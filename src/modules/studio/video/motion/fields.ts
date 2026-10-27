import { basename, h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { mediaOf } from "../model";
import { COLOR_KEYS, overrideTheme, type Colors, type FontRef, type ThemeKey } from "./brand";
import { fieldValue, type Field, type Template, type TemplateClip } from "./format";
import { BUNDLED, FONT_KINDS, PAIRINGS, loadFamily, weightFor } from "./fonts";
import { allKits, defaultKit } from "./settings";
import { templateOf } from "./templates";
import type { MotionTools } from "./tools";
import { buttons, choice, color, note, section, select, slider, textField, type Syncs } from "./ui";

/**
 * The inspector for a template clip: its fields (texts, choices, pictures with Cut out product),
 * its look (Brand Kit, colours, fonts, roundness, motion feel, each remembered as changed by
 * hand) and what can be done with it (sounds, Ungroup, poster, My Templates). The inspector adds
 * its Position section after these.
 */

export interface TemplateActions {
  openKits(): void;
  saveToMine(id: string): void;
  exportPackage(id: string): void;
}

const COLOR_LABELS: Record<keyof Colors, string> = { primary: "Primary", secondary: "Secondary", accent: "Accent", background: "Background", text: "Text" };

export function templateView(tools: MotionTools, actions: TemplateActions, id: string, syncs: Syncs): Node[] {
  const first = tools.clip(id);
  const template = first && templateOf(first);
  if (!first || !template) return [note("This template can't be shown.", true)];
  const c = () => tools.clip(id) ?? first;
  const out: Node[] = [h("header", { class: "ve-inspector-head" }, icon("template", 16), h("span", null, first.name))];
  if (first.ungrouped) out.push(note("Ungrouped: its texts and pictures are clips of their own. Regroup draws them in the template again."));
  out.push(contentSection(tools, template, id, c, syncs));
  out.push(lookSection(tools, actions, id, c, syncs));
  out.push(section("Template",
    note(`${template.description} Making the clip longer lengthens its hold; the entrance and exit keep their timing.`),
    buttons(
      template.hits?.length ? ["Add suggested sounds", () => void tools.addSounds(id)] : null,
      first.ungrouped ? ["Regroup", () => tools.regroup(id)] : ["Ungroup to layers", () => tools.ungroup(id)],
    ),
    buttons(
      ["Save as Poster", () => void tools.poster(id)],
      ["Save to My Templates", () => actions.saveToMine(id)],
      ["Export .zaztemplate", () => actions.exportPackage(id)],
    ),
  ));
  return out;
}

function contentSection(tools: MotionTools, template: Template, id: string, c: () => TemplateClip, syncs: Syncs): HTMLElement {
  const rows: Node[] = [];
  const hasBangla = template.fields.some((f) => f.kind === "text" && f.bn !== undefined);
  for (const f of template.fields) {
    if (f.kind === "text") {
      rows.push(textField(syncs, f.label, {
        get: () => fieldValue(template, c().values, f.id), limit: f.limit, multiline: f.multiline, placeholder: f.en,
        set: (v) => tools.edit(id, `field-${f.id}`, (x) => (x.values[f.id] = v)),
      }));
    } else if (f.kind === "choice") {
      rows.push(select(syncs, f.label, f.options ?? [], () => fieldValue(template, c().values, f.id), (v) => tools.edit(id, `field-${f.id}`, (x) => (x.values[f.id] = v))));
    } else rows.push(slotRow(tools, f, id, c, syncs));
  }
  if (hasBangla) {
    // Fills in the sample text in the other language, keeping texts the user wrote.
    const sample = (bangla: boolean) => tools.edit(id, "sample-language", (x) => {
      for (const f of template.fields) {
        if (f.kind !== "text" || f.bn === undefined) continue;
        const now = x.values[f.id];
        if (now === undefined || now === f.en || now === f.bn) x.values[f.id] = bangla ? f.bn : f.en;
      }
    });
    rows.push(buttons(["Sample text in English", () => sample(false)], ["বাংলায় নমুনা লেখা", () => sample(true)]));
  }
  return section("Content", ...rows);
}

function slotRow(tools: MotionTools, f: Field, id: string, c: () => TemplateClip, syncs: Syncs): HTMLElement {
  const name = h("span", { class: "mo-slot-name" });
  const show = () => {
    const x = c();
    const m = x.slots[f.id] ? mediaOf(tools.host.project(), x.slots[f.id]) : undefined;
    if (m) name.textContent = m.missing ? `${m.name} (missing)` : m.name;
    else if (f.bind === "logo" && x.theme.logo) name.textContent = `${basename(x.theme.logo)} (Brand Kit)`;
    else name.textContent = "Empty";
    name.title = m?.path ?? "";
  };
  show();
  syncs.push(show);
  return h("div", { class: "mo-slot" },
    h("div", { class: "ve-row" }, h("label", null, f.label), name),
    buttons(
      ["Choose…", () => void tools.chooseSlot(id, f.id)],
      ["Clear", () => tools.clearSlot(id, f.id)],
      f.product ? ["Cut out product", () => void tools.cutOut(id, f.id)] : null,
    ),
  );
}

function lookSection(tools: MotionTools, actions: TemplateActions, id: string, c: () => TemplateClip, syncs: Syncs): HTMLElement {
  const s = tools.settings();
  const changed = (key: ThemeKey) => c().overrides.includes(key);
  const override = (key: ThemeKey, fn: (x: TemplateClip) => void) => tools.edit(id, `theme-${key}`, (x) => overrideTheme(x, key, () => fn(x)));
  const kits = () => [...allKits(s).map((k) => [k.id, k.name] as [string, string]), ...(c().kit && allKits(s).some((k) => k.id === c().kit) ? [] : [["", "Custom"] as [string, string]])];
  const kitSelect = select(syncs, "Brand Kit", kits(), () => c().kit ?? "", (v) => {
    const kit = allKits(s).find((k) => k.id === v);
    if (kit) tools.applyKit(id, kit);
  });
  const families: [string, string][] = FONT_KINDS.flatMap(([kind, label]) => BUNDLED.filter((b) => b.kind === kind).map((b) => [b.family, `${b.family} · ${label}`] as [string, string]));
  const withCurrent = (ref: () => FontRef) => (families.some(([f]) => f === ref().family) ? families : [[ref().family, ref().family] as [string, string], ...families]);
  const font = (key: "heading" | "body" | "bangla", label: string, list: [string, string][]) => select(syncs, label, list, () => c().theme[key].family, (v) => {
    void loadFamily(v);
    override(key, (x) => (x.theme[key] = { family: v, weight: weightFor(v, x.theme[key].weight) }));
  });
  const pairing = select(syncs, "Pairing", [["", "Custom"], ...PAIRINGS.map((p) => [p.id, p.label.split(":")[0]] as [string, string])],
    () => PAIRINGS.find((p) => p.heading[0] === c().theme.heading.family && p.body[0] === c().theme.body.family)?.id ?? "",
    (v) => {
      const p = PAIRINGS.find((x) => x.id === v);
      if (!p) return;
      for (const f of [p.heading[0], p.body[0], p.bangla[0]]) void loadFamily(f);
      tools.edit(id, "theme-pairing", (x) => {
        overrideTheme(x, "heading", (t) => (t.heading = { family: p.heading[0], weight: p.heading[1] }));
        overrideTheme(x, "body", (t) => (t.body = { family: p.body[0], weight: p.body[1] }));
        overrideTheme(x, "bangla", (t) => (t.bangla = { family: p.bangla[0], weight: p.bangla[1] }));
      });
    });
  return section("Look",
    kitSelect,
    buttons(
      ["Reset to kit", () => tools.resetToKit(id)],
      ["Brand Kits…", () => actions.openKits()],
      ["Use on all templates", () => {
        const kit = allKits(s).find((k) => k.id === c().kit) ?? defaultKit(s);
        tools.applyKitEverywhere(kit);
      }],
    ),
    ...COLOR_KEYS.map((k) => color(syncs, COLOR_LABELS[k], () => c().theme.colors[k], (v) => override(k, (x) => (x.theme.colors[k] = v)), () => changed(k))),
    pairing,
    font("heading", "Headings", withCurrent(() => c().theme.heading)),
    font("body", "Body", withCurrent(() => c().theme.body)),
    font("bangla", "Bangla", families.filter(([f]) => BUNDLED.find((b) => b.family === f)?.bangla)),
    slider(syncs, "Roundness", { min: 0, max: 1, step: 0.05, get: () => c().theme.radius, set: (v) => override("radius", (x) => (x.theme.radius = v)), format: (v) => `${Math.round(v * 100)}%` }),
    choice(syncs, "Motion", [["snappy", "Snappy"], ["smooth", "Smooth"], ["playful", "Playful"]] as const, () => c().theme.motion, (v) => override("motion", (x) => (x.theme.motion = v))),
  );
}
