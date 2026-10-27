// Motion templates: easing and spring maths, Bangla-safe letter units, text fitting and numbers,
// where every template's texts and pictures sit in each shape, Brand Kit apply/reset, and the
// template file round trip (documents, packages, project clips, split and stretch timing).
// Run: node --test tools/motion.test.mjs   (Node 23.6+ reads the TypeScript directly)
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
const { bezier, ease, spring, valueAt, staggerStart, FEELS } = await import(`${root}/motion/ease.ts`);
const { graphemes, wordsOf, fitText, parseNumber, formatNumber } = await import(`${root}/motion/textfit.ts`);
const { SHAPES, resolve, safeArea, inside, templateTime, clipTimeAt, shapeOf } = await import(`${root}/motion/layout.ts`);
const { BUILT_IN_KITS, applyKit, resetToKit, overrideTheme, themeOf, normalizeTheme, contrast, onColor, paletteFromPixels } = await import(`${root}/motion/brand.ts`);
const { normalizeTemplate, normalizeTemplateClip, normalizePackage, pieceTime, fieldValue, FORMAT_VERSION } = await import(`${root}/motion/format.ts`);
const { TEMPLATES, templateById, templateOf } = await import(`${root}/motion/templates/index.ts`);
const { normalizeMotionSettings, kitFile, readKitFile, defaultKit } = await import(`${root}/motion/settings.ts`);
const model = await import(`${root}/model.ts`);

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ---- easing and springs

test("béziers solve like CSS cubic-bezier()", () => {
  const cssEase = bezier(0.25, 0.1, 0.25, 1);
  // Reference values of CSS `ease` (from the spec's curve, solved by bisection to 1e-9).
  const ref = (x) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 80; i++) {
      const t = (lo + hi) / 2;
      const sx = 3 * (1 - t) ** 2 * t * 0.25 + 3 * (1 - t) * t * t * 0.25 + t ** 3;
      if (sx < x) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2;
    return 3 * (1 - t) ** 2 * t * 0.1 + 3 * (1 - t) * t * t * 1 + t ** 3;
  };
  for (let x = 0; x <= 1.0001; x += 0.05) close(cssEase(x), ref(Math.min(1, x)), 1e-5);
  assert.equal(cssEase(-1), 0);
  assert.equal(cssEase(2), 1);
});

test("every ease starts at 0 and ends at 1 in every feel", () => {
  for (const feel of FEELS) {
    for (const name of ["out", "in", "inOut", "linear", "spring", "back"]) {
      close(ease(name, 0, feel), 0, 1e-9);
      close(ease(name, 1, feel), 1, 1e-9);
      close(ease(name, -3, feel), 0, 1e-9);
      close(ease(name, 7, feel), 1, 1e-9);
    }
    assert.equal(ease("hold", 0.7, feel), 0);
  }
});

test("ease-out is monotonic and front-loaded; ease-in the reverse", () => {
  let last = -1;
  for (let u = 0; u <= 1.0001; u += 0.01) {
    const v = ease("out", u, "smooth");
    assert.ok(v >= last - 1e-9);
    last = v;
  }
  assert.ok(ease("out", 0.3, "snappy") > 0.7, "an expressive out is most of the way there by 30%");
  assert.ok(ease("in", 0.3) < 0.1);
  close(ease("inOut", 0.5), 0.5, 1e-3);
});

test("springs: playful overshoots and bounces, smooth and snappy barely do, all settle at 1", () => {
  const peak = (f) => Math.max(...Array.from({ length: 1001 }, (_, i) => f(i / 1000)));
  const playful = (u) => ease("spring", u, "playful");
  assert.ok(peak(playful) > 1.08, `playful overshoots (${peak(playful)})`);
  assert.ok(peak((u) => ease("spring", u, "snappy")) < 1.05);
  assert.ok(peak((u) => ease("spring", u, "smooth")) < 1.03);
  // Crossing 1 more than once is a bounce.
  let crossings = 0;
  for (let i = 1; i <= 1000; i++) if ((playful(i / 1000) - 1) * (playful((i - 1) / 1000) - 1) < 0) crossings++;
  assert.ok(crossings >= 2, `playful bounces (${crossings} crossings)`);
  for (const f of [spring(0.3, 3), spring(1, 0), spring(0.7, 1)]) {
    close(f(1), 1, 1e-9);
    close(f(0.9999), 1, 0.01);
  }
  // Critically damped never overshoots.
  assert.ok(peak(spring(1, 0)) <= 1 + 1e-9);
});

test("keyframes interpolate with the ease of the key they leave", () => {
  const keys = [[0, 0, "linear"], [1, 10, "hold"], [2, 20]];
  close(valueAt(keys, -1, 5), 0);
  close(valueAt(keys, 0.5, 5), 5);
  close(valueAt(keys, 1.5, 5), 10);
  close(valueAt(keys, 2.5, 5), 20);
  assert.equal(valueAt(undefined, 1, 7), 7);
  assert.equal(valueAt(3, 1, 7), 3);
});

test("staggers run in reading order, and backwards for exits", () => {
  [0, 1, 2, 3].forEach((i) => close(staggerStart(1, i, 4, 0.03), 1 + i * 0.03));
  close(staggerStart(1, 0, 4, 0.1, true), 1.3);
  close(staggerStart(1, 3, 4, 0.1, true), 1);
});

// ---- Bangla-safe units

const MARK = /^[ঁ-ঃ়া-্ৗ‍‌]/u;

test("letters never start with a Bangla vowel sign, virama or joiner", () => {
  const samples = ["কিন্তু", "ক্ষমা", "জ্ঞান", "র্যাব", "স্ট্রিট", "ব্র্যান্ড", "অরোরা বাডস প্রো", "স্টুডিও সাউন্ড, সারাদিনের আরাম।", "৳১২,৯৯৯", "আরও দেখতে ফলো করুন", "শ্রী", "ক্‍ষ"];
  for (const s of samples) {
    const units = graphemes(s);
    assert.equal(units.join(""), s, "nothing lost or reordered");
    for (const u of units) assert.ok(!MARK.test(u), `"${u}" in "${s}" starts with a mark`);
  }
  // Conjuncts stay whole.
  assert.ok(graphemes("ক্ষমা").includes("ক্ষ") || graphemes("ক্ষমা")[0].startsWith("ক্ষ"));
  assert.equal(graphemes("জ্ঞান")[0].startsWith("জ্ঞা"), true);
  assert.equal(graphemes("Hello").length, 5);
  assert.deepEqual(wordsOf("Shop  now"), ["Shop", "  ", "now"]);
});

test("every Bangla default in the shipped templates splits safely", () => {
  for (const t of TEMPLATES) {
    for (const f of t.fields) {
      if (!f.bn) continue;
      for (const u of graphemes(f.bn)) assert.ok(!MARK.test(u), `${t.id}.${f.id}: "${u}"`);
    }
  }
});

// ---- fitting and numbers

// A fake font: every letter is half the size wide.
const measureAt = (size) => (s) => graphemes(s).length * size * 0.5;

test("text shrinks within its range before it wraps further, then ends in an ellipsis", () => {
  const short = fitText("Hello", { width: 400, max: 100, min: 50, lines: 1 }, measureAt);
  assert.equal(short.size, 100);
  assert.deepEqual(short.lines, ["Hello"]);
  // 20 letters at 100px = 1000px: one line needs ≤ 40px; two lines at max fit in 2 lines.
  const two = fitText("Aurora Buds Pro Max!", { width: 600, max: 100, min: 40, lines: 2 }, measureAt);
  assert.ok(two.lines.length <= 2 && !two.cut);
  for (const l of two.lines) assert.ok(measureAt(two.size)(l) <= 600.5);
  const one = fitText("Aurora Buds Pro Max!", { width: 600, max: 100, min: 40, lines: 1 }, measureAt);
  assert.equal(one.lines.length, 1);
  assert.ok(one.size < 100 && one.size >= 40);
  const cut = fitText("This sentence is far too long to ever fit in one small line", { width: 200, max: 40, min: 30, lines: 1 }, measureAt);
  assert.equal(cut.cut, true);
  assert.equal(cut.size, 30);
  assert.ok(cut.lines[0].endsWith("…"));
  assert.ok(measureAt(30)(cut.lines[0]) <= 200);
});

test("Bangla fits by whole letters", () => {
  const f = fitText("স্টুডিও সাউন্ড, সারাদিনের আরাম।", { width: 300, max: 60, min: 20, lines: 2 }, measureAt);
  for (const l of f.lines) for (const u of graphemes(l)) assert.ok(!MARK.test(u));
});

test("prices count in the same shape they're written", () => {
  const bn = parseNumber("৳১২,৯৯৯");
  assert.equal(bn.value, 12999);
  assert.equal(bn.bangla, true);
  assert.equal(formatNumber(parseNumber("৳৬,৪৯৯"), 6499), "৳৬,৪৯৯");
  assert.equal(formatNumber(bn, 9000.4), "৳৯,০০০");
  const lakh = parseNumber("১২,৩৪,৫৬৭ টাকা");
  assert.equal(lakh.lakh, true);
  assert.equal(formatNumber(lakh, 1234567), "১২,৩৪,৫৬৭ টাকা");
  assert.equal(formatNumber(parseNumber("$64"), 129), "$129");
  assert.equal(formatNumber(parseNumber("$1,299.00"), 999.5), "$999.50");
  assert.equal(formatNumber(parseNumber("50%"), 25), "25%");
  assert.equal(parseNumber("Free"), null);
});

// ---- layout per shape

const SIZES = { "9:16": [1080, 1920], "16:9": [1920, 1080], "1:1": [1080, 1080], "4:5": [1080, 1350] };

/** Text and slot picture layers with the groups they're in. */
function placed(layers, out = []) {
  for (const l of layers) {
    if (l.kind === "group") placed(l.children, out);
    else if (l.kind === "text" || (l.kind === "image" && l.slot)) out.push(l);
  }
  return out;
}

test("every template's texts and pictures sit inside the safe area in every shape", () => {
  for (const t of TEMPLATES) {
    for (const shape of t.shapes) {
      const [W, H] = SIZES[shape];
      assert.equal(shapeOf(W, H), shape);
      const safe = safeArea(W, H);
      for (const l of placed(t.layers)) {
        const box = resolve(l.frame, W, H);
        assert.ok(box.w > 0 && box.h > 0, `${t.id}/${l.id} has a size in ${shape}`);
        assert.ok(inside(box, safe, Math.min(W, H) * 0.005), `${t.id}/${l.id} in ${shape}: ${JSON.stringify(box)} outside ${JSON.stringify(safe)}`);
      }
    }
  }
});

test("shapes lay out differently where they should", () => {
  const trio = templateById("feature-trio");
  const card = trio.layers.find((l) => l.id === "card1");
  const a = resolve(card.frame, 1920, 1080), b = resolve(card.frame, 1080, 1920);
  assert.ok(a.h > a.w, "columns in 16:9");
  assert.ok(b.w > b.h, "rows in 9:16");
  const hero = templateById("launch-hero");
  const product = hero.layers.find((l) => l.id === "product");
  assert.ok(resolve(product.frame, 1920, 1080).x > 1920 * 0.4, "the product sits right of the text in 16:9");
});

// ---- Brand Kits

test("applying a kit keeps what was changed by hand; reset puts everything back", () => {
  const [midnight, sunrise] = BUILT_IN_KITS;
  const clip = { theme: themeOf(midnight), kit: midnight.id, overrides: [] };
  overrideTheme(clip, "accent", (th) => (th.colors.accent = "#123456"));
  overrideTheme(clip, "accent", (th) => (th.colors.accent = "#123457"));
  overrideTheme(clip, "heading", (th) => (th.heading = { family: "Anton", weight: 400 }));
  assert.deepEqual(clip.overrides, ["accent", "heading"]);
  applyKit(clip, sunrise);
  assert.equal(clip.kit, sunrise.id);
  assert.equal(clip.theme.colors.primary, sunrise.colors.primary);
  assert.equal(clip.theme.colors.accent, "#123457");
  assert.equal(clip.theme.heading.family, "Anton");
  assert.equal(clip.theme.body.family, sunrise.body.family);
  assert.equal(clip.theme.motion, sunrise.motion);
  resetToKit(clip, sunrise);
  assert.deepEqual(clip.theme, themeOf(sunrise));
  assert.deepEqual(clip.overrides, []);
  // The kit itself isn't changed through the clip.
  clip.theme.colors.primary = "#000000";
  assert.notEqual(sunrise.colors.primary, "#000000");
});

test("built-in kits read well: text on background and on primary", () => {
  for (const k of BUILT_IN_KITS) {
    assert.ok(contrast(k.colors.text, k.colors.background) >= 7, `${k.id} text`);
    assert.ok(contrast(onColor(k.colors.primary), k.colors.primary) >= 3, `${k.id} on primary`);
  }
});

test("kit files and settings: checked, built-ins never stored, fresh ids on import", () => {
  const mine = { ...themeOf(BUILT_IN_KITS[2]), id: "k1", name: "Ours" };
  const s = normalizeMotionSettings({ kits: [mine, { id: "midnight", name: "Fake" }, { junk: true }], defaultKit: "gone", mine: [{ id: "x" }] });
  assert.deepEqual(s.kits.map((k) => k.id), ["k1"]);
  assert.equal(s.defaultKit, "midnight");
  assert.equal(defaultKit(s).id, "midnight");
  assert.equal(s.mine.length, 0);
  assert.equal(s.sounds, true);
  const file = JSON.parse(JSON.stringify(kitFile(mine)));
  const back = readKitFile(file, "k2");
  assert.equal(back.id, "k2");
  assert.equal(back.name, "Ours");
  assert.deepEqual(back.colors, mine.colors);
  assert.equal(readKitFile({ app: "other" }, "k3"), null);
  assert.deepEqual(normalizeTheme({ colors: { primary: "red" }, radius: 9 }).colors.primary, BUILT_IN_KITS[0].colors.primary);
});

test("colours from a logo: its vivid colour leads, text stays readable", () => {
  const px = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) {
    const orange = i % 3 !== 0;
    px.set(orange ? [255, 102, 0, 255] : [20, 20, 20, 255], i * 4);
  }
  const c = paletteFromPixels(px, true);
  assert.equal(c.primary, "#ff6600");
  assert.ok(contrast(c.text, c.background) >= 7);
});

// ---- template files

test("shipped templates are valid documents and survive a save and load unchanged", () => {
  const ids = new Set();
  for (const t of TEMPLATES) {
    assert.ok(!ids.has(t.id));
    ids.add(t.id);
    assert.equal(t.version, FORMAT_VERSION);
    assert.ok(t.hold[0] < t.hold[1] && t.hold[1] <= t.length);
    const back = normalizeTemplate(JSON.parse(JSON.stringify(t)));
    assert.deepEqual(back, JSON.parse(JSON.stringify({ ...t, hits: t.hits ?? [], overlay: !!t.overlay })));
    // Every field a layer names exists.
    const fields = new Set(t.fields.map((f) => f.id));
    const walk = (layers) => {
      for (const l of layers) {
        if (l.field) assert.ok(fields.has(l.field), `${t.id}/${l.id} → ${l.field}`);
        if (l.slot) assert.ok(fields.has(l.slot), `${t.id}/${l.id} → ${l.slot}`);
        if (l.ifEmpty) assert.ok(fields.has(l.ifEmpty));
        if (l.ifFilled) assert.ok(fields.has(l.ifFilled));
        if (l.counter) assert.ok(fields.has(l.counter.from));
        if (l.kind === "group") walk(l.children);
      }
    };
    walk(t.layers);
    for (const f of t.fields) if (f.kind === "text") assert.ok(f.bn !== undefined, `${t.id}.${f.id} has Bangla`);
    for (const f of t.fields) if (f.limit && f.kind === "text") assert.ok(graphemes(f.en).length <= f.limit && graphemes(f.bn ?? "").length <= f.limit, `${t.id}.${f.id} defaults within the limit`);
  }
  assert.equal(TEMPLATES.length, 6);
  assert.equal(normalizeTemplate({ id: "x" }), null);
  assert.equal(normalizeTemplate({ id: "x", layers: [{ id: "a", kind: "rect" }], fields: [], hold: [5, 1], length: 3 }).layers.length, 0, "layers without frames are dropped");
});

test("packages: a template with its values and theme round-trips", () => {
  const t = templateById("sale-price");
  const doc = { app: "zaztemplate", version: 1, name: "Eid Sale", template: { ...t, id: "mine-abc" }, values: { price: "৳৯৯৯" }, theme: themeOf(BUILT_IN_KITS[1]), assets: { product: "product.png", logo: "kit-logo.svg" } };
  const back = normalizePackage(JSON.parse(JSON.stringify(doc)));
  assert.equal(back.name, "Eid Sale");
  assert.equal(back.template.id, "mine-abc");
  assert.deepEqual(back.values, doc.values);
  assert.deepEqual(back.theme, doc.theme);
  assert.deepEqual(back.assets, doc.assets);
  assert.equal(normalizePackage({ app: "zazkit" }), null);
  assert.equal(fieldValue(back.template, back.values, "price"), "৳৯৯৯");
  assert.equal(fieldValue(back.template, back.values, "old", true), "৳১২,৯৯৯");
});

function templateClip(over = {}) {
  return {
    id: "c1", type: "template", start: 2, duration: 6.5, template: "launch-hero", name: "Product Hero",
    values: { title: "Nova" }, slots: { product: "m1" }, theme: themeOf(BUILT_IN_KITS[0]), kit: "midnight", overrides: [],
    place: { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 }, ...over,
  };
}

test("projects keep template clips, drop unknown ones and missing media from slots", () => {
  const raw = {
    canvas: { aspect: "9:16", fps: 30, background: "blur" },
    media: [{ id: "m1", path: "/x/p.png", name: "p.png", kind: "image", duration: 0, width: 10, height: 10, fps: 0, audio: false }],
    tracks: [
      { id: "t0", kind: "main", clips: [] },
      { id: "t1", kind: "overlay", clips: [templateClip(), templateClip({ id: "c2", start: 9, template: "nope" }), templateClip({ id: "c3", start: 20, slots: { product: "gone" } })] },
    ],
  };
  const p = model.normalizeProject(JSON.parse(JSON.stringify(raw)));
  const clips = p.tracks[1].clips;
  assert.deepEqual(clips.map((c) => c.id), ["c1", "c3"]);
  assert.deepEqual(clips[1].slots, {});
  assert.deepEqual(model.unusedMedia(p), [], "a slot counts as using its media");
  p.tracks[1].clips = [clips[1]];
  assert.equal(model.unusedMedia(p).length, 1);
  // A saved template (My Templates) carries its own document.
  const own = normalizeTemplateClip(templateClip({ template: "mine-1", doc: { ...templateById("lower-name"), id: "mine-1" } }), new Set(), () => false);
  assert.equal(templateOf(own).id, "mine-1");
  assert.equal(normalizeTemplateClip(templateClip({ template: "mine-2" }), new Set(), () => false), null);
});

test("splitting a template clip keeps one timeline running across the cut", () => {
  const p = model.newProject("9:16");
  p.tracks.push({ id: "t1", kind: "overlay", clips: [templateClip({ start: 0, duration: 8 })], muted: false, hidden: false });
  const right = model.split(p, "c1", 3);
  const left = p.tracks[1].clips[0];
  assert.deepEqual(left.cut, { from: 0, span: 8 });
  assert.deepEqual(right.cut, { from: 3, span: 8 });
  const t = templateById("launch-hero");
  // The same moment, whichever piece draws it.
  for (const at of [0.5, 2.9]) close(templateTime(pieceTime(left, at).local, 8, t.length, t.hold), templateTime(at, 8, t.length, t.hold));
  for (const at of [0, 1, 4.9]) close(templateTime(pieceTime(right, at).local, 8, t.length, t.hold), templateTime(3 + at, 8, t.length, t.hold));
  // Split again: still the one timeline.
  const third = model.split(p, right.id, 5);
  assert.deepEqual(third.cut, { from: 5, span: 8 });
});

test("stretching only lengthens the hold, and clip time maps back", () => {
  for (const t of TEMPLATES) {
    for (const span of [t.length, t.length * 2, t.length + 0.5, t.hold[0] + (t.length - t.hold[1]) + 0.2, 1]) {
      close(templateTime(0, span, t.length, t.hold), 0);
      close(templateTime(span, span, t.length, t.hold), t.length, 1e-6);
      for (let u = 0; u <= 1.0001; u += 0.1) {
        const tt = templateTime(u * span, span, t.length, t.hold);
        close(clipTimeAt(tt, span, t.length, t.hold), u * span, 1e-6);
      }
    }
    // Entrance and exit keep their timing when stretched.
    const long = t.length * 3;
    close(templateTime(t.hold[0] * 0.5, long, t.length, t.hold), t.hold[0] * 0.5);
    close(templateTime(long - 0.1, long, t.length, t.hold), t.length - 0.1);
  }
});

// ---- SVG logos: cleaned to geometry, measured without the page

const xmldom = await import("@xmldom/xmldom").catch(() => null);
const { sanitizeSvgDocument } = await import(`${root}/motion/svgsafe.ts`);
const { svgShapes, flattenPath, parseTransform } = await import(`${root}/motion/outline.ts`);

const cleanSvg = (text) => {
  const doc = new xmldom.DOMParser({ onError: () => undefined }).parseFromString(text, "image/svg+xml");
  return sanitizeSvgDocument(doc, text);
};

const HOSTILE = `<?xml-stylesheet href="https://evil.example/s.css"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:evil="urn:evil" viewBox="0 0 100 100" onload="alert(1)" style="background:url(https://evil.example/bg.png)">
  <style>@import url(https://evil.example/x.css); circle { fill: red }</style>
  <script>top.__TAURI_INTERNALS__.invoke("photo_write_file")</script>
  <circle id="c" cx="50" cy="50" r="40" fill="url(#g)" stroke="url(https://evil.example/p.svg#a)" onclick="steal()" style="fill:url(javascript:alert(1))" class="x" evil:data="1">
    <animate attributeName="r" values="1;40" dur="1s" onbegin="alert(2)"/>
    <set attributeName="fill" to="red" onend="alert(3)"/>
    <animateTransform attributeName="transform" type="rotate" from="0" to="9"/>
  </circle>
  <a href="javascript:alert(4)"><rect x="10" y="10" width="20" height="20"/></a>
  <a xlink:href="javascript:alert(5)"><path d="M0 0L1 1"/></a>
  <image href="https://evil.example/track.png" width="10" height="10"/>
  <image xlink:href="file:///etc/passwd" width="10" height="10"/>
  <use href="https://evil.example/sprite.svg#icon"/>
  <use xlink:href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#x"/>
  <use href="#line" x="5" onmouseover="x()"/>
  <foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/frame"/></foreignObject>
  <defs><linearGradient id="g" gradientTransform="rotate(10)"><stop offset="0" stop-color="#f00"/></linearGradient><path id="line" d="M10 10H90"/></defs>
  <evil:thing onload="x()"/>
  <video src="https://evil.example/v.mp4"/><audio src="https://evil.example/a.mp3"/>
  <mask id="m"><rect width="100" height="100" fill="#fff" mask="url('https://evil.example/m.svg#m')"/></mask>
  <text x="0" y="0">hello <tspan onclick="x()">there</tspan></text>
  <!-- a comment -->
</svg>`;

test("an SVG logo keeps only its geometry: no script, events, links or outside files", { skip: !xmldom && "@xmldom/xmldom isn't installed" }, () => {
  const rootEl = cleanSvg(HOSTILE);
  assert.ok(rootEl);
  const out = new xmldom.XMLSerializer().serializeToString(rootEl);
  for (const bad of ["onload", "onbegin", "onclick", "onend", "onmouseover", "javascript", "evil", "script", "style", "<image", "foreignObject", "iframe",
    "animate", "<set", "<a ", "<a>", "data:", "@import", "<video", "<audio", "file:", "class=", "<text", "tspan", "comment", "https:"]) {
    assert.ok(!out.includes(bad), `"${bad}" survived: ${out}`);
  }
  for (const good of ["<circle", 'fill="url(#g)"', "<linearGradient", "<stop", 'href="#line"', 'd="M10 10H90"', 'viewBox="0 0 100 100"', "<mask"]) {
    assert.ok(out.includes(good), `"${good}" was lost: ${out}`);
  }
  // Still measurable: the circle and the <use>d line (the rect went with its link).
  const found = svgShapes(rootEl);
  assert.equal(found.shapes.length, 2);
  close(found.shapes[0].length, 2 * Math.PI * 0.4, 0.01);
  close(found.shapes[1].length, 0.8, 1e-6);
});

test("SVGs that aren't plain logos are refused", { skip: !xmldom && "@xmldom/xmldom isn't installed" }, () => {
  assert.equal(cleanSvg(`<!DOCTYPE svg [<!ENTITY a "aaaaaaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>`), null);
  assert.equal(cleanSvg(`<html xmlns="http://www.w3.org/1999/xhtml"><body onload="x()"/></html>`), null);
  assert.equal(cleanSvg(`<svg><path d="M0 0H10"/></svg>`), null, "no SVG namespace: not an SVG");
});

test("a normal logo's outline: transforms, viewBox and every path command", { skip: !xmldom && "@xmldom/xmldom isn't installed" }, () => {
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
    <g transform="translate(100 0) scale(0.5)"><rect x="0" y="0" width="100" height="100"/></g>
    <circle cx="50" cy="50" r="40"/>
    <polygon points="0,0 200,0 200,100"/>
  </svg>`;
  const found = svgShapes(cleanSvg(logo));
  assert.equal(found.aspect, 2);
  close(found.shapes[0].length, 2 * (0.25 + 0.5), 1e-6);
  // An ellipse 0.2 × 0.4 in the 0…1 box (Ramanujan's perimeter).
  const a = 0.2, b = 0.4;
  close(found.shapes[1].length, Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))), 0.01);
  close(found.shapes[2].length, 1 + 1 + Math.SQRT2, 1e-6);
  const len = (d) => flattenPath(d).reduce((n, line) => n + line.slice(1).reduce((m, p, i) => m + Math.hypot(p[0] - line[i][0], p[1] - line[i][1]), 0), 0);
  close(len("M0 0 L10 0 l0 10 H0 V0 Z"), 40);
  close(len("m0 0 10 0 0 10"), 20, 1e-9);
  close(len("M0 0 A10 10 0 0 1 20 0"), Math.PI * 10, 0.05);
  close(len("M0 0 C0 0 10 0 10 0 S20 0 20 0"), 20, 1e-6);
  close(len("M0 0 Q5 0 10 0 T20 0"), 20, 1e-6);
  close(len("M0 0 L10"), 0, 1e-9);
  const r = parseTransform("rotate(90 10 10)");
  close(r[0] * 20 + r[2] * 10 + r[4], 10);
  close(r[1] * 20 + r[3] * 10 + r[5], 20);
  assert.deepEqual(parseTransform("matrix(1 0 0 1 5 6)"), [1, 0, 0, 1, 5, 6]);
});
