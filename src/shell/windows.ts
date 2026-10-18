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

/** What an extra window shows: a module (Files can start in a folder), or one file on its own. */
export type WindowStart = { module: ModuleId; path?: string | null } | { module: "viewer"; path: string };

/** Where this window starts; null for the main window. Set by the backend before the page loads. */
export const windowStart: WindowStart | null = (window as { __COREPRO_WINDOW__?: WindowStart }).__COREPRO_WINDOW__ ?? null;

export const windowLabel = getCurrentWindow().label;
export const isMainWindow = windowLabel === "main";

/** Opens another window on a module (Files can start in `path`). */
export function openWindow(module: ModuleId, path?: string) {
  invoke("open_window", { module, path: path ?? null }).catch((err) => console.warn("Could not open a window:", err));
}

/** Opens a file on its own in a viewer window (images, video, PDF, text and code…). */
export function openViewerWindow(path: string) {
  invoke("open_window", { module: "viewer", path }).catch((err) => console.warn("Could not open a window:", err));
}

/**
 * Opens an item in its own window, in the place that suits it: a folder in Files, a picture in the
 * Gallery viewer, a video in the player, anything else in a viewer (text and code in the editor).
 */
export function openFileWindow(item: { path: string; dir: boolean; ext: string }) {
  if (item.dir) openWindow("files", item.path);
  else if (isImageExt(item.ext)) openWindow("gallery", item.path);
  else if (isVideoExt(item.ext)) openWindow("video", item.path);
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
