import { webview } from '@kit.ArkWeb';

/**
 * 唯一一个页面：一个占满窗口的 Web 组件。
 *
 * 加载的是打包进来的前端产物（`resources/rawfile/www/index.html`），不是远程地址 ——
 * 断网也能打开，和桌面版一样。
 *
 * 三项开关各有原因，别随手关掉：
 * - `domStorageAccess`：默认是 false，不开 localStorage 就用不了（应用密码、模式记忆都在里面）；
 * - `databaseAccess`：浏览器本地模式（IndexedDB）靠它，手机上不连服务器就靠这个存笔记；
 * - `zoomAccess(false)`：双指缩放交给页面自己处理，系统再缩放一次会跟画布缩放打架。
 */
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void {
    // 打开调试端口：电脑上 Chrome 访问 chrome://inspect 就能看到这个 WebView，
    // 手机上没有控制台，不开口子就只能靠猜。
    webview.WebviewController.setWebDebuggingAccess(true);
  }

  build() {
    Column() {
      Web({ src: $rawfile('www/index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .zoomAccess(false)
        .horizontalScrollBarAccess(false)
        .verticalScrollBarAccess(false)
        .darkMode(WebDarkMode.Auto)
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
