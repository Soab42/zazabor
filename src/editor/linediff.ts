/** A run of changed lines in the new text, for the editor's gutter (1-based, inclusive). */
export interface LineChange {
  kind: "added" | "modified" | "deleted";
  /** First and last new line; for "deleted", the line after which lines were removed (0 = top). */
  start: number;
  end: number;
}

/** Above this many lines on either side the gutter stays empty rather than slowing typing down. */
const MAX_LINES = 20_000;

/**
 * Which lines of `next` differ from `base`: Myers' diff over lines, folded into added, modified
 * and deleted runs the way editors mark them in the gutter.
 */
export function lineChanges(base: string, next: string): LineChange[] {
  const a = base.split("\n");
  const b = next.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return [];
  // Common prefix and suffix are unchanged; diff only the middle.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  const ops = myers(aMid, bMid);

  // Group consecutive deletes/inserts into hunks, then classify them.
  const changes: LineChange[] = [];
  let i = 0;
  let bLine = head; // lines of `b` consumed so far
  while (i < ops.length) {
    if (ops[i] === "=") {
      bLine++;
      i++;
      continue;
    }
    let deleted = 0;
    let inserted = 0;
    while (i < ops.length && ops[i] !== "=") {
      if (ops[i] === "-") deleted++;
      else inserted++;
      i++;
    }
    if (inserted === 0) changes.push({ kind: "deleted", start: bLine, end: bLine });
    else {
      const modified = Math.min(deleted, inserted);
      if (modified > 0) changes.push({ kind: "modified", start: bLine + 1, end: bLine + modified });
      if (inserted > modified) changes.push({ kind: "added", start: bLine + modified + 1, end: bLine + inserted });
      else if (deleted > inserted) changes.push({ kind: "deleted", start: bLine + inserted, end: bLine + inserted });
    }
    bLine += inserted;
  }
  return changes;
}

/** The edit script turning `a` into `b`: "=" keep, "-" delete from a, "+" insert from b. */
function myers(a: string[], b: string[]): ("=" | "-" | "+")[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk the trace back to recover the path.
  const ops: ("=" | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push("+");
      y--;
    } else {
      ops.push("-");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  return ops.reverse();
}
