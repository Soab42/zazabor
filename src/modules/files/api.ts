import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { learnTitles } from "./cloud";

/**
 * The contract between the Files module and the Rust `fs` backend (src-tauri/src/fs/).
 * Command names and payload shapes here must match the Rust side exactly.
 */

export interface FsEntry {
  name: string;
  /** Absolute path. */
  path: string;
  /** A folder, or a symlink that points at one. */
  dir: boolean;
  /** A symbolic link (`dir` tells what it points at). */
  link: boolean;
  /** Name starts with a dot. */
  hidden: boolean;
  /** Bytes; 0 for folders. */
  size: number;
  /** Modification time, seconds since the Unix epoch. */
  mtime: number;
  /** Lower-case extension without the dot, "" when there is none (always "" for folders). */
  ext: string;
  /** The content type, when the listing knows it (cloud drives). */
  mime?: string;
  /** A web address that opens the item: a Google Doc is a link, not a file. */
  url?: string;
}

export type PlaceKind = "home" | "desktop" | "documents" | "downloads" | "pictures" | "videos" | "music" | "trash";

/** A standard folder for the sidebar's Favourites. Only folders that exist are returned. */
export interface Place {
  kind: PlaceKind;
  name: string;
  path: string;
}

/** A mounted disk: the root filesystem, internal partitions, USB drives, phones and shares. */
export interface Volume {
  name: string;
  /** Where it is mounted. */
  path: string;
  /** Bytes. */
  total: number;
  free: number;
  /** USB sticks, SD cards, phones: things the user can eject. */
  removable: boolean;
}

export const fsApi = {
  /** Lists a folder. Rejects with a readable message for missing folders or permission errors. */
  list: async (path: string, showHidden: boolean) => {
    const entries = await invoke<FsEntry[]>("fs_list", { path, showHidden });
    learnTitles(entries);
    return entries;
  },
  stat: (path: string) => invoke<FsEntry>("fs_stat", { path }),
  places: () => invoke<Place[]>("fs_places"),
  volumes: () => invoke<Volume[]>("fs_volumes"),
  /** Starts watching a folder; changes arrive through `onChanged`. Watches are reference-counted. */
  watch: (path: string) => invoke<void>("fs_watch", { path }),
  unwatch: (path: string) => invoke<void>("fs_unwatch", { path }),
  /** Opens a file or folder with the system's default application. */
  openDefault: (path: string) => invoke<void>("fs_open_default", { path }),
};

/** Fires (debounced, ~150 ms) when something inside a watched folder changes. */
export function onChanged(handler: (folder: string) => void): Promise<UnlistenFn> {
  return listen<{ path: string }>("fs-changed", (event) => handler(event.payload.path));
}
