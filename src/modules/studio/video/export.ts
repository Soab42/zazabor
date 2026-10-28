import { api } from "../../../api";
import type { ShellContext } from "../../../shell/module";
import { save } from "../../../shared/dialog";
import { basename, dirname, formatBytes, h } from "../../../ui/dom";
import { showToast } from "../../files/ops/toast";
import { openDialog } from "../../time/dialog";
import { errorText } from "../../time/api";
import { editApi, type Codec, type Encoders, type ExportSpec } from "./api";
import { offerCodecInstall } from "./codecs";

export { offerCodecInstall };
import { mixdown, type Engine } from "./engine";
import type { MediaStore } from "./media";
import type { PendingRead } from "./gfx";
import { FramePipe } from "./pipe";
import { canvasSize, projectDuration, type Project } from "./model";
import { formatTime } from "./timeline";

/**
 * Export: settings, then the job. The page draws each frame at the output size (the same
 * compositor as the preview), packs it to I420 on the GPU and hands it to the backend, which
 * encodes with VA-API H.264 into MP4 (or VP9 into WebM). The sound is mixed first with an
 * OfflineAudioContext from the same clips the preview plays. Frames overlap on their way: the
 * page draws one while the GPU reads back the one before and the backend takes the one before
 * that (pipe.ts).
 */

export interface ExportHost {
  project(): Project;
  store: MediaStore;
  engine: Engine;
  /** Decoder keys for the export start with this. */
  keyPrefix: string;
  title: string;
  folder: string | null;
  shell: ShellContext;
}

type Quality = ExportSpec["quality"];
type Speed = NonNullable<ExportSpec["speed"]>;

interface Choice {
  format: "mp4" | "webm";
  codec: Codec["id"];
  short: 720 | 1080;
  fps: number;
  quality: Quality;
  speed: Speed;
  audio: boolean;
}

let last: Partial<Choice> = {};

const SPEED_NOTES: Record<Speed, string> = {
  best: "Motion blur on moving titles",
  fast: "No motion blur; quicker",
};

function segmented<V extends string | number>(options: [V, string][], get: () => V, set: (v: V) => void, disabled: (v: V) => boolean = () => false) {
  const buttons = options.map(([v, label]) => {
    const b = h("button", { type: "button", class: get() === v ? "active" : "", disabled: disabled(v), onclick: () => {
      set(v);
      for (const x of buttons) x.classList.toggle("active", x === b);
    } }, label);
    return b;
  });
  return h("div", { class: "segmented ve-seg" }, ...buttons);
}

/** Asks for the export's settings and file, then runs it. */
export async function openExport(host: ExportHost): Promise<void> {
  const encoders: Encoders = await editApi.encoders().catch(() => ({ h264: false, mp3: false, vp9: false, opus: false, aac: false, hevc: false, codecs: [], missing: [] }));
  const p = host.project();
  const firstCodec = encoders.codecs.find((c) => c.available)?.id ?? "vaapi";
  const choice: Choice = {
    codec: last.codec && encoders.codecs.some((c) => c.id === last.codec && c.available) ? last.codec : firstCodec,
    format: last.format ?? (encoders.h264 ? "mp4" : "webm"),
    short: last.short ?? 1080,
    fps: p.canvas.fps,
    quality: last.quality ?? "standard",
    speed: last.speed ?? "best",
    audio: last.audio ?? true,
  };
  if (choice.format === "mp4" && !encoders.h264) choice.format = "webm";
  const size = h("span", { class: "ve-value" });
  const showSize = () => {
    const { width, height } = canvasSize(p.canvas.aspect, choice.short);
    size.textContent = `${width} × ${height}`;
  };
  showSize();
  const notes: string[] = [];
  if (!encoders.h264) notes.push("MP4 needs an H.264 encoder: VA-API (gstreamer1.0-vaapi) or x264 (gstreamer1.0-plugins-ugly).");
  notes.push(encoders.aac ? "MP4s get AAC sound." : "MP4s get MP3 sound: this system has no AAC encoder (gstreamer1.0-libav adds one). YouTube, Instagram and TikTok take MP3.");
  if (!encoders.hevc) notes.push("HEVC needs x265 (gstreamer1.0-plugins-bad) or an NVIDIA graphics card; VA-API's HEVC encoder doesn't start on this machine.");
  const toast = (text: string) => showToast(text, undefined, 5000);
  const duration = projectDuration(p);
  const settings = await new Promise<Choice | null>((resolve) => {
    let result: Choice | null = null;
    const row = (label: string, control: Node, extra?: Node) => h("div", { class: "ve-row" }, h("label", null, label), control, extra ?? null);
    const audioToggle = h("input", { type: "checkbox", class: "switch", checked: choice.audio, onchange: () => (choice.audio = audioToggle.checked) });
    const codecSelect = h("select", { class: "ve-select", onchange: () => (choice.codec = codecSelect.value as Codec["id"]) },
      ...encoders.codecs.map((c) => h("option", { value: c.id, disabled: !c.available, selected: c.id === choice.codec, title: c.available ? "" : `Needs ${c.needs}` }, c.available ? c.label : `${c.label} — needs ${c.needs}`)));
    const codecRow = row("Video codec", codecSelect);
    const speedNote = h("span", { class: "ve-value" }, SPEED_NOTES[choice.speed]);
    codecRow.hidden = choice.format !== "mp4" || encoders.codecs.length === 0;
    const dialog = openDialog({
      title: "Export video",
      subtitle: `${host.title} · ${formatTime(duration, 30, false)}`,
      icon: "download",
      tone: "work",
      class: "ve-export-dialog tone-video",
      body: [
        row("Format", segmented<"mp4" | "webm">([["mp4", encoders.hevc ? "MP4" : "MP4 · H.264"], ["webm", "WebM · VP9"]], () => choice.format, (v) => {
          choice.format = v;
          codecRow.hidden = v !== "mp4";
        }, (v) => (v === "mp4" ? !encoders.h264 && !encoders.hevc : !encoders.vp9))),
        codecRow,
        row("Resolution", segmented<720 | 1080>([[720, "720p"], [1080, "1080p"]], () => choice.short, (v) => {
          choice.short = v;
          showSize();
        }), size),
        row("Frame rate", segmented<number>([[24, "24"], [25, "25"], [30, "30"], [50, "50"], [60, "60"]], () => choice.fps, (v) => (choice.fps = v))),
        row("Quality", segmented<Quality>([["high", "High"], ["standard", "Standard"], ["small", "Smaller file"]], () => choice.quality, (v) => (choice.quality = v))),
        row("Rendering", segmented<Speed>([["best", "Best"], ["fast", "Fast"]], () => choice.speed, (v) => {
          choice.speed = v;
          speedNote.textContent = SPEED_NOTES[v];
        }), speedNote),
        h("div", { class: "ve-row" }, h("label", null, "Sound"), h("span", { class: "spacer" }), audioToggle),
        h("ul", { class: "ve-export-notes" }, ...notes.map((n) => h("li", null, n))),
      ],
      foot: [
        encoders.missing.length
          ? h("button", { class: "btn", type: "button", title: `Adds ${encoders.missing.join(", ")}`, onclick: async () => {
            dialog.close();
            const now = await offerCodecInstall(encoders.missing, toast);
            if (now) await openExport(host);
          } }, "Install codecs…")
          : null,
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", "data-autofocus": "", onclick: () => {
          result = { ...choice };
          dialog.close();
        } }, "Export…"),
      ],
      onClose: () => resolve(result),
    });
  });
  if (!settings) return;
  last = settings;
  const ext = settings.format;
  const base = host.folder ? `${host.folder}/${host.title}.${ext}` : `${host.title}.${ext}`;
  let path = await save({ title: "Export Video", defaultPath: base, filters: [{ name: ext === "mp4" ? "MP4 video" : "WebM video", extensions: [ext] }] }).catch(() => null);
  if (!path) return;
  if (!path.toLowerCase().endsWith(`.${ext}`)) path += `.${ext}`;
  const { width, height } = canvasSize(p.canvas.aspect, settings.short);
  await run(host, { path, width, height, fps: settings.fps, format: settings.format, quality: settings.quality, speed: settings.speed, audio: settings.audio, codec: settings.format === "mp4" ? settings.codec : "" });
}

/** Runs an export with these settings, showing its progress. */
export async function run(host: ExportHost, spec: ExportSpec) {
  const p = host.project();
  const duration = projectDuration(p);
  const total = Math.max(1, Math.ceil(duration * spec.fps - 1e-6));
  let cancelled = false;
  let running = true;
  const bar = h("div", { class: "ve-progress-bar" });
  const status = h("p", { class: "ve-progress-text" }, "Starting the encoder…");
  const dialog = openDialog({
    title: `Exporting ${basename(spec.path)}`,
    subtitle: `${spec.width} × ${spec.height} · ${spec.fps} fps · ${spec.format === "webm" ? "VP9" : spec.codec?.endsWith("265") ? "HEVC" : "H.264"}${spec.speed === "fast" ? " · Fast" : ""}`,
    icon: "download",
    tone: "work",
    class: "ve-export-dialog tone-video",
    body: [h("div", { class: "ve-progress" }, bar), status],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel")],
    onClose: () => {
      if (running) cancelled = true;
    },
  });
  const engine = host.engine;
  engine.hold(true);
  engine.motion.fast = spec.speed === "fast";
  let job: number | null = null;
  let pipe: FramePipe<PendingRead> | null = null;
  const started = performance.now();
  try {
    job = await editApi.exportBegin(spec);
    if (spec.audio) {
      status.textContent = "Mixing the sound…";
      const pcm = await mixdown(p, host.store, total / spec.fps);
      if (cancelled) throw new Error("Cancelled");
      await editApi.exportAudio(job, pcm);
    }
    const id = job;
    pipe = new FramePipe<PendingRead>({
      collect: (read, out) => engine.gfx.collectI420(read, out),
      send: (seq, frame) => editApi.exportFrame(id, frame, seq),
    }, (spec.width * spec.height * 3) / 2);
    const loopStart = performance.now();
    const mixing = (loopStart - started) / 1000;
    let warming: Promise<void> = engine.warm(0, spec.width, spec.height, host.keyPrefix);
    for (let n = 0; n < total; n++) {
      if (cancelled) break;
      const t = n / spec.fps;
      await warming;
      const waits: Promise<void>[] = [];
      engine.compose(t, spec.width, spec.height, host.keyPrefix, waits);
      if (waits.length) {
        await Promise.all(waits);
        engine.compose(t, spec.width, spec.height, host.keyPrefix, null, false);
      }
      // The next frame's pictures decode while this one is read back and sent.
      warming = n + 1 < total ? engine.warm((n + 1) / spec.fps, spec.width, spec.height, host.keyPrefix) : Promise.resolve();
      await pipe.push(engine.gfx.beginI420());
      if (n % 5 === 0 || n === total - 1) {
        const elapsed = (performance.now() - loopStart) / 1000;
        const fps = (n + 1) / Math.max(0.001, elapsed);
        const left = (total - n - 1) / Math.max(0.1, fps);
        bar.style.width = `${((n + 1) / total) * 100}%`;
        status.textContent = `Frame ${n + 1} of ${total} · ${fps.toFixed(1)} fps (${(fps / spec.fps).toFixed(2)}× real time) · about ${formatTime(left, 30, false)} left`;
        // Let the dialog paint.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (cancelled) throw new Error("Cancelled");
    await pipe.flush();
    status.textContent = "Finishing the file…";
    const done = await editApi.exportFinish(job);
    job = null;
    running = false;
    dialog.close();
    const seconds = (performance.now() - started) / 1000;
    const drawing = seconds - mixing;
    void api.log("info", `[video-editor] exported ${done.frames} frames ${spec.width}x${spec.height} ${spec.codec || spec.format} in ${seconds.toFixed(1)} s (${(done.frames / seconds).toFixed(1)} fps, ${(done.frames / spec.fps / seconds).toFixed(2)}× real time; sound ${mixing.toFixed(1)} s, then frames at ${(done.frames / drawing).toFixed(1)} fps; the encoder kept them waiting ${done.waited.toFixed(1)} s), ${spec.speed ?? "best"}, ${done.bytes} bytes`).catch(() => undefined);
    showToast(`Exported ${basename(done.path)} · ${formatBytes(done.bytes)} in ${formatTime(seconds, 30, false)}`, {
      label: "Show in Files",
      run: () => host.shell.open({ kind: "folder", path: dirname(done.path) }),
    }, 9000);
  } catch (err) {
    running = false;
    pipe?.discard((read) => engine.gfx.dropI420(read));
    if (job !== null) await editApi.exportCancel(job).catch(() => undefined);
    dialog.close();
    if ((err as Error)?.message !== "Cancelled") {
      showToast(`The export stopped: ${errorText(err)}`);
      void api.log("error", `[video-editor] export stopped: ${errorText(err)}`).catch(() => undefined);
    } else showToast("Export cancelled.");
  } finally {
    engine.releasePrefix(host.keyPrefix);
    engine.motion.fast = false;
    engine.hold(false);
  }
}
