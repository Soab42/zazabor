import { invoke } from "@tauri-apps/api/core";
import type { Mapping } from "../../modules/wallet/api";

/**
 * Bank and wallet statements read into transactions (src-tauri/src/statements): CSV and Excel in
 * Rust, a PDF's text through pdf.js here and the table rebuilt in Rust, and scans or photos by
 * Claude when the user turned that on in Settings → AI. Amounts are minor units (poisha).
 */

export interface StatementRow {
  date: string;
  description: string;
  reference: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  /** Why the row needs a look; the numbers are never changed. */
  flag: string | null;
}

export interface StatementCheck {
  /** "ok", "mismatch" or "unchecked". */
  status: "ok" | "mismatch" | "unchecked";
  breaks: number;
  credits: number;
  debits: number;
  expectedClosing: number | null;
  difference: number | null;
  derivedOpening: boolean;
  message: string;
}

export interface Statement {
  source: "csv" | "xlsx" | "pdf" | "ai";
  file: string;
  bank: string | null;
  accountLast4: string | null;
  currency: string;
  periodFrom: string | null;
  periodTo: string | null;
  opening: number | null;
  closing: number | null;
  rows: StatementRow[];
  warnings: string[];
  check: StatementCheck;
  /** "good", "partial" (some lines unread) or "none" (no table found). */
  confidence: "good" | "partial" | "none";
}

/** A piece of a PDF's text: left edge and baseline from the top left, width, font size. */
export interface TextItem {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  s: string;
}

export interface AiState {
  hasKey: boolean;
  keyStore: "keyring" | "file" | "";
  model: string;
  consent: boolean;
}

export interface Staged {
  path: string;
  mapping: Mapping;
}

export const statementsApi = {
  read: (path: string) => invoke<Statement>("statement_read", { path }),
  fromItems: (items: TextItem[], file: string) => invoke<Statement>("statement_from_items", { items, file }),
  saveXlsx: (statement: Statement, path: string) => invoke<void>("statement_save_xlsx", { statement, path }),
  tablesXlsx: (items: TextItem[], path: string) => invoke<number>("statement_tables_xlsx", { items, path }),
  ai: (path: string, items: TextItem[] | null) => invoke<Statement>("statement_ai", { path, items }),
  aiCancel: () => invoke<void>("statement_ai_cancel"),
  stage: (statement: Statement) => invoke<Staged>("statement_stage", { statement }),
  aiState: () => invoke<AiState>("ai_state_get"),
  aiSettings: (model: string, consent: boolean) => invoke<AiState>("ai_settings_set", { model, consent }),
  aiKeySet: (key: string) => invoke<AiState>("ai_key_set", { key }),
  aiKeyClear: () => invoke<AiState>("ai_key_clear"),
  aiTest: () => invoke<string>("ai_test"),
};

/** Statements Zazabor reads (any of these can go to Excel or Wallet). */
export const STATEMENT_EXTENSIONS = ["pdf", "csv", "tsv", "txt", "xlsx", "xlsm", "jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp"];
export const PICTURE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "tif", "tiff", "bmp", "gif"];

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
