/** How subtitles look: the settings, and turning them into CSS for our own renderer. */

export type FontKey = "system" | "serif" | "mono" | "arial" | "georgia" | "verdana" | "trebuchet" | "impact";

export interface SubStyle {
  font: FontKey;
  /** "relative" scales with the picture height, "exact" is a pixel size. */
  sizeMode: "relative" | "exact";
  /** Percent of the default size (relative mode). */
  sizePct: number;
  sizePx: number;
  /** CSS colour of the text, "#rrggbb". */
  color: string;
  /** Outline width in px, 0–4. */
  outline: number;
  /** Soft shadow strength 0–1. */
  shadow: number;
  /** Opacity of the box behind each line, 0–0.9. */
  box: number;
  /** Distance of bottom-aligned subtitles from the bottom edge, percent of the picture height. */
  bottom: number;
  bold: boolean;
}

export const DEFAULT_STYLE: SubStyle = {
  font: "system", sizeMode: "relative", sizePct: 100, sizePx: 32, color: "#ffffff", outline: 2, shadow: 0.5, box: 0, bottom: 7, bold: false,
};

export const FONTS: { key: FontKey; label: string; css: string }[] = [
  { key: "system", label: "System", css: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif' },
  { key: "serif", label: "Serif", css: 'Georgia, "Times New Roman", "DejaVu Serif", serif' },
  { key: "mono", label: "Monospace", css: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace' },
  { key: "arial", label: "Arial", css: 'Arial, "Liberation Sans", Helvetica, sans-serif' },
  { key: "georgia", label: "Georgia", css: 'Georgia, "DejaVu Serif", serif' },
  { key: "verdana", label: "Verdana", css: 'Verdana, "DejaVu Sans", sans-serif' },
  { key: "trebuchet", label: "Trebuchet", css: '"Trebuchet MS", "DejaVu Sans", sans-serif' },
  { key: "impact", label: "Impact", css: 'Impact, "Arial Black", "Liberation Sans", sans-serif' },
];

/** The base size at 100 %: this many percent of the stage height. */
const BASE_HEIGHT_PERCENT = 4.4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A style from saved data: unknown or out-of-range values fall back to the defaults. */
export function normalizeStyle(raw: Partial<SubStyle> | undefined): SubStyle {
  const s = { ...DEFAULT_STYLE, ...(raw && typeof raw === "object" ? raw : {}) };
  return {
    font: FONTS.some((f) => f.key === s.font) ? s.font : DEFAULT_STYLE.font,
    sizeMode: s.sizeMode === "exact" ? "exact" : "relative",
    sizePct: clamp(Number(s.sizePct) || 100, 50, 300),
    sizePx: clamp(Number(s.sizePx) || 32, 12, 120),
    color: /^#[0-9a-f]{6}$/i.test(String(s.color)) ? String(s.color) : DEFAULT_STYLE.color,
    outline: clamp(Number(s.outline) || 0, 0, 4),
    shadow: clamp(Number(s.shadow) || 0, 0, 1),
    box: clamp(Number(s.box) || 0, 0, 0.9),
    bottom: clamp(Number.isFinite(Number(s.bottom)) ? Number(s.bottom) : 7, 0, 40),
    bold: !!s.bold,
  };
}

/** Font size in px for a stage `height` px tall. */
export function fontSizePx(style: SubStyle, height: number): number {
  return style.sizeMode === "exact" ? style.sizePx : Math.max(10, (height * BASE_HEIGHT_PERCENT * style.sizePct) / 10_000);
}

/** The text-shadow that draws an outline of `width` px (8 directions) and a soft drop shadow. */
export function textShadow(style: SubStyle): string {
  const parts: string[] = [];
  const w = style.outline;
  if (w > 0) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      parts.push(`${(Math.cos(a) * w).toFixed(2)}px ${(Math.sin(a) * w).toFixed(2)}px 0 #000`);
    }
  }
  if (style.shadow > 0) parts.push(`0 ${(1 + style.shadow * 2).toFixed(1)}px ${(2 + style.shadow * 6).toFixed(1)}px rgba(0,0,0,${(0.35 + style.shadow * 0.6).toFixed(2)})`);
  return parts.join(", ") || "none";
}

/** Applies the style to a subtitle container; `height` is the stage height in px. */
export function applyStyle(el: HTMLElement, style: SubStyle, height: number) {
  const font = FONTS.find((f) => f.key === style.font) ?? FONTS[0];
  el.style.fontFamily = font.css;
  el.style.fontSize = `${fontSizePx(style, height).toFixed(1)}px`;
  el.style.fontWeight = style.bold ? "700" : "500";
  el.style.color = style.color;
  el.style.setProperty("--sub-shadow", textShadow(style));
  el.style.setProperty("--sub-box", style.box > 0 ? `rgba(0,0,0,${style.box.toFixed(2)})` : "transparent");
  el.style.setProperty("--sub-box-pad", style.box > 0 ? "0.08em 0.5em" : "0");
}
