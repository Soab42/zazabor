import { invoke } from "@tauri-apps/api/core";
import type { SettingsGroup, SettingsRow } from "../appearance";
import type { Config } from "../config";
import { formatBytes, library } from "../content";
import { showToast } from "../modules/files/ops/toast";
import { h } from "../ui/dom";

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

/**
 * In the main window: keeps the content library's catalog fresh (hourly), and (unless turned
 * off) asks GitHub for a newer Zazabor a little after starting and twice a day, saying so when
 * there is.
 */
export function startUpdateChecks(config: Config, openAbout: () => void) {
  void library();
  window.setInterval(() => void library(true), LIBRARY_EVERY_MS);
  const check = async () => {
    if (!config.updates.auto) return;
    const c = await updateApi.check().catch(() => null);
    if (!c?.available || c.installed === c.available || config.updates.skipped === c.available) return;
    showToast(`Zazabor ${c.available} is available.`, { label: "Update…", run: openAbout }, 12_000);
  };
  window.setTimeout(() => void check(), 20_000);
  window.setInterval(() => void check(), CHECK_EVERY_MS);
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
  let poll = 0;
  const show = (text: string, ...buttons: HTMLButtonElement[]) => {
    u.status.textContent = text;
    u.actions.replaceChildren(...buttons);
  };
  const installed = (version: string) => {
    u.extra.hidden = true;
    show(`Zazabor ${version} is installed. Restart to start using it.`, u.button("Restart Now", () => void updateApi.restart(), true));
  };
  const check = async () => {
    clearInterval(poll);
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
    try {
      await updateApi.install();
    } catch (err) {
      return show(`Couldn't install the update: ${err}`, u.button("Try Again", () => void check()));
    }
    show("Downloading the update…");
    clearInterval(poll);
    poll = window.setInterval(async () => {
      const p = await updateApi.progress().catch(() => null);
      if (!p || !u.row.el.isConnected) return clearInterval(poll);
      if (p.running) {
        u.status.textContent = p.total && p.done < p.total ? `Downloading the update… ${Math.floor((p.done / p.total) * 100)}%` : "Installing the update…";
        return;
      }
      clearInterval(poll);
      if (p.error) show(`The update didn't install: ${p.error}`, u.button("Try Again", () => void install()));
      else if (p.installed) installed(p.installed);
    }, 400);
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
