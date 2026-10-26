# Wallet: personal cost management

*Written 2026-10-26. Status: **F1 (ledger) and F2 (budgets, Overview, Reports, backups) built**
(`src/modules/wallet`, `src-tauri/src/wallet`); F3–F6 are still plans. Section 11 records the
decisions. Wallet is the second "self management" section, after Time (`src-tauri/src/time/`).*

## 0. What's built (2026-10-26)

- **Ledger** in SQLite (`wallet/wallet.db`, `PRAGMA user_version` migrations): accounts (cash,
  bank, mobile wallet, card, savings) with opening balances, the default categories in two levels
  (editable: add, rename, re-icon, recolour, move, delete moving their transactions), spending and
  income in integer minor units, transfers between your own accounts with an optional fee booked
  in Fees (a bKash cash-out), and any currency in the table with a rate typed by hand.
- **Quick add** in the bar (Ctrl+K): "250 lunch bkash", "+45000 salary city bank 25 oct",
  "1,200 eating out Kacchi Bhai cash yesterday". Chips show the guess as you type; Enter adds it
  with Undo, Tab opens the full sheet pre-filled. Words like lunch, rickshaw, pathao, desco,
  netflix, zakat point to categories; a known payee brings its last category.
- **Views** in a slim sidebar: Overview (total balance, the month's income, spending and what
  was kept against last month, spending by category, budgets nearest their limit, accounts,
  latest), Transactions (grouped by day with day totals; span, account, category and kind
  filters; search; click, Ctrl and Shift to select, with the selection's sum; Edit, Duplicate,
  Delete, change category; Delete and Enter keys), Accounts (cards with balances and their taka
  value, archive, backups with Back Up Now and Restore), Budgets (per category and month, inline
  amounts, Copy Last Month, meters that turn amber at 80% and red past 100% with an icon and
  words), Reports (span presets; spending by category, income and spending per month, net worth;
  each with hover details and a table view).
- **Hide amounts** (eye button, Ctrl+H) shows every amount as `৳•••`, and stays on across restarts.
  Every `wallet_*` command refuses while CorePro is locked, and locking clears the section.
- **Backups**: a copy each day (`VACUUM INTO wallet/backups/YYYY-MM-DD.db`, the last 14 kept),
  and a "before-restore" copy before any restore.
- Not built yet from F1/F2: budget roll-over, archiving categories from the UI, and a Settings →
  Wallet page (the backups live on the Accounts view for now).


## 1. Goals

- **One person's money in one place.** Where it comes from, where it goes, and what is left in
  each wallet: cash, bank accounts, cards and mobile wallets (bKash, Nagad, Rocket).
- **Fast to enter.** A transaction takes a few seconds from anywhere: a quick-add field in the
  section, and a desktop shortcut like the quick note (`corepro --new-note`).
- **Honest numbers.** Money is stored as integers in minor units (poisha, cents), never floats.
  Transfers move money between your own accounts without counting as spending.
- **Plans, not just history.** Monthly budgets per category, recurring bills and subscriptions with
  their next due dates, and reports that show the trend.
- **Works with the rest of CorePro.** Receipts come from Files and the Gallery. Earnings come from
  the hours Time tracked. Statements come in as CSV or Excel files.
- **Private.** The privacy lock hides it, amounts can be blurred on screen, and the synced copy on a
  cloud drive is encrypted.

Out of scope for the first version: shared expenses between people, investments with live prices,
tax filing, and connecting to banks directly (Bangladeshi banks and wallets have no open
personal-finance API).

## 2. Section and screens

Wallet is a rail section (`id: "wallet"`, Ctrl+7), one module behind the
`AppModule` interface, with its own chunk. Like Video, it has a slim sidebar of views:

| View | What it shows |
|---|---|
| **Overview** | This month's income, spending and net (with the savings rate), wallet balances, budget bars for the top categories, bills due in the next 14 days, and the last 10 transactions. |
| **Transactions** | A virtualized table (date, payee, category, account, amount), grouped by day with daily totals. Filters for account, category, kind and date range, plus search. Selecting rows shows their sum. Inline edit, and multi-select to change a category or delete. |
| **Accounts** | One card per wallet: balance, a 90-day sparkline, last activity. Archive an account without losing its history. |
| **Budgets** | One row per category for the chosen month: budget, spent and left, with a bar that turns amber at 80% and red past 100%. Optional roll-over of what is left. Copy last month's budgets. |
| **Bills** | Recurring rules: next due date, amount, account, and what each costs per year. A "Subscriptions" filter. Mark as paid, which posts the transaction. |
| **Reports** | Spending by category (horizontal bars, not pies), a 12-month income vs spending trend, net worth over time, and budget vs actual. Each chart can export its rows as CSV. |
| **Import** | A wizard: pick a file, map its columns, preview with duplicates and rule matches marked, then commit. |

**Quick add.** A field at the top of every view reads short phrases: `250 lunch bkash` or
`+45000 salary city bank 25 oct`. It guesses the amount, category (from rules and past payees),
account and date, and shows the guess as chips before Enter commits. A full sheet (Ctrl+E) has
every field for the rest.

**Hide amounts.** A toggle (eye icon, and a shortcut) replaces every amount with `•••` for screen
sharing. The design follows `docs/DESIGN.md`: glass bars, tabular numbers, `--danger` only for
overspending, and charts built from the tokens so both themes work.

## 3. Money and currencies

- **Integers only.** Each amount is an `i64` in the currency's minor unit, with its ISO 4217 code.
  BDT, USD and EUR have 2 decimals, JPY has 0 and KWD has 3. The exponent comes from a small table
  in Rust, not from the frontend. Arithmetic and sums run in Rust or in SQL on integers. The
  frontend only formats them (`Intl.NumberFormat`, `bn-BD` or `en-BD` digits by choice, with lakh
  and crore grouping: ৳1,25,000).
- **Base currency.** One base currency (BDT by default) for totals and reports. Each account has its
  own currency, and a transaction can be in a third one (a USD subscription paid from a BDT card).
- **Rates.** A transaction in another currency stores the rate used as an integer in millionths
  (`rate_micro`), so a total never changes after the fact. Reports convert other accounts into the
  base currency using the stored rate, or else the latest rate in the `rates` table. Rates are typed
  in by hand at first. Fetching them online is a choice (section 11).

## 4. Data model

SQLite (section 5). Every table has `id TEXT` (32 hex digits, as `notes::new_id`), plus `created`
and `updated` in ms since the epoch, and `deleted` for soft deletes that sync.

| Table | Columns (besides id and timestamps) |
|---|---|
| `accounts` | `name`, `kind` (cash, bank, mobile_wallet, card, savings, loan), `currency`, `opening_minor`, `color`, `icon`, `archived`, `position` |
| `categories` | `parent_id` (two levels), `name`, `kind` (expense, income), `icon`, `color`, `archived` |
| `transactions` | `account_id`, `date` (local `YYYY-MM-DD`), `time` (optional), `amount_minor` (signed: negative is money out of this account), `currency`, `rate_micro`, `category_id`, `payee`, `note`, `transfer_id` (both legs of a transfer share it), `recurring_id`, `import_hash`, `time_project` (section 8) |
| `budgets` | `month` (`YYYY-MM`), `category_id`, `amount_minor`, `rollover` |
| `recurring` | `template` (JSON of a transaction), `rule` (subset of RRULE: daily, weekly on days, monthly on day N or last day, yearly), `next_date`, `auto_post`, `remind_days` |
| `receipts` | `transaction_id`, `file` (name inside `money/receipts/`), `mime`, `size`, `hash` |
| `rules` | `pattern` (matched against payee and description), `category_id`, `payee` (renames "FOODPANDA*BD 1234" to "Foodpanda"), `account_id`, `position` |
| `import_profiles` | `name` ("City Bank CSV"), column mapping, date format, sign convention, header row |
| `rates` | `date`, `from`, `to`, `rate_micro` |
| `project_rates` | `project` (Time's free-text project name), `rate_minor` per hour, `currency` |

A transfer is two rows with the same `transfer_id`. One is negative on the source, one positive on
the destination, and a fee is a third row: a bKash cash-out charge is an expense in a "Fees"
category, linked by `transfer_id`. Balances are `opening_minor + SUM(amount_minor)` per account.
The sum is computed from the rows every time, never cached in a column that could drift.

Default categories (all editable): Food (Groceries, Eating out), Transport (Rickshaw and CNG, Ride
share, Fuel), Bills (Electricity, Gas, Water, Internet, Mobile recharge), Rent, Family, Health,
Education, Shopping, Entertainment, Subscriptions, Charity (Zakat, Sadaqah), Fees, Other. Income:
Salary, Freelance, Business, Gifts, Refunds, Other.

## 5. Storage: SQLite, not one JSON file

Notes keep one `notes.json`, rewritten on every change (`notes/mod.rs`). That suits a few hundred
notes. Money is different:

| | One JSON file (as Notes) | SQLite (`rusqlite` with `bundled`) |
|---|---|---|
| Size over years | 10 transactions a day is about 36,000 rows in ten years, rewritten in full on each edit | Changes only the rows touched |
| Reports | Load everything, sum in Rust | `GROUP BY` month and category on integers, with indexes on `(date)` and `(account_id, date)` |
| A transfer's two legs | One save, but nothing enforces that both legs exist | One transaction: both legs are written or neither is |
| Imports of 2,000 rows with duplicate checks | Slow linear scans | A unique index on `import_hash` |
| Crash halfway through a save | Temp file then rename (as Notes does) | Write-ahead log, atomic commits |
| Cost | Nothing new | One crate (`rusqlite` 0.41, MIT), about 1 MB in the binary and a C compile of SQLite |

**Recommendation: SQLite** at `money/money.db` in the app data folder, opened by one Rust thread
behind a `Mutex`, as the Notes store is. Migrations are numbered SQL files run at start, and
`PRAGMA user_version` records which ones ran.

**Backups.** Once a day and before each migration or import, `VACUUM INTO money/backups/YYYY-MM-DD.db`.
Keep 14 daily and 12 monthly copies. Settings → Money lists them with a Restore button.

## 6. Privacy lock

- While CorePro is locked, the backend refuses every `money_*` command, as it already refuses to
  serve images. The section hides its content, as private albums do.
- An optional "Ask before showing Money" setting (off by default) calls `shell.lock.authorize()`
  when the section opens, like hidden albums.
- Hide amounts (section 2) works without a lock configured and stays on across restarts.
- Amounts never appear in window titles, notifications or Quick Look thumbnails.

## 7. Receipts, import and export

**Receipts.** Drop an image or PDF onto a transaction, use "Attach…" (file dialog), or right-click a
photo in Files or the Gallery and choose "Attach to transaction…". The file is copied into
`money/receipts/<hash>.<ext>`, so moving or deleting the original never breaks the link.
Thumbnails come from the existing `imaging.rs` cache and pictures open in Quick Look. Reading the
amount from a receipt photo (OCR with Tesseract) waits for the backlog.

**Import.** CSV through the `csv` crate, and XLSX, XLS and ODS through `calamine` (MIT, read-only;
reads xls, xlsx, xlsb and ods, but not formatting, which an import doesn't need,
[repo](https://github.com/tafia/calamine)). The steps:

1. Pick a file. CorePro sniffs the delimiter, encoding (UTF-8, or Windows-1252 from old bank
   exports), header row and date format.
2. Map the columns: date, description, amount, or separate debit and credit columns, plus an
   optional balance. Save the mapping as a profile per bank.
3. Preview. Each row shows the rule that categorised it and is marked if it is a duplicate:
   `import_hash` is a hash of the account, date, amount and normalised description.
4. Commit in one SQLite transaction. "Undo import" removes that batch.

bKash and most banks also offer PDF statements. Parsing PDFs is fragile, so it comes later, one
issuer at a time, from sample statements (section 11).

**Export.** CSV for any filtered list, XLSX with one sheet per month or account through
`rust_xlsxwriter` (Apache-2.0, [repo](https://github.com/jmcnamara/rust_xlsxwriter)), and a full
JSON export as a backup that other apps can read.

## 8. Links to Time and Notes

**Time → Money: what your hours earn.**

- `project_rates` gives each Time project an hourly rate and currency. It is set in Money →
  Settings, or from a project's menu in Time if Time adds one.
- Money asks Time for hours per project in a date range. That needs one small read command in the
  Time backend, for example `time_project_hours(from, to) -> [{ project, minutes }]`. This is the
  only change Money needs from Time.
- Overview and Reports gain an **Earnings** card: tracked hours × rate per project for the month.
  "Record as income" posts it as one income transaction per project, tagged with `time_project` so
  it is never posted twice for the same month.
- **Cost in hours** (optional): next to any expense, how many hours of work it took at your average
  effective rate. For example, "৳4,500 ≈ 3 h 10 m".

**Notes.** A transaction's note can link a sticky note: the link opens it with `notesApi.open`. "Send
to Notes" turns the month's summary, or a Bills list, into a Markdown note, and a checklist note
works as a shopping list. Notes stay optional: without the Notes feature, these entries hide.

## 9. Sync and backups across computers

Notes sync by keeping one Markdown file per note in a cloud-drive folder (`notes/sync.rs`). Copying
`money.db` into such a folder would be unsafe: a drive client can upload a half-written database,
and two computers would overwrite each other. Instead:

- **An append-only change log per device.** Each change to a row is a line of JSON (the full row
  with `updated`) in `<folder>/CorePro Money/<device-id>/<YYYY-MM>.log`. A device only ever writes
  its own files, so the drive never sees a write conflict.
- **Merge.** Each device reads the other devices' logs from where it last stopped and applies each
  row if its `updated` is newer. The last writer wins per row. Deletes are rows with `deleted` set.
  Both legs of a transfer travel in one line.
- **Encrypted.** Each line is sealed with XChaCha20-Poly1305 (`chacha20poly1305` crate). The key is
  derived from a sync passphrase with Argon2, which CorePro already uses for the lock. The drive's
  website then shows only ciphertext. (Notes are readable on the web by design; money should not
  be.)
- The same folder picker and status chip as Notes, in Settings → Money. An empty-looking
  (unmounted) folder never deletes anything, as with Notes.

## 10. Backend commands

All in `src-tauri/src/money/` (`mod.rs` store and migrations, `import.rs`, `export.rs`,
`sync.rs`, `report.rs`). Every change emits `money-changed` to all windows, the same pattern as
`notes-changed`.

| Command | Purpose |
|---|---|
| `money_accounts`, `money_account_save`, `money_account_archive` | Accounts with live balances |
| `money_categories`, `money_category_save`, `money_category_merge` | Category tree; merging moves the transactions |
| `money_tx_list { filter, cursor, limit }` | Paged transactions (100 per page) and the filtered sum |
| `money_tx_save`, `money_tx_delete`, `money_tx_bulk { ids, patch }` | Edit one or many |
| `money_transfer_save` | Both legs and an optional fee, in one transaction |
| `money_parse_quick { text }` | Quick-add guess: amount, category, account, date |
| `money_budgets { month }`, `money_budget_set`, `money_budgets_copy { from, to }` | Budgets with spent amounts |
| `money_recurring`, `money_recurring_save`, `money_recurring_post { id, date }` | Bills, and posting a due one |
| `money_report { kind, from, to }` | Rows for charts: by category, by month, net worth, budget vs actual, earnings |
| `money_receipt_attach { tx, path }`, `money_receipt_remove` | Receipts |
| `money_import_preview { path, profile }`, `money_import_commit`, `money_import_undo` | Import wizard |
| `money_export { kind, filter, path }` | CSV, XLSX or JSON |
| `money_rates`, `money_rate_set` | Exchange rates |
| `money_backups`, `money_backup_restore` | Daily snapshots |
| `money_sync_status`, `money_sync_set_folder`, `money_sync_now` | As the Notes sync commands |

Recurring bills are posted or reminded by a check at start-up and every hour, catching up on days
when CorePro wasn't running.

## 11. Decisions

Decided on 2026-10-26: the name is **Wallet**. For the rest, the recommendations below were taken
for now: SQLite; BDT with Latin digits and lakh/crore grouping (৳1,25,000), other currencies with a
rate typed by hand; no sync yet; no bank-specific import profiles yet; Time earnings later (F5);
no Zakat helper or lending yet. These can still change:

1. **Name on the rail.** Wallet (decided).
2. **Base currency and digits.** BDT with Latin digits (৳1,25,000), or Bangla digits (৳১,২৫,০০০)?
   Which other currencies do you use?
3. **Storage.** SQLite as recommended (section 5), or stay with JSON like Notes for simplicity?
4. **Which statements first.** Which banks and wallets (City, BRAC, DBBL, bKash, Nagad…)? A sample
   statement from each, with numbers blanked, is needed to build its import profile.
5. **Sync.** Encrypted change log in a cloud folder (recommended), plain files the drive website
   can read, or no sync at first?
6. **Exchange rates.** Typed in by hand, or fetched daily from a free rates service? Fetching sends
   that service a request every day, but no amounts.
7. **Earnings from Time.** Hourly rates per project (as proposed), per task, or one rate for
   everything? Should "Record as income" be manual, or post automatically at the end of each month?
8. **Extras.** Do you want a Zakat helper (2.5% of zakatable wealth above nisab, held for a lunar
   year), tracking money lent and borrowed, and the quick-add desktop shortcut?

## 12. Milestones

| # | Milestone | Done when |
|---|---|---|
| F1 ✓ | **Ledger**: SQLite store with migrations, accounts, categories, transactions, transfers with fees, quick add, Transactions view, hide amounts, lock refusal | A month of entries across cash, bank and bKash gives the right balances. Rust tests cover transfer legs, signed sums and minor-unit formatting for 0-, 2- and 3-decimal currencies. |
| F2 ✓ | **Plans**: budgets, Overview, Reports (SVG charts from tokens), daily backups | Budget bars match the hand-calculated figures. Charts read in light and dark themes. Restoring a backup works. |
| F3 | **Bills and receipts**: recurring rules with catch-up, Bills view, receipt attach from the dialog, drag and drop, Files and Gallery | A monthly bill posts once after CorePro was closed for 40 days (one post per missed month, or a single reminder, as configured). Receipts survive moving the original file. |
| F4 | **Import and export**: CSV/XLSX wizard with profiles, rules, duplicates and undo; CSV, XLSX and JSON export | Importing the same statement twice adds nothing the second time. Undo removes the whole batch. |
| F5 | **Time link**: `time_project_hours`, project rates, Earnings card, record as income, cost in hours | Earnings match Time's report for the month, and posting twice is refused. |
| F6 | **Sync**: encrypted per-device change logs, merge, status chip | Two profiles on one computer, syncing through a shared folder, converge after offline edits on both sides. A wrong passphrase reads nothing and deletes nothing. |

## 13. Risks

| Risk | Mitigation |
|---|---|
| Rounding errors | Integers in minor units everywhere. Rates are integer millionths. Conversion rounds half away from zero once per transaction, and tests cover it. |
| Losing financial history | SQLite WAL, daily `VACUUM INTO` backups, soft deletes, undo for imports and bulk edits. |
| Bank CSV formats change | Import profiles are data, not code. The preview shows any mismatch before commit. |
| Sync conflicts and data leaks | Per-device logs (no shared file is ever rewritten), last writer wins per row, encryption at rest on the drive. |
| Scope creep (investments, taxes, sharing) | Behind its own feature switch. Extras go to the backlog once the ledger is solid. |
