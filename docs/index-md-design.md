# index.md 模型设计

> 2026-10-16｜承接 `docs/index-md-precheck.md`（现状核实）。
> 目标：目录 + `index.md` = 一个「页面」（Notion 式 subpage），零迁移、不破坏现有数据。

---

## 1. 文件系统约定

```
框架笔记/                  ← 一个页面（父笔记）
  index.md                 ← 该页面自己的正文（frontmatter 与普通笔记完全一致）
  子笔记A.md               ← 子笔记（普通笔记文件）
  子笔记A.assets/          ← 它的附件（现有规则，无需改动）
  子笔记B/                 ← 又一个子页面
    index.md
    index.assets/          ← 页面正文的附件（getAssetsDirPath('子笔记B/index.md') 天然得出）
```

**判定规则一句话**：目录里有 `index.md`（大小写不敏感）→ 该目录是页面；没有 → 纯文件夹。

### 兼容旧结构（零迁移）

| 形态 | 新模型下的行为 |
|---|---|
| 根目录下的 `X.md` | 顶层笔记，**行为完全不变** |
| 没有 `index.md` 的目录 | 纯文件夹，**行为完全不变**（侧栏 📁、点进去看列表） |
| 有 `index.md` 的目录 | 页面：侧栏 📄、点击进笔记详情页、可写正文、可装子页面 |

**不迁移任何现有数据**。`index.md` 只在用户**主动创建子页面**（或手动放进网盘）时出现。

---

## 2. 关键规则

### 2.1 标识与标题

| 项 | 取值 |
|---|---|
| 页面的 id | `encodeId('<目录相对路径>/index.md')` —— **与普通笔记同一套 id 规则**，因此 `/notes/:id` 直接复用 |
| 页面的标题 | **所在目录的末段名**（不是 `index`） |
| 页面的 `folder_id` | 该目录的**父目录**（不是目录自己）→ 在侧栏里与同级条目并列 |
| 页面正文 | 就是 `index.md` 的内容（frontmatter + body，序列化与普通笔记同一套） |

### 2.2 同名冲突

`uniqueRel()` 现在只比 `entry.name`，因此 `X.md` 与 `X/` 可共存。新模型下收紧：

- 目录 `X/` **有 `index.md`** 时，同目录下再建 `X.md` → **视为冲突，自动补后缀**（`X 2.md`）。
- 反过来：已存在 `X.md` 时，创建页面 `X/` → 同样补后缀。
- 目的：不让「页面 X」与「笔记 X」在 UI 上出现两个同名不同物的东西。
- ⚠️ 只管**新建**，不回头清理历史数据（零迁移）。

### 2.3 删除

| 对象 | 行为 |
|---|---|
| 删页面（目录 + `index.md`） | **整个目录进 `.trash`**（复用 `foldersApi.trash`，整棵一次 `MOVE`，写 `.donote-origin`） |
| 删纯文件夹 | 维持现状：右键两个选项 ——「解散（内容上移）」与「删除（整棵进回收站）」 |
| 删普通笔记 | 维持现状 |

### 2.4 重命名

| 对象 | 行为 |
|---|---|
| 页面改标题 | **重命名它所在的目录**（`MOVE` 整棵，子项与附件跟着走） |
| 普通笔记改标题 | 维持现状（`MOVE` 文件 + 附件随动 + 改写附件引用） |

### 2.5 创建子页面

- 触发：笔记详情页的「新建子页面」按钮、拖 `.md` 到笔记详情页。
- 落点规则：
  - 当前笔记**是页面**（`…/index.md`）→ 落到**它自己的目录**下（`<目录>/<新名>/index.md`）；
  - 当前笔记**是普通笔记** → 落到**它所在的目录**下（与它平级；"当前页面目录"对它不存在，
    退化到所在目录，可预期且零数据改动）。
- 落地动作：`mkdir <目录>/<新名>` → 写 `<目录>/<新名>/index.md`。

---

## 3. 两个实现决策（偏离任务书的地方，写明理由）

### 3.1 不引入 `NodeDTO` 基类 / `PageNode` / `FolderNode` 继承体系

任务书写「引入 NodeDTO 基类，子类 PageNode / FolderNode，现有代码逐步迁移」。

**不做的理由**：现有两份扁平清单（`FolderDTO[]` + `NoteSummaryDTO[]`）已被 **8 个视图/组件**消费
（侧栏、列表页、文件夹页与详情页、移动对话框、批量条、回收站、搜索）。引入基类要改的是
**全部消费点的类型与判空**，换来的只是类型层面的整齐，**没有任何行为收益**，却把一次功能开发
变成了全仓重构 —— 与「简单优先」和「不写坏用户数据」两条都相悖。

**替代**：`FolderDTO` 加一个字段 `page_id: string | null`（有页面时给出 `index.md` 的笔记 id）。
侧栏行的判据从「是文件夹还是笔记」变成「这条目录行有没有 `page_id`」——
一个字段就表达了节点类型，改动面从 8 个降到 2 个（侧栏 + 文件夹页）。

### 3.2 `[[笔记名]]` 用**纯文本 + 装饰**实现，不建 mdast 节点

任务书写「编辑态显示为蓝色高亮的笔记名」，未限定实现方式。两条路：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 自定义 mdast 节点 | 仿 `math.ts` 写 `$nodeSchema('wikilink')` + 自写 remark 解析/序列化插件 | 触碰**序列化管线** —— 现有回归里 stage2 有「源码模式字节精确」与「落盘是 Markdown」的硬断言，新节点一旦序列化不完美就会写坏正文 |
| **B. 纯文本 + ProseMirror decoration**（采用） | `[[X]]` 始终是普通文本，只用 decoration 把它染蓝/染红并接管点击 | 零序列化风险（落盘天然就是原文）；光标退格时按普通文本处理 |

选 B。理由：**首要红线是「不写坏用户数据」**，而落盘存原文正是任务书的要求；
B 方案下"存原文"是天然结果而不是需要去保证的不变量。代价是 `[[` 不能做成语义化 atom
（比如不能整体删除、不能防中间插入字符），按「先跑通」接受。

补全菜单仿现有 `SlashMenu.vue`（`components/editor/SlashMenu.vue:96-108` 的触发解析 + 定位）。

---

## 4. 分层改动清单

### 4.1 数据层（`apps/web/src/storage/notes.ts`）

1. `walkTree()`：产出的 `Tree` 增加 `pages: Map<目录路径, index.md 的 DirEntry>`；
   遍历时遇到 `index.md` **不再放进 `notes`**，改记进 `pages`，并把该目录标记为页面。
2. 新增 `pageSummaryOf(dirRel, indexEntry)`：造一条 `NoteSummaryDTO`
   （id = `encodeId(dirRel + '/index.md')`、title = 目录末段名、folder_id = 父目录）。
3. `notesApi.list()`：合并「普通笔记 + 页面」。**页面进列表**（列表页/搜索要能看到它）。
4. `notesApi.create()`：建普通笔记时按 §2.2 避难。
5. `pageApi`（新增，或挂在 `notesApi` 上）：
   - `createChild(parentNoteId, {title, content})` → 建目录 + 写 `index.md`
   - `childrenOf(noteId)` → 列出该页面目录下的直系子项（子笔记 + 子目录/子页面）
6. `notesApi.update()`：rel 以 `/index.md` 结尾时，改标题 = **移动所在目录**。
7. `notesApi.remove()`：rel 以 `/index.md` 结尾时，**删整个目录**（走 `foldersApi.trash`）。
8. `foldersApi.list()`：每个目录补 `page_id`（有 `index.md` 才有值）；
   `note_count` 把直系页面算进去。
9. 反向链接：见 4.4。

### 4.2 缓存层（`services/cache/cached-adapter.ts`）

`reconcile()` 对 `name.toLowerCase() === 'index.md'` 的行，`title` 取**所在目录末段名**
（而不是 `stemOf('index.md')` = `index`）。别的地方不动 —— 缓存以 `rel` 为键，
`<目录>/index.md` 天然是普通键，`move` / `delete` 的 `repath` / `forget` 也按前缀工作。

### 4.3 侧栏（`components/SidebarTree.vue` + `utils/sidebar-tree.ts`）

- `SidebarFolderRow` 加 `pageId: string | null`；渲染时：
  - 有 `pageId` → 图标 📄、`RouterLink → /notes/{pageId}`（**展开箭头照旧**，展开出子项）
  - 无 → 现状（📁、`/folders/{id}`）
- `notes` 桶里**过滤掉页面**（页面已由它的目录行代表），避免同一条出现两次。
- 右键菜单：目录行有 `pageId` 时，把「新建笔记 / 新建子文件夹」替换为
  「打开页面 / 新建子页面 / 重命名 / 移到… / 删除…」。
- 进页面笔记时的祖先展开链：由 `pageId` 反查它的父目录链（`ancestorFolderIds` 的入参从
  `folder_id` 换成「目录 → 其父目录」的链）。

### 4.4 笔记详情页（`views/NoteEditView.vue`）

- 正文下方加**子页面区块**：卡片式列出子项（子笔记 + 子页面），顶部有「新建子页面」按钮。
- **面包屑层级**：由当前笔记的路径逐级向上，页面用页面名（链 `/notes/:id`）、
  纯文件夹用目录名（链 `/folders/:id`）。改用 `AppHeader` 的 `#crumbs` 槽
  （`FolderDetailView.vue:116-120` 是现成范例），替换现在的 `#subtitle` 文件夹名。
- **反向链接区块**：底部「被以下笔记提到」列表。

### 4.5 反向链接索引（不新增存储文件）

出链**顺手存进摘要缓存**：`CacheRow` 加 `l?: string[]`（该篇正文里出现的所有 `[[名字]]`）。
`hydrateExcerpts()` 本来就要读整篇正文来补摘要，多提取一次正则是零额外请求。
反链 = 遍历缓存、把 `l` 里含目标名的笔记收集起来（内存计算，可随时重建）。
刷新时机：保存笔记后更新该篇的 `l`；改名后由下一次 hydrate 自然纠正。

### 4.6 搜索（`notesApi.list`）

- 页面已在列表里，`q` 过滤天然覆盖 `index.md` 的摘要正文。
- 结果加层级路径：`NoteSummaryDTO` 加 `path_label?: string`（如 `框架笔记 / 子笔记B`），
  由 `folder_id` 逐级反查目录名拼出，在 `HomeView` 的卡片上显示。

### 4.7 拖放（`components/DropOverlay.vue` + `services/import-drop.ts`）

`importItems()` 的 `baseFolderId` 现在由调用方给（`App.vue` 里是 null）。
改造：拖放时若当前路由是 `/notes/:id`，把落点换成**该笔记的页面目录**（页面 → 自己的目录；
普通笔记 → 所在目录），通过新增的可选项 `preferChildOfNoteId` 传进 `importItems`。

### 4.8 编辑器（`components/editor/`）

- 新增 `wikilink.ts`：ProseMirror `$prose` 插件，扫全文档找 `[[…]]` 文本区间，
  经索引判断存在与否 → 加 `class="wikilink"` / `"wikilink is-missing"` 的 decoration；
  `handleClickOn` 命中区间 → 跳 `/notes/:id`（缺失则提示并可创建）。
- 新增 `WikilinkMenu.vue`：仿 `SlashMenu.vue`，监听 `[[` 触发，列出笔记名（模糊匹配），
  选中 → 插入纯文本 `[[名字]]`。
- `create-editor.ts` 注册插件；`NoteEditor.vue` 挂菜单并暴露所需回调。

---

## 5. 风险与红线

| 风险 | 处置 |
|---|---|
| 正文 / frontmatter / 路径被写坏 | 所有写操作沿用既有 `serializeNote` / `frontmatter.ts`，**不新增序列化路径** |
| 现有 300 项回归被打破 | 页面只在有 `index.md` 时出现 → 现有数据下**行为应当完全不变**；每阶段跑全量回归 |
| `index.md` 被当成普通笔记（标题「index」）| 数据层与缓存层两处都要认出来；`walkTree` 负责从 `notes` 剔除，`reconcile` 负责给对标题 |
| 页面 id 与普通笔记 id 撞车 | id 就是路径 base64，路径唯一 → 不会撞 |
| 冲突规则只在新建时生效 | 历史同名数据不动，保留原样 |
