import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
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
