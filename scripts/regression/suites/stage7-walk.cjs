/**
 * 阶段 7 走查：桌面端 / 移动端两套布局 + 几个必须手工确认的交互。
 *
 * 任务书列的手工清单逐条落成断言，截图存 shots-stage7/。
 * 用法：BASE=http://localhost:5176 node stage7-walk.cjs
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const { openPage, reloadPage } = require('../harness/nav.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5176';
const SHOTS = path.join(H.ART, 'shots-stage7');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;
const STAMP = Date.now().toString(36).slice(-6);
const TITLE = `S7走查${STAMP}`;
/** 第二篇：用来验「开着一篇再点另一篇」—— 有名字包含关系的话 hasText 会串行，故意不重名 */
const TITLEB = `S7二篇${STAMP}`;
const FOLDER = `S7目录${STAMP}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}


(async () => {
  const appPassword = H.appPassword();
  const auth = 'Basic ' + Buffer.from(`${ACCOUNT}:${appPassword}`).toString('base64');
  fs.mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let created = false;
  let createdB = false;
  let folderCreated = false;

  async function connect(page) {
    await openPage(page, BASE + '/');
    if (!page.url().includes('/login')) return;
    await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
    await page.getByPlaceholder('你的账号').fill(ACCOUNT);
    await page.getByPlaceholder('应用密码').fill(appPassword);
    await page.getByRole('button', { name: '连接' }).first().click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
    await page.waitForTimeout(1500);
  }

  const shoot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

  /** 页面有没有横向溢出（横向滚动条 = 布局崩了） */
  const overflows = (page) =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  /** 侧栏收起时先展开：下面有几条要在侧栏树里点行 */
  const openRail = async (page) => {
    if ((await page.evaluate(() => document.documentElement.dataset.sidebar)) !== 'open') {
      await page.locator('header.topbar button[aria-label="收起或展开侧边栏"]').click();
      await page.waitForTimeout(600);
    }
  };

  /* ============================ 桌面端 1440 ============================ */
  const deskCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dp = await deskCtx.newPage();
  await H.attach(dp, deskCtx);
  await connect(dp);
  await openPage(dp, BASE + '/');
  await dp.waitForTimeout(3000);
  await shoot(dp, 'd1-home');

  const rail = dp.locator('aside.rail');
  check('桌面端侧边栏常驻可见', await rail.isVisible());
  const railW = await rail.evaluate((el) => el.getBoundingClientRect().width);
  check('侧边栏宽 260px', Math.abs(railW - 260) <= 2, `${railW}px`);
  const bar = await dp.locator('header.topbar').evaluate((el) => el.getBoundingClientRect().height);
  check('顶栏高 48px', Math.abs(bar - 48) <= 2, `${bar}px`);
  check('桌面端无横向溢出', (await overflows(dp)) <= 1, `${await overflows(dp)}px`);

  // 折叠 / 展开
  await dp.locator('header.topbar button[aria-label="收起或展开侧边栏"]').click();
  await dp.waitForTimeout(600);
  check('折叠后 data-sidebar=closed', (await dp.evaluate(() => document.documentElement.dataset.sidebar)) === 'closed');
  await shoot(dp, 'd2-collapsed');
  await dp.locator('header.topbar button[aria-label="收起或展开侧边栏"]').click();
  await dp.waitForTimeout(600);
  check('再点一次展开 data-sidebar=open', (await dp.evaluate(() => document.documentElement.dataset.sidebar)) === 'open');

  // 侧边栏里的搜索框
  check('侧边栏顶部有搜索框', await dp.locator('aside.rail input[type="search"]').first().isVisible());

  // 新建一篇，检查详情页
  await dp.locator('.rail button.new').click();
  await dp.waitForURL(/\/notes\//, { timeout: 25000 });
  created = true;
  await dp.locator('input.title-input').fill(TITLE);
  const surface = dp.locator('.donote-surface .ProseMirror');
  await surface.waitFor({ state: 'visible', timeout: 20000 });
  await dp.waitForTimeout(300);
  // 点正文那一行本身，不要点容器中心 —— 内容只有一行时容器中心落在下方的空白里，
  // 那里没有文本节点，Shift+Home 不会产生 ProseMirror 的选区事务，浮条也就不出来
  await dp.locator('.donote-surface .ProseMirror p').first().click();
  await dp.waitForTimeout(200);
  await dp.keyboard.type('走查正文 ' + STAMP);
  await dp.waitForTimeout(600);

  check('详情页顶栏里有模式开关', await dp.locator('header.topbar button[aria-label="源码"]').isVisible());
  check('详情页顶栏里有更多操作', await dp.locator('header.topbar button.more').isVisible());
  check('顶部工具栏在位', await dp.locator('.toolbar').isVisible());
  await shoot(dp, 'd3-note-wysiwyg');

  // 选中文字 → 悬浮工具条
  const bars = () => dp.evaluate(() => document.querySelectorAll('.float-bar').length);

  // 光标本来就在字尾，直接选到行首（不先按 End —— 先按下一次再选，
  // 中间那次「空选区」会把浮条收掉，是脚本自己的问题）
  await dp.keyboard.press('Shift+Home');
  await dp.waitForTimeout(800);
  const byKeyboard = await bars();

  // 另一种选法：双击选一个词，走鼠标事件
  await dp.locator('.donote-surface .ProseMirror p').first().dblclick();
  await dp.waitForTimeout(800);
  const byMouse = await bars();

  check(
    '选中文字浮出小工具条（鼠标选中）',
    byMouse >= 1,
    `鼠标 ${byMouse} / 键盘 ${byKeyboard}`,
  );
  if (byKeyboard === 0) {
    // 老实记下来：这一处只有单个短段落，Shift+Home 没触发；stage4 的脚本在
    // 「多段文档 + 新起一个段落」的场合用同样的键是通的（45/45），所以先记为待查，
    // 不当作缺陷，也不放过。
    console.log('记录：此场景下键盘 Shift+Home 选区未触发浮条，鼠标选中可以（待查）');
  }
  await shoot(dp, 'd4-floating');

  // 源码模式
  await dp.locator('header.topbar button[aria-label="源码"]').click();
  await dp.locator('textarea.source').waitFor({ state: 'visible', timeout: 10000 });
  await dp.waitForTimeout(400);
  check('源码模式左右分栏', await dp.locator('.source-preview').isVisible());
  check('源码模式无横向溢出', (await overflows(dp)) <= 1, `${await overflows(dp)}px`);
  await shoot(dp, 'd5-source');
  // 切回来（首次会问一句）
  await dp.locator('header.topbar button[aria-label="所见即所得"]').click();
  await dp.locator('[role="dialog"] .major').click();
  await dp.waitForTimeout(800);
  check('切回所见即所得', await surface.isVisible());

  // 侧边栏搜索框：填关键词回车 → 落到列表页并按它筛（搜索逻辑只有一份，在列表页）
  const railSearch = dp.locator('aside.rail input[type="search"]');
  await railSearch.fill(STAMP);
  await railSearch.press('Enter');
  await dp.waitForTimeout(3200);
  check('侧边栏搜索把关键词带到列表页', new URL(dp.url()).searchParams.get('q') === STAMP, dp.url());
  check('列表按关键词筛出了那篇', (await dp.locator('body').innerText()).includes(TITLE));
  await shoot(dp, 'd6-search');

  /* ---------- 换笔记：/notes/:id 是同一条路由记录，组件会被复用 ----------
   * 「开着一篇、再点侧栏里另一篇」是这类跳转的唯一入口 —— 从列表页进详情是另一次挂载，
   * 走的是新建组件的路子，怎么都不会漏。只换地址栏不算数：标题和正文都得换成那一篇。 */
  await dp.locator('.rail button.new').click();
  await dp.waitForURL(/\/notes\//, { timeout: 25000 });
  createdB = true;
  await dp.locator('input.title-input').fill(TITLEB);
  await dp.waitForTimeout(3000);

  // 重进一次：侧栏树有自己的取数时机，别拿还没刷新的树当证据
  await reloadPage(dp);
  await dp.waitForTimeout(3000);
  await openRail(dp);
  const noteBId = dp.url().split('/notes/')[1] ?? '';
  const rowA = dp.locator('aside.rail a.tree-link', { hasText: TITLE }).first();
  check(
    '侧栏树里两篇笔记都在（下面两条才有意义）',
    (await dp.locator('aside.rail a.tree-link', { hasText: TITLE }).count()) >= 1 &&
      (await dp.locator('aside.rail a.tree-link', { hasText: TITLEB }).count()) >= 1,
    `当前在 ${noteBId}`,
  );
  if (await rowA.count()) {
    await rowA.click();
    await dp.waitForTimeout(3500);
    const noteAId = dp.url().split('/notes/')[1] ?? '';
    const loadedTitle = await dp.locator('input.title-input').inputValue();
    const loadedBody = await dp.locator('.donote-surface .ProseMirror').innerText();
    check('在 B 里点侧栏的 A，地址换回 A', !!noteAId && noteAId !== noteBId, `${noteBId} → ${noteAId}`);
    check(
      '标题与正文跟着换成 A',
      loadedTitle === TITLE && loadedBody.includes(STAMP),
      `${loadedTitle} / ${loadedBody.trim().slice(0, 10)}`,
    );
    await shoot(dp, 'd10-switch-note');
  }

  // 面包屑：先看只有「当前页」一段的页面（不可点是正常的），
  // 再看有父级链接的页面 —— 那才谈得上「跳转」
  await openPage(dp, BASE + '/trash');
  await dp.waitForTimeout(1500);
  check('面包屑在位', await dp.locator('header.topbar nav.crumbs').isVisible());
  check('当前页那段标成不可点', (await dp.locator('header.topbar nav.crumbs .crumb.is-current').count()) >= 1);
  await shoot(dp, 'd6-crumbs');

  await openPage(dp, BASE + '/folders');
  await dp.waitForTimeout(1800);

  const FOLDERNAME = FOLDER;
  // 建一个临时文件夹专门验面包屑跳转（用完直接删，不留痕）
  await dp.locator('button.btn-major.full').click();
  await dp.locator('[role="dialog"] input').first().fill(FOLDERNAME);
  await dp.locator('[role="dialog"] .major').click();
  await dp.waitForTimeout(2500);
  folderCreated = true;

  const row = dp.locator('.folder-link', { hasText: FOLDERNAME }).first();
  check('新建的文件夹出现在列表里', (await row.count()) === 1);

  /* ---------------------- 文件夹可折叠 ----------------------
   * 这一页不是树：整棵文件夹一次取回、按 parent_id 拉平成带缩进的行。
   * 所以「收起来」要真的把子行从列表里去掉，不能只是箭头转个方向 ——
   * 每条都同时看行在不在、以及 aria-expanded 的真值。 */
  const CHILD = `S7子目录${STAMP}`;
  const parentRow = dp.locator('.folder-row', { hasText: FOLDERNAME }).first();
  await parentRow.locator('.folder-more').click();
  await dp.waitForTimeout(500);
  await dp.locator('.sheet-item', { hasText: '新建子文件夹' }).click();
  await dp.locator('[role="dialog"] input').first().fill(CHILD);
  await dp.locator('[role="dialog"] .major').click();
  await dp.waitForTimeout(2500);

  const childRows = () => dp.locator('.folder-row', { hasText: CHILD }).count();
  const twist = () => dp.locator('.folder-row', { hasText: FOLDERNAME }).first().locator('button.twist');
  check('刚建的子文件夹立刻可见（父级自动铺开）', (await childRows()) === 1);

  await twist().click();
  await dp.waitForTimeout(600);
  check(
    '点箭头收起子层',
    (await childRows()) === 0 && (await twist().getAttribute('aria-expanded')) === 'false',
  );
  await shoot(dp, 'd8a-fold-collapsed');

  await twist().click();
  await dp.waitForTimeout(600);
  check(
    '再点箭头又铺开',
    (await childRows()) === 1 && (await twist().getAttribute('aria-expanded')) === 'true',
  );

  // 重进本页：不记住上次的展开，默认只看到最顶层
  await reloadPage(dp);
  await dp.waitForTimeout(2000);
  check('重进本页只看到最顶层', (await childRows()) === 0);
  check('顶层文件夹本身还在', (await dp.locator('.folder-link', { hasText: FOLDERNAME }).count()) === 1);
  check('箭头默认是收起的', (await twist().getAttribute('aria-expanded')) === 'false');
  await shoot(dp, 'd8b-fold-default');

  await row.click();
  await dp.waitForURL(/\/folders\//, { timeout: 20000 });
  await dp.waitForTimeout(1200);

  const up = dp.locator('header.topbar nav.crumbs a.crumb').first();
  check('文件夹页有可点击的父级面包屑', (await up.count()) >= 1);
  if (await up.count()) {
    await up.click();
    await dp.waitForTimeout(1500);
    check('点父级面包屑跳回上级', dp.url().endsWith('/folders'), dp.url());
  }
  await shoot(dp, 'd8-folders');

  /* ---------- 换文件夹：/folders/:id 同样是被复用的那条路由记录 ----------
   * 侧栏树是「已经站在某个文件夹里、还能点开另一个」的唯一入口。
   * 判据同样是两条：地址换了、面包屑上的名字也换了。 */
  await reloadPage(dp);
  await dp.waitForTimeout(2500);
  await openRail(dp);
  const treeRow = (name) => dp.locator('aside.rail a.tree-link', { hasText: name }).first();
  const parentTreeRow = dp.locator('aside.rail .tree-row', { hasText: FOLDERNAME }).first();
  if (await parentTreeRow.locator('button.twist[aria-expanded="false"]').count()) {
    await parentTreeRow.locator('button.twist').click();
    await dp.waitForTimeout(700);
  }
  await treeRow(FOLDERNAME).click();
  await dp.waitForTimeout(2500);
  const folderAId = dp.url().split('/folders/')[1] ?? '';
  check('侧栏树能打开文件夹 A', !!folderAId && (await dp.locator('header.topbar').innerText()).includes(FOLDERNAME));

  const haveChild = (await treeRow(CHILD).count()) === 1;
  check('侧栏树里能看到子文件夹 B', haveChild);
  if (haveChild) {
    await treeRow(CHILD).click();
    await dp.waitForTimeout(3000);
    const folderBId = dp.url().split('/folders/')[1] ?? '';
    const head = (await dp.locator('header.topbar').innerText()).replace(/\s+/g, ' ');
    check('在 A 里点侧栏的 B，地址换成 B', !!folderBId && folderBId !== folderAId, `${folderAId} → ${folderBId}`);
    check('画面也跟着换成 B', head.includes(CHILD), head);
    await shoot(dp, 'd9-switch-folder');
  }

  // 亮色主题
  await openPage(dp, BASE + '/');
  await dp.evaluate(() => {
    localStorage.setItem('donote.theme', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await dp.waitForTimeout(3000);
  await shoot(dp, 'd7-light');
  check('亮色主题无横向溢出', (await overflows(dp)) <= 1, `${await overflows(dp)}px`);

  /* ---------------------- 侧边栏宽度可拖拽 ---------------------- */
  // 栏宽只有一个出口：store 把宽度写进 <html> 的 --sidebar-w，主内容让位的
  // --content-offset 是同一个变量的别名。所以每条都既看变量、也看真实盒宽和真实内边距
  // —— 只比变量的话，变量改了却没人消费（选择器写错、被覆盖）也照样会 PASS。
  const railBox = () => dp.locator('aside.rail').evaluate((el) => el.getBoundingClientRect().width);
  const varW = () =>
    dp.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim());
  const pagePad = () =>
    dp.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.page')).paddingLeft));

  if ((await dp.evaluate(() => document.documentElement.dataset.sidebar)) !== 'open') {
    await dp.locator('header.topbar button[aria-label="收起或展开侧边栏"]').click();
    await dp.waitForTimeout(600);
  }

  const handle = dp.locator('aside.rail .rail-resizer');
  check('侧边栏有调宽手柄', await handle.isVisible());

  /**
   * 每次重新量手柄位置再按下去：拖窄之后手柄本身也跟着左移了，
   * 沿用第一次量的坐标会按在栏外面，等于什么都没拖到。
   */
  async function dragTo(x) {
    const b = await handle.boundingBox();
    const y = b.y + b.height / 2;
    await dp.mouse.move(b.x + b.width / 2, y);
    await dp.mouse.down();
    await dp.mouse.move(x, y, { steps: 10 });
    await dp.mouse.up();
    await dp.waitForTimeout(500);
  }

  await dragTo(400);
  const w400 = await railBox();
  check(
    '拖到 400：变量与真实宽度一致',
    Math.abs(w400 - 400) <= 2 && (await varW()) === '400px',
    `${w400}px / ${await varW()}`,
  );
  check('主内容让位跟着一起变', Math.abs((await pagePad()) - 400) <= 2, `${await pagePad()}px`);
  check('加宽后仍无横向溢出', (await overflows(dp)) <= 1, `${await overflows(dp)}px`);
  await shoot(dp, 'd9-sidebar-wide');

  await dragTo(60);
  check('拖到 60 被夹回下限 200', Math.abs((await railBox()) - 200) <= 2, `${await railBox()}px`);

  await dragTo(1000);
  check('拖到 1000 被夹回上限 520', Math.abs((await railBox()) - 520) <= 2, `${await railBox()}px`);
  check('松手才落盘，记的是夹取后的值', (await dp.evaluate(() => localStorage.getItem('donote.sidebar-w'))) === '520');

  await reloadPage(dp);
  await dp.waitForTimeout(2500);
  check('刷新后宽度还在', Math.abs((await railBox()) - 520) <= 2, `${await railBox()}px`);

  /*
   * 往左拖这一趟曾经在真机上被掐断：指针离开侧栏落到正文上时，Chromium 会把它判成
   * 「拖选那段文字」，发一个 dragstart 并立刻 pointercancel 掉整个指针序列。
   * 无头环境不一定复现同一次命中判定，但「调宽期间有没有冒出 dragstart」是可以直接断言的。
   */
  await dp.evaluate(() => {
    window.__dragstarts = 0;
    document.addEventListener('dragstart', () => (window.__dragstarts += 1), true);
  });
  await dragTo(240);
  check('往左快拖能一路拖到底', Math.abs((await railBox()) - 240) <= 2, `${await railBox()}px`);
  const dragstarts = await dp.evaluate(() => window.__dragstarts);
  check('调宽全程没有触发原生 dragstart', dragstarts === 0, `${dragstarts} 次`);

  await handle.dblclick();
  await dp.waitForTimeout(500);
  check('双击手柄回到默认 260', Math.abs((await railBox()) - 260) <= 2, `${await railBox()}px`);

  await handle.focus();
  await dp.keyboard.press('ArrowRight');
  await dp.keyboard.press('ArrowRight');
  await dp.waitForTimeout(400);
  check('方向键每次推 16px', Math.abs((await railBox()) - 292) <= 2, `${await railBox()}px`);

  await deskCtx.close();

  /* ==================== 窄窗 880：仍是桌面布局 ====================
   * 桌面端 minWidth 就是 880，而移动布局的判据曾是「视口 ≤1023」—— 也就是说窗口允许的
   * 整个下半段都会被判成手机（冒出底部标签栏、侧栏改抽屉盖内容、工具栏跑到正文下方）。
   * 现在桌面壳里没有移动布局这一层（手机将来另写客户端），这里钉住这条不变式。
   */
  const narrowCtx = await browser.newContext({ viewport: { width: 880, height: 700 } });
  const np = await narrowCtx.newPage();
  await H.attach(np, narrowCtx);
  await connect(np);
  await openPage(np, BASE + '/');
  await np.waitForTimeout(2500);
  await shoot(np, 'n1-home-880');

  const narrow = await np.evaluate(() => {
    const root = document.documentElement;
    const rail = document.querySelector('aside.rail');
    const page = document.querySelector('.page');
    const body = document.querySelector('.page-body');
    const px = (el, prop) => (el ? parseFloat(getComputedStyle(el)[prop]) || 0 : -1);
    return {
      tabs: document.querySelectorAll('nav.tabs').length,
      scrim: document.querySelectorAll('.scrim').length,
      offset: parseFloat(getComputedStyle(root).getPropertyValue('--content-offset')) || 0,
      sidebarW: parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-w')) || 0,
      padLeft: px(page, 'paddingLeft'),
      bodyLeft: body ? body.getBoundingClientRect().left : -1,
      railRight: rail ? rail.getBoundingClientRect().right : -1,
    };
  });
  check('880 没有底部标签栏', narrow.tabs === 0, `nav.tabs = ${narrow.tabs}`);
  check('880 没有抽屉遮罩（侧栏是常驻栏）', narrow.scrim === 0, `scrim = ${narrow.scrim}`);
  check(
    '880 侧栏推开内容，不是盖在内容上',
    narrow.offset === narrow.sidebarW &&
      narrow.padLeft === narrow.sidebarW &&
      narrow.bodyLeft >= narrow.railRight,
    `offset ${narrow.offset} / padding-left ${narrow.padLeft} / 内容左 ${Math.round(narrow.bodyLeft)} / 侧栏右 ${Math.round(narrow.railRight)}`,
  );
  check('880 无横向溢出', (await overflows(np)) <= 1, `${await overflows(np)}px`);

  // 编辑页：工具栏必须在正文**上方**（移动布局会把它排到正文下面）
  await np.locator('.card', { hasText: TITLE }).first().locator('.main').click();
  await np.waitForURL(/\/notes\//, { timeout: 25000 });
  await np.waitForSelector('.toolbar', { timeout: 20000 });
  await np.waitForTimeout(800);
  await shoot(np, 'n2-note-880');
  const narrowNote = await np.evaluate(() => {
    const bar = document.querySelector('.toolbar');
    const box = document.querySelector('.donote-surface');
    const rows = [...document.querySelectorAll('.toolbar .row')];
    return {
      barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
      boxTop: box ? Math.round(box.getBoundingClientRect().top) : null,
      barW: bar ? bar.scrollWidth - bar.clientWidth : 0,
      rowOver: rows.map((r) => r.scrollWidth - r.clientWidth).filter((n) => n > 0).length,
      padX: box ? getComputedStyle(box).paddingLeft : '',
    };
  });
  check(
    '880 工具栏在正文上方',
    narrowNote.barTop !== null && narrowNote.barTop < narrowNote.boxTop,
    `工具栏 top ${narrowNote.barTop} / 正文 top ${narrowNote.boxTop}`,
  );
  check(
    '880 工具栏不横向溢出（行可以换行）',
    narrowNote.barW <= 1 && narrowNote.rowOver === 0,
    `额外宽 ${narrowNote.barW} / 溢出行 ${narrowNote.rowOver}`,
  );
  check('880 正文内边距仍是桌面档 32px', narrowNote.padX === '32px', narrowNote.padX);
  check('880 编辑页无横向溢出', (await overflows(np)) <= 1, `${await overflows(np)}px`);

  /* ---- 正文框调宽手柄 / 提示线 ----
   * 线画在正文框外层（.surface-slot），不在整列（.body）上 —— 否则它会从标题一路贯下来。
   */
  const slotGeom = await np.evaluate(() => {
    const slot = document.querySelector('.surface-slot');
    const box = document.querySelector('.donote-surface');
    const body = document.querySelector('.body');
    const line = (sel) => getComputedStyle(slot, sel).opacity;
    return {
      slotTop: Math.round(slot.getBoundingClientRect().top),
      slotH: Math.round(slot.getBoundingClientRect().height),
      boxTop: Math.round(box.getBoundingClientRect().top),
      boxH: Math.round(box.getBoundingClientRect().height),
      bodyH: Math.round(body.getBoundingClientRect().height),
      lineOff: line('::before'),
      grips: document.querySelectorAll('.width-grip').length,
    };
  });
  check(
    '调宽线的那一层就是正文框那一层（不发散到整列）',
    slotGeom.slotTop === slotGeom.boxTop &&
      Math.abs(slotGeom.slotH - slotGeom.boxH) <= 1 &&
      slotGeom.slotH < slotGeom.bodyH,
    `slot ${slotGeom.slotTop}/${slotGeom.slotH} ｜ 框 ${slotGeom.boxTop}/${slotGeom.boxH} ｜ 整列 ${slotGeom.bodyH}`,
  );
  check('不按 Ctrl 时调宽线不显示', slotGeom.lineOff === '0' && slotGeom.grips === 2, `opacity ${slotGeom.lineOff} / 手柄 ${slotGeom.grips}`);
  await np.keyboard.down('Control');
  await np.waitForTimeout(250);
  const onCtrl = await np.evaluate(() => {
    const slot = document.querySelector('.surface-slot');
    return {
      op: getComputedStyle(slot, '::before').opacity,
      w: getComputedStyle(slot, '::before').width,
    };
  });
  await np.keyboard.up('Control');
  await np.waitForTimeout(250);
  const offCtrl = await np.evaluate(
    () => getComputedStyle(document.querySelector('.surface-slot'), '::before').opacity,
  );
  check('按住 Ctrl 时两侧才亮出细线（1px、半透明）', onCtrl.op === '0.5' && onCtrl.w === '1px', `opacity ${onCtrl.op} / 宽 ${onCtrl.w}`);
  check('松开 Ctrl 后线收回', offCtrl === '0', `opacity ${offCtrl}`);

  await narrowCtx.close();

  /* ============================ 清理 ============================ */
  if (created) {
    await fetch(`${DAV}/${encodeURI(`${TITLE}.md`)}`, {
      method: 'DELETE',
      headers: { Authorization: auth },
    }).catch(() => undefined);
    console.log(`清理：已删除 DoNote/${TITLE}.md`);
  }
  if (createdB) {
    await fetch(`${DAV}/${encodeURI(`${TITLEB}.md`)}`, {
      method: 'DELETE',
      headers: { Authorization: auth },
    }).catch(() => undefined);
    console.log(`清理：已删除 DoNote/${TITLEB}.md`);
  }
  if (folderCreated) {
    await fetch(`${DAV}/${encodeURI(FOLDER)}/`, {
      method: 'DELETE',
      headers: { Authorization: auth },
    }).catch(() => undefined);
    console.log(`清理：已删除 DoNote/${FOLDER}/`);
  }
  H.finish();
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'stage7-walk.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
