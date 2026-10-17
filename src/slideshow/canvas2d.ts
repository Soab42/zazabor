import { lerpRect } from "./motion";
import type { FrameState, Renderer, SlideFrame, SlideTexture } from "./renderer";
import { TRANSITION_IDS } from "./settings";

class ImageTexture implements SlideTexture {
  readonly width: number;
  readonly height: number;
  /** A tiny copy that, stretched with smoothing, makes a cheap blurred backdrop. */
  readonly blurred: HTMLCanvasElement;
  constructor(readonly image: HTMLImageElement | HTMLCanvasElement | null) {
    this.width = (image instanceof HTMLImageElement ? image.naturalWidth : image?.width) ?? 1;
    this.height = (image instanceof HTMLImageElement ? image.naturalHeight : image?.height) ?? 1;
    this.blurred = document.createElement("canvas");
    this.blurred.width = 160;
    this.blurred.height = Math.max(1, Math.round((160 * this.height) / this.width));
    if (image) this.blurred.getContext("2d")!.drawImage(image, 0, 0, this.blurred.width, this.blurred.height);
  }
  dispose() {}
}

/** Fallback when WebGL2 is unavailable: Ken Burns, dissolves, letterbox and vignette. */
export class Canvas2DRenderer implements Renderer {
  readonly kind = "canvas2d";
  readonly maxTextureSize = 8192;
  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement("canvas");
  private layerCtx = this.layer.getContext("2d")!;
  private vignette: HTMLCanvasElement | null = null;
  private vignetteKey = "";

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
  }

  resize(width: number, height: number) {
    this.canvas.width = this.layer.width = Math.max(1, width);
    this.canvas.height = this.layer.height = Math.max(1, height);
  }

  upload(image: HTMLImageElement | HTMLCanvasElement): SlideTexture {
    return new ImageTexture(image);
  }

  render(state: FrameState) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (state.a) {
      const kind = state.transition;
      if (state.b && kind === TRANSITION_IDS.dip) {
        const p = state.progress;
        if (p < 0.5) this.drawSlide(ctx, state.a, state.bars, 1 - smooth(p * 2));
        else this.drawSlide(ctx, state.b, state.bars, smooth(p * 2 - 1));
      } else {
        this.drawSlide(ctx, state.a, state.bars, 1);
        if (state.b) this.drawSlide(ctx, state.b, state.bars, smooth(state.progress));
      }
    }
    ctx.globalAlpha = 1;
    if (state.vignette > 0) ctx.drawImage(this.vignetteCanvas(W, H, state.vignette), 0, 0);
    if (state.fade < 1) {
      ctx.fillStyle = `rgba(0, 0, 0, ${1 - state.fade})`;
      ctx.fillRect(0, 0, W, H);
    }
    const bar = Math.round(state.bars * H);
    if (bar > 0) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
    }
  }

  private drawSlide(ctx: CanvasRenderingContext2D, frame: SlideFrame, bars: number, alpha: number) {
    if (alpha <= 0) return;
    const texture = frame.texture as ImageTexture;
    if (!texture.image) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const top = bars * H;
    const bandH = H - top * 2;
    // Compose on a layer first so the slide fades as a whole.
    const l = this.layerCtx;
    l.imageSmoothingEnabled = true;
    l.imageSmoothingQuality = "high";
    const { motion, t } = frame;
    const rect = lerpRect(motion.from, motion.to, t);
    if (motion.mode === "fill") {
      l.drawImage(texture.image, rect.x * texture.width, rect.y * texture.height, rect.w * texture.width, rect.h * texture.height, 0, top, W, bandH);
    } else {
      const back = lerpRect(motion.backFrom, motion.backTo, t);
      const b = texture.blurred;
      l.drawImage(b, back.x * b.width, back.y * b.height, back.w * b.width, back.h * b.height, 0, top, W, bandH);
      l.fillStyle = "rgba(0, 0, 0, 0.28)";
      l.fillRect(0, top, W, bandH);
      l.save();
      l.shadowColor = "rgba(0, 0, 0, 0.6)";
      l.shadowBlur = bandH * 0.04;
      l.drawImage(texture.image, rect.x * W, top + rect.y * bandH, rect.w * W, rect.h * bandH);
      l.restore();
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.layer, 0, 0);
    ctx.globalAlpha = 1;
  }

  private vignetteCanvas(W: number, H: number, amount: number) {
    const key = `${W}x${H}:${amount.toFixed(2)}`;
    if (this.vignette && this.vignetteKey === key) return this.vignette;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    const r = Math.hypot(W, H) / 2;
    const gradient = g.createRadialGradient(W / 2, H / 2, r * 0.35, W / 2, H / 2, r * 1.1);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, `rgba(0,0,0,${amount * 0.75})`);
    g.fillStyle = gradient;
    g.fillRect(0, 0, W, H);
    this.vignette = c;
    this.vignetteKey = key;
    return c;
  }

  dispose() {}
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
