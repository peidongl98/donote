/**
 * DoNote「附件工具层」最小验证（阶段 1）
 *
 * 分两段：
 *   A 纯函数   —— 路径推导 / 名称净化 / 引用改写（不需要网络，含 index.md 嵌套形态）
 *   B 真机联调 —— 对真实坚果云跑 upload / list / has / delete（不 mock）
 *
 * 跑法：先起 dev server（apps/web, 5173），再 node attach-e2e.cjs
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
const ROOT = '/DoNote';
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const NOTE = `E2E附件${STAMP}.md`;
const NOTE_NESTED = `E2E嵌套${STAMP}/index.md`;
const SCAN_NOTE = `E2E扫描${STAMP}.md`;


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
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('response', async (res) => {
    if (res.url().includes('/nutdav/') && res.status() >= 400) {
      let t = '';
      try {
        t = ' <<< ' + (await res.text()).slice(0, 200);
      } catch {}
      console.log(`  >> [${res.status()}] ${res.request().method()} ${decodeURIComponent(res.url())}${t}`);
    }
  });

  const dav = (rel, init = {}) => {
    const { headers = {}, ...rest } = init;
    return ctx.request.fetch(`${DAV}/${encodeURI(rel)}`, {
      ...rest,
      headers: { Authorization: auth, ...headers },
      failOnStatusCode: false,
    });
  };

  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });

    /* ------------------------- A 纯函数 ------------------------- */
    const pure = await page.evaluate(async () => {
      const m = await import('/src/services/attachments.ts');
      const oldName = '框架笔记.assets';
      const newName = '新名.assets';
      const rw = (s) => m.rewriteAssetRefs(s, oldName, newName);
      return {
        flat: m.getAssetsDirPath('框架笔记.md'),
        nested: m.getAssetsDirPath('框架笔记/index.md'),
        topIndex: m.getAssetsDirPath('index.md'),
        deep: m.getAssetsDirPath('a/b/c.md'),
        isTrue: m.isAssetsDir('x.assets'),
        isFalse1: m.isAssetsDir('x.assetsx'),
        isFalse2: m.isAssetsDir('assets'),
        urlFlat: m.attachmentUrl('框架笔记.md', '图片1.png'),
        urlNested: m.attachmentUrl('框架笔记/index.md', 'x.png'),
        san1: m.sanitizeAttachmentName('图:片?.png'),
        san2: m.sanitizeAttachmentName('a/b.png'),
        san3: m.sanitizeAttachmentName('.hidden'),
        r1: rw('![a](框架笔记.assets/1.png)'),
        r2: rw('![a](./框架笔记.assets/1.png)'),
        r3: rw('![a](%E6%A1%86%E6%9E%B6%E7%AC%94%E8%AE%B0.assets/1.png)'),
        r4: rw('<img src="框架笔记.assets/1.png">'),
        r5: rw("![a](框架笔记.assets/1.png '标题')"),
        r6: rw('![a](其它.assets/1.png)'),
        r7: rw('![a](框架笔记.assetsx/1.png)'),
        r8: rw('正文里提到 框架笔记.assets 但没有链接'),
        r9: rw('![a](框架笔记.assets)'),
      };
    });

    check('A1 平铺笔记 → 同名 .assets 目录', pure.flat === '框架笔记.assets', pure.flat);
    check('A2 嵌套笔记 index.md → index.assets', pure.nested === '框架笔记/index.assets', pure.nested);
    check('A3 顶层 index.md → index.assets', pure.topIndex === 'index.assets', pure.topIndex);
    check('A4 深层路径逐段保留', pure.deep === 'a/b/c.assets', pure.deep);
    check('A5 isAssetsDir 认后缀', pure.isTrue === true && pure.isFalse1 === false && pure.isFalse2 === false, `${pure.isTrue}/${pure.isFalse1}/${pure.isFalse2}`);
    check('A6 引用路径用目录名开头', pure.urlFlat === '框架笔记.assets/图片1.png', pure.urlFlat);
    check('A7 嵌套形态的引用路径', pure.urlNested === 'index.assets/x.png', pure.urlNested);
    check('A8 非法字符被替换、中文保留', pure.san1 === '图-片-.png', pure.san1);
    check('A9 路径分隔符不进文件名', pure.san2 === 'a-b.png', pure.san2);
    check('A10 前导点被剥掉', pure.san3 === 'hidden', pure.san3);
    check('A11 改写普通引用', pure.r1 === '![a](新名.assets/1.png)', pure.r1);
    check('A12 保留 ./ 前缀', pure.r2 === '![a](./新名.assets/1.png)', pure.r2);
    check('A13 命中 percent-encoding 写法', pure.r3 === '![a](%E6%96%B0%E5%90%8D.assets/1.png)', pure.r3);
    check('A14 命中 html src 属性', pure.r4 === '<img src="新名.assets/1.png">', pure.r4);
    check('A15 保留 md 标题部分', pure.r5 === "![a](新名.assets/1.png '标题')", pure.r5);
    check('A16 别的 .assets 目录不动', pure.r6 === '![a](其它.assets/1.png)', pure.r6);
    check('A17 前缀相似的目录不动', pure.r7 === '![a](框架笔记.assetsx/1.png)', pure.r7);
    check('A18 正文里的裸词不动', pure.r8 === '正文里提到 框架笔记.assets 但没有链接', pure.r8);
    check('A19 指向目录本身也改名', pure.r9 === '![a](新名.assets)', pure.r9);

    /* ------------------------- B 真机联调 ------------------------- */
    const net = await page.evaluate(
      async ({ note, nested, account, password }) => {
        const m = await import('/src/services/attachments.ts');
        const { WebdavAdapter, setStorage, getStorage } = await import('/src/services/storage/index.ts');
        const adapter = new WebdavAdapter();
        await adapter.connect({
          kind: 'webdav',
          baseUrl: 'https://dav.jianguoyun.com/dav',
          account,
          password,
          root: '/DoNote',
        });
        setStorage(adapter);

        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
        const out = {};

        await getStorage().write(note, '---\ntitle: "附件测试"\n---\n正文');
        out.hasBefore = await m.hasAttachments(note);

        out.up1 = await m.uploadAttachment(note, '图片1.png', png.buffer);
        out.hasAfter = await m.hasAttachments(note);
        out.list1 = await m.listAttachments(note);

        out.up2 = await m.uploadAttachment(note, '图片1.png', png.buffer);
        out.up3 = await m.uploadAttachment(note, '图:片?.png', png.buffer);
        out.list2 = await m.listAttachments(note);

        // 嵌套形态也真机走一遍（笔记嵌套本身是批次 3，这里只验路径推导能落地）
        const nestedDir = nested.slice(0, nested.lastIndexOf('/'));
        await getStorage().ensureDir(nestedDir);
        await getStorage().write(nested, '---\ntitle: "嵌套"\n---\n正文');
        out.upNested = await m.uploadAttachment(nested, 'x.png', png.buffer);

        // 清理
        await m.deleteAttachment(note, out.list2[0].name);
        out.afterDeleteOne = (await m.listAttachments(note)).length;
        await getStorage().delete(m.getAssetsDirPath(note));
        out.afterDeleteDir = await m.hasAttachments(note);
        await getStorage().delete(note);
        await getStorage().delete(m.getAssetsDirPath(nested));
        await getStorage().delete(nested);
        await getStorage().delete(nestedDir);
        out.cleaned = true;
        return out;
      },
      { note: NOTE, nested: NOTE_NESTED, account: ACCOUNT, password: appPassword },
    );

    const assetsDir = `E2E附件${STAMP}.assets`;
    check('B1 上传前没有附件目录', net.hasBefore === false, String(net.hasBefore));
    check('B2 上传返回附件路径', net.up1?.path === `${assetsDir}/图片1.png`, net.up1?.path);
    check('B3 上传返回 md 引用路径', net.up1?.url === `${assetsDir}/图片1.png`, net.up1?.url);
    check('B4 上传后 hasAttachments 为真', net.hasAfter === true, String(net.hasAfter));
    check('B5 列表读回刚上传的附件', net.list1?.length === 1 && net.list1[0].name === '图片1.png', JSON.stringify(net.list1));
    check('B6 重名自动加 -1', net.up2?.url.endsWith('图片1-1.png') === true, net.up2?.url);
    check('B7 非法字符文件名被净化后落盘', net.up3?.url.endsWith('图-片-.png') === true, net.up3?.url);
    check('B8 三个附件都在列表里', net.list2?.length === 3, JSON.stringify((net.list2 || []).map((a) => a.name)));
    check('B9 嵌套形态附件目录 = index.assets', net.upNested?.path === `E2E嵌套${STAMP}/index.assets/x.png`, net.upNested?.path);
    check('B10 删单个附件后剩两个', net.afterDeleteOne === 2, String(net.afterDeleteOne));
    check('B11 删整个附件目录后回到无附件', net.afterDeleteDir === false, String(net.afterDeleteDir));

    /* ------------------------- E 扫描跳过 .assets ------------------------- */
    const scan = await page.evaluate(
      async ({ note, account, password }) => {
        const { WebdavAdapter, setStorage, getStorage } = await import('/src/services/storage/index.ts');
        const adapter = new WebdavAdapter();
        await adapter.connect({
          kind: 'webdav',
          baseUrl: 'https://dav.jianguoyun.com/dav',
          account,
          password,
          root: '/DoNote',
        });
        setStorage(adapter);

        const { notesApi, foldersApi } = await import('/src/storage/notes.ts');
        const att = await import('/src/services/attachments.ts');
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

        const out = {};
        const before = await notesApi.list({});
        out.before = before.total;

        await getStorage().write(note, '---\ntitle: "扫描测试"\n---\n正文');
        await att.uploadAttachment(note, 'a.png', png.buffer);

        // 遍历结果有 3 秒缓存，等它过期再读，否则测的是改动前的树
        await new Promise((r) => setTimeout(r, 3300));

        const after = await notesApi.list({});
        out.after = after.total;

        const folders = await foldersApi.list();
        out.assetsAsFolder = folders.items.filter((f) => att.isAssetsDir(f.name)).map((f) => f.name);

        const hit = await notesApi.list({ q: 'E2E扫描' });
        out.searchHits = hit.items.map((i) => i.title);

        const trash = await notesApi.list({ trash: true });
        out.trashAssets = trash.items.filter((i) => att.isAssetsDir(i.title)).length;

        await getStorage().delete(att.getAssetsDirPath(note));
        await getStorage().delete(note);
        return out;
      },
      { note: SCAN_NOTE, account: ACCOUNT, password: appPassword },
    );

    check('E1 附件目录没有被当成文件夹列出来', scan.assetsAsFolder.length === 0, JSON.stringify(scan.assetsAsFolder));
    check('E2 笔记总数只 +1（附件目录不计数）', scan.after === scan.before + 1, `${scan.before} → ${scan.after}`);
    check('E3 搜索能命中笔记本身', scan.searchHits.length === 1, JSON.stringify(scan.searchHits));
    check('E4 回收站里没有附件目录', scan.trashAssets === 0, String(scan.trashAssets));

    /* ------------------------- C 服务端核对 ------------------------- */
    const stNote = await dav(NOTE, { method: 'PROPFIND', headers: { Depth: '0' } });
    check('C1 测试笔记已从坚果云清掉', stNote.status() === 404, String(stNote.status()));
    const stAssets = await dav(`E2E附件${STAMP}.assets`, { method: 'PROPFIND', headers: { Depth: '0' } });
    check('C2 附件目录已从坚果云清掉', stAssets.status() === 404, String(stAssets.status()));
    const stNested = await dav(`E2E嵌套${STAMP}`, { method: 'PROPFIND', headers: { Depth: '0' } });
    check('C3 嵌套测试目录已清掉', stNested.status() === 404, String(stNested.status()));
    const stScan = await dav(`E2E扫描${STAMP}.md`, { method: 'PROPFIND', headers: { Depth: '0' } });
    const stScanAssets = await dav(`E2E扫描${STAMP}.assets`, { method: 'PROPFIND', headers: { Depth: '0' } });
    check('C4 扫描测试的文件与附件目录都已清掉', stScan.status() === 404 && stScanAssets.status() === 404, `${stScan.status()}/${stScanAssets.status()}`);

    // 探测「目录不存在」必然产生 404，浏览器会把它记进 console，属预期噪音
    const realErrors = consoleErrors.filter((t) => !/404/.test(t));
    check('D1 无预期外的控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' / '));
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
})().catch((err) => {
  console.error('脚本异常：', err);
  process.exitCode = 1;
});
