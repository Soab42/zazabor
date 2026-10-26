/**
 * The Healing Brush: the stroke copies texture from the source, then its colour and light are
 * blended into the surroundings by solving Laplace's equation for the difference between what
 * was there and the copy (a Poisson blend). The solve runs coarse to fine: each level starts from
 * the smaller one's answer, so a few sweeps per level are enough.
 */

/**
 * `dest` and `src` are RGBA pieces of the same size (`w`×`h`, straight alpha); `cover` (0–255)
 * is the stroke. Returns `dest` with the healed stroke laid over it.
 */
export function heal(dest: Uint8Array, src: Uint8Array, cover: Uint8Array, w: number, h: number, opacity: number): Uint8Array {
  const n = w * h;
  // The unknown area: inside the stroke and away from the piece's border (which stays the edge).
  const inside = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (cover[y * w + x] > 0) inside[y * w + x] = 1;
  const out = dest.slice();
  for (let c = 0; c < 4; c++) {
    // The difference that has to be carried in from the edge.
    const diff = new Float32Array(n);
    for (let i = 0; i < n; i++) diff[i] = dest[i * 4 + c] - src[i * 4 + c];
    const f = solve(diff, inside, w, h);
    for (let i = 0; i < n; i++) {
      if (!cover[i]) continue;
      const healed = Math.min(255, Math.max(0, src[i * 4 + c] + f[i]));
      const a = (cover[i] / 255) * opacity;
      out[i * 4 + c] = Math.round(dest[i * 4 + c] + (healed - dest[i * 4 + c]) * a);
    }
  }
  return out;
}

/** f with f = `fixed` outside `inside` and a smooth (harmonic) fill inside it. */
function solve(fixed: Float32Array, inside: Uint8Array, w: number, h: number): Float32Array {
  const f = fixed.slice();
  let any = false;
  for (let i = 0; i < inside.length; i++) if (inside[i]) any = true;
  if (!any) return f;
  if (w > 24 && h > 24) {
    // The half-size problem first, as the starting guess.
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2);
    const sf = new Float32Array(hw * hh), sin = new Uint8Array(hw * hh), count = new Float32Array(hw * hh);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y >> 1) * hw + (x >> 1), i = y * w + x;
        if (inside[i]) sin[j] = 1;
        else {
          sf[j] += fixed[i];
          count[j]++;
        }
      }
    }
    for (let j = 0; j < sf.length; j++) {
      if (count[j]) {
        sf[j] /= count[j];
        // A coarse cell with any known pixel keeps it as a boundary value.
        sin[j] = 0;
      }
    }
    const coarse = solve(sf, sin, hw, hh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside[y * w + x]) f[y * w + x] = coarse[(y >> 1) * hw + (x >> 1)];
  } else {
    // Start from the average of the edge.
    let sum = 0, k = 0;
    for (let i = 0; i < inside.length; i++) if (!inside[i]) (sum += fixed[i]), k++;
    const mean = k ? sum / k : 0;
    for (let i = 0; i < inside.length; i++) if (inside[i]) f[i] = mean;
  }
  // Successive over-relaxation sweeps.
  const sweeps = w * h > 40000 ? 40 : 120;
  const omega = 1.85;
  for (let s = 0; s < sweeps; s++) {
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        if (!inside[i]) continue;
        const avg = (f[i - 1] + f[i + 1] + f[i - w] + f[i + w]) / 4;
        f[i] += omega * (avg - f[i]);
      }
    }
  }
  return f;
}
