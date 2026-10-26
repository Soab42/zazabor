// Photo's Levels and Curves against a reference, within 1/255 (8-bit) as the plan asks. The
// compositing shader works these out per pixel the same way (layeradjust.ts mirrors tone.ts);
// Gradient Map's table is checked too.
// Run: node --test tools/photo-tone.test.mjs   (Node 23.6+ reads the TypeScript directly)
import assert from "node:assert/strict";
import test from "node:test";
import { buildGradientLut, curveFunction, curveSpline, levelsValue, LEVELS_IDENTITY, lutSample, splineValue } from "../src/modules/studio/photo/tone.ts";

const STEP = 1 / 255;

// Reference Levels, written out separately: Photoshop's input range, midtone gamma, output range.
function refLevels(l, v) {
  const lo = l.inBlack / 255, hi = l.inWhite / 255;
  let t = (v - lo) / (hi - lo);
  t = Math.min(1, Math.max(0, t));
  t = t ** (1 / l.gamma);
  return Math.min(1, Math.max(0, (l.outBlack + (l.outWhite - l.outBlack) * t) / 255));
}

// Reference natural cubic spline: second derivatives from the full linear system, solved by
// Gaussian elimination (not the tridiagonal shortcut the app uses).
function refCurve(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]).map(([x, y]) => [x / 255, y / 255]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  A[0][0] = 1;
  A[n - 1][n - 1] = 1;
  for (let i = 1; i < n - 1; i++) {
    const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
    A[i][i - 1] = h0 / 6;
    A[i][i] = (h0 + h1) / 3;
    A[i][i + 1] = h1 / 6;
    A[i][n] = (ys[i + 1] - ys[i]) / h1 - (ys[i] - ys[i - 1]) / h0;
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const m = A.map((row, i) => row[n] / row[i]);
  return (v) => {
    if (v <= xs[0]) return Math.min(1, Math.max(0, ys[0]));
    if (v >= xs[n - 1]) return Math.min(1, Math.max(0, ys[n - 1]));
    let i = 0;
    while (xs[i + 1] < v) i++;
    const h = xs[i + 1] - xs[i];
    const a = (xs[i + 1] - v) / h, b = (v - xs[i]) / h;
    const y = a * ys[i] + b * ys[i + 1] + ((a ** 3 - a) * m[i] + (b ** 3 - b) * m[i + 1]) * h * h / 6;
    return Math.min(1, Math.max(0, y));
  };
}

// Every 8-bit input and a fine sweep between them.
const inputs = [...Array.from({ length: 256 }, (_, i) => i / 255), ...Array.from({ length: 4097 }, (_, i) => i / 4096)];

function maxError(f, ref) {
  let worst = 0;
  for (const v of inputs) worst = Math.max(worst, Math.abs(f(v) - ref(v)));
  return worst;
}

// What the shader computes in 32-bit floats: the same steps, rounded to float32 at each one.
const f32 = Math.fround;
function shaderLevels(l, v) {
  const lo = f32(l.inBlack / 255), hi = f32(l.inWhite / 255);
  const t = hi > lo ? Math.min(1, Math.max(0, f32(f32(v - lo) / f32(hi - lo)))) : v >= lo ? 1 : 0;
  const g = f32(t ** f32(1 / l.gamma));
  const ob = f32(l.outBlack / 255), ow = f32(l.outWhite / 255);
  return Math.min(1, Math.max(0, f32(ob + f32(f32(ow - ob) * g))));
}

// A small deterministic random source.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test("Levels: known values", () => {
  assert.equal(levelsValue(LEVELS_IDENTITY, 0.3), 0.3);
  assert.ok(Math.abs(levelsValue({ ...LEVELS_IDENTITY, inBlack: 50, inWhite: 200 }, 125 / 255) - 0.5) < 1e-12);
  assert.ok(Math.abs(levelsValue({ ...LEVELS_IDENTITY, gamma: 2 }, 0.5) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(levelsValue({ ...LEVELS_IDENTITY, outBlack: 20, outWhite: 220 }, 1) - 220 / 255) < 1e-12);
});

test("Levels: the app's maths, and the shader's in 32-bit floats, match the reference", () => {
  for (let k = 0; k < 300; k++) {
    const inBlack = Math.floor(rand() * 200);
    const inWhite = Math.min(255, inBlack + 2 + Math.floor(rand() * 250));
    const l = { inBlack, inWhite, gamma: 0.1 + rand() * 9.8, outBlack: Math.floor(rand() * 256), outWhite: Math.floor(rand() * 256) };
    const master = { ...LEVELS_IDENTITY, gamma: 0.3 + rand() * 3 };
    const ref = (v) => refLevels(master, refLevels(l, v));
    assert.ok(maxError((v) => levelsValue(master, levelsValue(l, v)), ref) < 1e-9, `levels ${JSON.stringify(l)}`);
    const err = maxError((v) => shaderLevels(master, shaderLevels(l, v)), ref);
    assert.ok(err < STEP, `levels ${JSON.stringify(l)} in float32 off by ${(err * 255).toFixed(4)}/255`);
  }
});

test("Curves: the spline the shader gets matches the reference", () => {
  assert.equal(curveFunction([[0, 0], [255, 255]])(0.37), 0.37);
  for (let k = 0; k < 300; k++) {
    const count = 2 + Math.floor(rand() * 7);
    const xs = new Set([Math.floor(rand() * 40), 215 + Math.floor(rand() * 41)]);
    while (xs.size < count) xs.add(41 + Math.floor(rand() * 173));
    const points = [...xs].sort((a, b) => a - b).map((x) => [x, Math.floor(rand() * 256)]);
    const ref = refCurve(points);
    const spline = curveSpline(points);
    // The shader takes the knots and second derivatives as 32-bit floats.
    const rounded = { xs: spline.xs.map(f32), ys: spline.ys.map(f32), ms: spline.ms.map(f32) };
    assert.ok(maxError((v) => splineValue(spline, v), ref) < 1e-9, `curve ${JSON.stringify(points)}`);
    const err = maxError((v) => splineValue(rounded, v), ref);
    assert.ok(err < STEP, `curve ${JSON.stringify(points)} in float32 off by ${(err * 255).toFixed(4)}/255`);
  }
});

test("Gradient Map: the table blends the two colours", () => {
  const lut = buildGradientLut([[0, 0, 0], [1, 0.5, 0.25]]);
  for (const v of inputs) {
    assert.ok(Math.abs(lutSample(lut, 0, v) - v) < 1e-6);
    assert.ok(Math.abs(lutSample(lut, 1, v) - v * 0.5) < 1e-6);
    assert.ok(Math.abs(lutSample(lut, 2, v) - v * 0.25) < 1e-6);
  }
});
