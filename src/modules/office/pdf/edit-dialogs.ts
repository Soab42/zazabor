import { h } from "../../../ui/dom";
import { field, openDialog, textArea, textInput } from "../../time/dialog";
import { parseRange, rangeText } from "./dialogs";
import { rgbOf, type Bates, type Face, type Rgb } from "./tools";

/** Dialogs for the Edit and Protect tabs. Each resolves to null when cancelled. */

const FACES: { id: Face; label: string; css: string }[] = [
  { id: "helvetica", label: "Helvetica", css: "Helvetica, Arial, 'Liberation Sans', sans-serif" },
  { id: "helveticaBold", label: "Helvetica Bold", css: "bold Helvetica, Arial, 'Liberation Sans', sans-serif" },
  { id: "times", label: "Times", css: "'Times New Roman', Times, 'Liberation Serif', serif" },
  { id: "timesBold", label: "Times Bold", css: "bold 'Times New Roman', Times, 'Liberation Serif', serif" },
  { id: "courier", label: "Courier", css: "'Courier New', Courier, 'Liberation Mono', monospace" },
];

export function faceCss(face: Face): { family: string; bold: boolean } {
  const f = FACES.find((x) => x.id === face) ?? FACES[0];
  return { family: f.css.replace(/^bold /, ""), bold: f.css.startsWith("bold ") };
}

const SWATCHES = ["#000000", "#5c5c5c", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#8e4ec6"];

function select<T extends string>(options: { id: T; label: string }[], value: T, label: string): HTMLSelectElement {
  const el = h("select", { class: "tt-input pf-select", "aria-label": label }, ...options.map((o) => h("option", { value: o.id }, o.label)));
  el.value = value;
  return el;
}

/** A row of colour swatches; `value()` is the picked "#rrggbb". */
function swatches(initial: string) {
  let value = initial;
  const row = h("div", { class: "pf-swatches", role: "radiogroup", "aria-label": "Colour" });
  const draw = () => {
    for (const b of row.children) b.classList.toggle("active", (b as HTMLElement).dataset.color === value);
  };
  for (const c of SWATCHES) {
    row.append(h("button", {
      class: "pf-swatch", type: "button", "data-color": c, title: c, "aria-label": c, style: `--swatch: ${c}`,
      onclick: () => {
        value = c;
        draw();
      },
    }));
  }
  draw();
  return { el: row, value: () => value };
}

function numberInput(value: number, label: string, attrs: Record<string, unknown> = {}): HTMLInputElement {
  return textInput({ value: String(value), inputmode: "decimal", class: "tt-input pf-num", "aria-label": label, ...attrs });
}

/** Which pages: all, or a typed range. */
function pagesField(count: number, current: number) {
  const all = h("input", { type: "radio", name: `pf-pages-${Math.random()}`, checked: true });
  const some = h("input", { type: "radio", name: all.name });
  const range = textInput({ value: String(current + 1), class: "tt-input pf-range-input", "aria-label": "Pages" });
  range.addEventListener("focus", () => (some.checked = true));
  const el = h("div", { class: "pf-pages-choice" },
    h("label", { class: "pf-check" }, all, `All ${count} pages`),
    h("label", { class: "pf-check" }, some, "Pages", range));
  return {
    el,
    /** 1-based page numbers; [] for all; null when the range doesn't read. */
    value(): number[] | null {
      if (all.checked) return [];
      const pages = parseRange(range.value, count);
      return pages?.length ? [...new Set(pages)].sort((a, b) => a - b).map((p) => p + 1) : null;
    },
  };
}

function foot(dialog: () => { close(): void }, ok: () => void, label: string) {
  return [
    h("span", { class: "spacer" }),
    h("button", { class: "btn", type: "button", onclick: () => dialog().close() }, "Cancel"),
    h("button", { class: "btn primary", type: "button", onclick: ok }, label),
  ];
}

// ---- notes and text

export function noteDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const text = textArea({ rows: 5, "aria-label": "Note", "data-autofocus": "", placeholder: "Type your note" });
    const ok = () => {
      if (!text.value.trim()) return dialog.error("Type the note.");
      answer = text.value.trim();
      dialog.close();
    };
    const dialog = openDialog({
      title: "Add a Note",
      subtitle: "Shows as a note icon; its text opens on hover. Ctrl+Enter adds it.",
      icon: "comment",
      tone: "work",
      body: [text],
      foot: foot(() => dialog, ok, "Add Note"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

export interface TextChoice {
  text: string;
  face: Face;
  size: number;
  color: string;
}

let lastText: Omit<TextChoice, "text"> = { face: "helvetica", size: 12, color: "#000000" };

export function addTextDialog(): Promise<TextChoice | null> {
  return new Promise((resolve) => {
    let answer: TextChoice | null = null;
    const text = textArea({ rows: 4, "aria-label": "Text", "data-autofocus": "" });
    const face = select(FACES, lastText.face, "Font");
    const size = numberInput(lastText.size, "Size");
    const color = swatches(lastText.color);
    const ok = () => {
      const n = Number(size.value);
      if (!text.value.trim()) return dialog.error("Type the text.");
      if (!(n >= 4 && n <= 200)) return dialog.error("Type a size from 4 to 200 points.");
      lastText = { face: face.value as Face, size: n, color: color.value() };
      answer = { text: text.value.replace(/\s+$/, ""), ...lastText };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Add Text",
      subtitle: "Written into the page itself, where you clicked. Text the PDF fonts can't show (Bangla…) goes on as a picture.",
      icon: "pfAddText",
      tone: "work",
      body: [field("Text", text), h("div", { class: "pf-row" }, field("Font", face), field("Size", size, { note: "pt" })), field("Colour", color.el)],
      foot: foot(() => dialog, ok, "Add"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

// ---- watermark, header and footer

export interface WatermarkChoice {
  text: string | null;
  picture: string | null;
  face: Face;
  size: number;
  color: Rgb;
  opacity: number;
  rotation: number;
  scale: number;
  behind: boolean;
  pages: number[];
}

export function watermarkDialog(count: number, current: number, pickPicture: () => Promise<string | null>): Promise<WatermarkChoice | null> {
  return new Promise((resolve) => {
    let answer: WatermarkChoice | null = null;
    let picture: string | null = null;
    const asText = h("input", { type: "radio", name: "pf-wm-kind", checked: true });
    const asPicture = h("input", { type: "radio", name: "pf-wm-kind" });
    const text = textInput({ value: "CONFIDENTIAL", "aria-label": "Watermark text", "data-autofocus": "" });
    text.addEventListener("focus", () => (asText.checked = true));
    const pictureName = h("span", { class: "pf-file-name" }, "No picture chosen");
    const choose = h("button", {
      class: "btn small", type: "button",
      onclick: async () => {
        const p = await pickPicture();
        if (!p) return;
        picture = p;
        pictureName.textContent = p.replace(/^.*\//, "");
        asPicture.checked = true;
      },
    }, "Choose…");
    const face = select(FACES, "helveticaBold", "Font");
    const size = numberInput(72, "Size");
    const scale = numberInput(50, "Width of the page");
    const color = swatches("#e5484d");
    const opacity = h("input", { type: "range", min: "5", max: "100", step: "5", value: "30", "aria-label": "Opacity", class: "pf-range" });
    const opacityValue = h("span", { class: "pf-range-value" }, "30%");
    opacity.addEventListener("input", () => (opacityValue.textContent = `${opacity.value}%`));
    const rotation = select([{ id: "45", label: "45° (diagonal)" }, { id: "0", label: "Level" }, { id: "-45", label: "−45°" }, { id: "90", label: "90° (upright)" }], "45", "Rotation");
    const behind = h("input", { type: "checkbox" });
    const pages = pagesField(count, current);
    const ok = () => {
      const pageList = pages.value();
      if (!pageList) return dialog.error(`Type pages between 1 and ${count}, like 1-3, 5.`);
      if (asText.checked && !text.value.trim()) return dialog.error("Type the watermark's text.");
      if (asPicture.checked && !picture) return dialog.error("Choose a picture.");
      const n = Number(size.value), s = Number(scale.value);
      if (asText.checked && !(n >= 4 && n <= 600)) return dialog.error("Type a size from 4 to 600 points.");
      if (asPicture.checked && !(s >= 2 && s <= 200)) return dialog.error("Type a width from 2% to 200% of the page.");
      answer = {
        text: asText.checked ? text.value.trim() : null,
        picture: asPicture.checked ? picture : null,
        face: face.value as Face,
        size: n,
        color: rgbOf(color.value()),
        opacity: Number(opacity.value) / 100,
        rotation: Number(rotation.value),
        scale: s / 100,
        behind: behind.checked,
        pages: pageList,
      };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Add Watermark",
      subtitle: "Stamped into the pages, see-through, over (or under) what's there.",
      icon: "pfWatermark",
      tone: "work",
      class: "pf-wide",
      body: [
        h("label", { class: "pf-check" }, asText, "Text"),
        h("div", { class: "pf-indent" }, text, h("div", { class: "pf-row" }, field("Font", face), field("Size", size, { note: "pt" })), field("Colour", color.el)),
        h("label", { class: "pf-check" }, asPicture, "Picture"),
        h("div", { class: "pf-indent pf-row" }, choose, pictureName, field("Width", scale, { note: "% of the page" })),
        h("div", { class: "pf-row" }, field("Opacity", h("div", { class: "pf-range-row" }, opacity, opacityValue)), field("Rotation", rotation)),
        h("label", { class: "pf-check" }, behind, "Behind the page's content (hidden by pictures and filled areas)"),
        field("Pages", pages.el),
      ],
      foot: foot(() => dialog, ok, "Add Watermark"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

export interface HeaderFooterChoice {
  slots: string[];
  face: Face;
  size: number;
  color: Rgb;
  margin: number;
  bates: Bates | null;
  pages: number[];
}

export function headerFooterDialog(count: number, current: number, withBates: boolean): Promise<HeaderFooterChoice | null> {
  return new Promise((resolve) => {
    let answer: HeaderFooterChoice | null = null;
    const slot = (label: string, value = "") => textInput({ value, "aria-label": label, placeholder: "—" });
    const slots = [
      slot("Header left"), slot("Header centre"), slot("Header right"),
      slot("Footer left"), slot("Footer centre", withBates ? "" : "Page {page} of {pages}"), slot("Footer right", withBates ? "{bates}" : ""),
    ];
    let focused = slots[4];
    for (const s of slots) s.addEventListener("focus", () => (focused = s));
    const token = (t: string, label: string) => h("button", {
      class: "btn small", type: "button", title: `Insert ${label}`,
      onclick: () => {
        const at = focused.selectionStart ?? focused.value.length;
        focused.value = focused.value.slice(0, at) + t + focused.value.slice(focused.selectionEnd ?? at);
        focused.focus();
        focused.setSelectionRange(at + t.length, at + t.length);
      },
    }, label);
    const face = select(FACES, "helvetica", "Font");
    const size = numberInput(10, "Size");
    const margin = numberInput(0.5, "Margin");
    const color = swatches("#000000");
    const bates = h("input", { type: "checkbox", checked: withBates });
    const prefix = textInput({ value: "", "aria-label": "Prefix", placeholder: "Prefix", class: "tt-input pf-bates-input" });
    const start = numberInput(1, "Start at", { class: "tt-input pf-num" });
    const digits = numberInput(6, "Digits", { class: "tt-input pf-num" });
    const suffix = textInput({ value: "", "aria-label": "Suffix", placeholder: "Suffix", class: "tt-input pf-bates-input" });
    const pages = pagesField(count, current);
    const ok = () => {
      const pageList = pages.value();
      if (!pageList) return dialog.error(`Type pages between 1 and ${count}, like 1-3, 5.`);
      const values = slots.map((s) => s.value);
      if (values.every((v) => !v.trim())) return dialog.error("Type something for the header or footer.");
      const n = Number(size.value), m = Number(margin.value), st = Number(start.value), d = Number(digits.value);
      if (!(n >= 4 && n <= 72)) return dialog.error("Type a size from 4 to 72 points.");
      if (!(m >= 0 && m <= 3)) return dialog.error("Type a margin from 0 to 3 inches.");
      if (bates.checked && !(Number.isInteger(st) && st >= 0 && Number.isInteger(d) && d >= 1 && d <= 15)) return dialog.error("Bates numbers need a whole start number and 1 to 15 digits.");
      if (bates.checked && !values.some((v) => v.includes("{bates}"))) return dialog.error("Put {bates} in one of the boxes to show the Bates number.");
      answer = {
        slots: values,
        face: face.value as Face,
        size: n,
        color: rgbOf(color.value()),
        margin: m * 72,
        bates: bates.checked ? { prefix: prefix.value, suffix: suffix.value, start: st, digits: d } : null,
        pages: pageList,
      };
      dialog.close();
    };
    const dialog = openDialog({
      title: withBates ? "Bates Numbering" : "Header & Footer",
      subtitle: "Written into the pages. {page}, {pages}, {date}, {file} and {bates} are filled in on each page.",
      icon: withBates ? "pfBates" : "pfHeaderFooter",
      tone: "work",
      class: "pf-wide",
      body: [
        h("div", { class: "pf-slots" },
          h("span", { class: "pf-slots-label" }, "Header"), slots[0], slots[1], slots[2],
          h("span", { class: "pf-slots-label" }, "Footer"), slots[3], slots[4], slots[5]),
        h("div", { class: "pf-row pf-tokens" }, token("{page}", "Page"), token("{pages}", "Page Count"), token("{date}", "Date"), token("{file}", "File Name"), token("{bates}", "Bates Number")),
        h("div", { class: "pf-row" }, field("Font", face), field("Size", size, { note: "pt" }), field("Margin", margin, { note: "in" })),
        field("Colour", color.el),
        h("label", { class: "pf-check" }, bates, "Bates numbers: one per page, counting up"),
        h("div", { class: "pf-indent pf-row" }, prefix, field("Start", start), field("Digits", digits), suffix),
        field("Pages", pages.el),
      ],
      foot: foot(() => dialog, ok, "Add"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

// ---- protect

export interface ProtectChoice {
  open: string;
  owner: string;
  print: boolean;
  copy: boolean;
  edit: boolean;
  comment: boolean;
}

export function protectDialog(): Promise<ProtectChoice | null> {
  return new Promise((resolve) => {
    let answer: ProtectChoice | null = null;
    const pw = (label: string) => textInput({ type: "password", autocomplete: "new-password", "aria-label": label });
    const needOpen = h("input", { type: "checkbox", checked: true });
    const open = pw("Password to open"), open2 = pw("Confirm");
    const restrict = h("input", { type: "checkbox" });
    const owner = pw("Permissions password"), owner2 = pw("Confirm");
    const allow = (label: string, on = false) => {
      const c = h("input", { type: "checkbox", checked: on });
      return { c, el: h("label", { class: "pf-check" }, c, label) };
    };
    const print = allow("Printing", true), copy = allow("Copying text and pictures"), edit = allow("Changing pages"), comment = allow("Comments and filling in forms", true);
    const sync = () => {
      for (const i of [open, open2]) i.disabled = !needOpen.checked;
      for (const i of [owner, owner2, print.c, copy.c, edit.c, comment.c]) i.disabled = !restrict.checked;
    };
    needOpen.addEventListener("change", sync);
    restrict.addEventListener("change", sync);
    sync();
    const ok = () => {
      if (!needOpen.checked && !restrict.checked) return dialog.error("Choose a password to open the file, or restrictions.");
      if (needOpen.checked) {
        if (!open.value) return dialog.error("Type the password that opens the file.");
        if (open.value !== open2.value) return dialog.error("The passwords to open the file don't match.");
      }
      if (restrict.checked) {
        if (!owner.value) return dialog.error("Type a permissions password.");
        if (owner.value !== owner2.value) return dialog.error("The permissions passwords don't match.");
        if (needOpen.checked && owner.value === open.value) return dialog.error("The permissions password must be different from the one that opens the file.");
      }
      const r = restrict.checked;
      answer = {
        open: needOpen.checked ? open.value : "",
        owner: r ? owner.value : "",
        print: !r || print.c.checked,
        copy: !r || copy.c.checked,
        edit: !r || edit.c.checked,
        comment: !r || comment.c.checked,
      };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Protect with a Password",
      subtitle: "AES-256 encryption. Keep the passwords somewhere safe: CorePro can't open the file without them.",
      icon: "lock",
      tone: "work",
      class: "pf-wide",
      body: [
        h("label", { class: "pf-check" }, needOpen, "Require a password to open the file"),
        h("div", { class: "pf-indent pf-row" }, field("Password", open), field("Confirm", open2)),
        h("label", { class: "pf-check" }, restrict, "Restrict printing and changes"),
        h("div", { class: "pf-indent" }, h("div", { class: "pf-row" }, field("Permissions password", owner), field("Confirm", owner2)),
          h("p", { class: "tt-dialog-text pf-note" }, "Allow:"), print.el, copy.el, edit.el, comment.el,
          h("p", { class: "tt-dialog-text pf-note" }, "Not every PDF app respects restrictions; only the password to open the file truly protects it.")),
      ],
      foot: foot(() => dialog, ok, "Protect"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

/** The permissions password, to remove a file's security; "" when it isn't needed. */
export function unprotectDialog(needsOwner: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;
    const owner = textInput({ type: "password", autocomplete: "off", "aria-label": "Permissions password", "data-autofocus": "" });
    const ok = () => {
      if (needsOwner && !owner.value) return dialog.error("Type the permissions password.");
      answer = owner.value;
      dialog.close();
    };
    const dialog = openDialog({
      title: "Remove Security",
      subtitle: needsOwner
        ? "This file restricts printing or changes. Its permissions password is needed to remove the protection."
        : "The file will open without a password and with no restrictions.",
      icon: "lock",
      tone: "work",
      class: "tt-confirm",
      body: needsOwner ? [field("Permissions password", owner)] : [],
      foot: foot(() => dialog, ok, "Remove"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

// ---- hidden information, redaction, compression

export interface SanitizeChoice {
  metadata: boolean;
  attachments: boolean;
  scripts: boolean;
  comments: boolean;
}

export function sanitizeDialog(): Promise<SanitizeChoice | null> {
  return new Promise((resolve) => {
    let answer: SanitizeChoice | null = null;
    const box = (label: string, on = true) => {
      const c = h("input", { type: "checkbox", checked: on });
      return { c, el: h("label", { class: "pf-check" }, c, label) };
    };
    const metadata = box("Properties and metadata (author, title, programs, dates)");
    const attachments = box("Attached files");
    const scripts = box("Scripts and actions that run or send something");
    const comments = box("Comments and markup", false);
    const ok = () => {
      answer = { metadata: metadata.c.checked, attachments: attachments.c.checked, scripts: scripts.c.checked, comments: comments.c.checked };
      if (!Object.values(answer).some(Boolean)) return dialog.error("Choose something to remove.");
      dialog.close();
    };
    const dialog = openDialog({
      title: "Remove Hidden Information",
      subtitle: "What a PDF carries besides its pages. The file is written out again whole, so earlier versions inside it go too.",
      icon: "eyeOff",
      tone: "work",
      body: [metadata.el, attachments.el, scripts.el, comments.el],
      foot: foot(() => dialog, ok, "Remove"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

/** Search patterns for redaction: typed text, and common kinds of personal data. */
export function redactFindDialog(): Promise<{ regex: RegExp; label: string }[] | null> {
  return new Promise((resolve) => {
    let answer: { regex: RegExp; label: string }[] | null = null;
    const text = textInput({ "aria-label": "Text to find", "data-autofocus": "", placeholder: "Words or numbers, separated by commas" });
    const box = (label: string) => {
      const c = h("input", { type: "checkbox" });
      return { c, el: h("label", { class: "pf-check" }, c, label) };
    };
    const phones = box("Phone numbers"), emails = box("Email addresses"), nid = box("National ID numbers (10, 13 or 17 digits)");
    const matchCase = box("Match case"), whole = box("Whole words only");
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ok = () => {
      const out: { regex: RegExp; label: string }[] = [];
      const flags = matchCase.c.checked ? "g" : "gi";
      for (const term of text.value.split(",").map((t) => t.trim()).filter(Boolean)) {
        const body = escape(term).replace(/\s+/g, "\\s+");
        out.push({ regex: new RegExp(whole.c.checked ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body, `${flags}u`), label: term });
      }
      if (phones.c.checked) out.push({ regex: /(?<!\d)(?:\+?88[\s-]?)?01[3-9]\d{2}[\s-]?\d{6}(?!\d)|(?<![\w\d])\+\d[\d\s().-]{7,}\d(?!\d)/g, label: "phone" });
      if (emails.c.checked) out.push({ regex: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, label: "email" });
      if (nid.c.checked) out.push({ regex: /(?<!\d)(?:\d{17}|\d{13}|\d{10})(?!\d)/g, label: "nid" });
      if (!out.length) return dialog.error("Type text to find, or choose a kind of number.");
      answer = out;
      dialog.close();
    };
    const dialog = openDialog({
      title: "Find Text to Redact",
      subtitle: "Every match is marked in red, with the whole words it's part of. Check the marks, add or remove any, then Apply Redactions.",
      icon: "search",
      tone: "work",
      body: [field("Find", text), h("div", { class: "pf-row" }, matchCase.el, whole.el), phones.el, emails.el, nid.el],
      foot: foot(() => dialog, ok, "Mark Matches"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

export function redactApplyDialog(pages: number[], marks: number): Promise<{ dpi: number; cleanup: boolean } | null> {
  return new Promise((resolve) => {
    let answer: { dpi: number; cleanup: boolean } | null = null;
    const dpi = select([{ id: "300", label: "300 dpi (sharp, larger file)" }, { id: "200", label: "200 dpi" }, { id: "150", label: "150 dpi (smaller file)" }], "300", "Resolution");
    const cleanup = h("input", { type: "checkbox", checked: true });
    const ok = () => {
      answer = { dpi: Number(dpi.value), cleanup: cleanup.checked };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Apply Redactions",
      subtitle: `${marks} mark${marks === 1 ? "" : "s"} on ${pages.length === 1 ? "page" : "pages"} ${rangeText(pages)}.`,
      icon: "pfRedact",
      tone: "work",
      body: [
        h("p", { class: "tt-dialog-text" }, "Each page with marks is replaced by a picture of itself with the marks painted black, so nothing under them can be recovered. Those pages lose their selectable text, links, comments and form fields; the other pages stay as they are."),
        field("Picture quality", dpi),
        h("label", { class: "pf-check" }, cleanup, "Also remove hidden information (metadata, attachments, scripts)"),
        h("p", { class: "tt-dialog-text pf-note" }, "Bookmarks aren't changed: check they don't name what you're hiding. Save under a new name to keep the original."),
      ],
      foot: foot(() => dialog, ok, "Apply"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}

export type CompressPreset = "high" | "medium" | "small" | "gs-ebook" | "gs-screen";

export function compressDialog(size: number, ghostscript: "yes" | "no" | "encrypted"): Promise<CompressPreset | null> {
  return new Promise((resolve) => {
    let answer: CompressPreset | null = null;
    const name = `pf-compress-${Math.random()}`;
    const option = (id: CompressPreset, label: string, note: string, checked = false, disabled = false) => {
      const c = h("input", { type: "radio", name, value: id, checked, disabled });
      return h("label", { class: `pf-check pf-option${disabled ? " disabled" : ""}` }, c, h("span", null, h("b", null, label), h("span", { class: "pf-option-note" }, note)));
    };
    const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const options = [
      option("high", "High quality", "Pictures at 150 dpi, good for printing", true),
      option("medium", "Medium", "Pictures at 120 dpi"),
      option("small", "Smallest", "Pictures at 96 dpi, for the screen and email"),
      option("gs-ebook", "Maximum (Ghostscript)", ghostscript === "yes" ? "Rewrites everything with Ghostscript, at 150 dpi" : ghostscript === "encrypted" ? "Remove the password first" : "Install Ghostscript to use it", false, ghostscript !== "yes"),
    ];
    const ok = () => {
      const picked = options.map((o) => o.querySelector("input")!).find((i) => i.checked);
      answer = (picked?.value as CompressPreset) ?? "high";
      dialog.close();
    };
    const dialog = openDialog({
      title: "Reduce File Size",
      subtitle: `The file is ${mb(size)} now. Nothing changes if it can't get smaller.`,
      icon: "pfCompress",
      tone: "work",
      body: options,
      foot: foot(() => dialog, ok, "Compress"),
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}
