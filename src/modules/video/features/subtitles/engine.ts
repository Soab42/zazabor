import { readText } from "../../../files/info-api";
import { CueIndex } from "./cues";
import { cueText, parseSubtitles } from "./parse";
import { applyStyle, DEFAULT_STYLE, type SubStyle } from "./style";
import type { Cue, Run } from "./types";

/** The largest subtitle file we read (a very long film is well under 1 MB). */
const MAX_BYTES = 8 * 1024 * 1024;

/** Extensions our own renderer understands; others (sub, idx, sup…) are left to VLC. */
export const OWN_FORMATS = ["srt", "vtt", "ass", "ssa"];
export const ownFormat = (path: string) => OWN_FORMATS.includes((/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase());

type Zone = "top" | "middle" | "bottom";
const zoneOf = (align: number): Zone => (align >= 7 ? "top" : align >= 4 ? "middle" : "bottom");
const sideOf = (align: number) => (align % 3 === 1 ? "left" : align % 3 === 0 ? "right" : "center");

/** Draws one cue's lines into `parent`. Text goes in through `textContent` only. */
export function renderCue(parent: HTMLElement, cue: Cue) {
  const block = document.createElement("div");
  block.className = "sub-cue";
  block.style.textAlign = sideOf(cue.align);
  block.style.alignSelf = sideOf(cue.align) === "left" ? "flex-start" : sideOf(cue.align) === "right" ? "flex-end" : "center";
  for (const runs of cue.lines) {
    const line = document.createElement("div");
    line.className = "sub-line";
    const inner = document.createElement("span");
    inner.className = "sub-text";
    for (const run of runs) inner.append(runNode(run));
    line.append(inner);
    block.append(line);
  }
  parent.append(block);
}

function runNode(run: Run): Node {
  if (!run.italic && !run.bold && !run.underline) return document.createTextNode(run.text);
  const span = document.createElement("span");
  if (run.italic) span.style.fontStyle = "italic";
  if (run.bold) span.style.fontWeight = "700";
  if (run.underline) span.style.textDecoration = "underline";
  span.textContent = run.text;
  return span;
}

/**
 * Our own renderer for external subtitle files: parses the file, and shows the cues that are on
 * screen at a given time as styled text in the stage layer.
 */
export class SubtitleEngine {
  index: CueIndex | null = null;
  path: string | null = null;
  /** Positive shows subtitles later. */
  delay = 0;
  style: SubStyle = { ...DEFAULT_STYLE };

  private readonly root = document.createElement("div");
  private readonly zones: Record<Zone, HTMLElement>;
  private readonly observer: ResizeObserver;
  private height = 0;
  private shown: Cue[] = [];
  private lastTime = 0;
  private loadToken = 0;

  constructor(parent: HTMLElement) {
    this.root.className = "sub-root";
    this.zones = { top: this.zone("top"), middle: this.zone("middle"), bottom: this.zone("bottom") };
    this.root.append(this.zones.top, this.zones.middle, this.zones.bottom);
    parent.append(this.root);
    this.observer = new ResizeObserver(() => {
      this.height = this.root.clientHeight;
      this.restyle();
    });
    this.observer.observe(this.root);
  }

  private zone(name: Zone): HTMLElement {
    const el = document.createElement("div");
    el.className = `sub-zone ${name}`;
    return el;
  }

  get active(): boolean {
    return this.index !== null;
  }

  /** Reads and parses a subtitle file; rejects when it has no subtitles. Returns the cue count. */
  async load(path: string): Promise<number> {
    const token = ++this.loadToken;
    const preview = await readText(path, MAX_BYTES);
    if (token !== this.loadToken) return 0;
    if (preview.binary || preview.truncated) throw new Error("That file is not a text subtitle file.");
    const cues = parseSubtitles(preview.text);
    if (cues.length === 0) throw new Error("No subtitles were found in that file.");
    this.index = new CueIndex(cues);
    this.path = path;
    this.clearShown();
    this.render(this.lastTime);
    return cues.length;
  }

  /** Stops showing the file and forgets it. */
  unload() {
    this.loadToken++;
    this.index = null;
    this.path = null;
    this.clearShown();
  }

  setDelay(ms: number) {
    this.delay = ms;
    this.render(this.lastTime);
  }

  setStyle(style: SubStyle) {
    this.style = style;
    this.restyle();
  }

  private restyle() {
    applyStyle(this.root, this.style, this.height || this.root.clientHeight);
    this.zones.bottom.style.bottom = `${this.style.bottom}%`;
  }

  private clearShown() {
    this.shown = [];
    for (const zone of Object.values(this.zones)) zone.replaceChildren();
  }

  /** Shows what is on screen at video time `time` (ms) once the delay is applied. */
  render(time: number) {
    this.lastTime = time;
    if (!this.index) return;
    const now = this.index.at(time - this.delay);
    if (now.length === this.shown.length && now.every((c, i) => c === this.shown[i])) return;
    this.shown = now;
    for (const zone of Object.values(this.zones)) zone.replaceChildren();
    for (const cue of now) renderCue(this.zones[zoneOf(cue.align)], cue);
  }

  /** The cue text on screen, for tests and the tab's status line. */
  get currentText(): string {
    return this.shown.map(cueText).join("\n");
  }

  dispose() {
    this.observer.disconnect();
    this.root.remove();
    this.index = null;
  }
}
