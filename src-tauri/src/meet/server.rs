//! The HTTP and WebSocket server on 127.0.0.1: the meeting page, `/api/info/<code>`, the
//! signalling socket `/ws/<code>` and the recording upload `/rec/<code>`. Plain threads on a
//! `TcpListener`; each request's head is peeked first so a WebSocket upgrade can go to
//! `tungstenite::accept` with the head still unread.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::Message;

use super::room::{Hello, Out};
use super::store;
use super::Hub;

pub const PREFERRED_PORT: u16 = 47_230;
const MAX_HEAD: usize = 16 << 10;
/// The most a recording chunk may weigh.
pub const MAX_CHUNK: usize = 8 << 20;
const MAX_WS_MESSAGE: usize = 256 << 10;
const POLL: Duration = Duration::from_millis(25);

const ROOM_HTML: &str = include_str!("web/room.html");
const ROOM_CSS: &str = include_str!("web/room.css");
const ROOM_JS: &str = include_str!("web/room.js");
const TICK_JS: &str = include_str!("web/tick.js");

/// What the page may load and do: itself, WebRTC media, sockets back home.
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; worker-src 'self'; \
    connect-src 'self' ws: wss:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Starts listening (port 47230 or the next free one). Returns the port.
pub fn start(hub: &Arc<Hub>, preferred: u16) -> Result<u16, String> {
    let listener = (preferred..preferred.saturating_add(30))
        .find_map(|p| TcpListener::bind((Ipv4Addr::LOCALHOST, p)).ok())
        .or_else(|| TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok())
        .ok_or("Meet couldn't open a local port.")?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let hub = hub.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let hub = hub.clone();
            std::thread::spawn(move || {
                let _ = serve(&hub, stream);
            });
        }
    });
    Ok(port)
}

struct Request {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    head_len: usize,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    fn q(&self, name: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    fn via_tunnel(&self) -> bool {
        self.header("cf-connecting-ip").is_some() || self.header("cf-ray").is_some()
    }
    fn is_ws(&self) -> bool {
        self.header("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    }
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() && b.get(i + 1..i + 3).is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit)) => {
                out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("0"), 16).unwrap_or(b'?'));
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Reads the request head without consuming it.
fn peek_head(stream: &TcpStream) -> Result<Request, String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut buf = vec![0u8; MAX_HEAD];
    loop {
        let n = stream.peek(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed".into());
        }
        if let Some(end) = buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            return parse_head(&buf[..end + 4]);
        }
        if n == buf.len() || Instant::now() > deadline {
            return Err("head too large or slow".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn parse_head(head: &[u8]) -> Result<Request, String> {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query = query.split('&').filter(|p| !p.is_empty()).map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (pct_decode(k), pct_decode(v))
    }).collect();
    let headers = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).collect();
    if method.is_empty() || !path.starts_with('/') {
        return Err("bad request".into());
    }
    Ok(Request { method, path: pct_decode(path), query, headers, head_len: head.len() })
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &[u8], page: bool) {
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n", body.len());
    if page {
        head.push_str(&format!("Content-Security-Policy: {CSP}\r\nPermissions-Policy: camera=(self), microphone=(self), display-capture=(self)\r\nX-Frame-Options: DENY\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Write);
}

fn json_reply(stream: &mut TcpStream, status: &str, v: Value) {
    respond(stream, status, "application/json; charset=utf-8", v.to_string().as_bytes(), false);
}

fn serve(hub: &Arc<Hub>, mut stream: TcpStream) -> Result<(), String> {
    let req = peek_head(&stream)?;
    let segs: Vec<&str> = req.path.trim_matches('/').split('/').collect();
    if req.is_ws() {
        return match segs.as_slice() {
            ["ws", code] if store::valid_code(code) => ws_session(hub, stream, code, req.via_tunnel()),
            _ => {
                respond(&mut stream, "404 Not Found", "text/plain", b"Not found", false);
                Ok(())
            }
        };
    }
    // Consume the head.
    let mut head = vec![0u8; req.head_len];
    stream.read_exact(&mut head).map_err(|e| e.to_string())?;
    match (req.method.as_str(), segs.as_slice()) {
        ("GET", ["m", code]) => {
            if store::valid_code(code) && hub.meeting_by_code(code).is_some() {
                respond(&mut stream, "200 OK", "text/html; charset=utf-8", ROOM_HTML.as_bytes(), true);
            } else {
                respond(&mut stream, "404 Not Found", "text/html; charset=utf-8", b"<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Meeting not found</title><body style=\"font-family:system-ui;background:#111;color:#eee;padding:2rem\"><h1>Meeting not found</h1><p>Check the link, or ask the host for a new one.", true);
            }
        }
        ("GET", ["assets", "room.css"]) => respond(&mut stream, "200 OK", "text/css; charset=utf-8", ROOM_CSS.as_bytes(), false),
        ("GET", ["assets", "tick.js"]) => respond(&mut stream, "200 OK", "text/javascript; charset=utf-8", TICK_JS.as_bytes(), false),
        ("GET", ["assets", "room.js"]) => respond(&mut stream, "200 OK", "text/javascript; charset=utf-8", ROOM_JS.as_bytes(), false),
        ("GET", ["api", "info", code]) => match store::valid_code(code).then(|| hub.meeting_by_code(code)).flatten() {
            Some(m) => {
                let host = req.q("host").is_some_and(|t| hub.is_host_token(t)) && !req.via_tunnel();
                json_reply(&mut stream, "200 OK", json!({
                    "title": m.title, "kind": m.kind, "recorded": m.auto_record, "lobby": m.lobby, "host": host,
                    "hostName": if host { Value::String(super::full_name()) } else { Value::Null },
                }));
            }
            None => json_reply(&mut stream, "404 Not Found", json!({"error": "not-found"})),
        },
        ("POST", ["rec", code]) => rec_upload(hub, &mut stream, &req, code),
        _ => respond(&mut stream, "404 Not Found", "text/plain", b"Not found", false),
    }
    Ok(())
}

fn rec_upload(hub: &Arc<Hub>, stream: &mut TcpStream, req: &Request, code: &str) {
    if !req.q("host").is_some_and(|t| hub.is_host_token(t)) || req.via_tunnel() {
        return json_reply(stream, "403 Forbidden", json!({"error": "host token needed"}));
    }
    let len = req.header("content-length").and_then(|v| v.parse::<usize>().ok());
    let Some(len) = len else { return json_reply(stream, "411 Length Required", json!({"error": "length"})) };
    if len > MAX_CHUNK {
        return json_reply(stream, "413 Payload Too Large", json!({"error": "too large"}));
    }
    let (Some(rec), Some(seq)) = (req.q("rec"), req.q("seq").and_then(|s| s.parse::<u64>().ok())) else {
        return json_reply(stream, "400 Bad Request", json!({"error": "rec and seq"}));
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut body = vec![0u8; len];
    if stream.read_exact(&mut body).is_err() {
        return json_reply(stream, "400 Bad Request", json!({"error": "short body"}));
    }
    match hub.rec_append(code, rec, seq, &body) {
        Ok(next) => json_reply(stream, "200 OK", json!({"next": next})),
        Err((status, msg)) => json_reply(stream, status, json!({"error": msg})),
    }
}

fn ws_session(hub: &Arc<Hub>, stream: TcpStream, code: &str, via_tunnel: bool) -> Result<(), String> {
    let config = WebSocketConfig::default().max_message_size(Some(MAX_WS_MESSAGE)).max_frame_size(Some(MAX_WS_MESSAGE));
    let _ = stream.set_nodelay(true);
    let mut ws = tungstenite::accept_with_config(stream, Some(config)).map_err(|e| e.to_string())?;
    let _ = ws.get_ref().set_read_timeout(Some(POLL));
    let _ = ws.get_ref().set_write_timeout(Some(Duration::from_secs(10)));

    let (tx, rx) = mpsc::channel::<Out>();
    let id = store::new_id()[..8].to_string();
    let started = Instant::now();
    let mut joined: Option<(Arc<super::room::Room>, store::Stored)> = None;

    let result = (|| -> Result<(), String> {
        loop {
            while let Ok(out) = rx.try_recv() {
                match out {
                    Out::Text(s) => ws.send(Message::text(s)).map_err(|e| e.to_string())?,
                    Out::Close => {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        return Ok(());
                    }
                }
            }
            if joined.is_none() && started.elapsed() > Duration::from_secs(15) {
                return Err("no hello".into());
            }
            match ws.read() {
                Ok(Message::Text(text)) => {
                    let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    let t = v.get("t").and_then(Value::as_str).unwrap_or("");
                    match &joined {
                        None => {
                            if t != "hello" {
                                return Err("expected hello".into());
                            }
                            let Some(m) = hub.meeting_by_code(code) else {
                                let _ = ws.send(Message::text(json!({"t": "error", "reason": "not-found"}).to_string()));
                                return Ok(());
                            };
                            let token = v.get("host").and_then(Value::as_str);
                            let is_host = token.is_some_and(|t| hub.is_host_token(t)) && !via_tunnel;
                            if token.is_some() && !is_host {
                                let _ = ws.send(Message::text(json!({"t": "denied", "reason": "token"}).to_string()));
                                return Ok(());
                            }
                            let room = hub.room(code);
                            match room.hello(hub, &m, &id, tx.clone(), &v, is_host) {
                                Hello::Refused => {
                                    while let Ok(Out::Text(s)) = rx.try_recv() {
                                        let _ = ws.send(Message::text(s));
                                    }
                                    return Ok(());
                                }
                                _ => joined = Some((room, m)),
                            }
                        }
                        Some((room, m)) => room.handle(hub, m, &id, &v),
                    }
                }
                Ok(Message::Close(_)) => return Ok(()),
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    })();
    if let Some((room, _)) = &joined {
        room.leave(hub, &id);
    }
    let _ = ws.get_ref().shutdown(Shutdown::Both);
    result
}
