/// <reference types="vitest" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Dev server proxies WS to perga-server,这样前端代码里 WS URL 只写相对路径,
// 浏览器看到的是同源连接,生产打包后(Tauri 或反向代理)也走同一路径。
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:7777",
        ws: true,
        // 不改路径,server 端就是 /ws。
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
