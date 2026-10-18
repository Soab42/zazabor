import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { openMenu } from "../../../../ui/menu";
import { formatTime } from "../../format";
import type { Song } from "../../library-api";
import { albumKeyOf, artistOf, buildMusic, sortAlbums, sortGroups, sortSongs, type Album, type Artist, type Genre, type MusicModel } from "./model";
import { MUSIC_TABS, type PageEnv, type PageResult } from "./page";
import { actionButton, art, card, coverUrl, emptyState, formatSpan, plural, renderChunked, row } from "./widgets";

/** Music: Songs / Albums / Artists / Genres, and the album, artist and genre pages. */

let cached: { songs: Song[]; model: MusicModel } | null = null;

function model(songs: Song[]): MusicModel {
  if (cached?.songs !== songs) cached = { songs, model: buildMusic(songs) };
  return cached.model;
}

const matches = (text: string, query: string) => !query || text.toLowerCase().includes(query);
const songMatches = (s: Song, q: string) => !q || [s.title, s.artist, s.album, s.albumArtist].some((t) => t.toLowerCase().includes(q));

const cover = (path: string | null, size: number) => (path ? coverUrl(path, size) : null);

function tabs(env: PageEnv, active: string): HTMLElement {
  const bar = h("div", { class: "segmented lib-tabs", role: "tablist" });
  for (const tab of MUSIC_TABS) {
    const b = h("button", { type: "button", role: "tab", class: tab.id === active ? "active" : "", "aria-selected": String(tab.id === active) }, tab.label);
    b.addEventListener("click", () => env.go({ section: "music", tab: tab.id }));
    bar.append(b);
  }
  return h("div", { class: "lib-tabs-row" }, bar);
}

function songMenu(env: PageEnv, x: number, y: number, song: Song, queue: string[]) {
  const { lib } = env;
  openMenu(x, y, [
    { label: "Play", icon: "play", action: () => lib.playAll(queue, Math.max(0, queue.indexOf(song.path))) },
    ...lib.itemMenu([song.path]),
    "separator",
    { label: "Go to Album", icon: "music", action: () => env.go({ section: "music", tab: "albums", album: albumKeyOf(song) }) },
    { label: "Go to Artist", icon: "music", action: () => env.go({ section: "music", tab: "artists", artist: artistOf(song) }) },
  ]);
}

function songRow(env: PageEnv, song: Song, queue: string[], lead?: string): HTMLElement {
  const { lib } = env;
  return row({
    lead,
    art: lead === undefined ? art({ src: cover(song.cover, 160), icon: "music", shape: "square", iconSize: 16 }) : undefined,
    title: song.title,
    subtitle: song.artist || undefined,
    columns: lead === undefined && song.album ? [song.album] : [],
    meta: song.duration ? formatTime(song.duration) : "",
    playing: lib.player.current === song.path,
    onOpen: () => lib.playAll(queue, Math.max(0, queue.indexOf(song.path))),
    onMenu: (x, y) => songMenu(env, x, y, song, queue),
    actions: [actionButton("playlist", "Add to Queue", () => lib.addToQueue([song.path]))],
  });
}

function songCard(env: PageEnv, song: Song, queue: string[]): HTMLElement {
  const { lib } = env;
  return card({
    art: art({ src: cover(song.cover, 400), icon: "music", shape: "square", iconSize: 34 }),
    title: song.title, subtitle: song.artist || song.album || undefined,
    playing: lib.player.current === song.path,
    onOpen: () => lib.playAll(queue, Math.max(0, queue.indexOf(song.path))),
    onMenu: (x, y) => songMenu(env, x, y, song, queue),
  });
}

function songList(env: PageEnv, songs: Song[], mode: "list" | "grid"): HTMLElement {
  const queue = songs.map((s) => s.path);
  const container = h("div", { class: mode === "grid" ? "lib-grid music" : "lib-list" });
  renderChunked(container, songs, (s) => (mode === "grid" ? songCard(env, s, queue) : songRow(env, s, queue)));
  return container;
}

function albumCard(env: PageEnv, album: Album): HTMLElement {
  return card({
    art: art({ src: cover(album.cover, 400), icon: "music", shape: "square", iconSize: 38 }),
    title: album.name,
    subtitle: album.artist || undefined,
    detail: [album.year || "", plural(album.songs.length, "song")].filter(Boolean).join(" · "),
    onOpen: () => env.go({ section: "music", tab: "albums", album: album.key }),
    onMenu: (x, y) => albumMenu(env, x, y, album),
  });
}

function albumMenu(env: PageEnv, x: number, y: number, album: Album) {
  const { lib } = env;
  const paths = album.songs.map((s) => s.path);
  openMenu(x, y, [
    { label: "Open", icon: "music", action: () => env.go({ section: "music", tab: "albums", album: album.key }) },
    { label: "Play", icon: "play", action: () => lib.playAll(paths) },
    ...lib.itemMenu(paths),
    "separator",
    { label: lib.isPinned("album", album.key) ? "Unpin from Sidebar" : "Pin to Sidebar", icon: "star", action: () => lib.togglePin("album", album.key, album.name) },
  ]);
}

function artistCard(env: PageEnv, artist: Artist): HTMLElement {
  return card({
    art: art({ src: cover(artist.cover, 300), icon: "music", shape: "circle", iconSize: 38 }),
    title: artist.name,
    subtitle: `${plural(artist.albums.length, "album")} · ${plural(artist.songs.length, "song")}`,
    onOpen: () => env.go({ section: "music", tab: "artists", artist: artist.name }),
    onMenu: (x, y) => {
      const paths = artist.songs.map((s) => s.path);
      openMenu(x, y, [
        { label: "Play", icon: "play", action: () => env.lib.playAll(paths) },
        ...env.lib.itemMenu(paths),
        "separator",
        { label: env.lib.isPinned("artist", artist.name) ? "Unpin from Sidebar" : "Pin to Sidebar", icon: "star", action: () => env.lib.togglePin("artist", artist.name, artist.name) },
      ]);
    },
  });
}

function genreCard(env: PageEnv, genre: Genre): HTMLElement {
  return card({
    art: art({ src: cover(genre.cover, 400), icon: "music", shape: "wide", iconSize: 34 }),
    title: genre.name,
    subtitle: plural(genre.songs.length, "song"),
    stack: true,
    onOpen: () => env.go({ section: "music", tab: "genres", genre: genre.name }),
    onMenu: (x, y) => {
      const paths = genre.songs.map((s) => s.path);
      openMenu(x, y, [{ label: "Play", icon: "play", action: () => env.lib.playAll(paths) }, ...env.lib.itemMenu(paths)]);
    },
  });
}

/** A hero for an album, artist or genre page. */
function hero(options: { shape: "square" | "circle" | "wide"; src: string | null; title: string; titleLink?: () => void; meta: string[]; songs: Song[]; env: PageEnv; pin?: { kind: "album" | "artist"; id: string } }): HTMLElement {
  const { env, songs } = options;
  const { lib } = env;
  const paths = songs.map((s) => s.path);
  const play = h("button", { class: "btn primary", type: "button", onclick: () => lib.playAll(paths) }, icon("play", 14), "Play");
  const shuffle = h("button", { class: "btn", type: "button", onclick: () => { lib.player.shuffle = true; lib.playAll(paths, Math.floor(Math.random() * paths.length)); } }, icon("shuffle", 14), "Shuffle");
  const actions = h("div", { class: "lib-hero-actions" }, play, shuffle);
  if (options.pin) {
    const { kind, id } = options.pin;
    const pinned = lib.isPinned(kind, id);
    const pin = h("button", { class: `icon-btn${pinned ? " active" : ""}`, type: "button", title: pinned ? "Unpin from sidebar" : "Pin to sidebar", "aria-label": "Pin" }, icon("star", 18));
    pin.addEventListener("click", () => lib.togglePin(kind, id, options.title));
    actions.append(pin);
  }
  const more = h("button", { class: "icon-btn", type: "button", title: "More", "aria-label": "More" }, icon("more", 18));
  more.addEventListener("click", () => {
    const r = more.getBoundingClientRect();
    openMenu(r.left, r.bottom + 6, lib.itemMenu(paths));
  });
  actions.append(more);
  const title = h("h1", { title: options.title }, options.title);
  const sub = options.titleLink
    ? h("button", { class: "lib-link", type: "button", onclick: options.titleLink }, options.meta[0])
    : null;
  return h("div", { class: `lib-hero music ${options.shape}` },
    h("div", { class: "lib-hero-art" }, art({ src: options.src, icon: "music", shape: options.shape, iconSize: 48 })),
    h("div", { class: "lib-hero-text" }, title, sub, h("div", { class: "lib-hero-meta" }, ...options.meta.slice(sub ? 1 : 0).map((m) => h("span", null, m))), actions));
}

function loading(songs: Song[] | null, scanning: boolean, env: PageEnv): HTMLElement | null {
  if (songs === null || (scanning && songs.length === 0)) {
    return h("div", { class: "lib-empty" }, h("div", { class: "spinner" }), h("p", null, "Looking for your music…"));
  }
  if (songs.length === 0) {
    return emptyState("music", "No music found", "CorePro looks for songs in your Music and Downloads folders and on connected drives.", { label: "Refresh", icon: "refresh", run: () => env.lib.ensureMusic(true) });
  }
  return null;
}

export function musicPage(env: PageEnv): PageResult {
  const { lib } = env;
  lib.ensureMusic();
  const { route } = env;
  if (route.section !== "music") return { body: h("div") };
  const body = h("div", { class: "lib-page" });
  const wait = loading(lib.songs, lib.scanningMusic, env);
  if (wait) {
    body.append(tabs(env, route.tab), wait);
    return { body };
  }
  const songs = lib.songs ?? [];
  const m = model(songs);

  if (route.album) {
    const album = m.albums.find((a) => a.key === route.album);
    if (!album) return { body: h("div", { class: "lib-page" }, emptyState("music", "Album not found", "It may have been moved or deleted.", { label: "All Albums", run: () => env.go({ section: "music", tab: "albums" }) })) };
    const queue = album.songs.map((s) => s.path);
    body.append(hero({
      env, shape: "square", src: cover(album.cover, 640), title: album.name, songs: album.songs, pin: { kind: "album", id: album.key },
      titleLink: album.artist ? () => env.go({ section: "music", tab: "artists", artist: album.artist }) : undefined,
      meta: [album.artist || "Unknown artist", [album.year || "", plural(album.songs.length, "song"), formatSpan(album.duration)].filter(Boolean).join(" · ")],
    }));
    const list = h("div", { class: "lib-list" });
    renderChunked(list, album.songs, (s, i) => songRow(env, s, queue, String(s.track || i + 1)));
    body.append(list);
    return { body, count: plural(album.songs.length, "song") };
  }

  if (route.artist) {
    const artist = m.artists.find((a) => a.name === route.artist);
    if (!artist) return { body: h("div", { class: "lib-page" }, emptyState("music", "Artist not found", "It may have been moved or deleted.", { label: "All Artists", run: () => env.go({ section: "music", tab: "artists" }) })) };
    body.append(hero({
      env, shape: "circle", src: cover(artist.cover, 640), title: artist.name, songs: artist.songs, pin: { kind: "artist", id: artist.name },
      meta: [`${plural(artist.albums.length, "album")} · ${plural(artist.songs.length, "song")}`],
    }));
    const q = env.query;
    const albums = artist.albums.filter((a) => matches(a.name, q) || a.songs.some((s) => songMatches(s, q)));
    if (albums.length) body.append(h("div", { class: "lib-heading" }, h("h3", null, "Albums")), h("div", { class: "lib-grid music" }, ...albums.map((a) => albumCard(env, a))));
    const shown = sortSongs(artist.songs.filter((s) => songMatches(s, q)), "name");
    if (shown.length) body.append(h("div", { class: "lib-heading" }, h("h3", null, "Songs")), songList(env, shown, "list"));
    return { body, count: plural(artist.songs.length, "song") };
  }

  if (route.genre) {
    const genre = m.genres.find((g) => g.name === route.genre);
    if (!genre) return { body: h("div", { class: "lib-page" }, emptyState("music", "Genre not found", "It may have been moved or deleted.", { label: "All Genres", run: () => env.go({ section: "music", tab: "genres" }) })) };
    body.append(hero({ env, shape: "wide", src: cover(genre.cover, 640), title: genre.name, songs: genre.songs, meta: [plural(genre.songs.length, "song")] }));
    const shown = sortSongs(genre.songs.filter((s) => songMatches(s, env.query)), env.sort);
    body.append(songList(env, shown, "list"));
    return { body, count: plural(genre.songs.length, "song") };
  }

  body.append(tabs(env, route.tab));
  const grid = env.view === "grid";
  switch (route.tab) {
    case "songs": {
      const shown = sortSongs(songs.filter((s) => songMatches(s, env.query)), env.sort);
      body.append(shown.length ? songList(env, shown, env.view) : h("p", { class: "lib-note" }, "No songs match your search."));
      return { body, count: plural(songs.length, "song") };
    }
    case "albums": {
      const shown = sortAlbums(m.albums.filter((a) => matches(a.name, env.query) || matches(a.artist, env.query)), env.sort);
      if (!shown.length) body.append(h("p", { class: "lib-note" }, "No albums match your search."));
      else if (grid) body.append(h("div", { class: "lib-grid music" }, ...shown.map((a) => albumCard(env, a))));
      else {
        const list = h("div", { class: "lib-list" });
        renderChunked(list, shown, (a) => row({
          art: art({ src: cover(a.cover, 160), icon: "music", shape: "square", iconSize: 16 }),
          title: a.name, subtitle: a.artist || undefined,
          columns: [a.year ? String(a.year) : "", plural(a.songs.length, "song")].filter(Boolean),
          meta: formatSpan(a.duration),
          onOpen: () => env.go({ section: "music", tab: "albums", album: a.key }),
          onMenu: (x, y) => albumMenu(env, x, y, a),
        }));
        body.append(list);
      }
      return { body, count: plural(m.albums.length, "album") };
    }
    case "artists": {
      const shown = sortGroups(m.artists.filter((a) => matches(a.name, env.query)), env.sort);
      if (!shown.length) body.append(h("p", { class: "lib-note" }, "No artists match your search."));
      else if (grid) body.append(h("div", { class: "lib-grid music" }, ...shown.map((a) => artistCard(env, a))));
      else {
        const list = h("div", { class: "lib-list" });
        renderChunked(list, shown, (a) => row({
          art: art({ src: cover(a.cover, 160), icon: "music", shape: "circle", iconSize: 16 }),
          title: a.name, columns: [plural(a.albums.length, "album")], meta: plural(a.songs.length, "song"),
          onOpen: () => env.go({ section: "music", tab: "artists", artist: a.name }),
        }));
        body.append(list);
      }
      return { body, count: plural(m.artists.length, "artist") };
    }
    default: {
      const shown = sortGroups(m.genres.filter((g) => matches(g.name, env.query)), env.sort);
      if (!shown.length) body.append(h("p", { class: "lib-note" }, "No genres match your search."));
      else if (grid) body.append(h("div", { class: "lib-grid folders" }, ...shown.map((g) => genreCard(env, g))));
      else {
        const list = h("div", { class: "lib-list" });
        renderChunked(list, shown, (g) => row({
          art: art({ src: cover(g.cover, 160), icon: "music", shape: "square", iconSize: 16 }),
          title: g.name, meta: plural(g.songs.length, "song"),
          onOpen: () => env.go({ section: "music", tab: "genres", genre: g.name }),
        }));
        body.append(list);
      }
      return { body, count: plural(m.genres.length, "genre") };
    }
  }
}

/** Title of the album/artist/genre on screen, for the address bar. */
export function musicCrumbLabel(songs: Song[] | null, route: { album?: string; artist?: string; genre?: string }): string {
  if (route.artist) return route.artist;
  if (route.genre) return route.genre;
  if (route.album && songs) return model(songs).albums.find((a) => a.key === route.album)?.name ?? "Album";
  return "Album";
}

