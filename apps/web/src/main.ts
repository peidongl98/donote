import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useNutstoreStore } from './stores/nutstore';
import { useThemeStore } from './stores/theme';
import { useUiStore } from './stores/ui';
import { installTauriBridge } from './storage/tauri';
import { isTauriRuntime } from './storage/transport';
import { checkUpdate } from './updater';

import './styles/tokens.css';
import './styles/base.css';
import './styles/glass.css';
import './styles/app.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// 端上先换成原生传输层与系统凭据存储（浏览器里是空操作）
installTauriBridge();

// 主题在挂载前先应用，避免与首屏内联脚本产生二次跳变
useThemeStore().init();

// 先从本机凭据恢复坚果云连接态，再放行路由，避免已连接用户闪一下连接页
const nutstore = useNutstoreStore();
nutstore.restore().finally(() => {
  app.use(router);
  app.mount('#app');
  // 启动后悄悄看一眼有没有新版本；失败就当作没有，不打扰用户
  if (isTauriRuntime()) {
    checkUpdate()
      .then((state) => {
        if (state.kind === 'available') {
          useUiStore().toast(`发现新版本 ${state.version}，可到设置里更新`);
        }
      })
      .catch(() => undefined);
  }
});
