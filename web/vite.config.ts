/// <reference types="vitest" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Dev server proxies WS + REST API 到 perga-server,这样前端代码里所有 URL 都
// 写相对路径,浏览器看到的是同源连接,生产打包后(Tauri 或反向代理)也走
// 同一路径。
//
// 没配代理的路径默认走 SPA fallback 返 index.html,所以新增 REST 端点时必须
// 同步在这里加 proxy,不然前端拿到 `<!doctype html>...` 当 JSON 解析就炸。
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
      // SSH host profile CRUD —— GET / POST / PUT / DELETE 全走这一条。
      "/api": {
        target: "http://127.0.0.1:7777",
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
