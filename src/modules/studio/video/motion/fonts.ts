/**
 * The fonts bundled for motion templates (SIL Open Font License, from github.com/google/fonts at
 * the commit in tools/fetch_motion_fonts.py, files and licences in public/fonts/). A family is
 * loaded the first time something draws with it; drawing waits for it where it matters (export,
 * posters) and redraws when it arrives elsewhere.
 */

export type FontKind = "sans" | "display" | "serif" | "script" | "bangla";

export interface Bundled {
  family: string;
  kind: FontKind;
  dir: string;
  /** Files: [file, weight range or weight, style]. */
  files: [string, string, "normal" | "italic"][];
  /** Has Bengali letters. */
  bangla?: boolean;
}

export const BUNDLED: readonly Bundled[] = [
  { family: "Inter", kind: "sans", dir: "inter", files: [["Inter[opsz,wght].ttf", "100 900", "normal"]] },
  { family: "Poppins", kind: "sans", dir: "poppins", files: [["Poppins-Regular.ttf", "400", "normal"], ["Poppins-SemiBold.ttf", "600", "normal"], ["Poppins-Bold.ttf", "700", "normal"], ["Poppins-ExtraBold.ttf", "800", "normal"]] },
  { family: "Montserrat", kind: "sans", dir: "montserrat", files: [["Montserrat[wght].ttf", "100 900", "normal"]] },
  { family: "Plus Jakarta Sans", kind: "sans", dir: "plusjakartasans", files: [["PlusJakartaSans[wght].ttf", "200 800", "normal"]] },
  { family: "DM Sans", kind: "sans", dir: "dmsans", files: [["DMSans[opsz,wght].ttf", "100 1000", "normal"]] },
  { family: "Manrope", kind: "sans", dir: "manrope", files: [["Manrope[wght].ttf", "200 800", "normal"]] },
  { family: "Space Grotesk", kind: "sans", dir: "spacegrotesk", files: [["SpaceGrotesk[wght].ttf", "300 700", "normal"]] },
  { family: "Outfit", kind: "sans", dir: "outfit", files: [["Outfit[wght].ttf", "100 900", "normal"]] },
  { family: "Sora", kind: "sans", dir: "sora", files: [["Sora[wght].ttf", "100 800", "normal"]] },
  { family: "Bebas Neue", kind: "display", dir: "bebasneue", files: [["BebasNeue-Regular.ttf", "400", "normal"]] },
  { family: "Anton", kind: "display", dir: "anton", files: [["Anton-Regular.ttf", "400", "normal"]] },
  { family: "Oswald", kind: "display", dir: "oswald", files: [["Oswald[wght].ttf", "200 700", "normal"]] },
  { family: "Archivo Black", kind: "display", dir: "archivoblack", files: [["ArchivoBlack-Regular.ttf", "400", "normal"]] },
  { family: "Syne", kind: "display", dir: "syne", files: [["Syne[wght].ttf", "400 800", "normal"]] },
  { family: "Unbounded", kind: "display", dir: "unbounded", files: [["Unbounded[wght].ttf", "200 900", "normal"]] },
  { family: "Righteous", kind: "display", dir: "righteous", files: [["Righteous-Regular.ttf", "400", "normal"]] },
  { family: "Playfair Display", kind: "serif", dir: "playfairdisplay", files: [["PlayfairDisplay[wght].ttf", "400 900", "normal"], ["PlayfairDisplay-Italic[wght].ttf", "400 900", "italic"]] },
  { family: "DM Serif Display", kind: "serif", dir: "dmserifdisplay", files: [["DMSerifDisplay-Regular.ttf", "400", "normal"], ["DMSerifDisplay-Italic.ttf", "400", "italic"]] },
  { family: "Fraunces", kind: "serif", dir: "fraunces", files: [["Fraunces[SOFT,WONK,opsz,wght].ttf", "100 900", "normal"]] },
  { family: "Cormorant Garamond", kind: "serif", dir: "cormorantgaramond", files: [["CormorantGaramond[wght].ttf", "300 700", "normal"]] },
  { family: "Pacifico", kind: "script", dir: "pacifico", files: [["Pacifico-Regular.ttf", "400", "normal"]] },
  { family: "Caveat", kind: "script", dir: "caveat", files: [["Caveat[wght].ttf", "400 700", "normal"]] },
  { family: "Dancing Script", kind: "script", dir: "dancingscript", files: [["DancingScript[wght].ttf", "400 700", "normal"]] },
  { family: "Hind Siliguri", kind: "bangla", dir: "hindsiliguri", bangla: true, files: [["HindSiliguri-Regular.ttf", "400", "normal"], ["HindSiliguri-SemiBold.ttf", "600", "normal"], ["HindSiliguri-Bold.ttf", "700", "normal"]] },
  { family: "Anek Bangla", kind: "bangla", dir: "anekbangla", bangla: true, files: [["AnekBangla[wdth,wght].ttf", "100 800", "normal"]] },
  { family: "Baloo Da 2", kind: "bangla", dir: "balooda2", bangla: true, files: [["BalooDa2[wght].ttf", "400 800", "normal"]] },
  { family: "Tiro Bangla", kind: "bangla", dir: "tirobangla", bangla: true, files: [["TiroBangla-Regular.ttf", "400", "normal"]] },
  { family: "Galada", kind: "bangla", dir: "galada", bangla: true, files: [["Galada-Regular.ttf", "400", "normal"]] },
];

export const FONT_KINDS: [FontKind, string][] = [["sans", "Sans"], ["display", "Display"], ["serif", "Serif"], ["script", "Script"], ["bangla", "Bangla"]];

/** Font pairings, as named presets for the inspector and Brand Kits. */
export const PAIRINGS: { id: string; label: string; heading: [string, number]; body: [string, number]; bangla: [string, number] }[] = [
  { id: "modern", label: "Modern: Plus Jakarta Sans + Inter", heading: ["Plus Jakarta Sans", 800], body: ["Inter", 500], bangla: ["Anek Bangla", 600] },
  { id: "editorial", label: "Editorial: Playfair Display + Inter", heading: ["Playfair Display", 700], body: ["Inter", 400], bangla: ["Tiro Bangla", 400] },
  { id: "retail", label: "Bold Retail: Anton + Poppins", heading: ["Anton", 400], body: ["Poppins", 600], bangla: ["Hind Siliguri", 700] },
  { id: "tech", label: "Tech: Space Grotesk + Inter", heading: ["Space Grotesk", 700], body: ["Inter", 500], bangla: ["Hind Siliguri", 600] },
  { id: "friendly", label: "Friendly: Outfit + Outfit", heading: ["Outfit", 800], body: ["Outfit", 500], bangla: ["Baloo Da 2", 600] },
  { id: "luxury", label: "Luxury: DM Serif Display + Manrope", heading: ["DM Serif Display", 400], body: ["Manrope", 500], bangla: ["Tiro Bangla", 400] },
  { id: "street", label: "Street: Bebas Neue + Montserrat", heading: ["Bebas Neue", 400], body: ["Montserrat", 600], bangla: ["Anek Bangla", 700] },
  { id: "playful", label: "Playful: Unbounded + DM Sans", heading: ["Unbounded", 800], body: ["DM Sans", 500], bangla: ["Baloo Da 2", 700] },
  { id: "bangla", label: "Bangla Modern: Anek Bangla + Hind Siliguri", heading: ["Anek Bangla", 700], body: ["Hind Siliguri", 500], bangla: ["Anek Bangla", 700] },
];

export const bundledFamily = (family: string) => BUNDLED.find((b) => b.family === family);

/** A CSS font family list: the family, the theme's Bangla font for Bengali letters, then a generic one. */
export function familyStack(family: string, bangla?: string): string {
  const generic = bundledFamily(family)?.kind === "serif" ? "serif" : "sans-serif";
  const list = [family, bangla && bangla !== family ? bangla : null, "Noto Sans Bengali"].filter((f): f is string => !!f);
  return [...list.map((f) => `"${f.replace(/"/g, "")}"`), generic].join(", ");
}

const loads = new Map<string, Promise<void>>();
/** Families whose files have loaded, and those that couldn't be read (drawn with the fallback, not asked for again). */
const done = new Set<string>();
const failed = new Set<string>();

/** Loads a bundled family's files (once). Families that aren't bundled are the system's: nothing to load. */
export function loadFamily(family: string): Promise<void> {
  const b = bundledFamily(family);
  if (!b) return Promise.resolve();
  let p = loads.get(b.family);
  if (!p) {
    p = Promise.all(b.files.map(async ([file, weight, style]) => {
      // Commas stay as they are: a dev server takes "%2C" literally.
      const url = `/fonts/${b.dir}/${encodeURI(file)}`;
      const face = new FontFace(b.family, `url("${url}")`, { weight, style, display: "block" });
      await face.load();
      document.fonts.add(face);
    })).then(() => {
      done.add(b.family);
    }).catch((err) => {
      failed.add(b.family);
      console.warn("[motion] font", b.family, err);
    });
    loads.set(b.family, p);
  }
  return p;
}

// (Not `document.fonts.check`: it answers true for a family it has no faces for yet.)
export const familyLoaded = (family: string) => !bundledFamily(family) || done.has(family) || failed.has(family);

/** The bundled families a CSS font-family list names. */
function bundledIn(fontCss: string): Bundled[] {
  const names = fontCss.split(",").map((n) => n.trim().replace(/^["']|["']$/g, ""));
  return BUNDLED.filter((b) => names.includes(b.family));
}

/** Every bundled family a CSS font-family list names (text clips made by Ungroup), loaded. */
export function loadFamiliesIn(fontCss: string): Promise<void> {
  return Promise.all(bundledIn(fontCss).map((b) => loadFamily(b.family))).then(() => undefined);
}

/** Whether the bundled families a CSS font-family list names are loaded. */
export const familiesLoadedIn = (fontCss: string) => bundledIn(fontCss).every((b) => familyLoaded(b.family));

/** The weight nearest `want` a family has (a variable font has its whole range). */
export function weightFor(family: string, want: number): number {
  const b = bundledFamily(family);
  if (!b) return want;
  let best = want, gap = Infinity;
  for (const [, range] of b.files) {
    const [lo, hi] = range.split(" ").map(Number);
    const v = Math.max(lo, Math.min(hi ?? lo, want));
    if (Math.abs(v - want) < gap) {
      gap = Math.abs(v - want);
      best = v;
    }
  }
  return best;
}
