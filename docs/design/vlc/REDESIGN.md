# VLC redesign: feature checklist

From the designer's video walkthrough ("I Redesigned VLC After 25 Years", Juxtopposed) as
summarised by the project owner, mapped onto CorePro's Video module. `PLAYER.md` has the visual
spec from the Figma file. CorePro keeps its own app accent and icon set (no VLC logo — it is
VideoLAN's trademark) but follows the redesign's ideas: neutral greys/black, orange-style accent
by default in the Video module's presets, rectangular-but-softened shapes, two-tone icons for
non-interactive menu icons.

Owners: **A** = player chrome & quick access, **B** = side panel & subtitles engine,
**C** = media library, **D** = open/convert/stream, settings, profiles, onboarding.

## 1. Visual style (all)
- [ ] Neutral greys/black surfaces in the player; accent for primary actions.
- [ ] Two-tone icon variant (grey + accent) for non-clickable menu/heading icons (A adds the CSS hook).

## 2. Control bar (A)
- [ ] Play/pause bottom-left, slightly bigger, previous/next around it (exists — refine).
- [ ] Fullscreen and the settings/panel button on the right of the bar.
- [ ] "Playlist" toggle becomes a **Queue** button (the auto-playing up-next list; playlists are saved collections — C).
- [ ] Volume as a full cone/wedge (exists — make it a full cone with a clear level).
- [ ] Seek bar along the bottom edge, thicker; **thumbnail preview while hovering/dragging** (backend: frame at a given time).
- [ ] Fullscreen: top bar (title + menu) and bottom bar both appear on hover.

## 3. Quick access (A, video tracks: B)
- [ ] Subtitle button opens the subtitle track list directly.
- [ ] Audio button lists audio tracks **and the output device** (speakers/headphones).
- [ ] Video tracks live in the Video tab of the side panel, not on the bar (B).
- [ ] One menu button replaces the duplicated top menu; the right-click menu is the same, cleaned up, with **Hide UI**.

## 4. Adding subtitles (B)
- [ ] "Add Subtitles" dialog: apply to this file / this folder / this queue; source: this computer (and an online source such as OpenSubtitles when an API key is set).
- [ ] Auto-match subtitle files to episodes (SxxEyy, numbers, names); match once manually and remember it for the series.

## 5. Side panel with four tabs (B; Bookmarks/Chapters tab: A)
- [ ] **Subtitles**: delay slider; subtitle timeline showing when lines appear, drag to sync; font, size (relative or exact), outline, position; save as a per-show **preset**; default subtitle language.
- [ ] **Audio**: default audio track/language, audio delay, equalizer with friendly presets and preview icons.
- [ ] **Video**: filters with live previews (brightness, contrast, saturation, hue, gamma, sharpen, grayscale, sepia…); flip, rotate, zoom, aspect ratio, HDR (tone-mapping toggle); decode resolution.
- [ ] **Playback**: speed, sleep timer, show subtitle timeline, metadata. (Reverse playback isn't supported by libVLC — leave out; waveform on the seek bar is optional.)

## 6. Media library (C)
- [ ] Sections: Home, Videos, Music, Network Streams, Playlists, Recent; pinned items.
- [ ] Back/forward, clickable address bar, visible sort / view mode / search; sort "unwatched first".
- [ ] Videos: automatic library with durations and watched state.
- [ ] Music: songs / albums / artists / genres, large cover art; plays through the same player.
- [ ] Compact library beside the video (sidebar) with **drag into the queue** without stopping playback; full library with the **mini player**.
- [ ] Home: latest files, playlists and streams, continue watching (instead of an empty screen).
- [ ] "Continue where you left off" prompt near the centre controls (A shows the prompt; C keeps positions).

## 7. Open media and streams (D)
- [ ] Separate, simple dialogs: Open File, Open Folder, Network Stream, Capture Device, From Clipboard, Recent Media, Convert, Stream to Device.
- [ ] A pasted IPTV/M3U playlist URL becomes a playlist automatically (C stores it).
- [ ] Create a playlist (name + files) or add a file to a playlist from anywhere (C).

## 8. Bookmarks and shortcut feedback (A)
- [ ] Ctrl+B adds a bookmark at the current time; bookmarks and chapters in the side panel.
- [ ] On-screen messages show which shortcut was pressed, not just the result.

## 9. Settings (D)
- [ ] Video settings in CorePro's Settings page by category: Interface, Playback, Video, Audio, Subtitles (incl. on-screen messages), Library, Network, Performance (hardware decoding), Recording/Casting — basic first, advanced below, an info icon on every setting, words instead of codes.
- [ ] A Keyboard Shortcuts dialog reachable directly from the player menu.

## 10. Customisation (D; Customise Player exists)
- [ ] Drag-and-drop layout editor (exists — polish).
- [ ] Profiles: save the control layout plus video settings under a name and switch between them.
- [ ] First-run intro for the Video module: theme choice and the basic shortcuts.
