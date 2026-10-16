/**
 * DoNote「笔记数据层」端到端验收（BYOS：直接读写用户自己的坚果云）
 *
 * 不 mock 任何 WebDAV 响应 —— 这条链路的意义就是验证真实坚果云上的
 * 列目录 / 读 / 写 / 改名 / 移动 / 回收站 / 恢复 / 删除是否都成立。
 *
 * 覆盖组合：
 *   1  连接            2  新建笔记            3  编辑 + 自动保存
 *   4  服务端文件核对   5  标题改名（文件跟着改）6  刷新持久化
 *   7  列表摘要补齐     8  正文搜索            9  新建文件夹
 *  10  移动进文件夹    11  软删除进 .trash     12  回收站展示
 *  13  恢复回原目录    14  彻底删除            15  删除文件夹
 *  16  断开连接
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const { openPage, reloadPage } = require('../harness/nav.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5173';
const SHOTS = path.join(H.ART, 'shots-notes');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const TITLE = `E2E测试${STAMP}`;
const FOLDER = `E2E目录${STAMP}`;
const TOKEN = `neirong${STAMP}`;
const BODY = `第一行 ${STAMP}\n\n${TOKEN} 只在正文里出现`;


const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

(async () => {
  const appPassword = H.appPassword();
  if (!appPassword) throw new Error('密钥文件里没有 Nut_Web');
  const auth = 'Basic ' + Buffer.from(`${ACCOUNT}:${appPassword}`).toString('base64');

  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await H.attach(page, ctx);

  const consoleErrors = [];
  const probe404 = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location && m.location();
    const url = loc && loc.url ? loc.url : '';
    // 预期噪音：应用靠 PROPFIND 判断「附件目录 / 回收站原位在不在」，WebDAV 用 404 回答"不存在"，
    // 浏览器会把每个 404 记成资源加载错误。只放行 WebDAV 数据路径（.md / .assets）的 404，
    // 其余（脚本、样式、图片等）的 404 照旧算失败。放行条数会打印出来，不信它被悄悄吞掉。
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      /* 保留原样 */
    }
    if (/status of 404/.test(m.text()) && /\.(md|assets)(\/|$)/.test(decoded)) {
      probe404.push(decoded);
      return;
    }
    consoleErrors.push(`${m.text()} << ${url || '?'}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  /** 直接问坚果云：这个路径在不在 */
  async function davStatus(rel) {
    const res = await ctx.request.fetch(rel ? `${DAV}/${rel}` : DAV, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1' },
      failOnStatusCode: false,
    });
    return res.status();
  }
  async function davText(rel) {
    const res = await ctx.request.fetch(`${DAV}/${rel}`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    return res.ok() ? res.text() : null;
  }
  async function davChildren(rel) {
    const res = await ctx.request.fetch(rel ? `${DAV}/${rel}` : DAV, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1' },
      failOnStatusCode: false,
    });
    if (res.status() !== 207) {
      // 非 207 一律当「空」会让下游的「已清掉」断言假通过（503 时尤其危险），
      // 所以这里把异常状态喊出来：看到这行就别信后面的空结果。
      if (res.status() !== 404) {
        console.log(`  !! davChildren(${rel || '/'}) 状态=${res.status()}（不是 207，按空处理）`);
      }
      return [];
    }
    const xml = await res.text();
    // 命名空间前缀可能是 D: 也可能是 d:，一律按 `:href>` 取
    return [...xml.matchAll(/:href>([^<]+)</g)].map((m) => m[1]);
  }

  async function connect() {
    await openPage(page, BASE + '/');
    if (!page.url().includes('/login')) return;
    await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
    await page.getByPlaceholder('你的账号').fill(ACCOUNT);
    await page.getByPlaceholder('应用密码').fill(appPassword);
    await page.getByRole('button', { name: '连接' }).first().click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
    await page.waitForTimeout(800);
  }

  // ---------- 0. 连接页：服务器地址字段 ----------
  await openPage(page, BASE + '/');
  check('0 未连接时落到连接页', page.url().includes('/login'), page.url());

  const serverInput = page.getByPlaceholder('https://dav.example.com/dav');
  const accountInput = page.getByPlaceholder('你的账号');
  const passwordInput = page.getByPlaceholder('应用密码');
  const connectBtn = page.locator('button[type="submit"]');

  // 引导文案跟着地址走：坚果云给专属步骤，别的地址给通用说明
  check('0 默认地址是坚果云', (await serverInput.inputValue()) === SERVER, await serverInput.inputValue());
  await page.locator('.guide .head').click();
  await page.waitForTimeout(300);
  check('0 坚果云地址给出专属步骤', /坚果云网页版/.test(await page.locator('.guide').innerText()));
  await serverInput.fill('https://cloud.example.com/remote.php/dav');
  await page.waitForTimeout(300);
  const otherGuide = await page.locator('.guide').innerText();
  check('0 其他地址换成通用说明', !/坚果云网页版/.test(otherGuide) && /自己的 WebDAV 服务/.test(otherGuide));
  await page.locator('.guide .head').click();

  // 非法地址不许提交
  await serverInput.fill('cloud.example.com');
  await accountInput.fill(ACCOUNT);
  await passwordInput.fill(appPassword);
  await connectBtn.click();
  await page.waitForTimeout(500);
  check('0 非 http(s) 地址被拦下', page.url().includes('/login'));

  // 地址确实被用上：填一个假地址，用桩接住这个域名的请求。
  // 若代码里偷偷写死坚果云，请求就走不到这个桩上，也就连不上。
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  await page.route(/fakedav\.example/, (route) =>
    route.fulfill({
      status: 207,
      contentType: 'application/xml',
      body: '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"/>',
    }),
  );
  await serverInput.fill('http://fakedav.example/fakedav');
  await connectBtn.click();
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 20000 });
  check(
    '0 填什么地址就连什么（没有写死坚果云）',
    seen.some((u) => u.includes('fakedav.example')),
    seen.filter((u) => u.includes('fakedav.example')).slice(0, 1).join(''),
  );

  // 复位：这次假连接会把凭据写进本机存储，清掉再回到连接页
  await page.unroute(/fakedav\.example/);
  await page.evaluate(() => localStorage.clear());
  await openPage(page, BASE + '/login');
  await page.waitForTimeout(500);
  check('0 复位后回到连接页', page.url().includes('/login'), page.url());

  // ---------- 1. 连接 ----------
  await connect();
  check('1 用真实凭据连上服务器', !page.url().includes('/login'), page.url());

  // ---------- 2. 新建笔记 ----------
  await openPage(page, BASE + '/');
  await page.waitForTimeout(1200);
  const unnamedBefore = (await davChildren('')).filter((h) => decodeURIComponent(h).includes('未命名')).length;
  await page.locator('button.fab').click();
  await page.waitForURL(/\/notes\//, { timeout: 20000 });
  await page.waitForTimeout(600);
  const createdId = page.url().split('/notes/')[1];
  check('2 新建后进入编辑器', !!createdId, createdId);

  // ---------- 3. 编辑 + 自动保存 ----------
  const titleInput = page.locator('input.title-input');
  await titleInput.fill(TITLE);
  // 正文区现在是所见即所得编辑器（Milkdown / ProseMirror），不再是 textarea。
  // 用键盘逐字敲，走的是真实输入路径（含 Markdown 输入规则）。
  const surface = page.locator('.donote-surface .ProseMirror');
  await surface.waitFor({ state: 'visible', timeout: 15000 });
  await surface.click();
  await page.keyboard.type(`第一行 ${STAMP}`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`${TOKEN} 只在正文里出现`);
  await page.waitForFunction(
    () => document.querySelector('.status')?.textContent?.includes('已保存'),
    undefined,
    { timeout: 25000 },
  );
  check('3 输入后自动保存到「已保存」', true);

  const savedId = page.url().split('/notes/')[1];
  check('5 标题改名把 id 一起换掉（文件名跟标题走）', savedId !== createdId, `${createdId} → ${savedId}`);
  await page.screenshot({ path: path.join(SHOTS, '01-editor.png') });

  // ---------- 4. 直接问坚果云：文件真的落了 ----------
  await page.waitForTimeout(1500);
  const fileStatus = await davStatus(`${TITLE}.md`);
  check('4 坚果云上存在 .md 文件', fileStatus === 207, `PROPFIND HTTP ${fileStatus}`);

  const raw = await davText(`${TITLE}.md`);
  check('4 frontmatter 写对了 title', !!raw && raw.includes(`title: "${TITLE}"`));
  check('4 frontmatter 带 created/updated/tags', !!raw && /created: \d+/.test(raw) && /updated: \d+/.test(raw) && raw.includes('tags: []'));
  check('4 正文原样保留', !!raw && raw.includes(TOKEN));
  const rootChildren = await davChildren('');
  check('4 列目录能读到刚写的文件（校验脚本自检）', rootChildren.some((h) => decodeURIComponent(h).includes(`${TITLE}.md`)), `${rootChildren.length} 条`);
  const unnamedAfter = (await davChildren('')).filter((h) => decodeURIComponent(h).includes('未命名')).length;
  check('4 改名后没有留下「未命名」占位文件', unnamedAfter === unnamedBefore, `${unnamedBefore} → ${unnamedAfter}`);

  // ---------- 6. 刷新持久化 ----------
  await reloadPage(page);
  await page.waitForTimeout(2000);
  const reloadedTitle = await page.locator('input.title-input').inputValue();
  await page.locator('.donote-surface .ProseMirror').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);
  const reloadedBody = await page.locator('.donote-surface .ProseMirror').innerText();
  check('6 刷新后标题不丢', reloadedTitle === TITLE, reloadedTitle);
  check('6 刷新后正文不丢', reloadedBody.includes(TOKEN));

  // ---------- 7 + 8. 列表摘要与搜索 ----------
  await openPage(page, BASE + '/');
  await page.waitForFunction(() => !document.querySelector('.skeleton'), undefined, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(4000);
  // ⚠️ 判据必须限定在列表区：侧栏的文件夹树也会把笔记标题显示出来，
  //    拿 body 全文判「列表里有/没有这篇」已经不成立（批次 5 侧栏树形导航加的）。
  const listText = () => page.locator('.page-body').innerText();
  const homeText = await listText();
  check('7 列表里出现这篇笔记', homeText.includes(TITLE));
  check('7 列表补出了正文摘要', homeText.includes(TOKEN), '首次进入可能需要一轮补齐');
  await page.screenshot({ path: path.join(SHOTS, '02-home.png') });

  // 侧边栏现在也有一个搜索框，这里要的是列表页正文区那个，必须限定范围
  const search = page.locator('.page-body .search input[type="search"]');
  await search.fill(TOKEN);
  await page.waitForTimeout(2500);
  check('8 按正文关键词能搜到', (await listText()).includes(TITLE));
  await search.fill(STAMP + 'zzz');
  await page.waitForTimeout(2500);
  check('8 无关关键词搜不到', !(await listText()).includes(TITLE));
  await search.fill('');
  await page.waitForTimeout(2000);

  // ---------- 9. 新建文件夹 ----------
  await openPage(page, BASE + '/folders');
  await page.waitForTimeout(2000);
  await page.locator('button.btn-major.full').click();
  await page.locator('[role="dialog"] input.dialog-input').fill(FOLDER);
  await page.locator('[role="dialog"] .major').click();
  await page.waitForTimeout(3000);
  check('9 坚果云上建出了目录', (await davStatus(FOLDER)) === 207, `/${FOLDER}`);
  check('9 文件夹列表出现它', (await page.locator('body').innerText()).includes(FOLDER));
  await page.screenshot({ path: path.join(SHOTS, '03-folders.png') });

  // ---------- 10. 移动笔记进文件夹 ----------
  await openPage(page, `${BASE}/notes/${savedId}`);
  await page.waitForTimeout(2500);
  await page.locator('button.more').click();
  await page.locator('.sheet-item', { hasText: '移动到文件夹' }).click();
  await page.waitForTimeout(600);
  await page.locator('.folder-pick', { hasText: FOLDER }).click();
  // 移动要打 PROPFIND + MOVE + PUT 三次往返，等 URL 真的换掉，别用固定等待
  await page.waitForURL((u) => !u.pathname.endsWith(savedId), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const movedId = page.url().split('/notes/')[1];
  check('10 移动后路由的 id 更新', movedId !== savedId, `${savedId} → ${movedId}`);
  check('10 文件出现在子目录里', (await davStatus(`${FOLDER}/${TITLE}.md`)) === 207);
  check('10 原位置的文件已不在', (await davStatus(`${TITLE}.md`)) === 404);

  // ---------- 11. 软删除 ----------
  await page.locator('button.more').click();
  await page.locator('.sheet-item', { hasText: '删除' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('[role="dialog"] .major').click();
  await page.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
  await page.waitForTimeout(2500);
  check('11 软删除后原文件移走', (await davStatus(`${FOLDER}/${TITLE}.md`)) === 404);

  const trashHrefs = await davChildren('.trash');
  check('11 .trash 目录能被列出来（校验脚本自检）', trashHrefs.length >= 1, `${trashHrefs.length} 条`);
  const trashed = trashHrefs.filter((h) => decodeURIComponent(h).includes(TITLE));
  check('11 .trash 里出现了它', trashed.length === 1, trashed[0] || '(空)');
  const trashRaw = trashed[0] ? await davText(trashed[0].split('/dav/DoNote/')[1]) : null;
  check('11 frontmatter 记下了原路径', !!trashRaw && trashRaw.includes(`deleted_from: "${FOLDER}/${TITLE}.md"`));
  check('11 frontmatter 记下了删除时间', !!trashRaw && /deleted_at: \d+/.test(trashRaw));

  // ---------- 12 + 13. 回收站展示与恢复 ----------
  await openPage(page, BASE + '/trash');
  await page.waitForTimeout(4000);
  check('12 回收站里列出来了', (await page.locator('body').innerText()).includes(TITLE));
  await page.screenshot({ path: path.join(SHOTS, '04-trash.png') });

  await page.locator('.row-card', { hasText: TITLE }).locator('button', { hasText: '恢复' }).click();
  await page.waitForTimeout(4500);
  check('13 恢复回原文件夹', (await davStatus(`${FOLDER}/${TITLE}.md`)) === 207);
  const trashAfter = (await davChildren('.trash')).filter((h) => decodeURIComponent(h).includes(TITLE));
  check('13 回收站里已清掉', trashAfter.length === 0);
  // ---------- 14. 彻底删除 ----------
  await openPage(page, BASE + '/folders');
  await page.waitForTimeout(2500);
  await page.locator('.folder-link', { hasText: FOLDER }).click();
  await page.waitForURL(/\/folders\//, { timeout: 20000 });
  await page.waitForTimeout(3000);
  const folderNote = page.locator('.card', { hasText: TITLE }).first();
  check('14 文件夹详情里能看到这篇笔记', (await folderNote.count()) > 0);
  await folderNote.click();
  await page.waitForTimeout(2500);
  await page.locator('button.more').click();
  await page.locator('.sheet-item', { hasText: '删除' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('[role="dialog"] .major').click();
  await page.waitForURL((u) => u.pathname === '/', { timeout: 20000 });
  await page.waitForTimeout(2500);

  // 从回收站彻底删除
  await openPage(page, BASE + '/trash');
  await page.waitForTimeout(4000);
  await page.locator('.row-card', { hasText: TITLE }).locator('button', { hasText: '彻底删除' }).click();
  await page.waitForTimeout(600);
  await page.locator('[role="dialog"] .major').click();
  await page.waitForTimeout(4500);
  check(
    '14 彻底删除后 .trash 里也没了',
    (await davChildren('.trash')).filter((h) => decodeURIComponent(h).includes(TITLE)).length === 0,
  );

  // ---------- 15. 删除文件夹 ----------
  await openPage(page, BASE + '/folders');
  await page.waitForTimeout(3000);
  await page.locator('.folder-row', { hasText: FOLDER }).locator('.folder-more').click();
  await page.waitForTimeout(600);
  await page.locator('.sheet-item', { hasText: '删除文件夹' }).click();
  await page.waitForTimeout(600);
  await page.locator('[role="dialog"] .major').click();
  await page.waitForTimeout(4000);
  check('15 文件夹已从服务器删掉', (await davStatus(FOLDER)) === 404, `/${FOLDER}`);

  // ---------- 16. 断开连接 ----------
  await openPage(page, BASE + '/settings');
  await page.waitForTimeout(2500);
  const settingsText = await page.locator('body').innerText();
  check('16 设置页展示账号与同步目录', settingsText.includes(ACCOUNT) && settingsText.includes('/DoNote'));
  check('16 设置页展示服务器地址', settingsText.includes('dav.jianguoyun.com'), '');
  check('16 有「关于」区块且显示版本号', /关于/.test(settingsText) && /版本/.test(settingsText) && /\d+\.\d+\.\d+/.test(settingsText));
  check('16 浏览器里不出现桌面专属的更新按钮', !/立即更新并重启/.test(settingsText));
  check('16 不再出现「分享管理」', !/分享管理/.test(settingsText));
  await page.screenshot({ path: path.join(SHOTS, '05-settings.png') });

  await page.locator('button.logout').click();
  await page.waitForURL(/\/login/, { timeout: 20000 });
  const afterLogout = await page.evaluate(() => localStorage.getItem('donote.nutstore'));
  check('16 断开后回到连接页', page.url().includes('/login'));
  check('16 本机凭据已清除', !afterLogout);

  check('无预期外的控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  console.log(`（另有 ${probe404.length} 条 .md/.assets 的 404 探测噪音已放行）`);

  H.finish();
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(' / '));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(2);
});
