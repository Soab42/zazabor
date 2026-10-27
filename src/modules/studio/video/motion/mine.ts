import { open, save } from "../../../../shared/dialog";
import { h } from "../../../../ui/dom";
import { openDialog } from "../../../time/dialog";
import { mediaOf, uid, type Media } from "../model";
import { FORMAT_VERSION, normalizePackage, type PackageDoc, type Template } from "./format";
import { deleteAssets, packTemplate, readBytes, storeAsset, unpackTemplate } from "./files";
import { MAX_MINE, type SavedTemplate } from "./settings";
import { templateOf } from "./templates";
import type { MotionTools } from "./tools";

/**
 * My Templates: a template clip saved with its texts, look and pictures (kept in the app's data
 * folder) to use again, and `.zaztemplate` packages to pass one to another computer.
 */

const extOf = (path: string) => (/\.([a-z0-9]{1,5})$/i.exec(path)?.[1] ?? "png").toLowerCase();

export const PACKAGE_FILTER = { name: "Zazabor motion template", extensions: ["zaztemplate"] };

/** Asks for a name (null when cancelled). */
export function askName(title: string, initial: string, action: string): Promise<string | null> {
  return new Promise((done) => {
    let result: string | null = null;
    const input = h("input", { type: "text", class: "mo-name", value: initial, maxlength: 80, "data-autofocus": "" });
    const submit = () => {
      const v = input.value.trim();
      if (!v) return dialog.error("Give it a name.");
      result = v;
      dialog.close();
    };
    const dialog = openDialog({
      title, icon: "template", body: [h("label", { class: "mo-name-label" }, "Name", input)],
      foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), h("button", { class: "btn primary", type: "button", onclick: submit }, action)],
      submit, onClose: () => done(result),
    });
    requestAnimationFrame(() => input.select());
  });
}

export class MyTemplates {
  constructor(private tools: MotionTools) {}

  list(): SavedTemplate[] {
    return this.tools.settings().mine;
  }

  /** Saves a clip to My Templates under a name the user gives. */
  async saveClip(id: string) {
    const c = this.tools.clip(id);
    const template = c && templateOf(c);
    if (!c || !template) return;
    const s = this.tools.settings();
    if (s.mine.length >= MAX_MINE) {
      this.tools.host.toast(`My Templates is full (${MAX_MINE}). Delete one to save another.`);
      return;
    }
    const name = await askName("Save to My Templates", c.name === template.name ? `My ${template.name}` : c.name, "Save");
    if (!name) return;
    const sid = `mine-${uid()}`;
    const pictures: Record<string, string> = {};
    try {
      const p = this.tools.host.project();
      for (const [field, mediaId] of Object.entries(c.slots)) {
        const m = mediaOf(p, mediaId);
        if (!m || m.missing) continue;
        pictures[field] = await storeAsset(sid, `${field}.${extOf(m.path)}`, await readBytes(m.path));
      }
    } catch (err) {
      await deleteAssets(sid).catch(() => undefined);
      this.tools.host.toast(`It couldn't be saved: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const doc: Template = { ...structuredClone(template), id: sid, name };
    s.mine.unshift({ id: sid, name, saved: Date.now(), doc, values: { ...c.values }, theme: structuredClone(c.theme), pictures });
    this.tools.saveSettings();
    this.tools.edit(id, "mine-name", (x) => (x.name = name));
    this.tools.host.refreshPanel();
    this.tools.host.toast(`Saved "${name}" to My Templates.`);
  }

  async use(entry: SavedTemplate) {
    const slots: Record<string, Media> = {};
    for (const [field, path] of Object.entries(entry.pictures)) {
      const m = await this.tools.slotMedia(path).catch(() => null);
      if (m) slots[field] = m;
    }
    await this.tools.use({ ...entry.doc, name: entry.name }, { values: entry.values, theme: entry.theme, slots });
  }

  async rename(entry: SavedTemplate) {
    const name = await askName("Rename Template", entry.name, "Rename");
    if (!name) return;
    const e = this.list().find((x) => x.id === entry.id);
    if (!e) return;
    e.name = name;
    e.doc.name = name;
    this.tools.saveSettings();
    this.tools.host.refreshPanel();
  }

  async remove(entry: SavedTemplate) {
    const s = this.tools.settings();
    s.mine = s.mine.filter((x) => x.id !== entry.id);
    this.tools.saveSettings();
    this.tools.host.refreshPanel();
    // Clips already using it keep their own copy of the template and pictures in the project.
    await deleteAssets(entry.id).catch(() => undefined);
    this.tools.host.toast(`Deleted "${entry.name}".`);
  }

  // ---- packages

  /** Writes a saved template as a `.zaztemplate`. */
  async exportEntry(entry: SavedTemplate) {
    await this.writePackage(entry.name, entry.doc, entry.values, entry.theme, entry.pictures);
  }

  /** Writes a clip on the timeline as a `.zaztemplate`. */
  async exportClip(id: string) {
    const c = this.tools.clip(id);
    const template = c && templateOf(c);
    if (!c || !template) return;
    const p = this.tools.host.project();
    const pictures: Record<string, string> = {};
    for (const [field, mediaId] of Object.entries(c.slots)) {
      const m = mediaOf(p, mediaId);
      if (m && !m.missing) pictures[field] = m.path;
    }
    await this.writePackage(c.name, { ...template, id: template.id.startsWith("mine-") ? template.id : `mine-${template.id}` }, c.values, c.theme, pictures);
  }

  private async writePackage(name: string, template: Template, values: Record<string, string>, theme: SavedTemplate["theme"], pictures: Record<string, string>) {
    const path = await save({ title: "Export Motion Template", defaultPath: `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Template"}.zaztemplate`, filters: [PACKAGE_FILTER] }).catch(() => null);
    if (!path) return;
    try {
      const assets: [string, Uint8Array][] = [];
      const names: Record<string, string> = {};
      for (const [field, file] of Object.entries(pictures)) {
        const asset = `${field}.${extOf(file)}`;
        assets.push([asset, await readBytes(file)]);
        names[field] = asset;
      }
      const look = structuredClone(theme);
      if (look.logo) {
        const asset = `kit-logo.${extOf(look.logo)}`;
        assets.push([asset, await readBytes(look.logo)]);
        names.logo = asset;
        look.logo = null;
      }
      const doc: PackageDoc = { app: "zaztemplate", version: FORMAT_VERSION, name, template, values, theme: look, assets: names };
      await packTemplate(path, doc, assets);
      this.tools.host.toast(`Exported "${name}".`);
    } catch (err) {
      this.tools.host.toast(`The template couldn't be exported: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Reads `.zaztemplate` files into My Templates. */
  async importFiles() {
    const picked = await open({ title: "Import Motion Templates", multiple: true, filters: [PACKAGE_FILTER] }).catch(() => null);
    if (!picked?.length) return;
    const s = this.tools.settings();
    let added = 0;
    const problems: string[] = [];
    for (const path of picked) {
      if (s.mine.length >= MAX_MINE) break;
      const sid = `mine-${uid()}`;
      try {
        const { doc, assets } = await unpackTemplate(path);
        const pkg = normalizePackage(doc);
        if (!pkg) throw new Error("it isn't a motion template");
        const pictures: Record<string, string> = {};
        const theme = pkg.theme;
        for (const [field, asset] of Object.entries(pkg.assets)) {
          const bytes = assets.get(asset);
          if (!bytes) continue;
          const stored = await storeAsset(sid, asset, bytes);
          if (field === "logo") theme.logo = stored;
          else pictures[field] = stored;
        }
        const name = pkg.name;
        s.mine.unshift({ id: sid, name, saved: Date.now(), doc: { ...pkg.template, id: sid, name }, values: pkg.values, theme, pictures });
        added++;
      } catch (err) {
        await deleteAssets(sid).catch(() => undefined);
        problems.push(`${path.split(/[\\/]/).pop()}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (added) {
      this.tools.saveSettings();
      this.tools.host.refreshPanel();
    }
    this.tools.host.toast(problems.length ? `Couldn't import ${problems[0]}` : `Imported ${added} template${added === 1 ? "" : "s"} into My Templates.`);
  }
}
