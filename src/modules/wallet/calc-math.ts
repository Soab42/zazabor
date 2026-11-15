// The Wallet calculator's arithmetic, apart from the page so it can be tested on its own.

/**
 * Reads a sum as typed ("1,250 + 15%", "12 × (3 − 1)", "11135*60") and works it out, without
 * `eval`. The usual pocket-calculator percent: added to or taken off a number, a percent is of
 * that number (1500 + 10% is 1650); elsewhere it's a hundredth (200 × 5% is 10).
 */
export function calculate(text: string): number {
  const src = text.replace(/[×xX]/g, "*").replace(/[÷]/g, "/").replace(/[−–—]/g, "-").replace(/,/g, "").replace(/\s+/g, "");
  let at = 0;
  const peek = () => src[at];
  const fail = (): never => {
    throw new Error(at >= src.length ? "Incomplete" : `Unexpected “${src[at]}”`);
  };
  // A factor: a number or a bracket, maybe negated, maybe a percent.
  function factor(): { value: number; percent: boolean } {
    if (peek() === "-" || peek() === "+") {
      const sign = src[at++] === "-" ? -1 : 1;
      const f = factor();
      return { value: sign * f.value, percent: f.percent };
    }
    let value: number;
    if (peek() === "(") {
      at++;
      value = sum();
      if (peek() !== ")") fail();
      at++;
    } else {
      const match = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\./i.exec(src.slice(at));
      if (!match) fail();
      at += match![0].length;
      value = Number(match![0]);
    }
    if (peek() === "%") {
      at++;
      return { value, percent: true };
    }
    return { value, percent: false };
  }
  function term(): { value: number; percent: boolean } {
    let left = factor();
    while (peek() === "*" || peek() === "/") {
      const op = src[at++];
      const right = factor();
      const r = right.percent ? right.value / 100 : right.value;
      const l = left.percent ? left.value / 100 : left.value;
      if (op === "/" && r === 0) throw new Error("Can't divide by zero");
      left = { value: op === "*" ? l * r : l / r, percent: false };
    }
    return left;
  }
  function sum(): number {
    const first = term();
    let value = first.percent ? first.value / 100 : first.value;
    while (peek() === "+" || peek() === "-") {
      const op = src[at++];
      const right = term();
      const r = right.percent ? (value * right.value) / 100 : right.value;
      value = op === "+" ? value + r : value - r;
    }
    return value;
  }
  if (!src) return 0;
  const value = sum();
  if (at < src.length) fail();
  if (!Number.isFinite(value)) throw new Error("Too big");
  return value;
}

/** "1,23,456.78": grouped the way the subcontinent writes money, up to six decimals. */
export function showNumber(n: number): string {
  const rounded = Math.round(n * 1e6) / 1e6;
  return rounded.toLocaleString("en-IN", { maximumFractionDigits: 6 });
}
