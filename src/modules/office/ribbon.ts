import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import { popover, type Popover } from "../time/pickers";
import type { OfficeKind } from "./api";

/**
 * The ribbon Docs and Sheets share, laid out as Word and Excel lay theirs: a File tab, then tabs of
 * groups (Clipboard, Font, Paragraph…), each group a row of large buttons or stacks of small ones
 * with its name underneath. Controls read their state through callbacks, and `refresh()` (after
 * every selection change) brings every toggle, menu value and colour up to date.
 */

/** Anything that sits in a group: an element, re-read on `refresh()`. */
export interface Control {
  readonly el: HTMLElement;
  refresh(): void;
}

export interface Group {
  label: string;
  controls: Control[];
  /** The little ↘ in the group's corner (Font…, Paragraph…, Format Cells…). */
  more?: { title: string; run: () => void };
}

interface Tab {
  id: string;
  label: string;
  groups: Group[];
  panel: HTMLElement;
  button: HTMLButtonElement;
  /** Contextual tabs (Table Design) only show while their thing is selected. */
  visible?: () => boolean;
}

export interface Look {
  /** An icon, or a short text glyph drawn as text ("B", "x²", "Σ", "fx"). */
  icon?: IconName;
  glyph?: string;
  /** Extra class on the glyph ("bold", "italic", "underline", "strike"). */
  glyphClass?: string;
  label?: string;
  /** Large: icon over the label, as tall as the group. Small: one row. */
  size?: "large" | "small";
  title: string;
  /** Shown in the tooltip ("Ctrl+B"). */
  shortcut?: string;
}

function face(look: Look): Node[] {
  const size = look.size === "large" ? 24 : 16;
  const mark = look.glyph
    ? h("span", { class: `rb-glyph ${look.glyphClass ?? ""}`, "aria-hidden": "true" }, look.glyph)
    : look.icon ? icon(look.icon, size) : null;
  return [mark, look.label ? h("span", { class: "rb-label" }, look.label) : null].filter((n): n is HTMLElement | SVGSVGElement => !!n);
}

function tooltip(look: Look): string {
  return look.shortcut ? `${look.title} (${look.shortcut})` : look.title;
}

/** A button; `active` makes it a toggle (Bold), `enabled` greys it out. */
export function button(look: Look & { run: () => void; active?: () => boolean; enabled?: () => boolean }): Control {
  const el = h("button", {
    class: `rb-btn ${look.size === "large" ? "large" : "small"}${look.label ? "" : " bare"}`, type: "button",
    title: tooltip(look), "aria-label": look.title,
    // Keep the editor's selection: a ribbon click must not take the focus away from the text.
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => look.run(),
  }, ...face(look));
  return {
    el,
    refresh() {
      if (look.active) {
        const on = !!look.active();
        el.classList.toggle("on", on);
        el.setAttribute("aria-pressed", String(on));
      }
      if (look.enabled) el.disabled = !look.enabled();
    },
  };
}

/** A button that opens a menu (Borders ▾, Insert ▾). */
export function menuButton(look: Look & { items: () => MenuItem[]; enabled?: () => boolean }): Control {
  const el = h("button", {
    class: `rb-btn ${look.size === "large" ? "large" : "small"} rb-menu${look.label ? "" : " bare"}`, type: "button",
    title: tooltip(look), "aria-label": look.title, "aria-haspopup": "menu",
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => {
      const r = el.getBoundingClientRect();
      openMenu(r.left, r.bottom + 2, look.items());
    },
  }, ...face(look), icon("chevronDown", 10));
  return { el, refresh: () => look.enabled && (el.disabled = !look.enabled()) };
}

/** The main part runs the last choice, the arrow opens the choices (Paste ▾, AutoSum ▾). */
export function splitButton(look: Look & { run: () => void; items: () => MenuItem[]; enabled?: () => boolean }): Control {
  const main = button({ ...look });
  const arrow = h("button", {
    class: `rb-split-arrow ${look.size === "large" ? "large" : "small"}`, type: "button", title: `${look.title} options`, "aria-label": `${look.title} options`,
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => {
      const r = el.getBoundingClientRect();
      openMenu(r.left, r.bottom + 2, look.items());
    },
  }, icon("chevronDown", 10));
  const el = h("div", { class: `rb-split ${look.size === "large" ? "large" : "small"}` }, main.el, arrow);
  return {
    el,
    refresh() {
      main.refresh();
      if (look.enabled) arrow.disabled = !look.enabled();
    },
  };
}

/**
 * A field with a list (font name, font size, number format). `editable` lets the user type a
 * value (a size of 13, a font not in the list); `preview` styles each choice in the list.
 */
export function combo(o: {
  title: string;
  width: number;
  options: () => string[];
  value: () => string;
  set: (value: string) => void;
  editable?: boolean;
  preview?: (value: string) => Partial<CSSStyleDeclaration>;
  enabled?: () => boolean;
}): Control {
  const input = h("input", {
    class: "rb-combo-input", type: "text", spellcheck: "false", "aria-label": o.title, title: o.title,
    readOnly: !o.editable, style: { width: `${o.width}px` },
  });
  const arrow = h("button", { class: "rb-combo-arrow", type: "button", tabindex: "-1", "aria-label": `${o.title} list`, onmousedown: (e: Event) => e.preventDefault() }, icon("chevronDown", 10));
  const el = h("div", { class: "rb-combo" }, input, arrow);
  let pop: Popover | null = null;
  let typed = false;
  const commit = () => {
    if (typed && input.value.trim()) o.set(input.value.trim());
    typed = false;
  };
  const show = () => {
    if (pop) return pop.close();
    const current = o.value();
    const list = h("div", { class: "rb-list", role: "listbox" }, ...o.options().map((value) => h("button", {
      class: `rb-list-item${value === current ? " selected" : ""}`, type: "button", role: "option", style: o.preview?.(value) ?? {},
      onmousedown: (e: Event) => e.preventDefault(),
      onclick: () => {
        pop?.close();
        o.set(value);
      },
    }, value)));
    pop = adoptTone(popover(el, list, document.body, () => (pop = null), true), el);
    requestAnimationFrame(() => list.querySelector(".selected")?.scrollIntoView({ block: "center" }));
  };
  arrow.addEventListener("click", show);
  input.addEventListener("mousedown", (e) => {
    if (!o.editable) {
      e.preventDefault();
      show();
    }
  });
  input.addEventListener("input", () => (typed = true));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      pop?.close();
    } else if (e.key === "Escape") {
      typed = false;
      input.value = o.value();
      input.blur();
    } else if (e.key === "ArrowDown" && e.altKey) {
      e.preventDefault();
      show();
    }
  });
  input.addEventListener("change", commit);
  return {
    el,
    refresh() {
      if (document.activeElement !== input) input.value = o.value();
      if (o.enabled) {
        const on = o.enabled();
        input.disabled = !on;
        arrow.disabled = !on;
      }
    },
  };
}

// ---- colours

/** Office's theme columns (each with lighter and darker steps below), then the standard colours. */
const THEME = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const STANDARD = ["#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0"];

function mix(hex: string, toward: string, amount: number): string {
  const a = Number.parseInt(hex.slice(1), 16);
  const b = Number.parseInt(toward.slice(1), 16);
  const channel = (shift: number) => Math.round(((a >> shift) & 255) * (1 - amount) + ((b >> shift) & 255) * amount);
  return `#${[16, 8, 0].map((s) => channel(s).toString(16).padStart(2, "0")).join("")}`;
}

/** The steps under a theme colour: lighter for dark colours, darker for light ones. */
function steps(hex: string): string[] {
  const light = hex === "#ffffff" || hex === "#e7e6e6" || hex === "#ffc000";
  if (hex === "#000000") return [0.5, 0.35, 0.25, 0.15, 0.05].map((k) => mix(hex, "#ffffff", k));
  return light ? [0.05, 0.15, 0.25, 0.35, 0.5].map((k) => mix(hex, "#000000", k)) : [0.8, 0.6, 0.4].map((k) => mix(hex, "#ffffff", k)).concat([0.25, 0.5].map((k) => mix(hex, "#000000", k)));
}

/**
 * Popovers live on the page's body, outside the editor, so they take the editor's tone (blue for
 * Docs, green for Sheets) from their anchor.
 */
function adoptTone(pop: Popover, anchor: HTMLElement): Popover {
  const tone = anchor.closest(".tone-doc, .tone-sheet, .tone-pdf");
  const kind = tone && (["doc", "sheet", "pdf"] as const).find((k) => tone.classList.contains(`tone-${k}`));
  if (kind) pop.el.classList.add(`tone-${kind}`);
  return pop;
}

/** A palette panel under `anchor`; `pick` gets the colour, or null for No Fill / Automatic. */
export function colorPanel(anchor: HTMLElement, o: { noneLabel: string; pick: (color: string | null) => void }): Popover {
  let pop: Popover;
  const swatch = (color: string) => h("button", {
    class: "rb-swatch", type: "button", title: color, "aria-label": color, style: { background: color },
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => (pop.close(), o.pick(color)),
  });
  const custom = h("input", { type: "color", class: "rb-custom-color", "aria-label": "More colours" });
  custom.addEventListener("change", () => (pop.close(), o.pick(custom.value)));
  const panel = h("div", { class: "rb-palette" },
    h("button", { class: "rb-palette-none", type: "button", onmousedown: (e: Event) => e.preventDefault(), onclick: () => (pop.close(), o.pick(null)) }, h("span", { class: "rb-swatch none" }), o.noneLabel),
    h("div", { class: "rb-palette-title" }, "Theme Colours"),
    h("div", { class: "rb-swatches" }, ...THEME.map(swatch)),
    h("div", { class: "rb-swatch-grid" }, ...[0, 1, 2, 3, 4].flatMap((i) => THEME.map((c) => swatch(steps(c)[i])))),
    h("div", { class: "rb-palette-title" }, "Standard Colours"),
    h("div", { class: "rb-swatches" }, ...STANDARD.map(swatch)),
    h("label", { class: "rb-palette-more" }, icon("palette", 14), "More Colours…", custom));
  pop = adoptTone(popover(anchor, panel, document.body), anchor);
  return pop;
}

/**
 * Font Color, Highlight, Fill: the main part applies the colour shown in its bar (the last one
 * picked), the arrow opens the palette.
 */
export function colorButton(look: Look & { initial: string | null; noneLabel: string; apply: (color: string | null) => void; enabled?: () => boolean }): Control {
  let current = look.initial;
  const bar = h("span", { class: "rb-color-bar" });
  const paint = () => {
    bar.style.background = current ?? "transparent";
    bar.classList.toggle("none", !current);
  };
  const main = h("button", {
    class: "rb-btn small bare rb-color-main", type: "button", title: tooltip(look), "aria-label": look.title,
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => look.apply(current),
  }, h("span", { class: "rb-color-face" }, ...face({ ...look, label: undefined, size: "small" }), bar));
  const arrow = h("button", {
    class: "rb-split-arrow small", type: "button", title: `${look.title} colours`, "aria-label": `${look.title} colours`,
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => colorPanel(el, {
      noneLabel: look.noneLabel,
      pick: (color) => {
        current = color;
        paint();
        look.apply(color);
      },
    }),
  }, icon("chevronDown", 10));
  const el = h("div", { class: "rb-split small" }, main, arrow);
  paint();
  return {
    el,
    refresh() {
      if (look.enabled) {
        const on = look.enabled();
        main.disabled = !on;
        arrow.disabled = !on;
      }
    },
  };
}

// ---- layout

/** Small controls in rows, stacked (Excel's Font group: name and size over B I U). */
export function stack(...rows: Control[][]): Control {
  const flat = rows.flat();
  return {
    el: h("div", { class: "rb-stack" }, ...rows.map((controls) => h("div", { class: "rb-row" }, ...controls.map((c) => c.el)))),
    refresh: () => flat.forEach((c) => c.refresh()),
  };
}

/** A thin line between controls in a row. */
export function divider(): Control {
  return { el: h("span", { class: "rb-divider" }), refresh() {} };
}

/** Any element as a control (a custom gallery, a zoom field…). */
export function custom(el: HTMLElement, refresh: () => void = () => {}): Control {
  return { el, refresh };
}

// ---- the ribbon

export class Ribbon {
  readonly el: HTMLElement;
  private tabs: Tab[] = [];
  private current = "";
  private strip = h("div", { class: "rb-tabs", role: "tablist" });
  private panels = h("div", { class: "rb-panels" });
  private collapsed = false;
  private peek = false;

  /** `tone` colours the File tab and the accents: blue for Docs, green for Sheets. */
  constructor(o: { tone: OfficeKind; onFile: () => void; extra?: HTMLElement[] }) {
    const file = h("button", { class: "rb-file", type: "button", onclick: () => o.onFile() }, "File");
    const collapse = h("button", {
      class: "icon-btn small rb-collapse", type: "button", title: "Collapse the ribbon (Ctrl+F1)", "aria-label": "Collapse the ribbon",
      onclick: () => this.setCollapsed(!this.collapsed),
    }, icon("chevronUp", 14));
    this.strip.append(file);
    this.el = h("div", { class: `rb tone-${o.tone}` }, h("div", { class: "rb-strip" }, this.strip, h("span", { class: "spacer" }), ...(o.extra ?? []), collapse), this.panels);
    // A narrow window drops the small buttons' labels, as Office's ribbon does, before scrolling.
    new ResizeObserver(() => this.fit()).observe(this.panels);
  }

  private fit() {
    const panel = this.tabs.find((t) => t.id === this.current)?.panel;
    if (!panel) return;
    panel.classList.remove("compact");
    if (panel.scrollWidth > panel.clientWidth + 1) panel.classList.add("compact");
  }

  /** Adds a tab; the first one added shows. */
  tab(id: string, label: string, groups: Group[], visible?: () => boolean) {
    const panel = h("div", { class: "rb-panel", role: "tabpanel" }, ...groups.map((g) =>
      h("div", { class: "rb-group" },
        h("div", { class: "rb-group-body" }, ...g.controls.map((c) => c.el)),
        h("div", { class: "rb-group-label" }, g.label,
          g.more ? h("button", { class: "rb-group-more", type: "button", title: g.more.title, "aria-label": g.more.title, onmousedown: (e: Event) => e.preventDefault(), onclick: g.more.run }, icon("launcher", 11)) : null))));
    const button = h("button", { class: "rb-tab", type: "button", role: "tab", onclick: () => this.select(id) }, label);
    this.tabs.push({ id, label, groups, panel, button, visible });
    this.strip.append(button);
    this.panels.append(panel);
    if (!this.current) this.select(id);
    else panel.hidden = true;
  }

  select(id: string) {
    this.current = id;
    // A click on a tab of a collapsed ribbon shows it over the page until the next action.
    if (this.collapsed) this.peek = true;
    this.draw();
  }

  setCollapsed(on: boolean) {
    this.collapsed = on;
    this.peek = false;
    this.draw();
  }

  /** Re-reads every control (call after the selection or the content changed). */
  refresh() {
    for (const tab of this.tabs) {
      if (tab.visible) tab.button.hidden = !tab.visible();
      if (tab.id === this.current) for (const g of tab.groups) for (const c of g.controls) c.refresh();
    }
    if (this.tabs.find((t) => t.id === this.current)?.button.hidden) this.select(this.tabs[0].id);
  }

  private draw() {
    for (const tab of this.tabs) {
      const on = tab.id === this.current;
      tab.button.classList.toggle("active", on && (!this.collapsed || this.peek));
      tab.button.setAttribute("aria-selected", String(on));
      tab.panel.hidden = !on;
      if (on) for (const g of tab.groups) for (const c of g.controls) c.refresh();
    }
    requestAnimationFrame(() => this.fit());
    this.el.classList.toggle("collapsed", this.collapsed && !this.peek);
    this.el.classList.toggle("peek", this.collapsed && this.peek);
  }

  /** Ctrl+F1, and the end of a peek after a command. */
  handleKey(e: KeyboardEvent): boolean {
    if ((e.ctrlKey || e.metaKey) && e.key === "F1") {
      this.setCollapsed(!this.collapsed);
      return true;
    }
    return false;
  }

  /** Ends a peek (the editor calls it when its content gets a click). */
  settle() {
    if (this.peek) {
      this.peek = false;
      this.draw();
    }
  }
}

// ---- the editor's frame

/**
 * The bar above the ribbon: Save, Undo and Redo (Office's Quick Access), the file's name with its
 * saved state, and a search field the editor wires up.
 */
export function titleBar(o: { save: () => void; undo: () => void; redo: () => void; canUndo: () => boolean; canRedo: () => boolean; tone: OfficeKind }) {
  const name = h("span", { class: "of-name" });
  const state = h("span", { class: "of-state" });
  const undo = button({ icon: "undo", title: "Undo", shortcut: "Ctrl+Z", run: o.undo, enabled: o.canUndo });
  const redo = button({ icon: "redo", title: "Redo", shortcut: "Ctrl+Y", run: o.redo, enabled: o.canRedo });
  const saveButton = button({ icon: "save", title: "Save", shortcut: "Ctrl+S", run: o.save });
  const el = h("div", { class: `of-titlebar tone-${o.tone}` },
    h("div", { class: "of-quick" }, saveButton.el, undo.el, redo.el),
    h("div", { class: "of-title" }, h("span", { class: "of-app-mark" }, icon(o.tone === "doc" ? "docFile" : o.tone === "sheet" ? "sheetFile" : "pdfFile", 15)), name, state));
  return {
    el,
    /** Shows the name and whether it's saved. */
    set(title: string, dirty: boolean, path: string | null) {
      name.textContent = title;
      name.title = path ?? "Not saved yet";
      state.textContent = dirty ? "• Edited" : path ? "Saved" : "";
      undo.refresh();
      redo.refresh();
    },
    refresh() {
      undo.refresh();
      redo.refresh();
    },
  };
}
