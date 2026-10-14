# 弹层一致性检查（本批收尾）

> 依据 `docs/ui-patterns.md`。检查范围：本批新增的 A–E 全部浮层 + 既有全部浮层。
> 结论分两类：**已直接统一**（改动小）与**待办**（改动大，只记录不动手）。

---

## 一、本批新增的浮层：逐项对照

| 任务 | 新增浮层 | 形态是否合规 | 结论 |
|---|---|---|---|
| A 表格增删 | 无新浮层（只用 toast 报「表头行不能删除」） | ✅ 提示三档选对了（不需要回应 → toast） | — |
| B Mermaid | `MermaidPanel.vue`（源码 + 实时预览） | ✅ 遮罩居中、`.glass`、`--content-offset` 居中于内容列、Esc 关；但用了 `z-index: 22` | 规范把 22 写成「只有 AppDialog」。**已把规范改成「22 = AppDialog 及等价的编辑类 Modal」**（它与 AppDialog 不会同屏出现） |
| C 侧栏菜单 | `SidebarTree.vue` 的贴节点 popover | ✅ 贴节点、不铺满、不压暗；`z-index: 21` | 入场动画原来只有 opacity，**已补成 300ms 弹簧曲线**，与其它浮层一致 |
| C 回收站弹层 | `TrashView.vue` 的 `.sheet-mask` | ✅ 21 / `.glass` / 内容列居中 / `<Transition name="sheet">` | 样式与 `NoteActionMenu` 完全重复 → **已抽成全局一份** |
| C 二次确认 | 「这篇笔记有附件」/「彻底删除」用 `AppDialog` | ✅ 需要用户回应 → AppDialog（22） | — |
| D 导入 | `ImportDialog.vue`「导入什么？」二选一 | ✅ `AppDialog` 的「非警示」用法（正文放两个选择按钮、`confirm-label="取消"`） | 规范里没写过这个形态 → **已补进组件清单** |
| D 移动 | 抽出的 `MoveDialog.vue` | ✅ 复用全局 `.folder-list / .folder-pick` | 但它自己又抄了一份 `.folder-*` → **已删，改用全局那份** |
| E 自动清理 | 设置页开关 + 步进器（inline，不是弹层）；说明用 `.hint` inline | ✅ 符合「提示三档」的 inline | 开关是本项目第一个开关，就地实现（`role="switch"`），已记入待补组件 |

---

## 二、既有浮层：清出来的不一致

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 1 | `NoteActionMenu` / `TrashView` / `FoldersView` / `NoteEditView` | 底部弹层样式**抄了四份**，`z-index` 抄出 **21 与 25 两个值**；`FoldersView` 的 `.sheet-item:hover` 少了 `:not(:disabled)`，`NoteEditView` 缺 `.sheet-title` | **已统一**：抽成 `styles/app.css` 的全局 `.sheet-*`（z-index 21 + 入场动画），四份副本全删；`FoldersView` 里「先关 sheet 再开对话框」的注释随之更新（不再需要，但保留收尾动作） |
| 2 | `MoveDialog` / `NoteEditView` | 各自抄了一份 `.folder-list / .folder-pick`，而 `app.css` 里**本来就有全局一份**（注释还写着「放全局而不是各自 scoped」） | **已统一**：两处只保留各自独有的变体（`.indent` / `.is-on`） |
| 3 | `SidebarTree` 的 popover | 入场只有 opacity，与规范「300ms 弹簧曲线」不符 | **已统一** |
| 4 | `MermaidPanel` | 22 与规范里「唯一用 22 的是 AppDialog」冲突 | **改规范**（见上）：22 归「遮罩 + 单面板」的模态，不只 AppDialog |
| 5 | 贴节点 popover 无遮罩 | 规范只写了「遮罩 rgba(0,0,0,.38–.42)」，没写 popover 的例外 | **规范补例外行**：popover 不铺遮罩，改「点在外面就关」 |
| 6 | 编辑器内部 14/15/16 | `BlockHandle` 手柄 14 / 菜单 15 / 子菜单 16 挤在一个区间，规范只写了「12–16」 | **待办**：要细分得动编辑器核心，本批不碰。现状能工作（三个数彼此有序），只是规范没表达清楚 |
| 7 | 图标按钮尺寸 | `AppHeader` 32 / 窗口按钮 46 / 树内 `act` 22 / 侧栏新按钮 38 / 浮层关闭按钮各异 | **待办**：没有统一规格，本批不定标准 —— 先记下来，等真出现「同屏两个尺寸不同的同类按钮」再谈 |
| 8 | 居中于内容列的两种写法 | `.sheet-mask` 用 `padding-left: var(--content-offset)`；`BatchToolbar` 的 `.bar` 用 `left + translateX` | **待办**：两种各自都对（前者把 transform 留给子元素的入场动画，后者自己要用 transform 居中），但同一份规范里出现两种口径容易抄错。合并需要抽一个「居中容器」抽象，改动面大 |
| 9 | `BatchToolbar` | 它的 `AppDialog`（移动到…）与 `MoveDialog` 是同一件事的两份实现（自己内联了目标列表） | **待办**：`BatchToolbar` 的移动是「批量 + 支持根目录」，`MoveDialog` 是「单条 + 未归类」，文案与目标集不同，合并要先统一语义。本批只统一了单条那两处 |
| 10 | `.toast` 只有一档 | 成功 / 失败 / 可撤销共用一种样式，靠时长区分 | **待办**：目前够用（规范已注明「够用则不加」），不加 |

---

## 三、验证

- `pnpm --filter @donote/web typecheck` 通过。
- `pnpm --filter @donote/web build` 通过；构建产物里核到 `.sheet-mask{…z-index:21…}`、
  `.sheet-item{…}`、`.sheet-enter-from .sheet,{transform:translateY(100%)}` —— 抽到全局后没丢样式。
- 回归：全套 9 套 mock 全绿（详见本批汇报）。改动集中在样式层，四个底部弹层的行为断言
  （`actions` 的回收站右键菜单、`notes` 的回收站行内按钮）都仍然通过。

## 四、一句话结论

本批新增的浮层**没有引入新的形态**：侧栏是 popover、内容区是 bottom sheet、需要回应的用 AppDialog。
真正的问题在既有代码里 —— 同一套底部弹层被抄了四份、`z-index` 漂到 25，以及全局 `.folder-*`
被两处重复定义。这三类已当场统一；剩下 5 条待办都需要先统一语义或抽象出组件，不在本批范围内。
