import type { ShellContext } from "../../shell/module";
import { basename, dirname, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import { videoApi, videoThumbUrl, type VideoFile } from "./api";
import { isFinished, isInProgress, progressOf, sortVideos, type VideoSort } from "./queue";

export interface VideoSidebarHooks {
  /** Plays a file with the folder's videos as the queue. */
  play(path: string, queue: string[]): void;
  openFolder(): void;
}

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

const SORT_LABELS: Record<VideoSort, string> = { name: "Name", date: "Date modified", size: "Size" };

/** The sidebar while playing: the videos of a folder with progress, sorting and search. */
export class VideoSidebar {
  readonly el = h("aside", { class: "vp-sidebar" });
  private readonly back = h("button", { class: "icon-btn small", type: "button", title: "Back", "aria-label": "Back" }, icon("chevronLeft", 16));
  private readonly forward = h("button", { class: "icon-btn small", type: "button", title: "Forward", "aria-label": "Forward" }, icon("chevronRight", 16));
  private readonly crumbs = h("div", { class: "vp-crumbs" });
  private readonly count = h("span", { class: "vp-count" });
  private readonly searchBox = h("input", { class: "vp-search", type: "text", placeholder: "Filter videos", spellcheck: false, autocomplete: "off" });
  private readonly list = h("div", { class: "vp-list" });
  private readonly searchRow = h("div", { class: "vp-search-row", hidden: true }, this.searchBox);
  private folder = "";
  private files: VideoFile[] = [];
  private history: string[] = [];
  private cursor = -1;
  private current: string | null = null;
  private sort: VideoSort = "name";
  private ascending = true;
  private token = 0;

  constructor(private readonly shell: ShellContext, private readonly hooks: VideoSidebarHooks) {
    this.back.addEventListener("click", () => this.step(-1));
    this.forward.addEventListener("click", () => this.step(1));
    const more = h("button", { class: "icon-btn small", type: "button", title: "More", "aria-label": "More" }, icon("more", 16));
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [{ label: "Open Folder…", icon: "folder", action: () => this.hooks.openFolder() }]);
    });
    const sortButton = h("button", { class: "icon-btn small", type: "button", title: "Sort", "aria-label": "Sort" }, icon("sort", 16));
    sortButton.addEventListener("click", () => this.sortMenu(sortButton));
    const searchButton = h("button", { class: "icon-btn small", type: "button", title: "Filter", "aria-label": "Filter" }, icon("search", 16));
    searchButton.addEventListener("click", () => {
      this.searchRow.hidden = !this.searchRow.hidden;
      if (this.searchRow.hidden) this.searchBox.value = "";
      else this.searchBox.focus();
      this.renderList();
    });
    this.searchBox.addEventListener("input", () => this.renderList());
    this.searchBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        searchButton.click();
      }
    });
    this.el.append(
      h("div", { class: "vp-side-head" }, this.back, this.forward, this.crumbs, more),
      h("div", { class: "vp-side-count" }, this.count, sortButton, searchButton),
      this.searchRow,
      this.list,
    );
    this.updateNav();
    this.renderList();
  }

  /** Shows a folder's videos; `record` adds it to the back/forward history. */
  async browse(folder: string, record = true) {
    if (!folder) return;
    if (record && this.history[this.cursor] !== folder) {
      this.history = [...this.history.slice(0, this.cursor + 1), folder];
      this.cursor = this.history.length - 1;
    }
    this.folder = folder;
    this.updateNav();
    const token = ++this.token;
    try {
      const files = await videoApi.listVideos(folder);
      if (token !== this.token) return;
      this.files = files;
    } catch (err) {
      if (token !== this.token) return;
      console.warn("Could not list videos:", err);
      this.files = [];
    }
    this.renderList();
  }

  get browsing(): string {
    return this.folder;
  }

  /** Highlights the playing file. */
  setCurrent(path: string | null) {
    this.current = path;
    this.refresh();
  }

  /** Redraws progress bars and names after resume points changed. */
  refresh() {
    this.renderList();
  }

  private step(delta: number) {
    const to = this.cursor + delta;
    if (to < 0 || to >= this.history.length) return;
    this.cursor = to;
    void this.browse(this.history[to], false);
  }

  private updateNav() {
    this.back.disabled = this.cursor <= 0;
    this.forward.disabled = this.cursor >= this.history.length - 1;
    this.crumbs.replaceChildren(...trail(this.folder).flatMap((crumb, i, all) => {
      const button = h("button", { class: `vp-crumb${i === all.length - 1 ? " current" : ""}`, type: "button", title: crumb.path }, crumb.name);
      button.addEventListener("click", () => void this.browse(crumb.path));
      return i === 0 ? [button] : [h("span", { class: "vp-crumb-sep" }, "▶"), button];
    }));
  }

  private sortMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    const keys = (Object.keys(SORT_LABELS) as VideoSort[]).map((key) => ({
      label: SORT_LABELS[key],
      icon: this.sort === key ? ("check" as const) : undefined,
      action: () => {
        this.sort = key;
        this.renderList();
      },
    }));
    openMenu(r.left, r.bottom + 4, [
      ...keys,
      "separator",
      { label: "Ascending", icon: this.ascending ? "check" : undefined, action: () => { this.ascending = true; this.renderList(); } },
      { label: "Descending", icon: this.ascending ? undefined : "check", action: () => { this.ascending = false; this.renderList(); } },
    ]);
  }

  private renderList() {
    const query = this.searchBox.value.trim().toLowerCase();
    const sorted = sortVideos(this.files, this.sort, this.ascending);
    const shown = query ? sorted.filter((f) => f.name.toLowerCase().includes(query)) : sorted;
    this.count.textContent = `${this.files.length} ${this.files.length === 1 ? "item" : "items"}`;
    if (shown.length === 0) {
      this.list.replaceChildren(h("div", { class: "vp-list-empty" }, this.files.length === 0 ? "No videos in this folder" : "No matches"));
      return;
    }
    const queue = sorted.map((f) => f.path);
    const positions = this.shell.config.video.positions;
    this.list.replaceChildren(...shown.map((file) => {
      const position = positions[file.path];
      const img = h("img", { alt: "", loading: "lazy", draggable: false, src: videoThumbUrl(file.path, file.mtime, 96) });
      img.addEventListener("load", () => img.classList.add("loaded"));
      img.addEventListener("error", () => img.remove());
      const thumb = h("div", { class: "vp-thumb" }, img,
        isInProgress(position) ? h("div", { class: "vp-prog", style: { width: `${Math.round(progressOf(position) * 100)}%` } }) : null);
      const playing = file.path === this.current;
      const row = h("button", {
        class: `vp-item${playing ? " playing" : ""}${isFinished(position) ? " done" : ""}`, type: "button", title: file.name,
      }, thumb, h("span", { class: "vp-name" }, file.name));
      row.addEventListener("click", () => this.hooks.play(file.path, queue));
      return row;
    }));
    this.list.querySelector(".playing")?.scrollIntoView({ block: "nearest" });
  }
}
