//! Writing a message out: the page's compose sheet becomes a MIME message (text and HTML, with
//! the files attached), goes out through the account's SMTP server, and is handed back to be
//! filed in Sent.

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart};
use lettre::Transport;
use serde::Deserialize;

use super::db::{Account, Address, Message};
use super::net;

/// A file to send along: one on disk, or one a message here carries (forwarding).
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Attach {
    File { path: String },
    Part { message: i64, index: usize },
}

/// What the compose sheet sends.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    pub account_id: String,
    pub to: Vec<Address>,
    #[serde(default)]
    pub cc: Vec<Address>,
    #[serde(default)]
    pub bcc: Vec<Address>,
    pub subject: String,
    pub html: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attach>,
    /// The message this answers.
    #[serde(default)]
    pub reply_to: Option<i64>,
    #[serde(default)]
    pub draft_id: Option<String>,
}

/// The most that goes out in one message (servers refuse more).
const MAX_TOTAL: usize = 25 << 20;

fn mailbox(a: &Address) -> Result<Mailbox, String> {
    let email = a.addr.trim().parse::<lettre::Address>().map_err(|_| format!("“{}” isn't an email address.", a.addr.trim()))?;
    let name = a.name.trim();
    Ok(Mailbox::new((!name.is_empty() && name != a.addr.trim()).then(|| name.to_string()), email))
}

/// A file's name, type and bytes.
pub type Loaded = (String, String, Vec<u8>);

/// Builds the message. `files` are the attachments, already read; `original` is the message
/// being answered.
pub fn build(account: &Account, out: &Outgoing, files: Vec<Loaded>, original: Option<&Message>) -> Result<lettre::Message, String> {
    if out.to.is_empty() && out.cc.is_empty() && out.bcc.is_empty() {
        return Err("Add someone to send it to.".into());
    }
    let from = mailbox(&Address { name: account.name.clone(), addr: account.email.clone() })?;
    let domain = account.email.rsplit('@').next().unwrap_or("localhost");
    let mut builder = lettre::Message::builder()
        .from(from)
        .subject(out.subject.trim())
        .message_id(Some(format!("<{}@{domain}>", crate::notes::new_id())))
        .user_agent("Zazabor".into());
    for a in &out.to {
        builder = builder.to(mailbox(a)?);
    }
    for a in &out.cc {
        builder = builder.cc(mailbox(a)?);
    }
    for a in &out.bcc {
        builder = builder.bcc(mailbox(a)?);
    }
    if let Some(original) = original.filter(|m| !m.message_id.is_empty()) {
        let mut refs: Vec<String> = original.refs.split_whitespace().map(|id| format!("<{id}>")).collect();
        refs.push(format!("<{}>", original.message_id));
        builder = builder.in_reply_to(format!("<{}>", original.message_id)).references(refs.join(" "));
    }
    let html = format!("<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body>{}</body></html>", out.html);
    let content = MultiPart::alternative_plain_html(out.text.clone(), html);
    let total: usize = files.iter().map(|(_, _, bytes)| bytes.len()).sum();
    if total > MAX_TOTAL {
        return Err(format!("The attachments are {} MB together; mail servers take about 25 MB.", total >> 20));
    }
    let message = if files.is_empty() {
        builder.multipart(content)
    } else {
        let mut mixed = MultiPart::mixed().multipart(content);
        for (name, mime, bytes) in files {
            let content_type = ContentType::parse(&mime).unwrap_or_else(|_| ContentType::parse("application/octet-stream").expect("a valid type"));
            mixed = mixed.singlepart(Attachment::new(name).body(bytes, content_type));
        }
        builder.multipart(mixed)
    };
    message.map_err(|e| format!("The message couldn't be put together: {e}"))
}

/// Sends it; returns the message as sent, for the Sent folder.
pub fn send(account: &Account, cred: &net::Cred, message: &lettre::Message) -> Result<Vec<u8>, String> {
    let transport = net::smtp(&account.smtp, &account.username, cred)?;
    transport.send(message).map_err(|e| net::smtp_err(&account.smtp, e))?;
    Ok(message.formatted())
}

/// Checks that the outgoing server takes the account's sign-in.
pub fn check(account: &Account, cred: &net::Cred) -> Result<(), String> {
    let transport = net::smtp(&account.smtp, &account.username, cred)?;
    match transport.test_connection() {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!("{} didn't answer like a mail server.", account.smtp.host)),
        Err(e) => Err(net::smtp_err(&account.smtp, e)),
    }
}

/// Whether the provider files what's sent by itself (a copy put in Sent would show twice).
pub fn files_sent_itself(account: &Account) -> bool {
    let host = account.smtp.host.to_ascii_lowercase();
    host.ends_with("gmail.com") || host.ends_with("googlemail.com") || host.ends_with("office365.com") || host.ends_with("outlook.com")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::db::Server;

    fn account() -> Account {
        Account {
            id: "a".into(), email: "me@example.com".into(), name: "Me Myself".into(), color: "blue".into(), username: "me@example.com".into(),
            imap: Server { host: "imap.example.com".into(), port: 993, security: "ssl".into() },
            smtp: Server { host: "smtp.example.com".into(), port: 465, security: "ssl".into() },
            signature: String::new(), auth: "password".into(), synced: 0, error: None,
        }
    }

    #[test]
    fn a_reply_with_a_file_is_a_proper_message() {
        let out = Outgoing {
            account_id: "a".into(),
            to: vec![Address { name: "Ann Smîth".into(), addr: "ann@example.com".into() }],
            cc: vec![],
            bcc: vec![Address { name: String::new(), addr: "quiet@example.com".into() }],
            subject: "Re: Lunch ☺".into(),
            html: "<p>Yes!</p>".into(),
            text: "Yes!".into(),
            attachments: vec![],
            reply_to: Some(1),
            draft_id: None,
        };
        let original = Message {
            id: 1, account_id: "a".into(), folder_id: 1, folder_role: "inbox".into(), uid: 1, message_id: "m2@example.com".into(), thread_id: "m1@example.com".into(),
            subject: "Lunch".into(), from: Address::default(), to: vec![], cc: vec![], reply_to: String::new(), date: 0, size: 0, seen: true, flagged: false, answered: false,
            attachments: false, snippet: String::new(), body: true, refs: "m1@example.com".into(),
        };
        let message = build(&account(), &out, vec![("menu.txt".into(), "text/plain".into(), b"soup".to_vec())], Some(&original)).unwrap();
        let raw = message.formatted();
        let parsed = super::super::parse::header(&raw);
        assert_eq!(parsed.subject, "Re: Lunch ☺");
        assert_eq!(parsed.from, Address { name: "Me Myself".into(), addr: "me@example.com".into() });
        assert_eq!(parsed.to, [Address { name: "Ann Smîth".into(), addr: "ann@example.com".into() }]);
        assert_eq!(parsed.in_reply_to, "m2@example.com");
        assert_eq!(parsed.refs, ["m1@example.com", "m2@example.com"]);
        assert!(parsed.message_id.ends_with("@example.com"));
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("quiet@example.com"), "Bcc stays out of what's sent");
        assert!(message.envelope().to().iter().any(|a| a.to_string() == "quiet@example.com"), "but is delivered to");
        let body = super::super::parse::body(&raw, false);
        assert!(body.html.unwrap().contains("<p>Yes!</p>"));
        assert_eq!(body.attachments.iter().map(|a| (a.name.as_str(), a.size)).collect::<Vec<_>>(), [("menu.txt", 4)]);
    }

    #[test]
    fn bad_addresses_and_no_recipients_are_refused() {
        let mut out = Outgoing { account_id: "a".into(), to: vec![], cc: vec![], bcc: vec![], subject: String::new(), html: String::new(), text: String::new(), attachments: vec![], reply_to: None, draft_id: None };
        assert!(build(&account(), &out, vec![], None).is_err());
        out.to.push(Address { name: String::new(), addr: "not an address".into() });
        assert!(build(&account(), &out, vec![], None).unwrap_err().contains("isn't an email address"));
    }
}
