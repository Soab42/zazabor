import { h } from "../../../../ui/dom";

/**
 * Pointer-based drag and drop. The webview's own drag and drop is taken over by the window for
 * files dropped from outside, so lists here move things with pointer events instead.
 *
 * A source is dragged by `draggable()`; a list accepts drops with `dropList()`, which reports the
 * insertion index under the pointer and draws an insertion line.
 */

export interface DragData {
  /** The files (or stream addresses) being dragged. */
  paths: string[];
  /** Which list the drag started in, and the index there (for reordering inside it). */
  origin?: { list: string; index: number };
  /** Text for the floating chip. */
  label: string;
}

interface DropZone {
  el: HTMLElement;
  /** The element holding the rows; their position decides the insertion index. */
  rows: () => HTMLElement[];
  accepts: (data: DragData) => boolean;
  drop: (data: DragData, index: number) => void;
  /** Whole-element target (a playlist card) instead of an insertion point. */
  onto?: boolean;
}

const zones = new Set<DropZone>();
const THRESHOLD = 6;
let dragging = false;

/** Whether a drag is in progress (clicks right after one are ignored). */
export const isDragging = () => dragging;

/** Makes `source` draggable; `data` is read when the drag starts. */
export function draggable(source: HTMLElement, data: () => DragData | null) {
  source.addEventListener("pointerdown", (down) => {
    if (down.button !== 0 || (down.target as HTMLElement).closest("button.lib-act, input, a")) return;
    const startX = down.clientX;
    const startY = down.clientY;
    let session: ReturnType<typeof begin> | null = null;

    const move = (e: PointerEvent) => {
      if (!session) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
        const payload = data();
        if (!payload) return cleanup();
        session = begin(payload, source);
      }
      session.move(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => {
      cleanup();
      if (session) {
        session.end(e.clientX, e.clientY);
        // The click that follows a drag must not play or open the item under the pointer.
        const stop = (c: Event) => c.stopPropagation();
        window.addEventListener("click", stop, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", stop, true), 0);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !session) return;
      session.cancel();
      session = null;
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
  });
}

/** Registers a list (or a single card with `onto`) as a drop target; returns the unregister function. */
export function dropZone(zone: DropZone): () => void {
  zones.add(zone);
  return () => zones.delete(zone);
}

/** Convenience for a vertical list: rows are the list's children with the `data-row` attribute. */
export function dropList(
  el: HTMLElement,
  accepts: (data: DragData) => boolean,
  drop: (data: DragData, index: number) => void,
) {
  return dropZone({ el, rows: () => Array.from(el.querySelectorAll<HTMLElement>(":scope > [data-row]")), accepts, drop });
}

function zoneAt(x: number, y: number, data: DragData): DropZone | null {
  const under = document.elementsFromPoint(x, y);
  for (const el of under) {
    for (const zone of zones) {
      if (zone.el === el || zone.el.contains(el)) {
        if (zone.accepts(data)) return zone;
      }
    }
  }
  return null;
}

function insertionIndex(zone: DropZone, y: number): number {
  const rows = zone.rows();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return rows.length;
}

function begin(data: DragData, source: HTMLElement) {
  dragging = true;
  document.body.classList.add("lib-dragging");
  source.classList.add("lib-drag-source");
  const chip = h("div", { class: "lib-drag-chip" }, data.label);
  const line = h("div", { class: "lib-drop-line" });
  document.body.append(chip, line);
  let target: DropZone | null = null;
  let index = 0;

  const clearTarget = () => {
    target?.el.classList.remove("lib-drop-over");
    line.classList.remove("show");
  };

  const finish = () => {
    clearTarget();
    chip.remove();
    line.remove();
    source.classList.remove("lib-drag-source");
    document.body.classList.remove("lib-dragging");
    // Cleared after the click that ends the gesture has been swallowed.
    setTimeout(() => (dragging = false), 0);
  };

  return {
    move(x: number, y: number) {
      chip.style.transform = `translate(${x + 14}px, ${y + 12}px)`;
      const next = zoneAt(x, y, data);
      if (next !== target) {
        clearTarget();
        target = next;
        target?.el.classList.toggle("lib-drop-over", !!target?.onto);
      }
      if (!target) return;
      if (target.onto) return;
      index = insertionIndex(target, y);
      const rows = target.rows();
      const box = target.el.getBoundingClientRect();
      let top: number;
      if (rows.length === 0) top = box.top + 8;
      else if (index < rows.length) top = rows[index].getBoundingClientRect().top - 1;
      else top = rows[rows.length - 1].getBoundingClientRect().bottom + 1;
      const left = rows[0]?.getBoundingClientRect().left ?? box.left;
      const width = rows[0]?.getBoundingClientRect().width ?? box.width;
      line.style.cssText = `top:${top}px;left:${left + 6}px;width:${Math.max(0, width - 12)}px`;
      line.classList.add("show");
    },
    end(x: number, y: number) {
      const zone = zoneAt(x, y, data) ?? target;
      const at = target && zone === target && !target.onto ? index : zone ? insertionIndex(zone, y) : 0;
      finish();
      if (zone) zone.drop(data, at);
    },
    cancel: finish,
  };
}
