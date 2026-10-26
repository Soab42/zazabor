import { h } from "../../../ui/dom";
import { CELL_BOOLEAN, CELL_ERROR, CELL_NUMBER, type Model } from "./engine";

/** More cells than this print as a warning instead (the print preview would take minutes). */
const MAX_CELLS = 150_000;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Values from the file go into CSS: only a hex colour, and a font name without quotes or markup. */
const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : "");
const safeFont = (name: string) => name.replace(/[^\p{L}\p{N} ._-]/gu, "");

/** Where the sheet's data ends. */
function usedRange(m: Model, sheet: number): [number, number] {
  let rows = 0;
  let cols = 0;
  for (let c = 1; c <= 500; c++) {
    const list = m.getRowsWithData(sheet, c);
    if (list.length) {
      rows = Math.max(rows, list[list.length - 1]);
      cols = c;
    }
  }
  return [rows, cols];
}

function border(m: Model, b: { style: string; color?: unknown } | undefined): string {
  if (!b) return "";
  const width = b.style === "thick" ? 2.25 : b.style.startsWith("medium") ? 1.5 : 0.75;
  const kind = b.style === "double" ? "double" : b.style === "dotted" ? "dotted" : b.style.includes("dash") ? "dashed" : "solid";
  return `${b.style === "double" ? 2.25 : width}pt ${kind} ${safeColor(m.resolveColor(b.color as never)) || "#000"}`;
}

/**
 * The sheet as an HTML table, the way Excel prints it: values as shown, fonts, fills, borders,
 * alignment, merged cells and column widths; no gridlines (Page Layout → Gridlines turns them on).
 */
export function sheetHtml(m: Model, sheet: number, gridlines: boolean): { html: string; cells: number } | null {
  const [rows, cols] = usedRange(m, sheet);
  if (!rows || !cols) return null;
  if (rows * cols > MAX_CELLS) return { html: "", cells: rows * cols };
  const covered = new Set<string>();
  const spans = new Map<string, [number, number]>();
  for (const mc of m.getMergedCells(sheet)) {
    spans.set(`${mc.row},${mc.column}`, [mc.height, mc.width]);
    for (let r = mc.row; r < mc.row + mc.height; r++) for (let c = mc.column; c < mc.column + mc.width; c++) if (r !== mc.row || c !== mc.column) covered.add(`${r},${c}`);
  }
  const colgroup = Array.from({ length: cols }, (_, i) => `<col style="width:${(m.getColumnWidth(sheet, i + 1) * 0.6).toFixed(1)}pt">`).join("");
  const body: string[] = [];
  for (let r = 1; r <= rows; r++) {
    const height = m.getRowHeight(sheet, r);
    if (height <= 0) continue;
    const cells: string[] = [];
    for (let c = 1; c <= cols; c++) {
      if (covered.has(`${r},${c}`)) continue;
      if (m.getColumnWidth(sheet, c) <= 0) continue;
      const text = m.getFormattedCellValue(sheet, r, c);
      const s = m.getCellStyle(sheet, r, c).style;
      const type = text ? m.getCellType(sheet, r, c) : 0;
      let align = s.alignment?.horizontal ?? "general";
      if (align === "general") align = type === CELL_NUMBER ? "right" : type === CELL_BOOLEAN || type === CELL_ERROR ? "center" : "left";
      if (align === "centerContinuous") align = "center";
      const css = [
        `text-align:${align === "fill" || align === "distributed" ? "left" : align}`,
        `vertical-align:${s.alignment?.vertical === "top" ? "top" : s.alignment?.vertical === "center" ? "middle" : "bottom"}`,
        `font-family:'${safeFont(s.font.name)}',Carlito,'Liberation Sans',sans-serif`,
        `font-size:${Number(s.font.sz) || 11}pt`,
        s.font.b ? "font-weight:bold" : "",
        s.font.i ? "font-style:italic" : "",
        s.font.u || s.font.strike ? `text-decoration:${s.font.u ? "underline" : ""} ${s.font.strike ? "line-through" : ""}` : "",
        safeColor(m.resolveColor(s.font.color)) ? `color:${safeColor(m.resolveColor(s.font.color))}` : "",
        safeColor(m.resolveColor(s.fill.color)) ? `background:${safeColor(m.resolveColor(s.fill.color))}` : "",
        s.alignment?.wrap_text ? "white-space:pre-wrap" : "white-space:pre",
        s.border?.top ? `border-top:${border(m, s.border.top)}` : "",
        s.border?.bottom ? `border-bottom:${border(m, s.border.bottom)}` : "",
        s.border?.left ? `border-left:${border(m, s.border.left)}` : "",
        s.border?.right ? `border-right:${border(m, s.border.right)}` : "",
      ].filter(Boolean).join(";");
      const span = spans.get(`${r},${c}`);
      cells.push(`<td style="${esc(css)}"${span ? ` rowspan="${span[0]}" colspan="${span[1]}"` : ""}>${esc(text)}</td>`);
    }
    body.push(`<tr style="height:${(height * 0.6).toFixed(1)}pt">${cells.join("")}</tr>`);
  }
  return { html: `<table class="${gridlines ? "grid" : ""}"><colgroup>${colgroup}</colgroup>${body.join("")}</table>`, cells: rows * cols };
}

/** Prints the active sheet through the system's print dialog (which can also save a PDF). */
export function printSheet(m: Model, sheet: number, gridlines: boolean, toast: (text: string) => void) {
  const out = sheetHtml(m, sheet, gridlines);
  if (!out) return toast("There's nothing on this sheet to print.");
  if (!out.html) return toast(`This sheet has ${out.cells.toLocaleString()} cells: too many to print at once.`);
  const style = h("style", null, `@page { margin: 0; }`);
  const area = h("div", { id: "sh-print-root" });
  area.innerHTML = out.html;
  document.body.append(style, area);
  const done = () => {
    style.remove();
    area.remove();
  };
  window.addEventListener("afterprint", done, { once: true });
  setTimeout(() => {
    window.print();
    // WebKit may not send afterprint; the print dialog is modal, so this runs after it.
    setTimeout(done, 1000);
  }, 50);
}
