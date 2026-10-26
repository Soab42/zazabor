import type { ShellContext } from "../../shell/module";
import type { Account, Category, Filter, Tx, WalletState } from "./api";
import { money, type MoneyOptions } from "./format";

export type ViewId = "overview" | "transactions" | "accounts" | "budgets" | "reports";

/** What the views and sheets share: the ledger's state, formatting, and navigation. */
export interface Ctx {
  readonly shell: ShellContext;
  /** Accounts, categories, rates and payees as last loaded. */
  state(): WalletState;
  /** Hide amounts is on. */
  hidden(): boolean;
  /** The month Overview and Budgets show, "YYYY-MM". */
  month(): string;
  setMonth(month: string): void;
  /** Opens the add/edit sheet: a transaction to edit, or a new one (optionally pre-filled). */
  openTx(tx?: Tx | null, preset?: Partial<NewTx>): void;
  /** Shows a view; Transactions can start filtered. */
  go(view: ViewId, filter?: Filter): void;
  toast(text: string, action?: { label: string; run: () => void }): void;
  /** Reloads the state and the view now (after a change made here). */
  changed(): void;
}

/** What a new transaction can be pre-filled with (from quick add, or Duplicate). */
export interface NewTx {
  kind: "expense" | "income" | "transfer";
  accountId: string | null;
  toAccountId: string | null;
  amount: string;
  categoryId: string | null;
  date: string;
  payee: string;
  note: string;
}

export function accountOf(ctx: Ctx, id: string | null | undefined): Account | undefined {
  return id ? ctx.state().accounts.find((a) => a.id === id) : undefined;
}

export function categoryOf(ctx: Ctx, id: string | null | undefined): Category | undefined {
  return id ? ctx.state().categories.find((c) => c.id === id) : undefined;
}

/** "Groceries", or "Food › Groceries" with `full`; "Uncategorised" without one. */
export function categoryName(ctx: Ctx, id: string | null | undefined, full = false): string {
  const c = categoryOf(ctx, id);
  if (!c) return "Uncategorised";
  const parent = full ? categoryOf(ctx, c.parentId) : undefined;
  return parent ? `${parent.name} › ${c.name}` : c.name;
}

/** An amount in a currency (the base one by default), honouring Hide amounts. */
export function fmt(ctx: Ctx, minor: number, code?: string, options: MoneyOptions = {}): string {
  return money(minor, code ?? ctx.state().base, { hidden: ctx.hidden(), ...options });
}

export const ACCOUNT_KIND_LABEL: Record<string, string> = {
  cash: "Cash", bank: "Bank account", mobile_wallet: "Mobile wallet", card: "Card", savings: "Savings",
};

export const ACCOUNT_KIND_ICON = {
  cash: "wallet", bank: "bank", mobile_wallet: "phone", card: "card", savings: "piggy",
} as const;

/** Category and account colours (the names the backend accepts). */
export const COLORS = ["red", "orange", "amber", "green", "teal", "sky", "blue", "indigo", "purple", "pink", "gray"] as const;

/** Icons a category can take. */
export const CATEGORY_ICONS = [
  "utensils", "bus", "bolt", "home", "users", "heart", "book", "bag", "film", "repeat", "handHeart", "receipt",
  "briefcase", "laptop", "store", "gift", "undo", "phone", "card", "bank", "piggy", "music", "image", "more",
] as const;
