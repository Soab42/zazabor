import { BUILT_IN_KITS, DEFAULT_KIT_ID, lookTheme, normalizeKit, normalizeTheme, OWN_LOOK, themeOf, type BrandKit, type Theme } from "./brand";
import { normalizeTemplate, type Template } from "./format";

/**
 * What motion templates keep in Studio's settings (`studio.apps.motion`): the user's Brand Kits
 * and which one new templates get, My Templates, and the browser's switches. Pure.
 */

/** A template saved to My Templates: the template with the user's texts, theme and pictures. */
export interface SavedTemplate {
  id: string;
  name: string;
  /** When it was saved (ms since 1970). */
  saved: number;
  doc: Template;
  values: Record<string, string>;
  theme: Theme;
  /** Media slots: field id → the picture kept in the app's data folder for it. */
  pictures: Record<string, string>;
}

export interface MotionSettings {
  /** The user's own kits (the built-in ones aren't stored). */
  kits: BrandKit[];
  /** The kit new templates get, or OWN_LOOK: each template's own look. */
  defaultKit: string;
  /** The user chose `defaultKit` (Midnight was everyone's default before templates had looks). */
  kitChosen?: boolean;
  mine: SavedTemplate[];
  /** The browser previews fields in Bangla. */
  bangla: boolean;
  /** Using a template also adds its suggested sound effects. */
  sounds: boolean;
}

export const MAX_KITS = 40;
export const MAX_MINE = 100;

export function allKits(s: MotionSettings): BrandKit[] {
  return [...BUILT_IN_KITS, ...s.kits];
}

export function kitById(s: MotionSettings, id: string | null): BrandKit | undefined {
  return id ? allKits(s).find((k) => k.id === id) : undefined;
}

/** The kit new templates get (the first built-in one while they get their own looks). */
export function defaultKit(s: MotionSettings): BrandKit {
  return kitById(s, s.defaultKit) ?? BUILT_IN_KITS[0];
}

/** New templates show their own looks (no default kit chosen). */
export function usesOwnLook(s: MotionSettings): boolean {
  return s.defaultKit === OWN_LOOK;
}

/** The kit new templates get, or OWN_LOOK. */
export function setDefaultKit(s: MotionSettings, id: string): void {
  s.defaultKit = id === OWN_LOOK || kitById(s, id) ? id : OWN_LOOK;
  s.kitChosen = s.defaultKit !== OWN_LOOK;
}

/** The theme and kit a new `template` starts with: its own look, or the default kit's. */
export function themeFor(template: Template, s: MotionSettings): { theme: Theme; kit: string } {
  if (usesOwnLook(s)) return { theme: lookTheme(template.look), kit: OWN_LOOK };
  const kit = defaultKit(s);
  return { theme: themeOf(kit), kit: kit.id };
}

function normalizeSaved(raw: unknown): SavedTemplate | null {
  const r = raw as Partial<SavedTemplate> | undefined;
  if (!r || typeof r.id !== "string" || !r.id) return null;
  const doc = normalizeTemplate(r.doc);
  if (!doc) return null;
  const strings = (v: unknown) => Object.fromEntries(Object.entries(v && typeof v === "object" ? v as Record<string, unknown> : {}).filter(([, x]) => typeof x === "string")) as Record<string, string>;
  return {
    id: r.id.slice(0, 64),
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : doc.name,
    saved: typeof r.saved === "number" ? r.saved : 0,
    doc,
    values: strings(r.values),
    theme: normalizeTheme(r.theme),
    pictures: strings(r.pictures),
  };
}

export function normalizeMotionSettings(raw: unknown): MotionSettings {
  const r = (raw ?? {}) as Partial<MotionSettings>;
  const builtIn = new Set(BUILT_IN_KITS.map((k) => k.id));
  const kits = (Array.isArray(r.kits) ? r.kits : [])
    .map(normalizeKit)
    .filter((k): k is BrandKit => !!k && !builtIn.has(k.id))
    .slice(0, MAX_KITS);
  for (const k of kits) delete k.builtIn;
  const kitChosen = !!r.kitChosen;
  const stored = typeof r.defaultKit === "string" ? r.defaultKit : OWN_LOOK;
  const s: MotionSettings = {
    kits,
    defaultKit: stored === DEFAULT_KIT_ID && !kitChosen ? OWN_LOOK : stored,
    kitChosen,
    mine: (Array.isArray(r.mine) ? r.mine : []).map(normalizeSaved).filter((x): x is SavedTemplate => !!x).slice(0, MAX_MINE),
    bangla: !!r.bangla,
    sounds: r.sounds === undefined ? true : !!r.sounds,
  };
  if (s.defaultKit !== OWN_LOOK && !kitById(s, s.defaultKit)) s.defaultKit = OWN_LOOK;
  if (s.defaultKit === OWN_LOOK) s.kitChosen = false;
  return s;
}

/** A `.zazkit` file's contents. */
export interface KitFile {
  app: "zazkit";
  version: 1;
  kit: Omit<BrandKit, "builtIn">;
}

export function kitFile(kit: BrandKit): KitFile {
  const { builtIn: _builtIn, ...rest } = kit;
  void _builtIn;
  return { app: "zazkit", version: 1, kit: { ...rest, logo: null } };
}

/** A kit read from a `.zazkit` file, with a fresh id (so importing twice makes two). */
export function readKitFile(raw: unknown, id: string): BrandKit | null {
  const r = raw as Partial<KitFile> | undefined;
  if (!r || r.app !== "zazkit") return null;
  const kit = normalizeKit({ ...(r.kit ?? {}), id });
  if (!kit) return null;
  delete kit.builtIn;
  return kit;
}
