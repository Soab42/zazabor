import type { Template, TemplateClip } from "../format";
import { featureTrio } from "./feature-trio";
import { productHero } from "./launch-hero";
import { lineLogo } from "./logo-line";
import { nameBar } from "./lower-name";
import { hookFollow } from "./reel-hook";
import { priceDrop } from "./sale-price";

/** The templates that ship with the app, in the browser's order. */
export const TEMPLATES: readonly Template[] = [productHero, priceDrop, featureTrio, lineLogo, nameBar, hookFollow];

export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/** A clip's template: its own document (My Templates) or a shipped one. */
export const templateOf = (c: Pick<TemplateClip, "template" | "doc">): Template | undefined => c.doc ?? templateById(c.template);
