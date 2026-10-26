import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isImageExt, isVideoExt } from "../modules/files/kinds";
import type { ModuleId } from "./module";

/**
 * CorePro can run several windows: the main one and any opened with `openWindow` (a module, or a
 * single file in a viewer). They share the backend, the saved config and the privacy lock; these
 * helpers say which window this is and carry messages between them.
 */

/**
 * What an extra window shows: a module (Files can start in a folder), or one file on its own.
 * `siblings` are the files a window for one file browses through, in order.
 */
export type WindowStart =
  | { module: ModuleId; path?: string | null; siblings?: string[] | null }
  | { module: "viewer"; path: string }
  /** A sticky note on the desktop; `path` is the note's id. */
  | { module: "note"; path: string }
  /** The Win+V clipboard popup. */
  | { module: "clipboard-popup"; path?: null };

/** Where this window starts; null for the main window. Set by the backend before the page loads. */
export const windowStart: WindowStart | null = (window as { __COREPRO_WINDOW__?: WindowStart }).__COREPRO_WINDOW__ ?? null;

export const windowLabel = getCurrentWindow().label;
export const isMainWindow = windowLabel === "main";

/**
 * A window for one picture or one video: only the viewer or the player, nothing around it. (A
 * Files window with a path is the file manager in that folder.)
 */
export const isFileWindow = !!windowStart?.path && (windowStart.module === "gallery" || windowStart.module === "video");

/** Closes this window. */
export const closeThisWindow = () => void getCurrentWindow().close().catch(() => undefined);

/**
 * Opens another window on a module (Files can start in `path`). A window for one picture or video
 * browses through `siblings` (in that order), or else the files of its folder.
 */
export function openWindow(module: ModuleId, path?: string, siblings?: string[]) {
  invoke("open_window", { module, path: path ?? null, siblings: siblings ?? null })
    .catch((err) => console.warn("Could not open a window:", err));
}

/** Opens a file on its own in a viewer window (images, video, PDF, text and code…). */
export function openViewerWindow(path: string) {
  invoke("open_window", { module: "viewer", path }).catch((err) => console.warn("Could not open a window:", err));
}

/**
 * Opens an item in its own window, in the place that suits it: a folder in Files, a picture in the
 * Gallery viewer, a video in the player, anything else in a viewer (text and code in the editor).
 * A picture or video browses through `siblings`: the ones of its kind among them, in that order.
 */
export function openFileWindow(item: { path: string; dir: boolean; ext: string }, siblings?: { path: string; ext: string }[]) {
  const ofKind = (is: (ext: string) => boolean) => siblings?.filter((s) => is(s.ext)).map((s) => s.path);
  if (item.dir) openWindow("files", item.path);
  else if (isImageExt(item.ext)) openWindow("gallery", item.path, ofKind(isImageExt));
  else if (isVideoExt(item.ext)) openWindow("video", item.path, ofKind(isVideoExt));
  else openViewerWindow(item.path);
}

/** Tells the other windows something; they get `payload` through `onOthers`. */
export function tellOthers<T>(event: string, payload: T) {
  void emit(event, { from: windowLabel, payload }).catch(() => undefined);
}

/** Listens for messages from the other windows (never this window's own). */
export function onOthers<T>(event: string, fn: (payload: T) => void): Promise<UnlistenFn> {
  return listen<{ from: string; payload: T }>(event, (e) => {
    if (e.payload.from !== windowLabel) fn(e.payload.payload);
  });
}
