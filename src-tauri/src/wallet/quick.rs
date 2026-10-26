//! Quick add: a short phrase becomes a transaction. "250 lunch bkash" is ৳250 spent on Eating out
//! from bKash today; "+45000 salary city bank 25 oct" is income into City Bank on 25 October.
//! The page shows the guess as chips while you type, and Enter saves it.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use super::db::{self, db_err, valid_date, Result};
use super::money;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Guess {
    /// "expense" or "income".
    pub kind: String,
    /// The amount as found ("250", "45000"), and in the account's minor units.
    pub amount: String,
    pub amount_minor: Option<i64>,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    /// "YYYY-MM-DD".
    pub date: String,
    pub payee: String,
}

/// Words that point to a default category (by its name), beyond the category's own name.
const KEYWORDS: &[(&str, &[&str])] = &[
    ("Eating out", &["lunch", "dinner", "breakfast", "snack", "snacks", "restaurant", "cafe", "coffee", "tea", "biryani", "pizza", "burger", "foodpanda", "iftar"]),
    ("Groceries", &["grocery", "groceries", "bazar", "bazaar", "market", "vegetables", "fish", "meat", "rice", "shwapno", "agora", "meena"]),
    ("Rickshaw and CNG", &["rickshaw", "cng", "auto"]),
    ("Ride share", &["uber", "pathao", "obhai", "ride"]),
    ("Fuel", &["fuel", "petrol", "octane", "diesel"]),
    ("Electricity", &["electricity", "desco", "dpdc", "nesco"]),
    ("Gas", &["titas"]),
    ("Water", &["wasa"]),
    ("Internet", &["wifi", "broadband", "isp"]),
    ("Mobile recharge", &["recharge", "flexiload", "topup", "top-up", "gp", "robi", "banglalink", "airtel", "teletalk"]),
    ("Rent", &["houserent"]),
    ("Family", &["parents", "mother", "father", "mom", "dad", "kids"]),
    ("Health", &["doctor", "medicine", "medicines", "pharmacy", "hospital", "clinic"]),
    ("Education", &["school", "tuition", "course", "books", "exam"]),
    ("Shopping", &["clothes", "daraz", "shoes", "shirt"]),
    ("Entertainment", &["movie", "cinema", "games", "concert"]),
    ("Subscriptions", &["netflix", "spotify", "youtube", "icloud", "subscription", "chatgpt", "claude"]),
    ("Zakat", &["zakat"]),
    ("Sadaqah", &["sadaqah", "sadaka", "charity", "donation"]),
    ("Fees", &["fee", "charge", "charges", "cashout"]),
    ("Salary", &["salary", "payroll"]),
    ("Freelance", &["freelance", "upwork", "fiverr"]),
    ("Gifts", &["gift", "salami"]),
    ("Refunds", &["refund", "cashback"]),
];

const MONTHS: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/// "oct", "Oct.", "sept", "october" → 10.
fn month_of(word: &str) -> Option<u32> {
    let w = word.trim_end_matches(['.', ',']);
    if w.len() < 3 {
        return None;
    }
    MONTHS.iter().position(|m| m.starts_with(w)).map(|i| i as u32 + 1)
}

fn day_of(word: &str) -> Option<u32> {
    let w = word.trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == ',');
    w.parse::<u32>().ok().filter(|d| (1..=31).contains(d)).filter(|_| word.len() <= 4)
}

/// A date in `year` (or the year before, when that would be after today).
fn date_in(today: &str, month: u32, day: u32) -> Option<String> {
    let y: i32 = today[..4].parse().ok()?;
    let this = format!("{y:04}-{month:02}-{day:02}");
    let date = if this.as_str() > today { format!("{:04}-{month:02}-{day:02}", y - 1) } else { this };
    valid_date(&date).then_some(date)
}

fn days_before(today: &str, n: i64) -> String {
    // Walk back day by day; n is small.
    let mut y: i32 = today[..4].parse().unwrap_or(2000);
    let mut m: u32 = today[5..7].parse().unwrap_or(1);
    let mut d: u32 = today[8..].parse().unwrap_or(1);
    for _ in 0..n {
        if d > 1 {
            d -= 1;
        } else {
            if m > 1 {
                m -= 1;
            } else {
                m = 12;
                y -= 1;
            }
            d = db::days_in_month(y, m);
        }
    }
    format!("{y:04}-{m:02}-{d:02}")
}

/// An amount token: "250", "1,250.50", "৳250", "250tk", "1.2k".
fn amount_token(word: &str) -> Option<String> {
    let w = word.trim_start_matches('৳').trim_end_matches("/-");
    let w = w.strip_suffix("taka").or_else(|| w.strip_suffix("tk")).unwrap_or(w);
    let first = w.trim_start_matches(['+', '-']).chars().next()?;
    (first.is_ascii_digit() || first == '.').then(|| w.to_string()).filter(|w| money::parse_amount(w, "BDT").is_some())
}

/// Finds the longest run of `words` (from any position) equal to one of `names`; returns the
/// index range and the name's position in `names`.
fn find_phrase(words: &[String], names: &[String]) -> Option<(usize, usize, usize)> {
    let mut best: Option<(usize, usize, usize)> = None;
    for (n, name) in names.iter().enumerate() {
        let parts: Vec<&str> = name.split_whitespace().collect();
        if parts.is_empty() || parts.len() > words.len() {
            continue;
        }
        for start in 0..=words.len() - parts.len() {
            if words[start..start + parts.len()].iter().zip(&parts).all(|(w, p)| w == p) && best.is_none_or(|b| b.1 - b.0 < parts.len()) {
                best = Some((start, start + parts.len(), n));
            }
        }
    }
    best
}

pub fn parse(conn: &Connection, text: &str, today: &str) -> Result<Guess> {
    if !valid_date(today) {
        return Err("Today isn't a date.".into());
    }
    let mut kind = if text.trim_start().starts_with('+') { "income" } else { "expense" }.to_string();
    let original: Vec<String> = text.split_whitespace().map(str::to_string).collect();
    let words: Vec<String> = original.iter().map(|w| w.to_lowercase()).collect();
    let mut keep: Vec<bool> = vec![true; words.len()];

    // The amount: the first number.
    let mut amount = String::new();
    // (Not the day of "25 oct".)
    let next_to_month = |i: usize| [i.checked_sub(1), Some(i + 1)].into_iter().flatten().any(|j| words.get(j).is_some_and(|w| month_of(w).is_some()));
    if let Some(i) = (0..words.len()).find(|&i| amount_token(&words[i]).is_some() && !(day_of(&words[i]).is_some() && next_to_month(i))) {
        amount = amount_token(&words[i]).unwrap_or_default().trim_start_matches(['+', '-']).to_string();
        keep[i] = false;
    }

    // The date: today, yesterday, "25 oct", "oct 25", "25/10", "2026-10-25".
    let mut date = today.to_string();
    for i in 0..words.len() {
        if !keep[i] {
            continue;
        }
        let w = words[i].as_str();
        if w == "today" {
            keep[i] = false;
        } else if w == "yesterday" {
            date = days_before(today, 1);
            keep[i] = false;
        } else if valid_date(w) {
            date = w.to_string();
            keep[i] = false;
        } else if let Some((d, m)) = w.split_once('/').and_then(|(d, rest)| {
            let m = rest.split('/').next()?;
            Some((d.parse::<u32>().ok()?, m.parse::<u32>().ok()?))
        }) {
            let year = w.split('/').nth(2).and_then(|y| y.parse::<i32>().ok()).map(|y| if y < 100 { 2000 + y } else { y });
            let found = match year {
                Some(y) => Some(format!("{y:04}-{m:02}-{d:02}")).filter(|d| valid_date(d)),
                None => date_in(today, m, d),
            };
            if let Some(found) = found {
                date = found;
                keep[i] = false;
            }
        } else if let Some(m) = month_of(w) {
            let day = [i.checked_sub(1), Some(i + 1)].into_iter().flatten().filter(|&j| j < words.len() && keep[j]).find_map(|j| day_of(&words[j]).map(|d| (j, d)));
            if let Some((j, d)) = day {
                if let Some(found) = date_in(today, m, d) {
                    date = found;
                    keep[i] = false;
                    keep[j] = false;
                }
            }
        }
    }

    let remaining = |keep: &[bool], words: &[String]| -> Vec<(usize, String)> { words.iter().enumerate().filter(|(i, _)| keep[*i]).map(|(i, w)| (i, w.clone())).collect() };

    // The account: its name ("city bank", "bkash"), else "cash" or "card" for one of that kind.
    let accounts: Vec<db::Account> = db::accounts(conn)?.into_iter().filter(|a| !a.archived).collect();
    let mut account_id = None;
    {
        let left = remaining(&keep, &words);
        let only: Vec<String> = left.iter().map(|(_, w)| w.clone()).collect();
        let names: Vec<String> = accounts.iter().map(|a| a.name.to_lowercase()).collect();
        if let Some((s, e, n)) = find_phrase(&only, &names) {
            account_id = Some(accounts[n].id.clone());
            for (i, _) in &left[s..e] {
                keep[*i] = false;
            }
        } else if let Some((i, w)) = left.iter().find(|(_, w)| w == "cash" || w == "card") {
            let kind = if w == "cash" { "cash" } else { "card" };
            if let Some(a) = accounts.iter().find(|a| a.kind == kind) {
                account_id = Some(a.id.clone());
                keep[*i] = false;
            }
        }
    }

    // The category: its name ("eating out"), else a word that points to it ("lunch").
    let categories: Vec<db::Category> = db::categories(conn)?.into_iter().filter(|c| !c.archived).collect();
    let mut category_id = None;
    let mut hint = String::new();
    {
        let left = remaining(&keep, &words);
        let only: Vec<String> = left.iter().map(|(_, w)| w.clone()).collect();
        let names: Vec<String> = categories.iter().map(|c| c.name.to_lowercase()).collect();
        if let Some((s, e, n)) = find_phrase(&only, &names) {
            category_id = Some(categories[n].id.clone());
            hint = left[s..e].iter().map(|(i, _)| original[*i].clone()).collect::<Vec<_>>().join(" ");
            for (i, _) in &left[s..e] {
                keep[*i] = false;
            }
        } else {
            'words: for (i, w) in &left {
                for (name, keys) in KEYWORDS {
                    if keys.contains(&w.as_str()) {
                        if let Some(c) = categories.iter().find(|c| c.name.eq_ignore_ascii_case(name)) {
                            category_id = Some(c.id.clone());
                            hint = original[*i].clone();
                            keep[*i] = false;
                            break 'words;
                        }
                    }
                }
            }
        }
    }

    // What's left names the payee; without anything left, the word that gave the category does.
    let payee_words: Vec<String> = original.iter().enumerate().filter(|(i, _)| keep[*i]).map(|(_, w)| w.clone()).collect();
    let mut payee = payee_words.join(" ");
    if payee.is_empty() && !hint.is_empty() {
        let mut chars = hint.chars();
        payee = chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default();
    }

    // A known payee brings its usual category (and kind), as last time.
    if category_id.is_none() && !payee.is_empty() {
        let last: Option<(Option<String>, i64)> = conn
            .query_row(
                "SELECT category_id, amount_minor FROM transactions WHERE lower(payee) = lower(?1) AND transfer_id IS NULL ORDER BY created DESC LIMIT 1",
                [&payee],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        if let Some((cat, amount)) = last {
            category_id = cat;
            if !text.trim_start().starts_with('+') {
                kind = if amount > 0 { "income" } else { "expense" }.into();
            }
        }
    }
    if let Some(cat) = categories.iter().find(|c| Some(&c.id) == category_id.as_ref()) {
        if !text.trim_start().starts_with('+') && !text.trim_start().starts_with('-') {
            kind = cat.kind.clone();
        }
    }

    // Without an account named, the one used last (or the first).
    if account_id.is_none() {
        let last: Option<String> = conn
            .query_row("SELECT t.account_id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.archived = 0 ORDER BY t.created DESC LIMIT 1", [], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        account_id = last.or_else(|| accounts.first().map(|a| a.id.clone()));
    }
    let currency = accounts.iter().find(|a| Some(&a.id) == account_id.as_ref()).map_or(money::BASE, |a| a.currency.as_str());
    let amount_minor = if amount.is_empty() { None } else { money::parse_amount(&amount, currency) };
    Ok(Guess { kind, amount, amount_minor, account_id, category_id, date, payee })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{add_account, cat, fresh};

    #[test]
    fn short_phrases() {
        let conn = fresh();
        let bkash = add_account(&conn, "bKash", "mobile_wallet", "BDT", None);
        let city = add_account(&conn, "City Bank", "bank", "BDT", None);
        let cash = db::accounts(&conn).unwrap().into_iter().find(|a| a.name == "Cash").unwrap().id;

        let g = parse(&conn, "250 lunch bkash", "2026-10-26").unwrap();
        assert_eq!((g.kind.as_str(), g.amount_minor, g.account_id.as_deref(), g.date.as_str()), ("expense", Some(25_000), Some(bkash.as_str()), "2026-10-26"));
        assert_eq!(g.category_id, Some(cat(&conn, "Eating out")));
        assert_eq!(g.payee, "Lunch");

        let g = parse(&conn, "+45000 salary city bank 25 oct", "2026-10-26").unwrap();
        assert_eq!((g.kind.as_str(), g.amount_minor, g.account_id.as_deref(), g.date.as_str()), ("income", Some(4_500_000), Some(city.as_str()), "2026-10-25"));
        assert_eq!(g.category_id, Some(cat(&conn, "Salary")));

        let g = parse(&conn, "1,200 eating out Kacchi Bhai cash yesterday", "2026-10-01").unwrap();
        assert_eq!((g.amount_minor, g.account_id.as_deref(), g.date.as_str(), g.payee.as_str()), (Some(120_000), Some(cash.as_str()), "2026-09-30", "Kacchi Bhai"));

        // A date after today is last year's; "dec 30" in January.
        assert_eq!(parse(&conn, "80 rickshaw dec 30", "2026-01-05").unwrap().date, "2025-12-30");
        assert_eq!(parse(&conn, "80 rickshaw 3/1", "2026-01-05").unwrap().date, "2026-01-03");
        assert_eq!(parse(&conn, "nothing here", "2026-01-05").unwrap().amount_minor, None);
        assert_eq!(parse(&conn, "25 oct 300 groceries", "2026-10-26").unwrap().amount_minor, Some(30_000));
    }
}
