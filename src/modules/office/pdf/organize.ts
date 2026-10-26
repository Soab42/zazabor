import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { lazyThumbs, type Thumbs } from "./thumbs";

/** What Organize Pages asks the editor to do; page numbers are 0-based, in the current order. */
export interface OrganizeOps {
  /** Moves `pages` (in their order) so they start at gap `to` (0 = before the first page). */
  move(pages: number[], to: number): void;
  rotate(pages: number[], delta: number): void;
  remove(pages: number[]): void;
  /** Inserts at gap `at`. */
  insert(at: number, what: "file" | "blank"): void;
  extract(pages: number[]): void;
  /** Shows the page in the reading view. */
  open(page: number): void;
  changed(): void;
}

const SIZES = [96, 128, 160, 200, 260];

/**
 * Organize Pages, as Acrobat lays it out: every page as a tile in a grid. Click, Ctrl+click and
 * Shift+click select; drag to move; each tile's buttons rotate and delete; the gaps between tiles
 * insert. Changes are the editor's (`OrganizeOps`); the grid is redrawn from the new document.
 */
export class Organizer {
  readonly el: HTMLElement;
  readonly selected = new Set<number>();
  private grid = h("div", { class: "pf-org-grid", role: "listbox", "aria-multiselectable": "true", "aria-label": "Pages" });
  private count = 0;
  private thumbs: Thumbs | null = null;
  private observer: IntersectionObserver;
  private anchor = -1;
  private sizeIndex = 2;
  private marker = h("div", { class: "pf-org-marker" });
  private drag: { pages: number[]; startX: number; startY: number; moving: boolean; gap: number; ghost: HTMLElement | null } | null = null;

  constructor(private readonly ops: OrganizeOps) {
    this.el = h("div", { class: "pf-org", tabindex: "-1" }, this.grid);
    this.observer = lazyThumbs(this.el, () => this.thumbs);
    this.el.addEventListener("pointerdown", (e) => {
      if (e.target === this.el || e.target === this.grid) {
        this.selected.clear();
        this.paint();
      }
    });
    this.el.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.resize(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  get tileWidth() {
    return SIZES[this.sizeIndex];
  }

  /** Larger (1) or smaller (-1) tiles. */
  resize(step: number) {
    const next = Math.max(0, Math.min(SIZES.length - 1, this.sizeIndex + step));
    if (next === this.sizeIndex) return;
    this.sizeIndex = next;
    this.draw();
  }

  /** Draws the pages of the document showing now. */
  show(count: number, thumbs: Thumbs, select?: number[]) {
    this.count = count;
    this.thumbs = thumbs;
    this.selected.clear();
    for (const p of select ?? []) if (p < count) this.selected.add(p);
    this.draw();
  }

  private draw() {
    this.observer.disconnect();
    const width = this.tileWidth;
    this.grid.style.setProperty("--tile", `${width}px`);
    const tiles: HTMLElement[] = [];
    for (let i = 0; i < this.count; i++) {
      const img = h("img", { class: "pf-org-img", alt: "", draggable: false, "data-page": String(i), "data-width": String(width) });
      img.addEventListener("load", () => (img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`), { once: true });
      const tools = h("div", { class: "pf-org-tools" },
        this.tool("rotateLeft", "Rotate Left", () => this.ops.rotate(this.targets(i), -90)),
        this.tool("rotateRight", "Rotate Right", () => this.ops.rotate(this.targets(i), 90)),
        this.tool("trash", "Delete", () => this.ops.remove(this.targets(i))));
      const tile = h("div", { class: "pf-org-tile", role: "option", tabindex: "-1", "data-index": String(i), title: `Page ${i + 1}` },
        h("div", { class: "pf-org-page" }, img, tools),
        h("div", { class: "pf-org-num" }, String(i + 1)));
      tile.addEventListener("pointerdown", (e) => this.down(e, i));
      tile.addEventListener("dblclick", () => this.ops.open(i));
      tile.addEventListener("contextmenu", (e) => this.menu(e, i));
      this.observer.observe(img);
      tiles.push(this.gap(i), tile);
    }
    tiles.push(this.gap(this.count));
    this.grid.replaceChildren(...tiles, this.marker);
    this.marker.hidden = true;
    this.paint();
  }

  /** The thin space before page `at`, with its Insert button. */
  private gap(at: number): HTMLElement {
    const add = h("button", {
      class: "pf-org-add", type: "button", title: "Insert Pages", "aria-label": `Insert pages before page ${at + 1}`,
      onclick: (e: MouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom + 4, [
          { label: "From File…", icon: "pageAdd", action: () => this.ops.insert(at, "file") },
          { label: "Blank Page", icon: "blankPage", action: () => this.ops.insert(at, "blank") },
        ]);
      },
    }, icon("plus", 14));
    return h("div", { class: "pf-org-gap", "data-gap": String(at) }, add);
  }

  private tool(name: "rotateLeft" | "rotateRight" | "trash", title: string, run: () => void): HTMLElement {
    return h("button", {
      class: "pf-org-tool", type: "button", title, "aria-label": title,
      onpointerdown: (e: Event) => e.stopPropagation(),
      onclick: (e: Event) => {
        e.stopPropagation();
        run();
      },
    }, icon(name, 14));
  }

  /** The pages a tile's button acts on: the selection when the tile is in it, else the tile. */
  private targets(i: number): number[] {
    return this.selected.has(i) ? [...this.selected].sort((a, b) => a - b) : [i];
  }

  private menu(e: MouseEvent, i: number) {
    e.preventDefault();
    if (!this.selected.has(i)) {
      this.selected.clear();
      this.selected.add(i);
      this.anchor = i;
      this.paint();
    }
    const pages = this.targets(i);
    const many = pages.length > 1 ? ` ${pages.length} Pages` : "";
    openMenu(e.clientX, e.clientY, [
      { label: `Rotate${many} Left`, icon: "rotateLeft", action: () => this.ops.rotate(pages, -90) },
      { label: `Rotate${many} Right`, icon: "rotateRight", action: () => this.ops.rotate(pages, 90) },
      "separator",
      { label: "Insert From File…", icon: "pageAdd", action: () => this.ops.insert(pages[pages.length - 1] + 1, "file") },
      { label: "Insert Blank Page", icon: "blankPage", action: () => this.ops.insert(pages[pages.length - 1] + 1, "blank") },
      { label: `Extract${many}…`, icon: "pageExtract", action: () => this.ops.extract(pages) },
      "separator",
      { label: `Delete${many}`, icon: "trash", danger: true, action: () => this.ops.remove(pages), disabled: pages.length >= this.count },
    ]);
  }

  // ---- selection

  private paint() {
    for (const tile of this.grid.querySelectorAll<HTMLElement>(".pf-org-tile")) {
      const on = this.selected.has(Number(tile.dataset.index));
      tile.classList.toggle("selected", on);
      tile.setAttribute("aria-selected", String(on));
    }
    this.ops.changed();
  }

  select(pages: number[]) {
    this.selected.clear();
    for (const p of pages) if (p >= 0 && p < this.count) this.selected.add(p);
    this.anchor = pages[pages.length - 1] ?? -1;
    this.paint();
  }

  selectWhere(which: "all" | "odd" | "even" | "none") {
    this.select(which === "none" ? [] : Array.from({ length: this.count }, (_, i) => i).filter((i) => which === "all" || (which === "odd" ? i % 2 === 0 : i % 2 === 1)));
  }

  /** The selected pages in order, or none. */
  selection(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  /** Arrow keys move the selection; Shift extends it. */
  step(delta: number, extend: boolean) {
    if (!this.count) return;
    const from = this.anchor >= 0 ? this.anchor : 0;
    let to = from + delta;
    if (Math.abs(delta) > 1) {
      // Up and down move a row.
      const tiles = this.grid.querySelectorAll<HTMLElement>(".pf-org-tile");
      const top = tiles[0]?.offsetTop ?? 0;
      const perRow = Math.max(1, Array.from(tiles).filter((t) => t.offsetTop === top).length);
      to = from + Math.sign(delta) * perRow;
    }
    to = Math.max(0, Math.min(this.count - 1, to));
    if (!extend) this.selected.clear();
    this.selected.add(to);
    this.anchor = to;
    this.paint();
    this.grid.querySelector<HTMLElement>(`.pf-org-tile[data-index="${to}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ---- clicking and dragging

  private down(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    this.el.focus({ preventScroll: true });
    if (e.shiftKey && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      if (!(e.ctrlKey || e.metaKey)) this.selected.clear();
      for (let p = a; p <= b; p++) this.selected.add(p);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(i)) this.selected.delete(i);
      else this.selected.add(i);
      this.anchor = i;
    } else if (!this.selected.has(i)) {
      this.selected.clear();
      this.selected.add(i);
      this.anchor = i;
    } else {
      this.anchor = i;
    }
    this.paint();
    this.drag = { pages: this.targets(i), startX: e.clientX, startY: e.clientY, moving: false, gap: -1, ghost: null };
    const move = (ev: PointerEvent) => this.dragMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.dragEnd(ev, i);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private dragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
      d.moving = true;
      this.el.classList.add("dragging");
      d.ghost = h("div", { class: "pf-org-ghost" }, d.pages.length > 1 ? `${d.pages.length} pages` : `Page ${d.pages[0] + 1}`);
      document.body.append(d.ghost);
    }
    d.ghost!.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    d.gap = this.gapAt(e.clientX, e.clientY);
    const gap = this.grid.querySelector<HTMLElement>(`.pf-org-gap[data-gap="${d.gap}"]`);
    if (gap) {
      this.marker.hidden = false;
      this.marker.style.left = `${gap.offsetLeft + gap.offsetWidth / 2 - 1.5}px`;
      this.marker.style.top = `${gap.offsetTop}px`;
      this.marker.style.height = `${gap.offsetHeight}px`;
    }
    // Near the edges, the grid scrolls.
    const r = this.el.getBoundingClientRect();
    if (e.clientY < r.top + 40) this.el.scrollTop -= 14;
    else if (e.clientY > r.bottom - 40) this.el.scrollTop += 14;
  }

  /** The gap nearest a point: before the tile under it, or after it past its middle. */
  private gapAt(x: number, y: number): number {
    let best = this.count;
    let bestDist = Infinity;
    for (const gap of this.grid.querySelectorAll<HTMLElement>(".pf-org-gap")) {
      const r = gap.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dist = Math.abs(x - cx) + dy * 3;
      if (dist < bestDist) {
        bestDist = dist;
        best = Number(gap.dataset.gap);
      }
    }
    return best;
  }

  private dragEnd(e: PointerEvent, i: number) {
    const d = this.drag;
    this.drag = null;
    this.marker.hidden = true;
    this.el.classList.remove("dragging");
    d?.ghost?.remove();
    if (!d) return;
    if (!d.moving) {
      // A plain click on a page of a selection selects just that page.
      if (!e.shiftKey && !(e.ctrlKey || e.metaKey) && this.selected.size > 1) {
        this.selected.clear();
        this.selected.add(i);
        this.paint();
      }
      return;
    }
    const before = d.pages.filter((p) => p < d.gap).length;
    const to = d.gap - before;
    // Dropped where they already are.
    const contiguous = d.pages.every((p, k) => p === d.pages[0] + k);
    if (contiguous && to === d.pages[0]) return;
    this.ops.move(d.pages, to);
  }

  dispose() {
    this.observer.disconnect();
  }
}
