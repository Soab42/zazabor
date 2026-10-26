import type { Currency } from "./api";

/** Known currencies (from the backend), for symbols and decimals. */
const currencies = new Map<string, Currency>();
export let BASE = "BDT";

export function setCurrencies(list: Currency[], base: string) {
  currencies.clear();
  for (const c of list) currencies.set(c.code, c);
  BASE = base;
}

export const exponentOf = (code: string) => currencies.get(code)?.exponent ?? 2;
export const symbolOf = (code: string) => currencies.get(code)?.symbol ?? `${code} `;

/** Taka and rupees group in lakhs and crores (1,25,000); other currencies in thousands. */
const grouping = (code: string) => (code === "BDT" || code === "INR" ? "en-IN" : "en-US");

const MINUS = "−";

export interface MoneyOptions {
  /** Show as ••• (Hide amounts). */
  hidden?: boolean;
  /** "+" before money in, "−" before money out (default: only "−"). */
  signed?: boolean;
  /** Keep the decimals even when they're zero. */
  decimals?: boolean;
}

/** "৳1,25,000", "−৳250.50", "$12.99"; whole amounts drop ".00". */
export function money(minor: number, code = BASE, options: MoneyOptions = {}): string {
  const symbol = symbolOf(code);
  const sign = minor < 0 ? MINUS : options.signed && minor > 0 ? "+" : "";
  if (options.hidden) return `${sign}${symbol}•••`;
  const exp = exponentOf(code);
  const unit = 10 ** exp;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / unit);
  const frac = abs % unit;
  let text = whole.toLocaleString(grouping(code));
  if (exp > 0 && (frac !== 0 || options.decimals)) text += `.${String(frac).padStart(exp, "0")}`;
  return `${sign}${symbol}${text}`;
}

/** Short, for chart axes: ৳500, ৳12k, ৳1.2L, ৳3.4Cr (taka); $1.2M elsewhere. */
export function compact(minor: number, code = BASE, hidden = false): string {
  if (hidden) return `${symbolOf(code)}•••`;
  const value = Math.abs(minor) / 10 ** exponentOf(code);
  const sign = minor < 0 ? MINUS : "";
  const lakhs = code === "BDT" || code === "INR";
  const steps: [number, string][] = lakhs ? [[1e7, "Cr"], [1e5, "L"], [1e3, "k"]] : [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of steps) {
    if (value >= size) {
      const n = value / size;
      return `${sign}${symbolOf(code)}${n >= 100 ? Math.round(n) : Number(n.toFixed(1))}${suffix}`;
    }
  }
  return `${sign}${symbolOf(code)}${Math.round(value)}`;
}

/** The amount as it would be typed back into a field: "1250.5" (no grouping, no sign). */
export function plain(minor: number, code = BASE): string {
  const exp = exponentOf(code);
  const abs = Math.abs(minor);
  const unit = 10 ** exp;
  const frac = abs % unit;
  return frac ? `${Math.floor(abs / unit)}.${String(frac).padStart(exp, "0").replace(/0+$/, "")}` : String(Math.floor(abs / unit));
}

// ---- dates ("YYYY-MM-DD" and "YYYY-MM", local)

const pad = (n: number) => String(n).padStart(2, "0");

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayKey = () => dateKey(new Date());
export const thisMonth = () => todayKey().slice(0, 7);

export function parseDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthStart(month: string) {
  return `${month}-01`;
}

export function monthEnd(month: string) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${pad(new Date(y, m, 0).getDate())}`;
}

/** "October 2026" ("October" in the current year). */
export function monthLabel(month: string, withYear = true): string {
  const d = parseDate(`${month}-01`);
  return d.toLocaleDateString(undefined, { month: "long", year: withYear || d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}

export function shortMonth(month: string): string {
  return parseDate(`${month}-01`).toLocaleDateString(undefined, { month: "short" });
}

/** "Today", "Yesterday", "Monday, 26 October" (with the year when it isn't this one). */
export function dayLabel(key: string): string {
  if (key === todayKey()) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (key === dateKey(y)) return "Yesterday";
  const d = parseDate(key);
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** "26 Oct" (with the year when it isn't this one). */
export function shortDate(key: string): string {
  const d = parseDate(key);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
