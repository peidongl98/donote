import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useWebdavStore } from './stores/webdav';
import { useThemeStore } from './stores/theme';
import { installTauriBridge } from './storage/tauri';
import { installExternalLinks } from './utils/open-external';

import './styles/tokens.css';
import './styles/base.css';
import './styles/glass.css';
import './styles/app.css';
// 列表外观三处共用这一份（编辑器 / 源码预览 / 导出 HTML），见文件头注释
import './styles/list-style.css';

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
  // 启动自检更新提示由 App.vue 里的 UpdatePrompt 负责（发现新版本即弹对话框）
});
