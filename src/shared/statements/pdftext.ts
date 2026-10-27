import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadEngine, openPdf } from "../../modules/office/pdf/engine";
import { passwordDialog } from "../../modules/office/pdf/dialogs";
import { readBinary } from "../quicklook/api";
import type { TextItem } from "./api";

/** PDFs larger than this aren't read here. */
const MAX_BYTES = 40 * 1024 * 1024;
/** Pages read at most (a long statement is a few dozen). */
const MAX_PAGES = 300;

/**
 * The positioned text of every page, top-left origin and baselines in PDF points, as the
 * statement reader in Rust takes it. A scan gives (almost) nothing.
 */
export async function textOf(doc: PDFDocumentProxy): Promise<TextItem[]> {
  const items: TextItem[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform as number[];
      const [x, y] = viewport.convertToViewportPoint(e, f);
      const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
      // pdf.js gives the width in page units already.
      items.push({ page: n, x, y, w: Math.abs(it.width), h: Math.abs(size), s: it.str });
    }
    page.cleanup();
  }
  return items;
}

/** Opens a PDF file (asking for its password when it has one) and reads its text. */
export async function pdfText(path: string): Promise<TextItem[]> {
  const engine = await loadEngine();
  const bytes = new Uint8Array(await readBinary(path, MAX_BYTES));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { doc } = await openPdf(engine, bytes, (wrong) => passwordDialog(name, wrong));
  try {
    return await textOf(doc);
  } finally {
    // pdf.js 6 frees a document through the task that loaded it.
    void doc.loadingTask.destroy();
  }
}
