import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The contract between the Video module's UI and its libVLC backend (src-tauri/src/video/).
 * Command names and payload shapes here must match the Rust side exactly. Frames are not part
 * of this file: `createVideoSurface()` in `./surface.ts` fetches them from `cs://localhost/frame`
 * and draws them with WebGL (see branch `m0-spike` for the measured prototype).
 */

export interface Track {
  /** libVLC's track id; pass it back to select the track. */
  id: number;
  name: string;
}

export interface PlaybackState {
  /** The open file, or null when nothing is loaded. */
  path: string | null;
  playing: boolean;
  /** Current position and duration in milliseconds (length 0 until known). */
  time: number;
  length: number;
  /** Playback reached the end of the file. */
  ended: boolean;
  /** 0–1.25. */
  volume: number;
  muted: boolean;
  /** Playback speed, 1 = normal. */
  rate: number;
  audioTracks: Track[];
  /** Selected audio track id, -1 when none. */
  audioTrack: number;
  subtitleTracks: Track[];
  /** Selected subtitle track id, -1 = subtitles off. */
  subtitleTrack: number;
  /** Decoded picture size (0 until the first frame). */
  videoWidth: number;
  videoHeight: number;
  /** A readable message when the file can't be played. */
  error: string | null;
}

/** A video file, for the play queue and the sidebar. */
export interface VideoFile {
  name: string;
  path: string;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

export const videoApi = {
  /**
   * Opens and starts playing a file. Frames are decoded at most `maxWidth`×`maxHeight` (device
   * pixels of the stage, keeping the aspect ratio); `startAt` resumes from a position in ms.
   */
  open: (path: string, maxWidth: number, maxHeight: number, startAt = 0) =>
    invoke<void>("video_open", { path, maxWidth, maxHeight, startAt }),
  setPaused: (paused: boolean) => invoke<void>("video_set_paused", { paused }),
  /** Stops and unloads the current file. */
  stop: () => invoke<void>("video_stop"),
  seek: (time: number) => invoke<void>("video_seek", { time }),
  setVolume: (volume: number) => invoke<void>("video_set_volume", { volume }),
  setMuted: (muted: boolean) => invoke<void>("video_set_muted", { muted }),
  setRate: (rate: number) => invoke<void>("video_set_rate", { rate }),
  setAudioTrack: (id: number) => invoke<void>("video_set_audio_track", { id }),
  setSubtitleTrack: (id: number) => invoke<void>("video_set_subtitle_track", { id }),
  /** Adds an external subtitle file (SRT, ASS, VTT…) and selects it. */
  addSubtitle: (path: string) => invoke<void>("video_add_subtitle", { path }),
  state: () => invoke<PlaybackState>("video_state"),
  /** Video files directly inside a folder, sorted naturally by name. */
  listVideos: (folder: string) => invoke<VideoFile[]>("video_list", { folder }),
};

/** Fires on every state change and about four times a second while playing. */
export function onState(handler: (state: PlaybackState) => void): Promise<UnlistenFn> {
  return listen<PlaybackState>("video-state", (event) => handler(event.payload));
}

// Custom schemes are exposed as http://<scheme>.localhost on Windows and <scheme>://localhost elsewhere.
const BASE = navigator.userAgent.includes("Windows") ? "http://cs.localhost/" : "cs://localhost/";

/** A cached JPEG frame from about 10% into a video, with its long edge at most `size`. */
export const videoThumbUrl = (path: string, mtime: number, size: number) =>
  `${BASE}vthumb?s=${size}&p=${encodeURIComponent(path)}&t=${Math.round(mtime * 1000)}`;

/** The WebGL canvas that shows decoded frames; `createVideoSurface()` in `./surface.ts` makes one. */
export interface VideoSurface {
  readonly el: HTMLCanvasElement;
  /** Starts pulling and drawing frames; `stop()` pauses that (e.g. while the module is hidden). */
  start(): void;
  stop(): void;
  /** The canvas size in device pixels, to pass to `videoApi.open`. */
  readonly pixelSize: { width: number; height: number };
  dispose(): void;
}
