import type { MailSettings } from "../../config";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { clamp, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import "../files/ops/ops.css";
import { confirmSheet } from "../files/ops/sheets";
import { showToast } from "../files/ops/toast";
import { accountSheet } from "./accounts";
import { displayName, mailApi, onMailChanged, onMailError, shortDate, type Account, type Draft, type Folder, type Overview, type Query, type Role, type SavedDraft, type Thread } from "./api";
import { blankDraft, openCompose, responseDraft, type ComposeHost } from "./compose";
import "./mail.css";
import { listen } from "@tauri-apps/api/event";
import { avatar, createReader, type ThreadAction } from "./reader";

/** What the list shows: every account's folder of a kind, the starred, the drafts, or one folder. */
type View = { kind: "unified"; role: "inbox" | "sent" } | { kind: "starred" } | { kind: "drafts" } | { kind: "folder"; id: number };

const PAGE = 60;
const ROLE_ORDER: Role[] = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
const ROLE_ICON: Record<string, IconName> = { inbox: "inbox", drafts: "pencil", sent: "send", archive: "archive", junk: "junk", trash: "trash", "": "folder" };

function parseView(text: string): View {
  const [kind, arg] = text.split(":");
  if (kind === "folder" && Number(arg) > 0) return { kind: "folder", id: Number(arg) };
  if (kind === "starred" || kind === "drafts") return { kind };
  return { kind: "unified", role: arg === "sent" ? "sent" : "inbox" };
}

const viewText = (v: View) => (v.kind === "folder" ? `folder:${v.id}` : v.kind === "unified" ? `unified:${v.role}` : v.kind);
const keyOf = (t: { accountId: string; threadId: string }) => `${t.accountId}|${t.threadId}`;

/**
 * Mail: every account in one place. A sidebar of unified views and each account's folders, the
 * list of conversations, and the reading pane. Everything works from the local copy the backend
 * keeps in sync, so opening, searching and moving mail never waits for a server.
 */
export const createMailModule: ModuleFactory = (shell) => {
  const settings = (): MailSettings => shell.config.mail;
  let overview: Overview | null = null;
  let failed: string | null = null;
  let view: View = parseView(settings().view);
  let threads: Thread[] = [];
  let drafts: SavedDraft[] = [];
  let limit = PAGE;
  /** The list may have more rows than are shown. */
  let more = false;
  let unreadOnly = false;
  let loadingList = true;
  /** The conversation open in the reading pane. */
  let current: string | null = null;
  /** Rows ticked for an action on several. */
  const selected = new Set<string>();
  let anchor: string | null = null;
  /** A conversation marked unread by hand stays unread while it's still open. */
  let keepUnread: string | null = null;
  let visible = false;
  let ticket = 0;
  let reloadTimer = 0;
  const unlisten: Promise<() => void>[] = [];
  let listening = false;

  // ---- sidebar
  const compose = h("button", { class: "btn primary ml-compose-btn", type: "button", title: "New message (C)" }, icon("pencil", 15), "New Message");
  compose.addEventListener("click", () => write());
  const nav = h("nav", { class: "ml-nav", "aria-label": "Mailboxes" });
  const addAccount = h("button", { class: "ml-side-add", type: "button" }, icon("plus", 14), "Add Account");
  addAccount.addEventListener("click", () => void editAccount(null));
  const side = h("aside", { class: "ml-side" }, compose, nav, h("div", { class: "spacer" }), addAccount);

  // ---- list
  const title = h("h1", { class: "ml-list-title" });
  const subtitle = h("span", { class: "ml-list-count" });
  const search = h("input", { class: "search-input", type: "search", placeholder: "Search all mail", "aria-label": "Search mail", spellcheck: "false" });
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      limit = PAGE;
      void reload();
    }, 180);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      limit = PAGE;
      void reload();
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      step(current ? 0 : 1);
      list.focus();
    }
  });
  const unreadToggle = h("button", { class: "icon-btn", type: "button", title: "Only unread", "aria-label": "Only unread", "aria-pressed": "false" }, icon("filter", 16));
  unreadToggle.addEventListener("click", () => {
    unreadOnly = !unreadOnly;
    unreadToggle.classList.toggle("active", unreadOnly);
    unreadToggle.setAttribute("aria-pressed", String(unreadOnly));
    limit = PAGE;
    void reload();
  });
  const syncButton = h("button", { class: "icon-btn", type: "button", title: "Check for mail (F5)", "aria-label": "Check for mail" }, icon("refresh", 16));
  syncButton.addEventListener("click", () => void sync());
  const moreButton = h("button", { class: "icon-btn", type: "button", title: "More", "aria-label": "More" }, icon("more", 16));
  moreButton.addEventListener("click", () => {
    const r = moreButton.getBoundingClientRect();
    const folder = view.kind === "folder" ? folderOf(view.id) : null;
    openMenu(r.right - 220, r.bottom + 4, [
      { label: "Mark All as Read", icon: "mailOpen", disabled: !folder, action: () => folder && void mailApi.readAll(folder.id).catch(report) },
      { label: "Select All", icon: "checkSquare", shortcut: "ctrl+a", disabled: threads.length === 0, action: selectAll },
      "separator",
      { label: "Always Show Pictures", icon: settings().images === "always" ? "check" : undefined, action: () => {
        settings().images = settings().images === "always" ? "ask" : "always";
        shell.saveConfig();
      } },
    ]);
  });
  // Folding: the sidebar of mailboxes away (New Message moves to the list's bar), and the list
  // away while a conversation is open, so it reads full width.
  const sideToggle = h("button", { class: "icon-btn ml-side-toggle", type: "button" }, icon("sidebar", 16));
  sideToggle.addEventListener("click", () => fold("side"));
  const composeMini = h("button", { class: "icon-btn ml-compose-mini", type: "button", title: "New message (C)", "aria-label": "New message" }, icon("pencil", 16));
  composeMini.addEventListener("click", () => write());
  const listToggle = h("button", { class: "icon-btn ml-list-toggle", type: "button" }, icon("columns", 17));
  listToggle.addEventListener("click", () => fold("list"));
  const listBar = h("header", { class: "ml-list-bar" },
    h("div", { class: "ml-list-head" }, sideToggle, h("div", { class: "ml-list-titles" }, title, subtitle), composeMini, unreadToggle, syncButton, moreButton),
    h("label", { class: "search ml-search" }, icon("search", 15), search));
  const bulkCount = h("span", { class: "ml-bulk-count" });
  const bulkButton = (glyph: IconName, label: string, action: ThreadAction) => {
    const el = h("button", { class: "icon-btn", type: "button", title: label, "aria-label": label }, icon(glyph, 16));
    el.addEventListener("click", () => void act(action, el));
    return el;
  };
  const bulkClear = h("button", { class: "icon-btn", type: "button", title: "Clear the selection (Esc)", "aria-label": "Clear the selection" }, icon("close", 15));
  bulkClear.addEventListener("click", () => {
    selected.clear();
    drawList();
  });
  const bulkBar = h("div", { class: "ml-bulk", hidden: true }, bulkClear, bulkCount, h("span", { class: "spacer" }),
    bulkButton("archive", "Archive", "archive"), bulkButton("trash", "Delete", "trash"), bulkButton("mail", "Mark read or unread", "unread"), bulkButton("star", "Star", "star"), bulkButton("folder", "Move to…", "move"));
  const list = h("div", { class: "ml-list", role: "listbox", tabindex: 0, "aria-label": "Conversations" });
  listBar.append(bulkBar);
  const listPane = h("section", { class: "ml-list-pane" }, listBar, list);
  list.addEventListener("scroll", () => {
    if (more && !loadingList && list.scrollTop + list.clientHeight > list.scrollHeight - 320) {
      limit += PAGE;
      void reload();
    }
  });

  // ---- reader
  const reader = createReader({
    accounts: () => overview?.accounts ?? [],
    alwaysImages: () => settings().images === "always",
    setAlwaysImages() {
      settings().images = "always";
      shell.saveConfig();
    },
    openUrl: (url) => shell.openExternally(url),
    openPath: (path) => shell.openExternally(path),
    respond: (mode, message, body) => openCompose(responseDraft(mode, message, body, overview?.accounts ?? []), composeHost),
    writeTo: (address) => write([{ name: "", addr: address }]),
    act: (action, anchorEl) => void act(action, anchorEl, true),
    starMessage: (message, on) => void mailApi.flag([message.id], "flagged", on).catch(report),
    toast: (message) => showToast(message, undefined, 2600),
    back: () => open(null),
  });

  // ---- the splitter between the list and the reading pane
  const splitter = h("div", { class: "ml-splitter", role: "separator", "aria-orientation": "vertical" });
  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const start = e.clientX;
    const from = listPane.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      settings().listWidth = clamp(Math.round(from + ev.clientX - start), 280, 620);
      el.style.setProperty("--ml-list-w", `${settings().listWidth}px`);
    };
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      shell.saveConfig();
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
    splitter.addEventListener("pointercancel", up, { once: true });
  });

  reader.el.querySelector(".ml-reader-bar")?.insertBefore(listToggle, reader.el.querySelector(".ml-back")?.nextSibling ?? null);

  const welcome = h("div", { class: "ml-welcome", hidden: true });
  const panes = h("div", { class: "ml-panes" }, side, listPane, splitter, reader.el);
  const el = h("section", { class: "mail-module" }, panes, welcome);
  el.style.setProperty("--ml-list-w", `${settings().listWidth}px`);
  new ResizeObserver(() => el.classList.toggle("narrow", el.clientWidth < 1040)).observe(el);

  /** Shows the panes folded or not, as the settings say. */
  function drawFolds() {
    const { sideFolded, listFolded } = settings();
    el.classList.toggle("side-folded", sideFolded);
    el.classList.toggle("list-folded", listFolded);
    const sideTitle = sideFolded ? "Show the mailboxes (Ctrl+B)" : "Hide the mailboxes (Ctrl+B)";
    sideToggle.title = sideTitle;
    sideToggle.setAttribute("aria-label", sideTitle);
    sideToggle.setAttribute("aria-pressed", String(sideFolded));
    const listTitle = listFolded ? "Show the list (Ctrl+Shift+B)" : "Hide the list while reading (Ctrl+Shift+B)";
    listToggle.title = listTitle;
    listToggle.setAttribute("aria-label", listTitle);
    listToggle.setAttribute("aria-pressed", String(listFolded));
    listToggle.classList.toggle("active", listFolded);
  }

  function fold(pane: "side" | "list") {
    if (pane === "side") settings().sideFolded = !settings().sideFolded;
    else settings().listFolded = !settings().listFolded;
    shell.saveConfig();
    drawFolds();
  }
  drawFolds();

  const report = (err: unknown) => showToast(String(err));

  const composeHost: ComposeHost = {
    get accounts() {
      return overview?.accounts ?? [];
    },
    toast: (message) => showToast(message, undefined, 2400),
    send(draft, text) {
      // Kept as a draft until it has really gone, and held a few seconds so it can be taken back.
      void mailApi.saveDraft(draft).catch(() => undefined);
      let undone = false;
      showToast("Sending…", { label: "Undo", run: () => {
        undone = true;
        openCompose(draft, composeHost);
      } }, 5000);
      window.setTimeout(() => {
        if (undone) return;
        mailApi.send(draft, text).then(
          () => showToast("Sent", undefined, 2200),
          (err) => showToast(`Not sent: ${err}`, { label: "Open", run: () => openCompose(draft, composeHost) }, 15000));
      }, 5000);
    },
  };

  function write(to: { name: string; addr: string }[] = []) {
    const accounts = overview?.accounts ?? [];
    if (!accounts.length) return void editAccount(null);
    // From the account being looked at, else the first.
    const folder = view.kind === "folder" ? folderOf(view.id) : null;
    const thread = current ? threads.find((t) => keyOf(t) === current) : null;
    const account = accounts.find((a) => a.id === (folder?.accountId ?? thread?.accountId)) ?? accounts[0];
    openCompose(blankDraft(account, to), composeHost);
  }

  async function editAccount(account: Account | null) {
    const changed = await accountSheet(account, overview?.colors ?? [], (url) => shell.openExternally(url), (message) => showToast(message, undefined, 7000));
    if (changed) void reload();
  }

  async function sync() {
    syncButton.classList.add("spinning");
    try {
      await mailApi.sync();
    } catch (err) {
      report(err);
    }
    window.setTimeout(() => syncButton.classList.toggle("spinning", !!overview?.accounts.some((a) => a.syncing)), 800);
  }

  // ---- data

  const allFolders = () => overview?.accounts.flatMap((a) => a.folders) ?? [];
  const folderOf = (id: number) => allFolders().find((f) => f.id === id) ?? null;
  const accountOf = (id: string) => overview?.accounts.find((a) => a.id === id) ?? null;

  function query(): Query {
    const text = search.value.trim();
    const q: Query = { limit: limit + 1, unread: unreadOnly };
    if (text) return { ...q, search: text };
    if (view.kind === "folder") return { ...q, folder: view.id };
    if (view.kind === "starred") return { ...q, starred: true };
    if (view.kind === "unified") return { ...q, role: view.role };
    return q;
  }

  async function reload() {
    const mine = ++ticket;
    try {
      const [nextOverview, nextThreads, nextDrafts] = await Promise.all([mailApi.overview(), view.kind === "drafts" && !search.value.trim() ? Promise.resolve([]) : mailApi.threads(query()), mailApi.drafts()]);
      if (mine !== ticket) return;
      overview = nextOverview;
      failed = null;
      // A folder that went away (or an account removed) falls back to the inboxes.
      if (view.kind === "folder" && !folderOf(view.id)) setView({ kind: "unified", role: "inbox" }, false);
      more = nextThreads.length > limit;
      threads = nextThreads.slice(0, limit);
      drafts = nextDrafts;
      loadingList = false;
      for (const key of [...selected]) if (!threads.some((t) => keyOf(t) === key)) selected.delete(key);
    } catch (err) {
      if (mine !== ticket) return;
      failed = String(err);
      loadingList = false;
    }
    draw();
    void refreshReader();
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => visible && void reload(), 220);
  }

  /** Shows the open conversation as it is now; reading it marks it read. */
  async function refreshReader() {
    const thread = current ? threads.find((t) => keyOf(t) === current) : null;
    if (!current) return reader.show([], false);
    const [accountId, ...rest] = current.split("|");
    const threadId = rest.join("|");
    const folder = view.kind === "folder" ? view.id : thread?.folderId;
    const opened = current;
    try {
      const messages = await mailApi.thread(accountId, threadId, folder);
      if (current !== opened) return;
      if (!messages.length) {
        current = null;
        el.classList.remove("reading");
        return reader.show([], false);
      }
      reader.show(messages, messages.some((m) => m.folderRole === "junk"));
      const unseen = messages.filter((m) => !m.seen).map((m) => m.id);
      if (unseen.length && keepUnread !== opened && visible) void mailApi.flag(unseen, "seen", true).catch(() => undefined);
    } catch (err) {
      report(err);
    }
  }

  function setView(next: View, load = true) {
    view = next;
    settings().view = viewText(next);
    shell.saveConfig();
    current = null;
    keepUnread = null;
    selected.clear();
    limit = PAGE;
    el.classList.remove("reading");
    if (load) {
      if (search.value) search.value = "";
      loadingList = true;
      list.scrollTop = 0;
      draw();
      void reload();
    }
  }

  function open(key: string | null) {
    if (key !== current) keepUnread = null;
    current = key;
    el.classList.toggle("reading", key !== null);
    drawList();
    void refreshReader();
  }

  // ---- acting on conversations

  /** The conversations an action applies to: the ticked ones, else the open one. */
  function targets(openOnly = false): Thread[] {
    if (!openOnly && selected.size) return threads.filter((t) => selected.has(keyOf(t)));
    return threads.filter((t) => keyOf(t) === current);
  }

  function selectAll() {
    threads.forEach((t) => selected.add(keyOf(t)));
    drawList();
  }

  /** The row to land on once these have left the list. */
  function neighbour(leaving: Thread[]): string | null {
    const gone = new Set(leaving.map(keyOf));
    if (!current || !gone.has(current)) return current;
    const at = threads.findIndex((t) => keyOf(t) === current);
    const next = threads.slice(at + 1).find((t) => !gone.has(keyOf(t))) ?? threads.slice(0, at).reverse().find((t) => !gone.has(keyOf(t)));
    return next ? keyOf(next) : null;
  }

  async function act(action: ThreadAction, anchorEl?: HTMLElement, openOnly = false) {
    const items = targets(openOnly);
    if (!items.length) return;
    const ids = items.flatMap((t) => t.ids);
    const many = items.length > 1 ? `${items.length} conversations` : "Conversation";
    try {
      if (action === "star") {
        const on = !items.every((t) => t.flagged);
        await mailApi.flag(on ? items.map((t) => t.id) : ids, "flagged", on);
      } else if (action === "unread") {
        const makeUnread = items.every((t) => t.unread === 0);
        if (makeUnread && current && items.some((t) => keyOf(t) === current)) keepUnread = current;
        await mailApi.flag(makeUnread ? items.map((t) => t.id) : ids, "seen", !makeUnread);
      } else if (action === "move") {
        const accounts = new Set(items.map((t) => t.accountId));
        if (accounts.size > 1) return showToast("Pick conversations of one account to move them together.");
        const account = accountOf(items[0].accountId);
        const r = (anchorEl ?? list).getBoundingClientRect();
        const choices: MenuItem[] = sortedFolders(account?.folders ?? []).filter((f) => f.selectable && f.id !== items[0].folderId).map((f) => ({
          label: `${"   ".repeat(depthOf(f))}${f.name}`, icon: ROLE_ICON[f.role] ?? "folder", action: () => void move(items, String(f.id), `${many} moved to ${f.name}`),
        }));
        openMenu(r.left, r.bottom + 4, choices);
      } else {
        const forever = action === "trash" && items.every((t) => t.folderRole === "trash" || t.folderRole === "junk");
        if (forever && !(await confirmSheet({ title: `Delete ${items.length > 1 ? `these ${items.length} conversations` : "this conversation"} for good?`, message: "It can’t be put back.", confirmLabel: "Delete", destructive: true, icon: "trash" }))) return;
        const done = { archive: "archived", trash: forever ? "deleted for good" : "moved to Trash", junk: "moved to Junk", inbox: "moved to the inbox" }[action];
        await move(items, action, `${many} ${done}`);
      }
    } catch (err) {
      report(err);
    }
  }

  async function move(items: Thread[], to: string, message: string) {
    const next = neighbour(items);
    const moved = await mailApi.move(items.flatMap((t) => t.ids), to);
    const gone = new Set(items.map(keyOf));
    threads = threads.filter((t) => !gone.has(keyOf(t)));
    gone.forEach((key) => selected.delete(key));
    open(next);
    if (!moved.count) return;
    showToast(message, moved.undo.length ? { label: "Undo", run: () => void mailApi.moveUndo(moved.undo).catch(report) } : undefined, 7000);
  }

  // ---- drawing

  /** How deep a folder sits among the account's own folders; the special ones always sit at the top. */
  const depthOf = (f: Folder) => {
    if (f.role) return 0;
    const parts = f.path.split(f.delim || "/");
    return Math.max(0, parts.length - 1 - (parts[0].toUpperCase() === "INBOX" ? 1 : 0));
  };

  function sortedFolders(folders: Folder[]): Folder[] {
    const rank = (f: Folder) => (f.role && ROLE_ORDER.includes(f.role) ? ROLE_ORDER.indexOf(f.role) : ROLE_ORDER.length);
    return [...folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { sensitivity: "base", numeric: true }));
  }

  function navItem(label: string, glyph: IconName, target: View, badge: number, depth = 0, strong = true): HTMLElement {
    const active = !search.value.trim() && viewText(view) === viewText(target);
    const item = h("button", { class: `ml-nav-item${active ? " active" : ""}`, type: "button", style: depth ? { paddingLeft: `${10 + depth * 14}px` } : undefined, title: label },
      icon(glyph, 16), h("span", { class: "ml-nav-label" }, label), badge > 0 ? h("span", { class: `ml-badge${strong ? "" : " quiet"}` }, String(badge)) : null);
    item.addEventListener("click", () => setView(target));
    return item;
  }

  function drawSide() {
    const accounts = overview?.accounts ?? [];
    const inboxUnread = accounts.reduce((n, a) => n + a.folders.filter((f) => f.role === "inbox").reduce((m, f) => m + f.unread, 0), 0);
    const parts: HTMLElement[] = [
      navItem(accounts.length > 1 ? "All Inboxes" : "Inbox", "inbox", { kind: "unified", role: "inbox" }, inboxUnread),
      navItem("Starred", "star", { kind: "starred" }, 0),
      navItem("Drafts", "pencil", { kind: "drafts" }, overview?.drafts ?? 0, 0, false),
      navItem(accounts.length > 1 ? "All Sent" : "Sent", "send", { kind: "unified", role: "sent" }, 0),
    ];
    for (const account of accounts) {
      const collapsed = settings().collapsed.includes(account.id);
      const state = account.error
        ? h("span", { class: "ml-account-state error", title: account.error }, icon("info", 14))
        : account.syncing ? h("span", { class: "ml-account-state", title: "Checking for mail…" }, h("span", { class: "spinner ml-mini-spin" })) : null;
      const head = h("button", { class: "ml-account", type: "button", "aria-expanded": String(!collapsed), title: account.email },
        icon(collapsed ? "chevronRight" : "chevronDown", 12), h("span", { class: `ml-dot ml-c-${account.color}` }), h("span", { class: "ml-account-name" }, account.email), state);
      head.addEventListener("click", () => {
        const set = new Set(settings().collapsed);
        if (!set.delete(account.id)) set.add(account.id);
        settings().collapsed = [...set];
        shell.saveConfig();
        drawSide();
      });
      const menu = (x: number, y: number) => openMenu(x, y, [
        { label: "Check for Mail", icon: "refresh", action: () => void mailApi.sync(account.id).catch(report) },
        { label: "Account Settings…", icon: "settings", action: () => void editAccount(account) },
      ]);
      head.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      });
      const gear = h("button", { class: "icon-btn small ml-account-gear", type: "button", title: "Account settings", "aria-label": `Settings for ${account.email}` }, icon("settings", 13));
      gear.addEventListener("click", () => void editAccount(account));
      parts.push(h("div", { class: "ml-account-row" }, head, gear));
      if (account.error) {
        const fix = h("button", { class: "ml-account-error", type: "button", title: account.error }, account.error);
        fix.addEventListener("click", () => void editAccount(account));
        parts.push(fix);
      }
      if (collapsed) continue;
      if (!account.folders.length) parts.push(h("div", { class: "ml-nav-wait" }, account.error ? "" : "Fetching folders…"));
      for (const f of sortedFolders(account.folders)) {
        if (!f.selectable) {
          // A folder that only holds others ("[Gmail]") shows when one of the account's own folders is in it.
          const holds = account.folders.some((x) => !x.role && x.selectable && x.path.startsWith(`${f.path}${f.delim}`));
          if (holds) parts.push(h("div", { class: "ml-nav-group", style: { paddingLeft: `${24 + depthOf(f) * 14}px` } }, f.name));
          continue;
        }
        const quiet = f.role === "drafts" || f.role === "junk" || f.role === "trash" || f.role === "sent";
        parts.push(navItem(f.name, ROLE_ICON[f.role] ?? "folder", { kind: "folder", id: f.id }, quiet ? 0 : f.unread, 1 + depthOf(f)));
      }
    }
    nav.replaceChildren(...parts);
  }

  function viewTitle(): string {
    if (search.value.trim()) return "Search";
    if (view.kind === "unified") return (overview?.accounts.length ?? 0) > 1 ? (view.role === "inbox" ? "All Inboxes" : "All Sent") : view.role === "inbox" ? "Inbox" : "Sent";
    if (view.kind === "starred") return "Starred";
    if (view.kind === "drafts") return "Drafts";
    return folderOf(view.id)?.name ?? "Mail";
  }

  function threadRow(t: Thread): HTMLElement {
    const key = keyOf(t);
    const account = accountOf(t.accountId);
    const outgoing = t.folderRole === "sent" || t.folderRole === "drafts";
    // In Sent, who it went to; elsewhere, who wrote.
    const who = outgoing ? `To: ${t.to.map(displayName).join(", ") || "(nobody)"}` : t.names.length > 1 ? t.names.map((n) => n.split(/[\s@]/)[0]).join(", ") : displayName(t.from);
    const star = h("button", { class: `ml-row-star${t.flagged ? " on" : ""}`, type: "button", tabindex: -1, title: t.flagged ? "Remove the star" : "Star", "aria-label": "Star" }, icon(t.flagged ? "starFilled" : "star", 14));
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      void mailApi.flag(t.flagged ? t.ids : [t.id], "flagged", !t.flagged).catch(report);
    });
    const tick = h("span", { class: "ml-row-tick", role: "checkbox", "aria-checked": String(selected.has(key)), title: "Select" }, icon("check", 13));
    tick.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSelected(key);
    });
    const person = outgoing && t.to[0] ? t.to[0] : t.from;
    const row = h("div", { class: `ml-row${t.unread ? " unread" : ""}${key === current ? " current" : ""}${selected.has(key) ? " selected" : ""}`, role: "option", "aria-selected": String(key === current), "data-key": key },
      h("span", { class: "ml-row-lead" }, avatar(person, 34), tick),
      h("div", { class: "ml-row-main" },
        h("div", { class: "ml-row-top" }, h("span", { class: "ml-row-who" }, who), t.count > 1 ? h("span", { class: "ml-row-count" }, String(t.count)) : null, h("span", { class: "ml-row-date" }, shortDate(t.date))),
        h("div", { class: "ml-row-subject" }, t.subject || "(no subject)"),
        h("div", { class: "ml-row-bottom" }, h("span", { class: "ml-row-snippet" }, t.snippet), t.attachments ? h("span", { class: "ml-row-clip" }, icon("paperclip", 12)) : null, star)),
      view.kind !== "folder" && (overview?.accounts.length ?? 0) > 1 ? h("span", { class: `ml-row-account ml-c-${account?.color ?? "blue"}`, title: account?.email }) : null);
    row.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) return toggleSelected(key);
      if (e.shiftKey && anchor) return selectRange(anchor, key);
      selected.clear();
      anchor = key;
      open(key);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!selected.has(key)) {
        selected.clear();
        if (current !== key) open(key);
      }
      openMenu(e.clientX, e.clientY, [
        { label: "Reply", icon: "reply", shortcut: "r", disabled: selected.size > 1, action: () => reader.respond("reply") },
        { label: "Forward", icon: "forward", shortcut: "f", disabled: selected.size > 1, action: () => reader.respond("forward") },
        "separator",
        { label: "Archive", icon: "archive", shortcut: "e", action: () => void act("archive") },
        { label: t.unread ? "Mark as Read" : "Mark as Unread", icon: "mail", shortcut: "u", action: () => void act("unread") },
        { label: t.flagged ? "Remove Star" : "Star", icon: "star", shortcut: "s", action: () => void act("star") },
        { label: "Move to…", icon: "folder", shortcut: "v", action: () => void act("move", row) },
        t.folderRole === "junk" ? { label: "Not Junk", icon: "inbox", action: () => void act("inbox") } : { label: "Junk", icon: "junk", action: () => void act("junk") },
        "separator",
        { label: "Delete", icon: "trash", danger: true, shortcut: "del", action: () => void act("trash") },
      ]);
    });
    return row;
  }

  function toggleSelected(key: string) {
    if (!selected.delete(key)) selected.add(key);
    anchor = key;
    drawList();
  }

  function selectRange(from: string, to: string) {
    const a = threads.findIndex((t) => keyOf(t) === from);
    const b = threads.findIndex((t) => keyOf(t) === to);
    if (a < 0 || b < 0) return;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(keyOf(threads[i]));
    drawList();
  }

  function draftRow(saved: SavedDraft): HTMLElement | null {
    let draft: Draft;
    try {
      draft = JSON.parse(saved.json) as Draft;
    } catch {
      return null;
    }
    const text = new DOMParser().parseFromString(draft.html, "text/html");
    text.querySelectorAll(".zz-quote, .zz-signature").forEach((node) => node.remove());
    const remove = h("button", { class: "ml-row-star", type: "button", title: "Delete this draft", "aria-label": "Delete this draft" }, icon("trash", 14));
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      void mailApi.deleteDraft(saved.id).catch(report);
    });
    const to = draft.to[0] ?? { name: "", addr: "" };
    const row = h("div", { class: "ml-row draft", role: "option" },
      h("span", { class: "ml-row-lead" }, avatar(to.addr ? to : { name: "?", addr: "" }, 34)),
      h("div", { class: "ml-row-main" },
        h("div", { class: "ml-row-top" }, h("span", { class: "ml-row-who" }, draft.to.length ? `To: ${draft.to.map(displayName).join(", ")}` : "No recipients yet"), h("span", { class: "ml-row-date" }, shortDate(saved.updated))),
        h("div", { class: "ml-row-subject" }, draft.subject || "(no subject)"),
        h("div", { class: "ml-row-bottom" }, h("span", { class: "ml-row-snippet" }, (text.body.textContent ?? "").trim().slice(0, 160)), remove)));
    row.addEventListener("click", () => openCompose(draft, composeHost));
    return row;
  }

  function emptyState(glyph: IconName, heading: string, text: string, action?: HTMLElement): HTMLElement {
    return h("div", { class: "ml-empty" }, h("div", { class: "ml-empty-tile glass" }, icon(glyph, 28)), h("h2", null, heading), h("p", null, text), action ?? null);
  }

  function drawList() {
    const searching = search.value.trim() !== "";
    title.textContent = viewTitle();
    const folder = view.kind === "folder" && !searching ? folderOf(view.id) : null;
    const unread = folder ? folder.unread : view.kind === "unified" && view.role === "inbox" && !searching ? allFolders().filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0) : 0;
    subtitle.textContent = searching ? `${threads.length}${more ? "+" : ""} found` : unread ? `${unread} unread` : "";
    bulkBar.hidden = selected.size === 0;
    listBar.classList.toggle("bulk", selected.size > 0);
    bulkCount.textContent = `${selected.size} selected`;
    syncButton.classList.toggle("spinning", !!overview?.accounts.some((a) => a.syncing));

    if (view.kind === "drafts" && !searching) {
      const rows = drafts.map(draftRow).filter((r): r is HTMLElement => r !== null);
      list.replaceChildren(...(rows.length ? rows : [emptyState("pencil", "No drafts", "A message you start and close is kept here until it’s sent.")]));
      return;
    }
    if (failed) return void list.replaceChildren(emptyState("info", "Mail couldn’t be read", failed));
    if (!threads.length) {
      const syncing = !!overview?.accounts.some((a) => a.syncing) || (folder !== null && folder.synced === 0);
      list.replaceChildren(
        loadingList || (syncing && !searching && !unreadOnly)
          ? h("div", { class: "ml-loading" }, h("span", { class: "spinner large" }), h("p", null, "Fetching your mail…"))
          : searching ? emptyState("search", "Nothing found", `No mail matches “${search.value.trim()}”.`)
          : unreadOnly ? emptyState("mailOpen", "All read", "Nothing unread here.")
          : emptyState(view.kind === "starred" ? "star" : "inbox", view.kind === "starred" ? "No starred mail" : "Nothing here", view.kind === "starred" ? "Star a message to find it here." : "This mailbox is empty."));
      return;
    }
    const top = list.scrollTop;
    const rows: HTMLElement[] = threads.map(threadRow);
    if (!more && folder && folder.total > folder.loaded && !unreadOnly) {
      const older = h("button", { class: "btn small ml-older", type: "button" }, `Load older messages (${folder.total - folder.loaded} more on the server)`);
      older.addEventListener("click", () => {
        older.disabled = true;
        older.replaceChildren(h("span", { class: "spinner ops-spin" }), "Fetching…");
        void mailApi.older(folder.id).catch(report);
      });
      rows.push(h("div", { class: "ml-older-row" }, older));
    }
    list.replaceChildren(...rows);
    list.scrollTop = top;
  }

  function drawWelcome() {
    const none = overview !== null && overview.accounts.length === 0;
    welcome.hidden = !none;
    panes.hidden = none;
    if (!none || welcome.childElementCount) return;
    const add = h("button", { class: "btn primary large", type: "button" }, icon("plus", 16), "Add an Email Account");
    add.addEventListener("click", () => void editAccount(null));
    welcome.replaceChildren(
      h("div", { class: "ml-welcome-tile glass" }, icon("mail", 40)),
      h("h1", null, "All your email, in one place"),
      h("p", null, "Add your accounts and read them together: one inbox for everything, each account’s folders beside it, search that works offline."),
      add,
      h("p", { class: "ml-welcome-note" }, "Works with Gmail, iCloud, Yahoo, Fastmail and any address that offers IMAP. Passwords stay in your keyring; mail is kept on this computer."));
  }

  function draw() {
    if (!visible) return;
    drawWelcome();
    drawSide();
    drawList();
  }

  /** Moves through the list by rows and opens where it lands. */
  function step(by: number) {
    if (view.kind === "drafts" || !threads.length) return;
    const at = threads.findIndex((t) => keyOf(t) === current);
    const next = threads[clamp(at < 0 ? (by >= 0 ? 0 : threads.length - 1) : at + by, 0, threads.length - 1)];
    if (!next) return;
    selected.clear();
    anchor = keyOf(next);
    open(keyOf(next));
    list.querySelector<HTMLElement>(`.ml-row[data-key="${CSS.escape(keyOf(next))}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // A new-mail notification was clicked: the inbox of every account (the shell brings Mail up).
  unlisten.push(listen("mail-show-inbox", () => {
    if (view.kind !== "unified" || view.role !== "inbox") setView(parseView("unified:inbox"), visible);
  }));

  const module: AppModule = {
    id: "mail",
    title: "Mail",
    icon: "mail",
    el,
    ownsNewKey: true,
    activate() {
      visible = true;
      if (!listening) {
        listening = true;
        unlisten.push(onMailChanged(scheduleReload), onMailError((message) => visible && showToast(message)));
      }
      void mailApi.start();
      draw();
      void reload();
    },
    deactivate() {
      visible = false;
    },
    handleKey(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (ctrl && key === "n") return write(), true;
      if (ctrl && key === "b") return fold(e.shiftKey ? "list" : "side"), true;
      if (ctrl && key === "f") return search.focus(), search.select(), true;
      if (ctrl && key === "a") return selectAll(), true;
      if (key === "F5" || (ctrl && key === "r")) return void sync(), true;
      if (ctrl || e.altKey) return false;
      switch (key) {
        case "c": return write(), true;
        case "/": return search.focus(), search.select(), true;
        case "j": case "ArrowDown": return step(1), true;
        case "k": case "ArrowUp": return step(-1), true;
        case "Home": return step(-threads.length), true;
        case "End": return step(threads.length), true;
        case " ": return reader.scrollBy(e.shiftKey ? -1 : 1), true;
        case "e": return void act("archive"), true;
        case "Delete": case "#": return void act("trash"), true;
        case "!": return void act("junk"), true;
        case "s": return void act("star"), true;
        case "u": return void act("unread"), true;
        case "v": return void act("move", list.querySelector<HTMLElement>(".ml-row.current") ?? undefined), true;
        case "r": return reader.respond("reply"), true;
        case "a": return reader.respond("replyAll"), true;
        case "f": return reader.respond("forward"), true;
        case "x": return current ? (toggleSelected(current), true) : false;
        case "Escape":
          if (selected.size) return selected.clear(), drawList(), true;
          // Back to the list: in a narrow window, or with the list folded while reading.
          if ((el.classList.contains("narrow") || settings().listFolded) && current) return open(null), true;
          return false;
        default: return false;
      }
    },
    configChanged() {
      el.style.setProperty("--ml-list-w", `${settings().listWidth}px`);
      drawFolds();
    },
    onLock() {
      open(null);
    },
    guideTopic: () => "mail",
    dispose() {
      unlisten.forEach((u) => void u.then((fn) => fn()));
      el.remove();
    },
  };
  return module;
};
