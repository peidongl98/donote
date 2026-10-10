# 存储适配器设计（批次 1a）

> 目标：把「直接调 WebDAV」收进一个可替换的适配器，为将来接入非 WebDAV 的后端留出口。
> 本轮**只做抽象，不换后端、不改用户可见行为**。
> 完成 1a 后紧接着做了一次收口：服务器从「写死坚果云」改为「任意 WebDAV」（见第七节）。

## 一、分层

```
视图层（views/*.vue）
   ↓  只认 notesApi / foldersApi 的 DTO
业务层（storage/notes.ts）
   ↓  路径与命名规则、目录遍历与缓存、DTO 组装、搜索
适配器层（services/storage/）
   ↓  StorageAdapter 接口 + WebdavAdapter 实现；唯一的 HTTP 发起方
传输层（storage/transport.ts）
   ↓  端上 → tauri-plugin-http（Rust reqwest）；dev → Vite 同源代理 /nutdav
用户自己的 WebDAV 服务器
```

改造前，前两层是混在一起的：`storage/notes.ts` 里既有业务逻辑，也内嵌了 PROPFIND / GET / PUT / MKCOL / DELETE / MOVE 六个原语；`storage/webdav.ts` 另有一份连接探测。现在这些全部收进 `services/storage/webdav.ts`。

**新增**
- `apps/web/src/services/storage/types.ts` — 接口与类型
- `apps/web/src/services/storage/webdav.ts` — WebDAV 实现（唯一的 HTTP 落点）
- `apps/web/src/services/storage/index.ts` — 当前适配器的注册与获取

**改造**
- `apps/web/src/storage/notes.ts` — 去掉内嵌原语，改调适配器；业务逻辑未动
- `apps/web/src/stores/webdav.ts` — 连接成功后创建并注册适配器；断开时注销

**删除**
- `apps/web/src/storage/webdav.ts` — 内容已被适配器完全吸收，无残留引用

## 二、接口

```ts
interface StorageAdapter {
  readonly kind: StorageKind;

  connect(config: StorageConfig): Promise<ConnectResult>;
  adopt(config: StorageConfig): void;      // 接口外，见「刻意的偏离」
  disconnect(): Promise<void>;
  testConnection(): Promise<boolean>;

  read(path: string): Promise<string>;
  write(path: string, content: string, etag?: string): Promise<WriteResult>;
  delete(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  list(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;  // 接口外，见「刻意的偏离」
  batch(operations: BatchOperation[]): Promise<BatchResult[]>;
}
```

**路径约定**：所有 `path` 都是**相对同步根**的路径（`''` 是同步根本身，`工作/周报.md` 是下面一篇笔记），不以 `/` 开头。这与改造前的 `rel` 完全一致，是业务层几乎不用改的原因。适配器内部负责拼成绝对地址并逐段 URL 编码。

**凭据**：适配器不持久化凭据，只接收上层通过 `connect(config)` / `adopt(config)` 注入的副本。持久化仍在系统凭据管理器（`storage/secret-store.ts` → Tauri keyring）。

**服务器地址**：`StorageConfig.baseUrl` 由上层注入，默认 `https://dav.jianguoyun.com/dav`（`DEFAULT_BASE_URL`），用户在连接页可改。适配器不判断是哪一家服务。

## 三、batch 的真实能力（重要）

**WebDAV 没有原生批量写接口**（不像 S3 的 `POST /?delete`），所以 `batch` 做不到「把 N 次请求合并成 1 次」。它实际解决的是三件事：

1. **串行执行** —— 并发恒为 1，不容易撞上服务端的并发限流
2. **同批次内重复的 `mkdir` 只发一次**
3. **单条失败不中断整批**，按序返回每条结果，由调用方决定怎么处理

真正的请求减少要靠上层少调接口（例如复用一次目录遍历的结果）。这一点在设计上不能含糊，否则后续会误以为 batch 能省请求。

`batch` 目前**没有业务调用方**，是为将来的批量移动 / 批量删除预留的入口。

## 四、与改造前的逐条对应

| 改造前 | 改造后 | 发出的请求 |
|---|---|---|
| `notes.ts` `propfindDir(rel)` | `adapter.list(rel)` | `PROPFIND` Depth:1（同） |
| `notes.ts` `getText(rel)` | `adapter.read(rel)` | `GET`（同） |
| `notes.ts` `putText(rel, t)` | `adapter.write(rel, t)` | `PUT`（同） |
| `notes.ts` `mkcol(rel)` | `adapter.mkdir(rel)` | `MKCOL`（同） |
| `notes.ts` `ensureDir(rel)` | `adapter.ensureDir(rel)` | 逐级 `MKCOL`（同） |
| `notes.ts` `removeFile(rel)` | `adapter.delete(rel)` | `DELETE`（同） |
| `notes.ts` `moveEntry(f, t)` | `adapter.move(f, t)` | `MOVE` + `Destination` + `Overwrite: F`（同） |
| `webdav.ts` `probeConnection()` | `adapter.connect()` 内部 | `PROPFIND` Depth:0（同） |
| `webdav.ts` `ensureRoot()` | `adapter.connect()` 内部 | `MKCOL`（同） |
| — | `adapter.stat()` | 新增，业务未调用 |
| — | `adapter.batch()` | 新增，业务未调用 |

请求的 method / header / body 逐条一致，没有引入新的请求模式。
唯一例外是 `Authorization` 头的生成方式：从 `btoa(account:password)` 改为先按 UTF-8 编码再 Base64。
纯 ASCII 凭据（坚果云邮箱 + 应用密码）产出的字节完全相同，改的是非 ASCII 账号不再抛
`InvalidCharacterError`（自建服务常见中文用户名）。

## 五、刻意的偏离与理由

1. **`connect` 返回 `ConnectResult` 而不是 `void`**
   上层要提示「已连接，并建好了同步目录」，这个信息只有适配器知道。

2. **接口外多两个方法：`adopt()` / `ensureDir()`**
   `adopt()`：启动时从系统凭据恢复连接态。凭据在连接那一刻已校验过，每次启动再打一次探测是白耗限流配额（坚果云 30 分钟 600 次）。
   `ensureDir()`：业务层原本就依赖「逐级建目录」，把它提进接口比让每个调用方自己循环更省事。

3. **`read` 的 404 语义**：适配器抛 `StorageError('not_found')`，业务层的 `readOrNull()` 翻译回 `null`。对视图层的结果完全一致。

4. **网络异常统一翻译**：改造前 `propfindDir` 有 try/catch、`getText` 没有；现在统一由适配器的 `send()` 包装成 `StorageError('unreachable')`。错误类型变了，但都是抛错，调用方的 catch 行为不变，且提示更可读。

5. **`etag` 通道预留但未启用**：`FileStat.etag` 恒为 `''`，`write(path, content, etag?)` 收到 etag 也不发 `If-Match`。启用需要改 PROPFIND 的 property 列表，属于网络行为变更，留到真正做冲突处理时再开。

6. **没有目录缓存**：`mkdir` 逐级发请求、不做跨调用缓存。缓存能省请求，但会在「目录被外部删掉」时给出错误判断，风险大于收益。仅在 `batch` 的单批次范围内做去重。

## 六、还没做

- 非 WebDAV 的后端（Seafile 的原生 API、对象存储 COS）。目前 `StorageKind` 只有 `'webdav'`；
  WebDAV 家族的服务器不需要新适配器，只需在连接页填不同地址。
- etag 与乐观锁、多设备冲突处理。
- 请求合并（受 WebDAV 协议限制，见第三节）。

## 七、多服务器支持（1a 收口）

连接页从「坚果云账号 + 应用密码」改为「**服务器地址 + 账号 + 密码**」，默认地址仍是坚果云。
改动分三处，缺一处「WebDAV 都 OK」就只是句空话：

1. **连接页与引导**：`LoginView.vue` 增加服务器地址字段并校验必须为 http/https；
   `WebdavGuide.vue` 按地址给不同说明 —— 坚果云地址给获取应用密码的五步，其它地址给通用提示。
2. **适配器**：`kind` 由 `'jianguoyun'` 改为 `'webdav'`，类名 `JianguoYunAdapter` → `WebdavAdapter`。
   dev 下的同源代理只对 `dav.jianguoyun.com` 生效（Vite 代理目标写死），填别的地址在浏览器里
   直连失败属预期；端上不受影响。
3. **桌面端域名白名单**：`src-tauri/capabilities/default.json` 从只放行
   `https://dav.jianguoyun.com/*` 改为 `https://*:*` + `http://*:*`。

### 白名单为什么必须写端口通配

URL Pattern 规范里，构造串没写端口时端口默认是**标准端口**，不是通配。实测（真实 Chromium）：

| 模式 | `https://nas.local:8443/...` | `http://192.168.1.5:5005/...` |
|---|---|---|
| `https://*/*` | 拦下 | 拦下 |
| `https://*:*` | 放行 | 拦下 |
| `http://*:*` | 拦下 | 放行 |
| `*://*:*/*` | 放行 | 放行 |

自建 NAS / 内网服务器普遍带自定义端口，所以必须用 `https://*:*` + `http://*:*` 两条，
而不是看起来更「安全」的 `https://*/*`。用两条而不是 `*://*:*/*`，是为了把协议收窄到 http/https。

**代价要写清楚**：白名单放宽后，应用能访问任意 http/https 地址。这是「连用户自己指定的服务器」
这类客户端的固有代价 —— 地址本身就是用户填的。缓解手段是：应用只在用户点连接时向该地址发请求，
不向任何其它地址外发内容。
