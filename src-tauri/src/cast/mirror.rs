//! Screen mirroring from the Zazabor Cast phone app (`ZMIR`, docs/plans/cast-receiver.md).
//!
//! The phone connects over TCP, says hello and waits while the page asks the user. Once allowed it
//! streams H.264 and AAC packets. They are muxed into MPEG-TS here and served to libVLC from a
//! local address (`http://127.0.0.1:‹port›/mirror/‹id›.ts`) whose body never ends while the phone
//! mirrors. One phone at a time: a new phone's cast replaces the one playing.

use serde::Deserialize;
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::{lock, Media, PlayState, Source, Status};

/// Tried first, so the phone app's remembered address keeps working after a restart.
const PREFERRED_PORT: u16 = 47_212;
/// How long the phone gets to say hello.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the PC may take to answer (the user is being asked).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
/// A phone that sends nothing for this long is gone (it sends frames even for a still screen).
const SILENCE_TIMEOUT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(200);
/// How often the hub is asked whether the user moved on, once mirroring.
const STATUS_EVERY: Duration = Duration::from_secs(1);
const MAX_PACKET: usize = 8 << 20;
/// What the stream keeps for its readers: from the latest key frame, up to this much. A reader
/// that falls further behind is dropped.
const MAX_BUFFER: usize = 24 << 20;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a new reader waits for the key frame it asked the phone for, before it starts from
/// the one the buffer already has (which can be up to a key frame interval old, and libVLC plays
/// at 1x, so that age would stay as delay).
const FRESH_KEY_WAIT: Duration = Duration::from_millis(500);

/// libVLC options for the stream: as little buffering as the network allows. `live-caching` and
/// `network-caching` both set the input's buffer (the stream is a live http one); `clock-synchro=0`
/// stops libVLC from re-deriving the clock from the first packets, which is where a late start's
/// delay would otherwise be kept.
const PLAYER_OPTIONS: [&str; 5] = [":network-caching=100", ":live-caching=100", ":demux=ts", ":clock-jitter=0", ":clock-synchro=0"];

/// Listens for phones; returns the TCP port.
pub fn start(generation: u64) -> Result<u16, String> {
    let phones = bind_preferred().map_err(|e| format!("can't listen for phones: {e}"))?;
    let port = phones.local_addr().map_err(|e| e.to_string())?.port();
    let player = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| format!("can't serve the stream: {e}"))?;
    let player_port = player.local_addr().map_err(|e| e.to_string())?.port();
    accept_loop("mirror-phones", phones, generation, move |stream| serve_phone(stream, generation, player_port))?;
    accept_loop("mirror-player", player, generation, move |stream| serve_player(stream, generation))?;
    Ok(port)
}

/// The preferred port, waiting a moment for a receiver that is just stopping to let go of it.
fn bind_preferred() -> io::Result<TcpListener> {
    let began = Instant::now();
    loop {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, PREFERRED_PORT)) {
            Ok(listener) => return Ok(listener),
            Err(_) if began.elapsed() < Duration::from_secs(1) => thread::sleep(Duration::from_millis(100)),
            Err(_) => return TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)),
        }
    }
}

fn accept_loop(
    name: &str,
    listener: TcpListener,
    generation: u64,
    serve: impl Fn(TcpStream) + Send + Clone + 'static,
) -> Result<(), String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let thread_name = format!("{name}-conn");
    thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            while super::alive(generation) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let serve = serve.clone();
                        let _ = thread::Builder::new().name(thread_name.clone()).spawn(move || serve(stream));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---- the phone -----------------------------------------------------------------------------

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Hello {
    name: String,
    id: String,
    audio: bool,
    sample_rate: Option<u32>,
    channels: Option<u8>,
}

/// Packet kinds and flags (phone → PC).
const KIND_VIDEO: u8 = 1;
const KIND_AUDIO: u8 = 2;
const FLAG_KEY: u8 = 1;
const FLAG_CONFIG: u8 = 2;

fn serve_phone(stream: TcpStream, generation: u64, player_port: u16) {
    let peer = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(HELLO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let Ok(read_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let mut phone = stream;

    let hello = match read_hello(&mut reader) {
        Ok(hello) => hello,
        Err(reason) => {
            answer(&mut phone, Err(&reason));
            return;
        }
    };
    let name = clean_name(&hello.name).unwrap_or_else(|| format!("Phone at {peer}"));

    let id = random_id();
    let feed = Arc::new(Feed::new(MAX_BUFFER));
    lock(&FEEDS).push((id.clone(), feed.clone()));
    let _listed = Listed(id.clone());

    let session = super::play(
        Source::Mirror,
        Media {
            url: format!("http://127.0.0.1:{player_port}/mirror/{id}.ts"),
            title: Some(format!("{name}'s screen")),
            live: true,
            options: PLAYER_OPTIONS.iter().map(|o| o.to_string()).collect(),
            sender: name,
            sender_key: trust_key(&hello.id),
            ..Default::default()
        },
    );
    if let Err(reason) = wait_for_answer(session, generation, &phone) {
        answer(&mut phone, Err(&reason));
        super::stop(session);
        return;
    }
    if !answer(&mut phone, Ok(())) {
        super::stop(session);
        return;
    }

    let _ = reader.get_ref().set_read_timeout(Some(SILENCE_TIMEOUT));
    let ended_here = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let control = {
        let (feed, ended_here, done) = (feed.clone(), ended_here.clone(), done.clone());
        thread::Builder::new()
            .name("mirror-control".into())
            .spawn(move || control_phone(phone, session, generation, &feed, &ended_here, &done))
    };

    let mut mux = TsMuxer::new(hello.audio, hello.sample_rate.unwrap_or(48_000), hello.channels.unwrap_or(2));
    while let Ok(Some(packet)) = read_packet(&mut reader) {
        if let Some(chunk) = mux.push(packet.kind, packet.flags, packet.pts_us, &packet.data) {
            feed.push(chunk.bytes, chunk.key);
        }
    }
    done.store(true, Ordering::SeqCst);
    if !ended_here.load(Ordering::SeqCst) {
        // The phone stopped mirroring.
        super::stop(session);
    }
    feed.close();
    if let Ok(control) = control {
        let _ = control.join();
    }
}

/// Talks to the phone while it mirrors: asks for key frames for new viewers, and says `bye` when
/// the PC stops the session.
fn control_phone(mut phone: TcpStream, session: u64, generation: u64, feed: &Feed, ended_here: &AtomicBool, done: &AtomicBool) {
    let mut checked = Instant::now();
    while !done.load(Ordering::SeqCst) {
        thread::sleep(POLL);
        if checked.elapsed() >= STATUS_EVERY {
            // Notices when the user played something else or closed the player.
            player_status(session);
            checked = Instant::now();
        }
        if !super::alive(generation) || !super::is_current(session) {
            ended_here.store(true, Ordering::SeqCst);
            let _ = phone.write_all(b"bye\n");
            let _ = phone.shutdown(Shutdown::Both);
            return;
        }
        if feed.want_key.swap(false, Ordering::SeqCst) && phone.write_all(b"key\n").is_err() {
            let _ = phone.shutdown(Shutdown::Both);
            return;
        }
    }
}

fn read_hello(reader: &mut impl BufRead) -> Result<Hello, String> {
    let magic = read_line(reader, 64).ok_or("no hello")?;
    if magic.trim_end() != "ZMIR/1" {
        return Err("unsupported protocol (update Zazabor Cast or Zazabor Home)".into());
    }
    let line = read_line(reader, 4096).ok_or("no hello")?;
    serde_json::from_str(&line).map_err(|e| format!("bad hello: {e}"))
}

fn read_line(reader: &mut impl BufRead, limit: u64) -> Option<String> {
    let mut line = String::new();
    match reader.take(limit).read_line(&mut line) {
        Ok(n) if n > 0 && line.ends_with('\n') => Some(line),
        _ => None,
    }
}

/// The key "Always allow" remembers for a phone. The hello's `id` is a secret the phone made
/// once (at least 128 random bits, hex); only its hash is kept, so the page's settings never hold
/// the secret. A phone without a proper secret gets a key that is never seen again, so it is asked
/// every time.
fn trust_key(id: &str) -> String {
    const MIN_SECRET_HEX: usize = 32;
    if id.len() < MIN_SECRET_HEX || id.len() > 256 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return format!("mirror:once-{}", random_id());
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, id.to_ascii_lowercase().as_bytes());
    let hex: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    format!("mirror:{}", &hex[..32])
}

/// A short, printable name; None when nothing is left.
fn clean_name(raw: &str) -> Option<String> {
    let name: String = raw.chars().filter(|c| !c.is_control()).take(64).collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Sends the PC's answer; false if the phone is gone.
fn answer(phone: &mut TcpStream, result: Result<(), &str>) -> bool {
    let line = match result {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(reason) => serde_json::json!({ "ok": false, "reason": reason }),
    };
    phone.write_all(format!("{line}\n").as_bytes()).is_ok()
}

/// Waits until the player opens the stream (the user allowed it).
fn wait_for_answer(session: u64, generation: u64, phone: &TcpStream) -> Result<(), String> {
    let began = Instant::now();
    loop {
        if !super::alive(generation) {
            return Err("Zazabor Home stopped receiving".into());
        }
        if hung_up(phone) {
            return Err("the phone hung up".into());
        }
        let status = player_status(session);
        match status.state {
            PlayState::Buffering | PlayState::Playing | PlayState::Paused => return Ok(()),
            PlayState::Loading => {}
            PlayState::Idle if status.error.as_deref() == Some("declined") => return Err("declined".into()),
            // No answer before the hub gave up on the page, or another cast took over.
            PlayState::Idle => return Err("Zazabor Home didn't open it (no answer, or another cast started)".into()),
            PlayState::Error | PlayState::Ended => {
                return Err(status.error.unwrap_or_else(|| "Zazabor Home couldn't open the stream".into()))
            }
        }
        if began.elapsed() >= ANSWER_TIMEOUT {
            return Err("nobody answered on the PC".into());
        }
        thread::sleep(POLL);
    }
}

/// The phone closed its end (it sends nothing until it has an answer).
fn hung_up(phone: &TcpStream) -> bool {
    if phone.set_nonblocking(true).is_err() {
        return true;
    }
    let result = phone.peek(&mut [0u8; 1]);
    let _ = phone.set_nonblocking(false);
    match result {
        Ok(n) => n == 0,
        Err(e) => e.kind() != io::ErrorKind::WouldBlock,
    }
}

/// The hub's view of the session (tests stand in for the page and the player).
fn player_status(session: u64) -> Status {
    #[cfg(test)]
    if let Some(status) = tests::fake_player(session) {
        return status;
    }
    super::status(session)
}

struct Packet {
    kind: u8,
    flags: u8,
    pts_us: u64,
    data: Vec<u8>,
}

/// The next packet; None when the phone closed the connection cleanly.
fn read_packet(reader: &mut impl Read) -> io::Result<Option<Packet>> {
    let mut head = [0u8; 14];
    match reader.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let pts_us = u64::from_be_bytes(head[2..10].try_into().unwrap());
    let len = u32::from_be_bytes(head[10..14].try_into().unwrap()) as usize;
    if len > MAX_PACKET {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "packet too large"));
    }
    let mut data = vec![0u8; len];
    reader.read_exact(&mut data)?;
    Ok(Some(Packet { kind: head[0], flags: head[1], pts_us, data }))
}

fn random_id() -> String {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 12];
    if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        bytes[..8].copy_from_slice(&(nanos as u64 ^ COUNTER.fetch_add(1, Ordering::SeqCst)).to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- the stream libVLC reads ---------------------------------------------------------------

/// The phones' streams by id.
static FEEDS: Mutex<Vec<(String, Arc<Feed>)>> = Mutex::new(Vec::new());

/// Takes a stream off the list (and ends it) when its phone's connection ends.
struct Listed(String);

impl Drop for Listed {
    fn drop(&mut self) {
        let mut feeds = lock(&FEEDS);
        if let Some(i) = feeds.iter().position(|(id, _)| *id == self.0) {
            feeds.remove(i).1.close();
        }
    }
}

fn find_feed(id: &str) -> Option<Arc<Feed>> {
    lock(&FEEDS).iter().find(|(i, _)| i == id).map(|(_, f)| f.clone())
}

/// One phone's MPEG-TS, shared by its readers. Chunks are kept from the latest key frame (each key
/// frame's chunk starts with PAT/PMT) so a reader that connects late starts cleanly.
struct Feed {
    inner: Mutex<FeedInner>,
    changed: Condvar,
    /// A reader connected: the phone should send a key frame.
    want_key: AtomicBool,
    max_bytes: usize,
}

#[derive(Default)]
struct FeedInner {
    chunks: VecDeque<Arc<Vec<u8>>>,
    /// The sequence number of `chunks[0]`.
    first: u64,
    bytes: usize,
    /// The sequence number of the latest chunk that starts with a key frame.
    key: Option<u64>,
    /// Reader id → the next sequence number it reads.
    readers: Vec<(u64, u64)>,
    next_reader: u64,
    closed: bool,
}

impl FeedInner {
    fn end(&self) -> u64 {
        self.first + self.chunks.len() as u64
    }
}

impl Feed {
    fn new(max_bytes: usize) -> Feed {
        Feed { inner: Mutex::new(FeedInner::default()), changed: Condvar::new(), want_key: AtomicBool::new(false), max_bytes }
    }

    fn push(&self, bytes: Vec<u8>, key: bool) {
        let mut inner = lock(&self.inner);
        let seq = inner.end();
        if key {
            inner.key = Some(seq);
        }
        inner.bytes += bytes.len();
        inner.chunks.push_back(Arc::new(bytes));
        // Forget what no reader needs and a new reader wouldn't start from, then cap the rest.
        let needed = inner.readers.iter().map(|&(_, pos)| pos).chain(inner.key).min().unwrap_or(seq);
        while inner.chunks.len() > 1 && (inner.first < needed || inner.bytes > self.max_bytes) {
            if let Some(chunk) = inner.chunks.pop_front() {
                inner.bytes -= chunk.len();
                inner.first += 1;
            }
        }
        let first = inner.first;
        // Readers that fell off the end are dropped.
        inner.readers.retain(|&(_, pos)| pos >= first);
        drop(inner);
        self.changed.notify_all();
    }

    fn close(&self) {
        lock(&self.inner).closed = true;
        self.changed.notify_all();
    }

    /// Moves `reader` to the first key frame that arrived after `since` (a `Feed::end` from when it
    /// joined), waiting up to `wait` for one. Without one the reader keeps its old start. True if
    /// it moved.
    fn restart_at_fresh_key(&self, reader: u64, since: u64, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        let mut inner = lock(&self.inner);
        loop {
            if let Some(key) = inner.key.filter(|&k| k >= since && k >= inner.first) {
                match inner.readers.iter_mut().find(|r| r.0 == reader) {
                    Some(slot) => slot.1 = key,
                    None => return false,
                }
                return true;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if inner.closed || left.is_zero() {
                return false;
            }
            inner = self.changed.wait_timeout(inner, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    /// The sequence number the next chunk gets.
    fn next_seq(&self) -> u64 {
        lock(&self.inner).end()
    }

    /// A new reader, starting at the latest key frame (or live, if it's gone).
    fn join(&self) -> u64 {
        let mut inner = lock(&self.inner);
        let start = inner.key.filter(|&k| k >= inner.first).unwrap_or_else(|| inner.end());
        let id = inner.next_reader;
        inner.next_reader += 1;
        inner.readers.push((id, start));
        id
    }

    fn leave(&self, reader: u64) {
        lock(&self.inner).readers.retain(|&(id, _)| id != reader);
    }

    /// What `reader` hasn't read yet, waiting up to `wait` for more. Err when the stream ended or
    /// the reader was dropped for falling behind.
    fn next(&self, reader: u64, wait: Duration) -> Result<Vec<Arc<Vec<u8>>>, ()> {
        let mut inner = lock(&self.inner);
        let mut waited = false;
        loop {
            let Some(slot) = inner.readers.iter().position(|&(id, _)| id == reader) else { return Err(()) };
            let pos = inner.readers[slot].1;
            let end = inner.end();
            if pos < end {
                let from = (pos - inner.first) as usize;
                let chunks = inner.chunks.range(from..).cloned().collect();
                inner.readers[slot].1 = end;
                return Ok(chunks);
            }
            if inner.closed {
                return Err(());
            }
            if waited {
                return Ok(Vec::new());
            }
            inner = self.changed.wait_timeout(inner, wait).unwrap_or_else(|e| e.into_inner()).0;
            waited = true;
        }
    }
}

/// Serves `/mirror/<id>.ts` to libVLC (127.0.0.1 only).
fn serve_player(mut stream: TcpStream, generation: u64) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let Ok(read_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let Some(request) = read_line(&mut reader, 2048) else { return };
    // Skip the headers.
    for _ in 0..100 {
        match read_line(&mut reader, 8192) {
            Some(line) if !line.trim().is_empty() => continue,
            _ => break,
        }
    }
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let feed = path
        .strip_prefix("/mirror/")
        .and_then(|p| p.strip_suffix(".ts"))
        .filter(|_| method == "GET" || method == "HEAD")
        .and_then(find_feed);
    let Some(feed) = feed else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let head = "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() || method == "HEAD" {
        return;
    }
    let _ = stream.set_nodelay(true);
    let since = feed.next_seq();
    let reader = feed.join();
    feed.want_key.store(true, Ordering::SeqCst);
    // The picture should be what the phone shows now, not up to a key frame interval ago.
    feed.restart_at_fresh_key(reader, since, FRESH_KEY_WAIT);
    while super::alive(generation) {
        match feed.next(reader, Duration::from_secs(1)) {
            Ok(chunks) => {
                if chunks.iter().any(|c| stream.write_all(c).is_err()) {
                    break;
                }
            }
            Err(()) => break,
        }
    }
    feed.leave(reader);
    let _ = stream.shutdown(Shutdown::Both);
}

// ---- MPEG-TS -------------------------------------------------------------------------------

const TS: usize = 188;
const PID_PAT: u16 = 0;
const PID_PMT: u16 = 0x1000;
const PID_VIDEO: u16 = 0x100;
const PID_AUDIO: u16 = 0x101;
const STREAM_H264: u8 = 0x1B;
const STREAM_AAC_ADTS: u8 = 0x0F;
/// The first frame's time: far enough from zero that audio a little older still fits.
const START_90K: i64 = 90_000;
/// The clock (PCR) runs this far behind the frames, so audio that arrives a little late still
/// plays. Small, because it adds to the delay.
const PCR_DELAY_90K: i64 = 9_000;
/// PAT/PMT go out with every key frame and at least this often.
const PSI_EVERY_90K: i64 = 45_000;
/// A clock reference at least this often, even while only audio arrives.
const PCR_EVERY_90K: i64 = 9_000;
const TIMESTAMP_MASK: u64 = (1 << 33) - 1;
const AUD: [u8; 6] = [0, 0, 0, 1, 0x09, 0xF0];

/// AAC as ADTS describes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AacConfig {
    /// Audio object type - 1 (1 = AAC-LC).
    profile: u8,
    frequency_index: u8,
    channels: u8,
}

const SAMPLE_RATES: [u32; 13] = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];

impl AacConfig {
    /// AAC-LC at the hello's rate and channels.
    fn lc(sample_rate: u32, channels: u8) -> AacConfig {
        let frequency_index = SAMPLE_RATES.iter().position(|&r| r == sample_rate).unwrap_or(3) as u8;
        AacConfig { profile: 1, frequency_index, channels: channels.clamp(1, 7) }
    }

    /// From an AudioSpecificConfig (the encoder's codec config).
    fn from_asc(asc: &[u8]) -> Option<AacConfig> {
        let [a, b, ..] = *asc else { return None };
        let object = a >> 3;
        let frequency_index = ((a & 7) << 1) | (b >> 7);
        let channels = (b >> 3) & 0xF;
        // ADTS has 2 bits for the profile and no room for an explicit rate.
        if !(1..=4).contains(&object) || frequency_index >= 13 || channels == 0 || channels > 7 {
            return None;
        }
        Some(AacConfig { profile: object - 1, frequency_index, channels })
    }

    fn adts_header(self, frame_len: usize) -> [u8; 7] {
        let len = frame_len + 7;
        [
            0xFF,
            0xF1, // MPEG-4, layer 0, no CRC
            (self.profile << 6) | (self.frequency_index << 2) | (self.channels >> 2),
            ((self.channels & 3) << 6) | ((len >> 11) & 3) as u8,
            (len >> 3) as u8,
            (((len & 7) as u8) << 5) | 0x1F,
            0xFC, // buffer fullness 0x7FF (variable), one raw data block
        ]
    }
}

pub(crate) struct Chunk {
    pub bytes: Vec<u8>,
    /// Starts with PAT/PMT and a key frame: a reader can start here.
    pub key: bool,
}

/// Turns the phone's packets into MPEG-TS: H.264 on one PID (which carries the clock), AAC as
/// ADTS on another.
pub(crate) struct TsMuxer {
    audio: bool,
    aac: AacConfig,
    /// SPS/PPS (Annex-B), sent again before every key frame.
    video_config: Vec<u8>,
    /// The latest SPS and PPS NAL units on their own: encoders may send them in one config
    /// packet or in two, and a lone PPS must not drop the SPS.
    sps: Vec<u8>,
    pps: Vec<u8>,
    /// The phone's timestamp of the first frame.
    base_us: Option<u64>,
    last_psi: Option<i64>,
    last_pcr: Option<i64>,
    cc: [u8; 4],
}

impl TsMuxer {
    pub fn new(audio: bool, sample_rate: u32, channels: u8) -> TsMuxer {
        TsMuxer {
            audio,
            aac: AacConfig::lc(sample_rate, channels),
            video_config: Vec::new(),
            sps: Vec::new(),
            pps: Vec::new(),
            base_us: None,
            last_psi: None,
            last_pcr: None,
            cc: [0; 4],
        }
    }

    /// One packet from the phone; None when it produces no output (codec config, or anything
    /// before the first key frame).
    pub fn push(&mut self, kind: u8, flags: u8, pts_us: u64, data: &[u8]) -> Option<Chunk> {
        let key = flags & FLAG_KEY != 0;
        match kind {
            KIND_VIDEO if flags & FLAG_CONFIG != 0 => {
                // A new SPS/PPS (also after the phone restarts its encoder, e.g. on rotation).
                for nal in nal_units(data) {
                    match nal.first().map(|b| b & 0x1F) {
                        Some(7) => self.sps = [&[0, 0, 0, 1][..], nal].concat(),
                        Some(8) => self.pps = [&[0, 0, 0, 1][..], nal].concat(),
                        _ => {}
                    }
                }
                self.video_config = [self.sps.as_slice(), self.pps.as_slice()].concat();
                None
            }
            KIND_AUDIO if flags & FLAG_CONFIG != 0 => {
                if let Some(aac) = AacConfig::from_asc(data) {
                    self.aac = aac;
                }
                None
            }
            KIND_VIDEO => {
                if self.base_us.is_none() {
                    if !key {
                        return None;
                    }
                    self.base_us = Some(pts_us);
                }
                let pts = self.time(pts_us);
                let mut out = Vec::with_capacity(data.len() + data.len() / 16 + 2 * TS);
                if key || self.last_psi.is_none_or(|t| pts - t >= PSI_EVERY_90K || pts < t) {
                    self.write_psi(&mut out);
                    self.last_psi = Some(pts);
                }
                let mut payload = Vec::with_capacity(data.len() + self.video_config.len() + AUD.len());
                if !nal_types(data).next().is_some_and(|t| t == 9) {
                    payload.extend_from_slice(&AUD);
                }
                if key && !nal_types(data).any(|t| t == 7) {
                    payload.extend_from_slice(&self.video_config);
                }
                payload.extend_from_slice(data);
                let pcr = pts - PCR_DELAY_90K;
                self.last_pcr = Some(pcr);
                self.write_pes(&mut out, PID_VIDEO, 0xE0, pts, &payload, Some(pcr), key);
                Some(Chunk { bytes: out, key })
            }
            KIND_AUDIO if self.audio && self.base_us.is_some() && !data.is_empty() => {
                let pts = self.time(pts_us);
                let mut out = Vec::with_capacity(data.len() + 2 * TS);
                let pcr = pts - PCR_DELAY_90K;
                if self.last_pcr.is_some_and(|last| pcr - last >= PCR_EVERY_90K) {
                    self.write_pcr(&mut out, pcr);
                    self.last_pcr = Some(pcr);
                }
                let mut payload = Vec::with_capacity(data.len() + 7);
                if !(data.len() >= 2 && data[0] == 0xFF && data[1] & 0xF0 == 0xF0) {
                    payload.extend_from_slice(&self.aac.adts_header(data.len()));
                }
                payload.extend_from_slice(data);
                self.write_pes(&mut out, PID_AUDIO, 0xC0, pts, &payload, None, false);
                Some(Chunk { bytes: out, key: false })
            }
            _ => None,
        }
    }

    /// The phone's microseconds as 90 kHz ticks since the first frame (plus `START_90K`).
    fn time(&self, pts_us: u64) -> i64 {
        let since = pts_us as i64 - self.base_us.unwrap_or(pts_us) as i64;
        START_90K + since * 9 / 100
    }

    fn next_cc(&mut self, pid: u16) -> u8 {
        let slot = match pid {
            PID_PAT => 0,
            PID_PMT => 1,
            PID_VIDEO => 2,
            _ => 3,
        };
        let cc = self.cc[slot];
        self.cc[slot] = (cc + 1) & 0xF;
        cc
    }

    fn write_psi(&mut self, out: &mut Vec<u8>) {
        let pat = pat_section();
        let cc = self.next_cc(PID_PAT);
        out.extend_from_slice(&psi_packet(PID_PAT, cc, &pat));
        let pmt = pmt_section(self.audio);
        let cc = self.next_cc(PID_PMT);
        out.extend_from_slice(&psi_packet(PID_PMT, cc, &pmt));
    }

    /// A packet on the clock's PID with only a PCR (no payload, so no continuity step).
    fn write_pcr(&mut self, out: &mut Vec<u8>, pcr: i64) {
        let cc = (self.cc[2] + 15) & 0xF; // the last one used
        let mut packet = [0xFFu8; TS];
        packet[0] = 0x47;
        packet[1] = (PID_VIDEO >> 8) as u8 & 0x1F;
        packet[2] = PID_VIDEO as u8;
        packet[3] = 0x20 | cc;
        packet[4] = 183;
        packet[5] = 0x10;
        packet[6..12].copy_from_slice(&pcr_bytes(pcr.max(0) as u64));
        out.extend_from_slice(&packet);
    }

    #[allow(clippy::too_many_arguments)]
    fn write_pes(&mut self, out: &mut Vec<u8>, pid: u16, stream_id: u8, pts: i64, payload: &[u8], pcr: Option<i64>, random_access: bool) {
        let pts = (pts.max(0) as u64) & TIMESTAMP_MASK;
        let mut pes = Vec::with_capacity(payload.len() + 14);
        pes.extend_from_slice(&[0, 0, 1, stream_id]);
        let length = 3 + 5 + payload.len();
        // Video may be longer than the field holds; 0 means "unbounded" there.
        let length = if stream_id == 0xE0 || length > 0xFFFF { 0 } else { length };
        pes.extend_from_slice(&(length as u16).to_be_bytes());
        pes.push(0x84); // '10', data alignment
        pes.push(0x80); // PTS only (no B-frames, so DTS = PTS)
        pes.push(5);
        pes.extend_from_slice(&timestamp_bytes(0b0010, pts));
        pes.extend_from_slice(payload);

        let mut pos = 0;
        let mut first = true;
        while pos < pes.len() {
            let mut packet = [0xFFu8; TS];
            packet[0] = 0x47;
            packet[1] = if first { 0x40 } else { 0 } | ((pid >> 8) as u8 & 0x1F);
            packet[2] = pid as u8;
            // The adaptation field, after its length byte.
            let mut field: Vec<u8> = Vec::new();
            if first && (pcr.is_some() || random_access) {
                field.push(if random_access { 0x40 } else { 0 } | if pcr.is_some() { 0x10 } else { 0 });
                if let Some(pcr) = pcr {
                    field.extend_from_slice(&pcr_bytes(pcr.max(0) as u64));
                }
            }
            let mut field_len = if field.is_empty() { 0 } else { 1 + field.len() };
            let remaining = pes.len() - pos;
            if remaining < TS - 4 - field_len {
                let stuffing = TS - 4 - field_len - remaining;
                if field.is_empty() {
                    if stuffing >= 2 {
                        field.push(0);
                        field.resize(stuffing - 1, 0xFF);
                    }
                    field_len = stuffing;
                } else {
                    field.resize(field.len() + stuffing, 0xFF);
                    field_len += stuffing;
                }
            }
            let cc = self.next_cc(pid);
            packet[3] = if field_len > 0 { 0x30 } else { 0x10 } | cc;
            if field_len > 0 {
                packet[4] = (field_len - 1) as u8;
                packet[5..4 + field_len].copy_from_slice(&field[..field_len - 1]);
            }
            let start = 4 + field_len;
            let take = TS - start;
            packet[start..].copy_from_slice(&pes[pos..pos + take]);
            pos += take;
            first = false;
            out.extend_from_slice(&packet);
        }
    }
}

/// The NAL unit types in an Annex-B buffer, in order.
/// The NAL units of an Annex-B buffer, without their start codes.
fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let mut end = starts.get(n + 1).map(|&next| next - 3).unwrap_or(data.len());
            // A 4-byte start code leaves its leading zero on the previous unit.
            while end > start && data[end - 1] == 0 {
                end -= 1;
            }
            &data[start..end]
        })
        .filter(|nal| !nal.is_empty())
        .collect()
}

fn nal_types(data: &[u8]) -> impl Iterator<Item = u8> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || {
        while i + 3 < data.len() {
            if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
                let t = data[i + 3] & 0x1F;
                i += 3;
                return Some(t);
            }
            i += 1;
        }
        None
    })
}

fn pat_section() -> Vec<u8> {
    let mut s = vec![0x00, 0xB0, 13, 0x00, 0x01, 0xC1, 0x00, 0x00];
    s.extend_from_slice(&[0x00, 0x01, 0xE0 | (PID_PMT >> 8) as u8, PID_PMT as u8]);
    let crc = crc32_mpeg(&s);
    s.extend_from_slice(&crc.to_be_bytes());
    s
}

fn pmt_section(audio: bool) -> Vec<u8> {
    let mut streams = vec![(STREAM_H264, PID_VIDEO)];
    if audio {
        streams.push((STREAM_AAC_ADTS, PID_AUDIO));
    }
    let length = 9 + 5 * streams.len() + 4;
    let mut s = vec![0x02, 0xB0 | (length >> 8) as u8, length as u8, 0x00, 0x01, 0xC1, 0x00, 0x00];
    s.extend_from_slice(&[0xE0 | (PID_VIDEO >> 8) as u8, PID_VIDEO as u8, 0xF0, 0x00]);
    for (kind, pid) in streams {
        s.extend_from_slice(&[kind, 0xE0 | (pid >> 8) as u8, pid as u8, 0xF0, 0x00]);
    }
    let crc = crc32_mpeg(&s);
    s.extend_from_slice(&crc.to_be_bytes());
    s
}

fn psi_packet(pid: u16, cc: u8, section: &[u8]) -> [u8; TS] {
    let mut packet = [0xFFu8; TS];
    packet[0] = 0x47;
    packet[1] = 0x40 | ((pid >> 8) as u8 & 0x1F);
    packet[2] = pid as u8;
    packet[3] = 0x10 | cc;
    packet[4] = 0; // pointer field
    packet[5..5 + section.len()].copy_from_slice(section);
    packet
}

/// A PTS/DTS field: 4-bit prefix, then 33 bits with marker bits.
fn timestamp_bytes(prefix: u8, ts: u64) -> [u8; 5] {
    let ts = ts & TIMESTAMP_MASK;
    [
        (prefix << 4) | (((ts >> 30) as u8 & 7) << 1) | 1,
        (ts >> 22) as u8,
        (((ts >> 15) as u8 & 0x7F) << 1) | 1,
        (ts >> 7) as u8,
        ((ts as u8 & 0x7F) << 1) | 1,
    ]
}

/// A PCR at 90 kHz (extension 0).
fn pcr_bytes(base: u64) -> [u8; 6] {
    let base = base & TIMESTAMP_MASK;
    [(base >> 25) as u8, (base >> 17) as u8, (base >> 9) as u8, (base >> 1) as u8, ((base as u8 & 1) << 7) | 0x7E, 0]
}

/// CRC-32/MPEG-2 (PSI sections).
fn crc32_mpeg(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04C1_1DB7 } else { crc << 1 };
        }
    }
    crc
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::OnceLock;

    /// Stands in for the page and the player: the state the hub would report.
    static FAKE: Mutex<Option<PlayState>> = Mutex::new(None);
    /// The tests share one receiver and the hub's one session, so they take turns.
    static TURN: Mutex<()> = Mutex::new(());

    pub(super) fn fake_player(session: u64) -> Option<Status> {
        let state = (*lock(&FAKE))?;
        let declined = lock(&super::super::SESSION).as_ref().is_some_and(|s| s.id == session && s.declined);
        let state = if super::super::is_current(session) { state } else { PlayState::Idle };
        Some(Status { state, time_ms: 0, length_ms: 0, volume: 1.0, muted: false, error: declined.then(|| "declined".into()) })
    }

    fn receiver() -> u16 {
        static PORT: OnceLock<u16> = OnceLock::new();
        *PORT.get_or_init(|| start(super::super::GENERATION.load(Ordering::SeqCst)).expect("start"))
    }

    fn next_session() -> u64 {
        super::super::NEXT_SESSION.load(Ordering::SeqCst)
    }

    /// The mirror session started at or after `from`: its id and address.
    fn wait_for_session(from: u64, timeout: Duration) -> Option<(u64, String)> {
        let began = Instant::now();
        while began.elapsed() < timeout {
            let found = lock(&super::super::SESSION)
                .as_ref()
                .filter(|s| s.id >= from && s.source == Source::Mirror)
                .map(|s| (s.id, s.media.url.clone()));
            if found.is_some() {
                return found;
            }
            thread::sleep(Duration::from_millis(20));
        }
        None
    }

    // ---- reading TS back ----

    fn packets(ts: &[u8]) -> Vec<&[u8]> {
        assert_eq!(ts.len() % TS, 0, "not whole TS packets");
        ts.chunks(TS).collect()
    }

    fn pid_of(p: &[u8]) -> u16 {
        (((p[1] & 0x1F) as u16) << 8) | p[2] as u16
    }

    fn payload_of(p: &[u8]) -> &[u8] {
        match p[3] & 0x30 {
            0x10 => &p[4..],
            0x30 => &p[5 + p[4] as usize..],
            _ => &[],
        }
    }

    /// The PES packets on `pid`, reassembled.
    fn pes_on(ts: &[u8], pid: u16) -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = Vec::new();
        for p in packets(ts).into_iter().filter(|p| pid_of(p) == pid) {
            if p[1] & 0x40 != 0 {
                out.push(Vec::new());
            }
            if let Some(last) = out.last_mut() {
                last.extend_from_slice(payload_of(p));
            }
        }
        out
    }

    fn decode_timestamp(b: &[u8]) -> u64 {
        (((b[0] >> 1) & 7) as u64) << 30 | (b[1] as u64) << 22 | ((b[2] >> 1) as u64) << 15 | (b[3] as u64) << 7 | (b[4] >> 1) as u64
    }

    #[test]
    fn crc_is_mpeg2() {
        assert_eq!(crc32_mpeg(b"123456789"), 0x0376_E6E7);
        // A section with its CRC appended checks to zero.
        assert_eq!(crc32_mpeg(&pat_section()), 0);
        assert_eq!(crc32_mpeg(&pmt_section(true)), 0);
        assert_eq!(crc32_mpeg(&pmt_section(false)), 0);
    }

    #[test]
    fn trust_keys_hash_the_phones_secret() {
        let secret = "00112233445566778899aabbccddeeff";
        let key = trust_key(secret);
        // sha256("00112233445566778899aabbccddeeff"), first 32 hex digits.
        assert_eq!(key, "mirror:5947d7c33d783f94b3b4c1a96ebc8991");
        assert!(!key.contains(secret));
        assert_eq!(trust_key(&secret.to_uppercase()), key);
        // Short, non-hex or missing ids never match a remembered phone.
        for weak in ["", "abc", "0011223344556677889", "zz112233445566778899aabbccddeeff"] {
            let once = trust_key(weak);
            assert!(once.starts_with("mirror:once-"), "{weak}");
            assert_ne!(once, trust_key(weak));
        }
    }

    #[test]
    fn pat_and_pmt() {
        let mut mux = TsMuxer::new(true, 48_000, 2);
        let mut out = Vec::new();
        mux.write_psi(&mut out);
        let ps = packets(&out);
        assert_eq!(ps.len(), 2);
        assert!(ps.iter().all(|p| p.len() == 188 && p[0] == 0x47 && p[1] & 0x40 != 0));
        assert_eq!(pid_of(ps[0]), PID_PAT);
        assert_eq!(pid_of(ps[1]), PID_PMT);
        // PAT: program 1 → PMT PID.
        let pat = &ps[0][5..5 + 3 + 13];
        assert_eq!(pat[0], 0);
        assert_eq!(((pat[10] as u16 & 0x1F) << 8) | pat[11] as u16, PID_PMT);
        assert_eq!(crc32_mpeg(pat), 0);
        // PMT: PCR on video, H.264 and AAC/ADTS.
        let len = (((ps[1][6] & 0x0F) as usize) << 8) | ps[1][7] as usize;
        let pmt = &ps[1][5..5 + 3 + len];
        assert_eq!(pmt[0], 2);
        assert_eq!(((pmt[8] as u16 & 0x1F) << 8) | pmt[9] as u16, PID_VIDEO);
        assert_eq!(pmt[12], 0x1B);
        assert_eq!(pmt[17], 0x0F);
        assert_eq!(crc32_mpeg(pmt), 0);
    }

    #[test]
    fn timestamps_round_trip() {
        for ts in [0u64, 1, 90_000, 0x1_2345_6789, TIMESTAMP_MASK] {
            let b = timestamp_bytes(0b0010, ts);
            assert_eq!(b[0] >> 4, 0b0010);
            assert_eq!(b[0] & 1, 1);
            assert_eq!(b[2] & 1, 1);
            assert_eq!(b[4] & 1, 1);
            assert_eq!(decode_timestamp(&b), ts);
        }
        assert_eq!(timestamp_bytes(0b0010, 0x1_2345_6789), [0x29, 0x8D, 0x15, 0xCF, 0x13]);
        let pcr = pcr_bytes(0x1_2345_6789);
        let base = (pcr[0] as u64) << 25 | (pcr[1] as u64) << 17 | (pcr[2] as u64) << 9 | (pcr[3] as u64) << 1 | (pcr[4] >> 7) as u64;
        assert_eq!(base, 0x1_2345_6789);
    }

    #[test]
    fn sps_and_pps_sent_apart_are_both_kept() {
        let mut mux = TsMuxer::new(false, 48_000, 2);
        let sps = [0, 0, 0, 1, 0x67, 0x42, 0, 0x1F];
        let pps = [0, 0, 0, 1, 0x68, 0xCE, 0x3C, 0x80];
        assert!(mux.push(KIND_VIDEO, FLAG_CONFIG, 0, &sps).is_none());
        assert!(mux.push(KIND_VIDEO, FLAG_CONFIG, 0, &pps).is_none());
        assert_eq!(mux.video_config, [&sps[..], &pps[..]].concat());
        // Both in one packet, as Android's MediaCodec sends them, replace both.
        let both = [0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x68, 0xEE, 0x3C];
        mux.push(KIND_VIDEO, FLAG_CONFIG, 0, &both);
        assert_eq!(mux.video_config, [&[0, 0, 0, 1, 0x67, 0x64, 0, 0x28][..], &[0, 0, 0, 1, 0x68, 0xEE, 0x3C][..]].concat());
        assert_eq!(nal_units(&both).len(), 2);
    }

    #[test]
    fn video_frames_become_pes_with_clock_and_config() {
        let mut mux = TsMuxer::new(true, 48_000, 2);
        let config = [0, 0, 0, 1, 0x67, 0x42, 0, 0x1F, 0, 0, 0, 1, 0x68, 0xCE, 0x3C, 0x80];
        assert!(mux.push(KIND_VIDEO, FLAG_CONFIG, 0, &config).is_none());
        // Nothing before the first key frame.
        assert!(mux.push(KIND_VIDEO, 0, 1_000, &[0, 0, 0, 1, 0x41, 1]).is_none());
        assert!(mux.push(KIND_AUDIO, 0, 1_000, &[1, 2, 3]).is_none());

        let base = 7_000_000_000u64;
        // Sizes that land on every stuffing case (one byte short, exact, a byte over…).
        for (i, size) in [500usize, 168, 169, 170, 183, 184, 185, 4000].into_iter().enumerate() {
            let mut frame = vec![0, 0, 0, 1, if i == 0 { 0x65 } else { 0x41 }];
            frame.resize(size, 0xAB);
            let pts = base + i as u64 * 33_333;
            let chunk = mux.push(KIND_VIDEO, if i == 0 { FLAG_KEY } else { 0 }, pts, &frame).expect("output");
            assert_eq!(chunk.key, i == 0);
            let ps = packets(&chunk.bytes);
            assert!(ps.iter().all(|p| p[0] == 0x47));
            if i == 0 {
                assert_eq!(pid_of(ps[0]), PID_PAT);
                assert_eq!(pid_of(ps[1]), PID_PMT);
            }
            let first = ps.iter().find(|p| pid_of(p) == PID_VIDEO).unwrap();
            // PCR in the first packet, random access on the key frame.
            assert_eq!(first[3] & 0x20, 0x20);
            assert_eq!(first[5] & 0x10, 0x10);
            assert_eq!(first[5] & 0x40 != 0, i == 0);
            let pes = pes_on(&chunk.bytes, PID_VIDEO);
            assert_eq!(pes.len(), 1);
            let pes = &pes[0];
            assert_eq!(&pes[..4], &[0, 0, 1, 0xE0]);
            let pts90 = decode_timestamp(&pes[9..14]);
            assert_eq!(pts90 as i64, START_90K + (i as i64 * 33_333) * 9 / 100);
            let mut want = AUD.to_vec();
            if i == 0 {
                want.extend_from_slice(&config);
            }
            want.extend_from_slice(&frame);
            assert_eq!(&pes[14..], &want[..], "frame {i} ({size} bytes)");
        }
        // Continuity counters run 0, 1, 2… per PID.
        let mut mux = TsMuxer::new(false, 48_000, 2);
        let mut all = Vec::new();
        for i in 0..20u64 {
            let frame = vec![0, 0, 1, if i % 10 == 0 { 0x65 } else { 0x41 }, 9, 9, 9].repeat(60);
            all.extend(mux.push(KIND_VIDEO, if i % 10 == 0 { FLAG_KEY } else { 0 }, i * 16_000, &frame).unwrap().bytes);
        }
        let mut last: [Option<u8>; 0x2000] = [None; 0x2000];
        for p in packets(&all) {
            let pid = pid_of(p) as usize;
            let cc = p[3] & 0xF;
            if let Some(prev) = last[pid] {
                assert_eq!(cc, (prev + 1) & 0xF, "pid {pid:#x}");
            }
            last[pid] = Some(cc);
        }
    }

    #[test]
    fn audio_gets_adts() {
        let aac = AacConfig::from_asc(&[0x11, 0x90]).unwrap(); // AAC-LC, 48 kHz, stereo
        assert_eq!(aac, AacConfig::lc(48_000, 2));
        assert_eq!(aac.adts_header(371), [0xFF, 0xF1, 0x4C, 0x80, 0x2F, 0x5F, 0xFC]);
        assert!(AacConfig::from_asc(&[0x12]).is_none());

        let mut mux = TsMuxer::new(true, 44_100, 1);
        mux.push(KIND_AUDIO, FLAG_CONFIG, 0, &[0x11, 0x90]);
        mux.push(KIND_VIDEO, FLAG_KEY, 1_000_000, &[0, 0, 0, 1, 0x65, 1]).unwrap();
        let frame = vec![0x21u8; 371];
        let chunk = mux.push(KIND_AUDIO, 0, 1_021_333, &frame).unwrap();
        let pes = pes_on(&chunk.bytes, PID_AUDIO).remove(0);
        assert_eq!(&pes[..4], &[0, 0, 1, 0xC0]);
        assert_eq!(u16::from_be_bytes([pes[4], pes[5]]) as usize, pes.len() - 6);
        assert_eq!(decode_timestamp(&pes[9..14]) as i64, START_90K + 21_333 * 9 / 100);
        assert_eq!(&pes[14..21], &aac.adts_header(371));
        assert_eq!(&pes[21..], &frame[..]);
        // A long stretch with only audio still carries a clock.
        let chunk = mux.push(KIND_AUDIO, 0, 1_300_000, &frame).unwrap();
        let first = packets(&chunk.bytes)[0];
        assert_eq!(pid_of(first), PID_VIDEO);
        assert_eq!(first[3] & 0x30, 0x20);
    }

    #[test]
    fn late_readers_start_at_a_key_frame_and_slow_ones_are_dropped() {
        let feed = Feed::new(1000);
        feed.push(vec![1; 10], false);
        feed.push(vec![2; 10], true);
        feed.push(vec![3; 10], false);
        let reader = feed.join();
        let got: Vec<u8> = feed.next(reader, Duration::ZERO).unwrap().iter().map(|c| c[0]).collect();
        assert_eq!(got, [2, 3]);
        // Before the key frame is forgotten once nobody needs it.
        assert_eq!(lock(&feed.inner).first, 1);
        // A reader that doesn't keep up is dropped when the buffer is full.
        let slow = feed.join();
        for _ in 0..200 {
            feed.push(vec![4; 10], false);
            feed.next(reader, Duration::ZERO).unwrap();
        }
        assert!(feed.next(slow, Duration::ZERO).is_err());
        assert!(feed.next(reader, Duration::ZERO).is_ok());
        assert!(lock(&feed.inner).bytes <= 1000);
        feed.close();
        assert!(feed.next(reader, Duration::ZERO).is_err());
    }

    #[test]
    fn a_new_reader_waits_for_the_key_frame_it_asked_for() {
        let feed = Arc::new(Feed::new(1000));
        feed.push(vec![1; 10], true);
        feed.push(vec![2; 10], false);
        let since = feed.next_seq();
        let reader = feed.join();
        // No fresh key frame in time: the old one stays the start.
        assert!(!feed.restart_at_fresh_key(reader, since, Duration::from_millis(30)));
        // A delta frame is no help; the key frame that follows is the start.
        let pusher = {
            let feed = feed.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(50));
                feed.push(vec![3; 10], false);
                feed.push(vec![4; 10], true);
                feed.push(vec![5; 10], false);
            })
        };
        assert!(feed.restart_at_fresh_key(reader, since, Duration::from_secs(5)));
        pusher.join().unwrap();
        let got: Vec<u8> = feed.next(reader, Duration::ZERO).unwrap().iter().map(|c| c[0]).collect();
        assert_eq!(got, [4, 5]);
        // A reader that already has a key frame newer than `since` moves at once.
        let late = feed.join();
        assert!(feed.restart_at_fresh_key(late, since, Duration::ZERO));
    }

    // ---- the protocol, end to end ----

    struct Phone {
        stream: TcpStream,
        lines: BufReader<TcpStream>,
    }

    impl Phone {
        fn connect(port: u16, hello: serde_json::Value) -> Phone {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            stream.write_all(format!("ZMIR/1\n{hello}\n").as_bytes()).unwrap();
            let lines = BufReader::new(stream.try_clone().unwrap());
            Phone { stream, lines }
        }

        fn line(&mut self) -> String {
            let mut line = String::new();
            self.lines.read_line(&mut line).unwrap();
            line.trim_end().to_string()
        }

        fn send(&mut self, kind: u8, flags: u8, pts_us: u64, data: &[u8]) {
            let mut packet = vec![kind, flags];
            packet.extend_from_slice(&pts_us.to_be_bytes());
            packet.extend_from_slice(&(data.len() as u32).to_be_bytes());
            packet.extend_from_slice(data);
            self.stream.write_all(&packet).unwrap();
        }
    }

    /// Reads the stream the way libVLC would, until it ends or `limit` passes.
    fn play(url: &str, limit: Duration) -> thread::JoinHandle<Vec<u8>> {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_at(rest.find('/').unwrap());
        let mut stream = TcpStream::connect(host).unwrap();
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nIcy-MetaData: 1\r\n\r\n").as_bytes()).unwrap();
        stream.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        thread::spawn(move || {
            let began = Instant::now();
            let mut body = Vec::new();
            let mut buf = [0u8; 65536];
            while began.elapsed() < limit {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => body.extend_from_slice(&buf[..n]),
                    Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
                    Err(_) => break,
                }
            }
            let head = body.windows(4).position(|w| w == b"\r\n\r\n").expect("an HTTP head") + 4;
            assert!(String::from_utf8_lossy(&body[..head]).contains("video/mp2t"));
            body.split_off(head)
        })
    }

    #[test]
    fn declined_and_hung_up() {
        let _turn = lock(&TURN);
        let port = receiver();

        *lock(&FAKE) = Some(PlayState::Loading);
        let from = next_session();
        let mut phone = Phone::connect(port, serde_json::json!({"name": "Pixel 7", "id": "abc", "audio": false}));
        let (session, url) = wait_for_session(from, Duration::from_secs(5)).unwrap();
        assert!(url.starts_with("http://127.0.0.1:") && url.ends_with(".ts"));
        let options = super::super::media_options(&url);
        assert_eq!(options, PLAYER_OPTIONS.map(String::from).to_vec(), "the stream plays with the low-latency options");
        {
            let slot = lock(&super::super::SESSION);
            let s = slot.as_ref().unwrap();
            assert_eq!(s.media.title.as_deref(), Some("Pixel 7's screen"));
            // "abc" is no secret: this phone gets asked every time.
            assert!(s.media.sender_key.starts_with("mirror:once-"));
            assert!(s.media.live);
        }
        super::super::cast_decline(session);
        assert_eq!(phone.line(), r#"{"ok":false,"reason":"declined"}"#);

        // Allowed, then the phone hangs up: the session ends and so does the stream.
        *lock(&FAKE) = Some(PlayState::Playing);
        let from = next_session();
        let mut phone = Phone::connect(port, serde_json::json!({"name": "Pixel 7", "id": "abc", "audio": false}));
        assert_eq!(phone.line(), r#"{"ok":true}"#);
        let (session, url) = wait_for_session(from, Duration::from_secs(5)).unwrap();
        let player = play(&url, Duration::from_secs(10));
        assert_eq!(phone.line(), "key");
        phone.send(KIND_VIDEO, FLAG_CONFIG, 0, &[0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2]);
        phone.send(KIND_VIDEO, FLAG_KEY, 10, &[0, 0, 0, 1, 0x65, 3, 4, 5]);
        thread::sleep(Duration::from_millis(300));
        drop(phone);
        let body = player.join().unwrap();
        assert!(!body.is_empty() && body.len() % TS == 0);
        assert!(!super::super::is_current(session));
    }

    // ---- a real stream through ffmpeg ----

    fn tool(name: &str) -> bool {
        Command::new(name).arg("-version").output().is_ok_and(|o| o.status.success())
    }

    fn ffmpeg(args: &[&str]) -> bool {
        Command::new("ffmpeg").args(["-hide_banner", "-v", "error", "-y"]).args(args).status().is_ok_and(|s| s.success())
    }

    fn ffprobe(args: &[&str]) -> String {
        let out = Command::new("ffprobe").args(["-hide_banner", "-v", "error"]).args(args).output().unwrap();
        assert!(out.status.success(), "ffprobe {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    fn scratch() -> PathBuf {
        let dir = std::env::var_os("ZMIR_TEST_DIR").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("zmir-test"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A test card as raw H.264 (whichever encoder this ffmpeg has).
    fn h264_clip(dir: &Path, name: &str, size: &str, seconds: &str) -> Vec<u8> {
        let path = dir.join(name);
        let path = path.to_str().unwrap();
        let source = format!("testsrc=size={size}:rate=30");
        let encoders = Command::new("ffmpeg").args(["-hide_banner", "-encoders"]).output().unwrap().stdout;
        let encoders = String::from_utf8_lossy(&encoders);
        let made = ["libx264", "libopenh264"].iter().filter(|c| encoders.contains(&format!(" {c} "))).any(|codec| {
            ffmpeg(&["-f", "lavfi", "-i", &source, "-t", seconds, "-c:v", codec, "-g", "30", "-bf", "0", "-b:v", "2M", "-pix_fmt", "yuv420p", "-f", "h264", path])
        });
        assert!(made, "no H.264 encoder in ffmpeg");
        std::fs::read(path).unwrap()
    }

    /// Annex-B → (codec config, access units with their key flag), the way MediaCodec hands
    /// them out: SPS/PPS separately, frames without them.
    fn access_units(stream: &[u8]) -> (Vec<u8>, Vec<(bool, Vec<u8>)>) {
        let mut starts = Vec::new();
        let mut i = 0;
        while i + 3 <= stream.len() {
            if stream[i..i + 3] == [0, 0, 1] {
                starts.push(if i > 0 && stream[i - 1] == 0 { i - 1 } else { i });
                i += 3;
            } else {
                i += 1;
            }
        }
        let nals: Vec<&[u8]> = starts.iter().enumerate().map(|(n, &s)| &stream[s..*starts.get(n + 1).unwrap_or(&stream.len())]).collect();
        let kind = |nal: &[u8]| nal[nal.iter().position(|&b| b == 1).unwrap() + 1] & 0x1F;
        let first_mb_zero = |nal: &[u8]| nal[nal.iter().position(|&b| b == 1).unwrap() + 2] & 0x80 != 0;
        let mut config = Vec::new();
        let mut units: Vec<(bool, Vec<u8>)> = Vec::new();
        let mut current: Option<(bool, Vec<u8>, bool)> = None; // key, bytes, has a slice
        for nal in nals {
            let t = kind(nal);
            let starts_unit = matches!(t, 6..=9) || ((t == 1 || t == 5) && first_mb_zero(nal));
            if starts_unit && current.as_ref().is_some_and(|c| c.2) {
                let (key, bytes, _) = current.take().unwrap();
                units.push((key, bytes));
            }
            if t == 7 || t == 8 {
                if units.is_empty() && current.as_ref().is_none_or(|c| !c.2) {
                    config.extend_from_slice(nal);
                }
                continue;
            }
            if t == 9 {
                continue;
            }
            let unit = current.get_or_insert_with(|| (false, Vec::new(), false));
            unit.1.extend_from_slice(nal);
            if t == 1 || t == 5 {
                unit.2 = true;
                unit.0 |= t == 5;
            }
        }
        if let Some((key, bytes, _)) = current {
            units.push((key, bytes));
        }
        (config, units)
    }

    /// ADTS → (AudioSpecificConfig, raw AAC frames).
    fn aac_frames(adts: &[u8]) -> (Vec<u8>, Vec<Vec<u8>>) {
        let mut frames = Vec::new();
        let mut i = 0;
        let mut asc = Vec::new();
        while i + 7 <= adts.len() {
            assert_eq!(adts[i], 0xFF);
            let header = if adts[i + 1] & 1 == 1 { 7 } else { 9 };
            let len = ((adts[i + 3] as usize & 3) << 11) | (adts[i + 4] as usize) << 3 | (adts[i + 5] as usize) >> 5;
            if asc.is_empty() {
                let object = (adts[i + 2] >> 6) + 1;
                let freq = (adts[i + 2] >> 2) & 0xF;
                let channels = ((adts[i + 2] & 1) << 2) | (adts[i + 3] >> 6);
                asc = vec![(object << 3) | (freq >> 1), ((freq & 1) << 7) | (channels << 3)];
            }
            frames.push(adts[i + header..i + len].to_vec());
            i += len;
        }
        (asc, frames)
    }

    #[test]
    fn a_phone_stream_plays_through_ffmpeg() {
        if !tool("ffmpeg") || !tool("ffprobe") {
            eprintln!("skipped: ffmpeg and ffprobe aren't on PATH");
            return;
        }
        let _turn = lock(&TURN);
        let dir = scratch();
        // Landscape, then the phone turns: the encoder restarts at a new size.
        let wide = h264_clip(&dir, "wide.h264", "640x360", "3");
        let tall = h264_clip(&dir, "tall.h264", "360x640", "2");
        let aac = dir.join("tone.aac");
        assert!(ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-ac", "2", "-t", "5", "-c:a", "aac", "-b:a", "128k", "-f", "adts", aac.to_str().unwrap()]));
        let (asc, audio) = aac_frames(&std::fs::read(&aac).unwrap());
        assert_eq!(AacConfig::from_asc(&asc), Some(AacConfig::lc(48_000, 2)));

        // The phone's packets, in time order.
        let base = 123_456_000_000u64;
        let mut packets: Vec<(u64, u8, u8, Vec<u8>)> = Vec::new();
        let mut frame = 0u64;
        for clip in [&wide, &tall] {
            let (config, units) = access_units(clip);
            assert!(!config.is_empty() && units[0].0);
            let pts = base + frame * 1_000_000 / 30;
            packets.push((pts, KIND_VIDEO, FLAG_CONFIG, config));
            for (key, unit) in units {
                packets.push((base + frame * 1_000_000 / 30, KIND_VIDEO, if key { FLAG_KEY } else { 0 }, unit));
                frame += 1;
            }
        }
        let video_frames = frame;
        packets.push((base, KIND_AUDIO, FLAG_CONFIG, asc));
        for (n, data) in audio.iter().enumerate() {
            packets.push((base + n as u64 * 1024 * 1_000_000 / 48_000 + 20_000, KIND_AUDIO, 0, data.clone()));
        }
        packets.sort_by_key(|p| (p.0, p.2 & FLAG_CONFIG == 0));

        *lock(&FAKE) = Some(PlayState::Playing);
        let from = next_session();
        let mut phone = Phone::connect(receiver(), serde_json::json!({"name": "Test phone", "id": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "audio": true, "sampleRate": 48000, "channels": 2}));
        assert_eq!(phone.line(), r#"{"ok":true}"#);
        let (session, url) = wait_for_session(from, Duration::from_secs(5)).unwrap();
        let player = play(&url, Duration::from_secs(30));
        assert_eq!(phone.line(), "key");
        for (pts, kind, flags, data) in &packets {
            phone.send(*kind, *flags, *pts, data);
        }
        thread::sleep(Duration::from_millis(800));
        // The user stops it on the PC: the phone hears `bye`.
        super::super::stop(session);
        let mut said = Vec::new();
        loop {
            let line = phone.line();
            if line.is_empty() || line == "bye" {
                said.push(line);
                break;
            }
            said.push(line);
        }
        assert_eq!(said.last().map(String::as_str), Some("bye"), "{said:?}");
        let ts = player.join().unwrap();
        let out = dir.join("mirror.ts");
        std::fs::write(&out, &ts).unwrap();
        let out = out.to_str().unwrap();

        let streams = ffprobe(&["-show_entries", "stream=codec_name,width,height,sample_rate,channels", "-of", "compact", out]);
        eprintln!("{streams}");
        assert!(streams.contains("codec_name=h264") && streams.contains("codec_name=aac"), "{streams}");
        assert!(streams.contains("sample_rate=48000") && streams.contains("channels=2"), "{streams}");
        let sizes = ffprobe(&["-select_streams", "v", "-show_entries", "frame=width,height", "-of", "csv=p=0", out]);
        let wide_frames = sizes.lines().filter(|l| *l == "640,360").count() as u64;
        let tall_frames = sizes.lines().filter(|l| *l == "360,640").count() as u64;
        eprintln!("video frames: {wide_frames} at 640x360, {tall_frames} at 360x640 (sent {video_frames})");
        assert!(wide_frames >= 88 && tall_frames >= 58, "{wide_frames} + {tall_frames}");
        let audio_frames = ffprobe(&["-select_streams", "a", "-show_entries", "frame=pts_time", "-of", "csv=p=0", out]).lines().count();
        eprintln!("audio frames: {audio_frames} (sent {})", audio.len());
        assert!(audio_frames + 2 >= audio.len(), "{audio_frames}");
        // Decodes without errors, and a frame from each half for a look.
        let errors = Command::new("ffmpeg").args(["-hide_banner", "-v", "error", "-i", out, "-f", "null", "-"]).output().unwrap();
        assert!(errors.status.success());
        let errors = String::from_utf8_lossy(&errors.stderr);
        assert!(errors.trim().is_empty(), "{errors}");
        for (at, name) in [("1.5", "wide.png"), ("4.0", "tall.png")] {
            assert!(ffmpeg(&["-ss", at, "-i", out, "-frames:v", "1", dir.join(name).to_str().unwrap()]));
        }
        eprintln!("wrote {out}");
    }

    /// For trying the phone app: `ZMIR_SECONDS=5 ZMIR_OUT=/tmp/phone.ts cargo test --lib
    /// cast::mirror::tests::serve_for_a_phone -- --ignored --nocapture`, then mirror to this PC
    /// (port printed). Allows the phone and records its stream like libVLC would.
    #[test]
    #[ignore]
    fn serve_for_a_phone() {
        let _turn = lock(&TURN);
        *lock(&FAKE) = Some(PlayState::Playing);
        let from = next_session();
        let port = receiver();
        eprintln!("waiting for a phone on port {port}");
        let (session, url) = wait_for_session(from, Duration::from_secs(600)).expect("no phone came");
        eprintln!("session {session}: {url}");
        let seconds = std::env::var("ZMIR_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(5);
        let ts = play(&url, Duration::from_secs(seconds)).join().unwrap();
        let out = std::env::var_os("ZMIR_OUT").map(PathBuf::from).unwrap_or_else(|| scratch().join("phone.ts"));
        std::fs::write(&out, &ts).unwrap();
        eprintln!("recorded {} bytes to {}", ts.len(), out.display());
        let linger = std::env::var("ZMIR_LINGER").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
        thread::sleep(Duration::from_secs(linger));
        super::super::stop(session);
        thread::sleep(Duration::from_millis(500));
    }
}
