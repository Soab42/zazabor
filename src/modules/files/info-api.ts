import { invoke } from "@tauri-apps/api/core";

/**
 * The contract between Quick Look, Get Info and tags and the Rust backend
 * (src-tauri/src/fs/{info,tags,text}.rs). Command names and payload shapes must match exactly.
 * Everything rejects with "locked" while the app is locked.
 */

export { readText, readBinary, watchFolderSize, type FolderSize, type TextPreview } from "../../shared/quicklook/api";

/** Metadata for Get Info (`fs_info`). A symlink is described, not followed. */
export interface FsInfo {
  kind: "folder" | "file" | "link";
  /** Bytes; 0 for folders (see `watchFolderSize`). */
  size: number;
  /** Direct children of a folder (0 otherwise). */
  items: number;
  /** Seconds since the Unix epoch; null where the filesystem does not record it. */
  created: number | null;
  modified: number;
  accessed: number;
  /** "rwxr-xr-x". */
  permissions: string;
  /** Octal, e.g. "755". */
  mode: string;
  owner: string;
  group: string;
  linkTarget?: string | null;
  readOnly: boolean;
}

/** The colour tags, stored by `name` in the `user.xdg.tags` extended attribute. */
export const TAG_COLORS = [
  { name: "Red", css: "var(--tag-red)" },
  { name: "Orange", css: "var(--tag-orange)" },
  { name: "Yellow", css: "var(--tag-yellow)" },
  { name: "Green", css: "var(--tag-green)" },
  { name: "Blue", css: "var(--tag-blue)" },
  { name: "Purple", css: "var(--tag-purple)" },
  { name: "Grey", css: "var(--tag-grey)" },
] as const;

export type TagName = (typeof TAG_COLORS)[number]["name"];

export const infoApi = {
  info: (path: string) => invoke<FsInfo>("fs_info", { path }),
  /** Tags per path; paths without tags are absent from the map. */
  tagsGet: (paths: string[]) => invoke<Record<string, string[]>>("fs_tags_get", { paths }),
  /** Replaces a path's tags ([] removes them). Rejects when the filesystem has no user xattrs. */
  tagsSet: (path: string, tags: string[]) => invoke<void>("fs_tags_set", { path, tags }),
};
