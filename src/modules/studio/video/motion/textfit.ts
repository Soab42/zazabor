/**
 * Text for motion templates: splitting into the units animators move (letters, words, lines)
 * without ever cutting a Bangla conjunct apart, and fitting text into a box (shrink within a
 * range, wrap to at most N balanced lines, then an ellipsis). Pure, with the measuring passed in
 * (a canvas in the app, a fake in tests).
 */

/** Signs that join the letter after them into one written cluster (virama/hasant, ZWJ). */
const JOINERS = new Set([
  "्", "্", "੍", "્", "୍", "்", "్", "್", "്", "්", "්", "‍",
]);

let segmenter: Intl.Segmenter | null | undefined;

/**
 * Letters as people see them: grapheme clusters, then any cluster ending in a virama or a
 * zero-width joiner joined with the next, so "ক্ষ" or "র্য" stays one unit even where the system's
 * ICU predates Unicode 15.1's conjunct rules.
 */
export function graphemes(text: string): string[] {
  if (segmenter === undefined) segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const raw = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
  const out: string[] = [];
  for (const g of raw) {
    const prev = out[out.length - 1];
    if (prev !== undefined && JOINERS.has(prev[prev.length - 1]) && !/^\s/.test(g)) out[out.length - 1] = prev + g;
    else out.push(g);
  }
  return out;
}

/** Words and the spaces between them, in order ("Hello, world" → ["Hello,", " ", "world"]). */
export function wordsOf(text: string): string[] {
  return text.split(/(\s+)/).filter((s) => s.length > 0);
}

export type Measure = (text: string) => number;

/** Greedy wrapping of one paragraph to `width`; a word too long for a line is broken by letters. */
export function wrapGreedy(text: string, width: number, measure: Measure): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of wordsOf(text)) {
    const space = /^\s+$/.test(word);
    const next = line + word;
    if (!line.trim() && space) continue;
    if (measure(next.trimEnd()) <= width || !line.trim()) {
      if (measure(next.trimEnd()) > width && !space) {
        // One word wider than the box: break it into letters.
        let part = line;
        for (const g of graphemes(word)) {
          if (measure(part + g) > width && part.trim()) {
            lines.push(part.trimEnd());
            part = g;
          } else part += g;
        }
        line = part;
      } else line = next;
    } else {
      lines.push(line.trimEnd());
      line = space ? "" : word;
    }
  }
  if (line.trim() || !lines.length) lines.push(line.trimEnd());
  return lines;
}

/**
 * Wraps text (paragraphs split at line breaks) into the fewest lines that fit, then evens them
 * out: the narrowest width that still needs no more lines, so no line is left with one word.
 */
export function wrapBalanced(text: string, width: number, measure: Measure): string[] {
  const paragraphs = text.split("\n");
  const greedy = paragraphs.flatMap((p) => wrapGreedy(p, width, measure));
  if (greedy.length <= paragraphs.length) return greedy;
  let lo = width * 0.4, hi = width;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const n = paragraphs.flatMap((p) => wrapGreedy(p, mid, measure)).length;
    if (n > greedy.length) lo = mid;
    else hi = mid;
  }
  return paragraphs.flatMap((p) => wrapGreedy(p, hi, measure));
}

export interface FitRule {
  /** Box width the text must fit. */
  width: number;
  /** Largest and smallest size (pixels); the text shrinks within this range before it wraps more. */
  max: number;
  min: number;
  /** Most lines allowed. */
  lines: number;
}

export interface Fitted {
  size: number;
  lines: string[];
  /** The text didn't fit even at the smallest size: the last line ends in "…". */
  cut: boolean;
}

/**
 * The size and lines for `text` under `rule`. `measureAt(size)` gives a measure for that size.
 * Sizes step down in 4% steps from `max` to `min`; the first that fits in `lines` lines wins.
 */
export function fitText(text: string, rule: FitRule, measureAt: (size: number) => Measure): Fitted {
  const clean = text.replace(/\r/g, "");
  let size = rule.max;
  for (;;) {
    const measure = measureAt(size);
    const lines = wrapBalanced(clean, rule.width, measure);
    if (lines.length <= rule.lines && lines.every((l) => measure(l) <= rule.width + 0.5)) return { size, lines, cut: false };
    const next = Math.max(rule.min, size * 0.96);
    if (size <= rule.min + 1e-6) {
      // Smallest size and still too long: keep what fits and end with an ellipsis.
      const kept = lines.slice(0, Math.max(1, rule.lines));
      let last = kept[kept.length - 1];
      const units = graphemes(last);
      while (units.length > 1 && measure(units.join("") + "…") > rule.width) units.pop();
      last = units.join("").trimEnd() + "…";
      kept[kept.length - 1] = last;
      return { size, lines: kept, cut: true };
    }
    size = next;
  }
}

/** Numbers in a price or count ("৳4,999", "-40%", "১,২০০") and how to write a value the same way. */
export interface NumberShape {
  prefix: string;
  suffix: string;
  value: number;
  decimals: number;
  bangla: boolean;
  /** Lakh grouping (12,34,567) rather than thousands (1,234,567). */
  lakh: boolean;
  grouped: boolean;
}

const BN = "০১২৩৪৫৬৭৮৯";

export function parseNumber(text: string): NumberShape | null {
  const latin = text.replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));
  const m = /^(.*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s.exec(latin);
  if (!m) return null;
  const digits = m[2];
  const value = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const whole = digits.split(".")[0].replace("-", "");
  const groups = whole.split(",");
  return {
    prefix: m[1],
    suffix: m[3],
    value,
    decimals: digits.includes(".") ? digits.split(".")[1].length : 0,
    bangla: /[০-৯]/.test(text),
    grouped: groups.length > 1,
    lakh: groups.length > 2 && groups.slice(1, -1).every((g) => g.length === 2),
  };
}

export function formatNumber(shape: NumberShape, value: number): string {
  const fixed = Math.abs(value).toFixed(shape.decimals);
  let [whole, frac] = fixed.split(".");
  if (shape.grouped) {
    if (shape.lakh && whole.length > 3) {
      const head = whole.slice(0, -3), tail = whole.slice(-3);
      whole = head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail;
    } else whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  let out = (value < 0 ? "-" : "") + whole + (frac ? `.${frac}` : "");
  if (shape.bangla) out = out.replace(/\d/g, (d) => BN[Number(d)]);
  return shape.prefix + out + shape.suffix;
}
