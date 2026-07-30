import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.H_MINESWEEPER_PORT || "3001";
  const backendUrl =
    env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${backendPort}`;
  const websocketUrl = backendUrl.replace(/^http/, "ws");

  return {
    plugins: [react()],
    server: {
      strictPort: true,
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
        },
        "/realtime": {
          target: websocketUrl,
          ws: true,
        },
      },
    },
    build: {
      target: "es2022",
      sourcemap: true,
    },
  };
});
