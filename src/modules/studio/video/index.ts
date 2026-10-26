import { open, save } from "../../../shared/dialog";
import { basename, dirname, h, stripExtension } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import type { LookId, TransitionKind } from "../../gallery/slideshow/settings";
import { errorText } from "../../time/api";
import type { Aspect, StudioApp, StudioFactory, StudioHost } from "../app";
import { editApi } from "./api";
import { Engine, mainClipAt } from "./engine";
import { openExport } from "./export";
import { Inspector } from "./inspector";
import { AUDIO_EXTENSIONS, MediaStore, PICTURE_EXTENSIONS, probeMedia, VIDEO_EXTENSIONS } from "./media";
import {
  clipEnd, findClip, insertMain, layoutMain, mainIndexAt, mainTrack, mediaClip, mediaOf, newProject, normalizeProject, placeFree,
  projectDuration, remove, split, TEXT_SECONDS, tidyTracks, trimEnd, trimStart, uid, defaultPlace,
  type Clip, type Media, type MediaClip, type Project, type TextClip,
} from "./model";
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
      const hit = this.engine.clipAtPoint(this.engine.time, (e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
      if (!hit) {
        this.select([], false);
        return;
      }
      if (!this.selection.has(hit.id)) this.select([hit.id], false);
      this.canvas.setPointerCapture(e.pointerId);
      const start = { x: e.clientX, y: e.clientY, px: hit.place.x, py: hit.place.y };
      const key = `canvas-move:${hit.id}:${Date.now()}`;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - start.x) / rect.width, dy = (ev.clientY - start.y) / rect.height;
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 3) return;
        this.change((p) => {
          const c = findClip(p, hit.id)?.clip;
          if (!c) return;
          // Snap back to the centre lines.
          const x = start.px + dx, y = start.py + dy;
          c.place.x = Math.abs(x - 0.5) < 0.012 ? 0.5 : x;
          c.place.y = Math.abs(y - 0.5) < 0.012 ? 0.5 : y;
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
    const missing = this.project.media.filter((m) => m.missing);
    if (missing.length) this.host.toast(`${missing.length} file${missing.length === 1 ? " is" : "s are"} missing: ${missing.map((m) => m.name).slice(0, 3).join(", ")}`);
    requestAnimationFrame(() => this.timeline.fit());
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
    this.engine.pause();
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active || this.exporting) return false;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.toLowerCase();
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
    this.observer.disconnect();
    this.timeline.dispose();
    this.engine.dispose();
    this.store.dispose();
  }
}

export const createVideoApp: StudioFactory = async (host, start) => {
  const app = new VideoEditor(host, start.aspect ?? "9:16");
  if (start.path) {
    try {
      await app.openProject(start.path);
    } catch (err) {
      app.dispose();
      throw err;
    }
  } else if (start.paths?.length) {
    void app.startWith(start.paths);
  }
  return app;
};
