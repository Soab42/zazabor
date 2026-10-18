import { h } from "../../../../ui/dom";
import type { SubtitleController } from "./controller";
import { cueText } from "./parse";
import { dragToDelay, formatDelay, fraction, msPerPixel, windowAround } from "./timeline";
import type { Cue } from "./types";

/** How much time the strip shows around the playhead. */
const SPAN_MS = 60_000;
/** Pointer movement under this many px is a click, not a drag. */
const DRAG_SLOP = 4;

export interface TimelineView {
  el: HTMLElement;
  /** Starts following the playhead (call when the strip becomes visible). */
  start(): void;
  stop(): void;
  dispose(): void;
}

/**
 * The subtitle timeline: cue blocks around the playhead. Drag the strip to shift the timing
 * (it changes the delay), click a block to jump to that line.
 */
export function createTimeline(c: SubtitleController, compact = false): TimelineView {
  const empty = h("div", { class: "pp-tl-empty" });
  const strip = h("div", { class: "pp-tl-strip", role: "slider", tabindex: 0, "aria-label": "Subtitle timeline: drag to shift timing, click a line to jump" });
  const head = h("div", { class: "pp-tl-head" });
  const readout = h("span", { class: "pp-tl-delay" });
  const el = h("div", { class: `pp-timeline${compact ? " compact" : ""}` }, strip, head, empty, readout);

  const pool: (HTMLElement & { cue?: Cue })[] = [];
  let raf = 0;
  let running = false;
  let drag: { x: number; delay: number; moved: boolean; target: EventTarget | null } | null = null;

  function block(i: number) {
    let b = pool[i];
    if (!b) {
      b = h("div", { class: "pp-tl-cue" }) as HTMLElement & { cue?: Cue };
      pool[i] = b;
      strip.append(b);
    }
    return b;
  }

  function draw() {
    raf = 0;
    const index = c.engine.index;
    const delay = c.engine.delay;
    readout.textContent = index ? formatDelay(delay) : "";
    readout.hidden = !index || delay === 0;
    if (!index) {
      empty.textContent = c.source !== "embedded"
        ? "Turn on a subtitle track or add a subtitle file to see its timeline."
        : c.readingEmbedded ? "Reading the subtitles in the video…" : "This track is a picture format, so it has no timeline.";
      empty.hidden = false;
      head.hidden = true;
      for (const b of pool) b.hidden = true;
    } else {
      empty.hidden = true;
      head.hidden = false;
      const win = windowAround(c.now(), SPAN_MS);
      const cues = index.between(win.from - delay, win.to - delay);
      cues.forEach((cue, i) => {
        const b = block(i);
        const left = fraction(cue.start + delay, win);
        const right = fraction(cue.end + delay, win);
        b.hidden = false;
        b.style.left = `${(left * 100).toFixed(3)}%`;
        b.style.width = `${Math.max(0.3, (right - left) * 100).toFixed(3)}%`;
        if (b.cue !== cue) {
          b.cue = cue;
          const text = cueText(cue);
          b.title = text;
          b.textContent = compact ? "" : text.replace(/\s+/g, " ");
        }
        b.classList.toggle("now", cue.start + delay <= win.from + SPAN_MS / 2 && cue.end + delay > win.from + SPAN_MS / 2);
      });
      for (let i = cues.length; i < pool.length; i++) pool[i].hidden = true;
    }
    if (running && (c.playing || drag)) raf = requestAnimationFrame(draw);
  }

  const schedule = () => {
    if (running && !raf) raf = requestAnimationFrame(draw);
  };
  const unsubscribe = c.subscribe(schedule);

  strip.addEventListener("pointerdown", (e) => {
    if (!c.engine.index || e.button !== 0) return;
    strip.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, delay: c.engine.delay, moved: false, target: e.target };
    schedule();
  });
  strip.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < DRAG_SLOP) return;
    drag.moved = true;
    c.engine.setDelay(dragToDelay(drag.delay, dx, msPerPixel(SPAN_MS, strip.clientWidth)));
    schedule();
  });
  const finish = (e: PointerEvent, cancelled: boolean) => {
    if (!drag) return;
    const was = drag;
    drag = null;
    if (strip.hasPointerCapture(e.pointerId)) strip.releasePointerCapture(e.pointerId);
    if (cancelled) {
      c.engine.setDelay(was.delay);
    } else if (was.moved) {
      c.setDelay(c.engine.delay);
    } else {
      const cue = (was.target as (HTMLElement & { cue?: Cue }) | null)?.cue;
      if (cue) c.seekToCue(cue.start);
    }
    schedule();
  };
  strip.addEventListener("pointerup", (e) => finish(e, false));
  strip.addEventListener("pointercancel", (e) => finish(e, true));
  strip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    c.setDelay(c.delay + (e.key === "ArrowRight" ? 50 : -50));
  });

  return {
    el,
    start() {
      running = true;
      schedule();
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
    },
    dispose() {
      this.stop();
      unsubscribe();
    },
  };
}
