import { markDrop, paintCut, paintTags } from "../views/marks";
import type { FilesSettings, FilesSortKey } from "../../../config";
import { formatDateTime, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import type { FsEntry } from "../api";
import { fetchTitles, isCloudPath, titledBelow } from "../cloud";
import { categoryOf, iconNameFor, iconNode, sizeText } from "../kinds";
import { crumbs, parentOf } from "../path";
import { clickSelect, moveSelect, selectAll, targetIndex, typeSelectIndex } from "../selection";
import type { FileView, ViewContext } from "../views/types";
import { VirtualList } from "../views/vlist";

const ROW = 28;

const COLUMNS: { key: FilesSortKey | null; label: string; cls: string }[] = [
  { key: "name", label: "Name", cls: "name" },
  { key: null, label: "Location", cls: "loc" },
  { key: "date", label: "Date Modified", cls: "date" },
  { key: "size", label: "Size", cls: "size" },
];

/** "Photos/2023" for a result found below the searched folder; "This Folder" for its direct children. */
export function locationOf(path: string, root: string): string {
  const parent = parentOf(path);
  const base = root.replace(/\/+$/, "");
  if (parent === base || parent === root) return "This Folder";
  // On a cloud drive the folders on disk are ids; show their titles.
  if (parent.startsWith(`${base}/`)) return isCloudPath(parent) ? titledBelow(parent, base) : parent.slice(base.length + 1);
  return parent;
}

/**
 * The search results list: like the list view, with a Location column instead of Kind. Results
 * come best match first; clicking a column header sorts by it (a third click goes back to best match).
 */
export class ResultsView implements FileView {
  readonly el = h("div", { class: "lv fs-results" });
  private header = h("div", { class: "lv-header" });
  private list: VirtualList;
  private entries: FsEntry[] = [];
  private index = new Map<string, number>();
  private query = "";
  private sort: FilesSettings["sort"] | null = null;

  constructor(private readonly ctx: ViewContext) {
    this.list = new VirtualList({
      axis: "y",
      size: ROW,
      pad: 4,
      overscan: 8,
      create: () => this.createRow(),
      bind: (row, i) => this.bindRow(row, i),
    });
    this.list.el.classList.add("fv-scroll", "lv-scroll");
    this.list.el.tabIndex = 0;
    for (const col of COLUMNS) {
      const button = h("button", {
        class: `lv-th ${col.cls}`, type: "button", disabled: col.key === null,
        title: col.key ? `Sort by ${col.label}` : col.label,
      }, h("span", null, col.label), h("span", { class: "lv-sort" }));
      if (col.key) {
        const key = col.key;
        button.dataset.key = key;
        button.addEventListener("click", () => ctx.sortBy(key));
      }
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
  }

  /** The text being searched, highlighted in each name. */
  setQuery(query: string) {
    this.query = query.trim().toLowerCase();
    this.list.refresh();
  }

  /** The column the results are ordered by; null means best match first. */
  setSort(sort: FilesSettings["sort"] | null) {
    this.sort = sort;
    this.renderHeader();
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

  private renderHeader() {
    for (const button of Array.from(this.header.children) as HTMLElement[]) {
      const active = !!this.sort && button.dataset.key === this.sort.key;
      button.classList.toggle("sorted", active);
      const slot = button.lastElementChild as HTMLElement;
      slot.replaceChildren(...(active && this.sort ? [icon(this.sort.ascending ? "chevronUp" : "chevronDown", 12)] : []));
    }
  }

  private createRow() {
    return h("div", { class: "lv-row" },
      h("div", { class: "lv-cell name" }, h("span", { class: "lv-icon" }), h("span", { class: "lv-text" }), h("span", { class: "lv-tags" })),
      h("div", { class: "lv-cell loc" }),
      h("div", { class: "lv-cell date" }),
      h("div", { class: "lv-cell size" }));
  }

  private bindRow(row: HTMLElement, i: number) {
    const entry = this.entries[i];
    row.dataset.i = String(i);
    row.dataset.path = entry.path;
    row.classList.toggle("odd", i % 2 === 1);
    const [name, loc, date, size] = Array.from(row.children) as HTMLElement[];
    const category = categoryOf(entry);
    const iconSlot = name.firstElementChild as HTMLElement;
    iconSlot.className = `lv-icon ${category}`;
    iconSlot.replaceChildren(iconNode(iconNameFor(category), 16));
    this.paintName(name.querySelector<HTMLElement>(".lv-text")!, entry.name);
    markDrop(row, entry, false);
    const where = locationOf(entry.path, this.ctx.path);
    loc.textContent = where;
    loc.title = parentOf(entry.path);
    if (isCloudPath(entry.path)) {
      void fetchTitles(crumbs(parentOf(entry.path))).then((arrived) => arrived && this.list.refresh());
    }
    row.title = entry.path;
    date.textContent = formatDateTime(entry.mtime);
    size.textContent = sizeText(entry);
    this.paint(row, entry.path);
  }

  /** The name with the first match wrapped in a `<mark>`. */
  private paintName(slot: HTMLElement, name: string) {
    const at = this.query ? name.toLowerCase().indexOf(this.query) : -1;
    if (at < 0 || name.toLowerCase().length !== name.length) {
      slot.textContent = name;
      return;
    }
    slot.replaceChildren(
      name.slice(0, at),
      h("mark", { class: "fs-hit" }, name.slice(at, at + this.query.length)),
      name.slice(at + this.query.length),
    );
  }

  /** Cut dimming and tag dots changed (see views/marks.ts). */
  refreshMarks() {
    this.renderSelection();
  }

  private paint(row: HTMLElement, path: string) {
    const { sel } = this.ctx;
    paintCut(row, this.ctx, path);
    paintTags(row.querySelector<HTMLElement>(".lv-tags")!, this.ctx.tagsOf(path));
    row.classList.toggle("selected", sel.selection.has(path));
    row.classList.toggle("focus", sel.focus === path);
  }

  setEntries(entries: FsEntry[]) {
    this.entries = entries;
    this.index = new Map(entries.map((entry, i) => [entry.path, i]));
    this.list.setCount(entries.length);
  }

  renderSelection() {
    this.list.forEachRendered((row) => this.paint(row, row.dataset.path ?? ""));
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
    this.list.dispose();
  }
}
