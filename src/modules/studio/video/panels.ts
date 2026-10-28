import { api, type BuiltinTrack } from "../../../api";
import { listening, onListening, stopListening, toggleListening } from "../../../shared/listen";
import { h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { LOOKS, TRANSITION_GROUPS, transitionLabel, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import { editApi, type SoundEffect } from "./api";
import type { CaptionsPanel } from "./captions";
import type { MediaStore } from "./media";
import type { Clip, Media, Project, Track } from "./model";
import { LAYER_TRANSITION_GROUPS } from "./overlays";
import { MEDIA_DRAG, TEXT_DRAG, formatTime } from "./timeline";
import { TEXT_PRESETS } from "./text";
import { STICKERS } from "./stickers";

/**
 * The left panel, as in CapCut: Media (the project's files), Audio (music and sound effects),
 * Text (styles), Stickers, Captions (auto captions), Transitions and Filters. Items are added
 * with their + button or dragged onto the timeline.
 */

export type PanelTab = "media" | "audio" | "text" | "templates" | "stickers" | "captions" | "transitions" | "filters";

/**
 * Where a transition goes: on a cut ("cut", into `clip` from the one before: any cut on the main
 * track; off it, only while `touching`), or a layer's own way on ("in") or off ("out").
 */
export type TransitionSlot = "cut" | "in" | "out";

export interface TransitionTarget {
  clip: Clip;
  track: Track;
  /** Off the main track: the clip before on its track ends where this one starts. */
  touching: boolean;
}

export interface PanelHost {
  project(): Project;
  store: MediaStore;
  importFiles(kind: "any" | "audio"): void;
  /** Starts (or stops) a voice-over at the playhead. */
  record(): void;
  importSrt(): void;
  exportSrt(): void;
  addMedia(id: string): void;
  addMusic(path: string): void;
  removeMedia(id: string): void;
  addText(presetId: string): void;
  addSticker(id: string): void;
  /** Adds a sound effect at the playhead. */
  addSound(path: string): void;
  captions: CaptionsPanel;
  /** Offers to install the codecs clips need, then checks those clips again. */
  installCodecs(): void;
  /**
   * What the Transitions tab sets: the selected clip off the main track (a layer), else the
   * selected main clip's cut, or the main track's cut nearest the playhead.
   */
  transitionTarget(): TransitionTarget | null;
  /** Sets (or with null removes) a transition on the target; `all`: on every cut, or every clip, of its track. */
  applyTransition(slot: TransitionSlot, kind: TransitionKind | null, duration: number, all: boolean): void;
  toast(text: string): void;
  /** The look of the selected clips (null when mixed or nothing is selected). */
  currentLook(): LookId | "none" | null;
  applyLook(look: LookId | "none", all: boolean): void;
  /** The Templates tab (motion/browser.ts). */
  templates?: { render(): Node[] };
}

const TABS: [PanelTab, string, IconName][] = [
  ["media", "Media", "film"],
  ["audio", "Audio", "music"],
  ["text", "Text", "textBox"],
  ["templates", "Templates", "template"],
  ["stickers", "Stickers", "veSticker"],
  ["captions", "Captions", "subtitles"],
  ["transitions", "Transitions", "sparkles"],
  ["filters", "Filters", "palette"],
];

/** Swatches standing in for each look in the Filters tab. */
const LOOK_SWATCH: Record<string, string> = {
  none: "linear-gradient(135deg, #5b6b7d, #9aa9b8)",
  natural: "linear-gradient(135deg, #3f7d4e, #d9c38a)",
  film: "linear-gradient(135deg, #3d3a33, #c7a77a)",
  tealorange: "linear-gradient(135deg, #0f5e6b, #f08a3c)",
  golden: "linear-gradient(135deg, #8a4b12, #ffd27a)",
  faded: "linear-gradient(135deg, #8d8a99, #e6dfd2)",
  noir: "linear-gradient(135deg, #111111, #bbbbbb)",
};

export class Panel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: HTMLElement;
  private tab: PanelTab = "media";
  private tracks: BuiltinTrack[] | null = null;
  private sounds: SoundEffect[] | null = null;
  private transitionLength = 0.6;
  /** Which of a layer's transitions the Transitions tab sets. */
  private slot: TransitionSlot = "in";
  /** The file this panel started playing (listening before adding). */
  private listened: string | null = null;
  private readonly stopWatching: () => void;

  constructor(private host: PanelHost) {
    this.tabs = h("div", { class: "ve-panel-tabs", role: "tablist" });
    this.body = h("div", { class: "ve-panel-body" });
    this.el = h("aside", { class: "ve-panel" }, this.tabs, this.body);
    this.stopWatching = onListening(() => this.drawListenButtons());
    this.drawTabs();
    this.refresh();
  }

  show(tab: PanelTab) {
    if (tab !== "audio") this.stopListening();
    this.tab = tab;
    this.drawTabs();
    this.refresh();
  }

  /** The Transitions tab, on a layer's in, out or the cut before it. */
  showTransition(slot: TransitionSlot) {
    this.slot = slot;
    this.show("transitions");
  }

  /** Stops what this panel plays (the editor plays, the panel closes). */
  stopListening() {
    if (this.listened && listening() === this.listened) stopListening();
    this.listened = null;
  }

  dispose() {
    this.stopListening();
    this.stopWatching();
  }

  /** A play/stop button for listening to `path` before adding it; `idle` is its icon while silent. */
  private listenButton(path: string, name: string, cls: string, idle: IconName = "play", size = 15): HTMLButtonElement {
    const b = h("button", {
      class: cls, type: "button", draggable: "false",
      onclick: (e: Event) => {
        e.stopPropagation();
        this.listened = path;
        toggleListening(path).catch(() => this.host.toast(`${name} can't be played here.`));
      },
      // Not the card's double-click (which adds the file).
      ondblclick: (e: Event) => e.stopPropagation(),
    });
    b.dataset.listen = path;
    b.dataset.name = name;
    b.dataset.idle = idle;
    b.dataset.size = String(size);
    this.drawListenButton(b);
    return b;
  }

  private drawListenButton(b: HTMLButtonElement) {
    const on = listening() === b.dataset.listen;
    const name = b.dataset.name ?? "";
    b.classList.toggle("playing", on);
    b.title = on ? `Stop ${name}` : `Listen to ${name}`;
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(on));
    b.replaceChildren(icon(on ? "stop" : (b.dataset.idle as IconName), Number(b.dataset.size)));
  }

  private drawListenButtons() {
    for (const b of this.body.querySelectorAll<HTMLButtonElement>("button[data-listen]")) this.drawListenButton(b);
  }

  private drawTabs() {
    this.tabs.replaceChildren(...TABS.map(([id, label, ic]) =>
      h("button", { class: `ve-panel-tab${id === this.tab ? " active" : ""}`, type: "button", role: "tab", title: label, "aria-selected": String(id === this.tab), onclick: () => this.show(id) }, icon(ic, 18), h("span", null, label)),
    ));
  }

  /** The Transitions and Filters tabs show what's selected. */
  selectionChanged() {
    if (this.tab === "transitions" || this.tab === "filters") this.refresh();
  }

  refresh() {
    const parts: Record<PanelTab, () => Node[]> = {
      media: () => this.mediaTab(),
      audio: () => this.audioTab(),
      text: () => this.textTab(),
      templates: () => this.host.templates?.render() ?? [],
      stickers: () => this.stickersTab(),
      captions: () => this.host.captions.render(),
      transitions: () => this.transitionsTab(),
      filters: () => this.filtersTab(),
    };
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(...parts[this.tab]());
    this.body.scrollTop = scroll;
  }

  private card(m: Media): HTMLElement {
    const thumb = h("canvas", { class: "ve-card-thumb", width: 160, height: 100 });
    if (m.kind !== "audio") {
      void this.host.store.strip(m).then((s) => {
        if (!s) return;
        const img = new Image();
        img.onload = () => {
          const g = thumb.getContext("2d")!;
          const scale = Math.max(160 / s.thumbWidth, 100 / s.thumbHeight);
          const dw = s.thumbWidth * scale, dh = s.thumbHeight * scale;
          g.drawImage(img, 0, 0, s.thumbWidth, s.thumbHeight, (160 - dw) / 2, (100 - dh) / 2, dw, dh);
        };
        img.src = s.url;
      });
    }
    const kindIcon: IconName = m.kind === "audio" ? "music" : m.kind === "image" ? "image" : "video";
    const el = h("div", {
      class: `ve-card${m.missing ? " missing" : ""}`,
      draggable: m.missing ? "false" : "true",
      title: m.note ? `${m.name}\n${m.note}` : m.name,
      ondragstart: (e: DragEvent) => {
        e.dataTransfer?.setData(MEDIA_DRAG, m.id);
        if (m.kind === "audio") e.dataTransfer?.setData(`${MEDIA_DRAG}-audio`, "1");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      },
      ondblclick: () => !m.missing && this.host.addMedia(m.id),
    },
      m.kind === "audio"
        ? h("div", { class: "ve-card-thumb audio" }, m.missing ? icon("music", 28) : this.listenButton(m.path, m.name, "ve-card-listen", "play", 18))
        : thumb,
      h("div", { class: "ve-card-meta" },
        icon(kindIcon, 13),
        h("span", { class: "ve-card-name" }, m.name),
        m.kind !== "image" ? h("span", { class: "ve-card-dur" }, formatTime(m.duration, 30, false)) : null,
      ),
      m.missing ? h("div", { class: "ve-card-badge" }, "Missing") : m.note ? h("div", { class: "ve-card-badge warn", title: m.note }, "!") : null,
      h("button", { class: "ve-card-add", type: "button", title: "Add to the timeline", "aria-label": `Add ${m.name}`, disabled: !!m.missing, onclick: () => this.host.addMedia(m.id) }, icon("plus", 16)),
      h("button", { class: "ve-card-remove", type: "button", title: "Remove from the project", "aria-label": `Remove ${m.name}`, onclick: () => this.host.removeMedia(m.id) }, icon("close", 13)),
    );
    return el;
  }

  private mediaTab(): Node[] {
    const media = this.host.project().media.filter((m) => m.kind !== "audio");
    const needsCodecs = this.host.project().media.some((m) => m.note && !m.missing);
    return [
      h("button", { class: "btn primary ve-import", type: "button", onclick: () => this.host.importFiles("any") }, icon("plus", 16), "Import"),
      needsCodecs
        ? h("div", { class: "ve-codec-note" },
          h("p", { class: "ve-panel-note" }, "Some files need codecs this system lacks (marked !)."),
          h("button", { class: "btn small", type: "button", onclick: () => this.host.installCodecs() }, icon("download", 14), "Install codecs…"))
        : null,
      media.length
        ? h("div", { class: "ve-cards" }, ...media.map((m) => this.card(m)))
        : h("p", { class: "ve-empty" }, "Import clips and pictures, then drag them onto the timeline or press +."),
    ].filter(Boolean) as Node[];
  }

  private audioTab(): Node[] {
    const media = this.host.project().media.filter((m) => m.kind === "audio");
    if (!this.tracks) {
      this.tracks = [];
      void api.builtinTracks().then((t) => {
        this.tracks = t;
        if (this.tab === "audio") this.refresh();
      }).catch(() => undefined);
    }
    return [
      h("button", { class: "btn primary ve-import", type: "button", onclick: () => this.host.importFiles("audio") }, icon("plus", 16), "Import music"),
      h("button", { class: "btn ve-import ve-voice-btn", type: "button", title: "Records from the microphone at the playhead (R)", onclick: () => this.host.record() }, icon("veMic", 16), "Record a voice-over"),
      media.length ? h("h3", { class: "ve-panel-h" }, "In this project") : null,
      media.length ? h("div", { class: "ve-cards" }, ...media.map((m) => this.card(m))) : null,
      ...this.soundsList(),
      this.tracks.length ? h("h3", { class: "ve-panel-h" }, "Zazabor soundtracks") : null,
      ...this.tracks.map((t) =>
        h("div", { class: "ve-track-row" },
          this.listenButton(t.path, t.title, "ve-track-icon ve-listen", "play", 16),
          h("div", { class: "ve-track-text" }, h("div", { class: "ve-track-title" }, t.title), h("div", { class: "ve-track-sub" }, `${t.vibe} · ${t.bpm} BPM · ${formatTime(t.seconds, 30, false)}`)),
          h("button", { class: "icon-btn small", type: "button", title: "Add at the playhead", "aria-label": `Add ${t.title}`, onclick: () => this.host.addMusic(t.path) }, icon("plus", 16)),
        )),
    ].filter(Boolean) as Node[];
  }

  /** Zazabor's own sound effects, each with a listen button. */
  private soundsList(): Node[] {
    if (!this.sounds) {
      this.sounds = [];
      void editApi.sounds().then((s) => {
        this.sounds = s;
        if (this.tab === "audio") this.refresh();
      }).catch(() => undefined);
    }
    if (!this.sounds.length) return [];
    return [
      h("h3", { class: "ve-panel-h" }, "Sound effects"),
      h("div", { class: "ve-sfx-grid" }, ...this.sounds.map((s) =>
        h("div", { class: "ve-sfx" },
          this.listenButton(s.path, s.title, "ve-sfx-play", "veSound", 15),
          h("span", { class: "ve-sfx-name" }, s.title),
          h("button", { class: "icon-btn small", type: "button", title: "Add at the playhead", "aria-label": `Add ${s.title}`, onclick: () => this.host.addSound(s.path) }, icon("plus", 15)),
        ))),
    ];
  }

  private stickersTab(): Node[] {
    return [
      h("p", { class: "ve-panel-note" }, "Click one to add it at the playhead; it comes and goes with a pop. Change its colour and size in the inspector."),
      h("div", { class: "ve-sticker-grid" }, ...STICKERS.map((s) => {
        const img = h("img", { class: "ve-sticker-img", alt: "", draggable: "false", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.svg("#ffb020"))}` });
        return h("button", { class: "ve-sticker", type: "button", title: `Add “${s.label}” at the playhead`, onclick: () => this.host.addSticker(s.id) }, img, h("span", null, s.label));
      })),
    ];
  }

  private textTab(): Node[] {
    return [
      h("button", { class: "btn primary ve-import", type: "button", onclick: () => this.host.addText("classic") }, icon("plus", 16), "Add text"),
      h("h3", { class: "ve-panel-h" }, "Styles"),
      h("div", { class: "ve-text-grid" }, ...TEXT_PRESETS.map((preset) => {
        const s = preset.style;
        const sample = h("span", {
          class: "ve-text-sample",
          style: {
            fontFamily: s.font, fontWeight: s.bold ? "700" : "400", fontStyle: s.italic ? "italic" : "normal", color: s.color,
            background: s.box ?? "transparent",
            textShadow: s.stroke ? `0 0 2px ${s.stroke}, 0 0 2px ${s.stroke}, 0 0 1px ${s.stroke}` : s.shadow ? `0 0 8px ${s.color === "#ffffff" ? "rgba(0,0,0,.8)" : s.color}` : "none",
          },
        }, "Aa");
        return h("button", {
          class: "ve-text-card", type: "button", title: `Add “${preset.label}” at the playhead`, draggable: "true",
          ondragstart: (e: DragEvent) => {
            e.dataTransfer?.setData(TEXT_DRAG, preset.id);
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
          },
          onclick: () => this.host.addText(preset.id),
        }, sample, h("span", { class: "ve-text-label" }, preset.label));
      })),
      h("h3", { class: "ve-panel-h" }, "Captions"),
      h("p", { class: "ve-panel-note" }, "Subtitle files (.srt) come in as texts on a track of their own; your texts go out as one."),
      h("div", { class: "ve-row ve-row-buttons" },
        h("button", { class: "btn small", type: "button", onclick: () => this.host.importSrt() }, icon("subtitles", 14), "Import .srt…"),
        h("button", { class: "btn small", type: "button", onclick: () => this.host.exportSrt() }, icon("download", 14), "Export .srt…")),
    ];
  }

  private transitionsTab(): Node[] {
    const target = this.host.transitionTarget();
    const layer = !!target && target.track.kind !== "main";
    if (layer && this.slot === "cut" && !target.touching) this.slot = "in";
    const slot: TransitionSlot = layer ? this.slot : "cut";
    const c = target?.clip;
    const now = (slot === "in" ? c?.transIn : slot === "out" ? c?.transOut : c?.transition) ?? null;
    const current = now?.kind ?? null;
    const apply = (kind: TransitionKind | null, all = false) => this.host.applyTransition(slot, kind, this.transitionLength, all);
    const length = h("input", {
      type: "range", min: "0.2", max: "2", step: "0.1", value: String(now?.duration ?? this.transitionLength),
      oninput: (e: Event) => {
        this.transitionLength = Number((e.target as HTMLInputElement).value);
        lengthValue.textContent = `${this.transitionLength.toFixed(1)} s`;
        if (current) apply(current);
      },
    });
    const lengthValue = h("span", { class: "ve-value" }, `${Number(length.value).toFixed(1)} s`);
    this.transitionLength = Number(length.value);
    let note = "Put two clips on the main track, then pick a transition for the cut between them. Select an overlay, a text or a sticker to give it an in and an out.";
    if (target && !layer) note = "Pick one for the selected cut (the orange marks on the main track).";
    else if (layer) {
      note = slot === "cut"
        ? "Plays across the cut on this layer: the clip before goes off as the selected one comes on."
        : `How the selected ${target.clip.type === "text" ? (target.clip.sticker ? "sticker" : "text") : target.clip.type === "template" ? "template" : "overlay"} comes on (In) and goes off (Out).`;
    }
    const allLabel = !layer ? "Apply to all cuts" : slot === "cut" ? "All cuts on this layer" : "Whole layer";
    const slots: [TransitionSlot, string][] = [["in", "In"], ["out", "Out"], ...(target?.touching ? [["cut", "Between"] as [TransitionSlot, string]] : [])];
    const kindOf = (s: TransitionSlot) => (s === "in" ? c?.transIn : s === "out" ? c?.transOut : c?.transition)?.kind;
    const groups = layer ? LAYER_TRANSITION_GROUPS : TRANSITION_GROUPS;
    return [
      h("p", { class: "ve-panel-note" }, note),
      layer ? h("div", { class: "segmented ve-seg ve-slot-seg", role: "tablist" }, ...slots.map(([s, label]) => {
        const kind = kindOf(s);
        return h("button", {
          type: "button", class: s === slot ? "active" : "", role: "tab", "aria-selected": String(s === slot),
          title: `${s === "cut" ? "Between this clip and the one before" : label}: ${kind ? transitionLabel(kind) : "none"}`,
          onclick: () => {
            this.slot = s;
            this.refresh();
          },
        }, label, kind ? h("span", { class: "ve-slot-dot" }) : null);
      })) : null,
      h("div", { class: "ve-row" }, h("label", null, "Length"), length, lengthValue),
      h("div", { class: "ve-row ve-row-buttons" },
        h("button", { class: "btn small", type: "button", disabled: !current, onclick: () => apply(null) }, "Remove"),
        h("button", { class: "btn small", type: "button", disabled: !current, onclick: () => current && apply(current, true) }, allLabel),
      ),
      ...groups.flatMap((group) => [
        h("h3", { class: "ve-panel-h" }, group.label),
        h("div", { class: "ve-chip-grid" }, ...group.items.map(([kind, label]) =>
          h("button", {
            class: `ve-chip${kind === current ? " active" : ""}`, type: "button", disabled: !target,
            onclick: () => apply(kind),
          }, label))),
      ]),
    ].filter(Boolean) as Node[];
  }

  private filtersTab(): Node[] {
    const current = this.host.currentLook();
    const items: [LookId | "none", string][] = [["none", "None"], ...LOOKS.map((l) => [l.id, l.label] as [LookId, string])];
    return [
      h("p", { class: "ve-panel-note" }, "Applies to the selected clips, or with “All clips” to every clip on the main track."),
      h("div", { class: "ve-look-grid" }, ...items.map(([id, label]) =>
        h("button", { class: `ve-look${current === id ? " active" : ""}`, type: "button", onclick: () => this.host.applyLook(id, false) },
          h("span", { class: "ve-look-swatch", style: { background: LOOK_SWATCH[id] ?? LOOK_SWATCH.none } }),
          h("span", null, label)))),
      h("div", { class: "ve-row ve-row-buttons" },
        h("button", { class: "btn small", type: "button", disabled: !current, onclick: () => current && this.host.applyLook(current, true) }, "All clips")),
    ];
  }
}
