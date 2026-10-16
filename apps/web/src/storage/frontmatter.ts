/**
 * 极简 frontmatter：只认 `key: value` 与 `tags: [a, b]` 两种写法，不引 YAML 依赖。
 * 文件本身就是笔记 —— 用户在自己的网盘里打开也能一眼读懂。
 */

export interface NoteMeta {
  title: string;
  created: number;
  updated: number;
  tags: string[];
  /** 仅回收站里的文件才有：原来的相对路径 */
  deleted_from?: string;
  /** 仅回收站里的文件才有：删除时间 */
  deleted_at?: number;
}

export interface ParsedNote extends NoteMeta {
  body: string;
}

const DELIM = '---';

/** 标题一律用 JSON 字符串写，避免冒号、井号、前后空格把解析搞坏 */
function quote(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return String(JSON.parse(text));
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  return text;
}

function parseTags(value: string): string[] {
  const text = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!text) return [];
  return text
    .split(',')
    .map((tag) => unquote(tag))
    .filter(Boolean);
}

function toTime(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 解析一篇笔记。
 * 没有 frontmatter（用户自己手写的 .md）时，正文原样保留，标题回退到文件名。
 */
export function parseNote(raw: string, fallbackTitle: string, fallbackTime: number): ParsedNote {
  const lines = raw.split(/\r?\n/);
  const fields = new Map<string, string>();
  let body = raw;

  if (lines[0]?.trim() === DELIM) {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === DELIM);
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const at = line.indexOf(':');
        if (at <= 0) continue;
        fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      body = lines.slice(end + 1).join('\n');
    }
  }

  const deletedFrom = fields.get('deleted_from');
  const deletedAt = fields.get('deleted_at');

  return {
    title: fields.has('title') ? unquote(fields.get('title') as string) : fallbackTitle,
    created: toTime(fields.get('created'), fallbackTime),
    updated: toTime(fields.get('updated'), fallbackTime),
    tags: fields.has('tags') ? parseTags(fields.get('tags') as string) : [],
    deleted_from: deletedFrom ? unquote(deletedFrom) : undefined,
    deleted_at: deletedAt ? toTime(deletedAt, 0) || undefined : undefined,
    body,
  };
}

export function serializeNote(meta: NoteMeta, body: string): string {
  const lines = [
    DELIM,
    `title: ${quote(meta.title)}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `tags: [${meta.tags.map(quote).join(', ')}]`,
  ];
  if (meta.deleted_from) lines.push(`deleted_from: ${quote(meta.deleted_from)}`);
  if (meta.deleted_at) lines.push(`deleted_at: ${meta.deleted_at}`);
  lines.push(DELIM);
  return `${lines.join('\n')}\n${body}`;
}

/**
 * 列表里展示的摘要：跳过空行，截到 240 字。
 *
 * 顺手把 `\[\[` / `\]\]` 还原成 `[[` / `]]` —— 序列化器会把方括号转义（见
 * `notes.ts` 的 `WIKILINK_RE`），摘要只是给人看的，带着一堆反斜杠很脏。
 * **只影响展示**：摘要是从正文派生出来的缓存，从不写回文件。
 */
export function excerptOf(body: string): string {
  const text = body
    .replace(/\\\[\\\[/g, '[[')
    .replace(/\\\]\\\]/g, ']]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 240 ? text.slice(0, 240) : text;
}
