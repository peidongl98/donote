/**
 * DoNote「笔记动作菜单」端到端验收（阶段 3）
 *
 * 覆盖：列表页右键 / 「更多」打开菜单 → 重命名 / 移动 / 删除 → 回收站菜单 → 恢复 / 彻底删除
 *      以及编辑态标记（详情页打开时 editingNoteId 有值）
 *
 * 所有断言都以服务端（真实坚果云）的实际状态为准，不 mock。
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5173';
const SHOTS = path.join(H.ART, 'shots-actions');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const TITLE = `E2E动作${STAMP}`;
const RENAMED = `E2E改名${STAMP}`;
const FOLDER = `E2E动作目录${STAMP}`;


const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
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
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const davStatus = async (rel) => {
    const res = await ctx.request.fetch(rel ? `${DAV}/${encodeURI(rel)}` : DAV, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: rel ? '0' : '1' },
      failOnStatusCode: false,
    });
    return res.status();
  };
  const davChildren = async (rel) => {
    const res = await ctx.request.fetch(rel ? `${DAV}/${encodeURI(rel)}` : DAV, {
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
    return [...xml.matchAll(/:href>([^<]+)</g)].map((m) => decodeURIComponent(m[1]));
  };

  /** 菜单开着的时候点某项 */
  const sheetItem = (text) => page.locator('.sheet-mask .sheet-item', { hasText: text }).first();
  const cardOf = (title) => page.locator('.card', { hasText: title }).first();

  try {
    /* ------------------------- 0 连接 ------------------------- */
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
      await page.getByPlaceholder('你的账号').fill(ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(800);
    }
    check('0 已连上真实服务器', !page.url().includes('/login'), page.url());

    /* ------------------------- 准备数据 ------------------------- */
    await page.evaluate(
      async ({ title, folder }) => {
        const { notesApi, foldersApi } = await import('/src/storage/notes.ts');
        const att = await import('/src/services/attachments.ts');
        const { getStorage } = await import('/src/services/storage/index.ts');
        await notesApi.create({ title, content: '动作菜单测试正文' });
        await foldersApi.create({ name: folder });
        const dir = att.getAssetsDirPath(`${title}.md`);
        await getStorage().ensureDir(dir);
        await getStorage().write(`${dir}/a.png`, new Uint8Array([137, 80, 78, 71]).buffer);
      },
      { title: TITLE, folder: FOLDER },
    );
    check('1 准备数据：笔记 + 文件夹 + 附件目录都在服务端', (await davStatus(`${TITLE}.md`)) === 207 && (await davStatus(FOLDER)) === 207 && (await davStatus(`${TITLE}.assets`)) === 207);

    /* ------------------------- 2 列表页菜单入口 ------------------------- */
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3500);

    await cardOf(TITLE).click({ button: 'right' });
    await page.waitForTimeout(500);
    check('2 右键卡片弹出操作菜单', await page.locator('.sheet-mask .sheet').isVisible());
    const menuText = await page.locator('.sheet-mask .sheet').innerText();
    check(
      '3 菜单含重命名 / 移动到文件夹 / 删除',
      /重命名/.test(menuText) && /移动到文件夹/.test(menuText) && /删除/.test(menuText),
      menuText.replace(/\n/g, ' '),
    );
    await page.screenshot({ path: path.join(SHOTS, '01-menu.png') });

    // 点遮罩关掉，再用「更多」按钮开一次
    // 诊断：记录 (8,8) 处的实际命中元素与遮罩盒模型
    const maskBox = await page.locator('.sheet-mask').boundingBox();
    const hit88 = await page.evaluate(() => {
      const el = document.elementFromPoint(8, 8);
      return el ? el.tagName + '.' + (typeof el.className === 'string' ? el.className : '') : 'null';
    });
    console.log(`DIAG elementFromPoint(8,8) = ${hit88}`);
    console.log(`DIAG sheet-mask box = ${JSON.stringify(maskBox)}`);
    // 原脚本用左上角 (8,8)，被常驻侧栏 .rail 盖住；改点遮罩右上角
    await page.locator('.sheet-mask').click({ position: { x: Math.max(20, (maskBox?.width ?? 1280) - 20), y: 8 } });
    await page.waitForTimeout(400);
    check('4 点空白处可关闭菜单', !(await page.locator('.sheet-mask').isVisible()));

    await cardOf(TITLE).locator('button.more').click();
    await page.waitForTimeout(400);
    check('5 卡片右上角「更多」也能开菜单', await page.locator('.sheet-mask .sheet').isVisible());

    /* ------------------------- 6 重命名 ------------------------- */
    await sheetItem('重命名').click();
    await page.waitForTimeout(500);
    const renameInput = page.locator('[role="dialog"] input');
    check('6 重命名对话框带出现有标题', (await renameInput.inputValue()) === TITLE, await renameInput.inputValue());
    await renameInput.fill(RENAMED);
    await page.locator('[role="dialog"] button', { hasText: '保存' }).click();
    await page.waitForTimeout(2500);
    check('6 重命名后新文件名落在服务端', (await davStatus(`${RENAMED}.md`)) === 207, `PROPFIND ${RENAMED}.md`);
    check('6 旧文件名已消失', (await davStatus(`${TITLE}.md`)) === 404, `PROPFIND ${TITLE}.md`);
    check('6 列表里已是新标题', (await page.locator('body').innerText()).includes(RENAMED));

    /* ------------------------- 7 移动 ------------------------- */
    await cardOf(RENAMED).click({ button: 'right' });
    await page.waitForTimeout(400);
    await sheetItem('移动到文件夹').click();
    await page.waitForTimeout(1500);
    await page.locator('[role="dialog"] button.folder-pick', { hasText: FOLDER }).first().click();
    await page.waitForTimeout(2500);
    check('7 移动后文件出现在目标文件夹', (await davStatus(`${FOLDER}/${RENAMED}.md`)) === 207, `${FOLDER}/${RENAMED}.md`);
    check('7 原位置已清空', (await davStatus(`${RENAMED}.md`)) === 404, `${RENAMED}.md`);

    /* ------------------------- 8 删除进回收站 ------------------------- */
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await cardOf(RENAMED).click({ button: 'right' });
    await page.waitForTimeout(400);
    await sheetItem('删除').click();
    await page.waitForTimeout(500);
    await page.locator('[role="dialog"] button', { hasText: '移入回收站' }).click();
    await page.waitForTimeout(2500);
    const trashNow = await davChildren('.trash');
    check('8 回收站里出现了它', trashNow.some((h) => h.includes(RENAMED)), trashNow.length + ' 条');
    check('8 原位置已不在', (await davStatus(`${FOLDER}/${RENAMED}.md`)) === 404);

    /* ------------------------- 9 回收站页菜单 ------------------------- */
    await page.goto(`${BASE}/trash`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const trashRow = page.locator('.row-card', { hasText: RENAMED }).first();
    await trashRow.click({ button: 'right' });
    await page.waitForTimeout(500);
    const trashMenu = await page.locator('.sheet-mask .sheet').innerText();
    check('9 回收站菜单是恢复 / 彻底删除', /恢复/.test(trashMenu) && /彻底删除/.test(trashMenu), trashMenu.replace(/\n/g, ' '));
    check('9 回收站菜单不出现「移动到文件夹」', !/移动到文件夹/.test(trashMenu));

    /* ------------------------- 10 恢复 ------------------------- */
    await sheetItem('恢复').click();
    await page.waitForTimeout(3000);
    check('10 恢复后回到原来的文件夹', (await davStatus(`${FOLDER}/${RENAMED}.md`)) === 207, `${FOLDER}/${RENAMED}.md`);

    /* ------------------------- 11 编辑态标记 ------------------------- */
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await cardOf(RENAMED).click();
    await page.waitForURL(/\/notes\//, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const editingId = await page.evaluate(async () => {
      const { useEditingStore } = await import('/src/stores/editing.ts');
      return useEditingStore().editingNoteId;
    });
    check('11 打开详情页时标记了正在编辑的笔记', Boolean(editingId), String(editingId));

    // 离开详情页后标记要清掉
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const leftId = await page.evaluate(async () => {
      const { useEditingStore } = await import('/src/stores/editing.ts');
      return useEditingStore().editingNoteId;
    });
    check('11 离开详情页后标记被清掉', leftId === null, String(leftId));

    /* ------------------------- 12 再删一次 → 彻底删除 ------------------------- */
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await cardOf(RENAMED).click({ button: 'right' });
    await page.waitForTimeout(400);
    await sheetItem('删除').click();
    await page.waitForTimeout(500);
    await page.locator('[role="dialog"] button', { hasText: '移入回收站' }).click();
    await page.waitForTimeout(2500);

    await page.goto(`${BASE}/trash`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.locator('.row-card', { hasText: RENAMED }).first().click({ button: 'right' });
    await page.waitForTimeout(400);
    await sheetItem('彻底删除').click();
    await page.waitForTimeout(500);
    await page.locator('[role="dialog"] button', { hasText: '彻底删除' }).click();
    await page.waitForTimeout(3000);
    check(
      '12 彻底删除后 .trash 里已无此文件',
      (await davChildren('.trash')).every((h) => !h.includes(RENAMED)),
    );
    check('12 回收站列表里也没有了', !(await page.locator('body').innerText()).includes(RENAMED));

    /* ------------------------- 13 清理 ------------------------- */
    await page.evaluate(
      async ({ folder, assets }) => {
        const { getStorage } = await import('/src/services/storage/index.ts');
        await getStorage().delete(folder);
        await getStorage().delete(assets);
      },
      { folder: FOLDER, assets: `${RENAMED}.assets` },
    );
    check(
      '13 测试数据已清干净',
      (await davStatus(FOLDER)) === 404 && (await davStatus(`${RENAMED}.assets`)) === 404,
    );

    const realErrors = consoleErrors.filter((t) => !/404|Failed to load resource/.test(t));
    check('14 无预期外的控制台错误', realErrors.length === 0, realErrors.slice(0, 2).join(' / '));
  } catch (err) {
    console.error('脚本异常：', err);
    process.exitCode = 1;
  } finally {
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((r) => r.name).join('、'));
    process.exitCode = 1;
  }
})();
