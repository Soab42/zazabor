import type { FsEntry } from "./api";
import { TypeAhead } from "./sort";

/** One tab's selection: the chosen paths, the end a Shift-range grows from, and the keyboard cursor. */
export interface Sel {
  selection: Set<string>;
  anchor: string | null;
  focus: string | null;
}

export const newSel = (): Sel => ({ selection: new Set(), anchor: null, focus: null });

export interface Modifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Selects the inclusive range between the anchor and `index`. */
function selectRange(sel: Sel, entries: FsEntry[], index: number, indexOf: (path: string) => number, keepOthers: boolean) {
  const a = sel.anchor === null ? -1 : indexOf(sel.anchor);
  if (a < 0) return false;
  if (!keepOthers) sel.selection.clear();
  for (let i = Math.min(a, index); i <= Math.max(a, index); i++) sel.selection.add(entries[i].path);
  sel.focus = entries[index].path;
  return true;
}

/** Applies a mouse click on `entries[index]`: plain, Ctrl-toggle or Shift-range. */
export function clickSelect(sel: Sel, entries: FsEntry[], index: number, mods: Modifiers, indexOf: (path: string) => number) {
  const path = entries[index].path;
  const toggle = mods.ctrlKey || mods.metaKey;
  if (mods.shiftKey && selectRange(sel, entries, index, indexOf, toggle)) return;
  if (toggle) {
    if (!sel.selection.delete(path)) sel.selection.add(path);
  } else {
    sel.selection.clear();
    sel.selection.add(path);
  }
  sel.anchor = path;
  sel.focus = path;
}

/** Moves the keyboard cursor to `index`; with `extend` the selection grows from the anchor. */
export function moveSelect(sel: Sel, entries: FsEntry[], index: number, extend: boolean, indexOf: (path: string) => number) {
  if (extend && selectRange(sel, entries, index, indexOf, false)) return;
  const path = entries[index].path;
  sel.selection.clear();
  sel.selection.add(path);
  sel.anchor = path;
  sel.focus = path;
}

export function selectAll(sel: Sel, entries: FsEntry[]) {
  sel.selection = new Set(entries.map((e) => e.path));
  sel.anchor = entries[0]?.path ?? null;
  sel.focus = entries[entries.length - 1]?.path ?? null;
}

/** Index steps for the keys a view reacts to, e.g. `{ ArrowDown: cols, ArrowUp: -cols }`. */
export type KeyDeltas = Partial<Record<"ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", number>>;

/**
 * Where an arrow, Home, End or Page key takes the cursor; null when the key is not one the
 * view handles. With no cursor yet, forward keys land on the first item and backward ones on the last.
 */
export function targetIndex(key: string, current: number, count: number, deltas: KeyDeltas, page: number): number | null {
  if (count === 0) return null;
  let delta: number | undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "PageDown") delta = page;
  else if (key === "PageUp") delta = -page;
  else delta = deltas[key as keyof KeyDeltas];
  if (delta === undefined) return null;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  const next = current + delta;
  // Down on the row above a ragged last row still reaches the final item.
  if (next >= count && delta > 1 && Math.floor(current / delta) < Math.floor((count - 1) / delta)) return count - 1;
  return Math.min(count - 1, Math.max(0, next));
}

export const typeAhead = new TypeAhead();

/** Type-to-select for a printable key; the index to jump to, or -1. */
export function typeSelectIndex(e: KeyboardEvent, entries: FsEntry[], current: number): number {
  if (e.key.length !== 1 || e.key === " " || e.ctrlKey || e.metaKey || e.altKey) return -1;
  return typeAhead.find(entries.length, (i) => entries[i].name, e.key, current);
}
