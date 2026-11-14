import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

/**
 * 鸿蒙侧的外壳。
 *
 * DoNote 的前端是一套 Vue 应用，桌面版跑在 Tauri 的 WebView2 里，这里换成 ArkWeb —
 * 内核同样是 Chromium 系，前端代码一行不用改。这个 Ability 只做一件事：
 * 把 rawfile 里那份构建产物装进窗口。
 */
export default class EntryAbility extends UIAbility {
  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        console.error(`[DoNote] loadContent 失败: ${err.code} ${err.message}`);
        return;
      }
      // 让页面铺到状态栏下面：DoNote 自己有顶栏，系统再压一条会很挤。
      // 拿不到窗口不影响使用，所以失败只记一笔。
      const win = windowStage.getMainWindowSync();
      win.setWindowLayoutFullScreen(true).catch((e: Error) => {
        console.warn(`[DoNote] 全屏布局设置失败: ${e.message}`);
      });
    });
  }
}
