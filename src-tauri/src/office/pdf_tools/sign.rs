//! Certificate signatures (docs/plans/pdf.md §4.7): signing with a .p12/.pfx certificate and
//! checking the signatures a file already has.
//!
//! Signing appends an incremental update to the file exactly as it is: a signature field (shown
//! where the user put it, or invisible), and its signature dictionary with a /ByteRange and a
//! /Contents placeholder. The update is written, the byte range filled in, the bytes outside
//! /Contents signed (CMS, detached, with the CAdES signing-certificate attribute:
//! ETSI.CAdES.detached, PAdES baseline B) and the signature written into the placeholder. Nothing
//! may rewrite the file after that, or the signature breaks: later changes must be incremental
//! updates too (pdf.js's own saving is).

use super::fonts::{self, Face};
use super::page::{image_xobject, Display};
use super::{deref, num, page_id, rect_obj};
use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream, StringFormat};
use openssl::cms::{CMSOptions, CmsContentInfo};
use openssl::pkcs12::Pkcs12;
use openssl::pkcs7::{Pkcs7, Pkcs7Flags};
use openssl::stack::Stack;
use openssl::x509::store::X509StoreBuilder;
use openssl::x509::{X509NameRef, X509PurposeId, X509};
use serde::{Deserialize, Serialize};

/// Room for the signature in the file: the CMS with the signer's certificate and its chain.
const CONTENTS_BYTES: usize = 16 * 1024;
/// Placeholder byte range, found again in the written update and replaced in place.
const BYTE_RANGE_PLACEHOLDER: [i64; 4] = [0, 1_111_111_111, 2_222_222_222, 3_333_333_333];
/// OpenSSL's CMS_CADES: adds the ESS signing-certificate-v2 attribute (not in the openssl crate).
const CMS_CADES: u32 = 0x100000;
/// A certificate file bigger than this isn't one.
const MAX_CERT_BYTES: u64 = 1024 * 1024;

/// What to sign with and where the signature shows.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignSpec {
    pub cert_path: String,
    pub cert_password: String,
    /// The page the signature shows on (from 1), with `rect` in its own space; 0 or no rect for
    /// an invisible signature.
    #[serde(default)]
    pub page: u32,
    #[serde(default)]
    pub rect: Option<[f32; 4]>,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub contact: String,
    /// A picture (blob index) shown beside the text: the user's signature.
    #[serde(default)]
    pub image: Option<usize>,
}

/// What a certificate file holds, shown before signing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    pub name: String,
    pub issuer: String,
    pub email: String,
    pub valid_from: String,
    pub valid_to: String,
    pub expired: bool,
    pub self_signed: bool,
}

/// One signature in a file, as the Signatures panel shows it.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SigInfo {
    pub field: String,
    pub signer: String,
    pub issuer: String,
    pub email: String,
    /// The signing time the signature dictionary claims (/M), as written.
    pub signed_at: String,
    pub reason: String,
    pub location: String,
    pub sub_filter: String,
    /// The signed bytes are as they were signed.
    pub intact: bool,
    /// The signer's certificate chains to a certificate this computer trusts.
    pub trusted: bool,
    /// The signature covers the whole file: nothing was added after it.
    pub whole: bool,
    pub page: Option<u32>,
    pub rect: Option<[f32; 4]>,
    /// Why it couldn't be checked, when it couldn't.
    pub problem: Option<String>,
}

// ---- certificates

struct Credentials {
    key: openssl::pkey::PKey<openssl::pkey::Private>,
    cert: X509,
    chain: Stack<X509>,
}

fn read_credentials(path: &str, password: &str) -> Result<Credentials, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("The certificate couldn't be read: {e}"))?;
    if meta.len() > MAX_CERT_BYTES {
        return Err("That file is too big to be a certificate.".into());
    }
    let der = std::fs::read(path).map_err(|e| format!("The certificate couldn't be read: {e}"))?;
    let p12 = Pkcs12::from_der(&der).map_err(|_| "That isn't a .p12 or .pfx certificate file.".to_string())?;
    let parsed = p12.parse2(password).map_err(|_| "The certificate's password is wrong.".to_string())?;
    let key = parsed.pkey.ok_or("The certificate file has no private key, so it can't sign.")?;
    let cert = parsed.cert.ok_or("The certificate file has no certificate.")?;
    let mut chain = Stack::new().map_err(|e| e.to_string())?;
    for c in parsed.ca.into_iter().flatten() {
        chain.push(c).map_err(|e| e.to_string())?;
    }
    Ok(Credentials { key, cert, chain })
}

fn name_entry(name: &X509NameRef, nid: openssl::nid::Nid) -> Option<String> {
    name.entries_by_nid(nid).next().and_then(|e| e.data().to_string().ok())
}

/// A person's name from a certificate: its common name, else its organization, else the email.
fn display_name(name: &X509NameRef) -> String {
    use openssl::nid::Nid;
    name_entry(name, Nid::COMMONNAME)
        .or_else(|| name_entry(name, Nid::ORGANIZATIONNAME))
        .or_else(|| name_entry(name, Nid::PKCS9_EMAILADDRESS))
        .unwrap_or_else(|| "Unknown".into())
}

fn cert_email(cert: &openssl::x509::X509Ref) -> String {
    use openssl::nid::Nid;
    if let Some(email) = cert.subject_alt_names().and_then(|names| names.iter().find_map(|n| n.email().map(str::to_string))) {
        return email;
    }
    name_entry(cert.subject_name(), Nid::PKCS9_EMAILADDRESS).unwrap_or_default()
}

fn expired(cert: &X509) -> bool {
    openssl::asn1::Asn1Time::days_from_now(0).map(|now| cert.not_after() < now).unwrap_or(false)
}

/// What the certificate at `path` holds (checks the password too).
pub fn cert_info(path: &str, password: &str) -> Result<CertInfo, String> {
    let c = read_credentials(path, password)?;
    Ok(CertInfo {
        name: display_name(c.cert.subject_name()),
        issuer: display_name(c.cert.issuer_name()),
        email: cert_email(&c.cert),
        valid_from: c.cert.not_before().to_string(),
        valid_to: c.cert.not_after().to_string(),
        expired: expired(&c.cert),
        self_signed: c.cert.subject_name().to_der().ok() == c.cert.issuer_name().to_der().ok(),
    })
}

// ---- signing

/// Local time now: (year, month, day, hour, minute, second, offset from UTC in minutes).
fn local_now() -> (i32, u32, u32, u32, u32, u32, i32) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as libc::time_t).unwrap_or(0);
    // SAFETY: localtime_r writes into the tm we own; the pointers are valid for the call.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&secs, &mut tm);
        tm
    };
    (tm.tm_year + 1900, tm.tm_mon as u32 + 1, tm.tm_mday as u32, tm.tm_hour as u32, tm.tm_min as u32, tm.tm_sec as u32, (tm.tm_gmtoff / 60) as i32)
}

/// The time as PDF dates write it, with the local offset: D:20261027031245+06'00'.
fn pdf_local_date() -> String {
    let (y, mo, d, h, mi, s, off) = local_now();
    let sign = if off < 0 { '-' } else { '+' };
    let off = off.abs();
    format!("D:{y:04}{mo:02}{d:02}{h:02}{mi:02}{s:02}{sign}{:02}'{:02}'", off / 60, off % 60)
}

/// The time as the signature's appearance shows it: 2026.10.27 03:12:45 +06'00'.
fn shown_date() -> String {
    let (y, mo, d, h, mi, s, off) = local_now();
    let sign = if off < 0 { '-' } else { '+' };
    let off = off.abs();
    format!("{y:04}.{mo:02}.{d:02} {h:02}:{mi:02}:{s:02} {sign}{:02}'{:02}'", off / 60, off % 60)
}

/// A field name not used yet: Signature1, Signature2…
fn unused_field_name(doc: &Document) -> String {
    let mut taken = std::collections::BTreeSet::new();
    fn walk(doc: &Document, list: &Object, taken: &mut std::collections::BTreeSet<Vec<u8>>, depth: u32) {
        if depth > 32 {
            return;
        }
        let Ok(arr) = deref(doc, list).as_array() else { return };
        for item in arr {
            let Ok(dict) = deref(doc, item).as_dict() else { continue };
            if let Ok(t) = dict.get(b"T").and_then(Object::as_str) {
                taken.insert(t.to_vec());
            }
            if let Ok(kids) = dict.get(b"Kids") {
                walk(doc, kids, taken, depth + 1);
            }
        }
    }
    if let Some(fields) = acroform(doc).and_then(|f| f.get(b"Fields").ok()) {
        walk(doc, fields, &mut taken, 0);
    }
    (1..).map(|n| format!("Signature{n}")).find(|n| !taken.contains(n.as_bytes())).unwrap_or_else(|| "Signature".into())
}

fn acroform(doc: &Document) -> Option<&Dictionary> {
    let form = doc.catalog().ok()?.get(b"AcroForm").ok()?;
    deref(doc, form).as_dict().ok()
}

/// Lines of WinAnsi text that fit; characters the standard fonts can't show become "?".
fn ansi(text: &str) -> Vec<u8> {
    text.chars().map(|c| fonts::win_ansi(&c.to_string()).ok().and_then(|b| b.first().copied()).unwrap_or(b'?')).collect()
}

/// The visible signature: the signer's picture (if any) on the left, the words on the right, drawn
/// upright on the page as it shows (`display`, with `turned` for a page turned a quarter). Its
/// objects go into `doc`, the update. Returns the appearance stream's id.
fn appearance(doc: &mut Document, display: &Display, turned: bool, rect: [f32; 4], lines: &[String], picture: Option<&[u8]>) -> Result<ObjectId, String> {
    let (w, h) = if turned { (rect[3] - rect[1], rect[2] - rect[0]) } else { (rect[2] - rect[0], rect[3] - rect[1]) };
    let (w, h) = (w.max(1.0), h.max(1.0));
    let mut res = Dictionary::new();
    let mut fonts_dict = Dictionary::new();
    fonts_dict.set("F1", Face::Helvetica.dict());
    fonts_dict.set("F2", Face::HelveticaBold.dict());
    res.set("Font", Object::Dictionary(fonts_dict));
    let mut content = String::new();
    let mut text_x = w * 0.04;
    if let Some(bytes) = picture {
        let (id, pw, ph) = image_xobject(doc, bytes)?;
        let mut xo = Dictionary::new();
        xo.set("Im1", Object::Reference(id));
        res.set("XObject", Object::Dictionary(xo));
        // The picture fills the left 45%, keeping its shape.
        let (bw, bh) = (w * 0.45, h * 0.9);
        let scale = (bw / pw.max(1) as f32).min(bh / ph.max(1) as f32);
        let (iw, ih) = (pw as f32 * scale, ph as f32 * scale);
        let (ix, iy) = ((bw - iw) / 2.0 + w * 0.02, (h - ih) / 2.0);
        content.push_str(&format!("q {} 0 0 {} {} {} cm /Im1 Do Q\n", num(iw), num(ih), num(ix), num(iy)));
        text_x = w * 0.5;
    }
    // Words: the first line bold, sized so every line fits the box.
    let encoded: Vec<Vec<u8>> = lines.iter().map(|l| ansi(l)).collect();
    let avail_w = (w - text_x - w * 0.03).max(1.0);
    let mut size = (h * 0.9 / (encoded.len().max(1) as f32 * 1.2)).min(14.0);
    for (i, line) in encoded.iter().enumerate() {
        let face = if i == 0 { Face::HelveticaBold } else { Face::Helvetica };
        let width = face.width(line, size);
        if width > avail_w {
            size *= avail_w / width;
        }
    }
    let size = size.max(2.0);
    let lead = size * 1.2;
    let block = lead * encoded.len() as f32;
    let mut y = (h + block) / 2.0 - size;
    content.push_str("BT 0 g\n");
    for (i, line) in encoded.iter().enumerate() {
        let font = if i == 0 { "F2" } else { "F1" };
        content.push_str(&format!("/{font} {} Tf 1 0 0 1 {} {} Tm {} Tj\n", num(size), num(text_x), num(y), fonts::hex(line)));
        y -= lead;
    }
    content.push_str("ET\n");

    let mut d = Dictionary::new();
    d.set("Type", "XObject");
    d.set("Subtype", "Form");
    d.set("BBox", rect_obj([0.0, 0.0, w, h]));
    // Upright on a turned page: the rotation of display space into the page's own.
    let [a, b, c, dd, _, _] = display.m;
    d.set("Matrix", Object::Array([a, b, c, dd, 0.0, 0.0].iter().map(|&v| super::real(v)).collect()));
    d.set("Resources", Object::Dictionary(res));
    let mut s = Stream::new(d, content.into_bytes());
    let _ = s.compress();
    Ok(doc.add_object(Object::Stream(s)))
}

/// Signs `pdf` (its bytes exactly as they'll be saved) and returns the signed file.
pub fn sign(pdf: &[u8], spec: &SignSpec, picture: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let creds = read_credentials(&spec.cert_path, &spec.cert_password)?;
    if expired(&creds.cert) {
        return Err(format!("The certificate expired on {}, so it can't sign any more.", creds.cert.not_after()));
    }
    let prev = Document::load_mem(pdf).map_err(|e| match e {
        lopdf::Error::InvalidPassword => "The file has a password. Remove Security before signing (Protect tab).".to_string(),
        e => format!("The file couldn't be read: {e}"),
    })?;
    if prev.is_encrypted() || prev.encryption_state.is_some() || prev.trailer.get(b"Encrypt").is_ok() {
        return Err("The file has a password. Remove Security before signing (Protect tab).".into());
    }
    let signer = display_name(creds.cert.subject_name());
    let field = unused_field_name(&prev);
    let catalog_id = prev.trailer.get(b"Root").and_then(Object::as_reference).map_err(|_| "The file has no catalog.".to_string())?;
    let visible = spec.page > 0 && spec.rect.is_some_and(|r| (r[2] - r[0]).abs() > 2.0 && (r[3] - r[1]).abs() > 2.0);
    let page_number = if visible { spec.page } else { 1 };
    let page = page_id(&prev, page_number)?;

    let mut inc = IncrementalDocument::create_from(pdf.to_vec(), prev);

    // The signature dictionary, with the placeholders.
    let mut sig = Dictionary::new();
    sig.set("Type", "Sig");
    sig.set("Filter", "Adobe.PPKLite");
    sig.set("SubFilter", "ETSI.CAdES.detached");
    sig.set("ByteRange", Object::Array(BYTE_RANGE_PLACEHOLDER.iter().map(|&v| Object::Integer(v)).collect()));
    sig.set("Contents", Object::String(vec![0u8; CONTENTS_BYTES], StringFormat::Hexadecimal));
    sig.set("M", Object::string_literal(pdf_local_date()));
    sig.set("Name", Object::String(super::annots::text_string(&signer), StringFormat::Literal));
    if !spec.reason.trim().is_empty() {
        sig.set("Reason", Object::String(super::annots::text_string(spec.reason.trim()), StringFormat::Literal));
    }
    if !spec.location.trim().is_empty() {
        sig.set("Location", Object::String(super::annots::text_string(spec.location.trim()), StringFormat::Literal));
    }
    if !spec.contact.trim().is_empty() {
        sig.set("ContactInfo", Object::String(super::annots::text_string(spec.contact.trim()), StringFormat::Literal));
    }
    let mut app = Dictionary::new();
    app.set("Name", "Zazabor");
    let mut build = Dictionary::new();
    build.set("App", Object::Dictionary(app));
    sig.set("Prop_Build", Object::Dictionary(build));
    let sig_id = inc.new_document.add_object(Object::Dictionary(sig));

    // The field and its widget, one object.
    let mut widget = Dictionary::new();
    widget.set("Type", "Annot");
    widget.set("Subtype", "Widget");
    widget.set("FT", "Sig");
    widget.set("T", Object::String(field.clone().into_bytes(), StringFormat::Literal));
    widget.set("V", Object::Reference(sig_id));
    // Print + Locked.
    widget.set("F", Object::Integer(4 | 128));
    widget.set("P", Object::Reference(page));
    if visible {
        let r = spec.rect.unwrap_or_default();
        let r = [r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])];
        let mut lines = vec![format!("Digitally signed by {signer}"), format!("Date: {}", shown_date())];
        if !spec.reason.trim().is_empty() {
            lines.push(format!("Reason: {}", spec.reason.trim()));
        }
        if !spec.location.trim().is_empty() {
            lines.push(format!("Location: {}", spec.location.trim()));
        }
        let display = Display::of(inc.get_prev_documents(), page);
        let turned = matches!(super::page_rotation(inc.get_prev_documents(), page), 90 | 270);
        let ap_id = appearance(&mut inc.new_document, &display, turned, r, &lines, picture)?;
        widget.set("Rect", rect_obj(r));
        let mut ap = Dictionary::new();
        ap.set("N", Object::Reference(ap_id));
        widget.set("AP", Object::Dictionary(ap));
    } else {
        widget.set("Rect", rect_obj([0.0, 0.0, 0.0, 0.0]));
    }
    let widget_id = inc.new_document.add_object(Object::Dictionary(widget));

    // The page lists the widget.
    attach_to_page(&mut inc, page, widget_id)?;
    // The form lists the field, and says the file has signatures (SigFlags 1 | 2: append only).
    add_to_form(&mut inc, catalog_id, widget_id)?;

    let mut out = Vec::with_capacity(pdf.len() + CONTENTS_BYTES * 2 + 8192);
    inc.save_to(&mut out).map_err(|e| format!("The signed file couldn't be written: {e}"))?;
    fill_signature(&mut out, pdf.len(), &creds)?;
    Ok(out)
}

/// Adds `widget` to the page's /Annots in the update.
fn attach_to_page(inc: &mut IncrementalDocument, page: ObjectId, widget: ObjectId) -> Result<(), String> {
    inc.opt_clone_object_to_new_document(page).map_err(|e| e.to_string())?;
    let annots = inc.new_document.get_dictionary(page).map_err(|e| e.to_string())?.get(b"Annots").ok().cloned();
    match annots {
        Some(Object::Reference(list)) => {
            inc.opt_clone_object_to_new_document(list).map_err(|e| e.to_string())?;
            match inc.new_document.get_object_mut(list) {
                Ok(Object::Array(a)) => a.push(Object::Reference(widget)),
                _ => {
                    inc.new_document.get_dictionary_mut(page).map_err(|e| e.to_string())?.set("Annots", Object::Array(vec![Object::Reference(widget)]));
                }
            }
        }
        Some(Object::Array(mut a)) => {
            a.push(Object::Reference(widget));
            inc.new_document.get_dictionary_mut(page).map_err(|e| e.to_string())?.set("Annots", Object::Array(a));
        }
        _ => {
            inc.new_document.get_dictionary_mut(page).map_err(|e| e.to_string())?.set("Annots", Object::Array(vec![Object::Reference(widget)]));
        }
    }
    Ok(())
}

/// Adds the field to the AcroForm (made when the file has none) and sets /SigFlags 3.
fn add_to_form(inc: &mut IncrementalDocument, catalog: ObjectId, widget: ObjectId) -> Result<(), String> {
    inc.opt_clone_object_to_new_document(catalog).map_err(|e| e.to_string())?;
    let form = inc.new_document.get_dictionary(catalog).map_err(|e| e.to_string())?.get(b"AcroForm").ok().cloned();
    let mut form_dict = match &form {
        Some(Object::Reference(id)) => inc.get_prev_documents().get_dictionary(*id).cloned().unwrap_or_default(),
        Some(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    // The field list: an array of its own in the form (copied when it's a separate object).
    let mut fields = match form_dict.get(b"Fields") {
        Ok(Object::Reference(id)) => inc.get_prev_documents().get_object(*id).ok().and_then(|o| o.as_array().ok()).cloned().unwrap_or_default(),
        Ok(Object::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    fields.push(Object::Reference(widget));
    form_dict.set("Fields", Object::Array(fields));
    form_dict.set("SigFlags", Object::Integer(3));
    match form {
        Some(Object::Reference(id)) => {
            inc.new_document.objects.insert(id, Object::Dictionary(form_dict));
        }
        _ => {
            inc.new_document.get_dictionary_mut(catalog).map_err(|e| e.to_string())?.set("AcroForm", Object::Dictionary(form_dict));
        }
    }
    Ok(())
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() || from > hay.len() - needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Fills the byte range and the signature into the written update (`start` is where it begins).
fn fill_signature(out: &mut [u8], start: usize, creds: &Credentials) -> Result<(), String> {
    let placeholder = format!("[{}]", BYTE_RANGE_PLACEHOLDER.map(|v| v.to_string()).join(" "));
    let br_at = find(out, placeholder.as_bytes(), start).ok_or("The signature's place couldn't be found in the file.")?;
    let mut zeros = Vec::with_capacity(CONTENTS_BYTES * 2 + 2);
    zeros.push(b'<');
    zeros.resize(CONTENTS_BYTES * 2 + 1, b'0');
    zeros.push(b'>');
    let contents_at = find(out, &zeros, start).ok_or("The signature's place couldn't be found in the file.")?;
    let (a, b) = (contents_at, contents_at + zeros.len());
    let ranges = [0usize, a, b, out.len() - b];
    let mut written = format!("[{} {} {} {}", ranges[0], ranges[1], ranges[2], ranges[3]);
    if written.len() + 1 > placeholder.len() {
        return Err("The file is too big to sign.".into());
    }
    while written.len() + 1 < placeholder.len() {
        written.push(' ');
    }
    written.push(']');
    out[br_at..br_at + placeholder.len()].copy_from_slice(written.as_bytes());

    let mut data = Vec::with_capacity(out.len() - (b - a));
    data.extend_from_slice(&out[..a]);
    data.extend_from_slice(&out[b..]);
    let flags = CMSOptions::from_bits_retain(
        (CMSOptions::DETACHED | CMSOptions::BINARY | CMSOptions::NOSMIMECAP).bits() | CMS_CADES,
    );
    let cms = CmsContentInfo::sign(Some(&*creds.cert), Some(&*creds.key), Some(&*creds.chain), Some(&data), flags)
        .map_err(|e| format!("The signature couldn't be made: {e}"))?;
    let der = cms.to_der().map_err(|e| e.to_string())?;
    if der.len() > CONTENTS_BYTES {
        return Err("The certificate chain is too long to fit in the signature.".into());
    }
    let hex: String = der.iter().map(|b| format!("{b:02X}")).collect();
    out[a + 1..a + 1 + hex.len()].copy_from_slice(hex.as_bytes());
    Ok(())
}

// ---- checking

/// The DER object at the start of `bytes`, without the padding after it.
fn der_prefix(bytes: &[u8]) -> &[u8] {
    if bytes.len() < 2 || bytes[0] != 0x30 {
        return bytes;
    }
    let first = bytes[1] as usize;
    let (len, head) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 || bytes.len() < 2 + n {
            return bytes;
        }
        (bytes[2..2 + n].iter().fold(0usize, |acc, &b| acc << 8 | b as usize), 2 + n)
    };
    &bytes[..(head + len).min(bytes.len())]
}

fn text_of(doc: &Document, dict: &Dictionary, key: &[u8]) -> String {
    match dict.get(key).map(|o| deref(doc, o)) {
        Ok(Object::String(bytes, _)) => decode_text(bytes),
        Ok(Object::Name(n)) => String::from_utf8_lossy(n).into_owned(),
        _ => String::new(),
    }
}

/// A PDF text string: UTF-16BE with a byte-order mark, or PDFDocEncoding (read as Latin-1).
fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    bytes.iter().map(|&b| b as char).collect()
}

/// Every signature field with a value, depth first, with the page it's on.
fn signature_fields(doc: &Document) -> Vec<(String, ObjectId, Dictionary)> {
    let mut out = Vec::new();
    fn walk(doc: &Document, list: &Object, prefix: &str, out: &mut Vec<(String, ObjectId, Dictionary)>, depth: u32) {
        if depth > 32 {
            return;
        }
        let Ok(arr) = deref(doc, list).as_array() else { return };
        for item in arr {
            let Object::Reference(id) = item else { continue };
            let Ok(dict) = doc.get_dictionary(*id) else { continue };
            let name = dict.get(b"T").ok().and_then(|o| o.as_str().ok()).map(decode_text).unwrap_or_default();
            let full = if prefix.is_empty() { name } else if name.is_empty() { prefix.to_string() } else { format!("{prefix}.{name}") };
            let is_sig = dict.get(b"FT").ok().and_then(|o| o.as_name().ok()) == Some(b"Sig".as_slice());
            if is_sig && dict.get(b"V").is_ok() {
                out.push((full.clone(), *id, dict.clone()));
            }
            if let Ok(kids) = dict.get(b"Kids") {
                walk(doc, kids, &full, out, depth + 1);
            }
        }
    }
    if let Some(fields) = acroform(doc).and_then(|f| f.get(b"Fields").ok()) {
        walk(doc, fields, "", &mut out, 0);
    }
    out
}

/// Checks every signature in `pdf`.
pub fn verify(pdf: &[u8]) -> Result<Vec<SigInfo>, String> {
    let doc = match Document::load_mem(pdf) {
        Ok(d) => d,
        // A file with a password can't be read here; its signatures aren't listed.
        Err(lopdf::Error::InvalidPassword) => return Ok(Vec::new()),
        Err(e) => return Err(format!("The file couldn't be read: {e}")),
    };
    if doc.is_encrypted() || doc.encryption_state.is_some() {
        return Ok(Vec::new());
    }
    let pages: std::collections::BTreeMap<ObjectId, u32> = doc.get_pages().into_iter().map(|(n, id)| (id, n)).collect();
    let mut out = Vec::new();
    for (field, _id, widget) in signature_fields(&doc) {
        let mut info = SigInfo { field, ..Default::default() };
        info.page = widget.get(b"P").ok().and_then(|o| o.as_reference().ok()).and_then(|p| pages.get(&p).copied());
        info.rect = widget.get(b"Rect").ok().and_then(|o| super::rect_of(&doc, o)).filter(|r| r[2] - r[0] > 0.5 && r[3] - r[1] > 0.5);
        let Some(sig) = widget.get(b"V").ok().map(|o| deref(&doc, o)).and_then(|o| o.as_dict().ok()) else {
            info.problem = Some("The signature has no value.".into());
            out.push(info);
            continue;
        };
        info.signed_at = text_of(&doc, sig, b"M");
        info.reason = text_of(&doc, sig, b"Reason");
        info.location = text_of(&doc, sig, b"Location");
        info.sub_filter = text_of(&doc, sig, b"SubFilter");
        check_one(pdf, &doc, sig, &mut info);
        out.push(info);
    }
    Ok(out)
}

fn check_one(pdf: &[u8], doc: &Document, sig: &Dictionary, info: &mut SigInfo) {
    let range: Vec<i64> = sig.get(b"ByteRange").ok().map(|o| deref(doc, o)).and_then(|o| o.as_array().ok())
        .map(|a| a.iter().filter_map(|o| deref(doc, o).as_i64().ok()).collect()).unwrap_or_default();
    let contents = match sig.get(b"Contents").map(|o| deref(doc, o)) {
        Ok(Object::String(bytes, _)) => bytes.clone(),
        _ => {
            info.problem = Some("The signature has no contents.".into());
            return;
        }
    };
    // Who signed, even when the rest can't be checked.
    let der = der_prefix(&contents);
    let Ok(p7) = Pkcs7::from_der(der) else {
        info.problem = Some("The signature isn't one Zazabor can read.".into());
        return;
    };
    let Ok(empty) = Stack::<X509>::new() else { return };
    if let Ok(signers) = p7.signers(&empty, Pkcs7Flags::empty()) {
        if let Some(cert) = signers.iter().next() {
            info.signer = display_name(cert.subject_name());
            info.issuer = display_name(cert.issuer_name());
            info.email = cert_email(cert);
        }
    }
    if range.len() != 4 || range.iter().any(|&v| v < 0) {
        info.problem = Some("The signature's byte range is broken.".into());
        return;
    }
    let [a, b, c, d] = [range[0] as usize, range[1] as usize, range[2] as usize, range[3] as usize];
    if a.checked_add(b).is_none_or(|e| e > pdf.len()) || c.checked_add(d).is_none_or(|e| e > pdf.len()) || a + b > c {
        info.problem = Some("The signature's byte range doesn't fit the file: it was cut or changed.".into());
        return;
    }
    let mut data = Vec::with_capacity(b + d);
    data.extend_from_slice(&pdf[a..a + b]);
    data.extend_from_slice(&pdf[c..c + d]);
    // Covers the file to its end (white space after the last %%EOF aside).
    info.whole = a == 0 && pdf[c + d..].iter().all(|b| b.is_ascii_whitespace());

    // The signed bytes against the signature, without judging the certificate.
    let Ok(no_store) = X509StoreBuilder::new().map(|b| b.build()) else { return };
    info.intact = p7.verify(&empty, &no_store, Some(&data), None, Pkcs7Flags::NOVERIFY).is_ok();
    // The certificate against the ones this computer trusts.
    if info.intact {
        if let Ok(mut builder) = X509StoreBuilder::new() {
            let _ = builder.set_default_paths();
            let _ = builder.set_purpose(X509PurposeId::ANY);
            let store = builder.build();
            info.trusted = p7.verify(&empty, &store, Some(&data), None, Pkcs7Flags::empty()).is_ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;
    use openssl::asn1::Asn1Time;
    use openssl::bn::BigNum;
    use openssl::hash::MessageDigest;
    use openssl::pkey::PKey;
    use openssl::rsa::Rsa;
    use openssl::x509::X509NameBuilder;

    /// One page of text, written with a classic cross-reference table or a stream.
    fn sample(xref_stream: bool) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let content = doc.add_object(Stream::new(dictionary! {}, b"BT /F1 24 Tf 72 700 Td (Contract text) Tj ET".to_vec()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = vec![];
        if xref_stream {
            let options = lopdf::SaveOptions::builder().use_object_streams(true).use_xref_streams(true).build();
            doc.save_with_options(&mut out, options).unwrap();
        } else {
            doc.save_to(&mut out).unwrap();
        }
        out
    }

    /// A self-signed certificate for "Test Signer" in a .p12 with password "pw", in a temp file.
    fn test_p12(tag: &str) -> std::path::PathBuf {
        let rsa = Rsa::generate(2048).unwrap();
        let key = PKey::from_rsa(rsa).unwrap();
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_text("CN", "Test Signer").unwrap();
        name.append_entry_by_text("O", "Zazabor Tests").unwrap();
        let name = name.build();
        let mut b = X509::builder().unwrap();
        b.set_version(2).unwrap();
        b.set_serial_number(&BigNum::from_u32(7).unwrap().to_asn1_integer().unwrap()).unwrap();
        b.set_subject_name(&name).unwrap();
        b.set_issuer_name(&name).unwrap();
        b.set_pubkey(&key).unwrap();
        b.set_not_before(&Asn1Time::days_from_now(0).unwrap()).unwrap();
        b.set_not_after(&Asn1Time::days_from_now(30).unwrap()).unwrap();
        b.sign(&key, MessageDigest::sha256()).unwrap();
        let cert = b.build();
        let p12 = Pkcs12::builder().name("Test Signer").pkey(&key).cert(&cert).build2("pw").unwrap();
        let path = std::env::temp_dir().join(format!("zazabor-sign-test-{}-{tag}.p12", std::process::id()));
        std::fs::write(&path, p12.to_der().unwrap()).unwrap();
        path
    }

    fn spec(path: &std::path::Path, visible: bool) -> SignSpec {
        SignSpec {
            cert_path: path.to_string_lossy().into_owned(),
            cert_password: "pw".into(),
            page: if visible { 1 } else { 0 },
            rect: visible.then_some([72.0, 72.0, 272.0, 132.0]),
            reason: "I approve this document".into(),
            location: "Dhaka".into(),
            contact: String::new(),
            image: None,
        }
    }

    #[test]
    fn signing_round_trip_and_tampering() {
        let p12 = test_p12("round");
        for xref_stream in [false, true] {
            let original = sample(xref_stream);
            let signed = sign(&original, &spec(&p12, true), None).unwrap();
            // The original bytes are kept as they were: the signature is an incremental update.
            assert!(signed.starts_with(&original));
            let sigs = verify(&signed).unwrap();
            assert_eq!(sigs.len(), 1, "one signature");
            let s = &sigs[0];
            assert!(s.problem.is_none(), "{:?}", s.problem);
            assert!(s.intact, "the signature checks out");
            assert!(s.whole, "it covers the whole file");
            assert!(!s.trusted, "a self-signed certificate isn't trusted");
            assert_eq!(s.signer, "Test Signer");
            assert_eq!(s.reason, "I approve this document");
            assert_eq!(s.page, Some(1));
            assert_eq!(s.sub_filter, "ETSI.CAdES.detached");

            // One changed byte in the signed part: the signature no longer checks out.
            let mut tampered = signed.clone();
            let at = find(&tampered, b"Contract text", 0).unwrap();
            tampered[at] = b'K';
            let sigs = verify(&tampered).unwrap();
            assert!(!sigs[0].intact, "a changed file fails the check");

            // Something appended after signing: still intact, but not the whole file.
            let mut later = signed.clone();
            later.extend_from_slice(b"\n% a later change\n");
            let sigs = verify(&later).unwrap();
            assert!(sigs[0].intact);
            assert!(!sigs[0].whole);
        }
        let _ = std::fs::remove_file(p12);
    }

    #[test]
    fn invisible_signature_and_second_signature() {
        let p12 = test_p12("two");
        let once = sign(&sample(false), &spec(&p12, false), None).unwrap();
        let twice = sign(&once, &spec(&p12, true), None).unwrap();
        let sigs = verify(&twice).unwrap();
        assert_eq!(sigs.len(), 2);
        assert_ne!(sigs[0].field, sigs[1].field, "each signature gets its own field");
        assert!(sigs.iter().all(|s| s.intact));
        // The first signature doesn't cover the second's update; the second covers everything.
        assert_eq!(sigs.iter().filter(|s| s.whole).count(), 1);
        assert!(sigs.iter().any(|s| s.rect.is_none()), "the first is invisible");
        let _ = std::fs::remove_file(p12);
    }

    #[test]
    fn wrong_password_and_bad_file() {
        let p12 = test_p12("bad");
        let mut s = spec(&p12, false);
        s.cert_password = "nope".into();
        assert_eq!(sign(&sample(false), &s, None).unwrap_err(), "The certificate's password is wrong.");
        let info = cert_info(&p12.to_string_lossy(), "pw").unwrap();
        assert_eq!(info.name, "Test Signer");
        assert!(info.self_signed && !info.expired);
        let _ = std::fs::remove_file(&p12);
        let not_cert = std::env::temp_dir().join(format!("zazabor-sign-test-{}-x.p12", std::process::id()));
        std::fs::write(&not_cert, b"not a certificate").unwrap();
        assert!(sign(&sample(false), &spec(&not_cert, false), None).is_err());
        let _ = std::fs::remove_file(not_cert);
    }

    /// Poppler's own check, when it's installed: valid, then broken by tampering.
    #[test]
    fn poppler_agrees() {
        if std::process::Command::new("pdfsig").arg("-v").output().is_err() {
            return;
        }
        let p12 = test_p12("poppler");
        let signed = sign(&sample(false), &spec(&p12, true), None).unwrap();
        let path = std::env::temp_dir().join(format!("zazabor-sign-test-{}.pdf", std::process::id()));
        std::fs::write(&path, &signed).unwrap();
        let out = std::process::Command::new("pdfsig").arg(&path).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("Signature Validation: Signature is Valid."), "{text}");
        let mut tampered = signed.clone();
        let at = find(&tampered, b"Contract text", 0).unwrap();
        tampered[at] = b'K';
        std::fs::write(&path, &tampered).unwrap();
        let out = std::process::Command::new("pdfsig").arg(&path).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(!text.contains("Signature Validation: Signature is Valid."), "{text}");
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(p12);
    }
}
