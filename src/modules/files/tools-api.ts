import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FsEntry } from "./api";

/**
 * The contract between the Files search and tools and the Rust backend (src-tauri/src/fs/search.rs,
 * archive.rs, apps.rs). Command names, argument names and payload shapes must match exactly.
 *
 * Compress and extract run as background jobs on the shared `fs-job` channel (see ops-api.ts); they
 * are reported with `kind: "copy"`, and the final event's `results` holds the archive or the folder
 * that was created. Search streams `fs-search` events.
 */

export interface SearchOptions {
  /** Look inside hidden folders and match hidden files. */
  showHidden: boolean;
  /** Also walk `node_modules` and `.git` (default false). */
  includeIgnored?: boolean;
}

/** The `fs-search` event payload: batches arrive as they are found, each sorted best first. */
export interface SearchEvent {
  id: number;
  results: FsEntry[];
  /** Relevance of each result (higher is better), parallel to `results`. */
  scores: number[];
  /** Entries looked at so far. */
  scanned: number;
  /** The last event of a search. A cancelled search sends none. */
  done: boolean;
  /** The 5,000-result cap was hit. */
  truncated: boolean;
}

export interface AppInfo {
  /** The desktop file id ("org.gnome.TextEditor.desktop"). */
  id: string;
  name: string;
  /** A `data:` URL for the app's icon, when one could be found. */
  icon?: string;
  isDefault: boolean;
}

export interface AppsFor {
  mime: string;
  /** The default app first (marked), then the other handlers. */
  apps: AppInfo[];
}

export const toolsApi = {
  /** Starts a recursive search under `root`; returns its id. Events may arrive before this resolves. */
  search: (root: string, query: string, options: SearchOptions) => invoke<number>("fs_search", { root, query, options }),
  searchCancel: (id: number) => invoke<void>("fs_search_cancel", { id }),
  /** Zips items into `destDir` ("name.zip", or "Archive.zip" for several); returns the job id. */
  compress: (sources: string[], destDir: string) => invoke<number>("fs_compress", { sources, destDir }),
  /** Extracts a zip or tar(.gz/.tgz/.xz/.bz2) into a new folder named after it; returns the job id. */
  extract: (archive: string, destDir: string) => invoke<number>("fs_extract", { archive, destDir }),
  /** The apps that open this file, default first. */
  appsFor: (path: string) => invoke<AppsFor>("fs_apps_for", { path }),
  openWith: (path: string, appId: string) => invoke<void>("fs_open_with", { path, appId }),
  setDefaultApp: (mime: string, appId: string) => invoke<void>("fs_set_default_app", { mime, appId }),
  /** Opens a terminal in `dir`: `terminal` (a command) if given, else the first one installed. */
  openTerminal: (dir: string, terminal?: string | null) => invoke<void>("fs_open_terminal", { dir, terminal: terminal ?? null }),
};

export function onSearch(handler: (event: SearchEvent) => void): Promise<UnlistenFn> {
  return listen<SearchEvent>("fs-search", (event) => handler(event.payload));
}

/** Extensions the backend can extract (the last part of a name like "x.tar.gz" is enough). */
const ARCHIVE_NAME = /\.(zip|tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2|tbz)$/i;
export const isExtractable = (name: string) => ARCHIVE_NAME.test(name) && name.replace(ARCHIVE_NAME, "").length > 0;
