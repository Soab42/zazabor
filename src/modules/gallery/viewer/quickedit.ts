import { api, displayRenderSize, loadImage, previewUrl } from "../../../api";
import { basename, clamp, h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { showToast } from "../../files/ops/toast";
import { autoAdjust, COLOUR_SLIDERS, DEFAULT_ADJUST, EFFECT_SLIDERS, FILTERS, formatValue, isDefault, LIGHT_SLIDERS, type Adjustments, type SliderSpec } from "../../studio/photo/adjust";
import { formatFor, hasAlpha, photoApi, type Decoded } from "../../studio/photo/api";
import { ask } from "../../studio/photo/ask";
import { cloneGeometry, DEFAULT_GEOMETRY, fitRatio, flipShown, frameSize, isIdentity, outputSize, rotateQuarter, type Geometry } from "../../studio/photo/geometry";
import { probeGpu } from "../../studio/photo/gl";
import { leaveForPhoto } from "../../studio/photo/handoff";
import { QuickRenderer } from "../../studio/photo/render";
import type { Photo } from "../library/model";
import { swapsAxes } from "./orient";
import "./quickedit.css";

export interface QuickEditResult {
  /** The file written: a new copy, or the original replaced. */
  path: string;
  mtime: number;
  replaced: boolean;
}

export interface QuickEditHandlers {
  /** Quick Edit closed; `saved` when it wrote a file. */
  close(saved: QuickEditResult | null): void;
  /** Opens the picture in Studio's Photo (the settings are left for it); null when Studio is off. */
  openInPhoto: ((path: string) => void) | null;
}

interface Settings {
  geometry: Geometry;
  adjust: Adjustments;
}

/** Crop shapes, as width / height of the result; "original" follows the turned picture. */
const RATIOS: { id: string; label: string; ratio: number | "original" | null }[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "original", label: "Original", ratio: "original" },
  { id: "1:1", label: "Square", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

const MIN_CROP = 0.03;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number] | "move";

const same = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);
const copy = (s: Settings): Settings => ({ geometry: cloneGeometry(s.geometry), adjust: { ...s.adjust } });

/**
 * The Gallery's Quick Edit: crop, straighten, turn and flip, Auto, the light and colour sliders,
 * filters and a vignette, previewed on the GPU. Saving writes a copy next to the original
 * ("IMG_1234 (edited).jpg") unless "Save over original" is chosen and confirmed.
 */
export class QuickEdit {
  readonly el: HTMLElement;
  private stage = h("div", { class: "qe-stage" });
  private canvas = h("canvas", { class: "qe-canvas" });
  private cropBox = h("div", { class: "qe-crop", hidden: true });
  private cropSize = h("div", { class: "qe-crop-size" });
  private panel = h("aside", { class: "qe-panel" });
  private busyEl = h("div", { class: "qe-busy", hidden: true }, h("span", { class: "spinner" }), h("span", { class: "qe-busy-text" }, "Preparing…"));
  private renderer: QuickRenderer;
  private state: Settings = { geometry: cloneGeometry(DEFAULT_GEOMETRY), adjust: { ...DEFAULT_ADJUST } };
  private undoStack: Settings[] = [];
  private redoStack: Settings[] = [];
  /** The settings when the last undo step was taken (sliders push once per drag). */
  private committed: Settings = copy(this.state);
  private cropping = false;
  private ratioId = "free";
  private comparing = false;
  private busy = false;
  private ready = false;
  private frame = 0;
  private swatchTimer = 0;
  private resize = new ResizeObserver(() => this.redraw());
  /** The full-resolution picture, decoded while the user edits so saving doesn't wait for it. */
  private full: Promise<Decoded> | null = null;
  private controls: { refresh: () => void }[] = [];
  private swatches = new Map<string, HTMLCanvasElement>();
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private cropSection!: HTMLElement;

  constructor(private readonly photo: Photo, private readonly handlers: QuickEditHandlers) {
    this.renderer = new QuickRenderer(this.canvas);
    this.undoButton = h("button", { class: "icon-btn", title: "Undo (Ctrl+Z)", "aria-label": "Undo", onclick: () => this.undo() }, icon("undo"));
    this.redoButton = h("button", { class: "icon-btn", title: "Redo (Ctrl+Shift+Z)", "aria-label": "Redo", onclick: () => this.redo() }, icon("redo"));
    const compare = h("button", { class: "icon-btn", title: "Hold to compare with the original (\\)", "aria-label": "Compare" }, icon("phCompare"));
    compare.addEventListener("pointerdown", () => this.setComparing(true));
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) compare.addEventListener(type, () => this.setComparing(false));
    const more = h("button", { class: "btn primary qe-more", type: "button", title: "More ways to save", "aria-label": "More ways to save", onclick: (e: MouseEvent) => this.openSaveMenu(e.currentTarget as HTMLElement) }, icon("chevronDown", 14));
    const top = h("header", { class: "qe-top" },
      h("button", { class: "btn ghost", type: "button", title: "Close without saving (Esc)", onclick: () => void this.cancel() }, icon("close", 16), "Cancel"),
      h("div", { class: "qe-title" }, h("div", { class: "qe-name" }, photo.name), h("div", { class: "qe-sub" }, "Saving keeps the original: the edit is saved as a copy")),
      h("div", { class: "qe-actions" },
        this.undoButton, this.redoButton, compare,
        h("button", { class: "text-btn", type: "button", title: "Undo every change", onclick: () => this.revert() }, "Revert"),
        h("div", { class: "qe-split" },
          h("button", { class: "btn primary", type: "button", title: "Save a copy next to the original (Ctrl+S)", onclick: () => void this.saveCopy() }, icon("save", 15), "Save a copy"),
          more)));
    this.stage.append(this.canvas, this.cropBox, this.busyEl);
    this.el = h("div", { class: "qe" }, top, h("div", { class: "qe-body" }, this.stage, this.panel));
    this.buildCropBox();
    this.buildPanel();
    this.resize.observe(this.stage);
    this.refresh();
  }

  /** Loads the picture's preview; rejects when it can't be edited here. */
  async start() {
    this.setBusy("Preparing…");
    try {
      const gpu = probeGpu();
      if (!gpu.webgl2) throw new Error("This computer's graphics can't run the editor (no WebGL2).");
      const [info, image] = await Promise.all([
        api.photoInfo(this.photo.path),
        loadImage(previewUrl(this.photo.path, this.photo.mtime, Math.min(displayRenderSize(), gpu.maxTexture))),
      ]);
      let width = info.width, height = info.height;
      if (swapsAxes(info.orientation)) [width, height] = [height, width];
      if (!(width > 0 && height > 0)) [width, height] = [image.naturalWidth, image.naturalHeight];
      this.renderer.setPreview(image, image.naturalWidth, image.naturalHeight, { width, height });
      this.ready = true;
      this.redraw();
      this.scheduleSwatches();
      this.full = photoApi.decode(this.photo.path, gpu.maxTexture);
      // A failure shows when saving.
      this.full.catch(() => undefined);
    } finally {
      this.setBusy(null);
    }
  }

  private get size() {
    return this.renderer.sourceSize;
  }

  // ---- settings and history

  /** Applies settings; `commit` makes it an undo step (a slider's drag commits when it ends). */
  private set(next: Settings, commit = true) {
    this.state = copy(next);
    if (commit) this.commit();
    this.refresh();
    this.redraw();
    this.scheduleSwatches();
  }

  private commit() {
    if (same(this.committed, this.state)) return;
    this.undoStack.push(this.committed);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.committed = copy(this.state);
    this.refreshHistory();
  }

  private undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(copy(this.state));
    this.committed = copy(previous);
    this.set(previous, false);
    this.refreshHistory();
  }

  private redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(copy(this.state));
    this.committed = copy(next);
    this.set(next, false);
    this.refreshHistory();
  }

  private refreshHistory() {
    this.undoButton.disabled = !this.undoStack.length;
    this.redoButton.disabled = !this.redoStack.length;
  }

  private get edited() {
    return !isIdentity(this.state.geometry) || !isDefault(this.state.adjust);
  }

  private revert() {
    this.set({ geometry: cloneGeometry(DEFAULT_GEOMETRY), adjust: { ...DEFAULT_ADJUST } });
    this.ratioId = "free";
  }

  private setAdjust(patch: Partial<Adjustments>, commit = true) {
    this.set({ geometry: this.state.geometry, adjust: { ...this.state.adjust, ...patch } }, commit);
  }

  private setGeometry(geometry: Geometry, commit = true) {
    this.set({ geometry, adjust: this.state.adjust }, commit);
  }

  private refresh() {
    for (const c of this.controls) c.refresh();
    this.refreshHistory();
  }

  // ---- panel

  private buildPanel() {
    const auto = h("button", { class: "btn qe-auto", type: "button", title: "Balance exposure, contrast and colour", onclick: () => this.auto() }, icon("sparkles", 15), "Auto");
    const section = (title: string, glyph: IconName, body: Node[], open = true) => {
      const head = h("button", { class: "qe-section-head", type: "button", "aria-expanded": String(open) }, icon(glyph, 15), h("span", null, title), icon("chevronDown", 14));
      const content = h("div", { class: "qe-section-body" }, ...body);
      const el = h("section", { class: `qe-section${open ? " open" : ""}` }, head, content);
      head.addEventListener("click", () => {
        const now = !el.classList.contains("open");
        el.classList.toggle("open", now);
        head.setAttribute("aria-expanded", String(now));
        if (el === this.cropSection) this.setCropping(now);
      });
      return el;
    };

    // Crop and rotate.
    const ratios = h("div", { class: "qe-chips" }, ...RATIOS.map((r) => {
      const chip = h("button", { class: "qe-chip", type: "button", onclick: () => this.chooseRatio(r.id) }, r.label);
      this.controls.push({ refresh: () => chip.classList.toggle("active", this.ratioId === r.id) });
      return chip;
    }));
    const turn = h("div", { class: "qe-row" },
      this.toolButton("rotateLeft", "Rotate left", () => this.setGeometry(rotateQuarter(this.state.geometry, -1))),
      this.toolButton("rotateRight", "Rotate right", () => this.setGeometry(rotateQuarter(this.state.geometry, 1))),
      this.toolButton("phFlipH", "Flip horizontally", () => this.setGeometry(flipShown(this.state.geometry, true))),
      this.toolButton("phFlipV", "Flip vertically", () => this.setGeometry(flipShown(this.state.geometry, false))),
      h("span", { class: "spacer" }),
      h("button", { class: "text-btn", type: "button", title: "Undo the crop, turns and straightening", onclick: () => ((this.ratioId = "free"), this.setGeometry(cloneGeometry(DEFAULT_GEOMETRY))) }, "Reset"));
    const straighten = this.slider({ label: "Straighten", min: -45, max: 45, step: 0.1 }, () => this.state.geometry.angle, (v, commit) => {
      const g = cloneGeometry(this.state.geometry);
      g.angle = v;
      this.setGeometry(g, commit);
    }, (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}°`);
    this.cropSection = section("Crop & rotate", "phCrop", [ratios, turn, straighten], false);

    const sliders = (specs: SliderSpec[]) => specs.map((spec) => this.slider(spec, () => this.state.adjust[spec.key], (v, commit) => this.setAdjust({ [spec.key]: v }, commit), (v) => formatValue(spec, v)));

    const filterGrid = h("div", { class: "qe-filters" }, ...FILTERS.map((f) => {
      const swatch = h("canvas", { class: "qe-swatch", width: 64, height: 64 });
      this.swatches.set(f.id, swatch);
      const b = h("button", { class: "qe-filter", type: "button", title: f.label, onclick: () => this.setAdjust({ look: f.id, lookAmount: f.id === this.state.adjust.look ? this.state.adjust.lookAmount : 100 }) }, swatch, h("span", null, f.label));
      this.controls.push({ refresh: () => b.classList.toggle("active", this.state.adjust.look === f.id) });
      return b;
    }));
    const strength = this.slider({ key: "lookAmount", label: "Strength", min: 0, max: 100, step: 1 }, () => this.state.adjust.lookAmount, (v, commit) => this.setAdjust({ lookAmount: v }, commit), (v) => `${Math.round(v)}%`);
    this.controls.push({ refresh: () => (strength.hidden = this.state.adjust.look === "none") });

    this.panel.append(
      h("div", { class: "qe-auto-row" }, auto),
      this.cropSection,
      section("Light", "phLight", sliders(LIGHT_SLIDERS)),
      section("Colour", "palette", sliders(COLOUR_SLIDERS)),
      section("Filters", "phFilters", [filterGrid, strength]),
      section("Effects", "phVignette", sliders(EFFECT_SLIDERS)),
    );
  }

  private toolButton(glyph: IconName, title: string, run: () => void) {
    return h("button", { class: "icon-btn", type: "button", title, "aria-label": title, onclick: run }, icon(glyph));
  }

  /** A labelled slider; double-clicking it (or its value) puts it back to zero. */
  private slider(spec: Pick<SliderSpec, "label" | "min" | "max" | "step"> & { key?: string }, get: () => number, put: (v: number, commit: boolean) => void, show: (v: number) => string) {
    const input = h("input", { type: "range", class: "qe-range", min: spec.min, max: spec.max, step: spec.step, "aria-label": spec.label });
    const value = h("span", { class: "qe-value" });
    const reset = spec.key === "lookAmount" ? 100 : 0;
    input.addEventListener("input", () => put(Number(input.value), false));
    input.addEventListener("change", () => put(Number(input.value), true));
    const back = () => put(reset, true);
    input.addEventListener("dblclick", back);
    value.addEventListener("dblclick", back);
    const row = h("label", { class: "qe-slider" }, h("span", { class: "qe-label" }, spec.label), value, input);
    this.controls.push({
      refresh: () => {
        const v = get();
        if (document.activeElement !== input || Number(input.value) !== v) input.value = String(v);
        value.textContent = show(v);
        row.classList.toggle("changed", v !== reset);
        // The fill grows from the middle for two-sided sliders.
        const lo = (Math.min(v, reset) - spec.min) / (spec.max - spec.min);
        const hi = (Math.max(v, reset) - spec.min) / (spec.max - spec.min);
        input.style.setProperty("--lo", `${lo * 100}%`);
        input.style.setProperty("--hi", `${hi * 100}%`);
      },
    });
    return row;
  }

  private auto() {
    if (!this.ready) return;
    const [ow, oh] = outputSize(this.state.geometry, this.size.width, this.size.height);
    const k = 256 / Math.max(ow, oh);
    const pixels = this.renderer.renderSmall(this.state.geometry, null, Math.max(1, Math.round(ow * k)), Math.max(1, Math.round(oh * k)));
    this.setAdjust(autoAdjust(pixels, this.state.adjust));
  }

  /** Filter swatches follow the other settings, a moment after they change. */
  private scheduleSwatches() {
    clearTimeout(this.swatchTimer);
    this.swatchTimer = window.setTimeout(() => this.drawSwatches(), 250);
  }

  private drawSwatches() {
    if (!this.ready) return;
    const square = fitRatio(this.state.geometry, 1, this.size.width, this.size.height);
    for (const [id, canvas] of this.swatches) {
      const pixels = this.renderer.renderSmall(square, { ...this.state.adjust, look: id as Adjustments["look"], lookAmount: 100, vignette: 0 }, 64, 64);
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), 64, 64), 0, 0);
    }
  }

  // ---- crop

  private setCropping(on: boolean) {
    this.cropping = on;
    this.cropBox.hidden = !on;
    this.stage.classList.toggle("cropping", on);
    this.redraw();
  }

  private chooseRatio(id: string) {
    this.ratioId = id;
    const ratio = this.currentRatio();
    if (!this.cropping) {
      this.cropSection.classList.add("open");
      this.setCropping(true);
    }
    this.setGeometry(ratio ? fitRatio(this.state.geometry, ratio, this.size.width, this.size.height) : this.state.geometry);
  }

  /** The chosen shape as width / height in pixels, or null for free. */
  private currentRatio(): number | null {
    const r = RATIOS.find((x) => x.id === this.ratioId)?.ratio ?? null;
    if (r !== "original") return r;
    const [fw, fh] = frameSize(this.state.geometry, this.size.width, this.size.height);
    return fw / fh;
  }

  private buildCropBox() {
    this.cropBox.append(h("div", { class: "qe-crop-grid" }), this.cropSize, ...HANDLES.map((edge) => h("div", { class: `qe-handle ${edge}`, "data-edge": edge })));
    this.cropBox.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const edge = ((e.target as HTMLElement).dataset.edge ?? "move") as Handle;
      const start = cloneGeometry(this.state.geometry);
      const rect = this.displayRect(true);
      const dpr = window.devicePixelRatio || 1;
      const x0 = e.clientX, y0 = e.clientY;
      this.cropBox.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = ((ev.clientX - x0) * dpr) / rect.w;
        const dy = ((ev.clientY - y0) * dpr) / rect.h;
        this.setGeometry(this.dragCrop(start, edge, dx, dy), false);
      };
      const up = () => {
        this.cropBox.removeEventListener("pointermove", move);
        this.cropBox.removeEventListener("pointerup", up);
        this.cropBox.removeEventListener("pointercancel", up);
        this.commit();
      };
      this.cropBox.addEventListener("pointermove", move);
      this.cropBox.addEventListener("pointerup", up);
      this.cropBox.addEventListener("pointercancel", up);
    });
  }

  /** The crop after dragging `edge` by (dx, dy) in frame units, kept inside the frame and in shape. */
  private dragCrop(start: Geometry, edge: Handle, dx: number, dy: number): Geometry {
    const g = cloneGeometry(start);
    const c = start.crop;
    if (edge === "move") {
      g.crop.x = clamp(c.x + dx, 0, 1 - c.w);
      g.crop.y = clamp(c.y + dy, 0, 1 - c.h);
      return g;
    }
    let left = c.x, top = c.y, right = c.x + c.w, bottom = c.y + c.h;
    if (edge.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP);
    if (edge.includes("e")) right = clamp(right + dx, left + MIN_CROP, 1);
    if (edge.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP);
    if (edge.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
    const ratio = this.currentRatio();
    if (ratio) {
      const [fw, fh] = frameSize(start, this.size.width, this.size.height);
      // In frame units a crop of this shape has w / h = r.
      const r = (ratio * fh) / fw;
      const corner = edge.length === 2;
      let w = right - left, h = bottom - top;
      if (corner) w = Math.max(w, h * r);
      else if (edge === "e" || edge === "w") h = w / r;
      else w = h * r;
      h = w / r;
      // Grow from the fixed side (or the middle, for an edge) without leaving the frame.
      const ax = edge.includes("w") ? right : edge.includes("e") ? left : (left + right) / 2;
      const ay = edge.includes("n") ? bottom : edge.includes("s") ? top : (top + bottom) / 2;
      const roomX = edge.includes("w") ? ax : edge.includes("e") ? 1 - ax : 2 * Math.min(ax, 1 - ax);
      const roomY = edge.includes("n") ? ay : edge.includes("s") ? 1 - ay : 2 * Math.min(ay, 1 - ay);
      if (w > roomX) (w = roomX), (h = w / r);
      if (h > roomY) (h = roomY), (w = h * r);
      left = edge.includes("w") ? ax - w : edge.includes("e") ? ax : ax - w / 2;
      top = edge.includes("n") ? ay - h : edge.includes("s") ? ay : ay - h / 2;
      right = left + w;
      bottom = top + h;
    }
    g.crop = { x: left, y: top, w: right - left, h: bottom - top };
    return g;
  }

  // ---- drawing

  /** Where the picture shows on the canvas, in device pixels. */
  private displayRect(whole: boolean) {
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width, H = this.canvas.height;
    const margin = Math.round((whole ? 40 : 24) * dpr);
    const g = this.comparing ? DEFAULT_GEOMETRY : this.state.geometry;
    const [fw, fh] = frameSize(g, this.size.width, this.size.height);
    const [ow, oh] = whole || this.comparing ? [fw, fh] : outputSize(g, this.size.width, this.size.height);
    const k = Math.min((W - 2 * margin) / ow, (H - 2 * margin) / oh);
    const w = Math.max(1, Math.round(ow * k)), hgt = Math.max(1, Math.round(oh * k));
    return { x: Math.round((W - w) / 2), y: Math.round((H - hgt) / 2), w, h: hgt };
  }

  private redraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.stage.clientWidth * dpr)), H = Math.max(1, Math.round(this.stage.clientHeight * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    if (!this.ready) return;
    const whole = this.cropping && !this.comparing;
    const rect = this.displayRect(whole);
    const backdrop = cssColor(getComputedStyle(this.stage).backgroundColor);
    if (this.comparing) this.renderer.draw(DEFAULT_GEOMETRY, null, rect, backdrop);
    else this.renderer.draw(this.state.geometry, this.state.adjust, rect, backdrop, whole);
    if (whole) {
      const c = this.state.geometry.crop;
      Object.assign(this.cropBox.style, {
        left: `${(rect.x + c.x * rect.w) / dpr}px`,
        top: `${(rect.y + c.y * rect.h) / dpr}px`,
        width: `${(c.w * rect.w) / dpr}px`,
        height: `${(c.h * rect.h) / dpr}px`,
      });
      const [ow, oh] = outputSize(this.state.geometry, this.size.width, this.size.height);
      this.cropSize.textContent = `${ow} × ${oh}`;
    }
  }

  private setComparing(on: boolean) {
    if (this.comparing === on) return;
    this.comparing = on;
    this.cropBox.hidden = !this.cropping || on;
    this.redraw();
  }

  // ---- saving

  private setBusy(text: string | null) {
    this.busy = text !== null;
    this.busyEl.hidden = !this.busy;
    if (text) this.busyEl.querySelector(".qe-busy-text")!.textContent = text;
    this.el.classList.toggle("busy", this.busy);
  }

  /** Renders the picture at full resolution with the current settings. */
  private async renderFull() {
    this.full ??= photoApi.decode(this.photo.path, probeGpu().maxTexture);
    const full = await this.full;
    const out = this.renderer.renderFull(full, this.state.geometry, this.state.adjust, !hasAlpha(formatFor(this.photo.path)));
    return { full, out };
  }

  private async saveCopy() {
    if (this.busy || !this.ready) return;
    this.setBusy("Saving a copy…");
    try {
      const { full, out } = await this.renderFull();
      const format = formatFor(this.photo.path);
      const target = await photoApi.copyPath(this.photo.path, this.photo.path.toLowerCase().endsWith(".gif") ? "png" : undefined);
      const mtime = await photoApi.encode(target, { ...out, format, quality: 92, icc: full.icc, exif: full.exif });
      showToast(`Saved as “${basename(target)}”${full.scaled ? " (scaled to fit the graphics card)" : ""}`, undefined, 4000);
      this.finish({ path: target, mtime, replaced: false });
    } catch (err) {
      this.setBusy(null);
      showToast(`Couldn’t save: ${errorText(err)}`, undefined, 6000);
    }
  }

  private async saveOver() {
    if (this.busy || !this.ready) return;
    const answer = await ask({
      title: `Replace “${this.photo.name}”?`,
      text: "The original picture will be overwritten with the edited one. This can't be undone.",
      icon: "save",
      choices: [{ id: "cancel", label: "Cancel" }, { id: "replace", label: "Replace the Original", primary: true }],
      cancel: "cancel",
    });
    if (answer !== "replace") return;
    this.setBusy("Saving…");
    try {
      const { full, out } = await this.renderFull();
      if (full.scaled) throw new Error("the picture is larger than the graphics card can hold, so it would lose resolution. Save a copy instead.");
      const mtime = await photoApi.encode(this.photo.path, { ...out, format: formatFor(this.photo.path), quality: 92, icc: full.icc, exif: full.exif });
      showToast(`Saved “${this.photo.name}”`, undefined, 3000);
      this.finish({ path: this.photo.path, mtime, replaced: true });
    } catch (err) {
      this.setBusy(null);
      showToast(`Couldn’t save: ${errorText(err)}`, undefined, 6000);
    }
  }

  private openSaveMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    const toPhoto = this.handlers.openInPhoto;
    openMenu(r.right - 220, r.bottom + 6, [
      { label: "Save a copy", icon: "save", shortcut: "Ctrl+S", action: () => void this.saveCopy() },
      { label: "Save over original…", icon: "saveAs", action: () => void this.saveOver() },
      "separator",
      { label: "Open in Photo", icon: "photoEdit", disabled: !toPhoto, action: () => this.openInPhoto() },
    ]);
  }

  /** Photo opens the picture with these settings as an adjustment layer. */
  private openInPhoto() {
    const toPhoto = this.handlers.openInPhoto;
    if (!toPhoto || this.busy) return;
    leaveForPhoto(this.photo.path, { geometry: cloneGeometry(this.state.geometry), adjust: { ...this.state.adjust } });
    this.finish(null);
    toPhoto(this.photo.path);
  }

  private async cancel() {
    if (this.busy) return;
    if (this.edited) {
      const answer = await ask({
        title: "Discard your edits?",
        text: "The picture stays as it was.",
        choices: [{ id: "keep", label: "Keep Editing" }, { id: "discard", label: "Discard", primary: true }],
        cancel: "keep",
      });
      if (answer !== "discard") return;
    }
    this.finish(null);
  }

  private finish(saved: QuickEditResult | null) {
    this.dispose();
    this.handlers.close(saved);
  }

  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (this.busy) return true;
    if (e.key === "Escape") {
      if (this.cropping) {
        this.cropSection.classList.remove("open");
        this.setCropping(false);
      } else void this.cancel();
      return true;
    }
    if (e.key === "Enter" && this.cropping) {
      this.cropSection.classList.remove("open");
      this.setCropping(false);
      return true;
    }
    if (mod && key === "z") {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && key === "y") {
      this.redo();
      return true;
    }
    if (mod && key === "s") {
      void this.saveCopy();
      return true;
    }
    if (e.key === "\\") {
      this.setComparing(true);
      window.addEventListener("keyup", () => this.setComparing(false), { once: true });
      return true;
    }
    if (!mod && key === "c") {
      const open = !this.cropping;
      this.cropSection.classList.toggle("open", open);
      this.setCropping(open);
      return true;
    }
    return false;
  }

  dispose() {
    this.full = null;
    clearTimeout(this.swatchTimer);
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.renderer.dispose();
    this.el.remove();
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error:\s*/, "");
}

/** "rgb(12, 12, 14)" as 0–1 channels. */
function cssColor(text: string): [number, number, number] {
  const m = text.match(/[\d.]+/g)?.map(Number) ?? [12, 12, 14];
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}
