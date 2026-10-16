/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/*
 * 不再自定义 ImportMetaEnv：这里原来只声明过一个 `VITE_API_BASE`，那是「网页版反代到 Worker」
 * 方案的残留（对应的 functions 反代从未实现）。网页端不作为产品形态（浏览器连不上坚果云，
 * CORS），`import.meta.env` 的类型直接用 vite/client 提供的那份。
 */
