import type { Aspect } from "../app";
import type { LookId, TransitionKind } from "../../gallery/slideshow/settings";

/**
 * The Video Editor's project: canvas, media and tracks, and the edits on them. Everything here
 * is plain data and pure functions (no DOM), so it can be tested on its own. Times are seconds.
 *
 * Tracks are stored in drawing order: `tracks[0]` is the main video track (magnetic: its clips
 * follow each other with no gaps), then overlay and text tracks bottom to top, then audio.
 */

export type MediaKind = "video" | "image" | "audio";

export interface Media {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  /** Seconds; 0 for pictures. */
  duration: number;
  /** As shown (rotation applied). */
  width: number;
  height: number;
  fps: number;
  /** Has a sound stream. */
  audio: boolean;
  /** Set when a saved project's file can't be found. */
  missing?: boolean;
  /** Why it can't be used fully ("No decoder for the sound"). */
  note?: string;
  /** The file's size when it was added (finding it again after it moved). */
  bytes?: number;
}

export interface Placement {
  /** Centre, as fractions of the canvas. */
  x: number;
  y: number;
  /** 1 = fitted (or filling) the canvas. */
  scale: number;
  /** Degrees clockwise. */
  rotation: number;
  opacity: number;
}

/** CapCut-style effects on a clip; `Fx.amount` sets how strong. */
export type EffectId = "none" | "shake" | "pulse" | "glitch" | "rgb" | "vhs" | "mirror" | "flash" | "blurin";

export interface ChromaKey {
  /** The colour taken out (#rrggbb). */
  color: string;
  /** 0…1: how far from the colour still goes. */
  tolerance: number;
  /** 0…1: the soft edge. */
  softness: number;
  /** 0…1: takes the colour's cast off what's left. */
  spill: number;
}

export interface Lut {
  /** A .cube file. */
  path: string;
  name: string;
  /** 0…1. */
  strength: number;
}

export interface Fx {
  look: LookId | "none";
  /** −1…1, 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 0…1 each. */
  blur: number;
  sharpen: number;
  vignette: number;
  grain: number;
  effect: EffectId;
  amount: number;
  lut: Lut | null;
  key: ChromaKey | null;
}

/** A shape that shows part of a clip, in the clip's own picture (0…1 across and down). */
export interface Mask {
  shape: "circle" | "rect";
  x: number;
  y: number;
  /** Width and height, as fractions of the picture's shorter side (equal: a circle or a square). */
  w: number;
  h: number;
  /** Soft edge, as a fraction of the picture's shorter side. */
  feather: number;
  invert: boolean;
}

/** Picture in picture: rounded corners, a border and a shadow around an overlay. */
export interface Frame {
  /** Corner radius as a fraction of the shorter side (0…0.5). */
  radius: number;
  /** Border width in thousandths of the canvas height. */
  border: number;
  color: string;
  /** 0…1. */
  shadow: number;
}

/** What can be animated with keyframes. */
export type KeyProp = "x" | "y" | "scale" | "rotation" | "opacity" | "volume";
export const KEY_PROPS: readonly KeyProp[] = ["x", "y", "scale", "rotation", "opacity", "volume"];

/** How a keyframe moves on to the next one. */
export type Ease = "linear" | "smooth" | "in" | "out" | "hold";

export interface Keyframe {
  /** Seconds from the clip's start. */
  t: number;
  v: number;
  ease: Ease;
}

export type Keys = Partial<Record<KeyProp, Keyframe[]>>;

/** CapCut's curve speeds: the clip's speed changes over its length. */
export type CurvePreset = "montage" | "hero" | "bullet" | "jumpcut" | "flashin" | "flashout";

export interface SpeedCurve {
  preset: CurvePreset;
  /** Speed factors at evenly spaced points over the clip (on top of `speed`). */
  points: number[];
}

export interface Transition {
  kind: TransitionKind;
  duration: number;
}

export interface MediaClip {
  id: string;
  type: "media";
  media: string;
  /** On the timeline. */
  start: number;
  duration: number;
  /** Where the clip starts in its file. */
  in: number;
  speed: number;
  /** 0…2. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** How the picture meets the canvas: covering it, or whole inside it. */
  fit: "fill" | "fit";
  place: Placement;
  fx: Fx;
  /** Ken Burns motion on a picture. */
  motion: boolean;
  /** Into this clip from the one before (main track). */
  transition?: Transition;
  keys?: Keys;
  mask?: Mask | null;
  frame?: Frame | null;
  /** Plays backwards. */
  reverse?: boolean;
  /** A freeze frame: this moment of the file (seconds) stays on screen, without sound. */
  freeze?: number;
  curve?: SpeedCurve | null;
  /** Music: how far it goes down under voice-overs (0 = not at all, 1 = silent). */
  duck?: number;
  /** A voice-over recorded in the editor. */
  role?: "voice";
  /** Beats in the file (seconds), marked from its sound. */
  beats?: number[];
}

export type TextAnim = "none" | "fade" | "pop" | "slide" | "typewriter" | "bounce";

export interface TextStyle {
  font: string;
  /** Thousandths of the canvas height. */
  size: number;
  color: string;
  stroke: string | null;
  /** Thousandths of the font size × 10 (so 80 = 8% of the size). */
  strokeWidth: number;
  /** A box behind the text. */
  box: string | null;
  shadow: boolean;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

export interface TextClip {
  id: string;
  type: "text";
  start: number;
  duration: number;
  text: string;
  style: TextStyle;
  place: Placement;
  animIn: TextAnim;
  animOut: TextAnim;
  keys?: Keys;
}

export type Clip = MediaClip | TextClip;
export type TrackKind = "main" | "overlay" | "text" | "audio";

export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
  muted: boolean;
  hidden: boolean;
}

export interface Canvas {
  aspect: Aspect;
  fps: number;
  /** "blur" (the clip itself, blurred), or a colour. */
  background: string;
}

export interface Project {
  app: "corevideo";
  version: 1;
  canvas: Canvas;
  media: Media[];
  tracks: Track[];
}

/** The shortest a clip can be. */
export const MIN_CLIP = 0.1;
/** A picture's length when it's added. */
export const PICTURE_SECONDS = 3;
export const TEXT_SECONDS = 3;

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Export (and canvas) sizes for each shape: 1080p and 720p. Widths are multiples of 8. */
export function canvasSize(aspect: Aspect, short = 1080): { width: number; height: number } {
  const [a, b] = aspect.split(":").map(Number);
  const round = (v: number, m: number) => Math.round(v / m) * m;
  if (a >= b) return { width: round((short * a) / b, 8), height: short };
  return { width: short, height: round((short * b) / a, 2) };
}

export function newProject(aspect: Aspect): Project {
  return {
    app: "corevideo",
    version: 1,
    canvas: { aspect, fps: 30, background: "blur" },
    media: [],
    tracks: [{ id: uid(), kind: "main", clips: [], muted: false, hidden: false }],
  };
}

export const defaultPlace = (): Placement => ({ x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 });
export const defaultFx = (): Fx => ({
  look: "none", brightness: 0, contrast: 0, saturation: 0, blur: 0, sharpen: 0, vignette: 0, grain: 0, effect: "none", amount: 0.6, lut: null, key: null,
});
export const defaultMask = (): Mask => ({ shape: "circle", x: 0.5, y: 0.5, w: 0.6, h: 0.6, feather: 0.04, invert: false });
export const defaultFrame = (): Frame => ({ radius: 0.08, border: 6, color: "#ffffff", shadow: 0.5 });

export function mediaClip(media: Media, start: number): MediaClip {
  return {
    id: uid(),
    type: "media",
    media: media.id,
    start,
    duration: media.kind === "image" ? PICTURE_SECONDS : Math.max(MIN_CLIP, media.duration),
    in: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    fit: "fill",
    place: defaultPlace(),
    fx: defaultFx(),
    motion: media.kind === "image",
  };
}

export const clipEnd = (c: Clip) => c.start + c.duration;

export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export const mainTrack = (p: Project) => p.tracks[0];
export const mediaOf = (p: Project, id: string) => p.media.find((m) => m.id === id);

export function findClip(p: Project, id: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

// ---- speed curves

export const CURVE_PRESETS: Record<CurvePreset, { label: string; points: number[] }> = {
  montage: { label: "Montage", points: [1, 1.8, 0.4, 1.8, 0.4, 1.8, 1] },
  hero: { label: "Hero", points: [1.5, 1.5, 0.22, 0.22, 1.5, 1.5] },
  bullet: { label: "Bullet", points: [2.5, 2.5, 0.12, 2.5, 2.5] },
  jumpcut: { label: "Jump cut", points: [0.6, 3, 0.6, 3, 0.6] },
  flashin: { label: "Flash in", points: [5, 2, 1, 1, 1] },
  flashout: { label: "Flash out", points: [1, 1, 1, 2, 5] },
};

/** The curve's factor at `u` (0…1 along the clip), straight lines between its points. */
export function curveAt(points: number[], u: number): number {
  if (points.length < 2) return points[0] ?? 1;
  const x = Math.max(0, Math.min(1, u)) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(x));
  return points[i] + (points[i + 1] - points[i]) * (x - i);
}

/** ∫₀ᵘ of the curve: how far through its file a curved clip has got at `u` (in clip lengths). */
export function curveIntegral(points: number[], u: number): number {
  if (points.length < 2) return (points[0] ?? 1) * u;
  const n = points.length - 1;
  const x = Math.max(0, Math.min(1, u)) * n;
  let sum = 0;
  for (let i = 0; i < n && i < x; i++) {
    const w = Math.min(1, x - i);
    const a = points[i], b = a + (points[i + 1] - a) * w;
    sum += ((a + b) / 2) * w;
  }
  return sum / n;
}

/** The average factor of a clip's speed curve (1 without one). */
export const curveMean = (c: MediaClip) => (c.curve ? curveIntegral(c.curve.points, 1) : 1);

/** Seconds of its file a clip plays. */
export const sourceSpan = (c: MediaClip) => (c.freeze !== undefined ? 0 : c.duration * c.speed * curveMean(c));

/** Seconds of the file played `local` seconds into the clip (counted from its in-point, forwards). */
function sourceOffset(c: MediaClip, local: number): number {
  if (c.curve) return c.speed * c.duration * curveIntegral(c.curve.points, local / Math.max(1e-6, c.duration));
  return local * c.speed;
}

/** The speed the file plays at `local` seconds into the clip. */
export const speedAt = (c: MediaClip, local: number) => c.speed * (c.curve ? curveAt(c.curve.points, local / Math.max(1e-6, c.duration)) : 1);

/** Seconds into the clip's file at timeline time `t`. */
export function sourceTime(c: MediaClip, t: number): number {
  if (c.freeze !== undefined) return c.freeze;
  const o = sourceOffset(c, t - c.start);
  return c.reverse ? c.in + sourceSpan(c) - o : c.in + o;
}

/** How long the clip may last from its in-point: the rest of its file at its speed. */
export function maxDuration(c: MediaClip, m: Media | undefined): number {
  if (!m || m.kind === "image" || c.freeze !== undefined) return Infinity;
  return Math.max(MIN_CLIP, (m.duration - c.in) / (c.speed * curveMean(c)));
}

// ---- keyframes

/** Two keyframes closer than this are at the same moment (half a frame at 30 fps). */
export const KEY_EPS = 1 / 60;

export function eased(e: Ease, u: number): number {
  const x = Math.max(0, Math.min(1, u));
  switch (e) {
    case "hold": return 0;
    case "in": return x * x * x;
    case "out": return 1 - (1 - x) ** 3;
    case "smooth": return x * x * (3 - 2 * x);
    default: return x;
  }
}

/** A keyed value at `local` seconds into a clip; `fallback` when there are no keyframes. */
export function keyValue(keys: Keyframe[] | undefined, local: number, fallback: number): number {
  if (!keys?.length) return fallback;
  if (local <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (local >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= local) i++;
  const a = keys[i], b = keys[i + 1];
  return a.v + (b.v - a.v) * eased(a.ease, (local - a.t) / Math.max(1e-9, b.t - a.t));
}

/** The value a property has without keyframes. */
export function baseValue(c: Clip, prop: KeyProp): number {
  if (prop === "volume") return c.type === "media" ? c.volume : 1;
  return c.place[prop];
}

export function propAt(c: Clip, prop: KeyProp, local: number): number {
  return keyValue(c.keys?.[prop], local, baseValue(c, prop));
}

/** Where a clip is `local` seconds into it, keyframes applied. */
export function placeAt(c: Clip, local: number): Placement {
  if (!c.keys) return c.place;
  return {
    x: propAt(c, "x", local), y: propAt(c, "y", local), scale: propAt(c, "scale", local),
    rotation: propAt(c, "rotation", local), opacity: propAt(c, "opacity", local),
  };
}

export const hasKeys = (c: Clip, prop: KeyProp) => !!c.keys?.[prop]?.length;

export function keyAt(c: Clip, prop: KeyProp, local: number): Keyframe | undefined {
  return c.keys?.[prop]?.find((k) => Math.abs(k.t - local) <= KEY_EPS);
}

/** Adds a keyframe (or changes the one at that moment). */
export function setKey(c: Clip, prop: KeyProp, local: number, v: number, ease?: Ease) {
  const t = Math.max(0, Math.min(c.duration, local));
  c.keys ??= {};
  const list = (c.keys[prop] ??= []);
  const have = list.find((k) => Math.abs(k.t - t) <= KEY_EPS);
  if (have) {
    have.v = v;
    if (ease) have.ease = ease;
  } else {
    list.push({ t, v, ease: ease ?? "smooth" });
    list.sort((a, b) => a.t - b.t);
  }
}

export function removeKey(c: Clip, prop: KeyProp, local: number) {
  const list = c.keys?.[prop];
  if (!list) return;
  const i = list.findIndex((k) => Math.abs(k.t - local) <= KEY_EPS);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) delete c.keys![prop];
  if (c.keys && !Object.keys(c.keys).length) delete c.keys;
}

/**
 * Sets a property the way the inspector and the canvas do: with keyframes on it, the keyframe at
 * `local` (made if needed); without, the plain value.
 */
export function setProp(c: Clip, prop: KeyProp, local: number, v: number) {
  if (hasKeys(c, prop)) return setKey(c, prop, local, v);
  if (prop === "volume") {
    if (c.type === "media") c.volume = v;
  } else c.place[prop] = v;
}

/** Every moment with a keyframe, in order. */
export function keyTimes(c: Clip): number[] {
  const out: number[] = [];
  for (const list of Object.values(c.keys ?? {})) {
    for (const k of list ?? []) if (!out.some((t) => Math.abs(t - k.t) <= KEY_EPS)) out.push(k.t);
  }
  return out.sort((a, b) => a - b);
}

/** Moves every keyframe by `dt` (the clip's start moved, its picture didn't). */
export function shiftKeys(c: Clip, dt: number) {
  for (const list of Object.values(c.keys ?? {})) for (const k of list ?? []) k.t += dt;
}

/** Keeps the keyframes inside a clip `duration` long (the last one outside stays at the edge). */
function clipKeys(c: Clip, from: number, to: number) {
  if (!c.keys) return;
  for (const prop of Object.keys(c.keys) as KeyProp[]) {
    const list = c.keys[prop]!;
    const inside = list.filter((k) => k.t >= from - KEY_EPS && k.t <= to + KEY_EPS);
    // The values at the cut, so the motion carries on from where it was.
    const at = (t: number) => ({ t, v: keyValue(list, t, 0), ease: "linear" as Ease });
    if (list.some((k) => k.t < from - KEY_EPS) && !inside.some((k) => Math.abs(k.t - from) <= KEY_EPS)) inside.unshift(at(from));
    if (list.some((k) => k.t > to + KEY_EPS) && !inside.some((k) => Math.abs(k.t - to) <= KEY_EPS)) inside.push(at(to));
    c.keys[prop] = inside;
  }
}

/** Main track: clips one after another from 0. */
export function layoutMain(p: Project) {
  let at = 0;
  for (const c of mainTrack(p).clips) {
    c.start = at;
    at += c.duration;
  }
  fitTransitions(p);
}

/** The longest a transition into main clip `i` may be (it borrows from both sides of the cut). */
export function maxTransition(track: Track, i: number): number {
  const a = track.clips[i - 1], b = track.clips[i];
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.duration, b.duration) * 0.9);
}

function fitTransitions(p: Project) {
  const main = mainTrack(p);
  main.clips.forEach((c, i) => {
    if (c.type !== "media" || !c.transition) return;
    if (i === 0) delete c.transition;
    else c.transition.duration = Math.min(c.transition.duration, maxTransition(main, i));
  });
}

/** Drops empty tracks (the main track stays). */
export function tidyTracks(p: Project) {
  p.tracks = p.tracks.filter((t, i) => i === 0 || t.clips.length > 0);
}

const overlaps = (track: Track, start: number, end: number, except?: string) =>
  track.clips.some((c) => c.id !== except && c.start < end - 1e-6 && clipEnd(c) > start + 1e-6);

/** Where a new track of `kind` goes: audio at the end, overlays below text, text on top of the pictures. */
function insertTrack(p: Project, kind: Exclude<TrackKind, "main">): Track {
  const track: Track = { id: uid(), kind, clips: [], muted: false, hidden: false };
  const order: Record<TrackKind, number> = { main: 0, overlay: 1, text: 2, audio: 3 };
  let at = p.tracks.length;
  for (let i = p.tracks.length - 1; i >= 1; i--) {
    if (order[p.tracks[i].kind] > order[kind]) at = i;
  }
  p.tracks.splice(at, 0, track);
  return track;
}

/** A new empty track of `kind`, where tracks of its kind go. */
export const newTrack = (p: Project, kind: Exclude<TrackKind, "main">): Track => insertTrack(p, kind);

/** Puts a clip on the first track of `kind` with room at its time, or on a new one. */
export function placeFree(p: Project, clip: Clip, kind: Exclude<TrackKind, "main">, prefer?: string): Track {
  const candidates = p.tracks.filter((t) => t.kind === kind);
  const preferred = candidates.find((t) => t.id === prefer);
  const ordered = preferred ? [preferred, ...candidates.filter((t) => t !== preferred)] : candidates;
  const track = ordered.find((t) => !overlaps(t, clip.start, clipEnd(clip), clip.id)) ?? insertTrack(p, kind);
  track.clips.push(clip);
  track.clips.sort((a, b) => a.start - b.start);
  return track;
}

/** Adds a clip to the main track before clip `index` (at the end by default). */
export function insertMain(p: Project, clip: MediaClip, index = mainTrack(p).clips.length) {
  const main = mainTrack(p);
  main.clips.splice(Math.max(0, Math.min(index, main.clips.length)), 0, clip);
  layoutMain(p);
}

/** The main-track index a clip dropped at `t` goes to: before the clip whose middle is after t. */
export function mainIndexAt(p: Project, t: number, except?: string): number {
  const clips = mainTrack(p).clips.filter((c) => c.id !== except);
  const i = clips.findIndex((c) => t < c.start + c.duration / 2);
  return i < 0 ? clips.length : i;
}

/** Splits a clip at timeline time `t`; returns the new right part. */
export function split(p: Project, id: string, t: number): Clip | null {
  const found = findClip(p, id);
  if (!found) return null;
  const { track, clip, index } = found;
  if (t <= clip.start + MIN_CLIP / 2 || t >= clipEnd(clip) - MIN_CLIP / 2) return null;
  const left = t - clip.start;
  const right = structuredClone(clip) as Clip;
  right.id = uid();
  right.start = t;
  right.duration = clip.duration - left;
  if (right.type === "media" && clip.type === "media" && clip.freeze === undefined) {
    // A curve is flattened into two plain speeds that play the same parts of the file.
    const total = sourceSpan(clip);
    const done = sourceOffset(clip, left);
    if (clip.curve) {
      clip.speed = done / left;
      right.speed = (total - done) / right.duration;
      clip.curve = null;
      right.curve = null;
    }
    if (clip.reverse) {
      right.in = clip.in;
      clip.in = clip.in + total - done;
    } else {
      right.in = clip.in + done;
    }
  }
  clip.duration = left;
  if (right.type === "media" && clip.type === "media") {
    delete right.transition;
    right.fadeIn = 0;
    clip.fadeOut = 0;
  }
  if (clip.keys) {
    clipKeys(clip, 0, left);
    clipKeys(right, left, left + right.duration);
    shiftKeys(right, -left);
  }
  track.clips.splice(index + 1, 0, right);
  if (track.kind === "main") layoutMain(p);
  return right;
}

/** Removes clips. The main track always closes the gap; other tracks only with `ripple`. */
export function remove(p: Project, ids: string[], ripple = false) {
  for (const id of ids) {
    const found = findClip(p, id);
    if (!found) continue;
    const { track, clip, index } = found;
    track.clips.splice(index, 1);
    if (track.kind !== "main" && ripple) {
      for (const c of track.clips) if (c.start >= clipEnd(clip) - 1e-6) c.start -= clip.duration;
    }
  }
  layoutMain(p);
  tidyTracks(p);
}

/**
 * Moves the left edge of a clip to `t` (its end stays where it is, except on the main track,
 * where the clips after it follow). Returns the edge's new time.
 */
export function trimStart(p: Project, id: string, t: number): number {
  const found = findClip(p, id);
  if (!found) return t;
  const { track, clip, index } = found;
  const end = clipEnd(clip);
  let delta = t - clip.start;
  delta = Math.min(delta, clip.duration - MIN_CLIP);
  if (clip.type === "media" && clip.freeze === undefined) {
    const m = mediaOf(p, clip.media);
    const rate = clip.speed * curveMean(clip);
    if (m && m.kind !== "image") delta = Math.max(delta, clip.reverse ? -(m.duration - clip.in - sourceSpan(clip)) / rate : -clip.in / rate);
  }
  if (track.kind !== "main") {
    // Not into the clip before it.
    const before = track.clips[index - 1];
    delta = Math.max(delta, (before ? clipEnd(before) : 0) - clip.start);
  }
  if (clip.type === "media" && clip.freeze === undefined && !clip.reverse) clip.in = Math.max(0, clip.in + delta * clip.speed * curveMean(clip));
  shiftKeys(clip, -delta);
  if (track.kind === "main") {
    clip.duration -= delta;
    layoutMain(p);
    return clip.start;
  }
  clip.start += delta;
  clip.duration = end - clip.start;
  return clip.start;
}

/** Moves the right edge of a clip to `t`. Returns the edge's new time. */
export function trimEnd(p: Project, id: string, t: number): number {
  const found = findClip(p, id);
  if (!found) return t;
  const { track, clip, index } = found;
  let duration = Math.max(MIN_CLIP, t - clip.start);
  if (clip.type === "media" && !clip.reverse) duration = Math.min(duration, maxDuration(clip, mediaOf(p, clip.media)));
  if (track.kind !== "main") {
    const after = track.clips[index + 1];
    if (after) duration = Math.min(duration, after.start - clip.start);
  }
  duration = Math.max(MIN_CLIP, duration);
  if (clip.type === "media" && clip.reverse && clip.freeze === undefined) {
    // Backwards, the clip's end is the file's in-point: keep the start where it was instead.
    const before = sourceSpan(clip);
    const m = mediaOf(p, clip.media);
    const room = m && m.kind !== "image" ? (before + clip.in) / (clip.speed * curveMean(clip)) : Infinity;
    duration = Math.min(duration, room);
    clip.duration = duration;
    clip.in = Math.max(0, clip.in + before - sourceSpan(clip));
  } else clip.duration = duration;
  if (track.kind === "main") layoutMain(p);
  return clipEnd(clip);
}

/** Moves a clip on a free track (overlay, text, audio) to `start` on `trackId` (same kind). */
export function moveFree(p: Project, id: string, start: number, trackId?: string): void {
  const found = findClip(p, id);
  if (!found || found.track.kind === "main") return;
  const { track, clip, index } = found;
  const target = p.tracks.find((t) => t.id === trackId && t.kind === track.kind) ?? track;
  clip.start = Math.max(0, start);
  track.clips.splice(index, 1);
  if (overlaps(target, clip.start, clipEnd(clip), clip.id)) placeFree(p, clip, track.kind as Exclude<TrackKind, "main">);
  else {
    target.clips.push(clip);
    target.clips.sort((a, b) => a.start - b.start);
  }
  tidyTracks(p);
}

/** Moves a main-track clip to position `index` among the others. */
export function moveMain(p: Project, id: string, index: number) {
  const main = mainTrack(p);
  const from = main.clips.findIndex((c) => c.id === id);
  if (from < 0) return;
  const [clip] = main.clips.splice(from, 1);
  main.clips.splice(Math.max(0, Math.min(index, main.clips.length)), 0, clip);
  layoutMain(p);
}

/** The time nearest `t` among edges, the playhead and 0, within `range`; else `t`. */
export function snap(p: Project, t: number, range: number, except: string[] = [], extra: number[] = []): number {
  let best = t, distance = range;
  const consider = (v: number) => {
    const d = Math.abs(v - t);
    if (d < distance) {
      distance = d;
      best = v;
    }
  };
  consider(0);
  for (const v of extra) consider(v);
  for (const track of p.tracks) {
    for (const c of track.clips) {
      if (except.includes(c.id)) continue;
      consider(c.start);
      consider(clipEnd(c));
      for (const b of beatTimes(c)) consider(b);
    }
  }
  return best;
}

/** A clip's beat marks on the timeline. */
export function beatTimes(c: Clip): number[] {
  if (c.type !== "media" || !c.beats?.length || c.freeze !== undefined) return [];
  const span = sourceSpan(c);
  const out: number[] = [];
  for (const b of c.beats) {
    if (b < c.in - 1e-6 || b > c.in + span + 1e-6) continue;
    // Plain speed only: curved clips don't show beats.
    if (c.curve) continue;
    const local = c.reverse ? (c.in + span - b) / c.speed : (b - c.in) / c.speed;
    out.push(c.start + local);
  }
  return out;
}

/** The clip of a track showing at `t`. */
export function clipAt(track: Track, t: number): Clip | undefined {
  return track.clips.find((c) => t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6);
}

/** What the canvas shows at time `t`. */
export interface Scene {
  /** The main track's clip, and during a transition the next one with progress 0…1. */
  a: MediaClip | null;
  b: MediaClip | null;
  transition: Transition | null;
  progress: number;
  /** Overlay pictures and texts, bottom to top. */
  layers: Clip[];
}

export function sceneAt(p: Project, t: number): Scene {
  const scene: Scene = { a: null, b: null, transition: null, progress: 0, layers: [] };
  const main = mainTrack(p);
  if (!main.hidden) {
    const clips = main.clips as MediaClip[];
    const i = clips.findIndex((c) => t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6);
    if (i >= 0) {
      scene.a = clips[i];
      // A transition is centred on its cut: the end of clip i or the start of clip i.
      const next = clips[i + 1], cur = clips[i];
      const into = (c: MediaClip | undefined) => (c?.transition && c.transition.duration > 0 ? c.transition : null);
      const tn = into(next);
      const tc = into(cur);
      if (next && tn && t >= next.start - tn.duration / 2) {
        scene.a = cur;
        scene.b = next;
        scene.transition = tn;
        scene.progress = (t - (next.start - tn.duration / 2)) / tn.duration;
      } else if (tc && i > 0 && t < cur.start + tc.duration / 2) {
        scene.a = clips[i - 1];
        scene.b = cur;
        scene.transition = tc;
        scene.progress = (t - (cur.start - tc.duration / 2)) / tc.duration;
      }
      scene.progress = Math.max(0, Math.min(1, scene.progress));
    }
  }
  for (const track of p.tracks.slice(1)) {
    if (track.hidden || track.kind === "audio") continue;
    const c = clipAt(track, t);
    if (c) scene.layers.push(c);
  }
  return scene;
}

/** Seconds into the file for a clip at `t`, kept inside the file (transitions read past cuts). */
export function clampedSource(c: MediaClip, m: Media | undefined, t: number): number {
  const s = sourceTime(c, t);
  if (!m || m.kind === "image") return Math.max(0, s);
  const last = Math.max(0, m.duration - 1 / Math.max(1, m.fps || 30));
  return Math.max(0, Math.min(last, s));
}

/** Clips with sound that play at some point, with their tracks (for the audio mix). */
export function audibleClips(p: Project): MediaClip[] {
  const out: MediaClip[] = [];
  for (const track of p.tracks) {
    if (track.muted || track.kind === "text") continue;
    for (const c of track.clips) {
      if (c.type !== "media" || c.freeze !== undefined || (c.volume <= 0 && !c.keys?.volume)) continue;
      const m = mediaOf(p, c.media);
      if (m?.audio && !m.missing) out.push(c);
    }
  }
  return out;
}

/** Media no clip uses. */
export function unusedMedia(p: Project): Media[] {
  const used = new Set<string>();
  for (const t of p.tracks) for (const c of t.clips) if (c.type === "media") used.add(c.media);
  return p.media.filter((m) => !used.has(m.id));
}

function normalizeKeys(raw: unknown): Keys | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Keys = {};
  for (const prop of KEY_PROPS) {
    const list = (raw as Keys)[prop];
    if (!Array.isArray(list)) continue;
    const ok = list.filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.v)).map((k) => ({ t: k.t, v: k.v, ease: (["linear", "smooth", "in", "out", "hold"] as Ease[]).includes(k.ease) ? k.ease : "smooth" as Ease }));
    if (ok.length) out[prop] = ok.sort((a, b) => a.t - b.t);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Makes a parsed project file safe to use: missing fields get defaults. */
export function normalizeProject(raw: unknown, fallbackAspect: Aspect = "9:16"): Project {
  const r = (raw ?? {}) as Partial<Project>;
  const p = newProject((r.canvas?.aspect as Aspect) ?? fallbackAspect);
  if (r.canvas) {
    p.canvas.fps = [24, 25, 30, 50, 60].includes(Number(r.canvas.fps)) ? Number(r.canvas.fps) : 30;
    p.canvas.background = typeof r.canvas.background === "string" ? r.canvas.background : "blur";
  }
  p.media = Array.isArray(r.media) ? r.media.filter((m) => m && typeof m.id === "string" && typeof m.path === "string") : [];
  const tracks = Array.isArray(r.tracks) ? r.tracks.filter((t) => t && Array.isArray(t.clips)) : [];
  const main = tracks.find((t) => t.kind === "main");
  if (main) p.tracks[0] = { ...main, muted: !!main.muted, hidden: !!main.hidden };
  for (const t of tracks) if (t !== main && ["overlay", "text", "audio"].includes(t.kind)) p.tracks.push({ ...t, muted: !!t.muted, hidden: !!t.hidden });
  for (const t of p.tracks) {
    t.clips = t.clips.filter((c) => c && (c.type === "text" || (c.type === "media" && p.media.some((m) => m.id === c.media))));
    for (const c of t.clips) {
      c.place = { ...defaultPlace(), ...(c.place ?? {}) };
      c.keys = normalizeKeys(c.keys);
      if (!c.keys) delete c.keys;
      if (c.type === "media") {
        c.fx = { ...defaultFx(), ...(c.fx ?? {}) };
        if (c.curve && (!Array.isArray(c.curve.points) || c.curve.points.length < 2 || !c.curve.points.every((v) => Number.isFinite(v) && v > 0))) c.curve = null;
        if (c.freeze !== undefined && !Number.isFinite(c.freeze)) delete c.freeze;
        if (c.beats && !Array.isArray(c.beats)) delete c.beats;
      }
    }
    t.clips.sort((a, b) => a.start - b.start);
  }
  layoutMain(p);
  return p;
}
