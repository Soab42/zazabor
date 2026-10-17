import { thumbUrl } from "../api";
import type { Photo } from "./model";

/** Thumbnail sizes the backend renders; picking from a few keeps the disk cache small. */
export function thumbBucket(displayPx: number) {
  const px = displayPx * (window.devicePixelRatio || 1);
  return px <= 200 ? 256 : 512;
}

const RETRY_MS = 5000;

export const photoThumbUrl = (photo: Photo, displayPx: number) =>
  thumbUrl(photo.path, photo.mtime, thumbBucket(displayPx));

/**
 * Loads thumbnails with bounded concurrency, newest requests first in line after the
 * ones already visible. Elements that leave the screen are cancelled before they start.
 */
export class ThumbLoader {
  private queue: HTMLImageElement[] = [];
  private wanted = new Map<HTMLImageElement, string>();
  private active = 0;
  private ready = new Set<string>();
  /** When a URL last failed (e.g. while the app was locked); retried after a pause. */
  private failedAt = new Map<string, number>();

  constructor(private readonly concurrency = 10) {}

  load(img: HTMLImageElement, url: string) {
    if (img.dataset.src === url) {
      const failed = this.failedAt.get(url);
      if (failed === undefined || performance.now() - failed < RETRY_MS || this.wanted.has(img)) return;
      img.classList.remove("failed");
      delete img.dataset.src;
    }
    img.dataset.src = url;
    this.cancel(img);
    if (this.ready.has(url)) {
      this.show(img, url);
      return;
    }
    this.wanted.set(img, url);
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
      const url = this.wanted.get(img);
      this.wanted.delete(img);
      if (!url) continue;
      this.active++;
      // Load through a detached element so a re-pointed <img> can never strand a slot.
      const probe = new Image();
      const finish = (ok: boolean) => {
        this.active--;
        if (ok) {
          this.failedAt.delete(url);
          this.ready.add(url);
          if (img.dataset.src === url) this.show(img, url);
        } else {
          this.failedAt.set(url, performance.now());
          if (img.dataset.src === url) img.classList.add("failed");
        }
        this.pump();
      };
      probe.onload = () => finish(true);
      probe.onerror = () => finish(false);
      probe.src = url;
    }
  }
}
