import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { field, openDialog } from "../../modules/time/dialog";
import type { Account } from "../../modules/wallet/api";
import { money } from "../../modules/wallet/format";
import { save as saveFile } from "../dialog";
import { errorText, statementsApi, type Statement } from "./api";
import "./statements.css";

/** Rows drawn at most (all of them are saved and imported). */
const SHOWN = 400;

/** What Wallet adds to the review: the account to import into, and the import itself. */
export interface WalletPart {
  accounts: Account[];
  /** The account this statement seems to be for, or null. */
  account: string | null;
  /** Imports the statement's rows, minus those left out (by index), into the account ("new" makes one). */
  run(statement: Statement, accountId: string, excluded: Set<number>): Promise<void>;
  /** The rows (by index) already in the account. */
  existing(statement: Statement, accountId: string): Promise<Set<number>>;
}

export interface ReviewOptions {
  statement: Statement;
  wallet?: WalletPart;
  /** Reads the file again with Claude (offered unless Claude read it). */
  useAi?: () => void;
  toast(text: string, action?: { label: string; run: () => void }): void;
  openInSheets?(path: string): void;
}

const SOURCE: Record<Statement["source"], string> = {
  csv: "Read from the CSV file",
  xlsx: "Read from the Excel file",
  pdf: "Read from the PDF's text",
  ai: "Read by Claude",
};

/** "city-oct.pdf" → "city-oct". */
const stem = (name: string) => name.replace(/\.[^.]+$/, "");

const show = (minor: number | null, code: string) => (minor == null ? "—" : money(minor, code, { decimals: true }));

/** Saves the statement as an .xlsx the user picks; offers to open it in Sheets. */
export async function saveAsExcel(st: Statement, toast: ReviewOptions["toast"], openInSheets?: (path: string) => void): Promise<boolean> {
  const path = await saveFile({ title: "Save as Excel", defaultPath: `${stem(st.file)} transactions.xlsx`, filters: [{ name: "Excel workbook", extensions: ["xlsx"] }] });
  if (!path) return false;
  await statementsApi.saveXlsx(st, path);
  const name = path.slice(path.lastIndexOf("/") + 1);
  toast(`Saved ${st.rows.length} transactions to ${name}`, openInSheets ? { label: "Open in Sheets", run: () => openInSheets(path) } : undefined);
  return true;
}

/**
 * The statement as read: where it came from, what its own numbers say (the balance check), every
 * row with the ones that need a look marked, and what to do with it (Excel; Wallet).
 */
export function reviewStatement(o: ReviewOptions) {
  const st = o.statement;
  const cur = st.currency;
  const excluded = new Set<number>();
  /** Rows the account already has (from an earlier import, or typed by hand). */
  let existing = new Set<number>();
  const c = st.check;

  const tone = c.status === "ok" ? "good" : c.status === "mismatch" ? "warn" : "plain";
  const banner = h("div", { class: `sr-check ${tone}` },
    icon(c.status === "ok" ? "check" : c.status === "mismatch" ? "stAlert" : "info", 16),
    h("div", null, h("strong", null, c.status === "ok" ? "The balances add up" : c.status === "mismatch" ? "The balances don't add up" : "Not checked"), h("p", null, c.message)));
  const facts = h("div", { class: "sr-facts" },
    ...([
      ["Opening", show(st.opening, cur) + (c.derivedOpening ? " *" : "")],
      ["Money in", show(c.credits, cur)],
      ["Money out", show(c.debits, cur)],
      ["Closing", show(st.closing, cur)],
    ] as const).map(([label, value]) => h("div", { class: "sr-fact" }, h("span", null, label), h("strong", null, value))));
  const who = [st.bank, st.accountLast4 ? `••••${st.accountLast4}` : null, st.periodFrom && st.periodTo ? `${st.periodFrom} – ${st.periodTo}` : null].filter(Boolean).join(" · ");
  const warnings = st.warnings.length ? h("ul", { class: "sr-warnings" }, ...st.warnings.map((w) => h("li", null, w))) : null;

  const count = h("span", { class: "sr-count" });
  const flagged = st.rows.filter((r) => r.flag).length;
  const boxes: (HTMLInputElement | null)[] = [];
  const rowEls: HTMLElement[] = [];
  const rows = st.rows.slice(0, SHOWN).map((r, i) => {
    const include = o.wallet ? h("input", { type: "checkbox", "aria-label": `Add row ${i + 1}` }) : null;
    boxes.push(include);
    if (include) {
      include.checked = true;
      include.addEventListener("change", () => (include.checked ? excluded.delete(i) : excluded.add(i), update()));
    }
    const el = h("div", { class: `sr-row${r.flag ? " flagged" : ""}`, title: r.flag ?? "" },
      include ?? h("span", null),
      h("span", { class: "sr-date" }, r.date || "—"),
      h("span", { class: "sr-desc" }, r.description || "—", r.reference ? h("span", { class: "sr-ref" }, ` ${r.reference}`) : null),
      h("span", { class: "sr-out" }, r.debit != null ? show(r.debit, cur) : ""),
      h("span", { class: "sr-in" }, r.credit != null ? show(r.credit, cur) : ""),
      h("span", { class: "sr-bal" }, r.balance != null ? show(r.balance, cur) : ""),
      r.flag ? h("span", { class: "sr-flag", "aria-label": r.flag }, icon("stAlert", 13)) : h("span", null));
    rowEls.push(el);
    return el;
  });
  const table = h("div", { class: "sr-table" },
    h("div", { class: "sr-row head" }, h("span", null), h("span", null, "Date"), h("span", null, "Description"), h("span", null, "Out"), h("span", null, "In"), h("span", null, "Balance"), h("span", null)),
    ...rows,
    st.rows.length > SHOWN ? h("p", { class: "tt-hint" }, `And ${st.rows.length - SHOWN} more rows (all of them are saved and added).`) : null);

  // Wallet: which account, and the import.
  let account: HTMLSelectElement | null = null;
  if (o.wallet) {
    const w = o.wallet;
    account = h("select", { class: "wl-select", "aria-label": "Into account" },
      ...w.accounts.filter((a) => !a.archived).map((a) => h("option", { value: a.id, selected: a.id === w.account }, `${a.name} (${a.currency})`)),
      h("option", { value: "new", selected: !w.account }, `New account: ${st.bank ?? "Statement"}${st.accountLast4 ? ` ••${st.accountLast4}` : ""}`));
  }
  const importButton = o.wallet ? h("button", { class: "btn primary", type: "button", onclick: () => void runImport() }, "Import") : null;
  const excel = h("button", { class: `btn${o.wallet ? "" : " primary"}`, type: "button", onclick: () => void excelSave() }, icon("saveAs", 14), "Save as Excel…");
  const ai = o.useAi && st.source !== "ai" ? h("button", { class: "btn ghost", type: "button", title: "Send the statement to Claude to read it (Settings → AI)", onclick: () => (dialog.close(), o.useAi!()) }, icon("sparkles", 14), "Read with Claude…") : null;

  const dialog = openDialog({
    title: st.file,
    subtitle: [SOURCE[st.source], who].filter(Boolean).join(" · "),
    icon: st.source === "ai" ? "sparkles" : "stStatement",
    tone: "work",
    class: "wl-dialog sr-dialog",
    body: [banner, facts, warnings, account ? field("Add to", account) : null, h("div", { class: "sr-table-head" }, h("h4", null, "Transactions"), count), table],
    foot: [ai, h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Close"), excel, importButton],
  });

  function update() {
    const n = st.rows.filter((_, i) => !excluded.has(i) && !existing.has(i)).length;
    count.textContent = `${st.rows.length} row${st.rows.length === 1 ? "" : "s"}${flagged ? ` · ${flagged} to look at` : ""}${existing.size ? ` · ${existing.size === st.rows.length ? "all" : existing.size} already in Wallet` : ""}`;
    rowEls.forEach((el, i) => el.classList.toggle("known", existing.has(i)));
    boxes.forEach((b, i) => {
      if (!b) return;
      b.disabled = existing.has(i);
      b.checked = !existing.has(i) && !excluded.has(i);
    });
    if (importButton) {
      importButton.textContent = n ? `Import ${n} Transaction${n === 1 ? "" : "s"}` : existing.size ? "Already in Wallet" : "Nothing to Import";
      (importButton as HTMLButtonElement).disabled = n === 0;
    }
  }
  update();

  /** Which rows the chosen account already has. */
  async function check() {
    if (!o.wallet || !account) return;
    const id = account.value;
    if (id === "new") existing = new Set();
    else {
      try {
        existing = await o.wallet.existing(st, id);
      } catch {
        existing = new Set();
      }
      if (account.value !== id) return;
    }
    update();
  }
  account?.addEventListener("change", () => void check());
  void check();

  async function excelSave() {
    dialog.error("");
    try {
      await saveAsExcel(st, o.toast, o.openInSheets);
    } catch (err) {
      dialog.error(errorText(err));
    }
  }

  async function runImport() {
    if (!o.wallet || !account) return;
    dialog.busy(true);
    dialog.error("");
    try {
      await o.wallet.run(st, account.value, excluded);
      dialog.close();
    } catch (err) {
      // The error line sits under the table; a toast is seen wherever the dialog is scrolled.
      dialog.error(errorText(err));
      o.toast(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }
  return dialog;
}
