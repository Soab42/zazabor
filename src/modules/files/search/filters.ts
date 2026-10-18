import type { FsEntry } from "../api";
import { categoryOf, type Category } from "../kinds";

export type KindFilter = "folders" | "images" | "videos" | "audio" | "documents" | "code" | "archives";
export type ModifiedFilter = "today" | "week" | "month" | "year";
export type SizeFilter = "mb1" | "mb100" | "gb1";

/** The chips under the toolbar: any of the chosen kinds, one age limit, one size limit. */
export interface SearchFilters {
  kinds: Set<KindFilter>;
  modified: ModifiedFilter | null;
  size: SizeFilter | null;
}

export const newFilters = (): SearchFilters => ({ kinds: new Set(), modified: null, size: null });

export const KIND_CHIPS: { id: KindFilter; label: string }[] = [
  { id: "folders", label: "Folders" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "audio", label: "Audio" },
  { id: "documents", label: "Documents" },
  { id: "code", label: "Code" },
  { id: "archives", label: "Archives" },
];

export const MODIFIED_CHIPS: { id: ModifiedFilter; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "Last 30 days" },
  { id: "year", label: "This year" },
];

export const SIZE_CHIPS: { id: SizeFilter; label: string }[] = [
  { id: "mb1", label: "> 1 MB" },
  { id: "mb100", label: "> 100 MB" },
  { id: "gb1", label: "> 1 GB" },
];

const KIND_OF: Record<Category, KindFilter | null> = {
  folder: "folders", image: "images", video: "videos", audio: "audio",
  document: "documents", code: "code", archive: "archives", generic: null,
};

const MB = 1024 * 1024;
const SIZE_MIN: Record<SizeFilter, number> = { mb1: MB, mb100: 100 * MB, gb1: 1024 * MB };
const DAY = 86400;

export const hasFilters = (f: SearchFilters) => f.kinds.size > 0 || f.modified !== null || f.size !== null;

/** Seconds since the epoch of the oldest modification time a "Modified" chip accepts. */
export function modifiedSince(filter: ModifiedFilter, now = new Date()): number {
  const seconds = now.getTime() / 1000;
  switch (filter) {
    case "today": return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    case "week": return seconds - 7 * DAY;
    case "month": return seconds - 30 * DAY;
    default: return new Date(now.getFullYear(), 0, 1).getTime() / 1000;
  }
}

export function matchesFilters(entry: FsEntry, f: SearchFilters, now = new Date()): boolean {
  if (f.kinds.size > 0) {
    const kind = KIND_OF[categoryOf(entry)];
    if (!kind || !f.kinds.has(kind)) return false;
  }
  if (f.modified && entry.mtime < modifiedSince(f.modified, now)) return false;
  // Size limits are about files; a folder's size is not measured.
  if (f.size && (entry.dir || entry.size <= SIZE_MIN[f.size])) return false;
  return true;
}

/** The entries that pass every chip (the same array when no chip is on). */
export function applyFilters(entries: FsEntry[], f: SearchFilters): FsEntry[] {
  if (!hasFilters(f)) return entries;
  const now = new Date();
  return entries.filter((e) => matchesFilters(e, f, now));
}
