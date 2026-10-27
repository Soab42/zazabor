import type { GuideArticle } from "../types";

export const videoPlayer: GuideArticle = {
  id: "video-player",
  title: "Video player",
  icon: "video",
  group: "media",
  summary: "A VLC-powered player with a library, subtitles, streams and macOS-style Liquid Glass controls.",
  open: { module: "video", label: "Open Video" },
  extra: "playerShortcuts",
  topics: [
    {
      title: "Play something",
      steps: [
        "Double-click a video in Files, or press {Ctrl+O} in Video and pick one.",
        "Or browse the library on the left: **Home** (with Continue watching), **Videos**, **Music**, **Network Streams**, **Playlists** and **Recent**.",
        "The **…** menu at the top has **Open File…**, **Open Folder…**, **Add Subtitles…** and **Customise Player…**.",
        "A video you stopped halfway offers to continue where you left off.",
      ],
    },
    {
      title: "Liquid Glass controls",
      steps: [
        "The controls float over the picture as glass that bends and blurs the video beneath, as on macOS.",
        "While a video plays, they fade away when the mouse rests; move the mouse to bring them back. While paused they stay.",
        "Drag the seek bar's bead to jump; it turns into a clear lens while you drag.",
        "Prefer a plain bar below the picture? Turn off **Settings → Video → Interface → Liquid Glass controls**.",
      ],
    },
    {
      title: "Subtitles, sound and picture",
      steps: [
        "Use the subtitle and audio buttons on the bar to pick a track (and the sound output).",
        "Open the side panel for the **Subtitles**, **Audio**, **Video**, **Playback** and **Bookmarks** tabs: subtitle timing and style, audio delay and the equalizer, picture filters, zoom and aspect ratio, speed and the sleep timer.",
        "**Add Subtitles…** matches subtitle files to a file, a folder or the whole queue.",
      ],
    },
    {
      title: "Keys",
      keys: [
        ["Space or K", "Play or pause"],
        ["← or →", "Jump back or forward (Shift for a longer jump)"],
        ["↑ or ↓", "Volume"],
        ["M", "Mute"],
        ["F", "Fullscreen (or double-click the picture)"],
        ["N or P", "Next or previous in the queue"],
        ["[ or ]", "Slower or faster"],
        ["G or H", "Subtitles earlier or later"],
        ["Ctrl+B", "Bookmark this moment"],
        ["Ctrl+H", "Hide or show the controls"],
        ["Ctrl+M", "Mini player"],
        ["?", "All the player's shortcuts"],
      ],
      tips: ["The jump and volume steps can be changed in **Settings → Video → Playback**."],
    },
    {
      title: "More",
      tips: [
        "**Customise Player…** lets you drag buttons into and out of the control bar.",
        "Network Streams takes a stream address or an M3U playlist of channels.",
        "The screen doesn't dim, blank or lock while a video plays.",
      ],
    },
  ],
  related: ["files", "settings", "video-editor"],
};
