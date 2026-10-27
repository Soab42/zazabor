import { open, save } from "../../../../shared/dialog";
import { basename } from "../../../../ui/dom";
import { photoApi } from "../../photo/api";
import { aiApi, ensureModels, growMask, shrinkRgba } from "../../photo/aimodels";
import { editApi, type SoundEffect } from "../api";
import type { Engine } from "../engine";
import {
  canvasSize, defaultPlace, findClip, mediaClip, mediaOf, placeFree, uid,
  type Media, type MediaClip, type Project, type TemplateClip, type TextClip,
} from "../model";
import { applyKit, resetToKit, themeOf, type BrandKit, type Theme } from "./brand";
import { fieldValue, type Template } from "./format";
import { familyStack, loadFamily } from "./fonts";
import { clipTimeAt, templateTime } from "./layout";
import { parts, type Picture } from "./player";
import { readSvg } from "./files";
import { defaultKit, kitById, normalizeMotionSettings, type MotionSettings } from "./settings";
import { templateOf } from "./templates";

/**
 * The Video Editor's motion templates: adding one (with its suggested sounds), cutting a
 * product out of its background, Brand Kits on clips, "Ungroup to layers", Save as Poster. The
 * Templates tab (browser.ts), the inspector view (fields.ts), Brand Kits (kits.ts) and My
 * Templates (mine.ts) work through this.
 */

export interface MotionHost {
  project(): Project;
  change(fn: (p: Project) => void, key?: string): void;
  select(ids: string[]): void;
  time(): number;
  seek(t: number): void;
  engine: Engine;
  /** Decoder keys for the editor's project start with this. */
  prefix: string;
  /** Studio's per-app settings (`studio.apps`); motion keeps its own under `motion`. */
  apps(): Record<string, unknown>;
  saveConfig(): void;
  /** Probes files into media (not yet in the project). */
  addFiles(paths: string[]): Promise<Media[]>;
  toast(text: string): void;
  /** The Templates tab should draw again (kits or My Templates changed). */
  refreshPanel(): void;
}

/** Pictures a media slot may take. */
export const SLOT_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif", "tif", "tiff", "svg"];

export class MotionTools {
  private cached: MotionSettings | null = null;
  private soundList: Promise<SoundEffect[]> | null = null;

  constructor(readonly host: MotionHost) {}

  settings(): MotionSettings {
    if (!this.cached) this.cached = normalizeMotionSettings(this.host.apps().motion);
    return this.cached;
  }

  saveSettings() {
    this.host.apps().motion = this.settings();
    this.host.saveConfig();
  }

  /** The clip as it is now (projects are replaced on undo and drags). */
  clip(id: string): TemplateClip | null {
    const c = findClip(this.host.project(), id)?.clip;
    return c?.type === "template" ? c : null;
  }

  edit(id: string, key: string, fn: (c: TemplateClip, p: Project) => void) {
    this.host.change((p) => {
      const c = findClip(p, id)?.clip;
      if (c?.type === "template") fn(c, p);
    }, `${id}:${key}`);
  }

  // ---- adding templates

  /**
   * Adds a template at the playhead on a track above the video, with the default Brand Kit (or
   * `from`'s look, for My Templates) and, when that's on, its suggested sound effects.
   */
  async use(template: Template, from?: { values: Record<string, string>; theme: Theme; slots: Record<string, Media> }): Promise<void> {
    const s = this.settings();
    const kit = defaultKit(s);
    const at = Math.max(0, this.host.time());
    const values: Record<string, string> = from ? { ...from.values } : {};
    if (!from && s.bangla) for (const f of template.fields) if (f.kind === "text" && f.bn !== undefined) values[f.id] = f.bn;
    const shipped = !template.id.startsWith("mine-");
    const clip: TemplateClip = {
      id: uid(), type: "template", start: at, duration: template.length,
      template: template.id, name: template.name, values, slots: {},
      theme: from ? structuredClone(from.theme) : themeOf(kit), kit: from ? null : kit.id, overrides: [],
      place: defaultPlace(),
    };
    if (!shipped) clip.doc = structuredClone(template);
    void loadFamily(clip.theme.heading.family);
    void loadFamily(clip.theme.body.family);
    void loadFamily(clip.theme.bangla.family);
    const sounds = s.sounds && template.hits?.length ? await this.hitMedia(template) : [];
    this.host.change((p) => {
      for (const [field, m] of Object.entries(from?.slots ?? {})) {
        if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
        clip.slots[field] = m.id;
      }
      placeFree(p, clip, "overlay");
      for (const [t, m] of sounds) {
        if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
        const c: MediaClip = { ...mediaClip(m, at + t), volume: 0.8 };
        placeFree(p, c, "audio");
      }
    });
    this.host.select([clip.id]);
  }

  /** The template's suggested sound effects as media, with their times. */
  private async hitMedia(template: Template): Promise<[number, Media][]> {
    try {
      this.soundList ??= editApi.sounds().catch(() => {
        this.soundList = null;
        return [];
      });
      const list = await this.soundList;
      const wanted = (template.hits ?? []).map((h) => [h.t, list.find((x) => x.id === h.sfx)?.path] as const).filter((x): x is [number, string] => !!x[1]);
      const media = await this.host.addFiles([...new Set(wanted.map(([, path]) => path))]);
      return wanted.map(([t, path]) => [t, media.find((m) => m.path === path)] as const).filter((x): x is [number, Media] => !!x[1]);
    } catch {
      return [];
    }
  }

  /** Adds a clip's suggested sounds now (from the inspector). */
  async addSounds(id: string) {
    const c = this.clip(id);
    const template = c && templateOf(c);
    if (!c || !template?.hits?.length) return;
    const sounds = await this.hitMedia(template);
    if (!sounds.length) {
      this.host.toast("The sound effects couldn't be found.");
      return;
    }
    this.host.change((p) => {
      for (const [t, m] of sounds) {
        if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
        // Where the hit lands in this clip (its length may differ from the template's).
        const local = clipTimeAt(t, c.cut?.span ?? c.duration, template.length, template.hold) - (c.cut?.from ?? 0);
        if (local < 0 || local > c.duration) continue;
        placeFree(p, { ...mediaClip(m, c.start + local), volume: 0.8 }, "audio");
      }
    });
  }

  // ---- media slots

  /** A picture for a media slot, as project media (SVG logos are read by the template itself). */
  async slotMedia(path: string): Promise<Media | null> {
    const have = this.host.project().media.find((m) => m.path === path && !m.missing);
    if (have) return have;
    if (/\.svg$/i.test(path)) {
      const size = await svgSize(path).catch(() => ({ width: 512, height: 512 }));
      return { id: uid(), path, name: basename(path), kind: "image", duration: 0, width: size.width, height: size.height, fps: 0, audio: false };
    }
    const [m] = await this.host.addFiles([path]);
    return m ?? null;
  }

  async chooseSlot(id: string, field: string) {
    const path = await open({ title: "Choose a Picture", filters: [{ name: "Pictures", extensions: SLOT_EXTENSIONS }] }).catch(() => null);
    if (!path) return;
    const m = await this.slotMedia(path);
    if (!m) return;
    this.edit(id, `slot-${field}`, (c, p) => {
      if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
      c.slots[field] = m.id;
    });
  }

  clearSlot(id: string, field: string) {
    this.edit(id, `slot-${field}`, (c) => delete c.slots[field]);
  }

  /**
   * "Cut out product": the slot's picture without its background (the Photo editor's subject
   * model, on this computer), saved as a PNG next to it, and put in the slot.
   */
  async cutOut(id: string, field: string) {
    const c = this.clip(id);
    const m = c?.slots[field] ? mediaOf(this.host.project(), c.slots[field]) : undefined;
    if (!c || !m || m.missing) {
      this.host.toast("Choose a product photo first.");
      return;
    }
    if (/\.svg$/i.test(m.path)) {
      this.host.toast("An SVG has no background to cut out.");
      return;
    }
    if (!(await ensureModels("subject", "cut-out"))) return;
    this.host.toast("Cutting out the product…");
    try {
      const pic = await photoApi.decode(m.path, 4096);
      const small = shrinkRgba(pic.rgba, pic.width, pic.height, 1024);
      const mask = growMask(await aiApi.subject(small.rgba, small.width, small.height, false), small.width, small.height, pic.width, pic.height);
      const cut = cropToAlpha(pic.rgba, mask, pic.width, pic.height);
      if (!cut) {
        this.host.toast("No product was found in that picture.");
        return;
      }
      const path = await photoApi.copyPath(m.path, "png");
      await photoApi.encode(path, { rgba: cut.rgba, width: cut.width, height: cut.height, format: "png" });
      const [made] = await this.host.addFiles([path]);
      if (!made) return;
      this.host.engine.motion.forget(path);
      this.edit(id, `cutout-${field}`, (x, p) => {
        if (!p.media.some((y) => y.id === made.id)) p.media.push(made);
        x.slots[field] = made.id;
      });
      this.host.toast(`Cut out: saved as ${basename(path)}.`);
    } catch (err) {
      this.host.toast(`The cut-out didn't work: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- brand kits on clips

  applyKit(id: string, kit: BrandKit) {
    this.edit(id, "kit", (c) => applyKit(c, kit));
    for (const f of [kit.heading.family, kit.body.family, kit.bangla.family]) void loadFamily(f);
  }

  /** A kit on every template clip in the project (parts changed by hand stay). */
  applyKitEverywhere(kit: BrandKit) {
    this.host.change((p) => {
      for (const t of p.tracks) for (const c of t.clips) if (c.type === "template") applyKit(c, kit);
    }, "kit-all");
    for (const f of [kit.heading.family, kit.body.family, kit.bangla.family]) void loadFamily(f);
  }

  resetToKit(id: string) {
    const c = this.clip(id);
    const kit = kitById(this.settings(), c?.kit ?? null) ?? defaultKit(this.settings());
    this.edit(id, "kit-reset", (x) => resetToKit(x, kit));
  }

  /** Every template clip that came from a kit takes its changes (after editing the kit). */
  kitChanged(kit: BrandKit) {
    const p = this.host.project();
    if (!p.tracks.some((t) => t.clips.some((c) => c.type === "template" && c.kit === kit.id))) return;
    this.host.change((q) => {
      for (const t of q.tracks) for (const c of t.clips) if (c.type === "template" && c.kit === kit.id) applyKit(c, kit);
    }, `kit-edit-${kit.id}`);
  }

  // ---- ungroup

  /**
   * "Ungroup to layers": the template's texts become text clips and its pictures picture clips
   * of their own (on tracks above it), where they were; the template keeps drawing the rest.
   */
  ungroup(id: string) {
    const c = this.clip(id);
    const template = c && templateOf(c);
    if (!c || !template || c.ungrouped) return;
    const p = this.host.project();
    const { width: W, height: H } = canvasSize(p.canvas.aspect, 1080);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const pictures = new Map<string, Picture | null>();
    const picks = new Map<string, Media>();
    for (const f of template.fields) {
      if (f.kind !== "media") continue;
      const m = c.slots[f.id] ? mediaOf(p, c.slots[f.id]) : undefined;
      // A stand-in so layout knows the slot is filled (pictures aren't drawn here).
      pictures.set(f.id, m && !m.missing ? canvas : null);
      if (m && !m.missing) picks.set(f.id, m);
    }
    const span = c.cut?.span ?? c.duration;
    const from = c.cut?.from ?? 0;
    const placed = parts(canvas.getContext("2d")!, W, H, template.hold[1], { template, values: c.values, theme: c.theme, pictures, outlines: new Map() });
    /** A template time range as this clip's start and length on the timeline. */
    const timing = (time?: [number, number]) => {
      if (!time) return { start: c.start, duration: c.duration };
      const a = Math.max(0, clipTimeAt(time[0], span, template.length, template.hold) - from);
      const b = Math.min(c.duration, clipTimeAt(Math.min(time[1], template.length), span, template.length, template.hold) - from);
      return b - a > 0.1 ? { start: c.start + a, duration: b - a } : null;
    };
    const made: string[] = [];
    this.host.change((q) => {
      const own = findClip(q, id)?.clip;
      if (own?.type !== "template") return;
      own.ungrouped = true;
      for (const t of placed.texts) {
        const when = timing(t.time);
        if (!when) continue;
        const clip: TextClip = {
          id: uid(), type: "text", ...when, text: t.text,
          style: {
            font: t.family, size: Math.round((t.size / H) * 1000), color: t.color, stroke: null, strokeWidth: 0, box: null,
            shadow: false, bold: t.weight >= 600, italic: t.italic, align: t.align,
          },
          // A text clip is placed by its middle: where the template's line would have its middle.
          place: { ...defaultPlace(), x: (t.align === "left" ? t.box.x + t.width / 2 : t.align === "right" ? t.box.x + t.box.w - t.width / 2 : t.box.x + t.box.w / 2) / W, y: (t.box.y + t.box.h / 2) / H },
          animIn: "fade", animOut: "fade",
        };
        placeFree(q, clip, "text");
        made.push(clip.id);
      }
      for (const pic of placed.pictures) {
        const m = picks.get(pic.slot);
        const when = timing(pic.time);
        if (!m || !when || /\.svg$/i.test(m.path)) continue;
        const clip = mediaClip(m, when.start);
        clip.duration = when.duration;
        clip.fit = "fit";
        clip.motion = false;
        // "Fit" fits the whole canvas; scaled down to the slot's box.
        const fitCanvas = Math.min(W / Math.max(1, m.width), H / Math.max(1, m.height));
        const fitBox = Math.min(pic.box.w / Math.max(1, m.width), pic.box.h / Math.max(1, m.height));
        clip.place = { ...defaultPlace(), x: (pic.box.x + pic.box.w / 2) / W, y: (pic.box.y + pic.box.h / 2) / H, scale: fitBox / fitCanvas };
        placeFree(q, clip, "overlay");
        made.push(clip.id);
      }
    }, "ungroup");
    if (made.length) this.host.select(made);
    this.host.toast(made.length ? `Ungrouped into ${made.length} clip${made.length === 1 ? "" : "s"}. Undo puts them back together.` : "This template has no texts or pictures to ungroup.");
  }

  regroup(id: string) {
    this.edit(id, "regroup", (c) => delete c.ungrouped);
  }

  // ---- poster

  /** Saves one frame of the clip (the playhead's, or the middle of its hold) as a picture. */
  async poster(id: string) {
    const c = this.clip(id);
    const template = c && templateOf(c);
    if (!c || !template) return;
    const now = this.host.time();
    const span = c.cut?.span ?? c.duration;
    const mid = clipTimeAt((template.hold[0] + template.hold[1]) / 2, span, template.length, template.hold) - (c.cut?.from ?? 0);
    const t = now >= c.start && now < c.start + c.duration ? now : c.start + Math.max(0, Math.min(c.duration - 0.01, mid));
    // Named after its main text (the title, a name, the hook…), else the first.
    const main = ["title", "brand", "name", "hook", "heading", "price"].find((id) => template.fields.some((f) => f.id === id && f.kind === "text"))
      ?? template.fields.find((f) => f.kind === "text")?.id ?? "";
    const name = (fieldValue(template, c.values, main) || c.name).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "Poster";
    const path = await save({ title: "Save as Poster", defaultPath: `${name}.png`, filters: [{ name: "PNG picture", extensions: ["png"] }, { name: "JPEG picture", extensions: ["jpg", "jpeg"] }] }).catch(() => null);
    if (!path) return;
    const p = this.host.project();
    const { width, height } = canvasSize(p.canvas.aspect, 1080);
    const engine = this.host.engine;
    const prefix = `${this.host.prefix}poster:`;
    engine.hold(true);
    try {
      const waits: Promise<void>[] = [];
      engine.compose(t, width, height, prefix, waits);
      if (waits.length) {
        await Promise.all(waits);
        engine.compose(t, width, height, prefix, null, false);
      }
      const frame = engine.gfx.readRGBA();
      const jpeg = /\.jpe?g$/i.test(path);
      await photoApi.encode(path, { rgba: frame.rgba, width: frame.width, height: frame.height, format: jpeg ? "jpeg" : "png", quality: 92 });
      this.host.toast(`Saved the poster as ${basename(path)}.`);
    } catch (err) {
      this.host.toast(`The poster couldn't be saved: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      engine.releasePrefix(prefix);
      engine.hold(false);
    }
  }

  /** Template time at the playhead for a clip (null when the playhead is outside it). */
  templateTimeAt(c: TemplateClip): number | null {
    const template = templateOf(c);
    const local = this.host.time() - c.start;
    if (!template || local < 0 || local > c.duration) return null;
    return templateTime((c.cut?.from ?? 0) + local, c.cut?.span ?? c.duration, template.length, template.hold);
  }
}

/** The CSS font family list a theme's heading uses (the browser's cards). */
export const headingStack = (theme: Theme) => familyStack(theme.heading.family, theme.bangla.family);

async function svgSize(path: string): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(new Blob([await readSvg(path)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("unreadable"));
      img.src = url;
    });
    return { width: img.naturalWidth || 512, height: img.naturalHeight || 512 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The picture with the mask as its transparency, cropped to what's left (with a small margin). */
function cropToAlpha(rgba: Uint8Array, mask: Uint8Array, w: number, h: number): { rgba: Uint8Array; width: number; height: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = Math.min(rgba[(y * w + x) * 4 + 3], mask[y * w + x]);
      if (a > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02);
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y + y0) * w + (x + x0)) * 4, di = (y * cw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = Math.min(rgba[si + 3], mask[(y + y0) * w + (x + x0)]);
    }
  }
  return { rgba: out, width: cw, height: ch };
}
