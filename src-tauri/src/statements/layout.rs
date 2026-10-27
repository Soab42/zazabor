//! A PDF's text with positions (pdf.js's `getTextContent`, sent by the page) back into a table:
//! pieces of text → lines (by baseline) → the statement's columns (from its heading row), or plain
//! tables (columns from how the text lines up) for "Tables to Excel".

use serde::Deserialize;

use super::parse::{self, Role};

/// One piece of text on a page: its left edge and baseline from the page's top left, its width
/// and font size, in PDF points.
#[derive(Deserialize, Clone, Debug)]
pub struct Item {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub s: String,
}

impl Item {
    fn x1(&self) -> f64 {
        self.x + self.w.max(0.0)
    }
    fn center(&self) -> f64 {
        self.x + self.w.max(0.0) / 2.0
    }
}

/// Pieces on one baseline, left to right.
#[derive(Clone, Debug)]
pub struct Line {
    pub page: u32,
    pub y: f64,
    pub h: f64,
    pub items: Vec<Item>,
}

/// Words of a line grouped into cells (a gap wider than `gap_em` font sizes starts a new cell).
#[derive(Clone, Debug)]
pub struct Cell {
    pub x0: f64,
    pub x1: f64,
    pub text: String,
}

/// The pages' text as lines, top to bottom.
pub fn lines(items: &[Item]) -> Vec<Line> {
    let mut sorted: Vec<&Item> = items.iter().filter(|i| !i.s.trim().is_empty() && i.x.is_finite() && i.y.is_finite()).collect();
    sorted.sort_by(|a, b| a.page.cmp(&b.page).then(a.y.total_cmp(&b.y)).then(a.x.total_cmp(&b.x)));
    let mut out: Vec<Line> = Vec::new();
    for it in sorted {
        let h = it.h.abs().max(1.0);
        if let Some(last) = out.last_mut() {
            if last.page == it.page && (it.y - last.y).abs() <= (0.45 * h.min(last.h)).max(1.5) {
                last.items.push(it.clone());
                continue;
            }
        }
        out.push(Line { page: it.page, y: it.y, h, items: vec![it.clone()] });
    }
    for l in &mut out {
        l.items.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    out
}

/// A line's cells: pieces closer than `gap_em` font sizes are one cell.
pub fn cells(line: &Line, gap_em: f64) -> Vec<Cell> {
    let mut out: Vec<Cell> = Vec::new();
    for it in &line.items {
        let text = it.s.trim();
        if text.is_empty() {
            continue;
        }
        let h = it.h.abs().max(1.0);
        if let Some(last) = out.last_mut() {
            let gap = it.x - last.x1;
            if gap <= gap_em * h {
                if gap > 0.12 * h || it.s.starts_with(' ') || last.text.ends_with(' ') {
                    last.text.push(' ');
                }
                last.text.push_str(text);
                last.x1 = last.x1.max(it.x1());
                continue;
            }
        }
        out.push(Cell { x0: it.x, x1: it.x1(), text: text.to_string() });
    }
    for c in &mut out {
        c.text = c.text.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    out
}

/// The whole line as text, cells apart by " | ".
pub fn line_text(line: &Line) -> String {
    cells(line, 0.8).iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" | ")
}

/// A column of the statement, from its heading.
#[derive(Clone, Debug)]
pub struct Column {
    pub role: Option<Role>,
    pub x0: f64,
    pub x1: f64,
}

impl Column {
    fn numeric(&self) -> bool {
        matches!(self.role, Some(Role::Debit | Role::Credit | Role::Amount | Role::Balance))
    }
}

/// A line's words, each with its share of its piece's width.
fn words(line: &Line) -> Vec<(Cell, f64)> {
    let mut out = Vec::new();
    for it in &line.items {
        let total = it.s.chars().count().max(1) as f64;
        let per = it.w.max(0.0) / total;
        let mut at = 0usize;
        for part in it.s.split(' ') {
            let n = part.chars().count();
            if !part.trim().is_empty() {
                let x0 = it.x + at as f64 * per;
                out.push((Cell { x0, x1: x0 + n as f64 * per, text: part.trim().to_string() }, it.h.abs().max(1.0)));
            }
            at += n + 1;
        }
    }
    out
}

/// A heading row's cells. Headings can sit closer together than the words inside one ("Chq/Ref
/// No Withdrawal Deposit" with 5 points between), so known headings are picked out by name,
/// longest first; other words that sit close together stay one cell.
fn heading_cells(line: &Line) -> Vec<(Cell, Option<Role>)> {
    let ws = words(line);
    let mut out: Vec<(Cell, Option<Role>)> = Vec::new();
    let mut i = 0;
    while i < ws.len() {
        let mut found = None;
        for len in (1..=4).rev() {
            if i + len > ws.len() {
                continue;
            }
            let close = (i + 1..i + len).all(|j| ws[j].0.x0 - ws[j - 1].0.x1 <= 1.2 * ws[j].1);
            let text = ws[i..i + len].iter().map(|(c, _)| c.text.as_str()).collect::<Vec<_>>().join(" ");
            if let Some(role) = parse::role_of(&text).filter(|_| close) {
                found = Some((len, role, text));
                break;
            }
        }
        match found {
            Some((len, role, text)) => {
                out.push((Cell { x0: ws[i].0.x0, x1: ws[i + len - 1].0.x1, text }, Some(role)));
                i += len;
            }
            None => {
                let (w, h) = &ws[i];
                match out.last_mut() {
                    Some((last, None)) if w.x0 - last.x1 <= 0.8 * h => {
                        last.text = format!("{} {}", last.text, w.text);
                        last.x1 = w.x1;
                    }
                    _ => out.push((w.clone(), None)),
                }
                i += 1;
            }
        }
    }
    out
}

/// The heading row's columns, if the line is one: a date column and at least two more that a
/// statement has, one of them money.
pub fn heading_columns(line: &Line) -> Option<Vec<Column>> {
    let cells = heading_cells(line);
    if cells.len() < 3 {
        return None;
    }
    let columns: Vec<Column> = cells.iter().map(|(c, role)| Column { role: *role, x0: c.x0, x1: c.x1 }).collect();
    let roles: Vec<Role> = columns.iter().filter_map(|c| c.role).collect();
    let mut distinct: Vec<Role> = Vec::new();
    for r in &roles {
        if !distinct.contains(r) {
            distinct.push(*r);
        }
    }
    let money = roles.iter().any(|r| matches!(r, Role::Debit | Role::Credit | Role::Amount | Role::Balance));
    (roles.contains(&Role::Date) && distinct.len() >= 3 && money).then_some(columns)
}

/// Which column a piece of text falls in. Money is right-aligned under its heading; text starts
/// under its heading (or sits centred on it).
pub fn column_of(columns: &[Column], item: &Item, currency: &str) -> usize {
    // Text: the last column starting at or before it.
    let tol = (0.5 * item.h.abs()).max(6.0);
    let mut text_col = 0;
    for (i, c) in columns.iter().enumerate() {
        if c.x0 <= item.x + tol {
            text_col = i;
        }
    }
    // A piece centred on a column further right than where it starts (a centred date or ID).
    if let Some((i, _)) = columns.iter().enumerate().find(|(_, c)| item.center() >= c.x0 - 2.0 && item.center() <= c.x1 + 2.0) {
        if !columns[text_col].numeric() || columns[i].numeric() {
            text_col = text_col.max(i);
        }
    }
    if parse::money(&item.s, currency).is_none() {
        return text_col;
    }
    // Money: the money column whose right edge is nearest.
    let nearest = columns
        .iter()
        .enumerate()
        .filter(|(_, c)| c.numeric())
        .map(|(i, c)| (i, (item.x1() - c.x1).abs(), c))
        .min_by(|a, b| a.1.total_cmp(&b.1));
    let Some((i, d, c)) = nearest else { return text_col };
    let t = &columns[text_col];
    // A number under a heading that isn't money (a cheque number) stays there.
    if !t.numeric() && item.center() >= t.x0 - 10.0 && item.center() <= t.x1 + (t.x1 - t.x0).max(20.0) {
        return text_col;
    }
    if d <= (2.0 * (c.x1 - c.x0)).max(40.0) {
        i
    } else {
        text_col
    }
}

/// A line of the table split into its columns' texts.
pub fn split(line: &Line, columns: &[Column], currency: &str) -> Vec<String> {
    let mut parts: Vec<Vec<&Item>> = vec![Vec::new(); columns.len()];
    for it in &line.items {
        if it.s.trim().is_empty() {
            continue;
        }
        parts[column_of(columns, it, currency)].push(it);
    }
    parts
        .into_iter()
        .map(|items| {
            let fake = Line { page: line.page, y: line.y, h: line.h, items: items.into_iter().cloned().collect() };
            cells(&fake, 0.6).iter().map(|c| c.text.clone()).collect::<Vec<_>>().join(" ")
        })
        .collect()
}

/// The statement's table found in the lines: its columns, its lines split into them (with each
/// line's page and baseline, for telling wrapped text from a page footer), and every other line.
pub struct Found {
    pub columns: Vec<Column>,
    pub rows: Vec<(u32, f64, f64, Vec<String>)>,
    pub around: Vec<String>,
}

pub fn statement_table(lines: &[Line], currency: &str) -> Option<Found> {
    let start = lines.iter().position(|l| heading_columns(l).is_some())?;
    let columns = heading_columns(&lines[start])?;
    let mut around: Vec<String> = lines[..start].iter().map(line_text).collect();
    let mut rows = Vec::new();
    for l in &lines[start + 1..] {
        // The heading again at the top of a later page.
        if heading_columns(l).is_some() {
            continue;
        }
        let text = line_text(l);
        let lower = text.to_lowercase();
        if lower.starts_with("page ") || lower.contains("computer generated") || lower.contains("does not require") || lower.contains("signature") {
            around.push(text);
            continue;
        }
        rows.push((l.page, l.y, l.h, split(l, &columns, currency)));
    }
    Some(Found { columns, rows, around })
}

/// Plain tables: runs of lines with two or more cells, their columns from where the cells line up.
pub fn tables(lines: &[Line]) -> Vec<(u32, Vec<Vec<String>>)> {
    let mut out = Vec::new();
    let mut block: Vec<(&Line, Vec<Cell>)> = Vec::new();
    let flush = |block: &mut Vec<(&Line, Vec<Cell>)>, out: &mut Vec<(u32, Vec<Vec<String>>)>| {
        if block.len() >= 2 {
            if let Some(t) = table_of(block) {
                out.push((block[0].0.page, t));
            }
        }
        block.clear();
    };
    for l in lines {
        let cs = cells(l, 1.0);
        let joins = block.last().is_some_and(|(prev, _)| prev.page == l.page && (l.y - prev.y) <= 3.0 * l.h.max(prev.h));
        if cs.len() >= 2 || (joins && !block.is_empty() && cs.len() == 1 && block.len() >= 2) {
            if !joins {
                flush(&mut block, &mut out);
            }
            block.push((l, cs));
        } else {
            flush(&mut block, &mut out);
        }
    }
    flush(&mut block, &mut out);
    out
}

/// One block of lines as a grid. A line's pieces closer than a fifth of their size are one
/// segment (a cell's words); columns are the bands no segment of a row-like line (three segments
/// or more) crosses, so a 5-point gap between columns still splits while a sentence above or
/// below the table doesn't run across the gutters. pdf.js joins text that sits a space apart into
/// one piece ("Chq/Ref No Withdrawal"), so a segment crossing the gutters of the other rows that
/// hold figures (headings have none) is first cut there, at its words.
fn table_of(block: &[(&Line, Vec<Cell>)]) -> Option<Vec<Vec<String>>> {
    let mut segs: Vec<(f64, Vec<Cell>)> = block.iter().map(|(l, _)| (l.h, cells(l, 0.2))).collect();
    let most = segs.iter().map(|(_, s)| s.len()).max().unwrap_or(0);
    let rowlike = |n: usize| n >= 3.min(most);
    let rows: Vec<usize> = (0..segs.len()).filter(|&i| rowlike(segs[i].1.len())).collect();
    let figures: Vec<usize> = rows.iter().copied().filter(|&i| block[i].0.items.iter().any(|it| it.s.chars().any(char::is_numeric))).collect();
    let gutters_from = if figures.len() >= 2 { &figures } else { &rows };
    let cut: Vec<(usize, Vec<Cell>)> = rows
        .iter()
        .map(|&i| {
            let others = bands(gutters_from.iter().filter(|&&j| j != i).map(|&j| &segs[j]));
            let ws = words(block[i].0);
            (i, segs[i].1.iter().flat_map(|c| cut_at(c, &ws, &others)).collect())
        })
        .collect();
    for (i, cs) in cut {
        segs[i].1 = cs;
    }
    let bands = bands(rows.iter().map(|&i| &segs[i]));
    if bands.len() < 2 {
        return None;
    }
    let mut grid = Vec::new();
    for (_, line) in &segs {
        let mut row = vec![String::new(); bands.len()];
        for c in line {
            let centre = (c.x0 + c.x1) / 2.0;
            let i = bands
                .iter()
                .enumerate()
                .min_by(|(_, x), (_, y)| {
                    let dx = if centre >= x.0 && centre <= x.1 { 0.0 } else { (centre - (x.0 + x.1) / 2.0).abs() };
                    let dy = if centre >= y.0 && centre <= y.1 { 0.0 } else { (centre - (y.0 + y.1) / 2.0).abs() };
                    dx.total_cmp(&dy)
                })
                .map(|(i, _)| i)
                .unwrap_or(0);
            if !row[i].is_empty() {
                row[i].push(' ');
            }
            row[i].push_str(&c.text);
        }
        grid.push(row);
    }
    Some(grid)
}

/// The column bands of some lines' segments: spans that touch (within a tenth of their size, at
/// most 1.5 points) are one band.
fn bands<'a>(lines: impl Iterator<Item = &'a (f64, Vec<Cell>)>) -> Vec<(f64, f64)> {
    let mut spans: Vec<(f64, f64, f64)> = lines.flat_map(|(h, s)| s.iter().map(move |c| (c.x0, c.x1, *h))).collect();
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b, h) in spans {
        match out.last_mut() {
            Some(last) if a <= last.1 + (0.1 * h).min(1.5) => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// A segment cut where it crosses into the next of `bands`: before its first word centred in or
/// past that band. A segment within one band comes back whole.
fn cut_at(seg: &Cell, ws: &[(Cell, f64)], bands: &[(f64, f64)]) -> Vec<Cell> {
    let inside: Vec<&Cell> = ws.iter().map(|(w, _)| w).filter(|w| (w.x0 + w.x1) / 2.0 >= seg.x0 && (w.x0 + w.x1) / 2.0 <= seg.x1).collect();
    let crossed: Vec<&(f64, f64)> = bands.iter().filter(|b| b.1 > seg.x0 && b.0 < seg.x1).collect();
    if inside.len() < 2 || crossed.len() < 2 {
        return vec![seg.clone()];
    }
    let mut starts = vec![0];
    for b in &crossed[1..] {
        let from = *starts.last().unwrap() + 1;
        if let Some(k) = (from..inside.len()).find(|&k| (inside[k].x0 + inside[k].x1) / 2.0 >= b.0) {
            starts.push(k);
        }
    }
    starts.push(inside.len());
    starts
        .windows(2)
        .enumerate()
        .map(|(n, w)| {
            let part = &inside[w[0]..w[1]];
            Cell {
                x0: if n == 0 { seg.x0 } else { part[0].x0 },
                x1: if w[1] == inside.len() { seg.x1 } else { part[part.len() - 1].x1 },
                text: part.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" "),
            }
        })
        .collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A text item: page 1, at (x, y), width from its length at 5 points a character, size 9.
    pub fn it(x: f64, y: f64, s: &str) -> Item {
        Item { page: 1, x, y, w: s.chars().count() as f64 * 5.0, h: 9.0, s: s.to_string() }
    }

    /// A text item whose right edge is at `x1` (right-aligned money).
    pub fn right(x1: f64, y: f64, s: &str) -> Item {
        let w = s.chars().count() as f64 * 5.0;
        Item { page: 1, x: x1 - w, y, w, h: 9.0, s: s.to_string() }
    }

    pub fn city_page() -> Vec<Item> {
        vec![
            it(40.0, 40.0, "THE CITY BANK LIMITED"),
            it(40.0, 60.0, "Account No: 1234-5678-9012"),
            it(40.0, 75.0, "Statement Period: 01/10/2026 to 31/10/2026"),
            it(40.0, 90.0, "Opening Balance: 50,000.00"),
            it(40.0, 120.0, "Date"),
            it(100.0, 120.0, "Particulars"),
            it(260.0, 120.0, "Chq No"),
            right(380.0, 120.0, "Withdrawal"),
            right(450.0, 120.0, "Deposit"),
            right(530.0, 120.0, "Balance"),
            it(40.0, 135.0, "05/10/2026"),
            it(100.0, 135.0, "FOODPANDA*BD ORDER"),
            right(380.0, 135.0, "450.00"),
            right(530.0, 135.0, "49,550.00"),
            it(100.0, 144.0, "DHAKA 1212"),
            it(40.0, 160.0, "06/10/2026"),
            it(100.0, 160.0, "CHEQUE PAYMENT"),
            it(262.0, 160.0, "123456"),
            right(380.0, 160.0, "1,000.00"),
            right(530.0, 160.0, "48,550.00"),
            it(40.0, 175.0, "25/10/2026"),
            it(100.0, 175.0, "SALARY OCT ACME LTD"),
            right(450.0, 175.0, "85,000.00"),
            right(530.0, 175.0, "1,33,550.00"),
            it(100.0, 200.0, "Closing Balance"),
            right(530.0, 200.0, "1,33,550.00"),
            it(250.0, 780.0, "Page 1 of 1"),
        ]
    }

    #[test]
    fn a_statement_page_comes_apart_into_its_columns() {
        let ls = lines(&city_page());
        let found = statement_table(&ls, "BDT").expect("the heading is found");
        let roles: Vec<Option<Role>> = found.columns.iter().map(|c| c.role).collect();
        assert_eq!(roles, [Some(Role::Date), Some(Role::Description), Some(Role::Reference), Some(Role::Debit), Some(Role::Credit), Some(Role::Balance)]);
        let rows: Vec<Vec<String>> = found.rows.iter().map(|r| r.3.clone()).collect();
        assert_eq!(rows[0], ["05/10/2026", "FOODPANDA*BD ORDER", "", "450.00", "", "49,550.00"]);
        assert_eq!(rows[1], ["", "DHAKA 1212", "", "", "", ""]);
        // The cheque number stays under its heading; the amount goes to Withdrawal.
        assert_eq!(rows[2], ["06/10/2026", "CHEQUE PAYMENT", "123456", "1,000.00", "", "48,550.00"]);
        assert_eq!(rows[3], ["25/10/2026", "SALARY OCT ACME LTD", "", "", "85,000.00", "1,33,550.00"]);
        assert!(found.around.iter().any(|l| l.contains("Opening Balance")));
    }

    /// An item of a given width (as pdftotext measured it).
    fn wide(x0: f64, x1: f64, y: f64, s: &str) -> Item {
        Item { page: 1, x: x0, y, w: x1 - x0, h: 9.6, s: s.to_string() }
    }

    #[test]
    fn close_headings_and_left_aligned_money() {
        // Word positions from a statement LibreOffice wrote: 5 points between headings, the
        // amounts left-aligned under them.
        let items = vec![
            wide(58.2, 76.5, 116.0, "Txn"),
            wide(79.7, 103.6, 116.0, "Date"),
            wide(118.3, 173.4, 116.0, "Particulars"),
            wide(299.1, 338.7, 116.0, "Chq/Ref"),
            wide(341.9, 355.6, 116.0, "No"),
            wide(360.6, 418.6, 116.0, "Withdrawal"),
            wide(424.4, 463.3, 116.0, "Deposit"),
            wide(477.7, 517.6, 116.0, "Balance"),
            wide(58.2, 109.9, 129.3, "02/10/2026"),
            wide(118.3, 284.5, 129.3, "POS PURCHASE SHWAPNO GULSHAN"),
            wide(360.6, 400.6, 129.3, "1,250.00"),
            wide(477.7, 523.4, 129.3, "48,750.00"),
            wide(58.2, 109.9, 142.6, "10/10/2026"),
            wide(118.3, 280.0, 142.6, "INWARD REMITTANCE FROM AHMED"),
            wide(299.1, 336.0, 142.6, "RM55123"),
            wide(424.4, 470.1, 142.6, "25,000.00"),
            wide(477.7, 523.4, 142.6, "73,750.00"),
        ];
        let found = statement_table(&lines(&items), "BDT").expect("the heading is found");
        let roles: Vec<Option<Role>> = found.columns.iter().map(|c| c.role).collect();
        assert_eq!(roles, [Some(Role::Date), Some(Role::Description), Some(Role::Reference), Some(Role::Debit), Some(Role::Credit), Some(Role::Balance)]);
        assert_eq!(found.rows[0].3, ["02/10/2026", "POS PURCHASE SHWAPNO GULSHAN", "", "1,250.00", "", "48,750.00"]);
        assert_eq!(found.rows[1].3, ["10/10/2026", "INWARD REMITTANCE FROM AHMED", "RM55123", "", "25,000.00", "73,750.00"]);
    }

    #[test]
    fn tight_tables_split_at_their_gutters() {
        let items = vec![
            wide(58.2, 300.0, 101.0, "Account No: 1234-5678-9012 Currency: BDT"),
            wide(320.0, 360.0, 101.0, "Page 1"),
            wide(58.2, 103.6, 116.0, "Txn Date"),
            wide(118.3, 173.4, 116.0, "Particulars"),
            wide(299.1, 355.6, 116.0, "Chq/Ref No"),
            wide(360.6, 418.6, 116.0, "Withdrawal"),
            wide(424.4, 463.3, 116.0, "Deposit"),
            wide(477.7, 517.6, 116.0, "Balance"),
            wide(58.2, 109.9, 129.3, "02/10/2026"),
            wide(118.3, 284.5, 129.3, "POS PURCHASE SHWAPNO GULSHAN"),
            wide(360.6, 400.6, 129.3, "1,250.00"),
            wide(477.7, 523.4, 129.3, "48,750.00"),
            wide(58.2, 109.9, 142.6, "10/10/2026"),
            wide(118.3, 280.0, 142.6, "INWARD REMITTANCE FROM AHMED"),
            wide(299.1, 336.0, 142.6, "RM55123"),
            wide(424.4, 470.1, 142.6, "25,000.00"),
            wide(477.7, 523.4, 142.6, "73,750.00"),
        ];
        // pdf.js may report a larger size than the glyphs look; the 5-point gaps still split.
        let items: Vec<Item> = items.into_iter().map(|mut i| {
            i.h = 14.0;
            i
        }).collect();
        let t = tables(&lines(&items));
        assert_eq!(t.len(), 1);
        let t = &t[0].1[1..];
        assert_eq!(t[0], ["Txn Date", "Particulars", "Chq/Ref No", "Withdrawal", "Deposit", "Balance"]);
        assert_eq!(t[1], ["02/10/2026", "POS PURCHASE SHWAPNO GULSHAN", "", "1,250.00", "", "48,750.00"]);
        assert_eq!(t[2], ["10/10/2026", "INWARD REMITTANCE FROM AHMED", "RM55123", "", "25,000.00", "73,750.00"]);

        // pdf.js gives headings a space apart as one piece, as it read this LibreOffice page.
        let mut joined: Vec<Item> = items.into_iter().filter(|i| i.y != 116.0 || i.x < 299.0).collect();
        joined.push(wide(299.1, 418.7, 116.0, "Chq/Ref No Withdrawal"));
        joined.push(wide(424.4, 517.6, 116.0, "Deposit Balance"));
        let t = tables(&lines(&joined));
        assert_eq!(t[0].1[1], ["Txn Date", "Particulars", "Chq/Ref No", "Withdrawal", "Deposit", "Balance"]);
        assert_eq!(t[0].1[3], ["10/10/2026", "INWARD REMITTANCE FROM AHMED", "RM55123", "", "25,000.00", "73,750.00"]);

        // A heading on two lines, both joined.
        joined.push(wide(299.1, 418.7, 108.0, "Cheque or Withdrawal"));
        joined.push(wide(58.2, 103.6, 108.0, "Posted"));
        joined.push(wide(118.3, 160.0, 108.0, "Narrative"));
        let t = tables(&lines(&joined));
        assert_eq!(t[0].1[1], ["Posted", "Narrative", "Cheque or", "Withdrawal", "", ""]);
        assert_eq!(t[0].1[2], ["Txn Date", "Particulars", "Chq/Ref No", "Withdrawal", "Deposit", "Balance"]);
    }

    #[test]
    fn plain_tables_line_up_by_their_columns() {
        let items = vec![
            it(40.0, 50.0, "Item"),
            it(200.0, 50.0, "Qty"),
            it(300.0, 50.0, "Price"),
            it(40.0, 65.0, "Rice 5 kg"),
            it(200.0, 65.0, "2"),
            it(300.0, 65.0, "780.00"),
            it(40.0, 80.0, "Lentils"),
            it(200.0, 80.0, "1"),
            it(300.0, 80.0, "160.00"),
            it(40.0, 300.0, "A paragraph of plain text that is not a table at all."),
        ];
        let t = tables(&lines(&items));
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].1, vec![vec!["Item", "Qty", "Price"], vec!["Rice 5 kg", "2", "780.00"], vec!["Lentils", "1", "160.00"]]);
    }
}
