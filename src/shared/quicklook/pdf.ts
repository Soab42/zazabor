import { h } from "../../ui/dom";
import { readBinary } from "./api";

/** Pages rendered up front; a longer document ends with a quiet "more pages" note. */
const MAX_PAGES = 12;
/** Larger files get the fallback card instead of being loaded whole. */
const MAX_BYTES = 64 * 1024 * 1024;

/** pdf.js, loaded on first use, with its worker set up. */
export async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

/**
 * Renders the first pages of a PDF as canvases with pdf.js (loaded on first use).
 * `isCurrent` lets the caller abandon the work when the user has moved on.
 * Rejects when the file cannot be read as a PDF.
 */
export async function renderPdf(path: string, width: number, isCurrent: () => boolean): Promise<HTMLElement> {
  const pdfjs = await loadPdfjs();
  // OffscreenCanvas off: WebKitGTK draws big page pictures (scans) blank through it.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readBinary(path, MAX_BYTES)), isOffscreenCanvasSupported: false }).promise;
  const pages = h("div", { class: "ql-pdf" });
  const count = Math.min(doc.numPages, MAX_PAGES);
  const scale = Math.max(1, window.devicePixelRatio || 1);
  for (let number = 1; number <= count; number++) {
    if (!isCurrent()) break;
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * scale });
    const canvas = h("canvas", { class: "ql-pdf-page" });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    await page.render({ canvas, viewport }).promise;
    pages.append(canvas);
  }
  if (doc.numPages > count) pages.append(h("div", { class: "ql-pdf-more" }, `${doc.numPages - count} more pages. Open the file to read them all.`));
  return pages;
}
