import type { Outline, Picture } from "./player";
import { elementsIn, safeSvgRoot, type DomElement } from "./svgsafe";

/**
 * Outlines for the logo line-draw reveal: an SVG logo's own shapes, or for a picture an outline
 * traced around its shape (its transparency, or what differs from its background colour) with
 * marching squares, smoothed into a few paths.
 */

const MAX_TRACE = 256;

/** A 2D affine matrix [a b c d e f], as SVG's `matrix()`. */
export type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

const numbers = (text: string) => (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/** An SVG `transform` attribute as one matrix (unknown parts are skipped). */
export function parseTransform(text: string | null): Matrix {
  let m = IDENTITY;
  if (!text) return m;
  for (const [, name, args] of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = numbers(args);
    let n: Matrix | null = null;
    const rad = ((v[0] ?? 0) * Math.PI) / 180;
    if (name === "matrix" && v.length >= 6) n = [v[0], v[1], v[2], v[3], v[4], v[5]];
    else if (name === "translate") n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (name === "scale") n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (name === "rotate") {
      const r: Matrix = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
      n = v.length >= 3 ? multiply(multiply([1, 0, 0, 1, v[1], v[2]], r), [1, 0, 0, 1, -v[1], -v[2]]) : r;
    } else if (name === "skewX") n = [1, 0, Math.tan(rad), 1, 0, 0];
    else if (name === "skewY") n = [1, Math.tan(rad), 0, 1, 0, 0];
    if (n) m = multiply(m, n);
  }
  return m;
}

/**
 * Path data as polylines (one per subpath), curves and arcs cut into short straight pieces: for
 * measuring how long a path is without asking the page's SVG engine.
 */
export function flattenPath(d: string): Pt[][] {
  const out: Pt[][] = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  let cmd = "";
  let x = 0, y = 0, sx = 0, sy = 0;
  let cx = 0, cy = 0; // last control point (for S and T)
  let prev = "";
  let line: Pt[] = [];
  const more = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
  // A command cut short ("M10 L") ends the path there.
  let short = false;
  const num = () => {
    if (!more()) {
      short = true;
      return 0;
    }
    return Number(tokens[i++]);
  };
  const start = (px: number, py: number) => {
    if (line.length > 1) out.push(line);
    line = [[px, py]];
  };
  const to = (px: number, py: number) => {
    if (!line.length) line = [[x, y]];
    line.push([px, py]);
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    const n = 16;
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      to(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    const n = 12;
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t;
      to(u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey);
    }
  };
  const arc = (rx: number, ry: number, angle: number, large: boolean, sweep: boolean, ex: number, ey: number) => {
    // SVG's endpoint arc to centre form (SVG 1.1 appendix F.6).
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (!rx || !ry) return to(ex, ey);
    const phi = (angle * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    const scale = Math.max(1, Math.sqrt((x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)));
    rx *= scale;
    ry *= scale;
    const sign = large === sweep ? -1 : 1;
    const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const k = sign * Math.sqrt(Math.max(0, num2 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const cxp = (k * rx * y1) / ry, cyp = (-k * ry * x1) / rx;
    const ccx = cos * cxp - sin * cyp + (x + ex) / 2, ccy = sin * cxp + cos * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 32)));
    for (let s = 1; s <= n; s++) {
      const t = t1 + (dt * s) / n;
      to(ccx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, ccy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
    }
  };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === "Z") {
      to(sx, sy);
      if (line.length > 1) out.push(line);
      line = [];
      x = sx;
      y = sy;
      prev = "Z";
      continue;
    }
    if (!more()) {
      cmd = "";
      continue;
    }
    if (C === "M") {
      const mx = ox + num(), my = oy + num();
      if (short) break;
      x = mx;
      y = my;
      sx = x;
      sy = y;
      start(x, y);
      // Pairs after a moveto are linetos.
      cmd = rel ? "l" : "L";
    } else if (C === "L") {
      const nx = ox + num(), ny = oy + num();
      if (short) break;
      to(nx, ny);
      x = nx;
      y = ny;
    } else if (C === "H") {
      const hx = ox + num();
      if (short) break;
      x = hx;
      to(x, y);
    } else if (C === "V") {
      const vy = oy + num();
      if (short) break;
      y = vy;
      to(x, y);
    } else if (C === "C") {
      const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
      if (short) break;
      cubic(x1, y1, x2, y2, ex, ey);
      cx = x2;
      cy = y2;
      x = ex;
      y = ey;
    } else if (C === "S") {
      const x1 = prev === "C" || prev === "S" ? 2 * x - cx : x, y1 = prev === "C" || prev === "S" ? 2 * y - cy : y;
      const x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
      if (short) break;
      cubic(x1, y1, x2, y2, ex, ey);
      cx = x2;
      cy = y2;
      x = ex;
      y = ey;
    } else if (C === "Q") {
      const x1 = ox + num(), y1 = oy + num(), ex = ox + num(), ey = oy + num();
      if (short) break;
      quad(x1, y1, ex, ey);
      cx = x1;
      cy = y1;
      x = ex;
      y = ey;
    } else if (C === "T") {
      const x1 = prev === "Q" || prev === "T" ? 2 * x - cx : x, y1 = prev === "Q" || prev === "T" ? 2 * y - cy : y;
      const ex = ox + num(), ey = oy + num();
      if (short) break;
      quad(x1, y1, ex, ey);
      cx = x1;
      cy = y1;
      x = ex;
      y = ey;
    } else if (C === "A") {
      const rx = num(), ry = num(), angle = num(), large = num() !== 0, sweep = num() !== 0, ex = ox + num(), ey = oy + num();
      if (short) break;
      arc(rx, ry, angle, large, sweep, ex, ey);
      x = ex;
      y = ey;
    }
    prev = C;
  }
  if (line.length > 1) out.push(line);
  return out;
}

/** A shape of an SVG logo: its path data, where it goes (into the logo's 0…1 box) and how long it is there. */
export interface SvgShape {
  d: string;
  m: Matrix;
  length: number;
}

const SKIP = new Set(["defs", "clippath", "mask", "lineargradient", "radialgradient", "stop"]);
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

/** The drawn shapes of a cleaned SVG root (svgsafe.ts), with lengths, and its aspect. */
export function svgShapes(root: DomElement): { shapes: SvgShape[]; aspect: number } | null {
  const vb = numbers(root.getAttribute("viewBox") ?? "");
  const vw = vb.length === 4 && vb[2] > 0 ? vb[2] : Number.parseFloat(root.getAttribute("width") ?? "") || 100;
  const vh = vb.length === 4 && vb[3] > 0 ? vb[3] : Number.parseFloat(root.getAttribute("height") ?? "") || 100;
  const base = multiply([1 / vw, 0, 0, 1 / vh, 0, 0], [1, 0, 0, 1, vb.length === 4 ? -vb[0] : 0, vb.length === 4 ? -vb[1] : 0]);
  const ids = new Map<string, DomElement>();
  const index = (el: DomElement) => {
    const id = el.getAttribute("id");
    if (id && !ids.has(id)) ids.set(id, el);
    for (const c of elementsIn(el)) index(c);
  };
  index(root);
  const shapes: SvgShape[] = [];
  const walk = (el: DomElement, m: Matrix, depth: number, using: Set<DomElement>) => {
    if (depth > 24 || shapes.length > 2000 || el.getAttribute("display") === "none") return;
    const name = (el.localName ?? el.nodeName).toLowerCase();
    if (SKIP.has(name)) return;
    let here = el === root ? m : multiply(m, parseTransform(el.getAttribute("transform")));
    if (name === "svg" && el !== root) here = multiply(here, [1, 0, 0, 1, Number.parseFloat(el.getAttribute("x") ?? "") || 0, Number.parseFloat(el.getAttribute("y") ?? "") || 0]);
    if (name === "use") {
      const ref = ids.get((el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "").trim().slice(1));
      if (!ref || using.has(ref) || using.size > 8) return;
      const at = multiply(here, [1, 0, 0, 1, Number.parseFloat(el.getAttribute("x") ?? "") || 0, Number.parseFloat(el.getAttribute("y") ?? "") || 0]);
      // A referenced element inside <defs> is drawn here even though <defs> itself isn't.
      walkShape(ref, at, depth + 1, new Set([...using, ref]));
      return;
    }
    if (SHAPES.has(name)) {
      const d = dOf(el);
      if (d) {
        let length = 0;
        for (const line of flattenPath(d)) {
          for (let k = 1; k < line.length; k++) {
            const [ax, ay] = apply(here, line[k - 1]), [bx, by] = apply(here, line[k]);
            length += Math.hypot(bx - ax, by - ay);
          }
        }
        if (length >= 0.004) shapes.push({ d, m: here, length });
      }
      return;
    }
    for (const c of elementsIn(el)) walk(c, here, depth + 1, using);
  };
  const walkShape = (el: DomElement, m: Matrix, depth: number, using: Set<DomElement>) => {
    const name = (el.localName ?? el.nodeName).toLowerCase();
    if (SKIP.has(name)) return;
    walk(el, m, depth, using);
  };
  walk(root, base, 0, new Set());
  return shapes.length ? { shapes, aspect: vw / vh } : null;
}

const apply = (m: Matrix, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** The outline of an SVG logo's shapes, in its own 0…1 box (the SVG is cleaned first and never put in the page). */
export function svgOutline(svgText: string): Outline | null {
  const root = safeSvgRoot(svgText);
  const found = root ? svgShapes(root) : null;
  if (!found) return null;
  const paths: Path2D[] = [];
  const lengths: number[] = [];
  for (const s of found.shapes) {
    const p = new Path2D();
    p.addPath(new Path2D(s.d), new DOMMatrix(s.m));
    paths.push(p);
    lengths.push(s.length);
  }
  return { paths, lengths, aspect: found.aspect };
}

function dOf(el: DomElement): string | null {
  const n = (name: string) => Number.parseFloat(el.getAttribute(name) ?? "0") || 0;
  const tag = (el.localName ?? el.nodeName).toLowerCase();
  switch (tag) {
    case "path": return el.getAttribute("d");
    case "rect": {
      const x = n("x"), y = n("y"), w = n("width"), h = n("height");
      return w > 0 && h > 0 ? `M${x} ${y}h${w}v${h}h${-w}z` : null;
    }
    case "circle": {
      const cx = n("cx"), cy = n("cy"), r = n("r");
      return r > 0 ? `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z` : null;
    }
    case "ellipse": {
      const cx = n("cx"), cy = n("cy"), rx = n("rx"), ry = n("ry");
      return rx > 0 && ry > 0 ? `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z` : null;
    }
    case "line": return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
    case "polyline": case "polygon": {
      const pts = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tag === "polygon" ? `${d}z` : d;
    }
  }
  return null;
}

/**
 * Which cells of a small copy of the picture are part of the logo: its opaque pixels when it has
 * transparency, else those that differ clearly from the colour around its edges.
 */
export function shapeMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  let transparent = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 128) transparent++;
  if (transparent > w * h * 0.04) {
    for (let i = 0; i < w * h; i++) mask[i] = rgba[i * 4 + 3] >= 128 ? 1 : 0;
    return mask;
  }
  // The background: the average of the border pixels.
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    r += rgba[i];
    g += rgba[i + 1];
    b += rgba[i + 2];
    n++;
  };
  for (let x = 0; x < w; x++) (add(x, 0), add(x, h - 1));
  for (let y = 0; y < h; y++) (add(0, y), add(w - 1, y));
  r /= n;
  g /= n;
  b /= n;
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(rgba[i * 4] - r) + Math.abs(rgba[i * 4 + 1] - g) + Math.abs(rgba[i * 4 + 2] - b);
    mask[i] = d > 90 ? 1 : 0;
  }
  return mask;
}

type Pt = [number, number];

/** Marching squares: the boundary of a 0/1 mask as closed polylines (in cell corners). */
export function contours(mask: Uint8Array, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  // Edges between a set cell and an unset one, as directed segments keyed by their start.
  const next = new Map<string, Pt[]>();
  const key = (p: Pt) => `${p[0]},${p[1]}`;
  const push = (a: Pt, b: Pt) => {
    const k = key(a);
    const list = next.get(k);
    if (list) list.push(b);
    else next.set(k, [b]);
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const c = at(x, y);
      if (at(x + 1, y) !== c) {
        // A vertical edge at x+1 between rows y and y+1, oriented so the set side is on the left.
        if (c) push([x + 1, y + 1], [x + 1, y]);
        else push([x + 1, y], [x + 1, y + 1]);
      }
      if (at(x, y + 1) !== c) {
        if (c) push([x, y + 1], [x + 1, y + 1]);
        else push([x + 1, y + 1], [x, y + 1]);
      }
    }
  }
  const loops: Pt[][] = [];
  for (const startKey of [...next.keys()]) {
    while (next.get(startKey)?.length) {
      const [sx, sy] = startKey.split(",").map(Number);
      const loop: Pt[] = [[sx, sy]];
      let cur: Pt = [sx, sy];
      for (let guard = 0; guard < w * h * 4 + 8; guard++) {
        const list = next.get(key(cur));
        if (!list?.length) break;
        const p = list.pop()!;
        if (!list.length) next.delete(key(cur));
        if (p[0] === sx && p[1] === sy) break;
        loop.push(p);
        cur = p;
      }
      if (loop.length > 3) loops.push(loop);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker on a closed loop. */
export function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 4) return points;
  const rdp = (pts: Pt[]): Pt[] => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = 0, at = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / len;
      if (d > far) (far = d), (at = i);
    }
    if (far <= epsilon) return [pts[0], pts[pts.length - 1]];
    return [...rdp(pts.slice(0, at + 1)).slice(0, -1), ...rdp(pts.slice(at))];
  };
  const half = Math.floor(points.length / 2);
  return [...rdp(points.slice(0, half + 1)).slice(0, -1), ...rdp([...points.slice(half), points[0]]).slice(0, -1)];
}

/** A picture's outline: traced on a copy at most 256 pixels across, in its own 0…1 box. */
export function traceOutline(pic: Picture): Outline | null {
  const pw = "naturalWidth" in pic ? pic.naturalWidth : pic.width;
  const ph = "naturalHeight" in pic ? pic.naturalHeight : pic.height;
  if (!pw || !ph) return null;
  const k = Math.min(1, MAX_TRACE / Math.max(pw, ph));
  const w = Math.max(8, Math.round(pw * k)), h = Math.max(8, Math.round(ph * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(pic, 0, 0, w, h);
  const mask = shapeMask(g.getImageData(0, 0, w, h).data, w, h);
  const loops = contours(mask, w, h)
    .map((l) => simplify(l, 0.9))
    .filter((l) => l.length >= 3)
    .map((l) => ({ l, len: l.reduce((s, p, i) => s + Math.hypot(p[0] - l[(i + 1) % l.length][0], p[1] - l[(i + 1) % l.length][1]), 0) }))
    .filter((x) => x.len > (w + h) * 0.03)
    .sort((a, b) => b.len - a.len)
    .slice(0, 40);
  if (!loops.length) return null;
  const paths: Path2D[] = [];
  const lengths: number[] = [];
  for (const { l, len } of loops) {
    const p = new Path2D();
    p.moveTo(l[0][0] / w, l[0][1] / h);
    // Through the midpoints with the corners as control points: smooth curves, not stair steps.
    for (let i = 1; i <= l.length; i++) {
      const c = l[i % l.length], n = l[(i + 1) % l.length];
      p.quadraticCurveTo(c[0] / w, c[1] / h, (c[0] + n[0]) / 2 / w, (c[1] + n[1]) / 2 / h);
    }
    p.closePath();
    paths.push(p);
    lengths.push(len / ((w + h) / 2));
  }
  return { paths, lengths, aspect: pw / ph };
}
