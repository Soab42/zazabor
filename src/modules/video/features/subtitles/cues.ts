import type { Cue } from "./types";

/** Cues sorted by start, searchable by time. */
export class CueIndex {
  readonly cues: readonly Cue[];
  /** Running maximum of the cues' end times, so a search can stop early. */
  private readonly maxEnd: number[];

  constructor(cues: Cue[]) {
    this.cues = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
    let max = -Infinity;
    this.maxEnd = this.cues.map((cue) => (max = Math.max(max, cue.end)));
  }

  /** Index of the first cue starting after `time` (cues.length when none). */
  private firstStartingAfter(time: number): number {
    let lo = 0, hi = this.cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cues[mid].start <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Cues on screen at `time` (start inclusive, end exclusive), in start order. */
  at(time: number): Cue[] {
    const out: Cue[] = [];
    for (let i = this.firstStartingAfter(time) - 1; i >= 0 && this.maxEnd[i] > time; i--) {
      if (this.cues[i].end > time) out.push(this.cues[i]);
    }
    return out.reverse();
  }

  /** Cues overlapping [from, to), in start order. */
  between(from: number, to: number): Cue[] {
    const out: Cue[] = [];
    for (let i = this.firstStartingAfter(to - 1) - 1; i >= 0 && this.maxEnd[i] > from; i--) {
      if (this.cues[i].end > from) out.push(this.cues[i]);
    }
    return out.reverse();
  }

  get length(): number {
    return this.cues.length;
  }
}
