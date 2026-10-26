/**
 * Dragging a note card, on the board and in the Kanban columns. The card lifts and follows the
 * pointer (a copy, moved on the GPU), and where it would land shows as a shadow card: the card's
 * own place, emptied and outlined, which the layout moves as the pointer goes. Near an edge the
 * view scrolls. Escape puts everything back.
 *
 * Pointer events rather than HTML drag and drop: a card's links and pictures would start the
 * webview's own drag, and the page wouldn't follow the pointer every frame.
 */

export interface DragLayout {
  /** A drag starts on `card`; false when it can't be dragged (a deleted note). */
  start(card: HTMLElement): boolean;
  /** The pointer is at `x`, `y` (client coordinates): move the shadow to where the card would land. */
  move(x: number, y: number): void;
  /** Dropped where the shadow is (`drop`), or put back. */
  end(drop: boolean): void;
  /** What scrolls while the pointer is near its edges, and which way. */
  scrollers(x: number, y: number): { el: HTMLElement; axis: "x" | "y" }[];
}

const THRESHOLD = 5;
const EDGE = 56;
const MAX_SPEED = 20;

export class CardDrag {
  private justEnded = false;

  constructor(root: HTMLElement, private readonly layout: DragLayout) {
    root.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement;
      const card = target.closest(".nm-card") as HTMLElement | null;
      if (e.button !== 0 || !card || !root.contains(card) || target.closest("button, input, textarea, select")) return;
      this.press(e, card);
    });
  }

  /** True just after a drag, so the click that ends it doesn't open the note. */
  get dragging() {
    return this.justEnded;
  }

  private press(down: PointerEvent, card: HTMLElement) {
    // No webview drag of a link or picture, and no text selection, from here on.
    down.preventDefault();
    let x = down.clientX;
    let y = down.clientY;
    let ghost: HTMLElement | null = null;
    let offsetX = 0;
    let offsetY = 0;
    let frame = 0;

    const tick = () => {
      frame = 0;
      if (!ghost) return;
      ghost.style.transform = `translate3d(${x - offsetX}px, ${y - offsetY}px, 0) rotate(1deg)`;
      let scrolled = false;
      for (const { el, axis } of this.layout.scrollers(x, y)) {
        const r = el.getBoundingClientRect();
        const [at, low, high] = axis === "x" ? [x, r.left, r.right] : [y, r.top, r.bottom];
        const speed = at < low + EDGE ? -MAX_SPEED * Math.min(1, (low + EDGE - at) / EDGE)
          : at > high - EDGE ? MAX_SPEED * Math.min(1, (at - high + EDGE) / EDGE) : 0;
        if (!speed) continue;
        const before = axis === "x" ? el.scrollLeft : el.scrollTop;
        if (axis === "x") el.scrollLeft += speed;
        else el.scrollTop += speed;
        scrolled ||= (axis === "x" ? el.scrollLeft : el.scrollTop) !== before;
      }
      this.layout.move(x, y);
      // Keep scrolling while the pointer rests near an edge.
      if (scrolled) frame = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!ghost) {
        if (Math.hypot(x - down.clientX, y - down.clientY) < THRESHOLD) return;
        if (!this.layout.start(card)) return end(false);
        const rect = card.getBoundingClientRect();
        offsetX = down.clientX - rect.left;
        offsetY = down.clientY - rect.top;
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.remove("entering");
        ghost.classList.add("nm-ghost");
        ghost.removeAttribute("tabindex");
        Object.assign(ghost.style, {
          left: "", top: "", width: `${rect.width}px`, height: `${rect.height}px`,
          transform: `translate3d(${x - offsetX}px, ${y - offsetY}px, 0) rotate(1deg)`,
        });
        document.body.append(ghost);
        document.body.classList.add("nm-dragging");
        card.classList.add("nm-shadow");
        try {
          card.setPointerCapture(down.pointerId);
        } catch {
          // The pointer already went; the window listeners still see it.
        }
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };

    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      cancelAnimationFrame(frame);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("nm-dragging");
      card.classList.remove("nm-shadow");
      this.layout.end(drop);
      this.justEnded = true;
      setTimeout(() => (this.justEnded = false), 0);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }
}
