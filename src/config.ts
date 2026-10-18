import { api } from "./api";
import { normalizeAppearance, type Appearance } from "./appearance";
import { normalizeSettings, type SlideshowSettings } from "./modules/gallery/slideshow/settings";
import type { SortMode } from "./modules/gallery/library/model";
import { MODULE_IDS, type ModuleId } from "./shell/module";
import { tellOthers } from "./shell/windows";

export type FilesView = "icon" | "list" | "column" | "gallery";
export type FilesSortKey = "name" | "date" | "size" | "kind";

export type VideoSection = "home" | "videos" | "recent";

/** Where a video was left, for resuming and for the sidebar's progress bars. */
export interface VideoPosition {
  /** Milliseconds. */
  time: number;
  length: number;
  /** When it was last watched, ms since the epoch. */
  at: number;
}

export interface VideoSettings {
  /** 0–2 (200%, as in VLC; libVLC amplifies above 1). */
  volume: number;
  muted: boolean;
  /** The sidebar (play queue / browser) is open. */
  sidebar: boolean;
  section: VideoSection;
  /** Resume points by file path; trimmed to the most recent 500. */
  positions: Record<string, VideoPosition>;
  /** Recently played files, most recent first (max 50). */
  recent: string[];
  /** Control-bar items in order (Customise player); see docs/design/vlc/PLAYER.md. */
  controls: string[];
  /** Settings of individual video features, by feature id (see `featureSettings` in video/extensions.ts). */
  ext: Record<string, unknown>;
}

/** The redesign's bar (Figma): transport, the seek bar and volume, then quick access and panel/fullscreen on the right. */
export const DEFAULT_VIDEO_CONTROLS = ["previous", "play", "next", "seek", "volume", "audio", "subtitles", "playlist", "settings", "fullscreen"];

export interface FilesSettings {
  showHidden: boolean;
  view: FilesView;
  foldersFirst: boolean;
  /** Tile size of the icon view, in CSS pixels. */
  iconSize: number;
  sort: { key: FilesSortKey; ascending: boolean };
  /** Folders the user pinned to the sidebar's Favourites. */
  pinned: string[];
  /** Where the last session ended, to reopen there. */
  lastPath: string | null;
  /** Ask before moving items to the Trash. */
  confirmTrash: boolean;
  /** The terminal "Open Terminal Here" launches (a command name); null picks one automatically. */
  terminal: string | null;
  /** Servers saved from Connect to Server, shown under Network in the sidebar. */
  servers: SavedServer[];
}

export interface SavedServer {
  name: string;
  /** e.g. smb://nas/photos, sftp://user@host/home/user */
  url: string;
}

export interface Config {
  /** Extra folders added by hand; everything else is discovered automatically. */
  roots: string[];
  hiddenAlbums: string[];
  favoriteAlbums: string[];
  libraryView: "albums" | "favorites" | "photos";
  /** Minutes of inactivity before a configured lock engages; 0 = never. */
  autoLockMinutes: number;
  thumbSize: number;
  sort: SortMode;
  showInfo: boolean;
  showFilmstrip: boolean;
  slideshow: SlideshowSettings;
  appearance: Appearance;
  /** Which features are on (Settings → Features). At least one stays on. */
  features: Record<ModuleId, boolean>;
  /** The module shown last, reopened at launch. */
  module: ModuleId;
  /** The first-run wizard has been completed. */
  onboarded: boolean;
  files: FilesSettings;
  video: VideoSettings;
}

const DEFAULT_VIDEO: VideoSettings = {
  volume: 1,
  muted: false,
  sidebar: true,
  section: "home",
  positions: {},
  recent: [],
  controls: DEFAULT_VIDEO_CONTROLS,
  ext: {},
};

function normalizeVideo(raw: Partial<VideoSettings> | undefined): VideoSettings {
  const v = { ...DEFAULT_VIDEO, ...raw };
  const positions: Record<string, VideoPosition> = {};
  if (v.positions && typeof v.positions === "object") {
    for (const [path, p] of Object.entries(v.positions)) {
      if (p && typeof p.time === "number" && typeof p.length === "number" && typeof p.at === "number") positions[path] = p;
    }
  }
  return {
    volume: typeof v.volume === "number" ? Math.min(2, Math.max(0, v.volume)) : 1,
    muted: v.muted === true,
    sidebar: v.sidebar !== false,
    section: v.section === "videos" || v.section === "recent" ? v.section : "home",
    positions,
    recent: Array.isArray(v.recent) ? v.recent.filter((p) => typeof p === "string").slice(0, 50) : [],
    controls: Array.isArray(v.controls) && v.controls.every((c) => typeof c === "string") ? v.controls : DEFAULT_VIDEO_CONTROLS,
    ext: v.ext && typeof v.ext === "object" && !Array.isArray(v.ext) ? v.ext : {},
  };
}

const DEFAULT_FILES: FilesSettings = {
  showHidden: false,
  view: "icon",
  foldersFirst: true,
  iconSize: 96,
  sort: { key: "name", ascending: true },
  pinned: [],
  lastPath: null,
  confirmTrash: false,
  terminal: null,
  servers: [],
};

function normalizeFiles(raw: Partial<FilesSettings> | undefined): FilesSettings {
  const f = { ...DEFAULT_FILES, ...raw };
  const sort = f.sort && ["name", "date", "size", "kind"].includes(f.sort.key) ? f.sort : DEFAULT_FILES.sort;
  return {
    showHidden: f.showHidden === true,
    view: ["icon", "list", "column", "gallery"].includes(f.view) ? f.view : "icon",
    foldersFirst: f.foldersFirst !== false,
    iconSize: typeof f.iconSize === "number" && f.iconSize >= 48 && f.iconSize <= 256 ? f.iconSize : DEFAULT_FILES.iconSize,
    sort: { key: sort.key, ascending: sort.ascending !== false },
    pinned: Array.isArray(f.pinned) ? f.pinned.filter((p) => typeof p === "string") : [],
    lastPath: typeof f.lastPath === "string" ? f.lastPath : null,
    confirmTrash: f.confirmTrash === true,
    terminal: typeof f.terminal === "string" && f.terminal.trim() ? f.terminal.trim() : null,
    servers: Array.isArray(f.servers)
      ? f.servers.filter((s): s is SavedServer => !!s && typeof s.name === "string" && typeof s.url === "string")
      : [],
  };
}

function normalizeFeatures(raw: Partial<Record<ModuleId, boolean>> | undefined): Record<ModuleId, boolean> {
  const features = Object.fromEntries(MODULE_IDS.map((id) => [id, raw?.[id] !== false])) as Record<ModuleId, boolean>;
  if (!MODULE_IDS.some((id) => features[id])) features.gallery = true;
  return features;
}

const DEFAULTS: Config = {
  roots: [],
  hiddenAlbums: [],
  favoriteAlbums: [],
  libraryView: "albums",
  autoLockMinutes: 5,
  thumbSize: 168,
  sort: "date",
  showInfo: false,
  showFilmstrip: true,
  slideshow: normalizeSettings(undefined),
  appearance: normalizeAppearance(undefined),
  features: normalizeFeatures(undefined),
  module: "files",
  onboarded: false,
  files: DEFAULT_FILES,
  video: DEFAULT_VIDEO,
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await api.loadConfig();
    if (!raw) return structuredClone(DEFAULTS);
    return parseConfig(raw);
  } catch (err) {
    console.warn("Could not read config, using defaults:", err);
    return structuredClone(DEFAULTS);
  }
}

/** A saved config with every field checked and defaults filled in; throws on malformed JSON. */
export function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw) as Partial<Config>;
  return {
    ...structuredClone(DEFAULTS),
    ...parsed,
    roots: Array.isArray(parsed.roots) ? parsed.roots.filter((r) => typeof r === "string") : [],
    hiddenAlbums: Array.isArray(parsed.hiddenAlbums) ? parsed.hiddenAlbums.filter((r) => typeof r === "string") : [],
    favoriteAlbums: Array.isArray(parsed.favoriteAlbums) ? parsed.favoriteAlbums.filter((r) => typeof r === "string") : [],
    libraryView: parsed.libraryView === "photos" || parsed.libraryView === "favorites" ? parsed.libraryView : "albums",
    sort: parsed.sort === "name" ? "name" : "date",
    slideshow: normalizeSettings(parsed.slideshow),
    appearance: normalizeAppearance(parsed.appearance),
    features: normalizeFeatures(parsed.features),
    module: MODULE_IDS.includes(parsed.module as ModuleId) ? (parsed.module as ModuleId) : "files",
    onboarded: parsed.onboarded === true,
    files: normalizeFiles(parsed.files),
    video: normalizeVideo(parsed.video),
  };
}

let saveTimer: number | undefined;

/** Persists the config shortly after the last change, and hands it to the other windows. */
export function saveConfig(config: Config) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const json = JSON.stringify(config, null, 2);
    api.saveConfig(json)
      .then(() => tellOthers(CONFIG_SAVED, json))
      .catch((err) => console.error("Saving config failed:", err));
  }, 400);
}

/** The event that carries a saved config to the other windows. */
export const CONFIG_SAVED = "config-saved";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Takes another window's saved config into this one in place: objects are merged key by key (code
 * holds references into the config, e.g. `config.video`), everything else is replaced. Which module
 * this window shows stays its own.
 */
export function adoptConfig(config: Config, incoming: Config) {
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      const current = target[key];
      if (isObject(value) && isObject(current)) merge(current, value);
      else target[key] = value;
    }
  };
  const { module: _own, ...rest } = incoming;
  merge(config as unknown as Record<string, unknown>, rest as unknown as Record<string, unknown>);
}
