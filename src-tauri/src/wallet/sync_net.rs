//! Sync over the local network: the desktop listens, the phone calls.
//!
//! Pairing: the desktop shows a QR code holding its id, name, addresses, port and a fresh secret.
//! The phone scans it, keeps the secret, and says hello encrypted with it; the desktop takes the
//! phone as a peer. From then on every frame between the two is sealed with that secret
//! (ChaCha20-Poly1305), so nobody else on the Wi-Fi can read or write either ledger.
//!
//! A sync is rounds of batches (`sync::changes_since`) both ways until neither side has more.
//! Each side moves its cursor for the other (`sync_peers.sent`) only once the other has said it
//! applied the batch, so a dropped connection just sends the same rows again next time.
//!
//! When the desktop's address changed (a new DHCP lease), the phone asks the network for it with a
//! UDP broadcast on the same port.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::db::{db_err, Result};
use super::sync::{self, Change};

/// The TCP port the desktop listens on, and the UDP port it answers "where are you?" on.
pub const PORT: u16 = 47_211;
const MAGIC: &[u8; 4] = b"ZWS1";
const MAX_FRAME: usize = 256 << 20;
/// Rows per batch.
const PAGE: usize = 1500;
/// How long a pairing code stays good.
const PAIRING_TTL: Duration = Duration::from_secs(300);
const TIMEOUT: Duration = Duration::from_secs(20);

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Another device this ledger syncs with.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    /// "desktop" (this side calls it) or "phone" (it calls this side).
    pub kind: String,
    pub address: String,
    /// Milliseconds since the epoch; 0 when never.
    pub last_sync: i64,
}

/// What a pairing QR code says.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Invite {
    pub device: String,
    pub name: String,
    pub addresses: Vec<String>,
    pub port: u16,
    pub secret: String,
}

impl Invite {
    pub fn to_code(&self) -> String {
        format!(
            "zazabor-wallet:1?d={}&n={}&a={}&p={}&k={}",
            self.device,
            B64.encode(self.name.as_bytes()),
            self.addresses.join(","),
            self.port,
            self.secret
        )
    }

    pub fn parse(code: &str) -> Result<Invite> {
        let bad = || "That isn't a Zazabor Wallet pairing code.".to_string();
        let query = code.trim().strip_prefix("zazabor-wallet:1?").ok_or_else(bad)?;
        let mut invite = Invite { device: String::new(), name: String::new(), addresses: vec![], port: PORT, secret: String::new() };
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').ok_or_else(bad)?;
            match k {
                "d" => invite.device = v.to_string(),
                "n" => invite.name = B64.decode(v).ok().and_then(|b| String::from_utf8(b).ok()).ok_or_else(bad)?,
                "a" => invite.addresses = v.split(',').filter(|a| !a.is_empty()).map(str::to_string).collect(),
                "p" => invite.port = v.parse().map_err(|_| bad())?,
                "k" => invite.secret = v.to_string(),
                _ => {}
            }
        }
        if invite.device.is_empty() || invite.addresses.is_empty() || key_bytes(&invite.secret).is_err() {
            return Err(bad());
        }
        Ok(invite)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t")]
enum Msg {
    Hello { device: String, name: String, schema: i64 },
    Welcome { device: String, name: String, schema: i64 },
    /// Rows, how far they reach, whether more follow, and how far the sender applied the other's.
    Batch { changes: Vec<Change>, upto: i64, more: bool, ack: i64 },
    /// The caller is done; `ack` as in a batch.
    Bye { ack: i64 },
    Done,
    Refused { reason: String },
}

// ---- framing and sealing

fn key_bytes(secret: &str) -> Result<[u8; 32]> {
    let bytes = B64.decode(secret).map_err(|_| "The pairing secret is damaged.".to_string())?;
    bytes.try_into().map_err(|_| "The pairing secret is damaged.".to_string())
}

pub fn new_secret() -> String {
    let mut bytes = [0u8; 32];
    SystemRandom::new().fill(&mut bytes).expect("the system's random source");
    B64.encode(bytes)
}

struct Channel {
    stream: TcpStream,
    key: LessSafeKey,
    /// Frames this side seals are tagged with its role, so a frame can't be bounced back.
    mine: &'static [u8],
    theirs: &'static [u8],
}

fn seal_key(secret: &str) -> Result<LessSafeKey> {
    Ok(LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, &key_bytes(secret)?).map_err(|_| "Bad key".to_string())?))
}

/// One frame: magic, the sender's device id (so the receiver knows which secret), then a sealed body.
fn write_frame(stream: &mut TcpStream, device: &str, key: &LessSafeKey, aad: &[u8], body: &[u8]) -> Result<()> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new().fill(&mut nonce).map_err(|_| "No randomness".to_string())?;
    let mut sealed = body.to_vec();
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(aad), &mut sealed).map_err(|_| "Couldn't seal".to_string())?;
    let mut out = Vec::with_capacity(sealed.len() + 64);
    out.extend_from_slice(MAGIC);
    out.push(device.len() as u8);
    out.extend_from_slice(device.as_bytes());
    out.extend_from_slice(&((NONCE_LEN + sealed.len()) as u32).to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    stream.write_all(&out).map_err(net_err)
}

/// Reads a frame's header: who sent it, and its sealed bytes.
fn read_raw(stream: &mut TcpStream) -> Result<(String, Vec<u8>)> {
    let mut magic = [0u8; 5];
    stream.read_exact(&mut magic).map_err(net_err)?;
    if &magic[..4] != MAGIC {
        return Err("Something else answered on the sync port.".into());
    }
    let mut device = vec![0u8; magic[4] as usize];
    stream.read_exact(&mut device).map_err(net_err)?;
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).map_err(net_err)?;
    let len = u32::from_be_bytes(len) as usize;
    if !(NONCE_LEN + 16..=MAX_FRAME).contains(&len) {
        return Err("A sync message was the wrong size.".into());
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).map_err(net_err)?;
    Ok((String::from_utf8_lossy(&device).into_owned(), body))
}

fn open_sealed(key: &LessSafeKey, aad: &[u8], mut body: Vec<u8>) -> Result<Msg> {
    let nonce = Nonce::try_assume_unique_for_key(&body[..NONCE_LEN]).map_err(|_| "Bad nonce".to_string())?;
    let plain = key.open_within(nonce, Aad::from(aad), &mut body, NONCE_LEN..).map_err(|_| "The other device doesn't have this pairing any more. Pair again.".to_string())?;
    serde_json::from_slice(plain).map_err(|e| format!("A sync message didn't make sense: {e}"))
}

impl Channel {
    fn send(&mut self, device: &str, msg: &Msg) -> Result<()> {
        let body = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        write_frame(&mut self.stream, device, &self.key, self.mine, &body)
    }

    fn recv(&mut self) -> Result<Msg> {
        let (_, body) = read_raw(&mut self.stream)?;
        open_sealed(&self.key, self.theirs, body)
    }
}

fn net_err(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "The other device stopped answering.".into(),
        std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset => "The other device hung up.".into(),
        _ => format!("Network: {e}"),
    }
}

// ---- peers

pub fn schema(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err)
}

pub fn peers(conn: &Connection) -> Result<Vec<Peer>> {
    let mut stmt = conn.prepare("SELECT id, name, kind, address, last_sync FROM sync_peers ORDER BY created").map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| Ok(Peer { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, address: r.get(3)?, last_sync: r.get(4)? }))
        .map_err(db_err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_err);
    rows
}

fn peer_secret(conn: &Connection, id: &str) -> Result<Option<(String, i64)>> {
    conn.query_row("SELECT secret, sent FROM sync_peers WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(db_err)
}

pub fn add_peer(conn: &Connection, id: &str, name: &str, kind: &str, secret: &str, address: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_peers (id, name, kind, secret, address, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, secret = excluded.secret, address = excluded.address",
        params![id, name, kind, secret, address, now],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn forget_peer(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM sync_peers WHERE id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

fn set_sent(conn: &Connection, id: &str, sent: i64, now: i64) -> Result<()> {
    conn.execute("UPDATE sync_peers SET sent = max(sent, ?2), last_sync = ?3 WHERE id = ?1", params![id, sent, now]).map_err(db_err)?;
    Ok(())
}

/// This machine's IPv4 addresses on its networks (not loopback), best first.
pub fn local_addresses() -> Vec<String> {
    let mut out = Vec::new();
    // The address the default route leaves from (no packet is sent).
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        if s.connect("192.0.2.1:9").is_ok() {
            if let Ok(SocketAddr::V4(a)) = s.local_addr() {
                if !a.ip().is_loopback() && !a.ip().is_unspecified() {
                    out.push(a.ip().to_string());
                }
            }
        }
    }
    // SAFETY: getifaddrs hands back a list we only read, then free with freeifaddrs.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) == 0 {
            let mut cur = list;
            while !cur.is_null() {
                let ifa = &*cur;
                if !ifa.ifa_addr.is_null() && (*ifa.ifa_addr).sa_family as i32 == libc::AF_INET {
                    let sin = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                    let ip = Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
                    // Container and VPN bridges are rarely where the phone is; keep them last.
                    let name = std::ffi::CStr::from_ptr(ifa.ifa_name).to_string_lossy();
                    let s = ip.to_string();
                    if !ip.is_loopback() && !out.contains(&s) && !name.starts_with("docker") && !name.starts_with("br-") && !name.starts_with("veth") {
                        out.push(s);
                    }
                }
                cur = ifa.ifa_next;
            }
            libc::freeifaddrs(list);
        }
    }
    out
}

// ---- the desktop's side

/// The secret a QR code on screen offers, until someone uses it or it runs out.
static PAIRING: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// Starts offering a pairing; the QR code shows what it returns.
pub fn invite(device: String, name: String, port: u16) -> Invite {
    let secret = new_secret();
    *PAIRING.lock().unwrap() = Some((secret.clone(), Instant::now()));
    Invite { device, name, addresses: local_addresses(), port, secret }
}

pub fn cancel_invite() {
    *PAIRING.lock().unwrap() = None;
}

/// Where the ledger is, for the server's threads: run `f` on it, or fail when it's closed.
pub trait Ledger: Send + Sync + 'static {
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T>;
    fn name(&self) -> String;
    /// Rows came in: tell the windows.
    fn changed(&self);
    /// A phone paired: tell the window showing the QR code.
    fn paired(&self, peer: &Peer);
}

/// Listens for phones on `PORT` (TCP) and answers "where are you?" (UDP). Returns the port.
pub fn serve<L: Ledger>(ledger: L) -> Result<u16> {
    let listener = TcpListener::bind(("0.0.0.0", PORT)).or_else(|_| TcpListener::bind(("0.0.0.0", 0))).map_err(|e| format!("Wallet sync can't listen: {e}"))?;
    let port = listener.local_addr().map_err(net_err)?.port();
    let ledger = std::sync::Arc::new(ledger);
    let device = ledger.with(|c| sync::device(c))?;
    if let Ok(udp) = UdpSocket::bind(("0.0.0.0", PORT)) {
        let device = device.clone();
        let _ = std::thread::Builder::new().name("wallet-sync-find".into()).spawn(move || {
            let mut buf = [0u8; 128];
            while let Ok((n, from)) = udp.recv_from(&mut buf) {
                if buf[..n] == *format!("ZWS?{device}").as_bytes() {
                    let _ = udp.send_to(format!("ZWS!{device}:{port}").as_bytes(), from);
                }
            }
        });
    }
    let _ = std::thread::Builder::new().name("wallet-sync".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let ledger = ledger.clone();
            let device = device.clone();
            let _ = std::thread::Builder::new().name("wallet-sync-peer".into()).spawn(move || {
                if let Err(err) = answer(&*ledger, &device, stream) {
                    eprintln!("Wallet sync: {err}");
                }
            });
        }
    });
    Ok(port)
}

/// One phone's visit.
fn answer<L: Ledger>(ledger: &L, device: &str, mut stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(TIMEOUT)).map_err(net_err)?;
    stream.set_write_timeout(Some(TIMEOUT)).map_err(net_err)?;
    let (peer, body) = read_raw(&mut stream)?;
    // A known phone, or one using the pairing code on screen.
    let known = ledger.with(|c| peer_secret(c, &peer))?;
    let pairing = PAIRING.lock().unwrap().clone().filter(|(_, at)| at.elapsed() < PAIRING_TTL).map(|(s, _)| s);
    let mut opened = None;
    for (secret, new) in known.iter().map(|k| (k.0.clone(), false)).chain(pairing.into_iter().map(|s| (s, true))) {
        let key = seal_key(&secret)?;
        if let Ok(msg) = open_sealed(&key, b"call", body.clone()) {
            opened = Some((key, secret, new, msg));
            break;
        }
    }
    let Some((key, secret, new, hello)) = opened else {
        return Err("A device that isn't paired tried to sync.".into());
    };
    let mut ch = Channel { stream, key, mine: b"answer", theirs: b"call" };
    let Msg::Hello { name, schema: theirs, .. } = hello else { return Err("The phone didn't say hello.".into()) };
    let (ours, mut sent) = ledger.with(|c| Ok((schema(c)?, peer_secret(c, &peer)?.map_or(0, |p| p.1))))?;
    if theirs != ours {
        let reason = if theirs < ours { "Update Zazabor Wallet on the phone to sync with this computer." } else { "Update Zazabor on this computer to sync with the phone." };
        ch.send(device, &Msg::Refused { reason: reason.into() })?;
        return Err(reason.into());
    }
    if new {
        let address = ch.stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
        let now = crate::notes::now();
        ledger.with(|c| add_peer(c, &peer, &name, "phone", &secret, &address, now))?;
        cancel_invite();
        ledger.paired(&Peer { id: peer.clone(), name: name.clone(), kind: "phone".into(), address, last_sync: now });
    }
    ch.send(device, &Msg::Welcome { device: device.into(), name: ledger.name(), schema: ours })?;
    let mut got_any = false;
    loop {
        match ch.recv()? {
            Msg::Batch { changes, ack, .. } => {
                if ack > 0 {
                    ledger.with(|c| set_sent(c, &peer, ack, crate::notes::now()))?;
                    sent = sent.max(ack);
                }
                got_any |= !changes.is_empty();
                ledger.with(|c| sync::apply(c, changes))?;
                let (changes, upto, more) = ledger.with(|c| page(c, sent, &peer))?;
                ch.send(device, &Msg::Batch { changes, upto, more, ack: 0 })?;
                // The next batch starts after this one, acknowledged or not.
                sent = upto;
            }
            Msg::Bye { ack } => {
                ledger.with(|c| set_sent(c, &peer, ack, crate::notes::now()))?;
                ch.send(device, &Msg::Done)?;
                break;
            }
            other => return Err(format!("Unexpected {other:?}")),
        }
    }
    if got_any {
        ledger.changed();
    }
    Ok(())
}

fn page(conn: &Connection, since: i64, peer: &str) -> Result<(Vec<Change>, i64, bool)> {
    let (changes, upto) = sync::changes_since(conn, since, PAGE, Some(peer))?;
    Ok((changes, upto, upto < sync::head(conn)?))
}

// ---- the phone's side

/// What a sync did, for the screen.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub sent: usize,
    pub received: usize,
    pub peer: String,
}

/// Finds a paired desktop whose address changed: a broadcast, answered with its port.
fn find(device: &str) -> Option<SocketAddr> {
    let udp = UdpSocket::bind("0.0.0.0:0").ok()?;
    udp.set_broadcast(true).ok()?;
    udp.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    let ask = format!("ZWS?{device}");
    for _ in 0..2 {
        let _ = udp.send_to(ask.as_bytes(), (Ipv4Addr::BROADCAST, PORT));
        let mut buf = [0u8; 128];
        while let Ok((n, from)) = udp.recv_from(&mut buf) {
            let reply = String::from_utf8_lossy(&buf[..n]).into_owned();
            if let Some(port) = reply.strip_prefix(&format!("ZWS!{device}:")).and_then(|p| p.parse::<u16>().ok()) {
                return Some(SocketAddr::new(from.ip(), port));
            }
        }
    }
    None
}

fn connect(addresses: &[String], port: u16, device: &str) -> Result<TcpStream> {
    for a in addresses {
        let addr = a.parse::<SocketAddr>().or_else(|_| a.parse::<IpAddr>().map(|ip| SocketAddr::new(ip, port)));
        if let Ok(addr) = addr {
            if let Ok(s) = TcpStream::connect_timeout(&addr, Duration::from_millis(2500)) {
                return Ok(s);
            }
        }
    }
    if let Some(addr) = find(device) {
        if let Ok(s) = TcpStream::connect_timeout(&addr, Duration::from_millis(2500)) {
            return Ok(s);
        }
    }
    Err("Couldn't reach the computer. Check that it's on, Zazabor Home is open, and both are on the same Wi-Fi.".into())
}

/// Calls a desktop and syncs both ways. `invite` is set the first time (from the QR code); later
/// the peer's saved secret and address are used. The ledger is only locked while reading or
/// writing it, never while waiting on the network.
pub fn call(with: &dyn Fn(&mut dyn FnMut(&mut Connection) -> Result<()>) -> Result<()>, peer_id: &str, invite: Option<&Invite>, my_name: &str) -> Result<Outcome> {
    let mut me = String::new();
    let mut ours = 0;
    let mut saved: Option<(String, i64, String)> = None;
    with(&mut |c| {
        me = sync::device(c)?;
        ours = schema(c)?;
        saved = c
            .query_row("SELECT secret, sent, address FROM sync_peers WHERE id = ?1", [peer_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(db_err)?;
        Ok(())
    })?;
    let (secret, mut sent, addresses, port) = match (invite, saved) {
        (Some(inv), _) => (inv.secret.clone(), 0, inv.addresses.clone(), inv.port),
        (None, Some((secret, sent, address))) => {
            let (host, port) = address.rsplit_once(':').and_then(|(h, p)| p.parse().ok().map(|p| (h.to_string(), p))).unwrap_or((address.clone(), PORT));
            (secret, sent, vec![host], port)
        }
        (None, None) => return Err("That computer isn't paired any more.".into()),
    };
    let stream = connect(&addresses, port, peer_id)?;
    stream.set_read_timeout(Some(TIMEOUT)).map_err(net_err)?;
    stream.set_write_timeout(Some(TIMEOUT)).map_err(net_err)?;
    let address = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    let mut ch = Channel { stream, key: seal_key(&secret)?, mine: b"call", theirs: b"answer" };
    ch.send(&me, &Msg::Hello { device: me.clone(), name: my_name.into(), schema: ours })?;
    let welcome = ch.recv().map_err(|e| {
        if invite.is_some() && e.contains("hung up") {
            "The computer didn't take this code. Codes work once, for five minutes: show a new one and scan again.".to_string()
        } else if e.contains("hung up") {
            "The computer doesn't know this phone any more. Pair again from its Settings → Wallet → Devices.".to_string()
        } else {
            e
        }
    })?;
    let (their_name, theirs) = match welcome {
        Msg::Welcome { name, schema, .. } => (name, schema),
        Msg::Refused { reason } => return Err(reason),
        other => return Err(format!("Unexpected {other:?}")),
    };
    if theirs != ours {
        return Err("Zazabor on the computer and the phone are different versions. Update both.".into());
    }
    let now = crate::notes::now();
    with(&mut |c| add_peer(c, peer_id, &their_name, "desktop", &secret, &address, now))?;

    let mut out = Outcome { peer: their_name, ..Outcome::default() };
    let mut ack = 0;
    loop {
        let mut batch = (Vec::new(), 0, false);
        with(&mut |c| {
            batch = page(c, sent, peer_id)?;
            Ok(())
        })?;
        let (changes, upto, more) = batch;
        out.sent += changes.len();
        ch.send(&me, &Msg::Batch { changes, upto, more, ack })?;
        let Msg::Batch { changes: theirs, upto: their_upto, more: their_more, .. } = ch.recv()? else {
            return Err("The computer answered out of turn.".into());
        };
        out.received += theirs.len();
        with(&mut |c| {
            sync::apply(c, theirs.clone())?;
            set_sent(c, peer_id, upto, crate::notes::now())
        })?;
        sent = upto;
        ack = their_upto;
        if !more && !their_more {
            break;
        }
    }
    ch.send(&me, &Msg::Bye { ack })?;
    match ch.recv()? {
        Msg::Done => Ok(out),
        other => Err(format!("Unexpected {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::fresh;
    use std::sync::Arc;

    #[test]
    fn invite_codes_round_trip() {
        let inv = Invite { device: "abc".into(), name: "Soab’s PC".into(), addresses: vec!["192.168.1.5".into(), "10.0.0.2".into()], port: 47211, secret: new_secret() };
        assert_eq!(Invite::parse(&inv.to_code()).unwrap(), inv);
        assert!(Invite::parse("https://example.com").is_err());
    }

    struct Desk(Arc<Mutex<Connection>>);
    impl Ledger for Desk {
        fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
            f(&mut self.0.lock().unwrap())
        }
        fn name(&self) -> String {
            "Desk".into()
        }
        fn changed(&self) {}
        fn paired(&self, _: &Peer) {}
    }

    fn ledger() -> Arc<Mutex<Connection>> {
        let c = fresh();
        sync::install(&c).unwrap();
        Arc::new(Mutex::new(c))
    }

    fn count(c: &Arc<Mutex<Connection>>, sql: &str) -> i64 {
        c.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_phone_pairs_and_syncs_over_the_network() {
        let desk = ledger();
        let phone = ledger();
        desk.lock().unwrap().execute("INSERT INTO accounts (id, name, kind, currency, created, updated) VALUES ('d', 'Desk bank', 'bank', 'BDT', 1, 1)", []).unwrap();
        phone.lock().unwrap().execute("INSERT INTO accounts (id, name, kind, currency, created, updated) VALUES ('p', 'bKash', 'mobile_wallet', 'BDT', 1, 1)", []).unwrap();
        // The desktop listens (on whichever port is free; the test can't count on 47211).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let desk_id = sync::device(&desk.lock().unwrap()).unwrap();
        let mut inv = invite(desk_id.clone(), "Desk".into(), port);
        inv.addresses = vec!["127.0.0.1".into()];
        let server = {
            let desk = Desk(desk.clone());
            let device = desk_id.clone();
            std::thread::spawn(move || {
                for _ in 0..2 {
                    let (s, _) = listener.accept().unwrap();
                    answer(&desk, &device, s).unwrap();
                }
            })
        };
        let with = |f: &mut dyn FnMut(&mut Connection) -> Result<()>| f(&mut phone.lock().unwrap());
        let first = call(&with, &desk_id, Some(&Invite::parse(&inv.to_code()).unwrap()), "Phone").unwrap();
        assert_eq!(first.peer, "Desk");
        assert_eq!(count(&desk, "SELECT count(*) FROM accounts WHERE id IN ('d', 'p')"), 2);
        assert_eq!(count(&phone, "SELECT count(*) FROM accounts WHERE id IN ('d', 'p')"), 2);
        // Later: the saved pairing, and only what changed travels.
        desk.lock().unwrap().execute("UPDATE accounts SET name = 'City Bank' WHERE id = 'd'", []).unwrap();
        let second = call(&with, &desk_id, None, "Phone").unwrap();
        assert_eq!((second.sent, second.received), (0, 1));
        assert_eq!(count(&phone, "SELECT count(*) FROM accounts WHERE name = 'City Bank'"), 1);
        server.join().unwrap();
        // A stranger with a made-up secret gets nowhere.
        assert!(open_sealed(&seal_key(&new_secret()).unwrap(), b"call", vec![0; 40]).is_err());
    }

    /// Not a test: a desktop's sync server on a scratch ledger, for pairing a phone or the
    /// emulator by hand. `ZW_SERVE_DB=/tmp/x.db cargo test --lib serve_for_a_phone -- --ignored --nocapture`
    /// prints the pairing code and serves until stopped.
    #[test]
    #[ignore]
    fn serve_for_a_phone() {
        let path = std::env::var("ZW_SERVE_DB").expect("ZW_SERVE_DB names a scratch ledger file");
        let mut conn = Connection::open(&path).unwrap();
        crate::wallet::db::migrate(&mut conn, crate::notes::now()).unwrap();
        sync::install(&conn).unwrap();
        let desk = Desk(Arc::new(Mutex::new(conn)));
        let device = desk.with(|c| sync::device(c)).unwrap();
        let port = serve(desk).unwrap();
        println!("PAIRING CODE {}", invite(device, "Test desk".into(), port).to_code());
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
}
