import type { Anim, EaseName } from "./ease";
import type { Responsive, Shape } from "./layout";
import { normalizeTheme, THEME_KEYS, type Theme, type ThemeKey } from "./brand";
import type { Keys, Placement } from "../model";

/**
 * The motion template format (v1). A template is a scene of layers (shapes, paths, texts,
 * pictures, groups and effects) with keyframed properties in template time, fields the user fills
 * in, and colours and fonts that come from a Brand Kit theme. Shipped templates are TS objects in
 * `templates/`; a saved one travels as a `.zaztemplate` package (document + pictures).
 */

export const FORMAT_VERSION = 1;

/** A colour: "#rrggbb", a theme colour ("@primary", "@onPrimary"…), either with "/0.5" opacity. */
export type Paint = string | Gradient;

export interface Gradient {
  kind: "linear" | "radial";
  /** Linear: degrees, 0 = left to right, 90 = top to bottom. */
  angle?: number;
  stops: [number, string][];
}

export type RevealFrom = "bottom" | "top" | "left" | "right" | "center";

interface LayerBase {
  id: string;
  frame: Responsive;
  /** Shown only between these template times. */
  time?: [number, number];
  opacity?: Anim;
  /** Offsets in canvas short sides. */
  dx?: Anim;
  dy?: Anim;
  scale?: Anim;
  /** Degrees clockwise. */
  rotate?: Anim;
  /** Blur in canvas short sides. */
  blur?: Anim;
  /** A wipe that shows the layer from one side (0 hidden … 1 whole). */
  reveal?: { from: RevealFrom; v: Anim; soft?: number };
  /** Soft drop shadow (sizes in short sides). */
  shadow?: { color: Paint; blur: number; y: number };
  glow?: { color: Paint; blur: number };
  /** A band of light sweeping across the layer (0 before … 1 past it). */
  sheen?: { at: Anim; width?: number; angle?: number; strength?: number };
  blend?: GlobalCompositeOperation;
  /** Slow change over the whole clip, so a stretched hold still lives (amounts over the clip). */
  idle?: { scale?: number; dy?: number; rotate?: number };
  /** Drawn only while this media slot is empty (a stand-in), or only once it's filled. */
  ifEmpty?: string;
  ifFilled?: string;
}

export interface RectLayer extends LayerBase {
  kind: "rect" | "ellipse";
  fill?: Paint;
  stroke?: Paint;
  /** Short sides. */
  strokeWidth?: number;
  /** Corner radius in short sides, "theme" (the kit's roundness) or "pill". */
  radius?: number | "theme" | "pill";
}

export interface PathLayer extends LayerBase {
  kind: "path";
  /** SVG path data in a `view` box (100 × 100 unless given), stretched to the frame. */
  d: string;
  view?: [number, number];
  fill?: Paint;
  stroke?: Paint;
  strokeWidth?: number;
  /** Line drawing: how much of the stroke shows (0…1). */
  draw?: Anim;
  cap?: CanvasLineCap;
}

export interface TextAnimator {
  unit: "char" | "word" | "line";
  /** Template time the first unit starts. */
  t: number;
  /** Seconds between units. */
  stagger: number;
  /** Each unit's own time. */
  duration: number;
  /** Entrance: where units come from. Exit: where they go. dx/dy/blur in em, rotate in degrees. */
  from: { opacity?: number; dx?: number; dy?: number; scale?: number; rotate?: number; blur?: number };
  ease?: EaseName;
  /** Units stay inside their line's box (rising from behind the baseline). */
  mask?: boolean;
  /** Exits: last unit first. */
  reverse?: boolean;
}

export interface TextLayer extends LayerBase {
  kind: "text";
  /** The field it shows, or fixed text. */
  field?: string;
  text?: string;
  font: "heading" | "body";
  /** Weight; the theme's when not given. */
  weight?: number;
  italic?: boolean;
  /** Largest size and smallest (in short sides); it shrinks within these, then wraps. */
  size: number;
  minSize?: number;
  lines?: number;
  color: Paint;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  /** Letter spacing in em (animatable). */
  tracking?: Anim;
  upper?: boolean;
  animate?: TextAnimator;
  exit?: TextAnimator;
  /** Counts up from another field's number to this one's between two template times. */
  counter?: { from: string; t: [number, number] };
  /** A strike-through line drawn across (0…1). */
  strike?: { draw: Anim; color: Paint; width: number };
  /** Size, lines and alignment for some shapes. */
  textAt?: Partial<Record<Shape, { size?: number; minSize?: number; lines?: number; align?: "left" | "center" | "right" }>>;
}

export interface ImageLayer extends LayerBase {
  kind: "image";
  /** The media slot it shows (a field of kind "media"). */
  slot?: string;
  fit?: "cover" | "contain";
  radius?: number | "theme" | "pill";
  /** Logo reveal: the picture's outline (an SVG's paths, or a traced outline) drawn first. */
  trace?: { draw: Anim; color: Paint; width: number; fill: Anim };
  /** Shown while the slot is empty: a soft placeholder with this label (preview only). */
  placeholder?: string;
}

export interface IconLayer extends LayerBase {
  kind: "icon";
  /** A choice field holding the icon's id, or a fixed icon. */
  field?: string;
  icon?: string;
  color: Paint;
  strokeWidth?: number;
  draw?: Anim;
}

export interface GroupLayer extends LayerBase {
  kind: "group";
  children: Layer[];
}

export type FxKind = "grain" | "vignette" | "leak" | "blobs" | "stripes" | "rays" | "progress" | "dots";

export interface FxLayer extends LayerBase {
  kind: "fx";
  fx: FxKind;
  color?: Paint;
  color2?: Paint;
  amount?: number;
  /** For "progress": how far (0…1). */
  value?: Anim;
}

export type Layer = RectLayer | PathLayer | TextLayer | ImageLayer | IconLayer | GroupLayer | FxLayer;

export interface Field {
  id: string;
  kind: "text" | "media" | "choice";
  label: string;
  /** English default, and the Bangla one. */
  en: string;
  bn?: string;
  /** Characters the design holds well. */
  limit?: number;
  multiline?: boolean;
  options?: [string, string][];
  /** A media slot the Brand Kit's logo fills. */
  bind?: "logo";
  /** Media slot: offer "Cut out product". */
  product?: boolean;
}

export type Category = "launch" | "sale" | "feature" | "logo" | "lower" | "hook";

export const CATEGORIES: { id: Category | "mine"; label: string }[] = [
  { id: "launch", label: "Product launch" },
  { id: "sale", label: "Sale & offers" },
  { id: "feature", label: "Feature highlight" },
  { id: "logo", label: "Logo reveals" },
  { id: "lower", label: "Lower thirds" },
  { id: "hook", label: "Reel hooks & end screens" },
  { id: "mine", label: "My Templates" },
];

export interface Template {
  version: number;
  id: string;
  name: string;
  category: Category;
  description: string;
  tags: string[];
  /** Designed length (seconds), and the hold that stretches: [end of entrance, start of exit]. */
  length: number;
  hold: [number, number];
  shapes: Shape[];
  fields: Field[];
  layers: Layer[];
  /** Suggested sound effects (round 3's, by id) at template times. */
  hits?: { t: number; sfx: string }[];
  /** No background of its own: meant over video (lower thirds). */
  overlay?: boolean;
}

/** A template on the timeline. */
export interface TemplateClip {
  id: string;
  type: "template";
  start: number;
  duration: number;
  /** A shipped template's id; `doc` holds the template itself when it isn't shipped (My Templates). */
  template: string;
  doc?: Template;
  name: string;
  /** Text and choice fields. */
  values: Record<string, string>;
  /** Media slots: field id → the project's media id. */
  slots: Record<string, string>;
  theme: Theme;
  kit: string | null;
  overrides: ThemeKey[];
  place: Placement;
  keys?: Keys;
  /** Split: which part of the template's timeline (`span` long) this piece starts at. */
  cut?: { from: number; span: number };
  /** "Ungroup to layers" made its texts and pictures into clips of their own. */
  ungrouped?: boolean;
}

const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");

function stringMap(raw: unknown, max: number, keep: (k: string, v: string) => boolean = () => true): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && k.length <= 64 && keep(k, v)) out[k] = v.slice(0, max);
  }
  return out;
}

/** A template document read from a file: the basics checked, so a broken file can't break drawing. */
export function normalizeTemplate(raw: unknown): Template | null {
  const r = raw as Partial<Template> | undefined;
  if (!r || typeof r.id !== "string" || !Array.isArray(r.layers) || !Array.isArray(r.fields)) return null;
  const length = typeof r.length === "number" && r.length > 0.2 && r.length < 600 ? r.length : 6;
  const hold: [number, number] = Array.isArray(r.hold) && r.hold.length === 2 && r.hold.every((v) => typeof v === "number") && r.hold[0] <= r.hold[1] && r.hold[1] <= length
    ? [Math.max(0, r.hold[0]), r.hold[1]] : [length * 0.4, length * 0.85];
  return {
    version: FORMAT_VERSION,
    id: str(r.id, 64),
    name: str(r.name, 80) || "Template",
    category: (["launch", "sale", "feature", "logo", "lower", "hook"] as Category[]).includes(r.category as Category) ? r.category as Category : "launch",
    description: str(r.description, 400),
    tags: Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === "string").slice(0, 20) : [],
    length,
    hold,
    shapes: Array.isArray(r.shapes) ? (r.shapes.filter((s) => ["9:16", "16:9", "1:1", "4:5"].includes(s)) as Shape[]) : ["9:16", "16:9", "1:1", "4:5"],
    fields: r.fields.filter((f) => f && typeof f.id === "string" && ["text", "media", "choice"].includes(f.kind)),
    layers: r.layers.filter((l) => l && typeof l.id === "string" && typeof l.kind === "string" && l.frame && typeof l.frame === "object"),
    hits: Array.isArray(r.hits) ? r.hits.filter((h) => h && typeof h.t === "number" && typeof h.sfx === "string") : [],
    overlay: !!r.overlay,
  };
}

/** A saved project's template clip, checked; null when it can't be used. */
export function normalizeTemplateClip(raw: unknown, mediaIds: Set<string>, known: (id: string) => boolean): TemplateClip | null {
  const r = raw as Partial<TemplateClip> | undefined;
  if (!r || r.type !== "template" || typeof r.template !== "string") return null;
  const doc = r.doc ? normalizeTemplate(r.doc) ?? undefined : undefined;
  if (!doc && !known(r.template)) return null;
  const start = Number.isFinite(r.start) ? Math.max(0, r.start as number) : 0;
  const duration = Number.isFinite(r.duration) && (r.duration as number) > 0.1 ? (r.duration as number) : 0.1;
  const clip: TemplateClip = {
    id: typeof r.id === "string" && r.id ? r.id : Math.random().toString(36).slice(2, 10),
    type: "template",
    start, duration,
    template: str(r.template, 64),
    name: str(r.name, 80) || doc?.name || "Template",
    values: stringMap(r.values, 2000),
    slots: stringMap(r.slots, 64, (_k, v) => mediaIds.has(v)),
    theme: normalizeTheme(r.theme),
    kit: typeof r.kit === "string" ? r.kit : null,
    overrides: Array.isArray(r.overrides) ? r.overrides.filter((k): k is ThemeKey => (THEME_KEYS as string[]).includes(k)) : [],
    place: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, ...(r.place ?? {}) },
  };
  if (doc) clip.doc = doc;
  if (r.keys) clip.keys = r.keys;
  if (r.cut && Number.isFinite(r.cut.from) && Number.isFinite(r.cut.span) && r.cut.span > 0) clip.cut = { from: Math.max(0, r.cut.from), span: r.cut.span };
  if (r.ungrouped) clip.ungrouped = true;
  return clip;
}

/** The template time a piece of a (maybe split) clip is at, `local` seconds into it, before stretching. */
export function pieceTime(c: Pick<TemplateClip, "duration" | "cut">, local: number): { local: number; span: number } {
  if (!c.cut) return { local, span: c.duration };
  return { local: c.cut.from + local, span: c.cut.span };
}

/** What a field shows: the clip's value, else its default in the clip's language. */
export function fieldValue(t: Template, values: Record<string, string>, id: string, bangla = false): string {
  if (id in values) return values[id];
  const f = t.fields.find((x) => x.id === id);
  return f ? (bangla && f.bn !== undefined ? f.bn : f.en) : "";
}

/** A `.zaztemplate` document: the template, the user's values and theme; pictures by asset name. */
export interface PackageDoc {
  app: "zaztemplate";
  version: number;
  name: string;
  template: Template;
  values: Record<string, string>;
  theme: Theme;
  /** Media slots and the logo: field id (or "logo") → asset name in the package. */
  assets: Record<string, string>;
}

export function normalizePackage(raw: unknown): PackageDoc | null {
  const r = raw as Partial<PackageDoc> | undefined;
  if (!r || r.app !== "zaztemplate") return null;
  const template = normalizeTemplate(r.template);
  if (!template) return null;
  return {
    app: "zaztemplate",
    version: FORMAT_VERSION,
    name: str(r.name, 80) || template.name,
    template,
    values: stringMap(r.values, 2000),
    theme: normalizeTheme(r.theme),
    assets: stringMap(r.assets, 120),
  };
}
