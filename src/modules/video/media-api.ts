import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The contract for opening media beyond local files, converting, casting and instance options
 * (src-tauri/src/video/{capture,convert,renderers,options}.rs). Command names and payload shapes
 * must match the Rust side exactly. Playing anything — a file, a web address or a device — still
 * goes through `VideoContext.play` / `videoApi.open`, which accept `scheme://…` addresses.
 */

/** libVLC instance options (Settings → Performance, Network…); applied when nothing is playing. */
export interface MediaOptions {
  hardwareDecoding: boolean;
  /** Milliseconds of buffering for network streams. */
  networkCaching: number;
  httpReconnect: boolean;
  deinterlace: "auto" | "on" | "off";
  skipLoopFilter: "normal" | "faster";
  fastDecode: boolean;
  replayGain: "none" | "track" | "album";
  /** Decoder threads, 0 = automatic. */
  threads: number;
}

export interface CaptureDevice {
  /** e.g. /dev/video0 */
  path: string;
  /** The camera's own name. */
  name: string;
  /** What to play, e.g. v4l2:///dev/video0 */
  mrl: string;
}

export interface PlaylistEntry {
  title: string;
  /** An address `videoApi.open` accepts. */
  mrl: string;
}

export type ConvertState = "running" | "done" | "failed" | "cancelled";

/** A conversion job; `video-convert` events carry the whole object. */
export interface ConvertJob {
  id: number;
  source: string;
  dest: string;
  profile: string;
  /** 0–1. */
  progress: number;
  state: ConvertState;
  error: string | null;
}

export interface Renderer {
  id: number;
  name: string;
  /** libVLC's type, e.g. "chromecast". */
  kind: string;
  video: boolean;
  audio: boolean;
}

export interface CastState {
  /** Readable names of the running searches; empty = this VLC cannot search for devices. */
  searching: string[];
  devices: Renderer[];
  /** The device the next playback goes to, null = this computer. */
  selected: number | null;
}

/** Target formats; the ids match `PROFILES` in convert.rs. */
export const CONVERT_PROFILES = [
  { id: "mp4", label: "MP4", detail: "H.264 video, plays almost everywhere", ext: "mp4", audioOnly: false },
  { id: "mp4-720", label: "MP4, smaller (720p)", detail: "H.264 scaled to 720p for phones and sharing", ext: "mp4", audioOnly: false },
  { id: "webm", label: "WebM", detail: "VP9 video and Opus audio for the web (slow to make)", ext: "webm", audioOnly: false },
  { id: "mp3", label: "MP3 audio", detail: "Only the sound, as an MP3 file", ext: "mp3", audioOnly: true },
] as const;
export type ConvertProfileId = (typeof CONVERT_PROFILES)[number]["id"];

export const mediaApi = {
  /** Webcams and capture cards (/dev/video*) with their names. */
  captureDevices: () => invoke<CaptureDevice[]>("video_capture_devices"),
  /** Lists what a playlist address (M3U, PLS, XSPF) holds; a plain address gives one entry. */
  resolvePlaylist: (url: string) => invoke<PlaylistEntry[]>("video_resolve_playlist", { url }),
  /** Starts converting `source` into `destDir`; `maxSeconds` limits the output (used for tests). */
  convertStart: (source: string, profile: string, destDir: string, maxSeconds?: number) =>
    invoke<ConvertJob>("video_convert_start", { source, profile, destDir, maxSeconds: maxSeconds ?? null }),
  convertCancel: (id: number) => invoke<void>("video_convert_cancel", { id }),
  convertJobs: () => invoke<ConvertJob[]>("video_convert_jobs"),
  /** Forgets finished jobs. */
  convertClear: () => invoke<void>("video_convert_clear"),
  /** Stores instance options; resolves true when they are already in effect. */
  setOptions: (options: MediaOptions) => invoke<boolean>("video_set_options", { options }),
  /** Starts searching for cast devices. */
  castDiscover: () => invoke<CastState>("video_cast_discover"),
  castState: () => invoke<CastState>("video_cast_state"),
  /** Chooses the device for the next playback (null = this computer). Re-open the media after. */
  castTo: (id: number | null) => invoke<CastState>("video_cast_to", { id }),
  castStopDiscovery: () => invoke<void>("video_cast_stop_discovery"),
};

/** Fires when a conversion changes (progress, finished, failed, cancelled). */
export function onConvert(handler: (job: ConvertJob) => void): Promise<UnlistenFn> {
  return listen<ConvertJob>("video-convert", (event) => handler(event.payload));
}

/** True for `scheme://…` addresses (mirrors `is_location` in capture.rs). */
export function isLocation(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
}

/** An address that is probably a list of channels or tracks rather than one stream. */
export function looksLikePlaylist(url: string): boolean {
  const lower = url.toLowerCase();
  return /\.(m3u|pls|xspf|asx)(\?|#|$)/.test(lower) || /[?&]type=m3u/.test(lower);
}

/**
 * Where the media library (agent C) plugs in: when set, a pasted playlist address with more than
 * one entry is handed over to be stored as a playlist. Return true when it was taken; otherwise
 * the first entry plays and the rest becomes the queue.
 */
export const playlistHook: { importPlaylist?: (url: string, entries: PlaylistEntry[]) => boolean | Promise<boolean> } = {};
