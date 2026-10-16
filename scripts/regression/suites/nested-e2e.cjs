/**
 * 批次 6 验收：笔记嵌套（index.md 页面模型）+ 笔记间导航（[[…]] + 反链）。
 *
 * 默认走同源假 DAV；USE_REAL_DAV=1 才连真坚果云。断言逻辑两边完全一致。
 *
 * 两条主线，共 18 项：
 *   嵌套 1  顶层页面 → 侧栏 📄        2  新建子页面 → 侧栏出现层级
 *        3  父页面 → 正文 + 子项列表   4  点子项 → 进入
 *        5  面包屑层级且可跳转          6  拖 .md 到详情页 → 生成子页面
 *        7  拖 .md 到列表页 → 同级笔记  8  删父页面 → 整棵进 .trash
 *        9  恢复父页面 → 整棵回来       10 普通笔记（无 index.md）行为不变
 *   导航 1  输入 `[[` 触发补全          2  选中候选 → 插入链接
 *        3  点链接 → 跳到目标           4  目标不存在 → 红色 + 点一下建出来
 *        5  详情页底部显示反向链接      6  改名 → 引用它的笔记里链接跟着改
 *        7  搜索结果显示层级路径        8  删除被引用的笔记 → 链接变红
 *
 * 用法：BASE=http://localhost:5173 node nested-e2e.cjs
 */
const { chromium } = require('playwright-core');
const H = require('../harness/davmode.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5176';
const SHOTS = path.join(H.ART, 'shots-nested');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const PARENT = `N1${STAMP}`; // 顶层页面（父笔记）
const CHILD = `C1${STAMP}`; // 父页面下的子页面
const TARGET = `T1${STAMP}`; // 被 [[…]] 指向的目标笔记
const TARGET2 = `${TARGET}改`; // 改名之后
const GHOST = `G1${STAMP}`; // 不存在的目标（点一下建出来）
const DROP_D = `D1${STAMP}`; // 拖到详情页
const DROP_L = `D2${STAMP}`; // 拖到列表页
const PLAIN = `P1${STAMP}`; // 普通笔记：行为不变

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
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location && m.location().url) || '';
    let decoded = url;
    try {
      decoded = decodeURIComponent(url);
    } catch {
      /* 保留原样 */
    }
    // 预期噪音：WebDAV 用 404 回答「不存在」。除了 .md / .assets，
    // 还有「目录探活」—— 恢复文件夹前会 stat 一下原位置，那一下必然是 404。
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
  /** Depth:1 列出目录里的名字（只看最后一段） */
  async function davNames(dir) {
    const res = await ctx.request.fetch(`${DAV}/${encodeURI(dir)}`, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '1' },
      data: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
      failOnStatusCode: false,
    });
    if (!res.ok()) return [];
    const xml = await res.text();
    return [...xml.matchAll(/href>([^<]+)<\/[^>]*href>/gi)]
      .map((m) => {
        try {
          return decodeURIComponent(m[1]);
        } catch {
          return m[1];
        }
      })
      .map((h) => h.replace(/\/$/, '').split('/').pop())
      .filter((n) => n && n !== dir);
  }

  /* ------------------------------ 页面小工具 ------------------------------ */

  const surface = page.locator('.donote-surface .ProseMirror');

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

  /** 标题即文件名：填完要等它改名落盘（页面改名 = 移动整个目录） */
  async function renameTo(name) {
    await page.locator('input.title-input').fill(name);
    await settled();
    await page.waitForTimeout(600);
  }

  async function noteIdFromUrl() {
    return page.url().split('/notes/')[1] || '';
  }

  /** 侧栏里某一行的元素（按可见文字找） */
  function treeRow(text) {
    return page.locator('.tree-row').filter({ hasText: text }).first();
  }

  async function openNoteByTitle(title) {
    await treeRow(title).locator('a.tree-link').first().click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(600);
  }

  /** 模拟拖一个 .md 到窗口里（DropOverlay 听的是 window 上的 HTML5 拖放） */
  async function dropMarkdown(name, text) {
    await page.evaluate(
      async ({ fileName, body }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([body], fileName, { type: 'text/markdown' }));
        window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        window.dispatchEvent(
          new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
        );
      },
      { fileName: name, body: text },
    );
  }

  /** 等某个 DAV 路径出现（拖放是异步的，没有可直接观察的 DOM 信号） */
  async function waitForDav(rel, timeout = 20000) {
    const until = Date.now() + timeout;
    for (;;) {
      if ((await davText(rel)) !== null) return true;
      if (Date.now() > until) return false;
      await page.waitForTimeout(400);
    }
  }

  /** 等某篇的正文里出现一段文字（改名后改写引用是异步的，要等它落盘） */
  async function waitForBody(rel, snippet, timeout = 20000) {
    const until = Date.now() + timeout;
    for (;;) {
      const raw = await davText(rel);
      if (raw !== null && raw.includes(snippet)) return true;
      if (Date.now() > until) return false;
      await page.waitForTimeout(400);
    }
  }

  /**
   * 等正文里那条链接变成想要的样式。
   * `cls` 传空串 = 只等它被认出来是条链接；以 `!` 开头 = 等它**不带**这个类。
   *
   * 三件事都是异步的，不能读一次就下结论：装饰由文档变化触发、颜色由 titleIndex 决定、
   * 而索引与反链是拉来的。所以一律轮询到条件成立或超时。
   */
  async function waitForLink(name, cls = '', timeout = 15000) {
    return page
      .waitForFunction(
        ({ n, c }) => {
          const spans = Array.from(document.querySelectorAll('.donote-surface .donote-wikilink'));
          const hit = spans.find((el) => el.textContent.includes(n));
          if (!hit) return false;
          if (!c) return true;
          return c.startsWith('!') ? !hit.className.includes(c.slice(1)) : hit.className.includes(c);
        },
        { n: name, c: cls },
        { timeout },
      )
      .then(() => true)
      .catch(() => false);
  }

  /** 等反向链接区块里出现某个名字 */
  async function waitForBacklink(name, timeout = 20000) {
    return page
      .waitForFunction(
        (n) => {
          const sections = Array.from(document.querySelectorAll('section.children'));
          const box = sections.find((el) => el.textContent.includes('被以下笔记提到'));
          return !!box && box.textContent.includes(n);
        },
        name,
        { timeout },
      )
      .then(() => true)
      .catch(() => false);
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

    // ---------- 嵌套 1：新建顶层页面 → 侧栏 📄 ----------
    // 右键侧栏的**空白处**（树本身，不是某一行）→「新建页面」= 根目录下的一个页面
    const treeBox = await page.locator('.tree').boundingBox();
    await page.mouse.click(treeBox.x + 24, treeBox.y + treeBox.height - 24, { button: 'right' });
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '新建页面' }).first().click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await renameTo(PARENT);
    await page.waitForTimeout(800);

    check(
      '嵌套 1 新建顶层页面 → 侧栏出现 📄 节点',
      (await treeRow(PARENT).locator('.tree-label').innerText().catch(() => '')) .includes(`📄 ${PARENT}`),
    );
    check('嵌套 1 落盘成 目录/index.md', (await davText(`${PARENT}/index.md`)) !== null);

    // ---------- 嵌套 2：详情页新建子页面 → 侧栏层级 ----------
    await page.getByRole('button', { name: '新建子页面', exact: true }).click();
    await page.waitForURL((u) => /\/notes\//.test(u.pathname), { timeout: 20000 });
    await page.waitForTimeout(1200);
    await renameTo(CHILD);
    await page.waitForTimeout(800);

    // 子行在侧栏里要缩进得比父行深
    if ((await treeRow(CHILD).count()) === 0) {
      await treeRow(PARENT).locator('.twist').first().click();
      await page.waitForTimeout(400);
    }
    const parentPad = await treeRow(PARENT).evaluate((el) => el.style.paddingLeft);
    const childPad = await treeRow(CHILD).evaluate((el) => el.style.paddingLeft);
    check(
      '嵌套 2 新建子页面 → 侧栏出现层级（子行缩进更深）',
      parseInt(childPad || '0', 10) > parseInt(parentPad || '0', 10),
      `父 ${parentPad} / 子 ${childPad}`,
    );
    check('嵌套 2 子页面落盘成 父目录/子目录/index.md', (await davText(`${PARENT}/${CHILD}/index.md`)) !== null);
    await page.screenshot({ path: path.join(SHOTS, '01-sidebar-tree.png') });

    // ---------- 嵌套 3：点父页面 → 正文 + 子项列表 ----------
    await openNoteByTitle(PARENT);
    check('嵌套 3 打开父页面，正文编辑器在', await surface.isVisible());
    const childCard = page.locator('.children-list .child-card').filter({ hasText: CHILD });
    check('嵌套 3 正文下方列出子项', (await childCard.count()) > 0);
    await page.screenshot({ path: path.join(SHOTS, '02-parent-page.png') });

    // ---------- 嵌套 4：点子项 → 进入 ----------
    await childCard.first().click();
    await page.waitForTimeout(1200);
    check(
      '嵌套 4 点子项进入子页面',
      (await page.locator('input.title-input').inputValue()) === CHILD,
      page.url().split('/notes/')[1] || '',
    );

    // ---------- 嵌套 5：面包屑层级且可跳转 ----------
    const crumbs = page.locator('.crumbs .crumb');
    const crumbCount = await crumbs.count();
    const crumbTexts = [];
    for (let i = 0; i < crumbCount; i += 1) crumbTexts.push((await crumbs.nth(i).innerText()).trim());
    check(
      '嵌套 5 面包屑显示层级（父 / 当前）',
      crumbCount === 2 && crumbTexts[0] === PARENT && crumbTexts[1] === CHILD,
      crumbTexts.join(' / '),
    );
    await crumbs.first().click();
    await page.waitForTimeout(1200);
    check(
      '嵌套 5 面包屑可跳转回父页面',
      (await page.locator('input.title-input').inputValue()) === PARENT,
      page.url(),
    );

    // ---------- 嵌套 6：拖 .md 到详情页 → 子页面 ----------
    await dropMarkdown(`${DROP_D}.md`, `# ${DROP_D}\n\n拖进父页面的正文`);
    check('嵌套 6 拖 .md 到详情页 → 生成 父目录/新名/index.md', await waitForDav(`${PARENT}/${DROP_D}/index.md`));

    // ---------- 嵌套 7：拖 .md 到列表页 → 同级笔记 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await dropMarkdown(`${DROP_L}.md`, `# ${DROP_L}\n\n拖到列表页`);
    check('嵌套 7 拖 .md 到列表页 → 生成同级 .md', await waitForDav(`${DROP_L}.md`));

    // ---------- 嵌套 10：普通笔记行为不变 ----------
    await page.locator('.rail button.new').click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await renameTo(PLAIN);
    await page.waitForTimeout(600);
    const plainFile = await davText(`${PLAIN}.md`);
    check('嵌套 10 普通笔记仍存成裸 .md', plainFile !== null);
    check('嵌套 10 普通笔记没有被变成目录', (await davText(`${PLAIN}/index.md`)) === null);
    check('嵌套 10 仍然是一篇能编辑的笔记', await surface.isVisible());

    // ---------- 导航：先备一篇被链接的目标笔记 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.locator('.rail button.new').click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await renameTo(TARGET);
    await page.waitForTimeout(600);

    // ---------- 导航 1：输入 [[ 触发补全 ----------
    await openNoteByTitle(PARENT);
    await surface.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('[[');
    await page.waitForTimeout(600);
    const menu = page.locator('.wikilink-menu');
    const menuVisible = await menu.isVisible().catch(() => false);
    check('导航 1 输入 [[ 弹出笔记补全菜单', menuVisible, menuVisible ? '' : '菜单没出现');
    await page.screenshot({ path: path.join(SHOTS, '03-wikilink-menu.png') });

    await page.keyboard.type(TARGET);
    await page.waitForTimeout(500);
    const menuItems = await page.locator('.wikilink-menu .wikilink-item').allInnerTexts();
    check(
      '导航 1 候选里按名字模糊匹配到目标笔记',
      menuItems.some((t) => t.includes(TARGET)),
      menuItems.slice(0, 3).join(' | '),
    );

    // ---------- 导航 2：选中候选 → 插入链接 ----------
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    check(
      '导航 2 选中候选 → 正文里插入 [[目标名]]',
      (await surface.innerText()).includes(`[[${TARGET}]]`),
    );
    await settled();

    // ---------- 导航 3：点链接 → 跳到目标 ----------
    const link = surface.locator('.donote-wikilink').filter({ hasText: TARGET });
    const resolved = await waitForLink(TARGET);
    const resolvedClass = (await link.count()) ? await link.first().getAttribute('class') : '';
    check(
      '导航 2 已解析的链接渲染成可点样式（不是红色缺失）',
      resolved && !resolvedClass.includes('is-missing'),
      resolvedClass || '没等到链接装饰',
    );
    await link.first().click();
    await page.waitForTimeout(1500);
    const jumped = (await page.locator('input.title-input').inputValue()) === TARGET;
    check('导航 3 点链接 → 跳到目标笔记', jumped, page.url().split('/notes/')[1] || '');
    await page.screenshot({ path: path.join(SHOTS, '04-jump.png') });

    // ---------- 导航 5：反向链接 ----------
    const backSection = page.locator('section.children').filter({ hasText: '被以下笔记提到' });
    const hasBacklink = await waitForBacklink(PARENT);
    const backText = (await backSection.first().count()) ? await backSection.first().innerText() : '';
    check(
      '导航 5 目标详情页底部列出反向链接',
      hasBacklink && backText.includes(PARENT),
      backText.replace(/\s+/g, ' ').slice(0, 90),
    );

    // ---------- 导航 6：改名 → 引用自动更新 ----------
    await renameTo(TARGET2);
    await page.waitForTimeout(800);
    const rewritten = await waitForBody(`${PARENT}/index.md`, `[[${TARGET2}]]`);
    await openNoteByTitle(PARENT);
    const afterRename = await surface.innerText();
    check(
      '导航 6 改名后，引用它的笔记里链接跟着改成新名字',
      rewritten && afterRename.includes(`[[${TARGET2}]]`) && !afterRename.includes(`[[${TARGET}]]`),
      rewritten ? '' : '引用它的笔记没有在超时内改成新名字',
    );

    // ---------- 导航 9：落盘 → 重开，链接仍然认得出来 ----------
    // 🔴 序列化器怕 `[` 被当成链接起头，会把开头的方括号转义成 `\[\[` 写进文件。
    // 链接本身读回来还是 `[[…]]`，但**正文级的扫描器**（反链、改名改写）看的是磁盘原文 ——
    // 这条专门盯住「转义之后两边都还认」，这两处曾经一起栽在这里。
    await page.reload({ waitUntil: 'networkidle' });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    const survived = await waitForLink(TARGET2, '!is-missing');
    check(
      '导航 9 落盘再重开，[[…]] 仍被认出来（没被转义成普通文字）',
      survived,
      survived ? '' : '重开后认不出这条链接',
    );

    // ---------- 导航 4：目标不存在 → 红色 + 点一下建出来 ----------
    await surface.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    // 整段敲完（敲到 `]` 时补全菜单自己就关了），落成一条指向不存在笔记的链接
    await page.keyboard.type(`[[${GHOST}]]`);
    const ghostMissing = await waitForLink(GHOST, 'is-missing');
    const ghost = surface.locator('.donote-wikilink').filter({ hasText: GHOST });
    check('导航 4 指向不存在笔记的链接渲染成红色（is-missing）', ghostMissing, ghostMissing ? '' : '等不到 is-missing');
    await page.screenshot({ path: path.join(SHOTS, '05-missing-link.png') });

    await ghost.first().click();
    await page.waitForTimeout(2000);
    check(
      '导航 4 点红色链接 → 把目标建出来并跳过去',
      (await page.locator('input.title-input').inputValue()) === GHOST &&
        // 落点 = 当前笔记所在的目录（这里是父页面自己的目录），不是根
        (await davText(`${PARENT}/${GHOST}.md`)) !== null,
      page.url().split('/notes/')[1] || '',
    );

    // ---------- 导航 7：搜索显示层级路径 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.getByPlaceholder('搜索标题或正文').fill(CHILD);
    await page.waitForTimeout(1600);
    const card = page.locator('.card').filter({ hasText: CHILD }).first();
    const folderChip = (await card.count()) ? await card.locator('.folder').innerText() : '';
    check('导航 7 搜索结果里显示层级路径', folderChip.includes(PARENT), folderChip.trim());
    await page.screenshot({ path: path.join(SHOTS, '06-search-path.png') });

    // ---------- 导航 8：删除被引用的笔记 → 链接变红 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await openNoteByTitle(TARGET2);
    await page.locator('.more').click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '移入回收站' }).click();
    await page.waitForTimeout(2200);
    await openNoteByTitle(PARENT);
    const danglingOk = await waitForLink(TARGET2, 'is-missing');
    check(
      '导航 8 删除被引用的笔记 → 原来的链接变红',
      danglingOk,
      danglingOk ? '' : '等不到 is-missing',
    );

    // ---------- 嵌套 8：删父页面 → 整棵进 .trash ----------
    const before = await davNames('.trash');
    await openNoteByTitle(PARENT);
    await page.locator('.more').click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '移入回收站' }).click();
    await page.waitForTimeout(2400);
    const after = await davNames('.trash');
    const newEntry = after.find((n) => !before.includes(n) && n.includes(PARENT));
    check('嵌套 8 删除父页面 → 整棵目录离开原位', (await davText(`${PARENT}/index.md`)) === null);
    check('嵌套 8 父页面整棵进了 .trash', !!newEntry, newEntry || after.slice(0, 4).join(' | '));

    // ---------- 嵌套 9：恢复父页面 → 整棵回来 ----------
    await page.goto(BASE + '/trash', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const node = page.locator('.node').filter({ hasText: PARENT }).first();
    await node.getByRole('button', { name: '恢复' }).first().click();
    await page.waitForTimeout(2600);
    check('嵌套 9 恢复父页面 → 父页面回来', (await davText(`${PARENT}/index.md`)) !== null);
    check('嵌套 9 子页面跟着整棵回来', (await davText(`${PARENT}/${CHILD}/index.md`)) !== null);
    check('嵌套 9 拖进来的子页面也跟着回来', (await davText(`${PARENT}/${DROP_D}/index.md`)) !== null);

    // ---------- 收尾 ----------
    check('全程没有意外的 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));

    // 清掉本次造的数据（真机模式下不留垃圾）
    await davDelete(PARENT);
    await davDelete(GHOST);
    await davDelete(DROP_L);
    await davDelete(PLAIN);
    await davDelete(TARGET);
    await davDelete(TARGET2);
    if (newEntry) await davDelete(`.trash/${newEntry}`);
    console.log('\n清理：已删除本次造出的笔记 / 目录');
  } finally {
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'nested-e2e.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(2);
});
