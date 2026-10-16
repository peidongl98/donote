# index.md 模型改造前：现状核实

> 2026-10-16｜基线：工作区 0.3.0（线上同版本）｜**只读核实**，未启动应用、未连坚果云。
> 与前两份文档的关系：`docs/folder-note-model.md`（10-12）核实的是**文件模型与 UI 现状**，
> `docs/walktree-audit.md`（10-12）核实的是**遍历与请求量**。本文补的是**这四天里新增的代码**
> （侧栏树、导入、回收站树、绿色版）在 index.md 模型下会踩到什么。

---

## 1. 当前文件模型

### 1.1 权威定义（`apps/web/src/storage/notes.ts:4-7`）

```
<同步根>/<文件夹…>/<标题>.md          一篇笔记 = 一个 .md 文件
<同步根>/<标题>.assets/<文件名>       附件，与笔记同级同名
<同步根>/.trash/<时间>-<随机>-<标题>.md   软删
<同步根>/.trash/<YYYYMMDD-HHMMSS>_<目录名>/  删文件夹 = 整棵子树
```

- **一篇笔记 = 一个 `.md` 文件**；**一个文件夹 = 一个空目录**（`foldersApi.create` 只 `MKCOL`，
  不写任何占位文件，`notes.ts:603-622`）。
- 同步根默认 `/DoNote`。

### 1.2 同名 `.md` 与目录**可以共存**

`uniqueRel()`（`notes.ts:295-307`）按 `entry.name`（含扩展名）判重：
笔记占 `框架笔记.md`、目录占 `框架笔记`，两串不相等 → 不冲突。
所以 `/DoNote/框架笔记.md` 与 `/DoNote/框架笔记/` 能同时存在，**UI 上没有任何消歧**。

> 这条在新模型里要收紧：目录有 `index.md` 时，同目录下的同名 `.md` 会让两者语义撞车。

### 1.3 walkTree 遍历规则（`notes.ts:120-151`）

广度优先、同层并发 4、`MAX_DIRS = 300` / `MAX_DEPTH = 8`。逐条规则：

| 项 | 行为 |
|---|---|
| 目录 | 收进 `acc.dirs`，并继续往下递归 |
| `.md` 文件 | 收进 `acc.notes`，**不递归** |
| 其它文件 | 忽略 |
| `.` 开头的目录/文件 | 跳过（`.trash` 等） |
| `*.assets` 目录 | 跳过（`isAssetsDir`），不递归 |

产出是**两份扁平清单** `{ notes: DirEntry[], dirs: DirEntry[] }`，**没有 `index.md` 任何特殊分支**
（全仓 `index.md` 目前只出现在 3 处注释里：`notes.ts:400`、`services/attachments.ts:6,34`）。

`tree()`（`:163-176`）带 3 秒模块缓存 + 并发合并，列表页与文件夹页共用一次遍历；
`invalidateTree()`（`:159`）作废缓存。

---

## 2. 数据层

### 2.1 DTO（`packages/shared/src/index.ts`）

```ts
FolderDTO      { id, parent_id, name, created_at, updated_at, note_count }     // :45-53
NoteDTO        { id, folder_id, title, content, created_at, updated_at,
                 deleted_at, version, tags }                                    // :10-21
NoteSummaryDTO { id, folder_id, title, excerpt, created_at, updated_at,
                 deleted_at, tags }                                             // :24-34
```

### 2.2 关联键：**路径的 base64url**（`encodeId`，`notes.ts:40-45`）

| 侧 | 字段 | 取值 |
|---|---|---|
| 笔记 | `folder_id` | `encodeId(parentOf(path))`；根 → `null`（`:279-292`） |
| 文件夹 | `parent_id` | `encodeId(parentOf(dir.path))`；根 → `null`（`:587-597`） |

- **没有 `parent` / `child` 字段**：「笔记挂笔记」在当前模型里不存在。
- 父子关系**由路径现推**（`parentOf` / `baseName` / `stemOf`），不是显式字段。
- `note_count` 只数**直系**笔记（`:581-596`）；`notesApi.list({folder_id})` 也按**直系**过滤
  （`:397-403`，注释里已经写明「批次 4 的 index.md 模型下递归更是错的」）。

### 2.3 缓存层的索引（`services/cache/`）

- `meta.json`：`notes[相对路径] = { title, folder, mtime, etag, cached, dirty }`（`meta.ts:36-54`），
  正文副本落 `notes/<rel>`（`:32-34`）。
- `folders.json`：`{ items: string[], listed: string[], checked: Record<目录, 时刻> }`（`:21-26`）。
- `reconcile()`（`cached-adapter.ts:530-596`）：`!name.endsWith('.md')` 的直接跳过（`:543`），
  是 `.md` 就按 `entry.path` 建行、`title` 缺省取 `stemOf(name)`（`:553-561`）。
- → **今天若放一个 `index.md` 进去，缓存层会把标题记成「index」**，并按普通笔记列出。

### 2.4 相关 API 现状

| API | 位置 | 说明 |
|---|---|---|
| `notesApi.list` | `notes.ts:386-425` | 标题 + 摘要过滤，按 `updated_at` 倒序 |
| `notesApi.create` | `:427-440` | `uniqueRel(dir, sanitize(title), '.md')` |
| `notesApi.get/update/remove/restore` | `:442-572` | 改标题 = 移动文件 + 附件随动 + 改写引用 |
| `foldersApi.list/create/rename/move/remove/trash` | `:578-724` | `remove` = 解散；`trash` = 整棵进回收站 |
| 回收站树 | `:767-1037` | `listTrashEntries` / `restoreTrashEntry` / `purgeExpiredTrash` |

---

## 3. 依赖文件模型的地方（全量清单）

### 3.1 存储与遍历
`notes.ts`：`walkTree:120`、`tree:163`、`summaryOf:265`、`noteOf:279`、`uniqueRel:295`、
`listTrash:355`、`notesApi.*:385-573`、`foldersApi.*:577-724`、`readTrashChildren:848`、
`listTrashEntries:879`。

### 3.2 侧栏树（`components/SidebarTree.vue`）
自取自渲染，props 只有 `reloadToken`（`:42`）。
`load()` 并行 `foldersApi.list()` + `notesApi.list({limit:100_000})`（`:97-108`）→
`rows = buildSidebarRows(folders, notes, expanded)`（`:70`）→ 行模板 `:521-534`，
缩进 `depth * 18px`（`:531`）。
- 文件夹行 `:535-600`：展开箭头 `.twist`（仅 `hasChildren`）、`📁`、`RouterLink → /folders/:id`
- 笔记行 `:602-629`：`📄`、`RouterLink → /notes/:id`
- 展开状态落 `localStorage: donote.sidebar.expanded`（`:29,50-68`）
- 进笔记自动展开祖先链：`revealCurrent()` + `ancestorFolderIds`（`:114-125`）
- 刷新：`onMounted` / `watch(sync.dataVersion)` / `watch(reloadToken)`（`:132-136`）
- 右键菜单：文件夹 8 项（`:649-683`）、笔记 6 项（`:685-711`）、空白 4 项（`:713-724`）
- **树内没有任何 drag/drop**

### 3.3 侧栏容器（`components/AppSidebar.vue`）
不组装数据，只挂 `<SidebarTree :reload-token>`（`:263-266`），导入后 `reloadToken++`（`:150-153`）。

### 3.4 列表与文件夹页
- `HomeView.vue`：卡片列表；`folderNames` 映射用于卡片上的文件夹名（`:227`）
- `FoldersView.vue`：`flattenFolders`（`:46`）、总计数 `reduce note_count`（`:60`）、行内计数（`:324`）
- `FolderDetailView.vue`：`notesApi.list({folder_id})`（`:64`）、新建笔记（`:86`）、
  面包屑 `[{文件夹, /folders}, {folderName}]`（`:116-120`）
- `TrashView.vue` / `TrashNode.vue`：回收站树

### 3.5 编辑器（`components/editor/`）
文件：`BlockHandle.vue`、`EditorToolbar.vue`、`FloatingToolbar.vue`、`MermaidPanel.vue`、
`NoteEditor.vue`、`SlashMenu.vue`、`commands.ts`、`create-editor.ts`、`editor.css`、`math.ts`、`mermaid.ts`。

- 实例创建：`createNoteEditor()`（`create-editor.ts:42-81`），
  预设 `commonmark / gfm / history / listener` + 自定义 `math / mermaid`（`:75-80`）
- 自定义 node 的现成范例：`math.ts:25-95`（`$nodeSchema` + `$remark('remarkMath')`）
- **没有任何自定义 input rule**（全仓 `$inputRule` 为空）
- 唯一的「输入触发菜单」是 `/` 命令：`SlashMenu.vue:96-108`（正则 `/(?:^|\s)\/(\S*)$/`）
- **`[[` / wikilink / backlink / subpage 全仓 0 命中**
- 落盘：listener 的 `markdownUpdated`（`create-editor.ts:53-57`）→ `NoteEditor.vue:87-91`；
  **只有 `remark-math` 一个 remark 插件**，其余走预设序列化

### 3.6 导入
- `ImportButton.vue`（侧栏 + 列表页）→ `ImportDialog.vue` → `services/import-pick.ts`
- 核心 `services/import-drop.ts`：桌面 `itemsFromPaths()`（递归读 `list_dir`/`read_text`，只收 `.md`，
  `:56-84`）、浏览器 `itemsFromFiles()`（`:87-94`）；
  落盘 `importItems()`（`:106-147`）= 按 `item.rel` 逐级 `foldersApi.create` + `notesApi.create`
- **拖放挂载点在 `App.vue:49` 的 `DropOverlay`（整窗投放）**，不在任何视图内部：
  浏览器 `onDrop`（`:68-76`）、桌面 `onDragDropEvent`（`:82-101`）→ 同一个 `importItems`

### 3.7 store
`editing`（哪篇开着）、`layout`（侧栏宽度/开关）、`selection`（多选）、`sync`（离线/脏/冲突 +
`dataVersion`，`attach()` 里 `invalidateTree()`）、`theme`、`ui`（toast）、`webdav`（凭据 + 装配缓存层）。

### 3.8 名字推断点（index.md 模型下需要复核）
`endsWith('.md')`：`notes.ts:63,66,142,357,432,864,906`、`cached-adapter.ts:543`、`import-drop.ts:66,78`。
`baseName()`：`notes.ts:270,366,447,488,547,549,733,908,913,915`。
`stemOf()`：`notes.ts:497,694,865`、`cached-adapter.ts:559`。
`folder_id`：`sidebar-tree.ts:60,104`、`SidebarTree.vue:119,270,394,447`、`NoteEditView.vue:136,308,591`、
`FolderDetailView.vue:64,86`、`HomeView.vue:227`、`NoteActionMenu.vue:79`、`BatchToolbar.vue:80`、`MoveDialog.vue:6`。
`note_count`：`notes.ts:595,619,638,681`、`FoldersView.vue:60,324,395`、`shared/index.ts:52`。

---

## 4. 版本与回归状态

- 版本号 **6 处**：根 `package.json`、`apps/web`、`apps/desktop`、`packages/shared`、
  `apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml`。
  （`scripts/release.mjs` 的第 1 步会一次改齐，另有 `Cargo.lock` 随之更新。）
- **回归：9 套 300 项**（`notes 47`、`attach 39`、`life 25`、`stage2 24`、`stage4 52`、`stage5 11`、
  `stage6 24`、`stage7 55`、`actions 23`）。⚠️ 任务书写的「272 项」是 0.2.x 时代的数，**当前是 300**。
- 跑法：**必须先起 dev server**（`pnpm --filter @donote/web dev`，5173），再 `pnpm regress`。
  每套有 `checks` 预期项数，`exit≠0` 或 `PASS+FAIL≠checks` 都算坏。

### 最近 20 个 commit

```
4bfc7fb chore(release): 补上绿色版打包脚本
e55ea73 chore(release): 0.3.0
d34206f chore(release): 0.2.9
63458dc feat: 外链交给系统浏览器、首次安装默认装到空间最大的盘
8afb365 chore: 以 MIT 许可证开源
5685fa0 chore(release): 0.2.8
89945dc feat: 侧栏宽度可调 / 文件夹页可折叠 / 换目标不重取 / 更新沿用原安装位置
19f316a chore(release): 0.2.7
ba78210 docs: 批次记录
74d3910 docs: 弹层一致性检查
01ca697 feat: 回收站自动清理
5f35c84 feat: 导入按钮（侧栏 + 列表页）
e5e7c9c feat: 侧栏右键菜单 + 删除/解散双功能 + 回收站树形视图
53e2b13 feat: Mermaid 块交互重做（NodeView 只出图 + 点击开源码面板）
df5e1dc docs: UI 交互规范
8d9f20c fix: 表格删行/删列按光标所在行列操作（表头行曾被清空并凭空多出一行）
8abd309 chore(release): 0.2.6
96ca218 feat: 块级手柄支持拖动排序
12e5328 chore(release): 0.2.5
2194546 feat: 标签（frontmatter + 侧栏筛选）
```

### 工作区当前未提交

`AppHeader.vue`、`NoteEditView.vue`、`docs/ui-patterns.md`、`vite.config.ts`、`env.d.ts`，
以及已 stage 的 `D:/DoNote/.env.production` 删除（详见 `memory/2026-10-15.md` 附二~附六）。

---

## 5. 改造要动的最小面（结论）

| 层 | 改动 | 规模 |
|---|---|---|
| 数据层 | `walkTree` 认 `index.md` → 目录变成「页面」；页面笔记的 id = `encodeId('<目录>/index.md')`、标题 = 目录末段名 | 中 |
| DTO | `FolderDTO` 加 `page_id: string \| null`（有页面的目录才有值）；不加 NodeDTO 基类（见设计文档说明） | 小 |
| 缓存层 | `reconcile` 对 `index.md` 用目录名当标题 | 小 |
| 侧栏 | 目录行有 `page_id` → 渲染成 📄 且链到 `/notes/:id`；`/notes/:id` 直接复用现有详情页 | 中 |
| 详情页 | 加「子页面列表 + 新建子页面 + 面包屑层级」 | 中 |
| 编辑器 | `[[` 补全菜单 + 纯文本 decoration（**不做 mdast 节点**，见设计文档） | 中 |
| 反链 | 摘要缓存行加 `l: string[]`（出链），反链索引由缓存派生、不落额外文件 | 小 |
| 搜索 | 结果带层级路径 | 小 |
| 拖放 | 落到「当前页面的目录」而非统一落到根 | 小 |

**不改**：`services/storage/*`（适配器接口不动）、WebDAV 交互、附件规则（`getAssetsDirPath`
对 `index.md` 天然成立）、回收站结构、`.trash` 语义。
