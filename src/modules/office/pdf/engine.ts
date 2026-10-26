import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfjs } from "../../../shared/quicklook/pdf";
import { blankPdf } from "./bytes";

/**
 * pdf.js for the PDF app: the library, its viewer components with their stylesheet (scoped to the
 * app, as it styles generic class names like `.sidebar`), and the files it reads on demand
 * (CMaps for Asian text, the standard fonts, the image decoders), bundled rather than fetched.
 *
 * Pages are moved, rotated, inserted and removed by building a new file with pdf.js's
 * `extractPages`; a page's saved rotation, which `extractPages` copies as it was, is set
 * afterwards by an incremental update written here.
 */

export type PdfLib = Awaited<ReturnType<typeof loadPdfjs>>;
export type ViewerLib = typeof import("pdfjs-dist/web/pdf_viewer.mjs");

const ASSETS: Record<string, Record<string, () => Promise<unknown>>> = {
  cMapUrl: import.meta.glob("/node_modules/pdfjs-dist/cmaps/*.bcmap", { query: "?url", import: "default" }),
  standardFontDataUrl: import.meta.glob("/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", { query: "?url", import: "default" }),
  wasmUrl: import.meta.glob("/node_modules/pdfjs-dist/wasm/{jbig2,openjpeg,qcms_bg}.wasm", { query: "?url", import: "default" }),
};

/** Hands pdf.js the bundled CMaps, fonts and decoders by name (it asks instead of fetching). */
class BundledData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const table = ASSETS[kind] ?? {};
    const key = Object.keys(table).find((k) => k.endsWith(`/${filename}`));
    if (!key) throw new Error(`pdf.js asked for ${kind} ${filename}, which isn't bundled`);
    const response = await fetch((await table[key]()) as string);
    if (!response.ok) throw new Error(`Couldn’t load ${filename}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export interface Engine {
  lib: PdfLib;
  viewer: ViewerLib;
}

let loading: Promise<Engine> | null = null;

/**
 * WebKitGTK's ReadableStream can't be read with `for await` yet, and pdf.js reads a page's text
 * that way (search, copying from a page's list): the standard iterator, added when missing.
 */
function readableStreamIteration() {
  type Iterable = ReadableStream & { values?: unknown; [Symbol.asyncIterator]?: unknown };
  const proto = ReadableStream.prototype as Iterable;
  if (typeof proto[Symbol.asyncIterator] === "function") return;
  function values(this: ReadableStream, options?: { preventCancel?: boolean }) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (err) {
          reader.releaseLock();
          throw err;
        }
      },
      async return(value?: unknown) {
        if (!options?.preventCancel) {
          const cancelled = reader.cancel(value);
          reader.releaseLock();
          await cancelled;
        } else reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  Object.defineProperty(proto, "values", { value: values, writable: true, configurable: true });
  Object.defineProperty(proto, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
}

export function loadEngine(): Promise<Engine> {
  loading ??= (async () => {
    readableStreamIteration();
    const lib = await loadPdfjs();
    // The viewer components read the library from globalThis.pdfjsLib, which pdf.mjs sets.
    const [viewer, css] = await Promise.all([import("pdfjs-dist/web/pdf_viewer.mjs"), import("pdfjs-dist/web/pdf_viewer.css?inline")]);
    adoptScoped(css.default, ".pf-editor");
    return { lib, viewer };
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Splits a selector list at its top-level commas (not those inside `:is(…)` or `[…]`). */
function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Adds pdf.js's stylesheet with every rule limited to `scope` (`:root` becomes the scope itself). */
function adoptScoped(css: string, scope: string) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        rule.selectorText = splitSelectors(rule.selectorText)
          .map((s) => (s.startsWith(":root") ? `${scope}${s.slice(5)}` : `${scope} ${s}`))
          .join(", ");
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || (typeof CSSLayerBlockRule !== "undefined" && rule instanceof CSSLayerBlockRule)) {
        walk(rule.cssRules);
      }
    }
  };
  walk(sheet.cssRules);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** Why a document couldn't be opened, in words. */
export function openError(err: unknown): string {
  const name = (err as Error)?.name;
  if (name === "InvalidPDFException") return "It isn’t a PDF file, or it’s damaged.";
  if (name === "PasswordException") return "It needs a password.";
  return (err as Error)?.message ?? String(err);
}

/**
 * Opens a document. `ask` is called when it needs a password (again after a wrong one) and
 * resolves to null when the user gives up; the promise then rejects with an Error named
 * "Cancelled". Resolves with the document and the password that opened it.
 */
export async function openPdf(engine: Engine, bytes: Uint8Array, ask: (wrong: boolean) => Promise<string | null>, password?: string | null): Promise<{ doc: PDFDocumentProxy; password: string | null }> {
  let used = password ?? null;
  // pdf.js takes the buffer over to its worker: it gets a copy, so the caller keeps its bytes.
  const task: PDFDocumentLoadingTask = engine.lib.getDocument({
    data: bytes.slice(),
    password: used ?? undefined,
    BinaryDataFactory: BundledData as never,
    useWorkerFetch: false,
    cMapPacked: true,
    enableXfa: false,
  } as Parameters<PdfLib["getDocument"]>[0]);
  let cancelled = false;
  task.onPassword = (update: (password: string) => void, reason: number) => {
    void ask(reason === engine.lib.PasswordResponses.INCORRECT_PASSWORD).then((answer) => {
      if (answer == null) {
        cancelled = true;
        void task.destroy();
      } else {
        used = answer;
        update(answer);
      }
    });
  };
  try {
    const doc = await task.promise;
    return { doc, password: used };
  } catch (err) {
    if (cancelled) {
      const stop = new Error("Cancelled");
      stop.name = "Cancelled";
      throw stop;
    }
    throw err;
  }
}

// ---- building files

/** A page of the file being built: page `index` (0-based) of `source`, or a picture. */
export type Slot =
  | { source: Source; index: number; rotate: number }
  | { image: Blob };

/** A file pages come from; the same object for every page of the same file. */
export interface Source {
  bytes: Uint8Array;
  password?: string | null;
}

let helper: Promise<PDFDocumentProxy> | null = null;

/**
 * The document `extractPages` is called on. It contributes no pages of its own: every page comes
 * from a source given as bytes, so the edits pending in the open document (which the caller saves
 * into its bytes first) are never added twice.
 */
function helperDoc(engine: Engine): Promise<PDFDocumentProxy> {
  helper ??= engine.lib.getDocument({ data: blankPdf([[612, 792]]) }).promise.catch((err) => {
    helper = null;
    throw err;
  });
  return helper;
}

/**
 * A new PDF of `slots`, in order. Pages keep their content, links, form fields and annotations;
 * bookmarks to pages that stay are kept. A file built from one source keeps its encryption and
 * document properties. Pictures get pages the size most of the other pages have (Letter or A4
 * when there are none: see `paper`), with a margin.
 */
export async function build(engine: Engine, slots: Slot[], paper: "a4" | "letter" = "a4"): Promise<Uint8Array> {
  if (!slots.length) throw new Error("There are no pages to keep.");
  const host = await helperDoc(engine);
  // A page used twice comes from a second copy of its file (pdf.js copies each page of a source once).
  const groups: { source: Source; copy: number; pages: { index: number; at: number }[] }[] = [];
  const infos: Record<string, unknown>[] = [];
  const seen = new Map<Source, Map<number, number>>();
  const onlyPictures = slots.every((s) => "image" in s);
  // Pictures alone: a blank page of the chosen paper sets their size, and is dropped afterwards.
  const pad = onlyPictures ? 1 : 0;
  if (pad) infos.push({ document: blankPdf([paper === "a4" ? [595.28, 841.89] : [612, 792]]), includePages: [0], pageIndices: [0] });
  for (let at = 0; at < slots.length; at++) {
    const slot = slots[at];
    if ("image" in slot) {
      infos.push({ image: await createImageBitmap(slot.image), pageIndices: [at + pad] });
      continue;
    }
    const uses = seen.get(slot.source) ?? new Map<number, number>();
    seen.set(slot.source, uses);
    const copy = uses.get(slot.index) ?? 0;
    uses.set(slot.index, copy + 1);
    let group = groups.find((g) => g.source === slot.source && g.copy === copy);
    if (!group) groups.push((group = { source: slot.source, copy, pages: [] }));
    group.pages.push({ index: slot.index, at: at + pad });
  }
  for (const g of groups) {
    // includePages is read in page order; pageIndices says where each of those pages goes.
    const pages = [...g.pages].sort((a, b) => a.index - b.index);
    infos.push({ document: g.source.bytes, password: g.source.password ?? undefined, includePages: pages.map((p) => p.index), pageIndices: pages.map((p) => p.at) });
  }
  let out = await host.extractPages(infos as never);
  if (!out) throw new Error("pdf.js couldn’t build the file.");
  if (pad) {
    const padded = { bytes: out };
    out = await host.extractPages([{ document: padded.bytes, excludePages: [0] }] as never);
    if (!out) throw new Error("pdf.js couldn’t build the file.");
  }
  return out;
}

/** The paper pictures get by default: Letter where it's the custom, A4 elsewhere. */
export function paper(): "a4" | "letter" {
  const region = (navigator.language.split("-")[1] ?? "").toUpperCase();
  return ["US", "CA", "MX", "PH", "CL", "CO", "VE", "GT", "CR", "PA", "DO", "PR", "SV", "NI", "HN"].includes(region) ? "letter" : "a4";
}
