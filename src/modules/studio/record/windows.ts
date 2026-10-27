import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyAppearance } from "../../../appearance";
import { adoptConfig, CONFIG_SAVED, parseConfig, saveConfig, type Config } from "../../../config";
import { onOthers, openWindow } from "../../../shell/windows";
import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { showToast } from "../../files/ops/toast";
import { clock, onStatus, recApi, type Area, type Status } from "./api";
import { createRecorderPage } from "./page";
import "./record.css";

function followConfig(config: Config) {
  applyAppearance(config.appearance);
  void onOthers<string>(CONFIG_SAVED, (json) => {
    try {
      adoptConfig(config, parseConfig(json));
    } catch {
      return;
    }
    applyAppearance(config.appearance);
  });
}

/**
 * The control bar that floats over everything while recording: the time, Pause, the
 * microphone, Stop and Discard; before that, the 3-2-1 countdown. Dragged by its empty parts.
 */
export function startRecorderBar(config: Config) {
  document.body.classList.add("rec-bar-window");
  followConfig(config);
  const dot = h("span", { class: "rec-bar-dot" });
  const time = h("span", { class: "rec-bar-time" }, "0:00");
  const count = h("span", { class: "rec-bar-count" });
  const pause = h("button", { class: "rec-bar-btn", type: "button", title: "Pause", "aria-label": "Pause" }, icon("pause", 17));
  const mic = h("button", { class: "rec-bar-btn", type: "button", title: "Mute the microphone", "aria-label": "Mute the microphone" }, icon("veMic", 17));
  const stop = h("button", { class: "rec-bar-btn stop", type: "button", title: "Stop and save", "aria-label": "Stop and save" }, h("span", { class: "rec-bar-square" }), "Stop");
  const discard = h("button", { class: "rec-bar-btn", type: "button", title: "Discard this recording", "aria-label": "Discard this recording" }, icon("trash", 16));
  const warning = h("span", { class: "rec-bar-warning", role: "status" });
  const bar = h("div", { class: "rec-bar", "data-tauri-drag-region": "" }, dot, time, count, warning, h("span", { class: "spacer", "data-tauri-drag-region": "" }), pause, mic, stop, discard);
  document.getElementById("app")!.append(bar);

  let status: Status | null = null;
  let confirmDiscard = 0;
  const drawn = { paused: false, muted: false };
  const act = (p: Promise<unknown>) => void p.catch((err) => console.warn("Recorder:", err));
  pause.addEventListener("click", () => act(status?.phase === "paused" ? recApi.resume() : recApi.pause()));
  mic.addEventListener("click", () => act(recApi.mute(!status?.muted)));
  stop.addEventListener("click", () => act(recApi.stop()));
  discard.addEventListener("click", () => {
    // Twice to throw it away: one stray click mustn't lose a recording.
    if (status?.phase !== "countdown" && !confirmDiscard) {
      confirmDiscard = window.setTimeout(() => ((confirmDiscard = 0), draw()), 3000);
      return draw();
    }
    act(recApi.discard());
  });

  function draw() {
    const s = status;
    if (!s) return;
    const counting = s.phase === "countdown";
    bar.classList.toggle("counting", counting);
    bar.classList.toggle("paused", s.phase === "paused");
    count.textContent = counting && s.countdown ? `Starting in ${s.countdown}…` : "";
    time.textContent = counting ? "" : clock(s.elapsed);
    time.hidden = counting;
    pause.hidden = counting;
    // Icons are swapped only when they change: a redraw between mousedown and mouseup would
    // take the click's target away and the press would do nothing.
    const paused = s.phase === "paused";
    if (paused !== drawn.paused) {
      drawn.paused = paused;
      pause.replaceChildren(icon(paused ? "play" : "pause", 17));
      pause.title = paused ? "Resume" : "Pause";
      pause.setAttribute("aria-label", pause.title);
    }
    mic.hidden = !s.mic || counting;
    mic.classList.toggle("off", s.muted);
    if (s.muted !== drawn.muted) {
      drawn.muted = s.muted;
      mic.replaceChildren(icon(s.muted ? "recMicOff" : "veMic", 17));
      mic.title = s.muted ? "Unmute the microphone" : "Mute the microphone";
      mic.setAttribute("aria-label", mic.title);
    }
    stop.hidden = counting;
    discard.classList.toggle("confirm", !!confirmDiscard);
    discard.title = confirmDiscard ? "Click again to throw it away" : counting ? "Cancel" : "Discard this recording";
    warning.textContent = s.warning ?? "";
    // "Hide the control bar": once the countdown is over it gets out of the picture.
    if (s.hideBar && (s.phase === "recording" || s.phase === "paused")) void getCurrentWindow().hide().catch(() => undefined);
  }

  void onStatus((s) => ((status = s), draw()));
  void recApi.status().then((s) => ((status = s), draw()), () => undefined);
}

/**
 * The area picker: a still of the screen, dimmed, with the dragged rectangle clear. Shapes snap
 * the box (16:9, 9:16, 1:1); Enter or "Record This Area" takes it, Esc cancels.
 */
export async function startAreaPicker(config: Config, start: string | null | undefined) {
  document.body.classList.add("rec-area-window");
  followConfig(config);
  let monitor: Area = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  try {
    monitor = { ...monitor, ...JSON.parse(start ?? "{}") };
  } catch {
    // The whole window then.
  }
  const shot = h("img", { class: "rec-area-shot", alt: "", draggable: false });
  const shade = h("div", { class: "rec-area-shade" });
  const box = h("div", { class: "rec-area-box", hidden: true });
  const label = h("span", { class: "rec-area-size" });
  box.append(label);
  const ratios: [string, number | null][] = [["Free", null], ["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1]];
  let ratio: number | null = null;
  const ratioButtons = ratios.map(([name, r]) => h("button", { type: "button", class: r === ratio ? "active" : "", onclick: () => ((ratio = r), snap(), drawTools()) }, name));
  const ok = h("button", { class: "btn primary", type: "button", disabled: true, onclick: () => done(true) }, icon("recRecord", 14), "Record This Area");
  const tools = h("div", { class: "rec-area-tools glass-strong" },
    h("span", { class: "rec-area-hint" }, "Drag to draw the area"),
    h("div", { class: "segmented" }, ...ratioButtons), ok,
    h("button", { class: "btn ghost", type: "button", onclick: () => done(false) }, "Cancel"));
  const root = h("div", { class: "rec-area" }, shot, shade, box, tools);
  document.getElementById("app")!.append(root);

  try {
    const jpeg = await recApi.areaStill();
    shot.src = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
  } catch {
    // No still: the dark shade alone still shows where the box goes.
  }

  // The rectangle in window (CSS) pixels.
  let rect: { x: number; y: number; w: number; h: number } | null = null;

  function drawTools() {
    ratioButtons.forEach((b, i) => b.classList.toggle("active", ratios[i][1] === ratio));
    ok.disabled = !rect || rect.w < 32 || rect.h < 32;
  }

  function drawBox() {
    if (!rect) {
      box.hidden = true;
      shade.style.clipPath = "";
      return drawTools();
    }
    const { x, y, w, h: ht } = rect;
    box.hidden = false;
    Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${ht}px` });
    // The shade has a hole where the box is.
    const W = window.innerWidth, H = window.innerHeight;
    shade.style.clipPath = `polygon(evenodd, 0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0, ${x}px ${y}px, ${x}px ${y + ht}px, ${x + w}px ${y + ht}px, ${x + w}px ${y}px, ${x}px ${y}px)`;
    const s = scale();
    label.textContent = `${Math.round(w * s.x) & ~1} × ${Math.round(ht * s.y) & ~1}`;
    drawTools();
  }

  /** Window pixels to screen pixels. */
  function scale() {
    return { x: monitor.width / window.innerWidth, y: monitor.height / window.innerHeight };
  }

  function snap() {
    if (!rect || !ratio) return drawBox();
    const W = window.innerWidth, H = window.innerHeight;
    let w = rect.w, ht = w / ratio;
    if (rect.y + ht > H) {
      ht = H - rect.y;
      w = ht * ratio;
    }
    rect = { ...rect, w: Math.min(w, W - rect.x), h: ht };
    drawBox();
  }

  root.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".rec-area-tools") || e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      let w = Math.abs(ev.clientX - x0), ht = Math.abs(ev.clientY - y0);
      if (ratio) ht = w / ratio;
      const x = ev.clientX < x0 ? x0 - w : x0;
      const y = ev.clientY < y0 && !ratio ? y0 - ht : y0;
      rect = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, window.innerWidth - Math.max(0, x)), h: Math.min(ht, window.innerHeight - Math.max(0, y)) };
      drawBox();
    };
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(false);
    else if (e.key === "Enter" && !ok.disabled) done(true);
  });

  function done(take: boolean) {
    if (!take || !rect) return void recApi.areaDone(null);
    const s = scale();
    void recApi.areaDone({
      x: Math.round(monitor.x + rect.x * s.x),
      y: Math.round(monitor.y + rect.y * s.y),
      width: Math.round(rect.w * s.x) & ~1,
      height: Math.round(rect.h * s.y) & ~1,
    });
  }
  drawBox();
}

/** The recorder window (`zazabor --record`, or its shortcut): the recorder page on its own. */
export function startRecorderWindow(config: Config) {
  document.body.classList.add("rec-window");
  followConfig(config);
  const page = createRecorderPage({
    config,
    saveConfig: () => saveConfig(config),
    toast: (text, action) => showToast(text, action, 4000),
    openInEditor: (path) => openWindow("studio", path),
    showInFiles: (path) => openWindow("files", path.replace(/\/[^/]*$/, "") || "/"),
    showFolder: (path) => openWindow("files", path),
    play: (path) => openWindow("video", path),
  }, true);
  document.getElementById("app")!.append(page.el);
  page.show();
  window.addEventListener("focus", () => page.show());
}
