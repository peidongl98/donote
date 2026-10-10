# DoNote 方案文档 · BYOS 架构

> 版本 v1 ｜ 2026-10-10 ｜ 状态：**待评审**
> 本方案取代上一版「云端账号 + 多租户 + 分享服务」架构。被取代的部分见 §9。

---

## 0. 一句话

DoNote = **本地优先的 Markdown 笔记客户端**。

数据存在用户自己的坚果云里，同步交给坚果云的同步能力，分享靠导出一个自包含的 HTML 文件。
**DoNote 自己不提供服务端、不收集用户数据、不收费。**

---

## 1. 三条已定的决定

| # | 决定 | 连带结果 |
|---|---|---|
| 1 | 存储走 **BYOS**（用户自带存储 = 坚果云） | 不需要 DoNote 账号体系、不需要数据库、不需要短信凭证 |
| 2 | 分享 = **导出单文件 HTML** | 不需要分享服务、不需要静态托管、不依赖坚果云外链 |
| 3 | 分发 = 三端壳（Windows PC / 鸿蒙手机 / iOS） | Windows 无门槛；鸿蒙、iOS 需过应用市场审核 |

---

## 2. 目标架构

```
┌──────────────────────────────┐
│      DoNote 客户端（Vue 3）    │
│  Windows: Tauri 2            │
│  鸿蒙手机: ArkWeb 壳          │
│  iOS: Tauri 2 iOS 目标        │
└───────────┬──────────────────┘
            │  storage 适配层  ← 本次改造的核心
            │
   ┌────────┼────────────┬──────────────┐
   ▼        ▼            ▼              ▼
本地文件夹   WebDAV      File System     （未来可加）
(Tauri FS)  (原生网络栈)  Access API
   │        │            │
   │        └────────────┴──► 坚果云（用户自己的账号）
   │
   └──► 用户自己用坚果云客户端同步该文件夹

导出分享：笔记 ──► 单文件 HTML ──► 用户自己发出去（不经过 DoNote）
```

关键点：**三种存储实现共用同一个接口**，视图层不关心数据在哪。

| 端 | 存储实现 | 为什么 |
|---|---|---|
| Windows PC | 本地文件夹（Tauri FS） | 零 WebDAV 代码；离线体验最好；用户在坚果云客户端把该文件夹设为同步目录即可 |
| 鸿蒙手机 | WebDAV 直连 | 移动端没有「用户选文件夹」的通用能力，只能走 WebDAV |
| iOS | WebDAV 直连 | 同上 |
| 开发调试（浏览器） | File System Access API | Chromium 系可让网页访问本地文件夹 → 不用装壳就能开发调试 |

---

## 3. 文件模型

```
<坚果云同步根>/
└── DoNote/                        ← 用户自建，DoNote 只在里面活动
    ├── index.json                 ← 索引缓存（不是真相）
    ├── 教学/                       ← 目录即文件夹
    │   ├── 课堂记录.md
    │   ├── 课堂记录.assets/        ← 这篇笔记的附件，与笔记同级同名
    │   │   └── 课本地图.png
    │   └── 地理校本课程.md
    ├── 散记.md
    ├── 散记.assets/
    │   └── 手写稿.jpg
    └── .trash/                    ← 删除的笔记移到这里，附件目录一起搬过来
```

单篇笔记的 frontmatter：

```markdown
---
id: n_7f3c9a2b          # 稳定标识，改名不变
title: 课堂记录
created: 2026-10-10T09:12:00+08:00
updated: 2026-10-10T14:30:00+08:00
tags: [教学, 地理]
---

正文……
```

设计规则：

| 规则 | 理由 |
|---|---|
| **一篇笔记 = 一个 `.md`** | 用户拿 U 盘拷走就能用；任何 Markdown 工具都能读 |
| **文件夹 = 真目录** | Obsidian / VS Code / Typora 可直接打开；不搞私有结构 |
| **`id` 才是身份，标题只是显示** | 改名不必担心引用失效 |
| **附件住同级同名的 `.assets/` 目录** | `课堂记录.md` 配 `课堂记录.assets/`。笔记与附件一起搬、一起删、一起恢复；用户单独拿走一个 `.md` 也不会认错归属。目录内部**只平铺、不递归** |
| **正文里的附件引用写相对路径** | 形如 `课堂记录.assets/课本地图.png`。不用绝对路径、不用 `./` 前缀、不用仓库根路径 —— 拷到别处仍然能显示 |
| **删除 = 移到 `.trash/`** | 不是改字段。用户在坚果云里也能自己捞回来 |
| **`index.json` 是缓存不是真相** | 启动只读它（1 次请求）→ 列表秒开；对不上就扫描目录重建 |
| **冲突处理：`updated` 新的胜出** | 旧的另存 `xxx.conflict-20261010-1430.md`，不静默丢数据 |

`index.json` 为什么必须有：坚果云免费版限制 **每 30 分钟 ≤600 次请求**、**单次列目录 ≤750 条**。
每开一次 App 就全量扫目录会直接撞限流。

---

## 4. 前端改造清单

| 类别 | 具体内容 |
|---|---|
| **新增** | `storage/types.ts`（`listNotes` / `readNote` / `writeNote` / `deleteNote` / `restoreNote` / `listFolders` / `createFolder` / `moveNote`）<br>`storage/local-folder.ts`（Tauri FS）<br>`storage/webdav.ts`（PROPFIND / GET / PUT / DELETE / MKCOL）<br>`storage/fsa.ts`（File System Access API，供浏览器开发）<br>`export/html.ts`（markdown-it 渲染 + CSS 内联 + 图片转 data URI）<br>设置页「同步」区块（地址 / 邮箱 / 应用密码；凭据存系统安全存储） |
| **替换** | 8 个视图里 `api/resources.ts` 的调用点 → 换成 storage 接口。**视图结构与样式不动** |
| **删除** | `stores/auth.ts`、`views/LoginView.vue`、`views/PublicShareView.vue`、`api/resources.ts`、auth 相关路由 |
| **保留不动** | `apps/api/`（废弃但**不删**，将来做云端版还能捡回来）；`components/`、`styles/`、`utils/` 全部保留 |

凭据存储（**不存 localStorage / 不存明文**）：

| 端 | 方案 |
|---|---|
| Windows | `keyring` crate → Windows Credential Manager |
| 鸿蒙 | `@kit.AssetStoreKit`（`@ohos.security.asset`，API 11+，HUKS + TEE 加密，单条上限 1024 字节） |
| iOS | Keychain |

---

## 5. 已核实的平台事实

| 事实 | 来源 | 状态 |
|---|---|---|
| 坚果云 WebDAV 地址 `https://dav.jianguoyun.com/dav/`；账号 = 注册邮箱，密码 = 应用密码 | 官方帮助 | **实测通过**（PROPFIND 207 / PUT 201） |
| 浏览器直连坚果云被 CORS 拦死（无 `Access-Control-Allow-Origin`） | 实测 | **已确认** |
| 坚果云**没有**公开的开放平台 / 分享 API | 实测 | **已确认**（`/developer-api`、`/developers`、`/open`、`/api`、`open.jianguoyun.com` 全 404） |
| 免费版限流：每 30 分钟 ≤600 次请求；单次列目录 ≤750 条；单文件上传 ≤500MB | 官方帮助 | 已核实 |
| WebDAV 与微信二次验证冲突，需先在网页端关掉才能用 | 官方帮助 | 已核实 |
| 外链格式 `https://www.jianguoyun.com/s/xxxx`，只能网页/客户端手动创建 | 官方帮助 + RFC 4918 | 已核实 |
| 鸿蒙 `Web` 组件 + `ohos.permission.INTERNET` 可加载线上 H5 | 华为文档 | 已核实 |
| 鸿蒙 `@kit.AssetStoreKit` 专为凭据设计 | 华为文档 | 已核实 |
| Apple 审核指南 **4.2** 拒绝「简单打包网页」 | Apple 文档 | 已核实 |
| 本机网络 `*.workers.dev` 不可达 | 本机实测（早前） | 已核实 |

---

## 6. 三端交付路线

| 端 | 壳 | 存储 | 门槛 |
|---|---|---|---|
| **Windows PC** | Tauri 2 → `.exe` / `.msi` | 本地文件夹 | **无**。随便分发 |
| **鸿蒙手机** | ArkWeb 壳（ArkTS 工程 + `Web` 组件 + `javaScriptProxy` 原生桥） | WebDAV 直连 | 开发者实名 → 受邀名单 → APP 备案 → 上架审核 |
| **iOS** | Tauri 2 iOS 目标 / WKWebView 壳 | WebDAV 直连 | 付费开发者账号 + 过 4.2 |

**顺序建议：Windows → 鸿蒙 → iOS。**
Windows 打完就能真用，且不依赖任何资质；鸿蒙和 iOS 都要等审核。

⚠️ **纯网页版（`donote.pages.dev`）不再是产品形态** —— 浏览器连不上坚果云（CORS），网页版没有存储能力。它可以留作「导入 / 导出」的轻量工具页，但不是主产品。

---

## 7. 上架与资质

已核实：

- 华为应用市场要求提供 **APP 备案号**
- **个人主体不能从事经营性互联网信息服务** —— 想收费需公司主体 +《增值电信业务经营许可证》（ICP 经营许可证，注册资本 ≥ 100 万）。**个人和个体工商户都办不了**
- Apple **5.1.1(v)** 要求 App 内可删账号 —— 本方案**不做账号**，这条天然不适用

**待核实（本方案的最大不确定项）：**

1. **没有自有服务端的 App，是否仍需要 APP 备案？** 如果需要，备案表里的「服务器域名」怎么填——坚果云算不算「第三方 SDK 的域名」？两种说法都找不到明确条文。
   → **建议直接问腾讯云备案客服 + 华为开发者客服**，不要替自己做假设。
2. 2026 年鸿蒙「应用创建受邀名单」的当前状态（此前查到的信息是需发邮件至 `agconnect@huawei.com` 申请，3–5 个工作日）。
3. 鸿蒙审核对「App 内展示用户动态内容」的限制（思源笔记的插件集市因审核原因在 App 内不可用，是前例）。

---

## 8. 待拍板

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 文件夹用**真目录**还是 frontmatter 字段？ | 真目录（Obsidian 兼容，用户可直接用别的工具打开） |
| 2 | 桌面端用**本地文件夹**还是 WebDAV 直连？ | 本地文件夹（零 WebDAV 代码，离线体验最好） |
| 3 | 导出的 HTML 写到哪？ | 每次让用户选路径（默认记住上次选的） |
| 4 | `.trash/` 保留多久？ | 永久保留（反正占的是用户自己的空间），只提供「清空」按钮 |

---

## 9. 已废弃部分

以下为上一版架构的产物，本方案不再使用。**代码先保留在仓库，不删。**

| 废弃项 | 位置 |
|---|---|
| 多租户 D1 数据库（10 张表） | `apps/api` + `donote-db` |
| 手机号 + 短信验证码登录 | `apps/api/src/routes/auth.ts`、`stores/auth.ts`、`LoginView.vue` |
| 腾讯云短信 5 项凭证 | 不再需要（原本是登录的阻塞项） |
| 分享服务（`shares` 表、公开分享页、410 Gone 语义） | `apps/api/src/routes/shares.ts`、`PublicShareView.vue` |
| Cloudflare Workers 部署链 | `wrangler.toml` |
| 「迁腾讯云 + ICP 备案」这条链 | 前提可能不成立，见 §7 待核实 1 |

---

## 10. 参考

- 坚果云帮助中心：WebDAV 授权、预览格式、限流
- 华为开发者文档：ArkWeb `Web` 组件、Asset Store Kit
- Apple App Store Review Guidelines 4.2 / 5.1.1
- 同赛道先例：思源笔记（本地优先 + WebDAV 同步）、Joplin、Obsidian（Remotely Save）
