import type { SaveFormat } from "./api";
import { DEFAULT_FILTERS, type FilterSettings } from "./filters";
import type { SelectMode } from "./selection";
import { FONTS, SHAPES, type ShapeKind, type TextAlign } from "./vector";

export type Tool =
  | "move" | "marquee" | "ellipse" | "lasso" | "polyLasso" | "wand" | "crop" | "eyedropper"
  | "heal" | "brush" | "clone" | "eraser" | "gradient" | "bucket" | "text" | "shape" | "hand" | "zoom";

export interface BrushSettings {
  /** Diameter in document pixels. */
  size: number;
  /** 0–100: how much of the radius is solid. */
  hardness: number;
  /** 0–100: the most one stroke covers. */
  opacity: number;
  /** 0–100: how much each dab adds. */
  flow: number;
}

/** Photo's own settings, kept in `config.studio.apps.photo`. */
export interface PhotoSettings {
  tool: Tool;
  brush: BrushSettings;
  eraser: BrushSettings;
  bucket: { tolerance: number; contiguous: boolean; allLayers: boolean; opacity: number };
  gradient: { radial: boolean; opacity: number; transparent: boolean };
  eyedropper: { allLayers: boolean };
  crop: { ratio: string };
  /** The marquees and lassos: how a new selection combines, and its feather (pixels). */
  select: { mode: SelectMode; feather: number };
  wand: { tolerance: number; contiguous: boolean; allLayers: boolean };
  clone: BrushSettings & { aligned: boolean };
  heal: BrushSettings & { aligned: boolean };
  text: { font: string; size: number; bold: boolean; italic: boolean; align: TextAlign; lineHeight: number };
  shape: { shape: ShapeKind; fill: boolean; stroke: boolean; strokeWidth: number; radius: number; sides: number };
  filters: FilterSettings;
  /** Colours as "#rrggbb". */
  fg: string;
  bg: string;
  newCanvas: { width: number; height: number; background: "white" | "black" | "transparent" };
  export: { format: SaveFormat; quality: number };
}

export const TOOLS: Tool[] = ["move", "marquee", "ellipse", "lasso", "polyLasso", "wand", "crop", "eyedropper", "heal", "brush", "clone", "eraser", "gradient", "bucket", "text", "shape", "hand", "zoom"];

const DEFAULTS: PhotoSettings = {
  tool: "brush",
  brush: { size: 40, hardness: 80, opacity: 100, flow: 100 },
  eraser: { size: 60, hardness: 80, opacity: 100, flow: 100 },
  bucket: { tolerance: 32, contiguous: true, allLayers: false, opacity: 100 },
  gradient: { radial: false, opacity: 100, transparent: false },
  eyedropper: { allLayers: true },
  crop: { ratio: "free" },
  select: { mode: "new", feather: 0 },
  wand: { tolerance: 32, contiguous: true, allLayers: false },
  clone: { size: 60, hardness: 50, opacity: 100, flow: 100, aligned: true },
  heal: { size: 40, hardness: 60, opacity: 100, flow: 100, aligned: true },
  text: { font: "Sans", size: 72, bold: false, italic: false, align: "left", lineHeight: 1.2 },
  shape: { shape: "rect", fill: true, stroke: false, strokeWidth: 4, radius: 0, sides: 6 },
  filters: DEFAULT_FILTERS,
  fg: "#000000",
  bg: "#ffffff",
  newCanvas: { width: 1080, height: 1080, background: "white" },
  export: { format: "png", quality: 92 },
};

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizePhotoSettings(raw: unknown): PhotoSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const brush = (v: unknown, d: BrushSettings): BrushSettings => {
    const b = obj(v);
    return { size: num(b.size, 1, 2000, d.size), hardness: num(b.hardness, 0, 100, d.hardness), opacity: num(b.opacity, 1, 100, d.opacity), flow: num(b.flow, 1, 100, d.flow) };
  };
  const bucket = obj(r.bucket), gradient = obj(r.gradient), eye = obj(r.eyedropper), canvas = obj(r.newCanvas), exp = obj(r.export), crop = obj(r.crop);
  const select = obj(r.select), wand = obj(r.wand), text = obj(r.text), shape = obj(r.shape), filters = obj(r.filters);
  const cloneLike = (v: unknown, d: BrushSettings & { aligned: boolean }) => ({ ...brush(v, d), aligned: bool(obj(v).aligned, true) });
  const f = (k: keyof FilterSettings) => obj(filters[k]);
  return {
    tool: TOOLS.includes(r.tool as Tool) ? (r.tool as Tool) : DEFAULTS.tool,
    brush: brush(r.brush, DEFAULTS.brush),
    eraser: brush(r.eraser, DEFAULTS.eraser),
    bucket: { tolerance: num(bucket.tolerance, 0, 255, 32), contiguous: bool(bucket.contiguous, true), allLayers: bool(bucket.allLayers, false), opacity: num(bucket.opacity, 1, 100, 100) },
    gradient: { radial: bool(gradient.radial, false), opacity: num(gradient.opacity, 1, 100, 100), transparent: bool(gradient.transparent, false) },
    eyedropper: { allLayers: bool(eye.allLayers, true) },
    crop: { ratio: typeof crop.ratio === "string" ? crop.ratio : "free" },
    select: { mode: ["new", "add", "subtract", "intersect"].includes(select.mode as string) ? (select.mode as SelectMode) : "new", feather: num(select.feather, 0, 250, 0) },
    wand: { tolerance: num(wand.tolerance, 0, 255, 32), contiguous: bool(wand.contiguous, true), allLayers: bool(wand.allLayers, false) },
    clone: cloneLike(r.clone, DEFAULTS.clone),
    heal: cloneLike(r.heal, DEFAULTS.heal),
    text: {
      font: typeof text.font === "string" && FONTS.includes(text.font) ? text.font : "Sans",
      size: num(text.size, 1, 2000, 72),
      bold: bool(text.bold, false),
      italic: bool(text.italic, false),
      align: text.align === "center" || text.align === "right" ? text.align : "left",
      lineHeight: num(text.lineHeight, 0.5, 4, 1.2),
    },
    shape: {
      shape: SHAPES.some((x) => x.id === shape.shape) ? (shape.shape as ShapeKind) : "rect",
      fill: bool(shape.fill, true),
      stroke: bool(shape.stroke, false),
      strokeWidth: num(shape.strokeWidth, 0, 500, 4),
      radius: num(shape.radius, 0, 2000, 0),
      sides: Math.round(num(shape.sides, 3, 64, 6)),
    },
    filters: {
      gaussian: { radius: num(f("gaussian").radius, 0.1, 250, 4) },
      unsharp: { amount: num(f("unsharp").amount, 1, 500, 100), radius: num(f("unsharp").radius, 0.1, 250, 2), threshold: num(f("unsharp").threshold, 0, 255, 0) },
      noise: { amount: num(f("noise").amount, 0, 400, 10), gaussian: bool(f("noise").gaussian, true), mono: bool(f("noise").mono, false) },
      motion: { angle: num(f("motion").angle, -360, 360, 0), distance: num(f("motion").distance, 1, 300, 20) },
    },
    fg: typeof r.fg === "string" && HEX.test(r.fg) ? r.fg : DEFAULTS.fg,
    bg: typeof r.bg === "string" && HEX.test(r.bg) ? r.bg : DEFAULTS.bg,
    newCanvas: {
      width: Math.round(num(canvas.width, 1, 16384, 1080)),
      height: Math.round(num(canvas.height, 1, 16384, 1080)),
      background: canvas.background === "black" || canvas.background === "transparent" ? canvas.background : "white",
    },
    export: {
      format: ["jpeg", "png", "webp", "webp-lossy", "avif", "tiff", "bmp"].includes(exp.format as string) ? (exp.format as SaveFormat) : "png",
      quality: Math.round(num(exp.quality, 1, 100, 92)),
    },
  };
}

/** "#rrggbb" as 0–1 channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}
