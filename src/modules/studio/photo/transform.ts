import { applyAffine, type Affine, type Rect } from "./engine";

/**
 * Free Transform's maths. A box (the layer or the selection, document pixels) is scaled, flipped,
 * skewed, rotated and moved about its centre:
 *   p' = C + t + R(angle) · K(skew) · S(sx · flipX, sy · flipY) · (p − C)
 * Handles sit on the transformed box; dragging one changes these numbers.
 */

export interface TransformParams {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** Radians, clockwise on screen. */
  angle: number;
  /** Horizontal skew: x moves by skew × y. */
  skew: number;
  flipX: boolean;
  flipY: boolean;
}

export const IDENTITY_PARAMS: TransformParams = { tx: 0, ty: 0, sx: 1, sy: 1, angle: 0, skew: 0, flipX: false, flipY: false };

export const isIdentityParams = (p: TransformParams) =>
  p.tx === 0 && p.ty === 0 && p.sx === 1 && p.sy === 1 && p.angle === 0 && p.skew === 0 && !p.flipX && !p.flipY;

/** R · K: the scaled box's frame to document offsets. */
function frame(p: TransformParams): [number, number, number, number] {
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  // R = [c -s; s c], K = [1 k; 0 1] → R·K = [c, c·k − s; s, s·k + c]
  return [c, s, c * p.skew - s, s * p.skew + c];
}

/** The map from source document pixels to transformed document pixels. */
export function transformMap(box: Rect, p: TransformParams): Affine {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const [a, b, c, d] = frame(p);
  const sx = p.sx * (p.flipX ? -1 : 1), sy = p.sy * (p.flipY ? -1 : 1);
  // M = F · S: columns scaled.
  const m0 = a * sx, m1 = b * sx, m2 = c * sy, m3 = d * sy;
  return [m0, m1, m2, m3, cx + p.tx - (m0 * cx + m2 * cy), cy + p.ty - (m1 * cx + m3 * cy)];
}

/** The transformed box's corners (nw, ne, se, sw) in document pixels. */
export function corners(box: Rect, p: TransformParams): [number, number][] {
  // Flips mirror the content, not the box: handles stay where they look.
  const m = transformMap(box, { ...p, flipX: false, flipY: false });
  return [[box.x, box.y], [box.x + box.w, box.y], [box.x + box.w, box.y + box.h], [box.x, box.y + box.h]].map(([x, y]) => applyAffine(m, x, y));
}

/** The integer document rectangle holding the transformed box. */
export function outBounds(box: Rect, p: TransformParams): Rect {
  const pts = corners(box, p);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, w: Math.max(1, Math.ceil(Math.max(...xs)) - x), h: Math.max(1, Math.ceil(Math.max(...ys)) - y) };
}

/** Handles by name, with their direction in the box: (−1, −1) is the top-left corner. */
export const HANDLES: { id: string; hx: number; hy: number }[] = [
  { id: "nw", hx: -1, hy: -1 }, { id: "n", hx: 0, hy: -1 }, { id: "ne", hx: 1, hy: -1 }, { id: "e", hx: 1, hy: 0 },
  { id: "se", hx: 1, hy: 1 }, { id: "s", hx: 0, hy: 1 }, { id: "sw", hx: -1, hy: 1 }, { id: "w", hx: -1, hy: 0 },
];

/** A handle's position in document pixels. */
export function handlePoint(box: Rect, p: TransformParams, hx: number, hy: number): [number, number] {
  const m = transformMap(box, { ...p, flipX: false, flipY: false });
  return applyAffine(m, box.x + ((hx + 1) / 2) * box.w, box.y + ((hy + 1) / 2) * box.h);
}

/** Into the scaled box's own frame: document offset from the transformed centre, unrotated and unskewed. */
function toLocal(box: Rect, p: TransformParams, x: number, y: number): [number, number] {
  const cx = box.x + box.w / 2 + p.tx, cy = box.y + box.h / 2 + p.ty;
  const [a, b, c, d] = frame(p);
  const det = a * d - b * c || 1e-12;
  const dx = x - cx, dy = y - cy;
  return [(d * dx - c * dy) / det, (-b * dx + a * dy) / det];
}

function fromLocal(p: TransformParams, lx: number, ly: number): [number, number] {
  const [a, b, c, d] = frame(p);
  return [a * lx + c * ly, b * lx + d * ly];
}

export type TransformDrag =
  | { mode: "move"; start: [number, number]; from: TransformParams }
  | { mode: "rotate"; start: [number, number]; from: TransformParams }
  | { mode: "scale"; hx: number; hy: number; from: TransformParams }
  | { mode: "skew"; hy: number; start: [number, number]; from: TransformParams };

/**
 * What a pointer at document (x, y) would drag: a handle (within `tol` document pixels), the box
 * (move), or outside it (rotate). `skew` asks for skewing on the top and bottom edges.
 */
export function hitTransform(box: Rect, p: TransformParams, x: number, y: number, tol: number, skew: boolean): TransformDrag {
  for (const h of HANDLES) {
    const [hx, hy] = handlePoint(box, p, h.hx, h.hy);
    if (Math.hypot(x - hx, y - hy) <= tol) {
      if (skew && h.hx === 0) return { mode: "skew", hy: h.hy, start: [x, y], from: { ...p } };
      return { mode: "scale", hx: h.hx, hy: h.hy, from: { ...p } };
    }
  }
  const [lx, ly] = toLocal(box, p, x, y);
  const inside = Math.abs(lx) <= (p.sx * box.w) / 2 && Math.abs(ly) <= (p.sy * box.h) / 2;
  return inside ? { mode: "move", start: [x, y], from: { ...p } } : { mode: "rotate", start: [x, y], from: { ...p } };
}

/**
 * The parameters while dragging to (x, y). Corners scale in proportion unless `free` (Shift, as
 * in Photoshop since 2019); rotation snaps to 15° with `snap`.
 */
export function dragTransform(box: Rect, drag: TransformDrag, x: number, y: number, free: boolean, snap: boolean): TransformParams {
  const p = { ...drag.from };
  if (drag.mode === "move") {
    p.tx = drag.from.tx + x - drag.start[0];
    p.ty = drag.from.ty + y - drag.start[1];
    return p;
  }
  const cx = box.x + box.w / 2 + drag.from.tx, cy = box.y + box.h / 2 + drag.from.ty;
  if (drag.mode === "rotate") {
    let angle = drag.from.angle + Math.atan2(y - cy, x - cx) - Math.atan2(drag.start[1] - cy, drag.start[0] - cx);
    if (snap) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
    p.angle = angle;
    return p;
  }
  if (drag.mode === "skew") {
    const [lx0] = toLocal(box, drag.from, drag.start[0], drag.start[1]);
    const [lx] = toLocal(box, drag.from, x, y);
    p.skew = drag.from.skew + ((lx - lx0) / ((drag.from.sy * box.h) / 2)) * drag.hy;
    return p;
  }
  const { hx, hy, from } = drag;
  const [qx, qy] = toLocal(box, from, x, y);
  const hw = (from.sx * box.w) / 2, hh = (from.sy * box.h) / 2;
  // The opposite handle stays put.
  const ax = -hx * hw, ay = -hy * hh;
  let sx = from.sx, sy = from.sy;
  if (hx && hy && !free) {
    const dx = hx * 2 * hw, dy = hy * 2 * hh;
    const f = Math.max(0.001, ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy));
    sx = from.sx * f;
    sy = from.sy * f;
  } else {
    if (hx) sx = Math.max(1 / box.w, ((qx - ax) * hx) / box.w);
    if (hy) sy = Math.max(1 / box.h, ((qy - ay) * hy) / box.h);
  }
  p.sx = sx;
  p.sy = sy;
  // The new centre in the old frame, then back to a document offset.
  const ncx = hx ? ax + (hx * sx * box.w) / 2 : 0;
  const ncy = hy ? ay + (hy * sy * box.h) / 2 : 0;
  const [ox, oy] = fromLocal(from, ncx, ncy);
  p.tx = from.tx + ox;
  p.ty = from.ty + oy;
  return p;
}

/** The cursor for a drag mode. */
export function transformCursor(drag: TransformDrag): string {
  if (drag.mode === "move") return "move";
  if (drag.mode === "rotate") return "alias";
  if (drag.mode === "skew") return "ew-resize";
  const { hx, hy } = drag;
  if (!hx) return "ns-resize";
  if (!hy) return "ew-resize";
  return hx === hy ? "nwse-resize" : "nesw-resize";
}
