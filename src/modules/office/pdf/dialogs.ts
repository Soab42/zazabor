import type { PDFDocumentProxy } from "pdfjs-dist";
import { h } from "../../../ui/dom";
import { field, openDialog, textInput } from "../../time/dialog";

/** The password a protected PDF asks for; null when the user gives up. */
export function passwordDialog(name: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const input = textInput({ type: "password", "aria-label": "Password", "data-autofocus": "", autocomplete: "off" });
    const ok = () => {
      if (!input.value) return dialog.error("Type the password.");
      answer = input.value;
      dialog.close();
    };
    const dialog = openDialog({
      title: "Password",
      subtitle: `“${name}” is protected. Type its password to open it.`,
      icon: "lock",
      tone: "work",
      class: "tt-confirm",
      body: [field("Password", input)],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: ok }, "Open"),
      ],
      submit: ok,
      onClose: () => resolve(answer),
    });
    if (wrong) dialog.error("That password isn't right. Try again.");
  });
}

/**
 * Pages typed as "1-3, 5, 8-" (1-based, in the order typed; "-4" from the start, "8-" to the
 * end), as 0-based indexes; null when it doesn't read.
 */
export function parseRange(text: string, count: number): number[] | null {
  const out: number[] = [];
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    if (m) {
      const from = m[1] ? Number(m[1]) : 1;
      const to = m[2] ? Number(m[2]) : count;
      if (from < 1 || to > count || from > to) return null;
      for (let p = from; p <= to; p++) out.push(p - 1);
    } else if (/^\d+$/.test(part)) {
      const p = Number(part);
      if (p < 1 || p > count) return null;
      out.push(p - 1);
    } else return null;
  }
  return out;
}

/** 0-based pages as "1-3, 5". */
export function rangeText(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(j > i ? `${sorted[i] + 1}-${sorted[j] + 1}` : `${sorted[i] + 1}`);
    i = j;
  }
  return runs.join(", ");
}

/** Extract Pages: which pages, and whether to take them out of this file. */
export function extractDialog(count: number, selected: number[]): Promise<{ pages: number[]; remove: boolean } | null> {
  return new Promise((resolve) => {
    let answer: { pages: number[]; remove: boolean } | null = null;
    const range = textInput({ value: selected.length ? rangeText(selected) : `1-${count}`, "aria-label": "Pages", "data-autofocus": "" });
    const remove = h("input", { type: "checkbox" });
    const ok = () => {
      const pages = parseRange(range.value, count);
      if (!pages?.length) return dialog.error(`Type pages between 1 and ${count}, like 1-3, 5.`);
      if (remove.checked && new Set(pages).size >= count) return dialog.error("A file has to keep at least one page.");
      answer = { pages, remove: remove.checked };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Extract Pages",
      subtitle: "Saves a copy of the pages as a new PDF.",
      icon: "pageExtract",
      tone: "work",
      body: [field("Pages", range, { note: `of ${count}` }), h("label", { class: "pf-check" }, remove, "Delete the pages from this file after extracting")],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: ok }, "Extract…"),
      ],
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

/** Split: every N pages, or at each top-level bookmark; then a folder to save the parts in. */
export function splitDialog(count: number, hasBookmarks: boolean): Promise<{ by: "pages"; size: number } | { by: "bookmarks" } | null> {
  return new Promise((resolve) => {
    let answer: { by: "pages"; size: number } | { by: "bookmarks" } | null = null;
    const byPages = h("input", { type: "radio", name: "pf-split", checked: true });
    const byMarks = h("input", { type: "radio", name: "pf-split", disabled: !hasBookmarks });
    const size = textInput({ value: "1", inputmode: "numeric", class: "tt-input pf-num", "aria-label": "Pages in each file" });
    size.addEventListener("focus", () => (byPages.checked = true));
    const ok = () => {
      if (byMarks.checked) answer = { by: "bookmarks" };
      else {
        const n = Number(size.value);
        if (!Number.isInteger(n) || n < 1 || n >= count) return dialog.error(`Type a number of pages from 1 to ${count - 1}.`);
        answer = { by: "pages", size: n };
      }
      dialog.close();
    };
    const dialog = openDialog({
      title: "Split Document",
      subtitle: `${count} pages into separate PDFs, saved next to each other in a folder you choose.`,
      icon: "pageSplit",
      tone: "work",
      body: [
        h("label", { class: "pf-check" }, byPages, "Every", size, "pages"),
        h("label", { class: `pf-check${hasBookmarks ? "" : " disabled"}` }, byMarks, hasBookmarks ? "At each top-level bookmark" : "At each top-level bookmark (this file has none)"),
      ],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: ok }, "Split…"),
      ],
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

/** Go to Page (Ctrl+Shift+N, as in Acrobat). */
export function goToDialog(count: number, current: number, go: (page: number) => void) {
  const input = textInput({ value: String(current), inputmode: "numeric", "aria-label": "Page", "data-autofocus": "" });
  const ok = () => {
    const page = Number(input.value);
    if (!Number.isInteger(page) || page < 1 || page > count) return dialog.error(`Type a page from 1 to ${count}.`);
    dialog.close();
    go(page);
  };
  const dialog = openDialog({
    title: "Go to Page",
    icon: "pdfFile",
    tone: "work",
    class: "tt-confirm",
    body: [field("Page", input, { note: `of ${count}` })],
    foot: [
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
      h("button", { class: "btn primary", type: "button", onclick: ok }, "Go"),
    ],
    submit: ok,
  });
  requestAnimationFrame(() => input.select());
}

function pdfDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = value.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return value;
  const d = new Date(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Document Properties (Ctrl+D, as in Acrobat): what the file says about itself. */
export async function propertiesDialog(doc: PDFDocumentProxy, o: { name: string; path: string | null; size: number }) {
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const page = await doc.getPage(1);
  const [x0, y0, x1, y1] = page.view;
  const inches = (pt: number) => (pt / 72).toFixed(2);
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  const size = o.size >= 1024 * 1024 ? `${(o.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(o.size / 1024))} KB`;
  const rows: [string, string][] = [
    ["File", o.path ?? `${o.name} (not saved yet)`],
    ["Title", String(info.Title ?? "")],
    ["Author", String(info.Author ?? "")],
    ["Subject", String(info.Subject ?? "")],
    ["Keywords", String(info.Keywords ?? "")],
    ["Created", pdfDate(info.CreationDate)],
    ["Modified", pdfDate(info.ModDate)],
    ["Application", String(info.Creator ?? "")],
    ["PDF Producer", String(info.Producer ?? "")],
    ["PDF Version", String(info.PDFFormatVersion ?? "")],
    ["Pages", String(doc.numPages)],
    ["Page Size", `${inches(x1 - x0)} × ${inches(y1 - y0)} in (${mm(x1 - x0)} × ${mm(y1 - y0)} mm)`],
    ["File Size", size],
    ["Security", info.EncryptFilterName ? "Password protected" : "None"],
    ["Fillable Form", info.IsAcroFormPresent ? "Yes" : "No"],
  ];
  const dialog = openDialog({
    title: "Document Properties",
    icon: "info",
    tone: "work",
    class: "pf-props",
    body: [h("dl", { class: "pf-props-list" }, ...rows.filter(([, v]) => v).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]))],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn primary", type: "button", onclick: () => dialog.close() }, "Close")],
  });
}
