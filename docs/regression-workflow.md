# 回归与发版工作流

> 2026-10-13 订。目标：把「改代码 → 上线」从「等 6 分钟跑 9 套」变成「1 分钟确认没坏 + 一键发版」。
> 底层的两层脚手架（mock / 真实）、假 DAV 怎么接进去，见 [regression-harness.md](./regression-harness.md)。

---

## 一、三种场景

| 场景 | 命令 | 跑什么 | 实测耗时 |
|---|---|---|---|
| **日常迭代**（改完一块代码） | `pnpm regress --changed` | 受改动影响的 1–4 套 | **23s – 95s**（见 §五） |
| **提交前** | `pnpm regress` | 全套 9 套 | **约 5 分钟**（316s / 265 PASS） |
| **发版前** | `pnpm regress --real --suites=…` → `pnpm release 0.2.5` | 真坚果云抽样 + 一键发布 | 真实模式较慢，见 harness 文档 |

前置：dev server 得先跑着。

```bash
pnpm --filter @donote/web dev      # 另开一个终端，保持运行
```

运行器发现 `http://localhost:5173` 不通会直接退出（退出码 2），不会跑到一半才失败。

---

## 二、运行器

`scripts/regression/run-regression.cjs`（`pnpm regress` 是它的别名）。
只依赖 Node 内置模块，不引入任何依赖。

### 选择器（可叠加，取并集；一个都不给 = 全套）

| 选择器 | 作用 | 例 |
|---|---|---|
| `--changed[=ref]` | 按 git 改动自动挑套件 | `pnpm regress --changed`、`--changed=origin/main` |
| `--module=a,b` | 按功能模块挑 | `pnpm regress --module=cache` |
| `--suites=a,b` | 按套件短名挑（也认 `notes-e2e` / `notes-e2e.cjs`） | `pnpm regress --suites=notes,life` |
| `--all` | 全套 | |

`--changed` 的判定顺序：命中「触发全套」的位置 → 全套；命中某个模块 → 该模块的套件；
落在源码目录但没归类 → **保守起见跑全套**（并打印是哪些文件）；文档 / 站点 / 脚本 → 忽略。

### 运行方式

| 开关 | 说明 |
|---|---|
| `--real` | 切真坚果云（`USE_REAL_DAV=1`），套件之间默认停 60 秒避限流 |
| `--mock` | 强制 mock（默认） |
| `--gap=N` | 套件间隔秒数（`--real` 默认 60，mock 默认 0） |
| `--timeout=N` | 单套超时秒（默认 600），超时强杀并计为失败 |
| `--base=URL` | dev server 地址（默认 `http://localhost:5173`） |
| `--suites-dir=DIR` | 套件目录（默认读映射表的 `suitesDir` = `scripts/regression/suites`；旧名 `--harness-dir` 仍认） |
| `--log-dir=DIR` | 日志目录（默认 `scripts/regression/.logs`） |
| `--node-path=DIR` | `playwright-core` 所在 `node_modules`（默认取 `local.json` → `DONOTE_NODE_PATH`） |

> 本机相关的东西（node_modules 路径、密钥文件、账号、BASE）放在 `scripts/regression/local.json`，
> 从 `local.example.json` 复制即可；该文件不入库。缺省时走映射表默认值 / 环境变量。

### 输出

| 开关 | 说明 |
|---|---|
| `--explain` | **只看会跑哪些、为什么**，不执行。选之前先跑这个最省事 |
| `--list` | 列出全部套件、模块映射、触发全套的位置 |
| `--json` | 汇总以 JSON 输出 |

### 退出码与日志

- `0` 全绿
- `1` 有 FAIL / 某套 0 项断言 / 超时
- `2` 用法错或环境错（dev server 不通、套件目录不存在）

日志沿用旧约定：`<mock|real>-<套件文件>.log`，写在日志目录（默认 `scripts/regression/.logs/`，不入库）。失败的套件会顺手打印前 6 行 `FAIL` 与日志路径。

---

## 三、依赖映射表

**`scripts/regression/regression-map.json`** —— 运行器只读它，改表不用改代码。
套件本体与假 DAV 也都在**仓库里**（`scripts/regression/suites` / `harness`），因为它要跟代码一起演进。

每套除了 `estSeconds`（预估耗时）还有 `checks`（**预期断言项数**，9 套合计 265）：
套件崩在半路时进程照样会 print 已经跑完的 PASS 行，只数 PASS/FAIL 会把「19/39」看成全绿。
运行器用 `PASS+FAIL` 跟 `checks` 对齐，**缺的项数按 FAIL 计入汇总**，并单独标红列出。
套件加了断言 → 记得同步改这个字段（少记会误报「多出 N 项」）。

### 9 套套件

| 短名 | 文件 | 覆盖 | 实测耗时 |
|---|---|---|---|
| `notes` | `notes-e2e.cjs` | 连接 / 新建 / 自动保存 / 改名 / 移动 / 软删 / 回收站 / 恢复 / 彻底删除 / 断开 | 95s |
| `attach` | `attach-e2e.cjs` | 附件路径推导与引用的纯函数 + upload / list / has / delete | 13s |
| `life` | `life-e2e.cjs` | 附件生命周期联动（五场景 × 三种附件状态） | 13s |
| `stage2` | `stage2-editor.cjs` | Milkdown 集成、落盘是 Markdown、源码模式字节精确 | 23s |
| `stage4` | `stage4-toolbar.cjs` | 编辑器工具栏 15 项（既看 DOM 也看落盘） | 31s |
| `stage5` | `stage5-image.cjs` | 图片按钮 → 上传附件 → 插入引用 | 16s |
| `stage6` | `stage6-source.cjs` | 源码 / 所见即所得开关与规范化提示 | 19s |
| `stage7` | `stage7-walk.cjs` | 桌面 / 移动布局、侧栏与抽屉、浮层不跨栏 | 47s |
| `actions` | `actions-e2e.fixed.cjs` | 动作菜单：重命名 / 移动 / 删除 / 恢复 / 彻底删除 | 57s |

### 模块 → 套件（22 个模块）

| 模块 | 代码位置 | 跑哪些套件 |
|---|---|---|
| `cache` | `services/cache/**` | notes, life, attach |
| `storage` | `services/storage/**` | notes, attach, life, actions, stage7 |
| `attachments` | `services/attachments.ts` | attach, life, stage5 |
| `batch` | `services/batch.ts` | actions, life |
| `pick-image` | `services/pick-image.ts` | stage5 |
| `editor` | `components/editor/**` | stage2, stage4, stage5, stage6 |
| `sidebar` | `AppSidebar.vue`, `SidebarTree.vue` | stage7 |
| `chrome` | `AppHeader.vue`, `BottomTabs.vue`, `ThemeToggle.vue` | stage6, stage7 |
| `overlays` | `AppDialog.vue`, `NoteActionMenu.vue`, `BatchToolbar.vue`, `EmptyState.vue` | actions, stage7 |
| `ui-kit` | `Glass*.vue`, `MarkdownView.vue`, `WebdavGuide.vue` | notes, stage7 |
| `views-home` | `views/HomeView.vue`, `NoteCard.vue` | notes, actions, life |
| `views-note` | `views/NoteEditView.vue` | stage2, stage4, stage5, stage6 |
| `views-folders` | `views/FoldersView.vue`, `FolderDetailView.vue` | notes, actions, life, stage7 |
| `views-trash` | `views/TrashView.vue` | notes, actions, life |
| `views-login` / `views-settings` | `LoginView.vue` / `SettingsView.vue` | notes |
| `stores` | `stores/**` | notes, actions, stage7 |
| `styles` | `styles/**` | stage7 |
| `router` | `router/**` | notes, stage7 |
| `utils` | `utils/**` | notes, attach, stage7 |
| `web-entry` | `main.ts`, `App.vue`, `index.html` | notes, stage7 |

### 另外两类

- **`fullRunTriggers`**：影响面横跨所有套件的位置 → 直接全套。
  `packages/shared/**`、`pnpm-lock.yaml`、根 `package.json`、`vite.config.ts`、`storage/types.ts`、
  `apps/desktop/src/**`、`apps/desktop/src-tauri/{src/**,tauri.conf.json,Cargo.toml}`。
- **`ignorePaths`**：不触发任何套件。`docs/**`、`site/**`、`scripts/**`、`.workbuddy/**`、`**/*.md`、
  `.gitignore`，以及 `Cargo.lock`（这里只随版本号变，版本号改动不该惊动回归）。

### 怎么维护

- **加了新套件**：在 `suites` 里加一项（`file` 必填），再把它补进相关模块的 `suites`。
  加上去之前**先确认它已按 harness 文档接好 `davmode` 开关**，否则真实模式会打到真服务器。
- **加了新模块 / 新文件**：在 `modules` 里加一项，写清 `paths` 与 `suites`。
  **没归类的新文件落在源码目录里会被判成「未归类」→ 自动跑全套**，所以宁可先归类。
- **改动前后都可以自查**：`pnpm regress --explain --changed`。

---

## 四、一键发版

```bash
pnpm release 0.2.5
pnpm release 0.2.5 --notes "侧栏改成文件夹树…"
node scripts/release.mjs 0.2.5 --dry-run      # 只打印计划，什么都不做
```

### 七步，任一步失败立刻停

| 步 | 做什么 | 细节 |
|---|---|---|
| 1 | 改版本号（**7 处**） | `package.json`、`apps/{desktop,web}/package.json`、`packages/shared/package.json`、`tauri.conf.json`、`Cargo.toml`、`site/index.html` 的 `data-href`。**少改任何一处都会报出来并停下** |
| 2 | 打包 | 先把 `apps/web/dist` 让开 → `tauri build --bundles nsis`。`Cargo.lock` 由 cargo 自动跟随 |
| 3 | 生成发布产物 | `make-release.mjs` → `site/downloads/DoNote-<v>-win-x64.exe` + `site/updates/latest.json` |
| 4 | 部署 | `wrangler pages deploy site --project-name donote --branch main` |
| 5 | 提交 | `chore(release): <v>` |
| 6 | 推送 | GitHub Git Data API（`git push` 会弹凭据管理器挂死，不用） |
| 7 | 线上核验 | `latest.json` 版本、安装包 HTTP 200 + **sha256 与本地一致**、**上一版仍可下载** |

### 前置检查（不满足就停在做任何改动之前）

- 版本号格式 `x.y.z` 且**大于**当前（`--force` 可强推）
- 分支必须是 `main`（`--allow-branch` 放行）
- 工作区必须干净（`--allow-dirty` 放行）
- 凭据文件 `D:/design-website/.deploy-secrets` 里有 `GITHUB_TOKEN` / `CLOUDFLARE_Page_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
- `cargo`（rustup toolchain 的 bin）、tauri CLI、`wrangler` 都能找到

### 按需跳过

`--skip-build` `--skip-release` `--skip-deploy` `--skip-commit` `--skip-push` `--skip-verify`
（重跑某一步时用；跳过 deploy 仍会走到提交和推送）

### 失败之后

脚本会打印**已完成的步骤**和**收尾建议**。通用的收尾：

- 失败在第 5 步之前 → 版本号已改但没提交：`git restore --source=HEAD --worktree -- .` 把 7 处还原
- 失败在第 6 步 → 本地已提交、远端没更新：修好原因后重跑 `--skip-build --skip-release --skip-deploy`
- 失败在第 7 步 → 已经在线上跑完了：用 `--skip-build --skip-release --skip-deploy --skip-commit --skip-push` 只重做核验

### ⚠ 两条硬约束

1. **发版前必须跑过真机验收**：`node scripts/regression/run-regression.cjs --real`（或抽样几套）。
   mock 全绿只等于「逻辑回归通过」，不代表能发版 —— 真实服务器的限流、非标准返回 mock 测不到。
2. **`pnpm release` 不会替你跑回归**。它是发布动作，不是质量门禁；跑回归是发版前的独立一步。

---

## 五、耗时对比（改前 vs 改后）

### 改前

- 只有 `bash scripts/regression/harness/run-all.sh` 一条路：**默认就是全套 9 套**。
- 想只跑几套得手打**完整文件名**：`bash scripts/regression/harness/run-all.sh notes-e2e.cjs life-e2e.cjs`。
- 「改了哪个文件该跑哪几套」全靠记忆，没有可查的映射。
- 没有「只看会跑什么、不执行」的干跑。

### 改后（同一台机器，mock，2026-10-13 实测）

| 场景 | 命中面 | 套件数 | 实测 |
|---|---|---|---|
| 改 `services/attachments.ts` | attach, life, stage5 | 3 | **约 42s** |
| 改 `services/cache/**` | notes, life, attach | 3 | 约 121s |
| 改 `components/editor/**` | stage2, stage4, stage5, stage6 | 4 | 约 89s |
| 改 `components/AppSidebar.vue` | stage7 | 1 | 约 47s |
| 提交前 / 发版前 | 全套 | 9 | **316s（265 PASS / 0 FAIL）** |

> 单套实测（用于上面的加总）：notes 95s、attach 13s、life 13s、stage2 23s、stage4 31s、
> stage5 16s、stage6 19s、stage7 47s、actions 57s。全套实测 316s，与 history 记录的量级一致。

**一句话**：改一块具体功能，确认窗口从「全套约 5 分钟」压到 **13 秒 – 1.5 分钟**；
只有提交前 / 发版前才付全套的代价。

---

## 六、边界，以及这一批次没做的

- **套件本身没有更快**。9 套里有 137 处硬编码 `waitForTimeout`（合计约 177 秒）与大量
  `waitUntil: 'networkidle'` 门控 —— 要真正压到秒级得把这些改成「条件成立就往下走」，
  那是在改套件时序，属于另一个决定，**本批次没做**。
- **套件没有去重重组**（9 套合并成 4–5 套）是独立任务，本批次不碰。约束是「不删任何现有套件、不改任何断言」。
- **套件本体已入库**（2026-10-13）：`scripts/regression/suites/`、`scripts/regression/harness/`。
  入库前做过敏感信息清理：硬编码账号改为 `DONOTE_ACCOUNT`，密钥文件路径改为 `DONOTE_SECRETS`
  （默认仓库上一级的 `.deploy-secrets`），产物改写到 gitignore 的 `.artifacts/`；本机值集中在 `local.json`（不入库）。
- **mock 全绿 ≠ 可发版**，理由见 §四。
