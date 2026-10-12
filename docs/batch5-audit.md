# 批次 5 前置核实（批量操作 + 侧栏树的落点）

> 2026-10-12。动代码前只读核对，回答任务书里列的 6 个问题，末尾给可行性与卡点。

## 1. 笔记卡片现在怎么渲染「单条菜单」

`NoteCard.vue` **自己不渲染菜单**，只抛一个事件：

- 右键整张卡片：`@contextmenu.prevent="emit('menu', note)"`
- 点右上角 `.more`（⋯）：`emit('menu', note)`
- 数量与时间在 `.top`，标题前缀 📄，文件夹徽标前缀 📁
- 整块内容包在 `<RouterLink :to="/notes/${id}">` 里 —— **多选时要拦的就是它**（见卡点 3）

菜单本体在 `NoteActionMenu.vue`：

- `<Teleport to="body">` + `.sheet-mask`（fixed 全屏遮罩）+ 底部弹出 `.sheet glass`
- `props.note` 为 `null` 时整块不渲染（所以父级只要把 note 置空就关掉了）
- `mode='normal' | 'trash'` 决定菜单项：普通＝重命名 / 移动到文件夹 / 删除；回收站＝恢复 / 彻底删除
- 重命名 / 移动 / 删除的确认框是内部的 `AppDialog`
- **本次已顺手修好的层级问题**：`.sheet-mask` 原来是 `z-index: 18`，被侧栏 `.rail`（20）压住；
  现在 18 → **21**，`AppDialog` 20 → **22**，保持「菜单在侧栏之上、对话框在菜单之上」。
  验收脚本 `taskA-menu-z.cjs`（11 项，含反向对照）

使用点（3 处）：

| 视图 | 用途 | 是否用 NoteCard |
|---|---|---|
| `HomeView.vue` | 全部笔记列表 | 是 |
| `FolderDetailView.vue` | 文件夹内列表 | 是 |
| `TrashView.vue` | 回收站（`mode="trash"`） | 否，自己写 `.row-card` + 「恢复 / 彻底删除」两个按钮 |

## 2. `notesApi.remove` / 移动的实现

### 删除 `notesApi.remove(id, hard = false)`

```
hard === true 或 rel 已经在 .trash/ 下
  → storage.delete(rel)
  → storage.delete(trashAssetsPath(rel))     // 回收站里的附件目录，按时间戳前缀配对
  → invalidateTree()

否则（软删）
  → ensureDir('.trash')
  → 写 .trash/<毫秒时间戳>-<4位随机>-<原文件名>.md
     frontmatter 追加 deleted_from: <原相对路径>、deleted_at: <毫秒>
  → storage.delete(原文件)
  → moveAssets(原 .assets/, .trash 里配对的时间戳前缀 .assets/)
  → invalidateTree()
```

注意：**软删是「复制一份进 .trash 再删原件」，不是 MOVE**；附件目录才是 MOVE。

### 移动 = `notesApi.update(id, { folder_id })`

```
readOrNull(rel) → 不存在直接抛 not_found
folderNext !== folderNow 或标题变了 时：
  → ensureDir(folderNext)                    // 逐段无条件 MKCOL
  → uniqueRel(folderNext, stem, '.md', rel)  // 撞名自动补后缀
  → storage.move(rel, target)
  → moveAssets(fromDir, toDir)               // 附件目录同级跟随
  → 标题变了还要 rewriteAssetRefs(body, fromName, toName)
  → invalidateTree()
最后 write(target, serializeNote(meta, body))   // 更新 updated 时间戳
```

**没有独立的 `notesApi.move`**，移动是 `update` 的一个分支 —— 任务书写的「逐个 notesApi.move」实际调用的是 `notesApi.update(id, { folder_id })`。

## 3. 回收站的恢复 / 彻底删除

| 操作 | 实现 |
|---|---|
| 恢复 | `notesApi.restore(id)`：原位置**被占用就放弃**（不自动改名，避免「恢复出来的东西悄悄换了名字」）；附件 best-effort 回滚 |
| 彻底删除 | `notesApi.remove(id, true)` |

视图层（`TrashView.vue`）：`.row-card` 每行两个按钮（恢复 / 彻底删除），右键开 `NoteActionMenu(mode="trash")`；
「彻底删除」走页内 `AppDialog`（因为要多显示标题）。

## 4. 文件夹列表的删 / 移

`foldersApi` 只有四个方法：`list` / `create` / `rename` / `remove`。

- **`foldersApi.remove(id)` 的语义是「解散」**：把子项逐个 `move` 到父目录（并发 3），再删掉目录本身，返回 `moved_to`。
  不是连带删除。
- **没有「移动文件夹」的能力**：既没有 `foldersApi.move`，`update` 也不存在。← 见卡点 1

`FoldersView.vue`：列表项是 `<RouterLink class="folder-link">`，新建 / 重命名走 `AppDialog`，删除调 `foldersApi.remove`。

## 5. 现有 Pinia store 里有没有选择状态

**没有。** `stores/` 现有：`editing` / `layout` / `sync` / `theme` / `ui` / `webdav`。
全仓 grep `selectedIds|selection|selecting` 只命中编辑器的 `commands.ts` / `create-editor.ts` / `NoteEditor.vue`（是 ProseMirror 的选区，无关）。

→ `stores/selection.ts` 需要新建，没有可复用的。

可复用的两个：

- `useUiStore().toast(text, duration=2200)` —— 汇总提示直接用
- `useSyncStore().dataVersion` —— 缓存层后台校验出差异时的信号；批量操作后只要调 `invalidateTree()`，重取列表会走缓存的 `notifyData` 合并（200 ms），不会逐条刷新

## 6. 底部悬浮工具栏：现有 UI 有没有类似组件

**没有可直接复用的浮动工具栏。** 最接近的两类：

| 现成物 | 位置 | 层级 | 说明 |
|---|---|---|---|
| 选中文字浮条 | `components/editor/FloatingToolbar.vue` | 16 | 编辑器内的，绑定 ProseMirror 选区，不能挪作他用 |
| 页面底部面板 | `NoteEditView.vue` / `FoldersView.vue` 的 `.sheet-mask` | 25 | fixed + `align-items: flex-end`，是全屏遮罩式，会挡住页面 |

→ `BatchToolbar.vue` 是新组件。视觉上复用的应该是 `.glass`（毛玻璃）与 CSS 变量（`--r-*` / `--sp-*` / `--accent` 等），
而不是上面任何一个组件的结构。层级按已理清的栈落：`.rail` 20 < **批量工具栏 21** < `AppDialog` 22 < `.toast` 30。

## 自检：方案可行？卡点

**可行。** 批量操作本质是「把已有的单条调用串行跑一遍」，不需要动数据层。但有 4 个卡点：

### 卡点 1（唯一需要你定的）—— 文件夹的「批量移动」没有对应能力

任务书 B3 写「笔记 / 文件夹：删除、移动」，但 `foldersApi` **没有 move**，数据层也没有「移动目录」的能力。
两条路：

- **A**：新增 `foldersApi.move(id, parent_id)`（= 查重 → `storage.move` → `invalidateTree`；缓存层的 `move()` 已会搬运整棵子树）。
  与笔记对齐，工作量小，但要新增数据层 API。
- **B**：批量移动只对笔记生效；文件夹只有「解散」（删除）。不新增 API，但文件夹的「移动」按钮要按选中内容禁用。

### 卡点 2 —— 多选态要先拦掉 RouterLink

`NoteCard` 整块是 `RouterLink`。多选模式下点卡片必须**不进详情、改为切换选中**，
需要在多选态下 `@click.prevent` 并挡住冒泡（`<RouterLink>` 的默认导航）。这是实现要点，不是阻塞项。

### 卡点 3 —— `NoteActionMenu` 与多选态并存

多选态下右键卡片应该「退出多选」还是「照常开单条菜单」，任务书没写。倾向：**照常开单条菜单**（不动既有行为），
多选只由悬停勾选框 / 长按进入。

### 卡点 4 —— 文件夹的删除语义

`foldersApi.remove` 是「解散」（把子项搬回父目录）。批量删除文件夹时会按「解散」执行，
**不是**连带删除。这会和用户对「批量删除」的直觉不一致，需要在确认框文案里写明（例如「将解散 N 个文件夹，里面的笔记会移到上一级」）。
（此条与先前 `STATUS.md` 里待定的「删除 / 解散」文案是同一件事，一并处理。）
