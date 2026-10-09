# noteapp

多端 Markdown 笔记工具（未来商业化 SaaS）。初期单人使用，架构从第一天按多租户设计。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vite 8 + Vue 3.5 + TypeScript + Vue Router 5 + Pinia 4 |
| 后端 | Cloudflare Workers + Hono 4 |
| 数据库 | Cloudflare D1（SQLite） |
| 短信 | 腾讯云短信（TC3-HMAC-SHA256 签名） |
| 部署 | GitHub + Cloudflare Pages（前端）+ Workers（后端） |

UI 为自实现纯 CSS 毛玻璃（变量体系参考 `mianbeishiwole/Liquid-Glass-Vue`，该项目 `private: true` 未发布）。

## 目录结构

```
NoteApp/
├── apps/
│   ├── web/                    Vite + Vue 3 前端
│   │   ├── functions/api/[[path]].ts   Pages Function：/api/* 同源反代到 Worker
│   │   └── src/{views,components,stores,router,api,styles}
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

本地无需任何外部凭证：`TENCENT_SECRET_ID` 缺失时后端自动进入 dev 模式，
`/auth/send-code` 直接把验证码以 `devCode` 字段回传，登录页会展示并支持一键填入。

## 数据库

D1 库 `noteapp-db`，id `27114cad-81b3-4d3b-8bf2-080545d49a4e`。

```bash
pnpm db:local    # 本地
pnpm db:remote   # 线上
```

10 张业务表：`users` / `tenants` / `tenant_members` / `phone_codes` / `sessions` /
`notes` / `folders` / `shares` / `sms_logs` / `audit_logs`。

多租户约定：**所有业务表带 `tenant_id`，所有查询恒带 `WHERE tenant_id = ?`**。
软删除用可空的 `deleted_at` 时间戳。分享行不随笔记软删除而删除（软删除期间分享页统一返回 `410 Gone`）。

## API

全部版本化在 `/api/v1` 下。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 健康检查，返回当前 `ENVIRONMENT` |
| POST | `/api/v1/auth/send-code` | 发送验证码（三条防刷阈值） |
| POST | `/api/v1/auth/verify` | 校验并登录/注册，返回 30 天 session token |
| GET | `/api/v1/auth/me` | 取当前 user + tenant |
| POST | `/api/v1/auth/logout` | 销毁 session |

成功响应扁平：`{ "success": true, ... }`；失败统一：`{ "success": false, "error": { "code", "message" } }`。

防刷阈值（同手机号 60 秒 1 次 / 24 小时 10 次，同 IP 1 小时 20 次）与验证码有效期、锁定规则
集中在 `packages/shared`，前后端共用同一份常量。

## 环境变量

写在根目录 `wrangler.toml` 的 `[vars]` / `[env.production.vars]`；敏感凭证用
`wrangler secret put` 或改由 CI 注入，**不写进仓库**。

| 变量 | dev | production |
|---|---|---|
| `ENVIRONMENT` | `dev` | `production` |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Pages 域名 |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 可缺省（触发 dev 降级） | **必填** |
| `TENCENT_SMS_SDK_APP_ID` / `TENCENT_SMS_SIGN_NAME` / `TENCENT_SMS_TEMPLATE_ID` | 可缺省 | **必填** |

环境判断一律用 `env.ENVIRONMENT`，**不要用 `NODE_ENV`**（Workers 运行时不存在）。
生产环境缺凭证时接口返回 `sms_not_configured`，**不会**退回 dev 模式。

## 部署

```bash
# 后端（独立 Worker）
pnpm deploy:api:prod

# 前端（Pages，含 /api 反代 Function）
cd apps/web && pnpm build && wrangler pages deploy dist --project-name noteapp --branch main

# 推送到 GitHub（本机 github.com 直连不可用，走 api.github.com）
git -c core.quotepath=false ls-files --cached -z > "$TMPF"
PUSH_FILE_LIST="$TMPF" node scripts/push-to-github.cjs --owner peidongl98 --repo noteapp --branch main
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
2. **`pnpm install`**：本机 esbuild/workerd 的 postinstall 会因 `spawnSync EBUSY` 报错，
   用 `--ignore-scripts`；二进制来自 `@esbuild/win32-x64` 与 `@cloudflare/workerd-windows-64`，实测可直接执行。
3. **`git push` 不可用**：本机 `github.com:443` 会触发 Git Credential Manager 弹窗并挂起，统一走
   `scripts/push-to-github.cjs`（Git Data API）。空仓库需先建一次占位提交，否则建 blob 报 409。
4. **`wrangler.toml` 不写 `account_id`**，由环境变量 `CLOUDFLARE_ACCOUNT_ID` 提供。
5. **多个 environment 时必须显式 `--env`**，否则 wrangler 会警告可能改错环境。

## 本批范围之外

PWA、笔记 CRUD 与 Markdown 渲染、文件夹管理、分享页 —— 均为第二阶段。
