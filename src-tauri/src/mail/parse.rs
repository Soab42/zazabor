//! Reading a message: its headers for the list, and its text, pictures and files for the page.
//!
//! An HTML message is untrusted: it is cleaned down to formatting (no scripts, forms, frames or
//! event handlers) and shown in a frame that can't run scripts. Pictures from the web are left
//! out until asked for (they tell the sender the message was opened); asked for, Zazabor fetches
//! them itself and hands them to the page as data.

use base64::Engine;
use mail_parser::{HeaderValue, MessageParser, MessagePart, MimeHeaders};
use serde::Serialize;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::db::{Address, Header};

fn address(a: &mail_parser::Addr) -> Address {
    Address { name: a.name().unwrap_or("").trim().to_string(), addr: a.address().unwrap_or("").trim().to_string() }
}

fn addresses(list: Option<&mail_parser::Address>) -> Vec<Address> {
    list.map(|l| l.iter().map(address).filter(|a| !a.addr.is_empty()).collect()).unwrap_or_default()
}

/// The ids in an In-Reply-To or References header.
fn ids(value: &HeaderValue) -> Vec<String> {
    match value {
        HeaderValue::Text(id) => vec![id.to_string()],
        HeaderValue::TextList(list) => list.iter().map(|id| id.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// The headers the list and the conversations need. `raw` is the header block (or a whole message).
pub fn header(raw: &[u8]) -> Header {
    let Some(msg) = MessageParser::default().parse_headers(raw) else { return Header::default() };
    let content_type = msg.root_part().content_type();
    Header {
        message_id: msg.message_id().unwrap_or("").to_string(),
        in_reply_to: ids(msg.in_reply_to()).pop().unwrap_or_default(),
        refs: ids(msg.references()),
        subject: collapse(msg.subject().unwrap_or("")),
        from: msg.from().and_then(|l| l.first()).map(address).unwrap_or_default(),
        to: addresses(msg.to()),
        cc: addresses(msg.cc()),
        reply_to: msg.reply_to().and_then(|l| l.first()).and_then(|a| a.address().map(str::to_string)).unwrap_or_default(),
        date: msg.date().map(|d| d.to_timestamp()).unwrap_or(0),
        attachments: content_type.is_some_and(|c| c.ctype().eq_ignore_ascii_case("multipart") && c.subtype().is_some_and(|s| s.eq_ignore_ascii_case("mixed"))),
        ..Header::default()
    }
}

/// Runs of white space become one space.
pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One file a message carries.
#[derive(Serialize, Clone, Debug)]
pub struct Attachment {
    /// Which of the message's attachments, for saving or opening it.
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: usize,
}

/// A message, ready to show.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    /// The cleaned HTML, when the message has an HTML part.
    pub html: Option<String>,
    pub text: String,
    pub attachments: Vec<Attachment>,
    /// It has pictures on the web that were left out.
    pub blocked_images: bool,
    /// Where "Unsubscribe" goes (an https or mailto address), when the sender says.
    pub unsubscribe: Option<String>,
}

/// What the list and the search keep of a message's text.
pub struct Summary {
    pub snippet: String,
    pub attachments: bool,
    pub text: String,
}

fn mime_of(part: &MessagePart) -> String {
    part.content_type()
        .map(|c| match c.subtype() {
            Some(sub) => format!("{}/{}", c.ctype(), sub).to_lowercase(),
            None => c.ctype().to_lowercase(),
        })
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// The message's HTML, when it has an HTML part (a plain message stays plain).
fn html_of(msg: &mail_parser::Message<'_>) -> Option<String> {
    msg.html_bodies().any(|p| p.is_content_type("text", "html")).then(|| (0..msg.html_body_count()).filter_map(|i| msg.body_html(i)).collect::<Vec<_>>().join("\n"))
}

fn text_of(msg: &mail_parser::Message<'_>) -> String {
    (0..msg.text_body_count()).filter_map(|i| msg.body_text(i)).collect::<Vec<_>>().join("\n")
}

/// The files to offer: every attachment except the pictures the HTML shows in place.
fn files<'m>(msg: &'m mail_parser::Message<'_>, html: Option<&str>) -> Vec<(usize, &'m MessagePart<'m>)> {
    msg.attachments()
        .enumerate()
        .filter(|(_, part)| match (part.content_id(), html) {
            (Some(cid), Some(html)) if mime_of(part).starts_with("image/") => !html.contains(&format!("cid:{}", cid.trim_matches(['<', '>']))),
            _ => true,
        })
        .collect()
}

fn file_name(part: &MessagePart, index: usize) -> String {
    let name = part.attachment_name().map(collapse).filter(|n| !n.is_empty()).unwrap_or_else(|| {
        let mime = mime_of(part);
        let ext = match mime.as_str() {
            "message/rfc822" => "eml",
            "text/calendar" => "ics",
            "text/plain" => "txt",
            "text/html" => "html",
            _ => mime.rsplit('/').next().filter(|e| e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("bin"),
        };
        format!("Attachment {}.{ext}", index + 1)
    });
    // A name is a name, never a path.
    name.replace(['/', '\\', '\0'], "_").trim_start_matches('.').to_string()
}

pub fn summary(raw: &[u8]) -> Summary {
    let Some(msg) = MessageParser::default().parse(raw) else { return Summary { snippet: String::new(), attachments: false, text: String::new() } };
    let html = html_of(&msg);
    let mut text = text_of(&msg);
    if text.len() > 200_000 {
        let mut cut = 200_000;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    Summary {
        snippet: collapse(&msg.body_preview(220).unwrap_or_default()).chars().take(200).collect(),
        attachments: !files(&msg, html.as_deref()).is_empty(),
        text,
    }
}

/// What a `cid:` picture in the HTML points at, as a data URL.
fn inline_images(msg: &mail_parser::Message<'_>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in &msg.parts {
        let Some(cid) = part.content_id() else { continue };
        let mime = mime_of(part);
        if !mime.starts_with("image/") || part.len() > 8 << 20 {
            continue;
        }
        out.insert(cid.trim_matches(['<', '>']).to_string(), data_url(&mime, part.contents()));
    }
    out
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

const EXTRA_TAGS: [&str; 6] = ["style", "font", "center", "section", "main", "label"];
const EXTRA_ATTRIBUTES: [&str; 17] = [
    "style", "class", "id", "align", "valign", "bgcolor", "width", "height", "border", "cellpadding", "cellspacing", "color", "face", "size", "dir", "lang", "role",
];

/// What to do with the pictures an HTML message links from the web.
enum Remote {
    /// Leave them out, noting that there were some.
    Block(Arc<Mutex<bool>>),
    /// Only list them.
    Collect(Arc<Mutex<Vec<String>>>),
    /// Put the fetched ones in.
    Fill(Arc<HashMap<String, String>>),
}

fn clean(html: &str, cids: Arc<HashMap<String, String>>, remote: Remote) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(EXTRA_TAGS)
        .rm_clean_content_tags(["style"])
        .add_generic_attributes(EXTRA_ATTRIBUTES)
        .url_schemes(HashSet::from(["http", "https", "mailto", "tel", "cid", "data"]))
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(move |element, attribute, value| {
            if attribute == "srcset" || attribute == "background" || attribute == "id" {
                return None;
            }
            if element == "img" && attribute == "src" {
                let v = value.trim();
                if let Some(cid) = v.strip_prefix("cid:") {
                    return cids.get(cid).map(|url| Cow::Owned(url.clone()));
                }
                if v.starts_with("data:image/") {
                    return Some(Cow::Borrowed(value));
                }
                if v.starts_with("http://") || v.starts_with("https://") {
                    return match &remote {
                        Remote::Block(found) => {
                            *found.lock().unwrap_or_else(|e| e.into_inner()) = true;
                            None
                        }
                        Remote::Collect(urls) => {
                            urls.lock().unwrap_or_else(|e| e.into_inner()).push(v.to_string());
                            None
                        }
                        Remote::Fill(images) => images.get(v).map(|url| Cow::Owned(url.clone())),
                    };
                }
                return None;
            }
            // Only pictures may be data: a link never is.
            if attribute == "href" && value.trim_start().to_ascii_lowercase().starts_with("data:") {
                return None;
            }
            Some(Cow::Borrowed(value))
        });
    builder.clean(html).to_string()
}

/// Whether an address is out on the internet: not this computer, the local network, or any
/// other range that only means something from where the request is made.
fn is_public(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast() || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public(IpAddr::V4(v4)),
            None => {
                let first = v6.segments()[0];
                !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 || first == 0x0064 || first == 0x2002)
            }
        },
    }
}

/// Looks names up like the default resolver, and refuses any that leads to this computer or the
/// local network. A message chooses the addresses of its pictures, so fetching them must never
/// reach something only this computer can (a router's page, a service on localhost). The check
/// is on the very addresses the connection then uses, for every hop of a redirect.
#[derive(Debug, Default)]
struct PublicOnly(ureq::unversioned::resolver::DefaultResolver);

impl ureq::unversioned::resolver::Resolver for PublicOnly {
    fn resolve(&self, uri: &ureq::http::Uri, config: &ureq::config::Config, timeout: ureq::unversioned::transport::NextTimeout) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        let addrs = self.0.resolve(uri, config, timeout)?;
        if addrs.iter().all(|addr| is_public(addr.ip())) {
            Ok(addrs)
        } else {
            Err(ureq::Error::HostNotFound)
        }
    }
}

/// Fetches the pictures a message links (a few at a time, each and all of them up to a size).
fn fetch_images(urls: Vec<String>) -> HashMap<String, String> {
    const MAX_IMAGES: usize = 80;
    const MAX_EACH: u64 = 4 << 20;
    let mut unique: Vec<String> = Vec::new();
    for url in urls {
        if !unique.contains(&url) && unique.len() < MAX_IMAGES {
            unique.push(url);
        }
    }
    let config = ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(8)))
        .timeout_global(Some(std::time::Duration::from_secs(20)))
        .max_redirects(4)
        .proxy(None)
        .http_status_as_error(false)
        .build();
    let agent = ureq::Agent::with_parts(config, ureq::unversioned::transport::DefaultConnector::default(), PublicOnly::default());
    let out = Mutex::new(HashMap::new());
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..unique.len().min(8) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(url) = unique.get(i) else { break };
                let Ok(response) = agent.get(url).header("User-Agent", "Mozilla/5.0").header("Accept", "image/*").call() else { continue };
                if response.status().as_u16() != 200 {
                    continue;
                }
                let mime = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
                let Ok(bytes) = response.into_body().with_config().limit(MAX_EACH).read_to_vec() else { continue };
                let mime = if mime.starts_with("image/") { mime } else { sniff(&bytes).to_string() };
                if mime.is_empty() {
                    continue;
                }
                out.lock().unwrap_or_else(|e| e.into_inner()).insert(url.clone(), data_url(&mime, &bytes));
            });
        }
    });
    out.into_inner().unwrap_or_else(|e| e.into_inner())
}

/// A picture's type by its first bytes, "" when it isn't one.
fn sniff(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => "",
    }
}

fn unsubscribe(msg: &mail_parser::Message<'_>) -> Option<String> {
    let raw = msg.header_raw("List-Unsubscribe")?;
    let targets: Vec<&str> = raw.split('<').skip(1).filter_map(|s| s.split('>').next()).map(str::trim).collect();
    targets.iter().find(|t| t.starts_with("https://")).or_else(|| targets.iter().find(|t| t.starts_with("mailto:"))).map(|t| t.to_string())
}

/// The message as the page shows it. `load_images` fetches the pictures it links from the web.
pub fn body(raw: &[u8], load_images: bool) -> Body {
    let Some(msg) = MessageParser::default().parse(raw) else { return Body { text: String::from_utf8_lossy(raw).into_owned(), ..Body::default() } };
    let source = html_of(&msg);
    let attachments = files(&msg, source.as_deref())
        .into_iter()
        .map(|(index, part)| Attachment { index, name: file_name(part, index), mime: mime_of(part), size: part.len() })
        .collect();
    let mut blocked_images = false;
    let html = source.map(|source| {
        let cids = Arc::new(inline_images(&msg));
        if load_images {
            let urls = Arc::new(Mutex::new(Vec::new()));
            clean(&source, cids.clone(), Remote::Collect(urls.clone()));
            let urls = std::mem::take(&mut *urls.lock().unwrap_or_else(|e| e.into_inner()));
            let images = if urls.is_empty() { HashMap::new() } else { fetch_images(urls) };
            clean(&source, cids, Remote::Fill(Arc::new(images)))
        } else {
            let found = Arc::new(Mutex::new(false));
            let html = clean(&source, cids, Remote::Block(found.clone()));
            blocked_images = *found.lock().unwrap_or_else(|e| e.into_inner());
            html
        }
    });
    Body { html, text: text_of(&msg), attachments, blocked_images, unsubscribe: unsubscribe(&msg) }
}

/// One of the message's files: its name, type and bytes.
pub fn attachment(raw: &[u8], index: usize) -> Option<(String, String, Vec<u8>)> {
    let msg = MessageParser::default().parse(raw)?;
    let part = msg.attachments().nth(index)?;
    Some((file_name(part, index), mime_of(part), part.contents().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGE: &str = concat!(
        "From: =?UTF-8?Q?Ann_Sm=C3=AEth?= <ann@example.com>\r\n",
        "To: Me <me@example.com>, you@example.com\r\n",
        "Subject: =?utf-8?B?SGVsbG8g4pi6?=\r\n   there\r\n",
        "Message-ID: <m2@example.com>\r\n",
        "In-Reply-To: <m1@example.com>\r\n",
        "References: <m0@example.com> <m1@example.com>\r\n",
        "Date: Sat, 20 Nov 2021 14:22:01 +0000\r\n",
        "List-Unsubscribe: <mailto:leave@example.com>, <https://example.com/leave?u=1>\r\n",
        "Content-Type: multipart/mixed; boundary=\"b\"\r\n",
        "\r\n",
        "--b\r\n",
        "Content-Type: text/html; charset=utf-8\r\n",
        "\r\n",
        "<html><body onload=\"evil()\"><p style=\"color:red\">Hi <b>there</b></p><script>alert(1)</script>",
        "<img src=\"cid:pic1\"><img src=\"https://tracker.example/p.gif\"><a href=\"javascript:alert(1)\">x</a>",
        "<a href=\"https://example.com/a?b=1&amp;c=2\">link</a><form action=\"https://evil\"><input name=\"p\"></form></body></html>\r\n",
        "--b\r\n",
        "Content-Type: image/png\r\n",
        "Content-ID: <pic1>\r\n",
        "Content-Disposition: inline\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "\r\n",
        "iVBORw0KGgo=\r\n",
        "--b\r\n",
        "Content-Type: application/pdf; name=\"../Report.pdf\"\r\n",
        "Content-Disposition: attachment\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "\r\n",
        "JVBERi0=\r\n",
        "--b--\r\n",
    );

    #[test]
    fn headers_are_decoded() {
        let h = header(MESSAGE.as_bytes());
        assert_eq!(h.from, Address { name: "Ann Smîth".into(), addr: "ann@example.com".into() });
        assert_eq!(h.to.iter().map(|a| a.addr.as_str()).collect::<Vec<_>>(), ["me@example.com", "you@example.com"]);
        assert_eq!(h.subject, "Hello ☺ there");
        assert_eq!((h.message_id.as_str(), h.in_reply_to.as_str()), ("m2@example.com", "m1@example.com"));
        assert_eq!(h.refs, ["m0@example.com", "m1@example.com"]);
        assert_eq!(h.date, 1_637_418_121);
        assert!(h.attachments);
    }

    #[test]
    fn html_is_cleaned_and_web_pictures_wait() {
        let b = body(MESSAGE.as_bytes(), false);
        let html = b.html.expect("an HTML part");
        assert!(html.contains("<b>there</b>") && html.contains("color:red"), "formatting stays: {html}");
        for bad in ["script", "onload", "javascript:", "<form", "<input", "tracker.example"] {
            assert!(!html.contains(bad), "{bad} must be gone: {html}");
        }
        assert!(html.contains("data:image/png;base64,iVBORw0KGgo="), "the picture it carries shows: {html}");
        assert!(html.contains("https://example.com/a?b=1&amp;c=2"));
        assert!(b.blocked_images);
        assert_eq!(b.unsubscribe.as_deref(), Some("https://example.com/leave?u=1"));
        // The picture shown in place isn't offered as a file; the PDF is, under a safe name.
        assert_eq!(b.attachments.len(), 1);
        assert_eq!((b.attachments[0].name.as_str(), b.attachments[0].mime.as_str(), b.attachments[0].size), ("_Report.pdf", "application/pdf", 5));
        let (name, _, bytes) = attachment(MESSAGE.as_bytes(), b.attachments[0].index).unwrap();
        assert_eq!((name.as_str(), bytes.as_slice()), ("_Report.pdf", &b"%PDF-"[..]));
    }

    #[test]
    fn pictures_are_only_fetched_from_the_internet() {
        for local in ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd12::1", "::ffff:192.168.1.1", "::ffff:127.0.0.1"] {
            assert!(!is_public(local.parse().unwrap()), "{local} is not out on the internet");
        }
        for public in ["8.8.8.8", "142.250.70.14", "2606:4700::1111"] {
            assert!(is_public(public.parse().unwrap()), "{public} is");
        }
        // A picture on this computer (and one that names it another way) is never fetched.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let fetched = fetch_images(vec![format!("http://127.0.0.1:{port}/a.png"), format!("http://localhost:{port}/b.png"), format!("http://[::1]:{port}/c.png")]);
        assert!(fetched.is_empty());
        assert!(listener.accept().is_err(), "nothing connected");
    }

    #[test]
    fn a_plain_message_stays_plain() {
        let raw = b"From: a@example.com\r\nSubject: Hi\r\n\r\nLine one\r\nLine   two\r\n";
        let b = body(raw, false);
        assert!(b.html.is_none());
        assert!(b.text.contains("Line one"));
        let s = summary(raw);
        assert_eq!(s.snippet, "Line one Line two");
        assert!(!s.attachments);
    }
}
