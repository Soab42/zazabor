import { clamp, h } from "../../../ui/dom";
import type { PageSetup } from "./read";

/** Points to CSS pixels (96 per inch against 72). */
export const px = (pt: number) => (pt * 4) / 3;

/**
 * Print Layout as Word shows it: white paper of the document's size on a grey desk, with the
 * document's margins, centred and zoomable. The text flows on one sheet; a dashed line and the
 * page number mark where each page ends, and a page break opens a real gap between two sheets.
 * Web Layout drops the paper and lets the text fill the window.
 */
export class PageView {
  readonly el: HTMLElement;
  /** Where the editor goes. */
  readonly content = h("div", { class: "dc-content" });
  private paper: HTMLElement;
  private guides = h("div", { class: "dc-guides", "aria-hidden": "true" });
  private fill = h("div", { class: "dc-fill" });
  private page: PageSetup;
  private pages = 1;
  zoom = 1;
  layout: "print" | "web" = "print";
  private queued = false;

  constructor(page: PageSetup, private readonly changed: () => void) {
    this.page = page;
    this.paper = h("div", { class: "dc-paper" }, this.guides, this.content, this.fill);
    this.el = h("div", { class: "dc-desk" }, h("div", { class: "dc-sheet-wrap" }, this.paper));
    new ResizeObserver(() => this.measureSoon()).observe(this.content);
    this.apply();
  }

  get setup(): PageSetup {
    return this.page;
  }

  setPage(page: PageSetup) {
    this.page = page;
    this.apply();
  }

  /** Width and height of the page as laid out (landscape swaps them), in points. */
  private dims() {
    const { width, height, orientation } = this.page;
    return orientation === "landscape" ? { w: height, h: width } : { w: width, h: height };
  }

  private apply() {
    const { w } = this.dims();
    const m = this.page.margins;
    const s = this.paper.style;
    s.setProperty("--pw", `${px(w)}px`);
    s.setProperty("--mt", `${px(m.top)}px`);
    s.setProperty("--mr", `${px(m.right)}px`);
    s.setProperty("--mb", `${px(m.bottom)}px`);
    s.setProperty("--ml", `${px(m.left)}px`);
    this.paper.style.zoom = String(this.zoom);
    this.el.classList.toggle("web", this.layout === "web");
    this.measureSoon();
  }

  setZoom(z: number) {
    this.zoom = clamp(Math.round(z * 100) / 100, 0.1, 5);
    this.apply();
    this.changed();
  }

  setLayout(layout: "print" | "web") {
    this.layout = layout;
    this.apply();
    this.changed();
  }

  /** View → Page Width. */
  fitWidth() {
    const room = this.el.clientWidth - 48;
    this.setZoom(room / px(this.dims().w));
  }

  /** View → One Page. */
  onePage() {
    const room = this.el.clientHeight - 48;
    this.setZoom(Math.min(room / px(this.dims().h), (this.el.clientWidth - 48) / px(this.dims().w)));
  }

  /** How many pages the text fills (Print Layout's count, also used for Web Layout). */
  get pageCount(): number {
    return this.pages;
  }

  /** The page the caret is on, from its top in viewport pixels. */
  pageAt(clientY: number): number {
    const root = this.content.firstElementChild as HTMLElement | null;
    if (!root) return 1;
    const rect = root.getBoundingClientRect();
    const y = (clientY - rect.top) / (this.zoom || 1);
    const per = this.perPage();
    let page = 1;
    for (const seg of this.segments(root)) {
      if (y < seg.end || seg === this.lastSeg) return page + Math.max(0, Math.floor((y - seg.start) / per));
      page += seg.pages;
    }
    return page;
  }

  private lastSeg: { start: number; end: number; pages: number } | null = null;

  /** The text height that fits on one page, in CSS pixels. */
  private perPage(): number {
    const m = this.page.margins;
    return Math.max(48, px(this.dims().h - m.top - m.bottom));
  }

  /** Runs of text between page breaks, in the editor's own pixels. */
  private segments(root: HTMLElement) {
    const per = this.perPage();
    const segs: { start: number; end: number; pages: number }[] = [];
    let start = 0;
    for (const br of Array.from(root.querySelectorAll<HTMLElement>(":scope > .dc-page-break"))) {
      const end = br.offsetTop;
      segs.push({ start, end, pages: Math.max(1, Math.ceil((end - start - 1) / per)) });
      start = br.offsetTop + br.offsetHeight;
    }
    const end = root.offsetHeight;
    segs.push({ start, end, pages: Math.max(1, Math.ceil((end - start - 1) / per)) });
    this.lastSeg = segs[segs.length - 1];
    return segs;
  }

  measureSoon() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.measure();
    });
  }

  /** Draws where pages end and fills the last page down to its bottom margin. */
  private measure() {
    const root = this.content.firstElementChild as HTMLElement | null;
    if (!root || this.layout === "web") {
      this.guides.replaceChildren();
      this.fill.style.height = "0px";
      return;
    }
    const per = this.perPage();
    const lines: HTMLElement[] = [];
    let page = 1;
    const segs = this.segments(root);
    for (const seg of segs) {
      for (let k = 1; k < seg.pages; k++) {
        lines.push(h("div", { class: "dc-guide", style: { top: `calc(var(--mt) + ${seg.start + k * per}px)` } }, h("span", null, `Page ${page + k}`)));
      }
      page += seg.pages;
    }
    this.guides.replaceChildren(...lines);
    const last = segs[segs.length - 1];
    this.fill.style.height = `${Math.max(0, last.start + last.pages * per - last.end)}px`;
    const before = this.pages;
    this.pages = page - 1;
    if (before !== this.pages) this.changed();
  }
}
