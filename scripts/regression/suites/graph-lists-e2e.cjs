/**
 * 列表与图（mindmap / flowchart）的行为验收 —— 12 项。
 *
 * 这几条都是用户真的报过的问题，单看 DOM 变化看不出来，必须量结构或量尺寸：
 *
 *   列表 1 逐段加两次 → **一张**列表（两个 ol 会各自从 1 开始编号）
 *       2 选中多段一次加 → 合成一张，条目数对得上
 *       3 首条按 Tab → 吃掉按键，焦点还在编辑器里（原来会跑到工具栏 / 块手柄上）
 *       4 第二条按 Tab → 降一级；Shift+Tab 升回来
 *       5 选中两条再点列表按钮 → 这两条变回段落，没选中的留在列表里
 *   流程图 6 有回路的图（`K -- 否 --> D`）不再把节点排到 x≈12600，画布不会一万像素宽
 *         7 最长的连线不超过一屏；TD 图竖着排
 *         8 已经被旧版写死了一万多像素 @pos 的笔记，打开时重新排队
 *   导图  9 节点底色 ≥ 3 种（按分支取色相、按深度取明度）
 *        10 中心节点与一级分支不同色，且中心是深底浅字
 *        11 渲染无报错
 *
 * 用法：BASE=http://localhost:5173 node graph-lists-e2e.cjs
 */
const { chromium } = require('playwright-core');
const H = require('../harness/davmode.cjs');
const { connect, openPage } = require('../harness/nav.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5173';
const SHOTS = path.join(H.ART, 'shots-graph-lists');

const STAMP = Date.now().toString(36).slice(-6);
const LIST_NOTE = `列表${STAMP}`;
const CHART_NOTE = `回路${STAMP}`;
const BROKEN_NOTE = `坏坐标${STAMP}`;

const LIST_BODY = ['甲段', '', '乙段', '', '丙段', '', '丁段'].join('\n');

// 就是 Pre_文献导读 里那张：`K -- 否 --> D` 是一条回路
const CHART_BODY = [
  '正文。',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[决定收集证据] --> B[分配资源]',
  '  B --> C[内容分析]',
  '  C --> D[编写题目]',
  '  D --> E[题目审查 1]',
  '  E --> F[规划评分]',
  '  F --> G[制作试测卷]',
  '  G --> H[试测]',
  '  H --> I[题目审查 2]',
  '  I --> J[修订]',
  '  J --> K{题目够不够}',
  '  K -- 否 --> D',
  '  K -- 是 --> L[组装最终卷]',
  '```',
  '',
  '```mermaid',
  'mindmap',
  '  root((中心主题))',
  '    效率',
  '      时间成本',
  '    体验',
  '      上手难度',
  '    质量',
  '      一致性',
  '```',
].join('\n');

// 旧版在有回路的图上算出来的坐标（一万多像素）
const BROKEN_BODY = [
  '正文。',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[甲] --> B[乙]',
  '  B --> C[丙]',
  '  C --> A',
  '',
  '%% @pos A 12430 40',
  '%% @pos B 12640 40',
  '%% @pos C 12850 132',
  '```',
].join('\n');

const encodeId = (rel) => Buffer.from(rel, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

/** 顶层块的结构：ol(甲段,乙段) / p:丙段 */
const shape = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.ProseMirror');
    return [...root.children].map((el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'ol' || tag === 'ul') {
        const items = [...el.children]
          .filter((item) => item.tagName === 'LI')
          .map((li) => li.textContent.trim().slice(0, 4));
        return `${tag}(${items.join(',')})`;
      }
      return `${tag}:${el.textContent.trim().slice(0, 4)}`;
    });
  });

const focusIn = (page) => page.evaluate(() => (document.activeElement?.className || '') + '|' + document.activeElement?.tagName);

/** 流程图画布上的几何量：节点外接尺寸、最长一条连线的包围盒 */
const geom = (page) =>
  page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.flow .node')];
    const rects = nodes.map((el) => {
      const left = parseFloat(el.style.left || '0');
      const top = parseFloat(el.style.top || '0');
      return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
    });
    const edges = [...document.querySelectorAll('.flow .edge')].map((el) => {
      const box = el.getBBox();
      return Math.max(box.width, box.height);
    });
    return {
      count: nodes.length,
      width: Math.round(Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left))),
      height: Math.round(Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top))),
      longestEdge: Math.round(Math.max(0, ...edges)),
    };
  });

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  try {
    await H.attach(page, ctx);
    H.mock.putNote(LIST_NOTE, LIST_BODY);
    H.mock.putNote(CHART_NOTE, CHART_BODY);
    H.mock.putNote(BROKEN_NOTE, BROKEN_BODY);
    await connect(page, { base: BASE, server: H.SERVER, account: H.ACCOUNT, password: H.appPassword() });

    /* ───────────────── 列表 ───────────────── */
    await openPage(page, `${BASE}/notes/${encodeId(`${LIST_NOTE}.md`)}`, '.donote-surface .ProseMirror');
    await page.waitForTimeout(1200);
    const ordered = page.locator('.toolbar button[aria-label="有序列表"]');

    for (const text of ['甲段', '乙段']) {
      await page.locator('.ProseMirror p, .ProseMirror li', { hasText: text }).first().click();
      await page.waitForTimeout(200);
      await ordered.click();
      await page.waitForTimeout(350);
    }
    let blocks = await shape(page);
    check('列表 1 逐段加两次 → 合成一张列表', blocks.filter((b) => b.startsWith('ol')).length === 1, JSON.stringify(blocks));
    check('列表 1 两条都在同一张表里', blocks[0]?.startsWith('ol(甲段,乙段'), JSON.stringify(blocks));

    await page.locator('.ProseMirror p', { hasText: '丙段' }).click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(250);
    await ordered.click();
    await page.waitForTimeout(500);
    blocks = await shape(page);
    const items = await page.locator('.ProseMirror > ol > li').count();
    check('列表 2 选中两段一次加 → 还是同一张表', blocks.filter((b) => b.startsWith('ol')).length === 1, JSON.stringify(blocks));
    check('列表 2 四个条目同表', items === 4, `${items} 条`);

    await page.locator('.ProseMirror li').first().click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(350);
    const focusAfterTab = await focusIn(page);
    const depthAfterTab = await page.locator('.ProseMirror > ol > li').count();
    check('列表 3 首条按 Tab 焦点还在编辑器里', focusAfterTab.includes('ProseMirror'), focusAfterTab);
    check('列表 3 首条按 Tab 结构不变', depthAfterTab === 4, `${depthAfterTab} 条`);

    await page.locator('.ProseMirror li').nth(1).click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    let nested = await page.locator('.ProseMirror > ol > li > ol').count();
    check('列表 4 第二条按 Tab 能降一级', nested === 1, `${nested} 个子列表`);
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(400);
    nested = await page.locator('.ProseMirror > ol > li > ol').count();
    check('列表 4 Shift+Tab 升回一级', nested === 0, `${nested} 个子列表`);

    await page.locator('.ProseMirror li').first().click();
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(250);
    await ordered.click();
    await page.waitForTimeout(500);
    blocks = await shape(page);
    check(
      '列表 5 选中的两条变回段落，其余留在列表里',
      blocks.filter((b) => b.startsWith('p:')).length >= 2 && blocks.some((b) => b.startsWith('ol(')),
      JSON.stringify(blocks),
    );

    /* ───────────────── 流程图 ───────────────── */
    await openPage(page, `${BASE}/notes/${encodeId(`${CHART_NOTE}.md`)}`, '.donote-surface .ProseMirror');
    await page.waitForTimeout(1800);
    await page.locator('.donote-mermaid').filter({ hasText: '决定收集证据' }).first().click();
    await page.waitForTimeout(1400);
    const flowPanel = page.locator('[role="dialog"][aria-label="编辑流程图"]');
    check('流程图 6 默认进可视化', (await flowPanel.locator('.flow').count()) === 1);

    let box = await geom(page);
    check('流程图 6 十二个节点都在', box.count === 12, `${box.count} 个`);
    check('流程图 6 画布没有一万像素宽', box.width < 3000, `宽 ${box.width}px 高 ${box.height}px`);
    check('流程图 7 最长的连线不超过一屏', box.longestEdge < 1200, `最长 ${box.longestEdge}px`);
    check('流程图 7 TD 图竖着排', box.height > box.width, `${box.width}×${box.height}`);
    await page.screenshot({ path: path.join(SHOTS, 'flow-td.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await openPage(page, `${BASE}/notes/${encodeId(`${BROKEN_NOTE}.md`)}`, '.donote-surface .ProseMirror');
    await page.waitForTimeout(1600);
    await page.locator('.donote-mermaid').first().click();
    await page.waitForTimeout(1200);
    box = await geom(page);
    check('流程图 8 旧版写死的坏坐标被丢掉、重新排队', box.width < 3000, `宽 ${box.width}px`);
    check('流程图 8 节点数没变', box.count === 3, `${box.count} 个`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    /* ───────────────── 导图配色 ───────────────── */
    await openPage(page, `${BASE}/notes/${encodeId(`${CHART_NOTE}.md`)}`, '.donote-surface .ProseMirror');
    await page.waitForTimeout(1800);
    const mapBlock = page.locator('.donote-mermaid').filter({ hasText: '效率' }).first();
    const tones = await mapBlock.evaluate((el) => {
      const nodes = [...el.querySelectorAll('.mindmap-node')];
      const fillOf = (node) => {
        const shape = node.querySelector('path, rect, circle, polygon');
        return shape ? getComputedStyle(shape).fill : '';
      };
      const textOf = (node) => {
        const label = node.querySelector('span, text');
        return label ? getComputedStyle(label).color || getComputedStyle(label).fill : '';
      };
      return nodes.map((node) => ({ fill: fillOf(node), text: textOf(node) }));
    });
    const fills = tones.map((t) => t.fill);
    check('导图 9 节点底色 ≥ 3 种', new Set(fills).size >= 3, [...new Set(fills)].join(' / '));
    check('导图 10 中心与一级分支不同色', fills[0] !== fills[1], `${fills[0]} vs ${fills[1]}`);
    check('导图 10 中心是深底浅字', /^rgb\(4[0-9], 6[0-9], 9[0-9]\)$|^rgb\(3[0-9], 5[0-9], 8[0-9]\)$/.test(fills[0] ?? '') && (tones[0]?.text ?? '').includes('255'));
    await mapBlock.scrollIntoViewIfNeeded();
    await mapBlock.screenshot({ path: path.join(SHOTS, 'mindmap-light.png') });

    check('渲染无报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' / '));
  } finally {
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'graph-lists-e2e.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
