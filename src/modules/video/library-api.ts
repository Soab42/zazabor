import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { MenuItem } from "../../ui/menu";

/**
 * The contract of the media library: the backend commands (src-tauri/src/video/library.rs,
 * music.rs, streams.rs), the shapes stored in the library's settings, and the small service other
 * features use (queue actions, "Add to Playlist", saving a stream). Names and payloads must match
 * the Rust side exactly.
 */

// ---- backend -----------------------------------------------------------------------------------

/** What the parser knows about a file; empty strings and zeros mean "not known". */
export interface MediaInfo {
  /** Milliseconds. */
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: number;
  track: number;
  /** An image file with the cover art. */
  cover: string | null;
}

export interface LibVideo {
  name: string;
  path: string;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** Milliseconds; 0 until parsed. */
  duration: number;
  width: number;
  height: number;
}

/** A folder holding videos of 1 MB or more, found under the home folder and mounted drives. */
export interface LibFolder {
  name: string;
  path: string;
  videos: LibVideo[];
  /** The newest modification time of its videos, seconds since the epoch. */
  latest: number;
}

export interface Song {
  path: string;
  /** The file name without extension. */
  name: string;
  size: number;
  mtime: number;
  /** The tag, or the file name. */
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: number;
  track: number;
  /** Milliseconds; 0 until read. */
  duration: number;
  cover: string | null;
}

/** One entry of an IPTV / M3U playlist. */
export interface Channel {
  name: string;
  url: string;
  logo?: string;
  group?: string;
  id?: string;
}

export interface ImportResult {
  /** `playlist`: channels are stored under the id; `stream`: just play the address. */
  kind: "playlist" | "stream";
  title: string | null;
  count: number;
}

export const libraryApi = {
  /** The folders of the last scan (empty until one has finished). */
  videoLibrary: () => invoke<LibFolder[]>("video_library"),
  /** Rescans in the background; `onVideoLibrary` delivers the result (twice: files, then durations). */
  refreshVideos: () => invoke<void>("video_library_refresh"),
  /** Durations, resolution, tags and cover art, in the order of `paths`. */
  meta: (paths: string[]) => invoke<MediaInfo[]>("video_library_meta", { paths }),
  musicLibrary: () => invoke<Song[]>("music_library"),
  /** Rescans in the background; `onMusicLibrary` delivers the result as tags are read. */
  refreshMusic: () => invoke<void>("music_library_refresh"),
  /**
   * Reads an address: an IPTV/M3U playlist URL is downloaded, parsed and stored under `id`
   * (`force` also tries addresses that don't look like a playlist); anything else is a `stream`.
   */
  importStream: (url: string, id: string, force = false) => invoke<ImportResult>("streams_import", { url, id, force }),
  channels: (id: string) => invoke<Channel[]>("streams_channels", { id }),
  forgetChannels: (id: string) => invoke<void>("streams_forget", { id }),
};

export function onVideoLibrary(handler: (folders: LibFolder[]) => void): Promise<UnlistenFn> {
  return listen<LibFolder[]>("video-library", (event) => handler(event.payload));
}

export function onMusicLibrary(handler: (songs: Song[]) => void): Promise<UnlistenFn> {
  return listen<Song[]>("music-library", (event) => handler(event.payload));
}

// ---- settings (stored through `featureSettings(shell, "library", …)`) -------------------------------

export type LibSection = "home" | "videos" | "music" | "streams" | "playlists" | "recent";
export type ViewMode = "grid" | "list";
export type SortKey = "recent" | "name" | "duration" | "unwatched" | "artist" | "year" | "count";
export type MusicTab = "songs" | "albums" | "artists" | "genres";

/** A file path or a stream URL, with what is known about it. */
export interface PlaylistItem {
  path: string;
  name?: string;
  logo?: string;
  group?: string;
}

export interface Playlist {
  id: string;
  name: string;
  /** Empty for an imported IPTV playlist: its channels are stored by the backend under `id`. */
  items: PlaylistItem[];
  created: number;
  /** The M3U address an IPTV playlist was imported from. */
  source?: string;
  /** Number of channels of an IPTV playlist. */
  channelCount?: number;
}

/** A stream address saved in Network Streams. */
export interface SavedStream {
  id: string;
  name: string;
  url: string;
  added: number;
}

export type PinKind = "folder" | "playlist" | "stream" | "album" | "artist";

/** Something pinned under the rail: a folder path, playlist id, stream id, album key or artist name. */
export interface Pin {
  kind: PinKind;
  id: string;
  name: string;
}

export interface LibrarySettings {
  section: LibSection;
  musicTab: MusicTab;
  playlists: Playlist[];
  streams: SavedStream[];
  pinned: Pin[];
  /** Per page: `videos`, `folder`, `songs`, `albums`, `artists`, `genres`, `playlists`, `playlist`, `streams`, `recent`. */
  views: Record<string, ViewMode>;
  sorts: Record<string, SortKey>;
}

export const LIBRARY_DEFAULTS: LibrarySettings = {
  section: "home",
  musicTab: "songs",
  playlists: [],
  streams: [],
  pinned: [],
  views: {},
  sorts: {},
};

// ---- service for other features ------------------------------------------------------------------

/** What other features may ask of the library (get it with `libraryService()`). */
export interface LibraryService {
  /** Plays `paths` as the queue, starting at `start`. */
  playAll(paths: string[], start?: number): void;
  /** Plays the paths right after the current one. */
  playNext(paths: string[]): void;
  addToQueue(paths: string[]): void;
  /** The usual actions for these files: Play Next, Add to Queue, Add to Playlist…. */
  itemMenu(paths: string[]): MenuItem[];
  /** Opens a menu at the point listing the playlists, plus New Playlist…. */
  addToPlaylist(paths: string[], x: number, y: number): void;
  /** Creates a playlist; resolves with its id. */
  createPlaylist(name: string, items?: PlaylistItem[]): string;
  /** Saves a stream address (or imports an IPTV playlist URL); resolves with what it became. */
  addStream(url: string, name?: string): Promise<{ kind: "stream" | "playlist"; id: string }>;
  /** Called whenever playlists, streams, pins or the library data change. */
  onChange(fn: () => void): () => void;
  /** What to call a file or stream (a channel name rather than its address, when known). */
  label(path: string): string;
  /** Names (and groups) for addresses, e.g. the channels of a playlist that is about to play. */
  remember(items: { path: string; name?: string; group?: string }[]): void;
}

let service: LibraryService | null = null;

/** The library service, once the Video module has built it. */
export const libraryService = (): LibraryService | null => service;

export function setLibraryService(next: LibraryService | null) {
  service = next;
}
