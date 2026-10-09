# DoNote

DoNote —— 多端 Markdown 笔记工具（未来商业化 SaaS）。初期单人使用，架构从第一天按多租户设计。

线上：**https://donote.pages.dev**

## 功能

| 模块 | 状态 |
|---|---|
| 手机号验证码登录 / 注册（一码一用、错 3 次锁 10 分钟、三条防刷阈值） | 已上线 |
| 多租户数据隔离（一人一租户，预留 tenant_members 与 plan） | 已上线 |
| 笔记：新建 / 编辑（自动保存）/ 删除 / 回收站 / 恢复 / 彻底删除 | 已上线 |
| Markdown 渲染（markdown-it，禁用原始 HTML） | 已上线 |
| 文件夹：树形归类 / 重命名 / 删除时内容上移不丢 | 已上线 |
| 分享：公开链接 / 访问密码 / 有效期 / 撤销；软删除后统一 410 Gone | 已上线 |
| PWA（可添加到主屏，service worker 不缓存 `/api/*`） | 已上线 |
| 腾讯云短信真实发送 | **待配凭证**（未配置时仅测试账号与 dev 可用） |

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vite 8 + Vue 3.5 + TypeScript + Vue Router 5 + Pinia 4 + markdown-it |
| 后端 | Cloudflare Workers + Hono 4 |
| 数据库 | Cloudflare D1（SQLite） |
| 短信 | 腾讯云短信（TC3-HMAC-SHA256 签名） |
| 部署 | GitHub + Cloudflare Pages（前端）+ Workers（后端） |

UI 为自实现纯 CSS 毛玻璃（变量体系参考 `mianbeishiwole/Liquid-Glass-Vue`，该项目 `private: true` 未发布）。

## 目录结构

```
DoNote/
├── apps/
│   ├── web/                    Vite + Vue 3 前端
│   │   ├── functions/api/[[path]].ts   Pages Function：/api/* 同源反代到 Worker
│   │   ├── public/              PWA 图标（脚本生成的 PNG）
│   │   └── src/{views,components,stores,router,api,styles,utils}
│   └── api/                    Workers + Hono 后端
│       ├── schema.sql          D1 schema（幂等，可重复执行）
│       └── src/{routes,middleware,utils}
├── packages/shared/            前后端共享类型与常量（直接暴露 TS 源码，不走构建）
├── scripts/push-to-github.cjs  Git Data API 推送脚本
├── wrangler.toml               唯一一份配置（含 [env.production]）
└── pnpm-workspace.yaml
```

## 本地开发

```bash
# 依赖（本机 esbuild postinstall 会因 spawnSync EBUSY 失败，需 --ignore-scripts）
pnpm install --ignore-scripts

# 首次：建本地 D1 表
pnpm db:local

# 两个终端分别启动
pnpm dev:api     # http://127.0.0.1:8787
pnpm dev:web     # http://localhost:5173（/api 由 Vite 代理到 8787）
```

本地不需要任何外部凭证：`TENCENT_SECRET_ID` 缺失时后端进入 dev 模式，
`/auth/send-code` 把验证码以 `devCode` 回传，登录页直接展示并支持一键填入。

## 测试账号（免短信登录）

短信凭证未配置时，用 `TEST_LOGIN_PHONES` 白名单给指定手机号开一条免短信通道：

- 服务端变量：`TEST_LOGIN_PHONES`（逗号分隔的 11 位手机号）
- **留空 = 完全关闭**，线上默认不配置即不存在这条通道
- 命中白名单的号码：跳过腾讯云，验证码仍随机生成、写库、5 分钟过期、校验通过即删（一码一用）
- 响应里多带 `devCode` 与 `testChannel: true`，前端照单展示

```bash
# 线上设置（值不入仓库，存在 Cloudflare）
printf '18617195056' | wrangler secret put TEST_LOGIN_PHONES --env production

# 关闭
wrangler secret delete TEST_LOGIN_PHONES --env production
```

## 数据库

D1 库 `donote-db`，id `eca2dcd8-9bab-4f6e-beac-dae4d126e8e0`。

```bash
pnpm db:local    # 本地
pnpm db:remote   # 线上
```

10 张业务表：`users` / `tenants` / `tenant_members` / `phone_codes` / `sessions` /
`notes` / `folders` / `shares` / `sms_logs` / `audit_logs`。

多租户约定：**所有业务表带 `tenant_id`，所有查询恒带 `WHERE tenant_id = ?`**。
软删除用可空的 `deleted_at` 时间戳。分享行不随笔记软删除而删除（软删除期间分享页统一返回 `410 Gone`），
只在笔记被**彻底删除**时级联清理。

## API

全部版本化在 `/api/v1` 下。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回当前 `ENVIRONMENT` |
| POST | `/auth/send-code` | 发送验证码（三条防刷阈值） |
| POST | `/auth/verify` | 校验并登录/注册，返回 30 天 session token |
| GET | `/auth/me` | 取当前 user + tenant |
| POST | `/auth/logout` | 销毁 session |
| GET | `/notes` | 列表：`folder_id`（缺省=全部 / `root` / id）、`q`、`trash=1`、`limit`、`offset`；只返回 120 字摘要 |
| POST | `/notes` | 新建 |
| GET | `/notes/:id` | 详情（含正文，回收站内也可读） |
| PATCH | `/notes/:id` | 更新 title / content / folder_id，`version` 自增 |
| DELETE | `/notes/:id` | 软删除；`?hard=1` 彻底删除并级联清理 shares |
| POST | `/notes/:id/restore` | 从回收站恢复 |
| GET | `/folders` | 文件夹平铺列表（带直系 `note_count`） |
| POST | `/folders` | 新建（可指定 `parent_id`） |
| PATCH | `/folders/:id` | 重命名 / 移动（成环返回 409） |
| DELETE | `/folders/:id` | 删除文件夹，其内容上移到父级（不删笔记） |
| POST | `/shares` | 创建分享（可带密码与有效期；重复分享复用同一条，slug 稳定） |
| GET | `/shares` | 我的分享列表（含笔记标题、查看次数、失效原因） |
| DELETE | `/shares/:id` | 撤销分享 |
| GET | `/public/shares/:slug` | 匿名读取；需要密码时 401 `password_required`；已删/过期 410 `gone`；撤销 404 |
| POST | `/public/shares/:slug` | 提交密码换内容 |

成功响应扁平：`{ "success": true, ... }`；失败统一：`{ "success": false, "error": { "code", "message" } }`。
所有 API 响应带 `Cache-Control: no-store`（原因见「已知陷阱」）。

## 环境变量

写在根目录 `wrangler.toml` 的 `[vars]` / `[env.production.vars]`；敏感值用
`wrangler secret put`，**不写进仓库**。

| 变量 | dev | production |
|---|---|---|
| `ENVIRONMENT` | `dev` | `production` |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | `https://donote.pages.dev` |
| `TEST_LOGIN_PHONES` | 可缺省 | 需要测试账号时设置（secret） |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 可缺省（触发 dev 降级） | **必填** |
| `TENCENT_SMS_SDK_APP_ID` / `TENCENT_SMS_SIGN_NAME` / `TENCENT_SMS_TEMPLATE_ID` | 可缺省 | **必填** |

环境判断一律用 `env.ENVIRONMENT`，**不要用 `NODE_ENV`**（Workers 运行时不存在）。
生产环境缺凭证时接口返回 `sms_not_configured`，**不会**退回 dev 模式。

## 部署

```bash
# 后端（独立 Worker）
pnpm deploy:api:prod

# 前端（Pages，含 /api 反代 Function + PWA 产物）
cd apps/web && pnpm build && wrangler pages deploy dist --project-name donote --branch main

# 推送到 GitHub（本机 github.com 直连不可用，走 api.github.com）
git -c core.quotepath=false ls-files --cached -z > "$TMPF"
PUSH_FILE_LIST="$TMPF" node scripts/push-to-github.cjs --owner peidongl98 --repo donote --branch main
```

### 为什么前端要经 Pages Function 反代

本机网络无法访问 `*.workers.dev`（实测该域连接失败，`*.pages.dev` 正常）。
若前端直接跨域调 Worker，用户侧会整站不可用。经 `functions/api/[[path]].ts` 同源反代后：

- 用户只需能访问 Pages 域名，不依赖 `workers.dev` 可达性
- 前后端同源，**完全不需要 CORS**
- 后端仍是独立部署的 Worker，反代层不含任何业务逻辑

## 已知陷阱

1. **`-webkit-backdrop-filter` 陷阱**：Vite 8 默认用 lightningcss 压缩 CSS，会把
   `backdrop-filter` 改写成只剩 `-webkit-` 前缀版本，Chromium 不认 → **线上毛玻璃整条失效**
   （dev 不压缩所以测不出来）。已在 `vite.config.ts` 设 `cssMinify: 'esbuild'` 规避。
   改样式后必须核验**构建产物**，不能只看 dev。
2. **410 会被浏览器启发式缓存**：410 Gone 属于 RFC 7234 允许启发式缓存的状态码。
   曾复现「笔记删除后访客看到已删除 → 恢复后访客刷新仍看到已删除」。
   已对所有 `/api/*` 加 `Cache-Control: no-store` 根治。
3. **编辑页加载竞态**：笔记详情是异步拉回来的，若输入框在加载完成前可编辑，
   用户先打的字会被服务端返回值覆盖。已让标题框在 `loading` 期间 `disabled`。
4. **`pnpm install`**：本机 esbuild/workerd 的 postinstall 会因 `spawnSync EBUSY` 报错，
   用 `--ignore-scripts`；二进制来自 `@esbuild/win32-x64` 与 `@cloudflare/workerd-windows-64`，实测可直接执行。
   **移动/重命名仓库目录后**必须删掉各级 `node_modules` 再装，否则会出现
   `Cannot find module 'undici' / '@volar/typescript'` 这类「装了但没装全」的症状。
5. **`git push` 不可用**：本机 `github.com:443` 会触发 Git Credential Manager 弹窗并挂起，统一走
   `scripts/push-to-github.cjs`（Git Data API）。空仓库需先建一次占位提交，否则建 blob 报 409。
6. **`wrangler.toml` 不写 `account_id`**，由环境变量 `CLOUDFLARE_ACCOUNT_ID` 提供。
7. **多个 environment 时必须显式 `--env`**，否则 wrangler 会警告可能改错环境。
8. **Cloudflare 的 Pages 项目与 D1 都不支持改名**，只能新建 + 重放 schema + 重新部署 + 删旧；
   Worker 删除要带 `?force=true`。
9. **PWA 的 `runtimeCaching` 必须排除 `/api/*`**（这里用 `NetworkOnly` + `navigateFallbackDenylist`），
   否则缓存会让认证与「已删除/已恢复」类状态失真。

## 下一步

- 补腾讯云短信 5 项凭证后打开真实短信登录（并删除 `TEST_LOGIN_PHONES`）
- 笔记版本历史（软删除期间保留的 shares 行可复用）
- 团队协作（`tenant_members` 与 `plan` 已预埋）
- 鸿蒙打包（ArkWeb 套壳方案，见 `docs/reference-notes.md`）
