#!/usr/bin/env node
/**
 * 给 hvigorw 打出来的 HAP 签名。
 *
 * 子命令是 sign-app（不是 sign）：hap-sign-tool 26.0.0 起把 sign 拆成了
 * sign-app / sign-profile，旧写法会报 "Can not find method {sign}"。
 * 同时 -compatibleVersion 成了 sign-app 的必填项，值取自 module.json5 的
 * minAPIVersion（50000012 = API 12 / HarmonyOS 5.0.0）。
 *
 * 为什么单独一步、不写进 build-profile.json5：
 * 那个文件是入库的，而 signingConfigs 里的 storePassword 只能是明文 —— 写进去等于
 * 把密钥库口令提交到仓库。改成在这里现读 apps/harmony/sign/.storepass（已 gitignore），
 * 仓库里就不会出现任何口令。
 *
 * 前置：
 *   sign/donote.key / .self.crt / .p12 / .cer 已就位（见 sign/README.md）
 *   sign/donote.p7b 已从 AGC 下载（Profile，绑定应用 + 证书 + 设备 UDID）
 *   entry/build/.../entry-default-unsigned.hap 已由 hvigorw assembleHap 生成
 *
 * 用法：node scripts/sign-harmony.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARMONY = join(REPO, 'apps/harmony');
const SIGN = join(HARMONY, 'sign');
const OUT_DIR = join(HARMONY, 'build');

/** SDK 装在哪儿：优先环境变量，否则用本机固定位置 */
function toolchains() {
  const candidates = [
    process.env.DEVECO_SDK_HOME,
    process.env.OHOS_SDK_HOME,
    'D:/ohos-sdk/command-line-tools/sdk',
  ].filter(Boolean);
  for (const base of candidates) {
    const jars = join(base, 'default/openharmony/toolchains/lib/hap-sign-tool.jar');
    if (existsSync(jars)) return dirname(jars);
  }
  fail('找不到 hap-sign-tool.jar', [
    '设 DEVECO_SDK_HOME 指向 command-line-tools/sdk',
    '或确认 D:/ohos-sdk/command-line-tools/sdk/default/openharmony/toolchains/lib 存在',
  ]);
}

/**
 * 找 java。
 * command-line-tools 里**不带** JRE，打包链的 PackageHap / 签名都是 `spawn java`，
 * 所以必须能在 PATH 或 JAVA_HOME 里找到它。这里是最后一道兜底。
 */
function findJava() {
  const direct = [
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin/java.exe'),
    'D:/ohos-sdk/jdk-17.0.20.1+1-jre/bin/java.exe',
  ].filter(Boolean);
  for (const p of direct) if (existsSync(p)) return p;
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' });
    return 'java';
  } catch {
    fail('找不到 java', [
      '装一个 JRE 17，或设 JAVA_HOME 指向它',
      'D:/ohos-sdk/jdk-17.0.20.1+1-jre 就是本机已下好的那份',
    ]);
  }
}

function fail(msg, hints = []) {
  process.stderr.write(`\n✗ ${msg}\n`);
  for (const h of hints) process.stderr.write(`  · ${h}\n`);
  process.exit(1);
}

const lib = toolchains();
const java = findJava();

// 输入：最近一次构建出来的未签名 HAP
const buildOut = join(HARMONY, 'entry/build/default/outputs/default');
const unsigned = existsSync(buildOut)
  ? readdirSync(buildOut)
      .filter((f) => f.endsWith('.hap'))
      .map((f) => join(buildOut, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  : null;
if (!unsigned) {
  fail('没有可签的 HAP', ['先跑 node scripts/build-harmony.mjs 和 hvigorw assembleHap']);
}

// 签名材料
const storeFile = join(SIGN, 'donote.p12');
const certFile = join(SIGN, 'donote.cer');
// Profile 文件名由 AGC 决定（下载时叫什么就是什么），所以按后缀找，不写死
const profile = readdirSync(SIGN)
  .filter((f) => f.toLowerCase().endsWith('.p7b'))
  .sort()
  .map((f) => join(SIGN, f))
  .pop();
const passFile = join(SIGN, '.storepass');
for (const [f, hint] of [
  [storeFile, '密钥库丢了就要重新生成密钥并重签证书'],
  [certFile, '从 AGC「证书」页重新下载'],
  [profile, '从 AGC「Profile」页下载，需要先登记设备 UDID'],
  [passFile, '密钥库口令'],
]) {
  if (!existsSync(f)) fail(`缺少 ${basename(f)}`, [hint]);
}

const storepass = readFileSync(passFile, 'utf8').trim();
const KEY_ALIAS = 'donote';

mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(OUT_DIR, 'donote-signed.hap');

process.stdout.write(`· 输入 ${unsigned.replace(REPO, '.')}\n`);
process.stdout.write(`· 签名材料 ${lib.replace(REPO, '.')}\n`);

try {
  execFileSync(
    java,
    [
      '-jar',
      join(lib, 'hap-sign-tool.jar'),
      'sign-app',
      '-mode',
      'localSign',
      '-compatibleVersion',
      '50000012',
      '-keystoreFile',
      storeFile,
      '-keystorePwd',
      storepass,
      '-keyAlias',
      KEY_ALIAS,
      '-keyPwd',
      storepass,
      '-profileFile',
      profile,
      '-appCertFile',
      certFile,
      '-signAlg',
      'SHA384withECDSA',
      '-inFile',
      unsigned,
      '-outFile',
      outFile,
    ],
    { stdio: 'inherit' },
  );
} catch {
  fail('签名失败', [
    '口令 / 别名不对：别名是 donote，口令在 sign/.storepass',
    'Profile 与应用包名不匹配：AGC 上的 bundleName 必须是 com.peidongl98.donote',
    'Profile 里没登记这台设备的 UDID',
  ]);
}

if (!existsSync(outFile)) fail('签名命令跑完了但没有产物');
process.stdout.write(`\n✓ ${outFile.replace(REPO, '.')}  ${(statSync(outFile).size / 1e6).toFixed(1)}MB\n`);
process.stdout.write('  装到设备：hdc install -r apps/harmony/build/donote-signed.hap\n');
