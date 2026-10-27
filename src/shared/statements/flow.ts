import { listen } from "@tauri-apps/api/event";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { openDialog } from "../../modules/time/dialog";
import { errorText, extensionOf, PICTURE_EXTENSIONS, statementsApi, type Statement, type TextItem } from "./api";
import { pdfText } from "./pdftext";
import { reviewStatement, saveAsExcel, type WalletPart } from "./review";

/** What the place opening a statement offers (Wallet, or the PDF app for Excel only). */
export interface StatementHost {
  toast(text: string, action?: { label: string; run: () => void }): void;
  /** Opens Settings on a category ("ai"). */
  openSettings(category: string): void;
  openInSheets?(path: string): void;
  /** Wallet's part; without it the statement can only be saved as Excel. */
  wallet?(statement: Statement): WalletPart;
  /**
   * When the statement should go straight to Wallet without the review (the check passed and
   * the account is known): returns true when it did.
   */
  autoImport?(statement: Statement): Promise<boolean>;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A small window while something reads, with Stop when it can be stopped. */
function working(title: string, text: string, stop?: () => void) {
  const line = h("p", { class: "sr-working-text" }, text);
  const dialog = openDialog({
    title,
    icon: "sparkles",
    tone: "work",
    class: "wl-dialog sr-working",
    body: [h("div", { class: "sr-working-row" }, h("div", { class: "spinner" }), line)],
    foot: [h("span", { class: "spacer" }), stop ? h("button", { class: "btn", type: "button", onclick: () => stop() }, icon("stop", 13), "Stop") : null],
  });
  return { dialog, set: (t: string) => (line.textContent = t) };
}

/** Reads the file without Claude: CSV and Excel in Rust, a PDF's text here. */
async function readLocally(path: string): Promise<{ statement: Statement | null; items: TextItem[] | null }> {
  const ext = extensionOf(path);
  if (PICTURE_EXTENSIONS.includes(ext)) return { statement: null, items: null };
  if (ext === "pdf") {
    const items = await pdfText(path);
    return { statement: await statementsApi.fromItems(items, nameOf(path)), items };
  }
  return { statement: await statementsApi.read(path), items: null };
}

/** Claude reads the file (the user agreed in Settings → AI), with progress and Stop. */
async function readWithClaude(path: string, items: TextItem[] | null): Promise<Statement | null> {
  let stopped = false;
  const w = working("Claude is reading", `Sending “${nameOf(path)}” to Claude…`, () => {
    stopped = true;
    void statementsApi.aiCancel();
  });
  const unlisten = await listen<number>("statement-ai-progress", (e) => w.set(`Reading “${nameOf(path)}”: ${e.payload.toLocaleString()} characters so far…`));
  try {
    return await statementsApi.ai(path, items);
  } catch (err) {
    if (stopped) return null;
    throw err;
  } finally {
    unlisten();
    w.dialog.close();
  }
}

/** Why Claude can't read it yet, with the way to turn it on. */
function needsClaude(host: StatementHost, path: string, why: string) {
  const dialog = openDialog({
    title: "This statement needs Claude",
    subtitle: nameOf(path),
    icon: "sparkles",
    tone: "work",
    class: "wl-dialog",
    body: [
      h("p", null, why),
      h("p", { class: "tt-hint" }, "Claude (Anthropic's AI) can read scans, photos and unusual layouts. It's off until you add your API key and agree, in Settings → AI, that statements are sent to Anthropic to be read."),
    ],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Close"),
      h("button", { class: "btn primary", type: "button", onclick: () => (dialog.close(), host.openSettings("ai")) }, "Open Settings → AI")],
  });
}

/**
 * Opens a statement: reads it (CSV, Excel and PDFs with text without AI; scans and photos with
 * Claude when the user turned that on), then either imports it straight away (Wallet, when the
 * check passed and that's turned on) or shows the review.
 */
export async function openStatement(path: string, host: StatementHost): Promise<void> {
  let statement: Statement | null = null;
  let items: TextItem[] | null = null;
  const reading = working("Reading the statement", `Reading “${nameOf(path)}”…`);
  try {
    ({ statement, items } = await readLocally(path));
  } catch (err) {
    reading.dialog.close();
    if (extensionOf(path) === "pdf" && (err as Error)?.name === "Cancelled") return;
    host.toast(`Couldn't read “${nameOf(path)}”: ${errorText(err)}`);
    return;
  }
  reading.dialog.close();

  const unread = !statement || statement.confidence === "none";
  if (unread) {
    const ai = await statementsApi.aiState().catch(() => null);
    const why = !statement
      ? "It's a picture, so its text has to be read first."
      : statement.warnings[0] ?? "Zazabor couldn't find a table of transactions in it.";
    if (!ai?.consent || !ai.hasKey) return needsClaude(host, path, why);
    try {
      statement = await readWithClaude(path, items);
    } catch (err) {
      host.toast(errorText(err));
      return;
    }
    if (!statement) return;
  }
  show(path, statement!, items, host);
}

/** The review, or the import straight away. */
async function show(path: string, statement: Statement, items: TextItem[] | null, host: StatementHost) {
  if (host.autoImport && (await host.autoImport(statement).catch((err) => (host.toast(errorText(err)), false)))) return;
  reviewStatement({
    statement,
    wallet: host.wallet?.(statement),
    toast: host.toast,
    openInSheets: host.openInSheets,
    useAi: statement.source === "ai" ? undefined : () => void again(),
  });

  async function again() {
    const ai = await statementsApi.aiState().catch(() => null);
    if (!ai?.consent || !ai.hasKey) return needsClaude(host, path, "Reading it again with Claude needs the AI settings.");
    try {
      const read = await readWithClaude(path, items);
      if (read) void show(path, read, items, host);
    } catch (err) {
      host.toast(errorText(err));
    }
  }
}

/** For the PDF app: a statement straight to Excel, after the review. */
export async function statementToExcel(path: string, host: StatementHost) {
  await openStatement(path, { ...host, wallet: undefined, autoImport: undefined });
}

/** "Tables to Excel": every table in the PDF, a sheet each. */
export async function tablesToExcel(path: string, host: StatementHost, save: (defaultName: string) => Promise<string | null>) {
  const w = working("Finding tables", `Reading “${nameOf(path)}”…`);
  let items: TextItem[];
  try {
    items = await pdfText(path);
  } catch (err) {
    w.dialog.close();
    if ((err as Error)?.name !== "Cancelled") host.toast(`Couldn't read “${nameOf(path)}”: ${errorText(err)}`);
    return;
  }
  w.dialog.close();
  if (items.length < 20) return host.toast("This PDF has little or no text (a scan?), so there are no tables to copy.");
  const out = await save(`${nameOf(path).replace(/\.[^.]+$/, "")} tables.xlsx`);
  if (!out) return;
  try {
    const n = await statementsApi.tablesXlsx(items, out);
    host.toast(`Saved ${n} table${n === 1 ? "" : "s"} to ${nameOf(out)}`, host.openInSheets ? { label: "Open in Sheets", run: () => host.openInSheets!(out) } : undefined);
  } catch (err) {
    host.toast(errorText(err));
  }
}

export { saveAsExcel };
