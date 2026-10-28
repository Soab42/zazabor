import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Zazabor's content library (src-tauri/src/content.rs): soundtracks, sound effects, motion
 * templates and their fonts, on the content site and downloaded the first time they're used. The
 * starter set ships with the app; this is everything in the library's catalog.
 */

export interface LibraryFile {
  /** The file's path in the library ("music/cinematic.ogg"). */
  file: string;
  bytes: number;
  sha256: string;
}

export interface LibraryTrack extends LibraryFile {
  id: string;
  title: string;
  vibe: string;
  bpm: number;
  seconds: number;
}

export interface LibrarySound extends LibraryFile {
  id: string;
  title: string;
  seconds: number;
}

export interface LibraryFontFile extends LibraryFile {
  /** The font's own file name. */
  name: string;
  weight: string;
  style: "normal" | "italic";
}

export interface LibraryFont {
  family: string;
  kind: string;
  dir: string;
  bangla?: boolean;
  /** Ships with the app (in /fonts). */
  starter?: boolean;
  files: LibraryFontFile[];
}

export interface LibraryTemplate extends LibraryFile {
  id: string;
  name: string;
  category: string;
  /** The template format it needs (motion/format.ts FORMAT_VERSION). */
  format: number;
  starter?: boolean;
}

export interface Catalog {
  kind: string;
  format: number;
  /** When it was published (Unix seconds). */
  published: number;
  music: LibraryTrack[];
  sounds: LibrarySound[];
  fonts: LibraryFont[];
  templates: LibraryTemplate[];
}

export interface LibraryState {
  catalog: Catalog | null;
  /** Its files that are downloaded. */
  installed: string[];
  /** Where downloaded files are: `${dir}/${file}`. */
  dir: string;
  /** Why the content site couldn't be asked, when it couldn't. */
  error: string | null;
}

const EMPTY: LibraryState = { catalog: null, installed: [], dir: "", error: null };

let state: Promise<LibraryState> | null = null;
let known: LibraryState = EMPTY;
/** When the site was last asked, if it couldn't be reached then. */
let failedAt = 0;
/** After the site couldn't be reached, it's asked again this much later. */
const RETRY_MS = 2 * 60_000;
const installed = new Set<string>();

/** Fires "change" when a newer catalog arrives. */
export const libraryEvents = new EventTarget();

/**
 * The library: its catalog as kept on this computer, asked for again from the site when it's
 * a few hours old (or now, with `refresh`). Offline, the kept one; never online, an empty one.
 */
export function library(refresh = false): Promise<LibraryState> {
  if (state && !refresh && !(failedAt && Date.now() - failedAt > RETRY_MS)) return state;
  const before = known.catalog?.published ?? -1;
  state = invoke<LibraryState>("content_catalog", { refreshNow: refresh || failedAt > 0 }).then((s) => {
    known = s;
    failedAt = s.error ? Date.now() : 0;
    installed.clear();
    for (const f of s.installed) installed.add(f);
    if ((s.catalog?.published ?? -1) !== before) libraryEvents.dispatchEvent(new Event("change"));
    return s;
  }, (err) => {
    console.warn("[content] library unavailable:", err);
    return { ...known, error: String(err) };
  });
  return state;
}

/** Where a library file is (or will be, once downloaded). */
export function localPath(file: string): string {
  return `${known.dir}/${file}`;
}

export const isLocal = (file: string) => installed.has(file);

/** A library file's path, downloading it first if it isn't here. */
export async function fetchFile(file: string): Promise<string> {
  await library();
  const path = await invoke<string>("content_fetch", { file });
  installed.add(file);
  return path;
}

/** A library file's bytes (a template or a font), downloading it first if it isn't here. */
export async function readFile(file: string): Promise<ArrayBuffer> {
  await library();
  const bytes = await invoke<ArrayBuffer>("content_read", { file });
  installed.add(file);
  return bytes;
}

/** Download progress of the library's bigger files (soundtracks, fonts). */
export function onDownload(listener: (p: { file: string; done: number; total: number }) => void): Promise<() => void> {
  return listen<{ file: string; done: number; total: number }>("content-progress", (e) => listener(e.payload));
}

/** The library file a path names: one in the library's folder, or Zazabor's soundtracks as they were bundled before. */
async function libraryFileOf(path: string): Promise<string | null> {
  const s = await library();
  if (s.dir && path.startsWith(`${s.dir}/`)) return path.slice(s.dir.length + 1);
  const bundled = /[/\\]resources[/\\]music[/\\]([^/\\]+)$/.exec(path)?.[1];
  return (bundled && s.catalog?.music.find((t) => t.file.split("/").pop() === bundled)?.file) || null;
}

/** Makes sure a library file a path names is downloaded (no-op for any other path). */
export async function ensureLocal(path: string): Promise<void> {
  const file = await libraryFileOf(path);
  if (file && !installed.has(file)) await fetchFile(file);
}

/**
 * A missing file that's in the library, downloaded again (removed with Remove Downloads, or a
 * soundtrack from when they came with the app): its path now, or null.
 */
export async function restoreFromLibrary(path: string): Promise<string | null> {
  const file = await libraryFileOf(path);
  if (!file) return null;
  try {
    return await fetchFile(file);
  } catch (err) {
    console.warn("[content] couldn't restore", path, err);
    return null;
  }
}

/** The library's soundtracks; `path` is where each is or will be, `local` whether it's downloaded. */
export async function soundtracks(): Promise<(LibraryTrack & { path: string; local: boolean })[]> {
  const s = await library();
  return (s.catalog?.music ?? []).map((t) => ({ ...t, path: localPath(t.file), local: installed.has(t.file) }));
}

/** The library's extra sound effects (beyond those that come with Zazabor), like `soundtracks`. */
export async function extraSounds(): Promise<(LibrarySound & { path: string; local: boolean })[]> {
  const s = await library();
  return (s.catalog?.sounds ?? []).map((t) => ({ ...t, path: localPath(t.file), local: installed.has(t.file) }));
}

export const formatBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
