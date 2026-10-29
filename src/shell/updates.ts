import { invoke } from "@tauri-apps/api/core";
import type { SettingsGroup, SettingsRow } from "../appearance";
import type { Config } from "../config";
import { formatBytes, library } from "../content";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";

/**
 * Updates (src-tauri/src/update.rs) and the content library (content.ts), as Settings → Zazabor
 * shows them, and the check now and then that says when there's a newer Zazabor.
 */

export interface UpdateCheck {
  current: string;
  /** The latest version, when it's newer than this one. */
  available: string | null;
  notes: string;
  published: number;
  bytes: number;
  /** Why this copy can't install it itself (then the release page is the way). */
  whyNot: string | null;
  /** A version already installed, starting at the next restart. */
  installed: string | null;
}

interface Progress {
  running: boolean;
  done: number;
  total: number;
  error: string | null;
  installed: string | null;
}

const RELEASES = "https://github.com/Soab42/zazabor/releases/latest";
const CHECK_EVERY_MS = 12 * 3600_000;
/** New templates and music reach a running Zazabor within this long. */
const LIBRARY_EVERY_MS = 3600_000;

const updateApi = {
  check: () => invoke<UpdateCheck>("update_check"),
  install: () => invoke<void>("update_install"),
  progress: () => invoke<Progress>("update_progress"),
  restart: () => invoke<void>("update_restart"),
  usage: () => invoke<{ bytes: number; files: number }>("content_usage"),
  clear: () => invoke<void>("content_clear"),
};

const openLink = (url: string) => void invoke("fs_open_default", { path: url }).catch(() => undefined);

/** How progress reads while an update downloads and installs. */
function progressText(p: Progress): string {
  return p.total && p.done < p.total ? `Downloading the update… ${Math.floor((p.done / p.total) * 100)}%` : "Installing the update…";
}

/**
 * Downloads and installs the latest version (update.rs), reporting progress until it's done;
 * resolves with the version installed. Settings and the popup both use it, so they agree.
 */
async function installUpdate(onProgress: (p: Progress) => void): Promise<string> {
  await updateApi.install();
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const p = await updateApi.progress();
    if (p.running) {
      onProgress(p);
      continue;
    }
    if (p.error) throw new Error(p.error);
    if (p.installed) return p.installed;
    throw new Error("The update stopped before it was installed.");
  }
}

export interface UpdateHost {
  readonly config: Config;
  saveConfig(): void;
  /** Whether a popup may show now (not while locked, in a slideshow or another dialog). */
  canInterrupt(): boolean;
}

/** A first check this long after starting (the window settles first). */
const FIRST_CHECK_MS = 8_000;
/** Coming back online, the check waits this long for the network to settle. */
const ONLINE_DELAY_MS = 5_000;
/** A popup that can't show yet (a slideshow runs) tries again this much later. */
const RETRY_MS = 60_000;

/**
 * In the main window: keeps the content library's catalog fresh (hourly), and (unless turned
 * off) asks GitHub for a newer Zazabor a few seconds after starting, when the computer comes back
 * online, and twice a day. A newer version shows a popup (once per start; Skip This Version
 * for good). Offline, the check fails quietly and nothing shows.
 */
export function startUpdateChecks(host: UpdateHost) {
  void library();
  window.setInterval(() => void library(true), LIBRARY_EVERY_MS);
  /** Versions offered this run ("Later" waits for the next start). */
  const offered = new Set<string>();
  let timer = 0;
  const check = async () => {
    clearTimeout(timer);
    if (!host.config.updates.auto || !navigator.onLine) return;
    const c = await updateApi.check().catch(() => null);
    const version = c?.available;
    if (!c || !version || c.installed === version || host.config.updates.skipped === version || offered.has(version)) return;
    if (!host.canInterrupt()) {
      timer = window.setTimeout(() => void check(), RETRY_MS);
      return;
    }
    offered.add(version);
    showUpdatePopup(c, host);
  };
  window.setTimeout(() => void check(), FIRST_CHECK_MS);
  window.setInterval(() => void check(), CHECK_EVERY_MS);
  window.addEventListener("online", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void check(), ONLINE_DELAY_MS);
  });
}

/**
 * The popup for a newer version: what's new and its size, then Install Update (progress here,
 * then Restart Now), Later, or Skip This Version. A copy that can't update itself links the
 * release page instead.
 */
function showUpdatePopup(c: UpdateCheck, host: UpdateHost) {
  const version = c.available!;
  const button = (text: string, run: () => void, cls = "btn") => h("button", { type: "button", class: cls, onclick: run }, text);
  const status = h("p", { class: "up-status", role: "status", "aria-live": "polite", hidden: true });
  const bar = h("span", { class: "up-bar-fill" });
  const progress = h("div", { class: "up-bar", hidden: true }, bar);
  const notes = c.notes ? h("div", { class: "up-notes" }, h("span", { class: "up-label" }, "What's new"), h("p", null, c.notes)) : null;
  const foot = h("div", { class: "modal-foot" });
  const sub = h("p", { class: "up-sub" }, `You have ${c.current}${c.bytes ? ` · ${formatBytes(c.bytes)} download` : ""}`);
  const card = h("div", { class: "modal up-popup", role: "dialog", "aria-modal": "true", "aria-labelledby": "up-title" },
    h("div", { class: "modal-head up-head" },
      h("img", { src: "/logo.svg", alt: "", width: 48, height: 48 }),
      h("div", { class: "up-heading" }, h("h2", { id: "up-title" }, `Zazabor ${version} is available`), sub),
      h("button", { class: "icon-btn small", type: "button", title: "Later (Esc)", "aria-label": "Later", onclick: () => close() }, icon("close", 14))),
    h("div", { class: "modal-body" }, notes, c.whyNot ? h("p", { class: "up-why" }, c.whyNot) : null, progress, status),
    foot);
  const overlay = h("div", { class: "modal-overlay" }, card);
  let installing = false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  function close() {
    overlay.remove();
    removeEventListener("keydown", onKey, true);
    previous?.focus();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  const setFoot = (...nodes: Node[]) => {
    foot.replaceChildren(...nodes);
    (foot.querySelector<HTMLButtonElement>(".btn.primary") ?? foot.querySelector("button"))?.focus();
  };
  const offer = () => {
    if (c.whyNot) return setFoot(h("span", { class: "spacer" }), button("Later", close), button("Open the Release Page", () => (openLink(RELEASES), close()), "btn primary"));
    setFoot(
      button("Skip This Version", () => {
        host.config.updates.skipped = version;
        host.saveConfig();
        close();
      }, "btn ghost"),
      h("span", { class: "spacer" }),
      button("Later", close),
      button("Install Update", () => void install(), "btn primary"));
  };
  const install = async () => {
    if (installing) return;
    installing = true;
    status.hidden = false;
    status.classList.remove("error");
    progress.hidden = false;
    status.textContent = "Downloading the update…";
    // Closing now only hides this: the update carries on (Settings → Zazabor shows it).
    setFoot(h("span", { class: "spacer" }), button("Hide", close));
    try {
      const done = await installUpdate((p) => {
        status.textContent = progressText(p);
        bar.style.width = `${p.total ? Math.min(100, (p.done / p.total) * 100) : 100}%`;
      });
      bar.style.width = "100%";
      status.textContent = `Zazabor ${done} is installed. Restart to start using it: windows with unsaved work ask first.`;
      setFoot(h("span", { class: "spacer" }), button("Restart Later", close), button("Restart Now", () => void updateApi.restart(), "btn primary"));
    } catch (err) {
      installing = false;
      progress.hidden = true;
      status.classList.add("error");
      status.textContent = `The update didn't install: ${err instanceof Error ? err.message : err}`;
      offer();
    }
  };

  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  offer();
}

/** A row with a label, a status line under it and buttons on the right. */
function statusRow(label: string, keywords: string) {
  const status = h("p", { class: "sf-hint" });
  const extra = h("p", { class: "sf-hint st-update-notes", hidden: true });
  const actions = h("div", { class: "st-actions" });
  const row: SettingsRow = {
    label: `${label} ${keywords}`,
    el: h("div", { class: "sf-row plain" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), status, extra), actions),
  };
  const button = (text: string, run: () => void, primary = false) => h("button", { type: "button", class: `btn small${primary ? " primary" : ""}`, onclick: run }, text);
  return { row, status, extra, actions, button };
}

/** Settings → Zazabor: Updates, then the content library. */
export function updateGroups(config: Config, saveConfig: () => void): SettingsGroup[] {
  // ---- updates
  const u = statusRow("Updates", "version new release upgrade");
  const show = (text: string, ...buttons: HTMLButtonElement[]) => {
    u.status.textContent = text;
    u.actions.replaceChildren(...buttons);
  };
  const installed = (version: string) => {
    u.extra.hidden = true;
    show(`Zazabor ${version} is installed. Restart to start using it.`, u.button("Restart Now", () => void updateApi.restart(), true));
  };
  const check = async () => {
    show("Checking for updates…");
    u.extra.hidden = true;
    let c: UpdateCheck;
    try {
      c = await updateApi.check();
    } catch (err) {
      return show(`Couldn't check for updates: ${err}`, u.button("Try Again", () => void check()));
    }
    if (c.installed) return installed(c.installed);
    if (!c.available) return show(`Zazabor ${c.current} is up to date.`, u.button("Check Again", () => void check()));
    const version = c.available;
    u.extra.textContent = c.notes;
    u.extra.hidden = !c.notes;
    if (c.whyNot) {
      return show(`Zazabor ${version} is available. ${c.whyNot}`, u.button("Open the Release Page", () => openLink(RELEASES)));
    }
    show(`Zazabor ${version} is available (${formatBytes(c.bytes)}). You have ${c.current}.`,
      u.button("Skip This Version", () => {
        config.updates.skipped = version;
        saveConfig();
        show(`Zazabor ${version} was skipped; a later version will be offered.`, u.button("Check Again", () => void check()));
      }),
      u.button("Install Update", () => void install(), true));
  };
  const install = async () => {
    show("Downloading the update…");
    try {
      installed(await installUpdate((p) => (u.status.textContent = progressText(p))));
    } catch (err) {
      show(`The update didn't install: ${err instanceof Error ? err.message : err}`, u.button("Try Again", () => void install()));
    }
  };
  show("", u.button("Check for Updates", () => void check()));
  // An update installed earlier in this session waits for a restart.
  void updateApi.progress().then((p) => {
    if (p.installed) installed(p.installed);
    else if (p.running) void install();
  }).catch(() => undefined);

  const auto = h("input", { type: "checkbox", class: "switch", role: "switch" });
  auto.checked = config.updates.auto;
  auto.addEventListener("change", () => {
    config.updates.auto = auto.checked;
    saveConfig();
  });
  const autoRow: SettingsRow = {
    label: "Check for updates automatically",
    el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Check for updates automatically"),
      h("p", { class: "sf-hint" }, "Asks GitHub for a newer Zazabor now and then, and says when there's one. Nothing installs without you.")), auto),
  };

  // ---- the content library
  const lib = statusRow("Templates, music and fonts", "content library download motion templates soundtracks");
  const showLibrary = async (refresh: boolean) => {
    lib.status.textContent = refresh ? "Checking Zazabor's library…" : "";
    const s = await library(refresh);
    const c = s.catalog;
    const when = c ? new Date(c.published * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    lib.status.textContent = c
      ? `${c.templates.length} templates, ${c.music.length} soundtracks and ${c.fonts.length} font families, updated ${when}. They download when you first use them.`
      : "Zazabor gets its library of templates, soundtracks and fonts when it's online.";
    if (s.error && refresh) lib.status.textContent += ` (Couldn't reach the library: ${s.error})`;
  };
  lib.actions.append(lib.button("Check Now", () => void showLibrary(true)));
  void showLibrary(false);

  const used = statusRow("Downloads", "storage space disk remove clear");
  const showUsage = async () => {
    const usage = await updateApi.usage().catch(() => null);
    used.status.textContent = usage?.files ? `${formatBytes(usage.bytes)} downloaded on this computer.` : "Nothing downloaded yet.";
    removeButton.disabled = !usage?.files;
  };
  const removeButton = used.button("Remove Downloads", async () => {
    await updateApi.clear().catch((err) => (used.status.textContent = String(err)));
    await showUsage();
    used.status.textContent += " Soundtracks, sound effects and fonts download again when they're used.";
  });
  used.actions.append(removeButton);
  void showUsage();

  return [
    { title: "Updates", rows: [u.row, autoRow] },
    { title: "Library", rows: [lib.row, used.row] },
  ];
}
