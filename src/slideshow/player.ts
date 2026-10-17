import { getCurrentWindow } from "@tauri-apps/api/window";
import { displayRenderSize, loadImage, previewUrl } from "../api";
import type { Photo } from "../library/model";
import { clamp, formatDate, h, stripExtension } from "../ui/dom";
import { icon } from "../ui/icons";
import { Canvas2DRenderer } from "./canvas2d";
import { GLRenderer } from "./gl";
import { hashString, letterboxBars, motionEase, mulberry32, planMotion, type Motion } from "./motion";
import type { Renderer, SlideFrame, SlideTexture } from "./renderer";
import { MusicChannel, onPreviewChange, resolveMusic } from "./music";
import { GRADES, pickTransition, themeOf, TRANSITION_IDS, type SlideshowSettings, type TransitionKind } from "./settings";
import { SettingsForm, type SlideshowScope } from "./setup";

/** Opening title: 1 s fade in, 2.2 s hold, 1 s fade out. */
const TITLE_MS = 4200;
const TITLE_FADE_MS = 1000;
/** The first photo rises out of black. */
const INTRO_MS = 2000;
const OUTRO_MS = 2400;
/** Longest transition when the viewer skips manually, so skipping feels responsive. */
const SKIP_MS = 900;
const HUD_IDLE_MS = 2600;

interface Slide {
  photo: Photo;
  texture: SlideTexture;
  aspect: number;
  seed: number;
  motion?: Motion;
  motionKey?: string;
}

interface Showing {
  pos: number;
  slide: Slide;
  /** Virtual time its incoming transition started. */
  start: number;
  /** Length of that incoming transition. */
  tin: number;
}

interface Transition {
  pos: number;
  slide: Slide;
  start: number;
  duration: number;
  kind: TransitionKind;
  direction: [number, number];
  seed: number;
}

export interface PlayerOptions {
  scope: SlideshowScope;
  settings: SlideshowSettings;
  saveSettings(): void;
  onExit(photo: Photo | null): void;
}

type Next = { pos: number; slide: Slide } | "wait" | "end";

export class Player {
  private el = h("div", { class: "slideshow" });
  private canvas = h("canvas", { class: "ss-canvas" });
  private renderer!: Renderer;
  private photos: Photo[];
  private order: number[];
  private startPos: number;
  private slides = new Map<number, Promise<Slide | null>>();
  private ready = new Map<number, Slide | null>();
  private cur: Showing | null = null;
  private trans: Transition | null = null;
  private pendingSkip: 1 | -1 | null = null;
  private phase: "title" | "show" | "outro" = "title";
  private skipTitle = false;
  private introStart = -1;
  private outroStart = -1;
  /** Virtual clock in ms; it stops while paused. */
  private vt = 0;
  private lastFrame = 0;
  private frame = 0;
  private paused = false;
  private destroyed = false;
  private lastKind: TransitionKind | null = null;
  private random = mulberry32((Math.random() * 2 ** 32) >>> 0);
  private salt = (Math.random() * 2 ** 32) >>> 0;
  private renderSize = 2560;
  private wasFullscreen = true;
  private wakeLock: WakeLockSentinel | null = null;
  private music = new MusicChannel("show");
  private unsubscribePreview: () => void;
  private muted = false;
  /** Tempo of the playing soundtrack when known (built-in tracks), for cutting on the beat. */
  private bpm: number | null = null;
  /** The music setting the current audio was loaded for. */
  private playingMusic: string | null = null;
  /** Virtual time at which the next automatic transition starts, once scheduled. */
  private cutAt: number | null = null;

  private titleCard: HTMLElement;
  private caption = h("div", { class: "ss-caption" });
  private pausedBadge = h("div", { class: "ss-paused", hidden: true }, icon("pause", 14), "Paused");
  private hud = h("div", { class: "ss-hud" });
  private playButton = h("button", { class: "ss-btn", title: "Pause (Space)" }, icon("pause", 20));
  private muteButton = h("button", { class: "ss-btn", title: "Mute (M)" }, icon("volume", 19));
  private counter = h("span", { class: "ss-count" });
  private progressFill = h("div", { class: "ss-progress-fill" });
  private panel = h("div", { class: "ss-panel", hidden: true });
  private form: SettingsForm;
  private idleTimer = 0;

  constructor(private readonly options: PlayerOptions) {
    const { scope } = options;
    this.photos = scope.photos;
    const indices = this.photos.map((_, i) => i);
    if (this.settings.shuffle) {
      // Start with the chosen photo, then the rest in random order.
      const rest = indices.filter((i) => i !== scope.start);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.order = [scope.start, ...rest];
      this.startPos = 0;
    } else {
      this.order = indices;
      this.startPos = clamp(scope.start, 0, indices.length - 1);
    }

    this.titleCard = this.buildTitleCard();
    this.form = new SettingsForm(this.settings, (key) => this.onSettingChanged(key), this.order.slice(this.startPos, this.startPos + 6).map((i) => this.photos[i]));
    this.panel.append(h("div", { class: "ss-panel-head" }, h("span", null, "Slideshow settings")), this.form.preview.el, this.form.el);
    this.buildHud();
    this.el.append(this.canvas, this.titleCard, this.caption, this.pausedBadge, this.panel, this.hud);
    this.el.addEventListener("pointermove", () => this.wake());
    this.canvas.addEventListener("click", this.onCanvasClick);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.unsubscribePreview = onPreviewChange((active) => {
      if (this.playingMusic && !this.paused) this.music.volume(active ? this.targetVolume * 0.15 : this.targetVolume, 300);
    });
  }

  private get settings() {
    return this.options.settings;
  }

  async start() {
    document.body.append(this.el);
    try {
      this.renderer = new GLRenderer(this.canvas);
    } catch (err) {
      console.warn("WebGL2 unavailable, using the Canvas2D slideshow renderer:", err);
      const fallback = h("canvas", { class: "ss-canvas" });
      this.canvas.replaceWith(fallback);
      this.canvas = fallback;
      this.canvas.addEventListener("click", this.onCanvasClick);
      this.renderer = new Canvas2DRenderer(this.canvas);
    }
    this.renderSize = Math.min(displayRenderSize(), this.renderer.maxTextureSize);
    this.resize();
    this.prefetch(this.startPos);
    this.lastFrame = performance.now();
    this.frame = requestAnimationFrame(this.tick);
    this.wake();

    void this.loadMusic();
    const win = getCurrentWindow();
    this.wasFullscreen = await win.isFullscreen().catch(() => true);
    if (!this.wasFullscreen) await win.setFullscreen(true).catch((err) => console.warn("Fullscreen failed:", err));
    // Keep the screen awake where the webview supports it.
    navigator.wakeLock?.request("screen").then((lock) => (this.wakeLock = lock), () => {});
  }

  private onCanvasClick = () => {
    if (!this.panel.hidden) this.togglePanel(false);
    else this.togglePause();
  };

  async exit() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.idleTimer);
    this.wakeLock?.release().catch(() => {});
    this.stopMusic();
    this.unsubscribePreview();
    const photo = (this.trans ?? this.cur)?.slide.photo ?? this.photos[this.order[this.startPos]] ?? null;
    this.el.classList.add("closing");
    if (!this.wasFullscreen) await getCurrentWindow().setFullscreen(false).catch(() => {});
    for (const promise of this.slides.values()) promise.then((slide) => slide?.texture.dispose());
    this.slides.clear();
    this.ready.clear();
    this.renderer.dispose();
    this.form.dispose();
    this.el.remove();
    this.options.onExit(photo);
  }

  handleKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case "Escape":
        if (!this.panel.hidden) this.togglePanel(false);
        else this.exit();
        return true;
      case " ": case "k": case "K":
        this.togglePause();
        return true;
      case "ArrowRight": case "PageDown":
        this.skip(1);
        return true;
      case "ArrowLeft": case "PageUp":
        this.skip(-1);
        return true;
      case "m": case "M":
        this.toggleMute();
        return true;
      case "s": case "S": case ",":
        this.togglePanel();
        return true;
      case "c": case "C":
        this.settings.captions = !this.settings.captions;
        this.onSettingChanged("captions");
        this.form.sync();
        return true;
      default:
        return false;
    }
  }

  // ---- timeline ---------------------------------------------------------------------------

  private tick = (now: number) => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    // Transitions always finish, even when paused, so manual skips complete.
    if (!this.paused || this.trans || this.phase === "outro") this.vt += dt;
    this.update();
    this.draw(now);
  };

  private update() {
    const T = this.settings.transitionTime * 1000;
    const D = this.settings.duration * 1000;

    if (this.phase === "title") {
      const titleDone = !this.settings.titleCard || this.skipTitle || this.vt >= TITLE_MS;
      this.titleCard.classList.toggle("visible", this.settings.titleCard && !this.skipTitle && this.vt > 150 && this.vt < TITLE_MS - TITLE_FADE_MS);
      const first = this.resolveFrom(this.startPos);
      if (titleDone && first !== "wait") {
        if (first === "end") {
          this.exit();
          return;
        }
        this.titleCard.classList.remove("visible");
        this.cur = { pos: first.pos, slide: first.slide, start: this.vt, tin: INTRO_MS };
        this.introStart = this.vt;
        this.phase = "show";
        this.onSlideShown();
      }
      return;
    }

    if (this.phase === "outro") {
      if (this.vt - this.outroStart >= OUTRO_MS) this.exit();
      return;
    }

    if (this.trans && this.vt >= this.trans.start + this.trans.duration) {
      const t = this.trans;
      this.cur = { pos: t.pos, slide: t.slide, start: t.start, tin: t.duration };
      this.trans = null;
      this.onSlideShown();
    }
    if (this.trans || !this.cur) return;

    if (this.pendingSkip) {
      const target = this.nextFrom(this.cur.pos, this.pendingSkip);
      if (target === "end") this.pendingSkip = null;
      else if (target !== "wait") {
        this.pendingSkip = null;
        this.beginTransition(target.pos, target.slide, Math.min(T, SKIP_MS));
      }
      return;
    }

    if (this.paused || this.vt < this.cur.start + this.cur.tin + D) return;
    const next = this.nextFrom(this.cur.pos, 1);
    if (next === "end") {
      this.phase = "outro";
      this.outroStart = this.vt;
      this.caption.classList.remove("visible");
    } else if (next !== "wait") {
      this.cutAt ??= this.vt + this.beatDelay(T);
      if (this.vt >= this.cutAt) this.beginTransition(next.pos, next.slide, T);
    }
  }

  /**
   * How long to wait so the middle of a transition of `duration` ms lands on the beat grid
   * of the soundtrack; 0 when the tempo is unknown or beat sync is off.
   */
  private beatDelay(duration: number) {
    const music = this.music;
    if (!this.settings.beatSync || !this.bpm || !music.playing) return 0;
    const grid = (60 / this.bpm) * themeOf(this.settings.theme).beatsPerCut;
    const middle = music.position + duration / 2000;
    return (Math.ceil(middle / grid) * grid - middle) * 1000;
  }

  private step(pos: number, dir: 1 | -1): number | null {
    const next = pos + dir;
    if (next >= 0 && next < this.order.length) return next;
    if (!this.settings.loop) return null;
    return (next + this.order.length) % this.order.length;
  }

  /** The first loadable slide at or after `pos`, skipping photos that failed to load. */
  private resolveFrom(pos: number): Next {
    this.prefetch(pos);
    if (!this.ready.has(pos)) return "wait";
    const slide = this.ready.get(pos);
    if (slide) return { pos, slide };
    return this.nextFrom(pos, 1);
  }

  private nextFrom(pos: number, dir: 1 | -1): Next {
    let p: number | null = pos;
    for (let tries = 0; tries < this.order.length; tries++) {
      p = this.step(p, dir);
      if (p === null) return "end";
      this.load(p);
      if (!this.ready.has(p)) return "wait";
      const slide = this.ready.get(p);
      if (slide) return { pos: p, slide };
    }
    return "end";
  }

  private beginTransition(pos: number, slide: Slide, duration: number) {
    const kind = pickTransition(this.settings, this.lastKind, this.random);
    this.lastKind = kind;
    this.cutAt = null;
    let direction: [number, number] = this.random() < 0.5 ? [1, 0] : [-1, 0];
    if (kind === "wipe") {
      const angle = (this.random() - 0.5) * 0.9 + (this.random() < 0.5 ? 0 : Math.PI);
      direction = [Math.cos(angle), Math.sin(angle)];
    } else if (kind === "shutter") {
      direction = this.random() < 0.5 ? [1, 0] : [0, 1];
    }
    this.trans = { pos, slide, start: this.vt, duration, kind, direction, seed: this.random() };
    this.caption.classList.remove("visible");
    this.prefetch(pos);
  }

  skipBy(dir: 1 | -1) {
    this.skip(dir);
    this.wake();
  }

  private skip(dir: 1 | -1) {
    if (this.phase === "title") {
      this.skipTitle = true;
      return;
    }
    if (this.phase !== "show" || !this.cur) return;
    if (this.trans) {
      // Land the running transition immediately, then move on from there.
      const t = this.trans;
      this.cur = { pos: t.pos, slide: t.slide, start: this.vt - t.duration, tin: t.duration };
      this.trans = null;
      this.onSlideShown();
    }
    this.pendingSkip = dir;
    this.update();
  }

  private onSlideShown() {
    if (!this.cur) return;
    this.prefetch(this.cur.pos);
    this.updateCounter();
    const photo = this.cur.slide.photo;
    this.caption.replaceChildren(
      h("div", { class: "ss-caption-name" }, stripExtension(photo.name)),
      h("div", { class: "ss-caption-meta" }, [photo.folder.name, formatDate(photo.mtime, "long")].filter(Boolean).join("  ·  ")),
    );
    window.setTimeout(() => {
      if (this.cur?.slide.photo === photo && !this.trans) this.caption.classList.toggle("visible", this.settings.captions);
    }, 500);
  }

  // ---- loading ----------------------------------------------------------------------------

  /** Loads the slides around `pos` and releases the rest. */
  private prefetch(pos: number) {
    const keep = new Set<number>([pos]);
    let p: number | null = pos;
    for (let i = 0; i < 2 && p !== null; i++) {
      p = this.step(p, 1);
      if (p !== null) keep.add(p);
    }
    const prev = this.step(pos, -1);
    if (prev !== null) keep.add(prev);
    if (this.cur) keep.add(this.cur.pos);
    if (this.trans) keep.add(this.trans.pos);
    for (const k of keep) this.load(k);
    for (const [k, promise] of this.slides) {
      if (keep.has(k)) continue;
      this.slides.delete(k);
      this.ready.delete(k);
      promise.then((slide) => slide?.texture.dispose());
    }
  }

  private load(pos: number) {
    if (this.slides.has(pos)) return;
    const photo = this.photos[this.order[pos]];
    const promise: Promise<Slide | null> = loadImage(previewUrl(photo.path, photo.mtime, this.renderSize))
      .then((img) => {
        if (this.destroyed) return null;
        return {
          photo,
          texture: this.renderer.upload(img),
          aspect: img.naturalWidth / img.naturalHeight,
          seed: (hashString(photo.path) ^ this.salt ^ pos) >>> 0,
        };
      })
      .catch((err) => {
        console.warn(`Slideshow skipped ${photo.path}:`, err);
        return null;
      });
    this.slides.set(pos, promise);
    promise.then((slide) => {
      if (this.slides.get(pos) === promise) this.ready.set(pos, slide);
      else slide?.texture.dispose();
    });
  }

  // ---- drawing ----------------------------------------------------------------------------

  private resize() {
    if (!this.renderer) return;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.resize(Math.round(this.el.clientWidth * dpr), Math.round(this.el.clientHeight * dpr));
    this.canvas.style.width = `${this.el.clientWidth}px`;
    this.canvas.style.height = `${this.el.clientHeight}px`;
  }

  private motionFor(slide: Slide, frameAspect: number): Motion {
    const s = this.settings;
    const key = `${frameAspect.toFixed(4)}|${s.framing}|${s.kenBurns}`;
    if (slide.motionKey !== key) {
      slide.motion = planMotion(slide.aspect, frameAspect, s.framing, s.kenBurns, slide.seed);
      slide.motionKey = key;
    }
    return slide.motion!;
  }

  private draw(now: number) {
    const s = this.settings;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const bars = letterboxBars(W / H, s.letterbox);
    const frameAspect = W / H / (1 - 2 * bars);
    const T = s.transitionTime * 1000;
    const D = s.duration * 1000;
    const frameOf = (slide: Slide, start: number, tin: number): SlideFrame => ({
      texture: slide.texture,
      motion: this.motionFor(slide, frameAspect),
      t: motionEase((this.vt - start) / (tin + D + T)),
    });

    let fade = 1;
    if (this.phase === "title") fade = 0;
    else if (this.phase === "outro") fade = 1 - smooth((this.vt - this.outroStart) / OUTRO_MS);
    else if (this.introStart >= 0) fade = smooth((this.vt - this.introStart) / INTRO_MS);

    const t = this.trans;
    this.renderer.render({
      a: this.cur ? frameOf(this.cur.slide, this.cur.start, this.cur.tin) : null,
      b: t ? frameOf(t.slide, t.start, t.duration) : null,
      transition: t ? TRANSITION_IDS[t.kind] : 0,
      progress: t ? (this.vt - t.start) / t.duration : 0,
      direction: t?.direction ?? [1, 0],
      seed: t?.seed ?? 0,
      time: now / 1000,
      fade,
      bars,
      grade: GRADES[s.look],
      grain: s.grain,
      vignette: s.vignette,
    });

    this.caption.style.bottom = `calc(${(bars * 100).toFixed(3)}% + 4.5vh)`;
    if (this.cur && this.phase === "show") {
      const into = clamp((this.vt - this.cur.start - this.cur.tin) / D, 0, 1);
      const pos = this.order.length > 1 ? (this.cur.pos + into) / this.order.length : into;
      this.progressFill.style.transform = `scaleX(${pos})`;
    }
  }

  // ---- chrome -----------------------------------------------------------------------------

  private buildTitleCard() {
    const { scope } = this.options;
    let first = Infinity;
    let last = 0;
    for (const p of scope.photos) {
      if (!p.mtime) continue;
      first = Math.min(first, p.mtime);
      last = Math.max(last, p.mtime);
    }
    const from = Number.isFinite(first) ? formatDate(first, "short") : "";
    const to = last ? formatDate(last, "short") : "";
    const dates = from && to && from !== to ? `${from} – ${to}` : from;
    const count = `${scope.photos.length.toLocaleString()} ${scope.photos.length === 1 ? "photo" : "photos"}`;
    return h(
      "div",
      { class: "ss-title" },
      h("h1", null, scope.title),
      h("div", { class: "ss-rule" }),
      h("p", null, [dates, count].filter(Boolean).join("   ·   ")),
    );
  }

  private buildHud() {
    const prev = h("button", { class: "ss-btn", title: "Previous (←)", onclick: () => this.skip(-1) }, icon("prev", 18));
    const next = h("button", { class: "ss-btn", title: "Next (→)", onclick: () => this.skip(1) }, icon("next", 18));
    this.playButton.addEventListener("click", () => this.togglePause());
    this.muteButton.addEventListener("click", () => this.toggleMute());
    this.muteButton.hidden = !this.settings.music;
    const settingsButton = h("button", { class: "ss-btn", title: "Settings (S)", onclick: () => this.togglePanel() }, icon("settings", 19));
    const close = h("button", { class: "ss-btn", title: "End slideshow (Esc)", onclick: () => this.exit() }, icon("close", 19));
    this.hud.append(
      prev, this.playButton, next,
      this.counter,
      h("div", { class: "ss-progress" }, this.progressFill),
      this.muteButton, settingsButton, close,
    );
    this.hud.addEventListener("pointerenter", () => this.wake());
    this.updateCounter();
  }

  private updateCounter() {
    const pos = this.cur?.pos ?? this.startPos;
    this.counter.textContent = `${pos + 1} / ${this.order.length}`;
  }

  private wake() {
    this.el.classList.remove("idle");
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.panel.hidden && !this.hud.matches(":hover")) this.el.classList.add("idle");
    }, HUD_IDLE_MS);
  }

  private togglePanel(show: boolean = Boolean(this.panel.hidden)) {
    this.panel.hidden = !show;
    this.form.setVisible(show);
    this.wake();
  }

  private togglePause() {
    this.paused = !this.paused;
    this.playButton.replaceChildren(icon(this.paused ? "play" : "pause", 20));
    this.playButton.title = this.paused ? "Play (Space)" : "Pause (Space)";
    this.pausedBadge.hidden = !this.paused;
    if (this.playingMusic) {
      if (this.paused) this.music.pause();
      else this.music.resume(this.targetVolume);
    }
    this.wake();
  }

  private onSettingChanged(key: keyof SlideshowSettings) {
    this.options.saveSettings();
    if (key === "captions") this.caption.classList.toggle("visible", this.settings.captions && !!this.cur && !this.trans);
    if (key === "music" || (key === "theme" && this.settings.music !== this.playingMusic)) {
      this.stopMusic();
      this.loadMusic();
    }
    if (key === "musicVolume") this.music.volume(this.targetVolume, 200);
  }

  // ---- music ------------------------------------------------------------------------------

  private get targetVolume() {
    return this.muted ? 0 : this.settings.musicVolume;
  }

  private async loadMusic() {
    const choice = this.settings.music;
    this.playingMusic = choice;
    this.muteButton.hidden = !choice;
    this.bpm = null;
    if (!choice) return;
    try {
      const resolved = await resolveMusic(choice);
      if (!resolved) throw new Error("soundtrack not found");
      if (this.destroyed || this.playingMusic !== choice) return;
      await this.music.play(resolved.path, this.paused ? 0 : this.targetVolume, 2500);
      if (this.destroyed || this.playingMusic !== choice) return;
      this.bpm = resolved.bpm;
      if (this.paused) this.music.pause(0);
    } catch (err) {
      console.warn(`Could not play ${choice}:`, err);
      this.muteButton.hidden = true;
    }
  }

  private stopMusic() {
    this.playingMusic = null;
    this.bpm = null;
    this.music.stop();
  }

  private toggleMute() {
    if (!this.playingMusic) return;
    this.muted = !this.muted;
    this.muteButton.replaceChildren(icon(this.muted ? "mute" : "volume", 19));
    this.music.volume(this.targetVolume, 300);
    this.wake();
  }
}

const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
