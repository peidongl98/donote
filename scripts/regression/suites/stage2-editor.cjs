/**
 * 阶段 2 验收：Milkdown 正式集成（所见即所得 + 源码模式）
 *
 * 全部走真实坚果云（dev 代理 /nutdav → dav.jianguoyun.com），不 mock 任何 WebDAV 响应。
 *
 * 覆盖：
 *   1  连接                        2  新建笔记 → 进入详情页
 *   3  编辑器挂载（contenteditable）4  用 Markdown 输入规则打字
 *   5  自动保存到「已保存」         6  磁盘上确实是 Markdown（不是 HTML）
 *   7  刷新后内容不丢               8  刷新后仍渲染成 h1 / 列表
 *   9  源码模式字节精确             10 源码模式改动会落盘
 *  11  切回所见即所得不丢内容        12 console 无错误
 *
 * 用法：BASE=http://localhost:5176 node stage2-editor.cjs
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
// 断言逻辑不受影响，见 harness/davmode.cjs 与 docs/regression-harness.md。
const H = require('../harness/davmode.cjs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:5176';
const SHOTS = path.join(H.ART, 'shots-stage2');
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;

const STAMP = Date.now().toString(36).slice(-6);
const TITLE = `S2所见即所得${STAMP}`;
const TOKEN = `token${STAMP}`;

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
    // 预期噪音：WebDAV 用 404 回答「不存在」
    if (/status of 404/.test(m.text()) && /\.(md|assets)(\/|$)/.test(decoded)) return;
    consoleErrors.push(`${m.text()} << ${url || '?'}`);
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  async function davText(rel) {
    const res = await ctx.request.fetch(`${DAV}/${rel}`, {
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
    return res.ok() ? await res.text() : null;
  }
  async function davDelete(rel) {
    await ctx.request.fetch(`${DAV}/${rel}`, {
      method: 'DELETE',
      headers: { Authorization: auth },
      failOnStatusCode: false,
    });
  }
  /** 笔记文件 = frontmatter + 空行 + 正文；源码模式里看到的只是正文那一段 */
  function bodyOf(raw) {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
    return m ? raw.slice(m[0].length).replace(/^\r?\n/, '') : raw;
  }

  const surface = page.locator('.donote-surface .ProseMirror');
  const source = page.locator('textarea.source');

  try {
    // ---------- 1. 连接 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(SERVER);
      await page.getByPlaceholder('你的账号').fill(ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.getByRole('button', { name: '连接' }).first().click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(800);
    }
    check('1 连上服务器', !page.url().includes('/login'), page.url());

    // ---------- 2. 新建笔记 ----------
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await page.locator('button.fab').click();
    await page.waitForURL(/\/notes\//, { timeout: 20000 });
    await page.locator('input.title-input').fill(TITLE);
    await page.waitForTimeout(300);

    // ---------- 3. 编辑器挂载 ----------
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    const editable = await surface.getAttribute('contenteditable');
    check('3 所见即所得编辑器挂载且可编辑', editable === 'true', `contenteditable=${editable}`);
    check('3 旧 textarea 已不在', (await page.locator('textarea.content-input').count()) === 0);

    // ---------- 4. 打字（走 Markdown 输入规则） ----------
    await surface.click();
    await page.keyboard.type(`# 标题${STAMP}`);
    await page.keyboard.press('Enter');
    await page.keyboard.type(`正文里有 ${TOKEN} 这个词`);
    await page.keyboard.press('Enter');
    await page.keyboard.type('- 第一条');
    await page.keyboard.press('Enter');
    await page.keyboard.type('第二条');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type(`> 引用${STAMP}`);
    await page.waitForTimeout(400);

    const h1InEditor = await surface.locator('h1').innerText();
    check('4 输入 `# 标题` 变成真标题（正文里没有 # 号）', h1InEditor.trim() === `标题${STAMP}`, h1InEditor);
    check('4 输入 `- ` 变成真列表', (await surface.locator('ul li').count()) === 2);
    check('4 输入 `> ` 变成真引用', (await surface.locator('blockquote').count()) === 1);
    await page.screenshot({ path: path.join(SHOTS, '01-wysiwyg.png') });

    // ---------- 5. 自动保存 ----------
    await page.waitForFunction(
      () => document.querySelector('.status')?.textContent?.includes('已保存'),
      undefined,
      { timeout: 25000 },
    );
    check('5 输入后自动保存到「已保存」', true);

    // ---------- 6. 磁盘上是 Markdown ----------
    const savedId = page.url().split('/notes/')[1];
    await page.waitForTimeout(1200);
    const raw = await davText(`${TITLE}.md`);
    const savedBody = raw ? bodyOf(raw) : '';
    check('6 磁盘上存在笔记文件', !!raw, savedId);
    check('6 存的是 Markdown 标题行', !!raw && raw.includes(`# 标题${STAMP}`), (raw || '').split('\n').slice(1, 4).join(' ⏎ '));
    // 无序列表标记允许是 - 或 *：序列化器统一写成 *，这是已接受的「写法规范化」
    check('6 存的是 Markdown 无序列表', /^[-*] 第一条$/m.test(savedBody) && /^[-*] 第二条$/m.test(savedBody));
    check('6 存的是 Markdown 引用', !!raw && raw.includes(`> 引用${STAMP}`));
    check('6 正文原样保留', !!raw && raw.includes(TOKEN));
    check('6 frontmatter 与正文没有混在一起', !!raw && raw.startsWith('---') && !raw.slice(0, 40).includes(TOKEN));
    console.log('--- 落盘正文 ---\n' + savedBody + '--- /正文 ---');

    // ---------- 7 + 8. 刷新 ----------
    await page.reload({ waitUntil: 'networkidle' });
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1200);
    check('7 刷新后标题不丢', (await page.locator('input.title-input').inputValue()) === TITLE);
    check('8 刷新后仍渲染成标题', (await surface.locator('h1').innerText()).trim() === `标题${STAMP}`);
    check('8 刷新后列表与引用都在', (await surface.locator('ul li').count()) === 2 && (await surface.locator('blockquote').count()) === 1);
    check('7 刷新后正文不丢', (await surface.innerText()).includes(TOKEN));

    // ---------- 9. 源码模式字节精确 ----------
    // `exact` 是为了跟正文下方的子页面卡片（可访问名 = 笔记标题）区分开
    await page.getByRole('button', { name: '源码', exact: true }).click();
    await source.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);
    const sourceText = await source.inputValue();
    check('9 源码模式拿到的就是磁盘正文（逐字符一致）', sourceText === savedBody, `源码 ${sourceText.length} 字符 / 磁盘正文 ${savedBody.length} 字符`);
    check('9 源码模式是裸 Markdown，不带 frontmatter', !sourceText.startsWith('---'));
    await page.screenshot({ path: path.join(SHOTS, '02-source.png') });

    // ---------- 10. 源码模式改动会落盘 ----------
    await source.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(`\n\n手工追加 ${STAMP}`);
    await page.waitForFunction(
      () => document.querySelector('.status')?.textContent?.includes('已保存'),
      undefined,
      { timeout: 25000 },
    );
    await page.waitForTimeout(1200);
    const raw2 = await davText(`${TITLE}.md`);
    check('10 源码模式的改动落盘了', !!raw2 && raw2.includes(`手工追加 ${STAMP}`));

    // ---------- 11. 切回所见即所得 ----------
    // 切回要把正文重新过一遍 Milkdown 的解析 → 序列化，第一次会先问一句
    await page.getByRole('button', { name: '所见即所得', exact: true }).click();
    const keepGoing = page.locator('[role="dialog"] .major');
    await keepGoing.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    check('11 首次切回会先提示格式会被规范化', await keepGoing.isVisible().catch(() => false));
    await keepGoing.click();
    await surface.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    const backText = await surface.innerText();
    check('11 切回所见即所得内容没丢', backText.includes(TOKEN) && backText.includes(`手工追加 ${STAMP}`));
    check('11 切回后结构还在', (await surface.locator('h1').count()) === 1 && (await surface.locator('ul li').count()) === 2);
    await page.screenshot({ path: path.join(SHOTS, '03-back-to-wysiwyg.png') });

    // ---------- 11b. 粘贴 Markdown 源码会怎样（如实记录，不预设结论） ----------
    await surface.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const pasteBody = `## 粘贴标题${STAMP}`;
    await page.evaluate((text) => {
      const el = document.querySelector('.donote-surface .ProseMirror');
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, pasteBody);
    await page.waitForTimeout(600);
    const pastedH2 = await surface.locator('h2').count();
    const pasteNote =
      pastedH2 > 0 ? '粘贴的 Markdown 被解析成了结构' : '粘贴的 Markdown 原样落成了一段纯文本（粘贴不解析）';
    console.log(`记录：${pasteNote}`);
    await page.screenshot({ path: path.join(SHOTS, '04-paste.png') });
    fs.writeFileSync(path.join(H.ART, 'stage2-paste.txt'), pasteNote + '\n' + (await surface.innerText()));

    // ---------- 12. console ----------
    check('12 全程没有意外的 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));

    // ---------- 收尾：清掉测试笔记 ----------
    await davDelete(`${TITLE}.md`);
    console.log(`\n清理：已删除 DoNote/${TITLE}.md`);
  } finally {
    H.finish();
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  fs.writeFileSync(
    path.join(H.ART, 'stage2-editor.out'),
    results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  | ' + r.detail : ''}`).join('\n') + '\n',
  );
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(2);
});
