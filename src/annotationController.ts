import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { formatNotes, lineLabel, selectionKey, type Note, type SourceRange } from './notes';
import { NoteStore } from './noteStore';

/** 一个选区的输入框可以包含多条已保存批注，但始终引用同一份原文。 */
interface AnnotationThread {
  /** 选中文字时的文档地址、位置和内容。 */
  readonly snapshot: Pick<Note, 'uri' | 'range' | 'source'>;
  /** VS Code 负责呈现的原生批注框。 */
  readonly thread: vscode.CommentThread;
  /** 当前选区已经保存的批注，未提交的输入不在其中。 */
  readonly notes: Note[];
  /** 防止快速连点保存生成重复批注。 */
  saving: Promise<void> | undefined;
}

/** 把用户选择、原生批注框与工作区存储连接起来，不修改被批注的文档。 */
export class AnnotationController implements vscode.Disposable {
  /** 已保存数据的权威来源，所有修改都经过串行持久化。 */
  readonly store: NoteStore;
  private readonly controller: vscode.CommentController;
  private readonly bindings = new Map<string, AnnotationThread>();
  private readonly commentIds = new WeakMap<vscode.Comment, string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private clearing = false;
  private disposed = false;

  /** 使用宿主原生组件，使批注与当前选区相邻，同时复用编辑器已有的输入体验。 */
  constructor(store: NoteStore) {
    this.store = store;
    this.controller = vscode.comments.createCommentController(
      'selectionNotes',
      'Selection Notes（选中批注）',
    );
    this.controller.options = {
      prompt: '输入批注',
      placeHolder: '输入批注…',
    };
    this.controller.commentingRangeProvider = {
      /** 文本的业务含义由用户判断，不按文件扩展名限制可批注的位置。 */
      provideCommentingRanges: (document) => ({
        ranges: this.supportsUri(document.uri)
          ? [
              new vscode.Range(
                0,
                0,
                document.lineCount - 1,
                document.lineAt(document.lineCount - 1).text.length,
              ),
            ]
          : [],
        enableFileComments: false,
      }),
    };
  }

  /** 便于宿主管理当前已展开及历史批注，返回数组本身不会改变内部登记关系。 */
  get threads(): readonly vscode.CommentThread[] {
    return [...this.bindings.values()].map((binding) => binding.thread);
  }

  /** 在窗口恢复时找回批注，并只监听用户选择，不把程序定位误当成批注意图。 */
  start(): void {
    for (const note of this.store.all()) {
      if (!this.supportsUri(vscode.Uri.parse(note.uri))) continue;
      const key = selectionKey(note);
      let binding = this.bindings.get(key);
      if (!binding) binding = this.createThread(note, false);
      binding.notes.push(note);
      this.render(binding);
    }
    for (const document of vscode.workspace.textDocuments) this.refreshDocument(document);
    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((event) => this.handleSelectionChange(event)),
      vscode.window.onDidChangeActiveTextEditor(() => this.cancelTimer()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('selectionNotes')) this.cancelTimer();
      }),
      vscode.workspace.onDidOpenTextDocument((document) => this.refreshDocument(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.refreshDocument(event.document)),
    );
  }

  /** 右键添加只使用主编辑区的主选区，不受自动弹出开关影响。 */
  addComment(editor: vscode.TextEditor | undefined): vscode.CommentThread | undefined {
    if (!editor || editor.viewColumn === undefined) return undefined;
    return this.openDraft(editor.document, editor.selection);
  }

  /** 自动模式按最后一次选区变化计时；公开 API 无法判断鼠标是否已经松开。 */
  handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent): void {
    this.cancelTimer();
    if (
      this.disposed ||
      this.clearing ||
      (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse &&
        event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard)
    )
      return;
    const editor = event.textEditor;
    const selection = event.selections[0];
    if (
      !selection ||
      selection.isEmpty ||
      editor !== vscode.window.activeTextEditor ||
      editor.viewColumn === undefined ||
      !this.supportsUri(editor.document.uri) ||
      vscode.workspace
        .getConfiguration('selectionNotes', editor.document.uri)
        .get<string>('triggerMode', 'contextMenu') !== 'automatic'
    )
      return;
    const source = editor.document.getText(selection);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (
          this.disposed ||
          this.clearing ||
          editor.viewColumn === undefined ||
          vscode.workspace
            .getConfiguration('selectionNotes', editor.document.uri)
            .get<string>('triggerMode', 'contextMenu') !== 'automatic' ||
          editor.document.isClosed ||
          editor !== vscode.window.activeTextEditor ||
          !editor.selection.isEqual(selection) ||
          editor.document.getText(selection) !== source
        )
          return;
        this.openDraft(editor.document, selection);
      },
      vscode.workspace
        .getConfiguration('selectionNotes', editor.document.uri)
        .get<number>('popupDelay', 200),
    );
  }

  /** 让同一份选中文字只有一个批注框，重复选择时仍能继续补充意见。 */
  openDraft(document: vscode.TextDocument, range: vscode.Range): vscode.CommentThread | undefined {
    if (
      this.disposed ||
      this.clearing ||
      !this.supportsUri(document.uri) ||
      range.isEmpty ||
      !document.validateRange(range).isEqual(range)
    )
      return undefined;
    const snapshot = {
      uri: document.uri.toString(),
      range: this.sourceRange(range),
      source: document.getText(range),
    };
    this.pruneClosedDrafts();
    const existing = this.bindings.get(selectionKey(snapshot));
    if (existing) {
      existing.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      return existing.thread;
    }
    return this.createThread(snapshot, true).thread;
  }

  /** 保存时使用打开输入框时的快照，避免用户输入期间原文变化导致引用内容被替换。 */
  async saveComment(reply: vscode.CommentReply | undefined): Promise<void> {
    if (!reply?.thread || typeof reply.text !== 'string') return;
    if (!this.supportsUri(reply.thread.uri)) {
      reply.thread.dispose();
      return;
    }
    if (!reply.text.trim()) {
      void vscode.window.showWarningMessage('批注不能为空，请输入内容后保存。');
      return;
    }
    if (this.clearing || this.disposed) return;
    let binding = [...this.bindings.values()].find((item) => item.thread === reply.thread);
    // 编辑器自带的“添加批注”也能创建输入框，提交时将它纳入同一套存储。
    if (!binding) {
      const document = vscode.workspace.textDocuments.find(
        (item) => item.uri.toString() === reply.thread.uri.toString(),
      );
      if (!document || !reply.thread.range || reply.thread.range.isEmpty) return;
      const snapshot = {
        uri: document.uri.toString(),
        range: this.sourceRange(reply.thread.range),
        source: document.getText(reply.thread.range),
      };
      const key = selectionKey(snapshot);
      const existing = this.bindings.get(key);
      if (existing) {
        binding = existing;
      } else {
        binding = { snapshot, thread: reply.thread, notes: [], saving: undefined };
        this.bindings.set(key, binding);
      }
    }
    // 重复点击共享同一次保存结果，失败时也不能被另一次提前返回误判成成功。
    if (!binding.saving) binding.saving = this.persistComment(binding, reply.text);
    await binding.saving;
    if (binding.thread !== reply.thread) reply.thread.dispose();
  }

  /** 原生输入框必须等到可靠落盘后才结束提交，失败时保留用户继续处理的机会。 */
  private async persistComment(binding: AnnotationThread, text: string): Promise<void> {
    const note: Note = { ...binding.snapshot, id: randomUUID(), text, createdAt: Date.now() };
    try {
      await this.store.add(note);
      if (!this.disposed && this.bindings.get(selectionKey(binding.snapshot)) === binding) {
        binding.notes.push(note);
        this.render(binding);
        const document = vscode.workspace.textDocuments.find(
          (item) => item.uri.toString() === note.uri,
        );
        if (document) this.refreshDocument(document);
        binding.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        vscode.window.setStatusBarMessage('批注已保存', 2000);
      }
    } catch (error) {
      this.reportError('保存批注失败，输入内容尚未计入汇总', error);
      throw error;
    } finally {
      binding.saving = undefined;
    }
  }

  /** 取消草稿不应删除同一位置已经保存的意见。 */
  cancelDraft(argument: vscode.CommentReply | vscode.CommentThread | undefined): void {
    if (!argument) return;
    const thread = 'thread' in argument ? argument.thread : argument;
    const entry = [...this.bindings.entries()].find(([, item]) => item.thread === thread);
    if (!entry) {
      thread.dispose();
      return;
    }
    const [key, binding] = entry;
    if (binding.saving) return;
    if (binding.notes.length === 0) {
      this.bindings.delete(key);
      thread.dispose();
    } else {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }

  /** 原生关闭会销毁空草稿，移除登记后才能在下次选择时重新打开。 */
  pruneClosedDrafts(): void {
    for (const [key, binding] of this.bindings) {
      if (
        binding.notes.length === 0 &&
        !binding.saving &&
        binding.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Collapsed
      ) {
        this.bindings.delete(key);
        binding.thread.dispose();
      }
    }
  }

  /** 单条删除先可靠落盘，再更新界面；同一选区的其他意见和正在输入的草稿仍保留。 */
  async deleteComment(comment: vscode.Comment | undefined): Promise<void> {
    if (!comment || this.clearing || this.disposed) return;
    const id = this.commentIds.get(comment);
    if (!id) return;
    const entry = [...this.bindings.entries()].find(([, binding]) =>
      binding.notes.some((note) => note.id === id),
    );
    if (!entry) return;
    const [key, binding] = entry;
    try {
      if (!(await this.store.remove(id))) return;
      // 删除旧意见时可能正在保存新意见，必须等它结束后再判断是否可以关闭框。
      await binding.saving?.catch(() => undefined);
      if (this.disposed || this.bindings.get(key) !== binding) return;
      const index = binding.notes.findIndex((note) => note.id === id);
      if (index >= 0) binding.notes.splice(index, 1);
      if (
        binding.notes.length === 0 &&
        binding.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Collapsed
      ) {
        this.bindings.delete(key);
        binding.thread.dispose();
      } else {
        this.render(binding);
        const document = vscode.workspace.textDocuments.find(
          (item) => item.uri.toString() === binding.snapshot.uri,
        );
        if (document) this.refreshDocument(document);
      }
      vscode.window.setStatusBarMessage('已删除这条批注', 2000);
    } catch (error) {
      this.reportError('删除批注失败，原批注已保留', error);
    }
  }

  /** 汇总只依赖已保存快照，文件消失或内容变化也不能使批注失去原文。 */
  async copyAll(): Promise<void> {
    try {
      await this.store.whenIdle();
      const notes = this.store.all();
      if (notes.length === 0) {
        void vscode.window.showInformationMessage('当前项目没有已保存的批注，剪贴板未改变。');
        return;
      }
      await vscode.env.clipboard.writeText(formatNotes(notes, (uri) => this.displayPath(uri)));
      void vscode.window.showInformationMessage(`已复制当前项目的 ${notes.length} 条批注。`);
    } catch (error) {
      this.reportError('复制批注失败', error);
    }
  }

  /** 清空前必须让用户明确确认整个工作区的范围；弹框期间不再接受新的保存。 */
  async clearAll(confirm?: (count: number) => Promise<boolean>): Promise<void> {
    if (this.clearing || this.disposed) return;
    this.cancelTimer();
    this.clearing = true;
    try {
      const cleared = await this.store.clear(confirm ?? ((count) => this.confirmClear(count)));
      if (cleared) {
        for (const binding of this.bindings.values()) binding.thread.dispose();
        this.bindings.clear();
        void vscode.window.showInformationMessage('当前项目的全部批注已清空。');
      } else if (this.store.all().length === 0) {
        void vscode.window.showInformationMessage('当前项目没有已保存的批注。');
      }
    } catch (error) {
      this.reportError('清空批注失败，原批注已保留', error);
    } finally {
      this.clearing = false;
    }
  }

  /** 文件变化后不猜测批注的新位置，改为文件级历史批注，防止意见贴到无关代码上。 */
  refreshDocument(document: vscode.TextDocument): void {
    for (const binding of this.bindings.values()) {
      if (binding.snapshot.uri !== document.uri.toString()) continue;
      const range = this.editorRange(binding.snapshot.range);
      const matches =
        document.validateRange(range).isEqual(range) &&
        document.getText(range) === binding.snapshot.source;
      binding.thread.range = matches ? range : undefined;
      binding.thread.canReply = matches || binding.notes.length === 0;
      binding.thread.label = matches
        ? binding.notes.length
          ? `第 ${lineLabel(binding.snapshot.range)} 行`
          : '添加批注'
        : `历史批注 · 第 ${lineLabel(binding.snapshot.range)} 行`;
    }
  }

  /** 批注位置脱离文档后仍保留原始来源，多个根目录则需要目录名来区分同名文件。 */
  displayPath(rawUri: string): string {
    const uri = vscode.Uri.parse(rawUri);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder)
      return vscode.workspace.asRelativePath(
        uri,
        (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
      );
    return uri.scheme === 'file' ? uri.fsPath : uri.toString();
  }

  /** 释放监听和输入框，避免扩展重载后旧计时器再次打开批注。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.controller.dispose();
    this.bindings.clear();
  }

  /** 未打开的文件先显示为历史批注，读取到真实内容后才能恢复行内位置。 */
  private createThread(
    snapshot: Pick<Note, 'uri' | 'range' | 'source'>,
    expanded: boolean,
  ): AnnotationThread {
    const thread = this.controller.createCommentThread(
      vscode.Uri.parse(snapshot.uri),
      this.editorRange(snapshot.range),
      [],
    );
    thread.range = expanded ? this.editorRange(snapshot.range) : undefined;
    thread.canReply = expanded;
    thread.label = expanded ? '添加批注' : `历史批注 · 第 ${lineLabel(snapshot.range)} 行`;
    thread.collapsibleState = expanded
      ? vscode.CommentThreadCollapsibleState.Expanded
      : vscode.CommentThreadCollapsibleState.Collapsed;
    const binding: AnnotationThread = { snapshot, thread, notes: [], saving: undefined };
    this.bindings.set(selectionKey(snapshot), binding);
    return binding;
  }

  /** 用户输入只作为文字展示，不把批注解释成可执行链接或 HTML。 */
  private render(binding: AnnotationThread): void {
    binding.thread.comments = binding.notes.map((note) => {
      const comment: vscode.Comment = {
        body: new vscode.MarkdownString().appendText(note.text),
        mode: vscode.CommentMode.Preview,
        author: { name: '批注' },
        contextValue: 'selectionNotes.saved',
      };
      this.commentIds.set(comment, note.id);
      return comment;
    });
  }

  /** 工具面板也是文本编辑器，但它们的临时输出不属于需要批注的文档。 */
  private supportsUri(uri: vscode.Uri): boolean {
    return ![
      'output',
      'vscode-output',
      'log',
      'vscode-log',
      'debug',
      'debug-console',
      'vscode-debugconsole',
      'vscode-terminal',
      'comment',
      'vscode-comment',
    ].includes(uri.scheme);
  }

  /** 将编辑器对象转为普通数据，使批注不依赖已经关闭的编辑器。 */
  private sourceRange(range: vscode.Range): SourceRange {
    return {
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
    };
  }

  /** 只在显示批注时创建宿主坐标，持久化仍使用原始普通数据。 */
  private editorRange(range: SourceRange): vscode.Range {
    return new vscode.Range(
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
    );
  }

  /** 让用户在不可撤销的操作前看清工作区名称、文件夹和批注数量。 */
  private async confirmClear(count: number): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const scope = folders.length
      ? folders.map((folder) => folder.uri.fsPath).join('\n')
      : '当前未打开文件夹的窗口';
    const answer = await vscode.window.showWarningMessage(
      `确定清空“${vscode.workspace.name ?? '当前窗口'}”的全部 ${count} 条批注吗？`,
      {
        modal: true,
        detail: `范围：当前工作区的所有文件。\n${scope}\n\n此操作无法撤销，未保存的批注草稿也将关闭。`,
      },
      '清空全部批注',
    );
    return answer === '清空全部批注';
  }

  /** 选择已经变更时，旧的弹框计划不再代表用户当前意图。 */
  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 给出失败原因，让用户知道数据是否已保存，避免无声失败。 */
  private reportError(message: string, error: unknown): void {
    void vscode.window.showErrorMessage(
      `${message}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
