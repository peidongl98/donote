# DoNote 文件夹与笔记文件模型（代码核实）

> 核实日期 2026-10-12｜基线：工作区代码 = 线上 0.2.3｜**只读核实，未改任何代码、未启动应用、未发网络请求**。
> 结论全部来自代码。行号对应当前工作区文件。
> 编号口径：**STATUS 表里的「批次」与仓库内部叫法差 1**（见 §5 对照表）。

---

## 1. 文件系统层实际结构

同步根默认 `/DoNote`（`apps/web/src/services/storage/types.ts:24`）。权威定义在 `apps/web/src/storage/notes.ts:1-14` 的文件头注释：

```
<同步根>/<文件夹…>/<标题>.md                 一篇笔记 = 一个 .md 文件
<同步根>/<标题>.assets/<文件名>             附件，与笔记同级同名
<同步根>/.trash/<时间>-<随机>-<标题>.md      软删
<同步根>/.trash/<时间>-<随机>-<标题>.assets/ 附件随笔记进回收站
```

### 1.1 文件夹是什么：**空目录**

`foldersApi.create()` → `getStorage().mkdir(rel)`（`storage/notes.ts:589-606`）→ WebDAV `MKCOL`（`apps/web/src/services/storage/webdav.ts:370-377`）。

`MKCOL` 之后**不写任何文件**。没有 `index.md`，也没有 `.keep` 之类的占位文件。全仓检索 `index.md` 只命中 3 处，且全部是文字（1 处代码注释 + STATUS.md），代码路径为 0（见 §5）。

`mkdir` 把 `201` 与 `405`（已存在）都当作成功（`webdav.ts:375`）。

### 1.2 笔记是什么：**纯 `.md` 文件**

- 文件名 = 标题经 `sanitize()` 处理后 + `.md`（`storage/notes.ts:61-64`、`:269-281`）。
- 只有 `.md` 结尾的**文件**算笔记（`storage/notes.ts:138`）；其它文件被忽略。
- 标题不能含 `/` `\` `:` `*` `?` `"` `<` `>` `|`，这些字符被换成 `-`；也不能以 `.` 开头；上限 60 字符（`sanitize()`，`storage/notes.ts:71-82`）→ **层级不能靠标题表达，只能靠移动**。

### 1.3 展示层跳过规则

`walkTree()`（`storage/notes.ts:116-147`）在遍历时跳过：

- 以 `.` 开头的目录（`.trash` 等）与文件；
- 名字以 `.assets` 结尾的目录（附件目录，约定平铺不递归）。

递归上限 `MAX_DIRS = 300`、`MAX_DEPTH = 8`（`storage/notes.ts:112-113`）；同层并发 4。

### 1.4 文件夹与笔记能否同名共存：**能**

`uniqueRel()` 按 `entry.name`（**含扩展名的完整名**）比较占用（`storage/notes.ts:269-281`）：

- 笔记占用的是 `框架笔记.md`
- 文件夹占用的是 `框架笔记`
- 两者 name 不同 → 不冲突

因此同一父目录下可同时存在两者。假想实例：

```
/DoNote
  框架笔记.md          ← 笔记，标题「框架笔记」
  框架笔记/            ← 文件夹，名称「框架笔记」（空目录）
    子笔记 A.md
  未命名.md
  未命名.assets/       ← 上面那篇笔记的附件目录
  .trash/
    1759…-a3f2-旧笔记.md
    1759…-a3f2-旧笔记.assets/
```

⚠️ UI 上没有消歧：`HomeView` 的卡片只显示标题，`FoldersView` 只显示目录名，两处都不带类型后缀（`views/HomeView.vue:146-154`、`views/FoldersView.vue:161-180`）。

### 1.5 两个与「文件夹」相关的实际行为

| 行为 | 代码 | 说明 |
|---|---|---|
| DoNote 内「删除文件夹」= **只解散** | `storage/notes.ts:627-642` | 先把子项逐个 `MOVE` 到父级（重名加后缀），再 `delete(目录)`。笔记不会丢。 |
| 直接在坚果云网页版删目录 | — | 里面的笔记会**跟着目录一起被删** —— 它们物理上就在该目录内。文件夹不是标签。 |
| `foldersApi.create` **不查重** | `storage/notes.ts:589-606` | 撞到已有目录时 `MKCOL` 返回 405 → 当作成功 → **静默复用既有目录**，不会产生「名字 2」。 |
| `foldersApi.rename` **查重** | `storage/notes.ts:608-625` | 走 `uniqueRel`，重名自动加后缀。 |

→ 同一实体的「新建」与「改名」查重策略不一致。

---

## 2. 数据模型实体关系

**没有数据库、没有表**（BYOS：无服务端，数据就是用户网盘上的真实目录树）。

### 2.1 两类 DTO（都在 `packages/shared/src/index.ts`）

```ts
// :41-49
interface FolderDTO { id; parent_id; name; created_at; updated_at; note_count }
// :10-30
interface NoteDTO  { id; folder_id; title; content; created_at; updated_at; deleted_at; version }
interface NoteSummaryDTO { id; folder_id; title; excerpt; created_at; updated_at; deleted_at }
```

### 2.2 来源：**同一次遍历派生的两个平行数组**

```
walkTree()  →  { notes: DirEntry[], dirs: DirEntry[] }        storage/notes.ts:116-147
                 │                        │
                 │                        └→ foldersApi.list() → FolderDTO[]      :564-587
                 └→ notesApi.list()      → NoteSummaryDTO[]  :355-392
```

`tree()` 带 3 秒内存缓存（`storage/notes.ts:156-161`），列表页与文件夹页共用一次遍历。

### 2.3 关联键

路径的 base64url（`encodeId()`，`storage/notes.ts:40-45`）：

| 侧 | 字段 | 取值 |
|---|---|---|
| 笔记 | `folder_id` | `encodeId(parentOf(path))`；根目录 → `null`（`:241-252`） |
| 文件夹 | `parent_id` | `encodeId(parentOf(dir.path))`；根目录 → `null`（`:573-583`） |

### 2.4 实体关系结论

- 实质是 **一棵目录树 + 两类节点**；但**数据形状上是两个独立数组，无外键、无引用完整性**。父子关系由路径串现推，不是显式字段。
- **笔记没有父笔记字段**：`NoteDTO` / `NoteSummaryDTO` 里没有 `parent_id` 一类字段 → 「笔记挂笔记」在模型层不存在。
- **计数口径不一致**：
  - `FolderDTO.note_count` 只数**直系**（`storage/notes.ts:567-571`）；
  - `notesApi.list({ folder_id })` 返回**该目录及其全部后代**的笔记（`rel === folder || rel.startsWith(folder + '/')`，`:366-373`）。
  - → 文件夹列表上的数字与点进去看到的条数不必相等。

### 2.5 缓存层是同一结构的镜像

`apps/web/src/services/cache/meta.ts`：

- `meta.json`：`notes[路径] = { title, folder, mtime, etag, cached, dirty }`（`:22-32`）
- `folders.json`：`{ items: string[] }`，相对同步根的路径数组（`:74-91`）

断网时 `cachedEntries()` 用这两份拼出该层目录（`apps/web/src/services/cache/cached-adapter.ts:363-384`）；在线时 `merge()` 把新条目并进这两份（`:329-361`）。

---

## 3. UI 交互现状

### 3.1 Sidebar 不渲染文件夹树

`apps/web/src/components/AppSidebar.vue` 的 `nav` 是**固定 4 项**（`:40-45`）：全部笔记 `/`、文件夹 `/folders`、回收站 `/trash`、设置 `/settings`；外加搜索框、「新建笔记」、底部提示。

> ⚠️ `docs/STATUS.md` 第 2 节写「桌面端左侧栏（搜索框 + **笔记/文件夹树** + 底部设置/回收站入口，260px 可折叠）」—— **与代码不符**：代码里没有笔记树，也没有文件夹树。

### 3.2 点文件夹 → 打开「文件夹详情页」，不是过滤列表

两级：

1. `/folders`（`views/FoldersView.vue`）
   `foldersApi.list()` 取全部文件夹，按 `parent_id` 组树后拉平，按 `depth * 18px` 缩进（`utils/folder-tree.ts`）→ 一个**可嵌套的树形列表**。每行：折叠箭头（有子文件夹才画）+ 目录名 + 直系笔记数 + 「⋯」菜单（新建子文件夹 / 重命名 / 删除文件夹）。
   **折叠**：默认只看到最顶层（`expanded` 空集，`FoldersView.vue:43`），点箭头收放子层，状态不落盘 —— 重进本页又是只露最顶层；刚建/刚移完的那个目标层会自动铺开。`flattenFolders(folders, expanded?)` 传 `expanded` 才按折叠裁行，不传仍是整棵树（「移动到…」候选清单必须一次看全）。
2. 点行 → `RouterLink to="/folders/{id}"` → `/folders/:id`（`views/FolderDetailView.vue`）
   `AppHeader` 面包屑「文件夹 / <名字>」+ 返回（`back-to="/folders"`）；正文是该文件夹的笔记卡片列表；`actions` 槽只有一个「＋」= 在此文件夹新建笔记（`:61-73`）。
   **没有编辑器，没有子文件夹入口，文件夹自身的 CRUD 也不在这里。**

### 3.3 点笔记 → 笔记详情页

`/notes/:id`（`views/NoteEditView.vue`）：面包屑 + 模式开关 + 更多；标题输入 + Milkdown 编辑器。卡片上的「更多」菜单提供重命名 / 移动到文件夹 / 删除（`components/NoteActionMenu.vue:164-189`）。

### 3.4 对称性

**路径对称，能力不对称：**

| | 文件夹 | 笔记 |
|---|---|---|
| 有独立详情页 | ✅ `/folders/:id` | ✅ `/notes/:id` |
| 详情页能写正文 | ❌ | ✅ |
| 详情页能看到子节点 | ✅（笔记列表） | ❌ |
| 详情页内有自身 CRUD | ❌（只在 `/folders` 行的「⋯」里） | ✅（更多菜单） |

→ 「一个目录 = 一个页面，既能写正文也能装子笔记」**没有实现**。

底部标签栏（路由 `meta.tabs`）只在 `/`、`/folders`、`/settings`；`/notes/:id`、`/folders/:id`、`/trash`、`/login` 都没有（`router/index.ts:13-56`）。

---

## 4. 代码位置清单

| 关注点 | 位置 |
|---|---|
| 路由定义 | `apps/web/src/router/index.ts:13-57` |
| `/folders/:id` 与 `/notes/:id` 的关系 | **无嵌套**。两个平级路由、两个组件（`FolderDetailView.vue` / `NoteEditView.vue`）。进 `/folders/:id` 后返回硬编码 `back-to="/folders"` |
| 笔记 CRUD | `apps/web/src/storage/notes.ts` → `notesApi`：`list:355`、`create:394`、`get:409`、`update:430`（改标题 = 移动文件 + 附件随动 + 改写正文引用）、`remove:482`（软删进 `.trash`）、`restore:521` |
| 文件夹 CRUD | 同文件 → `foldersApi`：`list:564`、`create:589`、`rename:608`、`remove:628` |
| 目录遍历 / 树 / 缓存 | `storage/notes.ts:105-161`（`walkTree` / `tree` / `invalidateTree`）；摘要缓存 `:163-237` |
| 路径与命名规则 | `storage/notes.ts:37-82`（`encodeId`/`decodeId`/`parentOf`/`baseName`/`stemOf`/`sanitize`）、`uniqueRel:269` |
| 附件 `.assets` 规则 | `apps/web/src/services/attachments.ts`（`isAssetsDir:28`、`getAssetsDirPath:36`、`assetsDirName:42`、`attachmentUrl:48`、`rewriteAssetRefs:73`）；生命周期联动 `storage/notes.ts:283-310` |
| Sidebar 渲染 | `apps/web/src/components/AppSidebar.vue`（nav 数据 `:40-45`，模板 `:79-184`） |
| 文件夹树渲染 | `apps/web/src/views/FoldersView.vue:28-44`（`rows` 组树 + 缩进）、`:161-180`（行模板） |
| 文件夹详情页 | `apps/web/src/views/FolderDetailView.vue`（`:25-45` 加载，`:61-73` 头部） |
| 笔记列表页 | `apps/web/src/views/HomeView.vue`（`:28-30` `folderNames` 映射，用于在卡片上显示所属文件夹名） |
| 移动笔记到文件夹 | `apps/web/src/components/NoteActionMenu.vue:72-94` → `notesApi.update(id, { folder_id })` |
| 存储适配器接口 | `apps/web/src/services/storage/types.ts`（`StorageAdapter`、`DirEntry:56-65`）；唯一注册点 `apps/web/src/services/storage/index.ts` |
| WebDAV 实现 | `apps/web/src/services/storage/webdav.ts`（`MOVE:356`、`MKCOL:370`、`ensureDir:394`、`PROPFIND list`） |
| 缓存层 | `apps/web/src/services/cache/{store,meta,cached-adapter,background}.ts`；`cached-adapter.ts` 的 `list:310`、`merge:329`、`cachedEntries:364`、`mkdir:444` |
| 本地文件模型说明（权威） | `storage/notes.ts:1-14` |

---

## 5. 与计划模型的差距

### 5.1 计划原文（`docs/STATUS.md:87-100`）

```
框架笔记/
  index.md      ← 这条笔记自己的正文
  子笔记 A.md
  子笔记 B/
    index.md
    …
```

> **副作用**：文件夹与笔记合并为同一个概念 —— 一个目录就是一个页面，既能写正文也能装子笔记；没有 `index.md` 的目录即纯文件夹。

### 5.2 结论：**完全没有实现**

| 判据 | 结果 |
|---|---|
| `index.md` 出现在代码里 | **0 处**。全仓 3 处命中全是文字：`services/attachments.ts:6,34`（注释举例）、`docs/STATUS.md:93,96,100` |
| 「目录名 = 一篇笔记」的概念 | 不存在。`walkTree` 只把 `isDirectory` 收进 `dirs`、把 `.md` 收进 `notes`，两者互不相干（`storage/notes.ts:135-140`） |
| 文件夹的正文存储位置 | 无。`foldersApi.create` 只 `MKCOL`（`:593`）；`FolderDTO` 没有 `content` 字段 |
| 笔记的子节点概念 | 无。DTO 无 parent 字段；UI 无子笔记入口 |
| 文件夹详情页可写正文 | 无编辑器（`FolderDetailView.vue` 全文件） |

补充：`services/attachments.ts:6,34` 注释里出现 `框架笔记/index.md → 框架笔记/index.assets/`，是**路径推导通用性的举例**（`getAssetsDirPath` 只做「去掉 `.md` 后缀 + 拼 `.assets`」，`:36-39`），**不代表该形态已被支持**。它的实际含义是：将来若引入 `index.md`，附件规则无需改动。

### 5.3 批次编号对照（两个口径差 1）

| `docs/STATUS.md:107-112` 执行顺序表 | 仓库内部叫法 | 状态 |
|---|---|---|
| 批次 1 所见即所得编辑器 + Word 工具栏 | 批次 2 | ✅ 已随 0.2.0 上线 |
| 批次 2 导出 HTML 分享 | — | ❌ 未做 |
| 批次 3 笔记嵌套 | **批次 4（接下来这批）** | ❌ 未做 |
| 批次 4 导入、思维导图 | — | 思维导图已提前在工具栏交付（Mermaid `mindmap` 块），导入未做 |

内部批次：1 = 块 A 附件基础（2026-10-10）｜2 = 编辑器（0.2.0）｜3 = 本地缓存 + 自定义标题栏（0.2.3）｜**4 = 笔记嵌套 + index.md 模型**。
需求清单里「笔记嵌套」是第 3 项（`docs/STATUS.md:82`），执行顺序表里是「批次 3」—— 任务书中的「批次 4」用的是内部编号。

---

## 6. [待确认]

1. `docs/STATUS.md` 第 2 节的「桌面端左侧栏（搜索框 + 笔记/文件夹树）」写在**现状表**里，但代码里没有树。若这是新设计的目标形态，则新设计与现有 `AppSidebar.vue` 的差距比文档描述的大。
2. `FolderDTO.note_count`（直系）与 `notesApi.list({ folder_id })`（含后代）**计数口径不一致**，是有意还是遗留。
3. `foldersApi.create` 不查重、撞名静默复用既有目录（省掉一次 `PROPFIND`），是有意还是遗漏。
4. 本轮**未发任何网络请求**（避免触发坚果云限流），「坚果云上此刻的真实目录」未实地核对。以代码可确定的是：新建文件夹 = 空目录、笔记 = 单个 `.md`；当前用户网盘 `/DoNote` 根下有无文件夹未核。
5. 笔记与文件夹同名共存时 UI 无消歧标识 —— 是否需要在同名时加类型标记，待定。
