# SliderPro

A Picasa-style photo gallery for the desktop, with GPU-accelerated deep zoom and cinematic slideshows. Built with [Tauri 2](https://tauri.app) (Rust) and TypeScript + WebGL2.

## Features

**Gallery**
- Finds your photos automatically, like a phone gallery: it scans your home folder and connected drives, skipping hidden folders, app data, code projects and icon-sized images. Results are cached, so albums appear instantly on the next launch.
- Album covers, an "All photos" view, search, sort by date or name, and hidden albums.
- A Google Photos-style justified grid: photos keep their proportions in rows that fill the width (or square tiles, if you prefer).
- Extra folders can be added by hand or dropped onto the window.
- EXIF orientation is respected everywhere.

**Viewer**
- GPU-rendered zoom up to 12,800%, with a pixel grid and crisp pixels at high magnification, and a colour readout under the cursor.
- Cubic-bezier zoom anchored at the cursor; repeated wheel notches and held keys hand their speed on, so zooming glides instead of stuttering. Inertial panning, minimap navigator, filmstrip, crossfades between photos.
- Controls stay in the top and bottom bars, off the photo; in fullscreen they float over it and fade away.
- Info panel with an RGB histogram and camera metadata (camera, lens, exposure, GPS…).

**Slideshows**
- 11 themes: Cinematic, Modern, Action, Neon, Adventure, Travel, Dreamy, Elegant, Memories, Playful and Noir, plus a Custom style that keeps your own timing, look and music with your own mix of transitions.
- 50 WebGL transitions in 8 families (classic, light, motion, zoom & spin, 3D, liquid & organic, geometric, digital), with a live preview of each.
- Ken Burns motion with smart framing (landscapes fill the frame; portraits float over a blurred backdrop), colour grades, film grain, vignette, 2.39:1 letterbox, title cards and captions.
- Five original built-in soundtracks (synthesised by `tools/make_music.py`, free to ship); cuts can land on the beat. Your own music works too.

**Appearance**
- Grid layout, gap and corner rounding; accent colour and background tone; the zoom animation curve (presets or your own cubic-bezier); and custom CSS on top of everything. Changes apply live.

**Privacy lock**
- Lock the app with this computer's administrator password (system polkit dialog) or a custom password (stored as an Argon2 hash).
- While locked, the backend refuses to scan folders or serve any image; hidden albums become private. Auto-lock after inactivity, or press Ctrl+L.
- The lock keeps people using the computer from browsing your photos; it does not encrypt files on disk.

## Keyboard

| Where | Keys |
| --- | --- |
| Gallery | Arrows to move, Enter to open, Ctrl+F to search, F5 for a slideshow, Ctrl+L to lock |
| Viewer | ← → to browse, ↑ ↓, +/− or wheel to zoom (hold to glide), 0 to fit, 1–8 for 100%–12,800%, R to rotate, I for info, F for fullscreen, S for a slideshow |
| Slideshow | Space to pause, ← → to skip, M to mute, S for settings, C for captions, Esc to exit |

## Install on Linux (no root needed)

```sh
scripts/install-linux.sh            # builds, then installs into ~/.local with a menu entry
scripts/install-linux.sh --uninstall
```

This adds SliderPro to your applications menu and to "Open With" for images. To build `.deb`/`.rpm` packages instead, run `npm run tauri build`.

## Development

Requirements: Rust (stable), Node.js 20+, and on Linux the WebKitGTK 4.1 development packages ([Tauri prerequisites](https://tauri.app/start/prerequisites/)).

```sh
npm install
npm run tauri dev               # run in development
npm run tauri build             # build installers
npm run typecheck
cd src-tauri && cargo test      # backend tests
```

Regenerate the built-in soundtracks (needs numpy and GStreamer's `gst-launch-1.0` with vorbisenc):

```sh
python3 tools/make_music.py
```

## Project layout

- `src-tauri/src` — Rust backend: folder discovery (`scan.rs`), decoding, thumbnails and EXIF (`imaging.rs`), the `cs://` image protocol (`protocol.rs`) and the lock (`lock.rs`).
- `src/library` — gallery: albums, virtualized photo grid, sidebar.
- `src/viewer` — zoom engine (`zoom.ts`), WebGL/Canvas2D drawers, filmstrip, info panel.
- `src/slideshow` — player, WebGL renderer and transitions (`gl.ts`), Ken Burns planning, themes, music.
