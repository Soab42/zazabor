import { api } from "../../../api";
import { readText } from "../../../shared/quicklook/api";
import { GRADES, TRANSITION_IDS } from "../../gallery/slideshow/settings";
import { editApi } from "./api";
import { CURVE_RATE, gainCurve, rateCurve, steadyGain, voiceWindows, clipGain, type Windows } from "./audio";
import { Compositor, SHADER_EFFECTS, type LayerDraw, type LayerFx, type Lut3D, type Source } from "./gfx";
import { parseCube } from "./lut";
import {
  audibleClips, clampedSource, clipEnd, mainTrack, mediaOf, placeAt, projectDuration, sceneAt, sourceSpan, sourceTime,
  type Clip, type Media, type MediaClip, type Project, type TextClip,
} from "./model";
import { PEAK_RATE, type MediaStore } from "./media";
import { drawText, textKey, textLook } from "./text";
import { drawSticker, stickerHeight, stickerImage, stickerOf, type Sticker } from "./stickers";
import { MotionRenderer } from "./motion/render";
import { familiesLoadedIn, loadFamiliesIn } from "./motion/fonts";

/**
 * Plays a project: the clock (Web Audio's, so sound and picture share it), the sound graph, and
 * the pictures for each moment: decoded frames from the backend (one decoder per clip, read
 * ahead while playing), pictures and texts, all drawn by the compositor.
 */

interface Slot {
  source: Source | null;
  busy: boolean;
  /** The source time wanted while a request was out. */
  pending: number | null;
  /** The source time `source` was asked for. */
  time: number | null;
  used: number;
  failed: boolean;
}

const LOOKAHEAD = 0.8;
const IDLE_RELEASE_MS = 15000;
/** Decode sizes as fractions of the file's size, so small changes don't reopen decoders. */
const DECODE_STEPS = [0.25, 0.375, 0.5, 0.75, 1];

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Smooth noise in −1…1 (for camera shake). */
function noise(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const h = (n: number) => hash(`${n}:${seed}`);
  const u = f * f * (3 - 2 * f);
  return (h(i) * (1 - u) + h(i + 1) * u) * 2 - 1;
}

/** A .cube file this big isn't a colour table. */
const LUT_BYTES = 16 * 1024 * 1024;

function parseColor(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Where a picture of `m` goes on a W×H canvas, before the clip's own placement. */
export function baseSize(m: Media, fit: "fill" | "fit", W: number, H: number): [number, number] {
  const sa = m.width / Math.max(1, m.height), ca = W / H;
  const cover = fit === "fill";
  if (sa > ca === cover) return [H * sa, H];
  return [W, W / sa];
}

/** The layer rectangle of a media clip at `local` seconds into it. */
export function placeMedia(c: MediaClip, m: Media, W: number, H: number, local: number): { center: [number, number]; size: [number, number]; rotation: number; opacity: number } {
  const [w, h] = baseSize(m, c.fit, W, H);
  const place = placeAt(c, local);
  let scale = place.scale;
  let cx = place.x * W, cy = place.y * H;
  let rotation = place.rotation;
  const amount = c.fx.amount;
  if (c.fx.effect === "shake") {
    const seed = hash(c.id) * 1000;
    cx += noise(local * 14, seed) * W * 0.025 * amount;
    cy += noise(local * 14 + 31, seed) * H * 0.02 * amount;
    rotation += noise(local * 9 + 7, seed) * 2.5 * amount;
    scale *= 1 + 0.04 * amount;
  } else if (c.fx.effect === "pulse") {
    const phase = (local % 0.5) / 0.5;
    scale *= 1 + 0.08 * amount * Math.exp(-phase * 5);
  }
  if (m.kind === "image" && c.motion) {
    // Ken Burns: a slow zoom with a drift, its direction fixed per clip.
    const r = hash(c.id);
    const u = Math.max(0, Math.min(1, local / Math.max(0.1, c.duration)));
    const zoomIn = r < 0.5;
    const z = 1.04 + 0.14 * (zoomIn ? u : 1 - u);
    scale *= z;
    const angle = r * Math.PI * 6;
    cx += Math.cos(angle) * W * 0.035 * (u - 0.5);
    cy += Math.sin(angle) * H * 0.035 * (u - 0.5);
  }
  return { center: [cx, cy], size: [w * scale, h * scale], rotation: (rotation * Math.PI) / 180, opacity: place.opacity };
}

export interface EngineHost {
  project(): Project;
  store: MediaStore;
  /** Decoder keys start with this (one prefix per open project). */
  prefix: string;
  /** Output volume 0…1. */
  volume(): number;
  /** The playhead moved while playing, or playback stopped. */
  onTime(t: number): void;
  onPlayState(playing: boolean): void;
}

export class Engine {
  readonly gfx: Compositor;
  /** Template clips (motion templates). */
  readonly motion: MotionRenderer;
  time = 0;
  playing = false;
  private slots = new Map<string, Slot>();
  private pictures = new Map<string, Source>();
  private texts = new Map<string, { canvas: HTMLCanvasElement; key: string; source: Source | null; size: { width: number; height: number } }>();
  private luts = new Map<string, Lut3D | null>();
  private lutLoads = new Map<string, Promise<void>>();
  /** Playback measurements (frames drawn, frames that showed an older picture than due). */
  readonly stats = { frames: 0, stale: 0, since: performance.now() };
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private clockStart = 0;
  private timeStart = 0;
  private raf = 0;
  private dirty = true;
  private sweep = 0;
  private width = 0;
  private height = 0;
  private disposed = false;
  /** How long a frame takes to arrive (seconds, smoothed): playback asks that far ahead. */
  private lead = 0.03;
  /** Export owns the compositor: the preview doesn't draw. */
  private held = false;
  /** A clip whose chroma key is off while its colour is picked from the preview. */
  keyOff: string | null = null;

  constructor(readonly canvas: HTMLCanvasElement, private host: EngineHost) {
    this.gfx = new Compositor(canvas);
    this.motion = new MotionRenderer(this.gfx, () => this.invalidate());
    this.sweep = window.setInterval(() => this.releaseIdle(), 5000);
  }

  /** The composition size for the preview (the canvas's pixels). */
  setSize(width: number, height: number) {
    width = Math.max(8, Math.round(width / 8) * 8);
    height = Math.max(8, Math.round(height / 2) * 2);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.invalidate();
  }

  get size() {
    return { width: this.width, height: this.height };
  }

  /** The project changed: draw again, and rebuild the sound graph if playing. */
  invalidate(sound = false) {
    this.dirty = true;
    if (sound && this.playing) this.startSound(this.time);
    this.kick();
  }

  private kick() {
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.loop);
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(t, projectDuration(this.host.project())));
    if (this.playing) this.startSound(this.time);
    this.dirty = true;
    this.kick();
  }

  play() {
    if (this.playing) return;
    const end = projectDuration(this.host.project());
    if (end <= 0) return;
    if (this.time >= end - 0.02) this.time = 0;
    this.playing = true;
    this.startSound(this.time);
    this.host.onPlayState(true);
    this.kick();
  }

  pause() {
    if (!this.playing) return;
    this.time = this.clock();
    this.playing = false;
    this.stopSound();
    this.host.onPlayState(false);
    this.dirty = true;
    this.kick();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  setVolume(v: number) {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  // ---- sound

  private audio(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
    } catch {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.host.volume();
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Timeline time now (the sound's clock while playing). */
  private clock(): number {
    if (!this.playing) return this.time;
    const ctx = this.ctx;
    const now = ctx && ctx.state === "running" ? ctx.currentTime : performance.now() / 1000;
    const latency = ctx && ctx.state === "running" ? (ctx.outputLatency || ctx.baseLatency || 0) : 0;
    return Math.max(this.timeStart, this.timeStart + (now - this.clockStart) - latency);
  }

  private stopSound() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // already stopped
      }
      n.disconnect();
    }
    this.nodes = [];
  }

  /** Schedules every audible clip from timeline time `t0`. */
  private startSound(t0: number) {
    this.stopSound();
    const ctx = this.audio();
    this.timeStart = t0;
    if (!ctx || !this.master) {
      this.clockStart = performance.now() / 1000;
      return;
    }
    if (ctx.state === "suspended") void ctx.resume();
    const when0 = ctx.currentTime + 0.06;
    this.clockStart = ctx.state === "running" ? when0 : performance.now() / 1000;
    const p = this.host.project();
    const windows = duckWindows(p, this.host.store);
    for (const c of audibleClips(p)) {
      const end = clipEnd(c);
      if (end <= t0) continue;
      const m = mediaOf(p, c.media)!;
      const sound = c.reverse ? this.host.store.reversedNow(m) : this.host.store.soundNow(m);
      if (sound === undefined) {
        // Not decoded yet: start it, and rebuild the graph when it's ready.
        void (c.reverse ? this.host.store.reversed(m) : this.host.store.sound(m)).then(() => {
          if (this.playing && !this.disposed) this.startSound(this.clock());
        });
        continue;
      }
      if (!sound) continue;
      const node = playClip(ctx, this.master, sound, c, t0, when0, windows);
      if (node) this.nodes.push(node);
    }
  }

  // ---- pictures

  private slot(key: string): Slot {
    let s = this.slots.get(key);
    if (!s) {
      s = { source: null, busy: false, pending: null, time: null, used: performance.now(), failed: false };
      this.slots.set(key, s);
    }
    s.used = performance.now();
    return s;
  }

  private decodeBox(m: Media, need: [number, number]): [number, number] {
    const f = Math.max(need[0] / Math.max(1, m.width), need[1] / Math.max(1, m.height));
    const q = DECODE_STEPS.find((s) => s >= f) ?? 1;
    return [Math.ceil(m.width * q), Math.ceil(m.height * q)];
  }

  /** Asks for a clip's frame; the newest wish wins while a request is out. */
  private request(key: string, m: Media, time: number, need: [number, number]): Promise<void> {
    const slot = this.slot(key);
    if (slot.failed) return Promise.resolve();
    if (slot.busy) {
      slot.pending = time;
      return Promise.resolve();
    }
    return this.fetch(key, slot, m, time, need);
  }

  private async fetch(key: string, slot: Slot, m: Media, time: number, need: [number, number]): Promise<void> {
    slot.busy = true;
    const [maxWidth, maxHeight] = this.decodeBox(m, need);
    const asked = performance.now();
    try {
      const frame = await editApi.frame({ key, path: m.path, time, width: m.width, height: m.height, maxWidth, maxHeight, have: slot.source?.pts ?? null });
      if (this.disposed) return;
      if (this.playing) this.lead = Math.min(0.12, this.lead * 0.8 + ((performance.now() - asked) / 1000 + 1 / 60) * 0.2);
      if (frame.data || !slot.source) slot.source = this.gfx.uploadFrame(slot.source, frame);
      slot.time = time;
      this.dirty = true;
      this.kick();
    } catch (err) {
      console.warn("[video-editor] frame", m.name, err);
      slot.failed = true;
      window.setTimeout(() => (slot.failed = false), 3000);
    } finally {
      slot.busy = false;
    }
    if (slot.pending !== null) {
      const next = slot.pending;
      slot.pending = null;
      if (Math.abs(next - time) > 1e-4) await this.fetch(key, slot, m, next, need);
    }
  }

  private picture(m: Media): Source | null {
    const have = this.pictures.get(m.id);
    if (have) return have;
    void this.host.store.picture(m).then((img) => {
      if (this.disposed || this.pictures.has(m.id)) return;
      this.pictures.set(m.id, this.gfx.uploadImage(null, img));
      this.dirty = true;
      this.kick();
    }).catch(() => undefined);
    return null;
  }

  private text(c: TextClip, W: number, H: number, chars: number, word: number, exact: Promise<void>[] | null) {
    const key = textKey(c, H, chars, word);
    let t = this.texts.get(c.id);
    if (!t) {
      t = { canvas: document.createElement("canvas"), key: "", source: null, size: { width: 0, height: 0 } };
      this.texts.set(c.id, t);
    }
    if (t.key !== key) {
      if (c.sticker) {
        const sticker = stickerOf(c.sticker);
        const img = sticker ? this.stickerReady(sticker, c.style.color, exact) : null;
        if (!sticker || !img) return t;
        t.size = drawSticker(t.canvas, sticker, img, stickerHeight(c.style.size, H));
      } else {
        if (!familiesLoadedIn(c.style.font)) {
          // Bundled fonts (texts made from templates) load first; the text is drawn again then.
          const loading = loadFamiliesIn(c.style.font).then(() => {
            const held = this.texts.get(c.id);
            if (held) held.key = "";
            this.invalidate();
          });
          if (exact) exact.push(loading);
        }
        t.size = drawText(t.canvas, c, W, H, chars, word);
      }
      t.source = this.gfx.uploadImage(t.source, t.canvas);
      t.key = key;
    }
    return t;
  }

  private stickerImages = new Map<string, HTMLImageElement>();

  /** A sticker's picture once it's loaded; until then asks for it (export waits for it). */
  private stickerReady(s: Sticker, color: string, exact: Promise<void>[] | null): HTMLImageElement | null {
    const key = `${s.id}\u0000${s.tint ? color : ""}`;
    const have = this.stickerImages.get(key);
    if (have) return have;
    const loading = stickerImage(s, color).then((img) => {
      this.stickerImages.set(key, img);
      if (this.disposed) return;
      this.dirty = true;
      this.kick();
    });
    if (exact) exact.push(loading.catch(() => undefined));
    loading.catch((err) => this.report(err));
    return null;
  }

  /** The draws for a media clip at timeline time `t`, asking for frames as needed. */
  private mediaLayer(c: MediaClip, t: number, W: number, H: number, keyPrefix: string, exact: Promise<void>[] | null, background: boolean, fetch: boolean): LayerDraw[] {
    const p = this.host.project();
    const m = mediaOf(p, c.media);
    if (!m || m.missing || m.kind === "audio") return [];
    const local = t - c.start;
    const place = placeMedia(c, m, W, H, local);
    if (place.opacity <= 0.001) return [];
    let source: Source | null = null;
    if (m.kind === "image") {
      source = this.picture(m);
      if (!source && exact) exact.push(this.host.store.picture(m).then(() => undefined));
    } else {
      const key = `${keyPrefix}${c.id}`;
      // While playing, ask for the frame that will be due when the answer arrives.
      const time = clampedSource(c, m, this.playing && !exact ? Math.min(t + this.lead, clipEnd(c) - 1e-3) : t);
      const need: [number, number] = [Math.min(place.size[0], W * 1.5), Math.min(place.size[1], H * 1.5)];
      // Exporting: a frame already here (asked for ahead by `warm`) needs no second trip. The
      // time it was asked for counts too: with millisecond timestamps (WebM), 2/30 s falls just
      // before the frame stamped 0.067.
      const slot = this.slots.get(key);
      const held = slot?.source;
      const covered = !!exact && !!held && !slot.busy && (slot.time === time || (time >= held.pts - 1e-4 && time < held.pts + (held.dur ?? 0) - 1e-4));
      if (fetch && !covered) {
        const wait = this.request(key, m, time, need);
        if (exact) exact.push(wait);
      }
      source = this.slots.get(key)?.source ?? null;
      if (source && this.playing && !exact) {
        this.stats.frames++;
        if (Math.abs(source.pts - clampedSource(c, m, t)) > 1.5 / Math.max(10, m.fps || 30)) this.stats.stale++;
      }
    }
    if (!source) return [];
    const look = c.fx.look !== "none" ? GRADES[c.fx.look] : null;
    const fx = this.layerFx(c, local, t, place.size, H, exact);
    let blur = c.fx.blur * 5;
    if (c.fx.effect === "blurin") blur += c.fx.amount * 6 * (1 - Math.min(1, local / 0.6));
    const draw: LayerDraw = {
      source, center: place.center, size: place.size, rotation: place.rotation, opacity: place.opacity,
      grade: look, adjust: [c.fx.brightness, c.fx.contrast, c.fx.saturation], blur, dim: 0, fx,
    };
    const draws: LayerDraw[] = [];
    if (background && this.host.project().canvas.background === "blur") {
      const [bw, bh] = baseSize(m, "fill", W, H);
      const covers = c.fit === "fill" && placeAt(c, local).scale >= 1 && !c.mask && !c.fx.key && Math.abs(place.center[0] - W / 2) < 1 && Math.abs(place.center[1] - H / 2) < 1 && place.rotation === 0 && place.opacity >= 1;
      if (!covers) draws.push({ ...draw, center: [W / 2, H / 2], size: [bw * 1.08, bh * 1.08], rotation: 0, opacity: 1, blur: 4.5, dim: 0.28, fx: undefined });
    }
    if (c.frame && c.frame.shadow > 0) {
      const soft = H * (0.012 + 0.03 * c.frame.shadow);
      draws.push({
        ...draw, fx: undefined, center: [place.center[0], place.center[1] + H * 0.01], size: [place.size[0] + soft * 4, place.size[1] + soft * 4],
        opacity: place.opacity * 0.65 * Math.min(1, c.frame.shadow * 1.4),
        shadow: { box: [place.size[0] / 2, place.size[1] / 2], radius: fx.radius, softness: soft },
      });
    }
    draws.push(draw);
    return draws;
  }

  /** A media clip's extras for the layer shader. Export waits (`exact`) for a colour table still loading. */
  private layerFx(c: MediaClip, local: number, t: number, size: [number, number], H: number, exact: Promise<void>[] | null): LayerFx {
    const f = c.fx;
    let lut: Lut3D | null = null;
    if (f.lut && f.lut.strength > 0) {
      const have = this.luts.get(f.lut.path);
      if (have !== undefined) lut = have;
      else {
        const loading = this.loadLut(f.lut.path);
        if (exact) exact.push(loading);
      }
    }
    const key = f.key && this.keyOff !== c.id ? [...parseColor(f.key.color), f.key.tolerance * 0.25, f.key.softness * 0.15, f.key.spill] as LayerFx["key"] : null;
    const mask = c.mask ? { shape: c.mask.shape === "circle" ? 1 as const : 2 as const, rect: [c.mask.x, c.mask.y, c.mask.w, c.mask.h] as [number, number, number, number], feather: c.mask.feather, invert: c.mask.invert } : null;
    const fr = c.frame;
    return {
      sharpen: f.sharpen, vignette: f.vignette, grain: f.grain,
      effect: SHADER_EFFECTS[f.effect] ?? 0, amount: f.amount, local, time: t, seed: hash(c.id) * 100,
      key, lut, lutStrength: f.lut?.strength ?? 1, mask,
      radius: fr ? fr.radius * Math.min(size[0], size[1]) : 0,
      border: fr ? (fr.border / 1000) * H : 0,
      borderColor: fr ? parseColor(fr.color) : [1, 1, 1],
    };
  }

  /** Reads and uploads a .cube colour table once; a broken one draws without it. */
  private loadLut(path: string): Promise<void> {
    let p = this.lutLoads.get(path);
    if (p) return p;
    p = readText(path, LUT_BYTES).then((file) => {
      if (this.disposed) return;
      const cube = parseCube(file.text);
      this.luts.set(path, this.gfx.uploadLut(cube.size, cube.data));
    }).catch((err) => {
      console.warn("[video-editor] colour table", path, err);
      this.luts.set(path, null);
    }).finally(() => {
      this.dirty = true;
      this.kick();
    });
    this.lutLoads.set(path, p);
    return p;
  }

  /** A colour table changed on disk or was replaced: read it again. */
  forgetLut(path: string) {
    const have = this.luts.get(path);
    if (have) this.gfx.releaseLut(have);
    this.luts.delete(path);
    this.lutLoads.delete(path);
  }

  /**
   * Draws the frame at `t` into the compositor at W×H. `exact` collects what's still loading
   * (export waits for it, then draws again with `fetch` off); the preview draws what it has.
   */
  compose(t: number, W: number, H: number, keyPrefix: string, exact: Promise<void>[] | null, fetch = true) {
    const p = this.host.project();
    this.gfx.resize(W, H);
    const scene = sceneAt(p, t);
    const bg = p.canvas.background === "blur" ? [0, 0, 0] as [number, number, number] : parseColor(p.canvas.background);
    const a = scene.a ? this.mediaLayer(scene.a, t, W, H, keyPrefix, exact, true, fetch) : [];
    this.gfx.drawInto("a", a, bg);
    let kind = -1;
    if (scene.b && scene.transition) {
      this.gfx.drawInto("b", this.mediaLayer(scene.b, t, W, H, keyPrefix, exact, true, fetch), bg);
      kind = TRANSITION_IDS[scene.transition.kind] ?? 0;
    }
    this.gfx.combine(kind, scene.progress, scene.b ? hash(scene.b.id) : 0, t);
    const over: LayerDraw[] = [];
    for (const layer of scene.layers) {
      if (layer.type === "media") over.push(...this.mediaLayer(layer, t, W, H, keyPrefix, exact, false, fetch));
      else if (layer.type === "template") over.push(...this.motion.layer(p, layer, t, W, H, exact, exact !== null || !fetch));
      else over.push(...this.textLayer(layer, t, W, H, exact));
    }
    this.gfx.drawInto("c", over, null);
    if (!exact && fetch) this.prefetch(t, W, H, keyPrefix);
  }

  /**
   * Export: asks for the frames time `t` will need without drawing, so they decode while the
   * frame before is read back and sent. Resolves when they're all here.
   */
  warm(t: number, W: number, H: number, keyPrefix: string): Promise<void> {
    const p = this.host.project();
    const scene = sceneAt(p, t);
    const clips = [scene.a, scene.b, ...scene.layers].filter((c): c is MediaClip => !!c && c.type === "media");
    const waits: Promise<void>[] = [];
    for (const c of clips) {
      const m = mediaOf(p, c.media);
      if (!m || m.missing || m.kind !== "video") continue;
      const place = placeMedia(c, m, W, H, t - c.start);
      if (place.opacity <= 0.001) continue;
      waits.push(this.request(`${keyPrefix}${c.id}`, m, clampedSource(c, m, t), [Math.min(place.size[0], W * 1.5), Math.min(place.size[1], H * 1.5)]));
    }
    return Promise.all(waits).then(() => undefined);
  }

  private textLayer(c: TextClip, t: number, W: number, H: number, exact: Promise<void>[] | null): LayerDraw[] {
    const look = textLook(c, t - c.start);
    const place = placeAt(c, t - c.start);
    if (look.opacity <= 0.001 || look.scale <= 0.001 || place.opacity <= 0.001) return [];
    const drawn = this.text(c, W, H, c.sticker ? -1 : look.chars, look.word, exact);
    if (!drawn.source) return [];
    const s = place.scale * look.scale;
    return [{
      source: drawn.source,
      center: [place.x * W, (place.y + look.dy) * H],
      size: [drawn.size.width * s, drawn.size.height * s],
      rotation: (place.rotation * Math.PI) / 180,
      opacity: place.opacity * look.opacity,
      grade: null, adjust: [0, 0, 0], blur: 0, dim: 0,
    }];
  }

  /**
   * The topmost clip under a point of the preview (composition pixels) at `t`: texts and
   * overlays first, then the main track's clip.
   */
  clipAtPoint(t: number, x: number, y: number): Clip | null {
    const p = this.host.project();
    const { width: W, height: H } = this;
    const scene = sceneAt(p, t);
    const inside = (center: [number, number], size: [number, number], rotation: number) => {
      const dx = x - center[0], dy = y - center[1];
      const c = Math.cos(-rotation), s = Math.sin(-rotation);
      const lx = c * dx - s * dy, ly = s * dx + c * dy;
      return Math.abs(lx) <= size[0] / 2 && Math.abs(ly) <= size[1] / 2;
    };
    for (const layer of [...scene.layers].reverse()) {
      if (layer.type === "text") {
        const drawn = this.texts.get(layer.id);
        if (!drawn) continue;
        const look = textLook(layer, t - layer.start);
        const place = placeAt(layer, t - layer.start);
        const s = place.scale * look.scale;
        if (inside([place.x * W, (place.y + look.dy) * H], [drawn.size.width * s, drawn.size.height * s], (place.rotation * Math.PI) / 180)) return layer;
      } else if (layer.type === "template") {
        if (this.motion.hit(layer, t, x, y, W, H)) return layer;
      } else {
        const m = mediaOf(p, layer.media);
        if (!m) continue;
        const r = placeMedia(layer, m, W, H, t - layer.start);
        if (inside(r.center, r.size, r.rotation)) return layer;
      }
    }
    return scene.a;
  }

  /** Warms up decoders of clips about to start, so cuts don't stall. */
  private prefetch(t: number, W: number, H: number, keyPrefix: string) {
    if (!this.playing) return;
    const p = this.host.project();
    for (const track of p.tracks) {
      if (track.hidden || track.kind === "audio" || track.kind === "text") continue;
      const next = track.clips.find((c) => c.start > t && c.start - t < LOOKAHEAD) as Clip | undefined;
      if (!next || next.type !== "media") continue;
      const m = mediaOf(p, next.media);
      if (!m || m.kind !== "video" || m.missing) continue;
      const place = placeMedia(next, m, W, H, 0);
      void this.request(`${keyPrefix}${next.id}`, m, clampedSource(next, m, next.start), [Math.min(place.size[0], W * 1.5), Math.min(place.size[1], H * 1.5)]);
    }
  }

  /** The preview's colour at a point (composition pixels), as #rrggbb. */
  colorAt(x: number, y: number): string | null {
    const px = this.gfx.readPixel(x, y);
    return px ? `#${px.map((v) => v.toString(16).padStart(2, "0")).join("")}` : null;
  }

  /** Draws the current frame now (after a change the eyedropper must see). */
  drawNow() {
    if (this.width <= 0) return;
    this.compose(Math.min(this.time, Math.max(0, projectDuration(this.host.project()) - 1e-3)), this.width, this.height, this.host.prefix, null, false);
    this.gfx.present();
  }

  /** Stops (or resumes) drawing the preview while export uses the compositor. */
  hold(on: boolean) {
    this.held = on;
    if (on) this.pause();
    else this.invalidate();
  }

  private loop = () => {
    this.raf = 0;
    if (this.disposed || this.held) return;
    const p = this.host.project();
    if (this.playing) {
      this.time = this.clock();
      const end = projectDuration(p);
      if (this.time >= end) {
        this.time = end;
        this.playing = false;
        this.stopSound();
        this.host.onPlayState(false);
      }
      this.host.onTime(this.time);
    }
    if ((this.dirty || this.playing) && this.width > 0) {
      this.dirty = false;
      try {
        this.compose(Math.min(this.time, Math.max(0, projectDuration(p) - 1e-3)), this.width, this.height, this.host.prefix, null);
        this.gfx.present();
      } catch (err) {
        this.report(err);
      }
    }
    if (this.playing || this.dirty) this.kick();
    if (import.meta.env.DEV && this.playing && performance.now() - this.stats.since > 5000) this.logStats();
  };

  /** Development builds: how smoothly the last few seconds played (in the app's log). */
  private logStats() {
    const seconds = (performance.now() - this.stats.since) / 1000;
    const { frames, stale } = this.stats;
    if (frames) void api.log("info", `[video-editor] playback ${this.width}x${this.height}: ${(frames / seconds).toFixed(1)} clip frames/s, ${((stale / frames) * 100).toFixed(1)}% late, lead ${(this.lead * 1000).toFixed(0)} ms`).catch(() => undefined);
    this.stats.frames = 0;
    this.stats.stale = 0;
    this.stats.since = performance.now();
  }

  private reported = new Set<string>();

  /** A drawing error, logged once (the preview keeps going with the next frame). */
  private report(err: unknown) {
    const text = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    if (this.reported.has(text)) return;
    this.reported.add(text);
    console.error("[video-editor] drawing", err);
    void api.log("error", `[video-editor] ${text}`).catch(() => undefined);
  }

  /** Closes decoders and textures nothing used for a while. */
  private releaseIdle() {
    const now = performance.now();
    const stale: string[] = [];
    for (const [key, slot] of this.slots) {
      if (now - slot.used > IDLE_RELEASE_MS && !slot.busy) {
        stale.push(key);
        if (slot.source) this.gfx.release(slot.source);
        this.slots.delete(key);
      }
    }
    if (stale.length) void editApi.release(stale).catch(() => undefined);
    const p = this.host.project();
    this.motion.sweep(p);
    for (const [id, t] of this.texts) {
      if (!p.tracks.some((tr) => tr.clips.some((c) => c.id === id))) {
        if (t.source) this.gfx.release(t.source);
        this.texts.delete(id);
      }
    }
  }

  /** Drops the export's decoders and their textures. */
  releasePrefix(prefix: string) {
    for (const [key, slot] of this.slots) {
      if (!key.startsWith(prefix)) continue;
      if (slot.source) this.gfx.release(slot.source);
      this.slots.delete(key);
    }
    void editApi.release([], prefix).catch(() => undefined);
  }

  /** A picture was replaced or a clip's file relinked: forget what was drawn from it. */
  forgetMedia(id: string) {
    const s = this.pictures.get(id);
    if (s) this.gfx.release(s);
    this.pictures.delete(id);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.sweep);
    this.stopSound();
    void this.ctx?.close().catch(() => undefined);
    void editApi.release([], this.host.prefix).catch(() => undefined);
    for (const lut of this.luts.values()) if (lut) this.gfx.releaseLut(lut);
    this.motion.dispose();
    this.gfx.dispose();
  }
}

/**
 * Plays one clip from timeline time `t0` on a graph whose clock reads `when0` at `t0`: its gain
 * (volume keyframes, fades, ducking), its speed or speed curve, backwards from a reversed buffer.
 */
export function playClip(ctx: BaseAudioContext, out: AudioNode, sound: { buffer: AudioBuffer }, c: MediaClip, t0: number, when0: number, windows: Windows): AudioBufferSourceNode | null {
  const end = clipEnd(c);
  const from = Math.max(c.start, t0);
  if (end - from < 0.005) return null;
  const buffer = sound.buffer;
  // Where in the (maybe reversed) buffer the clip is at `from`, and how much of it is left.
  const s = sourceTime(c, from);
  const offset = c.reverse ? buffer.duration - s : s;
  const left = c.reverse ? s - c.in : c.in + sourceSpan(c) - s;
  if (offset >= buffer.duration || left <= 0.001) return null;
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  const at = when0 + (from - t0);
  const rates = rateCurve(c, from);
  if (rates) node.playbackRate.setValueCurveAtTime(rates, at, end - from);
  else node.playbackRate.value = c.speed;
  const gain = ctx.createGain();
  if (steadyGain(c, windows)) gain.gain.setValueAtTime(clipGain(c, from, windows), at);
  else gain.gain.setValueCurveAtTime(gainCurve(c, from, windows), at, end - from);
  node.connect(gain).connect(out);
  node.start(at, Math.max(0, offset), left);
  node.stop(at + (end - from) + 1 / CURVE_RATE);
  return node;
}

/** When voice-overs are heard (from their waveforms once decoded), for ducking the music. */
export function duckWindows(p: Project, store: MediaStore): Windows {
  if (!p.tracks.some((t) => t.clips.some((c) => c.type === "media" && !!c.duck))) return [];
  return voiceWindows(p, (c, t) => {
    const m = mediaOf(p, c.media);
    const sound = m ? store.soundNow(m) : null;
    // Not decoded yet: count it as speaking.
    if (!sound) return true;
    const i = Math.floor(sourceTime(c, t) * PEAK_RATE);
    return (sound.peaks[i] ?? 0) / 255 * propAt01(c, t) > 0.12;
  });
}

/** A clip's volume at timeline time `t`, at most 1 (for telling speech from silence). */
function propAt01(c: MediaClip, t: number): number {
  return Math.min(1, Math.max(0, clipGain(c, t, [])));
}

/** Renders the whole sound mix offline (for export): interleaved 16-bit stereo at 48 kHz. */
export async function mixdown(p: Project, store: MediaStore, seconds: number): Promise<Uint8Array> {
  const length = Math.max(1, Math.ceil(seconds * 48000));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: 48000 });
  const clips = audibleClips(p);
  // Every sound decoded first, so ducking sees the voice-overs' waveforms.
  await Promise.all(clips.map((c) => {
    const m = mediaOf(p, c.media)!;
    return c.reverse ? store.reversed(m) : store.sound(m);
  }));
  await Promise.all(p.tracks.flatMap((t) => t.clips).filter((c): c is MediaClip => c.type === "media" && c.role === "voice").map((c) => store.sound(mediaOf(p, c.media)!)));
  const windows = duckWindows(p, store);
  for (const c of clips) {
    const m = mediaOf(p, c.media)!;
    const sound = await (c.reverse ? store.reversed(m) : store.sound(m));
    if (sound) playClip(ctx, ctx.destination, sound, c, 0, 0, windows);
  }
  const rendered = await ctx.startRendering();
  const l = rendered.getChannelData(0), r = rendered.getChannelData(1);
  const out = new Int16Array(length * 2);
  for (let i = 0; i < length; i++) {
    out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767)));
    out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767)));
  }
  return new Uint8Array(out.buffer);
}

/** The main track's first clip covering `t` (for actions on "the clip under the playhead"). */
export function mainClipAt(p: Project, t: number): MediaClip | undefined {
  return mainTrack(p).clips.find((c) => t >= c.start && t < clipEnd(c)) as MediaClip | undefined;
}
