import { clamp, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import type { PlaybackState } from "./api";

const MAX = 1.25;

/** The mute button and the wedge-shaped ramp meter (drag or scroll, 0–125%). */
export class VolumeControl {
  readonly el: HTMLElement;
  private readonly button = h("button", { class: "icon-btn vc-btn", type: "button", title: "Mute (M)", "aria-label": "Mute" });
  private readonly fill = h("div", { class: "vc-vol-fill" });
  private readonly meter = h("div", { class: "vc-vol", role: "slider", "aria-label": "Volume", "aria-valuemin": 0, "aria-valuemax": 125 },
    h("div", { class: "vc-vol-wedge" }, this.fill));
  private dragging = false;
  private iconName = "";
  private volume = 1;

  constructor(private readonly hooks: { setVolume(v: number): void; toggleMute(): void }) {
    this.el = h("div", { class: "vc-volume" }, this.button, this.meter);
    this.button.addEventListener("click", () => hooks.toggleMute());
    this.meter.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.meter.setPointerCapture(e.pointerId);
      this.set(e);
    });
    this.meter.addEventListener("pointermove", (e) => {
      if (this.dragging) this.set(e);
    });
    this.meter.addEventListener("pointerup", () => (this.dragging = false));
    this.meter.addEventListener("pointercancel", () => (this.dragging = false));
    this.meter.addEventListener("wheel", (e) => {
      e.preventDefault();
      hooks.setVolume(Math.round((this.volume - Math.sign(e.deltaY) * 0.05) * 100) / 100);
    }, { passive: false });
  }

  private set(e: PointerEvent) {
    const rect = this.meter.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    // Snap the ends so 0 and 100% are easy to hit.
    const v = frac < 0.03 ? 0 : Math.abs(frac * MAX - 1) < 0.025 ? 1 : frac * MAX;
    this.hooks.setVolume(v);
  }

  update(state: PlaybackState) {
    this.volume = state.volume;
    const shown = state.muted ? 0 : state.volume;
    this.fill.style.setProperty("--v", `${(shown / MAX) * 100}%`);
    const percent = Math.round(state.volume * 100);
    this.meter.title = `Volume ${percent}%`;
    this.meter.setAttribute("aria-valuenow", String(percent));
    const name = state.muted || state.volume === 0 ? "mute" : "volume";
    if (name !== this.iconName) {
      this.iconName = name;
      this.button.replaceChildren(icon(name, 18));
    }
    this.button.title = state.muted ? "Unmute (M)" : "Mute (M)";
  }
}
