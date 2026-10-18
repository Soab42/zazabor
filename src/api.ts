import { invoke } from "@tauri-apps/api/core";

export interface PhotoFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  /** Upright display size; 0×0 when unknown, and absent from libraries cached by older versions. */
  width: number;
  height: number;
}

export interface FolderScan {
  path: string;
  name: string;
  photos: PhotoFile[];
}

export interface PhotoInfo {
  /** Stored pixel dimensions, before EXIF orientation. */
  width: number;
  height: number;
  orientation: number;
  size: number;
  mtime: number;
  format: string;
  exif: [string, string][];
}

export type PathKind = "dir" | "image" | "audio" | "file" | "missing";

export interface BuiltinTrack {
  id: string;
  title: string;
  vibe: string;
  file: string;
  bpm: number;
  seconds: number;
  path: string;
}

export interface MusicFile {
  path: string;
  name: string;
  folder: string;
  size: number;
}

export const api = {
  discoverMusic: () => invoke<MusicFile[]>("discover_music"),
  scanFolder: (path: string, recursive = true) =>
    invoke<FolderScan[]>("scan_folder", { path, recursive }),
  discoverPhotos: () => invoke<FolderScan[]>("discover_photos"),
  cachedPhotos: async (): Promise<FolderScan[] | null> => {
    const raw = await invoke<string | null>("cached_photos");
    return raw ? (JSON.parse(raw) as FolderScan[]) : null;
  },
  builtinTracks: () => invoke<BuiltinTrack[]>("builtin_tracks"),
  photoInfo: (path: string) => invoke<PhotoInfo>("photo_info", { path }),
  pathKind: (path: string) => invoke<PathKind>("path_kind", { path }),
  launchPath: () => invoke<string | null>("launch_path"),
  loadConfig: () => invoke<string | null>("load_config"),
  saveConfig: (json: string) => invoke<void>("save_config", { json }),
  log: (level: string, message: string) => invoke<void>("log", { level, message }),
};

// Custom schemes are exposed as http://<scheme>.localhost on Windows and <scheme>://localhost elsewhere.
const BASE = navigator.userAgent.includes("Windows") ? "http://cs.localhost/" : "cs://localhost/";

const query = (path: string, mtime?: number) =>
  `p=${encodeURIComponent(path)}${mtime ? `&t=${Math.round(mtime * 1000)}` : ""}`;

/** An oriented thumbnail whose long edge is at most `size`. */
export const thumbUrl = (path: string, mtime: number, size: number) =>
  `${BASE}thumb?s=${size}&${query(path, mtime)}`;

/** An oriented, high-quality render whose long edge is at most `size` (0 = full resolution). */
export const previewUrl = (path: string, mtime: number, size: number) =>
  `${BASE}preview?s=${size}&${query(path, mtime)}`;

/** Decodes the full-resolution image on the backend (for tiles); answers with its size. */
export const fullUrl = (path: string, mtime: number) => `${BASE}full?${query(path, mtime)}`;

/** One tile of the full-resolution image as raw RGBA (see TiledImage). */
export const tileUrl = (path: string, mtime: number, x: number, y: number, size: number) =>
  `${BASE}tile?s=${size}&x=${x}&y=${y}&${query(path, mtime)}`;

/** The original file bytes. */
export const fileUrl = (path: string, mtime?: number) => `${BASE}file?${query(path, mtime)}`;

/**
 * Long-edge size for screen renders (viewer previews and slideshow frames): `headroom` times
 * the screen so Ken Burns zooms stay sharp, rounded so the disk cache is shared.
 */
export function displayRenderSize(headroom = 1.25) {
  const dpr = window.devicePixelRatio || 1;
  const long = Math.max(screen.width, screen.height) * dpr * headroom;
  return Math.min(4096, Math.max(1536, Math.ceil(long / 512) * 512));
}

/** Formats the webview decodes natively; others are shown through a full-size render. */
export const browserDecodable = (path: string) => /\.(jpe?g|jpe|jfif|png|gif|webp|bmp)$/i.test(path);

/** Loads and decodes an image that canvas and WebGL may read (CORS-clean). */
export function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const onAbort = () => {
      img.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    img.src = url;
    img
      .decode()
      .catch(() => {
        // decode() can reject for images that did load (e.g. very large ones); trust the element.
        if (!(img.complete && img.naturalWidth > 0)) throw new Error(`Could not load ${url}`);
      })
      .then(
        () => {
          signal?.removeEventListener("abort", onAbort);
          if (!signal?.aborted) resolve(img);
        },
        (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
  });
}

/** Mirrors console errors and uncaught exceptions to the terminal running the app. */
export function forwardLogsToTerminal() {
  const send = (level: string, parts: unknown[]) => {
    const message = parts
      .map((p) => (p instanceof Error ? `${p.message}\n${p.stack ?? ""}` : typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ");
    api.log(level, message).catch(() => {});
  };
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      send(level, args);
    };
  }
  window.addEventListener("error", (e) => send("error", [e.error ?? e.message]));
  window.addEventListener("unhandledrejection", (e) => send("error", ["Unhandled rejection:", e.reason]));
}
