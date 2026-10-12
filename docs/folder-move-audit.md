# 文件夹移动能力：前置核实

> 2026-10-12。为「三合一 B 的批量移动需要文件夹也能移动」补数据层能力，动代码前只读核对。

## 1. `foldersApi` 现有实现的位置

`apps/web/src/storage/notes.ts`，`export const foldersApi = {`（**579 行**）：

| 方法 | 行号 | 说明 |
|---|---|---|
| `list()` | 580 | 从 `tree()` 拿 `dirs` + 按目录统计直系笔记数，拼成 `FolderDTO[]` |
| `create({name, parent_id})` | 605 | `uniqueRel(parent, sanitize(name), '')` 查重 → `mkdir` → `invalidateTree()` |
| `rename(id, name)` | 626 | `uniqueRel(parent, sanitize(name), '', rel)` → `move(rel, target)` → `invalidateTree()` |
| `remove(id)` | 646 | **解散**：子项逐个 move 到父目录（并发 3）→ 删空目录 |

**没有 `move`。** 注意 `rename` 已经是「同一父目录内改名」= `uniqueRel` + `move`，
所以「移动到别的父目录」与它是同一段逻辑，只差目标目录不同。

## 2. `notesApi.move` 是怎么发 WebDAV MOVE 的

`notesApi` **没有独立的 move**。换目录走 `notesApi.update(id, { folder_id })`
（`notes.ts:446`），在 464-480 行的分支里调 `getStorage().move(rel, target)`。

真正的请求在适配器层 `apps/web/src/services/storage/webdav.ts` 的 `move()`（**353-370 行**）：

```ts
const res = await this.send(this.url(from), {          // ① 请求打的是 **源**
  method: 'MOVE',
  headers: {
    Authorization: this.auth(),
    Destination: this.originUrl(to),                   // ② 目标，绝对地址
    Overwrite: 'F',                                    // ③ 不覆盖
  },
});
```

| 项 | 值 | 备注 |
|---|---|---|
| URL | `this.url(from)` | `requestBase + '/' + 逐段编码的相对路径`；dev 下坚果云会被 `resolveRequestBase()` 改写成同源 `/nutdav/dav` |
| `Destination` | `this.originUrl(to)` | **绝对地址**，用配置里的原始 `baseUrl` 拼（源码注释：Destination 必须是绝对地址，因此不能复用 dev 下的同源代理前缀）|
| `Overwrite` | **`'F'`** | 目标已存在时服务器回 412 |
| 成功 | `201` / `204` | |
| `412` | `StorageError('conflict', '目标位置已有同名条目', 412)` | |
| 其它 | `StorageError('other', '移动失败（HTTP …）')` | |

目录用的是**同一个** `move()` —— `foldersApi.rename`（`notes.ts:631`）就是这么给文件夹改名的，
所以目录搬家这条路径已经在真机上跑通过。

## 3. `cached-adapter.ts` 的 move 实现

```ts
async move(from: string, to: string): Promise<void> {   // 642 行
  await this.inner.move(from, to);
  await this.repath(from, to);
  this.scheduleSave();
}
```

`repath(from, to)`（**653-687 行**）把 `from` 及其整棵子树在本地索引里改写：

1. `meta.notes` 里命中子树的每一行：旧键删除、新键为 `to + rel.slice(from.length)`，
   并把 **`row.folder` 重设为 `parentOf(next)`**；有本地正文副本的连副本一起搬到新键、删旧键
2. `this.folders` 与 `this.listed` 两个目录集合整体换前缀
3. 作废 `from` 与 `to` 两个父目录的校验时刻（`checkedAt`）

**关于「meta.json 里 folder_id 更新」**：缓存里没有独立的 `folder_id` 字段 ——
一篇笔记的归属就是 `row.folder`（父目录相对路径），而 `FolderDTO.parent_id` 是 `list()` 时
用 `parentOf(dir.path)` 现算的。所以 **`repath()` 已经覆盖了子项的归属更新，不需要额外写**。

## 4. `capabilities/default.json` 里 MOVE 需要什么权限

```json
{ "identifier": "http:default", "allow": [{ "url": "https://*:*" }, { "url": "http://*:*" }] }
```

tauri-plugin-http 的 ACL **按 URL 放行，没有方法白名单**。
→ **现有权限已经够 MOVE，不用改**（改这个文件必须重新打包，代价高，能不动就不动）。

## 5. `FoldersView.vue` 的「⋯」菜单现有项

**不是复用 `NoteActionMenu`**，是本页自己写的：`<Teleport to="body">` + `.sheet-mask`
（`z-index: 25`）+ `.sheet glass`，由 `sheetTarget` 控制。

现有 4 项：**新建子文件夹 / 重命名 / 删除文件夹 / 取消**。

⚠️ 每个 `open*()` 都先 `sheetTarget.value = null`（`openCreate:62`、`openRename:88`、`openDelete:112`）——
因为这张 sheet 在 z-index **25**、而 `AppDialog` 在 **22**，不先关掉的话对话框会被 sheet 盖住。
新增「移动到…」必须沿用同样的顺序。

## 自检：可行？卡点

**可行，无阻塞。** 复用现成的四块：`uniqueRel()`（查重 + 后缀）、`getStorage().move()`、
`invalidateTree()`、`cached-adapter.repath()`。不引入依赖，不动 `notesApi`。

实现时要注意（都不是需要你定的问题，写下来备查）：

1. **防环必须在数据层做**：`target === source` 或 `target.startsWith(source + '/')` 一律拒绝 ——
   不能只靠 UI 把选项禁掉。
2. 根目录不可移动：`source` 为空串时拒绝。
3. 移到「根」时目标父目录是空串，`uniqueRel('', …)` 正常工作。
4. 目标父目录必然已存在（要么是根、要么是列表里已选中的文件夹），**不需要 `ensureDir`**。
5. 与 `rename` 高度重合：可以抽一个内部函数让两者共用，但 `rename` 的**对外行为一行不改**。
6. `.assets` 与子目录由 WebDAV `MOVE` 整体搬运（收尾 1 个请求），缓存层 `repath` 同步，
   不需要像 `remove` 那样逐个子项搬。
