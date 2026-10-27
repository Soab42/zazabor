import { previewUrl } from "../../../../api";
import type { Compositor, LayerDraw, Source } from "../gfx";
import { mediaOf, placeAt, type Project } from "../model";
import { pieceTime, type Template, type TemplateClip } from "./format";
import { loadFamily, familyLoaded } from "./fonts";
import { templateTime, type Box } from "./layout";
import { svgOutline, traceOutline } from "./outline";
import { drawScene, moving, newMemory, type Memory, type Outline, type Picture, type Scene } from "./player";
import { templateOf } from "./templates";
import { readSvg } from "./files";

/**
 * Template clips in the editor's engine: each draws on a canvas of its own at the output size,
 * which becomes one layer of the compositor. Export adds motion blur (several moments averaged)
 * while something moves, and waits for fonts and pictures; the preview draws with what's there
 * and redraws when the rest arrives.
 */

/** Moments averaged for motion blur on export, and the shutter (fraction of a frame). */
const BLUR_SAMPLES = 5;
const SHUTTER = 0.5;

interface Held {
  canvas: HTMLCanvasElement;
  source: Source | null;
  mem: Memory;
  key: string;
  hits: Box[];
  size: [number, number];
  /** Whether the theme's fonts had loaded when texts were measured. */
  fonts: boolean;
}

type Loaded = { pic: Picture | null; outline: Outline | null | undefined };

export class MotionRenderer {
  private held = new Map<string, Held>();
  /** Pictures by path (slots' media and kits' logos). */
  private pictures = new Map<string, Loaded | Promise<void>>();
  private accum: HTMLCanvasElement | null = null;

  constructor(private gfx: Compositor, private redraw: () => void) {}

  /**
   * The compositor layer for a template clip at timeline time `t` on a W×H canvas. `final`: an
   * export or poster frame (motion blur, no placeholders), also on its second pass, when `exact`
   * is null because everything has loaded.
   */
  layer(p: Project, c: TemplateClip, t: number, W: number, H: number, exact: Promise<void>[] | null, final = exact !== null): LayerDraw[] {
    const template = templateOf(c);
    if (!template) return [];
    const local = t - c.start;
    const place = placeAt(c, local);
    if (place.opacity <= 0.001) return [];
    const scene = this.scene(p, c, template, exact, final);
    const piece = pieceTime(c, local);
    const tt = templateTime(piece.local, piece.span, template.length, template.hold);
    const idle = Math.max(0, Math.min(1, piece.local / Math.max(0.1, piece.span)));
    let held = this.held.get(c.id);
    if (!held) {
      held = { canvas: document.createElement("canvas"), source: null, mem: newMemory(), key: "", hits: [], size: [0, 0], fonts: false };
      this.held.set(c.id, held);
    }
    const ready = [c.theme.heading.family, c.theme.body.family, c.theme.bangla.family].every(familyLoaded);
    if (held.fonts !== ready) {
      // Texts measured with a stand-in font are measured again.
      held.mem = newMemory();
      held.fonts = ready;
    }
    const picKey = [...scene.pictures.values()].map((x) => (x ? 1 : 0)).join("") + [...scene.outlines.values()].map((x) => (x ? 1 : 0)).join("");
    const key = `${tt.toFixed(4)}|${W}x${H}|${final ? "x" : "p"}|${ready}|${picKey}|${JSON.stringify(c.values)}|${JSON.stringify(c.theme)}|${c.ungrouped ? 1 : 0}`;
    if (held.key !== key) {
      if (held.canvas.width !== W || held.canvas.height !== H) {
        held.canvas.width = W;
        held.canvas.height = H;
      }
      const g = held.canvas.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      held.hits = [];
      const fps = Math.max(1, p.canvas.fps || 30);
      const shutter = SHUTTER / fps;
      if (final && moving(template, tt - shutter, tt + shutter)) {
        // Motion blur: moments across the shutter, averaged (premultiplied colours add up).
        const acc = (this.accum ??= document.createElement("canvas"));
        if (acc.width !== W || acc.height !== H) {
          acc.width = W;
          acc.height = H;
        }
        const a = acc.getContext("2d")!;
        g.save();
        g.globalCompositeOperation = "lighter";
        for (let i = 0; i < BLUR_SAMPLES; i++) {
          const offset = (i / (BLUR_SAMPLES - 1) - 0.5) * shutter;
          const ti = templateTime(Math.max(0, piece.local + offset), piece.span, template.length, template.hold);
          a.setTransform(1, 0, 0, 1, 0, 0);
          a.clearRect(0, 0, W, H);
          drawScene(a, W, H, ti, idle, scene, held.mem, i === Math.floor(BLUR_SAMPLES / 2) ? held.hits : null);
          g.globalAlpha = 1 / BLUR_SAMPLES;
          g.drawImage(acc, 0, 0);
        }
        g.restore();
      } else drawScene(g, W, H, tt, idle, scene, held.mem, held.hits);
      try {
        held.source = this.gfx.uploadImage(held.source, held.canvas);
      } catch (err) {
        // A canvas that drew something unreadable stays unreadable: start a fresh one next time.
        held.canvas = document.createElement("canvas");
        throw err;
      }
      held.key = key;
      held.size = [W, H];
    }
    if (!held.source) return [];
    return [{
      source: held.source,
      center: [place.x * W, place.y * H],
      size: [W * place.scale, H * place.scale],
      rotation: (place.rotation * Math.PI) / 180,
      opacity: place.opacity,
      grade: null, adjust: [0, 0, 0], blur: 0, dim: 0,
    }];
  }

  /** Whether a point (composition pixels) is on something the template drew last time. */
  hit(c: TemplateClip, t: number, x: number, y: number, W: number, H: number): boolean {
    const held = this.held.get(c.id);
    if (!held) return false;
    const place = placeAt(c, t - c.start);
    const [hw, hh] = held.size;
    // Back into the template's own canvas.
    const lx = (x - place.x * W) / place.scale + hw / 2, ly = (y - place.y * H) / place.scale + hh / 2;
    return held.hits.some((b) => lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h);
  }

  /** What the player needs for a clip: values, theme and the pictures loaded so far. */
  private scene(p: Project, c: TemplateClip, template: Template, exact: Promise<void>[] | null, final: boolean): Scene {
    for (const f of [c.theme.heading.family, c.theme.body.family, c.theme.bangla.family]) {
      if (familyLoaded(f)) continue;
      const loading = loadFamily(f).then(() => this.redraw());
      if (exact) exact.push(loading);
    }
    const pictures = new Map<string, Picture | null>();
    const outlines = new Map<string, Outline | null>();
    const traced = new Set<string>();
    const scan = (layers: Template["layers"]) => {
      for (const l of layers) {
        if (l.kind === "image" && l.slot && l.trace) traced.add(l.slot);
        if (l.kind === "group") scan(l.children);
      }
    };
    scan(template.layers);
    for (const f of template.fields) {
      if (f.kind !== "media") continue;
      const id = c.slots[f.id];
      const m = id ? mediaOf(p, id) : undefined;
      const path = m && !m.missing ? m.path : f.bind === "logo" ? c.theme.logo : null;
      const got = path ? this.picture(path, traced.has(f.id), exact) : null;
      pictures.set(f.id, got?.pic ?? null);
      outlines.set(f.id, got?.outline ?? null);
    }
    return { template, values: c.values, theme: c.theme, pictures, outlines, graphicsOnly: c.ungrouped, placeholders: !final };
  }

  /** A picture by path (an SVG read as a picture and as paths), with its outline when asked for. */
  private picture(path: string, outline: boolean, exact: Promise<void>[] | null): Loaded | null {
    const have = this.pictures.get(path);
    if (have && !(have instanceof Promise)) {
      if (outline && have.outline === undefined && have.pic) have.outline = traceOutline(have.pic);
      return have;
    }
    if (have instanceof Promise) {
      if (exact) exact.push(have);
      return null;
    }
    const loading = (async () => {
      let loaded: Loaded;
      if (/\.svg$/i.test(path)) {
        const text = await readSvg(path);
        const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
        const img = await image(url);
        loaded = { pic: img, outline: svgOutline(text) };
      } else {
        loaded = { pic: await image(previewUrl(path, 0, 2048)), outline: undefined };
      }
      this.pictures.set(path, loaded);
      this.redraw();
    })().catch((err) => {
      console.warn("[motion] picture", path, err);
      this.pictures.set(path, { pic: null, outline: null });
    });
    this.pictures.set(path, loading);
    if (exact) exact.push(loading);
    return null;
  }

  /** A picture changed on disk (cut out, replaced): read it again. */
  forget(path: string) {
    this.pictures.delete(path);
  }

  /** Drops what clips no longer in the project held. */
  sweep(p: Project) {
    const ids = new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const [id, h] of this.held) {
      if (ids.has(id)) continue;
      if (h.source) this.gfx.release(h.source);
      this.held.delete(id);
    }
  }

  dispose() {
    for (const h of this.held.values()) if (h.source) this.gfx.release(h.source);
    this.held.clear();
  }
}

function image(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    // CORS-clean, so the canvas it's drawn on can still be uploaded to WebGL.
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("The picture couldn't be read."));
    img.src = url;
  });
}
