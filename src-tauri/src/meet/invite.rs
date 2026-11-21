//! Invitations: the e-mail text and the calendar invite (`invite.ics`, RFC 5545).

use super::store::{pretty_code, Stored};

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `20261121T143000Z`
pub fn utc_stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", t / 3600, t / 60 % 60, t % 60)
}

/// Escapes a TEXT value.
pub fn escape(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\r' => {}
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out
}

/// Folds a content line to at most 75 octets, continuation lines starting with a space. Never
/// splits a character.
pub fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut len = 0;
    let mut limit = 75;
    for c in line.chars() {
        let n = c.len_utf8();
        if len + n > limit {
            out.push_str("\r\n ");
            len = 1;
            limit = 75;
        }
        out.push(c);
        len += n;
    }
    out
}

/// A parameter value (CN=…): no quotes, and quoted when it has , ; or :.
fn param(s: &str) -> String {
    let clean: String = s.chars().filter(|c| *c != '"' && !c.is_control()).collect();
    if clean.contains([',', ';', ':']) {
        format!("\"{clean}\"")
    } else {
        clean
    }
}

/// The calendar invite for a scheduled meeting.
pub fn ics(m: &Stored, join_url: &str, organizer: (&str, &str), now_ms: i64) -> Option<String> {
    let start = m.starts_at?;
    let minutes = if m.minutes > 0 { m.minutes } else { 30 };
    let end = start + minutes * 60_000;
    let mut lines: Vec<String> = vec![
        "BEGIN:VCALENDAR".into(),
        "PRODID:-//Zazabor Home//Meet//EN".into(),
        "VERSION:2.0".into(),
        "CALSCALE:GREGORIAN".into(),
        "METHOD:REQUEST".into(),
        "BEGIN:VEVENT".into(),
        format!("UID:{}@zazabor", m.id),
        format!("DTSTAMP:{}", utc_stamp(now_ms)),
        format!("DTSTART:{}", utc_stamp(start)),
        format!("DTEND:{}", utc_stamp(end)),
        "SEQUENCE:0".into(),
        format!("SUMMARY:{}", escape(&m.title)),
        format!("DESCRIPTION:{}", escape(&description(m, join_url))),
        format!("LOCATION:{}", escape(join_url)),
        format!("URL:{join_url}"),
        "STATUS:CONFIRMED".into(),
        "TRANSP:OPAQUE".into(),
        format!("ORGANIZER;CN={}:mailto:{}", param(organizer.0), organizer.1),
    ];
    for i in &m.invitees {
        let cn = if i.name.trim().is_empty() { i.email.as_str() } else { i.name.as_str() };
        lines.push(format!("ATTENDEE;CN={};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:{}", param(cn), i.email));
    }
    lines.push("END:VEVENT".into());
    lines.push("END:VCALENDAR".into());
    Some(lines.iter().map(|l| fold(l)).collect::<Vec<_>>().join("\r\n") + "\r\n")
}

fn description(m: &Stored, join_url: &str) -> String {
    let mut d = format!("Join the meeting: {join_url}\nMeeting code: {}", pretty_code(&m.code));
    if m.auto_record {
        d.push_str("\nThis meeting will be recorded.");
    }
    d
}

pub struct Mail {
    pub subject: String,
    pub html: String,
    pub text: String,
}

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// What an invitation says. `when` is the time in words (None for an instant meeting or call).
pub fn compose(m: &Stored, join_url: &str, host: &str, when: Option<&str>, note: &str, starting: bool) -> Mail {
    let call = m.kind == "call";
    let subject = if starting {
        format!("{} is starting: join here", m.title)
    } else if call {
        format!("{host} is calling you: join")
    } else if let Some(when) = when {
        format!("Invitation: {} ({when})", m.title)
    } else {
        format!("Join now: {}", m.title)
    };
    let button = if when.is_none() || starting { "Join now" } else { "Join meeting" };
    let mut text = String::new();
    let mut html = String::from("<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1c1c1e;max-width:520px\">");
    html.push_str(&format!("<h2 style=\"margin:0 0 8px\">{}</h2>", html_escape(&m.title)));
    text.push_str(&format!("{}\n", m.title));
    if starting {
        html.push_str("<p>The meeting is starting. The link has changed, so use this one:</p>");
        text.push_str("\nThe meeting is starting. The link has changed, so use this one.\n");
    } else if call {
        html.push_str(&format!("<p>{} is calling you.</p>", html_escape(host)));
        text.push_str(&format!("\n{host} is calling you.\n"));
    } else {
        html.push_str(&format!("<p>{} invites you to a meeting.</p>", html_escape(host)));
        text.push_str(&format!("\n{host} invites you to a meeting.\n"));
    }
    if let (Some(when), false) = (when, starting) {
        html.push_str(&format!("<p><b>When:</b> {}</p>", html_escape(when)));
        text.push_str(&format!("When: {when}\n"));
    }
    if !note.trim().is_empty() {
        html.push_str(&format!("<p style=\"white-space:pre-wrap\">{}</p>", html_escape(note.trim())));
        text.push_str(&format!("\n{}\n", note.trim()));
    }
    html.push_str(&format!("<p><a href=\"{u}\" style=\"display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:10px;font-weight:600\">{button}</a></p>", u = html_escape(join_url)));
    html.push_str(&format!("<p style=\"color:#6e6e73\">Or open {u}<br>Meeting code: {c}</p>", u = html_escape(join_url), c = pretty_code(&m.code)));
    text.push_str(&format!("\n{button}: {join_url}\nMeeting code: {}\n", pretty_code(&m.code)));
    if m.auto_record {
        html.push_str("<p style=\"color:#6e6e73\">This meeting will be recorded.</p>");
        text.push_str("\nThis meeting will be recorded.\n");
    }
    html.push_str("</div>");
    Mail { subject, html, text }
}

#[cfg(test)]
mod tests {
    use super::super::store::Invitee;
    use super::*;

    fn meeting() -> Stored {
        Stored {
            id: "0123456789abcdef".into(), code: "abcdefghjk".into(), title: "Plan; budget, Q4 \\ ünïcode ✓".into(), kind: "meeting".into(),
            starts_at: Some(1_795_270_200_000), minutes: 45, auto_record: true, lobby: true,
            invitees: vec![Invitee { email: "ann@example.com".into(), name: "Ann, Lee".into(), ..Default::default() }, Invitee { email: "bo@example.com".into(), ..Default::default() }],
            created_at: 0, invite_url: None, invite_account: None, started_mail: false,
        }
    }

    #[test]
    fn utc_times_are_formatted_like_rfc_5545() {
        assert_eq!(utc_stamp(0), "19700101T000000Z");
        assert_eq!(utc_stamp(951_782_400_000), "20000229T000000Z");
        assert_eq!(utc_stamp(1_795_270_200_000), "20261121T141000Z");
    }

    #[test]
    fn text_is_escaped_and_lines_fold_at_75_octets() {
        assert_eq!(escape("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
        let long = format!("SUMMARY:{}", "é".repeat(100));
        let folded = fold(&long);
        for line in folded.split("\r\n") {
            assert!(line.len() <= 75, "{} octets", line.len());
        }
        assert_eq!(folded.replace("\r\n ", ""), long);
    }

    #[test]
    fn the_invite_is_a_request_with_every_attendee() {
        let m = meeting();
        let text = ics(&m, "https://x.trycloudflare.com/m/abcdefghjk", ("Host Name", "host@example.com"), 1_795_000_000_000).unwrap();
        assert!(text.starts_with("BEGIN:VCALENDAR\r\n") && text.ends_with("END:VCALENDAR\r\n"));
        assert!(!text.replace("\r\n", "").contains('\n') && !text.contains("\n\n"));
        for line in text.split("\r\n") {
            assert!(line.len() <= 75, "{line}");
        }
        let unfolded = text.replace("\r\n ", "");
        assert!(unfolded.contains("METHOD:REQUEST\r\n"));
        assert!(unfolded.contains("UID:0123456789abcdef@zazabor\r\n"));
        assert!(unfolded.contains("DTSTART:20261121T141000Z\r\n"));
        assert!(unfolded.contains("DTEND:20261121T145500Z\r\n"));
        assert!(unfolded.contains("SUMMARY:Plan\\; budget\\, Q4 \\\\ ünïcode ✓\r\n"));
        assert!(unfolded.contains("LOCATION:https://x.trycloudflare.com/m/abcdefghjk\r\n"));
        assert!(unfolded.contains("URL:https://x.trycloudflare.com/m/abcdefghjk\r\n"));
        assert!(unfolded.contains("ORGANIZER;CN=Host Name:mailto:host@example.com\r\n"));
        assert!(unfolded.contains("ATTENDEE;CN=\"Ann, Lee\";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ann@example.com\r\n"));
        assert!(unfolded.contains("CN=bo@example.com;ROLE=REQ-PARTICIPANT"));
        let mut instant = m;
        instant.starts_at = None;
        assert!(ics(&instant, "u", ("a", "b@c.d"), 0).is_none());
    }

    #[test]
    fn the_mail_says_it_is_recorded_and_escapes_the_title() {
        let mut m = meeting();
        m.title = "<b>Hi</b> & co".into();
        let mail = compose(&m, "https://x.trycloudflare.com/m/abcdefghjk", "Host", Some("Sat 21 Nov, 13:30"), "See you", false);
        assert!(mail.subject.starts_with("Invitation: <b>Hi</b> & co"));
        assert!(mail.html.contains("&lt;b&gt;Hi&lt;/b&gt; &amp; co") && !mail.html.contains("<b>Hi</b>"));
        assert!(mail.html.contains("This meeting will be recorded") && mail.text.contains("This meeting will be recorded"));
        assert!(mail.html.contains("Join meeting") && mail.text.contains("abc-defg-hjk"));
        let call = compose(&Stored { kind: "call".into(), ..m.clone() }, "u", "Ann", None, "", false);
        assert_eq!(call.subject, "Ann is calling you: join");
        let again = compose(&m, "u", "Host", None, "", true);
        assert!(again.subject.ends_with("is starting: join here"));
    }
}
