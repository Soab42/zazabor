import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import { ago } from "../../notes/api";
import { fsApi } from "../files/api";
import { kindOf, stem, type OfficeKind } from "./api";
import { TEMPLATES, type HubView, type Template } from "./editor";

/** What the hub asks of the section. */
export interface HubHost {
  recent(): string[];
  pinned(): string[];
  newFile(kind: OfficeKind, template: string): void;
  open(path: string): void;
  browse(kind?: OfficeKind, folder?: "documents" | "desktop" | "downloads"): void;
  togglePin(path: string): void;
  forget(path: string): void;
  showInFiles(path: string): void;
  openInWindow(path: string): void;
}

const KIND_ICON: Record<OfficeKind, IconName> = { doc: "docFile", sheet: "sheetFile", pdf: "pdfFile" };
const KIND_NAME: Record<OfficeKind, string> = { doc: "Document", sheet: "Workbook", pdf: "PDF" };

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** A template's first page in miniature. */
function thumb(t: Template): HTMLElement {
  if (t.kind === "pdf") {
    // Two pages being joined, or a picture becoming a page.
    return h("div", { class: `of-thumb pdf ${t.id}` }, h("span", { class: "h" }), h("span"), h("span", { class: "short" }), h("span"), h("span"));
  }
  if (t.kind === "sheet") {
    return h("div", { class: "of-thumb grid" }, ...Array.from({ length: 28 }, (_, i) => h("span", { class: t.id !== "blank" && i < 4 ? "h" : "" })));
  }
  if (t.id === "blank") return h("div", { class: "of-thumb" });
  const lines = t.id === "letter" ? ["short", "", "", "", "", "short", "", ""] : t.id === "resume" ? ["h", "short", "", "", "h", "", "", "short"] : ["h", "", "", "short", "h", "", "", ""];
  return h("div", { class: "of-thumb" }, ...lines.map((c) => h("span", { class: c })));
}

function tile(t: Template, host: HubHost): HTMLElement {
  return h("button", { class: `of-tile tone-${t.kind}`, type: "button", onclick: () => host.newFile(t.kind, t.id) },
    h("div", { class: "of-tile-page" }, thumb(t), h("span", { class: "of-tile-badge" }, icon(KIND_ICON[t.kind], 15))),
    h("span", { class: "of-tile-name" }, t.name),
    h("span", { class: "of-tile-kind" }, KIND_NAME[t.kind]));
}

/** Recent files as rows: name, folder, when it was changed, a pin. */
function recentList(paths: string[], host: HubHost, empty: string): HTMLElement {
  const pinned = new Set(host.pinned());
  if (!paths.length) return h("div", { class: "of-recent" }, h("div", { class: "of-empty-line" }, empty));
  const rows = paths.map((path) => {
    const kind = kindOf(path) ?? "doc";
    const when = h("span", { class: "of-recent-when" }, "");
    void fsApi.stat(path).then((e) => (when.textContent = ago(e.mtime * 1000)), () => ((when.textContent = "Not found"), row.classList.add("missing")));
    const pin = h("button", {
      class: `icon-btn small${pinned.has(path) ? " on" : ""}`, type: "button", title: pinned.has(path) ? "Unpin" : "Pin to the list", "aria-label": "Pin",
      onclick: (e: Event) => (e.stopPropagation(), host.togglePin(path)),
    }, icon("pin", 14));
    const row = h("div", { class: `of-recent-row tone-${kind}`, role: "button", tabindex: "0", title: path, onclick: () => host.open(path) },
      h("span", { class: "of-kind" }, icon(KIND_ICON[kind], 15)),
      h("span", { class: "of-recent-name" }, stem(path)),
      h("span", { class: "of-recent-path" }, path.replace(/\/[^/]*$/, "").replace(/^\/home\/[^/]+/, "~")),
      when, pin);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") host.open(path);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: "Open", icon: "open", action: () => host.open(path) },
        { label: "Open in New Window", icon: "external", action: () => host.openInWindow(path) },
        { label: "Show in Files", icon: "folder", action: () => host.showInFiles(path) },
        "separator",
        { label: pinned.has(path) ? "Unpin" : "Pin to the List", icon: "pin", action: () => host.togglePin(path) },
        { label: "Remove from the List", icon: "close", action: () => host.forget(path) },
      ]);
    });
    return row;
  });
  return h("div", { class: "of-recent" },
    h("div", { class: "of-recent-row of-recent-head" }, h("span"), h("span", null, "Name"), h("span", null, "Location"), h("span", null, "Modified"), h("span")),
    ...rows);
}

/**
 * The backstage: Home (new files and recent ones), New (every template), Open (recent, pinned,
 * browse, and the usual folders), and a page each for Docs and Sheets.
 */
export function renderHub(view: HubView, host: HubHost, query = ""): HTMLElement[] {
  const terms = query.trim().toLowerCase();
  const filter = (paths: string[], kind?: OfficeKind) => paths.filter((p) => (!kind || kindOf(p) === kind) && (!terms || p.toLowerCase().includes(terms)));
  const pinnedFirst = (paths: string[]) => [...host.pinned().filter((p) => paths.includes(p)), ...paths.filter((p) => !host.pinned().includes(p))];
  const tiles = (kind?: OfficeKind, limit = 99) => h("div", { class: "of-new" }, ...TEMPLATES.filter((t) => !kind || t.kind === kind).slice(0, limit).map((t) => tile(t, host)));

  if (view === "home") {
    const blanks = TEMPLATES.filter((t) => t.id === "blank");
    // Two of each kind after the blank ones.
    const some = (["doc", "sheet"] as const).flatMap((kind) => TEMPLATES.filter((t) => t.id !== "blank" && t.kind === kind).slice(0, 2));
    const pdf = TEMPLATES.filter((t) => t.kind === "pdf").slice(0, 1);
    return [
      h("h1", null, greeting()),
      h("p", { class: "of-hub-sub" }, "Write a document, work out the numbers or work on a PDF. Word, Excel and PDF files open and save as they are."),
      h("div", { class: "of-new" }, ...[...blanks, ...some, ...pdf].map((t) => tile(t, host))),
      h("div", { class: "of-hub-head" }, h("h2", null, "Recent"), h("span", { class: "spacer" }),
        h("button", { class: "btn small", type: "button", onclick: () => host.browse() }, icon("open", 14), "Open…")),
      recentList(pinnedFirst(filter([...new Set([...host.pinned(), ...host.recent()])])).slice(0, 20), host, "Files you open or save show up here."),
    ];
  }
  if (view === "new") return [h("h1", null, "New"), h("p", { class: "of-hub-sub" }, "Start from a blank page or a template."), h("h2", null, "Documents"), tiles("doc"), h("h2", null, "Workbooks"), tiles("sheet"), h("h2", null, "PDF"), tiles("pdf")];
  if (view === "open") {
    const places: [string, "documents" | "desktop" | "downloads"][] = [["Documents", "documents"], ["Desktop", "desktop"], ["Downloads", "downloads"]];
    return [
      h("h1", null, "Open"),
      h("p", { class: "of-hub-sub" }, "Word (.docx), Excel (.xlsx), PDF, CSV and text files."),
      h("div", { class: "of-places" },
        h("button", { class: "btn primary", type: "button", onclick: () => host.browse() }, icon("open", 15), "Browse…"),
        ...places.map(([name, folder]) => h("button", { class: "btn", type: "button", onclick: () => host.browse(undefined, folder) }, icon("folder", 15), name))),
      h("h2", null, "Pinned"),
      recentList(filter(host.pinned()), host, "Pin files to keep them here."),
      h("h2", null, "Recent"),
      recentList(filter(host.recent()), host, "Nothing opened yet."),
    ];
  }
  const kind: OfficeKind = view;
  const page: Record<OfficeKind, [string, string, string, string]> = {
    doc: ["Docs", "Letters, reports and notes; opens and saves Word documents.", "Recent documents", "Documents you open show up here."],
    sheet: ["Sheets", "Budgets, lists and calculations; opens and saves Excel workbooks.", "Recent workbooks", "Workbooks you open show up here."],
    pdf: ["PDF", "Read, comment, fill and sign, and put pages in order; combine files or turn pictures into a PDF.", "Recent PDFs", "PDFs you open show up here."],
  };
  const [title, sub, recentTitle, empty] = page[kind];
  return [
    h("h1", null, title),
    h("p", { class: "of-hub-sub" }, sub),
    tiles(kind),
    h("div", { class: "of-hub-head" }, h("h2", null, recentTitle), h("span", { class: "spacer" }),
      h("button", { class: "btn small", type: "button", onclick: () => host.browse(kind) }, icon("open", 14), "Open…")),
    recentList(pinnedFirst(filter([...new Set([...host.pinned(), ...host.recent()])], kind)), host, empty),
  ];
}
