import type { PhotoInfo } from "../../../api";
import type { Photo } from "../library/model";
import { clear, formatBytes, formatDateTime, h } from "../../../ui/dom";
import { drawHistogram, type Histogram } from "./histogram";

export class InfoPanel {
  readonly el = h("aside", { class: "v-info" });
  private histogramCanvas = h("canvas", { class: "histogram" });
  private body = h("div", { class: "info-body" });
  private histogram: Histogram | null = null;

  constructor() {
    this.el.append(
      h("section", { class: "info-section" }, h("h3", null, "Histogram"), this.histogramCanvas),
      this.body,
    );
  }

  update(photo: Photo, info: PhotoInfo | null, width: number, height: number) {
    clear(this.body);
    const megapixels = width && height ? `${((width * height) / 1e6).toFixed(1)} MP` : "";
    const file: [string, string][] = [
      ["Name", photo.name],
      ["Folder", photo.folder.path],
      ["Dimensions", width && height ? `${width.toLocaleString()} × ${height.toLocaleString()}  ·  ${megapixels}` : "Unknown"],
      ["Size", formatBytes(info?.size ?? photo.size)],
      ["Format", info?.format ?? ""],
      ["Modified", formatDateTime(info?.mtime ?? photo.mtime)],
    ];
    this.body.append(this.section("File", file));
    if (info?.exif.length) this.body.append(this.section("Camera", info.exif));
    else if (info) this.body.append(h("p", { class: "info-empty" }, "No camera metadata in this file."));
  }

  setHistogram(hist: Histogram | null) {
    this.histogram = hist;
    this.redraw();
  }

  redraw() {
    if (!this.el.hidden) drawHistogram(this.histogramCanvas, this.histogram);
  }

  private section(title: string, rows: [string, string][]) {
    const dl = h("dl", { class: "info-table" });
    for (const [label, value] of rows) {
      if (!value) continue;
      dl.append(h("dt", null, label), h("dd", { title: value }, value));
    }
    return h("section", { class: "info-section" }, h("h3", null, title), dl);
  }
}
