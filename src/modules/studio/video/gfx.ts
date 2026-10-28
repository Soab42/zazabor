import { FINAL, NEEDS_FRAME_MIPS, VERTEX } from "../../gallery/slideshow/gl";
import type { Grade } from "../../gallery/slideshow/settings";
import type { Frame } from "./api";

/**
 * The compositor (WebGL2). A frame is drawn in three steps, all at the output size:
 * 1. the main track's clip (and during a transition the next one) into targets A and B, each
 *    over the canvas background (a colour, or the clip itself blurred);
 * 2. the slideshow's transition shader (`FINAL` in gallery/slideshow/gl.ts) mixes A and B into C;
 * 3. overlays and texts are blended onto C.
 * C is then shown on the canvas, or packed into I420 for export.
 *
 * Every texture holds its picture top row first; targets are ordinary GL framebuffers (bottom
 * row first), which is what `FINAL` expects.
 */

/** Something to draw: a decoded video frame (three planes) or a picture or text (RGBA). */
export interface Source {
  kind: "yuv" | "rgba";
  width: number;
  height: number;
  textures: WebGLTexture[];
  /** The frame shown (video), to ask for the next one. */
  pts: number;
  /** How long that frame lasts (video). */
  dur?: number;
  /** Mipmaps are made on demand for blurred backgrounds. */
  mips: boolean;
}

/** A 3D colour table on the GPU (see lut.ts). */
export interface Lut3D {
  tex: WebGLTexture;
  size: number;
}

/** Shader ids of the effects drawn in the layer shader (shake, pulse and blur-in move or blur the layer instead). */
export const SHADER_EFFECTS: Record<string, number> = { glitch: 1, rgb: 2, vhs: 3, mirror: 4, flash: 5 };

/** A layer's extras: effects, chroma key, colour table, mask and picture-in-picture frame. */
export interface LayerFx {
  sharpen: number;
  vignette: number;
  grain: number;
  /** SHADER_EFFECTS id, 0 for none. */
  effect: number;
  amount: number;
  /** Seconds into the clip, and the timeline time (animated effects). */
  local: number;
  time: number;
  seed: number;
  /** Key colour (0…1) and tolerance, softness, spill. */
  key: [number, number, number, number, number, number] | null;
  lut: Lut3D | null;
  lutStrength: number;
  /** 1 = ellipse, 2 = rectangle; centre in the picture (0…1), size and feather in its shorter side, inverted. */
  mask: { shape: 1 | 2; rect: [number, number, number, number]; feather: number; invert: boolean } | null;
  /** Rounded corners and border in output pixels; border colour 0…1. */
  radius: number;
  border: number;
  borderColor: [number, number, number];
}

export interface LayerDraw {
  /** A drop shadow instead of a picture: a soft dark rounded box `box` big (half sizes, px). */
  shadow?: { box: [number, number]; radius: number; softness: number };
  fx?: LayerFx;
  source: Source;
  /** Centre and size in output pixels (before rotation), rotation in radians. */
  center: [number, number];
  size: [number, number];
  rotation: number;
  opacity: number;
  grade: Grade | null;
  /** Brightness, contrast, saturation (−1…1). */
  adjust: [number, number, number];
  /** Background mode: blur radius as a mip level, and darkening. */
  blur: number;
  dim: number;
}

const LAYER_VS = `#version 300 es
uniform vec2 uCanvas, uCenter, uSize;
uniform float uRot;
out vec2 vUv;
void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 l = (q - 0.5) * uSize;
  float c = cos(uRot), s = sin(uRot);
  vec2 p = uCenter + vec2(c * l.x - s * l.y, s * l.x + c * l.y);
  vUv = q;
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

const LAYER_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform int uYuv;
uniform sampler2D uY, uU, uV;
uniform sampler3D uLut;
uniform vec2 uTexel, uPx, uBox;
uniform float uLod, uOpacity, uDim, uGraded;
uniform vec3 uLift, uGamma, uGain, uShadowTint, uHighTint;
uniform float uSat, uContrast;
uniform vec3 uAdjust;
uniform int uEffect, uLutOn, uMask, uKeyOn, uSolid;
uniform float uSharpen, uVignette, uGrain, uAmount, uLocal, uTime, uSeed, uLutStrength, uLutSize;
uniform vec3 uKeyColor, uKeyParams, uBorderColor;
uniform vec4 uMaskRect;
uniform float uMaskFeather, uMaskInvert, uRadius, uBorder, uSoft;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 chroma(vec3 c) { float y = dot(c, vec3(0.299, 0.587, 0.114)); return vec2((c.b - y) * 0.565, (c.r - y) * 0.713); }
float roundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
vec4 fetch(vec2 uv) {
  if (uYuv == 1) {
    float y = (textureLod(uY, uv, uLod).r - 0.0627) * 1.164;
    float u = textureLod(uU, uv, uLod).r - 0.5, v = textureLod(uV, uv, uLod).r - 0.5;
    return vec4(clamp(vec3(y + 1.793 * v, y - 0.213 * u - 0.533 * v, y + 2.112 * u), 0.0, 1.0), 1.0);
  }
  vec4 c = textureLod(uY, uv, uLod);
  return vec4(c.a > 0.0 ? c.rgb / c.a : vec3(0.0), c.a);
}
vec4 sampleAt(vec2 uv) {
  if (uLod <= 0.0) return fetch(uv);
  vec2 d = uTexel * exp2(uLod) * 1.5;
  vec4 c = fetch(uv) * 0.2;
  c += (fetch(uv + vec2(d.x, 0.0)) + fetch(uv - vec2(d.x, 0.0)) + fetch(uv + vec2(0.0, d.y)) + fetch(uv - vec2(0.0, d.y))) * 0.125;
  c += (fetch(uv + d) + fetch(uv - d) + fetch(uv + vec2(d.x, -d.y)) + fetch(uv + vec2(-d.x, d.y))) * 0.075;
  return c;
}
vec3 grade(vec3 c) {
  c = clamp(c * uGain + uLift * (1.0 - c), 0.0, 1.0);
  c = pow(c, 1.0 / uGamma);
  c = mix(vec3(luma(c)), c, uSat);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  float l = luma(c);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l)) + uHighTint * smoothstep(0.45, 1.0, l);
  return clamp(c, 0.0, 1.0);
}
vec2 effectUv(vec2 uv) {
  if (uEffect == 4) uv.x = uv.x < 0.5 ? uv.x : 1.0 - uv.x;
  if (uEffect == 1) {
    float t = floor(uTime * 12.0), band = floor(uv.y * 24.0);
    if (hash(vec2(band, t + uSeed)) > 1.0 - 0.25 * uAmount) uv.x += (hash(vec2(t, band)) - 0.5) * 0.12 * uAmount;
  }
  if (uEffect == 3) uv.x += sin(uv.y * 40.0 + uTime * 5.0) * 0.002 * uAmount + (hash(vec2(floor(uv.y * 240.0), floor(uTime * 30.0))) - 0.5) * 0.003 * uAmount;
  return uv;
}
vec4 colorAt(vec2 uv) {
  vec4 s = sampleAt(clamp(uv, 0.0, 1.0));
  if (uEffect == 1 || uEffect == 2 || uEffect == 3) {
    float d = (uEffect == 2 ? 0.012 : uEffect == 1 ? 0.009 : 0.004) * uAmount;
    if (uEffect == 1) d *= step(0.45, hash(vec2(floor(uTime * 12.0), uSeed)));
    s.r = sampleAt(clamp(uv + vec2(d, 0.0), 0.0, 1.0)).r;
    s.b = sampleAt(clamp(uv - vec2(d, 0.0), 0.0, 1.0)).b;
  }
  if (uSharpen > 0.0) {
    vec2 o = uTexel;
    vec3 n = (sampleAt(clamp(uv + vec2(o.x, 0.0), 0.0, 1.0)).rgb + sampleAt(clamp(uv - vec2(o.x, 0.0), 0.0, 1.0)).rgb
      + sampleAt(clamp(uv + vec2(0.0, o.y), 0.0, 1.0)).rgb + sampleAt(clamp(uv - vec2(0.0, o.y), 0.0, 1.0)).rgb) * 0.25;
    s.rgb = clamp(s.rgb + (s.rgb - n) * uSharpen * 2.0, 0.0, 1.0);
  }
  return s;
}
void main() {
  vec2 p = (vUv - 0.5) * uPx;
  if (uSolid == 1) {
    float d = roundBox(p, uBox, uRadius);
    float a = (1.0 - smoothstep(-uSoft, uSoft, d)) * uOpacity;
    outColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  vec4 s = colorAt(effectUv(vUv));
  vec3 c = s.rgb;
  float alpha = s.a;
  if (uKeyOn == 1) {
    float d = distance(chroma(c), chroma(uKeyColor));
    alpha *= smoothstep(uKeyParams.x, uKeyParams.x + uKeyParams.y + 0.001, d);
    c = mix(c, vec3(luma(c)), uKeyParams.z * (1.0 - smoothstep(uKeyParams.x, uKeyParams.x + uKeyParams.y + 0.2, d)));
  }
  if (uGraded > 0.5) c = grade(c);
  c += uAdjust.x * 0.5;
  c = (c - 0.5) * (1.0 + uAdjust.y) + 0.5;
  c = mix(vec3(luma(c)), c, 1.0 + uAdjust.z);
  c = clamp(c, 0.0, 1.0);
  if (uLutOn == 1) c = mix(c, texture(uLut, c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb, uLutStrength);
  if (uVignette > 0.0) c *= 1.0 - uVignette * smoothstep(0.3, 0.95, length(vUv - 0.5) * 1.414);
  if (uEffect == 3) c = mix(c, c * (0.9 + 0.1 * sin(vUv.y * uPx.y * 1.6)) * vec3(1.04, 0.98, 1.07), uAmount);
  if (uEffect == 5) c = mix(c, vec3(1.0), clamp(uAmount * exp(-uLocal * 7.0), 0.0, 1.0));
  if (uGrain > 0.0) c += (hash(vUv * uPx + fract(uTime * 13.7) * 97.0) - 0.5) * uGrain * 0.22;
  c = clamp(c, 0.0, 1.0) * (1.0 - uDim);
  if (uMask > 0) {
    // Sizes are fractions of the picture's shorter side, so equal ones make a circle or a square.
    float side = min(uPx.x, uPx.y);
    vec2 q = (vUv - uMaskRect.xy) * uPx;
    vec2 hs = max(uMaskRect.zw * side * 0.5, vec2(0.5));
    float d;
    if (uMask == 1) d = (length(q / hs) - 1.0) * min(hs.x, hs.y);
    else { vec2 e = abs(q) - hs; d = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0); }
    float f = max(1.0, uMaskFeather * side);
    float inside = 1.0 - smoothstep(-f, f, d);
    alpha *= uMaskInvert > 0.5 ? 1.0 - inside : inside;
  }
  if (uRadius > 0.0 || uBorder > 0.0) {
    float d = roundBox(p, uBox, uRadius);
    alpha *= clamp(0.5 - d, 0.0, 1.0);
    if (uBorder > 0.0) c = mix(c, uBorderColor, clamp(d + uBorder + 0.5, 0.0, 1.0));
  }
  float a = alpha * uOpacity;
  outColor = vec4(c * a, a);
}`;

/** RGB from target C into I420 planes: each RGBA texel holds four 8-bit samples of one row. */
const PACK_FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform int uPlane;   // 0 = Y, 1 = U (Cb), 2 = V (Cr)
const vec3 K = vec3(0.2126, 0.7152, 0.0722);
vec3 rgb(int x, int y) { return texelFetch(uSrc, ivec2(x, uSize.y - 1 - y), 0).rgb; }
float chroma(int cx, int cy) {
  vec3 c = (rgb(cx * 2, cy * 2) + rgb(cx * 2 + 1, cy * 2) + rgb(cx * 2, cy * 2 + 1) + rgb(cx * 2 + 1, cy * 2 + 1)) * 0.25;
  float y = dot(c, K);
  float v = uPlane == 1 ? (c.b - y) / 1.8556 : (c.r - y) / 1.5748;
  return (128.0 + 224.0 * v) / 255.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 o;
  for (int k = 0; k < 4; k++) {
    float v;
    if (uPlane == 0) v = (16.0 + 219.0 * dot(rgb(p.x * 4 + k, p.y), K)) / 255.0;
    else v = chroma(p.x * 4 + k, p.y);
    o[k] = v;
  }
  outColor = o;
}`;

const PACK_VS = `#version 300 es
void main() {
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

/** A read of the output `beginI420` started: a buffer on the GPU's side and the fence that says it's filled. */
export interface PendingRead {
  buffer: WebGLBuffer;
  fence: WebGLSync;
  bytes: number;
}

/** Resolves on a later task: through a message (timers wait 4 ms once nested), or after `ms`. */
function nextTask(ms = 0): Promise<void> {
  if (ms > 0) return new Promise((r) => setTimeout(r, ms));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      r();
    };
    ch.port2.postMessage(null);
  });
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

function uniforms(gl: WebGL2RenderingContext, program: WebGLProgram) {
  const cache = new Map<string, WebGLUniformLocation | null>();
  return (name: string) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    return cache.get(name)!;
  };
}

const NEUTRAL: Grade = { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], saturation: 1, contrast: 0, shadowTint: [0, 0, 0], highlightTint: [0, 0, 0] };

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private layer: WebGLProgram;
  private final: WebGLProgram;
  private pack: WebGLProgram;
  private ul: (n: string) => WebGLUniformLocation | null;
  private uf: (n: string) => WebGLUniformLocation | null;
  private up: (n: string) => WebGLUniformLocation | null;
  private targets: Record<"a" | "b" | "c", Target | null> = { a: null, b: null, c: null };
  private planes: Target[] = [];
  /** Free buffers for the reads `beginI420` starts, `readBytes` each. */
  private reads: WebGLBuffer[] = [];
  private readBytes = 0;
  private width = 0;
  private height = 0;
  private lost = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 isn't available, so the editor can't draw.");
    this.gl = gl;
    this.layer = compile(gl, LAYER_VS, LAYER_FS);
    this.final = compile(gl, VERTEX, FINAL);
    this.pack = compile(gl, PACK_VS, PACK_FS);
    this.ul = uniforms(gl, this.layer);
    this.uf = uniforms(gl, this.final);
    this.up = uniforms(gl, this.pack);
    canvas.addEventListener("webglcontextlost", () => (this.lost = true));
  }

  get size() {
    return { width: this.width, height: this.height };
  }

  private target(width: number, height: number, mips = false): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mips ? gl.LINEAR : gl.NEAREST);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fb, tex, width, height };
  }

  private drop(t: Target | null) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
  }

  /** Sizes the three targets (and the canvas, for showing them). */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    for (const k of ["a", "b", "c"] as const) {
      this.drop(this.targets[k]);
      this.targets[k] = this.target(width, height, true);
    }
    for (const p of this.planes) this.drop(p);
    this.planes = [];
  }

  // ---- sources

  private planeTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Puts a decoded frame into a source (made on first use, resized as needed). */
  uploadFrame(source: Source | null, frame: Frame): Source {
    const gl = this.gl;
    let s = source;
    if (!s || s.kind !== "yuv") {
      if (s) this.release(s);
      s = { kind: "yuv", width: 0, height: 0, textures: [this.planeTexture(), this.planeTexture(), this.planeTexture()], pts: -1, mips: false };
    }
    if (!frame.data) return s;
    const { width: w, height: h, data } = frame;
    const fresh = w !== s.width || h !== s.height;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const planes: [number, number, number][] = [[w, h, 0], [w / 2, h / 2, w * h], [w / 2, h / 2, w * h + (w * h) / 4]];
    planes.forEach(([pw, ph, offset], i) => {
      gl.bindTexture(gl.TEXTURE_2D, s!.textures[i]);
      const pixels = data.subarray(offset, offset + pw * ph);
      if (fresh) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.RED, gl.UNSIGNED_BYTE, pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    });
    s.width = w;
    s.height = h;
    s.pts = frame.pts;
    s.dur = frame.dur;
    s.mips = false;
    return s;
  }

  /** A picture, a text or any canvas as a source (premultiplied). */
  uploadImage(source: Source | null, image: TexImageSource & { width: number; height: number }): Source {
    const gl = this.gl;
    let s = source;
    if (!s || s.kind !== "rgba") {
      if (s) this.release(s);
      s = { kind: "rgba", width: 0, height: 0, textures: [this.planeTexture()], pts: 0, mips: false };
    }
    gl.bindTexture(gl.TEXTURE_2D, s.textures[0]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    s.width = image.width;
    s.height = image.height;
    s.mips = false;
    return s;
  }

  /** A colour table as a 3D texture (RGB, 16-bit float). */
  uploadLut(size: number, data: Float32Array): Lut3D {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return { tex, size };
  }

  releaseLut(lut: Lut3D) {
    this.gl.deleteTexture(lut.tex);
  }

  release(source: Source) {
    for (const t of source.textures) this.gl.deleteTexture(t);
    source.textures = [];
  }

  private ensureMips(s: Source) {
    if (s.mips) return;
    const gl = this.gl;
    for (const t of s.textures) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    s.mips = true;
  }

  // ---- drawing

  private bind(t: Target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.width, t.height);
  }

  /** Clears a target to a colour (0…1) and draws layers into it, in order. */
  drawInto(which: "a" | "b" | "c", layers: LayerDraw[], clear: [number, number, number] | null) {
    const t = this.targets[which];
    if (!t || this.lost) return;
    const gl = this.gl;
    this.bind(t);
    if (clear) {
      gl.clearColor(clear[0], clear[1], clear[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (!layers.length) return;
    gl.useProgram(this.layer);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const u = this.ul;
    gl.uniform2f(u("uCanvas"), t.width, t.height);
    gl.uniform1i(u("uY"), 0);
    gl.uniform1i(u("uU"), 1);
    gl.uniform1i(u("uV"), 2);
    // Its own unit: two sampler types may not share one.
    gl.uniform1i(u("uLut"), 3);
    for (const l of layers) {
      const s = l.source;
      if (!l.shadow && (!s.textures.length || !s.width)) continue;
      this.layerExtras(l);
      if (l.shadow) {
        gl.uniform2f(u("uCenter"), l.center[0], l.center[1]);
        gl.uniform2f(u("uSize"), l.size[0], l.size[1]);
        gl.uniform1f(u("uRot"), l.rotation);
        gl.uniform1f(u("uOpacity"), l.opacity);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        continue;
      }
      if (l.blur > 0) this.ensureMips(s);
      s.textures.forEach((tex, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      });
      gl.uniform1i(u("uYuv"), s.kind === "yuv" ? 1 : 0);
      gl.uniform2f(u("uTexel"), 1 / s.width, 1 / s.height);
      gl.uniform2f(u("uCenter"), l.center[0], l.center[1]);
      gl.uniform2f(u("uSize"), l.size[0], l.size[1]);
      gl.uniform1f(u("uRot"), l.rotation);
      gl.uniform1f(u("uOpacity"), l.opacity);
      gl.uniform1f(u("uLod"), l.blur);
      gl.uniform1f(u("uDim"), l.dim);
      const g = l.grade ?? NEUTRAL;
      gl.uniform1f(u("uGraded"), l.grade ? 1 : 0);
      gl.uniform3fv(u("uLift"), g.lift);
      gl.uniform3fv(u("uGamma"), g.gamma);
      gl.uniform3fv(u("uGain"), g.gain);
      gl.uniform3fv(u("uShadowTint"), g.shadowTint);
      gl.uniform3fv(u("uHighTint"), g.highlightTint);
      gl.uniform1f(u("uSat"), g.saturation);
      gl.uniform1f(u("uContrast"), g.contrast);
      gl.uniform3f(u("uAdjust"), l.adjust[0], l.adjust[1], l.adjust[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The uniforms beyond the picture itself: effects, key, colour table, mask, frame, shadow. */
  private layerExtras(l: LayerDraw) {
    const gl = this.gl;
    const u = this.ul;
    const fx = l.fx;
    gl.uniform2f(u("uPx"), l.size[0], l.size[1]);
    gl.uniform1i(u("uSolid"), l.shadow ? 1 : 0);
    if (l.shadow) {
      gl.uniform2f(u("uBox"), l.shadow.box[0], l.shadow.box[1]);
      gl.uniform1f(u("uRadius"), l.shadow.radius);
      gl.uniform1f(u("uSoft"), l.shadow.softness);
      return;
    }
    gl.uniform2f(u("uBox"), l.size[0] / 2, l.size[1] / 2);
    gl.uniform1i(u("uEffect"), fx?.effect ?? 0);
    gl.uniform1f(u("uAmount"), fx?.amount ?? 0);
    gl.uniform1f(u("uLocal"), fx?.local ?? 0);
    gl.uniform1f(u("uTime"), fx?.time ?? 0);
    gl.uniform1f(u("uSeed"), fx?.seed ?? 0);
    gl.uniform1f(u("uSharpen"), fx?.sharpen ?? 0);
    gl.uniform1f(u("uVignette"), fx?.vignette ?? 0);
    gl.uniform1f(u("uGrain"), fx?.grain ?? 0);
    const key = fx?.key;
    gl.uniform1i(u("uKeyOn"), key ? 1 : 0);
    if (key) {
      gl.uniform3f(u("uKeyColor"), key[0], key[1], key[2]);
      gl.uniform3f(u("uKeyParams"), key[3], key[4], key[5]);
    }
    const lut = fx?.lut;
    gl.uniform1i(u("uLutOn"), lut ? 1 : 0);
    if (lut) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_3D, lut.tex);
      gl.uniform1f(u("uLutSize"), lut.size);
      gl.uniform1f(u("uLutStrength"), fx?.lutStrength ?? 1);
    }
    const mask = fx?.mask;
    gl.uniform1i(u("uMask"), mask ? mask.shape : 0);
    if (mask) {
      gl.uniform4f(u("uMaskRect"), mask.rect[0], mask.rect[1], mask.rect[2], mask.rect[3]);
      gl.uniform1f(u("uMaskFeather"), Math.max(0.001, mask.feather));
      gl.uniform1f(u("uMaskInvert"), mask.invert ? 1 : 0);
    }
    gl.uniform1f(u("uRadius"), fx?.radius ?? 0);
    gl.uniform1f(u("uBorder"), fx?.border ?? 0);
    const bc = fx?.borderColor ?? [1, 1, 1];
    gl.uniform3f(u("uBorderColor"), bc[0], bc[1], bc[2]);
  }

  /**
   * Mixes A and B into C with a slideshow transition (`kind` from TRANSITION_IDS), or copies A
   * when `kind` is −1.
   */
  combine(kind: number, progress: number, seed: number, time: number) {
    const { a, b, c } = this.targets;
    if (!a || !b || !c || this.lost) return;
    const gl = this.gl;
    if (kind >= 0 && NEEDS_FRAME_MIPS.has(kind)) {
      for (const t of [a, b]) {
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      }
    } else {
      for (const t of [a, b]) {
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
    }
    this.bind(c);
    gl.useProgram(this.final);
    const u = this.uf;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform1i(u("uA"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform1i(u("uB"), 1);
    gl.uniform1i(u("uKind"), kind);
    gl.uniform1f(u("uP"), progress);
    const angle = seed * Math.PI * 2;
    gl.uniform2f(u("uDir"), Math.cos(angle) >= 0 ? 1 : -1, 0);
    gl.uniform1f(u("uSeed"), seed);
    gl.uniform2f(u("uRes"), c.width, c.height);
    gl.uniform1f(u("uTime"), time);
    gl.uniform1f(u("uFade"), 1);
    gl.uniform1f(u("uBars"), 0);
    gl.uniform1f(u("uGrain"), 0);
    gl.uniform1f(u("uVignette"), 0);
    gl.uniform3f(u("uLift"), 0, 0, 0);
    gl.uniform3f(u("uGamma"), 1, 1, 1);
    gl.uniform3f(u("uGain"), 1, 1, 1);
    gl.uniform1f(u("uSat"), 1);
    gl.uniform1f(u("uContrast"), 0);
    gl.uniform3f(u("uShadowTint"), 0, 0, 0);
    gl.uniform3f(u("uHighTint"), 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The colour of output pixel (x, y) from the top left, 0…255 (the eyedropper). */
  readPixel(x: number, y: number): [number, number, number] | null {
    const c = this.targets.c;
    if (!c || this.lost) return null;
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fb);
    gl.readPixels(Math.max(0, Math.min(c.width - 1, Math.round(x))), Math.max(0, Math.min(c.height - 1, c.height - 1 - Math.round(y))), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [px[0], px[1], px[2]];
  }

  /** C as RGBA rows from the top (Save as Poster). */
  readRGBA(): { rgba: Uint8Array; width: number; height: number } {
    const c = this.targets.c;
    if (!c || this.lost) throw new Error("The picture was lost (WebGL).");
    const gl = this.gl;
    const { width: w, height: h } = c;
    const flipped = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fb);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) rgba.set(flipped.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { rgba, width: w, height: h };
  }

  /** Shows C on the canvas (its size is the output size). */
  present() {
    const c = this.targets.c;
    if (!c || this.lost) return;
    const gl = this.gl;
    if (this.canvas.width !== c.width || this.canvas.height !== c.height) {
      this.canvas.width = c.width;
      this.canvas.height = c.height;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, c.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, c.width, c.height, 0, 0, c.width, c.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** C as I420 (width a multiple of 8), into `out` (width × height × 1.5 bytes). */
  readI420(out: Uint8Array) {
    const gl = this.gl;
    this.packI420((plane, offset) => gl.readPixels(0, 0, plane.width, plane.height, gl.RGBA, gl.UNSIGNED_BYTE, out, offset));
  }

  /**
   * Starts reading C as I420 without waiting for the GPU: the planes go into a buffer on its
   * side, and `collectI420` copies them out once they're there, so the page draws the next
   * frames meanwhile (export keeps a few on their way).
   */
  beginI420(): PendingRead {
    const gl = this.gl;
    const c = this.targets.c;
    const bytes = c ? (c.width * c.height * 3) / 2 : 0;
    if (bytes !== this.readBytes) {
      for (const b of this.reads) gl.deleteBuffer(b);
      this.reads = [];
      this.readBytes = bytes;
    }
    let buffer = this.reads.pop();
    if (!buffer) {
      buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    try {
      this.packI420((plane, offset) => gl.readPixels(0, 0, plane.width, plane.height, gl.RGBA, gl.UNSIGNED_BYTE, offset));
    } catch (err) {
      this.reads.push(buffer);
      throw err;
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();
    return { buffer, fence, bytes };
  }

  /** Copies a read `beginI420` started into `out` once the GPU has done it; the page runs meanwhile. */
  async collectI420(read: PendingRead, out: Uint8Array): Promise<void> {
    const gl = this.gl;
    // A fence only changes between tasks: look again on the next one (then every millisecond).
    for (let tries = 0; !this.lost && gl.clientWaitSync(read.fence, 0, 0) === gl.TIMEOUT_EXPIRED; tries++) await nextTask(tries < 8 ? 0 : 1);
    gl.deleteSync(read.fence);
    if (this.lost) throw new Error("The picture was lost (WebGL).");
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out, 0, read.bytes);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (read.bytes === this.readBytes) this.reads.push(read.buffer);
    else gl.deleteBuffer(read.buffer);
  }

  /** Lets go of a read `beginI420` started that won't be collected. */
  dropI420(read: PendingRead) {
    this.gl.deleteSync(read.fence);
    if (read.bytes === this.readBytes) this.reads.push(read.buffer);
    else this.gl.deleteBuffer(read.buffer);
  }

  /** Draws C's I420 planes (width a multiple of 8) and has `read` take each, at its offset in the frame. */
  private packI420(read: (plane: Target, offset: number) => void) {
    const c = this.targets.c;
    if (!c || this.lost) throw new Error("The picture was lost (WebGL).");
    const gl = this.gl;
    const { width: w, height: h } = c;
    if (!this.planes.length) this.planes = [this.target(w / 4, h), this.target(w / 8, h / 2), this.target(w / 8, h / 2)];
    gl.useProgram(this.pack);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, c.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.uniform1i(this.up("uSrc"), 0);
    gl.uniform2i(this.up("uSize"), w, h);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    const offsets = [0, w * h, w * h + (w * h) / 4];
    this.planes.forEach((plane, i) => {
      this.bind(plane);
      gl.uniform1i(this.up("uPlane"), i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      read(plane, offsets[i]);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose() {
    for (const k of ["a", "b", "c"] as const) this.drop(this.targets[k]);
    for (const p of this.planes) this.drop(p);
    for (const b of this.reads) this.gl.deleteBuffer(b);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
