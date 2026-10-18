import { api } from "./api";
import { normalizeAppearance, type Appearance } from "./appearance";
import { normalizeSettings, type SlideshowSettings } from "./modules/gallery/slideshow/settings";
import type { SortMode } from "./modules/gallery/library/model";
import { MODULE_IDS, type ModuleId } from "./shell/module";

export type FilesView = "icon" | "list" | "column" | "gallery";
export type FilesSortKey = "name" | "date" | "size" | "kind";

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
}

const DEFAULT_FILES: FilesSettings = {
  showHidden: false,
  view: "icon",
  foldersFirst: true,
  iconSize: 96,
  sort: { key: "name", ascending: true },
  pinned: [],
  lastPath: null,
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
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await api.loadConfig();
    if (!raw) return structuredClone(DEFAULTS);
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
    };
  } catch (err) {
    console.warn("Could not read config, using defaults:", err);
    return structuredClone(DEFAULTS);
  }
}

let saveTimer: number | undefined;

/** Persists the config shortly after the last change. */
export function saveConfig(config: Config) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.saveConfig(JSON.stringify(config, null, 2)).catch((err) => console.error("Saving config failed:", err));
  }, 400);
}
