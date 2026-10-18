import { basename, dirname } from "../../../../ui/dom";
import type { LibFolder, LibVideo, Song, SortKey } from "../../library-api";
import type { Library } from "./store";
import { isUnwatched } from "./store";
import { isInProgress } from "../../queue";

/** Pure grouping and sorting for the library pages. */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const byName = (a: string, b: string) => collator.compare(a, b);

/** 0 = not started, 1 = in progress, 2 = finished. */
function watchRank(lib: Library, path: string): number {
  const position = lib.positionOf(path);
  if (isUnwatched(position)) return 0;
  return isInProgress(position) ? 1 : 2;
}

export function sortVideos<T extends { name: string; path: string; mtime: number; duration?: number }>(videos: T[], sort: SortKey, lib: Library): T[] {
  const list = [...videos];
  switch (sort) {
    case "recent": return list.sort((a, b) => b.mtime - a.mtime || byName(a.name, b.name));
    case "duration": return list.sort((a, b) => lib.durationOf(b) - lib.durationOf(a) || byName(a.name, b.name));
    case "unwatched": return list.sort((a, b) => watchRank(lib, a.path) - watchRank(lib, b.path) || byName(a.name, b.name));
    default: return list.sort((a, b) => byName(a.name, b.name));
  }
}

export function sortFolders(folders: LibFolder[], sort: SortKey, lib: Library): LibFolder[] {
  const list = [...folders];
  const unwatched = (f: LibFolder) => f.videos.filter((v) => isUnwatched(lib.positionOf(v.path))).length;
  const total = (f: LibFolder) => f.videos.reduce((sum, v) => sum + lib.durationOf(v), 0);
  switch (sort) {
    case "name": return list.sort((a, b) => byName(a.name, b.name));
    case "duration": return list.sort((a, b) => total(b) - total(a) || byName(a.name, b.name));
    case "unwatched": return list.sort((a, b) => unwatched(b) - unwatched(a) || b.latest - a.latest);
    default: return list.sort((a, b) => b.latest - a.latest);
  }
}

/** The newest video of a folder, which gives the folder its picture. */
export function newestVideo(folder: LibFolder | { videos: LibVideo[] }): LibVideo | undefined {
  return folder.videos.reduce<LibVideo | undefined>((best, v) => (!best || v.mtime > best.mtime ? v : best), undefined);
}

export function sortSongs(songs: Song[], sort: SortKey): Song[] {
  const list = [...songs];
  switch (sort) {
    case "artist": return list.sort((a, b) => byName(a.artist || "~", b.artist || "~") || byName(a.album, b.album) || a.track - b.track || byName(a.title, b.title));
    case "recent": return list.sort((a, b) => b.mtime - a.mtime || byName(a.title, b.title));
    case "duration": return list.sort((a, b) => b.duration - a.duration || byName(a.title, b.title));
    default: return list.sort((a, b) => byName(a.title, b.title));
  }
}

export interface Album {
  key: string;
  name: string;
  artist: string;
  year: number;
  songs: Song[];
  cover: string | null;
  duration: number;
  latest: number;
  /** The tags had no album; the folder stands in for it. */
  fromFolder: boolean;
}

export interface Artist {
  name: string;
  albums: Album[];
  songs: Song[];
  cover: string | null;
}

export interface Genre {
  name: string;
  songs: Song[];
  cover: string | null;
}

export interface MusicModel {
  albums: Album[];
  artists: Artist[];
  genres: Genre[];
}

export const UNKNOWN_ARTIST = "Unknown artist";
export const UNKNOWN_GENRE = "Unknown genre";

export const artistOf = (song: Song) => song.albumArtist || song.artist || UNKNOWN_ARTIST;

/** The key of the album a song belongs to (see `buildMusic`). */
export function albumKeyOf(song: Song): string {
  return song.album ? `${(song.albumArtist || song.artist).toLowerCase()}\u0000${song.album.toLowerCase()}` : `folder\u0000${dirname(song.path)}`;
}

/** Groups songs into albums (by album tag and artist, else by folder), artists and genres. */
export function buildMusic(songs: Song[]): MusicModel {
  const albums = new Map<string, Album>();
  for (const song of songs) {
    const fromFolder = !song.album;
    const key = albumKeyOf(song);
    let album = albums.get(key);
    if (!album) {
      album = {
        key, fromFolder, songs: [], cover: null, duration: 0, latest: 0, year: 0,
        name: fromFolder ? basename(dirname(song.path)) : song.album,
        artist: fromFolder ? song.artist : song.albumArtist || song.artist,
      };
      albums.set(key, album);
    }
    album.songs.push(song);
    album.cover ??= song.cover;
    album.duration += song.duration;
    album.latest = Math.max(album.latest, song.mtime);
    album.year ||= song.year;
  }
  for (const album of albums.values()) {
    album.songs.sort((a, b) => (a.track || 1e6) - (b.track || 1e6) || byName(a.title, b.title));
  }

  const artists = new Map<string, Artist>();
  for (const album of albums.values()) {
    const name = album.artist || UNKNOWN_ARTIST;
    let artist = artists.get(name.toLowerCase());
    if (!artist) {
      artist = { name, albums: [], songs: [], cover: null };
      artists.set(name.toLowerCase(), artist);
    }
    artist.albums.push(album);
    artist.songs.push(...album.songs);
    artist.cover ??= album.cover;
  }

  const genres = new Map<string, Genre>();
  for (const song of songs) {
    const name = song.genre || UNKNOWN_GENRE;
    let genre = genres.get(name.toLowerCase());
    if (!genre) {
      genre = { name, songs: [], cover: null };
      genres.set(name.toLowerCase(), genre);
    }
    genre.songs.push(song);
    genre.cover ??= song.cover;
  }
  return {
    albums: [...albums.values()],
    artists: [...artists.values()].map((a) => ({ ...a, albums: a.albums.sort((x, y) => y.year - x.year || byName(x.name, y.name)) })),
    genres: [...genres.values()],
  };
}

export function sortAlbums(albums: Album[], sort: SortKey): Album[] {
  const list = [...albums];
  switch (sort) {
    case "artist": return list.sort((a, b) => byName(a.artist || "~", b.artist || "~") || byName(a.name, b.name));
    case "year": return list.sort((a, b) => b.year - a.year || byName(a.name, b.name));
    case "recent": return list.sort((a, b) => b.latest - a.latest);
    default: return list.sort((a, b) => byName(a.name, b.name));
  }
}

export function sortGroups<T extends { name: string; songs: Song[] }>(groups: T[], sort: SortKey): T[] {
  const list = [...groups];
  return sort === "count" ? list.sort((a, b) => b.songs.length - a.songs.length || byName(a.name, b.name)) : list.sort((a, b) => byName(a.name, b.name));
}
