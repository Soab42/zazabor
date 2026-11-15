import type { FeatureFactory } from "./extensions";
import { createLibraryFeature } from "./features/library";
import { createMediaTools } from "./features/open";
import { panelFeatures } from "./features/panel";
import { quickFeature } from "./features/quick";
import { receiverFeature } from "./features/receiver";

/** The Video module's features, in order (see `extensions.ts`). Add a line per feature. */
export const FEATURES: FeatureFactory[] = [
  quickFeature,
  ...panelFeatures,
  createLibraryFeature,
  createMediaTools, // open, convert, cast, profiles, intro, shortcuts
  receiverFeature, // Cast to This PC
];
