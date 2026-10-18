import { formatBytes, formatDateTime, h } from "../../../ui/dom";
import type { FilesSortKey } from "../../../config";
import { icon } from "../../../ui/icons";
import type { FsEntry } from "../api";
import { categoryOf, iconNameFor, iconNode, kindLabel } from "../kinds";
import { clickSelect, moveSelect, selectAll, targetIndex, typeSelectIndex } from "../selection";
import { attachDragSource } from "../dnd";
import { markDrop, paintCut, paintTags } from "./marks";
import { attachRubberBand, rowHits } from "./rubber";
import type { FileView, ViewContext } from "./types";
import { VirtualList } from "./vlist";

const ROW = 28;
const PAD = 4;

const COLUMNS: { key: FilesSortKey; label: string; cls: string }[] = [
  { key: "name", label: "Name", cls: "name" },
  { key: "date", label: "Date Modified", cls: "date" },
  { key: "size", label: "Size", cls: "size" },
  { key: "kind", label: "Kind", cls: "kind" },
];

/** List view: a sticky sortable header over 28px rows with name, date, size and kind. */
export class ListView implements FileView {
  readonly el = h("div", { class: "lv" });
  private header = h("div", { class: "lv-header" });
  private list: VirtualList;
  private entries: FsEntry[] = [];
  private index = new Map<string, number>();
  private detach: (() => void)[] = [];

  constructor(private readonly ctx: ViewContext) {
    this.list = new VirtualList({
      axis: "y",
      size: ROW,
      pad: PAD,
      overscan: 8,
      create: () => this.createRow(),
      bind: (row, i) => this.bindRow(row, i),
    });
    this.list.el.classList.add("fv-scroll", "lv-scroll");
    this.list.el.tabIndex = 0;
    for (const col of COLUMNS) {
      const button = h("button", { class: `lv-th ${col.cls}`, type: "button", "data-key": col.key, title: `Sort by ${col.label}` },
        h("span", null, col.label), h("span", { class: "lv-sort" }));
      button.addEventListener("click", () => ctx.sortBy(col.key));
      this.header.append(button);
    }
    this.el.append(this.header, this.list.el);

    const el = this.list.el;
    el.addEventListener("click", (e) => this.onClick(e));
    el.addEventListener("dblclick", (e) => {
      const i = this.indexAt(e);
      if (i >= 0) ctx.open(this.entries[i], this.entries);
    });
    el.addEventListener("contextmenu", (e) => {
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
    this.renderHeader();
    this.detach = [
      attachDragSource(el, {
        entryAt: (t) => {
          const row = t.closest<HTMLElement>(".lv-row");
          return row ? this.entries[Number(row.dataset.i)] ?? null : null;
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
        scroller: el,
        isEmpty: (t) => !t.closest(".lv-row"),
        hits: (band) => rowHits(band, ROW, PAD, this.entries.length).map((i) => this.entries[i].path),
        sel: () => ctx.sel,
        changed: () => {
          this.renderSelection();
          ctx.selectionChanged();
        },
      }),
    ];
  }

  private indexOf = (path: string) => this.index.get(path) ?? -1;

  private indexAt(e: Event): number {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".lv-row");
    return row ? Number(row.dataset.i) : -1;
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

  /** Marks the sorted column with a chevron showing the direction. */
  private renderHeader() {
    const { key, ascending } = this.ctx.settings.sort;
    for (const button of Array.from(this.header.children) as HTMLElement[]) {
      const active = button.dataset.key === key;
      button.classList.toggle("sorted", active);
      const slot = button.lastElementChild as HTMLElement;
      slot.replaceChildren(...(active ? [icon(ascending ? "chevronUp" : "chevronDown", 12)] : []));
    }
  }

  private createRow() {
    return h("div", { class: "lv-row" },
      h("div", { class: "lv-cell name" }, h("span", { class: "lv-icon" }), h("span", { class: "lv-text" }), h("span", { class: "lv-tags" })),
      h("div", { class: "lv-cell date" }),
      h("div", { class: "lv-cell size" }),
      h("div", { class: "lv-cell kind" }));
  }

  private bindRow(row: HTMLElement, i: number) {
    const entry = this.entries[i];
    row.dataset.i = String(i);
    row.dataset.path = entry.path;
    row.classList.toggle("odd", i % 2 === 1);
    const [name, date, size, kind] = Array.from(row.children) as HTMLElement[];
    const category = categoryOf(entry);
    const iconSlot = name.firstElementChild as HTMLElement;
    iconSlot.className = `lv-icon ${category}`;
    iconSlot.replaceChildren(iconNode(iconNameFor(category), 16));
    const text = name.children[1] as HTMLElement;
    text.textContent = entry.name;
    markDrop(row, entry, true);
    row.title = entry.name;
    date.textContent = formatDateTime(entry.mtime);
    size.textContent = entry.dir ? "—" : formatBytes(entry.size);
    kind.textContent = kindLabel(entry);
    this.paint(row, entry.path);
  }

  private paint(row: HTMLElement, path: string) {
    const { sel } = this.ctx;
    row.classList.toggle("selected", sel.selection.has(path));
    row.classList.toggle("focus", sel.focus === path);
    paintCut(row, this.ctx, path);
    paintTags(row.querySelector<HTMLElement>(".lv-tags")!, this.ctx.tagsOf(path));
  }

  setEntries(entries: FsEntry[]) {
    this.entries = entries;
    this.index = new Map(entries.map((entry, i) => [entry.path, i]));
    this.renderHeader();
    this.list.el.dataset.dropPath = this.ctx.path;
    this.list.setCount(entries.length);
  }

  renderSelection() {
    this.list.forEachRendered((row) => this.paint(row, row.dataset.path ?? ""));
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
    if (i >= 0) this.list.scrollTo(i);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.altKey || e.metaKey) return false;
    const { sel } = this.ctx;
    const cur = sel.focus ? this.indexOf(sel.focus) : -1;
    let target = e.ctrlKey ? null : targetIndex(e.key, cur, this.entries.length, { ArrowUp: -1, ArrowDown: 1 }, Math.max(1, this.list.pageItems - 1));
    if (target === null) {
      const typed = typeSelectIndex(e, this.entries, cur);
      target = typed >= 0 ? typed : null;
    }
    if (target === null) return false;
    moveSelect(sel, this.entries, target, e.shiftKey, this.indexOf);
    this.list.scrollTo(target);
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
