import { invoke } from "@tauri-apps/api/core";
import { api, type BuiltinTrack, type MusicFile } from "../../../api";
import { basename } from "../../../ui/dom";
import { BUILTIN_MUSIC } from "./settings";

let tracks: Promise<BuiltinTrack[]> | null = null;

/** The soundtracks bundled with the app (loaded once). */
export function builtinTracks(): Promise<BuiltinTrack[]> {
  tracks ??= api.builtinTracks().catch((err) => {
    console.warn("Built-in soundtracks unavailable:", err);
    return [];
  });
  return tracks;
}

let songs: Promise<MusicFile[]> | null = null;

/** Songs found in the user's Music, Downloads and Desktop folders (looked up once). */
export function yourMusic(refresh = false): Promise<MusicFile[]> {
  if (refresh) songs = null;
  songs ??= api.discoverMusic().catch(() => []);
  return songs;
}

export interface ResolvedMusic {
  path: string;
  title: string;
  /** Known only for built-in tracks; enables cutting on the beat. */
  bpm: number | null;
}

export async function resolveMusic(music: string | null): Promise<ResolvedMusic | null> {
  if (!music) return null;
  if (!music.startsWith(BUILTIN_MUSIC)) return { path: music, title: basename(music), bpm: null };
  const id = music.slice(BUILTIN_MUSIC.length);
  const track = (await builtinTracks()).find((t) => t.id === id);
  return track ? { path: track.path, title: track.title, bpm: track.bpm } : null;
}

/**
 * One looping music channel, played natively by the backend (GStreamer) so that pausing and
 * fading never block the interface.
 */
export class MusicChannel {
  playing = false;
  private sample = { seconds: 0, at: 0 };
  private poll = 0;

  constructor(private readonly channel: "show" | "preview") {}

  async play(path: string, volume: number, fadeMs: number, startFraction?: number) {
    await invoke("music_play", { channel: this.channel, path, volume, fadeMs, startFraction: startFraction ?? null });
    this.playing = true;
    this.sample = { seconds: 0, at: performance.now() };
    clearInterval(this.poll);
    this.poll = window.setInterval(() => this.refreshPosition(), 500);
  }

  pause(fadeMs = 400) {
    this.playing = false;
    void invoke("music_pause", { channel: this.channel, fadeMs });
  }

  resume(volume: number, fadeMs = 800) {
    this.playing = true;
    this.sample.at = performance.now();
    void invoke("music_resume", { channel: this.channel, volume, fadeMs });
  }

  volume(volume: number, fadeMs = 250) {
    void invoke("music_volume", { channel: this.channel, volume, fadeMs });
  }

  stop(fadeMs = 600) {
    this.playing = false;
    clearInterval(this.poll);
    void invoke("music_stop", { channel: this.channel, fadeMs });
  }

  /** Seconds into the track, extrapolated between the backend's position reports. */
  get position() {
    return this.sample.seconds + (this.playing ? (performance.now() - this.sample.at) / 1000 : 0);
  }

  private async refreshPosition() {
    const seconds = await invoke<number | null>("music_position", { channel: this.channel }).catch(() => null);
    if (seconds !== null) this.sample = { seconds, at: performance.now() };
  }
}

const previewChannel = new MusicChannel("preview");
let previewing: { choice: string; timer: number } | null = null;
const previewListeners = new Set<(active: boolean) => void>();

/** Lets a running slideshow duck its own music while the user auditions a track. */
export function onPreviewChange(listener: (active: boolean) => void) {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
}

/** Plays 15 seconds from a quarter of the way into a track; false if it can't be played. */
export async function previewMusic(choice: string | null, onEnd: () => void): Promise<boolean> {
  stopPreview();
  const music = await resolveMusic(choice);
  if (!music || !choice) return false;
  const timer = window.setTimeout(() => {
    stopPreview();
    onEnd();
  }, 15_000);
  previewing = { choice, timer };
  previewListeners.forEach((fn) => fn(true));
  try {
    await previewChannel.play(music.path, 0.8, 500, 0.25);
    return true;
  } catch (err) {
    console.warn(`Could not preview ${music.path}:`, err);
    stopPreview();
    return false;
  }
}

export function stopPreview() {
  if (!previewing) return;
  clearTimeout(previewing.timer);
  previewing = null;
  previewChannel.stop(300);
  previewListeners.forEach((fn) => fn(false));
}

export const isPreviewing = (choice: string | null) => !!previewing && previewing.choice === choice;
