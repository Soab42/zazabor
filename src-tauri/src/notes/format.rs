//! How a note looks as a file in the sync folder: Markdown with a small front matter block, so it
//! reads well in a drive's web view and can be written by hand.
//!
//! ```text
//! ---
//! id: 5c1f0e2a9b7d4c3e8f6a1b2c3d4e5f60
//! color: yellow
//! pinned: false
//! created: 2026-10-24T09:12:33.000Z
//! updated: 2026-10-24T09:15:02.481Z
//! ---
//! Shopping
//! - [ ] Milk
//! ```

use super::Note;

pub const COLORS: [&str; 7] = ["yellow", "green", "pink", "purple", "blue", "gray", "charcoal"];

/// The note as file contents. Equal notes always give equal text, so a hash of it tells whether
/// either side changed since the last sync. A title and a status are written only when there are
/// any (as JSON strings, which YAML reads too).
pub fn to_file(note: &Note) -> String {
    let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();
    let title = if note.title.is_empty() { String::new() } else { format!("title: {}\n", quoted(&note.title)) };
    let status = note.status.as_deref().map(|s| format!("status: {}\n", quoted(s))).unwrap_or_default();
    let order = note.position.map(|p| format!("order: {p}\n")).unwrap_or_default();
    format!(
        "---\nid: {}\n{title}color: {}\npinned: {}\n{status}{order}created: {}\nupdated: {}\n---\n{}\n",
        note.id,
        note.color,
        note.pinned,
        iso(note.created),
        iso(note.updated),
        note.body.trim_end_matches('\n'),
    )
}

/// What a file says about its note. A Markdown file without front matter (written on the web,
/// say) is all body; the caller gives it an id and the file's date.
#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub id: Option<String>,
    pub title: String,
    pub status: Option<String>,
    pub position: Option<f64>,
    pub color: Option<String>,
    pub pinned: bool,
    pub created: Option<i64>,
    pub updated: Option<i64>,
    pub body: String,
}

pub fn parse(text: &str) -> Parsed {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else {
        return Parsed { body: clean_body(&text), ..Default::default() };
    };
    let Some(end) = rest.find("\n---\n").map(|i| (i, i + 5)).or_else(|| rest.strip_suffix("\n---").map(|r| (r.len(), rest.len()))) else {
        return Parsed { body: clean_body(&text), ..Default::default() };
    };
    let mut parsed = Parsed { body: clean_body(&rest[end.1..]), ..Default::default() };
    for line in rest[..end.0].lines() {
        let Some((key, raw)) = line.split_once(':') else { continue };
        let value = raw.trim().trim_matches('"');
        match key.trim() {
            "title" => parsed.title = text_value(raw),
            "status" => parsed.status = Some(text_value(raw)).filter(|s| !s.is_empty()),
            "order" => parsed.position = value.parse::<f64>().ok().filter(|p| p.is_finite()),
            "id" if is_id(value) => parsed.id = Some(value.to_ascii_lowercase()),
            "color" if COLORS.contains(&value) => parsed.color = Some(value.to_string()),
            "pinned" => parsed.pinned = value == "true",
            "created" => parsed.created = parse_time(value),
            "updated" => parsed.updated = parse_time(value),
            _ => {}
        }
    }
    parsed
}

/// A front matter string: "quoted" (with escapes), 'quoted' or bare.
fn text_value(raw: &str) -> String {
    let raw = raw.trim();
    if raw.starts_with('"') {
        if let Ok(text) = serde_json::from_str::<String>(raw) {
            return text;
        }
    }
    raw.trim_matches('"').trim_matches('\'').trim().to_string()
}

fn clean_body(body: &str) -> String {
    body.trim_end_matches(['\n', ' ', '\t']).to_string()
}

/// Ids are 32 hex digits; anything else in a hand-written file is ignored and replaced.
pub fn is_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The file name a note gets: its title (or else its first line), then the start of its id so two
/// notes with the same title don't collide, e.g. `Shopping (5c1f0e).md`.
pub fn file_name(note: &Note) -> String {
    let title = safe_name(&display_title(note));
    let title = if title.is_empty() { "Note".to_string() } else { title };
    format!("{} ({}).md", title, &note.id[..6])
}

/// What a note is called: its title, or else its first line of text.
pub fn display_title(note: &Note) -> String {
    let title = note.title.trim();
    if title.is_empty() { first_line(&note.body) } else { title.to_string() }
}

/// Made safe for any file system, ≤ 60 characters.
fn safe_name(text: &str) -> String {
    let out: String = text.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { ' ' } else { c }).collect();
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut cut: String = collapsed.chars().take(60).collect();
    // A trailing dot or space is trouble on Windows drives.
    while cut.ends_with('.') || cut.ends_with(' ') {
        cut.pop();
    }
    cut
}

/// The first line with text, without Markdown marks (a code fence or a rule isn't text).
pub fn first_line(body: &str) -> String {
    let line = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("```") && !l.starts_with("~~~") && !l.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')))
        .unwrap_or("");
    let line = line
        .trim_start_matches("- [ ] ")
        .trim_start_matches("- [x] ")
        .trim_start_matches("- [X] ")
        .trim_start_matches("- ")
        .trim_start_matches(|c| c == '#' || c == '>' || c == ' ');
    let mut out = String::new();
    let mut escaped = false;
    for c in line.replace("<u>", "").replace("</u>", "").chars() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
            continue;
        } else if matches!(c, '*' | '~' | '`') {
            continue;
        }
        out.push(if c.is_control() { ' ' } else { c });
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect()
}

// ---- dates, as ISO 8601 in UTC, without a date crate ---------------------------------------------

/// Milliseconds since the epoch as `2026-10-24T09:15:02.481Z`.
pub fn iso(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, m, d) = civil_from_days(days);
    let (h, rem) = (rem / 3_600_000, rem % 3_600_000);
    let (min, rem) = (rem / 60_000, rem % 60_000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{:02}.{:03}Z", rem / 1000, rem % 1000)
}

/// Reads `iso`'s format, with or without milliseconds or the `Z`, or plain epoch milliseconds.
pub fn parse_time(value: &str) -> Option<i64> {
    if let Ok(ms) = value.parse::<i64>() {
        return Some(ms);
    }
    let value = value.trim_end_matches('Z');
    let (date, time) = value.split_once('T').or_else(|| value.split_once(' ')).unwrap_or((value, "00:00:00"));
    let mut date = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (date.next()??, date.next()??, date.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut hms = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (h, min, s) = (hms.next()??, hms.next().unwrap_or(Some(0))?, hms.next().unwrap_or(Some(0))?);
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 || s > 60 {
        return None;
    }
    Some(days_from_civil(y, m, d) * 86_400_000 + h * 3_600_000 + min * 60_000 + s * 1000 + ms)
}

// Howard Hinnant's algorithms: http://howardhinnant.github.io/date_algorithms.html
fn civil_from_days(days: i64) -> (i64, i64, i64) {
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

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(body: &str) -> Note {
        Note {
            id: "5c1f0e2a9b7d4c3e8f6a1b2c3d4e5f60".into(),
            title: String::new(),
            body: body.into(),
            color: "green".into(),
            pinned: true,
            status: None,
            position: None,
            created: 1_761_297_153_000,
            updated: 1_761_297_302_481,
            deleted: None,
        }
    }

    #[test]
    fn dates_round_trip() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_761_297_302_481), "2025-10-24T09:15:02.481Z");
        for ms in [0, 951_782_400_000, 1_761_297_302_481, 4_102_444_799_999] {
            assert_eq!(parse_time(&iso(ms)), Some(ms));
        }
        assert_eq!(parse_time("2025-10-24T09:15:02Z"), Some(1_761_297_302_000));
        assert_eq!(parse_time("2025-10-24"), Some(1_761_264_000_000));
        assert_eq!(parse_time("yesterday"), None);
    }

    #[test]
    fn file_round_trip() {
        let n = note("Shopping\n- [ ] Milk\n\n**Bread**");
        let p = parse(&to_file(&n));
        assert_eq!(p.id.as_deref(), Some(n.id.as_str()));
        assert_eq!(p.color.as_deref(), Some("green"));
        assert!(p.pinned);
        assert_eq!((p.created, p.updated), (Some(n.created), Some(n.updated)));
        assert_eq!(p.body, n.body);
    }

    #[test]
    fn hand_written_files() {
        let p = parse("Just text\r\nfrom the web\r\n\r\n");
        assert_eq!((p.id, p.body.as_str()), (None, "Just text\nfrom the web"));
        // A rule at the top isn't front matter unless it closes.
        assert_eq!(parse("---\nnot closed").body, "---\nnot closed");
        let p = parse("---\nid: nope\ncolor: tartan\n---\nHi");
        assert_eq!((p.id, p.color, p.body.as_str()), (None, None, "Hi"));
    }

    #[test]
    fn titles_and_status() {
        let mut n = note("Body");
        // Without them, the file is as it always was.
        assert!(!to_file(&n).contains("title:") && !to_file(&n).contains("status:"));
        n.title = "Plan: \"Q4\" / launch".into();
        n.status = Some("In progress".into());
        n.position = Some(1_761_297_153_000.5);
        let p = parse(&to_file(&n));
        assert_eq!((p.title.as_str(), p.status.as_deref(), p.body.as_str()), ("Plan: \"Q4\" / launch", Some("In progress"), "Body"));
        assert_eq!(p.position, Some(1_761_297_153_000.5));
        assert_eq!(file_name(&n), "Plan Q4 launch (5c1f0e).md");
        assert_eq!(display_title(&n), "Plan: \"Q4\" / launch");
        // Hand-written front matter, quoted or not.
        let p = parse("---\ntitle: Shopping list\nstatus: 'Done'\n---\nMilk");
        assert_eq!((p.title.as_str(), p.status.as_deref()), ("Shopping list", Some("Done")));
    }

    #[test]
    fn file_names() {
        assert_eq!(file_name(&note("")), "Note (5c1f0e).md");
        assert_eq!(file_name(&note("\n- [ ] **Call** <u>Sam</u>: 3/4?\nmore")), "Call Sam 3 4 (5c1f0e).md");
        assert_eq!(file_name(&note("2 \\* 3 = 6...")), "2 3 = 6 (5c1f0e).md");
    }
}
