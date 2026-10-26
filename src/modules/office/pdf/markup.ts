import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
import { h } from "../../../ui/dom";
import { rgbOf, type AnnotKind, type Op } from "./tools";

/**
 * CorePro's own tools on the pages, beside pdf.js's editors: text markup (underline,
 * strikethrough, squiggly) on selected text, notes, shapes, redaction marks, and text and pictures
 * placed as page content. Shapes and marks are drawn over the page while they're made; finished
 * ones go to Rust (tools.ts) and come back as part of the file.
 */

export type ShapeTool = "square" | "circle" | "line" | "arrow" | "polygon";
export type MarkupTool = "underline" | "strikeOut" | "squiggly";
export type OwnTool = MarkupTool | ShapeTool | "note" | "redact" | "text" | "picture";

export const TOOL_LABEL: Record<OwnTool, string> = {
  underline: "Underline", strikeOut: "Strikethrough", squiggly: "Squiggly", square: "Rectangle", circle: "Oval",
  line: "Line", arrow: "Arrow", polygon: "Polygon", note: "Note", redact: "Mark for Redaction", text: "Add Text", picture: "Add Picture",
};

/** A rectangle in the page's own space: x0 y0 x1 y1. */
export type Box = [number, number, number, number];

export interface RedactMark {
  box: Box;
  /** What found it, for the check afterwards; none for areas drawn by hand. */
  term?: string;
}

export interface Style {
  /** "#rrggbb". */
  color: string;
  width: number;
  opacity: number;
  fill: string | null;
}

interface PageView {
  viewport: PageViewport;
  div: HTMLElement;
}

export interface MarkupHost {
  readonly scroller: HTMLElement;
  readonly main: HTMLElement;
  pageView(index: number): PageView | undefined;
  /** Runs operations on the file (one Undo step); false when it failed. */
  apply(what: string, ops: Op[], blobs?: Uint8Array[]): Promise<boolean>;
  toast(text: string): void;
  changed(): void;
  /** Asks for a note's text; null when cancelled. */
  noteText(): Promise<string | null>;
  /** Asks for text to add to the page and places it; `at` is the top left in page space. */
  addText(page: number, at: [number, number], client: { x: number; y: number }): Promise<void>;
  /** A picture armed for placing, placed at a click. */
  placePicture(page: number, center: [number, number]): Promise<void>;
  author(): string;
}

/** The page under a client point, with the point in the page's own space. */
export function pageAt(host: MarkupHost, target: EventTarget | null, x: number, y: number): { index: number; view: PageView; point: [number, number] } | null {
  const div = (target as HTMLElement | null)?.closest?.<HTMLElement>(".page");
  if (!div) return null;
  const index = Number(div.dataset.pageNumber) - 1;
  const view = host.pageView(index);
  if (!view) return null;
  const box = (view.div.querySelector(".canvasWrapper") ?? view.div).getBoundingClientRect();
  const [px, py] = view.viewport.convertToPdfPoint(x - box.left, y - box.top);
  return { index, view, point: [px, py] };
}

function clientToPage(view: PageView, x: number, y: number): [number, number] {
  const box = (view.div.querySelector(".canvasWrapper") ?? view.div).getBoundingClientRect();
  const [px, py] = view.viewport.convertToPdfPoint(x - box.left, y - box.top);
  return [px, py];
}

/** A page-space box in the viewport's pixels (pdf.js 6 has no convertToViewportRectangle). */
export function viewportRect(viewport: PageViewport, b: Box): Box {
  const [x0, y0] = viewport.convertToViewportPoint(b[0], b[1]);
  const [x1, y1] = viewport.convertToViewportPoint(b[2], b[3]);
  return [x0, y0, x1, y1];
}

/** A page-space box as percentages of the page as it shows. */
function percentBox(view: PageView, b: Box) {
  const [x0, y0, x1, y1] = viewportRect(view.viewport, b);
  const { width, height } = view.viewport;
  return {
    left: `${(Math.min(x0, x1) / width) * 100}%`,
    top: `${(Math.min(y0, y1) / height) * 100}%`,
    width: `${(Math.abs(x1 - x0) / width) * 100}%`,
    height: `${(Math.abs(y1 - y0) / height) * 100}%`,
  };
}

export function normalize(b: Box): Box {
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

/** The text a selection covers, as client rectangles of its text (not of the elements around it). */
function textRects(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer;
  const scope = root.nodeType === Node.TEXT_NODE ? root.parentNode! : root;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const out: DOMRect[] = [];
  const nodes: Node[] = root.nodeType === Node.TEXT_NODE ? [root] : [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const n of nodes) {
    if (!range.intersectsNode(n) || !n.parentElement?.closest(".textLayer")) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    if (n === range.startContainer) r.setStart(n, range.startOffset);
    if (n === range.endContainer) r.setEnd(n, range.endOffset);
    if (r.collapsed) continue;
    for (const rect of r.getClientRects()) if (rect.width > 0.5 && rect.height > 0.5) out.push(rect);
  }
  return out;
}

/** Pieces of text on one line joined into one rectangle. */
function joinLines(rects: DOMRect[]): DOMRect[] {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: DOMRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const sameLine = last && Math.abs(last.top - r.top) < Math.min(last.height, r.height) * 0.5 && Math.abs(last.height - r.height) < Math.max(last.height, r.height) * 0.5;
    if (sameLine && r.left <= last.right + Math.max(last.height, r.height)) {
      const left = Math.min(last.left, r.left), top = Math.min(last.top, r.top);
      out[out.length - 1] = new DOMRect(left, top, Math.max(last.right, r.right) - left, Math.max(last.bottom, r.bottom) - top);
    } else out.push(r);
  }
  return out;
}

export class Markup {
  tool: OwnTool | null = null;
  style: Style = { color: "#e5484d", width: 2, opacity: 1, fill: null };
  /** Redaction marks by page (from 0). */
  readonly marks = new Map<number, RedactMark[]>();

  private drag: { index: number; view: PageView; start: [number, number]; client: [number, number]; el: SVGSVGElement; shape: SVGElement } | null = null;
  private polygon: { index: number; view: PageView; points: [number, number][]; el: SVGSVGElement; line: SVGPolylineElement } | null = null;
  private readonly ghost = h("div", { class: "pf-ghost pf-own-ghost", "aria-hidden": "true" });
  /** The text selection when the ribbon was pressed (pressing it may clear the selection). */
  private kept: Range | null = null;

  constructor(private host: MarkupHost) {
    this.ghost.hidden = true;
    host.main.append(this.ghost);
    const s = host.scroller;
    s.addEventListener("pointerdown", (e) => this.down(e), true);
    s.addEventListener("pointermove", (e) => this.move(e));
    s.addEventListener("pointerup", (e) => this.up(e), true);
    s.addEventListener("dblclick", (e) => {
      if (this.tool === "polygon" && this.polygon) {
        e.preventDefault();
        void this.finishPolygon();
      }
    }, true);
    s.addEventListener("pointerleave", () => (this.ghost.hidden = true));
  }

  setTool(tool: OwnTool | null) {
    this.cancel();
    this.tool = tool;
    this.host.scroller.classList.toggle("pf-own-drawing", !!tool && tool !== "underline" && tool !== "strikeOut" && tool !== "squiggly");
    this.host.scroller.classList.toggle("pf-redacting", tool === "redact");
    this.host.scroller.dataset.ownTool = tool ?? "";
    if (tool === "picture") {
      this.ghost.replaceChildren(h("span", { class: "pf-ghost-text" }, "Picture"));
    } else if (tool === "text") {
      this.ghost.replaceChildren(h("span", { class: "pf-ghost-text" }, "T"));
    }
    this.ghost.hidden = true;
    this.host.changed();
  }

  /** Esc: stops the shape being drawn, then the tool. True when it did something. */
  escape(): boolean {
    if (this.drag || this.polygon) {
      this.cancel();
      return true;
    }
    if (this.tool) {
      this.setTool(null);
      return true;
    }
    return false;
  }

  /** Enter finishes a polygon. */
  enter(): boolean {
    if (this.polygon) {
      void this.finishPolygon();
      return true;
    }
    return false;
  }

  cancel() {
    this.drag?.el.remove();
    this.drag = null;
    this.polygon?.el.remove();
    this.polygon = null;
  }

  /** Remembers the text selection in the pages (called as the ribbon is pressed). */
  keepSelection() {
    const sel = getSelection();
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
    this.kept = range && this.host.scroller.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  }

  /** Text markup on the selected text now; false when nothing is selected. */
  async markSelection(kind: MarkupTool): Promise<boolean> {
    const sel = getSelection();
    let range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !this.host.scroller.contains(range.commonAncestorContainer)) range = this.kept;
    this.kept = null;
    if (!range) return false;
    const rects = joinLines(textRects(range));
    if (!rects.length) return false;
    // By page: the quadrilaterals of each line.
    const byPage = new Map<number, number[]>();
    for (const r of rects) {
      const hit = pageAt(this.host, document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), r.left + r.width / 2, r.top + r.height / 2);
      if (!hit) continue;
      const v = hit.view;
      const ul = clientToPage(v, r.left, r.top), ur = clientToPage(v, r.right, r.top);
      const ll = clientToPage(v, r.left, r.bottom), lr = clientToPage(v, r.right, r.bottom);
      const list = byPage.get(hit.index) ?? [];
      list.push(...ul, ...ur, ...ll, ...lr);
      byPage.set(hit.index, list);
    }
    if (!byPage.size) return false;
    sel?.removeAllRanges();
    const ops: Op[] = [...byPage].map(([index, quads]) => ({
      op: "annotate", page: index + 1,
      annot: { kind: kind as AnnotKind, quads, color: rgbOf(this.style.color), opacity: this.style.opacity, author: this.host.author() },
    }));
    return this.host.apply(TOOL_LABEL[kind], ops);
  }

  // ---- pointer

  private down(e: PointerEvent) {
    const tool = this.tool;
    if (!tool || e.button !== 0 || tool === "underline" || tool === "strikeOut" || tool === "squiggly") return;
    const hit = pageAt(this.host, e.target, e.clientX, e.clientY);
    // Clicking a redaction mark removes it.
    if (tool === "redact" && (e.target as HTMLElement).closest?.(".pf-redact-mark")) {
      e.preventDefault();
      e.stopPropagation();
      const el = (e.target as HTMLElement).closest<HTMLElement>(".pf-redact-mark")!;
      const list = this.marks.get(Number(el.dataset.page));
      list?.splice(Number(el.dataset.index), 1);
      this.drawMarks(Number(el.dataset.page));
      this.host.changed();
      return;
    }
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    if (tool === "note" || tool === "text" || tool === "picture") return; // placed on pointerup
    if (tool === "polygon") {
      if (this.polygon && this.polygon.index !== hit.index) this.cancel();
      if (!this.polygon) {
        const el = this.svg(hit.view);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        this.styleShape(line);
        el.append(line);
        this.polygon = { index: hit.index, view: hit.view, points: [], el, line };
      }
      this.polygon.points.push(hit.point);
      this.drawPolygon(hit.point);
      return;
    }
    const el = this.svg(hit.view);
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tool === "circle" ? "ellipse" : tool === "line" || tool === "arrow" ? "line" : "rect");
    if (tool === "redact") shape.setAttribute("class", "pf-redact-draft");
    else this.styleShape(shape);
    el.append(shape);
    this.drag = { index: hit.index, view: hit.view, start: hit.point, client: [e.clientX, e.clientY], el, shape };
    this.host.scroller.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent) {
    if (this.tool === "picture" || this.tool === "text" || this.tool === "note") {
      const r = this.host.main.getBoundingClientRect();
      this.ghost.hidden = this.tool === "note" || !(e.target as HTMLElement).closest?.(".page");
      this.ghost.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px) translate(-50%, -50%)`;
    }
    if (this.polygon) {
      this.drawPolygon(clientToPage(this.polygon.view, e.clientX, e.clientY));
      return;
    }
    const d = this.drag;
    if (!d) return;
    const end = this.constrain(d.start, clientToPage(d.view, e.clientX, e.clientY), e.shiftKey);
    this.drawDrag(d, end);
  }

  private async up(e: PointerEvent) {
    const tool = this.tool;
    if (!tool || e.button !== 0) return;
    if (tool === "underline" || tool === "strikeOut" || tool === "squiggly") {
      // Text was selected with the tool on: mark it.
      setTimeout(() => void this.markSelection(tool), 0);
      return;
    }
    if (tool === "note" || tool === "text" || tool === "picture") {
      const hit = pageAt(this.host, e.target, e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (tool === "note") {
        const text = await this.host.noteText();
        // One note at a time, as in Acrobat: the tool goes off.
        this.setTool(null);
        if (text == null) return;
        await this.host.apply("Adding a note", [{
          op: "annotate", page: hit.index + 1,
          annot: { kind: "note", rect: [hit.point[0], hit.point[1], hit.point[0], hit.point[1]], color: rgbOf(this.style.color), contents: text, author: this.host.author() },
        }]);
      } else if (tool === "text") {
        await this.host.addText(hit.index + 1, hit.point, { x: e.clientX, y: e.clientY });
      } else {
        this.ghost.hidden = true;
        await this.host.placePicture(hit.index + 1, hit.point);
      }
      return;
    }
    const d = this.drag;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    this.drag = null;
    d.el.remove();
    const end = this.constrain(d.start, clientToPage(d.view, e.clientX, e.clientY), e.shiftKey);
    const moved = Math.hypot(e.clientX - d.client[0], e.clientY - d.client[1]) > 3;
    if (!moved) return;
    const page = d.index + 1;
    const color = rgbOf(this.style.color);
    if (tool === "redact") {
      const list = this.marks.get(d.index) ?? [];
      list.push({ box: normalize([...d.start, ...end]) });
      this.marks.set(d.index, list);
      this.drawMarks(d.index);
      this.host.changed();
      return;
    }
    const base = { color, width: this.style.width, opacity: this.style.opacity, author: this.host.author() };
    if (tool === "line" || tool === "arrow") {
      await this.host.apply(TOOL_LABEL[tool], [{ op: "annotate", page, annot: { ...base, kind: tool, points: [...d.start, ...end] } }]);
    } else {
      await this.host.apply(TOOL_LABEL[tool], [{ op: "annotate", page, annot: { ...base, kind: tool as AnnotKind, rect: normalize([...d.start, ...end]), fill: this.style.fill ? rgbOf(this.style.fill) : null } }]);
    }
  }

  /** Shift: squares and circles, and lines at 45° steps. */
  private constrain(start: [number, number], end: [number, number], shift: boolean): [number, number] {
    if (!shift) return end;
    const [dx, dy] = [end[0] - start[0], end[1] - start[1]];
    if (this.tool === "line" || this.tool === "arrow") {
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return [start[0] + Math.cos(angle) * len, start[1] + Math.sin(angle) * len];
    }
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [start[0] + Math.sign(dx || 1) * side, start[1] + Math.sign(dy || 1) * side];
  }

  private async finishPolygon() {
    const p = this.polygon;
    if (!p) return;
    this.polygon = null;
    p.el.remove();
    // A double click adds the last corner twice.
    const pts = p.points.filter((q, i) => i === 0 || Math.hypot(q[0] - p.points[i - 1][0], q[1] - p.points[i - 1][1]) > 0.5);
    if (pts.length < 3) return this.host.toast("A polygon needs at least three corners.");
    await this.host.apply("Polygon", [{
      op: "annotate", page: p.index + 1,
      annot: { kind: "polygon", points: pts.flat(), color: rgbOf(this.style.color), width: this.style.width, opacity: this.style.opacity, fill: this.style.fill ? rgbOf(this.style.fill) : null, author: this.host.author() },
    }]);
  }

  // ---- drawing over the page

  private svg(view: PageView): SVGSVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("class", "pf-draft");
    el.setAttribute("viewBox", `0 0 ${view.viewport.width} ${view.viewport.height}`);
    el.setAttribute("preserveAspectRatio", "none");
    view.div.append(el);
    return el;
  }

  private styleShape(shape: SVGElement) {
    shape.setAttribute("stroke", this.style.color);
    shape.setAttribute("stroke-width", String(Math.max(1, this.style.width)));
    shape.setAttribute("fill", this.style.fill ?? "none");
    shape.setAttribute("opacity", String(this.style.opacity));
    shape.setAttribute("vector-effect", "non-scaling-stroke");
  }

  private drawDrag(d: NonNullable<Markup["drag"]>, end: [number, number]) {
    const [x0, y0] = d.view.viewport.convertToViewportPoint(d.start[0], d.start[1]);
    const [x1, y1] = d.view.viewport.convertToViewportPoint(end[0], end[1]);
    const s = d.shape;
    if (s instanceof SVGLineElement) {
      s.setAttribute("x1", String(x0));
      s.setAttribute("y1", String(y0));
      s.setAttribute("x2", String(x1));
      s.setAttribute("y2", String(y1));
    } else if (s instanceof SVGEllipseElement) {
      s.setAttribute("cx", String((x0 + x1) / 2));
      s.setAttribute("cy", String((y0 + y1) / 2));
      s.setAttribute("rx", String(Math.abs(x1 - x0) / 2));
      s.setAttribute("ry", String(Math.abs(y1 - y0) / 2));
    } else {
      s.setAttribute("x", String(Math.min(x0, x1)));
      s.setAttribute("y", String(Math.min(y0, y1)));
      s.setAttribute("width", String(Math.abs(x1 - x0)));
      s.setAttribute("height", String(Math.abs(y1 - y0)));
    }
  }

  private drawPolygon(cursor: [number, number]) {
    const p = this.polygon;
    if (!p) return;
    const pts = [...p.points, cursor].map((q) => p.view.viewport.convertToViewportPoint(q[0], q[1]).join(",")).join(" ");
    p.line.setAttribute("points", pts);
  }

  /** Draws page `index`'s redaction marks (again, after pdf.js re-renders the page). */
  drawMarks(index: number) {
    const view = this.host.pageView(index);
    if (!view) return;
    view.div.querySelector(".pf-redact-layer")?.remove();
    const list = this.marks.get(index);
    if (!list?.length) return;
    const layer = h("div", { class: "pf-redact-layer" });
    list.forEach((m, i) => {
      const el = h("div", { class: "pf-redact-mark", "data-page": String(index), "data-index": String(i), title: "Marked for redaction (click with Mark for Redaction on to remove)" });
      Object.assign(el.style, percentBox(view, m.box));
      layer.append(el);
    });
    view.div.append(layer);
  }

  markCount(): number {
    let n = 0;
    for (const list of this.marks.values()) n += list.length;
    return n;
  }

  clearMarks() {
    const pages = [...this.marks.keys()];
    this.marks.clear();
    for (const p of pages) this.drawMarks(p);
    this.host.changed();
  }

  /** The marks are for this file only: a new version of the pages (or another file) drops them. */
  reset() {
    this.cancel();
    this.marks.clear();
  }

  // ---- finding text to redact

  /**
   * Marks every match of `patterns` in the document's text; returns how many. A mark covers the
   * whole words a match touches, measured with the PDF's own fonts along pdf.js's text runs, with
   * a margin: redacting a little more is safe, a little less is not.
   */
  async findMarks(doc: PDFDocumentProxy, patterns: { regex: RegExp; label: string }[]): Promise<number> {
    const canvas = document.createElement("canvas").getContext("2d")!;
    let found = 0;
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const content = await page.getTextContent();
      const styles = content.styles as Record<string, { fontFamily?: string }>;
      // pdf.js loads a page's fonts (as font faces named like its text runs' fonts) when it draws
      // the page: drawing it tiny once lets the widths below come from the real glyphs.
      const names = [...new Set(content.items.map((it) => ("fontName" in it ? it.fontName : "")).filter(Boolean))];
      if (names.some((n) => !document.fonts.check(`10px "${n}"`))) {
        const tiny = document.createElement("canvas");
        await page.render({ canvas: tiny, viewport: page.getViewport({ scale: 0.05 }) }).promise.catch(() => undefined);
      }
      // The page's text as one string, with where each run starts.
      type Run = { str: string; transform: number[]; width: number; height: number; fontName: string };
      const runs = content.items.filter((it): it is Run & typeof it => "str" in it) as unknown as (Run & { hasEOL?: boolean })[];
      let text = "";
      const starts: number[] = [];
      for (const r of runs) {
        starts.push(text.length);
        text += r.str + (r.hasEOL ? "\n" : " ");
      }
      const list = this.marks.get(i) ?? [];
      for (const { regex, label } of patterns) {
        regex.lastIndex = 0;
        for (let m = regex.exec(text); m; m = regex.exec(text)) {
          if (!m[0].length) {
            regex.lastIndex++;
            continue;
          }
          const from = m.index, to = m.index + m[0].length;
          for (let k = 0; k < runs.length; k++) {
            const s = starts[k], e = s + runs[k].str.length;
            if (e <= from || s >= to || !runs[k].str.length) continue;
            const r = runs[k];
            let a = Math.max(from, s) - s, b = Math.min(to, e) - s;
            // Out to the edges of the words.
            while (a > 0 && !/\s/.test(r.str[a - 1])) a--;
            while (b < r.str.length && !/\s/.test(r.str[b])) b++;
            canvas.font = `100px "${r.fontName}", ${styles[r.fontName]?.fontFamily ?? "sans-serif"}`;
            const whole = canvas.measureText(r.str).width || 1;
            const p0 = canvas.measureText(r.str.slice(0, a)).width / whole;
            const p1 = canvas.measureText(r.str.slice(0, b)).width / whole;
            const [ta, tb, tc, td, te, tf] = r.transform;
            const ulen = Math.hypot(ta, tb) || 1, vlen = Math.hypot(tc, td) || 1;
            const u = [ta / ulen, tb / ulen], v = [tc / vlen, td / vlen];
            const size = r.height || vlen;
            // Most of a letter's width of margin either side, and from below the baseline to above caps.
            const pad = (r.width / Math.max(1, r.str.length)) * 0.8;
            const x0 = r.width * p0 - pad, x1 = r.width * p1 + pad;
            const y0 = -0.35 * size, y1 = 1.05 * size;
            const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [te + u[0] * x + v[0] * y, tf + u[1] * x + v[1] * y]);
            const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
            list.push({ box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], term: label === "text" ? m[0] : m[0] });
            found++;
          }
        }
      }
      if (list.length) this.marks.set(i, list);
      this.drawMarks(i);
      page.cleanup();
    }
    this.host.changed();
    return found;
  }
}
