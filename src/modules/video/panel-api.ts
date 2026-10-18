import { invoke } from "@tauri-apps/api/core";
import type { Track } from "./api";

/**
 * The contract between the side panel's tabs (Subtitles, Audio, Video, Playback) and the Rust
 * backend (src-tauri/src/video/{fx,tracks,meta}.rs). Command names and payload shapes must match
 * exactly. Everything rejects with "locked" while the app is locked.
 *
 * libVLC keeps the equalizer and the delays per media player and a new player is made for every
 * file, so the UI applies them again whenever a file opens.
 */

export interface EqPreset {
  index: number;
  name: string;
  /** dB. */
  preamp: number;
  /** dB per band, in the order of `EqInfo.frequencies`. */
  bands: number[];
}

export interface EqInfo {
  /** Centre frequency of each band in Hz (10 bands). */
  frequencies: number[];
  presets: EqPreset[];
}

export interface VideoTracks {
  tracks: Track[];
  /** The selected track's id, -1 when none. */
  current: number;
}

/** One stream of the current media. */
export interface StreamInfo {
  codec: string;
  language: string | null;
  /** Bits per second, 0 when unknown. */
  bitrate: number;
  width: number;
  height: number;
  fps: number;
  channels: number;
  sampleRate: number;
}

export interface MediaMeta {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  date: string | null;
  /** Bytes; 0 for streams. */
  size: number;
  bitrateKbps: number;
  video: StreamInfo[];
  audio: StreamInfo[];
  subtitles: StreamInfo[];
}

export interface FileHash {
  /** OpenSubtitles movie hash, 16 hex digits. */
  hash: string;
  size: number;
}

export interface OnlineReply {
  status: number;
  body: string;
}

/** A subtitle track stored in the video file (src-tauri/src/video/embedded_subs.rs), in file order. */
export interface EmbeddedTrack {
  /** Position among the file's subtitle tracks; libVLC lists them in the same order. */
  index: number;
  trackNumber: number;
  codec: string;
  language: string;
  name: string;
  default: boolean;
  forced: boolean;
  /** A text track we can draw ourselves; image tracks (PGS, VobSub) stay with libVLC. */
  text: boolean;
  /** Times in ms; text with its SRT tags or ASS override blocks. */
  cues: { start: number; end: number; text: string }[];
}

export const panelApi = {
  eqInfo: () => invoke<EqInfo>("video_eq_info"),
  /** Turns the equalizer on with these gains (dB), or off. */
  setEqualizer: (enabled: boolean, preamp: number, bands: number[]) => invoke<void>("video_set_equalizer", { enabled, preamp, bands }),
  /** Positive = sound later. Whole milliseconds, within ±60 s. */
  setAudioDelay: (ms: number) => invoke<void>("video_set_audio_delay", { ms: Math.round(ms) }),
  /** Delay of VLC's own (embedded) subtitle tracks; positive = subtitles later. */
  setSubtitleDelay: (ms: number) => invoke<void>("video_set_subtitle_delay", { ms: Math.round(ms) }),
  videoTracks: () => invoke<VideoTracks>("video_video_tracks"),
  setVideoTrack: (id: number) => invoke<void>("video_set_video_track", { id }),
  meta: () => invoke<MediaMeta>("video_meta"),
  /** The subtitle tracks inside a Matroska/WebM file (empty for other files). */
  embeddedSubtitles: (path: string) => invoke<EmbeddedTrack[]>("video_embedded_subtitles", { path }),
  fileHash: (path: string) => invoke<FileHash>("video_file_hash", { path }),
  /** One call to the OpenSubtitles REST API v1 (`path` like "/subtitles?query=x"). */
  onlineRequest: (method: "GET" | "POST", path: string, apiKey: string, token?: string, body?: unknown) =>
    invoke<OnlineReply>("video_online_request", {
      method, path, apiKey, token: token ?? null, body: body === undefined ? null : JSON.stringify(body),
    }),
  /** Downloads a subtitle from an OpenSubtitles address into a cache folder; returns the file's path. */
  onlineDownload: (url: string, name: string) => invoke<string>("video_online_download", { url, name }),
};

/** A folder entry as `fs_list` reports it (only what the panel reads). */
export interface FolderEntry {
  name: string;
  path: string;
  dir: boolean;
}

/** The entries of a folder (hidden ones included), via the Files module's `fs_list`. */
export const listFolder = (path: string) => invoke<FolderEntry[]>("fs_list", { path, showHidden: true });
