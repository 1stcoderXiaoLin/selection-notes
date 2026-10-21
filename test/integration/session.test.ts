import assert from 'node:assert/strict';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { suite, suiteSetup, suiteTeardown, setup, test } from 'mocha';
import * as vscode from 'vscode';
import type { AnnotationController } from '../../src/annotationController';

const phase = process.env.SELECTION_NOTES_PHASE ?? 'main';
const fixtures = process.env.SELECTION_NOTES_FIXTURES!;
let service: AnnotationController;

/** 等待宿主传播选择事件，避免把程序设置选区与模拟用户事件混在同一时刻。 */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 给每个测试建立真实文本文件，验证批注不依赖某一种语言。 */
async function editorFor(
  relative: string,
  source = 'const value = 1;\n  second();\n',
): Promise<vscode.TextEditor> {
  const file = path.join(fixtures, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  return vscode.window.showTextDocument(document);
}

/** 使用原生批注对象提交，与用户点击输入框“保存”走同一条命令路径。 */
async function save(
  editor: vscode.TextEditor,
  text: string,
  range = new vscode.Range(0, 6, 0, 11),
): Promise<vscode.CommentThread> {
  const thread = service.openDraft(editor.document, range)!;
  assert.ok(thread);
  await vscode.commands.executeCommand('selectionNotes.saveComment', { thread, text });
  return thread;
}

/** 只模拟事件的来源标识，文档、选区、批注框与延时均使用真实 VS Code 宿主。 */
async function choose(
  editor: vscode.TextEditor,
  ranges: readonly vscode.Selection[],
  kind: vscode.TextEditorSelectionChangeKind,
): Promise<void> {
  editor.selections = [...ranges];
  await pause(100);
  service.handleSelectionChange({ textEditor: editor, selections: ranges, kind });
}

suite(`Selection Notes 扩展宿主：${phase}`, () => {
  /** 激活当前正在开发的插件，不读取用户实际安装的其他扩展。 */
  suiteSetup(async () => {
    const extension = vscode.extensions.all.find(
      (item) => item.packageJSON.name === 'selection-notes',
    );
    assert.ok(extension);
    service = (await extension.activate()) as AnnotationController;
  });

  if (phase === 'main') {
    /** 每个主流程用例从空工作区开始，草稿和已保存批注都不能串入下一个用例。 */
    setup(async () => {
      await vscode.workspace
        .getConfiguration('selectionNotes')
        .update('triggerMode', undefined, vscode.ConfigurationTarget.Workspace);
      await service.clearAll(async () => true);
      for (const thread of service.threads) service.cancelDraft(thread);
    });

    /**
     * 默认右键模式下，鼠标和键盘选择 value，分别等待 350 毫秒都不能自动弹框。
     * 执行右键菜单绑定的添加命令后才出现一个框，再次执行仍复用原框。
     */
    test('默认仅右键添加，选择文字不自动弹出', async () => {
      const editor = await editorFor('app/src/manual.ts');
      const selection = new vscode.Selection(0, 6, 0, 11);
      for (const kind of [
        vscode.TextEditorSelectionChangeKind.Mouse,
        vscode.TextEditorSelectionChangeKind.Keyboard,
      ]) {
        await choose(editor, [selection], kind);
        await pause(350);
        assert.equal(service.threads.length, 0);
      }
      // 公开命令使用主选区；重复添加不创建多余框。
      await vscode.commands.executeCommand('selectionNotes.addComment');
      const thread = service.threads[0];
      assert.ok(thread?.range?.isEqual(selection));
      await vscode.commands.executeCommand('selectionNotes.addComment');
      assert.equal(service.threads.length, 1);
      assert.equal(service.threads[0], thread);
    });

    /**
     * 向真实输出通道写入 value 并展示，尝试对其文档直接添加批注。
     * 输出文档不能创建批注；真实辅助面板的鼠标交互仍需人工验收。
     */
    test('真实输出通道文档不能创建批注', async () => {
      const channel = vscode.window.createOutputChannel('Selection Notes 面板过滤测试');
      try {
        channel.appendLine('value');
        channel.show();
        await pause(300);
        const document = vscode.workspace.textDocuments.find(
          (item) => item.uri.scheme === 'output' && item.getText().includes('value'),
        );
        assert.ok(document, '宿主应报告刚刚展示的输出通道文档');
        assert.equal(service.openDraft(document, new vscode.Range(0, 0, 0, 5)), undefined);
        assert.equal(service.threads.length, 0);
      } finally {
        channel.dispose();
      }
    });

    /**
     * 在同一 value 选区保存两条相同文字的意见，执行单条菜单绑定的删除命令。
     * 应只剩第二个 ID，复制时只出现一条；展开后删除最后一条仍保留空输入框。
     */
    test('单条删除命令只移除目标，复制排除已删除批注', async () => {
      const editor = await editorFor('app/src/delete.ts');
      const thread = await save(editor, '相同意见');
      await save(editor, '相同意见');
      const remainingId = service.store.all()[1].id;
      await vscode.commands.executeCommand('selectionNotes.deleteComment', thread.comments[0]);
      assert.deepEqual(
        service.store.all().map((note) => note.id),
        [remainingId],
      );
      assert.equal(thread.comments.length, 1);
      // 复制与删除使用同一持久化结果，不能重新导出旧意见。
      await vscode.commands.executeCommand('selectionNotes.copyAll');
      const output = await vscode.env.clipboard.readText();
      assert.equal(output.split('相同意见').length - 1, 1);
      service.openDraft(editor.document, new vscode.Range(0, 6, 0, 11));
      await vscode.commands.executeCommand('selectionNotes.deleteComment', thread.comments[0]);
      assert.equal(thread.comments.length, 0);
      assert.ok(service.threads.includes(thread));
    });

    /**
     * 在 example.ts 中选择 value，以鼠标事件触发后等待 50 毫秒，再等到超过 200 毫秒。
     * 前一次检查应无批注框，后一次应有一个空批注框；草稿不能进入已保存列表。
     */
    test('选择稳定 200 毫秒后打开原生批注框', async () => {
      await vscode.workspace
        .getConfiguration('selectionNotes')
        .update('triggerMode', 'automatic', vscode.ConfigurationTarget.Workspace);
      // 在真实编辑器中选择变量名，先检查尚未达到延时的状态。
      const editor = await editorFor('app/src/example.ts');
      const selection = new vscode.Selection(0, 6, 0, 11);
      await choose(editor, [selection], vscode.TextEditorSelectionChangeKind.Mouse);
      await pause(50);
      assert.equal(service.threads.length, 0);
      // 达到延时后只出现草稿，不应增加持久化记录。
      await pause(250);
      assert.equal(service.threads.length, 1);
      assert.equal(
        service.threads[0].collapsibleState,
        vscode.CommentThreadCollapsibleState.Expanded,
      );
      assert.deepEqual(service.store.all(), []);
    });

    /**
     * 先选择 value，40 毫秒后键盘改选第二行的 second，再连续等待 350 毫秒。
     * 只有最后稳定下来的 second 应有批注框，先前的 value 不应产生残留草稿。
     */
    test('连续选择只处理最终选区', async () => {
      await vscode.workspace
        .getConfiguration('selectionNotes')
        .update('triggerMode', 'automatic', vscode.ConfigurationTarget.Workspace);
      // 用户在延时结束前改选其他位置，旧选择不应留下输入框。
      const editor = await editorFor('app/src/debounce.ts');
      await choose(
        editor,
        [new vscode.Selection(0, 6, 0, 11)],
        vscode.TextEditorSelectionChangeKind.Mouse,
      );
      await pause(40);
      const final = new vscode.Selection(1, 2, 1, 8);
      await choose(editor, [final], vscode.TextEditorSelectionChangeKind.Keyboard);
      await pause(350);
      // 最终只为第二行的 second 展开一个批注框。
      assert.equal(service.threads.length, 1);
      assert.ok(service.threads[0].range?.isEqual(final));
    });

    /**
     * 将“选区弹框等待时长”设为 400 毫秒，选择 value 后等待 150 毫秒仍不应弹框。
     * 再等待 350 毫秒应出现一个框；最后恢复设置，避免影响其他用例。
     */
    test('工作区可配置弹框等待时长', async () => {
      await vscode.workspace
        .getConfiguration('selectionNotes')
        .update('triggerMode', 'automatic', vscode.ConfigurationTarget.Workspace);
      const configuration = vscode.workspace.getConfiguration('selectionNotes');
      await configuration.update('popupDelay', 400, vscode.ConfigurationTarget.Workspace);
      try {
        const editor = await editorFor('app/src/config.ts');
        await choose(
          editor,
          [new vscode.Selection(0, 6, 0, 11)],
          vscode.TextEditorSelectionChangeKind.Mouse,
        );
        await pause(150);
        assert.equal(service.threads.length, 0);
        // 自定义时长只影响新选区，不改变原文与保存规则。
        await pause(350);
        assert.equal(service.threads.length, 1);
      } finally {
        await configuration.update('popupDelay', undefined, vscode.ConfigurationTarget.Workspace);
      }
    });

    /**
     * 在 buttons.ts 中为 value 创建批注框，通过保存按钮绑定的命令提交两行意见。
     * 保存后应收起；重新展开后通过取消按钮的命令丢弃新增输入，已保存意见仍只有一条。
     * 此用例验证按钮的命令路径，真实按钮点击仍需人工验收。
     */
    test('按钮命令保存多行批注，取消新增输入不删除已有意见', async () => {
      const editor = await editorFor('app/src/buttons.ts');
      const thread = await save(editor, '检查参数。\n保留空值含义。');
      assert.equal(service.store.all()[0].text, '检查参数。\n保留空值含义。');
      assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
      // 同一框内取消新输入，只关闭输入框，不改动已保存的数据。
      service.openDraft(editor.document, new vscode.Range(0, 6, 0, 11));
      await vscode.commands.executeCommand('selectionNotes.cancelDraft', {
        thread,
        text: '不提交的新增意见',
      });
      assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
      assert.equal(service.store.all().length, 1);
      assert.equal(service.store.all()[0].text, '检查参数。\n保留空值含义。');
    });

    /**
     * 在 Markdown 中同时选择第一行的 value 和第二行的 second，以键盘事件提交主选区。
     * 应只产生 value 的一个批注框；重复选择 value 也不能再创建一个框。
     */
    test('多光标只处理主选区，同一选区复用输入框', async () => {
      await vscode.workspace
        .getConfiguration('selectionNotes')
        .update('triggerMode', 'automatic', vscode.ConfigurationTarget.Workspace);
      // 主选区和次选区同时存在，批注意图只取主选区。
      const editor = await editorFor('docs/review.md');
      const primary = new vscode.Selection(0, 6, 0, 11);
      await choose(
        editor,
        [primary, new vscode.Selection(1, 2, 1, 8)],
        vscode.TextEditorSelectionChangeKind.Keyboard,
      );
      await pause(350);
      const thread = service.threads[0];
      // 再次选择同一份原文，应复用原生批注框。
      assert.ok(thread);
      assert.equal(service.openDraft(editor.document, primary), thread);
      assert.equal(service.threads.length, 1);
    });

    /**
     * 在日志文件中先提交空白批注并取消草稿，再保存包含两行文字的批注。
     * 空白与取消均不能保存，最终仅保留 value 快照及完整的两行批注。
     */
    test('空白和取消不保存，多行批注通过原生命令保存', async () => {
      // 空白与取消都不能形成已保存的批注。
      const editor = await editorFor('docs/review.log');
      const range = new vscode.Range(0, 6, 0, 11);
      const draft = service.openDraft(editor.document, range)!;
      await vscode.commands.executeCommand('selectionNotes.saveComment', {
        thread: draft,
        text: '  \n ',
      });
      assert.equal(service.store.all().length, 0);
      await vscode.commands.executeCommand('selectionNotes.cancelDraft', {
        thread: draft,
        text: '',
      });
      assert.equal(service.threads.length, 0);
      // 真正提交后，原文与多行批注都应完整保存。
      await save(editor, '这里需要校验。\n同时保留空值含义。');
      assert.equal(service.store.all().length, 1);
      assert.equal(service.store.all()[0].source, 'value');
      assert.equal(service.store.all()[0].text, '这里需要校验。\n同时保留空值含义。');
    });

    /**
     * 剪贴板先存入“原来的剪贴板”，在没有批注时执行公开复制命令。
     * 原剪贴板内容必须保留，不能被空字符串覆盖。
     */
    test('空项目复制不会覆盖真实剪贴板', async () => {
      await vscode.env.clipboard.writeText('原来的剪贴板');
      await vscode.commands.executeCommand('selectionNotes.copyAll');
      assert.equal(await vscode.env.clipboard.readText(), '原来的剪贴板');
    });

    /**
     * 在 app/src/copy.ts 与 docs/copy.txt 分别批注 value 和 alpha，随后改写第一个文件并删除第二个文件。
     * 汇总应含两个工作区根目录名和添加时原文；变化后的批注不能继续挂在不匹配的行上。
     */
    test('跨根目录汇总使用快照，文件修改删除不影响复制', async () => {
      // 先建立两个真实文件，各保存一条批注。
      const first = await editorFor('app/src/copy.ts');
      const firstThread = await save(first, '检查数值。');
      const second = await editorFor('docs/copy.txt', 'alpha beta\n');
      await save(second, '检查单词。', new vscode.Range(0, 0, 0, 5));
      // 原文被改写和删除后，批注仍应有独立的讨论依据。
      const edit = new vscode.WorkspaceEdit();
      edit.replace(first.document.uri, new vscode.Range(0, 6, 0, 11), 'other');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await first.document.save();
      await unlink(second.document.uri.fsPath);
      service.refreshDocument(first.document);
      await vscode.commands.executeCommand('selectionNotes.copyAll');
      // 复制必须包含旧快照，并避免给变化后的 other 贴上旧意见。
      const copied = await vscode.env.clipboard.readText();
      assert.ok(copied.includes('文件：app/src/copy.ts'));
      assert.ok(copied.includes('文件：docs/copy.txt'));
      assert.ok(copied.includes('原文：\nvalue'));
      assert.ok(copied.includes('原文：\nalpha'));
      assert.equal(firstThread.range, undefined);
    });

    /**
     * 为 readonly 文档与无标题文档准备选区；不以语言或是否已保存来决定能否批注。
     * 分别选中 readonly text 中的 readonly、draft text 中的 draft，保存后只保留这两个片段。
     */
    test('只读虚拟文档和无标题文本都可批注', async () => {
      // 使用只读提供器，证明插件无需修改原文件即可批注。
      const registration = vscode.workspace.registerTextDocumentContentProvider(
        'selection-notes-readonly',
        {
          /** 只读文本用于证明批注不需要写入原文件。 */
          provideTextDocumentContent: () => 'readonly text',
        },
      );
      try {
        const readonly = await vscode.workspace.openTextDocument(
          vscode.Uri.parse('selection-notes-readonly:/sample'),
        );
        const untitled = await vscode.workspace.openTextDocument({
          content: 'draft text',
          language: 'plaintext',
        });
        await save(
          await vscode.window.showTextDocument(readonly),
          '只读也能批注。',
          new vscode.Range(0, 0, 0, 8),
        );
        await save(
          await vscode.window.showTextDocument(untitled),
          '无标题也能批注。',
          new vscode.Range(0, 0, 0, 5),
        );
        // 原文来自不同类型的编辑器，都只保存选中的部分。
        assert.deepEqual(
          service.store.all().map((note) => note.source),
          ['readonly', 'draft'],
        );
      } finally {
        registration.dispose();
      }
    });

    /**
     * app/src/clear.ts 已保存一条 value 批注；第一次取消清空，第二次确认。
     * 取消后批注及原生框都保留，确认后两者都清空；这里替换确认应答，不自动操作真实模态框。
     */
    test('清空取消保留数据，明确确认后清除数据和输入框', async () => {
      // 已保存的一条批注应出现在确认数量中。
      const editor = await editorFor('app/src/clear.ts');
      await save(editor, '准备清空的批注。');
      await service.clearAll(async (count) => {
        assert.equal(count, 1);
        return false;
      });
      assert.equal(service.store.all().length, 1);
      assert.equal(service.threads.length, 1);
      // 取消不会改变数据，再次确认才同时删除存储和界面批注。
      await service.clearAll(async () => true);
      assert.equal(service.store.all().length, 0);
      assert.equal(service.threads.length, 0);
    });

    /**
     * 主流程结束时在 restart.ts 的 value 保存两条批注并删除第一条，只留一条供下个进程验证。
     * 等待宿主持久化完成后再退出，不能以重建内存对象替代重启。
     */
    suiteTeardown(async () => {
      await vscode.workspace
        .getConfiguration('selectionNotes')
        .update('triggerMode', undefined, vscode.ConfigurationTarget.Workspace);
      await service.clearAll(async () => true);
      const editor = await editorFor('app/src/restart.ts');
      const thread = await save(editor, '删除后重启不能恢复的批注。');
      const removed = thread.comments[0];
      await save(editor, '跨重启保留的批注。');
      await vscode.commands.executeCommand('selectionNotes.deleteComment', removed);
      await service.store.whenIdle();
    });
  } else if (phase === 'restart') {
    /**
     * 使用同一个用户数据目录和工作区重新启动 VS Code，不重新写入任何批注。
     * 应恢复上一进程的 value 快照，打开 restart.ts 后恢复行内位置，且可以直接复制。
     */
    test('真实重启后恢复批注和行内位置', async () => {
      // 第二次启动直接读取上一个进程保存的内容，不重新创建批注。
      assert.equal(service.store.all().length, 1);
      assert.equal(service.store.all()[0].text, '跨重启保留的批注。');
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(fixtures, 'app/src/restart.ts')),
      );
      await vscode.window.showTextDocument(document);
      service.refreshDocument(document);
      // 原文仍匹配时恢复行内显示，并通过公开命令复制到真实剪贴板。
      assert.ok(service.threads[0].range?.isEqual(new vscode.Range(0, 6, 0, 11)));
      await vscode.commands.executeCommand('selectionNotes.copyAll');
      assert.ok((await vscode.env.clipboard.readText()).includes('跨重启保留的批注。'));
    });
  } else {
    /**
     * 复用同一个用户数据目录，打开包含同样两个根目录的另一个工作区文件。
     * 新工作区没有保存过批注，即使文件路径相同，也不能读到原工作区的数据。
     */
    test('不同工作区不共享批注', () => {
      assert.deepEqual(service.store.all(), []);
      assert.equal(service.threads.length, 0);
    });
  }
});
