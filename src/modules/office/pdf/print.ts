import type { PDFDocumentProxy } from "pdfjs-dist";
import { h } from "../../../ui/dom";
import type { PdfLib } from "./engine";

/** Pages print as pictures this sharp (dots per inch). */
const DPI = 150;

let printing = false;

/**
 * Prints the document through the system's print dialog (which can also save a PDF): each page
 * drawn as a picture with its form values and new comments, one page per sheet, scaled to the
 * paper chosen there.
 */
export async function printPdf(lib: PdfLib, doc: PDFDocumentProxy, toast: (text: string) => void, isCurrent: () => boolean) {
  if (printing) return;
  printing = true;
  const urls: string[] = [];
  const area = h("div", { id: "pf-print-root" });
  try {
    if (doc.numPages > 3) toast(`Preparing ${doc.numPages} pages to print…`);
    const storage = doc.annotationStorage.print;
    for (let n = 1; n <= doc.numPages; n++) {
      if (!isCurrent()) return;
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: DPI / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport, intent: "print", annotationMode: lib.AnnotationMode.ENABLE_STORAGE, printAnnotationStorage: storage }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error(`Couldn’t draw page ${n}`);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const landscape = viewport.width > viewport.height;
      area.append(h("img", { class: `pf-print-page${landscape ? " landscape" : ""}`, src: url, alt: "" }));
      page.cleanup();
    }
    await Promise.all(Array.from(area.querySelectorAll("img"), (img) => img.decode().catch(() => undefined)));
    const sheet = h("style", null, "@page { margin: 0; }");
    document.body.append(sheet, area);
    document.body.classList.add("pf-printing");
    await new Promise<void>((resolve) => {
      const done = () => {
        sheet.remove();
        document.body.classList.remove("pf-printing");
        resolve();
      };
      window.addEventListener("afterprint", done, { once: true });
      setTimeout(() => {
        window.print();
        // WebKit may not send afterprint; the print dialog is modal, so this runs after it.
        setTimeout(done, 1000);
      }, 50);
    });
  } catch (err) {
    toast(`Couldn’t print: ${(err as Error)?.message ?? err}`);
  } finally {
    area.remove();
    for (const url of urls) URL.revokeObjectURL(url);
    printing = false;
  }
}
