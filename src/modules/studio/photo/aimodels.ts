import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openDialog } from "../../time/dialog";
import { ask } from "./ask";

/**
 * Photo's AI tools run on this computer (src-tauri/src/photo/ai.rs). Their models aren't bundled:
 * each downloads once, after asking with its size, and resumes if stopped. This file talks to
 * that side: the model list, downloads with a progress dialog, and the tools' calls.
 */

/** "subject" and "subject-fast" find the main subject; "select" is click to select; "remove" fills. */
export type AiTool = "subject" | "subject-fast" | "select" | "remove";

export interface AiModel {
  id: string;
  title: string;
  bytes: number;
  licence: string;
  source: string;
  installed: boolean;
  /** Bytes of an unfinished download. */
  partial: number;
}

export interface AiModels {
  models: AiModel[];
  tools: Record<AiTool, string[]>;
}

export interface SamPoint {
  x: number;
  y: number;
  /** A click that adds (true) or one that takes away (false). */
  add: boolean;
}

export interface InpaintPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8Array;
}

function bytesOf(result: unknown): Uint8Array {
  return result instanceof ArrayBuffer ? new Uint8Array(result) : result instanceof Uint8Array ? result : new Uint8Array(result as number[]);
}

const meta = (o: object) => ({ headers: { "x-meta": encodeURIComponent(JSON.stringify(o)) } });

export const aiApi = {
  models: () => invoke<AiModels>("photo_ai_models"),
  download: (id: string) => invoke<void>("photo_ai_download", { id }),
  cancel: (id: string) => invoke<void>("photo_ai_cancel", { id }),
  remove: (id: string) => invoke<void>("photo_ai_remove", { id }),
  /** How opaque the main subject is at each pixel (one byte a pixel). */
  async subject(rgba: Uint8Array, width: number, height: number, fast: boolean): Promise<Uint8Array> {
    return bytesOf(await invoke("photo_ai_subject", rgba, meta({ width, height, fast })));
  },
  /** Lets MobileSAM look at a picture; the token is for `samMask`. */
  samEmbed: (rgba: Uint8Array, width: number, height: number) => invoke<number>("photo_ai_sam_embed", rgba, meta({ width, height })),
  async samMask(token: number, points: SamPoint[]): Promise<Uint8Array> {
    return bytesOf(await invoke("photo_ai_sam_mask", { token, points }));
  },
  /** Fills where `mask` > 127 from its surroundings; returns the changed area. */
  async inpaint(rgba: Uint8Array, mask: Uint8Array, width: number, height: number): Promise<InpaintPatch> {
    const body = new Uint8Array(rgba.length + mask.length);
    body.set(rgba, 0);
    body.set(mask, rgba.length);
    const out = bytesOf(await invoke("photo_ai_inpaint", body, meta({ width, height })));
    const view = new DataView(out.buffer, out.byteOffset, 16);
    const [x, y, w, hgt] = [0, 4, 8, 12].map((at) => view.getUint32(at, true));
    return { x, y, width: w, height: hgt, rgba: out.subarray(16, 16 + w * hgt * 4) };
  },
};

export const megabytes = (bytes: number) => (bytes >= 100 * 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The tool's models are on this computer: asks before downloading what's missing, then shows the
 * download. False when declined, cancelled or failed (an error is shown in the dialog first).
 */
export async function ensureModels(tool: AiTool, purpose: string): Promise<boolean> {
  let all: AiModels;
  try {
    all = await aiApi.models();
  } catch (err) {
    await ask({ title: "AI tools aren't available", text: errorText(err), icon: "sparkles", choices: [{ id: "ok", label: "OK", primary: true }], cancel: "ok" });
    return false;
  }
  const missing = (all.tools[tool] ?? []).map((id) => all.models.find((m) => m.id === id)).filter((m): m is AiModel => !!m && !m.installed);
  if (!missing.length) return true;
  const left = missing.reduce((n, m) => n + m.bytes - m.partial, 0);
  const licences = [...new Set(missing.map((m) => m.licence))].join(", ");
  const resumed = missing.some((m) => m.partial > 0);
  const answer = await ask({
    title: missing.length > 1 ? `Download the ${purpose} models?` : `Download the ${purpose} model?`,
    text: `${missing.map((m) => m.title).join(" and ")} ${missing.length > 1 ? "download" : "downloads"} once (${megabytes(left)}${resumed ? " left" : ""}; ${licences}). It runs on this computer: your pictures never leave it.`,
    icon: "download",
    choices: [{ id: "cancel", label: "Not Now" }, { id: "download", label: `Download ${megabytes(left)}`, primary: true }],
    cancel: "cancel",
  });
  if (answer !== "download") return false;
  return downloadModels(missing);
}

/** Downloads models one after another in a dialog with a progress bar; true when all arrived. */
export function downloadModels(models: AiModel[]): Promise<boolean> {
  return new Promise((resolve) => {
    const total = models.reduce((n, m) => n + m.bytes, 0);
    const done = new Map(models.map((m) => [m.id, m.partial]));
    let current: string | null = null;
    let settled = false;
    let failed = false;
    const fill = h("div", { class: "ph-progress-fill" });
    const bar = h("div", { class: "ph-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
    const line = h("p", { class: "tt-dialog-text ph-progress-text" });
    const draw = () => {
      const sum = [...done.values()].reduce((a, b) => a + b, 0);
      const pct = total ? Math.min(100, (sum / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(Math.round(pct)));
      const name = models.find((m) => m.id === current)?.title ?? "";
      line.textContent = `${name ? `${name}: ` : ""}${megabytes(sum)} of ${megabytes(total)}`;
    };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      void unlisten.then((fn) => fn());
      resolve(ok);
    };
    const cancelButton = h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel");
    const dialog = openDialog({
      title: "Downloading",
      subtitle: "Once only: the next time it starts at once",
      icon: "download",
      tone: "work",
      body: [line, bar, h("p", { class: "tt-dialog-text ph-note" }, "Cancelling keeps what has arrived; the download continues from there next time.")],
      foot: [h("span", { class: "spacer" }), cancelButton],
      onClose: () => {
        if (current && !failed) void aiApi.cancel(current);
        finish(false);
      },
    });
    const unlisten = listen<{ id: string; done: number; total: number }>("photo-ai-download", (e) => {
      done.set(e.payload.id, e.payload.done);
      draw();
    });
    draw();
    void (async () => {
      try {
        for (const m of models) {
          if (settled) return;
          current = m.id;
          draw();
          await aiApi.download(m.id);
          done.set(m.id, m.bytes);
        }
        current = null;
        finish(true);
        dialog.close();
      } catch (err) {
        if (settled) return;
        failed = true;
        const text = errorText(err);
        if (text === "Cancelled") return finish(false);
        dialog.error(text);
        cancelButton.textContent = "Close";
      }
    })();
  });
}

/** Settings → Photo: each model, its size and licence, downloaded or not, with Download/Remove. */
export function modelsPanel(): { el: HTMLElement; refresh: () => void } {
  const el = h("div", { class: "ph-models" });
  const refresh = () => {
    void aiApi.models().then((all) => {
      el.replaceChildren(...all.models.map((m) => {
        const state = m.installed ? "Downloaded" : m.partial > 0 ? `${megabytes(m.partial)} of ${megabytes(m.bytes)} so far` : "Not downloaded";
        const action = m.installed || m.partial > 0
          ? h("button", { class: "btn small ghost", type: "button", onclick: () => void aiApi.remove(m.id).then(refresh) }, icon("trash", 13), "Remove")
          : h("button", { class: "btn small", type: "button", onclick: () => void downloadModels([m]).then(refresh) }, icon("download", 13), "Download");
        return h("div", { class: "ph-model" },
          h("div", { class: "ph-model-text" },
            h("span", { class: "ph-model-title" }, m.title),
            h("span", { class: "ph-model-meta" }, `${megabytes(m.bytes)} · ${m.licence} · ${state}`)),
          action);
      }));
    }, (err) => el.replaceChildren(h("p", { class: "sf-hint" }, errorText(err))));
  };
  refresh();
  return { el, refresh };
}

// ---- pictures for the models: smaller on the way in, the masks back to full size ----

/** The pixels scaled so the long side is at most `max` (the models look at 1024 px or less). */
export function shrinkRgba(rgba: Uint8Array, width: number, height: number, max: number): { rgba: Uint8Array; width: number; height: number } {
  if (Math.max(width, height) <= max) return { rgba, width, height };
  const k = max / Math.max(width, height);
  const w = Math.max(1, Math.round(width * k)), hgt = Math.max(1, Math.round(height * k));
  const src = new OffscreenCanvas(width, height);
  const pixels = new Uint8ClampedArray(rgba.length);
  pixels.set(rgba);
  src.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  const dst = new OffscreenCanvas(w, hgt);
  const ctx = dst.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, hgt);
  return { rgba: new Uint8Array(ctx.getImageData(0, 0, w, hgt).data.buffer), width: w, height: hgt };
}

/** A one-byte-a-pixel mask scaled smoothly to `width` × `height`. */
export function growMask(mask: Uint8Array, w: number, hgt: number, width: number, height: number): Uint8Array {
  if (w === width && hgt === height) return mask;
  const grey = new Uint8ClampedArray(w * hgt * 4);
  for (let i = 0; i < mask.length; i++) grey[i * 4] = grey[i * 4 + 1] = grey[i * 4 + 2] = mask[i], grey[i * 4 + 3] = 255;
  const src = new OffscreenCanvas(w, hgt);
  src.getContext("2d")!.putImageData(new ImageData(grey, w, hgt), 0, 0);
  const dst = new OffscreenCanvas(width, height);
  const ctx = dst.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, width, height);
  const big = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = big[i * 4];
  return out;
}
