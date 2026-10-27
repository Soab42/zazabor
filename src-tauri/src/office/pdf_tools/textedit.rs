//! Editing existing text in place with PDFium (docs/plans/pdf.md §4.6, one line at a time).
//!
//! A click picks the text object under it and the others beside it on the same baseline in the
//! same font and size (a line, as most PDF makers write one: a run per word or kerning change).
//! The new text replaces the line, starting where it started, in the same font when that font has
//! every letter (its glyphs, not only a code for them: embedded fonts are usually subsets). When it
//! hasn't, the line goes into the closest standard font (Helvetica, Times or Courier, bold and
//! italic kept), and the note says so. No reflow: longer text runs on past the line's old end.
//! Text in scripts that need shaping (Bangla, Devanagari, Arabic…) is refused: PDFs store it as
//! shaped glyphs, and rewriting it would garble it.

use super::pdfium::{self, normal, Api, Doc, Page, TextPage, TEXT};
use super::{page_id, redact};
use lopdf::Document;
use pdfium_render::prelude::{FPDF_PAGEOBJECT, FS_MATRIX};
use serde::{Deserialize, Serialize};

/// The line under a click, for the page to edit.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// The text objects, as indexes into the page's objects.
    pub objects: Vec<usize>,
    pub text: String,
    /// left, bottom, right, top on the page.
    pub rect: [f32; 4],
    pub font: String,
    /// Where the line's baseline starts, on the page.
    pub baseline: [f32; 2],
    /// The size the text shows at, in points.
    pub size: f32,
    /// Degrees, counterclockwise.
    pub angle: f32,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub serif: bool,
    pub mono: bool,
    /// Why it can't be edited, when it can't.
    pub refused: Option<String>,
}

/// One edit: the line (as `Line` gave it) and its new text.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSpec {
    pub page: u32,
    pub objects: Vec<usize>,
    pub old: String,
    pub text: String,
}

/// The line at (x, y) on page `number` (from 1), if there's text there.
pub fn line_at(pdf: &[u8], password: Option<&str>, number: u32, x: f32, y: f32) -> Result<Option<Line>, String> {
    pdfium::session(|api| {
        let file = Doc::open(api, pdf.to_vec(), password)?;
        let page = file.page((number as usize).checked_sub(1).ok_or("There's no page 0.")?)?;
        let objects = page.objects();
        let text = page.text()?;
        // The character under the point, else the nearest within a couple of points.
        let mut best: Option<(f32, FPDF_PAGEOBJECT)> = None;
        for i in 0..text.count() {
            let obj = text.object(i);
            let Some(b) = text.char_box(i).filter(|_| !obj.is_null()) else { continue };
            let dx = (b[0] - x).max(x - b[2]).max(0.0);
            let dy = (b[1] - y).max(y - b[3]).max(0.0);
            let d = dx.hypot(dy);
            if d <= 2.0 && best.is_none_or(|(e, _)| d < e) {
                best = Some((d, obj));
            }
        }
        let Some((_, hit)) = best else { return Ok(None) };
        let Some(at) = objects.iter().position(|&o| o == hit) else {
            return Ok(Some(refused_line(api, &text, hit, "This text is inside a group (a form XObject) PDFium can't rewrite in place. Use Add Text over a white box instead.")));
        };
        let group = line_of(api, &objects, at);
        let joined = joined_text(api, &text, &objects, &group);
        let font = api.font(hit);
        let name = api.font_name(font);
        let m = api.matrix(hit);
        let scale = (m.a * m.d - m.b * m.c).abs().sqrt();
        let rect = group.iter().filter_map(|&i| api.bounds(objects[i]).map(normal)).fold([f32::MAX, f32::MAX, f32::MIN, f32::MIN], |a, b| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]);
        let (bold, italic, serif, mono) = style_of(&name, api.font_weight(font));
        let start = api.matrix(objects[group[0]]);
        let refused = if joined.trim().is_empty() || joined.contains('\u{fffd}') {
            Some("This text's font doesn't say which letters its glyphs are, so it can't be edited. Use Add Text over a white box instead.".to_string())
        } else if needs_shaping(&joined) {
            Some("Bangla and other scripts that join their letters are stored as shaped glyphs, so they can't be edited in place. Use Add Text instead.".to_string())
        } else {
            None
        };
        let (mut r, mut g, mut b, mut a) = (0, 0, 0, 255);
        unsafe { api.b.FPDFPageObj_GetFillColor(hit, &mut r, &mut g, &mut b, &mut a) };
        Ok(Some(Line {
            objects: group,
            text: joined,
            rect,
            baseline: [start.e, start.f],
            font: name,
            size: api.font_size(hit) * scale,
            angle: m.b.atan2(m.a).to_degrees(),
            color: format!("#{r:02x}{g:02x}{b:02x}"),
            bold,
            italic,
            serif,
            mono,
            refused,
        }))
    })
}

fn refused_line(api: Api, text: &TextPage, obj: FPDF_PAGEOBJECT, why: &str) -> Line {
    Line {
        objects: Vec::new(),
        text: text.object_text(obj),
        rect: api.bounds(obj).map(normal).unwrap_or_default(),
        baseline: [0.0, 0.0],
        font: String::new(),
        size: 0.0,
        angle: 0.0,
        color: "#000000".into(),
        bold: false,
        italic: false,
        serif: false,
        mono: false,
        refused: Some(why.into()),
    }
}

/// The objects of the line object `at` is on: text in the same font, size and direction, on the
/// same baseline, each starting within a few letters of the one before.
fn line_of(api: Api, objects: &[FPDF_PAGEOBJECT], at: usize) -> Vec<usize> {
    let first = objects[at];
    let (font, size, m) = (api.font(first), api.font_size(first), api.matrix(first));
    let len = m.a.hypot(m.b).max(1e-6);
    let dir = (m.a / len, m.b / len);
    let em = size * (m.a * m.d - m.b * m.c).abs().sqrt();
    let same = |o: FPDF_PAGEOBJECT| {
        let n = api.matrix(o);
        api.kind(o) == TEXT && api.font(o) == font && (api.font_size(o) - size).abs() < 0.01 && [(n.a, m.a), (n.b, m.b), (n.c, m.c), (n.d, m.d)].iter().all(|(p, q)| (p - q).abs() < 1e-3)
    };
    // Along the baseline: where each candidate starts and ends.
    let extent = |o: FPDF_PAGEOBJECT| -> Option<(f32, f32, f32)> {
        let n = api.matrix(o);
        let across = (n.e - m.e) * -dir.1 + (n.f - m.f) * dir.0;
        let b = api.bounds(o)?;
        let along = |x: f32, y: f32| (x - m.e) * dir.0 + (y - m.f) * dir.1;
        let ends = [along(b[0], b[1]), along(b[2], b[1]), along(b[0], b[3]), along(b[2], b[3])];
        Some((across, ends.iter().copied().fold(f32::MAX, f32::min), ends.iter().copied().fold(f32::MIN, f32::max)))
    };
    let mut on_line: Vec<(usize, f32, f32)> = objects
        .iter()
        .enumerate()
        .filter(|&(_, &o)| same(o))
        .filter_map(|(i, &o)| extent(o).filter(|e| e.0.abs() < 0.2 * em).map(|e| (i, e.1, e.2)))
        .collect();
    on_line.sort_by(|a, b| a.1.total_cmp(&b.1));
    let Some(k) = on_line.iter().position(|e| e.0 == at) else { return vec![at] };
    let gap = 1.5 * em;
    let (mut lo, mut hi) = (k, k);
    while lo > 0 && on_line[lo].1 - on_line[lo - 1].2 < gap {
        lo -= 1;
    }
    while hi + 1 < on_line.len() && on_line[hi + 1].1 - on_line[hi].2 < gap {
        hi += 1;
    }
    on_line[lo..=hi].iter().map(|e| e.0).collect()
}

/// The line's text, with a space where the objects have a gap between them and no space of their own.
fn joined_text(api: Api, text: &TextPage, objects: &[FPDF_PAGEOBJECT], group: &[usize]) -> String {
    pieces(api, text, objects, group).iter().map(|p| format!("{}{}", p.1, p.2)).collect::<String>().trim_end_matches(['\r', '\n']).to_string()
}

/// Each object of the line: its index, the space put before it (if any) and its text.
fn pieces(api: Api, text: &TextPage, objects: &[FPDF_PAGEOBJECT], group: &[usize]) -> Vec<(usize, &'static str, String)> {
    let mut out: Vec<(usize, &'static str, String)> = Vec::new();
    let mut last_end: Option<f32> = None;
    for &i in group {
        let o = objects[i];
        let t = text.object_text(o).trim_end_matches(['\r', '\n']).to_string();
        let b = api.bounds(o).map(normal).unwrap_or_default();
        let mut gap = "";
        if let (Some(end), Some(prev)) = (last_end, out.last()) {
            let em = api.font_size(o) * { let m = api.matrix(o); (m.a * m.d - m.b * m.c).abs().sqrt() };
            if b[0] - end > 0.15 * em && !prev.2.ends_with(char::is_whitespace) && !t.starts_with(char::is_whitespace) {
                gap = " ";
            }
        }
        out.push((i, gap, t));
        last_end = Some(b[2]);
    }
    out
}

fn needs_shaping(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c as u32,
            0x0590..=0x08FF // Hebrew, Arabic, Syriac, Thaana…
            | 0x0900..=0x0DFF // Devanagari, Bangla and the other Indic scripts
            | 0x0E00..=0x0FFF // Thai, Lao, Tibetan
            | 0x1000..=0x109F // Myanmar
            | 0x1780..=0x17FF // Khmer
            | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF)
    })
}

fn style_of(name: &str, weight: i32) -> (bool, bool, bool, bool) {
    let n = name.to_ascii_lowercase();
    let bold = weight >= 600 || ["bold", "black", "heavy", "semibold", "demi"].iter().any(|w| n.contains(w));
    let italic = n.contains("italic") || n.contains("oblique");
    let mono = ["courier", "mono", "consol", "typewriter"].iter().any(|w| n.contains(w));
    let serif = !mono && !n.contains("sans") && ["times", "serif", "roman", "georgia", "garamond", "cambria", "book", "minion", "palatino", "caslon", "baskerville"].iter().any(|w| n.contains(w));
    (bold, italic, serif, mono)
}

/// The standard font closest to `name`.
fn standard_for(name: &str, weight: i32) -> &'static str {
    let (bold, italic, serif, mono) = style_of(name, weight);
    match (serif, mono, bold, italic) {
        (_, true, false, false) => "Courier",
        (_, true, true, false) => "Courier-Bold",
        (_, true, false, true) => "Courier-Oblique",
        (_, true, true, true) => "Courier-BoldOblique",
        (true, _, false, false) => "Times-Roman",
        (true, _, true, false) => "Times-Bold",
        (true, _, false, true) => "Times-Italic",
        (true, _, true, true) => "Times-BoldItalic",
        (_, _, false, false) => "Helvetica",
        (_, _, true, false) => "Helvetica-Bold",
        (_, _, false, true) => "Helvetica-Oblique",
        (_, _, true, true) => "Helvetica-BoldOblique",
    }
}

/// Whether the standard fonts (WinAnsi) can show `c`.
fn win_ansi(c: char) -> bool {
    matches!(c as u32, 0x20..=0x7E | 0xA0..=0xFF) || "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".contains(c)
}

fn squeeze(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Applies `spec` (from `run`, on the decrypted document).
pub(super) fn edit(doc: &mut Document, spec: &EditSpec, notes: &mut Vec<String>) -> Result<(), String> {
    let page = page_id(doc, spec.page)?;
    let new = spec.text.replace(['\r', '\n', '\t'], " ");
    if spec.objects.is_empty() {
        return Err("Click a line of text first.".into());
    }
    if needs_shaping(&new) {
        return Err("Bangla and other scripts that join their letters can't be typed into a PDF's own text. Use Add Text instead.".into());
    }
    redact::single_stream(doc, page)?;
    doc.encryption_state = None;
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(|e| e.to_string())?;

    let out = pdfium::session(|api| {
        let file = Doc::open(api, bytes, None)?;
        let page = file.page(spec.page as usize - 1)?;
        let objects = page.objects();
        let line: Vec<FPDF_PAGEOBJECT> = spec.objects.iter().map(|&i| objects.get(i).copied().filter(|&o| api.kind(o) == TEXT)).collect::<Option<_>>().ok_or("The page changed: click the text again.")?;
        let text = page.text()?;
        let parts = pieces(api, &text, &objects, &spec.objects);
        drop(text);
        let now: String = parts.iter().map(|p| format!("{}{}", p.1, p.2)).collect();
        if squeeze(&now) != squeeze(&spec.old) {
            return Err("The page changed: click the text again.".into());
        }
        // Runs at either end the edit leaves as they were stay, in their places (a list's number
        // and the gap after it, say); the text between goes into the first run changed.
        let (mut lo, mut hi) = (0, parts.len() - 1);
        let mut rest: &str = &new;
        while lo < hi {
            let head = format!("{}{}", parts[lo].2, parts[lo + 1].1);
            match rest.strip_prefix(head.as_str()) {
                Some(r) => {
                    rest = r;
                    lo += 1;
                }
                None => break,
            }
        }
        while hi > lo {
            let tail = format!("{}{}", parts[hi].1, parts[hi].2);
            match rest.strip_suffix(tail.as_str()) {
                Some(r) => {
                    rest = r;
                    hi -= 1;
                }
                None => break,
            }
        }
        let line = &line[lo..=hi];
        let new = rest.to_string();
        if new == parts[lo].2 && lo == hi {
            return Err("Nothing changed.".into());
        }
        let first = line[0];
        if new.trim().is_empty() {
            for &o in line {
                page.remove(o);
            }
            notes.push("The text was removed.".into());
        } else {
            let font = api.font(first);
            let size = api.font_size(first);
            let name = api.font_name(font);
            let mut missing: Vec<char> = new.chars().filter(|&c| !c.is_whitespace() && !api.has_glyph(font, c, size)).collect();
            missing.dedup();
            let kept = missing.is_empty() && set_text(api, &page, first, &new);
            if kept {
                for &o in &line[1..] {
                    page.remove(o);
                }
            } else {
                if let Some(c) = new.chars().find(|&c| !win_ansi(c)) {
                    return Err(format!("The file's font has no “{c}”, and the standard fonts can't show it either. Use Add Text (Edit tab) for this."));
                }
                let standard = standard_for(&name, api.font_weight(font));
                let sub = file.standard_font(standard);
                if sub.is_null() {
                    return Err("PDFium couldn't load a standard font.".into());
                }
                let m: FS_MATRIX = api.matrix(first);
                let obj = api.new_text(&file, sub, size, &new, &m, first);
                if obj.is_null() {
                    return Err("PDFium couldn't write the text.".into());
                }
                let at = page.index_of(first).ok_or("The text went missing.")?;
                page.insert(obj, at)?;
                for &o in line {
                    page.remove(o);
                }
                let shown: String = if missing.is_empty() { "some of these letters".into() } else { missing.iter().take(6).map(|c| format!("“{c}”")).collect::<Vec<_>>().join(" ") };
                let family = standard.split('-').next().unwrap_or(standard);
                notes.push(format!(
                    "The file's font{} has no {shown}, so the line is in {family} now, a standard font that looks a little different.",
                    if name.is_empty() { String::new() } else { format!(" ({name})") }
                ));
            }
        }
        page.generate()?;
        drop(page);
        file.save()
    })?;
    *doc = Document::load_mem(&out).map_err(|e| format!("The edited file couldn't be read back: {e}"))?;
    Ok(())
}

/// Sets `obj`'s text and reads it back: false when the font couldn't encode all of it.
fn set_text(api: Api, page: &Page, obj: FPDF_PAGEOBJECT, s: &str) -> bool {
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    if unsafe { api.b.FPDFText_SetText(obj, wide.as_ptr()) } == 0 {
        return false;
    }
    let Ok(text) = page.text() else { return false };
    squeeze(&text.object_text(obj)) == squeeze(s)
}
