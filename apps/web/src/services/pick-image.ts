/**
 * 挑一张本机图片。
 *
 * 两条路各自负责，返回的东西一样，上层不用分环境：
 * - 桌面端（Tauri）：系统文件对话框（tauri-plugin-dialog）只给路径，
 *   内容由 Rust 侧的 read_image 读回来，走二进制通道。
 * - 浏览器：没有系统对话框，退化成一个临时的 <input type="file">。开发调试走这条。
 *
 * 这里只管「拿到文件」，不管存到哪、更不管怎么插进正文 —— 那些在 attachments.ts
 * 和编辑器里，路径规则只有一份。
 */
import { isTauriRuntime } from '@/storage/transport';

export interface PickedImage {
  name: string;
  data: Blob | ArrayBuffer;
}

/** 不限于图片，但默认只列常见图片，省得用户在一堆文件里翻 */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'];

/** 用户取消返回 null，两条路一致 */
export async function pickImage(): Promise<PickedImage | null> {
  return isTauriRuntime() ? pickInDesktop() : pickInBrowser();
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || '图片';
}

async function pickInDesktop(): Promise<PickedImage | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '图片', extensions: IMAGE_EXT }],
  });
  if (typeof picked !== 'string') return null;

  const { invoke } = await import('@tauri-apps/api/core');
  const data = await invoke<ArrayBuffer>('read_image', { path: picked });
  return { name: baseName(picked), data };
}

function pickInBrowser(): Promise<PickedImage | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    const finish = (value: PickedImage | null): void => {
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      finish(file ? { name: file.name, data: file } : null);
    });
    // 用户按了取消：Chrome 会派 cancel，老浏览器就永远等不到，交给 change 兜底
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}
