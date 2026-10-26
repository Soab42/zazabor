import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";

export interface DialogOptions {
  title: string;
  subtitle?: string;
  icon?: IconName;
  /** Colours the icon chip like a stat card ("work", "lunch", …). */
  tone?: string;
  class?: string;
  body: (Node | null | false)[];
  /** Footer controls, left to right. */
  foot: (Node | null | false)[];
  /** Enter runs this (not in a text area, and not on a button, which clicks instead). */
  submit?: () => void;
  onClose?: () => void;
}

export interface Dialog {
  readonly overlay: HTMLElement;
  readonly card: HTMLElement;
  close(): void;
  /** Shows a problem under the fields ("" clears it). */
  error(text: string): void;
  /** Disables the footer's buttons while a request runs. */
  busy(on: boolean): void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A glass dialog on the shared `.modal` classes: Esc and a click outside close it, Enter submits,
 * Tab stays inside (popovers live in the overlay, so they count as inside), and focus goes back
 * where it was afterwards.
 */
export function openDialog(options: DialogOptions): Dialog {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const errorLine = h("p", { class: "tt-error", role: "alert", "aria-live": "polite" });
  const titleId = `tt-dialog-${Math.random().toString(36).slice(2)}`;
  const foot = h("div", { class: "modal-foot" });
  for (const node of options.foot) if (node) foot.append(node);
  const body = h("div", { class: "modal-body tt-dialog-body" });
  for (const node of options.body) if (node) body.append(node);
  body.append(errorLine);
  const card = h("div", { class: `modal tt-dialog ${options.class ?? ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleId },
    h("div", { class: "modal-head" },
      h("div", { class: "tt-dialog-heading" },
        options.icon ? h("span", { class: `tt-chip-icon tone-${options.tone ?? "total"}` }, icon(options.icon, 18)) : null,
        h("div", null,
          h("h2", { id: titleId }, options.title),
          options.subtitle ? h("p", { class: "tt-dialog-sub" }, options.subtitle) : null)),
      h("button", { class: "icon-btn small", type: "button", title: "Close (Esc)", "aria-label": "Close", onclick: () => close() }, icon("close", 14))),
    body, foot);
  const overlay = h("div", { class: "modal-overlay tt-overlay" }, card);
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    options.onClose?.();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }

  overlay.addEventListener("keydown", (e) => {
    // Keys typed here are the dialog's, not the section's shortcuts.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && !e.shiftKey && options.submit) {
      const target = e.target as HTMLElement;
      // A text area takes Enter as a new line (Ctrl+Enter submits), unless it holds a one-line label.
      if (target instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey) && !("enterSubmits" in target.dataset)) return;
      if (target instanceof HTMLButtonElement) return;
      e.preventDefault();
      options.submit();
    } else if (e.key === "Tab") {
      const list = [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  // The first field takes the keyboard (or the first button, for a plain question).
  requestAnimationFrame(() => {
    const auto = card.querySelector<HTMLElement>("[data-autofocus]") ?? body.querySelector<HTMLElement>(FOCUSABLE) ?? foot.querySelector<HTMLElement>(".btn.primary");
    auto?.focus();
  });

  return {
    overlay,
    card,
    close,
    error(text: string) {
      errorLine.textContent = text;
    },
    busy(on: boolean) {
      for (const button of foot.querySelectorAll("button")) button.toggleAttribute("data-busy", on);
      card.classList.toggle("busy", on);
    },
  };
}

/** A labelled field; `optional` adds "(optional)" after the label, `note` a muted hint beside it. */
export function field(label: string, control: Node, extra: { optional?: boolean; note?: Node | string | null; class?: string } = {}): HTMLElement {
  return h("div", { class: `tt-field ${extra.class ?? ""}` },
    h("div", { class: "tt-label-row" },
      h("span", { class: "tt-label" }, label, extra.optional ? h("span", { class: "tt-optional" }, " (optional)") : null),
      extra.note ?? null),
    control);
}

export function textInput(attrs: Record<string, unknown> = {}): HTMLInputElement {
  return h("input", { class: "tt-input", type: "text", spellcheck: "false", autocomplete: "off", ...attrs });
}

export function textArea(attrs: Record<string, unknown> = {}): HTMLTextAreaElement {
  return h("textarea", { class: "tt-input tt-textarea", rows: 3, ...attrs });
}

/** A yes/no question; resolves true when confirmed. */
export function confirmDialog(options: { title: string; text: string; confirm: string; danger?: boolean; icon?: IconName; tone?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const yes = h("button", {
      class: `btn ${options.danger ? "tt-danger-solid" : "primary"}`, type: "button",
      onclick: () => ((answer = true), dialog.close()),
    }, options.confirm);
    const dialog = openDialog({
      title: options.title,
      icon: options.icon,
      tone: options.tone,
      class: "tt-confirm",
      body: [h("p", { class: "tt-dialog-text" }, options.text)],
      foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), yes],
      onClose: () => resolve(answer),
    });
    requestAnimationFrame(() => yes.focus());
  });
}
