/**
 * KaTeX 公式：渲染 + 编辑面板。
 *
 * 默认走同源假 DAV；USE_REAL_DAV=1 才连真坚果云。断言逻辑两边完全一致。
 *
 * 共 15 项：
 *   功能 1 工具栏点「公式」→ 插入块级公式并弹面板   2 输入 `$$` → 转块级公式
 *       3 输入 `$x^2$` → 行内公式渲染               4 点击块级公式 → 弹面板
 *       5 面板编辑 LaTeX → 实时预览                 6 关闭面板 → 正文里的公式更新
 *       7 复杂公式（\frac \int \sum \sqrt）不报错    8 暗 / 亮两套主题下颜色跟随
 *   落盘 1 块级 `$$…$$` 结构正确                    2 行内 `$…$` 结构正确
 *       3 与批次 2 的 `\,` 修复兼容（间距指令不被吃）
 *   兼容 1 价格文本里的 `$` 不转成公式              1b 重新打开后 `\$` 还原成 `$`
 *       2 思维导图块不受影响                        3 全程没有意外的 console 错误
 *
 * 用法：BASE=http://localhost:5173 node math-e2e.cjs
 */
const { chromium } = require('playwright-core');
const H = require('../harness/davmode.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5173';
const SHOTS = path.join(H.ART, 'shots-math');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
/** 工具栏插入 / 面板 / 复杂公式 / 主题 —— 都在这篇里 */
const MAIN = `X1${STAMP}`;
/** 输入规则 / 落盘 —— 从空文档开局，光标好定位 */
const TYPE = `X2${STAMP}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

/** 笔记 id 是相对路径的 base64url，反推回 DAV 路径（与 notes.ts 的 decodeId 同一套） */
function decodeId(id) {
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
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
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location && m.location().url) || '';
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      /* 保留原样 */
    }
    // 预期噪音：WebDAV 用 404 回答「不存在」
    if (/status of 404/.test(m.text()) && /\/dav\/DoNote\//.test(decoded)) return;
    consoleErrors.push(`${m.text()} << ${url || '?'}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  /* ------------------------------ DAV 小工具 ------------------------------ */

  async function davText(rel) {
    const res = await ctx.request.fetch(`${DAV}/${encodeURI(rel)}`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    return res.ok() ? await res.text() : null;
  }
  async function davDelete(rel) {
    await ctx.request
      .fetch(`${DAV}/${encodeURI(rel)}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
        failOnStatusCode: false,
      })
      .catch(() => undefined);
  }

  /* ------------------------------ 页面小工具 ------------------------------ */

  const surface = page.locator('.donote-surface .ProseMirror');
  const dialog = page.locator('[aria-label="编辑公式"]');
  const source = page.locator('textarea[aria-label="LaTeX 源码"]');
  /** 正文里的块级公式（NodeView 的那一层） */
  const blocks = page.locator('.donote-surface .donote-math-block');
  const inlines = page.locator('.donote-surface .donote-math-inline');

  /** 等到自动保存完成（防抖 1200ms + 请求），再给一点落盘余量 */
  async function settled() {
    await page.waitForTimeout(1800);
    await page.waitForFunction(
      () => document.querySelector('.status')?.textContent?.includes('已保存'),
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(400);
  }

  /** 空白处右键 →「新建笔记」，返回它的 DAV 相对路径 */
  async function newNote() {
    const box = await page.locator('.tree').boundingBox();
    await page.mouse.click(box.x + 24, box.y + box.height - 24, { button: 'right' });
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '新建笔记' }).first().click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    return decodeId(page.url().split('/notes/')[1] || '');
  }

  /** 标题即文件名：填完要等它改名落盘 */
  async function renameTo(name) {
    await page.locator('input.title-input').fill(name);
    await settled();
    await page.waitForTimeout(600);
  }

  /** 把光标放到正文里，并确认编辑器拿到了焦点 */
  async function focusBody() {
    await surface.click();
    await page.waitForTimeout(300);
  }

  async function openBlockPanel(index = 0) {
    await blocks.nth(index).click();
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
  }

  async function finishPanel() {
    await dialog.getByRole('button', { name: '完成' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(500);
  }

  try {
    /* ============================== 准备 ============================== */

    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
      await page.getByPlaceholder('你的账号').fill(ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.getByRole('button', { name: '连接' }).first().click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(1200);
    }

    /* ==================== 第一篇：工具栏 / 面板 / 落盘 ==================== */

    const mainRel = await newNote();
    await renameTo(MAIN);
    const mainPath = `${MAIN}.md`;

    // ---------- 功能 1：工具栏点「公式」→ 插入块级公式 + 弹面板 ----------
    await page.getByRole('button', { name: '公式', exact: true }).click();
    await page.waitForTimeout(700);
    const blockCount = await blocks.count();
    const panelShown = await dialog.isVisible().catch(() => false);
    check(
      '功能 1 工具栏点「公式」→ 插入块级公式并弹出面板',
      blockCount === 1 && panelShown,
      `block=${blockCount} panel=${panelShown}`,
    );
    await page.screenshot({ path: path.join(SHOTS, '01-inserted.png') });

    // ---------- 功能 5：面板里改 LaTeX → 预览实时跟着变 ----------
    await source.fill('E = mc^2');
    await page.waitForTimeout(500);
    const previewKatex = await dialog.locator('.preview-math .katex').count();
    const previewText = (await dialog.locator('.preview-math').innerText().catch(() => '')).trim();
    check(
      '功能 5 面板编辑 LaTeX → 预览实时排版',
      previewKatex > 0 && previewText.length > 0,
      `katex=${previewKatex} text=${JSON.stringify(previewText)}`,
    );
    await page.screenshot({ path: path.join(SHOTS, '02-panel.png') });

    // ---------- 功能 6：点「完成」→ 正文里的公式跟着更新 ----------
    await finishPanel();
    const bodyAfterSave = (await blocks.first().innerText().catch(() => '')).trim();
    const bodyKatex = await blocks.first().locator('.katex').count();
    check(
      '功能 6 关闭面板 → 正文里的公式更新',
      bodyKatex > 0 && bodyAfterSave.length > 0,
      `katex=${bodyKatex} text=${JSON.stringify(bodyAfterSave)}`,
    );

    // ---------- 功能 4：点击正文里的块级公式 → 重新弹面板 ----------
    await openBlockPanel(0);
    const reopened = await dialog.isVisible().catch(() => false);
    const sourceFilled = await source.inputValue();
    check(
      '功能 4 点击块级公式 → 弹出编辑面板（源码回填）',
      reopened && sourceFilled.trim() === 'E = mc^2',
      `open=${reopened} source=${JSON.stringify(sourceFilled)}`,
    );

    // ---------- 功能 7：复杂公式不报错 ----------
    const COMPLEX = '\\frac{a}{b} + \\int_0^1 x\\,dx + \\sum_{n=1}^{\\infty} \\sqrt{2}';
    await source.fill(COMPLEX);
    await page.waitForTimeout(600);
    const previewErrors = await dialog.locator('.preview-math .katex-error').count();
    const previewRendered = await dialog.locator('.preview-math .katex').count();
    await finishPanel();
    const bodyErrors = await blocks.first().locator('.katex-error').count();
    check(
      '功能 7 复杂公式（\\frac \\int \\sum \\sqrt）正确渲染',
      previewErrors === 0 && bodyErrors === 0 && previewRendered > 0,
      `previewErr=${previewErrors} bodyErr=${bodyErrors}`,
    );

    // ---------- 功能 8：暗 / 亮两套主题下颜色跟随 ----------
    const colorOf = () =>
      page.evaluate(() => {
        const el = document.querySelector('.donote-surface .donote-math-block .katex');
        return el ? getComputedStyle(el).color : '';
      });
    const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme || '');
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.waitForTimeout(300);
    const lightColor = await colorOf();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.waitForTimeout(300);
    const darkColor = await colorOf();
    await page.evaluate((t) => {
      // 原本就没有这个属性时不要留下一个空的 data-theme=""，那和「没有」不是一回事
      if (t) document.documentElement.dataset.theme = t;
      else delete document.documentElement.dataset.theme;
    }, originalTheme);
    check(
      '功能 8 暗 / 亮模式下公式样式跟随主题',
      !!lightColor && !!darkColor && lightColor !== darkColor,
      `light=${lightColor} dark=${darkColor}`,
    );

    // ---------- 落盘 1：块级公式 ----------
    await settled();
    const mainRaw = await davText(mainPath);
    check(
      '落盘 1 块级公式落盘成 $$…$$ 结构',
      !!mainRaw && /\$\$\n[^]*?\n\$\$/.test(mainRaw) && mainRaw.includes('\\frac{a}{b}'),
      JSON.stringify((mainRaw || '').slice(-160)),
    );

    await page.screenshot({ path: path.join(SHOTS, '03-body.png') });

    /* ==================== 第二篇：输入规则 / 兼容 ==================== */

    const typeRel = await newNote();
    await renameTo(TYPE);
    const typePath = `${TYPE}.md`;
    await focusBody();

    // ---------- 兼容 1：价格文本不被误转 ----------
    // 第二个 `$` 前面是空格 —— 行内公式要求 `$` 紧贴内容，正好把这一句挡住
    await page.keyboard.type('cost $5 and $10');
    await page.waitForTimeout(500);
    const priceInline = await inlines.count();
    check('兼容 1 单个 / 成对出现的价格 $ 不被误转', priceInline === 0, `inline=${priceInline}`);

    // ---------- 功能 3：`$x^2$` → 行内公式 ----------
    await page.keyboard.press('Enter');
    await page.keyboard.type('$x^2$');
    await page.waitForTimeout(500);
    const inlineCount = await inlines.count();
    const inlineKatex = await inlines.first().locator('.katex').count().catch(() => 0);
    check(
      '功能 3 输入 $x^2$ → 行内公式渲染',
      inlineCount === 1 && inlineKatex > 0,
      `inline=${inlineCount} katex=${inlineKatex}`,
    );

    // ---------- 落盘 3 的前置：带 `\,` 的公式也要转成节点 ----------
    // 只查落盘是不够的 —— 没转成节点时正文里照样是 `$x\,dx$` 那串原文，落盘检查会假绿
    await page.keyboard.press('Enter');
    await page.keyboard.type('$x\\,dx$');
    await page.waitForTimeout(500);
    const spacedInline = await inlines.count();

    // ---------- 功能 2：输入 `$$` → 转块级公式 ----------
    await page.keyboard.press('Enter');
    await page.keyboard.type('$$');
    await page.waitForTimeout(700);
    const blocksInType = await blocks.count();
    check('功能 2 输入 $$ → 转成块级公式', blocksInType === 1, `block=${blocksInType}`);

    // ---------- 落盘 2 / 3：行内公式与间距指令的正文 ----------
    await settled();
    const typeRaw = await davText(typePath);
    // 价格文本里的 `$` 会被序列化器转义成 `\$` —— 这是**要**的：不转义的话，下次解析时
    // `$5 and $10` 中间那一段正好凑成一个 `$…$`，价格就被吃成公式了。转义后语义不变。
    check(
      '落盘 2 行内公式落盘成 $…$ 结构，价格文本转义成 \\$（免得被误认成公式）',
      !!typeRaw && typeRaw.includes('$x^2$') && typeRaw.includes('cost \\$5 and \\$10'),
      JSON.stringify((typeRaw || '').slice(-200)),
    );
    check(
      '落盘 3 间距指令 \\, 落盘后仍在（批次 2 的修复没有回退）',
      !!typeRaw && typeRaw.includes('$x\\,dx$') && spacedInline === 2,
      `inline=${spacedInline} | ${JSON.stringify((typeRaw || '').slice(-120))}`,
    );

    // ---------- 兼容 1b：重新打开后价格文本显示如常（`\$` 要还原成 `$`） ----------
    // 上一条只证明「落盘是合法的 Markdown 转义」，这一条证明「读回来还是用户写的那句话」
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    await page.locator('.tree-row').filter({ hasText: TYPE }).first().locator('a.tree-link').first().click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    // 这一篇没有改动，`.status` 不会挂「已保存」，所以只等正文渲染出来
    await page
      .waitForFunction(
        () => (document.querySelector('.donote-surface .ProseMirror')?.innerText ?? '').includes('cost'),
        undefined,
        { timeout: 20000 },
      )
      .catch(() => {});
    const reopenedText = await surface.innerText();
    check(
      '兼容 1b 重新打开后价格文本仍是「cost $5 and $10」（\\$ 已还原）',
      reopenedText.includes('cost $5 and $10') && !reopenedText.includes('\\$'),
      JSON.stringify(reopenedText.replace(/\s+/g, ' ').slice(0, 90)),
    );

    // ---------- 兼容 2：思维导图块不受影响 ----------
    await focusBody();
    await page.getByRole('button', { name: '思维导图', exact: true }).click();
    await page.waitForTimeout(2600);
    const mermaidSvg = await page.locator('.donote-surface .donote-mermaid svg').count();
    check('兼容 2 思维导图块不受影响（照常出图）', mermaidSvg > 0, `svg=${mermaidSvg}`);
    await page.screenshot({ path: path.join(SHOTS, '04-mixed.png') });

    // ---------- 收尾 ----------
    check('兼容 3 全程没有意外的 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));

    await davDelete(mainPath);
    await davDelete(typePath);
    console.log('\n清理：已删除本次造出的两篇笔记');
  } finally {
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'math-e2e.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(2);
});
