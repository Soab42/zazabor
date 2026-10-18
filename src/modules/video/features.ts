import type { FeatureFactory } from "./extensions";
import { createMediaTools } from "./features/open";

/** The Video module's features, in order (see `extensions.ts`). Add a line per feature. */
export const FEATURES: FeatureFactory[] = [
  createMediaTools, // open, convert, cast, profiles, intro, shortcuts
];
