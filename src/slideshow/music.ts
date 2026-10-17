import { api, fileUrl, type BuiltinTrack, type MusicFile } from "../api";
import { MusicPlayer } from "./audio";
import { basename } from "../ui/dom";
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
export function yourMusic(): Promise<MusicFile[]> {
  songs ??= api.discoverMusic().catch(() => []);
  return songs;
}

let previewing: { player: MusicPlayer; choice: string; stop: number } | null = null;

/** Plays a short stretch of a track so it can be auditioned; returns false if it can't play. */
export async function previewMusic(choice: string | null, onEnd: () => void): Promise<boolean> {
  stopPreview();
  const music = await resolveMusic(choice);
  if (!music) return false;
  const player = new MusicPlayer();
  const stop = window.setTimeout(() => {
    stopPreview();
    onEnd();
  }, 15_000);
  previewing = { player, choice: choice!, stop };
  try {
    await player.load(fileUrl(music.path));
    if (previewing?.player !== player) return true;
    player.start(player.duration * 0.25);
    player.fadeTo(0.8, 0.6);
    return true;
  } catch (err) {
    console.warn(`Could not preview ${music.path}:`, err);
    stopPreview();
    return false;
  }
}

export function stopPreview() {
  if (!previewing) return;
  clearTimeout(previewing.stop);
  void previewing.player.dispose(0.3);
  previewing = null;
}

export const isPreviewing = (choice: string | null) => !!previewing && previewing.choice === choice;

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
