import { previewUrl } from "../../../../api";
import { basename, h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { MenuItem } from "../../../../ui/menu";
import {
  callout, mini, menuAt, row, section, segRow, selectRow, sliderRow, textField, well, type Syncs,
} from "../controls";
import { mediaOf } from "../model";
import { COLOR_KEYS, OWN_LOOK, overrideTheme, type Colors, type FontRef, type ThemeKey } from "./brand";
import { fieldValue, type Field, type Template, type TemplateClip } from "./format";
import { BUNDLED, FONT_KINDS, PAIRINGS, loadFamily, weightFor } from "./fonts";
import { allKits, defaultKit } from "./settings";
import { templateOf } from "./templates";
import type { MotionTools } from "./tools";

/**
 * The inspector for a template clip, in the editor's controls (controls.ts): the Content tab
 * (texts, choices, pictures with Cut out product), the Look tab (Brand Kit, colours, fonts,
 * roundness, motion feel, each remembered as changed by hand) and the header's ⋯ menu (sounds,
 * Ungroup, poster, My Templates). The inspector adds Transform and Transitions after Content.
 */

export interface TemplateActions {
  openKits(): void;
  saveToMine(id: string): void;
  exportPackage(id: string): void;
}

const COLOR_LABELS: Record<keyof Colors, string> = { primary: "Primary", secondary: "Secondary", accent: "Accent", background: "Background", text: "Text" };

const clipAndTemplate = (tools: MotionTools, id: string) => {
  const first = tools.clip(id);
  const template = first && templateOf(first);
  return first && template ? { first, template, c: () => tools.clip(id) ?? first } : null;
};

export function templateInfo(tools: MotionTools, id: string): { name: string; description: string } | null {
  const t = clipAndTemplate(tools, id);
  if (!t) return null;
  return { name: t.first.name, description: `${t.template.description} Making the clip longer lengthens its hold; the entrance and exit keep their timing.` };
}

/** The ⋯ menu: what can be done with the template. */
export function templateMenu(tools: MotionTools, actions: TemplateActions, id: string): MenuItem[] {
  const t = clipAndTemplate(tools, id);
  if (!t) return [];
  const items: MenuItem[] = [];
  if (t.template.hits?.length) items.push({ label: "Add Suggested Sounds", icon: "music", action: () => void tools.addSounds(id) });
  items.push(t.first.ungrouped
    ? { label: "Regroup", icon: "template", action: () => tools.regroup(id) }
    : { label: "Ungroup to Layers", icon: "phLayers", action: () => tools.ungroup(id) });
  items.push(
    "separator",
    { label: "Save as Poster…", icon: "image", action: () => void tools.poster(id) },
    { label: "Save to My Templates", icon: "star", action: () => actions.saveToMine(id) },
    { label: "Export .zaztemplate…", icon: "download", action: () => actions.exportPackage(id) },
    "separator",
    { label: "Brand Kits…", icon: "palette", action: () => actions.openKits() },
  );
  return items;
}

/** The Content tab: the template's texts, choices and pictures. */
export function templateContent(tools: MotionTools, id: string, syncs: Syncs): Node[] {
  const t = clipAndTemplate(tools, id);
  if (!t) return [callout("This template can't be shown.", "danger")];
  const { first, template, c } = t;
  const out: Node[] = [];
  if (first.ungrouped) out.push(callout("Ungrouped: its texts and pictures are clips of their own. Regroup (⋯) draws them in the template again."));
  out.push(contentSection(tools, template, id, c, syncs));
  return out;
}

function contentSection(tools: MotionTools, template: Template, id: string, c: () => TemplateClip, syncs: Syncs): HTMLElement {
  const rows: (Node | null)[] = [];
  const hasBangla = template.fields.some((f) => f.kind === "text" && f.bn !== undefined);
  for (const f of template.fields) {
    if (f.kind === "text") {
      rows.push(textField(syncs, f.label, {
        get: () => fieldValue(template, c().values, f.id), limit: f.limit, multiline: f.multiline, placeholder: f.en,
        set: (v) => tools.edit(id, `field-${f.id}`, (x) => (x.values[f.id] = v)),
      }));
    } else if (f.kind === "choice") {
      rows.push(selectRow(syncs, f.label, f.options ?? [], () => fieldValue(template, c().values, f.id), (v) => tools.edit(id, `field-${f.id}`, (x) => (x.values[f.id] = v))));
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
    rows.push(row("Sample text", h("div", { class: "vc-buttons tight" },
      h("button", { class: "btn small", type: "button", onclick: () => sample(false) }, "English"),
      h("button", { class: "btn small", type: "button", onclick: () => sample(true) }, "বাংলা"))));
  }
  return section(syncs, { id: "template:content", title: "Content", summary: () => `${template.fields.length} field${template.fields.length === 1 ? "" : "s"}` }, ...rows);
}

/** A picture slot: a thumbnail, its file and Choose…, with Clear and Cut out product under ⋯. */
function slotRow(tools: MotionTools, f: Field, id: string, c: () => TemplateClip, syncs: Syncs): HTMLElement {
  const name = h("span", { class: "vc-slot-name" });
  const thumb = h("span", { class: "vc-slot-thumb" }, icon("image", 16));
  let shown = "";
  const show = () => {
    const x = c();
    const m = x.slots[f.id] ? mediaOf(tools.host.project(), x.slots[f.id]) : undefined;
    const path = m && !m.missing ? m.path : f.bind === "logo" && x.theme.logo ? x.theme.logo : "";
    if (m) name.textContent = m.missing ? `${m.name} (missing)` : m.name;
    else if (f.bind === "logo" && x.theme.logo) name.textContent = `${basename(x.theme.logo)} (Brand Kit)`;
    else name.textContent = "Empty";
    name.classList.toggle("empty", !m && !(f.bind === "logo" && x.theme.logo));
    name.title = m?.path ?? "";
    if (path !== shown) {
      shown = path;
      thumb.replaceChildren(path && !/\.svg$/i.test(path) ? h("img", { src: previewUrl(path, 0, 96), alt: "", draggable: "false" }) : icon("image", 16));
    }
  };
  show();
  syncs.push(show);
  const more: MenuItem[] = [
    { label: "Clear", icon: "close", action: () => tools.clearSlot(id, f.id) },
    ...(f.product ? [{ label: "Cut Out Product", icon: "phSubject", action: () => void tools.cutOut(id, f.id) } as MenuItem] : []),
  ];
  // Labelled above, as the text fields are: a slot's label can be long ("Product photo").
  return h("div", { class: "vc-field-block" }, h("div", { class: "vc-field-head" }, h("span", null, f.label)),
    h("div", { class: "vc-slot-pick" }, thumb, name,
      h("button", { class: "btn small", type: "button", onclick: () => void tools.chooseSlot(id, f.id) }, "Choose…"),
      mini("more", `${f.label} options`, (e) => menuAt(e.currentTarget as HTMLElement, more))));
}

/** The Look tab: Brand Kit, colours, fonts and style. */
export function templateLook(tools: MotionTools, actions: TemplateActions, id: string, syncs: Syncs): Node[] {
  const t = clipAndTemplate(tools, id);
  if (!t) return [];
  const { c } = t;
  const s = tools.settings();
  const changed = (key: ThemeKey) => c().overrides.includes(key);
  const override = (key: ThemeKey, fn: (x: TemplateClip) => void) => tools.edit(id, `theme-${key}`, (x) => overrideTheme(x, key, () => fn(x)));
  const known = (kit: string | null) => kit === OWN_LOOK || allKits(s).some((k) => k.id === kit);
  const kits = () => [[OWN_LOOK, "Template's own look"] as [string, string], ...allKits(s).map((k) => [k.id, k.name] as [string, string]), ...(known(c().kit) ? [] : [["", "Custom"] as [string, string]])];
  const kitName = () => kits().find(([v]) => v === (c().kit ?? ""))?.[1] ?? "Custom";
  const families: [string, string][] = FONT_KINDS.flatMap(([kind, label]) => BUNDLED.filter((b) => b.kind === kind).map((b) => [b.family, `${b.family} · ${label}`] as [string, string]));
  const withCurrent = (ref: () => FontRef) => (families.some(([f]) => f === ref().family) ? families : [[ref().family, ref().family] as [string, string], ...families]);
  const font = (key: "heading" | "body" | "bangla", label: string, list: [string, string][]) => selectRow(syncs, label, list, () => c().theme[key].family, (v) => {
    void loadFamily(v);
    override(key, (x) => (x.theme[key] = { family: v, weight: weightFor(v, x.theme[key].weight) }));
  });
  const pairing = selectRow(syncs, "Pairing", [["", "Custom"], ...PAIRINGS.map((p) => [p.id, p.label.split(":")[0]] as [string, string])],
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
  const anyChanged = () => c().overrides.length > 0;
  const colourKeys = COLOR_KEYS;
  return [
    section(syncs, {
      id: "template:kit", title: "Brand Kit", summary: kitName,
      modified: anyChanged,
      reset: () => tools.resetToKit(id),
      menu: () => [
        { label: "Reset to Kit", icon: "undo", disabled: !anyChanged(), action: () => tools.resetToKit(id) },
        { label: "Use on All Templates", icon: "template", action: () => {
          if (c().kit === OWN_LOOK) return tools.applyOwnLookEverywhere();
          const kit = allKits(s).find((k) => k.id === c().kit) ?? defaultKit(s);
          tools.applyKitEverywhere(kit);
        } },
        "separator",
        { label: "Brand Kits…", icon: "palette", action: () => actions.openKits() },
      ],
    }, selectRow(syncs, "Kit", kits(), () => c().kit ?? "", (v) => {
      const kit = allKits(s).find((k) => k.id === v);
      if (v === OWN_LOOK) tools.applyOwnLook(id);
      else if (kit) tools.applyKit(id, kit);
    })),
    section(syncs, {
      id: "template:colours", title: "Colours",
      summary: () => (colourKeys.some(changed) ? "Changed" : kitName()),
      modified: () => colourKeys.some(changed),
    }, row(null, h("div", { class: "vc-wells" }, ...colourKeys.map((k) => h("div", { class: "vc-well-item" }, well(syncs, COLOR_LABELS[k], {
      get: () => c().theme.colors[k], set: (v) => v && override(k, (x) => (x.theme.colors[k] = v)), fallback: "#ffffff", changed: () => changed(k),
    }), h("span", null, COLOR_LABELS[k])))), { cls: "full" })),
    section(syncs, {
      id: "template:fonts", title: "Fonts", summary: () => `${c().theme.heading.family} + ${c().theme.body.family}`,
      modified: () => (["heading", "body", "bangla"] as ThemeKey[]).some(changed),
    },
    pairing,
    font("heading", "Headings", withCurrent(() => c().theme.heading)),
    font("body", "Body", withCurrent(() => c().theme.body)),
    font("bangla", "Bangla", families.filter(([f]) => BUNDLED.find((b) => b.family === f)?.bangla)),
    ),
    section(syncs, {
      id: "template:style", title: "Style", summary: () => `${Math.round(c().theme.radius * 100)}% · ${c().theme.motion}`,
      modified: () => changed("radius") || changed("motion"),
    },
    sliderRow(syncs, "Roundness", {
      min: 0, max: 1, step: 0.05, scale: 100, decimals: 0, unit: "%", get: () => c().theme.radius, set: (v) => override("radius", (x) => (x.theme.radius = v)),
    }),
    segRow(syncs, "Motion", [["snappy", "Snappy"], ["smooth", "Smooth"], ["playful", "Playful"]] as const, () => c().theme.motion, (v) => override("motion", (x) => (x.theme.motion = v))),
    ),
  ];
}

