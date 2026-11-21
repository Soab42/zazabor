import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { fileUrl } from "../../api";
import type { TvSettings } from "../../config";

/**
 * TV's page side: typed wrappers for the `tv_*` commands (the Rust side is `src-tauri/src/tv`).
 * Times are Unix ms.
 *
 * A dev build can run the whole section without the servers or a backend: open the page with
 * `?tvmock` (or set localStorage `zazabor.tvMock` to "1"; "empty" starts with nothing found,
 * "offline" as if the ISP's network was out of reach). That mock (`mock.ts`) is never part of a
 * release build.
 */

// ---- types --------------------------------------------------------------------------------------

export type Section = "movies" | "tv" | "animation" | "indian";

export interface Item {
  id: string;
  title: string;
  year: number | null;
  quality: string;
  tags: string[];
  kind: "movie" | "series";
  section: Section;
  category: string;
  categoryUrl: string;
  folderUrl: string;
  /** Empty until the folder has been looked into. */
  videoUrl: string;
  size: number;
  /** A file in the cache (or, in the mock, a data: URL). */
  poster: string | null;
  noPoster: boolean;
  added: number;
  rank: number | null;
  played: number;
}

export interface CatRow {
  url: string;
  label: string;
  section: Section;
  kind: string;
  count: number;
  items: Item[];
}

export interface Home {
  hero: Item[];
  recent: Item[];
  new: Item[];
  top: Item[];
  topYear: number | null;
  categories: CatRow[];
  total: number;
}

export interface Filter {
  section?: Section;
  kind?: "movie" | "series";
  categoryUrl?: string;
  q?: string;
  year?: number;
  quality?: string;
  sort?: "new" | "az" | "year" | "rank" | "played";
  played?: boolean;
  limit?: number;
  offset?: number;
}

export interface Page {
  items: Item[];
  total: number;
  years: [number, number][];
  qualities: [string, number][];
}

export interface Progress {
  running: boolean;
  done: number;
  total: number;
  items: number;
  reachable: boolean | null;
  error: string;
  lastCrawl: number;
}

export interface Category {
  url: string;
  label: string;
  section: Section;
  series: boolean;
  defaultOn: boolean;
}

export interface Discovered {
  reachable: boolean;
  error: string;
  categories: Category[];
}

export interface Episode {
  name: string;
  url: string;
  size: number;
  season: number | null;
  episode: number | null;
}

export interface Season {
  name: string;
  episodes: Episode[];
}

export interface CacheInfo {
  bytes: number;
  files: number;
  items: number;
  channels: number;
  cap: number;
}

export interface Channel {
  id: string;
  source: string;
  name: string;
  tvgId: string;
  logo: string | null;
  hasLogo: boolean;
  group: string;
  url: string;
  fav: boolean;
  watched: number;
  status: "" | "online" | "offline";
}

export interface SourceResult {
  id: string;
  count: number;
  error: string;
}

export interface Events {
  "tv-progress": Progress;
  "tv-changed": null;
  "tv-live-changed": null;
  "tv-live-status": { id: string; status: "online" | "offline" };
}

export const FREE_BD_PLAYLIST = { name: "Bangladesh (iptv-org)", url: "https://iptv-org.github.io/iptv/countries/bd.m3u" };

// ---- helpers ------------------------------------------------------------------------------------

/** The `<img>` source of a cached poster or logo. */
export const picUrl = (path: string) => (path.startsWith("data:") ? path : fileUrl(path));

export function sizeText(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / 1073741824;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

export function errorText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : "Something went wrong.";
}

export const newId = () => Math.random().toString(36).slice(2, 10);

// ---- the dev mock -------------------------------------------------------------------------------

export interface TvMock {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  listen<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void;
}

function mockWanted(): string | null {
  try {
    const query = new URLSearchParams(location.search);
    if (query.has("tvmock")) return query.get("tvmock") || "1";
    return localStorage.getItem("zazabor.tvMock");
  } catch {
    return null;
  }
}

/** Only dev builds look for the mock; in a release `import.meta.env.DEV` is false and it's dropped. */
const mock: Promise<TvMock> | null = import.meta.env.DEV && mockWanted()
  ? import("./mock").then((m) => m.createMock(mockWanted() ?? "1"))
  : null;

export const isMock = mock !== null;

function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (mock) return mock.then((m) => m.invoke(cmd, args) as Promise<T>);
  return invoke<T>(cmd, args);
}

/** Listens to a TV event; resolves to the function that stops listening. */
export function onTv<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): Promise<UnlistenFn> {
  if (mock) return mock.then((m) => m.listen(event, fn));
  return listen<Events[K]>(event, (e) => fn(e.payload));
}

// ---- commands -----------------------------------------------------------------------------------

export const tvApi = {
  discover: (portal: string) => call<Discovered>("tv_discover", { portal }),
  state: () => call<Progress>("tv_state"),
  start: (settings: TvSettings, force: boolean) =>
    call<Progress>("tv_start", { portals: settings.sources.map((s) => s.url), overrides: settings.overrides, force }),
  home: () => call<Home>("tv_home"),
  items: (filter: Filter, facets = false) => call<Page>("tv_items", { filter, facets }),
  resolve: (id: string) => call<Item>("tv_resolve", { id }),
  episodes: (id: string) => call<Season[]>("tv_episodes", { id }),
  played: (id: string) => call<void>("tv_played", { id }),
  cacheInfo: () => call<CacheInfo>("tv_cache_info"),
  clearCache: (catalogToo = false) => call<void>("tv_clear_cache", { catalogToo }),
  liveRefresh: (settings: TvSettings) => call<SourceResult[]>("tv_live_refresh", { sources: settings.playlists }),
  liveChannels: () => call<Channel[]>("tv_live_channels"),
  liveFav: (id: string, on: boolean) => call<void>("tv_live_fav", { id, on }),
  liveWatched: (id: string) => call<void>("tv_live_watched", { id }),
  liveLogo: (id: string) => call<string | null>("tv_live_logo", { id }),
  liveProbe: (ids: string[], force = false) => call<number>("tv_live_probe", { ids, force }),
};
