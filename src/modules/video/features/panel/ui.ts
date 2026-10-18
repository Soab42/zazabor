import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";

/** Small building blocks shared by the side panel's tabs (styles in panel.css). */

/** A titled group of controls. */
export function section(title: string, ...children: (Node | null | undefined | false)[]): HTMLElement {
  return h("section", { class: "pp-section" }, h("h3", { class: "pp-heading" }, title), ...children);
}

export const note = (text: string) => h("p", { class: "pp-note" }, text);

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Text for the value readout. */
  format: (value: number) => string;
  onInput: (value: number) => void;
  /** Shows a reset button that sets this value (and calls onInput). */
  resetTo?: number;
  title?: string;
}

export interface SliderHandle {
  el: HTMLElement;
  /** Moves the slider and readout without calling `onInput`. */
  set(value: number): void;
}

/** A label with its value on top and a full-width slider below. */
export function slider(o: SliderOptions): SliderHandle {
  const value = h("span", { class: "pp-value" }, o.format(o.value));
  const input = h("input", { type: "range", min: o.min, max: o.max, step: o.step, "aria-label": o.label, title: o.title });
  input.value = String(o.value);
  const reset = o.resetTo === undefined ? null : h("button", {
    class: "icon-btn small pp-reset", type: "button", title: "Reset", "aria-label": `Reset ${o.label}`,
    onclick: () => {
      set(o.resetTo!);
      o.onInput(o.resetTo!);
    },
  }, icon("refresh", 13));
  const set = (v: number) => {
    input.value = String(v);
    value.textContent = o.format(v);
    if (reset) reset.hidden = v === o.resetTo;
  };
  input.addEventListener("input", () => {
    const v = Number(input.value);
    value.textContent = o.format(v);
    if (reset) reset.hidden = v === o.resetTo;
    o.onInput(v);
  });
  if (reset) reset.hidden = o.value === o.resetTo;
  const el = h("div", { class: "pp-slider" }, h("div", { class: "pp-slider-head" }, h("span", { class: "pp-label" }, o.label), value, reset), input);
  return { el, set };
}

/** A row with a label and a switch. */
export function toggle(label: string, checked: boolean, onChange: (on: boolean) => void, hint?: string): { el: HTMLElement; set(on: boolean): void } {
  const input = h("input", { type: "checkbox", class: "switch", "aria-label": label });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const el = h("label", { class: "pp-toggle" }, h("span", { class: "pp-toggle-text" }, h("span", { class: "pp-label" }, label), hint ? h("span", { class: "pp-hint" }, hint) : null), input);
  return { el, set: (on) => (input.checked = on) };
}

/** A segmented control; `set` changes the highlighted option without calling `onChange`. */
export function segmented<T extends string>(options: { value: T; label: string; title?: string }[], value: T, onChange: (value: T) => void) {
  const buttons = options.map((o) =>
    h("button", { type: "button", class: o.value === value ? "active" : "", title: o.title, onclick: () => {
      set(o.value);
      onChange(o.value);
    } }, o.label),
  );
  const el = h("div", { class: "segmented pp-segmented", role: "group" }, ...buttons);
  function set(v: T) {
    options.forEach((o, i) => buttons[i].classList.toggle("active", o.value === v));
  }
  return { el, set };
}

/** A label with a select. */
export function selectRow(label: string, options: { value: string; label: string }[], value: string, onChange: (value: string) => void) {
  const select = h("select", { "aria-label": label }, ...options.map((o) => h("option", { value: o.value }, o.label)));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  const el = h("label", { class: "pp-select-row" }, h("span", { class: "pp-label" }, label), select);
  return { el, select };
}

/** A selectable row, e.g. a track. */
export function choiceRow(label: string, selected: boolean, onPick: () => void, detail?: string): HTMLButtonElement {
  return h("button", { type: "button", class: `pp-choice${selected ? " selected" : ""}`, role: "radio", "aria-checked": String(selected), onclick: onPick },
    h("span", { class: "pp-choice-mark" }, selected ? icon("check", 13) : null),
    h("span", { class: "pp-choice-label" }, label),
    detail ? h("span", { class: "pp-choice-detail" }, detail) : null);
}

/** "123 ms" / "1.50 s" style delay in the sliders. */
export const secondsLabel = (ms: number) => (ms === 0 ? "0 s" : `${ms > 0 ? "+" : "−"}${(Math.abs(ms) / 1000).toFixed(2)} s`);
