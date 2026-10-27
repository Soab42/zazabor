import { save as saveDialog } from "../../../shared/dialog";
import { basename, clamp, dirname, h, stripExtension } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import type { StudioApp, StudioHost } from "../app";
import { aiApi, ensureModels, growMask, shrinkRgba, type SamPoint } from "./aimodels";
import { autoAdjust, COLOUR_SLIDERS, DEFAULT_ADJUST, EFFECT_SLIDERS, FILTERS, formatValue, LIGHT_SLIDERS, isDefault, type Adjustments, type SliderSpec } from "./adjust";
import { extensionOf, formatFor, hasAlpha, photoApi, SAVE_FORMATS, type Decoded, type ProjectLayer, type SaveFormat } from "./api";
import { ask } from "./ask";
import { askColorRange, askExport, askFilter, askImageSize, askNumber, type NewCanvas } from "./dialogs";
import { BLEND_GROUPS, Engine, intersect, union, type AdjustLayer, type Dab, type Doc, type GroupLayer, type Layer, type LayerMask, type Paint, type PixelLayer, type Rect, type Surface, type Transform } from "./engine";
import { floodMask } from "./fill";
import { Filters, FILTER_LABELS, type FilterKind, type FilterSettings } from "./filters";
import { isIdentity } from "./geometry";
import { developPanel, isRaw, rawApi, DEFAULT_DEVELOP, type DevelopSettings, type RawInfo } from "./develop";
import { describeGpu } from "./gl";
import type { QuickEditSettings } from "./handoff";
import { heal } from "./heal";
import { History } from "./history";
import { adjIcon, adjLabel, ADJ_TYPES, cloneSpec, defaultSpec, type AdjSpec, type AdjType } from "./layeradjust";
import type { LoadedProject, ProjectJson, ProjectLayerJson } from "./project";
import { specEditor } from "./props";
import { QuickRenderer } from "./render";
import { colorRange, combine, expand, feather, invert, makeSelection, outlinePath, polygonMask, refineEdge, selectAll, shapePoints, type SelectMode, type Selection } from "./selection";
import { hexToRgb, normalizePhotoSettings, rgbToHex, type BrushSettings, type PhotoSettings, type Tool } from "./settings";
import { corners, dragTransform, handlePoint, HANDLES, hitTransform, IDENTITY_PARAMS, isIdentityParams, outBounds, transformCursor, transformMap, type TransformDrag, type TransformParams } from "./transform";
import { blockOf, depthOf, descendants, isFolded, moveBlock, siblings } from "./tree";
import { drawShape, drawText, fontFamily, FONTS, SHAPES, type ShapeSource, type TextSource } from "./vector";
import "./photo.css";
import { PHOTO_PROJECT_EXTENSIONS } from "../app";

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
  marquee: { label: "Rectangular Marquee", key: "M", icon: "phMarquee" },
  ellipse: { label: "Elliptical Marquee", key: "M", icon: "phEllipse" },
  lasso: { label: "Lasso", key: "L", icon: "phLasso" },
  polyLasso: { label: "Polygonal Lasso", key: "L", icon: "phPolyLasso" },
  wand: { label: "Magic Wand", key: "W", icon: "phWand" },
  objectSelect: { label: "Object Selection", key: "Shift+W", icon: "phObjectSelect" },
  crop: { label: "Crop", key: "C", icon: "phCrop" },
  eyedropper: { label: "Eyedropper", key: "I", icon: "phEyedropper" },
  heal: { label: "Healing Brush", key: "J", icon: "phHeal" },
  remove: { label: "Remove", key: "Shift+J", icon: "phRemove" },
  brush: { label: "Brush", key: "B", icon: "brush" },
  clone: { label: "Clone Stamp", key: "S", icon: "stamp" },
  eraser: { label: "Eraser", key: "E", icon: "eraser" },
  gradient: { label: "Gradient", key: "G", icon: "phGradient" },
  bucket: { label: "Paint Bucket", key: "G", icon: "bucket" },
  text: { label: "Type", key: "T", icon: "phText" },
  shape: { label: "Shape", key: "U", icon: "phShape" },
  hand: { label: "Hand", key: "H", icon: "phHand" },
  zoom: { label: "Zoom", key: "Z", icon: "zoomIn" },
};
const TOOL_ORDER: Tool[] = ["move", "marquee", "ellipse", "lasso", "polyLasso", "wand", "objectSelect", "crop", "eyedropper", "heal", "remove", "brush", "clone", "eraser", "gradient", "bucket", "text", "shape", "hand", "zoom"];
/** Tools grouped as in Photoshop's toolbar: a thin line between groups. */
const TOOL_BREAKS = new Set<Tool>(["marquee", "crop", "heal", "text", "hand"]);

const CROP_RATIOS: { id: string; label: string; ratio: number | null }[] = [
  { id: "free", label: "Ratio: free", ratio: null },
  { id: "1:1", label: "1:1 (square)", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

const SELECT_MODES: { id: SelectMode; label: string }[] = [
  { id: "new", label: "New" },
  { id: "add", label: "Add" },
  { id: "subtract", label: "Subtract" },
  { id: "intersect", label: "Intersect" },
];

type Drag =
  | { kind: "pan"; x: number; y: number; cx: number; cy: number }
  | { kind: "paint"; target: PaintTarget; last: { x: number; y: number }; rest: number; brush: BrushSettings; pen: boolean; tool: "brush" | "eraser" | "clone" | "heal"; offset: [number, number] }
  | { kind: "gradient"; target: PaintTarget; from: [number, number] }
  | { kind: "move"; layers: { layer: Layer; ox: number; oy: number; mx: number; my: number }[]; x: number; y: number; dx: number; dy: number }
  | { kind: "crop"; mode: string; start: Rect; x: number; y: number }
  | { kind: "select"; ellipse: boolean; from: [number, number]; to: [number, number]; mode: SelectMode }
  | { kind: "lasso"; points: [number, number][]; mode: SelectMode }
  | { kind: "transform"; drag: TransformDrag }
  | { kind: "shape"; from: [number, number]; to: [number, number] }
  | { kind: "remove"; layer: PixelLayer; points: [number, number][] }
  | { kind: "pick" };

/** Object Selection: one object's clicks on the picture MobileSAM looked at. */
interface ObjectSession {
  /** What the picture looked like (see `compositeKey`); a change means looking again. */
  key: string;
  token: number;
  /** The picture's size as the model saw it (shrunk). */
  width: number;
  height: number;
  points: SamPoint[];
  /** The selection before this object, and how the object combines with it. */
  base: Selection | null;
  mode: SelectMode;
  /** The selection the last click made: another selection change ends the session. */
  result: Selection | null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What painting goes into: a pixel layer, or a layer's mask. */
interface PaintTarget {
  layer: Layer;
  surface: Surface;
  mask: boolean;
}

/** A layer list with each layer's group, clipping and mask at that moment (for undo). */
interface Snapshot {
  layers: Layer[];
  meta: Map<Layer, { parent: number | null; clip: boolean; mask: LayerMask | null }>;
  active: number;
}

/** Free Transform in progress. */
interface TransformSession {
  /** The layer drawn transformed (the lifted piece when a selection was transformed). */
  target: PixelLayer;
  box: Rect;
  params: TransformParams;
  /** Moving or transforming selected pixels: they're lifted off their layer into `target`. */
  lifted: { layer: PixelLayer; original: WebGLTexture; hole: WebGLTexture } | null;
  /** The Move tool's drag: ends with the pointer, no handles. */
  quick: boolean;
}

/** Copied pixels, shared by every open document. */
let clipboard: { x: number; y: number; width: number; height: number; rgba: Uint8Array } | null = null;

const bytesOf = (layer: Layer) => (layer.kind === "pixel" ? layer.width * layer.height * 4 : 0) + (layer.mask ? layer.mask.width * layer.mask.height * 4 : 0);
const sizeText = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const grey = (hex: string): [number, number, number] => {
  const [r, g, b] = hexToRgb(hex);
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return [l, l, l];
};
const greyRgba = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(data.length * 4);
  for (let i = 0; i < data.length; i++) out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i], out[i * 4 + 3] = 255;
  return out;
};

/**
 * Photo: a layered photo editor in Photoshop's layout. Tools on the left, the tool's options
 * along the top, the canvas in the middle, and Properties, Layers and History on the right.
 */
export class PhotoEditor implements StudioApp {
  readonly kind = "photo" as const;
  readonly el: HTMLElement;
  private engine: Engine;
  private filters: Filters;
  private settings: PhotoSettings;
  private doc: Doc = { width: 1, height: 1, layers: [] };
  private history = new History("Open");
  private activeIndex = 0;
  /** Editing the chosen layer's mask instead of its pixels. */
  private editMask = false;
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
  private propsTitle = h("span", null, "Properties");
  private propsBody = h("div", { class: "ph-panel-body ph-props" });
  private layersBody = h("div", { class: "ph-panel-body ph-layers" });
  private layerControls = h("div", { class: "ph-layer-controls" });
  private historyBody = h("div", { class: "ph-panel-body ph-history" });
  private statusZoom = h("span", { class: "ph-status-zoom" });
  private statusSize = h("span");
  private statusMemory = h("span");
  private statusSelection = h("span", { class: "ph-status-sel" });
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
  private thumbs = new Map<string, { version: number; canvas: HTMLCanvasElement }>();
  private versions = new Map<number, number>();
  private maskVersions = new Map<number, number>();
  private thumbTimer = 0;
  private settingsTimer = 0;
  private resize = new ResizeObserver(() => this.fitIfFitted());

  // Selections.
  private selection: Selection | null = null;
  private lastSelection: Selection | null = null;
  private selectionPath: Path2D | null = null;
  private antsPhase = 0;
  private antsTimer = 0;
  /** The Polygonal Lasso's corners so far. */
  private poly: { points: [number, number][]; mode: SelectMode } | null = null;

  private transform: TransformSession | null = null;
  private cloneSource: [number, number] | null = null;
  private cloneOffset: [number, number] | null = null;
  private textEdit: { layer: PixelLayer; box: HTMLElement; isNew: boolean; before: Snapshot | null } | null = null;
  private gradientTo: [number, number] | null = null;
  /** Object Selection's current object. */
  private objectSession: ObjectSession | null = null;
  /** An AI tool is working (one at a time). */
  private aiWorking = false;
  /** RAW files' camera details, by path. */
  private rawInfo = new Map<string, RawInfo>();
  /** Developing again, one at a time; the Develop sliders' settings when a drag started. */
  private developQueue: Promise<void> = Promise.resolve();
  private developTimer = 0;
  private developStart: DevelopSettings | null = null;
  private lastFilter: { kind: FilterKind } | null = null;
  /** The adjustment change last recorded, which a quick repeat folds into. */
  private lastAdjust: { step: object; layer: Layer; label: string; time: number; next: { a: Adjustments; s: AdjSpec } } | null = null;

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") {
      this.spaceHeld = false;
      this.updateCursor();
    }
  };

  constructor(private readonly host: StudioHost) {
    this.settings = normalizePhotoSettings(host.shell.config.studio.apps.photo);
    this.engine = new Engine(this.canvas);
    this.filters = new Filters(this.engine);
    this.undoButton = h("button", { class: "icon-btn small", type: "button", "aria-label": "Undo", onclick: () => this.history.undo() }, icon("undo", 16));
    this.redoButton = h("button", { class: "icon-btn small", type: "button", "aria-label": "Redo", onclick: () => this.history.redo() }, icon("redo", 16));
    const menu = (label: string, items: () => MenuItem[]) => {
      const button = h("button", { class: "ph-menu-btn", type: "button" }, label);
      button.addEventListener("click", () => {
        this.commitText();
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
        menu("Select", () => this.selectMenu()),
        menu("Filter", () => this.filterMenu()),
        menu("View", () => this.viewMenu())),
      h("div", { class: "ph-title" }, this.titleName, this.titleState),
      h("div", { class: "ph-title-actions" }, this.undoButton, this.redoButton));
    this.stage.append(this.canvas, this.overlay, this.busyEl);
    const panel = (title: HTMLElement, glyph: IconName, body: HTMLElement, cls = "") =>
      h("section", { class: `ph-panel ${cls}` }, h("header", { class: "ph-panel-head" }, icon(glyph, 14), title), body);
    const layerButtons = h("div", { class: "ph-layer-buttons" },
      this.iconButton("phNewLayer", "New layer (Ctrl+Shift+N)", () => this.newLayer()),
      this.iconButton("phGroup", "New group", () => this.newGroup()),
      this.iconButton("phMask", "Add layer mask", () => this.addMask(this.selection ? "revealSelection" : "reveal")),
      this.iconButton("phAdjustLayer", "New adjustment layer", (e) => this.adjustMenuAt(e)),
      this.iconButton("copy", "Duplicate layer (Ctrl+J)", () => this.duplicateLayer()),
      this.iconButton("phMerge", "Merge down (Ctrl+E)", () => this.mergeDown()),
      this.iconButton("trash", "Delete layer", () => this.deleteLayer()));
    const panels = h("aside", { class: "ph-panels" },
      panel(this.propsTitle, "phAdjustLayer", this.propsBody),
      h("section", { class: "ph-panel ph-panel-layers" }, h("header", { class: "ph-panel-head" }, icon("phLayers", 14), h("span", null, "Layers")), this.layerControls, this.layersBody, layerButtons),
      panel(h("span", null, "History"), "phHistory", this.historyBody));
    const status = h("footer", { class: "ph-status" }, this.statusZoom, this.statusSize, this.statusMemory, this.statusSelection, h("span", { class: "spacer" }), this.statusPointer,
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
      // A camera RAW file: the layer can be developed again from the Properties panel.
      if (isRaw(opening.path) && !quick) (this.doc.layers[0] as PixelLayer).raw = { path: opening.path, settings: { ...DEFAULT_DEVELOP } };
      if (quick && !isDefault(quick.adjust)) {
        this.doc.layers.push(this.adjustLayer("Quick Edit", { type: "basic" }, quick.adjust));
      }
      if (decoded.scaled) this.host.toast(`${basename(opening.path)} was scaled to ${decoded.width} × ${decoded.height}: the largest this computer's graphics can edit.`);
    } else {
      const { project } = opening;
      this.filePath = opening.path;
      this.icc = project.icc.slice();
      this.history = this.newHistory("Open", "image");
      this.setDocSize(project.width, project.height);
      this.doc.layers = this.layersFromLoaded(project.layers);
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

  /** Layers from a project or a PSD (groups named by index), with fresh ids. */
  layersFromLoaded(loaded: LoadedProject["layers"]): Layer[] {
    const ids = loaded.map(() => this.nextId++);
    return loaded.map((l, i): Layer => {
      const mask: LayerMask | null = l.mask ? { tex: this.engine.layerTexture(l.mask.width, l.mask.height, l.mask.rgba), x: l.mask.x, y: l.mask.y, width: l.mask.width, height: l.mask.height, fill: l.mask.fill, enabled: l.mask.enabled } : null;
      const base = { id: ids[i], name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, parent: l.parent === null ? null : ids[l.parent], clip: l.clip, mask };
      if (l.kind === "pixel") return { ...base, kind: "pixel", x: l.x, y: l.y, width: l.width, height: l.height, tex: this.engine.layerTexture(l.width, l.height, l.rgba), source: l.source, raw: l.raw ?? null };
      if (l.kind === "adjust") return { ...base, kind: "adjust", adjust: { ...l.adjust }, spec: l.spec };
      return { ...base, kind: "group", passThrough: l.passThrough, open: l.open };
    });
  }

  private newHistory(label: string, glyph: IconName) {
    const history = new History(label, glyph);
    history.onChange = () => this.historyChanged();
    return history;
  }

  private nextLayerNumber = 1;

  private pixelLayer(name: string, x: number, y: number, width: number, height: number, fill: Uint8Array | [number, number, number, number] | null): PixelLayer {
    return { kind: "pixel", id: this.nextId++, name, visible: true, opacity: 1, blend: "normal", parent: null, clip: false, mask: null, source: null, x, y, width, height, tex: this.engine.layerTexture(width, height, fill) };
  }

  private adjustLayer(name: string, spec: AdjSpec, adjust: Adjustments = DEFAULT_ADJUST): AdjustLayer {
    return { kind: "adjust", id: this.nextId++, name, visible: true, opacity: 1, blend: "normal", parent: null, clip: false, mask: null, adjust: { ...adjust }, spec: cloneSpec(spec) };
  }

  private setDocSize(width: number, height: number) {
    this.doc.width = width;
    this.doc.height = height;
    this.engine.setDocSize(width, height);
    // A selection belongs to one canvas size.
    this.selection = null;
    this.lastSelection = null;
    this.selectionPath = null;
    this.updateAnts();
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
    this.updateAnts();
  }

  deactivate() {
    this.endDrag(false);
    this.commitText();
    window.clearInterval(this.antsTimer);
    this.antsTimer = 0;
  }

  dispose() {
    clearTimeout(this.thumbTimer);
    clearTimeout(this.settingsTimer);
    window.clearInterval(this.antsTimer);
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    window.removeEventListener("keyup", this.onKeyUp);
    this.cancelTransform();
    this.textEdit?.box.remove();
    this.history.clear();
    for (const layer of this.doc.layers) {
      if (layer.kind === "pixel") this.engine.deleteTexture(layer.tex);
      if (layer.mask) this.engine.deleteTexture(layer.mask.tex);
    }
    this.filters.dispose();
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

  /** Memory in use: layers, masks, compositing buffers and history. */
  private memoryUse() {
    return this.doc.layers.reduce((n, l) => n + bytesOf(l), 0) + this.engine.bufferBytes + this.history.bytes;
  }

  /** Whether `bytes` more fit the budget; says why not when they don't. */
  private fits(bytes: number) {
    if (this.memoryUse() + bytes <= BUDGET) return true;
    this.host.toast(`Not enough memory for that: Photo uses ${sizeText(this.memoryUse())} of ${sizeText(BUDGET)}. Merge or delete layers first.`);
    return false;
  }

  /** A layer's pixels (or its mask) changed: its thumbnail follows. */
  private touched(layer: Layer, mask = false) {
    const map = mask ? this.maskVersions : this.versions;
    map.set(layer.id, (map.get(layer.id) ?? 0) + 1);
    this.engine.invalidate();
    this.scheduleThumbs();
    this.render();
  }

  private snapshot(): Snapshot {
    return { layers: [...this.doc.layers], meta: new Map(this.doc.layers.map((l) => [l, { parent: l.parent, clip: l.clip, mask: l.mask }])), active: this.activeIndex };
  }

  private restore(s: Snapshot) {
    this.doc.layers = [...s.layers];
    for (const [l, m] of s.meta) Object.assign(l, m);
    this.activeIndex = Math.max(0, Math.min(s.active, this.doc.layers.length - 1));
    if (!this.layer?.mask) this.editMask = false;
    this.engine.invalidate();
    this.engine.pruneLuts(this.doc);
    this.refreshAll();
  }

  /**
   * Records a change of the layer list (added, removed, reordered, grouped, merged layers) from
   * `before` to now; a selection change can ride along.
   */
  private recordLayers(label: string, glyph: IconName, before: Snapshot, sel?: { before: Selection | null; after: Selection | null }) {
    const after = this.snapshot();
    const added = after.layers.filter((l) => !before.layers.includes(l));
    const removed = before.layers.filter((l) => !after.layers.includes(l));
    const textures = (s: Snapshot, l: Layer) => [...(l.kind === "pixel" ? [l.tex] : []), ...(s.meta.get(l)?.mask ? [s.meta.get(l)!.mask!.tex] : [])];
    const apply = (s: Snapshot, selection: Selection | null | undefined) => {
      if (sel) this.setSelectionState(selection ?? null);
      this.restore(s);
    };
    this.history.push({
      label,
      icon: glyph,
      bytes: [...added, ...removed].reduce((n, l) => n + bytesOf(l), 0) + (sel ? (sel.before?.data.length ?? 0) + (sel.after?.data.length ?? 0) : 0),
      undo: () => apply(before, sel?.before),
      redo: () => apply(after, sel?.after),
      drop: (applied) => {
        for (const layer of applied ? removed : added) for (const tex of textures(applied ? before : after, layer)) this.engine.deleteTexture(tex);
      },
    });
  }

  /** Records a change of some layer settings: `set(true)` puts the new ones back, `set(false)` the old. */
  private recordChange(label: string, glyph: IconName, set: (after: boolean) => void, bytes = 0, drop?: (applied: boolean) => void) {
    this.history.push({
      label,
      icon: glyph,
      bytes,
      undo: () => (set(false), this.engine.invalidate(), this.refreshAll()),
      redo: () => (set(true), this.engine.invalidate(), this.refreshAll()),
      drop,
    });
  }

  /** Records pixels that changed in a rectangle of a surface (`before` holds the old ones). */
  private recordPixels(label: string, glyph: IconName, layer: Layer, mask: boolean, rect: Rect, before: Uint8Array) {
    let data = before;
    const swap = () => {
      const surface = mask ? layer.mask : layer.kind === "pixel" ? layer : null;
      if (!surface) return;
      data = this.engine.swapTexture(surface.tex, rect, data);
      this.touched(layer, mask);
    };
    this.history.push({ label, icon: glyph, bytes: data.length, undo: swap, redo: swap });
  }

  /** Records a surface's texture replaced by a new one (filters, Apply Mask). */
  private recordTexture(label: string, glyph: IconName, layer: Layer, mask: boolean, old: WebGLTexture, next: WebGLTexture) {
    const set = (tex: WebGLTexture) => {
      const surface = mask ? layer.mask : layer.kind === "pixel" ? layer : null;
      if (surface) surface.tex = tex;
      this.touched(layer, mask);
    };
    const surface = mask ? layer.mask! : (layer as PixelLayer);
    this.history.push({
      label,
      icon: glyph,
      bytes: surface.width * surface.height * 4,
      undo: () => set(old),
      redo: () => set(next),
      drop: (applied) => this.engine.deleteTexture(applied ? old : next),
    });
  }

  /** Puts a new layer above the chosen one (inside it when that's a group) and chooses it. */
  private insertLayer(layer: Layer) {
    const active = this.layer;
    let at = this.activeIndex + 1;
    let parent: number | null = active?.parent ?? null;
    if (active?.kind === "group" && active.open) {
      at = this.activeIndex;
      parent = active.id;
    } else if (!active) at = this.doc.layers.length;
    layer.parent = parent;
    this.doc.layers.splice(at, 0, layer);
    this.activeIndex = at;
    this.editMask = false;
  }

  private newLayer() {
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const before = this.snapshot();
    this.insertLayer(this.pixelLayer(`Layer ${this.nextLayerNumber++}`, 0, 0, this.doc.width, this.doc.height, null));
    this.recordLayers("New Layer", "phNewLayer", before);
    this.refreshAll();
  }

  private newGroup() {
    const before = this.snapshot();
    const count = this.doc.layers.filter((l) => l.kind === "group").length + 1;
    const group: GroupLayer = { kind: "group", id: this.nextId++, name: `Group ${count}`, visible: true, opacity: 1, blend: "normal", parent: null, clip: false, mask: null, passThrough: true, open: true };
    this.insertLayer(group);
    this.recordLayers("New Group", "phGroup", before);
    this.refreshAll();
  }

  /** Ctrl+G: the chosen layer (and what's inside it) goes into a new group. */
  private groupLayers() {
    const layer = this.layer;
    if (!layer) return;
    const before = this.snapshot();
    const count = this.doc.layers.filter((l) => l.kind === "group").length + 1;
    const group: GroupLayer = { kind: "group", id: this.nextId++, name: `Group ${count}`, visible: true, opacity: 1, blend: "normal", parent: layer.parent, clip: false, mask: null, passThrough: true, open: true };
    layer.parent = group.id;
    layer.clip = false;
    this.doc.layers.splice(this.activeIndex + 1, 0, group);
    this.activeIndex++;
    this.engine.invalidate();
    this.recordLayers("Group Layers", "phGroup", before);
    this.refreshAll();
  }

  private ungroup() {
    const group = this.layer;
    if (group?.kind !== "group") return this.host.toast("Choose a group to ungroup.");
    const before = this.snapshot();
    for (const l of this.doc.layers) if (l.parent === group.id) l.parent = group.parent;
    this.doc.layers.splice(this.activeIndex, 1);
    this.activeIndex = Math.max(0, this.activeIndex - 1);
    this.engine.invalidate();
    this.recordLayers("Ungroup Layers", "phGroup", before);
    this.refreshAll();
  }

  private newAdjustLayer(type: AdjType = "basic", adjust: Adjustments = DEFAULT_ADJUST, name?: string) {
    const before = this.snapshot();
    const label = name ?? adjLabel(type);
    const count = this.doc.layers.filter((l) => l.kind === "adjust" && l.name.startsWith(label)).length + 1;
    const layer = this.adjustLayer(`${label} ${count}`, defaultSpec(type), adjust);
    // A selection limits a new adjustment, as in Photoshop.
    if (this.selection) layer.mask = this.maskFromSelection(this.selection, false);
    this.insertLayer(layer);
    this.engine.invalidate();
    this.recordLayers(`New ${adjLabel(type)} Layer`, adjIcon(type), before);
    this.refreshAll();
  }

  private adjustMenuAt(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.top - 8 - ADJ_TYPES.length * 30, ADJ_TYPES.map((t) => ({ label: t.label, icon: t.icon, action: () => this.newAdjustLayer(t.type) })));
  }

  private copyMask(mask: LayerMask | null): LayerMask | null {
    return mask ? { ...mask, tex: this.engine.transformTexture(mask.tex, mask.width, mask.height, "copy") } : null;
  }

  private duplicateLayer() {
    const layer = this.layer;
    if (!layer) return;
    const [start, end] = blockOf(this.doc.layers, this.activeIndex);
    const block = this.doc.layers.slice(start, end + 1);
    if (!this.fits(block.reduce((n, l) => n + bytesOf(l), 0))) return;
    const before = this.snapshot();
    const ids = new Map<number, number>();
    for (const l of block) ids.set(l.id, this.nextId++);
    const copies = block.map((l): Layer => {
      const base = { ...l, id: ids.get(l.id)!, name: l === layer ? `${l.name} copy` : l.name, parent: l === layer ? l.parent : (ids.get(l.parent!) ?? l.parent), mask: this.copyMask(l.mask) };
      if (l.kind === "pixel") return { ...base, kind: "pixel", tex: this.engine.transformTexture(l.tex, l.width, l.height, "copy"), source: l.source ? { ...l.source } : null } as PixelLayer;
      if (l.kind === "adjust") return { ...base, kind: "adjust", adjust: { ...l.adjust }, spec: cloneSpec(l.spec) } as AdjustLayer;
      return { ...base } as GroupLayer;
    });
    this.doc.layers.splice(end + 1, 0, ...copies);
    this.activeIndex = end + copies.length;
    this.recordLayers("Duplicate Layer", "copy", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  private deleteLayer() {
    if (!this.layer) return;
    const [start, end] = blockOf(this.doc.layers, this.activeIndex);
    if (end - start + 1 >= this.doc.layers.length) return this.host.toast("A picture keeps at least one layer.");
    const before = this.snapshot();
    this.doc.layers.splice(start, end - start + 1);
    this.activeIndex = Math.max(0, Math.min(start, this.doc.layers.length) - 1);
    this.editMask = false;
    this.recordLayers("Delete Layer", "trash", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Merges `layers` (in order, bottom first) into one pixel layer the size of the document. */
  private merged(layers: Layer[], name: string): PixelLayer {
    const tex = this.engine.mergeLayers({ width: this.doc.width, height: this.doc.height, layers });
    return { kind: "pixel", id: this.nextId++, name, visible: true, opacity: 1, blend: "normal", parent: null, clip: false, mask: null, source: null, x: 0, y: 0, width: this.doc.width, height: this.doc.height, tex };
  }

  private mergeDown() {
    const top = this.layer;
    if (!top) return;
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    if (top.kind === "group") {
      // Merge Group: the group and everything in it become one layer.
      const [start, end] = blockOf(this.doc.layers, this.activeIndex);
      const before = this.snapshot();
      const block = this.doc.layers.slice(start, end + 1).map((l) => (l === top ? { ...l, parent: null } : l));
      const merged = this.merged(top.visible ? block.map((l) => (l.id === top.id ? { ...l, visible: true } : l)) : [], top.name);
      merged.parent = top.parent;
      this.doc.layers.splice(start, end - start + 1, merged);
      this.activeIndex = start;
      this.recordLayers("Merge Group", "phMerge", before);
      this.engine.invalidate();
      this.refreshAll();
      return;
    }
    const below = this.doc.layers[this.activeIndex - 1];
    if (!below || below.parent !== top.parent) return this.host.toast("There's no layer below to merge into.");
    if (below.kind !== "pixel") return this.host.toast("Merge onto a pixel layer: the layer below isn't one.");
    if (!below.visible) return this.host.toast("The layer below is hidden.");
    const before = this.snapshot();
    const base = { ...below, opacity: 1, blend: "normal" as const, clip: false };
    const merged = this.merged(top.visible ? [base, top] : [base], below.name);
    merged.opacity = below.opacity;
    merged.blend = below.blend;
    merged.parent = below.parent;
    merged.clip = below.clip;
    this.doc.layers.splice(this.activeIndex - 1, 2, merged);
    this.activeIndex--;
    this.editMask = false;
    this.recordLayers("Merge Down", "phMerge", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  private mergeVisible() {
    const roots = this.doc.layers.filter((l) => l.parent === null && l.visible);
    if (roots.length < 2 && !(roots.length === 1 && roots[0].kind !== "pixel")) return;
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const before = this.snapshot();
    const keep = new Set<Layer>();
    for (const root of roots) {
      const [start, end] = blockOf(this.doc.layers, this.doc.layers.indexOf(root));
      for (const l of this.doc.layers.slice(start, end + 1)) keep.add(l);
    }
    const merged = this.merged(this.doc.layers.filter((l) => keep.has(l)), "Merged");
    const top = Math.max(...[...keep].map((l) => this.doc.layers.indexOf(l)));
    const rest = this.doc.layers.filter((l) => !keep.has(l));
    const at = rest.filter((l) => this.doc.layers.indexOf(l) < top).length;
    rest.splice(at, 0, merged);
    this.doc.layers = rest;
    this.activeIndex = at;
    this.editMask = false;
    this.recordLayers("Merge Visible", "phMerge", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  private flatten() {
    const only = this.doc.layers[0];
    if (this.doc.layers.length === 1 && only.kind === "pixel" && only.opacity === 1 && !only.mask) return;
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const before = this.snapshot();
    this.doc.layers = [this.merged(this.doc.layers, "Background")];
    this.activeIndex = 0;
    this.editMask = false;
    this.recordLayers("Flatten Image", "phLayers", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Moves the chosen layer above (1) or below (−1) its neighbour in the same group. */
  private arrange(delta: number) {
    const layer = this.layer;
    if (!layer) return;
    const sibs = siblings(this.doc.layers, layer.parent);
    const k = sibs.indexOf(this.activeIndex);
    const other = sibs[k + delta];
    if (other === undefined) return;
    const at = delta > 0 ? other + 1 : blockOf(this.doc.layers, other)[0];
    this.moveTo(this.activeIndex, at, layer.parent, "Layer Order");
  }

  private moveTo(from: number, at: number, parent: number | null, label: string) {
    const before = this.snapshot();
    const moved = moveBlock(this.doc.layers, from, at, parent);
    if (!moved) {
      this.restore(before);
      return;
    }
    if (moved.layers.every((l, i) => l === before.layers[i]) && this.doc.layers[from].parent === before.meta.get(this.doc.layers[from])!.parent) return;
    this.doc.layers = moved.layers;
    this.activeIndex = moved.index;
    this.recordLayers(label, "phLayers", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  private setLayerProp<K extends "opacity" | "blend" | "visible" | "name" | "clip">(layer: Layer, key: K, value: Layer[K], label: string, record = true) {
    const old = layer[key];
    if (old === value) return;
    layer[key] = value;
    this.engine.invalidate();
    if (record) this.recordChange(label, "phLayers", (after) => (layer[key] = after ? value : old));
    this.refreshAll();
  }

  private toggleClip() {
    const layer = this.layer;
    if (!layer) return;
    this.setLayerProp(layer, "clip", !layer.clip, layer.clip ? "Release Clipping Mask" : "Create Clipping Mask");
  }

  private setPassThrough(group: GroupLayer, on: boolean, blend: Layer["blend"]) {
    const old = { passThrough: group.passThrough, blend: group.blend };
    const now = { passThrough: on, blend };
    if (old.passThrough === on && old.blend === blend) return;
    Object.assign(group, now);
    this.recordChange("Blending Change", "phLayers", (after) => Object.assign(group, after ? now : old));
    this.engine.invalidate();
    this.refreshAll();
  }

  // ---- masks

  /** A document-sized mask from the selection (or its inverse). */
  private maskFromSelection(sel: Selection, inverse: boolean): LayerMask {
    const data = inverse ? invert(sel.data) : sel.data;
    return { tex: this.engine.layerTexture(this.doc.width, this.doc.height, greyRgba(data)), x: 0, y: 0, width: this.doc.width, height: this.doc.height, fill: inverse ? 1 : 0, enabled: true };
  }

  private addMask(kind: "reveal" | "hide" | "revealSelection" | "hideSelection") {
    const layer = this.layer;
    if (!layer) return;
    if (layer.mask) return this.host.toast("This layer already has a mask.");
    if ((kind === "revealSelection" || kind === "hideSelection") && !this.selection) return this.host.toast("Make a selection first.");
    if (!this.fits(this.doc.width * this.doc.height * 4)) return;
    const W = this.doc.width, H = this.doc.height;
    const mask: LayerMask = kind === "reveal" || kind === "hide"
      ? { tex: this.engine.layerTexture(W, H, kind === "reveal" ? [1, 1, 1, 1] : [0, 0, 0, 1]), x: 0, y: 0, width: W, height: H, fill: kind === "reveal" ? 1 : 0, enabled: true }
      : this.maskFromSelection(this.selection!, kind === "hideSelection");
    layer.mask = mask;
    this.editMask = true;
    this.recordChange("Add Layer Mask", "phMask", (after) => (layer.mask = after ? mask : null), W * H * 4, (applied) => {
      if (!applied) this.engine.deleteTexture(mask.tex);
    });
    this.engine.invalidate();
    this.refreshAll();
  }

  private deleteMask() {
    const layer = this.layer;
    const mask = layer?.mask;
    if (!layer || !mask) return;
    layer.mask = null;
    this.editMask = false;
    this.recordChange("Delete Layer Mask", "phMask", (after) => (layer.mask = after ? null : mask), mask.width * mask.height * 4, (applied) => {
      if (applied) this.engine.deleteTexture(mask.tex);
    });
    this.engine.invalidate();
    this.refreshAll();
  }

  private toggleMask() {
    const mask = this.layer?.mask;
    if (!mask) return;
    const on = !mask.enabled;
    mask.enabled = on;
    this.recordChange(on ? "Enable Layer Mask" : "Disable Layer Mask", "phMask", (after) => (mask.enabled = after ? on : !on));
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Layer ▸ Layer Mask ▸ Apply: the mask cuts into the pixels and goes. */
  private applyMask() {
    const layer = this.layer;
    const mask = layer?.mask;
    if (!layer || !mask) return;
    if (layer.kind !== "pixel") return this.host.toast("Only a pixel layer's mask can be applied.");
    const rect = { x: 0, y: 0, w: layer.width, h: layer.height };
    const pixels = this.engine.readTexture(layer.tex, rect);
    const m = this.engine.readTexture(mask.tex, { x: 0, y: 0, w: mask.width, h: mask.height });
    for (let y = 0; y < layer.height; y++) {
      for (let x = 0; x < layer.width; x++) {
        const mx = x + layer.x - mask.x, my = y + layer.y - mask.y;
        const v = mx < 0 || my < 0 || mx >= mask.width || my >= mask.height ? mask.fill * 255 : m[(my * mask.width + mx) * 4];
        const i = (y * layer.width + x) * 4 + 3;
        pixels[i] = Math.round((pixels[i] * v) / 255);
      }
    }
    const next = this.engine.layerTexture(layer.width, layer.height, pixels);
    const before = this.snapshot();
    const replaced: PixelLayer = { ...layer, id: this.nextId++, tex: next, mask: null, source: null, raw: null };
    this.doc.layers[this.activeIndex] = replaced;
    this.editMask = false;
    this.recordLayers("Apply Layer Mask", "phMask", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Ctrl+I on a mask: black and white swap. */
  private invertMask() {
    const layer = this.layer;
    const mask = layer?.mask;
    if (!layer || !mask) return;
    const rect = { x: 0, y: 0, w: mask.width, h: mask.height };
    const before = this.engine.readTexture(mask.tex, rect);
    const out = before.slice();
    for (let i = 0; i < out.length; i += 4) out[i] = out[i + 1] = out[i + 2] = 255 - out[i];
    this.engine.writeTexture(mask.tex, rect, out);
    mask.fill = 1 - mask.fill;
    let data = before;
    const swap = () => {
      data = this.engine.swapTexture(mask.tex, rect, data);
      mask.fill = 1 - mask.fill;
      this.touched(layer, true);
    };
    this.history.push({ label: "Invert", icon: "phMask", bytes: before.length, undo: swap, redo: swap });
    this.touched(layer, true);
  }

  // ---- whole-picture changes

  private transformDoc(op: Transform, record = true) {
    const W = this.doc.width, H = this.doc.height;
    const place: Record<Transform, (x: number, y: number, w: number, hgt: number) => [number, number, number, number]> = {
      rotateRight: (x, y, w, hgt) => [H - y - hgt, x, hgt, w],
      rotateLeft: (x, y, w, hgt) => [y, W - x - w, hgt, w],
      rotate180: (x, y, w, hgt) => [W - x - w, H - y - hgt, w, hgt],
      flipH: (x, y, w, hgt) => [W - x - w, y, w, hgt],
      flipV: (x, y, w, hgt) => [x, H - y - hgt, w, hgt],
    };
    const turn = (s: Surface) => {
      const tex = this.engine.transformTexture(s.tex, s.width, s.height, op);
      this.engine.deleteTexture(s.tex);
      s.tex = tex;
      [s.x, s.y, s.width, s.height] = place[op](s.x, s.y, s.width, s.height);
    };
    for (const layer of this.doc.layers) {
      if (layer.kind === "pixel") {
        turn(layer);
        // Text and shapes would no longer match their pixels.
        layer.source = null;
        this.versions.set(layer.id, (this.versions.get(layer.id) ?? 0) + 1);
      }
      if (layer.mask) {
        turn(layer.mask);
        this.maskVersions.set(layer.id, (this.maskVersions.get(layer.id) ?? 0) + 1);
      }
    }
    if (op === "rotateLeft" || op === "rotateRight") this.setDocSize(H, W);
    else this.setSelectionState(null);
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
        if (layer.kind === "pixel") {
          layer.x += dx;
          layer.y += dy;
          if (layer.source) {
            layer.source.x += dx;
            layer.source.y += dy;
          }
        }
        if (layer.mask) {
          layer.mask.x += dx;
          layer.mask.y += dy;
        }
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
    const surfaces: { owner: Layer; s: Surface; mask: boolean }[] = [];
    for (const l of this.doc.layers) {
      if (l.kind === "pixel") surfaces.push({ owner: l, s: l, mask: false });
      if (l.mask) surfaces.push({ owner: l, s: l.mask, mask: true });
    }
    const extra = surfaces.reduce((n, o) => n + Math.ceil(o.s.width * kx) * Math.ceil(o.s.height * ky) * 4, 0);
    if (!this.fits(extra)) return;
    const old = surfaces.map((o) => ({ ...o, tex: o.s.tex, x: o.s.x, y: o.s.y, w: o.s.width, h: o.s.height }));
    const next = old.map((o) => {
      const w = Math.max(1, Math.round(o.w * kx)), hgt = Math.max(1, Math.round(o.h * ky));
      const target = this.engine.scaleTexture(o.tex, o.w, o.h, { x: 0, y: 0, w: o.w, h: o.h }, w, hgt);
      this.engine.releaseTarget(target);
      return { ...o, tex: target.tex, x: Math.round(o.x * kx), y: Math.round(o.y * ky), w, h: hgt };
    });
    const sources = this.doc.layers.filter((l): l is PixelLayer => l.kind === "pixel" && !!l.source).map((l) => ({ layer: l, source: l.source }));
    const oldSize = { w: this.doc.width, h: this.doc.height };
    const put = (set: typeof old, w: number, hgt: number, keepSources: boolean) => {
      for (const s of set) Object.assign(s.s, { tex: s.tex, x: s.x, y: s.y, width: s.w, height: s.h });
      for (const s of set) (s.mask ? this.maskVersions : this.versions).set(s.owner.id, ((s.mask ? this.maskVersions : this.versions).get(s.owner.id) ?? 0) + 1);
      for (const s of sources) s.layer.source = keepSources ? s.source : null;
      this.setDocSize(w, hgt);
      this.engine.invalidate();
      this.refreshAll();
      this.fit();
    };
    put(next, size.width, size.height, false);
    this.history.push({
      label: "Image Size",
      icon: "phCanvas",
      bytes: old.reduce((n, o) => n + o.w * o.h * 4, 0) + next.reduce((n, o) => n + o.w * o.h * 4, 0),
      undo: () => put(old, oldSize.w, oldSize.h, true),
      redo: () => put(next, size.width, size.height, false),
      drop: (applied) => {
        for (const s of applied ? old : next) this.engine.deleteTexture(s.tex);
      },
    });
  }

  /** Image ▸ Auto Tone: an adjustment layer with Auto's settings for the whole picture. */
  private autoTone() {
    const k = 256 / Math.max(this.doc.width, this.doc.height);
    const w = Math.max(1, Math.round(this.doc.width * k)), hgt = Math.max(1, Math.round(this.doc.height * k));
    this.activeIndex = this.doc.layers.length - 1;
    this.newAdjustLayer("basic", autoAdjust(this.engine.compositeThumbnail(this.doc, w, hgt), DEFAULT_ADJUST), "Auto Tone");
  }

  // ---- saving

  async save(as = false): Promise<boolean> {
    if (this.busy) return false;
    this.commitText();
    this.commitTransform();
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
      if (PHOTO_PROJECT_EXTENSIONS.includes(ext)) await this.saveProject(path);
      else if (ext === "psd") await this.savePsd(path);
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
    const name = `${stripExtension(this.title())}.zazimage`;
    const path = await saveDialog({
      title: "Save As",
      defaultPath: folder ? `${folder}/${name}` : name,
      filters: [
        { name: "Photo project (layers kept)", extensions: ["zazimage"] },
        { name: "Photoshop (layers kept)", extensions: ["psd"] },
        ...SAVE_FORMATS.map((f) => ({ name: `${f.name} (layers merged)`, extensions: [f.extension] })),
      ],
    });
    if (!path) return null;
    const ext = extensionOf(path);
    return PHOTO_PROJECT_EXTENSIONS.includes(ext) || ext === "psd" || SAVE_FORMATS.some((f) => f.extension === ext || (f.id === "jpeg" && ext === "jpeg") || (f.id === "tiff" && ext === "tif")) ? path : `${path}.zazimage`;
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
      const pixels = (s: Surface) => {
        layers.push({ width: s.width, height: s.height, rgba: this.engine.readTexture(s.tex, { x: 0, y: 0, w: s.width, h: s.height }) });
        return layers.length - 1;
      };
      const index = new Map(this.doc.layers.map((l, i) => [l.id, i]));
      const json: ProjectJson = {
        app: "Zazabor Photo",
        version: 2,
        width: this.doc.width,
        height: this.doc.height,
        active: this.activeIndex,
        layers: this.doc.layers.map((l): ProjectLayerJson => {
          const mask = l.mask ? { x: l.mask.x, y: l.mask.y, fill: l.mask.fill, enabled: l.mask.enabled, data: pixels(l.mask) } : null;
          const base = { name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, parent: l.parent === null ? null : (index.get(l.parent) ?? null), clip: l.clip, mask };
          if (l.kind === "adjust") return { ...base, kind: "adjust", adjust: { ...l.adjust }, spec: cloneSpec(l.spec) };
          if (l.kind === "group") return { ...base, kind: "group", passThrough: l.passThrough, open: l.open };
          return { ...base, kind: "pixel", x: l.x, y: l.y, width: l.width, height: l.height, data: pixels(l), source: l.source ? { ...l.source } : null, raw: l.raw ? { path: l.raw.path, settings: { ...l.raw.settings } } : null };
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

  /** Every layer and mask as RGBA, for writing a PSD. */
  private async savePsd(path: string) {
    let left = 0;
    await this.withBusy("Saving…", async () => {
      const { writePsdFile, unsupportedInPsd } = await import("./psd");
      left = unsupportedInPsd(this.doc);
      const read = (s: Surface) => this.engine.readTexture(s.tex, { x: 0, y: 0, w: s.width, h: s.height });
      const composite = this.engine.flatten(this.doc, false);
      const bytes = await writePsdFile(this.doc, read, composite, this.icc);
      await photoApi.writeFile(path, bytes);
    });
    this.host.toast(left ? `Saved “${basename(path)}” without its ${left} Light & Colour layer${left > 1 ? "s" : ""}: Photoshop has nothing like them.` : `Saved “${basename(path)}”`);
  }

  private async exportAs() {
    this.commitText();
    this.commitTransform();
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
    this.commitText();
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
    const target = this.surfaceTarget();
    return [
      { label: this.history.canUndo ? `Undo ${this.history.undoLabel}` : "Undo", icon: "undo", shortcut: "Ctrl+Z", disabled: !this.history.canUndo, action: () => this.history.undo() },
      { label: this.history.canRedo ? `Redo ${this.history.redoLabel}` : "Redo", icon: "redo", shortcut: "Ctrl+Shift+Z", disabled: !this.history.canRedo, action: () => this.history.redo() },
      "separator",
      { label: "Cut", icon: "cut", shortcut: "Ctrl+X", disabled: !this.pixelTarget, action: () => this.copy(false, true) },
      { label: "Copy", icon: "copy", shortcut: "Ctrl+C", disabled: !this.pixelTarget, action: () => this.copy(false, false) },
      { label: "Copy Merged", icon: "copy", shortcut: "Ctrl+Shift+C", action: () => this.copy(true, false) },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", action: () => void this.paste() },
      { label: "Clear", icon: "eraser", shortcut: "Delete", disabled: !target, action: () => this.fillSurface(null, "Clear") },
      "separator",
      { label: "Fill with Foreground", icon: "bucket", shortcut: "Alt+Backspace", disabled: !target, action: () => this.fillSurface(this.settings.fg, "Fill") },
      { label: "Fill with Background", icon: "bucket", shortcut: "Ctrl+Backspace", disabled: !target, action: () => this.fillSurface(this.settings.bg, "Fill") },
      "separator",
      { label: "Free Transform", icon: "phTransform", shortcut: "Ctrl+T", disabled: !this.pixelTarget, action: () => this.startTransform(false) },
      { label: "Flip Layer Horizontal", icon: "phFlipH", disabled: !this.pixelTarget, action: () => this.quickTransform({ ...IDENTITY_PARAMS, flipX: true }, "Flip Horizontal") },
      { label: "Flip Layer Vertical", icon: "phFlipV", disabled: !this.pixelTarget, action: () => this.quickTransform({ ...IDENTITY_PARAMS, flipY: true }, "Flip Vertical") },
      { label: "Rotate Layer 90° Clockwise", icon: "rotateRight", disabled: !this.pixelTarget, action: () => this.quickTransform({ ...IDENTITY_PARAMS, angle: Math.PI / 2 }, "Rotate 90° Clockwise") },
      { label: "Rotate Layer 90° Counter Clockwise", icon: "rotateLeft", disabled: !this.pixelTarget, action: () => this.quickTransform({ ...IDENTITY_PARAMS, angle: -Math.PI / 2 }, "Rotate 90° Counter Clockwise") },
    ];
  }

  private imageMenu(): MenuItem[] {
    return [
      { label: "Auto Tone", icon: "sparkles", action: () => this.autoTone() },
      { label: "Invert", icon: "phInvert", shortcut: "Ctrl+I", disabled: !this.surfaceTarget(), action: () => this.invertPixels() },
      { label: "Image Size…", icon: "phCanvas", action: () => void this.imageSize() },
      { label: "Crop", icon: "phCrop", shortcut: "C", action: () => this.selectTool("crop") },
      { label: "Crop to Selection", icon: "phCrop", disabled: !this.selection, action: () => this.selection && this.applyCrop(this.selection.bounds) },
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
    const mask = layer?.mask;
    return [
      { label: "New Layer", icon: "phNewLayer", shortcut: "Ctrl+Shift+N", action: () => this.newLayer() },
      { label: "New Adjustment Layer…", icon: "phAdjustLayer", action: () => {
        const r = this.layersBody.getBoundingClientRect();
        openMenu(r.left, r.top, ADJ_TYPES.map((t) => ({ label: t.label, icon: t.icon, action: () => this.newAdjustLayer(t.type) })));
      } },
      { label: "Layer via Copy", icon: "copy", shortcut: "Ctrl+J", disabled: !layer, action: () => this.duplicateOrViaCopy(false) },
      { label: "Layer via Cut", icon: "cut", shortcut: "Ctrl+Shift+J", disabled: !this.selection || !this.pixelTarget, action: () => this.duplicateOrViaCopy(true) },
      { label: "Delete Layer", icon: "trash", disabled: !layer || this.doc.layers.length < 2, action: () => this.deleteLayer() },
      { label: "Rename Layer…", icon: "pencil", disabled: !layer, action: () => this.renameLayer() },
      { label: "Rasterize", icon: "image", disabled: !this.pixelTarget?.source, action: () => this.rasterize() },
      "separator",
      { label: "New Group", icon: "phGroup", action: () => this.newGroup() },
      { label: "Group Layers", icon: "phGroup", shortcut: "Ctrl+G", disabled: !layer, action: () => this.groupLayers() },
      { label: "Ungroup Layers", icon: "phGroup", shortcut: "Ctrl+Shift+G", disabled: layer?.kind !== "group", action: () => this.ungroup() },
      { label: layer?.clip ? "Release Clipping Mask" : "Create Clipping Mask", icon: "phClip", shortcut: "Ctrl+Alt+G", disabled: !layer, action: () => this.toggleClip() },
      "separator",
      ...(mask
        ? [
          { label: mask.enabled ? "Disable Layer Mask" : "Enable Layer Mask", icon: "phMask" as IconName, action: () => this.toggleMask() },
          { label: "Apply Layer Mask", icon: "phMask" as IconName, disabled: layer?.kind !== "pixel", action: () => this.applyMask() },
          { label: "Delete Layer Mask", icon: "trash" as IconName, action: () => this.deleteMask() },
          { label: "Load Mask as Selection", icon: "phMarquee" as IconName, action: () => this.selectFromMask() },
        ]
        : [
          { label: "Remove Background", icon: "phSubject" as IconName, disabled: !this.pixelTarget, action: () => void this.removeBackground() },
          { label: "Add Mask: Reveal All", icon: "phMask" as IconName, disabled: !layer, action: () => this.addMask("reveal") },
          { label: "Add Mask: Hide All", icon: "phMask" as IconName, disabled: !layer, action: () => this.addMask("hide") },
          { label: "Add Mask: Reveal Selection", icon: "phMask" as IconName, disabled: !layer || !this.selection, action: () => this.addMask("revealSelection") },
          { label: "Add Mask: Hide Selection", icon: "phMask" as IconName, disabled: !layer || !this.selection, action: () => this.addMask("hideSelection") },
        ]),
      "separator",
      { label: "Bring Forward", icon: "arrowUp", shortcut: "Ctrl+]", disabled: !layer, action: () => this.arrange(1) },
      { label: "Send Backward", icon: "chevronDown", shortcut: "Ctrl+[", disabled: !layer, action: () => this.arrange(-1) },
      "separator",
      { label: layer?.kind === "group" ? "Merge Group" : "Merge Down", icon: "phMerge", shortcut: "Ctrl+E", disabled: !layer, action: () => this.mergeDown() },
      { label: "Merge Visible", icon: "phMerge", shortcut: "Ctrl+Shift+E", action: () => this.mergeVisible() },
      { label: "Flatten Image", icon: "phLayers", action: () => this.flatten() },
    ];
  }

  private selectMenu(): MenuItem[] {
    const sel = !!this.selection;
    return [
      { label: "All", icon: "phMarquee", shortcut: "Ctrl+A", action: () => this.changeSelection(selectAll(this.doc.width, this.doc.height), "Select All") },
      { label: "Deselect", icon: "close", shortcut: "Ctrl+D", disabled: !sel, action: () => this.deselect() },
      { label: "Reselect", icon: "refresh", shortcut: "Ctrl+Shift+D", disabled: !this.lastSelection || sel, action: () => this.lastSelection && this.changeSelection(this.lastSelection, "Reselect") },
      { label: "Inverse", icon: "phInvert", shortcut: "Ctrl+Shift+I", disabled: !sel, action: () => this.inverseSelection() },
      "separator",
      { label: "Subject", icon: "phSubject", action: () => void this.selectSubject() },
      { label: "Color Range…", icon: "phWand", action: () => void this.colorRangeDialog() },
      { label: "Layer Transparency", icon: "phLayers", disabled: !this.pixelTarget, action: () => this.selectLayerPixels(this.pixelTarget!) },
      "separator",
      { label: "Feather…", icon: "phBlur", shortcut: "Shift+F6", disabled: !sel, action: () => void this.modifySelection("feather") },
      { label: "Expand…", icon: "plus", disabled: !sel, action: () => void this.modifySelection("expand") },
      { label: "Contract…", icon: "minus", disabled: !sel, action: () => void this.modifySelection("contract") },
      { label: "Refine Edge…", icon: "phSubject", disabled: !sel, action: () => void this.refineSelectionEdge() },
    ];
  }

  private filterMenu(): MenuItem[] {
    const target = !!this.surfaceTarget();
    const last = this.lastFilter;
    return [
      { label: last ? `Last Filter (${FILTER_LABELS[last.kind]})` : "Last Filter", icon: "refresh", shortcut: "Ctrl+Alt+F", disabled: !last || !target, action: () => last && void this.runFilter(last.kind, true) },
      "separator",
      { label: "Gaussian Blur…", icon: "phBlur", disabled: !target, action: () => void this.runFilter("gaussian") },
      { label: "Motion Blur…", icon: "phMotion", disabled: !target, action: () => void this.runFilter("motion") },
      { label: "Unsharp Mask…", icon: "phSharpen", disabled: !target, action: () => void this.runFilter("unsharp") },
      { label: "Add Noise…", icon: "phNoise", disabled: !target, action: () => void this.runFilter("noise") },
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

  // ---- selection

  /** Shows a selection (or none) without recording it. */
  private setSelectionState(sel: Selection | null) {
    this.selection = sel;
    this.engine.setSelection(sel?.data ?? null);
    this.selectionPath = sel ? outlinePath(sel) : null;
    this.updateAnts();
    this.drawStatus();
    this.drawOverlay();
    // The adjustments list says whether a new one applies inside the selection.
    if (this.layer?.kind !== "adjust" && !(this.editMask && this.layer?.mask)) this.drawProps();
  }

  /** Changes the selection as one History step. */
  private changeSelection(next: Selection | null, label: string, glyph: IconName = "phMarquee") {
    const before = this.selection;
    if (!before && !next) return;
    if (before) this.lastSelection = before;
    this.setSelectionState(next);
    this.history.push({
      label,
      icon: glyph,
      bytes: (before?.data.length ?? 0) + (next?.data.length ?? 0),
      undo: () => this.setSelectionState(before),
      redo: () => this.setSelectionState(next),
    });
  }

  private deselect() {
    if (this.selection) this.changeSelection(null, "Deselect", "close");
  }

  private inverseSelection() {
    if (!this.selection) return;
    this.changeSelection(makeSelection(invert(this.selection.data), this.doc.width, this.doc.height), "Inverse", "phInvert");
  }

  /** Combines a new mask with the selection by `mode` and records it. */
  private applySelection(data: Uint8Array, mode: SelectMode, label: string, glyph: IconName) {
    const W = this.doc.width, H = this.doc.height;
    const feathered = this.settings.select.feather > 0 && mode !== "intersect" ? feather(data, W, H, this.settings.select.feather) : data;
    const next = makeSelection(combine(this.selection?.data ?? null, feathered, mode), W, H);
    this.changeSelection(next, label, glyph);
  }

  private updateAnts() {
    const want = !!this.selectionPath && this.el?.isConnected !== false;
    if (want && !this.antsTimer) {
      this.antsTimer = window.setInterval(() => {
        if (!this.el.isConnected || this.el.offsetParent === null) return;
        this.antsPhase = (this.antsPhase + 1) % 8;
        this.drawOverlay();
      }, 110);
    } else if (!want && this.antsTimer) {
      window.clearInterval(this.antsTimer);
      this.antsTimer = 0;
    }
  }

  private async modifySelection(kind: "feather" | "expand" | "contract") {
    const sel = this.selection;
    if (!sel) return;
    const titles = { feather: "Feather Selection", expand: "Expand Selection", contract: "Contract Selection" };
    const by = await askNumber({ title: titles[kind], label: kind === "feather" ? "Feather Radius" : kind === "expand" ? "Expand By" : "Contract By", value: kind === "feather" ? 5 : 4, min: kind === "feather" ? 0.5 : 1, max: kind === "feather" ? 250 : 500, unit: "px", icon: kind === "feather" ? "phBlur" : "phMarquee" });
    if (!by || !this.selection) return;
    const W = this.doc.width, H = this.doc.height;
    const data = kind === "feather" ? feather(sel.data, W, H, by) : expand(sel.data, W, H, kind === "expand" ? Math.round(by) : -Math.round(by));
    this.changeSelection(makeSelection(data, W, H), kind === "feather" ? "Feather" : kind === "expand" ? "Expand" : "Contract");
  }

  /** Select ▸ Refine Edge: the selection's soft edge snaps to the picture's own edges (hair, fur). */
  private async refineSelectionEdge() {
    const sel = this.selection;
    if (!sel) return;
    const radius = await askNumber({ title: "Refine Edge", label: "Radius", value: 8, min: 1, max: 100, unit: "px", icon: "phSubject" });
    if (!radius || this.selection !== sel) return;
    const W = this.doc.width, H = this.doc.height;
    const data = await this.withBusy("Refining the edge…", async () => refineEdge(sel.data, this.engine.flatten(this.doc), W, H, radius));
    this.changeSelection(makeSelection(data, W, H), "Refine Edge", "phSubject");
  }

  private async colorRangeDialog() {
    const W = this.doc.width, H = this.doc.height;
    const original = this.selection;
    const layer = this.pixelTarget;
    const composite = this.engine.flatten(this.doc);
    let own: Uint8Array | null = null;
    const pixels = (all: boolean) => {
      if (all || !layer) return composite;
      if (!own) {
        // The layer's pixels placed in a document-sized picture.
        own = new Uint8Array(W * H * 4);
        const src = this.engine.readTexture(layer.tex, { x: 0, y: 0, w: layer.width, h: layer.height });
        for (let y = 0; y < layer.height; y++) {
          const dy = y + layer.y;
          if (dy < 0 || dy >= H) continue;
          for (let x = 0; x < layer.width; x++) {
            const dx = x + layer.x;
            if (dx < 0 || dx >= W) continue;
            own.set(src.subarray((y * layer.width + x) * 4, (y * layer.width + x) * 4 + 4), (dy * W + dx) * 4);
          }
        }
      }
      return own;
    };
    const build = (c: { color: string; fuzziness: number; allLayers: boolean }) => colorRange(pixels(c.allLayers), W, H, hexToRgb(c.color).map((v) => v * 255) as [number, number, number], c.fuzziness);
    const choice = await askColorRange({ color: this.settings.fg, fuzziness: 40, allLayers: true }, (c) => this.setSelectionState(makeSelection(build(c), W, H)));
    this.setSelectionState(original);
    if (!choice) return;
    this.changeSelection(makeSelection(build(choice), W, H), "Color Range", "phWand");
  }

  /** Ctrl+click a thumbnail: select the layer's pixels (by their opacity). */
  private selectLayerPixels(layer: PixelLayer) {
    const W = this.doc.width, H = this.doc.height;
    const data = new Uint8Array(W * H);
    const src = this.engine.readTexture(layer.tex, { x: 0, y: 0, w: layer.width, h: layer.height });
    for (let y = 0; y < layer.height; y++) {
      const dy = y + layer.y;
      if (dy < 0 || dy >= H) continue;
      for (let x = 0; x < layer.width; x++) {
        const dx = x + layer.x;
        if (dx >= 0 && dx < W) data[dy * W + dx] = src[(y * layer.width + x) * 4 + 3];
      }
    }
    this.changeSelection(makeSelection(data, W, H), "Load Selection");
  }

  private selectFromMask() {
    const mask = this.layer?.mask;
    if (!mask) return;
    const W = this.doc.width, H = this.doc.height;
    const data = new Uint8Array(W * H);
    const src = this.engine.readTexture(mask.tex, { x: 0, y: 0, w: mask.width, h: mask.height });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const mx = x - mask.x, my = y - mask.y;
        data[y * W + x] = mx < 0 || my < 0 || mx >= mask.width || my >= mask.height ? Math.round(mask.fill * 255) : src[(my * mask.width + mx) * 4];
      }
    }
    this.changeSelection(makeSelection(data, W, H), "Load Selection");
  }

  /** The selection's coverage (0–1) at a document pixel; 1 without a selection. */
  private selAt(x: number, y: number): number {
    const sel = this.selection;
    if (!sel) return 1;
    return x < 0 || y < 0 || x >= sel.width || y >= sel.height ? 0 : sel.data[y * sel.width + x] / 255;
  }

  // ---- editing pixels

  /** What editing goes into now: the chosen layer's mask, or its pixels; null for neither. */
  private surfaceTarget(): PaintTarget | null {
    const layer = this.layer;
    if (!layer) return null;
    if (this.editMask && layer.mask) return { layer, surface: layer.mask, mask: true };
    if (layer.kind === "pixel") return { layer, surface: layer, mask: false };
    return null;
  }

  /** The target for painting tools, or null after saying why not. */
  private paintableTarget(): PaintTarget | null {
    const target = this.surfaceTarget();
    const layer = this.layer;
    if (!target || !layer) {
      this.host.toast(layer?.kind === "group" ? "Choose a layer to paint on: a group has no pixels of its own." : "Choose a pixel layer or a mask to paint on.");
      return null;
    }
    if (!layer.visible) {
      this.host.toast("The chosen layer is hidden: show it to paint on it.");
      return null;
    }
    if (!target.mask && layer.kind === "pixel" && layer.source) {
      void this.askRasterize(layer);
      return null;
    }
    return target;
  }

  private async askRasterize(layer: PixelLayer): Promise<boolean> {
    const answer = await ask({
      title: "Rasterize this layer?",
      text: `“${layer.name}” is a ${layer.source?.kind === "text" ? "type" : "shape"} layer. It has to become pixels before it can be painted on, and then it can't be edited as ${layer.source?.kind === "text" ? "text" : "a shape"}.`,
      icon: "image",
      choices: [{ id: "cancel", label: "Cancel" }, { id: "ok", label: "Rasterize", primary: true }],
      cancel: "cancel",
    });
    if (answer !== "ok") return false;
    this.rasterize(layer);
    return true;
  }

  /** A text or shape layer becomes plain pixels. */
  private rasterize(layer: PixelLayer | null = this.pixelTarget) {
    if (!layer?.source) return;
    const source = layer.source;
    layer.source = null;
    this.recordChange("Rasterize Layer", "image", (after) => (layer.source = after ? null : source));
    this.refreshAll();
  }

  /** Fill (a colour) or Clear (null) the target, inside the selection when there is one. */
  private fillSurface(hex: string | null, label: string) {
    const target = this.surfaceTarget();
    if (!target) return this.host.toast("Choose a pixel layer or a mask.");
    if (!target.mask && target.layer.kind === "pixel" && target.layer.source) return void this.askRasterize(target.layer);
    const s = target.surface;
    const sel = this.selection;
    let rect: Rect = { x: 0, y: 0, w: s.width, h: s.height };
    if (sel) {
      const r = intersect({ x: sel.bounds.x - s.x, y: sel.bounds.y - s.y, w: sel.bounds.w, h: sel.bounds.h }, rect);
      if (!r) return;
      rect = r;
    }
    const before = this.engine.readTexture(s.tex, rect);
    const pixels = before.slice();
    const color = hex ? (target.mask ? grey(hex) : hexToRgb(hex)).map((v) => Math.round(v * 255)) : null;
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const a = this.selAt(x + rect.x + s.x, y + rect.y + s.y);
        if (a <= 0) continue;
        const i = (y * rect.w + x) * 4;
        if (target.mask) {
          // A mask fills with grey; Clear hides.
          const v = color ? color[0] : 0;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.round(pixels[i] + (v - pixels[i]) * a);
          pixels[i + 3] = 255;
        } else if (color) {
          const da = pixels[i + 3] / 255;
          const ao = a + da * (1 - a);
          for (let c = 0; c < 3; c++) pixels[i + c] = Math.round((color[c] * a + pixels[i + c] * da * (1 - a)) / Math.max(ao, 1e-6));
          pixels[i + 3] = Math.round(ao * 255);
        } else pixels[i + 3] = Math.round(pixels[i + 3] * (1 - a));
      }
    }
    this.engine.writeTexture(s.tex, rect, pixels);
    this.recordPixels(label, hex ? "bucket" : "eraser", target.layer, target.mask, rect, before);
    this.touched(target.layer, target.mask);
  }

  /** Image ▸ Invert (Ctrl+I): the target's colours (or a mask's grey) turn over, inside the selection. */
  private invertPixels() {
    const target = this.surfaceTarget();
    if (!target) return;
    if (target.mask && !this.selection) return this.invertMask();
    if (!target.mask && target.layer.kind === "pixel" && target.layer.source) return void this.askRasterize(target.layer);
    const s = target.surface;
    const rect = { x: 0, y: 0, w: s.width, h: s.height };
    const before = this.engine.readTexture(s.tex, rect);
    const pixels = before.slice();
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const a = this.selAt(x + s.x, y + s.y);
        if (a <= 0) continue;
        const i = (y * rect.w + x) * 4;
        for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] + (255 - 2 * pixels[i + c]) * a);
      }
    }
    this.engine.writeTexture(s.tex, rect, pixels);
    this.recordPixels("Invert", "phInvert", target.layer, target.mask, rect, before);
    this.touched(target.layer, target.mask);
  }

  /** Copy (Ctrl+C), Copy Merged (Ctrl+Shift+C) or Cut (Ctrl+X): the selected pixels. */
  private copy(merged: boolean, cut: boolean) {
    const W = this.doc.width, H = this.doc.height;
    const sel = this.selection;
    let rgba: Uint8Array, rect: Rect;
    if (merged) {
      rect = sel ? sel.bounds : { x: 0, y: 0, w: W, h: H };
      const all = this.engine.flatten(this.doc);
      rgba = new Uint8Array(rect.w * rect.h * 4);
      for (let y = 0; y < rect.h; y++) rgba.set(all.subarray(((y + rect.y) * W + rect.x) * 4, ((y + rect.y) * W + rect.x + rect.w) * 4), y * rect.w * 4);
    } else {
      const layer = this.pixelTarget;
      if (!layer) return this.host.toast("Choose a pixel layer to copy from.");
      const layerRect = { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
      const r = sel ? intersect(sel.bounds, layerRect) : layerRect;
      if (!r) return this.host.toast("The selection doesn't cover any of this layer.");
      rect = r;
      rgba = this.engine.readTexture(layer.tex, { x: rect.x - layer.x, y: rect.y - layer.y, w: rect.w, h: rect.h });
    }
    if (sel) {
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) rgba[(y * rect.w + x) * 4 + 3] = Math.round(rgba[(y * rect.w + x) * 4 + 3] * this.selAt(x + rect.x, y + rect.y));
    }
    clipboard = { x: rect.x, y: rect.y, width: rect.w, height: rect.h, rgba };
    if (cut) this.fillSurface(null, "Cut");
    else this.host.toast(merged ? "Copied what the picture shows." : "Copied.");
  }

  /** Paste (Ctrl+V): what was copied, as a new layer where it came from (or a picture on the system clipboard). */
  private async paste() {
    let item = clipboard;
    if (!item) item = await systemClipboardPicture();
    if (!item) return this.host.toast("There's nothing to paste.");
    if (!this.fits(item.width * item.height * 4)) return;
    const before = this.snapshot();
    // Keep it in view when it came from somewhere outside this canvas.
    const x = item.x + item.width > 0 && item.x < this.doc.width ? item.x : Math.round((this.doc.width - item.width) / 2);
    const y = item.y + item.height > 0 && item.y < this.doc.height ? item.y : Math.round((this.doc.height - item.height) / 2);
    this.insertLayer(this.pixelLayer(`Layer ${this.nextLayerNumber++}`, x, y, item.width, item.height, item.rgba));
    this.recordLayers("Paste", "paste", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Ctrl+J: with a selection, its pixels become a new layer (Layer via Copy); without one, Duplicate. */
  private duplicateOrViaCopy(cut: boolean) {
    const layer = this.pixelTarget;
    if (!this.selection || !layer) {
      if (!cut) this.duplicateLayer();
      return;
    }
    const sel = this.selection;
    const r = intersect(sel.bounds, { x: layer.x, y: layer.y, w: layer.width, h: layer.height });
    if (!r) return this.host.toast("The selection doesn't cover any of this layer.");
    const rgba = this.engine.readTexture(layer.tex, { x: r.x - layer.x, y: r.y - layer.y, w: r.w, h: r.h });
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) rgba[(y * r.w + x) * 4 + 3] = Math.round(rgba[(y * r.w + x) * 4 + 3] * this.selAt(x + r.x, y + r.y));
    if (cut) this.fillSurface(null, "Cut");
    const before = this.snapshot();
    const copy = this.pixelLayer(`Layer ${this.nextLayerNumber++}`, r.x, r.y, r.w, r.h, rgba);
    copy.parent = layer.parent;
    this.doc.layers.splice(this.doc.layers.indexOf(layer) + 1, 0, copy);
    this.activeIndex = this.doc.layers.indexOf(copy);
    this.editMask = false;
    this.recordLayers(cut ? "Layer via Cut" : "Layer via Copy", "copy", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  // ---- filters

  private async runFilter(kind: FilterKind, again = false) {
    const target = this.surfaceTarget();
    if (!target) return this.host.toast("Choose a pixel layer or a mask to filter.");
    if (!target.mask && target.layer.kind === "pixel" && target.layer.source && !(await this.askRasterize(target.layer))) return;
    const surface = target.mask ? target.layer.mask! : (target.layer as PixelLayer);
    const original = surface.tex;
    const doc: [number, number] = [this.doc.width, this.doc.height];
    let preview: WebGLTexture | null = null;
    const seed = Math.random();
    const show = (s: FilterSettings[typeof kind] | null) => {
      if (preview) this.engine.deleteTexture(preview);
      preview = null;
      surface.tex = original;
      if (s) {
        preview = this.filters.apply({ ...surface, tex: original }, kind, s, this.engine.selectionTexture, doc, seed);
        surface.tex = preview;
      }
      this.engine.invalidate();
      this.render();
    };
    let settings: FilterSettings[typeof kind] | null = this.settings.filters[kind];
    if (!again) settings = await askFilter(kind, this.settings.filters[kind], FILTER_LABELS[kind], show);
    else show(settings);
    surface.tex = original;
    if (!settings) {
      if (preview) this.engine.deleteTexture(preview);
      this.engine.invalidate();
      this.render();
      return;
    }
    (this.settings.filters as Record<FilterKind, unknown>)[kind] = settings;
    this.saveSettings();
    this.lastFilter = { kind };
    const result = preview ?? this.filters.apply({ ...surface, tex: original }, kind, settings, this.engine.selectionTexture, doc, seed);
    surface.tex = result;
    this.recordTexture(FILTER_LABELS[kind], kind === "noise" ? "phNoise" : kind === "unsharp" ? "phSharpen" : "phBlur", target.layer, target.mask, original, result);
    this.touched(target.layer, target.mask);
  }

  // ---- Free Transform

  /**
   * Starts Free Transform on the chosen layer, or on the selected pixels (lifted off it). `quick`
   * is the Move tool's drag of selected pixels.
   */
  private startTransform(quick: boolean): boolean {
    if (this.transform) return true;
    this.commitText();
    const layer = this.pixelTarget;
    if (!layer || this.editMask) {
      this.host.toast("Choose a pixel layer to transform.");
      return false;
    }
    if (!layer.visible) {
      this.host.toast("The chosen layer is hidden.");
      return false;
    }
    const sel = this.selection;
    if (!sel) {
      this.transform = { target: layer, box: { x: layer.x, y: layer.y, w: layer.width, h: layer.height }, params: { ...IDENTITY_PARAMS }, lifted: null, quick };
    } else {
      const r = intersect(sel.bounds, { x: layer.x, y: layer.y, w: layer.width, h: layer.height });
      if (!r) {
        this.host.toast("The selection doesn't cover any of this layer.");
        return false;
      }
      const all = this.engine.readTexture(layer.tex, { x: 0, y: 0, w: layer.width, h: layer.height });
      const piece = new Uint8Array(r.w * r.h * 4);
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const a = this.selAt(x + r.x, y + r.y);
          const si = ((y + r.y - layer.y) * layer.width + (x + r.x - layer.x)) * 4;
          const di = (y * r.w + x) * 4;
          piece.set(all.subarray(si, si + 4), di);
          piece[di + 3] = Math.round(all[si + 3] * a);
          all[si + 3] = Math.round(all[si + 3] * (1 - a));
        }
      }
      const hole = this.engine.layerTexture(layer.width, layer.height, all);
      const original = layer.tex;
      layer.tex = hole;
      const floating: PixelLayer = { ...this.pixelLayer("Floating", r.x, r.y, r.w, r.h, piece), parent: layer.parent, opacity: layer.opacity, blend: layer.blend };
      this.doc.layers.splice(this.doc.layers.indexOf(layer) + 1, 0, floating);
      this.transform = { target: floating, box: r, params: { ...IDENTITY_PARAMS }, lifted: { layer, original, hole }, quick };
    }
    this.engine.setPreview(this.transform.target, transformMap(this.transform.box, this.transform.params));
    if (!quick) this.drawOptions();
    this.render();
    return true;
  }

  private updateTransform(params: TransformParams) {
    const t = this.transform;
    if (!t) return;
    t.params = params;
    this.engine.setPreview(t.target, transformMap(t.box, params));
    if (!t.quick) this.drawOptions();
    this.render();
  }

  /** Puts everything back as it was. */
  private cancelTransform() {
    const t = this.transform;
    if (!t) return;
    this.transform = null;
    this.engine.setPreview(null, null);
    if (t.lifted) {
      t.lifted.layer.tex = t.lifted.original;
      this.doc.layers.splice(this.doc.layers.indexOf(t.target), 1);
      this.engine.deleteTexture(t.lifted.hole);
      this.engine.deleteTexture(t.target.tex);
    }
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Bakes the transform: new pixels (and mask, and selection) in one History step. */
  private commitTransform(label?: string) {
    const t = this.transform;
    if (!t) return;
    if (isIdentityParams(t.params)) return this.cancelTransform();
    this.transform = null;
    this.engine.setPreview(null, null);
    const map = transformMap(t.box, t.params);
    const max = this.engine.gpu.maxTexture;
    const out = outBounds(t.box, t.params);
    if (out.w > max || out.h > max) {
      this.host.toast(`That's larger than this computer's graphics can hold (${max} px).`);
      this.transform = t;
      this.engine.setPreview(t.target, map);
      return;
    }
    const W = this.doc.width, H = this.doc.height;
    const tex = this.engine.affineTexture(t.target, map, out);
    let selAfter: Selection | null = this.selection;
    if (this.selection) {
      // The selection follows the pixels.
      const selSurface: Surface = { tex: this.engine.layerTexture(W, H, greyRgba(this.selection.data)), x: 0, y: 0, width: W, height: H };
      const moved = this.engine.affineTexture(selSurface, map, { x: 0, y: 0, w: W, h: H });
      const rgba = this.engine.readTexture(moved, { x: 0, y: 0, w: W, h: H });
      this.engine.deleteTexture(selSurface.tex);
      this.engine.deleteTexture(moved);
      const data = new Uint8Array(W * H);
      for (let i = 0; i < data.length; i++) data[i] = Math.round((rgba[i * 4] * rgba[i * 4 + 3]) / 255);
      selAfter = makeSelection(data, W, H);
    }
    if (t.lifted) {
      const { layer, original, hole } = t.lifted;
      // The snapshot before the lift: the floating piece leaves, the original pixels come back.
      this.doc.layers.splice(this.doc.layers.indexOf(t.target), 1);
      layer.tex = original;
      const before = this.snapshot();
      const holeLayer: PixelLayer = { ...layer, tex: hole, opacity: 1, blend: "normal", mask: null, clip: false, parent: null };
      const piece: PixelLayer = { ...t.target, tex, x: out.x, y: out.y, width: out.w, height: out.h, opacity: 1, blend: "normal", mask: null, clip: false, parent: null };
      const merged = this.merged([holeLayer, piece], layer.name);
      const replaced: PixelLayer = { ...layer, id: merged.id, tex: merged.tex, x: 0, y: 0, width: W, height: H, source: null, raw: null };
      this.doc.layers[this.doc.layers.indexOf(layer)] = replaced;
      this.activeIndex = this.doc.layers.indexOf(replaced);
      this.engine.deleteTexture(hole);
      this.engine.deleteTexture(tex);
      this.engine.deleteTexture(t.target.tex);
      this.recordLayers(label ?? (t.quick ? "Move" : "Free Transform"), t.quick ? "phMove" : "phTransform", before, { before: this.selection, after: selAfter });
      this.setSelectionState(selAfter);
    } else {
      const layer = t.target;
      const before = this.snapshot();
      let mask: LayerMask | null = null;
      if (layer.mask) {
        const m = layer.mask;
        // The mask moves with the layer: the same map, over its own rectangle.
        const corners4 = [[m.x, m.y], [m.x + m.width, m.y], [m.x, m.y + m.height], [m.x + m.width, m.y + m.height]].map(([x, y]) => [map[0] * x + map[2] * y + map[4], map[1] * x + map[3] * y + map[5]]);
        const xs = corners4.map((c) => c[0]), ys = corners4.map((c) => c[1]);
        const mr = { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)), w: 0, h: 0 };
        mr.w = Math.max(1, Math.ceil(Math.max(...xs)) - mr.x);
        mr.h = Math.max(1, Math.ceil(Math.max(...ys)) - mr.y);
        if (mr.w <= max && mr.h <= max) mask = { ...m, tex: this.engine.affineTexture(m, map, mr, [m.fill, m.fill, m.fill, 1]), x: mr.x, y: mr.y, width: mr.w, height: mr.h };
      }
      const replaced: PixelLayer = { ...layer, id: this.nextId++, tex, x: out.x, y: out.y, width: out.w, height: out.h, source: null, mask, raw: null };
      if (layer.source) this.host.toast(`“${layer.name}” was rasterized to transform it.`);
      this.doc.layers[this.doc.layers.indexOf(layer)] = replaced;
      this.activeIndex = this.doc.layers.indexOf(replaced);
      this.recordLayers(label ?? (t.quick ? "Move" : "Free Transform"), t.quick ? "phMove" : "phTransform", before, this.selection ? { before: this.selection, after: selAfter } : undefined);
      this.setSelectionState(selAfter);
    }
    this.engine.invalidate();
    this.refreshAll();
  }

  /** A transform applied at once (Flip Layer, Rotate Layer 90°). */
  private quickTransform(params: TransformParams, label: string) {
    if (!this.startTransform(false)) return;
    this.transform!.params = params;
    this.commitTransform(label);
  }

  // ---- text and shapes

  /** Starts typing on a text layer (`layer`), or a new one at (x, y). */
  private editText(layer: PixelLayer | null, x = 0, y = 0) {
    this.commitText();
    let isNew = false;
    let before: Snapshot | null = null;
    if (!layer) {
      before = this.snapshot();
      const t = this.settings.text;
      const source: TextSource = { kind: "text", text: "", font: t.font, size: t.size, color: this.settings.fg, bold: t.bold, italic: t.italic, align: t.align, lineHeight: t.lineHeight, x, y };
      const drawn = drawText({ ...source, text: " " });
      layer = { ...this.pixelLayer("Text", drawn.x, drawn.y, drawn.width, drawn.height, null), source };
      this.insertLayer(layer);
      isNew = true;
    } else {
      this.activeIndex = this.doc.layers.indexOf(layer);
      this.editMask = false;
    }
    const source = layer.source as TextSource;
    const box = h("div", { class: "ph-text-edit", contenteditable: "plaintext-only", spellcheck: "false" });
    box.textContent = source.text;
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.commitText(true);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.commitText();
      }
    });
    box.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.stage.append(box);
    layer.visible = false;
    this.textEdit = { layer, box, isNew, before };
    this.placeTextBox();
    this.engine.invalidate();
    this.refreshAll();
    const focus = () => {
      if (this.textEdit?.box !== box) return;
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    focus();
    setTimeout(focus, 0);
  }

  /** Puts the typing box where the text sits, at the zoom. */
  private placeTextBox() {
    const edit = this.textEdit;
    if (!edit) return;
    const s = edit.layer.source as TextSource;
    const v = this.viewState();
    const k = v.scale / this.dpr;
    const box = edit.box;
    box.style.left = `${(v.x + s.x * v.scale) / this.dpr}px`;
    box.style.top = `${(v.y + s.y * v.scale) / this.dpr}px`;
    box.style.font = `${s.italic ? "italic " : ""}${s.bold ? "700 " : "400 "}${s.size * k}px ${fontFamily(s.font)}`;
    box.style.lineHeight = String(s.lineHeight);
    box.style.color = s.color;
    box.style.textAlign = s.align;
    box.style.transform = s.align === "center" ? "translateX(-50%)" : s.align === "right" ? "translateX(-100%)" : "";
  }

  /** Ends typing: keeps the text (or drops it with `cancel`). */
  private commitText(cancel = false) {
    const edit = this.textEdit;
    if (!edit) return;
    this.textEdit = null;
    const { layer, box, isNew, before } = edit;
    const text = (box.innerText ?? box.textContent ?? "").replace(/\n$/, "");
    box.remove();
    layer.visible = true;
    const source = layer.source as TextSource;
    if (isNew && (cancel || !text.trim())) {
      // Nothing typed: the new layer goes away unrecorded.
      this.doc.layers.splice(this.doc.layers.indexOf(layer), 1);
      this.engine.deleteTexture(layer.tex);
      this.activeIndex = Math.max(0, Math.min(this.activeIndex, this.doc.layers.length - 1));
      this.engine.invalidate();
      this.refreshAll();
      return;
    }
    if (cancel || text === source.text) {
      this.engine.invalidate();
      this.refreshAll();
      return;
    }
    if (isNew && before) {
      this.setSourceDrawn(layer, { ...source, text });
      layer.name = text.split("\n")[0].slice(0, 40) || "Text";
      this.recordLayers("Type Layer", "phText", before);
    } else this.changeSource(layer, { ...source, text }, "Edit Type");
    this.refreshAll();
  }

  /** Draws a source into a layer's pixels (replacing its texture). */
  private setSourceDrawn(layer: PixelLayer, source: TextSource | ShapeSource) {
    const drawn = source.kind === "text" ? drawText(source) : drawShape(source);
    this.engine.deleteTexture(layer.tex);
    Object.assign(layer, { source, tex: this.engine.layerTexture(drawn.width, drawn.height, drawn.rgba), x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height });
    this.touched(layer);
  }

  /** A text or shape layer's settings changed: drawn again, recorded. */
  private changeSource(layer: PixelLayer, next: TextSource | ShapeSource, label: string) {
    const old = { source: layer.source, tex: layer.tex, x: layer.x, y: layer.y, width: layer.width, height: layer.height };
    const drawn = next.kind === "text" ? drawText(next) : drawShape(next);
    const now = { source: next, tex: this.engine.layerTexture(drawn.width, drawn.height, drawn.rgba), x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height };
    Object.assign(layer, now);
    this.recordChange(label, next.kind === "text" ? "phText" : "phShape", (after) => {
      Object.assign(layer, after ? now : old);
      this.touched(layer);
    }, old.width * old.height * 4, (applied) => this.engine.deleteTexture(applied ? old.tex : now.tex));
    this.touched(layer);
  }

  /** The topmost text layer at a document point. */
  private textLayerAt(x: number, y: number): PixelLayer | null {
    for (let i = this.doc.layers.length - 1; i >= 0; i--) {
      const l = this.doc.layers[i];
      if (l.kind !== "pixel" || l.source?.kind !== "text" || !l.visible) continue;
      if (x >= l.x && y >= l.y && x < l.x + l.width && y < l.y + l.height) return l;
    }
    return null;
  }

  /** The text tool's options changed: they apply to the chosen text layer too. */
  private textOptionsChanged() {
    const layer = this.pixelTarget;
    const t = this.settings.text;
    if (this.textEdit) {
      Object.assign(this.textEdit.layer.source as TextSource, { font: t.font, size: t.size, bold: t.bold, italic: t.italic, align: t.align, lineHeight: t.lineHeight, color: this.settings.fg });
      this.placeTextBox();
      return;
    }
    if (layer?.source?.kind === "text") this.changeSource(layer, { ...layer.source, font: t.font, size: t.size, bold: t.bold, italic: t.italic, align: t.align, lineHeight: t.lineHeight }, "Character Change");
  }

  private shapeOptionsChanged() {
    const layer = this.pixelTarget;
    if (layer?.source?.kind !== "shape") return;
    const s = this.settings.shape;
    this.changeSource(layer, { ...layer.source, shape: s.shape, fill: s.fill ? layer.source.fill ?? this.settings.fg : null, stroke: s.stroke ? layer.source.stroke ?? this.settings.bg : null, strokeWidth: s.strokeWidth, radius: s.radius, sides: s.sides }, "Shape Change");
  }

  private makeShape(from: [number, number], to: [number, number], square: boolean) {
    let w = to[0] - from[0], hgt = to[1] - from[1];
    const s = this.settings.shape;
    if (square && s.shape !== "line") {
      const m = Math.max(Math.abs(w), Math.abs(hgt));
      w = Math.sign(w || 1) * m;
      hgt = Math.sign(hgt || 1) * m;
    }
    if (Math.abs(w) < 2 && Math.abs(hgt) < 2) return;
    if (!s.fill && !s.stroke) return this.host.toast("Turn on the shape's fill or stroke first.");
    const source: ShapeSource = { kind: "shape", shape: s.shape, x: from[0], y: from[1], w, h: hgt, sides: s.sides, radius: s.radius, fill: s.fill && s.shape !== "line" ? this.settings.fg : null, stroke: s.stroke || s.shape === "line" ? (s.shape === "line" && !s.stroke ? this.settings.fg : this.settings.bg) : null, strokeWidth: s.shape === "line" ? Math.max(1, s.strokeWidth) : s.strokeWidth };
    const drawn = drawShape(source);
    if (!this.fits(drawn.width * drawn.height * 4)) return;
    const before = this.snapshot();
    const count = this.doc.layers.filter((l) => l.kind === "pixel" && l.source?.kind === "shape").length + 1;
    const layer: PixelLayer = { ...this.pixelLayer(`${SHAPES.find((x) => x.id === s.shape)!.label} ${count}`, drawn.x, drawn.y, drawn.width, drawn.height, drawn.rgba), source };
    this.insertLayer(layer);
    this.recordLayers("Shape Layer", "phShape", before);
    this.engine.invalidate();
    this.refreshAll();
  }

  // ---- tools

  private selectTool(tool: Tool) {
    if (this.settings.tool !== tool) {
      this.settings.tool = tool;
      this.saveSettings();
    }
    if (tool !== "text") this.commitText();
    if (this.transform && !this.transform.quick) this.commitTransform();
    if (tool !== "polyLasso") this.poly = null;
    if (tool !== "objectSelect") this.objectSession = null;
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
    const buttons: HTMLElement[] = [];
    for (const t of TOOL_ORDER) {
      if (TOOL_BREAKS.has(t) && buttons.length) buttons.push(h("div", { class: "ph-tools-gap" }));
      const info = TOOL_INFO[t];
      buttons.push(h("button", { class: `ph-tool${t === tool ? " active" : ""}`, type: "button", title: `${info.label} (${info.key})`, "aria-label": info.label, onclick: () => this.selectTool(t) }, icon(info.icon, 17)));
    }
    const colorInput = (which: "fg" | "bg") => {
      const input = h("input", { type: "color", class: "ph-color-input", value: this.settings[which], "aria-label": which === "fg" ? "Foreground colour" : "Background colour" });
      input.addEventListener("input", () => {
        this.settings[which] = input.value;
        this.saveSettings();
        this.drawTools();
        if (which === "fg" && this.textEdit) this.textOptionsChanged();
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
  private option(label: string, value: number, min: number, max: number, unit: string, set: (v: number) => void, done?: () => void) {
    const range = h("input", { type: "range", class: "ph-opt-range", min, max, step: 1, value, "aria-label": label });
    const box = h("input", { type: "number", class: "ph-opt-number", min, max, step: 1, value: Math.round(value), "aria-label": label });
    range.addEventListener("input", () => {
      box.value = range.value;
      set(Number(range.value));
    });
    if (done) range.addEventListener("change", done);
    box.addEventListener("change", () => {
      const v = clamp(Math.round(Number(box.value) || min), min, max);
      box.value = range.value = String(v);
      set(v);
      done?.();
    });
    return h("label", { class: "ph-opt" }, h("span", null, label), range, box, unit ? h("span", { class: "ph-opt-unit" }, unit) : null);
  }

  private check(label: string, value: boolean, set: (v: boolean) => void) {
    const input = h("input", { type: "checkbox", checked: value });
    input.addEventListener("change", () => set(input.checked));
    return h("label", { class: "ph-opt ph-opt-check" }, input, label);
  }

  private segmented<T extends string>(items: { id: T; label: string; icon?: IconName }[], value: T, set: (v: T) => void) {
    return h("div", { class: "segmented small" }, ...items.map((it) =>
      h("button", { type: "button", class: it.id === value ? "active" : "", title: it.label, onclick: () => set(it.id) }, it.icon ? icon(it.icon, 14) : it.label)));
  }

  private drawOptions() {
    const s = this.settings;
    const tool = s.tool;
    const info = TOOL_INFO[tool];
    const parts: (HTMLElement | null)[] = [h("span", { class: "ph-opt-tool" }, icon(info.icon, 16), info.label)];
    const save = () => this.saveSettings();
    const t = this.transform;
    if (t && !t.quick) {
      const p = t.params;
      const num = (label: string, value: number, unit: string, set: (v: number) => void, digits = 0) => {
        const box = h("input", { type: "number", class: "ph-opt-number wide", value: Number(value.toFixed(digits)), step: digits ? 0.1 : 1, "aria-label": label });
        box.addEventListener("change", () => set(Number(box.value) || 0));
        return h("label", { class: "ph-opt" }, h("span", null, label), box, h("span", { class: "ph-opt-unit" }, unit));
      };
      parts.splice(0, 1, h("span", { class: "ph-opt-tool" }, icon("phTransform", 16), "Free Transform"),
        num("X", t.box.x + t.box.w / 2 + p.tx, "px", (v) => this.updateTransform({ ...p, tx: v - t.box.x - t.box.w / 2 })),
        num("Y", t.box.y + t.box.h / 2 + p.ty, "px", (v) => this.updateTransform({ ...p, ty: v - t.box.y - t.box.h / 2 })),
        num("W", p.sx * 100, "%", (v) => this.updateTransform({ ...p, sx: Math.max(0.1, v) / 100 }), 1),
        num("H", p.sy * 100, "%", (v) => this.updateTransform({ ...p, sy: Math.max(0.1, v) / 100 }), 1),
        num("Angle", (p.angle * 180) / Math.PI, "°", (v) => this.updateTransform({ ...p, angle: (v * Math.PI) / 180 }), 1),
        h("button", { class: "icon-btn small", type: "button", title: "Flip horizontal", onclick: () => this.updateTransform({ ...p, flipX: !p.flipX }) }, icon("phFlipH", 15)),
        h("button", { class: "icon-btn small", type: "button", title: "Flip vertical", onclick: () => this.updateTransform({ ...p, flipY: !p.flipY }) }, icon("phFlipV", 15)),
        h("span", { class: "ph-opt-note" }, "Drag a corner (Shift: free), outside to rotate, Ctrl+top/bottom edge to skew."),
        h("span", { class: "spacer" }),
        h("button", { class: "btn small", type: "button", onclick: () => this.cancelTransform() }, icon("close", 13), "Cancel"),
        h("button", { class: "btn small primary", type: "button", onclick: () => this.commitTransform() }, icon("check", 13), "Commit"));
      this.optionsBar.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
      return;
    }
    if (tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal") {
      const b = s[tool];
      parts.push(
        this.option("Size", b.size, 1, 1000, "px", (v) => ((b.size = v), save(), this.drawOverlay())),
        this.option("Hardness", b.hardness, 0, 100, "%", (v) => ((b.hardness = v), save())),
        tool === "heal" ? null : this.option("Opacity", b.opacity, 1, 100, "%", (v) => ((b.opacity = v), save())),
        tool === "heal" ? null : this.option("Flow", b.flow, 1, 100, "%", (v) => ((b.flow = v), save())));
      if (tool === "clone" || tool === "heal") {
        const c = s[tool];
        parts.push(this.check("Aligned", c.aligned, (v) => ((c.aligned = v), (this.cloneOffset = null), save())),
          h("span", { class: "ph-opt-note" }, this.cloneSource ? "Alt+click to pick a new source." : "Alt+click where to copy from first."));
      }
      if (this.editMask && this.layer?.mask) parts.push(h("span", { class: "ph-opt-note mask" }, icon("phMask", 13), "Painting on the mask: black hides, white shows."));
    } else if (tool === "remove") {
      parts.push(
        this.option("Size", s.remove.size, 1, 1000, "px", (v) => ((s.remove.size = v), save(), this.drawOverlay())),
        h("span", { class: "ph-opt-note" }, "Paint over what to remove: when you let go, it's filled from what's around it (AI, on this computer)."));
    } else if (tool === "objectSelect") {
      parts.push(this.segmented(SELECT_MODES, s.select.mode, (v) => ((s.select.mode = v), save(), this.drawOptions())),
        h("button", { class: "btn small", type: "button", onclick: () => void this.selectSubject() }, icon("phSubject", 13), "Select Subject"),
        h("span", { class: "ph-opt-note" }, this.objectSession?.points.length
          ? "Click to add more of the object, Alt+click to take a part away, Shift+click for another object."
          : "Click an object to select it (AI, on this computer). Alt+click takes a part away; Shift+click adds another object."));
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
    } else if (tool === "marquee" || tool === "ellipse" || tool === "lasso" || tool === "polyLasso" || tool === "wand") {
      parts.push(this.segmented(SELECT_MODES, s.select.mode, (v) => ((s.select.mode = v), save(), this.drawOptions())));
      if (tool === "wand") {
        parts.push(
          this.option("Tolerance", s.wand.tolerance, 0, 255, "", (v) => ((s.wand.tolerance = v), save())),
          this.check("Contiguous", s.wand.contiguous, (v) => ((s.wand.contiguous = v), save())),
          this.check("Sample all layers", s.wand.allLayers, (v) => ((s.wand.allLayers = v), save())));
      } else parts.push(this.option("Feather", s.select.feather, 0, 250, "px", (v) => ((s.select.feather = v), save())));
      parts.push(h("span", { class: "ph-opt-note" }, tool === "polyLasso" ? "Click the corners; double-click or Enter closes. Shift adds, Alt subtracts." : "Shift adds to the selection, Alt subtracts."));
    } else if (tool === "text") {
      const tx = s.text;
      const font = h("select", { class: "ph-select small", "aria-label": "Font" }, ...FONTS.map((f) => h("option", { value: f }, f)));
      font.value = tx.font;
      font.addEventListener("change", () => ((tx.font = font.value), save(), this.textOptionsChanged()));
      const toggle = (label: string, on: boolean, set: (v: boolean) => void, letter: string) =>
        h("button", { class: `ph-letter${on ? " active" : ""}${letter === "I" ? " italic" : ""}`, type: "button", title: label, "aria-pressed": String(on), onclick: () => (set(!on), save(), this.textOptionsChanged(), this.drawOptions()) }, letter);
      parts.push(font,
        this.option("Size", tx.size, 4, 1000, "px", (v) => ((tx.size = v), save()), () => this.textOptionsChanged()),
        toggle("Bold", tx.bold, (v) => (tx.bold = v), "B"),
        toggle("Italic", tx.italic, (v) => (tx.italic = v), "I"),
        this.segmented([{ id: "left", label: "Left", icon: "alignLeft" }, { id: "center", label: "Centre", icon: "alignCenter" }, { id: "right", label: "Right", icon: "alignRight" }], tx.align, (v) => ((tx.align = v), save(), this.textOptionsChanged(), this.drawOptions())),
        h("span", { class: "ph-opt-note" }, this.textEdit ? "Ctrl+Enter keeps the text, Esc undoes the typing." : "Click to type; click text to edit it. The colour is the foreground."));
      if (this.textEdit) parts.push(h("span", { class: "spacer" }), h("button", { class: "btn small primary", type: "button", onclick: () => this.commitText() }, icon("check", 13), "Done"));
    } else if (tool === "shape") {
      const sh = s.shape;
      parts.push(this.segmented(SHAPES.map((x) => ({ id: x.id, label: x.label })), sh.shape, (v) => ((sh.shape = v), save(), this.shapeOptionsChanged(), this.drawOptions())),
        this.check("Fill", sh.fill, (v) => ((sh.fill = v), save(), this.shapeOptionsChanged())),
        this.check("Stroke", sh.stroke, (v) => ((sh.stroke = v), save(), this.shapeOptionsChanged())),
        this.option("Width", sh.strokeWidth, 0, 200, "px", (v) => ((sh.strokeWidth = v), save()), () => this.shapeOptionsChanged()),
        sh.shape === "rect" ? this.option("Radius", sh.radius, 0, 500, "px", (v) => ((sh.radius = v), save()), () => this.shapeOptionsChanged()) : null,
        sh.shape === "polygon" ? this.option("Sides", sh.sides, 3, 32, "", (v) => ((sh.sides = v), save()), () => this.shapeOptionsChanged()) : null,
        h("span", { class: "ph-opt-note" }, "Fill uses the foreground colour, stroke the background. Shift keeps it square."));
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
      const layer = this.layer;
      parts.push(h("span", { class: "ph-opt-note" }, !layer ? "" : this.selection && layer.kind === "pixel" ? "Drag to move the selected pixels. Ctrl+T transforms them." : layer.kind === "adjust" ? "Choose a pixel layer or group to move." : `Drag to move “${layer.name}”. Arrow keys nudge by 1 px (Shift: 10).`),
        layer?.kind === "pixel" ? h("button", { class: "btn small", type: "button", onclick: () => this.startTransform(false) }, icon("phTransform", 13), "Transform") : null);
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
    const tool = this.settings.tool;
    if (tool === "move" || tool === "crop" || tool === "brush" || tool === "eraser" || tool === "text" || this.transform) this.drawOptions();
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
    const target = this.layer ? `${this.layer.name}${this.editMask && this.layer.mask ? " (mask)" : ""}` : "";
    this.titleName.textContent = this.title();
    this.titleState.textContent = `${Math.round(this.zoom * 100) / 100 === 1 ? "100" : Math.round(this.zoom * 1000) / 10}% · ${target}${this.dirty() ? " · Edited" : ""}`;
  }

  private drawStatus() {
    this.statusZoom.textContent = `${formatZoom(this.zoom)}`;
    this.statusSize.textContent = `${this.doc.width} × ${this.doc.height} px`;
    this.statusMemory.textContent = `Memory ${sizeText(this.memoryUse())} of ${sizeText(BUDGET)}`;
    const sel = this.selection?.bounds;
    this.statusSelection.textContent = sel ? `Selection ${sel.w} × ${sel.h}` : "";
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
    // Blend mode and opacity of the chosen layer; groups add Pass Through.
    const blend = h("select", { class: "ph-select small", "aria-label": "Blend mode", disabled: !layer },
      ...(layer?.kind === "group" ? [h("option", { value: "passThrough" }, "Pass Through"), h("option", { disabled: true }, "──────────")] : []),
      ...BLEND_GROUPS.flatMap((group, gi) => [
        ...(gi ? [h("option", { disabled: true }, "──────────")] : []),
        ...group.map((m) => h("option", { value: m.id }, m.label)),
      ]));
    if (layer) blend.value = layer.kind === "group" && layer.passThrough ? "passThrough" : layer.blend;
    blend.addEventListener("change", () => {
      if (!layer) return;
      if (layer.kind === "group") this.setPassThrough(layer, blend.value === "passThrough", blend.value === "passThrough" ? layer.blend : (blend.value as Layer["blend"]));
      else this.setLayerProp(layer, "blend", blend.value as Layer["blend"], "Blending Change");
    });
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

    const layers = this.doc.layers;
    const rows: HTMLElement[] = [];
    for (let index = layers.length - 1; index >= 0; index--) {
      const l = layers[index];
      if (isFolded(layers, l)) continue;
      const depth = depthOf(layers, l);
      const eye = h("button", { class: `ph-eye${l.visible ? "" : " off"}`, type: "button", title: l.visible ? "Hide" : "Show", "aria-label": l.visible ? "Hide layer" : "Show layer" }, icon(l.visible ? "eye" : "eyeOff", 14));
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setLayerProp(l, "visible", !l.visible, l.visible ? "Hide Layer" : "Show Layer");
      });
      const name = h("span", { class: "ph-layer-name" }, l.name);
      const active = index === this.activeIndex;
      const fold = l.kind === "group"
        ? h("button", { class: `ph-fold${l.open ? " open" : ""}`, type: "button", "aria-label": l.open ? "Close group" : "Open group", onclick: (e: MouseEvent) => {
          e.stopPropagation();
          l.open = !l.open;
          this.drawLayers();
        } }, icon("chevronRight", 12))
        : null;
      const thumb = this.thumbFor(l);
      thumb.classList.toggle("target", active && !(this.editMask && l.mask));
      thumb.addEventListener("click", (e) => {
        if (e.ctrlKey && l.kind === "pixel") {
          e.stopPropagation();
          this.selectLayerPixels(l);
        }
      });
      const maskThumb = l.mask ? this.maskThumbFor(l) : null;
      maskThumb?.classList.toggle("target", active && this.editMask);
      maskThumb?.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.shiftKey) {
          this.activeIndex = index;
          this.toggleMask();
          return;
        }
        this.activeIndex = index;
        this.editMask = true;
        this.refreshAll();
      });
      const row = h("div", { class: `ph-layer${active ? " active" : ""}${l.visible ? "" : " hidden-layer"}${l.kind === "group" ? " group" : ""}`, "data-index": String(index), role: "button", tabindex: "-1" },
        eye,
        h("span", { class: "ph-indent", style: { width: `${depth * 14}px` } }),
        fold,
        l.clip ? h("span", { class: "ph-clip-mark", title: "Clipped to the layer below" }, icon("phClip", 12)) : null,
        thumb, maskThumb, name,
        l.blend !== "normal" || l.opacity < 1 ? h("span", { class: "ph-layer-meta" }, `${l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : ""}`) : null);
      row.addEventListener("dblclick", (e) => {
        if (l.kind === "pixel" && l.source?.kind === "text" && (e.target as HTMLElement).closest(".ph-thumb")) {
          this.selectTool("text");
          this.editText(l);
          return;
        }
        this.renameLayer(l, name);
      });
      row.addEventListener("pointerdown", (e) => this.layerPointerDown(e, index, row));
      rows.push(row);
    }
    this.layersBody.replaceChildren(...rows);
  }

  /** Clicking a row picks the layer; dragging moves it above, below or into a group. */
  private layerPointerDown(e: PointerEvent, index: number, row: HTMLElement) {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".ph-eye, .ph-fold, input")) return;
    const startY = e.clientY;
    let dragging = false;
    const rows = [...this.layersBody.children] as HTMLElement[];
    let drop: { index: number; where: "above" | "below" | "into" } | null = null;
    const find = (y: number) => {
      for (const r of rows) {
        const box = r.getBoundingClientRect();
        if (y < box.top || y >= box.bottom) continue;
        const i = Number(r.dataset.index);
        const rel = (y - box.top) / box.height;
        const target = this.doc.layers[i];
        if (target?.kind === "group" && rel > 0.3 && rel < 0.7) return { index: i, where: "into" as const };
        return { index: i, where: rel < 0.5 ? ("above" as const) : ("below" as const) };
      }
      const last = rows[rows.length - 1];
      return last && y >= last.getBoundingClientRect().bottom ? { index: Number(last.dataset.index), where: "below" as const } : null;
    };
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientY - startY) > 4) {
        dragging = true;
        row.classList.add("dragging");
      }
      if (!dragging) return;
      drop = find(ev.clientY);
      for (const r of rows) {
        const on = !!drop && Number(r.dataset.index) === drop.index && drop.index !== index;
        r.classList.toggle("drop-above", on && drop!.where === "above");
        r.classList.toggle("drop-below", on && drop!.where === "below");
        r.classList.toggle("drop-into", on && drop!.where === "into");
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (dragging && drop && drop.index !== index) {
        const target = this.doc.layers[drop.index];
        if (drop.where === "into") this.moveTo(index, drop.index, target.id, "Layer Order");
        else if (drop.where === "above") this.moveTo(index, drop.index + 1, target.parent, "Layer Order");
        else this.moveTo(index, blockOf(this.doc.layers, drop.index)[0], target.parent, "Layer Order");
      } else if (dragging) this.drawLayers();
      else {
        const onThumb = !!(e.target as HTMLElement).closest(".ph-thumb:not(.mask)");
        if (index !== this.activeIndex || (onThumb && this.editMask)) {
          if (this.transform) this.commitTransform();
          this.commitText();
          this.activeIndex = index;
          this.editMask = false;
          this.refreshAll();
        }
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
    if (layer.kind === "adjust") return h("span", { class: "ph-thumb adjust" }, icon(adjIcon(layer.spec.type), 16));
    if (layer.kind === "group") return h("span", { class: "ph-thumb group" }, icon("phGroup", 16));
    if (layer.source?.kind === "text") return h("span", { class: "ph-thumb text" }, icon("phText", 16));
    return this.cachedThumb(`p${layer.id}`, this.versions.get(layer.id) ?? 0, "ph-thumb");
  }

  private maskThumbFor(layer: Layer): HTMLElement {
    const el = this.cachedThumb(`m${layer.id}`, this.maskVersions.get(layer.id) ?? 0, "ph-thumb mask");
    el.classList.toggle("off", !layer.mask?.enabled);
    el.title = layer.mask?.enabled ? "Layer mask: click to paint on it, Shift+click to turn it off" : "Layer mask (off): Shift+click to turn it on";
    return el;
  }

  private cachedThumb(key: string, version: number, cls: string): HTMLCanvasElement {
    let cached = this.thumbs.get(key);
    if (!cached) {
      cached = { version: -1, canvas: h("canvas", { class: cls }) };
      this.thumbs.set(key, cached);
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
    const draw = (key: string, version: number, s: Surface, mask: LayerMask | null) => {
      const cached = this.thumbs.get(key);
      if (!cached || cached.version === version) return;
      // The surface as it sits in the document, letterboxed in the box.
      const k = box / Math.max(this.doc.width, this.doc.height);
      const w = Math.max(1, Math.round(s.width * k)), hgt = Math.max(1, Math.round(s.height * k));
      const pixels = this.engine.thumbnail(s.tex, s.width, s.height, w, hgt);
      const c = cached.canvas;
      c.width = c.height = box;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, box, box);
      const dw = Math.round(this.doc.width * k), dh = Math.round(this.doc.height * k);
      const ox = Math.round((box - dw) / 2), oy = Math.round((box - dh) / 2);
      if (mask) {
        const f = Math.round(mask.fill * 255);
        ctx.fillStyle = `rgb(${f}, ${f}, ${f})`;
        ctx.fillRect(ox, oy, dw, dh);
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(ox, oy, dw, dh);
        ctx.fillStyle = "#cccccc";
        const cell = Math.max(2, Math.round(4 * dpr));
        for (let y = 0; y < dh; y += cell) for (let x = (y / cell) % 2 ? cell : 0; x < dw; x += cell * 2) ctx.fillRect(ox + x, oy + y, Math.min(cell, dw - x), Math.min(cell, dh - y));
      }
      const img = new ImageData(new Uint8ClampedArray(pixels), w, hgt);
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = hgt;
      tmp.getContext("2d")!.putImageData(img, 0, 0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, dw, dh);
      ctx.clip();
      ctx.drawImage(tmp, ox + Math.round(s.x * k), oy + Math.round(s.y * k));
      ctx.restore();
      cached.version = version;
    };
    for (const layer of this.doc.layers) {
      if (layer.kind === "pixel") draw(`p${layer.id}`, this.versions.get(layer.id) ?? 0, layer, null);
      if (layer.mask) draw(`m${layer.id}`, this.maskVersions.get(layer.id) ?? 0, layer.mask, layer.mask);
    }
  }

  /** What lies below an adjustment layer, as histograms (red, green, blue, brightness). */
  private histogramBelow(layer: Layer): Uint32Array[] {
    const was = layer.visible;
    layer.visible = false;
    this.engine.invalidate();
    const k = 256 / Math.max(this.doc.width, this.doc.height);
    const w = Math.max(1, Math.round(this.doc.width * Math.min(1, k))), hgt = Math.max(1, Math.round(this.doc.height * Math.min(1, k)));
    const rgba = this.engine.compositeThumbnail(this.doc, w, hgt);
    layer.visible = was;
    this.engine.invalidate();
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 8) continue;
      bins[0][rgba[i]]++;
      bins[1][rgba[i + 1]]++;
      bins[2][rgba[i + 2]]++;
      bins[3][Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2])]++;
    }
    return bins;
  }

  /** The Properties panel: the chosen adjustment's controls, the mask's, or the adjustments to add. */
  private drawProps() {
    const layer = this.layer;
    if (this.editMask && layer?.mask) {
      const mask = layer.mask;
      this.propsTitle.textContent = "Layer Mask";
      this.propsBody.replaceChildren(
        h("p", { class: "ph-empty" }, "Paint black to hide this layer, white to show it, grey for in between. Filters, fills and gradients work on the mask too."),
        h("div", { class: "ph-props-actions wrap" },
          h("button", { class: "btn small", type: "button", onclick: () => this.invertMask() }, icon("phInvert", 13), "Invert"),
          h("button", { class: "btn small", type: "button", onclick: () => this.toggleMask() }, icon("phMask", 13), mask.enabled ? "Disable" : "Enable"),
          h("button", { class: "btn small", type: "button", onclick: () => this.selectFromMask() }, icon("phMarquee", 13), "To Selection"),
          layer.kind === "pixel" ? h("button", { class: "btn small", type: "button", onclick: () => this.applyMask() }, icon("check", 13), "Apply") : null,
          h("button", { class: "btn small", type: "button", onclick: () => this.deleteMask() }, icon("trash", 13), "Delete")));
      return;
    }
    if (layer?.kind === "pixel" && layer.raw) {
      const raw = layer.raw;
      this.propsTitle.textContent = "Develop";
      const info = this.rawInfo.get(raw.path) ?? null;
      if (!info) void rawApi.info(raw.path).then((i) => (this.rawInfo.set(raw.path, i), this.layer === layer && this.drawProps()), () => undefined);
      this.propsBody.replaceChildren(
        ...developPanel(raw, info, { change: (next, label, final) => this.developChanged(layer, next, label, final) }),
        h("p", { class: "ph-empty" }, "Developing again replaces this layer's pixels: paint and retouch on a layer above."),
        this.quickActions());
      return;
    }
    if (layer?.kind !== "adjust") {
      this.propsTitle.textContent = "Adjustments";
      const grid = h("div", { class: "ph-adjust-grid" }, ...ADJ_TYPES.map((t) =>
        h("button", { class: "icon-btn", type: "button", title: `Add ${t.label}`, "aria-label": `Add ${t.label}`, onclick: () => this.newAdjustLayer(t.type) }, icon(t.icon, 17))));
      const note = layer?.kind === "pixel" && layer.source?.kind === "text"
        ? h("p", { class: "ph-empty" }, "A type layer. Double-click its thumbnail, or click the text with the Type tool, to edit it.")
        : h("p", { class: "ph-empty" }, this.selection ? "Add an adjustment: it applies inside the selection." : "Add an adjustment layer: it changes everything below it and can be changed later.");
      this.propsBody.replaceChildren(note, grid,
        h("div", { class: "ph-props-actions" }, h("button", { class: "btn small", type: "button", onclick: () => this.autoTone() }, icon("sparkles", 13), "Auto Tone")),
        ...(layer?.kind === "pixel" ? [this.quickActions()] : []));
      return;
    }
    this.propsTitle.textContent = adjLabel(layer.spec.type);
    let before = JSON.stringify({ a: layer.adjust, s: layer.spec });
    const commit = (label: string) => {
      const now = JSON.stringify({ a: layer.adjust, s: layer.spec });
      if (now === before) return;
      const old = JSON.parse(before) as { a: Adjustments; s: AdjSpec };
      const next = JSON.parse(now) as { a: Adjustments; s: AdjSpec };
      before = now;
      const set = (s: { a: Adjustments; s: AdjSpec }) => {
        layer.adjust = { ...s.a };
        layer.spec = cloneSpec(s.s);
      };
      // The same setting changed again within a moment (arrow keys on a slider): one step.
      const last = this.history.last;
      const recent = this.lastAdjust;
      if (last && recent && recent.step === last && recent.layer === layer && recent.label === label && Date.now() - recent.time < 1500) {
        recent.next = next;
        recent.time = Date.now();
        this.drawStatus();
        return;
      }
      const entry = { step: null as unknown as object, layer, label, time: Date.now(), next };
      this.recordChange(label, adjIcon(layer.spec.type), (after) => set(after ? entry.next : old));
      entry.step = this.history.last!;
      this.lastAdjust = entry;
      this.drawStatus();
    };
    const live = () => {
      this.engine.invalidate();
      this.render();
    };
    const editor = specEditor(layer.spec, { live, commit: (label) => commit(label), histogram: () => this.histogramBelow(layer) });
    if (editor) {
      this.propsBody.replaceChildren(...editor);
      return;
    }
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

  // ---- AI tools (aimodels.ts; they run on this computer)

  /** Remove Background and Select Subject, as Photoshop's Properties panel offers them. */
  private quickActions(): HTMLElement {
    return h("div", { class: "ph-prop-group" }, h("h4", null, "Quick Actions"),
      h("div", { class: "ph-props-actions wrap" },
        h("button", { class: "btn small", type: "button", onclick: () => void this.removeBackground() }, icon("phSubject", 13), "Remove Background"),
        h("button", { class: "btn small", type: "button", onclick: () => void this.selectSubject() }, icon("phMarquee", 13), "Select Subject")));
  }

  /** The faster subject finder when Settings → Photo says so. */
  private subjectTool(): "subject" | "subject-fast" {
    return normalizePhotoSettings(this.host.shell.config.studio.apps.photo).ai.subject === "fast" ? "subject-fast" : "subject";
  }

  /** Runs one AI step with the spinner; errors become a message. */
  private async aiStep<T>(text: string, work: () => Promise<T>): Promise<T | null> {
    if (this.aiWorking) return null;
    this.aiWorking = true;
    try {
      return await this.withBusy(text, work);
    } catch (err) {
      this.host.toast(errorText(err));
      return null;
    } finally {
      this.aiWorking = false;
    }
  }

  /** The main subject's mask for RGBA pixels, at their size. */
  private async subjectOf(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
    const small = shrinkRgba(rgba, width, height, 2048);
    const found = await aiApi.subject(small.rgba, small.width, small.height, this.subjectTool() === "subject-fast");
    return growMask(found, small.width, small.height, width, height);
  }

  /** Layer ▸ Remove Background: a mask that hides everything but the subject (no pixel is lost). */
  private async removeBackground() {
    const layer = this.pixelTarget;
    if (!layer) return this.host.toast("Choose a pixel layer: Remove Background gives it a mask that hides the background.");
    if (layer.mask) return this.host.toast("This layer already has a mask. Delete it first, or paint on it.");
    const W = this.doc.width, H = this.doc.height;
    if (!this.fits(W * H * 4)) return;
    if (!(await ensureModels(this.subjectTool(), "subject finder"))) return;
    const mask = await this.aiStep("Finding the subject…", async () => {
      const local = await this.subjectOf(this.engine.readTexture(layer.tex, { x: 0, y: 0, w: layer.width, h: layer.height }), layer.width, layer.height);
      // The mask covers the canvas: the layer's place from the model, hidden elsewhere.
      const full = new Uint8Array(W * H);
      for (let y = 0; y < layer.height; y++) {
        const dy = y + layer.y;
        if (dy < 0 || dy >= H) continue;
        for (let x = 0; x < layer.width; x++) {
          const dx = x + layer.x;
          if (dx >= 0 && dx < W) full[dy * W + dx] = local[y * layer.width + x];
        }
      }
      return { tex: this.engine.layerTexture(W, H, greyRgba(full)), x: 0, y: 0, width: W, height: H, fill: 0, enabled: true } satisfies LayerMask;
    });
    if (!mask) return;
    layer.mask = mask;
    this.editMask = false;
    this.recordChange("Remove Background", "phSubject", (after) => (layer.mask = after ? mask : null), W * H * 4, (applied) => {
      if (!applied) this.engine.deleteTexture(mask.tex);
    });
    this.engine.invalidate();
    this.refreshAll();
  }

  /** Select ▸ Subject: the main subject of what the picture shows, as a new selection. */
  private async selectSubject() {
    const W = this.doc.width, H = this.doc.height;
    if (!(await ensureModels(this.subjectTool(), "subject finder"))) return;
    const mask = await this.aiStep("Finding the subject…", () => this.subjectOf(this.engine.flatten(this.doc), W, H));
    if (!mask) return;
    const feather = this.settings.select.feather;
    this.settings.select.feather = 0;
    this.applySelection(mask, "new", "Select Subject", "phSubject");
    this.settings.select.feather = feather;
  }

  /** What the picture looks like now, as a key: layers, their settings and pixel versions. */
  private compositeKey(): string {
    return `${this.doc.width}x${this.doc.height}|` + this.doc.layers.map((l) => [l.id, l.visible ? 1 : 0, l.opacity, l.blend, l.parent ?? "", l.clip ? 1 : 0,
      this.versions.get(l.id) ?? 0, l.mask ? `${l.mask.enabled ? 1 : 0}${this.maskVersions.get(l.id) ?? 0}` : "-",
      l.kind === "adjust" ? JSON.stringify([l.adjust, l.spec]) : l.kind === "pixel" ? `${l.x},${l.y}` : ""].join(":")).join("|");
  }

  /** Object Selection: each click refines the object MobileSAM finds; Shift starts another. */
  private async objectSelectClick(p: { x: number; y: number }, e: PointerEvent) {
    const W = this.doc.width, H = this.doc.height;
    if (this.aiWorking || p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
    const alt = e.altKey, shift = e.shiftKey;
    if (!(await ensureModels("select", "object selection"))) return;
    const key = this.compositeKey();
    let s = this.objectSession;
    const sameLook = !!s && s.key === key;
    if (!s || !sameLook || shift || this.selection !== s.result) {
      // A new object: on top of the selection there is now, as the options bar says.
      const mode: SelectMode = shift ? "add" : this.settings.select.mode;
      s = { key, token: sameLook && s ? s.token : 0, width: sameLook && s ? s.width : 0, height: sameLook && s ? s.height : 0, points: [], base: this.selection, mode, result: null };
    }
    const session = s;
    const mask = await this.aiStep(session.token ? "Selecting…" : "Looking at the picture…", async () => {
      if (!session.token) {
        // The model works at 1024 px: send it no more.
        const small = shrinkRgba(this.engine.flatten(this.doc), W, H, 1024);
        session.token = await aiApi.samEmbed(small.rgba, small.width, small.height);
        session.width = small.width;
        session.height = small.height;
      }
      session.points.push({ x: (p.x * session.width) / W, y: (p.y * session.height) / H, add: !alt });
      const found = await aiApi.samMask(session.token, session.points);
      return growMask(found, session.width, session.height, W, H);
    });
    if (!mask) {
      if (session.points.length && !session.result) session.points.pop();
      return;
    }
    const next = makeSelection(combine(session.base?.data ?? null, mask, session.mode), W, H);
    this.changeSelection(next, "Object Selection", "phObjectSelect");
    session.result = this.selection;
    this.objectSession = session;
    this.drawOptions();
    this.drawOverlay();
  }

  /** The Remove tool: what was painted over is filled from around it (MI-GAN, on this computer). */
  private async removeObject(drag: Extract<Drag, { kind: "remove" }>) {
    const layer = drag.layer;
    const size = this.settings.remove.size;
    const r = size / 2;
    const xs = drag.points.map(([x]) => x - layer.x), ys = drag.points.map(([, y]) => y - layer.y);
    const bx0 = Math.max(0, Math.floor(Math.min(...xs) - r)), by0 = Math.max(0, Math.floor(Math.min(...ys) - r));
    const bx1 = Math.min(layer.width, Math.ceil(Math.max(...xs) + r)), by1 = Math.min(layer.height, Math.ceil(Math.max(...ys) + r));
    if (bx1 <= bx0 || by1 <= by0) return;
    if (!(await ensureModels("remove", "object remover"))) return;
    // What the model sees: the painted area with room around it (about 3.2 times its size).
    const side = Math.min(Math.max(layer.width, layer.height), Math.max(512, Math.round(Math.max(bx1 - bx0, by1 - by0) * 3.2)));
    const cw = Math.min(side, layer.width), ch = Math.min(side, layer.height);
    const cx = clamp(Math.round((bx0 + bx1) / 2 - cw / 2), 0, layer.width - cw), cy = clamp(Math.round((by0 + by1) / 2 - ch / 2), 0, layer.height - ch);
    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext("2d")!;
    ctx.strokeStyle = ctx.fillStyle = "#ffffff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = size;
    ctx.beginPath();
    drag.points.forEach(([x, y], i) => (i ? ctx.lineTo(x - layer.x - cx, y - layer.y - cy) : ctx.moveTo(x - layer.x - cx, y - layer.y - cy)));
    if (drag.points.length === 1) {
      ctx.arc(drag.points[0][0] - layer.x - cx, drag.points[0][1] - layer.y - cy, r, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.stroke();
    const painted = ctx.getImageData(0, 0, cw, ch).data;
    const mask = new Uint8Array(cw * ch);
    for (let i = 0; i < mask.length; i++) mask[i] = painted[i * 4 + 3];
    const region = this.engine.readTexture(layer.tex, { x: cx, y: cy, w: cw, h: ch });
    const patch = await this.aiStep("Removing…", () => aiApi.inpaint(region, mask, cw, ch));
    if (!patch) return;
    const rect = { x: cx + patch.x, y: cy + patch.y, w: patch.width, h: patch.height };
    const before = this.engine.readTexture(layer.tex, rect);
    this.engine.writeTexture(layer.tex, rect, patch.rgba);
    this.recordPixels("Remove", "phRemove", layer, false, rect, before);
    this.touched(layer, false);
  }

  // ---- RAW files (develop.ts)

  /** The Develop panel changed a setting: develop again (soon while dragging); one History step per change. */
  private developChanged(layer: PixelLayer, next: DevelopSettings, label: string, final: boolean) {
    const raw = layer.raw;
    if (!raw) return;
    if (!this.developStart) this.developStart = { ...raw.settings };
    raw.settings = { ...next };
    clearTimeout(this.developTimer);
    if (!final) {
      this.developTimer = window.setTimeout(() => this.redevelop(layer), 200);
      return;
    }
    const before = this.developStart;
    this.developStart = null;
    this.redevelop(layer);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    this.recordChange(label, "phDevelop", (after) => {
      raw.settings = { ...(after ? next : before) };
      this.redevelop(layer);
      if (this.layer === layer) this.drawProps();
    });
  }

  /** Develops the layer's RAW file again with its settings (the latest request wins). */
  private redevelop(layer: PixelLayer) {
    const raw = layer.raw;
    if (!raw) return;
    const wanted = JSON.stringify(raw.settings);
    this.developQueue = this.developQueue.then(async () => {
      if (layer.raw !== raw || JSON.stringify(raw.settings) !== wanted) return;
      const d = await rawApi.develop(raw.path, raw.settings, this.engine.gpu.maxTexture);
      if (d.width !== layer.width || d.height !== layer.height) throw new Error("The RAW file changed size since it was opened.");
      this.engine.writeTexture(layer.tex, { x: 0, y: 0, w: d.width, h: d.height }, d.rgba);
      // The document takes the colour space the RAW file was developed into.
      if (this.doc.layers[0] === layer) this.icc = d.icc.slice();
      this.touched(layer, false);
    }).catch((err) => this.host.toast(`Couldn’t develop the RAW file: ${errorText(err)}`));
  }

  private iconButton(glyph: IconName, title: string, run: (e: MouseEvent) => void) {
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
    this.viewChanged();
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
    this.viewChanged();
  }

  private viewChanged() {
    this.drawStatus();
    this.drawTitle();
    this.placeTextBox();
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const v = this.viewState();
    const d = this.dpr;
    const toScreen = (x: number, y: number): [number, number] => [v.x + x * v.scale, v.y + y * v.scale];
    // The canvas edge.
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(v.x - 0.5, v.y - 0.5, this.doc.width * v.scale + 1, this.doc.height * v.scale + 1);
    const tool = this.settings.tool;
    // Marching ants.
    if (this.selectionPath) {
      ctx.save();
      ctx.setTransform(v.scale, 0, 0, v.scale, v.x, v.y);
      ctx.lineWidth = d / v.scale;
      ctx.strokeStyle = "#000000";
      ctx.stroke(this.selectionPath);
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([(4 * d) / v.scale, (4 * d) / v.scale]);
      ctx.lineDashOffset = (-this.antsPhase * d) / v.scale;
      ctx.stroke(this.selectionPath);
      ctx.restore();
    }
    const dashed = (draw: () => void) => {
      ctx.lineWidth = d;
      ctx.setLineDash([]);
      ctx.strokeStyle = "#000000";
      draw();
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([4 * d, 4 * d]);
      draw();
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const drag = this.drag;
    if (drag?.kind === "select") {
      const x0 = Math.min(drag.from[0], drag.to[0]), y0 = Math.min(drag.from[1], drag.to[1]);
      const [sx, sy] = toScreen(x0, y0);
      const w = Math.abs(drag.to[0] - drag.from[0]) * v.scale, hgt = Math.abs(drag.to[1] - drag.from[1]) * v.scale;
      dashed(() => {
        ctx.beginPath();
        if (drag.ellipse) ctx.ellipse(sx + w / 2, sy + hgt / 2, Math.max(0.5, w / 2), Math.max(0.5, hgt / 2), 0, 0, Math.PI * 2);
        else ctx.rect(sx, sy, w, hgt);
      });
    }
    if (drag?.kind === "lasso" && drag.points.length > 1) {
      dashed(() => {
        ctx.beginPath();
        drag.points.forEach(([x, y], i) => (i ? ctx.lineTo(...toScreen(x, y)) : ctx.moveTo(...toScreen(x, y))));
      });
    }
    if (this.poly && this.poly.points.length) {
      const pts = this.poly.points;
      dashed(() => {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(...toScreen(x, y)) : ctx.moveTo(...toScreen(x, y))));
        if (this.pointer.inside) ctx.lineTo(this.pointer.x * d, this.pointer.y * d);
      });
      const [fx, fy] = toScreen(pts[0][0], pts[0][1]);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(fx - 3 * d, fy - 3 * d, 6 * d, 6 * d);
    }
    if (drag?.kind === "shape") {
      const [x0, y0] = toScreen(drag.from[0], drag.from[1]);
      const [x1, y1] = toScreen(drag.to[0], drag.to[1]);
      const shape = this.settings.shape.shape;
      dashed(() => {
        ctx.beginPath();
        if (shape === "line") {
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        } else if (shape === "ellipse") ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(0.5, Math.abs(x1 - x0) / 2), Math.max(0.5, Math.abs(y1 - y0) / 2), 0, 0, Math.PI * 2);
        else ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      });
    }
    // Free Transform's box and handles.
    const t = this.transform;
    if (t && !t.quick) {
      const pts = corners(t.box, t.params).map(([x, y]) => toScreen(x, y));
      ctx.lineWidth = d;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([3 * d, 3 * d]);
      ctx.stroke();
      ctx.setLineDash([]);
      const s = 8 * d;
      for (const hd of HANDLES) {
        const [x, y] = toScreen(...handlePoint(t.box, t.params, hd.hx, hd.hy));
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
        ctx.strokeRect(x - s / 2, y - s / 2, s, s);
      }
      const [cx, cy] = toScreen(t.box.x + t.box.w / 2 + t.params.tx, t.box.y + t.box.h / 2 + t.params.ty);
      ctx.strokeStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, 4 * d, 0, Math.PI * 2);
      ctx.stroke();
    }
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
      for (const k of [1 / 3, 2 / 3]) {
        ctx.moveTo(x + w * k, y);
        ctx.lineTo(x + w * k, y + hgt);
        ctx.moveTo(x, y + hgt * k);
        ctx.lineTo(x + w, y + hgt * k);
      }
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5 * d;
      ctx.strokeRect(x, y, w, hgt);
      ctx.fillStyle = "#ffffff";
      const s = 7 * d;
      for (const [hx, hy] of [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + hgt / 2], [x + w, y + hgt], [x + w / 2, y + hgt], [x, y + hgt], [x, y + hgt / 2]]) ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
    }
    if (drag?.kind === "remove") {
      // What will be removed, in translucent red as Photoshop paints it.
      ctx.save();
      ctx.strokeStyle = "rgba(255, 60, 90, 0.45)";
      ctx.fillStyle = "rgba(255, 60, 90, 0.45)";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = this.settings.remove.size * v.scale;
      ctx.beginPath();
      drag.points.forEach(([x, y], i) => (i ? ctx.lineTo(...toScreen(x, y)) : ctx.moveTo(...toScreen(x, y))));
      if (drag.points.length === 1) {
        const [x, y] = toScreen(drag.points[0][0], drag.points[0][1]);
        ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.stroke();
      ctx.restore();
    }
    if (this.objectSession && tool === "objectSelect" && this.objectSession.result === this.selection) {
      const s = this.objectSession;
      for (const pt of s.points) {
        const [x, y] = toScreen((pt.x * this.doc.width) / s.width, (pt.y * this.doc.height) / s.height);
        ctx.fillStyle = pt.add ? "#34c759" : "#ff3b30";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5 * d;
        ctx.beginPath();
        ctx.arc(x, y, 4.5 * d, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    const brushLike = tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal" || tool === "remove";
    if (brushLike && this.pointer.inside && !this.spaceHeld) {
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
      // Where the clone stamp copies from.
      if ((tool === "clone" || tool === "heal") && this.cloneSource) {
        const p = this.docPoint({ clientX: this.pointer.x + this.stage.getBoundingClientRect().left, clientY: this.pointer.y + this.stage.getBoundingClientRect().top });
        const off = this.drag?.kind === "paint" ? this.drag.offset : this.cloneOffset;
        const [sx, sy] = off ? toScreen(p.x + off[0], p.y + off[1]) : toScreen(this.cloneSource[0], this.cloneSource[1]);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = d;
        ctx.beginPath();
        ctx.moveTo(sx - 7 * d, sy);
        ctx.lineTo(sx + 7 * d, sy);
        ctx.moveTo(sx, sy - 7 * d);
        ctx.lineTo(sx, sy + 7 * d);
        ctx.stroke();
      }
    }
    if (drag?.kind === "gradient" && this.gradientTo) {
      const s = drag.target.surface;
      const [ax, ay] = toScreen(drag.from[0] + s.x, drag.from[1] + s.y);
      const [bx, by] = toScreen(this.gradientTo[0] + s.x, this.gradientTo[1] + s.y);
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

  private updateCursor() {
    const tool = this.settings.tool;
    const cursor = this.drag?.kind === "pan" ? "grabbing"
      : this.spaceHeld || tool === "hand" ? "grab"
      : tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal" || tool === "remove" ? "none"
      : tool === "zoom" ? "zoom-in"
      : tool === "move" ? "move"
      : tool === "text" ? "text"
      : "crosshair";
    this.stage.style.cursor = cursor;
  }

  // ---- pointer

  private bindStage() {
    const stage = this.stage;
    stage.addEventListener("pointerdown", (e) => this.pointerDown(e));
    stage.addEventListener("pointermove", (e) => this.pointerMove(e));
    stage.addEventListener("pointerup", (e) => this.endDrag(true, e));
    stage.addEventListener("pointercancel", () => this.endDrag(false));
    stage.addEventListener("dblclick", (e) => {
      if (this.poly) {
        e.preventDefault();
        this.finishPoly();
      }
    });
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
        this.viewChanged();
      }
    }, { passive: false });
    stage.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private selectMode(e: PointerEvent): SelectMode {
    if (e.shiftKey && e.altKey) return "intersect";
    if (e.shiftKey) return "add";
    if (e.altKey) return "subtract";
    return this.settings.select.mode;
  }

  private pointerDown(e: PointerEvent) {
    if (this.busy || this.drag) return;
    this.stage.focus({ preventScroll: true });
    const tool = this.settings.tool;
    const p = this.docPoint(e);
    if (e.button === 1 || (e.button === 0 && (this.spaceHeld || tool === "hand"))) {
      this.drag = { kind: "pan", x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy };
      this.stage.setPointerCapture(e.pointerId);
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    if (this.textEdit && tool !== "text") this.commitText();
    // Free Transform takes the pointer while it's on.
    const t = this.transform;
    if (t && !t.quick) {
      const drag = hitTransform(t.box, t.params, p.x, p.y, (9 * this.dpr) / this.zoom, e.ctrlKey || e.metaKey);
      this.drag = { kind: "transform", drag };
      this.stage.style.cursor = transformCursor(drag);
      this.stage.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === "zoom") {
      this.zoomStep(e.altKey ? -1 : 1, e);
      return;
    }
    if (tool === "eyedropper" || ((tool === "brush" || tool === "gradient" || tool === "bucket") && e.altKey)) {
      this.pick(p);
      this.drag = { kind: "pick" };
    } else if ((tool === "clone" || tool === "heal") && e.altKey) {
      this.cloneSource = [p.x, p.y];
      this.cloneOffset = null;
      this.host.toast("Source set: now paint where it should go.");
      this.drawOptions();
      return;
    } else if (tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal") {
      const target = this.paintableTarget();
      if (!target) return;
      const brush = { ...this.settings[tool] };
      let offset: [number, number] = [0, 0];
      if (tool === "clone" || tool === "heal") {
        if (!this.cloneSource) return this.host.toast("Alt+click where to copy from first.");
        const aligned = this.settings[tool].aligned;
        offset = aligned && this.cloneOffset ? this.cloneOffset : [Math.round(this.cloneSource[0] - p.x), Math.round(this.cloneSource[1] - p.y)];
        if (aligned) this.cloneOffset = offset;
      }
      const opacity = brush.opacity / 100;
      const paint: Paint = tool === "clone" || tool === "heal"
        ? { kind: "clone", layer: target.layer, mask: target.mask, offset, opacity: tool === "heal" ? 1 : opacity }
        : tool === "brush"
          ? { kind: "brush", layer: target.layer, mask: target.mask, color: target.mask ? grey(this.settings.fg) : hexToRgb(this.settings.fg), opacity }
          : target.mask
            // An eraser on a mask paints the background colour, as in Photoshop.
            ? { kind: "brush", layer: target.layer, mask: true, color: grey(this.settings.bg), opacity }
            : { kind: "erase", layer: target.layer, mask: false, opacity };
      this.engine.beginPaint(this.doc, paint, brush.hardness / 100);
      const s = target.surface;
      const start = { x: p.x - s.x, y: p.y - s.y };
      this.drag = { kind: "paint", target, last: start, rest: 0, brush, pen: e.pointerType === "pen", tool, offset };
      this.engine.addDabs([this.dab(start.x, start.y, brush, e)]);
      this.render();
    } else if (tool === "gradient") {
      const target = this.paintableTarget();
      if (!target) return;
      const g = this.settings.gradient;
      const fg = target.mask ? grey(this.settings.fg) : hexToRgb(this.settings.fg);
      const end = g.transparent ? [...fg, 0] : [...(target.mask ? grey(this.settings.bg) : hexToRgb(this.settings.bg)), 1];
      const s = target.surface;
      const from: [number, number] = [p.x - s.x, p.y - s.y];
      this.engine.beginPaint(this.doc, { kind: "gradient", layer: target.layer, mask: target.mask, from, to: from, a: [...fg, 1] as [number, number, number, number], b: end as [number, number, number, number], radial: g.radial, opacity: g.opacity / 100 });
      this.drag = { kind: "gradient", target, from };
      this.gradientTo = from;
    } else if (tool === "bucket") {
      this.bucket(p);
      return;
    } else if (tool === "move") {
      const layer = this.layer;
      if (!layer) return;
      if (this.selection && layer.kind === "pixel" && !this.editMask) {
        // Moving selected pixels lifts them, as Free Transform does.
        if (!this.startTransform(true)) return;
        this.drag = { kind: "transform", drag: { mode: "move", start: [p.x, p.y], from: { ...IDENTITY_PARAMS } } };
      } else {
        const layers = (layer.kind === "group" ? [layer, ...descendants(this.doc.layers, this.activeIndex)] : [layer])
          .filter((l) => l.kind === "pixel" || l.mask)
          .map((l) => ({ layer: l, ox: l.kind === "pixel" ? l.x : 0, oy: l.kind === "pixel" ? l.y : 0, mx: l.mask?.x ?? 0, my: l.mask?.y ?? 0 }));
        if (!layers.length) return this.host.toast("Choose a pixel layer or a group to move.");
        this.engine.beginLive(this.doc, layer.kind === "group" ? blockOf(this.doc.layers, this.activeIndex)[0] : this.activeIndex);
        this.drag = { kind: "move", layers, x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
      }
    } else if (tool === "crop") {
      this.drag = { kind: "crop", mode: this.cropHit(e), start: this.crop ? { ...this.crop } : { x: p.x, y: p.y, w: 0, h: 0 }, x: p.x, y: p.y };
    } else if (tool === "marquee" || tool === "ellipse") {
      const q: [number, number] = [Math.round(p.x), Math.round(p.y)];
      this.drag = { kind: "select", ellipse: tool === "ellipse", from: q, to: q, mode: this.selectMode(e) };
    } else if (tool === "lasso") {
      this.drag = { kind: "lasso", points: [[p.x, p.y]], mode: this.selectMode(e) };
    } else if (tool === "polyLasso") {
      const pt: [number, number] = [p.x, p.y];
      if (!this.poly) this.poly = { points: [pt], mode: this.selectMode(e) };
      else {
        const first = this.poly.points[0];
        const near = Math.hypot(first[0] - p.x, first[1] - p.y) * this.zoom < 8 * this.dpr;
        if (near && this.poly.points.length >= 3) this.finishPoly();
        else this.poly.points.push(pt);
      }
      this.drawOverlay();
      return;
    } else if (tool === "wand") {
      this.magicWand(p, this.selectMode(e));
      return;
    } else if (tool === "objectSelect") {
      void this.objectSelectClick(p, e);
      return;
    } else if (tool === "remove") {
      const target = this.paintableTarget();
      if (!target) return;
      if (target.mask || target.layer.kind !== "pixel") return this.host.toast("Remove works on a layer's pixels: click the layer's thumbnail, not its mask.");
      this.drag = { kind: "remove", layer: target.layer, points: [[p.x, p.y]] };
      this.drawOverlay();
    } else if (tool === "text") {
      // The browser would move the focus to the canvas after this; the typing box keeps it.
      e.preventDefault();
      if (this.textEdit) {
        this.commitText();
        return;
      }
      const hit = this.textLayerAt(p.x, p.y);
      this.editText(hit, Math.round(p.x), Math.round(p.y));
      return;
    } else if (tool === "shape") {
      this.drag = { kind: "shape", from: [p.x, p.y], to: [p.x, p.y] };
    } else return;
    this.stage.setPointerCapture(e.pointerId);
    this.updateCursor();
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
      const tool = this.settings.tool;
      if (tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal" || tool === "remove" || this.poly) this.drawOverlay();
      if (tool === "crop") this.stage.style.cursor = cropCursor(this.cropHit(e));
      const t = this.transform;
      if (t && !t.quick) this.stage.style.cursor = transformCursor(hitTransform(t.box, t.params, p.x, p.y, (9 * this.dpr) / this.zoom, e.ctrlKey || e.metaKey));
      return;
    }
    if (drag.kind === "pan") {
      this.cx = drag.cx - ((e.clientX - drag.x) * this.dpr) / this.zoom;
      this.cy = drag.cy - ((e.clientY - drag.y) * this.dpr) / this.zoom;
      this.fitted = false;
      this.placeTextBox();
      this.render();
    } else if (drag.kind === "pick") {
      this.pick(p);
    } else if (drag.kind === "paint") {
      const events = e.getCoalescedEvents?.() ?? [e];
      const dabs: Dab[] = [];
      const s = drag.target.surface;
      for (const ev of events.length ? events : [e]) {
        const q = this.docPoint(ev);
        const to = { x: q.x - s.x, y: q.y - s.y };
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
      const s = drag.target.surface;
      let to: [number, number] = [p.x - s.x, p.y - s.y];
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
      const dx = Math.round(((e.clientX - drag.x) * this.dpr) / this.zoom), dy = Math.round(((e.clientY - drag.y) * this.dpr) / this.zoom);
      if (dx === drag.dx && dy === drag.dy) return;
      drag.dx = dx;
      drag.dy = dy;
      let area: Rect | null = null;
      for (const m of drag.layers) {
        const l = m.layer;
        if (l.kind === "pixel") {
          area = union(area, { x: l.x, y: l.y, w: l.width, h: l.height });
          l.x = m.ox + dx;
          l.y = m.oy + dy;
          area = union(area, { x: l.x, y: l.y, w: l.width, h: l.height });
        }
        if (l.mask) {
          area = union(area, { x: l.mask.x, y: l.mask.y, w: l.mask.width, h: l.mask.height });
          l.mask.x = m.mx + dx;
          l.mask.y = m.my + dy;
          area = union(area, { x: l.mask.x, y: l.mask.y, w: l.mask.width, h: l.mask.height });
        }
      }
      // A mask's fill reaches past its rectangle, so a moved mask can change anything.
      if (drag.layers.some((m) => m.layer.mask && m.layer.mask.fill < 1) || !area) this.engine.touch();
      else this.engine.touch(area);
      this.render();
    } else if (drag.kind === "crop") {
      this.crop = this.dragCrop(drag, p);
      this.drawOptions();
      this.render();
    } else if (drag.kind === "select") {
      let to: [number, number] = [Math.round(p.x), Math.round(p.y)];
      if (e.shiftKey && drag.mode !== "add") {
        const m = Math.max(Math.abs(to[0] - drag.from[0]), Math.abs(to[1] - drag.from[1]));
        to = [drag.from[0] + Math.sign(to[0] - drag.from[0] || 1) * m, drag.from[1] + Math.sign(to[1] - drag.from[1] || 1) * m];
      }
      drag.to = to;
      this.drawOverlay();
    } else if (drag.kind === "lasso") {
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(last[0] - p.x, last[1] - p.y) * this.zoom >= this.dpr) {
        drag.points.push([p.x, p.y]);
        this.drawOverlay();
      }
    } else if (drag.kind === "remove") {
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(last[0] - p.x, last[1] - p.y) * this.zoom >= 2 * this.dpr) drag.points.push([p.x, p.y]);
      this.drawOverlay();
    } else if (drag.kind === "transform") {
      const t = this.transform;
      if (!t) return;
      this.updateTransform(dragTransform(t.box, drag.drag, p.x, p.y, e.shiftKey, e.shiftKey));
    } else if (drag.kind === "shape") {
      drag.to = [p.x, p.y];
      this.drawOverlay();
    }
  }

  private endDrag(keep: boolean, e?: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.kind === "remove") {
      if (keep) void this.removeObject(drag);
      this.drawOverlay();
      return;
    }
    if (drag.kind === "paint" || drag.kind === "gradient") {
      const target = drag.target;
      if (drag.kind === "paint" && drag.tool === "heal" && keep) this.finishHeal(drag);
      else {
        const moved = drag.kind === "paint" || (this.gradientTo && Math.hypot(this.gradientTo[0] - drag.from[0], this.gradientTo[1] - drag.from[1]) >= 2);
        const result = this.engine.endPaint(keep && !!moved);
        if (result) {
          const label = drag.kind === "gradient" ? "Gradient" : TOOL_INFO[drag.tool].label;
          const glyph: IconName = drag.kind === "gradient" ? "phGradient" : TOOL_INFO[drag.tool].icon;
          this.recordPixels(label, glyph, target.layer, target.mask, result.rect, result.before);
        }
      }
      this.gradientTo = null;
      this.touched(target.layer, target.mask);
    } else if (drag.kind === "move") {
      this.engine.endLive();
      const { dx, dy, layers: items } = drag;
      // Back to where they were; a kept move then shifts everything (sources and masks too) at once.
      for (const m of items) {
        if (m.layer.kind === "pixel") Object.assign(m.layer, { x: m.ox, y: m.oy });
        if (m.layer.mask) Object.assign(m.layer.mask, { x: m.mx, y: m.my });
      }
      if (keep && (dx || dy)) {
        const shift = (sign: number) => {
          for (const m of items) {
            const l = m.layer;
            if (l.kind === "pixel") {
              l.x += dx * sign;
              l.y += dy * sign;
              if (l.source) (l.source.x += dx * sign), (l.source.y += dy * sign);
            }
            if (l.mask) (l.mask.x += dx * sign), (l.mask.y += dy * sign);
          }
        };
        shift(1);
        let applied = true;
        this.recordChange("Move", "phMove", (after) => {
          if (after !== applied) shift(after ? 1 : -1);
          applied = after;
        });
      }
      for (const m of items) this.touched(m.layer, !!m.layer.mask);
    } else if (drag.kind === "crop") {
      if (this.crop && (this.crop.w < 1 || this.crop.h < 1)) this.crop = { ...drag.start };
      this.drawOptions();
    } else if (drag.kind === "select" && keep) {
      const x = Math.min(drag.from[0], drag.to[0]), y = Math.min(drag.from[1], drag.to[1]);
      const w = Math.abs(drag.to[0] - drag.from[0]), hgt = Math.abs(drag.to[1] - drag.from[1]);
      if (w < 1 || hgt < 1) {
        // A click without a drag deselects, as in Photoshop.
        if (drag.mode === "new") this.deselect();
      } else {
        const data = polygonMask(shapePoints({ x, y, w, h: hgt }, drag.ellipse), this.doc.width, this.doc.height);
        this.applySelection(data, drag.mode, drag.ellipse ? "Elliptical Marquee" : "Rectangular Marquee", drag.ellipse ? "phEllipse" : "phMarquee");
      }
    } else if (drag.kind === "lasso" && keep) {
      if (drag.points.length >= 3) this.applySelection(polygonMask(drag.points, this.doc.width, this.doc.height), drag.mode, "Lasso", "phLasso");
      else if (drag.mode === "new") this.deselect();
    } else if (drag.kind === "transform") {
      if (this.transform?.quick) {
        if (keep) this.commitTransform();
        else this.cancelTransform();
      }
    } else if (drag.kind === "shape" && keep) {
      this.makeShape(drag.from, drag.to, !!e?.shiftKey);
    }
    this.updateCursor();
    this.render();
  }

  /** The Healing Brush lets go: the copied stroke is blended into its surroundings. */
  private finishHeal(drag: Extract<Drag, { kind: "paint" }>) {
    const cover = this.engine.strokeCoverage();
    const s = drag.target.surface;
    this.engine.endPaint(false);
    if (!cover) return;
    const margin = 2;
    const rect = intersect({ x: cover.rect.x - margin, y: cover.rect.y - margin, w: cover.rect.w + margin * 2, h: cover.rect.h + margin * 2 }, { x: 0, y: 0, w: s.width, h: s.height });
    if (!rect) return;
    const dest = this.engine.readTexture(s.tex, rect);
    const [ox, oy] = drag.offset;
    // The source: the same piece moved by the offset; where it leaves the surface, the destination.
    const src = dest.slice();
    const from = intersect({ x: rect.x + ox, y: rect.y + oy, w: rect.w, h: rect.h }, { x: 0, y: 0, w: s.width, h: s.height });
    if (from) {
      const piece = this.engine.readTexture(s.tex, from);
      for (let y = 0; y < from.h; y++) src.set(piece.subarray(y * from.w * 4, (y + 1) * from.w * 4), ((y + from.y - oy - rect.y) * rect.w + (from.x - ox - rect.x)) * 4);
    }
    const coverage = new Uint8Array(rect.w * rect.h);
    for (let y = 0; y < cover.rect.h; y++) {
      for (let x = 0; x < cover.rect.w; x++) {
        const cx = x + cover.rect.x - rect.x, cy = y + cover.rect.y - rect.y;
        if (cx < 0 || cy < 0 || cx >= rect.w || cy >= rect.h) continue;
        coverage[cy * rect.w + cx] = Math.round(cover.alpha[y * cover.rect.w + x] * this.selAt(x + cover.rect.x + s.x, y + cover.rect.y + s.y));
      }
    }
    const healed = heal(dest, src, coverage, rect.w, rect.h, drag.brush.opacity / 100);
    this.engine.writeTexture(s.tex, rect, healed);
    this.recordPixels("Healing Brush", "phHeal", drag.target.layer, drag.target.mask, rect, dest);
  }

  private finishPoly() {
    const poly = this.poly;
    this.poly = null;
    if (!poly) return;
    if (poly.points.length >= 3) this.applySelection(polygonMask(poly.points, this.doc.width, this.doc.height), poly.mode, "Polygonal Lasso", "phPolyLasso");
    this.drawOverlay();
  }

  private magicWand(p: { x: number; y: number }, mode: SelectMode) {
    const W = this.doc.width, H = this.doc.height;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const s = this.settings.wand;
    const layer = this.pixelTarget;
    let area: Uint8Array | null = null;
    if (s.allLayers || !layer) {
      area = floodMask(this.engine.flatten(this.doc), W, H, x, y, s.tolerance, s.contiguous)?.mask ?? null;
    } else {
      const found = floodMask(this.engine.readTexture(layer.tex, { x: 0, y: 0, w: layer.width, h: layer.height }), layer.width, layer.height, x - layer.x, y - layer.y, s.tolerance, s.contiguous);
      if (found) {
        area = new Uint8Array(W * H);
        for (let ly = 0; ly < layer.height; ly++) {
          const dy = ly + layer.y;
          if (dy < 0 || dy >= H) continue;
          for (let lx = 0; lx < layer.width; lx++) {
            const dx = lx + layer.x;
            if (dx >= 0 && dx < W && found.mask[ly * layer.width + lx]) area[dy * W + dx] = 1;
          }
        }
      }
    }
    if (!area) return;
    for (let i = 0; i < area.length; i++) area[i] = area[i] ? 255 : 0;
    const before = this.settings.select.feather;
    this.settings.select.feather = 0;
    this.applySelection(area, mode, "Magic Wand", "phWand");
    this.settings.select.feather = before;
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
    const target = this.paintableTarget();
    if (!target) return;
    const s = this.settings.bucket;
    const surf = target.surface;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    const lx = x - surf.x, ly = y - surf.y;
    if (lx < 0 || ly < 0 || lx >= surf.width || ly >= surf.height) return;
    const whole = { x: 0, y: 0, w: surf.width, h: surf.height };
    // The area comes from the surface, or from what all layers show (Photoshop's "All Layers").
    const fromAll = s.allLayers && !target.mask;
    const source = fromAll ? this.engine.flatten(this.doc) : this.engine.readTexture(surf.tex, whole);
    const [sw, sh, sx, sy] = fromAll ? [this.doc.width, this.doc.height, x, y] : [surf.width, surf.height, lx, ly];
    const area = floodMask(source, sw, sh, sx, sy, s.tolerance, s.contiguous);
    if (!area) return;
    const offset = fromAll ? { x: surf.x, y: surf.y } : { x: 0, y: 0 };
    const rect = intersect({ x: area.rect.x - offset.x, y: area.rect.y - offset.y, w: area.rect.w, h: area.rect.h }, whole);
    if (!rect) return;
    const before = this.engine.readTexture(surf.tex, rect);
    const pixels = before.slice();
    const color = (target.mask ? grey(this.settings.fg) : hexToRgb(this.settings.fg)).map((v) => v * 255);
    const opacity = s.opacity / 100;
    for (let yy = 0; yy < rect.h; yy++) {
      for (let xx = 0; xx < rect.w; xx++) {
        if (!area.mask[(yy + rect.y + offset.y) * sw + xx + rect.x + offset.x]) continue;
        const a = opacity * this.selAt(xx + rect.x + surf.x, yy + rect.y + surf.y);
        if (a <= 0) continue;
        const i = (yy * rect.w + xx) * 4;
        const da = pixels[i + 3] / 255;
        const ao = a + da * (1 - a);
        for (let c = 0; c < 3; c++) pixels[i + c] = Math.round((color[c] * a + pixels[i + c] * da * (1 - a)) / Math.max(ao, 1e-6));
        pixels[i + 3] = Math.round(ao * 255);
      }
    }
    this.engine.writeTexture(surf.tex, rect, pixels);
    this.recordPixels("Paint Bucket", "bucket", target.layer, target.mask, rect, before);
    this.touched(target.layer, target.mask);
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
    // Typing whose box lost the focus still goes into the text, not to the tools.
    const edit = this.textEdit;
    if (edit && !mod && (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter" || e.key === "Escape")) {
      edit.box.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(edit.box);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      if (e.key === "Escape") this.commitText(true);
      else if (e.key === "Backspace") edit.box.textContent = (edit.box.textContent ?? "").slice(0, -1);
      else edit.box.textContent = `${edit.box.textContent ?? ""}${e.key === "Enter" ? "\n" : e.key}`;
      if (e.key !== "Escape") {
        const end = document.createRange();
        end.selectNodeContents(edit.box);
        end.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(end);
      }
      return true;
    }
    if (this.transform && !this.transform.quick) {
      if (e.key === "Enter") return this.commitTransform(), true;
      if (e.key === "Escape") return this.cancelTransform(), true;
    }
    if (this.poly) {
      if (e.key === "Enter") return this.finishPoly(), true;
      if (e.key === "Escape") return (this.poly = null), this.drawOverlay(), true;
      if (e.key === "Backspace" || e.key === "Delete") {
        this.poly.points.pop();
        if (!this.poly.points.length) this.poly = null;
        this.drawOverlay();
        return true;
      }
    }
    if (mod) {
      if (key === "z") return e.shiftKey ? this.history.redo() : this.history.undo(), true;
      if (key === "y") return this.history.redo(), true;
      if (key === "a") return this.changeSelection(selectAll(this.doc.width, this.doc.height), "Select All"), true;
      if (key === "d") {
        if (e.shiftKey) {
          if (this.lastSelection && !this.selection) this.changeSelection(this.lastSelection, "Reselect");
        } else this.deselect();
        return true;
      }
      if (key === "i") return e.shiftKey ? this.inverseSelection() : this.invertPixels(), true;
      if (key === "c") return this.copy(e.shiftKey, false), true;
      if (key === "x") return this.copy(false, true), true;
      if (key === "v") return void this.paste(), true;
      if (key === "t") return this.startTransform(false), true;
      if (key === "g") {
        if (e.altKey) this.toggleClip();
        else if (e.shiftKey) this.ungroup();
        else this.groupLayers();
        return true;
      }
      if (key === "f" && e.altKey && this.lastFilter) return void this.runFilter(this.lastFilter.kind, true), true;
      if (key === "j") return this.duplicateOrViaCopy(e.shiftKey), true;
      if (key === "n" && e.shiftKey) return this.newLayer(), true;
      if (key === "e") return e.shiftKey ? this.mergeVisible() : this.mergeDown(), true;
      if (e.key === "]") return this.arrange(1), true;
      if (e.key === "[") return this.arrange(-1), true;
      if (key === "0") return this.fit(true), true;
      if (key === "1") return this.zoomTo(1), true;
      if (key === "=" || key === "+") return this.zoomStep(1), true;
      if (key === "-") return this.zoomStep(-1), true;
      if (e.key === "Backspace") return this.fillSurface(this.settings.bg, "Fill"), true;
      return false;
    }
    if (e.altKey && e.key === "Backspace") return this.fillSurface(this.settings.fg, "Fill"), true;
    if ((e.key === "Delete" || e.key === "Backspace") && this.selection) return this.fillSurface(null, "Clear"), true;
    if (e.shiftKey && e.key === "F6") return void this.modifySelection("feather"), true;
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
    const cycle = (a: Tool, b: Tool) => this.selectTool(this.settings.tool === a && e.shiftKey ? b : this.settings.tool === b && e.shiftKey ? a : this.settings.tool === b ? b : a);
    if (key === "m") return cycle("marquee", "ellipse"), true;
    if (key === "l") return cycle("lasso", "polyLasso"), true;
    if (key === "w") return cycle("wand", "objectSelect"), true;
    if (key === "j") return cycle("heal", "remove"), true;
    const tools: Record<string, Tool> = { v: "move", c: "crop", b: "brush", e: "eraser", i: "eyedropper", h: "hand", z: "zoom", t: "text", u: "shape", s: "clone" };
    if (tools[key]) return this.selectTool(tools[key]), true;
    if (key === "g") return this.selectTool(this.settings.tool === "gradient" ? "bucket" : "gradient"), true;
    if (key === "x") return this.swapColors(), true;
    if (key === "d") return this.defaultColors(), true;
    if (key === "q" && this.layer?.mask) {
      this.editMask = !this.editMask;
      this.refreshAll();
      return true;
    }
    const tool = this.settings.tool;
    if ((tool === "brush" || tool === "eraser" || tool === "clone" || tool === "heal" || tool === "remove") && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}")) {
      const b = this.settings[tool] as { size: number; hardness?: number };
      const up = e.key === "]" || e.key === "}";
      if (e.shiftKey && b.hardness !== undefined) b.hardness = clamp(b.hardness + (up ? 25 : -25), 0, 100);
      else {
        const step = b.size < 10 ? 1 : b.size < 50 ? 5 : b.size < 200 ? 10 : 50;
        b.size = clamp(b.size + (up ? step : -step), 1, 1000);
      }
      this.saveSettings();
      this.drawOptions();
      this.drawOverlay();
      return true;
    }
    if ((tool === "brush" || tool === "eraser" || tool === "clone") && /^[0-9]$/.test(e.key)) {
      this.settings[tool].opacity = e.key === "0" ? 100 : Number(e.key) * 10;
      this.saveSettings();
      this.drawOptions();
      return true;
    }
    return false;
  }

  private nudge(key: string, by: number) {
    const layer = this.layer;
    if (!layer) return;
    const dx = key === "ArrowLeft" ? -by : key === "ArrowRight" ? by : 0, dy = key === "ArrowUp" ? -by : key === "ArrowDown" ? by : 0;
    if (this.selection && layer.kind === "pixel") {
      if (!this.startTransform(true)) return;
      this.transform!.params = { ...IDENTITY_PARAMS, tx: dx, ty: dy };
      this.commitTransform();
      return;
    }
    const items = (layer.kind === "group" ? [layer, ...descendants(this.doc.layers, this.activeIndex)] : [layer]).filter((l) => l.kind === "pixel" || l.mask);
    const shift = (sign: number) => {
      for (const l of items) {
        if (l.kind === "pixel") {
          l.x += dx * sign;
          l.y += dy * sign;
          if (l.source) (l.source.x += dx * sign), (l.source.y += dy * sign);
        }
        if (l.mask) (l.mask.x += dx * sign), (l.mask.y += dy * sign);
      }
    };
    shift(1);
    let applied = true;
    this.recordChange("Nudge", "phMove", (after) => {
      if (after !== applied) shift(after ? 1 : -1);
      applied = after;
    });
    for (const l of items) this.touched(l, !!l.mask);
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

/** A picture on the system clipboard (copied in another app), when the webview can read it. */
async function systemClipboardPicture(): Promise<{ x: number; y: number; width: number; height: number; rgba: Uint8Array } | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const bitmap = await createImageBitmap(await item.getType(type));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return { x: -1e9, y: -1e9, width: bitmap.width, height: bitmap.height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    }
  } catch {
    // No permission, or nothing there.
  }
  return null;
}
