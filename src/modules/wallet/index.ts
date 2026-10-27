import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import "../files/ops/ops.css";
import { showToast } from "../files/ops/toast";
import "../time/time-module.css";
import { errorText, onWalletChanged, walletApi, type WalletState } from "./api";
import { hideTip } from "./charts";
import { ACCOUNT_KIND_ICON, fmt, type Ctx, type ViewId } from "./ctx";
import { addMonths, monthLabel, setCurrencies, thisMonth } from "./format";
import { quickAdd } from "./quickadd";
import { txSheet } from "./sheets";
import { accountsView } from "./views/accounts";
import { billsView } from "./views/bills";
import { budgetsView } from "./views/budgets";
import { importView } from "./views/importer";
import { overviewView } from "./views/overview";
import { reportsView } from "./views/reports";
import { transactionsView } from "./views/transactions";
import "./wallet.css";

const EMPTY: WalletState = { base: "BDT", currencies: [], accounts: [], categories: [], rates: [], payees: [] };

/**
 * Wallet: one person's money. A slim sidebar of views (Overview, Transactions, Accounts,
 * Budgets, Reports) and the accounts with their balances; a bar with the month, Quick add,
 * Hide amounts and New. The ledger lives in the backend (`src-tauri/src/wallet`); every window
 * hears `wallet-changed` and reloads.
 */
export const createWalletModule: ModuleFactory = (shell) => {
  let state: WalletState = EMPTY;
  let month = thisMonth();
  let visible = false;
  let current: ViewId = "overview";
  let problem: string | null = null;
  const unlisten: Promise<UnlistenFn>[] = [];

  const ctx: Ctx = {
    shell,
    state: () => state,
    hidden: () => shell.config.wallet.hideAmounts,
    month: () => month,
    setMonth(next) {
      month = next;
      drawBar();
      void views[current].load();
    },
    openTx: (tx, preset) => txSheet(ctx, tx ?? null, preset),
    go(view, filter) {
      if (view === "transactions") views.transactions.setFilter(filter ?? {});
      show(view);
    },
    toast: (text, action) => showToast(text, action, action ? 6000 : 3200),
    changed: () => void refresh(true),
  };

  const views = {
    overview: overviewView(ctx),
    transactions: transactionsView(ctx),
    accounts: accountsView(ctx),
    budgets: budgetsView(ctx),
    bills: billsView(ctx),
    reports: reportsView(ctx),
    import: importView(ctx),
  };

  // ---- sidebar

  const nav: [ViewId, string, IconName][] = [
    ["overview", "Overview", "pieChart"], ["transactions", "Transactions", "list"], ["accounts", "Accounts", "wallet"],
    ["budgets", "Budgets", "target"], ["bills", "Bills", "repeat"], ["reports", "Reports", "barChart"], ["import", "Import & Export", "download"],
  ];
  const navButtons = nav.map(([id, label, glyph]) => h("button", { class: "wl-nav", type: "button", onclick: () => show(id) }, icon(glyph, 17), h("span", null, label)));
  const sideAccounts = h("div", { class: "wl-side-accounts" });
  const sideTotal = h("div", { class: "wl-side-total" });
  const side = h("aside", { class: "wl-side" },
    h("div", { class: "wl-side-head" }, h("span", { class: "wl-side-mark" }, icon("wallet", 18)), h("h1", null, "Wallet")),
    h("nav", { class: "wl-navs", "aria-label": "Wallet views" }, ...navButtons),
    h("div", { class: "wl-side-label" }, "Accounts"),
    sideAccounts,
    h("div", { class: "spacer" }),
    sideTotal);

  // ---- bar

  const title = h("h2", { class: "wl-title" });
  const monthLabelEl = h("span", { class: "wl-month-label" });
  const stepper = h("div", { class: "wl-month" },
    h("button", { class: "icon-btn small", type: "button", title: "Previous month", "aria-label": "Previous month", onclick: () => ctx.setMonth(addMonths(month, -1)) }, icon("chevronLeft", 14)),
    monthLabelEl,
    h("button", { class: "icon-btn small wl-next-month", type: "button", title: "Next month", "aria-label": "Next month", onclick: () => ctx.setMonth(addMonths(month, 1)) }, icon("chevronRight", 14)));
  const quick = quickAdd(ctx);
  const hideButton = h("button", { class: "icon-btn", type: "button", onclick: () => toggleHidden() });
  const newButton = h("button", { class: "btn primary", type: "button", onclick: () => ctx.openTx(null) }, icon("plus", 15), "New");
  const newMore = h("button", {
    class: "btn primary wl-new-more", type: "button", title: "Spending, income or a transfer", "aria-label": "More kinds of transaction",
    onclick: () => {
      const r = newMore.getBoundingClientRect();
      openMenu(r.right - 200, r.bottom + 4, [
        { label: "Spending", icon: "trendDown", action: () => ctx.openTx(null, { kind: "expense" }), shortcut: "Ctrl+E" },
        { label: "Income", icon: "trendUp", action: () => ctx.openTx(null, { kind: "income" }) },
        { label: "Transfer", icon: "transfer", action: () => ctx.openTx(null, { kind: "transfer" }) },
      ]);
    },
  }, icon("chevronDown", 13));
  const bar = h("header", { class: "wl-bar" }, h("div", { class: "wl-heading" }, title, stepper), quick.el, hideButton, h("div", { class: "wl-new" }, newButton, newMore));
  const scroll = h("div", { class: "wl-scroll" });
  const main = h("div", { class: "wl-main" }, bar, scroll);
  const el = h("section", { class: "wallet-module" }, side, main);
  scroll.addEventListener("scroll", hideTip, { passive: true });

  function toggleHidden() {
    shell.config.wallet.hideAmounts = !shell.config.wallet.hideAmounts;
    shell.saveConfig();
    redraw();
  }

  function drawBar() {
    const view = views[current];
    title.textContent = view.title;
    stepper.hidden = !view.usesMonth;
    monthLabelEl.textContent = monthLabel(month);
    stepper.querySelector<HTMLButtonElement>(".wl-next-month")!.disabled = month >= thisMonth();
    const hidden = ctx.hidden();
    hideButton.replaceChildren(icon(hidden ? "eyeOff" : "eye", 17));
    hideButton.classList.toggle("active", hidden);
    hideButton.title = hidden ? "Show amounts (Ctrl+H)" : "Hide amounts (Ctrl+H)";
    hideButton.setAttribute("aria-pressed", String(hidden));
  }

  function drawSide() {
    navButtons.forEach((b, i) => b.classList.toggle("active", nav[i][0] === current));
    const live = state.accounts.filter((a) => !a.archived);
    sideAccounts.replaceChildren(...live.map((a) => h("button", { class: "wl-side-account", type: "button", title: `${a.name}: show its transactions`, onclick: () => ctx.go("transactions", { accountId: a.id }) },
      h("span", { class: `wl-chip wl-c-${a.color}`, style: { width: "22px", height: "22px" } }, icon(ACCOUNT_KIND_ICON[a.kind], 12)),
      h("span", { class: "wl-side-name" }, a.name),
      h("span", { class: `wl-side-balance${a.balanceMinor < 0 ? " negative" : ""}` }, fmt(ctx, a.balanceMinor, a.currency)))),
    h("button", { class: "wl-side-add", type: "button", onclick: () => show("accounts") }, icon("plus", 13), "Add Account"));
    const total = live.reduce((t, a) => t + (a.balanceBaseMinor ?? 0), 0);
    sideTotal.replaceChildren(h("span", { class: "wl-stat-label" }, "Total balance"), h("strong", null, fmt(ctx, total)));
  }

  function show(view: ViewId) {
    current = view;
    hideTip();
    scroll.replaceChildren(problem ? problemState() : views[view].el);
    scroll.scrollTop = 0;
    drawBar();
    drawSide();
    if (!problem) void views[view].load();
  }

  function redraw() {
    drawBar();
    drawSide();
    quick.redraw();
    if (!problem) void views[current].load();
  }

  function problemState(): HTMLElement {
    const locked = problem === "locked";
    return h("div", { class: "wl-empty" },
      h("div", { class: "wl-empty-tile glass" }, icon(locked ? "lock" : "info", 30)),
      h("h2", null, locked ? "Wallet is locked" : "Wallet couldn't open"),
      h("p", null, locked ? "Unlock Zazabor to see your accounts." : problem ?? ""),
      locked ? null : h("button", { class: "btn", type: "button", onclick: () => void refresh(true) }, icon("refresh", 15), "Try Again"));
  }

  let inflight: Promise<void> | null = null;
  let again = false;
  let soon = 0;

  /** Reloads the state, then the view; bursts of changes fold into one load at a time. */
  function refresh(now = false): Promise<void> {
    if (!now) {
      clearTimeout(soon);
      soon = window.setTimeout(() => void refresh(true), 50);
      return Promise.resolve();
    }
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      const before = problem;
      try {
        state = await walletApi.state();
        setCurrencies(state.currencies, state.base);
        problem = null;
      } catch (err) {
        problem = errorText(err);
      } finally {
        inflight = null;
      }
      if (visible) {
        if (problem || before || !scroll.firstChild) show(current);
        else redraw();
      }
      if (again) {
        again = false;
        await refresh(true);
      }
    })();
    return inflight;
  }

  unlisten.push(onWalletChanged(() => visible && void refresh()));
  // Unlocking (here or in another window) brings the views back.
  unlisten.push(listen<boolean>("lock-changed", (e) => !e.payload && visible && void refresh(true)));

  const module: AppModule = {
    id: "wallet",
    title: "Wallet",
    icon: "wallet",
    el,
    activate() {
      visible = true;
      if (!scroll.firstChild) show(current);
      void refresh(true);
    },
    deactivate() {
      visible = false;
      hideTip();
    },
    handleKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "e") {
        ctx.openTx(null);
        return true;
      }
      if (mod && key === "h") {
        toggleHidden();
        return true;
      }
      if (mod && key === "f") {
        if (current !== "transactions") show("transactions");
        views.transactions.focusSearch();
        return true;
      }
      if (mod && key === "k") {
        quick.focus();
        return true;
      }
      return false;
    },
    onLock() {
      // No amounts stay on screen behind the lock; the views reload after unlocking.
      for (const overlay of document.querySelectorAll(".tt-overlay")) overlay.remove();
      hideTip();
      scroll.replaceChildren();
      state = EMPTY;
      drawSide();
    },
    lockChanged: () => void refresh(true),
    dispose() {
      clearTimeout(soon);
      hideTip();
      for (const u of unlisten) void u.then((fn) => fn());
      el.remove();
    },
  };
  return module;
};
