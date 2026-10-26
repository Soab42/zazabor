//! Passwords (AES-256), removing hidden information, and redaction by replacing pages with
//! pictures of themselves (docs/plans/pdf.md §4.5, §4.9; §11 decision 7's rasterising option,
//! as true object-level redaction needs PDFium).

use super::annots::{self, remove_fields};
use super::page::image_xobject;
use super::{deref, num, page_annots, page_box, page_id, owner_password_ok, Refs};
use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::{Dictionary, Document, EncryptionState, EncryptionVersion, Object, Permissions, Stream};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::sync::Arc;

// ---- passwords

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectSpec {
    /// The password that opens the file; empty for none.
    #[serde(default)]
    pub open: String,
    /// The permissions (owner) password; needed when anything is restricted.
    #[serde(default)]
    pub owner: String,
    #[serde(default = "yes")]
    pub print: bool,
    #[serde(default = "yes")]
    pub copy: bool,
    #[serde(default = "yes")]
    pub edit: bool,
    #[serde(default = "yes")]
    pub comment: bool,
}

fn yes() -> bool {
    true
}

const EVERYTHING: Permissions = Permissions::PRINTABLE
    .union(Permissions::MODIFIABLE)
    .union(Permissions::COPYABLE)
    .union(Permissions::ANNOTABLE)
    .union(Permissions::FILLABLE)
    .union(Permissions::ASSEMBLABLE)
    .union(Permissions::PRINTABLE_IN_HIGH_QUALITY);

fn random_bytes(n: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|e| format!("No random numbers for the key: {e}"))?;
    Ok(buf)
}

/// AES-256 encryption (PDF 2.0's standard security handler, revision 6) for `spec`.
pub fn protect_state(doc: &Document, spec: &ProtectSpec) -> Result<EncryptionState, String> {
    let mut permissions = Permissions::COPYABLE_FOR_ACCESSIBILITY;
    if spec.print {
        permissions |= Permissions::PRINTABLE | Permissions::PRINTABLE_IN_HIGH_QUALITY;
    }
    if spec.copy {
        permissions |= Permissions::COPYABLE;
    }
    if spec.edit {
        permissions |= Permissions::MODIFIABLE | Permissions::ASSEMBLABLE;
    }
    if spec.comment {
        permissions |= Permissions::ANNOTABLE | Permissions::FILLABLE;
    }
    let restricted = !permissions.contains(EVERYTHING);
    if spec.open.is_empty() && !restricted {
        return Err("Set a password to open the file, or restrict something.".into());
    }
    if restricted && spec.owner.is_empty() {
        return Err("Restrictions need a permissions password.".into());
    }
    if restricted && spec.owner == spec.open {
        return Err("The permissions password must be different from the one that opens the file.".into());
    }
    // Without restrictions, whoever can open the file may change its security too.
    let owner = if spec.owner.is_empty() { spec.open.clone() } else { spec.owner.clone() };
    let key = random_bytes(32)?;
    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
        file_encryption_key: &key,
        stream_filter: b"StdCF".to_vec(),
        string_filter: b"StdCF".to_vec(),
        owner_password: &owner,
        user_password: &spec.open,
        permissions,
    };
    let _ = doc;
    EncryptionState::try_from(version).map_err(|e| format!("The file couldn't be encrypted: {e}"))
}

/// Before the trailer is written with AES-256: a file identifier and a version that has it.
pub fn prepare_for_aes(doc: &mut Document) -> Result<(), String> {
    if doc.trailer.get(b"ID").is_err() {
        let id = random_bytes(16)?;
        doc.trailer.set("ID", Object::Array(vec![Object::String(id.clone(), lopdf::StringFormat::Hexadecimal), Object::String(id, lopdf::StringFormat::Hexadecimal)]));
    }
    if doc.version.as_str() < "1.7" {
        doc.version = "1.7".into();
    }
    Ok(())
}

/// lopdf writes AES-256's encryption dictionary without key lengths. Poppler then falls back to a
/// 40-bit key and reads every stream as garbage (the password still checks out), so they're
/// added as Acrobat writes them: 256 bits for the file, 32 bytes for the crypt filter.
pub fn complete_encrypt_dict(doc: &mut Document) {
    let Ok(id) = doc.trailer.get(b"Encrypt").and_then(Object::as_reference) else { return };
    let Ok(dict) = doc.get_dictionary_mut(id) else { return };
    dict.set("Length", 256);
    if let Ok(Object::Dictionary(filters)) = dict.get_mut(b"CF") {
        for (_, filter) in filters.iter_mut() {
            if let Object::Dictionary(f) = filter {
                f.set("Length", 32);
                if !f.has(b"AuthEvent") {
                    f.set("AuthEvent", "DocOpen");
                }
            }
        }
    }
}

/// Removing a file's security needs its permissions password when it restricts anything.
pub fn check_unprotect(doc: &Document, state: &EncryptionState, opened_with: Option<&str>, owner: Option<&str>) -> Result<(), String> {
    if state.permissions().contains(EVERYTHING) {
        return Ok(());
    }
    if opened_with.is_some_and(|p| owner_password_ok(doc, state, p)) || owner.is_some_and(|p| owner_password_ok(doc, state, p)) {
        return Ok(());
    }
    Err(if owner.is_some() { "That isn't the permissions password." } else { "The file's permissions password is needed to remove its security." }.into())
}

// ---- hidden information

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizeSpec {
    #[serde(default)]
    pub metadata: bool,
    #[serde(default)]
    pub attachments: bool,
    #[serde(default)]
    pub scripts: bool,
    #[serde(default)]
    pub comments: bool,
}

/// Actions that run something rather than move within the document.
const RISKY_ACTIONS: [&[u8]; 7] = [b"JavaScript", b"Launch", b"SubmitForm", b"ImportData", b"Rendition", b"Movie", b"Sound"];

fn risky_action(doc: &Document, obj: &Object) -> bool {
    deref(doc, obj).as_dict().ok().and_then(|d| d.get(b"S").ok()).and_then(|s| s.as_name().ok()).is_some_and(|s| RISKY_ACTIONS.contains(&s))
}

/// Takes `key` out of the catalog's /Names dictionary (inline or its own object).
fn remove_name_tree(doc: &mut Document, key: &[u8]) {
    let names = doc.catalog().ok().and_then(|c| c.get(b"Names").ok()).cloned();
    match names {
        Some(Object::Reference(id)) => {
            if let Ok(d) = doc.get_dictionary_mut(id) {
                d.remove(key);
            }
        }
        Some(Object::Dictionary(_)) => {
            if let Ok(Object::Dictionary(d)) = doc.catalog_mut().and_then(|c| c.get_mut(b"Names")) {
                d.remove(key);
            }
        }
        _ => {}
    }
}

pub fn sanitize(doc: &mut Document, spec: &SanitizeSpec) {
    if spec.comments || spec.attachments {
        let mut gone = Refs::new();
        for (_, page) in doc.get_pages() {
            for item in page_annots(doc, page) {
                let Ok(id) = item.as_reference() else { continue };
                let Ok(d) = doc.get_dictionary(id) else { continue };
                let subtype = d.get(b"Subtype").and_then(Object::as_name).unwrap_or(b"");
                let comment = !matches!(subtype, b"Link" | b"Widget" | b"Popup" | b"FileAttachment");
                if (spec.comments && comment) || (spec.attachments && subtype == b"FileAttachment") {
                    gone.insert(id);
                }
            }
        }
        annots::remove(doc, &gone);
    }
    if spec.attachments {
        remove_name_tree(doc, b"EmbeddedFiles");
    }
    if spec.scripts {
        remove_name_tree(doc, b"JavaScript");
    }
    // Keys in any dictionary.
    let risky: Vec<_> = if spec.scripts {
        doc.objects
            .iter()
            .filter_map(|(id, o)| {
                let d = match o {
                    Object::Dictionary(d) => d,
                    Object::Stream(s) => &s.dict,
                    _ => return None,
                };
                let keys: Vec<Vec<u8>> = [b"A".as_slice(), b"OpenAction"].iter().filter(|k| d.get(k).is_ok_and(|v| risky_action(doc, v))).map(|k| k.to_vec()).collect();
                (!keys.is_empty()).then_some((*id, keys))
            })
            .collect()
    } else {
        vec![]
    };
    for (id, keys) in risky {
        if let Some(d) = dict_mut(doc, id) {
            for k in keys {
                d.remove(&k);
            }
        }
    }
    let mut drop: Vec<&[u8]> = vec![];
    if spec.metadata {
        drop.extend([b"Metadata".as_slice(), b"PieceInfo", b"LastModified"]);
    }
    if spec.scripts {
        drop.extend([b"AA".as_slice(), b"XFA"]);
    }
    if spec.attachments {
        drop.push(b"AF");
    }
    if !drop.is_empty() {
        for obj in doc.objects.values_mut() {
            let d = match obj {
                Object::Dictionary(d) => d,
                Object::Stream(s) => &mut s.dict,
                _ => continue,
            };
            for k in &drop {
                d.remove(k);
            }
            // An inline AcroForm in the catalog, and the catalog's own inline dictionaries.
            if let Ok(Object::Dictionary(form)) = d.get_mut(b"AcroForm") {
                for k in &drop {
                    form.remove(k);
                }
            }
        }
    }
    if spec.metadata {
        // The document information dictionary: title, author, subject, keywords, programs, dates.
        if let Ok(id) = doc.trailer.get(b"Info").and_then(Object::as_reference) {
            doc.objects.remove(&id);
        }
        doc.trailer.remove(b"Info");
    }
}

fn dict_mut(doc: &mut Document, id: lopdf::ObjectId) -> Option<&mut Dictionary> {
    match doc.objects.get_mut(&id)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&mut s.dict),
        _ => None,
    }
}

// ---- redaction

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactPage {
    pub page: u32,
    /// A JPEG or PNG of the page with the marks painted over, drawn unrotated over `view`.
    pub blob: usize,
    /// The part of the page the picture covers (pdf.js's `page.view`); the page's box when absent.
    #[serde(default)]
    pub view: Option<[f32; 4]>,
}

/// Replaces each page's content with its picture: its text, drawings, pictures, annotations and
/// form fields go, and the picture (with the marks painted black) takes their place.
pub fn redact(doc: &mut Document, pages: &[RedactPage], images: &[&[u8]]) -> Result<(), String> {
    let mut gone = Refs::new();
    for (p, bytes) in pages.iter().zip(images) {
        let page = page_id(doc, p.page)?;
        let b = p.view.unwrap_or_else(|| page_box(doc, page));
        let (image, _, _) = image_xobject(doc, bytes)?;
        for a in page_annots(doc, page) {
            if let Ok(id) = a.as_reference() {
                gone.insert(id);
            }
        }
        let content = format!("q {} 0 0 {} {} {} cm /CPPage Do Q", num(b[2] - b[0]), num(b[3] - b[1]), num(b[0]), num(b[1]));
        let mut s = Stream::new(Dictionary::new(), content.into_bytes());
        let _ = s.compress();
        let content_id = doc.add_object(Object::Stream(s));
        let mut xobjects = Dictionary::new();
        xobjects.set("CPPage", Object::Reference(image));
        let mut res = Dictionary::new();
        res.set("XObject", Object::Dictionary(xobjects));
        let dict = doc.get_dictionary_mut(page).map_err(|e| e.to_string())?;
        dict.set("Contents", Object::Reference(content_id));
        dict.set("Resources", Object::Dictionary(res));
        for key in [b"Annots".as_slice(), b"Thumb", b"PieceInfo", b"Metadata", b"AA", b"B", b"StructParents", b"Group"] {
            dict.remove(key);
        }
    }
    // Form fields whose widgets were on those pages.
    remove_fields(doc, &gone);
    for id in &gone {
        doc.objects.remove(id);
    }
    // Text can live outside the pages too: alternate and actual text in the structure tree.
    if let Ok(c) = doc.catalog_mut() {
        c.remove(b"StructTreeRoot");
        c.remove(b"MarkInfo");
    }
    Ok(())
}
