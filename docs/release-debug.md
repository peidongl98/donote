# 0.2.0 发布后「看不到新功能」诊断报告

> 2026-10-11 ｜ **只排查**：未改任何源码、未改任何配置、未动用户网盘里的文件（只做只读列举）。
> 结论先行：**安装包是对的、部署也是对的。界面被 WebView2 里一个 2026-10-10 12:00 注册的 service worker 锁死在旧版本。**

## 0 结论速览

| 用户报告 | 核实结果 | 关键证据 |
|---|---|---|
| 装 0.2.0 后没有侧边栏 | **成立**，但不是安装包的问题 | WebView2 的 SW 缓存里存的是 10-10 那一代 app 壳 |
| 打开笔记没有工具栏 | **成立**，同一原因（旧壳里编辑器还是 textarea） | 同上 |
| 出现很多空笔记 | **成立**，但不是 0.2.0 造成的 | 21 篇「未命名」创建于 10-11 02:29–02:58，比安装早约 14.5 小时 |
| 版本号显示 "2.0" | **无法复现，且没有代码依据** | 见 §3；需要确认是在哪个界面看到的 |

一句话机理：
`vite-plugin-pwa` 生成的 service worker 会 precache 整个 app 壳（`navigateFallback: 'index.html'`）。
SW 按 **origin** 存在 WebView2 的 profile 目录里，而 profile 目录由 `identifier` 决定、**升级安装不会重建**。
于是新二进制里那套新前端资源，被旧 SW 用它 10-10 缓存的旧 `index.html` 顶掉 —— 旧壳再加载旧 JS，
旧 JS 里根本没有 `AppSidebar`，编辑器也还是 textarea。**新代码一次都没被加载过。**

---

## 1 安装包内容核实结果（有没有阶段 3–7 的代码）

**有，而且完全对得上。**

1. 安装位置已由用户确认：`D:\DoNote\`（`HKCU\...\Uninstall` 里 `InstallLocation = "D:\DoNote"`）。目录里只有两个文件：
   - `donote.exe` —— **8,425,472 字节**，mtime `2026-10-11 16:58:52`
   - `uninstall.exe` —— 78,825 字节，mtime `2026-10-11 17:10:03`
2. `apps/web/dist`（打进包里的那份前端）**含批次 2 全部特征**：
   `AppSidebar` / `EditorToolbar` / `FloatingToolbar` / `rail-search` / `milkdown` / `ProseMirror` 均能搜到；
   `dist/index.html` 里带着阶段 3 的 `data-sidebar` 内联脚本。
3. **`donote.exe` 里嵌的前端资源 = dist**。把二进制里的明文资源路径抠出来共 **134 条**，
   与 `apps/web/dist/assets/` 的 **134 个文件**做差集，**两个方向都为空**；其中包括批次 2 才有的
   `/assets/NoteEditView-DLLl6Scn.js`（587 KB，Milkdown 编辑器那一坨）。
4. `apps/web/dist/index.html` 的 mtime = `16:54:45`，`donote.exe` = `16:58:52`
   → **安装包比前端产物新**，不存在「用了旧 dist」。
5. 安装的那份 exe 与 `apps/desktop/src-tauri/target/release/donote.exe` 只差 **3 个字节**（偏移 7834231）。
   原因已查明：安装包里那份是 `16:58:52` 的编译，target 里那份是 `16:58:57` 的编译（bundler 取走副本之后又链了一次），
   两次编译同一份源码。**不影响前端** —— 上面第 3 条的 134 条资源路径逐条一致。
   ⚠️ NSIS 载荷是 LZMA 压缩的，直接对 `DoNote_0.2.0_x64-setup.exe` 做字符串搜索永远搜不到东西（0.1.1 也一样），
   这一条不要当作「安装包没有代码」的证据。

**结论：阶段 3–7 的代码确实在装上的那个二进制里。**

## 2 线上安装包与本地构建的一致性

**一致，部署的不是旧包。**

- 发布时已核（本轮重新确认）：线上 `DoNote-0.2.0-win-x64.exe` 4,187,088 字节，
  线上 / `site/downloads/` / `target/.../bundle/nsis/` 的 sha256 三方一致 `9e1acc7e…`。
- 注册表 `DisplayVersion = 0.2.0`；`donote.exe` 与 `uninstall.exe` 的 FileVersion / ProductVersion **都是 0.2.0**。
- 下载页 `data-href` 指向 `/downloads/DoNote-0.2.0-win-x64.exe`。
- 线上 / 本机的完整资源清单与阶段 2 发布时的核验记录一致，没有第二份可疑的 0.2.0 包。

## 3 版本号显示来源与「2.0」的根因

**代码里只有一个版本显示点，且没有任何格式化逻辑。**

- 显示点：`apps/web/src/views/SettingsView.vue:156` → `<span class="line-val mono">{{ version || '—' }}</span>`
- 取值：`apps/web/src/updater.ts:32` `appVersion()`
  ```ts
  export async function appVersion(): Promise<string> {
    if (!isTauriRuntime()) return '0.0.0-web';
    try { const { getVersion } = await import('@tauri-apps/api/app'); return await getVersion(); }
    catch { return 'unknown'; }
  }
  ```
  端上就是 Tauri 的 `getVersion()`，也就是 `tauri.conf.json` 的 `version`。
- **全仓没有任何 `split('.')` / `replace` / `slice` / `parseInt` 处理版本号的地方**（已 grep 全部源码）。
  所以 `0.2.0` 不可能被渲染成 `2.0`。
- 所有版本元数据都是 `0.2.0`：
  `apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml`、
  根 / `apps/desktop` / `apps/web` / `packages/shared` 四个 `package.json`、
  注册表 `DisplayVersion`、`donote.exe` 与 `uninstall.exe` 的 FileVersion + ProductVersion。
- 补一刀：从 WebView2 的 SW 缓存里抠出来的**旧版** `appVersion()` 实现与当前**逐字相同**（也是 `getVersion()`），
  所以「就算是那套旧界面在跑，也只会显示 `0.2.0`」。

**结论：本构建里不存在能显示 "2.0" 的代码路径。** → **[待确认]**
需要用户确认：是在哪个界面看到的？是应用内的「设置 → 关于 → 版本」，还是 Windows「应用和功能」里的版本，
还是安装器窗口？最好给一张截图。若确实是应用内那行，则说明跑的不是这份二进制（但目前所有证据都指向它就是这份）。

## 4 空笔记的创建时间、位置与来源

**已定位，且与本批次无关。**

- **位置**：用户坚果云 `/DoNote` **根目录**（`https://dav.jianguoyun.com/dav/DoNote/`），不在子文件夹。
  根目录当前一共 22 项：`.trash`（目录）＋ **21 篇 `未命名*.md`**。
- **文件名**：`未命名.md`、`未命名 2.md` … `未命名 20.md`、**`未命名 22.md`**
  —— 注意**缺 `未命名 21.md`**，说明一共创建过 22 次，第 21 篇被改名或删掉了。
- **内容**：**只有 frontmatter，没有任何正文**，21 篇互不相同（`created` 各不相同），全部 82 字节 / 76 字符：
  ```yaml
  ---
  title: "未命名"
  created: 1791656961658
  updated: 1791656961658
  tags: []
  ---
  ```
  `created == updated` → 创建之后**从未被编辑过**。
- **创建时间**：**2026-10-11 02:29:21 → 02:58**（本地时间，间隔 50–217 秒不等）。
- **是不是本批次引入的**：不是。
  - 时间上：比 0.2.0 安装（17:09）**早约 14.5 小时**。任务书里「安装后才出现 → 本批次引入」这条不成立。
  - 代码上：应用里**只有两处**会创建笔记，都是明确的用户动作
    —— `apps/web/src/components/AppSidebar.vue:53`（侧边栏「新建」）与 `apps/web/src/views/HomeView.vue:75`（列表页新建按钮）。
    `NoteEditView` 挂载时**不调用** `notesApi.create`，Milkdown 初始化也不写盘；自动保存（`scheduleSave`，防抖 1200ms）只写当前打开的那一篇。
    所以「编辑器 mount 时误触发 save 建空文件」这条假设**不成立**（已看代码排除）。
- **真正的来源**：**本批次调试用的探针脚本残留**。
  - `D:\design-website\.workbuddy\tmp\donote\` 下 8 个探针的落盘时间是
    `02:31 / 02:35 / 02:38 / 02:39 / 02:40 / 02:50 / 02:54 / 02:59`，**与空笔记的产生窗口逐条重合**。
  - 这 8 个探针（`probe-new` / `probe-detail` / `probe-detail2` / `probe-steps` / `probe-sel` / `probe-css` / `probe-targets` / `probe-doc`）
    **每一个都会点「新建笔记」后就收工**。以最小的那个为例，`probe-new.cjs` 第 49 行：
    ```js
    await page.locator('.rail button.new').click();
    await page.waitForTimeout(6000);
    ...
    await browser.close();   // 从不改名，也不删除
    ```
    每跑一次就往真实网盘留一篇「未命名」。这几个探针当时是反复迭代跑的。
    ⚠️ 「逐篇指认到具体某一次运行」做不到 —— 当时没有留运行日志，文件里也没有运行标记。
    能确定的是三点同时吻合：**只有这一批脚本的行为是「建完就走」**（`stage2/4/5/6/7` 与 `notes-e2e` 都会改名、填正文、事后清理）、
    **脚本落盘时间与 21 篇的创建时间同窗**、**数量级相当**。据此判为本批次调试残留。
  - 事后 `cleanup-leftovers.cjs`（`04:40`）只清 `S2所见即所得` / `S4工具栏` / `S5图片` / `S6源码` / `S7走查` / `S7目录` / `E2E测试` / `E2E目录` 这些前缀，
    **没有匹配「未命名」**，所以它们留在了根目录。
- **判定**：本批次**调试残留**，不是产品缺陷。**我没有删任何一篇**（任务要求不碰用户网盘），是否清理由用户决定。

## 5 开发模式 vs 打包模式的差异

**打包没问题，运行期被 service worker 顶掉了。**

### 5.1 打包产物本身是好的

把 `apps/web/dist`（就是嵌进 exe 的那份）单独用静态服务器托管，再用 Chromium 加载（1440×900）：

```
url        : /login
data-sidebar: "open"          ← 阶段 3 的内联脚本生效（旧壳没有这段脚本）
data-theme : "light"
入口        : /assets/index-C8mXaL6a.js   ← 当前 dist 的入口
样式        : /assets/index-Da0rSHZJ.css + 路由级 CSS 全部 200
4xx/5xx    : (无)
页面错误    : (无)
```

→ **这批资源自己跑起来就是批次 2 的界面。**

### 5.2 打包后的实际运行期：被旧 SW 锁死

WebView2 的 profile 在 `%LOCALAPPDATA%\com.donote.desktop\EBWebView\`
（按 `identifier` 命名，**与安装路径无关，升级安装不会重建**；该目录创建于 2026-10-10 01:09）。
其中 `Default/Service Worker` 里住着一个 **2026-10-10 12:00 注册** 的 service worker：

| 检查项 | 结果 |
|---|---|
| `ScriptCache` 里存着的 sw.js，其 precache 清单指向 | `assets/index-dBJvntib.js` + `assets/index-YrhqKJx6.css` |
| 当前 dist 的入口 | `assets/index-C8mXaL6a.js` + `assets/index-Da0rSHZJ.css` |
| `CacheStorage` 缓存条目 | 30 个资源，**写入时间全部是 2026-10-10 12:00** |
| 缓存里的 index.html 引用的入口 | `<script type="module" src="/assets/index-dBJvntib.js">` |
| 缓存里有没有 `data-sidebar` / `donote.sidebar` | **0**（当前 dist 里各 1） |
| 缓存里有没有 `AppSidebar` / `EditorToolbar` / `rail-search` / `donote.normalize-hint` | **全为 0** |
| 缓存里 vs 当前 dist 的资源集合 | 缓存里 30 个，**26 个不在 dist 里**；dist 的 134 个里 **131 个不在缓存里** |
| WebView2 的 HTTP 缓存里的 `/assets/` 条目 | **0 条** → 那些资源全是 SW 从 cache 发的 |

`vite.config.ts` 里的配置正是这套行为的来源：

```ts
VitePWA({
  registerType: 'autoUpdate',
  workbox: {
    globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
    navigateFallback: 'index.html',                       // ← 所有导航请求回退到 precache 的 index.html
    navigateFallbackDenylist: [/^\/nutdav\//],
  },
  devOptions: { enabled: false },                          // ← dev 不注册 SW
})
```

于是：启动 → 请求 `/` → 旧 SW 用 `navigateFallback` 返回它 10-10 缓存的旧 `index.html`
→ 旧 HTML 加载旧 `index-*.js`（都在它的 precache 里）→ **整套旧界面渲染出来，新二进制里的新资源一次都没被请求**。

**为什么一直没自愈**：`Service Worker/Database/LOG` 显示今天 17:11 确实被写过（启动时跑过注册/更新检查），
但 `Database/000003.log`（真正的注册数据）与 `ScriptCache` 仍停在 10-10 12:00，precache 也没被重写
→ **新版 `sw.js` 从未被安装 / 激活**。具体卡在哪一步 **[待确认]**，候选：
① WebView2 对 SW 脚本的更新请求走了 HTTP 缓存（SW 脚本 >24h 才强制绕缓存）；
② Tauri 的自定义资源协议没有 `Cache-Control` / 不支持条件请求，导致更新判成「未变化」；
③ 生成的 `registerSW.js` 是最简形式 `navigator.serviceWorker.register('/sw.js',{scope:'/'})`——
   它**没有任何 `controlling` → `location.reload()` 的收尾**，就算新 SW 装上了，也已经渲染完的旧页面不会自己刷新。

### 5.3 开发模式为什么一直是对的

`devOptions: { enabled: false }` —— **dev 根本不注册 SW**，所以 dev 下必然是新界面。
这解释了批次 2 的全部验收（`stage7-walk` 27/27、`stage4-toolbar` 45/45 …）为什么全绿：
它们跑在 dev server 上，从来没经过 WebView2 的 SW 缓存这条路径。

### 5.4 关于任务书点名的「关键实验」

**没有跑 `pnpm tauri dev`**，理由：它会新开一个 GUI 窗口并触发一次 debug 编译，而它答不了「打包后为什么不同」
——打包产物已经被证明是新的（§1 二进制内嵌资源 134/134、§5.1 独立加载正常）。
改用「把打包产物单独静态托管 + Chromium 加载」做了等价且更直接的对照，结论一致。
同理也**没有启动已装的 `D:\DoNote\donote.exe`**：启动本身会改写 WebView2 的 profile（正是要诊断的那个对象），
会在用户决定怎么修之前把证据冲掉。

### 5.5 一条从未被测到的路径

批次 2 的验收覆盖了「dev 下所有功能」，发布时覆盖了「全新下载安装」，
**唯独没有覆盖「已装 0.1.x 的机器原地升级到 0.2.0」** —— 而这条正是出问题的那条。
下次发版必须把它加进验收。

## 6 建议的修复方向（不执行，供决策）

1. **桌面端不要注册 service worker（首选，最简）。**
   PWA 是给「网页版」用的，而网页版已废弃；桌面端资源本来就编在二进制里，SW 只会带来这类陈旧缓存问题。
   做法：给 `VitePWA` 加 `disable: !!process.env.TAURI_ENV_PLATFORM`（Tauri 构建时会注入该变量），
   或在只为端上构建时关掉插件。**只需改 `vite.config.ts` 一处。**
   注意：光「不再注册」还不够 —— 用户机器上那个旧 SW 还在，仍会拦住第一次导航，所以还要做第 2 条。
2. **顺手清掉客户端上的旧 SW（一次性）**：在 `apps/web/index.html` 最前面加一段内联脚本
   （必须内联，才能赶在 SW 拦截导航之前执行）：
   ```js
   if ('serviceWorker' in navigator) {
     navigator.serviceWorker.getRegistrations().then(rs => {
       if (!rs.length) return;
       Promise.all(rs.map(r => r.unregister())).then(() => caches.keys())
         .then(ks => Promise.all(ks.map(k => caches.delete(k))))
         .then(() => location.reload());
     });
   }
   ```
3. 若坚持保留 PWA（不建议）：至少每次发版给 `sw.js` 换 URL（`registerSW.js` 带版本 query）、
   打开 `cleanupOutdatedCaches`，并补上 `controlling → reload` 的收尾逻辑。
4. **空笔记**：把 `.workbuddy/tmp/donote/` 下那批 `probe-*.cjs` 归档（它们会往真实网盘写「未命名」笔记）；
   根目录那 21 篇的清理由用户决定（我没动）。
5. **版本号 "2.0"**：无代码依据，等用户确认界面后再定。
6. 修完之后要专门验一次**「旧版本原地升级」**这条路径（§5.5）。

---

### 附：本轮用到的取证位置

| 对象 | 路径 |
|---|---|
| 已安装的应用 | `D:\DoNote\donote.exe`（8,425,472 B，16:58:52） |
| 构建产物 | `D:\design-website\DoNote\apps\desktop\src-tauri\target\release\{donote.exe, bundle\nsis\DoNote_0.2.0_x64-setup.exe}` |
| 前端产物 | `D:\design-website\DoNote\apps\web\dist\`（134 个资源，index.html 16:54:45） |
| WebView2 profile | `%LOCALAPPDATA%\com.donote.desktop\EBWebView\` |
| ↳ service worker 缓存 | `…\EBWebView\Default\Service Worker\{CacheStorage, ScriptCache, Database}\` |
| 用户网盘根目录 | `https://dav.jianguoyun.com/dav/DoNote/`（只读 PROPFIND / GET） |
| 只读探针脚本 | `D:\design-website\.workbuddy\tmp\donote\{probe-nutstore.cjs, probe-unnamed.cjs, static-check.cjs}` |
