// Video Editor timeline edits: Select All on a layer, moving and copying several clips, and
// transitions on overlay layers (when each clip is part way in or out, and how it looks then).
// Run: node --test tools/video-editor.test.mjs   (Node 23.6+ reads the TypeScript directly)
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

// The app's modules import each other without ".ts"; Node needs it spelled out.
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
const model = await import(`${root}/model.ts`);
const { layerLook, applyLayerLook, LAYER_TRANSITION_GROUPS, isLayerKind } = await import(`${root}/overlays.ts`);

const media = (id, kind = "video", duration = 5) => ({ id, path: `/tmp/${id}.${kind === "image" ? "png" : "mp4"}`, name: id, kind, duration, width: 1920, height: 1080, fps: 30, audio: kind !== "image" });
const text = (id, start, duration, extra = {}) => ({
  id, type: "text", start, duration, text: id,
  style: { font: "sans-serif", size: 56, color: "#ffffff", stroke: null, strokeWidth: 0, box: null, shadow: false, bold: false, italic: false, align: "center" },
  place: model.defaultPlace(), animIn: "none", animOut: "none", ...extra,
});

/** A project: three main clips, two overlays on one track, one on another, a text track. */
function project() {
  const p = model.newProject("9:16");
  p.media.push(media("a"), media("b"), media("pic", "image", 0));
  for (const [id, m] of [["m1", "a"], ["m2", "b"], ["m3", "a"]]) {
    const c = model.mediaClip(model.mediaOf(p, m), 0);
    c.id = id;
    c.duration = 2;
    model.insertMain(p, c);
  }
  const o = (id, start, track) => {
    const c = model.mediaClip(model.mediaOf(p, "pic"), start);
    c.id = id;
    c.duration = 2;
    return model.placeFree(p, c, "overlay", track);
  };
  const t1 = o("o1", 0);
  o("o2", 3, t1.id);
  // At 0.5 o1 is in the way on the first overlay track: a second one.
  o("o3", 0.5);
  model.placeFree(p, text("t1", 1, 2), "text");
  return p;
}

const ids = (p, kind) => p.tracks.filter((t) => t.kind === kind).map((t) => t.clips.map((c) => c.id));

// ---- Select All

test("Ctrl+A: the main track with nothing selected, the selection's layer, then every layer", () => {
  const p = project();
  assert.deepEqual(model.selectAllIds(p, []), ["m1", "m2", "m3"]);
  // Again (the main track is wholly selected): every clip.
  const all = model.selectAllIds(p, ["m1", "m2", "m3"]);
  assert.equal(all.length, 7);
  // One overlay selected: its own track only.
  assert.deepEqual(model.selectAllIds(p, ["o2"]), ["o1", "o2"]);
  assert.equal(model.selectAllIds(p, ["o1", "o2"]).length, 7);
  // A selection across tracks: everything.
  assert.equal(model.selectAllIds(p, ["o1", "t1"]).length, 7);
  // Nothing on the main track: everything.
  const q = model.newProject("16:9");
  model.placeFree(q, text("x", 0, 1), "text");
  assert.deepEqual(model.selectAllIds(q, []), ["x"]);
});

// ---- moving and copying together

test("selected clips off the main track move together, each on its own track", () => {
  const p = project();
  model.moveGroup(p, ["o1", "o3", "t1", "m2"], 1.5, { id: "o1" });
  const at = (id) => model.findClip(p, id);
  assert.equal(at("o1").clip.start, 1.5);
  assert.equal(at("o3").clip.start, 2);
  assert.equal(at("t1").clip.start, 2.5);
  // The main track is magnetic: its clip stays.
  assert.equal(at("m2").clip.start, 2);
  // o1 now runs into o2 (3…5) on its track: it goes to a free overlay track instead of overlapping.
  for (const t of p.tracks) {
    const clips = [...t.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) assert.ok(clips[i].start >= model.clipEnd(clips[i - 1]) - 1e-9, `overlap on ${t.kind}`);
  }
  // Moving left stops at 0 for the earliest one, keeping the gaps.
  const q = project();
  model.moveGroup(q, ["o1", "o3"], -5, { id: "o3" });
  assert.equal(model.findClip(q, "o1").clip.start, 0);
  assert.equal(model.findClip(q, "o3").clip.start, 0.5);
});

test("the dragged clip can change track while the others keep theirs", () => {
  const p = project();
  const second = p.tracks.filter((t) => t.kind === "overlay")[1];
  model.moveGroup(p, ["o2"], 0.5, { id: "o2", track: second.id });
  assert.equal(model.findClip(p, "o2").track.id, second.id);
  assert.equal(model.findClip(p, "o2").clip.start, 3.5);
});

test("selected main-track clips move as a block, in their order", () => {
  const p = project();
  model.moveMainBlock(p, ["m1", "m2"], model.mainIndexAmong(p, 5.9, ["m1", "m2"]));
  assert.deepEqual(ids(p, "main")[0], ["m3", "m1", "m2"]);
  assert.deepEqual(model.mainTrack(p).clips.map((c) => c.start), [0, 2, 4]);
});

test("copy and paste: offsets kept, main clips go in at the cut, media come along", () => {
  const p = project();
  model.findClip(p, "o2").clip.transition = { kind: "dissolve", duration: 0.5 };
  const copy = model.copyClips(p, ["o2", "t1", "m3"]);
  assert.equal(copy.clips.length, 3);
  assert.deepEqual(copy.media.map((m) => m.id).sort(), ["a", "pic"]);
  const pasted = model.pasteClips(p, copy, 10);
  assert.equal(pasted.length, 3);
  const clips = pasted.map((id) => model.findClip(p, id));
  const byKind = Object.fromEntries(clips.map((f) => [f.track.kind, f.clip]));
  // The earliest copied off the main track (t1 at 1) goes to 10; o2 (at 3) keeps its 2 s after it.
  assert.equal(byKind.text.start, 10);
  assert.equal(byKind.overlay.start, 12);
  assert.equal(byKind.overlay.transition, undefined);
  // The main clip goes in at the end (10 is past the main track's 6 s).
  assert.equal(model.mainTrack(p).clips.at(-1).id, byKind.main.id);
  assert.equal(p.media.length, 3);
  // Into another project: the media it uses are added.
  const q = model.newProject("9:16");
  const into = model.pasteClips(q, copy, 0);
  assert.equal(into.length, 3);
  assert.deepEqual(q.media.map((m) => m.id).sort(), ["a", "pic"]);
  for (const t of q.tracks) for (const c of t.clips) if (c.type === "media") assert.ok(q.media.some((m) => m.id === c.media));
});

// ---- transitions off the main track

test("a layer's own in and out: when it plays, kept inside the clip", () => {
  const p = project();
  const track = model.findClip(p, "o1").track;
  const o1 = model.findClip(p, "o1").clip;
  o1.transIn = { kind: "slide", duration: 0.5 };
  o1.transOut = { kind: "zoom", duration: 3 };
  assert.deepEqual(model.layerSpans(o1), { in: 0.5, out: 1 });
  const at = (t) => model.layerClipsAt(track, t).find((x) => x.clip.id === "o1");
  assert.deepEqual(at(0.25).phase, { kind: "slide", side: "in", p: 0.5 });
  assert.equal(at(0.75).phase, null);
  assert.deepEqual(at(1.5).phase, { kind: "zoom", side: "out", p: 0.5 });
  assert.equal(at(2), undefined);
});

test("a transition between touching clips on a layer plays across the cut", () => {
  const p = project();
  const track = model.findClip(p, "o1").track;
  const o2 = model.findClip(p, "o2").clip;
  o2.transition = { kind: "push", duration: 1 };
  // Not touching (o1 ends at 2, o2 starts at 3): nothing.
  assert.equal(model.cutTransition(track, 1), null);
  assert.equal(model.layerClipsAt(track, 2.9).length, 0);
  // Touching: o1 plays on past its end going off while o2 comes in, half before and half after the cut.
  o2.start = 2;
  model.findClip(p, "o1").clip.transOut = { kind: "dissolve", duration: 0.4 };
  o2.transIn = { kind: "dissolve", duration: 0.4 };
  assert.ok(model.touchesPrevious(track, 1));
  const before = model.layerClipsAt(track, 1.75);
  assert.deepEqual(before.map((x) => [x.clip.id, x.phase.side, x.phase.kind, x.phase.p]), [["o1", "out", "push", 0.75], ["o2", "in", "push", 0.25]]);
  const after = model.layerClipsAt(track, 2.25);
  assert.deepEqual(after.map((x) => [x.clip.id, x.phase.p]), [["o1", 0.25], ["o2", 0.75]]);
  assert.deepEqual(model.layerClipsAt(track, 2.6).map((x) => [x.clip.id, x.phase]), [["o2", null]]);
  // Both move on one even curve: a push keeps them side by side.
  const W = 1080;
  const [a, b] = before.map((x) => layerLook(x.phase, W, 1920));
  assert.ok(Math.abs(b.dx - a.dx - W) < 1e-6, `${a.dx} ${b.dx}`);
  // The length is kept to what both clips allow (0.9 of the shorter one).
  o2.transition.duration = 5;
  assert.equal(model.cutTransition(track, 1).duration, 1.8);
  // Moved apart again: back to their own out and in.
  o2.start = 2.5;
  assert.equal(model.layerClipsAt(track, 1.9).find((x) => x.clip.id === "o1").phase.kind, "dissolve");
});

test("the scene carries the phases; hidden and audio tracks still don't draw", () => {
  const p = project();
  model.findClip(p, "t1").clip.transIn = { kind: "iris", duration: 1 };
  const s = model.sceneAt(p, 1.5);
  assert.ok(s.layers.some((c) => c.id === "t1"));
  assert.deepEqual(s.phases.t1, { kind: "iris", side: "in", p: 0.5 });
  model.findClip(p, "t1").track.hidden = true;
  assert.ok(!model.sceneAt(p, 1.5).layers.some((c) => c.id === "t1"));
});

test("split: the left piece keeps the in, the right one the out", () => {
  const p = project();
  const o1 = model.findClip(p, "o1").clip;
  o1.transIn = { kind: "slide", duration: 0.5 };
  o1.transOut = { kind: "zoom", duration: 0.5 };
  o1.transition = { kind: "push", duration: 0.5 };
  const right = model.split(p, "o1", 1);
  assert.ok(o1.transIn && !o1.transOut && o1.transition);
  assert.ok(right.transOut && !right.transIn && !right.transition);
});

test("every layer kind is whole at the end of its way in and gone at its start", () => {
  const kinds = LAYER_TRANSITION_GROUPS.flatMap((g) => g.items.map(([k]) => k));
  assert.ok(kinds.length >= 15 && kinds.every(isLayerKind));
  assert.ok(!isLayerKind("cube"));
  const W = 1080, H = 1920;
  for (const kind of [...kinds, "cube"]) {
    for (const side of ["in", "out"]) {
      const whole = layerLook({ kind, side, p: 1 }, W, H);
      assert.equal(whole.opacity, 1, `${kind} ${side} opacity`);
      assert.ok(Math.abs(whole.dx) < 1e-9 && Math.abs(whole.dy) < 1e-9, `${kind} ${side} place`);
      assert.ok(Math.abs(whole.scale - 1) < 1e-9 && Math.abs(whole.sx - 1) < 1e-9 && Math.abs(whole.rotate) < 1e-9, `${kind} ${side} shape`);
      assert.ok(Math.abs(whole.blur) < 1e-9 && Math.abs(whole.bright) < 1e-9, `${kind} ${side} look`);
      if (whole.wipe) assert.deepEqual([whole.wipe.to - whole.wipe.from], [1]);
      if (whole.iris !== null) assert.equal(whole.iris, 1);
      const gone = layerLook({ kind, side, p: 0 }, W, H);
      const hidden = gone.opacity < 0.2 || Math.abs(gone.dx) >= W * 0.9 || Math.abs(gone.dy) >= H * 0.5 || gone.scale < 0.01 || gone.sx < 0.01
        || (gone.wipe && gone.wipe.to - gone.wipe.from <= 0) || gone.iris === 0;
      assert.ok(hidden, `${kind} ${side} at 0 still shows`);
    }
  }
  // Sideways moves carry on: in from the right, out to the left.
  assert.ok(layerLook({ kind: "slide", side: "in", p: 0.5 }, W, H).dx > 0);
  assert.ok(layerLook({ kind: "slide", side: "out", p: 0.5 }, W, H).dx < 0);
});

test("a look is applied about the picture's centre; wipes become masks, or a fade on a masked clip", () => {
  const draw = (extra = {}) => ({ source: {}, center: [500, 800], size: [400, 300], rotation: 0, opacity: 0.8, grade: null, adjust: [0, 0, 0], blur: 0, dim: 0, ...extra });
  const shadow = draw({ center: [500, 820], size: [440, 340], shadow: { box: [200, 150], radius: 20, softness: 10 } });
  const same = applyLayerLook([shadow, draw()], layerLook({ kind: "dissolve", side: "in", p: 1 }, 1080, 1920));
  assert.deepEqual(same[1].center, [500, 800]);
  assert.deepEqual(same[0].center, [500, 820]);
  const half = applyLayerLook([shadow, draw()], { opacity: 0.5, dx: 10, dy: 0, scale: 0.5, sx: 1, rotate: 0, blur: 2, bright: 0.5, wipe: null, iris: null });
  assert.deepEqual(half[1].center, [510, 800]);
  assert.deepEqual(half[1].size, [200, 150]);
  assert.equal(half[1].opacity, 0.4);
  assert.equal(half[1].blur, 2);
  assert.deepEqual(half[1].adjust, [0.5, 0, 0]);
  // The shadow scales about the picture's centre and isn't blurred or lit.
  assert.deepEqual(half[0].center, [510, 810]);
  assert.deepEqual(half[0].shadow.box, [100, 75]);
  assert.equal(half[0].blur, 0);
  const wiped = applyLayerLook([draw()], layerLook({ kind: "wipe", side: "in", p: 0.5 }, 1080, 1920));
  assert.equal(wiped[0].fx.mask.shape, 2);
  assert.ok(wiped[0].fx.mask.rect[0] > 0 && wiped[0].fx.mask.rect[0] < 0.5);
  const masked = draw({ fx: { mask: { shape: 1, rect: [0.5, 0.5, 1, 1], feather: 0.1, invert: false }, radius: 0, border: 0 } });
  const faded = applyLayerLook([masked], layerLook({ kind: "wipe", side: "in", p: 0.5 }, 1080, 1920));
  assert.equal(faded[0].fx.mask.shape, 1, "the clip's own mask stays");
  assert.ok(faded[0].opacity < 0.8);
});

// ---- project files

test("transitions on layers survive saving; older projects open unchanged", () => {
  const p = project();
  model.findClip(p, "o1").clip.transIn = { kind: "slide", duration: 0.5 };
  model.findClip(p, "t1").clip.transOut = { kind: "flip", duration: 0.7 };
  model.findClip(p, "t1").clip.transIn = { kind: "dissolve", duration: -1 };
  p.tracks.find((t) => t.kind === "overlay").clips.push({
    id: "tpl", type: "template", template: "launch-hero", name: "Launch", start: 6, duration: 3, values: {}, slots: {}, theme: {}, kit: null, overrides: [],
    place: model.defaultPlace(), transOut: { kind: "zoom", duration: 0.6 }, transition: { kind: "push", duration: "x" },
  });
  const back = model.normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(model.findClip(back, "o1").clip.transIn, { kind: "slide", duration: 0.5 });
  assert.deepEqual(model.findClip(back, "t1").clip.transOut, { kind: "flip", duration: 0.7 });
  assert.equal(model.findClip(back, "t1").clip.transIn, undefined, "a broken one is dropped");
  const tpl = model.findClip(back, "tpl");
  assert.ok(tpl, "the template clip is read");
  assert.deepEqual(tpl.clip.transOut, { kind: "zoom", duration: 0.6 });
  assert.equal(tpl.clip.transition, undefined);
  // A project from before: no new fields appear.
  const old = project();
  const text1 = JSON.stringify(model.normalizeProject(JSON.parse(JSON.stringify(old))));
  assert.ok(!/transIn|transOut/.test(text1));
  assert.deepEqual(model.normalizeProject(JSON.parse(text1)), JSON.parse(text1));
});

// ---- The inspector's number fields (scrub.ts): showing, typing, stepping and dragging values.

const scrub = await import(`${root}/scrub.ts`);

test("number fields show values in their units", () => {
  const pos = { min: -0.5, max: 1.5, step: 0.01, scale: 100, offset: 0.5, decimals: 0, unit: "%" };
  assert.equal(scrub.display(pos, 0.5), "0 %", "the middle is 0");
  assert.equal(scrub.display(pos, 0.42), "−8 %", "a real minus sign");
  assert.equal(scrub.display(pos, 0.498), "0 %", "no −0");
  assert.equal(scrub.display({ min: 0.25, max: 4, step: 0.05, decimals: 2, unit: "×" }, 1.5), "1.50×");
  assert.equal(scrub.display({ min: -180, max: 180, step: 1, unit: "°" }, -45), "−45°");
  assert.equal(scrub.display({ min: -1, max: 1, step: 0.01, scale: 100, decimals: 0, signed: true }, 0.12), "+12");
  assert.equal(scrub.display({ min: 0, max: 5, step: 0.1, unit: "s" }, 0.6), "0.6 s", "decimals follow the step");
  assert.equal(scrub.display({ min: 0, max: 1, step: 0.05, format: (v) => (v ? `−${Math.round(v * 100)} %` : "Off") }, 0), "Off");
});

test("typed values are read in display units and kept in range", () => {
  const pct = { min: 0, max: 1, step: 0.01, scale: 100, decimals: 0, unit: "%" };
  assert.equal(scrub.parse(pct, "45"), 0.45);
  assert.equal(scrub.parse(pct, "45 %"), 0.45, "the unit is allowed");
  assert.equal(scrub.parse(pct, "250"), 1, "kept in range");
  assert.equal(scrub.parse(pct, "-3"), 0);
  assert.equal(scrub.parse(pct, "abc"), null, "not a number");
  assert.equal(scrub.parse(pct, ""), null);
  const pos = { min: -0.5, max: 1.5, step: 0.01, scale: 100, offset: 0.5 };
  assert.equal(scrub.parse(pos, "−8"), 0.42, "a typographic minus works");
  assert.equal(scrub.parse({ min: 0, max: 5, step: 0.1 }, "1,5"), 1.5, "a decimal comma works");
});

test("stepping and dragging move by the step, ×10 with Shift and ×0.1 with Alt", () => {
  const spec = { min: 0, max: 2, step: 0.01 };
  assert.equal(scrub.stepBy(spec, 1, 1), 1.01);
  assert.equal(scrub.stepBy(spec, 1, -1, 10), 0.9);
  assert.equal(scrub.stepBy(spec, 1, 3, 0.1), 1.003, "fine steps aren't rounded away");
  assert.equal(scrub.stepBy(spec, 1.996, 1), 2, "kept in range");
  assert.equal(scrub.stepBy(spec, 0.2, -100), 0);
  assert.equal(scrub.stepBy({ min: 0, max: 30, step: 0.5 }, 0.3, 0), 0.5, "on the step's grid");
  assert.equal(scrub.dragValue(spec, 1, 20), 1.1, `one step per ${scrub.DRAG_PX} px`);
  assert.equal(scrub.dragValue(spec, 1, -21), 0.9, "partial steps don't count");
  assert.equal(scrub.dragValue(spec, 1, 20, 10), 2, "Shift: ten at a time, kept in range");
  assert.equal(scrub.fraction({ min: -1, max: 1, step: 0.01 }, 0), 0.5);
});
