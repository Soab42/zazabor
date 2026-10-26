import type { TextAnim, TextClip, TextStyle } from "./model";

/**
 * Texts on the canvas: drawn with Canvas 2D (so system fonts and Bangla shaping come from the
 * browser), then used as a texture. A text is redrawn only when its content, style, size or the
 * typewriter's visible length changes.
 */

export interface TextPreset {
  id: string;
  label: string;
  style: TextStyle;
  animIn: TextAnim;
  animOut: TextAnim;
}

const base: TextStyle = {
  font: "sans-serif", size: 56, color: "#ffffff", stroke: null, strokeWidth: 0, box: null,
  shadow: false, bold: true, italic: false, align: "center",
};

export const TEXT_PRESETS: TextPreset[] = [
  { id: "classic", label: "Classic", style: { ...base, stroke: "#000000", strokeWidth: 90 }, animIn: "fade", animOut: "fade" },
  { id: "box", label: "Box", style: { ...base, box: "rgba(0,0,0,0.62)" }, animIn: "pop", animOut: "fade" },
  { id: "bold", label: "Bold title", style: { ...base, size: 84, font: "sans-serif", shadow: true }, animIn: "pop", animOut: "pop" },
  { id: "caption", label: "Caption", style: { ...base, size: 44, color: "#fff36a", stroke: "#000000", strokeWidth: 110 }, animIn: "none", animOut: "none" },
  { id: "neon", label: "Neon", style: { ...base, color: "#7af8ff", shadow: true, bold: false, size: 64 }, animIn: "fade", animOut: "fade" },
  { id: "serif", label: "Elegant", style: { ...base, font: "serif", bold: false, italic: true, size: 64, shadow: true }, animIn: "slide", animOut: "fade" },
  { id: "typewriter", label: "Typewriter", style: { ...base, font: "monospace", bold: false, size: 48, box: "rgba(255,255,255,0.88)", color: "#111111" }, animIn: "typewriter", animOut: "fade" },
  { id: "bounce", label: "Bounce", style: { ...base, color: "#ffd166", stroke: "#3a1d00", strokeWidth: 80, size: 72 }, animIn: "bounce", animOut: "pop" },
];

export const TEXT_FONTS = [
  ["sans-serif", "Sans"],
  ["serif", "Serif"],
  ["monospace", "Mono"],
  ["'Noto Sans Bengali', sans-serif", "Bangla (Noto Sans)"],
  ["'DejaVu Sans Condensed', sans-serif", "Condensed"],
  ["cursive", "Handwriting"],
] as const;

export const TEXT_ANIMS: [TextAnim, string][] = [
  ["none", "None"], ["fade", "Fade"], ["pop", "Pop"], ["slide", "Slide up"], ["typewriter", "Typewriter"], ["bounce", "Bounce"],
];

/** How long in and out animations take. */
const ANIM_SECONDS = 0.45;

export interface TextLook {
  /** Visible characters (typewriter), −1 for all. */
  chars: number;
  opacity: number;
  scale: number;
  /** Offset in canvas heights. */
  dy: number;
}

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
function backOut(x: number) {
  const c = 1.70158;
  const t = Math.min(1, Math.max(0, x)) - 1;
  return 1 + (c + 1) * t * t * t + c * t * t;
}
function bounceOut(x: number) {
  const t = Math.min(1, Math.max(0, x));
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t - 1.5 / d) ** 2 + 0.75;
  if (t < 2.5 / d) return n * (t - 2.25 / d) ** 2 + 0.9375;
  return n * (t - 2.625 / d) ** 2 + 0.984375;
}

/** The animation state of a text `local` seconds after it starts. */
export function textLook(c: TextClip, local: number): TextLook {
  const look: TextLook = { chars: -1, opacity: 1, scale: 1, dy: 0 };
  const span = Math.min(ANIM_SECONDS, c.duration / 2);
  const inP = span > 0 ? local / span : 1;
  const outP = span > 0 ? (c.duration - local) / span : 1;
  if (inP < 1) {
    switch (c.animIn) {
      case "fade": look.opacity = easeOut(inP); break;
      case "pop": look.scale = 0.6 + 0.4 * backOut(inP); look.opacity = easeOut(inP * 2); break;
      case "slide": look.dy = 0.06 * (1 - easeOut(inP)); look.opacity = easeOut(inP); break;
      case "bounce": look.scale = Math.max(0.01, bounceOut(inP)); break;
      default: break;
    }
  }
  if (c.animIn === "typewriter") {
    const total = [...c.text].length;
    const typing = Math.min(c.duration * 0.6, total * 0.06);
    look.chars = typing > 0 ? Math.min(total, Math.floor((local / typing) * total)) : total;
  }
  if (outP < 1) {
    switch (c.animOut) {
      case "fade": case "typewriter": look.opacity *= easeOut(outP); break;
      case "pop": look.scale *= 0.6 + 0.4 * easeOut(outP); look.opacity *= easeOut(outP); break;
      case "slide": look.dy -= 0.06 * (1 - easeOut(outP)); look.opacity *= easeOut(outP); break;
      case "bounce": look.scale *= easeOut(outP); break;
      default: break;
    }
  }
  return look;
}

function font(style: TextStyle, px: number) {
  return `${style.italic ? "italic " : ""}${style.bold ? "700 " : "400 "}${Math.max(4, Math.round(px))}px ${style.font}`;
}

/** Breaks text into lines that fit `width` (words first, then characters for long words). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/(\s+)/);
    let line = "";
    for (const word of words) {
      const next = line + word;
      if (ctx.measureText(next).width <= width || !line.trim()) {
        line = next;
        if (ctx.measureText(line).width > width) {
          // One long word: break it by characters.
          let part = "";
          for (const ch of [...line]) {
            if (ctx.measureText(part + ch).width > width && part) {
              lines.push(part);
              part = ch;
            } else part += ch;
          }
          line = part;
        }
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/**
 * Draws a text for a canvas `canvasHeight` pixels tall into `out` (resized to fit), showing
 * `chars` characters (−1 for all). Returns the drawing's size.
 */
export function drawText(out: HTMLCanvasElement, c: TextClip, canvasWidth: number, canvasHeight: number, chars: number): { width: number; height: number } {
  const s = c.style;
  const px = (s.size / 1000) * canvasHeight;
  const ctx = out.getContext("2d")!;
  ctx.font = font(s, px);
  const text = chars >= 0 ? [...c.text].slice(0, chars).join("") : c.text;
  const lines = wrap(ctx, text || " ", canvasWidth * 0.86);
  const lineHeight = px * 1.22;
  const stroke = s.stroke ? (s.strokeWidth / 1000) * px : 0;
  const padX = s.box ? px * 0.45 : 0, padY = s.box ? px * 0.22 : 0;
  const glow = s.shadow ? px * 0.25 : 0;
  const widths = lines.map((l) => ctx.measureText(l).width);
  // Size the drawing for the full text, so typing doesn't move the block around.
  const fullLines = chars >= 0 ? wrap(ctx, c.text || " ", canvasWidth * 0.86) : lines;
  const fullWidths = fullLines.map((l) => ctx.measureText(l).width);
  const textWidth = Math.max(1, ...fullWidths);
  const margin = Math.ceil(stroke + glow + 2);
  const w = Math.ceil(textWidth + padX * 2 + margin * 2);
  const h = Math.ceil(fullLines.length * lineHeight + padY * 2 + margin * 2);
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  } else ctx.clearRect(0, 0, w, h);
  ctx.font = font(s, px);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const xFor = (lw: number) => (s.align === "left" ? margin + padX : s.align === "right" ? w - margin - padX - lw : (w - lw) / 2);
  if (s.box) {
    ctx.fillStyle = s.box;
    const r = px * 0.28;
    lines.forEach((line, i) => {
      if (!line.trim() && lines.length > 1) return;
      const lw = widths[i];
      const x = xFor(lw) - padX, y = margin + i * lineHeight, bw = lw + padX * 2, bh = lineHeight + padY * 2;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, r);
      ctx.fill();
    });
  }
  lines.forEach((line, i) => {
    const x = xFor(widths[i]);
    const y = margin + padY + i * lineHeight + lineHeight / 2;
    if (s.shadow) {
      ctx.shadowColor = s.color === "#ffffff" ? "rgba(0,0,0,0.65)" : s.color;
      ctx.shadowBlur = glow;
      ctx.shadowOffsetY = s.color === "#ffffff" ? px * 0.04 : 0;
    }
    if (stroke > 0 && s.stroke) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = stroke * 2;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });
  return { width: w, height: h };
}

/** A key that changes whenever the drawing would. */
export function textKey(c: TextClip, canvasHeight: number, chars: number) {
  return `${c.text}\u0000${JSON.stringify(c.style)}\u0000${canvasHeight}\u0000${chars}`;
}
