import { loadImage, thumbUrl } from "../api";
import type { Photo } from "../library/model";
import { clamp, h } from "../ui/dom";
import { GLRenderer } from "./gl";
import { planMotion } from "./motion";
import type { SlideFrame, SlideTexture } from "./renderer";
import { GRADES, TRANSITION_IDS, themeOf, transitionLabel, type SlideshowSettings, type TransitionKind } from "./settings";

const HOLD_MS = 450;
const PLAY_MS = 1300;
const ALL = Object.keys(TRANSITION_IDS) as TransitionKind[];

/** A small looping preview of transitions, played between two of the user's own photos. */
export class TransitionPreview {
  readonly el = h("div", { class: "tp" });
  private canvas = h("canvas", { class: "tp-canvas" });
  private label = h("div", { class: "tp-label" });
  private renderer: GLRenderer | null = null;
  private slides: { texture: SlideTexture; aspect: number }[] = [];
  private hovered: TransitionKind | null = null;
  private start = performance.now();
  private cycle = 0;
  private swapped = false;
  private frame = 0;
  private shownLabel = "";
  private started = false;
  private disposed = false;

  constructor(private readonly settings: SlideshowSettings, private readonly photos: Photo[]) {
    this.el.append(this.canvas, this.label);
  }

  /**
   * Compiling the transition shaders takes a moment, so it happens only once the surrounding
   * dialog has painted; the dialog itself opens instantly.
   */
  private init() {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      this.renderer = new GLRenderer(this.canvas);
      this.renderer.resize(512, 288);
    } catch {
      this.el.hidden = true;
      return;
    }
    this.el.classList.add("ready");
    if (this.frame === -1) this.frame = requestAnimationFrame(this.tick);
    const photos = this.photos;
    const picks = photos.length > 1 ? [photos[0], photos[Math.min(photos.length - 1, 1 + Math.floor(photos.length / 3))]] : photos;
    Promise.all(picks.map((p) => loadImage(thumbUrl(p.path, p.mtime, 512))))
      .then((images) => (images.length ? images : []))
      .catch(() => [] as HTMLImageElement[])
      .then((images) => {
        const sources: (HTMLImageElement | HTMLCanvasElement)[] = images.length >= 2 ? images : [images[0] ?? sample(0), sample(1)];
        if (!this.renderer) return;
        this.slides = sources.map((source) => ({ texture: this.renderer!.upload(source), aspect: sourceAspect(source) }));
      });
  }

  /** Plays one transition while the pointer is over its chip; null returns to the setting. */
  show(kind: TransitionKind | null) {
    if (kind === this.hovered) return;
    this.hovered = kind;
    this.start = performance.now();
  }

  play() {
    if (!this.started) {
      // -1 marks "play once ready".
      this.frame = -1;
      requestAnimationFrame(() => setTimeout(() => this.init(), 40));
      return;
    }
    if (this.frame <= 0 && this.renderer) this.frame = requestAnimationFrame(this.tick);
  }

  pause() {
    if (this.frame > 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  dispose() {
    this.disposed = true;
    this.pause();
    for (const slide of this.slides) slide.texture.dispose();
    this.slides = [];
    this.renderer?.dispose();
    this.renderer = null;
  }

  private current(): TransitionKind {
    if (this.hovered) return this.hovered;
    const choice = this.settings.transition;
    if (choice === "theme") {
      const pool = themeOf(this.settings.theme).transitions;
      return pool[this.cycle % pool.length][0];
    }
    if (choice === "random") return ALL[(this.cycle * 7) % ALL.length];
    return choice;
  }

  private tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.renderer || this.slides.length < 2) return;
    let elapsed = now - this.start;
    if (elapsed > HOLD_MS + PLAY_MS) {
      // The incoming photo becomes the outgoing one for the next run.
      this.start = now;
      this.cycle++;
      this.swapped = !this.swapped;
      elapsed = 0;
    }
    const progress = clamp((elapsed - HOLD_MS) / PLAY_MS, 0, 1);
    const kind = this.current();
    const text = transitionLabel(kind);
    if (text !== this.shownLabel) this.label.textContent = this.shownLabel = text;
    const [a, b] = this.swapped ? [this.slides[1], this.slides[0]] : [this.slides[0], this.slides[1]];
    const frame = (slide: { texture: SlideTexture; aspect: number }): SlideFrame => ({
      texture: slide.texture,
      motion: planMotion(slide.aspect, 16 / 9, "fill", 0, 1),
      t: 0,
    });
    this.renderer.render({
      a: frame(a),
      b: progress > 0 ? frame(b) : null,
      transition: TRANSITION_IDS[kind],
      progress,
      direction: kind === "shutter" ? [0, 1] : [1, 0],
      seed: 0.37 + this.cycle * 0.131,
      time: now / 1000,
      fade: 1,
      bars: 0,
      grade: GRADES.natural,
      grain: 0,
      vignette: 0.15,
    });
  };
}

function sourceAspect(source: HTMLImageElement | HTMLCanvasElement) {
  return source instanceof HTMLImageElement ? source.naturalWidth / source.naturalHeight : source.width / source.height;
}

/** Stand-in artwork when there are no photos to preview with. */
function sample(variant: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 288;
  const g = c.getContext("2d")!;
  const gradient = g.createLinearGradient(0, 0, 512, 288);
  gradient.addColorStop(0, variant ? "#173b5c" : "#5c2a17");
  gradient.addColorStop(1, variant ? "#7ac0d6" : "#f0b34a");
  g.fillStyle = gradient;
  g.fillRect(0, 0, 512, 288);
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath();
  g.arc(variant ? 360 : 150, 120, 46, 0, Math.PI * 2);
  g.fill();
  return c;
}
