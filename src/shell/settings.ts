import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "../shared/dialog";
import { clipboardCategory } from "../clipboard/settings";
import { notesApi, onSyncStatus, syncText, type SyncStatus } from "../notes/api";
import { createAppearanceControls, type SettingsGroup, type SettingsRow } from "../appearance";
import type { Config, FilesView } from "../config";
import type { LockMode } from "../lock";
import { clear, h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";
import { MODULE_IDS, type ModuleId } from "./module";
import { MODULES } from "./registry";
import { videoShortcuts } from "../modules/video/features/hotkeys";
import { mediaSettings } from "../modules/video/features/profiles/settings";
import { videoCategories } from "./settings-video";

/** What the Settings page needs from the shell. */
export interface SettingsHost {
  readonly config: Config;
  /** Applies the appearance everywhere, saves it and tells the modules. */
  appearanceChanged(): void;
  /** Saves the config and tells the modules to re-read it. */
  configChanged(): void;
  setFeature(id: ModuleId, on: boolean): void;
  lockMode(): LockMode;
  openLockSettings(): void;
  lockNow(): void;
  /** Leaves Settings and returns to the module. */
  close(): void;
}

export interface Category {
  id: string;
  title: string;
  icon: IconName;
  section: "App" | "Modules" | "Video" | "About";
  groups: SettingsGroup[];
  /** Shown above the groups. */
  intro?: HTMLElement;
  /** Re-reads live state (lock mode, feature switches) when the page opens. */
  refresh?(): void;
}

// ---- small row builders -------------------------------------------------------------------------

function plainRow(label: string, control: HTMLElement, layout: "wide" | "" = ""): SettingsRow {
  return { label, el: h("div", { class: `sf-row plain${layout ? ` ${layout}` : ""}` }, h("span", { class: "sf-label" }, label), control) };
}

function toggleRow(label: string, hint: string, get: () => boolean, set: (on: boolean) => void) {
  const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
  input.checked = get();
  input.addEventListener("change", () => set(input.checked));
  const el = h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), hint ? h("p", { class: "sf-hint" }, hint) : null), input);
  return { row: { label, el } satisfies SettingsRow, input };
}

function segmentedRow<T extends string>(label: string, options: [T, string][], get: () => T, set: (v: T) => void): SettingsRow {
  const group = h("div", { class: "segmented" });
  const buttons = options.map(([value, text]) => {
    const button = h("button", { type: "button", onclick: () => (set(value), sync()) }, text);
    group.append(button);
    return [value, button] as const;
  });
  const sync = () => buttons.forEach(([value, button]) => button.classList.toggle("active", get() === value));
  sync();
  return plainRow(label, group);
}

function sliderRow(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, unit = "px"): SettingsRow {
  const input = h("input", { type: "range", min, max, step });
  const value = h("span", { class: "sf-value" });
  const sync = () => {
    input.value = String(get());
    value.textContent = `${get()} ${unit}`;
  };
  input.addEventListener("input", () => {
    set(Number(input.value));
    sync();
  });
  sync();
  return { label, el: h("div", { class: "sf-row" }, h("span", { class: "sf-label" }, label), input, value) };
}

const textValue = (text: string) => h("span", { class: "st-value" }, text);

/** Shows an error from the backend in a value field. */
function alertText(el: HTMLElement, err: unknown) {
  el.textContent = String(err);
  el.classList.add("st-error");
}

// ---- keyboard reference ---------------------------------------------------------------------------

const SHORTCUTS: { title: string; rows: [string, string[][]][] }[] = [
  {
    title: "Everywhere",
    rows: [
      ["Switch module", [["Ctrl", "1"], ["Ctrl", "2"], ["Ctrl", "3"]]],
      ["Open Settings", [["Ctrl", ","]]],
      ["Lock CorePro (with a privacy lock)", [["Ctrl", "L"]]],
      ["Close Settings", [["Esc"]]],
    ],
  },
  {
    title: "Gallery",
    rows: [
      ["Search albums and photos", [["Ctrl", "F"]]],
      ["Move between photos", [["←"], ["→"], ["↑"], ["↓"]]],
      ["Open the focused photo", [["Enter"]]],
      ["Select everything", [["Ctrl", "A"]]],
      ["Clear the selection", [["Esc"]]],
      ["Back to albums", [["Backspace"], ["Esc"]]],
      ["Start a slideshow", [["F5"], ["Ctrl", "Enter"]]],
      ["Back and forward", [["Mouse back"], ["Mouse forward"]]],
    ],
  },
  {
    title: "Photo viewer",
    rows: [
      ["Previous photo", [["←"], ["Page Up"], ["Backspace"]]],
      ["Next photo", [["→"], ["Page Down"], ["Space"]]],
      ["First and last photo", [["Home"], ["End"]]],
      ["Zoom in", [["+"], ["↑"]]],
      ["Zoom out", [["−"], ["↓"]]],
      ["Fit to window", [["0"]]],
      ["Actual size, 200%, 400% …", [["1"], ["2"], ["3"], ["…"], ["8"]]],
      ["Rotate right and left", [["R"], ["Shift", "R"]]],
      ["Info and histogram", [["I"]]],
      ["Show or hide the filmstrip", [["H"]]],
      ["Fullscreen", [["F"], ["F11"]]],
      ["Slideshow from this photo", [["S"], ["F5"]]],
      ["Back to the library", [["Esc"]]],
    ],
  },
  {
    title: "Slideshow",
    rows: [
      ["Pause and resume", [["Space"], ["K"]]],
      ["Next and previous", [["→"], ["←"]]],
      ["Mute music", [["M"]]],
      ["Slideshow settings", [["S"], [","]]],
      ["Captions", [["C"]]],
      ["End the slideshow", [["Esc"]]],
    ],
  },
];

function keyboardGroups(config: Config): SettingsGroup[] {
  const video = videoShortcuts(mediaSettings({ config })).map((group) => ({ title: `Video · ${group.title}`, rows: group.rows }));
  return [...SHORTCUTS, ...video].map(({ title, rows }) => ({
    title,
    rows: rows.map(([label, combos]) => {
      const keys = h("div", { class: "st-keys" });
      combos.forEach((combo, i) => {
        if (i > 0) keys.append(h("span", { class: "st-or" }, "or"));
        keys.append(h("span", { class: "st-combo" }, ...combo.map((k) => h("kbd", null, k))));
      });
      return plainRow(label, keys);
    }),
  }));
}

// ---- the page --------------------------------------------------------------------------------------

/** The Settings page, shown in the workspace: a searchable category list and the selected category's rows. */
export class Settings {
  readonly el = h("section", { class: "settings", hidden: true, "aria-label": "Settings" });
  private search = h("input", { class: "search-input", type: "search", placeholder: "Search settings", spellcheck: false });
  private nav = h("nav", { class: "st-nav-list" });
  private page = h("div", { class: "st-page" });
  private title = h("h1", { class: "st-title" });
  private navButtons = new Map<string, HTMLButtonElement>();
  private categories: Category[];
  private selected = "general";
  private appearance;
  private featureInputs = new Map<ModuleId, HTMLInputElement>();
  private lockValue = textValue("");
  private lockNowButton = h("button", { type: "button", class: "btn small" }, "Lock now");
  private autoLockValue = textValue("");
  private version = textValue("");
  /** Shows the notes sync's status on the Notes page while it exists. */
  private showSync: ((status: SyncStatus) => void) | null = null;

  constructor(private readonly host: SettingsHost) {
    this.appearance = createAppearanceControls(host.config.appearance, () => host.appearanceChanged());
    this.categories = this.buildCategories();

    let section: string | null = null;
    for (const category of this.categories) {
      if (category.section !== section) {
        section = category.section;
        this.nav.append(h("div", { class: "st-nav-head" }, section));
      }
      const button = h("button", { class: "st-nav-item", onclick: () => this.select(category.id) }, icon(category.icon, 17), h("span", null, category.title));
      this.navButtons.set(category.id, button);
      this.nav.append(button);
    }
    this.search.addEventListener("input", () => this.render());
    const aside = h("aside", { class: "st-nav" }, h("div", { class: "st-nav-top" }, h("label", { class: "search" }, icon("search", 15), this.search)), this.nav);
    const main = h(
      "div",
      { class: "st-main" },
      h("header", { class: "st-head" }, this.title, h("div", { class: "spacer" }), h("button", { class: "icon-btn", title: "Close (Esc)", "aria-label": "Close settings", onclick: () => host.close() }, icon("close"))),
      this.page,
    );
    this.el.append(aside, main);
    getVersion().then((v) => (this.version.textContent = v)).catch(() => (this.version.textContent = "dev"));
    void onSyncStatus((status) => this.showSync?.(status));
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** Shows the page, on `categoryId` when given, otherwise where it was left. */
  open(categoryId?: string) {
    if (categoryId) this.selected = categoryId;
    this.search.value = "";
    // Rows are cheap; rebuilding them picks up changes a module made to its own settings.
    this.categories = this.buildCategories();
    this.appearance.sync();
    this.el.hidden = false;
    this.refresh();
    this.render();
  }

  close() {
    this.appearance.flush();
    this.el.hidden = true;
  }

  /** Re-reads live state, e.g. after a feature was turned off or the lock changed. */
  refresh() {
    for (const category of this.categories) category.refresh?.();
    if (this.isOpen) this.syncNav();
  }

  /** Esc closes (after clearing a search); returns true when the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.key !== "Escape") return false;
    if (this.search.value) {
      this.search.value = "";
      this.render();
    } else {
      this.host.close();
    }
    return true;
  }

  private select(id: string) {
    this.selected = id;
    this.search.value = "";
    this.render();
  }

  private syncNav() {
    const searching = this.search.value.trim() !== "";
    for (const [id, button] of this.navButtons) button.classList.toggle("active", !searching && id === this.selected);
  }

  private render() {
    clear(this.page);
    this.syncNav();
    const query = this.search.value.trim().toLowerCase();
    if (!query) {
      const category = this.categories.find((c) => c.id === this.selected) ?? this.categories[0];
      this.title.textContent = category.title;
      if (category.intro) this.page.append(category.intro);
      for (const group of category.groups) this.page.append(this.renderGroup(group.title, group.rows));
      this.page.scrollTop = 0;
      return;
    }

    this.title.textContent = "Search results";
    const terms = query.split(/\s+/);
    let found = 0;
    for (const category of this.categories) {
      for (const group of category.groups) {
        const rows = group.rows.filter((row) => {
          const hay = `${row.label} ${group.title} ${category.title}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
        if (!rows.length) continue;
        found += rows.length;
        this.page.append(this.renderGroup(`${category.title} · ${group.title}`, rows));
      }
    }
    if (!found) this.page.append(h("p", { class: "st-none" }, `No settings match “${this.search.value.trim()}”.`));
    this.page.scrollTop = 0;
  }

  private renderGroup(title: string, rows: SettingsRow[]) {
    return h("fieldset", { class: "sf-group" }, h("legend", null, title), h("div", { class: "st-card" }, ...rows.map((r) => r.el)));
  }

  // ---- categories

  private buildCategories(): Category[] {
    const { config } = this.host;
    return [
      { id: "general", title: "General", icon: "settings", section: "App", groups: this.appearance.general() },
      { id: "appearance", title: "Appearance", icon: "palette", section: "App", groups: this.appearance.appearance() },
      this.featuresCategory(),
      this.privacyCategory(),
      { id: "keyboard", title: "Keyboard", icon: "terminal", section: "App", groups: keyboardGroups(config) },
      {
        id: "files", title: "Files", icon: "folder", section: "Modules",
        groups: [{
          title: "Browsing",
          rows: [
            toggleRow("Show hidden files", "Include files and folders whose names start with a dot.", () => config.files.showHidden, (on) => (config.files.showHidden = on, this.host.configChanged())).row,
            toggleRow("Folders first", "List folders before files when sorting.", () => config.files.foldersFirst, (on) => (config.files.foldersFirst = on, this.host.configChanged())).row,
            segmentedRow<FilesView>("Default view", [["icon", "Icons"], ["list", "List"], ["column", "Columns"], ["gallery", "Gallery"]], () => config.files.view, (v) => (config.files.view = v, this.host.configChanged())),
          ],
        }],
      },
      {
        id: "gallery", title: "Gallery", icon: "image", section: "Modules",
        groups: [{
          title: "Library",
          rows: [
            segmentedRow<Config["sort"]>("Sort albums and photos", [["date", "Recent"], ["name", "Name"]], () => config.sort, (v) => (config.sort = v, this.host.configChanged())),
            sliderRow("Thumbnail size", 96, 320, 8, () => config.thumbSize, (v) => (config.thumbSize = v, this.host.configChanged())),
          ],
        }],
      },
      this.notesCategory(),
      clipboardCategory(),
      ...videoCategories(this.host),
      this.aboutCategory(),
    ];
  }

  private featuresCategory(): Category {
    const { config } = this.host;
    this.featureInputs.clear();
    const rows = MODULE_IDS.map((id) => {
      const meta = MODULES[id];
      const { row, input } = toggleRow(meta.title, meta.blurb, () => config.features[id], (on) => {
        this.host.setFeature(id, on);
        this.refresh();
      });
      this.featureInputs.set(id, input);
      return row;
    });
    return {
      id: "features", title: "Features", icon: "sparkles", section: "App",
      groups: [{ title: "Turn features on or off", rows }],
      refresh: () => {
        const on = MODULE_IDS.filter((id) => config.features[id]);
        for (const [id, input] of this.featureInputs) {
          input.checked = config.features[id];
          // The last feature stays on, so there is always something to show.
          input.disabled = on.length === 1 && on[0] === id;
          input.title = input.disabled ? "At least one feature must stay on" : "";
        }
      },
    };
  }

  private privacyCategory(): Category {
    const { config } = this.host;
    this.lockNowButton.addEventListener("click", () => this.host.lockNow());
    const lockControl = h("div", { class: "st-inline" }, this.lockValue, h("button", { type: "button", class: "btn small", onclick: () => this.host.openLockSettings() }, "Configure…"));
    const names: Record<LockMode, string> = { off: "Off", system: "System password", custom: "Custom password" };
    return {
      id: "privacy", title: "Privacy", icon: "lock", section: "App",
      groups: [{
        title: "Privacy lock",
        rows: [
          plainRow("Lock", lockControl),
          plainRow("Lock automatically", this.autoLockValue),
          plainRow("Lock now", this.lockNowButton),
        ],
      }],
      refresh: () => {
        const mode = this.host.lockMode();
        this.lockValue.textContent = names[mode];
        this.lockNowButton.disabled = mode === "off";
        const minutes = config.autoLockMinutes;
        this.autoLockValue.textContent = mode === "off" ? "Not applicable" : minutes ? `After ${minutes} minute${minutes === 1 ? "" : "s"}` : "Never";
      },
    };
  }

  private notesCategory(): Category {
    const { config } = this.host;
    const button = (label: string, onclick: () => void, cls = "btn small") => h("button", { type: "button", class: cls, onclick }, label);
    const wideRow = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
      label: `${label} ${hint}`,
      el: h("div", { class: "sf-row plain wide st-notes-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
    });

    // Sync through a folder.
    const folderValue = textValue("Off");
    const statusValue = textValue("");
    const turnOff = button("Turn Off", () => void notesApi.setSyncFolder(null).catch((err) => alertText(statusValue, err)), "btn small ghost");
    const syncNow = button("Sync Now", () => void notesApi.syncNow());
    const showFolder = button("Show Folder", () => {
      const folder = folderValue.title;
      if (folder) void invoke("fs_open_default", { path: folder }).catch(() => undefined);
    }, "btn small ghost");
    const choose = button("Choose…", async () => {
      const folder = await openDialog({ directory: true, title: "Choose a Folder to Sync Notes With" }).catch(() => null);
      if (typeof folder === "string") await notesApi.setSyncFolder(folder).catch((err) => alertText(statusValue, err));
    });
    this.showSync = (status) => {
      folderValue.textContent = status.folder ? status.folder.replace(/^.*\//, "") || status.folder : "Off";
      folderValue.title = status.folder ?? "";
      statusValue.textContent = syncText(status);
      statusValue.classList.toggle("st-error", status.state === "error");
      for (const el of [turnOff, syncNow, showFolder]) el.hidden = !status.folder;
      choose.textContent = status.folder ? "Change…" : "Choose…";
    };

    // The desktop shortcut for a quick note.
    type Shortcut = { supported: boolean; state: "none" | "installed" | "other"; binding: string; command: string };
    const BINDINGS: [string, string][] = [["<Super><Alt>n", "Super+Alt+N"], ["<Primary><Alt>n", "Ctrl+Alt+N"], ["<Super><Shift>n", "Super+Shift+N"], ["<Primary><Shift><Alt>n", "Ctrl+Shift+Alt+N"]];
    const keys = h("select", { "aria-label": "Shortcut" }, ...BINDINGS.map(([value, label]) => h("option", { value }, label)));
    const shortcutState = textValue("");
    const shortcutButton = button("Add Shortcut", () => void setShortcut(keys.value));
    const removeShortcut = button("Remove", () => void setShortcut(null), "btn small ghost");
    const copyCommand = button("Copy Command", () => void navigator.clipboard.writeText(command).catch(() => undefined));
    let command = "";
    const showShortcut = (s: Shortcut) => {
      command = s.command;
      if (!BINDINGS.some(([value]) => value === s.binding)) keys.append(h("option", { value: s.binding }, s.binding));
      keys.value = s.binding;
      keys.hidden = shortcutButton.hidden = !s.supported;
      copyCommand.hidden = s.supported;
      removeShortcut.hidden = s.state === "none";
      shortcutButton.textContent = s.state === "installed" ? "Update" : s.state === "other" ? "Use This CorePro" : "Add Shortcut";
      shortcutState.textContent = !s.supported ? "" : s.state === "installed" ? "On" : s.state === "other" ? "Opens another CorePro" : "";
    };
    const setShortcut = async (binding: string | null) => {
      try {
        showShortcut(await invoke<Shortcut>("notes_set_shortcut", { binding }));
      } catch (err) {
        alertText(shortcutState, err);
      }
    };

    const refresh = () => {
      void notesApi.syncStatus().then((s) => this.showSync?.(s), () => undefined);
      void invoke<Shortcut>("notes_shortcut").then(showShortcut, () => undefined);
    };
    return {
      id: "notes", title: "Notes", icon: "note", section: "Modules",
      groups: [
        {
          title: "Sync",
          rows: [
            wideRow("Sync folder", "Each note is saved there as a Markdown file. Pick a folder in Google Drive or OneDrive (connected in your desktop’s Online Accounts), Nextcloud, Dropbox or Syncthing to read your notes on the web and on your other computers.",
              h("div", { class: "st-inline" }, folderValue, turnOff, choose)),
            plainRow("Status", h("div", { class: "st-inline" }, statusValue, showFolder, syncNow)),
          ],
        },
        {
          title: "Quick note",
          rows: [
            wideRow("Keyboard shortcut", "Opens a new note from anywhere, even when CorePro isn’t running. It runs “corepro --new-note”, which you can also bind yourself.",
              h("div", { class: "st-inline" }, shortcutState, keys, removeShortcut, shortcutButton, copyCommand)),
          ],
        },
        {
          title: "Notes",
          rows: [
            toggleRow("Reopen notes at start", "Notes that were on the desktop when CorePro closed come back when it starts.", () => config.notes.reopen, (on) => (config.notes.reopen = on, this.host.configChanged())).row,
          ],
        },
      ],
      refresh,
    };
  }

  private aboutCategory(): Category {
    return {
      id: "about", title: "CorePro", icon: "info", section: "About",
      intro: h("div", { class: "st-about" },
        h("img", { src: "/logo.svg", alt: "", width: 64, height: 64 }),
        h("h2", null, "CorePro"),
        h("p", { class: "muted" }, "Files, photos and video in one calm place."),
        h("div", { class: "st-about-version" }, "Version ", this.version)),
      groups: [{
        title: "Credits",
        rows: [
          plainRow("Built with", textValue("Tauri 2, TypeScript and WebGL")),
          plainRow("Video engine", textValue("libVLC (LGPL 2.1+)")),
          plainRow("Player design", textValue("Inspired by the VLC Redesign concept")),
          plainRow("Grew out of", textValue("SliderPro")),
        ],
      }],
    };
  }
}
