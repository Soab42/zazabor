import type { GuideArticle } from "../types";

export const videoEditor: GuideArticle = {
  id: "video-editor",
  title: "Video Editor",
  icon: "videoEdit",
  group: "studio",
  summary: "A CapCut-style editor for reels and videos: clips, text, music, stickers, captions, keyframes and effects.",
  open: { module: "studio", target: "video", label: "Open Video Editor" },
  needs: "Auto captions download a speech model once, after asking (English: base; Bangla: small). Some formats need codec packages: **Install codecs…** in the export window or **Settings → Video Editor** installs them with your system password.",
  topics: [
    {
      title: "Start a reel",
      steps: [
        "In Studio's Home, choose **Reel** (9:16) or **Video** (16:9). Square and 4:5 are there too.",
        "In the **Media** tab, press **Import Media** and pick clips and pictures, then drag them onto the timeline (or **Add to the timeline**).",
        "Press {Space} to play the preview. Click the ruler or press {←}/{→} to move the playhead a frame ({Shift} for a second).",
      ],
    },
    {
      title: "Edit on the timeline",
      steps: [
        "The main track is magnetic: clips sit end to end. Overlays, texts, stickers and sounds go on tracks above and below.",
        "Drag a clip to move it, or drag its edges to trim. **Snap to edges** ({N}) lines things up.",
        "Press {S} (or {Ctrl+B}) to split at the playhead. {Q} and {W} trim the start or end to the playhead.",
        "Press {Delete} to remove a clip (the main track closes the gap; {Shift+Delete} closes gaps elsewhere). {Ctrl+D} duplicates.",
        "Right-click a clip for its actions: split, trim, cut, copy, paste, duplicate, transitions, speed, reverse, freeze frame, select all on its layer and delete. Right-click empty space on a track to paste there, select the layer's clips, or mute or hide the track. The preview has the same menu for the layer under the pointer.",
        "{Ctrl+A} selects every clip on the layer of the selection (the main track when nothing is selected); press it again for every layer. {Shift}-click or {Ctrl}-click adds clips. Selected clips are dragged, deleted, copied and duplicated together.",
        "{Ctrl+C}, {Ctrl+X} and {Ctrl+V} copy, cut and paste clips at the playhead, also into another project.",
        "Zoom the timeline with {+}/{-} or {Ctrl} and the mouse wheel.",
      ],
      keys: [
        ["Space", "Play or pause (K pauses, L plays, J jumps back 5 s)"],
        ["S or Ctrl+B", "Split at the playhead"],
        ["Q or W", "Trim the start or end to the playhead"],
        ["Delete", "Remove (Shift+Delete closes the gap)"],
        ["Ctrl+D", "Duplicate"],
        ["Ctrl+A", "Select all on the layer (again: every layer)"],
        ["Ctrl+C or Ctrl+X", "Copy or cut the selected clips"],
        ["Ctrl+V", "Paste at the playhead"],
        ["N", "Snap on or off"],
        ["R", "Record a voice-over"],
        ["Ctrl+Z", "Undo (Ctrl+Shift+Z redo)"],
        ["Ctrl+E", "Export"],
      ],
    },
    {
      title: "Text, stickers, music and captions",
      steps: [
        "**Text**: pick a style, then type its words. To change them later, double-click the text on the preview (or on the timeline, or choose **Edit Text** from its right-click menu): a box opens on the video to type in, and {Esc} closes it. A template's texts open in the inspector's **Content** section. The inspector sets the font, colours, outline, box and an animation (fade, pop, slide, typewriter, bounce…).",
        "**Stickers**: arrows, callouts, badges, **Subscribe**, **SALE tag** and more, with their own animations.",
        "**Audio**: **Import Music**, Zazabor's own soundtracks and sound effects, and **Mark beats** to line cuts up with the music. Press ▶ beside a soundtrack, a sound or your music to listen before adding it; one plays at a time, and it stops when the editor plays. In the Import Music window, select a sound and press **Listen** (or {Space}).",
        "**Voice-over**: press {R} to record from the microphone at the playhead; press {R} again to stop. Music set to **Lower under voice-overs** dips while you speak.",
        "**Captions**: choose the language and press **Generate captions** for word-by-word captions you can style, or **Import .srt…** / **Export .srt…**.",
      ],
      tips: ["Captions run on this computer; your videos never leave it. Bangla captions use the bigger model and still need a check."],
    },
    {
      title: "Look and motion",
      steps: [
        "Select a clip; the inspector on the right shows its **Picture**, **Position**, **Filter and adjust**, **Effects**, **Mask**, **Chroma key**, **Speed** and **Sound** settings.",
        "Press ◆ beside position, scale, rotation, opacity or volume to add a keyframe at the playhead; move the playhead and change the value for another. Zazabor animates between them.",
        "**Chroma key** removes a green or blue background. **Colour table** loads a .cube LUT.",
        "**Speed** changes the pace (with presets like Montage and Hero), plays in **Reverse**, or adds a **Freeze frame** at the playhead.",
        "**Transitions**: pick one of the slideshow's 50 for a cut on the main track. Select an overlay, a text, a sticker or a template to give it an **In** and an **Out** (dissolve, wipe, iris, slide, push, zoom, spin, flip, glitch and more); when two clips on an overlay track touch, **Between** plays across the cut between them (click the mark at the cut). The inspector has the same choices. **Filters** apply a look to one clip or all.",
      ],
    },
    {
      title: "Export",
      steps: [
        "Press **Export** ({Ctrl+E}). Choose **MP4 · H.264** or **WebM · VP9**, the resolution (720p or 1080p), frame rate and quality.",
        "Pick where to save; a progress bar shows the speed and time left, with **Cancel**.",
        "Save the project itself with {Ctrl+S} as a .corevideo file, to keep editing later.",
      ],
      tips: [
        "Without the extra codec packages, MP4 sound is MP3; with them, MP4s get AAC sound and x264. **Install codecs…** explains what it adds before installing.",
        "Heavy reels can export slower than real time.",
        "Moved a clip on disk? When you open the project, Zazabor looks for missing files and lets you **Search a Folder**.",
      ],
    },
  ],
  related: ["studio", "slideshows", "video-player"],
};
