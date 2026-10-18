/**
 * 页面导航的等待判据 —— 9 套回归共用。
 *
 * 🔴 为什么不能用 `waitUntil: 'networkidle'`：**真机上永远到不了**。
 * 应用空闲时会主动发请求（后台预拉取整个笔记库），实测静默 40 秒里最长的一段空窗只有 42ms，
 * 而 `networkidle` 要求连续 500ms 无连接 —— 两者定义上互斥。
 * 后果不是「慢」，是「跑不完」：真机上 13 处门控全部卡死，套件表现成 exit=2 / 无输出。
 *
 * 替代判据是**显式等元素**：应用自己渲染出「连接页」或「主界面外壳」就算就绪。
 * 这两者都是本地渲染、不依赖网络，所以 mock 与真机一视同仁。
 * 不变量：`.login`（未连接）与 `.rail`（已连接，App.vue 里 showShell 为真时渲染）二者必有其一。
 */

/** 应用就绪的两种形态之一 */
const READY = '.login, .rail';

async function waitReady(page, timeout = 20000) {
  await page.waitForSelector(READY, { timeout });
}

/** 打开一个页面并等应用就绪。waitFor 可以再指定一个业务元素（列表、编辑器等） */
async function openPage(page, url, waitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitReady(page);
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 });
}

/** 原地重载并等应用就绪 */
async function reloadPage(page, waitFor) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitReady(page);
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 });
}

/**
 * 连上假 DAV（或真坚果云，看 davmode 的 MODE）。
 *
 * 🔴 为什么必须显式连一次：没连接时应用会停在 `/login`，而**连接页上也有 `.card`**
 * （WebdavGuide 的说明卡）。直接 `openPage(page, BASE, '.card')` 会立刻满足，
 * 拿到的是连接页 —— 后续所有数据层调用都报「还没连接存储」，看起来像模块实例重份，
 * 其实是根本没登录。判据要以 `.rail`（已连接外壳）为准。
 */
async function connect(page, { base, server, account, password }) {
  await openPage(page, `${base}/`);
  if (!page.url().includes('/login')) return;
  await page.getByPlaceholder('https://dav.example.com/dav').fill(server);
  await page.getByPlaceholder('你的账号').fill(account);
  await page.getByPlaceholder('应用密码').fill(password);
  await page.getByRole('button', { name: '连接' }).first().click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
  await page.waitForTimeout(500);
}

module.exports = { READY, waitReady, openPage, reloadPage, connect };
