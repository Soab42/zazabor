//! Wallet: one person's money (docs/plans/money.md). Accounts and wallets (cash, banks, bKash and
//! other mobile wallets, cards), spending and income in categories, transfers with their fees,
//! monthly budgets and reports. The ledger is a SQLite database, `wallet/wallet.db` in the app's
//! data folder (`db.rs`), with a copy kept each day in `wallet/backups/` (the last 14).
//!
//! Every command refuses while Zazabor is locked; changes go out to all windows as `wallet-changed`.

mod bills;
mod cards;
pub(crate) mod dates;
mod db;
mod earnings;
mod export;
mod fdr;
pub(crate) mod import;
pub(crate) mod money;
mod plans;
mod quick;
mod receipts;
pub(crate) mod sync;
pub(crate) mod sync_net;

use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::Emitter;

use crate::notes::now;
use dates::civil_from_days;
use db::{db_err, Result};

/// A receipt file nothing points to is kept this long, so restoring a backup (14 are kept)
/// finds its receipts.
const RECEIPT_GRACE: std::time::Duration = std::time::Duration::from_secs(15 * 86_400);

/// Daily copies kept.
const KEEP_BACKUPS: usize = 14;

struct Store {
    dir: PathBuf,
    /// `None` when the database couldn't be opened (the error is kept for the page).
    conn: Option<Connection>,
    error: Option<String>,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn store() -> MutexGuard<'static, Store> {
    STORE.get().expect("wallet::init runs at startup").lock().unwrap_or_else(|e| e.into_inner())
}

fn open(dir: &Path) -> Result<Connection> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Wallet can't make its folder: {e}"))?;
    let mut conn = Connection::open(dir.join("wallet.db")).map_err(db_err)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;").map_err(db_err)?;
    db::migrate(&mut conn, now())?;
    sync::install(&conn)?;
    // DPS and loans made before payments had a ledger of their own.
    if let Err(err) = plans::adopt(&mut conn, now()) {
        eprintln!("Wallet: couldn't carry over the DPS and loan payments: {err}");
    }
    Ok(conn)
}

/// Runs `f` on a thread of its own (imports and exports read and write files).
fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> impl std::future::Future<Output = Result<T>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// Posts the bills and the DPS and loan installments that post by themselves and are due, then
/// tells the windows.
fn post_due_bills() -> Result<usize> {
    let posted = {
        let mut store = store();
        let Some(conn) = store.conn.as_mut() else { return Ok(0) };
        bills::post_due(conn, &today(), now())? + plans::post_due(conn, &today(), now())? + fdr::post_due(conn, &today(), now())?
    };
    if posted > 0 {
        if let Some(app) = APP.get() {
            let _ = app.emit("wallet-changed", ());
        }
    }
    Ok(posted)
}

/// Opens the ledger and starts the daily backup. `dir` is the app's data folder.
pub fn init(app: tauri::AppHandle, dir: PathBuf) {
    let dir = dir.join("wallet");
    let (conn, error) = match open(&dir) {
        Ok(conn) => (Some(conn), None),
        Err(err) => {
            eprintln!("Wallet: {err}");
            (None, Some(err))
        }
    };
    let _ = STORE.set(Mutex::new(Store { dir, conn, error }));
    let _ = APP.set(app);
    listen_if_paired();
    // Each hour (and at start): the day's backup, then the bills that came due, catching up on
    // the days Zazabor wasn't running. Neither runs while Zazabor is locked.
    let _ = std::thread::Builder::new().name("wallet-backup".into()).spawn(|| loop {
        if let Err(err) = backup_if_due() {
            eprintln!("Wallet backup: {err}");
        }
        if crate::ensure_unlocked().is_ok() {
            if let Err(err) = post_due_bills() {
                eprintln!("Wallet bills: {err}");
            }
        }
        let _ = {
            let store = store();
            store.conn.as_ref().map(|conn| receipts::sweep(conn, &store.dir, RECEIPT_GRACE))
        };
        std::thread::sleep(std::time::Duration::from_secs(3600));
    });
}

fn with<T>(f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let error = store.error.clone();
    let conn = store.conn.as_mut().ok_or_else(|| error.unwrap_or_else(|| "Wallet couldn't open its database.".into()))?;
    f(conn)
}

/// A change: tells every window when it worked.
fn change<T>(f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    let out = with(f)?;
    if let Some(app) = APP.get() {
        let _ = app.emit("wallet-changed", ());
    }
    Ok(out)
}

// ---- backups

/// Milliseconds since the epoch at local midnight starting a date.
fn local_midnight(date: &str) -> i64 {
    let (y, m, d) = dates::parts(date);
    #[cfg(unix)]
    // SAFETY: mktime only reads and normalises the struct handed to it.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        tm.tm_year = (y - 1900) as i32;
        tm.tm_mon = m as i32 - 1;
        tm.tm_mday = d as i32;
        tm.tm_isdst = -1;
        let t = libc::mktime(&mut tm);
        if t != -1 {
            return t as i64 * 1000;
        }
    }
    dates::days_from_civil(y, m, d) * 86_400_000
}

/// Today's local date, "YYYY-MM-DD".
fn today() -> String {
    #[cfg(unix)]
    // SAFETY: time and localtime_r only write the values handed to them.
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if !libc::localtime_r(&t, &mut tm).is_null() {
            return format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);
        }
    }
    let days = now().div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}


#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub name: String,
    pub size: u64,
    /// Milliseconds since the epoch.
    pub modified: i64,
}

fn backups_dir(dir: &Path) -> PathBuf {
    dir.join("backups")
}

fn list_backups(dir: &Path) -> Vec<Backup> {
    let mut list: Vec<Backup> = std::fs::read_dir(backups_dir(dir))
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let meta = e.metadata().ok()?;
                    name.ends_with(".db").then(|| Backup {
                        name,
                        size: meta.len(),
                        modified: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| b.modified.cmp(&a.modified).then(b.name.cmp(&a.name)));
    list
}

/// Copies the ledger to `backups/<name>` (replacing one of that name).
fn backup_to(conn: &Connection, dir: &Path, name: &str) -> Result<()> {
    let folder = backups_dir(dir);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Can't make the backups folder: {e}"))?;
    let path = folder.join(name);
    let _ = std::fs::remove_file(&path);
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()]).map_err(db_err)?;
    Ok(())
}

/// The day's backup, once a day; the oldest dated ones beyond `KEEP_BACKUPS` go.
fn backup_if_due() -> Result<()> {
    let store = store();
    let Some(conn) = store.conn.as_ref() else { return Ok(()) };
    let name = format!("{}.db", today());
    if backups_dir(&store.dir).join(&name).exists() {
        return Ok(());
    }
    backup_to(conn, &store.dir, &name)?;
    let mut dated: Vec<String> = list_backups(&store.dir).into_iter().map(|b| b.name).filter(|n| db::valid_date(n.trim_end_matches(".db"))).collect();
    dated.sort_by(|a, b| b.cmp(a));
    for old in dated.iter().skip(KEEP_BACKUPS) {
        let _ = std::fs::remove_file(backups_dir(&store.dir).join(old));
    }
    Ok(())
}

// ---- for other modules' tests

#[cfg(test)]
pub(crate) fn db_for_tests() -> Connection {
    db::tests::fresh()
}

#[cfg(test)]
pub(crate) fn account_for_tests(conn: &Connection, name: &str) -> String {
    db::tests::add_account(conn, name, "bank", "BDT", None)
}

// ---- commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    base: &'static str,
    currencies: &'static [money::Currency],
    accounts: Vec<db::Account>,
    categories: Vec<db::Category>,
    rates: Vec<db::Rate>,
    /// Past payees, most used first.
    payees: Vec<String>,
}

/// Accounts with balances, categories, rates: what every view needs.
#[tauri::command]
pub fn wallet_state() -> Result<State> {
    with(|conn| {
        Ok(State {
            base: money::BASE,
            currencies: money::CURRENCIES,
            accounts: db::accounts(conn)?,
            categories: db::categories(conn)?,
            rates: db::rates(conn)?,
            payees: db::payees(conn)?,
        })
    })
}

#[tauri::command]
pub fn wallet_account_save(account: db::AccountInput) -> Result<db::Account> {
    change(|conn| db::save_account(conn, account, now()))
}

#[tauri::command]
pub fn wallet_account_archive(id: String, archived: bool) -> Result<()> {
    change(|conn| db::archive_account(conn, &id, archived, now()))
}

#[tauri::command]
pub fn wallet_account_delete(id: String) -> Result<()> {
    change(|conn| db::delete_account(conn, &id))
}

#[tauri::command]
pub fn wallet_rate_set(currency: String, rate: String) -> Result<()> {
    change(|conn| db::set_rate(conn, &currency, &rate, now()))
}

#[tauri::command]
pub fn wallet_category_save(category: db::CategoryInput) -> Result<db::Category> {
    change(|conn| db::save_category(conn, category, now()))
}

#[tauri::command]
pub fn wallet_category_delete(id: String, move_to: Option<String>) -> Result<()> {
    change(|conn| db::delete_category(conn, &id, move_to.as_deref()))
}

#[tauri::command]
pub fn wallet_tx_list(filter: db::Filter) -> Result<db::TxPage> {
    with(|conn| db::list(conn, &filter))
}

#[tauri::command]
pub fn wallet_tx_save(tx: db::TxInput) -> Result<db::Tx> {
    change(|conn| db::save_tx(conn, tx, now()))
}

#[tauri::command]
pub fn wallet_tx_delete(ids: Vec<String>) -> Result<usize> {
    let n = change(|conn| {
        let n = db::delete_txs(conn, &ids)?;
        // A DPS or loan payment deleted here leaves its table.
        plans::after_delete(conn, now())?;
        fdr::after_delete(conn, now())?;
        Ok(n)
    })?;
    sweep_receipts();
    Ok(n)
}

/// Deletes receipt files nothing points to any more.
fn sweep_receipts() {
    let store = store();
    if let Some(conn) = store.conn.as_ref() {
        let _ = receipts::sweep(conn, &store.dir, RECEIPT_GRACE);
    }
}

#[tauri::command]
pub fn wallet_category_archive(id: String, archived: bool) -> Result<()> {
    change(|conn| db::archive_category(conn, &id, archived, now()))
}

#[tauri::command]
pub fn wallet_budget_rollover(month: String, category_id: String, on: bool) -> Result<()> {
    change(|conn| db::set_rollover(conn, &month, &category_id, on))
}

// ---- bills

/// Every bill; `today` is the page's local date (for what's due).
#[tauri::command]
pub fn wallet_bills(today: String) -> Result<Vec<bills::Bill>> {
    crate::ensure_unlocked()?;
    // Catches up first (the hourly check skips while Zazabor is locked).
    post_due_bills()?;
    with(|conn| bills::list(conn, &today))
}

#[tauri::command]
pub fn wallet_bill_save(bill: bills::BillInput, today: String) -> Result<bills::Bill> {
    let saved = change(|conn| bills::save(conn, bill, &today, now()))?;
    // A bill that posts by itself and started in the past catches up at once.
    if post_due_bills()? > 0 {
        return with(|conn| bills::get(conn, &saved.id, &today));
    }
    Ok(saved)
}

#[tauri::command]
pub fn wallet_bill_pause(id: String, paused: bool) -> Result<()> {
    change(|conn| bills::set_paused(conn, &id, paused, now()))
}

#[tauri::command]
pub fn wallet_bill_delete(id: String) -> Result<()> {
    change(|conn| bills::delete(conn, &id))
}

/// Marks the next due date as paid (on `date`, or the due date); returns the transaction.
#[tauri::command]
pub fn wallet_bill_pay(id: String, date: Option<String>, today: String) -> Result<db::Tx> {
    change(|conn| {
        let tx = bills::pay(conn, &id, date.as_deref(), &today, now())?;
        db::tx(conn, &tx)
    })
}

#[tauri::command]
pub fn wallet_bill_skip(id: String, today: String) -> Result<()> {
    change(|conn| bills::skip(conn, &id, &today, now()))
}

// ---- credit cards

/// Each card's limit, statement and what's due on it.
#[tauri::command]
pub fn wallet_cards(today: String) -> Result<Vec<cards::CardStatus>> {
    with(|conn| cards::all(conn, &today))
}

// ---- DPS and loans

/// Every DPS and loan; `today` is the page's local date (for what's due).
#[tauri::command]
pub fn wallet_plans(today: String) -> Result<Vec<plans::Plan>> {
    crate::ensure_unlocked()?;
    post_due_bills()?;
    with(|conn| plans::list(conn, &today))
}

/// One DPS or loan with its table.
#[tauri::command]
pub fn wallet_plan(id: String, today: String) -> Result<plans::PlanDetail> {
    with(|conn| plans::detail(conn, &id, &today))
}

/// What the terms work out to, before saving.
#[tauri::command]
pub fn wallet_plan_preview(plan: plans::PlanInput) -> Result<plans::Preview> {
    with(|conn| plans::preview(conn, &plan))
}

#[tauri::command]
pub fn wallet_plan_save(plan: plans::PlanInput, today: String) -> Result<plans::PlanDetail> {
    let saved = change(|conn| plans::save(conn, plan, &today, now()))?;
    // One that pays by itself and started in the past catches up at once.
    if post_due_bills()? > 0 {
        return with(|conn| plans::detail(conn, &saved.plan.id, &today));
    }
    Ok(saved)
}

/// Marks an installment as paid (on `date`, else its own date, or today when that's ahead).
#[tauri::command]
pub fn wallet_plan_pay(id: String, no: i64, date: Option<String>, today: String) -> Result<plans::PlanDetail> {
    change(|conn| {
        plans::pay(conn, &id, no, date.as_deref(), &today, now())?;
        plans::detail(conn, &id, &today)
    })
}

/// Adds or changes a payment on a DPS or loan; returns the table worked out again.
#[tauri::command]
pub fn wallet_plan_payment_save(payment: plans::PaymentInput, today: String) -> Result<plans::PlanDetail> {
    change(|conn| plans::save_payment(conn, payment, &today, now()))
}

#[tauri::command]
pub fn wallet_plan_payment_delete(id: String, today: String) -> Result<plans::PlanDetail> {
    change(|conn| plans::delete_payment(conn, &id, &today, now()))
}

/// Reads a pasted loan or DPS statement into the payments already made; with `apply` off, only
/// says what it found.
#[tauri::command]
pub fn wallet_plan_import(id: String, text: String, by_day: bool, apply: bool, today: String) -> Result<plans::StatementImport> {
    if apply {
        change(|conn| plans::import_statement(conn, &id, &text, by_day, true, &today, now()))
    } else {
        with(|conn| plans::import_statement(conn, &id, &text, by_day, false, &today, now()))
    }
}

// ---- FDRs

/// Every FDR with its interest payments.
#[tauri::command]
pub fn wallet_fdrs(today: String) -> Result<Vec<fdr::FdrDetail>> {
    crate::ensure_unlocked()?;
    post_due_bills()?;
    with(|conn| fdr::list(conn, &today))
}

#[tauri::command]
pub fn wallet_fdr_save(fdr: fdr::FdrInput, today: String) -> Result<fdr::FdrDetail> {
    let saved = change(|conn| fdr::save(conn, fdr, &today, now()))?;
    if post_due_bills()? > 0 {
        return with(|conn| fdr::detail(conn, &saved.fdr.id, &today));
    }
    Ok(saved)
}

/// Marks an interest payment as received (on `date`, else its own date).
#[tauri::command]
pub fn wallet_fdr_receive(id: String, no: i64, date: Option<String>, today: String) -> Result<fdr::FdrDetail> {
    change(|conn| fdr::receive(conn, &id, no, date.as_deref(), &today, now()))
}

#[tauri::command]
pub fn wallet_fdr_delete(id: String) -> Result<()> {
    change(|conn| fdr::delete(conn, &id))
}

#[tauri::command]
pub fn wallet_plan_delete(id: String) -> Result<()> {
    change(|conn| plans::delete(conn, &id))
}

// ---- receipts

#[tauri::command]
pub fn wallet_receipts(transaction_id: String) -> Result<Vec<receipts::Receipt>> {
    crate::ensure_unlocked()?;
    let store = store();
    let conn = store.conn.as_ref().ok_or("Wallet couldn't open its database.")?;
    receipts::list(conn, &store.dir, &transaction_id)
}

/// Copies files into the wallet and attaches them to a transaction.
#[tauri::command]
pub async fn wallet_receipt_attach(transaction_id: String, paths: Vec<String>) -> Result<Vec<receipts::Receipt>> {
    let out = blocking(move || {
        crate::ensure_unlocked()?;
        let store = store();
        let conn = store.conn.as_ref().ok_or("Wallet couldn't open its database.")?;
        paths.iter().map(|p| receipts::attach(conn, &store.dir, &transaction_id, Path::new(p), now())).collect::<Result<Vec<_>>>()
    })
    .await?;
    if let Some(app) = APP.get() {
        let _ = app.emit("wallet-changed", ());
    }
    Ok(out)
}

#[tauri::command]
pub fn wallet_receipt_remove(id: String) -> Result<()> {
    change(|conn| receipts::remove(conn, &id))?;
    sweep_receipts();
    Ok(())
}

// ---- import and export

#[tauri::command]
pub async fn wallet_import_preview(path: String, sheet: Option<u32>, account_id: String, mapping: Option<import::Mapping>) -> Result<import::Preview> {
    blocking(move || with(|conn| import::preview(conn, Path::new(&path), sheet, &account_id, mapping))).await
}

#[tauri::command]
pub async fn wallet_import_commit(path: String, sheet: Option<u32>, account_id: String, mapping: import::Mapping, edits: Vec<import::RowEdit>, label: Option<String>) -> Result<import::Batch> {
    blocking(move || {
        change(|conn| {
            let batch = import::commit(conn, Path::new(&path), sheet, &account_id, &mapping, &edits, now())?;
            // A statement read from a PDF or picture is listed under its own name, not the CSV it became.
            match label.filter(|l| !l.trim().is_empty()) {
                Some(l) => import::rename_batch(conn, &batch.id, &l),
                None => Ok(batch),
            }
        })
    })
    .await
}

#[tauri::command]
pub fn wallet_import_undo(id: String) -> Result<usize> {
    let n = change(|conn| import::undo(conn, &id))?;
    sweep_receipts();
    Ok(n)
}

#[tauri::command]
pub fn wallet_import_batches() -> Result<Vec<import::Batch>> {
    with(|conn| import::batches(conn))
}

#[tauri::command]
pub fn wallet_profiles() -> Result<Vec<import::Profile>> {
    with(|conn| import::profiles(conn))
}

#[tauri::command]
pub fn wallet_profile_save(name: String, account_id: Option<String>, mapping: import::Mapping) -> Result<import::Profile> {
    change(|conn| import::save_profile(conn, &name, account_id.as_deref(), &mapping, now()))
}

#[tauri::command]
pub fn wallet_profile_delete(id: String) -> Result<()> {
    change(|conn| import::delete_profile(conn, &id))
}

#[tauri::command]
pub fn wallet_rules() -> Result<Vec<import::Rule>> {
    with(|conn| import::rules(conn))
}

#[tauri::command]
pub fn wallet_rule_save(rule: import::Rule) -> Result<import::Rule> {
    change(|conn| import::save_rule(conn, rule, now()))
}

#[tauri::command]
pub fn wallet_rule_delete(id: String) -> Result<()> {
    change(|conn| import::delete_rule(conn, &id))
}

/// Writes transactions (filtered) as "csv" or "xlsx", or the whole ledger as "json"; returns how
/// many transactions went out.
#[tauri::command]
pub async fn wallet_export(kind: String, filter: db::Filter, path: String) -> Result<usize> {
    blocking(move || {
        with(|conn| match kind.as_str() {
            "csv" => export::csv(conn, &filter, Path::new(&path)),
            "xlsx" => export::xlsx(conn, &filter, Path::new(&path)),
            "json" => export::json(conn, Path::new(&path), now()),
            _ => Err("Unknown kind of export.".into()),
        })
    })
    .await
}

// ---- earnings from Time

/// Minutes per Time project in a month (local time).
fn month_minutes(month: &str) -> Vec<(String, i64)> {
    let from = local_midnight(&format!("{month}-01"));
    let to = local_midnight(&format!("{}-01", db::add_months(month, 1)));
    crate::time::project_minutes(from, to).into_iter().map(|p| (p.project, p.minutes)).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Earnings {
    rows: Vec<earnings::Earning>,
    rates: Vec<earnings::ProjectRate>,
    /// Every project Time has tracked work on, for the rates.
    projects: Vec<String>,
}

#[tauri::command]
pub fn wallet_earnings(month: String) -> Result<Earnings> {
    crate::ensure_unlocked()?;
    if !db::valid_month(&month) {
        return Err("Pick a month.".into());
    }
    let minutes = month_minutes(&month);
    let projects: Vec<String> = crate::time::project_minutes(0, i64::MAX / 2).into_iter().map(|p| p.project).filter(|p| !p.is_empty()).collect();
    with(|conn| Ok(Earnings { rows: earnings::earnings(conn, &month, &minutes)?, rates: earnings::rates(conn)?, projects }))
}

#[tauri::command]
pub fn wallet_project_rate_set(project: String, rate: String, currency: String) -> Result<()> {
    change(|conn| earnings::set_rate(conn, &project, &rate, &currency, now()))
}

/// Records the month's earnings as income; returns how many transactions were added.
#[tauri::command]
pub fn wallet_earnings_post(month: String, account_id: String, category_id: Option<String>, today: String) -> Result<usize> {
    crate::ensure_unlocked()?;
    if !db::valid_month(&month) {
        return Err("Pick a month.".into());
    }
    let minutes = month_minutes(&month);
    change(|conn| earnings::post(conn, &month, &minutes, &account_id, category_id.as_deref(), &today, now()))
}

#[tauri::command]
pub fn wallet_tx_set_category(ids: Vec<String>, category_id: Option<String>) -> Result<usize> {
    change(|conn| db::set_category(conn, &ids, category_id.as_deref(), now()))
}

#[tauri::command]
pub fn wallet_transfer_save(transfer: db::TransferInput) -> Result<db::Transfer> {
    change(|conn| db::save_transfer(conn, transfer, now()))
}

#[tauri::command]
pub fn wallet_transfer(id: String) -> Result<db::Transfer> {
    with(|conn| db::transfer(conn, &id))
}

/// Reads a quick-add phrase; `today` is the page's local date.
#[tauri::command]
pub fn wallet_parse(text: String, today: String) -> Result<quick::Guess> {
    with(|conn| quick::parse(conn, &text, &today))
}

#[tauri::command]
pub fn wallet_budgets(month: String) -> Result<Vec<db::BudgetRow>> {
    with(|conn| db::budgets(conn, &month))
}

#[tauri::command]
pub fn wallet_budget_set(month: String, category_id: String, amount: String) -> Result<()> {
    change(|conn| db::set_budget(conn, &month, &category_id, &amount))
}

#[tauri::command]
pub fn wallet_budgets_copy(from: String, to: String) -> Result<usize> {
    change(|conn| db::copy_budgets(conn, &from, &to))
}

#[tauri::command]
pub fn wallet_by_category(from: String, to: String) -> Result<Vec<db::CategorySpend>> {
    with(|conn| db::by_category(conn, &from, &to))
}

#[tauri::command]
pub fn wallet_months(last: String, count: i32) -> Result<Vec<db::MonthTotals>> {
    with(|conn| db::months(conn, &last, count))
}

#[tauri::command]
pub fn wallet_backups() -> Result<Vec<Backup>> {
    crate::ensure_unlocked()?;
    Ok(list_backups(&store().dir))
}

/// Today's backup, made now (replacing an earlier one of today).
#[tauri::command]
pub fn wallet_backup_now() -> Result<()> {
    crate::ensure_unlocked()?;
    let store = store();
    let conn = store.conn.as_ref().ok_or("Wallet couldn't open its database.")?;
    backup_to(conn, &store.dir, &format!("{}.db", today()))
}

/// Puts a backup in place of the ledger, after saving the ledger as it was ("before-restore-…").
#[tauri::command]
pub fn wallet_backup_restore(name: String) -> Result<()> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let dir = store.dir.clone();
    if name.contains('/') || name.contains('\\') || !list_backups(&dir).iter().any(|b| b.name == name) {
        return Err("That backup no longer exists.".into());
    }
    if let Some(conn) = store.conn.as_ref() {
        backup_to(conn, &dir, &format!("before-restore-{}.db", now()))?;
    }
    // Close the ledger before replacing its file.
    store.conn = None;
    let db_path = dir.join("wallet.db");
    let copied = std::fs::copy(backups_dir(&dir).join(&name), &db_path).map_err(|e| format!("Couldn't restore: {e}"));
    for side in ["wallet.db-wal", "wallet.db-shm"] {
        let _ = std::fs::remove_file(dir.join(side));
    }
    let reopened = open(&dir);
    match reopened {
        Ok(conn) => {
            store.conn = Some(conn);
            store.error = None;
        }
        Err(err) => store.error = Some(err),
    }
    drop(store);
    copied?;
    if let Some(app) = APP.get() {
        let _ = app.emit("wallet-changed", ());
    }
    Ok(())
}

// ---- sync with other devices (`sync.rs`, `sync_net.rs`)

/// What Settings → Wallet → Devices (and the phone's Sync sheet) shows.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    device: String,
    name: String,
    peers: Vec<sync_net::Peer>,
    /// The port this side listens on, when it does (the desktop, once a phone is paired).
    listening: Option<u16>,
}

/// A pairing on offer: the code and the same as a QR code (SVG).
#[derive(Serialize)]
pub struct SyncInvite {
    code: String,
    svg: String,
}

static LISTENING: OnceLock<u16> = OnceLock::new();

/// What this device is called on the other one.
fn device_name() -> String {
    if cfg!(target_os = "android") {
        return "Android phone".into();
    }
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most `buf.len()` bytes into `buf`.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0;
    let host = if ok { String::from_utf8_lossy(&buf[..buf.iter().position(|b| *b == 0).unwrap_or(0)]).into_owned() } else { String::new() };
    if host.is_empty() { "Computer".into() } else { host }
}

/// The ledger as the sync server's threads see it.
struct StoreLedger;

use sync_net::Ledger as _;

impl sync_net::Ledger for StoreLedger {
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        with(f)
    }
    fn name(&self) -> String {
        device_name()
    }
    fn changed(&self) {
        if let Some(app) = APP.get() {
            let _ = app.emit("wallet-changed", ());
        }
    }
    fn paired(&self, peer: &sync_net::Peer) {
        if let Some(app) = APP.get() {
            let _ = app.emit("wallet-sync-paired", peer.clone());
        }
    }
}

/// Starts answering phones (once; later calls just say where).
fn listen() -> Result<u16> {
    if let Some(port) = LISTENING.get() {
        return Ok(*port);
    }
    let port = sync_net::serve(StoreLedger)?;
    let _ = LISTENING.set(port);
    Ok(port)
}

/// At start: the desktop listens again when it has phones paired.
fn listen_if_paired() {
    if cfg!(target_os = "android") {
        return;
    }
    let paired = with(|c| Ok(sync_net::peers(c)?.iter().any(|p| p.kind == "phone"))).unwrap_or(false);
    if paired {
        if let Err(err) = listen() {
            eprintln!("Wallet sync: {err}");
        }
    }
}

#[tauri::command]
pub fn wallet_sync_info() -> Result<SyncInfo> {
    with(|c| Ok(SyncInfo { device: sync::device(c)?, name: device_name(), peers: sync_net::peers(c)?, listening: LISTENING.get().copied() }))
}

/// Offers a pairing for five minutes (the desktop): starts listening, returns the QR code.
#[tauri::command]
pub fn wallet_sync_invite() -> Result<SyncInvite> {
    let port = listen()?;
    let device = with(|c| sync::device(c))?;
    let code = sync_net::invite(device, device_name(), port).to_code();
    let svg = qrcode::QrCode::with_error_correction_level(code.as_bytes(), qrcode::EcLevel::M)
        .map_err(|e| e.to_string())?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .build();
    Ok(SyncInvite { code, svg })
}

#[tauri::command]
pub fn wallet_sync_cancel_invite() {
    sync_net::cancel_invite();
}

/// Pairs with a computer from its QR code (the phone), then syncs. A phone with nothing of its
/// own yet takes the computer's ledger as it is instead of adding its starter categories to it.
#[tauri::command]
pub async fn wallet_sync_join(code: String) -> Result<sync_net::Outcome> {
    let invite = sync_net::Invite::parse(&code)?;
    blocking(move || {
        with(|c| sync::forget_starter(c))?;
        let out = sync_net::call(&|f| with(|c| f(c)), &invite.device.clone(), Some(&invite), &device_name());
        StoreLedger.changed();
        out
    })
    .await
}

/// Syncs with every paired computer now (the phone). Problems come back per computer.
#[tauri::command]
pub async fn wallet_sync_now() -> Result<Vec<std::result::Result<sync_net::Outcome, String>>> {
    blocking(|| {
        let desktops: Vec<String> = with(|c| Ok(sync_net::peers(c)?.into_iter().filter(|p| p.kind == "desktop").map(|p| p.id).collect()))?;
        let out: Vec<_> = desktops.iter().map(|id| sync_net::call(&|f| with(|c| f(c)), id, None, &device_name())).collect();
        if out.iter().any(|o| o.as_ref().is_ok_and(|o| o.received > 0)) {
            StoreLedger.changed();
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub fn wallet_sync_forget(id: String) -> Result<()> {
    with(|c| sync_net::forget_peer(c, &id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_without_local_time() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_752), (2026, 10, 26));
        assert!(db::valid_date(&today()));
    }

    #[test]
    fn backups_copy_the_ledger() {
        let dir = std::env::temp_dir().join(format!("zazabor-wallet-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let conn = open(&dir).unwrap();
        backup_to(&conn, &dir, "2026-10-26.db").unwrap();
        backup_to(&conn, &dir, "2026-10-26.db").unwrap();
        let list = list_backups(&dir);
        assert_eq!(list.len(), 1);
        let copy = Connection::open(backups_dir(&dir).join("2026-10-26.db")).unwrap();
        let n: i64 = copy.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert!(n > 20);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
