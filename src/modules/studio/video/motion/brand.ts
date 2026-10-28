import type { Feel } from "./ease";

/**
 * Brand Kits: a brand's colours, fonts, logo, roundness and motion feel, saved once and applied
 * to every template in a project. A template clip keeps the theme it was given (so a project looks
 * the same on another computer) and which parts the user changed by hand, which applying a kit
 * leaves alone until "Reset to kit". Pure (tested in tools/motion.test.ts).
 *
 * Template looks (API for template authors):
 *   - A template may carry its own designed `look` (format.ts `Template.look`, type `Look` below):
 *     `{ colors: { primary, secondary, accent, background, text }, heading: { family, weight },
 *     body: { family, weight }, bangla?, radius?, motion?, backdrop?, grade?, grain? }`.
 *     Fonts are bundled families (fonts.ts). Every paint a layer uses ("@primary", "@bg"…) then
 *     resolves to the look's colours, so write layers with theme paints, not hex.
 *   - `backdrop`: up to six paints (hex or "@…") for base background layers (not `over` ones) that
 *     don't set their own `colors`, by slot as background.ts's BG_COLORS (0–2 the lights, 3 the
 *     dark base, 4 the light base, 5 an extra). Only while the look is on: a Brand Kit uses its own
 *     colours. A light look needs a light slot 3 and a mixing preset (mesh, waves, glass): the
 *     others add light, which a light base can't show.
 *   - "@card" is a card's fill that suits either: near-white on a light background, the deep
 *     surface on a dark one.
 *   - `grade`: a finishing colour grade over the whole frame (`warmth` -1 cool … 1 warm, `fade`
 *     0…1 lifted blacks, `saturation` 0…1 how much colour stays, `tint` + `tintAmount` 0…0.3);
 *     `grain` 0…0.06 is the backgrounds' film grain while the look is on. Overlay templates
 *     (lower thirds over video) aren't graded.
 *   - A clip shows its template's look while its `kit` is `OWN_LOOK` ("Template's own look", the
 *     default for new templates unless the user picks a default kit). Applying a kit replaces it;
 *     "Reset" on a clip whose kit is `OWN_LOOK` goes back to the look. A template without a look
 *     shows the first built-in kit (Midnight).
 *
 *   Example:
 *     look: {
 *       colors: { primary: "#d4af37", secondary: "#1c1a16", accent: "#f2e3b3", background: "#0a0907", text: "#f7f3ea" },
 *       heading: { family: "Playfair Display", weight: 700 }, body: { family: "Manrope", weight: 500 },
 *       backdrop: ["#d4af37", "#8a6a2a", "#f2e3b3", "#050403", "#1a1610"], grade: { warmth: 0.3, fade: 0.08 }, grain: 0.03,
 *     },
 */

export interface FontRef {
  /** A family of the bundled fonts (fonts.ts) or one installed on the system. */
  family: string;
  weight: number;
}

export interface Colors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

/** A finishing colour grade (see the note at the top). */
export interface Grade {
  /** -1 cool … 1 warm. */
  warmth?: number;
  /** 0…1: lifted blacks, a softer filmic look. */
  fade?: number;
  /** 0…1: how much colour stays (1 all of it). */
  saturation?: number;
  /** A colour washed over everything, and how much (0…0.3). */
  tint?: string;
  tintAmount?: number;
}

/** A template's own designed look (see the note at the top). */
export interface Look {
  colors: Colors;
  heading: FontRef;
  body: FontRef;
  bangla?: FontRef;
  radius?: number;
  motion?: Feel;
  backdrop?: string[];
  grade?: Grade;
  grain?: number;
}

/** The `kit` of a clip that shows its template's own look. */
export const OWN_LOOK = "@own";

export interface Theme {
  colors: Colors;
  heading: FontRef;
  body: FontRef;
  /** The font Bangla letters fall back to in every text (display fonts mostly have none). */
  bangla: FontRef;
  /** 0 square … 1 fully round corners on cards, pills and badges. */
  radius: number;
  motion: Feel;
  /** A logo picture (path); templates with a logo slot use it until one is chosen there. */
  logo: string | null;
  /** From a template's look only (a kit has none): background paints, a grade and grain. */
  backdrop?: string[];
  grade?: Grade;
  grain?: number;
}

export interface BrandKit extends Theme {
  id: string;
  name: string;
  /** Shipped with the app (can't be deleted or changed, only copied). */
  builtIn?: boolean;
}

export type ThemeKey = keyof Colors | "heading" | "body" | "bangla" | "radius" | "motion" | "logo";
export const COLOR_KEYS: readonly (keyof Colors)[] = ["primary", "secondary", "accent", "background", "text"];
export const THEME_KEYS: readonly ThemeKey[] = [...COLOR_KEYS, "heading", "body", "bangla", "radius", "motion", "logo"];

export const BUILT_IN_KITS: readonly BrandKit[] = [
  {
    id: "midnight", name: "Midnight", builtIn: true,
    colors: { primary: "#7c5cff", secondary: "#1a1f3d", accent: "#3ee0cf", background: "#0b0d1a", text: "#f4f5ff" },
    heading: { family: "Plus Jakarta Sans", weight: 800 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Anek Bangla", weight: 600 },
    radius: 0.5, motion: "smooth", logo: null,
  },
  {
    id: "sunrise", name: "Sunrise", builtIn: true,
    colors: { primary: "#ff5a3c", secondary: "#ffd8c2", accent: "#ffb703", background: "#fff6ee", text: "#2b1330" },
    heading: { family: "Poppins", weight: 800 }, body: { family: "DM Sans", weight: 500 }, bangla: { family: "Hind Siliguri", weight: 600 },
    radius: 0.35, motion: "playful", logo: null,
  },
  {
    id: "luxe", name: "Mono Luxe", builtIn: true,
    colors: { primary: "#d4af37", secondary: "#1c1c1c", accent: "#f2e3b3", background: "#0a0a0a", text: "#f7f3ea" },
    heading: { family: "Playfair Display", weight: 700 }, body: { family: "Manrope", weight: 500 }, bangla: { family: "Tiro Bangla", weight: 400 },
    radius: 0.08, motion: "smooth", logo: null,
  },
  {
    id: "mint", name: "Fresh Mint", builtIn: true,
    colors: { primary: "#0f9d74", secondary: "#d9f5ea", accent: "#ffcc4d", background: "#f7fffb", text: "#0c2b22" },
    heading: { family: "Outfit", weight: 800 }, body: { family: "Outfit", weight: 500 }, bangla: { family: "Baloo Da 2", weight: 600 },
    radius: 0.6, motion: "snappy", logo: null,
  },
  {
    id: "tech", name: "Tech Blue", builtIn: true,
    colors: { primary: "#2f6bff", secondary: "#0f1b33", accent: "#00e0ff", background: "#050a14", text: "#eef4ff" },
    heading: { family: "Space Grotesk", weight: 700 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Hind Siliguri", weight: 600 },
    radius: 0.2, motion: "snappy", logo: null,
  },
];

export const DEFAULT_KIT_ID = "midnight";

export function themeOf(kit: Theme): Theme {
  const theme: Theme = {
    colors: { ...kit.colors }, heading: { ...kit.heading }, body: { ...kit.body }, bangla: { ...kit.bangla },
    radius: kit.radius, motion: kit.motion, logo: kit.logo,
  };
  setExtras(theme, kit);
  return theme;
}

/** A look's background paints, grade and grain onto `theme` (none from a kit). */
function setExtras(theme: Theme, from: Pick<Theme, "backdrop" | "grade" | "grain">) {
  if (from.backdrop) theme.backdrop = [...from.backdrop];
  else delete theme.backdrop;
  if (from.grade) theme.grade = { ...from.grade };
  else delete theme.grade;
  if (from.grain !== undefined) theme.grain = from.grain;
  else delete theme.grain;
}

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);
const fontOr = (v: unknown, d: FontRef): FontRef => {
  const f = v as Partial<FontRef> | undefined;
  const family = typeof f?.family === "string" && f.family.trim() && f.family.length < 80 ? f.family.trim() : d.family;
  const weight = typeof f?.weight === "number" && f.weight >= 100 && f.weight <= 900 ? Math.round(f.weight / 100) * 100 : d.weight;
  return { family, weight };
};

/** A theme read from a file or settings, every part checked (bad parts take `fallback`'s). */
export function normalizeTheme(raw: unknown, fallback: Theme = BUILT_IN_KITS[0]): Theme {
  const r = (raw ?? {}) as Partial<Theme>;
  const c = (r.colors ?? {}) as Partial<Colors>;
  return {
    colors: {
      primary: hexOr(c.primary, fallback.colors.primary), secondary: hexOr(c.secondary, fallback.colors.secondary), accent: hexOr(c.accent, fallback.colors.accent),
      background: hexOr(c.background, fallback.colors.background), text: hexOr(c.text, fallback.colors.text),
    },
    heading: fontOr(r.heading, fallback.heading),
    body: fontOr(r.body, fallback.body),
    bangla: fontOr(r.bangla, fallback.bangla),
    radius: typeof r.radius === "number" && Number.isFinite(r.radius) ? Math.max(0, Math.min(1, r.radius)) : fallback.radius,
    motion: r.motion === "snappy" || r.motion === "smooth" || r.motion === "playful" ? r.motion : fallback.motion,
    logo: typeof r.logo === "string" && r.logo ? r.logo : null,
    ...lookExtras(r),
  };
}

export function normalizeKit(raw: unknown): BrandKit | null {
  const r = raw as Partial<BrandKit> | undefined;
  if (!r || typeof r.id !== "string" || !r.id || r.id === OWN_LOOK || typeof r.name !== "string") return null;
  // A kit is colours, fonts, roundness, motion and a logo; a look's grade and background paints aren't part of it.
  const theme = normalizeTheme(r);
  setExtras(theme, {});
  return { ...theme, id: r.id.slice(0, 64), name: r.name.trim().slice(0, 60) || "Brand Kit" };
}

// As background.ts reads a layer's paints.
const PAINT = /^(@[a-zA-Z]+|#[0-9a-fA-F]{6})(\/(0(\.\d+)?|1(\.0+)?|\.\d+))?$/;
const within = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);

function normalizeGrade(raw: unknown): Grade | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const g: Grade = {};
  const warmth = within(r.warmth, -1, 1), fade = within(r.fade, 0, 1), saturation = within(r.saturation, 0, 1), tintAmount = within(r.tintAmount, 0, 0.3);
  if (warmth) g.warmth = warmth;
  if (fade) g.fade = fade;
  if (saturation !== undefined && saturation < 1) g.saturation = saturation;
  if (typeof r.tint === "string" && HEX.test(r.tint) && tintAmount) {
    g.tint = r.tint.toLowerCase();
    g.tintAmount = tintAmount;
  }
  return Object.keys(g).length ? g : undefined;
}

/** A look's background paints, grade and grain, checked (bad ones dropped). */
function lookExtras(r: { backdrop?: unknown; grade?: unknown; grain?: unknown }): Pick<Theme, "backdrop" | "grade" | "grain"> {
  const out: Pick<Theme, "backdrop" | "grade" | "grain"> = {};
  if (Array.isArray(r.backdrop)) {
    const paints = r.backdrop.filter((c): c is string => typeof c === "string" && PAINT.test(c)).slice(0, 6);
    if (paints.length) out.backdrop = paints;
  }
  const grade = normalizeGrade(r.grade);
  if (grade) out.grade = grade;
  const grain = within(r.grain, 0, 0.06);
  if (grain !== undefined) out.grain = grain;
  return out;
}

/** A template's look read from a file: undefined when its colours or fonts are missing or bad. */
export function normalizeLook(raw: unknown): Look | undefined {
  const r = raw as Partial<Look> | undefined;
  if (!r || typeof r !== "object" || !r.colors || !r.heading || !r.body) return undefined;
  const c = r.colors as Partial<Colors>;
  if (!COLOR_KEYS.every((k) => typeof c[k] === "string" && HEX.test(c[k]!))) return undefined;
  const base = BUILT_IN_KITS[0];
  const look: Look = {
    colors: { primary: c.primary!.toLowerCase(), secondary: c.secondary!.toLowerCase(), accent: c.accent!.toLowerCase(), background: c.background!.toLowerCase(), text: c.text!.toLowerCase() },
    heading: fontOr(r.heading, base.heading),
    body: fontOr(r.body, base.body),
  };
  if (r.bangla) look.bangla = fontOr(r.bangla, base.bangla);
  const radius = within(r.radius, 0, 1);
  if (radius !== undefined) look.radius = radius;
  if (r.motion === "snappy" || r.motion === "smooth" || r.motion === "playful") look.motion = r.motion;
  return { ...look, ...lookExtras(r) };
}

/** The theme a template's look gives (no look: `fallback`, the first built-in kit). */
export function lookTheme(look: Look | undefined, fallback: Theme = BUILT_IN_KITS[0]): Theme {
  if (!look) return themeOf(fallback);
  const theme: Theme = {
    colors: { ...look.colors }, heading: { ...look.heading }, body: { ...look.body }, bangla: { ...(look.bangla ?? fallback.bangla) },
    radius: look.radius ?? fallback.radius, motion: look.motion ?? fallback.motion, logo: null,
  };
  setExtras(theme, look);
  return theme;
}

/** What a template clip keeps of its look. */
export interface Themed {
  theme: Theme;
  /** The kit it came from (null: none, or the kit was deleted). */
  kit: string | null;
  /** Parts changed by hand, kept when a kit is applied. */
  overrides: ThemeKey[];
}

function setKey(theme: Theme, key: ThemeKey, from: Theme) {
  if (key === "heading" || key === "body" || key === "bangla") theme[key] = { ...from[key] };
  else if (key === "radius") theme.radius = from.radius;
  else if (key === "motion") theme.motion = from.motion;
  else if (key === "logo") theme.logo = from.logo;
  else theme.colors[key] = from.colors[key];
}

/** Applies a kit: every part not changed by hand takes the kit's. */
export function applyKit(target: Themed, kit: BrandKit): void {
  for (const key of THEME_KEYS) if (!target.overrides.includes(key)) setKey(target.theme, key, kit);
  setExtras(target.theme, kit);
  target.kit = kit.id;
}

/** "Reset to kit": every part back to the kit's, nothing kept as changed. */
export function resetToKit(target: Themed, kit: BrandKit): void {
  target.theme = themeOf(kit);
  target.overrides = [];
  target.kit = kit.id;
}

/** "Template's own look": every part not changed by hand (but the logo) takes the look's (`lookTheme`). */
export function applyLook(target: Themed, look: Theme): void {
  for (const key of THEME_KEYS) if (key !== "logo" && !target.overrides.includes(key)) setKey(target.theme, key, look);
  setExtras(target.theme, look);
  target.kit = OWN_LOOK;
}

/** Reset on a clip showing its template's look: every part back to the look's (its logo kept). */
export function resetToLook(target: Themed, look: Theme): void {
  const logo = target.theme.logo;
  target.theme = themeOf(look);
  target.theme.logo = logo;
  target.overrides = [];
  target.kit = OWN_LOOK;
}

/** A change by hand: the part is set and remembered as the user's. */
export function overrideTheme(target: Themed, key: ThemeKey, apply: (theme: Theme) => void): void {
  apply(target.theme);
  if (!target.overrides.includes(key)) target.overrides.push(key);
}

// ---- colour

export function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function hexOf([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1…21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Text on a colour: near-white or near-black, whichever reads better. */
export function onColor(bg: string): string {
  return contrast("#ffffff", bg) >= contrast("#111111", bg) ? "#ffffff" : "#111111";
}

/** A paint: a theme colour ("@primary", "@surface", "@deep"…) or hex, with an optional "/alpha", as hex and alpha. */
export function themeColor(p: string, theme: Theme): { hex: string; alpha: number } {
  const [name, alphaText] = p.split("/");
  const c = theme.colors;
  const hex = name === "@primary" ? c.primary
    : name === "@secondary" ? c.secondary
    : name === "@accent" ? c.accent
    : name === "@bg" || name === "@background" ? c.background
    : name === "@text" ? c.text
    : name === "@onPrimary" ? onColor(c.primary)
    : name === "@onAccent" ? onColor(c.accent)
    : name === "@surface" ? mix(c.background, c.text, 0.08)
    : name === "@card" ? (luminance(c.background) > 0.4 ? mix(c.background, "#ffffff", 0.72) : mix(c.background, c.text, 0.08))
    : name === "@deep" ? mix(c.background, "#000000", 0.45)
    : name === "@primaryDeep" ? mix(c.primary, "#000000", 0.42)
    : name;
  const alpha = alphaText !== undefined ? Number(alphaText) : 1;
  return { hex, alpha: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1 };
}

export function mix(a: string, b: string, t: number): string {
  const p = rgbOf(a), q = rgbOf(b);
  return hexOf([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
}

function hsl([r, g, b]: [number, number, number]): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

/**
 * Colours for a kit from a logo's pixels (RGBA): the logo's main colours by k-means, the most
 * vivid as primary, a different hue as accent, and a background and text with good contrast.
 */
export function paletteFromPixels(rgba: Uint8Array | Uint8ClampedArray, dark = true): Colors {
  const points: [number, number, number][] = [];
  for (let i = 0; i < rgba.length; i += 4 * 7) {
    if (rgba[i + 3] < 160) continue;
    points.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
  if (points.length < 8) return { ...BUILT_IN_KITS[0].colors };
  const k = Math.min(5, points.length);
  // Seeds spread through the pixels, then a few rounds of k-means.
  let centers = Array.from({ length: k }, (_, i) => points[Math.floor(((i + 0.5) / k) * points.length)]);
  let counts: number[] = [];
  for (let round = 0; round < 8; round++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = centers.map(() => 0);
    for (const p of points) {
      let best = 0, bestD = Infinity;
      centers.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestD) (bestD = d), (best = j);
      });
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += p[2];
      counts[best]++;
    }
    centers = centers.map((c, j) => (counts[j] ? [sums[j][0] / counts[j], sums[j][1] / counts[j], sums[j][2] / counts[j]] : c));
  }
  const clusters = centers.map((c, j) => ({ hex: hexOf(c), n: counts[j], hsl: hsl(c) })).filter((c) => c.n > 0);
  // Vivid and common: saturation, weighted a little by how much of the logo it covers.
  const vivid = [...clusters].sort((a, b) => b.hsl[1] * (0.6 + 0.4 * Math.sqrt(b.n / points.length)) - a.hsl[1] * (0.6 + 0.4 * Math.sqrt(a.n / points.length)));
  const primary = vivid[0]?.hsl[1] > 0.15 ? vivid[0].hex : dark ? "#7c5cff" : "#2f6bff";
  const hue = hsl(rgbOf(primary))[0];
  const other = vivid.find((c) => c.hex !== primary && c.hsl[1] > 0.2 && Math.min(Math.abs(c.hsl[0] - hue), 360 - Math.abs(c.hsl[0] - hue)) > 30);
  const accent = other ? other.hex : mix(primary, dark ? "#ffffff" : "#000000", 0.45);
  const background = dark ? mix(primary, "#05060a", 0.9) : mix(primary, "#ffffff", 0.94);
  const text = dark ? "#f5f6fa" : "#14151a";
  const secondary = dark ? mix(primary, "#05060a", 0.72) : mix(primary, "#ffffff", 0.78);
  return { primary, secondary, accent, background, text };
}
