import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `src-tauri/src/wallet/`. Amounts are integers in minor units (poisha, cents). */
export type AccountKind = "cash" | "bank" | "mobile_wallet" | "card" | "savings" | "dps" | "loan" | "person" | "fdr";
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
  /** Counts in the total balance and net worth (a loan doesn't by default). */
  inTotal: boolean;
  /** A card: its credit limit. */
  creditLimitMinor: number | null;
  /** A card: the day its statement closes (0: not set). */
  statementDay: number;
  /** A card: the day its payment is due (0: not set). */
  dueDay: number;
  details: AccountDetails;
  /** In the account's currency. */
  balanceMinor: number;
  /** In the base currency at the latest rate; null without a rate. */
  balanceBaseMinor: number | null;
  txCount: number;
  lastDate: string | null;
}

/** Optional details: the bank (or issuer, provider) and branch, the number (a card: its last
 * four digits), a phone (a mobile wallet's, a person's) and a note. */
export interface AccountDetails {
  institution: string;
  branch: string;
  number: string;
  phone: string;
  note: string;
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
  /** The DPS or loan it pays (changed in Loans & DPS). */
  planId: string | null;
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
  /** A transfer moves money to another of your accounts. */
  kind: "expense" | "income" | "transfer";
  accountId: string;
  toAccountId: string | null;
  /** "statement": pays what's due on a card's statement. */
  amountMode: "fixed" | "statement";
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
  kind: "expense" | "income" | "transfer";
  accountId: string;
  toAccountId?: string | null;
  amountMode?: "fixed" | "statement";
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

/** A DPS or a loan: an account with terms and the payments made on it. */
export interface Plan {
  id: string;
  kind: "dps" | "loan";
  accountId: string;
  name: string;
  color: string;
  currency: string;
  /** A DPS: the deposit each month. A loan: the amount borrowed. */
  amountMinor: number;
  /** Yearly rate in hundredths of a percent. */
  rateBp: number;
  months: number;
  startDate: string;
  /** "daily": by the day on what's owed (as banks do); "reducing": by the month; "flat". */
  method: "daily" | "reducing" | "flat";
  paymentTyped: number | null;
  maturityTyped: number | null;
  paidBefore: number;
  payFrom: string;
  autoPost: boolean;
  disburseDate: string;
  disburseTo: string | null;
  inTotal: boolean;
  paymentMinor: number;
  /** A loan: interest paid and still to pay. A DPS: the interest at maturity. */
  interestMinor: number;
  /** A loan: everything paid back. A DPS: the value at maturity. */
  totalMinor: number;
  installments: number;
  paid: number;
  nextNo: number | null;
  nextDate: string | null;
  overdue: number;
  endDate: string;
  /** A loan: still owed. A DPS: its value now. */
  outstandingMinor: number;
  unpaidInterestMinor: number;
  paidMinor: number;
  interestPaidMinor: number;
  balanceMinor: number;
}

export interface PlanRow {
  kind: "before" | "payment" | "missed" | "due" | "upcoming";
  /** The first installment it pays (null: a part payment). */
  no: number | null;
  count: number;
  date: string;
  paymentMinor: number;
  /** A loan: the principal part. A DPS: deposited so far. */
  principalMinor: number;
  /** A loan: the interest part. A DPS: interest earned so far. */
  interestMinor: number;
  /** A loan: still owed. A DPS: its value. */
  balanceMinor: number;
  unpaidInterestMinor: number;
  paymentId: string | null;
  fromAccount: string | null;
  interestTyped: number | null;
  note: string;
  transferId: string | null;
  /** The money moved in Wallet (false: recorded only, paid before). */
  posted: boolean;
}

export interface PlanDetail {
  plan: Plan;
  rows: PlanRow[];
}

export interface PlanInput {
  id?: string | null;
  kind: "dps" | "loan";
  name: string;
  color: string;
  amount: string;
  rate: string;
  months: number;
  startDate: string;
  method: Plan["method"];
  payment?: string | null;
  maturity?: string | null;
  paidBefore: number;
  payFrom: string;
  autoPost: boolean;
  disburseTo?: string | null;
  disburseDate?: string | null;
  inTotal?: boolean | null;
  details?: AccountDetails | null;
}

export interface PaymentInput {
  id?: string | null;
  planId: string;
  date: string;
  amount: string;
  /** The first installment it pays; null for a part payment. */
  no: number | null;
  count: number;
  /** A loan: the interest the bank charged, as typed; empty to work it out. */
  interest?: string | null;
  fromAccount?: string | null;
  note: string;
  /** Moves the money in Wallet; off for one paid before, kept only for the table. */
  posted: boolean;
}

/** A fixed deposit and its interest payments. */
export interface Fdr {
  id: string;
  accountId: string;
  name: string;
  color: string;
  currency: string;
  principalMinor: number;
  rateBp: number;
  months: number;
  startDate: string;
  payout: "monthly" | "quarterly" | "halfyearly" | "yearly" | "maturity";
  /** Source tax in hundredths of a percent. */
  taxBp: number;
  /** Where the interest goes; null: it stays in the FDR. */
  interestTo: string | null;
  fundedFrom: string | null;
  autoPost: boolean;
  inTotal: boolean;
  maturityDate: string;
  maturityValueMinor: number;
  interestMinor: number;
  taxMinor: number;
  netMinor: number;
  receivedMinor: number;
  payments: number;
  posted: number;
  nextDate: string | null;
  nextNetMinor: number | null;
  overdue: number;
  matured: boolean;
  balanceMinor: number;
}

export interface FdrRow {
  no: number;
  date: string;
  interestMinor: number;
  taxMinor: number;
  netMinor: number;
  valueMinor: number;
  kind: "posted" | "due" | "upcoming";
  postedOn: string | null;
  transferId: string | null;
}

export interface FdrDetail {
  fdr: Fdr;
  rows: FdrRow[];
}

export interface FdrInput {
  id?: string | null;
  name: string;
  color: string;
  currency?: string | null;
  amount: string;
  rate: string;
  months: number;
  startDate: string;
  payout: Fdr["payout"];
  tax: string;
  interestTo: string | null;
  fundedFrom: string | null;
  autoPost: boolean;
  inTotal?: boolean | null;
  details?: AccountDetails | null;
}

/** What a pasted statement held. */
export interface StatementImport {
  found: number;
  added: number;
  disburseDate: string | null;
  first: string | null;
  last: string | null;
  outstandingMinor: number | null;
  detail: PlanDetail | null;
}

export interface PlanPreview {
  paymentMinor: number;
  interestMinor: number;
  totalMinor: number;
  installments: number;
  endDate: string;
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
  inTotal?: boolean | null;
  creditLimit?: string | null;
  statementDay?: number | null;
  dueDay?: number | null;
  /** Without it, the details stay as they were. */
  details?: AccountDetails | null;
}

/** A credit card's limit and statement. */
export interface CardStatus {
  accountId: string;
  limitMinor: number | null;
  usedMinor: number;
  availableMinor: number | null;
  statementDate: string | null;
  /** Owed when the last statement closed. */
  statementMinor: number;
  paidSinceMinor: number;
  /** Still to pay on it. */
  dueMinor: number;
  dueDate: string | null;
  nextStatement: string | null;
}

export interface CategoryInput {
  id?: string | null;
  parentId: string | null;
  name: string;
  kind: "expense" | "income";
  icon: string;
  color: string;
}

/** Another device this ledger syncs with (`sync_net.rs`). */
export interface SyncPeer {
  id: string;
  name: string;
  /** "desktop": this side calls it (the phone); "phone": it calls this side (the desktop). */
  kind: "desktop" | "phone";
  address: string;
  /** Milliseconds since the epoch; 0 when never. */
  lastSync: number;
}

export interface SyncInfo {
  device: string;
  name: string;
  peers: SyncPeer[];
  /** The port the desktop listens on, once a phone is paired. */
  listening: number | null;
}

export interface SyncOutcome {
  sent: number;
  received: number;
  peer: string;
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
  syncInfo: () => invoke<SyncInfo>("wallet_sync_info"),
  syncInvite: () => invoke<{ code: string; svg: string }>("wallet_sync_invite"),
  syncCancelInvite: () => invoke<void>("wallet_sync_cancel_invite"),
  syncJoin: (code: string) => invoke<SyncOutcome>("wallet_sync_join", { code }),
  /** One result per paired computer: an outcome, or the problem as text. */
  syncNow: () => invoke<({ Ok: SyncOutcome } | { Err: string })[]>("wallet_sync_now"),
  syncForget: (id: string) => invoke<void>("wallet_sync_forget", { id }),
  restore: (name: string) => invoke<void>("wallet_backup_restore", { name }),
  archiveCategory: (id: string, archived: boolean) => invoke<void>("wallet_category_archive", { id, archived }),
  setRollover: (month: string, categoryId: string, on: boolean) => invoke<void>("wallet_budget_rollover", { month, categoryId, on }),
  bills: (today: string) => invoke<Bill[]>("wallet_bills", { today }),
  saveBill: (bill: BillInput, today: string) => invoke<Bill>("wallet_bill_save", { bill, today }),
  pauseBill: (id: string, paused: boolean) => invoke<void>("wallet_bill_pause", { id, paused }),
  deleteBill: (id: string) => invoke<void>("wallet_bill_delete", { id }),
  payBill: (id: string, date: string | null, today: string) => invoke<Tx>("wallet_bill_pay", { id, date, today }),
  skipBill: (id: string, today: string) => invoke<void>("wallet_bill_skip", { id, today }),
  cards: (today: string) => invoke<CardStatus[]>("wallet_cards", { today }),
  plans: (today: string) => invoke<Plan[]>("wallet_plans", { today }),
  plan: (id: string, today: string) => invoke<PlanDetail>("wallet_plan", { id, today }),
  planPreview: (plan: PlanInput) => invoke<PlanPreview>("wallet_plan_preview", { plan }),
  savePlan: (plan: PlanInput, today: string) => invoke<PlanDetail>("wallet_plan_save", { plan, today }),
  payPlan: (id: string, no: number, date: string | null, today: string) => invoke<PlanDetail>("wallet_plan_pay", { id, no, date, today }),
  deletePlan: (id: string) => invoke<void>("wallet_plan_delete", { id }),
  savePayment: (payment: PaymentInput, today: string) => invoke<PlanDetail>("wallet_plan_payment_save", { payment, today }),
  importStatement: (id: string, text: string, byDay: boolean, apply: boolean, today: string) => invoke<StatementImport>("wallet_plan_import", { id, text, byDay, apply, today }),
  fdrs: (today: string) => invoke<FdrDetail[]>("wallet_fdrs", { today }),
  saveFdr: (fdr: FdrInput, today: string) => invoke<FdrDetail>("wallet_fdr_save", { fdr, today }),
  receiveFdr: (id: string, no: number, date: string | null, today: string) => invoke<FdrDetail>("wallet_fdr_receive", { id, no, date, today }),
  deleteFdr: (id: string) => invoke<void>("wallet_fdr_delete", { id }),
  deletePayment: (id: string, today: string) => invoke<PlanDetail>("wallet_plan_payment_delete", { id, today }),
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
