import { isLocal, library, libraryEvents, readFile, type LibraryTemplate } from "../../../../content";
import { FORMAT_VERSION, normalizeTemplate, type Template, type TemplateClip } from "./format";
import { getTheApp } from "./templates/app-download";
import { notifications } from "./templates/app-notify";
import { featureTrio } from "./templates/feature-trio";
import { minimalLogo } from "./templates/logo-minimal";
import { nameBar } from "./templates/lower-name";
import { newsBar } from "./templates/lower-news";

/**
 * The motion templates the app has: the starter set that ships with it (using only the starter
 * fonts, see fonts.ts), and the content library's, listed in its catalog. The library's are small
 * documents, all downloaded with the catalog and kept, so projects open offline; a library
 * version of a starter template replaces the shipped one. Every template's source is in
 * templates/ (index.ts lists them all), and tools/content/build.mjs publishes them.
 */
export const STARTER_TEMPLATES: readonly Template[] = [featureTrio, nameBar, minimalLogo, newsBar, notifications, getTheApp];

let all: readonly Template[] = STARTER_TEMPLATES;
let byId = new Map(all.map((t) => [t.id, t]));
/** How many of the library's templates need a newer Zazabor. */
let needsUpdate = 0;
/** The library's catalog has been had (online now or before). */
let haveLibrary = false;

/** Fires "change" when the templates have changed (the library's arrived or was updated). */
export const templateEvents = new EventTarget();

/** The templates, in the browser's order. */
export const templates = (): readonly Template[] => all;

/** How many of the library's templates need a newer Zazabor (they're left out until then). */
export const templatesNeedingUpdate = () => needsUpdate;

/** Only the starter set is here: the library hasn't been reached yet (offline since installing). */
export const onlyStarterTemplates = () => !haveLibrary;

export const templateById = (id: string): Template | undefined => byId.get(id);

/** A clip's template: its own document (My Templates) or the app's. */
export const templateOf = (c: Pick<TemplateClip, "template" | "doc">): Template | undefined => c.doc ?? templateById(c.template);

let loading: Promise<void> | null = null;

/** Loads the library's templates (once, and again when a newer catalog arrives). */
export function loadTemplates(): Promise<void> {
  loading ??= load();
  return loading;
}

libraryEvents.addEventListener("change", () => {
  if (loading) loading = loading.then(load);
});

/** The template in a library file, or null when it can't be had (offline and never downloaded) or read. */
async function fetchTemplate(entry: LibraryTemplate): Promise<Template | null> {
  try {
    const doc = normalizeTemplate(JSON.parse(new TextDecoder().decode(await readFile(entry.file))));
    return doc?.id === entry.id ? doc : null;
  } catch (err) {
    console.warn(`[motion] template ${entry.id}:`, err);
    return null;
  }
}

async function load() {
  const { catalog, error } = await library();
  const entries = catalog?.templates ?? [];
  const usable = entries.filter((e) => e.format <= FORMAT_VERSION);
  // Offline, only what's downloaded (each of the others would wait for the network in vain).
  const reachable = (e: LibraryTemplate) => !error || isLocal(e.file);
  // A few at a time: on a first start they all download.
  const docs: (Template | null)[] = new Array(usable.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < usable.length) {
      const i = next++;
      if (reachable(usable[i])) docs[i] = await fetchTemplate(usable[i]);
    }
  }));
  const list: Template[] = [];
  usable.forEach((e, i) => {
    const doc = docs[i] ?? STARTER_TEMPLATES.find((t) => t.id === e.id);
    if (doc) list.push(doc);
  });
  // Starter templates the catalog doesn't have (never online yet) stay, at the front.
  list.unshift(...STARTER_TEMPLATES.filter((t) => !list.some((x) => x.id === t.id)));
  needsUpdate = entries.length - usable.length;
  haveLibrary = !!catalog;
  all = list;
  byId = new Map(list.map((t) => [t.id, t]));
  templateEvents.dispatchEvent(new Event("change"));
}
