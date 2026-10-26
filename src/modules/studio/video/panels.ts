import { api, type BuiltinTrack } from "../../../api";
import { h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { LOOKS, TRANSITION_GROUPS, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import type { MediaStore } from "./media";
import type { Media, MediaClip, Project } from "./model";
import { MEDIA_DRAG, TEXT_DRAG, formatTime } from "./timeline";
import { TEXT_PRESETS } from "./text";

/**
 * The left panel, as in CapCut: Media (the project's files), Audio (music), Text (styles),
 * Transitions and Filters. Items are added with their + button or dragged onto the timeline.
 */

export type PanelTab = "media" | "audio" | "text" | "transitions" | "filters";

export interface PanelHost {
  project(): Project;
  store: MediaStore;
  importFiles(kind: "any" | "audio"): void;
  addMedia(id: string): void;
  addMusic(path: string): void;
  removeMedia(id: string): void;
  addText(presetId: string): void;
  /** The cut a transition goes on: the selected main clip, or the cut nearest the playhead. */
  transitionTarget(): MediaClip | null;
  applyTransition(kind: TransitionKind | null, duration: number, all: boolean): void;
  /** The look of the selected clips (null when mixed or nothing is selected). */
  currentLook(): LookId | "none" | null;
  applyLook(look: LookId | "none", all: boolean): void;
}

const TABS: [PanelTab, string, IconName][] = [
  ["media", "Media", "film"],
  ["audio", "Audio", "music"],
  ["text", "Text", "textBox"],
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
  private transitionLength = 0.6;

  constructor(private host: PanelHost) {
    this.tabs = h("div", { class: "ve-panel-tabs", role: "tablist" });
    this.body = h("div", { class: "ve-panel-body" });
    this.el = h("aside", { class: "ve-panel" }, this.tabs, this.body);
    this.drawTabs();
    this.refresh();
  }

  show(tab: PanelTab) {
    this.tab = tab;
    this.drawTabs();
    this.refresh();
  }

  private drawTabs() {
    this.tabs.replaceChildren(...TABS.map(([id, label, ic]) =>
      h("button", { class: `ve-panel-tab${id === this.tab ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(id === this.tab), onclick: () => this.show(id) }, icon(ic, 18), h("span", null, label)),
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
      m.kind === "audio" ? h("div", { class: "ve-card-thumb audio" }, icon("music", 28)) : thumb,
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
    return [
      h("button", { class: "btn primary ve-import", type: "button", onclick: () => this.host.importFiles("any") }, icon("plus", 16), "Import"),
      media.length
        ? h("div", { class: "ve-cards" }, ...media.map((m) => this.card(m)))
        : h("p", { class: "ve-empty" }, "Import clips and pictures, then drag them onto the timeline or press +."),
    ];
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
      media.length ? h("h3", { class: "ve-panel-h" }, "In this project") : null,
      media.length ? h("div", { class: "ve-cards" }, ...media.map((m) => this.card(m))) : null,
      this.tracks.length ? h("h3", { class: "ve-panel-h" }, "CorePro soundtracks") : null,
      ...this.tracks.map((t) =>
        h("div", { class: "ve-track-row" },
          h("div", { class: "ve-track-icon" }, icon("music", 16)),
          h("div", { class: "ve-track-text" }, h("div", { class: "ve-track-title" }, t.title), h("div", { class: "ve-track-sub" }, `${t.vibe} · ${t.bpm} BPM · ${formatTime(t.seconds, 30, false)}`)),
          h("button", { class: "icon-btn small", type: "button", title: "Add at the playhead", "aria-label": `Add ${t.title}`, onclick: () => this.host.addMusic(t.path) }, icon("plus", 16)),
        )),
    ].filter(Boolean) as Node[];
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
    ];
  }

  private transitionsTab(): Node[] {
    const target = this.host.transitionTarget();
    const current = target?.transition?.kind ?? null;
    const length = h("input", {
      type: "range", min: "0.2", max: "2", step: "0.1", value: String(target?.transition?.duration ?? this.transitionLength),
      oninput: (e: Event) => {
        this.transitionLength = Number((e.target as HTMLInputElement).value);
        lengthValue.textContent = `${this.transitionLength.toFixed(1)} s`;
        if (current) this.host.applyTransition(current, this.transitionLength, false);
      },
    });
    const lengthValue = h("span", { class: "ve-value" }, `${Number(length.value).toFixed(1)} s`);
    this.transitionLength = Number(length.value);
    return [
      h("p", { class: "ve-panel-note" }, target ? "Pick one for the selected cut (the orange marks on the main track)." : "Put two clips on the main track, then pick a transition for the cut between them."),
      h("div", { class: "ve-row" }, h("label", null, "Length"), length, lengthValue),
      h("div", { class: "ve-row ve-row-buttons" },
        h("button", { class: "btn small", type: "button", disabled: !current, onclick: () => this.host.applyTransition(null, 0, false) }, "Remove"),
        h("button", { class: "btn small", type: "button", disabled: !current, onclick: () => current && this.host.applyTransition(current, this.transitionLength, true) }, "Apply to all cuts"),
      ),
      ...TRANSITION_GROUPS.flatMap((group) => [
        h("h3", { class: "ve-panel-h" }, group.label),
        h("div", { class: "ve-chip-grid" }, ...group.items.map(([kind, label]) =>
          h("button", {
            class: `ve-chip${kind === current ? " active" : ""}`, type: "button", disabled: !target,
            onclick: () => this.host.applyTransition(kind, this.transitionLength, false),
          }, label))),
      ]),
    ];
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
