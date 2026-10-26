import { notesApi, orderOf, positionBetween, type Note } from "../../notes/api";
import { h } from "../../ui/dom";
import { CardDrag } from "./drag";

/** Cards are at least this wide; the columns share what's left. */
const MIN_WIDTH = 232;
const GAP = 16;
/** While dragging, the shadow moves at most this often, so cards of different heights don't flip back and forth. */
const SWAP_EVERY_MS = 180;

interface Placed {
  el: HTMLElement;
  note: Note;
  column: number;
}

/**
 * The notes as a masonry board: columns of cards, each as tall as its note, every card in the
 * shortest column so there are no gaps. Cards are kept, not rebuilt: a changed note's card is
 * swapped in place and keeps its column (typing in a note only moves the cards under it), and
 * only a newly added card fades in. Everything is laid out afresh when notes come or go, or the
 * width changes.
 *
 * Drag a card to move it among the others: a shadow card shows where it will land, and the rest
 * slide aside. Pinned notes stay before the others.
 */
export class Board {
  readonly el = h("div", { class: "nm-board", role: "list" });
  readonly drag: CardDrag;
  private cards = new Map<string, Placed>();
  private order: string[] = [];
  private columns = 0;
  private width = 0;
  private drawn = false;
  // While a card is dragged: which, the order before, the card last swapped with, and notes that
  // arrived meanwhile (shown when the drag ends).
  private dragged: string | null = null;
  private orderBefore: string[] = [];
  private lastTarget: string | null = null;
  private lastSwap = 0;
  private pending: Note[] | null = null;

  constructor(private readonly makeCard: (note: Note) => HTMLElement) {
    new ResizeObserver(() => {
      if (this.el.clientWidth !== this.width) this.layout(false);
    }).observe(this.el);
    this.drag = new CardDrag(this.el, {
      start: (card) => this.startDrag(card),
      move: (x, y) => this.dragOver(x, y),
      end: (drop) => this.endDrag(drop),
      scrollers: () => {
        const scroll = this.el.closest(".nm-scroll") as HTMLElement | null;
        return scroll ? [{ el: scroll, axis: "y" }] : [];
      },
    });
  }

  /** Shows these notes, in this order. */
  show(notes: Note[]) {
    if (this.dragged) {
      this.pending = notes;
      return;
    }
    const showing = new Set(notes.map((n) => n.id));
    for (const [id, placed] of this.cards) {
      if (showing.has(id)) continue;
      placed.el.remove();
      this.cards.delete(id);
    }
    for (const note of notes) {
      const placed = this.cards.get(note.id);
      // A note that changed is a new object, so its card is rebuilt, in the same place.
      if (placed && placed.note === note) continue;
      const el = this.makeCard(note);
      if (placed) {
        const focused = placed.el.contains(document.activeElement);
        el.style.cssText = placed.el.style.cssText;
        placed.el.replaceWith(el);
        if (focused) el.focus();
      } else {
        // In reading order, for the keyboard and screen readers; where it shows is set below.
        this.el.append(el);
        if (this.drawn) {
          el.classList.add("entering");
          el.addEventListener("animationend", () => el.classList.remove("entering"), { once: true });
        }
      }
      this.cards.set(note.id, { el, note, column: placed?.column ?? -1 });
    }
    const order = notes.map((n) => n.id);
    const reordered = order.join() !== this.order.join();
    this.order = order;
    if (reordered) for (const id of order) this.el.append(this.cards.get(id)!.el);
    this.layout(reordered);
    this.drawn = true;
  }

  /** Places the cards: afresh (`full`), or keeping each card's column. */
  private layout(full: boolean) {
    const width = this.el.clientWidth;
    if (!width) return;
    this.width = width;
    const columns = Math.max(1, Math.floor((width + GAP) / (MIN_WIDTH + GAP)));
    const columnWidth = (width - GAP * (columns - 1)) / columns;
    if (columns !== this.columns) full = true;
    this.columns = columns;
    const cards = this.order.map((id) => this.cards.get(id)!);
    // Writes, then reads, then writes: one layout pass however many cards there are.
    for (const card of cards) card.el.style.width = `${columnWidth}px`;
    const heights = cards.map((card) => card.el.offsetHeight);
    const overflowing = cards.map((card) => {
      const text = card.el.querySelector<HTMLElement>(".nm-card-text");
      return !!text && text.scrollHeight > text.clientHeight + 1;
    });
    const tops = new Array<number>(columns).fill(0);
    cards.forEach((card, i) => {
      if (full || card.column < 0 || card.column >= columns) card.column = tops.indexOf(Math.min(...tops));
      card.el.style.transform = `translate3d(${card.column * (columnWidth + GAP)}px, ${tops[card.column]}px, 0)`;
      tops[card.column] += heights[i] + GAP;
      card.el.querySelector(".nm-card-text")?.classList.toggle("overflowing", overflowing[i]);
    });
    this.el.style.height = `${Math.max(0, Math.max(...tops) - GAP)}px`;
  }

  // ---- dragging

  private startDrag(card: HTMLElement): boolean {
    const id = card.dataset.id;
    const placed = id ? this.cards.get(id) : undefined;
    if (!id || !placed || placed.note.deleted) return false;
    this.dragged = id;
    this.orderBefore = [...this.order];
    this.lastTarget = null;
    this.el.classList.add("sorting");
    return true;
  }

  /** Over another card (well inside it): the shadow takes that card's place. */
  private dragOver(x: number, y: number) {
    const dragged = this.dragged ? this.cards.get(this.dragged) : undefined;
    const over = document.elementFromPoint(x, y)?.closest(".nm-card") as HTMLElement | null;
    const id = over?.dataset.id;
    if (!dragged || !id || id === this.dragged || !this.el.contains(over)) {
      this.lastTarget = null;
      return;
    }
    const target = this.cards.get(id);
    if (!target || id === this.lastTarget || target.note.pinned !== dragged.note.pinned) return;
    const rect = over.getBoundingClientRect();
    const inside = x > rect.left + rect.width * 0.15 && x < rect.right - rect.width * 0.15 && y > rect.top + Math.min(24, rect.height * 0.2) && y < rect.bottom - Math.min(24, rect.height * 0.2);
    if (!inside || performance.now() - this.lastSwap < SWAP_EVERY_MS) return;
    const from = this.order.indexOf(this.dragged!);
    const to = this.order.indexOf(id);
    this.order.splice(from, 1);
    this.order.splice(to, 0, this.dragged!);
    this.lastTarget = id;
    this.lastSwap = performance.now();
    this.layout(true);
  }

  private endDrag(drop: boolean) {
    const id = this.dragged!;
    this.dragged = null;
    this.el.classList.remove("sorting");
    if (!drop) {
      this.order = this.orderBefore;
      this.layout(true);
    } else if (this.order.join() !== this.orderBefore.join()) {
      // Its new place, between its neighbours (pinned and other notes keep to their own).
      const note = this.cards.get(id)!.note;
      const at = this.order.indexOf(id);
      const neighbour = (i: number) => {
        const other = this.cards.get(this.order[i])?.note;
        return other && other.pinned === note.pinned ? other : undefined;
      };
      const position = positionBetween(neighbour(at - 1), neighbour(at + 1), orderOf(note));
      void notesApi.update(id, { position }).catch((err) => console.warn("Could not move the note:", err));
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) this.show(pending);
  }
}
