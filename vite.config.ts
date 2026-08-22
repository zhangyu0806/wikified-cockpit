import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 前端开发服务器代理 /api 到本机 Bun server(默认 4177)。
// 生产构建产物由 Bun server 直接静态托管,无需 nginx。
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 4176,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.COCKPIT_PORT || 4177}`,
        changeOrigin: true,
      },
    },
  },
});
