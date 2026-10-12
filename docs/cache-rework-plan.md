# 缓存改造前核实 · 本地优先 + 后台校验

> 核实日期 2026-10-12｜基线：工作区代码（线上 0.2.3）
> 核实手段：读代码 + **只读探针**（`cache-probe.cjs` / `etag-probe2.cjs`，读同步根与 `.trash`；写操作只在一个点开头的临时文件上做，测完即删）+ 读本机真实缓存 `D:\DoNote\data\cache\`。
> 行号对应当前工作区文件。

---

## 1. cached-adapter.ts：哪些走缓存、哪些每次回源

### 1.1 `read()` —— 已经是本地优先

`cached-adapter.ts:228-253`：`options.preferCache` 为真且有副本 → 立刻返回副本，同时 `void this.revalidate(path)` 后台校验（`:256-275`）。没有副本或没传 preferCache → 回源。

调用面：只有 `storage/notes.ts:96-103` 的 `readOrNull(rel, preferCache)`，且只被 `notesApi.get()` 传 `true`（`storage/notes.ts:412`）。→ **只有「打开笔记看」走本地优先**；读改写（update/remove/restore）一律回源，这条必须保持。

### 1.2 `list()` —— **每次回源**，缓存只做断网兜底

`cached-adapter.ts:310-327`：

```ts
const entries = await this.inner.list(path);   // 先发 PROPFIND
this.merge(entries);
this.markOnline();
return entries;
// catch 里：仅 isOffline(error) 且 cachedEntries(path).length > 0 才用缓存
```

即：**先网络、失败才缓存**。列表页的等待时间就是网络往返时间。

为什么这么写：文件头注释（`:8`）把列目录的缓存定位为「网断了用 meta.json 里记的结构顶一下，让列表还能显示」——**离线兜底**，不是首屏加速。这是设计取向，不是技术限制；`cachedEntries()`（`:364-384`）已经能完整拼出任意一层的目录，改成首选不需要新能力。

### 1.3 `merge()` 只增不删，且不发数据变更通知

`cached-adapter.ts:329-361`：

- 只把 PROPFIND 回来的条目并进 meta / folders；
- **云端已消失的条目不会被移除** → 断网兜底可能显示已删除的笔记；
- 有变化时只 `scheduleSave()`，**不 `notify()`** → UI 无从得知后台变了。

### 1.4 结构变更对 `folders` 集合是漏的

| 方法 | 对 `meta.notes` | 对 `this.folders` |
|---|---|---|
| `delete` → `forget`（`:409-422`） | 删这一条 | **不动** |
| `move`（`:424-442`） | 把行搬到新路径 | **不动**（不重映射前缀） |
| `mkdir` / `ensureDir`（`:444-463`） | — | 加 |

→ 目录改名 / 删除后，`folders` 里会残留旧路径，`cachedEntries()` 会把它列出来。现在因为列表不是缓存优先，这个缺陷被网络结果盖住了；**一旦改成缓存优先，它会直接显示出来**，必须一并修。

### 1.5 状态通知在每次 `list()` 都会触发

`markOnline()` / `markOffline()`（`:131-139`）无条件 `notify()`，而 `list()` / `read()` / `stat()` 每次都调 `markOnline()`。→ 直接拿 `notify()` 驱动界面刷新会形成 `load → list → markOnline → notify → load` 死循环，必须分成两个信号。

---

## 2. 坚果云 PROPFIND 返回什么（实测）

请求体见 `webdav.ts:31-32`：`<prop><resourcetype/><getlastmodified/><getetag/></prop>`。

| 项 | 实测结果 |
|---|---|
| `getlastmodified` | **有**。格式 `Mon, 12 Oct 2026 08:38:26 GMT`（HTTP-date，**秒级**）→ `Date.parse` 后末位恒为 `000` |
| `getetag`（**集合/目录**） | `<d:getetag/>` —— **空元素，没有值** |
| `getetag`（**文件**） | **有真值**，22 字符 base64url，例 `VIO7s2UV58qYhsMMdzbdUA` |
| 文件 etag 语义 | **内容变 → etag 变**（`nHDalrTZ…` → `TtKNbcvB…`）；**同内容重写 → etag 稳定**（两次 PUT 同内容，etag 相同） |
| PUT 响应头 | **不带 ETag**（`null`） |
| `Depth: infinity` | **被静默降级为 `Depth: 1`** —— 返回的 207 与 Depth:1 完全一致，只有直接子项 |
| 目录的 `getlastmodified` | **不随子项变化**：`/DoNote/.trash` 的 mtime 是 10-09，而里面的文件被改到 10-10、10-12 |

### 结论

- **能用的校验量**：**文件的 etag**（可靠，是首选）+ 目录自身的 `getlastmodified`（只反映目录自身，不反映子项内容变化）。
- 一次 `PROPFIND Depth:1 <dir>` 就同时拿到该目录**所有直接子文件**的 etag 与 mtime → **校验一个目录只需 1 次请求**，不必逐文件 `stat`。
- ⚠️ **修正上一轮报告的结论**：`docs/STATUS.md` 与 0.2.3 报告里写的「坚果云 PROPFIND 不返回 getetag」是**只探了集合（根目录）得出的，对文件不成立**。当时还把校验退化成 mtime，代价是"每次打开都重拉全文"。本批次改用文件 etag 后，这一条代价可以去掉。

---

## 3. 回收站（trash）

### 3.1 列表数据从哪来

`storage/notes.ts:326-352` `listTrash()`：

1. `listDir('.trash')` → `getStorage().list('.trash')`（1 次 PROPFIND）
2. 对每个条目 `readOrNull(entry.path)` 取标题 / 摘要（**没传 preferCache** → 逐篇 GET，N 次）
3. `mapLimited(..., 4)`，最多 60 条

→ 打开回收站 = **1 + N 次请求**，且全部走网络。

### 3.2 有没有缓存

**没有独立的 trash 缓存文件**，但条目**会自动进 meta.json**：软删走的是 `CachedStorage.write('.trash/<名>.md')`，恢复走 `write(目标)` + `delete('.trash/<名>.md')`。本机实测 `D:\DoNote\data\cache\`：

```
meta.json      33 行，全部是 .trash/*.md（folder 字段全是 ".trash"）
folders.json   {"items":[".trash"]}
notes/         33 个文件，全部在 notes/.trash/ 下（软删笔记的正文还留在本地）
```

所以 `cachedEntries('.trash')` 能离线拼出回收站列表 —— **离线可看，但首屏仍要等网络**。

### 3.3 删除 / 恢复时缓存怎么处理

| 操作 | 云端 | 缓存层做完的 | 漏的 |
|---|---|---|---|
| 软删除 | `write('.trash/x.md')` + `delete(原路径)` | 新行进 meta；原路径行被 `forget` 删掉 | — |
| 恢复 | `write(目标)` + `delete('.trash/x.md')` | 目标行新建；`.trash` 行删掉 | — |
| 彻底删除 | `delete('.trash/x.md')` | 行删掉 | — |
| 目录改名 / 删目录 | `move` / `delete` | 笔记行跟着动 | **`folders` 集合不跟着动**（见 §1.4） |

---

## 4. 现有 meta.json 结构

`services/cache/meta.ts:22-40`：

```jsonc
{
  "version": 1,              // 版本对不上 / root 换了 → 整份作废
  "root": "/DoNote",
  "updatedAt": 1791793932074,
  "notes": {
    ".trash/1791653811792-b8or-未命名 2.md": {
      "title": "1791653811792-b8or-未命名 2",   // 只有 merge 过才填，否则空串
      "folder": ".trash",                      // 相对同步根的父目录路径
      "mtime": 1791653813000,                  // 毫秒数字，但值来自服务端秒级 HTTP-date
      "etag": "VIO7s2UV58qYhsMMdzbdUA",        // 文件有值；本地刚写完还没校正时为空串
      "cached": true,                          // 正文是否已落到 notes/
      "dirty": false                           // 有本地改动未推
    }
  }
}
```

`folders.json`：`{"items": [".trash"]}` —— 相对同步根的目录路径数组。

### 实测要点（本机 33 行）

| 判据 | 结果 |
|---|---|
| `version` 字段 | 有（`1`） |
| `etag` 字段 | 有 |
| mtime 粒度 | **秒级**（32/33 行 `% 1000 === 0`） |
| 唯一例外的那 1 行 | `mtime % 1000 !== 0` 且 `etag` 为空 → **本地 `write()` 写的 `Date.now()`，还没被 PROPFIND 校正过** |
| `dirty = true` | 0 行 | 
| `cached = false` | 0 行 |

⚠️ **`row.mtime` 有两个来源**：服务端 HTTP-date（秒级、真值）与本地 `Date.now()`（毫秒、写完后临时值，见 `cached-adapter.ts:287`、`webdav.ts:344`）。混在一起比 mtime 会让「本地刚写完的那篇」永远判为"变了"，每次都重拉全文。

---

## 5. 30 秒自检：方案可行吗？卡点在哪

**可行，但有 1 处目标落差要报，另有 3 处必须一并修的点。**

### 5.1 目标落差：「冷启动 1 次请求」做不到

`Depth: infinity` 被坚果云静默降级为 `Depth: 1`（实测），**没有「一次拿整棵树」的接口**。目录树只能按层遍历，请求数 = 1 + 目录数。

改造后能达到的是：

- **首屏 0 网络等待**：列表 / 笔记 / 回收站立刻用缓存渲染；
- **请求全部移到后台**，不阻塞界面；
- 加**目录级校验 TTL**（同一目录 N 秒内不重复校验）后，TTL 内重复导航 / 切页 = **0 请求**；
- 冷启动请求数与改造前**同量**（1 + 目录数），只是对用户不可见。

要让请求数真的降到 1，只能换协议能力（例如服务端提供整树清单），**不在本批次范围内**。

### 5.2 必须一并修的三点

1. **写路径要同步结构**：`forget()` 与 `move()` 必须同步 `this.folders`（含子树前缀）。否则缓存优先后，改过名的目录会留下幽灵条目。
2. **两个信号要分开**：`notify()` 目前被 `markOnline()` 在每次 `list()` 里触发，直接驱动界面刷新会死循环。需要「状态信号」（状态点）与「数据变化信号」（视图重载）两条通道。
3. **校验优先用 etag**：文件用 etag 比（可靠），mtime 只在 etag 缺失时按**秒级**兜底。否则本地写入的毫秒 mtime 会永远不相等。

### 5.3 请求预算

坚果云 30 分钟 600 次。改造后**请求总量不变**（只是异步），所以**目录级 TTL 是必须的** —— 没有 TTL 的话，频繁切页反而会因为后台校验比改造前更费。

### 5.4 结论

**没有阻塞性卡点，可以进入改造（第二步）。** 唯一需要如实修正的是汇报口径：「请求量」按 §5.1 给，不能报成「1 次」。
