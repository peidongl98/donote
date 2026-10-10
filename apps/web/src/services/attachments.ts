/**
 * 附件工具层。
 *
 * 附件住在笔记旁边的同名 `.assets` 目录里，内部只允许平铺、不递归：
 *   框架笔记.md        → 框架笔记.assets/
 *   框架笔记/index.md  → 框架笔记/index.assets/
 *
 * 这一层只做「路径推导 + 增删查 + 引用改写」，不接 UI、不管编辑器选型。
 * 网络请求仍然全部走 services/storage 的适配器，不新增任何请求方式。
 */

import { getStorage, StorageError, type DirEntry } from '@/services/storage';

export const ASSETS_SUFFIX = '.assets';

export interface Attachment {
  name: string;
  /** 相对同步根的路径 */
  path: string;
  mtime: number;
  /** 当前 PROPFIND 只取 resourcetype / getlastmodified，拿不到体积，因此不填 */
  size?: number;
}

/* ------------------------------ 纯函数：路径 ------------------------------ */

/** 目录名以 `.assets` 结尾即视为附件目录。扫描、搜索、回收站都靠它跳过 */
export function isAssetsDir(name: string): boolean {
  return name.endsWith(ASSETS_SUFFIX);
}

/**
 * 笔记路径 → 附件目录路径。只推导，不碰网络、不创建目录。
 * `框架笔记.md` → `框架笔记.assets`；`框架笔记/index.md` → `框架笔记/index.assets`
 */
export function getAssetsDirPath(notePath: string): string {
  const stem = notePath.toLowerCase().endsWith('.md') ? notePath.slice(0, -3) : notePath;
  return `${stem}${ASSETS_SUFFIX}`;
}

/** 附件目录名（最后一段） */
export function assetsDirName(notePath: string): string {
  const dir = getAssetsDirPath(notePath);
  return dir.slice(dir.lastIndexOf('/') + 1);
}

/** 写进笔记的相对引用路径（相对笔记文件本身） */
export function attachmentUrl(notePath: string, fileName: string): string {
  return `${assetsDirName(notePath)}/${fileName}`;
}

/** 文件名里不能出现的字符换掉；中文保留；扩展名一并净化 */
export function sanitizeAttachmentName(name: string): string {
  const at = name.lastIndexOf('.');
  const stem = at > 0 ? name.slice(0, at) : name;
  const ext = at > 0 ? name.slice(at) : '';
  // eslint-disable-next-line no-control-regex
  const cleaned = stem
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim();
  return `${cleaned || '附件'}${ext.replace(/[/\\:*?"<>|]/g, '').slice(0, 12)}`;
}

/**
 * 把正文里指向某个附件目录的引用改写成新目录名。只动链接目标，其余一字不改。
 * 兼容 `./` 前缀可有可无、percent-encoding、md 的 `(path "title")` 与 html 的 `src="path"`。
 */
export function rewriteAssetRefs(body: string, oldName: string, newName: string): string {
  return body
    .replace(
      /\]\(\s*(?:<([^>\n]*)>|([^)\s\n]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g,
      (match, wrapped, bare) => {
        const raw: string = wrapped ?? bare;
        const next = rewriteOne(raw, oldName, newName);
        return next === null ? match : match.replace(raw, () => next);
      },
    )
    .replace(/(\b(?:src|href)\s*=\s*)(["'])([^"'\n]*)\2/g, (match, head, quote, raw) => {
      const next = rewriteOne(raw, oldName, newName);
      return next === null ? match : `${head}${quote}${next}${quote}`;
    });
}

/** 只看路径首段是不是那个附件目录；是就换掉，不是返回 null */
function rewriteOne(raw: string, oldName: string, newName: string): string | null {
  const m = /^(\.\/)?([^/]+)((?:\/.*)?)$/.exec(raw);
  if (!m) return null;
  const [, dot = '', head, tail = ''] = m;
  if (decodeSafe(head) !== oldName) return null;
  return `${dot}${/%/.test(head) ? encodeURIComponent(newName) : newName}${tail}`;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/* ------------------------------ 网络：增删查 ------------------------------ */

async function exists(path: string): Promise<boolean> {
  try {
    await getStorage().stat(path);
    return true;
  } catch (error) {
    if (error instanceof StorageError && error.code === 'not_found') return false;
    throw error;
  }
}

/** 路径在不在。回收站恢复的前置校验也用它 */
export { exists as pathExists };

/** 目录不存在时返回空列表，而不是抛错 */
async function listDir(path: string): Promise<DirEntry[]> {
  try {
    return await getStorage().list(path);
  } catch (error) {
    if (error instanceof StorageError && error.code === 'not_found') return [];
    throw error;
  }
}

/** 笔记有没有附件目录 */
export async function hasAttachments(notePath: string): Promise<boolean> {
  return exists(getAssetsDirPath(notePath));
}

/** 列出附件。按平铺约定只看最上层，子目录不算附件 */
export async function listAttachments(notePath: string): Promise<Attachment[]> {
  const entries = await listDir(getAssetsDirPath(notePath));
  return entries
    .filter((entry) => !entry.isDirectory && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: entry.path, mtime: entry.mtime ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/**
 * 上传附件。目录不存在就建；重名按 `-1`、`-2` 往后排。
 * 返回的 url 是写进笔记的相对引用（相对笔记文件本身）。
 */
export async function uploadAttachment(
  notePath: string,
  fileName: string,
  content: Blob | ArrayBuffer,
): Promise<{ path: string; url: string }> {
  const dir = getAssetsDirPath(notePath);
  await getStorage().ensureDir(dir);

  const taken = new Set((await listDir(dir)).map((entry) => entry.name));
  const name = uniqueName(sanitizeAttachmentName(fileName), taken);
  const path = `${dir}/${name}`;

  await getStorage().write(path, content);
  return { path, url: attachmentUrl(notePath, name) };
}

export async function deleteAttachment(notePath: string, fileName: string): Promise<void> {
  await getStorage().delete(`${getAssetsDirPath(notePath)}/${fileName}`);
}

/** 在已占用的名字里挑一个不冲突的（重名加 -1、-2）。附件目录的合并也要用 */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  const at = base.lastIndexOf('.');
  const stem = at > 0 ? base.slice(0, at) : base;
  const ext = at > 0 ? base.slice(at) : '';
  let n = 1;
  while (taken.has(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}
