import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Config } from "../../../../config";
import type { ShellContext } from "../../../../shell/module";
import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { libraryService } from "../../library-api";
import { openDialog } from "../open/dialog";
import "../open/media.css";
import "./receiver.css";

/**
 * Cast to Zazabor: the PC shows up on the Wi-Fi as a screen phones can send things to (VLC's
 * "Play on…", DLNA apps, the YouTube app, and the Zazabor Cast app's screen mirroring; see
 * docs/plans/cast-receiver.md). The protocols run in Rust (`src-tauri/src/cast`); this side keeps
 * the settings, starts the receiver in the main window, asks before a new phone plays something,
 * and opens casts in the Video player.
 */

export interface ReceiverSettings {
  enabled: boolean;
  /** The name phones show; empty means "Zazabor on ‹hostname›". */
  name: string;
  /** A stable id for this PC, made once. */
  id: string;
  /** Ask before a phone that isn't trusted plays something. */
  ask: boolean;
  /** Phones that may always cast: sender keys with the name they had. */
  trusted: { key: string; name: string }[];
}

export type CastSource = "cast" | "dlna" | "youtube" | "mirror";

export interface PlayRequest {
  session: number;
  url: string;
  title: string | null;
  subtitle: string | null;
  artwork: string | null;
  startMs: number;
  live: boolean;
  /** The phone sends no picture (VLC's "Audio only" casting, a song over DLNA). */
  audioOnly: boolean;
  source: CastSource;
  sourceLabel: string;
  sender: string;
  senderKey: string;
}

export interface ServiceInfo {
  id: string;
  label: string;
  port: number;
  error: string | null;
}

export interface ReceiverInfo {
  running: boolean;
  name: string;
  addresses: string[];
  services: ServiceInfo[];
  tvCode: string | null;
}

const DEFAULTS: ReceiverSettings = { enabled: false, name: "", id: "", ask: true, trusted: [] };

/** The receiver's settings in `config.video.ext.receiver`, defaults filled in (and an id made). */
export function receiverSettings(config: Config): ReceiverSettings {
  const saved = config.video.ext.receiver;
  const merged: ReceiverSettings = { ...DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  if (!Array.isArray(merged.trusted)) merged.trusted = [];
  if (!merged.id) merged.id = crypto.randomUUID();
  config.video.ext.receiver = merged;
  return merged;
}

export const receiverApi = {
  start: (name: string, id: string) => invoke<ReceiverInfo>("cast_receiver_start", { settings: { name, id } }),
  stop: () => invoke<void>("cast_receiver_stop"),
  info: () => invoke<ReceiverInfo>("cast_receiver_info"),
  pending: () => invoke<PlayRequest | null>("cast_pending"),
  taken: (session: number) => invoke<void>("cast_taken", { session }),
  decline: (session: number) => invoke<void>("cast_decline", { session }),
  end: (session: number) => invoke<void>("cast_end", { session }),
  youtubeCode: () => invoke<string>("cast_youtube_code"),
  hostname: () => invoke<string>("cast_hostname"),
};

/** The name phones see. */
export async function receiverName(settings: ReceiverSettings): Promise<string> {
  if (settings.name.trim()) return settings.name.trim();
  try {
    return `Zazabor on ${await receiverApi.hostname()}`;
  } catch {
    return "Zazabor";
  }
}

// ---- what is being cast now ------------------------------------------------------------------

interface Casting {
  request: PlayRequest;
}

let casting: Casting | null = null;
const listeners = new Set<() => void>();

/** The cast playing now (its address is what the player plays), if any. */
export const currentCast = (): PlayRequest | null => casting?.request ?? null;

export function onCastChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setCasting(next: Casting | null) {
  casting = next;
  for (const fn of listeners) fn();
}

/** The user stopped the cast from Zazabor: tell the phone. */
export function endCast() {
  const now = casting;
  if (!now) return;
  setCasting(null);
  void receiverApi.end(now.request.session).catch(() => undefined);
}

// ---- the service (main window) ---------------------------------------------------------------

let shellRef: ShellContext | null = null;
/** Phones allowed until Zazabor closes ("Allow" without "Always"). */
const allowedThisRun = new Set<string>();
/** Phones turned away recently, so a retrying sender doesn't ask again and again. */
const declinedUntil = new Map<string, number>();
const DECLINE_QUIET_MS = 2 * 60_000;
const infoListeners = new Set<(info: ReceiverInfo | null) => void>();
let lastInfo: ReceiverInfo | null = null;

export const receiverInfo = () => lastInfo;

export function onReceiverInfo(fn: (info: ReceiverInfo | null) => void): () => void {
  infoListeners.add(fn);
  return () => infoListeners.delete(fn);
}

function setInfo(info: ReceiverInfo | null) {
  lastInfo = info;
  for (const fn of infoListeners) fn(info);
}

/** Starts the receiver (or stops it) to match the settings. */
export async function applyReceiver(shell: { readonly config: Config }): Promise<ReceiverInfo | null> {
  const settings = receiverSettings(shell.config);
  if (!settings.enabled) {
    await receiverApi.stop().catch(() => undefined);
    setInfo(null);
    return null;
  }
  const info = await receiverApi.start(await receiverName(settings), settings.id);
  setInfo(info);
  return info;
}

/** Called once by the shell in the main window. */
export function startReceiverService(shell: ShellContext) {
  if (shellRef) return;
  shellRef = shell;
  void listen<PlayRequest>("cast-play", (e) => void incoming(e.payload));
  void listen<number>("cast-stop", (e) => {
    if (casting?.request.session === e.payload) setCasting(null);
  });
  if (receiverSettings(shell.config).enabled) {
    void applyReceiver(shell).catch((err) => console.warn("Cast receiver did not start:", err));
  }
  // A cast that arrived while this window was still loading.
  void receiverApi.pending().then((request) => request && incoming(request)).catch(() => undefined);
}

async function incoming(request: PlayRequest) {
  const shell = shellRef;
  if (!shell) return;
  await receiverApi.taken(request.session).catch(() => undefined);
  const settings = receiverSettings(shell.config);
  const trusted = !settings.ask || allowedThisRun.has(request.senderKey) || settings.trusted.some((t) => t.key === request.senderKey);
  if (!trusted) {
    const quietUntil = declinedUntil.get(request.senderKey) ?? 0;
    if (Date.now() < quietUntil) {
      void receiverApi.decline(request.session);
      return;
    }
    const answer = await ask(request);
    if (answer === "decline") {
      declinedUntil.set(request.senderKey, Date.now() + DECLINE_QUIET_MS);
      void receiverApi.decline(request.session);
      return;
    }
    allowedThisRun.add(request.senderKey);
    if (answer === "always" && !settings.trusted.some((t) => t.key === request.senderKey)) {
      settings.trusted.push({ key: request.senderKey, name: request.sender });
      shell.saveConfig();
    }
  }
  play(shell, request);
}

function play(shell: ShellContext, request: PlayRequest) {
  setCasting({ request });
  libraryService()?.remember([{ path: request.url, name: castTitle(request), group: request.sender }]);
  shell.open({ kind: "video", path: request.url, siblings: [request.url] });
  // The library service exists once the Video module is built (it may have just been).
  setTimeout(() => libraryService()?.remember([{ path: request.url, name: castTitle(request), group: request.sender }]), 400);
}

/** What the player's title bar shows for a cast. */
export function castTitle(request: PlayRequest): string {
  if (request.title) return request.title;
  if (request.source === "mirror") return `${request.sender}'s screen`;
  try {
    const name = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
    if (name && /\.[a-z0-9]{2,4}$/i.test(name)) return name;
  } catch {
    // not a URL
  }
  return `From ${request.sender}`;
}

const SOURCE_ICON = { cast: "cast", dlna: "network", youtube: "play", mirror: "phone" } as const;

/** "Pixel 7 wants to play “Song” — Allow / Always allow / Decline". */
function ask(request: PlayRequest): Promise<"once" | "always" | "decline"> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value: "once" | "always" | "decline") => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };
    const what = request.source === "mirror" ? "wants to show its screen here" : request.title ? `wants to play “${request.title}”` : "wants to play something here";
    const dialog = openDialog({
      title: "Play from a phone?",
      subtitle: `${request.sender} ${what} (${request.sourceLabel}).`,
      icon: SOURCE_ICON[request.source] ?? "desktop",
      width: 460,
      onClose: () => answer("decline"),
    });
    if (request.artwork) {
      dialog.body.append(h("img", { class: "rc-art", src: request.artwork, alt: "", referrerPolicy: "no-referrer" }));
    }
    dialog.body.append(
      h("p", { class: "mt-hint" }, "Only allow phones you know. “Always allow” lets this one play without asking; you can take that back in Settings → Video → Recording & Casting."),
    );
    const decline = h("button", { class: "btn", type: "button" }, "Decline");
    const always = h("button", { class: "btn", type: "button" }, "Always Allow");
    // A phone without a lasting id (`mirror:once-…`) is new every time: nothing to remember it by.
    always.hidden = request.senderKey.includes(":once-");
    const once = h("button", { class: "btn primary", type: "button" }, icon("play", 14), "Allow");
    decline.addEventListener("click", () => answer("decline"));
    always.addEventListener("click", () => answer("always"));
    once.addEventListener("click", () => answer("once"));
    dialog.foot.append(decline, h("div", { class: "spacer" }), always, once);
    // A phone that gives up (or a newer cast) shouldn't leave the question hanging forever.
    setTimeout(() => answer("decline"), 60_000);
    queueMicrotask(() => once.focus());
  });
}
