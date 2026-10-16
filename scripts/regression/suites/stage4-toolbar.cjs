/**
 * 阶段 4 验收：Word 式工具栏 17 项。
 *
 * 真实坚果云，无 mock。每一项都既看编辑器 DOM 变了没，也看最终落盘的 Markdown 对不对 ——
 * 只验 DOM 会漏掉「看着对、存下来是错的」这类问题。
 *
 * 用法：BASE=http://localhost:5176 node stage4-toolbar.cjs
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5176';
const SHOTS = path.join(H.ART, 'shots-stage4');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const TITLE = `S4工具栏${STAMP}`;

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
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      /* 原样 */
    }
    if (/status of 404/.test(m.text()) && /\.(md|assets)(\/|$)/.test(decoded)) return;
    consoleErrors.push(`${m.text()} << ${url || '?'}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const surface = page.locator('.donote-surface .ProseMirror');
  const tool = (label) => page.locator(`.toolbar button[aria-label="${label}"]`);

  async function davText(rel) {
    const res = await ctx.request.fetch(`${DAV}/${rel}`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    return res.ok() ? await res.text() : null;
  }

  /**
   * 点完之后必须等一下再发下一条命令。
   *
   * Chromium 里「点一下 → ProseMirror 记录的选区跟上」是异步的：DOM 选区在 mousedown
   * 就折叠了，视图里的选区要等下一轮 selectionchange 才更新。中间这一小段窗口里发出的
   * 命令（回车/删除/加粗）会作用在点击之前那段旧选区上 —— 实测会把刚选中的文字删掉。
   * 真人手速到不了这个窗口，但自动化点完立刻就按键，必然撞上。
   */
  const settle = (ms = 150) => page.waitForTimeout(ms);

  /** 光标是否落在代码块里（文末常常就是刚插入的代码块） */
  function inCodeBlock() {
    return page.evaluate(() => {
      const sel = window.getSelection();
      const node = sel && sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      return !!(el && el.closest && el.closest('pre'));
    });
  }

  /**
   * 光标移到文末，开一段新段落。
   *
   * 文末可能落在代码块里（回车只会换行，后面的内容会被吸进代码块），先按 Ctrl+Enter
   * 退出来 —— 那是 ProseMirror 的 exitCode，专门干这个。
   */
  async function freshParagraph() {
    await surface.click();
    await settle();
    await page.keyboard.press('Control+End');
    await settle(80);
    if (await inCodeBlock()) {
      await page.keyboard.press('Control+Enter');
      await settle(80);
    }
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  }

  try {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
      await page.getByPlaceholder('你的账号').fill(ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.getByRole('button', { name: '连接' }).first().click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(1200);
    }

    // 用侧边栏的「新建笔记」建一篇
    await page.locator('.rail button.new').click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await page.locator('input.title-input').fill(TITLE);
    await surface.waitFor({ state: 'visible', timeout: 15000 });

    // ---------- 1. 工具栏在 ----------
    check('1 工具栏出现在编辑器顶部', await page.locator('.toolbar').isVisible());
    const toolCount = await page.locator('.toolbar button[aria-label]').count();
    check('1 16 个操作按钮齐全（＋段落样式下拉共 17 项）', toolCount === 16, `${toolCount} 个按钮`);
    check('1 段落样式下拉在', await page.locator('.toolbar select').count() === 1);
    await page.screenshot({ path: path.join(SHOTS, '01-toolbar.png') });

    // ---------- 2. 段落样式：标题 ----------
    await surface.click();
    await settle();
    await page.keyboard.type('一级标题');
    await page.locator('.toolbar select').selectOption('1');
    await page.waitForTimeout(300);
    check('2 段落样式→标题 1 生效', (await surface.locator('h1').count()) >= 1);

    // ---------- 3. 行内样式 ----------
    await freshParagraph();
    await page.keyboard.type('加粗字');
    await page.keyboard.press('Shift+Home');
    await tool('加粗').click();
    await page.waitForTimeout(200);
    check('3 加粗', (await surface.locator('strong').count()) >= 1);

    await freshParagraph();
    await page.keyboard.type('斜体字');
    await page.keyboard.press('Shift+Home');
    await tool('斜体').click();
    await page.waitForTimeout(200);
    check('3 斜体', (await surface.locator('em').count()) >= 1);

    await freshParagraph();
    await page.keyboard.type('删除线字');
    await page.keyboard.press('Shift+Home');
    await tool('删除线').click();
    await page.waitForTimeout(200);
    check('3 删除线', (await surface.locator('s, del').count()) >= 1);

    await freshParagraph();
    await page.keyboard.type('行内代码');
    await page.keyboard.press('Shift+Home');
    await tool('行内代码').click();
    await page.waitForTimeout(200);
    check('3 行内代码', (await surface.locator('code').count()) >= 1);

    // ---------- 4. 链接 ----------
    await freshParagraph();
    await page.keyboard.type('站内链接');
    await page.keyboard.press('Shift+Home');
    await tool('链接').click();
    await page.waitForTimeout(200);
    check('4 链接弹出地址输入框', await page.locator('.toolbar .pop-input').isVisible());
    await page.locator('.toolbar .pop-input').fill('https://example.com/doc');
    await page.locator('.toolbar .chip.is-primary').click();
    await page.waitForTimeout(300);
    const href = await surface.locator('a').first().getAttribute('href');
    check('4 链接写进了文档', href === 'https://example.com/doc', String(href));

    // ---------- 5. 列表 ----------
    await freshParagraph();
    await page.keyboard.type('无序项');
    await tool('无序列表').click();
    await page.waitForTimeout(250);
    check('5 无序列表', (await surface.locator('ul li').count()) >= 1);

    await freshParagraph();
    await page.keyboard.type('有序项');
    await tool('有序列表').click();
    await page.waitForTimeout(250);
    check('5 有序列表', (await surface.locator('ol li').count()) >= 1);

    await freshParagraph();
    await page.keyboard.type('待办项');
    await tool('任务清单').click();
    await page.waitForTimeout(250);
    check('5 任务清单', (await surface.locator('li[data-item-type="task"]').count()) >= 1);

    // ---------- 6. 引用 / 代码块 / 分割线 ----------
    await freshParagraph();
    await page.keyboard.type('引用一句');
    await tool('引用').click();
    await page.waitForTimeout(250);
    check('6 引用', (await surface.locator('blockquote').count()) >= 1);

    await freshParagraph();
    await page.keyboard.type('code here');
    await tool('代码块').click();
    await page.waitForTimeout(250);
    check('6 代码块', (await surface.locator('pre code, pre').count()) >= 1);

    await freshParagraph();
    await tool('分割线').click();
    await page.waitForTimeout(250);
    check('6 分割线', (await surface.locator('hr').count()) >= 1);

    // ---------- 7. 表格 ----------
    await freshParagraph();
    await tool('表格').click();
    await page.waitForTimeout(400);
    // 点「表格」先弹 8×8 尺寸网格，选一格才插（默认高亮 3×3）
    await page.locator('.popover.is-grid .grid-cell').nth(2 * 8 + 2).click();
    await page.waitForTimeout(400);
    check('7 插入表格', (await surface.locator('table').count()) === 1);
    check('7 表格操作条自动出现', await page.locator('.toolbar .row.is-table').isVisible());
    await page.screenshot({ path: path.join(SHOTS, '02-table.png') });

    const rows0 = await surface.locator('table tr').count();
    const cols0 = await surface.locator('table tr:first-child th, table tr:first-child td').count();
    await page.locator('.toolbar .row.is-table .chip', { hasText: '下方加行' }).click();
    await page.waitForTimeout(300);
    const rows1 = await surface.locator('table tr').count();
    check('7 下方加行', rows1 === rows0 + 1, `${rows0} → ${rows1}`);

    await page.locator('.toolbar .row.is-table .chip', { hasText: '右侧加列' }).click();
    await page.waitForTimeout(300);
    const cols1 = await surface.locator('table tr:first-child th, table tr:first-child td').count();
    check('7 右侧加列', cols1 === cols0 + 1, `${cols0} → ${cols1}`);

    // 删行删列要先让光标落进某一格：整张表都被选中时，「删除本行」没有唯一答案
    // （prosemirror-tables 在这种情况下会直接拒绝 —— 那是它的正确行为，不是 bug）
    await surface.locator('table tr').nth(1).locator('td, th').first().click();
    await settle(250);
    check('7 点进单元格后表格操作条还在', await page.locator('.toolbar .row.is-table').isVisible());

    await page.locator('.toolbar .row.is-table .chip', { hasText: '删除本行' }).click();
    await page.waitForTimeout(300);
    check('7 删除本行', (await surface.locator('table tr').count()) === rows1 - 1, `${rows1} → ${await surface.locator('table tr').count()}`);

    await page.locator('.toolbar .row.is-table .chip', { hasText: '删除本列' }).click();
    await page.waitForTimeout(300);
    check(
      '7 删除本列',
      (await surface.locator('table tr:first-child th, table tr:first-child td').count()) === cols1 - 1,
      `${cols1} → ${await surface.locator('table tr:first-child th, table tr:first-child td').count()}`,
    );

    // 表头行删不掉：gfm 的表是 `table_header_row table_row+`，表头行是独立节点类型、
    // 而且必须存在。prosemirror-tables 的 deleteRow 不认识它，直接删会把表头清空、
    // 表格凭空多出一行（插入表格后光标就落在表头行，一插完就点「删除本行」必现）。
    await surface.locator('table tr').nth(0).locator('td, th').first().click();
    await page.waitForTimeout(250);
    const rowsBeforeHeaderDel = await surface.locator('table tr').count();
    await page.locator('.toolbar .row.is-table .chip', { hasText: '删除本行' }).click();
    await page.waitForTimeout(400);
    check(
      '7 光标在表头行时「删除本行」不动表格',
      (await surface.locator('table tr').count()) === rowsBeforeHeaderDel,
      `${rowsBeforeHeaderDel} → ${await surface.locator('table tr').count()}`,
    );
    check(
      '7 表头行删不掉时给出提示',
      await page.locator('.toast').isVisible(),
      (await page.locator('.toast').innerText().catch(() => '')).trim(),
    );

    await page.locator('.toolbar .row.is-table .chip', { hasText: '删除表格' }).click();
    await page.waitForTimeout(300);
    check('7 删除表格', (await surface.locator('table').count()) === 0);

    // ---------- 8. 思维导图（NodeView + 源码面板） ----------
    // 块自己就是那张图：正文里不该再出现源码，也不该有 <pre data-language="mermaid">。
    await freshParagraph();
    await tool('思维导图').click();
    await page.waitForTimeout(7000); // 首次要把 mermaid 本体动态拉下来
    check('8 插入后只看到图，看不到源码', (await surface.locator('pre[data-language]').count()) === 0);
    const svgCount = await surface.locator('.donote-mermaid svg').count();
    const boxText = (await surface.locator('.donote-mermaid').first().innerText()).trim();
    check('8 渲染出思维导图', svgCount === 1, svgCount ? 'svg 已生成' : `未生成，框内文字：${boxText}`);
    check('8 正文里没有源码文字', !(await surface.innerText()).includes('mindmap'));
    await page.screenshot({ path: path.join(SHOTS, '03-mermaid.png'), fullPage: true });

    // 点图 → 源码面板
    await surface.locator('.donote-mermaid').first().click();
    await page.waitForTimeout(500);
    const panel = page.locator('.panel[aria-label="编辑思维导图"]');
    const panelSource = page.locator('.source[aria-label="Mermaid 源码"]');
    check('8 点图弹出源码面板', await panel.isVisible());
    check('8 面板里能看到预填模板', (await panelSource.inputValue()).includes('mindmap'));

    // 面板里改源码 → 实时预览跟着变
    const edited = 'mindmap\n  root((改过的中心))\n    甲\n    乙';
    await panelSource.fill(edited);
    await page.waitForTimeout(1600);
    const previewText = await page.locator('.preview-svg').innerText().catch(() => '');
    check('8 面板里的预览实时更新', previewText.includes('改过的中心'), previewText.replace(/\n+/g, ' ').slice(0, 40));

    // 关闭（完成）→ 块内容更新
    await page.locator('.foot button.major').click();
    await page.waitForTimeout(2200);
    check('8 关闭后面板收起', !(await panel.isVisible().catch(() => false)));
    const afterText = (await surface.locator('.donote-mermaid').first().innerText()).trim();
    check('8 关闭后块内容已更新', afterText.includes('改过的中心'), afterText.replace(/\n+/g, ' ').slice(0, 40));

    // ---------- 9. 悬浮工具栏 ----------
    await freshParagraph();
    await page.keyboard.type('选中这段字看看浮条');
    await page.keyboard.press('Shift+Home');
    await page.waitForTimeout(400);
    const floatVisible = await page.locator('.float-bar').isVisible().catch(() => false);
    check('9 选中文字浮出小工具条', floatVisible);
    if (floatVisible) {
      await page.screenshot({ path: path.join(SHOTS, '04-floating.png') });
      await page.locator('.float-bar button[aria-label="加粗"]').click();
      await page.waitForTimeout(300);
      check('9 浮条上的加粗可用', (await surface.locator('strong').count()) >= 2);
    }

    // ---------- 10. 状态高亮 ----------
    // 前面插过代码块，文末就落在围栏里 —— 在代码块里按回车只换行、加粗也不生效，
    // 直接敲字会全被吸进代码块。用 freshParagraph 先退出来再开新段落。
    await freshParagraph();
    await page.keyboard.type('高亮检查');
    await page.keyboard.press('Shift+Home');
    await tool('加粗').click();
    await page.waitForTimeout(400);
    const pressed = await tool('加粗').getAttribute('aria-pressed');
    check('10 光标处已加粗时按钮高亮', pressed === 'true', `aria-pressed=${pressed}`);

    // ---------- 11. 落盘 ----------
    await page.waitForFunction(
      () => document.querySelector('.status')?.textContent?.includes('已保存'),
      undefined,
      { timeout: 25000 },
    );
    await page.waitForTimeout(1200);
    const raw = await davText(`${TITLE}.md`);
    check('11 磁盘上拿得到笔记', !!raw);
    check('11 标题写成 # ', !!raw && /^# 一级标题$/m.test(raw));
    check('11 加粗写成 **', !!raw && raw.includes('**加粗字**'));
    check('11 斜体写成 *', !!raw && /\*斜体字\*/.test(raw));
    check('11 删除线写成 ~~', !!raw && raw.includes('~~删除线字~~'));
    check('11 行内代码写成反引号', !!raw && raw.includes('`行内代码`'));
    check('11 链接写成 [文字](地址)', !!raw && raw.includes('[站内链接](https://example.com/doc)'));
    check('11 无序列表写成 - 或 *', !!raw && /^[-*] 无序项$/m.test(raw));
    check('11 有序列表写成 1.', !!raw && /^1\. 有序项$/m.test(raw));
    check('11 任务项写成 [ ]', !!raw && /^[-*] \[ \] 待办项$/m.test(raw));
    check('11 引用写成 >', !!raw && /^> 引用一句$/m.test(raw));
    check('11 代码块写成围栏', !!raw && raw.includes('```'));
    check('11 分割线写成 ---', !!raw && /^---$/m.test(raw));
    check('11 思维导图写成 ```mermaid', !!raw && /^```mermaid$/m.test(raw));

    check('12 全程没有意外的 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
    console.log('\n--- 落盘 Markdown ---\n' + (raw || '') + '\n--- /落盘 ---');
  } finally {
    try {
      await ctx.request.fetch(`${DAV}/${TITLE}.md`, {
        method: 'DELETE',
        headers: { Authorization: auth },
        failOnStatusCode: false,
      });
      console.log(`清理：已删除 DoNote/${TITLE}.md`);
    } catch {
      /* 清理失败不影响结论 */
    }
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'stage4-toolbar.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
