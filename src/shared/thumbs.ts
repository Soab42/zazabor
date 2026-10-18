import { thumbUrl } from "../api";

/**
 * Thumbnail sizes the backend renders; picking from a few keeps the disk cache small.
 * The smallest that is at least as large as the display is used, so none is upscaled.
 */
export function thumbBucket(displayPx: number) {
  const px = displayPx * (window.devicePixelRatio || 1);
  return px <= 256 ? 256 : 512;
}

const RETRY_MS = 5000;

/** A thumbnail URL for any image file, sized for `displayPx` CSS pixels. */
export const photoThumbUrl = (photo: { path: string; mtime: number }, displayPx: number) =>
  thumbUrl(photo.path, photo.mtime, thumbBucket(displayPx));

/** A thumbnail drawn on demand (a document's first page): `key` names it, `make` gives its URL. */
export interface LazyThumb {
  key: string;
  make(): Promise<string>;
}

/** What a thumbnail is loaded from: a URL, or a page drawn on demand. */
export type ThumbSource = string | LazyThumb;

const keyOf = (source: ThumbSource) => (typeof source === "string" ? source : source.key);

/** The URL to show for a thumbnail source. */
export const resolveThumb = (source: ThumbSource) => (typeof source === "string" ? Promise.resolve(source) : source.make());

/**
 * Loads thumbnails with bounded concurrency, newest requests first in line after the
 * ones already visible. Elements that leave the screen are cancelled before they start.
 */
export class ThumbLoader {
  private queue: HTMLImageElement[] = [];
  private wanted = new Map<HTMLImageElement, ThumbSource>();
  private active = 0;
  private ready = new Set<string>();
  /** When a source last failed (e.g. while the app was locked); retried after a pause. */
  private failedAt = new Map<string, number>();
  /** Sources already retried once without being asked again. */
  private retried = new Set<string>();

  constructor(private readonly concurrency = 10) {}

  load(img: HTMLImageElement, source: ThumbSource) {
    const key = keyOf(source);
    if (img.dataset.src === key) {
      const failed = this.failedAt.get(key);
      if (failed === undefined || performance.now() - failed < RETRY_MS || this.wanted.has(img)) return;
      img.classList.remove("failed");
      delete img.dataset.src;
    }
    img.dataset.src = key;
    this.cancel(img);
    if (this.ready.has(key)) {
      this.show(img, key);
      return;
    }
    this.wanted.set(img, source);
    this.queue.push(img);
    this.pump();
  }

  cancel(img: HTMLImageElement) {
    if (this.wanted.delete(img)) {
      const i = this.queue.indexOf(img);
      if (i >= 0) this.queue.splice(i, 1);
    }
  }

  private show(img: HTMLImageElement, url: string) {
    img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
    img.src = url;
    if (img.complete && img.naturalWidth) img.classList.add("loaded");
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const img = this.queue.shift()!;
      const source = this.wanted.get(img);
      this.wanted.delete(img);
      if (!source) continue;
      const key = keyOf(source);
      this.active++;
      const finish = (url: string | null) => {
        this.active--;
        if (url) {
          this.failedAt.delete(key);
          // A drawn page's URL is the drawer's to keep (it may be let go), so it is asked again.
          if (typeof source === "string") this.ready.add(key);
          if (img.dataset.src === key) this.show(img, url);
        } else {
          this.failedAt.set(key, performance.now());
          if (img.dataset.src === key) {
            img.classList.add("failed");
            // A first failure can pass (the video decoder still starting up), so a thumbnail
            // still on screen tries once more.
            if (!this.retried.has(key)) {
              this.retried.add(key);
              window.setTimeout(() => img.isConnected && img.dataset.src === key && this.load(img, source), RETRY_MS + 50);
            }
          }
        }
        this.pump();
      };
      resolveThumb(source).then((url) => {
        // Load through a detached element so a re-pointed <img> can never strand a slot.
        const probe = new Image();
        probe.onload = () => finish(url);
        probe.onerror = () => finish(null);
        probe.src = url;
      }, () => finish(null));
    }
  }
}
