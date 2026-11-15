import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import type { Contact } from "./api";
import { contactPhoto } from "./store";

/** Small pieces the Phone views share. */

// ---- sheets -------------------------------------------------------------------------------------

export interface Sheet {
  readonly body: HTMLElement;
  readonly foot: HTMLElement;
  readonly el: HTMLElement;
  close(): void;
}

export interface SheetOptions {
  title: string;
  subtitle?: string;
  icon: IconName;
  width?: number;
  class?: string;
  onClose?: () => void;
}

/** A glass dialog over the window (`.modal`); keys stay inside it, Esc closes. */
export function openSheet(options: SheetOptions): Sheet {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const closeButton = h("button", { class: "icon-btn", type: "button", title: "Close (Esc)", "aria-label": "Close" }, icon("close", 17));
  const head = h("header", { class: "modal-head pl-sheet-head" },
    h("span", { class: "pl-sheet-tile" }, icon(options.icon, 20)),
    h("div", { class: "pl-sheet-titles" }, h("h2", null, options.title), options.subtitle ? h("p", { class: "pl-sheet-sub" }, options.subtitle) : null),
    closeButton);
  const body = h("div", { class: "modal-body pl-sheet-body" });
  const foot = h("footer", { class: "modal-foot pl-sheet-foot" });
  const modal = h("div", { class: `modal pl-sheet${options.class ? ` ${options.class}` : ""}`, style: { width: `min(${options.width ?? 460}px, 100%)` } }, head, body, foot);
  const el = h("div", { class: "modal-overlay pl-overlay", role: "dialog", "aria-modal": "true", "aria-label": options.title, tabIndex: -1 }, modal);
  let closed = false;
  const sheet: Sheet = {
    el, body, foot,
    close() {
      if (closed) return;
      closed = true;
      el.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      options.onClose?.();
    },
  };
  closeButton.addEventListener("click", () => sheet.close());
  el.addEventListener("pointerdown", (e) => {
    if (e.target === el) sheet.close();
  });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      sheet.close();
    }
  });
  document.body.append(el);
  return sheet;
}

// ---- people -------------------------------------------------------------------------------------

function hueOf(text: string): number {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length || /^\d/.test(words[0])) return "";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

/** A round picture: the contact's photo, their initials on a colour, or a person glyph. */
export function avatar(name: string, size: number, phoneId?: string | null, contact?: Contact | null): HTMLElement {
  const letters = initials(name);
  const el = h("span", { class: "pl-avatar", style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` } },
    letters || icon("user", Math.round(size * 0.5)));
  el.style.setProperty("--hue", String(hueOf(name)));
  if (phoneId && contact?.hasPhoto) {
    void contactPhoto(phoneId, contact).then((url) => {
      if (!url) return;
      el.replaceChildren(h("img", { src: url, alt: "", draggable: false }));
      el.classList.add("photo");
    });
  }
  return el;
}

// ---- status glyphs ------------------------------------------------------------------------------

/** A battery drawn at its level (CSS), with a bolt while charging. */
export function batteryEl(level: number | null, charging: boolean): HTMLElement {
  const known = level != null;
  const pct = known ? Math.max(0, Math.min(100, level!)) : 0;
  const el = h("span", { class: `pl-battery${charging ? " charging" : ""}${known && pct <= 15 && !charging ? " low" : ""}`, title: known ? `Battery ${pct}%${charging ? ", charging" : ""}` : "Battery unknown" },
    h("span", { class: "pl-battery-body" }, h("span", { class: "pl-battery-fill", style: { width: `${pct}%` } }), charging ? icon("bolt", 9) : null),
    h("span", { class: "pl-battery-cap" }));
  return el;
}

/** Four signal bars, `level` of them lit. */
export function signalEl(level: number | null, label?: string | null): HTMLElement {
  const el = h("span", { class: "pl-signal", title: level == null ? "No signal information" : `Signal ${level} of 4${label ? ` (${label})` : ""}` });
  for (let i = 1; i <= 4; i++) el.append(h("span", { class: `pl-sig-bar${level != null && i <= level ? " on" : ""}`, style: { height: `${3 + i * 2.5}px` } }));
  return el;
}

// ---- empty and loading states -------------------------------------------------------------------

export function emptyState(glyph: IconName, title: string, text: string, ...extra: (Node | null)[]): HTMLElement {
  return h("div", { class: "pl-empty" }, h("div", { class: "pl-empty-tile" }, icon(glyph, 28)), h("h2", null, title), h("p", null, text), ...extra);
}

export function loadingState(text = "Loading…"): HTMLElement {
  return h("div", { class: "pl-loading" }, h("span", { class: "spinner large" }), h("p", null, text));
}

/** "Last synced 5 min ago" over cached content while the phone is away. */
export function staleBanner(text: string): HTMLElement {
  return h("div", { class: "pl-stale" }, icon("clock", 14), h("span", null, text));
}
