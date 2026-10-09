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
        // 站内导航一律回退到 index.html（SPA），但 /api/* 除外
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // 认证与业务接口绝不进缓存：缓存会让「已删除 / 已恢复」这类状态失真
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
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
    // dev 走同源代理，避免本地额外跨域；线上由 Worker 的 CORS 白名单接管
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
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
