import type { Engine, Surface } from "./engine";
import { dropTarget, makeProgram, makeTarget, makeTexture, QUAD_VERTEX, type Program, type Target } from "./gl";

/**
 * Photo's filters on the GPU: Gaussian Blur, Unsharp Mask, Add Noise and Motion Blur. Each makes
 * a new straight-alpha texture the size of the surface, mixed with the original by the selection
 * (where there is one), so the caller can preview it in place and keep or drop it.
 */

export type FilterKind = "gaussian" | "unsharp" | "noise" | "motion";

export interface FilterSettings {
  gaussian: { radius: number };
  unsharp: { amount: number; radius: number; threshold: number };
  noise: { amount: number; gaussian: boolean; mono: boolean };
  motion: { angle: number; distance: number };
}

export const DEFAULT_FILTERS: FilterSettings = {
  gaussian: { radius: 4 },
  unsharp: { amount: 100, radius: 2, threshold: 0 },
  noise: { amount: 10, gaussian: true, mono: false },
  motion: { angle: 0, distance: 20 },
};

export const FILTER_LABELS: Record<FilterKind, string> = {
  gaussian: "Gaussian Blur",
  unsharp: "Unsharp Mask",
  noise: "Add Noise",
  motion: "Motion Blur",
};

/** Premultiplied box shrink by a whole factor (large blurs run on a smaller copy). */
const DOWN = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
uniform int uFactor;
uniform bool uStraight;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * uFactor;
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int j = 0; j < 32; j++) {
    if (j >= uFactor) break;
    for (int i = 0; i < 32; i++) {
      if (i >= uFactor) break;
      ivec2 q = min(o + ivec2(i, j), uSrcSize - 1);
      vec4 c = texelFetch(uSrc, q, 0);
      if (uStraight) c.rgb *= c.a;
      acc += c;
      n += 1.0;
    }
  }
  outColor = acc / n;
}`;

/** One direction of a Gaussian, on premultiplied colour (straight input with `uStraight`). */
const BLUR = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform ivec2 uDir;
uniform float uSigma;
uniform int uRadius;
uniform bool uStraight;
out vec4 outColor;
vec4 at(ivec2 q) {
  vec4 c = texelFetch(uSrc, clamp(q, ivec2(0), uSize - 1), 0);
  if (uStraight) c.rgb *= c.a;
  return c;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = at(p);
  float wsum = 1.0;
  float k = -0.5 / (uSigma * uSigma);
  for (int i = 1; i <= 256; i++) {
    if (i > uRadius) break;
    float w = exp(float(i * i) * k);
    acc += (at(p + uDir * i) + at(p - uDir * i)) * w;
    wsum += 2.0 * w;
  }
  outColor = acc / wsum;
}`;

/** Motion blur: an average along a line through each pixel, premultiplied. */
const MOTION = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform vec2 uStep;
uniform int uTaps;
out vec4 outColor;
vec4 at(vec2 q) {
  vec4 c = texelFetch(uSrc, clamp(ivec2(floor(q)), ivec2(0), uSize - 1), 0);
  return vec4(c.rgb * c.a, c.a);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 128; i++) {
    if (i >= uTaps) break;
    float t = float(i) / float(max(uTaps - 1, 1)) - 0.5;
    acc += at(p + uStep * t);
  }
  outColor = acc / float(uTaps);
}`;

/**
 * The result: the filtered colour (from `uBlur`, premultiplied, at `uScale` of the size) or the
 * original with sharpening or noise, then mixed with the original by the selection.
 */
const COMBINE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform sampler2D uSel;
uniform ivec2 uSize;
uniform vec2 uBlurSize;
uniform float uScale;
uniform int uMode;
uniform bool uHasSel;
uniform ivec2 uOrigin;
uniform ivec2 uDoc;
uniform float uAmount;
uniform float uThreshold;
uniform bool uGaussian;
uniform bool uMono;
uniform float uSeed;
out vec4 outColor;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + uSeed);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise(vec2 p) {
  if (!uGaussian) return hash(p) * 2.0 - 1.0;
  float u1 = max(hash(p), 1e-6), u2 = hash(p + 17.13);
  return clamp(sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2) / 2.5, -1.0, 1.0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 o = texelFetch(uSrc, p, 0);
  vec4 f = o;
  if (uMode == 0 || uMode == 1) {
    vec4 b = texture(uBlur, (vec2(p) + 0.5) * uScale / uBlurSize);
    vec4 blurred = b.a > 1e-6 ? vec4(b.rgb / b.a, b.a) : vec4(0.0);
    if (uMode == 0) f = blurred;
    else {
      vec3 d = o.rgb - blurred.rgb;
      vec3 keep = step(vec3(uThreshold), abs(d) * 255.0);
      f = vec4(clamp(o.rgb + uAmount * d * keep, 0.0, 1.0), o.a);
    }
  } else if (uMode == 2) {
    vec2 q = vec2(p);
    vec3 n = uMono ? vec3(noise(q)) : vec3(noise(q), noise(q + 31.7), noise(q + 73.1));
    f = vec4(clamp(o.rgb + n * uAmount, 0.0, 1.0), o.a);
  }
  float s = 1.0;
  if (uHasSel) {
    ivec2 d = p + uOrigin;
    s = (d.x < 0 || d.y < 0 || d.x >= uDoc.x || d.y >= uDoc.y) ? 0.0 : texelFetch(uSel, d, 0).r;
  }
  // Mix in premultiplied colour so a blur into transparency fades instead of going grey.
  vec4 a = vec4(o.rgb * o.a, o.a), b2 = vec4(f.rgb * f.a, f.a);
  vec4 m = mix(a, b2, s);
  outColor = m.a > 1e-6 ? vec4(m.rgb / m.a, m.a) : vec4(0.0);
}`;

export class Filters {
  private down: Program;
  private blur: Program;
  private motion: Program;
  private combine: Program;
  private empty: WebGLTexture;
  private linear: WebGLSampler;

  constructor(private readonly engine: Engine) {
    const gl = engine.gl;
    this.down = makeProgram(gl, QUAD_VERTEX, DOWN, "Shrink");
    this.blur = makeProgram(gl, QUAD_VERTEX, BLUR, "Blur");
    this.motion = makeProgram(gl, QUAD_VERTEX, MOTION, "Motion Blur");
    this.combine = makeProgram(gl, QUAD_VERTEX, COMBINE, "Filter");
    this.empty = makeTexture(gl, 1, 1, "rgba8", new Uint8Array(4));
    this.linear = gl.createSampler()!;
    gl.samplerParameteri(this.linear, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.linear, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.linear, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.linear, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private draw(program: Program, target: Target, setup: (u: (n: string) => WebGLUniformLocation | null) => void) {
    const gl = this.engine.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(program.program);
    gl.bindVertexArray(this.engine.quad);
    for (let unit = 0; unit < 3; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
    }
    setup((n) => program.u(n));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bind(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) {
    const gl = this.engine.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  /** The Gaussian of a surface (premultiplied), at 1/`factor` of its size. */
  private gaussian(src: Surface, sigma: number): { target: Target; factor: number; drop: Target[] } {
    const gl = this.engine.gl;
    const format = this.engine.accum;
    const drop: Target[] = [];
    let factor = 1;
    let source: WebGLTexture = src.tex;
    let w = src.width, h = src.height;
    let straight = true;
    if (sigma > 16) {
      factor = Math.min(32, Math.ceil(sigma / 12));
      w = Math.max(1, Math.ceil(src.width / factor));
      h = Math.max(1, Math.ceil(src.height / factor));
      const small = makeTarget(gl, w, h, format);
      drop.push(small);
      this.draw(this.down, small, (u) => {
        this.bind(0, src.tex, u("uSrc"));
        gl.uniform2i(u("uSrcSize"), src.width, src.height);
        gl.uniform1i(u("uFactor"), factor);
        gl.uniform1i(u("uStraight"), 1);
      });
      source = small.tex;
      straight = false;
    }
    const s = Math.max(0.3, sigma / factor);
    const radius = Math.min(256, Math.ceil(s * 3));
    const a = makeTarget(gl, w, h, format), b = makeTarget(gl, w, h, format, gl.LINEAR);
    drop.push(a);
    const pass = (from: WebGLTexture, to: Target, dir: [number, number], straightIn: boolean) =>
      this.draw(this.blur, to, (u) => {
        this.bind(0, from, u("uSrc"));
        gl.uniform2i(u("uSize"), w, h);
        gl.uniform2i(u("uDir"), dir[0], dir[1]);
        gl.uniform1f(u("uSigma"), s);
        gl.uniform1i(u("uRadius"), radius);
        gl.uniform1i(u("uStraight"), straightIn ? 1 : 0);
      });
    pass(source, a, [1, 0], straight);
    pass(a.tex, b, [0, 1], false);
    return { target: b, factor, drop };
  }

  /**
   * The filtered surface as a new texture (straight RGBA, the surface's size). `selection` is the
   * document's selection texture; `doc` its size.
   */
  apply<K extends FilterKind>(src: Surface, kind: K, settings: FilterSettings[K], selection: WebGLTexture | null, doc: [number, number], seed = 0): WebGLTexture {
    const gl = this.engine.gl;
    const drop: Target[] = [];
    let blurred: Target | null = null;
    let factor = 1;
    let mode = 2;
    if (kind === "gaussian" || kind === "unsharp") {
      const radius = kind === "gaussian" ? (settings as FilterSettings["gaussian"]).radius : (settings as FilterSettings["unsharp"]).radius;
      const g = this.gaussian(src, Math.max(0.1, radius));
      blurred = g.target;
      factor = g.factor;
      drop.push(...g.drop, g.target);
      mode = kind === "gaussian" ? 0 : 1;
    } else if (kind === "motion") {
      const m = settings as FilterSettings["motion"];
      const target = makeTarget(gl, src.width, src.height, this.engine.accum, gl.LINEAR);
      drop.push(target);
      const rad = (m.angle * Math.PI) / 180;
      this.draw(this.motion, target, (u) => {
        this.bind(0, src.tex, u("uSrc"));
        gl.uniform2i(u("uSize"), src.width, src.height);
        // Angles count counter-clockwise, as in Photoshop; rows run top-down here.
        gl.uniform2f(u("uStep"), Math.cos(rad) * m.distance, -Math.sin(rad) * m.distance);
        gl.uniform1i(u("uTaps"), Math.max(2, Math.min(128, Math.round(m.distance))));
      });
      blurred = target;
      mode = 0;
    }
    const out = makeTarget(gl, src.width, src.height);
    this.draw(this.combine, out, (u) => {
      this.bind(0, src.tex, u("uSrc"));
      if (blurred) {
        this.bind(1, blurred.tex, u("uBlur"));
        gl.bindSampler(1, this.linear);
      } else gl.uniform1i(u("uBlur"), 1);
      this.bind(2, selection ?? this.empty, u("uSel"));
      gl.uniform2i(u("uSize"), src.width, src.height);
      gl.uniform2f(u("uBlurSize"), blurred?.width ?? 1, blurred?.height ?? 1);
      gl.uniform1f(u("uScale"), 1 / factor);
      gl.uniform1i(u("uMode"), mode);
      gl.uniform1i(u("uHasSel"), selection ? 1 : 0);
      gl.uniform2i(u("uOrigin"), src.x, src.y);
      gl.uniform2i(u("uDoc"), doc[0], doc[1]);
      gl.uniform1f(u("uSeed"), seed);
      if (kind === "unsharp") {
        const s = settings as FilterSettings["unsharp"];
        gl.uniform1f(u("uAmount"), s.amount / 100);
        gl.uniform1f(u("uThreshold"), s.threshold);
      } else if (kind === "noise") {
        const s = settings as FilterSettings["noise"];
        gl.uniform1f(u("uAmount"), s.amount / 100);
        gl.uniform1i(u("uGaussian"), s.gaussian ? 1 : 0);
        gl.uniform1i(u("uMono"), s.mono ? 1 : 0);
      }
    });
    gl.bindSampler(1, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const t of drop) dropTarget(gl, t);
    this.engine.releaseTarget(out);
    this.engine.invalidate();
    return out.tex;
  }

  dispose() {
    const gl = this.engine.gl;
    gl.deleteTexture(this.empty);
    gl.deleteSampler(this.linear);
  }
}
