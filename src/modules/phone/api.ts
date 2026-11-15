import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Phone Link's page side: typed wrappers for the `phone_*` commands and events of
 * docs/plans/phone-link.md §3 (the Rust side is `src-tauri/src/phonelink`). Times are Unix ms.
 *
 * A dev build can run the whole section without a phone or a backend: open the page with
 * `?phonemock` (or set localStorage `zazabor.phoneMock` to "1"; "bare" starts with no phone
 * paired). That mock (`mock.ts`) is never part of a release build.
 */

// ---- types --------------------------------------------------------------------------------------

export interface PhoneState {
  enabled: boolean;
  port: number | null;
  pcName: string;
  /** The PC's local addresses (while the link is on), for typing into the phone. */
  addresses?: string[];
  phones: Phone[];
  pairing: PairRequest | null;
  clip: boolean;
}

export interface PairRequest {
  phoneId: string;
  name: string;
  /** Six digits, e.g. "482913". */
  code: string;
}

export type Cap = "sms" | "calls" | "contacts" | "notifications" | "files" | "photos" | "clipboard" | "mirror";

export interface Phone {
  phoneId: string;
  name: string;
  model: string;
  connected: boolean;
  lastSeen: number;
  battery: number | null;
  charging: boolean;
  /** 0–4 bars. */
  signal: number | null;
  network: string | null;
  carrier: string | null;
  caps: string[];
  unreadSms: number;
  notifCount: number;
}

export interface Thread {
  threadId: number;
  addresses: string[];
  name: string | null;
  snippet: string;
  at: number;
  unread: number;
  count: number;
}

export interface Msg {
  id: number;
  threadId: number;
  address: string;
  body: string;
  at: number;
  out: boolean;
  status: "sent" | "pending" | "failed" | "received";
  mms: boolean;
}

export type CallKind = "in" | "out" | "missed" | "rejected" | "blocked" | "voicemail";

export interface Call {
  id: number;
  number: string;
  name: string | null;
  at: number;
  /** Seconds. */
  duration: number;
  kind: CallKind;
}

export interface Contact {
  id: string;
  name: string;
  numbers: { number: string; label: string }[];
  starred: boolean;
  hasPhoto: boolean;
}

export interface NotifAction {
  title: string;
  reply: boolean;
}

export interface Notif {
  key: string;
  app: string;
  appName: string;
  title: string;
  text: string;
  at: number;
  /** Base64 PNG (48 px), or null. */
  icon: string | null;
  actions: NotifAction[];
  clearable: boolean;
}

export interface Photo {
  id: number;
  uri: string;
  name: string;
  at: number;
  size: number;
  mime: string;
  width: number;
  height: number;
  video: boolean;
  duration: number | null;
  /** A `data:` URL (256 px JPEG). */
  thumb: string;
}

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  at: number;
  mime: string | null;
}

export interface Transfer {
  id: number;
  phoneId: string;
  name: string;
  size: number;
  done: number;
  dir: "in" | "out";
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  path: string | null;
  error: string | null;
}

export interface BtPhone {
  address: string;
  name: string;
  paired: boolean;
  /** Connected over HFP. */
  connected: boolean;
  battery: number | null;
  signal: number | null;
  carrier: string | null;
  phoneId: string | null;
}

export type LiveState = "active" | "held" | "dialing" | "alerting" | "incoming" | "waiting";

export interface LiveCall {
  idx: number;
  number: string;
  name: string | null;
  dir: "in" | "out";
  state: LiveState;
  /** When the call was answered (Unix ms), or null. */
  since: number | null;
}

export interface BtState {
  enabled: boolean;
  /** An adapter is present and powered. */
  available: boolean;
  dropIn: boolean;
  devices: BtPhone[];
  calls: LiveCall[];
  audioOnPc: boolean;
  muted: boolean;
  volume: number;
}

export interface Events {
  "phone-changed": PhoneState;
  "phone-pair": PairRequest;
  "phone-sms": { phoneId: string; msg: Msg };
  "phone-notif": { phoneId: string; n: Notif };
  "phone-notif-removed": { phoneId: string; key: string };
  "phone-transfer": Transfer;
  "phone-bt": BtState;
  "phone-ring": LiveCall;
  /** The Zazabor Link app's own view of a call (works without Bluetooth). */
  "phone-call-state": AppCallState;
}

/** `call.state` from the phone app, relayed by the backend with the phone's id. */
export interface AppCallState {
  phoneId: string;
  state: "ringing" | "dialing" | "active" | "held" | "ended";
  number: string;
  name: string | null;
  at: number;
}

// ---- the dev mock -------------------------------------------------------------------------------

/** What the mock exposes; `mock.ts` implements it. */
export interface PhoneMock {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  listen<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void;
}

function mockWanted(): string | null {
  try {
    const query = new URLSearchParams(location.search);
    if (query.has("phonemock")) return query.get("phonemock") || "1";
    return localStorage.getItem("zazabor.phoneMock");
  } catch {
    return null;
  }
}

/** Only dev builds look for the mock; in a release `import.meta.env.DEV` is false and it's dropped. */
const mock: Promise<PhoneMock> | null = import.meta.env.DEV && mockWanted()
  ? import("./mock").then((m) => m.createMock(mockWanted() ?? "1"))
  : null;

export const isMock = mock !== null;

function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (mock) return mock.then((m) => m.invoke(cmd, args) as Promise<T>);
  return invoke<T>(cmd, args);
}

/** Listens to a Phone Link event; resolves to the function that stops listening. */
export function onPhone<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): Promise<UnlistenFn> {
  if (mock) return mock.then((m) => m.listen(event, fn));
  return listen<Events[K]>(event, (e) => fn(e.payload));
}

// ---- commands -----------------------------------------------------------------------------------

export const phoneApi = {
  // the link
  state: () => call<PhoneState>("phone_state"),
  linkEnable: (on: boolean) => call<PhoneState>("phone_link_enable", { on }),
  pairAnswer: (phoneId: string, accept: boolean) => call<void>("phone_pair_answer", { phoneId, accept }),
  forget: (phoneId: string) => call<void>("phone_forget", { phoneId }),
  rename: (phoneId: string, name: string) => call<void>("phone_rename", { phoneId, name }),
  threads: (phoneId: string) => call<Thread[]>("phone_threads", { phoneId }),
  thread: (phoneId: string, threadId: number, before?: number) => call<Msg[]>("phone_thread", { phoneId, threadId, before: before ?? null }),
  smsSend: (phoneId: string, to: string[], body: string) => call<void>("phone_sms_send", { phoneId, to, body }),
  calls: (phoneId: string) => call<Call[]>("phone_calls", { phoneId }),
  contacts: (phoneId: string) => call<Contact[]>("phone_contacts", { phoneId }),
  contactPhoto: (phoneId: string, id: string) => call<string | null>("phone_contact_photo", { phoneId, id }),
  /** The phone's home-screen wallpaper (a data: URL): fresh while linked, else the one kept. */
  wallpaper: (phoneId: string) => call<string | null>("phone_wallpaper", { phoneId }),
  notifs: (phoneId: string) => call<Notif[]>("phone_notifs", { phoneId }),
  notifDismiss: (phoneId: string, key: string) => call<void>("phone_notif_dismiss", { phoneId, key }),
  notifAction: (phoneId: string, key: string, action: number, text?: string) => call<void>("phone_notif_action", { phoneId, key, action, text: text ?? null }),
  photos: (phoneId: string, offset: number, limit: number) => call<Photo[]>("phone_photos", { phoneId, offset, limit }),
  files: (phoneId: string, path: string) => call<Entry[]>("phone_files", { phoneId, path }),
  download: (phoneId: string, paths: string[], dest?: string) => call<number[]>("phone_download", { phoneId, paths, dest: dest || null }),
  upload: (phoneId: string, paths: string[], dir?: string) => call<number[]>("phone_upload", { phoneId, paths, dir: dir || null }),
  fileDelete: (phoneId: string, path: string) => call<void>("phone_file_delete", { phoneId, path }),
  transfers: () => call<Transfer[]>("phone_transfers"),
  transferCancel: (id: number) => call<void>("phone_transfer_cancel", { id }),
  ring: (phoneId: string) => call<void>("phone_ring", { phoneId }),
  mirror: (phoneId: string) => call<void>("phone_mirror", { phoneId }),
  clipShare: (phoneId: string, on: boolean) => call<void>("phone_clip_share", { phoneId, on }),

  // Bluetooth calls
  btState: () => call<BtState>("phone_bt_state"),
  btEnable: (on: boolean) => call<BtState>("phone_bt_enable", { on }),
  btConnect: (address: string) => call<void>("phone_bt_connect", { address }),
  btSettings: () => call<void>("phone_bt_settings"),
  /**
   * Starts a call. `phoneId` is a hint for when Bluetooth calls aren't set up: the backend can then
   * ask that phone over the link (`call.dial`), and the audio stays on the phone.
   */
  dial: (number: string, phoneId?: string) => call<void>("phone_call_dial", { number, phoneId: phoneId ?? null }),
  /** `phoneId` lets the backend fall back to the app when no phone is connected over Bluetooth. */
  answer: (phoneId?: string) => call<void>("phone_call_answer", { phoneId: phoneId ?? null }),
  hangup: (phoneId?: string) => call<void>("phone_call_hangup", { phoneId: phoneId ?? null }),
  decline: (phoneId?: string) => call<void>("phone_call_decline", { phoneId: phoneId ?? null }),
  dtmf: (digit: string) => call<void>("phone_call_dtmf", { digit }),
  /** AT+CHLD: 0 releases the held (or turns away a waiting call), 1 ends the active and takes the other, 2 swaps. */
  hold: (action: 0 | 1 | 2) => call<void>("phone_call_hold", { action }),
  audio: (onPc: boolean) => call<void>("phone_call_audio", { onPc }),
  mute: (on: boolean) => call<void>("phone_call_mute", { on }),
  volume: (level: number) => call<void>("phone_call_volume", { level }),
};

// ---- helpers ------------------------------------------------------------------------------------

export function hasCap(phone: Phone | null | undefined, cap: Cap): boolean {
  return !!phone?.caps.includes(cap);
}

/** "482913" → "482 913". */
export const formatCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** The digits that identify a number, for matching "+1 (555) 010-2030" with "5550102030". */
export function numberKey(number: string): string {
  const digits = number.replace(/[^\d]/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/** A readable error from a command. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "9:41", "Yesterday", "Mon", "12 Mar", "12 Mar 2024". */
export function shortTime(at: number): string {
  if (!at) return "";
  const d = new Date(at);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "just now", "5 min ago", "3 h ago", or a date. */
export function agoText(at: number): string {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return shortTime(at);
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
