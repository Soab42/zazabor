import { basename, formatBytes } from "../../../ui/dom";
import type { JobEvent, JobKind } from "../ops-api";

/** “report.pdf” for one item, "12 items" for several. */
export function describeItems(paths: string[]): string {
  return paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`;
}

const progressive: Record<JobKind, string> = {
  copy: "Copying", move: "Moving", trash: "Moving to Trash", delete: "Deleting", compress: "Compressing", extract: "Extracting",
};
const past: Record<JobKind, string> = {
  copy: "Copied", move: "Moved", trash: "Moved to Trash", delete: "Deleted", compress: "Compressed", extract: "Extracted",
};

/** "Compressing…" for a job this panel didn't start itself (and so has no fuller title). */
export const kindTitle = (kind: JobKind) => `${progressive[kind]}…`;

const destination = (kind: JobKind, dest?: string) =>
  kind === "copy" || kind === "move" ? ` to ${dest ? basename(dest) : "folder"}` : "";

/** "Copying 12 items to Pictures". */
export function jobTitle(kind: JobKind, paths: string[], dest?: string): string {
  return `${progressive[kind]} ${describeItems(paths)}${destination(kind, dest)}`;
}

/** "Moved 3 items to Trash". */
export function doneTitle(kind: JobKind, paths: string[], dest?: string): string {
  return `${past[kind]} ${describeItems(paths)}${destination(kind, dest)}`;
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "";
  if (seconds < 5) return "a few seconds";
  if (seconds < 60) return `${Math.round(seconds / 5) * 5} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Bytes, speed and time left for a running job; `started` is when it began (ms). */
export function progressDetail(event: JobEvent, started: number, now = Date.now()): string {
  const parts: string[] = [];
  if (event.totalBytes > 0) parts.push(`${formatBytes(event.bytes)} of ${formatBytes(event.totalBytes)}`);
  else parts.push(`${event.done} of ${event.total}`);
  const elapsed = (now - started) / 1000;
  if (event.totalBytes > 0 && elapsed > 1 && event.bytes > 0) {
    const speed = event.bytes / elapsed;
    parts.push(`${formatBytes(speed)}/s`);
    const left = formatDuration((event.totalBytes - event.bytes) / speed);
    if (left && event.bytes < event.totalBytes) parts.push(`${left} left`);
  }
  return parts.join("  ·  ");
}

/** Fraction 0..1 of a job: bytes when known, else items. */
export function progressOf(event: JobEvent): number {
  if (event.totalBytes > 0) return Math.min(1, event.bytes / event.totalBytes);
  return event.total > 0 ? Math.min(1, event.done / event.total) : 0;
}
