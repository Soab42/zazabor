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

export interface Fx {
  look: LookId | "none";
  /** −1…1, 0 = unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
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
export const defaultFx = (): Fx => ({ look: "none", brightness: 0, contrast: 0, saturation: 0 });

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

/** Seconds into the clip's file at timeline time `t`. */
export const sourceTime = (c: MediaClip, t: number) => c.in + (t - c.start) * c.speed;

/** How long the clip may last from its in-point: the rest of its file at its speed. */
export function maxDuration(c: MediaClip, m: Media | undefined): number {
  if (!m || m.kind === "image") return Infinity;
  return Math.max(MIN_CLIP, (m.duration - c.in) / c.speed);
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
  clip.duration = left;
  if (right.type === "media" && clip.type === "media") {
    right.in = clip.in + left * clip.speed;
    delete right.transition;
    right.fadeIn = 0;
    clip.fadeOut = 0;
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
  if (clip.type === "media") {
    const m = mediaOf(p, clip.media);
    if (m && m.kind !== "image") delta = Math.max(delta, -clip.in / clip.speed);
  }
  if (track.kind !== "main") {
    // Not into the clip before it.
    const before = track.clips[index - 1];
    delta = Math.max(delta, (before ? clipEnd(before) : 0) - clip.start);
  }
  if (clip.type === "media") clip.in = Math.max(0, clip.in + delta * clip.speed);
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
  if (clip.type === "media") duration = Math.min(duration, maxDuration(clip, mediaOf(p, clip.media)));
  if (track.kind !== "main") {
    const after = track.clips[index + 1];
    if (after) duration = Math.min(duration, after.start - clip.start);
  }
  clip.duration = Math.max(MIN_CLIP, duration);
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
    }
  }
  return best;
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
      if (c.type !== "media" || c.volume <= 0) continue;
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
      if (c.type === "media") c.fx = { ...defaultFx(), ...(c.fx ?? {}) };
    }
    t.clips.sort((a, b) => a.start - b.start);
  }
  layoutMain(p);
  return p;
}
