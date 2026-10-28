/**
 * The maths of the inspector's number fields (controls.ts): how a value is shown, typed, stepped
 * and dragged. No DOM here, so tools/video-editor.test.mjs can check it.
 *
 * A value is shown as `(value - offset) * scale`: a position stored as 0…1 with 0.5 in the middle
 * shows as −50 … 50 % with `offset: 0.5, scale: 100`.
 */

export interface NumberSpec {
  min: number;
  max: number;
  /** One step of the arrow keys, and of every 2 px of a drag (model units). */
  step: number;
  scale?: number;
  offset?: number;
  /** Decimals shown; from the step when left out. */
  decimals?: number;
  /** Shown after the number ("%", "°", "s", "×", "px"). */
  unit?: string;
  /** Shows "+" before positive numbers (brightness and the like). */
  signed?: boolean;
  /** Replaces the usual text (e.g. "Off" at 0). */
  format?: (v: number) => string;
}

/** Pixels of drag per step. */
export const DRAG_PX = 2;

export function decimalsOf(spec: NumberSpec): number {
  if (spec.decimals !== undefined) return spec.decimals;
  const s = String(Number((spec.step * (spec.scale ?? 1)).toFixed(6)));
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

export const clampTo = (spec: NumberSpec, v: number) => Math.min(spec.max, Math.max(spec.min, v));

/** The number as shown, without its unit ("−8", "+12", "1.50"). */
export function displayNumber(spec: NumberSpec, v: number): string {
  const d = (v - (spec.offset ?? 0)) * (spec.scale ?? 1);
  let text = d.toFixed(decimalsOf(spec));
  if (/^-0(\.0+)?$/.test(text)) text = text.slice(1);
  if (text.startsWith("-")) return `−${text.slice(1)}`;
  return spec.signed && Number(text) > 0 ? `+${text}` : text;
}

/** The value as shown, with its unit ("−8 %", "0.6 s", "1.50×"). */
export function display(spec: NumberSpec, v: number): string {
  if (spec.format) return spec.format(v);
  const n = displayNumber(spec, v);
  if (!spec.unit) return n;
  return spec.unit === "×" || spec.unit === "°" ? `${n}${spec.unit}` : `${n} ${spec.unit}`;
}

/** A typed value in model units, kept in range; null when it isn't a number. */
export function parse(spec: NumberSpec, text: string): number | null {
  const cleaned = text.trim().replace(/[−–]/g, "-").replace(",", ".").replace(/[^0-9.+\-eE]/g, "");
  if (!cleaned || !/[0-9]/.test(cleaned)) return null;
  const d = Number(cleaned);
  if (!Number.isFinite(d)) return null;
  return clampTo(spec, d / (spec.scale ?? 1) + (spec.offset ?? 0));
}

/** `v` moved by `steps` steps of `step × factor`, on that grid and in range. */
export function stepBy(spec: NumberSpec, v: number, steps: number, factor = 1): number {
  const unit = spec.step * factor;
  const next = Math.round((v + steps * unit) / unit) * unit;
  return clampTo(spec, Number(next.toFixed(10)));
}

/** The value after dragging `dx` pixels from `start` (Shift: ×10, Alt: ×0.1). */
export const dragValue = (spec: NumberSpec, start: number, dx: number, factor = 1) => stepBy(spec, start, Math.trunc(dx / DRAG_PX), factor);

/** Where `v` sits along the range, 0…1 (for a slider's fill). */
export const fraction = (spec: NumberSpec, v: number) => (spec.max > spec.min ? Math.min(1, Math.max(0, (v - spec.min) / (spec.max - spec.min))) : 0);
