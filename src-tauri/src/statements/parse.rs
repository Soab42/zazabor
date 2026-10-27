//! Reading the words of a statement: what a column heading means, dates and amounts, and the
//! lines around the table (bank, account number, period, opening and closing balance).

use crate::wallet::{dates, import::read_money};

/// What a column of a statement holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Date,
    Description,
    Reference,
    Debit,
    Credit,
    Amount,
    Balance,
    /// "Type" or "Dr/Cr": which way the money went, in words.
    Kind,
}

/// A heading as compared: lower case, currency marks and punctuation gone ("In (৳)" → "in").
pub fn heading(text: &str) -> String {
    let lower = text.to_lowercase();
    let mut out = String::new();
    for c in lower.chars() {
        if c.is_alphanumeric() || c == '/' || c == '&' {
            out.push(c);
        } else {
            out.push(' ');
        }
    }
    let words: Vec<&str> = out.split_whitespace().filter(|w| !matches!(*w, "৳" | "bdt" | "tk" | "taka" | "in bdt")).collect();
    words.join(" ")
}

const DATE: &[&str] = &["date", "txn date", "transaction date", "trans date", "tran date", "value date", "posting date", "post date", "date/time", "date & time", "date time", "trx date"];
const DESCRIPTION: &[&str] = &["description", "details", "narration", "particulars", "remarks", "transaction details", "transaction description", "memo", "payee", "detail", "naration"];
const REFERENCE: &[&str] = &["ref", "ref no", "reference", "reference no", "cheque", "cheque no", "chq", "chq no", "chq/ref no", "instrument no", "trx id", "trxid", "transaction id", "txn id", "tran id", "voucher no"];
const DEBIT: &[&str] = &["debit", "debits", "withdrawal", "withdrawals", "dr", "paid out", "money out", "out", "debit amount", "withdrawal amount", "cash out"];
const CREDIT: &[&str] = &["credit", "credits", "deposit", "deposits", "cr", "paid in", "money in", "in", "credit amount", "deposit amount", "cash in"];
const AMOUNT: &[&str] = &["amount", "amt", "transaction amount", "txn amount"];
const BALANCE: &[&str] = &["balance", "running balance", "available balance", "ledger balance", "balance amount"];
const KIND: &[&str] = &["type", "transaction type", "txn type", "dr/cr", "cr/dr", "dr cr"];

/// What a heading names, if it names a statement column.
pub fn role_of(text: &str) -> Option<Role> {
    let h = heading(text);
    if h.is_empty() || h.len() > 40 {
        return None;
    }
    let table: [(&[&str], Role); 8] = [
        (DATE, Role::Date),
        (BALANCE, Role::Balance),
        (DEBIT, Role::Debit),
        (CREDIT, Role::Credit),
        (AMOUNT, Role::Amount),
        (REFERENCE, Role::Reference),
        (KIND, Role::Kind),
        (DESCRIPTION, Role::Description),
    ];
    for (names, role) in table {
        if names.contains(&h.as_str()) {
            return Some(role);
        }
    }
    None
}

/// "1,25,000.50", "(450.00)", "450.00 Dr", "৳ 85,000": the unsigned amount in poisha and the sign the
/// text itself carries (−1, +1, or 0 for none). Text with letters other than Dr/Cr/Tk isn't money.
pub fn money(text: &str, currency: &str) -> Option<(i64, i32)> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let letters: String = t.chars().filter(|c| c.is_alphabetic()).collect::<String>().to_lowercase();
    if !matches!(letters.as_str(), "" | "dr" | "cr" | "tk" | "bdt" | "tkdr" | "tkcr" | "bdtdr" | "bdtcr") {
        return None;
    }
    let digits = t.chars().filter(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    // Two numbers side by side ("123456 18,000.00") aren't one amount.
    if t.split_whitespace().filter(|w| w.chars().any(|c| c.is_ascii_digit())).count() > 1 {
        return None;
    }
    // A date or a phone number isn't an amount: amounts have at most one dot and their
    // separators are commas.
    if t.matches('.').count() > 1 || t.contains('/') || (t.contains('-') && !t.starts_with('-') && !t.ends_with('-')) {
        return None;
    }
    read_money(t, currency, false)
}

/// A date in a statement ("05/10/2026", "05-Oct-26", "2026-10-05 14:20"), as "YYYY-MM-DD".
pub fn date(text: &str, order: &str) -> Option<String> {
    let t = text.trim();
    if t.len() < 6 || t.len() > 40 {
        return None;
    }
    dates::parse_loose(t, order)
}

/// Day-first or month-first, from the dates seen: a first number above 12 means day first.
pub fn date_order<'a>(samples: impl Iterator<Item = &'a str>) -> &'static str {
    let (mut dmy, mut mdy) = (0, 0);
    for v in samples {
        let nums: Vec<u32> = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect();
        if nums.len() >= 3 && nums[0] <= 31 && v.chars().take(4).filter(|c| c.is_ascii_digit()).count() < 4 {
            if nums[0] > 12 {
                dmy += 1;
            } else if nums[1] > 12 {
                mdy += 1;
            }
        }
    }
    if mdy > dmy {
        "mdy"
    } else {
        "dmy"
    }
}

/// Banks and wallets of Bangladesh (and a few more), by the words their statements carry.
const BANKS: &[(&str, &str)] = &[
    ("bkash", "bKash"),
    ("nagad", "Nagad"),
    ("rocket", "Rocket"),
    ("upay", "Upay"),
    ("brac bank", "BRAC Bank"),
    ("city bank", "The City Bank"),
    ("dutch-bangla", "Dutch-Bangla Bank"),
    ("dutch bangla", "Dutch-Bangla Bank"),
    ("eastern bank", "Eastern Bank"),
    ("islami bank", "Islami Bank Bangladesh"),
    ("prime bank", "Prime Bank"),
    ("standard chartered", "Standard Chartered"),
    ("hsbc", "HSBC"),
    ("sonali bank", "Sonali Bank"),
    ("janata bank", "Janata Bank"),
    ("agrani bank", "Agrani Bank"),
    ("rupali bank", "Rupali Bank"),
    ("pubali bank", "Pubali Bank"),
    ("mutual trust", "Mutual Trust Bank"),
    ("united commercial", "United Commercial Bank"),
    ("bank asia", "Bank Asia"),
    ("ific bank", "IFIC Bank"),
    ("ncc bank", "NCC Bank"),
    ("southeast bank", "Southeast Bank"),
    ("jamuna bank", "Jamuna Bank"),
    ("one bank", "ONE Bank"),
    ("dhaka bank", "Dhaka Bank"),
    ("trust bank", "Trust Bank"),
    ("ab bank", "AB Bank"),
    ("mercantile bank", "Mercantile Bank"),
    ("exim bank", "EXIM Bank"),
    ("al-arafah", "Al-Arafah Islami Bank"),
    ("shahjalal", "Shahjalal Islami Bank"),
    ("premier bank", "Premier Bank"),
    ("community bank", "Community Bank"),
];

/// The bank or wallet a statement's opening lines name.
pub fn bank(lines: &[String]) -> Option<String> {
    for line in lines.iter().take(40) {
        let l = line.to_lowercase();
        if let Some((_, name)) = BANKS.iter().find(|(key, _)| l.contains(key)) {
            return Some(name.to_string());
        }
    }
    // A line naming some other bank: "Xyz Bank Limited".
    lines.iter().take(15).find_map(|line| {
        let words: Vec<&str> = line.split_whitespace().collect();
        let i = words.iter().position(|w| w.eq_ignore_ascii_case("bank"))?;
        let start = i.saturating_sub(3);
        let name = words[start..=i].join(" ");
        (name.len() > 5 && !name.to_lowercase().starts_with("bank")).then_some(name)
    })
}

/// The last four digits of the account number named in the lines ("Account No: 1234-5678-9012",
/// "A/C: 01712345678"), never the whole number.
pub fn account_last4(lines: &[String]) -> Option<String> {
    const LABELS: [&str; 8] = ["account no", "account number", "a/c no", "a/c number", "acc no", "account:", "a/c:", "wallet no"];
    for line in lines.iter().take(60) {
        let l = line.to_lowercase();
        let Some(at) = LABELS.iter().filter_map(|label| l.find(label).map(|i| i + label.len())).min() else { continue };
        let rest = &line[at.min(line.len())..];
        // The first run of digits (with -, spaces or * inside) after the label.
        let mut digits = String::new();
        let mut started = false;
        for c in rest.chars() {
            if c.is_ascii_digit() {
                digits.push(c);
                started = true;
            } else if started && !matches!(c, '-' | ' ' | '*' | 'x' | 'X' | '•') {
                break;
            }
        }
        if digits.len() >= 4 {
            return Some(digits[digits.len() - 4..].to_string());
        }
    }
    None
}

/// "Statement period: 01/10/2026 to 31/10/2026", "From 01-Oct-2026 To 31-Oct-2026".
pub fn period(lines: &[String], order: &str) -> Option<(String, String)> {
    for line in lines.iter().take(60) {
        let l = line.to_lowercase();
        if !(l.contains("period") || l.contains("from") || l.contains("statement date") || l.contains(" to ")) {
            continue;
        }
        let found: Vec<String> = line
            .split(|c: char| c.is_whitespace() || c == ':' || c == '–' || c == '—')
            .filter(|w| !w.is_empty() && !w.eq_ignore_ascii_case("to") && !w.eq_ignore_ascii_case("from"))
            .collect::<Vec<_>>()
            .windows(3)
            .filter_map(|w| date(&w.join(" "), order))
            .chain(line.split(|c: char| c.is_whitespace()).filter_map(|w| date(w, order)))
            .collect();
        let mut unique: Vec<String> = Vec::new();
        for d in found {
            if !unique.contains(&d) {
                unique.push(d);
            }
        }
        if unique.len() >= 2 {
            let (a, b) = (unique[0].clone(), unique[1].clone());
            return Some(if a <= b { (a, b) } else { (b, a) });
        }
    }
    None
}

/// What a line outside the table says about the balance.
#[derive(Debug, PartialEq, Eq)]
pub enum BalanceLine {
    Opening,
    Closing,
    Total,
}

/// "Opening Balance", "Balance B/F", "Closing Balance", "Total": lines that aren't transactions.
pub fn balance_line(text: &str) -> Option<BalanceLine> {
    let l = text.to_lowercase();
    if ["opening balance", "balance b/f", "balance brought forward", "brought forward", "previous balance", "beginning balance", "opening bal"].iter().any(|k| l.contains(k)) {
        Some(BalanceLine::Opening)
    } else if ["closing balance", "balance c/f", "carried forward", "ending balance", "closing bal", "available balance"].iter().any(|k| l.contains(k)) {
        Some(BalanceLine::Closing)
    } else if l.split_whitespace().any(|w| w == "total" || w == "totals" || w == "total:") {
        Some(BalanceLine::Total)
    } else {
        None
    }
}

/// The amount on a balance line: the last money on it.
pub fn last_money(cells: &[String], currency: &str) -> Option<i64> {
    cells.iter().rev().find_map(|c| {
        // "Opening Balance: 50,000.00" may be one cell.
        let tail = c.rsplit([':', ' ']).find(|p| !p.trim().is_empty()).unwrap_or(c);
        money(tail, currency).or_else(|| money(c, currency)).map(|(m, s)| if s < 0 { -m } else { m })
    })
}

/// Which way a "Type" word moves money: −1 out, +1 in, 0 unknown.
pub fn direction(kind: &str) -> i32 {
    let k = kind.to_lowercase();
    const OUT: [&str; 18] = ["cash out", "send money", "payment", "pay bill", "bill pay", "merchant", "withdraw", "debit", "transfer to", "recharge", "airtime", "fee", "charge", "purchase", "pos ", "atm", "sent", "paid"];
    const IN: [&str; 13] = ["cash in", "received", "receive", "add money", "deposit", "credit", "refund", "cashback", "salary", "transfer from", "remittance", "interest", "inward"];
    if k.trim() == "dr" || k.trim() == "d" {
        return -1;
    }
    if k.trim() == "cr" || k.trim() == "c" {
        return 1;
    }
    if OUT.iter().any(|w| k.contains(w)) {
        -1
    } else if IN.iter().any(|w| k.contains(w)) {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_name_their_columns() {
        assert_eq!(role_of("Txn Date"), Some(Role::Date));
        assert_eq!(role_of("Particulars"), Some(Role::Description));
        assert_eq!(role_of("Withdrawal (৳)"), Some(Role::Debit));
        assert_eq!(role_of("In (৳)"), Some(Role::Credit));
        assert_eq!(role_of("Balance (BDT)"), Some(Role::Balance));
        assert_eq!(role_of("Chq/Ref No"), Some(Role::Reference));
        assert_eq!(role_of("Trx ID"), Some(Role::Reference));
        assert_eq!(role_of("Transaction Type"), Some(Role::Kind));
        assert_eq!(role_of("Hello world"), None);
    }

    #[test]
    fn amounts_and_dates() {
        assert_eq!(money("1,25,000.50", "BDT"), Some((12_500_050, 0)));
        assert_eq!(money("(450.00)", "BDT"), Some((45_000, -1)));
        assert_eq!(money("450.00 Dr", "BDT"), Some((45_000, -1)));
        assert_eq!(money("Tk 85,000 Cr", "BDT"), Some((8_500_000, 1)));
        assert_eq!(money("05/10/2026", "BDT"), None);
        assert_eq!(money("01712-345678", "BDT"), None);
        assert_eq!(money("FOODPANDA 1234", "BDT"), None);
        assert_eq!(money("1.2.3", "BDT"), None);
        assert_eq!(money("123456 18,000.00", "BDT"), None);
        assert_eq!(money("Tk 1,000", "BDT"), Some((100_000, 0)));
        assert_eq!(date("05/10/2026", "dmy").as_deref(), Some("2026-10-05"));
        assert_eq!(date("05-Oct-26", "dmy").as_deref(), Some("2026-10-05"));
        assert_eq!(date("2026-10-05 14:22:10", "dmy").as_deref(), Some("2026-10-05"));
        assert_eq!(date("10/25/2026", "mdy").as_deref(), Some("2026-10-25"));
        assert_eq!(date("Balance", "dmy"), None);
        assert_eq!(date_order(["05/10/2026", "25/10/2026"].into_iter()), "dmy");
        assert_eq!(date_order(["10/05/2026", "10/25/2026"].into_iter()), "mdy");
    }

    #[test]
    fn the_lines_around_the_table() {
        let lines: Vec<String> = [
            "THE CITY BANK LIMITED",
            "Statement of Account",
            "Account No: 1234-5678-9012    Currency: BDT",
            "Statement Period: 01/10/2026 to 31/10/2026",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(bank(&lines).as_deref(), Some("The City Bank"));
        assert_eq!(account_last4(&lines).as_deref(), Some("9012"));
        assert_eq!(period(&lines, "dmy"), Some(("2026-10-01".into(), "2026-10-31".into())));
        let wallet: Vec<String> = ["bKash Statement", "Account: 01712-345678", "From 01-Oct-2026 To 31-Oct-2026"].iter().map(|s| s.to_string()).collect();
        assert_eq!(bank(&wallet).as_deref(), Some("bKash"));
        assert_eq!(account_last4(&wallet).as_deref(), Some("5678"));
        assert_eq!(period(&wallet, "dmy"), Some(("2026-10-01".into(), "2026-10-31".into())));
        assert_eq!(balance_line("Opening Balance"), Some(BalanceLine::Opening));
        assert_eq!(balance_line("Balance C/F"), Some(BalanceLine::Closing));
        assert_eq!(balance_line("Total"), Some(BalanceLine::Total));
        assert_eq!(last_money(&["Opening Balance: 50,000.00".to_string()], "BDT"), Some(5_000_000));
        assert_eq!(direction("Cash Out"), -1);
        assert_eq!(direction("Cash In"), 1);
        assert_eq!(direction("Send Money"), -1);
    }
}
