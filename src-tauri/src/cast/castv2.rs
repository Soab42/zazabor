//! The Cast v2 receiver: Zazabor as a "Chromecast" for VLC's "Play on…" (Android and desktop).
//!
//! A phone connects over TLS (port 8009, a self-signed certificate made at startup; VLC doesn't
//! check it), then speaks length-prefixed protobuf `CastMessage`s with JSON payloads. We answer the
//! device-auth challenge with dummy bytes (VLC only checks that a response came), pretend to run
//! the Default Media Receiver app (CC1AD845), and turn its media commands into the hub's session.
//! See docs/plans/cast-receiver.md for the exchange VLC expects.
//!
//! Google's own senders (YouTube, Chrome, Android's screen cast) verify the device certificate,
//! so they never list Zazabor; YouTube comes in through DIAL instead.

use openssl::ssl::{SslAcceptor, SslMethod, SslStream};
use serde_json::{json, Value};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use super::{Media, PlayState, Source};

pub const PORT: u16 = 8009;
const MAX_MESSAGE: usize = 64 * 1024;
const READ_TICK: Duration = Duration::from_millis(250);
const PING_EVERY: Duration = Duration::from_secs(5);
/// No word from the phone for this long: it's gone.
const SILENCE: Duration = Duration::from_secs(20);
const STATUS_EVERY: Duration = Duration::from_millis(1000);

const NS_AUTH: &str = "urn:x-cast:com.google.cast.tp.deviceauth";
const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";
const RECEIVER_ID: &str = "receiver-0";
/// The Default Media Receiver, the app VLC launches.
const MEDIA_APP: &str = "CC1AD845";
/// PAUSE | SEEK | STREAM_VOLUME | STREAM_MUTE.
const MEDIA_COMMANDS: u32 = 15;

static NEXT_MEDIA_SESSION: AtomicI64 = AtomicI64::new(1);

// ---- protobuf ------------------------------------------------------------------------------

/// A `CastMessage` (cast_channel.proto). Exactly one payload is set.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Message {
    pub source: String,
    pub destination: String,
    pub namespace: String,
    pub text: Option<String>,
    pub binary: Option<Vec<u8>>,
}

impl Message {
    fn text(source: &str, destination: &str, namespace: &str, payload: &Value) -> Message {
        Message { source: source.into(), destination: destination.into(), namespace: namespace.into(), text: Some(payload.to_string()), binary: None }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_varint_field(&mut out, 1, 0);
        put_bytes_field(&mut out, 2, self.source.as_bytes());
        put_bytes_field(&mut out, 3, self.destination.as_bytes());
        put_bytes_field(&mut out, 4, self.namespace.as_bytes());
        match (&self.text, &self.binary) {
            (_, Some(binary)) => {
                put_varint_field(&mut out, 5, 1);
                put_bytes_field(&mut out, 7, binary);
            }
            (text, None) => {
                put_varint_field(&mut out, 5, 0);
                put_bytes_field(&mut out, 6, text.as_deref().unwrap_or("").as_bytes());
            }
        }
        out
    }

    pub fn decode(data: &[u8]) -> Option<Message> {
        let mut m = Message::default();
        let mut binary_type = false;
        let mut text = None;
        let mut binary = None;
        for (field, value) in fields(data)? {
            match (field, value) {
                (2, Field::Bytes(b)) => m.source = String::from_utf8_lossy(b).into_owned(),
                (3, Field::Bytes(b)) => m.destination = String::from_utf8_lossy(b).into_owned(),
                (4, Field::Bytes(b)) => m.namespace = String::from_utf8_lossy(b).into_owned(),
                (5, Field::Varint(v)) => binary_type = v == 1,
                (6, Field::Bytes(b)) => text = Some(String::from_utf8_lossy(b).into_owned()),
                (7, Field::Bytes(b)) => binary = Some(b.to_vec()),
                _ => {}
            }
        }
        if binary_type {
            m.binary = Some(binary.unwrap_or_default());
        } else {
            m.text = Some(text.unwrap_or_default());
        }
        Some(m)
    }

    fn json(&self) -> Value {
        self.text.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null)
    }
}

enum Field<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

fn fields(mut data: &[u8]) -> Option<Vec<(u64, Field<'_>)>> {
    let mut out = Vec::new();
    while !data.is_empty() {
        let key = take_varint(&mut data)?;
        let field = key >> 3;
        match key & 7 {
            0 => out.push((field, Field::Varint(take_varint(&mut data)?))),
            1 => data = data.get(8..)?,
            2 => {
                let len = usize::try_from(take_varint(&mut data)?).ok()?;
                let bytes = data.get(..len)?;
                data = &data[len..];
                out.push((field, Field::Bytes(bytes)));
            }
            5 => data = data.get(4..)?,
            _ => return None,
        }
    }
    Some(out)
}

fn take_varint(data: &mut &[u8]) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let (&byte, rest) = data.split_first()?;
        *data = rest;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn put_varint_field(out: &mut Vec<u8>, field: u64, value: u64) {
    put_varint(out, field << 3);
    put_varint(out, value);
}

fn put_bytes_field(out: &mut Vec<u8>, field: u64, bytes: &[u8]) {
    put_varint(out, field << 3 | 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

/// `DeviceAuthMessage { response: AuthResponse { signature, client_auth_certificate } }`. Senders
/// that verify it (Google's) will reject these bytes; VLC only checks the response is there.
fn auth_response() -> Vec<u8> {
    let mut response = Vec::new();
    put_bytes_field(&mut response, 1, &[0u8; 256]);
    put_bytes_field(&mut response, 2, b"zazabor");
    let mut out = Vec::new();
    put_bytes_field(&mut out, 2, &response);
    out
}

// ---- TLS -----------------------------------------------------------------------------------

fn acceptor() -> Result<Arc<SslAcceptor>, String> {
    static ACCEPTOR: OnceLock<Result<Arc<SslAcceptor>, String>> = OnceLock::new();
    ACCEPTOR.get_or_init(|| make_acceptor().map(Arc::new).map_err(|e| format!("TLS: {e}"))).clone()
}

fn make_acceptor() -> Result<SslAcceptor, openssl::error::ErrorStack> {
    use openssl::{asn1::Asn1Time, bn::BigNum, hash::MessageDigest, pkey::PKey, rsa::Rsa, x509::X509NameBuilder, x509::X509};
    let key = PKey::from_rsa(Rsa::generate(2048)?)?;
    let mut name = X509NameBuilder::new()?;
    name.append_entry_by_text("CN", "Zazabor")?;
    let name = name.build();
    let mut cert = X509::builder()?;
    cert.set_version(2)?;
    cert.set_serial_number(&*BigNum::from_u32(1)?.to_asn1_integer()?)?;
    cert.set_subject_name(&name)?;
    cert.set_issuer_name(&name)?;
    cert.set_pubkey(&key)?;
    cert.set_not_before(&*Asn1Time::days_from_now(0)?)?;
    cert.set_not_after(&*Asn1Time::days_from_now(3650)?)?;
    cert.sign(&key, MessageDigest::sha256())?;
    let cert = cert.build();
    let mut builder = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls())?;
    builder.set_private_key(&key)?;
    builder.set_certificate(&cert)?;
    builder.check_private_key()?;
    Ok(builder.build())
}

// ---- server --------------------------------------------------------------------------------

/// Listens for Cast senders; returns the port (8009 unless it is taken).
pub fn start(generation: u64) -> Result<u16, String> {
    let acceptor = acceptor()?;
    let listener = TcpListener::bind(("0.0.0.0", PORT))
        .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
        .map_err(|e| format!("could not listen: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("cast-v2".into())
        .spawn(move || {
            while super::alive(generation) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let acceptor = acceptor.clone();
                        let _ = std::thread::Builder::new().name("cast-v2-conn".into()).spawn(move || {
                            if let Err(e) = serve(&acceptor, stream, generation) {
                                eprintln!("cast: connection ended: {e}");
                            }
                        });
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
                    Err(_) => std::thread::sleep(Duration::from_millis(500)),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(port)
}

/// The pretend Default Media Receiver, once a phone launched it.
struct App {
    session_id: String,
    transport_id: String,
}

/// What a LOAD started.
struct Loaded {
    media_session: i64,
    cast: u64,
    /// The sender to send unprompted MEDIA_STATUS to.
    sender: String,
    media: Value,
    last: Option<(PlayState, bool, i64)>,
}

struct Conn {
    peer: IpAddr,
    app: Option<App>,
    loaded: Option<Loaded>,
    /// The user turned this phone away; later LOADs (VLC retries with other settings) fail at once.
    declined: bool,
    /// The sender ids that said CONNECT, for PINGs.
    senders: Vec<String>,
}

fn serve(acceptor: &SslAcceptor, stream: TcpStream, generation: u64) -> Result<(), String> {
    let peer = stream.peer_addr().map_err(|e| e.to_string())?.ip();
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    let mut tls = acceptor.accept(stream).map_err(|e| format!("handshake: {e}"))?;
    tls.get_ref().set_read_timeout(Some(READ_TICK)).map_err(|e| e.to_string())?;
    let mut conn = Conn { peer, app: None, loaded: None, declined: false, senders: Vec::new() };
    let result = run(&mut conn, &mut tls, generation);
    // The phone went away (or the receiver stopped): a cast it started stops with it.
    if let Some(loaded) = conn.loaded.take() {
        if super::is_current(loaded.cast) {
            super::stop(loaded.cast);
        }
    }
    let _ = tls.shutdown();
    result
}

fn run(conn: &mut Conn, tls: &mut SslStream<TcpStream>, generation: u64) -> Result<(), String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut heard = Instant::now();
    let mut pinged = Instant::now();
    let mut reported = Instant::now();
    while super::alive(generation) {
        match tls.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                heard = Instant::now();
                buf.extend_from_slice(&chunk[..n]);
                while let Some(message) = take_frame(&mut buf)? {
                    for reply in handle(conn, &message) {
                        send(tls, &reply)?;
                    }
                }
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
            Err(e) => return Err(e.to_string()),
        }
        if heard.elapsed() > SILENCE {
            return Err("the phone went quiet".into());
        }
        if pinged.elapsed() >= PING_EVERY {
            pinged = Instant::now();
            let to = conn.senders.first().cloned().unwrap_or_else(|| "sender-0".into());
            send(tls, &Message::text(RECEIVER_ID, &to, NS_HEARTBEAT, &json!({"type": "PING"})))?;
        }
        if reported.elapsed() >= STATUS_EVERY {
            reported = Instant::now();
            if let Some(update) = status_update(conn) {
                send(tls, &update)?;
            }
        }
    }
    Ok(())
}

/// Takes one complete frame (u32 BE length + message) off the front of `buf`.
fn take_frame(buf: &mut Vec<u8>) -> Result<Option<Message>, String> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_MESSAGE {
        return Err("message too large".into());
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    let message = Message::decode(&buf[4..4 + len]).ok_or("bad message")?;
    buf.drain(..4 + len);
    Ok(Some(message))
}

fn send(tls: &mut SslStream<TcpStream>, message: &Message) -> Result<(), String> {
    let body = message.encode();
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(&body);
    tls.write_all(&frame).map_err(|e| e.to_string())
}

// ---- the conversation ----------------------------------------------------------------------

fn handle(conn: &mut Conn, message: &Message) -> Vec<Message> {
    let payload = message.json();
    let kind = payload["type"].as_str().unwrap_or("");
    let request_id = payload["requestId"].as_i64().unwrap_or(0);
    let reply = |namespace: &str, body: Value| Message::text(&message.destination, &message.source, namespace, &body);
    match message.namespace.as_str() {
        NS_AUTH => vec![Message { source: message.destination.clone(), destination: message.source.clone(), namespace: NS_AUTH.into(), text: None, binary: Some(auth_response()) }],
        NS_CONNECTION => {
            match kind {
                "CONNECT" if !conn.senders.contains(&message.source) => conn.senders.push(message.source.clone()),
                "CLOSE" if conn.app.as_ref().is_some_and(|a| a.transport_id == message.destination) => {
                    // The phone left the app; the cast it started stops with it.
                    if let Some(loaded) = conn.loaded.take() {
                        super::stop(loaded.cast);
                    }
                }
                _ => {}
            }
            Vec::new()
        }
        NS_HEARTBEAT if kind == "PING" => vec![reply(NS_HEARTBEAT, json!({"type": "PONG"}))],
        NS_HEARTBEAT => Vec::new(),
        NS_RECEIVER => receiver_message(conn, kind, request_id, &payload, &reply),
        NS_MEDIA => media_message(conn, message, kind, request_id, &payload, &reply),
        _ => Vec::new(),
    }
}

fn receiver_message(conn: &mut Conn, kind: &str, request_id: i64, payload: &Value, reply: &dyn Fn(&str, Value) -> Message) -> Vec<Message> {
    match kind {
        "GET_STATUS" => vec![reply(NS_RECEIVER, receiver_status(conn, request_id))],
        "LAUNCH" => {
            if payload["appId"].as_str() != Some(MEDIA_APP) {
                return vec![reply(NS_RECEIVER, json!({"type": "LAUNCH_ERROR", "reason": "NOT_FOUND", "requestId": request_id}))];
            }
            if conn.app.is_none() {
                let n = NEXT_MEDIA_SESSION.fetch_add(1, Ordering::SeqCst);
                conn.app = Some(App { session_id: format!("zazabor-{:x}-{n}", std::process::id()), transport_id: format!("zazabor-media-{n}") });
            }
            vec![reply(NS_RECEIVER, receiver_status(conn, request_id))]
        }
        "STOP" => {
            conn.app = None;
            if let Some(loaded) = conn.loaded.take() {
                super::stop(loaded.cast);
            }
            vec![reply(NS_RECEIVER, receiver_status(conn, request_id))]
        }
        "SET_VOLUME" => {
            set_volume(conn, &payload["volume"]);
            vec![reply(NS_RECEIVER, receiver_status(conn, request_id))]
        }
        "GET_APP_AVAILABILITY" => {
            let ids: Vec<&str> = payload["appId"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
            let availability: serde_json::Map<String, Value> =
                ids.iter().map(|id| (id.to_string(), json!(if *id == MEDIA_APP { "APP_AVAILABLE" } else { "APP_UNAVAILABLE" }))).collect();
            vec![reply(NS_RECEIVER, json!({"type": "GET_APP_AVAILABILITY", "requestId": request_id, "responseType": "GET_APP_AVAILABILITY", "availability": availability}))]
        }
        _ => vec![reply(NS_RECEIVER, json!({"type": "INVALID_REQUEST", "reason": "INVALID_COMMAND", "requestId": request_id}))],
    }
}

fn receiver_status(conn: &Conn, request_id: i64) -> Value {
    let (volume, muted) = current_volume();
    let applications: Vec<Value> = conn
        .app
        .iter()
        .map(|app| {
            json!({
                "appId": MEDIA_APP,
                "displayName": "Default Media Receiver",
                "isIdleScreen": false,
                "namespaces": [{"name": NS_MEDIA}],
                "sessionId": app.session_id,
                "statusText": "Zazabor Home",
                "transportId": app.transport_id,
            })
        })
        .collect();
    json!({
        "type": "RECEIVER_STATUS",
        "requestId": request_id,
        "status": {
            "applications": applications,
            "isActiveInput": true,
            "isStandBy": false,
            "volume": {"controlType": "attenuation", "level": volume, "muted": muted, "stepInterval": 0.05},
        }
    })
}

fn current_volume() -> (f64, bool) {
    let state = crate::video::control::state();
    let (volume, muted) = crate::video::control::volume(&state);
    (volume.min(1.0), muted)
}

fn set_volume(conn: &Conn, volume: &Value) {
    let Some(loaded) = &conn.loaded else { return };
    if let Some(level) = volume["level"].as_f64() {
        super::set_volume(loaded.cast, level);
    }
    if let Some(muted) = volume["muted"].as_bool() {
        super::set_muted(loaded.cast, muted);
    }
}

fn media_message(conn: &mut Conn, message: &Message, kind: &str, request_id: i64, payload: &Value, reply: &dyn Fn(&str, Value) -> Message) -> Vec<Message> {
    let status = |conn: &mut Conn| reply(NS_MEDIA, media_status(conn, request_id));
    match kind {
        "LOAD" => {
            if conn.declined {
                return vec![reply(NS_MEDIA, json!({"type": "LOAD_FAILED", "requestId": request_id}))];
            }
            let media = payload["media"].clone();
            let Some(url) = media["contentId"].as_str().or(media["contentUrl"].as_str()).filter(|u| u.starts_with("http")) else {
                return vec![reply(NS_MEDIA, json!({"type": "LOAD_FAILED", "requestId": request_id}))];
            };
            let previous = conn.loaded.take();
            let cast = super::play(Source::Cast, media_from(&media, url, payload, &message.source, conn.peer));
            // A new LOAD (VLC seeks this way) replaces the old one without stopping the player.
            drop(previous);
            conn.loaded = Some(Loaded { media_session: NEXT_MEDIA_SESSION.fetch_add(1, Ordering::SeqCst), cast, sender: message.source.clone(), media, last: None });
            vec![status(conn)]
        }
        "PLAY" | "PAUSE" => {
            if let Some(loaded) = &conn.loaded {
                super::set_paused(loaded.cast, kind == "PAUSE");
            }
            vec![status(conn)]
        }
        "SEEK" => {
            if let (Some(loaded), Some(time)) = (&conn.loaded, payload["currentTime"].as_f64()) {
                super::seek(loaded.cast, (time * 1000.0) as i64);
            }
            vec![status(conn)]
        }
        "STOP" => {
            if let Some(loaded) = &conn.loaded {
                super::stop(loaded.cast);
            }
            vec![status(conn)]
        }
        "SET_VOLUME" => {
            set_volume(conn, &payload["volume"]);
            vec![status(conn)]
        }
        "GET_STATUS" => vec![status(conn)],
        _ => vec![reply(NS_MEDIA, json!({"type": "INVALID_REQUEST", "reason": "INVALID_COMMAND", "requestId": request_id}))],
    }
}

fn media_from(media: &Value, url: &str, load: &Value, sender_id: &str, peer: IpAddr) -> Media {
    let meta = &media["metadata"];
    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let app = if sender_id.contains("vlc") { "VLC" } else { "Cast" };
    Media {
        url: url.to_string(),
        title: text(&meta["title"]),
        subtitle: text(&meta["artist"]).or_else(|| text(&meta["albumName"])).or_else(|| text(&meta["album"])).or_else(|| text(&meta["subtitle"])),
        artwork: meta["images"][0]["url"].as_str().filter(|u| u.starts_with("http")).map(String::from),
        start_ms: load["currentTime"].as_f64().map(|t| (t * 1000.0) as i64).unwrap_or(0),
        // VLC always says LIVE: it streams whatever it plays, and seeks by loading again.
        live: media["streamType"].as_str() == Some("LIVE"),
        options: Vec::new(),
        sender: format!("{app} on {peer}"),
        sender_key: format!("cast:{peer}"),
    }
}

/// MEDIA_STATUS for the loaded media (an empty list when nothing is loaded).
fn media_status(conn: &mut Conn, request_id: i64) -> Value {
    let Some(cast) = conn.loaded.as_ref().map(|l| l.cast) else {
        return json!({"type": "MEDIA_STATUS", "requestId": request_id, "status": []});
    };
    let status = super::status(cast);
    if status.error.as_deref() == Some("declined") {
        conn.declined = true;
    }
    let loaded = conn.loaded.as_mut().expect("checked above");
    let (state, idle_reason) = match status.state {
        PlayState::Loading | PlayState::Buffering => ("BUFFERING", None),
        PlayState::Playing => ("PLAYING", None),
        PlayState::Paused => ("PAUSED", None),
        PlayState::Ended => ("IDLE", Some("FINISHED")),
        PlayState::Error => ("IDLE", Some("ERROR")),
        PlayState::Idle if status.error.is_some() => ("IDLE", Some("ERROR")),
        PlayState::Idle => ("IDLE", Some("INTERRUPTED")),
    };
    loaded.last = Some((status.state, status.muted, (status.volume * 100.0) as i64));
    let mut media = loaded.media.clone();
    if status.length_ms > 0 {
        media["duration"] = json!(status.length_ms as f64 / 1000.0);
    }
    let mut entry = json!({
        "mediaSessionId": loaded.media_session,
        "playbackRate": 1,
        "playerState": state,
        "currentTime": status.time_ms as f64 / 1000.0,
        "supportedMediaCommands": MEDIA_COMMANDS,
        "volume": {"level": status.volume, "muted": status.muted},
        "media": media,
    });
    if let Some(reason) = idle_reason {
        entry["idleReason"] = json!(reason);
    }
    json!({"type": "MEDIA_STATUS", "requestId": request_id, "status": [entry]})
}

/// An unprompted MEDIA_STATUS when the state or volume changed since the last report.
fn status_update(conn: &mut Conn) -> Option<Message> {
    let (app, loaded) = (conn.app.as_ref()?, conn.loaded.as_ref()?);
    let status = super::status(loaded.cast);
    let now = (status.state, status.muted, (status.volume * 100.0) as i64);
    if loaded.last == Some(now) {
        return None;
    }
    // Report a finished session once, then forget it.
    let finished = matches!(status.state, PlayState::Idle | PlayState::Ended | PlayState::Error);
    let (from, to) = (app.transport_id.clone(), loaded.sender.clone());
    let body = media_status(conn, 0);
    if finished {
        conn.loaded = None;
    }
    Some(Message::text(&from, &to, NS_MEDIA, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip() {
        let m = Message::text("sender-vlc", "receiver-0", NS_RECEIVER, &json!({"type": "GET_STATUS", "requestId": 1}));
        let back = Message::decode(&m.encode()).unwrap();
        assert_eq!(back, m);
        let b = Message { source: "a".into(), destination: "b".into(), namespace: NS_AUTH.into(), text: None, binary: Some(vec![0x0a, 0x00]) };
        assert_eq!(Message::decode(&b.encode()).unwrap(), b);
    }

    #[test]
    fn frames_split_across_reads() {
        let m = Message::text("s", "d", NS_HEARTBEAT, &json!({"type": "PING"}));
        let body = m.encode();
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&body);
        let mut buf = frame[..5].to_vec();
        assert_eq!(take_frame(&mut buf).unwrap(), None);
        buf.extend_from_slice(&frame[5..]);
        buf.extend_from_slice(&frame[..2]);
        assert_eq!(take_frame(&mut buf).unwrap(), Some(m));
        assert_eq!(buf.len(), 2);
    }

    #[test]
    fn auth_response_has_the_response_field() {
        let bytes = auth_response();
        let top = fields(&bytes).unwrap();
        assert!(matches!(top[0], (2, Field::Bytes(_))));
        if let (_, Field::Bytes(inner)) = &top[0] {
            let inner = fields(inner).unwrap();
            assert_eq!(inner.len(), 2);
        }
    }

    #[test]
    fn launch_gives_a_transport() {
        let mut conn = Conn { peer: "127.0.0.1".parse().unwrap(), app: None, loaded: None, declined: false, senders: vec![] };
        let launch = Message::text("sender-vlc", RECEIVER_ID, NS_RECEIVER, &json!({"type": "LAUNCH", "appId": MEDIA_APP, "requestId": 3}));
        let replies = handle(&mut conn, &launch);
        let status = replies[0].json();
        assert_eq!(status["type"], "RECEIVER_STATUS");
        assert_eq!(status["requestId"], 3);
        assert_eq!(status["status"]["applications"][0]["appId"], MEDIA_APP);
        assert!(status["status"]["applications"][0]["transportId"].as_str().unwrap().starts_with("zazabor-media-"));
        let other = Message::text("sender-vlc", RECEIVER_ID, NS_RECEIVER, &json!({"type": "LAUNCH", "appId": "233637DE", "requestId": 4}));
        assert_eq!(handle(&mut conn, &other)[0].json()["type"], "LAUNCH_ERROR");
    }

    #[test]
    fn ping_gets_pong() {
        let mut conn = Conn { peer: "127.0.0.1".parse().unwrap(), app: None, loaded: None, declined: false, senders: vec![] };
        let ping = Message::text("sender-vlc", RECEIVER_ID, NS_HEARTBEAT, &json!({"type": "PING"}));
        let replies = handle(&mut conn, &ping);
        assert_eq!(replies[0].json()["type"], "PONG");
        assert_eq!(replies[0].destination, "sender-vlc");
    }
}

/// The real VLC on this PC casts a short clip here, as a phone's VLC would. Needs `cvlc` and
/// `ffmpeg`/`ffprobe`: `cargo test --lib cast::castv2::live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    #[ignore]
    fn vlc_casts_to_us() {
        let generation = super::super::testing::begin();
        let port = super::start(generation).expect("listen");
        let dir = std::env::temp_dir().join(format!("zazabor-cast-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.mp4");
        let made = Command::new("ffmpeg")
            .args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "5", "-c:v", "libopenh264", "-b:v", "1M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(&clip)
            .status()
            .unwrap();
        assert!(made.success());
        let mut vlc = Command::new("cvlc")
            .arg(&clip)
            .arg("--sout")
            .arg(format!("#chromecast{{ip=127.0.0.1,port={port}}}"))
            .args(["--play-and-exit", "-vv", "--demux-filter=cc_demux"])
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(dir.join("vlc.log")).unwrap())
            .spawn()
            .expect("cvlc");
        let started = Instant::now();
        let url = loop {
            if let Some(url) = super::super::testing::current_url() {
                break url;
            }
            if started.elapsed() > Duration::from_secs(20) {
                let _ = vlc.kill();
                let log = std::fs::read_to_string(dir.join("vlc.log")).unwrap_or_default();
                let cc: Vec<&str> = log.lines().filter(|l| l.contains("chromecast") || l.contains("tls") || l.contains("gnutls")).collect();
                panic!("VLC never sent LOAD:\n{}", cc[cc.len().saturating_sub(40)..].join("\n"));
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        println!("VLC asked us to play {url}");
        let probe = Command::new("ffprobe").args(["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "compact", "-rw_timeout", "10000000"]).arg(&url).output().unwrap();
        let text = String::from_utf8_lossy(&probe.stdout);
        println!("{text}");
        let _ = vlc.kill();
        let _ = vlc.wait();
        let log = std::fs::read_to_string(dir.join("vlc.log")).unwrap_or_default();
        let cc: Vec<&str> = log.lines().filter(|l| l.contains("chromecast") || l.contains("httpd")).collect();
        println!("{}", cc[cc.len().saturating_sub(50)..].join("\n"));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(text.contains("codec_type=video"), "no video in VLC's stream: {}", String::from_utf8_lossy(&probe.stderr));
    }
}
