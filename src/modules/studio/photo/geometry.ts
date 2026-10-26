/**
 * Quick Edit's crop, straighten, rotate and flip. The picture is flipped, turned by quarter turns,
 * then straightened about its centre and zoomed just enough that no empty corner shows; the crop is
 * a rectangle of that frame (0–1 on each side). One matrix maps an output position back to the
 * source, so the preview and the saved file sample the same places.
 */
export interface Geometry {
  /** Quarter turns clockwise, 0–3. */
  quarter: number;
  /** Mirrored left to right, then up and down, in the source picture (before turning). */
  flipH: boolean;
  flipV: boolean;
  /** Straighten, in degrees (−45 to 45); positive turns the picture clockwise. */
  angle: number;
  /** The kept part of the frame, 0–1. */
  crop: { x: number; y: number; w: number; h: number };
}

export const DEFAULT_GEOMETRY: Geometry = { quarter: 0, flipH: false, flipV: false, angle: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };

export const cloneGeometry = (g: Geometry): Geometry => ({ ...g, crop: { ...g.crop } });

export const isIdentity = (g: Geometry) =>
  g.quarter === 0 && !g.flipH && !g.flipV && g.angle === 0 && g.crop.x === 0 && g.crop.y === 0 && g.crop.w === 1 && g.crop.h === 1;

export function normalizeGeometry(raw: unknown): Geometry {
  const g = cloneGeometry(DEFAULT_GEOMETRY);
  if (!raw || typeof raw !== "object") return g;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  g.quarter = Math.round(num(r.quarter, 0, 3, 0));
  g.flipH = r.flipH === true;
  g.flipV = r.flipV === true;
  g.angle = num(r.angle, -45, 45, 0);
  const c = (r.crop ?? {}) as Record<string, unknown>;
  g.crop.x = num(c.x, 0, 1, 0);
  g.crop.y = num(c.y, 0, 1, 0);
  g.crop.w = num(c.w, 0.001, 1 - g.crop.x, 1 - g.crop.x);
  g.crop.h = num(c.h, 0.001, 1 - g.crop.y, 1 - g.crop.y);
  return g;
}

/** The turned picture's size (the frame), before cropping. */
export function frameSize(g: Geometry, width: number, height: number): [number, number] {
  return g.quarter % 2 === 1 ? [height, width] : [width, height];
}

/** The saved picture's size in pixels, at the source's resolution. */
export function outputSize(g: Geometry, width: number, height: number): [number, number] {
  const [fw, fh] = frameSize(g, width, height);
  return [Math.max(1, Math.round(g.crop.w * fw)), Math.max(1, Math.round(g.crop.h * fh))];
}

/** How much straightening zooms in so the turned picture still covers its frame. */
export function straightenZoom(angle: number, fw: number, fh: number): number {
  const t = (Math.abs(angle) * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return Math.max((fw * c + fh * s) / fw, (fw * s + fh * c) / fh);
}

/**
 * A column-major 3×3 matrix (for `uniformMatrix3fv`) taking a position in the output (0–1, top
 * left first) to the source texture's coordinates (0–1, top row first). With `whole`, the output
 * is the whole frame, as the crop tool shows it.
 */
export function outputToSource(g: Geometry, width: number, height: number, whole = false): Float32Array {
  const [fw, fh] = frameSize(g, width, height);
  const crop = whole ? DEFAULT_GEOMETRY.crop : g.crop;
  // Output 0–1 → frame pixels about the centre.
  let m = mat(crop.w * fw, 0, (crop.x - 0.5) * fw, 0, crop.h * fh, (crop.y - 0.5) * fh);
  // Undo the straighten: turn back by the angle and zoom out.
  const t = (-g.angle * Math.PI) / 180;
  const z = 1 / straightenZoom(g.angle, fw, fh);
  m = mul(mat(Math.cos(t) * z, -Math.sin(t) * z, 0, Math.sin(t) * z, Math.cos(t) * z, 0), m);
  // Frame pixels → turned picture 0–1.
  m = mul(mat(1 / fw, 0, 0.5, 0, 1 / fh, 0.5), m);
  // Undo the quarter turns: (a, b) in the turned picture is a source position.
  const q = ((g.quarter % 4) + 4) % 4;
  const unturn = q === 1 ? mat(0, 1, 0, -1, 0, 1) : q === 2 ? mat(-1, 0, 1, 0, -1, 1) : q === 3 ? mat(0, -1, 1, 1, 0, 0) : mat(1, 0, 0, 0, 1, 0);
  m = mul(unturn, m);
  m = mul(mat(g.flipH ? -1 : 1, 0, g.flipH ? 1 : 0, 0, g.flipV ? -1 : 1, g.flipV ? 1 : 0), m);
  // Row-major [a b c; d e f; 0 0 1] → column-major.
  return new Float32Array([m[0], m[3], 0, m[1], m[4], 0, m[2], m[5], 1]);
}

type Mat = [number, number, number, number, number, number];
const mat = (a: number, b: number, c: number, d: number, e: number, f: number): Mat => [a, b, c, d, e, f];
/** p · q for affine matrices [a b c; d e f]. */
function mul(p: Mat, q: Mat): Mat {
  return [
    p[0] * q[0] + p[1] * q[3], p[0] * q[1] + p[1] * q[4], p[0] * q[2] + p[1] * q[5] + p[2],
    p[3] * q[0] + p[4] * q[3], p[3] * q[1] + p[4] * q[4], p[3] * q[2] + p[4] * q[5] + p[5],
  ];
}

/** Turns the picture a quarter clockwise (1) or anticlockwise (−1), keeping the crop on the same part. */
export function rotateQuarter(g: Geometry, dir: 1 | -1): Geometry {
  const next = cloneGeometry(g);
  next.quarter = (g.quarter + (dir === 1 ? 1 : 3)) % 4;
  const { x, y, w, h } = g.crop;
  next.crop = dir === 1 ? { x: 1 - y - h, y: x, w: h, h: w } : { x: y, y: 1 - x - w, w: h, h: w };
  return next;
}

/** Mirrors the picture as it shows on screen: left to right, or up and down. */
export function flipShown(g: Geometry, horizontal: boolean): Geometry {
  const next = cloneGeometry(g);
  // A flip happens before the quarter turns, so on a turned picture it's the other axis.
  if (horizontal !== (g.quarter % 2 === 1)) next.flipH = !g.flipH;
  else next.flipV = !g.flipV;
  next.angle = -g.angle;
  const { x, y, w, h } = g.crop;
  next.crop = horizontal ? { x: 1 - x - w, y, w, h } : { x, y: 1 - y - h, w, h };
  return next;
}

/** The largest crop of `ratio` (width / height in pixels) centred on the current one. */
export function fitRatio(g: Geometry, ratio: number | null, width: number, height: number): Geometry {
  const next = cloneGeometry(g);
  if (!ratio) return next;
  const [fw, fh] = frameSize(g, width, height);
  const cx = g.crop.x + g.crop.w / 2, cy = g.crop.y + g.crop.h / 2;
  // In frame units, w/h = ratio · fh / fw.
  const r = (ratio * fh) / fw;
  let w = Math.min(1, r), h = w / r;
  if (h > 1) {
    h = 1;
    w = r;
  }
  // Keep about the size of the current crop when it was smaller.
  const k = Math.min(1, Math.max(g.crop.w / w, g.crop.h / h));
  w *= k;
  h *= k;
  next.crop = { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
  return next;
}
