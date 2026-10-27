import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Config } from "../../../config";

/** The screen recorder's backend (`src-tauri/src/recorder`). */

export interface Monitor {
  /** RandR's name: "eDP-1", "HDMI-1". */
  name: string;
  /** In words: "Laptop screen", "HDMI screen (HDMI-1)". */
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface WindowInfo {
  xid: number;
  title: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  icon: string | null;
}

/** A microphone (a PulseAudio/PipeWire source). */
export interface Mic {
  id: string;
  name: string;
  kind: "built-in" | "usb" | "bluetooth" | "virtual" | "other";
  /** Something worth knowing about it (Bluetooth headsets record in call quality). */
  hint: string | null;
}

/** A speaker or other output; `id` is its monitor, what "System sound" records. */
export interface Output {
  id: string;
  name: string;
  kind: Mic["kind"];
}

export interface CameraDevice {
  /** "/dev/video0", or "test" for the test picture. */
  path: string;
  name: string;
  mode: { mjpeg: boolean; width: number; height: number; fps: number } | null;
}

export interface Sources {
  monitors: Monitor[];
  windows: WindowInfo[];
  mics: Mic[];
  outputs: Output[];
  cameras: CameraDevice[];
  formats: ("mp4" | "webm")[];
  folder: string;
  free: number | null;
  /** Why recording can't work here (a Wayland session), when it can't. */
  unsupported: string | null;
}

export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Target = { kind: "screen"; monitor: number } | { kind: "all" } | { kind: "window"; xid: number } | ({ kind: "area" } & Area);

export type Quality = "standard" | "smooth" | "small";
export type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export interface StartSpec {
  target: Target;
  systemSound: boolean;
  mic: boolean;
  micId: string | null;
  outputId: string | null;
  camera: Corner | null;
  cameraId: string | null;
  quality: Quality;
  format: "mp4" | "webm";
  countdown: boolean;
  hideBar: boolean;
  folder: string | null;
}

export interface Status {
  phase: "idle" | "countdown" | "recording" | "paused" | "finishing" | "";
  countdown: number;
  elapsed: number;
  mic: boolean;
  muted: boolean;
  hideBar: boolean;
  warning: string | null;
  origin: string;
}

export interface Finished {
  path: string | null;
  seconds: number;
  bytes: number;
  origin: string;
  discarded: boolean;
  error: string | null;
}

export interface Recording {
  path: string;
  name: string;
  bytes: number;
  mtime: number;
  recovered: boolean;
}

export interface Shortcut {
  supported: boolean;
  state: "none" | "installed" | "other";
  binding: string;
  command: string;
}

export const recApi = {
  sources: (folder: string | null) => invoke<Sources>("recorder_sources", { folderPath: folder }),
  still: async (a: Area) => new Uint8Array(await invoke<ArrayBuffer>("recorder_still", { x: a.x, y: a.y, width: a.width, height: a.height })),
  start: (spec: StartSpec) => invoke<void>("recorder_start", { spec }),
  status: () => invoke<Status>("recorder_status"),
  takeFinished: () => invoke<Finished | null>("recorder_take_finished"),
  pause: () => invoke<void>("recorder_pause"),
  resume: () => invoke<void>("recorder_resume"),
  mute: (muted: boolean) => invoke<void>("recorder_mute", { muted }),
  stop: () => invoke<void>("recorder_stop"),
  discard: () => invoke<void>("recorder_discard"),
  pickArea: (monitor: number) => invoke<void>("recorder_pick_area", { monitor }),
  areaStill: async () => new Uint8Array(await invoke<ArrayBuffer>("recorder_area_still")),
  areaDone: (area: Area | null) => invoke<void>("recorder_area_done", { area }),
  list: (folder: string | null) => invoke<Recording[]>("recorder_list", { folderPath: folder }),
  keep: (path: string) => invoke<string>("recorder_keep", { path }),
  remove: (path: string) => invoke<void>("recorder_delete", { path }),
  copyFile: (path: string) => invoke<void>("recorder_copy_file", { path }),
  trim: (path: string, start: number, end: number) => invoke<{ path: string; bytes: number }>("recorder_trim", { path, start, end }),
  meterStart: (micId: string | null) => invoke<void>("recorder_meter_start", { micId }),
  meterStop: () => invoke<void>("recorder_meter_stop"),
  shortcut: () => invoke<Shortcut>("recorder_shortcut"),
  setShortcut: (binding: string | null) => invoke<Shortcut>("recorder_set_shortcut", { binding }),
  /** "recorder-devices" while the page is open, when screens or devices come and go. */
  watch: () => invoke<void>("recorder_watch"),
  unwatch: () => invoke<void>("recorder_unwatch"),
};

export const onStatus = (fn: (s: Status) => void): Promise<UnlistenFn> => listen<Status>("recorder-state", (e) => fn(e.payload));
export const onFinished = (fn: (f: Finished) => void): Promise<UnlistenFn> => listen<Finished | null>("recorder-finished", (e) => e.payload && fn(e.payload));
export const onArea = (fn: (a: Area | null) => void): Promise<UnlistenFn> => listen<Area | null>("recorder-area", (e) => fn(e.payload));
export const onLevel = (fn: (db: number) => void): Promise<UnlistenFn> => listen<number>("recorder-level", (e) => fn(e.payload));
export const onDevices = (fn: () => void): Promise<UnlistenFn> => listen("recorder-devices", () => fn());

// ---- what the recorder remembers (config.studio.apps.record) -----------------------------------

export interface RecordPrefs {
  target: "screen" | "window" | "area";
  /** Which screen (left to right); -1 for all of them. */
  monitor: number;
  area: Area | null;
  systemSound: boolean;
  mic: boolean;
  micId: string | null;
  /** The output "System sound" records; null for the default one. */
  outputId: string | null;
  camera: Corner | null;
  cameraId: string | null;
  quality: Quality;
  format: "mp4" | "webm";
  countdown: boolean;
  hideBar: boolean;
  /** Where recordings go; null for ~/Videos/Recordings. */
  folder: string | null;
}

const DEFAULTS: RecordPrefs = {
  target: "screen", monitor: 0, area: null, systemSound: true, mic: false, micId: null, outputId: null, camera: null, cameraId: null,
  quality: "standard", format: "mp4", countdown: true, hideBar: false, folder: null,
};

const CORNERS: Corner[] = ["bottom-right", "bottom-left", "top-right", "top-left"];

/** The recorder's settings, repaired in place (a hand-edited config can hold anything). */
export function recordPrefs(config: Config): RecordPrefs {
  const apps = config.studio.apps as Record<string, unknown>;
  const raw = (apps.record && typeof apps.record === "object" ? apps.record : {}) as Partial<RecordPrefs>;
  const pick = <T>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const area = raw.area && typeof raw.area === "object" && [raw.area.x, raw.area.y, raw.area.width, raw.area.height].every((n) => Number.isFinite(n)) ? raw.area : null;
  const prefs: RecordPrefs = {
    target: pick(raw.target, ["screen", "window", "area"] as const, DEFAULTS.target),
    // -1 is "All screens".
    monitor: Number.isInteger(raw.monitor) && (raw.monitor as number) >= -1 ? (raw.monitor as number) : 0,
    area,
    systemSound: bool(raw.systemSound, DEFAULTS.systemSound),
    mic: bool(raw.mic, DEFAULTS.mic),
    micId: typeof raw.micId === "string" ? raw.micId : null,
    outputId: typeof raw.outputId === "string" ? raw.outputId : null,
    camera: raw.camera === null ? null : pick(raw.camera, CORNERS, null as Corner | null),
    cameraId: typeof raw.cameraId === "string" ? raw.cameraId : null,
    quality: pick(raw.quality, ["standard", "smooth", "small"] as const, DEFAULTS.quality),
    format: pick(raw.format, ["mp4", "webm"] as const, DEFAULTS.format),
    countdown: bool(raw.countdown, DEFAULTS.countdown),
    hideBar: bool(raw.hideBar, DEFAULTS.hideBar),
    folder: typeof raw.folder === "string" && raw.folder.startsWith("/") ? raw.folder : null,
  };
  apps.record = prefs;
  return prefs;
}

/** "1:05", "12:40", "1:02:03". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
