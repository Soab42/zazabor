import { h } from "../../../../ui/dom";
import { icon, type IconName } from "../../../../ui/icons";

/** A full-width row for picking something: icon tile, title, a quiet second line, optional end. */
export function listButton(options: { icon: IconName; title: string; meta?: string; action: () => void; end?: Node | null; active?: boolean }): HTMLButtonElement {
  const button = h("button", { class: `mt-item${options.active ? " active" : ""}`, type: "button", title: options.title },
    h("span", { class: "mt-item-icon" }, icon(options.icon, 18)),
    h("span", { class: "mt-item-text" },
      h("span", { class: "mt-item-title" }, options.title),
      options.meta ? h("span", { class: "mt-item-meta" }, options.meta) : null),
    options.end ?? null);
  button.addEventListener("click", options.action);
  return button;
}

/** A glass tile with a big accent icon, one line, one sentence and an optional button. */
export function emptyState(iconName: IconName, title: string, text: string, action?: { label: string; run: () => void }): HTMLElement {
  const button = action ? h("button", { class: "btn small", type: "button" }, action.label) : null;
  button?.addEventListener("click", action!.run);
  return h("div", { class: "mt-empty" },
    h("span", { class: "mt-empty-icon" }, icon(iconName, 26)),
    h("strong", null, title),
    h("p", null, text),
    button);
}

/** The small uppercase label above a group. */
export const sectionLabel = (text: string, ...end: Node[]) =>
  h("div", { class: "mt-section" }, h("span", null, text), ...end);

export function textInput(placeholder: string, value = ""): HTMLInputElement {
  const input = h("input", { class: "mt-input", type: "text", placeholder, spellcheck: false, autocomplete: "off" });
  input.value = value;
  return input;
}

/** Quiet line of help text. */
export const hint = (text: string) => h("p", { class: "mt-hint" }, text);

/** A line that shows an error (empty = hidden). */
export function errorLine(): { el: HTMLElement; set(text: string): void } {
  const el = h("p", { class: "mt-error", role: "alert", hidden: true });
  return {
    el,
    set(text: string) {
      el.textContent = text;
      el.hidden = text === "";
    },
  };
}

/** Hostname for a web address, or the whole text when it isn't one. */
export function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}
