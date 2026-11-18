import { webview } from '@kit.ArkWeb';
import { window } from '@kit.ArkUI';
import { DavBridge } from '../common/DavBridge';

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
 *
 * 另外注入一个原生 HTTP 桥（见 common/DavBridge.ets）：页面 origin 是 null，
 * 直连 WebDAV 会被跨域策略拦成 Failed to fetch，所有出网请求都得走它。
 */
@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private dav: DavBridge = new DavBridge();
  private insetTop: number = 0;
  private insetBottom: number = 0;

  aboutToAppear(): void {
    // 打开调试端口：电脑上 Chrome 访问 chrome://inspect 就能看到这个 WebView，
    // 手机上没有控制台，不开口子就只能靠猜。
    webview.WebviewController.setWebDebuggingAccess(true);
    this.measureInsets();
  }

  /**
   * 量状态栏 / 手势条压掉的高度。
   *
   * 窗口是全屏的（EntryAbility 里 setWindowLayoutFullScreen(true)），页面从屏幕顶端开始铺，
   * 而 ArkWeb 不填 CSS 的 env(safe-area-inset-*)。不把这两个数字告诉网页，
   * 顶栏的标题就会跟时间和电量叠在一起。
   */
  private measureInsets(): void {
    window
      .getLastWindow(getContext(this))
      .then((win: window.Window) => {
        const sys: window.AvoidArea = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
        const nav: window.AvoidArea = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
        this.insetTop = px2vp(sys.topRect.height);
        this.insetBottom = px2vp(nav.bottomRect.height);
        this.dav.setInsets(this.insetTop, this.insetBottom);
      })
      .catch((err: Error) => {
        console.warn(`[DoNote] 安全区读取失败: ${err.message}`);
      });
  }

  /**
   * 页面加载完再灌一次 CSS 变量。
   * 走 runJavaScript 而不是只靠同步接口：getLastWindow 是异步的，
   * 首帧很可能比页面脚本晚，晚到的那一次得有人补上。
   */
  private pushInsets(): void {
    if (this.insetTop <= 0 && this.insetBottom <= 0) return;
    const js =
      `document.documentElement.style.setProperty('--safe-top','${this.insetTop}px');` +
      `document.documentElement.style.setProperty('--safe-bottom','${this.insetBottom}px');`;
    this.controller.runJavaScript(js).catch((err: Error) => {
      console.warn(`[DoNote] 安全区注入失败: ${err.message}`);
    });
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
        // 网页侧 window.DoNoteNative.davRequest(...) / .deviceType()
        .javaScriptProxy({
          object: this.dav,
          name: 'DoNoteNative',
          methodList: ['davRequest', 'deviceType', 'safeInsets'],
          controller: this.controller,
        })
        // 首帧之后再补一次安全区（见 pushInsets 的注释）
        .onPageEnd(() => this.pushInsets())
        .width('100%')
        .height('100%')
        // 手机上没法开控制台，加载失败/脚本报错只能靠 hilog 看：过滤 "WEBERR" 即可
        .onErrorReceive((event: OnErrorReceiveEvent) => {
          const e: WebResourceError = event.error;
          console.error('WEBERR code=' + e.getErrorCode() + ' desc=' + e.getErrorInfo() + ' url=' + event.request.getRequestUrl());
        })
        .onConsole((event: OnConsoleEvent) => {
          const m: ConsoleMessage = event.message;
          console.error('WEBERR console ' + m.getSourceId() + ':' + m.getLineNumber() + ' ' + m.getMessage());
          return false;
        })
    }
    .width('100%')
    .height('100%')
  }
}
