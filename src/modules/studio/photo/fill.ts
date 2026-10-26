import type { Rect } from "./engine";

/**
 * The paint bucket's area: pixels like the one at (x, y), within `tolerance` (0–255) on every
 * channel, either touching it (`contiguous`) or anywhere. Null when (x, y) is outside.
 */
export function floodMask(rgba: Uint8Array, width: number, height: number, x: number, y: number, tolerance: number, contiguous: boolean): { mask: Uint8Array; rect: Rect } | null {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const at = (y * width + x) * 4;
  const r = rgba[at], g = rgba[at + 1], b = rgba[at + 2], a = rgba[at + 3];
  const like = (i: number) => {
    const p = i * 4;
    return Math.abs(rgba[p] - r) <= tolerance && Math.abs(rgba[p + 1] - g) <= tolerance && Math.abs(rgba[p + 2] - b) <= tolerance && Math.abs(rgba[p + 3] - a) <= tolerance;
  };
  const mask = new Uint8Array(width * height);
  let x0 = x, x1 = x, y0 = y, y1 = y;
  const mark = (i: number) => {
    mask[i] = 1;
    const px = i % width, py = (i - px) / width;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  };
  if (!contiguous) {
    for (let i = 0; i < width * height; i++) if (like(i)) mark(i);
  } else {
    // Scanline fill: fill a run left and right, then look for runs above and below it.
    const stack = [x, y];
    while (stack.length) {
      const sy = stack.pop()!, sx = stack.pop()!;
      let left = sx;
      const row = sy * width;
      if (mask[row + left] || !like(row + left)) continue;
      while (left > 0 && !mask[row + left - 1] && like(row + left - 1)) left--;
      let right = sx;
      while (right < width - 1 && !mask[row + right + 1] && like(row + right + 1)) right++;
      for (let i = left; i <= right; i++) mark(row + i);
      for (const ny of [sy - 1, sy + 1]) {
        if (ny < 0 || ny >= height) continue;
        const nrow = ny * width;
        let inRun = false;
        for (let i = left; i <= right; i++) {
          const ok = !mask[nrow + i] && like(nrow + i);
          if (ok && !inRun) stack.push(i, ny);
          inRun = ok;
        }
      }
    }
  }
  return { mask, rect: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

/**
 * Paints `color` (0–255 RGB) at `opacity` (0–1) over the masked pixels of `pixels`, a `rect`-sized
 * piece of a layer whose mask is `width` wide and offset by (mx, my) from the piece.
 */
export function paintMask(pixels: Uint8Array, rect: Rect, mask: Uint8Array, maskWidth: number, mx: number, my: number, color: [number, number, number], opacity: number) {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (!mask[(y + my) * maskWidth + x + mx]) continue;
      const p = (y * rect.w + x) * 4;
      const da = pixels[p + 3] / 255;
      const ao = opacity + da * (1 - opacity);
      for (let c = 0; c < 3; c++) pixels[p + c] = Math.round((color[c] * opacity + pixels[p + c] * da * (1 - opacity)) / ao);
      pixels[p + 3] = Math.round(ao * 255);
    }
  }
}
