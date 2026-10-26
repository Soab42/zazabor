import { h } from "../../../ui/dom";
import { openDialog } from "../../time/dialog";
import "../../time/time-module.css";
import { SAVE_FORMATS, type SaveFormat } from "./api";
import type { PhotoSettings } from "./settings";

export interface NewCanvas {
  width: number;
  height: number;
  background: "white" | "black" | "transparent";
}

const PRESETS: { label: string; width: number; height: number }[] = [
  { label: "Square post", width: 1080, height: 1080 },
  { label: "Portrait post", width: 1080, height: 1350 },
  { label: "Story or reel", width: 1080, height: 1920 },
  { label: "Full HD", width: 1920, height: 1080 },
  { label: "4K UHD", width: 3840, height: 2160 },
  { label: "A4 at 300 ppi", width: 2480, height: 3508 },
];

const field = (label: string, control: HTMLElement, suffix?: string) =>
  h("label", { class: "ph-field" }, h("span", { class: "ph-field-label" }, label), control, suffix ? h("span", { class: "ph-field-suffix" }, suffix) : null);

const numberInput = (value: number, max: number) => h("input", { type: "number", class: "ph-input", min: 1, max, step: 1, value });

/** Asks for a new canvas's size and background; null when cancelled. */
export function askNewCanvas(last: PhotoSettings["newCanvas"], maxSide: number): Promise<NewCanvas | null> {
  return new Promise((resolve) => {
    let result: NewCanvas | null = null;
    const width = numberInput(last.width, maxSide);
    const height = numberInput(last.height, maxSide);
    const preset = h("select", { class: "ph-select" },
      ...PRESETS.map((p, i) => h("option", { value: String(i) }, `${p.label} · ${p.width} × ${p.height}`)),
      h("option", { value: "custom" }, "Custom"));
    const sync = () => {
      const i = PRESETS.findIndex((p) => p.width === Number(width.value) && p.height === Number(height.value));
      preset.value = i >= 0 ? String(i) : "custom";
    };
    sync();
    preset.addEventListener("change", () => {
      const p = PRESETS[Number(preset.value)];
      if (!p) return;
      width.value = String(p.width);
      height.value = String(p.height);
    });
    width.addEventListener("input", sync);
    height.addEventListener("input", sync);
    let background = last.background;
    const backgrounds = h("div", { class: "segmented" }, ...(["white", "black", "transparent"] as const).map((b) => {
      const button = h("button", { type: "button", class: b === background ? "active" : "", onclick: () => {
        background = b;
        for (const other of backgrounds.children) other.classList.toggle("active", other === button);
      } }, b === "white" ? "White" : b === "black" ? "Black" : "Transparent");
      return button;
    }));
    const submit = () => {
      const w = Math.round(Number(width.value)), hgt = Math.round(Number(height.value));
      if (!(w >= 1 && w <= maxSide && hgt >= 1 && hgt <= maxSide)) {
        dialog.error(`Width and height go from 1 to ${maxSide} pixels on this computer.`);
        return;
      }
      result = { width: w, height: hgt, background };
      dialog.close();
    };
    const dialog = openDialog({
      title: "New Canvas",
      subtitle: "Pixels, for screens and social posts",
      icon: "phCanvas",
      tone: "work",
      body: [
        field("Preset", preset),
        h("div", { class: "ph-field-row" }, field("Width", width, "px"), field("Height", height, "px")),
        field("Background", backgrounds),
      ],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: submit }, "Create"),
      ],
      submit,
      onClose: () => resolve(result),
    });
    width.focus();
    width.select();
  });
}

/** Export As: a format and, for JPEG, a quality. */
export function askExport(last: PhotoSettings["export"]): Promise<{ format: SaveFormat; quality: number } | null> {
  return new Promise((resolve) => {
    let result: { format: SaveFormat; quality: number } | null = null;
    const format = h("select", { class: "ph-select" }, ...SAVE_FORMATS.map((f) => h("option", { value: f.id }, f.name)));
    format.value = last.format;
    const quality = h("input", { type: "range", min: 1, max: 100, step: 1, value: last.quality, class: "ph-range" });
    const qualityValue = h("span", { class: "ph-field-suffix" });
    const qualityRow = h("label", { class: "ph-field" }, h("span", { class: "ph-field-label" }, "Quality"), quality, qualityValue);
    const note = h("p", { class: "tt-dialog-text ph-note" });
    const sync = () => {
      qualityValue.textContent = `${quality.value}`;
      qualityRow.hidden = format.value !== "jpeg";
      note.textContent = format.value === "jpeg" || format.value === "bmp"
        ? "This format has no transparency: transparent parts become white. Layers are merged."
        : "Layers are merged into one picture; the colour profile is kept.";
    };
    format.addEventListener("change", sync);
    quality.addEventListener("input", sync);
    sync();
    const submit = () => {
      result = { format: format.value as SaveFormat, quality: Number(quality.value) };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Export As",
      icon: "phExport",
      tone: "work",
      body: [field("Format", format), qualityRow, note],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: submit }, "Export…"),
      ],
      submit,
      onClose: () => resolve(result),
    });
  });
}

/** Image Size: new pixel dimensions, keeping the proportions unless unlinked. */
export function askImageSize(width: number, height: number, maxSide: number): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let result: { width: number; height: number } | null = null;
    const w = numberInput(width, maxSide);
    const hgt = numberInput(height, maxSide);
    const link = h("input", { type: "checkbox", class: "switch", checked: true });
    w.addEventListener("input", () => {
      if (link.checked) hgt.value = String(Math.max(1, Math.round((Number(w.value) * height) / width)));
    });
    hgt.addEventListener("input", () => {
      if (link.checked) w.value = String(Math.max(1, Math.round((Number(hgt.value) * width) / height)));
    });
    const submit = () => {
      const nw = Math.round(Number(w.value)), nh = Math.round(Number(hgt.value));
      if (!(nw >= 1 && nw <= maxSide && nh >= 1 && nh <= maxSide)) {
        dialog.error(`Width and height go from 1 to ${maxSide} pixels on this computer.`);
        return;
      }
      result = { width: nw, height: nh };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Image Size",
      subtitle: `Now ${width} × ${height} pixels`,
      icon: "phCanvas",
      tone: "work",
      body: [
        h("div", { class: "ph-field-row" }, field("Width", w, "px"), field("Height", hgt, "px")),
        h("label", { class: "ph-check" }, link, "Keep proportions"),
      ],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: submit }, "Resize"),
      ],
      submit,
      onClose: () => resolve(result),
    });
    w.focus();
    w.select();
  });
}
