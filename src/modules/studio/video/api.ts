import { invoke } from "@tauri-apps/api/core";

/** The Video Editor's backend (`src-tauri/src/videoedit`). Bulk data comes back as ArrayBuffers. */

export interface Probe {
  duration: number;
  bytes: number;
  video: { width: number; height: number; fps: number; codec: string | null; rotation: number; decodable: boolean } | null;
  audio: { rate: number; channels: number; codec: string | null; decodable: boolean } | null;
  missing: string[];
}

/** One of MP4's video encoders. */
export interface Codec {
  id: "vaapi" | "x264" | "nvh264" | "x265" | "nvh265";
  label: string;
  available: boolean;
  /** What adds it: a package name, or a sentence. */
  needs: string;
}

export interface Encoders {
  h264: boolean;
  mp3: boolean;
  vp9: boolean;
  opus: boolean;
  aac: boolean;
  hevc: boolean;
  codecs: Codec[];
  /** Packages "Install codecs" would add. */
  missing: string[];
}

/** A captions model (whisper.cpp's ggml files, downloaded on first use). */
export interface CaptionModel {
  id: "base" | "small";
  label: string;
  note: string;
  bytes: number;
  installed: boolean;
  partial: number;
  downloading: boolean;
  error: string | null;
}

/** A clip's sound to caption: `from`–`to` seconds of `path`, at `at` on the timeline. */
export interface CaptionSpan {
  path: string;
  from: number;
  to: number;
  at: number;
  speed: number;
  hasAudio: boolean;
}

/** A caption line, with its words' times from its start. */
export interface Cue {
  start: number;
  end: number;
  text: string;
  words: { t: number; text: string }[];
}

export interface CaptionPoll {
  progress: number;
  stage: string;
  done: boolean;
  result: { language: string; cues: Cue[] } | null;
  error: string | null;
}

/** One of Zazabor's sound effects. */
export interface SoundEffect {
  id: string;
  title: string;
  seconds: number;
  path: string;
}

export interface ExportSpec {
  path: string;
  width: number;
  height: number;
  fps: number;
  format: "mp4" | "webm";
  quality: "high" | "standard" | "small";
  audio: boolean;
  /** MP4's encoder (empty: the best there is). */
  codec?: Codec["id"] | "";
}

export interface ExportDone {
  path: string;
  bytes: number;
  seconds: number;
  frames: number;
}

/** A decoded frame: planar I420, `width` a multiple of 8. `data` is null when unchanged. */
export interface Frame {
  width: number;
  height: number;
  pts: number;
  dur: number;
  ended: boolean;
  data: Uint8Array | null;
}

/** An AutoRecover snapshot of an unsaved project. */
export interface Snapshot {
  id: string;
  title: string;
  path: string | null;
  /** When it was taken (ms). */
  saved: number;
  pid: number;
}

const HEADER = 32;

function parseFrame(buffer: ArrayBuffer): Frame {
  const view = new DataView(buffer);
  const width = view.getUint32(0, true), height = view.getUint32(4, true);
  const flags = view.getUint32(24, true);
  return {
    width,
    height,
    pts: view.getFloat64(8, true),
    dur: view.getFloat64(16, true),
    ended: (flags & 2) !== 0,
    data: flags & 1 ? null : new Uint8Array(buffer, HEADER),
  };
}

export const editApi = {
  probe: (path: string) => invoke<Probe>("videoedit_probe", { path }),
  frame: async (o: { key: string; path: string; time: number; width: number; height: number; maxWidth: number; maxHeight: number; have: number | null }) =>
    parseFrame(await invoke<ArrayBuffer>("videoedit_frame", o)),
  release: (keys: string[], prefix?: string) => invoke<void>("videoedit_release", { keys, prefix: prefix ?? null }),
  /** A thumbnail strip: one picture's width and the JPEG. */
  strip: async (o: { path: string; width: number; height: number; duration: number; thumbHeight: number; count: number }) => {
    const buffer = await invoke<ArrayBuffer>("videoedit_strip", o);
    return { thumbWidth: new DataView(buffer).getUint32(0, true), jpeg: new Blob([new Uint8Array(buffer, 4)], { type: "image/jpeg" }) };
  },
  /** Interleaved 16-bit stereo PCM at 48 kHz. */
  audio: async (path: string, hasAudio: boolean) => new Int16Array(await invoke<ArrayBuffer>("videoedit_audio", { path, hasAudio })),
  encoders: () => invoke<Encoders>("videoedit_encoders"),
  exportBegin: (spec: ExportSpec) => invoke<number>("videoedit_export_begin", { spec }),
  exportAudio: (job: number, pcm: Uint8Array) => invoke<void>("videoedit_export_audio", pcm, { headers: { "x-job": String(job) } }),
  exportFrame: (job: number, frame: Uint8Array) => invoke<number>("videoedit_export_frame", frame, { headers: { "x-job": String(job) } }),
  exportFinish: (job: number) => invoke<ExportDone>("videoedit_export_finish", { job }),
  exportCancel: (job: number) => invoke<void>("videoedit_export_cancel", { job }),
  saveProject: (path: string, text: string) => invoke<void>("videoedit_project_save", { path, text }),
  relink: (o: { project: string | null; folder: string | null; missing: { id: string; name: string; bytes: number | null }[]; oldPaths: string[] }) =>
    invoke<{ id: string; path: string }[]>("videoedit_relink", o),
  recoverySave: (meta: Omit<Snapshot, "saved" | "pid">, text: string) => invoke<void>("videoedit_recovery_save", { meta: { ...meta, saved: 0, pid: 0 }, text }),
  recoveryList: () => invoke<Snapshot[]>("videoedit_recovery_list"),
  recoveryRead: async (id: string) => JSON.parse(await invoke<string>("videoedit_recovery_read", { id })) as unknown,
  recoveryDelete: (id: string) => invoke<void>("videoedit_recovery_delete", { id }),
  writeText: (path: string, text: string) => invoke<void>("videoedit_write_text", { path, text }),
  recordStart: (folder: string | null) => invoke<{ id: number; path: string }>("videoedit_record_start", { folder }),
  recordLevel: (id: number) => invoke<number>("videoedit_record_level", { id }),
  recordStop: (id: number, keep: boolean) => invoke<{ path: string; seconds: number }>("videoedit_record_stop", { id, keep }),
  openProject: async (path: string) => JSON.parse(await invoke<string>("videoedit_project_open", { path })) as unknown,
  captionModels: () => invoke<CaptionModel[]>("videoedit_caption_models"),
  captionModelDownload: (id: CaptionModel["id"]) => invoke<void>("videoedit_caption_model_download", { id }),
  captionModelCancel: (id: CaptionModel["id"]) => invoke<void>("videoedit_caption_model_cancel", { id }),
  captionModelRemove: (id: CaptionModel["id"]) => invoke<void>("videoedit_caption_model_remove", { id }),
  captionsStart: (request: { spans: CaptionSpan[]; model: CaptionModel["id"]; language: string | null; maxChars: number }) =>
    invoke<number>("videoedit_captions_start", { request }),
  captionsPoll: (job: number) => invoke<CaptionPoll>("videoedit_captions_poll", { job }),
  captionsCancel: (job: number) => invoke<void>("videoedit_captions_cancel", { job }),
  installCodecs: (packages: string[]) => invoke<Encoders>("videoedit_codecs_install", { packages }),
  sounds: () => invoke<SoundEffect[]>("videoedit_sounds"),
};
