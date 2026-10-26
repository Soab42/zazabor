import type { IconName } from "../../../ui/icons";
import { buildGradientLut, curveSpline, CURVE_IDENTITY, LEVELS_IDENTITY, type CurvePoints, type LevelsChannel } from "./tone";

/**
 * Photo's adjustment layers beyond Light & Colour (Quick Edit's sliders, `adjust.ts`): Photoshop's
 * Levels, Curves, Hue/Saturation, Color Balance, Black & White, Vibrance, Exposure, Photo Filter,
 * Gradient Map, Invert, Posterize and Threshold, as GLSL in `SPEC_GLSL` that the compositing
 * shader runs with `setSpecUniforms`. The maths matches `tone.ts`, where Node tests it.
 */

export type AdjType =
  | "basic" | "levels" | "curves" | "hueSat" | "colorBalance" | "blackWhite" | "vibrance"
  | "exposure" | "photoFilter" | "gradientMap" | "invert" | "posterize" | "threshold";

export type Channel = "rgb" | "r" | "g" | "b";
export const CHANNELS: { id: Channel; label: string }[] = [
  { id: "rgb", label: "RGB" },
  { id: "r", label: "Red" },
  { id: "g", label: "Green" },
  { id: "b", label: "Blue" },
];

export type HueRange = "master" | "reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas";
export const HUE_RANGES: { id: HueRange; label: string }[] = [
  { id: "master", label: "Master" },
  { id: "reds", label: "Reds" },
  { id: "yellows", label: "Yellows" },
  { id: "greens", label: "Greens" },
  { id: "cyans", label: "Cyans" },
  { id: "blues", label: "Blues" },
  { id: "magentas", label: "Magentas" },
];

/** Hue (−180–180), saturation and lightness (−100–100). */
export interface Hsl {
  hue: number;
  sat: number;
  light: number;
}

export type Tone = "shadows" | "midtones" | "highlights";

export type AdjSpec =
  | { type: "basic" }
  | { type: "levels"; levels: Record<Channel, LevelsChannel> }
  | { type: "curves"; curves: Record<Channel, CurvePoints> }
  | { type: "hueSat"; ranges: Record<HueRange, Hsl>; colorize: boolean; colorizeHue: number; colorizeSat: number }
  /** Cyan–red, magenta–green, yellow–blue for each tone, −100–100. */
  | { type: "colorBalance"; tones: Record<Tone, [number, number, number]>; preserve: boolean }
  /** Percentages, −200–300, as in Photoshop; tint hue 0–360 and saturation 0–100. */
  | { type: "blackWhite"; reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tintHue: number; tintSat: number }
  | { type: "vibrance"; vibrance: number; saturation: number }
  | { type: "exposure"; exposure: number; offset: number; gamma: number }
  | { type: "photoFilter"; color: string; density: number; preserve: boolean }
  | { type: "gradientMap"; from: string; to: string; reverse: boolean }
  | { type: "invert" }
  | { type: "posterize"; levels: number }
  | { type: "threshold"; level: number };

export const ADJ_TYPES: { type: AdjType; label: string; icon: IconName }[] = [
  { type: "basic", label: "Light & Colour", icon: "phLight" },
  { type: "levels", label: "Levels", icon: "phLevels" },
  { type: "curves", label: "Curves", icon: "phCurves" },
  { type: "exposure", label: "Exposure", icon: "phLight" },
  { type: "vibrance", label: "Vibrance", icon: "phVibrance" },
  { type: "hueSat", label: "Hue/Saturation", icon: "phHueSat" },
  { type: "colorBalance", label: "Color Balance", icon: "phBalance" },
  { type: "blackWhite", label: "Black & White", icon: "phBlackWhite" },
  { type: "photoFilter", label: "Photo Filter", icon: "phFilters" },
  { type: "gradientMap", label: "Gradient Map", icon: "phGradient" },
  { type: "invert", label: "Invert", icon: "phInvert" },
  { type: "posterize", label: "Posterize", icon: "phPosterize" },
  { type: "threshold", label: "Threshold", icon: "phThreshold" },
];

export const adjLabel = (type: AdjType) => ADJ_TYPES.find((t) => t.type === type)?.label ?? "Adjustments";
export const adjIcon = (type: AdjType): IconName => ADJ_TYPES.find((t) => t.type === type)?.icon ?? "phAdjustLayer";

const levels = (): Record<Channel, LevelsChannel> => ({ rgb: { ...LEVELS_IDENTITY }, r: { ...LEVELS_IDENTITY }, g: { ...LEVELS_IDENTITY }, b: { ...LEVELS_IDENTITY } });
const curves = (): Record<Channel, CurvePoints> => ({ rgb: CURVE_IDENTITY.map((p) => [...p] as [number, number]), r: CURVE_IDENTITY.map((p) => [...p] as [number, number]), g: CURVE_IDENTITY.map((p) => [...p] as [number, number]), b: CURVE_IDENTITY.map((p) => [...p] as [number, number]) });
const hsl = (): Hsl => ({ hue: 0, sat: 0, light: 0 });

/** Photo Filter's presets, as in Photoshop. */
export const PHOTO_FILTERS: { label: string; color: string }[] = [
  { label: "Warming Filter (85)", color: "#ec8a00" },
  { label: "Warming Filter (LBA)", color: "#fa9600" },
  { label: "Warming Filter (81)", color: "#ebb113" },
  { label: "Cooling Filter (80)", color: "#006dff" },
  { label: "Cooling Filter (LBB)", color: "#005dff" },
  { label: "Cooling Filter (82)", color: "#00b5ff" },
  { label: "Red", color: "#ea1a1a" },
  { label: "Orange", color: "#f28b00" },
  { label: "Yellow", color: "#f9e31c" },
  { label: "Green", color: "#19c919" },
  { label: "Cyan", color: "#1de6f2" },
  { label: "Blue", color: "#1d35ea" },
  { label: "Violet", color: "#9b1dea" },
  { label: "Magenta", color: "#e318e3" },
  { label: "Sepia", color: "#ac7a33" },
  { label: "Deep Red", color: "#ff0000" },
  { label: "Deep Blue", color: "#0022cd" },
  { label: "Deep Emerald", color: "#008c00" },
  { label: "Deep Yellow", color: "#ffd500" },
  { label: "Underwater", color: "#00c1b1" },
];

/** A new adjustment of `type` that changes nothing yet (Photoshop's defaults where they do). */
export function defaultSpec(type: AdjType): AdjSpec {
  switch (type) {
    case "basic": return { type };
    case "levels": return { type, levels: levels() };
    case "curves": return { type, curves: curves() };
    case "hueSat": return { type, ranges: { master: hsl(), reds: hsl(), yellows: hsl(), greens: hsl(), cyans: hsl(), blues: hsl(), magentas: hsl() }, colorize: false, colorizeHue: 0, colorizeSat: 25 };
    case "colorBalance": return { type, tones: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] }, preserve: true };
    case "blackWhite": return { type, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 42, tintSat: 20 };
    case "vibrance": return { type, vibrance: 0, saturation: 0 };
    case "exposure": return { type, exposure: 0, offset: 0, gamma: 1 };
    case "photoFilter": return { type, color: "#ec8a00", density: 25, preserve: true };
    case "gradientMap": return { type, from: "#000000", to: "#ffffff", reverse: false };
    case "invert": return { type };
    case "posterize": return { type, levels: 4 };
    case "threshold": return { type, level: 128 };
  }
}

export const cloneSpec = (spec: AdjSpec): AdjSpec => JSON.parse(JSON.stringify(spec)) as AdjSpec;

const HEX = /^#[0-9a-f]{6}$/i;

/** A spec read from a file: unknown types become Light & Colour, numbers are kept in range. */
export function normalizeSpec(raw: unknown): AdjSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = ADJ_TYPES.some((t) => t.type === r.type) ? (r.type as AdjType) : "basic";
  const out = defaultSpec(type) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  switch (type) {
    case "levels": {
      const src = obj(r.levels);
      const lv = out.levels as Record<Channel, LevelsChannel>;
      for (const c of CHANNELS) {
        const s = obj(src[c.id]);
        lv[c.id] = { inBlack: num(s.inBlack, 0, 253, 0), inWhite: num(s.inWhite, 2, 255, 255), gamma: num(s.gamma, 0.1, 9.99, 1), outBlack: num(s.outBlack, 0, 255, 0), outWhite: num(s.outWhite, 0, 255, 255) };
      }
      break;
    }
    case "curves": {
      const src = obj(r.curves);
      const cv = out.curves as Record<Channel, CurvePoints>;
      for (const c of CHANNELS) {
        const pts = Array.isArray(src[c.id]) ? (src[c.id] as unknown[]) : [];
        const ok = pts.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v))).map(([x, y]) => [num(x, 0, 255, 0), num(y, 0, 255, 0)] as [number, number]).slice(0, 16);
        if (ok.length >= 2) cv[c.id] = ok.sort((a, b) => a[0] - b[0]);
      }
      break;
    }
    case "hueSat": {
      const src = obj(r.ranges);
      const rg = out.ranges as Record<HueRange, Hsl>;
      for (const h of HUE_RANGES) {
        const s = obj(src[h.id]);
        rg[h.id] = { hue: num(s.hue, -180, 180, 0), sat: num(s.sat, -100, 100, 0), light: num(s.light, -100, 100, 0) };
      }
      out.colorize = r.colorize === true;
      out.colorizeHue = num(r.colorizeHue, 0, 360, 0);
      out.colorizeSat = num(r.colorizeSat, 0, 100, 25);
      break;
    }
    case "colorBalance": {
      const src = obj(r.tones);
      const tones = out.tones as Record<Tone, [number, number, number]>;
      for (const t of ["shadows", "midtones", "highlights"] as Tone[]) {
        const v = Array.isArray(src[t]) ? (src[t] as unknown[]) : [];
        tones[t] = [0, 1, 2].map((i) => num(v[i], -100, 100, 0)) as [number, number, number];
      }
      out.preserve = r.preserve !== false;
      break;
    }
    case "blackWhite":
      for (const k of ["reds", "yellows", "greens", "cyans", "blues", "magentas"]) out[k] = num(r[k], -200, 300, out[k] as number);
      out.tint = r.tint === true;
      out.tintHue = num(r.tintHue, 0, 360, 42);
      out.tintSat = num(r.tintSat, 0, 100, 20);
      break;
    case "vibrance":
      out.vibrance = num(r.vibrance, -100, 100, 0);
      out.saturation = num(r.saturation, -100, 100, 0);
      break;
    case "exposure":
      out.exposure = num(r.exposure, -20, 20, 0);
      out.offset = num(r.offset, -0.5, 0.5, 0);
      out.gamma = num(r.gamma, 0.01, 9.99, 1);
      break;
    case "photoFilter":
      out.color = typeof r.color === "string" && HEX.test(r.color) ? r.color : "#ec8a00";
      out.density = num(r.density, 1, 100, 25);
      out.preserve = r.preserve !== false;
      break;
    case "gradientMap":
      out.from = typeof r.from === "string" && HEX.test(r.from) ? r.from : "#000000";
      out.to = typeof r.to === "string" && HEX.test(r.to) ? r.to : "#ffffff";
      out.reverse = r.reverse === true;
      break;
    case "posterize":
      out.levels = Math.round(num(r.levels, 2, 255, 4));
      break;
    case "threshold":
      out.level = Math.round(num(r.level, 1, 255, 128));
      break;
  }
  return out as AdjSpec;
}

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** The lookup table a spec needs (Gradient Map's colours), or null. */
export function lutFor(spec: AdjSpec): Float32Array | null {
  if (spec.type !== "gradientMap") return null;
  const stops = [hexRgb(spec.from), hexRgb(spec.to)];
  return buildGradientLut(spec.reverse ? stops.reverse() : stops);
}

/** Which branch of `adjustSpec` a spec runs (0 is Light & Colour's own `adjust`). */
const SHADER_KIND: Record<AdjType, number> = {
  basic: 0, levels: 1, gradientMap: 2, hueSat: 3, colorBalance: 4, blackWhite: 5, vibrance: 6, photoFilter: 7,
  threshold: 8, curves: 9, exposure: 10, invert: 11, posterize: 12,
};

/** Curves points per channel the shader takes. */
const MAX_POINTS = 16;

/**
 * `vec3 adjustSpec(vec3 c)` for the layer's spec (gamma-encoded 0–1 colour). Needs `luma`
 * (ADJUST_GLSL) and `lum`/`setLum` (the blend helpers) defined before it.
 */
export const SPEC_GLSL = `
uniform int uAdjType;
uniform sampler2D uLut;
uniform int uLutSize;
uniform vec3 uHsl[7];
uniform bool uColorize;
uniform vec2 uColorizeHs;
uniform vec3 uCbShadows;
uniform vec3 uCbMid;
uniform vec3 uCbHigh;
uniform bool uPreserve;
uniform float uBw[6];
uniform bool uTintOn;
uniform vec2 uTintHs;
uniform vec2 uVibSat;
uniform vec3 uFilterColor;
uniform float uDensity;
uniform float uThreshold;
// Levels: per channel (RGB, red, green, blue) the points / 255 and 1 / gamma.
uniform vec4 uLevels[4];
uniform float uLevelsGamma[4];
// Curves: per channel 16 knots (x, y, second derivative), and how many are used.
uniform vec4 uCurve[64];
uniform int uCurveN[4];
uniform vec3 uExposure3;
uniform float uPosterize;

vec4 lutAt(float v) {
  float x = clamp(v, 0.0, 1.0) * float(uLutSize - 1);
  int i = int(floor(x));
  int j = min(i + 1, uLutSize - 1);
  return mix(texelFetch(uLut, ivec2(i, 0), 0), texelFetch(uLut, ivec2(j, 0), 0), x - float(i));
}

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  if (mx - mn < 1e-6) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y <= 0.0) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(hue2rgb(p, q, hsl.x + 1.0 / 3.0), hue2rgb(p, q, hsl.x), hue2rgb(p, q, hsl.x - 1.0 / 3.0));
}

vec3 hueSat(vec3 c) {
  vec3 hsl = rgb2hsl(c);
  vec3 sum = uHsl[0];
  // Each range is full strength within 15 degrees of its hue and fades out by 45 (sums to 1).
  for (int k = 0; k < 6; k++) {
    float d = abs(fract(hsl.x - float(k) / 6.0 + 0.5) - 0.5) * 360.0;
    float w = clamp((45.0 - d) / 30.0, 0.0, 1.0);
    sum += uHsl[k + 1] * w * step(1e-4, hsl.y);
  }
  float light = clamp(sum.z, -1.0, 1.0);
  float l = light < 0.0 ? hsl.z * (1.0 + light) : hsl.z + (1.0 - hsl.z) * light;
  if (uColorize) return hsl2rgb(vec3(uColorizeHs.x, uColorizeHs.y, l));
  float h = fract(hsl.x + sum.x);
  float s = clamp(hsl.y * (1.0 + clamp(sum.y, -1.0, 1.0)), 0.0, 1.0);
  return hsl2rgb(vec3(h, s, l));
}

float balance(float v, float l, float sh, float mid, float hi) {
  sh *= clamp((l - 0.333) / -0.25 + 0.5, 0.0, 1.0) * 0.7;
  mid *= clamp((l - 0.333) / 0.25 + 0.5, 0.0, 1.0) * clamp((l + 0.333 - 1.0) / -0.25 + 0.5, 0.0, 1.0) * 0.7;
  hi *= clamp((l + 0.333 - 1.0) / 0.25 + 0.5, 0.0, 1.0) * 0.7;
  return clamp(v + sh + mid + hi, 0.0, 1.0);
}
vec3 colorBalance(vec3 c) {
  float l = rgb2hsl(c).z;
  vec3 o = vec3(
    balance(c.r, l, uCbShadows.x, uCbMid.x, uCbHigh.x),
    balance(c.g, l, uCbShadows.y, uCbMid.y, uCbHigh.y),
    balance(c.b, l, uCbShadows.z, uCbMid.z, uCbHigh.z));
  if (uPreserve) {
    vec3 h = rgb2hsl(o);
    o = hsl2rgb(vec3(h.x, h.y, l));
  }
  return o;
}

// Photoshop's Black & White: the smallest channel, plus the primary (largest channel's) and
// secondary (largest two's) colour weights on the differences.
vec3 blackWhite(vec3 c) {
  float mn = min(c.r, min(c.g, c.b)), mx = max(c.r, max(c.g, c.b));
  float md = c.r + c.g + c.b - mn - mx;
  float wp, ws;
  if (c.r >= c.g && c.r >= c.b) { wp = uBw[0]; ws = c.g >= c.b ? uBw[1] : uBw[5]; }
  else if (c.g >= c.b) { wp = uBw[2]; ws = c.r >= c.b ? uBw[1] : uBw[3]; }
  else { wp = uBw[4]; ws = c.g >= c.r ? uBw[3] : uBw[5]; }
  float g = clamp(mn + (mx - md) * wp + (md - mn) * ws, 0.0, 1.0);
  if (uTintOn) return hsl2rgb(vec3(uTintHs.x, uTintHs.y, g));
  return vec3(g);
}

vec3 vibranceSat(vec3 c) {
  float l = luma(c);
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float vib = uVibSat.x * (uVibSat.x > 0.0 ? 1.0 - smoothstep(0.0, 0.75, chroma) : 1.0);
  return clamp(mix(vec3(l), c, max(0.0, 1.0 + uVibSat.y + vib)), 0.0, 1.0);
}

vec3 photoFilter(vec3 c) {
  vec3 f = mix(c, c * uFilterColor, uDensity);
  if (uPreserve) f = setLum(f, lum(c));
  return clamp(f, 0.0, 1.0);
}

float levelsAt(int k, float v) {
  vec4 p = uLevels[k];
  float t = p.y > p.x ? clamp((v - p.x) / (p.y - p.x), 0.0, 1.0) : step(p.x, v);
  return clamp(mix(p.z, p.w, pow(t, uLevelsGamma[k])), 0.0, 1.0);
}

float curveAt(int k, float v) {
  int n = uCurveN[k];
  int base = k * 16;
  if (n < 2) return v;
  vec4 first = uCurve[base];
  if (v <= first.x) return clamp(first.y, 0.0, 1.0);
  for (int i = 0; i < 15; i++) {
    if (i + 1 >= n) break;
    vec4 a = uCurve[base + i], b = uCurve[base + i + 1];
    if (v <= b.x) {
      float h = b.x - a.x;
      float t0 = (b.x - v) / h, t1 = (v - a.x) / h;
      return clamp(t0 * a.y + t1 * b.y + ((t0 * t0 * t0 - t0) * a.z + (t1 * t1 * t1 - t1) * b.z) * h * h / 6.0, 0.0, 1.0);
    }
  }
  return clamp(uCurve[base + n - 1].y, 0.0, 1.0);
}

vec3 adjustSpec(vec3 c) {
  if (uAdjType == 1) return vec3(levelsAt(0, levelsAt(1, c.r)), levelsAt(0, levelsAt(2, c.g)), levelsAt(0, levelsAt(3, c.b)));
  if (uAdjType == 9) return vec3(curveAt(0, curveAt(1, c.r)), curveAt(0, curveAt(2, c.g)), curveAt(0, curveAt(3, c.b)));
  if (uAdjType == 10) {
    vec3 lin = max(toLinear(c) * exp2(uExposure3.x) + uExposure3.y, 0.0);
    return clamp(toGamma(clamp(pow(lin, vec3(uExposure3.z)), 0.0, 1.0)), 0.0, 1.0);
  }
  if (uAdjType == 11) return 1.0 - c;
  if (uAdjType == 12) return min(vec3(uPosterize - 1.0), floor(c * uPosterize)) / (uPosterize - 1.0);
  if (uAdjType == 2) return lutAt(luma(c)).rgb;
  if (uAdjType == 3) return hueSat(c);
  if (uAdjType == 4) return colorBalance(c);
  if (uAdjType == 5) return blackWhite(c);
  if (uAdjType == 6) return vibranceSat(c);
  if (uAdjType == 7) return photoFilter(c);
  if (uAdjType == 8) return vec3(step(uThreshold, luma(c)));
  return c;
}
`;

type Uniform = (name: string) => WebGLUniformLocation | null;

/** Sets `SPEC_GLSL`'s uniforms on the program in use; `lutUnit` is where the table is bound. */
export function setSpecUniforms(gl: WebGL2RenderingContext, u: Uniform, spec: AdjSpec, lutUnit: number, lutSize: number) {
  gl.uniform1i(u("uAdjType"), SHADER_KIND[spec.type]);
  gl.uniform1i(u("uLut"), lutUnit);
  gl.uniform1i(u("uLutSize"), lutSize);
  if (spec.type === "hueSat") {
    const values = HUE_RANGES.flatMap((r) => [spec.ranges[r.id].hue / 360, spec.ranges[r.id].sat / 100, spec.ranges[r.id].light / 100]);
    gl.uniform3fv(u("uHsl[0]"), values);
    gl.uniform1i(u("uColorize"), spec.colorize ? 1 : 0);
    gl.uniform2f(u("uColorizeHs"), spec.colorizeHue / 360, spec.colorizeSat / 100);
  } else if (spec.type === "colorBalance") {
    const t = (v: [number, number, number]) => v.map((x) => x / 100);
    gl.uniform3fv(u("uCbShadows"), t(spec.tones.shadows));
    gl.uniform3fv(u("uCbMid"), t(spec.tones.midtones));
    gl.uniform3fv(u("uCbHigh"), t(spec.tones.highlights));
    gl.uniform1i(u("uPreserve"), spec.preserve ? 1 : 0);
  } else if (spec.type === "blackWhite") {
    gl.uniform1fv(u("uBw[0]"), [spec.reds, spec.yellows, spec.greens, spec.cyans, spec.blues, spec.magentas].map((v) => v / 100));
    gl.uniform1i(u("uTintOn"), spec.tint ? 1 : 0);
    gl.uniform2f(u("uTintHs"), spec.tintHue / 360, spec.tintSat / 100);
  } else if (spec.type === "vibrance") {
    gl.uniform2f(u("uVibSat"), spec.vibrance / 100, spec.saturation / 100);
  } else if (spec.type === "photoFilter") {
    gl.uniform3fv(u("uFilterColor"), hexRgb(spec.color));
    gl.uniform1f(u("uDensity"), spec.density / 100);
    gl.uniform1i(u("uPreserve"), spec.preserve ? 1 : 0);
  } else if (spec.type === "threshold") {
    gl.uniform1f(u("uThreshold"), spec.level / 255);
  } else if (spec.type === "levels") {
    const order: Channel[] = ["rgb", "r", "g", "b"];
    gl.uniform4fv(u("uLevels[0]"), order.flatMap((c) => {
      const l = spec.levels[c];
      return [l.inBlack / 255, l.inWhite / 255, l.outBlack / 255, l.outWhite / 255];
    }));
    gl.uniform1fv(u("uLevelsGamma[0]"), order.map((c) => 1 / Math.max(0.01, spec.levels[c].gamma)));
  } else if (spec.type === "curves") {
    const order: Channel[] = ["rgb", "r", "g", "b"];
    const data = new Float32Array(64 * 4);
    const counts = order.map((c, k) => {
      const s = curveSpline(spec.curves[c]);
      const n = Math.min(MAX_POINTS, s.xs.length);
      for (let i = 0; i < n; i++) data.set([s.xs[i], s.ys[i], s.ms[i], 0], (k * 16 + i) * 4);
      return n;
    });
    gl.uniform4fv(u("uCurve[0]"), data);
    gl.uniform1iv(u("uCurveN[0]"), counts);
  } else if (spec.type === "exposure") {
    gl.uniform3f(u("uExposure3"), spec.exposure, spec.offset, 1 / Math.max(0.01, spec.gamma));
  } else if (spec.type === "posterize") {
    gl.uniform1f(u("uPosterize"), Math.max(2, Math.round(spec.levels)));
  }
}
