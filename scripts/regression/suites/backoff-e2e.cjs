/**
 * DoNote「同步请求调度」端到端验收 —— 全局闸门与限流退避。
 *
 * 对应 docs/sync-concurrency-plan.md §6 判据 1–5。这些都是**纯时序逻辑**，与数据源无关，
 * 所以 mock 上就能测（秒回的假 DAV 看不出并发差别 —— 所以给它 setDelay 人为放慢）。
 *
 *   1  闸门把并发压成 1（5 个并发请求，峰值在途 = 1）
 *   2  撞 503 → 退避 30 分钟起（±25% 抖动之内）
 *   3  退避期间不再出站（后台校验队列被拦住）
 *   4  二次撞限流 → 档位翻倍（约 60 分钟）
 *   5  响应带 Retry-After 时以它为准（而不是本地算的 30 分钟）
 *   6  一次成功 → 档位复位
 *   7  令牌桶：前 30 个请求走库存（突发额度），几乎瞬时放行
 *   8  额度用光后落回「一个 3.2 秒」的补票速率
 *
 * 判据 6/7（排除项、五源全过闸门）靠上面几条的组合覆盖；判据 8（真机跑完）只能在真机上做。
 *
 * 🔴 7/8 是**直接拿模块自身**测的：正式构建才带限速（dev 传 0），所以套件里显式给
 * `REMOTE_MIN_GAP_MS` 调 throughGate。dev 下应用自己的请求不受影响（它们传 0），不会互相干扰。
 */
const { chromium } = require('playwright-core');
// 回归脚手架：默认走同源假 DAV（零坚果云额度），设 USE_REAL_DAV=1 才连真服务器。
const H = require('../harness/davmode.cjs');
const { openPage } = require('../harness/nav.cjs');

const BASE = process.env.BASE || 'http://localhost:5173';

const MIN = 60_000;
/** 抖动的允许范围：基准值的 ±25%，再留一点执行误差 */
const band = (base, lo = 0.7, hi = 1.35) => [base * lo, base * hi];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

/** 页面里发一次「跳过缓存、直接问云端」的请求；返回 'ok' 或错误摘要 */
async function hitDav(page) {
  return page.evaluate(async () => {
    const { getStorage } = await import('/src/services/storage/index.ts');
    try {
      await getStorage().list('', { fresh: true });
      return 'ok';
    } catch (error) {
      return `${error?.name}:${error?.status}:${error?.message}`;
    }
  });
}

/** 读当前退避状态（还剩多少毫秒、档位） */
async function backoffState(page) {
  return page.evaluate(async () => {
    const m = await import('/src/storage/backoff.ts');
    return {
      inBackoff: m.inBackoff(),
      remainingMs: m.backoffUntil() - Date.now(),
      streak: m.backoffStreak(),
    };
  });
}

(async () => {
  const appPassword = H.appPassword();
  if (!appPassword) throw new Error('密钥文件里没有 Nut_Web');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await H.attach(page, ctx);
  H.mock.putNote('退避验收', '用来触发出站请求。');

  try {
    await openPage(page, `${BASE}/`);
    if (page.url().includes('/login')) {
      await page.getByPlaceholder('https://dav.example.com/dav').fill(H.SERVER);
      await page.getByPlaceholder('你的账号').fill(H.ACCOUNT);
      await page.getByPlaceholder('应用密码').fill(appPassword);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 });
      await page.waitForTimeout(500);
    }
    check('0 已连上', !page.url().includes('/login'));

    /* ============ 1. 闸门：5 个并发请求，峰值在途必须是 1 ============ */
    H.mock.setDelay(80);
    H.mock.resetTiming();
    const t0 = Date.now();
    await page.evaluate(async () => {
      const { getStorage } = await import('/src/services/storage/index.ts');
      await Promise.all(
        Array.from({ length: 5 }, () => getStorage().list('', { fresh: true })),
      );
    });
    const elapsed = Date.now() - t0;
    H.mock.setDelay(0);

    const peak = H.mock.timing().peakInflight;
    check('1 闸门把并发压成 1', peak === 1, `峰值在途 ${peak}（期望 1）`);
    // 串行 5 × 80ms ≈ 400ms；若真并发，总耗时约 80ms
    check('1 请求确实排了队', elapsed >= 320, `5 个请求耗时 ${elapsed}ms（串行下限 320ms）`);

    /* ============ 2. 撞 503 → 退避 30 分钟起 ============ */
    H.mock.injectFailure((method) => (method === 'PROPFIND' ? 503 : 0));
    const hit1 = await hitDav(page);
    check('2 503 被识别成限流', hit1.startsWith('StorageError:503'), hit1);

    const b1 = await backoffState(page);
    const [lo1, hi1] = band(30 * MIN);
    check(
      '2 退避 30 分钟起（抖动 ±25%）',
      b1.inBackoff && b1.remainingMs >= lo1 && b1.remainingMs <= hi1,
      `剩 ${Math.round(b1.remainingMs / MIN)} 分钟 · 档位 ${b1.streak}`,
    );

    /* ============ 3. 退避期间不再出站 ============ */
    const before = H.mock.stats().PROPFIND ?? 0;
    await page.evaluate(async () => {
      const { getStorage } = await import('/src/services/storage/index.ts');
      // 命中本地缓存 + 把校验排进后台队列 —— 退避期内这一笔必须被拦住
      await getStorage().list('');
    });
    await page.waitForTimeout(700);
    const after = H.mock.stats().PROPFIND ?? 0;
    check('3 退避期间零出站', after === before, `PROPFIND ${before} → ${after}`);

    /* ============ 4. 二次撞限流 → 档位翻倍 ============ */
    const hit2 = await hitDav(page);
    const b2 = await backoffState(page);
    check(
      '4 二次撞限流翻倍',
      hit2.startsWith('StorageError:503') && b2.remainingMs > b1.remainingMs * 1.4,
      `剩 ${Math.round(b2.remainingMs / MIN)} 分钟（上一次 ${Math.round(b1.remainingMs / MIN)}）· 档位 ${b2.streak}`,
    );

    /* ============ 5. Retry-After 优先 ============ */
    H.mock.injectFailure((method) =>
      method === 'PROPFIND' ? { status: 503, headers: { 'retry-after': '3600' } } : 0,
    );
    const hit3 = await hitDav(page);
    const b3 = await backoffState(page);
    const [lo3, hi3] = band(3600_000);
    check(
      '5 Retry-After 覆盖本地档位',
      hit3.startsWith('StorageError:503') && b3.remainingMs >= lo3 && b3.remainingMs <= hi3,
      `剩 ${Math.round(b3.remainingMs / MIN)} 分钟（Retry-After 说 60 分钟）`,
    );

    /* ============ 6. 一次成功就复位 ============ */
    H.mock.injectFailure(null);
    const ok = await hitDav(page);
    const b4 = await backoffState(page);
    check('6 成功即复位', ok === 'ok' && !b4.inBackoff && b4.streak === 0, `${ok} · 档位 ${b4.streak}`);

    /* ============ 7/8. 令牌桶：先给突发额度，用光后回到补票速率 ============ */
    const burst = await page.evaluate(async () => {
      const { throughGate, REMOTE_MIN_GAP_MS, BURST_TOKENS } = await import('/src/storage/gate.ts');
      const t0 = performance.now();
      const marks = [];
      for (let i = 0; i < BURST_TOKENS + 2; i++) {
        await throughGate(REMOTE_MIN_GAP_MS, async () => marks.push(performance.now() - t0));
      }
      return { marks, gap: REMOTE_MIN_GAP_MS, capacity: BURST_TOKENS };
    });

    const lastFree = burst.marks[burst.capacity - 1];
    check(
      `7 突发额度：前 ${burst.capacity} 个几乎瞬时放行`,
      lastFree < 1000,
      `第 ${burst.capacity} 个在 ${Math.round(lastFree)}ms`,
    );
    // 第 capacity+1 / +2 个才要等票：跨两个请求应 ≈ 2 × 3.2 秒
    const tail = burst.marks[burst.capacity + 1] - burst.marks[burst.capacity - 1];
    const want = burst.gap * 2;
    check(
      '8 额度用光后落回 3.2 秒一个',
      tail >= want * 0.9 && tail <= want * 2,
      `第 ${burst.capacity} → ${burst.capacity + 2} 个用了 ${Math.round(tail)}ms（期望 ≈ ${Math.round(want)}ms）`,
    );
  } catch (error) {
    console.log('脚本异常：', error?.message ?? error);
    process.exitCode = 1;
  } finally {
    await browser.close();
    H.finish();
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${pass}/${results.length} 通过`);
  if (fail) process.exitCode = 1;
})();
