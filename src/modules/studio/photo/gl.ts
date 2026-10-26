/**
 * WebGL2 helpers shared by Photo and the Gallery's Quick Edit: what the GPU can do (the probe),
 * programs, textures and framebuffers.
 *
 * Every texture holds its top row first (no UNPACK_FLIP_Y), so a texel's row is the picture's row
 * and `readPixels` from a framebuffer returns the picture top-down. Only drawing to the screen
 * flips.
 */

export interface GpuInfo {
  webgl2: boolean;
  /** RGBA16F and RGBA32F can be rendered into (EXT_color_buffer_float), checked by a real draw. */
  floatTargets: boolean;
  /** RGBA16F only, through EXT_color_buffer_half_float. */
  halfFloatTargets: boolean;
  /** 32-bit float textures can be filtered (OES_texture_float_linear). */
  floatLinear: boolean;
  maxTexture: number;
  maxRenderbuffer: number;
  maxViewport: [number, number];
  /** The driver's own name for the GPU, when the browser tells it ("Mesa Intel(R) Xe Graphics…"). */
  renderer: string;
}

let probed: GpuInfo | null = null;

/** What WebGL2 can do here; tested once on a throwaway context. */
export function probeGpu(): GpuInfo {
  if (probed) return probed;
  const none: GpuInfo = { webgl2: false, floatTargets: false, halfFloatTargets: false, floatLinear: false, maxTexture: 0, maxRenderbuffer: 0, maxViewport: [0, 0], renderer: "" };
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 4;
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false });
  if (!gl) return (probed = none);
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const info: GpuInfo = {
    webgl2: true,
    floatTargets: false,
    halfFloatTargets: false,
    floatLinear: !!gl.getExtension("OES_texture_float_linear"),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    maxViewport: [...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)] as [number, number],
    renderer: String((debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? ""),
  };
  // An extension can be listed yet the framebuffer still refuse the format, or clamp it: draw a
  // value 8 bits can't hold and read it back.
  const holdsHalfFloat = () => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (ok) {
      const value = 0.5 + 1 / 1024;
      gl.clearColor(value, 1.5, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const out = new Float32Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, out);
      ok = gl.getError() === gl.NO_ERROR && Math.abs(out[0] - value) < 1 / 4096 && out[1] > 1.25;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok;
  };
  if (gl.getExtension("EXT_color_buffer_float")) info.floatTargets = info.halfFloatTargets = holdsHalfFloat();
  else if (gl.getExtension("EXT_color_buffer_half_float")) info.halfFloatTargets = holdsHalfFloat();
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return (probed = info);
}

/** "WebGL2 · 16-bit float · up to 16384 px", for the status bar. */
export function describeGpu(info: GpuInfo): string {
  if (!info.webgl2) return "No WebGL2";
  const depth = info.halfFloatTargets ? "16-bit float" : "8-bit (no float targets)";
  return `WebGL2 · ${depth} · textures up to ${info.maxTexture} px`;
}

/** A fullscreen quad's corners, (0,0) to (1,1), drawn as a triangle strip at attribute 0. */
export const QUAD_VERTEX = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vPos;
void main() {
  vPos = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface Program {
  readonly program: WebGLProgram;
  /** A uniform's location, looked up once. */
  u(name: string): WebGLUniformLocation | null;
}

export function makeProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string, label: string): Program {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`${label} shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram()!;
  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${label} shader: ${gl.getProgramInfoLog(program)}`);
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    u(name) {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
      return cache.get(name)!;
    },
  };
}

/** The quad every pass draws. */
export function makeQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export type TexFormat = "rgba8" | "rgba16f";

export const bytesPerPixel = (format: TexFormat) => (format === "rgba16f" ? 8 : 4);

/** An immutable-size texture, optionally filled with 8-bit RGBA rows (top row first). */
export function makeTexture(gl: WebGL2RenderingContext, width: number, height: number, format: TexFormat = "rgba8", data?: ArrayBufferView | TexImageSource | null, filter: number = gl.NEAREST): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const levels = filter === gl.LINEAR_MIPMAP_LINEAR ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, format === "rgba16f" ? gl.RGBA16F : gl.RGBA8, width, height);
  if (data) {
    unpackRaw(gl);
    if (ArrayBuffer.isView(data)) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    if (levels > 1) gl.generateMipmap(gl.TEXTURE_2D);
  }
  return tex;
}

/**
 * Pixels go in as they are: no flip, no premultiplying, and no colour conversion, so a picture's
 * values on the GPU are the values in the file (as Rust reads them for saving).
 */
export function unpackRaw(gl: WebGL2RenderingContext) {
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
}

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  format: TexFormat;
}

/** A texture to render into. */
export function makeTarget(gl: WebGL2RenderingContext, width: number, height: number, format: TexFormat = "rgba8", filter: number = gl.NEAREST): Target {
  const tex = makeTexture(gl, width, height, format, null, filter);
  return { tex, fbo: framebufferFor(gl, tex), width, height, format };
}

export function framebufferFor(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    throw new Error(`The GPU can't draw into this texture (status ${status}).`);
  }
  return fbo;
}

export function dropTarget(gl: WebGL2RenderingContext, target: Target | null) {
  if (!target) return;
  gl.deleteFramebuffer(target.fbo);
  gl.deleteTexture(target.tex);
}

/**
 * Reads 8-bit RGBA from the bound read framebuffer into `out` (row length `stride` pixels, at
 * pixel `offset`), top row first since textures are top-down.
 */
export function readInto(gl: WebGL2RenderingContext, x: number, y: number, width: number, height: number, out: Uint8Array, stride = width, offset = 0) {
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, stride === width ? 0 : stride);
  gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out, offset * 4);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
}

/** A GPU that's gone (driver reset, too much memory) shows as this. */
export function contextLost(gl: WebGL2RenderingContext) {
  return gl.isContextLost();
}
