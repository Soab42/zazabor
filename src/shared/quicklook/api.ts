import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The start of a file as text (`fs_read_text`). */
export interface TextPreview {
  text: string;
  /** The file is longer than what was read. */
  truncated: boolean;
  /** Looks like binary data; `text` is empty. */
  binary: boolean;
}

/** One progress report of a folder size job (`fs-size`). */
export interface FolderSize {
  bytes: number;
  files: number;
  done: boolean;
}

/** Reads at most `maxBytes` of a file as text. */
export const readText = (path: string, maxBytes: number) => invoke<TextPreview>("fs_read_text", { path, maxBytes });

/** A file's raw bytes; rejects when it is larger than `maxBytes`. */
export const readBinary = (path: string, maxBytes: number) => invoke<ArrayBuffer>("fs_read_binary", { path, maxBytes });

/** The number of direct children of a folder. */
export const folderItemCount = (path: string) => invoke<{ items: number }>("fs_info", { path }).then((info) => info.items);

/**
 * Measures a folder in the background and reports progress (about five times a second) until
 * done. Returns a function that cancels the job and stops reporting.
 */
export function watchFolderSize(path: string, onProgress: (size: FolderSize) => void, onError?: (message: string) => void): () => void {
  let id: number | null = null;
  let stopped = false;
  let unlisten: (() => void) | null = null;
  // Events can arrive before the command resolves with the id, so buffer until it is known.
  const early: { id: number; bytes: number; files: number; done: boolean }[] = [];
  const deliver = (e: { id: number; bytes: number; files: number; done: boolean }) => {
    if (!stopped && e.id === id) onProgress({ bytes: e.bytes, files: e.files, done: e.done });
  };
  void listen<{ id: number; bytes: number; files: number; done: boolean }>("fs-size", (event) => {
    if (id === null) early.push(event.payload);
    else deliver(event.payload);
  }).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });
  invoke<number>("fs_folder_size", { path })
    .then((job) => {
      id = job;
      if (stopped) {
        void invoke("fs_folder_size_cancel", { id: job });
        return;
      }
      early.splice(0).forEach(deliver);
    })
    .catch((e) => onError?.(String(e)));
  return () => {
    stopped = true;
    unlisten?.();
    if (id !== null) void invoke("fs_folder_size_cancel", { id });
  };
}
