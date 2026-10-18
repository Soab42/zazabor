import type { IconName } from "../../../../ui/icons";
import type { LibSection, MusicTab, SortKey, ViewMode } from "../../library-api";
import type { Library } from "./store";

/** Where the library is: a section, and a place inside it. */
export type Route =
  | { section: "home" }
  | { section: "recent" }
  | { section: "videos"; folder?: string }
  | { section: "music"; tab: MusicTab; album?: string; artist?: string; genre?: string }
  | { section: "streams" }
  | { section: "playlists"; id?: string };

export interface Crumb {
  label: string;
  route: Route;
}

export interface PageHooks {
  openFile(): void;
  openFolder(): void;
  /** Removes a file from the history lists. */
  forget(path: string): void;
}

export interface PageEnv {
  lib: Library;
  hooks: PageHooks;
  route: Route;
  /** The search box text (lower-cased and trimmed). */
  query: string;
  view: ViewMode;
  sort: SortKey;
  go(route: Route): void;
}

export interface PageResult {
  body: HTMLElement;
  /** "12 videos", shown beside the controls. */
  count?: string;
  /** Extra buttons for the toolbar (Open Folder, New Playlist…). */
  actions?: HTMLElement[];
  /** Called before the page is replaced (drop targets to unregister). */
  dispose?: () => void;
}

/** What a page offers in the toolbar. */
export interface PageKind {
  key: string;
  sorts: SortKey[];
  defaultSort: SortKey;
  views: boolean;
  defaultView: ViewMode;
  search: boolean;
  placeholder: string;
}

export const SORT_LABELS: Record<SortKey, string> = {
  recent: "Recent", name: "Name", duration: "Duration", unwatched: "Unwatched first", artist: "Artist", year: "Year", count: "Most items",
};

const VIDEO_SORTS: SortKey[] = ["recent", "name", "duration", "unwatched"];

const none = (key: string, placeholder = "Search"): PageKind => ({ key, sorts: [], defaultSort: "name", views: false, defaultView: "grid", search: false, placeholder });

/** The toolbar controls of a route. */
export function pageKind(route: Route): PageKind {
  switch (route.section) {
    case "home": return none("home");
    case "recent": return { key: "recent", sorts: VIDEO_SORTS, defaultSort: "recent", views: true, defaultView: "grid", search: true, placeholder: "Search recent videos" };
    case "videos":
      return route.folder
        ? { key: "folder", sorts: ["name", "recent", "duration", "unwatched"], defaultSort: "name", views: true, defaultView: "grid", search: true, placeholder: "Search this folder" }
        : { key: "videos", sorts: VIDEO_SORTS, defaultSort: "recent", views: true, defaultView: "grid", search: true, placeholder: "Search folders" };
    case "music":
      if (route.album) return { ...none("album"), search: false };
      if (route.artist) return { key: "artist", sorts: [], defaultSort: "name", views: false, defaultView: "grid", search: true, placeholder: "Search songs" };
      if (route.genre) return { key: "genre", sorts: ["name", "artist", "recent", "duration"], defaultSort: "name", views: false, defaultView: "list", search: true, placeholder: "Search songs" };
      switch (route.tab) {
        case "songs": return { key: "songs", sorts: ["name", "artist", "recent", "duration"], defaultSort: "name", views: true, defaultView: "list", search: true, placeholder: "Search songs" };
        case "albums": return { key: "albums", sorts: ["name", "artist", "year", "recent"], defaultSort: "name", views: true, defaultView: "grid", search: true, placeholder: "Search albums" };
        case "artists": return { key: "artists", sorts: ["name", "count"], defaultSort: "name", views: true, defaultView: "grid", search: true, placeholder: "Search artists" };
        default: return { key: "genres", sorts: ["name", "count"], defaultSort: "name", views: true, defaultView: "grid", search: true, placeholder: "Search genres" };
      }
    case "streams": return { key: "streams", sorts: ["recent", "name"], defaultSort: "recent", views: false, defaultView: "list", search: true, placeholder: "Search streams" };
    case "playlists":
      return route.id
        ? { key: "playlist", sorts: [], defaultSort: "name", views: false, defaultView: "list", search: true, placeholder: "Search this playlist" }
        : { key: "playlists", sorts: ["recent", "name"], defaultSort: "recent", views: true, defaultView: "grid", search: true, placeholder: "Search playlists" };
  }
}

export const SECTION_TITLES: Record<LibSection, string> = {
  home: "Home", videos: "Videos", music: "Music", streams: "Network Streams", playlists: "Playlists", recent: "Recent",
};

export const SECTION_ICONS: Record<LibSection, IconName> = {
  home: "home", videos: "video", music: "music", streams: "network", playlists: "playlist", recent: "clock",
};

export const MUSIC_TABS: { id: MusicTab; label: string }[] = [
  { id: "songs", label: "Songs" }, { id: "albums", label: "Albums" }, { id: "artists", label: "Artists" }, { id: "genres", label: "Genres" },
];

export const sameRoute = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);
