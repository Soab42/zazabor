import type { Motion } from "./motion";
import type { Grade } from "./settings";

export interface SlideTexture {
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

export interface SlideFrame {
  texture: SlideTexture;
  motion: Motion;
  /** Eased motion progress, 0–1. */
  t: number;
}

export interface FrameState {
  /** The outgoing (or only) slide; null draws black. */
  a: SlideFrame | null;
  /** The incoming slide during a transition. */
  b: SlideFrame | null;
  /** Shader transition id (see TRANSITION_IDS). */
  transition: number;
  progress: number;
  /** Unit axis for directional transitions. */
  direction: [number, number];
  seed: number;
  /** Seconds, drives film grain. */
  time: number;
  /** 0 = black, 1 = fully visible. */
  fade: number;
  /** Letterbox bar height per side, as a fraction of the screen height. */
  bars: number;
  grade: Grade;
  grain: number;
  vignette: number;
}

export interface Renderer {
  readonly kind: "webgl2" | "canvas2d";
  readonly maxTextureSize: number;
  resize(width: number, height: number): void;
  upload(image: HTMLImageElement | HTMLCanvasElement): SlideTexture;
  render(state: FrameState): void;
  dispose(): void;
}
