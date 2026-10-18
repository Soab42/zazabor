import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The contract between file operations and the Rust backend (src-tauri/src/fs/ops.rs, jobs.rs,
 * trash.rs). Command names, argument names and payload shapes must match the Rust side exactly.
 *
 * Copy, move, trash, restore, delete and empty-trash run as background *jobs*: the command
 * returns a job id at once and progress arrives as `fs-job` events. The last event of a job
 * (state done, cancelled or failed) lists the resulting paths and the records that undo it.
 * Rename, new folder, duplicate and undo are quick and return their result directly.
 */

/** One reversible step; undo and redo both apply the inverse of each record (see `undo`). */
export type UndoOp =
  /** An item moved (or was renamed) from `from` to `to`. */
  | { op: "move"; from: string; to: string }
  /** A new item exists at `path` (created, copied or restored). */
  | { op: "created"; path: string }
  /** An item went to the Trash: where it was, and where it is now. */
  | { op: "trashed"; original: string; trashed: string };

export type JobKind = "copy" | "move" | "trash" | "delete";
export type JobState = "running" | "waiting" | "done" | "cancelled" | "failed";
export type Decision = "replace" | "keepBoth" | "skip";

/** A copy or move is paused on this: `target` already exists. */
export interface JobConflict {
  source: string;
  target: string;
  isDir: boolean;
}

/** The `fs-job` event payload. Events for a running job are throttled to about ten per second. */
export interface JobEvent {
  id: number;
  kind: JobKind;
  state: JobState;
  /** Items finished, of `total`. */
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  /** Name of the item being worked on. */
  current: string;
  error?: string;
  /** Present while `state` is "waiting". */
  conflict?: JobConflict;
  /** Final events only: records that reverse the job (newest last). */
  undo: UndoOp[];
  /** Final events only: resulting paths (pasted, restored or trashed items). */
  results: string[];
}

/** What `undo` did: the records for the opposite direction (redo) and what could not be done. */
export interface UndoReport {
  ops: UndoOp[];
  errors: string[];
}

export const opsApi = {
  /** Copies items into a folder; returns the job id. */
  copy: (sources: string[], destDir: string) => invoke<number>("fs_copy", { sources, destDir }),
  /** Moves items into a folder (a rename on one disk, copy-verify-delete across disks). */
  move: (sources: string[], destDir: string) => invoke<number>("fs_move", { sources, destDir }),
  /** Moves items to the Trash; the final event's `results` are their Trash locations. */
  trash: (paths: string[]) => invoke<number>("fs_trash", { paths }),
  /** Puts items from the Trash's `files` folder back where they came from. */
  restore: (paths: string[]) => invoke<number>("fs_trash_restore", { paths }),
  /** Deletes items permanently. */
  delete: (paths: string[]) => invoke<number>("fs_delete", { paths }),
  /** Deletes everything in the Trash permanently. */
  emptyTrash: () => invoke<number>("fs_empty_trash"),
  /** Answers a job that is "waiting" on a conflict. */
  resolve: (id: number, decision: Decision, applyToAll: boolean) =>
    invoke<void>("fs_job_resolve", { id, decision, applyToAll }),
  /** Stops a job at the next safe point; nothing half-written is left behind. */
  cancel: (id: number) => invoke<void>("fs_job_cancel", { id }),
  /** Renames inside the folder; rejects with a readable message (empty name, name taken, …). */
  rename: (path: string, newName: string) => invoke<string>("fs_rename", { path, newName }),
  /** Creates "untitled folder" (or "untitled folder 2", …); returns the path. */
  newFolder: (parent: string, name: string) => invoke<string>("fs_new_folder", { parent, name }),
  /** Duplicates next to the originals ("name copy.ext"); returns the new paths. */
  duplicate: (paths: string[]) => invoke<string[]>("fs_duplicate", { paths }),
  /** Applies the inverse of each record, newest first; feed the returned `ops` back to redo. */
  undo: (ops: UndoOp[]) => invoke<UndoReport>("fs_undo", { ops }),
};

/** Subscribes to job progress (all jobs). */
export function onJob(handler: (event: JobEvent) => void): Promise<UnlistenFn> {
  return listen<JobEvent>("fs-job", (event) => handler(event.payload));
}

/** True for a job's last event. */
export const isFinal = (event: JobEvent) => event.state === "done" || event.state === "cancelled" || event.state === "failed";
