/**
 * 导出落盘：桌面端走系统保存对话框，浏览器退化成下载。
 *
 * 文本与二进制走同一条路：文本直接写字符串，二进制（.docx）先 base64 再过 Rust 落盘 ——
 * 面板只认一个 `save()`，不指望 WebView 里 `<a download>` 能弹出像样的另存为。
 */
import { toBase64 } from '@/utils/base64';

export interface SaveFilter {
  name: string;
  extensions: string[];
}

export async function saveFile(
  fileName: string,
  data: string | Blob,
  filter: SaveFilter,
): Promise<'saved' | 'canceled'> {
  const { isTauriRuntime } = await import('@/storage/transport');
  if (isTauriRuntime()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { invoke } = await import('@tauri-apps/api/core');
    const target = await save({ defaultPath: fileName, filters: [filter] });
    if (typeof target !== 'string') return 'canceled';
    if (typeof data === 'string') {
      await invoke('write_text', { path: target, contents: data });
    } else {
      await invoke('write_bytes', { path: target, data: toBase64(await data.arrayBuffer()) });
    }
    return 'saved';
  }

  const blob = typeof data === 'string' ? new Blob([data], { type: 'text/plain;charset=utf-8' }) : data;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'saved';
}
