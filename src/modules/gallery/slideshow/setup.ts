import { invoke } from "@tauri-apps/api/core";
import { open } from "../../../shared/dialog";
import type { BuiltinTrack, MusicFile } from "../../../api";
import type { Photo } from "../library/model";
import { basename, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { builtinTracks, isPreviewing, previewMusic, stopPreview, yourMusic } from "./music";
import { TransitionPreview } from "./preview";
import {
  applyTheme, BUILTIN_MUSIC, KEN_BURNS_MAX, LOOKS, THEMES, TRANSITION_GROUPS, useCustomMix,
  type Framing, type SlideshowSettings, type TransitionChoice, type TransitionKind,
} from "./settings";

export interface SlideshowScope {
  /** Shown in the setup dialog, e.g. “Selected photos”. */
  label: string;
  /** Shown on the opening title card. */
  title: string;
  photos: Photo[];
  start: number;
}

const AUDIO_EXTENSIONS = ["mp3", "ogg", "oga", "opus", "flac", "wav", "m4a", "aac"];

const TABS = ["Style", "Transitions", "Timing", "Look", "Music"] as const;
type Tab = (typeof TABS)[number];
/** Reopening the settings returns to the tab used last. */
let lastTab: Tab = "Style";

/**
 * Live-editing slideshow settings in tabs, with a transition preview the host places (`preview`).
 * Used by the setup dialog and the in-show panel.
 */
export class SettingsForm {
  readonly el = h("div", { class: "settings-form" });
  readonly preview: TransitionPreview;
  private syncers: (() => void)[] = [];
  private tracks: BuiltinTrack[] = [];
  private songs: MusicFile[] = [];
  private tabs = new Map<Tab, [HTMLButtonElement, HTMLElement]>();
  private renderMusic: () => void = () => {};

  constructor(
    private readonly settings: SlideshowSettings,
    private readonly onChange: (key: keyof SlideshowSettings) => void,
    samples: Photo[] = [],
  ) {
    this.preview = new TransitionPreview(settings, samples);
    const panes: Record<Tab, HTMLElement[]> = {
      Style: [this.themePicker()],
      Transitions: [this.transitionLibrary()],
      Timing: [
        this.slider("Each photo", "duration", 2, 20, 0.5, (v) => `${v.toFixed(1)} s`),
        this.slider("Transition", "transitionTime", 0.3, 3, 0.1, (v) => `${v.toFixed(1)} s`),
        this.slider("Ken Burns", "kenBurns", 0, KEN_BURNS_MAX, 0.05, (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)),
        this.segmented("Framing", "framing", [["smart", "Smart"], ["fill", "Fill"], ["fit", "Fit"]]),
        this.framingHint(),
        this.toggle("Shuffle", "shuffle"),
        this.toggle("Loop", "loop"),
      ],
      Look: [
        this.select("Color grade", "look", LOOKS),
        this.slider("Film grain", "grain", 0, 1, 0.05, (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)),
        this.slider("Vignette", "vignette", 0, 1, 0.05, (v) => (v === 0 ? "Off" : `${Math.round(v * 100)}%`)),
        this.toggle("Cinema letterbox (2.39:1)", "letterbox"),
        this.toggle("Opening title card", "titleCard"),
        this.toggle("Captions", "captions"),
      ],
      Music: [
        this.musicList(),
        this.slider("Volume", "musicVolume", 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
        this.toggle("Cut on the beat", "beatSync"),
      ],
    };
    const bar = h("div", { class: "sf-tabs", role: "tablist" });
    const body = h("div", { class: "sf-panes" });
    for (const tab of TABS) {
      const button = h("button", { type: "button", class: "sf-tab", role: "tab", onclick: () => this.showTab(tab) }, tab);
      const pane = h("div", { class: `sf-pane sf-pane-${tab.toLowerCase()}`, role: "tabpanel" }, ...panes[tab]);
      this.tabs.set(tab, [button, pane]);
      bar.append(button);
      body.append(pane);
    }
    this.el.append(bar, body);
    this.showTab(lastTab);
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

  private showTab(tab: Tab) {
    lastTab = tab;
    for (const [name, [button, pane]] of this.tabs) {
      button.classList.toggle("active", name === tab);
      button.setAttribute("aria-selected", String(name === tab));
      pane.hidden = name !== tab;
    }
  }

  private changed(key: keyof SlideshowSettings) {
    this.sync();
    this.onChange(key);
  }

  private row(label: string, control: HTMLElement, value?: HTMLElement) {
    return h("label", { class: "sf-row" }, h("span", { class: "sf-label" }, label), control, value ?? null);
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

  private segmented(label: string, key: "framing", options: [Framing, string][]) {
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
    return this.row(label, group);
  }

  private framingHint() {
    const hint = h("p", { class: "sf-hint" });
    const text: Record<Framing, string> = {
      smart: "Landscapes fill the screen, the camera finding each photo's subject. Portraits start whole over a frosted backdrop, then slowly zoom toward faces.",
      fill: "Every photo fills the screen. The camera finds the subject and gives each photo its own move: pushing in, pulling back, gliding or drifting past it. Panoramas and tall shots are panned across.",
      fit: "Every photo stays whole over a frosted backdrop, with a gentle push-in.",
    };
    this.syncers.push(() => (hint.textContent = text[this.settings.framing]));
    this.syncers[this.syncers.length - 1]();
    return hint;
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

  /**
   * Category pills over a small set of chips; hovering a chip previews it. In "My mix" mode the
   * chips add and remove transitions from the user's own mix instead of picking just one.
   */
  private transitionLibrary() {
    const chips = new Map<TransitionChoice, HTMLButtonElement>();
    const special = (id: TransitionChoice) => id === "theme" || id === "random" || id === "custom";
    const chip = (id: TransitionChoice, label: string, extra = "") => {
      const button = h("button", { type: "button", class: `tchip${extra}` }, label);
      button.addEventListener("click", () => {
        const mix = this.settings.customTransitions;
        if (id === "custom") {
          useCustomMix(this.settings);
          this.settings.theme = "custom";
        } else if (this.settings.transition === "custom" && !special(id)) {
          const kind = id as TransitionKind;
          this.settings.customTransitions = mix.includes(kind) ? mix.filter((k) => k !== kind) : [...mix, kind];
        } else {
          this.settings.transition = id;
        }
        this.changed("transition");
      });
      if (!special(id)) {
        button.addEventListener("pointerenter", () => this.preview.show(id as TransitionKind));
        button.addEventListener("pointerleave", () => this.preview.show(null));
      }
      chips.set(id, button);
      return button;
    };
    const specials = h("div", { class: "tlib-row" }, chip("theme", "Match theme", " special"), chip("random", "Surprise me (all 50)", " special"), chip("custom", "My mix", " special"));
    const categories = h("div", { class: "tcats" });
    const rows = TRANSITION_GROUPS.map((group) => h("div", { class: "tlib-row", hidden: true }, ...group.items.map(([id, label]) => chip(id, label))));
    const pills = TRANSITION_GROUPS.map((group, i) => {
      const pill = h("button", { type: "button", class: "tcat" }, group.label);
      pill.addEventListener("click", () => showCategory(i));
      categories.append(pill);
      return pill;
    });
    const showCategory = (index: number) => {
      rows.forEach((row, i) => (row.hidden = i !== index));
      pills.forEach((pill, i) => pill.classList.toggle("active", i === index));
    };
    const selected = TRANSITION_GROUPS.findIndex((g) => g.items.some(([id]) => id === this.settings.transition));
    showCategory(Math.max(0, selected));
    const hint = h("p", { class: "sf-hint" });
    this.syncers.push(() => {
      const mixing = this.settings.transition === "custom";
      const mix = this.settings.customTransitions;
      chips.forEach((button, id) => button.classList.toggle("active", mixing && !special(id) ? mix.includes(id as TransitionKind) : this.settings.transition === id));
      chips.get("custom")!.textContent = mixing ? `My mix (${mix.length})` : "My mix";
      hint.textContent = mixing
        ? "Click transitions to add them to your mix or take them out; the show picks among them at random. Hover to preview."
        : "Hover a transition to preview it; click to use it for the whole show, or choose My mix to combine several.";
    });
    this.syncers[this.syncers.length - 1]();
    return h(
      "div",
      { class: "tlib" },
      specials,
      categories,
      ...rows,
      hint,
    );
  }

  /** Every soundtrack as a row with its own ▶ preview, then the user's songs. */
  private musicList() {
    const list = h("div", { class: "music-list" });
    const row = (choice: string | null, title: string, detail: string) => {
      const selected = (this.settings.music ?? null) === choice;
      const playing = choice !== null && isPreviewing(choice);
      const listen = h("button", { type: "button", class: "ml-play", title: playing ? "Stop" : "Listen", disabled: choice === null },
        icon(playing ? "pause" : "play", 13));
      listen.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (isPreviewing(choice)) {
          stopPreview();
        } else {
          listen.replaceChildren(icon("pause", 13));
          if (!(await previewMusic(choice, this.renderMusic))) listen.title = "This file can't be played on this computer";
        }
        this.renderMusic();
      });
      const item = h("div", { class: `ml-row${selected ? " active" : ""}`, role: "option", tabIndex: 0 },
        listen, h("span", { class: "ml-title" }, title), h("span", { class: "ml-detail" }, detail),
        selected ? h("span", { class: "ml-check" }, icon("check", 14)) : null);
      const choose = () => {
        this.settings.music = choice;
        this.changed("music");
      };
      item.addEventListener("click", choose);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose();
        }
      });
      return item;
    };
    const actions = h(
      "div",
      { class: "ml-actions" },
      h("button", { type: "button", class: "btn small", onclick: () => this.chooseFile() }, icon("folder", 14), "Choose a file…"),
      h("button", { type: "button", class: "btn small", title: "Songs you put here appear in this list", onclick: () => invoke("open_music_folder").catch(() => {}) }, icon("music", 14), "Open Music folder"),
      h("button", { type: "button", class: "btn small", title: "Opens YouTube's Audio Library in your browser. Its tracks are free to download and use; save them to your Music folder.", onclick: () => invoke("open_audio_library").catch(() => {}) }, icon("play", 13), "Free music on YouTube"),
      h("button", { type: "button", class: "icon-btn small", title: "Look for new songs", onclick: async () => {
        this.songs = await yourMusic(true);
        this.renderMusic();
      } }, icon("refresh", 14)),
    );
    this.renderMusic = () => {
      const current = this.settings.music;
      list.replaceChildren(row(null, "No music", ""));
      list.append(h("div", { class: "ml-head" }, "CorePro soundtracks"));
      for (const track of this.tracks) list.append(row(`${BUILTIN_MUSIC}${track.id}`, track.title, track.vibe));
      const own = current && !current.startsWith(BUILTIN_MUSIC) && !this.songs.some((s) => s.path === current) ? [current] : [];
      if (this.songs.length || own.length) {
        list.append(h("div", { class: "ml-head" }, "Your music"));
        for (const path of own) list.append(row(path, basename(path), "chosen file"));
        for (const song of this.songs) list.append(row(song.path, song.name, song.folder));
      }
    };
    Promise.all([builtinTracks(), yourMusic()]).then(([tracks, songs]) => {
      this.tracks = tracks;
      this.songs = songs;
      this.renderMusic();
    });
    this.syncers.push(() => this.renderMusic());
    this.renderMusic();
    return h("div", { class: "music-section" }, list, actions);
  }

  private async chooseFile() {
    stopPreview();
    const file = await open({ multiple: false, directory: false, title: "Choose slideshow music", filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
    if (typeof file === "string") {
      this.settings.music = file;
      this.changed("music");
    }
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
      } else if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement) && !(e.target as HTMLElement)?.closest?.(".ml-row")) {
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
    const side = h(
      "div",
      { class: "setup-side" },
      form.preview.el,
      scopes.length > 1 ? h("div", { class: "setup-scopes" }, h("div", { class: "ml-head" }, "Play"), scopeList) : null,
    );
    const dialog = h(
      "div",
      { class: "modal setup", role: "dialog", "aria-label": "Slideshow" },
      h("header", { class: "modal-head" },
        h("div", null, h("h2", null, "Slideshow"), summary),
        h("button", { class: "icon-btn", title: "Cancel (Esc)", onclick: () => finish(null) }, icon("close"))),
      h("div", { class: "setup-body" }, side, form.el),
      h("footer", { class: "modal-foot" },
        h("span", { class: "muted small" }, "Space pauses · ← → skip · S opens these settings during the show"),
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
