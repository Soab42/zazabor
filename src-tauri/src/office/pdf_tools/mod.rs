//! PDF tools that pdf.js can't do in the page, on `lopdf`: the annotation kinds pdf.js doesn't
//! make (underline, strikethrough, squiggly, notes, shapes), page content (text, pictures,
//! watermarks, headers and footers, Bates numbers), flattening, passwords, removing hidden
//! information, redaction by replacing pages with pictures of themselves, and compression
//! (docs/plans/pdf.md §4.3–4.9).
//!
//! The page sends the file as it is now (with its own comments and form values written in) and a
//! list of operations; the answer is the whole new file, which the page opens in place of the old.
//! Every change is a full rewrite with unreferenced objects dropped, so nothing removed survives
//! in an earlier revision of the file.

mod annots;
mod compress;
mod fonts;
mod fonts_table;
mod page;
mod security;

#[cfg(test)]
mod tests;

use lopdf::{Dictionary, Document, EncryptionState, LoadOptions, Object, ObjectId, Permissions};
use serde::Deserialize;
use std::collections::BTreeSet;
use tauri::ipc::{InvokeBody, Request, Response};

/// Bigger files than this aren't edited (Office's reader stops at the same size).
const MAX_BYTES: usize = 256 * 1024 * 1024;

/// What the page asks for: the password that opened the file (none when it has none) and the
/// operations, run in order.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    #[serde(default)]
    password: Option<String>,
    ops: Vec<Op>,
}

/// One change. Points and rectangles are in the page's own coordinates (PDF points, as pdf.js's
/// `convertToPdfPoint` gives them); pages are numbered from 1.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub(crate) enum Op {
    Annotate { page: u32, annot: annots::NewAnnot },
    RemoveAnnots { refs: Vec<(u32, u16)> },
    AddText(page::TextSpec),
    AddImage(page::ImageSpec),
    Watermark(page::WatermarkSpec),
    HeaderFooter(page::HeaderFooterSpec),
    Flatten { comments: bool, forms: bool },
    Protect(security::ProtectSpec),
    Unprotect { #[serde(default)] owner: Option<String> },
    Sanitize(security::SanitizeSpec),
    Redact { pages: Vec<security::RedactPage> },
    Compress(compress::CompressSpec),
}

impl Op {
    /// The permission an encrypted file must grant for this change, unless the owner's password
    /// opened it.
    fn needs(&self) -> Permissions {
        match self {
            Op::Annotate { .. } | Op::RemoveAnnots { .. } => Permissions::ANNOTABLE,
            Op::Protect(_) | Op::Unprotect { .. } => Permissions::empty(),
            _ => Permissions::MODIFIABLE,
        }
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Splits the request body: a little-endian u32 length and the JSON job, then a u32 count and that
/// many blobs, each a u32 length and its bytes. The first blob is the PDF; operations name the
/// others (pictures) by index.
fn split_body(body: &[u8]) -> Result<(Job, Vec<&[u8]>), String> {
    let mut at = 0usize;
    let mut take = |n: usize| -> Result<&[u8], String> {
        let end = at.checked_add(n).filter(|&e| e <= body.len()).ok_or("The request was cut short.")?;
        let out = &body[at..end];
        at = end;
        Ok(out)
    };
    let u32_at = |b: &[u8]| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
    let len = u32_at(take(4)?);
    let job: Job = serde_json::from_slice(take(len)?).map_err(|e| format!("Bad request: {e}"))?;
    let count = u32_at(take(4)?);
    let mut blobs = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        let n = u32_at(take(4)?);
        blobs.push(take(n)?);
    }
    if blobs.is_empty() {
        return Err("There's no PDF in the request.".into());
    }
    Ok((job, blobs))
}

/// Runs a job on `pdf`; `blobs` are the pictures operations refer to.
pub(crate) fn run(pdf: &[u8], password: Option<&str>, ops: &[Op], blobs: &[&[u8]]) -> Result<Vec<u8>, String> {
    if pdf.len() > MAX_BYTES {
        return Err("The file is too big to edit.".into());
    }
    let options = match password {
        Some(p) => LoadOptions::with_password(p),
        None => LoadOptions::default(),
    };
    let mut doc = Document::load_mem_with_options(pdf, options).map_err(|e| match e {
        lopdf::Error::InvalidPassword => "The password is wrong.".to_string(),
        e => format!("The file couldn't be read: {e}"),
    })?;
    if doc.is_encrypted() {
        return Err("The file needs its password.".into());
    }
    let state = doc.encryption_state.clone();
    // An encrypted file's owner may forbid changes: then only the owner's password allows them.
    if let Some(state) = &state {
        let owner = password.is_some_and(|p| owner_password_ok(&doc, state, p));
        if !owner {
            for op in ops {
                let need = op.needs();
                if !need.is_empty() && !state.permissions().contains(need) {
                    return Err("The file's owner doesn't allow this change. Remove Security with the permissions password first (Protect tab).".into());
                }
            }
        }
    }

    let mut new_state: Option<Option<EncryptionState>> = None;
    let mut compressing = false;
    for op in ops {
        match op {
            Op::Annotate { page, annot } => {
                let id = page_id(&doc, *page)?;
                annots::add(&mut doc, id, annot)?
            }
            Op::RemoveAnnots { refs } => annots::remove(&mut doc, &refs.iter().copied().collect()),
            Op::AddText(spec) => page::add_text(&mut doc, spec)?,
            Op::AddImage(spec) => page::add_image(&mut doc, spec, blob(blobs, spec.blob)?)?,
            Op::Watermark(spec) => page::watermark(&mut doc, spec, match spec.blob {
                Some(i) => Some(blob(blobs, i)?),
                None => None,
            })?,
            Op::HeaderFooter(spec) => page::header_footer(&mut doc, spec)?,
            Op::Flatten { comments, forms } => annots::flatten(&mut doc, *comments, *forms)?,
            Op::Protect(spec) => {
                if state.is_some() && new_state.is_none() {
                    return Err("The file already has a password. Remove Security first.".into());
                }
                new_state = Some(Some(security::protect_state(&doc, spec)?));
            }
            Op::Unprotect { owner } => {
                let Some(state) = &state else {
                    return Err("The file has no password.".into());
                };
                security::check_unprotect(&doc, state, password, owner.as_deref())?;
                new_state = Some(None);
            }
            Op::Sanitize(spec) => security::sanitize(&mut doc, spec),
            Op::Redact { pages } => {
                let images = pages.iter().map(|p| blob(blobs, p.blob)).collect::<Result<Vec<_>, _>>()?;
                security::redact(&mut doc, pages, &images)?;
            }
            Op::Compress(spec) => {
                compress::images(&mut doc, spec)?;
                compressing = true;
            }
        }
    }

    finish(&mut doc, new_state.unwrap_or(state), compressing)
}

/// The file written out whole: unreferenced objects dropped, encrypted again (with the same
/// passwords, unless the job changed them), compressed when asked.
fn finish(doc: &mut Document, state: Option<EncryptionState>, compact: bool) -> Result<Vec<u8>, String> {
    doc.prune_objects();
    if compact {
        doc.compress();
    }
    if let Some(info) = doc.trailer.get(b"Info").ok().and_then(|o| o.as_reference().ok()).and_then(|id| doc.get_dictionary_mut(id).ok()) {
        info.set("ModDate", Object::string_literal(annots::pdf_date()));
    }
    let encrypted = state.is_some();
    if let Some(state) = &state {
        if state.revision() >= 5 {
            security::prepare_for_aes(doc)?;
        }
        doc.encrypt(state).map_err(|e| format!("The file couldn't be encrypted: {e}"))?;
        if state.revision() >= 5 {
            security::complete_encrypt_dict(doc);
        }
    }
    let mut out = Vec::new();
    if compact && !encrypted {
        let options = lopdf::SaveOptions::builder().use_object_streams(true).use_xref_streams(true).build();
        doc.save_with_options(&mut out, options).map_err(err)?;
    } else {
        doc.save_to(&mut out).map_err(err)?;
    }
    Ok(out)
}

fn blob<'a>(blobs: &[&'a [u8]], index: usize) -> Result<&'a [u8], String> {
    // Blob 0 is the PDF itself.
    blobs.get(index).copied().filter(|_| index > 0).ok_or_else(|| "A picture is missing from the request.".to_string())
}

/// Whether `password` is the owner's (permissions) password of the file `state` came from.
pub(crate) fn owner_password_ok(doc: &Document, state: &EncryptionState, password: &str) -> bool {
    // The file was decrypted when it was read: put its encryption dictionary back on a copy of
    // the trailer and ask lopdf to check the password against it.
    let Ok(encrypt) = state.encode() else { return false };
    let mut probe = Document::new();
    probe.trailer = doc.trailer.clone();
    let id = probe.add_object(Object::Dictionary(encrypt));
    probe.trailer.set("Encrypt", Object::Reference(id));
    probe.authenticate_owner_password(password).is_ok()
}

// ---- helpers shared by the tools

/// The object id of page `number` (from 1).
pub(crate) fn page_id(doc: &Document, number: u32) -> Result<ObjectId, String> {
    doc.get_pages().get(&number).copied().ok_or_else(|| format!("There's no page {number}."))
}

/// Pages `numbers` (from 1), or every page when it's empty; numbers that don't exist are skipped.
pub(crate) fn chosen_pages(doc: &Document, numbers: &[u32]) -> Vec<(u32, ObjectId)> {
    let all = doc.get_pages();
    if numbers.is_empty() {
        return all.into_iter().collect();
    }
    let wanted: BTreeSet<u32> = numbers.iter().copied().collect();
    all.into_iter().filter(|(n, _)| wanted.contains(n)).collect()
}

/// `obj`, following references.
pub(crate) fn deref<'a>(doc: &'a Document, obj: &'a Object) -> &'a Object {
    doc.dereference(obj).map(|(_, o)| o).unwrap_or(obj)
}

pub(crate) fn number(doc: &Document, obj: &Object) -> Option<f32> {
    deref(doc, obj).as_float().ok()
}

/// A page attribute, inherited from the page tree when the page doesn't set it.
pub(crate) fn inherited<'a>(doc: &'a Document, page: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page;
    for _ in 0..64 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value);
        }
        id = dict.get(b"Parent").and_then(Object::as_reference).ok()?;
    }
    None
}

/// A rectangle array as [x0, y0, x1, y1] with x0 < x1 and y0 < y1.
pub(crate) fn rect_of(doc: &Document, obj: &Object) -> Option<[f32; 4]> {
    let arr = deref(doc, obj).as_array().ok()?;
    if arr.len() != 4 {
        return None;
    }
    let v: Vec<f32> = arr.iter().filter_map(|o| number(doc, o)).collect();
    if v.len() != 4 {
        return None;
    }
    Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
}

/// The part of the page that shows: its crop box, or its media box.
pub(crate) fn page_box(doc: &Document, page: ObjectId) -> [f32; 4] {
    let media = inherited(doc, page, b"MediaBox").and_then(|o| rect_of(doc, o)).unwrap_or([0.0, 0.0, 612.0, 792.0]);
    match inherited(doc, page, b"CropBox").and_then(|o| rect_of(doc, o)) {
        // The crop box, inside the media box.
        Some(c) => {
            let r = [c[0].max(media[0]), c[1].max(media[1]), c[2].min(media[2]), c[3].min(media[3])];
            if r[2] > r[0] && r[3] > r[1] { r } else { media }
        }
        None => media,
    }
}

/// The page's rotation for display: 0, 90, 180 or 270 (clockwise).
pub(crate) fn page_rotation(doc: &Document, page: ObjectId) -> i32 {
    let r = inherited(doc, page, b"Rotate").and_then(|o| deref(doc, o).as_i64().ok()).unwrap_or(0);
    ((r % 360 + 360) % 360) as i32 / 90 * 90
}

/// A number as PDF content writes it: at most three decimals, no trailing zeros.
pub(crate) fn num(v: f32) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let s = format!("{:.3}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.to_string() }
}

pub(crate) fn real(v: f32) -> Object {
    Object::Real(if v.is_finite() { v } else { 0.0 })
}

pub(crate) fn rect_obj(r: [f32; 4]) -> Object {
    Object::Array(r.iter().map(|&v| real(v)).collect())
}

pub(crate) fn color_obj(c: [f32; 3]) -> Object {
    Object::Array(c.iter().map(|&v| real(v.clamp(0.0, 1.0))).collect())
}

/// A dictionary-valued entry of `dict`, followed through a reference and copied (to be changed
/// and set back as a direct dictionary).
pub(crate) fn sub_dict(doc: &Document, dict: &Dictionary, key: &[u8]) -> Dictionary {
    dict.get(key).ok().map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()).cloned().unwrap_or_default()
}

/// The pages' annotation arrays by page, resolved (for removing and flattening).
pub(crate) fn page_annots(doc: &Document, page: ObjectId) -> Vec<Object> {
    doc.get_dictionary(page)
        .ok()
        .and_then(|d| d.get(b"Annots").ok())
        .map(|o| deref(doc, o))
        .and_then(|o| o.as_array().ok())
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn set_page_annots(doc: &mut Document, page: ObjectId, annots: Vec<Object>) {
    if let Ok(dict) = doc.get_dictionary_mut(page) {
        if annots.is_empty() {
            dict.remove(b"Annots");
        } else {
            dict.set("Annots", Object::Array(annots));
        }
    }
}

pub(crate) type Refs = BTreeSet<ObjectId>;

// ---- commands

/// Changes a PDF. The body is the job and the file (see `split_body`); the answer is the new file.
#[tauri::command]
pub async fn pdf_edit(request: Request<'_>) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Nothing to change.".into());
    };
    let body = body.to_vec();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let (job, blobs) = split_body(&body)?;
        run(blobs[0], job.password.as_deref(), &job.ops, &blobs)
    })
    .await
    .map_err(err)??;
    Ok(Response::new(out))
}

/// Whether Ghostscript is installed (for "Maximum compression").
#[tauri::command]
pub async fn pdf_ghostscript() -> bool {
    compress::ghostscript().is_some()
}

/// Compresses the request body (a PDF without a password) with Ghostscript; the `x-preset` header
/// is one of screen, ebook or printer.
#[tauri::command]
pub async fn pdf_compress_ghostscript(request: Request<'_>) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Nothing to compress.".into());
    };
    let preset = request.headers().get("x-preset").and_then(|v| v.to_str().ok()).unwrap_or("ebook").to_string();
    let body = body.to_vec();
    let out = tauri::async_runtime::spawn_blocking(move || compress::with_ghostscript(&body, &preset)).await.map_err(err)??;
    Ok(Response::new(out))
}
