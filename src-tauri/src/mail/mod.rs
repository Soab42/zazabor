//! Mail: several email accounts in one place. Each account is reached over IMAP (reading) and
//! SMTP (sending), so anything from Gmail to a company's own server works. A thread per account
//! (`sync.rs`) keeps a local copy: the headers in SQLite with a full-text index (`db.rs`, in
//! `mail/mail.db` in the app's data folder) and each message as the server holds it in
//! `mail/raw/<account>/<folder>/<uid>.eml`, so mail reads and searches offline. Passwords live in
//! the desktop's keyring (`secrets.rs`).
//!
//! What the user does applies here at once and is carried to the server behind it. Every command
//! refuses while Zazabor is locked; changes go out to all windows as `mail-changed`.

mod db;
mod net;
mod parse;
mod providers;
mod secrets;
mod send;
mod sync;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

use db::{Account, Address, Folder, Server, FLAGGED, SEEN};
use sync::{Cmd, Dest};

type Result<T> = std::result::Result<T, String>;

struct Store {
    dir: PathBuf,
    conn: Mutex<Option<Connection>>,
    error: Option<String>,
}

static STORE: OnceLock<Store> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static WORKERS: Mutex<Option<HashMap<String, sync::Handle>>> = Mutex::new(None);
/// Messages with a change on its way to the server (folder → uid → how many): the sync leaves
/// them as they are here until the change has run.
static HELD: Mutex<Option<HashMap<i64, HashMap<u32, u32>>>> = Mutex::new(None);
/// Accounts in the middle of a full sync.
static BUSY: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn store() -> &'static Store {
    STORE.get().expect("mail::init runs at startup")
}

/// Seconds since the epoch.
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Set in tests: nothing outside the account's own servers is asked.
pub(crate) fn offline() -> bool {
    std::env::var_os("ZAZABOR_MAIL_NO_LOOKUP").is_some()
}

pub(crate) fn with_db<T>(f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    let store = store();
    let mut guard = store.conn.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Some(conn) => f(conn),
        None => Err(store.error.clone().unwrap_or_else(|| "Mail's database isn't open.".into())),
    }
}

fn raw_dir(account: &str, folder: i64) -> PathBuf {
    store().dir.join("raw").join(account).join(folder.to_string())
}

fn raw_path(account: &str, folder: i64, uid: u32) -> PathBuf {
    raw_dir(account, folder).join(format!("{uid}.eml"))
}

/// Tells the windows that an account's mail changed.
fn changed(account: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("mail-changed", account);
    }
}

/// A change the user made didn't reach the server.
fn failed(account: &str, why: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("mail-error", serde_json::json!({ "accountId": account, "message": why }));
    }
}

fn busy(account: &str, on: bool) {
    let mut guard = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    if on {
        set.insert(account.to_string());
    } else {
        set.remove(account);
    }
}

fn hold(folder: i64, uids: &[u32]) {
    let mut guard = HELD.lock().unwrap_or_else(|e| e.into_inner());
    let folder = guard.get_or_insert_with(HashMap::new).entry(folder).or_default();
    for uid in uids {
        *folder.entry(*uid).or_insert(0) += 1;
    }
}

fn settle(folder: i64, uids: &[u32]) {
    let mut guard = HELD.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(held) = guard.as_mut().and_then(|all| all.get_mut(&folder)) {
        for uid in uids {
            if let Some(count) = held.get_mut(uid) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    held.remove(uid);
                }
            }
        }
    }
}

fn held(folder: i64) -> HashSet<u32> {
    let guard = HELD.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().and_then(|all| all.get(&folder)).map(|held| held.keys().copied().collect()).unwrap_or_default()
}

/// New mail came in: the windows show it, and so does the desktop.
fn announce(account: &str, arrived: &[&db::Header]) {
    let Some(first) = arrived.iter().max_by_key(|h| h.date) else { return };
    let from = if first.from.name.is_empty() { first.from.addr.clone() } else { first.from.name.clone() };
    if let Some(app) = APP.get() {
        let _ = app.emit("mail-new", serde_json::json!({ "accountId": account, "count": arrived.len(), "from": from, "subject": first.subject }));
    }
    // Who wrote stays private while Zazabor is locked.
    let (title, text) = if crate::lock::is_locked() {
        ("New mail".to_string(), String::new())
    } else if arrived.len() == 1 {
        (from, first.subject.clone())
    } else {
        (format!("{} new messages", arrived.len()), format!("{from}: {}", first.subject))
    };
    let _ = std::process::Command::new("notify-send").args(["-a", "Zazabor", "-i", "mail-unread", "--", &title, &text]).spawn().map(|mut child| {
        std::thread::spawn(move || {
            let _ = child.wait();
        })
    });
}

/// Keeps a message as the server holds it, with its preview line and its words for the search.
fn store_body(account: &str, folder: i64, uid: u32, raw: &[u8]) -> Result<()> {
    let path = raw_path(account, folder, uid);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Mail can't keep the message: {e}"))?;
    }
    std::fs::write(&path, raw).map_err(|e| format!("Mail can't keep the message: {e}"))?;
    let summary = parse::summary(raw);
    with_db(|conn| db::set_body(conn, folder, uid, &summary.snippet, summary.attachments, &summary.text))
}

fn worker_send(account: &str, cmd: Cmd) {
    start_workers();
    if let Some(worker) = WORKERS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|w| w.get(account)) {
        worker.send(cmd);
    }
}

/// A thread for every account that hasn't one.
fn start_workers() {
    let Ok(accounts) = with_db(|conn| db::accounts(conn)) else { return };
    let mut guard = WORKERS.lock().unwrap_or_else(|e| e.into_inner());
    let workers = guard.get_or_insert_with(HashMap::new);
    for account in accounts {
        workers.entry(account.id.clone()).or_insert_with(|| sync::start(account.id));
    }
}

fn stop_worker(account: &str) {
    if let Some(worker) = WORKERS.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|w| w.remove(account)) {
        worker.stop();
    }
}

/// Opens the store. `dir` is the app's data folder. The accounts start syncing when a window
/// asks (`mail_start`), so nothing runs with the feature turned off.
pub fn init(app: tauri::AppHandle, dir: PathBuf) {
    let dir = dir.join("mail");
    let opened = (|| -> Result<Connection> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Mail can't make its folder: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let mut conn = Connection::open(dir.join("mail.db")).map_err(db::db_err)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;").map_err(db::db_err)?;
        db::migrate(&mut conn)?;
        Ok(conn)
    })();
    let (conn, error) = match opened {
        Ok(conn) => (Some(conn), None),
        Err(err) => {
            eprintln!("Mail: {err}");
            (None, Some(err))
        }
    };
    secrets::init(dir.clone());
    let _ = STORE.set(Store { dir, conn: Mutex::new(conn), error });
    let _ = APP.set(app);
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> impl std::future::Future<Output = Result<T>> {
    async move {
        crate::ensure_unlocked()?;
        tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
    }
}

// ---- what the page sees

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    #[serde(flatten)]
    folder: Folder,
    /// Messages of it held here (the server may have more: `total`).
    loaded: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(flatten)]
    account: Account,
    syncing: bool,
    folders: Vec<FolderView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    accounts: Vec<AccountView>,
    drafts: usize,
    colors: Vec<&'static str>,
}

#[tauri::command]
pub async fn mail_overview() -> Result<Overview> {
    blocking(|| {
        let busy: HashSet<String> = BUSY.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
        with_db(|conn| {
            let mut loaded: HashMap<i64, u32> = HashMap::new();
            {
                let mut stmt = conn.prepare("SELECT folder_id, COUNT(*) FROM messages GROUP BY folder_id").map_err(db::db_err)?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?))).map_err(db::db_err)?;
                loaded.extend(rows.flatten());
            }
            let folders = db::folders(conn, None)?;
            let accounts = db::accounts(conn)?
                .into_iter()
                .map(|account| AccountView {
                    syncing: busy.contains(&account.id),
                    folders: folders
                        .iter()
                        .filter(|f| f.account_id == account.id && !db::VIRTUAL_ROLES.contains(&f.role.as_str()))
                        .map(|f| FolderView { loaded: loaded.get(&f.id).copied().unwrap_or(0), folder: f.clone() })
                        .collect(),
                    account,
                })
                .collect();
            Ok(Overview { accounts, drafts: db::drafts(conn)?.len(), colors: db::COLORS.to_vec() })
        })
    })
    .await
}

/// Starts the accounts' syncing (once); the rail asks while the feature is on.
#[tauri::command]
pub fn mail_start() {
    start_workers();
}

/// Unread messages in every inbox, for the rail's dot.
#[tauri::command]
pub fn mail_unread() -> Result<u32> {
    crate::ensure_unlocked()?;
    with_db(|conn| db::unread_inbox(conn))
}

#[tauri::command]
pub async fn mail_sync(account: Option<String>) -> Result<()> {
    blocking(move || {
        for a in with_db(|conn| db::accounts(conn))? {
            if account.as_deref().is_none_or(|id| id == a.id) {
                worker_send(&a.id, Cmd::Sync);
            }
        }
        Ok(())
    })
    .await
}

// ---- accounts

#[tauri::command]
pub async fn mail_discover(email: String) -> Result<providers::Setup> {
    blocking(move || {
        if !email.contains('@') {
            return Err("That doesn't look like an email address.".into());
        }
        Ok(providers::discover(&email))
    })
    .await
}

/// An account as the sheet sends it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    /// Empty for a new account.
    #[serde(default)]
    id: String,
    email: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
    username: String,
    imap: Server,
    smtp: Server,
    #[serde(default)]
    signature: String,
    /// Empty keeps the saved one.
    #[serde(default)]
    password: String,
}

fn check_server(server: &mut Server, what: &str) -> Result<()> {
    server.host = server.host.trim().to_string();
    if server.host.is_empty() || server.host.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err(format!("Enter the {what} server's name."));
    }
    if server.port == 0 {
        return Err(format!("Enter the {what} server's port."));
    }
    if !["ssl", "starttls", "none"].contains(&server.security.as_str()) {
        server.security = "ssl".into();
    }
    Ok(())
}

/// Adds an account, or changes one. Signing in is tried on both servers first, so an account
/// that's saved works.
#[tauri::command]
pub async fn mail_account_save(input: AccountInput) -> Result<Account> {
    blocking(move || {
        let mut input = input;
        let existing = if input.id.is_empty() { None } else { Some(with_db(|conn| db::account(conn, &input.id))?) };
        let email = input.email.trim().to_string();
        if email.parse::<lettre::Address>().is_err() {
            return Err("That doesn't look like an email address.".into());
        }
        check_server(&mut input.imap, "incoming")?;
        check_server(&mut input.smtp, "outgoing")?;
        let all = with_db(|conn| db::accounts(conn))?;
        if all.iter().any(|a| a.email.eq_ignore_ascii_case(&email) && Some(&a.id) != existing.as_ref().map(|e| &e.id)) {
            return Err(format!("{email} is already here."));
        }
        let color = if db::COLORS.contains(&input.color.as_str()) {
            input.color.clone()
        } else {
            db::COLORS.iter().find(|c| !all.iter().any(|a| a.color == **c)).unwrap_or(&db::COLORS[all.len() % db::COLORS.len()]).to_string()
        };
        let account = Account {
            id: existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(crate::notes::new_id),
            email: email.clone(),
            name: input.name.trim().to_string(),
            color,
            username: if input.username.trim().is_empty() { email.clone() } else { input.username.trim().to_string() },
            imap: input.imap,
            smtp: input.smtp,
            signature: input.signature,
            synced: 0,
            error: None,
        };
        let reconnect = match &existing {
            Some(old) => !input.password.is_empty() || old.imap != account.imap || old.smtp != account.smtp || old.username != account.username,
            None => true,
        };
        if reconnect {
            let password = if input.password.is_empty() { secrets::get(&account.id).ok_or("Enter the password.")? } else { input.password.clone() };
            let mut link = net::connect(&account.imap, &account.username, &password)?;
            let _ = link.session.logout();
            send::check(&account, &password).map_err(|e| format!("Reading mail works, but sending doesn't: {e}"))?;
            stop_worker(&account.id);
            secrets::set(&account.id, &account.email, &password)?;
        }
        with_db(|conn| {
            db::save_account(conn, &account, now())?;
            db::set_account_state(conn, &account.id, None, None)
        })?;
        start_workers();
        changed(&account.id);
        with_db(|conn| db::account(conn, &account.id))
    })
    .await
}

#[tauri::command]
pub async fn mail_account_remove(id: String) -> Result<()> {
    blocking(move || {
        stop_worker(&id);
        with_db(|conn| db::remove_account(conn, &id))?;
        secrets::clear(&id);
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
            let _ = std::fs::remove_dir_all(store().dir.join("raw").join(&id));
        }
        changed(&id);
        Ok(())
    })
    .await
}

// ---- reading

#[tauri::command]
pub async fn mail_threads(query: db::Query) -> Result<Vec<db::Thread>> {
    blocking(move || with_db(|conn| db::threads(conn, &query))).await
}

#[tauri::command]
pub async fn mail_thread(account: String, thread: String, folder: Option<i64>) -> Result<Vec<db::Message>> {
    blocking(move || with_db(|conn| db::thread(conn, &account, &thread, folder))).await
}

/// The message as the server holds it, fetched now when it isn't here yet.
fn raw_of(message: &db::Message) -> Result<Vec<u8>> {
    let path = raw_path(&message.account_id, message.folder_id, message.uid);
    if let Ok(raw) = std::fs::read(&path) {
        return Ok(raw);
    }
    let (reply, answer) = std::sync::mpsc::channel();
    worker_send(&message.account_id, Cmd::Body { folder: message.folder_id, uid: message.uid, reply });
    answer.recv_timeout(Duration::from_secs(180)).map_err(|_| "The server is taking too long. Try again in a moment.".to_string())??;
    std::fs::read(&path).map_err(|e| format!("The message couldn't be read: {e}"))
}

/// A message to show. `images` also fetches the pictures it links from the web.
#[tauri::command]
pub async fn mail_body(id: i64, images: bool) -> Result<parse::Body> {
    blocking(move || {
        let message = with_db(|conn| db::message(conn, id))?;
        Ok(parse::body(&raw_of(&message)?, images))
    })
    .await
}

/// Writes one of a message's files to `path`, or (without one) to a folder of its own in the
/// cache, to be opened; returns where it is.
#[tauri::command]
pub async fn mail_attachment(app: tauri::AppHandle, id: i64, index: usize, path: Option<String>) -> Result<String> {
    use tauri::Manager;
    blocking(move || {
        let message = with_db(|conn| db::message(conn, id))?;
        let (name, _, bytes) = parse::attachment(&raw_of(&message)?, index).ok_or("That attachment isn't in the message.")?;
        let target = match path {
            Some(path) => PathBuf::from(path),
            None => {
                let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("mail-open").join(format!("{id}-{index}"));
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                dir.join(name)
            }
        };
        std::fs::write(&target, bytes).map_err(|e| format!("Couldn't save {}: {e}", target.display()))?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn mail_contacts(prefix: String) -> Result<Vec<Address>> {
    blocking(move || with_db(|conn| db::contacts(conn, prefix.trim(), 8))).await
}

#[tauri::command]
pub async fn mail_older(folder: i64) -> Result<()> {
    blocking(move || {
        let folder = with_db(|conn| db::folder(conn, folder))?;
        worker_send(&folder.account_id, Cmd::Older(folder.id));
        Ok(())
    })
    .await
}

// ---- acting on messages

/// The messages by folder: (account, folder) → their uids.
fn by_folder(messages: &[db::Message]) -> HashMap<(String, i64), Vec<&db::Message>> {
    let mut groups: HashMap<(String, i64), Vec<&db::Message>> = HashMap::new();
    for m in messages {
        groups.entry((m.account_id.clone(), m.folder_id)).or_default().push(m);
    }
    groups
}

/// Marks messages read or unread ("seen"), starred or not ("flagged").
#[tauri::command]
pub async fn mail_flag(ids: Vec<i64>, flag: String, on: bool) -> Result<()> {
    blocking(move || {
        let bit = match flag.as_str() {
            "seen" => SEEN,
            "flagged" => FLAGGED,
            _ => return Err("No such flag.".into()),
        };
        let messages = with_db(|conn| db::messages_by_ids(conn, &ids))?;
        let mut accounts = HashSet::new();
        for ((account, folder), group) in by_folder(&messages) {
            let change: Vec<&&db::Message> = group.iter().filter(|m| (if bit == SEEN { m.seen } else { m.flagged }) != on).collect();
            if change.is_empty() {
                continue;
            }
            let uids: Vec<u32> = change.iter().map(|m| m.uid).collect();
            hold(folder, &uids);
            with_db(|conn| {
                for m in &change {
                    let flags = (if m.seen { SEEN } else { 0 }) | (if m.flagged { FLAGGED } else { 0 }) | (if m.answered { db::ANSWERED } else { 0 });
                    db::set_flags(conn, folder, m.uid, if on { flags | bit } else { flags & !bit })?;
                }
                if bit == SEEN {
                    db::recount_unread(conn, folder, if on { -(change.len() as i64) } else { change.len() as i64 })?;
                }
                Ok(())
            })?;
            worker_send(&account, Cmd::Flag { folder, uids, flag: bit, on });
            accounts.insert(account);
        }
        accounts.iter().for_each(|a| changed(a));
        Ok(())
    })
    .await
}

/// How to put moved messages back.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Undo {
    account: String,
    /// Where they are now.
    from: i64,
    /// Where they were.
    to: i64,
    message_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    count: usize,
    /// True when they were removed for good (from Trash or Junk).
    deleted: bool,
    undo: Vec<Undo>,
}

/// Moves messages: `to` is "archive", "trash", "junk", "inbox", or a folder's id. From Trash and
/// Junk, "trash" removes them for good.
#[tauri::command]
pub async fn mail_move(ids: Vec<i64>, to: String) -> Result<Moved> {
    blocking(move || {
        let messages = with_db(|conn| db::messages_by_ids(conn, &ids))?;
        let mut moved = Moved { count: 0, deleted: false, undo: Vec::new() };
        let mut accounts = HashSet::new();
        for ((account, folder), group) in by_folder(&messages) {
            let source = with_db(|conn| db::folder(conn, folder))?;
            // Where they go: a folder here, a kind of folder the account has yet to get (made on
            // the way), or nowhere (out of Trash and Junk, "trash" removes for good).
            let role_folder = |role: &str| with_db(|conn| db::folder_by_role(conn, &account, role));
            let target: Option<std::result::Result<Folder, &'static str>> = match to.as_str() {
                "archive" => Some(match role_folder("archive")? {
                    Some(f) => Ok(f),
                    None => role_folder("all")?.ok_or("archive"),
                }),
                "trash" if matches!(source.role.as_str(), "trash" | "junk") => None,
                "trash" => Some(role_folder("trash")?.ok_or("trash")),
                "junk" => Some(role_folder("junk")?.ok_or("junk")),
                "inbox" => Some(Ok(role_folder("inbox")?.ok_or("This account has no inbox.")?)),
                id => Some(Ok(with_db(|conn| db::folder(conn, id.parse().map_err(|_| "No such folder.".to_string())?))?)),
            };
            if let Some(Ok(t)) = &target {
                if t.id == folder || t.account_id != account {
                    continue;
                }
            }
            let uids: Vec<u32> = group.iter().map(|m| m.uid).collect();
            let unread = group.iter().filter(|m| !m.seen).count() as i64;
            hold(folder, &uids);
            with_db(|conn| {
                db::delete_uids(conn, folder, &uids)?;
                db::recount_unread(conn, folder, -unread)
            })?;
            for uid in &uids {
                let _ = std::fs::remove_file(raw_path(&account, folder, *uid));
            }
            moved.count += uids.len();
            match target {
                Some(Ok(target)) => {
                    let message_ids: Vec<String> = group.iter().map(|m| m.message_id.clone()).filter(|id| !id.is_empty()).collect();
                    if message_ids.len() == group.len() {
                        moved.undo.push(Undo { account: account.clone(), from: target.id, to: folder, message_ids });
                    }
                    worker_send(&account, Cmd::Move { folder, uids, to: Dest::Folder(target.id) });
                }
                Some(Err(role)) => worker_send(&account, Cmd::Move { folder, uids, to: Dest::Role(role) }),
                None => {
                    moved.deleted = true;
                    worker_send(&account, Cmd::Delete { folder, uids });
                }
            }
            accounts.insert(account);
        }
        accounts.iter().for_each(|a| changed(a));
        Ok(moved)
    })
    .await
}

#[tauri::command]
pub async fn mail_move_undo(undo: Vec<Undo>) -> Result<()> {
    blocking(move || {
        for u in undo {
            worker_send(&u.account, Cmd::MoveBack { from: u.from, to: u.to, message_ids: u.message_ids });
        }
        Ok(())
    })
    .await
}

/// Marks everything held here of a folder as read.
#[tauri::command]
pub async fn mail_read_all(folder: i64) -> Result<()> {
    blocking(move || {
        let folder = with_db(|conn| db::folder(conn, folder))?;
        let uids: Vec<u32> = with_db(|conn| db::folder_uids(conn, folder.id))?.into_iter().filter(|(_, flags)| flags & SEEN == 0).map(|(uid, _)| uid).collect();
        if uids.is_empty() {
            return Ok(());
        }
        hold(folder.id, &uids);
        with_db(|conn| {
            conn.execute("UPDATE messages SET flags = flags | 1 WHERE folder_id = ?1", [folder.id]).map_err(db::db_err)?;
            db::recount_unread(conn, folder.id, -(uids.len() as i64))
        })?;
        worker_send(&folder.account_id, Cmd::Flag { folder: folder.id, uids, flag: SEEN, on: true });
        changed(&folder.account_id);
        Ok(())
    })
    .await
}

// ---- writing

#[tauri::command]
pub async fn mail_send(out: send::Outgoing) -> Result<()> {
    blocking(move || {
        let account = with_db(|conn| db::account(conn, &out.account_id))?;
        let password = secrets::get(&account.id).ok_or("This account's password isn't saved any more. Enter it again in the account's settings.")?;
        let original = match out.reply_to {
            Some(id) => with_db(|conn| db::message(conn, id)).ok(),
            None => None,
        };
        let mut files: Vec<send::Loaded> = Vec::new();
        for attach in &out.attachments {
            files.push(match attach {
                send::Attach::File { path } => {
                    let path = PathBuf::from(path);
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
                    let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read {name}: {e}"))?;
                    (name, mime_guess::from_path(&path).first_or_octet_stream().to_string(), bytes)
                }
                send::Attach::Part { message, index } => {
                    let message = with_db(|conn| db::message(conn, *message))?;
                    parse::attachment(&raw_of(&message)?, *index).ok_or("An attachment of the forwarded message isn't there any more.")?
                }
            });
        }
        let message = send::build(&account, &out, files, original.as_ref())?;
        let raw = send::send(&account, &password, &message)?;

        let at = now();
        with_db(|conn| {
            for a in out.to.iter().chain(out.cc.iter()).chain(out.bcc.iter()) {
                db::touch_contact(conn, a, at, 1)?;
            }
            if let Some(draft) = &out.draft_id {
                db::delete_draft(conn, draft)?;
            }
            Ok(())
        })?;
        if let Some(original) = original.filter(|m| !m.answered) {
            let flags = (if original.seen { SEEN } else { 0 }) | (if original.flagged { FLAGGED } else { 0 }) | db::ANSWERED;
            hold(original.folder_id, &[original.uid]);
            with_db(|conn| db::set_flags(conn, original.folder_id, original.uid, flags))?;
            worker_send(&account.id, Cmd::Flag { folder: original.folder_id, uids: vec![original.uid], flag: db::ANSWERED, on: true });
        }
        if send::files_sent_itself(&account) {
            if let Some(sent) = with_db(|conn| db::folder_by_role(conn, &account.id, "sent"))? {
                worker_send(&account.id, Cmd::Folder(sent.id));
            }
        } else {
            worker_send(&account.id, Cmd::Append { role: "sent", raw });
        }
        changed(&account.id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn mail_drafts() -> Result<Vec<db::Draft>> {
    blocking(|| with_db(|conn| db::drafts(conn))).await
}

#[tauri::command]
pub async fn mail_draft_save(id: String, account: String, json: String) -> Result<()> {
    blocking(move || {
        if json.len() > 4 << 20 {
            return Err("The draft is too long to keep.".into());
        }
        with_db(|conn| db::save_draft(conn, &id, &account, &json, now()))?;
        changed("");
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn mail_draft_delete(id: String) -> Result<()> {
    blocking(move || {
        with_db(|conn| db::delete_draft(conn, &id))?;
        changed("");
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_for<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
        let until = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(found) = check() {
                return found;
            }
            assert!(std::time::Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// The whole round against a real server (a GreenMail container, sign-in turned off):
    /// `ZAZABOR_MAIL_TEST=127.0.0.1:3143:3025 ZAZABOR_MAIL_NO_KEYRING=1 cargo test --lib mail::tests::live -- --ignored`
    #[test]
    #[ignore]
    fn live() {
        let Ok(target) = std::env::var("ZAZABOR_MAIL_TEST") else { return };
        let mut parts = target.split(':');
        let host = parts.next().unwrap().to_string();
        let (imap_port, smtp_port): (u16, u16) = (parts.next().unwrap().parse().unwrap(), parts.next().unwrap().parse().unwrap());
        let dir = std::env::temp_dir().join(format!("zazabor-mail-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut conn = Connection::open(dir.join("mail.db")).unwrap();
        db::migrate(&mut conn).unwrap();
        secrets::init(dir.clone());
        let _ = STORE.set(Store { dir: dir.clone(), conn: Mutex::new(Some(conn)), error: None });

        let stamp = now();
        let account = |who: &str| Account {
            id: format!("{who}{stamp}"),
            email: format!("{who}{stamp}@test.local"),
            name: who.to_string(),
            color: "blue".into(),
            username: format!("{who}{stamp}@test.local"),
            imap: Server { host: host.clone(), port: imap_port, security: "none".into() },
            smtp: Server { host: host.clone(), port: smtp_port, security: "none".into() },
            signature: String::new(),
            synced: 0,
            error: None,
        };
        let (ann, bob) = (account("ann"), account("bob"));
        for a in [&ann, &bob] {
            with_db(|conn| db::save_account(conn, a, stamp)).unwrap();
            secrets::set(&a.id, &a.email, "secret").unwrap();
        }
        send::check(&bob, "secret").unwrap();

        // Bob writes to Ann, with a file.
        let out = send::Outgoing {
            account_id: bob.id.clone(),
            to: vec![Address { name: "Ann".into(), addr: ann.email.clone() }],
            cc: vec![],
            bcc: vec![],
            subject: "Lunch on Friday?".into(),
            html: "<p>Shall we try the <b>new place</b>?</p>".into(),
            text: "Shall we try the new place?".into(),
            attachments: vec![],
            reply_to: None,
            draft_id: None,
        };
        let message = send::build(&bob, &out, vec![("menu.txt".into(), "text/plain".into(), b"soup of the day".to_vec())], None).unwrap();
        send::send(&bob, "secret", &message).unwrap();

        // Ann's account syncs: the folders appear, then the message with its text.
        start_workers();
        let inbox = wait_for("Ann's inbox", || with_db(|conn| db::folder_by_role(conn, &ann.id, "inbox")).unwrap().filter(|f| f.synced > 0));
        let query = || db::Query { folder: Some(inbox.id), ..db::Query::default() };
        let thread = wait_for("the message's text", || with_db(|conn| db::threads(conn, &query())).unwrap().into_iter().find(|t| !t.snippet.is_empty()));
        assert_eq!((thread.subject.as_str(), thread.unread, thread.attachments), ("Lunch on Friday?", 1, true));
        assert_eq!(thread.from.addr, bob.email);
        assert!(thread.snippet.contains("new place"), "{}", thread.snippet);
        let first = with_db(|conn| db::message(conn, thread.id)).unwrap();
        let body = parse::body(&raw_of(&first).unwrap(), false);
        assert!(body.html.unwrap().contains("<b>new place</b>"));
        assert_eq!(body.attachments[0].name, "menu.txt");
        assert_eq!(with_db(|conn| db::threads(conn, &db::Query { search: "friday".into(), ..db::Query::default() })).unwrap().len(), 1);
        assert_eq!(with_db(|conn| db::folder(conn, inbox.id)).unwrap().unread, 1);

        // New mail while running shows by IDLE, without waiting for the next pass.
        let second = send::build(&bob, &send::Outgoing { subject: "PS".into(), ..out.clone() }, vec![], None).unwrap();
        send::send(&bob, "secret", &second).unwrap();
        wait_for("the second message", || (with_db(|conn| db::threads(conn, &query())).unwrap().len() == 2).then_some(()));

        // Reading it reaches the server: a sync afterwards still has it read.
        let read_on_server = |uid: u32| {
            let mut link = net::connect(&ann.imap, &ann.username, "secret").unwrap();
            link.session.select("INBOX").unwrap();
            let seen = link.session.uid_search("SEEN").unwrap().contains(&uid);
            let _ = link.session.logout();
            seen
        };
        tauri::async_runtime::block_on(mail_flag(vec![first.id], "seen".into(), true)).unwrap();
        assert!(with_db(|conn| db::message(conn, first.id)).unwrap().seen, "read here at once");
        wait_for("the server to have it read", || read_on_server(first.uid).then_some(()));
        assert_eq!(with_db(|conn| db::folder(conn, inbox.id)).unwrap().unread, 1);

        // Moving it to Trash and back.
        let trash = match with_db(|conn| db::folder_by_role(conn, &ann.id, "trash")).unwrap() {
            Some(trash) => trash,
            None => {
                let mut link = net::connect(&ann.imap, &ann.username, "secret").unwrap();
                link.session.create("Trash").unwrap();
                let _ = link.session.logout();
                worker_send(&ann.id, Cmd::Sync);
                wait_for("the Trash folder", || with_db(|conn| db::folder_by_role(conn, &ann.id, "trash")).unwrap())
            }
        };
        let moved = tauri::async_runtime::block_on(mail_move(vec![first.id], "trash".into())).unwrap();
        assert_eq!((moved.count, moved.deleted, moved.undo.len()), (1, false, 1));
        assert_eq!(with_db(|conn| db::threads(conn, &query())).unwrap().len(), 1, "gone from the inbox at once");
        let in_trash = || with_db(|conn| db::threads(conn, &db::Query { folder: Some(trash.id), ..db::Query::default() })).unwrap();
        let trashed = wait_for("it to show in Trash", || in_trash().into_iter().next());
        assert!(with_db(|conn| db::message(conn, trashed.id)).unwrap().seen, "still read after the move");
        tauri::async_runtime::block_on(mail_move_undo(moved.undo)).unwrap();
        wait_for("the undo", || (with_db(|conn| db::threads(conn, &query())).unwrap().len() == 2 && in_trash().is_empty()).then_some(()));

        // A reply joins the conversation and is filed in Sent.
        let back = with_db(|conn| db::threads(conn, &query())).unwrap().into_iter().find(|t| t.subject == "Lunch on Friday?").unwrap();
        let reply = send::Outgoing {
            account_id: ann.id.clone(),
            to: vec![Address { name: "Bob".into(), addr: bob.email.clone() }],
            subject: "Re: Lunch on Friday?".into(),
            html: "<p>Yes!</p>".into(),
            text: "Yes!".into(),
            attachments: vec![send::Attach::Part { message: back.id, index: 0 }],
            reply_to: Some(back.id),
            ..out.clone()
        };
        tauri::async_runtime::block_on(mail_send(reply)).unwrap();
        let conversation = wait_for("the reply in Sent", || {
            let all = with_db(|conn| db::thread(conn, &ann.id, &back.thread_id, None)).unwrap();
            (all.len() == 2).then_some(all)
        });
        assert_eq!(conversation[1].folder_role, "sent");
        assert!(conversation[0].answered);
        assert!(conversation[1].attachments || !conversation[1].body, "the forwarded file went along");

        // Deleting from Trash removes for good.
        let again = tauri::async_runtime::block_on(mail_move(vec![back.id], "trash".into())).unwrap();
        assert_eq!(again.count, 1);
        let gone = wait_for("it in Trash again", || in_trash().into_iter().next());
        let forever = tauri::async_runtime::block_on(mail_move(vec![gone.id], "trash".into())).unwrap();
        assert!(forever.deleted);
        worker_send(&ann.id, Cmd::Sync);
        std::thread::sleep(Duration::from_secs(3));
        assert!(in_trash().is_empty(), "and stays gone after a sync");

        for a in [&ann, &bob] {
            stop_worker(&a.id);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
