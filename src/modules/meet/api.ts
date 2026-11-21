import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Account, Address, Overview } from "../mail/api";

/**
 * Meet's page side: typed wrappers for the `meet_*` commands and events of docs/plans/meet.md
 * (the Rust side is `src-tauri/src/meet`). Times are Unix ms.
 *
 * A dev build can run the whole section without a backend: open the page with `?meetmock` (or set
 * localStorage `zazabor.meetMock` to "1"; "bare" starts with nothing and the outside link off).
 * That mock (`mock.ts`) is never part of a release build.
 */

// ---- types --------------------------------------------------------------------------------------

export interface Invitee {
  email: string;
  name: string;
  sentAt: number | null;
  error: string | null;
}

export interface Meeting {
  id: string;
  /** 10 characters from [a-z2-9]; shown as abc-defg-hij. */
  code: string;
  title: string;
  /** A call starts with cameras off. */
  kind: "meeting" | "call";
  /** Unix ms; null for an instant meeting ("Meet now"). */
  startsAt: number | null;
  minutes: number;
  autoRecord: boolean;
  lobby: boolean;
  invitees: Invitee[];
  createdAt: number;
  live: boolean;
  hostIn: boolean;
  people: number;
  waiting: number;
  recording: boolean;
}

export interface Recording {
  id: string;
  meetingId: string;
  title: string;
  path: string;
  startedAt: number;
  endedAt: number | null;
  bytes: number;
}

export interface Tunnel {
  state: "off" | "starting" | "on" | "error";
  url: string | null;
  error: string | null;
}

export interface Turn {
  url: string;
  username: string;
  credential: string;
}

export interface MeetState {
  port: number;
  tunnel: Tunnel;
  /** The browser the host's window opens in, e.g. "Google Chrome"; null: the default browser. */
  browser: string | null;
  recordingsDir: string;
  stun: string[];
  turn: Turn | null;
}

/** What the sheets send to `meet_create` and `meet_update` (the latter with the `id`). */
export interface MeetingInput {
  title: string;
  kind: "meeting" | "call";
  startsAt: number | null;
  minutes: number;
  autoRecord: boolean;
  lobby: boolean;
  invitees: { email: string; name: string }[];
}

export interface Events {
  "meet-changed": null;
  "meet-knock": { meetingId: string; title: string; name: string };
}

// ---- the dev mock -------------------------------------------------------------------------------

/** What the mock exposes; `mock.ts` implements it. */
export interface MeetMock {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  listen<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void;
}

function mockWanted(): string | null {
  try {
    const query = new URLSearchParams(location.search);
    if (query.has("meetmock")) return query.get("meetmock") || "1";
    return localStorage.getItem("zazabor.meetMock");
  } catch {
    return null;
  }
}

/** Only dev builds look for the mock; in a release `import.meta.env.DEV` is false and it's dropped. */
const mock: Promise<MeetMock> | null = import.meta.env.DEV && mockWanted()
  ? import("./mock").then((m) => m.createMock(mockWanted() ?? "1"))
  : null;

export const isMock = mock !== null;

function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (mock) return mock.then((m) => m.invoke(cmd, args) as Promise<T>);
  return invoke<T>(cmd, args);
}

/** Listens to a Meet event; resolves to the function that stops listening. */
export function onMeet<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): Promise<UnlistenFn> {
  if (mock) return mock.then((m) => m.listen(event, fn));
  return listen<Events[K]>(event, (e) => fn(e.payload));
}

// ---- commands -----------------------------------------------------------------------------------

export const meetApi = {
  state: () => call<MeetState>("meet_state"),
  list: () => call<Meeting[]>("meet_list"),
  create: (input: MeetingInput) => call<Meeting>("meet_create", { ...input }),
  update: (id: string, input: MeetingInput) => call<Meeting>("meet_update", { id, ...input }),
  remove: (id: string) => call<void>("meet_delete", { id }),
  /** The link to share; starts the outside link first when it's off (can take up to 20 s). */
  joinUrl: (id: string) => call<string>("meet_join_url", { id }),
  open: (id: string) => call<void>("meet_open", { id }),
  invite: (id: string, accountId: string, message: string) => call<Invitee[]>("meet_invite", { id, accountId, message }),
  end: (id: string) => call<void>("meet_end", { id }),
  recordings: () => call<Recording[]>("meet_recordings"),
  recordingDelete: (id: string) => call<void>("meet_recording_delete", { id }),
  tunnel: (on: boolean) => call<MeetState>("meet_tunnel", { on }),
  settings: (stun: string[], turn: Turn | null) => call<MeetState>("meet_settings", { stun, turn }),
  // Mail's accounts and contacts, through the mock in a dev build.
  mailAccounts: () => call<Overview>("mail_overview").then((o): Account[] => o.accounts),
  mailContacts: (prefix: string) => call<Address[]>("mail_contacts", { prefix }),
};

// ---- helpers ------------------------------------------------------------------------------------

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** abc-defg-hij */
export function codeText(code: string): string {
  return code.length === 10 ? `${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}` : code;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const yearDayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** "Today", "Tomorrow", "Yesterday", "Fri, Nov 21" (with the year when it isn't this one). */
export function dayText(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return (new Date(ms).getFullYear() === new Date(now).getFullYear() ? dayFormat : yearDayFormat).format(ms);
}

/** "Today 3:00 PM · 30 min"; an instant meeting shows when it was made. */
export function whenText(m: Meeting): string {
  const at = m.startsAt ?? m.createdAt;
  const length = m.startsAt !== null && m.minutes > 0 ? ` · ${durationText(m.minutes * 60)}` : "";
  return `${dayText(at)} ${timeFormat.format(at)}${length}`;
}

export function clockText(ms: number): string {
  return timeFormat.format(ms);
}

/** "30 min", "1 h 30 min". */
export function durationText(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

/** Past once it is over: its planned end (or an hour after an instant start) has gone by and nobody is in it. */
export function isPast(m: Meeting, now = Date.now()): boolean {
  if (m.live) return false;
  const start = m.startsAt ?? m.createdAt;
  const end = start + Math.max(m.minutes, 30) * 60_000;
  return m.startsAt === null ? now > start + 60 * 60_000 : now > end;
}
