import { api } from "./api";
import { normalizeAppearance, type Appearance } from "./appearance";
import { normalizeSettings, type SlideshowSettings } from "./slideshow/settings";
import type { SortMode } from "./library/model";

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
