import { api } from "../../../api";
import { open, save } from "../../../shared/dialog";
import { readText } from "../../../shared/quicklook/api";
import { basename, dirname, h, stripExtension } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { BUILTIN_MUSIC, THEMES, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import { openDialog } from "../../time/dialog";
import { errorText } from "../../time/api";
import type { Aspect, StudioApp, StudioFactory, StudioHost } from "../app";
import { detectBeats } from "./audio";
import { editApi } from "./api";
import { Engine, mainClipAt } from "./engine";
import { openExport } from "./export";
import { Inspector } from "./inspector";
import { parseCube } from "./lut";
import { AUDIO_EXTENSIONS, MediaStore, PEAK_RATE, PICTURE_EXTENSIONS, probeMedia, VIDEO_EXTENSIONS } from "./media";
import {
  clipEnd, findClip, insertMain, layoutMain, mainIndexAt, mainTrack, mediaClip, mediaOf, newProject, newTrack, normalizeProject, placeAt, placeFree,
  projectDuration, remove, setProp, sourceTime, split, TEXT_SECONDS, tidyTracks, trimEnd, trimStart, uid, defaultPlace,
  type Clip, type Media, type MediaClip, type Project, type TextClip,
} from "./model";
import { parseSrt, writeSrt } from "./srt";
import { Panel } from "./panels";
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
}

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
  private inspector: Inspector;
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
  /** Picking a chroma key colour from the preview for this clip. */
  private picking: string | null = null;

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
        this.panel.show("transitions");
      },
      command: (name) => this.command(name),
      fps: () => this.project.canvas.fps,
    });

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
      transitionTarget: () => this.transitionTarget(),
      applyTransition: (kind, duration, all) => this.applyTransition(kind, duration, all),
      currentLook: () => this.currentLook(),
      applyLook: (look, all) => this.applyLook(look, all),
    });

    this.inspector = new Inspector({
      project: () => this.project,
      selectedId: () => (this.selection.size === 1 ? [...this.selection][0] : null),
      change: (fn, key) => this.change(fn, key),
      setAspect: (a) => this.change((p) => (p.canvas.aspect = a), "aspect"),
      time: () => this.engine.time,
      seek: (t) => this.seek(t),
      loadLut: (id) => void this.loadLut(id),
      pickKeyColor: (id) => this.pickKeyColor(id),
      freezeFrame: () => this.freezeFrame(),
      markBeats: (id) => void this.markBeats(id),
    });

    const tb = (name: Parameters<typeof icon>[0], title: string, run: () => void) =>
      h("button", { class: "icon-btn", type: "button", title, "aria-label": title, onclick: run }, icon(name, 18));
    this.undoBtn = tb("undo", "Undo (Ctrl+Z)", () => this.undo());
    this.redoBtn = tb("redo", "Redo (Ctrl+Shift+Z)", () => this.redo());
    this.titleEl = h("div", { class: "ve-title" });
    const top = h("header", { class: "ve-top" },
      tb("back", "Studio Home", () => host.showHome()),
      h("div", { class: "ve-brand" }, icon("videoEdit", 18)),
      this.titleEl,
      h("span", { class: "spacer" }),
      this.undoBtn, this.redoBtn,
      tb("save", "Save (Ctrl+S)", () => void this.save()),
      h("button", { class: "btn primary ve-export", type: "button", onclick: () => this.exportVideo() }, icon("download", 16), "Export"),
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
    const main = h("div", { class: "ve-main" }, this.panel.el, player, this.inspector.el);
    const splitter = h("div", { class: "ve-split", title: "Drag to resize the timeline" });
    this.el = h("div", { class: "of-editor ve-app tone-video" }, top, main, splitter, this.timeline.el);
    this.dragSplitter(splitter);
    this.canvasPointer();

    this.observer = new ResizeObserver(() => this.fitStage());
    this.observer.observe(this.stage);
    this.refresh({ sound: false });
    this.recoverTimer = window.setInterval(() => void this.keepSnapshot(), RECOVER_MS);
  }

  // ---- settings and title

  private settings(): Settings {
    const apps = this.host.shell.config.studio.apps;
    const raw = (apps.video ?? {}) as Partial<Settings>;
    const s: Settings = { volume: typeof raw.volume === "number" ? Math.max(0, Math.min(1, raw.volume)) : 1 };
    apps.video = s;
    return s;
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
    this.project = JSON.parse(s) as Project;
    this.markDirty();
    this.refresh({ sound: true });
    this.panel.refresh();
  }

  private redo() {
    const s = this.history.redo(JSON.stringify(this.project));
    if (s === null) return;
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
      p.media = p.media.filter((m) => m.id !== id);
      layoutMain(p);
      tidyTracks(p);
    });
    this.engine.forgetMedia(id);
    if (used) this.host.toast("Removed the file and its clips. Undo brings them back.");
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

  private transitionTarget(): MediaClip | null {
    const main = mainTrack(this.project).clips as MediaClip[];
    const selected = main.find((c, i) => i > 0 && this.selection.has(c.id));
    if (selected) return selected;
    if (main.length < 2) return null;
    // The cut nearest the playhead.
    const t = this.engine.time;
    return main.slice(1).reduce((best, c) => (Math.abs(c.start - t) < Math.abs(best.start - t) ? c : best));
  }

  private applyTransition(kind: TransitionKind | null, duration: number, all: boolean) {
    const target = this.transitionTarget();
    if (!target) return;
    this.change((p) => {
      const main = mainTrack(p).clips as MediaClip[];
      const targets = all ? main.slice(1) : main.filter((c) => c.id === target.id);
      for (const c of targets) {
        if (kind) c.transition = { kind, duration };
        else delete c.transition;
      }
      layoutMain(p);
    }, all ? "" : `transition:${target.id}`);
    this.selection.clear();
    this.selection.add(target.id);
    this.panel.refresh();
    this.inspector.refresh();
    if (kind) {
      // Show it: play from just before the cut.
      this.seek(Math.max(0, target.start - duration / 2 - 0.4));
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
          if (found.track.kind === "main") {
            if (copy.type === "media") delete copy.transition;
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
    const texts = this.project.tracks.filter((t) => t.kind === "text" && !t.hidden).flatMap((t) => t.clips).filter((c): c is TextClip => c.type === "text");
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
    // The slideshow's music: one of CorePro's soundtracks, the user's own file, or none.
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
      path = await save({ title: as ? "Save Video Project As" : "Save Video Project", defaultPath: `${this.title()}.corevideo`, filters: [{ name: "Video projects", extensions: ["corevideo"] }] }).catch(() => null);
      if (!path) return false;
      if (!path.toLowerCase().endsWith(".corevideo")) path += ".corevideo";
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
