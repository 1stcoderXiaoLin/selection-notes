import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import type { AnnotationController as Controller } from '../../src/annotationController';
import { NoteStore, type StateStorage } from '../../src/noteStore';
import { formatNotes, type Note } from '../../src/notes';

/** 只替代宿主边界，让延时与保存失败能在没有 VS Code 的环境下确定性验证。 */
function harness(uri = 'file:///project/example.ts', initial: Note[] = []) {
  let delay = 200;
  let failure = false;
  let triggerMode = 'contextMenu';
  const statuses: string[] = [];
  const range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 5 },
    isEmpty: false,
    /** 测试固定选择 value，重复选择仍指向同一位置。 */
    isEqual: () => true,
  };
  const document = {
    uri: { toString: () => uri, scheme: uri.split(':')[0] },
    lineCount: 1,
    /** 批注范围只需覆盖本测试的一行 value。 */
    lineAt: () => ({ text: 'value' }),
    isClosed: false,
    /** 只提供选中的五个字符，不扩大为整行。 */
    getText: () => 'value',
    /** 测试中的选区始终处于文档范围内。 */
    validateRange: () => range,
  };
  const editor = { document, selection: range, viewColumn: 1 as number | undefined };
  /** 替代宿主监听器注册，恢复测试不依赖真实窗口事件。 */
  const subscribe = () => ({ dispose() {} });
  const nativeController = {
    commentingRangeProvider: undefined as vscode.CommentingRangeProvider | undefined,
    /** 每次创建独立原生框替身，以观察关闭和重建。 */
    createCommentThread: (uri: unknown, selected: unknown, comments: unknown[]) => ({
      uri,
      range: selected,
      comments,
      /** 替身没有外部资源，销毁不需要额外操作。 */
      dispose() {},
    }),
    /** 替身控制器没有监听器需要释放。 */
    dispose() {},
  };
  const host = {
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2 },
    CommentMode: { Preview: 0 },
    Uri: { parse: (raw: string) => ({ scheme: raw.split(':')[0], toString: () => raw }) },
    Range: class {
      /** 坐标转换不参与本测试，仅保留宿主需要的对象形状。 */
      constructor(..._coordinates: number[]) {}
    },
    MarkdownString: class {
      /** 记录渲染发生即可，文字转义由真实宿主测试验证。 */
      appendText() {
        return this;
      }
    },
    comments: {
      /** 提供最小原生框替身，观察收起和重新创建。 */
      createCommentController: () => nativeController,
    },
    workspace: {
      textDocuments: [document],
      /** 每次选择重新读取配置，以验证用户修改后立即生效。 */
      getConfiguration: () => ({
        get: (key: string) => (key === 'popupDelay' ? delay : triggerMode),
      }),
      onDidOpenTextDocument: subscribe,
      onDidChangeTextDocument: subscribe,
      onDidChangeConfiguration: subscribe,
    },
    window: {
      activeTextEditor: editor as typeof editor | undefined,
      onDidChangeTextEditorSelection: subscribe,
      onDidChangeActiveTextEditor: subscribe,
      /** 保存成功的反馈应轻量展示，不打断继续阅读。 */
      setStatusBarMessage: (message: string) => statuses.push(message),
      /** 失败提醒不在本单元测试中展示真实界面。 */
      showErrorMessage() {},
      /** 测试清空时不显示真实通知。 */
      showInformationMessage() {},
    },
  };
  // 仅在加载被测模块时替代 vscode；其他测试仍使用正常的模块加载器。
  const loader = require('node:module') as { _load: (...args: unknown[]) => unknown };
  const original = loader._load;
  let AnnotationController: new (store: NoteStore) => Controller;
  try {
    loader._load = (name, ...args) =>
      name === 'vscode' ? host : original.call(loader, name, ...args);
    delete require.cache[require.resolve('../../src/annotationController')];
    AnnotationController = require('../../src/annotationController').AnnotationController;
  } finally {
    loader._load = original;
  }
  const state: StateStorage = {
    /** 每次测试以无批注工作区开始。 */
    get<T>(): T | undefined {
      return initial.length ? (structuredClone({ version: 1, notes: initial }) as T) : undefined;
    },
    /** 模拟存储不可用，观察失败时输入框是否保留。 */
    async update() {
      if (failure) throw new Error('disk full');
    },
  };
  const service = new AnnotationController!(new NoteStore(state));
  return {
    service,
    statuses,
    nativeController,
    editor: editor as unknown as vscode.TextEditor,
    /** 模拟焦点离开原编辑器，检查等待中的弹框是否被取消。 */
    focusElsewhere() {
      host.window.activeTextEditor = undefined;
    },
    /** 修改触发方式，默认仅由右键命令打开。 */
    setTriggerMode(value: string) {
      triggerMode = value;
    },
    /** 模拟辅助区域没有主编辑区列号。 */
    setViewColumn(value: number | undefined) {
      editor.viewColumn = value;
    },
    document: document as unknown as vscode.TextDocument,
    range: range as unknown as vscode.Range,
    event: {
      textEditor: editor,
      selections: [range],
      kind: 2,
    } as unknown as vscode.TextEditorSelectionChangeEvent,
    /** 改变下一次选区触发使用的等待时长。 */
    setDelay(value: number) {
      delay = value;
    },
    /** 切换持久化是否成功，输入和选区保持不变。 */
    failWrites(value: boolean) {
      failure = value;
    },
  };
}

/**
 * 开启自动弹出，准备 value 选区和默认 200 毫秒等待，推进到 199 毫秒时不应弹出，200 毫秒时出现。
 * 取消后把等待改为 400 毫秒，中途重新选择，只有最后一次选择稳定 400 毫秒才出现。
 */
test('自动模式默认 200 毫秒触发，配置变更和连续选择重新计算等待', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  try {
    h.setTriggerMode('automatic');
    h.service.handleSelectionChange(h.event);
    context.mock.timers.tick(199);
    assert.equal(h.service.threads.length, 0);
    context.mock.timers.tick(1);
    assert.equal(h.service.threads.length, 1);
    // 改为 400 毫秒后重新选择，应取消旧的弹框计划。
    h.service.cancelDraft(h.service.threads[0]);
    h.setDelay(400);
    h.service.handleSelectionChange(h.event);
    context.mock.timers.tick(300);
    h.service.handleSelectionChange(h.event);
    context.mock.timers.tick(399);
    assert.equal(h.service.threads.length, 0);
    context.mock.timers.tick(1);
    assert.equal(h.service.threads.length, 1);
  } finally {
    h.service.dispose();
  }
});

/**
 * 准备同一个 value 草稿，第一次保存两行批注时模拟磁盘满，第二次恢复写入。
 * 失败后输入框保持展开且无成功反馈；成功后只保存一条完整批注并收起输入框。
 */
test('保存失败保留展开状态，可靠保存后才收起并提示', async () => {
  const h = harness();
  try {
    const thread = h.service.openDraft(h.document, h.range)!;
    h.failWrites(true);
    await assert.rejects(h.service.saveComment({ thread, text: '第一行\n第二行' }), /disk full/);
    assert.equal(thread.collapsibleState, 1);
    assert.equal(h.service.store.all().length, 0);
    assert.deepEqual(h.statuses, []);
    // 恢复写入后，相同输入可以重试，避免失败后丢失批注意见。
    h.failWrites(false);
    await h.service.saveComment({ thread, text: '第一行\n第二行' });
    assert.equal(thread.collapsibleState, 0);
    assert.equal(h.service.store.all()[0].text, '第一行\n第二行');
    assert.deepEqual(h.statuses, ['批注已保存']);
  } finally {
    h.service.dispose();
  }
});

/**
 * 准备两个空草稿，只收起第一个，再次选择第一个位置。
 * 已关闭草稿必须重新创建，另一个仍展开的草稿保留；已保存批注不能被清理。
 */
test('原生关闭后重新选择会重建草稿，不移除其他输入和已保存批注', async () => {
  const h = harness();
  try {
    const first = h.service.openDraft(h.document, h.range)!;
    const other = h.service.openDraft(h.document, {
      ...h.range,
      start: { line: 1, character: 0 },
    } as vscode.Range)!;
    first.collapsibleState = 0;
    const reopened = h.service.openDraft(h.document, h.range)!;
    assert.notEqual(reopened, first);
    assert.ok(h.service.threads.includes(other));
    // 成功保存后也会收起，但已有意见不能作为空草稿被清理。
    await h.service.saveComment({ thread: reopened, text: '保留这条意见' });
    h.service.pruneClosedDrafts();
    assert.ok(h.service.threads.includes(reopened));
    assert.equal(h.service.threads.length, 2);
  } finally {
    h.service.dispose();
  }
});

/**
 * 默认使用右键触发，分别模拟鼠标和键盘选择 value 并等待 1 秒，都不能自动弹框。
 * 执行添加命令后立即打开一个框，重复执行仍复用同一框。
 */
test('默认不自动弹出，右键添加复用主选区批注框', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  try {
    for (const kind of [1, 2]) {
      h.service.handleSelectionChange({ ...h.event, kind });
      context.mock.timers.tick(1000);
      assert.equal(h.service.threads.length, 0);
    }
    // 用户明确执行添加命令后才创建草稿。
    const thread = h.service.addComment(h.editor);
    assert.ok(thread);
    assert.equal(h.service.addComment(h.editor), thread);
    assert.equal(h.service.threads.length, 1);
  } finally {
    h.service.dispose();
  }
});

/**
 * 为输出、日志、调试控制台、终端和批注输入框准备 value 选区并开启自动模式。
 * 自动选择、右键添加、直接创建及原生范围入口都不能生成批注。
 */
test('辅助面板的所有创建入口都被排除', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scheme of [
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
  ]) {
    const h = harness(`${scheme}:/panel`);
    try {
      h.setTriggerMode('automatic');
      h.service.handleSelectionChange(h.event);
      context.mock.timers.tick(1000);
      assert.equal(h.service.addComment(h.editor), undefined, scheme);
      assert.equal(h.service.openDraft(h.document, h.range), undefined, scheme);
      const ranges = await h.nativeController.commentingRangeProvider!.provideCommentingRanges(
        h.document,
        {} as vscode.CancellationToken,
      );
      // 排除范围提供器，防止原生“添加批注”绕过选区过滤。
      assert.deepEqual(ranges, { ranges: [], enableFileComments: false }, scheme);
      assert.equal(h.service.threads.length, 0, scheme);
    } finally {
      h.service.dispose();
    }
  }
});

/**
 * 普通文件、无标题和只读虚拟文本均放在主编辑区，自动选择后 200 毫秒可出现草稿。
 * 同样的文本若不属于主编辑区，或等待时切走焦点、关闭自动模式，都不能弹出。
 */
test('主编辑区文本可用，焦点或模式变化取消旧弹框', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const uri of [
    'file:///project/a.log',
    'untitled:Untitled-1',
    'selection-notes-readonly:/sample',
  ]) {
    const h = harness(uri);
    try {
      h.setTriggerMode('automatic');
      h.service.handleSelectionChange(h.event);
      context.mock.timers.tick(200);
      assert.equal(h.service.threads.length, 1, uri);
      // 主编辑区之外即使报告了文本选择，也不能触发。
      h.service.cancelDraft(h.service.threads[0]);
      h.setViewColumn(undefined);
      h.service.handleSelectionChange(h.event);
      context.mock.timers.tick(200);
      assert.equal(h.service.addComment(h.editor), undefined);
      assert.equal(h.service.threads.length, 0);
      h.setViewColumn(1);
      h.service.handleSelectionChange(h.event);
      h.setTriggerMode('contextMenu');
      context.mock.timers.tick(200);
      assert.equal(h.service.threads.length, 0);
      // 开始等待后切走焦点，不能在后台打开原编辑器的批注框。
      h.setTriggerMode('automatic');
      h.service.handleSelectionChange(h.event);
      h.focusElsewhere();
      context.mock.timers.tick(200);
      assert.equal(h.service.threads.length, 0);
    } finally {
      h.service.dispose();
    }
  }
});

/**
 * 在同一 value 选区保存两条文字相同但 ID 不同的意见，只点击第一条的删除入口。
 * 应保留第二条；重复删除旧对象不再写入或影响保留项；删除最后一条后移除收起的框。
 */
test('单条删除按 ID 区分相同文字，重复删除不影响剩余批注', async () => {
  const h = harness();
  try {
    const thread = h.service.openDraft(h.document, h.range)!;
    await h.service.saveComment({ thread, text: '同样的意见' });
    await h.service.saveComment({ thread, text: '同样的意见' });
    const [firstId, secondId] = h.service.store.all().map((note) => note.id);
    const firstComment = thread.comments[0];
    await h.service.deleteComment(firstComment);
    assert.deepEqual(
      h.service.store.all().map((note) => note.id),
      [secondId],
    );
    assert.notEqual(firstId, secondId);
    assert.equal(thread.comments.length, 1);
    // 老的菜单对象重复执行也不能把第二条相同文字删掉。
    await h.service.deleteComment(firstComment);
    assert.equal(h.service.store.all().length, 1);
    await h.service.deleteComment(thread.comments[0]);
    assert.equal(h.service.threads.length, 0);
    assert.deepEqual(h.service.store.all(), []);
  } finally {
    h.service.dispose();
  }
});

/**
 * 保存一条意见后模拟删除写入失败，数据和原生评论对象都应保留。
 * 恢复写入并展开输入框，再删除最后一条，输入框应作为空草稿保留且可重新保存。
 */
test('删除失败保留批注，删除最后一条时保留展开的输入框', async () => {
  const h = harness();
  try {
    const thread = h.service.openDraft(h.document, h.range)!;
    await h.service.saveComment({ thread, text: '待删除' });
    const comment = thread.comments[0];
    h.failWrites(true);
    await h.service.deleteComment(comment);
    assert.equal(h.service.store.all().length, 1);
    assert.equal(thread.comments[0], comment);
    // 只在删除可靠落盘后更新界面，展开的草稿不能被一并销毁。
    h.failWrites(false);
    h.service.openDraft(h.document, h.range);
    await h.service.deleteComment(comment);
    assert.equal(thread.comments.length, 0);
    assert.ok(h.service.threads.includes(thread));
    await h.service.saveComment({ thread, text: '新的意见' });
    assert.equal(h.service.store.all()[0].text, '新的意见');
  } finally {
    h.service.dispose();
  }
});

/**
 * 已有一条旧意见时同时删除旧意见并保存新意见。
 * 新保存不得因删除最后一条而失去输入框，最终存储和界面都仅包含新意见。
 */
test('删除与保存并发时保留新批注及其输入框', async () => {
  const h = harness();
  try {
    const thread = h.service.openDraft(h.document, h.range)!;
    await h.service.saveComment({ thread, text: '旧意见' });
    await Promise.all([
      h.service.deleteComment(thread.comments[0]),
      h.service.saveComment({ thread, text: '新意见' }),
    ]);
    assert.equal(h.service.store.all().length, 1);
    assert.equal(h.service.store.all()[0].text, '新意见');
    assert.equal(thread.comments.length, 1);
    assert.ok(h.service.threads.includes(thread));
  } finally {
    h.service.dispose();
  }
});

/**
 * 工作区已有普通文件 value 的意见及旧版误存到输出面板的两条记录。
 * 恢复时只挂载普通文件的框，但两份数据和导出快照都保留，不静默删除历史记录。
 */
test('历史输出批注不恢复行内显示，原始快照仍可导出', () => {
  const base: Note = {
    id: 'file',
    uri: 'file:///project/example.ts',
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    source: 'value',
    text: '文件意见',
    createdAt: 100,
  };
  const h = harness(base.uri, [
    base,
    { ...base, id: 'output', uri: 'output:/old', text: '旧输出意见' },
  ]);
  try {
    h.service.start();
    assert.equal(h.service.threads.length, 1);
    assert.equal(h.service.threads[0].uri.toString(), base.uri);
    // 不显示辅助面板批注，不代表可以丢掉用户以前保存的原文。
    assert.equal(h.service.store.all().length, 2);
    assert.ok(formatNotes(h.service.store.all(), (uri) => uri).includes('旧输出意见'));
  } finally {
    h.service.dispose();
  }
});

/**
 * 开启自动模式，选择 value 后尚未等到 200 毫秒就执行清空。
 * 即使工作区尚无已保存批注，旧计时也应取消，之后不能重新弹出草稿。
 */
test('清空操作取消尚未触发的选区计时', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  try {
    h.setTriggerMode('automatic');
    h.service.handleSelectionChange(h.event);
    await h.service.clearAll(async () => true);
    context.mock.timers.tick(1000);
    assert.equal(h.service.threads.length, 0);
  } finally {
    h.service.dispose();
  }
});
