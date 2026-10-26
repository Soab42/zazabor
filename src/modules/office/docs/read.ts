import JSZip from "jszip";
import { WORD_LINE } from "./schema";

/**
 * Opening files as Docs content (HTML that the editor's schema reads). A .docx is read straight
 * from its XML: paragraphs with their styles, alignment, spacing and indents, runs with their
 * fonts, sizes, colours and highlights, lists, tables with merged cells, pictures, links, page
 * breaks and the page setup. What Docs doesn't keep (headers, footnotes, comments, text boxes…)
 * comes back as warnings, so saving over the file can ask first. If reading fails, mammoth's
 * plainer conversion is the fallback.
 */

export interface PageSetup {
  size: PageSize;
  orientation: "portrait" | "landscape";
  /** In points. */
  width: number;
  height: number;
  margins: { top: number; right: number; bottom: number; left: number };
}

export type PageSize = "a4" | "letter" | "legal" | "a5" | "custom";

/** Portrait sizes in points. */
export const PAGE_SIZES: Record<Exclude<PageSize, "custom">, { name: string; width: number; height: number; note: string }> = {
  a4: { name: "A4", width: 595.3, height: 841.9, note: "21 × 29.7 cm" },
  letter: { name: "Letter", width: 612, height: 792, note: "8.5 × 11 in" },
  legal: { name: "Legal", width: 612, height: 1008, note: "8.5 × 14 in" },
  a5: { name: "A5", width: 419.5, height: 595.3, note: "14.8 × 21 cm" },
};

export const MARGIN_PRESETS: { id: string; name: string; margins: PageSetup["margins"] }[] = [
  { id: "normal", name: "Normal", margins: { top: 72, right: 72, bottom: 72, left: 72 } },
  { id: "narrow", name: "Narrow", margins: { top: 36, right: 36, bottom: 36, left: 36 } },
  { id: "moderate", name: "Moderate", margins: { top: 72, right: 54, bottom: 72, left: 54 } },
  { id: "wide", name: "Wide", margins: { top: 72, right: 144, bottom: 72, left: 144 } },
];

export function defaultPage(): PageSetup {
  return { size: "a4", orientation: "portrait", width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height, margins: { ...MARGIN_PRESETS[0].margins } };
}

export interface Imported {
  html: string;
  page: PageSetup;
  /** What the file has that Docs doesn't keep (plain words: "comments", "headers and footers"). */
  warnings: string[];
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Word's paragraph defaults that Docs' Normal style already has (see docs.css). */
export const NORMAL_AFTER = 8;
export const NORMAL_LINE = 1.08;

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function kids(el: Element | null | undefined, name?: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (const c of el.children) if (!name || c.localName === name) out.push(c);
  return out;
}
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0] ?? null;
function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  return el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`);
}
/** An on/off property: present and not "false", "0" or "off". */
function on(el: Element | null | undefined): boolean {
  if (!el) return false;
  const v = attr(el, "val");
  return v == null || !["false", "0", "off", "none"].includes(v);
}
const twipsToPt = (v: string | null) => (v == null ? null : Number.parseInt(v, 10) / 20);

const HIGHLIGHTS: Record<string, string> = {
  yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000",
  darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
  darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff",
};

interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  vert?: "superscript" | "subscript";
  color?: string;
  highlight?: string;
  shade?: string;
  size?: number;
  sizeCs?: number;
  font?: string;
  fontCs?: string;
}

interface ParaProps {
  align?: string;
  before?: number;
  after?: number;
  line?: number;
  indent?: number;
  firstLine?: number;
  pageBreakBefore?: boolean;
}

interface Style {
  name: string;
  basedOn: string | null;
  pPr: Element | null;
  rPr: Element | null;
}

class Reader {
  private styles = new Map<string, Style>();
  private defaultRun: RunProps = {};
  private defaultPara: ParaProps = {};
  private rels = new Map<string, { target: string; external: boolean }>();
  private numbering = new Map<string, { abstract: string; starts: Map<number, number> }>();
  private abstracts = new Map<string, Map<number, { format: string; start: number }>>();
  private theme = { minor: "Calibri", major: "Calibri Light" };
  readonly warnings = new Set<string>();
  page = defaultPage();
  private images = new Map<string, string>();

  constructor(private zip: JSZip) {}

  private async xml(path: string): Promise<Document | null> {
    const file = this.zip.file(path);
    if (!file) return null;
    return new DOMParser().parseFromString(await file.async("text"), "application/xml");
  }

  async load(): Promise<string> {
    const doc = await this.xml("word/document.xml");
    if (!doc) throw new Error("This isn't a Word document (no word/document.xml).");
    await Promise.all([this.loadTheme(), this.loadStyles(), this.loadNumbering(), this.loadRels()]);
    const body = doc.getElementsByTagNameNS(W, "body")[0];
    if (!body) throw new Error("The document has no body.");
    if (this.zip.file("word/comments.xml")) this.warnings.add("comments");
    await this.preloadImages(body);
    const sections = body.getElementsByTagNameNS(W, "sectPr");
    if (sections.length > 1) this.warnings.add("sections with their own page setup");
    const last = kids(body, "sectPr")[0] ?? sections[sections.length - 1];
    if (last) this.readSection(last);
    return this.blocks(kids(body));
  }

  // ---- parts

  private async loadTheme() {
    const theme = await this.xml("word/theme/theme1.xml");
    if (!theme) return;
    const font = (name: string) => theme.getElementsByTagName(`a:${name}`)[0]?.getElementsByTagName("a:latin")[0]?.getAttribute("typeface");
    this.theme = { minor: font("minorFont") || this.theme.minor, major: font("majorFont") || this.theme.major };
  }

  private async loadStyles() {
    const styles = await this.xml("word/styles.xml");
    if (!styles) return;
    const root = styles.documentElement;
    const defaults = kid(root, "docDefaults");
    this.defaultRun = this.runProps(kid(kid(defaults, "rPrDefault"), "rPr"), {});
    this.defaultPara = this.paraProps(kid(kid(defaults, "pPrDefault"), "pPr"), {});
    for (const s of kids(root, "style")) {
      const id = attr(s, "styleId");
      if (!id) continue;
      this.styles.set(id, {
        name: (attr(kid(s, "name"), "val") ?? id).toLowerCase(),
        basedOn: attr(kid(s, "basedOn"), "val"),
        pPr: kid(s, "pPr"),
        rPr: kid(s, "rPr"),
      });
    }
  }

  private async loadNumbering() {
    const numbering = await this.xml("word/numbering.xml");
    if (!numbering) return;
    for (const a of kids(numbering.documentElement, "abstractNum")) {
      const levels = new Map<number, { format: string; start: number }>();
      for (const lvl of kids(a, "lvl")) {
        levels.set(Number(attr(lvl, "ilvl") ?? 0), { format: attr(kid(lvl, "numFmt"), "val") ?? "bullet", start: Number(attr(kid(lvl, "start"), "val") ?? 1) });
      }
      this.abstracts.set(attr(a, "abstractNumId") ?? "", levels);
    }
    for (const n of kids(numbering.documentElement, "num")) {
      const starts = new Map<number, number>();
      for (const o of kids(n, "lvlOverride")) {
        const start = attr(kid(o, "startOverride"), "val");
        if (start) starts.set(Number(attr(o, "ilvl") ?? 0), Number(start));
      }
      this.numbering.set(attr(n, "numId") ?? "", { abstract: attr(kid(n, "abstractNumId"), "val") ?? "", starts });
    }
  }

  private async loadRels() {
    const rels = await this.xml("word/_rels/document.xml.rels");
    if (!rels) return;
    for (const r of Array.from(rels.documentElement.children)) {
      const id = r.getAttribute("Id");
      const target = r.getAttribute("Target");
      if (id && target) this.rels.set(id, { target, external: r.getAttribute("TargetMode") === "External" });
    }
  }

  /** Pictures as data URLs, read up front (the walk below is synchronous). */
  private async preloadImages(body: Element) {
    const ids = new Set<string>();
    for (const blip of Array.from(body.getElementsByTagName("a:blip"))) {
      const id = blip.getAttributeNS(R, "embed") ?? blip.getAttribute("r:embed");
      if (id) ids.add(id);
    }
    for (const data of Array.from(body.getElementsByTagName("v:imagedata"))) {
      const id = data.getAttributeNS(R, "id") ?? data.getAttribute("r:id");
      if (id) ids.add(id);
    }
    await Promise.all([...ids].map(async (id) => {
      const rel = this.rels.get(id);
      if (!rel || rel.external) return;
      const path = rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target.replace(/^\.\//, "")}`;
      const file = this.zip.file(path);
      if (!file) return;
      const ext = path.split(".").pop()!.toLowerCase();
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "bmp" ? "image/bmp" : ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : null;
      if (!mime) {
        this.warnings.add(`pictures in .${ext} format`);
        return;
      }
      this.images.set(id, `data:${mime};base64,${await file.async("base64")}`);
    }));
  }

  private readSection(sect: Element) {
    const size = kid(sect, "pgSz");
    const margin = kid(sect, "pgMar");
    const w = twipsToPt(attr(size, "w"));
    const hgt = twipsToPt(attr(size, "h"));
    if (w && hgt) {
      const landscape = attr(size, "orient") === "landscape" || w > hgt;
      const pw = Math.min(w, hgt);
      const ph = Math.max(w, hgt);
      const match = (Object.entries(PAGE_SIZES) as [Exclude<PageSize, "custom">, { width: number; height: number }][]).find(([, s]) => Math.abs(s.width - pw) < 3 && Math.abs(s.height - ph) < 3);
      this.page = { ...this.page, size: match?.[0] ?? "custom", orientation: landscape ? "landscape" : "portrait", width: pw, height: ph };
    }
    if (margin) {
      const m = (side: string, fallback: number) => Math.abs(twipsToPt(attr(margin, side)) ?? fallback);
      this.page.margins = { top: m("top", 72), right: m("right", 72), bottom: m("bottom", 72), left: m("left", 72) };
    }
    if (kids(sect, "headerReference").length || kids(sect, "footerReference").length) this.warnings.add("headers and footers");
    if (Number(attr(kid(sect, "cols"), "num") ?? 1) > 1) this.warnings.add("text in columns");
  }

  // ---- properties

  private runProps(rPr: Element | null, base: RunProps): RunProps {
    if (!rPr) return base;
    const p: RunProps = { ...base };
    for (const c of kids(rPr)) {
      switch (c.localName) {
        case "b": p.bold = on(c); break;
        case "i": p.italic = on(c); break;
        case "u": p.underline = on(c); break;
        case "strike": case "dstrike": p.strike = on(c); break;
        case "caps": p.caps = on(c); break;
        case "vertAlign": { const v = attr(c, "val"); p.vert = v === "superscript" || v === "subscript" ? v : undefined; break; }
        case "color": { const v = attr(c, "val"); p.color = v && v !== "auto" ? `#${v}` : undefined; break; }
        case "highlight": { const v = attr(c, "val"); p.highlight = v && v !== "none" ? HIGHLIGHTS[v] ?? undefined : undefined; break; }
        case "shd": { const v = attr(c, "fill"); p.shade = v && v !== "auto" ? `#${v}` : undefined; break; }
        case "sz": p.size = Number(attr(c, "val")) / 2; break;
        case "szCs": p.sizeCs = Number(attr(c, "val")) / 2; break;
        case "rFonts": {
          const theme = (t: string | null) => (t ? (t.startsWith("major") ? this.theme.major : this.theme.minor) : null);
          p.font = attr(c, "ascii") ?? attr(c, "hAnsi") ?? theme(attr(c, "asciiTheme") ?? attr(c, "hAnsiTheme")) ?? p.font;
          p.fontCs = attr(c, "cs") ?? theme(attr(c, "cstheme")) ?? p.fontCs;
          break;
        }
      }
    }
    return p;
  }

  private paraProps(pPr: Element | null, base: ParaProps): ParaProps {
    if (!pPr) return base;
    const p: ParaProps = { ...base };
    const jc = attr(kid(pPr, "jc"), "val");
    if (jc) p.align = jc === "both" || jc === "distribute" ? "justify" : jc === "end" ? "right" : jc === "start" ? "left" : jc;
    const spacing = kid(pPr, "spacing");
    if (spacing) {
      const before = twipsToPt(attr(spacing, "before"));
      const after = twipsToPt(attr(spacing, "after"));
      if (before != null) p.before = before;
      if (after != null) p.after = after;
      const line = attr(spacing, "line");
      const rule = attr(spacing, "lineRule") ?? "auto";
      if (line && rule === "auto") p.line = Math.round((Number(line) / 240) * 100) / 100;
    }
    const ind = kid(pPr, "ind");
    if (ind) {
      const left = twipsToPt(attr(ind, "left") ?? attr(ind, "start"));
      if (left != null) p.indent = left;
      const first = twipsToPt(attr(ind, "firstLine"));
      const hanging = twipsToPt(attr(ind, "hanging"));
      if (first != null) p.firstLine = first;
      else if (hanging != null) p.firstLine = -hanging;
    }
    if (kid(pPr, "pageBreakBefore") && on(kid(pPr, "pageBreakBefore"))) p.pageBreakBefore = true;
    return p;
  }

  /** A style's chain, oldest ancestor first. */
  private chain(id: string | null): Style[] {
    const out: Style[] = [];
    for (let i = 0; id && i < 12; i++) {
      const s = this.styles.get(id);
      if (!s) break;
      out.unshift(s);
      id = s.basedOn;
    }
    return out;
  }

  /** Which Docs style a paragraph style is (through what it's based on). */
  private kindOf(styleId: string | null): string {
    for (const s of this.chain(styleId).reverse()) {
      const m = /^heading (\d)$/.exec(s.name);
      if (m) return `h${Math.min(6, Number(m[1]))}`;
      if (s.name === "title") return "title";
      if (s.name === "subtitle") return "subtitle";
      if (s.name === "quote" || s.name === "intense quote") return "quote";
      if (s.name === "html preformatted" || s.name === "code" || s.name === "source code") return "code";
    }
    return "normal";
  }

  // ---- body

  private blocks(elements: Element[]): string {
    let html = "";
    /** Open lists: level, numId, kind. */
    const lists: { level: number; numId: string; tag: "ul" | "ol" }[] = [];
    const closeTo = (level: number) => {
      while (lists.length && lists[lists.length - 1].level > level) html += `</li></${lists.pop()!.tag}>`;
    };
    for (const el of elements) {
      if (el.localName === "p") {
        const pPr = kid(el, "pPr");
        const numPr = kid(pPr, "numPr");
        const numId = attr(kid(numPr, "numId"), "val");
        if (numId && numId !== "0" && this.numbering.has(numId)) {
          const level = Number(attr(kid(numPr, "ilvl"), "val") ?? 0);
          const info = this.listInfo(numId, level);
          closeTo(level);
          const top = lists[lists.length - 1];
          if (top && top.level === level && (top.numId !== numId || top.tag !== info.tag)) {
            html += `</li></${lists.pop()!.tag}>`;
          }
          const current = lists[lists.length - 1];
          if (!current || current.level < level) {
            const attrs = info.tag === "ol" ? `${info.start !== 1 ? ` start="${info.start}"` : ""}${info.type ? ` type="${info.type}"` : ""}` : "";
            html += `<${info.tag}${attrs}><li>`;
            lists.push({ level, numId, tag: info.tag });
          } else {
            html += "</li><li>";
          }
          html += this.paragraph(el, true);
          continue;
        }
        closeTo(-1);
        html += this.paragraph(el, false);
      } else {
        closeTo(-1);
        if (el.localName === "tbl") html += this.table(el);
        else if (el.localName === "sdt") html += this.blocks(kids(kid(el, "sdtContent")));
        else if (el.localName === "customXml") html += this.blocks(kids(el));
        else if (el.localName === "AlternateContent") html += this.blocks(kids(kid(el, "Fallback") ?? kid(el, "Choice")));
      }
    }
    closeTo(-1);
    return html;
  }

  private listInfo(numId: string, level: number): { tag: "ul" | "ol"; start: number; type: string } {
    const num = this.numbering.get(numId)!;
    const lvl = this.abstracts.get(num.abstract)?.get(level);
    const format = lvl?.format ?? "bullet";
    if (format === "bullet" || format === "none") return { tag: "ul", start: 1, type: "" };
    const type = format === "lowerLetter" ? "a" : format === "upperLetter" ? "A" : format === "lowerRoman" ? "i" : format === "upperRoman" ? "I" : "";
    return { tag: "ol", start: num.starts.get(level) ?? lvl?.start ?? 1, type };
  }

  private paragraph(el: Element, inList: boolean): string {
    const pPr = kid(el, "pPr");
    const styleId = attr(kid(pPr, "pStyle"), "val");
    const kind = inList ? "normal" : this.kindOf(styleId);
    const styled = kind === "normal" || kind === "quote";
    const chain = this.chain(styleId);
    // A mapped style (heading, title) looks as Docs draws it; only direct formatting comes along.
    let para = styled ? { ...this.defaultPara } : {};
    let run = styled ? { ...this.defaultRun } : {};
    if (styled) for (const s of chain) {
      para = this.paraProps(s.pPr, para);
      run = this.runProps(s.rPr, run);
    }
    para = this.paraProps(pPr, para);
    const paraRun = this.runProps(kid(pPr, "rPr"), run);

    // The runs, split where a page break falls inside the paragraph.
    const chunks: string[] = [""];
    const after: string[] = [];
    this.inline(kids(el), paraRun, chunks, after, null);

    const style: string[] = [];
    if (para.align && para.align !== "left") style.push(`text-align: ${para.align}`);
    if (!inList) {
      if (para.indent) style.push(`margin-left: ${para.indent}pt`);
      if (para.firstLine) style.push(`text-indent: ${para.firstLine}pt`);
    }
    if (styled && para.before != null && para.before !== 0) style.push(`margin-top: ${para.before}pt`);
    if (styled && para.after != null && para.after !== NORMAL_AFTER) style.push(`margin-bottom: ${para.after}pt`);
    if (styled && para.line != null && Math.abs(para.line - NORMAL_LINE) > 0.02) style.push(`line-height: ${Math.round(para.line * WORD_LINE * 1000) / 1000}`);
    const styleAttr = style.length ? ` style="${style.join("; ")}"` : "";
    const [open, close] = kind.startsWith("h")
      ? [`<${kind}${styleAttr}>`, `</${kind}>`]
      : kind === "code"
        ? ["<pre><code>", "</code></pre>"]
        : [`<p${kind === "normal" ? "" : ` class="ds-${kind}"`}${styleAttr}>`, "</p>"];
    let html = para.pageBreakBefore ? '<div data-page-break=""></div>' : "";
    // A page break at the very start of a paragraph doesn't leave an empty one before it.
    const parts = chunks.length > 1 && !chunks[0] ? chunks.slice(1) : chunks;
    if (parts !== chunks) html += '<div data-page-break=""></div>';
    html += parts.map((c) => `${open}${kind === "code" ? c.replace(/<[^>]+>/g, "") : c}${close}`).join('<div data-page-break=""></div>');
    return html + after.join("");
  }

  /** Runs, links and fields into `chunks` (a page break starts a new chunk); text boxes go to `after`. */
  private inline(elements: Element[], paraRun: RunProps, chunks: string[], after: string[], href: string | null) {
    let field: { instr: string; showing: boolean; href: string | null } | null = null;
    const push = (html: string) => {
      const link = href ?? field?.href ?? null;
      chunks[chunks.length - 1] += link ? `<a href="${esc(link)}">${html}</a>` : html;
    };
    for (const el of elements) {
      switch (el.localName) {
        case "r": {
          const rPr = kid(el, "rPr");
          const rStyle = attr(kid(rPr, "rStyle"), "val");
          let props = { ...paraRun };
          for (const s of this.chain(rStyle)) props = this.runProps(s.rPr, props);
          props = this.runProps(rPr, props);
          for (const c of kids(el)) {
            if (c.localName === "fldChar") {
              const type = attr(c, "fldCharType");
              if (type === "begin") field = { instr: "", showing: false, href: null };
              else if (type === "separate" && field) {
                field.showing = true;
                const m = /HYPERLINK\s+"([^"]+)"/.exec(field.instr);
                if (m) field.href = m[1];
                else if (/\b(TOC|PAGE|NUMPAGES|REF|SEQ|DATE)\b/.test(field.instr)) this.warnings.add("fields (page numbers, tables of contents)");
              } else if (type === "end") field = null;
              continue;
            }
            if (c.localName === "instrText") {
              if (field) field.instr += c.textContent ?? "";
              continue;
            }
            if (field && !field.showing) continue;
            const piece = this.runChild(c, props, chunks);
            if (piece) push(this.wrap(piece, props));
          }
          for (const box of Array.from(el.getElementsByTagNameNS(W, "txbxContent"))) {
            this.warnings.add("text boxes");
            after.push(this.blocks(kids(box)));
          }
          break;
        }
        case "hyperlink": {
          const id = el.getAttributeNS(R, "id") ?? el.getAttribute("r:id");
          const anchor = attr(el, "anchor");
          const link = id ? this.rels.get(id)?.target ?? null : anchor ? `#${anchor}` : null;
          this.inline(kids(el), paraRun, chunks, after, link);
          break;
        }
        case "fldSimple":
          if (/\b(TOC|PAGE|NUMPAGES)\b/.test(attr(el, "instr") ?? "")) this.warnings.add("fields (page numbers, tables of contents)");
          this.inline(kids(el), paraRun, chunks, after, href);
          break;
        case "ins":
          this.warnings.add("tracked changes");
          this.inline(kids(el), paraRun, chunks, after, href);
          break;
        case "del":
          this.warnings.add("tracked changes");
          break;
        case "smartTag": case "customXml": case "bdo": case "dir":
          this.inline(kids(el), paraRun, chunks, after, href);
          break;
        case "sdt":
          this.inline(kids(kid(el, "sdtContent")), paraRun, chunks, after, href);
          break;
        case "commentRangeStart": case "commentReference":
          this.warnings.add("comments");
          break;
        case "oMath": case "oMathPara":
          this.warnings.add("equations");
          push(esc(Array.from(el.getElementsByTagName("m:t")).map((t) => t.textContent).join("")));
          break;
        case "AlternateContent":
          this.inline(kids(kid(el, "Fallback") ?? kid(el, "Choice")), paraRun, chunks, after, href);
          break;
      }
    }
  }

  /** One piece of a run as HTML text (not yet styled); a page break starts a new chunk. */
  private runChild(c: Element, props: RunProps, chunks: string[]): string {
    switch (c.localName) {
      case "t": {
        const text = c.textContent ?? "";
        return esc(props.caps ? text.toUpperCase() : text);
      }
      case "tab": return "\t";
      case "br":
        if (attr(c, "type") === "page") {
          chunks.push("");
          return "";
        }
        return attr(c, "type") === "column" ? "" : "<br>";
      case "cr": return "<br>";
      case "noBreakHyphen": return "‑";
      case "softHyphen": return "­";
      case "sym": {
        const code = attr(c, "char");
        return code ? esc(String.fromCharCode(Number.parseInt(code, 16) & 0xffff)) : "";
      }
      case "footnoteReference": case "endnoteReference":
        this.warnings.add("footnotes and endnotes");
        return `<sup>[${esc(attr(c, "id") ?? "")}]</sup>`;
      case "commentReference":
        this.warnings.add("comments");
        return "";
      case "drawing": return this.drawing(c);
      case "pict": {
        const data = c.getElementsByTagName("v:imagedata")[0];
        const id = data?.getAttributeNS(R, "id") ?? data?.getAttribute("r:id");
        const src = id ? this.images.get(id) : null;
        if (!src) this.warnings.add("shapes and drawings");
        return src ? `<img src="${src}">` : "";
      }
      case "object":
        this.warnings.add("embedded objects");
        return "";
      default:
        return "";
    }
  }

  private drawing(c: Element): string {
    const anchor = kid(c, "anchor");
    const holder = anchor ?? kid(c, "inline");
    const blip = c.getElementsByTagName("a:blip")[0];
    const id = blip?.getAttributeNS(R, "embed") ?? blip?.getAttribute("r:embed");
    const src = id ? this.images.get(id) : null;
    if (!src) {
      this.warnings.add(c.getElementsByTagName("c:chart").length ? "charts" : "shapes and drawings");
      return "";
    }
    if (anchor) this.warnings.add("floating pictures (they become inline)");
    const extent = kid(holder, "extent");
    const width = extent ? Math.round(Number(extent.getAttribute("cx")) / 9525) : 0;
    const alt = kid(holder, "docPr")?.getAttribute("descr") ?? "";
    return `<img src="${src}"${width ? ` width="${width}"` : ""}${alt ? ` alt="${esc(alt)}"` : ""}>`;
  }

  /** Text with a run's formatting, as the editor's marks read it. */
  private wrap(html: string, p: RunProps): string {
    if (!html) return "";
    const bangla = /[ঀ-৿]/.test(html);
    const font = bangla && p.fontCs ? p.fontCs : p.font;
    const size = bangla && p.sizeCs ? p.sizeCs : p.size;
    const style: string[] = [];
    if (p.color && p.color.toLowerCase() !== "#000000") style.push(`color: ${p.color}`);
    if (p.shade) style.push(`background-color: ${p.shade}`);
    if (font && font !== "Calibri") style.push(`font-family: ${/\s/.test(font) ? `'${font}'` : font}`);
    if (size && size !== 11) style.push(`font-size: ${size}pt`);
    let out = style.length ? `<span style="${style.join("; ")}">${html}</span>` : html;
    if (p.highlight) out = `<mark data-color="${p.highlight}" style="background-color: ${p.highlight}">${out}</mark>`;
    if (p.vert === "superscript") out = `<sup>${out}</sup>`;
    if (p.vert === "subscript") out = `<sub>${out}</sub>`;
    if (p.strike) out = `<s>${out}</s>`;
    if (p.underline) out = `<u>${out}</u>`;
    if (p.italic) out = `<em>${out}</em>`;
    if (p.bold) out = `<strong>${out}</strong>`;
    return out;
  }

  private table(tbl: Element): string {
    const rows = kids(tbl, "tr");
    // Vertically merged cells: the first cell of a merge spans the rows that continue it.
    type Cell = { el: Element; col: number; span: number; rowspan: number; skip: boolean; header: boolean };
    const grid: Cell[][] = [];
    const starts = new Map<number, Cell>();
    for (const tr of rows) {
      const header = !!kid(kid(tr, "trPr"), "tblHeader");
      let col = Number(attr(kid(kid(tr, "trPr"), "gridBefore"), "val") ?? 0);
      const line: Cell[] = [];
      for (const tc of kids(tr, "tc")) {
        const tcPr = kid(tc, "tcPr");
        const span = Number(attr(kid(tcPr, "gridSpan"), "val") ?? 1);
        const vMerge = kid(tcPr, "vMerge");
        const cell: Cell = { el: tc, col, span, rowspan: 1, skip: false, header };
        if (vMerge && attr(vMerge, "val") !== "restart") {
          const start = starts.get(col);
          if (start) {
            start.rowspan++;
            cell.skip = true;
          }
        } else if (vMerge) starts.set(col, cell);
        else starts.delete(col);
        line.push(cell);
        col += span;
      }
      grid.push(line);
    }
    let html = "<table><tbody>";
    for (const line of grid) {
      html += "<tr>";
      for (const cell of line) {
        if (cell.skip) continue;
        const tcPr = kid(cell.el, "tcPr");
        const fill = attr(kid(tcPr, "shd"), "fill");
        const tag = cell.header ? "th" : "td";
        const attrs = `${cell.span > 1 ? ` colspan="${cell.span}"` : ""}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ""}${fill && fill !== "auto" ? ` style="background-color: #${fill}"` : ""}`;
        const inner = this.blocks(kids(cell.el).filter((c) => c.localName !== "tcPr"));
        html += `<${tag}${attrs}>${inner || "<p></p>"}</${tag}>`;
      }
      html += "</tr>";
    }
    return `${html}</tbody></table>`;
  }
}

export async function readDocx(bytes: Uint8Array): Promise<Imported> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const reader = new Reader(zip);
    const html = await reader.load();
    return { html, page: reader.page, warnings: [...reader.warnings] };
  } catch (err) {
    // A file this reader trips over still opens, plainer, through mammoth.
    console.warn("Docs: reading the .docx directly failed, using mammoth:", err);
    // @ts-ignore: the browser build has no types of its own (mammoth's are for the Node build).
    const mammoth = (await import("mammoth/mammoth.browser.min.js")).default as typeof import("mammoth");
    const copy = bytes.slice().buffer as ArrayBuffer;
    const result = await mammoth.convertToHtml({ arrayBuffer: copy });
    const warnings = ["formatting the simple reader doesn't keep (fonts, colours, sizes, alignment)"];
    if (result.messages.some((m) => m.type === "warning")) warnings.push("styles Word uses that Docs doesn't have");
    return { html: result.value, page: defaultPage(), warnings };
  }
}

export function readText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => `<p>${esc(line).replace(/\t/g, "\t")}</p>`).join("");
}

/** The usual Markdown: headings, lists (nested by indent), quotes, code, rules, emphasis, links, images. */
export function readMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const inline = (s: string) => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
  let html = "";
  const lists: { indent: number; tag: string }[] = [];
  const closeLists = (indent: number) => {
    while (lists.length && lists[lists.length - 1].indent >= indent) html += `</li></${lists.pop()!.tag}>`;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```/.exec(line);
    if (fence) {
      closeLists(0);
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      const indent = item[1].replace(/\t/g, "    ").length;
      const tag = /\d/.test(item[2]) ? "ol" : "ul";
      const top = lists[lists.length - 1];
      if (top && top.indent > indent) closeLists(indent + 1);
      const now = lists[lists.length - 1];
      if (!now || now.indent < indent) {
        html += `<${tag}><li>`;
        lists.push({ indent, tag });
      } else if (now.tag !== tag) {
        html += `</li></${lists.pop()!.tag}><${tag}><li>`;
        lists.push({ indent, tag });
      } else html += "</li><li>";
      html += `<p>${inline(item[4])}</p>`;
      continue;
    }
    closeLists(0);
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) html += `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) html += "<hr>";
    else if (/^>\s?/.test(line)) html += `<blockquote><p>${inline(line.replace(/^>\s?/, ""))}</p></blockquote>`;
    else if (line.trim()) {
      // A paragraph runs until a blank line.
      let para = line;
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,6}\s|>|```|\s*([-*+]|\d+[.)])\s)/.test(lines[i + 1])) para += ` ${lines[++i].trim()}`;
      html += `<p>${inline(para)}</p>`;
    }
  }
  closeLists(0);
  return html;
}

/** A web page's body, without its scripts, styles and frames. */
export function readHtml(text: string): string {
  const doc = new DOMParser().parseFromString(text, "text/html");
  doc.querySelectorAll("script, style, iframe, object, embed, link, meta, noscript, template").forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name) || (a.name === "href" && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
  });
  return doc.body.innerHTML;
}
