import { open } from "../../../../shared/dialog";
import { formatDate, h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { openMenu } from "../../../../ui/menu";
import { formatTime } from "../../format";
import type { Playlist, PlaylistItem, SavedStream } from "../../library-api";
import { pathArt } from "./art";
import { confirmDialog } from "./confirm";
import { draggable, dropList, type DragData } from "./dnd";
import { byName } from "./model";
import type { PageEnv, PageResult } from "./page";
import { isUrl } from "./store";
import { actionButton, art, askName, card, emptyState, formatSpan, plural, renderChunked, row } from "./widgets";

/** Network Streams and Playlists. */

const MEDIA_EXTENSIONS = [
  "mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "ogv", "3gp",
  "mp3", "ogg", "oga", "opus", "flac", "wav", "m4a", "aac", "wma", "aiff", "aif", "mka",
];

const matches = (text: string | undefined, query: string) => !query || (text ?? "").toLowerCase().includes(query);

/** Lets the user pick videos and songs; empty when cancelled. */
export async function pickMedia(): Promise<string[]> {
  try {
    const picked = await open({ multiple: true, filters: [{ name: "Videos and music", extensions: MEDIA_EXTENSIONS }] });
    return Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  } catch (err) {
    console.warn("File dialog failed:", err);
    return [];
  }
}

/** New Playlist: a name, then files to put in it (optional). Opens the new playlist. */
export async function createPlaylistFlow(env: PageEnv) {
  const name = await askName({ title: "New Playlist", label: "Name", value: "", confirm: "Choose Files…", placeholder: "My playlist" });
  if (name === null) return;
  const files = await pickMedia();
  const id = env.lib.createPlaylist(name, files.map((path) => ({ path })));
  env.go({ section: "playlists", id });
}

// ---- Network Streams -------------------------------------------------------------------------

let streamDraft = "";

function streamMenu(env: PageEnv, x: number, y: number, s: SavedStream) {
  const { lib } = env;
  openMenu(x, y, [
    { label: "Play", icon: "play", action: () => lib.playAll([s.url]) },
    ...lib.itemMenu([s.url]),
    "separator",
    { label: "Rename…", icon: "pencil", action: () => void askName({ title: "Rename Stream", label: "Name", value: s.name, confirm: "Rename" }).then((n) => n && lib.renameStream(s.id, n)) },
    { label: lib.isPinned("stream", s.id) ? "Unpin from Sidebar" : "Pin to Sidebar", icon: "star", action: () => lib.togglePin("stream", s.id, s.name) },
    { label: "Remove", icon: "trash", danger: true, action: () => lib.deleteStream(s.id) },
  ]);
}

export function streamsPage(env: PageEnv): PageResult {
  const { lib } = env;
  const input = h("input", {
    class: "lib-field", type: "text", value: streamDraft, spellcheck: false, autocomplete: "off",
    placeholder: "Stream address (http, https, rtsp, udp…) or an IPTV playlist (.m3u) URL",
  });
  const message = h("div", { class: "lib-form-note", role: "status" });
  const add = h("button", { class: "btn primary", type: "button" }, icon("plus", 15), "Add");
  const submit = async () => {
    const url = input.value.trim();
    if (!url) return input.focus();
    add.disabled = true;
    input.disabled = true;
    message.className = "lib-form-note";
    message.replaceChildren(h("div", { class: "spinner small" }), /\.m3u8?(\?|$)/i.test(url) ? "Reading the playlist…" : "Saving…");
    try {
      const result = await lib.addStream(url);
      streamDraft = "";
      if (result.kind === "playlist") env.go({ section: "playlists", id: result.id });
      else {
        input.value = "";
        message.replaceChildren("Saved.");
      }
    } catch (err) {
      message.className = "lib-form-note error";
      message.replaceChildren(typeof err === "string" ? err : err instanceof Error ? err.message : "That address couldn't be added.");
    } finally {
      add.disabled = false;
      input.disabled = false;
    }
  };
  add.addEventListener("click", () => void submit());
  input.addEventListener("input", () => (streamDraft = input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });

  const form = h("div", { class: "lib-form" },
    h("div", { class: "lib-form-row" }, input, add),
    message,
    h("p", { class: "lib-hint" }, "Paste an IPTV or M3U playlist address and it becomes a playlist of channels automatically."));
  const body = h("div", { class: "lib-page" }, form);

  const streams = lib.settings.streams.filter((s) => matches(s.name, env.query) || matches(s.url, env.query));
  streams.sort(env.sort === "name" ? (a, b) => byName(a.name, b.name) : (a, b) => b.added - a.added);
  if (lib.settings.streams.length === 0) {
    body.append(emptyState("network", "No saved streams", "Saved streams stay here so you can open them again in one click. Add a web radio, a camera or a live TV address above."));
  } else if (streams.length === 0) {
    body.append(h("p", { class: "lib-note" }, "No streams match your search."));
  } else {
    body.append(h("div", { class: "lib-list" }, ...streams.map((s) => row({
      art: art({ icon: "network", shape: "square", iconSize: 18 }),
      title: s.name, subtitle: s.url,
      meta: formatDate(s.added / 1000),
      playing: lib.player.current === s.url,
      onOpen: () => lib.playAll(streams.map((x) => x.url), streams.indexOf(s)),
      onMenu: (x, y) => streamMenu(env, x, y, s),
      actions: [actionButton("more", "More", (e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); streamMenu(env, r.left, r.bottom + 4, s); })],
    }))));
  }
  return { body, count: plural(lib.settings.streams.length, "stream") };
}

// ---- Playlists -------------------------------------------------------------------------------

/** A 2×2 mosaic of the first items' pictures (a single picture below four). */
function mosaic(env: PageEnv, playlist: Playlist, size: number): HTMLElement {
  if (playlist.source) return art({ icon: "network", shape: "wide", iconSize: 34 });
  const items = playlist.items;
  if (items.length === 0) return art({ icon: "playlist", shape: "wide", iconSize: 34 });
  if (items.length < 4) return pathArt(env.lib, items[0].path, size, { shape: "wide", icon: "playlist" });
  return h("div", { class: "lib-art wide lib-mosaic" }, ...items.slice(0, 4).map((i) => pathArt(env.lib, i.path, size / 2, { shape: "square" })));
}

function playlistMenu(env: PageEnv, x: number, y: number, p: Playlist) {
  const { lib } = env;
  openMenu(x, y, [
    { label: "Open", icon: "playlist", action: () => env.go({ section: "playlists", id: p.id }) },
    { label: "Play", icon: "play", action: () => lib.playPlaylist(p) },
    { label: "Shuffle", icon: "shuffle", action: () => lib.playPlaylist(p, 0, true) },
    "separator",
    { label: "Rename…", icon: "pencil", action: () => void askName({ title: "Rename Playlist", label: "Name", value: p.name, confirm: "Rename" }).then((n) => n && lib.renamePlaylist(p.id, n)) },
    { label: lib.isPinned("playlist", p.id) ? "Unpin from Sidebar" : "Pin to Sidebar", icon: "star", action: () => lib.togglePin("playlist", p.id, p.name) },
    { label: "Delete Playlist", icon: "trash", danger: true, action: () => void deletePlaylist(env, p) },
  ]);
}

async function deletePlaylist(env: PageEnv, p: Playlist) {
  const ok = await confirmDialog({ title: "Delete playlist?", text: `“${p.name}” will be deleted. Your files aren't touched.`, confirm: "Delete" });
  if (!ok) return;
  env.lib.deletePlaylist(p.id);
  if (env.route.section === "playlists" && env.route.id === p.id) env.go({ section: "playlists" });
}

function playlistSummary(p: Playlist, durationMs = 0): string {
  const count = p.source ? plural(p.channelCount ?? 0, "channel") : plural(p.items.length, "item");
  return [count, p.source ? "IPTV" : "", durationMs ? formatSpan(durationMs) : ""].filter(Boolean).join(" · ");
}

export function playlistCard(env: PageEnv, p: Playlist): HTMLElement {
  return card({
    art: mosaic(env, p, 400),
    title: p.name,
    subtitle: playlistSummary(p),
    stack: true,
    onOpen: () => env.go({ section: "playlists", id: p.id }),
    onMenu: (x, y) => playlistMenu(env, x, y, p),
  });
}

export function playlistsPage(env: PageEnv): PageResult {
  const { lib } = env;
  const create = h("button", { class: "btn small", type: "button", onclick: () => void createPlaylistFlow(env) }, icon("plus", 15), "New Playlist");
  const body = h("div", { class: "lib-page" });
  const all = lib.settings.playlists;
  if (all.length === 0) {
    body.append(emptyState("playlist", "No playlists yet", "A playlist is a saved collection of videos, songs or streams. Create one, or add anything to a playlist from its menu.", { label: "New Playlist", icon: "plus", run: () => void createPlaylistFlow(env) }));
    return { body, actions: [create] };
  }
  const shown = all.filter((p) => matches(p.name, env.query));
  shown.sort(env.sort === "name" ? (a, b) => byName(a.name, b.name) : (a, b) => b.created - a.created);
  if (shown.length === 0) body.append(h("p", { class: "lib-note" }, "No playlists match your search."));
  else if (env.view === "grid") body.append(h("div", { class: "lib-grid folders" }, ...shown.map((p) => playlistCard(env, p))));
  else {
    body.append(h("div", { class: "lib-list" }, ...shown.map((p) => row({
      art: mosaic(env, p, 160), title: p.name, subtitle: playlistSummary(p), meta: formatDate(p.created / 1000),
      onOpen: () => env.go({ section: "playlists", id: p.id }),
      onMenu: (x, y) => playlistMenu(env, x, y, p),
    }))));
  }
  return { body, count: plural(all.length, "playlist"), actions: [create] };
}

export function playlistPage(env: PageEnv, id: string): PageResult {
  const { lib } = env;
  const playlist = lib.playlist(id);
  const body = h("div", { class: "lib-page" });
  if (!playlist) {
    body.append(emptyState("playlist", "Playlist not found", "It may have been deleted.", { label: "All Playlists", run: () => env.go({ section: "playlists" }) }));
    return { body };
  }
  const items = lib.itemsOf(playlist);
  if (items === null) {
    body.append(h("div", { class: "lib-empty" }, h("div", { class: "spinner" }), h("p", null, "Loading channels…")));
    return { body };
  }
  lib.remember(items);
  const editable = !playlist.source;
  const paths = items.map((i) => i.path);
  lib.wantInfo(items.slice(0, 40).map((i) => i.path).filter((p) => !isUrl(p)));
  const duration = items.reduce((sum, i) => sum + (lib.songAt(i.path)?.duration ?? lib.info(i.path)?.duration ?? 0), 0);

  const play = h("button", { class: "btn primary", type: "button", disabled: items.length === 0, onclick: () => lib.playPlaylist(playlist) }, icon("play", 14), "Play");
  const shuffle = h("button", { class: "btn", type: "button", disabled: items.length === 0, onclick: () => lib.playPlaylist(playlist, 0, true) }, icon("shuffle", 14), "Shuffle");
  const addFiles = editable
    ? h("button", { class: "btn", type: "button", onclick: () => void pickMedia().then((files) => files.length && lib.addToPlaylistById(id, files)) }, icon("plus", 14), "Add Files")
    : h("button", { class: "btn", type: "button", onclick: () => void lib.refreshPlaylist(id).catch((err) => console.warn("Could not refresh the playlist:", err)) }, icon("refresh", 14), "Refresh");
  const pin = h("button", { class: `icon-btn${lib.isPinned("playlist", id) ? " active" : ""}`, type: "button", title: lib.isPinned("playlist", id) ? "Unpin from sidebar" : "Pin to sidebar", "aria-label": "Pin playlist" }, icon("star", 18));
  pin.addEventListener("click", () => lib.togglePin("playlist", id, playlist.name));
  const more = h("button", { class: "icon-btn", type: "button", title: "More", "aria-label": "More" }, icon("more", 18));
  more.addEventListener("click", () => {
    const r = more.getBoundingClientRect();
    playlistMenu(env, r.left, r.bottom + 6, playlist);
  });
  body.append(h("div", { class: "lib-hero" },
    h("div", { class: "lib-hero-art" }, mosaic(env, playlist, 640)),
    h("div", { class: "lib-hero-text" },
      h("h1", { title: playlist.source }, playlist.name),
      h("div", { class: "lib-hero-meta" }, h("span", null, playlistSummary(playlist, duration))),
      playlist.source ? h("div", { class: "lib-hero-sub", title: playlist.source }, playlist.source) : null,
      h("div", { class: "lib-hero-actions" }, play, shuffle, addFiles, pin, more))));

  if (items.length === 0) {
    body.append(emptyState("playlist", "This playlist is empty", "Add files here, or use “Add to Playlist” in any item's menu.", editable ? { label: "Add Files", icon: "plus", run: () => void pickMedia().then((files) => files.length && lib.addToPlaylistById(id, files)) } : undefined));
    return { body, count: "0 items" };
  }

  const filtering = env.query !== "";
  const visible = items.map((item, index) => ({ item, index })).filter(({ item }) => matches(lib.label(item.path), env.query) || matches(item.group, env.query));
  const list = h("div", { class: "lib-list playlist-list" });
  const listName = `pl:${id}`;
  const build = ({ item, index }: { item: PlaylistItem; index: number }) => {
    const label = lib.label(item.path);
    const song = lib.songAt(item.path);
    const duration = song?.duration ?? lib.info(item.path)?.duration ?? 0;
    const el = row({
      lead: String(index + 1),
      art: pathArt(lib, item.path, 160, { iconSize: 16 }),
      title: label,
      subtitle: item.group ?? lib.sublabel(item.path),
      meta: duration ? formatTime(duration) : "",
      playing: lib.player.current === item.path,
      listRow: true,
      onOpen: () => lib.playAll(paths, index),
      onMenu: (x, y) => openMenu(x, y, [
        { label: "Play", icon: "play", action: () => lib.playAll(paths, index) },
        ...lib.itemMenu([item.path]),
        ...(editable ? ["separator" as const, { label: "Remove from Playlist", icon: "close" as const, action: () => lib.removeFromPlaylist(id, index) }] : []),
      ]),
      actions: editable ? [actionButton("close", "Remove from playlist", () => lib.removeFromPlaylist(id, index))] : [actionButton("playlist", "Add to Queue", () => lib.addToQueue([item.path]))],
    });
    if (editable && !filtering) draggable(el, (): DragData => ({ paths: [item.path], origin: { list: listName, index }, label }));
    return el;
  };
  renderChunked(list, visible, build);
  body.append(list);
  let dispose: (() => void) | undefined;
  if (editable && !filtering) {
    dispose = dropList(list, (data) => data.origin?.list === listName || data.paths.length > 0, (data, at) => {
      if (data.origin?.list === listName) lib.moveInPlaylist(id, data.origin.index, at);
      else lib.insertInPlaylist(id, data.paths, at);
    });
  }
  return { body, count: plural(items.length, playlist.source ? "channel" : "item"), dispose };
}
