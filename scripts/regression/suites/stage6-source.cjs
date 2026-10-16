/**
 * 阶段 6 验收：顶栏的「源码 / 所见即所得」开关。
 *
 * 真实坚果云，无 mock。要点是三件事：
 *  1. 开关在顶栏右侧、是个图标按钮，两种模式共用一个位置
 *  2. 源码模式是裸 textarea + 右侧 markdown 预览，字节进出，不经过 Milkdown 序列化
 *  3. 首次切回所见即所得会先提示「格式会被统一规范化」，可以勾「不再提示」
 *
 * 用法：BASE=http://localhost:5176 node stage6-source.cjs
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const { openPage, reloadPage } = require('../harness/nav.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5176';
const SHOTS = path.join(H.ART, 'shots-stage6');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const TITLE = `S6源码${STAMP}`;
const TOKEN = `neirong${STAMP}`;

/** 源码模式里手写的正文：带 \, 的公式 + 行尾两个空格。这两样都被 Milkdown 规范化过 */
const RAW_BODY = [
  `# 源码标题${STAMP}`,
  '',
  `正文里有 ${TOKEN} 这个词。`,
  '',
  '行内公式 $\\int_0^1 x^2 \\, dx$ 后面留着两个空格  ',
  '',
  '$$',
  'a \\, b',
  '$$',
  '',
].join('\n');

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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await H.attach(page, ctx);

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location && m.location().url) || '';
    // 图片走相对路径，dev 下取不到是预期的
    if (/status of 404/.test(m.text()) && /\.(md|assets|png)(\/|$)/.test(url)) return;
    consoleErrors.push(`${m.text()} << ${url || '?'}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const surface = page.locator('.donote-surface .ProseMirror');
  const source = page.locator('textarea.source');
  /**
   * 顶栏右侧那个开关：两种模式下 aria-label 不同，位置是同一个。
   *
   * ⚠️ 必须 `exact`：本套件的笔记叫「源码标题…」，正文下方的**子页面卡片**按钮的
   * 可访问名就是笔记标题，模糊匹配会把「源码」同时命中它（strict mode violation）。
   */
  const toggle = (label) => page.getByRole('button', { name: label, exact: true });
  const dialogMajor = page.locator('[role="dialog"] .major');

  /** 笔记文件 = frontmatter + 正文，源码模式里看到的只是正文那一段 */
  function bodyOf(raw) {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
    return m ? raw.slice(m[0].length).replace(/^\r?\n/, '') : raw;
  }

  async function davText(rel) {
    const res = await ctx.request.fetch(`${DAV}/${encodeURI(rel)}`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    return res.ok() ? res.text() : null;
  }

  async function savedNow() {
    await page.waitForFunction(
      () => document.querySelector('.status')?.textContent?.includes('已保存'),
      undefined,
      { timeout: 25000 },
    );
    await page.waitForTimeout(1000);
  }

  try {
    // ---------- 登录 + 建一篇 ----------
    await openPage(page, BASE + '/');
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
      await page.getByPlaceholder('你的账号').fill(ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.getByRole('button', { name: '连接' }).first().click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(1000);
    }
    check('0 连上服务器', !page.url().includes('/login'), page.url());

    await page.locator('.rail button.new').click();
    await page.waitForURL(/\/notes\//, { timeout: 25000 });
    await page.locator('input.title-input').fill(TITLE);
    await surface.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(300);

    await surface.click();
    await page.waitForTimeout(150);
    await page.keyboard.type(`先写一句 ${TOKEN}`);
    await savedNow();

    // ---------- 1. 开关在顶栏 ----------
    check('1 顶栏右侧有「源码」图标开关', await toggle('源码').isVisible());
    const inTopbar = await page.evaluate(() => {
      const btn = document.querySelector('header.topbar button[aria-label="源码"]');
      return !!btn;
    });
    check('1 它确实在顶栏里，不在正文区', inTopbar);

    // ---------- 2. 进源码模式 ----------
    await toggle('源码').click();
    await source.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
    check('2 点它切到源码模式，出现 textarea', await source.isVisible());
    check('2 所见即所得编辑器已经撤掉', (await surface.count()) === 0);
    await page.screenshot({ path: path.join(SHOTS, '01-source.png') });

    // ---------- 3. 右侧 markdown 预览 ----------
    const preview = page.locator('.source-preview');
    check('3 源码模式右侧有预览栏', await preview.isVisible());
    // 这一刻正文只有一句话，没有标题，所以数 <p> 而不是 <h1>
    check('3 预览把 markdown 渲染成了标签', (await preview.locator('p').count()) >= 1, `${await preview.locator('p').count()} 个 p`);
    check('3 预览的内容就是正文', (await preview.innerText()).includes(TOKEN));
    const sideBySide = await page.evaluate(() => {
      const a = document.querySelector('textarea.source').getBoundingClientRect();
      const b = document.querySelector('.source-preview').getBoundingClientRect();
      return b.left >= a.right - 1;
    });
    check('3 预览在源码右边，不是上下堆着', sideBySide);

    // ---------- 4. 源码就是磁盘正文 ----------
    const raw0 = await davText(`${TITLE}.md`);
    check('4 源码拿到的就是磁盘正文（逐字符一致）', (await source.inputValue()) === bodyOf(raw0));
    check('4 源码里没有 frontmatter', !(await source.inputValue()).startsWith('---'));

    // ---------- 5. 字节精确：写进去什么就是什么 ----------
    await source.fill(RAW_BODY);
    check('5 预览跟着源码一起变', (await preview.locator('h1').innerText()).trim() === `源码标题${STAMP}`);
    await savedNow();
    const raw1 = await davText(`${TITLE}.md`);
    check('5 落盘正文与源码逐字节一致（没被规范化）', bodyOf(raw1) === RAW_BODY);
    check('5 公式里的 \\, 原样保留', (raw1 || '').includes('x^2 \\, dx') && (raw1 || '').includes('a \\, b'));
    check('5 行尾两个空格原样保留', (raw1 || '').includes('两个空格  \n'), JSON.stringify((raw1 || '').slice(-40)));

    // ---------- 6. 首次切回会先提示 ----------
    await toggle('所见即所得').click();
    await dialogMajor.waitFor({ state: 'visible', timeout: 8000 });
    const tip = await page.locator('[role="dialog"] .tip').innerText();
    check('6 首次切回先弹提示', tip.includes('格式会被统一规范化'), tip.trim());
    check('6 提示里有「不再提示」勾选', (await page.locator('[role="dialog"] .check input').count()) === 1);
    await page.screenshot({ path: path.join(SHOTS, '02-confirm.png') });

    // ---------- 7. 取消就留在源码模式 ----------
    await page.locator('[role="dialog"] .ghost').click();
    await page.waitForTimeout(400);
    check('7 取消后仍留在源码模式', (await source.isVisible()) && (await surface.count()) === 0);

    // ---------- 8. 勾「不再提示」再继续 ----------
    await toggle('所见即所得').click();
    await dialogMajor.waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[role="dialog"] .check input').check();
    await dialogMajor.click();
    await surface.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(600);
    check('8 继续后回到所见即所得', (await source.count()) === 0);
    const backText = await surface.innerText();
    check('8 切回来内容没丢', backText.includes(TOKEN) && backText.includes(`源码标题${STAMP}`));
    check('8 公式文本还在（渲染成什么样另说）', backText.includes('dx'));
    await page.screenshot({ path: path.join(SHOTS, '03-back.png') });

    // ---------- 9. 记住「不再提示」 ----------
    await toggle('源码').click();
    await source.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
    await toggle('所见即所得').click();
    await page.waitForTimeout(1200);
    check('9 第二次切回不再弹提示', (await dialogMajor.count()) === 0);
    check('9 第二次切回直接回到所见即所得', await surface.isVisible());

    check('10 全程没有意外的 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  } finally {
    await ctx.request
      .fetch(`${DAV}/${encodeURI(`${TITLE}.md`)}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
        failOnStatusCode: false,
      })
      .catch(() => undefined);
    console.log(`清理：已删除 DoNote/${TITLE}.md`);
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'stage6-source.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
