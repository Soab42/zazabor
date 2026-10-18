import { h } from "../../../ui/dom";
import { edgeScroll, swallowClick } from "../dnd";
import type { Sel } from "../selection";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const THRESHOLD = 4;

/** Rectangle spanned by two points. */
export function rectOf(x1: number, y1: number, x2: number, y2: number): Rect {
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Indices of fixed-height rows (list view) the band touches; `band` is in content coordinates. */
export function rowHits(band: Rect, rowHeight: number, pad: number, count: number): number[] {
  if (count === 0) return [];
  const first = Math.max(0, Math.floor((band.top - pad) / rowHeight));
  const last = Math.min(count - 1, Math.floor((band.bottom - pad) / rowHeight));
  const out: number[] = [];
  for (let i = first; i <= last; i++) if (band.bottom > pad + i * rowHeight && band.top < pad + (i + 1) * rowHeight) out.push(i);
  return out;
}

export interface TileGrid {
  count: number;
  cols: number;
  width: number;
  pad: number;
  sidePad: number;
  rowHeight: number;
  tileHeight: number;
  /** Horizontal margin of a tile inside its grid cell. */
  gap: number;
}

/** Indices of grid tiles (icon view) the band touches; `band` is in content coordinates. */
export function tileHits(band: Rect, g: TileGrid): number[] {
  if (g.count === 0) return [];
  const cell = (g.width - g.sidePad * 2) / g.cols;
  const rows = Math.ceil(g.count / g.cols);
  const r0 = Math.max(0, Math.floor((band.top - g.pad) / g.rowHeight));
  const r1 = Math.min(rows - 1, Math.floor((band.bottom - g.pad) / g.rowHeight));
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c;
      if (i >= g.count) break;
      const tile: Rect = {
        left: g.sidePad + c * cell + g.gap, right: g.sidePad + (c + 1) * cell - g.gap,
        top: g.pad + r * g.rowHeight, bottom: g.pad + r * g.rowHeight + g.tileHeight,
      };
      if (intersects(band, tile)) out.push(i);
    }
  }
  return out;
}

export interface RubberOptions {
  /** The scroll container (a virtual list element). */
  scroller: HTMLElement;
  /** True when the pointer went down on empty space rather than an item. */
  isEmpty(target: HTMLElement): boolean;
  /** Paths of the items the band touches; `band` is in the scroller's content coordinates. */
  hits(band: Rect): string[];
  sel(): Sel;
  /** Selection changed: repaint and update the status bar. */
  changed(): void;
}

/**
 * Rubber-band selection: dragging on empty space draws a translucent accent rectangle and selects
 * what it touches. Ctrl or Shift keeps the selection that was there; edges auto-scroll.
 */
export function attachRubberBand(opts: RubberOptions): () => void {
  const { scroller } = opts;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !(e.target instanceof HTMLElement) || !opts.isEmpty(e.target)) return;
    const box = scroller.getBoundingClientRect();
    // Not on the scrollbar.
    if (e.clientX >= box.left + scroller.clientWidth || e.clientY >= box.top + scroller.clientHeight) return;
    start(e);
  };

  const start = (down: PointerEvent) => {
    const additive = down.ctrlKey || down.metaKey || down.shiftKey;
    const base = additive ? new Set(opts.sel().selection) : new Set<string>();
    // Content coordinates of the press, kept fixed while the list scrolls under the pointer.
    const first = scroller.getBoundingClientRect();
    const anchor = { x: down.clientX - first.left + scroller.scrollLeft, y: down.clientY - first.top + scroller.scrollTop };
    let px = down.clientX;
    let py = down.clientY;
    let band: HTMLElement | null = null;
    let frame = 0;

    const apply = () => {
      const box = scroller.getBoundingClientRect();
      const cx = Math.max(box.left, Math.min(px, box.left + scroller.clientWidth));
      const cy = Math.max(box.top, Math.min(py, box.top + scroller.clientHeight));
      const pointX = cx - box.left + scroller.scrollLeft;
      const pointY = cy - box.top + scroller.scrollTop;
      const rect = rectOf(anchor.x, anchor.y, pointX, pointY);
      if (band) {
        // The press point moves on screen as the list scrolls.
        const sx = box.left + anchor.x - scroller.scrollLeft;
        const sy = box.top + anchor.y - scroller.scrollTop;
        const v = rectOf(Math.max(box.left, Math.min(sx, box.left + scroller.clientWidth)), Math.max(box.top, Math.min(sy, box.top + scroller.clientHeight)), cx, cy);
        Object.assign(band.style, { left: `${v.left}px`, top: `${v.top}px`, width: `${v.right - v.left}px`, height: `${v.bottom - v.top}px` });
      }
      const sel = opts.sel();
      const next = new Set(base);
      const hit = opts.hits(rect);
      for (const p of hit) next.add(p);
      sel.selection = next;
      if (hit.length) sel.anchor = sel.focus = hit[hit.length - 1];
      opts.changed();
    };

    const move = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      if (!band) {
        if (Math.hypot(px - down.clientX, py - down.clientY) < THRESHOLD) return;
        band = h("div", { class: "rubber-band" });
        document.body.append(band);
        scroller.focus({ preventScroll: true });
        document.addEventListener("pointerup", swallowClick, { capture: true, once: true });
        frame = requestAnimationFrame(tick);
      }
      apply();
    };
    const tick = () => {
      const box = scroller.getBoundingClientRect();
      const dy = edgeScroll(py, box.top, box.bottom);
      if (dy) {
        scroller.scrollTop += dy;
        apply();
      }
      frame = requestAnimationFrame(tick);
    };
    const end = (e: Event) => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      cancelAnimationFrame(frame);
      band?.remove();
      if (e.type === "pointercancel") document.removeEventListener("pointerup", swallowClick, true);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
  };

  scroller.addEventListener("pointerdown", onDown);
  return () => scroller.removeEventListener("pointerdown", onDown);
}
