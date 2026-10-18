import type { ShellContext } from "../../../../shell/module";
import { basename, dirname, stripExtension } from "../../../../ui/dom";
import { openMenu, type MenuItem } from "../../../../ui/menu";
import { videoApi, type VideoFile } from "../../api";
import { featureSettings } from "../../extensions";
import {
  LIBRARY_DEFAULTS, libraryApi, onMusicLibrary, onVideoLibrary, setLibraryService,
  type Channel, type LibFolder, type LibVideo, type LibrarySettings, type LibraryService, type MediaInfo, type Pin, type PinKind, type Playlist,
  type PlaylistItem, type SavedStream, type Song,
} from "../../library-api";
import type { Player } from "../../player";
import { isFinished, isInProgress, progressOf } from "../../queue";
import { askName } from "./widgets";

const AUDIO_EXTENSIONS = ["mp3", "ogg", "oga", "opus", "flac", "wav", "m4a", "aac", "wma", "aiff", "aif", "mka"];

export const isUrl = (path: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
export const isAudioPath = (path: string) => !isUrl(path) && AUDIO_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** A readable name for a stream address: its last path segment, or its host. */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segment = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return stripExtension(segment) || u.host || url;
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Whether a video counts as not watched yet. */
export const isUnwatched = (position: Parameters<typeof isInProgress>[0]) => !isInProgress(position) && !isFinished(position);

/**
 * The media library: data (video folders, songs, stream playlists), the user's playlists, streams
 * and pins, and the actions on them. One instance per module; pages and the sidebar share it and
 * redraw when it reports a change.
 */
export class Library implements LibraryService {
  private static instance: Library | null = null;

  /** The library of this module, created on first use. */
  static of(shell: ShellContext, player: Player): Library {
    if (!Library.instance || Library.instance.shell !== shell || Library.instance.player !== player) Library.instance = new Library(shell, player);
    return Library.instance;
  }

  readonly settings: LibrarySettings;
  /** Folders of the video library, null until the cached scan has loaded. */
  folders: LibFolder[] | null = null;
  songs: Song[] | null = null;
  scanningVideos = false;
  scanningMusic = false;
  /** Plays a file; the Video module replaces it with its own `play` (which also shows the player). */
  playFn: (path: string, queue?: string[]) => void;

  private readonly listeners = new Set<() => void>();
  private readonly infos = new Map<string, MediaInfo>();
  private readonly infoWanted = new Set<string>();
  private infoBusy = false;
  private readonly folderListings = new Map<string, LibVideo[]>();
  private readonly folderLoading = new Set<string>();
  private readonly channelLists = new Map<string, PlaylistItem[]>();
  private readonly channelLoading = new Set<string>();
  private readonly labels = new Map<string, string>();
  private songIndex = new Map<string, Song>();
  private loadedVideos = false;
  private loadedMusic = false;
  private notifyTimer = 0;
  private disposers: (() => void)[] = [];

  private constructor(private readonly shell: ShellContext, readonly player: Player) {
    this.settings = featureSettings(shell, "library", structuredClone(LIBRARY_DEFAULTS));
    // Arrays and maps the defaults share would otherwise be mutated across profiles.
    for (const key of ["playlists", "streams", "pinned"] as const) if (!Array.isArray(this.settings[key])) this.settings[key] = [];
    if (typeof this.settings.views !== "object" || !this.settings.views) this.settings.views = {};
    if (typeof this.settings.sorts !== "object" || !this.settings.sorts) this.settings.sorts = {};
    this.playFn = (path, queue) => void player.open(path, queue);
    setLibraryService(this);
  }

  dispose() {
    for (const d of this.disposers) d();
    this.disposers = [];
    clearTimeout(this.notifyTimer);
    this.listeners.clear();
    if (Library.instance === this) Library.instance = null;
    setLibraryService(null);
  }

  // ---- change notification -------------------------------------------------------------------

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tells listeners something changed; `soon` batches bursts (tags arriving) into one redraw. */
  private changed(soon = false) {
    if (soon) {
      if (this.notifyTimer) return;
      this.notifyTimer = window.setTimeout(() => {
        this.notifyTimer = 0;
        for (const fn of this.listeners) fn();
      }, 120);
      return;
    }
    for (const fn of this.listeners) fn();
  }

  save() {
    this.shell.saveConfig();
  }

  /** Settings or pins changed: persist and redraw. */
  commit() {
    this.save();
    this.changed();
  }

  // ---- library data --------------------------------------------------------------------------

  /** Loads the last scan, then rescans in the background (once per launch unless `force`). */
  ensureVideos(force = false) {
    if (this.loadedVideos && !force) return;
    const first = !this.loadedVideos;
    this.loadedVideos = true;
    if (first) {
      void onVideoLibrary((folders) => {
        this.folders = folders;
        this.folderListings.clear();
        this.scanningVideos = false;
        this.changed(true);
      }).then((off) => this.disposers.push(off)).catch((err) => console.warn("Could not listen for the video library:", err));
      void libraryApi.videoLibrary().then((folders) => {
        if (!this.folders) this.folders = folders;
        this.changed();
      }).catch((err) => {
        console.warn("Could not read the video library:", err);
        this.folders ??= [];
        this.changed();
      });
    }
    this.scanningVideos = true;
    this.changed();
    void libraryApi.refreshVideos().catch((err) => console.warn("Could not scan for videos:", err));
    // The scan reports its end by sending the list; this is the fallback when nothing changed.
    window.setTimeout(() => {
      this.scanningVideos = false;
      this.changed();
    }, 20000);
  }

  ensureMusic(force = false) {
    if (this.loadedMusic && !force) return;
    const first = !this.loadedMusic;
    this.loadedMusic = true;
    if (first) {
      void onMusicLibrary((songs) => {
        this.setSongs(songs);
        this.scanningMusic = false;
        this.changed(true);
      }).then((off) => this.disposers.push(off)).catch((err) => console.warn("Could not listen for the music library:", err));
      void libraryApi.musicLibrary().then((songs) => {
        if (!this.songs) this.setSongs(songs);
        this.changed();
      }).catch((err) => {
        console.warn("Could not read the music library:", err);
        this.setSongs(this.songs ?? []);
        this.changed();
      });
    }
    this.scanningMusic = true;
    this.changed();
    void libraryApi.refreshMusic().catch((err) => console.warn("Could not scan for music:", err));
    window.setTimeout(() => {
      this.scanningMusic = false;
      this.changed();
    }, 30000);
  }

  private setSongs(songs: Song[]) {
    this.songs = songs;
    this.songIndex = new Map(songs.map((s) => [s.path, s]));
  }

  songAt(path: string): Song | undefined {
    return this.songIndex.get(path);
  }

  /** The cover image file of a song or an opened audio file, if known. */
  coverOf(path: string): string | null {
    return this.songIndex.get(path)?.cover ?? this.infos.get(path)?.cover ?? null;
  }

  /** The videos of a folder: the live listing once fetched, else the library's. */
  folderVideos(path: string): LibVideo[] | null {
    return this.folderListings.get(path) ?? this.folders?.find((f) => f.path === path)?.videos ?? null;
  }

  /**
   * Lists a folder from disk (fresh, and for folders the library hasn't found). Pages call this
   * while rendering, so it lists each folder once; a new library scan makes them list again.
   */
  loadFolder(path: string) {
    if (this.folderLoading.has(path) || this.folderListings.has(path)) return;
    this.folderLoading.add(path);
    void videoApi.listVideos(path).then((files: VideoFile[]) => {
      const known = new Map((this.folders?.find((f) => f.path === path)?.videos ?? []).map((v) => [v.path, v]));
      this.folderListings.set(path, files.map((f) => ({
        name: f.name, path: f.path, size: f.size, mtime: f.mtime,
        duration: known.get(f.path)?.duration ?? 0, width: known.get(f.path)?.width ?? 0, height: known.get(f.path)?.height ?? 0,
      })));
      this.wantInfo(files.map((f) => f.path));
    }).catch((err) => {
      console.warn("Could not list videos:", err);
      this.folderListings.set(path, []);
    }).finally(() => {
      this.folderLoading.delete(path);
      this.changed();
    });
  }

  /** Duration in ms of a video, from the library or the info fetched for it (0 if unknown). */
  durationOf(video: { path: string; duration?: number }): number {
    return video.duration || this.infos.get(video.path)?.duration || 0;
  }

  info(path: string): MediaInfo | undefined {
    return this.infos.get(path);
  }

  /** Asks the backend for durations/tags of these files (batched; redraws as they arrive). */
  wantInfo(paths: string[]) {
    for (const p of paths) if (!this.infos.has(p) && !isUrl(p)) this.infoWanted.add(p);
    void this.pumpInfo();
  }

  private async pumpInfo() {
    if (this.infoBusy) return;
    this.infoBusy = true;
    try {
      while (this.infoWanted.size > 0) {
        const batch = [...this.infoWanted].slice(0, 16);
        for (const p of batch) this.infoWanted.delete(p);
        try {
          const found = await libraryApi.meta(batch);
          batch.forEach((p, i) => this.infos.set(p, found[i]));
        } catch (err) {
          console.warn("Could not read media info:", err);
          for (const p of batch) this.infos.set(p, { duration: 0, width: 0, height: 0, hasVideo: false, title: "", artist: "", album: "", albumArtist: "", genre: "", year: 0, track: 0, cover: null });
        }
        this.changed(true);
      }
    } finally {
      this.infoBusy = false;
    }
  }

  // ---- names ---------------------------------------------------------------------------------

  /** What to call a file or stream in lists. */
  label(path: string): string {
    const song = this.songIndex.get(path);
    if (song) return song.title;
    const named = this.labels.get(path);
    if (named) return named;
    const info = this.infos.get(path);
    if (info?.title && isAudioPath(path)) return info.title;
    return isUrl(path) ? nameFromUrl(path) : stripExtension(basename(path));
  }

  /** The second line for a queue/list row: artist, folder or address. */
  sublabel(path: string): string {
    const song = this.songIndex.get(path);
    if (song) return song.artist;
    if (this.labels.has(path)) return this.groups.get(path) ?? "";
    const info = this.infos.get(path);
    if (info?.artist) return info.artist;
    return isUrl(path) ? hostOf(path) : basename(dirname(path));
  }

  private readonly groups = new Map<string, string>();

  remember(items: { path: string; name?: string; group?: string }[]) {
    for (const item of items) {
      if (item.name) this.labels.set(item.path, item.name);
      if (item.group) this.groups.set(item.path, item.group);
    }
  }

  // ---- playing and the queue -----------------------------------------------------------------

  playAll(paths: string[], start = 0) {
    const path = paths[start];
    if (path) this.playFn(path, paths);
  }

  playNext(paths: string[]) {
    this.player.playNext(paths);
  }

  addToQueue(paths: string[]) {
    this.player.enqueue(paths);
  }

  // ---- playlists -----------------------------------------------------------------------------

  playlist(id: string): Playlist | undefined {
    return this.settings.playlists.find((p) => p.id === id);
  }

  createPlaylist(name: string, items: PlaylistItem[] = []): string {
    const playlist: Playlist = { id: newId(), name: name.trim() || "Playlist", items: dedupe(items), created: Date.now() };
    this.settings.playlists.push(playlist);
    this.remember(playlist.items);
    this.commit();
    return playlist.id;
  }

  renamePlaylist(id: string, name: string) {
    const playlist = this.playlist(id);
    if (!playlist || !name.trim()) return;
    playlist.name = name.trim();
    this.syncPin("playlist", id, playlist.name);
    this.commit();
  }

  deletePlaylist(id: string) {
    const playlist = this.playlist(id);
    if (!playlist) return;
    this.settings.playlists = this.settings.playlists.filter((p) => p.id !== id);
    this.settings.pinned = this.settings.pinned.filter((p) => !(p.kind === "playlist" && p.id === id));
    this.channelLists.delete(id);
    if (playlist.source) void libraryApi.forgetChannels(id).catch(() => undefined);
    this.commit();
  }

  addToPlaylistById(id: string, paths: string[]) {
    const playlist = this.playlist(id);
    if (!playlist || playlist.source) return;
    const items = paths.map((path) => ({ path, name: this.nameFor(path) }));
    playlist.items = dedupe([...playlist.items, ...items]);
    this.remember(playlist.items);
    this.commit();
  }

  /** A name worth storing with a playlist item: only for streams, whose address says little. */
  private nameFor(path: string): string | undefined {
    return isUrl(path) ? this.label(path) : undefined;
  }

  removeFromPlaylist(id: string, index: number) {
    const playlist = this.playlist(id);
    if (!playlist || playlist.source) return;
    playlist.items = playlist.items.filter((_, i) => i !== index);
    this.commit();
  }

  /** Moves an item so it lands before the one at `to` (`to` may be the length). */
  moveInPlaylist(id: string, from: number, to: number) {
    const playlist = this.playlist(id);
    if (!playlist || playlist.source || from < 0 || from >= playlist.items.length) return;
    const target = Math.min(Math.max(to, 0), playlist.items.length);
    const [item] = playlist.items.splice(from, 1);
    playlist.items.splice(target > from ? target - 1 : target, 0, item);
    this.commit();
  }

  insertInPlaylist(id: string, paths: string[], at: number) {
    const playlist = this.playlist(id);
    if (!playlist || playlist.source) return;
    const items = paths.map((path) => ({ path, name: this.nameFor(path) }));
    const fresh = items.filter((i) => !playlist.items.some((p) => p.path === i.path));
    playlist.items.splice(Math.min(Math.max(at, 0), playlist.items.length), 0, ...fresh);
    this.remember(fresh);
    this.commit();
  }

  /** The items of a playlist; an IPTV playlist loads its channels from disk first (null until then). */
  itemsOf(playlist: Playlist): PlaylistItem[] | null {
    if (!playlist.source) return playlist.items;
    const cached = this.channelLists.get(playlist.id);
    if (cached) return cached;
    if (!this.channelLoading.has(playlist.id)) {
      this.channelLoading.add(playlist.id);
      void libraryApi.channels(playlist.id).then((channels: Channel[]) => {
        const items = channels.map((c) => ({ path: c.url, name: c.name, logo: c.logo, group: c.group }));
        this.remember(items);
        this.channelLists.set(playlist.id, items);
      }).catch((err) => {
        console.warn("Could not load the channels:", err);
        this.channelLists.set(playlist.id, []);
      }).finally(() => {
        this.channelLoading.delete(playlist.id);
        this.changed();
      });
    }
    return null;
  }

  /** Plays a playlist from the first item (or `start`), optionally shuffled. */
  playPlaylist(playlist: Playlist, start = 0, shuffle = false) {
    const items = this.itemsOf(playlist);
    if (!items?.length) return;
    this.remember(items);
    const paths = items.map((i) => i.path);
    if (shuffle) this.player.shuffle = true;
    this.playAll(paths, shuffle ? Math.floor(Math.random() * paths.length) : start);
  }

  // ---- streams -------------------------------------------------------------------------------

  streamById(id: string): SavedStream | undefined {
    return this.settings.streams.find((s) => s.id === id);
  }

  /** Saves a stream, or turns an IPTV/M3U playlist address into a playlist of channels. */
  async addStream(url: string, name?: string): Promise<{ kind: "stream" | "playlist"; id: string }> {
    const address = url.trim();
    const existing = this.settings.streams.find((s) => s.url === address);
    if (existing) return { kind: "stream", id: existing.id };
    const id = newId();
    const result = await libraryApi.importStream(address, id);
    if (result.kind === "playlist") {
      const playlist: Playlist = {
        id, name: name?.trim() || result.title || nameFromUrl(address), items: [], created: Date.now(), source: address, channelCount: result.count,
      };
      this.settings.playlists.push(playlist);
      this.commit();
      return { kind: "playlist", id };
    }
    const stream: SavedStream = { id, name: name?.trim() || nameFromUrl(address), url: address, added: Date.now() };
    this.settings.streams.push(stream);
    this.labels.set(stream.url, stream.name);
    this.commit();
    return { kind: "stream", id };
  }

  renameStream(id: string, name: string) {
    const stream = this.streamById(id);
    if (!stream || !name.trim()) return;
    stream.name = name.trim();
    this.labels.set(stream.url, stream.name);
    this.syncPin("stream", id, stream.name);
    this.commit();
  }

  deleteStream(id: string) {
    this.settings.streams = this.settings.streams.filter((s) => s.id !== id);
    this.settings.pinned = this.settings.pinned.filter((p) => !(p.kind === "stream" && p.id === id));
    this.commit();
  }

  /** Re-downloads an IPTV playlist. */
  async refreshPlaylist(id: string) {
    const playlist = this.playlist(id);
    if (!playlist?.source) return;
    const result = await libraryApi.importStream(playlist.source, id, true);
    if (result.kind !== "playlist") throw new Error("That address isn't a playlist any more.");
    playlist.channelCount = result.count;
    this.channelLists.delete(id);
    this.commit();
  }

  // ---- pins ----------------------------------------------------------------------------------

  isPinned(kind: PinKind, id: string): boolean {
    return this.settings.pinned.some((p) => p.kind === kind && p.id === id);
  }

  togglePin(kind: PinKind, id: string, name: string) {
    const at = this.settings.pinned.findIndex((p) => p.kind === kind && p.id === id);
    if (at >= 0) this.settings.pinned.splice(at, 1);
    else this.settings.pinned.push({ kind, id, name });
    this.commit();
  }

  private syncPin(kind: PinKind, id: string, name: string) {
    const pin: Pin | undefined = this.settings.pinned.find((p) => p.kind === kind && p.id === id);
    if (pin) pin.name = name;
  }

  // ---- menus ---------------------------------------------------------------------------------

  /** Play Next / Add to Queue / Add to Playlist for these files, for any menu. */
  itemMenu(paths: string[]): MenuItem[] {
    const when = paths.length === 0;
    return [
      { label: "Play Next", icon: "next", disabled: when, action: () => this.playNext(paths) },
      { label: "Add to Queue", icon: "playlist", disabled: when, action: () => this.addToQueue(paths) },
      { label: "Add to Playlist…", icon: "plus", disabled: when, action: () => this.addToPlaylistAt(paths) },
    ];
  }

  private addToPlaylistAt(paths: string[]) {
    // Opened from a menu item: the menu is gone, so put the next one near where it was.
    this.addToPlaylist(paths, Math.max(80, innerWidth / 2 - 100), Math.max(80, innerHeight / 3));
  }

  addToPlaylist(paths: string[], x: number, y: number) {
    if (paths.length === 0) return;
    const own = this.settings.playlists.filter((p) => !p.source);
    openMenu(x, y, [
      ...own.map((p): MenuItem => ({ label: p.name, icon: "playlist", action: () => this.addToPlaylistById(p.id, paths) })),
      ...(own.length ? ["separator" as const] : []),
      { label: "New Playlist…", icon: "plus", action: () => void this.newPlaylistWith(paths) },
    ]);
  }

  /** Asks for a name and creates a playlist holding `paths`. */
  async newPlaylistWith(paths: string[] = []): Promise<string | null> {
    const name = await askName({ title: "New Playlist", label: "Name", value: "", confirm: "Create", placeholder: "My playlist" });
    if (name === null) return null;
    return this.createPlaylist(name, paths.map((path) => ({ path, name: this.nameFor(path) })));
  }

  // ---- progress helpers used by the pages ------------------------------------------------------

  /** The Video module's settings (resume points, recent files). */
  get video() {
    return this.shell.config.video;
  }

  progress(path: string): number {
    return progressOf(this.shell.config.video.positions[path]);
  }

  positionOf(path: string) {
    return this.shell.config.video.positions[path];
  }

  /** Watched state of a folder's videos: how many are not started and the total length known. */
  folderStats(videos: LibVideo[]): { count: number; duration: number; unwatched: number; durationKnown: boolean } {
    let duration = 0;
    let unwatched = 0;
    let known = true;
    for (const v of videos) {
      const d = this.durationOf(v);
      if (d) duration += d;
      else known = false;
      if (isUnwatched(this.positionOf(v.path))) unwatched++;
    }
    return { count: videos.length, duration, unwatched, durationKnown: known };
  }
}

function dedupe(items: PlaylistItem[]): PlaylistItem[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.path) && !!seen.add(i.path));
}
