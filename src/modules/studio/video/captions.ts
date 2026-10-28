import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { errorText } from "../../time/api";
import { ask } from "../photo/ask";
import { editApi, type CaptionModel, type CaptionSpan, type Cue } from "./api";
import { mediaOf, type MediaClip, type Project } from "./model";
import { TEXT_PRESETS } from "./text";
import { callout, colorRow, note, segRow, selectRow, type Syncs } from "./controls";

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
    // The pane is drawn again on each change; its controls' syncs only matter for the colour well.
    const syncs: Syncs = [];
    const resync = () => syncs.forEach((f) => f());

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
    const installed = models.filter((m) => m.installed || m.partial > 0);
    const root = h("div", { class: "ve-captions" },
      note("Writes captions from the clips' speech, lit up word by word. It runs on this computer; nothing is uploaded.", "vc-lede"),
      segRow(syncs, "From", [["all", "All clips"], ["selected", "Selected"]] as const, () => this.scope, (v) => {
        this.scope = v;
        this.refresh();
      }),
      selectRow(syncs, "Language", CAPTION_LANGUAGES, () => this.language, (v) => {
        this.language = v;
        // Small is the better of the two at Bangla, though neither gets it right yet.
        if (v === "bn") this.model = "small";
        this.refresh();
      }),
      selectRow(syncs, "Model", modelOptions, () => this.model, (v) => {
        this.model = v as CaptionModel["id"];
        this.refresh();
      }),
      chosen?.note ? note(chosen.note, "vc-under") : null,
      selectRow(syncs, "Style", TEXT_PRESETS.map((p) => [p.id, p.label] as [string, string]), () => this.preset, (v) => (this.preset = v)),
      colorRow(syncs, "Highlight", {
        get: () => this.highlight, optional: true, fallback: "#ffd23f",
        set: (v) => {
          this.highlight = v;
          resync();
        },
      }),
      error?.error ? callout(error.error, "danger") : null,
      progress,
      h("button", { class: "btn primary vc-wide", type: "button", disabled: busy, onclick: () => void this.generate() }, icon("subtitles", 16), action),
      installed.length
        ? h("div", { class: "ve-cap-models" }, h("h3", { class: "vc-group-h" }, "Models on this computer"),
          ...installed.map((m) =>
            h("div", { class: "vc-list-row" },
              h("span", { class: "vc-list-icon" }, icon("subtitles", 15)),
              h("div", { class: "vc-list-text" }, h("div", { class: "vc-list-title" }, m.label), h("div", { class: "vc-list-sub" }, m.installed ? mb(m.bytes) : `${mb(m.partial)} of ${mb(m.bytes)}`)),
              h("button", { class: "vc-mini", type: "button", title: "Remove from this computer", "aria-label": `Remove ${m.label}`, disabled: m.downloading || busy, onclick: () => void this.remove(m) }, icon("trash", 13)))))
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
