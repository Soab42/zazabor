import type { FeatureFactory } from "./extensions";
import { createLibraryFeature } from "./features/library";
import { panelFeatures } from "./features/panel";
import { quickFeature } from "./features/quick";

/** The Video module's features, in order (see `extensions.ts`). Add a line per feature. */
export const FEATURES: FeatureFactory[] = [
  quickFeature,
  ...panelFeatures,
  createLibraryFeature,
];
