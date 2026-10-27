import type { Editor } from "@tiptap/core";
import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { field, openDialog, textArea, textInput } from "../../time/dialog";
import { popover, type Popover } from "../../time/pickers";
import type { ParagraphAttrs } from "./schema";

/** Insert → Link (Ctrl+K): the text to show and the address; Remove Link when there is one. */
export function linkDialog(editor: Editor) {
  const existing = editor.getAttributes("link").href as string | undefined;
  if (existing) editor.chain().focus().extendMarkRange("link").run();
  const { from, to } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, " ");
  const text = textInput({ value: selected, placeholder: "Text to display", "aria-label": "Text to display" });
  const address = textInput({ value: existing ?? "", placeholder: "https://example.com or name@example.com", "aria-label": "Address", "data-autofocus": "" });
  const apply = () => {
    let href = address.value.trim();
    if (!href) return dialog.error("Type an address.");
    if (/^[^\s@/]+@[^\s@]+\.[^\s@]+$/.test(href)) href = `mailto:${href}`;
    else if (!/^[a-z][a-z0-9+.-]*:|^#/i.test(href)) href = `https://${href}`;
    const label = text.value || href;
    const chain = editor.chain().focus();
    if (label !== selected || from === to) chain.insertContentAt({ from, to }, { type: "text", text: label, marks: [{ type: "link", attrs: { href } }] });
    else chain.setLink({ href });
    chain.run();
    dialog.close();
  };
  const dialog = openDialog({
    title: existing ? "Edit Link" : "Insert Link",
    icon: "link",
    tone: "work",
    body: [field("Text to display", text), field("Address", address)],
    foot: [
      existing ? h("button", { class: "btn tt-danger", type: "button", onclick: () => (editor.chain().focus().extendMarkRange("link").unsetLink().run(), dialog.close()) }, "Remove Link") : null,
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
      h("button", { class: "btn primary", type: "button", onclick: apply }, "OK"),
    ],
    submit: apply,
  });
}

/** Picture Format → Alt Text: what the picture shows, read aloud by screen readers. */
export function altTextDialog(alt: string, apply: (alt: string) => void) {
  const box = textArea({ value: alt, rows: 3, placeholder: "A short description of the picture", "aria-label": "Alt text", "data-autofocus": "" });
  const done = () => {
    apply(box.value.trim());
    dialog.close();
  };
  const dialog = openDialog({
    title: "Alt Text",
    subtitle: "Describe the picture for people who can't see it. Word keeps it too.",
    icon: "image",
    tone: "work",
    body: [field("Description", box)],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), h("button", { class: "btn primary", type: "button", onclick: done }, "OK")],
    submit: done,
  });
}

/** Review → Word Count. */
export function wordCountDialog(editor: Editor, pages: number) {
  const storage = (editor.storage as unknown as Record<string, { words: () => number; characters: () => number }>).characterCount;
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", " ");
  let paragraphs = 0;
  editor.state.doc.descendants((n) => {
    if (n.isTextblock && n.textContent.trim()) paragraphs++;
    return !n.isTextblock;
  });
  const rows: [string, number][] = [
    ["Pages", pages],
    ["Words", storage.words()],
    ["Characters (no spaces)", text.replace(/\s/g, "").length],
    ["Characters (with spaces)", storage.characters()],
    ["Paragraphs", paragraphs],
  ];
  const dialog = openDialog({
    title: "Word Count",
    icon: "docFile",
    tone: "work",
    class: "tt-confirm",
    body: [h("dl", { class: "dc-stats" }, ...rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v.toLocaleString())]))],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn primary", type: "button", onclick: () => dialog.close() }, "Close")],
  });
}

/** Paragraph… : spacing, line spacing and indents, in points. */
export function paragraphDialog(editor: Editor) {
  const node = editor.state.selection.$from.parent;
  const a = node.attrs as Partial<ParagraphAttrs>;
  const num = (value: number | null | undefined, label: string) => textInput({ class: "tt-input dc-num", inputmode: "decimal", value: value != null ? String(value) : "", placeholder: "Auto", "aria-label": label });
  const before = num(a.spaceBefore, "Space before");
  const after = num(a.spaceAfter, "Space after");
  const indent = num(a.indent, "Left indent");
  const first = num(a.firstLine, "First line indent");
  const line = h("select", { "aria-label": "Line spacing" }, ...[["", "Single (default)"], ["1", "1.0"], ["1.15", "1.15"], ["1.5", "1.5"], ["2", "Double"], ["2.5", "2.5"], ["3", "3.0"]].map(([v, l]) => h("option", { value: v }, l)));
  line.value = a.lineHeight != null ? String(a.lineHeight) : "";
  const read = (input: HTMLInputElement) => {
    const v = Number.parseFloat(input.value);
    return Number.isFinite(v) ? v : null;
  };
  const apply = () => {
    editor.chain().focus().setParagraphFormat({
      spaceBefore: read(before), spaceAfter: read(after), indent: read(indent), firstLine: read(first),
      lineHeight: line.value ? Number(line.value) : null,
    }).run();
    dialog.close();
  };
  const dialog = openDialog({
    title: "Paragraph",
    subtitle: "Spacing and indents, in points (72 points = 1 inch).",
    icon: "lineSpacing",
    tone: "work",
    body: [
      h("div", { class: "tt-pair" }, field("Space before", before), field("Space after", after)),
      h("div", { class: "tt-pair" }, field("Left indent", indent), field("First line", first, { note: h("span", { class: "tt-hint" }, "negative = hanging") })),
      field("Line spacing", line),
    ],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), h("button", { class: "btn primary", type: "button", onclick: apply }, "OK")],
    submit: apply,
  });
}

/** Insert → Table: a grid to drag over (up to 10 × 8), as Word's. */
export function tablePicker(anchor: HTMLElement, insert: (rows: number, cols: number) => void): Popover {
  const label = h("div", { class: "dc-grid-label" }, "Insert Table");
  const grid = h("div", { class: "dc-grid" });
  const cells: HTMLElement[] = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) {
    const cell = h("button", { class: "dc-grid-cell", type: "button", "aria-label": `${r + 1} by ${c + 1}` });
    cell.addEventListener("mouseenter", () => mark(r, c));
    cell.addEventListener("focus", () => mark(r, c));
    cell.addEventListener("mousedown", (e) => e.preventDefault());
    cell.addEventListener("click", () => (pop.close(), insert(r + 1, c + 1)));
    cells.push(cell);
    grid.append(cell);
  }
  const mark = (r: number, c: number) => {
    cells.forEach((cell, i) => cell.classList.toggle("on", Math.floor(i / 10) <= r && i % 10 <= c));
    label.textContent = `${c + 1} × ${r + 1} Table`;
  };
  const pop = popover(anchor, h("div", { class: "dc-table-picker" }, label, grid), document.body);
  return pop;
}

const SYMBOLS = [
  "©", "®", "™", "§", "¶", "†", "‡", "•", "…", "–", "—", "‘", "’", "“", "”", "«", "»",
  "€", "£", "¥", "¢", "৳", "₹", "$", "°", "±", "×", "÷", "≠", "≈", "≤", "≥", "∞", "√",
  "∑", "π", "µ", "Ω", "α", "β", "γ", "Δ", "½", "¼", "¾", "²", "³", "←", "→", "↑", "↓",
  "↔", "⇒", "✓", "✗", "★", "☆", "♥", "♦", "♣", "♠", "☐", "☑", "☎", "✉", "☺", "♪",
];

/** Insert → Symbol: the usual ones in a grid. */
export function symbolPicker(anchor: HTMLElement, insert: (text: string) => void): Popover {
  const pop = popover(anchor, h("div", { class: "dc-symbols" }, ...SYMBOLS.map((s) => h("button", {
    class: "dc-symbol", type: "button", title: `U+${s.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => (pop.close(), insert(s)),
  }, s))), document.body);
  return pop;
}

/** Insert → Date & Time: today in the usual formats. */
export function dateFormats(): string[] {
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions[] = [
    { day: "numeric", month: "numeric", year: "numeric" },
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
    { day: "numeric", month: "long", year: "numeric" },
    { day: "numeric", month: "short", year: "numeric" },
    { month: "long", year: "numeric" },
    { hour: "numeric", minute: "2-digit" },
    { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" },
  ];
  return [...new Set([...opts.map((o) => now.toLocaleString(undefined, o)), now.toISOString().slice(0, 10)])];
}

/**
 * Saving over a Word file that has parts Docs doesn't keep: a copy (the default), replace it, or
 * not now.
 */
export function guardDialog(name: string, lost: string[]): Promise<"copy" | "replace" | "cancel"> {
  return new Promise((resolve) => {
    let answer: "copy" | "replace" | "cancel" = "cancel";
    const pick = (a: typeof answer) => () => ((answer = a), dialog.close());
    const dialog = openDialog({
      title: "Save a copy?",
      subtitle: `“${name}” has things Docs can't keep yet.`,
      icon: "saveAs",
      tone: "meeting",
      body: [
        h("p", { class: "tt-dialog-text" }, "Saving over the original would remove them from the file:"),
        h("ul", { class: "dc-lost" }, ...lost.map((l) => h("li", null, l))),
        h("p", { class: "tt-dialog-text" }, "A copy keeps the original as it was."),
      ],
      foot: [
        h("button", { class: "btn tt-danger", type: "button", onclick: pick("replace") }, "Replace the Original"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: pick("cancel") }, "Cancel"),
        h("button", { class: "btn primary", type: "button", "data-autofocus": "", onclick: pick("copy") }, icon("saveAs", 14), "Save a Copy…"),
      ],
      onClose: () => resolve(answer),
    });
  });
}

/** Closing with unsaved changes (Ctrl+W in the page). */
export function askSave(title: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    let answer: "save" | "discard" | "cancel" = "cancel";
    const pick = (a: typeof answer) => () => ((answer = a), dialog.close());
    const dialog = openDialog({
      title: `Save changes to “${title}”?`,
      icon: "save",
      tone: "work",
      class: "tt-confirm",
      body: [h("p", { class: "tt-dialog-text" }, "Your changes will be lost if you don't save them.")],
      foot: [
        h("button", { class: "btn", type: "button", onclick: pick("discard") }, "Don't Save"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: pick("cancel") }, "Cancel"),
        h("button", { class: "btn primary", type: "button", "data-autofocus": "", onclick: pick("save") }, "Save"),
      ],
      onClose: () => resolve(answer),
    });
  });
}
