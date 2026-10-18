import { basename, h } from "../../../../ui/dom";
import { videoApi } from "../../api";
import type { PanelTab, VideoContext } from "../../extensions";
import { formatTime } from "../../format";
import { panelApi, type MediaMeta, type StreamInfo } from "../../panel-api";
import { note, section, slider, toggle } from "./ui";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Sleep timer choices in minutes; "end" stops when the video ends. */
const SLEEP_CHOICES: { id: string; label: string; minutes?: number }[] = [
  { id: "off", label: "Off" },
  { id: "15", label: "15 min", minutes: 15 },
  { id: "30", label: "30 min", minutes: 30 },
  { id: "45", label: "45 min", minutes: 45 },
  { id: "60", label: "60 min", minutes: 60 },
  { id: "end", label: "End of video" },
];
/** The volume fades out over this long before the timer pauses playback. */
export const FADE_MS = 10_000;
const TICK_MS = 500;

/** Volume (0–1.25 scale of `base`) while fading with `remaining` ms left; 1 outside the fade. */
export function fadeFactor(remaining: number, fade = FADE_MS): number {
  return Math.max(0, Math.min(1, remaining / fade));
}

const speedLabel = (v: number) => `${+v.toFixed(2)}×`;

const channelsLabel = (n: number) => (n === 1 ? "Mono" : n === 2 ? "Stereo" : n === 6 ? "5.1" : n === 8 ? "7.1" : n > 0 ? `${n} channels` : "");

const describeStream = (s: StreamInfo, kind: "video" | "audio") => {
  const parts: string[] = [s.codec];
  if (kind === "video") {
    if (s.width) parts.push(`${s.width}×${s.height}`);
    if (s.fps) parts.push(`${+s.fps.toFixed(2)} fps`);
  } else {
    const ch = channelsLabel(s.channels);
    if (ch) parts.push(ch);
    if (s.sampleRate) parts.push(`${+(s.sampleRate / 1000).toFixed(1)} kHz`);
    if (s.language && s.language !== "und") parts.push(s.language);
  }
  if (s.bitrate) parts.push(`${Math.round(s.bitrate / 1000)} kbit/s`);
  return parts.join(" · ");
};

const formatSize = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

/** The Playback tab: speed, sleep timer, the timeline switch and the file's details. */
export function createPlaybackTab(ctx: VideoContext, timeline: { get(): boolean; set(on: boolean): void }): { tab: PanelTab; dispose(): void } {
  const { player } = ctx;
  let visible = false;
  let path: string | null = null;

  // ---- speed -------------------------------------------------------------------------------
  let rate = 1;
  let dragging = false;
  const setRate = (v: number) => {
    rate = Math.round(Math.min(4, Math.max(0.25, v)) * 100) / 100;
    speedSlider.set(rate);
    markSpeeds();
    void videoApi.setRate(rate).catch(() => undefined);
  };
  const speedSlider = slider({ label: "Speed", min: 0.25, max: 4, step: 0.05, value: 1, format: speedLabel, onInput: (v) => {
    rate = v;
    markSpeeds();
    void videoApi.setRate(v).catch(() => undefined);
  }, resetTo: 1 });
  speedSlider.el.addEventListener("pointerdown", () => (dragging = true));
  window.addEventListener("pointerup", () => (dragging = false));
  const speedButtons = SPEEDS.map((v) => h("button", { type: "button", class: "pp-chip-btn", onclick: () => setRate(v) }, speedLabel(v)));
  const speeds = h("div", { class: "pp-chips", role: "group", "aria-label": "Speed presets" }, ...speedButtons);
  function markSpeeds() {
    SPEEDS.forEach((v, i) => speedButtons[i].classList.toggle("active", Math.abs(v - rate) < 0.001));
  }

  // ---- sleep timer -------------------------------------------------------------------------
  let sleep: { mode: string; until: number } | null = null;
  let sleepTimer = 0;
  let fading = false;
  let lastFade = 0;
  const sleepButtons = SLEEP_CHOICES.map((c) => h("button", { type: "button", class: "pp-chip-btn", onclick: () => startSleep(c.id) }, c.label));
  const sleepStatus = h("p", { class: "pp-note", role: "status" });

  function restoreVolume() {
    if (!fading) return;
    fading = false;
    void videoApi.setVolume(ctx.shell.config.video.volume).catch(() => undefined);
  }

  function stopSleep() {
    clearInterval(sleepTimer);
    sleep = null;
    restoreVolume();
    markSleep();
  }

  function startSleep(id: string) {
    stopSleep();
    const choice = SLEEP_CHOICES.find((c) => c.id === id);
    if (!choice || id === "off") {
      ctx.showOsd("Sleep timer off");
      return;
    }
    sleep = { mode: id, until: choice.minutes ? Date.now() + choice.minutes * 60_000 : 0 };
    sleepTimer = window.setInterval(tickSleep, TICK_MS);
    ctx.showOsd(choice.minutes ? `Sleep timer: ${choice.minutes} minutes` : "Sleep timer: end of video");
    markSleep();
    tickSleep();
  }

  /** Milliseconds until the timer fires, or null when it can't tell yet. */
  function remainingMs(): number | null {
    if (!sleep) return null;
    if (sleep.mode !== "end") return sleep.until - Date.now();
    const { length, time, rate: r } = player.state;
    return length > 0 ? (length - time) / Math.max(0.25, r) : null;
  }

  function tickSleep() {
    const remaining = remainingMs();
    if (remaining === null || !sleep) return;
    if (remaining <= 0) {
      const end = sleep.mode === "end";
      stopSleep();
      void videoApi.setPaused(true).catch(() => undefined);
      // Put the volume back once the sound has stopped, so the next play isn't silent.
      window.setTimeout(() => void videoApi.setVolume(ctx.shell.config.video.volume).catch(() => undefined), 400);
      ctx.showOsd(end ? "Reached the end" : "Sleep timer: paused");
      return;
    }
    if (remaining <= FADE_MS && player.state.playing) {
      fading = true;
      const now = performance.now();
      if (now - lastFade > 200) {
        lastFade = now;
        void videoApi.setVolume(ctx.shell.config.video.volume * fadeFactor(remaining)).catch(() => undefined);
      }
    }
    sleepStatus.textContent = `Pausing in ${formatTime(Math.max(0, remaining))}`;
  }

  function markSleep() {
    SLEEP_CHOICES.forEach((c, i) => sleepButtons[i].classList.toggle("active", (sleep?.mode ?? "off") === c.id));
    if (!sleep) sleepStatus.textContent = "Pauses playback and fades the sound out.";
  }

  // ---- metadata ----------------------------------------------------------------------------
  const metaBox = h("dl", { class: "pp-meta" });
  let metaPath: string | null = null;
  let metaTimer = 0;
  const addRow = (label: string, value: string | null | undefined) => {
    if (!value) return;
    metaBox.append(h("dt", null, label), h("dd", null, value));
  };

  function renderMeta(meta: MediaMeta | null) {
    metaBox.replaceChildren();
    const state = player.state;
    if (!state.path) {
      metaBox.append(note("Nothing is playing."));
      return;
    }
    addRow("Title", meta?.title ?? basename(state.path));
    addRow("Artist", meta?.artist);
    addRow("Album", meta?.album);
    addRow("Genre", meta?.genre);
    addRow("Date", meta?.date);
    addRow("Duration", state.length ? formatTime(state.length) : null);
    if (meta) {
      meta.video.forEach((s, i) => addRow(meta.video.length > 1 ? `Video ${i + 1}` : "Video", describeStream(s, "video")));
      meta.audio.forEach((s, i) => addRow(meta.audio.length > 1 ? `Audio ${i + 1}` : "Audio", describeStream(s, "audio")));
      if (meta.subtitles.length) addRow("Subtitles", `${meta.subtitles.length} in the file`);
      addRow("Bitrate", meta.bitrateKbps ? `${meta.bitrateKbps.toLocaleString()} kbit/s` : null);
      addRow("Size", meta.size ? formatSize(meta.size) : null);
    } else if (state.videoWidth) {
      addRow("Resolution", `${state.videoWidth}×${state.videoHeight}`);
    }
    addRow("Location", state.path);
  }

  function loadMeta() {
    const file = player.state.path;
    if (!file) {
      metaPath = null;
      renderMeta(null);
      return;
    }
    if (file === metaPath) return;
    metaPath = file;
    renderMeta(null);
    clearTimeout(metaTimer);
    // The details are known once playback has started.
    metaTimer = window.setTimeout(async () => {
      if (!visible || player.state.path !== file) {
        metaPath = null;
        return;
      }
      try {
        const meta = await panelApi.meta();
        if (player.state.path === file) renderMeta(meta);
      } catch {
        // keep the basic rows
      }
    }, 700);
  }

  // ---- state ---------------------------------------------------------------------------------
  const timelineToggle = toggle("Show subtitle timeline", timeline.get(), (on) => timeline.set(on), "A strip of subtitle lines over the video; drag it to fix the timing");

  const unsubscribe = player.subscribe(() => {
    const state = player.state;
    if (!dragging && Math.abs(state.rate - rate) > 0.001) {
      rate = state.rate;
      speedSlider.set(rate);
      markSpeeds();
    }
    if (state.path !== path) {
      path = state.path;
      if (!path) {
        metaPath = null;
        renderMeta(null);
      }
      if (sleep?.mode === "end") stopSleep();
      // A new player starts at normal speed.
      rate = state.rate;
      if (visible) loadMeta();
    }
  });

  return {
    tab: {
      id: "playback",
      title: "Playback",
      icon: "speed",
      order: 40,
      render() {
        rate = player.state.rate;
        speedSlider.set(rate);
        markSpeeds();
        markSleep();
        timelineToggle.set(timeline.get());
        return h("div", { class: "pp" },
          section("Speed", speedSlider.el, speeds),
          section("Sleep timer", h("div", { class: "pp-chips", role: "group", "aria-label": "Sleep timer" }, ...sleepButtons), sleepStatus),
          section("Subtitles", timelineToggle.el),
          section("Details", metaBox));
      },
      shown() {
        visible = true;
        timelineToggle.set(timeline.get());
        loadMeta();
      },
      hidden() {
        visible = false;
        clearTimeout(metaTimer);
        metaPath = null;
      },
    },
    dispose() {
      stopSleep();
      clearTimeout(metaTimer);
      unsubscribe();
    },
  };
}
