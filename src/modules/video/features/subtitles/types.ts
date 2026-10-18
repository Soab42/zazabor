/** A piece of cue text with one style. Text is always shown as text, never as HTML. */
export interface Run {
  text: string;
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
}

export interface Cue {
  /** Milliseconds from the start of the video. */
  start: number;
  end: number;
  /** Lines of styled runs. */
  lines: Run[][];
  /** Numpad alignment as in ASS `\an` (1–3 bottom, 4–6 middle, 7–9 top); 2 is the default. */
  align: number;
}
