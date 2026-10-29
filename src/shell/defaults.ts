import { invoke } from "@tauri-apps/api/core";
import type { SettingsGroup, SettingsRow } from "../appearance";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { openMenu, type MenuItem } from "../ui/menu";

/**
 * Settings → General → Default apps (src-tauri/src/defaults.rs): what opens photos, videos, PDFs,
 * Word documents, spreadsheets and folders when they're double-clicked, here and everywhere on
 * the desktop. One button makes Zazabor the default for all but folders; each kind can also go
 * to any app that opens it.
 */

interface App {
  id: string;
  name: string;
  icon?: string;
}

interface KindState {
  id: string;
  current: App | null;
  mixed: boolean;
  zazabor: boolean;
  apps: App[];
}

interface State {
  installed: boolean;
  kinds: KindState[];
}

const ZAZABOR = "zazabor.desktop";

const KINDS: [id: string, label: string, hint: string][] = [
  ["photos", "Photos", "JPEG, PNG, GIF, WebP, BMP and TIFF"],
  ["videos", "Videos", "MP4, MKV, WebM, MOV and AVI"],
  ["pdf", "PDF files", "Read, fill and sign them in Office → PDF"],
  ["word", "Word documents", ".docx, in Office → Docs"],
  ["sheets", "Spreadsheets", "Excel (.xlsx, .xlsm), CSV and TSV, in Office → Sheets"],
  ["folders", "Folders", "Your whole desktop opens folders with it, Downloads and Show in Folder too"],
];

/** Every kind but folders: what "Use Zazabor for All" covers. */
const EVERYDAY = KINDS.map(([id]) => id).filter((id) => id !== "folders");

const api = {
  state: () => invoke<State>("defaults_state"),
  set: (kinds: string[], appId: string) => invoke<void>("defaults_set", { kinds, appId }),
};

export function defaultAppsGroup(): SettingsGroup {
  const allStatus = h("p", { class: "sf-hint" }, "Checking…");
  const allButton = h("button", { type: "button", class: "btn small primary", disabled: true }, "Use Zazabor for All");
  const allRow: SettingsRow = {
    label: "Use Zazabor for all default apps open with photos videos pdf word excel",
    el: h("div", { class: "sf-row plain" },
      h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Open my files with Zazabor"), allStatus),
      allButton),
  };

  const kindRows = KINDS.map(([id, label, hint]) => {
    const status = h("p", { class: "sf-hint" });
    const pick = h("button", { type: "button", class: "st-app-pick", disabled: true, "aria-label": `Choose the app for ${label.toLowerCase()}` });
    const row: SettingsRow = {
      label: `${label} default app open with`,
      el: h("div", { class: "sf-row plain" },
        h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), status, h("p", { class: "sf-hint st-faint" }, hint)),
        pick),
    };
    return { id, label, status, pick, row };
  });

  let state: State | null = null;

  const set = async (kinds: string[], appId: string) => {
    allButton.disabled = true;
    try {
      await api.set(kinds, appId);
    } catch (err) {
      allStatus.textContent = String(err);
      allStatus.classList.add("st-error");
    }
    await load();
  };

  const appFace = (app: App | null, text: string) => [
    // Zazabor shows its own logo (its launcher's icon may not be installed in every theme).
    app?.id === ZAZABOR ? h("img", { src: "/logo.svg", alt: "", width: 18, height: 18 })
      : app?.icon ? h("img", { src: app.icon, alt: "", width: 18, height: 18 }) : icon(app ? "image" : "close", 16),
    h("span", null, text),
    icon("chevronDown", 14),
  ];

  const render = (s: State) => {
    const everyday = s.kinds.filter((k) => EVERYDAY.includes(k.id));
    const done = everyday.every((k) => k.zazabor);
    allButton.disabled = !s.installed || done;
    allButton.textContent = done ? "Zazabor Opens Them All" : "Use Zazabor for All";
    allStatus.classList.remove("st-error");
    allStatus.textContent = !s.installed
      ? "Zazabor isn't installed for your user, so it can't be a default app yet. Install it with the one-line installer on its website."
      : done ? "Photos, videos, PDFs, Word documents and spreadsheets open in Zazabor." : "Photos, videos, PDFs, Word documents and spreadsheets (folders are below, on their own).";
    for (const r of kindRows) {
      const k = s.kinds.find((x) => x.id === r.id);
      if (!k) continue;
      const name = k.current?.id === ZAZABOR ? "Zazabor" : k.current?.name;
      r.status.textContent = k.zazabor ? "Opens in Zazabor." : k.mixed ? `Opens in ${name ?? "another app"} and other apps, by type.` : name ? `Opens in ${name}.` : "No app opens these yet.";
      r.pick.replaceChildren(...appFace(k.current, k.mixed ? "Several Apps" : name ?? "None"));
      r.pick.disabled = !k.apps.length;
      r.pick.onclick = () => {
        const rect = r.pick.getBoundingClientRect();
        // Zazabor first, then the others the desktop knows for this kind.
        const apps = [...k.apps].sort((a, b) => Number(b.id === ZAZABOR) - Number(a.id === ZAZABOR));
        const items: MenuItem[] = apps.map((app) => ({
          label: app.id === ZAZABOR ? "Zazabor" : app.name,
          icon: !k.mixed && k.current?.id === app.id ? "check" : undefined,
          disabled: app.id === ZAZABOR && !s.installed,
          action: () => void set([k.id], app.id),
        }));
        openMenu(rect.left, rect.bottom + 4, items);
      };
    }
  };

  const load = async () => {
    try {
      state = await api.state();
      render(state);
    } catch (err) {
      allStatus.textContent = `Couldn't read the default apps: ${err}`;
      allStatus.classList.add("st-error");
    }
  };
  allButton.addEventListener("click", () => state && void set(EVERYDAY, ZAZABOR));
  void load();

  return { title: "Default apps", rows: [allRow, ...kindRows.map((r) => r.row)] };
}
