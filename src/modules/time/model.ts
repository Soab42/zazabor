import type { IconName } from "../../ui/icons";
import type { Entry, EntryKind, Session, Task } from "./api";

/** The stat cards, in order; each entry kind counts towards one of them. */
export type Category = "total" | "work" | "break" | "prayer" | "lunch" | "meeting" | "others" | "idle";

export const CATEGORIES: { id: Category; label: string; icon: IconName }[] = [
  { id: "total", label: "Total", icon: "clock" },
  { id: "work", label: "Work", icon: "briefcase" },
  { id: "break", label: "Break", icon: "coffee" },
  { id: "prayer", label: "Prayer", icon: "moon" },
  { id: "lunch", label: "Lunch", icon: "utensils" },
  { id: "meeting", label: "Meeting", icon: "calendar" },
  { id: "others", label: "Others", icon: "more" },
  { id: "idle", label: "Idle", icon: "hourglass" },
];

export const KIND_CATEGORY: Record<EntryKind, Category> = {
  work: "work", short_break: "break", lunch: "lunch", prayer: "prayer", meeting: "meeting", other: "others",
};

/** Activity names, as on the chips and in the Type menus. */
export const KIND_LABEL: Record<EntryKind, string> = {
  work: "Work", short_break: "Short Break", lunch: "Lunch", prayer: "Prayer", meeting: "Meeting", other: "Other",
};

export const KIND_ICON: Record<EntryKind, IconName> = {
  work: "briefcase", short_break: "coffee", lunch: "utensils", prayer: "moon", meeting: "calendar", other: "more",
};

export type Totals = Record<Category, number>;

const HOUR = 3_600_000;
const MINUTE = 60_000;

// ---- days

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The start of the next day (exclusive end of `ms`'s day; DST-safe). */
export function endOfDay(ms: number): number {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** "YYYY-MM-DD" for the local day `ms` falls on. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local midnight of a "YYYY-MM-DD" day. */
export function dayFromKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// ---- totals

/**
 * Time per card within `from..to`, up to `now`. Idle is the time checked in with nothing tracked:
 * check-ins minus what was tracked inside them (a past entry logged outside a check-in doesn't
 * make idle time negative).
 */
export function totals(sessions: Session[], entries: Entry[], from: number, to: number, now: number): Totals {
  const sum: Totals = { total: 0, work: 0, break: 0, prayer: 0, lunch: 0, meeting: 0, others: 0, idle: 0 };
  const until = Math.min(to, now);
  let tracked = 0;
  for (const e of entries) {
    const end = e.end ?? now;
    const ms = overlap(e.start, end, from, until);
    sum[KIND_CATEGORY[e.kind]] += ms;
    sum.total += ms;
    for (const s of sessions) tracked += overlap(Math.max(e.start, from), Math.min(end, until), s.start, s.end ?? now);
  }
  const checkedIn = sessions.reduce((ms, s) => ms + overlap(s.start, s.end ?? now, from, until), 0);
  sum.idle = Math.max(0, checkedIn - tracked);
  return sum;
}

// ---- formatting

const pad = (n: number) => String(n).padStart(2, "0");

/** "01:02:03", for the stat cards. */
export function clock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** "1h 5m" (always with hours), as the header and the report say it. */
export function hm(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MINUTE);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "1h 5m", "12m", or seconds while still under a minute. */
export function duration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** "Oct 26, 16:32", for the table. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "4:32 PM" in the system's style. */
export function timeOfDay(ms: number, twoDigit = false): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: twoDigit ? "2-digit" : "numeric", minute: "2-digit" });
}

/** "Oct 26, 2026 · 3:33 PM", for the date-time fields. */
export function dateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${timeOfDay(ms)}`;
}

/** "Monday, October 26". */
export function longDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

// ---- table rows

export type Tab = "all" | "work" | "breaks";

export interface Row {
  entry: Entry;
  task: Task | null;
  /** The task's title, or the activity's description (else its name). */
  title: string;
  /** "—" for activities. */
  project: string;
  /** The Type badge: Development, Meeting, Break, Lunch, Prayer, Other. */
  badge: string;
  /** Picks the colour: a category, or "meeting" for a meeting task. */
  tone: Category;
  icon: IconName;
}

export function toRow(entry: Entry, tasks: Map<string, Task>): Row {
  if (entry.kind === "work") {
    const task = (entry.task && tasks.get(entry.task)) || null;
    const meeting = task?.kind === "meeting";
    return {
      entry, task,
      title: task?.title ?? "Deleted task",
      project: task?.project || "—",
      badge: meeting ? "Meeting" : "Development",
      tone: meeting ? "meeting" : "work",
      icon: meeting ? "calendar" : "briefcase",
    };
  }
  const badge = entry.kind === "short_break" ? "Break" : KIND_LABEL[entry.kind];
  return { entry, task: null, title: entry.text || KIND_LABEL[entry.kind], project: "—", badge, tone: KIND_CATEGORY[entry.kind], icon: KIND_ICON[entry.kind] };
}

export function inTab(row: Row, tab: Tab): boolean {
  return tab === "all" || (tab === "work") === (row.entry.kind === "work");
}

/** Every search word appears in the task, project, type or description. */
export function matches(row: Row, terms: string[]): boolean {
  if (!terms.length) return true;
  const hay = [row.title, row.project, row.badge, KIND_LABEL[row.entry.kind], row.entry.text].join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// ---- daily report

export interface DaySummary {
  checkedIn: number | null;
  /** null while still checked in (or never checked in). */
  checkedOut: number | null;
  totals: Totals;
  /** Breaks as the report counts them: short breaks, lunch, prayer and other activities. */
  breaks: number;
}

export function summarize(sessions: Session[], entries: Entry[], day: number, now: number): DaySummary {
  const from = startOfDay(day);
  const to = endOfDay(day);
  const today = sessions.filter((s) => s.start < to && (s.end ?? now) > from);
  const t = totals(today, entries, from, to, now);
  const last = today.at(-1);
  return {
    checkedIn: today[0]?.start ?? null,
    checkedOut: last && last.end != null ? last.end : null,
    totals: t,
    breaks: t.break + t.lunch + t.prayer + t.others,
  };
}

/** The report's starting text, built from the day's entries; the user edits it from there. */
export function reportText(summary: DaySummary, entries: Entry[], tasks: Map<string, Task>, day: number, now: number): string {
  const from = startOfDay(day);
  const until = Math.min(endOfDay(day), now);
  const t = summary.totals;
  const lines = [
    `Checked in: ${summary.checkedIn != null ? timeOfDay(summary.checkedIn, true) : "—"} · Checked out: ${summary.checkedOut != null ? timeOfDay(summary.checkedOut, true) : "—"}`,
  ];
  // Time and notes per task, the longest first.
  const perTask = new Map<string, { ms: number; notes: string[] }>();
  for (const e of entries) {
    if (e.kind !== "work" || !e.task) continue;
    const ms = overlap(e.start, e.end ?? now, from, until);
    if (!ms) continue;
    const item = perTask.get(e.task) ?? { ms: 0, notes: [] };
    item.ms += ms;
    if (e.text && !item.notes.includes(e.text)) item.notes.push(e.text);
    perTask.set(e.task, item);
  }
  if (perTask.size) {
    lines.push(`Worked ${hm(t.work)} today:`);
    for (const [id, item] of [...perTask].sort((a, b) => b[1].ms - a[1].ms)) {
      const task = tasks.get(id);
      const name = task ? `${task.title}${task.project ? ` (${task.project})` : ""}` : "Deleted task";
      lines.push(`- ${name}: ${hm(item.ms)}${item.notes.length ? ` — ${item.notes.join("; ")}` : ""}`);
    }
  } else {
    lines.push(`Worked ${hm(t.work)} today. No task time logged.`);
  }
  if (t.meeting) lines.push(`Meetings: ${hm(t.meeting)}`);
  const parts = ([["Short break", t.break], ["Lunch", t.lunch], ["Prayer", t.prayer], ["Other", t.others]] as const).filter(([, ms]) => ms >= MINUTE);
  lines.push(`Breaks: ${hm(summary.breaks)}${parts.length ? ` (${parts.map(([name, ms]) => `${name} ${hm(ms)}`).join(", ")})` : ""} · Idle: ${hm(t.idle)}`);
  return lines.join("\n");
}

export const minutes = (ms: number) => Math.round(ms / MINUTE);
export { HOUR, MINUTE };
