//! UPnP discovery (SSDP): answers phones asking the network "any MediaRenderers / DIAL servers
//! here?" on 239.255.255.250:1900, and announces the receiver with NOTIFY alive/byebye.
//!
//! The socket shares port 1900 with anything else on the PC (minissdpd, a browser, Kodi), so it
//! binds with SO_REUSEADDR/SO_REUSEPORT. Each answer's LOCATION uses the address of the interface
//! the phone is on.

use socket2::{Domain, Protocol, Socket, Type};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const PORT: u16 = 1900;
const MAX_AGE: u32 = 1800;
const NOTIFY_EVERY: Duration = Duration::from_secs(60);
const SERVER: &str = "Linux/1 UPnP/1.0 Zazabor/1";

/// One device the receiver announces.
#[derive(Clone, Debug)]
pub struct Advert {
    /// Without the `uuid:` prefix.
    pub uuid: String,
    /// `urn:schemas-upnp-org:device:MediaRenderer:1`, `urn:dial-multiscreen-org:device:dial:1`.
    pub device_type: String,
    /// Service types it answers for too.
    pub services: Vec<String>,
    /// The description's path on the receiver's web server (`/dlna/description.xml`).
    pub location: String,
}

impl Advert {
    /// Every (search target, USN) pair this device answers for.
    fn targets(&self) -> Vec<(String, String)> {
        let uuid = format!("uuid:{}", self.uuid);
        let mut out = vec![
            ("upnp:rootdevice".to_string(), format!("{uuid}::upnp:rootdevice")),
            (uuid.clone(), uuid.clone()),
            (self.device_type.clone(), format!("{uuid}::{}", self.device_type)),
        ];
        for service in &self.services {
            out.push((service.clone(), format!("{uuid}::{service}")));
        }
        out
    }
}

struct Running {
    adverts: Vec<Advert>,
    http_port: u16,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn running() -> std::sync::MutexGuard<'static, Option<Running>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn start(generation: u64, http_port: u16, adverts: Vec<Advert>) -> Result<(), String> {
    if adverts.is_empty() || http_port == 0 {
        return Err("nothing to announce".into());
    }
    let socket = listen_socket()?;
    *running() = Some(Running { adverts: adverts.clone(), http_port });
    std::thread::Builder::new()
        .name("cast-ssdp".into())
        .spawn(move || {
            let mut last_notify: Option<Instant> = None;
            let mut burst = 3;
            let mut buf = [0u8; 2048];
            while super::alive(generation) {
                if last_notify.is_none_or(|t| t.elapsed() >= NOTIFY_EVERY) || burst > 0 {
                    notify_all(&adverts, http_port, "ssdp:alive");
                    last_notify = Some(Instant::now());
                    burst = (burst - 1).max(0);
                }
                let Ok((n, peer)) = socket.recv_from(&mut buf) else { continue };
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some((st, mx)) = parse_search(&text) {
                    // MX asks for a random delay up to that many seconds; a short one keeps us
                    // early in the phone's list without flooding it.
                    let delay = Duration::from_millis(50 + (n as u64 * 7) % (mx.clamp(1, 3) as u64 * 200));
                    for answer in answers(&adverts, &st, peer.ip(), http_port) {
                        std::thread::sleep(delay / 4);
                        let _ = socket.send_to(answer.as_bytes(), peer);
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Says goodbye on every interface (the receiver is going off).
pub fn stop() {
    if let Some(r) = running().take() {
        notify_all(&r.adverts, r.http_port, "ssdp:byebye");
    }
}

fn listen_socket() -> Result<UdpSocket, String> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).map_err(|e| e.to_string())?;
    socket.set_reuse_address(true).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    socket.set_reuse_port(true).map_err(|e| e.to_string())?;
    socket
        .bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORT)).into())
        .map_err(|e| format!("port 1900 is taken: {e}"))?;
    let mut joined = false;
    for ip in super::local_addresses() {
        joined |= socket.join_multicast_v4(&GROUP, &ip).is_ok();
    }
    if !joined {
        socket.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED).map_err(|e| e.to_string())?;
    }
    socket.set_read_timeout(Some(Duration::from_secs(1))).map_err(|e| e.to_string())?;
    Ok(socket.into())
}

/// The search target and MX of an M-SEARCH, or None for anything else.
fn parse_search(text: &str) -> Option<(String, u32)> {
    let mut lines = text.split("\r\n");
    if !lines.next()?.to_ascii_uppercase().starts_with("M-SEARCH") {
        return None;
    }
    let mut st = None;
    let mut mx = 1;
    let mut discover = false;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        match k.trim().to_ascii_uppercase().as_str() {
            "ST" => st = Some(v.to_string()),
            "MX" => mx = v.parse().unwrap_or(1),
            "MAN" => discover = v.trim_matches('"').eq_ignore_ascii_case("ssdp:discover"),
            _ => {}
        }
    }
    discover.then_some(())?;
    Some((st?, mx))
}

fn answers(adverts: &[Advert], st: &str, peer: IpAddr, http_port: u16) -> Vec<String> {
    let Some(local) = super::address_towards(peer) else { return Vec::new() };
    let mut out = Vec::new();
    for advert in adverts {
        for (target, usn) in advert.targets() {
            if st == "ssdp:all" || target.eq_ignore_ascii_case(st) {
                out.push(format!(
                    "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age={MAX_AGE}\r\nDATE: {}\r\nEXT:\r\nLOCATION: http://{local}:{http_port}{}\r\nSERVER: {SERVER}\r\nST: {target}\r\nUSN: {usn}\r\nBOOTID.UPNP.ORG: 1\r\nCONFIGID.UPNP.ORG: 1\r\n\r\n",
                    http_date(),
                    advert.location
                ));
            }
        }
    }
    out
}

fn notify_all(adverts: &[Advert], http_port: u16, nts: &str) {
    for ip in super::local_addresses() {
        let Ok(socket) = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) else { continue };
        let _ = socket.set_multicast_if_v4(&ip);
        let _ = socket.set_multicast_ttl_v4(2);
        if socket.bind(&SocketAddr::V4(SocketAddrV4::new(ip, 0)).into()).is_err() {
            continue;
        }
        let to: socket2::SockAddr = SocketAddr::V4(SocketAddrV4::new(GROUP, PORT)).into();
        for advert in adverts {
            for (target, usn) in advert.targets() {
                let mut message = format!("NOTIFY * HTTP/1.1\r\nHOST: {GROUP}:{PORT}\r\nNT: {target}\r\nNTS: {nts}\r\nUSN: {usn}\r\nBOOTID.UPNP.ORG: 1\r\nCONFIGID.UPNP.ORG: 1\r\n");
                if nts == "ssdp:alive" {
                    message.push_str(&format!("CACHE-CONTROL: max-age={MAX_AGE}\r\nLOCATION: http://{ip}:{http_port}{}\r\nSERVER: {SERVER}\r\n", advert.location));
                }
                message.push_str("\r\n");
                let _ = socket.send_to(message.as_bytes(), &to);
            }
        }
    }
}

/// RFC 1123 date for the DATE header.
pub fn http_date() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = secs / 86_400;
    let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][(days % 7) as usize];
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(month - 1) as usize];
    format!("{weekday}, {day:02} {name} {year} {h:02}:{m:02}:{s:02} GMT")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_m_search() {
        let req = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n";
        assert_eq!(parse_search(req), Some(("urn:dial-multiscreen-org:service:dial:1".into(), 2)));
        assert_eq!(parse_search("NOTIFY * HTTP/1.1\r\nNT: x\r\n\r\n"), None);
    }

    #[test]
    fn answers_matching_targets_only() {
        let a = Advert { uuid: "abc".into(), device_type: "urn:schemas-upnp-org:device:MediaRenderer:1".into(), services: vec!["urn:schemas-upnp-org:service:AVTransport:1".into()], location: "/d.xml".into() };
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        let hits = answers(&[a.clone()], "urn:schemas-upnp-org:service:AVTransport:1", peer, 5);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].contains("USN: uuid:abc::urn:schemas-upnp-org:service:AVTransport:1"));
        assert!(hits[0].contains("LOCATION: http://127.0.0.1:5/d.xml"));
        assert_eq!(answers(&[a.clone()], "ssdp:all", peer, 5).len(), 4);
        assert!(answers(&[a], "urn:other", peer, 5).is_empty());
    }

    #[test]
    fn formats_dates() {
        let d = http_date();
        assert!(d.ends_with(" GMT") && d.len() == 29, "{d}");
    }
}
