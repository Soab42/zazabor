import type { FilesSettings } from "../../config";
import type { FsEntry } from "./api";
import { kindLabel } from "./kinds";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural name order: "file2" before "file10", case-insensitive. */
export const compareNames = (a: string, b: string) => collator.compare(a, b);

/** Builds the comparison for the sort setting; folders stay on top when `foldersFirst`. */
export function entryComparator(sort: FilesSettings["sort"], foldersFirst: boolean) {
  const dir = sort.ascending ? 1 : -1;
  return (a: FsEntry, b: FsEntry): number => {
    if (foldersFirst && a.dir !== b.dir) return a.dir ? -1 : 1;
    let c = 0;
    switch (sort.key) {
      case "date": c = a.mtime - b.mtime; break;
      case "size": c = a.size - b.size; break;
      case "kind": c = compareNames(kindLabel(a), kindLabel(b)); break;
      default: c = 0;
    }
    if (c !== 0) return c * dir;
    // Name decides ties, and orders by itself for the name sort.
    return compareNames(a.name, b.name) * (sort.key === "name" ? dir : 1);
  };
}

/** A sorted copy of `entries`. */
export function sortEntries(entries: readonly FsEntry[], sort: FilesSettings["sort"], foldersFirst: boolean): FsEntry[] {
  return entries.slice().sort(entryComparator(sort, foldersFirst));
}

/** Entries whose name contains `query`, ignoring case; the list itself when the query is blank. */
export function filterEntries(entries: FsEntry[], query: string): FsEntry[] {
  const q = query.trim().toLowerCase();
  return q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
}

/** The first of `count` names, starting at `from` and wrapping, that begins with `prefix`; -1 if none. */
export function matchPrefix(count: number, nameAt: (i: number) => string, prefix: string, from: number): number {
  const p = prefix.toLowerCase();
  for (let k = 0; k < count; k++) {
    const i = (((from + k) % count) + count) % count;
    if (nameAt(i).toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

/**
 * Type-to-select: letters typed in quick succession form a prefix that jumps to the first
 * matching name. Repeating one letter cycles through the names starting with it.
 */
export class TypeAhead {
  private buffer = "";
  private last = 0;

  constructor(private readonly timeoutMs = 800) {}

  /** Feeds a typed character; returns the index to select, or -1 when nothing matches. */
  find(count: number, nameAt: (i: number) => string, char: string, current: number, now = Date.now()): number {
    if (now - this.last > this.timeoutMs) this.buffer = "";
    this.last = now;
    this.buffer += char.toLowerCase();
    if (count === 0) return -1;
    const cycle = this.buffer.length > 1 && [...this.buffer].every((c) => c === this.buffer[0]);
    const prefix = cycle ? this.buffer[0] : this.buffer;
    const from = this.buffer.length === 1 || cycle ? current + 1 : Math.max(current, 0);
    return matchPrefix(count, nameAt, prefix, from);
  }
}
