import type { Env } from '../env';

const PHONE = /^1[3-9]\d{9}$/;

/**
 * 测试账号通道。
 *
 * 存在的唯一理由：腾讯云短信凭证尚未配置时，仍要能在真实环境走完整登录链路。
 * 安全边界（三条件缺一不可）：
 *   1) 只有显式写进 env.TEST_LOGIN_PHONES 的号码才会命中；
 *   2) 该变量默认留空 → 生产环境不配置此变量时，等于完全没有这条通道；
 *   3) 验证码仍然随机生成、写库、5 分钟过期、校验通过即删（一码一用），
 *      只是不经过短信网关，不存在任何「万能码」。
 */
export function isTestLoginPhone(env: Env, phone: string): boolean {
  const raw = env.TEST_LOGIN_PHONES;
  if (!raw) return false;
  return raw
    .split(',')
    .map((item) => item.trim())
    .some((item) => item === phone && PHONE.test(item));
}
