import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "../../api";
import { fsApi, type FsEntry, type Place, type Volume } from "../../modules/files/api";
import "../../modules/files/files.css";
import { categoryOf, folderGlyph, iconNameFor, iconNode, kindLabel, sizeText, volumeIcon } from "../../modules/files/kinds";
import { opsApi } from "../../modules/files/ops-api";
import { expandPath, folderName, joinPath, normalizePath, parentOf, samePath } from "../../modules/files/path";
import { PathBar } from "../../modules/files/pathbar";
import { clickSelect, moveSelect, newSel, selectAll, targetIndex, typeSelectIndex } from "../../modules/files/selection";
import { filterEntries, sortEntries } from "../../modules/files/sort";
import { VirtualList } from "../../modules/files/views/vlist";
import { basename, formatBytes, formatDateTime, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import type { DialogFilter } from "../dialog";
import { fileThumb } from "../file-thumbs";
import { ThumbLoader } from "../thumbs";
import "./filepicker.css";

/**
 * CorePro's own file chooser: Open, Choose Folder and Save As in the Files look (sidebar of
 * places and drives, path bar, list and icon views, thumbnails), in a glass sheet over the window
 * that asked. It uses the Files backend and a few of its light parts only, so it works with the
 * Files feature turned off and in every window.
 */

export type PickerMode = "open" | "folder" | "save";

export interface PickerOptions {
  mode: PickerMode;
  title?: string;
  filters?: DialogFilter[];
  /** A folder to start in, or a file (its folder, with the file selected or named). */
  defaultPath?: string;
  multiple?: boolean;
}

type SortKey = "name" | "date" | "size" | "kind";
type ViewKind = "list" | "icon";

const PLACE_ICONS: Record<string, IconName> = {
  home: "home", desktop: "desktop", documents: "document", downloads: "download", pictures: "image", videos: "video", music: "music",
};
const ROW = 28;
const TILE_W = 104;
const TILE_H = 64 + 56;
const RECENT_MAX = 6;

// ---- remembered choices (per viewer; any failure just forgets) ------------------------------

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`corepro.picker.${key}`);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(`corepro.picker.${key}`, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: nothing to remember.
  }
}

/** Matches `entry` against a type filter; "*" (or no filter) takes every file. */
function fits(entry: FsEntry, filter: DialogFilter | undefined): boolean {
  if (entry.dir || !filter) return true;
  const exts = filter.extensions.map((e) => e.toLowerCase().replace(/^\*?\./, ""));
  return exts.includes("*") || exts.includes(entry.ext.toLowerCase());
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

let current: { cancel(): void } | null = null;

/** Shows the picker; resolves with the chosen paths, or null when cancelled. */
export function runPicker(options: PickerOptions): Promise<string[] | null> {
  current?.cancel();
  return new Promise((resolve) => {
    const picker = new FilePicker(options, (paths) => {
      if (current === picker) current = null;
      resolve(paths);
    });
    current = picker;
    void picker.start();
  });
}

class FilePicker {
  private readonly mode: PickerMode;
  private readonly memory: string;
  private readonly filters: DialogFilter[];
  private filterIndex = 0;
  private dir = "";
  private home = "/";
  private raw: FsEntry[] = [];
  private shown: FsEntry[] = [];
  private sel = newSel();
  private back: string[] = [];
  private forward: string[] = [];
  private view: ViewKind = stored<ViewKind>("view", "list");
  private sort: { key: SortKey; ascending: boolean } = stored("sort", { key: "name", ascending: true });
  private hidden = stored("hidden", false);
  private token = 0;
  private problem: null | { kind: "locked" | "error"; text: string } = null;
  private loading = false;
  private closed = false;
  private cols = 4;
  private places: Place[] = [];
  private volumes: Volume[] = [];
  private pinned: string[] = [];
  private unlisten: Promise<UnlistenFn>[] = [];
  private readonly thumbs = new ThumbLoader(6);
  private readonly previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // ---- elements
  private readonly overlay: HTMLElement;
  private readonly sidebar = h("nav", { class: "fs-sidebar fp-sidebar", "aria-label": "Places" });
  private readonly backBtn = this.toolButton("back", "Back (Alt+←)", () => this.goBack());
  private readonly forwardBtn = this.toolButton("chevronRight", "Forward (Alt+→)", () => this.goForward());
  private readonly upBtn = this.toolButton("arrowUp", "Enclosing Folder (Alt+↑)", () => this.goUp());
  private readonly pathbar = new PathBar({ navigate: (p) => void this.navigate(p), submit: (t) => void this.typedPath(t) });
  private readonly search = h("input", { class: "search-input", type: "search", placeholder: "Filter", "aria-label": "Filter this folder", spellcheck: "false" });
  private readonly viewButtons: [ViewKind, HTMLButtonElement][];
  private readonly body = h("div", { class: "fp-view", tabindex: "0", role: "listbox", "aria-label": "Files", style: "--iv-icon: 64px" });
  private readonly state = h("div", { class: "fs-state fp-state" });
  private list: VirtualList | null = null;
  private header: HTMLElement | null = null;
  private readonly nameInput = h("input", { class: "fp-name", type: "text", spellcheck: "false", autocomplete: "off", "aria-label": "Name" });
  private readonly typeSelect = h("select", { class: "fp-type", "aria-label": "File type" });
  private readonly summary = h("span", { class: "fp-summary" });
  private readonly primary = h("button", { class: "btn primary", type: "button" });

  constructor(private readonly options: PickerOptions, private readonly done: (paths: string[] | null) => void) {
    this.mode = options.mode;
    this.memory = options.title ?? options.mode;
    const filters = (options.filters ?? []).filter((f) => f.extensions.length);
    // Open offers "All files" after the filters given, as file choosers do; Save keeps to its formats.
    if (this.mode === "open" && filters.length && !filters.some((f) => f.extensions.includes("*"))) filters.push({ name: "All Files", extensions: ["*"] });
    this.filters = this.mode === "folder" ? [] : filters;
    this.viewButtons = (["list", "icon"] as ViewKind[]).map((v) => [v, h("button", {
      type: "button", title: v === "list" ? "List" : "Icons", "aria-label": v === "list" ? "List" : "Icons",
      onclick: () => this.setView(v),
    }, icon(v === "list" ? "list" : "grid", 15))]);

    const title = options.title ?? (this.mode === "save" ? "Save As" : this.mode === "folder" ? "Choose Folder" : options.multiple ? "Open Files" : "Open File");
    const more = this.toolButton("more", "More", () => {
      const r = more.getBoundingClientRect();
      openMenu(r.right - 220, r.bottom + 4, [
        { label: `${this.hidden ? "✓ " : ""}Show Hidden Files`, icon: "eye", shortcut: "Ctrl+H", action: () => this.toggleHidden() },
        { label: "New Folder…", icon: "folderPlus", shortcut: "Ctrl+Shift+N", action: () => this.newFolder() },
        "separator",
        ...(["name", "date", "size", "kind"] as SortKey[]).map((k) => ({
          label: `${this.sort.key === k ? (this.sort.ascending ? "↑ " : "↓ ") : ""}Sort by ${k === "date" ? "Date Modified" : k[0].toUpperCase() + k.slice(1)}`,
          action: () => this.setSort(k),
        })),
      ]);
    });
    const newFolderBtn = this.toolButton("folderPlus", "New Folder (Ctrl+Shift+N)", () => this.newFolder());
    this.search.addEventListener("input", () => this.apply(true));
    const toolbar = h("div", { class: "fp-toolbar" },
      h("div", { class: "fs-nav" }, this.backBtn, this.forwardBtn, this.upBtn),
      this.pathbar.el,
      h("label", { class: "search fp-search" }, icon("search", 14), this.search),
      h("div", { class: "segmented fp-views" }, ...this.viewButtons.map(([, b]) => b)),
      newFolderBtn, more);

    const foot = h("div", { class: "fp-foot" });
    if (this.mode === "save") {
      foot.append(h("label", { class: "fp-field" }, h("span", null, "Name"), this.nameInput));
      this.nameInput.addEventListener("input", () => this.refreshFoot());
    }
    if (this.filters.length) {
      for (const [i, f] of this.filters.entries()) {
        const exts = f.extensions.includes("*") ? "" : ` (${f.extensions.map((e) => `.${e}`).join(", ")})`;
        this.typeSelect.append(h("option", { value: String(i) }, `${f.name}${exts}`));
      }
      this.typeSelect.addEventListener("change", () => this.setFilter(Number(this.typeSelect.value)));
      foot.append(this.typeSelect);
    }
    this.primary.textContent = this.mode === "save" ? "Save" : this.mode === "folder" ? "Select Folder" : "Open";
    this.primary.addEventListener("click", () => void this.accept());
    foot.append(this.summary, h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: () => this.finish(null) }, "Cancel"), this.primary);

    const card = h("div", { class: "modal fp", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "fp-head" },
        h("span", { class: "fp-head-icon" }, icon(this.mode === "save" ? "save" : this.mode === "folder" ? "folder" : "open", 16)),
        h("h2", null, title), h("span", { class: "spacer" }),
        h("button", { class: "icon-btn small", type: "button", title: "Cancel (Esc)", "aria-label": "Cancel", onclick: () => this.finish(null) }, icon("close", 14))),
      h("div", { class: "fp-body" }, this.sidebar, h("div", { class: "fp-main" }, toolbar, h("div", { class: "fp-content" }, this.body, this.state))),
      foot);
    this.overlay = h("div", { class: "modal-overlay fp-overlay" }, card);
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.finish(null);
    });
    // The window's capture phase runs before any other listener (a dialog under the picker
    // catching keys on the document, the shell's shortcuts), so the picker on top gets its keys.
    window.addEventListener("keydown", this.onWindowKey, true);
    this.bindView();
    this.wire();
  }

  cancel() {
    this.finish(null);
  }

  private readonly onWindowKey = (e: KeyboardEvent) => {
    // A picker opened over this one, or its own Replace question, takes the key instead.
    const pickers = document.querySelectorAll(".fp-overlay");
    if (pickers[pickers.length - 1] !== this.overlay || document.querySelector(".fp-confirm")) return;
    // A menu opened from the picker (More, Sort) handles its own keys.
    if (document.querySelector("body > .menu")) return;
    e.stopPropagation();
    this.key(e);
  };

  // ---- start and finish

  async start() {
    document.body.append(this.overlay);
    document.body.classList.add("file-picker-open");
    this.drawViewButtons();
    this.home = await homeDir().catch(() => "/");
    const [places, volumes] = await Promise.all([fsApi.places().catch(() => []), fsApi.volumes().catch(() => [])]);
    this.places = places.filter((p) => p.kind !== "trash");
    this.volumes = volumes;
    this.pinned = await api.loadConfig()
      .then((raw) => {
        const files = raw ? (JSON.parse(raw) as { files?: { pinned?: unknown } }).files : undefined;
        return Array.isArray(files?.pinned) ? files.pinned.filter((p): p is string => typeof p === "string") : [];
      })
      .catch(() => []);
    this.drawSidebar();
    let start = stored<string | null>(`dir:${this.memory}`, null) ?? this.home;
    let select: string | null = null;
    const wanted = this.options.defaultPath?.trim();
    if (wanted) {
      const path = wanted.includes("/") ? expandPath(wanted, this.home) : null;
      const name = basename(wanted);
      const stat = path ? await fsApi.stat(path).catch(() => null) : null;
      if (stat?.dir) start = path!;
      else if (path) {
        start = parentOf(path);
        if (stat) select = path;
      }
      if (this.mode === "save" && (!stat || !stat.dir)) this.nameInput.value = name;
    }
    this.unlisten.push(listen<boolean>("lock-changed", (e) => {
      if (!e.payload && this.problem?.kind === "locked") void this.load(this.dir);
    }));
    this.unlisten.push(getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length) void this.dropped(event.payload.paths);
    }));
    this.refreshFoot();
    await this.navigate(start, false, select);
    if (this.problem && !samePath(start, this.home)) await this.navigate(this.home, false);
    if (this.mode === "save") {
      this.nameInput.focus();
      const stem = this.nameInput.value.lastIndexOf(".");
      this.nameInput.setSelectionRange(0, stem > 0 ? stem : this.nameInput.value.length);
    } else this.body.focus();
  }

  private finish(paths: string[] | null) {
    if (this.closed) return;
    this.closed = true;
    if (paths?.length) {
      store(`dir:${this.memory}`, this.dir);
      const recent = [this.dir, ...stored<string[]>("recent", []).filter((p) => !samePath(p, this.dir))].slice(0, RECENT_MAX);
      store("recent", recent);
    }
    for (const u of this.unlisten) void u.then((fn) => fn());
    window.removeEventListener("keydown", this.onWindowKey, true);
    this.overlay.remove();
    if (!document.querySelector(".fp-overlay")) document.body.classList.remove("file-picker-open");
    if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
    this.done(paths);
  }

  // ---- navigation

  private async navigate(path: string, record = true, select: string | null = null) {
    const target = normalizePath(path);
    if (record && this.dir && !samePath(target, this.dir)) {
      this.back.push(this.dir);
      this.forward = [];
    }
    await this.load(target, select);
  }

  private async load(dir: string, select: string | null = null) {
    const token = ++this.token;
    this.dir = dir;
    this.pathbar.setPath(dir);
    this.loading = true;
    const spinner = window.setTimeout(() => token === this.token && this.loading && this.drawState(), 150);
    let entries: FsEntry[] = [];
    try {
      entries = await fsApi.list(dir, this.hidden);
      this.problem = null;
    } catch (err) {
      const text = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
      this.problem = text === "locked" ? { kind: "locked", text } : { kind: "error", text };
    }
    clearTimeout(spinner);
    if (token !== this.token || this.closed) return;
    this.loading = false;
    this.raw = entries;
    this.sel = newSel();
    this.search.value = "";
    this.apply(false);
    if (select) {
      const i = this.shown.findIndex((e) => samePath(e.path, select));
      if (i >= 0) {
        moveSelect(this.sel, this.shown, i, false, (p) => this.indexOf(p));
        this.list?.scrollTo(this.rowOf(i), "center");
      }
    }
    this.paint();
    this.drawSidebar();
    this.backBtn.disabled = !this.back.length;
    this.forwardBtn.disabled = !this.forward.length;
    this.upBtn.disabled = samePath(parentOf(dir), dir);
    this.refreshFoot();
  }

  private goBack() {
    const to = this.back.pop();
    if (!to) return;
    this.forward.push(this.dir);
    void this.load(to);
  }

  private goForward() {
    const to = this.forward.pop();
    if (!to) return;
    this.back.push(this.dir);
    void this.load(to);
  }

  private goUp() {
    const up = parentOf(this.dir);
    if (!samePath(up, this.dir)) void this.navigate(up, true, this.dir);
  }

  /** A path typed into the path bar: a folder opens; a file is picked (Open) or named (Save). */
  private async typedPath(text: string) {
    if (!text.trim()) return;
    const path = expandPath(text, this.home);
    const stat = await fsApi.stat(path).catch(() => null);
    if (stat?.dir) return void this.navigate(path);
    if (stat && this.mode === "open" && fits(stat, this.filters[this.filterIndex])) return this.finish([path]);
    if (this.mode === "save") {
      const parent = await fsApi.stat(parentOf(path)).catch(() => null);
      if (parent?.dir) {
        this.nameInput.value = basename(path);
        await this.navigate(parentOf(path));
        return void this.accept();
      }
    }
    this.flash(stat ? "That file doesn't fit here." : `“${text}” doesn't exist.`);
  }

  /** Files dropped on the window while the picker shows: their folder opens, the file selected. */
  private async dropped(paths: string[]) {
    const first = paths[0];
    const stat = await fsApi.stat(first).catch(() => null);
    if (!stat) return;
    if (stat.dir && this.mode !== "save") return void this.navigate(first);
    await this.navigate(stat.dir ? first : parentOf(first), true, stat.dir ? null : first);
    if (this.mode === "save" && !stat.dir) {
      this.nameInput.value = stat.name;
      this.refreshFoot();
    }
  }

  // ---- what shows

  /** Sorts and filters the listing; `keepSelection` keeps what's still there selected. */
  private apply(keepSelection: boolean) {
    const filter = this.filters[this.filterIndex];
    let list = this.raw.filter((e) => (this.mode === "folder" ? e.dir : fits(e, filter)));
    list = filterEntries(list, this.search.value);
    this.shown = sortEntries(list, this.sort, true);
    if (!keepSelection) this.sel = newSel();
    else {
      const still = new Set(this.shown.map((e) => e.path));
      for (const p of [...this.sel.selection]) if (!still.has(p)) this.sel.selection.delete(p);
    }
    this.layout();
    this.drawState();
    this.refreshFoot();
  }

  private indexOf(path: string) {
    return this.shown.findIndex((e) => e.path === path);
  }

  private selected(): FsEntry[] {
    return this.shown.filter((e) => this.sel.selection.has(e.path));
  }

  private rowOf(index: number) {
    return this.view === "icon" ? Math.floor(index / this.cols) : index;
  }

  private drawState() {
    const card = (glyph: IconName, title: string, text: string) =>
      h("div", { class: "fs-state-card plain" }, h("div", { class: "fs-state-icon" }, icon(glyph, 28)), h("h2", null, title), h("p", null, text));
    let content: HTMLElement | null = null;
    if (this.loading) content = h("span", { class: "spinner large" });
    else if (this.problem?.kind === "locked") content = card("lock", "CorePro is locked", "Unlock CorePro to browse your files.");
    else if (this.problem) content = card("info", "Can't open this folder", this.problem.text);
    else if (!this.shown.length) {
      content = this.search.value.trim()
        ? card("search", "Nothing matches", `No item here has “${this.search.value.trim()}” in its name.`)
        : this.mode === "folder"
          ? card("folder", "No folders in here", "Select Folder picks this one, or make one with New Folder.")
          : card("folder", this.raw.length ? "No matching files" : "This folder is empty", this.raw.length ? "Choose another file type below, or look in another folder." : "");
    }
    this.state.replaceChildren(...(content ? [content] : []));
    this.state.hidden = !content;
  }

  private setView(view: ViewKind) {
    if (this.view === view) return;
    this.view = view;
    store("view", view);
    this.bindView();
    this.drawViewButtons();
    this.layout();
    this.body.focus();
  }

  private drawViewButtons() {
    for (const [v, b] of this.viewButtons) b.classList.toggle("active", v === this.view);
  }

  private setSort(key: SortKey) {
    this.sort = this.sort.key === key ? { key, ascending: !this.sort.ascending } : { key, ascending: key === "name" || key === "kind" };
    store("sort", this.sort);
    this.apply(true);
    this.drawHeader();
  }

  private toggleHidden() {
    this.hidden = !this.hidden;
    store("hidden", this.hidden);
    void this.load(this.dir);
  }

  private setFilter(index: number) {
    const before = this.filters[this.filterIndex];
    this.filterIndex = index;
    const after = this.filters[index];
    // Save: the name's extension follows the chosen format.
    if (this.mode === "save" && after && !after.extensions.includes("*")) {
      const name = this.nameInput.value;
      const ext = extOf(name);
      const known = before?.extensions.map((e) => e.toLowerCase()).includes(ext) || this.filters.some((f) => f.extensions.includes(ext));
      if (name && ext && known) this.nameInput.value = `${name.slice(0, name.length - ext.length)}${after.extensions[0]}`;
      else if (name && !ext) this.nameInput.value = `${name}.${after.extensions[0]}`;
    }
    this.apply(true);
  }

  // ---- views

  private bindView() {
    this.list?.el.remove();
    this.header?.remove();
    this.header = null;
    const icons = this.view === "icon";
    this.list = new VirtualList({
      axis: "y",
      size: icons ? TILE_H : ROW,
      pad: icons ? 10 : 4,
      overscan: icons ? 2 : 8,
      create: () => (icons ? h("div", { class: "iv-row" }) : this.createRow()),
      bind: (el, i) => (icons ? this.bindTiles(el, i) : this.bindRow(el, i)),
      release: (el) => el.querySelectorAll("img").forEach((img) => this.thumbs.cancel(img)),
      onResize: (width) => {
        const cols = Math.max(1, Math.floor((width - 32) / TILE_W));
        if (icons && cols !== this.cols) {
          this.cols = cols;
          this.layout();
        }
      },
    });
    this.list.el.classList.add("fp-list");
    if (!icons) this.list.el.classList.add("lv-scroll");
    if (!icons) {
      this.header = h("div", { class: "lv-header fp-lv-header" });
      this.drawHeader();
      this.body.append(this.header);
    }
    this.body.classList.toggle("lv", !icons);
    this.body.append(this.list.el);
  }

  private drawHeader() {
    if (!this.header) return;
    const cols: [SortKey, string][] = [["name", "Name"], ["date", "Date Modified"], ["size", "Size"], ["kind", "Kind"]];
    this.header.replaceChildren(...cols.map(([k, label]) => h("button", {
      class: `lv-th ${k}${this.sort.key === k ? " sorted" : ""}`, type: "button", onclick: () => this.setSort(k),
    }, label, this.sort.key === k ? h("span", { class: "lv-sort" }, icon(this.sort.ascending ? "chevronUp" : "chevronDown", 11)) : null)));
  }

  private layout() {
    if (!this.list) return;
    this.list.setCount(this.view === "icon" ? Math.ceil(this.shown.length / this.cols) : this.shown.length);
    this.body.style.setProperty("--cols", String(this.cols));
  }

  private paint() {
    this.list?.refresh();
  }

  private createRow(): HTMLElement {
    return h("div", { class: "lv-row" },
      h("div", { class: "lv-cell name" }, h("span", { class: "lv-icon" }), h("span", { class: "lv-text" })),
      h("div", { class: "lv-cell date" }), h("div", { class: "lv-cell size" }), h("div", { class: "lv-cell kind" }));
  }

  private bindRow(el: HTMLElement, i: number) {
    const e = this.shown[i];
    if (!e) return;
    const [name, date, size, kind] = Array.from(el.children) as HTMLElement[];
    const category = categoryOf(e);
    const glyph = name.firstElementChild as HTMLElement;
    glyph.className = `lv-icon${e.dir ? " folder" : ""}`;
    glyph.replaceChildren(iconNode(iconNameFor(category), 16));
    (name.lastElementChild as HTMLElement).textContent = e.name;
    date.textContent = formatDateTime(e.mtime);
    size.textContent = sizeText(e);
    kind.textContent = kindLabel(e);
    el.dataset.index = String(i);
    el.title = e.name;
    el.classList.toggle("odd", i % 2 === 1);
    el.classList.toggle("selected", this.sel.selection.has(e.path));
    el.classList.toggle("focus", this.sel.focus === e.path);
    el.classList.toggle("hidden-file", e.hidden);
  }

  private bindTiles(row: HTMLElement, rowIndex: number) {
    const start = rowIndex * this.cols;
    const tiles = Array.from(row.children) as HTMLElement[];
    for (let k = 0; k < this.cols; k++) {
      const i = start + k;
      const e = this.shown[i];
      let tile = tiles[k];
      if (!e) {
        tile?.remove();
        continue;
      }
      if (!tile) {
        tile = h("div", { class: "iv-tile" }, h("div", { class: "iv-art" }), h("div", { class: "iv-name" }, h("span")));
        row.append(tile);
      }
      const art = tile.firstElementChild as HTMLElement;
      const category = categoryOf(e);
      if (art.dataset.path !== e.path) {
        art.dataset.path = e.path;
        art.querySelectorAll("img").forEach((img) => this.thumbs.cancel(img));
        art.className = `iv-art ${category}`;
        if (e.dir) art.replaceChildren(folderGlyph());
        else {
          const thumb = fileThumb(e, 64);
          const sheet = h("div", { class: `iv-sheet${thumb ? ` ${thumb.look}` : ""}` }, iconNode(iconNameFor(category), 28));
          if (!thumb) sheet.append(h("span", { class: "iv-ext" }, e.ext.toUpperCase().slice(0, 5)));
          else {
            const img = h("img", { class: "iv-thumb", alt: "", draggable: false, decoding: "async" });
            sheet.append(img);
            this.thumbs.load(img, thumb.source);
          }
          art.replaceChildren(sheet);
        }
      }
      (tile.lastElementChild!.firstElementChild as HTMLElement).textContent = e.name;
      tile.dataset.index = String(i);
      tile.title = e.dir ? e.name : `${e.name}\n${formatBytes(e.size)}`;
      tile.classList.toggle("selected", this.sel.selection.has(e.path));
      tile.classList.toggle("focus", this.sel.focus === e.path);
      tile.classList.toggle("hidden-file", e.hidden);
    }
    while (row.children.length > this.cols) row.lastElementChild!.remove();
  }

  // ---- pointer and keys

  private indexAt(target: EventTarget | null): number {
    const el = (target as HTMLElement | null)?.closest?.("[data-index]") as HTMLElement | null;
    return el && this.body.contains(el) ? Number(el.dataset.index) : -1;
  }

  private wire() {
    this.body.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const i = this.indexAt(e.target);
      this.body.focus({ preventScroll: true });
      if (i < 0) {
        if (!e.ctrlKey && !e.shiftKey) {
          this.sel = newSel();
          this.paint();
          this.refreshFoot();
        }
        return;
      }
      const multi = !!this.options.multiple;
      clickSelect(this.sel, this.shown, i, { ctrlKey: multi && e.ctrlKey, metaKey: multi && e.metaKey, shiftKey: multi && e.shiftKey }, (p) => this.indexOf(p));
      const entry = this.shown[i];
      if (this.mode === "save" && !entry.dir) {
        this.nameInput.value = entry.name;
      }
      this.paint();
      this.refreshFoot();
    });
    this.body.addEventListener("dblclick", (e) => {
      const i = this.indexAt(e.target);
      if (i >= 0) void this.activate(this.shown[i]);
    });
  }

  private key(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const lower = e.key.toLowerCase();
    const target = e.target as HTMLElement;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
    // Fields with their own keys: the window-level catch above stops their listeners, so the
    // picker does what they would.
    if (target.closest(".fp-newfolder")) {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        target.closest(".fp-newfolder")!.querySelector<HTMLButtonElement>(e.key === "Enter" ? ".fp-create" : ".fp-dismiss")!.click();
      }
      return;
    }
    if (target.classList.contains("pb-input")) {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        const text = (target as HTMLInputElement).value;
        target.blur();
        this.body.focus();
        if (e.key === "Enter") void this.typedPath(text);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (target === this.search && this.search.value) {
        this.search.value = "";
        this.apply(true);
        this.body.focus();
      } else this.finish(null);
      return;
    }
    if (mod && lower === "h") return this.handled(e, () => this.toggleHidden());
    if (mod && lower === "l") return this.handled(e, () => this.pathbar.edit());
    if (mod && lower === "f") return this.handled(e, () => (this.search.focus(), this.search.select()));
    if (mod && e.shiftKey && lower === "n") return this.handled(e, () => this.newFolder());
    if (e.altKey && e.key === "ArrowUp") return this.handled(e, () => this.goUp());
    if (e.altKey && e.key === "ArrowLeft") return this.handled(e, () => this.goBack());
    if (e.altKey && e.key === "ArrowRight") return this.handled(e, () => this.goForward());
    if (target === this.nameInput && e.key === "Enter") return this.handled(e, () => void this.accept());
    if (target === this.search) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        this.handled(e, () => {
          if (this.shown.length) moveSelect(this.sel, this.shown, 0, false, (p) => this.indexOf(p));
          this.paint();
          this.refreshFoot();
          this.body.focus();
          if (e.key === "Enter" && this.shown.length === 1) void this.activate(this.shown[0]);
        });
      }
      return;
    }
    if (typing) return;
    if (target !== this.body && !this.body.contains(target) && e.key !== "Enter") return;
    if (e.key === "Enter") return this.handled(e, () => void this.accept(true));
    if (e.key === "Backspace") return this.handled(e, () => this.goUp());
    if (mod && lower === "a" && this.options.multiple) {
      return this.handled(e, () => {
        selectAll(this.sel, this.shown);
        this.paint();
        this.refreshFoot();
      });
    }
    const index = this.sel.focus ? this.indexOf(this.sel.focus) : -1;
    const deltas = this.view === "icon"
      ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.cols, ArrowDown: this.cols }
      : { ArrowUp: -1, ArrowDown: 1 };
    const page = this.list ? this.list.pageItems * (this.view === "icon" ? this.cols : 1) : 10;
    let next = targetIndex(e.key, index, this.shown.length, deltas, page);
    if (next === null) {
      const typed = typeSelectIndex(e, this.shown, index);
      if (typed < 0) return;
      next = typed;
    }
    e.preventDefault();
    moveSelect(this.sel, this.shown, next, e.shiftKey && !!this.options.multiple, (p) => this.indexOf(p));
    const entry = this.shown[next];
    if (this.mode === "save" && entry && !entry.dir) this.nameInput.value = entry.name;
    this.list?.scrollTo(this.rowOf(next));
    this.paint();
    this.refreshFoot();
  }

  private handled(e: KeyboardEvent, run: () => void) {
    e.preventDefault();
    run();
  }

  // ---- choosing

  /** Double-click or Enter on an item: a folder opens; a file is chosen. */
  private async activate(entry: FsEntry) {
    if (entry.dir) return void this.navigate(entry.path);
    if (this.mode === "open") {
      const many = this.options.multiple && this.sel.selection.has(entry.path) ? this.selected().filter((e) => !e.dir).map((e) => e.path) : [entry.path];
      return this.finish(many);
    }
    if (this.mode === "save") {
      this.nameInput.value = entry.name;
      return void this.accept();
    }
  }

  /** The main button (or Enter): Open, Select Folder, Save. `fromList`: Enter in the file list. */
  private async accept(fromList = false) {
    if (this.problem) return;
    const chosen = this.selected();
    if (this.mode === "folder") {
      const folders = chosen.filter((e) => e.dir);
      if (fromList && folders.length === 1 && !this.options.multiple) return void this.navigate(folders[0].path);
      return this.finish(folders.length ? (this.options.multiple ? folders.map((e) => e.path) : [folders[0].path]) : [this.dir]);
    }
    if (this.mode === "open") {
      if (chosen.length === 1 && chosen[0].dir) return void this.navigate(chosen[0].path);
      const files = chosen.filter((e) => !e.dir).map((e) => e.path);
      if (files.length) this.finish(this.options.multiple ? files : [files[0]]);
      return;
    }
    // Save.
    if (fromList && chosen.length === 1 && chosen[0].dir) return void this.navigate(chosen[0].path);
    let name = this.nameInput.value.trim();
    if (!name) return this.nameInput.focus();
    if (name.includes("/")) return void this.typedPath(name);
    const filter = this.filters[this.filterIndex];
    if (!extOf(name) && filter && !filter.extensions.includes("*")) name = `${name}.${filter.extensions[0]}`;
    const path = joinPath(this.dir, name);
    const existing = await fsApi.stat(path).catch(() => null);
    if (existing?.dir) {
      this.nameInput.value = "";
      return void this.navigate(path);
    }
    if (existing && !(await this.confirmReplace(name))) {
      this.nameInput.focus();
      return;
    }
    this.finish([path]);
  }

  private refreshFoot() {
    const chosen = this.selected();
    if (this.mode === "open") {
      const files = chosen.filter((e) => !e.dir);
      this.primary.disabled = !!this.problem || (!files.length && !(chosen.length === 1 && chosen[0].dir));
      this.summary.textContent = files.length > 1 ? `${files.length} files selected` : "";
    } else if (this.mode === "folder") {
      const folders = chosen.filter((e) => e.dir);
      this.primary.disabled = !!this.problem;
      this.summary.textContent = folders.length > 1 ? `${folders.length} folders` : `Folder: ${folders[0]?.name ?? folderName(this.dir)}`;
      this.summary.title = folders[0]?.path ?? this.dir;
    } else {
      this.primary.disabled = !!this.problem || !this.nameInput.value.trim();
    }
  }

  private confirmReplace(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (yes: boolean) => {
        window.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(yes);
      };
      const replace = h("button", { class: "btn fp-danger", type: "button", onclick: () => done(true) }, "Replace");
      const overlay = h("div", { class: "modal-overlay fp-confirm" },
        h("div", { class: "modal fp-confirm-card", role: "alertdialog", "aria-label": `Replace ${name}?` },
          h("div", { class: "modal-body" },
            h("h2", null, `“${name}” already exists.`),
            h("p", null, "Do you want to replace it? Its contents will be overwritten.")),
          h("div", { class: "modal-foot" }, h("span", { class: "spacer" }),
            h("button", { class: "btn", type: "button", onclick: () => done(false) }, "Cancel"), replace)));
      const onKey = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          done(false);
        } else if (e.key === "Tab") {
          e.preventDefault();
          (document.activeElement === replace ? cancel : replace).focus();
        }
      };
      window.addEventListener("keydown", onKey, true);
      const cancel = overlay.querySelector<HTMLButtonElement>(".modal-foot .btn:not(.fp-danger)")!;
      document.body.append(overlay);
      requestAnimationFrame(() => replace.focus());
    });
  }

  // ---- new folder

  private newFolder() {
    if (this.problem) return;
    const input = h("input", { class: "fp-name", type: "text", value: "untitled folder", spellcheck: "false", "aria-label": "Folder name" });
    const error = h("p", { class: "fp-error" });
    const make = async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        const path = await opsApi.newFolder(this.dir, name);
        pop.remove();
        await this.load(this.dir, path);
        if (this.mode !== "save") this.body.focus();
        else this.nameInput.focus();
      } catch (err) {
        error.textContent = String(err);
      }
    };
    const pop = h("div", { class: "fp-newfolder glass-strong" },
      h("div", { class: "fp-newfolder-title" }, icon("folderPlus", 15), "New Folder"),
      input, error,
      h("div", { class: "fp-newfolder-foot" },
        h("button", { class: "btn small fp-dismiss", type: "button", onclick: () => (pop.remove(), this.body.focus()) }, "Cancel"),
        h("button", { class: "btn small primary fp-create", type: "button", onclick: () => void make() }, "Create")));
    this.overlay.querySelector(".fp-newfolder")?.remove();
    this.overlay.querySelector(".fp-content")!.append(pop);
    // After the key that opened it is done, so typing replaces the whole default name.
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  // ---- sidebar

  private drawSidebar() {
    const row = (glyph: IconName, name: string, path: string, extra?: Node) => {
      const item = h("button", {
        class: `sb-item${samePath(path, this.dir) ? " active" : ""}`, type: "button", title: path,
        onclick: () => void this.navigate(path),
      }, h("span", { class: "sb-icon" }, icon(glyph, 16)), h("span", { class: "sb-name" }, name));
      if (extra) {
        item.classList.add("sb-volume");
        item.append(extra);
      }
      return item;
    };
    const section = (label: string, items: HTMLElement[]): HTMLElement[] =>
      items.length ? [h("div", { class: "sb-section" }, h("div", { class: "sb-label" }, label), ...items)] : [];
    const known = new Set([...this.places.map((p) => normalizePath(p.path)), ...this.pinned.map(normalizePath)]);
    const recent = stored<string[]>("recent", []).filter((p) => !known.has(normalizePath(p))).slice(0, RECENT_MAX);
    const meter = (v: Volume) => {
      if (!v.total) return undefined;
      const used = 1 - v.free / v.total;
      return h("span", { class: `sb-usage${used > 0.9 ? " full" : ""}`, title: `${formatBytes(v.free)} free of ${formatBytes(v.total)}` },
        h("i", { style: { width: `${Math.round(used * 100)}%` } }));
    };
    this.sidebar.replaceChildren(
      ...section("Favourites", this.places.map((p) => row(PLACE_ICONS[p.kind] ?? "folder", p.name, p.path))),
      ...section("Pinned", this.pinned.map((p) => row("folder", folderName(p), p))),
      ...section("Recent", recent.map((p) => row("clock", folderName(p), p))),
      ...section("Devices", this.volumes.map((v) => row(volumeIcon(v), v.name, v.path, meter(v)))));
  }

  // ---- bits

  private toolButton(glyph: IconName, title: string, run: () => void): HTMLButtonElement {
    return h("button", { class: "icon-btn small", type: "button", title, "aria-label": title, onclick: run }, icon(glyph, 15));
  }

  private flash(text: string) {
    this.summary.textContent = text;
    this.summary.classList.add("fp-warn");
    window.setTimeout(() => {
      this.summary.classList.remove("fp-warn");
      this.refreshFoot();
    }, 3000);
  }
}
