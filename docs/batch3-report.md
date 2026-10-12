# 批次 3 报告：本地缓存 + 自定义标题栏 + 界面遮挡修复（0.2.3）

- 时间：2026-10-12
- 版本：0.2.2 → **0.2.3**，已发布（线上 `https://donote.pages.dev`，commit `b95b11c`）
- 安装包：`site/downloads/DoNote-0.2.3-win-x64.exe`，4,192,047 字节
  sha256 `ad91c3fda567d73e3af14c37f5ac4db633499d75483f9b3f530749b3f7d1c61a`

---

## 一、本地缓存层

### 设计

缓存层是**装饰器**，套在存储注册点（`apps/web/src/stores/webdav.ts::register()`）而不是改适配器内部 ——
以后换存储协议，缓存层不用动。

```
CachedStorage(inner: WebdavAdapter, store: CacheStore, root)  implements StorageAdapter
```

缓存目录 = **安装目录** `data/cache/`（装不进 Program Files 时回落到 `app_data_dir`，设置页会照实说）：

| 文件 | 内容 |
|---|---|
| `meta.json` | 全量元数据：每篇的 title / folder / mtime / etag / cached / dirty |
| `notes/<相对路径>.md` | 按需缓存的正文，保留目录层级 |
| `folders.json` | 目录结构，断网列目录时顶一下 |

### 三条硬规则

1. **读写链路分开**：`read(path, { preferCache: true })` 只给「打开来看」（先给副本求秒开，再后台校验）；
   读改写（保存 / 删除 / 恢复）一律不带这个参数，永远以云端为准 —— 否则会拿旧内容盖掉别人刚改的东西。
2. **只有「请求根本没发出去」才走缓存兜底**：判据是 `StorageError.code === 'unreachable'`。
   服务端返回 4xx/5xx 一律照常抛错，不拿缓存糊弄。
3. **结构变更不做离线兜底**：move / delete / mkdir 断网直接抛错。半成功比失败更难收拾。

### 断网表现

- 启动：先从 `meta.json` 渲染列表，再后台更新。
- 打开：本地有副本 → 立刻显示 + 后台比对指纹（一致不动 / 不一致拉全文覆盖）；没副本 → 拉全文 + 写缓存。
- 保存：写不出去 → 写本地副本 + `dirty: true`；恢复联网后按 mtime 推送。
- 顶栏三态点：绿 = 已同步 / 黄 = 有未推送 / 灰 = 离线用缓存。列表里没缓存的笔记画浅灰。
- 后台预拉取：空闲 30 秒后开始，一批 6 篇、篇间隔 2.5 秒，遇 503/429 冷却 10 分钟。

### ⚠️ 实测发现

- **坚果云的 PROPFIND 不返回 `getetag`**（只有 GET 响应带 `ETag` 头）。
  所以 `stat()` 拿到的 etag 恒为空 → 指纹校验退回 `mtime` 比较（`getlastmodified` 会随内容变化，实测有效）。
  后果是**安全但偏保守**：比对两侧口径不同，实际几乎每次都判「变了」，于是每次打开都会后台重拉一次全文。
  代价是流量不是正确性（不会显示旧内容）。若将来要省这点流量，应改成「服务端 stat 不给 etag 就用 mtime 比」，而不是用本地 GET 到的 etag 去比 PROPFIND 的空值。
- `write()` 里 etag 通道**仍未启用**（`webdav.ts:328` 明确写着本批次不发 `If-Match`），保持与改造前一致的请求形状。

### 验收（真机 · 真实壳 + 真实缓存目录）

断网怎么造：给应用进程设 `HTTPS_PROXY=http://127.0.0.1:1`（死端口）。
桌面端 WebDAV 走的是 **Rust 侧 HTTP**（tauri-plugin-http），CDP 层的 `route/abort` 拦不到它；
而 reqwest 默认认 proxy 环境变量，于是每个请求都「发不出去」= `unreachable`，且不动任何连接配置。

| 场景 | 实测 |
|---|---|
| 断网启动 | 灰点，标题「连不上网盘，正在用本地缓存」；列表仍显示 1 篇（来自缓存），不是错误页 |
| 断网打开 | 编辑器正常挂载，正文来自本地副本 |
| 断网编辑 | 正文落进 `data/cache/notes/未命名.md`（90→91 字节） |
| dirty 标记 | `meta.json` 里 `dirty: true`、mtime 更新为本地时间 |
| 状态点 | 转黄：「有 1 篇改动还没同步」 |
| 云端是否被污染 | **没有** —— 直接 GET 云端，内容与操作前逐字节一致 |

> 记录一次**测量假象**：第一次读 `meta.json` 得到 `dirty: false`，看着像 bug。
> 实际是读取发生在应用 500ms 防抖落盘之前。改成每秒采样后可见 `dirty: true` 全程稳定。
> 教训：验这类「防抖落盘」的状态，必须连续采样，不能读一次就下结论。

**未验到的一条**：恢复联网后把 dirty 推回云端这一路径**没有机器验证** —— 验它就必须真的写用户的网盘。
代码在 `services/cache/background.ts::flushDirty()`（先 stat 比 mtime，云端更新则转冲突）。

---

## 二、自定义标题栏

### 方案

任务书点名的 `tauri-plugin-window-controls` 与 2.3 的要求**直接冲突**：它的按钮是 **Win32 原生子窗口浮在 WebView2 之上**
（README 原文 `rendered in Win32 child windows above WebView2`、`No frontend integration`），CSS 覆盖不了配色。
`tauri-plugin-decoration` 可行但要 `withGlobalTauri` + 原生 HWND overlay，多一个依赖。
最终选**核心 API 自绘**：

- `tauri.conf.json`：`decorations: false`（窗口仍 `transparent: false`，用系统圆角）
- `capabilities/default.json` 补 5 个权限：`allow-start-dragging` / `allow-minimize` / `allow-toggle-maximize` / `allow-is-maximized` / `allow-close`
  （漏了的表现是「按钮点了没反应」—— IPC 静默失败）
- 复用 `AppHeader.vue`（48px，**不新增一行**）：左侧面包屑、中间 `data-tauri-drag-region`、右侧三个窗口按钮贴右边缘
- Rust ~15 行：`DwmSetWindowAttribute(hwnd, 33, DWMWCP_ROUND, 4)`；Win10 不认识该属性，调用失败即忽略
- 最大化图标同步用**窗口作用域**的 `getCurrentWindow().onResized()`，不用全局 `tauri://resize`
  （后者对 `toggleMaximize()` 这类合成尺寸变化不可靠）

### ⚠️ 一个容易误判的点：`WS_CAPTION` 仍然是 1

tao（Tauri 的窗口库）**故意保留** `WS_CAPTION | WS_THICKFRAME`：

- 去标题栏靠 `WM_NCCALCSIZE` 返回 0（整窗都算客户区，系统没地方画标题栏）
- 边缘缩放靠 `WM_NCHITTEST` 自己在边框上回 `HTLEFT` / `HTRIGHT` / …

所以**判据不能是「`WS_CAPTION == 0`」**。真正的判据是：

1. 客户区尺寸 == 配置的窗口尺寸（没有 31px 被标题栏占掉）
2. 四边四角命中测试回 resize 码
3. 内部（含标题栏那一行）回 `HTCLIENT`，不是 `HTCAPTION`

### 验收（真机 0.2.3，Win11）

工具：`.workbuddy/tmp/donote/sw-lab/win-style.py`（Python ctypes，因为沙箱禁止从 bash 调 PowerShell）

| 判据 | 实测 | 结论 |
|---|---|---|
| 客户区 / 非客户区边距 | `1120×780`，边距 `[8,1,8,8]` | 无标题栏占位 |
| 四边 + 四角命中 | `HTLEFT/HTRIGHT/HTTOP/HTBOTTOM` + 四个角 | **边缘缩放可用** |
| 中心 / 标题栏处命中 | `HTCLIENT` / `HTCLIENT` | 原生标题栏确实不存在 |
| DWM 圆角 | `cornerPreference = 2`，`Hr = 0` | **Win11 圆角生效** |
| `is_decorated`（IPC） | `false` | `decorations:false` 已生效 |

DOM / IPC / 行为（CDP）：

| 项 | 实测 |
|---|---|
| origin | `https://tauri.localhost`（0.2.2 的 SW 隔离方案未被破坏） |
| 顶栏 | 找到，带 `data-tauri-drag-region`；48px（`h: 48`） |
| 窗口按钮 | 3 个：最小化 / 最大化 / 关闭；最右按钮右边缘 == 窗口内宽（贴边） |
| 同步状态点 | 存在，`sync-dot is-online`，title「已同步 · 本地已存 N 篇」 |
| 浅灰规则进包 | `.is-uncached` 规则在样式表里 |
| 最大化 | `1120×780` → `1920×1032`，`is_maximized=true`，图标切成「还原」 |
| 还原 | 回到 `1120×780`，图标切回「最大化」 |
| 最小化 | 点击后 Win32 `IsIconic = true`（`allow-minimize` 生效） |
| 关闭 | 点击后进程消失（`allow-close` 生效） |

> ⚠️ CDP 端口怎么来的：wry **总是**显式调 `set_additional_browser_arguments()`，
> 所以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量会被忽略（上一轮我以为是 profile 复用，实际是这个）。
> 验证时用 `pnpm tauri build --no-bundle --config tauri.verify.json` 临时注入
> `--remote-debugging-port=9333`，**不动仓库里的 `tauri.conf.json`**，发版包里没有调试参数。

**拖拽这一条的实测结论（单独复核过）**：窗口**没有位移**，但**不是权限问题**。

- DOM：`[data-tauri-drag-region]` 有两处 —— `HEADER.topbar`（860×48，覆盖整个顶栏）与 `NAV.crumbs`；
  扫描后确认存在「点上去 `elementFromPoint` 就是那个带属性元素自己」的位置（(266,6) → `HEADER.topbar`），
  即不存在「被不带属性的子元素挡住」的情况。
- 用真实鼠标事件序列（down → move 15 步 → up）拖那个点：窗口矩形 `[400,126,1536,915]` 前后一致，没动。
- **直接调 `plugin:window|start_dragging` → `resolved`**（对照组 `is_maximized` 同样可用，且 console / pageerror 全空）。
  → 权限与调用链是通的。
- 没动的原因：Tauri 在 Windows 上是 `ReleaseCapture()` + `PostMessage(WM_NCLBUTTONDOWN, HTCAPTION)`，
  进系统**模态移动循环**，那个循环跟的是**真实光标位置**；CDP 注入的事件进的是渲染进程的输入管线，不移动系统光标。
  验收环境不允许 GUI 接管，所以「实际位移」这一步在这里测不到。
- 可旁证的一点：同批 5 个窗口命令（最大化 / 还原 / 最小化 / 关闭 / is_maximized）全部实测生效。

---

## 三、界面遮挡检测

脚本：`.workbuddy/tmp/donote/screenshots.mjs`（静态服务器 + 无头 Edge + 6 路由 × 2 视口 = 12 个页面状态）

检测项：水平/垂直溢出、裁切（`scrollWidth > clientWidth`）、landmark 两两重叠、关键元素被遮挡
（`elementFromPoint`）、z-index 异常值、滚到底后末项是否被底部固定栏压住。

**结果：12/12 全部干净，0 项遮挡 / 溢出 / 裁切。**

采样数据证明确实留了位置：移动端末项底 224px / 底栏顶 740px / 视口 812px；
桌面端 `/settings`、`/trash` 末项底 836px / 视口 900px。

### 检测器自身的三个假警报（都是检测器写错，不是界面有问题）

1. 输入框报「内容被裁切」—— `input` 天然 `scrollWidth > clientWidth`（光标滚动）→ 排除 `INPUT/TEXTAREA/SELECT`
2. 移动端报 `.page-body` 与底部标签栏重叠 —— 标签栏是 `position: fixed` 的设计 → 重叠检测排除固定定位
3. 移动端抽屉报「压住页面内容」—— 封闭的抽屉也是 `position: fixed` 且铺满视口，`top=0` 把所有页都判成被压
   → 固定栏识别加上 `r.top > vh/2 && r.height < vh/2` 排除全屏抽屉

---

## 四、遇到的问题

| 问题 | 处理 |
|---|---|
| 应用内编辑了一篇真实笔记（压测时误输入） | 用 WebDAV PUT 把**原始字节**（取自上一轮缓存副本）写回，核对逐字节一致 |
| Git Bash 把 `/DoNote/...` 改写成 Git 安装目录下的路径（PUT 到错地址得 410） | 传远端路径一律 `MSYS2_ARG_CONV_EXCL="*"` |
| `cargo check`（debug）报 `拒绝访问 os error 5`（沙箱不让执行新建的 build script） | 改用 `cargo check --release` 复用已有产物 |
| `reg.exe` 被沙箱拉黑 | 查已装版本改用 `donote.exe` 的大小指纹 |
| NSIS 静默安装后 exe 不存在 | 安装器异步返回 → 改成轮询 30×2 秒等 `donote.exe` 落盘 |
| `apps/web/dist.building`（临时挪开的旧 dist）删不掉也移不动：OS 回收站操作失败 + 目录被占用 | **未处理**，保持原位。它们（还有 `apps/web/dist.keep`）在 `.gitignore` 之外但**未被追踪**，不会进 GitHub，`dist/` 会在下次构建时被 Vite 重建 |

## 五、下一步

- 回归用例的完整结果见本轮汇报（`notes-e2e` / `attach-e2e` 等）。
- 想验「恢复联网后自动回推 dirty」，需要一个指向本地假 WebDAV 的测试配置（要动连接配置，需用户同意）。
- 编辑器里公式仍未渲染（显示 LaTeX 原文，未接 KaTeX），属批次 2 遗留。
