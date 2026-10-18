import { clamp, h } from "../../ui/dom";
import type { PlaybackState } from "./api";
import { sprites } from "./features/quick/sprites";
import { formatTime } from "./format";
import { seekMarks } from "./quick-api";

/**
 * Elapsed time, the seek track with its accent playhead, and the duration. Hovering or dragging
 * shows a preview card (nearest thumbnail, time, chapter); chapters and bookmarks are ticks.
 */
export class Seekbar {
  readonly el: HTMLElement;
  private readonly elapsed = h("span", { class: "vc-time" }, "0:00");
  private readonly duration = h("span", { class: "vc-time" }, "0:00");
  private readonly played = h("div", { class: "vc-played" });
  private readonly thumb = h("div", { class: "vc-thumb" });
  private readonly marks = h("div", { class: "vc-marks" });
  private readonly image = h("img", { class: "vc-tip-img", alt: "", draggable: false });
  private readonly timeLabel = h("span", { class: "vc-tip-time" }, "0:00");
  private readonly chapterLabel = h("span", { class: "vc-tip-chapter" });
  private readonly tip = h("div", { class: "vc-tip" }, this.image, h("div", { class: "vc-tip-text" }, this.timeLabel, this.chapterLabel));
  private readonly track = h("div", { class: "vc-track", role: "slider", "aria-label": "Seek", "aria-valuemin": 0 },
    this.marks, this.played, this.thumb);
  private length = 0;
  private dragging = false;
  private shownUrl = "";
  private readonly unsubscribe: () => void;

  constructor(private readonly seek: (time: number) => void) {
    this.el = h("div", { class: "vc-seek" }, this.elapsed, this.track, this.duration, this.tip);
    this.track.addEventListener("pointerdown", (e) => this.down(e));
    this.track.addEventListener("pointermove", (e) => this.move(e));
    this.track.addEventListener("pointerup", (e) => this.up(e));
    this.track.addEventListener("pointercancel", () => {
      this.dragging = false;
      this.track.classList.remove("dragging");
      this.hideTip();
    });
    this.track.addEventListener("pointerleave", () => {
      if (!this.dragging) this.hideTip();
    });
    this.unsubscribe = seekMarks.subscribe(() => this.renderMarks());
    this.renderMarks();
  }

  /** Stops following the marks (the bar was rebuilt). */
  dispose() {
    this.unsubscribe();
  }

  private fraction(e: PointerEvent) {
    const rect = this.track.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  }

  private renderMarks() {
    const length = this.length;
    this.marks.replaceChildren(...(length > 0 ? seekMarks.list : [])
      .filter((m) => m.time > 0 && m.time < length)
      .map((m) => h("span", { class: `vc-mark ${m.kind}`, style: { left: `${(m.time / length) * 100}%` } })));
  }

  /** The title of the chapter that contains `time`, if the file has chapters. */
  private chapterAt(time: number): string {
    let name = "";
    for (const m of seekMarks.list) if (m.kind === "chapter" && m.time <= time) name = m.label;
    return name;
  }

  /** Shows the preview card above the pointer for a fraction of the track. */
  private showTip(frac: number) {
    if (this.length <= 0) return;
    const time = frac * this.length;
    this.timeLabel.textContent = formatTime(time);
    const chapter = this.chapterAt(time);
    this.chapterLabel.textContent = chapter;
    this.chapterLabel.hidden = chapter === "";
    const frame = sprites.frameAt(time);
    this.tip.classList.toggle("with-image", frame !== null);
    if (frame && frame.url !== this.shownUrl) {
      // Swap the picture only once it has loaded, so moving along the bar never flashes blank.
      const url = frame.url;
      const next = new Image();
      next.onload = () => {
        this.image.src = url;
        this.shownUrl = url;
      };
      next.src = url;
    }
    this.tip.classList.add("show");
    const rect = this.track.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    const half = this.tip.offsetWidth / 2;
    const center = clamp(rect.left + frac * rect.width, half + 10, innerWidth - half - 10);
    this.tip.style.left = `${center - host.left}px`;
  }

  private hideTip() {
    this.tip.classList.remove("show");
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || this.length <= 0) return;
    this.dragging = true;
    this.track.classList.add("dragging");
    this.track.setPointerCapture(e.pointerId);
    const frac = this.fraction(e);
    this.track.style.setProperty("--p", String(frac));
    this.elapsed.textContent = formatTime(frac * this.length);
    this.showTip(frac);
  }

  private move(e: PointerEvent) {
    if (this.length <= 0) return;
    const frac = this.fraction(e);
    this.showTip(frac);
    // Dragging moves the playhead; hovering only moves the preview.
    if (this.dragging) {
      this.track.style.setProperty("--p", String(frac));
      this.elapsed.textContent = formatTime(frac * this.length);
    }
  }

  private up(e: PointerEvent) {
    if (!this.dragging) return;
    this.dragging = false;
    this.track.classList.remove("dragging");
    this.hideTip();
    this.seek(this.fraction(e) * this.length);
  }

  /** Shows the playback position; ignored while the user is dragging the thumb. */
  update(state: PlaybackState) {
    if (state.length !== this.length) {
      this.length = state.length;
      this.renderMarks();
    }
    this.duration.textContent = formatTime(state.length);
    this.track.setAttribute("aria-valuemax", String(Math.round(state.length / 1000)));
    this.track.classList.toggle("empty", state.length <= 0);
    if (this.dragging) return;
    this.elapsed.textContent = formatTime(state.time);
    this.track.style.setProperty("--p", String(state.length > 0 ? clamp(state.time / state.length, 0, 1) : 0));
    this.track.setAttribute("aria-valuenow", String(Math.round(state.time / 1000)));
  }
}
