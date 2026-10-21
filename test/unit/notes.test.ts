import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatNotes, selectionKey, type Note } from '../../src/notes';
import { NoteStore, STORAGE_KEY, type StateStorage } from '../../src/noteStore';

/** 提供只属于当前测试的数据，避免不同工作区的批注互相影响。 */
function memoryState(initial: unknown = undefined): StateStorage {
  let value = initial;
  return {
    /** 隔离测试工作区，避免读取其他测试的数据。 */
    get<T>(_key: string): T | undefined {
      return value as T | undefined;
    },
    /** 模拟宿主持久化，保存独立副本而不是引用。 */
    async update(_key: string, next: unknown): Promise<void> {
      value = structuredClone(next);
    },
  };
}

/** 准备第 12 行中间选中的变量名，作为快照与导出测试的共同业务数据。 */
function note(id: string, changes: Partial<Note> = {}): Note {
  return {
    id,
    uri: 'file:///project/src/example.ts',
    range: { start: { line: 11, character: 6 }, end: { line: 11, character: 11 } },
    source: 'value',
    text: '检查空值。',
    createdAt: 100,
    ...changes,
  };
}

/**
 * 准备只选中 value 的批注及包含两个缩进空格、CRLF 换行的多行快照。
 * 汇总后只应包含选中的 value，且多行原文的缩进与换行不能被格式化。
 * 选区结束于第 15 行开头时，实际引用的末行是第 14 行。
 */
test('导出严格保留部分选区、缩进、换行及实际涉及的行号', () => {
  // 部分选区不扩展为完整代码行。
  const partial = formatNotes([note('partial')], () => 'src/example.ts');
  assert.ok(partial.includes('原始行号：12\n原文：\nvalue\n\n批注：\n检查空值。'));
  // 三行原文以 CRLF 结束，选区停在下一行开头。
  const source = '  first();\r\n    second();\r\n  third();\r\n';
  const multiline = note('multiline', {
    source,
    range: { start: { line: 11, character: 0 }, end: { line: 14, character: 0 } },
  });
  const output = formatNotes([multiline], () => 'src/example.ts');
  // 行号和原文必须同时保留添加时的含义。
  assert.ok(output.includes('原始行号：12–14'));
  assert.ok(output.includes(`原文：\n${source}\n\n批注：`));
});

/**
 * 准备 b.ts、a.ts 中不同位置及同位置不同创建时间的四条批注，创建时间戳分别为 100、200 毫秒。
 * 打乱顺序后汇总，应按文件、原始位置、创建时间输出，不能改变原始数组。
 */
test('跨文件汇总按路径、位置和创建顺序排列', () => {
  // 打乱路径、行号及同一选区的创建顺序。
  const notes = [
    note('b', { uri: 'file:///project/b.ts' }),
    note('late', { uri: 'file:///project/a.ts', text: '较晚', createdAt: 200 }),
    note('early', { uri: 'file:///project/a.ts', text: '较早', createdAt: 100 }),
    note('first', {
      uri: 'file:///project/a.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      source: 'v',
      text: '第一行',
    }),
  ];
  const output = formatNotes(notes, (uri) => uri.replace('file:///project/', ''));
  // 汇总只调整输出顺序，不能修改已保存的数据。
  assert.ok(output.indexOf('第一行') < output.indexOf('较早'));
  assert.ok(output.indexOf('较早') < output.indexOf('较晚'));
  assert.ok(output.indexOf('较晚') < output.indexOf('文件：b.ts'));
  assert.deepEqual(
    notes.map((item) => item.id),
    ['b', 'late', 'early', 'first'],
  );
});

/**
 * 准备同一文件同一位置的两次选择，以及原文已改变的第三次选择。
 * 相同选区和原文应复用批注框；原文变化后不能复用旧快照。
 */
test('选区标识区分原文版本', () => {
  const original = note('one');
  assert.equal(selectionKey(original), selectionKey(note('two')));
  assert.notEqual(selectionKey(original), selectionKey(note('three', { source: 'other' })));
});

/**
 * 在两个独立工作区中仅向 A 保存 value 批注，再重新创建 A 的存储对象。
 * A 应恢复原文和批注，B 应为空，证明持久化以工作区为边界。
 */
test('批注可重新加载且工作区相互隔离', async () => {
  const stateA = memoryState();
  const stateB = memoryState();
  await new NoteStore(stateA).add(note('a'));
  assert.deepEqual(new NoteStore(stateA).all(), [note('a')]);
  assert.deepEqual(new NoteStore(stateB).all(), []);
});

/**
 * 连续提交 a、b 两条批注，并让第一个写入等待外部完成。
 * 第二个写入只能在第一个之后发生，最终必须保留两条，不能因异步覆盖而丢失。
 */
test('并发保存按顺序执行，写入成功前不更新可见数据', async () => {
  // 将第一次持久化暂停，给第二次提交制造并发条件。
  let release!: () => void;
  let writes = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state: StateStorage = {
    /** 从没有批注的工作区开始，观察首次保存。 */
    get<T>(): T | undefined {
      return undefined;
    },
    /** 暂停第一次写入，让测试能观察保存是否排队。 */
    async update(): Promise<void> {
      if (++writes === 1) await gate;
    },
  };
  const store = new NoteStore(state);
  const first = store.add(note('a'));
  const second = store.add(note('b'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.deepEqual(store.all(), []);
  // 放行后两次保存都应完成，任何一条都不能被覆盖。
  release();
  await Promise.all([first, second]);
  assert.deepEqual(
    store.all().map((item) => item.id),
    ['a', 'b'],
  );
});

/**
 * 第一次保存 a 时模拟磁盘失败，第二次正常保存 b。
 * a 不能显示为已保存，失败也不能阻塞后续写入，最终仅返回 b。
 */
test('失败的保存不污染内存，也不阻塞后续操作', async () => {
  // 第一次写入失败，后面的写入仍应获得执行机会。
  let writes = 0;
  const state: StateStorage = {
    /** 从空工作区开始，排除旧数据干扰。 */
    get<T>(): T | undefined {
      return undefined;
    },
    /** 模拟一次磁盘失败，后续保存恢复正常。 */
    async update(): Promise<void> {
      if (++writes === 1) throw new Error('disk full');
    },
  };
  const store = new NoteStore(state);
  await assert.rejects(store.add(note('a')), /disk full/);
  // 失败的 a 不计入已保存状态，成功的 b 才能返回。
  assert.deepEqual(store.all(), []);
  await store.add(note('b'));
  assert.deepEqual(
    store.all().map((item) => item.id),
    ['b'],
  );
});

/**
 * 已有两条批注时先取消清空，再确认清空。
 * 取消应保留两条，确认后当前工作区必须为空，持久化重新加载后也应为空。
 */
test('清空只有经过确认才修改持久化数据', async () => {
  // 在同一工作区保存两条批注，取消第一次清空。
  const state = memoryState();
  const store = new NoteStore(state);
  await store.add(note('a'));
  await store.add(note('b'));
  assert.equal(
    await store.clear(async (count) => {
      assert.equal(count, 2);
      return false;
    }),
    false,
  );
  assert.equal(store.all().length, 2);
  // 第二次明确确认后，重新加载也不应再出现旧批注。
  assert.equal(await store.clear(async () => true), true);
  assert.deepEqual(new NoteStore(state).all(), []);
});

/**
 * 存储中存在无法识别的新版本数据时尝试加载。
 * 应明确报错，不能把未知格式当成空项目并在后续保存中覆盖原数据。
 */
test('拒绝覆盖无法识别的持久化格式', () => {
  assert.throws(() => new NoteStore(memoryState({ version: 999, notes: [] })), /格式/);
  assert.equal(STORAGE_KEY, 'selectionNotes.data');
});

/**
 * 确认框展示已有一条 a 时，再提交新的 b。
 * 清空操作只能删除确认时已有的 a；b 排在清空之后保存，不能被悄悄删除。
 */
test('确认过程中提交的保存排在清空之后', async () => {
  // 用尚未应答的确认框暂停清空。
  const store = new NoteStore(memoryState());
  await store.add(note('a'));
  let answer!: (value: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const clearing = store.clear(async (count) => {
    assert.equal(count, 1);
    return confirmation;
  });
  const saving = store.add(note('b'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    store.all().map((item) => item.id),
    ['a'],
  );
  // 用户确认只删除已展示的 a，之后的 b 应继续保存。
  answer(true);
  await Promise.all([clearing, saving]);
  assert.deepEqual(
    store.all().map((item) => item.id),
    ['b'],
  );
});

/**
 * 保存相同原文和文字的 a、b 两条批注，只删除 a，再重复删除 a。
 * 第二次删除应返回未删除；重新加载和导出后都只保留 b，说明删除依据 ID 而非文字。
 */
test('单条删除持久化后不再恢复，缺失 ID 不产生额外删除', async () => {
  const state = memoryState();
  const store = new NoteStore(state);
  await store.add(note('a'));
  await store.add(note('b'));
  assert.equal(await store.remove('a'), true);
  assert.equal(await store.remove('a'), false);
  // 从落盘状态重新读取，导出也只能包含剩余的一条。
  const restored = new NoteStore(state).all();
  assert.deepEqual(
    restored.map((item) => item.id),
    ['b'],
  );
  assert.equal(formatNotes(restored, () => 'example.ts').split('批注：').length - 1, 1);
});

/**
 * 准备 a、b 两条意见，令第一次删除 a 的写入失败，再正常删除 a 并并发保存 c。
 * 失败后 a、b 均保留；重试完成后只剩 b、c，不能因异步覆盖丢失新保存的数据。
 */
test('删除失败不改变数据，删除与新增共用持久化队列', async () => {
  const backing = memoryState();
  const store = new NoteStore(backing);
  await store.add(note('a'));
  await store.add(note('b'));
  const update = backing.update;
  backing.update = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(store.remove('a'), /disk full/);
  assert.deepEqual(
    store.all().map((item) => item.id),
    ['a', 'b'],
  );
  // 恢复写入后，删除旧记录与添加新记录必须按序保留彼此的结果。
  backing.update = update;
  await Promise.all([store.remove('a'), store.add(note('c'))]);
  assert.deepEqual(
    new NoteStore(backing).all().map((item) => item.id),
    ['b', 'c'],
  );
});
