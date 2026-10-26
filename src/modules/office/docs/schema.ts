import { Extension, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyleKit } from "@tiptap/extension-text-style";
import { CharacterCount } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { FindReplace } from "./find";

/**
 * What a Docs document is made of: Tiptap's starter kit (paragraphs, headings, lists, quotes, code,
 * links, bold, italic, underline, strike), text styles (font, size, colour, shading), highlight,
 * super/subscript, alignment, tables, inline pictures and checklists, plus three things of our
 * own: Word's paragraph formatting (spacing, line spacing, indents, the Title/Subtitle/Quote
 * styles), a page break, and find & replace.
 */

/** Word's paragraph styles Docs has, and the node each is. */
export type DocStyle = "normal" | "title" | "subtitle" | "h1" | "h2" | "h3" | "quote" | "code";

export const STYLES: { id: DocStyle; name: string }[] = [
  { id: "normal", name: "Normal" },
  { id: "title", name: "Title" },
  { id: "subtitle", name: "Subtitle" },
  { id: "h1", name: "Heading 1" },
  { id: "h2", name: "Heading 2" },
  { id: "h3", name: "Heading 3" },
  { id: "quote", name: "Quote" },
  { id: "code", name: "Code" },
];

/** Word's default body text. Fontconfig shows a metric-compatible font where Calibri is missing. */
export const DEFAULT_FONT = "Calibri";
export const DEFAULT_SIZE = 11;
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** Fonts offered in the Font box when this computer has them (Word's names first; Bangla too). */
const FONT_CANDIDATES = [
  "Calibri", "Cambria", "Arial", "Times New Roman", "Courier New", "Georgia", "Verdana", "Tahoma", "Trebuchet MS", "Garamond", "Comic Sans MS",
  "Liberation Sans", "Liberation Serif", "Liberation Mono", "Liberation Sans Narrow", "Carlito", "Caladea",
  "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Noto Sans", "Noto Serif", "Noto Sans Mono",
  "Noto Sans Bengali", "Noto Serif Bengali", "Kalpurush", "SolaimanLipi", "Siyam Rupali", "Lohit Bengali", "Nikosh", "Mukti",
  "Fira Sans", "Fira Mono", "Ubuntu", "Cantarell", "Open Sans", "Roboto", "Lato", "Source Sans Pro", "Inter",
  "FreeSans", "FreeSerif", "FreeMono", "Nimbus Sans", "Nimbus Roman", "Bitstream Charter", "Courier 10 Pitch",
];

let installed: string[] | null = null;

/** The candidates this computer can draw (measured on a canvas against two fallbacks). */
export function availableFonts(): string[] {
  if (installed) return installed;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return (installed = FONT_CANDIDATES);
  const sample = "mmmmmmmmmmlliWW@#ঋক্ষ";
  const width = (font: string) => {
    ctx.font = `40px ${font}`;
    return ctx.measureText(sample).width;
  };
  const mono = width("monospace");
  const serif = width("serif");
  installed = FONT_CANDIDATES.filter((f) => width(`"${f}", monospace`) !== mono || width(`"${f}", serif`) !== serif);
  if (!installed.includes(DEFAULT_FONT)) installed.unshift(DEFAULT_FONT);
  return installed;
}

// ---- paragraph formatting

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphFormat: {
      /** Sets spacing, indents or the style of the paragraphs in the selection. */
      setParagraphFormat: (attrs: Partial<ParagraphAttrs>) => ReturnType;
    };
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

/**
 * Word's "single" line is about 1.2 of the font size (the font's own line height), so a Word line
 * spacing of 1.5 lines is CSS line-height 1.8. Docs keeps Word's multiple and draws it this way,
 * and the .docx writer reads CSS the same way (CSS 1.8 → 1.5 lines).
 */
export const WORD_LINE = 1.2;

export interface ParagraphAttrs {
  /** Line spacing in Word's lines (1, 1.15, 1.5, 2); null for the style's own. */
  lineHeight: number | null;
  /** Space before and after, in points. */
  spaceBefore: number | null;
  spaceAfter: number | null;
  /** Left indent and first-line indent, in points. */
  indent: number | null;
  firstLine: number | null;
  /** Title, Subtitle or Quote on a paragraph (headings are their own nodes). */
  docStyle: "title" | "subtitle" | "quote" | null;
}

const pt = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return null;
  if (v.endsWith("px")) return Math.round(n * 0.75 * 10) / 10;
  if (v.endsWith("in")) return n * 72;
  if (v.endsWith("cm")) return Math.round((n / 2.54) * 72 * 10) / 10;
  if (v.endsWith("mm")) return Math.round((n / 25.4) * 72 * 10) / 10;
  return n;
};

const ParagraphFormat = Extension.create({
  name: "paragraphFormat",
  addGlobalAttributes() {
    return [{
      // Word's cell shading.
      types: ["tableCell", "tableHeader"],
      attributes: {
        background: {
          default: null,
          parseHTML: (el) => el.style.backgroundColor || el.getAttribute("bgcolor") || null,
          renderHTML: (a) => (a.background ? { style: `background-color: ${a.background}` } : {}),
        },
      },
    }, {
      types: ["paragraph", "heading"],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => {
            const v = el.style.lineHeight;
            if (!v || v === "normal") return null;
            const n = Number.parseFloat(v);
            const css = v.endsWith("%") ? n / 100 : Number.isFinite(n) && !/[a-z]/.test(v) ? n : null;
            return css == null ? null : Math.round((css / WORD_LINE) * 100) / 100;
          },
          renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${Math.round(a.lineHeight * WORD_LINE * 1000) / 1000}` } : {}),
        },
        spaceBefore: {
          default: null,
          parseHTML: (el) => pt(el.style.marginTop),
          renderHTML: (a) => (a.spaceBefore != null ? { style: `margin-top: ${a.spaceBefore}pt` } : {}),
        },
        spaceAfter: {
          default: null,
          parseHTML: (el) => pt(el.style.marginBottom),
          renderHTML: (a) => (a.spaceAfter != null ? { style: `margin-bottom: ${a.spaceAfter}pt` } : {}),
        },
        indent: {
          default: null,
          parseHTML: (el) => pt(el.style.marginLeft) || null,
          renderHTML: (a) => (a.indent ? { style: `margin-left: ${a.indent}pt` } : {}),
        },
        firstLine: {
          default: null,
          parseHTML: (el) => pt(el.style.textIndent) || null,
          renderHTML: (a) => (a.firstLine ? { style: `text-indent: ${a.firstLine}pt` } : {}),
        },
        docStyle: {
          default: null,
          parseHTML: (el) => {
            const c = el.classList;
            return c.contains("ds-title") ? "title" : c.contains("ds-subtitle") ? "subtitle" : c.contains("ds-quote") ? "quote" : null;
          },
          renderHTML: (a) => (a.docStyle ? { class: `ds-${a.docStyle}` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setParagraphFormat: (attrs) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
          changed = true;
          return false;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
    };
  },
});

/** A page break: ends the page in Print Layout and in the saved .docx. */
const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML() {
    return [
      { tag: "div[data-page-break]" },
      { tag: "hr[data-page-break]" },
      // Word's HTML and others: an element that only breaks the page.
      { tag: "br", getAttrs: (el) => (/page/.test((el as HTMLElement).style.pageBreakBefore || (el as HTMLElement).style.breakBefore || "") ? {} : false), priority: 60 },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-page-break": "", class: "dc-page-break", style: "page-break-after: always; break-after: page" })];
  },
  addCommands() {
    return {
      setPageBreak: () => ({ chain }) => chain().insertContent({ type: this.name }).createParagraphNear().run(),
    };
  },
});

export interface Hooks {
  save(as: boolean): void;
  find(replace: boolean): void;
  link(): void;
  print(): void;
  close(): void;
  openHub(): void;
  /** Ctrl+Shift+V: the next paste keeps text only. */
  plainPaste(): void;
}

/** Word's keys that ProseMirror doesn't know, or knows differently (Ctrl+Shift+S is Save As). */
function wordKeys(hooks: Hooks) {
  return Extension.create({
    name: "wordKeys",
    priority: 1000,
    addKeyboardShortcuts() {
      const align = (a: string) => () => this.editor.chain().focus().setTextAlign(a).run();
      const grow = (step: number) => () => {
        const size = Number.parseFloat(this.editor.getAttributes("textStyle").fontSize ?? "") || DEFAULT_SIZE;
        const next = step > 0 ? FONT_SIZES.find((s) => s > size) ?? size + 10 : [...FONT_SIZES].reverse().find((s) => s < size) ?? Math.max(1, size - 1);
        return this.editor.chain().focus().setFontSize(`${next}pt`).run();
      };
      return {
        "Mod-s": () => (hooks.save(false), true),
        "Mod-Shift-s": () => (hooks.save(true), true),
        "Mod-f": () => (hooks.find(false), true),
        "Mod-h": () => (hooks.find(true), true),
        "Mod-k": () => (hooks.link(), true),
        "Mod-p": () => (hooks.print(), true),
        "Mod-w": () => (hooks.close(), true),
        "Mod-o": () => (hooks.openHub(), true),
        "Mod-Shift-v": () => (hooks.plainPaste(), false),
        "Mod-l": align("left"),
        "Mod-e": align("center"),
        "Mod-r": align("right"),
        "Mod-j": align("justify"),
        "Mod-Shift->": grow(1),
        "Mod-Shift-<": grow(-1),
        "Mod-]": grow(1),
        "Mod-[": grow(-1),
        "Mod-y": () => this.editor.commands.redo(),
        "Mod-Enter": () => this.editor.commands.setPageBreak(),
        "Mod-Shift-n": () => this.editor.chain().focus().setParagraph().setParagraphFormat({ docStyle: null }).run(),
        "Mod-Alt-1": () => this.editor.chain().focus().toggleHeading({ level: 1 }).run(),
        "Mod-Alt-2": () => this.editor.chain().focus().toggleHeading({ level: 2 }).run(),
        "Mod-Alt-3": () => this.editor.chain().focus().toggleHeading({ level: 3 }).run(),
        "Mod-Shift-l": () => this.editor.chain().focus().toggleBulletList().run(),
        "Mod-Space": () => this.editor.chain().focus().unsetAllMarks().run(),
        "Mod-=": () => this.editor.chain().focus().toggleSubscript().run(),
        "Mod-Shift-+": () => this.editor.chain().focus().toggleSuperscript().run(),
        "Mod-Shift-x": () => this.editor.chain().focus().toggleStrike().run(),
      };
    },
  });
}

export function extensions(hooks: Hooks): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      undoRedo: { depth: 500 },
    }),
    TextStyleKit.configure({ lineHeight: false }),
    TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
    Highlight.configure({ multicolor: true }),
    Subscript,
    Superscript,
    Image.configure({ inline: true, allowBase64: true, resize: { enabled: true, directions: ["top-left", "top-right", "bottom-left", "bottom-right"], alwaysPreserveAspectRatio: true, minWidth: 24, minHeight: 24 } }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 40 } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    CharacterCount,
    ParagraphFormat,
    PageBreak,
    FindReplace,
    wordKeys(hooks),
  ];
}

/** The style the selection's paragraph has, for the Styles gallery. */
export function currentStyle(isActive: (name: string, attrs?: Record<string, unknown>) => boolean, docStyle: string | null): DocStyle {
  if (isActive("codeBlock")) return "code";
  for (const level of [1, 2, 3] as const) if (isActive("heading", { level })) return `h${level}`;
  if (docStyle === "title" || docStyle === "subtitle" || docStyle === "quote") return docStyle;
  return "normal";
}
