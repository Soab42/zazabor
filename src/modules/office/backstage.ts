import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import type { OfficeKind } from "./api";
import type { OfficeEditor } from "./editor";
import { renderHub, type HubHost } from "./hub";

/**
 * File: the backstage, as Word and Excel have it. A coloured list down the left (Home, New, Open,
 * then Info, Save, Save As, Print, Export and Close for the file) and the chosen page beside it,
 * over the file, which comes back with the arrow or Esc.
 */

export type BackstagePage = "home" | "new" | "open" | "info" | "save-as" | "print" | "export";

export interface BackstageHost {
  /** Templates, recent files and browsing, shared with Office's Home. */
  readonly hub: HubHost;
  /** Back to the file. */
  back(): void;
  close(ed: OfficeEditor): void;
  showInFiles(path: string): void;
  toast(text: string): void;
}

/** What a kind of file saves as (shown on Save As; the picker offers the same choices). */
const FORMATS: Record<OfficeKind, [IconName, string, string][]> = {
  doc: [["docFile", "Word Document", ".docx"], ["network", "Web Page", ".html"], ["note", "Markdown", ".md"], ["note", "Plain Text", ".txt"]],
  sheet: [["sheetFile", "Excel Workbook", ".xlsx"], ["table", "CSV (comma separated)", ".csv"], ["table", "Text (tab separated)", ".tsv"]],
  pdf: [["pdfFile", "PDF", ".pdf"]],
};
const KIND_NOUN: Record<OfficeKind, string> = { doc: "document", sheet: "workbook", pdf: "PDF" };

interface FsEntry {
  size: number;
  mtime: number;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function createBackstage(host: BackstageHost) {
  const nav = h("nav", { class: "of-bs-nav", "aria-label": "File" });
  const main = h("div", { class: "of-bs-main" });
  const el = h("div", { class: "of-bs", hidden: true }, nav, main);
  let ed: OfficeEditor | null = null;
  let page: BackstagePage = "home";

  const item = (id: BackstagePage | "save" | "close", glyph: IconName, label: string, run?: () => void) => {
    const b = h("button", { class: `of-bs-item${id === page ? " active" : ""}`, type: "button", onclick: run ?? (() => show(id as BackstagePage)) }, icon(glyph, 17), h("span", null, label));
    if (id === page) b.setAttribute("aria-current", "page");
    return b;
  };

  function drawNav(file: OfficeEditor) {
    const items: (HTMLElement | null)[] = [
      h("button", { class: "of-bs-back", type: "button", title: `Back to ${file.title()} (Esc)`, "aria-label": "Back", onclick: () => host.back() }, icon("back", 18)),
      item("home", "home", "Home"),
      item("new", "plus", "New"),
      item("open", "open", "Open"),
      h("div", { class: "of-bs-sep" }),
      item("info", "info", "Info"),
      item("save", "save", "Save", () => void save(file)),
      item("save-as", "saveAs", "Save As"),
      file.print ? item("print", "print", "Print") : null,
      item("export", "phExport", "Export"),
      h("span", { class: "spacer" }),
      item("close", "close", "Close", () => host.close(file)),
    ];
    nav.replaceChildren(...items.filter((n): n is HTMLElement => !!n));
  }

  /** Save: at once when the file has a place, else Save As's page (as Word does). */
  async function save(file: OfficeEditor) {
    if (!file.path()) return show("save-as");
    if (await file.save()) {
      host.toast(`Saved “${file.title()}”`);
      host.back();
    }
  }

  async function saveAs(file: OfficeEditor) {
    if (await file.save(true)) {
      host.toast(`Saved “${file.title()}”`);
      host.back();
    }
  }

  const heading = (text: string, sub?: string) => [h("h1", null, text), sub ? h("p", { class: "of-hub-sub" }, sub) : null];

  function infoPage(file: OfficeEditor): (Node | null)[] {
    const path = file.path();
    const facts = h("dl", { class: "of-bs-facts" });
    const fact = (label: string, value: string) => facts.append(h("dt", null, label), h("dd", null, value));
    fact("Type", FORMATS[file.kind][0][1]);
    for (const [label, value] of file.info?.() ?? []) fact(label, value);
    if (path) {
      void invoke<FsEntry>("fs_stat", { path }).then((entry) => {
        fact("Size", size(entry.size));
        fact("Last modified", new Date(entry.mtime * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
      }, () => undefined);
    }
    const where = path
      ? h("div", { class: "of-bs-card" },
        h("div", { class: "of-bs-card-title" }, icon("folder", 16), "Location"),
        h("p", { class: "of-bs-path" }, dirname(path)),
        h("div", { class: "of-bs-row" },
          h("button", { class: "btn small", type: "button", onclick: () => host.showInFiles(path) }, icon("folder", 14), "Open File Location"),
          h("button", { class: "btn small ghost", type: "button", onclick: () => void navigator.clipboard.writeText(path).then(() => host.toast("Path copied"), () => undefined) }, icon("copy", 14), "Copy Path")))
      : h("div", { class: "of-bs-card" },
        h("div", { class: "of-bs-card-title" }, icon("save", 16), "Not saved yet"),
        h("p", null, `This ${KIND_NOUN[file.kind]} isn't saved anywhere. AutoRecover keeps a copy every 20 seconds until you save it.`),
        h("div", { class: "of-bs-row" }, h("button", { class: "btn small primary", type: "button", onclick: () => show("save-as") }, icon("saveAs", 14), "Save As…")));
    const recover = h("div", { class: "of-bs-card" },
      h("div", { class: "of-bs-card-title" }, icon("clock", 16), "AutoRecover"),
      h("p", null, file.dirty()
        ? "There are unsaved changes. A copy is kept every 20 seconds; if Zazabor stops before you save, Home offers it back."
        : "Everything is saved."));
    return [
      ...heading("Info", file.title()),
      h("div", { class: "of-bs-columns" }, h("div", { class: "of-bs-stack" }, where, recover), h("div", { class: "of-bs-card" }, h("div", { class: "of-bs-card-title" }, icon("info", 16), "Properties"), facts)),
    ];
  }

  function saveAsPage(file: OfficeEditor): (Node | null)[] {
    const path = file.path();
    return [
      ...heading("Save As", path ? `Now in ${dirname(path)}` : `Choose where this ${KIND_NOUN[file.kind]} goes and what kind of file it is.`),
      h("div", { class: "of-bs-columns" },
        h("div", { class: "of-bs-stack" },
          h("button", { class: "of-bs-big", type: "button", onclick: () => void saveAs(file) }, icon("open", 26), h("span", null, h("strong", null, "Browse…"), h("small", null, "Pick a folder and a name"))),
          path ? h("button", { class: "of-bs-big", type: "button", onclick: () => void saveAs(file) }, icon("folder", 26), h("span", null, h("strong", null, basename(dirname(path)) || "/"), h("small", null, dirname(path)))) : null),
        h("div", { class: "of-bs-card" },
          h("div", { class: "of-bs-card-title" }, icon("file", 16), "Formats"),
          h("div", { class: "of-bs-formats" }, ...FORMATS[file.kind].map(([glyph, name, ext]) =>
            h("button", { class: "of-bs-format", type: "button", title: `Save as ${name}`, onclick: () => void saveAs(file) }, icon(glyph, 16), h("span", null, name), h("small", null, ext)))),
          h("p", { class: "of-bs-note" }, "Choose the format in the save window's type list."))),
    ];
  }

  function printPage(file: OfficeEditor): (Node | null)[] {
    const preview = h("div", { class: "of-bs-preview" });
    const paper = file.printPreview?.() ?? null;
    if (paper) preview.append(paper);
    else preview.append(h("p", { class: "of-bs-note" }, file.printPreview ? "There's nothing to print yet." : "No preview for this file. Print shows it in the print window."));
    return [
      ...heading("Print"),
      h("div", { class: "of-bs-print" },
        h("div", { class: "of-bs-stack" },
          h("button", { class: "of-bs-big primary", type: "button", onclick: () => (host.back(), file.print!()) }, icon("print", 26), h("span", null, h("strong", null, "Print"), h("small", null, "Ctrl+P"))),
          h("div", { class: "of-bs-card" },
            h("div", { class: "of-bs-card-title" }, icon("settings", 16), "Settings"),
            h("p", null, "The print window chooses the printer, copies, pages and paper. Print to File there saves a PDF."))),
        preview),
    ];
  }

  function exportPage(file: OfficeEditor): (Node | null)[] {
    const card = (glyph: IconName, title: string, text: string, run: () => void) =>
      h("button", { class: "of-bs-big", type: "button", onclick: run }, icon(glyph, 26), h("span", null, h("strong", null, title), h("small", null, text)));
    return [
      ...heading("Export"),
      h("div", { class: "of-bs-stack narrow" },
        file.kind !== "pdf" && file.print
          ? card("pdfFile", "Create PDF Document", "Print to File in the print window keeps the layout, fonts and pictures", () => (host.back(), file.print!()))
          : null,
        card("saveAs", file.kind === "pdf" ? "Save a Copy" : "Change File Type", file.kind === "pdf" ? "Another name or folder" : FORMATS[file.kind].map(([, name]) => name).join(", "), () => show("save-as"))),
    ];
  }

  function draw() {
    if (!ed) return;
    drawNav(ed);
    const body: (Node | null)[] = page === "info" ? infoPage(ed)
      : page === "save-as" ? saveAsPage(ed)
      : page === "print" ? printPage(ed)
      : page === "export" ? exportPage(ed)
      : renderHub(page, host.hub);
    main.replaceChildren(...body.filter((n): n is Node => !!n));
    main.scrollTop = 0;
  }

  function show(next: BackstagePage) {
    page = next;
    draw();
  }

  return {
    el,
    /** Shows the backstage over `file`, on `start` (Home unless asked). */
    open(file: OfficeEditor, start: BackstagePage = "home") {
      ed = file;
      page = start;
      el.className = `of-bs tone-${file.kind}`;
      el.hidden = false;
      draw();
      (nav.querySelector(".of-bs-item.active") as HTMLElement | null)?.focus();
    },
    hide() {
      el.hidden = true;
      ed = null;
    },
    get isOpen() {
      return !el.hidden;
    },
    get file() {
      return ed;
    },
    /** Recent files, pins or titles changed: draw again. */
    refresh: () => draw(),
  };
}
