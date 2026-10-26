import type { SaveFormat } from "./api";

export type Tool = "move" | "crop" | "brush" | "eraser" | "bucket" | "gradient" | "eyedropper" | "hand" | "zoom";

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
  /** Colours as "#rrggbb". */
  fg: string;
  bg: string;
  newCanvas: { width: number; height: number; background: "white" | "black" | "transparent" };
  export: { format: SaveFormat; quality: number };
}

export const TOOLS: Tool[] = ["move", "crop", "brush", "eraser", "bucket", "gradient", "eyedropper", "hand", "zoom"];

const DEFAULTS: PhotoSettings = {
  tool: "brush",
  brush: { size: 40, hardness: 80, opacity: 100, flow: 100 },
  eraser: { size: 60, hardness: 80, opacity: 100, flow: 100 },
  bucket: { tolerance: 32, contiguous: true, allLayers: false, opacity: 100 },
  gradient: { radial: false, opacity: 100, transparent: false },
  eyedropper: { allLayers: true },
  crop: { ratio: "free" },
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
  return {
    tool: TOOLS.includes(r.tool as Tool) ? (r.tool as Tool) : DEFAULTS.tool,
    brush: brush(r.brush, DEFAULTS.brush),
    eraser: brush(r.eraser, DEFAULTS.eraser),
    bucket: { tolerance: num(bucket.tolerance, 0, 255, 32), contiguous: bool(bucket.contiguous, true), allLayers: bool(bucket.allLayers, false), opacity: num(bucket.opacity, 1, 100, 100) },
    gradient: { radial: bool(gradient.radial, false), opacity: num(gradient.opacity, 1, 100, 100), transparent: bool(gradient.transparent, false) },
    eyedropper: { allLayers: bool(eye.allLayers, true) },
    crop: { ratio: typeof crop.ratio === "string" ? crop.ratio : "free" },
    fg: typeof r.fg === "string" && HEX.test(r.fg) ? r.fg : DEFAULTS.fg,
    bg: typeof r.bg === "string" && HEX.test(r.bg) ? r.bg : DEFAULTS.bg,
    newCanvas: {
      width: Math.round(num(canvas.width, 1, 16384, 1080)),
      height: Math.round(num(canvas.height, 1, 16384, 1080)),
      background: canvas.background === "black" || canvas.background === "transparent" ? canvas.background : "white",
    },
    export: {
      format: ["jpeg", "png", "webp", "tiff", "bmp"].includes(exp.format as string) ? (exp.format as SaveFormat) : "png",
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
