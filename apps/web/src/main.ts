import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useAuthStore } from './stores/auth';
import { useThemeStore } from './stores/theme';

import './styles/tokens.css';
import './styles/base.css';
import './styles/glass.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);

// 主题在挂载前先应用，避免与首屏内联脚本产生二次跳变
useThemeStore().init();

// 有本地 token 就先静默校验一次，再放行路由，避免已登录用户闪一下登录页
const auth = useAuthStore();
auth.restore().finally(() => {
  app.use(router);
  app.mount('#app');
});
