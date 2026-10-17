import type { Tile } from "./tiles";
import type { ZoomLayer } from "./zoom";

export interface DrawItem {
  layer: ZoomLayer;
  /** Source pixels → canvas pixels. */
  matrix: DOMMatrix;
  alpha: number;
  /** For tiled layers: the loaded tiles to draw. */
  tiles?: Tile[];
}

export interface DrawOptions {
  /** Draw magnified pixels as sharp squares rather than smoothing them. */
  crisp: boolean;
  /** Pixel-grid opacity (0 hides it). */
  grid: number;
  dpr: number;
}

/** Draws image layers onto the zoom canvas; implemented with WebGL2 or Canvas2D. */
export interface ZoomDrawer {
  resize(width: number, height: number): void;
  draw(items: DrawItem[], options: DrawOptions): void;
  /** Uploads an image ahead of time so the first frame that needs it doesn't stall. */
  prepare(image: CanvasImageSource): void;
  /** Frees whatever was kept for an image that is no longer shown. */
  release(image: CanvasImageSource): void;
}

const BACKGROUND: [number, number, number] = [0.043, 0.043, 0.047];

// ---- WebGL2 ------------------------------------------------------------------------------

const VERTEX = `#version 300 es
in vec2 aPos;
uniform mat3 uToClip;
uniform vec4 uTile;      // x, y, width, height in source pixels
uniform vec4 uUv;        // the texture region holding that rectangle
out vec2 vSrc;
out vec2 vUv;
void main() {
  vec2 src = uTile.xy + aPos * uTile.zw;
  vSrc = src;
  vUv = uUv.xy + aPos * uUv.zw;
  vec3 p = uToClip * vec3(src, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vSrc;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uAlpha;
uniform float uGrid;
uniform float uDevicePerSource;
uniform float uDpr;
void main() {
  vec4 c = texture(uTex, vUv);
  // A checkerboard shows through transparent pixels.
  vec2 cell = floor(gl_FragCoord.xy / (8.0 * uDpr));
  vec3 checker = mix(vec3(0.169, 0.169, 0.18), vec3(0.22, 0.22, 0.235), mod(cell.x + cell.y, 2.0));
  vec3 color = mix(checker, c.rgb, c.a);
  if (uGrid > 0.0) {
    vec2 f = fract(vSrc);
    vec2 edge = min(f, 1.0 - f) * uDevicePerSource;
    float line = 1.0 - smoothstep(0.35, 1.0, min(edge.x, edge.y));
    color = mix(color, vec3(0.5, 0.5, 0.52), line * uGrid);
  }
  outColor = vec4(color * uAlpha, uAlpha);
}`;

interface ImageTile {
  texture: WebGLTexture;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class GLDrawer implements ZoomDrawer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject;
  private smooth: WebGLSampler;
  private sharp: WebGLSampler;
  private tiles = new Map<CanvasImageSource, ImageTile[]>();
  /** Textures for backend tiles, with the frame each was last drawn in. */
  private tileTextures = new Map<Tile, { texture: WebGLTexture; frame: number }>();
  private frameCount = 0;
  private maxTile: number;
  private width = 1;
  private height = 1;

  /** Throws when WebGL2 is unavailable so the caller can use the Canvas2D drawer. */
  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.maxTile = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Viewer shader: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(this.program, 0, "aPos");
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(`Viewer shader: ${gl.getProgramInfoLog(this.program)}`);
    for (const name of ["uToClip", "uTile", "uUv", "uTex", "uAlpha", "uGrid", "uDevicePerSource", "uDpr"]) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const sampler = (mag: number) => {
      const s = gl.createSampler()!;
      gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, mag);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return s;
    };
    this.smooth = sampler(gl.LINEAR);
    this.sharp = sampler(gl.NEAREST);
  }

  resize(width: number, height: number) {
    this.width = this.canvas.width = Math.max(1, width);
    this.height = this.canvas.height = Math.max(1, height);
  }

  prepare(image: CanvasImageSource) {
    this.tilesFor(image);
  }

  release(image: CanvasImageSource) {
    for (const tile of this.tiles.get(image) ?? []) this.gl.deleteTexture(tile.texture);
    this.tiles.delete(image);
  }

  private tileTexture(tile: Tile): WebGLTexture {
    const cached = this.tileTextures.get(tile);
    if (cached) {
      cached.frame = this.frameCount;
      return cached.texture;
    }
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tile.dataW, tile.dataH, 0, gl.RGBA, gl.UNSIGNED_BYTE, tile.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.tileTextures.set(tile, { texture, frame: this.frameCount });
    return texture;
  }

  /** Frees textures of tiles that haven't been drawn for a while. */
  private evictTiles() {
    if (this.tileTextures.size <= 160) return;
    for (const [tile, entry] of this.tileTextures) {
      if (this.frameCount - entry.frame > 90) {
        this.gl.deleteTexture(entry.texture);
        this.tileTextures.delete(tile);
      }
    }
  }

  /** Uploads an image as one texture, or several when it exceeds the GPU's size limit. */
  private tilesFor(image: CanvasImageSource): ImageTile[] {
    const cached = this.tiles.get(image);
    if (cached) return cached;
    const gl = this.gl;
    const { width, height } = sourceSize(image);
    const tiles: ImageTile[] = [];
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (let y = 0; y < height; y += this.maxTile) {
      for (let x = 0; x < width; x += this.maxTile) {
        const w = Math.min(this.maxTile, width - x);
        const h = Math.min(this.maxTile, height - y);
        let source: TexImageSource = image as TexImageSource;
        if (w !== width || h !== height) {
          const crop = document.createElement("canvas");
          crop.width = w;
          crop.height = h;
          crop.getContext("2d")!.drawImage(image, x, y, w, h, 0, 0, w, h);
          source = crop;
        }
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.generateMipmap(gl.TEXTURE_2D);
        tiles.push({ texture, x, y, w, h });
      }
    }
    this.tiles.set(image, tiles);
    return tiles;
  }

  draw(items: DrawItem[], options: DrawOptions) {
    const gl = this.gl;
    this.frameCount++;
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(...BACKGROUND, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!items.length) return;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1f(this.u.uDpr, options.dpr);
    for (const item of items) {
      const m = item.matrix;
      // Canvas pixels → clip space, then flip y.
      const sx = 2 / this.width, sy = -2 / this.height;
      gl.uniformMatrix3fv(this.u.uToClip, false, [
        m.a * sx, m.b * sy, 0,
        m.c * sx, m.d * sy, 0,
        m.e * sx - 1, m.f * sy + 1, 1,
      ]);
      const devicePerSource = Math.hypot(m.a, m.b);
      const exact = item.layer.density === 1;
      gl.bindSampler(0, options.crisp && exact ? this.sharp : this.smooth);
      gl.uniform1f(this.u.uAlpha, item.alpha);
      gl.uniform1f(this.u.uGrid, exact ? options.grid : 0);
      gl.uniform1f(this.u.uDevicePerSource, devicePerSource);
      if (item.tiles) {
        for (const tile of item.tiles) {
          gl.bindTexture(gl.TEXTURE_2D, this.tileTexture(tile));
          gl.uniform4f(this.u.uTile, tile.x, tile.y, tile.w, tile.h);
          gl.uniform4f(this.u.uUv, tile.offX / tile.dataW, tile.offY / tile.dataH, tile.w / tile.dataW, tile.h / tile.dataH);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        continue;
      }
      if (!item.layer.image) continue;
      gl.uniform4f(this.u.uUv, 0, 0, 1, 1);
      for (const tile of this.tilesFor(item.layer.image)) {
        gl.bindTexture(gl.TEXTURE_2D, tile.texture);
        gl.uniform4f(this.u.uTile, tile.x, tile.y, tile.w, tile.h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.disable(gl.BLEND);
    this.evictTiles();
  }
}

function sourceSize(image: CanvasImageSource) {
  if (image instanceof HTMLImageElement) return { width: image.naturalWidth, height: image.naturalHeight };
  if (image instanceof HTMLVideoElement) return { width: image.videoWidth, height: image.videoHeight };
  const sized = image as { width: number | SVGAnimatedLength; height: number | SVGAnimatedLength };
  return { width: Number(sized.width), height: Number(sized.height) };
}

// ---- Canvas2D fallback ---------------------------------------------------------------------

/** Device pixels per image pixel above which the pixel grid is drawn. */
export const GRID_ABOVE = 16;

export class Canvas2DDrawer implements ZoomDrawer {
  private ctx: CanvasRenderingContext2D;
  private checker: CanvasPattern | null = null;
  private checkerDpr = 0;
  private tileCanvases = new WeakMap<Tile, HTMLCanvasElement>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(width: number, height: number) {
    this.canvas.width = Math.max(1, width);
    this.canvas.height = Math.max(1, height);
  }

  prepare() {}
  release() {}

  draw(items: DrawItem[], options: DrawOptions) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#0b0b0c";
    ctx.fillRect(0, 0, W, H);
    for (const item of items) this.drawItem(item, options, W, H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  private drawItem({ layer, matrix, alpha, tiles }: DrawItem, options: DrawOptions, W: number, H: number) {
    const ctx = this.ctx;
    if (tiles) {
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = !options.crisp;
      ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      for (const tile of tiles) ctx.drawImage(this.tileCanvas(tile), tile.offX, tile.offY, tile.w, tile.h, tile.x, tile.y, tile.w, tile.h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    if (!layer.image) return;
    const image = layer.image;
    // Bounds of the image on screen.
    const corners = [[0, 0], [layer.width, 0], [0, layer.height], [layer.width, layer.height]].map(([x, y]) => matrix.transformPoint(new DOMPoint(x, y)));
    const x0 = Math.max(0, Math.min(...corners.map((p) => p.x)));
    const y0 = Math.max(0, Math.min(...corners.map((p) => p.y)));
    const x1 = Math.min(W, Math.max(...corners.map((p) => p.x)));
    const y1 = Math.min(H, Math.max(...corners.map((p) => p.y)));
    if (x1 <= x0 || y1 <= y0) return;
    ctx.globalAlpha = alpha;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.checkerPattern(options.dpr) ?? "#2b2b2e";
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    // Only the part of the source that lands on screen is drawn.
    const inverse = matrix.inverse();
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      const p = inverse.transformPoint(new DOMPoint(px, py));
      sx0 = Math.min(sx0, p.x); sy0 = Math.min(sy0, p.y);
      sx1 = Math.max(sx1, p.x); sy1 = Math.max(sy1, p.y);
    }
    sx0 = Math.max(0, Math.floor(sx0) - 1);
    sy0 = Math.max(0, Math.floor(sy0) - 1);
    sx1 = Math.min(layer.width, Math.ceil(sx1) + 1);
    sy1 = Math.min(layer.height, Math.ceil(sy1) + 1);
    if (sx1 <= sx0 || sy1 <= sy0) return;
    ctx.imageSmoothingEnabled = !(options.crisp && layer.density === 1);
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.drawImage(image, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0, sy0, sx1 - sx0, sy1 - sy0);
    if (options.grid > 0 && layer.density === 1) this.drawGrid(matrix, sx0, sy0, sx1, sy1, options.grid);
  }

  private drawGrid(matrix: DOMMatrix, sx0: number, sy0: number, sx1: number, sy1: number, alpha: number) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    const line = (ax: number, ay: number, bx: number, by: number) => {
      const a = matrix.transformPoint(new DOMPoint(ax, ay));
      const b = matrix.transformPoint(new DOMPoint(bx, by));
      ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
      ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    };
    for (let x = sx0; x <= sx1; x++) line(x, sy0, x, sy1);
    for (let y = sy0; y <= sy1; y++) line(sx0, y, sx1, y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(128, 128, 132, ${alpha})`;
    ctx.stroke();
  }

  private tileCanvas(tile: Tile) {
    let canvas = this.tileCanvases.get(tile);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = tile.dataW;
      canvas.height = tile.dataH;
      const pixels = new ImageData(new Uint8ClampedArray(tile.data.buffer as ArrayBuffer, tile.data.byteOffset, tile.data.byteLength), tile.dataW, tile.dataH);
      canvas.getContext("2d")!.putImageData(pixels, 0, 0);
      this.tileCanvases.set(tile, canvas);
    }
    return canvas;
  }

  private checkerPattern(dpr: number) {
    if (this.checker && this.checkerDpr === dpr) return this.checker;
    const size = Math.round(8 * dpr);
    const tile = document.createElement("canvas");
    tile.width = tile.height = size * 2;
    const t = tile.getContext("2d")!;
    t.fillStyle = "#2b2b2e";
    t.fillRect(0, 0, size * 2, size * 2);
    t.fillStyle = "#38383c";
    t.fillRect(0, 0, size, size);
    t.fillRect(size, size, size, size);
    this.checker = this.ctx.createPattern(tile, "repeat");
    this.checkerDpr = dpr;
    return this.checker;
  }
}
