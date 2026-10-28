import { effectAt, valueAt, ease, staggerStart, type Anim, type Feel } from "./ease";
import { fieldValue, roleOf, TEXT_FLOORS, type ArtLayer, type BackgroundLayer, type ChartLayer, type DeviceLayer, type FxLayer, type Gradient, type GroupLayer, type ImageLayer, type IconLayer, type Layer, type Paint, type PathLayer, type QrLayer, type RectLayer, type Template, type TextAnimator, type TextLayer } from "./format";
import { resolve, shapeOf, type Box } from "./layout";
import { fitText, formatNumber, graphemes, parseNumber, wordsOf, type Fitted } from "./textfit";
import { mix, rgbOf, themeColor, type Grade, type Theme } from "./brand";
import { faceStack, familyStack } from "./fonts";
import { ICONS } from "./icons";
import { drawArt as drawArtwork, type ArtEnv } from "./art";
import { encodeQr, type QrCode } from "./qr";
import { backgroundState, drawBackgroundFallback, renderBackground } from "./background";
import { barGrowth, chartValues, morphPath, particleAt, particleCount, particleSeeds, tickClock, type ParticleKind } from "./kinetic";

/**
 * Draws a motion template at one moment with Canvas 2D: fonts and Bangla shaping come from the
 * browser, shapes are Path2D, and effects are gradients, shadows and filters. The engine uploads
 * the result as one layer of the compositor (render.ts), so preview and export draw the same.
 */

/** Something a media slot shows. */
export type Picture = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

/** A logo's outline for the line-draw reveal: paths in the picture's own 0…1 box, and their lengths. */
export interface Outline {
  paths: Path2D[];
  /** Each path's length in the 0…1 box. */
  lengths: number[];
  /** The picture's aspect (width / height), so the outline sits where the picture does. */
  aspect: number;
}

export interface Scene {
  template: Template;
  values: Record<string, string>;
  theme: Theme;
  /** Slot field id → picture (null: empty). */
  pictures: Map<string, Picture | null>;
  outlines: Map<string, Outline | null>;
  /** Field defaults in Bangla. */
  bangla?: boolean;
  /** Texts and pictures were ungrouped into clips of their own: only the graphics draw. */
  graphicsOnly?: boolean;
  /** Empty slots show a placeholder (the editor and the template browser, never an export). */
  placeholders?: boolean;
  /** A preview: live backgrounds render at half size. */
  draft?: boolean;
}

/** Caches that live with one clip's renderer (text layouts and measurements). */
export interface Memory {
  texts: Map<string, { key: string; fit: Fitted; units: Unit[][]; ascent: number; descent: number; widths: number[] }>;
}

interface Unit {
  text: string;
  x: number;
  w: number;
  /** Index among all animated units of the layer (spaces aren't animated). */
  index: number;
}

export const newMemory = (): Memory => ({ texts: new Map() });

interface Env {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  S: number;
  t: number;
  /** 0…1 along the whole clip (slow idle motion). */
  idle: number;
  feel: Feel;
  scene: Scene;
  mem: Memory;
  hits: Box[] | null;
  /** The shadow offset of the layer being drawn when its shadow follows the light (pixels). */
  shadowShift?: [number, number];
}

let filterSupport: boolean | undefined;

/** Canvas `filter` (blur) works here; WebKit versions without it blur by scaling instead. */
function canFilter(ctx: CanvasRenderingContext2D): boolean {
  if (filterSupport === undefined) {
    filterSupport = typeof (ctx as { filter?: unknown }).filter === "string";
    if (filterSupport) {
      ctx.save();
      ctx.filter = "blur(2px)";
      filterSupport = ctx.filter === "blur(2px)";
      ctx.restore();
    }
  }
  return filterSupport;
}

// ---- paints

/** A theme colour or hex, with an optional "/alpha", as a CSS colour. */
export function color(p: string, theme: Theme): string {
  const { hex, alpha } = themeColor(p, theme);
  if (!/^#[0-9a-f]{6}$/i.test(hex) || alpha >= 1) return hex;
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function paint(ctx: CanvasRenderingContext2D, p: Paint, theme: Theme, box: Box): string | CanvasGradient {
  if (typeof p === "string") return color(p, theme);
  return gradient(ctx, p, theme, box);
}

function gradient(ctx: CanvasRenderingContext2D, g: Gradient, theme: Theme, box: Box): CanvasGradient {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let grad: CanvasGradient;
  if (g.kind === "radial") {
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(box.w, box.h) / 2);
  } else {
    const a = ((g.angle ?? 0) * Math.PI) / 180;
    const r = (Math.abs(Math.cos(a)) * box.w + Math.abs(Math.sin(a)) * box.h) / 2;
    grad = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  for (const [at, c] of g.stops) grad.addColorStop(Math.max(0, Math.min(1, at)), color(c, theme));
  return grad;
}

function radiusOf(r: number | "theme" | "pill" | undefined, box: Box, theme: Theme, S: number): number {
  const half = Math.min(box.w, box.h) / 2;
  if (r === "pill") return half;
  if (r === "theme") return Math.min(half, theme.radius * Math.min(half, S * 0.06));
  return Math.min(half, (r ?? 0) * S);
}

// ---- path lengths

const lengths = new Map<string, number>();
let measurer: SVGPathElement | null = null;

/** A path's length in its own units (SVG measures it; cached). */
function pathLength(d: string): number {
  let len = lengths.get(d);
  if (len !== undefined) return len;
  try {
    measurer ??= document.createElementNS("http://www.w3.org/2000/svg", "path");
    measurer.setAttribute("d", d);
    len = measurer.getTotalLength();
  } catch {
    len = 400;
  }
  lengths.set(d, len);
  return len;
}

// ---- drawing

const at = (a: Anim | undefined, env: Env, fallback: number) => valueAt(a, env.t, fallback, env.feel);

/** The template's light at this moment (canvas fractions), if it has one. */
function lightOf(env: Env): [number, number] | undefined {
  const l = env.scene.template.light;
  return l ? [at(l.x, env, 0.25), at(l.y, env, 0)] : undefined;
}

/**
 * Part of a scene: its top-level layers from `from` up to (not including) `to`, and whether the
 * grade goes on after them. Export's motion blur draws the still layers at the bottom once and
 * only the rest for each moment.
 */
export interface ScenePart {
  from: number;
  to: number;
  grade: boolean;
}

/** Draws the template at template time `t` onto `ctx` (W×H, cleared by the caller); `part`: only some of it. */
export function drawScene(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, idle: number, scene: Scene, mem: Memory, hits: Box[] | null = null, part?: ScenePart) {
  const env: Env = { ctx, W, H, S: Math.min(W, H), t, idle, feel: scene.theme.motion, scene, mem, hits };
  ctx.save();
  ctx.textBaseline = "alphabetic";
  const layers = part ? scene.template.layers.slice(part.from, part.to) : scene.template.layers;
  for (const layer of layers) drawLayer(env, layer);
  ctx.restore();
  // A template look's finishing grade (not over video: lower thirds keep the footage's colours).
  if (scene.theme.grade && !scene.template.overlay && (part?.grade ?? true)) drawGrade(ctx, scene.theme.grade);
}

/** Whether anything moves between two template times (export draws motion blur only then). */
export function moving(template: Template, t0: number, t1: number): boolean {
  const changes = (a: Anim | undefined) => Array.isArray(a) && a.length > 1 && a[0][0] < t1 && a[a.length - 1][0] > t0;
  const check = (layers: Layer[]): boolean => layers.some((l) =>
    changes(l.dx) || changes(l.dy) || changes(l.scale) || changes(l.rotate) || changes(l.turnY)
    || (l.kind === "text" && !!l.animate && ["dx", "dy", "scale", "rotate"].some((k) => k in l.animate!.from) && t1 > l.animate.t && t0 < l.animate.t + l.animate.duration + 2)
    || (l.kind === "group" && check(l.children)));
  return check(template.layers);
}

function drawLayer(env: Env, l: Layer) {
  const { ctx, S, t } = env;
  if (l.time && (t < l.time[0] || t >= l.time[1])) return;
  if (env.scene.graphicsOnly && (l.kind === "text" || (l.kind === "image" && !!l.slot))) return;
  if (l.ifEmpty && env.scene.pictures.get(l.ifEmpty)) return;
  if (l.ifFilled && !env.scene.pictures.get(l.ifFilled)) return;
  const opacity = effectAt(l.opacity, env.t, 1, env.feel);
  if (opacity <= 0.002) return;
  const box = resolve(l.frame, env.W, env.H);
  const dx = at(l.dx, env, 0) * S, dy = (at(l.dy, env, 0) + (l.idle?.dy ?? 0) * env.idle) * S;
  const scale = at(l.scale, env, 1) * (1 + (l.idle?.scale ?? 0) * env.idle);
  const rotate = at(l.rotate, env, 0) + (l.idle?.rotate ?? 0) * env.idle;
  if (scale <= 0.001) return;
  const blur = Math.max(0, effectAt(l.blur, env.t, 0, env.feel) * S);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.save();
  ctx.globalAlpha *= opacity;
  if (l.blend) ctx.globalCompositeOperation = l.blend;
  ctx.translate(cx + dx, cy + dy);
  if (rotate) ctx.rotate((rotate * Math.PI) / 180);
  if (scale !== 1) ctx.scale(scale, scale);
  const turn = at(l.turnY, env, 0);
  if (turn) {
    // Turning on the upright axis: narrower by the cosine, and sheared a little so the near edge
    // reads as closer (a stand-in for perspective that 2D canvas can't do).
    const a = (turn * Math.PI) / 180;
    const c = Math.cos(a);
    if (Math.abs(c) < 0.004) {
      ctx.restore();
      return;
    }
    ctx.transform(c, Math.sin(a * 2) * 0.1, 0, 1, 0, 0);
  }
  ctx.translate(-cx, -cy);
  if (l.reveal) {
    const v = Math.max(0, Math.min(1, at(l.reveal.v, env, 1)));
    if (v <= 0.001) {
      ctx.restore();
      return;
    }
    if (v < 0.999) {
      revealPath(ctx, l.reveal.from, box, v, S * 0.6);
      ctx.clip();
    }
  }
  if (env.hits && (l.kind === "text" || l.kind === "image")) {
    env.hits.push({ x: box.x + dx - (box.w * (scale - 1)) / 2, y: box.y + dy - (box.h * (scale - 1)) / 2, w: box.w * scale, h: box.h * scale });
  }
  const outerShift = env.shadowShift;
  const light = l.shadow?.follow ? lightOf(env) : undefined;
  if (light && l.shadow) {
    // Away from the light, as far as the shadow's own offset.
    const vx = cx + dx - light[0] * env.W, vy = cy + dy - light[1] * env.H;
    const len = Math.hypot(vx, vy) || 1;
    env.shadowShift = [(vx / len) * l.shadow.y * S, (vy / len) * l.shadow.y * S];
  }
  const content = () => drawContent(env, l, box);
  if (l.sheen || l.lightWrap || (blur > 0.4 && !canFilter(ctx))) offscreen(env, l, box, blur, content);
  else {
    if (blur > 0.4) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    content();
  }
  env.shadowShift = outerShift;
  ctx.restore();
}

/** The part of a layer a wipe shows at `v` (0…1), as the current path; `pad` reaches past the box for shadows. */
function revealPath(ctx: CanvasRenderingContext2D, from: NonNullable<Layer["reveal"]>["from"], box: Box, v: number, pad: number) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.beginPath();
  switch (from) {
    case "left": ctx.rect(box.x - pad, box.y - pad, pad + box.w * v, box.h + 2 * pad); return;
    case "right": ctx.rect(box.x + box.w * (1 - v), box.y - pad, box.w * v + pad, box.h + 2 * pad); return;
    case "top": ctx.rect(box.x - pad, box.y - pad, box.w + 2 * pad, pad + box.h * v); return;
    case "center": ctx.rect(cx - (box.w * v) / 2, cy - (box.h * v) / 2, box.w * v, box.h * v); return;
    case "circle": {
      // An iris opening from the centre until it reaches the corners (and the shadows past them).
      ctx.arc(cx, cy, (Math.hypot(box.w, box.h) / 2 + pad * 0.5) * v, 0, Math.PI * 2);
      return;
    }
    case "diagonal": {
      // Left to right with an edge leaning forward: the bottom leads by `lean`.
      const lean = box.h * 0.45;
      const edge = box.x - lean + (box.w + lean + pad) * v;
      const at = (y: number) => edge + (lean * (box.y + box.h - y)) / box.h;
      const y0 = box.y - pad, y1 = box.y + box.h + pad;
      ctx.moveTo(box.x - pad - lean * 3, y0);
      ctx.lineTo(at(y0) - lean, y0);
      ctx.lineTo(at(y1) - lean, y1);
      ctx.lineTo(box.x - pad - lean * 3, y1);
      ctx.closePath();
      return;
    }
    case "blinds": {
      // Six strips opening one after another, top to bottom.
      const n = 6, step = 0.07, strip = box.h / n;
      for (let i = 0; i < n; i++) {
        const u = Math.max(0, Math.min(1, (v - step * i) / (1 - step * (n - 1))));
        if (u <= 0) continue;
        const y = box.y + strip * i - (i === 0 ? pad : 0);
        const h = strip * u + (i === 0 ? pad : 0) + (i === n - 1 && u >= 1 ? pad : 0);
        ctx.rect(box.x - pad, y, box.w + 2 * pad, h + 0.5);
      }
      return;
    }
    default: ctx.rect(box.x - pad, box.y + box.h * (1 - v), box.w + 2 * pad, box.h * v + pad);
  }
}

const pool: HTMLCanvasElement[] = [];
let poolDepth = 0;

/** Draws a layer on a scratch canvas first: for a sheen across it, or a blur where filters are missing. */
function offscreen(env: Env, l: Layer, box: Box, blur: number, content: () => void) {
  const { ctx, W, H, S } = env;
  const scratch = (pool[poolDepth] ??= document.createElement("canvas"));
  poolDepth++;
  try {
    if (scratch.width !== W || scratch.height !== H) {
      scratch.width = W;
      scratch.height = H;
    }
    const g = scratch.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.setTransform(ctx.getTransform());
    g.textBaseline = "alphabetic";
    const outer = env.ctx;
    env.ctx = g;
    content();
    env.ctx = outer;
    if (l.sheen) {
      const p = at(l.sheen.at, env, -1);
      if (p > -0.2 && p < 1.2) {
        const angle = ((l.sheen.angle ?? 20) * Math.PI) / 180;
        const width = (l.sheen.width ?? 0.18) * Math.max(box.w, box.h);
        const span = box.w + box.h;
        const cx = box.x - span / 2 + (span * 2) * p, cy = box.y + box.h / 2;
        const ux = Math.cos(angle), uy = Math.sin(angle);
        const grad = g.createLinearGradient(cx - ux * width, cy - uy * width, cx + ux * width, cy + uy * width);
        const strength = l.sheen.strength ?? 0.55;
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(0.5, `rgba(255,255,255,${strength})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.globalCompositeOperation = "source-atop";
        g.fillStyle = grad;
        g.fillRect(box.x - span, box.y - span, box.w + 2 * span, box.h + 2 * span);
        g.globalCompositeOperation = "source-over";
      }
    }
    if (l.lightWrap) lightWrap(env, g, scratch, l.lightWrap);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (blur > 0.4) {
      if (canFilter(ctx)) {
        ctx.filter = `blur(${blur.toFixed(1)}px)`;
        ctx.drawImage(scratch, 0, 0);
      } else {
        // No canvas filters (WebKitGTK): halve step by step, each step averaging (one big step
        // would skip pixels and band), then stretch back up, which blurs about as much.
        const f = Math.max(1, Math.min(32, blur / (S * 0.004)));
        let src = scratch, sw = W, sh = H;
        for (let level = 0; f / 2 ** level > 1.4 && level < 6; level++) {
          const nw = Math.max(1, Math.round(sw / 2)), nh = Math.max(1, Math.round(sh / 2));
          const small = (pool[poolDepth + level] ??= document.createElement("canvas"));
          small.width = nw;
          small.height = nh;
          const sg = small.getContext("2d")!;
          sg.imageSmoothingQuality = "high";
          sg.drawImage(src, 0, 0, sw, sh, 0, 0, nw, nh);
          src = small;
          sw = nw;
          sh = nh;
        }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, 0, 0, sw, sh, 0, 0, W, H);
      }
    } else ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  } finally {
    poolDepth--;
  }
}

/**
 * Light wrap: the light behind spilling a little way onto the layer's edges. Everything but the
 * layer is filled with the light, blurred, and kept only where the layer is.
 */
function lightWrap(env: Env, g: CanvasRenderingContext2D, layer: HTMLCanvasElement, wrap: NonNullable<Layer["lightWrap"]>) {
  const { W, H, S } = env;
  const halo = (pool[poolDepth] ??= document.createElement("canvas"));
  if (halo.width !== W || halo.height !== H) {
    halo.width = W;
    halo.height = H;
  }
  const hg = halo.getContext("2d")!;
  hg.setTransform(1, 0, 0, 1, 0, 0);
  hg.globalCompositeOperation = "source-over";
  hg.clearRect(0, 0, W, H);
  hg.fillStyle = color((wrap.color as string) ?? "@primary", env.scene.theme);
  hg.fillRect(0, 0, W, H);
  hg.globalCompositeOperation = "destination-out";
  hg.drawImage(layer, 0, 0);
  const px = Math.max(1, (wrap.width ?? 0.02) * S);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = "source-atop";
  g.globalAlpha = Math.max(0, Math.min(1, wrap.amount ?? 0.5));
  if (canFilter(g)) {
    g.filter = `blur(${px.toFixed(1)}px)`;
    g.drawImage(halo, 0, 0);
  } else {
    // No filters: down and back up, which softens about as much.
    const f = Math.max(2, Math.min(32, Math.round(px / 2)));
    const small = (pool[poolDepth + 1] ??= document.createElement("canvas"));
    small.width = Math.max(1, Math.round(W / f));
    small.height = Math.max(1, Math.round(H / f));
    const sg = small.getContext("2d")!;
    sg.imageSmoothingQuality = "high";
    sg.drawImage(halo, 0, 0, small.width, small.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(small, 0, 0, W, H);
  }
  g.restore();
}

function setShadow(env: Env, l: Layer) {
  const { ctx, S } = env;
  const theme = env.scene.theme;
  if (l.glow) {
    ctx.shadowColor = color(typeof l.glow.color === "string" ? l.glow.color : "@primary", theme);
    ctx.shadowBlur = l.glow.blur * S;
    ctx.shadowOffsetY = 0;
  } else if (l.shadow) {
    ctx.shadowColor = color(typeof l.shadow.color === "string" ? l.shadow.color : "#000000/0.4", theme);
    ctx.shadowBlur = l.shadow.blur * S;
    const shift = l.shadow.follow ? env.shadowShift : undefined;
    ctx.shadowOffsetX = shift ? shift[0] : 0;
    ctx.shadowOffsetY = shift ? shift[1] : l.shadow.y * S;
  }
}

function drawContent(env: Env, l: Layer, box: Box) {
  switch (l.kind) {
    case "rect": case "ellipse": return drawRect(env, l, box);
    case "path": return drawPath(env, l, box);
    case "text": return drawText(env, l, box);
    case "image": return drawImage(env, l, box);
    case "icon": return drawIcon(env, l, box);
    case "group": return drawGroup(env, l, box);
    case "fx": return drawFx(env, l, box);
    case "device": return drawDevice(env, l, box);
    case "art": return drawArt(env, l, box);
    case "chart": return drawChart(env, l, box);
    case "qr": return drawQr(env, l, box);
    case "background": return drawBackground(env, l, box);
  }
}

function drawBackground(env: Env, l: BackgroundLayer, box: Box) {
  const { ctx } = env;
  const state = backgroundState(l, env.t, env.scene.theme, lightOf(env));
  // Where the box lands on the canvas (a background isn't turned, so scale and offset will do).
  const m = ctx.getTransform();
  const px = { x: m.a * box.x + m.e, y: m.d * box.y + m.f, w: Math.abs(m.a) * box.w, h: Math.abs(m.d) * box.h };
  const k = env.scene.draft ? 0.5 : 1;
  let below: Parameters<typeof renderBackground>[4];
  if (state.preset === "glass" && state.over) {
    const c = ctx.canvas;
    below = { source: c, rect: [px.x / c.width, px.y / c.height, px.w / c.width, px.h / c.height] };
  }
  const out = renderBackground(state, px.w * k, px.h * k, env.t, below);
  if (out) ctx.drawImage(out, 0, 0, out.width, out.height, box.x, box.y, box.w, box.h);
  else drawBackgroundFallback(ctx, state, box.x, box.y, box.w, box.h);
}

function drawGroup(env: Env, l: GroupLayer, box: Box) {
  const { ctx } = env;
  if (l.clip) {
    ctx.save();
    ctx.beginPath();
    if (l.clip === "ellipse") ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
    else ctx.roundRect(box.x, box.y, box.w, box.h, l.clip === "round" ? radiusOf("theme", box, env.scene.theme, env.S) : 0);
    ctx.clip();
  }
  for (const c of l.children) drawLayer(env, c);
  if (l.clip) ctx.restore();
}

function drawRect(env: Env, l: RectLayer, box: Box) {
  const { ctx, S } = env;
  const theme = env.scene.theme;
  ctx.beginPath();
  if (l.kind === "ellipse") ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
  else ctx.roundRect(box.x, box.y, box.w, box.h, radiusOf(l.radius, box, theme, S));
  if (l.fill) {
    setShadow(env, l);
    ctx.fillStyle = paint(ctx, l.fill, theme, box);
    ctx.fill();
    ctx.shadowColor = "transparent";
  }
  if (l.stroke) {
    ctx.strokeStyle = paint(ctx, l.stroke, theme, box);
    ctx.lineWidth = (l.strokeWidth ?? 0.004) * S;
    ctx.stroke();
  }
}

function drawPath(env: Env, l: PathLayer, box: Box) {
  const { ctx, S } = env;
  const theme = env.scene.theme;
  const [vw, vh] = l.view ?? [100, 100];
  const sx = box.w / vw, sy = box.h / vh;
  const d = l.morph ? morphPath(l.d, l.morph.to, Math.max(0, Math.min(1, at(l.morph.v, env, 0)))) : l.d;
  const path = new Path2D();
  path.addPath(new Path2D(d), new DOMMatrix([sx, 0, 0, sy, box.x, box.y]));
  if (l.fill) {
    setShadow(env, l);
    ctx.fillStyle = paint(ctx, l.fill, theme, box);
    ctx.fill(path);
    ctx.shadowColor = "transparent";
  }
  if (l.stroke) {
    const draw = Math.max(0, Math.min(1, at(l.draw, env, 1)));
    if (draw <= 0.001) return;
    ctx.strokeStyle = paint(ctx, l.stroke, theme, box);
    ctx.lineWidth = (l.strokeWidth ?? 0.006) * S;
    ctx.lineCap = l.cap ?? "round";
    ctx.lineJoin = "round";
    if (draw < 0.999) {
      const len = pathLength(l.d) * (sx + sy) / 2;
      ctx.setLineDash([len * draw, len + 1]);
    }
    if (l.glow) setShadow(env, l);
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.shadowColor = "transparent";
  }
}

function drawIcon(env: Env, l: IconLayer, box: Box) {
  const { ctx } = env;
  const id = l.field ? fieldValue(env.scene.template, env.scene.values, l.field) : l.icon ?? "";
  const d = ICONS[id] ?? ICONS.sparkle;
  const draw = Math.max(0, Math.min(1, at(l.draw, env, 1)));
  if (draw <= 0.001) return;
  const size = Math.min(box.w, box.h);
  const k = size / 24;
  const path = new Path2D();
  path.addPath(new Path2D(d), new DOMMatrix([k, 0, 0, k, box.x + (box.w - size) / 2, box.y + (box.h - size) / 2]));
  ctx.strokeStyle = color(l.color as string, env.scene.theme);
  ctx.lineWidth = (l.strokeWidth ?? 1.8) * k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (draw < 0.999) {
    const len = pathLength(d) * k;
    ctx.setLineDash([len * draw, len + 1]);
  }
  if (l.glow) setShadow(env, l);
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.shadowColor = "transparent";
}

// ---- pictures

function fitBox(pw: number, ph: number, box: Box, fit: "cover" | "contain"): Box {
  const s = fit === "cover" ? Math.max(box.w / pw, box.h / ph) : Math.min(box.w / pw, box.h / ph);
  const w = pw * s, h = ph * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

function drawImage(env: Env, l: ImageLayer, box: Box) {
  const { ctx, S } = env;
  const theme = env.scene.theme;
  const pic = l.slot ? env.scene.pictures.get(l.slot) ?? null : null;
  const radius = radiusOf(l.radius, box, theme, S);
  if (!pic) {
    if (!env.scene.placeholders || !l.placeholder) return;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, Math.max(radius, S * 0.02));
    ctx.fillStyle = color("@text/0.06", theme);
    ctx.fill();
    ctx.setLineDash([S * 0.012, S * 0.01]);
    ctx.strokeStyle = color("@text/0.35", theme);
    ctx.lineWidth = S * 0.003;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color("@text/0.6", theme);
    ctx.font = `600 ${Math.round(S * 0.032)}px ${faceStack(theme.body.family, theme.bangla.family)}`;
    ctx.textAlign = "center";
    ctx.fillText(l.placeholder, box.x + box.w / 2, box.y + box.h / 2 + S * 0.012);
    ctx.textAlign = "start";
    return;
  }
  const pw = "naturalWidth" in pic ? pic.naturalWidth : pic.width;
  const ph = "naturalHeight" in pic ? pic.naturalHeight : pic.height;
  if (!pw || !ph) return;
  const r = fitBox(pw, ph, box, l.fit ?? "cover");
  const fill = l.trace ? Math.max(0, Math.min(1, at(l.trace.fill, env, 1))) : 1;
  const outline = l.slot ? env.scene.outlines.get(l.slot) : null;
  if (l.trace && outline) {
    const draw = Math.max(0, Math.min(1, at(l.trace.draw, env, 1)));
    if (draw > 0.001 && fill < 0.999) {
      // The outline in the picture's place: its 0…1 box stretched over where the picture is drawn.
      const fitted = fitBox(outline.aspect, 1, box, l.fit ?? "contain");
      ctx.save();
      ctx.globalAlpha *= 1 - fill * 0.85;
      ctx.strokeStyle = color(l.trace.color as string, theme);
      ctx.lineWidth = l.trace.width * S;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (l.glow) setShadow(env, l);
      outline.paths.forEach((p, i) => {
        const path = new Path2D();
        path.addPath(p, new DOMMatrix([fitted.w, 0, 0, fitted.h, fitted.x, fitted.y]));
        const len = outline.lengths[i] * (fitted.w + fitted.h) / 2;
        if (draw < 0.999) ctx.setLineDash([len * draw, len + 1]);
        ctx.stroke(path);
      });
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
  if (fill <= 0.001) return;
  ctx.save();
  ctx.globalAlpha *= fill;
  setShadow(env, l);
  if (radius > 0 && (l.fit ?? "cover") === "cover") {
    // Shadow from the rounded box, then the picture clipped into it.
    if (l.shadow) {
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, radius);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.shadowColor = "transparent";
    }
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, radius);
    ctx.clip();
  }
  ctx.drawImage(pic, r.x, r.y, r.w, r.h);
  ctx.restore();
}

// ---- text

/** Bangla text (any letter in the Bengali block): no tracking, no italic, taller lines. */
const isBangla = (text: string) => /[\u0980-\u09ff]/.test(text);

function fontCss(env: Env, l: TextLayer, size: number, text = ""): string {
  const theme = env.scene.theme;
  const ref = l.font === "heading" ? theme.heading : theme.body;
  return `${l.italic && !isBangla(text) ? "italic " : ""}${l.weight ?? ref.weight} ${Math.max(1, Math.round(size * 10) / 10)}px ${faceStack(ref.family, theme.bangla.family)}`;
}

/** A text layer's text: its field or fixed text, as it ends (`settled`) or at this moment (counting, ticking). */
function textOf(env: Env, l: TextLayer, settled = false): string {
  const sc = env.scene;
  let text = l.field ? fieldValue(sc.template, sc.values, l.field, sc.bangla) : l.text ?? "";
  if (l.counter && !settled) {
    const to = parseNumber(text);
    const from = l.counter.from !== undefined ? parseNumber(fieldValue(sc.template, sc.values, l.counter.from, sc.bangla))?.value : l.counter.fromValue ?? 0;
    if (from !== undefined && to) {
      const [t0, t1] = l.counter.t;
      const u = ease("out", (env.t - t0) / Math.max(1e-3, t1 - t0), "smooth");
      text = formatNumber(to, from + (to.value - from) * u);
    }
  }
  if (l.clock && !settled) text = tickClock(text, env.t - l.clock.t);
  return l.upper ? text.toUpperCase() : text;
}

/**
 * Letter spacing, except in Bangla: spacing goes between letters, which would break the headline
 * stroke (matra) and pull vowel signs away, so Bangla text keeps its natural spacing.
 */
function trackingFor(env: Env, l: TextLayer, text: string): number {
  return isBangla(text) ? 0 : at(l.tracking, env, 0);
}

/** A text layer's size, lines and alignment in the shape being drawn. */
function textSpec(env: Env, l: TextLayer) {
  const o = l.textAt?.[shapeOf(env.W, env.H)];
  // Never below the role's floor (motion-rulebook.md §5.1): text wraps or shortens instead.
  const floor = TEXT_FLOORS[roleOf(l)];
  const size = Math.max(floor, o?.size ?? l.size);
  const min = o?.minSize ?? (o?.size ? size * 0.62 : l.minSize ?? size * 0.62);
  return { size, minSize: Math.min(size, Math.max(floor, min)), lines: o?.lines ?? l.lines ?? 3, align: o?.align ?? l.align ?? "center" };
}

/** Lays a text out to fit its box, cached; `fixed` holds the size (a counter keeps the size its last number fits). */
function layoutText(env: Env, l: TextLayer, box: Box, text: string, tracking: number, fixed?: number, slot = l.id) {
  const { ctx, S } = env;
  const spec = textSpec(env, l);
  const key = `${text}\u0000${box.w.toFixed(1)}\u0000${S}\u0000${fontCss(env, l, 10)}\u0000${tracking.toFixed(3)}\u0000${l.animate?.unit ?? ""}\u0000${spec.size}\u0000${spec.lines}\u0000${fixed ?? ""}`;
  const have = env.mem.texts.get(slot);
  if (have && have.key === key) return have;
  const max = fixed ?? spec.size * S, min = fixed ?? spec.minSize * S;
  const measureAt = (size: number) => {
    ctx.font = fontCss(env, l, size, text);
    const em = tracking * size;
    return (s: string) => ctx.measureText(s).width + (em ? em * Math.max(0, graphemes(s).length - 1) : 0);
  };
  const fit = fitText(text, { width: box.w, max, min, lines: spec.lines }, measureAt);
  const measure = measureAt(fit.size);
  const m = ctx.measureText("Hgজ্ঞা");
  const ascent = m.fontBoundingBoxAscent || fit.size * 0.8;
  const descent = m.fontBoundingBoxDescent || fit.size * 0.22;
  const unit = l.animate?.unit ?? l.exit?.unit ?? "line";
  // With letter spacing, letters are placed one by one even for word or line units.
  const pieces = (line: string) => (unit === "char" || tracking ? graphemes(line) : unit === "word" ? wordsOf(line) : [line]);
  let index = 0;
  const units: Unit[][] = [];
  const widths: number[] = [];
  for (const line of fit.lines) {
    const row: Unit[] = [];
    let prefix = "";
    let inWord = false;
    for (const p of pieces(line)) {
      const x = measure(prefix) + (prefix ? tracking * fit.size : 0);
      const space = /^\s+$/.test(p);
      let idx = -1;
      if (space) inWord = false;
      else if (unit === "word" && tracking) {
        // Letters placed one by one still move with their word.
        if (!inWord) index++;
        idx = index - 1;
        inWord = true;
      } else idx = index++;
      row.push({ text: p, x, w: measure(p), index: idx });
      prefix += p;
    }
    units.push(row);
    widths.push(measure(line));
  }
  const done = { key, fit, units, ascent, descent, widths };
  env.mem.texts.set(slot, done);
  return done;
}

/** Entrance or exit progress (0…1, eased) of unit `i` of `n`. */
function unitProgress(env: Env, a: TextAnimator, i: number, n: number, exit: boolean, effect = false): number {
  const start = staggerStart(a.t, i, n, a.stagger, a.reverse ?? exit);
  const u = (env.t - start) / Math.max(1e-3, a.duration);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const name = a.ease ?? (exit ? "in" : "out");
  // Opacity and blur never spring: only position, scale and rotation overshoot.
  if (effect) return ease(name === "spring" || name === "back" ? (exit ? "in" : "out") : name, u, "smooth");
  return ease(name, u, env.feel);
}

function drawText(env: Env, l: TextLayer, box: Box) {
  const { ctx } = env;
  const theme = env.scene.theme;
  const text = textOf(env, l);
  if (!text.trim()) return;
  if (l.marquee) return drawMarquee(env, l, box, text);
  const tracking = trackingFor(env, l, text);
  // Counting numbers keep the size the final one fits, so the text doesn't jump as it grows.
  const fixed = l.counter || l.clock ? layoutText(env, l, box, textOf(env, l, true), tracking, undefined, `${l.id}\u0001`).fit.size : undefined;
  const lay = layoutText(env, l, box, text, tracking, fixed);
  const size = lay.fit.size;
  const lineH = size * Math.max(l.lineHeight ?? 1.12, isBangla(text) ? 1.5 : 0);
  const blockH = lay.units.length * lineH;
  const align = textSpec(env, l).align;
  const top = l.valign === "top" ? box.y : l.valign === "bottom" ? box.y + box.h - blockH : box.y + (box.h - blockH) / 2;
  ctx.font = fontCss(env, l, size, text);
  if (l.marker) drawMarker(env, l.marker, lay.widths, top, lineH, size, align, box);
  const fill = paint(ctx, l.color, theme, box);
  ctx.fillStyle = fill;
  setShadow(env, l);
  const total = Math.max(1, ...lay.units.flat().map((u) => u.index + 1));
  const maxW = Math.max(...lay.widths);
  const baseAlpha = ctx.globalAlpha;
  const native = canFilter(ctx);
  lay.units.forEach((row, li) => {
    const lw = lay.widths[li];
    const x0 = align === "left" ? box.x : align === "right" ? box.x + box.w - lw : box.x + (box.w - lw) / 2;
    const lineTop = top + li * lineH;
    const baseline = lineTop + (lineH - (lay.ascent + lay.descent)) / 2 + lay.ascent;
    const masked = l.animate?.mask || l.exit?.mask;
    if (masked) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x - size, lineTop - lineH * 0.08, box.w + size * 2, lineH * 1.16);
      ctx.clip();
    }
    for (const u of row) {
      if (u.index < 0) continue;
      const lineUnit = (a: TextAnimator) => (a.unit === "line" ? li : u.index);
      const count = (a: TextAnimator) => (a.unit === "line" ? lay.units.length : total);
      let alpha = 1, ox = 0, oy = 0, sc = 1, rot = 0, bl = 0;
      if (l.animate) {
        const a = l.animate, e = unitProgress(env, a, lineUnit(a), count(a), false);
        const fe = unitProgress(env, a, lineUnit(a), count(a), false, true);
        const f = a.from;
        alpha *= (f.opacity ?? 1) + (1 - (f.opacity ?? 1)) * fe;
        ox += (f.dx ?? 0) * size * (1 - e);
        oy += (f.dy ?? 0) * size * (1 - e);
        sc *= (f.scale ?? 1) + (1 - (f.scale ?? 1)) * e;
        rot += (f.rotate ?? 0) * (1 - e);
        bl += (f.blur ?? 0) * size * (1 - fe);
      }
      if (l.exit) {
        const a = l.exit, e = unitProgress(env, a, lineUnit(a), count(a), true);
        const fe = unitProgress(env, a, lineUnit(a), count(a), true, true);
        const f = a.from;
        alpha *= 1 + ((f.opacity ?? 1) - 1) * fe;
        ox += (f.dx ?? 0) * size * e;
        oy += (f.dy ?? 0) * size * e;
        sc *= 1 + ((f.scale ?? 1) - 1) * e;
        rot += (f.rotate ?? 0) * e;
        bl += (f.blur ?? 0) * size * fe;
      }
      if (alpha <= 0.002 || sc <= 0.002) continue;
      const x = x0 + u.x;
      ctx.globalAlpha = baseAlpha * Math.min(1, alpha);
      const transformed = sc !== 1 || rot !== 0;
      if (transformed) {
        ctx.save();
        const pcx = x + u.w / 2 + ox, pcy = baseline - lay.ascent * 0.35 + oy;
        ctx.translate(pcx, pcy);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.scale(sc, sc);
        ctx.translate(-pcx, -pcy);
      }
      if (bl > 0.3 && native) ctx.filter = `blur(${bl.toFixed(1)}px)`;
      ctx.fillText(u.text, x + ox, baseline + oy);
      if (bl > 0.3 && native) ctx.filter = "none";
      if (transformed) ctx.restore();
    }
    if (masked) ctx.restore();
  });
  ctx.globalAlpha = baseAlpha;
  ctx.shadowColor = "transparent";
  if (l.strike) {
    const draw = Math.max(0, Math.min(1, at(l.strike.draw, env, 1)));
    if (draw > 0.001) {
      const lw = lay.widths[0] ?? maxW;
      const x0 = align === "left" ? box.x : align === "right" ? box.x + box.w - lw : box.x + (box.w - lw) / 2;
      const y = top + (lineH - (lay.ascent + lay.descent)) / 2 + lay.ascent * 0.62;
      ctx.beginPath();
      ctx.moveTo(x0 - size * 0.08, y + size * 0.06);
      ctx.lineTo(x0 - size * 0.08 + (lw + size * 0.16) * draw, y - size * 0.06);
      ctx.strokeStyle = color(l.strike.color as string, theme);
      ctx.lineWidth = l.strike.width * env.S;
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }
}

/** A ticker: the text repeated along one line, scrolling left, clipped to the box. */
function drawMarquee(env: Env, l: TextLayer, box: Box, text: string) {
  const { ctx, S } = env;
  const m = l.marquee!;
  const spec = textSpec(env, l);
  const size = Math.min(spec.size * S, box.h * 0.8);
  ctx.font = fontCss(env, l, size, text);
  const piece = text.replace(/\s+/g, " ") + (m.gap ?? "   •   ");
  const w = ctx.measureText(piece).width;
  if (w <= 1) return;
  const shift = ((env.t * m.speed * box.w) % w + w) % w;
  const metrics = ctx.measureText("Hgজ্ঞা");
  const ascent = metrics.fontBoundingBoxAscent || size * 0.8, descent = metrics.fontBoundingBoxDescent || size * 0.22;
  const baseline = box.y + (box.h - (ascent + descent)) / 2 + ascent;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y - size * 0.3, box.w, box.h + size * 0.6);
  ctx.clip();
  ctx.fillStyle = paint(ctx, l.color, env.scene.theme, box);
  setShadow(env, l);
  for (let x = box.x - shift; x < box.x + box.w; x += w) ctx.fillText(piece, x, baseline);
  ctx.restore();
}

/** A highlighter swiped behind a text's lines, one after another (testimonials' signature, motion-rulebook.md §12). */
function drawMarker(env: Env, m: NonNullable<TextLayer["marker"]>, widths: number[], top: number, lineH: number, size: number, align: string | undefined, box: Box) {
  const lines = widths.slice(0, m.lines ?? widths.length);
  const pad = size * 0.14;
  let left = Math.max(0, Math.min(1, at(m.draw, env, 1))) * lines.reduce((sum, w) => sum + w + pad * 2, 0);
  if (left <= 0.5) return;
  const { ctx } = env;
  ctx.save();
  ctx.fillStyle = color(m.color as string, env.scene.theme);
  lines.forEach((lw, li) => {
    const w = Math.min(left, lw + pad * 2);
    left -= w;
    if (w <= 0.5) return;
    const x0 = (align === "left" ? box.x : align === "right" ? box.x + box.w - lw : box.x + (box.w - lw) / 2) - pad;
    ctx.beginPath();
    ctx.roundRect(x0, top + li * lineH + lineH * 0.22, w, lineH * 0.7, size * 0.14);
    ctx.fill();
  });
  ctx.restore();
}

// ---- effects

let gradeCanvas: HTMLCanvasElement | null = null;

/**
 * Grades what's drawn (brand.ts `Grade`): blend-mode washes on a copy, drawn back only where
 * there's picture (source-atop), so transparent parts of the frame stay transparent.
 */
function drawGrade(ctx: CanvasRenderingContext2D, grade: Grade) {
  const { width: w, height: h } = ctx.canvas;
  if (!w || !h) return;
  const copy = (gradeCanvas ??= document.createElement("canvas"));
  if (copy.width !== w || copy.height !== h) {
    copy.width = w;
    copy.height = h;
  }
  const g = copy.getContext("2d")!;
  g.globalAlpha = 1;
  g.globalCompositeOperation = "copy";
  g.drawImage(ctx.canvas, 0, 0);
  const wash = (op: GlobalCompositeOperation, color: string, alpha: number) => {
    if (alpha <= 0.001) return;
    g.globalCompositeOperation = op;
    g.globalAlpha = Math.min(1, alpha);
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
  };
  if (grade.saturation !== undefined) wash("saturation", "#808080", 1 - grade.saturation);
  if (grade.warmth) wash("soft-light", grade.warmth > 0 ? "#ff9640" : "#4090ff", Math.abs(grade.warmth) * 0.4);
  if (grade.tint && grade.tintAmount) wash("color", grade.tint, grade.tintAmount);
  if (grade.fade) {
    const lift = Math.round(grade.fade * 0.18 * 255);
    wash("screen", `rgb(${lift},${lift},${lift})`, 1);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-atop";
  ctx.drawImage(copy, 0, 0);
  ctx.restore();
}

const grainTiles: HTMLCanvasElement[] = [];

function grainTile(i: number): HTMLCanvasElement {
  let tile = grainTiles[i];
  if (!tile) {
    tile = document.createElement("canvas");
    tile.width = tile.height = 192;
    const g = tile.getContext("2d")!;
    const img = g.createImageData(192, 192);
    let seed = 1234567 + i * 7919;
    for (let p = 0; p < img.data.length; p += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = (seed >> 16) & 255;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainTiles[i] = tile;
  }
  return tile;
}

function drawFx(env: Env, l: FxLayer, box: Box) {
  const { ctx, t, S } = env;
  const theme = env.scene.theme;
  const amount = l.amount ?? 1;
  const c1 = color((l.color as string) ?? "@primary", theme);
  const c2 = color((l.color2 as string) ?? "@accent", theme);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  switch (l.fx) {
    case "grain": {
      const tile = grainTile(Math.floor(t * 24) % 4);
      const pattern = ctx.createPattern(tile, "repeat");
      if (!pattern) return;
      ctx.save();
      ctx.globalAlpha *= amount;
      ctx.globalCompositeOperation = "overlay";
      ctx.fillStyle = pattern;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
      return;
    }
    case "vignette": {
      const grad = ctx.createRadialGradient(cx, cy, Math.min(box.w, box.h) * 0.25, cx, cy, Math.hypot(box.w, box.h) * 0.6);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, `rgba(0,0,0,${0.75 * amount})`);
      ctx.fillStyle = grad;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      return;
    }
    case "leak": case "blobs": {
      // Soft glowing light: big radial gradients drifting slowly.
      const spots = l.fx === "leak"
        ? [[0.15, 0.2, 0.75, c1], [0.9, 0.75, 0.6, c2]] as const
        : [[0.2, 0.25, 0.55, c1], [0.82, 0.3, 0.45, c2], [0.55, 0.85, 0.5, mix(theme.colors.primary, theme.colors.accent, 0.5)]] as const;
      ctx.save();
      ctx.globalCompositeOperation = l.fx === "leak" ? "screen" : "source-over";
      spots.forEach(([fx, fy, fr, col], i) => {
        const x = box.x + box.w * (fx + 0.06 * Math.sin(t * 0.35 + i * 2.1));
        const y = box.y + box.h * (fy + 0.05 * Math.cos(t * 0.3 + i * 1.7));
        const r = Math.max(box.w, box.h) * fr;
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
        const [rr, gg, bb] = rgbOf(col.startsWith("#") ? col : "#ffffff");
        grad.addColorStop(0, `rgba(${rr},${gg},${bb},${0.55 * amount})`);
        grad.addColorStop(0.5, `rgba(${rr},${gg},${bb},${0.18 * amount})`);
        grad.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      });
      ctx.restore();
      return;
    }
    case "stripes": {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 5);
      const gap = S * 0.07, width = S * 0.026;
      const span = Math.hypot(box.w, box.h);
      const shift = (t * S * 0.05) % gap;
      ctx.fillStyle = c1;
      ctx.globalAlpha *= amount;
      for (let x = -span - gap + shift; x < span; x += gap) ctx.fillRect(x, -span, width, span * 2);
      ctx.restore();
      return;
    }
    case "rays": {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.15);
      const r = Math.hypot(box.w, box.h);
      const n = 18;
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.7);
      const [rr, gg, bb] = rgbOf(c1.startsWith("#") ? c1 : "#ffffff");
      grad.addColorStop(0, `rgba(${rr},${gg},${bb},${0.32 * amount})`);
      grad.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
      ctx.fillStyle = grad;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = a0 + (Math.PI / n) * 0.9;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, a0, a1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    case "progress": {
      const v = Math.max(0, Math.min(1, at(l.value, env, 1)));
      const r = box.h / 2;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, r);
      ctx.fillStyle = color("@text/0.18", theme);
      ctx.fill();
      if (v > 0) {
        ctx.beginPath();
        ctx.roundRect(box.x, box.y, Math.max(box.h, box.w * v), box.h, r);
        ctx.fillStyle = c1;
        if (l.glow) setShadow(env, l);
        ctx.fill();
        ctx.shadowColor = "transparent";
      }
      return;
    }
    case "confetti": case "sparks": case "dust": return drawParticles(env, l, box, l.fx, c1, c2);
    case "divider": {
      // The before/after handle: a line across the frame at `value`, with a round knob.
      const x = box.x + box.w * Math.max(0, Math.min(1, at(l.value, env, 0.5)));
      const lw = Math.max(1.5, S * 0.005), knob = S * 0.045;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = S * 0.02;
      ctx.fillStyle = c1;
      ctx.fillRect(x - lw / 2, box.y, lw, box.h);
      ctx.beginPath();
      ctx.arc(x, cy, knob, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = c2;
      ctx.lineWidth = knob * 0.14;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x + side * knob * 0.22, cy - knob * 0.3);
        ctx.lineTo(x + side * knob * 0.5, cy);
        ctx.lineTo(x + side * knob * 0.22, cy + knob * 0.3);
        ctx.stroke();
      }
      return;
    }
    case "dots": {
      const r = box.h / 2;
      for (let i = 0; i < 3; i++) {
        const phase = ((t * 1.6 - i * 0.18) % 1 + 1) % 1;
        const lift = Math.sin(Math.min(1, phase * 2) * Math.PI) * box.h * 0.5;
        ctx.beginPath();
        ctx.arc(box.x + r + i * (box.w - 2 * r) / 2, box.y + box.h / 2 - lift * 0.5, r * 0.62, 0, Math.PI * 2);
        ctx.fillStyle = c1;
        ctx.fill();
      }
      return;
    }
  }
}

function drawParticles(env: Env, l: FxLayer, box: Box, kind: ParticleKind, c1: string, c2: string) {
  const { ctx, S, t } = env;
  const theme = env.scene.theme;
  const n = particleCount(kind, S, l.amount ?? 1);
  if (!n) return;
  const palette = [c1, c2, "#ffffff", color("@secondary", theme), mix(theme.colors.primary, theme.colors.accent, 0.5)];
  ctx.save();
  if (kind !== "confetti") ctx.globalCompositeOperation = "lighter";
  const base = ctx.globalAlpha;
  for (const p of particleSeeds(l.id, n)) {
    const at = particleAt(kind, p, t, l.burst, box.w, box.h);
    if (!at || at.alpha <= 0.01) continue;
    const x = box.x + at.x, y = box.y + at.y;
    ctx.globalAlpha = base * Math.min(1, at.alpha);
    if (kind === "confetti") {
      const w = S * 0.011 * (0.7 + p.size * 0.8);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(at.rotate);
      ctx.scale(1, Math.max(0.08, Math.abs(at.flip)));
      ctx.fillStyle = palette[Math.floor(p.hue * palette.length) % palette.length];
      if (p.spin > 0.7) {
        ctx.beginPath();
        ctx.arc(0, 0, w * 0.55, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(-w / 2, -w, w, w * 2);
      ctx.restore();
    } else if (kind === "sparks") {
      const c = p.hue < 0.45 ? c1 : p.hue < 0.75 ? "#fff6dc" : c2;
      ctx.strokeStyle = c;
      ctx.lineWidth = S * (0.0022 + p.size * 0.0028);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - Math.cos(at.rotate) * at.len, y - Math.sin(at.rotate) * at.len);
      ctx.stroke();
    } else {
      const r = S * (0.0018 + p.size * 0.0042);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
      const [rr, gg, bb] = rgbOf(p.hue < 0.6 ? "#ffffff" : c1.startsWith("#") ? c1 : "#ffffff");
      g.addColorStop(0, `rgba(${rr},${gg},${bb},0.9)`);
      g.addColorStop(1, `rgba(${rr},${gg},${bb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
    }
  }
  ctx.restore();
}

// ---- devices, art, charts and QR codes

function artEnv(env: Env, tint: Paint | undefined, tint2: Paint | undefined, scroll: number): ArtEnv {
  const theme = env.scene.theme;
  return {
    col: (p) => color(p, theme),
    tint: color((tint as string) ?? "@primary", theme),
    tint2: color((tint2 as string) ?? "@accent", theme),
    t: env.t,
    scroll,
    font: (size, weight, heading) => `${weight} ${Math.max(1, Math.round(size * 10) / 10)}px ${faceStack((heading ? theme.heading : theme.body).family, theme.bangla.family)}`,
  };
}

function drawArt(env: Env, l: ArtLayer, box: Box) {
  setShadow(env, l);
  drawArtwork(env.ctx, l.art, box, artEnv(env, l.tint, l.tint2, Math.max(0, Math.min(1, at(l.scroll, env, 0)))));
  env.ctx.shadowColor = "transparent";
}

/** What a device's screen shows: the slot's picture (scrolled when it's taller), else a built-in screen. */
function drawScreen(env: Env, l: DeviceLayer, screen: Box, radius: number) {
  const { ctx, S } = env;
  const theme = env.scene.theme;
  const scroll = Math.max(0, Math.min(1, at(l.scroll, env, 0)));
  const pic = l.slot ? env.scene.pictures.get(l.slot) ?? null : null;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(screen.x, screen.y, screen.w, screen.h, radius);
  ctx.clip();
  ctx.fillStyle = "#050608";
  ctx.fillRect(screen.x, screen.y, screen.w, screen.h);
  const pw = pic ? ("naturalWidth" in pic ? pic.naturalWidth : pic.width) : 0;
  const ph = pic ? ("naturalHeight" in pic ? pic.naturalHeight : pic.height) : 0;
  if (pic && pw && ph) {
    const r = fitBox(pw, ph, screen, "cover");
    // A tall screenshot scrolls from its top to its bottom; a wide one stays centred.
    const y = r.h > screen.h ? screen.y - (r.h - screen.h) * scroll : r.y;
    ctx.drawImage(pic, r.x, y, r.w, r.h);
  } else if (l.screen) {
    drawArtwork(ctx, l.screen, screen, artEnv(env, undefined, undefined, scroll));
  } else if (env.scene.placeholders) {
    ctx.fillStyle = color("@text/0.6", theme);
    ctx.font = `600 ${Math.round(S * 0.03)}px ${faceStack(theme.body.family, theme.bangla.family)}`;
    ctx.textAlign = "center";
    ctx.fillText("Screen", screen.x + screen.w / 2, screen.y + screen.h / 2);
    ctx.textAlign = "start";
  }
  // A faint reflection across the glass.
  const glare = ctx.createLinearGradient(screen.x, screen.y, screen.x + screen.w, screen.y + screen.h);
  glare.addColorStop(0, "rgba(255,255,255,0.10)");
  glare.addColorStop(0.42, "rgba(255,255,255,0)");
  ctx.fillStyle = glare;
  ctx.fillRect(screen.x, screen.y, screen.w, screen.h);
  ctx.restore();
}

function drawDevice(env: Env, l: DeviceLayer, box: Box) {
  const { ctx, S } = env;
  const theme = env.scene.theme;
  const bodyPaint = (b: Box): string | CanvasGradient => {
    if (l.body) return paint(ctx, l.body, theme, b);
    const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
    g.addColorStop(0, "#3b3e46");
    g.addColorStop(0.5, "#1c1d22");
    g.addColorStop(1, "#2c2e35");
    return g;
  };
  const rim = (path: () => void, b: Box) => {
    path();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = Math.max(1, b.w * 0.004);
    ctx.stroke();
  };
  if (l.device === "phone") {
    const p = fitBox(9, 19.5, box, "contain");
    const r = p.w * 0.17, bezel = p.w * 0.034;
    // Side buttons, then the body with its shadow, then the screen and the camera pill.
    ctx.fillStyle = "#24262c";
    ctx.fillRect(p.x - p.w * 0.012, p.y + p.h * 0.2, p.w * 0.02, p.h * 0.06);
    ctx.fillRect(p.x - p.w * 0.012, p.y + p.h * 0.29, p.w * 0.02, p.h * 0.1);
    ctx.fillRect(p.x + p.w - p.w * 0.008, p.y + p.h * 0.25, p.w * 0.02, p.h * 0.13);
    const body = () => {
      ctx.beginPath();
      ctx.roundRect(p.x, p.y, p.w, p.h, r);
    };
    body();
    setShadow(env, l);
    ctx.fillStyle = bodyPaint(p);
    ctx.fill();
    ctx.shadowColor = "transparent";
    rim(body, p);
    const screen = { x: p.x + bezel, y: p.y + bezel, w: p.w - bezel * 2, h: p.h - bezel * 2 };
    drawScreen(env, l, screen, r - bezel);
    const iw = p.w * 0.3, ih = p.w * 0.085;
    ctx.beginPath();
    ctx.roundRect(p.x + (p.w - iw) / 2, screen.y + p.w * 0.03, iw, ih, ih / 2);
    ctx.fillStyle = "#000000";
    ctx.fill();
    return;
  }
  if (l.device === "laptop") {
    // A lid 16:10 and a base a little wider: the whole thing is 1.16 lids wide.
    const whole = fitBox(1.16, 0.625 + 0.05, box, "contain");
    const lw = whole.w / 1.16, lh = lw * 0.625;
    const lid = { x: whole.x + (whole.w - lw) / 2, y: whole.y, w: lw, h: lh };
    const bezel = lw * 0.022, r = lw * 0.03;
    const lidPath = () => {
      ctx.beginPath();
      ctx.roundRect(lid.x, lid.y, lid.w, lid.h, [r, r, lw * 0.006, lw * 0.006]);
    };
    lidPath();
    setShadow(env, l);
    ctx.fillStyle = bodyPaint(lid);
    ctx.fill();
    ctx.shadowColor = "transparent";
    rim(lidPath, lid);
    const screen = { x: lid.x + bezel, y: lid.y + bezel * 1.3, w: lid.w - bezel * 2, h: lid.h - bezel * 2.3 };
    drawScreen(env, l, screen, lw * 0.006);
    ctx.beginPath();
    ctx.arc(lid.x + lid.w / 2, lid.y + bezel * 0.65, bezel * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = "#3a3d44";
    ctx.fill();
    // The base: a slab that tapers to a thin edge, with the thumb notch.
    const by = lid.y + lid.h, bh = whole.h - lh;
    ctx.beginPath();
    ctx.moveTo(whole.x + whole.w * 0.02, by);
    ctx.lineTo(whole.x + whole.w * 0.98, by);
    ctx.quadraticCurveTo(whole.x + whole.w, by + bh * 0.5, whole.x + whole.w * 0.965, by + bh);
    ctx.lineTo(whole.x + whole.w * 0.035, by + bh);
    ctx.quadraticCurveTo(whole.x, by + bh * 0.5, whole.x + whole.w * 0.02, by);
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    g.addColorStop(0, "#c9ccd3");
    g.addColorStop(0.35, "#8d9099");
    g.addColorStop(1, "#4a4c53");
    ctx.fillStyle = l.body ? paint(ctx, l.body, theme, whole) : g;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(whole.x + whole.w / 2 - lw * 0.08, by, lw * 0.16, bh * 0.38, [0, 0, bh * 0.3, bh * 0.3]);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fill();
    return;
  }
  // Browser: a window with a title bar, three dots and the address.
  const r = Math.min(box.w, box.h) * 0.035;
  const bar = Math.max(S * 0.04, Math.min(box.h * 0.1, box.w * 0.06));
  const win = () => {
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, r);
  };
  win();
  setShadow(env, l);
  ctx.fillStyle = l.body ? paint(ctx, l.body, theme, box) : color("@surface", theme);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.save();
  win();
  ctx.clip();
  ctx.fillStyle = l.body ? "rgba(0,0,0,0.12)" : mix(theme.colors.background, theme.colors.text, 0.14);
  ctx.fillRect(box.x, box.y, box.w, bar);
  ctx.restore();
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(box.x + bar * (0.55 + i * 0.42), box.y + bar / 2, bar * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  const ax = box.x + bar * 1.9, aw = Math.min(box.w - bar * 3.8, box.w * 0.62), ah = bar * 0.56;
  const pill = { x: Math.max(ax, box.x + (box.w - aw) / 2), y: box.y + (bar - ah) / 2, w: aw, h: ah };
  ctx.beginPath();
  ctx.roundRect(pill.x, pill.y, pill.w, pill.h, ah / 2);
  ctx.fillStyle = color("@bg/0.7", theme);
  ctx.fill();
  const url = l.urlField ? fieldValue(env.scene.template, env.scene.values, l.urlField, env.scene.bangla) : l.url ?? "";
  if (url) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pill.x + ah * 0.4, pill.y, pill.w - ah * 0.8, pill.h);
    ctx.clip();
    ctx.fillStyle = color("@text/0.7", theme);
    ctx.font = `500 ${Math.round(ah * 0.5)}px ${faceStack(theme.body.family, theme.bangla.family)}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(url.replace(/^https?:\/\//, ""), pill.x + pill.w / 2, pill.y + pill.h / 2);
    ctx.restore();
  }
  drawScreen(env, l, { x: box.x, y: box.y + bar, w: box.w, h: box.h - bar }, 0);
  ctx.save();
  win();
  ctx.strokeStyle = color("@text/0.14", theme);
  ctx.lineWidth = Math.max(1, S * 0.002);
  ctx.stroke();
  ctx.restore();
}

function drawChart(env: Env, l: ChartLayer, box: Box) {
  const { ctx, S } = env;
  const theme = env.scene.theme;
  const values = l.field ? chartValues(fieldValue(env.scene.template, env.scene.values, l.field, env.scene.bangla)) : l.values ?? [];
  if (!values.length) return;
  const grow = Math.max(0, Math.min(1, at(l.grow, env, 1)));
  if (l.chart === "ring") {
    const width = (l.width ?? 0.04) * S;
    const r = Math.min(box.w, box.h) / 2 - width / 2;
    if (r <= 0) return;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const frac = Math.max(0, Math.min(1, values[0] / 100));
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = paint(ctx, l.track ?? "@text/0.14", theme, box);
    ctx.stroke();
    if (frac * grow > 0.001) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac * grow);
      ctx.strokeStyle = paint(ctx, l.color, theme, box);
      setShadow(env, l);
      ctx.stroke();
      ctx.shadowColor = "transparent";
    }
    return;
  }
  const n = values.length;
  const max = Math.max(...values.map((v) => Math.abs(v)), 1e-6);
  const slot = box.w / n, bw = slot * 0.62;
  const radius = Math.min(bw * 0.28, S * 0.02);
  values.forEach((v, i) => {
    const x = box.x + slot * i + (slot - bw) / 2;
    if (l.track) {
      ctx.beginPath();
      ctx.roundRect(x, box.y, bw, box.h, radius);
      ctx.fillStyle = paint(ctx, l.track, theme, box);
      ctx.fill();
    }
    const h = box.h * (Math.abs(v) / max) * barGrowth(grow, i, n, l.stagger ?? 0.08);
    if (h < 0.5) return;
    ctx.beginPath();
    ctx.roundRect(x, box.y + box.h - h, bw, h, [radius, radius, radius * 0.4, radius * 0.4]);
    ctx.fillStyle = paint(ctx, i === n - 1 && l.color2 ? l.color2 : l.color, theme, { x, y: box.y, w: bw, h: box.h });
    setShadow(env, l);
    ctx.fill();
    ctx.shadowColor = "transparent";
  });
}

const qrCache = new Map<string, QrCode | null>();

function drawQr(env: Env, l: QrLayer, box: Box) {
  const { ctx } = env;
  const theme = env.scene.theme;
  const text = fieldValue(env.scene.template, env.scene.values, l.field, env.scene.bangla).trim();
  if (!text) return;
  let code = qrCache.get(text);
  if (code === undefined) {
    code = encodeQr(text);
    if (qrCache.size > 32) qrCache.clear();
    qrCache.set(text, code);
  }
  if (!code) return;
  const side = Math.min(box.w, box.h);
  const quiet = 2;
  const cell = side / (code.size + quiet * 2);
  const x0 = box.x + (box.w - side) / 2, y0 = box.y + (box.h - side) / 2;
  ctx.beginPath();
  ctx.roundRect(x0, y0, side, side, cell * 1.6);
  setShadow(env, l);
  ctx.fillStyle = paint(ctx, l.background ?? "#ffffff", theme, box);
  ctx.fill();
  ctx.shadowColor = "transparent";
  const draw = Math.max(0, Math.min(1, at(l.draw, env, 1)));
  ctx.fillStyle = paint(ctx, l.color, theme, box);
  // Whole pixels per module edge, so the code stays sharp (and readable) at any size.
  const edge = (i: number) => Math.round(x0 + (quiet + i) * cell);
  const edgeY = (i: number) => Math.round(y0 + (quiet + i) * cell);
  const span = code.size * 2;
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      if (draw < 0.999 && (x + y) / span > draw * 1.08 - 0.04) continue;
      ctx.fillRect(edge(x), edgeY(y), edge(x + 1) - edge(x), edgeY(y + 1) - edgeY(y));
    }
  }
}

// ---- ungrouping

/** A text of the template as it's laid out: for "Ungroup to layers". */
export interface PlacedText {
  layer: TextLayer;
  text: string;
  /** Font size in pixels, the CSS family list and weight. */
  size: number;
  family: string;
  weight: number;
  italic: boolean;
  color: string;
  align: "left" | "center" | "right";
  box: Box;
  /** Its widest line (pixels). */
  width: number;
  /** When it shows (template time), if only for part of the template. */
  time?: [number, number];
}

export interface PlacedPicture {
  layer: ImageLayer;
  slot: string;
  box: Box;
  time?: [number, number];
}

/** Where the template's texts and slot pictures sit on a W×H canvas (at template time `t`). */
export function parts(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, scene: Scene): { texts: PlacedText[]; pictures: PlacedPicture[] } {
  const env: Env = { ctx, W, H, S: Math.min(W, H), t, idle: 0, feel: scene.theme.motion, scene, mem: newMemory(), hits: null };
  const texts: PlacedText[] = [];
  const pictures: PlacedPicture[] = [];
  const walk = (layers: Layer[], time?: [number, number]) => {
    for (const l of layers) {
      if (l.ifEmpty && scene.pictures.get(l.ifEmpty)) continue;
      if (l.ifFilled && !scene.pictures.get(l.ifFilled)) continue;
      const span = l.time ?? time;
      const box = resolve(l.frame, W, H);
      if (l.kind === "group") walk(l.children, span);
      else if (l.kind === "image" && l.slot && scene.pictures.get(l.slot)) pictures.push({ layer: l, slot: l.slot, box, ...(span ? { time: span } : {}) });
      else if (l.kind === "text") {
        const text = textOf(env, l);
        if (!text.trim()) continue;
        const lay = layoutText(env, l, box, text, trackingFor(env, l, text));
        const ref = l.font === "heading" ? scene.theme.heading : scene.theme.body;
        const fill = typeof l.color === "string" ? l.color : l.color.stops[0]?.[1] ?? "@text";
        texts.push({
          layer: l, text: lay.fit.lines.join("\n"), size: lay.fit.size, family: familyStack(ref.family, scene.theme.bangla.family),
          weight: l.weight ?? ref.weight, italic: !!l.italic, color: color(fill, scene.theme), align: textSpec(env, l).align, box, width: Math.max(0, ...lay.widths),
          ...(span ? { time: span } : {}),
        });
      }
    }
  };
  walk(scene.template.layers);
  return { texts, pictures };
}
