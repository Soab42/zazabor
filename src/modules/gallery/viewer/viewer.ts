import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api, displayRenderSize, fullUrl, loadImage, previewUrl, thumbUrl,
} from "../../../api";
import { saveConfig, type Config } from "../../../config";
import type { Photo } from "../library/model";
import type { ThumbLoader } from "../../../shared/thumbs";
import type { SlideshowScope } from "../slideshow/setup";
import { clamp, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { Filmstrip } from "./filmstrip";
import { computeHistogram } from "./histogram";
import { InfoPanel } from "./info";
import { swapsAxes } from "./orient";
import type { Curve } from "./easing";
import { TiledImage } from "./tiles";
import { ZoomView, type ZoomLayer } from "./zoom";

export interface ViewerHandlers {
  close(photo: Photo | null): void;
  slideshow(scopes: SlideshowScope[]): void;
}

const CACHE_LIMIT = 4;
const ZOOM_STEP = 1.6;
/** Holding a zoom key glides: each auto-repeat adds this much on top of the first step. */
const ZOOM_REPEAT_STEP = 1.08;
const MINIMAP_W = 120;
const MINIMAP_H = 62;

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let value = cache.get(key);
  if (value === undefined) {
    value = make();
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  } else {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

export class Viewer {
  readonly el = h("div", { class: "viewer", hidden: true });
  private stage = h("div", { class: "v-stage" });
  private zoom: ZoomView;
  private name = h("div", { class: "v-name" });
  private sub = h("div", { class: "v-sub" });
  private backButton = h("button", { class: "btn ghost", title: "Back to library (Esc)", onclick: () => void this.close() }, icon("back", 17), "Library");
  private zoomLabel = h("button", { class: "zoom-label", title: "Toggle fit / actual size (double-click the photo)" });
  private zoomSlider = h("input", { type: "range", class: "zoom-slider", min: 0, max: 1000, step: 1, title: "Zoom" });
  private readout = h("div", { class: "v-readout", hidden: true });
  private minimap = h("canvas", { class: "v-minimap", hidden: true });
  private loading = h("div", { class: "v-loading", hidden: true }, h("span", { class: "spinner" }), "Loading full resolution…");
  private prevButton = h("button", { class: "v-nav", title: "Previous (←)" }, icon("chevronLeft", 22));
  private nextButton = h("button", { class: "v-nav", title: "Next (→)" }, icon("chevronRight", 22));
  /** Status, previous/next, the filmstrip and the navigator, kept below the photo rather than on it. */
  private bottom = h("footer", { class: "v-bottom" });
  private infoButton: HTMLButtonElement;
  private info = new InfoPanel();
  private film: Filmstrip;
  private photos: Photo[] = [];
  private index = 0;
  private token = 0;
  private previewCache = new Map<string, Promise<HTMLImageElement>>();
  private navigatorImage: HTMLImageElement | null = null;
  private immersive = false;
  private idleTimer = 0;
  private sliderActive = false;

  constructor(private readonly config: Config, thumbs: ThumbLoader, private readonly handlers: ViewerHandlers) {
    this.zoom = new ZoomView(this.stage);
    this.zoom.onChange = () => this.onZoomChange();
    this.zoom.onReadout = (r) => {
      this.readout.hidden = !r;
      if (!r) return;
      this.readout.replaceChildren(h("span", null, `${r.x}, ${r.y}`));
      if (r.color) this.readout.append(h("span", { class: "swatch", style: { background: r.color } }), h("span", null, r.color));
    };
    this.film = new Filmstrip(thumbs, (i) => this.show(i));

    this.prevButton.addEventListener("click", () => this.step(-1));
    this.nextButton.addEventListener("click", () => this.step(1));
    this.bottom.append(
      h("div", { class: "v-side" }, this.loading, this.readout),
      this.prevButton,
      this.film.el,
      this.nextButton,
      h("div", { class: "v-side end" }, this.minimap),
    );
    this.setupMinimap();

    this.zoomSlider.addEventListener("pointerdown", () => (this.sliderActive = true));
    this.zoomSlider.addEventListener("pointerup", () => (this.sliderActive = false));
    this.zoomSlider.addEventListener("input", () => {
      const t = Number(this.zoomSlider.value) / 1000;
      const lo = Math.log(this.zoom.minScale);
      const hi = Math.log(this.zoom.maxScale);
      this.zoom.zoomTo(Math.exp(lo + (hi - lo) * t), undefined, undefined, true);
    });
    this.zoomLabel.addEventListener("click", () => this.toggleActualSize());

    this.infoButton = h("button", { class: "icon-btn", title: "Info & histogram (I)", onclick: () => this.toggleInfo() }, icon("info"));
    const top = h(
      "header",
      { class: "v-top" },
      this.backButton,
      h("div", { class: "v-title" }, this.name, this.sub),
      h(
        "div",
        { class: "v-zoom" },
        h("button", { class: "icon-btn", title: "Zoom out (− or ↓)", onclick: () => this.zoom.zoomBy(1 / ZOOM_STEP) }, icon("zoomOut")),
        this.zoomSlider,
        h("button", { class: "icon-btn", title: "Zoom in (+ or ↑)", onclick: () => this.zoom.zoomBy(ZOOM_STEP) }, icon("zoomIn")),
        this.zoomLabel,
        h("button", { class: "icon-btn", title: "Fit to window (0)", onclick: () => this.zoom.home() }, icon("fit")),
        h("button", { class: "text-btn", title: "Actual pixels (1)", onclick: () => this.zoom.zoomTo(this.actualScale) }, "1:1"),
      ),
      h(
        "div",
        { class: "v-actions" },
        h("button", { class: "icon-btn", title: "Rotate left (Shift+R)", onclick: () => this.zoom.rotate(-1) }, icon("rotateLeft")),
        h("button", { class: "icon-btn", title: "Rotate right (R)", onclick: () => this.zoom.rotate(1) }, icon("rotateRight")),
        this.infoButton,
        h("button", { class: "icon-btn", title: "Fullscreen (F)", onclick: () => this.toggleFullscreen() }, icon("fullscreen")),
        h("button", { class: "btn primary", title: "Slideshow from this photo (S)", onclick: () => this.playSlideshow() }, icon("play", 15), "Slideshow"),
      ),
    );

    this.el.append(top, h("div", { class: "v-body" }, this.stage, this.info.el), this.bottom);
    this.info.el.hidden = !config.showInfo;
    this.infoButton.classList.toggle("active", config.showInfo);
    this.bottom.hidden = !config.showFilmstrip;

    this.el.addEventListener("pointermove", () => this.wake());
  }

  get isOpen() {
    return !this.el.hidden;
  }

  setZoomCurve(curve: Curve) {
    this.zoom.setStepCurve(curve);
  }

  /** Matches the photo's backdrop to the theme's --stage colour. */
  themeChanged() {
    this.zoom.setBackground(getComputedStyle(this.el).getPropertyValue("--stage"));
  }

  get currentPhoto(): Photo | null {
    return this.photos[this.index] ?? null;
  }

  private get actualScale() {
    return this.zoom.actualScale;
  }

  open(photos: Photo[], index: number) {
    this.photos = photos;
    this.el.hidden = false;
    this.film.setPhotos(photos);
    this.show(index);
    this.wake();
  }

  /** Re-shows the current photo at the given index, e.g. after a slideshow ends there. */
  goTo(photo: Photo) {
    const i = this.photos.findIndex((p) => p.path === photo.path);
    if (i >= 0) this.show(i);
  }

  /**
   * The window shows only this viewer (a picture opened in its own window): the back button
   * closes the window instead of going to the library.
   */
  setStandalone() {
    this.backButton.replaceChildren(icon("close", 16), "Close");
    this.backButton.title = "Close (Esc)";
  }

  async close() {
    if (this.immersive) await this.setFullscreen(false);
    this.token++;
    this.el.hidden = true;
    this.zoom.clear();
    this.handlers.close(this.currentPhoto);
  }

  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "Escape":
        if (this.immersive) this.setFullscreen(false);
        else this.close();
        return true;
      case "ArrowLeft": case "PageUp": case "Backspace":
        this.step(-1);
        return true;
      case "ArrowRight": case "PageDown": case " ":
        this.step(1);
        return true;
      case "Home":
        this.show(0);
        return true;
      case "End":
        this.show(this.photos.length - 1);
        return true;
      case "+": case "=": case "ArrowUp":
        this.zoom.zoomBy(e.repeat ? ZOOM_REPEAT_STEP : ZOOM_STEP);
        return true;
      case "-": case "_": case "ArrowDown":
        this.zoom.zoomBy(1 / (e.repeat ? ZOOM_REPEAT_STEP : ZOOM_STEP));
        return true;
      case "0":
        this.zoom.home();
        return true;
      case "1": case "2": case "3": case "4": case "5": case "6": case "7": case "8":
        // 1 → 100%, 2 → 200%, 3 → 400% … 8 → 12800%
        if (mod && e.key !== "1") return false;
        this.zoom.zoomTo(this.actualScale * 2 ** (Number(e.key) - 1));
        return true;
      case "r": case "R":
        if (mod) return false;
        this.zoom.rotate(e.shiftKey ? -1 : 1);
        return true;
      case "i": case "I":
        this.toggleInfo();
        return true;
      case "f": case "F": case "F11":
        this.toggleFullscreen();
        return true;
      case "s": case "S": case "F5":
        this.playSlideshow();
        return true;
      case "h": case "H":
        this.config.showFilmstrip = !this.config.showFilmstrip;
        this.bottom.hidden = !this.config.showFilmstrip;
        if (!this.bottom.hidden) this.film.setCurrent(this.index);
        saveConfig(this.config);
        return true;
      default:
        return false;
    }
  }

  /** Previous (-1) or next (+1) photo, e.g. from the mouse's side buttons. */
  stepBy(delta: number) {
    this.step(delta);
  }

  private step(delta: number) {
    const next = clamp(this.index + delta, 0, this.photos.length - 1);
    if (next !== this.index) this.show(next);
  }

  private playSlideshow() {
    const photo = this.currentPhoto;
    if (!photo) return;
    this.handlers.slideshow([{ label: `Album “${photo.folder.label}”`, title: photo.folder.label, photos: this.photos, start: this.index }]);
  }

  private toggleInfo() {
    this.config.showInfo = !this.config.showInfo;
    this.info.el.hidden = !this.config.showInfo;
    this.infoButton.classList.toggle("active", this.config.showInfo);
    this.info.redraw();
    saveConfig(this.config);
  }

  private toggleActualSize() {
    if (Math.abs(this.zoom.zoom - this.actualScale) < 1e-3) this.zoom.home();
    else this.zoom.zoomTo(this.actualScale);
  }

  private async toggleFullscreen() {
    await this.setFullscreen(!this.immersive);
  }

  private async setFullscreen(on: boolean) {
    try {
      await getCurrentWindow().setFullscreen(on);
    } catch (err) {
      console.warn("Fullscreen failed:", err);
      return;
    }
    this.immersive = on;
    this.el.classList.toggle("immersive", on);
    this.wake();
  }

  /** In fullscreen, chrome fades out after a moment without mouse movement. */
  private wake() {
    this.el.classList.remove("idle");
    clearTimeout(this.idleTimer);
    if (!this.immersive) return;
    this.idleTimer = window.setTimeout(() => {
      if (!this.el.querySelector(".v-top:hover, .v-bottom:hover")) this.el.classList.add("idle");
    }, 2200);
  }

  // ---- loading --------------------------------------------------------------------------

  private async show(index: number) {
    const photo = this.photos[index];
    if (!photo) return;
    this.index = index;
    const token = ++this.token;
    const current = () => token === this.token;
    this.name.textContent = photo.name;
    this.sub.textContent = `${index + 1} of ${this.photos.length}   ·   ${photo.folder.label}`;
    this.prevButton.disabled = index === 0;
    this.nextButton.disabled = index === this.photos.length - 1;
    if (!this.bottom.hidden) this.film.setCurrent(index);
    this.loading.hidden = true;

    const preview = this.loadPreview(photo);
    const [info, quick] = await Promise.all([
      api.photoInfo(photo.path).catch((err) => {
        console.warn(`No info for ${photo.path}:`, err);
        return null;
      }),
      // A cached preview arrives almost at once; show it directly instead of a blurry thumbnail.
      Promise.race([preview.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 120))]),
    ]);
    if (!current()) return;
    const first = quick ?? (await loadImage(thumbUrl(photo.path, photo.mtime, 512)).catch(() => null));
    if (!current()) return;

    let width = info?.width ?? 0;
    let height = info?.height ?? 0;
    if (swapsAxes(info?.orientation ?? 1)) [width, height] = [height, width];
    const sizeKnown = width > 0 && height > 0;
    if (!sizeKnown) {
      width = first?.naturalWidth || 1;
      height = first?.naturalHeight || 1;
    }

    this.zoom.setImage(width, height);
    this.navigatorImage = first;
    if (first) {
      this.zoom.addLayer(this.scaledLayer(first, width, height));
      this.info.setHistogram(computeHistogram(first, first.naturalWidth, first.naturalHeight));
    } else {
      this.info.setHistogram(null);
    }
    this.info.update(photo, info, sizeKnown ? width : 0, sizeKnown ? height : 0);

    const sharp = preview.then((img) => {
      if (!current() || img === first) return;
      const layer = this.scaledLayer(img, width, height);
      if (layer.density < 0.999) this.zoom.addLayer(layer);
      this.info.setHistogram(computeHistogram(img, img.naturalWidth, img.naturalHeight));
    }, () => {});

    // The backend decodes the full-resolution photo once; zooming in then streams tiles of it.
    const loadingTimer = window.setTimeout(() => {
      if (current()) this.loading.hidden = false;
    }, 350);
    fetch(fullUrl(photo.path, photo.mtime))
      .then((response) => (response.ok ? (response.json() as Promise<{ width: number; height: number }>) : Promise.reject(new Error(String(response.status)))))
      .then((full) => {
        if (!current()) return;
        const tiles = new TiledImage(photo.path, photo.mtime, full.width, full.height);
        this.zoom.addLayer({
          tiles,
          width: full.width,
          height: full.height,
          toUpright: new DOMMatrix([width / full.width, 0, 0, height / full.height, 0, 0]),
          density: 1,
        });
      })
      .catch((err) => {
        if (current()) console.error(`Could not open ${photo.path} at full resolution:`, err);
      })
      .finally(() => {
        clearTimeout(loadingTimer);
        if (current()) {
          this.loading.hidden = true;
          sharp.then(() => current() && this.preloadNeighbors());
        }
      });
  }

  /** A downscaled, already-upright rendition (thumbnail or preview). */
  private scaledLayer(img: HTMLImageElement, width: number, height: number): ZoomLayer {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    return { image: img, width: w, height: h, toUpright: new DOMMatrix([width / w, 0, 0, height / h, 0, 0]), density: w / width };
  }

  private loadPreview(photo: Photo) {
    const url = previewUrl(photo.path, photo.mtime, displayRenderSize());
    const promise = remember(this.previewCache, url, () => loadImage(url));
    promise.catch(() => this.previewCache.delete(url));
    return promise;
  }

  private preloadNeighbors() {
    const next = this.photos[this.index + 1];
    const prev = this.photos[this.index - 1];
    for (const photo of [next, prev]) {
      if (!photo) continue;
      loadImage(thumbUrl(photo.path, photo.mtime, 512)).catch(() => {});
      this.loadPreview(photo).catch(() => {});
    }
  }

  // ---- zoom chrome -----------------------------------------------------------------------

  private onZoomChange() {
    const scale = this.zoom.zoom;
    const percent = scale * (window.devicePixelRatio || 1) * 100;
    this.zoomLabel.textContent = this.zoom.isHome ? `Fit · ${formatPercent(percent)}` : formatPercent(percent);
    if (!this.sliderActive) {
      const lo = Math.log(this.zoom.minScale);
      const hi = Math.log(this.zoom.maxScale);
      this.zoomSlider.value = String(hi > lo ? Math.round(((Math.log(scale) - lo) / (hi - lo)) * 1000) : 0);
    }
    if (this.zoom.needsOriginal && !this.zoom.showingOriginal) {
      // The loading chip only matters when the user has zoomed past the preview.
      this.loading.classList.add("wanted");
    } else {
      this.loading.classList.remove("wanted");
    }
    this.drawMinimap();
  }

  private setupMinimap() {
    const seek = (e: PointerEvent) => {
      const rect = this.minimap.getBoundingClientRect();
      this.zoom.centerOn(clamp((e.clientX - rect.left) / rect.width, 0, 1), clamp((e.clientY - rect.top) / rect.height, 0, 1));
    };
    this.minimap.addEventListener("pointerdown", (e) => {
      this.minimap.setPointerCapture(e.pointerId);
      seek(e);
    });
    this.minimap.addEventListener("pointermove", (e) => {
      if (this.minimap.hasPointerCapture(e.pointerId)) seek(e);
    });
  }

  private drawMinimap() {
    const vp = this.zoom.viewport;
    const img = this.navigatorImage;
    this.minimap.hidden = !vp.overflow || !img;
    if (this.minimap.hidden || !img) return;
    const quarter = vp.rotation % 2 === 1;
    const aspect = quarter ? img.naturalHeight / img.naturalWidth : img.naturalWidth / img.naturalHeight;
    // Sized to sit inside the bottom bar.
    const cssW = Math.round(Math.min(MINIMAP_W, MINIMAP_H * aspect));
    const cssH = Math.round(Math.min(MINIMAP_H, MINIMAP_W / aspect));
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(cssW * dpr);
    const H = Math.round(cssH * dpr);
    if (this.minimap.width !== W || this.minimap.height !== H) {
      this.minimap.width = W;
      this.minimap.height = H;
      this.minimap.style.width = `${cssW}px`;
      this.minimap.style.height = `${cssH}px`;
    }
    const ctx = this.minimap.getContext("2d")!;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((vp.rotation * Math.PI) / 2);
    const [dw, dh] = quarter ? [H, W] : [W, H];
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    // Dim everything outside the visible region.
    const x = vp.x * W, y = vp.y * H, w = vp.w * W, h = vp.h * H;
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(x, y, w, h);
    ctx.fill("evenodd");
    ctx.strokeStyle = getComputedStyle(this.el).getPropertyValue("--accent-hover").trim() || "#f0b34a";
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect(x + 0.75 * dpr, y + 0.75 * dpr, Math.max(1, w - 1.5 * dpr), Math.max(1, h - 1.5 * dpr));
  }
}

function formatPercent(p: number) {
  if (p >= 1000) return `${Math.round(p).toLocaleString()}%`;
  if (p >= 100) return `${Math.round(p)}%`;
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}
