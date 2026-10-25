# 多级列表：层级、外观、折叠

> 2026-10-25。判据一句话：**结构进 `.md`，外观由显示层决定，折叠只在内存里。**

## 一、三件事各存在哪

| | 存在哪 | 为什么 |
|---|---|---|
| 层级（缩进 / 嵌套） | 标准 Markdown 列表嵌套 | 换任何编辑器都能读，别的工具也认得 |
| 每级标记（`1.` / `a.` / `•`） | `apps/web/src/styles/list-style.css` | Markdown 里没有「用 a. 还是 1.」的写法，存进去也留不住 |
| 折叠状态 | 内存（ProseMirror 插件 state） | 同上：`.md` 没有位置放它，重开一律展开 |

**不设「列表样式」设置项**。样式不是数据、是程序的一部分 —— 所有设备、所有版本天然一致，
不用为它做同步，也不会出现「这台是 `一、`、那台是 `1.`」。代价是换样式要改 CSS 再发版。

> 备选（没采用）：把样式存进 `.donote/config.json` 或 frontmatter。前者要多一次启动请求、
> 多一条写入失败路径，并给「以后什么都往这文件里塞」开了先例；后者会被外部脚本改写文件时抹掉。
> Notion / Word 能做「单篇可选」，是因为它们有块属性 / 文档属性这一层，Markdown 没有。

## 二、层级：9 级，按命中规则的**最高特异度**算

CSS 里没有「这是第几层」这种查询，所以用**祖先列表的个数**当层数：

```css
:where(.donote-surface .ProseMirror, .md, .donote-export) :is(ul, ol) ol > li      /* 第 2 级 */
:where(...) :is(ul, ol) :is(ul, ol) ol > li                                        /* 第 3 级 */
```

每多一层就多一个 `:is(ul, ol)`，特异度 +1；一条 `li` 能同时命中第 1…9 级的所有规则，
**命中的最高那条生效**，所以实际层数算得对。`ul > li > ol` 这种混排也成立（`:is` 两种都算）。

- 无序：`• ◦ ▪` 三循环。
- 有序：`1. → a. → i. → 1) → a) → i) → (1) → (a) → (i)`。第 4 级起 CSS 没有现成的
  `list-style-type` 可用，改用 `::marker { content: counter(list-item)… }` 画；
  `list-style-type` 留着当退路（不支持 `::marker content` 的引擎退回 `1.`，不会错乱）。
- 缩进逐级递减（1.5em → 0.9em），9 级累计约 10em；固定 1.5em 会到 13.5em，窄屏写不下。
- **第 10 级 Tab 无效**（`MAX_LIST_DEPTH`），再缩下去行宽就没了，也没有新的视觉区分。

## 三、折叠：装饰，不动文档

- 三角在**行尾**（段落末尾的行内 widget），只出现在**有子级**的条目上，悬停显形。
  放行尾是为了不跟 `::marker` 抢那块空白 —— 标记位置在 CSS 里不可控。
- 折叠 = 给 `list_item` 挂 `is-folded` 类，CSS 把它的子列表 `display: none`。
- 位置会随编辑漂移，所以每次事务都要 `tr.mapping` 映射，映射后还得确认那个位置
  仍是「有子级的列表项」，否则丢弃（节点被删了）。
- **光标不许落进看不见的地方**：选区一进入被折叠的子树，那条自动展开（撤销 / 重做也靠这条兜住）。

## 四、三处渲染共用一份 CSS

编辑器（`.donote-surface .ProseMirror`）、源码预览（`MarkdownView` 的 `.md`）、
导出 HTML（`body.donote-export`）都吃 `styles/list-style.css`：

- 前两处：`main.ts` 全局引入。
- 导出：`import css from '@/styles/list-style.css?raw'`，同一份文本拼进 `<style>`。

⚠️ 别在这三处的组件样式里再写 `padding-left` / `list-style-type`：scoped 选择器特异度更高，
会把层级规则整片盖掉（`MarkdownView` 原来那两条已经因此删掉）。

## 五、顺带修掉的一处旧问题

Milkdown 的 `selectionUpdated` 是在**事务 apply 阶段**回调的，那一刻 `view.state` 还是上一份。
工具栏快照直接读 `view.state` 会慢一步：刚点进另一条列表项，「第 N 级」和加粗 / 斜体高亮
显示的都是上一条的状态。现在推到下一个微任务再刷新（`NoteEditor.vue`）。

## 六、验收

`scripts/regression/.artifacts` 下有截图；判据脚本（临时，不入库）：

- 9 级有序 / 4 级无序的 `list-style-type` 与 `::marker` 内容逐级正确；
- 缩进逐级递减、横向位置逐级右移；
- 折叠按钮只出现在含子级的条目上（10 个），点一下子列表 `display:none`，**且不产生任何请求**；
- `Tab` 在低层正常降级、在第 9 级不再加深；`Shift+Tab` 升回；
- `Alt+Shift+↑` 把整条（含子级）挪到前一个兄弟之前；
- 斜杠菜单「多级列表」插出三级骨架；
- 源码预览与导出 HTML 的标记与编辑器一致。
