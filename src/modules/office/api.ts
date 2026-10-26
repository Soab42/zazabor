import { invoke } from "@tauri-apps/api/core";
import { desktopDir, documentDir, downloadDir } from "@tauri-apps/api/path";
import { open, save } from "../../shared/dialog";
import { basename } from "../../ui/dom";

/** Docs (a word processor), Sheets (a spreadsheet) or PDF (Acrobat-like). */
export type OfficeKind = "doc" | "sheet" | "pdf";

/** Extensions each editor opens. Docs: Word and plain text; Sheets: Excel and delimited text. */
export const DOC_EXTENSIONS = ["docx", "txt", "md", "html", "htm"];
export const SHEET_EXTENSIONS = ["xlsx", "xlsm", "csv", "tsv"];
export const PDF_EXTENSIONS = ["pdf"];

/** The open dialog's type filter for each app, and its title. */
const KIND_FILTER: Record<OfficeKind, { name: string; extensions: string[]; title: string }> = {
  doc: { name: "Documents", extensions: DOC_EXTENSIONS, title: "Open Document" },
  sheet: { name: "Spreadsheets", extensions: SHEET_EXTENSIONS, title: "Open Workbook" },
  pdf: { name: "PDF files", extensions: PDF_EXTENSIONS, title: "Open PDF" },
};

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Which editor opens a file; null for files Office doesn't open. */
export function kindOf(path: string): OfficeKind | null {
  const ext = extensionOf(path);
  if (DOC_EXTENSIONS.includes(ext)) return "doc";
  if (SHEET_EXTENSIONS.includes(ext)) return "sheet";
  if (PDF_EXTENSIONS.includes(ext)) return "pdf";
  return null;
}

/** "Report" for "/home/me/Report.docx". */
export function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

function bytesOf(result: unknown): Uint8Array {
  return result instanceof ArrayBuffer ? new Uint8Array(result) : result instanceof Uint8Array ? result : new Uint8Array(result as number[]);
}

/** A write's body is the bytes; the path rides in a header (percent-encoded: headers are ASCII). */
function writeOptions(path: string) {
  return { headers: { "x-path": encodeURIComponent(path).replace(/%2F/g, "/") } };
}

export const officeApi = {
  /** A file's bytes. */
  read: async (path: string) => bytesOf(await invoke("office_read", { path })),
  /** Saves bytes over `path` (safely: a temporary file renamed over it). Returns the new mtime. */
  write: (path: string, bytes: Uint8Array) => invoke<number>("office_write", bytes, writeOptions(path)),
  /** An .xlsx as IronCalc's bytes, for `Model.fromBytes`. */
  openWorkbook: async (path: string, locale: string, timezone: string) => bytesOf(await invoke("sheet_open", { path, locale, timezone })),
  /** IronCalc's bytes (`model.toBytes()`) saved as an .xlsx. */
  saveWorkbook: (path: string, bytes: Uint8Array) => invoke<number>("sheet_save", bytes, writeOptions(path)),
  recovery: {
    save: (meta: Omit<Recovered, "saved">, bytes: Uint8Array) =>
      invoke<void>("office_recovery_save", bytes, { headers: { "x-meta": encodeURIComponent(JSON.stringify(meta)) } }),
    list: () => invoke<Recovered[]>("office_recovery_list"),
    read: async (id: string) => bytesOf(await invoke("office_recovery_read", { id })),
    remove: (id: string) => invoke<void>("office_recovery_delete", { id }),
  },
};

/** An AutoRecover snapshot of a file that wasn't saved when CorePro last closed. */
export interface Recovered {
  id: string;
  kind: OfficeKind;
  /** The file it came from; null for a new one. */
  path: string | null;
  name: string;
  saved: number;
}

/** Links in documents may only open these: a file's link must never start a program. */
const LINK_SCHEMES = ["http:", "https:", "mailto:"];

/**
 * A link from a document as a web address safe to hand to the desktop, or null (file:, smb:,
 * javascript:, custom app schemes…). A bare "example.com" becomes https.
 */
export function safeLink(target: string): string | null {
  const text = target.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return LINK_SCHEMES.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Asks which files to open (Word, Excel and PDF files, text), starting in `folder` when given. */
export async function pickFiles(kind?: OfficeKind, folder?: "documents" | "desktop" | "downloads"): Promise<string[]> {
  const defaultPath = folder ? await (folder === "documents" ? documentDir() : folder === "desktop" ? desktopDir() : downloadDir()).catch(() => undefined) : undefined;
  const filters = (kind ? [KIND_FILTER[kind]] : Object.values(KIND_FILTER)).map(({ name, extensions }) => ({ name, extensions }));
  const all = { name: "Documents, spreadsheets and PDFs", extensions: [...DOC_EXTENSIONS, ...SHEET_EXTENSIONS, ...PDF_EXTENSIONS] };
  const picked = await open({ title: kind ? KIND_FILTER[kind].title : "Open", multiple: true, directory: false, defaultPath, filters: kind ? filters : [all, ...filters] });
  return picked ?? [];
}

/**
 * An editor factory rejects with this when the user cancelled what it asked first (PDF's
 * Combine Files picks the files): the section then shows nothing.
 */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

/** Asks where to save; `formats` are the extensions offered, the first is the default. */
export async function pickSavePath(suggested: string, formats: { name: string; extension: string }[]): Promise<string | null> {
  const path = await save({ title: "Save As", defaultPath: suggested, filters: formats.map((f) => ({ name: f.name, extensions: [f.extension] })) });
  if (!path) return null;
  // GTK's dialog doesn't add the extension of the chosen filter.
  return extensionOf(path) ? path : `${path}.${formats[0].extension}`;
}
