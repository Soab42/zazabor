type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/**
 * Creates an element. `class`, `style` (object), `on<event>` handlers and DOM properties
 * are applied specially; everything else becomes an attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = String(value);
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key.startsWith("on") && typeof value === "function")
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      else if (key in node && typeof value !== "string") (node as unknown as Attrs)[key] = value;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(node: Element, children: Child[]) {
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(typeof child === "number" ? String(child) : child);
  }
}

export function clear(node: Element) {
  while (node.firstChild) node.firstChild.remove();
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  if (target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(target.type);
}

const sizeUnits = ["B", "KB", "MB", "GB"];
export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${sizeUnits[unit]}`;
}

export function formatDate(seconds: number, style: "short" | "long" = "short") {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString(undefined,
    style === "short" ? { year: "numeric", month: "short" } : { year: "numeric", month: "long", day: "numeric" });
}

export function formatDateTime(seconds: number) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export const basename = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export const dirname = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed.slice(0, cut + 1);
};

export const stripExtension = (name: string) => name.replace(/\.[^.]+$/, "");

/** Runs `fn` at most once per animation frame. */
export function rafThrottle(fn: () => void) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}
