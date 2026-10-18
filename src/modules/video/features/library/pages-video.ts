import { basename, dirname, formatDate, formatBytes, h, stripExtension } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { openMenu, type MenuItem } from "../../../../ui/menu";
import { formatRemaining, formatTime } from "../../format";
import type { LibFolder } from "../../library-api";
import { continueWatching, isFinished, isInProgress, progressOf } from "../../queue";
import { newestVideo, sortFolders, sortVideos } from "./model";
import type { PageEnv, PageResult } from "./page";
import { playlistCard } from "./pages-lists";
import { isUrl, type Library } from "./store";
import { actionButton, art, card, emptyState, formatSpan, heading, plural, renderChunked, row, videoThumb } from "./widgets";
import { draggable, type DragData } from "./dnd";

/** Home, Videos (folders and a folder's videos) and Recent. */

type Playable = { path: string; name: string; mtime: number; size: number; duration: number };

export const shelf = (...children: (HTMLElement | null)[]) => h("div", { class: "lib-shelf" }, ...children);

const matches = (name: string, query: string) => !query || name.toLowerCase().includes(query);

/** The menu of a video anywhere: play, queue actions, and removing it from the history lists. */
export function videoMenu(env: PageEnv, x: number, y: number, path: string, queue: string[], extra: MenuItem[] = []) {
  const { lib } = env;
  const known = lib.video.recent.includes(path) || !!lib.video.positions[path];
  openMenu(x, y, [
    { label: "Play", icon: "play", action: () => lib.playAll(queue, Math.max(0, queue.indexOf(path))) },
    ...lib.itemMenu([path]),
    ...extra,
    ...(known ? ["separator" as const, { label: "Remove from History", icon: "close" as const, action: () => { env.hooks.forget(path); lib.commit(); } }] : []),
  ]);
}

function videoProgress(lib: Library, path: string) {
  const position = lib.positionOf(path);
  return { progress: isInProgress(position) ? progressOf(position) : undefined, done: isFinished(position) };
}

/** A video as a card: thumbnail, duration badge, watched bar, name and size. */
export function videoCard(env: PageEnv, video: Playable, queue: string[], subtitle?: string): HTMLElement {
  const { lib } = env;
  const { progress, done } = videoProgress(lib, video.path);
  const duration = lib.durationOf(video);
  const el = card({
    art: art({ src: videoThumb(video.path, video.mtime, 400), icon: "film", progress, done, badge: duration ? formatTime(duration) : undefined }),
    title: stripExtension(video.name),
    subtitle: subtitle ?? (video.size ? formatBytes(video.size) : undefined),
    playing: lib.player.current === video.path,
    onOpen: () => lib.playAll(queue, Math.max(0, queue.indexOf(video.path))),
    onMenu: (x, y) => videoMenu(env, x, y, video.path, queue),
  });
  el.classList.toggle("done", done);
  return el;
}

export function videoRow(env: PageEnv, video: Playable, queue: string[], listName?: string, index?: number): HTMLElement {
  const { lib } = env;
  const { progress, done } = videoProgress(lib, video.path);
  const duration = lib.durationOf(video);
  const el = row({
    art: art({ src: videoThumb(video.path, video.mtime, 160), icon: "film", shape: "wide", iconSize: 16 }),
    title: stripExtension(video.name),
    subtitle: basename(dirname(video.path)),
    columns: [video.size ? formatBytes(video.size) : "", video.mtime ? formatDate(video.mtime) : ""].filter(Boolean),
    meta: duration ? formatTime(duration) : "",
    playing: lib.player.current === video.path, done, progress,
    onOpen: () => lib.playAll(queue, Math.max(0, queue.indexOf(video.path))),
    onMenu: (x, y) => videoMenu(env, x, y, video.path, queue),
    actions: [actionButton("playlist", "Add to Queue", () => lib.addToQueue([video.path]))],
  });
  if (listName !== undefined && index !== undefined) {
    draggable(el, (): DragData => ({ paths: [video.path], origin: { list: listName, index }, label: stripExtension(video.name) }));
  }
  return el;
}

/** Cards or rows for a list of videos, in the page's view mode. */
function videoList(env: PageEnv, videos: Playable[], queue: string[]): HTMLElement {
  const grid = env.view === "grid";
  const container = h("div", { class: grid ? "lib-grid" : "lib-list" });
  renderChunked(container, videos, (v) => (grid ? videoCard(env, v, queue) : videoRow(env, v, queue)));
  return container;
}

// ---- Home ------------------------------------------------------------------------------------

export function homePage(env: PageEnv): PageResult {
  const { lib } = env;
  lib.ensureVideos();
  const body = h("div", { class: "lib-page" });
  const watching = continueWatching(lib.video.positions).slice(0, 12);
  const added = (lib.folders ?? [])
    .flatMap((f) => f.videos.map((v) => ({ video: v, folder: f.name })))
    .sort((a, b) => b.video.mtime - a.video.mtime)
    .slice(0, 14);
  const { playlists, streams } = lib.settings;

  if (watching.length > 0) {
    body.append(heading("Continue watching"), shelf(...watching.map(({ path, position }) => {
      const file = lib.folders?.flatMap((f) => f.videos).find((v) => v.path === path);
      const stream = isUrl(path);
      return card({
        art: art({ src: stream ? null : videoThumb(path, file?.mtime ?? 0, 400), icon: stream ? "network" : "film", progress: progressOf(position) }),
        title: lib.label(path),
        subtitle: formatRemaining(position.time, position.length),
        detail: lib.sublabel(path),
        playing: lib.player.current === path,
        onOpen: () => lib.playAll([path]),
        onMenu: (x, y) => videoMenu(env, x, y, path, [path]),
      });
    })));
  }
  if (added.length > 0) {
    const queue = added.map((a) => a.video.path);
    body.append(heading("Recently added", { label: "All folders", run: () => env.go({ section: "videos" }) }),
      shelf(...added.map((a) => videoCard(env, a.video, queue, a.folder))));
  }
  const playlistsHead = heading("Your playlists", { label: playlists.length ? "All playlists" : "Create one", run: () => env.go({ section: "playlists" }) });
  if (playlists.length > 0) body.append(playlistsHead, shelf(...playlists.slice(0, 10).map((p) => playlistCard(env, p))));
  if (streams.length > 0) {
    body.append(heading("Your streams", { label: "All streams", run: () => env.go({ section: "streams" }) }),
      h("div", { class: "lib-list" }, ...streams.slice(0, 5).map((s) => row({
        art: art({ icon: "network", shape: "square", iconSize: 18 }),
        title: s.name, subtitle: s.url,
        onOpen: () => lib.playAll([s.url]),
        onMenu: (x, y) => openMenu(x, y, [{ label: "Play", icon: "play", action: () => lib.playAll([s.url]) }, ...lib.itemMenu([s.url])]),
      }))));
  }
  if (!body.firstChild) {
    if (lib.folders === null || lib.scanningVideos && lib.folders.length === 0) {
      body.append(h("div", { class: "lib-empty" }, h("div", { class: "spinner" }), h("p", null, "Looking for your videos…")));
    } else {
      body.append(emptyState("video", "Nothing to watch yet", "Open a video to start. CorePro finds the videos on this computer, remembers where you stopped and lets you pick up right where you left off.", { label: "Open a Video", icon: "video", run: () => env.hooks.openFile() }));
    }
  }
  return { body };
}

// ---- Videos ----------------------------------------------------------------------------------

export function folderCard(env: PageEnv, folder: LibFolder): HTMLElement {
  const { lib } = env;
  const stats = lib.folderStats(folder.videos);
  const cover = newestVideo(folder);
  const summary = [plural(stats.count, "video"), stats.duration ? formatSpan(stats.duration) : ""].filter(Boolean).join(" · ");
  return card({
    art: art({ src: cover ? videoThumb(cover.path, cover.mtime, 400) : null, icon: "folder", badge: stats.unwatched > 0 && stats.unwatched < stats.count ? `${stats.unwatched} new` : undefined }),
    title: folder.name,
    subtitle: summary,
    detail: formatDate(folder.latest),
    stack: true,
    onOpen: () => env.go({ section: "videos", folder: folder.path }),
    onMenu: (x, y) => folderMenu(env, x, y, folder.path, folder.name, folder.videos.map((v) => v.path)),
  });
}

function folderMenu(env: PageEnv, x: number, y: number, path: string, name: string, paths: string[]) {
  const { lib } = env;
  openMenu(x, y, [
    { label: "Open", icon: "folder", action: () => env.go({ section: "videos", folder: path }) },
    { label: "Play", icon: "play", action: () => lib.playAll(paths) },
    ...lib.itemMenu(paths),
    "separator",
    { label: lib.isPinned("folder", path) ? "Unpin from Sidebar" : "Pin to Sidebar", icon: "star", action: () => lib.togglePin("folder", path, name) },
  ]);
}

export function videosPage(env: PageEnv): PageResult {
  const { lib } = env;
  lib.ensureVideos();
  const open = h("button", { class: "btn small", type: "button", onclick: () => env.hooks.openFolder() }, icon("folderPlus", 15), "Open Folder…");
  const body = h("div", { class: "lib-page" });
  const folders = lib.folders;
  if (folders === null || (lib.scanningVideos && folders.length === 0)) {
    body.append(h("div", { class: "lib-empty" }, h("div", { class: "spinner" }), h("p", null, "Looking for your videos…")));
    return { body, actions: [open] };
  }
  if (folders.length === 0) {
    body.append(emptyState("folder", "No videos found", "CorePro looks for videos of 1 MB or more in your home folder and on connected drives. Open a folder to browse it directly.", { label: "Open a Folder", icon: "folderPlus", run: () => env.hooks.openFolder() }));
    return { body, actions: [open] };
  }
  const shown = sortFolders(folders.filter((f) => matches(f.name, env.query)), env.sort, lib);
  if (shown.length === 0) {
    body.append(h("p", { class: "lib-note" }, "No folders match your search."));
  } else if (env.view === "grid") {
    body.append(h("div", { class: "lib-grid folders" }, ...shown.map((f) => folderCard(env, f))));
  } else {
    const list = h("div", { class: "lib-list" });
    renderChunked(list, shown, (f) => {
      const stats = lib.folderStats(f.videos);
      const cover = newestVideo(f);
      return row({
        art: art({ src: cover ? videoThumb(cover.path, cover.mtime, 160) : null, icon: "folder", iconSize: 16 }),
        title: f.name, subtitle: f.path.replace(/^\/home\/[^/]+/, "~"),
        columns: [plural(stats.count, "video"), stats.duration ? formatSpan(stats.duration) : ""].filter(Boolean),
        meta: formatDate(f.latest),
        onOpen: () => env.go({ section: "videos", folder: f.path }),
        onMenu: (x, y) => folderMenu(env, x, y, f.path, f.name, f.videos.map((v) => v.path)),
      });
    });
    body.append(list);
  }
  const total = folders.reduce((n, f) => n + f.videos.length, 0);
  return { body, count: `${plural(folders.length, "folder")} · ${plural(total, "video")}`, actions: [open] };
}

export function folderPage(env: PageEnv, path: string): PageResult {
  const { lib } = env;
  lib.ensureVideos();
  lib.loadFolder(path);
  const videos = lib.folderVideos(path);
  const body = h("div", { class: "lib-page" });
  if (videos === null) {
    body.append(h("div", { class: "lib-empty" }, h("div", { class: "spinner" })));
    return { body };
  }
  const name = basename(path);
  if (videos.length === 0) {
    body.append(emptyState("film", "No videos here", "This folder has no videos CorePro can play.", { label: "Open Another Folder", icon: "folderPlus", run: () => env.hooks.openFolder() }));
    return { body };
  }
  const ordered = sortVideos(videos, env.sort, lib);
  const queue = ordered.map((v) => v.path);
  const stats = lib.folderStats(videos);
  const watched = videos.filter((v) => isFinished(lib.positionOf(v.path))).length;
  const size = videos.reduce((n, v) => n + v.size, 0);
  const cover = newestVideo({ videos });
  const next = ordered.find((v) => !isFinished(lib.positionOf(v.path))) ?? ordered[0];

  const play = h("button", { class: "btn primary", type: "button", onclick: () => lib.playAll(queue, Math.max(0, queue.indexOf(next.path))) }, icon("play", 14), watched > 0 && watched < videos.length ? "Continue" : "Play");
  const shuffle = h("button", { class: "btn", type: "button", onclick: () => { lib.player.shuffle = true; lib.playAll(queue, Math.floor(Math.random() * queue.length)); } }, icon("shuffle", 14), "Shuffle");
  const pin = h("button", { class: `icon-btn${lib.isPinned("folder", path) ? " active" : ""}`, type: "button", title: lib.isPinned("folder", path) ? "Unpin from sidebar" : "Pin to sidebar", "aria-label": "Pin folder" }, icon("star", 18));
  pin.addEventListener("click", () => lib.togglePin("folder", path, name));
  const more = h("button", { class: "icon-btn", type: "button", title: "More", "aria-label": "More" }, icon("more", 18));
  more.addEventListener("click", () => {
    const r = more.getBoundingClientRect();
    openMenu(r.left, r.bottom + 6, [...lib.itemMenu(queue)]);
  });
  body.append(h("div", { class: "lib-hero" },
    h("div", { class: "lib-hero-art" }, art({ src: cover ? videoThumb(cover.path, cover.mtime, 640) : null, icon: "folder", iconSize: 40, progress: watched / videos.length })),
    h("div", { class: "lib-hero-text" },
      h("h1", { title: path }, name),
      h("div", { class: "lib-hero-meta" },
        h("span", null, plural(videos.length, "video")),
        stats.duration ? h("span", { class: "lib-badge-inline", title: stats.durationKnown ? "Total length" : "Total length so far" }, icon("clock", 13), formatSpan(stats.duration)) : null,
        h("span", null, formatBytes(size))),
      h("div", { class: "lib-hero-sub" }, watched === 0 ? "Not started" : watched === videos.length ? "All watched" : `${watched} of ${videos.length} watched`),
      h("div", { class: "lib-hero-actions" }, play, shuffle, pin, more))));

  const shown = ordered.filter((v) => matches(v.name, env.query));
  if (shown.length === 0) body.append(h("p", { class: "lib-note" }, "No videos match your search."));
  else body.append(videoList(env, shown, queue));
  return { body, count: plural(videos.length, "video") };
}

// ---- Recent ----------------------------------------------------------------------------------

export function recentPage(env: PageEnv): PageResult {
  const { lib } = env;
  lib.ensureVideos();
  const recent = lib.video.recent;
  if (recent.length === 0) {
    return { body: h("div", { class: "lib-page" }, emptyState("clock", "No recent videos", "Videos you play show up here so you can get back to them quickly.", { label: "Open a Video", icon: "video", run: () => env.hooks.openFile() })) };
  }
  const known = new Map((lib.folders ?? []).flatMap((f) => f.videos).map((v) => [v.path, v]));
  const items: Playable[] = recent.map((path) => {
    const v = known.get(path);
    return { path, name: isUrl(path) ? lib.label(path) : basename(path), mtime: v?.mtime ?? 0, size: v?.size ?? 0, duration: v?.duration ?? 0};
  });
  lib.wantInfo(items.filter((i) => !i.duration).map((i) => i.path).slice(0, 24));
  const filtered = items.filter((i) => matches(i.name, env.query));
  const sorted = env.sort === "recent" ? filtered : sortVideos(filtered, env.sort, lib);
  const queue = sorted.map((i) => i.path);
  const body = h("div", { class: "lib-page" });
  if (sorted.length === 0) body.append(h("p", { class: "lib-note" }, "Nothing matches your search."));
  else {
    const grid = env.view === "grid";
    const container = h("div", { class: grid ? "lib-grid" : "lib-list" });
    renderChunked(container, sorted, (item) => grid
      ? videoCard(env, item, queue, isUrl(item.path) ? "Stream" : basename(dirname(item.path)))
      : videoRow(env, item, queue));
    body.append(container);
  }
  const clear = h("button", { class: "btn small", type: "button", onclick: () => { lib.video.recent = []; lib.commit(); } }, "Clear History");
  return { body, count: plural(recent.length, "video"), actions: [clear] };
}
