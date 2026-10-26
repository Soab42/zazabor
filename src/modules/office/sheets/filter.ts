import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { popover, type Popover } from "../../time/pickers";
import type { Model } from "./engine";

type Range = [number, number, number, number];

export interface FilterHost {
  model(): Model;
  sheet(): number;
  run(change: () => void): void;
  /** Sorts the filtered range by a column (the header row stays). */
  sortBy(range: Range, col: number, ascending: boolean): void;
  focus(): void;
}

/**
 * AutoFilter (Data → Filter, Ctrl+Shift+L), as Excel has it: a ▾ in each header cell of the table
 * around the active cell; its menu sorts by that column or keeps only the values ticked, hiding
 * the other rows. The engine can't save an AutoFilter into .xlsx, so the rows simply stay hidden
 * in the file.
 */
export class AutoFilter {
  private state: null | { sheet: number; range: Range; keep: Map<number, Set<string>> } = null;
  private pop: Popover | null = null;

  constructor(private readonly host: FilterHost) {}

  /** The header row and its columns, for the grid to draw the buttons. */
  buttons(): { row: number; c1: number; c2: number; filtered: Set<number> } | null {
    const s = this.state;
    if (!s || s.sheet !== this.host.sheet()) return null;
    return { row: s.range[0], c1: s.range[1], c2: s.range[3], filtered: new Set(s.keep.keys()) };
  }

  get on() {
    return !!this.state && this.state.sheet === this.host.sheet();
  }

  /** Turns the filter on for `range` (its first row is the header), or off. */
  toggle(range: Range) {
    if (this.on) {
      this.clear();
      this.state = null;
      return;
    }
    if (range[2] <= range[0]) return;
    this.state = { sheet: this.host.sheet(), range, keep: new Map() };
    this.host.run(() => {});
  }

  /** Shows every row again (Clear Filter), keeping the buttons. */
  clear() {
    const s = this.state;
    if (!s) return;
    s.keep.clear();
    this.keepSelection(() => this.host.model().setRowsHidden(s.sheet, s.range[0] + 1, s.range[2], false));
  }

  /** Hiding rows moves the engine's selection; it stays where the user had it. */
  private keepSelection(change: () => void) {
    const m = this.host.model();
    const v = m.getSelectedView();
    this.host.run(() => {
      change();
      m.setSelectedCell(v.row, v.column);
      m.setSelectedRange(...(v.range as [number, number, number, number]));
    });
  }

  /** The ▾ of column `col` was clicked, at screen point (x, y). */
  open(col: number, anchor: DOMRect) {
    const s = this.state;
    if (!s) return;
    this.pop?.close();
    const m = this.host.model();
    const [r1, , r2] = s.range;
    const values = new Map<string, number>();
    for (let r = r1 + 1; r <= r2; r++) {
      const v = m.getFormattedCellValue(s.sheet, r, col);
      values.set(v, (values.get(v) ?? 0) + 1);
    }
    const sorted = [...values.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true })));
    const kept = s.keep.get(col);
    const boxes = new Map<string, HTMLInputElement>();
    const search = h("input", { class: "search-input", type: "search", placeholder: "Search", "aria-label": "Search values" });
    const all = h("input", { type: "checkbox", checked: !kept });
    const list = h("div", { class: "sh-filter-list" });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...sorted.filter((v) => !q || v.toLowerCase().includes(q)).map((v) => {
        let box = boxes.get(v);
        if (!box) {
          box = h("input", { type: "checkbox", checked: !kept || kept.has(v) });
          box.addEventListener("change", () => (all.checked = [...boxes.values()].every((b) => b.checked)));
          boxes.set(v, box);
        }
        return h("label", { class: "sh-check sh-filter-item" }, box, v === "" ? h("i", null, "(Blanks)") : v, h("span", { class: "sh-filter-count" }, String(values.get(v))));
      }));
    };
    all.addEventListener("change", () => boxes.forEach((b) => (b.checked = all.checked)));
    search.addEventListener("input", draw);
    draw();
    const close = () => (this.pop?.close(), this.host.focus());
    const sort = (asc: boolean) => () => {
      close();
      this.host.sortBy(s.range, col, asc);
      this.apply();
    };
    const panel = h("div", { class: "sh-filter" },
      h("button", { class: "rb-list-item", type: "button", onclick: sort(true) }, icon("sortAsc", 14), " Sort A to Z"),
      h("button", { class: "rb-list-item", type: "button", onclick: sort(false) }, icon("sortDesc", 14), " Sort Z to A"),
      h("button", { class: "rb-list-item", type: "button", disabled: !kept, onclick: () => (s.keep.delete(col), close(), this.apply()) }, icon("filter", 14), " Clear Filter"),
      h("label", { class: "search sh-filter-search" }, icon("search", 14), search),
      h("label", { class: "sh-check sh-filter-item" }, all, h("b", null, "(Select All)")),
      list,
      h("div", { class: "sh-filter-foot" },
        h("button", { class: "btn small", type: "button", onclick: close }, "Cancel"),
        h("button", { class: "btn small primary", type: "button", onclick: () => {
          const chosen = new Set([...boxes].filter(([, b]) => b.checked).map(([v]) => v));
          if (chosen.size === sorted.length) s.keep.delete(col);
          else s.keep.set(col, chosen);
          close();
          this.apply();
        } }, "OK")));
    const anchorEl = h("div", { style: { position: "fixed", left: `${anchor.left}px`, top: `${anchor.top}px`, width: `${anchor.width}px`, height: `${anchor.height}px` } });
    document.body.append(anchorEl);
    this.pop = popover(anchorEl, panel, document.body, () => anchorEl.remove());
    requestAnimationFrame(() => search.focus());
  }

  /** Hides the rows that don't match every column's choice. */
  private apply() {
    const s = this.state;
    if (!s) return;
    const m = this.host.model();
    const [r1, , r2] = s.range;
    this.keepSelection(() => {
      // Runs of rows that show or hide together, so a big table is a few calls.
      let start = r1 + 1;
      let hide: boolean | null = null;
      for (let r = r1 + 1; r <= r2 + 1; r++) {
        const h = r > r2 ? null : [...s.keep].some(([col, keep]) => !keep.has(m.getFormattedCellValue(s.sheet, r, col)));
        if (h !== hide) {
          if (hide !== null) m.setRowsHidden(s.sheet, start, r - 1, hide);
          start = r;
          hide = h;
        }
      }
    });
  }
}
