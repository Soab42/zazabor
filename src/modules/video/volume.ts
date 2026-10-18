import { clamp, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { MAX_VOLUME as MAX, type PlaybackState } from "./api";

/** Wheel movement that makes one volume step: a mouse notch, or a touchpad's small deltas added up. */
const WHEEL_STEP = 40;

/**
 * A wheel handler that calls `onStep(up)` once per mouse notch, and once per WHEEL_STEP of
 * touchpad scrolling, so neither races through the range.
 */
export function wheelStepper(onStep: (up: boolean) => void): (e: WheelEvent) => void {
  let pending = 0;
  return (e) => {
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    if (delta === 0) return;
    if (Math.sign(delta) !== Math.sign(pending)) pending = 0;
    pending = Math.abs(delta) >= WHEEL_STEP ? WHEEL_STEP * Math.sign(delta) : pending + delta;
    if (Math.abs(pending) < WHEEL_STEP) return;
    pending = 0;
    onStep(delta < 0);
  };
}

/** The mute button and the cone-shaped level meter (drag or scroll, 0–200%) with its percentage. */
export class VolumeControl {
  readonly el: HTMLElement;
  private readonly button = h("button", { class: "icon-btn vc-btn", type: "button", title: "Mute (M)", "aria-label": "Mute" });
  private readonly fill = h("div", { class: "vc-vol-fill" });
  private readonly cone = h("div", { class: "vc-vol-cone" }, this.fill);
  private readonly level = h("span", { class: "vc-vol-level" }, "100%");
  private readonly meter = h("div", { class: "vc-vol", role: "slider", "aria-label": "Volume", "aria-valuemin": 0, "aria-valuemax": MAX * 100 },
    this.cone, h("span", { class: "vc-vol-100", "aria-hidden": "true" }));
  private dragging = false;
  private iconName = "";

  constructor(private readonly hooks: { setVolume(v: number): void; toggleMute(): void; nudge(up: boolean): void }) {
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
    // Scrolling anywhere on the control (icon, cone or percentage) steps the volume.
    this.el.addEventListener("wheel", wheelStepper((up) => hooks.nudge(up)), { passive: false });
  }

  private set(e: PointerEvent) {
    const rect = this.meter.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    // Snap the ends so 0 and 100% are easy to hit.
    const v = frac < 0.03 ? 0 : Math.abs(frac * MAX - 1) < 0.025 ? 1 : frac * MAX;
    this.hooks.setVolume(v);
  }

  update(state: PlaybackState) {
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
