import { open } from "@tauri-apps/plugin-dialog";
import type { BuiltinTrack, MusicFile } from "../api";
import type { Photo } from "../library/model";
import { basename, h } from "../ui/dom";
import { icon } from "../ui/icons";
import { builtinTracks, isPreviewing, previewMusic, stopPreview, yourMusic } from "./music";
import { TransitionPreview } from "./preview";
import { applyTheme, BUILTIN_MUSIC, LOOKS, THEMES, TRANSITION_GROUPS, type Framing, type SlideshowSettings, type TransitionChoice, type TransitionKind } from "./settings";

export interface SlideshowScope {
  /** Shown in the setup dialog, e.g. “Selected photos”. */
  label: string;
  /** Shown on the opening title card. */
  title: string;
  photos: Photo[];
  start: number;
}

const AUDIO_EXTENSIONS = ["mp3", "ogg", "oga", "opus", "flac", "wav", "m4a", "aac"];

/** Live-editing controls for slideshow settings; used by the setup dialog and the in-show panel. */
export class SettingsForm {
  readonly el = h("div", { class: "settings-form" });
  private syncers: (() => void)[] = [];
  private tracks: BuiltinTrack[] = [];
  private songs: MusicFile[] = [];
  private preview: TransitionPreview;

  constructor(
    private readonly settings: SlideshowSettings,
    private readonly onChange: (key: keyof SlideshowSettings) => void,
    samples: Photo[] = [],
  ) {
    this.preview = new TransitionPreview(settings, samples);
    this.el.append(
      this.group("Theme", this.themePicker()),
      this.group("Transitions", this.transitionLibrary()),
      this.group("Timing",
        this.slider("Each photo", "duration", 2, 20, 0.5, (v) => `${v.toFixed(1)} s`),
        this.slider("Transition length", "transitionTime", 0.3, 3, 0.1, (v) => `${v.toFixed(1)} s`),
      ),
      this.group("Motion",
        this.slider("Ken Burns", "kenBurns", 0, 1, 0.05, (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)),
        this.segmented("Framing", "framing", [["smart", "Smart"], ["fill", "Fill"], ["fit", "Fit"]],
          "Smart fills the screen when a photo's shape is close to it, and otherwise shows the whole photo over a blurred backdrop."),
      ),
      this.group("Look",
        this.select("Color grade", "look", LOOKS),
        this.slider("Film grain", "grain", 0, 1, 0.05, (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)),
        this.slider("Vignette", "vignette", 0, 1, 0.05, (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)),
        this.toggle("Cinema letterbox (2.39:1)", "letterbox"),
        this.toggle("Opening title card", "titleCard"),
        this.toggle("Captions", "captions"),
      ),
      this.group("Playback",
        this.toggle("Shuffle", "shuffle"),
        this.toggle("Loop", "loop"),
      ),
      this.group("Music",
        this.musicRow(),
        this.slider("Volume", "musicVolume", 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
        this.toggle("Cut on the beat", "beatSync")),
    );
  }

  /** Starts or stops the animated preview (it costs GPU time while visible). */
  setVisible(visible: boolean) {
    if (visible) this.preview.play();
    else this.preview.pause();
  }

  dispose() {
    this.preview.dispose();
    stopPreview();
  }

  /** Re-reads every control from the settings object. */
  sync() {
    for (const fn of this.syncers) fn();
  }

  private changed(key: keyof SlideshowSettings) {
    this.sync();
    this.onChange(key);
  }

  private group(title: string, ...rows: HTMLElement[]) {
    return h("fieldset", { class: "sf-group" }, h("legend", null, title), ...rows);
  }

  private row(label: string, control: HTMLElement, value?: HTMLElement, hint?: string) {
    return h("label", { class: "sf-row", title: hint ?? null }, h("span", { class: "sf-label" }, label), control, value ?? null);
  }

  private slider(label: string, key: "duration" | "transitionTime" | "kenBurns" | "grain" | "vignette" | "musicVolume",
    min: number, max: number, step: number, format: (v: number) => string) {
    const input = h("input", { type: "range", min, max, step });
    const value = h("span", { class: "sf-value" });
    const sync = () => {
      input.value = String(this.settings[key]);
      value.textContent = format(this.settings[key]);
    };
    input.addEventListener("input", () => {
      this.settings[key] = Number(input.value);
      this.changed(key);
    });
    this.syncers.push(sync);
    sync();
    return this.row(label, input, value);
  }

  private select<K extends "look">(label: string, key: K, options: readonly { id: string; label: string }[]) {
    const select = h("select", null, ...options.map((o) => h("option", { value: o.id }, o.label)));
    select.addEventListener("change", () => {
      (this.settings[key] as string) = select.value;
      this.changed(key);
    });
    this.syncers.push(() => (select.value = this.settings[key]));
    select.value = this.settings[key];
    return this.row(label, select);
  }

  private segmented(label: string, key: "framing", options: [Framing, string][], hint: string) {
    const group = h("div", { class: "segmented" });
    const buttons = options.map(([value, text]) => {
      const button = h("button", { type: "button" }, text);
      button.addEventListener("click", () => {
        this.settings[key] = value;
        this.changed(key);
      });
      group.append(button);
      return [value, button] as const;
    });
    const sync = () => buttons.forEach(([value, button]) => button.classList.toggle("active", this.settings[key] === value));
    this.syncers.push(sync);
    sync();
    return this.row(label, group, undefined, hint);
  }

  private toggle(label: string, key: "letterbox" | "titleCard" | "captions" | "shuffle" | "loop" | "beatSync") {
    const input = h("input", { type: "checkbox", class: "switch" });
    input.addEventListener("change", () => {
      this.settings[key] = input.checked;
      this.changed(key);
    });
    this.syncers.push(() => (input.checked = this.settings[key]));
    input.checked = this.settings[key];
    return h("label", { class: "sf-row sf-toggle" }, h("span", { class: "sf-label" }, label), input);
  }

  private transitionLibrary() {
    const chips = new Map<TransitionChoice, HTMLButtonElement>();
    const chip = (id: TransitionChoice, label: string, extra = "") => {
      const button = h("button", { type: "button", class: `tchip${extra}` }, label);
      button.addEventListener("click", () => {
        this.settings.transition = id;
        this.changed("transition");
      });
      if (id !== "theme" && id !== "random") {
        button.addEventListener("pointerenter", () => this.preview.show(id as TransitionKind));
        button.addEventListener("pointerleave", () => this.preview.show(null));
      }
      chips.set(id, button);
      return button;
    };
    const library = h("div", { class: "tlib" },
      h("div", { class: "tlib-row" }, chip("theme", "Match theme", " special"), chip("random", "Surprise me (all 50)", " special")));
    for (const group of TRANSITION_GROUPS) {
      library.append(h("div", { class: "tlib-group" }, h("span", { class: "tlib-label" }, group.label),
        h("div", { class: "tlib-row" }, ...group.items.map(([id, label]) => chip(id, label)))));
    }
    this.syncers.push(() => chips.forEach((button, id) => button.classList.toggle("active", this.settings.transition === id)));
    this.syncers[this.syncers.length - 1]();
    return h("div", { class: "tsection" }, this.preview.el, library);
  }

  private themePicker() {
    const grid = h("div", { class: "theme-grid" });
    const cards = THEMES.map((theme) => {
      const card = h("button", { type: "button", class: `theme-card theme-${theme.id}`, title: theme.blurb },
        h("span", { class: "theme-name" }, theme.label), h("span", { class: "theme-blurb" }, theme.blurb));
      card.addEventListener("click", () => {
        applyTheme(this.settings, theme.id);
        this.changed("theme");
      });
      grid.append(card);
      return [theme.id, card] as const;
    });
    this.syncers.push(() => cards.forEach(([id, card]) => card.classList.toggle("active", this.settings.theme === id)));
    this.syncers[this.syncers.length - 1]();
    return grid;
  }

  private musicRow() {
    const CUSTOM = "\u0000custom";
    const select = h("select");
    const preview = h("button", { type: "button", class: "icon-btn small preview-btn", title: "Listen to a few seconds" }, icon("play", 14));
    const options = () => {
      const current = this.settings.music;
      select.replaceChildren(h("option", { value: "" }, "No music"));
      const builtIn = h("optgroup", { label: "SliderPro soundtracks" });
      for (const track of this.tracks) builtIn.append(h("option", { value: `${BUILTIN_MUSIC}${track.id}` }, `${track.vibe} — ${track.title}`));
      select.append(builtIn);
      if (this.songs.length) {
        const mine = h("optgroup", { label: "Your music" });
        for (const song of this.songs) mine.append(h("option", { value: song.path, title: song.path }, `${song.name}${song.folder ? `  ·  ${song.folder}` : ""}`));
        select.append(mine);
      }
      if (current && !current.startsWith(BUILTIN_MUSIC) && !this.songs.some((s) => s.path === current)) {
        select.append(h("option", { value: current }, basename(current)));
      }
      select.append(h("option", { value: CUSTOM }, "Choose a file…"));
      select.value = current ?? "";
      preview.disabled = !current;
      preview.replaceChildren(icon(isPreviewing(current) ? "pause" : "play", 14));
    };
    select.addEventListener("change", async () => {
      stopPreview();
      if (select.value !== CUSTOM) {
        this.settings.music = select.value || null;
        this.changed("music");
        return;
      }
      const file = await open({ multiple: false, directory: false, title: "Choose slideshow music", filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
      if (typeof file === "string") {
        this.settings.music = file;
        this.changed("music");
      } else {
        options();
      }
    });
    preview.addEventListener("click", async () => {
      const choice = this.settings.music;
      if (isPreviewing(choice)) {
        stopPreview();
        options();
        return;
      }
      preview.replaceChildren(icon("pause", 14));
      const ok = await previewMusic(choice, options);
      if (!ok) {
        preview.title = "This file can't be played on this computer";
        options();
      }
    });
    Promise.all([builtinTracks(), yourMusic()]).then(([tracks, songs]) => {
      this.tracks = tracks;
      this.songs = songs;
      options();
    });
    this.syncers.push(options);
    options();
    return h("div", { class: "sf-row sf-music" }, h("span", { class: "sf-label" }, "Soundtrack"), select, preview);
  }

}

function estimate(photos: number, settings: SlideshowSettings) {
  const seconds = photos * (settings.duration + settings.transitionTime) + (settings.titleCard ? 4 : 0);
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `about ${minutes} minutes` : `about ${(minutes / 60).toFixed(1)} hours`;
}

/** Asks what to play and how; resolves with the chosen scope, or null when cancelled. */
export function openSetupDialog(scopes: SlideshowScope[], settings: SlideshowSettings, onChange: () => void): Promise<SlideshowScope | null> {
  return new Promise((resolve) => {
    let chosen = 0;
    const summary = h("p", { class: "setup-summary" });
    const updateSummary = () => {
      const scope = scopes[chosen];
      summary.textContent = `${scope.photos.length.toLocaleString()} ${scope.photos.length === 1 ? "photo" : "photos"} · ${estimate(scope.photos.length, settings)}${settings.loop ? ", looping" : ""}`;
    };
    const scopeList = h("div", { class: "scope-list" });
    scopes.forEach((scope, i) => {
      const input = h("input", { type: "radio", name: "scope", checked: i === 0 });
      input.addEventListener("change", () => {
        chosen = i;
        updateSummary();
      });
      scopeList.append(h("label", { class: "scope" }, input, h("span", { class: "scope-label" }, scope.label), h("span", { class: "scope-count" }, scope.photos.length.toLocaleString())));
    });
    const form = new SettingsForm(settings, () => {
      updateSummary();
      onChange();
    }, scopes[0]?.photos.slice(scopes[0].start, scopes[0].start + 6) ?? []);
    form.setVisible(true);
    updateSummary();

    const overlay = h("div", { class: "modal-overlay" });
    const finish = (result: SlideshowScope | null) => {
      form.dispose();
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        e.stopPropagation();
        finish(scopes[chosen]);
      } else {
        // Keep the app's global shortcuts from acting behind the dialog.
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey, true);

    const play = h("button", { class: "btn primary large", onclick: () => finish(scopes[chosen]) }, icon("play", 16), "Play");
    const dialog = h(
      "div",
      { class: "modal setup", role: "dialog", "aria-label": "Slideshow" },
      h("header", { class: "modal-head" },
        h("div", null, h("h2", null, "Slideshow"), summary),
        h("button", { class: "icon-btn", title: "Cancel (Esc)", onclick: () => finish(null) }, icon("close"))),
      h("div", { class: "modal-body" }, scopes.length > 1 ? h("fieldset", { class: "sf-group" }, h("legend", null, "Play"), scopeList) : null, form.el),
      h("footer", { class: "modal-foot" },
        h("span", { class: "muted small" }, "Space pauses · ← → skip · Esc ends the show"),
        h("div", { class: "spacer" }),
        h("button", { class: "btn", onclick: () => finish(null) }, "Cancel"),
        play),
    );
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.append(dialog);
    document.body.append(overlay);
    play.focus();
  });
}
