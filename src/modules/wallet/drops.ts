import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * Files dropped from the desktop onto a transaction (a row, or its sheet) become its receipts.
 * The webview reports drops for the whole window, so a target claims the drop while the pointer
 * is over it: `body.drop-claimed` tells the shell not to open the files itself.
 */
interface Target {
  el: HTMLElement;
  /** The part under the pointer that takes the drop (a row in a list); `el` itself without it. */
  pick?(under: Element): HTMLElement | null;
  accept(paths: string[], at: HTMLElement): void;
}

const targets: Target[] = [];
let listening: Promise<unknown> | null = null;
let current: { target: Target; at: HTMLElement } | null = null;
let paths: string[] = [];

export const RECEIPT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "heic", "bmp", "tif", "tiff", "pdf"];

export function isReceipt(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return RECEIPT_EXTENSIONS.includes(ext);
}

function targetAt(x: number, y: number): { target: Target; at: HTMLElement } | null {
  if (!paths.some(isReceipt)) return null;
  const dpr = window.devicePixelRatio || 1;
  const under = document.elementFromPoint(x / dpr, y / dpr);
  if (!under) return null;
  // The newest target first: a sheet over the list wins.
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    if (!t.el.isConnected || !t.el.contains(under)) continue;
    const at = t.pick ? t.pick(under) : t.el;
    if (at) return { target: t, at };
    // A sheet covers what's under it, picked or not.
    if (!t.pick) return null;
  }
  return null;
}

function hover(next: { target: Target; at: HTMLElement } | null) {
  if (next?.at === current?.at) return;
  current?.at.classList.remove("wl-drop-over");
  current = next;
  current?.at.classList.add("wl-drop-over");
  document.body.classList.toggle("drop-claimed", !!current);
}

function listen() {
  listening ??= getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (document.body.classList.contains("file-picker-open") || document.body.classList.contains("app-locked")) return hover(null);
    if (p.type === "enter") {
      paths = p.paths;
      hover(targetAt(p.position.x, p.position.y));
    } else if (p.type === "over") {
      hover(targetAt(p.position.x, p.position.y));
    } else if (p.type === "drop") {
      paths = p.paths;
      const hit = targetAt(p.position.x, p.position.y);
      if (hit) hit.target.accept(p.paths.filter(isReceipt), hit.at);
      // The shell reads the claim on this same event; let it go after that.
      setTimeout(() => hover(null), 120);
    } else {
      hover(null);
    }
  });
}

/** Makes `el` take dropped pictures and PDFs; returns the function that stops it. */
export function dropTarget(el: HTMLElement, accept: (paths: string[], at: HTMLElement) => void, pick?: (under: Element) => HTMLElement | null): () => void {
  const target: Target = { el, accept, pick };
  targets.push(target);
  listen();
  return () => {
    const i = targets.indexOf(target);
    if (i >= 0) targets.splice(i, 1);
    if (current?.target === target) hover(null);
  };
}
