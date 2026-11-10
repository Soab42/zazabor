import { homeDir } from "@tauri-apps/api/path";
import type { AppsSettings } from "../../config";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { dirname, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import "../files/ops/ops.css";
import { showToast } from "../files/ops/toast";
import { appsApi, formatDate, formatSize, GROUPS, SOURCES, type Group, type Program } from "./api";
import "./apps.css";
import { uninstallSheet } from "./uninstall";

const SORTS: [AppsSettings["sort"], string][] = [["name", "Name"], ["size", "Size"], ["date", "Date Installed"]];

/**
 * The Apps section: every installed app in one list, like Windows' "Installed apps": apt packages,
 * Flatpaks, Snaps, AppImages, apps unpacked in the home folder, web apps and Steam games. Search,
 * filter by where they came from, sort by name, size or date, open one, show it in Files, and
 * uninstall it the way it was installed.
 */
export const createAppsModule: ModuleFactory = (shell) => {
  const settings = () => shell.config.apps;
  let programs: Program[] | null = null;
  let loading = false;
  let failed: string | null = null;
  let visible = false;
  let dryRun = false;
  let home = "";
  let loadedAt = 0;
  void homeDir().then((dir) => (home = dir.replace(/\/+$/, "")), () => undefined);
  void appsApi.dryRun().then((on) => ((dryRun = on), draw()), () => undefined);

  const search = h("input", { class: "search-input", type: "search", placeholder: "Search apps", "aria-label": "Search apps", spellcheck: "false" });
  search.addEventListener("input", () => draw());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      draw();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list.querySelector<HTMLElement>(".ap-row")?.focus();
    }
  });
  const groupButtons = GROUPS.map(([id, label]) => [id, h("button", { type: "button", onclick: () => setGroup(id) }, label)] as const);
  const groups = h("div", { class: "segmented ap-groups" }, ...groupButtons.map(([, b]) => b));
  const count = h("span", { class: "cm-count" });
  const sortButton = h("button", { class: "btn small ghost ap-sort", type: "button", onclick: (e: MouseEvent) => sortMenu(e.currentTarget as HTMLElement) });
  const refresh = h("button", { class: "icon-btn", type: "button", title: "Look again", "aria-label": "Refresh", onclick: () => void load() }, icon("refresh", 17));
  const bar = h("header", { class: "cm-bar ap-bar" },
    h("div", { class: "cm-title" }, h("h1", null, "Apps"), count),
    h("label", { class: "search cm-search" }, icon("search", 15), search),
    groups,
    h("div", { class: "spacer" }), sortButton, refresh);
  const summary = h("div", { class: "ap-summary" });
  const list = h("div", { class: "ap-list", role: "list" });
  const content = h("div", { class: "ap-content" }, summary, list);
  const scroll = h("div", { class: "ap-scroll" }, content);
  const el = h("section", { class: "apps-module" }, bar, scroll);

  list.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".ap-row");
    if (!row) return;
    const program = shownById.get(row.dataset.id ?? "");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
      if (next) next.focus();
      else if (e.key === "ArrowUp") search.focus();
    } else if (e.key === "Enter" && program?.launcher) {
      e.preventDefault();
      void launch(program);
    } else if (e.key === "Delete" && program) {
      e.preventDefault();
      void uninstall(program);
    } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && program) {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      menu(program, r.right - 40, r.top + r.height / 2);
    }
  });

  let shownById = new Map<string, Program>();

  function setGroup(id: Group) {
    settings().group = id;
    shell.saveConfig();
    draw();
  }

  function sortMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, SORTS.map(([id, label]) => ({
      label, icon: settings().sort === id ? "check" : undefined,
      action: () => {
        settings().sort = id;
        shell.saveConfig();
        draw();
      },
    })));
  }

  async function load() {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    refresh.classList.add("spinning");
    if (!programs) draw();
    try {
      programs = await appsApi.list();
      failed = null;
      loadedAt = Date.now();
    } catch (err) {
      failed = String(err);
    } finally {
      loading = false;
      refresh.disabled = false;
      refresh.classList.remove("spinning");
    }
    draw();
  }

  function matches(p: Program, terms: string[]): boolean {
    const hay = `${p.name} ${p.package ?? ""} ${p.publisher ?? ""} ${p.summary} ${SOURCES[p.source].label} ${p.launchers.join(" ")}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }

  function shown(): Program[] {
    const group = settings().group;
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const items = (programs ?? []).filter((p) => (group === "all" || SOURCES[p.source].group === group) && matches(p, terms));
    const byName = (a: Program, b: Program) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    const sort = settings().sort;
    return items.sort((a, b) => sort === "size" ? (b.size ?? -1) - (a.size ?? -1) || byName(a, b) : sort === "date" ? (b.installed ?? 0) - (a.installed ?? 0) || byName(a, b) : byName(a, b));
  }

  function row(p: Program): HTMLElement {
    const source = SOURCES[p.source];
    const meta = [p.version, p.publisher && p.publisher !== source.label ? p.publisher : null].filter(Boolean).join(" · ");
    const more = h("button", { class: "icon-btn ap-more", type: "button", title: "More", "aria-label": `More for ${p.name}`, tabindex: -1 }, icon("more", 17));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      menu(p, r.left, r.bottom + 4);
    });
    const badge = h("span", { class: `ap-badge ap-badge-${p.source}`, title: sourceTitle(p) }, source.label);
    const el = h("div", { class: `ap-row${p.source === "missing" ? " broken" : ""}`, role: "listitem", tabindex: 0, "data-id": p.id, title: p.summary || null },
      p.icon ? h("img", { class: "ap-icon", src: p.icon, alt: "", width: 32, height: 32, draggable: false, loading: "lazy" }) : h("span", { class: "ap-icon ap-icon-blank" }, icon(source.icon, 18)),
      h("div", { class: "ap-main" },
        h("div", { class: "ap-name" }, h("span", { class: "ap-name-text" }, p.name), badge),
        h("div", { class: "ap-meta" }, meta || fallbackMeta(p))),
      h("div", { class: "ap-date" }, p.installed ? formatDate(p.installed) : ""),
      h("div", { class: "ap-size" }, p.size != null ? formatSize(p.size) : ""),
      more);
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menu(p, e.clientX, e.clientY);
    });
    el.addEventListener("dblclick", () => p.launcher && void launch(p));
    return el;
  }

  /** The second line when there's no version or publisher: where it lives, else what it is. */
  function fallbackMeta(p: Program): string {
    if (p.source === "missing") return "Its program isn’t there any more";
    if ((p.source === "appimage" || p.source === "folder" || p.source === "file") && p.location) return tilde(p.location);
    return p.summary || sourceTitle(p);
  }

  function tilde(path: string): string {
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }

  function sourceTitle(p: Program): string {
    switch (p.source) {
      case "deb": return `apt package “${p.package}”, installed for everyone`;
      case "flatpak": return `Flatpak ${p.package}, ${p.installation === "user" ? "installed for you" : "installed for everyone"}`;
      case "snap": return `Snap “${p.package}”`;
      case "appimage": return "An AppImage file in your home folder";
      case "folder": return "Unpacked into a folder in your home folder";
      case "file": return "A program file in your home folder";
      case "web": return "A browser’s web app";
      case "steam": return "A Steam game";
      case "launcher": return "A launcher for a program installed some other way";
      case "missing": return "A launcher whose program was removed";
      case "manual": return "Installed for everyone outside a package";
    }
  }

  function menu(p: Program, x: number, y: number) {
    const items: MenuItem[] = [];
    if (p.launcher) items.push({ label: "Open", icon: "external", action: () => void launch(p) });
    if (p.location) {
      const folder = p.source === "folder" || p.source === "flatpak" ? p.location : dirname(p.location);
      items.push({ label: "Show in Files", icon: "folder", action: () => shell.open({ kind: "folder", path: folder }) });
    }
    if (p.package) items.push({ label: `Copy “${p.package}”`, icon: "copy", action: () => void navigator.clipboard.writeText(p.package!).then(() => showToast("Copied", undefined, 1800)) });
    if (items.length) items.push("separator");
    const label = p.source === "web" || p.source === "launcher" || p.source === "missing" ? "Remove Launcher…" : "Uninstall…";
    items.push({ label, icon: "trash", danger: true, disabled: p.isSelf, action: () => void uninstall(p) });
    openMenu(x, y, items);
  }

  async function launch(p: Program) {
    if (!p.launcher) return;
    try {
      await appsApi.open(p.launcher);
      showToast(`Opening ${p.name}…`, undefined, 2200);
    } catch (err) {
      showToast(String(err));
    }
  }

  async function uninstall(p: Program) {
    if (p.isSelf) return;
    const outcome = await uninstallSheet(p, home);
    if (!outcome) return;
    if (outcome.problems.length) console.warn("Uninstall problems:", outcome.problems);
    const undo = outcome.trashed.length && (p.source === "appimage" || p.source === "folder" || p.source === "file" || p.source === "web" || p.source === "launcher" || p.source === "missing")
      ? { label: "Undo", run: () => void appsApi.restore(outcome.trashed).then(() => setTimeout(() => void load(), 600), (err) => showToast(String(err))) }
      : undefined;
    showToast(outcome.problems.length ? `${outcome.message} Some of its files stayed: ${outcome.problems[0]}` : outcome.message, undo, undo ? 8000 : 5000);
    // Removing it from the list right away; the fresh scan confirms.
    if (programs && !outcome.message.startsWith("Dry run") && p.source !== "steam") programs = programs.filter((x) => x.id !== p.id);
    draw();
    void load();
  }

  function draw() {
    if (!visible) return;
    sortButton.replaceChildren(icon("sort", 14), SORTS.find(([id]) => id === settings().sort)?.[1] ?? "Name", icon("chevronDown", 12));
    const all = programs ?? [];
    const present = new Set(all.map((p) => SOURCES[p.source].group));
    for (const [id, button] of groupButtons) {
      button.hidden = id !== "all" && !present.has(id) && settings().group !== id;
      button.classList.toggle("active", id === settings().group);
    }
    if (!programs) {
      count.textContent = "";
      summary.replaceChildren();
      list.replaceChildren(failed ? empty("info", "Couldn’t list your apps", failed) : h("div", { class: "ap-loading" }, h("span", { class: "spinner large" }), h("p", null, "Looking for installed apps…")));
      return;
    }
    const items = shown();
    shownById = new Map(items.map((p) => [p.id, p]));
    count.textContent = String(all.length);
    const total = items.reduce((n, p) => n + (p.size ?? 0), 0);
    summary.replaceChildren(
      h("p", null, `${items.length} app${items.length === 1 ? "" : "s"}${total ? ` · ${formatSize(total)}` : ""}`),
      dryRun ? h("span", { class: "ap-dry" }, icon("info", 14), "Dry run: uninstalling only shows what would happen") : "",
    );
    if (!items.length) {
      const query = search.value.trim();
      list.replaceChildren(empty("search", "Nothing matches", query ? `No apps match “${query}”.` : "No apps of this kind are installed."));
      return;
    }
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".ap-row")?.dataset.id;
    list.replaceChildren(...items.map(row));
    if (focused) list.querySelector<HTMLElement>(`.ap-row[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function empty(glyph: IconName, title: string, text: string): HTMLElement {
    return h("div", { class: "nm-empty cp-empty ap-empty" }, h("div", { class: "cp-empty-tile glass" }, icon(glyph, 28)), h("h2", null, title), h("p", null, text));
  }

  const module: AppModule = {
    id: "apps",
    title: "Apps",
    icon: "package",
    el,
    activate() {
      visible = true;
      draw();
      // Look again when coming back after a while (something may have been installed meanwhile).
      if (!programs || Date.now() - loadedAt > 60_000) void load();
    },
    deactivate() {
      visible = false;
    },
    handleKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        search.focus();
        search.select();
        return true;
      }
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
        void load();
        return true;
      }
      return false;
    },
    guideTopic: () => "apps",
    dispose() {
      el.remove();
    },
  };
  return module;
};
