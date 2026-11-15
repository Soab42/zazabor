import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { confirmDialog } from "../../time/dialog";
import { errorText, walletApi, type Account, type Backup, type CardStatus } from "../api";
import { billSheet } from "./bills";
import { ACCOUNT_KIND_ICON, ACCOUNT_KIND_LABEL, fmt, type Ctx } from "../ctx";
import { plain, shortDate, todayKey } from "../format";
import { accountSheet, detailsLine } from "../sheets";

/**
 * One card per account: its balance (and what it's worth in taka when it's in another currency),
 * how many transactions, the last activity. Archived accounts fold away below; daily backups of
 * the ledger at the end.
 */
export function accountsView(ctx: Ctx) {
  let showArchived = false;
  let backups: Backup[] = [];
  let cards: CardStatus[] = [];
  const total = h("div", { class: "wl-accounts-total" });
  const grid = h("div", { class: "wl-account-grid" });
  const archived = h("div", { class: "wl-archived" });
  const backupCard = h("section", { class: "wl-card wl-backups" });
  const el = h("div", { class: "wl-view wl-accounts" }, total, grid, archived, backupCard);

  function card(a: Account): HTMLElement {
    const base = ctx.state().base;
    const rate = ctx.state().rates.find((r) => r.currency === a.currency);
    // A DPS or a loan is edited, with its terms, in Loans & DPS.
    const plan = a.kind === "dps" || a.kind === "loan" || a.kind === "fdr";
    const more = h("button", { class: "icon-btn small wl-card-more", type: "button", title: "More", "aria-label": `More for ${a.name}` }, icon("more", 16));
    // A div, not a button: it holds the More button.
    const c = h("div", { class: `wl-account wl-c-${a.color}${a.archived ? " archived" : ""}`, role: "button", tabindex: 0, "aria-label": plan ? `${a.name}: show its table` : `${a.name}: show its transactions`, onclick: () => plan ? ctx.go("plans", { accountId: a.id }) : ctx.go("transactions", { accountId: a.id }) },
      h("div", { class: "wl-account-top" },
        h("span", { class: `wl-chip wl-c-${a.color}`, style: { width: "34px", height: "34px" } }, icon(ACCOUNT_KIND_ICON[a.kind], 18)),
        h("div", { class: "wl-account-name" }, h("strong", null, a.name), h("span", null, ACCOUNT_KIND_LABEL[a.kind] ?? a.kind))),
      detailsLine(a) ? h("div", { class: "wl-account-details", title: [detailsLine(a), a.details.note].filter(Boolean).join("\n") }, detailsLine(a)) : null,
      h("div", { class: `wl-account-balance${a.balanceMinor < 0 && a.kind !== "loan" ? " negative" : ""}` }, fmt(ctx, a.kind === "loan" ? Math.abs(a.balanceMinor) : a.balanceMinor, a.currency)),
      a.kind === "loan" ? h("div", { class: "wl-account-base" }, "still owed") : null,
      a.currency !== base
        ? h("div", { class: "wl-account-base" }, a.balanceBaseMinor != null ? `≈ ${fmt(ctx, a.balanceBaseMinor)}` : "No rate yet", rate ? h("span", null, ` · 1 ${a.currency} = ${fmt(ctx, Math.round(rate.rateMicro / 10_000))}`) : null)
        : null,
      a.kind === "card" ? cardInfo(a) : null,
      h("div", { class: "wl-account-meta" }, a.inTotal ? null : h("span", null, "Not in the total · "), a.txCount ? `${a.txCount} transaction${a.txCount === 1 ? "" : "s"}${a.lastDate ? ` · last ${shortDate(a.lastDate)}` : ""}` : "No transactions yet"));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [
        plan ? { label: "Show its table", icon: "table", action: () => ctx.go("plans", { accountId: a.id }) } : { label: "Edit…", icon: "pencil", action: () => accountSheet(ctx, a) },
        ...(plan ? [{ label: "Show its transactions", icon: "list" as const, action: () => ctx.go("transactions", { accountId: a.id }) }] : []),
        { label: "Add a transaction", icon: "plus", action: () => ctx.openTx(null, { accountId: a.id }) },
        ...(a.kind === "card" ? [
          { label: "Pay the bill…", icon: "check" as const, action: () => payCard(a) },
          { label: "Pay it by itself each month…", icon: "repeat" as const, disabled: !a.statementDay, action: () => autoPay(a) },
        ] : []),
        { label: "Move money from here…", icon: "transfer", action: () => ctx.openTx(null, { kind: "transfer", accountId: a.id }) },
        "separator",
        { label: a.archived ? "Unarchive" : "Archive", icon: "archive", action: () => void walletApi.archiveAccount(a.id, !a.archived).then(() => ctx.changed(), (err) => ctx.toast(errorText(err))) },
      ]);
    });
    c.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === c) {
        e.preventDefault();
        c.click();
      }
    });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      more.click();
    });
    c.append(more);
    return c;
  }

  /** A card's limit, its statement and when it's due, with Pay Bill. */
  function cardInfo(a: Account): HTMLElement | null {
    const c = cards.find((x) => x.accountId === a.id);
    if (!c) return null;
    // A card without its terms yet: say what setting them brings.
    if (c.limitMinor == null && !c.statementDate) {
      return h("div", { class: "wl-card-info" },
        h("button", { class: "btn small wl-card-setup", type: "button", onclick: (e: Event) => (e.stopPropagation(), accountSheet(ctx, a)) },
          icon("card", 13), "Set limit, statement & due day"),
        h("div", { class: "wl-card-due" },
          h("span", { class: "wl-muted" }, a.balanceMinor < 0 ? `${fmt(ctx, -a.balanceMinor, a.currency)} owed` : "Nothing owed"),
          a.balanceMinor < 0 ? h("button", { class: "btn small", type: "button", onclick: (e: Event) => (e.stopPropagation(), payCard(a)) }, "Pay Bill") : null));
    }
    const parts: (HTMLElement | null)[] = [];
    if (c.limitMinor != null) {
      const used = c.limitMinor ? Math.min(1, c.usedMinor / c.limitMinor) : 0;
      parts.push(h("span", { class: `wl-meter${used > 0.9 ? " over" : used > 0.7 ? " near" : ""}`, "aria-hidden": "true" }, h("span", { class: "wl-meter-fill", style: { width: `${Math.round(used * 100)}%` } })),
        h("div", { class: "wl-account-base" }, `${fmt(ctx, c.availableMinor ?? 0, a.currency)} available of ${fmt(ctx, c.limitMinor, a.currency)}`));
    }
    if (c.statementDate) {
      const late = c.dueMinor > 0 && c.dueDate != null && c.dueDate < todayKey();
      parts.push(h("div", { class: "wl-card-due" },
        h("span", { class: late ? "wl-late" : "" }, c.dueMinor > 0
          ? `${fmt(ctx, c.dueMinor, a.currency)} due${c.dueDate ? ` ${late ? "since" : "by"} ${shortDate(c.dueDate)}` : ""}`
          : `Statement ${shortDate(c.statementDate)} paid`),
        c.dueMinor > 0 ? h("button", { class: `btn small${late ? " primary" : ""}`, type: "button", onclick: (e: Event) => (e.stopPropagation(), payCard(a)) }, "Pay Bill") : null));
    }
    return parts.length ? h("div", { class: "wl-card-info" }, ...parts) : null;
  }

  /** A transfer into the card from the bank, for what's due on its statement. */
  function payCard(a: Account) {
    const c = cards.find((x) => x.accountId === a.id);
    const due = c?.dueMinor || Math.max(0, -a.balanceMinor);
    const bank = ctx.state().accounts.find((x) => !x.archived && x.kind === "bank" && x.currency === a.currency);
    ctx.openTx(null, { kind: "transfer", accountId: bank?.id ?? null, toAccountId: a.id, amount: due ? plain(due, a.currency) : "", note: `${a.name} bill` });
  }

  /** An automatic transfer each month on the due day, of what's due on the statement. */
  function autoPay(a: Account) {
    const c = cards.find((x) => x.accountId === a.id);
    billSheet(ctx, null, undefined, { toAccountId: a.id, amountMode: "statement", day: a.dueDay || 0, startDate: c?.dueDate ?? todayKey(), name: `${a.name} bill` });
  }

  function addCard(): HTMLElement {
    return h("button", { class: "wl-account wl-account-add", type: "button", onclick: () => accountSheet(ctx, null) },
      icon("plus", 22), h("strong", null, "Add Account"), h("span", null, "Cash, a bank, bKash, Nagad, a card"));
  }

  function drawBackups() {
    const latest = backups[0];
    const list = h("div", { class: "wl-backup-list" }, ...backups.slice(0, 6).map((b) => h("div", { class: "wl-backup" },
      icon("archive", 14),
      h("span", { class: "wl-backup-name" }, b.name.replace(/\.db$/, "").replace(/^before-restore-(\d+)$/, (_, ms) => `Before a restore, ${new Date(Number(ms)).toLocaleString()}`)),
      h("span", { class: "wl-backup-size" }, `${Math.max(1, Math.round(b.size / 1024))} KB`),
      h("button", { class: "text-btn", type: "button", onclick: () => void restore(b) }, "Restore"))));
    backupCard.replaceChildren(
      h("header", { class: "wl-card-head" },
        h("div", null, h("h3", null, "Backups"), h("p", { class: "wl-card-sub" }, latest ? `A copy of the ledger is kept each day (the last 14). Latest: ${new Date(latest.modified).toLocaleString()}.` : "A copy of the ledger is kept each day (the last 14).")),
        h("span", { class: "spacer" }),
        h("button", { class: "btn small", type: "button", onclick: () => void backupNow() }, icon("download", 14), "Back Up Now")),
      backups.length ? list : h("p", { class: "wl-chart-empty" }, "No backups yet."));
  }

  async function backupNow() {
    try {
      await walletApi.backupNow();
      ctx.toast("Backed up");
      backups = await walletApi.backups();
      drawBackups();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  async function restore(b: Backup) {
    const yes = await confirmDialog({
      title: "Restore this backup?",
      text: "The ledger goes back to how it was then. Today's ledger is saved first as a backup of its own, so this can be undone.",
      confirm: "Restore", icon: "undo", tone: "idle",
    });
    if (!yes) return;
    try {
      await walletApi.restore(b.name);
      ctx.toast("Restored");
      ctx.changed();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  }

  function draw() {
    const s = ctx.state();
    const live = s.accounts.filter((a) => !a.archived);
    const gone = s.accounts.filter((a) => a.archived);
    const sum = live.filter((a) => a.inTotal).reduce((t, a) => t + (a.balanceBaseMinor ?? 0), 0);
    total.replaceChildren(h("span", { class: "wl-stat-label" }, "Total balance"), h("strong", { class: "wl-hero" }, fmt(ctx, sum)),
      h("span", { class: "wl-accounts-count" }, `${live.length} account${live.length === 1 ? "" : "s"}`));
    grid.replaceChildren(...live.map(card), addCard());
    archived.hidden = !gone.length;
    archived.replaceChildren(
      h("button", { class: "text-btn wl-archived-toggle", type: "button", onclick: () => ((showArchived = !showArchived), draw()) },
        icon(showArchived ? "chevronDown" : "chevronRight", 13), `Archived (${gone.length})`),
      ...(showArchived ? [h("div", { class: "wl-account-grid" }, ...gone.map(card))] : []));
    drawBackups();
  }

  return {
    id: "accounts" as const,
    title: "Accounts",
    el,
    usesMonth: false,
    async load() {
      cards = await walletApi.cards(todayKey()).catch(() => []);
      draw();
      backups = await walletApi.backups().catch(() => []);
      drawBackups();
    },
  };
}
