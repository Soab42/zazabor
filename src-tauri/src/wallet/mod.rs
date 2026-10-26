//! Wallet: one person's money (docs/plans/money.md). Accounts and wallets (cash, banks, bKash and
//! other mobile wallets, cards), spending and income in categories, transfers with their fees,
//! monthly budgets and reports. The ledger is a SQLite database, `wallet/wallet.db` in the app's
//! data folder (`db.rs`), with a copy kept each day in `wallet/backups/` (the last 14).
//!
//! Every command refuses while CorePro is locked; changes go out to all windows as `wallet-changed`.

mod bills;
mod dates;
mod db;
mod earnings;
mod export;
mod import;
mod money;
mod quick;
mod receipts;

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
    Ok(conn)
}

/// Runs `f` on a thread of its own (imports and exports read and write files).
fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> impl std::future::Future<Output = Result<T>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// Posts the bills that post by themselves and are due, then tells the windows.
fn post_due_bills() -> Result<usize> {
    let posted = {
        let mut store = store();
        let Some(conn) = store.conn.as_mut() else { return Ok(0) };
        bills::post_due(conn, &today(), now())?
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
    // Each hour (and at start): the day's backup, then the bills that came due, catching up on
    // the days CorePro wasn't running. Neither runs while CorePro is locked.
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
    let n = change(|conn| db::delete_txs(conn, &ids))?;
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
    // Catches up first (the hourly check skips while CorePro is locked).
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
pub async fn wallet_import_commit(path: String, sheet: Option<u32>, account_id: String, mapping: import::Mapping, edits: Vec<import::RowEdit>) -> Result<import::Batch> {
    blocking(move || change(|conn| import::commit(conn, Path::new(&path), sheet, &account_id, &mapping, &edits, now()))).await
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
        let dir = std::env::temp_dir().join(format!("corepro-wallet-test-{}", std::process::id()));
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
