# Wallet: personal cost management

*Written 2026-10-26. Status: **F1–F5 built** (`src/modules/wallet`, `src-tauri/src/wallet`); F6
(sync) waits, as decided. Section 11 records the decisions. Wallet is the second "self
management" section, after Time (`src-tauri/src/time/`).*

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
  Every `wallet_*` command refuses while Zazabor is locked, and locking clears the section.
- **Backups**: a copy each day (`VACUUM INTO wallet/backups/YYYY-MM-DD.db`, the last 14 kept),
  and a "before-restore" copy before any restore.
- **Roll-over and archiving** (2026-10-27): a budget can roll over (what's left of last month's,
  never below zero, follows back through months that roll over too); categories archive from
  their sheet (a top category takes its sub-categories) and leave the pickers but keep their
  history. **Settings → Wallet**: hide amounts by default, the base currency, hourly rates for
  Time projects, backups with Restore.

### Added 2026-10-27 (F3–F5)

Migration 2 adds `recurring`, `receipts`, `rules`, `import_profiles`, `import_batches` and
`project_rates`, plus `rollover` on budgets and `recurring_id`, `import_batch`, `import_hash`,
`time_project` and `time_month` on transactions (a unique index makes a project's month post once).

- **Bills (F3)**, `bills.rs` and the Bills view: daily, weekly, monthly (a day, or the last day;
  the 31st falls on the month's last day without drifting) and yearly rules, every N periods, a
  first date and an optional end. A bill either **posts by itself**: on the day, and for every
  date it missed while Zazabor was closed, each date in one SQLite transaction with moving the
  rule on, so a second run or a crash never posts twice (checked at start, each hour while
  unlocked, and whenever bills are listed). Or it **reminds**: it stays due, once, with the count
  of missed dates ("2 unpaid · since 10 Sep"), until Mark Paid posts the next date or Skip passes
  it. Pause, Delete (what it posted stays), Subscriptions and Income filters, the cost per year,
  "Repeat…" on any transaction, and a Coming up card on Overview with Mark Paid.
- **Receipts (F3)**, `receipts.rs`: pictures and PDFs (40 MB at most) are copied into
  `wallet/receipts/<xxh3-128>.<ext>`, so the original can move or go; the same file is stored
  once. Attach from the transaction sheet (Zazabor's own picker), by dropping files on the sheet
  or on a row (`drops.ts` claims the drop so the shell doesn't open the file), from Files'
  context menu ("Attach to Wallet Transaction…", in any window), or on a new transaction before
  it's added. Thumbnails open in a viewer window; rows show a paperclip. A file no receipt points
  to is deleted after 15 days, so restoring a backup (14 kept) still finds its receipts.
- **Import (F4)**, `import.rs` and Import & Export: CSV/TSV/TXT (UTF-8, or Windows-1252 from
  old exports; the separator sniffed) and `.xlsx` through the `ironcalc` crate already used by
  Sheets (`.xls`/`.ods` are asked to be saved as `.xlsx` first, so no `calamine`). The mapping is
  guessed (header row, date, description, one amount or money out/in, a category column, date
  order, decimal comma, "Dr"/"Cr", brackets) and can be changed or saved as a profile; a profile
  saved for the account is used first. The preview shows every row with its category (a rule,
  then a category column, then quick add's guess: payees seen before and words like "foodpanda"
  or "desco"), duplicates and rows that aren't transactions (opening balances, totals); rows can
  be left out or recategorised. Commit re-reads the file with the same mapping (the page sends
  only its choices) and adds one batch; the duplicate key is the account, date, amount,
  description and how many identical rows came before it in the file. Undo removes a batch.
  Rules (words → category and a cleaner payee) are managed on the same view.
- **Export (F4)**, `export.rs`: CSV (UTF-8 with BOM, as Excel opens it) and `.xlsx` with a sheet
  per month (text that looks like a formula stays text) of the transactions the filters show,
  and a JSON copy of every table.
- **Earnings (F5)**, `earnings.rs` and `time_project_hours` in Time: minutes of work per task
  project in local month bounds, hourly rates per project in any currency, an Earnings card on
  Overview (hours × rate, base-currency total), and "Record as income": one income transaction
  per project into an account of the rate's currency, dated today in the current month or the
  month's last day; a project's month is refused the second time.

Checked: 25 Wallet tests (bills catch-up and reminders, schedules, receipts surviving the
original, imports twice and undo, money cells and statement dates, exports read back, earnings
refused twice) and one in Time; in the app on a nested display, a monthly bill started 5 August
posted August–October at once, a reminder showed "2 unpaid" and Mark Paid moved it on, a bank CSV
imported with the right categories, re-importing found only the row left out, Undo restored the
balance, a receipt attached from the sheet and from Files, roll-over carried ৳1,000, earnings
recorded once, and Excel export read back. Dropping files from the desktop wasn't tried (the
test display has no app to drag from).

Not done: bank- and wallet-specific profiles (they need sample statements, section 11),
"Cost in hours" next to expenses, receipts from the Gallery (the viewer
has no menu for it yet), "Send to Notes", reminders as desktop notifications, and F6 sync.


### Statements (round 3, 2026-10-27)

`src-tauri/src/statements/` (parse, layout, build, xlsx, ai, keys) and `src/shared/statements/`.

- **Reading a statement**: PDF (pdf.js in the page sends the text with its positions), CSV, TSV,
  TXT and `.xlsx`. The heading row names the columns (date, particulars, reference, withdrawal and
  deposit or one amount with Dr/Cr, balance). Headings pdf.js joined into one piece ("Chq/Ref No
  Withdrawal") are picked out by name. Wrapped particulars are joined, carried-down dates filled
  in and newest-first statements turned round. The bank, the account's last four digits, the
  period and the opening and closing balances come from the lines around the table. A check
  runs the balance down the rows and compares the totals; rows that don't add up are flagged,
  never changed.
- **Reading with Claude**: scans, photos and statements the reader can't make out go to Claude.
  Settings → AI holds an Anthropic API key, the model (default `claude-opus-5-5`) and a consent
  switch; nothing is sent without the key and the consent.
  - The request is raw HTTPS from Rust (`reqwest`), streamed, with structured output (a JSON
    schema of the statement). PDFs go as a document block, pictures downscaled to 2400 px.
  - Rate limits and overload are retried; refusals and statements too long to answer are
    reported.
  - The key is kept in the desktop's Secret Service keyring, or in a 0600 file under `ai/` when
    there's no keyring. The page never sees it.
  - Every AI command is refused while Zazabor is locked, and the balance check runs on Claude's
    rows too.
- **Statement to Excel**: a review dialog shows the statement's details, the rows (flagged ones
  marked) and whether the balance adds up. Save as Excel writes a Transactions sheet (real dates,
  ৳ formats, flagged rows shaded, SUM totals, frozen header) and a Summary sheet. In PDF, Convert
  has Statement to Excel, and Tables to Excel for any PDF's tables (columns from where the text
  lines up, with joined headings cut at the gutters of the rows below).
- **Upload to Wallet**: Import & Export → Upload Statement… (or drop a statement on the card).
  - The account is guessed: the bank and last four digits remembered from before, else an
    account whose name has them, else "New account: The City Bank ••9012", opening at the
    statement's opening balance. Rows already in Wallet are dimmed.
  - The rows go through the same staged import as a CSV, as one batch named after the file,
    so Undo removes them.
  - With Settings → Wallet → "Import statements automatically", a statement that adds up, has
    no flagged rows and has a known account imports without the dialog.
- **Excel round trip**: Wallet's own Excel export imports back. An Account column puts rows into
  that account, "Food › Eating out" matches its category, and rows already in the ledger (same
  date, amount and payee) show as duplicates. Export's toast offers Open in Sheets.

Checked: 19 statement tests and 27 Wallet tests (Wallet's own Excel export comes back without
duplicates).
- The statement tests cover CSV, PDF pages with tight and joined headings, the balance check, the
  workbook read back, a staged import added once and undone, and the settings and key file.
- They also send the Claude request to a local stand-in: a rate limit is retried, and a refusal
  and a bad request are reported.

In the app on a nested display, with made-up statements:
- A City Bank PDF added up (৳50,000 + ৳1,10,112.50 − ৳32,119 = ৳1,27,993.50). Its Excel file read
  back the same, it imported into a new "The City Bank ••9012" at ৳1,27,993.50, and uploading it
  again showed every row already in Wallet.
- A newest-first bKash PDF and a BRAC CSV imported.
- Tables to Excel kept every column of the City page.
- A scan with AI off asked for Claude. With a key and consent it was read through a local
  stand-in for the Messages API.

**The live Claude call is untested**: there is no API key on this machine. Settings → AI → Test
checks it once a key is added.

Not done:
- Bank-specific profiles; they need real statements.
- A watched "statements inbox" folder.
- Wallet's multi-sheet export imports one sheet at a time.
- Without a running Secret Service, saving or reading the key waits for the keyring to time out
  before it uses the file.

## 1. Goals

- **One person's money in one place.** Where it comes from, where it goes, and what is left in
  each wallet: cash, bank accounts, cards and mobile wallets (bKash, Nagad, Rocket).
- **Fast to enter.** A transaction takes a few seconds from anywhere: a quick-add field in the
  section, and a desktop shortcut like the quick note (`zazabor --new-note`).
- **Honest numbers.** Money is stored as integers in minor units (poisha, cents), never floats.
  Transfers move money between your own accounts without counting as spending.
- **Plans, not just history.** Monthly budgets per category, recurring bills and subscriptions with
  their next due dates, and reports that show the trend.
- **Works with the rest of Zazabor.** Receipts come from Files and the Gallery. Earnings come from
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

- While Zazabor is locked, the backend refuses every `money_*` command, as it already refuses to
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

1. Pick a file. Zazabor sniffs the delimiter, encoding (UTF-8, or Windows-1252 from old bank
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
  with `updated`) in `<folder>/Zazabor Money/<device-id>/<YYYY-MM>.log`. A device only ever writes
  its own files, so the drive never sees a write conflict.
- **Merge.** Each device reads the other devices' logs from where it last stopped and applies each
  row if its `updated` is newer. The last writer wins per row. Deletes are rows with `deleted` set.
  Both legs of a transfer travel in one line.
- **Encrypted.** Each line is sealed with XChaCha20-Poly1305 (`chacha20poly1305` crate). The key is
  derived from a sync passphrase with Argon2, which Zazabor already uses for the lock. The drive's
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
when Zazabor wasn't running.

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
| F3 ✓ | **Bills and receipts**: recurring rules with catch-up, Bills view, receipt attach from the dialog, drag and drop, Files and Gallery | A monthly bill posts once after Zazabor was closed for 40 days (one post per missed month, or a single reminder, as configured). Receipts survive moving the original file. |
| F4 ✓ | **Import and export**: CSV/XLSX wizard with profiles, rules, duplicates and undo; CSV, XLSX and JSON export | Importing the same statement twice adds nothing the second time. Undo removes the whole batch. |
| F5 ✓ | **Time link**: `time_project_hours`, project rates, Earnings card, record as income, cost in hours | Earnings match Time's report for the month, and posting twice is refused. |
| F6 | **Sync**: encrypted per-device change logs, merge, status chip | Two profiles on one computer, syncing through a shared folder, converge after offline edits on both sides. A wrong passphrase reads nothing and deletes nothing. |

## 13. Risks

| Risk | Mitigation |
|---|---|
| Rounding errors | Integers in minor units everywhere. Rates are integer millionths. Conversion rounds half away from zero once per transaction, and tests cover it. |
| Losing financial history | SQLite WAL, daily `VACUUM INTO` backups, soft deletes, undo for imports and bulk edits. |
| Bank CSV formats change | Import profiles are data, not code. The preview shows any mismatch before commit. |
| Sync conflicts and data leaks | Per-device logs (no shared file is ever rewritten), last writer wins per row, encryption at rest on the drive. |
| Scope creep (investments, taxes, sharing) | Behind its own feature switch. Extras go to the backlog once the ledger is solid. |
