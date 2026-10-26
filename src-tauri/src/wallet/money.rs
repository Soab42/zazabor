//! Amounts: whole numbers in a currency's minor unit (poisha, cents), never floats. The page only
//! formats them; reading typed amounts and converting between currencies happens here.

use serde::Serialize;

/// The currency totals and reports are in.
pub const BASE: &str = "BDT";
/// Exchange rates are integer millionths: 1 unit of a currency = `rate_micro / 1e6` base units.
pub const RATE_ONE: i64 = 1_000_000;

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Currency {
    pub code: &'static str,
    pub symbol: &'static str,
    /// Digits after the decimal point (2 for BDT, 0 for JPY, 3 for KWD).
    pub exponent: u32,
    pub name: &'static str,
}

/// The currencies an account or a rate can be in.
pub const CURRENCIES: &[Currency] = &[
    Currency { code: "BDT", symbol: "৳", exponent: 2, name: "Bangladeshi taka" },
    Currency { code: "USD", symbol: "$", exponent: 2, name: "US dollar" },
    Currency { code: "EUR", symbol: "€", exponent: 2, name: "Euro" },
    Currency { code: "GBP", symbol: "£", exponent: 2, name: "British pound" },
    Currency { code: "INR", symbol: "₹", exponent: 2, name: "Indian rupee" },
    Currency { code: "SAR", symbol: "SAR ", exponent: 2, name: "Saudi riyal" },
    Currency { code: "AED", symbol: "AED ", exponent: 2, name: "UAE dirham" },
    Currency { code: "QAR", symbol: "QAR ", exponent: 2, name: "Qatari riyal" },
    Currency { code: "KWD", symbol: "KWD ", exponent: 3, name: "Kuwaiti dinar" },
    Currency { code: "OMR", symbol: "OMR ", exponent: 3, name: "Omani rial" },
    Currency { code: "MYR", symbol: "RM", exponent: 2, name: "Malaysian ringgit" },
    Currency { code: "SGD", symbol: "S$", exponent: 2, name: "Singapore dollar" },
    Currency { code: "CAD", symbol: "C$", exponent: 2, name: "Canadian dollar" },
    Currency { code: "AUD", symbol: "A$", exponent: 2, name: "Australian dollar" },
    Currency { code: "JPY", symbol: "¥", exponent: 0, name: "Japanese yen" },
    Currency { code: "CNY", symbol: "CN¥", exponent: 2, name: "Chinese yuan" },
];

pub fn currency(code: &str) -> Option<&'static Currency> {
    CURRENCIES.iter().find(|c| c.code == code)
}

pub fn exponent(code: &str) -> u32 {
    currency(code).map_or(2, |c| c.exponent)
}

/// Reads a typed amount ("1,250.50", "৳ 250", "1.2k", "45000") into minor units of `code`. The
/// sign is ignored: whether money goes in or out is the transaction's kind. `None` when it isn't
/// a number, or has more decimals than the currency.
pub fn parse_amount(text: &str, code: &str) -> Option<i64> {
    let exp = exponent(code);
    let cleaned: String = text
        .trim()
        .trim_start_matches(['+', '-', '−'])
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',' && *c != '_')
        .collect();
    let cleaned = cleaned.trim_start_matches(|c: char| !c.is_ascii_digit() && c != '.');
    let (number, factor) = match cleaned.chars().last()? {
        'k' | 'K' => (&cleaned[..cleaned.len() - 1], 1_000i64),
        'm' | 'M' => (&cleaned[..cleaned.len() - 1], 1_000_000i64),
        _ => (cleaned, 1),
    };
    let (whole, frac) = match number.split_once('.') {
        Some((w, f)) => (w, f),
        None => (number, ""),
    };
    if whole.is_empty() && frac.is_empty() {
        return None;
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let unit = 10i64.pow(exp);
    let whole: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    // "1.2k" may carry more decimals than the currency, as long as the result is whole.
    let frac_digits = frac.len() as u32;
    let frac_value: i64 = if frac.is_empty() { 0 } else { frac.parse().ok()? };
    let scale = 10i64.checked_pow(frac_digits)?;
    let numerator = (whole.checked_mul(scale)?.checked_add(frac_value)?).checked_mul(factor)?.checked_mul(unit)?;
    if numerator % scale != 0 {
        return None;
    }
    Some(numerator / scale)
}

/// Reads a typed exchange rate ("122.5": base units per unit) into millionths.
pub fn parse_rate(text: &str) -> Option<i64> {
    let cleaned: String = text.trim().chars().filter(|c| *c != ',' && !c.is_whitespace()).collect();
    let (whole, frac) = cleaned.split_once('.').unwrap_or((&cleaned, ""));
    if whole.is_empty() && frac.is_empty() || frac.len() > 6 {
        return None;
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let whole: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    let frac: i64 = format!("{frac:0<6}").parse().ok()?;
    let rate = whole.checked_mul(RATE_ONE)?.checked_add(frac)?;
    (rate > 0).then_some(rate)
}

/// `amount` minor units of `code` in base minor units at `rate_micro`, rounded half away from
/// zero, once.
pub fn to_base(amount: i64, code: &str, rate_micro: i64) -> i64 {
    let shift = exponent(BASE) as i32 - exponent(code) as i32;
    let mut num = amount as i128 * rate_micro as i128;
    let mut den = RATE_ONE as i128;
    if shift >= 0 {
        num *= 10i128.pow(shift as u32);
    } else {
        den *= 10i128.pow((-shift) as u32);
    }
    let half = den / 2;
    let rounded = if num >= 0 { (num + half) / den } else { (num - half) / den };
    rounded as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_amounts() {
        assert_eq!(parse_amount("250", "BDT"), Some(25_000));
        assert_eq!(parse_amount("1,25,000", "BDT"), Some(12_500_000));
        assert_eq!(parse_amount("1,250.5", "BDT"), Some(125_050));
        assert_eq!(parse_amount("৳ 99.99", "BDT"), Some(9_999));
        assert_eq!(parse_amount("+45000", "BDT"), Some(4_500_000));
        assert_eq!(parse_amount("1.2k", "BDT"), Some(120_000));
        assert_eq!(parse_amount(".5", "USD"), Some(50));
        assert_eq!(parse_amount("1500", "JPY"), Some(1_500));
        assert_eq!(parse_amount("1.5", "JPY"), None);
        assert_eq!(parse_amount("2.125", "KWD"), Some(2_125));
        assert_eq!(parse_amount("1.001", "BDT"), None);
        assert_eq!(parse_amount("lunch", "BDT"), None);
        assert_eq!(parse_amount("", "BDT"), None);
    }

    #[test]
    fn rates_and_conversion() {
        assert_eq!(parse_rate("122.5"), Some(122_500_000));
        assert_eq!(parse_rate("0"), None);
        assert_eq!(parse_rate("1.0000001"), None);
        // $12.99 at ৳122.50 = ৳1,591.275 → ৳1,591.28 (half away from zero).
        assert_eq!(to_base(1_299, "USD", 122_500_000), 159_128);
        assert_eq!(to_base(-1_299, "USD", 122_500_000), -159_128);
        assert_eq!(to_base(25_000, "BDT", RATE_ONE), 25_000);
        // ¥1,000 at ৳0.80: exponent 0 → 2.
        assert_eq!(to_base(1_000, "JPY", 800_000), 80_000);
        // KWD 1.500 at ৳400: exponent 3 → 2.
        assert_eq!(to_base(1_500, "KWD", 400 * RATE_ONE), 60_000);
    }
}
