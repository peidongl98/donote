# walkTree 的 PROPFIND 策略核实

> 2026-10-12。只读核实，不改代码。不启动应用、不连真实坚果云（避免限流）。
> 所有结论都给了代码位置；标〔实测〕的来自批次 4 阶段的真实坚果云探测记录（本地文档留档），
> 本次没有重连坚果云复测。

## 结论先行

**「改成 Depth: 1」这个前提不成立 —— 代码现在用的就是 `Depth: 1`。**

DAV 的 `Depth` 语义是「**往下走多深**」，不是「第几层」：

| Depth 值 | 含义 | 本项目用途 |
|---|---|---|
| `0` | 只返回该资源自身，不含子项 | `stat()`、`propfindStatus()` |
| `1` | **返回该资源 + 直接子项**（一层） | `list()` ← **walkTree 走的就是这条** |
| `infinity` | 递归返回整棵子树 | **没有一处代码在用** |

要「一次拿整棵树」只能用 `Depth: infinity`，而**坚果云把它静默降级成 `Depth: 1`**〔实测〕
（`docs/cache-rework-plan.md:68`、`docs/batch4-report.md:61`：返回的 207 与 `Depth: 1` **逐字节一致**）。

所以：**请求数 = 1 + 目录数，是协议与坚果云实现共同决定的，改不掉。**
不存在「按层遍历把 31 目录降到 3-5 次」这条路 —— 3-5 次这个数只有 `Depth: infinity` 能给。

## 1. walkTree 现在的实现

`apps/web/src/storage/notes.ts:120-151`：

```ts
const MAX_DIRS = 300;   // :116
const MAX_DEPTH = 8;    // :117

async function walkTree(): Promise<Tree> {          // :120
  const acc: Tree = { notes: [], dirs: [] };
  let frontier = [{ rel: '', depth: 0 }];            // 从同步根开始
  let visited = 0;

  while (frontier.length && visited < MAX_DIRS) {
    const group = frontier.splice(0, 4);             // 同层并发 4
    const results = await Promise.all(
      group.map((item) => listDir(item.rel).catch(() => [])),   // ← 每个目录一次 listDir
    );
    const next = [];
    results.forEach((entries, index) => {
      visited++;
      for (const entry of entries) {
        if (entry.name.startsWith('.') || isAssetsDir(entry.name)) continue;
        if (entry.isDirectory) {
          acc.dirs.push(entry);
          if (depth + 1 < MAX_DEPTH) next.push({ rel: entry.path, depth: depth + 1 });
        } else if (entry.name.toLowerCase().endsWith('.md')) acc.notes.push(entry);
      }
    });
    frontier = frontier.concat(next);
  }
  return acc;
}
```

调用链：`walkTree()` ← `tree()`（`:163-176`）← `notesApi.list()`（`:372`）与 `foldersApi.list()`（`:580`）。
`tree()` 有 3 秒模块级缓存 + 并发合并（`treeCache` `:154`、`treePending` `:156`），
所以同一次页面加载里列表页与文件夹页共用**一次**遍历。`invalidateTree()`（`:159`）只作废模块缓存。

`listDir`（`:91-94`）是一层薄封装：`getStorage().list(rel)`。

## 2. Depth header 实际值

全仓只有三处发 PROPFIND（`apps/web/src/services/storage/webdav.ts`）：

| 方法 | 行号 | Depth | body |
|---|---|---|---|
| `list(path)` | `:292-301` | **`'1'`**（`:297`） | `PROP_BODY`（`:33`，取 `resourcetype` / `getlastmodified` / `getetag`） |
| `stat(path)` | `:406-416` | `'0'`（`:412`） | `PROP_BODY` |
| `propfindStatus(absPath)` | `:281-287` | `'0'`（`:284`） | 无 body，只取状态码 |

**`infinity` 在代码里 0 处出现。** `walkTree` 每遇到一个目录就调一次 `listDir` →
一次 `Depth: 1`。31 个目录 = 31 次，与实测吻合。

## 3. 逐目录设计的原因

**不是设计选择，是协议所迫 + 缓存层依赖，两条都成立。**

### 3.1 协议层

`Depth: 1` 只覆盖**一层**。子目录的内容必须再对子目录发一次请求才能拿到。
要一次拿完只能 `Depth: infinity` —— 不可得（第 4 节）。

### 3.2 缓存层的对账口径**是按目录**建的

这一条更硬，不是「顺便」：

- `checkedAt: Map<string, number>`（`cached-adapter.ts:98`）—— **「这个目录」上次校验是什么时候**，
  一条目录一个时间戳，落盘在 `folders.checked`（`:120` / `:159`）。
- `LIST_TTL_MS = 60_000`（`:70`）：`enqueue(path)`（`:463-471`）按目录判「60 秒内不重复校验」。
- `fetchDir(path)`（`:452-459`）：列完**这一层**后 `this.checkedAt.set(path, Date.now())`，
  再用 `reconcile(path, entries)`（`:500-558`）给**这一层**的索引对账 ——
  里面「云端已经没有的条目要删掉」这一步由 `this.listed.has(dir)` + `directChild(rel)`
  **双重保护**（`:534-553`），就是因为「一次 PROPFIND 只敢对一层负责」。

### 3.3 驱动这一切的事实：目录的 `getetag` 是空的

〔实测〕`docs/cache-rework-plan.md:63-66`：
- 集合（目录）的 `getetag` 是 **`<d:getetag/>` 空元素，没有值**；
- 文件有真 etag（22 字符）；目录的 `getlastmodified` **不随子项变化**。

→ 目录「变没变」**无法**用指纹判断，只能**把那层列一遍再看结果**。
这就是「校验一个目录 = 1 次 `PROPFIND Depth: 1`」这个口径的来源（同文档 `:155-165`）。

### 3.4 结论

`reconcile()` 的 flat 解析本身对多层响应并不敏感（`parseMultistatus` 的 `rel` 是相对同步根算的），
但**「这一层的校验时刻」这个概念本身**在多层级响应下无处落脚：
一次 infinity 响应覆盖了 N 个目录，`checkedAt` 该记在哪几个 key 上？`directChild` 的保护前提也随之失效。
**改按层 = 要重做缓存层的对账口径，不是改 walkTree 内部一行。**

## 4. 改成 Depth: 1 的可行性

- **「Depth: 1 能一次返回子目录 + 子文件吗」** → 能，而且**现在就是这么用的**，
  这就是 `list()` 的全部行为（`webdav.ts:292-319`）。
- **「坚果云支持 Depth: 1 吗」** → 支持，这是当前唯一能用的列目录方式。
  被降级的是 `Depth: infinity`（\*→1）〔实测〕。
- **所以「改成 Depth: 1」没有可改的东西**：它已经是 Depth: 1。
- **如果真要让一次请求覆盖多层**：只有 `Depth: infinity`。这条不可得 ——
  坚果云的返回与 `Depth: 1` **逐字节一致**，不是「部分支持」或「慢」，是**被忽略**。
  验收台的假 DAV 也是按这个行为对齐的（`docs/regression-harness.md:61`：
  「`Depth: infinity` → 降级成 `1`；坚果云就这么干；也是『冷启动 1 次请求』做不到的原因」）。
- **边界情况**：`walkTree` 已用 `catch(() => [])` 吞掉单目录失败（权限、瞬时 5xx 都不会中断整棵树），
  并有 `MAX_DIRS = 300` / `MAX_DEPTH = 8` 护栏。这两条在按层方案里同样要保留，不是新问题。

## 5. 改造后请求量估算

| 方案 | 31 目录 / 4 层 的 PROPFIND | 可得性 |
|---|---|---|
| 现状（逐目录 `Depth: 1`） | **31** | 已在跑 |
| 「按层」设想（`Depth: infinity`） | **1** | ❌ 坚果云降级，拿不到 |
| 懒加载（只拉展开的层） | 初始 **1**，每展开一个目录 **+1** | ✅ 可得，但要另建一套机制 |

**上限照旧**：任何方案都受 `1 + 目录数` 约束 —— 懒加载省的是「不去碰没展开的分支」，
不是把「31」变成「3-5」。31 对应的是**目录数量**，与层数（3 层还是 4 层）无关。

另注：上面 31 是最坏情况（目录校验时刻已过 60 秒 TTL，要整树重新对账）。
TTL 内冷启动走本地索引，**0 次网络请求**，请求全部移进后台队列（批次 4 的成果）。

## 6. 建议

**优化 `walkTree`：不可行**（请求数由协议决定，没有可压缩的空间；能动的只有「什么时候发」，
批次 4 已经做成「本地先出、后台校验、60 秒 TTL 去重」）。
**上懒加载：不必。**

理由：侧栏方案（`docs/sidebar-tree-plan.md`）已定为**全量拉整棵树**，它调的是已有的 `tree()`，
与列表页共用同一次遍历 —— **首屏和笔记详情页的增量是 0**（10 目录 10→10、31 目录 31→31）。
换成懒加载能省的只有「冷启动**直接落在** `/trash` 或 `/settings`」这一种页面的那一次遍历，
代价是另开一套逐层列举 API + 每个展开节点的 loading / 失效状态，并让 `tree()` 的 60 秒 TTL 去重失效。
按简单优先，不值当。

→ **walkTree 不动，侧栏按全量实现。**

## 7. [待确认]

1. **「3-5 个请求」这个预期来自哪里？** 如果是按「层」估算的，那它对应的 DAV 能力是 `Depth: infinity`，
   坚果云不提供；如果是别的数据源或别的客户端给的经验，请说一声，我按那个前提重新核。
2. 本文件的「坚果云降级 `Depth: infinity`」引的是**批次 4 阶段的实测留档**（`docs/cache-rework-plan.md:68`、
   `docs/batch4-report.md:61`），**本次没有重连真实坚果云复测**（按任务约束：不连真实坚果云）。
   若这条前提需要重新取证，需要你允许连一次真实坚果云（一次 PROPFIND，配额代价可忽略）。
3. `MAX_DIRS = 300`：超过 300 个目录时 `walkTree` 会**提前截断**（列表页现在就被这个上限约束，
   侧栏树同理）。你的实际目录数若可能越过，需要单独提一版改造。
