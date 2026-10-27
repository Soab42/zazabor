import type { GuideArticle } from "../types";

export const gallery: GuideArticle = {
  id: "gallery",
  title: "Gallery",
  icon: "image",
  group: "media",
  summary: "Your photos, found on their own and shown as albums, with a deep-zoom viewer.",
  open: { module: "gallery", label: "Open Gallery" },
  topics: [
    {
      title: "Your albums",
      steps: [
        "The first time, the Gallery scans your home folder and connected drives for photos (it skips hidden folders, app data and tiny icons). Next time the albums appear at once.",
        "Click an album to see its photos, or **All photos** to see everything.",
        "Use **Sort** for newest first or by name, and the **Thumbnail size** slider for bigger or smaller pictures.",
        "Press {Ctrl+F} to search albums.",
      ],
      tips: [
        "Missing a folder? Use **Add a folder to your library**, or drop a folder on the window.",
        "Right-click an album to **Add to favorites** or **Hide this album**. Hidden albums only show again with **Show this album again**; with the privacy lock on they're private.",
        "**Select albums…** favours or hides several at once.",
      ],
    },
    {
      title: "The viewer",
      steps: [
        "Double-click a photo, or select it and press {Enter}.",
        "Move between photos with {←} and {→}, or {Home} and {End} for the first and last.",
        "Zoom with the mouse wheel, {↑}/{↓} or {+}/{-}; press {0} to fit and {1} for 100% (up to {8} for 12,800%). Drag to pan.",
        "Press {I} for the info panel (histogram, camera, lens, exposure, place), {R} to rotate, {H} to hide the filmstrip and {F} for fullscreen.",
        "Press {E} to edit the photo: see [[quick-edit|Quick Edit]].",
        "Press {Esc} to go back to the album.",
      ],
      keys: [
        ["← or →", "Previous or next photo"],
        ["+ or -", "Zoom in or out (hold to glide)"],
        ["0", "Fit the photo"],
        ["1", "100% (2 → 200% … 8 → 12,800%)"],
        ["R", "Rotate (Shift+R the other way)"],
        ["I", "Info panel"],
        ["F", "Fullscreen"],
        ["S or F5", "Slideshow from here"],
        ["E", "Quick Edit"],
      ],
    },
  ],
  related: ["quick-edit", "slideshows", "photo"],
};

export const quickEdit: GuideArticle = {
  id: "quick-edit",
  title: "Quick Edit",
  icon: "phLight",
  group: "media",
  summary: "Crop, straighten, brighten and filter a photo right in the viewer, then save a copy.",
  open: { module: "gallery", label: "Open Gallery" },
  topics: [
    {
      title: "Edit a photo",
      steps: [
        "Open a photo in the Gallery viewer and press {E} (or the **Edit** button).",
        "Press **Auto** to balance exposure, contrast and colour in one go.",
        "Open **Crop & rotate** (or press {C}) to crop with a ratio (**Free**, **Original**, **Square**, 4:5, 3:2, 16:9, 9:16), straighten, rotate or flip. Press {Enter} when the crop is right.",
        "Use the **Light** and **Colour** sliders, pick a look under **Filters** (with its **Strength**), and add a vignette under **Effects**.",
        "Hold {\\} or the compare button to see the original.",
      ],
      keys: [
        ["C", "Crop & rotate"],
        ["\\", "Hold to compare with the original"],
        ["Ctrl+Z", "Undo"],
        ["Ctrl+Shift+Z", "Redo"],
        ["Ctrl+S", "Save a copy"],
        ["Esc", "Close without saving"],
      ],
    },
    {
      title: "Save it",
      steps: [
        "Press **Save a copy** ({Ctrl+S}). It writes IMG_1234 (edited).jpg next to the original and shows it.",
        "To replace the photo itself, open the arrow beside it and choose **Save over original…**; Zazabor asks first.",
        "Choose **Open in Photo** to keep working in Studio's Photo editor: your edits arrive as an adjustment layer.",
      ],
      tips: ["The colour profile and camera details are kept; the orientation is set upright."],
    },
  ],
  related: ["gallery", "photo"],
};

export const slideshows: GuideArticle = {
  id: "slideshows",
  title: "Slideshows",
  icon: "film",
  group: "media",
  summary: "Cinematic slideshows with themes, transitions, camera moves and music.",
  open: { module: "gallery", label: "Open Gallery" },
  topics: [
    {
      title: "Start a slideshow",
      steps: [
        "In an album, press **Play slideshow** ({F5}). In the viewer, press {S}.",
        "In the setup, pick a **Style**: Cinematic, Modern, Action, Neon, Adventure, Travel, Dreamy, Elegant, Memories, Playful or Noir, or Custom.",
        "Choose the **Transition** (50 of them, each with a live preview), the **Music** (five built-in tracks or your own), and whether to show **Captions**, use **Ken Burns** motion, **Loop** or **Shuffle**.",
        "Press **Play**.",
      ],
      keys: [
        ["Space or K", "Pause or play"],
        ["← or →", "Previous or next photo"],
        ["M", "Mute the music"],
        ["S", "Slideshow settings"],
        ["C", "Captions on or off"],
        ["Esc", "End the slideshow"],
      ],
      tips: [
        "Landscape photos fill the screen with a gentle camera move; portraits float over a blurred backdrop.",
        "The screen doesn't dim or lock while a slideshow runs.",
      ],
    },
    {
      title: "Make a video from photos",
      steps: [
        "In the slideshow setup, choose a style and music, then press **Make a Video**.",
        "The photos open as a reel in Studio's Video Editor, ready to trim and export.",
      ],
    },
  ],
  related: ["gallery", "video-editor"],
};
