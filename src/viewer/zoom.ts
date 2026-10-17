import { clamp } from "../ui/dom";
import { Canvas2DDrawer, GLDrawer, GRID_ABOVE, type DrawItem, type ZoomDrawer } from "./drawers";
import { easeMove, easeWheel } from "./easing";

export interface ZoomLayer {
  image: CanvasImageSource;
  /** Pixel size in drawImage's coordinate space. */
  width: number;
  height: number;
  /** Maps source pixel coordinates to upright image coordinates. */
  toUpright: DOMMatrix;
  /** Source pixels per upright pixel: 1 for the original, less for previews. */
  density: number;
}

export interface Readout {
  x: number;
  y: number;
  color: string | null;
}

/** 12800%: far past where individual pixels become large squares. */
export const MAX_SCALE = 128;
/** Device pixels per image pixel above which pixels are drawn as crisp squares. */
const CRISP_ABOVE = 2.5;
const WHEEL_MS = 240;
const MOVE_MS = 320;
const CROSSFADE_MS = 170;

type TweenPath =
  /** Keep the image point (ix, iy) under the screen point (ax, ay). */
  | { kind: "anchor"; ax: number; ay: number; ix: number; iy: number }
  /** Glide the view center from one image point to another. */
  | { kind: "center"; fromX: number; fromY: number; toX: number; toY: number };

/** Scale is interpolated in log space so every step of a zoom feels equally fast. */
type Tween = TweenPath & { start: number; duration: number; ease: (t: number) => number; fromLog: number; toLog: number };

interface Outgoing {
  items: DrawItem[];
  start: number;
}

/**
 * GPU-accelerated pan/zoom view. Zoom changes are cubic-bezier tweens anchored under the
 * cursor; each wheel notch retargets the running tween so fast scrolling travels further.
 *
 * Coordinate spaces: source pixels → (toUpright) upright image → (user rotation) view →
 * (scale, translate) CSS pixels → (devicePixelRatio) canvas pixels.
 */
export class ZoomView {
  canvas = document.createElement("canvas");
  private drawer: ZoomDrawer;
  private layers: ZoomLayer[] = [];
  private uprightW = 0;
  private uprightH = 0;
  private rotation = 0;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private fitMode = true;
  private vw = 0;
  private vh = 0;
  private dpr = 1;
  private tween: Tween | null = null;
  private velocity: { x: number; y: number } | null = null;
  private drag: { id: number; x: number; y: number; t: number; vx: number; vy: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private outgoing: Outgoing | null = null;
  private frame = 0;
  private lastTime = 0;
  private dirty = false;
  private probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;

  /** Called after any change to zoom, position or layers. */
  onChange: () => void = () => {};
  onReadout: (readout: Readout | null) => void = () => {};

  constructor(private readonly container: HTMLElement) {
    this.canvas.className = "zoom-canvas";
    this.probe.canvas.width = this.probe.canvas.height = 1;
    container.append(this.canvas);
    try {
      this.drawer = new GLDrawer(this.canvas);
    } catch (err) {
      console.warn("Viewer falling back to Canvas2D:", err);
      const replacement = document.createElement("canvas");
      replacement.className = "zoom-canvas";
      this.canvas.replaceWith(replacement);
      this.canvas = replacement;
      this.drawer = new Canvas2DDrawer(replacement);
    }
    new ResizeObserver(() => this.resize()).observe(container);
    const c = this.canvas;
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    c.addEventListener("pointermove", (e) => this.onPointerMove(e));
    c.addEventListener("pointerup", (e) => this.onPointerUp(e));
    c.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    c.addEventListener("pointerleave", () => {
      this.pointer = null;
      this.onReadout(null);
    });
    c.addEventListener("dblclick", (e) => this.toggleZoom(e.offsetX, e.offsetY));
    this.resize();
  }

  // ---- public API -------------------------------------------------------------------

  /** Starts a new image of the given upright size; the previous one crossfades away. */
  setImage(width: number, height: number) {
    this.beginCrossfade();
    this.layers = [];
    this.uprightW = Math.max(1, width);
    this.uprightH = Math.max(1, height);
    this.rotation = 0;
    this.velocity = null;
    this.tween = null;
    this.snapHome();
  }

  /** Adds a rendition of the current image; the best one for the zoom level is drawn. */
  addLayer(layer: ZoomLayer) {
    for (const old of this.layers.filter((l) => l.density === layer.density)) this.retire(old);
    this.layers = [...this.layers.filter((l) => l.density !== layer.density), layer].sort((a, b) => a.density - b.density);
    // Upload big layers between frames, before a zoom needs them.
    if (layer.density >= 0.999) setTimeout(() => this.layers.includes(layer) && this.drawer.prepare(layer.image), 30);
    this.invalidate();
  }

  clear() {
    for (const layer of this.layers) this.retire(layer);
    this.finishCrossfade();
    this.layers = [];
    this.uprightW = this.uprightH = 0;
    this.invalidate();
  }

  get hasImage() {
    return this.layers.length > 0;
  }

  get zoom() {
    return this.scale;
  }

  /** One image pixel per device pixel. */
  get actualScale() {
    return 1 / this.dpr;
  }

  /** Fit to the window, but never enlarge small images past actual size. */
  get homeScale() {
    const { w, h } = this.viewSize();
    if (!w || !this.vw) return this.actualScale;
    return Math.min(this.actualScale, this.vw / w, this.vh / h);
  }

  get minScale() {
    return this.homeScale;
  }

  get maxScale() {
    return MAX_SCALE;
  }

  get isHome() {
    return this.fitMode;
  }

  /** Whether the full-resolution layer is what is currently being drawn. */
  get showingOriginal() {
    return this.pickLayer()?.density === 1;
  }

  get needsOriginal() {
    const best = this.layers[this.layers.length - 1];
    return !!best && best.density < 1 && this.scale * this.dpr > best.density * 1.02;
  }

  /** The visible region in normalized view coordinates, for the navigator. */
  get viewport() {
    const { w, h } = this.viewSize();
    const cw = w * this.scale;
    const ch = h * this.scale;
    return {
      x: clamp(-this.tx / cw, 0, 1),
      y: clamp(-this.ty / ch, 0, 1),
      w: clamp(this.vw / cw, 0, 1),
      h: clamp(this.vh / ch, 0, 1),
      rotation: this.rotation,
      overflow: cw > this.vw + 1 || ch > this.vh + 1,
    };
  }

  /** Fits the image to the window. */
  home(animate = true) {
    if (!animate || !this.hasImage) {
      this.snapHome();
      return;
    }
    this.fitMode = true;
    this.velocity = null;
    const { w, h } = this.viewSize();
    const center = this.viewCenter();
    this.startTween({ kind: "center", fromX: center.x, fromY: center.y, toX: w / 2, toY: h / 2 }, this.homeScale, MOVE_MS, easeMove);
  }

  /** Zooms to `scale` (CSS pixels per image pixel), keeping the point under (ax, ay) fixed. */
  zoomTo(scale: number, ax = this.vw / 2, ay = this.vh / 2, wheel = false) {
    if (!this.hasImage) return;
    const next = clamp(scale, this.minScale, MAX_SCALE);
    if (next <= this.homeScale * 1.0001) {
      this.home();
      return;
    }
    this.fitMode = false;
    this.velocity = null;
    const ix = (ax - this.tx) / this.scale;
    const iy = (ay - this.ty) / this.scale;
    this.startTween({ kind: "anchor", ax, ay, ix, iy }, next, wheel ? WHEEL_MS : MOVE_MS, wheel ? easeWheel : easeMove);
  }

  /** Multiplies the zoom, compounding with any zoom still in flight. */
  zoomBy(factor: number, ax?: number, ay?: number, wheel = false) {
    const base = this.tween ? Math.exp(this.tween.toLog) : this.scale;
    this.zoomTo(base * factor, ax, ay, wheel);
  }

  rotate(quarterTurns: number) {
    if (!this.hasImage) return;
    this.rotation = (((this.rotation + quarterTurns) % 4) + 4) % 4;
    this.snapHome();
  }

  /** Centers the view on a point given in normalized view coordinates. */
  centerOn(nx: number, ny: number) {
    const { w, h } = this.viewSize();
    this.tween = null;
    this.velocity = null;
    this.tx = this.vw / 2 - nx * w * this.scale;
    this.ty = this.vh / 2 - ny * h * this.scale;
    this.clampPosition();
    this.invalidate();
  }

  pan(dx: number, dy: number) {
    this.tx += dx;
    this.ty += dy;
    this.clampPosition();
    this.invalidate();
  }

  // ---- geometry ---------------------------------------------------------------------

  private viewSize() {
    return this.rotation % 2 ? { w: this.uprightH, h: this.uprightW } : { w: this.uprightW, h: this.uprightH };
  }

  private viewCenter() {
    return { x: (this.vw / 2 - this.tx) / this.scale, y: (this.vh / 2 - this.ty) / this.scale };
  }

  /** View ← upright: the user's quarter-turn rotation. */
  private rotationMatrix() {
    const W = this.uprightW;
    const H = this.uprightH;
    switch (this.rotation) {
      case 1: return new DOMMatrix([0, 1, -1, 0, H, 0]);
      case 2: return new DOMMatrix([-1, 0, 0, -1, W, H]);
      case 3: return new DOMMatrix([0, -1, 1, 0, 0, W]);
      default: return new DOMMatrix();
    }
  }

  /** Canvas pixels ← view, with the translation snapped to whole device pixels. */
  private screenMatrix() {
    const k = this.scale * this.dpr;
    return new DOMMatrix([k, 0, 0, k, Math.round(this.tx * this.dpr), Math.round(this.ty * this.dpr)]);
  }

  private snapHome() {
    this.fitMode = true;
    this.tween = null;
    this.scale = this.homeScale;
    const { w, h } = this.viewSize();
    this.tx = (this.vw - w * this.scale) / 2;
    this.ty = (this.vh - h * this.scale) / 2;
    this.invalidate();
  }

  private clampPosition() {
    const { w, h } = this.viewSize();
    const cw = w * this.scale;
    const ch = h * this.scale;
    this.tx = cw <= this.vw ? (this.vw - cw) / 2 : clamp(this.tx, this.vw - cw, 0);
    this.ty = ch <= this.vh ? (this.vh - ch) / 2 : clamp(this.ty, this.vh - ch, 0);
  }

  private resize() {
    const rect = this.container.getBoundingClientRect();
    const center = this.vw ? this.viewCenter() : { x: 0, y: 0 };
    this.vw = rect.width;
    this.vh = rect.height;
    this.dpr = window.devicePixelRatio || 1;
    this.drawer.resize(Math.round(this.vw * this.dpr), Math.round(this.vh * this.dpr));
    this.canvas.style.width = `${this.vw}px`;
    this.canvas.style.height = `${this.vh}px`;
    if (this.fitMode) {
      this.snapHome();
    } else {
      this.scale = Math.max(this.scale, this.minScale);
      this.tx = this.vw / 2 - center.x * this.scale;
      this.ty = this.vh / 2 - center.y * this.scale;
      this.clampPosition();
    }
    this.render();
    this.onChange();
  }

  // ---- input --------------------------------------------------------------------------

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    // A touchpad pinch arrives as ctrl+wheel with small deltas; mouse notches are large.
    const sensitivity = e.ctrlKey ? 0.012 : 0.0042;
    const delta = clamp(e.deltaY * unit, -240, 240);
    this.zoomBy(Math.exp(-delta * sensitivity), e.offsetX, e.offsetY, true);
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.tween = null;
    this.velocity = null;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
    this.canvas.classList.add("grabbing");
  }

  private onPointerMove(e: PointerEvent) {
    this.pointer = { x: e.offsetX, y: e.offsetY };
    if (this.drag && e.pointerId === this.drag.id) {
      const now = performance.now();
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      const dt = Math.max(1, now - this.drag.t);
      this.drag.vx = this.drag.vx * 0.6 + (dx / dt) * 0.4;
      this.drag.vy = this.drag.vy * 0.6 + (dy / dt) * 0.4;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.t = now;
      if (dx || dy) {
        this.fitMode = this.fitMode && !this.viewport.overflow;
        this.pan(dx, dy);
      }
    }
    this.scheduleReadout();
  }

  private onPointerUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const { vx, vy, t } = this.drag;
    this.drag = null;
    this.canvas.classList.remove("grabbing");
    if (performance.now() - t < 80 && Math.hypot(vx, vy) > 0.25) {
      this.velocity = { x: vx, y: vy };
      this.startLoop();
    }
  }

  private toggleZoom(x: number, y: number) {
    const home = this.homeScale;
    if (this.scale > home * 1.02) this.home();
    else this.zoomTo(home < this.actualScale * 0.99 ? this.actualScale : home * 4, x, y);
  }

  private readoutQueued = false;
  private scheduleReadout() {
    if (this.readoutQueued) return;
    this.readoutQueued = true;
    requestAnimationFrame(() => {
      this.readoutQueued = false;
      this.onReadout(this.computeReadout());
    });
  }

  private computeReadout(): Readout | null {
    if (!this.pointer || !this.hasImage) return null;
    const { w, h } = this.viewSize();
    const vx = (this.pointer.x - this.tx) / this.scale;
    const vy = (this.pointer.y - this.ty) / this.scale;
    if (vx < 0 || vy < 0 || vx >= w || vy >= h) return null;
    const readout: Readout = { x: Math.floor(vx), y: Math.floor(vy), color: null };
    const original = this.layers.find((l) => l.density === 1);
    if (original) {
      const toSource = this.rotationMatrix().multiply(original.toUpright).inverse();
      const p = toSource.transformPoint(new DOMPoint(readout.x + 0.5, readout.y + 0.5));
      const sx = Math.floor(p.x);
      const sy = Math.floor(p.y);
      if (sx >= 0 && sy >= 0 && sx < original.width && sy < original.height) {
        try {
          this.probe.clearRect(0, 0, 1, 1);
          this.probe.drawImage(original.image, sx, sy, 1, 1, 0, 0, 1, 1);
          const [r, g, b] = this.probe.getImageData(0, 0, 1, 1).data;
          readout.color = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
        } catch {
          readout.color = null;
        }
      }
    }
    return readout;
  }

  // ---- animation & drawing -------------------------------------------------------------

  private startTween(path: TweenPath, scale: number, duration: number, ease: (t: number) => number) {
    this.tween = { ...path, start: performance.now(), duration, ease, fromLog: Math.log(this.scale), toLog: Math.log(scale) };
    this.startLoop();
  }

  private invalidate() {
    this.dirty = true;
    this.startLoop();
  }

  private startLoop() {
    if (this.frame) return;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number) {
    this.frame = 0;
    const dt = Math.min(64, Math.max(1, now - this.lastTime));
    this.lastTime = now;
    let animating = false;

    const tween = this.tween;
    if (tween) {
      const t = Math.min(1, (now - tween.start) / tween.duration);
      const e = tween.ease(t);
      this.scale = Math.exp(tween.fromLog + (tween.toLog - tween.fromLog) * e);
      if (tween.kind === "anchor") {
        this.tx = tween.ax - tween.ix * this.scale;
        this.ty = tween.ay - tween.iy * this.scale;
      } else {
        this.tx = this.vw / 2 - (tween.fromX + (tween.toX - tween.fromX) * e) * this.scale;
        this.ty = this.vh / 2 - (tween.fromY + (tween.toY - tween.fromY) * e) * this.scale;
      }
      this.clampPosition();
      if (t >= 1) this.tween = null;
      else animating = true;
      this.dirty = true;
    }

    if (this.velocity) {
      const before = { x: this.tx, y: this.ty };
      this.tx += this.velocity.x * dt;
      this.ty += this.velocity.y * dt;
      this.clampPosition();
      // Stop momentum on an axis that hit an edge.
      if (Math.abs(this.tx - before.x) < 0.01) this.velocity.x = 0;
      if (Math.abs(this.ty - before.y) < 0.01) this.velocity.y = 0;
      const decay = Math.exp(-dt / 260);
      this.velocity.x *= decay;
      this.velocity.y *= decay;
      if (Math.hypot(this.velocity.x, this.velocity.y) < 0.015) this.velocity = null;
      else animating = true;
      this.dirty = true;
    }

    if (this.outgoing) {
      if (now - this.outgoing.start >= CROSSFADE_MS) this.finishCrossfade();
      else animating = true;
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.render(now);
      this.onChange();
      if (this.pointer) this.scheduleReadout();
    }
    if (animating) this.startLoop();
  }

  /** Lowest-density layer that still has enough pixels for the current zoom. */
  private pickLayer(): ZoomLayer | undefined {
    const needed = this.scale * this.dpr * 0.98;
    return this.layers.find((l) => l.density >= needed) ?? this.layers[this.layers.length - 1];
  }

  private currentItems(alpha = 1): DrawItem[] {
    const layer = this.pickLayer();
    if (!layer) return [];
    const matrix = this.screenMatrix().multiply(this.rotationMatrix()).multiply(layer.toUpright);
    return [{ layer, matrix, alpha }];
  }

  private render(now = performance.now()) {
    const items = this.currentItems();
    if (this.outgoing) {
      // New photo underneath at full strength, the old one fading out over it.
      const fade = 1 - Math.min(1, (now - this.outgoing.start) / CROSSFADE_MS);
      const eased = fade * fade * (3 - 2 * fade);
      items.push(...this.outgoing.items.map((item) => ({ ...item, alpha: eased })));
    }
    const k = this.scale * this.dpr;
    this.drawer.draw(items, {
      crisp: k >= CRISP_ABOVE,
      grid: k >= GRID_ABOVE ? clamp((k - GRID_ABOVE) / 24, 0, 1) * 0.45 : 0,
      dpr: this.dpr,
    });
  }

  private beginCrossfade() {
    this.finishCrossfade();
    const items = this.currentItems();
    if (!items.length) {
      for (const layer of this.layers) this.retire(layer);
      return;
    }
    // Keep the drawn layer alive for the fade; free the others now.
    for (const layer of this.layers) if (layer !== items[0].layer) this.retire(layer);
    this.outgoing = { items, start: performance.now() };
  }

  private finishCrossfade() {
    if (!this.outgoing) return;
    for (const item of this.outgoing.items) this.retire(item.layer);
    this.outgoing = null;
  }

  private retire(layer: ZoomLayer) {
    const stillUsed = this.layers.some((l) => l !== layer && l.image === layer.image) ||
      this.outgoing?.items.some((i) => i.layer !== layer && i.layer.image === layer.image);
    if (!stillUsed) this.drawer.release(layer.image);
  }
}
