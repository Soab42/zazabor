import { TRANSITION_GROUPS, type TransitionKind } from "../../gallery/slideshow/settings";
import type { LayerDraw, LayerFx } from "./gfx";
import type { LayerPhase } from "./model";

/**
 * Transitions off the main track. A cut on the main track mixes two whole frames in the
 * slideshow's shader; an overlay, text, sticker or template is a layer over the picture, so its
 * transitions move, turn, scale, fade, blur, light or wipe the layer itself (`layerLook`, applied
 * to its draws by `applyLayerLook`). The preview and export both draw through `Engine.compose`,
 * so they look the same. Which clip is part way in or out at a moment is the model's
 * (`layerClipsAt`).
 */

/** The kinds a layer can have: the slideshow's that make sense for one picture over another. */
const LAYER_KINDS = new Set<TransitionKind>([
  "dissolve", "dip", "fadewhite", "wipe", "iris", "flash", "blur", "slide", "push", "whip", "drop",
  "zoom", "punch", "zoomspin", "spin", "flip", "glitch",
]);

/** The Transitions tab's groups for a layer (the same names as for cuts on the main track). */
export const LAYER_TRANSITION_GROUPS = TRANSITION_GROUPS
  .map((g) => ({ label: g.label, items: g.items.filter(([k]) => LAYER_KINDS.has(k)) as [TransitionKind, string][] }))
  .filter((g) => g.items.length);

export const isLayerKind = (kind: TransitionKind) => LAYER_KINDS.has(kind);

/** What a layer looks like part way through a transition, on top of how it's placed. */
export interface LayerLook {
  /** Multiplies its opacity. */
  opacity: number;
  /** Moves it (output pixels). */
  dx: number;
  dy: number;
  /** Scales it about its centre; `sx` narrows it as well (a card turning). */
  scale: number;
  sx: number;
  /** Turns it (radians, clockwise). */
  rotate: number;
  /** Blurs it (the layer shader's mip level). */
  blur: number;
  /** Lightens (+) or darkens (−) it in the layer shader's brightness (2 takes it to white). */
  bright: number;
  /** Shows only this part of it, across (0…1 from the left edge). */
  wipe: { from: number; to: number } | null;
  /** Shows only a circle from its middle, this far grown (0…1 covers it). */
  iris: number | null;
}

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function bounceOut(x: number): number {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}

/** A fixed random number in 0…1 for `n`. */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A layer's look at `phase` on a W×H canvas. Coming in, it settles into place; going out, it
 * leaves the same way it would arrive, played backwards, except that sideways moves carry on
 * (in from the right, out to the left).
 */
export function layerLook(phase: LayerPhase, W: number, H: number): LayerLook {
  const look: LayerLook = { opacity: 1, dx: 0, dy: 0, scale: 1, sx: 1, rotate: 0, blur: 0, bright: 0, wipe: null, iris: null };
  const p = clamp01(phase.p);
  // Coming in, the move slows into place; going out (p runs down to 0), it speeds up away. Across
  // a cut both clips move on one even curve, so they stay side by side (a push pushes).
  const e = phase.cross ? smooth(p) : easeOut(p);
  const s = phase.side === "in" ? 1 : -1;
  switch (phase.kind) {
    case "dip":
      look.opacity = smooth(Math.min(1, p * 2));
      look.bright = -1.6 * (1 - smooth(p));
      break;
    case "fadewhite":
      look.opacity = smooth(Math.min(1, p * 2));
      look.bright = 2 * (1 - smooth(p));
      break;
    case "flash":
      look.opacity = Math.min(1, p * 4);
      look.bright = 2.2 * (1 - p) ** 2;
      break;
    case "blur":
      look.opacity = smooth(p);
      look.blur = 5 * (1 - e);
      break;
    case "wipe": {
      const w = smooth(p);
      look.wipe = phase.side === "in" ? { from: 0, to: w } : { from: 1 - w, to: 1 };
      break;
    }
    case "iris":
      look.iris = e;
      break;
    case "slide":
      look.dx = s * (1 - e) * 0.25 * W;
      look.opacity = smooth(p);
      break;
    case "push":
      look.dx = s * (1 - e) * W;
      break;
    case "whip": {
      const q = p < 0.5 ? 16 * p ** 5 : 1 - (-2 * p + 2) ** 5 / 2;
      look.dx = s * (1 - q) * 0.7 * W;
      look.blur = 6 * (1 - q);
      look.opacity = Math.min(1, p * 3);
      break;
    }
    case "drop":
      // In: falls from above and bounces; out: drops away.
      if (phase.side === "in") look.dy = -(1 - bounceOut(p)) * 0.6 * H;
      else look.dy = (1 - p) ** 2 * 1.1 * H;
      look.opacity = Math.min(1, p * 4);
      break;
    case "zoom":
      look.scale = 0.3 + 0.7 * e;
      look.opacity = smooth(p);
      break;
    case "punch":
      look.scale = 1 + 0.8 * (1 - e);
      look.opacity = smooth(p);
      break;
    case "zoomspin":
      look.scale = Math.max(0.001, e);
      look.rotate = s * (1 - e) * Math.PI;
      look.opacity = Math.min(1, p * 3);
      break;
    case "spin":
      look.rotate = s * (1 - e) * (Math.PI / 2);
      look.scale = 0.75 + 0.25 * e;
      look.blur = 4 * (1 - e);
      look.opacity = smooth(p);
      break;
    case "flip":
      // A card turning to face us: edge-on and dark, then whole.
      look.sx = Math.max(0.001, Math.sin((e * Math.PI) / 2));
      look.bright = -0.7 * (1 - e);
      break;
    case "glitch": {
      if (p >= 1) break;
      const k = Math.floor(p * 24) + (phase.side === "in" ? 0 : 100);
      const left = 1 - p;
      look.dx = (hash(k) - 0.5) * 0.14 * W * left;
      look.dy = (hash(k + 0.37) - 0.5) * 0.04 * H * left;
      look.opacity = hash(k + 0.71) < 0.3 + 0.7 * p ? Math.min(1, 0.35 + p) : 0.12;
      look.bright = (hash(k + 0.53) - 0.4) * left;
      break;
    }
    default:
      // Dissolve, and any kind a layer doesn't have.
      look.opacity = smooth(p);
  }
  return look;
}

/** The layer shader's extras with nothing on (texts and templates have none of their own). */
function plainFx(): LayerFx {
  return {
    sharpen: 0, vignette: 0, grain: 0, effect: 0, amount: 0, local: 0, time: 0, seed: 0,
    key: null, lut: null, lutStrength: 1, mask: null, radius: 0, border: 0, borderColor: [1, 1, 1],
  };
}

/** The soft edge of a wipe or an iris, as a fraction of the layer's shorter side. */
const FEATHER = 0.08;

/** A wipe or an iris as the layer shader's mask on a layer `size` big; null for neither. */
function revealMask(look: LayerLook, size: [number, number]): LayerFx["mask"] {
  const [w, h] = size;
  const side = Math.max(1, Math.min(w, h));
  const f = FEATHER * side;
  if (look.wipe) {
    // Edges moved out by the feather, so 0 hides it all and 1 shows it all.
    const fu = f / Math.max(1, w);
    const left = look.wipe.from * (1 + 2 * fu) - fu, right = look.wipe.to * (1 + 2 * fu) - fu;
    return { shape: 2, rect: [(left + right) / 2, 0.5, (Math.max(0, right - left) * w) / side, (h + 4 * f) / side], feather: FEATHER, invert: false };
  }
  if (look.iris !== null) {
    const across = look.iris * (Math.hypot(w, h) + 2 * f);
    return { shape: 1, rect: [0.5, 0.5, across / side, across / side], feather: FEATHER, invert: false };
  }
  return null;
}

/**
 * A clip's draws (its picture, and a picture-in-picture frame's shadow under it) with a look
 * applied, all about the picture's centre. A clip with a mask of its own fades instead of wiping.
 */
export function applyLayerLook(draws: LayerDraw[], look: LayerLook): LayerDraw[] {
  if (!draws.length) return draws;
  const [px, py] = draws[draws.length - 1].center;
  const cos = Math.cos(look.rotate), sin = Math.sin(look.rotate);
  const k = look.scale;
  // How much of it a wipe or an iris shows, for what can't be masked (shadows, masked clips).
  const shown = look.wipe ? look.wipe.to - look.wipe.from : look.iris ?? 1;
  return draws.map((d) => {
    const ox = (d.center[0] - px) * k * look.sx, oy = (d.center[1] - py) * k;
    const next: LayerDraw = {
      ...d,
      center: [px + ox * cos - oy * sin + look.dx, py + ox * sin + oy * cos + look.dy],
      size: [d.size[0] * k * look.sx, d.size[1] * k],
      rotation: d.rotation + look.rotate,
      opacity: d.opacity * look.opacity,
    };
    if (d.shadow) {
      next.shadow = { box: [d.shadow.box[0] * k * look.sx, d.shadow.box[1] * k], radius: d.shadow.radius * k, softness: d.shadow.softness };
      next.opacity *= shown;
      return next;
    }
    next.blur = d.blur + look.blur;
    next.adjust = [d.adjust[0] + look.bright, d.adjust[1], d.adjust[2]];
    if (d.fx) next.fx = { ...d.fx, radius: d.fx.radius * k, border: d.fx.border * k };
    const mask = revealMask(look, next.size);
    if (mask && d.fx?.mask) next.opacity *= shown;
    else if (mask) {
      next.fx = { ...(next.fx ?? plainFx()), mask };
      // A circle of no size still shows its soft middle.
      if (look.iris !== null) next.opacity *= smooth(Math.min(1, look.iris / 0.15));
    }
    return next;
  });
}
