import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

/** The Android wallet (`mobile/`): only the wallet, from `mobile.html`, into `dist-mobile/`. */
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/mobile/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    outDir: "dist-mobile",
    emptyOutDir: true,
    rollupOptions: { input: "mobile.html" },
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
