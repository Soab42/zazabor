# CorePro

Files, photos and video in one premium desktop app: a Finder-style file manager, a Picasa-style gallery with GPU deep zoom and cinematic slideshows, and (in progress) a VLC-based video player. Each feature can be turned on or off in Settings. Built with [Tauri 2](https://tauri.app) (Rust) and TypeScript + WebGL2. CorePro grew out of SliderPro; its settings move over on first launch.

See `docs/PLAN.md` for the roadmap and `docs/DESIGN.md` for the design rules.

## Features

**App**
- An app rail switches between Files, Gallery and Video (Ctrl+1/2/3); Settings sits at the bottom of the rail.
- A first-run wizard picks the theme, accent colour and which features to turn on.
- Frosted-glass macOS-style interface in dark, light or system theme, with accent colours and background tones.

**Windows**
- Any section can open in its own window (right-click its rail button, a middle click, or Ctrl+N): just that section, without the app rail or Settings. Any file can too (right-click → Open in New Window, or New Window in Quick Look): a picture gets only the viewer, a video only the player, a folder the file manager, PDFs and other files a viewer, text and code the editor.
- Windows share settings and the privacy lock: change the theme in one and the others follow; locking one locks them all.

**Code editor**
- Text and code open in a VS Code–style editor (Monaco, the editor VS Code is built on) in their own window: the project's Explorer, tabs with unsaved dots, breadcrumbs, a minimap, Ctrl+S to save (safely, keeping permissions), Ctrl+P to find a file, Ctrl+G to go to a line, and a status bar for position, indentation, line endings and language. Syntax colouring for dozens of languages, with IntelliSense for TypeScript, JavaScript, JSON, CSS and HTML.

**Files**
- Finder-style browsing: Favourites and Devices in the sidebar (including phones and network shares mounted by GVfs, with capacity meters), a clickable path bar, tabs, back/forward, and live updates when folders change.
- Icon, list, column and gallery views, all virtualized for folders with 100,000 items; image thumbnails, sorting, instant search and hidden files on demand.
- Images open in the Gallery viewer; videos open in the Video player; other files open with their default app or any app from Open With.
- File operations run as jobs with progress, conflict prompts and undo: copy, move, rename, duplicate, new folder, Trash (freedesktop, with Put Back), and drag and drop between folders, tabs and the sidebar.
- Quick Look (Space, or a double-click) for images, video, audio, PDF, text and code; Get Info; colour tags shared with other file managers.
- Search with scope (this folder or subfolders) and filters for kind, date and size; zip/tar compress and extract.
- Connect to Server (Ctrl+K) for SMB, SFTP, FTP and WebDAV; phones and shares appear under Devices and Network.

**Video**
- A libVLC player with the VLC redesign's interface: a frosted control bar with the seek bar along the bottom, hover previews from the film's frames, chapter and bookmark ticks, and a volume cone.
- Quick access on the bar: subtitle tracks, audio tracks and the output device, the Queue, and a side panel with Subtitles, Audio, Video, Playback and Bookmarks tabs.
- Subtitles drawn by CorePro: Add Subtitles for a file, folder or queue (auto-matched to episodes), a timeline you drag to fix the timing, styling and per-show presets.
- Audio delay and an equalizer with presets; video filters with live previews, flip, rotate, zoom, aspect ratio and HDR tone mapping; speed, sleep timer and file details.
- An automatic library: Home with Continue watching, Videos, Music (songs, albums, artists, genres), Network Streams (a pasted M3U address becomes a playlist of channels), Playlists and Recent.
- A compact library beside the video with drag into the queue, a mini player, a continue-where-you-left-off prompt, and on-screen messages that name the key you pressed.
- Separate dialogs for Network Stream, Capture Device, From Clipboard, Recent Media, Convert and Stream to Device; profiles for layout and settings; a drag-and-drop control bar editor; a first-run intro.

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
- Ken Burns motion up to 200% with smart framing (landscapes fill the frame; portraits float over a blurred backdrop). Filled photos get subject-aware camera moves: the camera finds the sharpest, most colourful part of each photo and pushes in, pulls back, trucks, tilts, glides or drifts with a gentle roll, a different move for each photo.
- Colour grades, film grain, vignette, 2.39:1 letterbox, title cards and captions.
- Five original built-in soundtracks (synthesised by `tools/make_music.py`, free to ship); cuts can land on the beat. Your own music works too.

**Settings**
- A searchable Settings page: theme, accent and background tone; grid layout, gap and corners; the zoom animation curve (presets or your own cubic-bezier); custom CSS; features on/off; Files options; the privacy lock; a keyboard reference. Changes apply live.

**Privacy lock**
- Lock the app with this computer's administrator password (system polkit dialog) or a custom password (stored as an Argon2 hash).
- While locked, the backend refuses to scan folders or serve any image; hidden albums become private. Auto-lock after inactivity, or press Ctrl+L.
- The lock keeps people using the computer from browsing your photos; it does not encrypt files on disk.

## Keyboard

| Where | Keys |
| --- | --- |
| App | Ctrl+1/2/3 to switch features, Ctrl+N for a new window of the current one, Ctrl+L to lock |
| Editor | Ctrl+S to save, Ctrl+P to open a file, Ctrl+G to go to a line, Ctrl+Tab to switch tabs, Ctrl+W to close a tab |
| Files | Enter to open, Alt+← → to go back/forward, Alt+↑ or Backspace for the parent folder, Ctrl+T/W for tabs, Ctrl+L to type a path, Ctrl+F to search, Ctrl+H for hidden files |
| Gallery | Arrows to move, Enter to open, Ctrl+F to search, F5 for a slideshow, Ctrl+L to lock |
| Viewer | ← → to browse, ↑ ↓, +/− or wheel to zoom (hold to glide), 0 to fit, 1–8 for 100%–12,800% (without Ctrl), R to rotate, I for info, F for fullscreen, S for a slideshow |
| Slideshow | Space to pause, ← → to skip, M to mute, S for settings, C for captions, Esc to exit |
| Video | Space or K to play/pause, ← → to skip (Shift for longer), ↑ ↓ for volume, M to mute, F for fullscreen, N/P for next/previous, [ ] for speed, G/H for subtitle delay, Ctrl+B for a bookmark, Ctrl+H to hide the UI, Ctrl+M for the mini player, ? for all shortcuts |

## Install on Linux (no root needed)

```sh
scripts/install-linux.sh            # builds, then installs into ~/.local with a menu entry
scripts/install-linux.sh --uninstall
```

This adds CorePro to your applications menu and to "Open With" for images, videos and folders (it removes an older SliderPro launcher). To build `.deb`/`.rpm` packages instead, run `npm run tauri build`.

## Development

Requirements: Rust (stable), Node.js 20+, and on Linux the WebKitGTK 4.1 development packages ([Tauri prerequisites](https://tauri.app/start/prerequisites/)) plus libVLC for the video player (`sudo apt install libvlc-dev vlc`).

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

- `src-tauri/src` — Rust backend: the file manager's commands (`fs/`), folder discovery (`scan.rs`), photo sizes (`dims.rs`), decoding, thumbnails and EXIF (`imaging.rs`), the `cs://` protocol (`protocol.rs`), the lock (`lock.rs`) and the SliderPro → CorePro migration (`migrate.rs`).
- `src/shell` — app rail, module registry, Settings page, first-run wizard; `module.ts` is the contract every feature implements.
- `src/modules/files` — the file manager: browser, sidebar, path bar, tabs, and the four views (`views/`).
- `src/modules/gallery` — albums and the virtualized photo grid (`library/`), the zoom viewer (`viewer/`), slideshows (`slideshow/`).
- `src/modules/video` — the video player (in progress).
- `src/shared`, `src/ui` — thumbnail loader, DOM helpers, icons, menus.
