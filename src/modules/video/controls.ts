import { basename, dirname, h, stripExtension } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import type { PlaybackState } from "./api";
import { formatRate } from "./format";
import { CONTROL_DEFS, RIGHT_GROUP, sanitizeControls } from "./items";
import type { Player } from "./player";
import { quickApi, quickHooks } from "./quick-api";
import { Seekbar } from "./seekbar";
import { VolumeControl } from "./volume";

/** What the control bar needs from the module around it. */
export interface ControlHost {
  player: Player;
  sidebarOpen(): boolean;
  toggleSidebar(): void;
  panelOpen(): boolean;
  togglePanel(): void;
  toggleFullscreen(): void;
  addSubtitleFile(): void;
  /** One volume step (the step from Settings), with an on-screen message. */
  nudgeVolume(up: boolean): void;
}

interface Built {
  el: HTMLElement;
  update?: (state: PlaybackState) => void;
  dispose?: () => void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Opens one of the player's menus. Its icons are two-tone (grey with accent details), the
 * redesign's look for non-interactive menu icons.
 */
export function openPlayerMenu(x: number, y: number, items: MenuItem[]) {
  openMenu(x, y, items);
  const menu = document.body.lastElementChild;
  if (!menu?.classList.contains("menu")) return;
  menu.classList.add("vp-menu");
  const buttons = menu.querySelectorAll(".menu-item");
  let index = 0;
  for (const item of items) {
    if (item === "separator") continue;
    if (item.action === HEADING) buttons[index]?.classList.add("vp-menu-heading");
    index++;
  }
}

/** The action of a menu heading (a disabled label that names the group below it). */
export const HEADING = () => undefined;

/** The glass control bar: one row, the seek bar between transport and the track buttons. Built from the configured item ids. */
export class ControlBar {
  readonly el = h("footer", { class: "vp-bar" });
  private built: Built[] = [];
  private ids: string[] = [];
  private editing = false;

  constructor(private readonly host: ControlHost) {}

  /**
   * Rebuilds the bar. While `editing`, every item sits in a dashed slot and does nothing; otherwise
   * the seek bar takes the free width, and without one the first item of the right-hand group
   * (tracks, queue, panel, fullscreen) pushes the rest to the right.
   */
  render(ids: string[], editing = false) {
    for (const item of this.built) item.dispose?.();
    this.ids = sanitizeControls(ids);
    this.editing = editing;
    this.built = this.ids.map((id) => this.build(id));
    this.el.classList.toggle("editing", editing);
    let pushed = false;
    this.el.replaceChildren(...this.built.map((b, i) => {
      const id = this.ids[i];
      if (editing) return h("div", { class: `vc-slot${id === "seek" ? " grow" : ""}`, "data-index": i, "data-id": id, title: CONTROL_DEFS[id].label }, b.el);
      if (!pushed && RIGHT_GROUP.has(id)) {
        pushed = true;
        b.el.classList.add("vc-right");
      }
      return b.el;
    }));
    this.update();
  }

  /** The slots shown while editing, in order. */
  slots(): HTMLElement[] {
    return [...this.el.querySelectorAll<HTMLElement>(".vc-slot")];
  }

  /** Refreshes every item from the player's current state. */
  update() {
    const { player } = this.host;
    this.el.classList.toggle("vp-bar-empty", !player.current && !this.editing);
    for (const item of this.built) item.update?.(player.state);
  }

  // ---- items -------------------------------------------------------------------------------

  private iconButton(id: string, title: string, onClick: () => void, size = 18): HTMLButtonElement {
    const def = CONTROL_DEFS[id];
    const button = h("button", { class: `icon-btn vc-btn vc-${id}`, type: "button", title, "aria-label": def.label });
    button.append(def.icon(size));
    button.addEventListener("click", onClick);
    return button;
  }

  private build(id: string): Built {
    const { player } = this.host;
    switch (id) {
      case "previous":
        return { el: this.iconButton(id, "Previous (P)", () => player.previous(), 22) };
      case "next":
        return { el: this.iconButton(id, "Next (N)", () => player.next(), 22) };
      case "play": {
        const button = h("button", { class: "vc-play", type: "button", "aria-label": "Play" });
        button.addEventListener("click", () => player.togglePlay());
        let shown = "";
        return {
          el: button,
          update: (s) => {
            const name: IconName = s.playing ? "pause" : "play";
            if (name !== shown) {
              shown = name;
              button.replaceChildren(icon(name, 22));
              button.title = s.playing ? "Pause (Space)" : "Play (Space)";
              button.setAttribute("aria-label", s.playing ? "Pause" : "Play");
            }
          },
        };
      }
      case "seek": {
        const seekbar = new Seekbar((time) => player.seekTo(time));
        return { el: seekbar.el, update: (s) => seekbar.update(s), dispose: () => seekbar.dispose() };
      }
      case "volume": {
        const volume = new VolumeControl({ setVolume: (v) => player.setVolume(v), toggleMute: () => player.toggleMute(), nudge: (up) => this.host.nudgeVolume(up) });
        return { el: volume.el, update: (s) => volume.update(s) };
      }
      case "audio": {
        const button = this.iconButton(id, "Audio tracks and output", () => void this.audioPopup(button));
        return { el: button };
      }
      case "subtitles": {
        const button = this.iconButton(id, "Subtitles", () => this.popup(button, this.subtitleMenu()));
        return { el: button, update: (s) => button.classList.toggle("active", quickHooks.subtitlesShown?.() ?? s.subtitleTrack >= 0) };
      }
      case "settings": {
        // The side panel (Subtitles, Audio, Video, Playback, Bookmarks…); features supply its tabs.
        const button = this.iconButton(id, "Side panel", () => {
          this.host.togglePanel();
          this.update();
        });
        return { el: button, update: () => button.classList.toggle("active", this.host.panelOpen()) };
      }
      case "bookmark": {
        const button = this.iconButton(id, "Add bookmark (Ctrl+B)", () => quickHooks.addBookmark?.());
        return { el: button, update: (s) => (button.disabled = s.path === null) };
      }
      case "speed": {
        const button = h("button", { class: "text-btn vc-speed", type: "button", title: "Playback speed ([ and ])" }, "1×");
        button.addEventListener("click", () => this.popup(button, this.speedItems()));
        return { el: button, update: (s) => (button.textContent = formatRate(s.rate)) };
      }
      case "playlist": {
        const button = this.iconButton(id, "Queue", () => {
          this.host.toggleSidebar();
          this.update();
        });
        return { el: button, update: () => button.classList.toggle("active", this.host.sidebarOpen()) };
      }
      case "skipBack10": return { el: this.iconButton(id, "Back 10 s", () => player.seekBy(-10_000), 20) };
      case "skipForward10": return { el: this.iconButton(id, "Forward 10 s", () => player.seekBy(10_000), 20) };
      case "skipBack15": return { el: this.iconButton(id, "Back 15 s", () => player.seekBy(-15_000), 20) };
      case "skipForward15": return { el: this.iconButton(id, "Forward 15 s", () => player.seekBy(15_000), 20) };
      case "stop": return { el: this.iconButton(id, "Stop", () => void player.stop()) };
      case "repeat": {
        const button = this.iconButton(id, "Repeat: off", () => player.cycleRepeat());
        return {
          el: button,
          update: () => {
            button.classList.toggle("active", player.repeat !== "off");
            button.dataset.badge = player.repeat === "one" ? "1" : "";
            button.title = `Repeat: ${player.repeat === "off" ? "off" : player.repeat === "all" ? "all" : "this video"}`;
          },
        };
      }
      case "shuffle": {
        const button = this.iconButton(id, "Shuffle", () => player.toggleShuffle());
        return { el: button, update: () => button.classList.toggle("active", player.shuffle) };
      }
      case "fullscreen": return { el: this.iconButton(id, "Fullscreen (F)", () => this.host.toggleFullscreen()) };
      case "filename": {
        const label = h("span", { class: "vc-label" });
        return {
          el: label,
          update: () => {
            const name = player.current ? stripExtension(basename(player.current)) : "";
            label.textContent = name;
            label.title = name;
          },
        };
      }
      case "folder": {
        const text = h("span", null);
        const label = h("span", { class: "vc-label with-icon" }, icon("folder", 14), text);
        return {
          el: label,
          update: () => {
            const name = player.current ? basename(dirname(player.current)) : "";
            text.textContent = name;
            label.title = name;
          },
        };
      }
      case "spacer": return { el: h("div", { class: "vc-spacer" }) };
      case "divider": return { el: h("div", { class: "vc-divider" }) };
      default: return { el: h("span") };
    }
  }

  // ---- popovers ----------------------------------------------------------------------------

  /** Opens a menu above a bar button. */
  private popup(anchor: HTMLElement, items: MenuItem[]) {
    const rect = anchor.getBoundingClientRect();
    const height = items.reduce((sum, item) => sum + (item === "separator" ? 11 : 28), 10);
    openPlayerMenu(rect.left, rect.top - height - 8, items);
  }

  /** Audio tracks, then the output devices (fetched when the menu opens) with the current one marked. */
  private async audioPopup(anchor: HTMLElement) {
    const devices = await quickApi.audioDevices().catch(() => []);
    const items: MenuItem[] = [...this.audioMenu()];
    if (devices.length > 0) {
      items.push(
        "separator",
        { label: "Output device", icon: "volume", disabled: true, action: HEADING },
        ...devices.map((d): MenuItem => ({
          label: d.name,
          icon: d.current ? "check" : undefined,
          action: () => void quickApi.setAudioDevice(d.id).catch((err) => console.warn("Could not switch the audio device:", err)),
        })),
      );
    }
    this.popup(anchor, items);
  }

  private audioMenu(): MenuItem[] {
    const { player } = this.host;
    const { audioTracks, audioTrack } = player.state;
    const heading: MenuItem = { label: "Audio track", icon: "audioTrack", disabled: true, action: HEADING };
    if (audioTracks.length === 0) return [heading, { label: "No audio tracks", disabled: true, action: () => undefined }];
    return [
      heading,
      ...audioTracks.map((track): MenuItem => ({
        label: track.name,
        icon: track.id === audioTrack ? "check" : undefined,
        action: () => player.setAudioTrack(track.id),
      })),
    ];
  }

  private subtitleMenu(): MenuItem[] {
    const { player } = this.host;
    const { subtitleTracks, subtitleTrack } = player.state;
    // The subtitles feature knows what's on screen when it draws a track itself.
    const choices: MenuItem[] = quickHooks.subtitleItems?.() ?? [
      { label: "Off", icon: subtitleTrack < 0 ? "check" : undefined, action: () => player.setSubtitleTrack(-1) },
      ...subtitleTracks.map((track) => ({
        label: track.name,
        icon: track.id === subtitleTrack ? ("check" as const) : undefined,
        action: () => player.setSubtitleTrack(track.id),
      })),
    ];
    return [
      { label: "Subtitles", icon: "subtitles", disabled: true, action: HEADING },
      ...choices,
      "separator",
      // The "Add Subtitles…" dialog from the subtitles feature takes over through `quickHooks.addSubtitles`.
      { label: "Add Subtitles…", icon: "plus", action: () => (quickHooks.addSubtitles ?? (() => this.host.addSubtitleFile()))() },
    ];
  }

  private speedItems(): MenuItem[] {
    const { player } = this.host;
    return SPEEDS.map((rate) => ({
      label: formatRate(rate),
      icon: Math.abs(player.state.rate - rate) < 0.001 ? ("check" as const) : undefined,
      action: () => player.setRate(rate),
    }));
  }
}
