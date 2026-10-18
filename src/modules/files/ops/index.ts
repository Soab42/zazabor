import type { BrowserExtension } from "../browser";
import { FileOps } from "./controller";
import "./ops.css";

/**
 * File operations for the Files browser: copy, cut, paste, trash, rename, new folder, duplicate,
 * undo/redo, the jobs panel and the conflict sheet. `host` is the Files module's root element.
 */
export function createFileOps(host: HTMLElement): BrowserExtension {
  return new FileOps(host);
}
