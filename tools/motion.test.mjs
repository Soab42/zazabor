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
const { bezier, ease, spring, valueAt, effectAt, staggerStart, FEELS } = await import(`${root}/motion/ease.ts`);
const { graphemes, wordsOf, fitText, parseNumber, formatNumber, wrapBalanced } = await import(`${root}/motion/textfit.ts`);
const { SHAPES, resolve, safeArea, secondaryArea, inside, templateTime, clipTimeAt, shapeOf } = await import(`${root}/motion/layout.ts`);
const { BUILT_IN_KITS, OWN_LOOK, applyKit, resetToKit, applyLook, resetToLook, lookTheme, normalizeLook, normalizeKit, overrideTheme, themeOf, normalizeTheme, contrast, onColor, paletteFromPixels } = await import(`${root}/motion/brand.ts`);
const { normalizeTemplate, normalizeTemplateClip, normalizePackage, pieceTime, fieldValue, FORMAT_VERSION, TEXT_FLOORS, roleOf } = await import(`${root}/motion/format.ts`);
const { TEMPLATES, templateById, templateOf } = await import(`${root}/motion/templates/index.ts`);
const { normalizeMotionSettings, kitFile, readKitFile, defaultKit, setDefaultKit, themeFor, usesOwnLook } = await import(`${root}/motion/settings.ts`);
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

test("evening lines out never splits a word", () => {
  // A narrow "k": at some trial widths "Than" / "k you" would also make two lines.
  const measure = (t) => [...t].reduce((w, c) => w + (c === "k" ? 2 : c === " " ? 3 : 10), 0);
  assert.deepEqual(wrapBalanced("Thank you", 70, measure), ["Thank", "you"]);
  assert.deepEqual(wrapBalanced("Big summer sale now on", 120, (t) => t.length * 10), ["Big summer", "sale now on"]);
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

/** Text, QR and slot picture layers with the groups they're in (tickers run off the edges by design). */
function placed(layers, out = []) {
  for (const l of layers) {
    // A clipped group (a loupe) shows only its own frame, however big what's inside it is.
    if (l.kind === "group") l.clip ? out.push(l) : placed(l.children, out);
    else if ((l.kind === "text" && !l.marquee) || l.kind === "qr" || (l.kind === "image" && l.slot)) out.push(l);
  }
  return out;
}

/** Headlines, CTAs, QR codes and logos are critical: in 9:16 they keep to the strict band (rule book §4.1). */
const critical = (t, l) => (l.kind === "text" && ["headline", "cta"].includes(roleOf(l))) || l.kind === "qr" || (l.kind === "image" && t.fields.find((f) => f.id === l.slot)?.bind === "logo");

test("every template's texts and pictures sit inside the safe area in every shape", () => {
  const misses = [];
  for (const t of TEMPLATES) {
    for (const shape of t.shapes) {
      const [W, H] = SIZES[shape];
      assert.equal(shapeOf(W, H), shape);
      for (const l of placed(t.layers)) {
        const box = resolve(l.frame, W, H);
        assert.ok(box.w > 0 && box.h > 0, `${t.id}/${l.id} has a size in ${shape}`);
        const area = critical(t, l) ? safeArea(W, H) : secondaryArea(W, H);
        if (!inside(box, area, Math.min(W, H) * 0.005)) misses.push(`${t.id}/${l.id} ${shape}${critical(t, l) ? " (critical)" : ""}: y ${(box.y / H).toFixed(3)}–${((box.y + box.h) / H).toFixed(3)}, x ${(box.x / W).toFixed(3)}–${((box.x + box.w) / W).toFixed(3)}`);
      }
    }
  }
  assert.deepEqual(misses, []);
});

test("the 9:16 safe area is the Reels, Shorts and TikTok union", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(safeArea(1080, 1920)).map(([k, v]) => [k, Math.round(v)])), { x: 65, y: 269, w: 886, h: 979 });
  assert.equal(Math.round(secondaryArea(1080, 1920).y + secondaryArea(1080, 1920).h), 1440);
  assert.deepEqual(safeArea(1920, 1080), { x: 54, y: 54, w: 1812, h: 972 });
});

test("no template text is smaller than its role allows", () => {
  const small = [];
  const walk = (t, layers) => {
    for (const l of layers) {
      if (l.kind === "group") walk(t, l.children);
      if (l.kind !== "text") continue;
      const floor = TEXT_FLOORS[roleOf(l)];
      const sizes = [["size", l.size], ["minSize", l.minSize], ...Object.entries(l.textAt ?? {}).flatMap(([k, o]) => [[`${k} size`, o.size], [`${k} minSize`, o.minSize]])];
      for (const [what, v] of sizes) if (v !== undefined && v < floor - 1e-9) small.push(`${t.id}/${l.id} ${what} ${v} < ${floor} (${roleOf(l)})`);
    }
  };
  for (const t of TEMPLATES) walk(t, t.layers);
  assert.deepEqual(small, []);
});

/** Whether a layer (and every group around it) shows at template time `time`. */
function showing(chain, time, feel = "smooth") {
  return chain.every((l) => (!l.time || (time >= l.time[0] && time < l.time[1]))
    && effectAt(l.opacity, time, 1, feel) >= 0.5 && valueAt(l.scale, time, 1) >= 0.3
    && (!l.reveal || valueAt(l.reveal.v, time, 1) >= 0.5));
}
function texts(layers, chain = [], out = []) {
  for (const l of layers) {
    if (l.kind === "group") texts(l.children, [...chain, l], out);
    else out.push([l, [...chain, l]]);
  }
  return out;
}

test("every text stays legible long enough to read (rule book §5.2)", () => {
  const short = [];
  for (const t of TEMPLATES) {
    for (const bangla of [false, true]) {
      for (const [l, chain] of texts(t.layers)) {
        if (l.kind !== "text" || l.marquee) continue;
        const text = l.field ? fieldValue(t, {}, l.field, bangla) : l.text ?? "";
        if (!text.trim()) continue;
        const chars = graphemes(text).length;
        const need = Math.max(1.5, 0.3 + chars / (bangla ? 22 : 20));
        // Legible from 70% into the last unit's entrance until the exit starts.
        const units = !l.animate ? 1 : l.animate.unit === "char" ? chars : l.animate.unit === "word" ? wordsOf(text).filter((w) => w.trim()).length : 1;
        const from = l.animate ? l.animate.t + l.animate.stagger * Math.max(0, units - 1) + l.animate.duration * 0.7 : 0;
        const until = l.exit ? l.exit.t : Infinity;
        let run = 0, best = 0;
        for (let time = 0; time <= t.length; time += 0.02) {
          if (time >= from && time < until && showing(chain, time)) best = Math.max(best, (run += 0.02));
          else run = 0;
        }
        if (best + 1e-6 < need) short.push(`${t.id}/${l.id}${bangla ? " (bn)" : ""}: ${best.toFixed(2)} s legible, needs ${need.toFixed(2)} s`);
      }
    }
  }
  assert.deepEqual(short, []);
});

test("frame 0 is the hook: a headline or the subject is already showing (rule book §0.1)", () => {
  const blank = [];
  for (const t of TEMPLATES) {
    if (t.category === "logo" || t.category === "lower" || t.overlay) continue;
    const ok = texts(t.layers).some(([l, chain]) => {
      if (!showing(chain, 0)) return false;
      if (l.kind === "art" || l.kind === "device") return true;
      if (l.kind !== "text" || !(l.field ? fieldValue(t, {}, l.field) : l.text)) return false;
      const a = l.animate;
      return !a || ((a.from.opacity ?? 1) >= 0.5 && !(a.mask && Math.abs(a.from.dy ?? 0) >= 0.5));
    });
    if (!ok) blank.push(t.id);
  }
  assert.deepEqual(blank, []);
});

test("nothing flashes more than three times a second (WCAG 2.3.1)", () => {
  const flashy = [];
  for (const t of TEMPLATES) {
    for (const [l, chain] of texts(t.layers)) {
      // Opacity sampled at 60 Hz; a flash is a rise and a fall of half or more.
      const v = [];
      for (let time = 0; time <= t.length; time += 1 / 60) v.push(chain.reduce((a, c) => a * effectAt(c.opacity, time, 1), 1));
      const turns = [];
      let dir = 0, from = v[0];
      v.forEach((x, i) => {
        if (dir >= 0 && x < from - 0.5) { turns.push(i); dir = -1; from = x; } else if (dir <= 0 && x > from + 0.5) { turns.push(i); dir = 1; from = x; }
        if ((dir > 0 && x > from) || (dir < 0 && x < from)) from = x;
      });
      for (let i = 0; i + 6 < turns.length; i++) if (turns[i + 6] - turns[i] < 60) { flashy.push(`${t.id}/${l.id}`); break; }
    }
  }
  assert.deepEqual(flashy, []);
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
  // A default kit that's gone: new templates show their own looks.
  assert.equal(s.defaultKit, OWN_LOOK);
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

// ---- template looks

const GOLD = {
  colors: { primary: "#D4AF37", secondary: "#1c1a16", accent: "#f2e3b3", background: "#0a0907", text: "#f7f3ea" },
  heading: { family: "Playfair Display", weight: 700 }, body: { family: "Manrope", weight: 500 },
  backdrop: ["#d4af37", "@accent/0.5", "#8a6a2a", "#050403", "#1a1610"], grade: { warmth: 0.3, fade: 0.08 }, grain: 0.03,
};

test("a template's look is checked: bad colours drop it, bad extras are dropped or held in range", () => {
  const look = normalizeLook(GOLD);
  assert.equal(look.colors.primary, "#d4af37");
  assert.deepEqual(look.backdrop, GOLD.backdrop);
  assert.deepEqual(look.grade, { warmth: 0.3, fade: 0.08 });
  assert.equal(look.grain, 0.03);
  assert.equal(normalizeLook({ ...GOLD, colors: { ...GOLD.colors, text: "white" } }), undefined);
  assert.equal(normalizeLook({ colors: GOLD.colors }), undefined, "fonts are needed");
  assert.equal(normalizeLook(null), undefined);
  const odd = normalizeLook({
    ...GOLD, backdrop: ["#000000", "url(x)", 3, "@primary", "#111111", "#222222", "#333333", "#444444", "#555555"],
    grade: { warmth: 4, saturation: 1, tint: "#ff0000", fade: "lots" }, grain: 1, motion: "wobbly",
  });
  assert.deepEqual(odd.backdrop, ["#000000", "@primary", "#111111", "#222222", "#333333", "#444444"], "six paints at most");
  assert.deepEqual(odd.grade, { warmth: 1 }, "full saturation and a tint without an amount are nothing");
  assert.equal(odd.grain, 0.06);
  assert.equal(odd.motion, undefined);
});

test("own look, kits over it, and back: hand changes stay, reset clears them", () => {
  const look = lookTheme(normalizeLook(GOLD));
  assert.equal(look.colors.primary, "#d4af37");
  assert.equal(look.bangla.family, BUILT_IN_KITS[0].bangla.family, "no Bangla font: the first kit's");
  assert.deepEqual(lookTheme(undefined), themeOf(BUILT_IN_KITS[0]), "no look: Midnight");
  const clip = { theme: themeOf(look), kit: OWN_LOOK, overrides: [] };
  overrideTheme(clip, "accent", (th) => (th.colors.accent = "#123456"));
  const sunrise = BUILT_IN_KITS[1];
  applyKit(clip, { ...sunrise, logo: "/k/logo.png" });
  assert.equal(clip.kit, sunrise.id);
  assert.equal(clip.theme.colors.primary, sunrise.colors.primary);
  assert.equal(clip.theme.colors.accent, "#123456");
  assert.equal(clip.theme.grade, undefined, "a kit has no grade");
  assert.equal(clip.theme.backdrop, undefined);
  assert.equal(clip.theme.grain, undefined);
  applyLook(clip, look);
  assert.equal(clip.kit, OWN_LOOK);
  assert.equal(clip.theme.colors.primary, "#d4af37");
  assert.equal(clip.theme.colors.accent, "#123456", "changed by hand");
  assert.equal(clip.theme.heading.family, "Playfair Display");
  assert.deepEqual(clip.theme.grade, look.grade);
  assert.equal(clip.theme.logo, "/k/logo.png", "the look keeps the logo");
  resetToLook(clip, look);
  assert.deepEqual(clip.overrides, []);
  assert.deepEqual(clip.theme, { ...themeOf(look), logo: "/k/logo.png" });
  // The look isn't changed through the clip.
  clip.theme.grade.warmth = -1;
  clip.theme.backdrop[0] = "#000000";
  assert.equal(look.grade.warmth, 0.3);
  assert.equal(look.backdrop[0], "#d4af37");
});

test("looks survive the file round trip; kits never carry one", () => {
  const doc = normalizeTemplate(JSON.parse(JSON.stringify({ ...templateById("launch-hero"), look: GOLD })));
  assert.deepEqual(doc.look, normalizeLook(GOLD));
  assert.equal(normalizeTemplate(JSON.parse(JSON.stringify({ ...templateById("launch-hero"), look: { colors: {} } }))).look, undefined);
  const theme = lookTheme(doc.look);
  const clip = normalizeTemplateClip(JSON.parse(JSON.stringify(templateClip({ template: "launch-hero", theme, kit: OWN_LOOK }))), new Set(), () => true);
  assert.equal(clip.kit, OWN_LOOK);
  assert.deepEqual(clip.theme, theme);
  const kit = normalizeKit({ ...theme, id: "k1", name: "Gold" });
  assert.equal(kit.grade, undefined);
  assert.equal(kit.backdrop, undefined);
  assert.equal(normalizeKit({ ...theme, id: OWN_LOOK, name: "Sneaky" }), null);
});

test("new templates show their own looks unless a default kit was chosen", () => {
  assert.equal(normalizeMotionSettings({}).defaultKit, OWN_LOOK);
  // Midnight was everyone's default before templates had looks; only a chosen one stays.
  assert.equal(normalizeMotionSettings({ defaultKit: "midnight" }).defaultKit, OWN_LOOK);
  assert.equal(normalizeMotionSettings({ defaultKit: "midnight", kitChosen: true }).defaultKit, "midnight");
  assert.equal(normalizeMotionSettings({ defaultKit: "sunrise" }).defaultKit, "sunrise");
  const s = normalizeMotionSettings({});
  assert.ok(usesOwnLook(s));
  const template = { ...templateById("launch-hero"), look: normalizeLook(GOLD) };
  const own = themeFor(template, s);
  assert.equal(own.kit, OWN_LOOK);
  assert.deepEqual(own.theme, lookTheme(template.look));
  setDefaultKit(s, "tech");
  assert.equal(s.kitChosen, true);
  assert.deepEqual(themeFor(template, s), { theme: themeOf(BUILT_IN_KITS.find((k) => k.id === "tech")), kit: "tech" });
  assert.equal(normalizeMotionSettings(JSON.parse(JSON.stringify(s))).defaultKit, "tech");
  setDefaultKit(s, "gone");
  assert.equal(s.defaultKit, OWN_LOOK);
  assert.equal(s.kitChosen, false);
  setDefaultKit(s, "midnight");
  assert.equal(normalizeMotionSettings(JSON.parse(JSON.stringify(s))).defaultKit, "midnight", "Midnight chosen stays");
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
        if (l.counter?.from !== undefined) assert.ok(fields.has(l.counter.from), `${t.id}/${l.id} counts from ${l.counter.from}`);
        if (l.urlField) assert.ok(fields.has(l.urlField), `${t.id}/${l.id} → ${l.urlField}`);
        if (l.kind === "group") walk(l.children);
      }
    };
    walk(t.layers);
    for (const f of t.fields) if (f.kind === "text") assert.ok(f.bn !== undefined, `${t.id}.${f.id} has Bangla`);
    for (const f of t.fields) if (f.limit && f.kind === "text") assert.ok(graphemes(f.en).length <= f.limit && graphemes(f.bn ?? "").length <= f.limit, `${t.id}.${f.id} defaults within the limit`);
  }
  assert.ok(TEMPLATES.length >= 6);
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

// A template the app doesn't have yet (the library's, offline since installing) keeps its clips:
// they draw once it arrives. Only a clip naming no template goes.
test("projects keep template clips, even of templates not here yet, and drop missing media from slots", () => {
  const raw = {
    canvas: { aspect: "9:16", fps: 30, background: "blur" },
    media: [{ id: "m1", path: "/x/p.png", name: "p.png", kind: "image", duration: 0, width: 10, height: 10, fps: 0, audio: false }],
    tracks: [
      { id: "t0", kind: "main", clips: [] },
      { id: "t1", kind: "overlay", clips: [templateClip(), templateClip({ id: "c2", start: 9, template: "from-the-library" }), templateClip({ id: "c3", start: 20, slots: { product: "gone" } }), templateClip({ id: "c4", start: 30, template: "" })] },
    ],
  };
  const p = model.normalizeProject(JSON.parse(JSON.stringify(raw)));
  const clips = p.tracks[1].clips;
  assert.deepEqual(clips.map((c) => c.id), ["c1", "c2", "c3"]);
  assert.deepEqual(clips[2].slots, {});
  assert.deepEqual(model.unusedMedia(p), [], "a slot counts as using its media");
  p.tracks[1].clips = [clips[2]];
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

// ---- the engine's newer pieces: morphs, particles, charts, countdowns and QR codes

const { morphPath, seeded, particleSeeds, particleCount, particleAt, chartValues, barGrowth, tickClock } = await import(`${root}/motion/kinetic.ts`);
const { encodeQr, formatBits, dataCapacity, versionFor } = await import(`${root}/motion/qr.ts`);

test("shapes morph number by number, and swap halfway when their commands differ", () => {
  const a = "M10 10 L90 10 L50 90 Z", b = "M20 30 L80 30 L50 50 Z";
  assert.equal(morphPath(a, b, 0), a);
  assert.equal(morphPath(a, b, 1), b);
  assert.equal(morphPath(a, b, 0.5), "M15 20 L85 20 L50 70 Z");
  // Numbers written together ("10-5") stay apart once they change sign.
  assert.equal(morphPath("M10-5L0 0", "M20 5L0 0", 0.75), "M17.5 2.5L0 0 ");
  assert.equal(morphPath("M0 0 L1 1", "M0 0 C1 1 2 2 3 3", 0.4), "M0 0 L1 1");
  assert.equal(morphPath("M0 0 L1 1", "M0 0 C1 1 2 2 3 3", 0.6), "M0 0 C1 1 2 2 3 3");
});

test("particles are the same every time, fewer on small canvases", () => {
  const r1 = seeded("confetti-a"), r2 = seeded("confetti-a"), r3 = seeded("confetti-b");
  const a = [r1(), r1(), r1()], b = [r2(), r2(), r2()], c = [r3(), r3(), r3()];
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const v of a) assert.ok(v >= 0 && v < 1);
  assert.deepEqual(particleSeeds("x", 12), particleSeeds("x", 12));
  assert.equal(particleCount("confetti", 1080), 90);
  assert.ok(particleCount("confetti", 240) < particleCount("confetti", 1080) / 2, "a card preview draws far fewer");
  assert.ok(particleCount("dust", 2160) <= particleCount("dust", 1080), "never more than full size at 4K");
  assert.equal(particleCount("sparks", 1080, 0), 0);
});

test("a confetti burst starts at the centre, flies up, then falls and fades", () => {
  const seeds = particleSeeds("burst", 40);
  for (const p of seeds) {
    assert.equal(particleAt("confetti", p, 0.99, 1, 1000, 1000), null, "nothing before the burst");
    const start = particleAt("confetti", p, 1, 1, 1000, 1000);
    close(start.x, 500, 1e-6);
    close(start.y, 500, 1e-6);
    assert.equal(particleAt("confetti", p, 6, 1, 1000, 1000), null, "gone after its life");
  }
  const rose = seeds.filter((p) => particleAt("confetti", p, 1.3, 1, 1000, 1000).y < 500).length;
  assert.ok(rose > seeds.length * 0.7, `most fly up first (${rose})`);
  const late = seeds.map((p) => particleAt("confetti", p, 3.4, 1, 1000, 1000)).filter(Boolean);
  const top = seeds.map((p) => particleAt("confetti", p, 1.5, 1, 1000, 1000));
  assert.ok(late.reduce((s, q) => s + q.y, 0) / late.length > top.reduce((s, q) => s + q.y, 0) / top.length, "then they fall");
  // Dust and embers loop: always somewhere in the box.
  for (const p of seeds) {
    for (const t of [0, 3.3, 47]) {
      const d = particleAt("dust", p, t, undefined, 800, 600);
      assert.ok(d.x >= 0 && d.x <= 800 && d.y >= 0 && d.y <= 600);
    }
  }
});

test("chart values and bars that grow one after another", () => {
  assert.deepEqual(chartValues("40, 65, 90"), [40, 65, 90]);
  assert.deepEqual(chartValues("৪০, ৬৫ ,৯০"), [40, 65, 90]);
  assert.deepEqual(chartValues("98%"), [98]);
  assert.deepEqual(chartValues("4.9 / 5"), [4.9, 5]);
  assert.deepEqual(chartValues("none"), []);
  assert.equal(barGrowth(0, 0, 4, 0.1), 0);
  assert.equal(barGrowth(1, 3, 4, 0.1), 1);
  assert.ok(barGrowth(0.3, 0, 4, 0.1) > barGrowth(0.3, 3, 4, 0.1), "the first bar leads");
  assert.equal(barGrowth(0.5, 0, 1, 0.5), 0.5, "one bar has nothing to stagger");
});

test("countdowns tick down in the shape and digits they're written in", () => {
  assert.equal(tickClock("02:59:59", 0), "02:59:59");
  assert.equal(tickClock("02:59:59", 2.7), "02:59:57");
  assert.equal(tickClock("02:59:59", -4), "02:59:59", "before it starts");
  assert.equal(tickClock("01:00", 1), "00:59");
  assert.equal(tickClock("1:00:00", 1), "0:59:59");
  assert.equal(tickClock("00:03", 10), "00:00", "stops at zero");
  assert.equal(tickClock("০২:০০:০০", 1), "০১:৫৯:৫৯");
  assert.equal(tickClock("Ends in 05:00 only", 61), "Ends in 03:59 only");
  assert.equal(tickClock("শেষ হবে ১০:০০ এ", 1), "শেষ হবে ০৯:৫৯ এ");
  assert.equal(tickClock("Ends tonight", 5), "Ends tonight");
});

test("QR codes: the right version, valid format bits, finders, timing and a dark module", () => {
  assert.equal(dataCapacity(1), 16);
  assert.equal(dataCapacity(5), 86);
  assert.equal(dataCapacity(10), 216);
  assert.equal(versionFor(14), 1);
  assert.equal(versionFor(15), 2);
  assert.equal(versionFor(213), 10);
  assert.equal(versionFor(214), null);
  // Level M with mask 0 is 101010000010010 in the standard's table.
  assert.equal(formatBits(0), 0b101010000010010);
  assert.equal(formatBits(5), 0b100000011001110);
  for (const text of ["https://zazabor.app", "HELLO", "https://shop.example.com/products/সাউন্ড?ref=reel&utm=summer-sale-2026", "x".repeat(200)]) {
    const q = encodeQr(text);
    assert.equal(q.size, q.version * 4 + 17);
    assert.equal(q.modules.length, q.size);
    const m = q.modules;
    for (const [fx, fy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
      for (let i = 0; i < 7; i++) {
        assert.ok(m[fy][fx + i] && m[fy + 6][fx + i] && m[fy + i][fx] && m[fy + i][fx + 6], `${text}: finder ring`);
        if (i >= 2 && i <= 4) assert.ok(m[fy + i][fx + 2] && m[fy + i][fx + 4], "finder centre");
      }
      assert.ok(!m[fy + 1][fx + 1] && !m[fy + 5][fx + 5], "finder gap");
    }
    for (let i = 8; i < q.size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, "timing row");
      assert.equal(m[i][6], i % 2 === 0, "timing column");
    }
    assert.ok(m[q.size - 8][8], "the dark module");
    // Format bits around the top-left finder read back as the chosen mask, and the copy agrees.
    let a = 0, b = 0;
    for (let i = 0; i <= 5; i++) a |= (m[i][8] ? 1 : 0) << i;
    a |= (m[7][8] ? 1 : 0) << 6;
    a |= (m[8][8] ? 1 : 0) << 7;
    a |= (m[8][7] ? 1 : 0) << 8;
    for (let i = 9; i < 15; i++) a |= (m[8][14 - i] ? 1 : 0) << i;
    for (let i = 0; i < 8; i++) b |= (m[8][q.size - 1 - i] ? 1 : 0) << i;
    for (let i = 8; i < 15; i++) b |= (m[q.size - 15 + i][8] ? 1 : 0) << i;
    assert.equal(a, formatBits(q.mask));
    assert.equal(b, a);
  }
  assert.equal(encodeQr("x".repeat(300)), null, "too long for version 10");
});

// ---- live backgrounds

const { BG_PRESETS, BG_COLORS, normalizeBackground, backgroundState, motionPhase } = await import(`${root}/motion/background.ts`);

test("background parameters: unknown presets, bad colours and non-numbers are dropped", () => {
  assert.deepEqual(normalizeBackground({ preset: "plasma" }), { preset: "mesh" });
  assert.deepEqual(normalizeBackground(null), { preset: "mesh" });
  const n = normalizeBackground({
    preset: "bokeh", colors: ["@primary", "red", "#12ab34/0.5", 7, "url(x)", "@accent/1"], speed: "fast", intensity: [[0, 0], [1, "x"]],
    grain: 0.02, drift: [[0, 0], [2, 1]], seed: Infinity, over: "yes",
  });
  assert.deepEqual(n, { preset: "bokeh", colors: ["@primary", "#12ab34/0.5", "@accent/1"], grain: 0.02, drift: [[0, 0], [2, 1]] });
  for (const p of BG_PRESETS) assert.equal(BG_COLORS[p].length, 6, `${p} names six colours`);
  // Out-of-range numbers are held in range when drawn.
  const s = backgroundState({ preset: "rays", intensity: 9, grain: 1, vignette: -2, speed: 99 }, 1, BUILT_IN_KITS[0]);
  assert.equal(s.intensity, 1.5);
  assert.equal(s.grain, 0.1);
  assert.equal(s.vignette, 0);
  assert.equal(s.phase, 4, "speed tops out at 4×");
});

test("a look's background paints and grain fill in where the layer names none", () => {
  const look = lookTheme(normalizeLook(GOLD));
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const s = backgroundState({ preset: "mesh" }, 0, look);
  assert.deepEqual(s.colors[0], rgb("#d4af37"));
  assert.deepEqual(s.colors[2], rgb("#8a6a2a"));
  const { backdrop, ...plain } = look;
  assert.deepEqual(s.colors[5], backgroundState({ preset: "mesh" }, 0, plain).colors[5], "past the look's paints: the preset's");
  assert.equal(s.grain, 0.03);
  const own = backgroundState({ preset: "mesh", colors: ["#ffffff"], grain: 0 }, 0, look);
  assert.deepEqual(own.colors[0], [1, 1, 1], "the layer's own paints win");
  assert.deepEqual(own.colors[2], rgb("#8a6a2a"));
  assert.equal(own.grain, 0);
  assert.equal(backgroundState({ preset: "mesh" }, 0, themeOf(BUILT_IN_KITS[0])).grain, 0.02, "no look: the usual grain");
  const over = backgroundState({ preset: "drift", over: true }, 0, look);
  assert.deepEqual(over.colors[0], rgb(look.colors.accent), "layers over others keep the preset's paints");
});

test("backgrounds take the Brand Kit's colours unless the template names its own", () => {
  const kit = themeOf(BUILT_IN_KITS[1]);
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const s = backgroundState({ preset: "mesh" }, 0, kit);
  assert.deepEqual(s.colors[0], rgb(kit.colors.primary));
  assert.deepEqual(s.colors[1], rgb(kit.colors.secondary));
  assert.deepEqual(s.colors[2], rgb(kit.colors.accent));
  assert.deepEqual(s.colors[4], rgb(kit.colors.background));
  const mine = backgroundState({ preset: "mesh", colors: ["#ff0000", "@text"] }, 0, kit);
  assert.deepEqual(mine.colors[0], [1, 0, 0]);
  assert.deepEqual(mine.colors[1], rgb(kit.colors.text));
  assert.deepEqual(mine.colors[2], rgb(kit.colors.accent), "the rest still from the kit");
  // Another kit, same template: the background follows.
  const other = backgroundState({ preset: "mesh" }, 0, themeOf(BUILT_IN_KITS[2]));
  assert.notDeepEqual(other.colors[0], s.colors[0]);
});

test("background motion: keyframed speed eases the pace, and every number can be keyframed", () => {
  close(motionPhase(undefined, 3), 3);
  close(motionPhase(2, 3), 6);
  close(motionPhase(0, 3), 0);
  close(motionPhase([[0, 1], [2, 1]], 5), 5);
  // Speeding up from 0 to 2 over two seconds (linear) covers 2 s of motion, then 2× after.
  close(motionPhase([[0, 0, "linear"], [2, 2]], 2), 2, 1e-3);
  close(motionPhase([[0, 0, "linear"], [2, 2]], 3), 4, 1e-3);
  close(motionPhase([[1, 0, "linear"], [2, 1]], 0.5), 0, 1e-9);
  // The phase never runs backwards, whatever the keys.
  let last = 0;
  for (let t = 0; t <= 6; t += 0.25) {
    const p = motionPhase([[0, 2, "out"], [1.5, 0.3, "inOut"], [4, 1.2]], t);
    assert.ok(p >= last - 1e-9);
    last = p;
  }
  const s = (t) => backgroundState({ preset: "aurora", intensity: [[0, 0.2], [2, 1]], vignette: [[0, 0], [1, 0.6]], light: 1 }, t, BUILT_IN_KITS[0], [0.5, 0.25]);
  close(s(0).intensity, 0.2);
  close(s(2).intensity, 1);
  close(s(1).vignette, 0.6);
  assert.deepEqual(s(0).light, [0.5, 0.25]);
  assert.equal(normalizeTemplate({ id: "x", layers: [], fields: [], light: { x: [[0, 0.2], [3, 0.8]], y: 0.1 } }).light.y, 0.1, "a template keeps its light");
  assert.equal(normalizeTemplate({ id: "x", layers: [], fields: [], light: { x: "left", y: 0 } }).light, undefined);
});

test("every template has at least two moving background layers and none is flat", () => {
  const backgrounds = (layers, out = []) => {
    for (const l of layers) {
      if (l.kind === "group") backgrounds(l.children, out);
      else if (l.kind === "background" || (l.kind === "fx" && ["blobs", "leak", "rays", "stripes", "confetti", "sparks", "dust"].includes(l.fx))) out.push(l);
    }
    return out;
  };
  for (const t of TEMPLATES) {
    const moving = backgrounds(t.layers);
    if (t.overlay) assert.ok(moving.length >= 1, `${t.id} (over video) lives somewhere`);
    else assert.ok(moving.length >= 2, `${t.id} has ${moving.length} moving background layers`);
    for (const l of moving) if (l.kind === "background") assert.notEqual(motionPhase(l.speed, 10), 0, `${t.id}/${l.id} moves`);
  }
});

test("exits accelerate on the rule book's curve, and effects never spring", () => {
  const exit = bezier(0.3, 0, 0.8, 0.15);
  for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) close(ease("in", u), exit(u), 1e-9);
  // A spring key on opacity eases out instead: never above the target, never back down.
  const keys = [[0, 0, "spring"], [1, 1]];
  let last = 0;
  for (let t = 0; t <= 1; t += 0.02) {
    const v = effectAt(keys, t, 1, "playful");
    assert.ok(v <= 1 + 1e-9 && v >= last - 1e-9);
    last = v;
  }
  assert.ok(Math.max(...Array.from({ length: 50 }, (_, i) => valueAt(keys, i / 50, 1, "playful"))) > 1.05, "position still springs");
  // Snappy overshoots at most 1.5%.
  assert.ok(Math.max(...Array.from({ length: 200 }, (_, i) => ease("spring", i / 200, "snappy"))) <= 1.015);
});

test("a danda never wraps onto a line of its own", () => {
  assert.deepEqual(wordsOf("আজই কিনুন ।").filter((w) => w.trim()), ["আজই", "কিনুন।"]);
});
