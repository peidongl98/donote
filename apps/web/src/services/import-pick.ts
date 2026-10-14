/**
 * 从按钮 / 菜单发起的导入。
 *
 * 拖放那条路（DropOverlay）是「文件已经拖进来了」，这条路是「用户点了导入，先选文件」。
 * 两条路后半段完全一样：`itemsFromPaths` / `itemsFromFiles` → `importItems` 串行建。
 *
 * Windows 的系统文件对话框**一次只能选文件或只能选文件夹**，所以给两个入口：
 * `importFiles()` 选 .md（可多选）、`importFolder()` 选文件夹（递归）。不硬凑成一个动作。
 *
 * 浏览器（开发调试）没有目录选择能力，退化成一个可多选的 <input type="file">。
 */
import { isTauriRuntime } from '@/storage/transport';
import { useUiStore } from '@/stores/ui';
import { importItems, itemsFromFiles, itemsFromPaths, type ImportResult } from './import-drop';

const MARKDOWN = /\.(md|markdown)$/i;
const MD_EXT = ['md', 'markdown'];

/** 点了取消 / 没选到东西 → null；否则给导入结果 */
export type ImportOutcome = ImportResult | null;

async function run(items: Awaited<ReturnType<typeof itemsFromPaths>>, baseFolderId: string | null): Promise<ImportOutcome> {
  const ui = useUiStore();
  if (!items.length) {
    ui.toast('没有可导入的 .md 文件');
    return null;
  }
  ui.toast(`导入中 0/${items.length}`);
  try {
    const result = await importItems(items, {
      baseFolderId,
      onProgress: (done, total) => ui.toast(`导入中 ${done}/${total}`),
    });
    ui.toast(
      `已导入 ${result.notes} 篇笔记${result.folders ? `、${result.folders} 个文件夹` : ''}` +
        (result.skipped.length ? `，跳过 ${result.skipped.length} 个非 .md 文件` : ''),
      3200,
    );
    return result;
  } catch (err) {
    ui.toast(err instanceof Error ? `导入失败：${err.message}` : '导入失败', 3600);
    return null;
  }
}

/** 选若干 .md 文件导入 */
export async function importFiles(baseFolderId: string | null = null): Promise<ImportOutcome> {
  if (!isTauriRuntime()) {
    const files = await pickBrowserFiles();
    return files.length ? run(itemsFromFiles(files), baseFolderId) : null;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: true,
    directory: false,
    filters: [{ name: 'Markdown', extensions: MD_EXT }],
  });
  const paths = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
  if (!paths.length) return null;
  return run(await itemsFromPaths(paths), baseFolderId);
}

/** 选若干文件夹，递归导入里面的 .md（子目录结构跟着建出来） */
export async function importFolder(baseFolderId: string | null = null): Promise<ImportOutcome> {
  if (!isTauriRuntime()) return importFiles(baseFolderId);
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: true, directory: true });
  const paths = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
  if (!paths.length) return null;
  return run(await itemsFromPaths(paths), baseFolderId);
}

function pickBrowserFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.md,.markdown,text/markdown';
    input.style.display = 'none';
    document.body.appendChild(input);

    const finish = (files: File[]): void => {
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish([...(input.files ?? [])].filter((f) => MARKDOWN.test(f.name))));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}
