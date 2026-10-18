import type { Cue, Run } from "./types";

/**
 * Subtitle file parsing: SRT, WebVTT and basic ASS/SSA. Cue text keeps italics, bold, underline,
 * line breaks and `\an` alignment; everything else (colours, positions, drawings) is dropped.
 * The result holds plain strings only, so rendering with `textContent` can never inject markup.
 */

const TIMING = /((?:\d+:)?\d+:\d+(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d+:\d+(?:[.,]\d+)?)/;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "‎", rlm: "‏",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** "00:01:02,500", "01:02.5", "0:00:01.50" → milliseconds (NaN when it isn't a time). */
export function parseTimestamp(raw: string): number {
  const m = /^(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?$/.exec(raw.trim());
  if (!m) return NaN;
  const fraction = m[4] ? Math.round(parseFloat(`0.${m[4]}`) * 1000) : 0;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + fraction;
}

interface Markup {
  lines: Run[][];
  align?: number;
  /** An ASS drawing (`\p1`), not text. */
  drawing: boolean;
}

/** Turns cue text with SRT/VTT tags and ASS override blocks into styled runs. */
export function parseMarkup(raw: string): Markup {
  let italic = false, bold = false, underline = false;
  let align: number | undefined;
  let drawing = false;
  const lines: Run[][] = [[]];
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    if (drawing) {
      buffer = "";
      return;
    }
    const text = decodeEntities(buffer);
    buffer = "";
    const line = lines[lines.length - 1];
    const prev = line[line.length - 1];
    if (prev && !!prev.italic === italic && !!prev.bold === bold && !!prev.underline === underline) prev.text += text;
    else line.push({ text, ...(italic && { italic }), ...(bold && { bold }), ...(underline && { underline }) });
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "{" && raw[i + 1] === "\\") {
      const end = raw.indexOf("}", i);
      if (end > 0) {
        flush();
        const block = raw.slice(i + 1, end);
        const an = /\\an([1-9])/.exec(block);
        if (an) align = Number(an[1]);
        for (const m of block.matchAll(/\\([ibu])(\d)/g)) {
          const on = m[2] !== "0";
          if (m[1] === "i") italic = on;
          else if (m[1] === "b") bold = on;
          else underline = on;
        }
        const p = /\\p(\d)/.exec(block);
        if (p) drawing = p[1] !== "0";
        i = end + 1;
        continue;
      }
    }
    if (ch === "<") {
      const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9.:-]*)(?:\s[^<>]*)?>|^<\d+:\d+(?::\d+)?[.,]\d+>/.exec(raw.slice(i, i + 200));
      if (tag) {
        const name = (tag[2] ?? "").toLowerCase();
        if (name === "i" || name === "b" || name === "u") {
          flush();
          const on = tag[1] !== "/";
          if (name === "i") italic = on;
          else if (name === "b") bold = on;
          else underline = on;
        } else if (name === "br") {
          flush();
          lines.push([]);
        } else {
          flush();
        }
        i += tag[0].length;
        continue;
      }
    }
    if (ch === "\\" && (raw[i + 1] === "N" || raw[i + 1] === "n")) {
      flush();
      lines.push([]);
      i += 2;
      continue;
    }
    if (ch === "\\" && raw[i + 1] === "h") {
      buffer += " ";
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      lines.push([]);
      i++;
      continue;
    }
    buffer += ch;
    i++;
  }
  flush();
  const kept = lines.filter((line) => line.some((run) => run.text.trim()));
  for (const line of kept) {
    line[0].text = line[0].text.replace(/^\s+/, "");
    line[line.length - 1].text = line[line.length - 1].text.replace(/\s+$/, "");
  }
  return { lines: kept, align, drawing };
}

function makeCue(start: number, end: number, raw: string): Cue | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const { lines, align, drawing } = parseMarkup(raw);
  if (drawing || lines.length === 0) return null;
  return { start, end: Math.max(end, start), lines, align: align ?? 2 };
}

/** SRT and WebVTT share a layout: optional id line, a timing line, text until a blank line. */
function parseBlocks(text: string, vtt: boolean): Cue[] {
  const cues: Cue[] = [];
  const lines = text.split("\n");
  let timing: RegExpExecArray | null = null;
  let body: string[] = [];
  let skipBlock = false;

  const finish = () => {
    if (timing) {
      // A cue number that ended up as the last line (no blank line between cues) isn't text.
      const cue = makeCue(parseTimestamp(timing[1]), parseTimestamp(timing[2]), body.join("\n"));
      if (cue) cues.push(cue);
    }
    timing = null;
    body = [];
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const found = TIMING.exec(line);
    if (found) {
      if (timing && body.length && /^\d+$/.test(body[body.length - 1].trim())) body.pop();
      finish();
      timing = found;
      skipBlock = false;
      continue;
    }
    if (line.trim() === "") {
      finish();
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    if (!timing) {
      if (vtt && /^(NOTE|STYLE|REGION)(\s|$)/.test(line)) skipBlock = true;
      continue;
    }
    body.push(line);
  }
  finish();
  return cues;
}

function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let section = "";
  let columns: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    if (!section.includes("events")) continue;
    if (/^format:/i.test(line)) {
      columns = line.slice(7).split(",").map((c) => c.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue:/i.test(line)) continue;
    const names = columns.length ? columns : ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    const textAt = names.indexOf("text");
    const parts = line.slice(9).split(",");
    // The text is last and may itself contain commas.
    const head = parts.slice(0, textAt < 0 ? names.length - 1 : textAt);
    const body = parts.slice(head.length).join(",");
    const get = (name: string) => head[names.indexOf(name)]?.trim() ?? "";
    const cue = makeCue(parseTimestamp(get("start")), parseTimestamp(get("end")), body);
    if (cue) cues.push(cue);
  }
  return cues;
}

export type SubtitleFormat = "srt" | "vtt" | "ass";

export function detectFormat(text: string): SubtitleFormat {
  const start = text.slice(0, 2000);
  if (/^\s*WEBVTT/.test(start)) return "vtt";
  if (/^\s*\[script info\]/im.test(start) || /^dialogue:/im.test(text.slice(0, 20000)) || /^\[events\]/im.test(text.slice(0, 20000))) return "ass";
  return "srt";
}

/** Parses any supported subtitle text into cues sorted by start time. */
export function parseSubtitles(input: string): Cue[] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const format = detectFormat(text);
  const cues = format === "ass" ? parseAss(text) : parseBlocks(text, format === "vtt");
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The cue's text as one plain string (lines joined by newlines). */
export function cueText(cue: Cue): string {
  return cue.lines.map((line) => line.map((run) => run.text).join("")).join("\n");
}
