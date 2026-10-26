import { BorderStyle, BorderType, type CellStyle, type CfRuleInput, type IronCalcTheme } from "@ironcalc/wasm";
import { getThemeList } from "@ironcalc/wasm";
import { h } from "../../../ui/dom";
import { field, openDialog, textInput, type Dialog } from "../../time/dialog";
import { areaOf, CELL_NUMBER, LAST_COLUMN, LAST_ROW, normalized, parseRange, rangeName, type Model } from "./engine";
import { safeLink } from "../api";
import { FUNCTION_CATEGORIES, FUNCTION_HELP, FUNCTION_NAMES } from "./functions";

type Range = [number, number, number, number];

/** What the editor gives its commands. */
export interface SheetBase {
  model(): Model;
  sheet(): number;
  selection(): Range;
  active(): [number, number];
  /** Runs a change to the workbook and redraws; a refusal shows as a toast. */
  run(change: () => void, message?: string): void;
  toast(text: string): void;
  /** Starts editing the active cell with this text. */
  edit(text: string | null): void;
  goTo(range: Range): void;
  paste(what: "all" | "values"): Promise<void>;
  copy(): void;
  cut(): void;
  /** Format Painter: picks up the selection's formats for the next range selected. */
  painter(): void;
  print(): void;
  /** Page Layout → Gridlines: Print. */
  printGridlines(): boolean;
  setPrintGridlines(on: boolean): void;
  showFormulas(): boolean;
  setShowFormulas(on: boolean): void;
  headings(): boolean;
  setHeadings(on: boolean): void;
  formulaBar(): boolean;
  setFormulaBar(on: boolean): void;
  zoom(): number;
  setZoom(zoom: number): void;
  autofit(what: "rows" | "columns"): void;
  openExternally(target: string): void;
  focus(): void;
}

export type NumberKind = "general" | "number" | "currency" | "accounting" | "shortDate" | "longDate" | "time" | "percent" | "fraction" | "scientific" | "text";

export const NUMBER_KINDS: [NumberKind, string][] = [
  ["general", "General"], ["number", "Number"], ["currency", "Currency"], ["accounting", "Accounting"], ["shortDate", "Short Date"],
  ["longDate", "Long Date"], ["time", "Time"], ["percent", "Percentage"], ["fraction", "Fraction"], ["scientific", "Scientific"], ["text", "Text"],
];

export const CURRENCIES: [string, string][] = [["৳", "৳ Bangladeshi Taka"], ["$", "$ US Dollar"], ["€", "€ Euro"], ["£", "£ British Pound"], ["₹", "₹ Indian Rupee"], ["¥", "¥ Yen"]];

export type BorderChoice = "Bottom" | "Top" | "Left" | "Right" | "None" | "All" | "Outer" | "Inner" | "ThickOuter" | "DoubleBottom" | "ThickBottom";

export interface SheetCommands {
  current(): CellStyle;
  style(path: string, value: string): void;
  toggle(path: "font.b" | "font.i" | "font.u" | "font.strike"): void;
  fontName(name: string): void;
  fontSize(size: number): void;
  grow(delta: number): void;
  fontColor(color: string | null): void;
  fillColor(color: string | null): void;
  align(horizontal: string): void;
  valign(vertical: string): void;
  wrap(): void;
  borders(choice: BorderChoice): void;
  borderLine(style: BorderStyle): void;
  borderLineStyle(): BorderStyle;
  borderColor(color: string | null): void;
  merge(kind: "center" | "across" | "merge" | "unmerge"): void;
  numberFormat(kind: NumberKind | string): void;
  numberKind(): string;
  currency(symbol: string): void;
  decimals(delta: number): void;
  thousands(): void;
  insert(what: "rows" | "columns" | "sheet" | "auto" | "ask"): void;
  remove(what: "rows" | "columns" | "sheet" | "auto" | "ask"): void;
  clear(kind: "all" | "formats" | "contents"): void;
  fill(direction: "down" | "right"): void;
  autoSum(fn: string): void;
  sort(ascending: boolean): void;
  /** Sorts `range` (its first row a header) by `col`. */
  sortRange(range: Range, col: number, ascending: boolean, header: boolean): void;
  /** The table around the active cell (or the selection). */
  region(): Range;
  hide(what: "rows" | "columns", hide: boolean): void;
  size(what: "rows" | "columns"): void;
  freeze(kind: "panes" | "row" | "column" | "none"): void;
  frozen(): boolean;
  gridlines(): boolean;
  setGridlines(on: boolean): void;
  formatCells(tab?: "number" | "alignment" | "font" | "fill"): void;
  insertFunction(category?: string): void;
  insertNamed(name: string): void;
  goTo(): void;
  find(replace: boolean): void;
  link(): void;
  followLink(): void;
  names(fromSelection?: boolean): void;
  repeat(): void;
  cellStyles(): string[];
  cellStyle(name: string): void;
  conditional(kind: "greater" | "less" | "between" | "equal" | "text" | "duplicates" | "top10" | "bottom10" | "above" | "below" | "databar" | "scale2" | "scale3" | "icons"): void;
  clearConditional(scope: "selection" | "sheet"): void;
  themes(): IronCalcTheme[];
  setTheme(theme: IronCalcTheme): void;
  calculate(): void;
}

/** Set by the editor (they need its AutoFilter). */
export interface FilterCommands {
  toggleFilter(): void;
  filterOn(): boolean;
  clearFilter(): void;
}

export type SheetActions = SheetBase & SheetCommands & FilterCommands;

/** Format codes for each kind. Currency literals are quoted so any symbol works. */
function formatFor(kind: NumberKind, symbol: string, fmt: { short_date: string; long_date: string }): string {
  const s = `"${symbol}"`;
  switch (kind) {
    case "general": return "general";
    case "number": return "#,##0.00";
    case "currency": return `${s}#,##0.00`;
    case "accounting": return `${s} #,##0.00;${s} (#,##0.00);${s} "-"`;
    case "shortDate": return fmt.short_date || "dd/mm/yyyy";
    case "longDate": return fmt.long_date || "dddd, mmmm d, yyyy";
    case "time": return "h:mm:ss AM/PM";
    case "percent": return "0.00%";
    case "fraction": return "# ?/?";
    case "scientific": return "0.00E+00";
    case "text": return "@";
  }
}

/** One more or one fewer decimal place in every section of a format code. */
export function shiftDecimals(code: string, delta: number): string {
  if (!code || code.toLowerCase() === "general") return delta > 0 ? "0.0" : "0";
  return code.split(";").map((section) => {
    if (section === "@" || /^"[^"]*"$/.test(section)) return section;
    // Leave quoted text and [colours] alone.
    const parts = section.split(/("[^"]*"|\[[^\]]*\])/);
    let done = false;
    for (let i = parts.length - 1; i >= 0 && !done; i--) {
      if (i % 2 === 1) continue;
      const p = parts[i];
      const dot = p.lastIndexOf(".");
      if (dot >= 0 && /[0#]/.test(p.slice(dot + 1))) {
        if (delta > 0) parts[i] = p.slice(0, dot + 1) + "0" + p.slice(dot + 1);
        else {
          const after = p.slice(dot + 1).replace(/[0#]/, "");
          parts[i] = /[0#]/.test(after) ? p.slice(0, dot + 1) + after : p.slice(0, dot) + after;
        }
        done = true;
      } else if (/[0#]/.test(p)) {
        if (delta > 0) {
          const last = Math.max(p.lastIndexOf("0"), p.lastIndexOf("#"));
          parts[i] = p.slice(0, last + 1) + ".0" + p.slice(last + 1);
        }
        done = true;
      }
    }
    return parts.join("");
  }).join(";");
}

export function makeCommands(b: SheetBase): SheetCommands {
  const m = () => b.model();
  const area = () => areaOf(b.sheet(), b.selection());
  let lastStyle: (() => void) | null = null;
  let border: { style: BorderStyle; color: string } = { style: BorderStyle.Thin, color: "#000000" };
  let currencySymbol = "৳";

  /** A formatting change, remembered for F4 (Repeat). */
  function styled(change: () => void) {
    lastStyle = change;
    b.run(change);
  }

  /** The selection, cut down to where the data is when it's whole rows or columns. */
  function bounded(): Range {
    const [r1, c1, r2, c2] = b.selection();
    let lastRow = r2;
    let lastCol = c2;
    if (r2 === LAST_ROW || c2 === LAST_COLUMN) {
      let rows = 1;
      let cols = 1;
      for (let c = c1; c <= Math.min(c2, c1 + 300); c++) {
        const list = m().getRowsWithData(b.sheet(), c);
        if (list.length) {
          rows = Math.max(rows, list[list.length - 1]);
          cols = c;
        }
      }
      lastRow = Math.min(r2, Math.max(r1, rows));
      lastCol = Math.min(c2, Math.max(c1, cols));
    }
    return [r1, c1, lastRow, lastCol];
  }

  /** Changes every cell's full style (for what updateRangeStyle can't set, like the font name). */
  function restyle(edit: (s: CellStyle) => void) {
    const [r1, c1, r2, c2] = bounded();
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200_000) {
      b.toast("That selection is too big to restyle at once.");
      return;
    }
    const styles: CellStyle[][] = [];
    for (let r = r1; r <= r2; r++) {
      const row: CellStyle[] = [];
      for (let c = c1; c <= c2; c++) {
        const s = structuredClone(m().getCellStyle(b.sheet(), r, c).style);
        edit(s);
        row.push(s);
      }
      styles.push(row);
    }
    const v = m().getSelectedView();
    const range = v.range as Range;
    styled(() => {
      m().setSelectedCell(r1, c1);
      m().setSelectedRange(r1, c1, r2, c2);
      m().onPasteStyles(styles);
      m().setSelectedCell(v.row, v.column);
      m().setSelectedRange(...range);
    });
  }

  /** Rows grow to fit bigger text, as Excel's do (they never shrink here). */
  function growRows() {
    const [r1, c1, r2, c2] = bounded();
    const s = b.sheet();
    for (let r = r1; r <= Math.min(r2, r1 + 500); r++) {
      let need = 0;
      for (let c = c1; c <= Math.min(c2, c1 + 200); c++) need = Math.max(need, m().getCellStyle(s, r, c).style.font.sz * 4 / 3 * 1.2 + 5);
      if (need > m().getRowHeight(s, r)) m().setRowsHeight(s, r, r, need);
    }
  }

  function current(): CellStyle {
    const [r, c] = b.active();
    return m().getCellStyle(b.sheet(), r, c).style;
  }

  /** The current region around the active cell (what Ctrl+A and Sort pick in Excel). */
  function region(): Range {
    const [r1, c1, r2, c2] = b.selection();
    if (r1 !== r2 || c1 !== c2) return bounded();
    const s = b.sheet();
    const filled = (r: number, c: number) => r >= 1 && c >= 1 && !!m().getFormattedCellValue(s, r, c);
    let top = r1;
    let bottom = r1;
    let left = c1;
    let right = c1;
    let grew = true;
    while (grew) {
      grew = false;
      for (let c = left; c <= right; c++) {
        if (filled(top - 1, c)) (top--, (grew = true));
        if (filled(bottom + 1, c)) (bottom++, (grew = true));
      }
      for (let r = top; r <= bottom; r++) {
        if (filled(r, left - 1)) (left--, (grew = true));
        if (filled(r, right + 1)) (right++, (grew = true));
      }
      if (bottom - top > 100_000 || right - left > 2000) break;
    }
    return [top, left, bottom, right];
  }

  const ask = (title: string, label: string, value: string, run: (v: string) => void, extra?: string) => {
    const input = textInput({ value, "data-autofocus": "" });
    const ok = h("button", { class: "btn primary", type: "button", onclick: () => go() }, "OK");
    const d = openDialog({ title, subtitle: extra, body: [field(label, input)], foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel"), ok], submit: () => go(), onClose: () => b.focus() });
    requestAnimationFrame(() => input.select());
    function go() {
      run(input.value);
      d.close();
    }
  };

  const commands: SheetCommands = {
    current,
    style: (path, value) => styled(() => m().updateRangeStyle(area(), path, value)),
    toggle(path) {
      const s = current();
      const key = path.split(".")[1] as "b" | "i" | "u" | "strike";
      const on = !s.font[key];
      styled(() => m().updateRangeStyle(area(), path, String(on)));
    },
    fontName: (name) => restyle((s) => (s.font.name = name)),
    fontSize: (size) => (styled(() => m().updateRangeStyle(area(), "font.size", String(Math.round(size)))), growRows()),
    grow: (delta) => (styled(() => m().updateRangeStyle(area(), "font.size_delta", String(delta))), growRows()),
    fontColor: (color) => styled(() => m().updateRangeStyle(area(), "font.color", color ?? "")),
    fillColor: (color) => styled(() => m().updateRangeStyle(area(), "fill.color", color ?? "")),
    align: (horizontal) => styled(() => m().updateRangeStyle(area(), "alignment.horizontal", current().alignment?.horizontal === horizontal ? "general" : horizontal)),
    valign: (vertical) => styled(() => m().updateRangeStyle(area(), "alignment.vertical", vertical)),
    wrap: () => styled(() => m().updateRangeStyle(area(), "alignment.wrap_text", String(!current().alignment?.wrap_text))),
    borders(choice) {
      const item = { style: border.style, color: border.color };
      const apply = (type: BorderType, it = item) => m().setAreaWithBorder(area(), { item: it, type });
      styled(() => {
        if (choice === "ThickOuter") apply(BorderType.Outer, { ...item, style: BorderStyle.Thick });
        else if (choice === "DoubleBottom") apply(BorderType.Bottom, { ...item, style: BorderStyle.Double });
        else if (choice === "ThickBottom") apply(BorderType.Bottom, { ...item, style: BorderStyle.Thick });
        else apply(BorderType[choice]);
      });
    },
    borderLine: (style) => (border = { ...border, style }),
    borderLineStyle: () => border.style,
    borderColor: (color) => (border = { ...border, color: color ?? "#000000" }),
    merge(kind) {
      const a = area();
      b.run(() => {
        if (kind === "unmerge") m().unmergeCells(a);
        else if (kind === "center") m().mergeCellsCenter(a);
        else if (kind === "across") m().mergeCellsAcross(a);
        else m().mergeCells(a);
      }, "Couldn't merge");
    },
    numberFormat(kind) {
      const code = NUMBER_KINDS.some(([k]) => k === kind) ? formatFor(kind as NumberKind, currencySymbol, m().getFmtSettings()) : kind;
      styled(() => m().updateRangeStyle(area(), "num_fmt", code));
    },
    numberKind() {
      const code = current().num_fmt || "general";
      const fmt = m().getFmtSettings();
      for (const [kind, label] of NUMBER_KINDS) if (formatFor(kind, currencySymbol, fmt) === code) return label;
      if (/%/.test(code)) return "Percentage";
      if (/[dmy]{2,}/i.test(code) && !/[#0]/.test(code)) return "Date";
      if (/E\+/.test(code)) return "Scientific";
      if (/[৳$€£₹¥]/.test(code)) return "Currency";
      return code === "general" ? "General" : "Custom";
    },
    currency(symbol) {
      currencySymbol = symbol;
      commands.numberFormat("currency");
    },
    decimals: (delta) => styled(() => m().updateRangeStyle(area(), "num_fmt", shiftDecimals(current().num_fmt, delta))),
    thousands: () => styled(() => m().updateRangeStyle(area(), "num_fmt", "#,##0.00")),
    insert(what) {
      const [r1, c1, r2, c2] = b.selection();
      const s = b.sheet();
      const kind = what === "auto" ? (c1 === 1 && c2 === LAST_COLUMN ? "rows" : r1 === 1 && r2 === LAST_ROW ? "columns" : "ask") : what;
      if (kind === "ask") return choose("Insert", (k) => commands.insert(k));
      b.run(() => {
        if (kind === "rows") m().insertRows(s, r1, r2 - r1 + 1);
        else if (kind === "columns") m().insertColumns(s, c1, c2 - c1 + 1);
        else m().newSheet();
      }, "Couldn't insert");
    },
    remove(what) {
      const [r1, c1, r2, c2] = b.selection();
      const s = b.sheet();
      const kind = what === "auto" ? (c1 === 1 && c2 === LAST_COLUMN ? "rows" : r1 === 1 && r2 === LAST_ROW ? "columns" : "ask") : what;
      if (kind === "ask") return choose("Delete", (k) => commands.remove(k));
      b.run(() => {
        if (kind === "rows") m().deleteRows(s, r1, r2 - r1 + 1);
        else if (kind === "columns") m().deleteColumns(s, c1, c2 - c1 + 1);
        else m().deleteSheet(s);
      }, "Couldn't delete");
    },
    clear(kind) {
      const [r1, c1, r2, c2] = bounded();
      const s = b.sheet();
      b.run(() => {
        if (kind === "all") m().rangeClearAll(s, r1, c1, r2, c2);
        else if (kind === "formats") m().rangeClearFormatting(s, r1, c1, r2, c2);
        else m().rangeClearContents(s, r1, c1, r2, c2);
      });
    },
    fill(direction) {
      const [r1, c1, r2, c2] = bounded();
      const s = b.sheet();
      if (direction === "down" && r2 > r1) b.run(() => m().autoFillRows({ sheet: s, row: r1, column: c1, width: c2 - c1 + 1, height: 1 }, r2));
      else if (direction === "right" && c2 > c1) b.run(() => m().autoFillColumns({ sheet: s, row: r1, column: c1, width: 1, height: r2 - r1 + 1 }, c2));
    },
    autoSum(fn) {
      // Excel's guess: the numbers right above the cell, or else right to its left.
      const [row, col] = b.active();
      const s = b.sheet();
      const isNumber = (r: number, c: number) => r >= 1 && c >= 1 && m().getCellType(s, r, c) === CELL_NUMBER && !!m().getFormattedCellValue(s, r, c);
      let range: Range | null = null;
      let r = row - 1;
      while (r >= 1 && !m().getFormattedCellValue(s, r, col)) r--;
      if (isNumber(r, col)) {
        let top = r;
        while (isNumber(top - 1, col)) top--;
        range = [top, col, r, col];
      } else {
        let c = col - 1;
        while (c >= 1 && !m().getFormattedCellValue(s, row, c)) c--;
        if (isNumber(row, c)) {
          let left = c;
          while (isNumber(row, left - 1)) left--;
          range = [row, left, row, c];
        }
      }
      b.edit(`=${fn}(${range ? rangeName(range) : ""}${range ? ")" : ""}`);
    },
    region,
    sort(ascending) {
      const range = region();
      const [r1, c1, , c2] = range;
      const [, activeCol] = b.active();
      const key = Math.min(Math.max(activeCol, c1), c2);
      const s = b.sheet();
      // A first row of text over a column of numbers is a header row, as Excel guesses.
      const header = range[2] > r1 && m().getCellType(s, r1, key) !== CELL_NUMBER && m().getCellType(s, r1 + 1, key) === CELL_NUMBER;
      commands.sortRange(range, key, ascending, header);
    },
    sortRange(range, key, ascending, header) {
      const [r1, c1, r2, c2] = range;
      const s = b.sheet();
      const top = header ? r1 + 1 : r1;
      if (r2 <= top) return;
      type Moved = { text: string; style: CellStyle; link: ReturnType<Model["getCellLink"]> | null; is_spill: boolean };
      const rows: { cells: Moved[]; value: string; type: number; num: number }[] = [];
      for (let r = top; r <= r2; r++) {
        const cells: Moved[] = [];
        // The engine's clipboard cells (is_spill isn't in its type declarations, but it's required).
        for (let c = c1; c <= c2; c++) cells.push({ text: m().getCellContent(s, r, c), style: m().getCellStyle(s, r, c).style, link: m().getCellLink(s, r, c) ?? null, is_spill: false });
        const type = m().getCellType(s, r, key);
        const shown = m().getFormattedCellValue(s, r, key);
        const raw = m().getCellContent(s, r, key);
        rows.push({ cells, value: shown.toLowerCase(), type: shown ? type : 0, num: type === CELL_NUMBER ? Number(raw.startsWith("=") ? shown.replace(/[^0-9.\-eE]/g, "") : raw) : Number.NaN });
      }
      // Numbers before text, empty cells last (both ways), like Excel.
      rows.sort((a, z) => {
        if (!a.type || !z.type) return !a.type && !z.type ? 0 : !a.type ? 1 : -1;
        const an = a.type === CELL_NUMBER;
        const zn = z.type === CELL_NUMBER;
        let d = an && zn ? a.num - z.num : an ? -1 : zn ? 1 : a.value.localeCompare(z.value);
        if (!ascending) d = -d;
        return d;
      });
      const data = new Map<number, Map<number, Moved>>();
      rows.forEach((row, i) => data.set(top + i, new Map(row.cells.map((cell, j) => [c1 + j, cell]))));
      const v = m().getSelectedView();
      b.run(() => {
        m().setSelectedCell(top, c1);
        m().setSelectedRange(top, c1, r2, c2);
        m().pasteFromClipboard(s, [top, c1, r2, c2], data as never, false);
        m().setSelectedCell(v.row, v.column);
        m().setSelectedRange(...(v.range as Range));
      }, "Couldn't sort");
    },
    hide(what, hide) {
      const [r1, c1, r2, c2] = b.selection();
      const s = b.sheet();
      b.run(() => (what === "rows" ? m().setRowsHidden(s, r1, r2, hide) : m().setColumnsHidden(s, c1, c2, hide)));
    },
    size(what) {
      const [r1, c1, r2, c2] = b.selection();
      const s = b.sheet();
      const now = what === "rows" ? m().getRowHeight(s, r1) / 1.5625 : m().getColumnWidth(s, c1) / 9;
      ask(what === "rows" ? "Row Height" : "Column Width", what === "rows" ? "Row height (points)" : "Column width (characters)", String(Math.round(now * 100) / 100), (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return b.toast("Type a number.");
        b.run(() => (what === "rows" ? m().setRowsHeight(s, r1, r2, n * 1.5625) : m().setColumnsWidth(s, c1, c2, n * 9)));
      });
    },
    freeze(kind) {
      const s = b.sheet();
      const [row, col] = b.active();
      b.run(() => {
        const rows = kind === "panes" ? row - 1 : kind === "row" ? 1 : 0;
        const cols = kind === "panes" ? col - 1 : kind === "column" ? 1 : 0;
        m().setFrozenRowsCount(s, rows);
        m().setFrozenColumnsCount(s, cols);
      });
    },
    frozen: () => m().getFrozenRowsCount(b.sheet()) > 0 || m().getFrozenColumnsCount(b.sheet()) > 0,
    gridlines: () => m().getShowGridLines(b.sheet()),
    setGridlines: (on) => b.run(() => m().setShowGridLines(b.sheet(), on)),
    formatCells: (tab) => formatCellsDialog(b, commands, tab ?? "number", currencySymbol),
    insertFunction: (category) => insertFunctionDialog(b, category),
    insertNamed: (name) => b.edit(`=${name}(`),
    goTo() {
      ask("Go To", "Reference", rangeName(b.selection()), (v) => {
        const range = parseRange(v);
        if (range) b.goTo(range);
        else b.toast(`“${v}” isn't a cell or a range.`);
      }, "A cell (B12), a range (A1:D20), whole columns (C:C) or rows (4:9).");
    },
    find: (replace) => findDialog(b, replace),
    link() {
      const [row, col] = b.active();
      const s = b.sheet();
      const existing = m().getCellLink(s, row, col);
      const target = textInput({ value: existing && existing.type === "External" ? existing.target : "", placeholder: "https://… or Sheet1!A1", "data-autofocus": "" });
      const label = textInput({ value: m().getFormattedCellValue(s, row, col) });
      const ok = h("button", { class: "btn primary", type: "button", onclick: () => go() }, "OK");
      const d = openDialog({
        title: "Insert Link", icon: "link", tone: "work",
        body: [field("Address", target), field("Text to show", label)],
        foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel"), ok],
        submit: () => go(), onClose: () => b.focus(),
      });
      function go() {
        const t = target.value.trim();
        if (!t) return d.error("Type an address.");
        const internal = /^'?[^/:]+'?![A-Z]+\d+/i.test(t) && !/^[a-z]+:\/\//i.test(t);
        const external = internal ? null : safeLink(t);
        if (!internal && !external) return d.error("Links can be web addresses (https://…), email (mailto:…) or a cell (Sheet1!A1).");
        b.run(() => m().setCellLink(s, row, col, internal ? { type: "Internal", location: t } : { type: "External", target: external! }, label.value || null));
        d.close();
      }
    },
    followLink() {
      const [row, col] = b.active();
      const link = m().getCellLink(b.sheet(), row, col);
      if (!link) return;
      if (link.type === "External") {
        // Links come from the file, which may come from anyone: only web and mail addresses open.
        const url = safeLink(link.target);
        if (url) b.openExternally(url);
        else b.toast("This link isn't a web or email address, so it isn't opened.");
      }
      else {
        const ref = link.location.replace(/^.*!/, "");
        const range = parseRange(ref);
        if (range) b.goTo(range);
      }
    },
    names: (fromSelection) => namesDialog(b, !!fromSelection),
    repeat: () => lastStyle && b.run(lastStyle),
    cellStyles: () => {
      try {
        return m().getBuiltinNamedStyles().map((s) => s.name);
      } catch {
        return [];
      }
    },
    cellStyle: (name) => styled(() => m().onApplyNamedStyle(name)),
    conditional: (kind) => conditionalDialog(b, kind),
    clearConditional(scope) {
      const s = b.sheet();
      const list = m().getConditionalFormattingList(s);
      const sel = b.selection();
      const hits = list.filter((cf) => {
        if (scope === "sheet") return true;
        const r = parseRange(cf.range.split(" ")[0]);
        return !!r && !(r[2] < sel[0] || r[0] > sel[2] || r[3] < sel[1] || r[1] > sel[3]);
      });
      b.run(() => [...hits].sort((a, z) => z.index - a.index).forEach((cf) => m().deleteConditionalFormatting(s, cf.index)));
    },
    themes: () => getThemeList(),
    setTheme: (theme) => b.run(() => m().setTheme(theme)),
    calculate: () => b.run(() => m().evaluate()),
  };

  /** Insert or Delete when it isn't clear what: rows, columns or the sheet. */
  function choose(title: string, then: (k: "rows" | "columns" | "sheet") => void) {
    const pick = (k: "rows" | "columns" | "sheet") => () => (d.close(), then(k));
    const d = openDialog({
      title, class: "tt-confirm",
      body: [h("div", { class: "sh-choose" },
        h("button", { class: "btn", type: "button", "data-autofocus": "", onclick: pick("rows") }, `Entire Rows`),
        h("button", { class: "btn", type: "button", onclick: pick("columns") }, `Entire Columns`),
        h("button", { class: "btn", type: "button", onclick: pick("sheet") }, title === "Insert" ? "A New Sheet" : "This Sheet"))],
      foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel")],
      onClose: () => b.focus(),
    });
  }

  return commands;
}

// ---- dialogs

function footer(d: () => Dialog, ok: HTMLButtonElement): Node[] {
  return [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => d().close() }, "Cancel"), ok];
}

/** Format Cells (Ctrl+1): Number, Alignment, Font and Fill, as Excel's dialog has them. */
function formatCellsDialog(b: SheetBase, c: SheetCommands, start: "number" | "alignment" | "font" | "fill", currency: string) {
  const s = c.current();
  const tabs = ["number", "alignment", "font", "fill"] as const;
  let tab: (typeof tabs)[number] = start;
  const pending: (() => void)[] = [];
  const kinds = h("select", { "aria-label": "Category", size: 8, class: "sh-kinds" }, ...NUMBER_KINDS.map(([k, label]) => h("option", { value: k }, label)), h("option", { value: "custom" }, "Custom"));
  const code = textInput({ value: s.num_fmt || "general", "aria-label": "Format code" });
  const symbol = h("select", { "aria-label": "Currency symbol" }, ...CURRENCIES.map(([sym, label]) => h("option", { value: sym, selected: sym === currency }, label)));
  const sample = h("div", { class: "sh-sample" });
  const fmt = b.model().getFmtSettings();
  const updateCode = () => {
    const k = kinds.value as NumberKind | "custom";
    if (k !== "custom") code.value = formatFor(k as NumberKind, symbol.value, fmt);
    sample.textContent = `Format: ${code.value}`;
  };
  kinds.addEventListener("change", updateCode);
  symbol.addEventListener("change", updateCode);
  code.addEventListener("input", () => ((kinds.value = "custom"), updateCode()));
  kinds.value = NUMBER_KINDS.find(([k]) => formatFor(k, currency, fmt) === (s.num_fmt || "general"))?.[0] ?? "custom";
  updateCode();

  const sel = (label: string, options: [string, string][], value: string) => {
    const el = h("select", { "aria-label": label }, ...options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
    return el;
  };
  const hAlign = sel("Horizontal", [["general", "General"], ["left", "Left"], ["center", "Center"], ["right", "Right"], ["fill", "Fill"], ["justify", "Justify"], ["centerContinuous", "Center Across Selection"], ["distributed", "Distributed"]], s.alignment?.horizontal ?? "general");
  const vAlign = sel("Vertical", [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"], ["justify", "Justify"], ["distributed", "Distributed"]], s.alignment?.vertical ?? "bottom");
  const wrap = h("input", { type: "checkbox", checked: !!s.alignment?.wrap_text });
  const fontName = textInput({ value: s.font.name, "aria-label": "Font" });
  const fontSize = textInput({ value: String(s.font.sz), "aria-label": "Size", inputmode: "numeric" });
  const bold = h("input", { type: "checkbox", checked: s.font.b });
  const italic = h("input", { type: "checkbox", checked: s.font.i });
  const underline = h("input", { type: "checkbox", checked: s.font.u });
  const strike = h("input", { type: "checkbox", checked: s.font.strike });
  const fontColor = h("input", { type: "color", value: b.model().resolveColor(s.font.color) || "#000000" });
  const fillColor = h("input", { type: "color", value: b.model().resolveColor(s.fill.color) || "#ffffff" });
  const noFill = h("input", { type: "checkbox", checked: !b.model().resolveColor(s.fill.color) });
  const check = (box: HTMLInputElement, label: string) => h("label", { class: "sh-check" }, box, label);

  const panes: Record<(typeof tabs)[number], HTMLElement> = {
    number: h("div", { class: "sh-pane sh-number" }, kinds, h("div", { class: "sh-number-side" }, field("Symbol", symbol), field("Format code", code), sample)),
    alignment: h("div", { class: "sh-pane" }, h("div", { class: "tt-pair" }, field("Horizontal", hAlign), field("Vertical", vAlign)), check(wrap, "Wrap text")),
    font: h("div", { class: "sh-pane" }, h("div", { class: "tt-pair" }, field("Font", fontName), field("Size", fontSize)),
      h("div", { class: "sh-checks" }, check(bold, "Bold"), check(italic, "Italic"), check(underline, "Underline"), check(strike, "Strikethrough")),
      field("Colour", fontColor)),
    fill: h("div", { class: "sh-pane" }, check(noFill, "No fill"), field("Background colour", fillColor)),
  };
  fillColor.addEventListener("input", () => (noFill.checked = false));
  const tabBar = h("div", { class: "segmented sh-format-tabs" }, ...tabs.map((t) => h("button", { type: "button", onclick: () => show(t) }, t[0].toUpperCase() + t.slice(1))));
  const body = h("div", { class: "sh-format-body" });
  function show(t: (typeof tabs)[number]) {
    tab = t;
    tabBar.querySelectorAll("button").forEach((btn, i) => btn.classList.toggle("active", tabs[i] === t));
    body.replaceChildren(panes[t]);
  }
  show(tab);
  const ok = h("button", { class: "btn primary", type: "button", onclick: () => apply() }, "OK");
  const d = openDialog({ title: "Format Cells", icon: "table", tone: "work", class: "sh-format", body: [tabBar, body], foot: footer(() => d, ok), submit: () => apply(), onClose: () => b.focus() });
  function apply() {
    const before = c.current();
    if (code.value !== (before.num_fmt || "general")) pending.push(() => c.numberFormat(code.value));
    if (hAlign.value !== (before.alignment?.horizontal ?? "general")) pending.push(() => c.style("alignment.horizontal", hAlign.value));
    if (vAlign.value !== (before.alignment?.vertical ?? "bottom")) pending.push(() => c.valign(vAlign.value));
    if (wrap.checked !== !!before.alignment?.wrap_text) pending.push(() => c.style("alignment.wrap_text", String(wrap.checked)));
    if (fontName.value.trim() && fontName.value.trim() !== before.font.name) pending.push(() => c.fontName(fontName.value.trim()));
    const size = Number(fontSize.value);
    if (Number.isFinite(size) && size > 0 && size !== before.font.sz) pending.push(() => c.fontSize(size));
    for (const [box, path, was] of [[bold, "font.b", before.font.b], [italic, "font.i", before.font.i], [underline, "font.u", before.font.u], [strike, "font.strike", before.font.strike]] as const) {
      if (box.checked !== was) pending.push(() => c.style(path, String(box.checked)));
    }
    if (fontColor.value !== (b.model().resolveColor(before.font.color) || "#000000")) pending.push(() => c.fontColor(fontColor.value));
    const fillNow = b.model().resolveColor(before.fill.color);
    if (noFill.checked ? !!fillNow : fillColor.value !== fillNow) pending.push(() => c.fillColor(noFill.checked ? null : fillColor.value));
    d.close();
    pending.forEach((p) => p());
  }
}

/** Insert Function: search or browse by category, read what it does, insert it. */
function insertFunctionDialog(b: SheetBase, category?: string) {
  const search = textInput({ placeholder: "Search for a function", "data-autofocus": "" });
  const cats = h("select", { "aria-label": "Category" }, h("option", { value: "" }, "All"), ...Object.keys(FUNCTION_CATEGORIES).map((c) => h("option", { value: c, selected: c === category }, c)));
  const list = h("select", { size: 10, class: "sh-fn-list", "aria-label": "Functions" });
  const help = h("div", { class: "sh-fn-help" });
  const draw = () => {
    const q = search.value.trim().toUpperCase();
    const names = (cats.value ? FUNCTION_CATEGORIES[cats.value] : FUNCTION_NAMES).filter((n) => !q || n.includes(q) || (FUNCTION_HELP[n]?.text.toUpperCase().includes(q) ?? false));
    list.replaceChildren(...names.map((n, i) => h("option", { value: n, selected: i === 0 }, n)));
    describe();
  };
  const describe = () => {
    const n = list.value;
    const info = FUNCTION_HELP[n];
    help.replaceChildren(h("b", null, `${n}(${info?.args ?? "…"})`), h("p", null, info?.text ?? "See Excel's documentation of this function: it works the same here."));
  };
  search.addEventListener("input", draw);
  cats.addEventListener("change", draw);
  list.addEventListener("change", describe);
  list.addEventListener("dblclick", () => go());
  const ok = h("button", { class: "btn primary", type: "button", onclick: () => go() }, "Insert");
  const d = openDialog({ title: "Insert Function", icon: "symbol", tone: "work", class: "sh-fn", body: [h("div", { class: "tt-pair" }, field("Search", search), field("Category", cats)), list, help], foot: footer(() => d, ok), submit: () => go() });
  draw();
  function go() {
    if (!list.value) return;
    d.close();
    b.edit(`=${list.value}(`);
  }
}

/** Find (Ctrl+F) and Replace (Ctrl+H) across the sheet or the workbook. */
function findDialog(b: SheetBase, replacing: boolean) {
  const m = b.model();
  const what = textInput({ placeholder: "Find what", "data-autofocus": "" });
  const withText = textInput({ placeholder: "Replace with" });
  const matchCase = h("input", { type: "checkbox" });
  const whole = h("input", { type: "checkbox" });
  const everywhere = h("input", { type: "checkbox" });
  const result = h("p", { class: "tt-hint" });
  const matches = (text: string) => {
    const a = matchCase.checked ? text : text.toLowerCase();
    const q = matchCase.checked ? what.value : what.value.toLowerCase();
    return q && (whole.checked ? a === q : a.includes(q));
  };
  /** Every cell in reading order, starting after the active one. */
  function* cells(): Generator<[number, number, number]> {
    const sheets = everywhere.checked ? m.getWorksheetsProperties().map((_, i) => i) : [b.sheet()];
    for (const s of sheets) {
      const rows = new Map<number, number[]>();
      for (let c = 1; c <= 500; c++) for (const r of m.getRowsWithData(s, c)) (rows.get(r) ?? rows.set(r, []).get(r)!).push(c);
      for (const r of [...rows.keys()].sort((x, y) => x - y)) for (const c of rows.get(r)!) yield [s, r, c];
    }
  }
  const findNext = () => {
    const [ar, ac] = b.active();
    const all = [...cells()];
    const start = all.findIndex(([s, r, c]) => s === b.sheet() && (r > ar || (r === ar && c > ac)));
    const order = [...all.slice(Math.max(0, start)), ...all.slice(0, Math.max(0, start))];
    const hit = order.find(([s, r, c]) => matches(m.getFormattedCellValue(s, r, c)) || matches(m.getCellContent(s, r, c)));
    if (!hit) {
      result.textContent = "Nothing found.";
      return null;
    }
    if (hit[0] !== b.sheet()) m.setSelectedSheet(hit[0]);
    b.goTo([hit[1], hit[2], hit[1], hit[2]]);
    result.textContent = "";
    return hit;
  };
  const swap = (text: string) => {
    const flags = matchCase.checked ? "g" : "gi";
    return whole.checked ? withText.value : text.replace(new RegExp(what.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags), withText.value);
  };
  const replaceOne = () => {
    const [r, c] = b.active();
    const s = b.sheet();
    const content = m.getCellContent(s, r, c);
    if (matches(content)) b.run(() => m.setUserInput(s, r, c, swap(content)));
    findNext();
  };
  const replaceAll = () => {
    let n = 0;
    const hits = [...cells()].filter(([s, r, c]) => matches(m.getCellContent(s, r, c)));
    b.run(() => {
      for (const [s, r, c] of hits) {
        m.setUserInput(s, r, c, swap(m.getCellContent(s, r, c)));
        n++;
      }
    });
    result.textContent = `${n} replaced.`;
  };
  const d = openDialog({
    title: replacing ? "Find and Replace" : "Find", icon: "search", tone: "work",
    body: [field("Find what", what), replacing ? field("Replace with", withText) : null,
      h("div", { class: "sh-checks" }, h("label", { class: "sh-check" }, matchCase, "Match case"), h("label", { class: "sh-check" }, whole, "Match entire cell"), h("label", { class: "sh-check" }, everywhere, "Whole workbook")), result],
    foot: [
      replacing ? h("button", { class: "btn", type: "button", onclick: replaceAll }, "Replace All") : null,
      replacing ? h("button", { class: "btn", type: "button", onclick: replaceOne }, "Replace") : null,
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Close"),
      h("button", { class: "btn primary", type: "button", onclick: () => findNext() }, "Find Next"),
    ],
    submit: () => findNext(),
    onClose: () => b.focus(),
  });
}

/** Name Manager: the workbook's defined names; new ones refer to the selection. */
function namesDialog(b: SheetBase, fromSelection: boolean) {
  const m = b.model();
  const sheetName = m.getWorksheetsProperties()[b.sheet()].name;
  const quoted = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheetName) ? sheetName : `'${sheetName}'`;
  const here = `=${quoted}!${rangeName(b.selection()).replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}`;
  const list = h("div", { class: "sh-names" });
  const name = textInput({ placeholder: "Name", "data-autofocus": "" });
  const refers = textInput({ value: here });
  const draw = () => {
    const names = m.getDefinedNameList();
    list.replaceChildren(...(names.length ? names.map((n) => h("div", { class: "sh-name-row" },
      h("b", null, n.name), h("span", null, n.formula),
      h("button", { class: "icon-btn small", type: "button", title: "Delete", "aria-label": `Delete ${n.name}`, onclick: () => (b.run(() => m.deleteDefinedName(n.name, n.scope ?? null)), draw()) }, "×"))) : [h("p", { class: "tt-hint" }, "No names yet. A name stands for a cell or range in formulas (=SUM(Sales)).")]));
  };
  draw();
  const add = h("button", { class: "btn primary", type: "button", onclick: () => go() }, "Add Name");
  const d = openDialog({
    title: "Name Manager", icon: "tag", tone: "work",
    body: [list, h("div", { class: "tt-pair" }, field("Name", name), field("Refers to", refers))],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Close"), add],
    submit: () => go(), onClose: () => b.focus(),
  });
  if (!fromSelection) requestAnimationFrame(() => name.focus());
  function go() {
    const n = name.value.trim();
    if (!n) return d.error("Give the name.");
    try {
      m.isValidDefinedName(n, null, refers.value.trim());
      b.run(() => m.newDefinedName(n, null, refers.value.trim()));
      name.value = "";
      d.error("");
      draw();
    } catch (err) {
      d.error(String(err));
    }
  }
}

/** Conditional Formatting: Excel's quick rules with its preset looks. */
function conditionalDialog(b: SheetBase, kind: Parameters<SheetCommands["conditional"]>[0]) {
  const m = b.model();
  const s = b.sheet();
  const range = rangeName(normalized(b.selection()));
  const looks: [string, string, { font: { color: string }; fill: { color: string } }][] = [
    ["red", "Light red fill with dark red text", { font: { color: "#9c0006" }, fill: { color: "#ffc7ce" } }],
    ["yellow", "Yellow fill with dark yellow text", { font: { color: "#9c5700" }, fill: { color: "#ffeb9c" } }],
    ["green", "Green fill with dark green text", { font: { color: "#006100" }, fill: { color: "#c6efce" } }],
    ["redText", "Red text", { font: { color: "#ff0000" }, fill: { color: "" } }],
  ];
  const add = (rule: CfRuleInput) => b.run(() => m.addConditionalFormatting(s, range, rule), "Couldn't add the rule");
  const instant: Partial<Record<typeof kind, () => CfRuleInput>> = {
    databar: () => ({ type: "DataBar", min: null, max: null, positive_color: "#638ec6", negative_color: "#ff0000", is_gradient: true, show_value: true }),
    scale2: () => ({ type: "ColorScale", thresholds: [{ cfvo: "Min", color: "#ffffff" }, { cfvo: "Max", color: "#63be7b" }] }),
    scale3: () => ({ type: "ColorScale", thresholds: [{ cfvo: "Min", color: "#f8696b" }, { cfvo: { Percentile: 50 }, color: "#ffeb84" }, { cfvo: "Max", color: "#63be7b" }] }),
    icons: () => ({ type: "IconSet", show_value: true, thresholds: [
      { icon: "ArrowDown", cfvo: "Min", color: "#f8696b", is_strict: false },
      { icon: "ArrowRight", cfvo: { Percent: 33 }, color: "#ffc000", is_strict: false },
      { icon: "ArrowUp", cfvo: { Percent: 67 }, color: "#00b050", is_strict: false },
    ] }),
  };
  if (instant[kind]) return add(instant[kind]!());
  const titles: Record<string, string> = { greater: "Greater Than", less: "Less Than", between: "Between", equal: "Equal To", text: "Text that Contains", duplicates: "Duplicate Values", top10: "Top 10 Items", bottom10: "Bottom 10 Items", above: "Above Average", below: "Below Average" };
  const value1 = textInput({ "data-autofocus": "", placeholder: kind === "text" ? "Text" : "Value or =formula" });
  const value2 = textInput({ placeholder: "and" });
  const rank = textInput({ value: "10", inputmode: "numeric" });
  const look = h("select", { "aria-label": "Format with" }, ...looks.map(([id, label]) => h("option", { value: id }, label)));
  const needsValue = ["greater", "less", "between", "equal", "text"].includes(kind);
  const ok = h("button", { class: "btn primary", type: "button", onclick: () => go() }, "OK");
  const d = openDialog({
    title: titles[kind], subtitle: `Format the cells of ${range} that match.`, icon: "palette", tone: "work",
    body: [needsValue ? field(kind === "text" ? "Contains" : "Value", value1) : null, kind === "between" ? field("And", value2) : null, kind === "top10" || kind === "bottom10" ? field("How many", rank) : null, field("Format with", look)],
    foot: footer(() => d, ok), submit: () => go(), onClose: () => b.focus(),
  });
  function go() {
    const f = looks.find(([id]) => id === look.value)![2];
    const format = { font: { color: f.font.color }, ...(f.fill.color ? { fill: { color: f.fill.color } } : {}) };
    const formula = (v: string) => (v.trim().startsWith("=") ? v.trim().slice(1) : /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : `"${v.trim().replace(/"/g, '""')}"`);
    if (needsValue && !value1.value.trim()) return d.error("Type a value.");
    const rule: CfRuleInput =
      kind === "text" ? { type: "Text", operator: "Contains", value: value1.value.trim(), format, stop_if_true: false }
      : kind === "duplicates" ? { type: "DuplicateValues", format, stop_if_true: false }
      : kind === "top10" || kind === "bottom10" ? { type: kind === "top10" ? "Top10" : "Bottom10", rank: Number(rank.value) || 10, percent: false, format, stop_if_true: false }
      : kind === "above" || kind === "below" ? { type: kind === "above" ? "AboveAverage" : "BelowAverage", format, stop_if_true: false }
      : { type: "CellIs", operator: kind === "greater" ? "GreaterThan" : kind === "less" ? "LessThan" : kind === "between" ? "Between" : "Equal", formula: formula(value1.value), formula2: kind === "between" ? formula(value2.value) : null, format, stop_if_true: false };
    add(rule);
    d.close();
  }
}
