//! Working out an account's servers from its address, so adding one takes an address and a
//! password: the big providers are known here; for any other domain Zazabor asks the domain
//! itself, then Thunderbird's public list of providers (which also says who handles the domain's
//! mail, so an address at a company's own domain finds Google or Microsoft), and failing all of
//! that tries the usual names.

use serde::Serialize;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use super::db::Server;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// Who runs the mail ("Gmail"), "" when unknown.
    pub provider: String,
    pub imap: Server,
    pub smtp: Server,
    pub username: String,
    /// What to know before signing in (an app password is needed, and where to make one).
    pub note: String,
    pub help_url: String,
    /// The provider has a sign-in of its own that Zazabor can use: "google", "microsoft" or "".
    pub sign_in: String,
    /// The servers are a guess: show them to be checked.
    pub guessed: bool,
}

struct Known {
    name: &'static str,
    domains: &'static [&'static str],
    /// What the domain's mail servers (MX) are called, for addresses at a custom domain.
    mx: &'static [&'static str],
    imap: (&'static str, u16, &'static str),
    smtp: (&'static str, u16, &'static str),
    note: &'static str,
    help_url: &'static str,
}

const KNOWN: &[Known] = &[
    Known {
        name: "Gmail",
        domains: &["gmail.com", "googlemail.com"],
        mx: &["google.com", "googlemail.com"],
        imap: ("imap.gmail.com", 993, "ssl"),
        smtp: ("smtp.gmail.com", 465, "ssl"),
        note: "Sign in with Google above. With a password instead, Google wants an app password, not your usual one: turn on 2-Step Verification, then make one for Zazabor.",
        help_url: "https://myaccount.google.com/apppasswords",
    },
    Known {
        name: "Outlook",
        domains: &["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.com.au", "hotmail.co.uk", "live.com.au"],
        mx: &["outlook.com", "protection.outlook.com"],
        imap: ("outlook.office365.com", 993, "ssl"),
        smtp: ("smtp-mail.outlook.com", 587, "starttls"),
        note: "Sign in with Microsoft above: Microsoft no longer takes a password from mail apps.",
        help_url: "",
    },
    Known {
        name: "Yahoo Mail",
        domains: &["yahoo.com", "yahoo.co.uk", "yahoo.com.au", "ymail.com", "rocketmail.com"],
        mx: &["yahoodns.net"],
        imap: ("imap.mail.yahoo.com", 993, "ssl"),
        smtp: ("smtp.mail.yahoo.com", 465, "ssl"),
        note: "Yahoo wants an app password here: make one under Account security.",
        help_url: "https://login.yahoo.com/account/security",
    },
    Known {
        name: "iCloud Mail",
        domains: &["icloud.com", "me.com", "mac.com"],
        mx: &["icloud.com"],
        imap: ("imap.mail.me.com", 993, "ssl"),
        smtp: ("smtp.mail.me.com", 587, "starttls"),
        note: "Apple wants an app-specific password here: make one under Sign-In and Security.",
        help_url: "https://account.apple.com/account/manage",
    },
    Known {
        name: "Fastmail",
        domains: &["fastmail.com", "fastmail.fm", "fastmail.com.au"],
        mx: &["messagingengine.com"],
        imap: ("imap.fastmail.com", 993, "ssl"),
        smtp: ("smtp.fastmail.com", 465, "ssl"),
        note: "Fastmail wants an app password here: make one under Settings → Privacy & Security.",
        help_url: "https://app.fastmail.com/settings/security/integrations",
    },
    Known {
        name: "Zoho Mail",
        domains: &["zoho.com", "zohomail.com"],
        mx: &["zoho.com"],
        imap: ("imap.zoho.com", 993, "ssl"),
        smtp: ("smtp.zoho.com", 465, "ssl"),
        note: "Turn on IMAP in Zoho Mail's settings first. With two-step sign-in, use an app password.",
        help_url: "https://accounts.zoho.com/home#security/app_password",
    },
    Known {
        name: "AOL Mail",
        domains: &["aol.com"],
        mx: &["aol.com"],
        imap: ("imap.aol.com", 993, "ssl"),
        smtp: ("smtp.aol.com", 465, "ssl"),
        note: "AOL wants an app password here: make one under Account security.",
        help_url: "https://login.aol.com/account/security",
    },
    Known {
        name: "Proton Mail",
        domains: &["proton.me", "protonmail.com", "pm.me"],
        mx: &["protonmail.ch"],
        imap: ("127.0.0.1", 1143, "starttls"),
        smtp: ("127.0.0.1", 1025, "starttls"),
        note: "Proton Mail reaches mail apps through Proton Mail Bridge: start it, and use the password Bridge shows for this address.",
        help_url: "https://proton.me/mail/bridge",
    },
    Known {
        name: "Yandex Mail",
        domains: &["yandex.com", "yandex.ru"],
        mx: &["yandex.net", "yandex.ru"],
        imap: ("imap.yandex.com", 993, "ssl"),
        smtp: ("smtp.yandex.com", 465, "ssl"),
        note: "Yandex wants an app password here.",
        help_url: "https://id.yandex.com/security/app-passwords",
    },
    Known {
        name: "GMX",
        domains: &["gmx.com", "gmx.net", "gmx.de"],
        mx: &["gmx.net"],
        imap: ("imap.gmx.com", 993, "ssl"),
        smtp: ("mail.gmx.com", 587, "starttls"),
        note: "Turn on IMAP in GMX's settings first.",
        help_url: "",
    },
];

fn server((host, port, security): (&str, u16, &str)) -> Server {
    Server { host: host.into(), port, security: security.into() }
}

fn of(known: &Known, email: &str) -> Setup {
    Setup {
        provider: known.name.into(),
        imap: server(known.imap),
        smtp: server(known.smtp),
        username: email.into(),
        note: known.note.into(),
        help_url: known.help_url.into(),
        sign_in: match known.name {
            "Gmail" => "google",
            "Outlook" => "microsoft",
            _ => "",
        }
        .into(),
        guessed: false,
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(5)))
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn get(url: &str) -> Option<String> {
    let response = agent().get(url).header("User-Agent", "Zazabor").call().ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    let bytes = response.into_body().with_config().limit(256 << 10).read_to_vec().ok()?;
    String::from_utf8(bytes).ok()
}

/// The text of `<tag …>…</tag>` inside `xml`.
fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = xml.find(&format!("<{name}"))?;
    let start = open + xml[open..].find('>')? + 1;
    let end = start + xml[start..].find(&format!("</{name}>"))?;
    Some(xml[start..end].trim())
}

/// The first `<kind type="protocol">` block of a Thunderbird-style config.
fn block<'a>(xml: &'a str, kind: &str, protocol: &str) -> Option<&'a str> {
    let mut rest = xml;
    loop {
        let open = rest.find(&format!("<{kind}"))?;
        let end = open + rest[open..].find(&format!("</{kind}>"))?;
        let found = &rest[open..end];
        let head = &found[..found.find('>')?];
        if head.contains(&format!("type=\"{protocol}\"")) {
            return Some(found);
        }
        rest = &rest[end + 1..];
    }
}

fn parse_server(block: &str) -> Option<Server> {
    let host = tag(block, "hostname")?.to_string();
    let port: u16 = tag(block, "port")?.parse().ok()?;
    let security = match tag(block, "socketType")?.to_ascii_uppercase().as_str() {
        "SSL" => "ssl",
        "STARTTLS" => "starttls",
        _ => "none",
    };
    (!host.is_empty() && !host.contains('%')).then(|| Server { host, port, security: security.into() })
}

/// Reads a Thunderbird-style "autoconfig" file.
fn parse_autoconfig(xml: &str, email: &str) -> Option<Setup> {
    let incoming = block(xml, "incomingServer", "imap")?;
    let outgoing = block(xml, "outgoingServer", "smtp")?;
    let (local, domain) = email.split_once('@')?;
    let username = tag(incoming, "username").unwrap_or("%EMAILADDRESS%").replace("%EMAILADDRESS%", email).replace("%EMAILLOCALPART%", local).replace("%EMAILDOMAIN%", domain);
    Some(Setup {
        provider: tag(xml, "displayShortName").or_else(|| tag(xml, "displayName")).unwrap_or("").to_string(),
        imap: parse_server(incoming)?,
        smtp: parse_server(outgoing)?,
        username,
        note: String::new(),
        help_url: String::new(),
        sign_in: String::new(),
        guessed: false,
    })
}

fn reachable(host: &str, port: u16) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else { return false };
    addrs.take(2).any(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_ok())
}

/// The first of these servers that answers.
fn first_reachable(candidates: &[(String, u16, &'static str)]) -> Option<Server> {
    let found = std::sync::Mutex::new(vec![false; candidates.len()]);
    std::thread::scope(|scope| {
        for (i, (host, port, _)) in candidates.iter().enumerate() {
            let found = &found;
            scope.spawn(move || {
                if reachable(host, *port) {
                    found.lock().unwrap_or_else(|e| e.into_inner())[i] = true;
                }
            });
        }
    });
    let found = found.into_inner().unwrap_or_else(|e| e.into_inner());
    candidates.iter().zip(found).find(|(_, ok)| *ok).map(|((host, port, security), _)| Server { host: host.clone(), port: *port, security: (*security).into() })
}

/// The servers for an address. Always answers: failing everything else, with the usual names.
pub fn discover(email: &str) -> Setup {
    let email = email.trim();
    let domain = email.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    if let Some(known) = KNOWN.iter().find(|k| k.domains.contains(&domain.as_str())) {
        return of(known, email);
    }
    let valid = !domain.is_empty() && domain.contains('.') && domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if valid && !super::offline() {
        // The domain's own answer, then Thunderbird's list.
        let own = [format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={email}"), format!("https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml")];
        if let Some(setup) = own.iter().find_map(|url| get(url)).and_then(|xml| parse_autoconfig(&xml, email)) {
            return setup;
        }
        if let Some(setup) = get(&format!("https://autoconfig.thunderbird.net/v1.1/{domain}")).and_then(|xml| parse_autoconfig(&xml, email)) {
            return setup;
        }
        // Who handles the domain's mail: a company address is often Google's or Microsoft's.
        if let Some(mx) = get(&format!("https://mx.thunderbird.net/dns/mx/{domain}")) {
            let hosts: Vec<String> = mx.lines().map(|l| l.trim().trim_end_matches('.').to_ascii_lowercase()).filter(|l| !l.is_empty()).collect();
            if let Some(known) = KNOWN.iter().find(|k| hosts.iter().any(|h| k.mx.iter().any(|m| h == m || h.ends_with(&format!(".{m}"))))) {
                let mut setup = of(known, email);
                if known.name == "Gmail" {
                    setup.provider = "Google Workspace".into();
                } else if known.name == "Outlook" {
                    setup.provider = "Microsoft 365".into();
                    setup.smtp = server(("smtp.office365.com", 587, "starttls"));
                }
                return setup;
            }
        }
    }
    let names = |prefixes: &[&str], ports: &[(u16, &'static str)]| -> Vec<(String, u16, &'static str)> {
        let mut out = Vec::new();
        for prefix in prefixes {
            for (port, security) in ports {
                out.push((format!("{prefix}.{domain}"), *port, *security));
            }
        }
        out
    };
    let probe = valid && !super::offline();
    let imap = probe.then(|| first_reachable(&names(&["imap", "mail"], &[(993, "ssl"), (143, "starttls")]))).flatten();
    let smtp = probe.then(|| first_reachable(&names(&["smtp", "mail"], &[(465, "ssl"), (587, "starttls")]))).flatten();
    Setup {
        provider: String::new(),
        imap: imap.unwrap_or_else(|| Server { host: format!("imap.{domain}"), port: 993, security: "ssl".into() }),
        smtp: smtp.unwrap_or_else(|| Server { host: format!("smtp.{domain}"), port: 465, security: "ssl".into() }),
        username: email.into(),
        note: String::new(),
        help_url: String::new(),
        sign_in: String::new(),
        guessed: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_providers_need_no_lookup() {
        let setup = discover("someone@gmail.com");
        assert_eq!((setup.provider.as_str(), setup.imap.host.as_str(), setup.imap.port), ("Gmail", "imap.gmail.com", 993));
        assert_eq!((setup.smtp.host.as_str(), setup.smtp.security.as_str()), ("smtp.gmail.com", "ssl"));
        assert!(!setup.guessed && setup.note.contains("app password"));
        assert_eq!((setup.sign_in.as_str(), discover("x@hotmail.com").sign_in.as_str(), discover("x@icloud.com").sign_in.as_str()), ("google", "microsoft", ""));
        assert_eq!(discover("x@icloud.com").smtp, Server { host: "smtp.mail.me.com".into(), port: 587, security: "starttls".into() });
    }

    #[test]
    fn autoconfig_files_are_read() {
        let xml = r#"<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="example.com">
          <displayName>Example Mail</displayName><displayShortName>Example</displayShortName>
          <incomingServer type="pop3"><hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
          <incomingServer type="imap"><hostname>imap.example.com</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer>
          <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>465</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></outgoingServer>
        </emailProvider></clientConfig>"#;
        let setup = parse_autoconfig(xml, "ann@example.com").unwrap();
        assert_eq!(setup.provider, "Example");
        assert_eq!(setup.imap, Server { host: "imap.example.com".into(), port: 143, security: "starttls".into() });
        assert_eq!(setup.smtp, Server { host: "smtp.example.com".into(), port: 465, security: "ssl".into() });
        assert_eq!(setup.username, "ann");
        assert!(parse_autoconfig("<clientConfig></clientConfig>", "ann@example.com").is_none());
    }
}
