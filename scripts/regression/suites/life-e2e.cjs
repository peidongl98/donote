/**
 * DoNote「附件生命周期联动」端到端验收（阶段 4）
 *
 * 五场景 × 三种附件状态（有附件 / 无附件 / 空附件目录），外加「恢复时原位置被占用」。
 * 全部对真实坚果云跑，断言以服务端实际状态为准。
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5173';
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);


const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

(async () => {
  const appPassword = H.appPassword();
  if (!appPassword) throw new Error('密钥文件里没有 Nut_Web');
  const auth = 'Basic ' + Buffer.from(`${ACCOUNT}:${appPassword}`).toString('base64');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await H.attach(page, ctx);
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const davStatus = async (rel) => {
    const res = await ctx.request.fetch(`${DAV}/${encodeURI(rel)}`, {
      method: 'PROPFIND',
      headers: { Authorization: auth, Depth: '0' },
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
  const davCleanup = async (rel) => {
    await ctx.request.fetch(`${DAV}/${encodeURI(rel)}`, {
      method: 'DELETE',
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
  };

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
      await page.getByPlaceholder('你的账号').fill(ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(800);
    }
    check('0 已连上真实服务器', !page.url().includes('/login'));

    /* ==================== 场景 A：有附件的笔记 ==================== */
    const A = await page.evaluate(
      async ({ stamp }) => {
        const { notesApi, foldersApi } = await import('/src/storage/notes.ts');
        const att = await import('/src/services/attachments.ts');
        const { getStorage } = await import('/src/services/storage/index.ts');
        const bin = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]).buffer;
        const out = {};

        const T = `E2ELa${stamp}`;
        const R = `E2ERa${stamp}`;
        const DIR = `E2EDa${stamp}`;

        const created = await notesApi.create({ title: T, content: `![x](${T}.assets/x.png)` });
        await att.uploadAttachment(`${T}.md`, 'x.png', bin);

        // 重命名
        const afterRename = await notesApi.update(created.note.id, { title: R });
        out.renameOldGone = !(await att.pathExists(`${T}.md`)) && !(await att.pathExists(`${T}.assets`));
        out.renameNewOk = (await att.pathExists(`${R}.md`)) && (await att.pathExists(`${R}.assets/x.png`));
        const body = await getStorage().read(`${R}.md`);
        out.bodyRewritten = body.includes(`![x](${R}.assets/x.png)`);
        out.bodyNoOldRef = !body.includes(`${T}.assets`);

        // 移动
        const folder = await foldersApi.create({ name: DIR });
        const afterMove = await notesApi.update(afterRename.note.id, { folder_id: folder.folder.id });
        out.moveOk = (await att.pathExists(`${DIR}/${R}.md`)) && (await att.pathExists(`${DIR}/${R}.assets/x.png`));
        out.moveOldGone = !(await att.pathExists(`${R}.md`)) && !(await att.pathExists(`${R}.assets`));

        // 软删除
        await notesApi.remove(afterMove.note.id);
        out.deletedFromSource = (await att.pathExists(`${DIR}/${R}.md`)) === false;
        const trashEntries = (await notesApi.list({ trash: true })).items;
        const trashed = trashEntries.find((i) => i.title === R);
        out.trashListed = Boolean(trashed);

        // 恢复
        const restored = await notesApi.restore(trashed.id);
        out.restoreOk = (await att.pathExists(`${DIR}/${R}.md`)) && (await att.pathExists(`${DIR}/${R}.assets/x.png`));

        // 再删一次才进回收站，然后彻底删除
        await notesApi.remove(restored.note.id);
        const trashed2 = (await notesApi.list({ trash: true })).items.find((i) => i.title === R);
        await notesApi.remove(trashed2.id, true);
        out.hardDeleted = !(await notesApi.list({ trash: true })).items.some((i) => i.title === R);
        out.assetsHardDeleted = !(await att.pathExists(`${DIR}/${R}.assets`));

        return out;
      },
      { stamp: STAMP },
    );

    check('A1 重命名：旧文件与旧附件目录都消失', A.renameOldGone);
    check('A2 重命名：新文件与新附件目录都在', A.renameNewOk);
    check('A3 重命名：正文引用改成了新目录名', A.bodyRewritten && A.bodyNoOldRef);
    check('A4 移动：文件与附件都到了目标文件夹', A.moveOk);
    check('A5 移动：原位置没留下空目录', A.moveOldGone);
    check('A6 删除：原位置的笔记已移走', A.deletedFromSource);
    check('A7 删除：回收站列表里能看到它', A.trashListed);
    check('A8 恢复：文件与附件都回到原文件夹', A.restoreOk);
    check('A9 彻底删除：回收站里已无它', A.hardDeleted);
    check('A10 彻底删除：附件目录也没了', A.assetsHardDeleted);

    // 停一会儿再查 .trash 里没有残留的 R 前缀条目
    const trashHrefs = await davChildren('.trash');
    check(
      'A11 服务端 .trash 里没有它的残留',
      trashHrefs.every((h) => !h.includes(`E2ERa${STAMP}`)),
      `${trashHrefs.length} 条`,
    );

    /* ==================== 场景 B：无附件的笔记 ==================== */
    const B = await page.evaluate(
      async ({ stamp }) => {
        const { notesApi, foldersApi } = await import('/src/storage/notes.ts');
        const att = await import('/src/services/attachments.ts');
        const out = {};
        const T = `E2ELb${stamp}`;
        const R = `E2ERb${stamp}`;
        const DIR = `E2EDb${stamp}`;

        const created = await notesApi.create({ title: T, content: '没有附件' });
        const renamed = await notesApi.update(created.note.id, { title: R });
        out.noExtraDir = !(await att.pathExists(`${T}.assets`)) && !(await att.pathExists(`${R}.assets`));

        const folder = await foldersApi.create({ name: DIR });
        const moved = await notesApi.update(renamed.note.id, { folder_id: folder.folder.id });
        await notesApi.remove(moved.note.id);
        const trashed = (await notesApi.list({ trash: true })).items.find((i) => i.title === R);
        out.listed = Boolean(trashed);
        const restored = await notesApi.restore(trashed.id);
        out.restored = await att.pathExists(`${DIR}/${R}.md`);
        await notesApi.remove(restored.note.id);
        const t2 = (await notesApi.list({ trash: true })).items.find((i) => i.title === R);
        await notesApi.remove(t2.id, true);
        out.gone = true;
        return out;
      },
      { stamp: STAMP },
    );

    check('B1 无附件：全流程不产生多余附件目录', B.noExtraDir);
    check('B2 无附件：删除后回收站能看到', B.listed);
    check('B3 无附件：恢复回到原位置', B.restored);
    check('B4 无附件：彻底删除走通', B.gone);

    /* ==================== 场景 C：空附件目录 ==================== */
    const C = await page.evaluate(
      async ({ stamp }) => {
        const { notesApi } = await import('/src/storage/notes.ts');
        const att = await import('/src/services/attachments.ts');
        const { getStorage } = await import('/src/services/storage/index.ts');
        const out = {};
        const T = `E2ELc${stamp}`;
        const R = `E2ERc${stamp}`;

        const created = await notesApi.create({ title: T, content: '空附件目录' });
        await getStorage().ensureDir(`${T}.assets`);

        const renamed = await notesApi.update(created.note.id, { title: R });
        out.carriedOnRename = (await att.pathExists(`${R}.assets`)) && !(await att.pathExists(`${T}.assets`));

        await notesApi.remove(renamed.note.id);
        out.sourceGone = !(await att.pathExists(`${R}.assets`));

        const trashed = (await notesApi.list({ trash: true })).items.find((i) => i.title === R);
        const restored = await notesApi.restore(trashed.id);
        out.backAfterRestore = await att.pathExists(`${R}.assets`);

        await notesApi.remove(restored.note.id);
        const t2 = (await notesApi.list({ trash: true })).items.find((i) => i.title === R);
        await notesApi.remove(t2.id, true);
        out.emptyDirGone = !(await att.pathExists(`${R}.assets`));
        await getStorage().delete(`${R}.md`);
        return out;
      },
      { stamp: STAMP },
    );

    check('C1 空附件目录跟着重命名', C.carriedOnRename);
    check('C2 空附件目录跟着进回收站', C.sourceGone);
    check('C3 空附件目录跟着恢复', C.backAfterRestore);
    check('C4 彻底删除时一并清掉', C.emptyDirGone);

    /* ==================== 场景 D：恢复时原位置被占用 ==================== */
    const D = await page.evaluate(
      async ({ stamp }) => {
        const { notesApi } = await import('/src/storage/notes.ts');
        const att = await import('/src/services/attachments.ts');
        const { getStorage } = await import('/src/services/storage/index.ts');
        const out = {};
        const T = `E2ELd${stamp}`;

        const created = await notesApi.create({ title: T, content: '第一份' });
        await notesApi.remove(created.note.id);
        // 占住原路径：直接写文件。走 create 的话重名会被改成「T 2」，占不到原位
        await getStorage().write(`${T}.md`, '---\ntitle: "占位"\n---\n占位');

        const trashed = (await notesApi.list({ trash: true })).items.find((i) => i.title === T);
        try {
          await notesApi.restore(trashed.id);
          out.refused = false;
          out.message = '(没有报错)';
        } catch (error) {
          out.refused = true;
          out.message = String(error && error.message);
        }
        // 放弃之后，回收站里的那条必须原封不动
        out.stillInTrash = (await notesApi.list({ trash: true })).items.some((i) => i.title === T);
        out.occupierIntact = await att.pathExists(`${T}.md`);
        return out;
      },
      { stamp: STAMP },
    );

    check('D1 原位置被占用时恢复被拒绝', D.refused, D.message);
    check('D2 拒绝后回收站里那条还在', D.stillInTrash);
    check('D3 拒绝后占位的文件没被动过', D.occupierIntact);

    /* ==================== 清理 ==================== */
    const junk = [
      ...(await davChildren('')).filter((h) => /E2E(L|R|D)[abcd]/i.test(h)),
      ...(await davChildren('.trash')).filter((h) => /E2E(L|R|D)[abcd]/i.test(h)),
    ].map((h) => h.replace('/dav/DoNote/', ''));
    for (const rel of junk) await davCleanup(rel);
    const left = (await davChildren('')).filter((h) => /E2E(L|R|D)[abcd]/i.test(h));
    check('E1 测试数据已清干净', left.length === 0, left.map((h) => decodeURIComponent(h)).join(' '));

    check('E2 无预期外的页面错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' / '));
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
