import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `src-tauri/src/wallet/`. Amounts are integers in minor units (poisha, cents). */
export type AccountKind = "cash" | "bank" | "mobile_wallet" | "card" | "savings";
export type TxKind = "expense" | "income" | "transfer";

export interface Currency {
  code: string;
  symbol: string;
  exponent: number;
  name: string;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingMinor: number;
  color: string;
  archived: boolean;
  position: number;
  /** In the account's currency. */
  balanceMinor: number;
  /** In the base currency at the latest rate; null without a rate. */
  balanceBaseMinor: number | null;
  txCount: number;
  lastDate: string | null;
}

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  kind: "expense" | "income";
  icon: string;
  color: string;
  archived: boolean;
  position: number;
}

export interface Rate {
  currency: string;
  /** Base units per unit, in millionths. */
  rateMicro: number;
  updated: number;
}

export interface WalletState {
  base: string;
  currencies: Currency[];
  accounts: Account[];
  categories: Category[];
  rates: Rate[];
  payees: string[];
}

export interface Tx {
  id: string;
  accountId: string;
  currency: string;
  /** "YYYY-MM-DD". */
  date: string;
  /** Signed: negative is money out of the account. */
  amountMinor: number;
  baseMinor: number;
  rateMicro: number;
  categoryId: string | null;
  payee: string;
  note: string;
  transferId: string | null;
  kind: TxKind;
  counterAccountId: string | null;
  created: number;
  /** Receipts attached. */
  receipts: number;
  /** The bill that posted it. */
  recurringId: string | null;
  /** The import that added it. */
  importBatch: string | null;
}

export interface Filter {
  from?: string | null;
  to?: string | null;
  accountId?: string | null;
  categoryId?: string | null;
  kind?: TxKind | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface TxPage {
  items: Tx[];
  total: number;
  incomeMinor: number;
  spendingMinor: number;
}

export interface TxInput {
  id?: string | null;
  kind: "expense" | "income";
  accountId: string;
  /** As typed, without a sign. */
  amount: string;
  date: string;
  categoryId: string | null;
  payee: string;
  note: string;
}

export interface TransferInput {
  transferId?: string | null;
  from: string;
  to: string;
  amount: string;
  received?: string | null;
  fee?: string | null;
  date: string;
  note: string;
}

export interface Transfer {
  transferId: string;
  from: string;
  to: string;
  amountMinor: number;
  receivedMinor: number;
  feeMinor: number;
  date: string;
  note: string;
}

export interface Guess {
  kind: "expense" | "income";
  amount: string;
  amountMinor: number | null;
  accountId: string | null;
  categoryId: string | null;
  date: string;
  payee: string;
}

export interface BudgetRow {
  categoryId: string;
  /** As set for the month, without what rolled over. */
  budgetMinor: number | null;
  spentMinor: number;
  /** What's left of last month's budget is added. */
  rollover: boolean;
  carryMinor: number;
}

export type Freq = "daily" | "weekly" | "monthly" | "yearly";

export interface Bill {
  id: string;
  kind: "expense" | "income";
  accountId: string;
  currency: string;
  /** Unsigned, in the account's currency. */
  amountMinor: number;
  categoryId: string | null;
  payee: string;
  note: string;
  freq: Freq;
  every: number;
  /** Monthly: day of the month, 0 for the last day. */
  day: number;
  startDate: string;
  endDate: string | null;
  nextDate: string | null;
  autoPost: boolean;
  subscription: boolean;
  remindDays: number;
  paused: boolean;
  yearlyBaseMinor: number | null;
  /** Missed due dates still waiting (reminders only). */
  overdue: number;
  lastDate: string | null;
}

export interface BillInput {
  id?: string | null;
  kind: "expense" | "income";
  accountId: string;
  amount: string;
  categoryId: string | null;
  payee: string;
  note: string;
  freq: Freq;
  every: number;
  day?: number | null;
  startDate: string;
  endDate?: string | null;
  autoPost: boolean;
  subscription: boolean;
  remindDays: number;
}

export interface Receipt {
  id: string;
  transactionId: string;
  /** The stored copy. */
  path: string;
  name: string;
  mime: string;
  size: number;
  created: number;
}

export interface Mapping {
  headerRow: number;
  date: number;
  description: number | null;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  category: number | null;
  /** A column naming the account (Wallet's own export): rows for another account go there. */
  account?: number | null;
  dateOrder: "dmy" | "mdy" | "ymd";
  sign: "negative-out" | "positive-out";
  decimalComma: boolean;
}

export interface ImportRow {
  line: number;
  date: string | null;
  payee: string;
  amountMinor: number | null;
  categoryId: string | null;
  rule: string | null;
  duplicate: boolean;
  /** Another account the row goes to (named by the account column). */
  accountId?: string | null;
  error: string | null;
}

export interface ImportPreview {
  mapping: Mapping;
  columns: string[];
  sample: string[][];
  sheets: string[];
  rows: ImportRow[];
  newCount: number;
  duplicates: number;
  errors: number;
}

export interface RowEdit {
  line: number;
  include: boolean;
  categoryId: string | null;
  payee?: string | null;
}

export interface Batch {
  id: string;
  accountId: string;
  file: string;
  added: number;
  skipped: number;
  created: number;
  undone: boolean;
  remaining: number;
}

export interface Profile {
  id: string;
  name: string;
  accountId: string | null;
  mapping: Mapping;
}

export interface Rule {
  id?: string | null;
  pattern: string;
  categoryId: string | null;
  payee: string;
}

export interface ProjectRate {
  project: string;
  rateMinor: number;
  currency: string;
}

export interface Earning {
  project: string;
  minutes: number;
  rate: ProjectRate | null;
  amountMinor: number | null;
  baseMinor: number | null;
  posted: string | null;
}

export interface Earnings {
  rows: Earning[];
  rates: ProjectRate[];
  projects: string[];
}

export interface CategorySpend {
  categoryId: string;
  spentMinor: number;
  children: CategorySpend[];
}

export interface MonthTotals {
  month: string;
  incomeMinor: number;
  spendingMinor: number;
  netWorthMinor: number;
}

export interface Backup {
  name: string;
  size: number;
  modified: number;
}

export interface AccountInput {
  id?: string | null;
  name: string;
  kind: AccountKind;
  currency: string;
  opening: string;
  color: string;
  rate?: string | null;
}

export interface CategoryInput {
  id?: string | null;
  parentId: string | null;
  name: string;
  kind: "expense" | "income";
  icon: string;
  color: string;
}

export const walletApi = {
  state: () => invoke<WalletState>("wallet_state"),
  saveAccount: (account: AccountInput) => invoke<Account>("wallet_account_save", { account }),
  archiveAccount: (id: string, archived: boolean) => invoke<void>("wallet_account_archive", { id, archived }),
  deleteAccount: (id: string) => invoke<void>("wallet_account_delete", { id }),
  setRate: (currency: string, rate: string) => invoke<void>("wallet_rate_set", { currency, rate }),
  saveCategory: (category: CategoryInput) => invoke<Category>("wallet_category_save", { category }),
  deleteCategory: (id: string, moveTo: string | null) => invoke<void>("wallet_category_delete", { id, moveTo }),
  list: (filter: Filter) => invoke<TxPage>("wallet_tx_list", { filter }),
  saveTx: (tx: TxInput) => invoke<Tx>("wallet_tx_save", { tx }),
  deleteTxs: (ids: string[]) => invoke<number>("wallet_tx_delete", { ids }),
  setCategory: (ids: string[], categoryId: string | null) => invoke<number>("wallet_tx_set_category", { ids, categoryId }),
  saveTransfer: (transfer: TransferInput) => invoke<Transfer>("wallet_transfer_save", { transfer }),
  transfer: (id: string) => invoke<Transfer>("wallet_transfer", { id }),
  parse: (text: string, today: string) => invoke<Guess>("wallet_parse", { text, today }),
  budgets: (month: string) => invoke<BudgetRow[]>("wallet_budgets", { month }),
  setBudget: (month: string, categoryId: string, amount: string) => invoke<void>("wallet_budget_set", { month, categoryId, amount }),
  copyBudgets: (from: string, to: string) => invoke<number>("wallet_budgets_copy", { from, to }),
  byCategory: (from: string, to: string) => invoke<CategorySpend[]>("wallet_by_category", { from, to }),
  months: (last: string, count: number) => invoke<MonthTotals[]>("wallet_months", { last, count }),
  backups: () => invoke<Backup[]>("wallet_backups"),
  backupNow: () => invoke<void>("wallet_backup_now"),
  restore: (name: string) => invoke<void>("wallet_backup_restore", { name }),
  archiveCategory: (id: string, archived: boolean) => invoke<void>("wallet_category_archive", { id, archived }),
  setRollover: (month: string, categoryId: string, on: boolean) => invoke<void>("wallet_budget_rollover", { month, categoryId, on }),
  bills: (today: string) => invoke<Bill[]>("wallet_bills", { today }),
  saveBill: (bill: BillInput, today: string) => invoke<Bill>("wallet_bill_save", { bill, today }),
  pauseBill: (id: string, paused: boolean) => invoke<void>("wallet_bill_pause", { id, paused }),
  deleteBill: (id: string) => invoke<void>("wallet_bill_delete", { id }),
  payBill: (id: string, date: string | null, today: string) => invoke<Tx>("wallet_bill_pay", { id, date, today }),
  skipBill: (id: string, today: string) => invoke<void>("wallet_bill_skip", { id, today }),
  receipts: (transactionId: string) => invoke<Receipt[]>("wallet_receipts", { transactionId }),
  attach: (transactionId: string, paths: string[]) => invoke<Receipt[]>("wallet_receipt_attach", { transactionId, paths }),
  removeReceipt: (id: string) => invoke<void>("wallet_receipt_remove", { id }),
  importPreview: (path: string, sheet: number | null, accountId: string, mapping: Mapping | null) => invoke<ImportPreview>("wallet_import_preview", { path, sheet, accountId, mapping }),
  importCommit: (path: string, sheet: number | null, accountId: string, mapping: Mapping, edits: RowEdit[], label: string | null = null) => invoke<Batch>("wallet_import_commit", { path, sheet, accountId, mapping, edits, label }),
  importUndo: (id: string) => invoke<number>("wallet_import_undo", { id }),
  batches: () => invoke<Batch[]>("wallet_import_batches"),
  profiles: () => invoke<Profile[]>("wallet_profiles"),
  saveProfile: (name: string, accountId: string | null, mapping: Mapping) => invoke<Profile>("wallet_profile_save", { name, accountId, mapping }),
  deleteProfile: (id: string) => invoke<void>("wallet_profile_delete", { id }),
  rules: () => invoke<Rule[]>("wallet_rules"),
  saveRule: (rule: Rule) => invoke<Rule>("wallet_rule_save", { rule }),
  deleteRule: (id: string) => invoke<void>("wallet_rule_delete", { id }),
  exportTo: (kind: "csv" | "xlsx" | "json", filter: Filter, path: string) => invoke<number>("wallet_export", { kind, filter, path }),
  earnings: (month: string) => invoke<Earnings>("wallet_earnings", { month }),
  setProjectRate: (project: string, rate: string, currency: string) => invoke<void>("wallet_project_rate_set", { project, rate, currency }),
  postEarnings: (month: string, accountId: string, categoryId: string | null, today: string) => invoke<number>("wallet_earnings_post", { month, accountId, categoryId, today }),
};

export function onWalletChanged(fn: () => void): Promise<UnlistenFn> {
  return listen("wallet-changed", () => fn());
}

export function errorText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}
