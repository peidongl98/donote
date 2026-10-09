/**
 * 应用内在线更新。
 *
 * 更新源是下载站上的静态 JSON（Cloudflare Pages），不是 GitHub —— 安装包和更新包
 * 都由我们自己托管，走的是和下载页同一个域名。
 * 签名公钥写死在 tauri.conf.json 的 plugins.updater.pubkey 里，只有私钥签过的包能装上。
 *
 * 浏览器里跑时整体降级为 unsupported（网页版不是产品形态）。
 */

import { isTauriRuntime } from './storage/transport';

export type UpdateState =
  | { kind: 'unsupported' }
  /** 已是最新 */
  | { kind: 'latest'; version: string }
  /** 有新版本待安装 */
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'installing' }
  | { kind: 'error'; message: string };

type PendingUpdate = import('@tauri-apps/plugin-updater').Update;

let pending: PendingUpdate | null = null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * 下载并安装，装完自动重启。
 * NSIS 的 installMode 是 passive：显示进度但不打断用户，不用再去官网拿安装包。
 */
export async function installUpdate(onState: (state: UpdateState) => void): Promise<void> {
  if (!isTauriRuntime()) throw new Error('当前环境不支持应用内更新');
  if (!pending) throw new Error('没有待安装的版本，请先检查更新');

  let total = 0;
  let received = 0;

  onState({ kind: 'downloading', percent: 0 });
  await pending.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0;
        onState({ kind: 'downloading', percent: 0 });
        break;
      case 'Progress':
        received += event.data.chunkLength;
        onState({
          kind: 'downloading',
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0,
        });
        break;
      case 'Finished':
        onState({ kind: 'installing' });
        break;
    }
  });

  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
