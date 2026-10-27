import { h } from "../../../../ui/dom";

/**
 * Small controls in the inspector's own markup (`ve-section`, `ve-row`), for the template views.
 * Each pushes a sync that brings it up to date when the project changes under it.
 */

export type Syncs = (() => void)[];

export const section = (title: string, ...rows: (Node | null | false)[]) =>
  h("section", { class: "ve-section" }, h("h3", null, title), ...rows.filter((r): r is Node => !!r));

export const note = (text: string, warn = false) => h("p", { class: `ve-panel-note${warn ? " warn" : ""}` }, text);

export function buttons(...items: ([string, () => void, boolean?] | null)[]): HTMLElement {
  return h("div", { class: "ve-row ve-row-buttons" }, ...items.filter((x): x is [string, () => void, boolean?] => !!x)
    .map(([text, run, disabled]) => h("button", { class: "btn small", type: "button", disabled: !!disabled, onclick: run }, text)));
}

export function select<V extends string>(syncs: Syncs, label: string, options: readonly (readonly [V, string])[], get: () => V, set: (v: V) => void): HTMLElement {
  const el = h("select", { onchange: () => set(el.value as V) }, ...options.map(([v, text]) => h("option", { value: v }, text)));
  el.value = get();
  syncs.push(() => {
    if (document.activeElement !== el) el.value = get();
  });
  return h("div", { class: "ve-row" }, h("label", null, label), el);
}

export function choice<V extends string>(syncs: Syncs, label: string, options: readonly (readonly [V, string])[], get: () => V, set: (v: V) => void): HTMLElement {
  const list = options.map(([v, text]) => h("button", { type: "button", class: get() === v ? "active" : "", onclick: () => set(v) }, text));
  syncs.push(() => list.forEach((b, i) => b.classList.toggle("active", options[i][0] === get())));
  return h("div", { class: "ve-row" }, h("label", null, label), h("div", { class: "segmented ve-seg" }, ...list));
}

export function toggle(syncs: Syncs, label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const el = h("input", { type: "checkbox", class: "switch", checked: get(), onchange: () => set(el.checked) });
  syncs.push(() => (el.checked = get()));
  return h("div", { class: "ve-row" }, h("label", null, label), h("span", { class: "spacer" }), el);
}

export function slider(syncs: Syncs, label: string, o: { min: number; max: number; step: number; get: () => number; set: (v: number) => void; format: (v: number) => string }): HTMLElement {
  const input = h("input", { type: "range", min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.get()) });
  const value = h("span", { class: "ve-value" }, o.format(o.get()));
  input.addEventListener("input", () => {
    o.set(Number(input.value));
    value.textContent = o.format(Number(input.value));
  });
  syncs.push(() => {
    if (document.activeElement === input) return;
    input.value = String(o.get());
    value.textContent = o.format(o.get());
  });
  return h("div", { class: "ve-row" }, h("label", null, label), input, value);
}

export function color(syncs: Syncs, label: string, get: () => string, set: (v: string) => void, mark?: () => boolean): HTMLElement {
  const input = h("input", { type: "color", value: get(), oninput: () => set(input.value) });
  const dot = h("span", { class: "mo-changed", title: "Changed by hand (Reset to kit puts it back)" });
  syncs.push(() => {
    if (document.activeElement !== input) input.value = get();
    dot.hidden = !mark?.();
  });
  dot.hidden = !mark?.();
  return h("div", { class: "ve-row" }, h("label", null, label), h("span", { class: "spacer" }), dot, input);
}

/** A text field with a counter against its limit (a text area when `multiline`). */
export function textField(syncs: Syncs, label: string, o: { get: () => string; set: (v: string) => void; limit?: number; multiline?: boolean; placeholder?: string }): HTMLElement {
  const input = o.multiline
    ? h("textarea", { class: "ve-textarea mo-text", rows: 2, spellcheck: "true", placeholder: o.placeholder ?? "" })
    : h("input", { type: "text", class: "mo-text", spellcheck: "true", placeholder: o.placeholder ?? "" });
  input.value = o.get();
  const count = h("span", { class: "mo-count" });
  const counted = () => {
    const n = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input.value)].length;
    count.textContent = o.limit ? `${n}/${o.limit}` : "";
    count.classList.toggle("over", !!o.limit && n > o.limit);
  };
  counted();
  input.addEventListener("input", () => {
    o.set(input.value);
    counted();
  });
  syncs.push(() => {
    if (document.activeElement === input) return;
    input.value = o.get();
    counted();
  });
  return h("div", { class: "mo-field" }, h("div", { class: "mo-field-head" }, h("label", null, label), count), input);
}
