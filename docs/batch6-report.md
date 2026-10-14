# 批次 6 报告：7 项功能 + bug 修复（大改数据层前的清理，0.2.7）

> 任务书顺序：F1 UI 规范 → A 表格增删修复 → B Mermaid 块 → C 侧栏右键菜单 + 回收站树 →
> D 导入按钮 → E 回收站自动清理 → F2 弹层一致性。
> 红线：不写坏用户数据 / 每步 mock 回归必过 / 不破 265 项回归 / 不引新依赖 / 不改数据模型与坚果云交互。

## 一、交付（7 个 commit）

| 任务 | commit | 内容 |
|---|---|---|
| F1 UI 规范 | `df5e1dc` | `docs: UI 交互规范` — 新增 `docs/ui-patterns.md`（弹层三场景 / 提示三档 / 视觉参数 / z-index 阶梯 / 组件清单 / 8 条检查清单） |
| A 表格增删 | `8d9f20c` | `fix: 表格删行/删列按光标所在行列操作（表头行曾被清空并凭空多出一行）` |
| B Mermaid | `53e2b13` | `feat: Mermaid 块交互重做（NodeView 只出图 + 点击开源码面板）` |
| C 侧栏 + 回收站 | `e5e7c9c` | `feat: 侧栏右键菜单 + 删除/解散双功能 + 回收站树形视图` |
| D 导入按钮 | `5f35c84` | `feat: 导入按钮（侧栏 + 列表页）` |
| E 自动清理 | `01ca697` | `feat: 回收站自动清理` |
| F2 一致性 | `74d3910` | `docs: 弹层一致性检查` — 新增 `docs/ui-audit.md` + 底部弹层抽全局 |

## 二、A 表格增删：报障与真缺陷不是一回事

**报障**：「四个按钮（加行/加列/删行/删列）实际行为全是加行」—— 复现不出来。
探针实测：加行 +1 行、加列 +1 列、删行 −1 行、删列 −1 列，四条映射本来就是对的。

**真缺陷**：用「5 种光标位 × 4 个按钮」矩阵探针找到 —— **光标停在表头行**（插完表格光标默认就在这）
点「删除本行」→ 表头行被替换成普通行：Δ行 +1 / Δ列 −3，落盘 `.md` 变成**无表头**的 4 行表格（分隔行成了 `| - | - | - |`）。

**根因**：`preset-gfm` 的表格是 `content: "table_header_row table_row+"`，而 prosemirror-tables 的
`deleteRow` / `deleteColumn` 只认自己 schema 的行节点名，遇到 gfm 的两种行类型判断不出来；
`deleteColumn` 在「整列选中」时还会因 `rect.left==0 && rect.right==map.width` 直接返回 `false`（静默无操作）。

**修法**（`commands.ts` + `EditorToolbar.vue`）：
1. `cursorCell()` 用 `$from.node(depth - 2)` 取表、`$from.before(depth)` 取单元格位置，循环 `depth > 1` 认 `tableRole`
   （`cell` / `header_cell`），**不靠节点名**；
2. 把光标所在单元格设成 `CellSelection` 再调 `deleteRow` / `deleteColumn`；
3. 三道守卫：`row === 0` → 表头行不许删；`map.height < 3` → 至少留一行内容行；`map.width < 2` → 至少留一列；
4. 结果分类回传 `'ok' | 'none' | 'header' | 'last'`，由 `EditorToolbar` 弹对应 toast
   （「表头行不能删除，表格必须有一行表头」/「至少保留一行内容行」/「至少保留一列」）。

**验证**：`stage4-toolbar` 补 2 条断言（光标在表头行时删行不动表格 / 删不掉时给出提示）→ **52/52**。

## 三、B Mermaid：正文只出图，点击才开源码

原来是 Decoration.widget 叠在代码块上 —— 源码仍在正文里，块手柄 / 拖动排序认不到那层。
改成 `$view` NodeView（挂在 `codeBlockSchema.node` 上按 `attrs.language` 分流）：渲染出的 SVG 就是**块自己的 DOM**，
块手柄 / 拖动排序 / 删除照旧可用；`ignoreMutation` + `stopEvent` 全开，PM 不重画。

点击 → `MermaidPanel.vue`（textarea 源码 + 实时预览，260ms 防抖，Esc 关）；**点「完成」才回写**
（`tr.replaceWith(pos+1, …)`）。落盘仍是 ```mermaid 代码块，**数据模型一个字节没改**，暗/亮模式切换会重绘。

**验证**：探针 13 项全过（正文无 `<pre data-language>`、无源码文本、点击开面板、面板预填、实时预览、完成回写、
磁盘 md 仍是 ```mermaid、切主题重绘、控制台无错误）。

## 四、C 删除 / 解散 / 回收站

### 数据层（`storage/notes.ts`）
- **单篇笔记删除格式一个字节没动**（`.trash/<ts>-<rand>-<标题>.md` + 配对 `.assets`，frontmatter 记账）——
  改格式会破 `notes-e2e` 的 `deleted_from` 断言，且属于「写坏用户数据」。
- **文件夹删除是新增形态**：整棵子树作为一个整体移进 `.trash/<YYYYMMDD-HHMMSS>_<原文件夹名>/`，
  内含 `.donote-origin`（内容＝原相对路径），用于还原回原位。
- **解散**（`foldersApi.remove`）保持不变：内容上移到上一级、文件夹本身消失。**两个动作并存、互不替代。**
- 回收站顶层条目 = 一次删除操作的整体；30 天从**各条目自己的 `deletedAt`** 起算（笔记取 frontmatter，
  文件夹取名字里的时间戳，兜底 mtime），整条一起到期一起清。
- 新增：`listTrashEntries` / `restoreTrashEntry` / `restoreTrashChild` / `purgeTrashEntry` / `purgeTrashChild` /
  `trashNoteHasAssets` / `purgeExpiredTrash(days)`。
- 单独恢复子项：笔记连 `.assets` 一起走；原父目录**在**就回原处，**不在**就落到**根**，不自动造父目录；
  原位置被占 → **放弃恢复**（与单篇恢复同口径，不自动改名、不落到别处）。

### UI
- `SidebarTree.vue`：桌面右键 + 触屏 ⋯ 按钮共用一份贴节点 popover（z-index 21，入场 300ms 弹簧，点外面关）。
  文件夹 7 项 / 笔记 5 项 / 空白区 3 项。二次确认文案按任务书模板。
- `TrashView.vue` + `TrashNode.vue`：平铺改**树形可展开**，每节点独立「恢复」/「彻底删除」；
  行仍是 `.row-card`、按钮文案仍是「恢复」「彻底删除」（`notes` / `actions` / `stage7` 三套断言依赖它们）。
- **平铺多选（长按/勾选 + 批量条）已去掉** —— 由树形 + 每节点独立按钮替代；回归未覆盖多选，272 项不受影响。
- 单独恢复「带非空 `.assets` 的笔记」时弹确认；**整条恢复不弹**（`actions-e2e` 要求点「恢复」后 3 秒内回原位）。

**验证**：探针 29/29（菜单三项齐、整条进 `.trash/20261014-123612_原名/` + `.donote-origin`、树形展开、
子项单独恢复/彻底删除、整条回原位、解散仍上移）。

## 五、D 导入按钮

侧栏顶部（新建笔记旁）+ 笔记列表页顶栏 → `ImportDialog` 二选一（选文件 / 选文件夹）→ 系统对话框。
**与拖放共用同一份 `importItems()`**（多个 `.md` 各成一篇 / 文件夹递归 / 重名由 `notesApi.create` 的 `uniqueRel`
加后缀）；新增 `ImportOptions.baseFolderId`，让「在此导入」落到指定文件夹。

**踩坑**：导入走 `notesApi.create` **不经过 `dataVersion`** → 侧栏树不自动刷；且 `<SidebarTree ref>` 写在 `v-for` 里
时**模板 ref 拿不到实例** → 改成 `defineExpose({ refresh })` + 直接声明的 ref，导完显式 `refresh()` + 重算标签。

**验证**：探针 13/13（同名两篇加后缀且正文各不串、frontmatter title 决定文件名、「在此导入」落到指定文件夹）。

## 六、E 回收站自动清理

- 设置页：开关（默认**开**）+ 保留天数（默认 **30**，夹在 **1–30**）+「下次清理时间」，存 `localStorage`。
- 触发点**只有两个**：应用启动、打开回收站；**不做定时任务**；同会话 60 秒内只真跑一次（节流）。
- 静默：失败一律吞掉不弹错；遇 **503**（坚果云 `BlockedTemporarily`）跳过、下次再清；多项分批 + 200ms 间隔。

**验证**：探针 20/20（默认开 + 30 天；天数夹到 1–30；关掉后启动与开回收站都不清；开回后 40 天前被清、刚删的保留）。

## 七、F2 弹层一致性（`docs/ui-audit.md`）

**当场统一**：底部弹层抄了四份（z-index 抄出 21 与 25 两个值）→ 抽成 `styles/app.css` 全局 `.sheet-*`；
`MoveDialog` / `NoteEditView` 各自抄的 `.folder-list / .folder-pick` 删掉改用全局那份；
侧栏 popover 入场补成 300ms 弹簧；规范补两条（22 归「遮罩 + 单面板」编辑类 Modal；popover 不铺遮罩，改「点外面关」）。

**5 条待办**（改动大，只记录）：
1. 编辑器内部 14/15/16 三层没细分（规范只写「12–16」）
2. 图标按钮尺寸无规格（32 / 46 / 22 / 38）
3. 「居中于内容列」两种写法（`padding-left` vs `left + translateX`）
4. `BatchToolbar` 的批量移动与 `MoveDialog` 语义不同，未合并
5. toast 只有一档（够用，不加）

## 八、回归与验证

```
9 套｜PASS 272｜FAIL 0｜用时 327s（预估 321s）  全绿
notes 47 / attach 39 / life 25 / stage2 24 / stage4 52 / stage5 11 / stage6 24 / stage7 27 / actions 23
```

`stage4-toolbar` 断言 45 → 47（表格表头两条）→ 52（Mermaid 八条替换掉旧的「思维导图」断言，`estSeconds` 31 → 38）。
`pnpm --filter @donote/web typecheck` 与 `build` 均通过；构建产物里核到 `.sheet-mask{…z-index:21…}` 没丢。

## 九、未验部分

桌面端 Tauri 的**文件夹递归导入**与**保存对话框**在浏览器里验不了（走退化路径），只验到汇合后的 `importItems`。
