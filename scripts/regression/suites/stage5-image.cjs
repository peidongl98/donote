/**
 * 阶段 5 验收：图片按钮。
 *
 * 真实坚果云，无 mock。走浏览器退化路径（临时 <input type="file">），因为它和桌面端的
 * 系统对话框共用同一段上传 + 插入逻辑；桌面端那条只剩「选文件」这一步不同。
 *
 * 用法：BASE=http://localhost:5176 node stage5-image.cjs
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const { openPage, reloadPage } = require('../harness/nav.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5176';
const SHOTS = path.join(H.ART, 'shots-stage5');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const TITLE = `S5图片${STAMP}`;
const IMG_NAME = '图片1.png';

/** 1×1 PNG，够用就行 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
    if (/status of 404/.test(m.text()) && /\.(md|assets|png)(\/|$)/.test(url)) return; // 图片走相对路径，dev 下取不到是预期的
    consoleErrors.push(`${m.text()} << ${url || '?'}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const surface = page.locator('.donote-surface .ProseMirror');
  const tool = (label) => page.locator(`.toolbar button[aria-label="${label}"]`);

  /**
   * 正文里真正的图片。
   *
   * 不能直接数 `img`：ProseMirror 会给行内叶节点旁边塞一个
   * `<img class="ProseMirror-separator">`（光标定位用），数进去就多一张。
   */
  const picture = (scope) => scope.locator('img:not(.ProseMirror-separator)');

  async function davStatus(rel) {
    const res = await ctx.request.fetch(`${DAV}/${encodeURI(rel)}`, {
      method: 'GET',
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    return res;
  }

  try {
    await openPage(page, BASE + '/');
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
      await page.getByPlaceholder('你的账号').fill(ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.getByRole('button', { name: '连接' }).first().click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(1200);
    }

    // 建一篇并改名 —— 顺便验证「改过名之后 noteId 指向新路径」这条
    await page.locator('.rail button.new').click();
    await page.waitForURL(/\/notes\//, { timeout: 25000 });
    await page.locator('input.title-input').fill(TITLE);
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(400);

    // 先写一行字，插图应该插在光标处（文末）
    await surface.click();
    await page.waitForTimeout(150);
    await page.keyboard.type('图文一段');
    await page.waitForTimeout(300);

    check('1 工具栏有「图片」按钮', await tool('图片').isVisible());

    // ---------- 点图片 → 选文件 ----------
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 });
    await tool('图片').click();
    const chooser = await chooserPromise;
    check('2 点「图片」弹出了选文件对话框', true);
    await chooser.setFiles([{ name: IMG_NAME, mimeType: 'image/png', buffer: PNG }]);

    // ---------- 编辑器里 ----------
    // 图片要等「上传完成 → 插进正文 → Milkdown 序列化回来」三跳，不能用固定 sleep 赌时间
    const img = picture(surface);
    let appeared = true;
    await img.first().waitFor({ state: 'attached', timeout: 30000 }).catch(() => {
      appeared = false;
    });
    check('3 编辑器里插入了一张图', appeared && (await img.count()) === 1, `${await img.count()} 张`);
    const src = await img.first().getAttribute('src').catch(() => null);
    check('4 src 指向笔记自己的附件目录', src === `${TITLE}.assets/${IMG_NAME}`, String(src));
    const alt = await img.first().getAttribute('alt').catch(() => null);
    check('5 alt 用的是文件名（去掉扩展名）', alt === '图片1', String(alt));
    await page.screenshot({ path: path.join(SHOTS, '01-inserted.png') });

    // ---------- 落盘 ----------
    await page.waitForFunction(
      () => document.querySelector('.status')?.textContent?.includes('已保存'),
      undefined,
      { timeout: 25000 },
    );
    await page.waitForTimeout(1200);

    const raw = await (await ctx.request.fetch(`${DAV}/${encodeURI(`${TITLE}.md`)}`, { headers: { Authorization: auth } })).text();
    check('6 正文写成了 ![alt](相对路径)', raw.includes(`![图片1](${TITLE}.assets/${IMG_NAME})`), raw.split('\n').filter(Boolean).pop());

    // ---------- 附件真的在网盘上 ----------
    const res = await davStatus(`${TITLE}.assets/${IMG_NAME}`);
    check('7 附件躺在 note.assets 目录里', res.ok(), `HTTP ${res.status()}`);
    const got = Buffer.from(await res.body());
    check('8 附件内容与选中的文件逐字节一致', got.equals(PNG), `${got.length} 字节`);

    // ---------- 刷新后还在 ----------
    await reloadPage(page);
    await surface.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(800);
    check('9 刷新后图还在', (await picture(surface).count()) === 1);
    check(
      '9 刷新后 src 没变',
      (await picture(surface).first().getAttribute('src')) === `${TITLE}.assets/${IMG_NAME}`,
    );

    check('10 全程没有意外的 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  } finally {
    for (const rel of [`${TITLE}.md`, `${TITLE}.assets/${IMG_NAME}`]) {
      await ctx.request
        .fetch(`${DAV}/${encodeURI(rel)}`, {
          method: 'DELETE',
          headers: { Authorization: auth },
          failOnStatusCode: false,
        })
        .catch(() => undefined);
    }
    await ctx.request
      .fetch(`${DAV}/${encodeURI(`${TITLE}.assets`)}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
        failOnStatusCode: false,
      })
      .catch(() => undefined);
    console.log(`清理：已删除 DoNote/${TITLE}.md 与 .assets`);
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'stage5-image.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
