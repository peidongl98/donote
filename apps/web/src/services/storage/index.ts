/**
 * 当前生效的存储适配器。
 *
 * 上层一律通过 getStorage() 拿适配器，不直接 import 具体实现，
 * 因此将来真要换协议（非 WebDAV 的对象存储）只需换这一个注册点。
 *
 * 连接成功后由 stores/webdav.ts 注册进来，断开连接时清空。
 */

import { StorageError, type StorageAdapter } from './types';

let current: StorageAdapter | null = null;

export function setStorage(adapter: StorageAdapter | null): void {
  current = adapter;
}

export function hasStorage(): boolean {
  return current !== null;
}

export function getStorage(): StorageAdapter {
  if (!current) throw new StorageError('not_connected', '还没连接存储，请先完成连接');
  return current;
}

export * from './types';
export { LocalAdapter } from './local';
export { WebdavAdapter } from './webdav';
