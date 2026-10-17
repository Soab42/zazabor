export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
}

/** Computes RGB and luma histograms from a downscaled copy of the image. */
export function computeHistogram(source: CanvasImageSource, width: number, height: number): Histogram | null {
  const scale = Math.min(1, 320 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const hist: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), luma: new Uint32Array(256) };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    hist.r[r]++;
    hist.g[g]++;
    hist.b[b]++;
    hist.luma[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
  }
  return hist;
}

export function drawHistogram(canvas: HTMLCanvasElement, hist: Histogram | null) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 280;
  const cssH = canvas.clientHeight || 96;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!hist) return;

  // Scale to the tallest interior bin so clipped shadows/highlights don't flatten the rest.
  let peak = 1;
  for (const channel of [hist.r, hist.g, hist.b]) {
    for (let i = 2; i < 254; i++) peak = Math.max(peak, channel[i]);
  }
  const path = (channel: Uint32Array) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W;
      const y = H - Math.min(1, channel[i] / peak) * (H - 2);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
  };

  ctx.globalCompositeOperation = "lighter";
  for (const [channel, color] of [[hist.r, "rgba(235, 70, 60, 0.55)"], [hist.g, "rgba(80, 200, 90, 0.5)"], [hist.b, "rgba(70, 120, 245, 0.6)"]] as const) {
    path(channel);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
  path(hist.luma);
  ctx.strokeStyle = "rgba(240, 236, 228, 0.75)";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.stroke();
}
