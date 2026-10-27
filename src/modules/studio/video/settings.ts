import type { SettingsRow } from "../../../appearance";
import type { Category } from "../../../shell/settings";
import { h } from "../../../ui/dom";
import { showToast } from "../../files/ops/toast";
import { errorText } from "../../time/api";
import { editApi, type CaptionModel, type Encoders } from "./api";
import { offerCodecInstall } from "./codecs";
import "./settings.css";

/**
 * Settings → Video Editor: the auto-captions models on this computer (download, pause, remove)
 * and the codecs exports can use (with Install codecs).
 */
export function videoEditorCategory(): Category {
  const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
  const modelsBox = h("div", { class: "st-ve-models" });
  const codecsBox = h("div", { class: "st-ve-codecs" });
  let timer = 0;

  const wide = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
    label: `${label} ${hint}`,
    el: h("div", { class: "sf-row plain wide" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
  });
  const button = (label: string, onclick: () => void, cls = "btn small") => h("button", { type: "button", class: cls, onclick }, label);

  const drawModels = (models: CaptionModel[]) => {
    modelsBox.replaceChildren(...models.map((m) => {
      const state = m.installed ? `Installed · ${mb(m.bytes)}` : m.downloading ? `Downloading ${Math.floor((m.partial / m.bytes) * 100)}%` : m.partial ? `Paused at ${mb(m.partial)} of ${mb(m.bytes)}` : `Not downloaded · ${mb(m.bytes)}`;
      const act = async (fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          showToast(errorText(err), undefined, 5000);
        }
        void refreshModels();
      };
      return h("div", { class: "st-ve-model" },
        h("div", { class: "st-text" }, h("span", { class: "sf-label" }, m.label), h("p", { class: "sf-hint" }, `${m.note} ${state}.${m.error ? ` ${m.error}` : ""}`)),
        m.downloading
          ? button("Pause", () => void act(() => editApi.captionModelCancel(m.id)))
          : !m.installed ? button(m.partial ? "Resume" : "Download", () => void act(() => editApi.captionModelDownload(m.id))) : null,
        m.installed || m.partial ? button("Remove", () => void act(() => editApi.captionModelRemove(m.id)), "btn small ghost") : null);
    }));
    clearTimeout(timer);
    if (models.some((m) => m.downloading)) timer = window.setTimeout(() => void refreshModels(), 700);
  };
  const refreshModels = async () => drawModels(await editApi.captionModels().catch(() => []));

  const drawCodecs = (e: Encoders) => {
    const list = e.codecs.map((c) => h("li", null, `${c.label}: ${c.available ? "ready" : `needs ${c.needs}`}`));
    list.push(h("li", null, `Sound in MP4: ${e.aac ? "AAC" : "MP3 (AAC needs gstreamer1.0-libav)"}`));
    codecsBox.replaceChildren(
      h("ul", { class: "st-ve-list" }, ...list),
      e.missing.length
        ? button("Install codecs…", () => void offerCodecInstall(e.missing, (t) => showToast(t, undefined, 5000)).then((now) => now && drawCodecs(now)))
        : h("p", { class: "sf-hint" }, "Everything Zazabor can use is installed."));
  };
  const refreshCodecs = async () => {
    const e = await editApi.encoders().catch(() => null);
    if (e) drawCodecs(e);
  };

  return {
    id: "video-editor", title: "Video Editor", icon: "videoEdit", section: "Modules",
    groups: [
      {
        title: "Auto captions",
        rows: [wide("Speech models", "Whisper, run on this computer. Downloaded once from the whisper.cpp project; videos never leave the computer.", modelsBox)],
      },
      {
        title: "Codecs",
        rows: [wide("Export encoders", "What MP4 exports can use. Installing codecs also lets the editor read phones' AAC sound directly.", codecsBox)],
      },
    ],
    refresh() {
      void refreshModels();
      void refreshCodecs();
    },
  };
}
