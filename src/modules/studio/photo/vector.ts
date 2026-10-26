/**
 * Text and shape layers: what they say or draw, kept editable, and drawn into pixels with Canvas
 * 2D (the browser shapes Bangla and other scripts). Positions are document pixels.
 */

export type TextAlign = "left" | "center" | "right";

export interface TextSource {
  kind: "text";
  text: string;
  font: string;
  /** Font size in document pixels. */
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Line height as a multiple of the size. */
  lineHeight: number;
  /** The anchor: the left edge, centre or right edge (by `align`) of the top of the first line. */
  x: number;
  y: number;
}

export type ShapeKind = "rect" | "ellipse" | "line" | "polygon";

export interface ShapeSource {
  kind: "shape";
  shape: ShapeKind;
  /** The box the shape fills; a line runs from (x, y) to (x + w, y + h). */
  x: number;
  y: number;
  w: number;
  h: number;
  sides: number;
  /** Corner radius of a rectangle. */
  radius: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
}

export type LayerSource = TextSource | ShapeSource;

export const FONTS = ["Sans", "Serif", "Monospace", "Noto Sans", "Noto Serif", "Noto Sans Bengali", "Ubuntu", "DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif", "Cantarell", "Fira Sans"];

export const SHAPES: { id: ShapeKind; label: string }[] = [
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "polygon", label: "Polygon" },
  { id: "line", label: "Line" },
];

/** CSS for a font family name: generic families as they are, others quoted. */
export function fontFamily(name: string): string {
  const generic: Record<string, string> = { Sans: "sans-serif", Serif: "serif", Monospace: "monospace" };
  return generic[name] ?? `"${name.replace(/["\\]/g, "")}", sans-serif`;
}

export function cssFont(t: TextSource, size = t.size): string {
  return `${t.italic ? "italic " : ""}${t.bold ? "700 " : "400 "}${size}px ${fontFamily(t.font)}`;
}

/** Pixels drawn for a layer: straight RGBA, `width`×`height`, placed at (x, y) in the document. */
export interface Drawn {
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8Array;
}

function readCanvas(canvas: HTMLCanvasElement, x: number, y: number): Drawn {
  const ctx = canvas.getContext("2d")!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { x, y, width: canvas.width, height: canvas.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** The lines of a text and the box they take, relative to the anchor. */
export function measureText(t: TextSource): { lines: string[]; widths: number[]; width: number; height: number; left: number } {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = cssFont(t);
  const lines = t.text.split("\n");
  const widths = lines.map((l) => ctx.measureText(l).width);
  const width = Math.max(1, ...widths);
  const height = Math.max(1, lines.length * t.size * t.lineHeight);
  const left = t.align === "left" ? 0 : t.align === "center" ? -width / 2 : -width;
  return { lines, widths, width, height, left };
}

export function drawText(t: TextSource): Drawn {
  const m = measureText(t);
  // Room for italics, descenders and accents beyond the measured box.
  const pad = Math.ceil(t.size * 0.35) + 2;
  const x = Math.floor(t.x + m.left - pad), y = Math.floor(t.y - pad);
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(16384, Math.ceil(m.width + pad * 2));
  canvas.height = Math.min(16384, Math.ceil(m.height + pad * 2));
  const ctx = canvas.getContext("2d")!;
  ctx.font = cssFont(t);
  ctx.fillStyle = t.color;
  ctx.textBaseline = "alphabetic";
  const ascent = t.size * 0.8 + (t.size * (t.lineHeight - 1)) / 2;
  m.lines.forEach((line, i) => {
    const lx = t.x + m.left + (t.align === "left" ? 0 : t.align === "center" ? (m.width - m.widths[i]) / 2 : m.width - m.widths[i]);
    ctx.fillText(line, lx - x, t.y - y + ascent + i * t.size * t.lineHeight);
  });
  return readCanvas(canvas, x, y);
}

/** A shape's outline as a path, relative to (ox, oy). */
function shapePath(ctx: CanvasRenderingContext2D, s: ShapeSource, ox: number, oy: number) {
  const x = Math.min(s.x, s.x + s.w) - ox, y = Math.min(s.y, s.y + s.h) - oy;
  const w = Math.abs(s.w), hgt = Math.abs(s.h);
  ctx.beginPath();
  if (s.shape === "line") {
    ctx.moveTo(s.x - ox, s.y - oy);
    ctx.lineTo(s.x + s.w - ox, s.y + s.h - oy);
  } else if (s.shape === "ellipse") {
    ctx.ellipse(x + w / 2, y + hgt / 2, w / 2, hgt / 2, 0, 0, Math.PI * 2);
  } else if (s.shape === "polygon") {
    const n = Math.max(3, Math.round(s.sides));
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const px = x + w / 2 + (Math.cos(a) * w) / 2, py = y + hgt / 2 + (Math.sin(a) * hgt) / 2;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
  } else {
    const r = Math.max(0, Math.min(s.radius, w / 2, hgt / 2));
    if (r > 0) ctx.roundRect(x, y, w, hgt, r);
    else ctx.rect(x, y, w, hgt);
  }
}

export function drawShape(s: ShapeSource): Drawn {
  const stroke = s.stroke && s.strokeWidth > 0 ? s.strokeWidth : 0;
  const pad = Math.ceil(stroke / 2) + 2;
  const x = Math.floor(Math.min(s.x, s.x + s.w) - pad), y = Math.floor(Math.min(s.y, s.y + s.h) - pad);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.min(16384, Math.ceil(Math.abs(s.w) + pad * 2) + 1));
  canvas.height = Math.max(1, Math.min(16384, Math.ceil(Math.abs(s.h) + pad * 2) + 1));
  const ctx = canvas.getContext("2d")!;
  shapePath(ctx, s, x, y);
  if (s.fill && s.shape !== "line") {
    ctx.fillStyle = s.fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = s.stroke!;
    ctx.lineWidth = stroke;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }
  return readCanvas(canvas, x, y);
}

export function drawSource(source: LayerSource): Drawn {
  return source.kind === "text" ? drawText(source) : drawShape(source);
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A source read from a project file; null when it doesn't make sense. */
export function normalizeSource(raw: unknown): LayerSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const color = (v: unknown, d: string | null) => (typeof v === "string" && HEX.test(v) ? v : d);
  if (r.kind === "text") {
    return {
      kind: "text",
      text: typeof r.text === "string" ? r.text.slice(0, 20000) : "",
      font: typeof r.font === "string" ? r.font.slice(0, 100) : "Sans",
      size: num(r.size, 1, 2000, 48),
      color: color(r.color, "#000000")!,
      bold: r.bold === true,
      italic: r.italic === true,
      align: r.align === "center" || r.align === "right" ? r.align : "left",
      lineHeight: num(r.lineHeight, 0.5, 4, 1.2),
      x: num(r.x, -65536, 65536, 0),
      y: num(r.y, -65536, 65536, 0),
    };
  }
  if (r.kind === "shape") {
    return {
      kind: "shape",
      shape: SHAPES.some((s) => s.id === r.shape) ? (r.shape as ShapeKind) : "rect",
      x: num(r.x, -65536, 65536, 0),
      y: num(r.y, -65536, 65536, 0),
      w: num(r.w, -65536, 65536, 1),
      h: num(r.h, -65536, 65536, 1),
      sides: Math.round(num(r.sides, 3, 64, 6)),
      radius: num(r.radius, 0, 10000, 0),
      fill: color(r.fill, null),
      stroke: color(r.stroke, null),
      strokeWidth: num(r.strokeWidth, 0, 500, 0),
    };
  }
  return null;
}
