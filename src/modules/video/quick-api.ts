import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The contract between the player chrome (control bar, quick access, Bookmarks tab) and the
 * backend files `src-tauri/src/video/{audio_out,chapters,sprite}.rs`, plus the small hooks other
 * features use to plug into the chrome. Command names and payloads match the Rust side exactly.
 */

/** An audio output device (speakers, headphones…). */
export interface AudioDevice {
  /** Pass back to `setAudioDevice`; "" is the system default. */
  id: string;
  name: string;
  /** The device the sound is going to now. */
  current: boolean;
}

/** A chapter from the file's container. Times are milliseconds. */
export interface Chapter {
  index: number;
  name: string;
  start: number;
  duration: number;
}

/** How the seek-preview frames are laid out for a video. */
export interface SpriteInfo {
  path: string;
  /** Frame `i` shows the video around `i * intervalMs + intervalMs / 2`. */
  intervalMs: number;
  count: number;
  /** Frames that already exist (from an earlier run). */
  ready: number[];
}

export const quickApi = {
  /** Output devices of the open player; empty when nothing is playing. */
  audioDevices: () => invoke<AudioDevice[]>("video_audio_devices"),
  setAudioDevice: (id: string) => invoke<void>("video_set_audio_device", { id }),
  /** Chapters of the open file; empty when it has none. */
  chapters: () => invoke<Chapter[]>("video_chapters"),
  setChapter: (index: number) => invoke<void>("video_set_chapter", { index }),
  /**
   * Starts making preview frames for the open file (`length` in ms) in the background. Each new
   * frame fires a `video-sprite` event; starting another file stops the previous job.
   */
  spriteStart: (path: string, length: number) => invoke<SpriteInfo | null>("video_sprite_start", { path, length: Math.round(length) }),
  spriteStop: () => invoke<void>("video_sprite_stop"),
};

/** Fires when preview frame `index` of `path` has been written. */
export function onSpriteFrame(handler: (frame: { path: string; index: number }) => void): Promise<UnlistenFn> {
  return listen<{ path: string; index: number }>("video-sprite", (event) => handler(event.payload));
}

const BASE = navigator.userAgent.includes("Windows") ? "http://cs.localhost/" : "cs://localhost/";

/** One preview frame (a small JPEG); 404 until the backend has made it. `salt` busts stale caches. */
export const spriteFrameUrl = (path: string, intervalMs: number, index: number, salt: number) =>
  `${BASE}vthumb?p=${encodeURIComponent(path)}&iv=${intervalMs}&i=${index}&t=${salt}`;

// ---- hooks into the chrome ---------------------------------------------------------------------

/** A tick on the seek bar. */
export interface SeekMark {
  /** Milliseconds. */
  time: number;
  kind: "chapter" | "bookmark";
  label: string;
}

/**
 * Things the chrome calls that other features provide. Set a handler to take over; the chrome
 * falls back to its own behaviour while one is null.
 */
export const quickHooks: {
  /** "Add Subtitles…" in the subtitle quick menu (agent B's dialog); null = a plain file picker. */
  addSubtitles: (() => void) | null;
  /** Adds a bookmark at the current time (the bar's Bookmark button, Ctrl+B). */
  addBookmark: (() => void) | null;
} = { addSubtitles: null, addBookmark: null };

type Listener = () => void;

/** The ticks the seek bar draws: chapters and bookmarks. Features call `set`; the bar subscribes. */
export const seekMarks = {
  list: [] as SeekMark[],
  listeners: new Set<Listener>(),
  set(marks: SeekMark[]) {
    this.list = marks;
    for (const fn of this.listeners) fn();
  },
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
};
