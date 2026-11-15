//! One thread per account keeps the local store like the server: it lists the folders, brings
//! in new messages' headers (newest first), follows flags and deletions, and then fetches the
//! messages themselves so they read and search offline. What the user does (read, star, move,
//! delete) is already applied here by the command; the thread carries it to the server, between
//! the sync's steps so it never waits behind a long one. A second connection sits in IDLE on the
//! inbox, so new mail shows as it arrives.

use std::collections::{HashMap, HashSet};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::db::{self, Folder, Header, Listed, ANSWERED, DRAFT, FLAGGED, SEEN, VIRTUAL_ROLES};
use super::net::{self, err, uid_set, Link};
use super::{parse, with_db};

/// Headers fetched when a folder is first seen, and again per "load older".
const WINDOW: u32 = 400;
/// Messages larger than this are fetched when opened, not ahead of time.
const PREFETCH_MAX: u32 = 3 << 20;
/// Messages per folder whose text is fetched ahead in one pass.
const PREFETCH_COUNT: usize = 400;
/// A full pass this often; the inbox also syncs whenever IDLE says it changed.
const POLL: Duration = Duration::from_secs(5 * 60);
const RETRY: Duration = Duration::from_secs(60);

/// Where a move goes: a folder, or the account's folder of a kind ("archive", "trash"), made
/// when the account hasn't one.
pub enum Dest {
    Folder(i64),
    Role(&'static str),
}

pub enum Cmd {
    /// Every folder.
    Sync,
    Folder(i64),
    /// Brings in the folder's next older messages.
    Older(i64),
    Flag { folder: i64, uids: Vec<u32>, flag: u32, on: bool },
    Move { folder: i64, uids: Vec<u32>, to: Dest },
    /// Removes them for good.
    Delete { folder: i64, uids: Vec<u32> },
    /// Undo of a move: the messages (by Message-ID) go from `from` back to `to`.
    MoveBack { from: i64, to: i64, message_ids: Vec<String> },
    /// Fetches one message now; answers when it's stored.
    Body { folder: i64, uid: u32, reply: Sender<Result<(), String>> },
    /// Files a sent message in the folder with this role.
    Append { role: &'static str, raw: Vec<u8> },
    Stop,
}

/// The way to an account's thread.
pub struct Handle {
    tx: Sender<Cmd>,
    stop: Arc<AtomicBool>,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
}

impl Handle {
    pub fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }

    /// Ends the thread and its IDLE companion, cutting their connections.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        for socket in self.sockets.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
            let _ = socket.shutdown(Shutdown::Both);
        }
        let _ = self.tx.send(Cmd::Stop);
    }
}

pub fn start(account: String) -> Handle {
    let (tx, rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let sockets = Arc::new(Mutex::new(Vec::new()));
    let worker = Worker {
        account,
        rx,
        tx: tx.clone(),
        stop: stop.clone(),
        sockets: sockets.clone(),
        link: None,
        selected: None,
        want_sync: false,
        want_folders: Vec::new(),
        idling: false,
    };
    std::thread::Builder::new().name("mail-sync".into()).spawn(move || worker.run()).expect("a thread for mail");
    let _ = tx.send(Cmd::Sync);
    Handle { tx, stop, sockets }
}

struct Worker {
    account: String,
    rx: Receiver<Cmd>,
    tx: Sender<Cmd>,
    stop: Arc<AtomicBool>,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
    link: Option<Link>,
    /// The folder the session has selected.
    selected: Option<i64>,
    /// Syncs asked for while another ran.
    want_sync: bool,
    want_folders: Vec<i64>,
    idling: bool,
}

fn bits(flags: &[imap::types::Flag<'_>]) -> u32 {
    use imap::types::Flag;
    flags.iter().fold(0, |bits, flag| {
        bits | match flag {
            Flag::Seen => SEEN,
            Flag::Flagged => FLAGGED,
            Flag::Answered => ANSWERED,
            Flag::Draft => DRAFT,
            _ => 0,
        }
    })
}

fn flag_name(flag: u32) -> &'static str {
    match flag {
        SEEN => "\\Seen",
        FLAGGED => "\\Flagged",
        ANSWERED => "\\Answered",
        _ => "\\Draft",
    }
}

/// What a folder is for, by what the server says of it, else by its name.
fn role_of(name: &imap::types::Name<'_>) -> &'static str {
    use imap_proto::NameAttribute as A;
    if name.name().eq_ignore_ascii_case("INBOX") {
        return "inbox";
    }
    for attribute in name.attributes() {
        match attribute {
            A::Sent => return "sent",
            A::Drafts => return "drafts",
            A::Trash => return "trash",
            A::Junk => return "junk",
            A::Archive => return "archive",
            A::All => return "all",
            A::Flagged => return "flagged",
            A::Extension(other) if other.eq_ignore_ascii_case("\\Important") => return "important",
            _ => {}
        }
    }
    let leaf = name.delimiter().and_then(|d| name.name().rsplit(d).next()).unwrap_or(name.name()).to_lowercase();
    match leaf.as_str() {
        "sent" | "sent items" | "sent mail" | "sent messages" => "sent",
        "drafts" | "draft" => "drafts",
        "trash" | "deleted items" | "deleted messages" | "bin" => "trash",
        "junk" | "spam" | "junk e-mail" | "junk email" | "bulk mail" => "junk",
        "archive" | "archives" => "archive",
        _ => "",
    }
}

/// The order folders sync in: what's looked at most comes first.
fn priority(role: &str) -> u8 {
    match role {
        "inbox" => 0,
        "sent" => 1,
        "drafts" => 2,
        "archive" => 3,
        "" => 4,
        "trash" => 5,
        _ => 6,
    }
}

impl Cmd {
    /// The messages a command acts on, held back from the sync until it has run.
    fn held(&self) -> Option<(i64, &[u32])> {
        match self {
            Cmd::Flag { folder, uids, .. } | Cmd::Move { folder, uids, .. } | Cmd::Delete { folder, uids } => Some((*folder, uids)),
            _ => None,
        }
    }
}

impl Worker {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn run(mut self) {
        let mut next_full = Instant::now() + POLL;
        loop {
            if self.stopped() {
                break;
            }
            let cmd = match self.rx.recv_timeout(next_full.saturating_duration_since(Instant::now())) {
                Ok(cmd) => cmd,
                Err(RecvTimeoutError::Timeout) => Cmd::Sync,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            if matches!(cmd, Cmd::Stop) {
                break;
            }
            let mut full = matches!(cmd, Cmd::Sync);
            let mut ok = self.handle(cmd);
            // What was asked for meanwhile.
            while !self.stopped() && ok && (self.want_sync || !self.want_folders.is_empty()) {
                let next = if std::mem::take(&mut self.want_sync) {
                    self.want_folders.clear();
                    full = true;
                    Cmd::Sync
                } else {
                    Cmd::Folder(self.want_folders.remove(0))
                };
                ok = self.handle(next);
            }
            if full {
                next_full = Instant::now() + if ok { POLL } else { RETRY };
            }
        }
        if let Some(mut link) = self.link.take() {
            let _ = link.session.logout();
        }
    }

    /// Runs a command, once more on a fresh connection when the old one had gone stale. Says
    /// whether it worked.
    fn handle(&mut self, cmd: Cmd) -> bool {
        let full = matches!(cmd, Cmd::Sync);
        if full {
            super::busy(&self.account, true);
            super::changed(&self.account);
        }
        let mut result = self.attempt(&cmd);
        if result.is_err() && !self.stopped() && !self.alive() {
            self.link = None;
            self.selected = None;
            result = self.attempt(&cmd);
        }
        if let Some((folder, uids)) = cmd.held() {
            super::settle(folder, uids);
        }
        if full {
            super::busy(&self.account, false);
        }
        match (&cmd, result) {
            (Cmd::Body { reply, .. }, result) => {
                let ok = result.is_ok();
                let _ = reply.send(result);
                ok
            }
            (_, Ok(())) => true,
            (Cmd::Sync | Cmd::Folder(_) | Cmd::Older(_), Err(why)) => {
                if !self.stopped() {
                    let _ = with_db(|conn| db::set_account_state(conn, &self.account, None, Some(&why)));
                    super::changed(&self.account);
                }
                false
            }
            (_, Err(why)) => {
                // The change didn't reach the server: say so, and show what the server has.
                if !self.stopped() {
                    super::failed(&self.account, &why);
                    self.want_sync = true;
                }
                true
            }
        }
    }

    /// Whether the connection still answers.
    fn alive(&mut self) -> bool {
        self.link.as_mut().is_some_and(|link| link.session.noop().is_ok())
    }

    fn link(&mut self) -> Result<&mut Link, String> {
        if self.link.is_none() {
            let account = with_db(|conn| db::account(conn, &self.account))?;
            let link = net::connect(&account.imap, &account.username, &super::cred(&account)?)?;
            if let Ok(socket) = link.tcp.try_clone() {
                self.sockets.lock().unwrap_or_else(|e| e.into_inner()).push(socket);
            }
            self.selected = None;
            self.link = Some(link);
        }
        Ok(self.link.as_mut().expect("just connected"))
    }

    fn select(&mut self, folder: &Folder, again: bool) -> Result<Option<imap::types::Mailbox>, String> {
        if self.selected == Some(folder.id) && !again {
            return Ok(None);
        }
        self.selected = None;
        let mailbox = self.link()?.session.select(&folder.path).map_err(err)?;
        self.selected = Some(folder.id);
        Ok(Some(mailbox))
    }

    fn folder(&self, id: i64) -> Result<Folder, String> {
        with_db(|conn| db::folder(conn, id))
    }

    fn attempt(&mut self, cmd: &Cmd) -> Result<(), String> {
        match cmd {
            Cmd::Sync => self.sync_all(),
            Cmd::Folder(id) => self.sync_folder(*id),
            Cmd::Older(id) => self.older(*id),
            Cmd::Flag { folder, uids, flag, on } => {
                let folder = self.folder(*folder)?;
                self.select(&folder, false)?;
                let change = format!("{}FLAGS.SILENT ({})", if *on { '+' } else { '-' }, flag_name(*flag));
                for chunk in uids.chunks(200) {
                    self.link()?.session.uid_store(uid_set(chunk), &change).map_err(err)?;
                }
                Ok(())
            }
            Cmd::Move { folder, uids, to } => {
                let from = self.folder(*folder)?;
                let to = match to {
                    Dest::Folder(id) => self.folder(*id)?,
                    Dest::Role(role) => self.folder_for(role)?,
                };
                self.move_uids(&from, uids, &to)?;
                self.want_folders.push(to.id);
                Ok(())
            }
            Cmd::Delete { folder, uids } => {
                let folder = self.folder(*folder)?;
                self.select(&folder, false)?;
                self.expunge(uids)
            }
            Cmd::MoveBack { from, to, message_ids } => {
                // The server knows where the messages are now (their numbers changed with the move,
                // and Gmail's All Mail isn't kept here at all): ask it for them by Message-ID.
                let (from, to) = (self.folder(*from)?, self.folder(*to)?);
                self.select(&from, true)?;
                let mut uids: Vec<u32> = Vec::new();
                for id in message_ids.iter().filter(|id| !id.is_empty() && !id.contains(['"', '\\', '\r', '\n'])) {
                    uids.extend(self.link()?.session.uid_search(format!("HEADER Message-ID \"<{id}>\"")).map_err(err)?);
                }
                if !uids.is_empty() {
                    self.move_uids(&from, &uids, &to)?;
                    with_db(|conn| db::delete_uids(conn, from.id, &uids))?;
                    self.sync_folder(to.id)?;
                    self.sync_folder(from.id)?;
                }
                Ok(())
            }
            Cmd::Body { folder, uid, .. } => {
                let folder = self.folder(*folder)?;
                self.select(&folder, false)?;
                let fetched = self.link()?.session.uid_fetch(uid.to_string(), "(UID BODY.PEEK[])").map_err(err)?;
                let raw = fetched.iter().find(|f| f.uid == Some(*uid)).and_then(|f| f.body()).ok_or("The server doesn't have that message any more.")?;
                super::store_body(&self.account, folder.id, *uid, raw)
            }
            Cmd::Append { role, raw } => {
                let folder = self.folder_for(role)?;
                self.link()?.session.append(&folder.path, raw).flag(imap::types::Flag::Seen).finish().map_err(err)?;
                self.want_folders.push(folder.id);
                Ok(())
            }
            Cmd::Stop => Ok(()),
        }
    }

    fn move_uids(&mut self, from: &Folder, uids: &[u32], to: &Folder) -> Result<(), String> {
        self.select(from, false)?;
        let can_move = self.link()?.can_move;
        for chunk in uids.chunks(200) {
            let set = uid_set(chunk);
            if can_move {
                self.link()?.session.uid_mv(&set, &to.path).map_err(err)?;
            } else {
                self.link()?.session.uid_copy(&set, &to.path).map_err(err)?;
                self.expunge(chunk)?;
            }
        }
        Ok(())
    }

    /// Removes messages of the selected folder for good.
    fn expunge(&mut self, uids: &[u32]) -> Result<(), String> {
        let uidplus = self.link()?.uidplus;
        for chunk in uids.chunks(200) {
            let set = uid_set(chunk);
            let session = &mut self.link()?.session;
            session.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").map_err(err)?;
            if uidplus {
                session.uid_expunge(&set).map_err(err)?;
            } else {
                session.expunge().map_err(err)?;
            }
        }
        Ok(())
    }

    /// Runs what the user did meanwhile; syncs asked for wait until the running one is done.
    fn drain(&mut self) {
        while let Ok(cmd) = self.rx.try_recv() {
            match cmd {
                Cmd::Sync => self.want_sync = true,
                Cmd::Folder(id) => {
                    if !self.want_folders.contains(&id) {
                        self.want_folders.push(id);
                    }
                }
                Cmd::Stop => self.stop.store(true, Ordering::SeqCst),
                other => {
                    self.handle(other);
                }
            }
        }
    }

    /// The account's folder of a kind, made on the server when it hasn't one.
    fn folder_for(&mut self, role: &str) -> Result<Folder, String> {
        if let Some(folder) = with_db(|conn| db::folder_by_role(conn, &self.account, role))? {
            return Ok(folder);
        }
        let name = match role {
            "sent" => "Sent",
            "trash" => "Trash",
            "junk" => "Junk",
            "drafts" => "Drafts",
            _ => "Archive",
        };
        // Some servers keep every folder inside the inbox ("INBOX.Sent").
        let folders = with_db(|conn| db::folders(conn, Some(&self.account)))?;
        let inside = folders.iter().find(|f| f.role != "inbox" && f.path.to_ascii_uppercase().starts_with(&format!("INBOX{}", f.delim))).map(|f| format!("INBOX{}", f.delim));
        let path = format!("{}{name}", inside.unwrap_or_default());
        self.link()?.session.create(&path).map_err(err)?;
        let _ = self.link()?.session.subscribe(&path);
        self.list_folders()?;
        with_db(|conn| db::folder_by_role(conn, &self.account, role))?.ok_or_else(|| format!("The server didn't make a {name} folder."))
    }

    /// Makes the folders here match the server's.
    fn list_folders(&mut self) -> Result<(), String> {
        let names = self.link()?.session.list(Some(""), Some("*")).map_err(err)?;
        let listed: Vec<Listed> = names
            .iter()
            .map(|name| {
                let delim = name.delimiter().unwrap_or("/").to_string();
                let role = role_of(name);
                let shown = net::decode_utf7(name.name());
                let leaf = shown.rsplit(delim.as_str()).next().unwrap_or(&shown).to_string();
                Listed {
                    path: name.name().to_string(),
                    name: if role == "inbox" { "Inbox".into() } else { leaf },
                    role: role.into(),
                    delim,
                    selectable: !name.attributes().iter().any(|a| matches!(a, imap_proto::NameAttribute::NoSelect)),
                }
            })
            .collect();
        drop(names);
        let gone = with_db(|conn| db::set_folders(conn, &self.account, &listed))?;
        for id in gone {
            let _ = std::fs::remove_dir_all(super::raw_dir(&self.account, id));
        }
        super::changed(&self.account);
        Ok(())
    }

    fn sync_all(&mut self) -> Result<(), String> {
        self.list_folders()?;
        let mut folders = with_db(|conn| db::folders(conn, Some(&self.account)))?;
        folders.retain(|f| f.selectable && !VIRTUAL_ROLES.contains(&f.role.as_str()));
        folders.sort_by_key(|f| priority(&f.role));
        for folder in &folders {
            if self.stopped() {
                return Ok(());
            }
            if let Err(why) = self.sync_folder(folder.id) {
                // One folder the server won't open doesn't stop the rest; a dead connection does.
                if !self.alive() {
                    return Err(why);
                }
                eprintln!("[mail] {}: {why}", folder.path);
            }
        }
        with_db(|conn| db::set_account_state(conn, &self.account, Some(super::now()), None))?;
        super::changed(&self.account);
        if !self.idling && self.link.as_ref().is_some_and(|l| l.idle) {
            self.idling = true;
            let (account, tx, stop, sockets) = (self.account.clone(), self.tx.clone(), self.stop.clone(), self.sockets.clone());
            let _ = std::thread::Builder::new().name("mail-idle".into()).spawn(move || idle(account, tx, stop, sockets));
        }
        Ok(())
    }

    fn sync_folder(&mut self, id: i64) -> Result<(), String> {
        let folder = self.folder(id)?;
        if !folder.selectable || VIRTUAL_ROLES.contains(&folder.role.as_str()) {
            return Ok(());
        }
        let Some(mailbox) = self.select(&folder, true)? else { return Ok(()) };
        let validity = mailbox.uid_validity.unwrap_or(0);
        let mut local = with_db(|conn| db::folder_uids(conn, id))?;
        if folder.uidvalidity != 0 && validity != folder.uidvalidity {
            // The server renumbered the folder: what's here no longer names its messages.
            with_db(|conn| db::clear_folder(conn, id))?;
            let _ = std::fs::remove_dir_all(super::raw_dir(&self.account, id));
            local.clear();
        }
        let first_time = folder.synced == 0;

        // What the server has, from the oldest message held here on (the newest ones at first).
        let mut server: HashMap<u32, u32> = HashMap::new();
        if mailbox.exists > 0 {
            let oldest = local.keys().min().copied();
            let session = &mut self.link()?.session;
            let fetched = match oldest {
                Some(oldest) => session.uid_fetch(format!("{oldest}:*"), "(UID FLAGS)"),
                None => session.fetch(format!("{}:*", mailbox.exists.saturating_sub(WINDOW - 1).max(1)), "(UID FLAGS)"),
            }
            .map_err(err)?;
            for f in fetched.iter() {
                if let Some(uid) = f.uid.filter(|uid| oldest.is_none_or(|oldest| *uid >= oldest)) {
                    server.insert(uid, bits(f.flags()));
                }
            }
        }
        let held: HashSet<u32> = super::held(id);
        let gone: Vec<u32> = local.keys().filter(|uid| !server.contains_key(uid) && !held.contains(uid)).copied().collect();
        if !gone.is_empty() {
            with_db(|conn| db::delete_uids(conn, id, &gone))?;
            for uid in &gone {
                let _ = std::fs::remove_file(super::raw_path(&self.account, id, *uid));
            }
        }
        let reflagged: Vec<(u32, u32)> = server.iter().filter(|(uid, flags)| local.get(uid).is_some_and(|old| old != *flags) && !held.contains(uid)).map(|(u, f)| (*u, *f)).collect();
        if !reflagged.is_empty() {
            with_db(|conn| reflagged.iter().try_for_each(|(uid, flags)| db::set_flags(conn, id, *uid, *flags)))?;
        }
        let new: Vec<u32> = server.keys().filter(|uid| !local.contains_key(uid) && !held.contains(uid)).copied().collect();
        let arrived = self.fetch_headers(&folder, new)?;
        if self.stopped() {
            return Ok(());
        }

        self.select(&folder, false)?;
        let unread = self.link()?.session.uid_search("UNSEEN").map_err(err)?.len() as u32;
        with_db(|conn| db::set_folder_state(conn, id, validity, mailbox.exists, unread, super::now()))?;
        super::changed(&self.account);
        if !first_time && folder.role == "inbox" {
            let unseen: Vec<&Header> = arrived.iter().filter(|h| h.flags & SEEN == 0).collect();
            if !unseen.is_empty() {
                super::announce(&self.account, &unseen);
            }
        }

        // The messages themselves, newest first, so they open at once and can be searched.
        if folder.role != "trash" && folder.role != "junk" {
            let wanted = with_db(|conn| db::without_body(conn, id, PREFETCH_MAX, PREFETCH_COUNT))?;
            for chunk in wanted.chunks(8) {
                if self.stopped() {
                    return Ok(());
                }
                self.select(&folder, false)?;
                let fetched = self.link()?.session.uid_fetch(uid_set(chunk), "(UID BODY.PEEK[])").map_err(err)?;
                for f in fetched.iter() {
                    if let (Some(uid), Some(raw)) = (f.uid, f.body()) {
                        super::store_body(&self.account, id, uid, raw)?;
                    }
                }
                drop(fetched);
                super::changed(&self.account);
                self.drain();
            }
        }
        Ok(())
    }

    /// Brings in the headers of these messages of the folder, newest first; returns them.
    fn fetch_headers(&mut self, folder: &Folder, mut uids: Vec<u32>) -> Result<Vec<Header>, String> {
        uids.sort_unstable_by(|a, b| b.cmp(a));
        let mut all = Vec::new();
        for chunk in uids.chunks(50) {
            if self.stopped() {
                break;
            }
            self.select(folder, false)?;
            let fetched = self.link()?.session.uid_fetch(uid_set(chunk), "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])").map_err(err)?;
            let headers: Vec<Header> = fetched
                .iter()
                .filter_map(|f| {
                    let mut h = parse::header(f.header()?);
                    h.uid = f.uid?;
                    h.size = f.size.unwrap_or(0);
                    h.flags = bits(f.flags());
                    if h.date <= 0 {
                        h.date = f.internal_date().map(|d| d.timestamp()).unwrap_or(0);
                    }
                    Some(h)
                })
                .collect();
            drop(fetched);
            with_db(|conn| db::insert_headers(conn, &self.account, folder.id, &headers))?;
            all.extend(headers);
            super::changed(&self.account);
            self.drain();
        }
        Ok(all)
    }

    fn older(&mut self, id: i64) -> Result<(), String> {
        let folder = self.folder(id)?;
        let local = with_db(|conn| db::folder_uids(conn, id))?;
        let Some(oldest) = local.keys().min().copied().filter(|uid| *uid > 1) else { return Ok(()) };
        self.select(&folder, false)?;
        let mut found: Vec<u32> = self.link()?.session.uid_search(format!("UID 1:{}", oldest - 1)).map_err(err)?.into_iter().filter(|uid| *uid < oldest).collect();
        found.sort_unstable_by(|a, b| b.cmp(a));
        found.truncate(WINDOW as usize);
        self.fetch_headers(&folder, found)?;
        self.want_folders.push(id);
        Ok(())
    }
}

/// Waits on the inbox in IDLE and asks for a sync whenever the server says it changed.
fn idle(account: String, tx: Sender<Cmd>, stop: Arc<AtomicBool>, sockets: Arc<Mutex<Vec<TcpStream>>>) {
    use imap::extensions::idle::{stop_on_any, WaitOutcome};
    let stopped = || stop.load(Ordering::SeqCst);
    let nap = |time: Duration| {
        let until = Instant::now() + time;
        while !stopped() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(500));
        }
    };
    while !stopped() {
        let ready = (|| -> Result<(Link, Folder), String> {
            let acct = with_db(|conn| db::account(conn, &account))?;
            let inbox = with_db(|conn| db::folder_by_role(conn, &account, "inbox"))?.ok_or("no inbox")?;
            let mut link = net::connect(&acct.imap, &acct.username, &super::cred(&acct)?)?;
            link.session.select(&inbox.path).map_err(err)?;
            Ok((link, inbox))
        })();
        let Ok((mut link, inbox)) = ready else {
            nap(RETRY);
            continue;
        };
        if let Ok(socket) = link.tcp.try_clone() {
            sockets.lock().unwrap_or_else(|e| e.into_inner()).push(socket);
        }
        while !stopped() {
            let mut waiting = link.session.idle();
            waiting.timeout(Duration::from_secs(9 * 60)).keepalive(false);
            let outcome = waiting.wait_while(stop_on_any);
            // IDLE leaves the socket without a timeout; ending it must not wait forever.
            let _ = link.tcp.set_read_timeout(Some(net::IO_TIMEOUT));
            drop(waiting);
            match outcome {
                Ok(WaitOutcome::MailboxChanged) => {
                    if tx.send(Cmd::Folder(inbox.id)).is_err() {
                        return;
                    }
                }
                Ok(WaitOutcome::TimedOut) => {}
                Err(_) => break,
            }
        }
        let _ = link.tcp.shutdown(Shutdown::Both);
        nap(Duration::from_secs(20));
    }
}
