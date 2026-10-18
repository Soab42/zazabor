/** Pure rules for the play queue, resume points and the lists built from them (no DOM). */

export interface Position {
  time: number;
  length: number;
  at: number;
}

export type RepeatMode = "off" | "all" | "one";

/** Between these fractions a video counts as in progress: it resumes and shows a progress bar. */
export const RESUME_MIN = 0.05;
export const RESUME_MAX = 0.95;
export const MAX_POSITIONS = 500;
export const MAX_RECENT = 50;

/** How far through a video the position is, 0–1 (0 when unknown). */
export function progressOf(position: Position | undefined): number {
  if (!position || position.length <= 0) return 0;
  return Math.min(1, Math.max(0, position.time / position.length));
}

export function isInProgress(position: Position | undefined): boolean {
  const p = progressOf(position);
  return p > RESUME_MIN && p < RESUME_MAX;
}

export function isFinished(position: Position | undefined): boolean {
  return progressOf(position) >= RESUME_MAX;
}

/** Where to start playing: the saved time when in progress, otherwise 0. */
export function resumeTime(position: Position | undefined): number {
  return position && isInProgress(position) ? Math.floor(position.time) : 0;
}

/** Keeps the `max` most recently watched resume points. */
export function trimPositions<T extends { at: number }>(positions: Record<string, T>, max = MAX_POSITIONS): Record<string, T> {
  const entries = Object.entries(positions);
  if (entries.length <= max) return positions;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, max));
}

/** Puts `path` first in the recent list, without duplicates, at most `max` long. */
export function addRecent(recent: string[], path: string, max = MAX_RECENT): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, max);
}

/** In-progress videos, most recently watched first. */
export function continueWatching(positions: Record<string, Position>): { path: string; position: Position }[] {
  return Object.entries(positions)
    .filter(([, position]) => isInProgress(position))
    .map(([path, position]) => ({ path, position }))
    .sort((a, b) => b.position.at - a.position.at);
}

/**
 * The index to play after `index`, or null at the end of the queue. `random` returns 0–1 and
 * only matters with shuffle on.
 */
export function nextIndex(length: number, index: number, repeat: RepeatMode, shuffle: boolean, random: () => number = Math.random): number | null {
  if (length === 0) return null;
  if (repeat === "one") return index;
  if (shuffle && length > 1) {
    const pick = Math.floor(random() * (length - 1));
    return pick >= index ? pick + 1 : pick;
  }
  if (index + 1 < length) return index + 1;
  return repeat === "all" ? 0 : null;
}

/** The index before `index`, wrapping around only when repeating the whole queue. */
export function previousIndex(length: number, index: number, repeat: RepeatMode): number | null {
  if (length === 0) return null;
  if (index > 0) return index - 1;
  return repeat === "all" ? length - 1 : null;
}

/** What "previous" does: restart when more than 3 s in, otherwise go to the previous item. */
export function previousAction(time: number, length: number, index: number, repeat: RepeatMode): { restart: true } | { index: number } {
  if (time > 3000) return { restart: true };
  const prev = previousIndex(length, index, repeat);
  return prev === null ? { restart: true } : { index: prev };
}

export type VideoSort = "name" | "date" | "size";

/** Sorts a copy of a video list; names compare naturally (episode 2 before episode 10). */
export function sortVideos<T extends { name: string; size: number; mtime: number }>(files: T[], key: VideoSort, ascending: boolean): T[] {
  const dir = ascending ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...files].sort((a, b) => {
    const diff = key === "name" ? collator.compare(a.name, b.name) : key === "date" ? a.mtime - b.mtime : a.size - b.size;
    return (diff || collator.compare(a.name, b.name)) * dir;
  });
}
