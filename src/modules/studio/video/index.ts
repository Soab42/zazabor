import { api } from "../../../api";
import { open, save } from "../../../shared/dialog";
import { readText } from "../../../shared/quicklook/api";
import { basename, dirname, h, isTypingTarget, stripExtension } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { closeMenu, openMenu, type MenuItem } from "../../../ui/menu";
import { BUILTIN_MUSIC, THEMES, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import { openDialog } from "../../time/dialog";
import { errorText } from "../../time/api";
import type { Aspect, StudioApp, StudioFactory, StudioHost } from "../app";
import { detectBeats } from "./audio";
import { editApi } from "./api";
import { Engine, mainClipAt } from "./engine";
import { offerCodecInstall, openExport } from "./export";
import { usePrefs } from "./controls";
import { Inspector } from "./inspector";
import { MotionFeatures } from "./motion/editor";
import { templateOf } from "./motion/templates";
import { parseCube } from "./lut";
import { AUDIO_EXTENSIONS, MediaStore, PEAK_RATE, PICTURE_EXTENSIONS, probeMedia, VIDEO_EXTENSIONS } from "./media";
import {
  clipEnd, copyClips, findClip, insertMain, layoutMain, mainIndexAt, mainTrack, mediaClip, mediaOf, MIN_CLIP, newProject, newTrack, normalizeProject,
  pasteClips, placeAt, placeFree, projectDuration, remove, selectAllIds, setProp, sourceTime, split, TEXT_SECONDS, tidyTracks, touchesPrevious, trimEnd,
  trimStart, uid, defaultPlace,
  type Clip, type ClipCopy, type EffectId, type Media, type MediaClip, type Project, type TextClip, type Track,
} from "./model";
import { parseSrt, writeSrt } from "./srt";
import { CaptionsPanel } from "./captions";
import type { Cue } from "./api";
import { STICKER_SIZE, stickerOf } from "./stickers";
import { Panel, type TransitionSlot, type TransitionTarget } from "./panels";
import { TEXT_PRESETS } from "./text";
import { formatTime, Timeline } from "./timeline";
import "./video-editor.css";

/**
 * Studio's Video Editor: a CapCut-like editor for reels and videos. Media panel on the left,
 * the player in the middle, the inspector on the right, the timeline below. See
 * docs/plans/video-editor.md for what's built and what comes next.
 */

interface Settings {
  volume: number;
  /** The side panels' widths, and whether each is shown. */
  left: number;
  right: number;
  leftOpen: boolean;
  rightOpen: boolean;
  /** The left panel's category, and sub-tabs in it ("effects": Effects or Filters). */
  panelTab?: string;
  subTabs: Record<string, string>;
  /** The inspector's tab for each kind of clip, and the sections folded or opened by hand. */
  tabs: Record<string, string>;
  sections: Record<string, boolean>;
}

/** Side panel widths: default, least and most. */
const LEFT_W = [304, 296, 480] as const;
const RIGHT_W = [320, 280, 440] as const;
/** The preview keeps at least this much room; side panels fold away first. */
const MIN_PLAYER = 360;
const GUTTER = 6;

const record = <T>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> => {
  const out: Record<string, T> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (ok(x)) out[k] = x;
  return out;
};
const isString = (x: unknown): x is string => typeof x === "string";
const isBool = (x: unknown): x is boolean => typeof x === "boolean";
const width = (v: unknown, [def, lo, hi]: readonly [number, number, number]) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def);

const UNDO_LIMIT = 200;
/** AutoRecover keeps a snapshot of unsaved changes this often. */
const RECOVER_MS = 20_000;
/** A .srt or .cube file bigger than this isn't one. */
const TEXT_FILE_BYTES = 16 * 1024 * 1024;
/** A freeze frame's length when it's made. */
const FREEZE_SECONDS = 3;
/** Edits with the same key closer together than this are one undo step (dragging a slider). */
const COALESCE_MS = 1500;

class History {
  private undos: string[] = [];
  private redos: string[] = [];
  private lastKey = "";
  private lastAt = 0;

  push(snapshot: string, key = "") {
    const now = performance.now();
    if (key && key === this.lastKey && now - this.lastAt < COALESCE_MS) {
      this.lastAt = now;
      return;
    }
    this.undos.push(snapshot);
    if (this.undos.length > UNDO_LIMIT) this.undos.shift();
    this.redos = [];
    this.lastKey = key;
    this.lastAt = now;
  }

  undo(current: string): string | null {
    const s = this.undos.pop();
    if (s === undefined) return null;
    this.redos.push(current);
    this.lastKey = "";
    return s;
  }

  redo(current: string): string | null {
    const s = this.redos.pop();
    if (s === undefined) return null;
    this.undos.push(current);
    this.lastKey = "";
    return s;
  }

  get canUndo() {
    return this.undos.length > 0;
  }

  get canRedo() {
    return this.redos.length > 0;
  }
}

let counter = 0;

/** Clips copied with Ctrl+C or Ctrl+X, for pasting into this project or another one. */
let clipboard: ClipCopy | null = null;

class VideoEditor implements StudioApp {
  readonly kind = "video" as const;
  readonly el: HTMLElement;
  private project: Project;
  private file: string | null = null;
  private unsaved = false;
  private history = new History();
  private dragOrigin: string | null = null;
  readonly selection = new Set<string>();
  readonly store = new MediaStore();
  private engine: Engine;
  private timeline: Timeline;
  private panel: Panel;
  private captions: CaptionsPanel;
  private inspector: Inspector;
  private motion: MotionFeatures;
  private stage: HTMLElement;
  private frame: HTMLElement;
  private canvas: HTMLCanvasElement;
  private timeLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private titleEl: HTMLElement;
  private safe: HTMLElement;
  private observer: ResizeObserver;
  private mediaSig = "";
  private active = false;
  private exporting = false;
  private readonly prefix = `ve${++counter}:`;
  /** AutoRecover: this project's snapshot id, and the text last kept. */
  private recoverId = `v-${uid()}`;
  private recoverText = "";
  private recoverTimer = 0;
  /** A voice-over being recorded. */
  private recording: { id: number; path: string; start: number; meter: number; level: HTMLElement; volume: number } | null = null;
  private recordBtn: HTMLButtonElement;
  private main: HTMLElement;
  private leftGutter: HTMLElement;
  private rightGutter: HTMLElement;
  private leftToggle: HTMLButtonElement;
  private rightToggle: HTMLButtonElement;
  /** Picking a chroma key colour from the preview for this clip. */
  private picking: string | null = null;
  /** Typing a text clip's words in a box on the preview. */
  private textEditor: { id: string; el: HTMLElement } | null = null;

  constructor(private host: StudioHost, aspect: Aspect) {
    this.project = newProject(aspect);
    const prefix = this.prefix;
    this.canvas = h("canvas", { class: "ve-canvas" });
    this.safe = h("div", { class: "ve-safe", hidden: true }, h("div", { class: "ve-safe-top" }), h("div", { class: "ve-safe-bottom" }), h("div", { class: "ve-safe-side" }));
    this.frame = h("div", { class: "ve-frame" }, this.canvas, this.safe);
    this.stage = h("div", { class: "ve-stage" }, this.frame);
    this.engine = new Engine(this.canvas, {
      project: () => this.project,
      store: this.store,
      prefix,
      volume: () => this.settings().volume,
      onTime: (t) => this.onTime(t, true),
      onPlayState: (playing) => this.onPlayState(playing),
    });

    this.timeline = new Timeline({
      project: () => this.project,
      store: this.store,
      selection: this.selection,
      time: () => this.engine.time,
      seek: (t) => this.seek(t),
      select: (ids, add) => this.select(ids, add),
      beginDrag: () => (this.dragOrigin = JSON.stringify(this.project)),
      dragTo: (fn) => {
        if (this.dragOrigin === null) return;
        this.project = JSON.parse(this.dragOrigin) as Project;
        fn(this.project);
        this.refresh({ sound: false, timeline: true });
      },
      endDrag: () => {
        const origin = this.dragOrigin;
        this.dragOrigin = null;
        if (origin !== null && origin !== JSON.stringify(this.project)) {
          this.history.push(origin);
          this.markDirty();
        }
        this.refresh({ sound: true });
      },
      dropMedia: (id, where) => this.dropMedia(id, where),
      dropText: (preset, time) => this.addText(preset, time),
      openTransition: (clipId) => {
        this.select([clipId], false);
        this.panel.showTransition("cut");
      },
      command: (name) => this.command(name),
      contextMenu: (e, clip, track, time) => this.contextMenu(e, clip, track, time),
      editText: (id) => this.editText(id),
      fps: () => this.project.canvas.fps,
    });

    this.captions = new CaptionsPanel({
      project: () => this.project,
      selectedClips: () => [...this.selection].map((id) => findClip(this.project, id)?.clip).filter((c): c is MediaClip => c?.type === "media"),
      apply: (cues, preset, highlight) => this.applyCaptions(cues, preset, highlight),
      toast: (text) => this.host.toast(text),
    }, () => this.panel.refresh());

    this.motion = new MotionFeatures({
      project: () => this.project,
      change: (fn, key) => this.change(fn, key),
      select: (ids) => this.select(ids, false),
      time: () => this.engine.time,
      seek: (t) => this.seek(t),
      engine: this.engine,
      prefix,
      apps: () => this.host.shell.config.studio.apps,
      saveConfig: () => this.host.shell.saveConfig(),
      addFiles: (paths) => this.addFiles(paths),
      toast: (text) => this.host.toast(text),
      refreshPanel: () => this.panel.refresh(),
    }, () => this.project.canvas.aspect, () => (this.selection.size === 1 ? [...this.selection][0] : null));

    this.panel = new Panel({
      project: () => this.project,
      store: this.store,
      importFiles: (kind) => void this.importFiles(kind),
      record: () => void this.toggleRecording(),
      importSrt: () => void this.importSrt(),
      exportSrt: () => void this.exportSrt(),
      addMedia: (id) => this.addMediaAtPlayhead(id),
      addMusic: (path) => void this.addMusic(path),
      removeMedia: (id) => this.removeMedia(id),
      addText: (preset) => this.addText(preset, this.engine.time),
      addSticker: (id) => this.addSticker(id, this.engine.time),
      addSound: (path) => void this.addMusic(path),
      captions: this.captions,
      installCodecs: () => void this.installCodecs(),
      transitionTarget: () => this.transitionTarget(),
      applyTransition: (slot, kind, duration, all) => this.applyTransition(slot, kind, duration, all),
      toast: (text) => this.host.toast(text),
      currentLook: () => this.currentLook(),
      applyLook: (look, all) => this.applyLook(look, all),
      currentEffect: () => this.currentEffect(),
      applyEffect: (effect) => this.applyEffect(effect),
      templates: this.motion.tab,
      prefs: {
        get: (key) => (key === "panelTab" ? this.settings().panelTab : this.settings().subTabs[key]),
        set: (key, value) => {
          if (key === "panelTab") this.settings().panelTab = value;
          else this.settings().subTabs[key] = value;
          this.host.shell.saveConfig();
        },
      },
    });

    usePrefs({
      open: (id) => this.settings().sections[id],
      setOpen: (id, open) => {
        this.settings().sections[id] = open;
        this.host.shell.saveConfig();
      },
      tab: (kind) => this.settings().tabs[kind],
      setTab: (kind, tab) => {
        this.settings().tabs[kind] = tab;
        this.host.shell.saveConfig();
      },
    });

    this.inspector = new Inspector({
      project: () => this.project,
      selection: () => [...this.selection],
      change: (fn, key) => this.change(fn, key),
      setAspect: (a) => this.change((p) => (p.canvas.aspect = a), "aspect"),
      time: () => this.engine.time,
      seek: (t) => this.seek(t),
      loadLut: (id) => void this.loadLut(id),
      pickKeyColor: (id) => this.pickKeyColor(id),
      freezeFrame: () => this.freezeFrame(),
      markBeats: (id) => void this.markBeats(id),
      deleteSelection: () => this.command("delete"),
      editText: (id) => this.editText(id),
      browse: (what, slot) => {
        this.setPanelOpen("left", true);
        if (what === "filters") this.panel.show("effects", "filters");
        else this.panel.showTransition(slot ?? "in");
      },
      template: this.motion.views,
    });

    const tb = (name: Parameters<typeof icon>[0], title: string, run: () => void) =>
      h("button", { class: "icon-btn", type: "button", title, "aria-label": title, onclick: run }, icon(name, 18));
    this.undoBtn = tb("undo", "Undo (Ctrl+Z)", () => this.undo());
    this.redoBtn = tb("redo", "Redo (Ctrl+Shift+Z)", () => this.redo());
    this.titleEl = h("div", { class: "ve-title" });
    this.leftToggle = h("button", { class: "icon-btn ve-panel-toggle", type: "button", title: "Hide the media panel (Ctrl+0)", "aria-label": "Media panel", onclick: () => this.setPanelOpen("left", !this.shownPanels.left) }, icon("sidebar", 18));
    this.rightToggle = h("button", { class: "icon-btn ve-panel-toggle right", type: "button", title: "Hide the inspector (Ctrl+Alt+0)", "aria-label": "Inspector", onclick: () => this.setPanelOpen("right", !this.shownPanels.right) }, icon("sidebar", 18));
    const top = h("header", { class: "ve-top" },
      this.leftToggle,
      tb("back", "Studio Home", () => host.showHome()),
      h("div", { class: "ve-brand" }, icon("videoEdit", 18)),
      this.titleEl,
      h("span", { class: "spacer" }),
      this.undoBtn, this.redoBtn,
      tb("save", "Save (Ctrl+S)", () => void this.save()),
      h("button", { class: "btn primary ve-export", type: "button", onclick: () => this.exportVideo() }, icon("download", 16), "Export"),
      this.rightToggle,
    );

    this.timeLabel = h("span", { class: "ve-time" });
    this.playBtn = h("button", { class: "icon-btn ve-play", type: "button", title: "Play (Space)", "aria-label": "Play", onclick: () => this.engine.toggle() }, icon("play", 22));
    const volume = h("input", {
      type: "range", min: "0", max: "1", step: "0.01", value: String(this.settings().volume), class: "ve-volume", "aria-label": "Preview volume",
      oninput: () => {
        this.settings().volume = Number(volume.value);
        this.engine.setVolume(this.settings().volume);
        host.shell.saveConfig();
      },
    });
    const transport = h("div", { class: "ve-transport" },
      this.timeLabel,
      h("span", { class: "spacer" }),
      tb("skipBack10", "Back one frame (←)", () => this.step(-1)),
      this.playBtn,
      tb("skipForward10", "Forward one frame (→)", () => this.step(1)),
      h("span", { class: "spacer" }),
      this.recordBtn = h("button", { class: "icon-btn small ve-record", type: "button", title: "Record a voice-over (R)", "aria-label": "Record a voice-over", onclick: () => void this.toggleRecording() }, icon("veMic", 16)),
      h("button", { class: "icon-btn small", type: "button", title: "Safe areas for Reels and TikTok", onclick: (e: Event) => {
        this.safe.hidden = !this.safe.hidden;
        (e.currentTarget as HTMLElement).classList.toggle("active", !this.safe.hidden);
      } }, icon("grid", 16)),
      icon("volume", 16),
      volume,
    );
    const player = h("section", { class: "ve-player" }, this.stage, transport);
    this.leftGutter = this.gutter("left");
    this.rightGutter = this.gutter("right");
    this.main = h("div", { class: "ve-main" }, this.panel.el, this.leftGutter, player, this.rightGutter, this.inspector.el);
    const splitter = h("div", { class: "ve-split", title: "Drag to resize the timeline" });
    this.el = h("div", { class: "of-editor ve-app tone-video" }, top, this.main, splitter, this.timeline.el);
    this.dragSplitter(splitter);
    this.layout();
    this.canvasPointer();

    this.observer = new ResizeObserver((entries) => {
      if (entries.some((e) => e.target === this.el)) this.layout();
      this.fitStage();
    });
    this.observer.observe(this.stage);
    this.observer.observe(this.el);
    this.refresh({ sound: false });
    this.recoverTimer = window.setInterval(() => void this.keepSnapshot(), RECOVER_MS);
  }

  // ---- settings and title

  private settings(): Settings {
    const apps = this.host.shell.config.studio.apps;
    const raw = (apps.video ?? {}) as Partial<Settings> & { _ok?: boolean };
    if (raw._ok) return raw as Settings;
    const s: Settings & { _ok?: boolean } = {
      volume: typeof raw.volume === "number" ? Math.max(0, Math.min(1, raw.volume)) : 1,
      left: width(raw.left, LEFT_W),
      right: width(raw.right, RIGHT_W),
      leftOpen: raw.leftOpen !== false,
      rightOpen: raw.rightOpen !== false,
      panelTab: typeof raw.panelTab === "string" ? raw.panelTab : undefined,
      subTabs: record(raw.subTabs, isString),
      tabs: record(raw.tabs, isString),
      sections: record(raw.sections, isBool),
    };
    // Checked once per session (not saved: it's a property of this object only).
    Object.defineProperty(s, "_ok", { value: true, enumerable: false });
    apps.video = s;
    return s;
  }

  // ---- the side panels: widths, showing and hiding, folding away when there's no room

  /** Which side panels show now (shown by choice and room). */
  private shownPanels = { left: true, right: true };
  /** The panel shown last by hand keeps its place when room runs out. */
  private priority: "left" | "right" = "right";

  private setPanelOpen(side: "left" | "right", open: boolean) {
    const s = this.settings();
    if (side === "left") s.leftOpen = open;
    else s.rightOpen = open;
    if (open) this.priority = side;
    this.host.shell.saveConfig();
    this.layout();
  }

  /** Lays out the panels: their widths, and which fit beside a preview of at least MIN_PLAYER. */
  private layout() {
    const s = this.settings();
    const room = this.main.clientWidth - 2 * GUTTER;
    let left = s.leftOpen, right = s.rightOpen;
    const fits = () => (left ? s.left + GUTTER : 0) + MIN_PLAYER + (right ? s.right + GUTTER : 0) <= room;
    if (room > 0 && !fits()) {
      // The panel not shown last by hand folds first.
      if (this.priority === "right" && left) left = false;
      else if (this.priority === "left" && right) right = false;
      if (!fits()) {
        if (left && this.priority !== "left") left = false;
        else if (right) right = false;
      }
    }
    // Shown again: its thumbnails are drawn again (a hidden canvas can lose what was drawn on it).
    if (left && !this.shownPanels.left) requestAnimationFrame(() => this.panel.refresh());
    this.shownPanels = { left, right };
    this.main.style.gridTemplateColumns = `${left ? `${s.left}px` : "0"} ${left ? `${GUTTER}px` : "0"} minmax(0, 1fr) ${right ? `${GUTTER}px` : "0"} ${right ? `${s.right}px` : "0"}`;
    this.panel.el.hidden = !left;
    this.leftGutter.hidden = !left;
    this.inspector.el.hidden = !right;
    this.rightGutter.hidden = !right;
    this.leftToggle.classList.toggle("active", left);
    this.rightToggle.classList.toggle("active", right);
    this.leftToggle.title = left ? "Hide the media panel (Ctrl+0)" : "Show the media panel (Ctrl+0)";
    this.rightToggle.title = right ? "Hide the inspector (Ctrl+Alt+0)" : "Show the inspector (Ctrl+Alt+0)";
    this.leftToggle.setAttribute("aria-pressed", String(left));
    this.rightToggle.setAttribute("aria-pressed", String(right));
  }

  /** A gutter between a side panel and the preview: drag (or ←/→) to resize, double-click for the default. */
  private gutter(side: "left" | "right"): HTMLElement {
    const [def, lo, hi] = side === "left" ? LEFT_W : RIGHT_W;
    const label = side === "left" ? "media panel" : "inspector";
    const el = h("div", {
      class: `ve-gutter ${side}`, role: "separator", tabindex: "0", "aria-orientation": "vertical", "aria-label": `Resize the ${label}`,
      title: `Drag to resize the ${label}; double-click for its usual width`,
    });
    const set = (w: number) => {
      const s = this.settings();
      const most = Math.max(lo, Math.min(hi, this.main.clientWidth - MIN_PLAYER - (side === "left" ? (this.shownPanels.right ? s.right : 0) : (this.shownPanels.left ? s.left : 0)) - 4 * GUTTER));
      const v = Math.round(Math.max(lo, Math.min(most, w)));
      if (side === "left") s.left = v;
      else s.right = v;
      el.setAttribute("aria-valuenow", String(v));
      this.layout();
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
      const x0 = e.clientX;
      const s = this.settings();
      const w0 = side === "left" ? s.left : s.right;
      const move = (ev: PointerEvent) => set(w0 + (side === "left" ? 1 : -1) * (ev.clientX - x0));
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.classList.remove("dragging");
        this.host.shell.saveConfig();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    el.addEventListener("dblclick", () => {
      set(def);
      this.host.shell.saveConfig();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      const s = this.settings();
      const step = (e.shiftKey ? 32 : 8) * (e.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
      set((side === "left" ? s.left : s.right) + step);
      this.host.shell.saveConfig();
    });
    return el;
  }

  title() {
    if (this.file) return stripExtension(basename(this.file));
    return this.project.canvas.aspect === "9:16" ? "Untitled reel" : "Untitled video";
  }

  path() {
    return this.file;
  }

  dirty() {
    return this.unsaved;
  }

  private markDirty() {
    if (!this.unsaved) {
      this.unsaved = true;
      this.host.changed();
    }
  }

  // ---- changing the project

  /** Applies an edit with undo; edits with the same key in a row coalesce. */
  change(fn: (p: Project) => void, key = "") {
    const before = JSON.stringify(this.project);
    fn(this.project);
    if (JSON.stringify(this.project) === before) return;
    this.history.push(before, key);
    this.markDirty();
    this.refresh({ sound: true });
  }

  /** Brings every view up to date. */
  private refresh(o: { sound: boolean; timeline?: boolean }) {
    for (const id of [...this.selection]) if (!findClip(this.project, id)) this.selection.delete(id);
    const end = projectDuration(this.project);
    if (this.engine.time > end) this.engine.seek(end);
    this.engine.invalidate(o.sound);
    this.timeline.redraw();
    this.inspector.refresh();
    const sig = this.project.media.map((m) => `${m.id}${m.missing ? "!" : ""}`).join(",");
    if (sig !== this.mediaSig) {
      this.mediaSig = sig;
      this.panel.refresh();
    }
    this.fitStage();
    this.titleEl.replaceChildren(h("span", null, this.title()), ...(this.unsaved ? [h("span", { class: "ve-dot", title: "Not saved" })] : []));
    this.undoBtn.disabled = !this.history.canUndo;
    this.redoBtn.disabled = !this.history.canRedo;
    this.onTime(this.engine.time, false);
  }

  private undo() {
    const s = this.history.undo(JSON.stringify(this.project));
    if (s === null) return;
    this.closeTextEditor();
    this.project = JSON.parse(s) as Project;
    this.markDirty();
    this.refresh({ sound: true });
    this.panel.refresh();
  }

  private redo() {
    const s = this.history.redo(JSON.stringify(this.project));
    if (s === null) return;
    this.closeTextEditor();
    this.project = JSON.parse(s) as Project;
    this.markDirty();
    this.refresh({ sound: true });
    this.panel.refresh();
  }

  private select(ids: string[], add: boolean) {
    if (!add) this.selection.clear();
    for (const id of ids) {
      if (add && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    if (this.textEditor && (this.selection.size !== 1 || !this.selection.has(this.textEditor.id))) this.closeTextEditor();
    this.timeline.redraw(false);
    this.inspector.refresh();
    this.panel.selectionChanged();
  }

  // ---- playback

  private seek(t: number) {
    this.engine.seek(t);
    this.onTime(this.engine.time, false);
  }

  private step(frames: number) {
    this.engine.pause();
    const fps = this.project.canvas.fps;
    const frame = Math.round(this.engine.time * fps) + frames;
    this.seek(Math.max(0, frame / fps));
  }

  private onTime(t: number, playing: boolean) {
    const fps = this.project.canvas.fps;
    this.timeLabel.textContent = `${formatTime(t, fps)} / ${formatTime(projectDuration(this.project), fps)}`;
    this.timeline.setTime(t);
    if (playing) this.timeline.follow(t);
    this.inspector.timeChanged(playing);
  }

  private onPlayState(playing: boolean) {
    if (playing) {
      // The project's own sound takes over from listening in the Audio tab.
      this.panel.stopListening();
      this.closeTextEditor();
    }
    this.playBtn.replaceChildren(icon(playing ? "pause" : "play", 22));
    this.playBtn.title = playing ? "Pause (Space)" : "Play (Space)";
    this.onTime(this.engine.time, false);
  }

  /** Sizes the preview to the canvas shape inside the stage, and the compositor to its pixels. */
  private fitStage() {
    const sw = this.stage.clientWidth - 24, sh = this.stage.clientHeight - 24;
    if (sw <= 0 || sh <= 0) return;
    const [a, b] = this.project.canvas.aspect.split(":").map(Number);
    const ratio = a / b;
    let w = sw, hh = sw / ratio;
    if (hh > sh) {
      hh = sh;
      w = sh * ratio;
    }
    this.frame.style.width = `${Math.floor(w)}px`;
    this.frame.style.height = `${Math.floor(hh)}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.engine.setSize(w * dpr, hh * dpr);
  }

  private dragSplitter(splitter: HTMLElement) {
    splitter.addEventListener("pointerdown", (e) => {
      splitter.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const start = this.timeline.el.getBoundingClientRect().height;
      const move = (ev: PointerEvent) => {
        const next = Math.max(160, Math.min(window.innerHeight * 0.7, start + (startY - ev.clientY)));
        this.timeline.el.style.height = `${next}px`;
      };
      const up = () => {
        splitter.removeEventListener("pointermove", move);
        splitter.removeEventListener("pointerup", up);
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", up);
    });
  }

  /** Clicking the preview selects the layer there; dragging moves it. */
  private canvasPointer() {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const sx = this.engine.size.width / rect.width, sy = this.engine.size.height / rect.height;
      if (this.picking) {
        const id = this.picking;
        this.engine.drawNow();
        const color = this.engine.colorAt((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
        this.endPicking();
        if (color) this.change((p) => {
          const c = findClip(p, id)?.clip;
          if (c?.type === "media" && c.fx.key) c.fx.key.color = color;
        }, `${id}:key-color`);
        return;
      }
      const hit = this.engine.clipAtPoint(this.engine.time, (e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
      if (!hit) {
        this.select([], false);
        return;
      }
      if (!this.selection.has(hit.id)) this.select([hit.id], false);
      this.canvas.setPointerCapture(e.pointerId);
      const local = Math.max(0, Math.min(hit.duration, this.engine.time - hit.start));
      const at = placeAt(hit, local);
      const start = { x: e.clientX, y: e.clientY, px: at.x, py: at.y };
      const key = `canvas-move:${hit.id}:${Date.now()}`;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / rect.width, dy = (ev.clientY - start.y) / rect.height;
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 3) return;
        this.change((p) => {
          const c = findClip(p, hit.id)?.clip;
          if (!c) return;
          // Snap back to the centre lines; with keyframes, the move is a keyframe at the playhead.
          const x = start.px + dx, y = start.py + dy;
          setProp(c, "x", local, Math.abs(x - 0.5) < 0.012 ? 0.5 : x);
          setProp(c, "y", local, Math.abs(y - 0.5) < 0.012 ? 0.5 : y);
        }, key);
      };
      const up = () => {
        this.canvas.removeEventListener("pointermove", move);
        this.canvas.removeEventListener("pointerup", up);
      };
      this.canvas.addEventListener("pointermove", move);
      this.canvas.addEventListener("pointerup", up);
    });
    const hitAt = (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const sx = this.engine.size.width / rect.width, sy = this.engine.size.height / rect.height;
      return this.engine.clipAtPoint(this.engine.time, (e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
    };
    // Double-click a text (or a template) to type its words.
    this.canvas.addEventListener("dblclick", (e) => {
      const hit = hitAt(e);
      if (hit && hasText(hit)) this.editText(hit.id);
    });
    // Right-click: the same menu as on the timeline, for the layer under the pointer.
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.picking) return;
      const hit = hitAt(e);
      const found = hit ? findClip(this.project, hit.id) : null;
      this.contextMenu(e, found?.clip ?? null, found?.track ?? null, this.engine.time);
    });
  }

  // ---- media

  /** Probes files into the project's media (skipping ones already there). */
  private async addFiles(paths: string[]): Promise<Media[]> {
    const added: Media[] = [];
    const problems: string[] = [];
    for (const path of paths) {
      const have = this.project.media.find((m) => m.path === path && !m.missing);
      if (have) {
        added.push(have);
        continue;
      }
      try {
        const m = await probeMedia(path);
        added.push(m);
        if (m.kind === "audio") void this.store.sound(m).then((sound) => sound && this.exactLength(m.id, sound.buffer.duration));
      } catch (err) {
        problems.push(errorText(err));
      }
    }
    if (problems.length) this.host.toast(problems[0] + (problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""));
    return added;
  }

  /**
   * A sound's real length, once decoded (some files only give an estimate up front): fixes the
   * media and shortens clips that would run past it. Not an edit of its own (no undo step).
   */
  private exactLength(id: string, seconds: number) {
    const m = mediaOf(this.project, id);
    if (!m || Math.abs(m.duration - seconds) < 0.02) return;
    m.duration = seconds;
    for (const t of this.project.tracks) {
      for (const c of t.clips) {
        if (c.type === "media" && c.media === id) c.duration = Math.min(c.duration, Math.max(0.1, (seconds - c.in) / c.speed));
      }
    }
    layoutMain(this.project);
    this.refresh({ sound: true });
  }

  private async importFiles(kind: "any" | "audio") {
    const filters = kind === "audio"
      ? [{ name: "Music and sounds", extensions: AUDIO_EXTENSIONS }]
      : [{ name: "Clips, pictures and music", extensions: [...VIDEO_EXTENSIONS, ...PICTURE_EXTENSIONS, ...AUDIO_EXTENSIONS] }, { name: "Clips", extensions: VIDEO_EXTENSIONS }, { name: "Pictures", extensions: PICTURE_EXTENSIONS }];
    const picked = await open({ title: kind === "audio" ? "Import Music" : "Import Media", multiple: true, filters }).catch(() => null);
    if (!picked?.length) return;
    const media = await this.addFiles(picked);
    if (!media.length) return;
    const emptyTimeline = this.project.tracks.every((t) => !t.clips.length);
    this.change((p) => {
      for (const m of media) if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
      if (emptyTimeline) this.putOnTimeline(p, media, 0);
    });
    if (media.some((m) => m.kind === "audio")) this.panel.show(kind === "audio" || media.every((m) => m.kind === "audio") ? "audio" : "media");
  }

  /** Puts media on the timeline: pictures and clips on the main track, sounds on audio tracks. */
  private putOnTimeline(p: Project, media: Media[], at: number) {
    let index = mainIndexAt(p, at);
    for (const m of media) {
      if (m.kind === "audio") {
        placeFree(p, mediaClip(m, at), "audio");
      } else {
        insertMain(p, mediaClip(m, 0), index++);
      }
    }
  }

  private addMediaAtPlayhead(id: string) {
    const m = mediaOf(this.project, id);
    if (!m || m.missing) return;
    const t = this.engine.time;
    this.change((p) => this.putOnTimeline(p, [m], t));
  }

  private dropMedia(id: string, where: { kind: "main"; index: number } | { kind: "overlay" | "audio"; time: number; track?: string }) {
    const m = mediaOf(this.project, id);
    if (!m || m.missing) return;
    this.change((p) => {
      if (where.kind === "main") {
        if (m.kind === "audio") placeFree(p, mediaClip(m, this.engine.time), "audio");
        else insertMain(p, mediaClip(m, 0), where.index);
        return;
      }
      const clip = mediaClip(m, where.time);
      if (where.kind === "overlay") {
        clip.place.scale = 0.5;
        clip.fit = "fit";
      }
      placeFree(p, clip, where.kind === "overlay" && m.kind === "audio" ? "audio" : where.kind, where.track);
      this.selection.clear();
      this.selection.add(clip.id);
    });
  }

  private async addMusic(path: string) {
    const [m] = await this.addFiles([path]);
    if (!m) return;
    const t = this.engine.time;
    this.change((p) => {
      if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
      placeFree(p, mediaClip(m, t), "audio");
    });
    this.panel.show("audio");
  }

  private removeMedia(id: string) {
    const used = this.project.tracks.some((t) => t.clips.some((c) => c.type === "media" && c.media === id));
    this.change((p) => {
      for (const t of p.tracks) t.clips = t.clips.filter((c) => c.type !== "media" || c.media !== id);
      for (const t of p.tracks) for (const c of t.clips) if (c.type === "template") for (const [k, v] of Object.entries(c.slots)) if (v === id) delete c.slots[k];
      p.media = p.media.filter((m) => m.id !== id);
      layoutMain(p);
      tidyTracks(p);
    });
    this.engine.forgetMedia(id);
    if (used) this.host.toast("Removed the file and its clips. Undo brings them back.");
  }

  /** Installs the codecs clips need, then probes those clips again (their notes may go). */
  private async installCodecs() {
    const encoders = await editApi.encoders().catch(() => null);
    const missing = encoders?.missing.length ? encoders.missing : ["gstreamer1.0-libav"];
    const now = await offerCodecInstall(missing, (text) => this.host.toast(text));
    if (!now) return;
    const noted = this.project.media.filter((m) => m.note && !m.missing);
    for (const m of noted) {
      const fresh = await probeMedia(m.path).catch(() => null);
      if (!fresh) continue;
      this.engine.forgetMedia(m.id);
      this.change((p) => {
        const x = p.media.find((y) => y.id === m.id);
        if (!x) return;
        if (fresh.note) x.note = fresh.note;
        else delete x.note;
        x.audio = fresh.audio;
      });
    }
  }

  /** A sticker at `time`: a text clip drawn as one of Zazabor's stickers. */
  private addSticker(stickerId: string, time: number) {
    const sticker = stickerOf(stickerId);
    if (!sticker) return;
    const clip: TextClip = {
      id: uid(), type: "text", start: Math.max(0, time), duration: TEXT_SECONDS, text: sticker.label,
      style: { ...structuredClone(TEXT_PRESETS[0].style), size: STICKER_SIZE, color: "#ffb020", stroke: null, strokeWidth: 0 },
      place: { ...defaultPlace(), y: 0.4 }, animIn: "pop", animOut: "pop", sticker: sticker.id,
    };
    this.change((p) => placeFree(p, clip, "text"));
    this.select([clip.id], false);
  }

  /** Auto captions onto a track of their own; earlier auto captions give way. */
  private applyCaptions(cues: Cue[], presetId: string, highlight: string | null): number {
    const preset = TEXT_PRESETS.find((x) => x.id === presetId) ?? TEXT_PRESETS.find((x) => x.id === "caption") ?? TEXT_PRESETS[0];
    // A highlight too close to the words' own colour wouldn't show: pick one that does.
    if (highlight && colorDistance(highlight, preset.style.color) < 120) highlight = colorDistance(preset.style.color, "#4ade80") < 120 ? "#ff5fa2" : "#4ade80";
    const y = this.project.canvas.aspect === "16:9" ? 0.84 : this.project.canvas.aspect === "9:16" ? 0.72 : 0.8;
    this.change((p) => {
      let track = p.tracks.find((t) => t.kind === "text" && t.clips.some((c) => c.type === "text" && c.auto));
      for (const t of p.tracks) if (t.kind === "text") t.clips = t.clips.filter((c) => !(c.type === "text" && c.auto));
      tidyTracks(p);
      if (!track || !p.tracks.includes(track)) track = newTrack(p, "text");
      for (const cue of cues) {
        track.clips.push({
          id: uid(), type: "text", start: cue.start, duration: Math.max(0.2, cue.end - cue.start), text: cue.text,
          style: structuredClone(preset.style), place: { ...defaultPlace(), y },
          animIn: preset.animIn === "typewriter" ? "none" : preset.animIn === "none" ? "none" : "pop", animOut: "none",
          words: cue.words, highlight, auto: true,
        });
      }
      track.clips.sort((a, b) => a.start - b.start);
    });
    requestAnimationFrame(() => this.timeline.fit());
    return cues.length;
  }

  private addText(presetId: string, time: number) {
    const preset = TEXT_PRESETS.find((x) => x.id === presetId) ?? TEXT_PRESETS[0];
    const clip: TextClip = {
      id: uid(), type: "text", start: Math.max(0, time), duration: TEXT_SECONDS, text: "Your text",
      style: structuredClone(preset.style), place: { ...defaultPlace(), y: 0.42 }, animIn: preset.animIn, animOut: preset.animOut,
    };
    this.change((p) => placeFree(p, clip, "text"));
    this.select([clip.id], false);
    // Ready to type over the placeholder.
    requestAnimationFrame(() => {
      const area = this.inspector.el.querySelector<HTMLTextAreaElement>(".ve-textarea");
      area?.focus();
      area?.select();
    });
  }

  // ---- transitions and looks

  private transitionTarget(): TransitionTarget | null {
    // A selected overlay, text, sticker or template: its own in and out.
    for (const id of this.selection) {
      const f = findClip(this.project, id);
      if (f && f.track.kind !== "main" && f.track.kind !== "audio") return { clip: f.clip, track: f.track, touching: touchesPrevious(f.track, f.index) };
    }
    const track = mainTrack(this.project);
    const main = track.clips;
    const selected = main.find((c, i) => i > 0 && this.selection.has(c.id));
    if (selected) return { clip: selected, track, touching: true };
    if (main.length < 2) return null;
    // The cut nearest the playhead.
    const t = this.engine.time;
    return { clip: main.slice(1).reduce((best, c) => (Math.abs(c.start - t) < Math.abs(best.start - t) ? c : best)), track, touching: true };
  }

  private applyTransition(slot: TransitionSlot, kind: TransitionKind | null, duration: number, all: boolean) {
    const target = this.transitionTarget();
    if (!target) return;
    const { clip: c, track: { id: trackId } } = target;
    const main = target.track.kind === "main";
    const key = slot === "in" ? "transIn" : slot === "out" ? "transOut" : "transition";
    this.change((p) => {
      const track = p.tracks.find((x) => x.id === trackId);
      if (!track) return;
      // All: every cut of the track (off the main track, where clips touch), or every clip's in or out.
      const targets = track.clips.filter((x, i) => (all ? slot !== "cut" || (main ? i > 0 : touchesPrevious(track, i)) : x.id === c.id));
      for (const x of targets) {
        if (kind) x[key] = { kind, duration };
        else delete x[key];
      }
      if (main) layoutMain(p);
    }, all ? "" : `transition:${slot}:${c.id}`);
    this.selection.clear();
    this.selection.add(c.id);
    this.panel.refresh();
    this.inspector.refresh();
    if (kind) {
      // Show it: from just before it.
      const at = slot === "cut" ? c.start - duration / 2 - 0.4 : slot === "in" ? c.start - 0.3 : clipEnd(c) - duration - 0.4;
      this.seek(Math.max(0, at));
    }
  }

  private selectedMediaClips(): MediaClip[] {
    return [...this.selection].map((id) => findClip(this.project, id)?.clip).filter((c): c is MediaClip => c?.type === "media");
  }

  private currentLook(): LookId | "none" | null {
    const clips = this.selectedMediaClips();
    if (!clips.length) return null;
    const look = clips[0].fx.look;
    return clips.every((c) => c.fx.look === look) ? look : null;
  }

  /** The selected clips with a picture. */
  private selectedPictures(): MediaClip[] {
    return this.selectedMediaClips().filter((c) => mediaOf(this.project, c.media)?.kind !== "audio" && findClip(this.project, c.id)?.track.kind !== "audio");
  }

  private currentEffect(): EffectId | "mixed" | null {
    const clips = this.selectedPictures();
    if (!clips.length) return null;
    const effect = clips[0].fx.effect;
    return clips.every((c) => c.fx.effect === effect) ? effect : "mixed";
  }

  private applyEffect(effect: EffectId) {
    const ids = new Set(this.selectedPictures().map((c) => c.id));
    if (!ids.size) return;
    this.change((p) => {
      for (const t of p.tracks) for (const c of t.clips) if (c.type === "media" && ids.has(c.id)) c.fx.effect = effect;
    }, "effect");
    this.panel.refresh();
  }

  private applyLook(look: LookId | "none", all: boolean) {
    let clips = this.selectedMediaClips();
    if (all || !clips.length) clips = mainTrack(this.project).clips as MediaClip[];
    if (!clips.length) return;
    const ids = new Set(clips.map((c) => c.id));
    this.change((p) => {
      for (const t of p.tracks) for (const c of t.clips) if (c.type === "media" && ids.has(c.id)) c.fx.look = look;
    });
    if (!this.selectedMediaClips().length && !all) this.host.toast("No clip was selected, so the filter went on every main clip.");
    this.panel.refresh();
  }

  // ---- commands

  /** The clips a command acts on: the selection, or the main clip under the playhead. */
  private targets(): Clip[] {
    const chosen = [...this.selection].map((id) => findClip(this.project, id)?.clip).filter((c): c is Clip => !!c);
    if (chosen.length) return chosen;
    const under = mainClipAt(this.project, this.engine.time);
    return under ? [under] : [];
  }

  private command(name: "split" | "delete" | "duplicate", ripple = false) {
    const t = this.engine.time;
    const targets = this.targets();
    if (!targets.length) return;
    if (name === "split") {
      const right: string[] = [];
      this.change((p) => {
        for (const c of targets) {
          const r = split(p, c.id, t);
          if (r) right.push(r.id);
        }
      });
      if (right.length) this.select(right, false);
      else this.host.toast("Move the playhead inside a clip to split it.");
    } else if (name === "delete") {
      this.change((p) => remove(p, targets.map((c) => c.id), ripple));
      this.selection.clear();
      this.refresh({ sound: true });
    } else {
      const copies: string[] = [];
      this.change((p) => {
        for (const c of targets) {
          const found = findClip(p, c.id);
          if (!found) continue;
          const copy = structuredClone(found.clip) as Clip;
          copy.id = uid();
          copies.push(copy.id);
          // The copy comes right after the clip: no transition across that cut.
          delete copy.transition;
          if (found.track.kind === "main") {
            insertMain(p, copy as MediaClip, found.index + 1);
          } else {
            copy.start = clipEnd(found.clip);
            placeFree(p, copy, found.track.kind as "overlay" | "text" | "audio", found.track.id);
          }
        }
      });
      this.select(copies, false);
    }
  }

  // ---- copy and paste, select all

  /** Ctrl+C and Ctrl+X: the selected clips onto the editor's clipboard (cut removes them). */
  private copy(cut: boolean) {
    const copy = copyClips(this.project, this.selection);
    if (!copy) return;
    clipboard = copy;
    if (cut) this.command("delete");
  }

  /** Ctrl+V: the copied clips at `t` (the playhead), on `track` when it's their kind. */
  private paste(t = this.engine.time, track?: string) {
    const copy = clipboard;
    if (!copy) return;
    let ids: string[] = [];
    this.change((p) => (ids = pasteClips(p, copy, t, track)));
    if (ids.length) this.select(ids, false);
  }

  /** Ctrl+A: the selection's track (the main track when nothing is selected); again, every track. `track`: that one's clips. */
  private selectAll(track?: string) {
    const on = track ? this.project.tracks.find((t) => t.id === track) : null;
    this.select(on ? on.clips.map((c) => c.id) : selectAllIds(this.project, this.selection), false);
  }

  // ---- right-click menus

  /** The timeline's and the preview's menu: a clip's actions, or the track's at `time`. */
  private contextMenu(e: MouseEvent, clip: Clip | null, track: Track | null, time: number) {
    const x = e.clientX, y = e.clientY;
    if (!clip) return openMenu(x, y, this.trackMenu(track, time));
    if (!this.selection.has(clip.id)) this.select([clip.id], false);
    openMenu(x, y, this.clipMenu(clip, track));
  }

  private clipMenu(clip: Clip, track: Track | null): MenuItem[] {
    const many = this.selection.size > 1;
    const t = this.engine.time;
    const chosen = this.targets();
    const at = (c: Clip) => t > c.start + MIN_CLIP / 2 && t < clipEnd(c) - MIN_CLIP / 2;
    const found = findClip(this.project, clip.id);
    const kind = track?.kind ?? found?.track.kind;
    const m = clip.type === "media" ? mediaOf(this.project, clip.media) : undefined;
    const video = clip.type === "media" && m?.kind === "video" && clip.freeze === undefined;
    const items: MenuItem[] = [];
    if (!many && hasText(clip)) items.push({ label: "Edit Text", icon: "pencil", action: () => this.editText(clip.id) }, "separator");
    items.push(
      { label: "Split at Playhead", icon: "splitRight", shortcut: "S", disabled: !chosen.some(at), action: () => this.command("split") },
      { label: "Trim Start to Playhead", shortcut: "Q", disabled: !chosen.some(at), action: () => this.trimToPlayhead("start") },
      { label: "Trim End to Playhead", shortcut: "W", disabled: !chosen.some(at), action: () => this.trimToPlayhead("end") },
      "separator",
      { label: "Cut", icon: "cut", shortcut: "Ctrl+X", action: () => this.copy(true) },
      { label: "Copy", icon: "copy", shortcut: "Ctrl+C", action: () => this.copy(false) },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", disabled: !clipboard, action: () => this.paste() },
      { label: "Duplicate", icon: "copy", shortcut: "Ctrl+D", action: () => this.command("duplicate") },
    );
    const extra: MenuItem[] = [];
    if (!many && kind && kind !== "main" && kind !== "audio") {
      extra.push({ label: "Transitions…", icon: "sparkles", action: () => this.panel.showTransition("in") });
    } else if (!many && kind === "main" && found && found.index > 0) {
      extra.push({ label: "Transition…", icon: "sparkles", action: () => {
        this.select([clip.id], false);
        this.panel.showTransition("cut");
      } });
    }
    if (!many && clip.type === "media" && m && m.kind !== "image" && clip.freeze === undefined) {
      extra.push({ label: "Speed…", icon: "speed", action: () => requestAnimationFrame(() => this.revealInInspector("speed")) });
    }
    if (!many && video && clip.type === "media") {
      extra.push({ label: `${clip.reverse ? "✓ " : ""}Reverse`, icon: "repeat", action: () => this.change((p) => {
        const c = findClip(p, clip.id)?.clip;
        if (c?.type === "media") c.reverse = c.reverse ? undefined : true;
      }) });
      if (kind === "main") extra.push({ label: "Freeze Frame", icon: "snowflake", disabled: !at(clip), action: () => this.freezeFrame() });
    }
    if (!many && kind === "audio" && clip.type === "media") extra.push({ label: "Mark Beats", icon: "music", action: () => void this.markBeats(clip.id) });
    if (extra.length) items.push("separator", ...extra);
    items.push(
      "separator",
      { label: "Select All on This Layer", icon: "checkSquare", shortcut: "Ctrl+A", action: () => this.selectAll(found?.track.id) },
      "separator",
      { label: "Delete", icon: "trash", shortcut: "Delete", danger: true, action: () => this.command("delete") },
    );
    if (kind !== "main") items.push({ label: "Ripple Delete", shortcut: "Shift+Delete", danger: true, action: () => this.command("delete", true) });
    return items;
  }

  /** Empty space on a track (or below the tracks, `track` null). */
  private trackMenu(track: Track | null, time: number): MenuItem[] {
    const items: MenuItem[] = [
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", disabled: !clipboard, action: () => this.paste(time, track?.id) },
    ];
    if (track?.clips.length) items.push({ label: "Select All on This Layer", icon: "checkSquare", shortcut: "Ctrl+A", action: () => this.selectAll(track.id) });
    if (this.project.tracks.some((t) => t.clips.length)) items.push({ label: "Select All Clips", action: () => this.select(this.project.tracks.flatMap((t) => t.clips.map((c) => c.id)), false) });
    if (track) {
      const id = track.id;
      const flag = (name: "muted" | "hidden") => this.change((p) => {
        const x = p.tracks.find((k) => k.id === id);
        if (x) x[name] = !x[name];
      });
      items.push("separator");
      if (track.kind !== "text") items.push({ label: track.muted ? "Unmute Track" : "Mute Track", icon: track.muted ? "volume" : "mute", action: () => flag("muted") });
      if (track.kind !== "audio") items.push({ label: track.hidden ? "Show Track" : "Hide Track", icon: track.hidden ? "eye" : "eyeOff", action: () => flag("hidden") });
    }
    return items;
  }

  /** Shows a section of the inspector (opening the inspector if it's hidden). */
  private revealInInspector(name: string, field?: string) {
    if (!this.shownPanels.right) this.setPanelOpen("right", true);
    this.inspector.reveal(name, field);
  }

  // ---- editing a text

  /** A text's words, ready to type: in a box on the preview (a template's in the inspector). */
  private editText(id: string) {
    const c = findClip(this.project, id)?.clip;
    if (!c || !hasText(c)) return;
    this.engine.pause();
    this.select([id], false);
    if (c.type === "template") {
      requestAnimationFrame(() => this.revealInInspector("content", ".mo-text"));
      return;
    }
    // The playhead onto the text, past its way in, so it shows whole.
    const t = this.engine.time;
    if (t < c.start + 0.05 || t >= clipEnd(c) - 0.05) this.seek(c.start + Math.min(0.9, c.duration / 2));
    this.openTextEditor(c.id);
  }

  private openTextEditor(id: string) {
    this.closeTextEditor();
    const c = findClip(this.project, id)?.clip;
    if (c?.type !== "text") return;
    this.engine.drawNow();
    const area = h("textarea", { class: "ve-textedit-area", rows: 2, spellcheck: "true", "aria-label": "Text" });
    area.value = c.text;
    const el = h("div", { class: "ve-textedit" }, area, h("div", { class: "ve-textedit-hint" }, "Enter starts a new line. Esc or a click elsewhere when done."));
    this.frame.append(el);
    this.textEditor = { id, el };
    // Under the text (above it when there's no room), as wide as the text and at least 240 px.
    const box = this.engine.textBox(c, this.engine.time);
    const fw = this.frame.clientWidth, fh = this.frame.clientHeight;
    const k = fw / Math.max(1, this.engine.size.width);
    const cx = box ? box.center[0] * k : fw / 2, cy = box ? box.center[1] * k : fh / 2;
    const half = box ? (box.size[1] * k) / 2 : 0;
    const width = Math.min(fw - 16, Math.max(240, box ? box.size[0] * k + 24 : 240));
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(8, Math.min(fw - width - 8, cx - width / 2))}px`;
    const height = el.offsetHeight;
    const below = cy + half + 8;
    el.style.top = `${below + height <= fh - 8 ? below : Math.max(8, cy - half - 8 - height)}px`;
    area.addEventListener("input", () => this.change((p) => {
      const x = findClip(p, id)?.clip;
      if (x?.type === "text") x.text = area.value;
    }, `${id}:text`));
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        this.closeTextEditor();
      }
    });
    area.addEventListener("blur", () => this.closeTextEditor());
    area.focus();
    area.select();
  }

  private closeTextEditor() {
    const editor = this.textEditor;
    if (!editor) return;
    this.textEditor = null;
    editor.el.remove();
  }

  /** Q and W: trims the clip's start or end to the playhead. */
  private trimToPlayhead(side: "start" | "end") {
    const t = this.engine.time;
    const targets = this.targets().filter((c) => t > c.start && t < clipEnd(c));
    if (!targets.length) return;
    this.change((p) => {
      for (const c of targets) {
        if (side === "end") trimEnd(p, c.id, t);
        else trimStart(p, c.id, t);
      }
    });
    if (side === "start") {
      const c = findClip(this.project, targets[0].id)?.clip;
      if (c) this.seek(c.start);
    }
  }

  // ---- freeze frames, colour tables, chroma key, beats

  /** Splits the main clip under the playhead and holds that frame for a few seconds between the parts. */
  private freezeFrame() {
    const t = this.engine.time;
    const chosen = [...this.selection].map((id) => findClip(this.project, id)).find((f) => f?.track.kind === "main" && f.clip.type === "media");
    const target = (chosen?.clip as MediaClip | undefined) ?? mainClipAt(this.project, t);
    const m = target ? mediaOf(this.project, target.media) : undefined;
    if (!target || !m || m.kind !== "video" || target.freeze !== undefined || t < target.start || t >= clipEnd(target)) {
      this.host.toast("Put the playhead on a video clip on the main track to freeze its frame.");
      return;
    }
    let freezeId = "";
    this.change((p) => {
      const found = findClip(p, target.id);
      if (!found) return;
      const clip = found.clip as MediaClip;
      const local = t - clip.start;
      const frozen: MediaClip = {
        ...structuredClone(clip), id: uid(), freeze: sourceTime(clip, t), duration: FREEZE_SECONDS, place: { ...placeAt(clip, local) },
        curve: null, reverse: undefined, fadeIn: 0, fadeOut: 0,
      };
      delete frozen.keys;
      delete frozen.transition;
      freezeId = frozen.id;
      const right = split(p, clip.id, t);
      const index = mainTrack(p).clips.findIndex((c) => c.id === clip.id);
      insertMain(p, frozen, right ? index + 1 : local <= 0.05 ? index : index + 1);
    });
    if (freezeId) this.select([freezeId], false);
  }

  private async loadLut(id: string) {
    const path = await open({ title: "Load a Colour Table", filters: [{ name: "Colour tables (.cube)", extensions: ["cube"] }] }).catch(() => null);
    if (!path) return;
    try {
      const text = await readText(path, TEXT_FILE_BYTES);
      if (text.binary) throw new Error("It isn't a text file.");
      const cube = parseCube(text.text);
      this.engine.forgetLut(path);
      this.change((p) => {
        const c = findClip(p, id)?.clip;
        if (c?.type === "media") c.fx.lut = { path, name: cube.title || stripExtension(basename(path)), strength: c.fx.lut?.strength ?? 1 };
      }, `${id}:lut`);
    } catch (err) {
      this.host.toast(`Couldn't use ${basename(path)}: ${errorText(err)}`);
    }
  }

  private pickKeyColor(id: string) {
    this.picking = id;
    this.engine.keyOff = id;
    this.engine.pause();
    this.engine.invalidate();
    this.frame.classList.add("picking");
    this.host.toast("Click the colour to remove in the preview (Esc to stop).");
  }

  private endPicking() {
    this.picking = null;
    this.engine.keyOff = null;
    this.frame.classList.remove("picking");
    this.engine.invalidate();
  }

  private async markBeats(id: string) {
    const clip = findClip(this.project, id)?.clip;
    const m = clip?.type === "media" ? mediaOf(this.project, clip.media) : undefined;
    if (!m) return;
    const sound = await this.store.sound(m);
    const beats = sound ? detectBeats(sound.peaks, PEAK_RATE) : [];
    if (beats.length < 4) {
      this.host.toast("No steady beat was found in this sound.");
      return;
    }
    this.change((p) => {
      const c = findClip(p, id)?.clip;
      if (c?.type === "media") c.beats = beats.map((b) => Math.round(b * 1000) / 1000);
    }, `${id}:beats`);
    const bpm = 60 / ((beats[beats.length - 1] - beats[0]) / (beats.length - 1));
    this.host.toast(`Marked ${beats.length} beats (about ${Math.round(bpm)} BPM). Clips snap to them.`);
  }

  // ---- voice-overs

  private async toggleRecording() {
    if (this.recording) return this.stopRecording(true);
    if (this.exporting) return;
    const folder = this.file ? `${dirname(this.file)}/Voice-overs` : null;
    let started: { id: number; path: string };
    try {
      started = await editApi.recordStart(folder);
    } catch (err) {
      this.host.toast(errorText(err));
      return;
    }
    const level = h("span", { class: "ve-record-level" });
    this.recordBtn.classList.add("recording");
    this.recordBtn.title = "Stop recording (R)";
    this.recordBtn.replaceChildren(icon("stop", 16), level);
    const volume = this.settings().volume;
    // The clips play silently while you speak, so the microphone doesn't hear them.
    this.engine.setVolume(0);
    const meter = window.setInterval(() => {
      if (!this.recording) return;
      void editApi.recordLevel(started.id).then((v) => {
        level.style.setProperty("--level", String(Math.min(1, v * 1.6)));
      }).catch(() => undefined);
    }, 90);
    // Playing from the end starts again from the beginning: the voice-over starts where playback does.
    this.engine.play();
    this.recording = { id: started.id, path: started.path, start: this.engine.time, meter, level, volume };
  }

  private async stopRecording(keep: boolean) {
    const r = this.recording;
    if (!r) return;
    this.recording = null;
    clearInterval(r.meter);
    this.engine.pause();
    this.engine.setVolume(r.volume);
    this.recordBtn.classList.remove("recording");
    this.recordBtn.title = "Record a voice-over (R)";
    this.recordBtn.replaceChildren(icon("veMic", 16));
    let done: { path: string; seconds: number };
    try {
      done = await editApi.recordStop(r.id, keep);
    } catch (err) {
      this.host.toast(errorText(err));
      return;
    }
    if (!keep) return;
    const [m] = await this.addFiles([done.path]);
    if (!m) return;
    let added = "";
    this.change((p) => {
      if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
      const clip = mediaClip(m, r.start);
      clip.role = "voice";
      added = clip.id;
      const voiceTrack = p.tracks.find((t) => t.kind === "audio" && t.clips.length > 0 && t.clips.every((c) => c.type === "media" && c.role === "voice"));
      placeFree(p, clip, "audio", voiceTrack?.id);
    });
    if (added) this.select([added], false);
    this.host.toast(`Recorded ${formatTime(done.seconds, 30, false)} of voice-over.`);
  }

  // ---- captions

  private async importSrt() {
    const path = await open({ title: "Import Captions", filters: [{ name: "Captions (.srt)", extensions: ["srt"] }] }).catch(() => null);
    if (!path) return;
    try {
      const file = await readText(path, TEXT_FILE_BYTES);
      const cues = parseSrt(file.text);
      if (!cues.length) throw new Error("It has no captions.");
      const preset = TEXT_PRESETS.find((x) => x.id === "caption") ?? TEXT_PRESETS[0];
      this.change((p) => {
        const track = newTrack(p, "text");
        for (const cue of cues) {
          track.clips.push({
            id: uid(), type: "text", start: cue.start, duration: cue.end - cue.start, text: cue.text,
            style: structuredClone(preset.style), place: { ...defaultPlace(), y: 0.8 }, animIn: "none", animOut: "none",
          });
        }
      });
      this.host.toast(`Added ${cues.length} captions from ${basename(path)}.`);
      requestAnimationFrame(() => this.timeline.fit());
    } catch (err) {
      this.host.toast(`Couldn't read ${basename(path)}: ${errorText(err)}`);
    }
  }

  private async exportSrt() {
    const texts = this.project.tracks.filter((t) => t.kind === "text" && !t.hidden).flatMap((t) => t.clips).filter((c): c is TextClip => c.type === "text" && !c.sticker);
    if (!texts.length) {
      this.host.toast("There are no texts to save as captions.");
      return;
    }
    let path = await save({ title: "Export Captions", defaultPath: `${this.file ? dirname(this.file) + "/" : ""}${this.title()}.srt`, filters: [{ name: "Captions (.srt)", extensions: ["srt"] }] }).catch(() => null);
    if (!path) return;
    if (!path.toLowerCase().endsWith(".srt")) path += ".srt";
    try {
      await editApi.writeText(path, writeSrt(texts.map((c) => ({ start: c.start, end: clipEnd(c), text: c.text }))));
      this.host.toast(`Saved ${texts.length} captions to ${basename(path)}.`);
    } catch (err) {
      this.host.toast(`Couldn't save: ${errorText(err)}`);
    }
  }

  // ---- missing files and AutoRecover

  /** Looks for moved files around the project; asks about the rest. */
  private async relinkMissing() {
    const missing = this.project.media.filter((m) => m.missing);
    if (!missing.length) return;
    const found = await this.searchFor(missing, null);
    if (found) this.host.toast(`Found ${found} moved file${found === 1 ? "" : "s"}.`);
    const still = this.project.media.filter((m) => m.missing);
    if (still.length) this.askMissing();
  }

  /** Searches `folder` (or around the project) for missing files; returns how many were found. */
  private async searchFor(missing: Media[], folder: string | null): Promise<number> {
    const found = await editApi.relink({
      project: this.file, folder,
      missing: missing.map((m) => ({ id: m.id, name: basename(m.path), bytes: m.bytes ?? null })),
      oldPaths: missing.map((m) => m.path),
    }).catch(() => []);
    if (found.length) this.relinked(found);
    return found.length;
  }

  private relinked(found: { id: string; path: string }[]) {
    this.change((p) => {
      for (const f of found) {
        const m = mediaOf(p, f.id);
        if (!m) continue;
        m.path = f.path;
        m.name = basename(f.path);
        delete m.missing;
      }
    });
    for (const f of found) {
      this.store.forget(f.id);
      this.engine.forgetMedia(f.id);
    }
    this.panel.refresh();
  }

  private askMissing() {
    const list = h("div", { class: "ve-missing-list" });
    const draw = () => {
      const still = this.project.media.filter((m) => m.missing);
      if (!still.length) return dialog.close();
      list.replaceChildren(...still.map((m) => h("div", { class: "ve-missing-row" },
        icon(m.kind === "audio" ? "music" : m.kind === "image" ? "image" : "video", 15),
        h("div", { class: "ve-missing-text" }, h("div", null, basename(m.path)), h("div", { class: "ve-missing-path" }, dirname(m.path).replace(/^\/home\/[^/]+/, "~"))),
        h("button", { class: "btn small", type: "button", onclick: () => void locate(m) }, "Locate…"))));
    };
    const locate = async (m: Media) => {
      const ext = m.path.slice(m.path.lastIndexOf(".") + 1);
      const picked = await open({ title: `Find ${basename(m.path)}`, filters: [{ name: basename(m.path), extensions: [ext] }, { name: "All files", extensions: ["*"] }] }).catch(() => null);
      if (!picked) return;
      this.relinked([{ id: m.id, path: picked }]);
      // The others are often in the same folder.
      const rest = this.project.media.filter((x) => x.missing);
      if (rest.length) await this.searchFor(rest, dirname(picked));
      draw();
    };
    const dialog = openDialog({
      title: "Some files are missing",
      subtitle: "They were moved, renamed or are on a drive that isn't connected.",
      icon: "search",
      tone: "work",
      class: "ve-export-dialog tone-video",
      body: [list],
      foot: [
        h("button", { class: "btn", type: "button", onclick: async () => {
          const folder = await open({ title: "Search a Folder", directory: true }).catch(() => null);
          if (!folder) return;
          const n = await this.searchFor(this.project.media.filter((m) => m.missing), folder);
          this.host.toast(n ? `Found ${n} file${n === 1 ? "" : "s"}.` : "Nothing with those names was found there.");
          draw();
        } }, "Search a folder…"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn primary", type: "button", onclick: () => dialog.close() }, "Later"),
      ],
    });
    draw();
  }

  /** Keeps a snapshot of unsaved changes for AutoRecover. */
  private async keepSnapshot() {
    if (!this.unsaved || this.exporting) return;
    const text = JSON.stringify({ ...this.project, _file: this.file });
    if (text === this.recoverText) return;
    this.recoverText = text;
    await editApi.recoverySave({ id: this.recoverId, title: this.title(), path: this.file }, text).catch(() => undefined);
  }

  private dropSnapshot() {
    this.recoverText = "";
    void editApi.recoveryDelete(this.recoverId).catch(() => undefined);
  }

  /** Opens an AutoRecover snapshot: the project as it was, still unsaved. */
  async openRecovered(id: string) {
    const raw = (await editApi.recoveryRead(id)) as { _file?: string | null };
    this.project = normalizeProject(raw);
    this.file = typeof raw._file === "string" ? raw._file : null;
    this.recoverId = id;
    this.unsaved = true;
    this.host.changed();
    this.refresh({ sound: false });
    this.panel.refresh();
    requestAnimationFrame(() => this.timeline.fit());
    await this.relinkMissing();
  }

  // ---- Make a Video (from the Gallery)

  /** Pictures become a reel in a slideshow theme's style, with its soundtrack on the beat. */
  async makeVideo(paths: string[], themeId: string, music: string | null) {
    const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
    const media = await this.addFiles(paths);
    const pictures = media.filter((m) => m.kind !== "audio");
    if (!pictures.length) return;
    // The slideshow's music: one of Zazabor's soundtracks, the user's own file, or none.
    let musicPath: string | null = null, bpm = 0;
    if (music?.startsWith(BUILTIN_MUSIC)) {
      const tracks = await api.builtinTracks().catch(() => []);
      const track = tracks.find((t) => t.id === music.slice(BUILTIN_MUSIC.length)) ?? tracks.find((t) => t.id === theme.track);
      musicPath = track?.path ?? null;
      bpm = track?.bpm ?? 0;
    } else if (music) musicPath = music;
    const [song] = musicPath ? await this.addFiles([musicPath]) : [];
    // Reels move faster than slideshows: about two thirds of the theme's time per picture, on the beat.
    let seconds = Math.max(1.2, Math.min(4.5, theme.look.duration * 0.65));
    if (bpm) {
      const bar = (60 / bpm) * theme.beatsPerCut;
      seconds = Math.max(bar, Math.round(seconds / bar) * bar);
    }
    const pool = theme.transitions.length ? theme.transitions : [["dissolve", 1] as const];
    const total = pool.reduce((sum, [, w]) => sum + w, 0);
    const pick = (i: number): TransitionKind => {
      let r = ((Math.sin(i * 12.9898 + 4.1) * 43758.5453) % 1 + 1) % 1 * total;
      for (const [kind, w] of pool) if ((r -= w) <= 0) return kind;
      return pool[0][0];
    };
    this.change((p) => {
      p.media.push(...media.filter((m) => !p.media.some((x) => x.id === m.id)));
      if (song && !p.media.some((x) => x.id === song.id)) p.media.push(song);
      pictures.forEach((m, i) => {
        const clip = mediaClip(m, 0);
        if (m.kind === "image") clip.duration = seconds;
        clip.fx.look = theme.look.look;
        clip.fx.vignette = theme.look.vignette * 0.6;
        clip.fx.grain = theme.look.grain * 0.5;
        if (i > 0) clip.transition = { kind: pick(i), duration: Math.min(theme.look.transitionTime * 0.6, seconds * 0.45) };
        insertMain(p, clip);
      });
      if (song) {
        const clip = mediaClip(song, 0);
        clip.duration = Math.min(song.duration || Infinity, projectDuration(p));
        clip.fadeOut = Math.min(2, clip.duration / 4);
        placeFree(p, clip, "audio");
      }
    });
    this.history = new History();
    this.unsaved = true;
    this.host.changed();
    this.refresh({ sound: false });
    this.panel.refresh();
    requestAnimationFrame(() => this.timeline.fit());
    this.host.toast(`Made a reel from ${pictures.length} picture${pictures.length === 1 ? "" : "s"} in the ${theme.label} style.`);
  }

  // ---- saving, opening, exporting

  async save(as = false): Promise<boolean> {
    let path = this.file;
    if (!path || as) {
      path = await save({ title: as ? "Save Video Project As" : "Save Video Project", defaultPath: `${this.title()}.zazvideo`, filters: [{ name: "Video projects", extensions: ["zazvideo"] }] }).catch(() => null);
      if (!path) return false;
      if (!/\.(zazvideo|corevideo)$/i.test(path)) path += ".zazvideo";
    }
    try {
      await editApi.saveProject(path, JSON.stringify(this.project));
    } catch (err) {
      this.host.toast(`Couldn't save: ${errorText(err)}`);
      return false;
    }
    this.file = path;
    this.unsaved = false;
    this.dropSnapshot();
    this.host.remember(path);
    this.host.changed();
    this.refresh({ sound: false });
    this.host.toast(`Saved ${basename(path)}`);
    return true;
  }

  async openProject(path: string) {
    const raw = await editApi.openProject(path);
    this.project = normalizeProject(raw);
    this.file = path;
    this.unsaved = false;
    this.refresh({ sound: false });
    this.panel.refresh();
    requestAnimationFrame(() => this.timeline.fit());
    void this.relinkMissing();
  }

  async startWith(paths: string[]) {
    const media = await this.addFiles(paths);
    if (!media.length) return;
    // A first clip in landscape on a new reel suggests a landscape project: keep the reel, but
    // show it whole over the blurred background.
    this.change((p) => {
      p.media.push(...media);
      this.putOnTimeline(p, media, 0);
    });
    this.history = new History();
    this.unsaved = false;
    this.refresh({ sound: false });
    requestAnimationFrame(() => this.timeline.fit());
  }

  private exportVideo() {
    if (this.exporting) return;
    if (projectDuration(this.project) <= 0) {
      this.host.toast("Add clips to the timeline first.");
      return;
    }
    this.exporting = true;
    this.closeTextEditor();
    void openExport({
      project: () => this.project,
      store: this.store,
      engine: this.engine,
      keyPrefix: `${this.prefix}x:`,
      title: this.title(),
      folder: this.file ? dirname(this.file) : null,
      shell: this.host.shell,
    }).catch((err) => this.host.toast(errorText(err))).finally(() => {
      this.exporting = false;
      this.fitStage();
      this.engine.invalidate();
    });
  }

  // ---- the Studio contract

  activate() {
    this.active = true;
    this.fitStage();
    this.engine.invalidate();
    this.timeline.redraw();
  }

  deactivate() {
    this.active = false;
    if (this.recording) void this.stopRecording(true);
    if (this.picking) this.endPicking();
    this.engine.pause();
    this.panel.stopListening();
    this.closeTextEditor();
    closeMenu();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active || this.exporting) return false;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
    if (this.recording) {
      if (key === "Escape") void this.stopRecording(false);
      else if (lower === "r" || key === " ") void this.stopRecording(true);
      return true;
    }
    if (this.picking && key === "Escape") {
      this.endPicking();
      return true;
    }
    // A focused slider takes its own keys (arrows, Home, End, Page Up/Down).
    if (e.target instanceof HTMLInputElement && e.target.type === "range" && /^(Arrow|Home$|End$|Page)/.test(key)) return false;
    if (mod && lower === "z") {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && lower === "y") {
      this.redo();
      return true;
    }
    if (mod && lower === "b") {
      this.command("split");
      return true;
    }
    if (mod && lower === "d") {
      this.command("duplicate");
      return true;
    }
    if (mod && lower === "e") {
      this.exportVideo();
      return true;
    }
    // Ctrl+0: the media panel; Ctrl+Alt+0: the inspector (as Xcode's navigator and inspector).
    if (mod && (e.code === "Digit0" || key === "0")) {
      if (e.altKey) this.setPanelOpen("right", !this.shownPanels.right);
      else this.setPanelOpen("left", !this.shownPanels.left);
      return true;
    }
    if (mod && !e.altKey && lower === "f" && !isTypingTarget(e.target)) {
      this.setPanelOpen("left", true);
      this.panel.focusSearch();
      return true;
    }
    // Alt+1…8: the media panel's categories.
    if (e.altKey && !mod && /^Digit[1-8]$/.test(e.code)) {
      this.setPanelOpen("left", true);
      this.panel.showIndex(Number(e.code.slice(5)) - 1);
      return true;
    }
    // Select all, copy, cut and paste are a field's own while typing in one.
    if (mod && !e.shiftKey && !e.altKey && ["a", "c", "x", "v"].includes(lower) && !isTypingTarget(e.target)) {
      if (lower === "a") this.selectAll();
      else if (lower === "v") this.paste();
      else this.copy(lower === "x");
      return true;
    }
    if (mod) return false;
    switch (key) {
      case " ":
        this.engine.toggle();
        return true;
      case "k": case "K":
        this.engine.pause();
        return true;
      case "l": case "L":
        this.engine.play();
        return true;
      case "j": case "J":
        this.seek(Math.max(0, this.engine.time - 5));
        return true;
      case "ArrowLeft":
        if (e.shiftKey) this.seek(Math.max(0, this.engine.time - 1));
        else this.step(-1);
        return true;
      case "ArrowRight":
        if (e.shiftKey) this.seek(this.engine.time + 1);
        else this.step(1);
        return true;
      case "Home":
        this.seek(0);
        return true;
      case "End":
        this.seek(projectDuration(this.project));
        return true;
      case "Delete": case "Backspace":
        this.command("delete", e.shiftKey);
        return true;
      case "s": case "S":
        this.command("split");
        return true;
      case "q": case "Q":
        this.trimToPlayhead("start");
        return true;
      case "w": case "W":
        this.trimToPlayhead("end");
        return true;
      case "n": case "N":
        this.timeline.toggleSnapKey();
        return true;
      case "r": case "R":
        void this.toggleRecording();
        return true;
      case "+": case "=":
        this.timeline.zoomBy(1.5);
        return true;
      case "-": case "_":
        this.timeline.zoomBy(1 / 1.5);
        return true;
      case "Escape":
        if (!this.selection.size) return false;
        this.select([], false);
        return true;
      default:
        return false;
    }
  }

  dispose() {
    clearInterval(this.recoverTimer);
    this.captions.dispose();
    this.panel.dispose();
    if (this.recording) void editApi.recordStop(this.recording.id, true).catch(() => undefined);
    // Closed on purpose (saved, or "Don't Save"): nothing to recover.
    this.dropSnapshot();
    this.observer.disconnect();
    this.timeline.dispose();
    this.engine.dispose();
    this.store.dispose();
  }
}

export const createVideoApp: StudioFactory = async (host, start) => {
  const app = new VideoEditor(host, start.aspect ?? "9:16");
  if (start.recover) {
    try {
      await app.openRecovered(start.recover);
    } catch (err) {
      app.dispose();
      throw err;
    }
  } else if (start.path) {
    try {
      await app.openProject(start.path);
    } catch (err) {
      app.dispose();
      throw err;
    }
  } else if (start.paths?.length && start.make) {
    void app.makeVideo(start.paths, start.make.theme, start.make.music);
  } else if (start.paths?.length) {
    void app.startWith(start.paths);
  }
  return app;
};

/** A text (not a sticker), or a template with texts to fill in: what Edit Text is for. */
function hasText(c: Clip): boolean {
  if (c.type === "text") return !c.sticker;
  return c.type === "template" && !!templateOf(c)?.fields.some((f) => f.kind === "text");
}

/** How far apart two #rrggbb colours are (0 = the same, about 440 = black and white). */
function colorDistance(a: string, b: string): number {
  const rgb = (c: string) => {
    const v = parseInt(/^#[0-9a-f]{6}$/i.test(c) ? c.slice(1) : "000000", 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
