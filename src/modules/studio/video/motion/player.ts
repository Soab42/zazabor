import { valueAt, ease, staggerStart, type Anim, type Feel } from "./ease";
import { fieldValue, type FxLayer, type Gradient, type ImageLayer, type IconLayer, type Layer, type Paint, type PathLayer, type RectLayer, type Template, type TextAnimator, type TextLayer } from "./format";
import { resolve, shapeOf, type Box } from "./layout";
import { fitText, formatNumber, graphemes, parseNumber, wordsOf, type Fitted } from "./textfit";
import { mix, onColor, rgbOf, type Theme } from "./brand";
import { familyStack } from "./fonts";
import { ICONS } from "./icons";

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
  const [name, alphaText] = p.split("/");
  const c = theme.colors;
  const base = name === "@primary" ? c.primary
    : name === "@secondary" ? c.secondary
    : name === "@accent" ? c.accent
    : name === "@bg" || name === "@background" ? c.background
    : name === "@text" ? c.text
    : name === "@onPrimary" ? onColor(c.primary)
    : name === "@onAccent" ? onColor(c.accent)
    : name === "@surface" ? mix(c.background, c.text, 0.08)
    : name === "@deep" ? mix(c.background, "#000000", 0.45)
    : name === "@primaryDeep" ? mix(c.primary, "#000000", 0.42)
    : name;
  const alpha = alphaText !== undefined ? Number(alphaText) : 1;
  if (!/^#[0-9a-f]{6}$/i.test(base)) return base;
  if (alpha >= 1) return base;
  const [r, g, b] = rgbOf(base);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
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

/** Draws the template at template time `t` onto `ctx` (W×H, cleared by the caller). */
export function drawScene(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, idle: number, scene: Scene, mem: Memory, hits: Box[] | null = null) {
  const env: Env = { ctx, W, H, S: Math.min(W, H), t, idle, feel: scene.theme.motion, scene, mem, hits };
  ctx.save();
  ctx.textBaseline = "alphabetic";
  for (const layer of scene.template.layers) drawLayer(env, layer);
  ctx.restore();
}

/** Whether anything moves between two template times (export draws motion blur only then). */
export function moving(template: Template, t0: number, t1: number): boolean {
  const changes = (a: Anim | undefined) => Array.isArray(a) && a.length > 1 && a[0][0] < t1 && a[a.length - 1][0] > t0;
  const check = (layers: Layer[]): boolean => layers.some((l) =>
    changes(l.dx) || changes(l.dy) || changes(l.scale) || changes(l.rotate)
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
  const opacity = at(l.opacity, env, 1);
  if (opacity <= 0.002) return;
  const box = resolve(l.frame, env.W, env.H);
  const dx = at(l.dx, env, 0) * S, dy = (at(l.dy, env, 0) + (l.idle?.dy ?? 0) * env.idle) * S;
  const scale = at(l.scale, env, 1) * (1 + (l.idle?.scale ?? 0) * env.idle);
  const rotate = at(l.rotate, env, 0) + (l.idle?.rotate ?? 0) * env.idle;
  if (scale <= 0.001) return;
  const blur = Math.max(0, at(l.blur, env, 0) * S);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.save();
  ctx.globalAlpha *= opacity;
  if (l.blend) ctx.globalCompositeOperation = l.blend;
  ctx.translate(cx + dx, cy + dy);
  if (rotate) ctx.rotate((rotate * Math.PI) / 180);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  if (l.reveal) {
    const v = Math.max(0, Math.min(1, at(l.reveal.v, env, 1)));
    if (v <= 0.001) {
      ctx.restore();
      return;
    }
    if (v < 0.999) {
      const pad = S * 0.6;
      let r: Box;
      switch (l.reveal.from) {
        case "left": r = { x: box.x - pad, y: box.y - pad, w: pad + box.w * v, h: box.h + 2 * pad }; break;
        case "right": r = { x: box.x + box.w * (1 - v), y: box.y - pad, w: box.w * v + pad, h: box.h + 2 * pad }; break;
        case "top": r = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: pad + box.h * v }; break;
        case "center": r = { x: cx - (box.w * v) / 2, y: cy - (box.h * v) / 2, w: box.w * v, h: box.h * v }; break;
        default: r = { x: box.x - pad, y: box.y + box.h * (1 - v), w: box.w + 2 * pad, h: box.h * v + pad };
      }
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
    }
  }
  if (env.hits && (l.kind === "text" || l.kind === "image")) {
    env.hits.push({ x: box.x + dx - (box.w * (scale - 1)) / 2, y: box.y + dy - (box.h * (scale - 1)) / 2, w: box.w * scale, h: box.h * scale });
  }
  const content = () => drawContent(env, l, box);
  if (l.sheen || (blur > 0.4 && !canFilter(ctx))) offscreen(env, l, box, blur, content);
  else {
    if (blur > 0.4) ctx.filter = `blur(${blur.toFixed(1)}px)`;
    content();
  }
  ctx.restore();
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
    ctx.shadowOffsetY = l.shadow.y * S;
  }
}

function drawContent(env: Env, l: Layer, box: Box) {
  switch (l.kind) {
    case "rect": case "ellipse": return drawRect(env, l, box);
    case "path": return drawPath(env, l, box);
    case "text": return drawText(env, l, box);
    case "image": return drawImage(env, l, box);
    case "icon": return drawIcon(env, l, box);
    case "group": for (const c of l.children) drawLayer(env, c); return;
    case "fx": return drawFx(env, l, box);
  }
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
  const path = new Path2D();
  path.addPath(new Path2D(l.d), new DOMMatrix([sx, 0, 0, sy, box.x, box.y]));
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
    ctx.font = `600 ${Math.round(S * 0.032)}px ${familyStack(theme.body.family, theme.bangla.family)}`;
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

function fontCss(env: Env, l: TextLayer, size: number): string {
  const theme = env.scene.theme;
  const ref = l.font === "heading" ? theme.heading : theme.body;
  return `${l.italic ? "italic " : ""}${l.weight ?? ref.weight} ${Math.max(1, Math.round(size * 10) / 10)}px ${familyStack(ref.family, theme.bangla.family)}`;
}

function textOf(env: Env, l: TextLayer): string {
  const sc = env.scene;
  let text = l.field ? fieldValue(sc.template, sc.values, l.field, sc.bangla) : l.text ?? "";
  if (l.counter) {
    const from = parseNumber(fieldValue(sc.template, sc.values, l.counter.from, sc.bangla));
    const to = parseNumber(text);
    if (from && to) {
      const [t0, t1] = l.counter.t;
      const u = ease("out", (env.t - t0) / Math.max(1e-3, t1 - t0), "smooth");
      text = formatNumber(to, from.value + (to.value - from.value) * u);
    }
  }
  return l.upper ? text.toUpperCase() : text;
}

/** A text layer's size, lines and alignment in the shape being drawn. */
function textSpec(env: Env, l: TextLayer) {
  const o = l.textAt?.[shapeOf(env.W, env.H)];
  const size = o?.size ?? l.size;
  return { size, minSize: o?.minSize ?? (o?.size ? size * 0.62 : l.minSize ?? size * 0.62), lines: o?.lines ?? l.lines ?? 3, align: o?.align ?? l.align ?? "center" };
}

function layoutText(env: Env, l: TextLayer, box: Box, text: string, tracking: number) {
  const { ctx, S } = env;
  const spec = textSpec(env, l);
  const key = `${text}\u0000${box.w.toFixed(1)}\u0000${S}\u0000${fontCss(env, l, 10)}\u0000${tracking.toFixed(3)}\u0000${l.animate?.unit ?? ""}\u0000${spec.size}\u0000${spec.lines}`;
  const have = env.mem.texts.get(l.id);
  if (have && have.key === key) return have;
  const max = spec.size * S, min = spec.minSize * S;
  const measureAt = (size: number) => {
    ctx.font = fontCss(env, l, size);
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
  env.mem.texts.set(l.id, done);
  return done;
}

/** Entrance or exit progress (0…1, eased) of unit `i` of `n`. */
function unitProgress(env: Env, a: TextAnimator, i: number, n: number, exit: boolean): number {
  const start = staggerStart(a.t, i, n, a.stagger, a.reverse ?? exit);
  const u = (env.t - start) / Math.max(1e-3, a.duration);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return ease(a.ease ?? (exit ? "in" : "out"), u, env.feel);
}

function drawText(env: Env, l: TextLayer, box: Box) {
  const { ctx } = env;
  const theme = env.scene.theme;
  const text = textOf(env, l);
  if (!text.trim()) return;
  const tracking = at(l.tracking, env, 0);
  const lay = layoutText(env, l, box, text, tracking);
  const size = lay.fit.size;
  const lineH = size * (l.lineHeight ?? 1.12);
  const blockH = lay.units.length * lineH;
  const align = textSpec(env, l).align;
  const top = l.valign === "top" ? box.y : l.valign === "bottom" ? box.y + box.h - blockH : box.y + (box.h - blockH) / 2;
  ctx.font = fontCss(env, l, size);
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
        const f = a.from;
        alpha *= (f.opacity ?? 1) + (1 - (f.opacity ?? 1)) * e;
        ox += (f.dx ?? 0) * size * (1 - e);
        oy += (f.dy ?? 0) * size * (1 - e);
        sc *= (f.scale ?? 1) + (1 - (f.scale ?? 1)) * e;
        rot += (f.rotate ?? 0) * (1 - e);
        bl += (f.blur ?? 0) * size * (1 - e);
      }
      if (l.exit) {
        const a = l.exit, e = unitProgress(env, a, lineUnit(a), count(a), true);
        const f = a.from;
        alpha *= 1 + ((f.opacity ?? 1) - 1) * e;
        ox += (f.dx ?? 0) * size * e;
        oy += (f.dy ?? 0) * size * e;
        sc *= 1 + ((f.scale ?? 1) - 1) * e;
        rot += (f.rotate ?? 0) * e;
        bl += (f.blur ?? 0) * size * e;
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

// ---- effects

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
        const lay = layoutText(env, l, box, text, at(l.tracking, env, 0));
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
