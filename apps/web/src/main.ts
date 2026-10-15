import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useWebdavStore } from './stores/webdav';
import { useThemeStore } from './stores/theme';
import { useUiStore } from './stores/ui';
import { installTauriBridge } from './storage/tauri';
import { isTauriRuntime } from './storage/transport';
import { startAutoUpdate } from './updater';
import { installExternalLinks } from './utils/open-external';

import './styles/tokens.css';
import './styles/base.css';
import './styles/glass.css';
import './styles/app.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// 端上先换成原生传输层与系统凭据存储（浏览器里是空操作）
installTauriBridge();

// 外部链接统一交给系统浏览器：WebView2 自己对 target="_blank" 不做任何事
installExternalLinks();

// 主题在挂载前先应用，避免与首屏内联脚本产生二次跳变
useThemeStore().init();

// 先从本机凭据恢复连接态，再放行路由，避免已连接用户闪一下连接页
const webdav = useWebdavStore();
webdav.restore().finally(() => {
  app.use(router);
  app.mount('#app');
  // 启动后自动检查并后台把新版本下好；下好了才提示一句，装不装由用户点一下决定
  if (isTauriRuntime()) {
    startAutoUpdate((state) => {
      if (state.kind !== 'ready') return;
      useUiStore().toast(
        state.portable
          ? `有新版本 ${state.version}，绿色版到下载页取新包`
          : `新版本 ${state.version} 已下载好，到设置里点「重启以更新」`,
      );
    });
  }
});
