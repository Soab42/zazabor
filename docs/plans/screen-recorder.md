# Screen recorder (state, 2026-10-27)

*Paused at the user's request; picked up later. Linux X11 only. Studio → Record, and
`zazabor --record` (Super+Shift+R by default) for a small recorder window. Backend
`src-tauri/src/recorder/` (no new dependencies), page `src/modules/studio/record/`.*

## What's built

- **What to record:** Full Screen (each monitor, plus "All screens"), A Window (follows it while
  it moves; listed without a window manager too), An Area (dragged on a still of the chosen
  monitor, Free/16:9/9:16/1:1). Monitors come from RandR 1.5 (`XRRGetMonitors`), named in words
  ("Laptop screen", "HDMI screen (HDMI-1)"), with a still on each button.
- **Sound:** system sound (the default output's monitor, or another output under More options),
  microphone with a level meter and a device list (PipeWire/PulseAudio sources with friendly
  names: built-in, USB, Bluetooth headset, Easy Effects), a hint for Bluetooth headsets (call
  quality, mono 16 kHz; headset mode is what makes the mic work). Mic mute from the bar.
- **Camera bubble:** round, in a chosen corner; cameras listed by name through GStreamer's
  device monitor and opened in their best mode (prefers 720p30 MJPEG).
- **Quality:** Standard 1080p30, Smooth 60 fps, Small 720p. MP4 (VA-API H.264, else x264;
  AAC if gst-libav is there, else MP3) or WebM (VP9 + Opus). MP4s are fragmented every second,
  so a crash leaves a playable file; leftovers show as Recovered with Keep.
- **Control bar:** floats on the recorded monitor: countdown, timer, Pause/Resume, mic mute,
  Stop, Discard (click twice). Can be hidden (then stop with the shortcut).
- **Review:** preview, trim strip with handles (cuts without re-encoding, starting on the first
  keyframe from the chosen start: at most 1 s later), Save / Save Trimmed, Open in Video Editor,
  Copy File, Show in Files, Delete. Recordings list with thumbnails and lengths.
- **Devices while recording:** a lost microphone or output is noted and the recording goes on
  without it (said afterwards: "The microphone was disconnected at 1:05…"); an unplugged
  recorded screen stops the recording and keeps the file. Screens and devices are listed again
  when they come and go while the page is open (`recorder-devices`).
- Settings → Modules → Screen Recorder: shortcut, folder, countdown, hide bar.

## Checked

- Unit tests (`cargo test --lib recorder`, 27): pipelines, monitor listing and labels,
  geometry → `ximagesrc` crop (second monitor, all screens), friendly device names, best camera
  mode, lost-device handling, keyframe detection, file names, free space, pause clock.
- Live test (`ZAZABOR_RECORDER_LIVE=:20 … live_recording_with_a_pause -- --ignored`), on a
  nested display with test tones and the test picture: 6 s with a 3 s pause → 6.07 s file, every
  frame decodes; a mic lost mid-way leaves the sound running; trim to 3.00 s starts on a keyframe.
- In the app on a nested display with two virtual monitors (`xrandr --setmonitor`): the picker
  shows both and All screens; 10 s of the right monitor with pause/resume → 960×1080, 10.85 s,
  706 KB, 324 frames all decode; the bar and countdown sat on that monitor. 1080p VA-API
  capture runs at 30 fps with about 21% CPU.
- Fixed on the way: Pause on the bar (icons redrawn under the click), compositor frame rate
  (files GStreamer couldn't decode with the camera on), black first/last frames, trim corrupting
  the file and deadlocking, bar window height.

## Untested or open

- **A crash (segfault) in the app** appeared once device listing could reach PipeWire.
  Two changes meant to fix it are in but **not yet run in the app**: one device monitor kept for
  the app's life, and one shared X connection. Check this first.
- Unplugging a monitor mid-recording (`xrandr --delmonitor`) wasn't seen through: the app had
  crashed. The in-app trim, Open in Video Editor and `zazabor --record` weren't rerun on the
  last build.
- Real hardware, never touched in tests: real mic, system sound, webcam, a Bluetooth headset in
  HFP mode, a real second monitor and hotplug (udev, RandR).
- A device that disappears under PipeWire may have its stream moved to the default device
  instead of failing; then nothing is reported.

## Left

- Wayland (portal + PipeWire screencast); today it says it needs X11.
- The bar is in full-screen recordings unless hidden; no "show clicks"; inline playback in the
  review (it opens the player); a separate monitor still for areas on "All screens".
- Decisions for the user: the default shortcut, the save folder (~/Videos/Recordings), recording
  into a hidden part file that's renamed on Stop.
