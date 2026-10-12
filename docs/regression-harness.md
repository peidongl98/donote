# 回归脚手架：两层（mock / 真实）

> 2026-10-12 订。起因：9 套连跑必撞坚果云限流，「跑完全绿」这件事一直被环境问题打断。

## 一、一句话

**日常迭代走同源假 DAV（零额度）；发版前跑一次真坚果云。** 切换靠环境变量 `USE_REAL_DAV`，断言逻辑一个字不用改。

| 层 | 命令 | 数据源 | 花坚果云额度 | 用在哪 |
|---|---|---|---|---|
| **mock**（默认） | `bash harness/run-all.sh` | 进程内的假 WebDAV | 否 | 每次改代码后 |
| **real** | `bash harness/run-all.sh --real` | 真坚果云 | 是 | 发版前跑一次 |

文件都在 `D:\design-website\.workbuddy\tmp\donote\`（回归脚本的既有落点，不入库）：

| 文件 | 作用 |
|---|---|
| `harness/davmock.cjs` | 假 WebDAV 内核：内存文件系统 + 协议实现 + 两条入口 |
| `harness/davmode.cjs` | 两层开关：`USE_REAL_DAV`、常量、密码、`attach()` / `finish()` |
| `harness/run-all.sh` | 唯一入口，两种模式 + 可选只跑指定套件 |
| `harness/patch-suites.cjs` | 批量给套件接开关（可 dry / revert） |
| `harness/probe-routing.cjs` | 定方案用的探针（Q1/Q2/Q3），改脚手架前先跑它 |
| `harness/_orig/` | 9 套接入前的原始文件，回退用 |

## 二、为什么必须分层

- 坚果云免费版 **600 请求 / 30 分钟**。9 套连跑约 **13 分钟**就撞 `503 BlockedTemporarily`，
  症状是 `waitForURL` 超时（应用卡在连接页）、脚本 0 项执行、套件跑到一半被掐断。
- 2026-10-12 实测：fix5 跑到第 9 套（`actions-e2e`）被限流打断；此前两条回归脚本并发跑
  （上一轮会话的后台任务**在会话结束后没有被回收**）把额度提前烧穿。
- 所以真实服务器只能承担「发布前的一次性验收」，日常迭代不能靠它。

## 三、假 DAV 是怎么接进去的（三条实测结论）

先跑了 `harness/probe-routing.cjs` 定方案，结论直接决定实现：

| | 问题 | 实测结论 |
|---|---|---|
| Q1 | `context.route()` 能不能拦到 `context.request.fetch()` | **不能**（`ctxRouteHit=0`，请求真的发出去了，返回真服务器的 401） |
| Q2 | `page.route('**/nutdav/**')` 能不能拦到页面里发的 DAV 请求 | **能**（返回 207，命中 1） |
| Q3 | 能不能直接改写 `ctx.request.fetch` | **能** |

于是假 DAV 有**两条入口，共用同一份内存文件系统**：

1. **应用侧**：dev 下 `resolveRequestBase()` 把坚果云地址改写成**同源** `/nutdav/dav`
   （见 `apps/web/src/services/storage/webdav.ts`），所以 `page.route('**/nutdav/**')` 就能接住，
   且同源 = 没有 CORS、没有 OPTIONS 预检。
2. **套件侧**：套件的 `davStatus / davText / davChildren` 是直接 `ctx.request.fetch('https://dav.jianguoyun.com/...')`
   做「服务端核对」的，Q1 证明拦不到，所以改写 `ctx.request.fetch`。

两条入口共用同一个 `NODES`（内存文件系统），因此**「套件核对到的服务端」和「界面看到的内容」永远一致**，
不会出现「界面说删掉了、核对说还在」这种假阳性。

> `SERVER` / `ACCOUNT` / `DAV` 三个常量在两种模式下**取值相同**（都是真坚果云地址）。
> 因为套件里有「默认地址是坚果云」这类**界面字面值**断言；mock 靠拦网络生效，不需要改地址，这些断言就不用动。

## 四、假 DAV 与真服务器的对齐点（都是踩出来的）

| 项 | 假 DAV 的做法 | 依据 |
|---|---|---|
| `Depth: infinity` | 降级成 `1` | 坚果云就这么干；也是「冷启动 1 次请求」做不到的原因 |
| 目录的 `getetag` | 空元素 | 坚果云只对**文件**返回真 etag |
| `getlastmodified` | HTTP-date（秒级） | 与真服务器同格式，缓存层的 `sameSecond()` 比较才成立 |
| `MOVE` 的 `Destination` | **先取 pathname 再算相对路径** | 应用用的是 `originUrl()`，注释写明「Destination 必须是绝对地址，因此不能复用 dev 下的同源代理前缀」——它指向真坚果云主机，而请求本身走 `/nutdav`。直接拿整串比前缀会得到 400 |
| 对**已存在集合** `MKCOL` | 回 **201**（不是 RFC 的 405） | 真实模式 9 套日志里 `405` 出现次数为 **0**，而 `ensureDir()` 是**无条件逐段 MKCOL**、`mkdir()` 同时容忍 201/405 → 真服务器对重复 MKCOL 不报错。按 RFC 回 405 会让「无预期外的控制台错误」在 mock 下假失败 |
| 不存在的路径 | 保持 **404** | 应用靠 PROPFIND 的 404 判断「附件目录 / 回收站原位在不在」，是**预期噪音**（套件里已放行 `.md`/`.assets` 的 404） |
| `PUT` 二进制 | 存 `Buffer`，按扩展名给 `content-type` | 图片套件要逐字节比对附件内容 |
| `Overwrite: F` + 目标已存在 | 回 **412** | 应用靠 412 报「目标位置已有同名条目」 |

种子数据是**确定性**的：空的同步根 + 空的 `.trash`，其余内容全由套件自己造（断言用的都是差值 / 条数，没有写死保险库总量）。

## 五、怎么切换

```bash
# 单套
node notes-e2e.cjs                    # mock（默认）
USE_REAL_DAV=1 node notes-e2e.cjs     # 真坚果云

# 全套
bash harness/run-all.sh               # mock，套件之间不停
bash harness/run-all.sh --real        # 真坚果云，每套之间停 60 秒
```

环境变量：

| 变量 | 作用 |
|---|---|
| `USE_REAL_DAV=1` | 切到真实坚果云；**不设就是 mock**（默认永不碰真服务器） |
| `BASE` | dev server 地址，默认 `http://localhost:5173` |
| `MOCK_LOG=1` | 打印假 DAV 的每条请求与状态（排查用） |

两种模式都要求 dev server 已经在跑（`pnpm --filter @donote/web dev`）。

## 六、新增套件怎么接进来

只改三处，**断言一行不动**：

```js
// 1) 顶部
const H = require('./harness/davmode.cjs');

// 2) 常量与密码
const ACCOUNT = H.ACCOUNT;
const SERVER = H.SERVER;
const DAV = H.DAV;
const appPassword = H.appPassword();

// 3) 每个 newPage() 之后（多个 context 就各调一次）
const page = await ctx.newPage();
await H.attach(page, ctx);
// 收尾（打印假 DAV 请求计数，证明真的没往外发）
H.finish();
```

已有 9 套是脚本批量打的补丁，可复查 / 可回退：

```bash
node harness/patch-suites.cjs --dry     # 只看会改什么
node harness/patch-suites.cjs           # 落盘（原始文件备份到 harness/_orig/）
node harness/patch-suites.cjs --revert  # 回退
```

## 七、能测到 / 测不到

- **能测**：协议层全部读写路径（PROPFIND/GET/PUT/MKCOL/DELETE/MOVE）、界面逻辑、缓存层、附件生命周期。
- **测不到**：真实服务器的**限流行为**、真实网络延迟、坚果云特有的非标准返回。
- 所以 **mock 全绿 = 逻辑回归通过，不等于可以发版**；发版前必须再跑一次 `--real`。

## 八、速度：mock 买到的是额度和确定性，不是秒级

实测（2026-10-12，同机）：

| | mock | 真实 |
|---|---|---|
| 9 套合计断言 | 265 项，全绿 | 8 套全绿、第 9 套被限流打断 |
| 墙钟时间 | **约 11 分钟** | 约 13 分钟 |
| 坚果云请求 | **0** | 上千次，直接撞 600/30 分钟上限 |

**没有达到「全套 < 60 秒」，原因是套件本身不是网络瓶颈**：9 套里有 **137 处硬编码 `waitForTimeout`，合计 177 秒**，
另有大量 `waitUntil: 'networkidle'` 门控；这些等待与数据源无关。逐套对比也能看出 mock 并不更快
（`notes-e2e` 真实 151 s / mock 148 s；`stage4` 真实 49 s / mock 73 s）。

所以这一层的价值是：**不耗额度、不会 503、结果完全确定、可以反复跑**。
要真正做到「秒级」需要把套件里的固定 sleep 改成「轮询条件成立就往下走」——
那是在改套件的时序（不是断言），属于另一个决定，**当前没做**。

## 九、回归结果留档

### mock（2026-10-12）

| 套件 | PASS | FAIL | 用时 |
|---|---|---|---|
| notes-e2e | 47 | 0 | 148s |
| attach-e2e | 39 | 0 | 42s |
| life-e2e | 25 | 0 | 42s |
| stage2-editor | 24 | 0 | 56s |
| stage4-toolbar | 45 | 0 | 73s |
| stage5-image | 11 | 0 | 53s |
| stage6-source | 24 | 0 | 48s |
| stage7-walk | 27 | 0 | 89s |
| actions-e2e.fixed | 23 | 0 | 107s |
| **合计** | **265** | **0** | **约 11 分钟** |

### 真实（2026-10-12）

`bash harness/run-all.sh --real notes-e2e.cjs attach-e2e.cjs stage5-image.cjs`：

| 套件 | PASS | FAIL | 用时 |
|---|---|---|---|
| notes-e2e | 47 | 0 | 197s |
| attach-e2e | 39 | 0 | 83s |
| stage5-image | 11 | 0 | 77s |
| **合计** | **97** | **0** | 559s（含两次 60 秒间隔） |

挑这三套是因为它们最吃 `MOVE` / `MKCOL` / 二进制 `PUT` —— 正是假 DAV 里对齐过真实服务器的那几处。

另有更早一轮真实模式 9 套的留档（见 `docs/batch4-report.md` 与 `fix5-*.log`）：8 套全绿，第 9 套被限流打断 —— 这正是分层的理由。

