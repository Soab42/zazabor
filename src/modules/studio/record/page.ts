import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Config } from "../../../config";
import { open } from "../../../shared/dialog";
import { windowLabel } from "../../../shell/windows";
import { basename, h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { videoThumbUrl } from "../../video/api";
import { errorText } from "../../time/api";
import { editApi } from "../video/api";
import { clock, onArea, onDevices, onFinished, onLevel, onStatus, recApi, recordPrefs, size, type Area, type Corner, type Finished, type Quality, type Recording, type Sources, type StartSpec, type Status } from "./api";
import "./record.css";

/** What the recorder page needs from where it's shown (Studio, or the recorder window). */
export interface RecorderHost {
  config: Config;
  saveConfig(): void;
  toast(text: string, action?: { label: string; run: () => void }): void;
  /** Starts a Video Editor project with the recording. */
  openInEditor(path: string): void;
  showInFiles(path: string): void;
  /** Opens a folder in Files. */
  showFolder(path: string): void;
  /** Plays a recording in Zazabor's player. */
  play(path: string): void;
  /** A recording just finished here (Studio shows its Record page). */
  finished?(): void;
}

const QUALITIES: [Quality, string, string][] = [
  ["standard", "Standard", "1080p · 30 fps"],
  ["smooth", "Smooth", "60 fps, for games and motion"],
  ["small", "Small file", "720p · easy to share"],
];

const CORNERS: [Corner, string][] = [["top-left", "Top left"], ["top-right", "Top right"], ["bottom-left", "Bottom left"], ["bottom-right", "Bottom right"]];

/**
 * The screen recorder: choose what to record (the screen, a window or an area), sound, the
 * camera bubble and the quality, then Start. A recording ends in the review: play it, trim the
 * start and end, open it in the Video Editor, copy or delete it. Below, the recordings so far.
 * Shown by Studio → Record and by the recorder window (`zazabor --record`, `compact`).
 */
export function createRecorderPage(host: RecorderHost, compact = false) {
  const prefs = () => recordPrefs(host.config);
  let sources: Sources | null = null;
  let windowXid: number | null = null;
  let status: Status = { phase: "idle", countdown: 0, elapsed: 0, mic: false, muted: false, hideBar: false, warning: null, origin: "" };
  const unlisten: Promise<UnlistenFn>[] = [];
  const idle = () => !status.phase || status.phase === "idle";
  let metering = false;

  const save = () => host.saveConfig();

  // ---- step 1: what to record

  const targetCard = (id: "screen" | "window" | "area", glyph: IconName, title: string, sub: string) => {
    const b = h("button", { class: "rec-card", type: "button", "aria-pressed": "false", onclick: () => setTarget(id) },
      h("span", { class: "rec-card-icon" }, icon(glyph, 26)), h("span", { class: "rec-card-title" }, title), h("span", { class: "rec-card-sub" }, sub));
    return [id, b] as const;
  };
  const cards = [
    targetCard("screen", "recScreen", "Full Screen", "Everything on a screen"),
    targetCard("window", "recWindow", "A Window", "One app, even when it moves"),
    targetCard("area", "recArea", "An Area", "Drag a box on the screen"),
  ];
  const targetDetail = h("div", { class: "rec-detail" });

  function setTarget(id: "screen" | "window" | "area") {
    prefs().target = id;
    save();
    draw();
    if (id === "area" && !prefs().area) void pickArea();
  }

  function drawTarget() {
    const p = prefs();
    for (const [id, b] of cards) {
      b.classList.toggle("active", p.target === id);
      b.setAttribute("aria-pressed", String(p.target === id));
    }
    const monitors = sources?.monitors ?? [];
    if (p.target === "screen") {
      if (p.monitor >= monitors.length || (p.monitor < 0 && monitors.length < 2)) p.monitor = 0;
      const all = monitors.length > 1 ? [screenChip("All screens", allBox(monitors), -1)] : [];
      targetDetail.replaceChildren(monitors.length > 1
        ? h("div", { class: "rec-screens", role: "radiogroup", "aria-label": "Screen" }, ...monitors.map((m, i) => screenChip(m.label, m, i)), ...all)
        : h("p", { class: "rec-note" }, monitors[0] ? `Your screen · ${monitors[0].width} × ${monitors[0].height}` : "Your screen"));
    } else if (p.target === "window") {
      const list = sources?.windows ?? [];
      if (windowXid !== null && !list.some((w) => w.xid === windowXid)) windowXid = null;
      targetDetail.replaceChildren(
        list.length
          ? h("div", { class: "rec-windows", role: "listbox", "aria-label": "Windows" }, ...list.map((w) => h("button", {
            class: `rec-window${w.xid === windowXid ? " active" : ""}`, type: "button", role: "option", "aria-selected": String(w.xid === windowXid), title: w.title,
            onclick: () => ((windowXid = w.xid), drawTarget(), drawStart()),
          },
          w.icon ? h("img", { class: "rec-window-icon", src: w.icon, alt: "" }) : h("span", { class: "rec-window-icon blank" }, icon("recWindow", 16)),
          h("span", { class: "rec-window-text" }, h("span", { class: "rec-window-title" }, w.title), h("span", { class: "rec-window-app" }, `${w.app || "App"} · ${w.width} × ${w.height}${w.minimized ? " · minimised" : ""}`)))))
          : h("p", { class: "rec-note" }, "No windows are open."),
        h("button", { class: "btn small ghost", type: "button", onclick: () => void refresh() }, icon("refresh", 13), "Refresh the list"));
    } else {
      const a = p.area;
      // With several screens, which one the box is drawn on.
      const on = monitors.length > 1 ? h("div", { class: "rec-chips", role: "radiogroup", "aria-label": "Draw on" }, ...monitors.map((m, i) => h("button", {
        class: `rec-chip${Math.max(0, p.monitor) === i ? " active" : ""}`, type: "button", role: "radio", "aria-checked": String(Math.max(0, p.monitor) === i),
        onclick: () => ((p.monitor = i), save(), drawTarget()),
      }, icon("recScreen", 14), m.label))) : null;
      targetDetail.replaceChildren(...(on ? [h("span", { class: "rec-field-label" }, "Draw on"), on] : []), h("div", { class: "rec-inline" },
        h("span", { class: "rec-note" }, a ? `${a.width} × ${a.height} area` : "No area yet."),
        h("button", { class: "btn small", type: "button", onclick: () => void pickArea() }, icon("recArea", 14), a ? "Draw Again" : "Draw an Area")));
    }
  }

  // A small still of each screen on its button, taken once per layout.
  const thumbs = new Map<string, string>();
  const boxKey = (a: Area) => `${a.x},${a.y},${a.width},${a.height}`;
  const allBox = (ms: Area[]): Area => {
    const x = Math.min(...ms.map((m) => m.x)), y = Math.min(...ms.map((m) => m.y));
    return { x, y, width: Math.max(...ms.map((m) => m.x + m.width)) - x, height: Math.max(...ms.map((m) => m.y + m.height)) - y };
  };
  function screenChip(label: string, box: Area, index: number) {
    const p = prefs();
    const active = p.monitor === index;
    const url = thumbs.get(boxKey(box));
    if (url === undefined) {
      thumbs.set(boxKey(box), "");
      void recApi.still(box).then((jpeg) => {
        thumbs.set(boxKey(box), URL.createObjectURL(new Blob([jpeg as BlobPart], { type: "image/jpeg" })));
        if (prefs().target === "screen") drawTarget();
      }, () => undefined);
    }
    return h("button", {
      class: `rec-screen${active ? " active" : ""}`, type: "button", role: "radio", "aria-checked": String(active),
      onclick: () => ((p.monitor = index), save(), drawTarget()),
    },
    h("span", { class: "rec-screen-shot", style: `aspect-ratio: ${box.width} / ${box.height}` }, url ? h("img", { src: url, alt: "" }) : icon("recScreen", 22)),
    h("span", { class: "rec-screen-label" }, label), h("span", { class: "rec-screen-size" }, `${box.width} × ${box.height}`));
  }

  async function pickArea() {
    try {
      await recApi.pickArea(Math.max(0, prefs().monitor));
    } catch (err) {
      host.toast(errorText(err));
    }
  }

  // ---- step 2: sound, camera, quality

  const toggle = (label: string, hint: string, glyph: IconName, get: () => boolean, set: (on: boolean) => void) => {
    const input = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": label });
    input.addEventListener("change", () => (set(input.checked), save(), draw()));
    const row = h("label", { class: "rec-toggle" }, h("span", { class: "rec-toggle-icon" }, icon(glyph, 18)),
      h("span", { class: "rec-toggle-text" }, h("span", { class: "rec-toggle-label" }, label), h("span", { class: "rec-toggle-hint" }, hint)), input);
    return { row, sync: () => (input.checked = get()) };
  };
  const systemToggle = toggle("System sound", "What you hear from the speakers", "recSystem", () => prefs().systemSound, (on) => (prefs().systemSound = on));
  const micToggle = toggle("Microphone", "Your voice", "veMic", () => prefs().mic, (on) => (prefs().mic = on));
  const meterFill = h("span", { class: "rec-meter-fill" });
  const meter = h("div", { class: "rec-meter", title: "Microphone level" }, meterFill);
  const micSelect = h("select", { class: "rec-select", "aria-label": "Microphone" });
  micSelect.addEventListener("change", () => ((prefs().micId = micSelect.value || null), save(), void restartMeter()));
  const micRow = h("div", { class: "rec-mic" }, meter, micSelect);
  const micHint = h("p", { class: "rec-note rec-hint" });
  const cameraSelect = h("select", { class: "rec-select", "aria-label": "Camera" });
  cameraSelect.addEventListener("change", () => ((prefs().cameraId = cameraSelect.value || null), save()));
  const cameraToggle = toggle("Camera", "You in a round bubble, in a corner", "recCamera", () => prefs().camera !== null, (on) => (prefs().camera = on ? "bottom-right" : null));
  const corners = h("div", { class: "rec-corners", role: "radiogroup", "aria-label": "Camera corner" });
  const quality = h("div", { class: "rec-quality", role: "radiogroup", "aria-label": "Quality" });

  function drawSound() {
    const p = prefs();
    systemToggle.sync();
    micToggle.sync();
    cameraToggle.sync();
    const mics = sources?.mics ?? [];
    micSelect.replaceChildren(...mics.map((m) => h("option", { value: m.id }, m.name)));
    if (p.micId && mics.some((m) => m.id === p.micId)) micSelect.value = p.micId;
    micSelect.hidden = mics.length < 2;
    micRow.hidden = !p.mic;
    const mic = mics.find((m) => m.id === micSelect.value) ?? mics[0];
    micHint.textContent = mic?.hint ?? "";
    micHint.hidden = !p.mic || !mic?.hint;
    const cameras = sources?.cameras ?? [];
    cameraSelect.replaceChildren(...cameras.map((c) => h("option", { value: c.path }, c.name)));
    if (p.cameraId && cameras.some((c) => c.path === p.cameraId)) cameraSelect.value = p.cameraId;
    cameraSelect.hidden = cameras.length < 2 || p.camera === null;
    cameraToggle.row.hidden = !cameras.length;
    corners.hidden = !cameras.length || p.camera === null;
    corners.replaceChildren(...CORNERS.map(([id, label]) => h("button", {
      class: `rec-corner ${id}${p.camera === id ? " active" : ""}`, type: "button", role: "radio", "aria-checked": String(p.camera === id), title: label, "aria-label": label,
      onclick: () => ((p.camera = id), save(), drawSound()),
    }, h("span", { class: "rec-corner-dot" }))));
    quality.replaceChildren(...QUALITIES.map(([id, label, sub]) => h("button", {
      class: `rec-q${p.quality === id ? " active" : ""}`, type: "button", role: "radio", "aria-checked": String(p.quality === id),
      onclick: () => ((p.quality = id), save(), drawSound()),
    }, h("span", { class: "rec-q-label" }, label), h("span", { class: "rec-q-sub" }, sub))));
    void restartMeter();
  }

  async function restartMeter() {
    const want = prefs().mic && !root.hidden && root.isConnected && view === "setup" && idle();
    if (!want) {
      if (metering) {
        metering = false;
        meterFill.style.width = "0%";
        void recApi.meterStop().catch(() => undefined);
      }
      return;
    }
    try {
      await recApi.meterStart(prefs().micId);
      metering = true;
    } catch {
      metering = false;
    }
  }
  unlisten.push(onLevel((db) => {
    if (!metering) return;
    // -60 dB is silence, 0 dB the loudest.
    meterFill.style.width = `${Math.round(Math.min(1, Math.max(0, (db + 60) / 60)) * 100)}%`;
  }));

  // ---- more options

  const more = h("details", { class: "rec-more" });
  const formatSeg = h("div", { class: "segmented" });
  const countdownToggle = toggle("Countdown", "3, 2, 1 before it starts", "clock", () => prefs().countdown, (on) => (prefs().countdown = on));
  const hideBarToggle = toggle("Hide the control bar", "Stop with the shortcut instead (it isn't recorded then)", "recRecord", () => prefs().hideBar, (on) => (prefs().hideBar = on));
  const outputSelect = h("select", { class: "rec-select", "aria-label": "System sound from" });
  outputSelect.addEventListener("change", () => ((prefs().outputId = outputSelect.value || null), save()));
  const outputField = h("div", { class: "rec-field" }, h("span", { class: "rec-field-label" }, "System sound from"), outputSelect);
  const folderText = h("span", { class: "rec-folder-path" });
  const folderRow = h("div", { class: "rec-inline" }, icon("folder", 15), folderText,
    h("button", { class: "btn small ghost", type: "button", onclick: () => void chooseFolder() }, "Change…"));

  function drawMore() {
    const p = prefs();
    const formats = sources?.formats ?? ["mp4", "webm"];
    if (!formats.includes(p.format) && formats.length) p.format = formats[0];
    formatSeg.replaceChildren(...(["mp4", "webm"] as const).map((f) => h("button", {
      type: "button", class: p.format === f ? "active" : "", disabled: !formats.includes(f),
      onclick: () => ((p.format = f), save(), drawMore()),
    }, f === "mp4" ? "MP4 (plays everywhere)" : "WebM (open format)")));
    const outputs = sources?.outputs ?? [];
    outputSelect.replaceChildren(h("option", { value: "" }, "The output in use (follows your sound settings)"), ...outputs.map((o) => h("option", { value: o.id }, o.name)));
    outputSelect.value = p.outputId && outputs.some((o) => o.id === p.outputId) ? p.outputId : "";
    outputField.hidden = !outputs.length;
    countdownToggle.sync();
    hideBarToggle.sync();
    folderText.textContent = (sources?.folder ?? "~/Videos/Recordings").replace(/^\/home\/[^/]+/, "~");
  }

  async function chooseFolder() {
    const picked = await open({ title: "Save Recordings In", directory: true }).catch(() => null);
    const folder = Array.isArray(picked) ? picked[0] : picked;
    if (!folder) return;
    prefs().folder = folder;
    save();
    await refresh();
  }

  more.append(h("summary", null, "More options"),
    h("div", { class: "rec-more-body" },
      h("div", { class: "rec-field" }, h("span", { class: "rec-field-label" }, "Format"), formatSeg),
      outputField,
      countdownToggle.row, hideBarToggle.row,
      h("div", { class: "rec-field" }, h("span", { class: "rec-field-label" }, "Save in"), folderRow)));

  // ---- start

  const startButton = h("button", { class: "rec-start", type: "button", onclick: () => void start() }, h("span", { class: "rec-start-dot" }), "Start Recording");
  const startHint = h("p", { class: "rec-start-hint" });
  const banner = h("div", { class: "rec-banner", role: "alert", hidden: true });

  function drawStart() {
    const p = prefs();
    const unsupported = sources?.unsupported ?? null;
    banner.hidden = !unsupported;
    banner.textContent = unsupported ?? "";
    const missing = p.target === "window" && windowXid === null ? "Pick a window to record." : p.target === "area" && !p.area ? "Draw an area to record." : null;
    startButton.disabled = !!unsupported || !!missing || !idle();
    startHint.textContent = missing ?? (!idle() ? "A recording is running." : prefs().hideBar ? "Stop with the shortcut, or by opening the recorder again." : "Stop with the red button on the bar that appears.");
  }

  function spec(): StartSpec | null {
    const p = prefs();
    const target = p.target === "screen" ? (p.monitor < 0 ? { kind: "all" as const } : { kind: "screen" as const, monitor: p.monitor })
      : p.target === "window" ? (windowXid === null ? null : { kind: "window" as const, xid: windowXid })
      : p.area ? { kind: "area" as const, ...p.area } : null;
    if (!target) return null;
    return {
      target, systemSound: p.systemSound, mic: p.mic, micId: p.micId, outputId: p.outputId,
      camera: sources?.cameras.length ? p.camera : null, cameraId: sources?.cameras.some((c) => c.path === p.cameraId) ? p.cameraId : null,
      quality: p.quality, format: p.format, countdown: p.countdown, hideBar: p.hideBar, folder: p.folder,
    };
  }

  async function start() {
    const s = spec();
    if (!s) return drawStart();
    startButton.disabled = true;
    try {
      await recApi.meterStop().catch(() => undefined);
      metering = false;
      await recApi.start(s);
      // Out of the way while recording; it comes back with the review.
      await getCurrentWindow().minimize().catch(() => undefined);
    } catch (err) {
      host.toast(errorText(err));
      drawStart();
    }
  }

  // ---- the review

  const review = h("section", { class: "rec-review", hidden: true });
  let reviewing: { path: string; seconds: number; start: number; end: number } | null = null;

  function openReview(path: string, seconds: number) {
    reviewing = { path, seconds, start: 0, end: seconds };
    view = "review";
    draw();
    void fillReview();
  }

  async function fillReview() {
    const r = reviewing;
    if (!r) return;
    const name = basename(r.path).replace(/\.[^.]+$/, "");
    const thumb = h("img", { class: "rec-preview-img", alt: "", src: videoThumbUrl(r.path, Date.now() / 1000, 720) });
    const stripBox = h("div", { class: "rec-strip" });
    const selection = h("div", { class: "rec-sel" });
    const left = h("span", { class: "rec-handle left", title: "Drag to cut the start", role: "slider", "aria-label": "Start" });
    const right = h("span", { class: "rec-handle right", title: "Drag to cut the end", role: "slider", "aria-label": "End" });
    selection.append(left, right);
    stripBox.append(selection);
    const times = h("div", { class: "rec-times" });
    const info = h("p", { class: "rec-note" });
    const drawSel = () => {
      const d = Math.max(0.001, r.seconds);
      selection.style.left = `${(r.start / d) * 100}%`;
      selection.style.width = `${((r.end - r.start) / d) * 100}%`;
      const cut = r.start > 0.05 || r.end < r.seconds - 0.05;
      times.replaceChildren(h("span", null, clock(r.start)), h("span", { class: "rec-times-len" }, cut ? `${clock(r.end - r.start)} kept` : `${clock(r.seconds)} long`), h("span", null, clock(r.end)));
      saveButton.textContent = cut ? "Save Trimmed" : "Save";
    };
    const drag = (which: "start" | "end") => (e: PointerEvent) => {
      e.preventDefault();
      const box = stripBox.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const t = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)) * r.seconds;
        if (which === "start") r.start = Math.min(t, r.end - 1);
        else r.end = Math.max(t, r.start + 1);
        r.start = Math.max(0, r.start);
        r.end = Math.min(r.seconds, r.end);
        drawSel();
      };
      const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    left.addEventListener("pointerdown", drag("start"));
    right.addEventListener("pointerdown", drag("end"));
    const saveButton = h("button", { class: "btn primary", type: "button", onclick: () => void keep() }, "Save");
    async function keep() {
      if (!r) return;
      const cut = r.start > 0.05 || r.end < r.seconds - 0.05;
      saveButton.disabled = true;
      try {
        if (cut) await recApi.trim(r.path, r.start, r.end);
        host.toast(cut ? "Trimmed and saved in Recordings" : "Saved in Recordings", { label: "Show in Files", run: () => host.showInFiles(r.path) });
        closeReview();
      } catch (err) {
        host.toast(errorText(err));
        saveButton.disabled = false;
      }
    }
    review.replaceChildren(
      h("div", { class: "rec-review-head" },
        h("button", { class: "icon-btn", type: "button", title: "Back", "aria-label": "Back", onclick: () => closeReview() }, icon("back", 18)),
        h("div", { class: "rec-review-title" }, h("h2", null, "Your recording"), h("span", { class: "rec-note" }, name))),
      h("button", { class: "rec-preview", type: "button", title: "Play", onclick: () => host.play(r.path) }, thumb, h("span", { class: "rec-play" }, icon("play", 30))),
      h("div", { class: "rec-trim" }, h("div", { class: "rec-trim-label" }, icon("cut", 14), "Trim the start and end"), stripBox, times),
      info,
      h("div", { class: "rec-actions" },
        saveButton,
        h("button", { class: "btn", type: "button", onclick: () => host.openInEditor(r.path) }, icon("videoEdit", 15), "Open in Video Editor"),
        h("button", { class: "btn", type: "button", onclick: () => void recApi.copyFile(r.path).then(() => host.toast("Copied. Paste it in Files, a chat or an email."), (err) => host.toast(errorText(err))) }, icon("copy", 15), "Copy File"),
        h("button", { class: "btn", type: "button", onclick: () => host.showInFiles(r.path) }, icon("folder", 15), "Show in Files"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn ghost rec-danger", type: "button", onclick: () => void removeRecording(r.path, true) }, icon("trash", 15), "Delete")));
    drawSel();
    try {
      const probe = await editApi.probe(r.path);
      if (reviewing !== r) return;
      if (probe.duration > 0) {
        const wasWhole = r.end >= r.seconds - 0.05;
        r.seconds = probe.duration;
        if (wasWhole) r.end = probe.duration;
        drawSel();
      }
      const v = probe.video;
      info.textContent = [v ? `${v.width} × ${v.height}` : null, v?.fps ? `${Math.round(v.fps)} fps` : null, size(probe.bytes), probe.audio ? "with sound" : "no sound"].filter(Boolean).join(" · ");
      if (v) {
        const count = compact ? 8 : 12;
        const strip = await editApi.strip({ path: r.path, width: v.width, height: v.height, duration: probe.duration, thumbHeight: 72, count });
        if (reviewing !== r) return;
        const url = URL.createObjectURL(strip.jpeg);
        stripBox.style.backgroundImage = `url("${url}")`;
      }
    } catch (err) {
      // A file another app is still writing, or one GStreamer can't read: no strip.
      console.warn("Recorder strip:", err);
    }
  }

  function closeReview() {
    reviewing = null;
    view = "setup";
    draw();
    void refreshList();
  }

  async function removeRecording(path: string, inReview = false) {
    try {
      await recApi.remove(path);
      host.toast("Recording deleted");
      if (inReview) closeReview();
      else void refreshList();
    } catch (err) {
      host.toast(errorText(err));
    }
  }

  // ---- recordings so far

  const listBox = h("div", { class: "rec-list" });
  const listHead = h("div", { class: "rec-list-head" }, h("h2", null, "Recordings"), h("span", { class: "spacer" }),
    h("button", { class: "btn small ghost", type: "button", onclick: () => sources && host.showFolder(sources.folder) }, icon("folder", 14), "Open Folder"));

  async function refreshList() {
    let items: Recording[] = [];
    try {
      items = await recApi.list(prefs().folder);
    } catch {
      items = [];
    }
    if (!items.length) {
      listBox.replaceChildren(h("p", { class: "rec-empty" }, "Your recordings show up here. They're saved in your Videos folder, under Recordings."));
      return;
    }
    listBox.replaceChildren(...items.slice(0, compact ? 8 : 24).map((item) => {
      const when = new Date(item.mtime * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const len = h("span", { class: "rec-row-len" });
      const row = h("div", { class: `rec-row${item.recovered ? " recovered" : ""}`, role: "button", tabindex: "0", title: item.path },
        h("img", { class: "rec-row-thumb", alt: "", loading: "lazy", src: videoThumbUrl(item.path, item.mtime, 160) }),
        h("span", { class: "rec-row-text" }, h("span", { class: "rec-row-name" }, item.name),
          h("span", { class: "rec-row-sub" }, item.recovered ? "Recovered after Zazabor stopped · " : "", when, " · ", size(item.bytes))),
        len,
        item.recovered ? h("button", { class: "btn small", type: "button", onclick: (e: Event) => (e.stopPropagation(), void recApi.keep(item.path).then(() => refreshList(), (err) => host.toast(errorText(err)))) }, "Keep") : null,
        h("button", { class: "icon-btn small", type: "button", title: "More", "aria-label": "More", onclick: (e: MouseEvent) => (e.stopPropagation(), menu(e, item)) }, icon("more", 15)));
      row.addEventListener("click", () => openReview(item.path, 0));
      row.addEventListener("dblclick", () => host.play(item.path));
      row.addEventListener("keydown", (e) => e.key === "Enter" && openReview(item.path, 0));
      row.addEventListener("contextmenu", (e) => (e.preventDefault(), menu(e, item)));
      void editApi.probe(item.path).then((p) => (len.textContent = p.duration > 0 ? clock(p.duration) : ""), () => undefined);
      return row;
    }));
  }

  function menu(e: MouseEvent, item: Recording) {
    openMenu(e.clientX, e.clientY, [
      { label: "Play", icon: "play", action: () => host.play(item.path) },
      { label: "Trim…", icon: "cut", action: () => openReview(item.path, 0) },
      { label: "Open in Video Editor", icon: "videoEdit", action: () => host.openInEditor(item.path) },
      { label: "Copy File", icon: "copy", action: () => void recApi.copyFile(item.path).then(() => host.toast("Copied"), (err) => host.toast(errorText(err))) },
      { label: "Show in Files", icon: "folder", action: () => host.showInFiles(item.path) },
      "separator",
      { label: "Delete", icon: "trash", danger: true, action: () => void removeRecording(item.path) },
    ]);
  }

  // ---- layout

  let view: "setup" | "review" = "setup";
  const step = (n: number, title: string, ...body: Node[]) => h("section", { class: "rec-step" }, h("h3", { class: "rec-step-title" }, h("span", { class: "rec-step-n" }, String(n)), title), ...body);
  const setup = h("div", { class: "rec-setup" },
    banner,
    step(1, "What to record", h("div", { class: "rec-cards" }, ...cards.map(([, b]) => b)), targetDetail),
    step(2, "Sound and camera", systemToggle.row, micToggle.row, micRow, micHint, cameraToggle.row, h("div", { class: "rec-camera" }, corners, cameraSelect)),
    step(3, "Quality", quality),
    more,
    h("div", { class: "rec-go" }, startButton, startHint));
  const intro = h("div", { class: "rec-intro" }, h("h1", null, "Screen Recorder"),
    h("p", { class: "of-hub-sub" }, "Record your screen, a window or an area, with sound. Trim it afterwards, or open it in the Video Editor. Nothing is uploaded."));
  const listSection = h("section", { class: "rec-recordings" }, listHead, listBox);
  const root = h("div", { class: `rec-page${compact ? " compact" : ""}` }, intro, h("div", { class: "rec-columns" }, h("div", { class: "rec-main" }, setup, review), listSection));

  function draw() {
    setup.hidden = view !== "setup";
    review.hidden = view !== "review";
    intro.hidden = view === "review" && compact;
    listSection.hidden = view === "review" && compact;
    drawTarget();
    drawSound();
    drawMore();
    drawStart();
  }

  async function refresh() {
    try {
      sources = await recApi.sources(prefs().folder);
    } catch (err) {
      host.toast(errorText(err));
    }
    draw();
    void refreshList();
  }

  // ---- events from the backend

  unlisten.push(onStatus((s) => {
    status = s;
    drawStart();
  }));
  unlisten.push(onArea((area: Area | null) => {
    if (!area) return;
    prefs().area = area;
    prefs().target = "area";
    save();
    draw();
  }));
  const finishedHere = (f: Finished) => {
    if (f.origin !== windowLabel) return;
    if (f.error && !f.path) host.toast(f.error);
    else if (f.error) host.toast(f.error);
    if (f.discarded) {
      if (!f.error) host.toast("Recording discarded");
      view = "setup";
      draw();
      return;
    }
    if (f.path) {
      host.finished?.();
      openReview(f.path, f.seconds);
    }
  };
  unlisten.push(onFinished(finishedHere));
  // A screen, microphone or camera plugged in or out: list again.
  unlisten.push(onDevices(() => void refresh()));
  void recApi.status().then((s) => ((status = s), drawStart()), () => undefined);

  return {
    el: root,
    /** Shown: read the screens, windows and recordings again. */
    show() {
      void refresh();
      void recApi.watch().catch(() => undefined);
      void recApi.takeFinished().then((f) => f && finishedHere(f), () => undefined);
    },
    hide() {
      void recApi.unwatch().catch(() => undefined);
      metering = false;
      void recApi.meterStop().catch(() => undefined);
    },
    review: openReview,
    dispose() {
      void recApi.unwatch().catch(() => undefined);
      void recApi.meterStop().catch(() => undefined);
      for (const u of unlisten) void u.then((fn) => fn());
      root.remove();
    },
    folder: () => sources?.folder ?? null,
  };
}
