import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
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
      // 坚果云 WebDAV 不返回 CORS 响应头，浏览器直连必被拦。
      // dev 用代理转发，让网页端也能开发调试；端上（Tauri / 鸿蒙）走原生网络栈，不需要它。
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
