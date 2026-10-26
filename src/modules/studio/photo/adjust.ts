import { GRADES, LOOKS, type LookId } from "../../gallery/slideshow/settings";

/**
 * Light and colour adjustments: the Gallery's Quick Edit sliders and Photo's adjustment layers.
 * One GLSL function applies them, so the preview, the saved file and an adjustment layer in Photo
 * are the same maths. Values are what the sliders show: exposure in stops, the rest −100 to 100.
 */
export interface Adjustments {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  saturation: number;
  vibrance: number;
  /** A filter preset: the slideshow's looks. */
  look: LookId | "none";
  /** How strongly the look applies, 0–100. */
  lookAmount: number;
  /** Darkens the corners (positive) or lightens them (negative). */
  vignette: number;
}

export const DEFAULT_ADJUST: Adjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, saturation: 0, vibrance: 0,
  look: "none", lookAmount: 100, vignette: 0,
};

export const FILTERS: { id: Adjustments["look"]; label: string }[] = [{ id: "none", label: "None" }, ...LOOKS];

/** A slider: its key, label and range. */
export interface SliderSpec {
  key: Exclude<keyof Adjustments, "look">;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const LIGHT_SLIDERS: SliderSpec[] = [
  { key: "exposure", label: "Exposure", min: -4, max: 4, step: 0.01 },
  { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1 },
  { key: "highlights", label: "Highlights", min: -100, max: 100, step: 1 },
  { key: "shadows", label: "Shadows", min: -100, max: 100, step: 1 },
  { key: "whites", label: "Whites", min: -100, max: 100, step: 1 },
  { key: "blacks", label: "Blacks", min: -100, max: 100, step: 1 },
];

export const COLOUR_SLIDERS: SliderSpec[] = [
  { key: "temperature", label: "Temperature", min: -100, max: 100, step: 1 },
  { key: "tint", label: "Tint", min: -100, max: 100, step: 1 },
  { key: "vibrance", label: "Vibrance", min: -100, max: 100, step: 1 },
  { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1 },
];

export const EFFECT_SLIDERS: SliderSpec[] = [{ key: "vignette", label: "Vignette", min: -100, max: 100, step: 1 }];

export function formatValue(spec: SliderSpec, value: number): string {
  if (spec.key === "exposure") return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
  if (spec.key === "lookAmount") return `${Math.round(value)}%`;
  return `${value > 0 ? "+" : ""}${Math.round(value)}`;
}

export const isDefault = (a: Adjustments) => (Object.keys(DEFAULT_ADJUST) as (keyof Adjustments)[]).every((k) => k === "lookAmount" ? a.look === "none" || a[k] === DEFAULT_ADJUST[k] : a[k] === DEFAULT_ADJUST[k]);

/** Settings read from a file or another module: anything unknown or out of range is dropped. */
export function normalizeAdjust(raw: unknown): Adjustments {
  const out: Adjustments = { ...DEFAULT_ADJUST };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const spec of [...LIGHT_SLIDERS, ...COLOUR_SLIDERS, ...EFFECT_SLIDERS, { key: "lookAmount", min: 0, max: 100 } as SliderSpec]) {
    const v = r[spec.key];
    if (typeof v === "number" && Number.isFinite(v)) out[spec.key] = Math.min(spec.max, Math.max(spec.min, v));
  }
  if (typeof r.look === "string" && FILTERS.some((f) => f.id === r.look)) out.look = r.look as Adjustments["look"];
  return out;
}

/**
 * The adjustment maths: `vec3 adjust(vec3 c, vec2 uv)` takes a gamma-encoded colour (0–1) and
 * where it sits in the frame (for the vignette), and its uniforms are set by `setAdjustUniforms`.
 */
export const ADJUST_GLSL = `
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemp;
uniform float uTint;
uniform float uSat;
uniform float uVib;
uniform float uLookAmount;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uLookSat;
uniform float uLookContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uVignette;
uniform float uFrameAspect;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toGamma(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

vec3 lookGrade(vec3 c) {
  c = clamp(c * uGain + uLift * (1.0 - c), 0.0, 1.0);
  c = pow(c, 1.0 / uGamma);
  c = mix(vec3(luma(c)), c, uLookSat);
  c = mix(c, c * c * (3.0 - 2.0 * c), uLookContrast);
  float l = luma(c);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l)) + uHighTint * smoothstep(0.45, 1.0, l);
  return clamp(c, 0.0, 1.0);
}

vec3 adjust(vec3 c, vec2 uv) {
  // White balance and exposure in linear light, as a camera would.
  vec3 lin = toLinear(clamp(c, 0.0, 1.0));
  float before = luma(lin);
  lin *= vec3(1.0 + 0.3 * uTemp, 1.0 - 0.22 * uTint, 1.0 - 0.3 * uTemp);
  float after = luma(lin);
  if (after > 1e-5) lin *= before / after;
  lin *= exp2(uExposure);
  c = toGamma(max(lin, 0.0));

  // Whites and blacks move the end points; highlights and shadows bend the tones near them.
  float white = 1.0 - 0.25 * uWhites;
  float black = -0.1 * uBlacks;
  c = (c - black) / (white - black);
  float l = luma(c);
  float lc = clamp(l, 0.0, 1.0);
  float hi = smoothstep(0.35, 1.0, lc);
  float lo = 1.0 - smoothstep(0.0, 0.65, lc);
  float shifted = l
    + uHighlights * 0.35 * hi * (uHighlights > 0.0 ? 1.0 - lc : lc)
    + uShadows * 0.4 * lo * (uShadows > 0.0 ? 1.0 - lc : lc);
  c += shifted - l;
  c = clamp(c, 0.0, 1.0);

  c = uContrast >= 0.0 ? mix(c, c * c * (3.0 - 2.0 * c), uContrast) : mix(c, vec3(0.5) + (c - 0.5) * 0.45, -uContrast);

  l = luma(c);
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float vib = uVib * (uVib > 0.0 ? 1.0 - smoothstep(0.0, 0.75, chroma) : 1.0);
  c = mix(vec3(l), c, max(0.0, 1.0 + uSat + vib));
  c = clamp(c, 0.0, 1.0);

  if (uLookAmount > 0.0) c = mix(c, lookGrade(c), uLookAmount);

  if (uVignette != 0.0) {
    vec2 q = (uv - 0.5) * vec2(uFrameAspect, 1.0);
    float r = length(q) / length(vec2(uFrameAspect, 1.0) * 0.5);
    float m = smoothstep(0.35, 1.1, r);
    c = uVignette > 0.0 ? c * (1.0 - uVignette * 0.75 * m) : mix(c, vec3(1.0), -uVignette * 0.6 * m);
  }
  return clamp(c, 0.0, 1.0);
}
`;

type Uniform = (name: string) => WebGLUniformLocation | null;

/** Sets `ADJUST_GLSL`'s uniforms on the program in use. `aspect` is the frame's width / height. */
export function setAdjustUniforms(gl: WebGL2RenderingContext, u: Uniform, a: Adjustments, aspect: number) {
  gl.uniform1f(u("uExposure"), a.exposure);
  gl.uniform1f(u("uContrast"), a.contrast / 100);
  gl.uniform1f(u("uHighlights"), a.highlights / 100);
  gl.uniform1f(u("uShadows"), a.shadows / 100);
  gl.uniform1f(u("uWhites"), a.whites / 100);
  gl.uniform1f(u("uBlacks"), a.blacks / 100);
  gl.uniform1f(u("uTemp"), a.temperature / 100);
  gl.uniform1f(u("uTint"), a.tint / 100);
  gl.uniform1f(u("uSat"), a.saturation / 100);
  gl.uniform1f(u("uVib"), a.vibrance / 100);
  const grade = a.look === "none" ? GRADES.natural : GRADES[a.look];
  gl.uniform1f(u("uLookAmount"), a.look === "none" ? 0 : a.lookAmount / 100);
  gl.uniform3fv(u("uLift"), grade.lift);
  gl.uniform3fv(u("uGamma"), grade.gamma);
  gl.uniform3fv(u("uGain"), grade.gain);
  gl.uniform1f(u("uLookSat"), grade.saturation);
  gl.uniform1f(u("uLookContrast"), grade.contrast);
  gl.uniform3fv(u("uShadowTint"), grade.shadowTint);
  gl.uniform3fv(u("uHighTint"), grade.highlightTint);
  gl.uniform1f(u("uVignette"), a.vignette / 100);
  gl.uniform1f(u("uFrameAspect"), aspect);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * "Auto": exposure, white and black points, shadows and highlights, and a gentle white balance,
 * from a small RGBA rendition of the picture (straight alpha; transparent pixels are skipped).
 */
export function autoAdjust(rgba: Uint8Array, current: Adjustments): Adjustments {
  const lumas: number[] = [];
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const cr = rgba[i] / 255, cg = rgba[i + 1] / 255, cb = rgba[i + 2] / 255;
    const l = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    lumas.push(l);
    // Grey-world white balance over the midtones only: skies and shadows mislead it.
    if (l > 0.15 && l < 0.85) {
      r += toLinear(cr);
      g += toLinear(cg);
      b += toLinear(cb);
      n++;
    }
  }
  if (lumas.length < 16) return { ...current };
  lumas.sort((x, y) => x - y);
  const at = (p: number) => lumas[Math.min(lumas.length - 1, Math.floor(p * lumas.length))];
  const median = Math.max(0.02, at(0.5));
  // Brighten toward a mid-grey median, but never so far that the brightest parts clip (a night
  // sky stays dark around a bright moon).
  const headroom = Math.log2(toLinear(0.97) / toLinear(Math.max(0.02, at(0.995))));
  const ev = clampTo(Math.min(Math.log2(toLinear(0.46) / toLinear(median)) * 0.7, Math.max(0, headroom)), -1.5, 1.5);
  const moved = (v: number) => toGamma(Math.min(1, toLinear(v) * 2 ** ev));
  const top = moved(at(0.995));
  const bottom = moved(at(0.005));
  // Solve the end points so the brightest 0.5% lands at 0.98 and the darkest at 0.02.
  let white = top / 0.98;
  let black = (bottom - 0.02 * white) / 0.98;
  white = black + (top - black) / 0.98;
  black = (bottom - 0.02 * white) / 0.98;
  // Blacks only deepen (lifting them greys a dark sky); whites mostly open up.
  const whites = clampTo(((1 - white) / 0.25) * 100, -30, 60);
  const blacks = clampTo((-black / 0.1) * 100, -60, 5);
  const shadows = at(0.5) < 0.08 ? 0 : at(0.25) < 0.18 ? 20 : at(0.25) < 0.25 ? 10 : 0;
  const highlights = at(0.9) > 0.92 ? -30 : at(0.9) > 0.85 ? -15 : 0;
  let temperature = 0;
  let tint = 0;
  if (n > 32) {
    r /= n;
    g /= n;
    b /= n;
    temperature = clampTo(((b - r) / Math.max(1e-4, r + b)) * 160, -30, 30);
    tint = clampTo(((g - (r + b) / 2) / Math.max(1e-4, g)) * 120, -25, 25);
  }
  return {
    ...current,
    exposure: Math.round(ev * 100) / 100,
    whites: Math.round(whites),
    blacks: Math.round(blacks),
    shadows,
    highlights,
    temperature: Math.round(temperature),
    tint: Math.round(tint),
    contrast: Math.max(current.contrast, 8),
    vibrance: Math.max(current.vibrance, 12),
  };
}
