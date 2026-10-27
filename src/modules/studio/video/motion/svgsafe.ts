/**
 * SVG logos the user picks are untrusted: one could carry script (event attributes, `<script>`,
 * `javascript:` links, animation events) or reach outside (`<image>`, `<use>` and `url()` to other
 * files, `<style>` with `@import`). In this webview script means Tauri's IPC, so a logo is cut
 * down to plain geometry before anything uses it: shapes, groups, gradients, clips and masks, and
 * `<use>` of its own `#ids`, with presentation attributes only. The parsed document is inert
 * (DOMParser runs nothing and loads nothing); nothing of the original reaches the page.
 *
 * Only DOM Level 2 calls are used, so the tests can run it on @xmldom/xmldom.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Elements kept (lower case). */
const ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "defs", "clippath", "mask", "lineargradient", "radialgradient", "stop", "use",
]);

/** Attributes kept: geometry and presentation (no `style`, no events, no `class`). */
const ATTRIBUTES = new Set([
  "id", "viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr",
  "d", "points", "pathlength", "transform", "preserveaspectratio", "version",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "color", "display", "visibility",
  "vector-effect", "paint-order", "shape-rendering", "clip-path", "clip-rule", "mask", "offset", "stop-color", "stop-opacity",
  "gradientunits", "gradienttransform", "spreadmethod", "clippathunits", "maskunits", "maskcontentunits",
  "href", "xlink:href",
]);

/** `url(#id)` only: a reference inside the logo. */
const LOCAL_URL = /^url\(\s*(["']?)#[A-Za-z0-9_.:-]+\1\s*\)$/;

/** Whether an attribute (already allowed by name) has a value that stays inside the logo. */
function safeValue(name: string, value: string): boolean {
  const v = value.trim();
  if (name === "href" || name === "xlink:href") return /^#[A-Za-z0-9_.:-]+$/.test(v);
  if (/url\s*\(/i.test(v)) return LOCAL_URL.test(v);
  // Nothing that reads like a link or script, even where it would mean nothing.
  return !/(javascript|vbscript|data)\s*:|expression\s*\(|@import|<|>/i.test(v);
}

interface DomNode {
  nodeType: number;
  childNodes: { length: number; item(i: number): DomNode | null } | ArrayLike<DomNode>;
  parentNode: DomNode | null;
  removeChild(child: DomNode): unknown;
}

interface DomElement extends DomNode {
  namespaceURI: string | null;
  localName: string | null;
  nodeName: string;
  attributes: { length: number; item(i: number): { name: string; value: string; namespaceURI: string | null } | null };
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}

const ELEMENT = 1;

function childList(n: DomNode): DomNode[] {
  const list = n.childNodes as { length: number; item?: (i: number) => DomNode | null } & ArrayLike<DomNode>;
  const out: DomNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list.item ? list.item(i) : list[i];
    if (c) out.push(c);
  }
  return out;
}

/** The element's children that are elements. */
export function elementsIn(n: DomNode): DomElement[] {
  return childList(n).filter((c): c is DomElement => c.nodeType === ELEMENT);
}

function clean(el: DomElement) {
  // Attributes: by name, then by value; namespaced ones only for xlink:href and the xmlns declarations.
  const attrs: { name: string; value: string; namespaceURI: string | null }[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i);
    if (a) attrs.push({ name: a.name, value: a.value, namespaceURI: a.namespaceURI });
  }
  for (const a of attrs) {
    const name = a.name.toLowerCase();
    let keep: boolean;
    if (name === "xmlns") keep = a.value === SVG_NS;
    else if (name === "xmlns:xlink") keep = a.value === XLINK_NS;
    else keep = ATTRIBUTES.has(name) && (!a.namespaceURI || (name === "xlink:href" && a.namespaceURI === XLINK_NS)) && safeValue(name, a.value);
    if (!keep) el.removeAttribute(a.name);
  }
  for (const c of childList(el)) {
    if (c.nodeType !== ELEMENT) {
      // Text, comments, CDATA and processing instructions: nothing a shape needs.
      el.removeChild(c);
      continue;
    }
    const child = c as DomElement;
    const name = (child.localName ?? child.nodeName).toLowerCase();
    const href = child.getAttribute("href") ?? child.getAttribute("xlink:href");
    const keep = child.namespaceURI === SVG_NS && ELEMENTS.has(name) && (name !== "use" || (!!href && /^#[A-Za-z0-9_.:-]+$/.test(href.trim())));
    if (!keep) el.removeChild(child);
    else clean(child);
  }
}

/**
 * The geometry of an SVG document, from a parsed (inert) document: its root `<svg>` cleaned in
 * place, or null when it isn't an SVG (or has entity declarations, which logos don't need).
 */
export function sanitizeSvgDocument(doc: { documentElement: unknown }, source: string): DomElement | null {
  if (/<!ENTITY/i.test(source)) return null;
  const root = doc.documentElement as DomElement | null;
  if (!root || root.namespaceURI !== SVG_NS || (root.localName ?? root.nodeName).toLowerCase() !== "svg") return null;
  clean(root);
  return root;
}

/** A user's SVG as safe text (geometry only), or null when it can't be used. */
export function safeSvgText(source: string): string | null {
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  const root = sanitizeSvgDocument(doc, source);
  return root ? new XMLSerializer().serializeToString(root as unknown as Node) : null;
}

/** The cleaned root of a user's SVG, for measuring (never put in the page). */
export function safeSvgRoot(source: string): DomElement | null {
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  return sanitizeSvgDocument(doc, source);
}

export type { DomElement };
