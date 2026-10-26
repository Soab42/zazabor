import { h } from "../../../ui/dom";
import { CELL_BOOLEAN, CELL_ERROR, CELL_NUMBER, LAST_COLUMN, LAST_ROW, columnName, normalized, type Model } from "./engine";

/**
 * The sheet itself, drawn on a canvas as Excel draws it: column letters and row numbers, cells
 * with their fills, borders and text (overflowing into empty neighbours, wrapped, or ### when a
 * number doesn't fit), merged cells, frozen panes, and the selection with its fill handle.
 *
 * The engine owns the view: the selection and the top-left cell live in the model, and its own
 * navigation (arrows, Ctrl+arrows, Page Up/Down) scrolls it. The grid scrolls by whole rows and
 * columns, as Excel does, so it never needs pixel offsets of row 900,000.
 */

type Range = [number, number, number, number];

export interface GridHost {
  model(): Model;
  sheet(): number;
  /** 1 = 100%. */
  zoom(): number;
  setZoom(zoom: number): void;
  showFormulas(): boolean;
  showGridlines(): boolean;
  showHeadings(): boolean;
  /** The selection moved (formula bar, ribbon and status bar follow). */
  selectionChanged(): void;
  /** The grid changed the workbook (a resize, a fill). */
  changed(): void;
  /** Edit the active cell (a double click). */
  edit(): void;
  /** True while a formula is being typed: clicks and drags pick references instead. */
  picking(): boolean;
  pick(range: Range, done: boolean): void;
  /** Right click: the cell menu, or the row/column header menu. */
  menu(x: number, y: number, at: "cell" | "rows" | "columns"): void;
  /** Gives the keyboard back to the sheet (a click on the grid). */
  focus(): void;
  /** A selection drag ended (Format Painter paints then). */
  selected(): void;
  /** The AutoFilter's header row, for its ▾ buttons. */
  filter(): { row: number; c1: number; c2: number; filtered: Set<number> } | null;
  filterClick(col: number, box: DOMRect): void;
  /** References of the formula being typed, outlined in colour. */
  highlights(): { range: Range; color: string }[];
  /** The range waiting to be pasted (marching ants). */
  copied(): Range | null;
  /** Data bars and icons drawn into cells? (always, when the style has them) */
}

interface Line {
  /** Row or column number. */
  index: number;
  /** Position in CSS pixels from the canvas's edge. */
  at: number;
  size: number;
}

interface Cell {
  text: string;
  type: number;
  style: ReturnType<Model["getCellStyle"]>;
}

interface Palette {
  bg: string;
  text: string;
  grid: string;
  headBg: string;
  headText: string;
  headSel: string;
  headSelText: string;
  headLine: string;
  selFill: string;
  selLine: string;
  freeze: string;
}

const LIGHT: Palette = {
  bg: "#ffffff", text: "#000000", grid: "#e2e3e5", headBg: "#f5f5f6", headText: "#5f6368", headSel: "#d9ebdf", headSelText: "#0f6e3b",
  headLine: "#cfd1d4", selFill: "rgba(22, 136, 74, 0.10)", selLine: "#16884a", freeze: "#9aa0a6",
};
const DARK: Palette = {
  bg: "#1e1f21", text: "#eceef0", grid: "#36383b", headBg: "#26282b", headText: "#9ca0a6", headSel: "#24402f", headSelText: "#7fdca6",
  headLine: "#3c3e42", selFill: "rgba(80, 205, 135, 0.14)", selLine: "#3fbf74", freeze: "#6c7077",
};

/** Model pixels to CSS pixels at 100%: IronCalc's rows are 25 px, Excel's 20. */
const SCALE = 0.8;
const FILL_HANDLE = 7;

const FONT_FALLBACKS: Record<string, string> = {
  calibri: `Calibri, Carlito, "Liberation Sans", Arial, sans-serif`,
  cambria: `Cambria, Caladea, "Liberation Serif", serif`,
  arial: `Arial, "Liberation Sans", Helvetica, sans-serif`,
  "times new roman": `"Times New Roman", "Liberation Serif", serif`,
  "courier new": `"Courier New", "Liberation Mono", monospace`,
};

function fontStack(name: string): string {
  // The name comes from the file: no quotes or other CSS in it.
  const clean = name.replace(/[^\p{L}\p{N} ._-]/gu, "");
  return FONT_FALLBACKS[clean.toLowerCase()] ?? `"${clean}", Carlito, "Liberation Sans", sans-serif`;
}

export class Grid {
  readonly el: HTMLElement;
  private canvas = h("canvas", { class: "sh-canvas" });
  private ctx = this.canvas.getContext("2d", { alpha: false })!;
  private vbar = h("div", { class: "sh-scroll v" }, h("div", { class: "sh-thumb" }));
  private hbar = h("div", { class: "sh-scroll h" }, h("div", { class: "sh-thumb" }));
  private guide = h("div", { class: "sh-guide", hidden: true });
  private width = 0;
  private height = 0;
  private rows: Line[] = [];
  private cols: Line[] = [];
  private headW = 0;
  private headH = 0;
  private cache = new Map<number, Cell>();
  private extent: { rows: number; cols: number } | null = null;
  private frame = 0;
  private antsOffset = 0;
  private antsTimer = 0;
  private wheelRows = 0;
  private wheelCols = 0;
  /** Where a drag is (selecting, picking a reference, resizing, filling). */
  private drag: null | { kind: "select" | "pick" | "resize-col" | "resize-row" | "fill" | "rows" | "cols"; index?: number; start?: number; startSize?: number; anchor?: [number, number]; range?: Range; to?: [number, number] } = null;
  private autoScroll = 0;
  private lastPointer: { x: number; y: number } | null = null;

  constructor(private readonly host: GridHost) {
    this.el = h("div", { class: "sh-grid" }, this.canvas, this.vbar, this.hbar, this.guide);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    // The keyboard stays where it is (the cell editor, or a formula being typed).
    this.canvas.addEventListener("mousedown", (e) => e.preventDefault());
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("dblclick", (e) => this.dblclick(e));
    this.canvas.addEventListener("contextmenu", (e) => this.context(e));
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.scrollbar(this.vbar, "v");
    this.scrollbar(this.hbar, "h");
  }

  private get model() {
    return this.host.model();
  }

  private get g() {
    return SCALE * this.host.zoom();
  }

  /** The workbook changed: re-read cells (`content`), then draw at the next frame. */
  invalidate(content = true) {
    if (content) {
      this.cache.clear();
      this.extent = null;
    }
    if (!this.frame) this.frame = requestAnimationFrame(() => ((this.frame = 0), this.draw()));
  }

  /** How many rows and columns fill the window (the engine's navigation scrolls by it). */
  private resize() {
    const r = this.el.getBoundingClientRect();
    this.width = Math.max(0, r.width - 12);
    this.height = Math.max(0, r.height - 12);
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.tellWindow();
    this.invalidate(false);
  }

  /** Scrolls as little as needed for the cell to show whole (frozen panes stay). */
  reveal(row: number, col: number) {
    const m = this.model;
    const sheet = this.host.sheet();
    const g = this.g;
    const v = m.getSelectedView();
    const fit = (target: number, first: number, frozen: number, room: number, size: (i: number) => number) => {
      if (target <= frozen) return first;
      for (let i = 1; i <= frozen; i++) room -= size(i);
      if (target < first) return target;
      let sum = 0;
      for (let i = target; i >= first && target - i < 2000; i--) {
        sum += size(i);
        if (sum > room) return Math.min(target, i + 1);
      }
      return first;
    };
    const top = fit(row, v.top_row, m.getFrozenRowsCount(sheet), this.height - this.headH, (r) => m.getRowHeight(sheet, r) * g);
    const left = fit(col, v.left_column, m.getFrozenColumnsCount(sheet), this.width - this.headW, (c) => m.getColumnWidth(sheet, c) * g);
    if (top !== v.top_row || left !== v.left_column) m.setTopLeftVisibleCell(top, left);
  }

  /** The engine measures the window in its own pixels, without the headers. */
  tellWindow() {
    const g = this.g;
    this.model.setWindowWidth(Math.max(1, (this.width - this.headW) / g));
    this.model.setWindowHeight(Math.max(1, (this.height - this.headH) / g));
  }

  // ---- reading cells

  private cell(row: number, col: number): Cell {
    const key = row * 20_000 + col;
    let c = this.cache.get(key);
    if (!c) {
      const sheet = this.host.sheet();
      const m = this.model;
      const text = this.host.showFormulas() ? m.getCellContent(sheet, row, col) : m.getFormattedCellValue(sheet, row, col);
      c = { text, type: text ? m.getCellType(sheet, row, col) : 0, style: m.getCellStyle(sheet, row, col) };
      this.cache.set(key, c);
    }
    return c;
  }

  private color(c: unknown): string {
    if (c == null) return "";
    try {
      return this.model.resolveColor(c as Parameters<Model["resolveColor"]>[0]);
    } catch {
      return "";
    }
  }

  // ---- layout

  private palette(): Palette {
    return document.documentElement.dataset.theme === "light" ? LIGHT : DARK;
  }

  /** Which rows and columns show, and where (frozen ones first). */
  private layout() {
    const m = this.model;
    const sheet = this.host.sheet();
    const g = this.g;
    const view = m.getSelectedView();
    const headings = this.host.showHeadings();
    this.headH = headings ? Math.round(22 * this.host.zoom()) : 0;
    const frozenRows = m.getFrozenRowsCount(sheet);
    const frozenCols = m.getFrozenColumnsCount(sheet);
    // Row numbers get as wide as the last one shown needs.
    const lastRowGuess = view.top_row + Math.ceil(this.height / (20 * this.host.zoom()));
    this.headW = headings ? Math.round(Math.max(34, 9 + String(lastRowGuess).length * 8) * this.host.zoom()) : 0;
    this.rows = [];
    let y = this.headH;
    for (let r = 1; r <= frozenRows && y < this.height; r++) {
      const size = m.getRowHeight(sheet, r) * g;
      this.rows.push({ index: r, at: y, size });
      y += size;
    }
    for (let r = Math.max(view.top_row, frozenRows + 1); r <= LAST_ROW && y < this.height; r++) {
      const size = m.getRowHeight(sheet, r) * g;
      if (size <= 0) continue;
      this.rows.push({ index: r, at: y, size });
      y += size;
    }
    this.cols = [];
    let x = this.headW;
    for (let c = 1; c <= frozenCols && x < this.width; c++) {
      const size = m.getColumnWidth(sheet, c) * g;
      this.cols.push({ index: c, at: x, size });
      x += size;
    }
    for (let c = Math.max(view.left_column, frozenCols + 1); c <= LAST_COLUMN && x < this.width; c++) {
      const size = m.getColumnWidth(sheet, c) * g;
      if (size <= 0) continue;
      this.cols.push({ index: c, at: x, size });
      x += size;
    }
    return { view, frozenRows, frozenCols };
  }

  private rowLine(row: number) {
    return this.rows.find((l) => l.index === row);
  }

  private colLine(col: number) {
    return this.cols.find((l) => l.index === col);
  }

  /** The rectangle of a range on screen, clipped to what shows; null when none of it does. */
  private rangeRect(range: Range): { x: number; y: number; w: number; h: number } | null {
    const [r1, c1, r2, c2] = normalized(range);
    const rs = this.rows.filter((l) => l.index >= r1 && l.index <= r2);
    const cs = this.cols.filter((l) => l.index >= c1 && l.index <= c2);
    if (!rs.length || !cs.length) return null;
    const x = cs[0].at;
    const y = rs[0].at;
    return { x, y, w: cs[cs.length - 1].at + cs[cs.length - 1].size - x, h: rs[rs.length - 1].at + rs[rs.length - 1].size - y };
  }

  /** The active cell's box in page coordinates, for the cell editor. */
  cellBox(row: number, col: number): DOMRect | null {
    const merge = this.mergeAt(row, col);
    const rect = this.rangeRect(merge ?? [row, col, row, col]);
    if (!rect) return null;
    const base = this.canvas.getBoundingClientRect();
    return new DOMRect(base.left + rect.x, base.top + rect.y, rect.w, rect.h);
  }

  /** The cell's style and its font in CSS, for the cell editor. */
  cellLook(row: number, col: number) {
    const c = this.cell(row, col);
    const f = c.style.style.font;
    const fill = this.color(c.style.style.fill.color);
    return {
      font: `${f.i ? "italic " : ""}${f.b ? "bold " : ""}${Math.max(6, f.sz * 4 / 3 * this.g)}px ${fontStack(f.name)}`,
      color: this.textColor(c, fill),
      background: fill || this.palette().bg,
      align: c.style.style.alignment?.horizontal ?? "general",
    };
  }

  private merges(): { row: number; column: number; width: number; height: number }[] {
    try {
      return this.model.getMergedCells(this.host.sheet());
    } catch {
      return [];
    }
  }

  private mergeAt(row: number, col: number): Range | null {
    for (const m of this.merges()) {
      if (row >= m.row && row < m.row + m.height && col >= m.column && col < m.column + m.width) return [m.row, m.column, m.row + m.height - 1, m.column + m.width - 1];
    }
    return null;
  }

  /** Where the data ends (for the scroll bars); a cheap look at the columns and rows that show. */
  private used(): { rows: number; cols: number } {
    if (this.extent) return this.extent;
    const m = this.model;
    const sheet = this.host.sheet();
    let rows = 1;
    let cols = 1;
    for (const l of this.cols.slice(0, 60)) {
      const list = m.getRowsWithData(sheet, l.index);
      if (list.length) rows = Math.max(rows, list[list.length - 1]);
    }
    for (const l of this.rows.slice(0, 80)) {
      const list = m.getColumnsWithData(sheet, l.index);
      if (list.length) cols = Math.max(cols, list[list.length - 1]);
    }
    this.extent = { rows, cols };
    return this.extent;
  }

  // ---- drawing

  draw() {
    if (!this.width || !this.height) return;
    const { view, frozenRows, frozenCols } = this.layout();
    const ctx = this.ctx;
    const dpr = devicePixelRatio || 1;
    const p = this.palette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    const right = this.cols.length ? this.cols[this.cols.length - 1].at + this.cols[this.cols.length - 1].size : this.headW;
    const bottom = this.rows.length ? this.rows[this.rows.length - 1].at + this.rows[this.rows.length - 1].size : this.headH;
    const merges = this.merges().filter((m) => this.rangeRect([m.row, m.column, m.row + m.height - 1, m.column + m.width - 1]));
    const inMerge = (r: number, c: number) => merges.find((m) => r >= m.row && r < m.row + m.height && c >= m.column && c < m.column + m.width);

    // Fills.
    for (const rl of this.rows) {
      for (const cl of this.cols) {
        if (inMerge(rl.index, cl.index)) continue;
        const fill = this.color(this.cell(rl.index, cl.index).style.style.fill.color);
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fillRect(cl.at, rl.at, cl.size, rl.size);
        }
      }
    }

    // Gridlines (under borders and merged cells).
    if (this.host.showGridlines()) {
      ctx.strokeStyle = p.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const cl of this.cols) {
        const x = Math.round(cl.at + cl.size) - 0.5;
        ctx.moveTo(x, this.headH);
        ctx.lineTo(x, bottom);
      }
      for (const rl of this.rows) {
        const y = Math.round(rl.at + rl.size) - 0.5;
        ctx.moveTo(this.headW, y);
        ctx.lineTo(right, y);
      }
      ctx.stroke();
    }

    // Data bars under the text.
    for (const rl of this.rows) {
      for (const cl of this.cols) {
        const bar = this.cell(rl.index, cl.index).style.data_bar;
        if (!bar) continue;
        // `value` is the bar's share of the cell (negative to the left of the axis).
        const share = Math.max(-1, Math.min(1, bar.value > 1 ? bar.value / 100 : bar.value));
        const axis = cl.at + 2 + (cl.size - 4) * Math.max(0, Math.min(1, bar.axis_position || 0));
        const len = (cl.size - 4) * Math.abs(share);
        ctx.fillStyle = this.color(share < 0 ? bar.negative_color : bar.positive_color) || "#638ec6";
        ctx.globalAlpha = 0.6;
        ctx.fillRect(share < 0 ? axis - len : axis, rl.at + 3, len, rl.size - 6);
        ctx.globalAlpha = 1;
      }
    }

    // Merged cells: one box each, covering the gridlines inside.
    for (const m of merges) {
      const rect = this.rangeRect([m.row, m.column, m.row + m.height - 1, m.column + m.width - 1]);
      if (!rect) continue;
      const fill = this.color(this.cell(m.row, m.column).style.style.fill.color);
      ctx.fillStyle = fill || p.bg;
      ctx.fillRect(rect.x, rect.y, rect.w - 1, rect.h - 1);
    }

    // Text, row by row; empty neighbours take the overflow.
    for (const rl of this.rows) {
      for (let i = 0; i < this.cols.length; i++) {
        const cl = this.cols[i];
        const merge = inMerge(rl.index, cl.index);
        if (merge && (merge.row !== rl.index || merge.column !== cl.index)) continue;
        const c = this.cell(rl.index, cl.index);
        if (!c.text) continue;
        const rect = merge ? this.rangeRect([merge.row, merge.column, merge.row + merge.height - 1, merge.column + merge.width - 1])! : { x: cl.at, y: rl.at, w: cl.size, h: rl.size };
        this.text(c, rect, i, rl.index, !!merge);
      }
    }

    // Borders.
    for (const rl of this.rows) {
      for (const cl of this.cols) {
        const b = this.cell(rl.index, cl.index).style.style.border;
        if (!b || (!b.top && !b.bottom && !b.left && !b.right)) continue;
        const x1 = cl.at;
        const y1 = rl.at;
        const x2 = cl.at + cl.size;
        const y2 = rl.at + rl.size;
        this.edge(b.top, x1, y1, x2, y1);
        this.edge(b.bottom, x1, y2, x2, y2);
        this.edge(b.left, x1, y1, x1, y2);
        this.edge(b.right, x2, y1, x2, y2);
      }
    }

    // Frozen panes.
    ctx.strokeStyle = p.freeze;
    ctx.lineWidth = 1;
    if (frozenRows) {
      const l = this.rowLine(frozenRows);
      if (l) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(l.at + l.size) + 0.5);
        ctx.lineTo(this.width, Math.round(l.at + l.size) + 0.5);
        ctx.stroke();
      }
    }
    if (frozenCols) {
      const l = this.colLine(frozenCols);
      if (l) {
        ctx.beginPath();
        ctx.moveTo(Math.round(l.at + l.size) + 0.5, 0);
        ctx.lineTo(Math.round(l.at + l.size) + 0.5, this.height);
        ctx.stroke();
      }
    }

    this.filterButtons(p);
    this.selection(view, p);
    this.extras();
    if (this.host.showHeadings()) this.headers(view, p);
    this.scrollbars(view);
  }

  /** Where the ▾ of each filtered header cell is. */
  private filterRects(): { col: number; x: number; y: number; size: number }[] {
    const f = this.host.filter();
    const rl = f && this.rowLine(f.row);
    if (!f || !rl) return [];
    const size = Math.min(16 * this.host.zoom(), rl.size - 4);
    return this.cols.filter((l) => l.index >= f.c1 && l.index <= f.c2).map((l) => ({ col: l.index, x: l.at + l.size - size - 3, y: rl.at + (rl.size - size) / 2, size }));
  }

  private filterButtons(p: Palette) {
    const f = this.host.filter();
    if (!f) return;
    const ctx = this.ctx;
    for (const b of this.filterRects()) {
      const on = f.filtered.has(b.col);
      ctx.fillStyle = on ? p.selLine : p.headBg;
      ctx.strokeStyle = p.headLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.size - 1, b.size - 1, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = on ? "#ffffff" : p.headText;
      ctx.beginPath();
      const cx = b.x + b.size / 2;
      const cy = b.y + b.size / 2;
      if (on) {
        // A funnel: this column is filtered.
        ctx.moveTo(cx - 4, cy - 3);
        ctx.lineTo(cx + 4, cy - 3);
        ctx.lineTo(cx + 1, cy + 0.5);
        ctx.lineTo(cx + 1, cy + 4);
        ctx.lineTo(cx - 1, cy + 3);
        ctx.lineTo(cx - 1, cy + 0.5);
      } else {
        ctx.moveTo(cx - 3.5, cy - 1.5);
        ctx.lineTo(cx + 3.5, cy - 1.5);
        ctx.lineTo(cx, cy + 2.5);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  private textColor(c: Cell, fill: string): string {
    const f = this.color(c.style.style.font.color);
    const automatic = !f || f.toLowerCase() === "#000000";
    if (!automatic) return f;
    // "Automatic" text follows the theme on no fill (as Excel's dark mode does), and on a fill
    // takes black or white, whichever reads.
    if (!fill) return this.palette().text;
    const n = Number.parseInt(fill.slice(1, 7), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.55 ? "#000000" : "#ffffff";
  }

  private text(c: Cell, rect: { x: number; y: number; w: number; h: number }, colIndex: number, row: number, merged: boolean) {
    const ctx = this.ctx;
    const s = c.style.style;
    const g = this.g;
    const size = Math.max(6, s.font.sz * 4 / 3 * g);
    ctx.font = `${s.font.i ? "italic " : ""}${s.font.b ? "bold " : ""}${size}px ${fontStack(s.font.name)}`;
    const fill = this.color(s.fill.color);
    ctx.fillStyle = this.textColor(c, fill);
    const pad = 3 * this.host.zoom();
    let align = s.alignment?.horizontal ?? "general";
    if (align === "general" || align === "fill" || align === "justify" || align === "distributed" || align === "centerContinuous") {
      align = align === "centerContinuous" ? "center" : this.host.showFormulas() ? "left" : c.type === CELL_NUMBER ? "right" : c.type === CELL_BOOLEAN || c.type === CELL_ERROR ? "center" : "left";
    }
    const vertical = s.alignment?.vertical ?? "bottom";
    const wrap = !!s.alignment?.wrap_text;
    let text = c.text;
    let lines = [text];
    let clipX = rect.x;
    let clipW = rect.w;
    const width = ctx.measureText(text).width;
    if (wrap) {
      lines = this.wrapLines(text, rect.w - pad * 2);
    } else if (width > rect.w - pad * 2) {
      if (c.type === CELL_NUMBER && !this.host.showFormulas()) {
        // Excel shows a number that doesn't fit as ###.
        const hash = ctx.measureText("#").width || 1;
        text = "#".repeat(Math.max(1, Math.floor((rect.w - pad * 2) / hash)));
        lines = [text];
      } else if (!merged) {
        // Text runs on through empty neighbours.
        const empty = (i: number) => {
          const l = this.cols[i];
          return l && !this.cell(row, l.index).text && !this.mergeAt(row, l.index);
        };
        if (align === "left" || align === "center") {
          let end = colIndex;
          while (end + 1 < this.cols.length && empty(end + 1) && this.cols[end + 1].at + this.cols[end + 1].size - rect.x < width + pad * 2) end++;
          if (align === "left" || end > colIndex) clipW = this.cols[end].at + this.cols[end].size - rect.x;
        }
        if (align === "right" || align === "center") {
          let start = colIndex;
          while (start - 1 >= 0 && empty(start - 1) && rect.x + rect.w - this.cols[start - 1].at < width + pad * 2) start--;
          clipW += clipX - this.cols[start].at;
          clipX = this.cols[start].at;
        }
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX + 1, rect.y + 1, clipW - 2, rect.h - 2);
    ctx.clip();
    const lineH = size * 1.2;
    const block = lineH * lines.length;
    let y = vertical === "top" ? rect.y + pad + size * 0.95 : vertical === "center" ? rect.y + (rect.h - block) / 2 + size * 0.95 : rect.y + rect.h - block + size * 0.95 - pad * 0.6;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      const x = align === "right" ? rect.x + rect.w - pad - w : align === "center" ? rect.x + (rect.w - w) / 2 : rect.x + pad;
      ctx.fillText(line, x, y);
      if (s.font.u || s.font.strike) {
        ctx.fillRect(x, s.font.u ? y + size * 0.12 : y - size * 0.3, w, Math.max(1, size / 14));
      }
      y += lineH;
    }
    ctx.restore();
  }

  private wrapLines(text: string, width: number): string[] {
    const ctx = this.ctx;
    const out: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (line && ctx.measureText(next).width > width) {
          out.push(line.trimEnd());
          line = word.trimStart();
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  private edge(b: { style: string; color?: unknown } | undefined, x1: number, y1: number, x2: number, y2: number) {
    if (!b) return;
    const ctx = this.ctx;
    const width = b.style === "thick" ? 3 : b.style.startsWith("medium") ? 2 : 1;
    // Black lines follow the theme like automatic text (light on the dark grid).
    const c = this.color(b.color);
    ctx.strokeStyle = !c || (c.toLowerCase() === "#000000" && this.palette() === DARK) ? this.palette().text : c;
    ctx.lineWidth = width;
    ctx.setLineDash(b.style === "dotted" ? [1, 2] : b.style.includes("dash") ? [4, 2] : []);
    const off = width % 2 ? 0.5 : 0;
    ctx.beginPath();
    if (b.style === "double") {
      const horizontal = y1 === y2;
      for (const d of [-1, 1]) {
        ctx.moveTo(Math.round(x1) + (horizontal ? 0 : d) + off, Math.round(y1) + (horizontal ? d : 0) + off);
        ctx.lineTo(Math.round(x2) + (horizontal ? 0 : d) + off, Math.round(y2) + (horizontal ? d : 0) + off);
      }
    } else {
      ctx.moveTo(Math.round(x1) - off, Math.round(y1) - off);
      ctx.lineTo(Math.round(x2) - off, Math.round(y2) - off);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private selection(view: ReturnType<Model["getSelectedView"]>, p: Palette) {
    const ctx = this.ctx;
    const range = normalized(view.range as Range);
    const rect = this.rangeRect(range);
    if (rect) {
      const single = range[0] === range[2] && range[1] === range[3];
      const merge = this.mergeAt(view.row, view.column);
      const sameAsMerge = merge && merge.every((v, i) => v === range[i]);
      if (!single && !sameAsMerge) {
        // The range is tinted, all but the active cell.
        const active = this.rangeRect(merge ?? [view.row, view.column, view.row, view.column]);
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        if (active) ctx.rect(active.x, active.y, active.w, active.h);
        ctx.clip("evenodd");
        ctx.fillStyle = p.selFill;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.restore();
      }
      ctx.strokeStyle = p.selLine;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.round(rect.w) - 1, Math.round(rect.h) - 1);
      // The fill handle.
      if (rect.x + rect.w <= this.width && rect.y + rect.h <= this.height && range[2] < LAST_ROW && range[3] < LAST_COLUMN) {
        ctx.fillStyle = p.selLine;
        ctx.fillRect(rect.x + rect.w - FILL_HANDLE / 2 - 1, rect.y + rect.h - FILL_HANDLE / 2 - 1, FILL_HANDLE, FILL_HANDLE);
        ctx.fillStyle = p.bg;
        ctx.fillRect(rect.x + rect.w - FILL_HANDLE / 2 - 2, rect.y + rect.h - FILL_HANDLE / 2 - 2, FILL_HANDLE + 2, 1);
        ctx.fillRect(rect.x + rect.w - FILL_HANDLE / 2 - 2, rect.y + rect.h - FILL_HANDLE / 2 - 2, 1, FILL_HANDLE + 2);
      }
    }
    // A fill being dragged.
    if (this.drag?.kind === "fill" && this.drag.to) {
      const [r1, c1, r2, c2] = range;
      const [tr, tc] = this.drag.to;
      const vertical = Math.abs(tr - (tr > r2 ? r2 : r1)) >= Math.abs(tc - (tc > c2 ? c2 : c1));
      const target: Range = vertical ? [Math.min(r1, tr), c1, Math.max(r2, tr), c2] : [r1, Math.min(c1, tc), r2, Math.max(c2, tc)];
      const t = this.rangeRect(target);
      if (t) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = p.selLine;
        ctx.lineWidth = 1;
        ctx.strokeRect(t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1);
        ctx.setLineDash([]);
      }
    }
  }

  /** Copied range (marching ants) and the references of the formula being typed. */
  private extras() {
    const ctx = this.ctx;
    for (const hl of this.host.highlights()) {
      const r = this.rangeRect(hl.range);
      if (!r) continue;
      ctx.fillStyle = hl.color;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = hl.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }
    const copied = this.host.copied();
    if (copied) {
      const r = this.rangeRect(copied);
      if (r) {
        ctx.strokeStyle = this.palette().selLine;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.lineDashOffset = -this.antsOffset;
        ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
      if (!this.antsTimer) {
        this.antsTimer = window.setInterval(() => {
          if (!this.host.copied()) {
            clearInterval(this.antsTimer);
            this.antsTimer = 0;
          }
          this.antsOffset = (this.antsOffset + 1) % 8;
          this.invalidate(false);
        }, 90);
      }
    }
  }

  private headers(view: ReturnType<Model["getSelectedView"]>, p: Palette) {
    const ctx = this.ctx;
    const [r1, c1, r2, c2] = normalized(view.range as Range);
    const fullRows = c1 === 1 && c2 === LAST_COLUMN;
    const fullCols = r1 === 1 && r2 === LAST_ROW;
    ctx.fillStyle = p.headBg;
    ctx.fillRect(0, 0, this.width, this.headH);
    ctx.fillRect(0, 0, this.headW, this.height);
    ctx.font = `${Math.round(11.5 * this.host.zoom())}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    for (const cl of this.cols) {
      const on = cl.index >= c1 && cl.index <= c2;
      if (on) {
        ctx.fillStyle = p.headSel;
        ctx.fillRect(cl.at, 0, cl.size, this.headH);
        ctx.fillStyle = p.selLine;
        ctx.fillRect(cl.at, this.headH - 2, cl.size, 2);
      }
      ctx.fillStyle = on && fullCols ? p.headSelText : on ? p.headSelText : p.headText;
      if (cl.size > 12) ctx.fillText(columnName(cl.index), cl.at + cl.size / 2, this.headH / 2 + 0.5);
    }
    for (const rl of this.rows) {
      const on = rl.index >= r1 && rl.index <= r2;
      if (on) {
        ctx.fillStyle = p.headSel;
        ctx.fillRect(0, rl.at, this.headW, rl.size);
        ctx.fillStyle = p.selLine;
        ctx.fillRect(this.headW - 2, rl.at, 2, rl.size);
      }
      ctx.fillStyle = on && fullRows ? p.headSelText : on ? p.headSelText : p.headText;
      if (rl.size > 8) ctx.fillText(String(rl.index), this.headW / 2, rl.at + rl.size / 2 + 0.5);
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    ctx.strokeStyle = p.headLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const cl of this.cols) {
      const x = Math.round(cl.at + cl.size) - 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.headH);
    }
    for (const rl of this.rows) {
      const y = Math.round(rl.at + rl.size) - 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.headW, y);
    }
    ctx.moveTo(0, this.headH - 0.5);
    ctx.lineTo(this.width, this.headH - 0.5);
    ctx.moveTo(this.headW - 0.5, 0);
    ctx.lineTo(this.headW - 0.5, this.height);
    ctx.stroke();
    // The select-all corner.
    ctx.fillStyle = p.headLine;
    ctx.beginPath();
    ctx.moveTo(this.headW - 4, this.headH - 4);
    ctx.lineTo(this.headW - 4, this.headH - 12);
    ctx.lineTo(this.headW - 12, this.headH - 4);
    ctx.closePath();
    ctx.fill();
  }

  // ---- scroll bars

  private scrollbars(view: ReturnType<Model["getSelectedView"]>) {
    const used = this.used();
    const shownRows = Math.max(1, this.rows.length - 1);
    const shownCols = Math.max(1, this.cols.length - 1);
    const totalRows = Math.max(used.rows + shownRows, view.top_row + shownRows * 2, 100);
    const totalCols = Math.max(used.cols + shownCols, view.left_column + shownCols * 2, 26);
    this.thumb(this.vbar, shownRows / totalRows, (view.top_row - 1) / totalRows);
    this.thumb(this.hbar, shownCols / totalCols, (view.left_column - 1) / totalCols);
    (this.vbar as HTMLElement & { total?: number }).dataset.total = String(totalRows);
    (this.hbar as HTMLElement & { total?: number }).dataset.total = String(totalCols);
  }

  private thumb(bar: HTMLElement, size: number, at: number) {
    const thumb = bar.firstElementChild as HTMLElement;
    const vertical = bar.classList.contains("v");
    const track = vertical ? bar.clientHeight : bar.clientWidth;
    const len = Math.max(24, Math.min(track, track * size));
    const pos = Math.min(track - len, track * at);
    thumb.style[vertical ? "height" : "width"] = `${len}px`;
    thumb.style[vertical ? "top" : "left"] = `${pos}px`;
  }

  private scrollbar(bar: HTMLElement, axis: "v" | "h") {
    const thumb = bar.firstElementChild as HTMLElement;
    let start: { pointer: number; index: number } | null = null;
    const total = () => Number(bar.dataset.total) || 100;
    const track = () => (axis === "v" ? bar.clientHeight : bar.clientWidth);
    const go = (index: number) => {
      const view = this.model.getSelectedView();
      const i = Math.max(1, Math.round(index));
      if (axis === "v") this.model.setTopLeftVisibleCell(Math.min(LAST_ROW, i), view.left_column);
      else this.model.setTopLeftVisibleCell(view.top_row, Math.min(LAST_COLUMN, i));
      this.invalidate(false);
      this.host.selectionChanged();
    };
    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      thumb.setPointerCapture(e.pointerId);
      const view = this.model.getSelectedView();
      start = { pointer: axis === "v" ? e.clientY : e.clientX, index: axis === "v" ? view.top_row : view.left_column };
    });
    thumb.addEventListener("pointermove", (e) => {
      if (!start) return;
      const delta = (axis === "v" ? e.clientY : e.clientX) - start.pointer;
      go(start.index + (delta / track()) * total());
    });
    thumb.addEventListener("pointerup", () => (start = null));
    bar.addEventListener("pointerdown", (e) => {
      if (e.target !== bar) return;
      const r = bar.getBoundingClientRect();
      const at = axis === "v" ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      go(1 + at * total());
    });
  }

  // ---- pointer

  private hit(x: number, y: number): { at: "corner" | "column" | "row" | "cell" | "col-edge" | "row-edge" | "fill" | "none"; row: number; col: number } {
    const col = this.cols.find((l) => x >= l.at && x < l.at + l.size);
    const row = this.rows.find((l) => y >= l.at && y < l.at + l.size);
    if (y < this.headH && x < this.headW) return { at: "corner", row: 0, col: 0 };
    if (y < this.headH) {
      const edge = this.cols.find((l) => Math.abs(x - (l.at + l.size)) <= 4);
      if (edge) return { at: "col-edge", row: 0, col: edge.index };
      return { at: col ? "column" : "none", row: 0, col: col?.index ?? 0 };
    }
    if (x < this.headW) {
      const edge = this.rows.find((l) => Math.abs(y - (l.at + l.size)) <= 3);
      if (edge) return { at: "row-edge", row: edge.index, col: 0 };
      return { at: row ? "row" : "none", row: row?.index ?? 0, col: 0 };
    }
    const view = this.model.getSelectedView();
    const sel = this.rangeRect(normalized(view.range as Range));
    if (sel && Math.abs(x - (sel.x + sel.w)) <= FILL_HANDLE && Math.abs(y - (sel.y + sel.h)) <= FILL_HANDLE) return { at: "fill", row: 0, col: 0 };
    if (!row || !col) return { at: "none", row: row?.index ?? 0, col: col?.index ?? 0 };
    return { at: "cell", row: row.index, col: col.index };
  }

  private local(e: PointerEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The cell under a point, or the nearest one when outside (while dragging past the edge). */
  private cellNear(x: number, y: number): [number, number] {
    const lastR = this.rows[this.rows.length - 1];
    const lastC = this.cols[this.cols.length - 1];
    const row = this.rows.find((l) => y >= l.at && y < l.at + l.size)?.index ?? (y < this.headH ? this.rows[0]?.index ?? 1 : lastR?.index ?? 1);
    const col = this.cols.find((l) => x >= l.at && x < l.at + l.size)?.index ?? (x < this.headW ? this.cols[0]?.index ?? 1 : lastC?.index ?? 1);
    return [row, col];
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    const hit = this.hit(x, y);
    const m = this.model;
    if (!this.host.picking()) this.host.focus();
    const button = this.filterRects().find((b) => x >= b.x && x <= b.x + b.size && y >= b.y && y <= b.y + b.size);
    if (button && !this.host.picking()) {
      e.preventDefault();
      const base = this.canvas.getBoundingClientRect();
      this.host.filterClick(button.col, new DOMRect(base.left + button.x, base.top + button.y, button.size, button.size));
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.lastPointer = { x, y };
    if (this.host.picking() && (hit.at === "cell" || hit.at === "column" || hit.at === "row")) {
      e.preventDefault();
      const range: Range = hit.at === "cell" ? [hit.row, hit.col, hit.row, hit.col] : hit.at === "column" ? [1, hit.col, LAST_ROW, hit.col] : [hit.row, 1, hit.row, LAST_COLUMN];
      this.drag = { kind: "pick", anchor: [hit.row || 1, hit.col || 1], range };
      this.host.pick(range, false);
      return;
    }
    switch (hit.at) {
      case "corner":
        m.setSelectedRange(1, 1, LAST_ROW, LAST_COLUMN);
        break;
      case "column": {
        const view = m.getSelectedView();
        if (e.shiftKey) m.setSelectedRange(1, Math.min(view.column, hit.col), LAST_ROW, Math.max(view.column, hit.col));
        else {
          m.setSelectedCell(view.top_row, hit.col);
          m.setSelectedRange(1, hit.col, LAST_ROW, hit.col);
        }
        this.drag = { kind: "cols", index: e.shiftKey ? view.column : hit.col };
        break;
      }
      case "row": {
        const view = m.getSelectedView();
        if (e.shiftKey) m.setSelectedRange(Math.min(view.row, hit.row), 1, Math.max(view.row, hit.row), LAST_COLUMN);
        else {
          m.setSelectedCell(hit.row, view.left_column);
          m.setSelectedRange(hit.row, 1, hit.row, LAST_COLUMN);
        }
        this.drag = { kind: "rows", index: e.shiftKey ? view.row : hit.row };
        break;
      }
      case "col-edge":
        this.drag = { kind: "resize-col", index: hit.col, start: x, startSize: this.colLine(hit.col)?.size ?? 0 };
        this.showGuide("col", x);
        return;
      case "row-edge":
        this.drag = { kind: "resize-row", index: hit.row, start: y, startSize: this.rowLine(hit.row)?.size ?? 0 };
        this.showGuide("row", y);
        return;
      case "fill":
        this.drag = { kind: "fill" };
        return;
      case "cell":
        if (e.shiftKey) m.onAreaSelecting(hit.row, hit.col);
        else m.setSelectedCell(hit.row, hit.col);
        this.drag = { kind: "select" };
        break;
      default:
        return;
    }
    this.invalidate(false);
    this.host.selectionChanged();
  }

  private move(e: PointerEvent) {
    const { x, y } = this.local(e);
    this.lastPointer = { x, y };
    if (!this.drag) {
      const hit = this.hit(x, y);
      this.canvas.style.cursor = hit.at === "col-edge" ? "col-resize" : hit.at === "row-edge" ? "row-resize" : hit.at === "fill" ? "crosshair" : hit.at === "column" ? "s-resize" : hit.at === "row" ? "e-resize" : "cell";
      return;
    }
    this.dragTo(x, y);
    this.keepScrolling();
  }

  private dragTo(x: number, y: number) {
    const d = this.drag!;
    const m = this.model;
    const [row, col] = this.cellNear(x, y);
    if (d.kind === "resize-col" || d.kind === "resize-row") {
      this.showGuide(d.kind === "resize-col" ? "col" : "row", d.kind === "resize-col" ? Math.max((this.colLine(d.index!)?.at ?? 0) + 2, x) : Math.max((this.rowLine(d.index!)?.at ?? 0) + 2, y));
      return;
    }
    if (d.kind === "pick") {
      const [ar, ac] = d.anchor!;
      d.range = normalized([ar, ac, row, col]);
      this.host.pick(d.range, false);
      return;
    }
    if (d.kind === "fill") {
      d.to = [row, col];
      this.invalidate(false);
      return;
    }
    if (d.kind === "cols") m.setSelectedRange(1, Math.min(d.index!, col), LAST_ROW, Math.max(d.index!, col));
    else if (d.kind === "rows") m.setSelectedRange(Math.min(d.index!, row), 1, Math.max(d.index!, row), LAST_COLUMN);
    else m.onAreaSelecting(row, col);
    this.invalidate(false);
    this.host.selectionChanged();
  }

  /** Dragging past an edge keeps the sheet scrolling that way. */
  private keepScrolling() {
    if (this.autoScroll || !this.drag || this.drag.kind.startsWith("resize")) return;
    const step = () => {
      if (!this.drag || !this.lastPointer) {
        this.autoScroll = 0;
        return;
      }
      const { x, y } = this.lastPointer;
      const view = this.model.getSelectedView();
      const dr = y > this.height - 4 ? 1 : y < this.headH && view.top_row > 1 ? -1 : 0;
      const dc = x > this.width - 4 ? 1 : x < this.headW && view.left_column > 1 ? -1 : 0;
      if (dr || dc) {
        this.model.setTopLeftVisibleCell(Math.max(1, view.top_row + dr), Math.max(1, view.left_column + dc));
        this.layout();
        this.dragTo(x, y);
        this.autoScroll = window.setTimeout(step, 50);
      } else this.autoScroll = 0;
    };
    this.autoScroll = window.setTimeout(step, 50);
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    clearTimeout(this.autoScroll);
    this.autoScroll = 0;
    if (!d) return;
    const { x, y } = this.local(e);
    const m = this.model;
    const sheet = this.host.sheet();
    if (d.kind === "resize-col" || d.kind === "resize-row") {
      this.guide.hidden = true;
      const size = Math.max(0, d.startSize! + ((d.kind === "resize-col" ? x : y) - d.start!)) / this.g;
      const view = m.getSelectedView();
      const [r1, c1, r2, c2] = normalized(view.range as Range);
      if (d.kind === "resize-col") {
        // Resizing one of several selected columns resizes them all.
        const all = r1 === 1 && r2 === LAST_ROW && d.index! >= c1 && d.index! <= c2;
        m.setColumnsWidth(sheet, all ? c1 : d.index!, all ? c2 : d.index!, size);
      } else {
        const all = c1 === 1 && c2 === LAST_COLUMN && d.index! >= r1 && d.index! <= r2;
        m.setRowsHeight(sheet, all ? r1 : d.index!, all ? r2 : d.index!, size);
      }
      this.host.changed();
      this.tellWindow();
      this.invalidate(true);
      return;
    }
    if (d.kind === "pick") {
      this.host.pick(d.range!, true);
      return;
    }
    if (d.kind === "select" || d.kind === "rows" || d.kind === "cols") this.host.selected();
    if (d.kind === "fill" && d.to) {
      const view = m.getSelectedView();
      const [r1, c1, r2, c2] = normalized(view.range as Range);
      const [tr, tc] = d.to;
      const source = { sheet, row: r1, column: c1, width: c2 - c1 + 1, height: r2 - r1 + 1 };
      const vertical = Math.abs(tr - (tr > r2 ? r2 : r1)) >= Math.abs(tc - (tc > c2 ? c2 : c1));
      try {
        if (vertical && (tr > r2 || tr < r1)) {
          m.autoFillRows(source, tr);
          m.setSelectedRange(Math.min(r1, tr), c1, Math.max(r2, tr), c2);
        } else if (!vertical && (tc > c2 || tc < c1)) {
          m.autoFillColumns(source, tc);
          m.setSelectedRange(r1, Math.min(c1, tc), r2, Math.max(c2, tc));
        }
        this.host.changed();
      } catch (err) {
        console.warn("Fill failed:", err);
      }
      this.invalidate(true);
      this.host.selectionChanged();
    }
  }

  private showGuide(axis: "col" | "row", at: number) {
    this.guide.hidden = false;
    this.guide.className = `sh-guide ${axis}`;
    if (axis === "col") Object.assign(this.guide.style, { left: `${at}px`, top: "0", width: "1px", height: `${this.height}px` });
    else Object.assign(this.guide.style, { top: `${at}px`, left: "0", height: "1px", width: `${this.width}px` });
  }

  private dblclick(e: MouseEvent) {
    const { x, y } = this.local(e);
    const hit = this.hit(x, y);
    if (hit.at === "col-edge") this.autofitColumn(hit.col);
    else if (hit.at === "row-edge") this.autofitRow(hit.row);
    else if (hit.at === "cell") this.host.edit();
  }

  /** Double-clicking a column's edge: as wide as its longest value. */
  autofitColumn(col: number) {
    const m = this.model;
    const sheet = this.host.sheet();
    const ctx = this.ctx;
    let widest = 0;
    for (const row of m.getRowsWithData(sheet, col).slice(0, 5000)) {
      const style = m.getCellStyle(sheet, row, col).style;
      ctx.font = `${style.font.i ? "italic " : ""}${style.font.b ? "bold " : ""}${style.font.sz * 4 / 3}px ${fontStack(style.font.name)}`;
      for (const line of m.getFormattedCellValue(sheet, row, col).split("\n")) widest = Math.max(widest, ctx.measureText(line).width);
    }
    m.setColumnsWidth(sheet, col, col, widest ? widest + 10 : 90);
    this.host.changed();
    this.invalidate(true);
  }

  autofitRow(row: number) {
    const m = this.model;
    const sheet = this.host.sheet();
    let tallest = 0;
    for (const col of m.getColumnsWithData(sheet, row).slice(0, 2000)) {
      const style = m.getCellStyle(sheet, row, col).style;
      const lines = m.getFormattedCellValue(sheet, row, col).split("\n").length;
      tallest = Math.max(tallest, style.font.sz * 4 / 3 * 1.2 * lines + 9);
    }
    m.setRowsHeight(sheet, row, row, Math.max(25, tallest));
    this.host.changed();
    this.invalidate(true);
  }

  private context(e: MouseEvent) {
    e.preventDefault();
    const { x, y } = this.local(e);
    const hit = this.hit(x, y);
    const m = this.model;
    const view = m.getSelectedView();
    const [r1, c1, r2, c2] = normalized(view.range as Range);
    if (hit.at === "cell" && !(hit.row >= r1 && hit.row <= r2 && hit.col >= c1 && hit.col <= c2)) {
      m.setSelectedCell(hit.row, hit.col);
      this.invalidate(false);
      this.host.selectionChanged();
    }
    if (hit.at === "column" && !(r1 === 1 && r2 === LAST_ROW && hit.col >= c1 && hit.col <= c2)) {
      m.setSelectedCell(view.top_row, hit.col);
      m.setSelectedRange(1, hit.col, LAST_ROW, hit.col);
      this.invalidate(false);
      this.host.selectionChanged();
    }
    if (hit.at === "row" && !(c1 === 1 && c2 === LAST_COLUMN && hit.row >= r1 && hit.row <= r2)) {
      m.setSelectedCell(hit.row, view.left_column);
      m.setSelectedRange(hit.row, 1, hit.row, LAST_COLUMN);
      this.invalidate(false);
      this.host.selectionChanged();
    }
    this.host.menu(e.clientX, e.clientY, hit.at === "column" || hit.at === "col-edge" ? "columns" : hit.at === "row" || hit.at === "row-edge" ? "rows" : "cell");
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey) {
      const z = this.host.zoom();
      this.host.setZoom(Math.round(Math.max(0.1, Math.min(4, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) * 100) / 100);
      return;
    }
    const lines = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 20 : 1 / 33;
    const horizontal = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const vertical = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    this.wheelRows += vertical * lines;
    this.wheelCols += horizontal * lines;
    const dr = Math.trunc(this.wheelRows);
    const dc = Math.trunc(this.wheelCols);
    if (!dr && !dc) return;
    this.wheelRows -= dr;
    this.wheelCols -= dc;
    const view = this.model.getSelectedView();
    this.model.setTopLeftVisibleCell(Math.max(1, Math.min(LAST_ROW, view.top_row + dr)), Math.max(1, Math.min(LAST_COLUMN, view.left_column + dc)));
    this.invalidate(false);
    this.host.selectionChanged();
  }

  dispose() {
    clearInterval(this.antsTimer);
    cancelAnimationFrame(this.frame);
  }
}
