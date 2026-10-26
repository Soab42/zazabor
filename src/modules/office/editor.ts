import type { ShellContext } from "../../shell/module";
import type { OfficeKind } from "./api";

/**
 * The contract between the Office section and its two editors (Docs in `docs/`, Sheets in
 * `sheets/`). The section owns the inner rail, Home/New/Open and the list of open files; an
 * editor owns everything inside its own element: title bar, ribbon, canvas, status bar.
 */

/** Where Home, New and Open live (the backstage, as Office calls it). */
export type HubView = "home" | "new" | "open" | "doc" | "sheet" | "pdf";

/** A file to open (the editor reads it, it knows its formats). `null` means a new blank one. */
export interface OpenFile {
  path: string;
}

/** A template a blank file starts from (New → Letter, Budget…). */
export interface Template {
  id: string;
  kind: OfficeKind;
  name: string;
}

/** What the section offers an editor. */
export interface EditorHost {
  readonly shell: ShellContext;
  /** The title, path or unsaved state changed: the rail and the window title follow. */
  changed(): void;
  /** File tab: back to Home (or another hub view), the editor stays open in the rail. */
  showHub(view?: HubView): void;
  /** Remembers a path in Recent (after opening, saving or Save As). */
  remember(path: string): void;
  /** A brief message at the bottom of the window. */
  toast(text: string): void;
  /** Closes this editor; it has already asked about unsaved changes (see `confirmClose`). */
  close(): void;
}

export interface OfficeEditor {
  readonly kind: OfficeKind;
  readonly el: HTMLElement;
  /** The file name shown in the rail and the title bar ("Document 1" until saved). */
  title(): string;
  /** null until it's saved somewhere. */
  path(): string | null;
  /** Changed since it was opened or last saved. */
  dirty(): boolean;
  /** Saves (asks where the first time, or always with `as`); false when cancelled or it failed. */
  save(as?: boolean): Promise<boolean>;
  /** Prints through the system's print dialog (which can also save a PDF). */
  print?(): void;
  /**
   * AutoRecover: the file as it is now, to keep in case CorePro doesn't close cleanly, and a
   * number that changes with every edit (no new snapshot while it stays the same).
   */
  snapshot?(): { bytes: Uint8Array; version: number };
  /** Shown again: take the keyboard, resume timers. */
  activate(): void;
  /** Hidden behind Home or another file. */
  deactivate(): void;
  /**
   * Keys typed outside any field while it shows; true when handled. Keys typed into the editor's
   * own text (a contenteditable page, a cell editor) never get here: the editor catches them on
   * its element and stops them there, so shortcuts the shell uses for other things (Ctrl+N new
   * window, Ctrl+L lock, Ctrl+1…9) work as in Word and Excel while it has the keyboard.
   */
  handleKey(e: KeyboardEvent): boolean;
  dispose(): void;
}

/** A snapshot AutoRecover kept, to open instead of the file (`snapshot()`'s bytes). */
export interface RecoveredFile {
  bytes: Uint8Array;
  name: string;
  /** Where it was saved last; null for a file never saved. */
  path: string | null;
}

/**
 * Builds an editor for a file, or a blank one (from a template id, when given), or from an
 * AutoRecover snapshot. Rejects with a message when the file can't be read; the section shows it.
 */
export type EditorFactory = (host: EditorHost, file: OpenFile | null, template?: string, recovered?: RecoveredFile) => Promise<OfficeEditor>;

/** The templates New offers; each editor's factory knows how to build its own. */
export const TEMPLATES: Template[] = [
  { id: "blank", kind: "doc", name: "Blank document" },
  { id: "letter", kind: "doc", name: "Letter" },
  { id: "report", kind: "doc", name: "Report" },
  { id: "resume", kind: "doc", name: "Resume" },
  { id: "meeting-notes", kind: "doc", name: "Meeting notes" },
  { id: "blank", kind: "sheet", name: "Blank workbook" },
  { id: "budget", kind: "sheet", name: "Monthly budget" },
  { id: "invoice", kind: "sheet", name: "Invoice" },
  { id: "todo", kind: "sheet", name: "To-do list" },
  { id: "timesheet", kind: "sheet", name: "Timesheet" },
  // PDF has no blank page: New asks for the files to combine, or the pictures to turn into a PDF.
  { id: "combine", kind: "pdf", name: "Combine files" },
  { id: "images", kind: "pdf", name: "Pictures to PDF" },
];
