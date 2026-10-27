import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { errorText } from "../../time/api";
import { ask } from "../photo/ask";
import { editApi, type CaptionModel, type CaptionSpan, type Cue } from "./api";
import { mediaOf, type MediaClip, type Project } from "./model";
import { TEXT_PRESETS } from "./text";

/**
 * Auto captions (the Captions tab): the clips' speech becomes captions with word timing, by
 * Whisper running on this computer (`videoedit/whisper`). The model is downloaded once, after
 * asking; nothing of the video leaves the computer.
 */

export interface CaptionsHost {
  project(): Project;
  /** The selected clips (any track). */
  selectedClips(): MediaClip[];
  /** Puts the captions on a track of their own (replacing earlier auto captions); returns how many. */
  apply(cues: Cue[], presetId: string, highlight: string | null): number;
  toast(text: string): void;
}

export const CAPTION_LANGUAGES: [string, string][] = [
  ["auto", "Detect"], ["en", "English"], ["bn", "Bangla"], ["hi", "Hindi"], ["ur", "Urdu"], ["ar", "Arabic"], ["es", "Spanish"],
  ["fr", "French"], ["de", "German"], ["pt", "Portuguese"], ["ru", "Russian"], ["tr", "Turkish"], ["id", "Indonesian"], ["ms", "Malay"],
  ["ta", "Tamil"], ["ne", "Nepali"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["it", "Italian"],
];

/** Characters per caption line for each canvas shape. */
const LINE_CHARS: Record<string, number> = { "9:16": 26, "4:5": 30, "1:1": 32, "16:9": 42 };

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** The stretches of sound to caption: clips with sound (music left out), in timeline order. */
export function captionSpans(p: Project, only: MediaClip[] | null): CaptionSpan[] {
  const spans: CaptionSpan[] = [];
  for (const track of p.tracks) {
    if (track.muted && !only) continue;
    for (const c of track.clips) {
      if (c.type !== "media") continue;
      if (only && !only.some((o) => o.id === c.id)) continue;
      const m = mediaOf(p, c.media);
      if (!m || m.missing || !m.audio || c.freeze !== undefined || c.reverse) continue;
      // Music isn't speech: skip it unless it was picked.
      if (!only && track.kind === "audio" && c.role !== "voice") continue;
      if (!only && c.volume <= 0) continue;
      const speed = c.speed > 0 ? c.speed : 1;
      spans.push({ path: m.path, from: c.in, to: c.in + c.duration * speed, at: c.start, speed, hasAudio: m.audio });
    }
  }
  return spans.sort((a, b) => a.at - b.at);
}

export class CaptionsPanel {
  private models: CaptionModel[] | null = null;
  private scope: "all" | "selected" = "all";
  private language = "auto";
  private model: CaptionModel["id"] = "base";
  /** White words with an outline: the yellow highlight stands out on them. */
  private preset = "classic";
  private highlight: string | null = "#ffd23f";
  private job: { id: number; progress: number; stage: string } | null = null;
  /** A download that will start captioning when it's done. */
  private waiting: CaptionModel["id"] | null = null;
  private timer = 0;
  private root: HTMLElement | null = null;

  constructor(private host: CaptionsHost, private refresh: () => void) {}

  dispose() {
    clearInterval(this.timer);
    if (this.job) void editApi.captionsCancel(this.job.id).catch(() => undefined);
  }

  private async loadModels() {
    this.models = await editApi.captionModels().catch(() => []);
  }

  render(): Node[] {
    if (!this.models) {
      void this.loadModels().then(() => this.refresh());
    }
    const models = this.models ?? [];
    const chosen = models.find((m) => m.id === this.model);
    const downloading = models.find((m) => m.downloading);
    const select = (label: string, options: [string, string][], value: string, set: (v: string) => void) =>
      h("div", { class: "ve-row" }, h("label", null, label),
        h("select", { class: "ve-select", onchange: (e: Event) => set((e.target as HTMLSelectElement).value) },
          ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l))));
    const segmented = (label: string, options: [string, string][], value: string, set: (v: string) => void) =>
      h("div", { class: "ve-row" }, h("label", null, label),
        h("div", { class: "segmented ve-seg" }, ...options.map(([v, l]) =>
          h("button", { type: "button", class: v === value ? "active" : "", onclick: () => (set(v), this.refresh()) }, l))));

    const status = (m: CaptionModel) =>
      m.installed ? "Ready" : m.downloading ? `Downloading ${Math.floor((m.partial / m.bytes) * 100)}%` : m.partial > 0 ? `Paused at ${Math.floor((m.partial / m.bytes) * 100)}%` : `${mb(m.bytes)} download`;
    const modelOptions: [string, string][] = models.length
      ? models.map((m) => [m.id, `${m.label} — ${status(m)}`])
      : [["base", "Base"], ["small", "Small"]];

    const busy = this.job !== null || this.waiting !== null;
    const progress = this.job
      ? h("div", { class: "ve-cap-progress" },
        h("div", { class: "ve-cap-bar" }, h("div", { class: "ve-cap-fill", style: { width: `${Math.round(this.job.progress * 100)}%` } })),
        h("div", { class: "ve-cap-stage" }, `${this.job.stage || "Starting…"} ${Math.round(this.job.progress * 100)}%`),
        h("button", { class: "btn small", type: "button", onclick: () => void this.cancel() }, "Cancel"))
      : downloading
        ? h("div", { class: "ve-cap-progress" },
          h("div", { class: "ve-cap-bar" }, h("div", { class: "ve-cap-fill", style: { width: `${Math.floor((downloading.partial / downloading.bytes) * 100)}%` } })),
          h("div", { class: "ve-cap-stage" }, `Downloading ${downloading.label}: ${mb(downloading.partial)} of ${mb(downloading.bytes)}`),
          h("button", { class: "btn small", type: "button", onclick: () => void this.pauseDownload(downloading.id) }, "Pause"))
        : null;

    const error = models.find((m) => m.error && !m.downloading);
    const action = chosen && !chosen.installed ? `Download ${chosen.label} (${mb(chosen.bytes)}) and generate` : "Generate captions";
    const root = h("div", { class: "ve-captions" },
      h("p", { class: "ve-panel-note" }, "Listens to the clips' speech on this computer and writes captions that light up word by word. Nothing is uploaded."),
      segmented("From", [["all", "All clips"], ["selected", "Selected"]], this.scope, (v) => (this.scope = v as "all" | "selected")),
      select("Language", CAPTION_LANGUAGES, this.language, (v) => {
        this.language = v;
        // Small is the better of the two at Bangla, though neither gets it right yet.
        if (v === "bn") this.model = "small";
        this.refresh();
      }),
      select("Model", modelOptions, this.model, (v) => {
        this.model = v as CaptionModel["id"];
        this.refresh();
      }),
      h("p", { class: "ve-panel-note ve-cap-hint" }, chosen?.note ?? ""),
      select("Style", TEXT_PRESETS.map((p) => [p.id, p.label] as [string, string]), this.preset, (v) => (this.preset = v)),
      h("div", { class: "ve-row" }, h("label", null, "Highlight"),
        h("input", { type: "checkbox", class: "switch", role: "switch", checked: this.highlight !== null, onchange: (e: Event) => {
          this.highlight = (e.target as HTMLInputElement).checked ? "#ffd23f" : null;
          this.refresh();
        } }),
        this.highlight !== null
          ? h("input", { type: "color", class: "ve-color", value: this.highlight, title: "The colour of words already spoken", oninput: (e: Event) => (this.highlight = (e.target as HTMLInputElement).value) })
          : null),
      error ? h("p", { class: "ve-panel-note ve-warn" }, error.error) : null,
      progress,
      h("button", { class: "btn primary ve-import", type: "button", disabled: busy, onclick: () => void this.generate() }, icon("subtitles", 16), action),
      models.some((m) => m.installed || m.partial > 0)
        ? h("div", { class: "ve-cap-models" }, h("h3", { class: "ve-panel-h" }, "Downloaded models"),
          ...models.filter((m) => m.installed || m.partial > 0).map((m) =>
            h("div", { class: "ve-track-row" },
              h("div", { class: "ve-track-icon" }, icon("subtitles", 16)),
              h("div", { class: "ve-track-text" }, h("div", { class: "ve-track-title" }, m.label), h("div", { class: "ve-track-sub" }, m.installed ? mb(m.bytes) : `${mb(m.partial)} of ${mb(m.bytes)}`)),
              h("button", { class: "icon-btn small", type: "button", title: "Remove from this computer", "aria-label": `Remove ${m.label}`, disabled: m.downloading || busy, onclick: () => void this.remove(m) }, icon("trash", 15)))))
        : null,
    );
    this.root = root;
    return [root];
  }

  private spans(): CaptionSpan[] {
    const p = this.host.project();
    return captionSpans(p, this.scope === "selected" ? this.host.selectedClips() : null);
  }

  private async generate() {
    const spans = this.spans();
    if (!spans.length) {
      this.host.toast(this.scope === "selected" ? "Select a clip with sound first." : "There's no clip with speech to caption.");
      return;
    }
    await this.loadModels();
    const model = this.models?.find((m) => m.id === this.model);
    if (!model) return;
    if (!model.installed) {
      const answer = await ask({
        title: `Download the ${model.label} captions model?`,
        text: `Auto captions need Whisper's ${model.label} model (${mb(model.bytes)}). It's downloaded once from the whisper.cpp project and kept on this computer; your videos never leave it. You can pause the download and remove the model later.`,
        icon: "subtitles",
        choices: [{ id: "no", label: "Cancel" }, { id: "yes", label: "Download", primary: true }],
        cancel: "no",
      });
      if (answer !== "yes") return;
      this.waiting = model.id;
      try {
        await editApi.captionModelDownload(model.id);
      } catch (err) {
        this.waiting = null;
        this.host.toast(`Couldn't download the model: ${errorText(err)}`);
        return;
      }
      this.watch();
      return;
    }
    await this.run(spans);
  }

  private async run(spans: CaptionSpan[]) {
    const p = this.host.project();
    try {
      const id = await editApi.captionsStart({
        spans, model: this.model, language: this.language === "auto" ? null : this.language, maxChars: LINE_CHARS[p.canvas.aspect] ?? 30,
      });
      this.job = { id, progress: 0, stage: "Starting…" };
      this.refresh();
      this.watch();
    } catch (err) {
      this.host.toast(`Couldn't make captions: ${errorText(err)}`);
    }
  }

  /** Follows a download or a captions job until it's done. */
  private watch() {
    clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.tick(), 400);
  }

  private async tick() {
    if (this.job) {
      const poll = await editApi.captionsPoll(this.job.id).catch((err) => ({ done: true, error: errorText(err), result: null, progress: 1, stage: "" }));
      if (!poll.done) {
        this.job.progress = poll.progress;
        this.job.stage = poll.stage;
        this.updateProgress();
        return;
      }
      this.job = null;
      clearInterval(this.timer);
      if (poll.error) {
        if (poll.error !== "Cancelled") this.host.toast(`Couldn't make captions: ${poll.error}`);
      } else if (poll.result) {
        const n = poll.result.cues.length ? this.host.apply(poll.result.cues, this.preset, this.highlight) : 0;
        this.host.toast(n ? `Added ${n} captions (${languageName(poll.result.language)}).` : "No speech was found in the clips.");
      }
      this.refresh();
      return;
    }
    await this.loadModels();
    const m = this.models?.find((x) => x.id === this.waiting);
    if (!m || !this.waiting) {
      clearInterval(this.timer);
      return;
    }
    if (m.installed) {
      this.waiting = null;
      clearInterval(this.timer);
      await this.run(this.spans());
      return;
    }
    if (!m.downloading) {
      // Paused, or it failed (the error shows in the panel).
      this.waiting = null;
      clearInterval(this.timer);
    }
    this.refresh();
  }

  /** Moves the bar without redrawing the panel (keeps the focus where it is). */
  private updateProgress() {
    const fill = this.root?.querySelector<HTMLElement>(".ve-cap-fill");
    const stage = this.root?.querySelector<HTMLElement>(".ve-cap-stage");
    if (!fill || !stage || !this.job) return this.refresh();
    fill.style.width = `${Math.round(this.job.progress * 100)}%`;
    stage.textContent = `${this.job.stage || "Starting…"} ${Math.round(this.job.progress * 100)}%`;
  }

  private async cancel() {
    if (this.job) await editApi.captionsCancel(this.job.id).catch(() => undefined);
  }

  private async pauseDownload(id: CaptionModel["id"]) {
    this.waiting = null;
    await editApi.captionModelCancel(id).catch(() => undefined);
    setTimeout(() => void this.loadModels().then(() => this.refresh()), 300);
  }

  private async remove(m: CaptionModel) {
    const answer = await ask({
      title: `Remove the ${m.label} captions model?`,
      text: `It frees ${mb(m.installed ? m.bytes : m.partial)}. Auto captions will offer to download it again when needed.`,
      icon: "subtitles",
      choices: [{ id: "keep", label: "Keep" }, { id: "remove", label: "Remove", primary: true }],
      cancel: "keep",
    });
    if (answer !== "remove") return;
    await editApi.captionModelRemove(m.id).catch((err) => this.host.toast(`Couldn't remove it: ${errorText(err)}`));
    await this.loadModels();
    this.refresh();
  }
}

export function languageName(code: string): string {
  return CAPTION_LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
}
