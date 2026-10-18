import type { FilesSettings } from "../../../config";
import type { ThumbLoader } from "../../../shared/thumbs";
import type { FsEntry } from "../api";
import type { Sel } from "../selection";

/** What the browser offers each view; views never talk to the backend or the shell directly. */
export interface ViewContext {
  readonly settings: FilesSettings;
  readonly thumbs: ThumbLoader;
  /** The active tab's selection; read it afresh, it is replaced when the tab changes. */
  readonly sel: Sel;
  /** The folder the active tab shows. */
  readonly path: string;
  /** Call after changing `sel`; updates the status bar. */
  selectionChanged(): void;
  /** Opens an entry; `folder` is the list it was in (for browsing images and videos). */
  open(entry: FsEntry, folder?: FsEntry[]): void;
  /** Shows the context menu for an entry, or for empty space when `entry` is null. */
  contextMenu(e: MouseEvent, entry: FsEntry | null): void;
  /** A folder's entries, sorted and honouring the hidden-files setting (for the column view). */
  listFolder(path: string): Promise<FsEntry[]>;
  watch(path: string): void;
  unwatch(path: string): void;
  /** The list header was clicked. */
  sortBy(key: FilesSettings["sort"]["key"]): void;
  /** The view's counts changed without the selection changing. */
  statusChanged(): void;
}

/** One way of showing a folder. All views are virtualized. */
export interface FileView {
  readonly el: HTMLElement;
  /** Shows a new listing (already sorted and filtered). `keep` marks a live refresh of the same folder. */
  setEntries(entries: FsEntry[], keep: boolean): void;
  /** The selection was changed from outside; repaint it. */
  renderSelection(): void;
  getScroll(): number;
  setScroll(value: number): void;
  /** Scrolls an entry into view. */
  reveal(path: string): void;
  handleKey(e: KeyboardEvent): boolean;
  selectAll(): void;
  /** The entry under the keyboard cursor, with the list it is in. */
  focused(): { entry: FsEntry; folder: FsEntry[] } | null;
  status(): { items: number; selected: number };
  /** Icon view only: the size slider moved. */
  iconSizeChanged?(): void;
  /** Column view only: a folder other than the root changed on disk. */
  folderChanged?(path: string): void;
  dispose(): void;
}
