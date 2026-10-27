import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * Tauri guesses a served file's type from its first bytes before its name, and takes any file with
 * "%PDF" in its first 1024 bytes for a PDF: a script like that won't load in the release build.
 */
const noPdfLookalikes: Plugin = {
  name: "zazabor-no-pdf-lookalikes",
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.fileName.endsWith(".pdf")) continue;
      const head = file.type === "chunk" ? file.code.slice(0, 1024)
        : typeof file.source === "string" ? file.source.slice(0, 1024)
        : new TextDecoder().decode(file.source.slice(0, 1024));
      if (head.includes("%PDF")) this.error(`${file.fileName} has "%PDF" in its first 1024 bytes, so the app would serve it as a PDF.`);
    }
  },
};

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  plugins: [noPdfLookalikes],
  build: {
    target: "es2022",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
