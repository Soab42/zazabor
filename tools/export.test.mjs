// Export speed: the frame pipe (every frame sent once, in order, no buffer filled while its send
// is out, never more on their way than asked) and motion blur sized to the motion.
// Run: node --test tools/export.test.mjs   (Node 23.6+ reads the TypeScript directly)
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.(ts|js|mjs|json|css)$/.test(spec)) {
    for (const ext of [".ts", "/index.ts"]) {
      try { return await next(spec + ext, ctx); } catch {}
    }
  }
  return next(spec, ctx);
}`));

const root = "../src/modules/studio/video";
const { FramePipe } = await import(`${root}/pipe.ts`);
const { travelPixels, blurMoments, blurOffsets, frameJitter, stillBelow, BLUR_MAX } = await import(`${root}/motion/blur.ts`);
const { moving } = await import(`${root}/motion/player.ts`).catch(() => ({ moving: null }));
const { TEMPLATES } = await import(`${root}/motion/templates/index.ts`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A small deterministic random (so a failure can be run again).
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

// ---- the frame pipe

/** Runs `frames` frames through a pipe whose reads and sends answer after random delays. */
async function run(frames, depth, seed, fail = -1) {
  const rand = rng(seed);
  const got = [];
  const busy = new Set();
  let sending = 0, most = 0, reading = 0, mostReads = 0;
  const pipe = new FramePipe({
    async collect(read, out) {
      assert.ok(!busy.has(out), "a buffer was filled while its send was still out");
      await sleep(rand() * 3);
      out[0] = read & 255;
      out[1] = read >> 8;
      reading--;
    },
    async send(seq, frame) {
      busy.add(frame);
      sending++;
      most = Math.max(most, sending);
      const content = frame[0] | (frame[1] << 8);
      await sleep(rand() * 6);
      // The bytes stayed put while the send was out.
      assert.equal(frame[0] | (frame[1] << 8), content);
      got.push([seq, content]);
      sending--;
      busy.delete(frame);
      if (seq === fail) throw new Error("encoder stopped");
      return seq + 1;
    },
  }, 4, depth);
  for (let n = 0; n < frames; n++) {
    reading++;
    mostReads = Math.max(mostReads, reading);
    await pipe.push(n);
  }
  await pipe.flush();
  return { got, most, mostReads, sent: pipe.sent };
}

test("every frame reaches the encoder once, numbered in order, with its own picture", async () => {
  for (const [seed, depth] of [[1, { reads: 2, sends: 2 }], [7, { reads: 1, sends: 3 }], [42, { reads: 3, sends: 1 }]]) {
    const { got, most, mostReads, sent } = await run(120, depth, seed);
    assert.equal(sent, 120);
    const bySeq = new Map(got);
    assert.equal(bySeq.size, 120, "a frame was dropped or sent twice");
    for (let n = 0; n < 120; n++) assert.equal(bySeq.get(n), n, `frame ${n} carried another frame's picture`);
    assert.ok(most <= depth.sends, `${most} sends out at once, more than ${depth.sends}`);
    assert.ok(mostReads <= depth.reads + 1, `${mostReads} reads waiting, more than ${depth.reads + 1}`);
  }
});

test("sends do overlap (the point of the pipe)", async () => {
  const { most } = await run(60, { reads: 2, sends: 3 }, 3);
  assert.ok(most >= 2);
});

test("a failed send stops the export with its error", async () => {
  await assert.rejects(run(80, { reads: 2, sends: 2 }, 5, 30), /encoder stopped/);
});

test("a short export (fewer frames than the pipe holds) still sends every frame", async () => {
  for (const frames of [1, 2, 3]) {
    const { got } = await run(frames, { reads: 2, sends: 2 }, 9);
    assert.deepEqual(got.map(([s]) => s).sort((a, b) => a - b), [...Array(frames).keys()]);
  }
});

test("a stopped export lets go of the reads it never collected", async () => {
  const pipe = new FramePipe({ collect: async () => {}, send: async () => {} }, 4, { reads: 2, sends: 2 });
  await pipe.push("a");
  await pipe.push("b");
  const dropped = [];
  pipe.discard((r) => dropped.push(r));
  assert.deepEqual(dropped, ["a", "b"]);
  assert.equal(pipe.sent, 0);
  await pipe.flush();
  assert.equal(pipe.sent, 0, "nothing left to send");
});

// ---- motion blur sized to the motion

const one = (layer) => ({ id: "t", name: "t", length: 4, hold: [1, 3], fields: [], layers: [layer], shapes: ["16:9"] });
const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };

test("nothing moving travels no pixels and gets one moment (one render)", () => {
  const still = one({ id: "a", kind: "rect", frame: box, dx: 0.1, opacity: [[0, 0], [1, 1]] });
  assert.equal(travelPixels(still, 0.4, 0.42, 1920, 1080), 0);
  assert.equal(blurMoments(0), 1);
  assert.equal(blurMoments(0.6), 1);
});

test("slow moves get few moments, fast ones up to the most, never more", () => {
  // 0.1 short sides in 2 s: 108 px over 2 s, ~0.9 px across a half-frame shutter at 30 fps.
  const slow = one({ id: "a", kind: "rect", frame: box, dx: [[0, 0, "linear"], [2, 0.1]] });
  const shutter = 0.5 / 30;
  const slowPx = travelPixels(slow, 1 - shutter / 2, 1 + shutter / 2, 1920, 1080);
  assert.ok(slowPx > 0.5 && slowPx < 1.2, `slow: ${slowPx}`);
  assert.equal(blurMoments(slowPx), 1);
  // A whole short side in 0.3 s: ~60 px across the shutter.
  const fast = one({ id: "a", kind: "rect", frame: box, dx: [[0, 0, "linear"], [0.3, 1]] });
  const fastPx = travelPixels(fast, 0.15 - shutter / 2, 0.15 + shutter / 2, 1920, 1080);
  assert.ok(fastPx > 40, `fast: ${fastPx}`);
  assert.equal(blurMoments(fastPx), BLUR_MAX);
  assert.ok(BLUR_MAX <= 4);
  for (let px = 0; px < 400; px += 0.5) {
    const n = blurMoments(px);
    assert.ok(n >= 1 && n <= BLUR_MAX);
    assert.ok(n >= blurMoments(px - 0.5), "more travel never gets fewer moments");
  }
});

test("turns, growth and the groups around a layer count as travel", () => {
  const w = 1920, h = 1080, t0 = 0.2, t1 = 0.22;
  assert.ok(travelPixels(one({ id: "a", kind: "rect", frame: box, rotate: [[0, 0, "linear"], [0.4, 90]] }), t0, t1, w, h) > 5);
  assert.ok(travelPixels(one({ id: "a", kind: "rect", frame: box, scale: [[0, 0.2, "linear"], [0.4, 1]] }), t0, t1, w, h) > 5);
  const child = { id: "c", kind: "rect", frame: box };
  assert.ok(travelPixels(one({ id: "g", kind: "group", frame: box, dy: [[0, 1, "linear"], [0.4, 0]], children: [child] }), t0, t1, w, h) > 20);
  // A layer that isn't shown then doesn't count.
  assert.equal(travelPixels(one({ id: "a", kind: "rect", frame: box, time: [2, 3], dx: [[0, 0], [0.4, 1]] }), t0, t1, w, h), 0);
});

test("letters flying in count while they fly, not after", () => {
  const text = { id: "a", kind: "text", frame: box, text: "x", size: 0.1, font: "heading", animate: { unit: "char", t: 0.5, stagger: 0.04, duration: 0.5, from: { dy: 1, opacity: 0 }, ease: "out" } };
  const s = 0.5 / 30;
  assert.ok(travelPixels(one(text), 0.6, 0.6 + s, 1920, 1080) > 1);
  assert.equal(travelPixels(one(text), 3.5, 3.5 + s, 1920, 1080), 0);
  // With the text known, its letters count only until the last has landed: "ab" lands by 0.5 +
  // 0.04 + 0.5 s; without it, up to 2 s more is assumed.
  const two = one({ ...text, text: "ab" });
  assert.ok(travelPixels(two, 0.9, 0.9 + s, 1920, 1080, "smooth", {}) > 0);
  assert.equal(travelPixels(two, 1.2, 1.2 + s, 1920, 1080, "smooth", {}), 0);
  assert.ok(travelPixels(two, 1.2, 1.2 + s, 1920, 1080) > 0);
  // Exits count too.
  const exit = one({ ...text, text: "ab", animate: undefined, exit: { unit: "char", t: 3, stagger: 0.04, duration: 0.4, from: { dy: 1 } } });
  assert.ok(travelPixels(exit, 3.2, 3.2 + s, 1920, 1080, "smooth", {}) > 1);
});

test("blur moments split the shutter evenly, jittered within their slices, the same every export", () => {
  assert.deepEqual(blurOffsets(1, 0.3), [0]);
  for (const n of [2, 3, 4]) {
    for (const j of [0, 0.25, 0.5, 0.999]) {
      const o = blurOffsets(n, j);
      assert.equal(o.length, n);
      o.forEach((x, i) => {
        assert.ok(x >= -0.5 && x < 0.5);
        assert.ok(x >= i / n - 0.5 && x < (i + 1) / n - 0.5, "each moment stays in its own slice");
      });
    }
  }
  const js = Array.from({ length: 300 }, (_, f) => frameJitter(f));
  assert.ok(js.every((j) => j >= 0 && j < 1));
  assert.equal(frameJitter(17), frameJitter(17));
  // Spread out: every tenth of the slice gets used.
  assert.equal(new Set(js.map((j) => Math.floor(j * 10))).size, 10);
});

test("the shipped templates: blur only where they move, and never more than the most moments", () => {
  const shutter = 0.5 / 30;
  for (const t of TEMPLATES) {
    for (let tt = 0; tt < t.length; tt += 1 / 30) {
      const px = travelPixels(t, tt - shutter / 2, tt + shutter / 2, 1920, 1080, "smooth");
      assert.ok(Number.isFinite(px) && px >= 0, `${t.id} at ${tt}: ${px}`);
      if (moving && !moving(t, tt - shutter, tt + shutter)) continue;
      assert.ok(blurMoments(px) <= BLUR_MAX);
    }
  }
});

test("the still layers at the bottom are drawn once: backgrounds and shapes up to the first that moves", () => {
  const t = { id: "t", name: "t", length: 4, hold: [1, 3], fields: [], shapes: ["16:9"], layers: [
    { id: "bg", kind: "background", frame: box, preset: "mesh" },
    { id: "card", kind: "rect", frame: box, opacity: [[0, 0], [1, 1]] },
    { id: "fly", kind: "rect", frame: box, dx: [[0, 1], [0.5, 0]] },
    { id: "logo", kind: "image", frame: box },
  ] };
  assert.equal(stillBelow(t, 0.2, 0.22), 2, "a fade isn't motion; the layer flying in and all above it are drawn per moment");
  assert.equal(stillBelow(t, 2, 2.02), 4, "once it has landed, everything is still");
  // Texts, art and effects draw differently with time: never counted still.
  assert.equal(stillBelow({ ...t, layers: [{ id: "x", kind: "text", frame: box, text: "x", size: 0.1 }, ...t.layers] }, 2, 2.02), 0);
  assert.equal(stillBelow({ ...t, layers: [{ id: "g", kind: "group", frame: box, children: [t.layers[2]] }] }, 0.2, 0.22), 0, "a group is still only if all of it is");
  // A wipe moving across counts as motion.
  assert.equal(stillBelow({ ...t, layers: [{ id: "w", kind: "rect", frame: box, reveal: { from: "left", v: [[0, 0], [1, 1]] } }] }, 0.4, 0.42), 0);
});
