import type { FeatureFactory } from "./extensions";
import { quickFeature } from "./features/quick";
import { panelFeatures } from "./features/panel";

/** The Video module's features, in order (see `extensions.ts`). Add a line per feature. */
export const FEATURES: FeatureFactory[] = [
  quickFeature,
  ...panelFeatures,
];
