import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `src-tauri/src/time/mod.rs`; every time is milliseconds since the epoch. */
export type ActivityKind = "short_break" | "lunch" | "prayer" | "meeting" | "other";
export type EntryKind = "work" | ActivityKind;
export type TaskKind = "development" | "meeting";

export const ACTIVITY_KINDS: readonly ActivityKind[] = ["short_break", "lunch", "prayer", "meeting", "other"];

export interface Task {
  id: string;
  title: string;
  /** "" for none. */
  project: string;
  kind: TaskKind;
  done: boolean;
  created: number;
}

/** One check-in; `end` is null while still checked in. */
export interface Session {
  id: string;
  start: number;
  end: number | null;
}

/** Time on a task (`kind` "work") or an activity; `end` is null while it runs. */
export interface Entry {
  id: string;
  kind: EntryKind;
  task: string | null;
  /** A work log's note, or what an activity was. */
  text: string;
  start: number;
  end: number | null;
  /** The task timer this activity paused; ending the activity starts it again. */
  pausedTask: string | null;
}

export interface TimeData {
  tasks: Task[];
  /** Check-ins reaching into the span asked for, oldest first. */
  sessions: Session[];
  /** Entries reaching into the span, newest first. */
  entries: Entry[];
  /** The open check-in, wherever it falls. */
  session: Session | null;
  /** What runs now, wherever it falls. */
  running: Entry | null;
  /** The backend's clock. */
  now: number;
}

export interface Report {
  /** The local day, "YYYY-MM-DD". */
  date: string;
  content: string;
  workedMin: number;
  breakMin: number;
  idleMin: number;
  status: "draft" | "submitted";
  updated: number;
  submitted: number | null;
}

export const timeApi = {
  data: (from: number, to: number) => invoke<TimeData>("time_data", { from: Math.floor(from), to: Math.ceil(to) }),
  checkIn: (at?: number) => invoke<Session>("time_check_in", { at: at ?? null }),
  checkOut: (at?: number) => invoke<Session>("time_check_out", { at: at ?? null }),
  /** Starts a task timer now, or at `at` (within today's check-in); stops what ran. */
  start: (task: string, note: string, at?: number) => invoke<Entry>("time_start", { task, note, at: at ?? null }),
  /** Starts an activity now; a running task timer pauses until it ends. */
  begin: (kind: ActivityKind, text: string) => invoke<Entry>("time_begin", { kind, text }),
  /** Stops what runs; `resumed` is the task timer an activity had paused, started again. */
  stop: () => invoke<{ stopped: Entry; resumed: Entry | null }>("time_stop"),
  add: (entry: { kind: EntryKind; task: string | null; text: string; start: number; end: number }) => invoke<Entry>("time_add", entry),
  /** `end: null` lets the entry run (only the latest, within the open check-in). */
  edit: (id: string, entry: { kind: EntryKind; task: string | null; text: string; start: number; end: number | null }) =>
    invoke<Entry>("time_edit", { id, ...entry }),
  remove: (id: string) => invoke<void>("time_delete", { id }),
  addTask: (title: string, project: string, kind: TaskKind) => invoke<Task>("time_task_add", { title, project, kind }),
  editTask: (id: string, patch: { title?: string; project?: string; kind?: TaskKind; done?: boolean }) =>
    invoke<Task>("time_task_edit", { id, title: patch.title ?? null, project: patch.project ?? null, kind: patch.kind ?? null, done: patch.done ?? null }),
  report: (date: string) => invoke<Report | null>("time_report", { date }),
  saveReport: (report: Report) => invoke<Report>("time_report_save", { report }),
};

export function onTimeChanged(fn: () => void): Promise<UnlistenFn> {
  return listen("time-changed", () => fn());
}

/** The backend's error text (commands reject with a plain string). */
export function errorText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}
