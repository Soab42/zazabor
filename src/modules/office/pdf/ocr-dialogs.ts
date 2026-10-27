import { h } from "../../../ui/dom";
import type { IconName } from "../../../ui/icons";
import { openDialog, textInput } from "../../time/dialog";
import { parseRange } from "./dialogs";
import { ocrApi, type OcrLanguage } from "./ocr";

/** Dialogs for Scan & OCR: what to read, downloading the language data, and progress. */

export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

export interface OcrChoice {
  langs: string[];
  /** Pages from 1; [] for all. */
  pages: number[];
  /** Read pages that already have text too. */
  all: boolean;
}

export function ocrDialog(langs: OcrLanguage[], count: number, current: number): Promise<OcrChoice | null> {
  return new Promise((resolve) => {
    let answer: OcrChoice | null = null;
    const boxes = langs.map((l) => {
      const c = h("input", { type: "checkbox", checked: l.code === "eng" });
      return { l, c, el: h("label", { class: "pf-check" }, c, l.name, h("span", { class: "pf-note" }, l.installed ? " (ready)" : ` (${megabytes(l.size)} to download)`)) };
    });
    const name = `pf-ocr-pages-${Math.random()}`;
    const all = h("input", { type: "radio", name, checked: true });
    const one = h("input", { type: "radio", name });
    const some = h("input", { type: "radio", name });
    const range = textInput({ value: `1-${count}`, class: "tt-input pf-range-input", "aria-label": "Pages" });
    range.addEventListener("focus", () => (some.checked = true));
    const redo = h("input", { type: "checkbox" });
    const ok = () => {
      const picked = boxes.filter((b) => b.c.checked).map((b) => b.l.code);
      if (!picked.length) return dialog.error("Choose the language the pages are written in.");
      let pages: number[] = [];
      if (one.checked) pages = [current + 1];
      else if (some.checked) {
        const r = parseRange(range.value, count);
        if (!r?.length) return dialog.error("Type pages like 1-3, 5.");
        pages = [...new Set(r)].sort((a, b) => a - b).map((p) => p + 1);
      }
      answer = { langs: picked, pages, all: redo.checked };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Recognize Text",
      subtitle: "Reads scanned pages so their text can be searched, selected and copied. The pages look the same.",
      icon: "pfOcr",
      tone: "work",
      body: [
        h("p", { class: "tt-dialog-text" }, "Language of the text"),
        ...boxes.map((b) => b.el),
        h("p", { class: "tt-dialog-text" }, "Pages"),
        h("label", { class: "pf-check" }, all, `All ${count} pages`),
        h("label", { class: "pf-check" }, one, `This page (${current + 1})`),
        h("label", { class: "pf-check" }, some, "Pages", range),
        h("label", { class: "pf-check" }, redo, "Also read pages that already have text"),
      ],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: ok }, "Recognize"),
      ],
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

/** Asks before downloading `missing` languages' data, then downloads it with progress. */
export function downloadDialog(missing: OcrLanguage[]): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let running: string | null = null;
    const total = missing.reduce((n, l) => n + l.size, 0);
    const bar = h("div", { class: "pf-progress" }, h("div", { class: "pf-progress-fill" }));
    const status = h("p", { class: "tt-dialog-text pf-note" }, `${missing.map((l) => l.name).join(" and ")}: ${megabytes(total)} from Tesseract's language data on GitHub (Apache-2.0). It's kept on this computer, and Settings → PDF can remove it.`);
    bar.hidden = true;
    const start = h("button", { class: "btn primary", type: "button" }, "Download");
    const fill = bar.firstElementChild as HTMLElement;
    const run = async () => {
      start.disabled = true;
      bar.hidden = false;
      let before = 0;
      try {
        for (const l of missing) {
          running = l.code;
          await ocrApi.download(l.code, (received) => {
            fill.style.width = `${Math.min(100, ((before + received) / total) * 100)}%`;
            status.textContent = `Downloading ${l.name}… ${megabytes(before + received)} of ${megabytes(total)}`;
          });
          before += l.size;
        }
        running = null;
        done = true;
        dialog.close();
      } catch (err) {
        running = null;
        start.disabled = false;
        start.textContent = "Try Again";
        if (String(err) !== "Cancelled") dialog.error(`The download didn't finish: ${err}. What arrived is kept, so trying again picks up where it stopped.`);
      }
    };
    start.addEventListener("click", () => void run());
    const dialog = openDialog({
      title: "Download Language Data?",
      subtitle: "Reading text needs Tesseract's language data, downloaded once.",
      icon: "download",
      tone: "work",
      body: [status, bar],
      foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), start],
      onClose: () => {
        if (running) void ocrApi.cancel(running);
        resolve(done);
      },
    });
  });
}

/** A progress window with Cancel; `signal` aborts when it's cancelled. */
export function progressDialog(title: string, subtitle: string, glyph: IconName = "pfOcr") {
  const controller = new AbortController();
  let finished = false;
  const fill = h("div", { class: "pf-progress-fill" });
  const text = h("p", { class: "tt-dialog-text pf-note" }, "Starting…");
  const dialog = openDialog({
    title,
    subtitle,
    icon: glyph,
    tone: "work",
    body: [h("div", { class: "pf-progress" }, fill), text],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel")],
    onClose: () => {
      if (!finished) controller.abort();
    },
  });
  return {
    signal: controller.signal,
    set(message: string, fraction: number) {
      text.textContent = message;
      fill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
    },
    /** Closes without cancelling. */
    finish() {
      finished = true;
      dialog.close();
    },
    get cancelled() {
      return controller.signal.aborted;
    },
  };
}
