# 图标替换任务中断后的现状核实

> 只读核查，未执行任何回退动作。全部结论均有 `git status` / `git diff` / `git ls-tree` 依据。
> 核查时间：2026-10-13 10:2x　｜　工具：git 2.x（Git Bash）

---

## 一、起点 commit

| 项 | 值 |
|---|---|
| **起点 commit（图标任务开始前的 HEAD）** | **`0d91ad2`** — `feat(0.2.4): 侧栏文件夹树 + 批量操作 + 文件夹移动，并修三个既有缺陷` |
| 当前 HEAD | `0d91ad2`（**与起点相同**） |
| 工作区改动 | **全部未提交、未暂存**（`git diff --cached --stat` 为空，`git stash list` 为空） |
| 进行中的合并/变基 | 无 |
| 远端状态 | 起点 commit 已推送（上一轮 push 后远端 main = `f3c607c`，142 文件镜像一致） |

**判定**：图标任务的全部改动都在**工作区与暂存区之外**——没有产生任何新提交。
所谓「回退」= 丢弃工作区改动 + 删除新增的未跟踪文件，**不涉及任何历史改写**。

---

## 二、图标相关改动清单

### 2.1 被修改的已跟踪文件（24 个）

`git diff --name-only`：**24 个文件，其中 17 个在 `icons/`、7 个在别处**。
`git status --porcelain`：**`D`（删除）= 0，`R`（重命名）= 0**。

| 分组 | 文件 | 改动 |
|---|---|---|
| **Tauri 图标（17）** | `apps/desktop/src-tauri/icons/` 下 **全部 17 个文件** | 全部被 `tauri icon` 重写。无新增、无删除，文件集与起点一致 |
| Tauri 图标配置 | `apps/desktop/src-tauri/tauri.conf.json` | **未改**（`git diff --stat` 为空） |
| 图标脚本 | `apps/desktop/package.json` | 1 行：`"icon": "tauri icon ../web/public/icon-512.png"` → `"tauri icon ../../app-icon.png"` |
| Web favicon 引用 | `apps/web/index.html` | +7 / −4 行：删掉内联 `data:image/svg+xml` 的 `<link rel="icon">`，换成 `/favicon.ico` + `/favicon-32.png` + `/favicon-16.png`；`apple-touch-icon` 保留指向 `/icon-192.png`；加 4 行注释 |
| Web 位图 | `apps/web/public/icon-192.png`、`icon-512.png` | 二进制替换（28851→59328 B；161448→409380 B） |
| **应用内 UI logo** | `apps/web/src/components/AppSidebar.vue` | +14 / −10：内联 SVG（18×18 文档图标）→ `<img class="logo-img" src="/icon-192.png" width="28" height="28">`，并加 `.logo-img` CSS（`width/height:100%`、`border-radius: inherit`、`object-fit: cover`） |
| **应用内 UI logo** | `apps/web/src/views/LoginView.vue` | +10 / −10：内联 SVG（22×22）→ `<img class="mark-img" src="/icon-192.png" width="44" height="44">`，并加 `.mark-img` CSS（同上） |
| **下载页** | `site/index.html` | +6 / −6：加 3 行 favicon link；`.mark` 内联 SVG（24×24）→ `<img src="/icon-192.png" width="48" height="48">`；加 `.mark img` CSS |
| **下载页其他** | `site/404.html`、`site/_headers`、`site/updates/*` | **未改**（不在 `git diff` 清单内） |

### 2.2 新增的未跟踪文件（12 个，`git clean -nd` 全量）

| 文件 | 尺寸 | 性质 |
|---|---|---|
| `app-icon.png` | 1,973,952 B，**1536×1536**，8bit / **色彩类型 2（RGB，无 alpha）** | 图标源文件（用户提供，放在项目根） |
| `apps/web/public/favicon-16.png` | 830 B（16×16） | 新生成 |
| `apps/web/public/favicon-32.png` | 2,405 B（32×32） | 新生成 |
| `apps/web/public/favicon-48.png` | 4,668 B（48×48） | 新生成 |
| `apps/web/public/favicon-64.png` | 7,588 B（64×64） | 新生成 |
| `apps/web/public/favicon-128.png` | 26,896 B（128×128） | 新生成 |
| `apps/web/public/favicon-256.png` | 107,953 B（256×256） | 新生成 |
| `apps/web/public/favicon.ico` | 7,957 B（内含 16/32/48 三个 PNG） | 新生成 |
| `site/favicon.ico` | 7,957 B | 从 `apps/web/public/` **拷贝** |
| `site/favicon-32.png` | 2,405 B | 拷贝 |
| `site/icon-192.png` | 59,328 B | 拷贝 |
| `docs/logo-inventory.md` | — | 第一步的核实清单（本次核查的上一份交付物） |

> ⚠️ 注意：起点时 `apps/web/public/` **只有** `icon-192.png` 与 `icon-512.png` 两个文件（`git ls-tree 0d91ad2 apps/web/public/`），
> **没有** `favicon.ico` / `favicon.svg` / `apple-touch-icon.png`。
> 起点时 `site/` 顶层**只有** `404.html` / `_headers` / `index.html` / `updates`，**没有任何图片文件**。
> 所以这些 favicon 全部是**本次新增**，不是覆盖。

### 2.3 未被触碰的位置（逐项核实）

| 任务书列出的位置 | 结论 |
|---|---|
| `src-tauri/icons/` 全部文件 | ✅ 已改（17/17 覆盖重写） |
| `apps/web/public/` favicon | ✅ 已改（新增 7 个 + 覆盖 2 个） |
| `apps/web/index.html` 的 `<link rel="icon">` | ✅ 已改（内联 SVG → 位图） |
| `site/` 下载页 favicon 与 logo | ✅ 已改（本地文件已改；**线上未部署**，见 §四） |
| `tauri.conf.json` 的 `bundle.icon` | ⚪ **未改**，仍为 `["icons/icon.ico"]`（起点即如此，无需改） |
| **AppHeader** | ⚪ **不含 logo**。`AppHeader.vue` 里的 `<svg>` 全是功能图标（刷新/同步 18×18、窗口按钮 12×12），与品牌无关，**未改** |
| **关于页（SettingsView）** | ⚪ **不含 logo**。「关于」区块只有版本号文本（`SettingsView.vue:215-218`），无图片、无内联 SVG logo，**未改** |
| **被删掉的原 SVG 文件** | ⚪ **无**。起点就没有独立的 `.svg` 图标文件；被替换的是 `.vue` / `.html` **文件内的内联 SVG 片段**（文本改动），不涉及文件删除（`git status` 中 `D` 计数 = 0） |
| README / docs 引用的图标图片 | ⚪ **无**。仓库内 README 与 `docs/` 未引用任何图标图片，**未改** |

---

## 三、非图标改动清单（有没有顺带改了不该改的）

**结论：没有。** 逐类核实：

| 类别 | 结论 | 依据 |
|---|---|---|
| 业务代码（存储 / 编辑器 / 同步 / 路由 / 状态） | **未改** | `git diff --name-only` 里除上述 24 个文件外无其他条目 |
| 缓存层（`cache*.ts` / `dav*.ts` / 索引） | **未改** | 不在 `git diff` 清单内 |
| 数据模型 / API 层 | **未改** | 同上 |
| 其他配置（`vite.config.ts` / `Cargo.toml` / `wrangler.toml` / `tsconfig` / `.gitignore`） | **未改** | 同上；`.gitignore` 的 `dist.*/` 规则源自更早的 `b33f107`，非本次 |
| 版本号（7 处） | **未改** | 起点 commit 已完成 0.2.4 版本号，本次未动 |
| `poc/`（含 `.fs-log.jsonl` / `.pristine`） | **未被触碰** | mtime 停在 `2026-10-11`，早于本次任务 |
| `apps/desktop/src-tauri/gen/` | **未被触碰** | mtime `2026-10-10` |
| 发布产物（`target/release/bundle/nsis/*`、`target/release/donote.exe`） | **未被覆盖** | `DoNote_0.2.4_x64-setup.exe` mtime `2026-10-13 01:06`、`donote.exe` 亦为 `01:06` —— 被中断的打包**未走到 NSIS 环节** |
| `site/downloads/*.exe`（线上拷贝源） | **未被覆盖** | `DoNote-0.2.4-win-x64.exe` mtime `01:06`、4,203,433 B，与部署时一致 |
| 线上站点 | **未部署，仍是旧状态** | 见 §四 |

### 唯一的「非图标」文本改动（仍属图标任务范围内）
`site/index.html` 中新增的 2 行 CSS 注释与 `.mark img` 规则、`AppSidebar.vue` / `LoginView.vue` 中的 `.logo-img` / `.mark-img` 规则 ——
都是**为承载新位图而加、且只作用于这两个选择器**，不影响布局、配色、尺寸（容器宽高与圆角沿用原有 `28×28` / `44×44` / `48×48`）。
`git diff` 逐行确认：这三个文件的改动**没有一行**落在 logo 之外。

---

## 四、中断留下的残留

### 4.1 仓库内（未跟踪，不影响 git 历史）

- §2.2 的 **12 个新增文件**。
- `docs/logo-inventory.md`（上一份交付物，是否有保留价值由你定）。

### 4.2 仓库内（被 `.gitignore` 忽略的构建残留，**不进 git status**）

| 路径 | 状态 |
|---|---|
| `apps/web/dist/` | mtime `10:19`，**含新图标的新构建**（145 文件，`index.html` 已引用 `favicon-32.png` 等）—— 被中断的打包在 Vite 阶段已完成 |
| `apps/web/dist.before-icons/` | mtime `01:02`，**旧构建**（138 文件，`index.html` 仍是 `data:image/svg` favicon）。即图标任务开始时让开的那个 `dist` |
| `apps/web/_dist-build-bak/`、`apps/web/_dist-old/` | **已彻底清除**（上一轮逐文件清空成功） |

> `dist/` 与 `dist.*/` 均被 `.gitignore` 覆盖，**对仓库与提交无任何影响**，属可再生成产物。

### 4.3 仓库外（`.workbuddy/tmp/`，已被 `.gitignore` 覆盖）

| 路径 | 内容 |
|---|---|
| `donote/_ak/DoNote-0.2.4-ak-win-x64.exe` | 上一轮「带调试端口的验收包」（4,202,471 B） |
| `donote/_dist-junk/` | **空目录**（改名未成功，无内容） |
| `donote/_shots/` | 6 张核对截图（`login.png` / `sidebar.png` / `brand.png` / `site.png` / `site-brand.png` / `home.png`） |
| `donote/gen-icons.cjs` | 生成 Web favicon 的脚本（**图标任务的核心产物之一**，回退后若重做可复用） |
| `donote/check-logo.cjs`、`check-sidebar-logo.cjs`、`check-site-logo.cjs`、`check-exe-icon.cjs` | 四处核对脚本 |

### 4.4 已清理干净的部分
- `tauri icon` 顺带生成的 `icons/android/`、`icons/ios/` → **已删除**（`ls -d` 确认不存在）。
- `apps/web/_dist-build-bak/`、`apps/web/_dist-old/` → **已删除**。

### 4.5 线上影响：**无**
`donote.pages.dev` 首页 `<head>` 中**没有任何 favicon link**，`/favicon.ico` 与 `/icon-192.png` 均返回 **404**。
本次 `site/` 的改动**从未部署**，线上仍是旧状态（0.2.4 的旧图标下载页）。

---

## 五、建议的回退方案

> 以下均为**建议**，尚未执行。起点 commit 与当前 HEAD 同为 `0d91ad2`，因此**不涉及历史改写**。

### 方案 A：完全回退（回到起点 commit 的干净状态）

```bash
cd /d/design-website/DoNote

# 1) 还原全部已跟踪文件（含 17 个图标、2 个 Vue、2 个 index.html、package.json、2 个 public 位图）
git restore --source=0d91ad2 --worktree -- .

# 2) 删除本次新增的 12 个未跟踪文件
rm -f app-icon.png docs/logo-inventory.md
rm -f apps/web/public/favicon.ico apps/web/public/favicon-{16,32,48,64,128,256}.png
rm -f site/favicon.ico site/favicon-32.png site/icon-192.png

# 3)（可选）清掉被忽略的构建残留
rm -rf apps/web/dist apps/web/dist.before-icons

# 4) 校验：应输出空
git status --short
```

- 因 HEAD 已是 `0d91ad2`，**也可以**用 `git reset --hard 0d91ad2`（等价，但**不会**删未跟踪文件，仍需第 2 步）。
- ⚠️ `git reset --hard` 会一并丢弃工作区**其它**未提交改动 —— 本例中除了图标改动没有别的，但用 `git restore --source=0d91ad2` 更精确、副作用更小，**推荐前者**。
- ⚠️ 若想保留图标源文件，把第 2 步里的 `rm -f app-icon.png` 去掉。

### 方案 B：部分回退（只恢复特定文件）

按需挑选，命令同构：

```bash
cd /d/design-website/DoNote

# 例 1：只把 Tauri 图标还原（保留 Web 侧与 UI 改动）
git restore --source=0d91ad2 --worktree -- apps/desktop/src-tauri/icons/

# 例 2：只把 UI 内的内联 SVG logo 还原（保留新的 favicon / 位图）
git restore --source=0d91ad2 --worktree -- \
  apps/web/src/components/AppSidebar.vue \
  apps/web/src/views/LoginView.vue

# 例 3：只把下载页还原
git restore --source=0d91ad2 --worktree -- site/index.html
rm -f site/favicon.ico site/favicon-32.png site/icon-192.png

# 例 4：只把 favicon 引用还原（保留 Tauri 图标）
git restore --source=0d91ad2 --worktree -- apps/web/index.html
rm -f apps/web/public/favicon.ico apps/web/public/favicon-{16,32,48,64,128,256}.png
```

### 方案 C：保留现状（如果判定改动无害）

**改动本身无害，可以直接保留并提交**，理由：
- `git diff` 显示所有改动都**只落在图标相关的选择器与属性上**，没有一行碰到布局、配色、尺寸或业务逻辑；
- 未执行任何删除，`D`/`R` 计数为 0；
- 未部署，线上不受影响；
- 构建产物（安装包、`site/downloads/`、`target/`）**全部未被覆盖**，唯一的本地副作用是 `apps/web/dist` 被重建成新图标版（可再生成）。

**但有两项需要你先定夺的隐患**（与 `docs/logo-inventory.md` §五 一致）：

1. **源图是 1536×1536，不是任务书说的 1024×1024**。`tauri icon` 只要求正方形且 ≥1024，功能上没问题，但请确认这不是误传的其它文件。
2. **源图是 RGB、无 alpha 通道**。新图标因此是**满幅实色方块、四角不透明**。若你期望的是「带透明圆角的图标」，当前结果四角会是实心色块（在深色任务栏/开始菜单上会露出方形边缘）。

> 若接受这两点，建议走**方案 C 保留 + 提交**；若其中任一是误操作，走**方案 A 完全回退**、补好源图后重来。

---

## 六、[待确认]

1. **回退方式**：A 完全回退 / B 部分回退（哪几个文件）/ C 保留现状并提交？
2. **`app-icon.png`**：保留在项目根并**入库**（作为可复现的图标源），还是删除？
3. **`docs/logo-inventory.md`**：保留，还是一并删掉？
4. **两项图标隐患**（尺寸 1536、无 alpha 四角实心）：接受，还是换源图重做？
5. 若选 C，是否需要**重新打包**（当前 `target/` 里的安装包仍是旧图标版）并**部署 `site/`**？

**执行前请确认；在你确认之前我不会动任何文件。**
