//! Signing in through the provider's own page (OAuth 2 with PKCE), for the accounts that take no
//! password from a mail app: Google and Microsoft. The browser opens the provider's sign-in; it
//! sends the answer back to a one-time address on this computer; Zazabor trades that for tokens.
//! The password never passes through Zazabor. What's kept (in the keyring, like a password) is
//! the refresh token, which only gets new access tokens for mail; an access token lasts about an
//! hour and is renewed when it runs out.
//!
//! Each provider only talks to an app it knows by a client ID, registered by whoever ships the
//! app. Zazabor takes them from the build (`ZAZABOR_GOOGLE_CLIENT_ID`, `ZAZABOR_GOOGLE_CLIENT_SECRET`,
//! `ZAZABOR_MICROSOFT_CLIENT_ID`) or from what was entered in the account sheet (`mail/oauth.json`).
//! A desktop app's Google "secret" is not a secret (Google says so): it only names the app.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::db::Server;

type Result<T> = std::result::Result<T, String>;

/// How long the browser has to come back.
const WAIT: Duration = Duration::from_secs(5 * 60);
/// A token this close to running out is renewed first.
const MARGIN: i64 = 120;

static CANCEL: AtomicBool = AtomicBool::new(false);
/// One renewal at a time: a provider may retire a refresh token as it hands out the next.
static RENEWING: Mutex<()> = Mutex::new(());

/// Who to sign in with.
pub struct Provider {
    /// What the account's `auth` says: "google" or "microsoft".
    pub id: &'static str,
    pub name: &'static str,
    pub auth_url: String,
    pub token_url: String,
    scope: &'static str,
    /// The address the browser comes back to names this computer as the provider wants it.
    loopback: &'static str,
    extra: &'static [(&'static str, &'static str)],
}

pub fn provider(id: &str) -> Result<Provider> {
    match id {
        "google" => Ok(Provider {
            id: "google",
            name: "Google",
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            scope: "https://mail.google.com/ openid email profile",
            loopback: "127.0.0.1",
            // Without these Google gives no refresh token the second time someone signs in.
            extra: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        "microsoft" => Ok(Provider {
            id: "microsoft",
            name: "Microsoft",
            auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token".into(),
            scope: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile",
            loopback: "localhost",
            extra: &[("response_mode", "query"), ("prompt", "select_account")],
        }),
        _ => Err("Zazabor Home can't sign in with that provider.".into()),
    }
}

/// The mail servers of an account signed in this way.
pub fn servers(provider: &str, email: &str) -> (Server, Server) {
    let server = |host: &str, port: u16, security: &str| Server { host: host.into(), port, security: security.into() };
    if provider == "google" {
        return (server("imap.gmail.com", 993, "ssl"), server("smtp.gmail.com", 465, "ssl"));
    }
    let domain = email.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    let personal = ["outlook.", "hotmail.", "live.", "msn."].iter().any(|d| domain.starts_with(d));
    (server("outlook.office365.com", 993, "ssl"), server(if personal { "smtp-mail.outlook.com" } else { "smtp.office365.com" }, 587, "starttls"))
}

// ---- the app's registrations

/// The client IDs the providers know Zazabor by.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Clients {
    pub google_id: String,
    pub google_secret: String,
    pub microsoft_id: String,
}

fn clients_path(dir: &Path) -> std::path::PathBuf {
    dir.join("oauth.json")
}

/// What was entered here, else what the build came with.
pub fn clients(dir: &Path) -> Clients {
    let saved: Clients = std::fs::read(clients_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let or = |saved: String, built: Option<&str>| if saved.is_empty() { built.unwrap_or("").to_string() } else { saved };
    Clients {
        google_secret: if saved.google_id.is_empty() { option_env!("ZAZABOR_GOOGLE_CLIENT_SECRET").unwrap_or("").to_string() } else { saved.google_secret },
        google_id: or(saved.google_id, option_env!("ZAZABOR_GOOGLE_CLIENT_ID")),
        microsoft_id: or(saved.microsoft_id, option_env!("ZAZABOR_MICROSOFT_CLIENT_ID")),
    }
}

pub fn save_clients(dir: &Path, clients: &Clients) -> Result<()> {
    let clean = |s: &str| -> Result<String> {
        let s = s.trim();
        if s.len() > 300 || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err("That doesn't look like a client ID. Copy it whole, without spaces.".into());
        }
        Ok(s.to_string())
    };
    let clients = Clients { google_id: clean(&clients.google_id)?, google_secret: clean(&clients.google_secret)?, microsoft_id: clean(&clients.microsoft_id)? };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    crate::fs::text::write_bytes(&clients_path(dir), &serde_json::to_vec_pretty(&clients).map_err(|e| e.to_string())?)?;
    Ok(())
}

/// The provider's client ID and (Google) secret, or why there's no signing in yet.
fn client_of(provider: &Provider, clients: &Clients) -> Result<(String, String)> {
    let (id, secret) = if provider.id == "google" { (clients.google_id.clone(), clients.google_secret.clone()) } else { (clients.microsoft_id.clone(), String::new()) };
    if id.is_empty() {
        return Err(format!("Signing in with {} needs a client ID first.", provider.name));
    }
    Ok((id, secret))
}

// ---- tokens

/// What's kept for an account signed in this way (as its secret, in the keyring).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Tokens {
    pub refresh: String,
    pub access: String,
    /// When the access token runs out (seconds since the epoch).
    pub expires: i64,
}

/// What a sign-in gives: who signed in, and their tokens.
#[derive(Debug)]
pub struct Grant {
    pub email: String,
    pub name: String,
    pub tokens: Tokens,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TokenAnswer {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    id_token: String,
    error: String,
    error_description: String,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(15))).timeout_global(Some(Duration::from_secs(40))).http_status_as_error(false).build().into()
}

fn random(bytes: usize) -> String {
    use ring::rand::SecureRandom;
    let mut buf = vec![0u8; bytes];
    ring::rand::SystemRandom::new().fill(&mut buf).expect("the system's random numbers");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Asks the provider's token address; an error answer becomes its own words.
fn ask(provider: &Provider, form: &[(&str, &str)]) -> Result<TokenAnswer> {
    let response = agent().post(&provider.token_url).send_form(form.iter().copied()).map_err(|e| format!("Couldn't reach {}: {e}", provider.name))?;
    let body = response.into_body().with_config().limit(1 << 20).read_to_string().map_err(|e| format!("{} didn't answer: {e}", provider.name))?;
    let answer: TokenAnswer = serde_json::from_str(&body).map_err(|_| format!("{} gave an answer Zazabor Home can't read.", provider.name))?;
    if !answer.error.is_empty() || answer.access_token.is_empty() {
        let why = answer.error_description.lines().next().unwrap_or("").trim().to_string();
        return Err(match answer.error.as_str() {
            "invalid_grant" => format!("{} wants you to sign in again. {why}", provider.name),
            "invalid_client" | "unauthorized_client" => format!("{} doesn't accept the client ID. Check it in the account sheet. {why}", provider.name),
            _ => format!("{} refused: {}", provider.name, if why.is_empty() { answer.error.clone() } else { why }),
        }
        .trim()
        .to_string());
    }
    Ok(answer)
}

/// The address and name an ID token is for. It came straight from the provider over TLS, so it
/// is read, not verified.
fn identity(id_token: &str) -> (String, String) {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Claims {
        email: String,
        preferred_username: String,
        name: String,
    }
    let claims: Claims = id_token
        .split('.')
        .nth(1)
        .and_then(|part| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let email = if claims.email.contains('@') { claims.email } else { claims.preferred_username };
    (email, claims.name)
}

/// A request the browser made to the one-time address: its query, when it's the answer.
fn read_answer(stream: &mut std::net::TcpStream) -> Option<Vec<(String, String)>> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = [0u8; 8192];
    let mut len = 0;
    while len < buf.len() && !buf[..len].windows(2).any(|w| w == b"\r\n") {
        match stream.read(&mut buf[len..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => len += n,
        }
    }
    let line = String::from_utf8_lossy(&buf[..len]);
    let target = line.lines().next()?.split_whitespace().nth(1)?.to_string();
    let url = url::Url::parse(&format!("http://localhost{target}")).ok()?;
    let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    query.iter().any(|(k, _)| k == "code" || k == "error").then_some(query)
}

fn reply(stream: &mut std::net::TcpStream, ok: bool, heading: &str, text: &str) {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Zazabor Home</title><style>body{{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0e0f11;color:#e8e8ea}}main{{text-align:center;max-width:420px;padding:24px}}h1{{font-size:22px;margin:0 0 8px}}p{{color:#a0a0a8;line-height:1.5}}</style></head><body><main><h1>{heading}</h1><p>{text}</p></main></body></html>"
    );
    let status = if ok { "200 OK" } else { "400 Bad Request" };
    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
    let _ = stream.flush();
}

/// Stops a sign-in that's waiting for the browser.
pub fn cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Signs in: opens the provider's page with `open`, waits for the browser to come back, and
/// trades the answer for tokens. `hint` is the address to sign in as, when it's known.
pub fn sign_in(provider: &Provider, clients: &Clients, hint: Option<&str>, open: impl FnOnce(&str) -> Result<()>) -> Result<Grant> {
    let (client_id, secret) = client_of(provider, clients)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Zazabor Home can't listen for the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // A browser may take "localhost" for the IPv6 loopback.
    let also = (provider.loopback == "localhost").then(|| TcpListener::bind(("::1", port)).ok()).flatten();
    for l in std::iter::once(&listener).chain(also.iter()) {
        l.set_nonblocking(true).map_err(|e| e.to_string())?;
    }
    let redirect = format!("http://{}:{port}", provider.loopback);
    let verifier = random(48);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    let state = random(24);
    let mut params: Vec<(&str, &str)> = vec![
        ("client_id", &client_id), ("redirect_uri", &redirect), ("response_type", "code"), ("scope", provider.scope),
        ("code_challenge", &challenge), ("code_challenge_method", "S256"), ("state", &state),
    ];
    params.extend_from_slice(provider.extra);
    if let Some(hint) = hint.filter(|h| h.contains('@')) {
        params.push(("login_hint", hint));
    }
    let url = url::Url::parse_with_params(&provider.auth_url, &params).map_err(|e| e.to_string())?;
    CANCEL.store(false, Ordering::SeqCst);
    open(url.as_str())?;

    let deadline = Instant::now() + WAIT;
    let code = loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled.".into());
        }
        if Instant::now() > deadline {
            return Err(format!("The sign-in wasn't finished in the browser. Try again when you're ready."));
        }
        let Some((mut stream, _)) = std::iter::once(&listener).chain(also.iter()).find_map(|l| l.accept().ok()) else {
            std::thread::sleep(Duration::from_millis(120));
            continue;
        };
        let _ = stream.set_nonblocking(false);
        // Browsers also ask for an icon: only the answer counts.
        let Some(query) = read_answer(&mut stream) else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        };
        let get = |name: &str| query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str()).unwrap_or("");
        if get("state") != state {
            reply(&mut stream, false, "This isn't the sign-in Zazabor Home started", "Go back to Zazabor Home and try again.");
            continue;
        }
        if !get("error").is_empty() {
            reply(&mut stream, false, "Not signed in", "You can close this tab and go back to Zazabor Home.");
            let why = get("error_description");
            return Err(if get("error") == "access_denied" { format!("{} didn't get permission to read your mail.", provider.name) } else { format!("{} refused: {}", provider.name, if why.is_empty() { get("error") } else { why }) });
        }
        reply(&mut stream, true, "You're signed in", "You can close this tab and go back to Zazabor Home.");
        break get("code").to_string();
    };

    let mut form = vec![("client_id", client_id.as_str()), ("code", code.as_str()), ("redirect_uri", redirect.as_str()), ("grant_type", "authorization_code"), ("code_verifier", verifier.as_str())];
    if !secret.is_empty() {
        form.push(("client_secret", &secret));
    }
    let answer = ask(provider, &form)?;
    if answer.refresh_token.is_empty() {
        return Err(format!("{} signed you in but gave nothing to stay signed in with. Remove Zazabor Home under your account's connected apps and sign in again.", provider.name));
    }
    let (email, name) = identity(&answer.id_token);
    if !email.contains('@') {
        return Err(format!("{} didn't say which address signed in.", provider.name));
    }
    Ok(Grant { email, name, tokens: Tokens { refresh: answer.refresh_token, access: answer.access_token, expires: super::now() + answer.expires_in.max(60) } })
}

/// A new access token from the refresh token.
pub fn renew(provider: &Provider, clients: &Clients, tokens: &Tokens) -> Result<Tokens> {
    let (client_id, secret) = client_of(provider, clients)?;
    let mut form = vec![("client_id", client_id.as_str()), ("refresh_token", tokens.refresh.as_str()), ("grant_type", "refresh_token")];
    if !secret.is_empty() {
        form.push(("client_secret", &secret));
    }
    let answer = ask(provider, &form)?;
    Ok(Tokens {
        refresh: if answer.refresh_token.is_empty() { tokens.refresh.clone() } else { answer.refresh_token },
        access: answer.access_token,
        expires: super::now() + answer.expires_in.max(60),
    })
}

/// An access token that still works for the account, renewed (and kept) when the one held has
/// run out. `secret` is what's kept for the account; `keep` stores what replaces it.
pub fn access_token(provider: &Provider, clients: &Clients, secret: impl Fn() -> Option<String>, keep: impl FnOnce(&str) -> Result<()>) -> Result<String> {
    let _one = RENEWING.lock().unwrap_or_else(|e| e.into_inner());
    let again = || format!("Sign in to {} again in the account's settings.", provider.name);
    let tokens: Tokens = secret().and_then(|s| serde_json::from_str(&s).ok()).ok_or_else(again)?;
    if tokens.expires - MARGIN > super::now() {
        return Ok(tokens.access);
    }
    let renewed = renew(provider, clients, &tokens)?;
    keep(&serde_json::to_string(&renewed).map_err(|e| e.to_string())?)?;
    Ok(renewed.access)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id_token(claims: &str) -> String {
        format!("e30.{}.sig", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims))
    }

    /// A stand-in for a provider's token address: answers each request with the next body, and
    /// hands back what it was sent.
    fn token_server(answers: Vec<String>) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for answer in answers {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut seen = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    seen.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&seen).to_string();
                    let Some(split) = text.find("\r\n\r\n") else { if n == 0 { break } else { continue } };
                    let length: usize = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))).unwrap_or(0);
                    if seen.len() >= split + 4 + length || n == 0 {
                        let _ = tx.send(text[split + 4..].to_string());
                        break;
                    }
                }
                let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}", answer.len()).as_bytes());
            }
        });
        (url, rx)
    }

    fn test_provider(token_url: String) -> Provider {
        Provider { token_url, auth_url: "http://127.0.0.1:9/authorize".into(), ..provider("microsoft").unwrap() }
    }

    fn clients() -> Clients {
        Clients { google_id: "g-id".into(), google_secret: "g-secret".into(), microsoft_id: "ms-id".into() }
    }

    #[test]
    fn a_sign_in_goes_out_with_pkce_and_comes_back_with_tokens() {
        let answer = format!(r#"{{"access_token":"at-1","refresh_token":"rt-1","expires_in":3600,"id_token":"{}"}}"#, id_token(r#"{"preferred_username":"ann@contoso.example","name":"Ann Lee"}"#));
        let (token_url, sent) = token_server(vec![answer]);
        let p = test_provider(token_url);
        // The "browser": reads where it was sent, then comes back the way the provider would.
        let grant = sign_in(&p, &clients(), Some("ann@contoso.example"), |url| {
            let url = url::Url::parse(url).unwrap();
            let get = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned()).unwrap_or_default();
            assert_eq!((get("client_id").as_str(), get("response_type").as_str(), get("code_challenge_method").as_str()), ("ms-id", "code", "S256"));
            assert_eq!(get("login_hint"), "ann@contoso.example");
            assert!(get("scope").contains("IMAP.AccessAsUser.All") && get("scope").contains("offline_access"));
            assert_eq!(get("code_challenge").len(), 43, "a SHA-256, base64url");
            let (redirect, state) = (get("redirect_uri"), get("state"));
            assert!(redirect.starts_with("http://localhost:"));
            std::thread::spawn(move || {
                let back = redirect.replace("localhost", "127.0.0.1");
                let quiet = ureq::Agent::config_builder().http_status_as_error(false).build();
                let agent: ureq::Agent = quiet.into();
                // An icon request and an answer with the wrong state are passed over.
                let _ = agent.get(&format!("{back}/favicon.ico")).call();
                let _ = agent.get(&format!("{back}/?code=stolen&state=wrong")).call();
                let page = agent.get(&format!("{back}/?code=the-code&state={state}")).call().unwrap().into_body().read_to_string().unwrap();
                assert!(page.contains("signed in"));
            });
            Ok(())
        })
        .unwrap();
        assert_eq!((grant.email.as_str(), grant.name.as_str()), ("ann@contoso.example", "Ann Lee"));
        assert_eq!((grant.tokens.access.as_str(), grant.tokens.refresh.as_str()), ("at-1", "rt-1"));
        let form = sent.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(form.contains("code=the-code") && form.contains("grant_type=authorization_code") && form.contains("code_verifier=") && form.contains("client_id=ms-id"), "{form}");
        assert!(!form.contains("client_secret"), "Microsoft's desktop sign-in has no secret");
    }

    #[test]
    fn tokens_are_renewed_when_they_run_out_and_a_refusal_says_to_sign_in_again() {
        let (token_url, sent) = token_server(vec![r#"{"access_token":"at-2","expires_in":3600}"#.into(), r#"{"error":"invalid_grant","error_description":"Token has been revoked."}"#.into()]);
        let p = Provider { id: "google", name: "Google", ..test_provider(token_url) };
        let fresh = Tokens { refresh: "rt".into(), access: "at-1".into(), expires: super::super::now() + 3000 };
        let kept = std::cell::RefCell::new(String::new());
        let get = |t: &Tokens| {
            let secret = serde_json::to_string(t).unwrap();
            access_token(&p, &clients(), || Some(secret.clone()), |new| {
                *kept.borrow_mut() = new.to_string();
                Ok(())
            })
        };
        assert_eq!(get(&fresh).unwrap(), "at-1", "still good: nothing is asked");
        let stale = Tokens { expires: super::super::now() - 5, ..fresh.clone() };
        assert_eq!(get(&stale).unwrap(), "at-2");
        let saved: Tokens = serde_json::from_str(&kept.borrow()).unwrap();
        assert_eq!((saved.refresh.as_str(), saved.access.as_str()), ("rt", "at-2"), "the refresh token stays when no new one comes");
        let form = sent.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(form.contains("grant_type=refresh_token") && form.contains("refresh_token=rt") && form.contains("client_secret=g-secret"), "{form}");
        assert!(get(&stale).unwrap_err().contains("sign in again"));
        assert!(access_token(&p, &clients(), || None, |_| Ok(())).unwrap_err().contains("Sign in to Google again"));
    }

    #[test]
    fn who_signed_in_and_which_servers() {
        assert_eq!(identity(&id_token(r#"{"email":"me@gmail.com","name":"Me"}"#)), ("me@gmail.com".to_string(), "Me".to_string()));
        assert_eq!(identity("not-a-token").0, "");
        assert_eq!(servers("google", "me@gmail.com").0.host, "imap.gmail.com");
        assert_eq!(servers("microsoft", "me@outlook.com").1.host, "smtp-mail.outlook.com");
        assert_eq!(servers("microsoft", "me@contoso.example").1.host, "smtp.office365.com");
        assert!(client_of(&provider("google").unwrap(), &Clients::default()).unwrap_err().contains("client ID"));
    }
}
