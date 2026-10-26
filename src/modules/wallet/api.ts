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
  budgetMinor: number | null;
  spentMinor: number;
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
};

export function onWalletChanged(fn: () => void): Promise<UnlistenFn> {
  return listen("wallet-changed", () => fn());
}

export function errorText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}
