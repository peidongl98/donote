# 参考项目调研笔记（阶段 0）

调研时间：2026-10-09
调研方式：GitHub REST API 核实仓库元数据 + 读取关键源文件（未克隆，按需抽取）
结论口径：`存在` = 仓库可访问且非归档；`可用` = 本项目可直接依赖或直接抄。

## 一、总览

| 项目 | 仓库 | 存在 | 维护状态 | GitHub 最后推送 | 本批用途 |
|---|---|---|---|---|---|
| synap.md | BungeeDEV/synap.md | ✅ 存在 | 活跃（2026-08-22） | Vue | monorepo 结构参考 |
| Obsttorte | shikakun/obsttorte | ✅ 存在 | 活跃（2026-10-08） | TypeScript | Cloudflare 同步架构参考（本批仅记录） |
| FlareMo | realchendahuang/FlareMo | ✅ 存在 | 活跃（2026-10-04） | TypeScript | 多租户 / D1 schema 参考 |
| Liquid Glass Vue（主） | mianbeishiwole/Liquid-Glass-Vue | ✅ 存在 | 2026-06-16 | Vue | **不可安装**，仅抄 CSS 变量设计 |
| Liquid Glass Vue（备） | WXperia/liquid-glass-vue | ✅ 存在 | 2025-07-04 | TypeScript | 可安装但未采用，见 §四 |
| ArkWeb 套壳框架 | zhubowen-bot/Bowen_ArkWeb_framework | ✅ 存在 | 2026-07-17 | TypeScript | 本批不动，记录备用 |

**6/6 全部存在**，无项目需要跳过。

---

## 二、synap.md（monorepo 结构参考）

- 定位：自托管 Markdown 笔记应用，Nuxt 4 + Vue 3 + Tauri 2，vault-based（磁盘 `.md` 是唯一真相来源，SQLite 只做索引）。
- 实际仓库规模：438 个文件。

### 目录结构（直接抄的部分）

```
apps/
  desktop/        Tauri 桌面端
  web/            主 Web 端
packages/
  config-tailwind/    共享构建配置
  design-tokens/      设计令牌（颜色/间距/圆角），导出 TS 常量
  editor-core/        共享编辑器扩展
  store/              共享 Pinia stores（api.ts + stores/*.ts）
  ui-vue/             共享 Vue 组件
  i18n/
pnpm-workspace.yaml
turbo.json
```

### 直接抄

- `pnpm-workspace.yaml` 的 workspace 声明方式：
  ```yaml
  packages:
    - 'apps/*'
    - 'packages/*'
  ```
- **packages 内包不走构建产物，直接暴露 TS 源码**（`main` / `types` / `exports` 全指向 `./src/index.ts`）。
  例：`@synap/store` 的 `package.json` 里 `"main": "./src/index.ts"`、`"exports": { ".": "./src/index.ts" }`，
  Vue/Pinia 只声明为 `peerDependencies`。→ 本项目 `packages/shared` 采用同一做法（免构建、免 d.ts 生成管线）。
- `packages/design-tokens`：设计令牌集中导出 TS 常量，而非散落 CSS。→ 本项目收敛为 `packages/shared` 中的类型 + `apps/web/src/styles/tokens.css`。
- 包命名加 scope（`@synap/*`）→ 本项目用 `@noteapp/*`。

### 需要适配 / 不适用

- Nuxt 相关（`@pinia/nuxt`、`nuxt-auth-utils`、`@vite-pwa/nuxt`）→ 不适用，本项目改用 Vite + vue-router 手工装配。
- Turborepo（`turbo.json`）→ **不引入**。本项目只有 3 个 workspace，pnpm 自带 `-r` 足够，多一层构建编排是纯负担（简单优先）。
- synap.md 的 `postinstall: nuxt prepare` 之类副作用脚本 → 不适用。
- synap.md 踩过的坑值得记：workspace 内 **Vue/Pinia 必须全局只有一份物理实例**，否则 `getActivePinia()` 报错。
  它在 `pnpm-workspace.yaml` 用 `overrides: { vue>typescript, pinia>typescript }` 收敛可选 peer 边。
  → 本项目只用**一份**根级 `typescript` 版本，避免同类问题。

---

## 三、FlareMo（多租户 + D1 参考）

- 定位：Cloudflare 原生团队知识库，提供 Memos 兼容 API 与 MCP 协议。305 stars，1329 文件，Drizzle ORM + better-auth。
- 数据模型要点（读 `migrations/0000_*.sql`）：
  - 表命名 snake_case；主键统一 `id text PRIMARY KEY`。
  - **外键带明确级联语义**：`ON DELETE cascade`（从属数据）/ `ON DELETE set null`（可选引用）。
  - **软删除用 `deleted_at text`（可空）**，不用布尔位 —— 与本项目 `notes.deleted_at` 一致。
  - 删除状态与业务状态分离：`visibility`（private/…) 与 `status`（normal/…）分列。
  - 复合索引按查询形态建：`memos_user_status_created_idx (user_id, status, created_at)`。
  - 预留 `payload text DEFAULT '{}'` 扩展列，避免频繁加迁移。
  - 分享表：`shares(memo_id, user_id, token UNIQUE, expires_at)` → 与本项目 `shares` 设计一致（本项目用 `slug`，语义相同）。
- **多租户形态不同**：FlareMo 是 `user_id` 单列作用域（单用户私密空间）+ team mode；**没有 tenant_id**。
  → 因此本项目**不抄**它的权限模型，改为 `tenant_id` + `tenant_members` 关联表（见任务书 schema）。
  这样单人期与团队期是同一套查询（恒带 `WHERE tenant_id = ?`），换实现最省。
- **Drizzle ORM 不引入**：本项目 SQL 手写 + `wrangler d1 execute`，schema 只有 10 张表，ORM 的迁移管线收益不抵复杂度。

### 直接抄

- D1 建表 SQL 的书写风格（反引号列名、`statement-breakpoint` 分句、索引紧跟建表）。
- 外键级联的取舍规则（cascade vs set null）。
- 软删除列可空语义。
- monorepo 里 worker 的 wrangler 配置**提在仓库根、子包用 `--config ../../wrangler.toml` 指回**：
  `"dev": "wrangler dev --config ../../wrangler.jsonc"` → 与本项目「wrangler.toml 只保留根目录一份」的要求完全一致，照抄。

---

## 四、Liquid Glass Vue（UI 参考）—— 结论：主项目不可安装，采用自实现 CSS

核实结果：

| 包/仓库 | 状态 | 结论 |
|---|---|---|
| 仓库 `mianbeishiwole/Liquid-Glass-Vue` | 存在，`package.json` 里 **`"private": true`**、version 0.1.0 | **未发布到 npm**，无法作为依赖安装 |
| npm `liquid-glass-vue` | 存在但为 **v0.0.1，无 repository、无 description**，与上述仓库无关联 | **不是**该参考项目，不采用 |
| 仓库 `WXperia/liquid-glass-vue` → npm `@wxperia/liquid-glass-vue` | 存在，v1.0.9，MIT，公开可装 | 可装，但**未采用**（理由见下） |

**未采用 `@wxperia/liquid-glass-vue` 的理由**：它是 WebGL/Canvas 着色器实现的液态玻璃折射效果，
需要真实渲染上下文与逐帧计算；本批只有登录卡片一处玻璃层，用它在低端设备上属于任务书明令避免的
「复杂动画 + 掉帧」风险，且与「低端设备自动降级」条款冲突。

**采用方案**：自实现纯 CSS 毛玻璃，**CSS 变量体系直接抄主项目 `src/styles/glass.css` 的设计**：

```css
--glass-blur / --glass-saturation / --glass-radius / --glass-thickness
--glass-refraction / --glass-light-angle / --glass-tint
--glass-highlight-top / --glass-highlight-edge / --glass-inner-shadow
--glass-transition: 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)
```

关键可抄结构（原文）：
- `.glass` 用 `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation))` + 1px 半透明边框 + 内外阴影双叠。
- `::before` 铺 `--glass-highlight-top` 对角高光渐变、`pointer-events: none`，**高光层不参与交互** —— 这个模式照抄。
- 过渡曲线 `cubic-bezier(0.34, 1.56, 0.64, 1)` 与任务书「弹簧曲线」要求一致，直接沿用。

### 需要适配

- 主项目默认色板是 iOS 蓝（`--glass-primary: #007aff`）→ 本项目强调色改为 `#5BA88C`（青绿），全站统一。
- 主项目 `* { margin: 0; padding: 0; box-sizing: border-box }` 全局重置 → 只在 `apps/web/src/styles/base.css` 里做等价 reset，不动第三方作用域。
- 任务书本项目背景为 `#0A0E14`（冷调深空黑），比主项目的浅色玻璃暗得多 → `rgba(255,255,255,0.08)` 级别的高光才成立，已按任务书取值。

---

## 五、Obsttorte（Cloudflare 同步架构参考）—— 本批只记录

- 定位：把 Obsidian vault 通过自建 Cloudflare 服务在多设备同步。Task: 逐文件三方合并 + 冲突解决 UI + 可恢复版本历史。
- 结构（154 文件）：`packages/engine`（同步内核，`merge/text.ts`、`merge/json.ts`、`merge/canvas.ts` 按类型分派三方合并）、
  `packages/server`（Workers 侧）、`packages/cli`、`packages/plugin`（Obsidian 插件）、`packages/shared`。
- **可抄的架构点（第二阶段用）**：
  1. **每台设备独立 device token**，服务端只存 `token_hash`（sha256），**明文不落库**，撤销走 `revoked_at`。
     → 本项目 `sessions.token` 当前存明文 64 hex；第二阶段加多设备时改成存 hash。**本批先记录不改**（避免超出任务书范围）。
  2. 认证中间件返回统一错误体 `apiError(code, message)` + 失败计数限流（按 `CF-Connecting-IP`），命中上限回 `429` + `Retry-After`。
     → 本项目统一错误体与限流中间件采用同一形态（任务书也要求 `{ success:false, error:{code,message} }`）。
  3. `last_seen_at` 这类高频写字段**做节流更新**（`LAST_SEEN_UPDATE_INTERVAL_MS`），并用 `executionCtx.waitUntil` 异步落库，不阻塞响应。
  4. 统计 D1 读写量：`D1Result.meta.rows_read / rows_written` 逐语句累加 —— 免费层额度监控的现成做法。
- **不适用**：Obsttorte 需要 Workers Paid；本项目前期 D1 + Workers 免费层足够（认证场景远未触顶），不付费。
- 本批不写同步代码，以上仅为第二阶段（笔记 CRUD / 同步）预埋。

---

## 六、ArkWeb 套壳框架（备用，本批不动）

- `zhubowen-bot/Bowen_ArkWeb_framework`：用 ArkWeb 把 HTML 直接打成鸿蒙 HAP，封装了系统控件、主题色、应用跳转。
- 与后续「鸿蒙打包」批次相关，本批**仅记录**，不做任何集成。

---

## 七、对本项目技术选型的净影响

| 决策点 | 结论 | 来源 |
|---|---|---|
| monorepo 工具 | pnpm workspace，**不引入 Turborepo** | synap.md 精简 |
| packages 内包分发方式 | 直接暴露 TS 源码，免构建 | synap.md |
| 包 scope | `@noteapp/*` | synap.md |
| wrangler 配置位置 | **仓库根唯一一份**，子包 `--config` 指回 | FlareMo |
| ORM | **不用**，手写 SQL | FlareMo 对比后否 |
| 多租户模型 | `tenant_id` + `tenant_members`（**不抄** FlareMo 的 user_id 模型） | FlareMo 对比后改 |
| 软删除 | 可空 `deleted_at` 时间戳 | FlareMo |
| 毛玻璃 UI | **自实现 CSS**，抄 `--glass-*` 变量体系 | Liquid-Glass-Vue 主项目不可装 |
| 设备 token 存 hash | 第二阶段改，本批记录 | Obsttorte |
