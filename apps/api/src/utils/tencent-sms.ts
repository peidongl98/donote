import type { Env } from '../env';

/**
 * 腾讯云短信（TC3-HMAC-SHA256 签名，Web Crypto 实现）
 * 文档口径：签名方法 v3，凭证作用域 <date>/sms/tc3_request（不含 region）。
 *
 * 降级规则（单一判据：任一凭证缺失）：
 *   - ENVIRONMENT === 'production' → 返回 configured=false，由调用方回 500「短信服务未配置」
 *   - 其它环境 → devMode=true，不调用腾讯云，验证码由接口回传给前端
 */

const HOST = 'sms.tencentcloudapi.com';
const SERVICE = 'sms';
const REGION = 'ap-guangzhou';
const ACTION = 'SendSms';
const VERSION = '2021-01-11';
const ALGORITHM = 'TC3-HMAC-SHA256';
const SIGNED_HEADERS = 'content-type;host;x-tc-action';

const encoder = new TextEncoder();

export interface SmsOutcome {
  /** 短信已确认投递（SendStatusSet[0].Code === 'Ok'） */
  delivered: boolean;
  /** 缺凭证且非生产环境 → 走 dev 降级 */
  devMode: boolean;
  /** 凭证齐备且尝试过真实调用 */
  configured: boolean;
  /** 腾讯云返回的错误码，不对外暴露原文 */
  errorCode?: string;
}

interface TencentSendStatus {
  Code?: string;
  Message?: string;
}

interface TencentSmsResponse {
  Response?: {
    SendStatusSet?: TencentSendStatus[];
    RequestId?: string;
    Error?: { Code?: string; Message?: string };
  };
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function buildAuthorization(
  secretId: string,
  secretKey: string,
  payload: string,
  timestamp: number,
): Promise<string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${HOST}\n` +
    `x-tc-action:${ACTION.toLowerCase()}\n`;

  // 步骤 1：拼接规范请求串
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    SIGNED_HEADERS,
    await sha256Hex(payload),
  ].join('\n');

  // 步骤 2：拼接待签名字符串
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    ALGORITHM,
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // 步骤 3：计算签名（派生链 TC3+key → date → service → tc3_request）
  const secretDate = await hmac(encoder.encode(`TC3${secretKey}`), date);
  const secretService = await hmac(secretDate, SERVICE);
  const secretSigning = await hmac(secretService, 'tc3_request');
  const signature = toHex(await hmac(secretSigning, stringToSign));

  // 步骤 4：拼接 Authorization
  return `${ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
}

function hasCredentials(env: Env): boolean {
  return Boolean(
    env.TENCENT_SECRET_ID &&
      env.TENCENT_SECRET_KEY &&
      env.TENCENT_SMS_SDK_APP_ID &&
      env.TENCENT_SMS_SIGN_NAME &&
      env.TENCENT_SMS_TEMPLATE_ID,
  );
}

export async function sendSmsCode(env: Env, phone: string, code: string): Promise<SmsOutcome> {
  if (!hasCredentials(env)) {
    if (env.ENVIRONMENT === 'production') {
      return { delivered: false, devMode: false, configured: false };
    }
    return { delivered: false, devMode: true, configured: false };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: env.TENCENT_SMS_SDK_APP_ID,
    SignName: env.TENCENT_SMS_SIGN_NAME,
    TemplateId: env.TENCENT_SMS_TEMPLATE_ID,
    // 模板形如「您的验证码为 {1}，5 分钟内有效」→ 单参数
    TemplateParamSet: [code],
  });

  try {
    const authorization = await buildAuthorization(
      env.TENCENT_SECRET_ID!,
      env.TENCENT_SECRET_KEY!,
      payload,
      timestamp,
    );

    const res = await fetch(`https://${HOST}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: HOST,
        'X-TC-Action': ACTION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': VERSION,
        'X-TC-Region': REGION,
      },
      body: payload,
    });

    const data = (await res.json()) as TencentSmsResponse;
    if (data.Response?.Error?.Code) {
      return {
        delivered: false,
        devMode: false,
        configured: true,
        errorCode: data.Response.Error.Code,
      };
    }
    const status = data.Response?.SendStatusSet?.[0];
    if (status?.Code !== 'Ok') {
      return {
        delivered: false,
        devMode: false,
        configured: true,
        errorCode: status?.Code ?? `Http${res.status}`,
      };
    }
    return { delivered: true, devMode: false, configured: true };
  } catch {
    return { delivered: false, devMode: false, configured: true, errorCode: 'NetworkError' };
  }
}
