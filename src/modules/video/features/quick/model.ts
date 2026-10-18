/** Pure rules for bookmarks and chapters (no DOM), used by the Bookmarks tab and the seek bar ticks. */

export interface Bookmark {
  /** Unique within its file. */
  id: number;
  /** Milliseconds from the start. */
  time: number;
  name: string;
}

export interface ChapterLike {
  start: number;
  name: string;
}

const AUTO_NAME = /^Bookmark (\d+)$/;

/** "Bookmark N" with N one past the highest auto-numbered bookmark (so deleting never reuses a name still shown). */
export function nextBookmarkName(existing: Bookmark[]): string {
  let highest = 0;
  for (const b of existing) {
    const match = AUTO_NAME.exec(b.name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `Bookmark ${highest + 1}`;
}

/** Adds a bookmark, keeping the list in time order. Bookmarks within `minGap` ms of one another are not duplicated. */
export function addBookmark(list: Bookmark[], time: number, minGap = 500): { list: Bookmark[]; added: Bookmark | null } {
  const at = Math.max(0, Math.round(time));
  if (list.some((b) => Math.abs(b.time - at) < minGap)) return { list, added: null };
  const id = list.reduce((max, b) => Math.max(max, b.id), 0) + 1;
  const added = { id, time: at, name: nextBookmarkName(list) };
  return { list: [...list, added].sort((a, b) => a.time - b.time || a.id - b.id), added };
}

/** A new name for a bookmark; blank names keep the old one. */
export function renameBookmark(list: Bookmark[], id: number, name: string): Bookmark[] {
  const clean = name.trim().slice(0, 80);
  if (!clean) return list;
  return list.map((b) => (b.id === id ? { ...b, name: clean } : b));
}

export function removeBookmark(list: Bookmark[], id: number): Bookmark[] {
  return list.filter((b) => b.id !== id);
}

/** Index of the chapter playing at `time` (the last one that has started), -1 before the first. */
export function chapterIndexAt(chapters: ChapterLike[], time: number): number {
  let index = -1;
  chapters.forEach((c, i) => {
    if (c.start <= time) index = i;
  });
  return index;
}

/** Accepts only well-formed stored bookmarks (the config file may have been edited or come from a newer version). */
export function cleanBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: Bookmark[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const { id, time, name } = b as Record<string, unknown>;
    if (typeof id !== "number" || typeof time !== "number" || typeof name !== "string" || seen.has(id) || time < 0) continue;
    seen.add(id);
    out.push({ id, time, name });
  }
  return out.sort((a, b) => a.time - b.time || a.id - b.id);
}
