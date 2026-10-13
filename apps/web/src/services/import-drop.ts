/**
 * 拖放导入：把本机 `.md`（或装着 `.md` 的文件夹）拖进窗口，导入成笔记。
 *
 * 两条路，交给上层分环境选：
 * - 桌面端：Tauri 的拖放事件给的是**绝对路径**，列目录 / 读文件走 Rust 侧的
 *   `list_dir` / `read_text`（std::fs，没引 fs 插件）。
 * - 浏览器（只有开发调试走这条）：`dataTransfer.files`，直接 `File.text()`。
 *
 * 两边最后都汇成同一份 `ImportItem[]`，导入流程只有一份 —— 串行、逐个建，
 * 免得一串并发撞上坚果云的限流。
 *
 * 「重名加后缀」不在这里做：`notesApi.create` / `foldersApi.create` 本来就查重
 * （`uniqueRel`），这里再补一套只会出现两个口径。
 */
import { foldersApi, notesApi } from '@/storage/notes';

export interface ImportItem {
  /** 相对路径，`/` 分隔，例如 `课程/第一课.md` */
  rel: string;
  read: () => Promise<string>;
}

export interface ImportResult {
  /** 新建的笔记数 */
  notes: number;
  /** 新建的文件夹数 */
  folders: number;
  /** 跳过的文件（不是 .md） */
  skipped: string[];
}

interface DirEntryDto {
  path: string;
  name: string;
  is_dir: boolean;
}

const MARKDOWN = /\.(md|markdown)$/i;

/** 剥掉 frontmatter：正文进笔记正文，title 优先用它（没有就用文件名） */
function splitFrontmatter(text: string): { title?: string; body: string } {
  const hit = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!hit) return { body: text };
  const title = /(?:^|\n)title:\s*"?([^"\n]+?)"?\s*(?:\n|$)/.exec(hit[1])?.[1];
  return { title: title?.trim() || undefined, body: text.slice(hit[0].length) };
}

/** 桌面端：绝对路径 → 条目（目录递归展开，子目录保留成相对路径） */
export async function itemsFromPaths(paths: string[]): Promise<ImportItem[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const out: ImportItem[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await invoke<DirEntryDto[]>('list_dir', { path: dir });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.is_dir) {
        await walk(entry.path, rel);
      } else if (MARKDOWN.test(entry.name)) {
        out.push({ rel, read: () => invoke<string>('read_text', { path: entry.path }) });
      }
    }
  };

  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() || path;
    try {
      // 先当目录试；打不开就当单个文件
      await walk(path, '');
    } catch {
      if (MARKDOWN.test(name)) {
        out.push({ rel: name, read: () => invoke<string>('read_text', { path }) });
      }
    }
  }
  return out;
}

/** 浏览器：只能拿到 File 列表（`webkitRelativePath` 有值就保留相对路径） */
export function itemsFromFiles(files: File[]): ImportItem[] {
  return files
    .filter((file) => MARKDOWN.test(file.name))
    .map((file) => ({
      rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      read: () => file.text(),
    }));
}

/**
 * 串行导入。返回建了多少，进度按条回调（给「3/10」这种提示用）。
 *
 * 文件夹按需建：同一次导入里出现过的相对目录缓存成 id，避免重复建。
 * 撞名交给 `foldersApi.create` 自己补后缀。
 * 非 .md 在这里统一挡掉（两条取数路径各自也会先筛一遍，这里兜底）。
 */
export async function importItems(
  items: ImportItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const folderIds = new Map<string, string | null>([['', null]]);
  const pending = items.filter((item) => MARKDOWN.test(item.rel));
  const skipped = items.filter((item) => !MARKDOWN.test(item.rel)).map((item) => item.rel);
  let folders = 0;
  let notes = 0;
  let done = 0;

  const ensureFolder = async (rel: string): Promise<string | null> => {
    const cached = folderIds.get(rel);
    if (cached !== undefined) return cached;
    const parts = rel.split('/');
    const name = parts.pop() as string;
    const parent = await ensureFolder(parts.join('/'));
    const { folder } = await foldersApi.create({ name, parent_id: parent });
    folderIds.set(rel, folder.id);
    folders += 1;
    return folder.id;
  };

  for (const item of pending) {
    const parts = item.rel.split('/');
    const file = parts.pop() as string;
    const folder = parts.length ? await ensureFolder(parts.join('/')) : null;
    const { title, body } = splitFrontmatter(await item.read());
    await notesApi.create({
      title: title ?? file.replace(MARKDOWN, ''),
      content: body,
      folder_id: folder,
    });
    notes += 1;
    done += 1;
    onProgress?.(done, pending.length);
  }

  return { notes, folders, skipped };
}
