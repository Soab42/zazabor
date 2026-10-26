import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import { confirmDialog } from "../../time/dialog";
import { errorText } from "../../time/api";
import { extensionOf, officeApi, pickSavePath, stem } from "../api";
import type { EditorFactory, OfficeEditor } from "../editor";
import { Ribbon, titleBar } from "../ribbon";
import { EditBox } from "./editbox";
import { areaOf, blankModel, columnName, CELL_NUMBER, LAST_COLUMN, LAST_ROW, loadEngine, LOCALE, modelFromBytes, normalized, parseRange, rangeName, sheetPrefix, timezone, type Model } from "./engine";
import { Grid } from "./grid";
import { makeCommands, type SheetActions, type SheetBase } from "./commands";
import { AutoFilter } from "./filter";
import { printSheet } from "./print";
import { buildRibbon } from "./ribbon-tabs";
import { SheetTabs } from "./tabs";
import { buildTemplate } from "./templates";
import "./sheets.css";

type Range = [number, number, number, number];
type Direction = "up" | "down" | "left" | "right";

let untitled = 0;

/**
 * Sheets: an Excel-like spreadsheet on IronCalc. The title bar and ribbon on top, then the name
 * box and formula bar, the grid, the sheet tabs and the status bar, as in Excel. Opens and saves
 * .xlsx (and .csv/.tsv, one sheet).
 */
export const createSheetEditor: EditorFactory = async (host, file, template, recovered) => {
  await loadEngine();
  let path = recovered ? recovered.path : file?.path ?? null;
  let model: Model;
  if (recovered) model = modelFromBytes(recovered.bytes);
  else if (file) model = modelFromBytes(await officeApi.openWorkbook(file.path, LOCALE, timezone()));
  else model = template && template !== "blank" ? modelFromBytes(buildTemplate(template)) : blankModel("Book");
  let name = recovered ? recovered.name : file ? stem(file.path) : `${template && template !== "blank" ? templateName(template) : "Book"} ${++untitled}`;
  // A recovered workbook isn't saved anywhere yet.
  let dirty = !!recovered;
  /** Bumped by every change, for AutoRecover. */
  let version = 0;
  let zoom = 1;
  let showFormulas = false;
  let editing: null | { row: number; col: number; sheet: number; original: string } = null;
  /** What Copy or Cut put aside, for pasting with formulas and formats. */
  let clipboard: null | { sheet: number; range: Range; data: ReturnType<Model["copyToClipboard"]>["data"]; text: string; cut: boolean } = null;
  let visible = false;

  // ---- frame

  const title = titleBar({
    tone: "sheet",
    save: () => void save(),
    undo: () => run(() => model.undo()),
    redo: () => run(() => model.redo()),
    canUndo: () => model.canUndo(),
    canRedo: () => model.canRedo(),
  });
  const nameBox = h("input", { class: "sh-namebox", spellcheck: "false", "aria-label": "Name Box", title: "Name Box: type a cell or range and press Enter" });
  const cellBox = new EditBox(editHost("cell"), "sh-celledit");
  const barBox = new EditBox(editHost("bar"), "sh-formula");
  const cancelBtn = h("button", { class: "sh-fx-btn", type: "button", title: "Cancel (Esc)", "aria-label": "Cancel", onmousedown: (e: Event) => e.preventDefault(), onclick: () => cancelEdit() }, icon("close", 13));
  const enterBtn = h("button", { class: "sh-fx-btn", type: "button", title: "Enter", "aria-label": "Enter", onmousedown: (e: Event) => e.preventDefault(), onclick: () => commitEdit(barBox.value, "none") }, icon("check", 13));
  const fxBtn = h("button", { class: "sh-fx-btn fx", type: "button", title: "Insert Function (Shift+F3)", "aria-label": "Insert function", onmousedown: (e: Event) => e.preventDefault(), onclick: () => actions.insertFunction() }, h("span", { class: "rb-glyph italic" }, "fx"));
  const formulaBar = h("div", { class: "sh-formulabar" }, nameBox, h("span", { class: "sh-fx-sep" }), cancelBtn, enterBtn, fxBtn, barBox.el);

  const grid = new Grid({
    model: () => model,
    sheet: () => model.getSelectedSheet(),
    zoom: () => zoom,
    setZoom: (z) => setZoom(z),
    showFormulas: () => showFormulas,
    showGridlines: () => model.getShowGridLines(model.getSelectedSheet()),
    showHeadings: () => headings,
    selectionChanged: () => selectionChanged(),
    changed: () => markChanged(),
    edit: () => beginEdit(null, false),
    picking: () => !!editing && activeBox().wantsReference(),
    pick: (range, done) => pickReference(range, done),
    menu: (x, y, at) => openMenu(x, y, cellMenu(at)),
    focus: () => {
      // A click elsewhere on the grid ends an edit (formulas pick references instead, see `picking`).
      if (editing) commitEdit(activeBox().value, "none");
      tabStart = null;
      cellBox.focus();
    },
    selected: () => paintFormats(),
    filter: () => autoFilter.buttons(),
    filterClick: (col, box) => autoFilter.open(col, box),
    highlights: () => highlights(),
    copied: () => (clipboard && clipboard.sheet === model.getSelectedSheet() ? clipboard.range : null),
  });
  let headings = true;
  cellBox.el.classList.add("idle");
  grid.el.append(cellBox.el);

  const tabs = new SheetTabs({
    model: () => model,
    sheet: () => model.getSelectedSheet(),
    select: (i) => selectSheet(i),
    changed: () => (markChanged(), tabs.draw(), grid.invalidate(true)),
    toast: host.toast,
    confirm: (t, text, yes) => confirmDialog({ title: t, text, confirm: yes, danger: true, icon: "trash", tone: "idle" }),
  });
  const mode = h("span", { class: "sh-mode" }, "Ready");
  const stats = h("span", { class: "sh-stats" });
  const zoomValue = h("span", { class: "of-zoom-value" }, "100%");
  const zoomSlider = h("input", { type: "range", min: "10", max: "400", step: "5", value: "100", "aria-label": "Zoom" });
  zoomSlider.addEventListener("input", () => setZoom(Number(zoomSlider.value) / 100));
  const status = h("div", { class: "of-status" }, mode, h("span", { class: "spacer" }), stats,
    h("div", { class: "of-zoom" },
      h("button", { type: "button", title: "Zoom out", onclick: () => setZoom(Math.max(0.1, Math.round((zoom - 0.1) * 10) / 10)) }, "−"),
      zoomSlider,
      h("button", { type: "button", title: "Zoom in", onclick: () => setZoom(Math.min(4, Math.round((zoom + 0.1) * 10) / 10)) }, "+"),
      zoomValue));
  const bottom = h("div", { class: "sh-bottom" }, tabs.el);
  const el = h("div", { class: "of-editor sheets tone-sheet" });

  const base = makeBase();
  const actions: SheetActions = { ...base, ...makeCommands(base), toggleFilter() {}, filterOn: () => false, clearFilter() {} };
  const autoFilter = new AutoFilter({
    model: () => model,
    sheet,
    run: (change) => run(change),
    sortBy: (range, col, asc) => actions.sortRange(range, col, asc, true),
    focus: () => cellBox.focus(),
  });
  actions.toggleFilter = () => autoFilter.toggle(actions.region());
  actions.filterOn = () => autoFilter.on;
  actions.clearFilter = () => autoFilter.clear();
  const ribbon: Ribbon = buildRibbon(actions, () => host.showHub());
  el.append(title.el, ribbon.el, formulaBar, grid.el, bottom, status);

  // ---- state helpers

  function sheet() {
    return model.getSelectedSheet();
  }

  function view() {
    return model.getSelectedView();
  }

  function selection(): Range {
    return normalized(view().range as Range);
  }

  function activeBox() {
    return document.activeElement === barBox.el ? barBox : cellBox;
  }

  function markChanged() {
    version++;
    if (!dirty) {
      dirty = true;
      host.changed();
    }
    title.set(name, dirty, path);
  }

  /** A change to the workbook: everything that shows it is redrawn. */
  function run(change: () => void, message?: string) {
    try {
      change();
    } catch (err) {
      host.toast(message ? `${message}: ${errorText(err)}` : errorText(err));
      return;
    }
    markChanged();
    grid.invalidate(true);
    tabs.draw();
    selectionChanged();
  }

  function selectSheet(i: number) {
    if (editing) commitEdit(activeBox().value, "none");
    model.setSelectedSheet(i);
    grid.tellWindow();
    grid.invalidate(true);
    tabs.draw();
    selectionChanged();
  }

  function setZoom(z: number) {
    zoom = Math.max(0.1, Math.min(4, z));
    zoomSlider.value = String(Math.round(zoom * 100));
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    grid.tellWindow();
    grid.invalidate(true);
    placeEditor();
  }

  // ---- the selection

  function selectionChanged() {
    const v = view();
    const range = selection();
    if (document.activeElement !== nameBox) nameBox.value = rangeName(range[0] === range[2] && range[1] === range[3] ? [v.row, v.column, v.row, v.column] : range);
    if (!editing) barBox.value = model.getCellContent(sheet(), v.row, v.column);
    ribbon.refresh();
    title.refresh();
    placeEditor();
    updateStats(range);
  }

  /** Average, Count and Sum of the selection, as Excel's status bar shows them. */
  function updateStats(range: Range) {
    const [r1, c1, r2, c2] = range;
    if (r1 === r2 && c1 === c2) {
      stats.textContent = "";
      return;
    }
    const s = sheet();
    let count = 0;
    let numbers = 0;
    let sum = 0;
    let seen = 0;
    const lastCol = Math.min(c2, c1 + 200);
    for (let c = c1; c <= lastCol; c++) {
      for (const r of model.getRowsWithData(s, c)) {
        if (r < r1 || r > r2) continue;
        if (++seen > 100_000) break;
        const text = model.getFormattedCellValue(s, r, c);
        if (!text) continue;
        count++;
        if (model.getCellType(s, r, c) === CELL_NUMBER) {
          const value = Number(model.getCellContent(s, r, c).replace(/^=.*/, "")) || Number.parseFloat(text.replace(/[^0-9.\-eE]/g, ""));
          if (Number.isFinite(value)) {
            numbers++;
            sum += value;
          }
        }
      }
    }
    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
    stats.textContent = count ? (numbers ? `Average: ${fmt(sum / numbers)}    Count: ${count}    Sum: ${fmt(sum)}` : `Count: ${count}`) : "";
  }

  // ---- editing

  function editHost(where: "cell" | "bar") {
    return {
      commit: (text: string, move: Direction | "none", fill: boolean) => commitEdit(text, move, fill),
      cancel: () => cancelEdit(),
      changed: (text: string) => {
        if (!editing) beginEdit(null, where === "bar", true);
        (where === "cell" ? barBox : cellBox).value = text;
        mode.textContent = activeBox().wantsReference() ? "Point" : activeBox().enterMode ? "Enter" : "Edit";
        sizeEditor();
        grid.invalidate(false);
      },
      completion: (text: string, cursor: number) => {
        try {
          const v = view();
          const ctx = model.getFormulaCompletion(sheet(), v.row, v.column, text, cursor);
          const name = ctx.expecting.find((e): e is { FunctionName: string } => typeof e === "object" && "FunctionName" in e);
          return name ? { from: ctx.replace_from, prefix: name.FunctionName } : null;
        } catch {
          return null;
        }
      },
      point: (dir: Direction, extend: boolean) => pointWithArrow(dir, extend),
    };
  }

  /**
   * Starts editing the active cell: with `text` typed over it (Enter mode), or its content with
   * the caret at the end (F2, a double click: Edit mode). `already`: the text box has the text.
   */
  function beginEdit(text: string | null, inBar: boolean, already = false) {
    const v = view();
    if (!editing) editing = { row: v.row, col: v.column, sheet: sheet(), original: model.getCellContent(sheet(), v.row, v.column) };
    const content = text ?? editing.original;
    if (!already) {
      cellBox.value = content;
      barBox.value = content;
    }
    cellBox.enterMode = text != null || already;
    barBox.enterMode = false;
    cellBox.el.classList.remove("idle");
    mode.textContent = cellBox.enterMode ? "Enter" : "Edit";
    const look = grid.cellLook(v.row, v.column);
    Object.assign(cellBox.el.style, { font: look.font, color: look.color, background: look.background, textAlign: look.align === "right" ? "right" : look.align === "center" ? "center" : "left" });
    placeEditor();
    if (!already) (inBar ? barBox : cellBox).focus("end");
    grid.invalidate(false);
  }

  /**
   * Where Tab started on this row: Enter after a run of Tabs goes back to that column on the next
   * row, as in Excel, so a table can be typed row by row.
   */
  let tabStart: number | null = null;

  function advance(move: Direction | "none", row: number, col: number) {
    if (move === "right") tabStart ??= col;
    if ((move === "down") && tabStart != null) {
      model.setSelectedCell(Math.min(LAST_ROW, row + 1), tabStart);
      tabStart = null;
      return;
    }
    if (move !== "right" && move !== "left") tabStart = null;
    if (move !== "none") arrow(move);
  }

  function commitEdit(text: string, move: Direction | "none", fill = false) {
    if (!editing) return;
    const e = editing;
    editing = null;
    finishEditUi();
    if (text !== e.original || fill) {
      const s = e.sheet;
      run(() => {
        if (fill) {
          // Ctrl+Enter: the same entry in every selected cell.
          const [r1, c1, r2, c2] = selection();
          for (let r = r1; r <= Math.min(r2, r1 + 5000); r++) for (let c = c1; c <= Math.min(c2, c1 + 500); c++) model.setUserInput(s, r, c, text);
        } else model.setUserInput(s, e.row, e.col, text);
      }, "That entry didn't go in");
    }
    advance(move, e.row, e.col);
    reveal();
    grid.invalidate(false);
    selectionChanged();
  }

  function cancelEdit() {
    if (!editing) return;
    editing = null;
    finishEditUi();
    selectionChanged();
  }

  function finishEditUi() {
    cellBox.value = "";
    cellBox.el.classList.add("idle");
    cellBox.el.removeAttribute("style");
    cellBox.endPointing();
    barBox.endPointing();
    mode.textContent = "Ready";
    placeEditor();
    if (visible) cellBox.focus();
    grid.invalidate(false);
  }

  /** The in-cell editor sits over the active cell (also while idle: it takes the typing). */
  function placeEditor() {
    const v = editing ?? { row: view().row, col: view().column };
    const box = grid.cellBox(v.row, v.col);
    const base = grid.el.getBoundingClientRect();
    if (!box) {
      cellBox.el.style.left = "-9999px";
      return;
    }
    cellBox.el.style.left = `${box.left - base.left}px`;
    cellBox.el.style.top = `${box.top - base.top}px`;
    cellBox.el.style.minWidth = `${box.width}px`;
    cellBox.el.style.minHeight = `${box.height}px`;
    cellBox.el.style.width = `${box.width}px`;
    cellBox.el.style.height = `${box.height}px`;
    if (editing) sizeEditor();
  }

  /** While typing, the editor widens to fit its text, as Excel's does. */
  function sizeEditor() {
    const ta = cellBox.el;
    if (ta.classList.contains("idle")) return;
    ta.style.width = "0px";
    ta.style.width = `${Math.max(parseFloat(ta.style.minWidth) || 0, Math.min(ta.scrollWidth + 8, 900))}px`;
    ta.style.height = "0px";
    ta.style.height = `${Math.max(parseFloat(ta.style.minHeight) || 0, ta.scrollHeight)}px`;
  }

  /** The formula's references, outlined on the grid in their colours. */
  function highlights() {
    if (!editing) return [];
    const box = activeBox();
    const here = model.getWorksheetsProperties()[sheet()]?.name;
    return box.references().filter((r) => r.range && (!r.sheet || r.sheet === here)).map((r) => ({ range: normalized(r.range!), color: r.color }));
  }

  function referenceText(range: Range): string {
    const s = model.getWorksheetsProperties()[sheet()].name;
    const prefix = editing && editing.sheet !== sheet() ? sheetPrefix(s) : "";
    return prefix + rangeName(range);
  }

  /** A click or drag on the grid while a formula is typed: that range goes into the formula. */
  function pickReference(range: Range, done: boolean) {
    activeBox().insertReference(referenceText(range));
    (activeBox() === cellBox ? barBox : cellBox).value = activeBox().value;
    sizeEditor();
    grid.invalidate(false);
    if (done) activeBox().focus("end");
  }

  /** Point mode: arrows walk a reference cell from the cell being edited. */
  let pointAt: [number, number] | null = null;
  function pointWithArrow(dir: Direction, extend: boolean) {
    if (!editing) return;
    const [r, c] = pointAt ?? [editing.row, editing.col];
    const next: [number, number] = [Math.max(1, Math.min(LAST_ROW, r + (dir === "down" ? 1 : dir === "up" ? -1 : 0))), Math.max(1, Math.min(LAST_COLUMN, c + (dir === "right" ? 1 : dir === "left" ? -1 : 0)))];
    pointAt = next;
    const range: Range = extend ? normalized([editing.row, editing.col, next[0], next[1]]) : [next[0], next[1], next[0], next[1]];
    activeBox().insertReference(referenceText(range));
    (activeBox() === cellBox ? barBox : cellBox).value = activeBox().value;
    grid.invalidate(false);
  }
  cellBox.el.addEventListener("input", () => (pointAt = null));

  // ---- keys

  function arrow(dir: Direction) {
    if (dir === "down") model.onArrowDown();
    else if (dir === "up") model.onArrowUp();
    else if (dir === "left") model.onArrowLeft();
    else model.onArrowRight();
  }

  function toEdge(dir: Direction) {
    const names = { up: ["ArrowUp", "Up"], down: ["ArrowDown", "Down"], left: ["ArrowLeft", "Left"], right: ["ArrowRight", "Right"] }[dir];
    for (const n of names) {
      try {
        model.onNavigateToEdgeInDirection(n);
        return;
      } catch {
        // The other spelling.
      }
    }
  }

  /** The active cell, scrolled into view (the engine's own scrolling only estimates). */
  function reveal() {
    const v = view();
    grid.reveal(v.row, v.column);
  }

  /** Keys while the grid has the keyboard and no cell is being edited. */
  function gridKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    const v = view();
    const s = sheet();
    const dirs: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    if (dirs[key]) {
      tabStart = null;
      if (mod && e.shiftKey) {
        const before = view();
        toEdge(dirs[key]);
        const after = view();
        model.setSelectedCell(before.row, before.column);
        model.setSelectedRange(before.row, before.column, after.row, after.column);
      } else if (mod) toEdge(dirs[key]);
      else if (e.shiftKey) model.onExpandSelectedRange(key);
      else arrow(dirs[key]);
    } else if (key === "Enter" || key === "Tab") {
      const back = e.shiftKey;
      advance(key === "Enter" ? (back ? "up" : "down") : back ? "left" : "right", v.row, v.column);
    } else if (key === "PageDown" && !mod) model.onPageDown();
    else if (key === "PageUp" && !mod) model.onPageUp();
    else if ((key === "PageDown" || key === "PageUp") && mod) {
      const sheets = model.getWorksheetsProperties();
      let i = s;
      do i = (i + (key === "PageDown" ? 1 : -1) + sheets.length) % sheets.length;
      while (sheets[i].state !== "visible" && i !== s);
      selectSheet(i);
      return true;
    } else if (key === "Home") {
      model.setSelectedCell(mod ? 1 : v.row, 1);
      if (mod) model.setTopLeftVisibleCell(1, 1);
    } else if (key === "End" && mod) goTo(lastCell());
    else if (key === "F2") beginEdit(null, false);
    else if (key === "Delete") actions.clear("contents");
    else if (key === "Backspace") {
      run(() => model.rangeClearContents(s, v.row, v.column, v.row, v.column));
      beginEdit("", false);
    } else if (key === "Escape") {
      clipboard = null;
      grid.invalidate(false);
    } else if (key === "F4" && !mod) actions.repeat();
    else if (key === "F11" && e.shiftKey) tabs.add();
    else if (key === "F3" && e.shiftKey) actions.insertFunction();
    else if (key === "F5" || (mod && lower === "g")) actions.goTo();
    else if (mod && lower === "a") model.setSelectedRange(1, 1, LAST_ROW, LAST_COLUMN);
    else if (mod && key === " ") model.setSelectedRange(1, v.column, LAST_ROW, v.column);
    else if (e.shiftKey && key === " ") model.setSelectedRange(v.row, 1, v.row, LAST_COLUMN);
    else if (mod && lower === "z") run(() => model.undo());
    else if (mod && lower === "y") run(() => model.redo());
    else if (mod && lower === "s") void save(e.shiftKey);
    else if (mod && lower === "p") print();
    else if (mod && lower === "b") actions.toggle("font.b");
    else if (mod && lower === "i") actions.toggle("font.i");
    else if (mod && lower === "u") actions.toggle("font.u");
    else if (mod && key === "5") actions.toggle("font.strike");
    else if (mod && key === "1") actions.formatCells();
    else if (mod && lower === "d") actions.fill("down");
    else if (mod && lower === "r") actions.fill("right");
    else if (mod && lower === "f") actions.find(false);
    else if (mod && lower === "h") actions.find(true);
    else if (mod && lower === "k") actions.link();
    else if (mod && key === ";") beginEdit(new Date().toLocaleDateString("en-GB"), false);
    else if (mod && key === ":") beginEdit(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }), false);
    else if (mod && (key === "+" || key === "=") && e.shiftKey) actions.insert("auto");
    else if (mod && key === "-") actions.remove("auto");
    else if (e.altKey && key === "=") actions.autoSum("SUM");
    else if (mod && key === "9") actions.hide("rows", true);
    else if (mod && key === "0") actions.hide("columns", true);
    else if (mod && key === "`") actions.setShowFormulas(!showFormulas);
    else if (mod && e.shiftKey && lower === "l") actions.toggleFilter();
    else if (mod && e.shiftKey && lower === "$") actions.numberFormat("currency");
    else if (mod && e.shiftKey && key === "%") actions.numberFormat("percent");
    else if (mod && e.shiftKey && key === "!") actions.numberFormat("number");
    else if (mod && (lower === "c" || lower === "x" || lower === "v")) return false; // the clipboard events do these
    else if (ribbon.handleKey(e)) return true;
    else return false;
    if (dirs[key] || ["Enter", "Tab", "PageDown", "PageUp", "Home", "End"].includes(key)) reveal();
    grid.invalidate(false);
    selectionChanged();
    return true;
  }

  /** The last cell with something in it (Ctrl+End). */
  function lastCell(): Range {
    const s = sheet();
    let row = 1;
    let col = 1;
    for (let c = 1; c <= 200; c++) {
      const rows = model.getRowsWithData(s, c);
      if (rows.length) {
        row = Math.max(row, rows[rows.length - 1]);
        col = c;
      }
    }
    return [row, col, row, col];
  }

  function goTo(range: Range) {
    const [r1, c1, r2, c2] = range;
    model.setSelectedCell(r1, c1);
    if (r2 !== r1 || c2 !== c1) model.setSelectedRange(r1, c1, r2, c2);
    const v = view();
    if (r1 < v.top_row || r1 > v.top_row + 25 || c1 < v.left_column || c1 > v.left_column + 10) model.setTopLeftVisibleCell(Math.max(1, r1 - 3), Math.max(1, c1 - 1));
    reveal();
    grid.invalidate(false);
    selectionChanged();
  }

  // The idle cell editor takes every key: typed characters start editing; the rest navigates.
  grid.el.addEventListener("keydown", (e) => {
    if (e.target !== cellBox.el || editing) return;
    if (e.isComposing) return;
    if (gridKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    } else if (e.ctrlKey || e.metaKey || e.altKey || e.key.startsWith("F") && e.key.length > 1) {
      // Not ours, but never the shell's either while a sheet has the keyboard (Ctrl+1…9, Ctrl+L).
      if (!["c", "x", "v", "n", "w", "o"].includes(e.key.toLowerCase())) e.stopPropagation();
    }
  }, true);
  cellBox.el.addEventListener("compositionstart", () => {
    if (!editing) beginEdit("", false, true);
  });
  nameBox.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const text = nameBox.value.trim();
      const range = parseRange(text) ?? definedName(text);
      if (range) goTo(range);
      else host.toast(`“${text}” isn't a cell, a range or a name.`);
      cellBox.focus();
    } else if (e.key === "Escape") {
      selectionChanged();
      cellBox.focus();
    }
  });
  nameBox.addEventListener("focus", () => nameBox.select());
  barBox.el.addEventListener("focus", () => {
    if (!editing) beginEdit(null, true);
    barBox.enterMode = false;
    mode.textContent = "Edit";
  });

  function definedName(text: string): Range | null {
    const found = model.getDefinedNameList().find((d) => d.name.toLowerCase() === text.toLowerCase());
    if (!found) return null;
    const ref = found.formula.replace(/^=/, "").replace(/^.*!/, "");
    return parseRange(ref);
  }

  // ---- Format Painter: the selection's formats, painted over the next range picked (tiled)

  let painter: ReturnType<Model["getCellStyle"]>["style"][][] | null = null;

  function pickFormats() {
    const [r1, c1, r2, c2] = selection();
    const rows = Math.min(r2 - r1 + 1, 200);
    const cols = Math.min(c2 - c1 + 1, 50);
    painter = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => structuredClone(model.getCellStyle(sheet(), r1 + i, c1 + j).style)));
    el.classList.add("painting");
    host.toast("Select the cells to paint the formats on");
  }

  function paintFormats() {
    if (!painter) return;
    const styles = painter;
    painter = null;
    el.classList.remove("painting");
    const [r1, c1, r2, c2] = selection();
    const rows = Math.max(r2 - r1 + 1, styles.length);
    const cols = Math.max(c2 - c1 + 1, styles[0].length);
    const tiled = Array.from({ length: Math.min(rows, 2000) }, (_, i) => Array.from({ length: Math.min(cols, 200) }, (_, j) => styles[i % styles.length][j % styles[0].length]));
    run(() => {
      model.setSelectedRange(r1, c1, r1 + tiled.length - 1, c1 + tiled[0].length - 1);
      model.onPasteStyles(tiled);
    });
  }

  // ---- clipboard (the system's, so copying between Sheets, Docs and other apps works)

  function copy(e: ClipboardEvent, cut: boolean) {
    if (editing) return;
    e.preventDefault();
    const range = selection();
    const data = model.copyToClipboard();
    clipboard = { sheet: sheet(), range, data: data.data, text: data.csv, cut };
    e.clipboardData?.setData("text/plain", data.csv);
    e.clipboardData?.setData("text/html", tableHtml(data.csv));
    grid.invalidate(false);
  }

  function paste(text: string | null) {
    if (editing) return;
    const range = selection();
    if (clipboard && (text == null || text === clipboard.text)) {
      const c = clipboard;
      run(() => model.pasteFromClipboard(c.sheet, c.range, c.data, c.cut), "Couldn't paste");
      if (c.cut) clipboard = null;
    } else if (text != null) {
      run(() => model.pasteCsvText(areaOf(sheet(), range), text), "Couldn't paste");
    }
  }

  // WebKit only copies from a field with something selected: give it a character to select.
  grid.el.addEventListener("keydown", (e) => {
    if (e.target !== cellBox.el || editing || !(e.ctrlKey || e.metaKey) || !["c", "x"].includes(e.key.toLowerCase())) return;
    cellBox.el.value = " ";
    cellBox.el.select();
    setTimeout(() => (cellBox.el.value = ""), 0);
  }, true);
  cellBox.el.addEventListener("copy", (e) => copy(e, false));
  cellBox.el.addEventListener("cut", (e) => copy(e, true));
  cellBox.el.addEventListener("paste", (e) => {
    if (editing) return;
    e.preventDefault();
    paste(e.clipboardData?.getData("text/plain") ?? null);
  });

  /** Tab-separated text as an HTML table, so a paste into Docs or a web page keeps the cells. */
  function tableHtml(tsv: string): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const rows = tsv.replace(/\r?\n$/, "").split(/\r?\n/).map((line) => `<tr>${line.split("\t").map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`);
    return `<table>${rows.join("")}</table>`;
  }

  // ---- menus

  function cellMenu(at: "cell" | "rows" | "columns"): MenuItem[] {
    const items: MenuItem[] = [
      { label: "Cut", icon: "cut", shortcut: "Ctrl+X", action: () => clipboardCommand("cut") },
      { label: "Copy", icon: "copy", shortcut: "Ctrl+C", action: () => clipboardCommand("copy") },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", action: () => void actions.paste("all") },
      { label: "Paste Values", icon: "paste", action: () => void actions.paste("values") },
      "separator",
    ];
    if (at === "rows") {
      items.push(
        { label: "Insert Rows", icon: "rowInsert", action: () => actions.insert("rows") },
        { label: "Delete Rows", icon: "rowDelete", action: () => actions.remove("rows") },
        { label: "Row Height…", icon: "rowHeight", action: () => actions.size("rows") },
        { label: "Hide", icon: "eyeOff", action: () => actions.hide("rows", true) },
        { label: "Unhide", icon: "eye", action: () => actions.hide("rows", false) });
    } else if (at === "columns") {
      items.push(
        { label: "Insert Columns", icon: "colInsert", action: () => actions.insert("columns") },
        { label: "Delete Columns", icon: "colDelete", action: () => actions.remove("columns") },
        { label: "Column Width…", icon: "colWidth", action: () => actions.size("columns") },
        { label: "Hide", icon: "eyeOff", action: () => actions.hide("columns", true) },
        { label: "Unhide", icon: "eye", action: () => actions.hide("columns", false) });
    } else {
      items.push(
        { label: "Insert…", icon: "rowInsert", action: () => actions.insert("ask") },
        { label: "Delete…", icon: "rowDelete", action: () => actions.remove("ask") },
        { label: "Clear Contents", icon: "eraser", shortcut: "Delete", action: () => actions.clear("contents") },
        "separator",
        { label: "Sort A to Z", icon: "sortAsc", action: () => actions.sort(true) },
        { label: "Sort Z to A", icon: "sortDesc", action: () => actions.sort(false) },
        "separator",
        { label: "Format Cells…", icon: "table", shortcut: "Ctrl+1", action: () => actions.formatCells() },
        { label: "Link…", icon: "link", shortcut: "Ctrl+K", action: () => actions.link() },
        { label: "Define Name…", icon: "tag", action: () => actions.names(true) });
      const v = view();
      const link = model.getCellLink(sheet(), v.row, v.column);
      if (link) items.push({ label: "Open Link", icon: "external", action: () => actions.followLink() }, { label: "Remove Link", icon: "close", action: () => run(() => model.deleteCellLink(sheet(), v.row, v.column)) });
    }
    return items;
  }

  // ---- saving

  async function save(as = false): Promise<boolean> {
    if (editing) commitEdit(activeBox().value, "none");
    let target = path;
    const ext = target ? extensionOf(target) : "";
    if (as || !target) {
      const suggested = `${name}.${ext === "csv" || ext === "tsv" ? ext : "xlsx"}`;
      target = await pickSavePath(suggested, [{ name: "Excel Workbook", extension: "xlsx" }, { name: "CSV (comma separated)", extension: "csv" }, { name: "Text (tab separated)", extension: "tsv" }]);
      if (!target) return false;
    }
    const toText = ["csv", "tsv"].includes(extensionOf(target));
    if (toText && model.getWorksheetsProperties().length > 1) {
      const ok = await confirmDialog({ title: "Save only this sheet?", text: `${extensionOf(target).toUpperCase()} keeps one sheet and no formatting. The other sheets aren't saved in it.`, confirm: "Save This Sheet", icon: "sheetFile", tone: "work" });
      if (!ok) return false;
    }
    try {
      await (toText
        ? invokeSaveText(target)
        : officeApi.saveWorkbook(target, model.toBytes()));
    } catch (err) {
      host.toast(errorText(err));
      return false;
    }
    path = target;
    name = stem(target);
    dirty = false;
    title.set(name, false, path);
    host.remember(target);
    host.changed();
    host.toast(`Saved ${name}.${extensionOf(target)}`);
    return true;
  }

  function print() {
    if (editing) commitEdit(activeBox().value, "none");
    printSheet(model, sheet(), printGridlines, host.toast);
  }
  let printGridlines = false;

  /** Copy or Cut from a button or a menu: the same as the keys. */
  function clipboardCommand(command: "copy" | "cut") {
    cellBox.focus();
    cellBox.el.value = " ";
    cellBox.el.select();
    document.execCommand(command);
    cellBox.el.value = "";
  }

  function invokeSaveText(target: string) {
    return import("@tauri-apps/api/core").then(({ invoke }) => invoke<number>("sheet_save", model.toBytes(), { headers: { "x-path": encodeURIComponent(target).replace(/%2F/g, "/"), "x-sheet": String(sheet()) } }));
  }

  // ---- actions for the ribbon and menus

  function makeBase(): SheetBase {
    return {
      model: () => model,
      sheet,
      selection,
      active: () => [view().row, view().column],
      run,
      toast: host.toast,
      edit: (text) => beginEdit(text, false),
      goTo,
      paste: async (what) => {
        if (what === "values" && clipboard) {
          const text = clipboard.text;
          run(() => model.pasteCsvText(areaOf(sheet(), selection()), text));
          return;
        }
        let text: string | null = null;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          // No access to the system clipboard from a button: what Copy put aside.
        }
        paste(text);
      },
      copy: () => clipboardCommand("copy"),
      cut: () => clipboardCommand("cut"),
      painter: () => pickFormats(),
      print: () => print(),
      printGridlines: () => printGridlines,
      setPrintGridlines: (on: boolean) => ((printGridlines = on), ribbon.refresh()),
      showFormulas: () => showFormulas,
      setShowFormulas: (on) => {
        showFormulas = on;
        grid.invalidate(true);
        ribbon.refresh();
      },
      headings: () => headings,
      setHeadings: (on) => {
        headings = on;
        grid.tellWindow();
        grid.invalidate(false);
        ribbon.refresh();
      },
      formulaBar: () => !formulaBar.hidden,
      setFormulaBar: (on) => {
        formulaBar.hidden = !on;
        ribbon.refresh();
      },
      zoom: () => zoom,
      setZoom,
      autofit: (what) => {
        const [r1, c1, r2, c2] = selection();
        if (what === "columns") for (let c = c1; c <= Math.min(c2, c1 + 100); c++) grid.autofitColumn(c);
        else for (let r = r1; r <= Math.min(r2, r1 + 500); r++) grid.autofitRow(r);
      },
      openExternally: (target) => host.shell.openExternally(target),
      focus: () => cellBox.focus(),
    };
  }

  // ---- the editor

  title.set(name, dirty, path);
  tabs.draw();
  requestAnimationFrame(() => {
    grid.tellWindow();
    grid.invalidate(true);
    selectionChanged();
  });

  const editor: OfficeEditor = {
    kind: "sheet",
    el,
    title: () => name,
    path: () => path,
    dirty: () => dirty,
    save,
    print,
    snapshot: () => ({ bytes: model.toBytes(), version }),
    activate() {
      visible = true;
      grid.tellWindow();
      grid.invalidate(true);
      requestAnimationFrame(() => {
        placeEditor();
        cellBox.focus();
      });
    },
    deactivate() {
      visible = false;
      if (editing) commitEdit(activeBox().value, "none");
    },
    handleKey: (e) => gridKey(e),
    dispose() {
      grid.dispose();
      cellBox.dispose();
      barBox.dispose();
      model.free();
    },
  };
  return editor;
};

function templateName(id: string): string {
  return { budget: "Budget", invoice: "Invoice", todo: "To-do", timesheet: "Timesheet" }[id] ?? "Book";
}

export { columnName };
