//! True redaction with PDFium (docs/plans/pdf.md §4.5): what's under the marks is taken out of the
//! page and the rest stays as it was, text included.
//!
//! - Text: characters under a mark go. A text object only partly under one is rebuilt from the
//!   characters left, word by word at each word's own place, in the same font, size and colour.
//! - Pictures: one wholly under a mark goes; one partly under is replaced by a copy with the
//!   covered pixels painted black (in the picture's own pixels, not just drawn over).
//! - Drawings (paths, shadings) wholly under a mark go; those reaching outside stay, covered.
//! - Forms (XObjects) a mark touches are opened up into the page first, so the same applies inside.
//! - Annotations, links and form fields a mark touches go (lopdf, with their popups and replies),
//!   and so do the page's thumbnail and the structure tree, whose alternate text could say what
//!   was there.
//! - A black box is drawn over each mark.
//!
//! Then the check: PDFium reads the new file again and no character may be left under a mark.
//! The caller (`run`) writes the file out whole, unreferenced objects dropped, so the old content
//! streams and pictures don't survive in it.

use super::pdfium::{self, apply, area, inside, invert, normal, overlap, Api, Doc, Page, FORM, IMAGE, PATH, SHADING, TEXT};
use super::{page_annots, page_id, rect_of, Refs};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use pdfium_render::prelude::{FPDF_PAGEOBJECT, FS_MATRIX};
use serde::Deserialize;
use std::collections::HashMap;

/// The marks on one page (from 1), each `[x0, y0, x1, y1]` in the page's own coordinates.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarkPage {
    pub page: u32,
    pub rects: Vec<[f32; 4]>,
}

pub(super) fn redact(doc: &mut Document, pages: &[MarkPage], notes: &mut Vec<String>) -> Result<(), String> {
    let mut by_page: Vec<MarkPage> = Vec::new();
    for p in pages {
        let rects: Vec<[f32; 4]> = p.rects.iter().map(|&r| normal(r)).filter(|r| r.iter().all(|v| v.is_finite()) && r[2] > r[0] && r[3] > r[1]).collect();
        if rects.is_empty() {
            continue;
        }
        page_id(doc, p.page)?;
        match by_page.iter_mut().find(|q| q.page == p.page) {
            Some(q) => q.rects.extend(rects),
            None => by_page.push(MarkPage { page: p.page, rects }),
        }
    }
    if by_page.is_empty() {
        return Err("There are no marks to apply.".into());
    }
    // One content stream per marked page: PDFium puts what it adds into a page's first stream, so
    // with several, the rebuilt text would be drawn before (under) the rest.
    for p in &by_page {
        single_stream(doc, page_id(doc, p.page)?)?;
    }
    // Decrypted already; `run` encrypts the result again.
    doc.encryption_state = None;
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(|e| e.to_string())?;

    let out = pdfium::session(|api| {
        let bytes = open_forms(api, bytes, &by_page)?;
        let file = Doc::load(api, bytes)?;
        for p in &by_page {
            let page = file.page(p.page as usize - 1)?;
            remove_under(api, &file, &page, &p.rects, notes).map_err(|e| format!("Page {}: {e}", p.page))?;
            page.generate()?;
        }
        let out = file.save()?;
        drop(file);
        check(api, &out, &by_page)?;
        Ok(out)
    })?;

    *doc = Document::load_mem(&out).map_err(|e| format!("The redacted file couldn't be read back: {e}"))?;
    let mut gone = Refs::new();
    for p in &by_page {
        let page = page_id(doc, p.page)?;
        for item in page_annots(doc, page) {
            let Ok(id) = item.as_reference() else { continue };
            let Some(r) = doc.get_dictionary(id).ok().and_then(|d| d.get(b"Rect").ok()).and_then(|r| rect_of(doc, r)) else { continue };
            let r = normal(r);
            if p.rects.iter().any(|m| overlap(*m, r) > 0.0 || inside(r, *m, 0.5)) {
                gone.insert(id);
            }
        }
        if let Ok(dict) = doc.get_dictionary_mut(page) {
            for key in [b"Thumb".as_slice(), b"PieceInfo", b"StructParents"] {
                dict.remove(key);
            }
        }
    }
    if !gone.is_empty() {
        notes.push(format!("{} comment{}, link{} or form field{} under the marks went too.", gone.len(), plural(gone.len()), plural(gone.len()), plural(gone.len())));
        super::annots::remove(doc, &gone);
    }
    if let Ok(c) = doc.catalog_mut() {
        c.remove(b"StructTreeRoot");
        c.remove(b"MarkInfo");
    }
    Ok(())
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// Joins a page's content streams into one.
pub(super) fn single_stream(doc: &mut Document, page: ObjectId) -> Result<(), String> {
    let ids = doc.get_page_contents(page);
    if ids.len() <= 1 {
        return Ok(());
    }
    let mut content = Vec::new();
    for id in ids {
        let Ok(s) = doc.get_object(id).and_then(Object::as_stream) else { continue };
        let data = if s.dict.get(b"Filter").is_ok() { s.decompressed_content().map_err(|e| format!("A page's content couldn't be read: {e}"))? } else { s.content.clone() };
        content.extend_from_slice(&data);
        content.push(b'\n');
    }
    let mut s = Stream::new(Dictionary::new(), content);
    let _ = s.compress();
    let id = doc.add_object(Object::Stream(s));
    doc.get_dictionary_mut(page).map_err(|e| e.to_string())?.set("Contents", Object::Reference(id));
    Ok(())
}

fn touches(marks: &[[f32; 4]], b: [f32; 4]) -> bool {
    marks.iter().any(|m| overlap(*m, b) > 0.0 || inside(b, *m, 0.5))
}

fn within(marks: &[[f32; 4]], b: [f32; 4]) -> bool {
    marks.iter().any(|m| inside(b, *m, 0.5))
}

/// Whether a character in `b` counts as under a mark: its middle is, or most of it.
fn covered(marks: &[[f32; 4]], b: [f32; 4]) -> bool {
    let (cx, cy) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
    let a = area(b);
    marks.iter().any(|m| (cx >= m[0] && cx <= m[2] && cy >= m[1] && cy <= m[3]) || (a > 0.0 && overlap(*m, b) >= 0.4 * a))
}

/// Moves what's inside each form a mark touches out onto the page (in the form's place), until
/// none is left: PDFium can't rewrite a form's own content reliably.
fn open_forms(api: Api, mut bytes: Vec<u8>, pages: &[MarkPage]) -> Result<Vec<u8>, String> {
    for _ in 0..8 {
        let file = Doc::load(api, bytes.clone())?;
        let mut changed = false;
        for p in pages {
            let page = file.page(p.page as usize - 1)?;
            let forms: Vec<FPDF_PAGEOBJECT> = page.objects().into_iter().filter(|&o| api.kind(o) == FORM && api.bounds(o).is_some_and(|b| touches(&p.rects, normal(b)))).collect();
            if forms.is_empty() {
                continue;
            }
            for form in forms {
                let m = api.matrix(form);
                let at = page.index_of(form).ok_or("A form went missing.")?;
                let n = unsafe { api.b.FPDFFormObj_CountObjects(form) }.max(0);
                let inner: Vec<FPDF_PAGEOBJECT> = (0..n).map(|i| unsafe { api.b.FPDFFormObj_GetObject(form, i as _) }).filter(|o| !o.is_null()).collect();
                for (k, &obj) in inner.iter().enumerate() {
                    if unsafe { api.b.FPDFFormObj_RemoveObject(form, obj) } == 0 {
                        return Err("A form on the page couldn't be opened up.".into());
                    }
                    unsafe { api.b.FPDFPageObj_TransformF(obj, &m) };
                    page.insert(obj, at + 1 + k)?;
                }
                page.remove(form);
            }
            page.generate()?;
            changed = true;
        }
        if !changed {
            return Ok(bytes);
        }
        bytes = file.save()?;
    }
    Err("The page's forms are nested too deeply to redact.".into())
}

fn remove_under(api: Api, file: &Doc, page: &Page, marks: &[[f32; 4]], notes: &mut Vec<String>) -> Result<(), String> {
    let text = page.text()?;
    // Each text object's characters, in order, and whether each is under a mark.
    let mut chars: HashMap<FPDF_PAGEOBJECT, Vec<(usize, bool)>> = HashMap::new();
    for i in 0..text.count() {
        let obj = text.object(i);
        if obj.is_null() {
            continue;
        }
        let Some(b) = text.char_box(i) else { continue };
        chars.entry(obj).or_default().push((i, covered(marks, b)));
    }

    let mut gone = Vec::new();
    let mut unreadable = 0;
    for obj in page.objects() {
        let Some(b) = api.bounds(obj).map(normal) else { continue };
        if !touches(marks, b) {
            continue;
        }
        match api.kind(obj) {
            TEXT => {
                let Some(list) = chars.get(&obj) else {
                    // Nothing PDFium can read as text (a Type 3 font, say), so it can't be split:
                    // all of it goes.
                    gone.push(obj);
                    continue;
                };
                if !list.iter().any(|c| c.1) {
                    continue;
                }
                if list.iter().all(|c| c.1) {
                    gone.push(obj);
                    continue;
                }
                // The rest, a word at a time where each word started.
                let (font, size, m) = (api.font(obj), api.font_size(obj), api.matrix(obj));
                let mut runs: Vec<Vec<usize>> = vec![Vec::new()];
                for &(i, hidden) in list {
                    if hidden || text.unicode(i).is_whitespace() {
                        runs.push(Vec::new());
                    } else {
                        runs.last_mut().expect("a run").push(i);
                    }
                }
                let mut at = page.index_of(obj).ok_or("A text went missing.")?;
                for run in runs.into_iter().filter(|r| !r.is_empty()) {
                    let word: String = run.iter().map(|&i| text.unicode(i)).collect();
                    let Some((x, y)) = text.origin(run[0]) else { continue };
                    let new = api.new_text(file, font, size, &word, &FS_MATRIX { e: x, f: y, ..m }, obj);
                    if new.is_null() {
                        continue;
                    }
                    page.insert(new, at)?;
                    at += 1;
                }
                gone.push(obj);
            }
            IMAGE => {
                if within(marks, b) {
                    gone.push(obj);
                    continue;
                }
                match painted(api, file, obj, marks) {
                    Some(new) => {
                        let at = page.index_of(obj).ok_or("A picture went missing.")?;
                        page.insert(new, at)?;
                    }
                    None => unreadable += 1,
                }
                gone.push(obj);
            }
            PATH | SHADING => {
                if within(marks, b) {
                    gone.push(obj);
                }
            }
            FORM => return Err("a form under a mark couldn't be opened up".into()),
            _ => {
                if within(marks, b) {
                    gone.push(obj);
                }
            }
        }
    }
    // The text page refers to the objects: closed before any is freed.
    drop(text);
    for obj in gone {
        page.remove(obj);
    }
    for &m in marks {
        let bx = api.black_box(m);
        if !bx.is_null() {
            page.insert(bx, page.objects().len())?;
        }
    }
    if unreadable > 0 {
        notes.push(format!("{unreadable} picture{} partly under a mark couldn't be read, so {} removed whole.", plural(unreadable), if unreadable == 1 { "it was" } else { "they were" }));
    }
    Ok(())
}

/// A copy of picture `obj` with the pixels under the marks painted black, placed the same way.
fn painted(api: Api, file: &Doc, obj: FPDF_PAGEOBJECT, marks: &[[f32; 4]]) -> Option<FPDF_PAGEOBJECT> {
    let mut bitmap = api.bitmap(obj)?;
    let (w, h, stride, bpp) = bitmap.layout();
    if w == 0 || h == 0 {
        return None;
    }
    // The picture's unit square is placed on the page by its matrix; row 0 is its top.
    let m = api.matrix(obj);
    let inv = invert(&m)?;
    let pixel = ((m.a * m.a + m.b * m.b).sqrt() / w as f32).max((m.c * m.c + m.d * m.d).sqrt() / h as f32);
    let data = bitmap.pixels();
    if data.len() < stride * h {
        return None;
    }
    for r in marks {
        let r = [r[0] - pixel, r[1] - pixel, r[2] + pixel, r[3] + pixel];
        let quad: Vec<(f32, f32)> = [(r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])]
            .iter()
            .map(|&(x, y)| {
                let (u, v) = apply(&inv, x, y);
                (u * w as f32, (1.0 - v) * h as f32)
            })
            .collect();
        let x0 = quad.iter().map(|p| p.0).fold(f32::MAX, f32::min).floor().max(0.0) as usize;
        let x1 = (quad.iter().map(|p| p.0).fold(f32::MIN, f32::max).ceil().max(0.0) as usize).min(w);
        let y0 = quad.iter().map(|p| p.1).fold(f32::MAX, f32::min).floor().max(0.0) as usize;
        let y1 = (quad.iter().map(|p| p.1).fold(f32::MIN, f32::max).ceil().max(0.0) as usize).min(h);
        for y in y0..y1 {
            for x in x0..x1 {
                if in_quad(&quad, x as f32 + 0.5, y as f32 + 0.5) {
                    let at = y * stride + x * bpp;
                    data[at..at + bpp.min(3)].fill(0);
                    if bpp == 4 {
                        data[at + 3] = 255;
                    }
                }
            }
        }
    }
    let new = unsafe { api.b.FPDFPageObj_NewImageObj(file.handle) };
    if new.is_null() {
        return None;
    }
    if unsafe { api.b.FPDFImageObj_SetBitmap(std::ptr::null_mut(), 0, new, bitmap.handle) } == 0 {
        unsafe { api.b.FPDFPageObj_Destroy(new) };
        return None;
    }
    api.set_matrix(new, &m);
    Some(new)
}

/// Whether (x, y) is inside the convex quadrilateral `q`.
fn in_quad(q: &[(f32, f32)], x: f32, y: f32) -> bool {
    let mut sign = 0.0f32;
    for i in 0..q.len() {
        let (a, b) = (q[i], q[(i + 1) % q.len()]);
        let cross = (b.0 - a.0) * (y - a.1) - (b.1 - a.1) * (x - a.0);
        if cross.abs() < 1e-6 {
            continue;
        }
        if sign == 0.0 {
            sign = cross.signum();
        } else if cross.signum() != sign {
            return false;
        }
    }
    true
}

/// No character may be left under a mark (its middle, a little inside the mark's edge).
fn check(api: Api, out: &[u8], pages: &[MarkPage]) -> Result<(), String> {
    let file = Doc::load(api, out.to_vec())?;
    for p in pages {
        let page = file.page(p.page as usize - 1)?;
        let text = page.text()?;
        let inner: Vec<[f32; 4]> = p.rects.iter().map(|r| [r[0] + 0.5, r[1] + 0.5, r[2] - 0.5, r[3] - 0.5]).collect();
        let mut left = String::new();
        for i in 0..text.count() {
            let c = text.unicode(i);
            if c.is_whitespace() || text.object(i).is_null() {
                continue;
            }
            let Some(b) = text.char_box(i) else { continue };
            let (cx, cy) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
            if inner.iter().any(|m| cx >= m[0] && cx <= m[2] && cy >= m[1] && cy <= m[3]) {
                left.push(c);
            }
        }
        if !left.is_empty() {
            return Err(format!("On page {}, text under the marks is still there after removing it, so nothing was changed. Use “Replace pages with pictures” for this file.", p.page));
        }
    }
    Ok(())
}
