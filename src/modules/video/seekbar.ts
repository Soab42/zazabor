import { clamp, h } from "../../ui/dom";
import type { PlaybackState } from "./api";
import { formatTime } from "./format";

/** Elapsed time, the recessed seek track with its accent thumb, and the duration. */
export class Seekbar {
  readonly el: HTMLElement;
  private readonly elapsed = h("span", { class: "vc-time" }, "0:00");
  private readonly duration = h("span", { class: "vc-time" }, "0:00");
  private readonly played = h("div", { class: "vc-played" });
  private readonly thumb = h("div", { class: "vc-thumb" });
  private readonly tip = h("div", { class: "vc-tip", hidden: true }, "0:00");
  private readonly track = h("div", { class: "vc-track", role: "slider", "aria-label": "Seek", "aria-valuemin": 0 },
    this.played, this.thumb, this.tip);
  private length = 0;
  private dragging = false;

  constructor(private readonly seek: (time: number) => void) {
    this.el = h("div", { class: "vc-seek" }, this.elapsed, this.track, this.duration);
    this.track.addEventListener("pointerdown", (e) => this.down(e));
    this.track.addEventListener("pointermove", (e) => this.move(e));
    this.track.addEventListener("pointerup", (e) => this.up(e));
    this.track.addEventListener("pointercancel", () => {
      this.dragging = false;
      this.track.classList.remove("dragging");
    });
    this.track.addEventListener("pointerleave", () => {
      if (!this.dragging) this.tip.hidden = true;
    });
  }

  private fraction(e: PointerEvent) {
    const rect = this.track.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  }

  private show(frac: number) {
    this.track.style.setProperty("--p", String(frac));
    this.tip.hidden = this.length <= 0;
    this.tip.style.left = `${frac * 100}%`;
    this.tip.textContent = formatTime(frac * this.length);
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || this.length <= 0) return;
    this.dragging = true;
    this.track.classList.add("dragging");
    this.track.setPointerCapture(e.pointerId);
    this.elapsed.textContent = formatTime(this.fraction(e) * this.length);
    this.show(this.fraction(e));
  }

  private move(e: PointerEvent) {
    if (this.length <= 0) return;
    const frac = this.fraction(e);
    if (this.dragging) {
      this.show(frac);
      this.elapsed.textContent = formatTime(frac * this.length);
    } else {
      // Hovering: the tooltip follows the pointer, the playhead stays put.
      this.tip.hidden = false;
      this.tip.style.left = `${frac * 100}%`;
      this.tip.textContent = formatTime(frac * this.length);
    }
  }

  private up(e: PointerEvent) {
    if (!this.dragging) return;
    this.dragging = false;
    this.track.classList.remove("dragging");
    this.seek(this.fraction(e) * this.length);
  }

  /** Shows the playback position; ignored while the user is dragging the thumb. */
  update(state: PlaybackState) {
    this.length = state.length;
    this.duration.textContent = formatTime(state.length);
    this.track.setAttribute("aria-valuemax", String(Math.round(state.length / 1000)));
    this.track.classList.toggle("empty", state.length <= 0);
    if (this.dragging) return;
    this.elapsed.textContent = formatTime(state.time);
    this.track.style.setProperty("--p", String(state.length > 0 ? clamp(state.time / state.length, 0, 1) : 0));
    this.track.setAttribute("aria-valuenow", String(Math.round(state.time / 1000)));
  }
}
