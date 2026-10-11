import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * 桌面构建时是否落地。
 *
 * `TAURI_ENV_PLATFORM` 由 tauri CLI 注入给 beforeBuildCommand / beforeDevCommand，
 * 普通 `vite build` 下不存在。
 */
const isDesktop = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      /**
       * 桌面端不注册 Service Worker。
       *
       * SW 是「给网页用的」：让浏览器离线也能打开。但桌面端的页面从 `tauri://localhost`
       * 直接读本机文件，根本没有网络这一步，SW 不提供任何好处，却会把 WebView2 的
       * profile 缓存住 —— 原地升级（0.1.x → 0.2.x）时旧 SW 拿旧的 precache 清单回退
       * 导航请求，新前端资源一次都不会被请求，界面就永远是上一版。
       *
       * ⚠️ 注意这一项只防「新注册」，救不了已经中毒的机器（旧 SW 会拦住导航，
       * 连新版页面本身都送不进去）。真正解开死锁的是 tauri.conf.json 里的
       * `useHttpsScheme: true` —— 换 origin 到 `https://tauri.localhost`，
       * 旧注册按 origin 隔离自然失效。详见项目 MEMORY.md 的【桌面端 SW 缓存坑】。
       */
      disable: isDesktop,
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'DoNote',
        short_name: 'DoNote',
        description: '多端 Markdown 笔记工具',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#0A0E14',
        background_color: '#0A0E14',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // 站内导航一律回退到 index.html（SPA），但 dev 代理路径除外
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/nutdav\//],
        runtimeCaching: [
          {
            // 笔记内容绝不进缓存：缓存会让「刚在坚果云改过」的内容失真
            urlPattern: ({ url }) => url.pathname.startsWith('/nutdav/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'donote-images' },
          },
        ],
      },
      // dev 不注册 sw，避免开发时被缓存干扰
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 多数 WebDAV 服务不返回 CORS 响应头，浏览器直连必被拦。
      // dev 用代理转发，让网页端能调试；端上（Tauri / 鸿蒙）走原生网络栈，不需要它。
      // ⚠️ 代理目标写死，因此只有坚果云在 dev 下可用；换别的服务器只能靠端上。
      '/nutdav': {
        target: 'https://dav.jianguoyun.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nutdav/, ''),
        configure: (proxy) => {
          // Chromium 收到带 WWW-Authenticate 的 401 会挂起等凭据，fetch 永远不 resolve。
          // 去掉这个头，让「密码错了」作为一个普通 401 返回，前端才能提示出来。
          proxy.on('proxyRes', (proxyRes) => {
            delete proxyRes.headers['www-authenticate'];
          });
        },
      },
    },
  },
  build: {
    target: 'es2022',
    // 必须显式声明 CSS 目标浏览器：默认目标偏老，压缩器会把 backdrop-filter
    // 改写成只剩 -webkit- 前缀版本，Chromium 不认 → 线上毛玻璃整条失效。
    // 显式指定现代浏览器后，压缩器保留标准属性名。
    cssTarget: ['chrome111', 'edge111', 'safari16.4', 'firefox113'],
    // 压缩器改用 esbuild：lightningcss 会把 backdrop-filter 降级成 -webkit- 前缀版本，
    // 导致 Chromium 侧整条声明失效（毛玻璃不生效）。
    cssMinify: 'esbuild',
    outDir: 'dist',
  },
});
