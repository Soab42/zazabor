import { basename, dirname, h, stripExtension } from "../../../../ui/dom";
import { icon, type IconName } from "../../../../ui/icons";
import { openMenu } from "../../../../ui/menu";
import { formatTime } from "../../format";
import type { Song } from "../../library-api";
import { isFinished, isInProgress, progressOf } from "../../queue";
import { pathArt } from "./art";
import { draggable } from "./dnd";
import { sortSongs, sortVideos } from "./model";
import { SORT_LABELS } from "./page";
import { isAudioPath, isUrl, type Library } from "./store";
import { actionButton, art, coverUrl, plural, renderChunked, row, videoThumb } from "./widgets";

/**
 * The compact library beside the video: videos by folder, music, playlists and streams, in a
 * narrow list. Every item can be dragged into the queue (see `QueueDock`), added with its "+"
 * button, or played; none of that stops what is playing.
 */

type Source = "videos" | "music" | "playlists" | "streams";
type Nav = { src: "videos"; folder?: string } | { src: "music" } | { src: "playlists"; id?: string } | { src: "streams" };

const SOURCES: { id: Source; label: string; icon: IconName }[] = [
  { id: "videos", label: "Videos", icon: "video" },
  { id: "music", label: "Music", icon: "music" },
  { id: "playlists", label: "Playlists", icon: "playlist" },
  { id: "streams", label: "Streams", icon: "network" },
];

const same = (a: Nav, b: Nav) => JSON.stringify(a) === JSON.stringify(b);

/** The folders to show as breadcrumbs: the last `count` segments of a path, each with its full path. */
export function trail(folder: string, count = 2): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  let path = folder;
  while (out.length < count && path) {
    out.unshift({ name: basename(path), path });
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  return out;
}

export class CompactLibrary {
  readonly el = h("div", { class: "lib-compact" });
  private readonly back = h("button", { class: "icon-btn small", type: "button", title: "Back", "aria-label": "Back" }, icon("chevronLeft", 16));
  private readonly forward = h("button", { class: "icon-btn small", type: "button", title: "Forward", "aria-label": "Forward" }, icon("chevronRight", 16));
  private readonly crumbs = h("div", { class: "lib-crumbs" });
  private readonly count = h("span", { class: "lib-count" });
  private readonly sources = h("div", { class: "segmented lib-sources", role: "tablist" });
  private readonly searchBox = h("input", { class: "lib-search-input", type: "text", placeholder: "Filter", spellcheck: false, autocomplete: "off", "aria-label": "Filter" });
  private readonly searchRow = h("div", { class: "lib-compact-search", hidden: true }, this.searchBox);
  private readonly list = h("div", { class: "lib-list compact" });
  private readonly sortButton = h("button", { class: "icon-btn small", type: "button", title: "Sort", "aria-label": "Sort" }, icon("sort", 16));
  private history: Nav[] = [{ src: "videos" }];
  private cursor = 0;
  /** The user has moved around here, so the folder of the playing file no longer steals the view. */
  private userNav = false;
  private current: string | null = null;

  constructor(private readonly lib: Library, private readonly hooks: { play(path: string, queue: string[]): void }) {
    this.back.addEventListener("click", () => this.step(-1));
    this.forward.addEventListener("click", () => this.step(1));
    this.sortButton.addEventListener("click", () => this.sortMenu());
    const searchButton = h("button", { class: "icon-btn small", type: "button", title: "Filter", "aria-label": "Filter" }, icon("search", 16));
    searchButton.addEventListener("click", () => {
      this.searchRow.hidden = !this.searchRow.hidden;
      if (this.searchRow.hidden) this.searchBox.value = "";
      else this.searchBox.focus();
      this.render();
    });
    this.searchBox.addEventListener("input", () => this.render());
    this.searchBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        searchButton.click();
      }
    });
    this.el.append(
      h("div", { class: "lib-compact-head" }, this.back, this.forward, this.crumbs),
      this.sources,
      h("div", { class: "lib-compact-count" }, this.count, this.sortButton, searchButton),
      this.searchRow,
      this.list,
    );
    lib.onChange(() => this.render(true));
    this.updateNav();
    this.render();
  }

  private get nav(): Nav {
    return this.history[this.cursor];
  }

  /** The folder being shown, for the module (empty when not on a folder). */
  get browsing(): string {
    const nav = this.nav;
    return nav.src === "videos" ? nav.folder ?? "" : "";
  }

  setCurrent(path: string | null) {
    this.current = path;
    this.render(true);
  }

  /** Shows a folder; `explicit` is a request from the user rather than the playing file changing. */
  browse(folder: string, explicit = true) {
    if (!folder || isUrl(folder)) return;
    if (!explicit && (this.userNav || (this.current && isAudioPath(this.current)))) return;
    this.go({ src: "videos", folder }, explicit);
  }

  private go(nav: Nav, user = true) {
    if (user) this.userNav = true;
    if (!same(nav, this.nav)) {
      this.history = [...this.history.slice(0, this.cursor + 1), nav];
      this.cursor = this.history.length - 1;
    }
    this.searchBox.value = "";
    this.updateNav();
    this.render();
    this.list.scrollTop = 0;
  }

  private step(delta: number) {
    const to = this.cursor + delta;
    if (to < 0 || to >= this.history.length) return;
    this.cursor = to;
    this.userNav = true;
    this.updateNav();
    this.render();
  }

  private updateNav() {
    this.back.disabled = this.cursor <= 0;
    this.forward.disabled = this.cursor >= this.history.length - 1;
    const nav = this.nav;
    this.sources.replaceChildren(...SOURCES.map((s) => {
      const b = h("button", { type: "button", role: "tab", class: s.id === nav.src ? "active" : "", title: s.label, "aria-selected": String(s.id === nav.src) }, icon(s.icon, 14), h("span", null, s.label));
      b.addEventListener("click", () => this.go({ src: s.id } as Nav));
      return b;
    }));
    const parts: { label: string; nav: Nav }[] = [];
    if (nav.src === "videos") {
      parts.push({ label: "Videos", nav: { src: "videos" } });
      if (nav.folder) parts.push({ label: basename(nav.folder), nav });
    } else if (nav.src === "playlists") {
      parts.push({ label: "Playlists", nav: { src: "playlists" } });
      if (nav.id) parts.push({ label: this.lib.playlist(nav.id)?.name ?? "Playlist", nav });
    } else {
      parts.push({ label: nav.src === "music" ? "Music" : "Network Streams", nav });
    }
    this.crumbs.replaceChildren(...parts.flatMap((part, i) => {
      const last = i === parts.length - 1;
      const item = h("button", { class: `lib-crumb${last ? " current" : ""}`, type: "button", title: part.label }, part.label);
      item.addEventListener("click", () => this.go(part.nav));
      return i === 0 ? [item] : [h("span", { class: "lib-crumb-sep", "aria-hidden": "true" }, icon("chevronRight", 11)), item];
    }));
    const sorts = nav.src === "videos" && nav.folder;
    this.sortButton.hidden = !sorts && nav.src !== "music";
  }

  private sortKey() {
    return this.lib.settings.sorts[this.nav.src === "music" ? "compact-music" : "compact-folder"] ?? "name";
  }

  private sortMenu() {
    const r = this.sortButton.getBoundingClientRect();
    const music = this.nav.src === "music";
    const keys = music ? (["name", "artist", "recent", "duration"] as const) : (["name", "recent", "duration", "unwatched"] as const);
    const storeKey = music ? "compact-music" : "compact-folder";
    openMenu(r.left, r.bottom + 4, keys.map((key) => ({
      label: SORT_LABELS[key], icon: this.sortKey() === key ? ("check" as const) : undefined,
      action: () => {
        this.lib.settings.sorts[storeKey] = key;
        this.lib.save();
        this.render();
      },
    })));
  }

  /** Redraws the list; `soft` keeps the scroll position (data arrived, playing item changed). */
  render(soft = false) {
    if (soft && !this.el.isConnected) return;
    const query = this.searchBox.value.trim().toLowerCase();
    const scroll = this.list.scrollTop;
    const container = this.list;
    container.replaceChildren();
    const nav = this.nav;
    switch (nav.src) {
      case "videos": nav.folder ? this.folderRows(nav.folder, query) : this.folderList(query); break;
      case "music": this.musicRows(query); break;
      case "playlists": nav.id ? this.playlistRows(nav.id, query) : this.playlistList(query); break;
      default: this.streamRows(query);
    }
    if (soft) container.scrollTop = scroll;
    else if (nav.src === "videos" && nav.folder) container.querySelector(".playing")?.scrollIntoView({ block: "nearest" });
  }

  private note(text: string) {
    this.list.replaceChildren(h("div", { class: "lib-list-empty" }, text));
  }

  private play(path: string, queue: string[]) {
    this.hooks.play(path, queue);
  }

  /** Makes a row draggable into the queue, carrying `paths`. */
  private drag(el: HTMLElement, paths: () => string[], label: string) {
    draggable(el, () => {
      const p = paths();
      return p.length ? { paths: p, label: p.length > 1 ? `${label} (${p.length})` : label } : null;
    });
    return el;
  }

  private folderList(query: string) {
    const { lib } = this;
    lib.ensureVideos();
    const folders = (lib.folders ?? []).filter((f) => !query || f.name.toLowerCase().includes(query));
    this.count.textContent = plural(folders.length, "folder");
    if (lib.folders === null) return this.note("Looking for your videos…");
    if (folders.length === 0) return this.note(query ? "No matches" : "No videos found");
    renderChunked(this.list, folders, (f) => {
      const newest = f.videos.reduce((best, v) => (v.mtime > best.mtime ? v : best), f.videos[0]);
      const paths = () => f.videos.map((v) => v.path);
      return this.drag(row({
        art: art({ src: videoThumb(newest.path, newest.mtime, 96), icon: "folder", iconSize: 14 }),
        title: f.name, subtitle: plural(f.videos.length, "video"),
        onOpen: () => this.go({ src: "videos", folder: f.path }),
        onMenu: (x, y) => openMenu(x, y, [
          { label: "Open", icon: "folder", action: () => this.go({ src: "videos", folder: f.path }) },
          ...lib.itemMenu(paths()),
        ]),
        actions: [actionButton("playlist", "Add folder to queue", () => lib.addToQueue(paths()))],
      }), paths, f.name);
    });
  }

  private folderRows(folder: string, query: string) {
    const { lib } = this;
    lib.loadFolder(folder);
    const videos = lib.folderVideos(folder);
    if (videos === null) {
      this.count.textContent = "";
      return this.note("Loading…");
    }
    this.count.textContent = plural(videos.length, "item");
    if (videos.length === 0) return this.note("No videos in this folder");
    const sorted = sortVideos(videos, this.sortKey(), lib);
    const shown = query ? sorted.filter((v) => v.name.toLowerCase().includes(query)) : sorted;
    if (shown.length === 0) return this.note("No matches");
    const queue = sorted.map((v) => v.path);
    renderChunked(this.list, shown, (v) => {
      const position = lib.positionOf(v.path);
      const duration = lib.durationOf(v);
      return this.drag(row({
        art: art({ src: videoThumb(v.path, v.mtime, 96), icon: "film", iconSize: 14, progress: isInProgress(position) ? progressOf(position) : undefined }),
        title: stripExtension(v.name), meta: duration ? formatTime(duration) : "",
        playing: v.path === this.current, done: isFinished(position),
        onOpen: () => this.play(v.path, queue),
        onMenu: (x, y) => openMenu(x, y, [{ label: "Play", icon: "play", action: () => this.play(v.path, queue) }, ...lib.itemMenu([v.path])]),
        actions: [actionButton("playlist", "Add to queue", () => lib.addToQueue([v.path]))],
      }), () => [v.path], stripExtension(v.name));
    });
  }

  private songRow(song: Song, queue: string[]) {
    const { lib } = this;
    return this.drag(row({
      art: art({ src: song.cover ? coverUrl(song.cover, 96) : null, icon: "music", shape: "square", iconSize: 14 }),
      title: song.title, subtitle: song.artist || undefined, meta: song.duration ? formatTime(song.duration) : "",
      playing: song.path === this.current,
      onOpen: () => this.play(song.path, queue),
      onMenu: (x, y) => openMenu(x, y, [{ label: "Play", icon: "play", action: () => this.play(song.path, queue) }, ...lib.itemMenu([song.path])]),
      actions: [actionButton("playlist", "Add to queue", () => lib.addToQueue([song.path]))],
    }), () => [song.path], song.title);
  }

  private musicRows(query: string) {
    const { lib } = this;
    lib.ensureMusic();
    if (lib.songs === null) {
      this.count.textContent = "";
      return this.note("Looking for your music…");
    }
    const sorted = sortSongs(lib.songs, this.sortKey());
    const shown = query ? sorted.filter((s) => [s.title, s.artist, s.album].some((t) => t.toLowerCase().includes(query))) : sorted;
    this.count.textContent = plural(lib.songs.length, "song");
    if (shown.length === 0) return this.note(lib.songs.length === 0 ? "No music found" : "No matches");
    const queue = shown.map((s) => s.path);
    renderChunked(this.list, shown, (s) => this.songRow(s, queue));
  }

  private playlistList(query: string) {
    const { lib } = this;
    const all = lib.settings.playlists.filter((p) => !query || p.name.toLowerCase().includes(query));
    this.count.textContent = plural(lib.settings.playlists.length, "playlist");
    if (all.length === 0) return this.note(query ? "No matches" : "No playlists yet");
    this.list.replaceChildren(...all.map((p) => row({
      art: art({ icon: p.source ? "network" : "playlist", shape: "square", iconSize: 14 }),
      title: p.name, subtitle: p.source ? plural(p.channelCount ?? 0, "channel") : plural(p.items.length, "item"),
      onOpen: () => this.go({ src: "playlists", id: p.id }),
      onMenu: (x, y) => openMenu(x, y, [
        { label: "Open", icon: "playlist", action: () => this.go({ src: "playlists", id: p.id }) },
        { label: "Play", icon: "play", action: () => lib.playPlaylist(p) },
      ]),
    })));
  }

  private playlistRows(id: string, query: string) {
    const { lib } = this;
    const playlist = lib.playlist(id);
    if (!playlist) return this.note("Playlist not found");
    const items = lib.itemsOf(playlist);
    if (items === null) return this.note("Loading channels…");
    this.count.textContent = plural(items.length, playlist.source ? "channel" : "item");
    const shown = items.map((item, index) => ({ item, index })).filter(({ item }) => !query || lib.label(item.path).toLowerCase().includes(query));
    if (shown.length === 0) return this.note(items.length === 0 ? "This playlist is empty" : "No matches");
    const queue = items.map((i) => i.path);
    lib.remember(items);
    renderChunked(this.list, shown, ({ item }) => this.drag(row({
      art: pathArt(lib, item.path, 96, { iconSize: 14 }), title: lib.label(item.path), subtitle: item.group ?? lib.sublabel(item.path),
      playing: item.path === this.current,
      onOpen: () => this.play(item.path, queue),
      onMenu: (x, y) => openMenu(x, y, [{ label: "Play", icon: "play", action: () => this.play(item.path, queue) }, ...lib.itemMenu([item.path])]),
      actions: [actionButton("playlist", "Add to queue", () => lib.addToQueue([item.path]))],
    }), () => [item.path], lib.label(item.path)));
  }

  private streamRows(query: string) {
    const { lib } = this;
    const streams = lib.settings.streams.filter((s) => !query || s.name.toLowerCase().includes(query) || s.url.toLowerCase().includes(query));
    this.count.textContent = plural(lib.settings.streams.length, "stream");
    if (streams.length === 0) return this.note(query ? "No matches" : "No saved streams");
    const queue = streams.map((s) => s.url);
    this.list.replaceChildren(...streams.map((s) => this.drag(row({
      art: art({ icon: "network", shape: "square", iconSize: 14 }),
      title: s.name, subtitle: s.url, playing: s.url === this.current,
      onOpen: () => this.play(s.url, queue),
      onMenu: (x, y) => openMenu(x, y, [{ label: "Play", icon: "play", action: () => this.play(s.url, queue) }, ...lib.itemMenu([s.url])]),
      actions: [actionButton("playlist", "Add to queue", () => lib.addToQueue([s.url]))],
    }), () => [s.url], s.name)));
  }
}
