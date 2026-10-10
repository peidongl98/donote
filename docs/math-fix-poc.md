# 阶段 0：公式 `\,` 被吃 —— 调研与修复 POC

> 分支 `poc/editor` ｜ 日期 2026-10-11 ｜ 结论：**已修复，方案可行，可以进入阶段 1**

---

## 一、结论（先读这段）

1. **修好了。** 含 7 种 LaTeX 间距写法的公式文件，加插件后「打开 → 不改 → 保存」**逐字节一致**（1305 → 1305 字节，差异行 0）；对照组（不加插件）1305 → 1278，14 行差异。
2. **根因不是 remark-stringify。** 是 Milkdown 的 commonmark / gfm 预设里**根本没有公式**，`$$…$$` 被当成普通段落文字，走到了 CommonMark 的「反斜杠转义」规则上 —— `\,` 里的逗号属于 ASCII 标点，是合法转义，反斜杠在**解析**阶段就被吃掉了。序列化器看到的已经是 `,`，它没做错任何事。
3. **`@milkdown/plugin-math` 在 7.22.3 里不存在**（该包停在 7.5.9），装不上。7.22.3 这一代的公式能力在 `@milkdown/crepe` 的 `feature/latex` 里。
4. **最终方案是自己注册 math 节点**：用 `remark-math` 让 `$…$` / `$$…$$` 成为真正的 mdast 节点，再写两个 ProseMirror schema。序列化交给 `mdast-util-math`，它把 `node.value` 原样写回。
5. **只新增 1 个依赖**：`remark-math@6`（解包 12.9 KB）。不引入 Crepe 的 core / CodeMirror / KaTeX。

---

## 二、根因

`\,` `\:` `\;` `\!` 的共同点是：**反斜杠后面跟的是 ASCII 标点**。CommonMark 规定反斜杠在这些字符前构成转义，解析时反斜杠被消耗。

对照组的全量 diff 把这些一次看全（`poc/fixtures/公式.md`）：

```diff
-细间距 `\,`：$a \, b$ 与 $x^2 \, dx$
+细间距 `\,`：$a , b$ 与 $x^2 , dx$
-中等间距 `\:`：$a \: b$
+中等间距 `\:`：$a : b$
-粗间距 `\;`：$a \; b$
+粗间距 `\;`：$a ; b$
-负间距 `\!`：$a \! b$
+负间距 `\!`：$a ! b$
-$$
-\begin{pmatrix} a \, b \\ c \: d \end{pmatrix}
-$$
+$$
+\begin{pmatrix} a , b \ c : d \end{pmatrix}
+$$
```

注意最后一条：**矩阵的换行符 `\\` 被吃成了 `\`**。这比 `\,` 严重得多 —— 矩阵直接散架。这个症状在之前只测 `\,` 的时候没暴露出来。

反过来，下面这些**没被吃**（也是对照组实测）：`\ `（反斜杠+空格）、`\quad`、`\qquad`、`\frac`、`\alpha` —— 因为它们后面跟的不是标点。

## 三、调研：7.22.3 这一代有什么现成的

| 候选 | 结论 |
|---|---|
| `@milkdown/plugin-math` | **不存在**。npm 上最新版本是 7.5.9，没有 7.22.3 |
| `@milkdown/plugin-diagram` | 同样不存在于 7.22.3（停在 7.7.0）。阶段 3 的思维导图不要依赖它 |
| `@milkdown/crepe/feature/latex` | **存在**，且 crepe 本来就是 `@milkdown/vue` 的传递依赖（已在 `node_modules` 里）。但它 `import` 时会抛 `You need to enable CodeMirror to use LaTeX feature`，等于必须带上 Crepe 的 core + CodeMirror + KaTeX + dompurify + lodash-es |
| `remark-math@6` | 存在，12.9 KB。Milkdown 侧只要 `$remark` + `$nodeSchema` 两个宏就能接上 |

Crepe 的 latex feature 源码（`@milkdown/crepe/src/feature/latex/`）是可读的 TypeScript，正好当参照：

- `inline-latex.ts` → `mathInlineSchema`，`toMarkdown` 里 `state.addNode('inlineMath', undefined, node.attrs.value)` —— 值原样写回。
- `block-latex.ts` → 扩展 `codeBlockSchema`，把 `lang === 'LaTeX'` 的代码块序列化回 `math` 节点。
- `remark.ts` → 把块级 `math` 节点转成 `lang: 'LaTeX'` 的 code 节点（因为 Crepe 没有独立的 math block schema）。

## 四、选定方案

**走 Crepe 的思路，但不带 Crepe 的包袱。**

`apps/web/src/poc/math-poc.ts`（阶段 0 的 POC 版，阶段 2 会重写进 `components/editor/`）三件东西：

1. `$remark('pocRemarkMath', () => remarkMath)` —— 让 remark 认识 `$…$` 与 `$$…$$`。
2. `math_inline` schema（`atom: true`）—— 行内公式，值存在 `attrs.value`。
3. `math_block` schema（`content: 'text*'`，`code: true`）—— 块级公式。

序列化两头都交给 `mdast-util-math`：它读 `node.value` 原样输出，`math(node)` 的实现是

```js
const sequence = '$'.repeat(Math.max(longestStreak(raw, '$') + 1, 2))
// … 输出 sequence + '\n' + raw + '\n' + sequence
```

**与 Crepe 的两处有意差异**：

| | Crepe | 本方案 | 原因 |
|---|---|---|---|
| 块级公式的载体 | 转成 `lang: 'LaTeX'` 的**代码块**，靠 CodeMirror 承接 | 独立 `math_block` 节点 | 不必为了公式拉进整个 CodeMirror |
| 取值的写法 | `node.content.firstChild?.text` | `node.textContent` | `firstChild` 只取**第一个**文本子节点，多行公式会被截断。`textContent` 拼接全部子节点 |
| 渲染 | KaTeX 实时渲染 + 编辑浮层 | **本轮不渲染**，只显示原文 | 本轮目标是「保存保真」。渲染方案见 §七 |

## 五、测试数据

测试方法沿用批次 1c 的口径：**记录 md5 → 打开 → 不修改 → 触发一次保存 → 记录新 md5**。三层交叉验证（浏览器写日志 / `fs.watch` / 磁盘 md5+mtime）。

### 5.1 公式文件逐字节对比

`poc/fixtures/公式.md`（1305 字节），覆盖 7 种间距写法：

| 写法 | 例子 | 加插件后 | 对照组（不加插件） |
|---|---|---|---|
| `\,` | `$a \, b$` | ✅ 保留 | ❌ → `$a , b$` |
| `\:` | `$a \: b$` | ✅ 保留 | ❌ → `$a : b$` |
| `\;` | `$a \; b$` | ✅ 保留 | ❌ → `$a ; b$` |
| `\!` | `$a \! b$` | ✅ 保留 | ❌ → `$a ! b$` |
| `\ `（反斜杠+空格） | `$a \ b$` | ✅ 保留 | ✅ 保留 |
| `\quad` / `\qquad` | `$a \quad b \qquad c$` | ✅ 保留 | ✅ 保留 |
| `\\`（矩阵换行） | `\begin{pmatrix} a \\ b \end{pmatrix}` | ✅ 保留 | ❌ → `\begin{pmatrix} a \ b \end{pmatrix}` |

**结果**：

```
[milkdown] 公式.md  逐字节一致=true  1305→1305 字节  差异行=0     ← 加了 math 插件
[milkdown] 公式.md  逐字节一致=false 1305→1278 字节  差异行=14    ← 对照组
```

多行 `aligned` 环境（三行带 `\\` 换行）也逐字节一致 —— 这是刻意避开 Crepe 那个 `firstChild.text` 截断写法的地方。

### 5.2 美元符号边界

加公式解析的风险是「普通文本里的 `$` 被误当成公式」。`poc/fixtures/美元边界.md` 专测这个：

| 场景 | 结果 |
|---|---|
| `售价 $100，那件 $200` | ✅ 不当成公式 |
| `成本 $5 元，利润 $2 元` | ✅ 不当成公式 |
| `从 $10 涨到 $20` | ✅ 不当成公式 |
| `行内代码 \`$HOME\`` | ✅ 不当成公式 |
| 代码块里的 `$ npm install` | ✅ 不当成公式 |
| 表格单元格里的 `$10` | ✅ 不当成公式 |
| `$S = \pi r^2$`（真公式） | ✅ 正确识别 |
| `$3$` / `$3 + 3 = 6$`（单个 `$` 包裹） | ✅ 正确识别 |

唯一的改动是**孤立 `$` 被转义成 `\$`**：

```diff
-美元符号 $ 单独出现。
+美元符号 \$ 单独出现。
```

这是 `remark-math` 把 `$` 登记进 `unsafe` 之后的正常输出。**渲染结果完全一致**（逐行比对 markdown-it 产物，38 行对 38 行，0 差异）。

### 5.3 全量回归

| 文件 | 不加 math | 加 math |
|---|---|---|
| 基础语法.md | 1113→1121（11 行） | 1113→1122（10 行） |
| 外部修改-符号变更.md | 1113→1121（5 行） | 1113→1122（4 行） |
| 外部修改-空行调整.md | 1107→1121（61 行） | 1107→1122（61 行） |
| 外部修改-行尾空格.md | 1129→1121（19 行） | 1129→1122（18 行） |
| 外部修改-编辑器规范.md | 1137→1121（11 行） | 1137→1122（10 行） |
| 极端.md | 1517→1554（71 行） | 1517→1554（71 行） |
| 公式.md | 1158→1136（11 行）❌ | **逐字节一致** ✅ |
| 空文件.md | 0→0 ✅ | 0→0 ✅ |

每个含公式的文件**恰好少 1 行差异、多 1 个字节**（多出来的就是被保住的那个反斜杠）。其它文件的规范化和批次 1c 记录的一致，没有新增。

渲染比对（markdown-it 渲染后逐行 diff，0 = 完全一致）：

| 文件 | 加 math 后 |
|---|---|
| 基础语法 / 符号变更 / 空行调整 / 行尾空格 / 编辑器规范 | **0** |
| 极端 | **0** |

**加了公式支持，没有让任何一份文件的渲染结果发生变化。**

### 5.4 构建

`pnpm build` 通过（15.85s），无 warning 级以上的问题。`remark-math` 正常打包。
另外确认：**Milkdown 目前还没进生产包** —— POC 路由挂在 `if (import.meta.env.DEV)` 下，生产构建里根本不生成这两个 chunk。

## 六、副作用与已知边界

| 项 | 说明 |
|---|---|
| 孤立 `$` 会被转义成 `\$` | 渲染等价，属可接受的写法规范化 |
| 公式内 `$$` 连续出现时的定界符 | `mdast-util-math` 会自动把定界符加长到比内容里最长的 `$` 串多一个。原文若本来就用 `$$$$` 之类的写法，会被规范化 |
| **公式不渲染** | 编辑器里显示的是原始 LaTeX 文本（等宽字体、浅底）。见 §七 |
| 依赖 | 新增 `remark-math@^6.0.0`（唯一新增依赖） |

## 七、待确认

**公式在编辑器里要不要渲染成排版后的样子？**

| 选项 | 代价 | 效果 |
|---|---|---|
| A. 不渲染（当前状态） | 0 | 显示原始 LaTeX。保存保真已经达标，但「所见即所得」名不副实 |
| B. 接 KaTeX | 新增 `katex`（JS 约 280 KB / CSS 约 23 KB，**已在 pnpm store 里**，是 crepe 的传递依赖）。按需 `import()` 可避免拖慢首屏 | 行内公式渲染成排版结果，块级公式渲染成居中公式。编辑时仍需点开看源码 |
| C. 直接用 Crepe 的 latex feature | 要连带 Crepe core + CodeMirror + dompurify + lodash-es | 有现成的行内编辑浮层，但会把整个 Crepe 栈拉进来 |

本轮按任务书范围只做了「保存保真」，没有自作主张接 KaTeX。倾向 B，但等确认。

**在确认之前不进入阶段 1**（本阶段已达成任务书要求的「方案可行 → 继续」条件，等的是渲染这一项）。

## 八、附件

| 附件 | 位置 |
|---|---|
| 公式 fixture | `poc/fixtures/公式.md`、`poc/fixtures/美元边界.md` |
| 逐字节对比原始输出 | `.workbuddy/tmp/donote/stage0-final.out`、`stage0-nomath.out` |
| 对照组全量 diff | `.workbuddy/tmp/donote/untouched-milkdown-nomath-公式.md` |
| 编辑器截图 | `.workbuddy/tmp/donote/stage0-公式-math.png`、`stage0-公式-nomath.png` |
| POC 实现 | `apps/web/src/poc/math-poc.ts` |
| 构建日志 | `.workbuddy/tmp/donote/stage0-build.log` |
