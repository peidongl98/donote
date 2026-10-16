/**
 * 应用内在线更新。
 *
 * 更新源是下载站上的静态 JSON（Cloudflare Pages），不是 GitHub —— 安装包和更新包
 * 都由我们自己托管，走的是和下载页同一个域名。
 * 签名公钥写死在 tauri.conf.json 的 plugins.updater.pubkey 里，只有私钥签过的包能装上。
 *
 * 两段式：启动后自动检查、后台把包下好（`startAutoUpdate`），下好了才提示
 * 「重启以更新」—— **安装动作永远由用户点一下触发**，不打断正在写的笔记。
 *
 * 绿色版（exe 同目录有 portable.txt）没有安装器可走，改为引导去下载页取新 zip。
 *
 * 浏览器里跑时整体降级为 unsupported（网页版不是产品形态）。
 */

import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './storage/transport';
import { openExternal } from './utils/open-external';

export const SITE_ORIGIN = 'https://donote.pages.dev';

export type UpdateState =
  | { kind: 'unsupported' }
  /** 已是最新 */
  | { kind: 'latest'; version: string }
  /** 有新版本待安装 */
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

/** 自动更新的进度：只有 ready 才是「问一句」的时机 */
export type AutoState =
  | { kind: 'idle' }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string; notes: string; portable: boolean }
  | { kind: 'failed'; message: string };

/** 界面订阅这个：下载进度与「已就绪」都从这里读 */
export const autoState = ref<AutoState>({ kind: 'idle' });

type PendingUpdate = import('@tauri-apps/plugin-updater').Update;

let pending: PendingUpdate | null = null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 绿色版的判据在 Rust 侧（看 exe 同目录有没有标记文件），问一次就缓存住 */
let portableFlag: boolean | null = null;

export async function isPortable(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (portableFlag === null) {
    try {
      portableFlag = await invoke<boolean>('portable_mode');
    } catch {
      portableFlag = false;
    }
  }
  return portableFlag;
}

/** 绿色版的新版包地址：同一个版本号，换成免安装 zip */
export function portableZipUrl(version: string): string {
  return `${SITE_ORIGIN}/downloads/DoNote-${version}-win-x64-portable.zip`;
}

/** 当前版本号；浏览器里回退到构建时注入的版本 */
export async function appVersion(): Promise<string> {
  if (!isTauriRuntime()) return '0.0.0-web';
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return 'unknown';
  }
}

export async function checkUpdate(): Promise<UpdateState> {
  if (!isTauriRuntime()) return { kind: 'unsupported' };
  try {
    const [{ check }, version] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      appVersion(),
    ]);
    const update = await check();
    if (!update) {
      pending = null;
      return { kind: 'latest', version };
    }
    pending = update;
    return { kind: 'available', version: update.version, notes: update.body ?? '' };
  } catch (error) {
    pending = null;
    return { kind: 'error', message: messageOf(error) };
  }
}

/** 后台把待安装的版本下好，进度写进 autoState。下载与安装分开，就是为了不打断用户。 */
async function downloadPending(version: string): Promise<void> {
  if (!pending) throw new Error('没有待下载的版本，请先检查更新');

  let total = 0;
  let received = 0;
  autoState.value = { kind: 'downloading', version, percent: 0 };

  await pending.download((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
      return;
    }
    if (event.event !== 'Progress') return;
    received += event.data.chunkLength;
    autoState.value = {
      kind: 'downloading',
      version,
      percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
    };
  });
}

/**
 * 把待安装的版本弄到「已下载」状态。启动时的自动流程和设置页的手动按钮走同一条路。
 * 已经就绪时直接返回，不重复下载。
 */
export async function ensureUpdateReady(): Promise<AutoState> {
  if (autoState.value.kind === 'ready') return autoState.value;

  if (!pending) {
    const state = await checkUpdate();
    if (state.kind !== 'available') return autoState.value;
  }
  const version = pending!.version;
  const notes = pending!.body ?? '';

  try {
    if (await isPortable()) {
      // 绿色版不下载安装包：它没有安装器，装了会在系统盘多出一份
      autoState.value = { kind: 'ready', version, notes, portable: true };
      return autoState.value;
    }
    await downloadPending(version);
  } catch (error) {
    autoState.value = { kind: 'failed', message: messageOf(error) };
    throw error;
  }

  autoState.value = { kind: 'ready', version, notes, portable: false };
  return autoState.value;
}

/**
 * 就绪之后的唯一下一步。
 * 绿色版：交给系统浏览器去拿新 zip；安装版：装完由安装器自己把应用重开。
 */
export async function applyUpdate(): Promise<void> {
  const state = autoState.value;
  if (state.kind !== 'ready') throw new Error('没有待安装的版本，请先检查更新');

  if (state.portable) {
    await openExternal(portableZipUrl(state.version));
    return;
  }
  if (!pending) throw new Error('更新包不在了，请重新检查更新');
  // Windows 上 install() 会拉起安装器（passive：显示进度但不打断）并退出本进程，
  // 装完由安装器重开应用，所以这里不需要再 relaunch。
  await pending.install();
}

/**
 * 启动自检发现的新版本。
 *
 * 🔴 回调在**一发现新版本时就发**，不等安装包下完（0.4.3 改）。
 * 旧流程是「后台把整包下完 → 弹一条 2.2 秒的 toast 说『到设置里点重启以更新』」，
 * 实测等于没有提示：下载要好几分钟、提示转瞬即逝，用户根本不知道有过更新。
 * 现在由界面立刻弹一句问，**装不装仍由用户点一下决定**。
 */
export type FoundUpdate = { version: string; notes: string };

/**
 * 启动后跑一次：延迟一会儿再动，别和首屏抢带宽。
 * 没有新版本、检查失败都静默放过 —— 更新不该在启动时打扰用户。
 */
export function startAutoUpdate(onFound?: (found: FoundUpdate) => void, delayMs = 3000): void {
  if (!isTauriRuntime()) return;
  window.setTimeout(() => {
    void checkUpdate().then((state) => {
      if (state.kind === 'available') onFound?.({ version: state.version, notes: state.notes });
    });
  }, delayMs);
}
