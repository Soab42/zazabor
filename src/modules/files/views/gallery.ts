import { formatBytes, formatDateTime, h } from "../../../ui/dom";
import { photoThumbUrl } from "../../../shared/thumbs";
import { previewUrl, thumbUrl } from "../../../api";
import type { FsEntry } from "../api";
import { categoryOf, folderGlyph, iconNameFor, iconNode, kindLabel } from "../kinds";
import { clickSelect, moveSelect, selectAll, targetIndex, typeSelectIndex } from "../selection";
import type { FileView, ViewContext } from "./types";
import { VirtualList } from "./vlist";

const CELL = 84;
const PREVIEW_PX = 1536;

/** Gallery view: a large preview of the focused item over a horizontal, virtualized filmstrip. */
export class GalleryView implements FileView {
  readonly el = h("div", { class: "gv" });
  private stage = h("div", { class: "gv-stage" });
  private caption = h("div", { class: "gv-caption" });
  private strip: VirtualList;
  private entries: FsEntry[] = [];
  private index = new Map<string, number>();
  private shown: string | null = null;
  private token = 0;
  private previewTimer: number | undefined;

  constructor(private readonly ctx: ViewContext) {
    this.strip = new VirtualList({
      axis: "x",
      size: CELL,
      pad: 12,
      overscan: 6,
      create: () => h("div", { class: "gv-cell" }, h("div", { class: "gv-thumb" })),
      bind: (cell, i) => this.bindCell(cell, i),
      release: (cell) => this.dropThumb(cell),
    });
    this.strip.el.classList.add("gv-strip", "fv-scroll");
    this.strip.el.tabIndex = 0;
    this.el.append(this.stage, this.caption, this.strip.el);

    this.strip.el.addEventListener("click", (e) => {
      const i = this.indexAt(e);
      if (i < 0) return;
      clickSelect(ctx.sel, this.entries, i, e, this.indexOf);
      this.afterSelection();
    });
    this.strip.el.addEventListener("dblclick", (e) => {
      const i = this.indexAt(e);
      if (i >= 0) ctx.open(this.entries[i], this.entries);
    });
    this.strip.el.addEventListener("contextmenu", (e) => {
      const i = this.indexAt(e);
      if (i < 0) return;
      e.preventDefault();
      this.pick(i);
      ctx.contextMenu(e, this.entries[i]);
    });
    this.stage.addEventListener("dblclick", () => {
      const entry = this.focusedEntry();
      if (entry) ctx.open(entry, this.entries);
    });
    this.stage.addEventListener("contextmenu", (e) => {
      const entry = this.focusedEntry();
      if (!entry) return;
      e.preventDefault();
      ctx.contextMenu(e, entry);
    });
  }

  private indexOf = (path: string) => this.index.get(path) ?? -1;

  private indexAt(e: Event): number {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".gv-cell");
    return cell ? Number(cell.dataset.i) : -1;
  }

  private focusedEntry(): FsEntry | null {
    const path = this.ctx.sel.focus;
    const i = path === null ? -1 : this.indexOf(path);
    return i >= 0 ? this.entries[i] : null;
  }

  private pick(i: number) {
    const { sel } = this.ctx;
    const path = this.entries[i].path;
    if (!sel.selection.has(path)) {
      sel.selection = new Set([path]);
      sel.anchor = sel.focus = path;
    } else {
      sel.focus = path;
    }
    this.afterSelection();
  }

  private afterSelection() {
    this.renderSelection();
    this.ctx.selectionChanged();
  }

  setEntries(entries: FsEntry[], keep: boolean) {
    this.entries = entries;
    this.index = new Map(entries.map((entry, i) => [entry.path, i]));
    const { sel } = this.ctx;
    // The stage always has something to show once the folder has items.
    if (entries.length && (sel.focus === null || !this.index.has(sel.focus))) {
      sel.selection = new Set([entries[0].path]);
      sel.anchor = sel.focus = entries[0].path;
      this.ctx.selectionChanged();
    }
    if (!keep) this.shown = null;
    this.strip.setCount(entries.length);
    this.renderSelection();
  }

  private bindCell(cell: HTMLElement, i: number) {
    const entry = this.entries[i];
    cell.dataset.i = String(i);
    cell.dataset.path = entry.path;
    cell.title = entry.name;
    const thumb = cell.firstElementChild as HTMLElement;
    this.dropThumb(cell);
    const category = categoryOf(entry);
    thumb.className = `gv-thumb ${category}`;
    if (category === "image") {
      const img = h("img", { class: "gv-img-thumb", alt: "", draggable: false, decoding: "async" });
      thumb.replaceChildren(iconNode("image", 20), img);
      this.ctx.thumbs.load(img, photoThumbUrl(entry, CELL - 12));
    } else if (category === "folder") {
      thumb.replaceChildren(folderGlyph());
    } else {
      thumb.replaceChildren(iconNode(iconNameFor(category), 20));
    }
    cell.classList.toggle("selected", this.ctx.sel.selection.has(entry.path));
    cell.classList.toggle("focus", this.ctx.sel.focus === entry.path);
  }

  private dropThumb(cell: HTMLElement) {
    const img = cell.querySelector<HTMLImageElement>("img");
    if (!img) return;
    this.ctx.thumbs.cancel(img);
    delete img.dataset.src;
    img.removeAttribute("src");
    img.classList.remove("loaded", "failed");
  }

  renderSelection() {
    const { sel } = this.ctx;
    this.strip.forEachRendered((cell) => {
      const path = cell.dataset.path ?? "";
      cell.classList.toggle("selected", sel.selection.has(path));
      cell.classList.toggle("focus", sel.focus === path);
    });
    this.renderStage();
  }

  /** Shows the focused item large: a thumbnail at once, sharpened by a preview render. */
  private renderStage() {
    const entry = this.focusedEntry();
    const path = entry?.path ?? null;
    if (path === this.shown) return;
    this.shown = path;
    const token = ++this.token;
    clearTimeout(this.previewTimer);
    if (!entry) {
      this.stage.replaceChildren();
      this.caption.replaceChildren();
      return;
    }
    const category = categoryOf(entry);
    if (category === "image") {
      const img = h("img", { class: "gv-img", alt: "", draggable: false, src: thumbUrl(entry.path, entry.mtime, 512) });
      this.stage.replaceChildren(img);
      // Skip the sharp render while the user is still flicking through items.
      this.previewTimer = window.setTimeout(() => {
        const sharp = new Image();
        sharp.onload = () => {
          if (token === this.token) img.src = sharp.src;
        };
        sharp.src = previewUrl(entry.path, entry.mtime, PREVIEW_PX);
      }, 140);
    } else if (category === "folder") {
      this.stage.replaceChildren(h("div", { class: "gv-glyph folder" }, folderGlyph()));
    } else {
      const ext = entry.ext && entry.ext.length <= 4 ? h("span", { class: "iv-ext" }, entry.ext.toUpperCase()) : null;
      this.stage.replaceChildren(h("div", { class: `gv-glyph ${category}` }, iconNode(iconNameFor(category), 24), ext));
    }
    const meta = [kindLabel(entry), entry.dir ? "" : formatBytes(entry.size), formatDateTime(entry.mtime)].filter(Boolean).join("  ·  ");
    this.caption.replaceChildren(h("div", { class: "gv-name", title: entry.name }, entry.name), h("div", { class: "gv-meta" }, meta));
  }

  getScroll() {
    return this.strip.scroll;
  }

  setScroll(value: number) {
    this.strip.scroll = value;
  }

  reveal(path: string) {
    const i = this.indexOf(path);
    if (i >= 0) this.strip.scrollTo(i, "center");
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.altKey || e.metaKey) return false;
    const { sel } = this.ctx;
    const cur = sel.focus ? this.indexOf(sel.focus) : -1;
    let target = e.ctrlKey ? null : targetIndex(e.key, cur, this.entries.length, { ArrowLeft: -1, ArrowRight: 1 }, Math.max(1, this.strip.pageItems - 1));
    if (target === null) {
      const typed = typeSelectIndex(e, this.entries, cur);
      target = typed >= 0 ? typed : null;
    }
    if (target === null) return false;
    moveSelect(sel, this.entries, target, e.shiftKey, this.indexOf);
    this.strip.scrollTo(target);
    this.afterSelection();
    return true;
  }

  selectAll() {
    selectAll(this.ctx.sel, this.entries);
    this.afterSelection();
  }

  focused() {
    const entry = this.focusedEntry();
    return entry ? { entry, folder: this.entries } : null;
  }

  status() {
    return { items: this.entries.length, selected: this.ctx.sel.selection.size };
  }

  dispose() {
    clearTimeout(this.previewTimer);
    this.token++;
    this.strip.dispose();
  }
}
