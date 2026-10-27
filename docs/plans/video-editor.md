# Video editor: a mini CapCut (plan, draft)

*Researched 2026-10-26. Licences, versions and release dates were read from each project's
repository, crates.io and the npm registry on that day. Target: Tauri 2 + plain TypeScript on
Linux. This machine: Pop!_OS 22.04, GStreamer 1.20.3, WebKitGTK 2.50.4, Intel UHD (Tiger Lake)
with VA-API, and an NVIDIA GTX 1650 Mobile whose driver isn't loaded. Status: **V0, V1, V2 and a first V3 built, with most of V4 and V5** (see What's built). Section 11 lists the decisions only the user can make.*

## What's built (2026-10-26)

V0, V1 and a first V3 are in, as **Studio → Video** (`src/modules/studio/video/`, backend
`src-tauri/src/videoedit/`). Checked in the running app on a nested display: a 9:16 reel with two
clips and a picture, split and trimmed, a text, music, a Push-through transition, played back,
exported to MP4 and WebM (both decode in GStreamer, the MP4 also in VLC), saved, closed and
reopened.

- **Project:** `.corevideo` JSON; media paths are stored relative to the project with the
  absolute path as a fallback, and missing files are flagged on open. Undo/redo (200 steps,
  slider drags coalesce), dirty state, Save/Save As through Zazabor's own picker.
- **Timeline** (canvas): magnetic main track, overlay, text and audio tracks (a clash makes a
  new track; empty ones go away), thumbnails, waveforms, cut markers, playhead, ruler,
  zoom (Ctrl+wheel, slider, fit), snapping to edges and the playhead, move/reorder, trim both
  edges, split (S, Ctrl+B), delete (main always ripples; Shift+Delete ripples others),
  duplicate (Ctrl+D), Q/W trim to the playhead, mute/hide per track, drag and drop from the
  media panel.
- **Preview:** WebGL2 compositor; frames come from one GStreamer decoder per clip at preview size
  (raw IPC, I420); Web Audio plays and mixes the clips' sound and is the clock; frames are asked
  for ahead by the measured fetch time. Fill/fit with the blurred background, position, scale,
  rotation, opacity, Ken Burns on pictures, the slideshow's 6 looks plus brightness, contrast and
  saturation, all 50 slideshow transitions on main-track cuts (the shared `FINAL` shader), texts
  with 8 styles, outline, box, glow and fade/pop/slide/typewriter/bounce animations, click and
  drag layers on the preview, safe-area guides.
- **Inspector:** project (shape, background, frame rate), clip (fit, position, filter, adjust,
  speed 0.25–4× with the same source span, volume, fades, transition), text (content, font,
  size, style, colours, animation, duration).
- **Export:** the page renders each frame at the output size, packs I420 on the GPU and sends it;
  the sound is mixed with an OfflineAudioContext. MP4 = VA-API H.264 (constant QP) + MP3, through
  our own byte-stream→AVC converter (`h264.rs`) into `mp4mux` with fast start; WebM = VP9 + Opus.
  720p/1080p, 24–60 fps, three qualities, progress with fps and time left, Cancel.
- **Sound without a GStreamer decoder** (AAC from phones here): libVLC converts it to a cached WAV
  first (`audio.rs`, its own libVLC instance). Tested by forcing it on an MP2 clip; no AAC sample
  could be made on this machine.

### Round 2 (2026-10-27)

- **Missing files and AutoRecover:** opening a project (or a recovered one) looks for moved files
  by name and size under the project's folder, the folder above it and the nearest existing folder
  of where each file was (`videoedit/relink.rs`, 200,000 entries at most, hidden folders skipped);
  the rest are listed with Locate… (Zazabor's own picker, then that folder is searched for the
  others) and Search a folder…. Media now records its size. While a project has unsaved changes a
  snapshot is kept every 20 s (`videoedit/recover.rs`, the app's data folder); one a Zazabor left
  behind (crash, power cut, killed) shows on Studio's Home under Recovered, opens unsaved as it was,
  and can be discarded. Saving or closing deletes it.
- **Keyframes (V2):** position, scale, rotation, opacity and volume, with smooth, linear, ease in,
  ease out and hold. A ◆ before each slider adds or removes the keyframe at the playhead; with
  keyframes, moving the slider (or dragging the layer on the preview) changes the one there. Step
  between keyframes and set their ease in the inspector; diamonds on the clip's foot in the
  timeline (click to jump). Splits and trims keep the motion where it was.
- **Effects and colour (V2):** blur, sharpen, vignette, grain; Shake, Zoom pulse, Glitch, RGB
  split, VHS, Mirror, Flash in and Blur in with an amount; .cube colour tables (3D, or 1D turned
  into 3D; 16-bit float 3D texture) with a strength; chroma key (colour, eyedropper on the preview,
  strength, edge, spill); masks (circle or rectangle, sizes in the picture's shorter side, feather,
  invert); picture in picture on overlays (corner spots, rounded corners, border, drop shadow).
  All in the one layer shader (`gfx.ts`), so preview and export match.
- **Speed (V5):** reverse (the frame server keeps up to 64 MB of decoded frames behind the newest
  one, so going backwards costs one seek per stretch, not per frame; the sound plays from a reversed
  copy), freeze frame at the playhead (splits the clip and holds that frame for 3 s, silent),
  speed curves Montage, Hero, Bullet, Jump cut, Flash in and Flash out (the clip keeps its part of
  the file; sound follows with a playback-rate curve). Splitting a curved clip flattens it into two
  plain speeds that play the same frames.
- **Make a Video (V5):** the Gallery's slideshow dialog has Make a Video: the chosen photos (at most
  200) become a reel in the Video Editor in that theme's style: its look, vignette and grain, a
  picture length of two thirds of the theme's (on the soundtrack's beat when it has a BPM), the
  theme's weighted transitions, and the slideshow's music (a Zazabor soundtrack or the user's file)
  faded out at the end.
- **Sound (V4 without AI):** voice-overs recorded from the default microphone through GStreamer
  (`videoedit/record.rs`; WebKitGTK's own microphone access is off in Zazabor's webview) into
  `Voice-overs/` beside a saved project, with a level meter; the clips play silently meanwhile and
  the take lands on a Voice track at the playhead (R starts and stops, Esc throws it away). Music
  can go down under voice-overs (Lower under voice-overs, by how much; 0.15 s down, 0.45 s back up,
  pauses under 0.6 s ignored, the voice-over's own waveform decides when it speaks). Volume
  keyframes, fades and ducking are one gain curve per clip (100 values a second, `audio.ts`), the
  same in preview and export. Mark beats finds the beat in a sound (onsets, the best tempo from 70
  to 180 BPM, an even grid nudged onto the onsets); clips snap to the marks.
- **Captions:** .srt files come in as texts on a track of their own (Caption style); texts go out
  as .srt.
- **Checked:** Rust tests for relink matching and the search, AutoRecover (only other Zazabors'
  snapshots, newest first, ids can't leave the folder) and recording a test tone into a WAV with
  the meter; 12 Node tests (`node --test`, kept outside the repo) on keyframe interpolation and
  eases, keyed setters, splits and trims with keyframes, curve maths, reverse and its split, freeze,
  ducking and gains, beat detection on a click track, SRT and .cube parsing, and old projects. In
  the app on a nested display: keyframes added from the inspector and seen moving; reverse counting
  down; a freeze frame; a .cube table, VHS and a vignette; chroma key over a clip; a circle mask; a
  test-tone voice-over on a Voice track; 60 beats marked on a 120 BPM song; captions with Bangla;
  a moved file found and a renamed one located; a project recovered after killing Zazabor; a reel
  made from six Gallery photos. An exported MP4 showed the keyframed zoom, the keyed ball, the
  captions, the freeze, the reversed clip with the colour table and VHS, and its sound had the music
  at about 20% under the voice-over and back after it.
- **Measured** (optimized Rust build, the page from Vite unminified, 272×480 preview on the
  nested display, load average about 4 from other builds): V2's bar, 20 phone-like clips
  (1080×1920 H.264, about 9 Mb/s) with a transition on every cut plus three overlays (a keyed
  VP9 green screen, a framed picture-in-picture 1080p clip and a picture with Ken Burns) plays at
  the full 60 fps of drawing, about 190 clip frames a second, with 9–23% of them a frame late (a
  repeated frame, mostly at cuts, where a decoder opens). Export of the same 30 s at 1080×1920:
  18.2 fps (0.61× real time); a single phone clip: 27.7 fps (0.92×). In a debug build under a load
  of 15 the same reel drew 70–105 clip frames a second with 30–43% late. Real time on the bar
  needs a decoder per main-track file instead of per clip (cuts in the same file reuse it) and
  read-back without the page (V6).
- **Fixed on the way:** 10-bit video (VP9 profile 2/3, HDR phone clips) failed with "Internal data
  stream error": `videoflip` only takes 8-bit formats, so the frame chain converts first. A focused
  slider now takes the arrow keys instead of the playhead.

### Round 3 (2026-10-27)

- **Auto captions (V4):** the Captions tab captions all clips or the selected one, in a chosen
  language or Auto, with a model, a caption style and a highlight colour for the spoken word
  (karaoke). The captions are texts on the captions track with per-word timings, and running it
  again replaces only the earlier auto captions. Whisper runs in Rust on candle
  (`videoedit/whisper/`: ggml file reader for f16/f32 files, log-mel, encoder, decoder with a
  key-value cache, OpenAI's timestamp rules, a temperature fallback of 0, 0.4 and 0.8 when a
  window repeats itself, and skipping windows without speech) on a worker thread, with progress
  and Cancel.
- **Models (decision 4):** Base and Small, pinned to commit `5359861c` of
  `ggerganov/whisper.cpp` on Hugging Face (MIT): `ggml-base.bin` 147,951,465 bytes, SHA-256
  `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`; `ggml-small.bin`
  487,601,967 bytes, SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`.
  A prompt with the size comes before the download; it can be paused and resumes with an HTTP
  range, the file is checked against its size and SHA-256 (and deleted if it doesn't match), and it
  stays in the app's data folder (`videoedit/models/`). Settings → Video Editor lists the models
  with Download, Pause, Resume and Remove. `ZAZABOR_WHISPER_BASE_URL` points the download
  elsewhere (tests).
- **Bangla:** Auto detects Bangla ("bn") on a LibriVox reading, but Small writes it in the wrong
  scripts (Telugu-, Khmer- and Gurmukhi-like text). The token bytes were checked against
  whisper.cpp's vocabulary, so it's the model, not the decoding: Small isn't usable for Bangla
  here, and the app says so ("Bangla doesn't come out right yet"). Next: `large-v3-turbo`.
- **Codecs (decision 5):** Install codecs (in Export, the Media tab and Settings) says what
  `gstreamer1.0-libav` and `gstreamer1.0-plugins-ugly` add, then runs `pkexec apt-get install -y`
  with them (only allow-listed package names), refreshes GStreamer's registry and probes again.
  Other systems get the package names. Not run on this machine; tested with a stand-in command
  (`ZAZABOR_CODEC_INSTALL_COMMAND`). MP4 export then picks the encoder: VA-API H.264 (default
  here), x264, x265 HEVC (needs `gstreamer1.0-plugins-bad`), and AAC sound (`avenc_aac`,
  `fdkaacenc` or `voaacenc`) instead of MP3.
- **NVENC (decision 6):** `nvh264enc` and `nvh265enc` are offered when GStreamer has them and the
  encoder opens (it gets to Ready, where it opens CUDA; the plugin itself loads without a working
  driver). Not available here: the NVIDIA driver isn't loaded.
- **Library (decision 7):** 32 stickers drawn in code (a Stickers tab; they are texts with a
  sticker, so they animate in and out like text) and 12 sound effects synthesized by
  `tools/make_sfx.py` into `src-tauri/resources/sfx/` (Ogg Vorbis, 108 KB in all: whoosh, swoosh,
  pop, click, ding, chime, rise, impact, glitch, shutter, typing, bubbles), listed in the Audio
  tab with a listen button.
- **Speed:** a clip's decoder that has been idle for 400 ms is taken over by the next clip of the
  same file at the same size, so cuts within a file seek instead of opening a pipeline
  (`ZAZABOR_VIDEOEDIT_NO_ADOPT=1` turns it off, for comparison). Export asks for the next frame's
  layers while the current one is read back, and skips layers that a full-frame layer above
  covers.
- **Checked:** Rust tests for the model download (resume with a range, a server without ranges,
  a wrong checksum, cancelling, the pinned files), the codec install (only allow-listed packages,
  the exact command, cancel and failure messages), NVENC and AAC in the encoder choice, caption
  lines (sentence ends incl. "।", pauses, the time limit, clip position and speed), decoder
  adoption, and the ggml reader, mel and timestamp rules. In the app on a nested display: the
  Base model downloaded in the app (18 s) and captioned a 73 s English reading (LibriVox, public
  domain) with the spoken word lit up; a speech-bubble sticker and the whoosh added; Install
  codecs with a stand-in command (it got exactly the two packages, then said the codecs still
  don't show up, since nothing was installed); and a 720p export whose frames show the sticker
  and the karaoke captions, and whose sound has the whoosh at 0 s (correlation 0.87).
- **Measured** (Zazabor's crate at opt-level 3, the page from Vite unminified, nested display; the
  load average from other agents' builds is given):
  - Captions, Base, 73.5 s of English: 40.5 s in the app (1.81× real time) at a load of 4; 47.5 s
    (1.55×) in the test harness at a load of 21–31. Small on 88.9 s of Bangla: 0.29–0.32× real
    time at a load above 20.
  - Preview, V2's bench (20 cuts of one phone clip with transitions and three overlays, 272×480):
    185–201 clip frames a second with 7–13% late, the same with decoder adoption on or off (load
    12–16). Adoption works (one play-through opened 3 MP4 demuxers instead of 23), so the late
    frames don't come from opening decoders.
  - Export of the same 30 s at 1080×1920, 30 fps, VA-API: round 2 18.2 fps (0.61× real time);
    now **31.7 fps (1.06×)** at a load of 4.5. On the way, the first version of this round's
    look-ahead fetched 537 of 900 frames twice (the "already here" test missed WebM's
    millisecond timestamps), which made it 8.2 fps; a slot now remembers the time it was asked
    for, and the next frame decodes during the read-back (16.3 fps with the first fix alone, at a
    load of 12). A frame from the export at 10 s shows the expected source times.

Not built yet: Bangla captions that are usable (`large-v3-turbo`, and reading quantized model
files), word times from attention (DTW) instead of spread by length, HEVC through the one-click
install (x265 is in `gstreamer1.0-plugins-bad`, which the approved command doesn't include), a
cause for the remaining late preview frames, proxies, GIF export and the native compositor (V6), masks that move
with keyframes, more transition and effect packs, speed-curve editing by hand (presets only), and
Make a Video for clips (the Gallery has photos only).

### V0 results (this machine: i5-11400H, Intel UHD VA-API, GStreamer 1.20.3)

| Probe | Result |
|---|---|
| Decoders | VA-API H.264 works without `h264parse` (MP4/MKV hand it whole AUs). VA-API VP9/AV1/VP8 need their parsers (plugins-bad, missing): "no valid frames", so Zazabor demotes them and `vaapidecodebin`; software `vp9dec` is used. No AAC decoder at all (no faad, no gst-libav). HEVC decode untested: no HEVC sample could be made (VLC's x265 wrote an audio-only file). |
| Accurate seek (540p out) | 1080×1920 H.264, 2 s GOP: median 51 ms, max 103 ms. 1080p landscape: 82/151 ms. 10-minute 1080×1920 H.264 at ~22 Mb/s: median 19 ms, max 31 ms. Software VP9: 341/517 ms. |
| Sequential decode (540p out) | H.264 portrait 646 fps, landscape 405 fps, 10-minute file 1081 fps; software VP9 51 fps. Through the frame server (debug build, incl. IPC copy): 90 frames in 432 ms. |
| Encoders | `vaapih264enc`: 81 fps at 1080×1920, but only CQP works here (cbr, vbr, vbr_constrained, icq, qvbr all fail to preroll), and it only writes byte-stream (its MP4/MKV output was corrupt) → own AVC converter. `vaapih265enc` fails to start at 1080p. vp9enc (deadline=1, cpu-used=8, row-mt) and opusenc, lamemp3enc work; no AAC or x264 encoder in GStreamer. |
| Export (first V3, debug build) | 21.4 s reel, 1080×1920 30 fps: MP4 ≈ 14 fps (≈0.46× real time), WebM 14.3 fps (0.48×). The page path (frame in, read-back, frame out) is the limit, not the encoder: V3's "1× real time" isn't met yet → measure a release build, then PBO read-back or the native GLES path (V6). |
| WebCodecs, whisper speed | Not probed this round. |

**Engine choice:** confirmed — GStreamer decodes in Rust, the page composites with WebGL2,
GStreamer encodes; libVLC only as the fallback for sound GStreamer can't decode.

## 1. Summary

- **Zazabor's own timeline and compositor, on parts it already has.**
  - GStreamer (already linked: the `gstreamer` crate drives music playback in `music.rs`) decodes
    clips in Rust.
  - Frames go to the page the way the Video player's already do: I420 frames over `cs://`, drawn
    with WebGL2 in `src/modules/video/surface.ts`, measured at 1080p and 4K at 25 fps.
  - The page composites tracks with WebGL2 and reuses the slideshow's **50 transitions**, colour
    grades, Ken Burns motion and beat sync (`src/modules/gallery/slideshow/`), plus the Video
    player's picture effects.
- **Export renders the same shaders, then GStreamer encodes.** It starts by rendering in the page
  and handing frames to Rust. If that is slower than real time at 1080p, the compositor moves to
  native GLES in Rust: GLSL ES 3.00 is the same language in WebGL2 and in GLES 3, so the shader
  files are shared. Encoders: VA-API H.264/HEVC (present here), x264 when installed, OpenH264
  as a fallback, AV1 through rav1e or SVT-AV1 where GStreamer has them.
- **Auto captions on this computer:** OpenAI's Whisper run in Rust on
  [candle](https://github.com/huggingface/candle) (MIT/Apache-2.0, 0.11.0), reading
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s model files (MIT). whisper-rs was the
  first plan, but it builds whisper.cpp with cmake and libclang, which this machine doesn't have.
  The `base` model (141 MiB) is the default and `small` (465 MiB) is offered for other languages.
  Word timings drive karaoke-style captions.
- **Considered and not chosen as the core:**
  - GES (LGPL, Pitivi's engine) is solid, but can't run Zazabor's own transitions without writing
    GStreamer GL elements.
  - MLT (LGPL with GPL modules; Shotcut and Kdenlive) needs ffmpeg and has no Rust binding.
  - The ffmpeg CLI isn't installed and is LGPL/GPL by build.
  - libVLC only plays.
  - WebCodecs in WebKitGTK has been listed since 2.44, but is unverified in Zazabor's webview.
    It's tested in milestone V0 as a possible shortcut.
- **Formats people post:** templates for 9:16 (Reels, TikTok, Shorts), 1:1, 4:5 and 16:9, and
  export presets for each platform.

## 2. Features

| Area | CapCut | Zazabor, first version | Later |
|---|---|---|---|
| Timeline | Main track plus overlay, text, sticker, effect and audio tracks; magnetic main track; zoomable; snapping | Same: one main video track with magnetic (ripple) behaviour, any number of overlay, text, sticker and audio tracks, snapping to clip edges, playhead and markers, zoom from frames to minutes | Compound clips (nesting), multicam |
| Editing | Split, trim, delete, ripple delete, duplicate, replace, freeze frame, reverse | All of these, with frame-accurate J/K/L shuttle and arrow-key nudging | Slip and slide tools |
| Speed | Normal speed and speed curves (Montage, Hero, Bullet…) | Constant 0.1×–10×, with pitch kept for audio; curves from presets or drawn points; frame blending for slow motion | Optical-flow slow motion |
| Transitions | Hundreds | The slideshow's 50 GLSL transitions in 8 families, each with a duration | More from the same shader framework |
| Effects and filters | Video effects, filters, adjustments (brightness, contrast, saturation, HSL, curves), LUTs | The Video player's picture effects; the slideshow's colour grades, grain, vignette and letterbox; adjustments; .cube LUTs; blur, glitch, shake, zoom-in "punch" | Face retouch, auto reframe |
| Text and titles | Fonts, styles, in/out/loop animations, templates, text to speech | Text layers with system fonts (Bangla shaped by the browser), stroke, shadow, background box, in/out/loop animations (fade, pop, slide, typewriter, bounce), title templates | Text to speech |
| Captions | Auto captions with styles and word highlight | Auto captions with whisper (English, Bangla and the other Whisper languages), editable lines, caption styles with the current word highlighted; import and export .srt | Translation |
| Stickers and overlays | Stickers, GIFs, images, picture in picture | Images, GIFs, PNG with alpha, picture in picture with transform, crop, masks (rectangle, circle, linear) and blend modes | Lottie stickers |
| Keyframes | Position, scale, rotation, opacity, volume, effect settings | Every numeric setting has keyframes with easing (the same cubic-beziers as the Gallery's zoom curve) | Motion tracking |
| Chroma key | Green screen | Chroma key shader with similarity, smoothness and spill removal | AI background removal on video |
| Audio | Music library, sound effects, voice-over, extract audio, fade, volume, noise reduction, beat marks | Zazabor's five soundtracks and the user's music, voice-over recorded through GStreamer (PipeWire/PulseAudio), extract audio from video, fades, volume, keyframes, beat marks (the slideshow's beat detection), automatic ducking under speech | Noise reduction, voice effects |
| Canvas | Ratios, background colour, blur fill | 9:16, 1:1, 4:5, 16:9, 4:3 and custom; background colour, image or blurred fill (as the slideshow fills portrait photos) | — |
| Templates | Template library with placeholders | "Make a reel" from photos and clips, with the slideshow's 11 themes as templates | User templates |
| Export | Resolution, frame rate, bitrate, H.264/HEVC | 720p to 4K, 24–60 fps, H.264 or HEVC in MP4, AV1 where available, GIF; presets per platform; queued in the background with progress | — |

## 3. Engines compared

| Option | Licence | Latest | What it gives | Verdict |
|---|---|---|---|---|
| [GStreamer](https://gstreamer.freedesktop.org) via [gstreamer-rs](https://gitlab.freedesktop.org/gstreamer/gstreamer-rs) | LGPL-2.1+ (GStreamer), MIT/Apache-2.0 (bindings) | 1.28 series (from 2026-01); 1.20.3 here. Bindings 0.25.4, 2026-09-21; Zazabor uses 0.21 | Decoding with seeks, VA-API, encoders, muxers, audio mixing, recording, waveform data | **Yes: decode, audio and encode** |
| [GES](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/tree/main/subprojects/gst-editing-services) (GStreamer Editing Services) | LGPL-2.1+ | `libges-1.0-0` 1.20.1 in the Pop!_OS repositories, not installed; bindings 0.25.4 | A full timeline: layers, clips, trims, transitions (crossfade and SMPTE wipes), effects as GStreamer elements, keyframes, encoding profiles. [Pitivi](https://developer.pitivi.org/GES.html) is built on it | **Plan B.** Custom transitions would need two-input GL elements written in Rust. Worth it if the own compositor's export disappoints |
| [MLT](https://github.com/mltframework/mlt) | LGPL-2.1 core, some modules **GPL** | 7.42.0, 2026-10-03 | The engine of [Shotcut](https://github.com/mltframework/shotcut) (GPL) and Kdenlive (GPL); XML projects, many filters | No: no Rust binding, needs ffmpeg (not installed), GPL modules to avoid |
| [libopenshot](https://github.com/OpenShot/libopenshot) | **LGPL-3.0** | v1.0.1, 2026-09-27 | OpenShot's C++ engine | No: C++ with Qt and ffmpeg |
| ffmpeg CLI, or libav through [ffmpeg-next](https://github.com/zmwangx/rust-ffmpeg) (WTFPL, 9.0.0) / [rsmpeg](https://github.com/larksuite/rsmpeg) (MIT, 0.18.0) | LGPL-2.1+, or **GPL** with x264 and x265 ([legal](https://ffmpeg.org/legal.html)) | ffmpeg 4.4 in the repositories, not installed (only VLC's `libavcodec58`) | Everything, through filter graphs | No as the core. A helper only when installed (for formats GStreamer can't decode) |
| libVLC (already used) | LGPL-2.1+ | 3.0.16 here | Playback; transcoding one file at a time (Video's Convert uses `sout`, `convert.rs`) | Not an editor engine. Its frame path is the model for preview |
| WebCodecs in WebKitGTK, with [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, 1.62.1, 2026-10-22) or [mp4box.js](https://github.com/gpac/mp4box.js) (BSD-3-Clause, 2.5.0) for demuxing and muxing | — | WebKitGTK [lists WebCodecs since 2.44](https://webkitgtk.org/2024/03/27/webkigit-2.44.html), on GStreamer ([Igalia, 2026](https://blogs.igalia.com/webkit/blog/2026/wip-59/)) | Decode and encode in the page, with no frame IPC | **Test in V0.** If VideoDecoder and VideoEncoder work for H.264/HEVC here, decoding and exporting in the page become a simpler path. Codec support follows the installed GStreamer plugins |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) | MIT wrapper; ffmpeg's licence | 0.12.15, 2025-01-07 | ffmpeg in the page | No: slow, needs cross-origin isolation, ffmpeg licensing |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) + whisper-rs | MIT; Unlicense | v1.9.5, 2026-10-06; 0.16.0 | Speech to text with word timestamps, on CPU; Vulkan helps on integrated GPUs ([Phoronix](https://phoronix.com/news/whisper-cpp-1.8.3-12x-perf)) | **Yes: auto captions** |

## 4. Architecture

### 4.1 Project

- A project is a JSON file, `.corevideo`, holding:
  - the canvas (size, frame rate, background) and the tracks;
  - each clip's source and range, speed, transform, keyframes, effects and transitions;
  - text and caption content and markers.
- Sources stay where they are, referenced by path with a fingerprint. Missing files can be
  relinked.
- A project folder in the app's data holds the caches: thumbnails, waveforms, proxies and caption
  results.

### 4.2 Media in Rust

- **Probe:** GStreamer's Discoverer reads duration, frame rate, size, rotation, streams and codecs.
  Then two caches are made in the background: a **thumbnail strip** (one frame every N seconds,
  sized for the timeline) and **waveform peaks** (audio decoded to PCM, peaks per 10 ms).
- **Proxies** (optional, automatic for 4K and HEVC): 540p H.264 made with VA-API when present.
  Editing uses proxies; export always uses the originals.
- **Frame server:** one decoding pipeline per active clip (`uridecodebin` → `videoconvert` →
  `videoscale` → `appsink`, scaled to the preview size).
  - While playing, pipelines run in sync with the audio clock.
  - While scrubbing, accurate seeks (`ACCURATE | FLUSH`) jump to the exact frame, with a small
    cache of recent frames per clip.
  - Frames go to the page through `cs://` as the Video player's do. At the 960×540 preview size, a
    frame is about 0.8 MB, so three layers at 30 fps are about 70 MB/s; the Video player already
    moves about 41 MB/s.
- **Audio:** mixed natively in GStreamer (`audiomixer`, with `volume` elements driven by
  keyframes through control bindings) and played through the system's output. The audio clock is
  the master; the page's preview follows it.

### 4.3 Compositor in the page (preview)

- WebGL2, one pass per layer from bottom to top: transform, crop and mask, effects, blend into the
  canvas.
- At a cut with a transition, the outgoing and incoming clips become the shader's A and B, and the
  slideshow's `transition(uv)` runs with its kind and progress (`gl.ts`).
- Text and stickers are Canvas 2D textures, redrawn only when their content changes. Animations
  are transforms and opacity.
- Caption words highlight through per-word ranges in the texture.
- Interactive handles on the preview (move, scale, rotate a layer) are DOM over the canvas.

### 4.4 Export

1. **First, render in the page:**
   - An offscreen WebGL2 canvas at the output size renders frame N.
   - The final pass converts to I420 in the shader, so read-back is 3.1 MB per 1080p frame, not
     8 MB.
   - The bytes go to Rust (raw IPC, as Office saves files) and into an `appsrc`.
   - Rust feeds decoded source frames at full resolution and runs the audio mix offline.
2. **Measure in V3.** If 1080p30 exports below about 1× real time on this machine, move the
   compositor to Rust:
   - EGL in a headless context (`glow` 0.18.0 with `khronos-egl` 6.0.0, or GStreamer's own GL
     context through `gstreamer-gl` 0.25.4; all MIT/Apache-2.0).
   - The same `.glsl` files the page uses (GLSL ES 3.00 in both).
   - Text pre-rendered by the page as image sequences or atlases.
3. **Encoding**, in order of preference:

   | Codec | Element | Licence | Here? |
   |---|---|---|---|
   | H.264 | `vaapih264enc` (gstreamer-vaapi) | LGPL | Yes |
   | HEVC | `vaapih265enc` | LGPL | Yes |
   | H.264 | `x264enc` (plugins-ugly; [x264](https://www.videolan.org/developers/x264.html) is **GPL**) | GPL plugin, loaded at run time, not shipped | Not installed (`libx264` is, for VLC) |
   | H.264 | `openh264enc` (plugins-bad; [OpenH264](https://github.com/cisco/openh264), BSD-2-Clause, with Cisco's binary for patents) | BSD-2-Clause | Not installed |
   | H.264/HEVC | `nvh264enc` and `nvh265enc` (plugins-bad nvcodec, NVIDIA driver) | LGPL | Driver not loaded |
   | AV1 | `rav1enc` ([rav1e](https://github.com/xiph/rav1e), BSD-2-Clause; gst-plugins-rs) or `svtav1enc` ([SVT-AV1](https://github.com/AOMediaCodec/SVT-AV1), BSD-3-Clause-Clear, newer GStreamer) | BSD | Not on 1.20 |
   | Audio | AAC (`avenc_aac` from gstreamer1.0-libav, or `voaacenc`), Opus (`opusenc`, base) | LGPL / BSD | Opus yes; AAC needs a plugin |

4. **Muxing:** `mp4mux` with fast start (MP4 for every platform), `webmmux` for VP9 and AV1, and
   GIF through a palette pass.
5. **Jobs:** each export is a queued job with progress, an estimate and Cancel, like Files'
   operations. It can carry on while Zazabor is in another section.

### 4.5 Captions

1. The editor's 48 kHz stereo sound cache is cut to the clip's span and resampled to 16 kHz mono
   (windowed sinc).
2. Whisper runs on a worker thread (candle, `videoedit/whisper/`). The language is chosen or
   detected; segments get times from Whisper's timestamp tokens, and words get times spread over
   their segment by length (as whisper.cpp does without DTW).
3. The result becomes texts on the captions track: lines end at sentence ends (including "।"),
   pauses of 0.6 s or more, 3.5 s, or a characters-per-line limit for the canvas shape, with the
   chosen style and the spoken word highlighted.
4. Results are cached per clip span, model, language and engine version. The user corrects text
   in the inspector; the timing stays.

Model choice: `base` (141 MiB) by default and `small` (465 MiB) for other languages, both f16
and downloaded on first use. Small doesn't caption Bangla usably (round 3); `large-v3-turbo`
(f16, about 1.6 GB, since the engine doesn't read quantized files yet) is the next to try.

### 4.6 Ducking and beat sync

- **Ducking:** where a voice or speech clip has energy above a threshold (from the waveform
  peaks), the music's volume gets keyframes 8–12 dB lower, with 200 ms ramps. The keyframes stay
  editable.
- **Beat marks:** the slideshow's beat detection marks beats on music clips. Snapping to beats
  makes cuts land on them.

## 5. Interface

Laid out like CapCut desktop:

- **Media and assets panel** on the left, with tabs: Media, Audio, Text, Stickers, Effects,
  Transitions, Captions, Filters, Templates. Each item can be dragged onto the timeline.
- **Player** in the middle, with the canvas ratio, safe-area guides for Reels and TikTok, and
  full-screen preview.
- **Inspector** on the right for the selected clip: Video (transform, crop, blend, mask), Speed,
  Animation, Adjust, Audio and Captions.
- **Timeline** along the bottom: tracks with thumbnails and waveforms, the magnetic main track,
  the playhead, markers and zoom. Keyboard: Space, J/K/L, Ctrl+B (split), Q/W (trim to the
  playhead), Delete and Shift+Delete (ripple), Ctrl+Z/Y, and +/− to zoom.

## 6. Integration with the rest of Zazabor

- **Video player:** **Edit in Video Editor** from a playing file or the library.
- **Gallery:** select photos and clips, then **Make a Video**. This opens a template project from
  the slideshow themes, ready to export as a reel.
- **Files:** `.corevideo` opens in the editor; videos get **Edit in Video Editor**.
- **Photo editor:** a frame grab can be edited there and placed back as an overlay.

## 7. Milestones

| # | Milestone | Done when |
|---|---|---|
| V0 | **Probes**: WebCodecs in Zazabor's webview (VideoDecoder/VideoEncoder for H.264, HEVC, VP9 and AV1); GStreamer accurate seeks on common phone files; frame streaming at preview size for three layers; whisper base and small speed here | A short report in this plan with the numbers, and the engine choice confirmed or switched |
| V1 | **Timeline and preview**: media panel with probing, thumbnails and waveforms; one video track and one audio track; split, trim, ripple delete; playback with audio sync; scrubbing | A 10-minute 1080p phone video edits and scrubs without lag; the audio stays in sync to within a frame |
| V2 | **Layers and effects**: overlay tracks, picture in picture, transforms with keyframes, the slideshow transitions, effects, filters and LUTs, chroma key, text layers with animations | Twenty clips with transitions and three overlays play in real time at preview size on this machine |
| V3 | **Export**: page compositor read-back, GStreamer encoding with VA-API, presets, the job queue; measure and decide on native GLES | A 1-minute 1080p30 project exports to MP4 that plays in VLC, Chrome and on a phone, and uploads to YouTube without re-encoding warnings |
| V4 | **Audio and captions**: voice-over, music library, fades, volume keyframes, ducking, beat marks, auto captions with styles, .srt in and out | Bangla and English captions come out with word timing close enough to edit, not retype |
| V5 | **Speed and templates**: speed curves with frame blending, freeze frame, reverse, Make a Video from the Gallery with the 11 themes, canvas ratios with blurred fill | A reel made from 20 photos and 3 clips exports in one click |
| V6 | **Native compositor** (if V3 says so), proxies, GIF export, more transitions | 4K export runs at real time or better with VA-API on this machine |

## 8. Effort, roughly

V0 takes one session. V1 takes 3–4 (the timeline UI and the frame server are the core). V2 takes
3, V3 2–3, V4 2, V5 2, and V6 2–3.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Accurate seeking is slow on long-GOP phone video (HEVC from phones) | Proxies (section 4.2), a frame cache, and only accurate seeks when paused; key-unit seeks while dragging fast |
| GStreamer 1.20 on Pop!_OS 22.04 is old (1.28 is current) | Code against 1.20 features. The AppImage can bundle a newer GStreamer later, at the cost of size |
| Missing codecs on the user's system (plugins-bad, ugly, libav not installed here) | Install codecs runs `pkexec apt-get install -y gstreamer1.0-libav gstreamer1.0-plugins-ugly` after explaining it (round 3); other systems are told the package names; VA-API covers H.264 on most Intel and AMD machines |
| Export through the page is slow | Measure in V3; the native GLES path shares shader files, so it's a port, not a rewrite |
| Patent licensing for H.264/HEVC encoding in distributed builds | Use the system's encoders (VA-API, or plugins the user installs) and Cisco's OpenH264 binary; don't bundle x264 or x265. AV1 and VP9 are royalty-free |
| Scope: CapCut is huge | The milestones put a useful editor (cut, text, music, export) at V3; the rest is incremental |

## 10. Licensing summary

- Zazabor links only LGPL GStreamer libraries (dynamically, from the system) and MIT, Apache or
  BSD crates.
- GPL encoders (x264, x265) are GStreamer plugins the user installs; Zazabor loads them at run
  time and never ships them.
- candle is MIT/Apache-2.0; whisper.cpp's model files are MIT (OpenAI's Whisper weights,
  converted). ureq (MIT/Apache-2.0) downloads them with rustls.
- The stickers and sound effects are Zazabor's own (drawn in code, synthesized by
  `tools/make_sfx.py`).
- mediabunny, if WebCodecs is used, is MPL-2.0, which is file-level copyleft and fine for a
  closed or open Zazabor.

## 11. Decisions to make

Decided 2026-10-27: 4–7 are yes (models on first use, with Bangla captions wanted; one-click
codecs; NVENC when the NVIDIA driver is there; a small library of Zazabor's own stickers and
sounds). Round 3 built them.

1. **Where it lives:** a "Studio" section with Photo and Video on its own inner rail
   (recommended); its own rail section; or inside the Video player?
2. **Name:** Video Editor, Zazabor Cut, Studio Video, or another?
3. **The first version's target:** short vertical reels (9:16, under 3 minutes, captions and
   music first), or longer YouTube-style edits (16:9, many clips, chapters)? The milestones order
   changes with it.
4. **Captions models:** OK to download `base` (142 MiB) on first use, and `small` (466 MiB) for
   Bangla? Is Bangla captioning important?
5. **Codecs:** may Zazabor offer to install `gstreamer1.0-plugins-ugly` and `gstreamer1.0-libav`
   (x264, AAC and more decoders) with one click, or only explain what's missing?
6. **NVIDIA:** do you use the NVIDIA GPU on this laptop? If so, NVENC export through the nvcodec
   plugin is worth adding; today its driver isn't loaded.
7. **Stickers, sounds and templates:** Zazabor has no content library like CapCut's. Should it
   ship a small set of its own (as with the five soundtracks), or only use the user's files?
8. **GES as plan B:** if the own compositor's export is too slow even natively, is building on GES
   (Pitivi's engine) acceptable, with fewer custom transitions at first?
