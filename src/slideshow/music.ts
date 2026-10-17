import { api, type BuiltinTrack } from "../api";
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
