/** What Quick Look needs to know about an item; the Files module's `FsEntry` fits as it is. */
export interface QuickLookItem {
  name: string;
  /** Absolute path. */
  path: string;
  /** A folder, or a symlink that points at one. */
  dir: boolean;
  link?: boolean;
  /** Bytes. */
  size: number;
  /** Modification time, seconds since the Unix epoch. */
  mtime: number;
  /** Lower-case extension without the dot, "" for none. */
  ext: string;
  /** The content type, when known (cloud drives). */
  mime?: string;
  /** A web address that opens the item (a Google Doc), instead of a file to read. */
  url?: string;
}
