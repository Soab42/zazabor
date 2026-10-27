import type { SettingsRow } from "../../../appearance";
import type { Category } from "../../../shell/settings";
import { basename, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { forgetCertificate, lastCertificate } from "./certs";
import { ocrApi, type OcrLanguage } from "./ocr";
import { megabytes } from "./ocr-dialogs";

/**
 * Settings → PDF: the language data Recognize Text downloaded (with Remove), and the certificate
 * Zazabor remembers for signing (its path only; Forget).
 */
export function pdfCategory(): Category {
  const note = h("p", { class: "sf-hint" });
  const wide = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
    label: `${label} ${hint}`,
    el: h("div", { class: "sf-row plain wide st-notes-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
  });
  const langs = h("div", { class: "st-inline pf-st-langs" });
  const cert = h("div", { class: "st-inline" });

  const drawLangs = (list: OcrLanguage[]) => {
    langs.replaceChildren(...list.map((l) => {
      const status = h("span", { class: "st-value" }, l.installed ? `${l.name}: ${megabytes(l.size)}` : l.partial ? `${l.name}: ${megabytes(l.partial)} of ${megabytes(l.size)} downloaded` : `${l.name}: not downloaded`);
      const download = h("button", {
        class: "btn small", type: "button", hidden: l.installed,
        onclick: async () => {
          download.disabled = true;
          try {
            await ocrApi.download(l.code, (got, total) => (status.textContent = `${l.name}: ${megabytes(got)} of ${megabytes(total)}…`));
          } catch (err) {
            note.textContent = `${l.name} didn't download: ${err}`;
          }
          void refresh();
        },
      }, icon("download", 13), l.partial ? "Resume" : "Download");
      const remove = h("button", {
        class: "btn small ghost", type: "button", hidden: !l.installed && !l.partial,
        onclick: () => void ocrApi.remove(l.code).then(refresh, (err) => (note.textContent = String(err))),
      }, "Remove");
      return h("div", { class: "st-inline" }, status, download, remove);
    }));
  };

  const drawCert = () => {
    const path = lastCertificate();
    cert.replaceChildren(
      h("span", { class: "st-value", title: path }, path ? basename(path) : "None"),
      ...(path ? [h("button", { class: "btn small ghost", type: "button", onclick: () => (forgetCertificate(), drawCert()) }, "Forget")] : []));
  };

  async function refresh() {
    note.textContent = "";
    drawCert();
    try {
      drawLangs(await ocrApi.languages());
    } catch (err) {
      langs.replaceChildren(h("span", { class: "sf-hint" }, String(err)));
    }
  }
  void refresh();

  return {
    id: "pdf", title: "PDF", icon: "pdfFile", section: "Modules",
    groups: [
      {
        title: "Recognize Text",
        rows: [
          wide("Languages", "Tesseract's data for reading scanned pages (Convert → Recognize Text), downloaded the first time a language is used and kept on this computer.", langs),
          { label: "note", el: note },
        ],
      },
      {
        title: "Certificates",
        rows: [wide("Certificate for signing", "The .p12/.pfx file Fill & Sign → Certificate starts with. Only its place is remembered, never its password.", cert)],
      },
    ],
    refresh: () => void refresh(),
  };
}
