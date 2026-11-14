//! Connections to an account's servers: IMAP (with timeouts on every step, so a dead network
//! never hangs the sync) and SMTP. Certificates are checked, except for a server on this computer
//! (Proton Mail Bridge and the like, which sign their own).

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use super::db::Server;

pub type Session = imap::Session<imap::Connection>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long one read or write may wait.
pub const IO_TIMEOUT: Duration = Duration::from_secs(90);

/// An IMAP session, what its server can do, and a handle on its socket (to cut it off).
pub struct Link {
    pub session: Session,
    pub tcp: TcpStream,
    pub can_move: bool,
    pub uidplus: bool,
    pub idle: bool,
}

pub fn is_local(host: &str) -> bool {
    matches!(host.trim().to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

fn open_tcp(server: &Server) -> Result<TcpStream, String> {
    let unreachable = |why: String| format!("Couldn't reach {}:{} ({why}). Check the connection and the server name.", server.host, server.port);
    let addrs = (server.host.as_str(), server.port).to_socket_addrs().map_err(|e| unreachable(e.to_string()))?;
    let mut last = "no address".to_string();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(tcp) => {
                let _ = tcp.set_read_timeout(Some(IO_TIMEOUT));
                let _ = tcp.set_write_timeout(Some(IO_TIMEOUT));
                let _ = tcp.set_nodelay(true);
                return Ok(tcp);
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(unreachable(last))
}

fn secure(server: &Server, tcp: TcpStream) -> Result<native_tls::TlsStream<TcpStream>, String> {
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(is_local(&server.host))
        .danger_accept_invalid_hostnames(is_local(&server.host))
        .build()
        .map_err(|e| e.to_string())?;
    connector.connect(&server.host, tcp).map_err(|e| format!("{} didn't make a secure connection: {e}", server.host))
}

/// One line from the server, read a byte at a time so nothing after it is taken.
fn read_line(mut tcp: &TcpStream) -> Result<String, String> {
    use std::io::Read;
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while !line.ends_with(b"\r\n") && line.len() < 8192 {
        match tcp.read(&mut byte) {
            Ok(1) => line.push(byte[0]),
            Ok(_) => return Err("the connection closed".into()),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(String::from_utf8_lossy(&line).trim_end().to_string())
}

/// Asks a server that greeted in the clear to switch to TLS (the handshake is the caller's).
fn start_tls(mut tcp: &TcpStream) -> Result<(), String> {
    use std::io::Write;
    let greeting = read_line(tcp)?;
    if !greeting.starts_with("* OK") && !greeting.starts_with("* PREAUTH") {
        return Err(format!("it answered “{greeting}”"));
    }
    tcp.write_all(b"z1 STARTTLS\r\n").map_err(|e| e.to_string())?;
    loop {
        let line = read_line(tcp)?;
        if let Some(answer) = line.strip_prefix("z1 ") {
            return if answer.to_ascii_uppercase().starts_with("OK") { Ok(()) } else { Err(format!("it answered “{answer}”")) };
        }
    }
}

fn imap_err(e: imap::Error) -> String {
    match e {
        imap::Error::No(no) => no.information.to_string(),
        imap::Error::Bad(bad) => bad.information.to_string(),
        imap::Error::Bye(bye) => format!("The server closed the connection: {}", bye.information),
        other => other.to_string(),
    }
}

/// Signs in to the account's IMAP server.
pub fn connect(server: &Server, username: &str, password: &str) -> Result<Link, String> {
    let tcp = open_tcp(server)?;
    let handle = tcp.try_clone().map_err(|e| e.to_string())?;
    let greeting = |e: imap::Error| format!("{} didn't answer like a mail server: {}", server.host, imap_err(e));
    let client: imap::Client<imap::Connection> = match server.security.as_str() {
        "ssl" => {
            let mut client = imap::Client::new(Box::new(secure(server, tcp)?) as imap::Connection);
            client.read_greeting().map_err(greeting)?;
            client
        }
        "starttls" => {
            start_tls(&tcp).map_err(|why| format!("{} doesn't offer STARTTLS ({why}).", server.host))?;
            let mut client = imap::Client::new(Box::new(secure(server, tcp)?) as imap::Connection);
            client.greeting_read = true;
            client
        }
        _ => {
            let mut client = imap::Client::new(Box::new(tcp) as imap::Connection);
            client.read_greeting().map_err(greeting)?;
            client
        }
    };
    let mut session = client.login(username, password).map_err(|(e, _)| match e {
        imap::Error::No(_) | imap::Error::Bad(_) => format!("{} didn't accept that user name and password. {}", server.host, imap_err(e)),
        other => imap_err(other),
    })?;
    let caps = session.capabilities().map_err(imap_err)?;
    let (can_move, uidplus, idle) = (caps.has_str("MOVE"), caps.has_str("UIDPLUS"), caps.has_str("IDLE"));
    drop(caps);
    Ok(Link { session, tcp: handle, can_move, uidplus, idle })
}

pub fn err(e: imap::Error) -> String {
    imap_err(e)
}

/// "3,5:7,12" for the UIDs (sorted here), as IMAP commands take them.
pub fn uid_set(uids: &[u32]) -> String {
    let mut sorted = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out = String::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            i += 1;
            end = sorted[i];
        }
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(&if end > start { format!("{start}:{end}") } else { start.to_string() });
        i += 1;
    }
    out
}

/// A folder name as people read it: IMAP writes other alphabets in its own UTF-7 ("&AOk-" is é).
pub fn decode_utf7(name: &str) -> String {
    use base64::Engine;
    let mut out = String::new();
    let mut rest = name;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('-') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let coded = &after[..end];
        if coded.is_empty() {
            out.push('&');
        } else {
            let standard = coded.replace(',', "/");
            match base64::engine::general_purpose::STANDARD_NO_PAD.decode(standard.trim_end_matches('=')) {
                Ok(bytes) => {
                    let units: Vec<u16> = bytes.chunks_exact(2).map(|b| u16::from_be_bytes([b[0], b[1]])).collect();
                    out.push_str(&String::from_utf16_lossy(&units));
                }
                Err(_) => out.push_str(&rest[start..start + end + 2]),
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The SMTP side: sends `message` through the account's outgoing server.
pub fn smtp(server: &Server, username: &str, password: &str) -> Result<lettre::SmtpTransport, String> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::transport::smtp::client::{Tls, TlsParameters};
    let params = || {
        TlsParameters::builder(server.host.clone())
            .dangerous_accept_invalid_certs(is_local(&server.host))
            .dangerous_accept_invalid_hostnames(is_local(&server.host))
            .build_native()
            .map_err(|e| e.to_string())
    };
    let tls = match server.security.as_str() {
        "ssl" => Tls::Wrapper(params()?),
        "starttls" => Tls::Required(params()?),
        _ => Tls::None,
    };
    Ok(lettre::SmtpTransport::builder_dangerous(server.host.clone())
        .port(server.port)
        .tls(tls)
        .timeout(Some(Duration::from_secs(60)))
        .credentials(Credentials::new(username.to_string(), password.to_string()))
        .build())
}

pub fn smtp_err(server: &Server, e: lettre::transport::smtp::Error) -> String {
    if e.is_permanent() || e.is_transient() {
        format!("{} refused: {e}", server.host)
    } else {
        format!("Couldn't send through {}:{} ({e}).", server.host, server.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_sets_and_folder_names() {
        assert_eq!(uid_set(&[7, 3, 5, 6, 12, 5]), "3,5:7,12");
        assert_eq!(uid_set(&[]), "");
        assert_eq!(decode_utf7("INBOX"), "INBOX");
        assert_eq!(decode_utf7("Entw&APw-rfe"), "Entwürfe");
        assert_eq!(decode_utf7("Tom &- Jerry"), "Tom & Jerry");
        assert_eq!(decode_utf7("&ZeVnLIqe-"), "日本語");
    }
}
