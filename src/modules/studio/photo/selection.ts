import type { Rect } from "./engine";

/**
 * Selections: an 8-bit mask the size of the document (255 selected, 0 not, values between for
 * feathered edges), built and changed on the CPU. The GPU gets a copy for painting and
 * adjustments, and the outline is traced once per change for the marching ants.
 */

export type SelectMode = "new" | "add" | "subtract" | "intersect";

export interface Selection {
  width: number;
  height: number;
  data: Uint8Array;
  /** The smallest rectangle holding every selected pixel. */
  bounds: Rect;
}

/** Finds the bounds of a mask; null when nothing is selected. */
export function maskBounds(data: Uint8Array, width: number, height: number): Rect | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1, last = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function makeSelection(data: Uint8Array, width: number, height: number): Selection | null {
  const bounds = maskBounds(data, width, height);
  return bounds ? { width, height, data, bounds } : null;
}

export function selectAll(width: number, height: number): Selection {
  return { width, height, data: new Uint8Array(width * height).fill(255), bounds: { x: 0, y: 0, w: width, h: height } };
}

/**
 * A polygon filled with the even-odd rule, anti-aliased with 4 rows of samples per pixel row
 * and exact horizontal coverage. Points are document pixels (edges between pixel centres).
 */
export function polygonMask(points: [number, number][], width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (points.length < 3) return out;
  const acc = new Float32Array(width);
  const SUB = 4;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    acc.fill(0);
    let any = false;
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB;
      xs.length = 0;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi <= sy && yj > sy) || (yj <= sy && yi > sy)) xs.push(xi + ((sy - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, xs[k]), b = Math.min(width, xs[k + 1]);
        if (b <= a) continue;
        any = true;
        const ia = Math.floor(a), ib = Math.floor(b);
        if (ia === ib) {
          if (ia < width) acc[ia] += b - a;
          continue;
        }
        acc[ia] += ia + 1 - a;
        for (let x = ia + 1; x < ib; x++) acc[x] += 1;
        if (ib < width) acc[ib] += b - ib;
      }
    }
    if (!any) continue;
    const row = y * width;
    for (let x = 0; x < width; x++) if (acc[x] > 0) out[row + x] = Math.min(255, Math.round((acc[x] / SUB) * 255));
  }
  return out;
}

/** A rectangle or ellipse as a polygon (ellipses get enough points to look round). */
export function shapePoints(rect: Rect, ellipse: boolean): [number, number][] {
  if (!ellipse) return [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]];
  const n = Math.max(32, Math.min(720, Math.round((rect.w + rect.h) * 0.8)));
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  return Array.from({ length: n }, (_, i) => [cx + (Math.cos((i / n) * Math.PI * 2) * rect.w) / 2, cy + (Math.sin((i / n) * Math.PI * 2) * rect.h) / 2] as [number, number]);
}

/** `next` combined with the current selection data (null: nothing selected). */
export function combine(current: Uint8Array | null, next: Uint8Array, mode: SelectMode): Uint8Array {
  if (mode === "new") return next;
  if (!current) return mode === "add" ? next : new Uint8Array(next.length);
  return apply(current, next, mode);
}

function apply(a: Uint8Array, b: Uint8Array, mode: SelectMode): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    out[i] = mode === "add" ? Math.max(x, y) : mode === "subtract" ? Math.round((x * (255 - y)) / 255) : Math.round((x * y) / 255);
  }
  return out;
}

export function invert(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = 255 - data[i];
  return out;
}

/** One box blur pass along rows (or columns when `vertical`), radius `r`, with a running sum. */
function boxPass(src: Float32Array, dst: Float32Array, width: number, height: number, r: number, vertical: boolean) {
  const [lines, len, stride, step] = vertical ? [width, height, 1, width] : [height, width, width, 1];
  const span = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    const base = line * stride;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[base + Math.min(len - 1, Math.max(0, i)) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum / span;
      const add = Math.min(len - 1, i + r + 1), drop = Math.max(0, i - r);
      sum += src[base + add * step] - src[base + drop * step];
    }
  }
}

/** Gaussian-like blur of a mask by three box blurs (Feather). */
export function feather(data: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius < 0.5) return data.slice();
  // Three boxes whose variance adds up to the Gaussian's (sigma = radius / 2, as Photoshop's
  // feather radius reaches about two sigmas).
  const sigma = radius / 2;
  const box = Math.max(1, Math.round((Math.sqrt((12 * sigma * sigma) / 3 + 1) - 1) / 2));
  let a = Float32Array.from(data);
  let b = new Float32Array(a.length);
  for (let k = 0; k < 3; k++) {
    boxPass(a, b, width, height, box, false);
    [a, b] = [b, a];
    boxPass(a, b, width, height, box, true);
    [a, b] = [b, a];
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(a[i]);
  return out;
}

/** Squared distances to the nearest pixel where `inside` is true (Felzenszwalb's transform). */
function distanceSquared(inside: (i: number) => boolean, width: number, height: number): Float32Array {
  const INF = 1e20;
  const f = new Float32Array(Math.max(width, height));
  const d = new Float32Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float32Array(Math.max(width, height) + 1);
  const grid = new Float32Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = inside(i) ? 0 : INF;
  const pass = (n: number, get: (i: number) => number, set: (i: number, val: number) => void) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let i = 0; i < n; i++) set(i, d[i]);
  };
  for (let x = 0; x < width; x++) pass(height, (i) => grid[i * width + x], (i, val) => (grid[i * width + x] = val));
  for (let y = 0; y < height; y++) pass(width, (i) => grid[y * width + i], (i, val) => (grid[y * width + i] = val));
  return grid;
}

/** Grows (positive `by`) or shrinks the selection by whole pixels, with round corners. */
export function expand(data: Uint8Array, width: number, height: number, by: number): Uint8Array {
  const out = new Uint8Array(data.length);
  if (by === 0) return data.slice();
  const r2 = by * by;
  if (by > 0) {
    const dist = distanceSquared((i) => data[i] >= 128, width, height);
    for (let i = 0; i < out.length; i++) out[i] = dist[i] <= r2 ? 255 : 0;
  } else {
    const dist = distanceSquared((i) => data[i] < 128, width, height);
    // Pixels at the document's edge count as next to unselected space only inside it.
    for (let i = 0; i < out.length; i++) out[i] = data[i] >= 128 && dist[i] > r2 ? 255 : 0;
  }
  return out;
}

/** Select ▸ Color Range: pixels near `color` (0–255 RGB), softly, within `fuzziness` (0–200). */
export function colorRange(rgba: Uint8Array, width: number, height: number, color: [number, number, number], fuzziness: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const f = Math.max(1, fuzziness);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    if (rgba[p + 3] === 0) continue;
    const d = Math.hypot(rgba[p] - color[0], rgba[p + 1] - color[1], rgba[p + 2] - color[2]);
    const v = 1 - d / f;
    if (v > 0) out[i] = Math.round(Math.min(1, v * 1.5) * (rgba[p + 3] / 255) * 255);
  }
  return out;
}

/** Moves a mask by whole pixels; what moves in from outside is unselected. */
export function translate(data: Uint8Array, width: number, height: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < width) out[y * width + x] = data[sy * width + sx];
    }
  }
  return out;
}

/**
 * The outline of the selection (pixels at least half selected) as a path in document pixels:
 * horizontal and vertical edges between selected and unselected pixels, joined into runs. Very
 * busy selections are traced on a coarser grid so drawing stays quick.
 */
export function outlinePath(sel: Selection): Path2D {
  const { width, height, data, bounds } = sel;
  let step = 1;
  const area = bounds.w * bounds.h;
  if (area > 16_000_000) step = 4;
  else if (area > 4_000_000) step = 2;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] >= 128;
  const path = new Path2D();
  const x0 = Math.max(0, bounds.x - step), x1 = Math.min(width, bounds.x + bounds.w + step);
  const y0 = Math.max(0, bounds.y - step), y1 = Math.min(height, bounds.y + bounds.h + step);
  // Horizontal edges: between row y-1 and row y.
  for (let y = y0; y <= y1; y += step) {
    let start = -1;
    for (let x = x0; x <= x1; x += step) {
      const edge = x < x1 && on(x, y - step) !== on(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        path.moveTo(start, y);
        path.lineTo(x, y);
        start = -1;
      }
    }
  }
  for (let x = x0; x <= x1; x += step) {
    let start = -1;
    for (let y = y0; y <= y1; y += step) {
      const edge = y < y1 && on(x - step, y) !== on(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        path.moveTo(x, start);
        path.lineTo(x, y);
        start = -1;
      }
    }
  }
  return path;
}
