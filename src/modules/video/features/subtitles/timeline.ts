/** Maths for the subtitle timeline strip: a window of time around the playhead. */

export const MAX_DELAY_MS = 10_000;
export const DELAY_STEP_MS = 50;

export interface TimeWindow {
  from: number;
  to: number;
}

/** The window of `span` ms centred on `center`. */
export function windowAround(center: number, span: number): TimeWindow {
  return { from: center - span / 2, to: center + span / 2 };
}

/** Horizontal position (0–1) of a time in the window. */
export function fraction(time: number, window: TimeWindow): number {
  return (time - window.from) / (window.to - window.from);
}

/** Milliseconds per pixel for a strip `width` px wide showing `span` ms. */
export function msPerPixel(span: number, width: number): number {
  return width > 0 ? span / width : 0;
}

/** Rounds a delay to the step and keeps it within ±10 s. */
export function snapDelay(ms: number, step = DELAY_STEP_MS, limit = MAX_DELAY_MS): number {
  const snapped = Math.round(ms / step) * step;
  return Math.max(-limit, Math.min(limit, snapped)) || 0;
}

/** The delay after dragging the strip `dx` px to the right (later) from `startDelay`. */
export function dragToDelay(startDelay: number, dx: number, msPerPx: number): number {
  return snapDelay(startDelay + dx * msPerPx);
}

/** "+1.25 s" / "−0.30 s" / "0 s" for the delay readout. */
export function formatDelay(ms: number): string {
  if (ms === 0) return "0 s";
  return `${ms > 0 ? "+" : "−"}${(Math.abs(ms) / 1000).toFixed(2)} s`;
}
