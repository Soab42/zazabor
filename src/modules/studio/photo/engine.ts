import { ADJUST_GLSL, setAdjustUniforms, type Adjustments } from "./adjust";
import { bytesPerPixel, dropTarget, makeProgram, makeQuad, makeTarget, makeTexture, probeGpu, QUAD_VERTEX, readInto, type GpuInfo, type Program, type Target, type TexFormat } from "./gl";

/**
 * Photo's GPU side: layers composited with blend modes into a 16-bit float buffer (8-bit when the
 * GPU can't render into floats), painting into a stroke buffer, and the view of the result.
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

interface LayerBase {
  id: number;
  name: string;
  visible: boolean;
  /** 0–1. */
  opacity: number;
  blend: BlendMode;
}

/** Pixels: straight-alpha RGBA, placed at (x, y) in the document. */
export interface PixelLayer extends LayerBase {
  kind: "pixel";
  x: number;
  y: number;
  width: number;
  height: number;
  tex: WebGLTexture;
}

/** Light and colour settings applied to everything below. */
export interface AdjustLayer extends LayerBase {
  kind: "adjust";
  adjust: Adjustments;
}

export type Layer = PixelLayer | AdjustLayer;

export interface Doc {
  width: number;
  height: number;
  /** Bottom first. */
  layers: Layer[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What's being painted onto a layer right now, shown live and baked in when it ends. */
export type Paint =
  | { kind: "brush"; layer: PixelLayer; color: [number, number, number]; opacity: number }
  | { kind: "erase"; layer: PixelLayer; opacity: number }
  | { kind: "gradient"; layer: PixelLayer; from: [number, number]; to: [number, number]; a: [number, number, number, number]; b: [number, number, number, number]; radial: boolean; opacity: number };

/** One brush dab: its centre in layer pixels, radius and strength (flow × pressure). */
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

const COMPOSITE = () => `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBack;
uniform sampler2D uLayer;
uniform sampler2D uPaint;
uniform int uKind;
uniform int uMode;
uniform float uOpacity;
uniform ivec2 uLayerPos;
uniform ivec2 uLayerSize;
uniform vec2 uDocSize;
uniform int uPaintMode;
uniform vec3 uPaintColor;
uniform float uPaintOpacity;
uniform vec2 uGradFrom;
uniform vec2 uGradTo;
uniform vec4 uGradA;
uniform vec4 uGradB;
uniform bool uGradRadial;
uniform bool uBake;
uniform ivec2 uBakeOffset;
out vec4 outColor;
${ADJUST_GLSL}
${blendGlsl()}

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

vec4 painted(vec4 c, ivec2 q) {
  if (uPaintMode == 1) {
    float a = texelFetch(uPaint, q, 0).a * uPaintOpacity;
    return over(c, vec4(uPaintColor * a, a));
  }
  if (uPaintMode == 2) return vec4(c.rgb, c.a * (1.0 - texelFetch(uPaint, q, 0).a * uPaintOpacity));
  if (uPaintMode == 3) {
    vec2 p = vec2(q) + 0.5;
    vec2 d = uGradTo - uGradFrom;
    float t = uGradRadial ? length(p - uGradFrom) / max(length(d), 1e-3) : dot(p - uGradFrom, d) / max(dot(d, d), 1e-6);
    t = clamp(t, 0.0, 1.0);
    vec4 g = mix(vec4(uGradA.rgb * uGradA.a, uGradA.a), vec4(uGradB.rgb * uGradB.a, uGradB.a), t) * uPaintOpacity;
    return over(c, g);
  }
  return c;
}

vec4 layerTexel(ivec2 q) {
  if (q.x < 0 || q.y < 0 || q.x >= uLayerSize.x || q.y >= uLayerSize.y) return vec4(0.0);
  return painted(texelFetch(uLayer, q, 0), q);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uBake) {
    outColor = layerTexel(p + uBakeOffset);
    return;
  }
  vec4 back = texelFetch(uBack, p, 0);
  float ab = back.a;
  vec3 cb = ab > 0.0 ? clamp(back.rgb / ab, 0.0, 1.0) : vec3(0.0);
  if (uKind == 1) {
    vec3 cs = adjust(cb, (vec2(p) + 0.5) / uDocSize);
    outColor = vec4(mix(cb, clamp(blend(uMode, cb, cs), 0.0, 1.0), uOpacity) * ab, ab);
    return;
  }
  vec4 s = layerTexel(p - uLayerPos);
  float as = s.a * uOpacity;
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

/**
 * Live work on one layer (a stroke, a gradient, dragging it): the layers below are composited
 * once into `below`, and each frame redoes only the layers from this one up, inside the changed
 * area. Every pass reads only the pixel it writes, which is what makes that exact.
 */
interface Live {
  index: number;
  below: Target;
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
  private quad: WebGLVertexArrayObject;
  private dabVao: WebGLVertexArrayObject;
  private dabBuffer: WebGLBuffer;
  private linear: WebGLSampler;
  private scratchFbo: WebGLFramebuffer;
  private ping: Target | null = null;
  private pong: Target | null = null;
  private result: Target | null = null;
  private docW = 0;
  private docH = 0;
  private dirty = true;
  private live: Live | null = null;
  private paint: Paint | null = null;
  private paintTarget: Target | null = null;
  /** The part of the layer being painted that the stroke touched, in layer pixels. */
  private paintRect: Rect | null = null;
  private hardness = 1;
  private empty: WebGLTexture;

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
    return per * 3 + (this.live ? per : 0) + (this.paintTarget ? this.paintTarget.width * this.paintTarget.height * 4 : 0);
  }

  /** Bytes a document of this size needs for compositing. */
  bufferBytesFor(width: number, height: number) {
    return width * height * bytesPerPixel(this.accum) * 4;
  }

  setDocSize(width: number, height: number) {
    if (width === this.docW && height === this.docH && this.result) return;
    const gl = this.gl;
    for (const t of [this.ping, this.pong, this.result]) dropTarget(gl, t);
    this.ping = this.pong = this.result = null;
    this.docW = width;
    this.docH = height;
    this.ping = makeTarget(gl, width, height, this.accum);
    this.pong = makeTarget(gl, width, height, this.accum);
    this.result = makeTarget(gl, width, height, this.accum, gl.LINEAR);
    this.dirty = true;
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

  /** A rectangle of a layer's pixels (8-bit RGBA, top row first). */
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

  // ---- compositing

  private ensureComposite(doc: Doc) {
    if (this.dirty) {
      this.compositeAll(doc);
      this.dirty = false;
      if (this.live) this.live.region = null;
    } else if (this.live?.region) {
      this.compositeFrom(doc, this.live.index, this.live.below, this.live.region);
      this.live.region = null;
    }
  }

  /** Every visible layer, bottom up, into `result` (or into `into` for the layers below `until`). */
  private compositeAll(doc: Doc, until = doc.layers.length, into: Target = this.result!) {
    const gl = this.gl;
    const layers = doc.layers.slice(0, until).filter((l) => l.visible);
    gl.disable(gl.SCISSOR_TEST);
    if (!layers.length) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ping!.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let src = this.ping!;
    layers.forEach((layer, i) => {
      const dst = i === layers.length - 1 ? into : src === this.ping ? this.pong! : this.ping!;
      this.pass(doc, layer, src.tex, dst, null);
      src = dst;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** The layers from `index` up, over `below`, inside `region` only. */
  private compositeFrom(doc: Doc, index: number, below: Target, region: Rect) {
    const area = intersect(region, { x: 0, y: 0, w: this.docW, h: this.docH });
    if (!area) return;
    const layers = doc.layers.slice(index).filter((l) => l.visible);
    const gl = this.gl;
    if (!layers.length) return;
    let src = below;
    layers.forEach((layer, i) => {
      const dst = i === layers.length - 1 ? this.result! : src === this.ping ? this.pong! : this.ping!;
      this.pass(doc, layer, src.tex, dst, area);
      src = dst;
    });
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private pass(doc: Doc, layer: Layer, back: WebGLTexture, dst: Target, region: Rect | null) {
    const gl = this.gl;
    const u = (n: string) => this.composite.u(n);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    if (region) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(region.x, region.y, region.w, region.h);
    } else gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.composite.program);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, back);
    gl.uniform1i(u("uBack"), 0);
    gl.uniform1i(u("uBake"), 0);
    gl.uniform2f(u("uDocSize"), doc.width, doc.height);
    gl.uniform1i(u("uMode"), BLEND_INDEX.get(layer.blend) ?? 0);
    gl.uniform1f(u("uOpacity"), layer.opacity);
    if (layer.kind === "adjust") {
      gl.uniform1i(u("uKind"), 1);
      gl.uniform1i(u("uPaintMode"), 0);
      setAdjustUniforms(gl, u, layer.adjust, doc.width / doc.height);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
      gl.uniform1i(u("uLayer"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
      gl.uniform1i(u("uPaint"), 2);
    } else {
      gl.uniform1i(u("uKind"), 0);
      this.bindLayer(layer);
      gl.uniform2i(u("uLayerPos"), layer.x, layer.y);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** The layer's pixels, and the paint going onto it, for the composite program in use. */
  private bindLayer(layer: PixelLayer) {
    const gl = this.gl;
    const u = (n: string) => this.composite.u(n);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, layer.tex);
    gl.uniform1i(u("uLayer"), 1);
    gl.uniform2i(u("uLayerSize"), layer.width, layer.height);
    const paint = this.paint && this.paint.layer === layer ? this.paint : null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, paint && paint.kind !== "gradient" && this.paintTarget ? this.paintTarget.tex : this.empty);
    gl.uniform1i(u("uPaint"), 2);
    if (!paint) {
      gl.uniform1i(u("uPaintMode"), 0);
      return;
    }
    gl.uniform1f(u("uPaintOpacity"), paint.opacity);
    if (paint.kind === "brush") {
      gl.uniform1i(u("uPaintMode"), 1);
      gl.uniform3fv(u("uPaintColor"), paint.color);
    } else if (paint.kind === "erase") {
      gl.uniform1i(u("uPaintMode"), 2);
    } else {
      gl.uniform1i(u("uPaintMode"), 3);
      gl.uniform2f(u("uGradFrom"), paint.from[0], paint.from[1]);
      gl.uniform2f(u("uGradTo"), paint.to[0], paint.to[1]);
      gl.uniform4fv(u("uGradA"), paint.a);
      gl.uniform4fv(u("uGradB"), paint.b);
      gl.uniform1i(u("uGradRadial"), paint.radial ? 1 : 0);
    }
  }

  /** Starts live work on the layer at `index`: the layers below it are composited once. */
  beginLive(doc: Doc, index: number) {
    this.endLive();
    this.ensureComposite(doc);
    const below = makeTarget(this.gl, this.docW, this.docH, this.accum);
    this.compositeAll(doc, index, below);
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

  // ---- painting

  /** Starts painting onto a layer (brush, eraser or gradient), shown live. */
  beginPaint(doc: Doc, paint: Paint, hardness = 1) {
    const index = doc.layers.indexOf(paint.layer);
    this.beginLive(doc, index);
    this.paint = paint;
    this.hardness = hardness;
    this.paintRect = null;
    if (paint.kind !== "gradient") {
      const gl = this.gl;
      const { width, height } = paint.layer;
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
      this.paintRect = { x: 0, y: 0, w: paint.layer.width, h: paint.layer.height };
      this.touch(this.layerRect(paint.layer));
    }
  }

  /** Moves the gradient (layer pixels). */
  updateGradient(from: [number, number], to: [number, number]) {
    const paint = this.paint;
    if (paint?.kind !== "gradient") return;
    paint.from = from;
    paint.to = to;
    this.touch(this.layerRect(paint.layer));
  }

  /** Stamps dabs into the stroke buffer. */
  addDabs(dabs: Dab[]) {
    const paint = this.paint;
    if (!paint || paint.kind === "gradient" || !this.paintTarget || !dabs.length) return;
    const gl = this.gl;
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
    const inLayer = intersect(rect!, { x: 0, y: 0, w: paint.layer.width, h: paint.layer.height });
    if (!inLayer) return;
    this.paintRect = union(this.paintRect, inLayer);
    this.touch({ x: inLayer.x + paint.layer.x, y: inLayer.y + paint.layer.y, w: inLayer.w, h: inLayer.h });
  }

  /**
   * Ends painting: bakes it into the layer (or drops it). Returns the changed rectangle (layer
   * pixels) and its pixels from before, for the history.
   */
  endPaint(keep: boolean): { rect: Rect; before: Uint8Array } | null {
    const paint = this.paint;
    const rect = this.paintRect;
    let out: { rect: Rect; before: Uint8Array } | null = null;
    if (paint && keep && rect) {
      const gl = this.gl;
      const before = this.readTexture(paint.layer.tex, rect);
      const scratch = makeTarget(gl, rect.w, rect.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fbo);
      gl.viewport(0, 0, rect.w, rect.h);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(this.composite.program);
      gl.bindVertexArray(this.quad);
      const u = (n: string) => this.composite.u(n);
      gl.uniform1i(u("uBake"), 1);
      gl.uniform2i(u("uBakeOffset"), rect.x, rect.y);
      // Every sampler needs a texture other than the one being drawn into, even unused ones:
      // creating `scratch` bound it to the active unit.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
      gl.uniform1i(u("uBack"), 0);
      this.bindLayer(paint.layer);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // Copy the baked rectangle into the layer.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, paint.layer.tex);
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

  private layerRect(layer: PixelLayer): Rect {
    return { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
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
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

