//! Annotations pdf.js doesn't make (docs/plans/pdf.md §4.3): underline, strikethrough and
//! squiggly on text, notes with a popup, and shapes. Each gets an appearance stream, so every
//! viewer draws it the same. Also removing annotations, and flattening them into the page.

use super::page::{add_resource, append_content, own_resources, set_resources};
use super::{color_obj, deref, num, page_annots, rect_obj, rect_of, real, set_page_annots, Refs};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Underline,
    StrikeOut,
    Squiggly,
    Note,
    Square,
    Circle,
    Line,
    Arrow,
    Polygon,
}

/// A new annotation, in the page's own space.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAnnot {
    pub kind: Kind,
    /// Text markup: quadrilaterals of 8 numbers each (upper left, upper right, lower left, lower
    /// right), as QuadPoints has them.
    #[serde(default)]
    pub quads: Vec<f32>,
    /// Lines: x1 y1 x2 y2. Polygons: the corners.
    #[serde(default)]
    pub points: Vec<f32>,
    /// Shapes: the box. Notes: where the icon's top left goes (x0 y0 of a box is enough).
    #[serde(default)]
    pub rect: Option<[f32; 4]>,
    #[serde(default = "red")]
    pub color: [f32; 3],
    #[serde(default)]
    pub fill: Option<[f32; 3]>,
    #[serde(default = "one")]
    pub width: f32,
    #[serde(default = "one")]
    pub opacity: f32,
    #[serde(default)]
    pub contents: String,
    #[serde(default)]
    pub author: String,
    /// Notes: the comment this one answers (a reply, /IRT), as object and generation numbers.
    #[serde(default)]
    pub in_reply_to: Option<(u32, u16)>,
}

fn red() -> [f32; 3] {
    [0.9, 0.2, 0.2]
}
fn one() -> f32 {
    1.0
}

/// A date as PDF writes it, in UTC.
pub fn pdf_date() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("D:{y:04}{m:02}{d:02}{:02}{:02}{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// A unique name for /NM.
fn unique_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("zazabor-{nanos:x}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn bbox(points: &[(f32, f32)], pad: f32) -> [f32; 4] {
    let mut r = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for &(x, y) in points {
        r[0] = r[0].min(x);
        r[1] = r[1].min(y);
        r[2] = r[2].max(x);
        r[3] = r[3].max(y);
    }
    [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad]
}

fn pairs(v: &[f32]) -> Vec<(f32, f32)> {
    v.chunks_exact(2).map(|p| (p[0], p[1])).filter(|p| p.0.is_finite() && p.1.is_finite()).collect()
}

fn rgb(c: [f32; 3]) -> String {
    c.map(|v| num(v.clamp(0.0, 1.0))).join(" ")
}

/// An appearance stream: a form drawn in the page's own space over `rect`.
fn appearance(doc: &mut Document, rect: [f32; 4], content: String, opacity: f32) -> ObjectId {
    let mut d = Dictionary::new();
    d.set("Type", "XObject");
    d.set("Subtype", "Form");
    d.set("BBox", rect_obj(rect));
    let mut res = Dictionary::new();
    let content = if opacity < 1.0 {
        let mut gs = Dictionary::new();
        gs.set("Type", "ExtGState");
        gs.set("CA", real(opacity.clamp(0.0, 1.0)));
        gs.set("ca", real(opacity.clamp(0.0, 1.0)));
        let mut states = Dictionary::new();
        states.set("GS0", Object::Dictionary(gs));
        res.set("ExtGState", Object::Dictionary(states));
        format!("/GS0 gs {content}")
    } else {
        content
    };
    d.set("Resources", Object::Dictionary(res));
    let mut s = Stream::new(d, content.into_bytes());
    let _ = s.compress();
    doc.add_object(Object::Stream(s))
}

/// Four Bézier curves for the ellipse inside `r`.
fn ellipse_path(r: [f32; 4]) -> String {
    let (cx, cy) = ((r[0] + r[2]) / 2.0, (r[1] + r[3]) / 2.0);
    let (rx, ry) = ((r[2] - r[0]) / 2.0, (r[3] - r[1]) / 2.0);
    let k = 0.552_284_8;
    let (ox, oy) = (rx * k, ry * k);
    format!(
        "{} {} m {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c h",
        num(cx + rx), num(cy),
        num(cx + rx), num(cy + oy), num(cx + ox), num(cy + ry), num(cx), num(cy + ry),
        num(cx - ox), num(cy + ry), num(cx - rx), num(cy + oy), num(cx - rx), num(cy),
        num(cx - rx), num(cy - oy), num(cx - ox), num(cy - ry), num(cx), num(cy - ry),
        num(cx + ox), num(cy - ry), num(cx + rx), num(cy - oy), num(cx + rx), num(cy),
    )
}

/// The two strokes of an open arrowhead at `tip`, coming from `from`.
fn arrow_head(from: (f32, f32), tip: (f32, f32), size: f32) -> String {
    let (dx, dy) = (tip.0 - from.0, tip.1 - from.1);
    let len = (dx * dx + dy * dy).sqrt().max(0.001);
    let (ux, uy) = (dx / len, dy / len);
    let (s, c) = (30f32.to_radians().sin(), 30f32.to_radians().cos());
    let left = (tip.0 - size * (ux * c - uy * s), tip.1 - size * (uy * c + ux * s));
    let right = (tip.0 - size * (ux * c + uy * s), tip.1 - size * (uy * c - ux * s));
    format!("{} {} m {} {} l {} {} l S", num(left.0), num(left.1), num(tip.0), num(tip.1), num(right.0), num(right.1))
}

/// Adds an annotation to `page`.
pub fn add(doc: &mut Document, page: ObjectId, a: &NewAnnot) -> Result<(), String> {
    let width = a.width.clamp(0.25, 50.0);
    let color = a.color;
    let mut dict = Dictionary::new();
    dict.set("Type", "Annot");
    dict.set("P", Object::Reference(page));
    dict.set("F", 4);
    dict.set("C", color_obj(color));
    dict.set("M", Object::string_literal(pdf_date()));
    dict.set("CreationDate", Object::string_literal(pdf_date()));
    dict.set("NM", Object::string_literal(unique_name()));
    if a.opacity < 1.0 {
        dict.set("CA", real(a.opacity.clamp(0.0, 1.0)));
    }
    if !a.author.is_empty() {
        dict.set("T", Object::String(text_string(&a.author), lopdf::StringFormat::Literal));
    }
    if !a.contents.is_empty() {
        dict.set("Contents", Object::String(text_string(&a.contents), lopdf::StringFormat::Literal));
    }
    let mut popup_rect = None;
    let (subtype, rect, content) = match a.kind {
        Kind::Underline | Kind::StrikeOut | Kind::Squiggly => {
            let quads: Vec<[(f32, f32); 4]> = a
                .quads
                .chunks_exact(8)
                .map(|q| [(q[0], q[1]), (q[2], q[3]), (q[4], q[5]), (q[6], q[7])])
                .filter(|q| q.iter().all(|p| p.0.is_finite() && p.1.is_finite()))
                .collect();
            if quads.is_empty() {
                return Err("Select some text first.".into());
            }
            let mut c = format!("{} RG ", rgb(color));
            for [ul, _, ll, lr] in &quads {
                // Along the text (u) and up across it (v), whatever the text's angle.
                let v = ((ul.0 - ll.0), (ul.1 - ll.1));
                let h = (v.0 * v.0 + v.1 * v.1).sqrt();
                let at = |p: (f32, f32), t: f32| (p.0 + v.0 * t, p.1 + v.1 * t);
                match a.kind {
                    Kind::Underline => {
                        let (s, e) = (at(*ll, 0.12), at(*lr, 0.12));
                        c.push_str(&format!("{} w {} {} m {} {} l S ", num((h / 16.0).max(0.5)), num(s.0), num(s.1), num(e.0), num(e.1)));
                    }
                    Kind::StrikeOut => {
                        let (s, e) = (at(*ll, 0.42), at(*lr, 0.42));
                        c.push_str(&format!("{} w {} {} m {} {} l S ", num((h / 16.0).max(0.5)), num(s.0), num(s.1), num(e.0), num(e.1)));
                    }
                    _ => {
                        // A zigzag along the bottom of the text.
                        let u = (lr.0 - ll.0, lr.1 - ll.1);
                        let len = (u.0 * u.0 + u.1 * u.1).sqrt();
                        let step = (h / 6.0).max(1.5);
                        let n = ((len / step).ceil() as usize).clamp(1, 4000);
                        c.push_str(&format!("{} w ", num((h / 22.0).max(0.4))));
                        for i in 0..=n {
                            let t = i as f32 / n as f32;
                            let base = (ll.0 + u.0 * t, ll.1 + u.1 * t);
                            let p = at(base, if i % 2 == 0 { 0.02 } else { 0.12 });
                            c.push_str(&format!("{} {} {} ", num(p.0), num(p.1), if i == 0 { "m" } else { "l" }));
                        }
                        c.push_str("S ");
                    }
                }
            }
            let all: Vec<(f32, f32)> = quads.iter().flatten().copied().collect();
            dict.set("QuadPoints", Object::Array(a.quads.iter().map(|&v| real(v)).collect()));
            let name = match a.kind {
                Kind::Underline => "Underline",
                Kind::StrikeOut => "StrikeOut",
                _ => "Squiggly",
            };
            (name, bbox(&all, 1.0), c)
        }
        Kind::Note if a.in_reply_to.is_some() => {
            // A reply (Acrobat's /IRT with /RT /R): listed under its comment, not drawn. Its box is
            // a point at the comment's corner, so viewers that draw it anyway (pdf.js) put nothing
            // over the comment's icon.
            let parent = a.in_reply_to.unwrap_or_default();
            let parent: ObjectId = (parent.0, parent.1);
            let r = doc
                .get_dictionary(parent)
                .ok()
                .filter(|d| d.get(b"Subtype").is_ok())
                .and_then(|d| rect_of(doc, d.get(b"Rect").ok()?))
                .ok_or("That comment isn't in the file any more.")?;
            if a.contents.trim().is_empty() {
                return Err("Type the reply.".into());
            }
            dict.set("IRT", Object::Reference(parent));
            dict.set("RT", "R");
            dict.set("Name", "Comment");
            dict.set("F", 28);
            let (x, y) = (r[0].min(r[2]), r[1].max(r[3]));
            ("Text", [x, y, x, y], String::new())
        }
        Kind::Note => {
            let at = a.rect.ok_or("Where does the note go?")?;
            let (x, y) = (at[0], at[3].max(at[1]));
            let r = [x, y - 20.0, x + 20.0, y];
            dict.set("Name", "Comment");
            // Notes keep their size and stay upright as the page zooms and turns.
            dict.set("F", 28);
            dict.set("Open", false);
            popup_rect = Some([x + 24.0, y - 124.0, x + 224.0, y]);
            // A speech bubble with three lines of text.
            let c = format!(
                "{fill} rg 0 0 0 RG 0.6 w {x0} {y1} m {x1} {y1} l {x1} {y3} l {x2} {y3} l {x3} {y0} l {x4} {y3} l {x0} {y3} l h B \
                 1 1 1 RG 1.2 w {lx0} {ly1} m {lx1} {ly1} l S {lx0} {ly2} m {lx1} {ly2} l S {lx0} {ly3} m {lx2} {ly3} l S",
                fill = rgb(color),
                x0 = num(r[0] + 1.0), x1 = num(r[2] - 1.0), x2 = num(r[0] + 9.0), x3 = num(r[0] + 5.0), x4 = num(r[0] + 5.0),
                y0 = num(r[1] + 1.0), y1 = num(r[3] - 1.0), y3 = num(r[1] + 6.0),
                lx0 = num(r[0] + 4.0), lx1 = num(r[2] - 4.0), lx2 = num(r[2] - 9.0),
                ly1 = num(r[3] - 5.0), ly2 = num(r[3] - 9.0), ly3 = num(r[3] - 13.0),
            );
            ("Text", r, c)
        }
        Kind::Square | Kind::Circle => {
            let r = a.rect.ok_or("Draw the shape first.")?;
            let r = [r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])];
            if r[2] - r[0] < 1.0 || r[3] - r[1] < 1.0 {
                return Err("The shape is too small.".into());
            }
            let inner = [r[0] + width / 2.0, r[1] + width / 2.0, r[2] - width / 2.0, r[3] - width / 2.0];
            dict.set("BS", bs(width));
            let mut c = format!("{} RG {} w ", rgb(color), num(width));
            let paint = match a.fill {
                Some(f) => {
                    dict.set("IC", color_obj(f));
                    c.push_str(&format!("{} rg ", rgb(f)));
                    "B"
                }
                None => "S",
            };
            if a.kind == Kind::Square {
                c.push_str(&format!("{} {} {} {} re {paint}", num(inner[0]), num(inner[1]), num(inner[2] - inner[0]), num(inner[3] - inner[1])));
                ("Square", r, c)
            } else {
                c.push_str(&format!("{} {paint}", ellipse_path(inner).trim_end_matches(" h")));
                ("Circle", r, c)
            }
        }
        Kind::Line | Kind::Arrow => {
            let p = pairs(&a.points);
            if p.len() < 2 {
                return Err("Draw the line first.".into());
            }
            let (s, e) = (p[0], p[1]);
            dict.set("L", Object::Array(vec![real(s.0), real(s.1), real(e.0), real(e.1)]));
            dict.set("BS", bs(width));
            let head = (width * 4.0).max(6.0);
            let mut c = format!("{} RG {} w 1 J 1 j {} {} m {} {} l S", rgb(color), num(width), num(s.0), num(s.1), num(e.0), num(e.1));
            if a.kind == Kind::Arrow {
                dict.set("LE", Object::Array(vec![Object::Name(b"None".to_vec()), Object::Name(b"OpenArrow".to_vec())]));
                c.push(' ');
                c.push_str(&arrow_head(s, e, head));
            }
            ("Line", bbox(&p[..2], head + width), c)
        }
        Kind::Polygon => {
            let p = pairs(&a.points);
            if p.len() < 3 {
                return Err("A polygon needs at least three corners.".into());
            }
            dict.set("Vertices", Object::Array(p.iter().flat_map(|&(x, y)| [real(x), real(y)]).collect()));
            dict.set("BS", bs(width));
            let mut c = format!("{} RG {} w 1 j ", rgb(color), num(width));
            for (i, (x, y)) in p.iter().enumerate() {
                c.push_str(&format!("{} {} {} ", num(*x), num(*y), if i == 0 { "m" } else { "l" }));
            }
            let paint = match a.fill {
                Some(f) => {
                    dict.set("IC", color_obj(f));
                    c.push_str(&format!("{} rg ", rgb(f)));
                    "b"
                }
                None => "s",
            };
            c.push_str(paint);
            ("Polygon", bbox(&p, width), c)
        }
    };
    dict.set("Subtype", subtype);
    dict.set("Rect", rect_obj(rect));
    let ap = appearance(doc, rect, content, a.opacity);
    let mut aps = Dictionary::new();
    aps.set("N", Object::Reference(ap));
    dict.set("AP", Object::Dictionary(aps));
    let id = doc.add_object(Object::Dictionary(dict));
    let mut list = page_annots(doc, page);
    list.push(Object::Reference(id));
    if let Some(pr) = popup_rect {
        let mut popup = Dictionary::new();
        popup.set("Type", "Annot");
        popup.set("Subtype", "Popup");
        popup.set("Rect", rect_obj(pr));
        popup.set("Parent", Object::Reference(id));
        popup.set("Open", false);
        popup.set("F", 28);
        let pid = doc.add_object(Object::Dictionary(popup));
        if let Ok(d) = doc.get_dictionary_mut(id) {
            d.set("Popup", Object::Reference(pid));
        }
        list.push(Object::Reference(pid));
    }
    set_page_annots(doc, page, list);
    Ok(())
}

fn bs(width: f32) -> Object {
    let mut d = Dictionary::new();
    d.set("W", real(width));
    d.set("S", "S");
    Object::Dictionary(d)
}

/// A text string: plain bytes when it's ASCII, else UTF-16BE with a byte-order mark.
pub fn text_string(s: &str) -> Vec<u8> {
    if s.is_ascii() {
        return s.as_bytes().to_vec();
    }
    let mut out = vec![0xFE, 0xFF];
    for u in s.encode_utf16() {
        out.extend_from_slice(&u.to_be_bytes());
    }
    out
}

/// Removes annotations (and their popups) from every page.
pub fn remove(doc: &mut Document, refs: &Refs) {
    if refs.is_empty() {
        return;
    }
    // Popups and replies (and replies to those) of removed annotations go with them.
    let mut gone = refs.clone();
    let mut linked = Vec::new();
    for (_, page) in doc.get_pages() {
        for item in page_annots(doc, page) {
            let Ok(id) = item.as_reference() else { continue };
            if let Ok(d) = doc.get_dictionary(id) {
                let popup = d.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Popup");
                let to = if popup { d.get(b"Parent") } else { d.get(b"IRT") };
                if let Ok(parent) = to.and_then(Object::as_reference) {
                    linked.push((id, parent));
                }
            }
        }
    }
    loop {
        let more: Vec<ObjectId> = linked.iter().filter(|(id, parent)| gone.contains(parent) && !gone.contains(id)).map(|l| l.0).collect();
        if more.is_empty() {
            break;
        }
        gone.extend(more);
    }
    for (_, page) in doc.get_pages() {
        let list = page_annots(doc, page);
        let kept: Vec<Object> = list.iter().filter(|o| o.as_reference().map_or(true, |id| !gone.contains(&id))).cloned().collect();
        if kept.len() != list.len() {
            set_page_annots(doc, page, kept);
        }
    }
    remove_fields(doc, &gone);
    for id in gone {
        doc.objects.remove(&id);
    }
}

/// Drops form fields (or their widgets) that are among `gone` from the form's field tree.
pub fn remove_fields(doc: &mut Document, gone: &Refs) {
    let Some(form_id) = acroform_id(doc) else { return };
    fn prune(doc: &mut Document, list: Vec<Object>, gone: &Refs) -> Vec<Object> {
        let mut out = Vec::new();
        for item in list {
            let Ok(id) = item.as_reference() else {
                out.push(item);
                continue;
            };
            if gone.contains(&id) {
                continue;
            }
            let kids = doc.get_dictionary(id).ok().and_then(|d| d.get(b"Kids").ok()).map(|k| deref(doc, k)).and_then(|k| k.as_array().ok()).cloned();
            if let Some(kids) = kids {
                let had = kids.len();
                let kept = prune(doc, kids, gone);
                if kept.is_empty() && had > 0 {
                    continue;
                }
                if let Ok(d) = doc.get_dictionary_mut(id) {
                    d.set("Kids", Object::Array(kept));
                }
            }
            out.push(item);
        }
        out
    }
    let fields = form_dict(doc, form_id).and_then(|f| f.get(b"Fields").ok()).map(|o| deref(doc, o)).and_then(|o| o.as_array().ok()).cloned().unwrap_or_default();
    let kept = prune(doc, fields, gone);
    set_form_dict(doc, form_id, |f| f.set("Fields", Object::Array(kept)));
}

/// Where the catalog's /AcroForm is: in its own object, or inline in the catalog.
#[derive(Clone, Copy)]
pub(crate) enum FormAt {
    Object(ObjectId),
    Catalog,
}

pub(crate) fn acroform_id(doc: &Document) -> Option<FormAt> {
    let form = doc.catalog().ok()?.get(b"AcroForm").ok()?;
    Some(match form {
        Object::Reference(id) => FormAt::Object(*id),
        _ => FormAt::Catalog,
    })
}

fn form_dict(doc: &Document, at: FormAt) -> Option<&Dictionary> {
    match at {
        FormAt::Object(id) => doc.get_dictionary(id).ok(),
        FormAt::Catalog => doc.catalog().ok()?.get(b"AcroForm").ok()?.as_dict().ok(),
    }
}

fn set_form_dict(doc: &mut Document, at: FormAt, f: impl FnOnce(&mut Dictionary)) {
    match at {
        FormAt::Object(id) => {
            if let Ok(d) = doc.get_dictionary_mut(id) {
                f(d);
            }
        }
        FormAt::Catalog => {
            if let Ok(Object::Dictionary(d)) = doc.catalog_mut().and_then(|c| c.get_mut(b"AcroForm")) {
                f(d);
            }
        }
    }
}

// ---- flattening

/// Draws annotations into the page and removes them: comments (everything but links and form
/// fields) and/or form fields. Ones without an appearance can't be drawn and are left as they are.
pub fn flatten(doc: &mut Document, comments: bool, forms: bool) -> Result<(), String> {
    let mut flattened = Refs::new();
    for (_, page) in doc.get_pages() {
        let list = page_annots(doc, page);
        let mut drawn = String::new();
        let mut res = own_resources(doc, page);
        let mut kept = Vec::new();
        for item in list {
            let Some(id) = item.as_reference().ok() else {
                kept.push(item);
                continue;
            };
            let Ok(dict) = doc.get_dictionary(id) else { continue };
            let subtype = dict.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");
            let is_form = subtype == b"Widget";
            let wanted = match subtype {
                b"Link" => false,
                b"Popup" => comments,
                _ if is_form => forms,
                _ => comments,
            };
            if !wanted {
                kept.push(item);
                continue;
            }
            let flags = dict.get(b"F").ok().and_then(|f| f.as_i64().ok()).unwrap_or(0);
            // Hidden ones (and popups, which draw nothing) just go.
            let hidden = flags & 2 != 0 || flags & 32 != 0 || subtype == b"Popup";
            if !hidden {
                let Some((stream, rect)) = normal_appearance(doc, dict) else {
                    kept.push(item);
                    continue;
                };
                let Some(m) = form_matrix(doc, stream, rect) else {
                    kept.push(item);
                    continue;
                };
                // The appearance becomes a form XObject drawn by the page.
                if let Ok(Object::Stream(s)) = doc.get_object_mut(stream) {
                    s.dict.set("Type", "XObject");
                    s.dict.set("Subtype", "Form");
                }
                let name = add_resource(doc, &mut res, "XObject", "CPFlat", Object::Reference(stream));
                drawn.push_str(&format!("q {} cm /{name} Do Q\n", m.map(num).join(" ")));
            }
            flattened.insert(id);
        }
        if !drawn.is_empty() {
            set_resources(doc, page, res)?;
            append_content(doc, page, drawn.into_bytes(), false)?;
        }
        set_page_annots(doc, page, kept);
    }
    if forms {
        remove_fields(doc, &flattened);
        // A form with no fields left is no form.
        let empty = acroform_id(doc)
            .and_then(|at| form_dict(doc, at))
            .and_then(|f| f.get(b"Fields").ok())
            .map(|o| deref(doc, o).as_array().map(|a| a.is_empty()).unwrap_or(true))
            .unwrap_or(true);
        if empty {
            if let Ok(c) = doc.catalog_mut() {
                c.remove(b"AcroForm");
            }
        }
    }
    Ok(())
}

/// The annotation's normal appearance (the state /AS picks for checkboxes) and its /Rect.
fn normal_appearance(doc: &Document, dict: &Dictionary) -> Option<(ObjectId, [f32; 4])> {
    let rect = rect_of(doc, dict.get(b"Rect").ok()?)?;
    let ap = deref(doc, dict.get(b"AP").ok()?).as_dict().ok()?;
    let n = ap.get(b"N").ok()?;
    let id = match n {
        Object::Reference(id) => match doc.get_object(*id).ok()? {
            Object::Stream(_) => *id,
            Object::Dictionary(states) => pick_state(doc, dict, states)?,
            _ => return None,
        },
        Object::Dictionary(states) => pick_state(doc, dict, states)?,
        _ => return None,
    };
    Some((id, rect))
}

fn pick_state(doc: &Document, dict: &Dictionary, states: &Dictionary) -> Option<ObjectId> {
    let state = dict.get(b"AS").ok().map(|o| deref(doc, o)).and_then(|o| o.as_name().ok())?;
    states.get(state).ok()?.as_reference().ok()
}

/// Where a form is drawn for an annotation: its /BBox through its /Matrix, fitted to /Rect
/// (PDF 32000-1 §12.5.5).
fn form_matrix(doc: &Document, stream: ObjectId, rect: [f32; 4]) -> Option<[f32; 6]> {
    let s = doc.get_object(stream).ok()?.as_stream().ok()?;
    let b = rect_of(doc, s.dict.get(b"BBox").ok()?)?;
    let m: [f32; 6] = match s.dict.get(b"Matrix").ok().map(|o| deref(doc, o)).and_then(|o| o.as_array().ok()) {
        Some(a) if a.len() == 6 => {
            let v: Vec<f32> = a.iter().filter_map(|o| deref(doc, o).as_float().ok()).collect();
            if v.len() != 6 {
                return None;
            }
            [v[0], v[1], v[2], v[3], v[4], v[5]]
        }
        _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    };
    // The transformed box's bounds.
    let corners = [(b[0], b[1]), (b[2], b[1]), (b[0], b[3]), (b[2], b[3])].map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
    let tb = bbox(&corners, 0.0);
    let (tw, th) = (tb[2] - tb[0], tb[3] - tb[1]);
    if tw.abs() < 1e-4 || th.abs() < 1e-4 {
        return None;
    }
    let (sx, sy) = ((rect[2] - rect[0]) / tw, (rect[3] - rect[1]) / th);
    // A = translate(rect) · scale · translate(-tb); the form's own Matrix is applied by Do.
    Some([sx, 0.0, 0.0, sy, rect[0] - tb[0] * sx, rect[1] - tb[1] * sy])
}
