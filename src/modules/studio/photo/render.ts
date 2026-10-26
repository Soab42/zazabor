import { ADJUST_GLSL, setAdjustUniforms, type Adjustments } from "./adjust";
import { outputSize, outputToSource, type Geometry } from "./geometry";
import { dropTarget, makeProgram, makeQuad, makeTarget, makeTexture, probeGpu, QUAD_VERTEX, readInto, type Program } from "./gl";

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform mat3 uMap;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform bool uFlipY;
uniform bool uAdjust;
uniform bool uFlatten;
uniform vec3 uBackdrop;
uniform bool uShowCrop;
uniform vec4 uCrop;
out vec4 outColor;
${ADJUST_GLSL}
void main() {
  vec2 uv = (gl_FragCoord.xy - uOrigin) / uSize;
  if (uFlipY) uv.y = 1.0 - uv.y;
  vec4 c = texture(uSrc, (uMap * vec3(uv, 1.0)).xy);
  // The vignette sits on the kept part, also while the crop tool shows the whole frame.
  vec2 frame = uShowCrop ? (uv - uCrop.xy) / uCrop.zw : uv;
  if (uAdjust) c.rgb = adjust(c.rgb, frame);
  if (uShowCrop && (frame.x < 0.0 || frame.y < 0.0 || frame.x > 1.0 || frame.y > 1.0)) c.rgb *= 0.4;
  if (uFlatten) c = vec4(mix(uBackdrop, c.rgb, c.a), 1.0);
  outColor = c;
}`;

/** Rows of 2048 px at a time: big enough to be quick, small enough for any GPU. */
const TILE = 2048;

export interface Source {
  width: number;
  height: number;
}

/**
 * Draws a picture through Quick Edit's geometry and adjustments: on screen (the preview), into
 * small renditions (filter swatches, Auto) and at full resolution in tiles (saving). All of them
 * run the same shader, so what's saved is what was shown.
 */
export class QuickRenderer {
  readonly gl: WebGL2RenderingContext;
  private program: Program;
  private quad: WebGLVertexArrayObject;
  private preview: WebGLTexture | null = null;
  private previewSize: Source = { width: 1, height: 1 };
  /** The picture's full size: the geometry is worked out in it, whatever the preview's size. */
  private size: Source = { width: 1, height: 1 };

  constructor(readonly canvas: HTMLCanvasElement = document.createElement("canvas")) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("This computer's graphics can't run the editor (no WebGL2).");
    this.gl = gl;
    this.program = makeProgram(gl, QUAD_VERTEX, FRAGMENT, "Quick Edit");
    this.quad = makeQuad(gl);
  }

  /** The picture to preview: a rendition of it (upright), and the full picture's size. */
  setPreview(image: TexImageSource | { width: number; height: number; rgba: Uint8Array }, width: number, height: number, full: Source) {
    const gl = this.gl;
    if (this.preview) gl.deleteTexture(this.preview);
    const data = "rgba" in image ? image.rgba : image;
    this.preview = makeTexture(gl, width, height, "rgba8", data, gl.LINEAR_MIPMAP_LINEAR);
    this.previewSize = { width, height };
    this.size = full;
  }

  get sourceSize(): Source {
    return this.size;
  }

  /** Sets up the program; `size` is the picture's (the geometry is worked out in it). */
  private use(tex: WebGLTexture, g: Geometry, adjust: Adjustments | null, whole: boolean, size: Source = this.size) {
    const gl = this.gl;
    const u = (name: string) => this.program.u(name);
    gl.useProgram(this.program.program);
    gl.bindVertexArray(this.quad);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u("uSrc"), 0);
    gl.uniformMatrix3fv(u("uMap"), false, outputToSource(g, size.width, size.height, whole));
    gl.uniform1i(u("uAdjust"), adjust ? 1 : 0);
    const [ow, oh] = outputSize(g, size.width, size.height);
    if (adjust) setAdjustUniforms(gl, u, adjust, ow / oh);
    gl.uniform1i(u("uShowCrop"), whole ? 1 : 0);
    gl.uniform4f(u("uCrop"), g.crop.x, g.crop.y, g.crop.w, g.crop.h);
  }

  /**
   * Draws the preview into `rect` (device pixels, top-left origin) of the canvas, over `backdrop`
   * (0–1 RGB). With `whole`, the whole frame shows, the parts the crop leaves out dimmed.
   */
  draw(g: Geometry, adjust: Adjustments | null, rect: { x: number; y: number; w: number; h: number }, backdrop: [number, number, number], whole = false) {
    const gl = this.gl;
    if (!this.preview) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(backdrop[0], backdrop[1], backdrop[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.use(this.preview, g, adjust, whole);
    const y = this.canvas.height - rect.y - rect.h;
    gl.viewport(rect.x, y, rect.w, rect.h);
    const u = (name: string) => this.program.u(name);
    gl.uniform2f(u("uOrigin"), rect.x, y);
    gl.uniform2f(u("uSize"), rect.w, rect.h);
    gl.uniform1i(u("uFlipY"), 1);
    gl.uniform1i(u("uFlatten"), 1);
    gl.uniform3fv(u("uBackdrop"), backdrop);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** A small rendition (straight alpha), from the preview: filter swatches and Auto read it. */
  renderSmall(g: Geometry, adjust: Adjustments | null, width: number, height: number): Uint8Array {
    if (!this.preview) return new Uint8Array(width * height * 4);
    return this.renderTiles(this.preview, g, adjust, width, height);
  }

  /**
   * The full-resolution result of the picture's pixels (`full`, the same picture as the preview)
   * as RGBA, `outputSize` large. Adjustments may be null: the geometry alone (for Photo).
   */
  renderFull(full: { width: number; height: number; rgba: Uint8Array }, g: Geometry, adjust: Adjustments | null, onWhite = false): { width: number; height: number; rgba: Uint8Array } {
    const gl = this.gl;
    const max = probeGpu().maxTexture;
    if (full.width > max || full.height > max) throw new Error(`The picture is larger than this GPU can hold (${max} px).`);
    const tex = makeTexture(gl, full.width, full.height, "rgba8", full.rgba, gl.LINEAR);
    try {
      const [width, height] = outputSize(g, full.width, full.height);
      return { width, height, rgba: this.renderTiles(tex, g, adjust, width, height, onWhite, full) };
    } finally {
      gl.deleteTexture(tex);
    }
  }

  /** `onWhite` flattens transparency onto white, for formats without alpha (JPEG, BMP). */
  private renderTiles(tex: WebGLTexture, g: Geometry, adjust: Adjustments | null, width: number, height: number, onWhite = false, size: Source = this.size): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(width * height * 4);
    const tw = Math.min(TILE, width), th = Math.min(TILE, height);
    const target = makeTarget(gl, tw, th);
    try {
      this.use(tex, g, adjust, false, size);
      const u = (name: string) => this.program.u(name);
      gl.uniform2f(u("uSize"), width, height);
      gl.uniform1i(u("uFlipY"), 0);
      gl.uniform1i(u("uFlatten"), onWhite ? 1 : 0);
      gl.uniform3f(u("uBackdrop"), 1, 1, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      for (let ty = 0; ty < height; ty += th) {
        for (let tx = 0; tx < width; tx += tw) {
          const w = Math.min(tw, width - tx), h = Math.min(th, height - ty);
          gl.viewport(0, 0, w, h);
          gl.uniform2f(u("uOrigin"), -tx, -ty);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          readInto(gl, 0, 0, w, h, out, width, ty * width + tx);
        }
      }
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`The GPU couldn't render the picture (error ${error}).`);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      dropTarget(gl, target);
    }
    return out;
  }

  /** The preview's own size (for the crop tool's pixel readout). */
  get previewPixels(): Source {
    return this.previewSize;
  }

  dispose() {
    if (this.preview) this.gl.deleteTexture(this.preview);
    this.preview = null;
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

