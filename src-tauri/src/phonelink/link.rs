//! The Wi-Fi link to a phone (`ZLNK/1`, docs/plans/phone-link.md §1): the listener, the
//! handshake with its numeric-comparison pairing, the sealed frames, requests with answers, and
//! the keep-alive pings.
//!
//! One thread per phone reads its frames and hands them to the hub; anything that waits on the
//! phone (a request) runs on another thread, so the reader is always free to deliver the answer.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::hkdf;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{lock, Hub};

/// The port the PC listens on first; the next free one when it's taken.
pub const PORT: u16 = 47_213;
const MAGIC: &str = "ZLNK/1";
/// A sealed body: at most 1 MiB of plaintext plus the 16-byte tag.
pub const MAX_SEALED: usize = (1 << 20) + 16;
/// File data per `2`-frame.
pub const CHUNK: usize = 256 << 10;
const TAG_LEN: usize = 16;
/// How long the user and the phone have to agree on a pairing code.
const PAIR_TIMEOUT: Duration = Duration::from_secs(120);
/// How long the handshake lines may take.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub type Result<T> = std::result::Result<T, String>;

// ---- keys -------------------------------------------------------------------------------------

/// The phone's id on the wire: the first 32 hex digits of SHA-256(mirrorSecret).
pub fn phone_id(mirror_secret: &str) -> String {
    hex(&Sha256::digest(mirror_secret.as_bytes()))[..32].to_string()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

/// Base64 from the phone: standard, with or without padding (URL-safe tolerated too).
pub fn unbase64(text: &str) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    let t = text.trim();
    B64.decode(t).or_else(|_| STANDARD_NO_PAD.decode(t)).or_else(|_| URL_SAFE.decode(t)).or_else(|_| URL_SAFE_NO_PAD.decode(t)).ok()
}

pub fn base64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

struct Len(usize);
impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

/// HKDF-SHA256 with the salt `phoneNonce ‖ pcNonce`.
fn derive(ikm: &[u8], phone_nonce: &[u8], pc_nonce: &[u8], info: &[u8], out: &mut [u8]) {
    let salt = [phone_nonce, pc_nonce].concat();
    hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
        .extract(ikm)
        .expand(&[info], Len(out.len()))
        .and_then(|okm| okm.fill(out))
        .expect("HKDF output fits");
}

/// The key a pairing leaves both sides with.
pub fn link_key(z: &[u8], phone_nonce: &[u8], pc_nonce: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    derive(z, phone_nonce, pc_nonce, b"zlnk pair", &mut out);
    out
}

/// The six-digit code both screens show while pairing.
pub fn pair_code(z: &[u8], phone_nonce: &[u8], pc_nonce: &[u8]) -> u32 {
    let mut out = [0u8; 4];
    derive(z, phone_nonce, pc_nonce, b"zlnk code", &mut out);
    u32::from_be_bytes(out) % 1_000_000
}

/// "482 913".
pub fn show_code(code: u32) -> String {
    let digits = format!("{code:06}");
    format!("{} {}", &digits[..3], &digits[3..])
}

/// This connection's keys: (phone→PC, PC→phone).
pub fn session_keys(link_key: &[u8], phone_nonce: &[u8], pc_nonce: &[u8]) -> ([u8; 32], [u8; 32]) {
    let mut out = [0u8; 64];
    derive(link_key, phone_nonce, pc_nonce, b"zlnk session", &mut out);
    let (a, b) = out.split_at(32);
    (a.try_into().unwrap(), b.try_into().unwrap())
}

/// One direction's ChaCha20-Poly1305 key and frame counter.
pub struct Cipher {
    key: LessSafeKey,
    counter: u64,
}

impl Cipher {
    pub fn new(key: &[u8; 32]) -> Cipher {
        Cipher { key: LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, key).expect("a 32-byte key")), counter: 0 }
    }

    fn nonce(&mut self) -> Nonce {
        let mut n = [0u8; 12];
        n[4..].copy_from_slice(&self.counter.to_be_bytes());
        self.counter += 1;
        Nonce::assume_unique_for_key(n)
    }

    /// Ciphertext ‖ tag for the next frame.
    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        let mut out = plain.to_vec();
        let nonce = self.nonce();
        self.key.seal_in_place_append_tag(nonce, Aad::empty(), &mut out).expect("sealing can't fail");
        out
    }

    /// The next frame's plaintext; fails on anything not sealed with this key and counter.
    pub fn open(&mut self, mut sealed: Vec<u8>) -> Result<Vec<u8>> {
        let nonce = self.nonce();
        let n = self.key.open_in_place(nonce, Aad::empty(), &mut sealed).map_err(|_| "A frame from the phone didn't open.".to_string())?.len();
        sealed.truncate(n);
        Ok(sealed)
    }
}

// ---- frames -----------------------------------------------------------------------------------

/// What a frame carries.
#[derive(Debug, PartialEq)]
pub enum Frame {
    Json(Value),
    Data(u32, Vec<u8>),
}

pub fn encode(frame: &Frame) -> Vec<u8> {
    match frame {
        Frame::Json(v) => {
            let mut out = vec![1u8];
            out.extend_from_slice(&serde_json::to_vec(v).expect("JSON"));
            out
        }
        Frame::Data(xfer, bytes) => {
            let mut out = Vec::with_capacity(5 + bytes.len());
            out.push(2);
            out.extend_from_slice(&xfer.to_be_bytes());
            out.extend_from_slice(bytes);
            out
        }
    }
}

pub fn decode(plain: Vec<u8>) -> Result<Frame> {
    match plain.first() {
        Some(1) => {
            let v: Value = serde_json::from_slice(&plain[1..]).map_err(|e| format!("A message from the phone didn't make sense: {e}"))?;
            if !v.get("t").is_some_and(Value::is_string) {
                return Err("A message from the phone had no type.".into());
            }
            Ok(Frame::Json(v))
        }
        Some(2) if plain.len() >= 5 => {
            let xfer = u32::from_be_bytes(plain[1..5].try_into().unwrap());
            Ok(Frame::Data(xfer, plain[5..].to_vec()))
        }
        _ => Err("The phone sent a frame of an unknown kind.".into()),
    }
}

/// Seals a frame and writes it with its length.
pub fn write_frame(w: &mut impl Write, cipher: &mut Cipher, frame: &Frame) -> Result<()> {
    let sealed = cipher.seal(&encode(frame));
    let mut out = Vec::with_capacity(4 + sealed.len());
    out.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    w.write_all(&out).map_err(net_err)?;
    w.flush().map_err(net_err)
}

/// Reads and opens one frame.
pub fn read_frame(r: &mut impl Read, cipher: &mut Cipher) -> Result<Frame> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).map_err(net_err)?;
    let len = u32::from_be_bytes(len) as usize;
    if !(TAG_LEN + 1..=MAX_SEALED).contains(&len) {
        return Err("A frame from the phone was the wrong size.".into());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(net_err)?;
    decode(cipher.open(body)?)
}

pub fn net_err(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "The phone stopped answering.".into(),
        std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => "The phone disconnected.".into(),
        _ => format!("Network: {e}"),
    }
}

/// One handshake line (at most 8 KiB), without its newline.
pub fn read_line(r: &mut impl BufRead) -> Result<String> {
    let mut line = Vec::new();
    r.take(8192).read_until(b'\n', &mut line).map_err(net_err)?;
    if line.last() != Some(&b'\n') {
        return Err(if line.is_empty() { "The phone disconnected.".into() } else { "The phone's handshake line was too long.".into() });
    }
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line).map_err(|_| "The phone's handshake wasn't text.".to_string())
}

fn write_line(w: &mut impl Write, v: &Value) -> Result<()> {
    let mut line = serde_json::to_vec(v).expect("JSON");
    line.push(b'\n');
    w.write_all(&line).map_err(net_err)
}

fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    SystemRandom::new().fill(&mut out).expect("the system's random source");
    out
}

pub fn new_pc_id() -> String {
    hex(&random::<16>())
}

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

// ---- a live link ------------------------------------------------------------------------------

/// The PC's side of one connected phone.
pub struct Link {
    pub phone_id: String,
    stream: TcpStream,
    writer: Mutex<Cipher>,
    pending: Mutex<HashMap<u32, mpsc::Sender<Value>>>,
    next_rid: AtomicU32,
    last_sent: Mutex<Instant>,
    closed: AtomicBool,
}

impl Link {
    fn new(phone_id: String, stream: TcpStream, cipher: Cipher) -> Link {
        Link {
            phone_id,
            stream,
            writer: Mutex::new(cipher),
            pending: Mutex::new(HashMap::new()),
            next_rid: AtomicU32::new(1),
            last_sent: Mutex::new(Instant::now()),
            closed: AtomicBool::new(false),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn write(&self, frame: &Frame) -> Result<()> {
        if self.is_closed() {
            return Err("The phone disconnected.".into());
        }
        let mut cipher = lock(&self.writer);
        let result = write_frame(&mut &self.stream, &mut cipher, frame);
        drop(cipher);
        match result {
            Ok(()) => {
                *lock(&self.last_sent) = Instant::now();
                Ok(())
            }
            Err(e) => {
                self.close();
                Err(e)
            }
        }
    }

    /// Sends one message (no answer expected).
    pub fn send(&self, msg: Value) -> Result<()> {
        self.write(&Frame::Json(msg))
    }

    /// Sends file data for a transfer.
    pub fn send_data(&self, xfer: u32, bytes: &[u8]) -> Result<()> {
        self.write(&Frame::Data(xfer, bytes.to_vec()))
    }

    /// Sends a request and waits for its answer: the answer's fields on `"ok":true`, its error
    /// otherwise.
    pub fn request(&self, mut msg: Value, timeout: Duration) -> Result<Value> {
        let rid = self.next_rid.fetch_add(1, Ordering::SeqCst);
        msg["rid"] = json!(rid);
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(rid, tx);
        if let Err(e) = self.send(msg) {
            lock(&self.pending).remove(&rid);
            return Err(e);
        }
        let answer = rx.recv_timeout(timeout);
        lock(&self.pending).remove(&rid);
        match answer {
            Ok(v) if v.get("ok").and_then(Value::as_bool) == Some(true) => Ok(v),
            Ok(v) => Err(v.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()).unwrap_or("The phone couldn't do that.").to_string()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("The phone didn't answer in time.".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("The phone disconnected.".into()),
        }
    }

    /// An answer arrived: wake the request waiting for it.
    fn answered(&self, v: Value) {
        let Some(rid) = v.get("rid").and_then(Value::as_u64) else { return };
        if let Some(tx) = lock(&self.pending).remove(&(rid as u32)) {
            let _ = tx.send(v);
        }
    }

    /// Hangs up; every request still waiting fails.
    pub fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.stream.shutdown(Shutdown::Both);
        }
        lock(&self.pending).clear();
    }
}

// ---- the listener -----------------------------------------------------------------------------

/// A running listener; dropping it doesn't stop it, `stop` does.
pub struct Listener {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Listener {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Listens on `host` at `PORT` or the next free port (0 = any), and handles each phone that
/// connects on its own thread.
pub fn listen(hub: &Arc<Hub>, host: &str, port: u16) -> Result<Listener> {
    let listener = if port == 0 {
        TcpListener::bind((host, 0))
    } else {
        (port..port.saturating_add(20)).find_map(|p| TcpListener::bind((host, p)).ok()).map_or_else(|| TcpListener::bind((host, 0)), Ok)
    }
    .map_err(|e| format!("Phone Link can't listen: {e}"))?;
    let port = listener.local_addr().map_err(net_err)?.port();
    listener.set_nonblocking(true).map_err(net_err)?;
    let stop = Arc::new(AtomicBool::new(false));
    let hub = hub.clone();
    let stopped = stop.clone();
    std::thread::Builder::new()
        .name("phonelink".into())
        .spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let hub = hub.clone();
                        let _ = std::thread::Builder::new().name("phonelink-phone".into()).spawn(move || {
                            if let Err(err) = accept(&hub, stream) {
                                eprintln!("Phone Link: {err}");
                            }
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
                    Err(e) => {
                        eprintln!("Phone Link: {e}");
                        std::thread::sleep(Duration::from_millis(500));
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Listener { port, stop })
}

/// What a pairing waits for.
enum PairEvent {
    User(bool),
    Phone(Result<bool>),
}

/// One phone's connection, from its first line to its last frame.
pub fn accept(hub: &Arc<Hub>, stream: TcpStream) -> Result<()> {
    stream.set_nonblocking(false).map_err(net_err)?;
    stream.set_nodelay(true).ok();
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(net_err)?;
    stream.set_write_timeout(Some(Duration::from_secs(30))).map_err(net_err)?;
    let mut reader = BufReader::with_capacity(64 << 10, stream.try_clone().map_err(net_err)?);
    let mut out = stream.try_clone().map_err(net_err)?;

    if read_line(&mut reader)? != MAGIC {
        return Err("Something that isn't Zazabor Link connected.".into());
    }
    let hello: Value = serde_json::from_str(&read_line(&mut reader)?).map_err(|_| "The phone's handshake didn't make sense.".to_string())?;
    let phone_id = str_field(&hello, "phoneId").to_ascii_lowercase();
    let phone_nonce = unbase64(str_field(&hello, "nonce")).unwrap_or_default();
    if phone_id.len() != 32 || !phone_id.bytes().all(|b| b.is_ascii_hexdigit()) || phone_nonce.len() != 16 {
        write_line(&mut out, &json!({"ok": false, "reason": "This version of Zazabor Link doesn't fit this PC. Update both."}))?;
        return Err("A phone sent a handshake that didn't fit.".into());
    }
    let name = str_field(&hello, "name").to_string();
    let model = str_field(&hello, "model").to_string();
    let wants_pair = hello.get("pair").and_then(Value::as_bool).unwrap_or(false);
    // SHA-256 of the key the phone will pair with, fixed before it sees the PC's key.
    let commit = unbase64(str_field(&hello, "commit")).filter(|c| c.len() == 32);
    let pc_nonce = random::<16>();
    let known = hub.with_db(|c| super::store::link_key(c, &phone_id))?;

    let (mut rx, tx) = match known {
        Some(key) if !wants_pair => {
            write_line(&mut out, &json!({"ok": true, "pcId": hub.pc_id, "name": hub.pc_name(), "nonce": base64(&pc_nonce)}))?;
            let (up, down) = session_keys(&key, &phone_nonce, &pc_nonce);
            (Cipher::new(&up), Cipher::new(&down))
        }
        // A phone this PC doesn't know, reconnecting on its own (not asking to pair): say so and
        // close. The phone then says "This PC forgot this phone" and waits for its user.
        None if !wants_pair => {
            let _ = write_line(&mut out, &json!({"ok": false, "unknown": true, "pcId": hub.pc_id, "name": hub.pc_name(), "reason": "This PC doesn't know this phone any more. Pair again."}));
            let _ = stream.shutdown(Shutdown::Both);
            return Err(format!("{} isn't paired with this PC (any more).", if name.is_empty() { "A phone" } else { name.as_str() }));
        }
        _ => {
            let Some((attempt, pairing)) = hub.begin_pairing(&phone_id, &name) else {
                write_line(&mut out, &json!({"ok": false, "reason": "This PC is pairing with another phone right now. Try again in a moment."}))?;
                return Err("A second phone tried to pair during a pairing.".into());
            };
            let result = pair(hub, &stream, reader, &mut out, &phone_id, &model, &phone_nonce, &pc_nonce, commit.as_deref(), pairing);
            hub.end_pairing(&phone_id, attempt);
            let (got_reader, ciphers) = result?;
            reader = got_reader;
            ciphers
        }
    };

    // The first sealed frame proves the phone holds the key. One that doesn't open gets no answer.
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).map_err(net_err)?;
    let first = match read_frame(&mut reader, &mut rx) {
        Ok(Frame::Json(v)) if str_field(&v, "t") == "hello" => v,
        Ok(_) => return Err("The phone didn't start with hello.".into()),
        Err(e) => {
            let _ = stream.shutdown(Shutdown::Both);
            return Err(format!("A phone that this PC doesn't know (or forgot) connected: {e}"));
        }
    };
    stream.set_read_timeout(Some(hub.timing.dead)).map_err(net_err)?;
    let link = Arc::new(Link::new(phone_id.clone(), stream.try_clone().map_err(net_err)?, tx));
    hub.connected(&link, &first);
    keep_alive(hub, &link);
    let end = loop {
        match read_frame(&mut reader, &mut rx) {
            Ok(Frame::Json(v)) => {
                if str_field(&v, "t") == "re" {
                    link.answered(v);
                } else {
                    hub.message(&link, v);
                }
            }
            Ok(Frame::Data(xfer, bytes)) => hub.data(&link, xfer, &bytes),
            Err(e) => break e,
        }
        if link.is_closed() {
            break "Closed".into();
        }
    };
    link.close();
    hub.disconnected(&link);
    if end == "Closed" || end.contains("disconnected") {
        Ok(())
    } else {
        Err(end)
    }
}

/// Pings after a quiet spell, so the phone's 30-second watchdog doesn't hang up.
fn keep_alive(hub: &Arc<Hub>, link: &Arc<Link>) {
    let link = link.clone();
    let every = hub.timing.ping;
    let _ = std::thread::Builder::new().name("phonelink-ping".into()).spawn(move || {
        let tick = (every / 4).max(Duration::from_millis(20));
        while !link.is_closed() {
            std::thread::sleep(tick);
            if lock(&link.last_sent).elapsed() >= every && link.send(json!({"t": "ping"})).is_err() {
                break;
            }
        }
    });
}

/// The pairing half of the handshake. Returns the reader and the ciphers, at counter 1 each,
/// once both sides said `pair.ok`; the connection then goes on with the phone's `hello`.
///
/// The phone's key must match the commitment in its hello (SHA-256 of the key, sent before it
/// saw the PC's). Otherwise someone posing as the phone could try key after key until the two
/// six-digit codes matched; no code is worked out or shown for a key that doesn't match.
#[allow(clippy::too_many_arguments)]
fn pair(
    hub: &Arc<Hub>,
    stream: &TcpStream,
    mut reader: BufReader<TcpStream>,
    out: &mut TcpStream,
    phone_id: &str,
    model: &str,
    phone_nonce: &[u8],
    pc_nonce: &[u8],
    commit: Option<&[u8]>,
    answers: mpsc::Receiver<bool>,
) -> Result<(BufReader<TcpStream>, (Cipher, Cipher))> {
    let rng = SystemRandom::new();
    let private = EphemeralPrivateKey::generate(&ECDH_P256, &rng).map_err(|_| "Couldn't make a pairing key.".to_string())?;
    let public = private.compute_public_key().map_err(|_| "Couldn't make a pairing key.".to_string())?;
    write_line(out, &json!({"ok": true, "pair": true, "pcId": hub.pc_id, "name": hub.pc_name(), "nonce": base64(pc_nonce), "pub": base64(public.as_ref())}))?;
    let theirs: Value = serde_json::from_str(&read_line(&mut reader)?).map_err(|_| "The phone's pairing key didn't make sense.".to_string())?;
    let their_pub = unbase64(str_field(&theirs, "pub")).filter(|p| p.len() == 65).ok_or("The phone's pairing key didn't make sense.")?;
    if !commit.is_some_and(|c| Sha256::digest(&their_pub).as_slice() == c) {
        let _ = write_line(out, &json!({"ok": false, "reason": "The pairing key didn't match what the phone promised. Pair again, and update Zazabor Link if this keeps happening."}));
        let _ = stream.shutdown(Shutdown::Both);
        return Err("A phone's pairing key didn't match its commitment; refused.".into());
    }
    let (key, code) = agreement::agree_ephemeral(private, &UnparsedPublicKey::new(&ECDH_P256, &their_pub), |z| (link_key(z, phone_nonce, pc_nonce), pair_code(z, phone_nonce, pc_nonce)))
        .map_err(|_| "The phone's pairing key didn't work.".to_string())?;
    let (up, down) = session_keys(&key, phone_nonce, pc_nonce);
    let mut tx = Cipher::new(&down);

    // The phone's verdict arrives whenever its user taps: read it on another thread, while this
    // one waits for the user here.
    let (events, verdicts) = mpsc::channel();
    stream.set_read_timeout(Some(PAIR_TIMEOUT + Duration::from_secs(5))).map_err(net_err)?;
    let phone_side = {
        let events = events.clone();
        let mut rx = Cipher::new(&up);
        std::thread::spawn(move || {
            let verdict = match read_frame(&mut reader, &mut rx) {
                Ok(Frame::Json(v)) => match str_field(&v, "t") {
                    "pair.ok" => Ok(true),
                    "pair.no" => Ok(false),
                    _ => Err("The phone answered the pairing out of turn.".to_string()),
                },
                Ok(_) => Err("The phone answered the pairing out of turn.".to_string()),
                Err(e) => Err(e),
            };
            let _ = events.send(PairEvent::Phone(verdict));
            (reader, rx)
        })
    };
    {
        let events = events.clone();
        std::thread::spawn(move || {
            if let Ok(yes) = answers.recv_timeout(PAIR_TIMEOUT) {
                let _ = events.send(PairEvent::User(yes));
            }
        });
    }
    drop(events);
    hub.show_pairing(phone_id, show_code(code));

    let deadline = Instant::now() + PAIR_TIMEOUT;
    let (mut user, mut phone) = (None, None);
    let outcome: Result<()> = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match verdicts.recv_timeout(left) {
            Ok(PairEvent::User(yes)) => {
                user = Some(yes);
                let said = write_frame(out, &mut tx, &Frame::Json(json!({"t": if yes { "pair.ok" } else { "pair.no" }})));
                if !yes {
                    break Err("You didn't pair the phone.".into());
                }
                said?;
            }
            Ok(PairEvent::Phone(Ok(yes))) => {
                phone = Some(yes);
                if !yes {
                    break Err("The phone didn't pair.".into());
                }
            }
            Ok(PairEvent::Phone(Err(e))) => break Err(e),
            Err(_) => {
                if user.is_none() {
                    let _ = write_frame(out, &mut tx, &Frame::Json(json!({"t": "pair.no"})));
                }
                break Err("Pairing timed out.".into());
            }
        }
        if user == Some(true) && phone == Some(true) {
            break Ok(());
        }
    };
    if let Err(e) = outcome {
        let _ = stream.shutdown(Shutdown::Both);
        let _ = phone_side.join();
        return Err(e);
    }
    let (reader, rx) = phone_side.join().map_err(|_| "Pairing failed.".to_string())?;
    let name = hub.pairing_name(phone_id);
    hub.with_db(|c| super::store::save_pairing(c, phone_id, &name, model, &key, crate::notes::now()))?;
    Ok((reader, (rx, tx)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(start: u8) -> Vec<u8> {
        (start..start + 16).collect()
    }

    #[test]
    fn the_test_vectors_hold() {
        let z: Vec<u8> = (0u8..32).collect();
        let (pn, cn) = (seq(0xa0), seq(0xc0));
        assert_eq!(hex(&link_key(&z, &pn, &cn)), "6e14f476f50e5be385a1cf6b0878ce8d9afd9bf12530dc6d5d5007cba3f40e7f");
        let code = pair_code(&z, &pn, &cn);
        assert_eq!(code, 910268);
        assert_eq!(show_code(code), "910 268");
        let (up, down) = session_keys(&link_key(&z, &pn, &cn), &pn, &cn);
        assert_eq!(hex(&up), "fe57135bfb34b1a6bca23d6af4898fc4700898352d76f91b830b8cfbbc86bd33");
        assert_eq!(hex(&down), "693b278d4bfe7d55f4f02a017d9f7d2053a42e25bdc02eba072d0b9d731a29e3");
        let plain = unhex("017b2274223a2270696e67227d").unwrap();
        assert_eq!(encode(&Frame::Json(json!({"t": "ping"}))), plain);
        let mut phone = Cipher::new(&up);
        let first = phone.seal(&plain);
        let second = phone.seal(&plain);
        assert_eq!(hex(&first), "7dd06ba0d697b88ef9c9f1432cd32fcc2e09f5579ab1dc3406712b94d5");
        assert_eq!(hex(&second), "770de953a6cc1b95c88cd9914e8ec5a99b8890d52c0b62237318cfa09b");
        // The PC opens them in order, and not out of order.
        let mut pc = Cipher::new(&up);
        assert_eq!(pc.open(first.clone()).unwrap(), plain);
        assert_eq!(pc.open(second).unwrap(), plain);
        assert!(Cipher::new(&up).open(unhex("770de953a6cc1b95c88cd9914e8ec5a99b8890d52c0b62237318cfa09b").unwrap()).is_err());
        assert!(Cipher::new(&down).open(first).is_err());
        assert_eq!(phone_id("00112233445566778899aabbccddeeff"), "5947d7c33d783f94b3b4c1a96ebc8991");
    }

    #[test]
    fn codes_show_six_digits() {
        assert_eq!(show_code(7), "000 007");
        assert_eq!(show_code(482913), "482 913");
    }

    #[test]
    fn frames_round_trip() {
        let (a, b) = ([1u8; 32], [1u8; 32]);
        let (mut tx, mut rx) = (Cipher::new(&a), Cipher::new(&b));
        let mut wire = Vec::new();
        write_frame(&mut wire, &mut tx, &Frame::Json(json!({"t": "status", "battery": 80}))).unwrap();
        write_frame(&mut wire, &mut tx, &Frame::Data(6, vec![9; 1000])).unwrap();
        let mut r = &wire[..];
        assert_eq!(read_frame(&mut r, &mut rx).unwrap(), Frame::Json(json!({"t": "status", "battery": 80})));
        assert_eq!(read_frame(&mut r, &mut rx).unwrap(), Frame::Data(6, vec![9; 1000]));
        // Too big for the protocol: refused before reading it.
        let mut big = ((MAX_SEALED + 1) as u32).to_be_bytes().to_vec();
        big.extend_from_slice(&[0; 32]);
        assert!(read_frame(&mut &big[..], &mut rx).is_err());
    }
}
