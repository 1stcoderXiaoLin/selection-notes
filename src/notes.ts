/** 不依赖编辑器生命周期的文本坐标，用来记录批注最初引用的位置。 */
export interface SourcePosition {
  /** 从零开始的行号。 */
  readonly line: number;
  /** 从零开始的 UTF-16 字符位置，与 VS Code 选区一致。 */
  readonly character: number;
}

/** 原始选区，结束位置不包含在原文中。 */
export interface SourceRange {
  /** 选区起点。 */
  readonly start: SourcePosition;
  /** 选区终点。 */
  readonly end: SourcePosition;
}

/** 一条已经保存的批注，原文与位置始终代表选中时的快照。 */
export interface Note {
  /** 批注的唯一标识。 */
  readonly id: string;
  /** 原始文档地址，文件消失后仍可用于辨认来源。 */
  readonly uri: string;
  /** 添加批注时的选区。 */
  readonly range: SourceRange;
  /** 严格保留缩进和换行的选中文字。 */
  readonly source: string;
  /** 用户输入的批注。 */
  readonly text: string;
  /** 创建时间戳，不依赖设备时区。 */
  readonly createdAt: number;
}

/** 同一位置的原文可能已经变化，将内容纳入标识才能避免复用错误的批注。 */
export function selectionKey(snapshot: Pick<Note, 'uri' | 'range' | 'source'>): string {
  return JSON.stringify([
    snapshot.uri,
    snapshot.range.start.line,
    snapshot.range.start.character,
    snapshot.range.end.line,
    snapshot.range.end.character,
    snapshot.source,
  ]);
}

/** 导出的是当时实际选中的行；恰好停在下一行开头，并不表示引用了下一行。 */
export function lineLabel(range: SourceRange): string {
  const first = range.start.line + 1;
  const last = Math.max(first, range.end.line + (range.end.character === 0 ? 0 : 1));
  return first === last ? String(first) : `${first}–${last}`;
}

/** 将批注整理为可直接粘贴的纯文本，不重新读取文件，以免原文变化后失去讨论依据。 */
export function formatNotes(notes: readonly Note[], displayPath: (uri: string) => string): string {
  const sorted = [...notes].sort((a, b) => {
    const pathA = displayPath(a.uri);
    const pathB = displayPath(b.uri);
    return (
      (pathA < pathB ? -1 : pathA > pathB ? 1 : 0) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character ||
      a.range.end.line - b.range.end.line ||
      a.range.end.character - b.range.end.character ||
      a.createdAt - b.createdAt
    );
  });
  return sorted
    .map(
      (note) =>
        `文件：${displayPath(note.uri)}\n原始行号：${lineLabel(note.range)}\n原文：\n${note.source}\n\n批注：\n${note.text}\n\n----------------------------------------`,
    )
    .join('\n\n');
}

/** 存储数据必须可完整解释，宁可报错，也不能把损坏或新版本的批注静默覆盖。 */
export function isNote(value: unknown): value is Note {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<Note>;
  const start = note.range?.start;
  const end = note.range?.end;
  if (!start || !end) return false;
  const coordinates = [start.line, start.character, end.line, end.character];
  return (
    typeof note.id === 'string' &&
    note.id.length > 0 &&
    typeof note.uri === 'string' &&
    note.uri.length > 0 &&
    typeof note.source === 'string' &&
    note.source.length > 0 &&
    typeof note.text === 'string' &&
    note.text.trim().length > 0 &&
    typeof note.createdAt === 'number' &&
    Number.isFinite(note.createdAt) &&
    coordinates.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    (end.line > start.line || (end.line === start.line && end.character > start.character))
  );
}
