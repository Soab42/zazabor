# CorePro: plan (draft)

SliderPro grows from a photo gallery into **CorePro**, an all-in-one, pro-grade desktop app: a **file
manager** in the spirit of macOS Finder, the existing **gallery viewer**, and a **video player**
based on the [VLC Redesign (Community)](https://www.figma.com/design/kzhCjdwL4QqrCb5hXqfFTp/VLC-Redesign--Community-?node-id=0-1&p=f&t=Pq8VQcXS2LWtmFM8-0)
Figma concept. Each feature can be switched on or off in Settings, and more features join later.

Status: **decisions made, ready to start with M0.** Section 2 records every decision; section 3
keeps the questions that led to them.
The Figma file has been read (section 8.3), so the video player and the Settings page follow it.

---

## 1. Goals

- **One app, several tools.** Files, Gallery and Video share one window, one design system, one
  settings page, and hand work to each other (open a photo from Files in the Gallery viewer,
  play a video from Files in the player, "Show in Files" from either).
- **Premium, Mac-like feel.** Frosted glass surfaces, light and dark themes, smooth motion,
  keyboard-first, fast with very large folders.
- **Pro / developer friendly.** Show hidden files, copy paths, open a terminal here, code
  previews, everything keyboard-driven.
- **Modular.** A feature is a self-contained module behind one interface; turning it off removes
  it from the UI and stops its background work. New modules (e.g. music, PDF, notes) slot in later.
- **Safe with user data.** File operations are cancellable, undoable where possible, use the
  Trash rather than deleting, and never overwrite silently.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| Video engine | **libVLC** (VLC's engine) for VLC-level format, codec and subtitle support. |
| File manager, first version | All four groups: browse & views, file operations, Quick Look & info, search & tools (section 6). |
| Platforms | **Linux first** (X11 session today); code stays portable, macOS/Windows later. |
| Display server | **X11 now, Wayland later.** On Wayland desktops CorePro runs through XWayland at first; native Wayland video is a later milestone. |
| App shell | **App rail + workspace**: a slim icon rail on the far left switches Files / Gallery / Video; each keeps its own sidebar and state. |
| Rails | **Two rails**: the app rail (Files / Gallery / Video) always stays; the Video module adds VLC's own rail beside it, as in the Figma. A module may bring a secondary rail; Files and Gallery don't need one at first. |
| Default app | Offered in Settings, off by default: separate, reversible switches to make CorePro the default for folders, videos and images (XDG MIME defaults via `xdg-mime`). |
| Video library | **Automatic**, like the Gallery: CorePro finds video folders (Videos, Downloads, mounted drives) and lists them with thumbnails and durations; single files and folders can still be opened directly. |
| Packaging | **.deb + AppImage.** The .deb depends on the system's `libvlc5` and VLC plugins; the AppImage bundles libVLC and its plugins (larger download, works on any distro). `scripts/install-linux.sh` stays for development. |
| Network & devices | **Both in the first version**: Android phones (MTP) and network shares (SMB, SFTP), through GVfs, the system layer GNOME Files uses. |
| Feature toggles | Settings → Features turns modules on/off; disabled modules vanish from the rail. |
| Look | Glassmorphism, light/dark/system theme, accent colours, already started in the current Appearance dialog. The VLC redesign uses the same idea (50px background blur on panels). |
| Name | **CorePro** (was SliderPro). App id `dev.soab.corepro`; settings, caches and the menu entry move over from SliderPro's folders on first launch. |
| Video, first version | The basic player first (section 8.1), then three Figma extras: speed and ±10 s skip, mini player, customise-player editor. Other VLC features wait. |
| Video UI | Follows the VLC Redesign Figma file: its layout, controls, settings structure, onboarding and player customisation (section 8.3). |
| Stack | Keep Tauri 2 (Rust backend) + TypeScript (no framework) + WebGL, as today. |

## 3. Open questions

Asked one at a time; answers are recorded in section 2 as they come in.

1. **Video extras.** Answered: speed and ±10 s skip, mini player and customise-player editor
   join the first version, built after the basics (section 2).
2. **App name.** Answered: CorePro (section 2).
3. **One rail or two.** Answered: two rails (section 2).
4. **Default file manager.** Answered: switches in Settings, off by default (section 2).
5. **Video library.** Answered: automatic library (section 2).
6. **Wayland.** Answered: X11 now, Wayland later (section 2).
7. **Packaging.** Answered: .deb + AppImage (section 2).
8. **Network locations.** Answered: phones and network shares both in the first version (section 2).

All eight are answered; new questions get added here as they come up.

## 4. Architecture

### 4.1 Shell and modules

```
┌──────┬───────────────────────────────────────────────┐
│ rail │  workspace of the active module                │
│      │  (its own sidebar, toolbar, content, status)   │
│ 📁   │                                               │
│ 🖼   │                                               │
│ ▶    │                                               │
│      │                                               │
│ ⚙    │                                               │
└──────┴───────────────────────────────────────────────┘
```

- **Rail**: module icons (enabled ones only), Settings at the bottom, and the active module
  highlighted. Ctrl+1/2/3 switches modules.
- **Secondary rail** (optional, per module): the Video module shows VLC's rail next to the app
  rail. In the first version it holds Home, Videos and Recent; Music, Network and Playlists
  appear when those features are built.
- **Module interface** (TypeScript):
  ```ts
  interface Module {
    id: "files" | "gallery" | "video";
    title: string;
    icon: IconName;
    mount(host: HTMLElement): void;     // build UI once, on first activation
    activate(): void; deactivate(): void; // show/hide; pause expensive work when hidden
    handleKey(e: KeyboardEvent): boolean;
    open?(target: OpenRequest): void;   // e.g. { kind: "image", path, siblings }
    dispose(): void;                     // when the feature is turned off
  }
  ```
- **Router**: `openPath(path)` picks a module by file kind (folder → Files, image → Gallery
  viewer, video → Video player, other → system default app), honouring which modules are on.
- **Lazy loading**: each module is a separate Vite chunk, loaded on first use, so turning
  features off also keeps startup light.

### 4.2 Shared services

| Service | Where | Used by |
|---|---|---|
| File system (list, stat, watch, ops, trash, search, archives) | Rust `fs/` | Files, Gallery (discovery), Video (library) |
| Thumbnails (images today; video frames and PDF pages next) | Rust `imaging.rs` + cache | all |
| Media discovery (photo folders today; video folders next) | Rust `scan.rs` | Gallery, Video |
| File kinds and icons (MIME sniffing, system icon theme) | Rust | Files, Quick Look |
| Quick Look previewer (images, video, audio, text/code, PDF, fonts) | TS `shared/quicklook` | Files, Gallery |
| Jobs (long copies/moves/extracts with progress, cancel, conflicts) | Rust + TS panel | Files |
| Settings, feature flags, appearance, privacy lock, shortcuts | TS `shell/` + `config.ts` | all |

### 4.3 Code layout (target)

```
src/
  shell/        app rail, router, settings page, feature flags, shortcuts
  shared/       design-system components, quicklook, jobs panel, icons, dom helpers
  modules/
    files/      browser, views (icon/list/column/gallery), sidebar, tabs, search, info
    gallery/    today's library/, viewer/, slideshow/ moved here
    video/      player UI, playlist, subtitles, library
src-tauri/src/
  fs/           list.rs, watch.rs, ops.rs (copy/move/rename), trash.rs, search.rs,
                archive.rs, tags.rs, openwith.rs
  video/        libvlc FFI, player state, events, rendering surface
  imaging.rs, scan.rs, dims.rs, protocol.rs, lock.rs, music.rs   (existing)
```

Moving the gallery into `modules/gallery/` is mechanical and comes first, so later work lands in
the new layout.

## 5. Settings page

One Settings view (opened from the rail) replaces today's separate dialogs. Its layout follows
the VLC design's settings window: a search field over grouped categories on the left, and rows
with labelled switches and dropdowns on the right.

- **Features**: toggles for Files, Gallery, Video (at least one stays on); per-module "open at
  launch" choice; "Make CorePro the default for folders / videos / images" switches (off by
  default; turning one off restores the previous default).
- **Appearance**: theme (dark/light/system), accent, background tone, glass intensity, grid
  layout, zoom curve, custom CSS (the current Appearance dialog, moved here).
- **Files**: show hidden files, default view, folders first, confirm before Trash, single vs
  double click, terminal command, default sort.
- **Gallery**: photo discovery locations, hidden albums, slideshow defaults.
- **Video**: hardware decoding, default subtitle language and style, resume playback, skip
  intervals, default speed.
- **Privacy lock** (existing), **Keyboard shortcuts** (view, later remap), **About**.

Turning a module off unmounts it, cancels its background work (e.g. photo discovery), and
removes it from the rail and from "Open with" routing.

## 6. Module: Files (Finder-style)

### 6.1 Browse and views
- Sidebar: Favourites (Home, Desktop, Documents, Downloads, Pictures, Videos, Music, pinned
  folders by drag), Devices (mounted drives, eject), Recent, Trash, tags.
- Views: **icon** (thumbnails for images/videos/PDFs), **list** (sortable columns: name, date,
  size, kind; disclosure triangles), **column** (Miller columns with preview pane), **gallery**
  (big preview + filmstrip). The view is remembered per folder.
- Tabs (Ctrl+T, Ctrl+W, drag to reorder), back/forward history, path bar (clickable crumbs,
  type a path with Ctrl+L), status bar (item count, free space), show/hide hidden (Ctrl+H).
- Virtualized rendering for 100k-item folders; live updates via file watching (`notify` crate).

### 6.2 File operations
- Copy, cut, paste, duplicate, rename (F2, inline), new folder/file, move to Trash
  (freedesktop Trash spec via the `trash` crate), restore from Trash, empty Trash.
- Drag and drop inside the app, to and from other apps (Tauri drag-drop + DnD out).
- Jobs panel for long operations: progress, speed, time left, pause/cancel; conflict dialog
  (replace / keep both / skip, "apply to all").
- Undo/redo for rename, move, trash, new folder (Ctrl+Z).

### 6.3 Quick Look and info
- Space bar opens Quick Look: images (reusing the gallery's zoom engine), video and audio (the
  player in a compact mode), text and code with syntax highlighting, Markdown rendered, PDF
  (pdf.js), fonts, archives (list of contents). Arrow keys move between items while it's open.
- Get Info panel (Ctrl+I): size (folder sizes computed in the background), dates, kind,
  permissions, owner, full path (copyable), image/video metadata, Open With default.
- Colour tags stored as `user.xdg.tags` extended attributes (shared with GNOME and KDE).

### 6.4 Search and tools
- Instant filename search in the current folder and below (Rust walker, fuzzy ranking, streamed
  results); filters: kind, date modified, size; saved searches later.
- Compress to zip, extract zip/tar/tar.gz/7z (where supported); progress via the jobs panel.
- Open With (system apps from XDG MIME data via GIO), set default app.
- Developer extras: open terminal here, copy path / relative path, show dotfiles; later:
  git status badges, open in editor.

### 6.5 Phones and network shares
- Built on **GVfs/GIO** (through the GTK libraries the app already links): `smb://`, `sftp://`
  and `mtp://` locations are mounted with GIO and then appear as ordinary folders (GVfs exposes
  them under `/run/user/<uid>/gvfs/`), so browsing, Quick Look and file operations reuse the
  local code paths.
- Sidebar: a **Devices** group lists phones and drives as they are plugged in (GIO volume
  monitor), with eject; a **Network** group lists saved servers.
- **Connect to Server** (Ctrl+K): enter `smb://nas/photos` or `sftp://user@host/`; a
  credentials sheet asks for user/password (optionally remembered in the system keyring through
  the GIO mount operation).
- Remote folders are slow: listings stream in, thumbnails are generated lazily and cached,
  every operation is cancellable, and timeouts show a clear error instead of freezing.
- Phones: Android must be unlocked and set to "File transfer"; CorePro shows that hint when a
  phone appears without storage access.
- Requires the `gvfs-backends` package (installed on Ubuntu/Pop!_OS by default); the .deb
  depends on it.

## 7. Module: Gallery (existing)

Today's albums, justified grid, deep-zoom viewer, slideshows with custom style, appearance and
privacy lock. Work here is mostly integration:
- Move into `modules/gallery/`; take its settings into the Settings page.
- "Show in Files" from the grid and viewer; Files opens images straight into the viewer.
- Share Quick Look and the thumbnail service with Files.

## 8. Module: Video player (VLC engine, VLC Redesign UI)

### 8.1 Features: a basic VLC, not all of VLC

The player recreates the VLC Redesign's look with only the basics shown in its main player
frames. Anything beyond that goes to the backlog (section 13).

**In (basic player):**
- Open a file or a folder (its videos become the play queue); drop files onto the window;
  open videos from Files.
- The control bar from the Figma: previous, play/pause, next, elapsed time, seek bar, duration,
  mute and volume, audio track menu, subtitle menu (embedded tracks plus loading an SRT/ASS
  file), settings, and the sidebar/playlist toggle.
- Fullscreen with the controls fading away; controls also hide while the mouse rests.
- The collapsible sidebar: the current folder's videos with thumbnails, breadcrumb, sort and
  search.
- Remember the position in each video and resume there.
- Basic shortcuts: Space, ← → (seek), ↑ ↓ (volume), F (fullscreen), M (mute), N/P (next/prev).
- Dark and light themes, accent colour (shared with the rest of the app).

**Library (first version):** the Videos section lists video folders found automatically by the
same discovery scanner the Gallery uses (extended to video files), with a frame thumbnail and
duration for each video; Home shows recently played and continue-watching items.

**Then, still in the first version (after the basics work):**
- Playback speed menu (0.5×–2×) and forward/back 10 s buttons.
- Mini player: a small always-on-top window with play/pause and seek (Figma `970:3091`).
- Customise player: the drag-and-drop editor for the control bar (Figma `2107:5604`), saved in
  Settings.

**Out for now (backlog):** audio effects (equalizer, compressor, spatializer, stereo widener),
video effects (crop, colours, HDR), recording, extensions, profiles, audio visualiser, network
streams, playlists management beyond the current folder, bookmarks, chapters, A–B loop,
snapshots, thumbnail previews on the seek bar.

### 8.2 Engine and rendering: the main technical risk
libVLC decodes everything, but its picture has to appear **inside the app window under HTML
controls**. Three ways to do that, to be settled by a test build (milestone M0):

| Path | How | Pros | Cons |
|---|---|---|---|
| A. Native surface under the webview | Add a GTK drawing area beneath the WebKit view (GTK overlay), give libVLC its X11 window id, and make the webview's player area transparent. | Full speed, hardware decoding, 4K/HDR, zero copies. | X11 only at first (Wayland needs XWayland); fiddly to keep the transparent "hole" aligned. |
| B. Frames into WebGL | libVLC video callbacks write frames to shared memory; the webview uploads them as textures. | Works on any display server; video can be styled and blended freely. | Copies every frame: fine for 1080p, heavy for 4K60. |
| C. Separate borderless window | A native child window tracks the player area's position. | Simple to start. | Fragile on move/resize, focus and stacking problems. |

Plan: try **A** first (X11 now; on Wayland desktops the app is started with
`GDK_BACKEND=x11` so it runs through XWayland), keep **B** as the fallback and for Quick Look
previews. Native Wayland (path B, or a Wayland subsurface) is a later milestone. Rust side: a thin FFI over `libvlc` (via `bindgen`, or the `vlc-rs` crate if it is
still current), player state and events forwarded to the UI as Tauri events.

Setup on this machine: `sudo apt install libvlc-dev vlc` (neither is installed yet).

### 8.3 UI from the Figma file (VLC Redesign, Community)

The file (`kzhCjdwL4QqrCb5hXqfFTp`, one page) holds 1920×1080 designs plus a component sheet.
Screens are built from it with the Figma connector (`get_design_context` per frame) in M7–M8.

**Layout of the player** (frames `247:445`, `187:328`):
- Title bar: app icon, "…" menu, sidebar toggle, breadcrumb of the current folder, centred file
  title, window buttons.
- Left icon rail: Home, Videos, Music, Network streams, Playlists, Recent, and "+" to add.
  CorePro shows it as the Video module's secondary rail, next to the app rail (first version:
  Home, Videos, Recent).
- Collapsible sidebar: back/forward, breadcrumb, item count, sort / view / search buttons, and the
  list (playlists, or a folder of episodes with thumbnails).
- Video area, and a bottom control bar: previous, a pill-shaped play button in the accent colour,
  next, elapsed time, a full-width seek bar (accent fill and thumb), duration, mute, a volume
  meter (green→yellow), then audio tracks, subtitles, settings and the playlist toggle.
- Variants: light theme (`2425:13624`), music playing (`4767:23726`), controls hidden
  (`3328:11554`).

**Customise player** (`2107:5604` and 8 more): a drag-and-drop editor for the control bar. Items:
spacer, divider, playback speed, forward/back 10 s and 15 s, stop, repeat, shuffle, record,
snapshot, picture-in-picture, HDR, zoom, right sidebar, settings, home, thumbnail, file name,
artist, folder name, playlist name, properties, replay, chapters, favourite, bookmark,
bookmarks, playlists. The layout is saved in Settings.

**Settings window** (`999:5047` … `6575:17137`): search field and grouped categories:
App (General, Interface, Privacy, Controls), Media (Playback, Video, Audio, Subtitles, Library),
System (Network, Performance, Recording, Extensions). General holds language, theme
(Dark / Light / System) and accent swatches; rows use labelled ON/OFF switches and dropdowns.
This becomes the template for the app-wide Settings page (section 5).

**Dialogs and panels**: Add subtitles to a playlist/folder (`1911:7545`), Keyboard shortcuts
(`2437:14832`), Open network stream (`6216:13614`), New playlist (`6259:14954`), Miniplayer
(`970:3091`), Audio effects: equalizer, compressor, spatializer, stereo widener
(`6114:13610`, `536:1513`, `536:1703`, `612:1223`), Video effects: essentials, crop, colours
(`536:1855`, `543:990`, `614:1430`), HDR options, audio visualiser, EQ presets, profiles, and
context menus for files, folders, playlists and the player (`2404:13340`, `2139:8935`,
`2459:9389`, `6065:13616`).

**Onboarding** (`1899:3055`, `1902:3670` …): a first-run wizard; one step picks the theme and
accent over a live preview of the player. The app's own first run reuses this pattern and adds
a step to choose which features (Files, Gallery, Video) to turn on.

**Design tokens** (Figma variables, dark):

| Figma variable | Value | App token |
|---|---|---|
| Dark/BG/B2 | `#090909` | deepest background (`--stage` for video) |
| Dark/BG/B1 Transparent | `#0E0E0E` | `--bg` |
| Dark/BG/A5 · A4 · A3 | `#151515` · `#191919` · `#1B1B1B` | panel and glass tints (`--glass-rgb`) |
| Dark/BG/A1 | `#222222` | raised controls (`--control`) |
| Dark/Divider/Dim · Bright | `#222222` · `#373737` | `--line` · `--line-strong` |
| Dark/FG/1 · 2 | `#EAEAEA` · `#C6C6C6` | `--text` · `--text-2` |
| Dark/FG/A1 · A3 · A4 | `#969696` · `#6B6B6B` · `#404040` | `--muted` · `--faint` · disabled |
| Dark/Accent/Main · Dim | `#D37918` · `#AB6314` | `--accent` · pressed accent |
| Dark/BG/Accent Bright | `#371F06` | `--accent-soft` |
| bg blur (+ shadow) | blur 50, shadow `0 8 15 #00000075` | `--blur`, `--shadow-pop` |

The video module uses these values as a theme preset ("VLC"); the rest of the app keeps its
own palette, so both live on one set of token names. The light-theme frame supplies the light
values when built.

## 9. Design system

- Tokens already in `styles.css`: foreground-tinted lines and fills, glass materials
  (`--glass`, `--glass-strong`, `--blur`), shadows, accent, light/dark palettes, background tones.
- Shared components to extract as the modules grow: toolbar, sidebar section and row, segmented
  control, search field, list/table with sortable headers, popover, context menu, sheet/dialog,
  toast, progress row, empty state.
- Motion: cubic-bezier curves (one for UI transitions, the configurable one for zoom), with
  reduced motion respected.
- Icons: keep the current line-icon set; file-type icons from the system theme.

## 10. Milestones

Each milestone ends with the app building, Rust tests passing, and the feature checked in the
running app.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Video test build** (libVLC rendering paths A and B) | A video plays inside the window under HTML controls; path chosen. |
| M1 | **Shell**: rename to CorePro (moving SliderPro's settings and caches), app rail, router, Settings page (VLC-style layout) with feature toggles, first-run wizard; gallery moved into a module | Gallery works as before with existing settings kept; toggling features shows/hides modules and survives restart; first run asks for theme, accent and features. |
| M2 | **Files: browse & views** | Icon, list, column and gallery views, tabs, history, sidebar, hidden files, live updates, 100k-file folder stays smooth. |
| M3 | **Files: operations** | Copy/move/rename/new/trash/restore with jobs panel, conflicts and undo; covered by Rust tests on temp folders. |
| M4 | **Files: Quick Look, info, tags** | Space previews all listed kinds; Get Info; tags readable by the system file manager. |
| M5 | **Files: search & tools** | Instant search with filters, zip/extract, Open With, terminal here. |
| M6 | **Files: phones & network** | Android phone (MTP) and SMB/SFTP shares appear in the sidebar, connect with credentials, browse, preview and copy both ways; unplugging or a dropped connection fails cleanly. |
| M7 | **Video: basic player** on libVLC with the redesign UI (player frame, control bar, sidebar) | Plays mkv/mp4/HEVC; play/pause, seek, volume, audio and subtitle tracks, external subtitles, fullscreen, folder queue, resume; matches the Figma player frame in dark and light. |
| M8 | **Video: library, extras and polish** | Automatic video library (discovery, frame thumbnails, durations), Home with continue-watching; speed menu and ±10 s skip, mini player window, customise-player editor; sidebar thumbnails, error states (unplayable file, missing codec), smooth control-bar hiding. |
| M9 | **Integration & polish** | Cross-module open/show-in, shared Quick Look, shortcuts reference; a .deb (depends on system libVLC) and an AppImage (bundles libVLC) that install and play video on a clean Ubuntu/Pop!_OS. |

M0 comes first because the video rendering path affects the shell's window setup (transparency,
GTK widget tree).

## 11. Risks

| Risk | Mitigation |
|---|---|
| libVLC picture under a webview (section 8.2) | M0 test build before any player UI; fallback path B. |
| Data loss in file operations | Trash by default, copy-then-verify-then-delete for cross-device moves, conflict prompts, Rust tests for every operation, undo journal. |
| Slow or flaky phones and network shares | Streamed listings, lazy cached thumbnails, cancellable operations, timeouts with clear errors (section 6.5). |
| Huge folders and slow drives | Streamed listings, virtualized views, background stat/thumbnails, cancellable work. |
| Glass effects costing frame rate (WebKitGTK) | Blur only on bars and popovers; a "reduce transparency" setting that swaps glass for solid fills. |
| Codec availability | libVLC ships its own codecs; GStreamer-only fallback not needed for video. |
| Licensing | libVLC is LGPL-2.1+: dynamic linking is fine; credit it in About. |
| Scope creep | Each module ships behind its toggle; later ideas go to a backlog, not the current milestone. |

## 12. Testing

- **Rust**: unit tests for listing, ops, trash, search, archives, tags, using temp folders (as
  `scan.rs` and `imaging.rs` already do).
- **TypeScript**: type-checking on every build; pure logic (layout, routing, job state) tested
  with small scripts.
- **App checks**: run the app and screenshot each milestone's flows; keep a short manual
  checklist per module.

## 13. Later (backlog)

Native Wayland video (no XWayland).

Video extras from the Figma file: audio and video effects panels, network streams, playlists,
bookmarks, chapters, A–B loop, snapshots, seek-bar thumbnails, recording, profiles, visualiser.

Other ideas:

Music player module, PDF/document viewer, more network protocols (WebDAV, FTP, NFS), dual-pane mode,
batch rename, duplicate finder, disk usage view, git integration in Files, cloud drives,
plugin API for third-party modules, macOS and Windows builds.
