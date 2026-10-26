import type { Adjustments } from "./adjust";
import type { Geometry } from "./geometry";

/**
 * Quick Edit's "Open in Photo": the Gallery leaves its settings here, keyed by the picture's path,
 * and Photo takes them when it opens that picture (as an adjustment layer over the cropped photo).
 * Kept apart from the editor so the Gallery doesn't load it.
 */
export interface QuickEditSettings {
  geometry: Geometry;
  adjust: Adjustments;
}

const pending = new Map<string, QuickEditSettings>();

export function leaveForPhoto(path: string, settings: QuickEditSettings) {
  pending.set(path, settings);
}

export function takeForPhoto(path: string): QuickEditSettings | null {
  const settings = pending.get(path) ?? null;
  pending.delete(path);
  return settings;
}
