import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import type { ControlBar } from "./controls";
import { CONTROL_DEFS, PALETTE_ORDER, sanitizeControls } from "./items";

export interface CustomizeOptions {
  /** Where the sheet goes (inside the module, so it also shows in fullscreen). */
  host: HTMLElement;
  bar: ControlBar;
  controls: string[];
  onSave(ids: string[]): void;
  /** The sheet went away, saved or not; put the real bar back. */
  onClose(): void;
}

export interface CustomizeHandle {
  close(): void;
}

/** Pixels the pointer may stray above or below the bar and still count as being over it. */
const BAR_SLACK = 28;
const DRAG_THRESHOLD = 4;

/**
 * The Customise Player sheet: a grid of available items above the live control bar, which shows
 * dashed slots. Drag (pointer events) to add, reorder or drop items off the bar to remove them.
 */
export function openCustomize(options: CustomizeOptions): CustomizeHandle {
  const { bar } = options;
  let draft = sanitizeControls(options.controls);
  const palette = h("div", { class: "vp-palette" });
  const save = h("button", { class: "btn primary", type: "button" }, "Save");
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
  const closeButton = h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close" }, icon("close", 16));
  const overlay = h("div", { class: "modal-overlay vp-custom" },
    h("div", { class: "modal vp-custom-sheet", role: "dialog", "aria-label": "Customize Player" },
      h("div", { class: "modal-head" }, h("h2", null, "Customize Player"), closeButton),
      h("div", { class: "modal-body" },
        h("p", { class: "vp-custom-hint" }, "Drag items into the bar below to add them or re-order them. Drag items off the bar to remove them."),
        palette),
      h("div", { class: "modal-foot" }, h("span", { class: "vp-custom-grow" }), cancel, save)));

  const refresh = () => {
    bar.render(draft, true);
    palette.replaceChildren(...PALETTE_ORDER
      .filter((id) => CONTROL_DEFS[id].repeatable || !draft.includes(id))
      .map((id) => tile(id)));
  };

  const tile = (id: string) => {
    const def = CONTROL_DEFS[id];
    const el = h("div", { class: "vp-tile", "data-id": id, title: `${def.label} (drag to the bar, or click)` },
      h("span", { class: "vp-tile-icon" }, def.icon(20)), h("span", { class: "vp-tile-label" }, def.label));
    el.addEventListener("pointerdown", (e) => startDrag(e, id, -1));
    return el;
  };

  // ---- dragging ----------------------------------------------------------------------------

  const clearMarks = () => {
    for (const slot of bar.slots()) slot.classList.remove("drop-before", "dragging");
    bar.el.classList.remove("drop-end");
  };

  /** Where a drop at pointer X lands in the list that remains once `skip` is lifted out. */
  const insertionIndex = (x: number, skip: number) => {
    let index = 0;
    bar.slots().forEach((slot, i) => {
      if (i === skip) return;
      const r = slot.getBoundingClientRect();
      if (x > r.left + r.width / 2) index++;
    });
    return index;
  };

  const overBar = (x: number, y: number) => {
    const r = bar.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top - BAR_SLACK && y <= r.bottom + BAR_SLACK;
  };

  function startDrag(down: PointerEvent, id: string, from: number) {
    if (down.button !== 0) return;
    down.preventDefault();
    const def = CONTROL_DEFS[id];
    const ghost = h("div", { class: "vp-ghost" }, def.icon(18), h("span", null, def.label));
    let dragging = false;
    let target: number | null = null;

    const place = (e: PointerEvent) => {
      ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
    };
    const move = (e: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < DRAG_THRESHOLD) return;
        dragging = true;
        overlay.classList.add("dragging");
        document.body.append(ghost);
        if (from >= 0) bar.slots()[from]?.classList.add("dragging");
      }
      place(e);
      clearMarks();
      if (from >= 0) bar.slots()[from]?.classList.add("dragging");
      const inside = overBar(e.clientX, e.clientY);
      ghost.classList.toggle("remove", from >= 0 && !inside);
      target = inside ? insertionIndex(e.clientX, from) : null;
      if (target !== null) {
        const rest = bar.slots().filter((_, i) => i !== from);
        if (target < rest.length) rest[target].classList.add("drop-before");
        else bar.el.classList.add("drop-end");
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      ghost.remove();
      overlay.classList.remove("dragging");
      clearMarks();
      if (!dragging) {
        // A plain click on a grid tile adds it at the end.
        if (from < 0) draft = [...draft, id];
      } else {
        const list = from >= 0 ? draft.filter((_, i) => i !== from) : [...draft];
        if (target !== null) list.splice(target, 0, id);
        else if (from < 0) return;
        draft = list;
      }
      refresh();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // Slots in the bar are rebuilt on every change, so listen on the bar itself.
  const onBarDown = (e: PointerEvent) => {
    const slot = (e.target as HTMLElement).closest<HTMLElement>(".vc-slot");
    if (!slot) return;
    startDrag(e, slot.dataset.id ?? "", Number(slot.dataset.index));
  };
  bar.el.addEventListener("pointerdown", onBarDown);

  // ---- closing -----------------------------------------------------------------------------

  const close = () => {
    bar.el.removeEventListener("pointerdown", onBarDown);
    overlay.remove();
    options.onClose();
  };
  cancel.addEventListener("click", close);
  closeButton.addEventListener("click", close);
  save.addEventListener("click", () => {
    options.onSave(draft);
    close();
  });

  options.host.append(overlay);
  refresh();
  return { close };
}
