/**
 * File dialogs for every module: Open, Choose Folder and Save As. Same options and results as
 * `@tauri-apps/plugin-dialog`, so a call site only changes its import. The dialogs are Zazabor's
 * own (`filepicker/`, loaded on first use), in the Files look, never the desktop's.
 */

export interface DialogFilter {
  /** Shown in the type menu ("Images"). */
  name: string;
  /** Without the dot ("png"); "*" matches every file. */
  extensions: string[];
}

export interface OpenOptions {
  /** The sheet's title ("Choose Music"). Also keys the folder it remembers. */
  title?: string;
  filters?: DialogFilter[];
  /** The folder to start in, or a file in it. */
  defaultPath?: string;
  multiple?: boolean;
  /** Pick a folder instead of files. */
  directory?: boolean;
}

export interface SaveOptions {
  title?: string;
  filters?: DialogFilter[];
  /** The suggested file ("~/Documents/Report.docx", or just "Report.docx"). */
  defaultPath?: string;
}

/** What `open` resolves with: several paths with `multiple`, else one; null when cancelled. */
export type OpenResult<T extends OpenOptions> = T["multiple"] extends true ? string[] | null : string | null;

const picker = () => import("./filepicker");

export async function open<T extends OpenOptions>(options?: T): Promise<OpenResult<T>> {
  const o: OpenOptions = options ?? {};
  const { runPicker } = await picker();
  const paths = await runPicker({ mode: o.directory ? "folder" : "open", title: o.title, filters: o.filters, defaultPath: o.defaultPath, multiple: o.multiple });
  return (paths === null ? null : o.multiple ? paths : paths[0] ?? null) as OpenResult<T>;
}

export async function save(options?: SaveOptions): Promise<string | null> {
  const o = options ?? {};
  const { runPicker } = await picker();
  const paths = await runPicker({ mode: "save", title: o.title, filters: o.filters, defaultPath: o.defaultPath });
  return paths?.[0] ?? null;
}
