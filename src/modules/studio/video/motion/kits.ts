import { open, save } from "../../../../shared/dialog";
import { basename, h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { openDialog } from "../../../time/dialog";
import { photoApi } from "../../photo/api";
import { uid } from "../model";
import { COLOR_KEYS, luminance, paletteFromPixels, themeOf, type BrandKit, type Colors } from "./brand";
import { readKitText, readSvg, writeKitText } from "./files";
import { BUNDLED, FONT_KINDS, PAIRINGS, loadFamily, weightFor } from "./fonts";
import { MAX_KITS, allKits, kitFile, readKitFile } from "./settings";
import { SLOT_EXTENSIONS, type MotionTools } from "./tools";

/**
 * Brand Kits: the built-in kits and the user's (colours, fonts, logo, roundness, motion feel).
 * Make one (from scratch, a copy, or colours picked from a logo), set the default new templates
 * get, apply one to the selected template or to all, and pass kits around as `.zazkit` files.
 */

const KIT_FILTER = { name: "Zazabor Brand Kit", extensions: ["zazkit"] };
const COLOR_LABELS: Record<keyof Colors, string> = { primary: "Primary", secondary: "Secondary", accent: "Accent", background: "Background", text: "Text" };

export interface KitsContext {
  /** The selected template clip, to apply a kit to. */
  selected(): string | null;
}

export function openKits(tools: MotionTools, ctx: KitsContext) {
  const s = tools.settings();
  const body = h("div", { class: "mo-kits" });
  const foot = h("div", { class: "mo-kits-foot" });
  const dialog = openDialog({ title: "Brand Kits", subtitle: "Colours, fonts and a logo, applied to every template.", icon: "palette", class: "mo-kits-dialog", body: [body], foot: [foot] });
  const persist = () => {
    tools.saveSettings();
    tools.host.refreshPanel();
  };

  const list = () => {
    dialog.error("");
    const rows = allKits(s).map((kit) => {
      const isDefault = s.defaultKit === kit.id;
      const selected = ctx.selected();
      return h("div", { class: `mo-kit${isDefault ? " default" : ""}` },
        swatches(kit),
        h("div", { class: "mo-kit-text" },
          h("strong", null, kit.name, isDefault ? h("span", { class: "mo-kit-badge" }, "Default") : null),
          h("span", null, `${kit.heading.family} + ${kit.body.family} · ${kit.bangla.family}${kit.logo ? ` · ${basename(kit.logo)}` : ""}`)),
        h("div", { class: "mo-kit-actions" },
          selected ? h("button", { class: "btn small", type: "button", title: "Apply to the selected template", onclick: () => tools.applyKit(selected, kit) }, "Apply") : null,
          h("button", { class: "btn small", type: "button", title: "Apply to every template in this project", onclick: () => tools.applyKitEverywhere(kit) }, "All"),
          h("button", { class: "icon-btn small", type: "button", title: isDefault ? "New templates get this kit" : "Use for new templates", disabled: isDefault, onclick: () => {
            s.defaultKit = kit.id;
            persist();
            list();
          } }, icon(isDefault ? "starFilled" : "star", 15)),
          h("button", { class: "icon-btn small", type: "button", title: kit.builtIn ? "Copy to edit" : "Edit", onclick: () => edit(kit.builtIn ? { ...themeOf(kit), id: uid(), name: `${kit.name} copy` } : kit, !!kit.builtIn) }, icon(kit.builtIn ? "copy" : "pencil", 15)),
          h("button", { class: "icon-btn small", type: "button", title: "Export .zazkit", onclick: () => void exportKit(kit) }, icon("download", 15)),
          kit.builtIn ? null : h("button", { class: "icon-btn small", type: "button", title: "Delete", onclick: () => {
            s.kits = s.kits.filter((k) => k.id !== kit.id);
            if (s.defaultKit === kit.id) s.defaultKit = allKits(s)[0].id;
            persist();
            list();
          } }, icon("trash", 15))));
    });
    body.replaceChildren(...rows);
    foot.replaceChildren(
      h("button", { class: "btn", type: "button", onclick: () => edit({ ...themeOf(allKits(s)[0]), id: uid(), name: "My brand" }, true) }, icon("plus", 14), "New kit"),
      h("button", { class: "btn", type: "button", onclick: () => void importKits() }, "Import .zazkit"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn primary", type: "button", onclick: () => dialog.close() }, "Done"),
    );
  };

  const edit = (start: BrandKit, isNew: boolean) => {
    if (isNew && s.kits.length >= MAX_KITS) {
      dialog.error(`You can keep up to ${MAX_KITS} kits.`);
      return;
    }
    const kit: BrandKit = structuredClone(start);
    delete kit.builtIn;
    const name = h("input", { type: "text", value: kit.name, maxlength: 60, class: "mo-text" });
    const colors = COLOR_KEYS.map((k) => {
      const input = h("input", { type: "color", value: kit.colors[k], oninput: () => {
        kit.colors[k] = input.value;
        preview();
      } });
      return [k, input] as const;
    });
    const sw = h("div", { class: "mo-kit-preview" });
    const preview = () => sw.replaceChildren(swatches(kit), h("span", { style: `font-family: "${kit.heading.family}"; font-weight: ${kit.heading.weight}` }, kit.name || "Brand"));
    const families = FONT_KINDS.flatMap(([kind, label]) => BUNDLED.filter((b) => b.kind === kind).map((b) => [b.family, `${b.family} · ${label}`] as const));
    const fontSelect = (key: "heading" | "body" | "bangla", only?: (f: string) => boolean) => {
      const el = h("select", { onchange: () => {
        kit[key] = { family: el.value, weight: weightFor(el.value, kit[key].weight) };
        void loadFamily(el.value).then(preview);
      } }, ...families.filter(([f]) => !only || only(f)).map(([f, l]) => h("option", { value: f }, l)));
      if (![...el.options].some((o) => o.value === kit[key].family)) el.prepend(h("option", { value: kit[key].family }, kit[key].family));
      el.value = kit[key].family;
      return el;
    };
    const heading = fontSelect("heading"), bodyFont = fontSelect("body"), bangla = fontSelect("bangla", (f) => !!BUNDLED.find((b) => b.family === f)?.bangla);
    const pairing = h("select", { onchange: () => {
      const p = PAIRINGS.find((x) => x.id === pairing.value);
      if (!p) return;
      kit.heading = { family: p.heading[0], weight: p.heading[1] };
      kit.body = { family: p.body[0], weight: p.body[1] };
      kit.bangla = { family: p.bangla[0], weight: p.bangla[1] };
      heading.value = p.heading[0];
      bodyFont.value = p.body[0];
      bangla.value = p.bangla[0];
      for (const f of [p.heading[0], p.body[0], p.bangla[0]]) void loadFamily(f);
      void loadFamily(p.heading[0]).then(preview);
    } }, h("option", { value: "" }, "Choose a pairing…"), ...PAIRINGS.map((p) => h("option", { value: p.id }, p.label)));
    const radius = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(kit.radius), oninput: () => (kit.radius = Number(radius.value)) });
    const motion = h("select", { onchange: () => (kit.motion = motion.value as BrandKit["motion"]) },
      h("option", { value: "snappy" }, "Snappy"), h("option", { value: "smooth" }, "Smooth"), h("option", { value: "playful" }, "Playful"));
    motion.value = kit.motion;
    const logoName = h("span", { class: "mo-slot-name" }, kit.logo ? basename(kit.logo) : "None");
    const chooseLogo = async () => {
      const path = await open({ title: "Choose a Logo", filters: [{ name: "Pictures", extensions: SLOT_EXTENSIONS }] }).catch(() => null);
      if (!path) return;
      kit.logo = path;
      logoName.textContent = basename(path);
    };
    const fromLogo = async () => {
      if (!kit.logo) return dialog.error("Choose a logo first.");
      try {
        const pixels = await logoPixels(kit.logo);
        const picked = paletteFromPixels(pixels, luminance(kit.colors.background) < 0.4);
        kit.colors = picked;
        for (const [k, input] of colors) input.value = picked[k];
        preview();
        dialog.error("");
      } catch (err) {
        dialog.error(`The logo couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const row = (label: string, ...nodes: Node[]) => h("div", { class: "ve-row" }, h("label", null, label), ...nodes);
    preview();
    body.replaceChildren(
      sw,
      row("Name", name),
      h("div", { class: "mo-kit-colors" }, ...colors.map(([k, input]) => h("label", null, input, COLOR_LABELS[k]))),
      row("Logo", logoName, h("button", { class: "btn small", type: "button", onclick: () => void chooseLogo() }, "Choose…"),
        h("button", { class: "btn small", type: "button", onclick: () => {
          kit.logo = null;
          logoName.textContent = "None";
        } }, "Clear"),
        h("button", { class: "btn small", type: "button", title: "Colours picked from the logo", onclick: () => void fromLogo() }, "Colours from logo")),
      row("Pairing", pairing),
      row("Headings", heading),
      row("Body", bodyFont),
      row("Bangla", bangla),
      row("Roundness", radius),
      row("Motion", motion),
    );
    foot.replaceChildren(
      h("button", { class: "btn", type: "button", onclick: list }, "Back"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn primary", type: "button", onclick: () => {
        kit.name = name.value.trim().slice(0, 60) || "Brand Kit";
        const at = s.kits.findIndex((k) => k.id === kit.id);
        if (at >= 0) s.kits[at] = kit;
        else s.kits.push(kit);
        persist();
        tools.kitChanged(kit);
        list();
      } }, "Save kit"),
    );
  };

  const exportKit = async (kit: BrandKit) => {
    const path = await save({ title: "Export Brand Kit", defaultPath: `${kit.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Brand Kit"}.zazkit`, filters: [KIT_FILTER] }).catch(() => null);
    if (!path) return;
    try {
      await writeKitText(path, JSON.stringify(kitFile(kit), null, 2));
      tools.host.toast(`Exported "${kit.name}".`);
    } catch (err) {
      dialog.error(`It couldn't be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const importKits = async () => {
    const picked = await open({ title: "Import Brand Kits", multiple: true, filters: [KIT_FILTER] }).catch(() => null);
    if (!picked?.length) return;
    let added = 0;
    for (const path of picked) {
      if (s.kits.length >= MAX_KITS) break;
      try {
        const kit = readKitFile(JSON.parse(await readKitText(path)), uid());
        if (kit) {
          s.kits.push(kit);
          added++;
        }
      } catch {
        // Not a kit: skipped, and said below.
      }
    }
    if (added) persist();
    list();
    if (added < picked.length) dialog.error(`${picked.length - added} file${picked.length - added === 1 ? " wasn't a Brand Kit" : "s weren't Brand Kits"}.`);
  };

  list();
}

function swatches(kit: BrandKit): HTMLElement {
  return h("span", { class: "mo-swatches", "aria-hidden": "true" }, ...COLOR_KEYS.map((k) => h("span", { style: `background: ${kit.colors[k]}` })));
}

/** A logo's pixels, small (for picking its colours). */
async function logoPixels(path: string): Promise<Uint8ClampedArray> {
  let img: HTMLImageElement | ImageBitmap;
  if (/\.svg$/i.test(path)) {
    const url = URL.createObjectURL(new Blob([await readSvg(path)], { type: "image/svg+xml" }));
    try {
      const el = new Image();
      el.src = url;
      await el.decode();
      img = el;
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    const pic = await photoApi.decode(path, 256);
    const data = new Uint8ClampedArray(pic.rgba.length);
    data.set(pic.rgba);
    img = await createImageBitmap(new ImageData(data, pic.width, pic.height));
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const g = canvas.getContext("2d")!;
  const w = "naturalWidth" in img ? img.naturalWidth : img.width, ht = "naturalHeight" in img ? img.naturalHeight : img.height;
  const k = Math.min(128 / Math.max(1, w), 128 / Math.max(1, ht));
  g.drawImage(img, 0, 0, Math.max(1, w * k), Math.max(1, ht * k));
  return g.getImageData(0, 0, 128, 128).data;
}
