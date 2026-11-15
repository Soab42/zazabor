import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** How to reach one of an account's servers; mirrors `Server` in `src-tauri/src/mail/db.rs`. */
export interface Server {
  host: string;
  port: number;
  security: "ssl" | "starttls" | "none";
}

export type Role = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "";

export interface Folder {
  id: number;
  accountId: string;
  path: string;
  name: string;
  role: Role;
  delim: string;
  selectable: boolean;
  /** Messages on the server. */
  total: number;
  unread: number;
  /** When it last synced (seconds), 0 for never. */
  synced: number;
  /** Messages of it held here. */
  loaded: number;
}

export interface Account {
  id: string;
  email: string;
  /** The name mail goes out under. */
  name: string;
  color: string;
  username: string;
  imap: Server;
  smtp: Server;
  /** HTML put under a new message. */
  signature: string;
  /** How it signs in: with a password, or through the provider's own sign-in. */
  auth: "password" | SignInProvider;
  synced: number;
  error: string | null;
  syncing: boolean;
  folders: Folder[];
}

export interface Overview {
  accounts: Account[];
  drafts: number;
  colors: string[];
}

export interface Address {
  name: string;
  addr: string;
}

/** One row of the list: a conversation; mirrors `Thread` in `db.rs`. */
export interface Thread {
  id: number;
  accountId: string;
  folderId: number;
  folderRole: Role;
  threadId: string;
  subject: string;
  from: Address;
  to: Address[];
  snippet: string;
  /** Seconds since the epoch. */
  date: number;
  count: number;
  unread: number;
  flagged: boolean;
  attachments: boolean;
  names: string[];
  /** Its messages' rows in this view. */
  ids: number[];
}

export interface Message {
  id: number;
  accountId: string;
  folderId: number;
  folderRole: Role;
  uid: number;
  messageId: string;
  threadId: string;
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: string;
  date: number;
  size: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  attachments: boolean;
  snippet: string;
  body: boolean;
}

export interface Attachment {
  index: number;
  name: string;
  mime: string;
  size: number;
}

export interface Body {
  /** Cleaned HTML, when the message has an HTML part. */
  html: string | null;
  text: string;
  attachments: Attachment[];
  blockedImages: boolean;
  unsubscribe: string | null;
}

/** What the list shows; mirrors `Query` in `db.rs`. */
export interface Query {
  folder?: number;
  role?: string;
  account?: string;
  starred?: boolean;
  unread?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

/** The servers worked out from an address; mirrors `Setup` in `providers.rs`. */
export interface Setup {
  provider: string;
  imap: Server;
  smtp: Server;
  username: string;
  note: string;
  helpUrl: string;
  /** The provider has a sign-in of its own that Zazabor can use. */
  signIn: SignInProvider | "";
  guessed: boolean;
}

export type SignInProvider = "google" | "microsoft";

/** Which providers can be signed in with (a client ID is known); mirrors `OAuthState` in `mail/mod.rs`. */
export interface OAuthState {
  google: boolean;
  microsoft: boolean;
  googleId: string;
  googleSecret: boolean;
  microsoftId: string;
}

export interface AccountInput {
  id?: string;
  email: string;
  name: string;
  color?: string;
  username: string;
  imap: Server;
  smtp: Server;
  signature?: string;
  /** Empty keeps the saved one. */
  password: string;
}

export interface Undo {
  account: string;
  from: number;
  to: number;
  messageIds: string[];
}

export interface Moved {
  count: number;
  deleted: boolean;
  undo: Undo[];
}

/** A file to send: one on disk, or one a message here carries (forwarding). */
export type Attach = { kind: "file"; path: string; name: string } | { kind: "part"; message: number; index: number; name: string };

/** The compose sheet's state: what's sent, and what a draft keeps. */
export interface Draft {
  id: string;
  accountId: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  attachments: Attach[];
  /** The message this answers. */
  replyTo: number | null;
}

export interface SavedDraft {
  id: string;
  accountId: string;
  json: string;
  /** Seconds since the epoch. */
  updated: number;
}

export const mailApi = {
  start: () => invoke<void>("mail_start"),
  overview: () => invoke<Overview>("mail_overview"),
  unread: () => invoke<number>("mail_unread"),
  sync: (account?: string) => invoke<void>("mail_sync", { account }),
  discover: (email: string) => invoke<Setup>("mail_discover", { email }),
  saveAccount: (input: AccountInput) => invoke<Account>("mail_account_save", { input }),
  removeAccount: (id: string) => invoke<void>("mail_account_remove", { id }),
  oauthState: () => invoke<OAuthState>("mail_oauth_state"),
  oauthClient: (provider: SignInProvider, id: string, secret: string) => invoke<OAuthState>("mail_oauth_client", { provider, id, secret }),
  /** Opens the provider's sign-in in the browser and waits for it; `account` signs that one in again. */
  oauthSignIn: (provider: SignInProvider, name: string, account?: string) => invoke<{ account: Account; warning: string | null }>("mail_oauth_signin", { provider, account, name }),
  oauthCancel: () => invoke<void>("mail_oauth_cancel"),
  threads: (query: Query) => invoke<Thread[]>("mail_threads", { query }),
  thread: (account: string, thread: string, folder?: number) => invoke<Message[]>("mail_thread", { account, thread, folder }),
  body: (id: number, images: boolean) => invoke<Body>("mail_body", { id, images }),
  /** Writes an attachment to `path` (or, without one, to the cache to be opened); resolves with where it is. */
  attachment: (id: number, index: number, path?: string) => invoke<string>("mail_attachment", { id, index, path }),
  contacts: (prefix: string) => invoke<Address[]>("mail_contacts", { prefix }),
  older: (folder: number) => invoke<void>("mail_older", { folder }),
  flag: (ids: number[], flag: "seen" | "flagged", on: boolean) => invoke<void>("mail_flag", { ids, flag, on }),
  /** `to`: "archive", "trash", "junk", "inbox", or a folder's id. */
  move: (ids: number[], to: string) => invoke<Moved>("mail_move", { ids, to }),
  moveUndo: (undo: Undo[]) => invoke<void>("mail_move_undo", { undo }),
  readAll: (folder: number) => invoke<void>("mail_read_all", { folder }),
  send: (draft: Draft, text: string) =>
    invoke<void>("mail_send", {
      out: {
        accountId: draft.accountId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, html: draft.html, text,
        attachments: draft.attachments.map((a) => (a.kind === "file" ? { kind: "file", path: a.path } : { kind: "part", message: a.message, index: a.index })),
        replyTo: draft.replyTo, draftId: draft.id,
      },
    }),
  drafts: () => invoke<SavedDraft[]>("mail_drafts"),
  saveDraft: (draft: Draft) => invoke<void>("mail_draft_save", { id: draft.id, account: draft.accountId, json: JSON.stringify(draft) }),
  deleteDraft: (id: string) => invoke<void>("mail_draft_delete", { id }),
};

export const onMailChanged = (handler: (account: string) => void): Promise<UnlistenFn> => listen<string>("mail-changed", (e) => handler(e.payload));
export const onMailError = (handler: (message: string) => void): Promise<UnlistenFn> => listen<{ accountId: string; message: string }>("mail-error", (e) => handler(e.payload.message));
export const onMailNew = (handler: (mail: { accountId: string; count: number; from: string; subject: string }) => void): Promise<UnlistenFn> =>
  listen<{ accountId: string; count: number; from: string; subject: string }>("mail-new", (e) => handler(e.payload));

// ---- shared helpers

export const displayName = (a: Address) => a.name || a.addr;

/** "AS" for Ann Smith, "A" for ann@example.com. */
export function initials(a: Address): string {
  const words = (a.name || a.addr.split("@")[0] || "?").replace(/[^\p{L}\p{N}\s.-]/gu, "").split(/[\s.-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${[...words[0]][0]}${[...words[words.length - 1]][0]}` : [...(words[0] ?? "?")][0] ?? "?";
  return letters.toUpperCase();
}

/** A steady hue for a sender, so the same person always has the same avatar. */
export function hueOf(a: Address): number {
  let hash = 0;
  for (const ch of a.addr.toLowerCase() || a.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** "14:05" today, "Tue" this week, "12 Mar" this year, else "12 Mar 2023". */
export function shortDate(seconds: number, now = Date.now()): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const today = new Date(now);
  const days = Math.floor((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, d.getFullYear() === today.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export function longDate(seconds: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Ann <ann@example.com>, bob@example.com" → addresses; what can't be one is returned as `bad`. */
export function parseAddresses(text: string): { good: Address[]; bad: string[] } {
  const good: Address[] = [];
  const bad: string[] = [];
  for (const piece of text.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const angled = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(piece);
    if (angled) good.push({ name: angled[1].trim().replace(/^"(.*)"$/, "$1"), addr: angled[2] });
    else if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(piece)) good.push({ name: "", addr: piece });
    else bad.push(piece);
  }
  return { good, bad };
}

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text as HTML: escaped, lines kept, web and mail addresses made links. */
export function textToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\r?\n/g, "<br>");
}

const NEVER = "script, link, meta, base, title, iframe, frame, frameset, object, embed, applet, form, input, button, textarea, select, option, svg, math, audio, video, source, track, template, slot, dialog";

/**
 * HTML parsed into a document of its own (nothing in it loads or runs) and made inert: nothing
 * that can run, load or submit, no event handlers, and no link that can take the window anywhere.
 * A link keeps its address in `data-href`, for the code that shows it to act on. The backend
 * already cleans messages; this is the second lock, and the app's content policy the third.
 */
export function inertDocument(html: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(NEVER).forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction" || name === "target" || name === "ping" || name === "download" || name === "is" || name === "part" || name === "slot") el.removeAttribute(attr.name);
      else if (name === "href" || name === "xlink:href") {
        el.removeAttribute(attr.name);
        if (/^(https?:|mailto:)/i.test(value)) {
          el.setAttribute("data-href", value);
          el.setAttribute("title", value.replace(/^mailto:/i, ""));
          el.setAttribute("tabindex", "0");
          el.setAttribute("role", "link");
        }
      } else if ((name === "src" || name === "action" || name === "poster") && !/^data:image\//i.test(value)) el.removeAttribute(attr.name);
    }
  });
  return doc;
}

/** `inertDocument`, without style sheets, as HTML: for what goes into the editor or the page itself. */
export function safeHtml(html: string): string {
  const doc = inertDocument(html);
  doc.querySelectorAll("style").forEach((el) => el.remove());
  // In the editor a link is a link again (it is only ever shown, sent, or cleaned once more).
  doc.querySelectorAll("[data-href]").forEach((el) => {
    el.setAttribute("href", el.getAttribute("data-href")!);
    for (const name of ["data-href", "title", "tabindex", "role"]) el.removeAttribute(name);
  });
  return doc.body.innerHTML;
}
