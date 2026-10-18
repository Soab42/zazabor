import { h } from "../../../../ui/dom";
import { icon, type IconName } from "../../../../ui/icons";
import { videoThumbUrl } from "../../api";
import "./library.css";

// Custom schemes are exposed as http://<scheme>.localhost on Windows and <scheme>://localhost elsewhere.
const BASE = navigator.userAgent.includes("Windows") ? "http://cs.localhost/" : "cs://localhost/";

/** A resized copy of an image file (cover art), served and cached by the backend. */
export const coverUrl = (path: string, size: number) => `${BASE}thumb?s=${size}&p=${encodeURIComponent(path)}`;

export const videoThumb = (path: string, mtime: number, size: number) => videoThumbUrl(path, mtime, size);

/** "3 h 20 min", "45 min", "1 min"; empty for 0. */
export function formatSpan(ms: number): string {
  if (!(ms > 0)) return "";
  const minutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "12 videos", "1 song". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export interface ArtOptions {
  src?: string | null;
  icon: IconName;
  shape?: "wide" | "square" | "circle" | "poster";
  /** 0–1 watched progress bar along the bottom. */
  progress?: number;
  /** Small chip in the corner (a duration). */
  badge?: string;
  /** Finished videos are dimmed. */
  done?: boolean;
  iconSize?: number;
}

/** A picture box with a placeholder icon that fades to the image. */
export function art(options: ArtOptions): HTMLElement {
  const box = h("div", { class: `lib-art ${options.shape ?? "wide"}${options.done ? " done" : ""}` },
    h("span", { class: "lib-art-ph" }, icon(options.icon, options.iconSize ?? 26)));
  if (options.src) {
    const img = h("img", { alt: "", loading: "lazy", decoding: "async", draggable: false, src: options.src });
    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => img.remove());
    box.append(img);
  }
  if (options.progress !== undefined && options.progress > 0) {
    box.append(h("div", { class: "lib-prog" }, h("div", { style: { width: `${Math.round(Math.min(1, options.progress) * 100)}%` } })));
  }
  if (options.badge) box.append(h("span", { class: "lib-badge" }, options.badge));
  return box;
}

export interface CardOptions {
  art: HTMLElement;
  title: string;
  subtitle?: string;
  /** A second muted line. */
  detail?: string;
  /** "stack" draws plates behind the picture (folders, playlists). */
  stack?: boolean;
  playing?: boolean;
  onOpen: () => void;
  onMenu?: (x: number, y: number) => void;
}

function activate(el: HTMLElement, onOpen: () => void, onMenu?: (x: number, y: number) => void) {
  el.addEventListener("click", onOpen);
  el.addEventListener("keydown", (e) => {
    if (e.target !== el) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = el.getBoundingClientRect();
      onMenu?.(r.left + 24, r.top + 24);
      e.preventDefault();
    }
  });
  if (onMenu) {
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      onMenu(e.clientX, e.clientY);
    });
  }
}

/** A grid card: picture, title, one or two quiet lines. */
export function card(options: CardOptions): HTMLElement {
  const el = h("div", { class: `lib-card${options.stack ? " stack" : ""}${options.playing ? " playing" : ""}`, tabIndex: 0, role: "button", title: options.title },
    h("div", { class: "lib-card-art" }, options.art),
    h("div", { class: "lib-card-text" },
      h("span", { class: "lib-card-title" }, options.title),
      options.subtitle ? h("span", { class: "lib-card-sub" }, options.subtitle) : null,
      options.detail ? h("span", { class: "lib-card-detail" }, options.detail) : null));
  activate(el, options.onOpen, options.onMenu);
  return el;
}

export interface RowOptions {
  art?: HTMLElement;
  /** A leading number or marker (track number). */
  lead?: string;
  title: string;
  subtitle?: string;
  /** Muted text columns before the end (album). */
  columns?: string[];
  /** Right-aligned, tabular (duration). */
  meta?: string;
  playing?: boolean;
  done?: boolean;
  progress?: number;
  onOpen: () => void;
  onMenu?: (x: number, y: number) => void;
  /** Buttons on the right, shown on hover. */
  actions?: HTMLElement[];
  /** Marks a row as a drag/insert target in its list. */
  listRow?: boolean;
}

export function row(options: RowOptions): HTMLElement {
  const el = h("div", {
    class: `lib-row${options.playing ? " playing" : ""}${options.done ? " done" : ""}`, tabIndex: 0, role: "button", title: options.title,
    ...(options.listRow ? { "data-row": "" } : {}),
  },
    options.lead !== undefined ? h("span", { class: "lib-row-lead" }, options.lead) : null,
    options.art ? h("div", { class: "lib-row-art" }, options.art) : null,
    h("div", { class: "lib-row-text" },
      h("span", { class: "lib-row-title" }, options.title),
      options.subtitle ? h("span", { class: "lib-row-sub" }, options.subtitle) : null),
    ...(options.columns ?? []).map((c) => h("span", { class: "lib-row-col" }, c)),
    options.meta ? h("span", { class: "lib-row-meta" }, options.meta) : null,
    options.actions?.length ? h("div", { class: "lib-row-actions" }, ...options.actions) : null);
  if (options.progress && options.progress > 0) {
    el.append(h("div", { class: "lib-row-prog" }, h("div", { style: { width: `${Math.round(Math.min(1, options.progress) * 100)}%` } })));
  }
  activate(el, options.onOpen, options.onMenu);
  return el;
}

/** A small icon button for a row (class `lib-act` keeps drags from starting on it). */
export function actionButton(iconName: IconName, label: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = h("button", { class: "icon-btn small lib-act", type: "button", title: label, "aria-label": label }, icon(iconName, 15));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  b.addEventListener("keydown", (e) => e.stopPropagation());
  return b;
}

export function emptyState(iconName: IconName, title: string, text: string, action?: { label: string; icon?: IconName; run: () => void }): HTMLElement {
  return h("div", { class: "lib-empty" },
    h("div", { class: "empty-icon" }, icon(iconName, 38)),
    h("h2", null, title),
    h("p", null, text),
    action ? h("button", { class: "btn primary large", type: "button", onclick: action.run }, action.icon ? icon(action.icon, 16) : null, action.label) : null);
}

/** A section heading with an optional "See all" link. */
export function heading(title: string, more?: { label: string; run: () => void }): HTMLElement {
  return h("div", { class: "lib-heading" },
    h("h3", null, title),
    more ? h("button", { class: "text-btn", type: "button", onclick: more.run }, more.label, icon("chevronRight", 14)) : null);
}

/**
 * Appends `items` to `container` a chunk at a time as the end scrolls into view, so a list of
 * thousands of channels or songs stays cheap.
 */
export function renderChunked<T>(container: HTMLElement, items: T[], build: (item: T, index: number) => HTMLElement, chunk = 80) {
  let shown = 0;
  const sentinel = h("div", { class: "lib-more", "aria-hidden": "true" });
  let observer: IntersectionObserver | null = null;
  const more = () => {
    const end = Math.min(items.length, shown + chunk);
    const fragment = document.createDocumentFragment();
    for (; shown < end; shown++) fragment.append(build(items[shown], shown));
    sentinel.before(fragment);
    if (shown >= items.length) {
      observer?.disconnect();
      sentinel.remove();
    }
  };
  container.append(sentinel);
  if (items.length <= chunk) return more();
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) more();
  }, { rootMargin: "600px" });
  observer.observe(sentinel);
  more();
}

interface NameDialog {
  title: string;
  label: string;
  value: string;
  confirm: string;
  placeholder?: string;
}

/** A small dialog asking for a name; resolves with the trimmed text, or null when cancelled. */
export function askName(options: NameDialog): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { class: "lib-field", type: "text", value: options.value, placeholder: options.placeholder ?? "", spellcheck: false, autocomplete: "off" });
    const done = (value: string | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const confirm = h("button", { class: "btn primary", type: "button" }, options.confirm);
    const submit = () => {
      const value = input.value.trim();
      if (value) done(value);
      else input.focus();
    };
    confirm.addEventListener("click", submit);
    const cancel = h("button", { class: "btn", type: "button", onclick: () => done(null) }, "Cancel");
    const overlay = h("div", { class: "modal-overlay lib-dialog" },
      h("div", { class: "modal lib-dialog-card", role: "dialog", "aria-label": options.title },
        h("div", { class: "modal-head" }, h("h2", null, options.title)),
        h("div", { class: "modal-body" }, h("label", { class: "lib-field-label" }, options.label), input),
        h("div", { class: "modal-foot" }, h("span", { class: "lib-grow" }), cancel, confirm)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(null);
      } else if (e.key === "Enter" && document.activeElement === input) {
        e.stopPropagation();
        submit();
      }
    };
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) done(null);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}
