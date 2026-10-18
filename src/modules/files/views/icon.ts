import { h } from "../../../ui/dom";
import { photoThumbUrl } from "../../../shared/thumbs";
import type { FsEntry } from "../api";
import { categoryOf, folderGlyph, iconNameFor, iconNode } from "../kinds";
import { clickSelect, moveSelect, selectAll, targetIndex, typeSelectIndex } from "../selection";
import { attachDragSource } from "../dnd";
import { markDrop, paintCut, paintTags } from "./marks";
import { attachRubberBand, tileHits } from "./rubber";
import type { FileView, ViewContext } from "./types";
import { VirtualList } from "./vlist";

const SIDE_PAD = 16;
const PAD = 12;
/** Everything in a tile besides the art: padding, the two-line name and the gap below. */
const CHROME = 62;

/**
 * Icon view: a grid of tiles with real thumbnails for images and large glyphs for the rest.
 * Each virtual item is one row of tiles; the column count follows the width.
 */
export class IconView implements FileView {
  readonly el: HTMLElement;
  private list: VirtualList;
  private entries: FsEntry[] = [];
  private index = new Map<string, number>();
  private cols = 1;
  private detach: (() => void)[] = [];

  constructor(private readonly ctx: ViewContext) {
    this.list = new VirtualList({
      axis: "y",
      size: this.rowHeight,
      pad: PAD,
      overscan: 2,
      create: () => h("div", { class: "iv-row" }),
      bind: (row, r) => this.bindRow(row, r),
      release: (row) => this.releaseRow(row),
      onResize: () => this.relayout(),
    });
    this.el = this.list.el;
    this.el.classList.add("fv-scroll", "iv");
    this.el.tabIndex = 0;
    this.applySize();
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("dblclick", (e) => {
      const i = this.indexAt(e);
      if (i >= 0) ctx.open(this.entries[i], this.entries);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const i = this.indexAt(e);
      if (i < 0) return;
      e.preventDefault();
      const entry = this.entries[i];
      if (!ctx.sel.selection.has(entry.path)) {
        ctx.sel.selection = new Set([entry.path]);
        ctx.sel.anchor = ctx.sel.focus = entry.path;
        this.renderSelection();
        ctx.selectionChanged();
      }
      ctx.contextMenu(e, entry);
    });
    this.detach = [
      attachDragSource(this.el, {
        entryAt: (t) => {
          const tile = t.closest<HTMLElement>(".iv-tile");
          return tile ? this.entries[Number(tile.dataset.i)] ?? null : null;
        },
        isSelected: (p) => ctx.sel.selection.has(p),
        select: (entry) => {
          ctx.sel.selection = new Set([entry.path]);
          ctx.sel.anchor = ctx.sel.focus = entry.path;
          this.renderSelection();
          ctx.selectionChanged();
        },
        paths: () => Array.from(ctx.sel.selection),
      }),
      attachRubberBand({
        scroller: this.el,
        isEmpty: (t) => !t.closest(".iv-tile"),
        hits: (band) => tileHits(band, {
          count: this.entries.length, cols: this.cols, width: this.el.clientWidth, pad: PAD, sidePad: SIDE_PAD,
          rowHeight: this.rowHeight, tileHeight: this.iconSize + 56, gap: 2,
        }).map((i) => this.entries[i].path),
        sel: () => ctx.sel,
        changed: () => {
          this.renderSelection();
          ctx.selectionChanged();
        },
      }),
    ];
  }

  private get iconSize() {
    return this.ctx.settings.iconSize;
  }

  private get rowHeight() {
    return this.iconSize + CHROME;
  }

  private indexOf = (path: string) => this.index.get(path) ?? -1;

  private applySize() {
    this.el.style.setProperty("--iv-icon", `${this.iconSize}px`);
  }

  private indexAt(e: Event): number {
    const tile = (e.target as HTMLElement).closest<HTMLElement>(".iv-tile");
    return tile ? Number(tile.dataset.i) : -1;
  }

  private onClick(e: MouseEvent) {
    const i = this.indexAt(e);
    const { sel } = this.ctx;
    if (i < 0) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || sel.selection.size === 0) return;
      sel.selection.clear();
      sel.anchor = null;
    } else {
      clickSelect(sel, this.entries, i, e, this.indexOf);
    }
    this.renderSelection();
    this.ctx.selectionChanged();
  }

  setEntries(entries: FsEntry[]) {
    this.entries = entries;
    this.index = new Map(entries.map((entry, i) => [entry.path, i]));
    this.computeCols();
    this.el.dataset.dropPath = this.ctx.path;
    this.list.setCount(Math.ceil(entries.length / this.cols));
  }

  private computeCols() {
    const avail = Math.max(0, this.el.clientWidth - SIDE_PAD * 2) || 800;
    this.cols = Math.max(1, Math.floor(avail / (this.iconSize + 28)));
    this.el.style.setProperty("--cols", String(this.cols));
  }

  private relayout() {
    const before = this.cols;
    this.computeCols();
    if (this.cols !== before) this.list.setCount(Math.ceil(this.entries.length / this.cols));
  }

  iconSizeChanged() {
    this.applySize();
    this.computeCols();
    this.list.setItemSize(this.rowHeight);
    this.list.setCount(Math.ceil(this.entries.length / this.cols));
  }

  private bindRow(row: HTMLElement, r: number) {
    const start = r * this.cols;
    const n = Math.max(0, Math.min(this.cols, this.entries.length - start));
    while (row.children.length > n) this.releaseTile(row.lastElementChild as HTMLElement, true);
    while (row.children.length < n) row.append(this.createTile());
    for (let k = 0; k < n; k++) this.bindTile(row.children[k] as HTMLElement, start + k);
  }

  private releaseRow(row: HTMLElement) {
    for (const tile of Array.from(row.children)) this.releaseTile(tile as HTMLElement, false);
  }

  private releaseTile(tile: HTMLElement, remove: boolean) {
    this.dropThumb(tile);
    delete tile.dataset.path;
    delete tile.dataset.dropPath;
    delete tile.dataset.spring;
    if (remove) tile.remove();
  }

  private dropThumb(tile: HTMLElement) {
    const img = tile.querySelector<HTMLImageElement>("img.iv-thumb");
    if (!img) return;
    this.ctx.thumbs.cancel(img);
    delete img.dataset.src;
    img.removeAttribute("src");
    img.classList.remove("loaded", "failed");
  }

  private createTile() {
    return h("div", { class: "iv-tile" }, h("div", { class: "iv-art" }), h("div", { class: "iv-name" }, h("span")),
      h("div", { class: "iv-tags" }));
  }

  private bindTile(tile: HTMLElement, i: number) {
    const entry = this.entries[i];
    tile.dataset.i = String(i);
    const stamp = `${entry.mtime}:${this.iconSize}`;
    if (tile.dataset.path !== entry.path || tile.dataset.stamp !== stamp) {
      tile.dataset.path = entry.path;
      tile.dataset.stamp = stamp;
      this.fillArt(tile, entry);
    }
    (tile.children[1].firstElementChild as HTMLElement).textContent = entry.name;
    tile.title = entry.name;
    markDrop(tile, entry, true);
    this.paint(tile, entry.path);
  }

  private fillArt(tile: HTMLElement, entry: FsEntry) {
    const art = tile.firstElementChild as HTMLElement;
    this.dropThumb(tile);
    const category = categoryOf(entry);
    art.className = `iv-art ${category}`;
    if (category === "folder") {
      art.replaceChildren(folderGlyph());
    } else if (category === "image") {
      const img = h("img", { class: "iv-thumb", alt: "", draggable: false, decoding: "async" });
      art.replaceChildren(h("div", { class: "iv-sheet photo" }, iconNode("image", 24), img));
      this.ctx.thumbs.load(img, photoThumbUrl(entry, this.iconSize));
    } else {
      const badge = entry.ext && entry.ext.length <= 4 ? h("span", { class: "iv-ext" }, entry.ext.toUpperCase()) : null;
      art.replaceChildren(h("div", { class: "iv-sheet" }, iconNode(iconNameFor(category), 24), badge));
    }
  }

  private paint(tile: HTMLElement, path: string) {
    const { sel } = this.ctx;
    tile.classList.toggle("selected", sel.selection.has(path));
    tile.classList.toggle("focus", sel.focus === path);
    paintCut(tile, this.ctx, path);
    paintTags(tile.lastElementChild as HTMLElement, this.ctx.tagsOf(path));
  }

  renderSelection() {
    this.list.forEachRendered((row) => {
      for (const tile of Array.from(row.children) as HTMLElement[]) {
        if (tile.dataset.path) this.paint(tile, tile.dataset.path);
      }
    });
  }

  refreshMarks() {
    this.renderSelection();
  }

  getScroll() {
    return this.list.scroll;
  }

  setScroll(value: number) {
    this.list.scroll = value;
  }

  reveal(path: string) {
    const i = this.indexOf(path);
    if (i >= 0) this.list.scrollTo(Math.floor(i / this.cols));
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.altKey || e.metaKey) return false;
    const { sel } = this.ctx;
    const cur = sel.focus ? this.indexOf(sel.focus) : -1;
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -this.cols, ArrowDown: this.cols };
    let target = e.ctrlKey ? null : targetIndex(e.key, cur, this.entries.length, deltas, this.cols * Math.max(1, this.list.pageItems - 1));
    if (target === null) {
      const typed = typeSelectIndex(e, this.entries, cur);
      target = typed >= 0 ? typed : null;
    }
    if (target === null) return false;
    moveSelect(sel, this.entries, target, e.shiftKey, this.indexOf);
    this.list.scrollTo(Math.floor(target / this.cols));
    this.renderSelection();
    this.ctx.selectionChanged();
    return true;
  }

  selectAll() {
    selectAll(this.ctx.sel, this.entries);
    this.renderSelection();
    this.ctx.selectionChanged();
  }

  focused() {
    const i = this.ctx.sel.focus ? this.indexOf(this.ctx.sel.focus) : -1;
    return i >= 0 ? { entry: this.entries[i], folder: this.entries } : null;
  }

  status() {
    return { items: this.entries.length, selected: this.ctx.sel.selection.size };
  }

  dispose() {
    for (const off of this.detach) off();
    this.list.dispose();
  }
}
