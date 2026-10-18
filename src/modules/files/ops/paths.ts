import type { BrowserContext } from "../browser";
import type { FsEntry } from "../api";
import { samePath } from "../path";

const TRASH_FILES = /\/(?:Trash|\.Trash-\d+|\.Trash\/\d+)\/files(?:\/|$)/;
const TRASH_ROOT = /\/(?:Trash|\.Trash-\d+|\.Trash\/\d+)\/files\/?$/;

/** The folder is inside a Trash `files` folder (or is one). */
export const inTrash = (folder: string) => TRASH_FILES.test(folder);

/** The folder is the top level of a Trash, where items can be put back or deleted for good. */
export const atTrashRoot = (folder: string) => TRASH_ROOT.test(folder);

/**
 * Where Paste goes: the single selected folder when it also has the keyboard focus, otherwise
 * the folder being shown.
 */
export function pasteTarget(ctx: BrowserContext): string {
  const selected = ctx.selected();
  const focused = ctx.focused();
  if (selected.length === 1 && selected[0].dir && focused && samePath(focused.path, selected[0].path)) return selected[0].path;
  return ctx.folder;
}

/** The one entry an action like Rename applies to: the sole selection, else the focused selected one. */
export function singleTarget(ctx: BrowserContext): FsEntry | null {
  const selected = ctx.selected();
  if (selected.length === 1) return selected[0];
  const focused = ctx.focused();
  return focused && selected.some((e) => e.path === focused.path) ? focused : null;
}
