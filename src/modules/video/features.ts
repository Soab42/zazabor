import type { FeatureFactory } from "./extensions";
import { createLibraryFeature } from "./features/library";

/** The Video module's features, in order (see `extensions.ts`). Add a line per feature. */
export const FEATURES: FeatureFactory[] = [createLibraryFeature];
