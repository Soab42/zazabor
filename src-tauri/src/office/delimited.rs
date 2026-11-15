//! Delimited text (CSV, TSV) as RFC 4180 has it. Kept free of the rest of Office so the
//! phone wallet (`mobile/`) can build it too.

/// Splits delimited text into rows of fields, as RFC 4180 has it: quotes around a field allow the
/// separator, line breaks and doubled quotes inside it. A byte-order mark is dropped.
pub(crate) fn parse_delimited(text: &str, sep: char) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == sep {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// A field as delimited text writes it: quoted when it holds the separator, a quote or a line break.
pub(crate) fn quote_field(value: &str, sep: char) -> String {
    if value.contains(sep) || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}
