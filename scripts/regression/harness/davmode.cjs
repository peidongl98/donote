/**
 * 回归脚手架的两层开关 —— 9 套共用这一个入口。
 *
 *   默认（不设环境变量） = mock：同源假 DAV，零坚果云额度，秒级
 *   USE_REAL_DAV=1      = real：真坚果云（只该在发版前跑一次）
 *
 * 用法（每套只改三处，断言逻辑一行不动）：
 *   1) 顶部：   const H = require('../harness/davmode.cjs');
 *   2) 常量：   const ACCOUNT = H.ACCOUNT;  const SERVER = H.SERVER;  const DAV = H.DAV;
 *   3) 密码：   const appPassword = H.appPassword();
 *   4) 建页后： await H.attach(page, ctx);   // 每个 page 各调一次
 *   收尾：      H.finish();
 *
 * 本机相关的东西（账号 / 密钥文件 / 产物目录）都从环境变量取，默认值只保证 mock 能跑：
 *   DONOTE_ACCOUNT        登录账号。mock 下只是界面上的字面量，随便填；real 下必须是真账号。
 *   DONOTE_SECRETS        密钥文件（key=value）。默认仓库上一级的 .deploy-secrets。
 *   DONOTE_ARTIFACTS_DIR  截图与 .out 的落点。默认 scripts/regression/.artifacts（不入库）。
 * 这些由 run-regression.cjs 从 scripts/regression/local.json 注入，见 docs/regression-workflow.md。
 *
 * 为什么 SERVER 两种模式都一样：套件里有「默认地址是坚果云」这类断言，
 * 检查的就是界面上的字面值；mock 靠拦网络而不是改地址来生效，所以这些断言不用动。
 */

const fs = require('fs');
const path = require('path');
const mock = require('./davmock.cjs');

/** 'mock' | 'real' —— 默认 mock：不显式声明就绝不碰真服务器 */
const MODE = process.env.USE_REAL_DAV === '1' ? 'real' : 'mock';

const ACCOUNT = process.env.DONOTE_ACCOUNT || 'user@example.com';
const SERVER = 'https://dav.jianguoyun.com/dav';
const DAV = 'https://dav.jianguoyun.com/dav/DoNote';
const SECRETS =
  process.env.DONOTE_SECRETS ||
  path.resolve(__dirname, '..', '..', '..', '..', '.deploy-secrets');

/** 截图 / .out 的落点：默认在 scripts/regression/.artifacts，整套产物集中一处、已 gitignore */
const ART = process.env.DONOTE_ARTIFACTS_DIR || path.resolve(__dirname, '..', '.artifacts');

if (MODE === 'real' && !process.env.DONOTE_ACCOUNT) {
  throw new Error(
    '真实模式需要 DONOTE_ACCOUNT（真坚果云账号）。见 scripts/regression/local.example.json',
  );
}

let realPassword = null;
function readSecrets() {
  const out = {};
  for (const line of fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function appPassword() {
  if (MODE === 'mock') return 'mock-app-password';
  if (realPassword === null) {
    realPassword = readSecrets().Nut_Web;
    if (!realPassword) throw new Error(`密钥文件里没有 Nut_Web（${SECRETS}）`);
  }
  return realPassword;
}

let seeded = false;
let attached = 0;

/**
 * 给一个 page（连同它的 context）装上假 DAV。
 * real 模式下什么都不做 —— 套件照原样连真服务器。
 */
async function attach(page, ctx) {
  if (MODE === 'real') return;
  if (!seeded) {
    mock.seed();
    seeded = true;
    console.log(`  [harness] 假 DAV 已就绪（${mock.PREFIX_PATH}），本套不耗坚果云额度`);
  }
  await mock.install(page, ctx);
  attached++;
}

/** 套件收尾时调一次，打印假 DAV 的请求计数（确认真的没往外发） */
function finish() {
  if (MODE === 'real') {
    console.log('  [harness] 真实坚果云模式');
    return;
  }
  console.log(`  [harness] mock 模式：${attached} 个页面接了假 DAV，请求计数 ${JSON.stringify(mock.stats())}`);
}

module.exports = { MODE, ACCOUNT, SERVER, DAV, SECRETS, ART, appPassword, attach, finish, mock };
