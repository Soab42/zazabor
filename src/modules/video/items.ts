import { icon, type IconName } from "../../ui/icons";

/** One thing that can sit in the control bar; the Customise Player sheet lists these. */
export interface ControlDef {
  label: string;
  icon: (size: number) => SVGSVGElement;
  /** May appear more than once in the bar. */
  repeatable?: boolean;
}

/** Local line icons for the few controls the shared set doesn't have (same grid and stroke). */
function svg(inner: string, size: number): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}

const shared = (name: IconName) => (size: number) => icon(name, size);

const SKIP_BACK_ARC = `<path d="M5 12a7 7 0 1 0 2.1-5"/><path d="M4.5 4v3.5H8"/>`;
const SKIP_FORWARD_ARC = `<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19.5 4v3.5H16"/>`;
const BOOKMARK = `<path d="M7 4.5h10a1 1 0 0 1 1 1v14l-6-4-6 4v-14a1 1 0 0 1 1-1z"/>`;
const DIGITS_15 = `<path d="M9.5 10v5M14.4 10h-2.4v2.3h1.2a1.35 1.35 0 0 1 0 2.7H11.9"/>`;

export const CONTROL_DEFS: Record<string, ControlDef> = {
  previous: { label: "Previous", icon: shared("prev") },
  play: { label: "Play / Pause", icon: shared("play") },
  next: { label: "Next", icon: shared("next") },
  seek: { label: "Seek Bar", icon: (size) => svg(`<path d="M3.5 12h17"/><circle cx="9" cy="12" r="2.4" fill="currentColor"/>`, size) },
  volume: { label: "Volume", icon: shared("volume") },
  audio: { label: "Audio Tracks", icon: shared("audioTrack") },
  subtitles: { label: "Subtitles", icon: shared("subtitles") },
  settings: { label: "Side Panel", icon: shared("settings") },
  playlist: { label: "Queue", icon: shared("playlist") },
  bookmark: { label: "Add Bookmark", icon: (size) => svg(BOOKMARK, size) },
  spacer: { label: "Spacer", icon: (size) => svg(`<rect x="5" y="5" width="14" height="14" rx="2" stroke-dasharray="2.5 3"/>`, size), repeatable: true },
  divider: { label: "Divider", icon: (size) => svg(`<path d="M12 4.5v15"/>`, size), repeatable: true },
  skipBack10: { label: "Back 10s", icon: shared("skipBack10") },
  skipForward10: { label: "Forward 10s", icon: shared("skipForward10") },
  skipBack15: { label: "Back 15s", icon: (size) => svg(SKIP_BACK_ARC + DIGITS_15, size) },
  skipForward15: { label: "Forward 15s", icon: (size) => svg(SKIP_FORWARD_ARC + DIGITS_15, size) },
  stop: { label: "Stop", icon: (size) => svg(`<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>`, size) },
  repeat: { label: "Repeat", icon: (size) => svg(`<path d="M4.5 11V9.5a3 3 0 0 1 3-3h11M15.5 3.5l3 3-3 3M19.5 13v1.5a3 3 0 0 1-3 3h-11M8.5 20.5l-3-3 3-3"/>`, size) },
  shuffle: { label: "Shuffle", icon: shared("shuffle") },
  speed: { label: "Playback Speed", icon: shared("speed") },
  filename: { label: "File Name", icon: shared("film") },
  folder: { label: "Folder Name", icon: shared("folder") },
  fullscreen: { label: "Fullscreen", icon: shared("fullscreen") },
};

/** The order items appear in the Customise Player grid. */
export const PALETTE_ORDER = [
  "spacer", "divider", "speed", "skipForward10", "skipBack10", "skipForward15", "skipBack15", "stop", "repeat", "shuffle",
  "previous", "play", "next", "seek", "volume", "audio", "subtitles", "bookmark", "settings", "playlist", "filename", "folder", "fullscreen",
];

/** Drops unknown ids and repeats of items that may only appear once. */
export function sanitizeControls(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const def = CONTROL_DEFS[id];
    if (!def) return false;
    if (!def.repeatable && seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The bar as in the Figma frame: transport, the seek bar, volume, then tracks, queue, side panel and fullscreen. */
export const REDESIGN_CONTROLS = ["previous", "play", "next", "seek", "volume", "audio", "subtitles", "playlist", "settings", "fullscreen"];

/** Earlier stock bars; a saved bar that equals one of them gets the current one. */
const OLD_DEFAULT_CONTROLS = [
  ["previous", "play", "next", "seek", "volume", "audio", "subtitles", "settings", "playlist"],
  // The two-row bar (seek bar along the bottom edge) had volume before it.
  ["previous", "play", "next", "volume", "seek", "audio", "subtitles", "playlist", "settings", "fullscreen"],
];

/** The bar to show for a saved list: an old stock layout is upgraded, custom layouts are kept. */
export function effectiveControls(saved: string[]): string[] {
  const stock = OLD_DEFAULT_CONTROLS.some((old) => saved.length === old.length && saved.every((id, i) => id === old[i]));
  return stock ? REDESIGN_CONTROLS : saved;
}

/** Items that sit at the right end of the bar; the first one present pushes the group right. */
export const RIGHT_GROUP = new Set(["speed", "audio", "subtitles", "bookmark", "playlist", "settings", "fullscreen"]);
