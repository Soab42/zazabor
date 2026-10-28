import { valueAt, type Anim } from "./ease";
import { rgbOf, themeColor, type Theme } from "./brand";
import type { BackgroundLayer, BackgroundPreset } from "./format";

/**
 * Live backgrounds for motion templates: full-frame WebGL2 shaders in the Brand Kit's colours,
 * drawn by the player (player.ts) into the template's canvas, so the template browser, the editor
 * preview and the export all show the same thing. Previews render at half size (they're soft
 * anyway) and exports at full size.
 *
 * API (for template authors):
 *   - Layer kind "background" (format.ts `BackgroundLayer`): `{ id, kind: "background", frame: FULL,
 *     preset, colors?, speed?, intensity?, seed?, grain?, vignette?, drift?, soft?, over? }`.
 *     Every number may be keyframed (`[[t, v, ease?], …]`).
 *   - Presets (`BG_PRESETS`): "mesh" flowing mesh gradient (domain-warped noise), "aurora" light
 *     ribbons, "rays" god rays from the template's `light` (or the top left), "bokeh" out-of-focus
 *     circles in three depths with parallax, "glass" translucent blobs that refract what's behind
 *     them (with `over: true`, the layers below; otherwise their own colour field), "grid" a
 *     perspective floor grid running toward the camera with a horizon glow, "waves" layered
 *     liquid waves, "drift" slow dust and sparks.
 *   - `over: true` draws a preset with transparency over the layers below instead of filling, so
 *     two backgrounds stack for depth (a mesh, then bokeh or rays over it).
 *   - `colors`: up to six paints; missing ones come from the Brand Kit (`BG_COLORS` per preset;
 *     by convention 0–2 are the lights, 3 the dark base and 4 the light base).
 *   - Template `light: { x, y }` (canvas fractions, keyframable) aims rays, and shadows with
 *     `follow: true` fall away from it. `lightWrap` on a layer spills light onto its edges.
 *   - Rules (plan §4): at least two moving background layers, never flat or static, cycles of
 *     8–20 s, colours from the Brand Kit, text readable at the brightest moment.
 *
 * Example:
 *   layers: [
 *     { id: "bg", kind: "background", preset: "mesh", frame: FULL, speed: 1, intensity: 0.9 },
 *     { id: "bokeh", kind: "background", preset: "bokeh", frame: FULL, over: true, intensity: [[0, 0], [1.2, 0.8]] },
 *     …
 *   ]
 *
 * The parameter maths (`normalizeBackground`, `backgroundState`, `motionPhase`) is pure and tested
 * in tools/motion.test.mjs; the GL part draws only in a browser and falls back to Canvas 2D
 * gradients without WebGL2.
 */

export const BG_PRESETS: readonly BackgroundPreset[] = ["mesh", "aurora", "rays", "bokeh", "glass", "grid", "waves", "drift"];

/** Each preset's Brand Kit colours (0–2 lights, 3 the dark base, 4 the light base, 5 an extra). */
export const BG_COLORS: Record<BackgroundPreset, string[]> = {
  mesh: ["@primary", "@secondary", "@accent", "@deep", "@bg", "@primaryDeep"],
  aurora: ["@primary", "@accent", "@secondary", "@deep", "@bg", "#ffffff"],
  rays: ["@primary", "@accent", "@secondary", "@deep", "@bg", "#ffffff"],
  bokeh: ["@primary", "@accent", "@secondary", "@deep", "@bg", "#ffffff"],
  glass: ["@primary", "@accent", "@secondary", "@deep", "@bg", "#ffffff"],
  grid: ["@primary", "@accent", "@secondary", "@deep", "@bg", "#ffffff"],
  waves: ["@primary", "@secondary", "@accent", "@deep", "@bg", "@primaryDeep"],
  drift: ["@accent", "@primary", "#ffffff", "@deep", "@bg", "@secondary"],
};

const PAINT = /^(@[a-zA-Z]+|#[0-9a-fA-F]{6})(\/(0(\.\d+)?|1(\.0+)?|\.\d+))?$/;

const isAnim = (v: unknown): v is Anim => (typeof v === "number" && Number.isFinite(v))
  || (Array.isArray(v) && v.length > 0 && v.length <= 256 && v.every((k) => Array.isArray(k) && Number.isFinite(k[0]) && Number.isFinite(k[1])));

/** The parameters a background layer is drawn with: unknown presets, bad colours and non-numbers dropped. */
export type BackgroundSpec = Pick<BackgroundLayer, "preset" | "colors" | "speed" | "intensity" | "seed" | "grain" | "vignette" | "drift" | "soft" | "over">;

export function normalizeBackground(raw: unknown): BackgroundSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: BackgroundSpec = { preset: BG_PRESETS.includes(r.preset as BackgroundPreset) ? (r.preset as BackgroundPreset) : "mesh" };
  if (Array.isArray(r.colors)) out.colors = r.colors.filter((c): c is string => typeof c === "string" && PAINT.test(c)).slice(0, 6);
  for (const k of ["speed", "intensity", "grain", "vignette", "drift", "soft"] as const) if (isAnim(r[k])) out[k] = r[k] as Anim;
  if (typeof r.seed === "number" && Number.isFinite(r.seed)) out.seed = r.seed;
  if (r.over === true) out.over = true;
  return out;
}

/**
 * How far a background has moved by template time `t`: seconds at its pace, so a keyframed speed
 * speeds up and slows down smoothly instead of jumping.
 */
export function motionPhase(speed: Anim | undefined, t: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(4, v));
  if (speed === undefined) return t;
  if (typeof speed === "number") return t * clamp(speed);
  if (!speed.length) return t;
  // Constant before the first key and after the last; each segment integrated in small steps.
  const first = speed[0], last = speed[speed.length - 1];
  let sum = 0;
  if (t <= first[0]) return t * clamp(first[1]);
  sum += first[0] * clamp(first[1]);
  for (let i = 0; i < speed.length - 1; i++) {
    const a = speed[i][0], b = Math.min(t, speed[i + 1][0]);
    if (b <= a) continue;
    const steps = 24, h = (b - a) / steps;
    let s = 0;
    for (let k = 0; k <= steps; k++) s += clamp(valueAt(speed, a + k * h, 1)) * (k === 0 || k === steps ? 0.5 : 1);
    sum += s * h;
    if (t <= speed[i + 1][0]) return sum;
  }
  return sum + (t - last[0]) * clamp(last[1]);
}

/** Everything a background needs at one moment, in shader terms. */
export interface BackgroundState {
  preset: BackgroundPreset;
  /** Six colours, 0…1 per channel. */
  colors: [number, number, number][];
  phase: number;
  intensity: number;
  grain: number;
  vignette: number;
  drift: number;
  soft: number;
  seed: number;
  /** The light (canvas fractions). */
  light: [number, number];
  over: boolean;
}

export function backgroundState(layer: unknown, t: number, theme: Theme, light?: [number, number]): BackgroundState {
  const spec = normalizeBackground(layer);
  // The layer's own paints, else (a base layer) a template look's background paints, else the preset's.
  const paints = BG_COLORS[spec.preset].map((p, i) => spec.colors?.[i] ?? (spec.over ? undefined : theme.backdrop?.[i]) ?? p);
  const colors = paints.map((p) => {
    const { hex } = themeColor(p, theme);
    const [r, g, b] = /^#[0-9a-f]{6}$/i.test(hex) ? rgbOf(hex) : [128, 128, 128];
    return [r / 255, g / 255, b / 255] as [number, number, number];
  });
  const num = (a: Anim | undefined, fallback: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, valueAt(a, t, fallback)));
  return {
    preset: spec.preset,
    colors,
    phase: motionPhase(spec.speed, t),
    intensity: num(spec.intensity, 1, 0, 1.5),
    grain: num(spec.grain, theme.grain ?? 0.02, 0, 0.1),
    vignette: num(spec.vignette, 0.35, 0, 1),
    drift: num(spec.drift, 0.5, 0, 1),
    soft: num(spec.soft, 0, 0, 1),
    seed: spec.seed ?? 0,
    light: light ?? [0.22, -0.05],
    over: !!spec.over,
  };
}

// ---- shaders

const VERTEX = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2. - 1., 0, 1); }`;

const HEADER = `#version 300 es
precision highp float; out vec4 o;
uniform vec2 res; uniform float phase, clock, seed, intensity, grainAmt, vignetteAmt, drift, soft;
uniform vec3 col[6]; uniform vec2 light; uniform int over, hasBelow; uniform sampler2D below; uniform vec4 belowRect;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 hash2(vec2 p){ float n = hash(p); return vec2(n, hash(p + n + 17.17)); }
vec2 grad(vec2 i){ float a = hash(i) * 6.2831853; return vec2(cos(a), sin(a)); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = dot(grad(i), f), b = dot(grad(i + vec2(1, 0)), f - vec2(1, 0));
  float c = dot(grad(i + vec2(0, 1)), f - vec2(0, 1)), d = dot(grad(i + vec2(1, 1)), f - vec2(1, 1));
  return .5 + .75 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float v = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  int oct = soft > .5 ? 3 : 5;
  for (int i = 0; i < 5; i++){ if (i >= oct) break; v += a * noise(p); p = m * p; a *= .5; }
  return v / (1. - pow(.5, float(oct)));
}
vec3 baseOf(vec2 uv){ return mix(col[3], col[4], .18 + .3 * uv.y); }
vec4 preset(vec2 uv, vec2 p, float aspect);
void main(){
  vec2 uv = vec2(gl_FragCoord.x / res.x, 1. - gl_FragCoord.y / res.y);
  // A slow camera: a push-in breathing over about 30 s and a sway over about 50.
  float push = 1. - drift * .07 * (.5 - .5 * cos(phase * .21));
  vec2 c = (uv - .5) * push + .5 + drift * .025 * vec2(sin(phase * .13 + seed), cos(phase * .11 + seed * 1.7));
  float aspect = res.x / res.y;
  vec2 p = vec2((c.x - .5) * aspect, c.y - .5);
  vec4 s = preset(c, p, aspect);
  vec3 rgb = over == 1 ? s.rgb : mix(baseOf(c), s.rgb, s.a);
  float a = over == 1 ? clamp(s.a, 0., 1.) : 1.;
  if (over == 0) rgb *= 1. - vignetteAmt * smoothstep(.42, 1.25, length(uv - .5) * 1.414);
  // Coarse grain (cells of about 2 px at 1080), refreshed 24 times a second, so a re-encode keeps it.
  vec2 cell = floor(gl_FragCoord.xy / max(1., res.y / 960.));
  rgb += (hash(cell + floor(clock * 24.) * vec2(113., 71.)) - .5) * grainAmt * (over == 1 ? a : 1.) * 2.;
  o = vec4(clamp(rgb, 0., 1.) * a, a);
}
`;

const PRESETS: Record<BackgroundPreset, string> = {
  mesh: `vec4 preset(vec2 uv, vec2 p, float aspect){
  float t = phase * .07; vec2 q = p * 1.15 + seed * .37;
  vec2 w1 = vec2(fbm(q + vec2(0, t)), fbm(q + vec2(5.2, 1.3) - t * .8));
  vec2 w2 = vec2(fbm(q + 2.2 * w1 + vec2(1.7, 9.2) + t * .6), fbm(q + 2.2 * w1 + vec2(8.3, 2.8) - t * .5));
  // fbm sits around .5: stretched, so the colours really separate into soft fields.
  float f = clamp((fbm(q + 1.8 * w2) - .5) * 2.2 + .5, 0., 1.);
  w1 = clamp((w1 - .5) * 2.1 + .5, 0., 1.); w2 = clamp((w2 - .5) * 2.1 + .5, 0., 1.);
  vec3 c = mix(col[3], col[0], smoothstep(.15, .75, f));
  c = mix(c, col[1], smoothstep(.3, .9, w2.x) * .8);
  c = mix(c, col[2], smoothstep(.5, .98, w2.y) * .7 * min(intensity, 1.));
  c = mix(c, col[5], smoothstep(.55, .95, 1. - f) * .55);
  c = mix(c, col[4], smoothstep(.7, 1., w1.x) * .25);
  c += col[2] * pow(smoothstep(.55, 1., f * w2.x), 2.) * .3 * intensity;
  return vec4(mix(col[3], c, clamp(.45 + .55 * intensity, 0., 1.2)), 1);
}`,
  aurora: `vec4 preset(vec2 uv, vec2 p, float aspect){
  float t = phase * .12; vec3 acc = vec3(0);
  for (int i = 0; i < 3; i++){
    float fi = float(i), x = p.x * (1.1 + fi * .25);
    float y0 = -.16 + fi * .13 + .09 * sin(x * 2.1 + t * (1. + fi * .3) + fi * 2. + seed) + .14 * (fbm(vec2(x * .8 + t * .35, fi * 3.1 + seed)) - .5);
    float up = y0 - p.y;
    float g = up > 0. ? exp(-up * (3.2 + fi * 1.3)) : exp(-up * up * 420.);
    g *= .5 + .5 * noise(vec2(x * 15. + fi * 7., t * .7 + fi)) * (1. - soft * .6);
    acc += col[i] * g * (.75 + .25 * sin(t * .8 + fi * 2.));
  }
  acc *= .9 * intensity;
  float star = step(.996, hash(floor(uv * res / 2.5) + seed)) * (.4 + .4 * sin(phase * 1.3 + hash(floor(uv * res / 2.5)) * 40.)) * (1. - smoothstep(.15, .6, uv.y));
  if (over == 1) { float a = clamp(max(acc.r, max(acc.g, acc.b)), 0., 1.); return vec4(acc / max(a, 1e-3), a); }
  return vec4(mix(col[3], col[4] * .55, (1. - uv.y) * .25) + acc + star * .6, 1);
}`,
  rays: `vec4 preset(vec2 uv, vec2 p, float aspect){
  vec2 L = vec2((light.x - .5) * aspect, light.y - .5); vec2 d = p - L;
  float r = length(d), ang = atan(d.y, d.x), t = phase * .06;
  float rays = smoothstep(.4, .9, noise(vec2(ang * 6. + seed, t))) + .7 * smoothstep(.45, .95, noise(vec2(ang * 13. - seed, t * 1.3 + 4.))) + .3 * noise(vec2(ang * 29., t * 1.7 + 9.));
  float fall = exp(-r * 1.05), glow = exp(-r * r * 4.);
  float motes = pow(noise(p * 9. + vec2(t * 4., -t * 6.)), 6.) * 1.6;
  vec3 lc = mix(col[0], col[1], smoothstep(0., .8, glow));
  float k = (rays * (.5 + motes) * fall + glow * .65) * intensity;
  if (over == 1) return vec4(lc, clamp(k, 0., 1.));
  return vec4(baseOf(uv) * (.75 + .25 * fbm(p * 1.5 + t)) + lc * k, 1);
}`,
  bokeh: `vec4 preset(vec2 uv, vec2 p, float aspect){
  vec3 acc = vec3(0); float cov = 0.;
  for (int L = 0; L < 3; L++){
    float fl = float(L), scale = 2.4 + fl * 2.2;
    vec2 q = (p + vec2(phase * (.012 + fl * .01), -phase * (.018 + fl * .016))) * scale + seed * (fl + 1.);
    vec2 id = floor(q), f = fract(q);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
      vec2 cell = id + vec2(i, j), h = hash2(cell + fl * 31.);
      if (h.x > .5) continue;
      vec2 c = vec2(i, j) + .5 + (h - .5) * .7;
      float rad = (.2 + .26 * hash(cell + 7.)) * (1. - fl * .12), d = length(f - c);
      float edge = (.18 - fl * .06 + soft * .25) * rad;
      float b = smoothstep(rad, rad - edge, d) * (.72 + .28 * smoothstep(rad * .55, rad, d));
      b *= (.6 + .4 * sin(phase * .45 + h.y * 20.)) * (.3 + fl * .22) * intensity;
      acc += col[int(h.y * 2.99)] * b; cov = max(cov, b);
    }
  }
  if (over == 1) { float a = clamp(cov * 1.2, 0., 1.); return vec4(acc / max(cov, 1e-3), a); }
  return vec4(baseOf(uv) + col[0] * .16 * fbm(p * 1.4 + phase * .03) + acc, 1);
}`,
  glass: `float field(vec2 p, float aspect){
  float F = 0.;
  // Five drops of glass drifting on slow, different orbits.
  for (int i = 0; i < 5; i++){
    float fi = float(i), t = phase * (.09 + fi * .021);
    vec2 m = vec2(sin(t + fi * 2.1 + seed) * .36 * aspect, cos(t * 1.3 + fi * 1.7 + seed) * .36);
    float r = .075 + .022 * fi; vec2 d = p - m; F += r * r / max(dot(d, d), 1e-4);
  }
  return F;
}
vec3 behind(vec2 uv, vec2 p){
  if (hasBelow == 1) return texture(below, belowRect.xy + clamp(uv, 0., 1.) * belowRect.zw).rgb;
  float f = clamp((fbm(p * 1.3 + phase * .05) - .5) * 2.4 + .5, 0., 1.), g = clamp((fbm(p * 2. - phase * .04 + 3.) - .5) * 2.4 + .5, 0., 1.);
  return mix(mix(col[3], col[0], smoothstep(.2, .85, f)), col[1], smoothstep(.45, .95, g) * .65);
}
vec4 preset(vec2 uv, vec2 p, float aspect){
  float F = field(p, aspect), e = .003;
  vec2 n = normalize(vec2(field(p + vec2(e, 0), aspect) - field(p - vec2(e, 0), aspect), field(p + vec2(0, e), aspect) - field(p - vec2(0, e), aspect)) + 1e-6);
  float inside = smoothstep(.92, 1.08, F), bend = 1. - smoothstep(1., 2.6, F);
  vec2 off = n * bend * .045, fr = n * bend * .006;
  vec3 g = vec3(behind(uv + off + fr, p + off).r, behind(uv + off, p + off).g, behind(uv + off - fr, p + off).b);
  g = g * 1.08 + .04 + col[5] * .06;
  vec2 L = normalize(vec2(light.x - .5, light.y - .5) + 1e-4);
  g += col[5] * (pow(max(dot(-n, L), 0.), 6.) * .45 + smoothstep(1., 1.25, F) * (1. - smoothstep(1.25, 2., F)) * .22) * intensity;
  if (over == 1) return vec4(g, inside * .96);
  return vec4(mix(behind(uv, p), g, inside), 1);
}`,
  grid: `vec4 preset(vec2 uv, vec2 p, float aspect){
  float hz = -.06;
  vec3 c = mix(col[3], col[4], smoothstep(-.5, hz, p.y) * .45);
  float glow = exp(-abs(p.y - hz) * 9.) * intensity;
  c += col[1] * glow * .65 + col[0] * exp(-length(vec2(p.x * .6, (p.y - hz) * 2.2)) * 5.) * .5 * intensity;
  float lines = 0.;
  if (p.y > hz + .002){
    float z = 1.1 / (p.y - hz);
    vec2 g = vec2(p.x * z * 1.3, z + phase * .5), fw = fwidth(g);
    vec2 d = abs(fract(g - .5) - .5) / max(fw * 1.2, 1e-4);
    float fade = exp(-z * .05) * smoothstep(0., .04, p.y - hz);
    lines = (1. - min(min(d.x, d.y), 1.)) * fade;
    c = mix(c, col[3] * .55, smoothstep(hz, hz + .35, p.y) * .45);
    c += (col[0] * 1.1 * intensity + col[1] * .35) * lines;
  }
  if (over == 1) return vec4(mix(col[1], col[0], lines), clamp(lines * intensity + glow * .5, 0., 1.));
  return vec4(c, 1);
}`,
  waves: `vec4 preset(vec2 uv, vec2 p, float aspect){
  vec3 c = mix(mix(col[4], col[0], .45), col[3], smoothstep(-.6, .3, p.y)); float cov = 0.;
  for (int i = 0; i < 4; i++){
    float fi = float(i), x = p.x;
    float y = -.02 + fi * .12 + .045 * sin(x * (2.2 + fi * .7) + phase * (.33 + fi * .1) + fi * 1.3 + seed)
      + .025 * sin(x * (4.1 + fi) - phase * (.45 + fi * .08) + fi * 2.7) + .03 * (fbm(vec2(x * 1.3 + phase * .05, fi * 4.)) - .5);
    float d = p.y - y, body = smoothstep(-.003, .003, d);
    int k = i == 0 ? 2 : i == 1 ? 1 : i == 2 ? 0 : 5;
    vec3 w = mix(col[k], col[3], clamp(d * 1.5, 0., .6) + fi * .06);
    w += (.3 * exp(-d * 45.) + .06 * noise(vec2(x * 30., d * 30. + phase * .3))) * intensity * body;
    c = mix(c, w, body); cov = max(cov, body);
  }
  return vec4(c, over == 1 ? cov : 1.);
}`,
  drift: `vec4 preset(vec2 uv, vec2 p, float aspect){
  vec3 acc = vec3(0); float cov = 0.;
  for (int L = 0; L < 3; L++){
    float fl = float(L), scale = 7. + fl * 5.;
    vec2 q = (p + vec2(sin(phase * .2 + fl) * .02, phase * (.014 + fl * .011))) * scale + seed * (fl + 1.);
    vec2 id = floor(q), f = fract(q);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
      vec2 cell = id + vec2(i, j), h = hash2(cell + fl * 17.);
      if (h.x > .45) continue;
      vec2 c = vec2(i, j) + .5 + (h - .5) * .8 + vec2(sin(phase * .5 + h.y * 30.) * .15, 0);
      float s = (.035 + .05 * hash(cell + 3.)) * (1. + fl * .25) * (1. + soft), d = length(f - c);
      float g = exp(-d * d / (s * s)) * (.55 + .45 * sin(phase * (.6 + h.x) + h.y * 40.)) * (.35 + fl * .3) * intensity;
      acc += mix(col[0], col[2], h.y) * g; cov = max(cov, g);
    }
  }
  if (over == 1) { float a = clamp(cov * 1.3, 0., 1.); return vec4(acc / max(cov, 1e-3), a); }
  return vec4(baseOf(uv) + col[1] * .14 * fbm(p * 1.2 - phase * .02) + acc, 1);
}`,
};

// ---- drawing

interface Program { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

let glCanvas: HTMLCanvasElement | null = null;
let gl: WebGL2RenderingContext | null = null;
let failed = false;
let belowTex: WebGLTexture | null = null;
const programs = new Map<BackgroundPreset, Program | null>();

function context(): WebGL2RenderingContext | null {
  if (gl && !gl.isContextLost()) return gl;
  if (failed && !gl) return null;
  try {
    glCanvas ??= document.createElement("canvas");
    gl = glCanvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false }) as WebGL2RenderingContext | null;
    if (!gl) {
      failed = true;
      return null;
    }
    glCanvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      programs.clear();
      belowTex = null;
    });
    glCanvas.addEventListener("webglcontextrestored", () => programs.clear());
    return gl;
  } catch {
    failed = true;
    return null;
  }
}

function compile(g: WebGL2RenderingContext, preset: BackgroundPreset): Program | null {
  const shader = (type: number, src: string) => {
    const s = g.createShader(type)!;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
      console.warn("[motion] background shader", preset, g.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = shader(g.VERTEX_SHADER, VERTEX), fs = shader(g.FRAGMENT_SHADER, HEADER + PRESETS[preset]);
  if (!vs || !fs) return null;
  const prog = g.createProgram()!;
  g.attachShader(prog, vs);
  g.attachShader(prog, fs);
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
    console.warn("[motion] background program", preset, g.getProgramInfoLog(prog));
    return null;
  }
  const u: Program["u"] = {};
  for (const n of ["res", "phase", "clock", "seed", "intensity", "grainAmt", "vignetteAmt", "drift", "soft", "col", "light", "over", "hasBelow", "below", "belowRect"]) u[n] = g.getUniformLocation(prog, n);
  return { prog, u };
}

/**
 * Renders a background `w` × `h` pixels; the canvas it returns holds it until the next call (draw
 * it right away). `below`: what to refract (glass over other layers), with the part of it under
 * the background as 0…1 fractions. Null without WebGL2.
 */
export function renderBackground(s: BackgroundState, w: number, h: number, clock: number, below?: { source: TexImageSource; rect: [number, number, number, number] }): HTMLCanvasElement | null {
  const g = context();
  if (!g || !glCanvas) return null;
  if (!programs.has(s.preset)) programs.set(s.preset, compile(g, s.preset));
  const p = programs.get(s.preset);
  if (!p) return null;
  w = Math.max(2, Math.min(4096, Math.round(w)));
  h = Math.max(2, Math.min(4096, Math.round(h)));
  if (glCanvas.width !== w || glCanvas.height !== h) {
    glCanvas.width = w;
    glCanvas.height = h;
  }
  g.viewport(0, 0, w, h);
  g.disable(g.BLEND);
  g.useProgram(p.prog);
  const u = p.u;
  g.uniform2f(u.res, w, h);
  g.uniform1f(u.phase, s.phase);
  g.uniform1f(u.clock, clock);
  g.uniform1f(u.seed, s.seed);
  g.uniform1f(u.intensity, s.intensity);
  g.uniform1f(u.grainAmt, s.grain);
  g.uniform1f(u.vignetteAmt, s.vignette);
  g.uniform1f(u.drift, s.drift);
  g.uniform1f(u.soft, s.soft);
  g.uniform3fv(u.col, s.colors.flat());
  g.uniform2f(u.light, s.light[0], s.light[1]);
  g.uniform1i(u.over, s.over ? 1 : 0);
  if (below) {
    belowTex ??= g.createTexture();
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, belowTex);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, below.source);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.uniform1i(u.below, 0);
    g.uniform4f(u.belowRect, ...below.rect);
  }
  g.uniform1i(u.hasBelow, below ? 1 : 0);
  g.clearColor(0, 0, 0, 0);
  g.clear(g.COLOR_BUFFER_BIT);
  g.drawArrays(g.TRIANGLES, 0, 3);
  return glCanvas;
}

/** Without WebGL2: soft gradients drifting over the base, so it's never flat. */
export function drawBackgroundFallback(ctx: CanvasRenderingContext2D, s: BackgroundState, x: number, y: number, w: number, h: number) {
  const css = ([r, g, b]: [number, number, number], a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
  ctx.save();
  if (!s.over) {
    const base = ctx.createLinearGradient(x, y, x, y + h);
    base.addColorStop(0, css(s.colors[3]));
    base.addColorStop(1, css(s.colors[4]));
    ctx.fillStyle = base;
    ctx.fillRect(x, y, w, h);
  }
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 3; i++) {
    const cx = x + w * (0.5 + 0.35 * Math.sin(s.phase * (0.09 + i * 0.02) + i * 2.1 + s.seed));
    const cy = y + h * (0.5 + 0.3 * Math.cos(s.phase * (0.07 + i * 0.03) + i * 1.3 + s.seed));
    const r = Math.max(w, h) * (0.45 + i * 0.1);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, css(s.colors[i], 0.55 * s.intensity));
    g.addColorStop(1, css(s.colors[i], 0));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}
