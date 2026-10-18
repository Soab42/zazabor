import { h } from "../../../../ui/dom";
import { icon, type IconName } from "../../../../ui/icons";

export interface DialogOptions {
  title: string;
  /** One quiet sentence under the title. */
  subtitle?: string;
  icon: IconName;
  /** Width in px (default 520). */
  width?: number;
  onClose?: () => void;
}

export interface Dialog {
  readonly body: HTMLElement;
  /** Buttons along the bottom; the bar is hidden while it is empty. */
  readonly foot: HTMLElement;
  close(): void;
}

let current: (Dialog & { el: HTMLElement }) | null = null;

/** Closes the open dialog, if any. */
export function closeDialog() {
  current?.close();
}

export const dialogOpen = () => current !== null;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A glass dialog over the app: title row, scrolling body and a button bar. One at a time. It
 * keeps keys to itself (Esc closes, Tab stays inside) so the player underneath doesn't react.
 */
export function openDialog(options: DialogOptions): Dialog {
  closeDialog();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const closeButton = h("button", { class: "icon-btn", type: "button", title: "Close (Esc)", "aria-label": "Close" }, icon("close", 18));
  const head = h("header", { class: "modal-head mt-head" },
    h("div", { class: "mt-head-main" },
      h("span", { class: "mt-tile" }, icon(options.icon, 20)),
      h("div", { class: "mt-head-text" }, h("h2", null, options.title), options.subtitle ? h("p", { class: "mt-sub" }, options.subtitle) : null)),
    closeButton);
  const body = h("div", { class: "modal-body mt-body" });
  const foot = h("footer", { class: "modal-foot mt-foot" });
  const modal = h("div", { class: "modal mt-dialog", style: { width: `min(${options.width ?? 520}px, 100%)` } }, head, body, foot);
  const el = h("div", { class: "modal-overlay mt-overlay", role: "dialog", "aria-modal": "true", "aria-label": options.title, tabIndex: -1 }, modal);

  let closed = false;
  const dialog: Dialog & { el: HTMLElement } = {
    el, body, foot,
    close() {
      if (closed) return;
      closed = true;
      if (current === dialog) current = null;
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 160);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      options.onClose?.();
    },
  };
  closeButton.addEventListener("click", () => dialog.close());
  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) dialog.close();
  });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      dialog.close();
    } else if (e.key === "Tab") {
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  // Keys typed into the dialog never reach the player, even when focus has wandered off.
  el.addEventListener("keyup", (e) => e.stopPropagation());

  current = dialog;
  document.body.append(el);
  el.focus({ preventScroll: true });
  return dialog;
}

/** Focuses the first field or button of a dialog's body (call after filling it). */
export function focusFirst(dialog: Dialog) {
  dialog.body.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
}
