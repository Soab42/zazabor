import type { ShellContext } from "../../shell/module";
import type { IconName } from "../../ui/icons";
import type { MenuItem } from "../../ui/menu";
import type { VideoSurface } from "./api";
import type { Player } from "./player";

/**
 * How video features plug into the Video module without editing it: a tab in the right side
 * panel, items in the menus, keys, and a layer over the video. Features are listed in
 * `features.ts`; each gets a `VideoContext` when the module is built.
 */

/** What a feature sees of the Video module. */
export interface VideoContext {
  readonly shell: ShellContext;
  /** Playback commands and state (`player.subscribe` for changes). */
  readonly player: Player;
  /** The WebGL canvas showing the video. */
  readonly surface: VideoSurface;
  /** A layer over the video, under the bars: subtitles, prompts, overlays. Click-through by default. */
  readonly stageLayer: HTMLElement;
  /** The player is showing (as opposed to a library page). */
  readonly showingPlayer: boolean;
  /** The window is in fullscreen. */
  readonly fullscreen: boolean;
  /** Plays a file; `queue` is the list to move through (defaults to its folder). */
  play(path: string, queue?: string[]): Promise<void>;
  /** A short message over the video; `shortcut` names the key that caused it (e.g. "↑"). */
  showOsd(text: string, shortcut?: string): void;
  /** Opens the right side panel, on a tab if given. */
  openPanel(tab?: string): void;
  closePanel(): void;
  /** Shows a library page or the player. */
  showPlayer(): void;
}

export interface PanelTab {
  id: string;
  title: string;
  icon: IconName;
  /** Lower comes first. */
  order: number;
  /** Builds the tab's content once, on first show. */
  render(): HTMLElement;
  /** The tab became visible / hidden (start or stop timers, refresh). */
  shown?(): void;
  hidden?(): void;
}

/**
 * Where menu items go: `top` = the player's single menu button, `stage` = right-click on the
 * video, `open` = the rail's "+" (open) menu.
 */
export type MenuPlace = "top" | "stage" | "open";

export interface VideoFeature {
  /** Tabs for the right side panel (Subtitles, Audio, Video, Playback, Bookmarks…). */
  panelTabs?: PanelTab[];
  /** Items for one of the menus; grouped with separators between features. */
  menuItems?(place: MenuPlace): MenuItem[];
  /** Keys before the module's own handling (never while typing in a field). Return true when handled. */
  handleKey?(e: KeyboardEvent): boolean;
  dispose?(): void;
}

export type FeatureFactory = (ctx: VideoContext) => VideoFeature;

/**
 * A feature's own settings, stored under `config.video.ext[id]` with defaults filled in. Mutate
 * the returned object and call `shell.saveConfig()`; unknown fields from newer versions are kept.
 */
export function featureSettings<T extends object>(shell: ShellContext, id: string, defaults: T): T {
  const store = shell.config.video.ext;
  const saved = store[id];
  const merged = { ...defaults, ...(saved && typeof saved === "object" ? saved : {}) } as T;
  store[id] = merged;
  return merged;
}
