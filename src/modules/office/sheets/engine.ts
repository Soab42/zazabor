import init, { Model, columnNameFromNumber, getAllTimezones, type Area } from "@ironcalc/wasm";

/**
 * IronCalc, the spreadsheet engine Sheets runs on (Rust compiled to wasm): formulas, styles,
 * merges, undo and the selection model. Loaded once, the first time a workbook opens.
 */

export { Model };
export type { Area };

/** Excel's grid. */
export const LAST_ROW = 1_048_576;
export const LAST_COLUMN = 16_384;

/** IronCalc's cell types (as Excel's TYPE()). */
export const CELL_NUMBER = 1;
export const CELL_TEXT = 2;
export const CELL_BOOLEAN = 4;
export const CELL_ERROR = 16;

/** The locale formulas and numbers are read in, and the language of function names. */
export const LOCALE = "en";
export const LANGUAGE = "en";

let ready: Promise<unknown> | null = null;
let zone: string | null = null;

export function loadEngine(): Promise<unknown> {
  return (ready ??= init());
}

/** The system's time zone when IronCalc knows it (NOW(), TODAY()), else UTC. */
export function timezone(): string {
  if (zone) return zone;
  const wanted = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    zone = getAllTimezones().includes(wanted) ? wanted : "UTC";
  } catch {
    zone = "UTC";
  }
  return zone;
}

export function blankModel(name: string): Model {
  return new Model(name, LOCALE, timezone(), LANGUAGE);
}

/** A model from IronCalc's bytes (an opened file), with no undo history. */
export function modelFromBytes(bytes: Uint8Array): Model {
  return Model.fromBytes(bytes, LANGUAGE);
}

export function columnName(column: number): string {
  return columnNameFromNumber(column);
}

/** "B3", or "B3:D7" for a range. */
export function rangeName(range: [number, number, number, number]): string {
  const [r1, c1, r2, c2] = range;
  const a = `${columnName(Math.min(c1, c2))}${Math.min(r1, r2)}`;
  if (r1 === r2 && c1 === c2) return a;
  // Whole columns and rows read as Excel writes them.
  if (Math.min(r1, r2) === 1 && Math.max(r1, r2) === LAST_ROW) return `${columnName(Math.min(c1, c2))}:${columnName(Math.max(c1, c2))}`;
  if (Math.min(c1, c2) === 1 && Math.max(c1, c2) === LAST_COLUMN) return `${Math.min(r1, r2)}:${Math.max(r1, r2)}`;
  return `${a}:${columnName(Math.max(c1, c2))}${Math.max(r1, r2)}`;
}

/** The selection's range, top-left to bottom-right. */
export function normalized(range: [number, number, number, number]): [number, number, number, number] {
  const [r1, c1, r2, c2] = range;
  return [Math.min(r1, r2), Math.min(c1, c2), Math.max(r1, r2), Math.max(c1, c2)];
}

export function areaOf(sheet: number, range: [number, number, number, number]): Area {
  const [r1, c1, r2, c2] = normalized(range);
  return { sheet, row: r1, column: c1, width: c2 - c1 + 1, height: r2 - r1 + 1 };
}

/** Parses "B3", "b3:d7", "C:C", "4:9" (no sheet names); null when it isn't a reference. */
export function parseRange(text: string): [number, number, number, number] | null {
  const t = text.trim().toUpperCase().replace(/\$/g, "");
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  let m = /^([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?$/.exec(t);
  if (m) {
    const r1 = Number(m[2]);
    const c1 = col(m[1]);
    const r2 = m[4] ? Number(m[4]) : r1;
    const c2 = m[3] ? col(m[3]) : c1;
    if ([r1, r2].every((r) => r >= 1 && r <= LAST_ROW) && [c1, c2].every((c) => c >= 1 && c <= LAST_COLUMN)) return normalized([r1, c1, r2, c2]);
    return null;
  }
  m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t);
  if (m) return normalized([1, col(m[1]), LAST_ROW, col(m[2])]);
  m = /^(\d{1,7}):(\d{1,7})$/.exec(t);
  if (m) return normalized([Number(m[1]), 1, Number(m[2]), LAST_COLUMN]);
  return null;
}

/** Sheet names in references: quoted when they need it ('My sheet'!A1). */
export function sheetPrefix(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? `${name}!` : `'${name.replace(/'/g, "''")}'!`;
}
