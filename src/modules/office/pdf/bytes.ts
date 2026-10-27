/**
 * PDF bytes written by hand: blank pages, and incremental updates that change a few objects of a
 * file pdf.js built (a page's saved rotation, the program named in its properties).
 */

/** A PDF of blank pages, of these sizes in points. */
export function blankPdf(sizes: [number, number][]): Uint8Array {
  const objects: string[] = [];
  const kids = sizes.map((_, i) => `${3 + i} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${sizes.length} >>`);
  for (const [w, h] of sizes) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> >>`);
  // Never a literal the minifier can put back together: Tauri serves a script whose first 1024
  // bytes hold "%PDF" as a PDF (its type sniffing wins over the .js name), and the release build
  // then can't load it.
  let text = [37, 80, 68, 70].map((c) => String.fromCharCode(c)).join("") + "-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

const latin1 = new TextDecoder("latin1");

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * The end (exclusive) of the dictionary or array that starts at `start` (`<<` or `[`), past the
 * strings inside it, whose bytes may be anything.
 */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "(") {
      // A literal string, with its escapes and balanced parentheses.
      let level = 1;
      for (i++; i < text.length && level; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "(") level++;
        else if (text[i] === ")") level--;
      }
      i--;
    } else if (c === "<" && text[i + 1] === "<") {
      depth++;
      i++;
    } else if (c === "<") {
      // A hex string.
      i = text.indexOf(">", i);
      if (i < 0) break;
    } else if (c === ">" && text[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    } else if (c === "[") {
      depth++;
    } else if (c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === "%") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
    }
  }
  throw new Error("A dictionary in the file isn't closed.");
}

/** The dictionary of object `num gen` (its last definition in the file), or null. */
function objectDict(text: string, num: number, gen: number): string | null {
  const re = new RegExp(`(?:^|[\\s>\\]])${num}\\s+${gen}\\s+obj\\b`, "g");
  let last = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m.index + m[0].length;
  if (last < 0) return null;
  const start = text.indexOf("<<", last);
  if (start < 0 || text.slice(last, start).trim()) return null;
  const end = valueEnd(text, start);
  // A stream isn't something this rewrites.
  if (/^\s*stream\b/.test(text.slice(end, end + 20))) return null;
  return text.slice(start, end);
}

interface Trailer {
  size: number;
  root: string;
  info: string | null;
  encrypt: string | null;
  id: string | null;
  prev: number;
  stream: boolean;
}

function readTrailer(text: string): Trailer {
  const at = text.lastIndexOf("startxref");
  if (at < 0) throw new Error("The file has no cross-reference table.");
  const prev = Number.parseInt(text.slice(at + 9).trim(), 10);
  if (!Number.isFinite(prev)) throw new Error("The file's cross-reference table is damaged.");
  const stream = !text.startsWith("xref", prev);
  const from = stream ? text.indexOf("<<", prev) : text.indexOf("<<", text.indexOf("trailer", prev));
  const dict = text.slice(from, valueEnd(text, from));
  const ref = (key: string) => dict.match(new RegExp(`/${key}\\s+(\\d+\\s+\\d+\\s+R)`))?.[1] ?? null;
  const root = ref("Root");
  if (!root) throw new Error("The file has no catalog.");
  const idAt = dict.search(/\/ID\s*\[/);
  return {
    size: Number.parseInt(dict.match(/\/Size\s+(\d+)/)?.[1] ?? "0", 10),
    root,
    info: ref("Info"),
    encrypt: ref("Encrypt"),
    id: idAt >= 0 ? dict.slice(dict.indexOf("[", idAt), valueEnd(dict, dict.indexOf("[", idAt))) : null,
    prev,
    stream,
  };
}

/** Appends new versions of objects (key "num gen", value its dictionary) to `bytes`. */
function appendUpdate(bytes: Uint8Array, text: string, trailer: Trailer, objects: Map<string, string>): Uint8Array {
  let body = text.endsWith("\n") ? "" : "\n";
  const entries: { num: number; gen: number; offset: number }[] = [];
  for (const [key, dict] of objects) {
    const [num, gen] = key.split(" ").map(Number);
    entries.push({ num, gen, offset: bytes.length + body.length });
    body += `${num} ${gen} obj\n${dict}\nendobj\n`;
  }
  const extra = `${trailer.info ? ` /Info ${trailer.info}` : ""}${trailer.encrypt ? ` /Encrypt ${trailer.encrypt}` : ""}${trailer.id ? ` /ID ${trailer.id}` : ""}`;
  let tail: Uint8Array;
  if (trailer.stream) {
    // Files whose table is a stream get a stream: a table can't follow one.
    const self = trailer.size;
    const offset = bytes.length + body.length;
    entries.push({ num: self, gen: 0, offset });
    entries.sort((a, b) => a.num - b.num);
    const data = new Uint8Array(entries.length * 7);
    entries.forEach((e, i) => {
      data[i * 7] = 1;
      data[i * 7 + 1] = (e.offset >>> 24) & 0xff;
      data[i * 7 + 2] = (e.offset >>> 16) & 0xff;
      data[i * 7 + 3] = (e.offset >>> 8) & 0xff;
      data[i * 7 + 4] = e.offset & 0xff;
      data[i * 7 + 5] = (e.gen >>> 8) & 0xff;
      data[i * 7 + 6] = e.gen & 0xff;
    });
    const index = entries.map((e) => `${e.num} 1`).join(" ");
    const head = `${self} 0 obj\n<< /Type /XRef /Size ${self + 1} /W [1 4 2] /Index [${index}] /Root ${trailer.root}${extra} /Prev ${trailer.prev} /Length ${data.length} >>\nstream\n`;
    const foot = `\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`;
    tail = concat([latin1Bytes(body + head), data, latin1Bytes(foot)]);
  } else {
    entries.sort((a, b) => a.num - b.num);
    const offset = bytes.length + body.length;
    let table = "xref\n";
    for (const e of entries) table += `${e.num} 1\n${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n \n`;
    const size = Math.max(trailer.size, ...entries.map((e) => e.num + 1));
    table += `trailer\n<< /Size ${size} /Root ${trailer.root}${extra} /Prev ${trailer.prev} >>\nstartxref\n${offset}\n%%EOF\n`;
    tail = latin1Bytes(body + table);
  }
  return concat([bytes, tail]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Finishes a file `build` made: sets the saved rotation of the pages listed (`refs` are the
 * pages' object numbers, from the built file opened with pdf.js) and names Zazabor as the
 * program that wrote it. Returns `bytes` itself when there's nothing to change.
 */
export function finish(bytes: Uint8Array, rotations: { ref: { num: number; gen: number }; rotate: number }[]): Uint8Array {
  const text = latin1.decode(bytes);
  const trailer = readTrailer(text);
  const objects = new Map<string, string>();
  for (const { ref, rotate } of rotations) {
    const dict = objectDict(text, ref.num, ref.gen);
    if (!dict || !/\/Type\s*\/Page\b/.test(dict)) throw new Error("A page of the file couldn’t be rotated.");
    const value = ((rotate % 360) + 360) % 360;
    const next = /\/Rotate\s+-?\d+/.test(dict) ? dict.replace(/\/Rotate\s+-?\d+/, `/Rotate ${value}`) : dict.replace(/^<</, `<< /Rotate ${value}`);
    objects.set(`${ref.num} ${ref.gen}`, next);
  }
  // pdf.js signs what it builds as "PDF.js" for Firefox; the strings of an encrypted file are
  // encrypted, so those are left as they are.
  if (trailer.info && !trailer.encrypt) {
    const [num, gen] = trailer.info.split(/\s+/).map(Number);
    const info = objectDict(text, num, gen);
    if (info && /\/Producer\s*\(Firefox\)/.test(info)) {
      objects.set(`${num} ${gen}`, info.replace(/\/Producer\s*\(Firefox\)/, "/Producer (Zazabor)").replace(/\/Creator\s*\(PDF\.js\)/, "/Creator (Zazabor PDF)"));
    } else if (!info) {
      // Packed in an object stream (files built from several): pdf.js wrote only its own three
      // entries there, so a new dictionary replaces it.
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
      objects.set(`${num} ${gen}`, `<< /Producer (Zazabor) /Creator (Zazabor PDF) /CreationDate (${stamp}) >>`);
    }
  }
  if (!objects.size) return bytes;
  return appendUpdate(bytes, text, trailer, objects);
}
