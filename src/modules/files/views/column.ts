import { formatBytes, formatDateTime, h } from "../../../ui/dom";
import { photoThumbUrl } from "../../../shared/thumbs";
import type { FsEntry } from "../api";
import { categoryOf, folderGlyph, iconNameFor, iconNode, kindLabel } from "../kinds";
import { samePath } from "../path";
import { clickSelect, moveSelect, selectAll, targetIndex, typeSelectIndex } from "../selection";
import type { FileView, ViewContext } from "./types";
import { VirtualList } from "./vlist";

const ROW = 26;

interface Column {
  path: string;
  root: boolean;
  entries: FsEntry[];
  index: Map<string, number>;
  el: HTMLElement;
  list: VirtualList;
  /** The entry whose contents (or preview) the next column shows. */
  selected: string | null;
  note: HTMLElement;
}

/**
 * Column view (Miller columns): each column lists a folder; choosing a folder opens it to the
 * right, choosing a file shows a preview. The first column is the tab's folder.
 */
export class ColumnView implements FileView {
  readonly el = h("div", { class: "fv-scroll cv", tabIndex: 0 });
  private cols: Column[] = [];
  private active = 0;
  private rootPath = "";
  private preview: HTMLElement | null = null;
  private previewImg: HTMLImageElement | null = null;
  /** After → into a column that is still loading, select its first entry once it arrives. */
  private pendingFirst: Column | null = null;

  constructor(private readonly ctx: ViewContext) {}

  private makeColumn(path: string, root: boolean): Column {
    const note = h("div", { class: "cv-note" });
    const col: Column = {
      path,
      root,
      entries: [],
      index: new Map(),
      el: h("div", { class: "cv-col" }),
      list: undefined as unknown as VirtualList,
      selected: null,
      note,
    };
    col.list = new VirtualList({
      axis: "y",
      size: ROW,
      pad: 6,
      overscan: 6,
      create: () => this.createRow(),
      bind: (row, i) => this.bindRow(col, row, i),
    });
    col.list.el.classList.add("cv-list");
    col.el.append(col.list.el, note);
    const idx = (p: string) => col.index.get(p) ?? -1;
    const rowAt = (e: Event) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".cv-row");
      return row ? Number(row.dataset.i) : -1;
    };
    col.list.el.addEventListener("click", (e) => {
      const i = rowAt(e);
      if (i < 0) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) this.multiSelect(col, i, e, idx);
      else this.choose(col, col.entries[i].path);
    });
    col.list.el.addEventListener("dblclick", (e) => {
      const i = rowAt(e);
      if (i >= 0) this.ctx.open(col.entries[i], col.entries);
    });
    col.list.el.addEventListener("contextmenu", (e) => {
      const i = rowAt(e);
      if (i < 0) return;
      e.preventDefault();
      const entry = col.entries[i];
      if (!this.ctx.sel.selection.has(entry.path)) this.choose(col, entry.path);
      this.ctx.contextMenu(e, entry);
    });
    return col;
  }

  private createRow() {
    return h("div", { class: "cv-row" }, h("span", { class: "cv-icon" }), h("span", { class: "cv-label" }), h("span", { class: "cv-chev" }));
  }

  private bindRow(col: Column, row: HTMLElement, i: number) {
    const entry = col.entries[i];
    row.dataset.i = String(i);
    row.dataset.path = entry.path;
    row.title = entry.name;
    const category = categoryOf(entry);
    const [iconSlot, label, chev] = Array.from(row.children) as HTMLElement[];
    iconSlot.className = `cv-icon ${category}`;
    iconSlot.replaceChildren(iconNode(iconNameFor(category), 16));
    label.textContent = entry.name;
    chev.replaceChildren(...(entry.dir ? [iconNode("chevronRight", 12)] : []));
    this.paintRow(col, row);
  }

  private paintRow(col: Column, row: HTMLElement) {
    const path = row.dataset.path ?? "";
    const active = this.cols[this.active] === col;
    row.classList.toggle("selected", col.selected === path || (active && this.ctx.sel.selection.has(path)));
  }

  private paintAll() {
    this.cols.forEach((col, k) => {
      col.el.classList.toggle("active", k === this.active);
      col.list.forEachRendered((row) => this.paintRow(col, row));
    });
  }

  renderSelection() {
    // Cleared or replaced from outside: forget the trail's highlights.
    const { sel } = this.ctx;
    if (sel.selection.size === 0) {
      for (const col of this.cols) col.selected = null;
      this.truncate(this.active + 1);
      this.hidePreview();
    }
    this.paintAll();
  }

  private setColumnEntries(col: Column, entries: FsEntry[]) {
    col.entries = entries;
    col.index = new Map(entries.map((e, i) => [e.path, i]));
    col.note.textContent = "";
    col.note.className = "cv-note";
    col.list.setCount(entries.length);
    const k = this.cols.indexOf(col);
    // The selected entry vanished from disk: close what it opened.
    if (col.selected && !col.index.has(col.selected)) {
      col.selected = null;
      this.truncate(k + 1);
      this.hidePreview();
    }
  }

  setEntries(entries: FsEntry[]) {
    const path = this.ctx.path;
    if (this.cols.length && this.rootPath === path) {
      this.setColumnEntries(this.cols[0], entries);
      // A sort or hidden-files change affects the open folders too.
      for (const col of this.cols.slice(1)) this.reload(col);
      this.paintAll();
      this.ctx.statusChanged();
      return;
    }
    this.truncate(0);
    this.hidePreview();
    this.rootPath = path;
    const root = this.makeColumn(path, true);
    this.cols = [root];
    this.active = 0;
    this.el.append(root.el);
    this.setColumnEntries(root, entries);
    const { sel } = this.ctx;
    if (sel.focus && root.index.has(sel.focus)) this.choose(root, sel.focus);
    else {
      sel.selection = new Set();
      this.paintAll();
    }
  }

  private async reload(col: Column) {
    try {
      const entries = await this.ctx.listFolder(col.path);
      if (this.cols.includes(col)) this.setColumnEntries(col, entries);
    } catch {
      // The folder went away; its parent's change event closes the column.
    }
  }

  folderChanged(path: string) {
    const col = this.cols.find((c) => !c.root && samePath(c.path, path));
    if (col) void this.reload(col);
  }

  /** Makes `path` the selected entry of `col`, opening its folder or preview to the right. */
  private choose(col: Column, path: string) {
    const k = this.cols.indexOf(col);
    const i = col.index.get(path);
    if (k < 0 || i === undefined) return;
    const entry = col.entries[i];
    this.truncate(k + 1);
    this.hidePreview();
    col.selected = path;
    this.active = k;
    const { sel } = this.ctx;
    sel.selection = new Set([path]);
    sel.anchor = sel.focus = path;
    if (entry.dir) void this.openFolder(entry.path);
    else this.showPreview(entry);
    col.list.scrollTo(i);
    this.paintAll();
    this.ctx.selectionChanged();
    this.scrollToEnd();
  }

  /** Ctrl- or Shift-click inside one column: a plain multi-selection with nothing opened. */
  private multiSelect(col: Column, i: number, e: MouseEvent, idx: (p: string) => number) {
    const k = this.cols.indexOf(col);
    this.truncate(k + 1);
    this.hidePreview();
    col.selected = null;
    this.active = k;
    clickSelect(this.ctx.sel, col.entries, i, e, idx);
    this.paintAll();
    this.ctx.selectionChanged();
  }

  private async openFolder(path: string) {
    const col = this.makeColumn(path, false);
    col.el.classList.add("loading");
    this.cols.push(col);
    this.el.append(col.el);
    this.ctx.watch(path);
    try {
      const entries = await this.ctx.listFolder(path);
      if (!this.cols.includes(col)) return;
      col.el.classList.remove("loading");
      this.setColumnEntries(col, entries);
      if (entries.length === 0) col.note.textContent = "Empty";
      if (this.pendingFirst === col) {
        this.pendingFirst = null;
        if (entries.length) this.choose(col, entries[0].path);
      }
    } catch (err) {
      if (!this.cols.includes(col)) return;
      col.el.classList.remove("loading");
      col.note.classList.add("error");
      col.note.textContent = err instanceof Error ? err.message : String(err);
    }
    this.ctx.statusChanged();
  }

  private truncate(count: number) {
    while (this.cols.length > count) {
      const col = this.cols.pop()!;
      if (this.pendingFirst === col) this.pendingFirst = null;
      col.list.dispose();
      col.el.remove();
      if (!col.root) this.ctx.unwatch(col.path);
    }
    if (this.active >= this.cols.length) this.active = Math.max(0, this.cols.length - 1);
  }

  private showPreview(entry: FsEntry) {
    const category = categoryOf(entry);
    let art: HTMLElement;
    if (category === "image") {
      const img = h("img", { class: "cv-pv-img", alt: "", draggable: false, decoding: "async" });
      this.previewImg = img;
      this.ctx.thumbs.load(img, photoThumbUrl(entry, 260));
      art = h("div", { class: "cv-pv-art photo" }, img);
    } else if (category === "folder") {
      art = h("div", { class: "cv-pv-art" }, folderGlyph());
    } else {
      art = h("div", { class: `cv-pv-art sheet ${category}` }, iconNode(iconNameFor(category), 24));
    }
    const row = (label: string, value: string) => h("div", { class: "cv-pv-row" }, h("span", null, label), h("span", null, value));
    this.preview = h("div", { class: "cv-col cv-preview" },
      art,
      h("div", { class: "cv-pv-name", title: entry.name }, entry.name),
      h("div", { class: "cv-pv-kind" }, kindLabel(entry)),
      h("div", { class: "cv-pv-meta" },
        row("Size", entry.dir ? "—" : formatBytes(entry.size)),
        row("Modified", formatDateTime(entry.mtime))));
    this.el.append(this.preview);
  }

  private hidePreview() {
    if (this.previewImg) this.ctx.thumbs.cancel(this.previewImg);
    this.previewImg = null;
    this.preview?.remove();
    this.preview = null;
  }

  private scrollToEnd() {
    requestAnimationFrame(() => this.el.scrollTo({ left: this.el.scrollWidth, behavior: "smooth" }));
  }

  getScroll() {
    return this.cols[0]?.list.scroll ?? 0;
  }

  setScroll(value: number) {
    if (this.cols[0]) this.cols[0].list.scroll = value;
  }

  reveal(path: string) {
    const col = this.cols[this.active];
    const i = col?.index.get(path);
    if (col && i !== undefined) col.list.scrollTo(i);
  }

  private stepRight(): boolean {
    const next = this.cols[this.active + 1];
    if (!next) return true;
    if (next.entries.length) {
      this.choose(next, next.entries[0].path);
    } else if (next.el.classList.contains("loading")) {
      // Still loading: move there and pick the first entry on arrival.
      this.active = this.cols.indexOf(next);
      this.pendingFirst = next;
      this.paintAll();
    }
    return true;
  }

  private stepLeft(): boolean {
    if (this.active === 0) return true;
    const from = this.active;
    const prev = this.cols[from - 1];
    this.active = from - 1;
    this.truncate(from + 1);
    this.cols[from].selected = null;
    this.hidePreview();
    const { sel } = this.ctx;
    if (prev.selected) {
      sel.selection = new Set([prev.selected]);
      sel.anchor = sel.focus = prev.selected;
    }
    this.paintAll();
    this.ctx.selectionChanged();
    return true;
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.altKey || e.metaKey) return false;
    const col = this.cols[this.active];
    if (!col) return false;
    if (!e.ctrlKey && !e.shiftKey && e.key === "ArrowRight") return this.stepRight();
    if (!e.ctrlKey && !e.shiftKey && e.key === "ArrowLeft") return this.stepLeft();
    const { sel } = this.ctx;
    const idx = (p: string) => col.index.get(p) ?? -1;
    const cur = sel.focus ? idx(sel.focus) : -1;
    let target = e.ctrlKey ? null : targetIndex(e.key, cur, col.entries.length, { ArrowUp: -1, ArrowDown: 1 }, Math.max(1, col.list.pageItems - 1));
    if (target === null) {
      const typed = typeSelectIndex(e, col.entries, cur);
      target = typed >= 0 ? typed : null;
    }
    if (target === null) return false;
    if (e.shiftKey) {
      moveSelect(sel, col.entries, target, true, idx);
      this.truncate(this.cols.indexOf(col) + 1);
      this.hidePreview();
      col.selected = null;
      col.list.scrollTo(target);
      this.paintAll();
      this.ctx.selectionChanged();
    } else {
      this.choose(col, col.entries[target].path);
    }
    return true;
  }

  selectAll() {
    const col = this.cols[this.active];
    if (!col) return;
    this.truncate(this.cols.indexOf(col) + 1);
    this.hidePreview();
    col.selected = null;
    selectAll(this.ctx.sel, col.entries);
    this.paintAll();
    this.ctx.selectionChanged();
  }

  focused() {
    const col = this.cols[this.active];
    const i = col && this.ctx.sel.focus ? col.index.get(this.ctx.sel.focus) : undefined;
    return col && i !== undefined ? { entry: col.entries[i], folder: col.entries } : null;
  }

  status() {
    return { items: this.cols[this.active]?.entries.length ?? 0, selected: this.ctx.sel.selection.size };
  }

  dispose() {
    this.hidePreview();
    this.truncate(0);
  }
}
