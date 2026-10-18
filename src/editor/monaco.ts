import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/**
 * Monaco, the editor VS Code is built on, set up for CorePro: its language workers (bundled, so
 * it works offline) and two themes drawn from the app's colours. Loaded only with the editor.
 */

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

export { monaco };

/** A CSS colour (token value) as #rrggbb, which Monaco's themes need. */
function hex(color: string, fallback: string): string {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !color.trim()) return fallback;
  ctx.fillStyle = fallback;
  ctx.fillStyle = color.trim();
  const value = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

/** Defines (or redefines) CorePro's dark and light editor themes from the current accent; returns the one to use. */
export function applyTheme(): string {
  const style = getComputedStyle(document.documentElement);
  const accent = hex(style.getPropertyValue("--accent"), "#3fb87a");
  // applyAppearance() marks the page with the theme in use ("System" already resolved).
  const dark = document.documentElement.dataset.theme !== "light";
  const name = dark ? "corepro-dark" : "corepro-light";
  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: dark
      ? {
          "editor.background": "#16171b",
          "editorGutter.background": "#16171b",
          "minimap.background": "#16171b",
          "editor.lineHighlightBackground": "#ffffff08",
          "editorLineNumber.foreground": "#5b5f6a",
          "editorLineNumber.activeForeground": "#c9ccd4",
          "editorCursor.foreground": accent,
          "editor.selectionBackground": `${accent}40`,
          "editor.inactiveSelectionBackground": `${accent}22`,
          "editorIndentGuide.background1": "#ffffff10",
          "editorWidget.background": "#202227",
          "editorWidget.border": "#ffffff14",
          "focusBorder": `${accent}99`,
        }
      : {
          "editor.background": "#fbfbfd",
          "editorGutter.background": "#fbfbfd",
          "minimap.background": "#fbfbfd",
          "editor.lineHighlightBackground": "#0000000a",
          "editorLineNumber.foreground": "#a3a6ae",
          "editorLineNumber.activeForeground": "#3a3d44",
          "editorCursor.foreground": accent,
          "editor.selectionBackground": `${accent}38`,
          "editor.inactiveSelectionBackground": `${accent}1f`,
          "editorWidget.background": "#ffffff",
          "editorWidget.border": "#00000014",
          "focusBorder": `${accent}99`,
        },
  });
  return name;
}

/** Monaco's language for a file name (by extension or whole name), "plaintext" when unknown. */
export function languageFor(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot) : "";
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === lower)) return lang.id;
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
  }
  return "plaintext";
}

/** The name people know a language by ("TypeScript"), for the status bar. */
export function languageName(id: string): string {
  return monaco.languages.getLanguages().find((l) => l.id === id)?.aliases?.[0] ?? id;
}
