import type { UnlistenFn } from "@tauri-apps/api/event";
import type { FilesSettings, FilesSortKey, FilesView } from "../../config";
import { ThumbLoader } from "../../shared/thumbs";
import type { ShellContext } from "../../shell/module";
import { formatBytes, h, isTypingTarget } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import { fsApi, onChanged, type FsEntry, type Volume } from "./api";
import { categoryOf, iconNameFor, isImageExt, isVideoExt } from "./kinds";
import { isInside, normalizePath, parentOf, samePath, expandPath } from "./path";
import { filterEntries, sortEntries } from "./sort";
import { emptyState, errorState, loadingState } from "./states";
import { TabBar } from "./tabbar";
import { Tab } from "./tabs";
import { Toolbar } from "./toolbar";
import { ColumnView } from "./views/column";
import { GalleryView } from "./views/gallery";
import { IconView } from "./views/icon";
import { ListView } from "./views/list";
import type { FileView, ViewContext } from "./views/types";

export interface BrowserHooks {
  /** The active tab is now showing this folder. */
  pathChanged(path: string): void;
  /** The pinned folders changed. */
  pinsChanged(): void;
}

/** What feature add-ons (file operations, Quick Look, …) can see and do in the browser. */
export interface BrowserContext {
  readonly shell: ShellContext;
  /** The folder the active tab shows. */
  readonly folder: string;
  /** Selected entries in view order; the focused entry when nothing is selected. */
  selected(): FsEntry[];
  focused(): FsEntry | null;
  /** Entries of the current folder in view order (after search filtering). */
  visible(): FsEntry[];
  /** Re-lists the current folder now (live updates catch most changes on their own). */
  refresh(): void;
  /** Selects these paths (e.g. after creating or pasting) and scrolls the focus into view. */
  select(paths: string[], focus?: string): void;
  navigate(path: string): void;
}

/**
 * A feature that plugs into the browser without editing it: its own shortcuts and context-menu
 * items. Registered with `Browser.addExtension` from the module's index.
 */
export interface BrowserExtension {
  /** Keys before the browser's own handling (never called while typing in a field). */
  handleKey?(e: KeyboardEvent, ctx: BrowserContext): boolean;
  /** Extra items for an item's context menu; `entries` are the selection the click acts on. */
  itemMenu?(entries: FsEntry[], ctx: BrowserContext): MenuItem[];
  /** Extra items for the context menu of empty space. */
  emptyMenu?(ctx: BrowserContext): MenuItem[];
}

const SORT_KEYS: { key: FilesSortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "date", label: "Date Modified" },
  { key: "size", label: "Size" },
  { key: "kind", label: "Kind" },
];

const VIEW_ITEMS: { view: FilesView; label: string }[] = [
  { view: "icon", label: "as Icons" },
  { view: "list", label: "as List" },
  { view: "column", label: "as Columns" },
  { view: "gallery", label: "as Gallery" },
];

/** Runs a command and reports the key as handled. */
const run = (fn: () => void) => {
  fn();
  return true;
};

/**
 * The main area of the Files module: toolbar, tabs, the current view and the status bar.
 * It lists folders, keeps them live, and owns tabs, history and selection.
 */
export class Browser {
  readonly el = h("section", { class: "fs-main" });
  private tabs: Tab[] = [new Tab("")];
  private activeTab = 0;
  private raw: FsEntry[] = [];
  private sorted: FsEntry[] = [];
  private visible: FsEntry[] = [];
  private extensions: BrowserExtension[] = [];
  private query = "";
  private error: string | null = null;
  private loadToken = 0;
  private loaded = false;
  private active = false;
  private disposed = false;
  private home = "";
  private volumes: Volume[] = [];
  private watched = new Set<string>();
  private viewWatch = new Map<string, number>();
  private unlisten: UnlistenFn | null = null;
  private liveTimer: number | undefined;
  private searchTimer: number | undefined;

  private readonly thumbs = new ThumbLoader();
  private readonly ctx: ViewContext;
  private readonly toolbar: Toolbar;
  private readonly tabBar: TabBar;
  private readonly content = h("div", { class: "fs-content" });
  private readonly overlay = h("div", { class: "fs-state" });
  private readonly statusText = h("span", { class: "status-text" });
  private readonly slider = h("input", { class: "size-slider", type: "range", min: "48", max: "160", step: "4", "aria-label": "Icon size" });
  private readonly sliderBox = h("div", { class: "fs-slider" }, h("span", { class: "slider-icon" }, icon("grid", 12)), this.slider,
    h("span", { class: "slider-icon" }, icon("grid", 17)));
  private view!: FileView;
  private viewKind: FilesView | null = null;

  constructor(private readonly shell: ShellContext, private readonly hooks: BrowserHooks) {
    const browser = this;
    this.ctx = {
      get settings() { return browser.settings; },
      thumbs: this.thumbs,
      get sel() { return browser.tab.sel; },
      get path() { return browser.tab.path; },
      selectionChanged: () => this.updateStatus(),
      open: (entry, folder) => this.openEntry(entry, folder),
      contextMenu: (e, entry) => this.contextMenu(e, entry),
      listFolder: async (path) => sortEntries(await fsApi.list(path, this.settings.showHidden), this.settings.sort, this.settings.foldersFirst),
      watch: (path) => this.addViewWatch(path),
      unwatch: (path) => this.removeViewWatch(path),
      sortBy: (key) => this.sortBy(key),
      statusChanged: () => this.updateStatus(),
    };

    this.toolbar = new Toolbar({
      back: () => this.back(),
      forward: () => this.forward(),
      navigate: (path) => this.navigate(path),
      submitPath: (text) => this.navigate(expandPath(text, this.home || "/")),
      setView: (view) => this.setView(view),
      sortMenu: (x, y) => openMenu(x, y, this.sortItems()),
      toggleHidden: () => this.toggleHidden(),
      search: (query) => this.setQuery(query),
      searchDone: () => this.view.el.focus({ preventScroll: true }),
    });
    this.tabBar = new TabBar({
      select: (i) => this.switchTab(i),
      close: (i) => this.closeTab(i),
      add: () => this.newTab(),
    });

    this.slider.value = String(this.settings.iconSize);
    this.slider.addEventListener("input", () => {
      this.settings.iconSize = Number(this.slider.value);
      this.shell.saveConfig();
      this.view.iconSizeChanged?.();
    });
    const status = h("div", { class: "fs-status" }, this.statusText, h("span", { class: "spacer" }), this.sliderBox);

    this.content.append(this.overlay);
    this.content.addEventListener("contextmenu", (e) => {
      if (!e.defaultPrevented) this.contextMenu(e, null);
    });
    this.el.append(this.toolbar.el, this.tabBar.el, this.content, status);
    this.overlay.hidden = true;

    this.mountView();
    this.updateToolbar();
    void onChanged((folder) => this.onFolderChanged(folder)).then((un) => {
      if (this.disposed) un();
      else this.unlisten = un;
    });
    void this.init();
  }

  private get settings(): FilesSettings {
    return this.shell.config.files;
  }

  private get tab(): Tab {
    return this.tabs[this.activeTab];
  }

  /** Finds the home folder and picks the first folder to show: the last one, if it still opens. */
  private async init() {
    try {
      const places = await fsApi.places();
      this.home = places.find((p) => p.kind === "home")?.path ?? "";
    } catch (err) {
      console.warn("Could not list places:", err);
    }
    if (this.disposed || this.tab.path) return;
    let start = this.home || "/";
    const last = this.settings.lastPath;
    if (last) {
      try {
        if ((await fsApi.stat(last)).dir) start = last;
      } catch {
        // Gone or unreadable: fall back to Home.
      }
    }
    if (this.disposed || this.tab.path) return;
    this.navigate(start);
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  activate() {
    this.active = true;
    this.syncWatches();
    // Anything may have changed while another module was showing.
    if (this.loaded) void this.load("live");
  }

  deactivate() {
    this.active = false;
    clearTimeout(this.liveTimer);
    this.syncWatches();
  }

  dispose() {
    this.disposed = true;
    this.active = false;
    clearTimeout(this.liveTimer);
    clearTimeout(this.searchTimer);
    this.loadToken++;
    this.view.dispose();
    this.viewWatch.clear();
    this.syncWatches();
    this.unlisten?.();
    this.unlisten = null;
  }

  addExtension(extension: BrowserExtension) {
    this.extensions.push(extension);
  }

  /** The add-on view of the browser (see BrowserContext). */
  get context(): BrowserContext {
    const browser = this;
    return {
      shell: this.shell,
      get folder() { return browser.tab.path; },
      selected: () => {
        const { selection, focus } = this.tab.sel;
        const chosen = this.visible.filter((e) => selection.has(e.path));
        if (chosen.length) return chosen;
        const current = focus ? this.visible.find((e) => e.path === focus) : undefined;
        return current ? [current] : [];
      },
      focused: () => this.view.focused()?.entry ?? null,
      visible: () => this.visible,
      refresh: () => void this.load("live"),
      select: (paths, focus) => {
        const sel = this.tab.sel;
        sel.selection = new Set(paths);
        sel.focus = sel.anchor = focus ?? paths[0] ?? null;
        this.view.renderSelection();
        if (sel.focus) this.view.reveal(sel.focus);
        this.updateStatus();
      },
      navigate: (path) => this.navigate(path),
    };
  }

  /** Settings edited `config.files` (hidden files, folders first, default view): follow along. */
  settingsChanged() {
    this.mountView();
    this.updateToolbar();
    void this.load("live");
  }

  setVolumes(volumes: Volume[]) {
    this.volumes = volumes;
    this.updateStatus();
  }

  // ---- navigation -----------------------------------------------------------------------------

  /** Shows `path` in the current tab, adding it to the history. */
  navigate(path: string, opts: { select?: string } = {}) {
    const target = normalizePath(path);
    if (!target) return;
    this.saveTabState();
    this.tab.visit(target);
    this.preselect(opts.select);
    this.afterNavigate();
  }

  private preselect(path: string | undefined) {
    if (!path) return;
    const sel = this.tab.sel;
    sel.selection = new Set([path]);
    sel.anchor = sel.focus = path;
  }

  private back() {
    this.step(-1);
  }

  private forward() {
    this.step(1);
  }

  private step(delta: -1 | 1) {
    this.saveTabState();
    const from = this.tab.path;
    const to = this.tab.step(delta);
    if (to === null) return;
    // Arriving at the parent of where you were: that folder is the one to highlight.
    if (samePath(parentOf(from), to)) this.preselect(from);
    this.afterNavigate();
  }

  private up() {
    const parent = parentOf(this.tab.path);
    if (!samePath(parent, this.tab.path)) this.navigate(parent, { select: this.tab.path });
  }

  private afterNavigate() {
    this.query = "";
    this.toolbar.resetSearch();
    this.updateToolbar();
    this.tabBar.render(this.tabs, this.activeTab);
    this.hooks.pathChanged(this.tab.path);
    void this.load("fresh");
  }

  private saveTabState() {
    if (this.view) this.tab.scroll = this.view.getScroll();
  }

  private goHome() {
    this.navigate(this.home || "/");
  }

  // ---- tabs -----------------------------------------------------------------------------------

  newTab(path = this.tab.path) {
    this.saveTabState();
    this.tabs.push(new Tab(path));
    this.activeTab = this.tabs.length - 1;
    this.afterNavigate();
  }

  private switchTab(index: number) {
    if (index === this.activeTab || !this.tabs[index]) return;
    this.saveTabState();
    this.activeTab = index;
    this.afterNavigate();
  }

  private closeTab(index: number) {
    if (this.tabs.length < 2 || !this.tabs[index]) return;
    this.saveTabState();
    this.tabs.splice(index, 1);
    if (index > this.activeTab) {
      this.tabBar.render(this.tabs, this.activeTab);
      return;
    }
    if (index < this.activeTab) this.activeTab--;
    this.activeTab = Math.min(this.activeTab, this.tabs.length - 1);
    this.afterNavigate();
  }

  private cycleTab(delta: number) {
    if (this.tabs.length < 2) return;
    this.switchTab((this.activeTab + delta + this.tabs.length) % this.tabs.length);
  }

  // ---- listing --------------------------------------------------------------------------------

  /**
   * Lists the active tab's folder. A fresh load restores the tab's saved scroll and shows a
   * spinner if it is slow; a live one keeps the current scroll and selection.
   */
  private async load(mode: "fresh" | "live") {
    const tab = this.tab;
    const path = tab.path;
    if (!path) return;
    const token = ++this.loadToken;
    const scroll = mode === "live" ? this.view.getScroll() : tab.scroll;
    const slow = mode === "fresh"
      ? window.setTimeout(() => {
          if (token === this.loadToken && !this.disposed) this.setState(loadingState());
        }, 180)
      : undefined;
    try {
      const raw = await fsApi.list(path, this.settings.showHidden);
      if (token !== this.loadToken || this.disposed) return;
      this.raw = raw;
      this.sorted = sortEntries(raw, this.settings.sort, this.settings.foldersFirst);
      this.error = null;
      this.loaded = true;
      this.settings.lastPath = path;
      this.shell.saveConfig();
      this.apply(mode === "live", scroll);
    } catch (err) {
      if (token !== this.loadToken || this.disposed) return;
      this.raw = this.sorted = this.visible = [];
      this.error = err instanceof Error ? err.message : String(err);
      this.loaded = true;
      this.view.setEntries([], false);
      this.setState(errorState(this.error, () => this.goHome()));
      this.updateStatus();
      this.syncWatches();
    } finally {
      clearTimeout(slow);
    }
  }

  /** Filters the sorted listing, hands it to the view and refreshes the bars. */
  private apply(keep: boolean, scroll: number) {
    this.visible = filterEntries(this.sorted, this.query);
    this.pruneSelection();
    this.view.setEntries(this.visible, keep);
    this.view.setScroll(scroll);
    const focus = this.tab.sel.focus;
    if (!keep && scroll === 0 && focus) this.view.reveal(focus);
    this.setState(this.visible.length === 0 ? emptyState(this.query.trim()) : null);
    this.updateStatus();
    this.syncWatches();
  }

  /** Forgets selected items of this folder that are no longer listed. */
  private pruneSelection() {
    const sel = this.tab.sel;
    if (sel.selection.size === 0 && !sel.focus) return;
    const here = this.tab.path;
    const present = new Set(this.visible.map((e) => e.path));
    const gone = (p: string) => !present.has(p) && samePath(parentOf(p), here);
    for (const p of sel.selection) if (gone(p)) sel.selection.delete(p);
    if (sel.focus && gone(sel.focus)) sel.focus = null;
    if (sel.anchor && gone(sel.anchor)) sel.anchor = null;
  }

  private setState(node: HTMLElement | null) {
    this.overlay.replaceChildren(...(node ? [node] : []));
    this.overlay.hidden = !node;
  }

  private setQuery(query: string) {
    this.query = query;
    clearTimeout(this.searchTimer);
    // A short pause keeps typing smooth in folders with 100,000 entries.
    this.searchTimer = window.setTimeout(() => {
      if (this.error !== null) return;
      this.apply(true, 0);
    }, this.sorted.length > 20000 ? 120 : 30);
  }

  private onFolderChanged(folder: string) {
    if (!this.active || this.disposed) return;
    if (this.tab.path && samePath(folder, this.tab.path)) {
      clearTimeout(this.liveTimer);
      this.liveTimer = window.setTimeout(() => void this.load("live"), 60);
    } else {
      this.view.folderChanged?.(folder);
    }
  }

  // ---- watching -------------------------------------------------------------------------------

  private addViewWatch(path: string) {
    this.viewWatch.set(path, (this.viewWatch.get(path) ?? 0) + 1);
    this.syncWatches();
  }

  private removeViewWatch(path: string) {
    const n = (this.viewWatch.get(path) ?? 0) - 1;
    if (n > 0) this.viewWatch.set(path, n);
    else this.viewWatch.delete(path);
    this.syncWatches();
  }

  /** Watches exactly the folders on screen, and none while the module is hidden. */
  private syncWatches() {
    const want = new Set<string>();
    if (this.active && !this.disposed) {
      if (this.tab.path && this.error === null) want.add(this.tab.path);
      for (const path of this.viewWatch.keys()) want.add(path);
    }
    for (const path of this.watched) {
      if (want.has(path)) continue;
      this.watched.delete(path);
      fsApi.unwatch(path).catch(() => {});
    }
    for (const path of want) {
      if (this.watched.has(path)) continue;
      this.watched.add(path);
      fsApi.watch(path).catch((err) => console.warn("Could not watch", path, err));
    }
  }

  // ---- views ----------------------------------------------------------------------------------

  private mountView() {
    const kind = this.settings.view;
    if (kind === this.viewKind) return;
    if (this.view) {
      this.view.el.remove();
      this.view.dispose();
    }
    this.viewKind = kind;
    switch (kind) {
      case "list": this.view = new ListView(this.ctx); break;
      case "column": this.view = new ColumnView(this.ctx); break;
      case "gallery": this.view = new GalleryView(this.ctx); break;
      default: this.view = new IconView(this.ctx);
    }
    this.content.prepend(this.view.el);
    this.sliderBox.hidden = kind !== "icon";
  }

  private setView(kind: FilesView) {
    if (kind === this.settings.view) return;
    this.settings.view = kind;
    this.shell.saveConfig();
    this.mountView();
    this.updateToolbar();
    if (this.loaded) {
      this.view.setEntries(this.visible, false);
      const focus = this.tab.sel.focus;
      if (focus) this.view.reveal(focus);
      this.updateStatus();
    }
  }

  private toggleHidden() {
    this.settings.showHidden = !this.settings.showHidden;
    this.shell.saveConfig();
    this.updateToolbar();
    void this.load("live");
  }

  private sortBy(key: FilesSortKey) {
    const sort = this.settings.sort;
    this.setSort(key, sort.key === key ? !sort.ascending : true);
  }

  private setSort(key: FilesSortKey, ascending: boolean) {
    this.settings.sort = { key, ascending };
    this.shell.saveConfig();
    this.resort();
  }

  private resort() {
    this.sorted = sortEntries(this.raw, this.settings.sort, this.settings.foldersFirst);
    this.apply(true, this.view.getScroll());
  }

  // ---- opening and menus ----------------------------------------------------------------------

  private openEntry(entry: FsEntry, folder: FsEntry[] = this.visible) {
    if (entry.dir) {
      this.navigate(entry.path);
    } else if (isImageExt(entry.ext)) {
      this.shell.open({ kind: "image", path: entry.path, siblings: folder.filter((e) => isImageExt(e.ext)).map((e) => e.path) });
    } else if (isVideoExt(entry.ext)) {
      this.shell.open({ kind: "video", path: entry.path, siblings: folder.filter((e) => isVideoExt(e.ext)).map((e) => e.path) });
    } else {
      this.shell.openExternally(entry.path);
    }
  }

  private isPinned(path: string) {
    return this.settings.pinned.some((p) => samePath(p, path));
  }

  pin(path: string) {
    if (this.isPinned(path)) return;
    this.settings.pinned.push(path);
    this.shell.saveConfig();
    this.hooks.pinsChanged();
  }

  unpin(path: string) {
    this.settings.pinned = this.settings.pinned.filter((p) => !samePath(p, path));
    this.shell.saveConfig();
    this.hooks.pinsChanged();
  }

  private sortItems(): MenuItem[] {
    const { sort, foldersFirst } = this.settings;
    return [
      ...SORT_KEYS.map(({ key, label }): MenuItem => ({
        label: `Sort by ${label}`, icon: sort.key === key ? "check" : undefined, action: () => this.setSort(key, sort.ascending),
      })),
      "separator",
      { label: "Ascending", icon: sort.ascending ? "check" : undefined, action: () => this.setSort(sort.key, true) },
      { label: "Descending", icon: sort.ascending ? undefined : "check", action: () => this.setSort(sort.key, false) },
      "separator",
      {
        label: "Folders on Top", icon: foldersFirst ? "check" : undefined,
        action: () => {
          this.settings.foldersFirst = !foldersFirst;
          this.shell.saveConfig();
          this.resort();
        },
      },
    ];
  }

  private contextMenu(e: MouseEvent, entry: FsEntry | null) {
    e.preventDefault();
    const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
    let items: MenuItem[];
    const ctx = this.context;
    const extra = (groups: MenuItem[][]) => groups.filter((g) => g.length).flatMap((g): MenuItem[] => ["separator", ...g]);
    if (entry) {
      const entries = this.tab.sel.selection.has(entry.path) ? ctx.selected() : [entry];
      const pinned = this.isPinned(entry.path);
      items = [
        { label: "Open", icon: iconNameFor(categoryOf(entry)), action: () => this.openEntry(entry, this.view.focused()?.folder) },
        ...(entry.dir ? [{ label: "Open in New Tab", icon: "plus" as const, action: () => this.newTab(entry.path) }] : []),
        { label: "Open with Default App", icon: "external", action: () => this.shell.openExternally(entry.path) },
        "separator",
        { label: "Copy Path", icon: "copy", action: () => copy(entry.path) },
        { label: "Copy Name", icon: "tag", action: () => copy(entry.name) },
        ...(entry.dir
          ? ["separator" as const, {
              label: pinned ? "Remove from Sidebar" : "Pin to Sidebar", icon: "star" as const,
              action: () => (pinned ? this.unpin(entry.path) : this.pin(entry.path)),
            }]
          : []),
        ...extra(this.extensions.map((x) => x.itemMenu?.(entries, ctx) ?? [])),
      ];
    } else {
      items = [
        ...VIEW_ITEMS.map(({ view, label }): MenuItem => ({
          label: `View ${label}`, icon: this.settings.view === view ? "check" : undefined, action: () => this.setView(view),
        })),
        "separator",
        ...this.sortItems(),
        "separator",
        {
          label: this.settings.showHidden ? "Hide Hidden Files" : "Show Hidden Files",
          icon: this.settings.showHidden ? "eyeOff" : "eye",
          action: () => this.toggleHidden(),
        },
        { label: "New Tab", icon: "plus", action: () => this.newTab() },
        ...extra(this.extensions.map((x) => x.emptyMenu?.(ctx) ?? [])),
      ];
    }
    openMenu(e.clientX, e.clientY, items);
  }

  // ---- bars -----------------------------------------------------------------------------------

  private updateToolbar() {
    this.toolbar.update({
      canBack: this.tab.canBack,
      canForward: this.tab.canForward,
      path: this.tab.path,
      view: this.settings.view,
      showHidden: this.settings.showHidden,
    });
    this.tabBar.render(this.tabs, this.activeTab);
  }

  /** Free bytes on the volume that holds the current folder. */
  private freeSpace(): number | null {
    let best: Volume | null = null;
    for (const v of this.volumes) {
      if (isInside(this.tab.path, v.path) && (!best || v.path.length > best.path.length)) best = v;
    }
    return best ? best.free : null;
  }

  private updateStatus() {
    const { items, selected } = this.view.status();
    const parts = [`${items.toLocaleString()} ${items === 1 ? "item" : "items"}`];
    if (selected > 0) parts.push(`${selected.toLocaleString()} selected`);
    const free = this.freeSpace();
    if (free !== null) parts.push(`${formatBytes(free)} free`);
    this.statusText.textContent = parts.join("  ·  ");
  }

  // ---- keyboard -------------------------------------------------------------------------------

  handleKey(e: KeyboardEvent): boolean {
    const handled = this.route(e);
    if (handled) e.preventDefault();
    return handled;
  }

  private route(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey) {
      if (e.key === "Tab") {
        this.cycleTab(e.shiftKey ? -1 : 1);
        return true;
      }
      if (!e.shiftKey) {
        if (key === "t") return run(() => this.newTab());
        if (key === "w") return run(() => this.closeTab(this.activeTab));
        if (key === "h") return run(() => this.toggleHidden());
        if (key === "l") return run(() => this.toolbar.editPath());
        if (key === "f") return run(() => this.toolbar.focusSearch());
      }
    }
    if (isTypingTarget(e.target)) return false;
    const ctx = this.context;
    for (const extension of this.extensions) if (extension.handleKey?.(e, ctx)) return true;
    if (mod && !e.altKey && !e.shiftKey && key === "a") {
      this.view.selectAll();
      return true;
    }
    if (e.altKey && !mod) {
      if (e.key === "ArrowLeft") return run(() => this.back());
      if (e.key === "ArrowRight") return run(() => this.forward());
      if (e.key === "ArrowUp") return run(() => this.up());
      return false;
    }
    if (mod) return this.view.handleKey(e);
    if (e.key === "Backspace") return run(() => this.up());
    if (e.key === "Enter") {
      const focused = this.view.focused();
      if (focused) this.openEntry(focused.entry, focused.folder);
      return true;
    }
    if (e.key === "Escape") {
      if (this.query) {
        this.toolbar.clearSearch();
        return true;
      }
      const sel = this.tab.sel;
      if (sel.selection.size === 0) return false;
      sel.selection.clear();
      sel.anchor = null;
      this.view.renderSelection();
      this.updateStatus();
      return true;
    }
    return this.view.handleKey(e);
  }
}
