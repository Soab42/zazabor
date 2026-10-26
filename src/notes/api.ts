import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { windowLabel } from "../shell/windows";

/** The note colours, as Microsoft Sticky Notes has them. */
export const NOTE_COLORS = ["yellow", "green", "pink", "purple", "blue", "gray", "charcoal"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const COLOR_NAMES: Record<NoteColor, string> = {
  yellow: "Yellow", green: "Green", pink: "Pink", purple: "Purple", blue: "Blue", gray: "Gray", charcoal: "Charcoal",
};

/** A sticky note; mirrors `Note` in `src-tauri/src/notes/mod.rs`. */
export interface Note {
  id: string;
  /** Shown above the text; "" for none. */
  title: string;
  /** Markdown, see `markdown.ts`. */
  body: string;
  color: NoteColor;
  pinned: boolean;
  /** The Kanban column it's in (the column's name). */
  status?: string;
  /** Where it was dragged to among the others (higher first); see `orderOf`. */
  position?: number;
  /** Milliseconds since the epoch. */
  created: number;
  updated: number;
  /** In Recently Deleted since then. */
  deleted?: number;
}

/** Where a note's window is on this computer (logical pixels). */
export interface NoteWindowState {
  open: boolean;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  onTop: boolean;
}

export interface SyncStatus {
  folder: string | null;
  state: "off" | "idle" | "syncing" | "error";
  /** When the last sync finished. */
  last: number | null;
  error: string | null;
}

export interface NotesChanged {
  notes: Note[];
  removed: string[];
  /** The window that made the change (it shows it already). */
  origin: string | null;
}

export const notesApi = {
  list: () => invoke<Note[]>("notes_list"),
  get: (id: string) => invoke<Note | null>("notes_get", { id }),
  /** Without a colour, the note takes the next one in turn. */
  create: (options: { color?: NoteColor; body?: string; status?: string } = {}) =>
    invoke<Note>("notes_create", { color: options.color ?? null, body: options.body ?? null, status: options.status ?? null, origin: windowLabel }),
  /** Changes what's given; `status: null` takes the note out of the Kanban columns. */
  update: (id: string, patch: { title?: string; body?: string; color?: NoteColor; pinned?: boolean; status?: string | null; position?: number }) =>
    invoke<Note>("notes_update", {
      id,
      title: patch.title ?? null,
      body: patch.body ?? null,
      color: patch.color ?? null,
      pinned: patch.pinned ?? null,
      status: patch.status === undefined ? null : patch.status ?? "",
      position: patch.position ?? null,
      origin: windowLabel,
    }),
  remove: (id: string) => invoke<void>("notes_delete", { id }),
  restore: (id: string) => invoke<Note>("notes_restore", { id }),
  /** Deletes for good from Recently Deleted; every deleted note when `ids` is empty. */
  purge: (ids: string[]) => invoke<void>("notes_purge", { ids }),
  /** Shows the note in its own window (or brings that window forward). */
  open: (id: string) => invoke<void>("notes_open", { id }),
  reopen: () => invoke<void>("notes_reopen"),
  windowState: (id: string) => invoke<NoteWindowState>("notes_window", { id }),
  setWindowState: (id: string, state: NoteWindowState) => invoke<void>("notes_set_window", { id, state }),
  syncStatus: () => invoke<SyncStatus>("notes_sync_status"),
  setSyncFolder: (folder: string | null) => invoke<void>("notes_sync_set_folder", { folder }),
  syncNow: () => invoke<void>("notes_sync_now"),
};

/** Where a note sorts among the others, higher first: where it was dragged to, else when it was made. */
export function orderOf(note: Note): number {
  return note.position ?? note.created;
}

/**
 * The position for a note dropped between two others (`before` shows above it, `after` below);
 * either may be missing at the ends of a list.
 */
export function positionBetween(before: Note | undefined, after: Note | undefined, fallback: number): number {
  if (before && after) return (orderOf(before) + orderOf(after)) / 2;
  if (before) return orderOf(before) - 1000;
  if (after) return orderOf(after) + 1000;
  return fallback;
}

export function onNotesChanged(fn: (change: NotesChanged) => void): Promise<UnlistenFn> {
  return listen<NotesChanged>("notes-changed", (e) => fn(e.payload));
}

export function onSyncStatus(fn: (status: SyncStatus) => void): Promise<UnlistenFn> {
  return listen<SyncStatus>("notes-sync", (e) => fn(e.payload));
}

/** "Synced 2 min ago", "Syncing…", the error, or "Sync is off". */
export function syncText(status: SyncStatus): string {
  if (status.state === "off") return "Sync is off";
  if (status.state === "syncing") return "Syncing…";
  if (status.state === "error") return status.error ?? "Sync failed";
  return status.last ? `Synced ${ago(status.last)}` : "Waiting to sync";
}

/** A short relative time: "just now", "5 min ago", "yesterday", or a date. */
export function ago(ms: number): string {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 2 * 86_400) return "yesterday";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: seconds > 300 * 86_400 ? "numeric" : undefined });
}
