import type { Focus } from "./focus";
import { KEN_BURNS_MAX, type Framing } from "./settings";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ken Burns motion for one slide, from `from` to `to` over its time on screen.
 *
 * - `fill`: the rects are the visible crop of the image, in normalized image coordinates.
 *   The camera can also roll about the crop's center and bow off the straight path.
 * - `fit`: the rects place the whole image inside the frame (normalized frame coordinates),
 *   over a blurred backdrop cropped by `backFrom`/`backTo` (normalized image coordinates).
 */
export interface Motion {
  mode: "fill" | "fit";
  from: Rect;
  to: Rect;
  backFrom: Rect;
  backTo: Rect;
  /** fill: camera roll at the start and the end, in radians. */
  roll: [number, number];
  /** fill: how far the path bows sideways at its middle, in normalized image units. */
  bow: { x: number; y: number };
  /** Image width over height, to keep a rolled crop inside the photo. */
  aspect: number;
}

/** What the camera sees at one moment. */
export interface Shot {
  /** fill: the crop before roll. fit: the photo's placement in the frame. */
  rect: Rect;
  /** fill: radians the crop turns about its center. */
  roll: number;
  /** fit: the backdrop crop. */
  back: Rect;
}

/** Hints that let a slide's motion follow its content and differ from its neighbors'. */
export interface MotionHints {
  /** The photo's subject (see findFocus). */
  focus?: Focus | null;
  /** The slide's place in the show; consecutive slides get different camera moves. */
  index?: number;
}

/** Deterministic PRNG so a slide keeps its motion when the plan is recomputed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const DEG = Math.PI / 180;

/** The largest crop of the image with the frame's aspect ratio. */
function coverCrop(ratio: number) {
  return ratio >= 1 ? { w: 1 / ratio, h: 1 } : { w: 1, h: ratio };
}

/** Image aspect over frame aspect beyond which a photo is panned across rather than zoomed. */
const SMART_CROP_LIMIT = 1.4;
/** Panoramas up to this many frames wide are panned across rather than fitted. */
const PANORAMA_LIMIT = 3.2;
/** Photos at least this wide for their height count as landscape. */
const LANDSCAPE_ASPECT = 1.1;

/**
 * Camera moves for filled photos, in the order slides get them: pushes alternate with
 * pulls, and lateral moves sit between them so no two neighbors move alike.
 */
const MOVES = ["push", "truck", "pull", "drift", "tilt", "push", "glide", "pull"] as const;
type Move = (typeof MOVES)[number];

export function planMotion(imageAspect: number, frameAspect: number, framing: Framing, strength: number, seed: number,
  hints: MotionHints = {}): Motion {
  const random = mulberry32(seed);
  const ratio = imageAspect / frameAspect;
  const s = clamp(strength, 0, KEN_BURNS_MAX);
  const landscape = imageAspect >= LANDSCAPE_ASPECT;
  // Landscape photos always fill the full width, even inside a wide letterbox; only portraits
  // and extreme panoramas are shown whole over a blurred backdrop.
  const fit = framing === "fit" ||
    (framing === "smart" && (ratio > PANORAMA_LIMIT || (!landscape && ratio < 1 / SMART_CROP_LIMIT)));
  if (fit) return planFit(ratio, imageAspect, s, random, framing === "smart" && ratio < 1);

  const camera = new Camera(coverCrop(ratio), imageAspect);
  const elongated = ratio > SMART_CROP_LIMIT || (!landscape && ratio < 1 / SMART_CROP_LIMIT);
  if (elongated) return planPan(camera, ratio > 1, s, random, hints.focus);
  const index = hints.index ?? Math.floor(random() * MOVES.length);
  const move = MOVES[((index % MOVES.length) + MOVES.length) % MOVES.length];
  return planMove(camera, move, s, random, aimAt(hints.focus, random));
}

/** A camera over the photo: its center (normalized image coordinates), zoom past the cover crop, and roll. */
interface Cam {
  x: number;
  y: number;
  z: number;
  roll: number;
}

/** Frames cameras on one photo, keeping every crop inside it. */
class Camera {
  constructor(readonly base: { w: number; h: number }, readonly aspect: number) {}

  /**
   * Zooms each camera in just enough for its roll, then moves the pair inside the photo,
   * together when possible so the move keeps its length and direction.
   */
  settle(a: Cam, b: Cam): [Cam, Cam] {
    const [ea, eb] = [a, b].map((cam) => {
      const e = rolledExtent(this.rect(cam), cam.roll, this.aspect);
      const k = Math.max(1, e.x * 2, e.y * 2);
      cam.z *= k;
      return { x: e.x / k, y: e.y / k };
    });
    const shift = (p: number, q: number, ep: number, eq: number): [number, number] => {
      const lo = Math.max(ep - p, eq - q), hi = Math.min(1 - ep - p, 1 - eq - q);
      if (lo <= hi) {
        const d = clamp(0, lo, hi);
        return [p + d, q + d];
      }
      return [clamp(p, ep, 1 - ep), clamp(q, eq, 1 - eq)];
    };
    [a.x, b.x] = shift(a.x, b.x, ea.x, eb.x);
    [a.y, b.y] = shift(a.y, b.y, ea.y, eb.y);
    return [a, b];
  }

  rect(cam: Cam): Rect {
    const w = this.base.w / cam.z, h = this.base.h / cam.z;
    return { x: cam.x - w / 2, y: cam.y - h / 2, w, h };
  }

  /** Whether a point of the photo sits well inside the camera's view, clear of the edges. */
  shows(cam: Cam, p: { x: number; y: number }) {
    const r = this.rect(cam);
    return Math.abs(p.x - cam.x) <= r.w * 0.3 && Math.abs(p.y - cam.y) <= r.h * 0.3;
  }

  motion(a: Cam, b: Cam, bow = { x: 0, y: 0 }): Motion {
    [a, b] = this.settle(a, b);
    const from = this.rect(a), to = this.rect(b);
    const motion: Motion = { mode: "fill", from, to, backFrom: from, backTo: to, roll: [a.roll, b.roll], bow, aspect: this.aspect };
    // The ends are inside the photo; make sure the bowed, rolling middle is too, or `contain`
    // would bend the path mid-move. Straight and level always fits.
    for (let tries = 0; !insideAll(motion); tries++) {
      if (tries === 6) {
        motion.bow = { x: 0, y: 0 };
        motion.roll = [0, 0];
        break;
      }
      motion.bow = { x: motion.bow.x / 2, y: motion.bow.y / 2 };
      if (tries >= 2) motion.roll = [motion.roll[0] / 2, motion.roll[1] / 2];
    }
    return motion;
  }
}

/** The subject to aim at: the found focus, leaning on the usual guess as confidence drops. */
function aimAt(focus: Focus | null | undefined, random: () => number) {
  // Subjects usually sit near the upper-middle third.
  const x = 0.5 + (random() - 0.5) * 0.36;
  const y = 0.44 + (random() - 0.5) * 0.24;
  if (!focus) return { x, y, sure: 0 };
  const k = clamp01(focus.weight);
  return { x: x + (focus.x - x) * k, y: y + (focus.y - y) * k, sure: k };
}

/** Pan along the long axis of a panorama (or a tall photo with "fill" framing), toward the subject. */
function planPan(camera: Camera, horizontal: boolean, s: number, random: () => number, focus?: Focus | null): Motion {
  const half = (horizontal ? camera.base.w : camera.base.h) / 2;
  const span = 1 - half * 2;
  const travel = clamp01(s * 1.6) * span;
  // Tall photos tend to have their subject near the top.
  const k = clamp01(focus?.weight ?? 0);
  const prior = horizontal ? 0.5 : 0.4;
  const subject = prior + (((horizontal ? focus?.x : focus?.y) ?? prior) - prior) * k;
  // Keep the subject in the sweep; with no motion this is simply a crop around it.
  const mid = clamp(subject, half + travel / 2, 1 - half - travel / 2);
  // Arrive at the subject when it sits toward one end; otherwise pick a side.
  const lean = subject - mid;
  const forward = Math.abs(lean) > travel * 0.1 ? lean > 0 : random() < (horizontal ? 0.5 : 0.4);
  const dir = forward ? 1 : -1;
  // A slight push keeps a long pan alive and gives the camera room to ease toward the subject
  // on the other axis as well.
  const across = 0.5 + (((horizontal ? focus?.y : focus?.x) ?? 0.5) - 0.5) * k;
  const at = (p: number, q: number, z: number): Cam => (horizontal ? { x: p, y: q, z, roll: 0 } : { x: q, y: p, z, roll: 0 });
  return camera.motion(at(mid - (dir * travel) / 2, 0.5, 1), at(mid + (dir * travel) / 2, across, 1 + 0.03 * s));
}

/** One of the camera moves for a photo that roughly matches the frame. */
function planMove(camera: Camera, move: Move, s: number, random: () => number, aim: { x: number; y: number; sure: number }): Motion {
  const { base } = camera;
  const sign = () => (random() < 0.5 ? -1 : 1);
  // When the frame already crops a lot of the photo (e.g. 3:2 in a 2.39:1 letterbox), zoom less.
  const cropped = Math.min(base.w, base.h) < 0.75;
  const lo = 1 + 0.03 * Math.min(1, s * 4);
  const range = Math.min(0.6, 0.27 * s * (cropped ? 0.55 : 1));
  // How far the camera travels between the whole picture and the subject.
  const reach = Math.min(1, s);
  // Past 100% the camera may end a push (or start a pull) on a slight dutch angle.
  const dutch = s > 1 ? sign() * 0.7 * DEG * (s - 1) : 0;
  // Which way a lateral move goes: toward the subject's side when it is off-center.
  const toward = (offset: number) => (aim.sure > 0.3 && Math.abs(offset) > 0.08 ? Math.sign(offset) : sign());
  // A lateral move, shortened until the subject stays well inside the frame at both ends
  // (near the photo's edge the camera can't center on it, so a long move would cut it off).
  const lateral = (plan: (length: number) => [Cam, Cam]) => {
    let pair = plan(1);
    for (const length of [0.8, 0.64, 0.5]) {
      const [a, b] = camera.settle(...pair);
      if (camera.shows(a, aim) && camera.shows(b, aim)) break;
      pair = plan(length);
    }
    return camera.motion(...pair);
  };

  switch (move) {
    case "push":
    case "pull": {
      // Wide near the middle of the photo, close on the subject.
      const angle = random() * Math.PI * 2;
      const drift = 0.05 * s;
      const wide: Cam = {
        x: aim.x + (0.5 - aim.x) * 0.6 * reach + Math.cos(angle) * drift,
        y: aim.y + (0.5 - aim.y) * 0.6 * reach + Math.sin(angle) * drift,
        z: lo,
        roll: 0,
      };
      const close: Cam = { x: aim.x, y: aim.y, z: lo + range * (move === "pull" ? 1.1 : 1), roll: dutch };
      return move === "push" ? camera.motion(wide, close) : camera.motion(close, wide);
    }
    case "truck":
    case "tilt": {
      // Slide across the photo at a steady zoom, ending with the subject just ahead of center.
      const horizontal = move === "truck";
      const dir = toward(horizontal ? aim.x - 0.5 : aim.y - 0.5);
      // A breath of zoom on top keeps the slide from feeling mechanical.
      const breathIn = random() < 0.5;
      const at = (p: number, zoom: number): Cam => (horizontal ? { x: aim.x + p, y: aim.y, z: zoom, roll: 0 } : { x: aim.x, y: aim.y + p, z: zoom, roll: 0 });
      return lateral((length) => {
        const travel = Math.min(0.3, 0.12 * s) * length;
        const z = Math.max(lo, (horizontal ? base.w : base.h) / (1 - travel));
        const breath = z * (1 + 0.04 * s);
        const [z0, z1] = breathIn ? [z, breath] : [breath, z];
        return [at(-dir * travel * 0.85, z0), at(dir * travel * 0.15, z1)];
      });
    }
    case "glide": {
      // Corner to corner across the subject while pushing in.
      const dx = toward(aim.x - 0.5), dy = toward(aim.y - 0.5);
      return lateral((length) => {
        const tx = Math.min(0.24, 0.09 * s) * length, ty = Math.min(0.2, 0.07 * s) * length;
        const z = Math.max(lo + range * 0.3, base.w / (1 - tx), base.h / (1 - ty));
        const at = (k: number, zoom: number): Cam => ({ x: aim.x + dx * tx * k, y: aim.y + dy * ty * k, z: zoom, roll: 0 });
        return [at(-0.8, z), at(0.2, z * (1 + 0.1 * s))];
      });
    }
    case "drift": {
      // A slow arc past the subject with a gentle roll, like a camera on a gimbal.
      const angle = random() * Math.PI * 2;
      const ux = Math.cos(angle), uy = Math.sin(angle);
      const step = 0.035 * s;
      const roll = sign() * 0.7 * DEG * s;
      const [z0, z1] = random() < 0.6 ? [lo + range * 0.25, lo + range * 0.8] : [lo + range * 0.8, lo + range * 0.25];
      const bend = sign() * 0.03 * s;
      return camera.motion(
        { x: aim.x - ux * step, y: aim.y - uy * step, z: z0, roll: -roll },
        { x: aim.x + ux * step, y: aim.y + uy * step, z: z1, roll },
        { x: -uy * bend, y: ux * bend },
      );
    }
  }
}

/**
 * The whole photo over a frosted backdrop. "Fit" pushes in gently and keeps all of it in view;
 * "smart" (cinematic) gives portraits a bigger move, drifting toward the upper part of the
 * frame where faces usually are.
 */
function planFit(ratio: number, aspect: number, s: number, random: () => number, cinematic: boolean): Motion {
  const beyond = Math.max(0, s - 1);
  // Size the photo to leave a margin of backdrop around it; stronger motion starts it smaller.
  const margin = 0.88 - 0.1 * beyond;
  const w = ratio >= 1 ? margin : margin * ratio;
  const h = ratio >= 1 ? margin / ratio : margin;
  const drift = (random() - 0.5) * 0.04 * s;
  const still = { roll: [0, 0] as [number, number], bow: { x: 0, y: 0 }, aspect };
  if (cinematic) {
    const k1 = 1 + 0.55 * Math.min(1, s) + 0.3 * beyond;
    // As the photo grows past the frame, slide it down so its upper part stays in view.
    const place = (k: number, toward: number): Rect => {
      const overflow = Math.max(0, h * k - 1);
      return { x: 0.5 - (w * k) / 2 + drift * toward, y: 0.5 - (h * k) / 2 + overflow * 0.35, w: w * k, h: h * k };
    };
    const base = coverCrop(ratio);
    const back = (z: number) => rectAround(0.5, 0.42, base.w / z, base.h / z);
    return { mode: "fit", from: place(1, 0), to: place(k1, 1), backFrom: back(1.05), backTo: back(1.05 + 0.3 * s), ...still };
  }
  // Never grow the photo past the frame: "fit" promises all of it stays in view.
  const push = Math.min(1 + 0.16 * s, (1 - 2 * Math.abs(drift)) / w, 1 / h);
  const zoomIn = random() < 0.75;
  const [k0, k1] = zoomIn ? [1, push] : [push, 1];
  const place = (k: number, toward: number): Rect => ({ x: 0.5 - (w * k) / 2 + drift * toward, y: 0.5 - (h * k) / 2, w: w * k, h: h * k });
  const base = coverCrop(ratio);
  const back = (z: number) => rectAround(0.5, 0.5, base.w / z, base.h / z);
  return { mode: "fit", from: place(k0, 0), to: place(k1, 1), backFrom: back(1.08), backTo: back(1.08 + 0.2 * s), ...still };
}

/** A w×h rect centered near (cx, cy), pushed back inside the unit square. */
function rectAround(cx: number, cy: number, w: number, h: number): Rect {
  return { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
}

/** Gentle ease: mostly constant speed (as Ken Burns motion should be) with softened ends. */
export function motionEase(u: number) {
  const t = clamp01(u);
  return t + (t * t * (3 - 2 * t) - t) * 0.5;
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t };
}

/**
 * Progress between two sizes that zooms at a steady perceived speed (equal ratios in equal
 * times). Moving the whole rect by it also keeps the point the zoom closes in on still.
 */
function zoomPace(from: number, to: number, t: number) {
  if (Math.abs(to / from - 1) < 1e-4) return t;
  return (from * Math.pow(to / from, t) - from) / (to - from);
}

/** The rect, before roll; the bow is added in, but not yet kept inside the photo. */
function rawShot(m: Motion, t: number) {
  const rect = lerpRect(m.from, m.to, zoomPace(m.from.w, m.to.w, t));
  const bend = Math.sin(Math.PI * t);
  rect.x += m.bow.x * bend;
  rect.y += m.bow.y * bend;
  return { rect, roll: m.roll[0] + (m.roll[1] - m.roll[0]) * t };
}

/** Half the size of a rolled crop's bounding box, in normalized image units. */
function rolledExtent(r: Rect, roll: number, aspect: number) {
  const c = Math.abs(Math.cos(roll)), s = Math.abs(Math.sin(roll));
  return { x: (r.w * c + (r.h / aspect) * s) / 2, y: (r.w * aspect * s + r.h * c) / 2 };
}

/** Shrinks and nudges a rolled crop until all of it lies on the photo. */
function contain(r: Rect, roll: number, aspect: number): Rect {
  const e = rolledExtent(r, roll, aspect);
  const k = Math.max(1, e.x * 2, e.y * 2);
  const w = r.w / k, h = r.h / k;
  const cx = clamp(r.x + r.w / 2, e.x / k, 1 - e.x / k);
  const cy = clamp(r.y + r.h / 2, e.y / k, 1 - e.y / k);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Whether the whole path stays on the photo without `contain` stepping in. */
function insideAll(m: Motion) {
  for (let i = 1; i < 32; i++) {
    const { rect, roll } = rawShot(m, i / 32);
    const e = rolledExtent(rect, roll, m.aspect);
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const slack = 1e-9;
    if (cx - e.x < -slack || cx + e.x > 1 + slack || cy - e.y < -slack || cy + e.y > 1 + slack) return false;
  }
  return true;
}

/** Where the camera is at eased progress `t`. */
export function shotAt(m: Motion, t: number): Shot {
  const back = lerpRect(m.backFrom, m.backTo, zoomPace(m.backFrom.w, m.backTo.w, t));
  if (m.mode === "fit") return { rect: lerpRect(m.from, m.to, zoomPace(m.from.w, m.to.w, t)), roll: 0, back };
  const { rect, roll } = rawShot(m, t);
  return { rect: contain(rect, roll, m.aspect), roll, back };
}

/** Letterbox bar height (fraction of the screen, per side) for a 2.39:1 picture. */
export function letterboxBars(screenAspect: number, enabled: boolean) {
  if (!enabled) return 0;
  return Math.max(0, (1 - screenAspect / 2.39) / 2);
}
