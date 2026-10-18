import { invoke } from "@tauri-apps/api/core";
import type { Crumb } from "./path";

/**
 * Cloud drives mounted by GVfs (Google Drive, OneDrive) keep their files under ids on disk; the
 * backend lists them with their titles (src-tauri/src/fs/cloud.rs). These are the titles for
 * paths shown outside a listing: path bar steps and tab names.
 */

/** The account folder of a cloud drive, e.g. /run/user/1000/gvfs/google-drive:host=gmail.com,user=me */
const ACCOUNT = /^(.*\/gvfs\/(?:google-drive|onedrive):[^/]+)/;

export const isCloudPath = (path: string) => ACCOUNT.test(path);

const titles = new Map<string, string>();

/** Remembers the titles a listing brought (cloud entries carry their title as `name`). */
export function learnTitles(entries: readonly { path: string; name: string }[]) {
  for (const entry of entries) if (isCloudPath(entry.path)) titles.set(entry.path, entry.name);
}

export const cachedTitle = (path: string): string | undefined => titles.get(path);

/** A cloud path's crumbs from its account down, with the titles known so far. */
export function cloudCrumbs(list: Crumb[]): Crumb[] {
  const start = list.findIndex((c) => ACCOUNT.exec(c.path)?.[1] === c.path);
  if (start < 0) return list;
  return list.slice(start).map((c) => ({ ...c, name: titles.get(c.path) ?? c.name }));
}

/** A folder below `root`, step by step in titles ("My Drive/Projects"), as far as they're known. */
export function titledBelow(folder: string, root: string): string {
  let at = root;
  return folder.slice(root.length + 1).split("/").map((part) => {
    at += `/${part}`;
    return titles.get(at) ?? part;
  }).join("/");
}

/** Paths being asked for, so rows of the same folder don't each ask. */
const asking = new Set<string>();

/** Asks the backend for the titles of crumbs not seen in a listing yet; true when any arrived. */
export async function fetchTitles(list: Crumb[]): Promise<boolean> {
  const unknown = cloudCrumbs(list).filter((c) => !titles.has(c.path) && !asking.has(c.path));
  if (unknown.length === 0) return false;
  for (const c of unknown) asking.add(c.path);
  const found = await invoke<(string | null)[]>("fs_titles", { paths: unknown.map((c) => c.path) }).catch(() => []);
  let any = false;
  unknown.forEach((c, i) => {
    asking.delete(c.path);
    const title = found[i];
    if (title) {
      titles.set(c.path, title);
      any = true;
    }
  });
  return any;
}
