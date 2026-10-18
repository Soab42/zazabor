import { clamp, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import type { PlaybackState } from "./api";

const MAX = 1.25;

/** The mute button and the cone-shaped level meter (drag or scroll, 0–125%) with its percentage. */
export class VolumeControl {
  readonly el: HTMLElement;
  private readonly button = h("button", { class: "icon-btn vc-btn", type: "button", title: "Mute (M)", "aria-label": "Mute" });
  private readonly fill = h("div", { class: "vc-vol-fill" });
  private readonly cone = h("div", { class: "vc-vol-cone" }, this.fill);
  private readonly level = h("span", { class: "vc-vol-level" }, "100%");
  private readonly meter = h("div", { class: "vc-vol", role: "slider", "aria-label": "Volume", "aria-valuemin": 0, "aria-valuemax": 125 },
    this.cone, h("span", { class: "vc-vol-100", "aria-hidden": "true" }));
  private dragging = false;
  private iconName = "";
  private volume = 1;

  constructor(private readonly hooks: { setVolume(v: number): void; toggleMute(): void }) {
    this.el = h("div", { class: "vc-volume" }, this.button, this.meter, this.level);
    this.button.addEventListener("click", () => hooks.toggleMute());
    this.meter.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.el.classList.add("dragging");
      this.meter.setPointerCapture(e.pointerId);
      this.set(e);
    });
    this.meter.addEventListener("pointermove", (e) => {
      if (this.dragging) this.set(e);
    });
    const end = () => {
      this.dragging = false;
      this.el.classList.remove("dragging");
    };
    this.meter.addEventListener("pointerup", end);
    this.meter.addEventListener("pointercancel", end);
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
    this.meter.style.setProperty("--v", `${(shown / MAX) * 100}%`);
    this.meter.style.setProperty("--full", `${(1 / MAX) * 100}%`);
    this.el.classList.toggle("muted", state.muted || state.volume === 0);
    this.el.classList.toggle("boost", !state.muted && state.volume > 1.001);
    const percent = Math.round(state.volume * 100);
    this.level.textContent = state.muted ? "Muted" : `${percent}%`;
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
