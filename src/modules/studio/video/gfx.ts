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
  /** Mipmaps are made on demand for blurred backgrounds. */
  mips: boolean;
}

export interface LayerDraw {
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
in vec2 vUv;
out vec4 outColor;
uniform int uYuv;
uniform sampler2D uY, uU, uV;
uniform vec2 uTexel;
uniform float uLod, uOpacity, uDim, uGraded;
uniform vec3 uLift, uGamma, uGain, uShadowTint, uHighTint;
uniform float uSat, uContrast;
uniform vec3 uAdjust;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
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
void main() {
  vec4 s = sampleAt(clamp(vUv, 0.0, 1.0));
  vec3 c = s.rgb;
  if (uGraded > 0.5) c = grade(c);
  c += uAdjust.x * 0.5;
  c = (c - 0.5) * (1.0 + uAdjust.y) + 0.5;
  c = mix(vec3(luma(c)), c, 1.0 + uAdjust.z);
  c = clamp(c, 0.0, 1.0) * (1.0 - uDim);
  float a = s.a * uOpacity;
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
    for (const l of layers) {
      const s = l.source;
      if (!s.textures.length || !s.width) continue;
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
    gl.activeTexture(gl.TEXTURE0);
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
      gl.readPixels(0, 0, plane.width, plane.height, gl.RGBA, gl.UNSIGNED_BYTE, out, offsets[i]);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose() {
    for (const k of ["a", "b", "c"] as const) this.drop(this.targets[k]);
    for (const p of this.planes) this.drop(p);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
