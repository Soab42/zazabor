import type { ShellContext } from "../../shell/module";
import type { Phone } from "./api";

export type Tab = "messages" | "calls" | "photos" | "files" | "notifications";

/** What the section gives each of its tabs. */
export interface PhoneCtx {
  readonly shell: ShellContext;
  /** The phone shown, or null. */
  phone(): Phone | null;
  /** Shows another tab (Calls' "Message" button opens Messages). */
  showTab(tab: Tab): void;
  /** Opens Messages on a conversation with `number`. */
  messageTo(number: string): void;
  /** Where files from the phone go ("" = the backend's default). */
  downloadDir(): string;
  /** Shows the transfers tray. */
  showTransfers(): void;
}

/** One tab of the section. */
export interface PhoneView {
  readonly el: HTMLElement;
  /** The tab shows, or the phone (or its connection) changed while it shows. */
  show(phoneChanged: boolean): void;
  hide?(): void;
  handleKey?(e: KeyboardEvent): boolean;
}
