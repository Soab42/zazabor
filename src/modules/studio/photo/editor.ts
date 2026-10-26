import { save as saveDialog } from "../../../shared/dialog";
import { basename, clamp, dirname, h, stripExtension } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import type { StudioApp, StudioHost } from "../app";
import { autoAdjust, COLOUR_SLIDERS, DEFAULT_ADJUST, EFFECT_SLIDERS, FILTERS, formatValue, isDefault, LIGHT_SLIDERS, type Adjustments, type SliderSpec } from "./adjust";
import { extensionOf, formatFor, hasAlpha, photoApi, SAVE_FORMATS, type Decoded, type ProjectLayer, type SaveFormat } from "./api";
import { ask } from "./ask";
import { askExport, askImageSize, type NewCanvas } from "./dialogs";
import { BLEND_GROUPS, Engine, union, type AdjustLayer, type Dab, type Doc, type Layer, type PixelLayer, type Rect, type Transform } from "./engine";
import { floodMask, paintMask } from "./fill";
import { isIdentity } from "./geometry";
import { describeGpu } from "./gl";
import type { QuickEditSettings } from "./handoff";
import { History } from "./history";
import type { LoadedProject, ProjectJson, ProjectLayerJson } from "./project";
import { QuickRenderer } from "./render";
import { hexToRgb, normalizePhotoSettings, rgbToHex, type BrushSettings, type PhotoSettings, type Tool } from "./settings";
import "./photo.css";

/** How a document starts. */
export type Opening =
  | { kind: "new"; canvas: NewCanvas }
  | { kind: "picture"; path: string; decoded: Decoded; quick: QuickEditSettings | null }
  | { kind: "project"; path: string; project: LoadedProject };

/** Layers, buffers and history together may use about this much memory. */
const BUDGET = 1.5 * 1024 * 1024 * 1024;
const ZOOMS = [1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32];
const PREVIEW_SIDE = 1600;

const TOOL_INFO: Record<Tool, { label: string; key: string; icon: IconName }> = {
  move: { label: "Move", key: "V", icon: "phMove" },
  crop: { label: "Crop", key: "C", icon: "phCrop" },
  brush: { label: "Brush", key: "B", icon: "brush" },
  eraser: { label: "Eraser", key: "E", icon: "eraser" },
  gradient: { label: "Gradient", key: "G", icon: "phGradient" },
  bucket: { label: "Paint Bucket", key: "G", icon: "bucket" },
  eyedropper: { label: "Eyedropper", key: "I", icon: "phEyedropper" },
  hand: { label: "Hand", key: "H", icon: "phHand" },
  zoom: { label: "Zoom", key: "Z", icon: "zoomIn" },
};
const TOOL_ORDER: Tool[] = ["move", "crop", "brush", "eraser", "gradient", "bucket", "eyedropper", "hand", "zoom"];

const CROP_RATIOS: { id: string; label: string; ratio: number | null }[] = [
  { id: "free", label: "Ratio: free", ratio: null },
  { id: "1:1", label: "1:1 (square)", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

type Drag =
  | { kind: "pan"; x: number; y: number; cx: number; cy: number }
  | { kind: "paint"; layer: PixelLayer; last: { x: number; y: number }; rest: number; brush: BrushSettings; pen: boolean }
  | { kind: "gradient"; layer: PixelLayer; from: [number, number] }
  | { kind: "move"; layer: PixelLayer; x: number; y: number; ox: number; oy: number }
  | { kind: "crop"; mode: string; start: Rect; x: number; y: number }
  | { kind: "pick" };

const bytesOf = (layer: Layer) => (layer.kind === "pixel" ? layer.width * layer.height * 4 : 0);
const sizeText = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/**
 * Photo: a layered photo editor in Photoshop's layout. Tools on the left, the tool's options
 * along the top, the canvas in the middle, and Adjustments, Layers and History on the right.
 */
export class PhotoEditor implements StudioApp {
  readonly kind = "photo" as const;
  readonly el: HTMLElement;
  private engine: Engine;
  private settings: PhotoSettings;
  private doc: Doc = { width: 1, height: 1, layers: [] };
  private history = new History("Open");
  private activeIndex = 0;
  private nextId = 1;
  private untitled = "Untitled";
  /** What Ctrl+S writes: a project, or a picture the user saved to. */
  private filePath: string | null = null;
  /** The picture this document was opened from: never overwritten without asking. */
  private sourcePicture: string | null = null;
  private icc: Uint8Array = new Uint8Array(0);
  private exif: Uint8Array = new Uint8Array(0);
  private busy = false;

  // View: device pixels per document pixel, and the document point at the canvas centre.
  private zoom = 1;
  private cx = 0;
  private cy = 0;
  private fitted = true;

  private stage = h("div", { class: "ph-stage", tabindex: "-1" });
  private canvas = h("canvas", { class: "ph-canvas" });
  private overlay = h("canvas", { class: "ph-overlay" });
  private optionsBar = h("div", { class: "ph-options" });
  private toolsBar = h("nav", { class: "ph-tools", "aria-label": "Tools" });
  private propsBody = h("div", { class: "ph-panel-body ph-props" });
  private layersBody = h("div", { class: "ph-panel-body ph-layers" });
  private layerControls = h("div", { class: "ph-layer-controls" });
  private historyBody = h("div", { class: "ph-panel-body ph-history" });
  private statusZoom = h("span", { class: "ph-status-zoom" });
  private statusSize = h("span");
  private statusMemory = h("span");
  private statusPointer = h("span", { class: "ph-status-pointer" });
  private titleName = h("span", { class: "ph-title-name" });
  private titleState = h("span", { class: "ph-title-state" });
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private busyEl = h("div", { class: "ph-busy", hidden: true }, h("span", { class: "spinner" }), h("span", { class: "ph-busy-text" }));

  private frame = 0;
  private drag: Drag | null = null;
  private pointer: { x: number; y: number; inside: boolean } = { x: 0, y: 0, inside: false };
  private spaceHeld = false;
  private crop: Rect | null = null;
  private thumbs = new Map<number, { version: number; canvas: HTMLCanvasElement }>();
  private versions = new Map<number, number>();
  private thumbTimer = 0;
  private settingsTimer = 0;
  private resize = new ResizeObserver(() => this.fitIfFitted());
  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") {
      this.spaceHeld = false;
      this.updateCursor();
    }
  };

  constructor(private readonly host: StudioHost) {
    this.settings = normalizePhotoSettings(host.shell.config.studio.apps.photo);
    this.engine = new Engine(this.canvas);
    this.undoButton = h("button", { class: "icon-btn small", type: "button", "aria-label": "Undo", onclick: () => this.history.undo() }, icon("undo", 16));
    this.redoButton = h("button", { class: "icon-btn small", type: "button", "aria-label": "Redo", onclick: () => this.history.redo() }, icon("redo", 16));
    const menu = (label: string, items: () => MenuItem[]) => {
      const button = h("button", { class: "ph-menu-btn", type: "button" }, label);
      button.addEventListener("click", () => {
        const r = button.getBoundingClientRect();
        openMenu(r.left, r.bottom + 2, items());
      });
      return button;
    };
    const titlebar = h("header", { class: "ph-titlebar" },
      h("button", { class: "icon-btn small", type: "button", title: "Studio Home", "aria-label": "Studio Home", onclick: () => this.host.showHome() }, icon("home", 16)),
      h("span", { class: "ph-app-mark" }, icon("photoEdit", 15)),
      h("div", { class: "ph-menus" },
        menu("File", () => this.fileMenu()),
        menu("Edit", () => this.editMenu()),
        menu("Image", () => this.imageMenu()),
        menu("Layer", () => this.layerMenu()),
        menu("View", () => this.viewMenu())),
      h("div", { class: "ph-title" }, this.titleName, this.titleState),
      h("div", { class: "ph-title-actions" }, this.undoButton, this.redoButton));
    this.stage.append(this.canvas, this.overlay, this.busyEl);
    const panel = (title: string, glyph: IconName, body: HTMLElement, extra?: HTMLElement) =>
      h("section", { class: "ph-panel" }, h("header", { class: "ph-panel-head" }, icon(glyph, 14), h("span", null, title), extra ?? null), body);
    const layerButtons = h("div", { class: "ph-layer-buttons" },
      this.iconButton("phNewLayer", "New layer (Ctrl+Shift+N)", () => this.newLayer()),
      this.iconButton("phAdjustLayer", "New adjustment layer", () => this.newAdjustLayer()),
      this.iconButton("copy", "Duplicate layer (Ctrl+J)", () => this.duplicateLayer()),
      this.iconButton("phMerge", "Merge down (Ctrl+E)", () => this.mergeDown()),
      this.iconButton("trash", "Delete layer", () => this.deleteLayer()));
    const panels = h("aside", { class: "ph-panels" },
      panel("Adjustments", "phAdjustLayer", this.propsBody),
      h("section", { class: "ph-panel ph-panel-layers" }, h("header", { class: "ph-panel-head" }, icon("phLayers", 14), h("span", null, "Layers")), this.layerControls, this.layersBody, layerButtons),
      panel("History", "phHistory", this.historyBody));
    const status = h("footer", { class: "ph-status" }, this.statusZoom, this.statusSize, this.statusMemory, h("span", { class: "spacer" }), this.statusPointer,
      h("span", { class: "ph-status-gpu", title: this.engine.gpu.renderer || "Graphics" }, describeGpu(this.engine.gpu)));
    this.el = h("div", { class: "ph tone-photo" }, titlebar, this.optionsBar, h("div", { class: "ph-main" }, this.toolsBar, this.stage, panels), status);
    this.history.onChange = () => this.historyChanged();
    this.bindStage();
    this.resize.observe(this.stage);
    window.addEventListener("keyup", this.onKeyUp);
  }

  // ---- opening

  async load(opening: Opening) {
    const gpu = this.engine.gpu;
    if (opening.kind === "new") {
      const { width, height, background } = opening.canvas;
      this.untitled = "Untitled";
      this.history = this.newHistory("New Canvas", "phCanvas");
      this.setDocSize(width, height);
      const fill: [number, number, number, number] | null = background === "white" ? [1, 1, 1, 1] : background === "black" ? [0, 0, 0, 1] : null;
      this.doc.layers = [this.pixelLayer(background === "transparent" ? "Layer 1" : "Background", 0, 0, width, height, fill)];
      if (background === "transparent") this.nextLayerNumber = 2;
    } else if (opening.kind === "picture") {
      let { decoded } = opening;
      this.sourcePicture = opening.path;
      this.icc = decoded.icc.slice();
      this.exif = decoded.exif.slice();
      this.history = this.newHistory("Open", "image");
      const quick = opening.quick;
      if (quick && !isIdentity(quick.geometry)) {
        // Quick Edit's crop and turns become the picture; its sliders an adjustment layer.
        const renderer = new QuickRenderer();
        try {
          const out = renderer.renderFull(decoded, quick.geometry, null);
          decoded = { ...decoded, ...out };
        } finally {
          renderer.dispose();
        }
      }
      this.setDocSize(decoded.width, decoded.height);
      this.doc.layers = [this.pixelLayer("Background", 0, 0, decoded.width, decoded.height, decoded.rgba)];
      if (quick && !isDefault(quick.adjust)) {
        this.doc.layers.push(this.adjustLayer("Quick Edit", quick.adjust));
      }
      if (decoded.scaled) this.host.toast(`${basename(opening.path)} was scaled to ${decoded.width} × ${decoded.height}: the largest this computer's graphics can edit.`);
    } else {
      const { project } = opening;
      this.filePath = opening.path;
      this.icc = project.icc.slice();
      this.history = this.newHistory("Open", "image");
      this.setDocSize(project.width, project.height);
      this.doc.layers = project.layers.map((l) =>
        l.kind === "pixel"
          ? { ...this.pixelLayer(l.name, l.x, l.y, l.width, l.height, l.rgba), visible: l.visible, opacity: l.opacity, blend: l.blend }
          : { ...this.adjustLayer(l.name, l.adjust), visible: l.visible, opacity: l.opacity, blend: l.blend });
      this.nextLayerNumber = this.doc.layers.length + 1;
    }
    this.activeIndex = opening.kind === "project" ? opening.project.active : this.doc.layers.length - 1;
    const needed = this.memoryUse();
    if (needed > BUDGET) this.host.toast(`This picture needs ${sizeText(needed)}, more than Photo's ${sizeText(BUDGET)}: it may be slow.`);
    if (!gpu.halfFloatTargets) console.warn("Photo: this GPU can't render into float textures; compositing in 8 bits.");
    this.selectTool(this.settings.tool);
    this.refreshAll();
    if (opening.kind === "picture" && opening.quick) this.history.markUnsaved();
    this.historyChanged();
    this.fit();
  }

  private newHistory(label: string, glyph: IconName) {
    const history = new History(label, glyph);
    history.onChange = () => this.historyChanged();
    return history;
  }

  private nextLayerNumber = 1;

  private pixelLayer(name: string, x: number, y: number, width: number, height: number, fill: Uint8Array | [number, number, number, number] | null): PixelLayer {
    return { kind: "pixel", id: this.nextId++, name, visible: true, opacity: 1, blend: "normal", x, y, width, height, tex: this.engine.layerTexture(width, height, fill) };
  }

  private adjustLayer(name: string, adjust: Adjustments): AdjustLayer {
    return { kind: "adjust", id: this.nextId++, name, visible: true, opacity: 1, blend: "normal", adjust: { ...adjust } };
  }

  private setDocSize(width: number, height: number) {
    this.doc.width = width;
    this.doc.height = height;
    this.engine.setDocSize(width, height);
  }

  // ---- StudioApp

  title() {
    return this.filePath ? basename(this.filePath) : this.sourcePicture ? basename(this.sourcePicture) : this.untitled;
  }

  path() {
    return this.filePath ?? this.sourcePicture;
  }

  dirty() {
    return this.history.dirty;
  }

  activate() {
    this.fitIfFitted();
  }

  deactivate() {
    this.endDrag(false);
  }

  dispose() {
    clearTimeout(this.thumbTimer);
    clearTimeout(this.settingsTimer);
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    window.removeEventListener("keyup", this.onKeyUp);
    this.history.clear();
    for (const layer of this.doc.layers) if (layer.kind === "pixel") this.engine.deleteTexture(layer.tex);
    this.engine.dispose();
  }

  // ---- layers

  private get layer(): Layer | undefined {
    return this.doc.layers[this.activeIndex];
  }

  private get pixelTarget(): PixelLayer | null {
    const layer = this.layer;
    return layer?.kind === "pixel" ? layer : null;
  }

  /** Memory in use: layers, compositing buffers and history. */
  private memoryUse() {
    return this.doc.layers.reduce((n, l) => n + bytesOf(l), 0) + this.engine.bufferBytes + this.history.bytes;
  }

  /** Whether `bytes` more fit the budget; says why not when they don't. */
  private fits(bytes: number) {
    if (this.memoryUse() + bytes <= BUDGET) return true;
    this.host.toast(`Not enough memory for that: Photo uses ${sizeText(this.memoryUse())} of ${sizeText(BUDGET)}. Merge or delete layers first.`);
    return false;
  }

  /** A layer's pixels changed: its thumbnail follows. */
  private touched(layer: Layer) {
    this.versions.set(layer.id, (this.versions.get(layer.id) ?? 0) + 1);
    this.engine.invalidate();
    this.scheduleThumbs();
    this.render();
  }

  /** Records a change of the layer list (added, removed, reordered, merged layers). */
  private recordLayers(label: string, glyph: IconName, before: Layer[], beforeActive: number) {
    const after = [...this.doc.layers];
    const afterActive = this.activeIndex;
    const added = after.filter((l) => !before.includes(l));
    const removed = before.filter((l) => !after.includes(l));
    const apply = (layers: Layer[], active: number) => {
      this.doc.layers = [...layers];
      this.activeIndex = active;
      this.engine.invalidate();
      this.refreshAll();
    };
    this.history.push({
      label,
      icon: glyph,
      bytes: [...added, ...removed].reduce((n, l) => n + bytesOf(l), 0),
      undo: () => apply(before, beforeActive),
      redo: () => apply(after, afterActive),
      drop: (applied) => {
        for (const layer of applied ? removed : added) if (layer.kind === "pixel") this.engine.deleteTexture(layer.tex);
      },
    });
  }

  /** Records a change of some layer settings: `set(true)` puts the new ones back, `set(false)` the old. */
  private recordChange(label: string, glyph: IconName, set: (after: boolean) => void) {
    this.history.push({
      label,
      icon: glyph,
      bytes: 0,
      undo: () => (set(false), this.engine.invalidate(), this.refreshAll()),
      redo: () => (set(true), this.engine.invalidate(), this.refreshAll()),
    });
  }

  /** Records pixels that changed in a rectangle of a layer (`before` holds the old ones). */
  private recordPixels(label: string, glyph: IconName, layer: PixelLayer, rect: Rect, before: Uint8Array) {
    let data = before;
    const swap = () => {
      data = this.engine.swapTexture(layer.tex, rect, data);
      this.touched(layer);
    };
    this.history.push({ label, icon: glyph, bytes: data.length, undo: swap, redo: swap });
  }

  private newLayer() {
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const before = [...this.doc.layers], active = this.activeIndex;
    const layer = this.pixelLayer(`Layer ${this.nextLayerNumber++}`, 0, 0, this.doc.width, this.doc.height, null);
    this.doc.layers.splice(this.activeIndex + 1, 0, layer);
    this.activeIndex++;
    this.recordLayers("New Layer", "phNewLayer", before, active);
    this.refreshAll();
  }

  private newAdjustLayer(adjust: Adjustments = DEFAULT_ADJUST, name = "Adjustments") {
    const before = [...this.doc.layers], active = this.activeIndex;
    const count = this.doc.layers.filter((l) => l.kind === "adjust").length + 1;
    this.doc.layers.splice(this.activeIndex + 1, 0, this.adjustLayer(`${name} ${count}`, adjust));
    this.activeIndex++;
    this.engine.invalidate();
    this.recordLayers("New Adjustment Layer", "phAdjustLayer", before, active);
    this.refreshAll();
  }

  private duplicateLayer() {
    const layer = this.layer;
    if (!layer || !this.fits(bytesOf(layer))) return;
    const before = [...this.doc.layers], active = this.activeIndex;
    const copy: Layer = layer.kind === "pixel"
      ? { ...layer, id: this.nextId++, name: `${layer.name} copy`, tex: this.engine.transformTexture(layer.tex, layer.width, layer.height, "copy") }
      : { ...layer, id: this.nextId++, name: `${layer.name} copy`, adjust: { ...layer.adjust } };
    this.doc.layers.splice(this.activeIndex + 1, 0, copy);
    this.activeIndex++;
    this.recordLayers("Duplicate Layer", "copy", before, active);
    this.engine.invalidate();
    this.refreshAll();
  }

  private deleteLayer() {
    if (!this.layer) return;
    if (this.doc.layers.length === 1) return this.host.toast("A picture keeps at least one layer.");
    const before = [...this.doc.layers], active = this.activeIndex;
    this.doc.layers.splice(this.activeIndex, 1);
    this.activeIndex = Math.max(0, this.activeIndex - 1);
    this.recordLayers("Delete Layer", "trash", before, active);
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Merges `layers` (in order, bottom first) into one pixel layer the size of the document. */
  private merged(layers: Layer[], name: string): PixelLayer {
    const tex = this.engine.mergeLayers({ width: this.doc.width, height: this.doc.height, layers });
    return { kind: "pixel", id: this.nextId++, name, visible: true, opacity: 1, blend: "normal", x: 0, y: 0, width: this.doc.width, height: this.doc.height, tex };
  }

  private mergeDown() {
    const top = this.layer, below = this.doc.layers[this.activeIndex - 1];
    if (!top || !below) return this.host.toast("There's no layer below to merge into.");
    if (below.kind !== "pixel") return this.host.toast("Merge onto a pixel layer: the layer below is an adjustment layer.");
    if (!below.visible) return this.host.toast("The layer below is hidden.");
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const before = [...this.doc.layers], active = this.activeIndex;
    const merged = this.merged(top.visible ? [{ ...below, opacity: 1, blend: "normal" }, top] : [{ ...below, opacity: 1, blend: "normal" }], below.name);
    merged.opacity = below.opacity;
    merged.blend = below.blend;
    this.doc.layers.splice(this.activeIndex - 1, 2, merged);
    this.activeIndex--;
    this.recordLayers("Merge Down", "phMerge", before, active);
    this.engine.invalidate();
    this.refreshAll();
  }

  private mergeVisible() {
    const visible = this.doc.layers.filter((l) => l.visible);
    if (visible.length < 2) return;
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const before = [...this.doc.layers], active = this.activeIndex;
    const merged = this.merged(visible, "Merged");
    const at = this.doc.layers.indexOf(visible[visible.length - 1]);
    const keep = this.doc.layers.filter((l, i) => !l.visible && i > at);
    this.doc.layers = [...this.doc.layers.filter((l, i) => !l.visible && i < at), merged, ...keep];
    this.activeIndex = this.doc.layers.indexOf(merged);
    this.recordLayers("Merge Visible", "phMerge", before, active);
    this.engine.invalidate();
    this.refreshAll();
  }

  private flatten() {
    if (this.doc.layers.length === 1 && this.doc.layers[0].kind === "pixel" && this.doc.layers[0].opacity === 1) return;
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const before = [...this.doc.layers], active = this.activeIndex;
    this.doc.layers = [this.merged(this.doc.layers.filter((l) => l.visible), "Background")];
    this.activeIndex = 0;
    this.recordLayers("Flatten Image", "phLayers", before, active);
    this.engine.invalidate();
    this.refreshAll();
  }

  private arrange(delta: number) {
    const from = this.activeIndex, to = from + delta;
    if (!this.layer || to < 0 || to >= this.doc.layers.length) return;
    this.moveLayerTo(from, to);
  }

  private moveLayerTo(from: number, to: number) {
    if (from === to) return;
    const before = [...this.doc.layers], active = this.activeIndex;
    const [layer] = this.doc.layers.splice(from, 1);
    this.doc.layers.splice(to, 0, layer);
    this.activeIndex = to;
    this.recordLayers("Layer Order", "phLayers", before, active);
    this.engine.invalidate();
    this.refreshAll();
  }

  private setLayerProp<K extends "opacity" | "blend" | "visible" | "name">(layer: Layer, key: K, value: Layer[K], label: string, record = true) {
    const old = layer[key];
    if (old === value) return;
    layer[key] = value;
    this.engine.invalidate();
    if (record) this.recordChange(label, "phLayers", (after) => (layer[key] = after ? value : old));
    this.refreshAll();
  }

  // ---- whole-picture changes

  private transformDoc(op: Transform, record = true) {
    const W = this.doc.width, H = this.doc.height;
    for (const layer of this.doc.layers) {
      if (layer.kind !== "pixel") continue;
      const { x, y, width: w, height: hgt } = layer;
      const tex = this.engine.transformTexture(layer.tex, w, hgt, op);
      this.engine.deleteTexture(layer.tex);
      layer.tex = tex;
      const place: Record<Transform, [number, number, number, number]> = {
        rotateRight: [H - y - hgt, x, hgt, w],
        rotateLeft: [y, W - x - w, hgt, w],
        rotate180: [W - x - w, H - y - hgt, w, hgt],
        flipH: [W - x - w, y, w, hgt],
        flipV: [x, H - y - hgt, w, hgt],
      };
      [layer.x, layer.y, layer.width, layer.height] = place[op];
      this.versions.set(layer.id, (this.versions.get(layer.id) ?? 0) + 1);
    }
    if (op === "rotateLeft" || op === "rotateRight") this.setDocSize(H, W);
    this.engine.invalidate();
    if (record) {
      const inverse: Transform = op === "rotateLeft" ? "rotateRight" : op === "rotateRight" ? "rotateLeft" : op;
      const labels: Record<Transform, string> = { rotateRight: "Rotate 90° Clockwise", rotateLeft: "Rotate 90° Counter Clockwise", rotate180: "Rotate 180°", flipH: "Flip Canvas Horizontal", flipV: "Flip Canvas Vertical" };
      this.history.push({ label: labels[op], icon: op.startsWith("flip") ? "phFlipH" : "rotateRight", bytes: 0, undo: () => this.transformDoc(inverse, false), redo: () => this.transformDoc(op, false) });
    }
    this.crop = null;
    this.refreshAll();
    this.fit();
  }

  /** Crops the canvas to `rect` (document pixels); layers keep the pixels outside it. */
  private applyCrop(rect: Rect) {
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)) };
    const old = { w: this.doc.width, h: this.doc.height };
    const shift = (dx: number, dy: number, w: number, hgt: number) => {
      for (const layer of this.doc.layers) {
        if (layer.kind !== "pixel") continue;
        layer.x += dx;
        layer.y += dy;
      }
      this.setDocSize(w, hgt);
      this.engine.invalidate();
      this.refreshAll();
      this.fit();
    };
    shift(-r.x, -r.y, r.w, r.h);
    this.history.push({ label: "Crop", icon: "phCrop", bytes: 0, undo: () => shift(r.x, r.y, old.w, old.h), redo: () => shift(-r.x, -r.y, r.w, r.h) });
    this.crop = null;
    this.drawOptions();
  }

  private async imageSize() {
    const size = await askImageSize(this.doc.width, this.doc.height, this.engine.gpu.maxTexture);
    if (!size || (size.width === this.doc.width && size.height === this.doc.height)) return;
    const kx = size.width / this.doc.width, ky = size.height / this.doc.height;
    const extra = this.doc.layers.reduce((n, l) => n + (l.kind === "pixel" ? Math.ceil(l.width * kx) * Math.ceil(l.height * ky) * 4 : 0), 0);
    if (!this.fits(extra)) return;
    const old = this.doc.layers.filter((l): l is PixelLayer => l.kind === "pixel").map((l) => ({ layer: l, tex: l.tex, x: l.x, y: l.y, w: l.width, h: l.height }));
    const next = old.map((o) => {
      const w = Math.max(1, Math.round(o.w * kx)), hgt = Math.max(1, Math.round(o.h * ky));
      const target = this.engine.scaleTexture(o.tex, o.w, o.h, { x: 0, y: 0, w: o.w, h: o.h }, w, hgt);
      this.engine.releaseTarget(target);
      return { layer: o.layer, tex: target.tex, x: Math.round(o.x * kx), y: Math.round(o.y * ky), w, h: hgt };
    });
    const oldSize = { w: this.doc.width, h: this.doc.height };
    const put = (set: typeof old, w: number, hgt: number) => {
      for (const s of set) Object.assign(s.layer, { tex: s.tex, x: s.x, y: s.y, width: s.w, height: s.h });
      for (const s of set) this.versions.set(s.layer.id, (this.versions.get(s.layer.id) ?? 0) + 1);
      this.setDocSize(w, hgt);
      this.engine.invalidate();
      this.refreshAll();
      this.fit();
    };
    put(next, size.width, size.height);
    this.history.push({
      label: "Image Size",
      icon: "phCanvas",
      bytes: old.reduce((n, o) => n + o.w * o.h * 4, 0) + next.reduce((n, o) => n + o.w * o.h * 4, 0),
      undo: () => put(old, oldSize.w, oldSize.h),
      redo: () => put(next, size.width, size.height),
      drop: (applied) => {
        for (const s of applied ? old : next) this.engine.deleteTexture(s.tex);
      },
    });
  }

  /** Fills the layer with a colour (Alt+Backspace foreground, Ctrl+Backspace background). */
  private fillLayer(hex: string | null, label: string) {
    const layer = this.pixelTarget;
    if (!layer) return this.host.toast("Choose a pixel layer to fill.");
    const rect = { x: 0, y: 0, w: layer.width, h: layer.height };
    const before = this.engine.readTexture(layer.tex, rect);
    const pixels = new Uint8Array(before.length);
    if (hex) {
      const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
      for (let i = 0; i < pixels.length; i += 4) (pixels[i] = r), (pixels[i + 1] = g), (pixels[i + 2] = b), (pixels[i + 3] = 255);
    }
    this.engine.writeTexture(layer.tex, rect, pixels);
    this.recordPixels(label, hex ? "bucket" : "eraser", layer, rect, before);
    this.touched(layer);
  }

  /** Image ▸ Auto Tone: an adjustment layer with Auto's settings for the whole picture. */
  private autoTone() {
    const k = 256 / Math.max(this.doc.width, this.doc.height);
    const w = Math.max(1, Math.round(this.doc.width * k)), hgt = Math.max(1, Math.round(this.doc.height * k));
    this.activeIndex = this.doc.layers.length - 1;
    this.newAdjustLayer(autoAdjust(this.engine.compositeThumbnail(this.doc, w, hgt), DEFAULT_ADJUST), "Auto Tone");
  }

  // ---- saving

  async save(as = false): Promise<boolean> {
    if (this.busy) return false;
    let path = as ? null : this.filePath;
    if (!path) path = await this.askSavePath();
    if (!path) return false;
    if (path === this.sourcePicture) {
      const answer = await ask({
        title: `Replace “${basename(path)}”?`,
        text: "The original picture will be overwritten with this one, its layers merged. This can't be undone.",
        icon: "save",
        choices: [{ id: "cancel", label: "Cancel" }, { id: "replace", label: "Replace the Original", primary: true }],
        cancel: "cancel",
      });
      if (answer !== "replace") return false;
    }
    const ext = extensionOf(path);
    try {
      if (ext === "coreimage") await this.saveProject(path);
      else await this.savePicture(path, formatFor(path), this.settings.export.quality);
    } catch (err) {
      this.host.toast(`Couldn’t save: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.filePath = path;
    this.history.markSaved();
    this.host.remember(path);
    this.host.changed();
    return true;
  }

  private async askSavePath(): Promise<string | null> {
    const folder = this.sourcePicture ? dirname(this.sourcePicture) : this.filePath ? dirname(this.filePath) : null;
    const name = `${stripExtension(this.title())}.coreimage`;
    const path = await saveDialog({
      title: "Save As",
      defaultPath: folder ? `${folder}/${name}` : name,
      filters: [{ name: "Photo project (layers kept)", extensions: ["coreimage"] }, ...SAVE_FORMATS.map((f) => ({ name: `${f.name} (layers merged)`, extensions: [f.extension] }))],
    });
    if (!path) return null;
    const ext = extensionOf(path);
    return ext === "coreimage" || SAVE_FORMATS.some((f) => f.extension === ext || (f.id === "jpeg" && ext === "jpeg") || (f.id === "tiff" && ext === "tif")) ? path : `${path}.coreimage`;
  }

  private async withBusy<T>(text: string, work: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.busyEl.hidden = false;
    this.busyEl.querySelector(".ph-busy-text")!.textContent = text;
    // Let the spinner show before the GPU and the bridge get busy.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      return await work();
    } finally {
      this.busy = false;
      this.busyEl.hidden = true;
    }
  }

  private async saveProject(path: string) {
    await this.withBusy("Saving…", async () => {
      const layers: ProjectLayer[] = [];
      const json: ProjectJson = {
        app: "CorePro Photo",
        version: 1,
        width: this.doc.width,
        height: this.doc.height,
        active: this.activeIndex,
        layers: this.doc.layers.map((l): ProjectLayerJson => {
          const base = { name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend };
          if (l.kind === "adjust") return { ...base, kind: "adjust", adjust: { ...l.adjust } };
          layers.push({ width: l.width, height: l.height, rgba: this.engine.readTexture(l.tex, { x: 0, y: 0, w: l.width, h: l.height }) });
          return { ...base, kind: "pixel", x: l.x, y: l.y, width: l.width, height: l.height, data: layers.length - 1 };
        }),
      };
      const k = Math.min(1, PREVIEW_SIDE / Math.max(this.doc.width, this.doc.height));
      const pw = Math.max(1, Math.round(this.doc.width * k)), ph = Math.max(1, Math.round(this.doc.height * k));
      const preview = { width: pw, height: ph, rgba: this.engine.compositeThumbnail(this.doc, pw, ph, true) };
      await photoApi.saveProject(path, { json: JSON.stringify(json), layers, preview, icc: this.icc });
    });
    this.host.toast(`Saved “${basename(path)}”`);
  }

  private async savePicture(path: string, format: SaveFormat, quality: number) {
    await this.withBusy("Saving…", async () => {
      const rgba = this.engine.flatten(this.doc, !hasAlpha(format));
      await photoApi.encode(path, { rgba, width: this.doc.width, height: this.doc.height, format, quality, icc: this.icc, exif: this.exif });
    });
    this.host.toast(`Saved “${basename(path)}”${this.doc.layers.length > 1 ? " with its layers merged" : ""}`);
  }

  private async exportAs() {
    const choice = await askExport(this.settings.export);
    if (!choice) return;
    this.settings.export = choice;
    this.saveSettings();
    const ext = SAVE_FORMATS.find((f) => f.id === choice.format)!.extension;
    const folder = this.sourcePicture ? dirname(this.sourcePicture) : this.filePath ? dirname(this.filePath) : null;
    const name = `${stripExtension(this.title())}.${ext}`;
    let path = await saveDialog({ title: "Export As", defaultPath: folder ? `${folder}/${name}` : name, filters: [{ name: SAVE_FORMATS.find((f) => f.id === choice.format)!.name, extensions: [ext] }] });
    if (!path) return;
    if (!extensionOf(path)) path = `${path}.${ext}`;
    if (path === this.sourcePicture) {
      const answer = await ask({
        title: `Replace “${basename(path)}”?`,
        text: "The original picture will be overwritten. This can't be undone.",
        icon: "save",
        choices: [{ id: "cancel", label: "Cancel" }, { id: "replace", label: "Replace the Original", primary: true }],
        cancel: "cancel",
      });
      if (answer !== "replace") return;
    }
    try {
      await this.savePicture(path, choice.format, choice.quality);
    } catch (err) {
      this.host.toast(`Couldn’t export: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- menus

  private fileMenu(): MenuItem[] {
    return [
      { label: "New Canvas…", icon: "phCanvas", action: () => this.host.shell.open({ kind: "studio", app: "photo" }) },
      { label: "Open…", icon: "open", shortcut: "Ctrl+O", action: () => void this.openOther() },
      "separator",
      { label: "Save", icon: "save", shortcut: "Ctrl+S", action: () => void this.save() },
      { label: "Save As…", icon: "saveAs", shortcut: "Ctrl+Shift+S", action: () => void this.save(true) },
      // No shortcut: Studio takes every Ctrl+W and Ctrl+S, so Photoshop's Ctrl+Alt+Shift+W would close.
      { label: "Export As…", icon: "phExport", action: () => void this.exportAs() },
      "separator",
      { label: "Close", icon: "close", shortcut: "Ctrl+W", action: () => void this.close() },
    ];
  }

  private async openOther() {
    const { open } = await import("../../../shared/dialog");
    const { PHOTO_EXTENSIONS } = await import("../app");
    const picked = await open({ title: "Edit a Photo", multiple: true, filters: [{ name: "Pictures", extensions: PHOTO_EXTENSIONS }] });
    for (const path of picked ?? []) this.host.shell.open({ kind: "studio", app: "photo", path });
  }

  private async close() {
    if (this.dirty()) {
      const answer = await ask({
        title: `Save changes to “${this.title()}”?`,
        text: "Your changes will be lost if you don't save them.",
        icon: "save",
        choices: [{ id: "discard", label: "Don't Save", aside: true }, { id: "cancel", label: "Cancel" }, { id: "save", label: "Save", primary: true }],
        cancel: "cancel",
      });
      if (answer === "cancel" || (answer === "save" && !(await this.save()))) return;
    }
    this.host.close();
  }

  private editMenu(): MenuItem[] {
    return [
      { label: this.history.canUndo ? `Undo ${this.history.undoLabel}` : "Undo", icon: "undo", shortcut: "Ctrl+Z", disabled: !this.history.canUndo, action: () => this.history.undo() },
      { label: this.history.canRedo ? `Redo ${this.history.redoLabel}` : "Redo", icon: "redo", shortcut: "Ctrl+Shift+Z", disabled: !this.history.canRedo, action: () => this.history.redo() },
      "separator",
      { label: "Fill with Foreground", icon: "bucket", shortcut: "Alt+Backspace", disabled: !this.pixelTarget, action: () => this.fillLayer(this.settings.fg, "Fill") },
      { label: "Fill with Background", icon: "bucket", shortcut: "Ctrl+Backspace", disabled: !this.pixelTarget, action: () => this.fillLayer(this.settings.bg, "Fill") },
      { label: "Clear Layer", icon: "eraser", disabled: !this.pixelTarget, action: () => this.fillLayer(null, "Clear") },
    ];
  }

  private imageMenu(): MenuItem[] {
    return [
      { label: "Auto Tone", icon: "sparkles", action: () => this.autoTone() },
      { label: "Image Size…", icon: "phCanvas", action: () => void this.imageSize() },
      { label: "Crop", icon: "phCrop", shortcut: "C", action: () => this.selectTool("crop") },
      "separator",
      { label: "Rotate 180°", icon: "rotateRight", action: () => this.transformDoc("rotate180") },
      { label: "Rotate 90° Clockwise", icon: "rotateRight", action: () => this.transformDoc("rotateRight") },
      { label: "Rotate 90° Counter Clockwise", icon: "rotateLeft", action: () => this.transformDoc("rotateLeft") },
      { label: "Flip Canvas Horizontal", icon: "phFlipH", action: () => this.transformDoc("flipH") },
      { label: "Flip Canvas Vertical", icon: "phFlipV", action: () => this.transformDoc("flipV") },
    ];
  }

  private layerMenu(): MenuItem[] {
    const layer = this.layer;
    return [
      { label: "New Layer", icon: "phNewLayer", shortcut: "Ctrl+Shift+N", action: () => this.newLayer() },
      { label: "New Adjustment Layer", icon: "phAdjustLayer", action: () => this.newAdjustLayer() },
      { label: "Duplicate Layer", icon: "copy", shortcut: "Ctrl+J", disabled: !layer, action: () => this.duplicateLayer() },
      { label: "Delete Layer", icon: "trash", disabled: !layer || this.doc.layers.length < 2, action: () => this.deleteLayer() },
      { label: "Rename Layer…", icon: "pencil", disabled: !layer, action: () => this.renameLayer() },
      "separator",
      { label: "Bring Forward", icon: "arrowUp", shortcut: "Ctrl+]", disabled: this.activeIndex >= this.doc.layers.length - 1, action: () => this.arrange(1) },
      { label: "Send Backward", icon: "chevronDown", shortcut: "Ctrl+[", disabled: this.activeIndex <= 0, action: () => this.arrange(-1) },
      "separator",
      { label: "Merge Down", icon: "phMerge", shortcut: "Ctrl+E", disabled: this.activeIndex <= 0, action: () => this.mergeDown() },
      { label: "Merge Visible", icon: "phMerge", shortcut: "Ctrl+Shift+E", action: () => this.mergeVisible() },
      { label: "Flatten Image", icon: "phLayers", action: () => this.flatten() },
    ];
  }

  private viewMenu(): MenuItem[] {
    return [
      { label: "Zoom In", icon: "zoomIn", shortcut: "Ctrl+=", action: () => this.zoomStep(1) },
      { label: "Zoom Out", icon: "zoomOut", shortcut: "Ctrl+-", action: () => this.zoomStep(-1) },
      { label: "Fit on Screen", icon: "fit", shortcut: "Ctrl+0", action: () => this.fit(true) },
      { label: "100%", icon: "zoomFit", shortcut: "Ctrl+1", action: () => this.zoomTo(1) },
      "separator",
      { label: describeGpu(this.engine.gpu), icon: "info", disabled: true, action: () => {} },
    ];
  }

  // ---- tools

  private selectTool(tool: Tool) {
    if (this.settings.tool !== tool) {
      this.settings.tool = tool;
      this.saveSettings();
    }
    if (tool === "crop" && !this.crop) this.crop = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    if (tool !== "crop") this.crop = null;
    this.drawTools();
    this.drawOptions();
    this.updateCursor();
    this.render();
  }

  private saveSettings() {
    clearTimeout(this.settingsTimer);
    this.settingsTimer = window.setTimeout(() => {
      this.host.shell.config.studio.apps.photo = this.settings;
      this.host.shell.saveConfig();
    }, 400);
  }

  private drawTools() {
    const tool = this.settings.tool;
    const buttons = TOOL_ORDER.map((t) => {
      const info = TOOL_INFO[t];
      return h("button", { class: `ph-tool${t === tool ? " active" : ""}`, type: "button", title: `${info.label} (${info.key})`, "aria-label": info.label, onclick: () => this.selectTool(t) }, icon(info.icon, 18));
    });
    const colorInput = (which: "fg" | "bg") => {
      const input = h("input", { type: "color", class: "ph-color-input", value: this.settings[which], "aria-label": which === "fg" ? "Foreground colour" : "Background colour" });
      input.addEventListener("input", () => {
        this.settings[which] = input.value;
        this.saveSettings();
        this.drawTools();
      });
      return input;
    };
    const swatch = (which: "fg" | "bg") => {
      const input = colorInput(which);
      return h("label", { class: `ph-swatch ${which}`, title: which === "fg" ? "Foreground colour" : "Background colour", style: { background: this.settings[which] } }, input);
    };
    this.toolsBar.replaceChildren(...buttons, h("div", { class: "ph-tools-sep" }),
      h("div", { class: "ph-colors" }, swatch("bg"), swatch("fg"),
        h("button", { class: "ph-mini", type: "button", title: "Swap colours (X)", "aria-label": "Swap colours", onclick: () => this.swapColors() }, icon("phSwap", 12)),
        h("button", { class: "ph-mini default", type: "button", title: "Black and white (D)", "aria-label": "Default colours", onclick: () => this.defaultColors() })));
  }

  private swapColors() {
    [this.settings.fg, this.settings.bg] = [this.settings.bg, this.settings.fg];
    this.saveSettings();
    this.drawTools();
  }

  private defaultColors() {
    this.settings.fg = "#000000";
    this.settings.bg = "#ffffff";
    this.saveSettings();
    this.drawTools();
  }

  /** A labelled slider with a number box, for the options bar. */
  private option(label: string, value: number, min: number, max: number, unit: string, set: (v: number) => void) {
    const range = h("input", { type: "range", class: "ph-opt-range", min, max, step: 1, value, "aria-label": label });
    const box = h("input", { type: "number", class: "ph-opt-number", min, max, step: 1, value: Math.round(value), "aria-label": label });
    range.addEventListener("input", () => {
      box.value = range.value;
      set(Number(range.value));
    });
    box.addEventListener("change", () => {
      const v = clamp(Math.round(Number(box.value) || min), min, max);
      box.value = range.value = String(v);
      set(v);
    });
    return h("label", { class: "ph-opt" }, h("span", null, label), range, box, unit ? h("span", { class: "ph-opt-unit" }, unit) : null);
  }

  private check(label: string, value: boolean, set: (v: boolean) => void) {
    const input = h("input", { type: "checkbox", checked: value });
    input.addEventListener("change", () => set(input.checked));
    return h("label", { class: "ph-opt ph-opt-check" }, input, label);
  }

  private drawOptions() {
    const s = this.settings;
    const tool = s.tool;
    const info = TOOL_INFO[tool];
    const parts: (HTMLElement | null)[] = [h("span", { class: "ph-opt-tool" }, icon(info.icon, 16), info.label)];
    const save = () => this.saveSettings();
    if (tool === "brush" || tool === "eraser") {
      const b = s[tool];
      parts.push(
        this.option("Size", b.size, 1, 1000, "px", (v) => ((b.size = v), save(), this.drawOverlay())),
        this.option("Hardness", b.hardness, 0, 100, "%", (v) => ((b.hardness = v), save())),
        this.option("Opacity", b.opacity, 1, 100, "%", (v) => ((b.opacity = v), save())),
        this.option("Flow", b.flow, 1, 100, "%", (v) => ((b.flow = v), save())));
    } else if (tool === "bucket") {
      parts.push(
        this.option("Opacity", s.bucket.opacity, 1, 100, "%", (v) => ((s.bucket.opacity = v), save())),
        this.option("Tolerance", s.bucket.tolerance, 0, 255, "", (v) => ((s.bucket.tolerance = v), save())),
        this.check("Contiguous", s.bucket.contiguous, (v) => ((s.bucket.contiguous = v), save())),
        this.check("All layers", s.bucket.allLayers, (v) => ((s.bucket.allLayers = v), save())));
    } else if (tool === "gradient") {
      const kind = h("div", { class: "segmented" }, ...([false, true] as const).map((radial) =>
        h("button", { type: "button", class: s.gradient.radial === radial ? "active" : "", onclick: () => ((s.gradient.radial = radial), save(), this.drawOptions()) }, radial ? "Radial" : "Linear")));
      parts.push(kind,
        this.option("Opacity", s.gradient.opacity, 1, 100, "%", (v) => ((s.gradient.opacity = v), save())),
        this.check("Foreground to transparent", s.gradient.transparent, (v) => ((s.gradient.transparent = v), save())));
    } else if (tool === "eyedropper") {
      parts.push(this.check("Sample all layers", s.eyedropper.allLayers, (v) => ((s.eyedropper.allLayers = v), save())));
    } else if (tool === "crop") {
      const ratio = h("select", { class: "ph-select small" }, ...CROP_RATIOS.map((r) => h("option", { value: r.id }, r.label)));
      ratio.value = s.crop.ratio;
      ratio.addEventListener("change", () => {
        s.crop.ratio = ratio.value;
        save();
        const r = this.cropRatio();
        if (r && this.crop) this.crop = this.fitCropRatio(this.crop, r);
        this.render();
      });
      const size = this.crop ? `${Math.round(this.crop.w)} × ${Math.round(this.crop.h)} px` : "";
      parts.push(ratio, h("span", { class: "ph-opt-note" }, size),
        h("span", { class: "spacer" }),
        h("button", { class: "btn small", type: "button", onclick: () => this.cancelCrop() }, icon("close", 13), "Cancel"),
        h("button", { class: "btn small primary", type: "button", onclick: () => this.crop && this.applyCrop(this.crop) }, icon("check", 13), "Crop"));
    } else if (tool === "move") {
      const layer = this.pixelTarget;
      parts.push(h("span", { class: "ph-opt-note" }, layer ? `Drag to move “${layer.name}”. Arrow keys nudge by 1 px (Shift: 10).` : "Choose a pixel layer to move."));
    } else if (tool === "zoom" || tool === "hand") {
      parts.push(
        h("button", { class: "btn small", type: "button", onclick: () => this.zoomTo(1) }, "100%"),
        h("button", { class: "btn small", type: "button", onclick: () => this.fit(true) }, "Fit Screen"),
        h("span", { class: "ph-opt-note" }, tool === "zoom" ? "Click to zoom in, Alt+click to zoom out." : "Drag to look around. Space does this with any tool."));
    }
    this.optionsBar.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  }

  private cancelCrop() {
    this.crop = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    this.drawOptions();
    this.render();
  }

  private cropRatio(): number | null {
    return CROP_RATIOS.find((r) => r.id === this.settings.crop.ratio)?.ratio ?? null;
  }

  private fitCropRatio(rect: Rect, ratio: number): Rect {
    let w = rect.w, hgt = w / ratio;
    if (hgt > rect.h) (hgt = rect.h), (w = hgt * ratio);
    w = Math.min(w, this.doc.width);
    hgt = Math.min(w / ratio, this.doc.height);
    w = hgt * ratio;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    return { x: clamp(cx - w / 2, 0, this.doc.width - w), y: clamp(cy - hgt / 2, 0, this.doc.height - hgt), w, h: hgt };
  }

  // ---- panels

  private refreshAll() {
    this.drawLayers();
    this.drawProps();
    this.drawHistory();
    this.drawStatus();
    this.drawTitle();
    if (this.settings.tool === "move" || this.settings.tool === "crop") this.drawOptions();
    this.render();
  }

  private historyChanged() {
    this.undoButton.disabled = !this.history.canUndo;
    this.redoButton.disabled = !this.history.canRedo;
    this.undoButton.title = this.history.canUndo ? `Undo ${this.history.undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)";
    this.redoButton.title = this.history.canRedo ? `Redo ${this.history.redoLabel} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)";
    this.drawHistory();
    this.drawTitle();
    this.drawStatus();
    this.host.changed();
  }

  private drawTitle() {
    this.titleName.textContent = this.title();
    this.titleState.textContent = `${Math.round(this.zoom * 100) / 100 === 1 ? "100" : Math.round(this.zoom * 1000) / 10}% · ${this.layer?.name ?? ""}${this.dirty() ? " · Edited" : ""}`;
  }

  private drawStatus() {
    this.statusZoom.textContent = `${formatZoom(this.zoom)}`;
    this.statusSize.textContent = `${this.doc.width} × ${this.doc.height} px`;
    this.statusMemory.textContent = `Memory ${sizeText(this.memoryUse())} of ${sizeText(BUDGET)}`;
  }

  private drawHistory() {
    const steps = this.history.steps;
    const position = this.history.position;
    this.historyBody.replaceChildren(...steps.map((step, i) =>
      h("button", { class: `ph-history-row${i === position ? " current" : ""}${i > position ? " undone" : ""}`, type: "button", onclick: () => this.history.goTo(i) },
        icon(step.icon, 14), h("span", null, step.label))));
    this.historyBody.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  private drawLayers() {
    const layer = this.layer;
    // Blend mode and opacity of the chosen layer.
    const blend = h("select", { class: "ph-select small", "aria-label": "Blend mode", disabled: !layer },
      ...BLEND_GROUPS.flatMap((group, gi) => [
        ...(gi ? [h("option", { disabled: true }, "──────────")] : []),
        ...group.map((m) => h("option", { value: m.id }, m.label)),
      ]));
    if (layer) blend.value = layer.blend;
    blend.addEventListener("change", () => layer && this.setLayerProp(layer, "blend", blend.value as Layer["blend"], "Blending Change"));
    const opacity = h("input", { type: "range", class: "ph-opt-range", min: 0, max: 100, step: 1, value: Math.round((layer?.opacity ?? 1) * 100), "aria-label": "Opacity", disabled: !layer });
    const opacityValue = h("span", { class: "ph-opt-unit" }, `${Math.round((layer?.opacity ?? 1) * 100)}%`);
    let opacityStart = layer?.opacity ?? 1;
    opacity.addEventListener("pointerdown", () => (opacityStart = layer?.opacity ?? 1));
    opacity.addEventListener("input", () => {
      if (!layer) return;
      layer.opacity = Number(opacity.value) / 100;
      opacityValue.textContent = `${opacity.value}%`;
      this.engine.invalidate();
      this.render();
    });
    opacity.addEventListener("change", () => {
      if (!layer) return;
      const value = Number(opacity.value) / 100;
      layer.opacity = opacityStart;
      this.setLayerProp(layer, "opacity", value, "Opacity Change");
    });
    this.layerControls.replaceChildren(blend, h("label", { class: "ph-opt" }, h("span", null, "Opacity"), opacity, opacityValue));

    const rows = this.doc.layers.map((l, index) => {
      const eye = h("button", { class: `ph-eye${l.visible ? "" : " off"}`, type: "button", title: l.visible ? "Hide" : "Show", "aria-label": l.visible ? "Hide layer" : "Show layer" }, icon(l.visible ? "eye" : "eyeOff", 14));
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setLayerProp(l, "visible", !l.visible, l.visible ? "Hide Layer" : "Show Layer");
      });
      const name = h("span", { class: "ph-layer-name" }, l.name);
      const row = h("div", { class: `ph-layer${index === this.activeIndex ? " active" : ""}${l.visible ? "" : " hidden-layer"}`, "data-index": String(index), role: "button", tabindex: "-1" },
        eye, this.thumbFor(l), name, l.blend !== "normal" || l.opacity < 1 ? h("span", { class: "ph-layer-meta" }, `${l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : ""}`) : null);
      row.addEventListener("dblclick", () => this.renameLayer(l, name));
      row.addEventListener("pointerdown", (e) => this.layerPointerDown(e, index, row));
      return row;
    });
    // Top layer first, as in Photoshop.
    this.layersBody.replaceChildren(...rows.reverse());
  }

  /** Clicking a row picks the layer; dragging it moves the layer up or down the list. */
  private layerPointerDown(e: PointerEvent, index: number, row: HTMLElement) {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".ph-eye, input")) return;
    const startY = e.clientY;
    let dragging = false;
    const rows = [...this.layersBody.children] as HTMLElement[];
    const targetIndex = (y: number) => {
      // Rows are top layer first.
      let slot = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          slot = i;
          break;
        }
      }
      return rows.length - 1 - slot;
    };
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) > 4) {
        dragging = true;
        row.classList.add("dragging");
      }
      if (!dragging) return;
      const to = targetIndex(ev.clientY);
      for (const r of rows) r.classList.toggle("drop-target", Number(r.dataset.index) === to && to !== index);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragging) this.moveLayerTo(index, targetIndex(ev.clientY));
      else if (index !== this.activeIndex) {
        this.activeIndex = index;
        this.refreshAll();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private renameLayer(layer: Layer | undefined = this.layer, nameEl?: HTMLElement) {
    if (!layer) return;
    const target = nameEl ?? (this.layersBody.querySelector(`.ph-layer[data-index="${this.doc.layers.indexOf(layer)}"] .ph-layer-name`) as HTMLElement | null);
    if (!target) return;
    const input = h("input", { class: "ph-layer-rename", value: layer.name, "aria-label": "Layer name" });
    target.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim().slice(0, 200);
      if (keep && value && value !== layer.name) this.setLayerProp(layer, "name", value, "Rename Layer");
      else this.drawLayers();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  private thumbFor(layer: Layer): HTMLElement {
    if (layer.kind === "adjust") return h("span", { class: "ph-thumb adjust" }, icon("phAdjustLayer", 16));
    const version = this.versions.get(layer.id) ?? 0;
    let cached = this.thumbs.get(layer.id);
    if (!cached) {
      cached = { version: -1, canvas: h("canvas", { class: "ph-thumb" }) };
      this.thumbs.set(layer.id, cached);
    }
    if (cached.version !== version) this.scheduleThumbs();
    return cached.canvas;
  }

  private scheduleThumbs() {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.drawThumbs(), 120);
  }

  private drawThumbs() {
    const dpr = window.devicePixelRatio || 1;
    const box = Math.round(34 * dpr);
    for (const layer of this.doc.layers) {
      if (layer.kind !== "pixel") continue;
      const cached = this.thumbs.get(layer.id);
      const version = this.versions.get(layer.id) ?? 0;
      if (!cached || cached.version === version) continue;
      // The layer as it sits in the document, letterboxed in the box.
      const k = box / Math.max(this.doc.width, this.doc.height);
      const w = Math.max(1, Math.round(layer.width * k)), hgt = Math.max(1, Math.round(layer.height * k));
      const pixels = this.engine.thumbnail(layer.tex, layer.width, layer.height, w, hgt);
      const c = cached.canvas;
      c.width = c.height = box;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, box, box);
      const dw = Math.round(this.doc.width * k), dh = Math.round(this.doc.height * k);
      const ox = Math.round((box - dw) / 2), oy = Math.round((box - dh) / 2);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(ox, oy, dw, dh);
      ctx.fillStyle = "#cccccc";
      const cell = Math.max(2, Math.round(4 * dpr));
      for (let y = 0; y < dh; y += cell) for (let x = (y / cell) % 2 ? cell : 0; x < dw; x += cell * 2) ctx.fillRect(ox + x, oy + y, Math.min(cell, dw - x), Math.min(cell, dh - y));
      const img = new ImageData(new Uint8ClampedArray(pixels), w, hgt);
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = hgt;
      tmp.getContext("2d")!.putImageData(img, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, dw, dh);
      ctx.clip();
      ctx.drawImage(tmp, ox + Math.round(layer.x * k), oy + Math.round(layer.y * k));
      ctx.restore();
      cached.version = version;
    }
  }

  /** The Adjustments panel: the chosen adjustment layer's sliders. */
  private drawProps() {
    const layer = this.layer;
    if (layer?.kind !== "adjust") {
      this.propsBody.replaceChildren(
        h("p", { class: "ph-empty" }, "Pick an adjustment layer to change its light and colour, or add one."),
        h("div", { class: "ph-props-actions" },
          h("button", { class: "btn small", type: "button", onclick: () => this.newAdjustLayer() }, icon("phAdjustLayer", 13), "Add Adjustments"),
          h("button", { class: "btn small", type: "button", onclick: () => this.autoTone() }, icon("sparkles", 13), "Auto Tone")));
      return;
    }
    let before: Adjustments = { ...layer.adjust };
    const commit = (label: string) => {
      const old = before, now = { ...layer.adjust };
      before = now;
      if (JSON.stringify(old) === JSON.stringify(now)) return;
      this.recordChange(label, "phAdjustLayer", (after) => (layer.adjust = { ...(after ? now : old) }));
      this.drawStatus();
    };
    const live = () => {
      this.engine.invalidate();
      this.render();
    };
    const slider = (spec: SliderSpec) => {
      const input = h("input", { type: "range", class: "ph-prop-range", min: spec.min, max: spec.max, step: spec.step, value: layer.adjust[spec.key], "aria-label": spec.label });
      const value = h("span", { class: "ph-prop-value" }, formatValue(spec, layer.adjust[spec.key]));
      const reset = spec.key === "lookAmount" ? 100 : 0;
      input.addEventListener("input", () => {
        layer.adjust[spec.key] = Number(input.value);
        value.textContent = formatValue(spec, layer.adjust[spec.key]);
        live();
      });
      input.addEventListener("change", () => commit(spec.label));
      input.addEventListener("dblclick", () => {
        layer.adjust[spec.key] = reset;
        input.value = String(reset);
        value.textContent = formatValue(spec, reset);
        live();
        commit(spec.label);
      });
      return h("label", { class: "ph-prop" }, h("span", null, spec.label), value, input);
    };
    const look = h("select", { class: "ph-select small", "aria-label": "Filter" }, ...FILTERS.map((f) => h("option", { value: f.id }, f.label)));
    look.value = layer.adjust.look;
    look.addEventListener("change", () => {
      layer.adjust.look = look.value as Adjustments["look"];
      live();
      commit("Filter");
    });
    const group = (title: string, specs: SliderSpec[]) => h("div", { class: "ph-prop-group" }, h("h4", null, title), ...specs.map(slider));
    this.propsBody.replaceChildren(
      group("Light", LIGHT_SLIDERS),
      group("Colour", COLOUR_SLIDERS),
      h("div", { class: "ph-prop-group" }, h("h4", null, "Filter"), look, slider({ key: "lookAmount", label: "Strength", min: 0, max: 100, step: 1 })),
      group("Effects", EFFECT_SLIDERS),
    );
  }

  private iconButton(glyph: IconName, title: string, run: () => void) {
    return h("button", { class: "icon-btn small", type: "button", title, "aria-label": title, onclick: run }, icon(glyph, 15));
  }

  // ---- view

  private get dpr() {
    return window.devicePixelRatio || 1;
  }

  private viewState() {
    return { scale: this.zoom, x: Math.round(this.canvas.width / 2 - this.cx * this.zoom), y: Math.round(this.canvas.height / 2 - this.cy * this.zoom) };
  }

  /** The document point under a pointer event. */
  private docPoint(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    const v = this.viewState();
    return { x: ((e.clientX - r.left) * this.dpr - v.x) / v.scale, y: ((e.clientY - r.top) * this.dpr - v.y) / v.scale };
  }

  fit(force = false) {
    if (force) this.fitted = true;
    const W = Math.max(1, this.stage.clientWidth * this.dpr), H = Math.max(1, this.stage.clientHeight * this.dpr);
    const m = 40 * this.dpr;
    const k = Math.min((W - 2 * m) / this.doc.width, (H - 2 * m) / this.doc.height);
    // Small pictures open at 100%; "Fit on Screen" enlarges them.
    this.zoom = Math.max(1 / 64, force ? k : Math.min(1, k));
    this.cx = this.doc.width / 2;
    this.cy = this.doc.height / 2;
    this.fitted = true;
    this.drawStatus();
    this.drawTitle();
    this.render();
  }

  private fitIfFitted() {
    if (this.fitted) this.fit();
    else this.render();
  }

  private zoomTo(zoom: number, at?: { clientX: number; clientY: number }) {
    const next = clamp(zoom, 1 / 64, 64);
    if (at) {
      const p = this.docPoint(at);
      const r = this.canvas.getBoundingClientRect();
      const dx = (at.clientX - r.left) * this.dpr - this.canvas.width / 2, dy = (at.clientY - r.top) * this.dpr - this.canvas.height / 2;
      this.cx = p.x - dx / next;
      this.cy = p.y - dy / next;
    }
    this.zoom = next;
    this.fitted = false;
    this.drawStatus();
    this.drawTitle();
    this.render();
  }

  private zoomStep(dir: 1 | -1, at?: { clientX: number; clientY: number }) {
    const next = dir > 0 ? ZOOMS.find((z) => z > this.zoom * 1.001) : [...ZOOMS].reverse().find((z) => z < this.zoom / 1.001);
    this.zoomTo(next ?? this.zoom, at);
  }

  private render() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.el.hidden || !this.el.isConnected) return;
      const W = Math.max(1, Math.round(this.stage.clientWidth * this.dpr)), H = Math.max(1, Math.round(this.stage.clientHeight * this.dpr));
      for (const c of [this.canvas, this.overlay]) {
        if (c.width !== W || c.height !== H) {
          c.width = W;
          c.height = H;
        }
      }
      if (this.engine.lost) return;
      this.engine.render(this.doc, this.viewState(), pasteboard(this.stage));
      this.drawOverlay();
    });
  }

  private drawOverlay() {
    const ctx = this.overlay.getContext("2d")!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const v = this.viewState();
    const d = this.dpr;
    // The canvas edge.
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(v.x - 0.5, v.y - 0.5, this.doc.width * v.scale + 1, this.doc.height * v.scale + 1);
    const tool = this.settings.tool;
    if (tool === "crop" && this.crop) {
      const c = this.crop;
      const x = v.x + c.x * v.scale, y = v.y + c.y * v.scale, w = c.w * v.scale, hgt = c.h * v.scale;
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, this.overlay.width, this.overlay.height);
      ctx.rect(x, y, w, hgt);
      ctx.fill("evenodd");
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.beginPath();
      for (const t of [1 / 3, 2 / 3]) {
        ctx.moveTo(x + w * t, y);
        ctx.lineTo(x + w * t, y + hgt);
        ctx.moveTo(x, y + hgt * t);
        ctx.lineTo(x + w, y + hgt * t);
      }
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5 * d;
      ctx.strokeRect(x, y, w, hgt);
      ctx.fillStyle = "#ffffff";
      const s = 7 * d;
      for (const [hx, hy] of [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + hgt / 2], [x + w, y + hgt], [x + w / 2, y + hgt], [x, y + hgt], [x, y + hgt / 2]]) ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
    }
    if ((tool === "brush" || tool === "eraser") && this.pointer.inside && !this.spaceHeld) {
      const r = (this.settings[tool].size / 2) * v.scale;
      const px = this.pointer.x * d, py = this.pointer.y * d;
      if (r >= 3 * d) {
        ctx.lineWidth = 1 * d;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
        ctx.beginPath();
        ctx.arc(px, py, r + 0.5 * d, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.5, r - 0.5 * d), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1 * d;
        ctx.beginPath();
        ctx.moveTo(px - 6 * d, py);
        ctx.lineTo(px + 6 * d, py);
        ctx.moveTo(px, py - 6 * d);
        ctx.lineTo(px, py + 6 * d);
        ctx.stroke();
      }
    }
    if (this.drag?.kind === "gradient" && this.gradientTo) {
      const layer = this.drag.layer;
      const ax = v.x + (this.drag.from[0] + layer.x) * v.scale, ay = v.y + (this.drag.from[1] + layer.y) * v.scale;
      const bx = v.x + (this.gradientTo[0] + layer.x) * v.scale, by = v.y + (this.gradientTo[1] + layer.y) * v.scale;
      ctx.lineWidth = 1.5 * d;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([4 * d, 3 * d]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private gradientTo: [number, number] | null = null;

  private updateCursor() {
    const tool = this.settings.tool;
    const cursor = this.drag?.kind === "pan" ? "grabbing"
      : this.spaceHeld || tool === "hand" ? "grab"
      : tool === "brush" || tool === "eraser" ? "none"
      : tool === "zoom" ? "zoom-in"
      : tool === "move" ? "move"
      : "crosshair";
    this.stage.style.cursor = cursor;
  }

  // ---- pointer

  private bindStage() {
    const stage = this.stage;
    stage.addEventListener("pointerdown", (e) => this.pointerDown(e));
    stage.addEventListener("pointermove", (e) => this.pointerMove(e));
    stage.addEventListener("pointerup", () => this.endDrag(true));
    stage.addEventListener("pointercancel", () => this.endDrag(false));
    stage.addEventListener("pointerleave", () => {
      this.pointer.inside = false;
      this.statusPointer.textContent = "";
      this.drawOverlay();
    });
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        // A wheel (or a pinch) zooms about the pointer, like the Gallery.
        this.zoomTo(this.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e);
      } else {
        this.cx += (e.deltaY / this.zoom) * this.dpr;
        this.fitted = false;
        this.render();
      }
    }, { passive: false });
    stage.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private pointerDown(e: PointerEvent) {
    if (this.busy || this.drag) return;
    this.stage.focus({ preventScroll: true });
    const tool = this.settings.tool;
    const p = this.docPoint(e);
    if (e.button === 1 || (e.button === 0 && (this.spaceHeld || tool === "hand"))) {
      this.drag = { kind: "pan", x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy };
    } else if (e.button !== 0) {
      return;
    } else if (tool === "zoom") {
      this.zoomStep(e.altKey ? -1 : 1, e);
      return;
    } else if (tool === "eyedropper" || ((tool === "brush" || tool === "gradient" || tool === "bucket") && e.altKey)) {
      this.pick(p);
      this.drag = { kind: "pick" };
    } else if (tool === "brush" || tool === "eraser") {
      const layer = this.paintableLayer();
      if (!layer) return;
      const brush = { ...this.settings[tool] };
      const color = hexToRgb(this.settings.fg);
      this.engine.beginPaint(this.doc, tool === "brush" ? { kind: "brush", layer, color, opacity: brush.opacity / 100 } : { kind: "erase", layer, opacity: brush.opacity / 100 }, brush.hardness / 100);
      const start = { x: p.x - layer.x, y: p.y - layer.y };
      this.drag = { kind: "paint", layer, last: start, rest: 0, brush, pen: e.pointerType === "pen" };
      this.engine.addDabs([this.dab(start.x, start.y, brush, e)]);
      this.render();
    } else if (tool === "gradient") {
      const layer = this.paintableLayer();
      if (!layer) return;
      const g = this.settings.gradient;
      const [r, gg, b] = hexToRgb(this.settings.fg);
      const end = g.transparent ? [r, gg, b, 0] : [...hexToRgb(this.settings.bg), 1];
      const from: [number, number] = [p.x - layer.x, p.y - layer.y];
      this.engine.beginPaint(this.doc, { kind: "gradient", layer, from, to: from, a: [r, gg, b, 1], b: end as [number, number, number, number], radial: g.radial, opacity: g.opacity / 100 });
      this.drag = { kind: "gradient", layer, from };
      this.gradientTo = from;
    } else if (tool === "bucket") {
      this.bucket(p);
      return;
    } else if (tool === "move") {
      const layer = this.pixelTarget;
      if (!layer) return this.host.toast("Choose a pixel layer to move.");
      this.engine.beginLive(this.doc, this.activeIndex);
      this.drag = { kind: "move", layer, x: e.clientX, y: e.clientY, ox: layer.x, oy: layer.y };
    } else if (tool === "crop") {
      this.drag = { kind: "crop", mode: this.cropHit(e), start: this.crop ? { ...this.crop } : { x: p.x, y: p.y, w: 0, h: 0 }, x: p.x, y: p.y };
    } else return;
    this.stage.setPointerCapture(e.pointerId);
    this.updateCursor();
  }

  /** The chosen layer when it can be painted on; says why not otherwise. */
  private paintableLayer(): PixelLayer | null {
    const layer = this.pixelTarget;
    if (!layer) {
      this.host.toast("Choose a pixel layer to paint on: the chosen layer is an adjustment layer.");
      return null;
    }
    if (!layer.visible) {
      this.host.toast("The chosen layer is hidden: show it to paint on it.");
      return null;
    }
    return layer;
  }

  private dab(x: number, y: number, brush: BrushSettings, e: PointerEvent): Dab {
    const pressure = e.pointerType === "pen" ? Math.max(0.05, e.pressure || 0.5) : 1;
    return { x, y, r: Math.max(0.5, (brush.size / 2) * pressure), alpha: (brush.flow / 100) * (e.pointerType === "pen" ? Math.min(1, 0.3 + pressure) : 1) };
  }

  private pointerMove(e: PointerEvent) {
    const r = this.stage.getBoundingClientRect();
    this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true };
    const p = this.docPoint(e);
    const inDoc = p.x >= 0 && p.y >= 0 && p.x < this.doc.width && p.y < this.doc.height;
    this.statusPointer.textContent = inDoc ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : "";
    const drag = this.drag;
    if (!drag) {
      if (this.settings.tool === "brush" || this.settings.tool === "eraser") this.drawOverlay();
      if (this.settings.tool === "crop") this.stage.style.cursor = cropCursor(this.cropHit(e));
      return;
    }
    if (drag.kind === "pan") {
      this.cx = drag.cx - ((e.clientX - drag.x) * this.dpr) / this.zoom;
      this.cy = drag.cy - ((e.clientY - drag.y) * this.dpr) / this.zoom;
      this.fitted = false;
      this.render();
    } else if (drag.kind === "pick") {
      this.pick(p);
    } else if (drag.kind === "paint") {
      const events = e.getCoalescedEvents?.() ?? [e];
      const dabs: Dab[] = [];
      for (const ev of events.length ? events : [e]) {
        const q = this.docPoint(ev);
        const to = { x: q.x - drag.layer.x, y: q.y - drag.layer.y };
        const dist = Math.hypot(to.x - drag.last.x, to.y - drag.last.y);
        const spacing = Math.max(0.5, drag.brush.size * 0.12);
        let t = drag.rest === 0 ? spacing : drag.rest;
        while (t <= dist) {
          const k = t / dist;
          dabs.push(this.dab(drag.last.x + (to.x - drag.last.x) * k, drag.last.y + (to.y - drag.last.y) * k, drag.brush, ev));
          t += spacing;
        }
        drag.rest = t - dist;
        drag.last = to;
      }
      this.engine.addDabs(dabs);
      this.render();
    } else if (drag.kind === "gradient") {
      let to: [number, number] = [p.x - drag.layer.x, p.y - drag.layer.y];
      if (e.shiftKey) {
        // Shift keeps the line at 45° steps.
        const dx = to[0] - drag.from[0], dy = to[1] - drag.from[1];
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        to = [drag.from[0] + Math.cos(angle) * len, drag.from[1] + Math.sin(angle) * len];
      }
      this.gradientTo = to;
      this.engine.updateGradient(drag.from, to);
      this.render();
    } else if (drag.kind === "move") {
      const layer = drag.layer;
      const old = { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
      layer.x = Math.round(drag.ox + ((e.clientX - drag.x) * this.dpr) / this.zoom);
      layer.y = Math.round(drag.oy + ((e.clientY - drag.y) * this.dpr) / this.zoom);
      this.engine.touch(union(old, { x: layer.x, y: layer.y, w: layer.width, h: layer.height }));
      this.render();
    } else if (drag.kind === "crop") {
      this.crop = this.dragCrop(drag, p);
      this.drawOptions();
      this.render();
    }
  }

  private endDrag(keep: boolean) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.kind === "paint" || drag.kind === "gradient") {
      const moved = drag.kind === "paint" || (this.gradientTo && Math.hypot(this.gradientTo[0] - drag.from[0], this.gradientTo[1] - drag.from[1]) >= 2);
      const result = this.engine.endPaint(keep && !!moved);
      this.gradientTo = null;
      if (result) {
        const label = drag.kind === "gradient" ? "Gradient" : this.settings.tool === "eraser" ? "Eraser" : "Brush";
        this.recordPixels(label, drag.kind === "gradient" ? "phGradient" : this.settings.tool === "eraser" ? "eraser" : "brush", drag.layer, result.rect, result.before);
      }
      this.touched(drag.layer);
    } else if (drag.kind === "move") {
      this.engine.endLive();
      const layer = drag.layer;
      const to = { x: layer.x, y: layer.y };
      if (keep && (to.x !== drag.ox || to.y !== drag.oy)) {
        this.recordChange("Move", "phMove", (after) => Object.assign(layer, after ? to : { x: drag.ox, y: drag.oy }));
      } else Object.assign(layer, { x: drag.ox, y: drag.oy });
      this.touched(layer);
    } else if (drag.kind === "crop") {
      if (this.crop && (this.crop.w < 1 || this.crop.h < 1)) this.crop = { ...drag.start };
      this.drawOptions();
    }
    this.updateCursor();
    this.render();
  }

  private pick(p: { x: number; y: number }) {
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return;
    let rgba: number[];
    const layer = this.pixelTarget;
    if (this.settings.eyedropper.allLayers || !layer) rgba = this.engine.pick(this.doc, x, y);
    else {
      const lx = x - layer.x, ly = y - layer.y;
      if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return;
      rgba = [...this.engine.readTexture(layer.tex, { x: lx, y: ly, w: 1, h: 1 })];
    }
    if (rgba[3] === 0) return;
    this.settings.fg = rgbToHex(rgba[0], rgba[1], rgba[2]);
    this.saveSettings();
    this.drawTools();
  }

  private bucket(p: { x: number; y: number }) {
    const layer = this.paintableLayer();
    if (!layer) return;
    const s = this.settings.bucket;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    const lx = x - layer.x, ly = y - layer.y;
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return;
    const whole = { x: 0, y: 0, w: layer.width, h: layer.height };
    // The area comes from the layer, or from what all layers show (Photoshop's "All Layers").
    const source = s.allLayers ? this.engine.flatten(this.doc) : this.engine.readTexture(layer.tex, whole);
    const [sw, sh, sx, sy] = s.allLayers ? [this.doc.width, this.doc.height, x, y] : [layer.width, layer.height, lx, ly];
    const area = floodMask(source, sw, sh, sx, sy, s.tolerance, s.contiguous);
    if (!area) return;
    // The filled rectangle, in layer pixels.
    const offset = s.allLayers ? { x: layer.x, y: layer.y } : { x: 0, y: 0 };
    const rect = {
      x: Math.max(0, area.rect.x - offset.x), y: Math.max(0, area.rect.y - offset.y),
      w: 0, h: 0,
    };
    rect.w = Math.min(layer.width, area.rect.x - offset.x + area.rect.w) - rect.x;
    rect.h = Math.min(layer.height, area.rect.y - offset.y + area.rect.h) - rect.y;
    if (rect.w <= 0 || rect.h <= 0) return;
    const before = this.engine.readTexture(layer.tex, rect);
    const pixels = before.slice();
    const color = hexToRgb(this.settings.fg).map((v) => v * 255) as [number, number, number];
    paintMask(pixels, rect, area.mask, sw, rect.x + offset.x, rect.y + offset.y, color, s.opacity / 100);
    this.engine.writeTexture(layer.tex, rect, pixels);
    this.recordPixels("Paint Bucket", "bucket", layer, rect, before);
    this.touched(layer);
  }

  /** Which part of the crop box a pointer is over: a handle ("nw", "e"…), "inside" or "outside". */
  private cropHit(e: { clientX: number; clientY: number }): string {
    if (!this.crop) return "outside";
    const v = this.viewState();
    const r = this.canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) * this.dpr, py = (e.clientY - r.top) * this.dpr;
    const c = this.crop;
    const x0 = v.x + c.x * v.scale, y0 = v.y + c.y * v.scale, x1 = x0 + c.w * v.scale, y1 = y0 + c.h * v.scale;
    const tol = 8 * this.dpr;
    const nearX = Math.abs(px - x0) < tol ? "w" : Math.abs(px - x1) < tol ? "e" : "";
    const nearY = Math.abs(py - y0) < tol ? "n" : Math.abs(py - y1) < tol ? "s" : "";
    const within = px > x0 - tol && px < x1 + tol && py > y0 - tol && py < y1 + tol;
    if (within && (nearX || nearY)) return nearY + nearX;
    return px > x0 && px < x1 && py > y0 && py < y1 ? "inside" : "outside";
  }

  private dragCrop(drag: Extract<Drag, { kind: "crop" }>, p: { x: number; y: number }): Rect {
    const W = this.doc.width, H = this.doc.height;
    const s = drag.start;
    const ratio = this.cropRatio();
    const dx = p.x - drag.x, dy = p.y - drag.y;
    if (drag.mode === "inside") return { ...s, x: clamp(s.x + dx, 0, W - s.w), y: clamp(s.y + dy, 0, H - s.h) };
    let left = s.x, top = s.y, right = s.x + s.w, bottom = s.y + s.h;
    if (drag.mode === "outside") {
      // A new box from where the drag began.
      left = clamp(Math.min(drag.x, p.x), 0, W);
      right = clamp(Math.max(drag.x, p.x), 0, W);
      top = clamp(Math.min(drag.y, p.y), 0, H);
      bottom = clamp(Math.max(drag.y, p.y), 0, H);
      if (ratio) {
        const w = right - left, hgt = Math.max(w / ratio, bottom - top);
        const fw = Math.min(hgt * ratio, p.x >= drag.x ? W - drag.x : drag.x), fh = fw / ratio;
        const fh2 = Math.min(fh, p.y >= drag.y ? H - drag.y : drag.y);
        const fw2 = fh2 * ratio;
        left = p.x >= drag.x ? drag.x : drag.x - fw2;
        top = p.y >= drag.y ? drag.y : drag.y - fh2;
        right = left + fw2;
        bottom = top + fh2;
      }
      return { x: left, y: top, w: right - left, h: bottom - top };
    }
    if (drag.mode.includes("w")) left = clamp(s.x + dx, 0, right - 1);
    if (drag.mode.includes("e")) right = clamp(s.x + s.w + dx, left + 1, W);
    if (drag.mode.includes("n")) top = clamp(s.y + dy, 0, bottom - 1);
    if (drag.mode.includes("s")) bottom = clamp(s.y + s.h + dy, top + 1, H);
    if (ratio) {
      let w = right - left, hgt = bottom - top;
      if (drag.mode.length === 2) w = Math.max(w, hgt * ratio);
      else if (drag.mode === "e" || drag.mode === "w") hgt = w / ratio;
      else w = hgt * ratio;
      hgt = w / ratio;
      const ax = drag.mode.includes("w") ? right : drag.mode.includes("e") ? left : (left + right) / 2;
      const ay = drag.mode.includes("n") ? bottom : drag.mode.includes("s") ? top : (top + bottom) / 2;
      const roomX = drag.mode.includes("w") ? ax : drag.mode.includes("e") ? W - ax : 2 * Math.min(ax, W - ax);
      const roomY = drag.mode.includes("n") ? ay : drag.mode.includes("s") ? H - ay : 2 * Math.min(ay, H - ay);
      if (w > roomX) (w = roomX), (hgt = w / ratio);
      if (hgt > roomY) (hgt = roomY), (w = hgt * ratio);
      left = drag.mode.includes("w") ? ax - w : drag.mode.includes("e") ? ax : ax - w / 2;
      top = drag.mode.includes("n") ? ay - hgt : drag.mode.includes("s") ? ay : ay - hgt / 2;
      right = left + w;
      bottom = top + hgt;
    }
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  // ---- keys

  handleKey(e: KeyboardEvent): boolean {
    if (this.busy) return true;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod) {
      if (key === "z") return e.shiftKey ? this.history.redo() : this.history.undo(), true;
      if (key === "y") return this.history.redo(), true;
      if (key === "j") return this.duplicateLayer(), true;
      if (key === "n" && e.shiftKey) return this.newLayer(), true;
      if (key === "e") return e.shiftKey ? this.mergeVisible() : this.mergeDown(), true;
      if (e.key === "]") return this.arrange(1), true;
      if (e.key === "[") return this.arrange(-1), true;
      if (key === "0") return this.fit(true), true;
      if (key === "1") return this.zoomTo(1), true;
      if (key === "=" || key === "+") return this.zoomStep(1), true;
      if (key === "-") return this.zoomStep(-1), true;
      if (e.key === "Backspace") return this.fillLayer(this.settings.bg, "Fill"), true;
      return false;
    }
    if (e.altKey && e.key === "Backspace") return this.fillLayer(this.settings.fg, "Fill"), true;
    if (e.key === " ") {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.updateCursor();
        this.drawOverlay();
      }
      return true;
    }
    if (e.key === "Escape") {
      if (this.drag) this.endDrag(false);
      else if (this.settings.tool === "crop") this.cancelCrop();
      return true;
    }
    if (e.key === "Enter" && this.settings.tool === "crop" && this.crop) {
      this.applyCrop(this.crop);
      return true;
    }
    if (this.settings.tool === "move" && e.key.startsWith("Arrow")) {
      this.nudge(e.key, e.shiftKey ? 10 : 1);
      return true;
    }
    const tools: Record<string, Tool> = { v: "move", c: "crop", b: "brush", e: "eraser", i: "eyedropper", h: "hand", z: "zoom" };
    if (tools[key]) return this.selectTool(tools[key]), true;
    if (key === "g") return this.selectTool(this.settings.tool === "gradient" ? "bucket" : this.settings.tool === "bucket" ? "gradient" : "gradient"), true;
    if (key === "x") return this.swapColors(), true;
    if (key === "d") return this.defaultColors(), true;
    const tool = this.settings.tool;
    if ((tool === "brush" || tool === "eraser") && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}")) {
      const b = this.settings[tool];
      const up = e.key === "]" || e.key === "}";
      if (e.shiftKey) b.hardness = clamp(b.hardness + (up ? 25 : -25), 0, 100);
      else {
        const step = b.size < 10 ? 1 : b.size < 50 ? 5 : b.size < 200 ? 10 : 50;
        b.size = clamp(b.size + (up ? step : -step), 1, 1000);
      }
      this.saveSettings();
      this.drawOptions();
      this.drawOverlay();
      return true;
    }
    if ((tool === "brush" || tool === "eraser") && /^[0-9]$/.test(e.key)) {
      this.settings[tool].opacity = e.key === "0" ? 100 : Number(e.key) * 10;
      this.saveSettings();
      this.drawOptions();
      return true;
    }
    return false;
  }

  private nudge(key: string, by: number) {
    const layer = this.pixelTarget;
    if (!layer) return;
    const from = { x: layer.x, y: layer.y };
    const to = { x: layer.x + (key === "ArrowLeft" ? -by : key === "ArrowRight" ? by : 0), y: layer.y + (key === "ArrowUp" ? -by : key === "ArrowDown" ? by : 0) };
    Object.assign(layer, to);
    this.recordChange("Nudge", "phMove", (after) => Object.assign(layer, after ? to : from));
    this.touched(layer);
  }
}

function formatZoom(zoom: number) {
  const p = zoom * 100;
  return p >= 100 ? `${Math.round(p)}%` : `${p.toFixed(p < 10 ? 2 : 1)}%`;
}

function cropCursor(hit: string) {
  if (hit === "inside") return "move";
  if (hit === "outside") return "crosshair";
  if (hit === "n" || hit === "s") return "ns-resize";
  if (hit === "e" || hit === "w") return "ew-resize";
  return hit === "nw" || hit === "se" ? "nwse-resize" : "nesw-resize";
}

/** The colour around the canvas, from the stage's background. */
function pasteboard(el: HTMLElement): [number, number, number] {
  const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [30, 31, 34];
  return [m[0] / 255, m[1] / 255, m[2] / 255];
}
