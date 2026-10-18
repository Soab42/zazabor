import { h } from "../../../../ui/dom";
import { icon, type IconName } from "../../../../ui/icons";
import type { PanelTab, VideoContext } from "../../extensions";
import { panelApi, type EqInfo } from "../../panel-api";
import { LANGUAGES, trackForLanguage } from "../subtitles/language";
import { snapDelay, MAX_DELAY_MS, DELAY_STEP_MS } from "../subtitles/timeline";
import { choiceRow, note, secondsLabel, section, selectRow, slider, toggle } from "./ui";

export interface EqSettings {
  enabled: boolean;
  /** Name of the preset the bands came from, "Custom" once edited. */
  preset: string;
  preamp: number;
  bands: number[];
}

export interface PanelSettings {
  /** Default audio language (two-letter code), "" for none. */
  audioLanguage: string;
  eq: EqSettings;
}

export const PANEL_DEFAULTS: PanelSettings = {
  audioLanguage: "",
  eq: { enabled: false, preset: "Flat", preamp: 0, bands: Array(10).fill(0) },
};

/** Friendly names and a flourish icon for libVLC's preset names. */
const PRESET_LOOK: Record<string, { label: string; icon: IconName }> = {
  Flat: { label: "Flat", icon: "minus" },
  Classical: { label: "Classical", icon: "music" },
  Club: { label: "Club", icon: "star" },
  Dance: { label: "Dance", icon: "speed" },
  "Full bass": { label: "Full bass", icon: "volume" },
  "Full bass and treble": { label: "Bass & treble", icon: "sparkles" },
  "Full treble": { label: "Full treble", icon: "sparkles" },
  Headphones: { label: "Headphones", icon: "music" },
  "Large Hall": { label: "Large hall", icon: "film" },
  Live: { label: "Live", icon: "star" },
  Party: { label: "Party", icon: "sparkles" },
  Pop: { label: "Pop", icon: "star" },
  Reggae: { label: "Reggae", icon: "music" },
  Rock: { label: "Rock", icon: "speed" },
  Ska: { label: "Ska", icon: "speed" },
  Soft: { label: "Soft", icon: "minus" },
  "Soft rock": { label: "Soft rock", icon: "music" },
  Techno: { label: "Techno", icon: "speed" },
};

const SVG = "http://www.w3.org/2000/svg";
const RANGE_DB = 20;

/** A small curve of the band gains, as a preview of the preset. */
export function curveIcon(bands: number[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 60 28");
  svg.setAttribute("class", "pp-curve");
  svg.setAttribute("aria-hidden", "true");
  const mid = document.createElementNS(SVG, "line");
  for (const [k, v] of Object.entries({ x1: 0, x2: 60, y1: 14, y2: 14 })) mid.setAttribute(k, String(v));
  mid.setAttribute("class", "pp-curve-mid");
  const line = document.createElementNS(SVG, "polyline");
  const points = bands.map((g, i) => `${(3 + (i * 54) / Math.max(1, bands.length - 1)).toFixed(1)},${(14 - (Math.max(-12, Math.min(12, g)) / 12) * 11).toFixed(1)}`);
  line.setAttribute("points", points.join(" "));
  line.setAttribute("class", "pp-curve-line");
  svg.append(mid, line);
  return svg;
}

const frequencyLabel = (hz: number) => (hz >= 1000 ? `${+(hz / 1000).toFixed(1)}k` : String(Math.round(hz)));

/** The Audio tab: track, default language, delay and the equalizer. */
export function createAudioTab(ctx: VideoContext, settings: PanelSettings): { tab: PanelTab; dispose(): void } {
  const { player } = ctx;
  const eq = settings.eq;
  const save = () => ctx.shell.saveConfig();
  let info: EqInfo | null = null;
  let delay = 0;
  let path: string | null = null;
  let visible = false;
  let defaultsDone = false;
  let defaultsTries = 0;
  let eqTimer = 0;

  // ---- equalizer ---------------------------------------------------------------------------
  const pushEq = () => {
    clearTimeout(eqTimer);
    eqTimer = window.setTimeout(() => void panelApi.setEqualizer(eq.enabled, eq.preamp, eq.bands).catch(() => undefined), 60);
  };

  const enabled = toggle("Equalizer", eq.enabled, (on) => {
    eq.enabled = on;
    save();
    pushEq();
    renderEq();
  });
  const cards = h("div", { class: "pp-cards", role: "radiogroup", "aria-label": "Equalizer presets" });
  const bandsBox = h("div", { class: "pp-bands" });
  const preamp = slider({ label: "Preamp", min: -RANGE_DB, max: RANGE_DB, step: 0.5, value: eq.preamp, format: (v) => `${v > 0 ? "+" : ""}${v} dB`, onInput: (v) => edited({ preamp: v }), resetTo: 0 });
  const bandInputs: HTMLInputElement[] = [];
  const bandValues: HTMLElement[] = [];

  function edited(patch: Partial<EqSettings>) {
    Object.assign(eq, patch, { preset: "Custom" });
    save();
    pushEq();
    markPreset();
  }

  function applyPreset(name: string) {
    const preset = info?.presets.find((p) => p.name === name);
    if (!preset) return;
    eq.preset = name;
    eq.preamp = preset.preamp;
    eq.bands = [...preset.bands];
    eq.enabled = true;
    save();
    pushEq();
    enabled.set(true);
    syncBands();
    renderEq();
  }

  function markPreset() {
    cards.querySelectorAll<HTMLElement>(".pp-card-preset").forEach((el) => {
      const on = eq.enabled && el.dataset.name === eq.preset;
      el.classList.toggle("selected", on);
      el.setAttribute("aria-checked", String(on));
    });
  }

  function syncBands() {
    preamp.set(eq.preamp);
    eq.bands.forEach((g, i) => {
      if (!bandInputs[i]) return;
      bandInputs[i].value = String(g);
      bandValues[i].textContent = String(Math.round(g));
    });
  }

  function buildBands() {
    if (!info || bandInputs.length) return;
    info.frequencies.forEach((hz, i) => {
      const input = h("input", { type: "range", min: -RANGE_DB, max: RANGE_DB, step: 0.5, "aria-label": `${frequencyLabel(hz)} Hz` });
      input.value = String(eq.bands[i] ?? 0);
      const value = h("span", { class: "pp-band-value" }, String(Math.round(eq.bands[i] ?? 0)));
      input.addEventListener("input", () => {
        const bands = [...eq.bands];
        while (bands.length < info!.frequencies.length) bands.push(0);
        bands[i] = Number(input.value);
        value.textContent = String(Math.round(bands[i]));
        edited({ bands });
      });
      bandInputs.push(input);
      bandValues.push(value);
      bandsBox.append(h("div", { class: "pp-band" }, value, h("div", { class: "pp-band-track" }, input), h("span", { class: "pp-band-hz" }, frequencyLabel(hz))));
    });
  }

  function renderEq() {
    cards.classList.toggle("off", !eq.enabled);
    bandsBox.classList.toggle("off", !eq.enabled);
    markPreset();
  }

  // Rendering and showing the tab both ask; the cards are built once.
  let loading: Promise<void> | null = null;
  function loadInfo(): Promise<void> {
    loading ??= fetchInfo().then((ok) => {
      if (!ok) loading = null;
    });
    return loading;
  }

  async function fetchInfo(): Promise<boolean> {
    try {
      info = await panelApi.eqInfo();
    } catch (err) {
      console.warn("Could not read the equalizer presets:", err);
      return false;
    }
    for (const p of info.presets) {
      const look = PRESET_LOOK[p.name] ?? { label: p.name, icon: "music" as IconName };
      cards.append(h("button", { type: "button", class: "pp-card-preset", role: "radio", "data-name": p.name, "aria-checked": "false", onclick: () => applyPreset(p.name) },
        curveIcon(p.bands), h("span", { class: "pp-card-name" }, icon(look.icon, 12), look.label)));
    }
    buildBands();
    syncBands();
    renderEq();
    return true;
  }

  // ---- track, language, delay --------------------------------------------------------------
  const tracksBox = h("div", { class: "pp-choices", role: "radiogroup", "aria-label": "Audio track" });
  let tracksKey = "";
  function renderTracks() {
    const { audioTracks, audioTrack } = player.state;
    const key = JSON.stringify([audioTracks, audioTrack]);
    if (key === tracksKey) return;
    tracksKey = key;
    tracksBox.replaceChildren(...(audioTracks.length
      ? audioTracks.map((t) => choiceRow(t.name, t.id === audioTrack, () => player.setAudioTrack(t.id)))
      : [note("No audio tracks.")]));
  }

  const language = selectRow("Default language", [{ value: "", label: "Automatic" }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name }))], settings.audioLanguage, (v) => {
    settings.audioLanguage = v;
    save();
  });

  const delaySlider = slider({
    label: "Audio delay", min: -MAX_DELAY_MS, max: MAX_DELAY_MS, step: DELAY_STEP_MS, value: 0, format: secondsLabel,
    onInput: (v) => {
      delay = snapDelay(v);
      void panelApi.setAudioDelay(delay).catch(() => undefined);
    },
    resetTo: 0, title: "Positive plays the sound later, negative earlier",
  });

  /** libVLC forgets the equalizer and delay with every new player, so they go in again. */
  function reapply() {
    void panelApi.setEqualizer(eq.enabled, eq.preamp, eq.bands).catch(() => undefined);
    void panelApi.setAudioDelay(delay).catch(() => undefined);
  }

  function onState() {
    const state = player.state;
    if (state.path !== path) {
      path = state.path;
      delay = 0;
      delaySlider.set(0);
      defaultsDone = false;
      defaultsTries = 0;
      if (path) reapplyWhenPlaying = true;
    }
    if (reapplyWhenPlaying && state.playing) {
      reapplyWhenPlaying = false;
      reapply();
    }
    if (!defaultsDone && state.playing) {
      defaultsTries++;
      if (defaultsTries > 40) defaultsDone = true;
      if (state.audioTracks.length > 0) {
        defaultsDone = true;
        if (state.audioTracks.length > 1 && settings.audioLanguage) {
          const track = trackForLanguage(state.audioTracks, settings.audioLanguage);
          if (track && track.id !== state.audioTrack) player.setAudioTrack(track.id);
        }
      }
    }
    if (visible) renderTracks();
  }
  let reapplyWhenPlaying = false;
  const unsubscribe = player.subscribe(onState);
  onState();

  const tab: PanelTab = {
    id: "audio",
    title: "Audio",
    icon: "volume",
    order: 20,
    render() {
      renderTracks();
      void loadInfo();
      return h("div", { class: "pp" },
        section("Audio track", tracksBox, language.el, note("Used when a video has several audio tracks.")),
        section("Timing", delaySlider.el),
        section("Equalizer", enabled.el, cards, bandsBox, preamp.el,
          note("Bands go from deep bass on the left to treble on the right. Moving one switches to a custom curve.")));
    },
    shown() {
      visible = true;
      renderTracks();
      void loadInfo();
    },
    hidden() {
      visible = false;
    },
  };

  return {
    tab,
    dispose() {
      clearTimeout(eqTimer);
      unsubscribe();
    },
  };
}
