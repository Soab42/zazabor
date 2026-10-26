import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyAppearance } from "../appearance";
import { adoptConfig, CONFIG_SAVED, parseConfig, saveConfig, type Config } from "../config";
import { followLock } from "../lock";
import { fsApi, type FsEntry } from "../modules/files/api";
import { isCloudPath } from "../modules/files/cloud";
import { categoryOf, iconNameFor, iconNode, kindLabel, sizeText } from "../modules/files/kinds";
import { buildBody, type Body } from "../shared/quicklook/bodies";
import { readText } from "../shared/quicklook/api";
import "../shared/quicklook/quicklook.css";
import type { ShellContext } from "../shell/module";
import { onOthers, openFileWindow, openWindow } from "../shell/windows";
import { dirname, h } from "../ui/dom";
import { icon } from "../ui/icons";
import "./viewer.css";

/**
 * A window showing one file on its own, to put anywhere next to the app: text and code open in
 * the editor (with the file's folder in its Explorer), everything else in a large preview.
 */
export async function startViewer(config: Config, path: string) {
  document.body.classList.add("viewer-window");
  applyAppearance(config.appearance);
  await followLock();
  const app = document.getElementById("app")!;
  const win = getCurrentWindow();
  const setTitle = (text: string) => void win.setTitle(text).catch(() => undefined);

  let entry: FsEntry;
  try {
    entry = await fsApi.stat(path);
  } catch (err) {
    app.append(h("div", { class: "vw-error" }, icon("file", 40), h("p", null, `Can’t open this file: ${err}`)));
    return;
  }

  let themeChanged = () => {};
  void onOthers<string>(CONFIG_SAVED, (json) => {
    try {
      adoptConfig(config, parseConfig(json));
    } catch {
      return;
    }
    applyAppearance(config.appearance);
    themeChanged();
  });

  if (await isText(entry)) {
    const { CodeEditor } = await import("../editor/editor");
    const editor = new CodeEditor(await projectRoot(dirname(path)), {
      openOther: (other) => openFileWindow(other),
      setTitle,
      terminalSettings: () => config.terminal,
      saveSettings: () => saveConfig(config),
    });
    app.append(editor.el);
    themeChanged = () => editor.themeChanged();
    await editor.open(path);
    // Unsaved changes are asked about before the window goes.
    void win.onCloseRequested(async (event) => {
      if (!editor.dirty) return;
      event.preventDefault();
      if (await editor.confirmClose()) await win.destroy();
    });
    return;
  }

  setTitle(entry.name);
  app.append(preview(entry));
}

/** Files and folders that mark the top of a project. */
const PROJECT_MARKERS = new Set([".git", ".hg", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "pom.xml",
  "build.gradle", "composer.json", "Gemfile", "deno.json", ".vscode"]);

/**
 * The project a folder belongs to (the nearest folder at or above it with a marker), else the
 * folder itself. The home folder is never the project, even with a .git or package.json in it.
 */
async function projectRoot(dir: string): Promise<string> {
  if (isCloudPath(dir)) return dir;
  const home = (await homeDir().catch(() => "")).replace(/\/+$/, "");
  let at = dir;
  for (let depth = 0; depth < 8 && at !== home; depth++) {
    const entries = await fsApi.list(at, true).catch(() => [] as FsEntry[]);
    if (entries.some((e) => PROJECT_MARKERS.has(e.name))) return at;
    const parent = dirname(at);
    if (!parent || parent === at || parent === "/") break;
    at = parent;
  }
  return dir;
}

/** Text the editor can take: not a picture, video, sound, archive, PDF or web document, and not binary. */
async function isText(entry: FsEntry): Promise<boolean> {
  const category = categoryOf(entry);
  if (entry.dir || entry.url || entry.ext === "pdf" || ["image", "video", "audio", "archive"].includes(category)) return false;
  const start = await readText(entry.path, 64 * 1024).catch(() => null);
  return !!start && !start.binary;
}

/** The Quick Look preview of a file, filling the window, with its name and a way to open it. */
function preview(entry: FsEntry): HTMLElement {
  const sub = h("div", { class: "vw-sub" }, [kindLabel(entry), entry.dir ? "" : sizeText(entry)].filter(Boolean).join(" · "));
  const open = h("button", { class: "btn small ghost", type: "button", onclick: () => openOutside(entry) },
    icon("external", 14), entry.url ? "Open in Browser" : "Open with Default App");
  const show = h("button", { class: "btn small ghost", type: "button", onclick: () => openWindow("files", dirname(entry.path)) },
    icon("folder", 14), "Show in Files");
  const head = h("header", { class: "vw-head" },
    h("span", { class: "vw-glyph" }, iconNode(iconNameFor(categoryOf(entry)), 18)),
    h("div", { class: "vw-titles" }, h("div", { class: "vw-title", title: entry.path }, entry.name), sub),
    show, open);
  const stage = h("div", { class: "vw-stage" });
  const shell = {
    open: (request: { kind: string; path: string }) => openFileWindow({ path: request.path, dir: request.kind === "folder", ext: request.kind === "video" ? "mp4" : "" }),
    openExternally: (p: string) => void invoke("fs_open_default", { path: p }).catch(() => undefined),
  } as unknown as ShellContext;
  let body: Body | null = buildBody(entry, {
    shell,
    siblings: () => [entry],
    isCurrent: () => body !== null,
    setMeta: (text) => (sub.textContent = [kindLabel(entry), sizeText(entry), text].filter(Boolean).join(" · ")),
    width: () => stage.clientWidth,
  });
  stage.append(body.el);
  window.addEventListener("beforeunload", () => {
    body?.dispose?.();
    body = null;
  });
  return h("div", { class: "vw" }, head, stage);
}

function openOutside(entry: FsEntry) {
  void invoke("fs_open_default", { path: entry.url ?? entry.path }).catch(() => undefined);
}

