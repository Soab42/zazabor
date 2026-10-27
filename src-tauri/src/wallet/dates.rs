//! Local calendar dates as "YYYY-MM-DD" text, the way the ledger stores them: day arithmetic for
//! recurring bills and statement imports, without a date crate.

use super::db::{days_in_month, valid_date};

/// Days since 1970-01-01 of a date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `days` days after 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn parts(date: &str) -> (i64, u32, u32) {
    (date[..4].parse().unwrap_or(2000), date[5..7].parse().unwrap_or(1), date[8..10].parse().unwrap_or(1))
}

pub fn format(y: i64, m: u32, d: u32) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 of "YYYY-MM-DD".
pub fn day_number(date: &str) -> i64 {
    let (y, m, d) = parts(date);
    days_from_civil(y, m, d)
}

pub fn add_days(date: &str, n: i64) -> String {
    let (y, m, d) = civil_from_days(day_number(date) + n);
    format(y, m, d)
}

/// Days from `a` to `b` (negative when `b` is earlier).
#[cfg(test)]
pub fn days_between(a: &str, b: &str) -> i64 {
    day_number(b) - day_number(a)
}

/// The day `day` (1–31, or 0 for the last day) of the month `months` after `date`'s month; a day
/// past the month's end is its last day (the 31st in February is the 28th or 29th).
pub fn in_month(date: &str, months: i64, day: u32) -> String {
    let (y, m, _) = parts(date);
    let total = y * 12 + i64::from(m) - 1 + months;
    let (y, m) = (total.div_euclid(12), (total.rem_euclid(12) + 1) as u32);
    let last = days_in_month(y as i32, m);
    format(y, m, if day == 0 { last } else { day.min(last) })
}

/// A date typed in a statement, in the given order of its parts ("dmy", "mdy" or "ymd"), with
/// "/", "-", "." or spaces between them, month names ("26 Oct 2026", "Oct 26, 2026") and
/// two-digit years. A time after the date is ignored.
pub fn parse_loose(text: &str, order: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // Drop a time of day: "26/10/2026 14:05" or the "T" of ISO dates.
    let date_part = text.split(['T', ' ']).filter(|p| !p.contains(':')).collect::<Vec<_>>().join(" ");
    let pieces: Vec<String> = date_part
        .split(|c: char| c == '/' || c == '-' || c == '.' || c == ' ' || c == ',')
        .filter(|p| !p.is_empty())
        .map(|p| p.to_lowercase())
        .collect();
    if pieces.len() < 3 {
        return None;
    }
    let pieces = &pieces[..3];
    let month_name = |p: &str| -> Option<u32> {
        const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        (p.len() >= 3 && p.chars().all(|c| c.is_ascii_alphabetic())).then(|| MONTHS.iter().position(|m| p.starts_with(m)).map(|i| i as u32 + 1)).flatten()
    };
    let number = |p: &str| p.parse::<i64>().ok();
    let year = |v: i64, digits: usize| if digits <= 2 { 2000 + v } else { v };
    let named = pieces.iter().position(|p| month_name(p).is_some());
    let (y, m, d) = if let Some(i) = named {
        let m = month_name(&pieces[i])?;
        let others: Vec<&String> = pieces.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, p)| p).collect();
        let (a, b) = (others[0], others[1]);
        // "2026 Oct 26", else "26 Oct 2026" / "Oct 26 2026": the year is the four-digit one.
        if a.len() == 4 {
            (number(a)?, m, number(b)? as u32)
        } else {
            (year(number(b)?, b.len()), m, number(a)? as u32)
        }
    } else {
        let n: Vec<i64> = pieces.iter().map(|p| number(p)).collect::<Option<_>>()?;
        if pieces[0].len() == 4 {
            (n[0], n[1] as u32, n[2] as u32)
        } else {
            match order {
                "mdy" => (year(n[2], pieces[2].len()), n[0] as u32, n[1] as u32),
                "ymd" => (year(n[0], pieces[0].len()), n[1] as u32, n[2] as u32),
                _ => (year(n[2], pieces[2].len()), n[1] as u32, n[0] as u32),
            }
        }
    };
    let out = format(y, m, d);
    valid_date(&out).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_round_trip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 10, 26), 20_752);
        assert_eq!(civil_from_days(20_752), (2026, 10, 26));
        assert_eq!(add_days("2026-02-27", 2), "2026-03-01");
        assert_eq!(add_days("2028-02-28", 1), "2028-02-29");
        assert_eq!(days_between("2026-10-01", "2026-11-10"), 40);
    }

    #[test]
    fn months_keep_their_day() {
        assert_eq!(in_month("2026-01-31", 1, 31), "2026-02-28");
        assert_eq!(in_month("2026-02-28", 1, 31), "2026-03-31");
        assert_eq!(in_month("2026-12-05", 1, 5), "2027-01-05");
        assert_eq!(in_month("2026-10-05", 0, 0), "2026-10-31");
    }

    #[test]
    fn statement_dates() {
        assert_eq!(parse_loose("26/10/2026", "dmy").as_deref(), Some("2026-10-26"));
        assert_eq!(parse_loose("10/26/2026", "mdy").as_deref(), Some("2026-10-26"));
        assert_eq!(parse_loose("2026-10-26T09:00:00", "dmy").as_deref(), Some("2026-10-26"));
        assert_eq!(parse_loose("26-Oct-26", "dmy").as_deref(), Some("2026-10-26"));
        assert_eq!(parse_loose("Oct 26, 2026", "dmy").as_deref(), Some("2026-10-26"));
        assert_eq!(parse_loose("26.10.2026 14:05", "dmy").as_deref(), Some("2026-10-26"));
        assert_eq!(parse_loose("31/02/2026", "dmy"), None);
        assert_eq!(parse_loose("Balance", "dmy"), None);
    }
}
