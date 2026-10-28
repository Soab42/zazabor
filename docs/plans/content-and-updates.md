# Content library and updates

Zazabor ships small and gets the rest from GitHub: its motion templates, soundtracks, sound
effects and template fonts from the **content library**, and new versions of itself as **updates**.
Both are signed with the release key, and the app uses nothing that isn't signed with it.

## What ships with the app

- The six starter templates (`STARTER_TEMPLATES` in `src/modules/studio/video/motion/library.ts`)
  and the six fonts they use (`starter: true` in `motion/fonts.ts`, files in `public/fonts/`).
- The sound effects (`src-tauri/resources/sfx`, about 140 KB).

Everything else is in the library: all 56 templates (starters included, so a fix to one reaches
everyone), the ten soundtracks (`content/music/`), the other 22 font families (`content/fonts/`)
and any extra sound effects (`content/sounds/` with a `sounds.json`, like `resources/sfx`).

## The content library

**Site:** GitHub Pages of `Soab42/zazabor-content`, at `https://soab42.github.io/zazabor-content`.
`tools/content/build.mjs` builds it into `content-dist/`:

```
catalog.json        kind "zazabor-content", format 1, published (Unix seconds),
                    music[], sounds[], fonts[], templates[]; each file with its size and SHA-256
catalog.json.sig    the Ed25519 signature of catalog.json (base64)
templates/<id>.json one template document each (the TS sources, as JSON)
music/, sounds/, fonts/<family>/
index.html, site.css, site.js, shots/, icons/, install.sh
                    the product page and the one-line installer (content/site)
```

The product page (`content/site`) reads `catalog.json` for its numbers, categories and playable
soundtracks, and GitHub for the latest version. `install.sh` (`curl -fsSL
https://soab42.github.io/zazabor-content/install.sh | sh`) installs the latest release the way
`scripts/install-linux.sh` does, after checking `latest.json`'s signature with OpenSSL 3 and the
archive's SHA-256. Its screenshots in `content/site/shots` are real ones, taken at 2× on a
nested display.

**In the app** (`src-tauri/src/content.rs`, `src/content.ts`):

- The catalog is fetched at start when the one kept is over an hour old, and hourly while Zazabor
  runs (Settings → Zazabor → Library → Check Now asks at once). It's kept in the data folder's
  `content/` and used offline. A catalog older than the one kept never replaces it.
- A file downloads the first time it's used (a soundtrack when it's played or added, a font
  when a template draws with it) into `content/<file>`, and only files the catalog lists, kept
  only if the size and SHA-256 match. Template documents are small: they all download with the
  catalog, so projects open offline.
- A template whose `format` is newer than the app's `FORMAT_VERSION` is left out, and the
  template browser says to update Zazabor.
- Video projects keep a soundtrack's path. A missing library file (removed with Remove
  Downloads, or a soundtrack from when they shipped in `~/.local/lib/Zazabor/resources/music`)
  downloads again when the project opens.

**Add or change templates, music or fonts:**

1. Templates: add the source to `motion/templates/` and to `TEMPLATES` in `templates/index.ts`.
   Music: the `.ogg` into `content/music/` and an entry in `tracks.json`. Fonts:
   `tools/fetch_motion_fonts.py` (and `BUNDLED` in `fonts.ts`).
2. `node --test tools/content.test.mjs tools/motion.test.mjs`
3. `tools/content/publish.sh` (the first time: `tools/content/publish.sh --setup`, which creates
   the repository and turns on its Pages). Running copies pick it up within the hour.

A template that uses a feature new to the format needs the app that draws it: raise
`FORMAT_VERSION`, release the app, and give the template that `version`. Older copies keep
working with the templates they can draw.

## Updates

**Release:** `scripts/release.sh 0.2.0 "What's new"` sets the version (package.json,
tauri.conf.json, Cargo.toml), builds, packs `zazabor-0.2.0-linux-x86_64.tar.gz` (the program
and `resources/sfx`), writes `latest.json` and signs it, commits and tags `v0.2.0`, and creates
the GitHub release with the three files. `--dry-run` packs into `dist-release/` and publishes
nothing.

```json
{ "kind": "zazabor-update", "version": "0.2.0", "published": 1793210930, "notes": "…",
  "builds": { "linux-x86_64": { "url": "https://github.com/Soab42/zazabor/releases/download/v0.2.0/…",
                                "bytes": 31000000, "sha256": "…" } } }
```

**In the app** (`src-tauri/src/update.rs`, `src/shell/updates.ts`): about 20 seconds after
starting and twice a day (unless Settings → Zazabor → Check for updates automatically is off),
it reads `releases/latest/download/latest.json` and its signature. A newer version shows a
notice; Install Update downloads the archive from the release, checks its SHA-256, unpacks
only `zazabor` and `resources/sfx/*`, and swaps the program in `~/.local/bin` in one rename.
Restart Now quits the way Quit does (windows with unsaved files ask first), and the new version
starts once the old one has gone.

Copies that can't replace themselves (a development build, a program folder Zazabor can't write
to) say so and link the release page. Copies installed before the first release with the updater
(0.1.0) have to install that one by hand (`scripts/install-linux.sh`).

## The release key

`node tools/release/sign.mjs keygen` made it once, at `~/.config/zazabor-release/signing-key.pem`
(readable only by you). Its public half is `PUBLIC_KEY` in `src-tauri/src/signing.rs`.
**Back the private key up.** Without it, no update or library change can reach the copies
already installed; if it's ever exposed, make a new key, put its public half in `signing.rs`,
and have everyone install that release by hand.

Testing against a local server: `ZAZABOR_CONTENT_URL` and `ZAZABOR_UPDATE_URL` point the app
elsewhere (what's there must still be signed with the release key).
