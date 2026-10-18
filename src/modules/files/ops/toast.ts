import { h } from "../../../ui/dom";

export interface ToastAction {
  label: string;
  run: () => void;
}

let current: { el: HTMLElement; timer: number } | null = null;

function dismiss(toast: { el: HTMLElement; timer: number }) {
  clearTimeout(toast.timer);
  toast.el.classList.add("leaving");
  const remove = () => toast.el.remove();
  toast.el.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, 400);
  if (current === toast) current = null;
}

/** A brief glass message at the bottom of the window, with an optional action ("Undo"). */
export function showToast(message: string, action?: ToastAction, ms = 5000) {
  if (current) dismiss(current);
  const el = h("div", { class: "ops-toast", role: "status" }, h("span", { class: "ops-toast-text" }, message));
  const toast = { el, timer: 0 };
  const arm = () => {
    clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => dismiss(toast), ms);
  };
  if (action) {
    el.append(h("button", {
      class: "ops-toast-action", type: "button",
      onclick: () => {
        dismiss(toast);
        action.run();
      },
    }, action.label));
  }
  el.addEventListener("pointerenter", () => clearTimeout(toast.timer));
  el.addEventListener("pointerleave", arm);
  document.body.append(el);
  current = toast;
  arm();
}
