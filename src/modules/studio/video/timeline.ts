import { h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import type { MediaStore } from "./media";
import { PEAK_RATE } from "./media";
import {
  beatTimes, clipEnd, keyTimes, sourceTime, mainIndexAt, mainTrack, mediaOf, moveFree, moveMain, MIN_CLIP, projectDuration, snap, trimEnd, trimStart,
  type Clip, type MediaClip, type Project, type Track, type TrackKind,
} from "./model";

/**
 * The timeline: a ruler and the tracks drawn on canvases (thumbnails, waveforms, texts), with
 * the playhead and track headers as DOM. Clips are selected, moved (reordered on the magnetic
 * main track), trimmed from either edge with snapping, and media is dropped on it.
 */

export const MEDIA_DRAG = "application/x-corepro-video-media";
export const TEXT_DRAG = "application/x-corepro-video-text";

export interface TimelineHost {
  project(): Project;
  store: MediaStore;
  selection: Set<string>;
  time(): number;
  seek(t: number): void;
  select(ids: string[], add: boolean): void;
  /** A drag starts: keep the project as it is now (for undo and for redoing the drag). */
  beginDrag(): void;
  /** Replays the drag from where it started with `fn`. */
  dragTo(fn: (p: Project) => void): void;
  endDrag(): void;
  dropMedia(mediaId: string, where: { kind: "main"; index: number } | { kind: "overlay" | "audio"; time: number; track?: string }): void;
  dropText(presetId: string, time: number): void;
  openTransition(clipId: string): void;
  /** Split, delete and friends from the toolbar. */
  command(name: "split" | "delete" | "duplicate"): void;
  fps(): number;
}

const HEADS = 132;
const RULER = 26;
const ROW_GAP = 4;
const PAD_TOP = 18;
const PAD_BOTTOM = 22;
const EDGE = 7;
const HEIGHT: Record<TrackKind, number> = { main: 64, overlay: 50, text: 30, audio: 44 };
const KIND_ICON: Record<TrackKind, IconName> = { main: "film", overlay: "image", text: "textBox", audio: "music" };
const KIND_LABEL: Record<TrackKind, string> = { main: "Main", overlay: "Overlay", text: "Text", audio: "Audio" };

interface Row {
  track: Track;
  y: number;
  h: number;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "move"; id: string; grab: number; startX: number; moved: boolean; main: boolean; trackKind: TrackKind }
  | { kind: "trim"; id: string; side: "start" | "end"; moved: boolean };

export function formatTime(t: number, fps = 30, frames = true): string {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total % 1) * fps + 1e-6);
  return frames ? `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export class Timeline {
  readonly el: HTMLElement;
  private ruler: HTMLCanvasElement;
  private canvas: HTMLCanvasElement;
  private heads: HTMLElement;
  private body: HTMLElement;
  private view: HTMLElement;
  private hscroll: HTMLElement;
  private spacer: HTMLElement;
  private playhead: HTMLElement;
  private zoom: HTMLInputElement;
  private snapBtn: HTMLButtonElement;
  private corner: HTMLElement;
  private rows: Row[] = [];
  /** Pixels per second. */
  private pps = 40;
  private scroll = 0;
  private snapOn = true;
  private drag: Drag | null = null;
  private snapLine: number | null = null;
  private insertAt: number | null = null;
  private dropRow: { y: number; h: number } | null = null;
  private raf = 0;
  private sprites = new Map<string, HTMLImageElement | null>();
  private observer: ResizeObserver;
  private width = 0;

  constructor(private host: TimelineHost) {
    const tool = (name: IconName, title: string, run: () => void) =>
      h("button", { class: "icon-btn small", type: "button", title, "aria-label": title, onclick: run }, icon(name, 17));
    this.zoom = h("input", { type: "range", min: "0", max: "1000", value: "500", class: "ve-zoom", "aria-label": "Zoom", oninput: () => this.setZoom(this.sliderPps(), null) });
    this.snapBtn = h("button", { class: "icon-btn small active", type: "button", title: "Snap to edges (N)", onclick: () => this.toggleSnap() }, icon("link", 17));
    const tools = h("div", { class: "ve-tl-tools" },
      tool("cut", "Split at the playhead (Ctrl+B)", () => host.command("split")),
      tool("trash", "Delete (Delete)", () => host.command("delete")),
      tool("copy", "Duplicate (Ctrl+D)", () => host.command("duplicate")),
      h("span", { class: "ve-sep" }),
      this.snapBtn,
      h("span", { class: "spacer" }),
      tool("zoomOut", "Zoom out (−)", () => this.zoomBy(1 / 1.5)),
      this.zoom,
      tool("zoomIn", "Zoom in (+)", () => this.zoomBy(1.5)),
      tool("zoomFit", "Fit the timeline", () => this.fit()),
    );
    this.corner = h("div", { class: "ve-tl-corner" }, "00:00:00");
    this.ruler = h("canvas", { class: "ve-tl-ruler" });
    this.canvas = h("canvas", { class: "ve-tl-canvas" });
    this.heads = h("div", { class: "ve-tl-heads" });
    this.view = h("div", { class: "ve-tl-view" }, this.canvas);
    this.body = h("div", { class: "ve-tl-body" }, this.heads, this.view);
    this.spacer = h("div", { class: "ve-tl-spacer" });
    this.hscroll = h("div", { class: "ve-tl-hscroll", onscroll: () => this.onHScroll() }, this.spacer);
    this.playhead = h("div", { class: "ve-tl-playhead" }, h("div", { class: "ve-tl-playhead-knob" }));
    this.el = h("div", { class: "ve-tl" }, tools, h("div", { class: "ve-tl-top" }, this.corner, this.ruler), this.body, this.hscroll, this.playhead);

    this.ruler.addEventListener("pointerdown", (e) => this.rulerDown(e));
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.hover(e));
    this.canvas.addEventListener("dblclick", (e) => this.dblclick(e));
    this.view.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.ruler.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.view.addEventListener("dragover", (e) => this.dragOver(e));
    this.view.addEventListener("dragleave", () => this.clearDrop());
    this.view.addEventListener("drop", (e) => this.dropped(e));
    this.body.addEventListener("scroll", () => this.placePlayhead());
    this.observer = new ResizeObserver(() => this.redraw());
    this.observer.observe(this.view);
  }

  // ---- geometry

  private x(t: number) {
    return t * this.pps - this.scroll;
  }

  private t(x: number) {
    return (x + this.scroll) / this.pps;
  }

  private layoutRows(): number {
    const p = this.host.project();
    const visual = p.tracks.slice(1).filter((t) => t.kind !== "audio").reverse();
    const audio = p.tracks.filter((t) => t.kind === "audio");
    const order = [...visual, mainTrack(p), ...audio];
    let y = PAD_TOP;
    this.rows = order.map((track) => {
      const row = { track, y, h: HEIGHT[track.kind] };
      y += row.h + ROW_GAP;
      return row;
    });
    return y + PAD_BOTTOM;
  }

  private rowAt(y: number): Row | undefined {
    return this.rows.find((r) => y >= r.y - ROW_GAP / 2 && y < r.y + r.h + ROW_GAP / 2);
  }

  private clipAtPoint(x: number, y: number): { clip: Clip; row: Row; edge: "start" | "end" | null } | null {
    const row = this.rowAt(y);
    if (!row || y < row.y || y > row.y + row.h) return null;
    const t = this.t(x);
    const slack = EDGE / this.pps;
    for (const clip of row.track.clips) {
      if (t < clip.start - slack || t > clipEnd(clip) + slack) continue;
      const x0 = this.x(clip.start), x1 = this.x(clipEnd(clip));
      const selected = this.host.selection.has(clip.id);
      const near = Math.min(EDGE, (x1 - x0) / 3);
      if (x - x0 < near && (selected || x1 - x0 > 24)) return { clip, row, edge: "start" };
      if (x1 - x < near && (selected || x1 - x0 > 24)) return { clip, row, edge: "end" };
      if (t >= clip.start && t <= clipEnd(clip)) return { clip, row, edge: null };
    }
    return null;
  }

  /** The cut marker under a point on the main track (the clip after the cut). */
  private cutAtPoint(x: number, y: number): MediaClip | null {
    const p = this.host.project();
    const row = this.rows.find((r) => r.track === mainTrack(p));
    if (!row || y < row.y + row.h - 22 || y > row.y + row.h + 2) return null;
    for (const c of mainTrack(p).clips.slice(1)) {
      if (Math.abs(this.x(c.start) - x) < 9) return c as MediaClip;
    }
    return null;
  }

  // ---- zoom and scrolling

  private sliderPps() {
    const v = Number(this.zoom.value) / 1000;
    return Math.exp(Math.log(2) + v * (Math.log(400) - Math.log(2)));
  }

  private syncSlider() {
    this.zoom.value = String(Math.round(((Math.log(this.pps) - Math.log(2)) / (Math.log(400) - Math.log(2))) * 1000));
  }

  /** Zooms keeping the time under `anchorX` (or the playhead) in place. */
  setZoom(pps: number, anchorX: number | null) {
    const next = Math.max(2, Math.min(400, pps));
    const ax = anchorX ?? Math.max(0, Math.min(this.width, this.x(this.host.time())));
    const at = this.t(ax);
    this.pps = next;
    this.scroll = Math.max(0, at * this.pps - ax);
    this.syncSlider();
    this.redraw();
  }

  zoomBy(f: number) {
    this.setZoom(this.pps * f, null);
  }

  fit() {
    const d = Math.max(5, projectDuration(this.host.project()));
    this.pps = Math.max(2, Math.min(400, (this.width - 40) / d));
    this.scroll = 0;
    this.syncSlider();
    this.redraw();
  }

  private toggleSnap() {
    this.snapOn = !this.snapOn;
    this.snapBtn.classList.toggle("active", this.snapOn);
  }

  toggleSnapKey() {
    this.toggleSnap();
  }

  private onHScroll() {
    if (Math.abs(this.hscroll.scrollLeft - this.scroll) < 1) return;
    this.scroll = this.hscroll.scrollLeft;
    this.redraw(false);
  }

  private wheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.view.getBoundingClientRect();
      this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left);
      return;
    }
    if (e.shiftKey) return; // vertical scrolling through the tracks
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!dx) return;
    e.preventDefault();
    this.scroll = Math.max(0, this.scroll + dx);
    this.redraw();
  }

  /** Keeps the playhead in view while playing. */
  follow(t: number) {
    const x = this.x(t);
    if (x > this.width - 30 || x < 0) {
      this.scroll = Math.max(0, t * this.pps - 60);
      this.redraw();
    } else this.placePlayhead();
  }

  setTime(t: number) {
    this.corner.textContent = formatTime(t, this.host.fps());
    this.placePlayhead();
  }

  private placePlayhead() {
    const x = this.x(this.host.time());
    const visible = x >= -1 && x <= this.width + 1;
    this.playhead.style.display = visible ? "" : "none";
    this.playhead.style.transform = `translateX(${HEADS + x}px)`;
  }

  // ---- drawing

  redraw(syncScroll = true) {
    if (syncScroll) this.syncScroll = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  private syncScroll = false;

  private palette() {
    const s = getComputedStyle(this.el);
    const v = (n: string, f: string) => s.getPropertyValue(n).trim() || f;
    return { text: v("--text", "#f5f5f7"), muted: v("--muted", "#9a9aa1"), line: v("--line", "rgba(255,255,255,0.1)"), font: s.fontFamily || "sans-serif" };
  }

  private draw() {
    this.raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(10, this.view.clientWidth);
    this.width = width;
    const height = this.layoutRows();
    const p = this.host.project();
    const duration = projectDuration(p);
    const contentWidth = Math.max(width, (duration + 30) * this.pps);
    this.spacer.style.width = `${contentWidth}px`;
    if (this.syncScroll) {
      this.syncScroll = false;
      this.scroll = Math.min(this.scroll, Math.max(0, contentWidth - width));
      if (Math.abs(this.hscroll.scrollLeft - this.scroll) >= 1) this.hscroll.scrollLeft = this.scroll;
    }
    const pal = this.palette();
    this.drawHeads();
    // Ruler.
    for (const [cv, w, hh] of [[this.ruler, width, RULER], [this.canvas, width, height]] as const) {
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(hh * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${hh}px`;
      }
    }
    const r = this.ruler.getContext("2d")!;
    r.setTransform(dpr, 0, 0, dpr, 0, 0);
    r.clearRect(0, 0, width, RULER);
    const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * this.pps >= 80) ?? 600;
    const minor = steps.slice().reverse().find((s) => s < major && s * this.pps >= 8) ?? major / 5;
    r.font = `10.5px ${pal.font}`;
    r.fillStyle = pal.muted;
    r.strokeStyle = pal.muted;
    r.globalAlpha = 0.8;
    const t0 = Math.floor(this.t(0) / minor) * minor;
    for (let t = t0; this.x(t) < width + 1; t += minor) {
      const x = Math.round(this.x(t)) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      r.beginPath();
      r.moveTo(x, RULER);
      r.lineTo(x, RULER - (isMajor ? 9 : 4));
      r.lineWidth = 1;
      r.stroke();
      if (isMajor) r.fillText(major < 1 ? formatTime(t, this.host.fps()) : formatTime(t, 30, false), x + 3, 11);
    }
    r.globalAlpha = 1;

    const g = this.canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    for (const row of this.rows) {
      g.fillStyle = row.track.kind === "main" ? "rgba(127,127,140,0.10)" : "rgba(127,127,140,0.055)";
      g.beginPath();
      g.roundRect(0, row.y, width, row.h, 6);
      g.fill();
      for (const clip of row.track.clips) {
        const x0 = this.x(clip.start), x1 = this.x(clipEnd(clip));
        if (x1 < -2 || x0 > width + 2) continue;
        this.drawClip(g, clip, row, x0, x1, pal);
      }
      if (row.track.kind === "main") this.drawCuts(g, row);
    }
    if (this.dropRow) {
      g.strokeStyle = "#f97350";
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.strokeRect(1, this.dropRow.y, width - 2, this.dropRow.h);
      g.setLineDash([]);
    }
    if (this.insertAt !== null) {
      const x = this.x(this.insertAt);
      const row = this.rows.find((rr) => rr.track.kind === "main")!;
      g.fillStyle = "#f97350";
      g.fillRect(x - 1.5, row.y - 4, 3, row.h + 8);
    }
    if (this.snapLine !== null) {
      const x = Math.round(this.x(this.snapLine)) + 0.5;
      g.strokeStyle = "#ffd166";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, height);
      g.stroke();
    }
    this.placePlayhead();
  }

  private drawHeads() {
    const p = this.host.project();
    const sig = this.rows.map((r) => `${r.track.id}:${r.track.kind}:${r.track.muted}:${r.track.hidden}:${r.y}:${r.track.clips.some((c) => c.type === "media" && c.role === "voice")}`).join("|");
    if (this.heads.dataset.sig === sig) return;
    this.heads.dataset.sig = sig;
    const total = this.rows.length ? this.rows[this.rows.length - 1].y + this.rows[this.rows.length - 1].h + PAD_BOTTOM : 0;
    this.heads.style.height = `${total}px`;
    this.heads.replaceChildren(...this.rows.map((row) => {
      const t = row.track;
      const toggle = (name: IconName, on: boolean, title: string, run: () => void) =>
        h("button", { class: `icon-btn small${on ? " active" : ""}`, type: "button", title, "aria-label": title, onclick: run }, icon(name, 14));
      const sameKind = p.tracks.filter((x) => x.kind === t.kind);
      const n = sameKind.length > 1 ? ` ${sameKind.indexOf(t) + 1}` : "";
      const voice = t.kind === "audio" && t.clips.length > 0 && t.clips.every((c) => c.type === "media" && c.role === "voice");
      return h("div", { class: `ve-tl-head kind-${t.kind}`, style: { top: `${row.y}px`, height: `${row.h}px` } },
        icon(voice ? "veMic" : KIND_ICON[t.kind], 14),
        h("span", { class: "ve-tl-head-name" }, (voice ? "Voice" : KIND_LABEL[t.kind]) + n),
        t.kind !== "text" ? toggle(t.muted ? "mute" : "volume", t.muted, t.muted ? "Unmute track" : "Mute track", () => this.trackFlag(t.id, "muted")) : null,
        t.kind !== "audio" ? toggle(t.hidden ? "eyeOff" : "eye", t.hidden, t.hidden ? "Show track" : "Hide track", () => this.trackFlag(t.id, "hidden")) : null,
      );
    }));
  }

  private trackFlag(id: string, flag: "muted" | "hidden") {
    this.host.beginDrag();
    this.host.dragTo((p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) t[flag] = !t[flag];
    });
    this.host.endDrag();
  }

  private sprite(url: string): HTMLImageElement | null {
    if (this.sprites.has(url)) return this.sprites.get(url)!;
    this.sprites.set(url, null);
    const img = new Image();
    img.onload = () => {
      this.sprites.set(url, img);
      this.redraw(false);
    };
    img.src = url;
    return null;
  }

  private stripFor = new Map<string, { url: string; thumbWidth: number; thumbHeight: number; count: number } | null>();

  private drawClip(g: CanvasRenderingContext2D, clip: Clip, row: Row, x0: number, x1: number, pal: { text: string; muted: string; font: string }) {
    const p = this.host.project();
    const selected = this.host.selection.has(clip.id);
    const y = row.y, hh = row.h;
    const w = Math.max(2, x1 - x0);
    g.save();
    g.beginPath();
    g.roundRect(x0 + 0.5, y + 0.5, w - 1, hh - 1, 6);
    g.clip();
    let label = "";
    if (clip.type === "text") {
      g.fillStyle = "#7c5cd6";
      g.fillRect(x0, y, w, hh);
      label = clip.text.replace(/\s+/g, " ") || "Text";
    } else {
      const m = mediaOf(p, clip.media);
      label = m?.name ?? "Missing";
      const audioOnly = m?.kind === "audio" || row.track.kind === "audio";
      g.fillStyle = m?.missing ? "#5a2a2a" : audioOnly ? "#1f5b46" : "#24435a";
      g.fillRect(x0, y, w, hh);
      if (m && !m.missing && !audioOnly) {
        if (!this.stripFor.has(m.id)) {
          this.stripFor.set(m.id, null);
          void this.host.store.strip(m).then((s) => {
            this.stripFor.set(m.id, s);
            this.redraw(false);
          });
        }
        const s = this.stripFor.get(m.id);
        const img = s ? this.sprite(s.url) : null;
        if (s && img) {
          const th = hh - (m.audio ? 14 : 0);
          const tw = Math.max(8, (th * s.thumbWidth) / s.thumbHeight);
          const first = Math.max(0, Math.floor(-x0 / tw));
          for (let i = first, x = x0 + first * tw; x < Math.min(x1, this.width + tw); i++, x += tw) {
            const tl = clip.start + ((x - x0 + tw / 2) / w) * clip.duration;
            const src = m.kind === "image" ? 0 : sourceTime(clip, tl);
            const k = m.kind === "image" ? 0 : Math.max(0, Math.min(s.count - 1, Math.floor((src / Math.max(0.001, m.duration)) * s.count)));
            g.drawImage(img, k * s.thumbWidth, 0, s.thumbWidth, s.thumbHeight, x, y, tw, th);
          }
        }
      }
      if (m && m.audio && !m.missing && clip.freeze === undefined) {
        const sound = this.host.store.soundNow(m);
        if (sound === undefined) void this.host.store.sound(m).then(() => this.redraw(false));
        if (sound) {
          const band = audioOnly ? hh - 16 : 13;
          const base = y + hh - 2;
          g.fillStyle = audioOnly ? "rgba(140, 240, 190, 0.85)" : "rgba(140, 240, 190, 0.7)";
          if (!audioOnly) {
            g.fillStyle = "rgba(10, 30, 26, 0.75)";
            g.fillRect(x0, y + hh - 14, w, 14);
            g.fillStyle = "rgba(140, 240, 190, 0.8)";
          }
          const start = Math.max(x0, 0), end = Math.min(x1, this.width);
          const vol = Math.min(1.5, clip.volume);
          for (let x = Math.floor(start); x < end; x += 2) {
            const sa = sourceTime(clip, clip.start + (x - x0) / this.pps), sb = sourceTime(clip, clip.start + (x + 2 - x0) / this.pps);
            const a = Math.min(sa, sb), b = Math.max(sa, sb, a + 1 / PEAK_RATE);
            let peak = 0;
            for (let i = Math.floor(a * PEAK_RATE), e = Math.ceil(b * PEAK_RATE); i < e && i < sound.peaks.length; i++) peak = Math.max(peak, sound.peaks[i]);
            const ph = Math.max(1, (peak / 255) * band * vol);
            if (audioOnly) g.fillRect(x, y + 14 + (band - ph) / 2, 1.5, ph);
            else g.fillRect(x, base - ph, 1.5, ph);
          }
        }
      }
      if (clip.speed !== 1 && !clip.curve) label = `${clip.speed.toFixed(clip.speed < 1 ? 2 : 1)}×  ${label}`;
      if (clip.curve) label = `Curve  ${label}`;
      if (clip.reverse) label = `◀◀  ${label}`;
      if (clip.freeze !== undefined) label = `Freeze  ${label}`;
      if (clip.role === "voice") label = `Voice-over`;
      if (clip.volume === 0 && m?.audio && !clip.keys?.volume) label = `🔇 ${label}`;
      // Beat marks.
      const beats = beatTimes(clip);
      if (beats.length) {
        g.fillStyle = "rgba(255, 209, 102, 0.9)";
        for (const b of beats) {
          const bx = this.x(b);
          if (bx >= x0 && bx <= x1) g.fillRect(Math.round(bx) - 0.5, y + hh - 9, 1.5, 7);
        }
      }
    }
    // Keyframes: diamonds along the clip's foot.
    if (clip.keys) {
      const size = selected ? 5 : 3.5;
      const ky = y + hh - (selected ? 8 : 6);
      for (const kt of keyTimes(clip)) {
        const kx = this.x(clip.start + kt);
        if (kx < x0 - 1 || kx > x1 + 1) continue;
        g.fillStyle = selected ? "#ffd166" : "rgba(255, 209, 102, 0.75)";
        g.strokeStyle = "rgba(0,0,0,0.6)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(kx, ky - size);
        g.lineTo(kx + size, ky);
        g.lineTo(kx, ky + size);
        g.lineTo(kx - size, ky);
        g.closePath();
        g.fill();
        g.stroke();
      }
    }
    // Label.
    g.font = `600 11px ${pal.font}`;
    const lw = Math.min(w - 10, g.measureText(label).width + 10);
    if (lw > 14) {
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.beginPath();
      g.roundRect(Math.max(x0, 0) + 4, y + 4, lw, 16, 4);
      g.fill();
      g.fillStyle = "#ffffff";
      g.fillText(label, Math.max(x0, 0) + 9, y + 16, lw - 10);
    }
    g.restore();
    if (selected) {
      g.strokeStyle = "#ffffff";
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(x0 + 1, y + 1, w - 2, hh - 2, 6);
      g.stroke();
      g.fillStyle = "#ffffff";
      for (const ex of [x0 + 1, x1 - 6]) {
        g.beginPath();
        g.roundRect(ex, y + 1, 5, hh - 2, 2);
        g.fill();
      }
    }
  }

  private drawCuts(g: CanvasRenderingContext2D, row: Row) {
    const clips = row.track.clips as MediaClip[];
    for (let i = 1; i < clips.length; i++) {
      const c = clips[i];
      const x = this.x(c.start);
      if (x < -20 || x > this.width + 20) continue;
      if (c.transition) {
        const half = (c.transition.duration / 2) * this.pps;
        g.fillStyle = "rgba(249, 115, 80, 0.32)";
        g.fillRect(x - half, row.y + row.h - 20, half * 2, 18);
      }
      g.fillStyle = c.transition ? "#f97350" : "rgba(255,255,255,0.85)";
      g.beginPath();
      g.roundRect(x - 8, row.y + row.h - 19, 16, 16, 4);
      g.fill();
      g.strokeStyle = c.transition ? "#ffffff" : "#24435a";
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(x - 4, row.y + row.h - 15);
      g.lineTo(x + 4, row.y + row.h - 7);
      g.moveTo(x + 4, row.y + row.h - 15);
      g.lineTo(x - 4, row.y + row.h - 7);
      g.stroke();
    }
  }

  // ---- pointer

  private local(e: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private rulerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.ruler.setPointerCapture(e.pointerId);
    const rect = this.ruler.getBoundingClientRect();
    const seek = (ev: PointerEvent) => this.host.seek(Math.max(0, this.t(ev.clientX - rect.left)));
    seek(e);
    const move = (ev: PointerEvent) => seek(ev);
    const up = () => {
      this.ruler.removeEventListener("pointermove", move);
      this.ruler.removeEventListener("pointerup", up);
    };
    this.ruler.addEventListener("pointermove", move);
    this.ruler.addEventListener("pointerup", up);
  }

  private hover(e: PointerEvent) {
    if (this.drag) return;
    const { x, y } = this.local(e);
    const hit = this.clipAtPoint(x, y);
    this.canvas.style.cursor = this.cutAtPoint(x, y) ? "pointer" : hit?.edge ? "ew-resize" : hit ? "grab" : "default";
  }

  private dblclick(e: MouseEvent) {
    const { x, y } = this.local(e);
    const cut = this.cutAtPoint(x, y);
    if (cut) this.host.openTransition(cut.id);
  }

  private snapped(t: number, except: string[]) {
    if (!this.snapOn) {
      this.snapLine = null;
      return t;
    }
    const s = snap(this.host.project(), t, 8 / this.pps, except, [this.host.time()]);
    this.snapLine = s !== t ? s : null;
    return s;
  }

  /** The keyframe of a selected clip under a point (its timeline time). */
  private keyAtPoint(x: number, y: number): number | null {
    const row = this.rowAt(y);
    if (!row || y < row.y + row.h - 15 || y > row.y + row.h) return null;
    for (const clip of row.track.clips) {
      if (!clip.keys || !this.host.selection.has(clip.id)) continue;
      for (const kt of keyTimes(clip)) if (Math.abs(this.x(clip.start + kt) - x) <= 6) return clip.start + kt;
    }
    return null;
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    const key = this.keyAtPoint(x, y);
    if (key !== null) {
      this.host.seek(key);
      return;
    }
    const cut = this.cutAtPoint(x, y);
    if (cut) {
      this.host.openTransition(cut.id);
      return;
    }
    const hit = this.clipAtPoint(x, y);
    this.canvas.setPointerCapture(e.pointerId);
    if (!hit) {
      this.host.select([], false);
      this.drag = { kind: "scrub" };
      this.host.seek(Math.max(0, this.t(x)));
    } else {
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      if (!this.host.selection.has(hit.clip.id) || add) this.host.select([hit.clip.id], add);
      if (hit.edge) {
        this.drag = { kind: "trim", id: hit.clip.id, side: hit.edge, moved: false };
      } else {
        this.drag = { kind: "move", id: hit.clip.id, grab: this.t(x) - hit.clip.start, startX: x, moved: false, main: hit.row.track.kind === "main", trackKind: hit.row.track.kind };
      }
    }
    const move = (ev: PointerEvent) => this.dragMove(ev);
    const up = (ev: PointerEvent) => {
      this.canvas.removeEventListener("pointermove", move);
      this.canvas.removeEventListener("pointerup", up);
      this.canvas.removeEventListener("pointercancel", up);
      this.dragEnd(ev);
    };
    this.canvas.addEventListener("pointermove", move);
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
  }

  private dragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const { x, y } = this.local(e);
    if (d.kind === "scrub") {
      this.host.seek(Math.max(0, this.t(x)));
      return;
    }
    if (d.kind === "trim") {
      if (!d.moved) {
        d.moved = true;
        this.host.beginDrag();
      }
      const t = this.snapped(Math.max(0, this.t(x)), [d.id]);
      this.host.dragTo((p) => (d.side === "start" ? trimStart(p, d.id, t) : trimEnd(p, d.id, t)));
      this.redraw(false);
      return;
    }
    if (!d.moved && Math.abs(x - d.startX) < 4) return;
    if (!d.moved) {
      d.moved = true;
      this.host.beginDrag();
    }
    this.canvas.style.cursor = "grabbing";
    if (d.main) {
      this.insertAt = this.insertionTime(this.t(x), d.id);
      this.redraw(false);
      return;
    }
    const start = this.snapStart(Math.max(0, this.t(x) - d.grab), d.id);
    const row = this.rowAt(y);
    const target = row && row.track.kind === d.trackKind ? row.track.id : undefined;
    this.host.dragTo((p) => moveFree(p, d.id, start, target));
    this.redraw(false);
  }

  /** Snaps a moving clip by its start or its end, whichever is closer to something. */
  private snapStart(start: number, id: string) {
    if (!this.snapOn) return start;
    const clip = this.host.project().tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    const length = clip?.duration ?? 0;
    const range = 8 / this.pps;
    const p = this.host.project();
    const a = snap(p, start, range, [id], [this.host.time()]);
    const b = snap(p, start + length, range, [id], [this.host.time()]);
    if (a !== start && (b === start + length || Math.abs(a - start) <= Math.abs(b - start - length))) {
      this.snapLine = a;
      return a;
    }
    if (b !== start + length) {
      this.snapLine = b;
      return b - length;
    }
    this.snapLine = null;
    return start;
  }

  /** Where a main-track clip dragged to `t` would go: the start of the clip it lands before. */
  private insertionTime(t: number, except?: string) {
    const p = this.host.project();
    const clips = mainTrack(p).clips.filter((c) => c.id !== except);
    const i = mainIndexAt(p, t, except);
    let at = 0;
    for (let k = 0; k < i; k++) at += clips[k].duration;
    return at;
  }

  private dragEnd(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    this.snapLine = null;
    if (!d || d.kind === "scrub") return;
    if (d.kind === "move" && d.main && d.moved) {
      const { x } = this.local(e);
      const p = this.host.project();
      const index = mainIndexAt(p, this.t(x), d.id);
      this.host.dragTo((q) => moveMain(q, d.id, index));
    }
    this.insertAt = null;
    if (d.moved) this.host.endDrag();
    this.redraw(false);
  }

  // ---- dropping media and texts

  private dropTarget(e: DragEvent): { kind: "main"; index: number; y: number; h: number } | { kind: "overlay" | "audio" | "text"; time: number; track?: string; y: number; h: number } | null {
    const types = e.dataTransfer?.types ?? [];
    const isMedia = types.includes(MEDIA_DRAG);
    const isText = types.includes(TEXT_DRAG);
    if (!isMedia && !isText) return null;
    const { x, y } = this.local(e);
    const t = Math.max(0, this.t(x));
    const row = this.rowAt(y);
    const audioMedia = types.includes(`${MEDIA_DRAG}-audio`);
    if (isText) {
      const tr = row?.track.kind === "text" ? row : null;
      return { kind: "text", time: t, track: tr?.track.id, y: tr?.y ?? Math.max(0, y - 15), h: tr?.h ?? HEIGHT.text };
    }
    if (audioMedia) {
      const tr = row?.track.kind === "audio" ? row : null;
      return { kind: "audio", time: t, track: tr?.track.id, y: tr?.y ?? Math.max(0, y - 20), h: tr?.h ?? HEIGHT.audio };
    }
    if (row?.track.kind === "main") return { kind: "main", index: mainIndexAt(this.host.project(), t), y: row.y, h: row.h };
    if (row?.track.kind === "overlay") return { kind: "overlay", time: t, track: row.track.id, y: row.y, h: row.h };
    if (row?.track.kind === "audio") return { kind: "audio", time: t, track: row.track.id, y: row.y, h: row.h };
    const main = this.rows.find((r) => r.track.kind === "main")!;
    if (y < main.y) return { kind: "overlay", time: t, y: Math.max(0, y - 20), h: HEIGHT.overlay };
    return { kind: "main", index: mainTrack(this.host.project()).clips.length, y: main.y, h: main.h };
  }

  private dragOver(e: DragEvent) {
    const target = this.dropTarget(e);
    if (!target) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (target.kind === "main") {
      this.insertAt = this.insertionTime(this.t(this.local(e).x));
      this.dropRow = null;
    } else {
      this.insertAt = null;
      this.dropRow = { y: target.y, h: target.h };
    }
    this.redraw(false);
  }

  private clearDrop() {
    this.insertAt = null;
    this.dropRow = null;
    this.redraw(false);
  }

  private dropped(e: DragEvent) {
    const target = this.dropTarget(e);
    this.clearDrop();
    if (!target || !e.dataTransfer) return;
    e.preventDefault();
    const text = e.dataTransfer.getData(TEXT_DRAG);
    if (target.kind === "text") {
      if (text) this.host.dropText(text, target.time);
      return;
    }
    const id = e.dataTransfer.getData(MEDIA_DRAG);
    if (!id) return;
    if (target.kind === "main") this.host.dropMedia(id, { kind: "main", index: target.index });
    else this.host.dropMedia(id, { kind: target.kind, time: target.time, track: target.track });
  }

  /** The smallest step of a clip edge at this zoom, for nudging. */
  get minStep() {
    return Math.max(MIN_CLIP, 1 / this.pps);
  }

  dispose() {
    this.observer.disconnect();
    cancelAnimationFrame(this.raf);
  }
}
