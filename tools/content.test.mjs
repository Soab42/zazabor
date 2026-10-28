// The content library: tools/content/build.mjs builds a signed catalog whose every file is there
// with the size and SHA-256 it lists, every template reads back as its source, and the starter set
// (which ships with the app) needs only the starter fonts.
// Run: node --test tools/content.test.mjs   (Node 23.6+ reads the TypeScript directly)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.(ts|js|mjs|json|css)$/.test(spec)) {
    for (const ext of [".ts", "/index.ts"]) {
      try { return await next(spec + ext, ctx); } catch {}
    }
  }
  return next(spec, ctx);
}`));

const motion = "../src/modules/studio/video/motion";
const { TEMPLATES } = await import(`${motion}/templates/index.ts`);
const { STARTER_TEMPLATES } = await import(`${motion}/library.ts`);
const { normalizeTemplate } = await import(`${motion}/format.ts`);
const { BUNDLED } = await import(`${motion}/fonts.ts`);
const { normalizeMotionSettings, themeFor } = await import(`${motion}/settings.ts`);

const dir = mkdtempSync(join(tmpdir(), "zazabor-content-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, ZAZABOR_SIGNING_KEY: join(dir, "key.pem") };
const tool = (file, ...args) => execFileSync("node", [new URL(file, import.meta.url).pathname, ...args], { env, encoding: "utf8" });
const publicKey = tool("release/sign.mjs", "keygen").trim();
const out = join(dir, "site");
tool("content/build.mjs", "--out", out);
const catalogBytes = readFileSync(join(out, "catalog.json"));
const catalog = JSON.parse(catalogBytes);

/** Every font family a template draws with (its look's, and any a layer names). */
function familiesOf(t) {
  const theme = themeFor(t, normalizeMotionSettings(undefined)).theme;
  const named = [...JSON.stringify(t).matchAll(/"family":"([^"]+)"/g)].map((m) => m[1]);
  return new Set([theme.heading.family, theme.body.family, theme.bangla.family, ...named]);
}

test("the catalog is signed with the release key", () => {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") }, format: "jwk" });
  const sig = Buffer.from(readFileSync(join(out, "catalog.json.sig"), "utf8").trim(), "base64");
  assert.ok(verify(null, catalogBytes, key, sig));
  assert.ok(!verify(null, Buffer.concat([catalogBytes, Buffer.from(" ")]), key, sig));
  assert.equal(catalog.kind, "zazabor-content");
  assert.equal(catalog.format, 1);
});

test("every file the catalog lists is there, with its size and checksum, under a plain name", () => {
  const entries = [...catalog.music, ...catalog.sounds, ...catalog.templates, ...catalog.fonts.flatMap((f) => f.files)];
  assert.ok(entries.length > 90);
  for (const e of entries) {
    assert.match(e.file, /^(music|sounds|fonts|templates)(\/[A-Za-z0-9._-]+)+$/);
    const data = readFileSync(join(out, e.file));
    assert.equal(data.length, e.bytes, e.file);
    assert.equal(createHash("sha256").update(data).digest("hex"), e.sha256, e.file);
  }
  assert.equal(catalog.music.length, 10);
  assert.ok(catalog.music.every((t) => t.title && t.bpm > 0 && t.seconds > 0 && t.file.endsWith(".ogg")));
});

test("every template is in the library and reads back as its source", () => {
  assert.deepEqual(catalog.templates.map((t) => t.id), TEMPLATES.map((t) => t.id));
  for (const t of TEMPLATES) {
    const entry = catalog.templates.find((e) => e.id === t.id);
    const doc = normalizeTemplate(JSON.parse(readFileSync(join(out, entry.file), "utf8")));
    assert.equal(JSON.stringify(doc), JSON.stringify(normalizeTemplate(t)), t.id);
    assert.equal(!!entry.starter, STARTER_TEMPLATES.includes(t), t.id);
  }
});

test("the starter templates need only the fonts that ship with the app", () => {
  const starterFonts = new Set(BUNDLED.filter((b) => b.starter).map((b) => b.family));
  assert.equal(STARTER_TEMPLATES.length, 6);
  for (const t of STARTER_TEMPLATES) {
    for (const family of familiesOf(t)) assert.ok(starterFonts.has(family), `${t.id} uses ${family}`);
  }
  // …and those are the families in public/fonts; the rest are in the library.
  for (const b of BUNDLED) {
    assert.equal(existsSync(new URL(`../public/fonts/${b.dir}`, import.meta.url)), !!b.starter, b.family);
    assert.equal(existsSync(new URL(`../content/fonts/${b.dir}`, import.meta.url)), !b.starter, b.family);
  }
});

test("every font a template uses is in the library", () => {
  const families = new Set(catalog.fonts.map((f) => f.family));
  for (const t of TEMPLATES) for (const family of familiesOf(t)) assert.ok(families.has(family), `${t.id}: ${family}`);
});
