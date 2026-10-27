# Video player: design spec (from the VLC Redesign Figma file)

Source: Figma file `kzhCjdwL4QqrCb5hXqfFTp` ("VLC Redesign (Community)"), frames `247:445`
(player), `187:328` (player with sidebar), `2425:13624` (light), `2107:5604` (customise
player). Reference renders: `player1.png`, `player2.png`, `light.png`, `customize.png` in this
folder. Values below are from Figma's design context; Zazabor adapts them to its glass tokens
(`docs/DESIGN.md`) — **use tokens in code, the hex values only tell you which token to pick.**

## Layout (1920×1080 frame)

```
┌ top bar 40px ───────────────────────────────────────────────────────────────┐
├ rail 50px ┬ sidebar ~377px (collapsible) ┬ video stage ────────────────────┤
│           │                               │                                 │
├───────────┴───────────────────────────────┴─────────────────────────────────┤
└ control bar 54px ───────────────────────────────────────────────────────────┘
```

In Zazabor the Video module lives right of the app rail; its own pieces:

- **Top bar (40px)** — Figma: `#1b1b1b`, backdrop-blur 25, padding 6. Left: "…" menu, sidebar
  toggle, divider, folder icon + breadcrumb text ("Videos", 14px `#8f8f8f`). Centre: current file
  title (14px `#8f8f8f`). Right: window buttons (skip — Zazabor has the system title bar; put
  fullscreen there instead). → Zazabor: a glass toolbar (`--glass` + `--blur`), text `--muted`.
- **Secondary rail (50px)** — Figma: `#191919`, padding 8, gap 14, icon buttons 30px wide (24px
  icons, 4px padding, radius 4). Items: Home, Videos, Music, Network, Playlists, Recent, "+".
  Zazabor first version: **Home, Videos, Recent** (then "+" to open a file/folder). Active item:
  accent icon + `--selection` pill. → glass, hairline on the right.
- **Sidebar (collapsible)** — Figma: `rgba(14,14,14,0.95)` + blur 25, padding 20, gap 17.
  - Header row: back / forward arrows (forward at 30% opacity when unavailable), breadcrumb
    ("… ▶ The Wand ▶ S01": crumbs 16px `#8f8f8f`, separators "▶" 8px `#404040`), then "more" and
    "open externally" icons (gap 12).
  - Count row: "15 items" (14px `#6b6b6b`) left; sort, list/grid view, search icons right (gap 12).
  - 1px divider (`#373737` → `--line-strong`), then the list (padding 20 0, gap 10):
    **media row** = 32×32 thumbnail (radius 2, placeholder `#303030` → `--tile`) + name (14px
    `#969696` → `--text-2`), gap 10. **Watched / in-progress** rows: a 3px accent bar along the
    bottom of the thumbnail (its width = progress) and the name dimmed to `#6b6b6b` (`--muted`).
    The playing item: name in `--text`, accent marker.
- **Video stage** — black (`--stage` in dark; keep the video area dark in light theme too).
  The WebGL canvas fills it, letterboxed.
- **Control bar (54px)** — Figma: `#1b1b1b` + blur 25, padding 11×20, gap 20. Left to right:
  1. **Transport** (gap 8): previous (24px icon), **play/pause pill** (accent `#d37918` fill,
     54px wide, radius 6, icon in `--accent-ink`), next.
  2. **Seek area** (flex 1, gap 8): elapsed time (15px `#8f8f8f`, 76px box, tabular numbers),
     **seek bar** = 28px tall track (radius 6, `#090909` → `rgba(var(--fg),0.06)` in a recessed
     look) with the played part as an inset 24px bar (radius 4, `#371f06` → `--accent-soft`) and
     an 8px-wide accent **thumb** (radius 4) at the playhead; then the duration (same style).
     Hover shows the time under the pointer in a small glass tooltip.
  3. **Volume** (gap 8): speaker icon (mute toggle; icon reflects level high/medium/low/muted)
     + an 88×28 **ramp meter**: a wedge that grows in height left→right, filled with a
     green→yellow gradient up to the volume level, unfilled part `rgba(var(--fg),0.08)`.
     Drag / wheel to change; 0–125%.
  4. **Track buttons** (gap 12, 30px icon buttons): audio tracks, subtitles, playback settings
     (speed etc.) — each opens a glass popover menu above the bar.
  5. **Playlist toggle** (shows/hides the sidebar).
- **Fullscreen**: the stage takes the whole screen; top bar and control bar float over the video
  as glass (`--glass-strong` over video so text stays legible) and fade out after ~2.5 s without
  mouse movement (cursor hidden too); any movement brings them back.
- **Light theme** (`light.png`): bars and sidebar turn light glass, text dark; the stage stays dark.

## Liquid Glass (2026-10-27, on by default)

The user asked for macOS 26's glass "specially for the video player". With Settings → Video →
Interface → Liquid Glass controls on, the same 54px single-row bar (same items, same order) and
the top bar float over the picture as glass capsules (14px from the edges, the bar at most
1180px wide; the top bar splits into pills: menu and crumb, title, extras), and hide while the
video plays and the pointer rests. Off gives the docked Figma layout above.

## Customise player (`customize.png`, frame `2107:5604`)

A sheet over the player: "Customize Player — Drag items around and out of the box below to
re-order them. Drag items into the box to remove them from the player." A grid of draggable
items (icon + label): Spacer, Divider, Playback Speed, Forward 10s, Backward 10s, Forward 15s,
Backward 15s, Stop, Repeat, Shuffle, Record, Snapshot, Picture in Picture, HDR, Zoom, Right
Sidebar, Quit, Settings, Go Home, Thumbnail, File Name, Artist Name, Folder Name, Playlist Name,
Properties, Replay, Chapters, Favorite, Bookmark, Bookmarks, Playlists. While open, the control
bar's slots show dashed outlines as drop targets. Footer: Cancel / Save. Zazabor first version
offers the items it can actually do (speed, ±10 s, ±15 s, stop, repeat, shuffle, spacer,
divider, file name, folder name, playlists, settings, fullscreen) and saves the layout in config.

## Mini player (frame `970:3091`)

A small always-on-top window: artwork/video, title, previous / play-pause / next, a thin seek
bar, and a button back to the full player.
