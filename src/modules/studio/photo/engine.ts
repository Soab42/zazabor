import { ADJUST_GLSL, setAdjustUniforms, type Adjustments } from "./adjust";
import { bytesPerPixel, dropTarget, makeProgram, makeQuad, makeTarget, makeTexture, probeGpu, QUAD_VERTEX, readInto, unpackRaw, type GpuInfo, type Program, type Target, type TexFormat } from "./gl";
import { lutFor, setSpecUniforms, SPEC_GLSL, type AdjSpec } from "./layeradjust";
import { LUT_SIZE } from "./tone";
import type { LayerSource } from "./vector";

/**
 * Photo's GPU side: layers composited with blend modes, masks, clipping masks and groups into a
 * 16-bit float buffer (8-bit when the GPU can't render into floats), painting into a stroke buffer
 * (limited to the selection), and the view of the result.
 *
 * Coordinates are document pixels, top-left first: a texture's row 0 is the picture's top row
 * and a framebuffer's row 0 is too, so only the on-screen view flips.
 */

export type BlendMode =
  | "normal" | "dissolve"
  | "darken" | "multiply" | "colorBurn" | "linearBurn" | "darkerColor"
  | "lighten" | "screen" | "colorDodge" | "linearDodge" | "lighterColor"
  | "overlay" | "softLight" | "hardLight" | "vividLight" | "linearLight" | "pinLight" | "hardMix"
  | "difference" | "exclusion" | "subtract" | "divide"
  | "hue" | "saturation" | "color" | "luminosity";

/** Photoshop's blend modes in its groups, each with its formula (backdrop `cb`, layer `cs`). */
export const BLEND_GROUPS: { id: BlendMode; label: string; glsl: string }[][] = [
  [
    { id: "normal", label: "Normal", glsl: "cs" },
    { id: "dissolve", label: "Dissolve", glsl: "cs" },
  ],
  [
    { id: "darken", label: "Darken", glsl: "min(cb, cs)" },
    { id: "multiply", label: "Multiply", glsl: "cb * cs" },
    { id: "colorBurn", label: "Color Burn", glsl: "burn(cb, cs)" },
    { id: "linearBurn", label: "Linear Burn", glsl: "max(cb + cs - 1.0, 0.0)" },
    { id: "darkerColor", label: "Darker Color", glsl: "lum(cs) < lum(cb) ? cs : cb" },
  ],
  [
    { id: "lighten", label: "Lighten", glsl: "max(cb, cs)" },
    { id: "screen", label: "Screen", glsl: "cb + cs - cb * cs" },
    { id: "colorDodge", label: "Color Dodge", glsl: "dodge(cb, cs)" },
    { id: "linearDodge", label: "Linear Dodge (Add)", glsl: "min(cb + cs, 1.0)" },
    { id: "lighterColor", label: "Lighter Color", glsl: "lum(cs) > lum(cb) ? cs : cb" },
  ],
  [
    { id: "overlay", label: "Overlay", glsl: "hardLight(cs, cb)" },
    { id: "softLight", label: "Soft Light", glsl: "softLight(cb, cs)" },
    { id: "hardLight", label: "Hard Light", glsl: "hardLight(cb, cs)" },
    { id: "vividLight", label: "Vivid Light", glsl: "vivid(cb, cs)" },
    { id: "linearLight", label: "Linear Light", glsl: "clamp(cb + 2.0 * cs - 1.0, 0.0, 1.0)" },
    { id: "pinLight", label: "Pin Light", glsl: "pin(cb, cs)" },
    { id: "hardMix", label: "Hard Mix", glsl: "step(1.0, cb + cs)" },
  ],
  [
    { id: "difference", label: "Difference", glsl: "abs(cb - cs)" },
    { id: "exclusion", label: "Exclusion", glsl: "cb + cs - 2.0 * cb * cs" },
    { id: "subtract", label: "Subtract", glsl: "max(cb - cs, 0.0)" },
    { id: "divide", label: "Divide", glsl: "divide(cb, cs)" },
  ],
  [
    { id: "hue", label: "Hue", glsl: "setLum(setSat(cs, sat(cb)), lum(cb))" },
    { id: "saturation", label: "Saturation", glsl: "setLum(setSat(cb, sat(cs)), lum(cb))" },
    { id: "color", label: "Color", glsl: "setLum(cs, lum(cb))" },
    { id: "luminosity", label: "Luminosity", glsl: "setLum(cb, lum(cs))" },
  ],
];

export const BLEND_MODES = BLEND_GROUPS.flat();
const BLEND_INDEX = new Map(BLEND_MODES.map((m, i) => [m.id, i]));
export const isBlendMode = (v: unknown): v is BlendMode => typeof v === "string" && BLEND_INDEX.has(v as BlendMode);

/** Pixels that can be painted on: a pixel layer, or a layer's mask. */
export interface Surface {
  tex: WebGLTexture;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A layer mask: grey in an RGBA texture (white shows the layer), placed like a pixel layer. */
export interface LayerMask extends Surface {
  /** What the mask is outside its rectangle: 0 hides, 1 shows. */
  fill: number;
  enabled: boolean;
}

interface LayerBase {
  id: number;
  name: string;
  visible: boolean;
  /** 0–1. */
  opacity: number;
  blend: BlendMode;
  /** The group this layer is in (its id), or null at the top. */
  parent: number | null;
  /** Shown only where the layer below it (in the same group) has pixels: a clipping mask. */
  clip: boolean;
  mask: LayerMask | null;
}

/** Pixels: straight-alpha RGBA, placed at (x, y) in the document; text and shapes keep their source. */
export interface PixelLayer extends LayerBase, Surface {
  kind: "pixel";
  source: LayerSource | null;
}

/** An adjustment applied to everything below: Light & Colour (`adjust`) or another kind (`spec`). */
export interface AdjustLayer extends LayerBase {
  kind: "adjust";
  adjust: Adjustments;
  spec: AdjSpec;
}

/**
 * A group. Its layers sit right below it in the list with `parent` set to its id. Pass Through
 * groups mix their layers straight into what's below; others are composited on their own first
 * and then blended like one layer.
 */
export interface GroupLayer extends LayerBase {
  kind: "group";
  passThrough: boolean;
  /** Shown open in the Layers panel. */
  open: boolean;
}

export type Layer = PixelLayer | AdjustLayer | GroupLayer;

export interface Doc {
  width: number;
  height: number;
  /** Bottom first; a group's layers come right before (below) the group. */
  layers: Layer[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What's being painted right now: onto a pixel layer, or onto a layer's mask with `mask` (any
 * kind of layer can have one).
 */
export type Paint =
  | { kind: "brush"; layer: Layer; mask: boolean; color: [number, number, number]; opacity: number }
  | { kind: "erase"; layer: Layer; mask: boolean; opacity: number }
  | { kind: "gradient"; layer: Layer; mask: boolean; from: [number, number]; to: [number, number]; a: [number, number, number, number]; b: [number, number, number, number]; radial: boolean; opacity: number }
  /** Clone stamp: the surface's own pixels from `offset` (surface pixels) away. */
  | { kind: "clone"; layer: Layer; mask: boolean; offset: [number, number]; opacity: number };

/** One brush dab: its centre in surface pixels, radius and strength (flow × pressure). */
export interface Dab {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

export interface View {
  /** Device pixels per document pixel. */
  scale: number;
  /** The document's top-left corner on the canvas, in device pixels. */
  x: number;
  y: number;
}

/** A 2D affine map as [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

export function invertAffine(m: Affine): Affine {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const applyAffine = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const blendGlsl = () => `
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float burn1(float b, float s) { return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
float dodge1(float b, float s) { return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
vec3 burn(vec3 b, vec3 s) { return vec3(burn1(b.r, s.r), burn1(b.g, s.g), burn1(b.b, s.b)); }
vec3 dodge(vec3 b, vec3 s) { return vec3(dodge1(b.r, s.r), dodge1(b.g, s.g), dodge1(b.b, s.b)); }
vec3 hardLight(vec3 b, vec3 s) {
  vec3 lo = b * 2.0 * s;
  vec3 t = 2.0 * s - 1.0;
  vec3 hi = b + t - b * t;
  return mix(lo, hi, step(0.5, s));
}
vec3 softLight(vec3 b, vec3 s) {
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  vec3 lo = b - (1.0 - 2.0 * s) * b * (1.0 - b);
  vec3 hi = b + (2.0 * s - 1.0) * (d - b);
  return mix(lo, hi, step(0.5, s));
}
vec3 vivid(vec3 b, vec3 s) { return mix(burn(b, 2.0 * s), dodge(b, 2.0 * (s - 0.5)), step(0.5, s)); }
vec3 pin(vec3 b, vec3 s) { return mix(min(b, 2.0 * s), max(b, 2.0 * (s - 0.5)), step(0.5, s)); }
vec3 divide(vec3 b, vec3 s) {
  return vec3(s.r <= 0.0 ? step(1e-6, b.r) : min(1.0, b.r / s.r), s.g <= 0.0 ? step(1e-6, b.g) : min(1.0, b.g / s.g), s.b <= 0.0 ? step(1e-6, b.b) : min(1.0, b.b / s.b));
}
vec3 blend(int m, vec3 cb, vec3 cs) {
${BLEND_MODES.map((mode, i) => `  if (m == ${i}) return ${mode.glsl};`).join("\n")}
  return cs;
}`;

/** Texture units the compositing program reads. */
const UNIT = { back: 0, layer: 1, paint: 2, mask: 3, clipLayer: 4, clipMask: 5, lut: 6, sel: 7 } as const;

const COMPOSITE = () => `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBack;
uniform sampler2D uLayer;
uniform sampler2D uPaint;
uniform sampler2D uMask;
uniform sampler2D uClipLayer;
uniform sampler2D uClipMask;
uniform sampler2D uSel;
uniform int uKind;
uniform bool uSpec;
uniform int uMode;
uniform float uOpacity;
uniform ivec2 uLayerPos;
uniform ivec2 uLayerSize;
uniform vec2 uDocSize;
uniform bool uHasMask;
uniform ivec2 uMaskPos;
uniform ivec2 uMaskSize;
uniform float uMaskFill;
uniform bool uClip;
uniform ivec2 uClipPos;
uniform ivec2 uClipSize;
uniform float uClipOpacity;
uniform bool uClipHasMask;
uniform ivec2 uClipMaskPos;
uniform ivec2 uClipMaskSize;
uniform float uClipMaskFill;
uniform int uPaintMode;
uniform bool uPaintOnMask;
uniform vec3 uPaintColor;
uniform float uPaintOpacity;
uniform vec2 uGradFrom;
uniform vec2 uGradTo;
uniform vec4 uGradA;
uniform vec4 uGradB;
uniform bool uGradRadial;
uniform ivec2 uCloneOffset;
uniform ivec2 uPaintOrigin;
uniform bool uHasSel;
uniform bool uXform;
uniform mat3 uXformInv;
uniform bool uBake;
uniform ivec2 uBakeOffset;
out vec4 outColor;
${ADJUST_GLSL}
${blendGlsl()}
${SPEC_GLSL}

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Straight-alpha source-over of a premultiplied colour.
vec4 over(vec4 dst, vec4 src) {
  float a = src.a + dst.a * (1.0 - src.a);
  vec3 c = src.rgb + dst.rgb * dst.a * (1.0 - src.a);
  return a > 0.0 ? vec4(c / a, a) : vec4(0.0);
}

bool outside(ivec2 q, ivec2 size) { return q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y; }

vec4 fetch(sampler2D s, ivec2 q, ivec2 size) { return outside(q, size) ? vec4(0.0) : texelFetch(s, q, 0); }

float selAt(ivec2 d) {
  if (!uHasSel) return 1.0;
  return outside(d, ivec2(uDocSize)) ? 0.0 : texelFetch(uSel, d, 0).r;
}

// The paint going onto a surface (layer or mask) at its pixel q, over its colour c.
vec4 painted(sampler2D surf, ivec2 size, vec4 c, ivec2 q) {
  if (uPaintMode == 0) return c;
  float sel = selAt(q + uPaintOrigin);
  if (uPaintMode == 1) {
    float a = texelFetch(uPaint, q, 0).a * uPaintOpacity * sel;
    return over(c, vec4(uPaintColor * a, a));
  }
  if (uPaintMode == 2) return vec4(c.rgb, c.a * (1.0 - texelFetch(uPaint, q, 0).a * uPaintOpacity * sel));
  if (uPaintMode == 3) {
    vec2 p = vec2(q) + 0.5;
    vec2 d = uGradTo - uGradFrom;
    float t = uGradRadial ? length(p - uGradFrom) / max(length(d), 1e-3) : dot(p - uGradFrom, d) / max(dot(d, d), 1e-6);
    t = clamp(t, 0.0, 1.0);
    vec4 g = mix(vec4(uGradA.rgb * uGradA.a, uGradA.a), vec4(uGradB.rgb * uGradB.a, uGradB.a), t) * uPaintOpacity * sel;
    return over(c, g);
  }
  if (uPaintMode == 4) {
    float a = texelFetch(uPaint, q, 0).a * uPaintOpacity * sel;
    vec4 s = fetch(surf, q + uCloneOffset, size);
    return over(c, vec4(s.rgb * s.a, s.a) * a);
  }
  return c;
}

// Bilinear sample of straight-alpha texels at a continuous texel position (centres at +0.5).
vec4 bilinear(sampler2D s, vec2 at, ivec2 size) {
  vec2 f = at - 0.5;
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  vec4 a = fetch(s, i, size), b = fetch(s, i + ivec2(1, 0), size), c = fetch(s, i + ivec2(0, 1), size), d = fetch(s, i + ivec2(1, 1), size);
  a.rgb *= a.a; b.rgb *= b.a; c.rgb *= c.a; d.rgb *= d.a;
  vec4 m = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  return m.a > 1e-6 ? vec4(m.rgb / m.a, m.a) : vec4(0.0);
}

vec2 sourcePoint(ivec2 p) { return (uXformInv * vec3(vec2(p) + 0.5, 1.0)).xy; }

vec4 layerAt(ivec2 p) {
  if (uXform) return bilinear(uLayer, sourcePoint(p) - vec2(uLayerPos), uLayerSize);
  ivec2 q = p - uLayerPos;
  if (outside(q, uLayerSize)) return vec4(0.0);
  vec4 c = texelFetch(uLayer, q, 0);
  return uPaintOnMask ? c : painted(uLayer, uLayerSize, c, q);
}

float maskAt(ivec2 p) {
  if (!uHasMask) return 1.0;
  ivec2 q = uXform ? ivec2(floor(sourcePoint(p))) - uMaskPos : p - uMaskPos;
  if (outside(q, uMaskSize)) return uMaskFill;
  vec4 m = texelFetch(uMask, q, 0);
  if (uPaintOnMask && !uXform) m = painted(uMask, uMaskSize, m, q);
  return m.r;
}

float clipAt(ivec2 p) {
  if (!uClip) return 1.0;
  float a = fetch(uClipLayer, p - uClipPos, uClipSize).a;
  if (uClipHasMask) {
    ivec2 m = p - uClipMaskPos;
    a *= outside(m, uClipMaskSize) ? uClipMaskFill : texelFetch(uClipMask, m, 0).r;
  }
  return a * uClipOpacity;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uBake) {
    ivec2 q = p + uBakeOffset;
    outColor = painted(uLayer, uLayerSize, texelFetch(uLayer, q, 0), q);
    return;
  }
  vec4 back = texelFetch(uBack, p, 0);
  float ab = back.a;
  vec3 cb = ab > 0.0 ? clamp(back.rgb / ab, 0.0, 1.0) : vec3(0.0);
  float cover = uOpacity * maskAt(p) * clipAt(p);
  if (uKind == 1) {
    vec3 cs = uSpec ? adjustSpec(cb) : adjust(cb, (vec2(p) + 0.5) / uDocSize);
    outColor = vec4(mix(cb, clamp(blend(uMode, cb, cs), 0.0, 1.0), cover) * ab, ab);
    return;
  }
  if (uKind == 3) {
    outColor = mix(back, texelFetch(uLayer, p, 0), cover);
    return;
  }
  vec4 s;
  if (uKind == 2) {
    vec4 g = texelFetch(uLayer, p, 0);
    s = g.a > 0.0 ? vec4(clamp(g.rgb / g.a, 0.0, 1.0), g.a) : vec4(0.0);
  } else s = layerAt(p);
  float as = s.a * cover;
  if (uMode == 1) as = hash(vec2(p)) < as ? 1.0 : 0.0;
  vec3 mixed = (1.0 - ab) * s.rgb + ab * clamp(blend(uMode, cb, s.rgb), 0.0, 1.0);
  outColor = vec4(as * mixed + (1.0 - as) * back.rgb, as + ab * (1.0 - as));
}`;

const VIEW = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uDoc;
uniform vec2 uCanvas;
uniform vec2 uOffset;
uniform float uScale;
uniform vec3 uBg;
uniform int uTaps;
out vec4 outColor;
void main() {
  vec2 px = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec2 d = (px - uOffset) / uScale;
  if (d.x < 0.0 || d.y < 0.0 || d.x >= uDoc.x || d.y >= uDoc.y) {
    outColor = vec4(uBg, 1.0);
    return;
  }
  vec2 cell = floor((px - uOffset) / 8.0);
  vec3 checker = mix(vec3(1.0), vec3(0.8), mod(cell.x + cell.y, 2.0));
  vec4 c;
  if (uTaps <= 1) {
    c = uScale >= 1.0 ? texelFetch(uImage, ivec2(d), 0) : texture(uImage, d / uDoc);
  } else {
    // Zoomed out: average the document pixels under this screen pixel.
    vec2 from = (px - 0.5 - uOffset) / uScale;
    float stepSize = 1.0 / uScale / float(uTaps);
    c = vec4(0.0);
    for (int j = 0; j < uTaps; j++)
      for (int i = 0; i < uTaps; i++)
        c += texture(uImage, (from + (vec2(i, j) + 0.5) * stepSize) / uDoc);
    c /= float(uTaps * uTaps);
  }
  outColor = vec4(c.rgb + checker * (1.0 - c.a), 1.0);
}`;

const DAB_VERTEX = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aDab;
layout(location = 2) in float aAlpha;
uniform vec2 uSize;
out vec2 vLocal;
out float vRadius;
out float vAlpha;
void main() {
  vLocal = aDab.xy;
  vRadius = aDab.z;
  vAlpha = aAlpha;
  gl_Position = vec4(aPos / uSize * 2.0 - 1.0, 0.0, 1.0);
}`;

const DAB_FRAGMENT = `#version 300 es
precision highp float;
uniform float uHardness;
in vec2 vLocal;
in float vRadius;
in float vAlpha;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float edge = clamp(vRadius - d + 0.5, 0.0, 1.0);
  float soft = uHardness >= 0.999 ? 1.0 : 1.0 - smoothstep(vRadius * uHardness, vRadius, d);
  outColor = vec4(0.0, 0.0, 0.0, vAlpha * min(edge, soft));
}`;

/** Exact moves of whole pixels: copy, quarter turns and flips. */
const XFORM = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform int uOp;
uniform ivec2 uSrcSize;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int w = uSrcSize.x, h = uSrcSize.y;
  ivec2 s = p;
  if (uOp == 1) s = ivec2(p.y, h - 1 - p.x);
  else if (uOp == 2) s = ivec2(w - 1 - p.x, h - 1 - p.y);
  else if (uOp == 3) s = ivec2(w - 1 - p.y, p.x);
  else if (uOp == 4) s = ivec2(w - 1 - p.x, p.y);
  else if (uOp == 5) s = ivec2(p.x, h - 1 - p.y);
  outColor = texelFetch(uSrc, s, 0);
}`;

/** Scaling with a box filter: thumbnails, previews and Image Size. */
const RESAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec4 uSrcRect;
uniform vec2 uDstSize;
uniform int uTaps;
uniform bool uPremultiplied;
uniform bool uStraightOut;
uniform bool uOnWhite;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy - 0.5;
  vec2 from = uSrcRect.xy + p / uDstSize * uSrcRect.zw;
  vec2 stepSize = uSrcRect.zw / uDstSize / float(uTaps);
  vec4 acc = vec4(0.0);
  for (int j = 0; j < uTaps; j++)
    for (int i = 0; i < uTaps; i++) {
      vec4 c = texture(uSrc, (from + (vec2(i, j) + 0.5) * stepSize) / uSrcSize);
      if (!uPremultiplied) c.rgb *= c.a;
      acc += c;
    }
  acc /= float(uTaps * uTaps);
  if (uOnWhite) acc = vec4(acc.rgb + (1.0 - acc.a), 1.0);
  outColor = uStraightOut ? (acc.a > 0.0 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0)) : acc;
}`;

/**
 * Free Transform's result: each output pixel (at `uOut` in the document) maps back through
 * `uInv` to the source, sampled bilinearly in premultiplied alpha with `uTaps`² samples when the
 * source shrinks. `uFill` is what lies outside the source (masks).
 */
const AFFINE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
uniform vec2 uSrcPos;
uniform vec2 uOut;
uniform mat3 uInv;
uniform int uTaps;
uniform vec4 uFill;
out vec4 outColor;
vec4 texel(ivec2 q) {
  vec4 c = (q.x < 0 || q.y < 0 || q.x >= uSrcSize.x || q.y >= uSrcSize.y) ? uFill : texelFetch(uSrc, q, 0);
  return vec4(c.rgb * c.a, c.a);
}
vec4 sampleAt(vec2 at) {
  vec2 f = at - 0.5;
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  return mix(mix(texel(i), texel(i + ivec2(1, 0)), t.x), mix(texel(i + ivec2(0, 1)), texel(i + ivec2(1, 1)), t.x), t.y);
}
void main() {
  vec4 acc = vec4(0.0);
  for (int j = 0; j < uTaps; j++)
    for (int i = 0; i < uTaps; i++) {
      vec2 d = uOut + gl_FragCoord.xy - 0.5 + (vec2(i, j) + 0.5) / float(uTaps);
      acc += sampleAt((uInv * vec3(d, 1.0)).xy - uSrcPos);
    }
  acc /= float(uTaps * uTaps);
  outColor = acc.a > 1e-6 ? vec4(acc.rgb / acc.a, acc.a) : vec4(0.0);
}`;

export type Transform = "rotateRight" | "rotate180" | "rotateLeft" | "flipH" | "flipV";
const XFORM_OP: Record<Transform | "copy", number> = { copy: 0, rotateRight: 1, rotate180: 2, rotateLeft: 3, flipH: 4, flipV: 5 };

export const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
};
export const union = (a: Rect | null, b: Rect): Rect => {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Layers by group: each group's layers (and the top level's, under null) bottom first. */
export function layerTree(layers: Layer[]): Map<number | null, Layer[]> {
  const ids = new Set(layers.map((l) => l.id));
  const tree = new Map<number | null, Layer[]>();
  for (const layer of layers) {
    // A layer whose group isn't in this list (a merge's sub-document) counts as top level.
    const key = layer.parent !== null && ids.has(layer.parent) ? layer.parent : null;
    let list = tree.get(key);
    if (!list) tree.set(key, (list = []));
    list.push(layer);
  }
  return tree;
}

/**
 * Live work on one layer (a stroke, a gradient, dragging it): the layers below are composited
 * once into `below`, and each frame redoes only the layers from this one up, inside the changed
 * area. Every pass reads only the pixel it writes, which is what makes that exact. Layers inside
 * a group have no `below`: each frame recomposites the changed area from the bottom.
 */
interface Live {
  index: number;
  below: Target | null;
  region: Rect | null;
}

export class Engine {
  readonly gl: WebGL2RenderingContext;
  readonly gpu: GpuInfo;
  /** The compositing buffers' format: 16-bit float when the GPU allows. */
  readonly accum: TexFormat;
  private composite: Program;
  private viewProgram: Program;
  private dab: Program;
  private xform: Program;
  private resample: Program;
  private affine: Program;
  readonly quad: WebGLVertexArrayObject;
  private dabVao: WebGLVertexArrayObject;
  private dabBuffer: WebGLBuffer;
  private linear: WebGLSampler;
  private scratchFbo: WebGLFramebuffer;
  private ping: Target | null = null;
  private pong: Target | null = null;
  private result: Target | null = null;
  /** Buffers for groups, by nesting depth (1 and deeper), made when first needed. */
  private groupBuffers: [Target, Target][] = [];
  private docW = 0;
  private docH = 0;
  private dirty = true;
  private live: Live | null = null;
  private paint: Paint | null = null;
  private paintTarget: Target | null = null;
  /** The part of the surface being painted that the stroke touched, in surface pixels. */
  private paintRect: Rect | null = null;
  private hardness = 1;
  private empty: WebGLTexture;
  private selection: WebGLTexture | null = null;
  private luts = new Map<number, { key: string; tex: WebGLTexture }>();
  /** Free Transform's preview: the layer drawn through `inv` (document → source document). */
  private preview: { layerId: number; inv: Affine } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("This computer's graphics can't run Photo (no WebGL2).");
    this.gl = gl;
    this.gpu = probeGpu();
    // The probe ran on its own context; extensions are per context.
    const float = !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
    this.accum = float && this.gpu.halfFloatTargets ? "rgba16f" : "rgba8";
    this.composite = makeProgram(gl, QUAD_VERTEX, COMPOSITE(), "Compositing");
    this.viewProgram = makeProgram(gl, QUAD_VERTEX, VIEW, "View");
    this.dab = makeProgram(gl, DAB_VERTEX, DAB_FRAGMENT, "Brush");
    this.xform = makeProgram(gl, QUAD_VERTEX, XFORM, "Transform");
    this.resample = makeProgram(gl, QUAD_VERTEX, RESAMPLE, "Resample");
    this.affine = makeProgram(gl, QUAD_VERTEX, AFFINE, "Free Transform");
    this.quad = makeQuad(gl);
    this.dabVao = gl.createVertexArray()!;
    this.dabBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
    gl.bindVertexArray(null);
    this.linear = gl.createSampler()!;
    gl.samplerParameteri(this.linear, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.linear, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.linear, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.linear, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.scratchFbo = gl.createFramebuffer()!;
    this.empty = makeTexture(gl, 1, 1, "rgba8", new Uint8Array(4));
  }

  get lost() {
    return this.gl.isContextLost();
  }

  /** Bytes the compositing buffers hold (for the memory budget). */
  get bufferBytes() {
    const per = this.docW * this.docH * bytesPerPixel(this.accum);
    return per * (3 + this.groupBuffers.length * 2) + (this.live?.below ? per : 0) + (this.paintTarget ? this.paintTarget.width * this.paintTarget.height * 4 : 0) + (this.selection ? this.docW * this.docH : 0);
  }

  /** Bytes a document of this size needs for compositing. */
  bufferBytesFor(width: number, height: number) {
    return width * height * bytesPerPixel(this.accum) * 4;
  }

  setDocSize(width: number, height: number) {
    if (width === this.docW && height === this.docH && this.result) return;
    const gl = this.gl;
    for (const t of [this.ping, this.pong, this.result]) dropTarget(gl, t);
    this.dropGroupBuffers();
    this.ping = this.pong = this.result = null;
    this.docW = width;
    this.docH = height;
    this.ping = makeTarget(gl, width, height, this.accum);
    this.pong = makeTarget(gl, width, height, this.accum);
    this.result = makeTarget(gl, width, height, this.accum, gl.LINEAR);
    this.setSelection(null);
    this.dirty = true;
  }

  private dropGroupBuffers() {
    for (const [a, b] of this.groupBuffers) {
      dropTarget(this.gl, a);
      dropTarget(this.gl, b);
    }
    this.groupBuffers = [];
  }

  /** Everything needs compositing again. */
  invalidate() {
    this.dirty = true;
  }

  // ---- textures

  /** A layer's texture: transparent, a colour, or 8-bit RGBA rows. */
  layerTexture(width: number, height: number, fill?: Uint8Array | [number, number, number, number] | null): WebGLTexture {
    const gl = this.gl;
    if (fill && !(fill instanceof Uint8Array)) {
      const tex = makeTexture(gl, width, height);
      this.clearTexture(tex, fill);
      return tex;
    }
    const tex = makeTexture(gl, width, height, "rgba8", fill ?? null);
    if (!fill) this.clearTexture(tex, [0, 0, 0, 0]);
    return tex;
  }

  private clearTexture(tex: WebGLTexture, color: [number, number, number, number]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(color[0], color[1], color[2], color[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  deleteTexture(tex: WebGLTexture) {
    this.gl.deleteTexture(tex);
  }

  /** A rectangle of a texture's pixels (8-bit RGBA, top row first). */
  readTexture(tex: WebGLTexture, rect: Rect): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(rect.w * rect.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    readInto(gl, rect.x, rect.y, rect.w, rect.h, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  writeTexture(tex: WebGLTexture, rect: Rect, data: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, rect.w, rect.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.dirty = true;
  }

  /** Swaps a rectangle of a texture with `data` (history steps undo and redo this way). */
  swapTexture(tex: WebGLTexture, rect: Rect, data: Uint8Array): Uint8Array {
    const current = this.readTexture(tex, rect);
    this.writeTexture(tex, rect, data);
    return current;
  }

  /** A turned or flipped copy of a texture (the size swaps for quarter turns). */
  transformTexture(tex: WebGLTexture, width: number, height: number, op: Transform | "copy"): WebGLTexture {
    const gl = this.gl;
    const quarter = op === "rotateLeft" || op === "rotateRight";
    const [w, h] = quarter ? [height, width] : [width, height];
    const out = makeTexture(gl, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.useProgram(this.xform.program);
    gl.bindVertexArray(this.quad);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.xform.u("uSrc"), 0);
    gl.uniform1i(this.xform.u("uOp"), XFORM_OP[op]);
    gl.uniform2i(this.xform.u("uSrcSize"), width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.dirty = true;
    return out;
  }

  /**
   * A source surface drawn through an affine map (source document → document), into a new
   * texture covering `out` (document pixels). `fill` is what lies outside the source.
   */
  affineTexture(src: Surface, map: Affine, out: Rect, fill: [number, number, number, number] = [0, 0, 0, 0]): WebGLTexture {
    const gl = this.gl;
    const tex = makeTexture(gl, out.w, out.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.useProgram(this.affine.program);
    gl.bindVertexArray(this.quad);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, out.w, out.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    const u = (n: string) => this.affine.u(n);
    const inv = invertAffine(map);
    gl.uniform1i(u("uSrc"), 0);
    gl.uniform2i(u("uSrcSize"), src.width, src.height);
    gl.uniform2f(u("uSrcPos"), src.x, src.y);
    gl.uniform2f(u("uOut"), out.x, out.y);
    gl.uniformMatrix3fv(u("uInv"), false, [inv[0], inv[1], 0, inv[2], inv[3], 0, inv[4], inv[5], 1]);
    // Shrinking takes more samples per pixel so detail averages instead of aliasing.
    const scale = Math.sqrt(Math.abs(map[0] * map[3] - map[1] * map[2]));
    gl.uniform1i(u("uTaps"), scale < 0.5 ? Math.min(4, Math.ceil(1 / scale)) : 1);
    gl.uniform4fv(u("uFill"), fill);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.dirty = true;
    return tex;
  }

  /**
   * `rect` of a texture scaled to `w`×`h` (box-filtered when shrinking), as a new texture, or read
   * back as RGBA with `read`.
   */
  scaleTexture(tex: WebGLTexture, srcW: number, srcH: number, rect: Rect, w: number, h: number, o: { premultiplied?: boolean; format?: TexFormat; onWhite?: boolean } = {}): Target {
    const gl = this.gl;
    const target = makeTarget(gl, w, h, o.format ?? "rgba8");
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.useProgram(this.resample.program);
    gl.bindVertexArray(this.quad);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindSampler(0, this.linear);
    const u = (n: string) => this.resample.u(n);
    gl.uniform1i(u("uSrc"), 0);
    gl.uniform2f(u("uSrcSize"), srcW, srcH);
    gl.uniform4f(u("uSrcRect"), rect.x, rect.y, rect.w, rect.h);
    gl.uniform2f(u("uDstSize"), w, h);
    gl.uniform1i(u("uTaps"), Math.max(1, Math.min(8, Math.ceil(Math.max(rect.w / w, rect.h / h) / 2))));
    gl.uniform1i(u("uPremultiplied"), o.premultiplied ? 1 : 0);
    gl.uniform1i(u("uStraightOut"), 1);
    gl.uniform1i(u("uOnWhite"), o.onWhite ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindSampler(0, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return target;
  }

  /** Keeps a target's texture and frees its framebuffer. */
  releaseTarget(target: Target) {
    this.gl.deleteFramebuffer(target.fbo);
  }

  /** A small picture of a texture, `w`×`h`, as RGBA. */
  thumbnail(tex: WebGLTexture, srcW: number, srcH: number, w: number, h: number, premultiplied = false, onWhite = false): Uint8Array {
    const target = this.scaleTexture(tex, srcW, srcH, { x: 0, y: 0, w: srcW, h: srcH }, w, h, { premultiplied, onWhite });
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    readInto(gl, 0, 0, w, h, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dropTarget(gl, target);
    return out;
  }

  /** The composite scaled to `w`×`h`, straight RGBA (or flattened onto white). */
  compositeThumbnail(doc: Doc, w: number, h: number, onWhite = false): Uint8Array {
    this.ensureComposite(doc);
    return this.thumbnail(this.result!.tex, this.docW, this.docH, w, h, true, onWhite);
  }

  /** `doc`'s visible layers merged into one straight-alpha texture of the document's size. */
  mergeLayers(doc: Doc): WebGLTexture {
    const gl = this.gl;
    const accum = makeTarget(gl, this.docW, this.docH, this.accum);
    try {
      this.compositeAll(doc, doc.layers.length, accum);
      const out = this.scaleTexture(accum.tex, this.docW, this.docH, { x: 0, y: 0, w: this.docW, h: this.docH }, this.docW, this.docH, { premultiplied: true });
      this.releaseTarget(out);
      return out.tex;
    } finally {
      dropTarget(gl, accum);
    }
  }

  // ---- selection

  /** The selection the painting tools keep inside (a document-sized mask, 0–255), or none. */
  setSelection(data: Uint8Array | null) {
    const gl = this.gl;
    if (this.selection) gl.deleteTexture(this.selection);
    this.selection = null;
    if (!data || data.length !== this.docW * this.docH) return;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, this.docW, this.docH);
    unpackRaw(gl);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.docW, this.docH, gl.RED, gl.UNSIGNED_BYTE, data);
    this.selection = tex;
  }

  /** The selection's texture (R8), for filters that mix by it. */
  get selectionTexture(): WebGLTexture | null {
    return this.selection;
  }

  // ---- compositing

  private ensureComposite(doc: Doc) {
    if (this.dirty) {
      this.compositeAll(doc);
      this.dirty = false;
      if (this.live) this.live.region = null;
    } else if (this.live?.region) {
      const area = intersect(this.live.region, { x: 0, y: 0, w: this.docW, h: this.docH });
      if (area) {
        if (this.live.below) this.compositeFrom(doc, this.live.index, this.live.below, area);
        else this.compositeAll(doc, doc.layers.length, this.result!, area);
      }
      this.live.region = null;
    }
  }

  private pair(depth: number): [Target, Target] {
    if (depth === 0) return [this.ping!, this.pong!];
    while (this.groupBuffers.length < depth) {
      this.groupBuffers.push([makeTarget(this.gl, this.docW, this.docH, this.accum), makeTarget(this.gl, this.docW, this.docH, this.accum)]);
    }
    return this.groupBuffers[depth - 1];
  }

  private scissor(region: Rect | null) {
    const gl = this.gl;
    if (region) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(region.x, region.y, region.w, region.h);
    } else gl.disable(gl.SCISSOR_TEST);
  }

  private clearTarget(target: Target, region: Rect | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    this.scissor(region);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private copyTarget(from: Target, to: Target, region: Rect | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fbo);
    this.scissor(region);
    gl.blitFramebuffer(0, 0, this.docW, this.docH, 0, 0, this.docW, this.docH, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /**
   * Top-level layers below array index `until`, bottom up, into `into` (only inside `region`
   * when given; the rest of `into` is left as it was).
   */
  private compositeAll(doc: Doc, until = doc.layers.length, into: Target = this.result!, region: Rect | null = null) {
    const tree = layerTree(doc.layers);
    const roots = (tree.get(null) ?? []).filter((l) => doc.layers.indexOf(l) < until);
    this.clearTarget(this.ping!, region);
    const out = this.compositeList(doc, tree, roots, 0, this.ping!, region);
    if (out !== into) this.copyTarget(out, into, region);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  /** The top-level layers from array index `index` up, over `below`, inside `region` only. */
  private compositeFrom(doc: Doc, index: number, below: Target, region: Rect) {
    const tree = layerTree(doc.layers);
    const roots = (tree.get(null) ?? []).filter((l) => doc.layers.indexOf(l) >= index);
    const out = this.compositeList(doc, tree, roots, 0, below, region);
    this.copyTarget(out, this.result!, region);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  /** `list` (one group's layers, bottom first) over `start`; returns the buffer holding the result. */
  private compositeList(doc: Doc, tree: Map<number | null, Layer[]>, list: Layer[], depth: number, start: Target, region: Rect | null): Target {
    let cur = start;
    const other = (t: Target) => {
      const [a, b] = this.pair(depth);
      return t === a ? b : a;
    };
    list.forEach((layer, k) => {
      if (!layer.visible) return;
      // A clipped layer shows only inside the nearest unclipped layer below it.
      let base: Layer | null = null;
      if (layer.clip) {
        for (let j = k - 1; j >= 0; j--) {
          if (!list[j].clip) {
            base = list[j];
            break;
          }
        }
        if (base && !base.visible) return;
        if (base && base.kind !== "pixel") base = null;
      }
      if (layer.kind === "group") {
        const kids = tree.get(layer.id) ?? [];
        const maskOn = !!layer.mask?.enabled;
        if (layer.passThrough && layer.opacity >= 1 && !maskOn && !base) {
          cur = this.compositeList(doc, tree, kids, depth, cur, region);
          return;
        }
        const [ga] = this.pair(depth + 1);
        if (layer.passThrough) this.copyTarget(cur, ga, region);
        else this.clearTarget(ga, region);
        const inner = this.compositeList(doc, tree, kids, depth + 1, ga, region);
        const next = other(cur);
        this.pass(doc, layer, cur.tex, next, region, base as PixelLayer | null, inner.tex);
        cur = next;
        return;
      }
      const next = other(cur);
      this.pass(doc, layer, cur.tex, next, region, base as PixelLayer | null, null);
      cur = next;
    });
    return cur;
  }

  /** Every sampler gets a harmless texture, so none is left on a texture being drawn into. */
  private bindDefaults() {
    const gl = this.gl;
    for (let unit = 0; unit <= UNIT.sel; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
    }
  }

  private bindUnit(unit: number, name: string, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.composite.u(name), unit);
  }

  private pass(doc: Doc, layer: Layer, back: WebGLTexture, dst: Target, region: Rect | null, clipBase: PixelLayer | null, groupTex: WebGLTexture | null) {
    const gl = this.gl;
    const u = (n: string) => this.composite.u(n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    this.scissor(region);
    gl.disable(gl.BLEND);
    gl.useProgram(this.composite.program);
    gl.bindVertexArray(this.quad);
    this.bindDefaults();
    this.bindUnit(UNIT.back, "uBack", back);
    gl.uniform1i(u("uBake"), 0);
    gl.uniform2f(u("uDocSize"), doc.width, doc.height);
    gl.uniform1i(u("uMode"), BLEND_INDEX.get(layer.blend) ?? 0);
    gl.uniform1f(u("uOpacity"), layer.opacity);
    gl.uniform1i(u("uXform"), 0);
    gl.uniform1i(u("uPaintMode"), 0);
    gl.uniform1i(u("uPaintOnMask"), 0);
    this.bindUnit(UNIT.paint, "uPaint", this.empty);
    this.bindUnit(UNIT.lut, "uLut", this.empty);
    this.bindSelection();
    // The mask, with paint going onto it.
    const mask = layer.mask?.enabled ? layer.mask : null;
    gl.uniform1i(u("uHasMask"), mask ? 1 : 0);
    this.bindUnit(UNIT.mask, "uMask", mask ? mask.tex : this.empty);
    if (mask) {
      gl.uniform2i(u("uMaskPos"), mask.x, mask.y);
      gl.uniform2i(u("uMaskSize"), mask.width, mask.height);
      gl.uniform1f(u("uMaskFill"), mask.fill);
    }
    // The clipping base: its pixels' coverage, mask and opacity.
    gl.uniform1i(u("uClip"), clipBase ? 1 : 0);
    this.bindUnit(UNIT.clipLayer, "uClipLayer", clipBase ? clipBase.tex : this.empty);
    const baseMask = clipBase?.mask?.enabled ? clipBase.mask : null;
    this.bindUnit(UNIT.clipMask, "uClipMask", baseMask ? baseMask.tex : this.empty);
    gl.uniform1i(u("uClipHasMask"), baseMask ? 1 : 0);
    if (clipBase) {
      gl.uniform2i(u("uClipPos"), clipBase.x, clipBase.y);
      gl.uniform2i(u("uClipSize"), clipBase.width, clipBase.height);
      gl.uniform1f(u("uClipOpacity"), clipBase.opacity);
    }
    if (baseMask) {
      gl.uniform2i(u("uClipMaskPos"), baseMask.x, baseMask.y);
      gl.uniform2i(u("uClipMaskSize"), baseMask.width, baseMask.height);
      gl.uniform1f(u("uClipMaskFill"), baseMask.fill);
    }
    if (layer.kind === "adjust") {
      gl.uniform1i(u("uKind"), 1);
      const spec = layer.spec.type !== "basic";
      gl.uniform1i(u("uSpec"), spec ? 1 : 0);
      if (spec) {
        this.bindUnit(UNIT.lut, "uLut", this.lutTexture(layer));
        setSpecUniforms(gl, u, layer.spec, UNIT.lut, LUT_SIZE);
      } else setAdjustUniforms(gl, u, layer.adjust, doc.width / doc.height);
    } else if (layer.kind === "group") {
      gl.uniform1i(u("uKind"), layer.passThrough ? 3 : 2);
      this.bindUnit(UNIT.layer, "uLayer", groupTex ?? this.empty);
    } else {
      gl.uniform1i(u("uKind"), 0);
      this.bindUnit(UNIT.layer, "uLayer", layer.tex);
      gl.uniform2i(u("uLayerPos"), layer.x, layer.y);
      gl.uniform2i(u("uLayerSize"), layer.width, layer.height);
      if (this.preview?.layerId === layer.id) {
        const inv = this.preview.inv;
        gl.uniform1i(u("uXform"), 1);
        gl.uniformMatrix3fv(u("uXformInv"), false, [inv[0], inv[1], 0, inv[2], inv[3], 0, inv[4], inv[5], 1]);
      }
    }
    if (this.paint && this.paint.layer === layer && this.preview?.layerId !== layer.id && (this.paint.mask ? !!mask : layer.kind === "pixel")) this.bindPaint(this.paint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindSelection() {
    const gl = this.gl;
    gl.uniform1i(this.composite.u("uHasSel"), this.selection ? 1 : 0);
    this.bindUnit(UNIT.sel, "uSel", this.selection ?? this.empty);
  }

  /** The paint going onto its layer or mask, for the composite program in use. */
  private bindPaint(paint: Paint) {
    const gl = this.gl;
    const u = (n: string) => this.composite.u(n);
    const surface = this.surfaceOf(paint);
    gl.uniform1i(u("uPaintOnMask"), paint.mask ? 1 : 0);
    gl.uniform2i(u("uPaintOrigin"), surface.x, surface.y);
    this.bindUnit(UNIT.paint, "uPaint", paint.kind !== "gradient" && this.paintTarget ? this.paintTarget.tex : this.empty);
    gl.uniform1f(u("uPaintOpacity"), paint.opacity);
    if (paint.kind === "brush") {
      gl.uniform1i(u("uPaintMode"), 1);
      gl.uniform3fv(u("uPaintColor"), paint.color);
    } else if (paint.kind === "erase") {
      gl.uniform1i(u("uPaintMode"), 2);
    } else if (paint.kind === "clone") {
      gl.uniform1i(u("uPaintMode"), 4);
      gl.uniform2i(u("uCloneOffset"), Math.round(paint.offset[0]), Math.round(paint.offset[1]));
    } else {
      gl.uniform1i(u("uPaintMode"), 3);
      gl.uniform2f(u("uGradFrom"), paint.from[0], paint.from[1]);
      gl.uniform2f(u("uGradTo"), paint.to[0], paint.to[1]);
      gl.uniform4fv(u("uGradA"), paint.a);
      gl.uniform4fv(u("uGradB"), paint.b);
      gl.uniform1i(u("uGradRadial"), paint.radial ? 1 : 0);
    }
  }

  private surfaceOf(paint: Paint): Surface {
    if (paint.mask && paint.layer.mask) return paint.layer.mask;
    if (paint.layer.kind !== "pixel") throw new Error("Only pixel layers and masks can be painted on.");
    return paint.layer;
  }

  /** An adjustment layer's lookup table, made again when its settings change. */
  private lutTexture(layer: AdjustLayer): WebGLTexture {
    const gl = this.gl;
    const key = JSON.stringify(layer.spec);
    const cached = this.luts.get(layer.id);
    if (cached?.key === key) return cached.tex;
    const data = lutFor(layer.spec);
    if (!data) return this.empty;
    if (cached) gl.deleteTexture(cached.tex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, LUT_SIZE, 1);
    unpackRaw(gl);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1, gl.RGBA, gl.FLOAT, data);
    this.luts.set(layer.id, { key, tex });
    return tex;
  }

  /** Frees lookup tables of layers that are gone (they're made again if one comes back). */
  pruneLuts(doc: Doc) {
    const ids = new Set(doc.layers.map((l) => l.id));
    for (const [id, entry] of this.luts) {
      if (ids.has(id)) continue;
      this.gl.deleteTexture(entry.tex);
      this.luts.delete(id);
    }
  }

  /** Starts live work on the layer at `index`: the layers below it are composited once. */
  beginLive(doc: Doc, index: number) {
    this.endLive();
    this.ensureComposite(doc);
    const layer = doc.layers[index];
    let below: Target | null = null;
    if (layer && layer.parent === null) {
      below = makeTarget(this.gl, this.docW, this.docH, this.accum);
      this.compositeAll(doc, index, below);
    }
    this.live = { index, below, region: null };
  }

  /** Part of the document changed during live work (or all of it, without a region). */
  touch(region?: Rect) {
    if (!this.live || !region) {
      this.dirty = true;
      return;
    }
    this.live.region = union(this.live.region, region);
  }

  endLive() {
    if (!this.live) return;
    dropTarget(this.gl, this.live.below);
    this.live = null;
  }

  // ---- Free Transform

  /** Shows a layer drawn through `map` (source → document), or stops showing it. */
  setPreview(layer: PixelLayer | null, map: Affine | null) {
    this.preview = layer && map ? { layerId: layer.id, inv: invertAffine(map) } : null;
    this.dirty = true;
  }

  // ---- painting

  /** Starts painting onto a layer or its mask (brush, eraser, gradient, clone), shown live. */
  beginPaint(doc: Doc, paint: Paint, hardness = 1) {
    const index = doc.layers.indexOf(paint.layer);
    this.beginLive(doc, index);
    this.paint = paint;
    this.hardness = hardness;
    this.paintRect = null;
    const surface = this.surfaceOf(paint);
    if (paint.kind !== "gradient") {
      const gl = this.gl;
      const { width, height } = surface;
      if (!this.paintTarget || this.paintTarget.width !== width || this.paintTarget.height !== height) {
        dropTarget(gl, this.paintTarget);
        this.paintTarget = makeTarget(gl, width, height);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.paintTarget.fbo);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      this.paintRect = { x: 0, y: 0, w: surface.width, h: surface.height };
      this.touch(this.surfaceRect(surface));
    }
  }

  /** Moves the gradient (surface pixels). */
  updateGradient(from: [number, number], to: [number, number]) {
    const paint = this.paint;
    if (paint?.kind !== "gradient") return;
    paint.from = from;
    paint.to = to;
    this.touch(this.surfaceRect(this.surfaceOf(paint)));
  }

  /** Stamps dabs into the stroke buffer. */
  addDabs(dabs: Dab[]) {
    const paint = this.paint;
    if (!paint || paint.kind === "gradient" || !this.paintTarget || !dabs.length) return;
    const gl = this.gl;
    const surface = this.surfaceOf(paint);
    const data = new Float32Array(dabs.length * 36);
    let at = 0;
    let rect: Rect | null = null;
    for (const d of dabs) {
      const e = d.r + 1;
      for (const [cx, cy] of [[-e, -e], [e, -e], [-e, e], [-e, e], [e, -e], [e, e]]) {
        data[at++] = d.x + cx;
        data[at++] = d.y + cy;
        data[at++] = cx;
        data[at++] = cy;
        data[at++] = d.r;
        data[at++] = d.alpha;
      }
      rect = union(rect, { x: Math.floor(d.x - e), y: Math.floor(d.y - e), w: Math.ceil(2 * e) + 2, h: Math.ceil(2 * e) + 2 });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.paintTarget.fbo);
    gl.viewport(0, 0, this.paintTarget.width, this.paintTarget.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.dab.program);
    gl.uniform2f(this.dab.u("uSize"), this.paintTarget.width, this.paintTarget.height);
    gl.uniform1f(this.dab.u("uHardness"), this.hardness);
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, dabs.length * 6);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const inSurface = intersect(rect!, { x: 0, y: 0, w: surface.width, h: surface.height });
    if (!inSurface) return;
    this.paintRect = union(this.paintRect, inSurface);
    // A mask's paint shows wherever the layer does; a layer's where the stroke is.
    this.touch({ x: inSurface.x + surface.x, y: inSurface.y + surface.y, w: inSurface.w, h: inSurface.h });
  }

  /** The stroke so far: its rectangle (surface pixels) and coverage there (0–255 per pixel). */
  strokeCoverage(): { rect: Rect; alpha: Uint8Array } | null {
    if (!this.paintTarget || !this.paintRect) return null;
    const rect = this.paintRect;
    const rgba = this.readTexture(this.paintTarget.tex, rect);
    const alpha = new Uint8Array(rect.w * rect.h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    return { rect: { ...rect }, alpha };
  }

  /**
   * Ends painting: bakes it into the surface (or drops it). Returns the changed rectangle
   * (surface pixels) and its pixels from before, for the history.
   */
  endPaint(keep: boolean): { rect: Rect; before: Uint8Array } | null {
    const paint = this.paint;
    const rect = this.paintRect;
    let out: { rect: Rect; before: Uint8Array } | null = null;
    if (paint && keep && rect) {
      const gl = this.gl;
      const surface = this.surfaceOf(paint);
      const before = this.readTexture(surface.tex, rect);
      const scratch = makeTarget(gl, rect.w, rect.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fbo);
      gl.viewport(0, 0, rect.w, rect.h);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(this.composite.program);
      gl.bindVertexArray(this.quad);
      const u = (n: string) => this.composite.u(n);
      this.bindDefaults();
      gl.uniform1i(u("uBake"), 1);
      gl.uniform2i(u("uBakeOffset"), rect.x, rect.y);
      gl.uniform2f(u("uDocSize"), this.docW, this.docH);
      this.bindUnit(UNIT.layer, "uLayer", surface.tex);
      gl.uniform2i(u("uLayerSize"), surface.width, surface.height);
      this.bindSelection();
      this.bindPaint(paint);
      // Baking treats the surface as the layer, whichever it is.
      gl.uniform1i(u("uPaintOnMask"), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // Copy the baked rectangle into the surface.
      gl.activeTexture(gl.TEXTURE0 + UNIT.layer);
      gl.bindTexture(gl.TEXTURE_2D, surface.tex);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, 0, 0, rect.w, rect.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      dropTarget(gl, scratch);
      out = { rect, before };
    }
    this.paint = null;
    this.paintRect = null;
    this.endLive();
    this.dirty = true;
    return out;
  }

  private surfaceRect(s: Surface): Rect {
    return { x: s.x, y: s.y, w: s.width, h: s.height };
  }

  /** Frees the stroke buffer (it's kept between strokes on the same layer). */
  releasePaintBuffer() {
    dropTarget(this.gl, this.paintTarget);
    this.paintTarget = null;
  }

  // ---- output

  /** Draws the document onto the canvas. */
  render(doc: Doc, view: View, background: [number, number, number]) {
    const gl = this.gl;
    if (!this.result) return;
    this.ensureComposite(doc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.viewProgram.program);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.result.tex);
    const u = (n: string) => this.viewProgram.u(n);
    gl.uniform1i(u("uImage"), 0);
    gl.uniform2f(u("uDoc"), this.docW, this.docH);
    gl.uniform2f(u("uCanvas"), this.canvas.width, this.canvas.height);
    gl.uniform2f(u("uOffset"), view.x, view.y);
    gl.uniform1f(u("uScale"), view.scale);
    gl.uniform3fv(u("uBg"), background);
    gl.uniform1i(u("uTaps"), view.scale >= 0.5 ? 1 : Math.min(6, Math.ceil(1 / view.scale / 2)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** The composite colour at a document pixel (straight RGBA, 0–255). */
  pick(doc: Doc, x: number, y: number): [number, number, number, number] {
    const gl = this.gl;
    this.ensureComposite(doc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.result!.fbo);
    let c: number[];
    if (this.accum === "rgba16f") {
      const f = new Float32Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, f);
      c = [...f];
    } else {
      const b = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
      c = [...b].map((v) => v / 255);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const a = c[3];
    const straight = (v: number) => Math.round(Math.min(1, a > 0 ? v / a : 0) * 255);
    return [straight(c[0]), straight(c[1]), straight(c[2]), Math.round(a * 255)];
  }

  /** The whole document flattened, straight 8-bit RGBA (or onto white), in tiles. */
  flatten(doc: Doc, onWhite = false): Uint8Array {
    const gl = this.gl;
    this.ensureComposite(doc);
    const W = this.docW, H = this.docH;
    const out = new Uint8Array(W * H * 4);
    const tile = 2048;
    for (let y = 0; y < H; y += tile) {
      for (let x = 0; x < W; x += tile) {
        const w = Math.min(tile, W - x), h = Math.min(tile, H - y);
        // 1:1, so the box filter takes one tap: only unpremultiplying and 8-bit conversion.
        const target = this.scaleTexture(this.result!.tex, W, H, { x, y, w, h }, w, h, { premultiplied: true, onWhite });
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        readInto(gl, 0, 0, w, h, out, W, y * W + x);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        dropTarget(gl, target);
      }
    }
    return out;
  }

  dispose() {
    const gl = this.gl;
    this.endLive();
    for (const t of [this.ping, this.pong, this.result, this.paintTarget]) dropTarget(gl, t);
    this.dropGroupBuffers();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
