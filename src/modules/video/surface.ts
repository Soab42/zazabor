import type { VideoSurface } from "./api";

/**
 * The video canvas: fetches decoded I420 frames from `cs://localhost/frame?after=N` and draws
 * them with WebGL2 (BT.709 limited range → RGB), letterboxed on black. The shader also applies
 * the picture effects of the side panel's Video tab (`VideoFx`, see `FxSurface`).
 */

// Custom schemes are exposed as http://<scheme>.localhost on Windows and <scheme>://localhost elsewhere.
const BASE = navigator.userAgent.includes("Windows") ? "http://cs.localhost/" : "cs://localhost/";

/** Picture effects. The defaults leave the picture untouched. */
export interface VideoFx {
  /** -1…1, added to the colour. */
  brightness: number;
  /** 0…2, around mid grey. */
  contrast: number;
  /** 0…2; 0 is black and white. */
  saturation: number;
  /** Degrees, -180…180. */
  hue: number;
  /** 0.5…2.5; above 1 lightens the mid tones. */
  gamma: number;
  /** 0…2 unsharp-mask strength. */
  sharpen: number;
  /** 0…1 mix amounts. */
  grayscale: number;
  sepia: number;
  invert: number;
  vignette: number;
  flipH: boolean;
  flipV: boolean;
  /** Clockwise, in 90° steps. */
  rotate: 0 | 90 | 180 | 270;
  /** 1…4. */
  zoom: number;
  /** -1…1: how far the picture is shifted, as a fraction of its zoomed half size. */
  panX: number;
  panY: number;
  /** Shows the picture at this width/height instead of its own; null keeps it. */
  aspect: number | null;
  /** Tone-maps washed-out HDR footage (ACES). */
  hdr: boolean;
}

export const DEFAULT_FX: Readonly<VideoFx> = {
  brightness: 0, contrast: 1, saturation: 1, hue: 0, gamma: 1, sharpen: 0, grayscale: 0, sepia: 0, invert: 0, vignette: 0,
  flipH: false, flipV: false, rotate: 0, zoom: 1, panX: 0, panY: 0, aspect: null, hdr: false,
};

/** A preview tile: the current frame is drawn into `canvas` through `fx`. */
export interface FxPreviewTile {
  canvas: HTMLCanvasElement;
  fx: Partial<VideoFx>;
}

export interface SurfaceFx {
  get(): VideoFx;
  /** Changes some effects and redraws the current frame. */
  set(patch: Partial<VideoFx>): void;
  reset(): void;
  /** Called after every change made through `set` / `reset`. */
  subscribe(fn: (fx: VideoFx) => void): () => void;
  /** A frame has been decoded (previews have something to show). */
  readonly hasFrame: boolean;
  /** Counts decoded frames (changes when a new one is drawn). */
  readonly frameCounter: number;
  /** Draws the current frame through each tile's effects, filling the tile (cropping). */
  renderPreviews(tiles: FxPreviewTile[]): boolean;
}

/**
 * Liquid Glass: player chrome floating over the picture bends and blurs the video under it, as
 * macOS 26 does. The canvas draws it (CSS can't refract): the picture renders into a mipmapped
 * texture, then a second pass samples it under each tracked element's rounded box, pulled inward
 * near the rim (the lens), blurred, with a little colour fringe at the edge. The elements draw
 * their own rim and highlights in CSS on top.
 */
export interface SurfaceGlass {
  /** Draws glass under `el` (its border box and border radius) while it shows; returns the undo. */
  track(el: HTMLElement): () => void;
  /** Off draws the picture alone, as before. */
  setEnabled(on: boolean): void;
  /** Tracked elements moved, resized or faded: redraw every frame for `ms`. */
  invalidate(ms?: number): void;
}

/** `createVideoSurface()` returns this; a plain `VideoSurface` is assignable from it. */
export interface FxSurface extends VideoSurface {
  readonly fx: SurfaceFx;
  readonly glass: SurfaceGlass;
}

/** The effects of a surface made by `createVideoSurface()`, if it has any. */
export function fxOf(surface: VideoSurface): SurfaceFx | undefined {
  return (surface as Partial<FxSurface>).fx;
}

/** The glass of a surface made by `createVideoSurface()`, if it has any. */
export function glassOf(surface: VideoSurface): SurfaceGlass | undefined {
  return (surface as Partial<FxSurface>).glass;
}

const VERTEX = `#version 300 es
in vec2 p; out vec2 uv; out vec2 q;
uniform vec2 scale, offset, flip; uniform mat2 rot;
void main(){
  vec2 d = vec2(p.x * .5 + .5, .5 - p.y * .5);
  q = d;
  if (flip.x > .5) d.x = 1. - d.x;
  if (flip.y > .5) d.y = 1. - d.y;
  uv = rot * (d - .5) + .5;
  gl_Position = vec4(p * scale + offset, 0, 1);
}`;
const FRAGMENT = `#version 300 es
precision highp float; in vec2 uv; in vec2 q; out vec4 o;
uniform sampler2D ty, tu, tv;
uniform vec2 texel; uniform mat3 hueM;
uniform float brightness, contrast, saturation, gamma, sharpen, gray, sepia, inv, vig, hdr;
const vec3 LUMA = vec3(.2126, .7152, .0722);
void main(){
  float y0 = texture(ty, uv).r;
  if (sharpen > 0.) {
    float n = texture(ty, uv + vec2(texel.x, 0)).r + texture(ty, uv - vec2(texel.x, 0)).r
            + texture(ty, uv + vec2(0, texel.y)).r + texture(ty, uv - vec2(0, texel.y)).r;
    y0 += sharpen * (4. * y0 - n) * .5;
  }
  float y = (y0 - .0627) * 1.164, u = texture(tu, uv).r - .5, v = texture(tv, uv).r - .5;
  vec3 c = clamp(vec3(y + 1.793 * v, y - .213 * u - .533 * v, y + 2.112 * u), 0., 1.);
  if (hdr > .5) {
    vec3 x = c * 1.2;
    c = clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.);
    c = mix(vec3(dot(c, LUMA)), c, 1.12);
  }
  c += brightness;
  c = (c - .5) * contrast + .5;
  c = mix(vec3(dot(c, LUMA)), c, saturation);
  c = hueM * c;
  c = pow(max(c, 0.), vec3(1. / gamma));
  c = mix(c, vec3(dot(c, LUMA)), gray);
  vec3 sp = vec3(dot(c, vec3(.393, .769, .189)), dot(c, vec3(.349, .686, .168)), dot(c, vec3(.272, .534, .131)));
  c = mix(c, sp, sepia);
  c = mix(c, 1. - c, inv);
  c *= 1. - vig * smoothstep(.3, .85, distance(q, vec2(.5)) * 1.42);
  o = vec4(clamp(c, 0., 1.), 1);
}`;

/** At most this many glass shapes at once (the bar, the top bar's pills, the side panels). */
const MAX_GLASS = 6;
const GLASS_VERTEX = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p, 0, 1); }`;
/**
 * The picture (a mipmapped texture), with each glass shape in rounded-box form: `rects` in canvas
 * pixels from the top left, `shape` = (corner radius, opacity, rim width, blur level).
 */
const GLASS_FRAGMENT = `#version 300 es
precision highp float; out vec4 o;
uniform sampler2D scene; uniform vec2 res; uniform int count;
uniform vec4 rects[${MAX_GLASS}]; uniform vec4 shape[${MAX_GLASS}];
const vec3 LUMA = vec3(.2126, .7152, .0722);
float box(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
vec3 blurred(vec2 uv, float lod){
  vec2 s = exp2(lod) * 1.25 / res;
  vec3 c = textureLod(scene, uv, lod).rgb * .2;
  c += textureLod(scene, uv + vec2( s.x, 0), lod).rgb * .1;
  c += textureLod(scene, uv + vec2(-s.x, 0), lod).rgb * .1;
  c += textureLod(scene, uv + vec2(0,  s.y), lod).rgb * .1;
  c += textureLod(scene, uv + vec2(0, -s.y), lod).rgb * .1;
  c += textureLod(scene, uv + s * .7, lod).rgb * .1;
  c += textureLod(scene, uv - s * .7, lod).rgb * .1;
  c += textureLod(scene, uv + vec2(s.x, -s.y) * .7, lod).rgb * .1;
  c += textureLod(scene, uv + vec2(-s.x, s.y) * .7, lod).rgb * .1;
  return c;
}
void main(){
  vec2 uv = gl_FragCoord.xy / res;
  vec3 c = textureLod(scene, uv, 0.).rgb;
  vec2 px = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  for (int i = 0; i < ${MAX_GLASS}; i++) {
    if (i >= count) break;
    vec4 r = rects[i]; vec4 g = shape[i];
    vec2 h = r.zw * .5;
    vec2 lp = px - r.xy - h;
    float rad = min(g.x, min(h.x, h.y));
    float d = box(lp, h, rad);
    if (d > 1.) continue;
    // The outward normal, from the distance field's slope.
    vec2 n = normalize(vec2(box(lp + vec2(1, 0), h, rad) - box(lp - vec2(1, 0), h, rad),
                            box(lp + vec2(0, 1), h, rad) - box(lp - vec2(0, 1), h, rad)) + 1e-5);
    float rim = max(g.z, 1.);
    float bend = pow(1. - clamp(-d / rim, 0., 1.), 2.4);
    // A convex lens: near the rim the picture comes from further inside, so it looks magnified.
    vec2 shift = -n * bend * rim * .85;
    vec2 at = uv + vec2(shift.x, -shift.y) / res;
    vec2 fringe = vec2(n.x, -n.y) * bend * 1.6 / res;
    vec3 glass = vec3(blurred(at + fringe, g.w).r, blurred(at, g.w).g, blurred(at - fringe, g.w).b);
    // Vibrancy and legibility: a little more colour, darker over bright picture (the symbols on
    // the glass are white), lifted toward the rim.
    float l = dot(glass, LUMA);
    glass = mix(vec3(l), glass, 1.3) * mix(.8, .56, smoothstep(.25, .85, l)) + .02 + bend * .06;
    float a = g.y * (1. - smoothstep(-1., 1., d));
    c = mix(c, glass, a);
  }
  o = vec4(c, 1);
}`;

const HEADER_BYTES = 16;
/** How long to wait before asking again after "no new frame" and after a failed request. */
const IDLE_DELAY_MS = 30;
const ERROR_DELAY_MS = 200;

interface Frame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Hue rotation in YIQ space as a column-major 3×3 matrix. */
export function hueMatrix(degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [
    0.299 + 0.701 * c + 0.168 * s, 0.299 - 0.299 * c - 0.328 * s, 0.299 - 0.3 * c + 1.25 * s,
    0.587 - 0.587 * c + 0.33 * s, 0.587 + 0.413 * c + 0.035 * s, 0.587 - 0.588 * c - 1.05 * s,
    0.114 - 0.114 * c - 0.497 * s, 0.114 - 0.114 * c + 0.292 * s, 0.114 + 0.886 * c - 0.203 * s,
  ];
}

/**
 * Where the picture goes in the canvas, in clip space: half-extents `scale` and centre `offset`.
 * `contain` letterboxes (the player), `cover` fills the canvas (preview tiles).
 */
export function fitGeometry(frameW: number, frameH: number, canvasW: number, canvasH: number, fx: VideoFx, mode: "contain" | "cover") {
  const turned = fx.rotate === 90 || fx.rotate === 270;
  const own = turned ? frameH / frameW : frameW / frameH;
  const aspect = fx.aspect ?? own;
  const canvas = canvasW / canvasH;
  const wide = mode === "contain" ? aspect > canvas : aspect < canvas;
  const sx = wide ? 1 : aspect / canvas;
  const sy = wide ? canvas / aspect : 1;
  const zoom = Math.min(4, Math.max(1, fx.zoom));
  return {
    scale: [sx * zoom, sy * zoom] as [number, number],
    offset: [fx.panX * sx * zoom, -fx.panY * sy * zoom] as [number, number],
  };
}

/** The shader program and its three plane textures on one GL context. */
function createRenderer(gl: WebGL2RenderingContext) {
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error("video:", gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, "p");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error("video:", gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    scale: at("scale"), offset: at("offset"), flip: at("flip"), rot: at("rot"), texel: at("texel"), hueM: at("hueM"),
    brightness: at("brightness"), contrast: at("contrast"), saturation: at("saturation"), gamma: at("gamma"),
    sharpen: at("sharpen"), gray: at("gray"), sepia: at("sepia"), inv: at("inv"), vig: at("vig"), hdr: at("hdr"),
  };
  const textures: WebGLTexture[] = [];
  ["ty", "tu", "tv"].forEach((name, unit) => {
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    gl.uniform1i(at(name), unit);
    textures.push(texture);
  });
  let uploadedSize = "";

  return {
    /** Uploads the planes (new storage when the size changed). */
    upload({ width: w, height: h, data }: Frame) {
      const key = `${w}x${h}`;
      const fresh = key !== uploadedSize;
      uploadedSize = key;
      const planes: [number, number, number][] = [
        [w, h, 0],
        [w / 2, h / 2, w * h],
        [w / 2, h / 2, w * h + (w * h) / 4],
      ];
      planes.forEach(([pw, ph, offset], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
        const pixels = data.subarray(offset, offset + pw * ph);
        if (fresh) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.RED, gl.UNSIGNED_BYTE, pixels);
      });
    },
    /** Clears to black and draws the uploaded frame of the given size. */
    draw(w: number, h: number, fx: VideoFx, mode: "contain" | "cover") {
      const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
      gl.useProgram(program);
      const { scale, offset } = fitGeometry(w, h, cw, ch, fx, mode);
      const a = (fx.rotate * Math.PI) / 180;
      const c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
      gl.uniform2f(u.scale, scale[0], scale[1]);
      gl.uniform2f(u.offset, offset[0], offset[1]);
      gl.uniform2f(u.flip, fx.flipH ? 1 : 0, fx.flipV ? 1 : 0);
      gl.uniformMatrix2fv(u.rot, false, [c, -s, s, c]);
      gl.uniform2f(u.texel, 1 / w, 1 / h);
      gl.uniformMatrix3fv(u.hueM, false, hueMatrix(fx.hue));
      gl.uniform1f(u.brightness, fx.brightness);
      gl.uniform1f(u.contrast, fx.contrast);
      gl.uniform1f(u.saturation, fx.saturation);
      gl.uniform1f(u.gamma, Math.max(0.1, fx.gamma));
      gl.uniform1f(u.sharpen, fx.sharpen);
      gl.uniform1f(u.gray, fx.grayscale);
      gl.uniform1f(u.sepia, fx.sepia);
      gl.uniform1f(u.inv, fx.invert);
      gl.uniform1f(u.vig, fx.vignette);
      gl.uniform1f(u.hdr, fx.hdr ? 1 : 0);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    clear() {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    dispose() {
      for (const texture of textures) gl.deleteTexture(texture);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    },
  };
}

/** Glass shapes for one draw: rounded boxes in canvas pixels and their look (see GLASS_FRAGMENT). */
interface GlassShapes {
  count: number;
  rects: Float32Array;
  shape: Float32Array;
}

/** The texture unit of the picture the glass samples (the video planes use 0–2). */
const SCENE_UNIT = 3;

/** Liquid Glass's second pass: the picture as a mipmapped texture, then the glass over it. */
function createGlassPass(gl: WebGL2RenderingContext) {
  const program = gl.createProgram()!;
  for (const [type, source] of [[gl.VERTEX_SHADER, GLASS_VERTEX], [gl.FRAGMENT_SHADER, GLASS_FRAGMENT]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error("video glass:", gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, "p");
  gl.linkProgram(program);
  const ok = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
  if (!ok) console.error("video glass:", gl.getProgramInfoLog(program));
  const at = (name: string) => gl.getUniformLocation(program, name);
  const u = { scene: at("scene"), res: at("res"), count: at("count"), rects: at("rects"), shape: at("shape") };
  const texture = gl.createTexture()!;
  const framebuffer = gl.createFramebuffer()!;
  let size = "";

  return {
    ok,
    /** Sends the next draw into the picture's texture (sized like the canvas). */
    begin() {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      gl.activeTexture(gl.TEXTURE0 + SCENE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      if (`${w}x${h}` !== size) {
        size = `${w}x${h}`;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      }
    },
    /** Draws the picture onto the canvas with glass over the shapes. */
    finish({ count, rects, shape }: GlassShapes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0 + SCENE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.useProgram(program);
      gl.uniform1i(u.scene, SCENE_UNIT);
      gl.uniform2f(u.res, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1i(u.count, count);
      gl.uniform4fv(u.rects, rects);
      gl.uniform4fv(u.shape, shape);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    },
  };
}

/** Events after which a tracked element's box or opacity may still be changing. */
const GLASS_MOTION = ["transitionrun", "transitionend", "transitioncancel", "animationstart", "animationend"];

export function createVideoSurface(): FxSurface {
  const el = document.createElement("canvas");
  el.style.cssText = "display:block;width:100%;height:100%;background:#000";
  const pixelSize = { width: 1, height: 1 };

  const gl = el.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: false });
  if (!gl) console.error("video: WebGL2 is not available");

  const renderer = gl ? createRenderer(gl) : null;
  const glassPass = gl ? createGlassPass(gl) : null;
  const tracked = new Set<HTMLElement>();
  let glassOn = true;
  let liveUntil = 0;
  let liveFrame = 0;
  let last: Frame | null = null;
  let frameCounter = 0;
  let fx: VideoFx = { ...DEFAULT_FX };
  const fxListeners = new Set<(fx: VideoFx) => void>();

  /** Uploads the planes if asked and draws the frame letterboxed with the current effects. */
  function draw(frame: Frame, upload: boolean) {
    if (!renderer) return;
    if (upload) renderer.upload(frame);
    const glass = glassShapes();
    if (!glass || !glassPass) return renderer.draw(frame.width, frame.height, fx, "contain");
    glassPass.begin();
    renderer.draw(frame.width, frame.height, fx, "contain");
    glassPass.finish(glass);
  }

  /** Where the tracked elements are over the canvas now, in its pixels; null when none shows. */
  function glassShapes(): GlassShapes | null {
    if (!glassOn || !glassPass?.ok || tracked.size === 0) return null;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    const sx = el.width / box.width, sy = el.height / box.height;
    const rects = new Float32Array(MAX_GLASS * 4);
    const shape = new Float32Array(MAX_GLASS * 4);
    let count = 0;
    for (const item of tracked) {
      if (count === MAX_GLASS) break;
      if (!item.isConnected) continue;
      const r = item.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
      const style = getComputedStyle(item);
      if (style.visibility === "hidden") continue;
      const opacity = Number(style.opacity) * (item.parentElement ? Number(getComputedStyle(item.parentElement).opacity) : 1);
      if (!(opacity > 0.01)) continue;
      // The box may be scaled by a transform; its radius scales with it.
      const k = item.offsetHeight ? r.height / item.offsetHeight : 1;
      const radius = (parseFloat(style.borderTopLeftRadius) || 0) * k * sy;
      const rim = (parseFloat(style.getPropertyValue("--lg-rim")) || 14) * k * sy;
      const blur = parseFloat(style.getPropertyValue("--lg-blur")) || 2.5;
      rects.set([(r.left - box.left) * sx, (r.top - box.top) * sy, r.width * sx, r.height * sy], count * 4);
      shape.set([radius, opacity, rim, blur], count * 4);
      count++;
    }
    return count ? { count, rects, shape } : null;
  }

  /** Redraws every frame until `liveUntil` (the glass follows its elements while they animate). */
  function invalidate(ms = 300) {
    liveUntil = Math.max(liveUntil, performance.now() + ms);
    if (!liveFrame && !disposed) liveFrame = requestAnimationFrame(tick);
  }
  function tick() {
    liveFrame = 0;
    if (disposed) return;
    if (last) draw(last, false);
    if (performance.now() < liveUntil) liveFrame = requestAnimationFrame(tick);
  }

  const glassApi: SurfaceGlass = {
    track(item) {
      tracked.add(item);
      const resize = new ResizeObserver(() => invalidate(60));
      resize.observe(item);
      const moving = (e: Event) => {
        if (e.target === item) invalidate(450);
      };
      for (const type of GLASS_MOTION) item.addEventListener(type, moving);
      invalidate(60);
      return () => {
        tracked.delete(item);
        resize.disconnect();
        for (const type of GLASS_MOTION) item.removeEventListener(type, moving);
        invalidate(60);
      };
    },
    setEnabled(on) {
      if (on === glassOn) return;
      glassOn = on;
      invalidate(60);
    },
    invalidate,
  };

  // The backing store follows the element's size in device pixels.
  const observer = new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(el.clientWidth * dpr));
    const height = Math.max(1, Math.round(el.clientHeight * dpr));
    if (width === el.width && height === el.height) return;
    el.width = width;
    el.height = height;
    pixelSize.width = width;
    pixelSize.height = height;
    if (last) draw(last, false);
    else renderer?.clear();
  });
  observer.observe(el);

  // Preview tiles of the Video tab draw on a small context of their own, made on first use.
  let preview: {
    canvas: HTMLCanvasElement;
    gl: WebGL2RenderingContext;
    renderer: ReturnType<typeof createRenderer>;
    uploaded: Frame | null;
  } | null = null;

  function renderPreviews(tiles: FxPreviewTile[]): boolean {
    const frame = last;
    if (!frame || tiles.length === 0) return false;
    if (!preview) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true });
      if (!context) return false;
      preview = { canvas, gl: context, renderer: createRenderer(context), uploaded: null };
    }
    if (preview.uploaded !== frame) {
      preview.renderer.upload(frame);
      preview.uploaded = frame;
    }
    for (const tile of tiles) {
      const target = tile.canvas.getContext("2d");
      if (!target) continue;
      const { width, height } = tile.canvas;
      if (preview.canvas.width !== width || preview.canvas.height !== height) {
        preview.canvas.width = width;
        preview.canvas.height = height;
      }
      preview.renderer.draw(frame.width, frame.height, { ...DEFAULT_FX, ...tile.fx }, "cover");
      target.drawImage(preview.canvas, 0, 0);
    }
    return true;
  }

  const fxApi: SurfaceFx = {
    get: () => ({ ...fx }),
    set(patch) {
      fx = { ...fx, ...patch };
      if (last) draw(last, false);
      for (const fn of fxListeners) fn({ ...fx });
    },
    reset() {
      fxApi.set({ ...DEFAULT_FX });
    },
    subscribe(fn) {
      fxListeners.add(fn);
      return () => fxListeners.delete(fn);
    },
    get hasFrame() {
      return last !== null;
    },
    get frameCounter() {
      return frameCounter;
    },
    renderPreviews,
  };

  let running = false;
  let disposed = false;
  let abort: AbortController | null = null;
  /** Bumped on every start() so a loop from an earlier start() exits instead of doubling up. */
  let generation = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function pump(mine: number) {
    let after = 0;
    while (running && mine === generation) {
      let response: Response;
      try {
        abort = new AbortController();
        response = await fetch(`${BASE}frame?after=${after}`, { cache: "no-store", signal: abort.signal });
      } catch {
        if (running && mine === generation) await sleep(ERROR_DELAY_MS);
        continue;
      }
      if (response.status !== 200) {
        // 204: nothing new (the request already waited); anything else: back off.
        await sleep(response.status === 204 ? IDLE_DELAY_MS : ERROR_DELAY_MS);
        continue;
      }
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch {
        await sleep(ERROR_DELAY_MS);
        continue;
      }
      if (!running || mine !== generation || buffer.byteLength < HEADER_BYTES) continue;
      const [width, height, , counter] = new Uint32Array(buffer, 0, 4);
      // A new file restarts nothing (the counter only grows), but guard against a stale reply.
      after = counter;
      if (!width || !height || buffer.byteLength < HEADER_BYTES + (width * height * 3) / 2) continue;
      last = { width, height, data: new Uint8Array(buffer, HEADER_BYTES) };
      frameCounter = counter;
      draw(last, true);
    }
  }

  return {
    el,
    fx: fxApi,
    glass: glassApi,
    start() {
      if (running || disposed) return;
      running = true;
      void pump(++generation);
    },
    stop() {
      running = false;
      abort?.abort();
    },
    get pixelSize() {
      return pixelSize;
    },
    clear() {
      last = null;
      renderer?.clear();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      abort?.abort();
      observer.disconnect();
      cancelAnimationFrame(liveFrame);
      tracked.clear();
      last = null;
      fxListeners.clear();
      glassPass?.dispose();
      renderer?.dispose();
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      if (preview) {
        preview.renderer.dispose();
        preview.gl.getExtension("WEBGL_lose_context")?.loseContext();
        preview = null;
      }
    },
  };
}
