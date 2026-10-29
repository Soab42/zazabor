import { h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import { display, dragValue, fraction, parse, stepBy, type NumberSpec } from "./scrub";

/**
 * The Video Editor's panel controls, built once and used by the inspector, the template views and
 * the left panel: collapsible sections, rows on one grid (label · control · value · actions), scrub
 * number fields, sliders with a value field, colour wells, segmented controls, selects, switches,
 * tabs, callouts and empty states. See docs/plans/video-editor-ui.md §5.
 *
 * Every control that shows project values pushes a sync onto `Syncs`: the inspector runs them
 * when the project changes or the playhead moves, and they leave a control being edited alone.
 */

export type Syncs = (() => void)[];
type Child = Node | null | false | undefined;
const kids = (list: Child[]) => list.filter((n): n is Node => !!n);

// ---- remembered state: which sections are open, which tab shows

export interface Prefs {
  open(id: string): boolean | undefined;
  setOpen(id: string, open: boolean): void;
  tab(kind: string): string | undefined;
  setTab(kind: string, tab: string): void;
}

let prefs: Prefs = (() => {
  const open = new Map<string, boolean>(), tabs = new Map<string, string>();
  return {
    open: (id) => open.get(id),
    setOpen: (id, v) => void open.set(id, v),
    tab: (kind) => tabs.get(kind),
    setTab: (kind, t) => void tabs.set(kind, t),
  };
})();

/** The editor's settings take over remembering sections and tabs. */
export function usePrefs(p: Prefs) {
  prefs = p;
}

export const getPrefs = () => prefs;

// ---- small pieces

/** A 20 px icon button for headers and rows. */
export function mini(name: IconName, title: string, run: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  return h("button", {
    class: `vc-mini${cls ? ` ${cls}` : ""}`, type: "button", title, "aria-label": title,
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      run(e);
    },
  }, icon(name, 13));
}

/**
 * A row of filter chips that scrolls sideways when they don't fit: with the mouse wheel (up and
 * down move it along, until an end, where the panel scrolls as usual), a trackpad, or the arrows
 * that show on hover at a side with more chips. A chip that's clicked comes fully into view.
 */
export function chipRow(attrs: Record<string, string>, chips: HTMLElement[]): HTMLElement {
  const row = h("div", { ...attrs, class: "vc-chips" }, ...chips);
  const by = (dir: number) => row.scrollBy({ left: dir * row.clientWidth * 0.7, behavior: "smooth" });
  const wrap = h("div", { class: "vc-chips-wrap" }, row,
    mini("chevronLeft", "More on the left", () => by(-1), "vc-chips-arrow left"),
    mini("chevronRight", "More on the right", () => by(1), "vc-chips-arrow right"));
  const sync = () => {
    const max = row.scrollWidth - row.clientWidth;
    wrap.classList.toggle("more-left", row.scrollLeft > 1);
    wrap.classList.toggle("more-right", row.scrollLeft < max - 1);
  };
  /** Scrolls `chip` fully into the row's view (keeping a little of the next one in sight). */
  const reveal = (chip: HTMLElement, smooth: boolean) => {
    const left = chip.offsetLeft - 24;
    const right = chip.offsetLeft + chip.offsetWidth + 24 - row.clientWidth;
    const to = left < row.scrollLeft ? left : right > row.scrollLeft ? right : null;
    if (to !== null) row.scrollTo({ left: to, behavior: smooth ? "smooth" : "auto" });
  };
  row.addEventListener("scroll", sync, { passive: true });
  // The panel can be resized while it's out of sight: check again when the pointer comes in.
  wrap.addEventListener("pointerenter", sync);
  row.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    const max = row.scrollWidth - row.clientWidth;
    if (max <= 0 || (delta < 0 && row.scrollLeft <= 0) || (delta > 0 && row.scrollLeft >= max - 1)) return;
    e.preventDefault();
    row.scrollLeft += delta;
  }, { passive: false });
  row.addEventListener("click", (e) => {
    const chip = (e.target as Element).closest?.<HTMLElement>(".vc-chip");
    if (chip) reveal(chip, true);
  });
  requestAnimationFrame(() => {
    const active = row.querySelector<HTMLElement>(".vc-chip.active");
    if (active) reveal(active, false);
    sync();
  });
  return wrap;
}

/** Opens `items` under `anchor` (a ⋯ button). */
export function menuAt(anchor: HTMLElement, items: MenuItem[]) {
  const r = anchor.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
}

export const note = (text: string, cls = "") => h("p", { class: `vc-note${cls ? ` ${cls}` : ""}` }, text);

let closePop: (() => void) | null = null;

/** A small glass popover under `anchor` (a panel's options); closes on Esc or a click outside. */
export function popover(anchor: HTMLElement, title: string, ...content: Child[]): () => void {
  closePop?.();
  const el = h("div", { class: "vc-pop glass-strong tone-video", role: "dialog", "aria-label": title }, h("div", { class: "vc-pop-title" }, title), ...kids(content));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  el.style.top = `${Math.min(window.innerHeight - el.offsetHeight - 8, r.bottom + 6)}px`;
  anchor.setAttribute("aria-expanded", "true");
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
    anchor.focus();
  };
  const close = () => {
    el.remove();
    anchor.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
    if (closePop === close) closePop = null;
  };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  closePop = close;
  (el.querySelector("select, input, button") as HTMLElement | null)?.focus();
  return close;
}

/** A search field in the app's look (`.search`), filtering as you type; Esc clears it, then leaves it. */
export function searchField(placeholder: string, value: string, set: (v: string) => void): HTMLElement {
  const input = h("input", { type: "text", class: "search-input", placeholder, value, spellcheck: "false", "aria-label": placeholder });
  input.addEventListener("input", () => set(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (input.value) {
      input.value = "";
      set("");
    } else input.blur();
  });
  return h("label", { class: "search vc-search" }, icon("search", 14), input);
}

/** One line of help, a warning or an error, with an optional action. */
export function callout(text: string, tone: "info" | "warn" | "danger" = "info", action?: [string, () => void]): HTMLElement {
  const name: IconName = tone === "info" ? "info" : "stAlert";
  return h("div", { class: `vc-callout ${tone}`, role: tone === "info" ? "note" : "alert" },
    icon(name, 14),
    h("span", { class: "vc-callout-text" }, text),
    action ? h("button", { class: "btn small", type: "button", onclick: action[1] }, action[0]) : null);
}

/** An empty pane: an icon in a tinted circle, a title, a sentence and one action. */
export function empty(name: IconName, title: string, text: string, ...actions: (HTMLElement | null)[]): HTMLElement {
  return h("div", { class: "vc-empty" },
    h("div", { class: "vc-empty-icon" }, icon(name, 22)),
    h("div", { class: "vc-empty-title" }, title),
    h("p", { class: "vc-empty-text" }, text),
    actions.some(Boolean) ? h("div", { class: "vc-empty-actions" }, ...actions) : null);
}

/** The inspector's header: what's selected, a line about it, and its ⋯ menu. */
export function head(o: { icon: IconName; title: string; meta?: string; tip?: string; menu?: () => MenuItem[] }): HTMLElement {
  const more = o.menu ? mini("more", "More", (e) => menuAt(e.currentTarget as HTMLElement, o.menu!())) : null;
  return h("header", { class: "vc-head" },
    h("span", { class: "vc-head-icon", title: o.tip ?? "" }, icon(o.icon, 16)),
    h("div", { class: "vc-head-text" },
      h("div", { class: "vc-head-title", title: o.tip ?? o.title }, o.title),
      o.meta ? h("div", { class: "vc-head-meta" }, o.meta) : null),
    more);
}

// ---- keyframes and reset, in a row's actions

export interface Keyed {
  /** The property has keyframes somewhere. */
  has(): boolean;
  /** One is at the playhead. */
  on(): boolean;
  toggle(): void;
  /** Its right-click menu (ease, previous, next, remove all). */
  menu?(): MenuItem[];
}

export interface Defaulted {
  modified(): boolean;
  reset(): void;
}

export function keyButton(syncs: Syncs, label: string, k: Keyed): HTMLButtonElement {
  const b = h("button", {
    class: "vc-key", type: "button", "aria-label": `Keyframe ${label}`,
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      k.toggle();
    },
    oncontextmenu: (e: MouseEvent) => {
      if (!k.menu) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY, k.menu());
    },
  }, icon("veKey", 11));
  const sync = () => {
    const on = k.on(), has = k.has();
    b.classList.toggle("on", on);
    b.classList.toggle("has", has);
    b.title = on ? `Remove the ${label} keyframe at the playhead (Alt+K)` : `Add a ${label} keyframe at the playhead (Alt+K)`;
  };
  syncs.push(sync);
  sync();
  return b;
}

export function resetButton(syncs: Syncs, label: string, d: Defaulted): HTMLButtonElement {
  const b = mini("undo", `Reset ${label}`, () => d.reset(), "vc-reset");
  const sync = () => b.classList.toggle("shown", d.modified());
  syncs.push(sync);
  sync();
  return b;
}

/** The trailing actions of a row: keyframe diamond, then reset (each slot kept, so columns line up). */
export function actions(syncs: Syncs, label: string, keyed?: Keyed | null, def?: Defaulted | null): HTMLElement {
  return h("span", { class: "vc-acts" },
    keyed ? keyButton(syncs, label, keyed) : h("span", { class: "vc-slot" }),
    def ? resetButton(syncs, label, def) : h("span", { class: "vc-slot" }));
}

// ---- rows

/**
 * A row on the panel grid: label | control | value | actions. Without a value the control takes
 * both middle columns; the actions slot is always there.
 */
export function row(label: string | null, control: Child | Child[], o: { value?: Child; acts?: Child; cls?: string; title?: string } = {}): HTMLElement {
  const controls = kids(Array.isArray(control) ? control : [control]);
  const hasValue = o.value !== undefined;
  return h("div", { class: `vc-row${o.cls ? ` ${o.cls}` : ""}`, title: o.title ?? null },
    h("span", { class: "vc-label", title: label ?? "" }, label ?? ""),
    h("div", { class: `vc-ctl${hasValue ? "" : " wide"}` }, ...controls),
    hasValue ? h("div", { class: "vc-val" }, ...kids([o.value])) : null,
    o.acts ? o.acts : h("span", { class: "vc-acts" }));
}

/** Hides a row (or anything) while `when()` is false. */
export function showWhen<T extends HTMLElement>(syncs: Syncs, el: T, when: () => boolean): T {
  const sync = () => (el.hidden = !when());
  syncs.push(sync);
  sync();
  return el;
}

// ---- number fields

export interface ScrubOpts extends NumberSpec {
  label: string;
  get(): number;
  set(v: number): void;
  /** "X", "Y", "W", "H": drawn inside the field. */
  prefix?: string;
  mixed?(): boolean;
  /** The property is animated: the number shows in the keyframe gold. */
  animated?(): boolean;
  disabled?(): boolean;
}

/**
 * A number you drag sideways, type into, or step with ↑/↓ (Shift ×10, Alt ×0.1). At rest it's a
 * read-only input marked `data-scrub`, so the editor's keys still work while it has focus.
 */
export function scrub(syncs: Syncs, o: ScrubOpts): HTMLElement {
  const input = h("input", {
    type: "text", class: "vc-scrub-input", readonly: true, spellcheck: "false", autocomplete: "off",
    inputmode: "decimal", role: "spinbutton", "aria-label": o.label,
    "aria-valuemin": String(o.min), "aria-valuemax": String(o.max),
  });
  input.dataset.scrub = "";
  const wrap = h("span", { class: "vc-scrub" }, o.prefix ? h("span", { class: "vc-scrub-prefix" }, o.prefix) : null, input);
  let editing = false;
  const show = () => {
    const off = !!o.disabled?.();
    wrap.classList.toggle("disabled", off);
    input.disabled = off;
    if (editing) return;
    const mixed = !!o.mixed?.();
    const v = o.get();
    input.value = mixed ? "—" : display(o, v);
    input.setAttribute("aria-valuenow", String(v));
    wrap.classList.toggle("animated", !mixed && !!o.animated?.());
  };
  const flash = () => {
    wrap.classList.remove("invalid");
    void wrap.offsetWidth;
    wrap.classList.add("invalid");
    setTimeout(() => wrap.classList.remove("invalid"), 320);
  };
  const startEdit = () => {
    if (editing) return;
    editing = true;
    input.readOnly = false;
    wrap.classList.add("editing");
    if (!o.mixed?.()) input.value = display(o, o.get()).replace(/\s?[^0-9.+\-−]+$/, "");
    input.focus();
    input.select();
  };
  const endEdit = (commit: boolean) => {
    if (!editing) return;
    if (commit) {
      const v = parse(o, input.value);
      if (v === null) {
        if (input.value.trim() && input.value !== "—") flash();
      } else if (v !== o.get() || o.mixed?.()) o.set(v);
    }
    editing = false;
    input.readOnly = true;
    wrap.classList.remove("editing");
    show();
  };
  input.addEventListener("pointerdown", (e) => {
    if (editing || e.button !== 0 || input.disabled) return;
    e.preventDefault();
    input.focus({ preventScroll: true });
    const x0 = e.clientX;
    const v0 = o.get();
    let moved = false;
    input.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) {
        moved = true;
        wrap.classList.add("dragging");
        document.body.classList.add("vc-scrubbing");
      }
      const v = dragValue(o, v0, dx, ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
      if (v !== o.get()) o.set(v);
      input.value = display(o, v);
    };
    const up = () => {
      input.removeEventListener("pointermove", move);
      input.removeEventListener("pointerup", up);
      input.removeEventListener("pointercancel", up);
      wrap.classList.remove("dragging");
      document.body.classList.remove("vc-scrubbing");
      if (moved) show();
      else startEdit();
    };
    input.addEventListener("pointermove", move);
    input.addEventListener("pointerup", up);
    input.addEventListener("pointercancel", up);
  });
  input.addEventListener("keydown", (e) => {
    if (editing) {
      if (e.key === "Enter") {
        e.preventDefault();
        endEdit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        endEdit(false);
      }
      // Typing stays in the field.
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const factor = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    let steps = 0;
    if (e.key === "ArrowUp") steps = 1;
    else if (e.key === "ArrowDown") steps = -1;
    else if (e.key === "PageUp") steps = 10;
    else if (e.key === "PageDown") steps = -10;
    else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      e.stopPropagation();
      startEdit();
      return;
    } else if (/^[0-9.,\-−]$/.test(e.key)) {
      // Typing a number starts editing; the key replaces the selected value.
      startEdit();
      e.stopPropagation();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    const v = stepBy(o, o.get(), steps, factor);
    if (v !== o.get()) o.set(v);
    show();
  });
  input.addEventListener("blur", () => endEdit(true));
  syncs.push(show);
  show();
  return wrap;
}

export interface SliderOpts extends NumberSpec {
  label: string;
  get(): number;
  set(v: number): void;
  /** Fills from the centre (−100 … +100 values). */
  bipolar?: boolean;
  /** Double-clicking the track goes back to it. */
  default?: number;
  mixed?(): boolean;
  disabled?(): boolean;
}

/** A slider whose track fills to the value (from the centre when bipolar). */
export function slider(syncs: Syncs, o: SliderOpts): HTMLInputElement {
  const el = h("input", {
    type: "range", class: "vc-range", min: String(o.min), max: String(o.max), step: String(o.step), "aria-label": o.label,
    oninput: () => {
      o.set(Number(el.value));
      paint(Number(el.value));
    },
    ondblclick: () => {
      if (o.default !== undefined) o.set(o.default);
    },
  });
  const paint = (v: number) => {
    const at = fraction(o, v) * 100;
    const centre = o.bipolar ? fraction(o, Math.min(o.max, Math.max(o.min, 0))) * 100 : 0;
    el.style.setProperty("--a", `${Math.min(at, centre)}%`);
    el.style.setProperty("--b", `${Math.max(at, centre)}%`);
  };
  if (o.bipolar) el.classList.add("bipolar");
  const sync = () => {
    const off = !!o.disabled?.();
    el.disabled = off;
    const mixed = !!o.mixed?.();
    el.classList.toggle("mixed", mixed);
    const v = o.get();
    if (document.activeElement !== el || !el.matches(":active")) el.value = String(v);
    paint(mixed ? o.min : Number(el.value));
  };
  syncs.push(sync);
  sync();
  return el;
}

export interface NumberRowOpts extends SliderOpts {
  keyed?: Keyed | null;
  def?: Defaulted | null;
  animated?(): boolean;
}

/** label | slider | value field | ◇ ↺ */
export function sliderRow(syncs: Syncs, label: string, o: Omit<NumberRowOpts, "label">): HTMLElement {
  return row(label, slider(syncs, { ...o, label }), {
    value: scrub(syncs, { ...o, label }),
    acts: actions(syncs, label, o.keyed, o.def),
  });
}

/** label | value field | ◇ ↺ (a duration, a length). */
export function scrubRow(syncs: Syncs, label: string, o: Omit<ScrubOpts, "label"> & { keyed?: Keyed | null; def?: Defaulted | null }): HTMLElement {
  return row(label, scrub(syncs, { ...o, label }), { acts: actions(syncs, label, o.keyed, o.def), cls: "vc-scrub-row" });
}

/** label | X field  Y field | ◇ ↺ */
export function pairRow(syncs: Syncs, label: string, a: ScrubOpts, b: ScrubOpts, keyed?: Keyed | null, def?: Defaulted | null): HTMLElement {
  return row(label, h("div", { class: "vc-pair" }, scrub(syncs, a), scrub(syncs, b)), { acts: actions(syncs, label, keyed, def) });
}

// ---- choices

export type SegItem<V extends string> = readonly [V, string] | readonly [V, string, IconName];

/** A segmented control; items with an icon show only it (the text becomes its tooltip). */
export function seg<V extends string>(syncs: Syncs, label: string, items: readonly SegItem<V>[], get: () => V | null, set: (v: V) => void, cls = ""): HTMLElement {
  const buttons = items.map((item) => {
    const [v, text] = item;
    const ic = item[2] as IconName | undefined;
    return h("button", {
      type: "button", role: "radio", title: ic ? text : null, "aria-label": text, tabindex: "-1",
      class: ic ? "icon" : "",
      onclick: () => {
        set(v);
        paint();
      },
    }, ic ? icon(ic, 14) : text);
  });
  const el = h("div", { class: `segmented vc-seg${cls ? ` ${cls}` : ""}`, role: "radiogroup", "aria-label": label }, ...buttons);
  const paint = () => {
    const now = get();
    let any = false;
    buttons.forEach((b, i) => {
      const on = items[i][0] === now;
      any ||= on;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (!any && buttons[0]) buttons[0].tabIndex = 0;
  };
  el.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const n = buttons.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (Math.max(0, i) + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    buttons[next].focus();
    buttons[next].click();
  });
  syncs.push(paint);
  paint();
  return el;
}

export function segRow<V extends string>(syncs: Syncs, label: string, items: readonly SegItem<V>[], get: () => V | null, set: (v: V) => void, acts?: Child): HTMLElement {
  return row(label, seg(syncs, label, items, get, set), { acts });
}

export function select<V extends string>(syncs: Syncs, label: string, options: readonly (readonly [V, string])[], get: () => V, set: (v: V) => void): HTMLSelectElement {
  const el = h("select", { class: "vc-select", "aria-label": label, onchange: () => set(el.value as V) },
    ...options.map(([v, text]) => h("option", { value: v }, text)));
  const sync = () => {
    if (document.activeElement !== el) el.value = get();
  };
  syncs.push(sync);
  sync();
  return el;
}

export function selectRow<V extends string>(syncs: Syncs, label: string, options: readonly (readonly [V, string])[], get: () => V, set: (v: V) => void, o: { value?: Child; acts?: Child } = {}): HTMLElement {
  return row(label, select(syncs, label, options, get, set), o);
}

export function switchEl(syncs: Syncs, label: string, get: () => boolean, set: (v: boolean) => void): HTMLInputElement {
  const el = h("input", { type: "checkbox", class: "switch vc-sm", role: "switch", "aria-label": label, onchange: () => set(el.checked) });
  const sync = () => (el.checked = get());
  syncs.push(sync);
  sync();
  return el;
}

export function switchRow(syncs: Syncs, label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  return row(label, h("div", { class: "vc-end" }, switchEl(syncs, label, get, set)));
}

/** A pressed / not pressed button: B and I, or an icon. */
export function toggle(syncs: Syncs, label: string, face: string | IconName, get: () => boolean, set: (v: boolean) => void, cls = ""): HTMLButtonElement {
  const isIcon = !/^[A-Z]$/.test(face);
  const b = h("button", {
    type: "button", class: `vc-tog${cls ? ` ${cls}` : ""}`, title: label, "aria-label": label,
    onclick: () => set(!get()),
  }, isIcon ? icon(face as IconName, 14) : face);
  const sync = () => {
    const on = get();
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  };
  syncs.push(sync);
  sync();
  return b;
}

// ---- colours

export function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return "#000000";
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}

export interface ColorOpts {
  get(): string | null;
  /** null turns an optional colour off. */
  set(v: string | null): void;
  /** Has an on/off checkbox (Outline, Background). */
  optional?: boolean;
  /** The colour shown while off, and the one turned on with. */
  fallback: string;
  eyedropper?: () => void;
  def?: Defaulted | null;
  /** Changed by hand (a template's Brand Kit colour). */
  changed?(): boolean;
}

/** A colour well (the system picker under a swatch), with its hex. */
export function well(syncs: Syncs, label: string, o: Pick<ColorOpts, "get" | "set" | "fallback" | "changed">): HTMLElement {
  let last = toHex(o.get() ?? o.fallback);
  const fill = h("span", { class: "vc-well-fill" });
  const input = h("input", { type: "color", class: "vc-well-input", "aria-label": label, oninput: () => o.set(input.value) });
  const dot = o.changed ? h("span", { class: "vc-well-dot", title: "Changed by hand" }) : null;
  const el = h("label", { class: "vc-well", title: label }, fill, input, dot);
  const sync = () => {
    const v = o.get();
    if (v) last = toHex(v);
    fill.style.background = v ?? last;
    el.classList.toggle("off", v === null);
    if (document.activeElement !== input) input.value = last;
    if (dot) dot.hidden = !o.changed!();
  };
  syncs.push(sync);
  sync();
  return el;
}

export function colorRow(syncs: Syncs, label: string, o: ColorOpts): HTMLElement {
  let last = toHex(o.get() ?? o.fallback);
  const check = o.optional ? h("input", {
    type: "checkbox", class: "vc-check", "aria-label": `${label} on`,
    onchange: () => o.set(check!.checked ? last : null),
  }) : null;
  const hex = h("span", { class: "vc-hex" });
  const w = well(syncs, label, { get: o.get, set: (v) => o.set(v), fallback: o.fallback });
  const sync = () => {
    const v = o.get();
    if (v) last = toHex(v);
    if (check) check.checked = v !== null;
    hex.textContent = (v ? toHex(v) : last).toUpperCase();
    hex.classList.toggle("off", v === null);
  };
  syncs.push(sync);
  sync();
  return row(label, [check, w, o.eyedropper ? mini("phEyedropper", "Pick it from the preview", o.eyedropper) : null], {
    value: hex,
    acts: actions(syncs, label, null, o.def),
    cls: "vc-color-row",
  });
}

// ---- text

/** A text area that grows with its text (2 to `max` lines). */
export function area(syncs: Syncs, o: { label: string; get(): string; set(v: string): void; placeholder?: string; max?: number; cls?: string }): HTMLTextAreaElement {
  const el = h("textarea", { class: `vc-area${o.cls ? ` ${o.cls}` : ""}`, rows: 2, spellcheck: "true", "aria-label": o.label, placeholder: o.placeholder ?? "" });
  el.value = o.get();
  const grow = () => {
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const max = line * (o.max ?? 6) + 12;
    if (el.scrollHeight) el.style.height = `${Math.min(max, el.scrollHeight + 1)}px`;
  };
  el.addEventListener("input", () => {
    o.set(el.value);
    grow();
  });
  el.addEventListener("focus", grow);
  syncs.push(() => {
    if (document.activeElement !== el) el.value = o.get();
    grow();
  });
  requestAnimationFrame(grow);
  return el;
}

/** A template's text field: its label and a count against its limit above, then the field. */
export function textField(syncs: Syncs, label: string, o: { get(): string; set(v: string): void; limit?: number; multiline?: boolean; placeholder?: string }): HTMLElement {
  const input: HTMLInputElement | HTMLTextAreaElement = o.multiline
    ? area(syncs, { label, get: o.get, set: o.set, placeholder: o.placeholder, max: 5, cls: "mo-text" })
    : h("input", { type: "text", class: "vc-field mo-text", spellcheck: "true", placeholder: o.placeholder ?? "", "aria-label": label });
  if (input instanceof HTMLInputElement) input.value = o.get();
  const count = h("span", { class: "vc-count" });
  const counted = () => {
    const n = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input.value)].length;
    count.textContent = o.limit ? `${n}/${o.limit}` : "";
    count.classList.toggle("over", !!o.limit && n > o.limit);
  };
  counted();
  input.addEventListener("input", () => {
    if (input instanceof HTMLInputElement) o.set(input.value);
    counted();
  });
  syncs.push(() => {
    if (document.activeElement === input) return;
    if (input instanceof HTMLInputElement) input.value = o.get();
    counted();
  });
  return h("div", { class: "vc-field-block" }, h("div", { class: "vc-field-head" }, h("span", null, label), count), input);
}

/** A row of small buttons. */
export function buttons(...items: ([string, () => void, boolean?] | null | false)[]): HTMLElement {
  return h("div", { class: "vc-buttons" }, ...items.filter((x): x is [string, () => void, boolean?] => !!x)
    .map(([text, run, disabled]) => h("button", { class: "btn small", type: "button", disabled: !!disabled, onclick: run }, text)));
}

// ---- sections

export interface SectionOpts {
  /** Remembered open or closed under this id ("video:transform"). */
  id: string;
  title: string;
  /** Open when nothing is remembered (default true). */
  open?: boolean | (() => boolean);
  /** Shown while collapsed ("Circle", "Dissolve · 0.6 s"). */
  summary?(): string;
  /** An optional effect: a switch in the header turns it on and off. */
  enable?: { get(): boolean; set(v: boolean): void };
  /** A dot after the title, and the header reset. */
  modified?(): boolean;
  reset?(): void;
  /** ‹ › in the header while the section's properties have keyframes. */
  keys?: { any(): boolean; prev(): void; next(): void };
  menu?(): MenuItem[];
  tip?: string;
}

const opener = new WeakMap<HTMLElement, () => void>();

/** Opens a section (`Inspector.reveal`). */
export function openSection(el: HTMLElement) {
  opener.get(el)?.();
}

export function section(syncs: Syncs, o: SectionOpts, ...rows: Child[]): HTMLElement {
  const remembered = prefs.open(o.id);
  let open = remembered ?? (typeof o.open === "function" ? o.open() : o.open ?? true);
  const enabled = () => !o.enable || o.enable.get();
  const chevron = h("span", { class: "vc-chev" }, icon("chevronRight", 12));
  const dot = h("span", { class: "vc-dot", title: "Changed" });
  const toggleBtn = h("button", {
    class: "vc-sec-toggle", type: "button", title: o.tip ?? null,
    onclick: () => {
      if (!enabled()) {
        // Clicking an effect that's off turns it on.
        prefs.setOpen(o.id, true);
        o.enable!.set(true);
        return;
      }
      open = !open;
      prefs.setOpen(o.id, open);
      apply();
    },
  }, chevron, h("span", { class: "vc-sec-title" }, o.title), dot);
  const summary = h("span", { class: "vc-sec-summary" });
  const prev = o.keys ? mini("chevronLeft", "Previous keyframe", () => o.keys!.prev(), "vc-nav") : null;
  const next = o.keys ? mini("chevronRight", "Next keyframe", () => o.keys!.next(), "vc-nav") : null;
  const reset = o.reset ? mini("undo", `Reset ${o.title}`, () => o.reset!(), "vc-reset") : null;
  const sw = o.enable ? h("input", {
    type: "checkbox", class: "switch vc-sm", role: "switch", "aria-label": `${o.title} on`,
    onchange: () => {
      if (sw!.checked) prefs.setOpen(o.id, true);
      o.enable!.set(sw!.checked);
    },
  }) : null;
  const more = o.menu ? mini("more", `${o.title} options`, (e) => menuAt(e.currentTarget as HTMLElement, o.menu!())) : null;
  const body = h("div", { class: "vc-sec-body" }, ...kids(rows));
  const el = h("section", { class: "vc-sec" },
    h("div", { class: "vc-sec-head" }, toggleBtn, summary, h("span", { class: "vc-sec-tools" }, prev, next, reset, sw, more)),
    body);
  el.dataset.section = o.id;
  const apply = () => {
    const on = enabled();
    const shown = open && on;
    body.hidden = !shown;
    el.classList.toggle("open", shown);
    el.classList.toggle("off", !on);
    toggleBtn.setAttribute("aria-expanded", String(shown));
    toggleBtn.title = !on ? `Turn ${o.title} on` : o.tip ?? "";
    summary.hidden = shown;
  };
  const sync = () => {
    const on = enabled();
    if (sw) sw.checked = on;
    summary.textContent = !on ? "Off" : o.summary?.() ?? "";
    const changed = on && !!o.modified?.();
    dot.hidden = !changed;
    if (reset) reset.classList.toggle("shown", changed);
    const keyed = on && !!o.keys?.any();
    if (prev) prev.hidden = !keyed;
    if (next) next.hidden = !keyed;
    apply();
  };
  opener.set(el, () => {
    open = true;
    prefs.setOpen(o.id, true);
    apply();
  });
  syncs.push(sync);
  sync();
  return el;
}

// ---- tabs

/** A row of tabs (a segmented control); ←/→ move between them. */
export function tabs(o: { label: string; items: readonly (readonly [string, string])[]; get(): string; set(id: string): void }): HTMLElement {
  const now = o.get();
  const buttons = o.items.map(([id, text]) => h("button", {
    type: "button", role: "tab", class: id === now ? "active" : "", "aria-selected": String(id === now), tabindex: id === now ? "0" : "-1",
    onclick: () => o.set(id),
  }, text));
  const el = h("div", { class: "segmented vc-tabs", role: "tablist", "aria-label": o.label }, ...buttons);
  el.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const n = buttons.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (Math.max(0, i) + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    o.set(o.items[next][0]);
  });
  return el;
}
