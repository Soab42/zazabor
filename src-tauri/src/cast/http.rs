//! A tiny HTTP/1.1 server for the receiver's web parts: the DLNA renderer's descriptions and SOAP
//! control, and DIAL for YouTube. One thread per connection, one request per connection
//! (`Connection: close`), small bodies only.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

/// Tried first, so phones that remember the address find it again after a restart.
const PREFERRED_PORT: u16 = 47_213;
const MAX_BODY: usize = 1 << 20;
const MAX_HEAD_LINES: usize = 100;
/// The request line and headers together; a phone's requests are well under 2 KiB.
const MAX_HEAD_BYTES: u64 = 16 * 1024;
/// Connections served at once; more are closed straight away.
const MAX_CONNECTIONS: usize = 32;
static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);
const IO_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Request {
    pub method: String,
    /// The path without the query (`/dlna/control/avt`).
    pub path: String,
    /// The raw query string (without `?`).
    pub query: String,
    /// Header names lower-cased.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub peer: SocketAddr,
    /// The address the request came in on (this PC as the phone sees it).
    pub local: SocketAddr,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// `http://<local ip>:<port>`, for addresses handed back to the phone.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.local)
    }
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16) -> Response {
        Response { status, headers: Vec::new(), body: Vec::new() }
    }

    pub fn ok(content_type: &str, body: impl Into<Vec<u8>>) -> Response {
        Response::new(200).header("Content-Type", content_type).body(body)
    }

    pub fn xml(body: impl Into<Vec<u8>>) -> Response {
        Response::ok("text/xml; charset=\"utf-8\"", body)
    }

    pub fn not_found() -> Response {
        Response::new(404)
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Response {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Response {
        self.body = body.into();
        self
    }

    fn write_to(&self, out: &mut impl Write) -> std::io::Result<()> {
        let mut head = format!("HTTP/1.1 {} {}\r\n", self.status, reason(self.status));
        for (k, v) in &self.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\nServer: Linux/1 UPnP/1.0 Zazabor/1\r\n\r\n", self.body.len()));
        out.write_all(head.as_bytes())?;
        out.write_all(&self.body)?;
        out.flush()
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        412 => "Precondition Failed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "",
    }
}

pub struct Server {
    pub port: u16,
}

/// Listens on all interfaces (preferring `PREFERRED_PORT`) until the receiver's generation moves on.
pub fn start(generation: u64) -> Result<Server, String> {
    let listener = TcpListener::bind(("0.0.0.0", PREFERRED_PORT))
        .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
        .map_err(|e| format!("could not listen: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("cast-http".into())
        .spawn(move || {
            while super::alive(generation) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if CONNECTIONS.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                            CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                            continue;
                        }
                        let spawned = std::thread::Builder::new().name("cast-http-conn".into()).spawn(move || {
                            serve(stream);
                            CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                        });
                        if spawned.is_err() {
                            CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
                    Err(_) => std::thread::sleep(Duration::from_millis(500)),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Server { port })
}

fn serve(stream: TcpStream) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let (Ok(peer), Ok(local)) = (stream.peer_addr(), stream.local_addr()) else { return };
    let Ok(mut writer) = stream.try_clone() else { return };
    let response = match read_request(BufReader::new(stream), peer, local) {
        Ok(request) => route(&request),
        Err(status) => Response::new(status),
    };
    let _ = response.write_to(&mut writer);
}

fn route(request: &Request) -> Response {
    super::dlna::route(request).or_else(|| super::youtube::route(request)).unwrap_or_else(Response::not_found)
}

fn read_request(mut reader: impl BufRead, peer: SocketAddr, local: SocketAddr) -> Result<Request, u16> {
    let (method, path, query, headers) = read_head(&mut (&mut reader).take(MAX_HEAD_BYTES))?;
    let length: usize = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if length > MAX_BODY {
        return Err(413);
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|_| 400u16)?;
    Ok(Request { method, path, query, headers, body, peer, local })
}

type Head = (String, String, String, Vec<(String, String)>);

/// Reads up to the blank line that ends the headers, from a reader capped at MAX_HEAD_BYTES: a
/// line that the cap cuts off (no newline) is 431, so a client can't make it buffer without end.
fn read_head(reader: &mut impl BufRead) -> Result<Head, u16> {
    let mut line = String::new();
    read_head_line(reader, &mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().ok_or(400u16)?.to_string();
    let target = parts.next().ok_or(400u16)?.to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    let mut headers = Vec::new();
    for _ in 0..MAX_HEAD_LINES {
        line.clear();
        if read_head_line(reader, &mut line)? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    Ok((method, path, query, headers))
}

fn read_head_line(reader: &mut impl BufRead, line: &mut String) -> Result<usize, u16> {
    let n = reader.read_line(line).map_err(|_| 400u16)?;
    if n > 0 && !line.ends_with('\n') {
        return Err(431);
    }
    Ok(n)
}

/// Decodes `a=1&b=x%20y` into pairs (`+` is a space).
pub fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect()
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => match (bytes.get(i + 1).and_then(|&b| hex(b)), bytes.get(i + 2).and_then(|&b| hex(b))) {
                (Some(hi), Some(lo)) => {
                    out.push(hi << 4 | lo);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// Escapes text for XML content and attributes.
pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_request_with_a_body() {
        let raw = b"POST /dlna/control/avt?x=1 HTTP/1.1\r\nHost: a\r\nSOAPACTION: \"urn:x#Play\"\r\nContent-Length: 4\r\n\r\nbodyEXTRA";
        let addr: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let r = read_request(&raw[..], addr, addr).unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/dlna/control/avt");
        assert_eq!(r.query, "x=1");
        assert_eq!(r.header("SoapAction"), Some("\"urn:x#Play\""));
        assert_eq!(r.body, b"body");
    }

    #[test]
    fn refuses_an_endless_header() {
        let addr: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let mut raw = b"GET / HTTP/1.1\r\nX-Long: ".to_vec();
        raw.extend(std::iter::repeat(b'a').take(MAX_HEAD_BYTES as usize));
        assert_eq!(read_request(&raw[..], addr, addr).err(), Some(431));
        let endless_line = vec![b'G'; 1 << 20];
        assert_eq!(read_request(&endless_line[..], addr, addr).err(), Some(431));
    }

    #[test]
    fn decodes_queries() {
        assert_eq!(parse_query("a=1&b=x%20y+z&c"), vec![("a".into(), "1".into()), ("b".into(), "x y z".into()), ("c".into(), "".into())]);
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%C3%A9"), "é");
    }
}
