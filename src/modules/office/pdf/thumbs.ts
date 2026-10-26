import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * Small pictures of a document's pages, for the Pages panel and Organize Pages: drawn a few at a
 * time as they scroll into view, kept as compressed images (not canvases) so long documents
 * stay light, and dropped with the document.
 */
export class Thumbs {
  private cache = new Map<string, Promise<string>>();
  private urls: string[] = [];
  private queue: (() => Promise<void>)[] = [];
  private running = 0;
  private disposed = false;

  constructor(private readonly doc: PDFDocumentProxy) {}

  /** A picture of page `index` (0-based), `width` CSS pixels wide, turned `extra` degrees more. */
  url(index: number, width: number, extra = 0): Promise<string> {
    const key = `${index}:${width}:${extra}`;
    let made = this.cache.get(key);
    if (!made) {
      made = new Promise<string>((resolve, reject) => {
        this.queue.push(() => this.draw(index, width, extra).then(resolve, reject));
        this.pump();
      });
      this.cache.set(key, made);
    }
    return made;
  }

  private pump() {
    while (this.running < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async draw(index: number, width: number, extra: number): Promise<string> {
    if (this.disposed) throw new Error("Closed");
    const page = await this.doc.getPage(index + 1);
    const rotation = (page.rotate + extra) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (width / base.width) * ratio, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("Couldn’t draw the page");
    const url = URL.createObjectURL(blob);
    if (this.disposed) {
      URL.revokeObjectURL(url);
      throw new Error("Closed");
    }
    this.urls.push(url);
    return url;
  }

  /** The size a page shows at with `extra` degrees more, in points (for placeholders). */
  async size(index: number, extra = 0): Promise<{ width: number; height: number }> {
    const page = await this.doc.getPage(index + 1);
    const v = page.getViewport({ scale: 1, rotation: (page.rotate + extra) % 360 });
    return { width: v.width, height: v.height };
  }

  dispose() {
    this.disposed = true;
    this.queue.length = 0;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.cache.clear();
  }
}

/**
 * Fills `img` with its page's picture once it scrolls into view (`root` is the scrolling list).
 * Returns the observer; disconnect it with the list.
 */
export function lazyThumbs(root: HTMLElement, thumbs: () => Thumbs | null): IntersectionObserver {
  return new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      observer.unobserve(img);
      const t = thumbs();
      if (!t) continue;
      const index = Number(img.dataset.page);
      const width = Number(img.dataset.width);
      const extra = Number(img.dataset.extra ?? 0);
      t.url(index, width, extra).then((url) => {
        if (img.isConnected) img.src = url;
      }, () => undefined);
    }
  }, { root, rootMargin: "300px 0px" });
}
