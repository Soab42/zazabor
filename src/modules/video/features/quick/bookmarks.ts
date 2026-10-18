import { h } from "../../../../ui/dom";
import { icon, type IconName } from "../../../../ui/icons";
import type { PanelTab, VideoContext } from "../../extensions";
import { featureSettings } from "../../extensions";
import { formatTime } from "../../format";
import { quickApi, seekMarks, type Chapter } from "../../quick-api";
import {
  addBookmark, chapterIndexAt, cleanBookmarks, removeBookmark, renameBookmark, type Bookmark,
} from "./model";

export interface QuickSettings {
  /** Bookmarks by file path. */
  bookmarks: Record<string, Bookmark[]>;
}

/** Files whose bookmarks are kept; the oldest entries go first. */
const MAX_FILES = 300;
/** Chapters can take a moment to appear after a file starts; ask a few times. */
const CHAPTER_TRIES = 5;

/** Bookmarks (stored per file in the feature's settings) and the open file's chapters. */
export class Bookmarks {
  readonly settings: QuickSettings;
  chapters: Chapter[] = [];
  private readonly listeners = new Set<() => void>();
  private chapterKey = "";
  private chapterTimer = 0;

  constructor(private readonly ctx: VideoContext) {
    this.settings = featureSettings<QuickSettings>(ctx.shell, "quick", { bookmarks: {} });
    if (!this.settings.bookmarks || typeof this.settings.bookmarks !== "object") this.settings.bookmarks = {};
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.publishMarks();
    for (const fn of this.listeners) fn();
  }

  private get path(): string | null {
    return this.ctx.player.current;
  }

  /** Bookmarks of the open file, in time order. */
  list(): Bookmark[] {
    const path = this.path;
    return path ? cleanBookmarks(this.settings.bookmarks[path]) : [];
  }

  private store(path: string, list: Bookmark[]) {
    const all = this.settings.bookmarks;
    if (list.length) {
      delete all[path];
      all[path] = list;
    } else {
      delete all[path];
    }
    const keys = Object.keys(all);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FILES))) delete all[key];
    this.ctx.shell.saveConfig();
    this.changed();
  }

  /** Adds a bookmark at the current time (Ctrl+B); tells the user what happened. */
  addHere() {
    const path = this.path;
    if (!path || this.ctx.player.state.path !== path) return;
    const time = this.ctx.player.state.time;
    const { list, added } = addBookmark(this.list(), time);
    if (!added) {
      this.ctx.showOsd(`Already bookmarked at ${formatTime(time)}`, "Ctrl+B");
      return;
    }
    this.store(path, list);
    this.ctx.showOsd(`${added.name} added at ${formatTime(added.time)}`, "Ctrl+B");
  }

  rename(id: number, name: string) {
    const path = this.path;
    if (path) this.store(path, renameBookmark(this.list(), id, name));
  }

  remove(id: number) {
    const path = this.path;
    if (path) this.store(path, removeBookmark(this.list(), id));
  }

  // ---- chapters ----------------------------------------------------------------------------

  /** Loads the chapters of the open file (once per file, retried while the file is still starting). */
  followPlayer() {
    const { player } = this.ctx;
    const path = player.current;
    const ready = path !== null && player.state.path === path && player.state.length > 0;
    const key = ready ? `${path}|${player.state.length}` : "";
    if (key === this.chapterKey) return;
    this.chapterKey = key;
    clearTimeout(this.chapterTimer);
    if (!key) {
      if (this.chapters.length) {
        this.chapters = [];
        this.changed();
      } else {
        this.publishMarks();
      }
      return;
    }
    this.loadChapters(key, CHAPTER_TRIES);
  }

  private loadChapters(key: string, triesLeft: number) {
    quickApi
      .chapters()
      .catch(() => [] as Chapter[])
      .then((chapters) => {
        if (key !== this.chapterKey) return;
        if (chapters.length === 0 && triesLeft > 1) {
          this.chapterTimer = window.setTimeout(() => this.loadChapters(key, triesLeft - 1), 1200);
          return;
        }
        this.chapters = chapters;
        this.changed();
      });
  }

  /** Chapters and bookmarks as ticks on the seek bar. */
  publishMarks() {
    seekMarks.set([
      ...this.chapters.map((c) => ({ time: c.start, kind: "chapter" as const, label: c.name })),
      ...this.list().map((b) => ({ time: b.time, kind: "bookmark" as const, label: b.name })),
    ]);
  }

  dispose() {
    clearTimeout(this.chapterTimer);
    this.listeners.clear();
    seekMarks.set([]);
  }
}

/** The Bookmarks tab of the side panel: chapters (when the file has them) and the file's bookmarks. */
export function bookmarksTab(ctx: VideoContext, store: Bookmarks): PanelTab {
  const root = h("div", { class: "vq-panel" });
  let stopFollowing: (() => void) | undefined;
  let activeChapter = -2;
  let editing: number | null = null;

  const heading = (name: IconName, text: string, extra?: HTMLElement) => {
    const glyph = icon(name, 15);
    glyph.classList.add("two-tone");
    return h("div", { class: "vq-heading" }, glyph, h("span", null, text), extra ?? null);
  };

  const jump = (ms: number) => ctx.player.seekTo(ms);

  const chapterRow = (c: Chapter, index: number) => {
    const row = h("button", { class: "vq-row vq-chapter", type: "button", title: `Jump to ${c.name}`, "data-index": index },
      h("span", { class: "vq-time" }, formatTime(c.start)), h("span", { class: "vq-name" }, c.name));
    row.addEventListener("click", () => {
      // The container's own chapter jump keeps playback in step; the seek covers files where it is ignored.
      void quickApi.setChapter(c.index).catch(() => undefined);
      jump(c.start);
    });
    return row;
  };

  const bookmarkRow = (b: Bookmark) => {
    const time = h("span", { class: "vq-time" }, formatTime(b.time));
    const label = h("span", { class: "vq-name" }, b.name);
    const rename = h("button", { class: "icon-btn small", type: "button", title: "Rename", "aria-label": `Rename ${b.name}` }, icon("pencil", 14));
    const remove = h("button", { class: "icon-btn small", type: "button", title: "Delete", "aria-label": `Delete ${b.name}` }, icon("trash", 14));
    const row = h("div", { class: "vq-row vq-bookmark", title: `Jump to ${b.name}` }, time, label, h("span", { class: "vq-actions" }, rename, remove));
    const edit = () => {
      editing = b.id;
      const input = h("input", { class: "vq-input", type: "text", value: b.name, maxLength: 80, spellcheck: false, "aria-label": "Bookmark name" });
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        editing = null;
        if (save) store.rename(b.id, input.value);
        else render();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      label.replaceWith(input);
      input.focus();
      input.select();
    };
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".vq-actions, .vq-input")) return;
      jump(b.time);
    });
    rename.addEventListener("click", edit);
    label.addEventListener("dblclick", edit);
    remove.addEventListener("click", () => store.remove(b.id));
    return row;
  };

  const render = () => {
    if (editing !== null) return;
    const bookmarks = store.list();
    const hasFile = ctx.player.current !== null;
    const add = h("button", { class: "btn small", type: "button", disabled: !hasFile, title: "Add a bookmark at the current time (Ctrl+B)" },
      icon("plus", 14), h("span", null, "Add"));
    add.addEventListener("click", () => store.addHere());
    const chapters = store.chapters;
    root.replaceChildren(
      heading("film", "Chapters"),
      chapters.length
        ? h("div", { class: "vq-list" }, ...chapters.map(chapterRow))
        : h("p", { class: "vq-empty" }, hasFile ? "This video has no chapters." : "Open a video to see its chapters."),
      heading("star", "Bookmarks", add),
      bookmarks.length
        ? h("div", { class: "vq-list" }, ...bookmarks.map(bookmarkRow))
        : h("p", { class: "vq-empty" }, "No bookmarks yet. Press Ctrl+B to mark the current moment."),
    );
    activeChapter = -2;
    highlight();
  };

  /** Marks the chapter that is playing. */
  const highlight = () => {
    const index = chapterIndexAt(store.chapters.map((c) => ({ start: c.start, name: c.name })), ctx.player.state.time);
    if (index === activeChapter) return;
    activeChapter = index;
    for (const row of root.querySelectorAll<HTMLElement>(".vq-chapter")) row.classList.toggle("current", Number(row.dataset.index) === index);
  };

  return {
    id: "bookmarks",
    title: "Bookmarks",
    icon: "star",
    order: 50,
    render() {
      render();
      return root;
    },
    shown() {
      render();
      const offStore = store.subscribe(render);
      const offPlayer = ctx.player.subscribe(highlight);
      stopFollowing = () => {
        offStore();
        offPlayer();
      };
    },
    hidden() {
      stopFollowing?.();
      stopFollowing = undefined;
    },
  };
}
