import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { del, set } from "idb-keyval";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type Tesseract from "tesseract.js";
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import coreUrl from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";

/**
 * Scan & OCR (docs/plans/pdf.md §4.8): tesseract.js, bundled with the app (its worker and its
 * SIMD LSTM core are served from Zazabor, nothing from a CDN), reads each page as a picture and
 * writes a one-page PDF of invisible words, which Rust lays over the page (the `ocrLayer` tool).
 * The language data (Tesseract's fast models for English and Bangla) is downloaded on first use
 * by Rust (src-tauri/src/office/pdf_ocr.rs) and kept in the app's data folder.
 */

export interface OcrLanguage {
  code: "eng" | "ben";
  name: string;
  size: number;
  installed: boolean;
  /** Bytes of an unfinished download. */
  partial: number;
}

export const ocrApi = {
  languages: () => invoke<OcrLanguage[]>("pdf_ocr_languages"),
  /** Downloads a language's data; `progress` gets bytes received and the total. */
  async download(code: string, progress: (received: number, total: number) => void): Promise<void> {
    const stop = await listen<{ code: string; received: number; total: number }>("pdf-ocr-download", (e) => {
      if (e.payload.code === code) progress(e.payload.received, e.payload.total);
    });
    try {
      await invoke("pdf_ocr_download", { code });
    } finally {
      stop();
    }
  },
  cancel: (code: string) => invoke("pdf_ocr_cancel", { code }),
  remove: (code: string) => invoke("pdf_ocr_remove", { code }),
  async data(code: string): Promise<Uint8Array> {
    const r = await invoke<ArrayBuffer | Uint8Array | number[]>("pdf_ocr_data", { code });
    return r instanceof ArrayBuffer ? new Uint8Array(r) : r instanceof Uint8Array ? r : new Uint8Array(r);
  },
};

/** One page read: the text-only PDF to lay over it, and how sure Tesseract was. */
export interface PageRead {
  page: number;
  pdf: Uint8Array;
  words: number;
  confidence: number;
}

/** Pages are read at this resolution (Tesseract's sweet spot for print). */
const DPI = 300;
/** Big pages are read smaller, so a poster doesn't become a gigapixel picture. */
const MAX_PIXELS = 40_000_000;

/** Whether a page already has text (then it isn't read unless asked). */
export async function pageHasText(doc: PDFDocumentProxy, page: number): Promise<boolean> {
  const p = await doc.getPage(page);
  const content = await p.getTextContent();
  return content.items.some((i) => "str" in i && i.str.trim().length > 0);
}

async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The page couldn't be drawn."))), "image/png"));
}

/**
 * Reads `pages` (from 1) of `doc` in `langs`. `progress` is told which page (0-based count done)
 * and how far Tesseract is into it; `signal` cancels (the promise rejects with "Cancelled").
 */
export async function readPages(
  doc: PDFDocumentProxy,
  pages: number[],
  langs: string[],
  progress: (done: number, fraction: number, status: string) => void,
  signal: AbortSignal,
): Promise<PageRead[]> {
  const T = ((await import("tesseract.js/dist/tesseract.esm.min.js")) as { default: typeof Tesseract }).default;
  // tesseract.js reads language data from its cache (IndexedDB) before the network: put the
  // downloaded data there for the worker to start with, then take it out again.
  const keys = langs.map((l) => `./${l}.traineddata`);
  await Promise.all(langs.map(async (l, i) => set(keys[i], await ocrApi.data(l))));
  let worker: Tesseract.Worker | null = null;
  const cancelled = () => Object.assign(new Error("Cancelled"), { name: "Cancelled" });
  let current = 0;
  const onAbort = () => void worker?.terminate();
  signal.addEventListener("abort", onAbort);
  try {
    worker = await T.createWorker(langs.join("+"), T.OEM.LSTM_ONLY, {
      workerPath: workerUrl,
      corePath: coreUrl,
      workerBlobURL: false,
      cacheMethod: "readOnly",
      gzip: false,
      // Never the CDN: a language missing from the cache fails here instead.
      langPath: "about:blank",
      logger: (m) => {
        if (m.status === "recognizing text") progress(current, m.progress, "Reading");
      },
    });
    if (signal.aborted) throw cancelled();
    await worker.setParameters({ user_defined_dpi: String(DPI), tessedit_pageseg_mode: T.PSM.AUTO });
    const out: PageRead[] = [];
    for (const n of pages) {
      if (signal.aborted) throw cancelled();
      progress(current, 0, "Drawing");
      const page = await doc.getPage(n);
      let viewport = page.getViewport({ scale: DPI / 72 });
      const pixels = viewport.width * viewport.height;
      if (pixels > MAX_PIXELS) viewport = page.getViewport({ scale: (DPI / 72) * Math.sqrt(MAX_PIXELS / pixels) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false })!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Comments aren't part of the scan: annotations are left out (mode 0).
      await page.render({ canvas, viewport, annotationMode: 0 } as Parameters<typeof page.render>[0]).promise;
      page.cleanup();
      const picture = await canvasBlob(canvas);
      canvas.width = canvas.height = 0;
      if (signal.aborted) throw cancelled();
      const result = await worker.recognize(picture, { pdfTextOnly: true }, { pdf: true, text: true, blocks: true });
      const pdf = result.data.pdf;
      if (!pdf) throw new Error("Tesseract didn't write the page's text.");
      const words = (result.data.text ?? "").split(/\s+/).filter(Boolean).length;
      out.push({ page: n, pdf: pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf), words, confidence: result.data.confidence ?? 0 });
      current++;
      progress(current, 0, "Reading");
    }
    return out;
  } catch (err) {
    if (signal.aborted) throw cancelled();
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await worker?.terminate().catch(() => undefined);
    await Promise.all(keys.map((k) => del(k).catch(() => undefined)));
  }
}
