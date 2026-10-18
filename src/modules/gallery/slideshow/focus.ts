/** Where the eye goes in a photo, in normalized image coordinates. */
export interface Focus {
  x: number;
  y: number;
  /** 0 when nothing stands out (an evenly busy or empty scene), 1 for a clear subject. */
  weight: number;
}

/** Long edge of the copy the focus is found on: coarse, but plenty to aim a camera. */
const PROBE = 96;

/** Finds the photo's subject from a tiny copy; null when the pixels can't be read. */
export function findFocus(image: HTMLImageElement | HTMLCanvasElement): Focus | null {
  const iw = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const ih = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  if (!iw || !ih) return null;
  const w = iw >= ih ? PROBE : Math.max(8, Math.round((PROBE * iw) / ih));
  const h = iw >= ih ? Math.max(8, Math.round((PROBE * ih) / iw)) : PROBE;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, w, h);
  try {
    return focusOf(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    return null;
  }
}

/**
 * The sharpest, most colorful region of an RGBA image. Photographers put the subject in
 * focus and let the background go soft, so local detail is a good stand-in for "subject";
 * saturation and skin tones nudge it toward people and colorful things, and a mild
 * center bias keeps stray detail at the borders from winning.
 */
export function focusOf(rgba: ArrayLike<number>, w: number, h: number): Focus | null {
  if (w < 3 || h < 3) return null;
  const n = w * h;
  const luma = new Float32Array(n);
  const boost = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    luma[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
    const skin = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 && luma[i] > 0.2 && luma[i] < 0.95;
    boost[i] = (0.6 + chroma) * (skin ? 1.5 : 1);
  }
  const interest = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const detail = Math.abs(luma[i + 1] - luma[i - 1]) + Math.abs(luma[i + w] - luma[i - w]);
      interest[i] = detail * boost[i];
    }
  }
  // Two box blurs ≈ a Gaussian: turns scattered edges into regions.
  const radius = Math.max(2, Math.round(Math.min(w, h) / 8));
  for (let pass = 0; pass < 2; pass++) {
    boxBlur(interest, w, h, radius, true);
    boxBlur(interest, w, h, radius, false);
  }
  let best = 0, bestAt = 0, sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x / (w - 1)) * 2 - 1;
      const dy = (y / (h - 1)) * 2 - 1;
      const i = y * w + x;
      const v = interest[i] * (1 - 0.3 * (dx * dx + dy * dy));
      interest[i] = v;
      sum += v;
      if (v > best) {
        best = v;
        bestAt = i;
      }
    }
  }
  const mean = sum / n;
  if (best <= 1e-6 || mean <= 1e-9) return null;
  // Centroid of the strong part of the peak, so the point sits in the middle of the subject.
  const px = bestAt % w, py = Math.floor(bestAt / w);
  let cx = 0, cy = 0, total = 0;
  for (let y = Math.max(0, py - radius); y <= Math.min(h - 1, py + radius); y++) {
    for (let x = Math.max(0, px - radius); x <= Math.min(w - 1, px + radius); x++) {
      const v = interest[y * w + x] - best * 0.6;
      if (v <= 0) continue;
      cx += (x + 0.5) * v;
      cy += (y + 0.5) * v;
      total += v;
    }
  }
  const weight = Math.min(1, Math.max(0, (best / mean - 1.3) / 1.7));
  return { x: cx / total / w, y: cy / total / h, weight };
}

function boxBlur(data: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? 1 : w;
  const line = new Float32Array(len);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    for (let k = 0; k < len; k++) line[k] = data[base + k * stride];
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += line[Math.min(len - 1, Math.max(0, k))];
    for (let k = 0; k < len; k++) {
      data[base + k * stride] = acc / (2 * r + 1);
      acc += line[Math.min(len - 1, k + r + 1)] - line[Math.max(0, k - r)];
    }
  }
}
