import { isNote, type Note } from './notes';

/** 工作区内的唯一存储键，数据版本保存在值中。 */
export const STORAGE_KEY = 'selectionNotes.data';

/** 仅使用宿主提供的工作区存储，不向用户项目写入额外文件。 */
export interface StateStorage {
  /** 读取当前工作区已有的批注。 */
  get<T>(key: string): T | undefined;
  /** 将完整快照交给宿主持久化；失败时不能宣称保存成功。 */
  update(key: string, value: unknown): PromiseLike<void>;
}

/** 串行保存同一工作区的数据，防止多个异步操作互相覆盖。 */
export class NoteStore {
  private notes: Note[];
  private pending: Promise<unknown> = Promise.resolve();

  /** 恢复已有批注，格式未知时停止写入，保护用户原来的数据。 */
  constructor(private readonly state: StateStorage) {
    const data = state.get<unknown>(STORAGE_KEY);
    if (data === undefined) {
      this.notes = [];
      return;
    }
    const stored = data as { version?: unknown; notes?: unknown } | null;
    if (
      !stored ||
      stored.version !== 1 ||
      !Array.isArray(stored.notes) ||
      !stored.notes.every(isNote) ||
      new Set(stored.notes.map((note) => note.id)).size !== stored.notes.length
    ) {
      throw new Error('批注存储格式无法识别，原数据已保留，未执行任何写入。');
    }
    this.notes = structuredClone(stored.notes);
  }

  /** 返回独立快照，调用方无法通过修改数组绕过持久化。 */
  all(): Note[] {
    return structuredClone(this.notes);
  }

  /** 复制和退出前等待已提交的保存，避免漏掉刚刚点击保存的批注。 */
  async whenIdle(): Promise<void> {
    await this.pending;
  }

  /** 只有持久化成功才让新批注进入已保存列表。 */
  add(note: Note): Promise<void> {
    const snapshot = structuredClone(note);
    return this.enqueue(async () => {
      if (!isNote(snapshot) || this.notes.some((item) => item.id === snapshot.id)) {
        throw new Error('批注内容无效或重复，未保存。');
      }
      await this.persist([...this.notes, snapshot]);
    });
  }

  /** 只删除指定 ID 的意见，重复点击不能误删文字相同的其他批注。 */
  remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const remaining = this.notes.filter((note) => note.id !== id);
      if (remaining.length === this.notes.length) return false;
      await this.persist(remaining);
      return true;
    });
  }

  /** 确认和清空占用同一条队列，确保确认的数量就是将被删除的数据。 */
  clear(confirm: (count: number) => Promise<boolean>): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.notes.length === 0 || !(await confirm(this.notes.length))) return false;
      await this.persist([]);
      return true;
    });
  }

  /** 允许后续操作继续执行，但将本次失败原样交给发起方处理。 */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  /** 内存中的已保存状态必须与宿主确认写入的数据一致。 */
  private async persist(notes: Note[]): Promise<void> {
    await this.state.update(STORAGE_KEY, { version: 1, notes });
    this.notes = notes;
  }
}
