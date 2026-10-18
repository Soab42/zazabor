import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { PanelTab } from "../../extensions";
import { choiceRow, note, section, secondsLabel, segmented, selectRow, slider, toggle } from "../panel/ui";
import type { SubtitleController } from "./controller";
import { LANGUAGES } from "./language";
import { setOnlinePassword } from "./online";
import { applyStyle, FONTS, type SubStyle } from "./style";
import { createTimeline } from "./timeline-ui";
import { DELAY_STEP_MS, MAX_DELAY_MS } from "./timeline";
import { renderCue } from "./engine";

const SWATCHES = ["#ffffff", "#ffe066", "#7be0ff", "#9dff9d", "#ff9ec4"];
const SAMPLE = "The quick brown fox jumps over the lazy dog";

/** The side panel's Subtitles tab. */
export function createSubtitlesTab(c: SubtitleController, addSubtitles: () => void): PanelTab {
  const timeline = createTimeline(c);
  let visible = false;
  let root: HTMLElement | null = null;
  const refreshers: (() => void)[] = [];
  const onChange = (fn: () => void) => refreshers.push(fn);

  // ---- source ------------------------------------------------------------------------------
  const tracksBox = h("div", { class: "pp-choices", role: "radiogroup", "aria-label": "Subtitle track" });
  let tracksKey = "";
  function renderTracks() {
    const state = c.state;
    const key = JSON.stringify([c.source, c.externalName, state.subtitleTrack, state.subtitleTracks]);
    if (key === tracksKey) return;
    tracksKey = key;
    const rows: HTMLElement[] = [choiceRow("Off", c.source === "off", () => c.turnOff())];
    if (c.externalName) rows.push(choiceRow(c.externalName, c.source === "ours", () => undefined, "added file"));
    for (const t of state.subtitleTracks) rows.push(choiceRow(t.name, c.source === "embedded" && state.subtitleTrack === t.id, () => c.selectEmbedded(t.id), "in the file"));
    tracksBox.replaceChildren(...rows);
  }
  const error = h("p", { class: "pp-note bad", role: "alert", hidden: true });
  onChange(() => {
    renderTracks();
    error.hidden = !c.error;
    error.textContent = c.error ?? "";
  });

  const addButton = h("button", { class: "btn small primary", type: "button", onclick: addSubtitles }, icon("plus", 14), "Add subtitles…");

  // ---- delay -------------------------------------------------------------------------------
  const delay = slider({
    label: "Delay", min: -MAX_DELAY_MS, max: MAX_DELAY_MS, step: DELAY_STEP_MS, value: c.delay, format: secondsLabel,
    onInput: (v) => c.setDelay(v), resetTo: 0, title: "Positive shows subtitles later, negative earlier (G / H keys nudge by 50 ms)",
  });
  const nudge = (label: string, by: number) => h("button", { class: "btn small ghost", type: "button", onclick: () => c.setDelay(c.delay + by) }, label);
  onChange(() => delay.set(c.delay));

  // ---- appearance --------------------------------------------------------------------------
  const preview = h("div", { class: "pp-sub-preview" });
  const previewRoot = h("div", { class: "sub-root pp-sub-root" });
  preview.append(previewRoot);
  function renderPreview() {
    previewRoot.replaceChildren();
    const zone = h("div", { class: "sub-zone bottom", style: { bottom: "14%" } });
    renderCue(zone, { start: 0, end: 1, lines: [[{ text: SAMPLE }]], align: 2 });
    previewRoot.append(zone);
    applyStyle(previewRoot, { ...c.style }, 110);
  }

  const font = selectRow("Font", FONTS.map((f) => ({ value: f.key, label: f.label })), c.style.font, (v) => c.setStyle({ font: v as SubStyle["font"] }));
  const sizeMode = segmented<SubStyle["sizeMode"]>([{ value: "relative", label: "Relative" }, { value: "exact", label: "Exact" }], c.style.sizeMode, (v) => c.setStyle({ sizeMode: v }));
  const sizeRel = slider({ label: "Size", min: 50, max: 300, step: 5, value: c.style.sizePct, format: (v) => `${v}%`, onInput: (v) => c.setStyle({ sizePct: v }), resetTo: 100 });
  const sizeExact = slider({ label: "Size", min: 12, max: 120, step: 1, value: c.style.sizePx, format: (v) => `${v} px`, onInput: (v) => c.setStyle({ sizePx: v }), resetTo: 32 });
  const outline = slider({ label: "Outline", min: 0, max: 4, step: 0.5, value: c.style.outline, format: (v) => `${v} px`, onInput: (v) => c.setStyle({ outline: v }), resetTo: 2 });
  const shadow = slider({ label: "Shadow", min: 0, max: 1, step: 0.05, value: c.style.shadow, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => c.setStyle({ shadow: v }), resetTo: 0.5 });
  const box = slider({ label: "Background box", min: 0, max: 0.9, step: 0.05, value: c.style.box, format: (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`), onInput: (v) => c.setStyle({ box: v }), resetTo: 0 });
  const position = slider({ label: "Position", min: 0, max: 40, step: 1, value: c.style.bottom, format: (v) => `${v}% up`, onInput: (v) => c.setStyle({ bottom: v }), resetTo: 7 });
  const bold = toggle("Bold", c.style.bold, (on) => c.setStyle({ bold: on }));
  const colorInput = h("input", { type: "color", class: "pp-color", "aria-label": "Custom colour", value: c.style.color });
  colorInput.addEventListener("input", () => c.setStyle({ color: colorInput.value }));
  const swatches = SWATCHES.map((hex) => h("button", { type: "button", class: "pp-swatch", title: hex, "aria-label": `Colour ${hex}`, style: { background: hex }, onclick: () => c.setStyle({ color: hex }) }));
  onChange(() => {
    const s = c.style;
    font.select.value = s.font;
    sizeMode.set(s.sizeMode);
    sizeRel.el.hidden = s.sizeMode !== "relative";
    sizeExact.el.hidden = s.sizeMode !== "exact";
    sizeRel.set(s.sizePct);
    sizeExact.set(s.sizePx);
    outline.set(s.outline);
    shadow.set(s.shadow);
    box.set(s.box);
    position.set(s.bottom);
    bold.set(s.bold);
    colorInput.value = s.color;
    swatches.forEach((sw, i) => sw.classList.toggle("active", SWATCHES[i] === s.color));
    renderPreview();
  });

  // ---- show preset -------------------------------------------------------------------------
  const presetBox = h("div", { class: "pp-preset" });
  let presetKey = "";
  function renderPreset() {
    const show = c.show;
    const preset = c.preset;
    const key = JSON.stringify([show?.key, show?.label, !!preset, c.presetDirty, preset?.name]);
    if (key === presetKey) return;
    presetKey = key;
    if (!show) {
      presetBox.replaceChildren(note("Open a video to save its subtitle look as a preset."));
      return;
    }
    const title = h("div", { class: "pp-preset-title" }, h("span", null, show.name), show.label ? h("span", { class: "pp-chip" }, show.label) : null);
    const buttons = preset
      ? [
          c.presetDirty ? h("button", { class: "btn small primary", type: "button", onclick: () => c.savePreset() }, "Update preset") : h("span", { class: "pp-saved" }, icon("check", 13), "Preset saved"),
          h("button", { class: "btn small ghost", type: "button", onclick: () => c.removePreset() }, "Remove"),
        ]
      : [h("button", { class: "btn small", type: "button", onclick: () => c.savePreset() }, `Save for “${show.name}”`)];
    presetBox.replaceChildren(title, h("div", { class: "pp-dialog-buttons" }, ...buttons),
      note("Font, size, colours and delay are applied to the show’s other episodes automatically."));
  }
  onChange(renderPreset);

  // ---- language ----------------------------------------------------------------------------
  const language = selectRow("Default language", [{ value: "", label: "Automatic" }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name }))], c.settings.language, (v) => {
    c.settings.language = v;
    c.save();
  });

  // ---- advanced ----------------------------------------------------------------------------
  const online = c.settings.online;
  const field = (label: string, input: HTMLInputElement) => h("label", { class: "pp-field" }, h("span", { class: "pp-label" }, label), input);
  const keyInput = h("input", { class: "pp-input", type: "password", autocomplete: "off", spellcheck: false, placeholder: "API key", value: online.apiKey });
  const userInput = h("input", { class: "pp-input", type: "text", autocomplete: "off", spellcheck: false, placeholder: "User name", value: online.username });
  const passInput = h("input", { class: "pp-input", type: "password", autocomplete: "off", placeholder: "Password (kept only until you quit)" });
  keyInput.addEventListener("change", () => {
    online.apiKey = keyInput.value.trim();
    c.save();
  });
  userInput.addEventListener("change", () => {
    online.username = userInput.value.trim();
    c.save();
  });
  passInput.addEventListener("change", () => setOnlinePassword(passInput.value));
  for (const input of [keyInput, userInput, passInput]) input.addEventListener("keydown", (e) => e.stopPropagation());
  const advanced = h("details", { class: "pp-advanced" },
    h("summary", null, "Advanced: online subtitles"),
    note("Online subtitles come from OpenSubtitles. Create a free account at opensubtitles.com, add an API consumer under your profile, and paste its key here. Downloading also needs your user name and password; the password is not saved."),
    field("API key", keyInput), field("User name", userInput), field("Password", passInput));

  const timelineToggle = toggle("Show timeline over the video", c.settings.showTimeline, (on) => {
    c.settings.showTimeline = on;
    c.save();
    c.emitSettings();
  });
  onChange(() => timelineToggle.set(c.settings.showTimeline));

  function refresh() {
    for (const fn of refreshers) fn();
  }
  const unsubscribe = c.subscribe(() => {
    if (visible) refresh();
  });

  return {
    id: "subtitles",
    title: "Subtitles",
    icon: "subtitles",
    order: 10,
    render() {
      root = h("div", { class: "pp" },
        section("Subtitles", tracksBox, error, h("div", { class: "pp-dialog-buttons" }, addButton)),
        section("Timing", delay.el, h("div", { class: "pp-dialog-buttons" }, nudge("− 50 ms", -50), nudge("+ 50 ms", 50)), timeline.el,
          note("Drag the strip sideways to shift the timing; click a line to jump to it."), timelineToggle.el),
        section("Appearance", preview, font.el, h("div", { class: "pp-row-split" }, h("span", { class: "pp-label" }, "Size"), sizeMode.el), sizeRel.el, sizeExact.el,
          h("div", { class: "pp-colors" }, h("span", { class: "pp-label" }, "Colour"), h("div", { class: "pp-swatches" }, ...swatches, colorInput)),
          outline.el, shadow.el, box.el, position.el, bold.el,
          note("Our own renderer draws subtitle files you add. Subtitles inside the video are drawn by VLC and keep its look.")),
        section("Show preset", presetBox),
        section("Language", language.el, note("Used when a video has several subtitle tracks.")),
        advanced);
      refresh();
      onOpenAdvanced();
      return root;
    },
    shown() {
      visible = true;
      timeline.start();
      refresh();
      onOpenAdvanced();
    },
    hidden() {
      visible = false;
      timeline.stop();
    },
  };

  function onOpenAdvanced() {
    if (c.wantAdvanced) {
      c.wantAdvanced = false;
      advanced.open = true;
      requestAnimationFrame(() => advanced.scrollIntoView({ block: "center", behavior: "smooth" }));
    }
  }
  // The tab lives as long as the feature; the subscription is cleared when the controller is disposed.
  void unsubscribe;
}
