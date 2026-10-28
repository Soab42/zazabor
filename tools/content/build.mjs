// Builds the content library's site into content-dist/: the motion templates (as JSON, from their
// sources in src/modules/studio/video/motion/templates), the fonts they use (public/fonts and
// content/fonts), the soundtracks (content/music) and extra sound effects (content/sounds), with
// catalog.json listing each file's size and SHA-256, signed with the release key
// (tools/release/sign.mjs), and the product page with its installer (content/site).
// tools/content/publish.sh puts it on the site.
//
// Run: node tools/content/build.mjs [--out <dir>]
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signature } from "../release/sign.mjs";

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

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const motion = join(repo, "src/modules/studio/video/motion");
const { TEMPLATES } = await import(join(motion, "templates/index.ts"));
const { STARTER_TEMPLATES } = await import(join(motion, "library.ts"));
const { normalizeTemplate } = await import(join(motion, "format.ts"));
const { BUNDLED } = await import(join(motion, "fonts.ts"));

const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? process.argv[outArg + 1] : join(repo, "content-dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const fail = (why) => {
  console.error(`content: ${why}`);
  process.exit(1);
};

/** Copies a file into the site; its catalog entry (`file`, `bytes`, `sha256`). */
function put(from, file) {
  const data = readFileSync(from);
  mkdirSync(dirname(join(out, file)), { recursive: true });
  copyFileSync(from, join(out, file));
  return { file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

/** A name the site can serve as it is (the library only takes letters, digits, ".", "_" and "-"). */
const plain = (name) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+(?=\.)/g, "");

// Templates: each one's JSON must read back as the app reads the source (as JSON: a property
// that's undefined and one that's missing are the same there).
const templates = TEMPLATES.map((t) => {
  const json = JSON.stringify(t);
  if (JSON.stringify(normalizeTemplate(JSON.parse(json))) !== JSON.stringify(normalizeTemplate(t))) fail(`template ${t.id} doesn't survive JSON`);
  const file = `templates/${plain(t.id)}.json`;
  mkdirSync(join(out, "templates"), { recursive: true });
  writeFileSync(join(out, file), json);
  const entry = put(join(out, file), file);
  return { id: t.id, name: t.name, category: t.category, format: t.version, starter: STARTER_TEMPLATES.some((s) => s.id === t.id) || undefined, ...entry };
});
for (const s of STARTER_TEMPLATES) if (!TEMPLATES.includes(s)) fail(`starter template ${s.id} isn't in templates/index.ts`);

// Fonts: the starter families ship in public/fonts, the rest are in content/fonts.
const fonts = BUNDLED.map((b) => {
  const where = b.starter ? "public" : "content";
  const dir = join(repo, where, "fonts", b.dir);
  if (!existsSync(dir)) fail(`${b.family} (${b.starter ? "starter" : "library"}) isn't in ${where}/fonts/${b.dir}`);
  const other = join(repo, b.starter ? "content" : "public", "fonts", b.dir);
  if (existsSync(other)) fail(`${b.family} is in both public/fonts and content/fonts`);
  if (existsSync(join(dir, "OFL.txt"))) copyFileSync(join(dir, "OFL.txt"), (mkdirSync(join(out, "fonts", b.dir), { recursive: true }), join(out, "fonts", b.dir, "OFL.txt")));
  return {
    family: b.family, kind: b.kind, dir: b.dir, bangla: b.bangla || undefined, starter: b.starter || undefined,
    files: b.files.map(([name, weight, style]) => ({ name, weight, style, ...put(join(dir, name), `fonts/${b.dir}/${plain(name)}`) })),
  };
});

// Soundtracks and sound effects, with what the app shows about each (from their JSON lists).
function audio(folder, list) {
  const src = join(repo, "content", folder);
  if (!existsSync(join(src, list))) return [];
  return JSON.parse(readFileSync(join(src, list), "utf8")).map((item) => {
    const { file, ...rest } = item;
    return { ...rest, ...put(join(src, file), `${folder}/${plain(file)}`) };
  });
}
const music = audio("music", "tracks.json");
const sounds = audio("sounds", "sounds.json");

const catalog = {
  kind: "zazabor-content",
  format: 1,
  published: Math.floor(Date.now() / 1000),
  music, sounds, fonts, templates,
};
const json = JSON.stringify(catalog, null, 1);
writeFileSync(join(out, "catalog.json"), json);
writeFileSync(join(out, "catalog.json.sig"), signature(Buffer.from(json)) + "\n");
// GitHub Pages: serve the files as they are. The product page (content/site: index.html, its
// pictures and the one-line installer) sits beside the library, which it reads for its numbers.
writeFileSync(join(out, ".nojekyll"), "");
cpSync(join(repo, "content", "site"), out, { recursive: true });

const size = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
console.log(`content-dist: ${templates.length} templates, ${music.length} soundtracks, ${sounds.length} sound effects, ${fonts.length} font families, ${(size(out) / 1048576).toFixed(1)} MB`);
