//! The text layer OCR adds (docs/plans/pdf.md §4.8). The page reads each scanned page with
//! tesseract.js, which writes a one-page PDF holding only the words it read: invisible text
//! (render mode 3) in Tesseract's glyphless font, with a ToUnicode map, placed where each word
//! is. That page is laid over the original as a form, stretched to the page as it shows, so
//! the scan looks the same but search, selection and copying work.

use super::page::{add_resource, append_content, own_resources, set_resources, Display};
use super::{deref, num, page_box, page_id, rect_obj};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;
use std::collections::BTreeMap;

/// One page's text layer: Tesseract's text-only PDF is blob `blob`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPage {
    pub page: u32,
    pub blob: usize,
}

/// Copies `obj` of `src` into `dst`, objects it refers to included (each once), under new numbers.
fn import(src: &Document, dst: &mut Document, obj: &Object, map: &mut BTreeMap<ObjectId, ObjectId>, depth: u32) -> Object {
    if depth > 64 {
        return Object::Null;
    }
    match obj {
        Object::Reference(r) => {
            if let Some(new) = map.get(r) {
                return Object::Reference(*new);
            }
            let new = dst.new_object_id();
            map.insert(*r, new);
            let copied = src.get_object(*r).map(|o| import(src, dst, o, map, depth + 1)).unwrap_or(Object::Null);
            dst.objects.insert(new, copied);
            Object::Reference(new)
        }
        Object::Array(a) => Object::Array(a.iter().map(|o| import(src, dst, o, map, depth + 1)).collect()),
        Object::Dictionary(d) => {
            let mut out = Dictionary::new();
            for (k, v) in d.iter() {
                // A page's parent would drag the other document's page tree along.
                if k.as_slice() == b"Parent" {
                    continue;
                }
                out.set(k.clone(), import(src, dst, v, map, depth + 1));
            }
            Object::Dictionary(out)
        }
        Object::Stream(s) => {
            let mut dict = Dictionary::new();
            for (k, v) in s.dict.iter() {
                dict.set(k.clone(), import(src, dst, v, map, depth + 1));
            }
            let mut stream = Stream::new(dict, s.content.clone());
            stream.allows_compression = s.allows_compression;
            Object::Stream(stream)
        }
        other => other.clone(),
    }
}

/// Lays each page's text-only PDF over the page.
pub fn add_layers(doc: &mut Document, pages: &[OcrPage], blobs: &[&[u8]]) -> Result<(), String> {
    for p in pages {
        let bytes = super::blob(blobs, p.blob)?;
        let src = Document::load_mem(bytes).map_err(|e| format!("The text OCR read couldn't be used: {e}"))?;
        let Some((_, src_page)) = src.get_pages().into_iter().next() else { continue };
        let [x0, y0, x1, y1] = page_box(&src, src_page);
        let (w, h) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
        let content = src.get_page_content(src_page);
        let resources = super::inherited(&src, src_page, b"Resources").map(|o| deref(&src, o).clone()).unwrap_or(Object::Dictionary(Dictionary::new()));
        let mut map = BTreeMap::new();
        let resources = import(&src, doc, &resources, &mut map, 0);

        let mut form = Dictionary::new();
        form.set("Type", "XObject");
        form.set("Subtype", "Form");
        form.set("BBox", rect_obj([x0, y0, x1, y1]));
        form.set("Resources", resources);
        let mut stream = Stream::new(form, content);
        let _ = stream.compress();
        let form_id = doc.add_object(Object::Stream(stream));

        // The read page's space → the page as it shows → the page's own space.
        let target = page_id(doc, p.page)?;
        let display = Display::of(doc, target);
        let (sx, sy) = (display.width / w, display.height / h);
        let mut res = own_resources(doc, target);
        let name = add_resource(doc, &mut res, "XObject", "OCR", Object::Reference(form_id));
        set_resources(doc, target, res)?;
        let draw = format!("q {} {} 0 0 {} {} {} cm /{name} Do Q\n", display.cm(), num(sx), num(sy), num(-x0 * sx), num(-y0 * sy));
        append_content(doc, target, draw.into_bytes(), false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// A page with a picture-like box and no text; `rotate` turns it.
    fn scan(rotate: i64) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let content = doc.add_object(Stream::new(dictionary! {}, b"0.5 g 72 600 200 100 re f".to_vec()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => content, "Rotate" => rotate,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = vec![];
        doc.save_to(&mut out).unwrap();
        out
    }

    /// What Tesseract writes: a page of invisible words (render mode 3), here `w`×`h` points.
    fn words(w: i64, h: i64) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let content = doc.add_object(Stream::new(dictionary! {}, format!("BT 3 Tr /F1 12 Tf 80 {} Td (Hello OCR words) Tj ET", h - 152).into_bytes()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => content,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            "MediaBox" => vec![0.into(), 0.into(), w.into(), h.into()],
        });
        doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = vec![];
        doc.save_to(&mut out).unwrap();
        out
    }

    fn pdftotext(pdf: &[u8]) -> Option<String> {
        let path = std::env::temp_dir().join(format!("zazabor-ocr-layer-{}-{}.pdf", std::process::id(), pdf.len()));
        std::fs::write(&path, pdf).ok()?;
        let out = std::process::Command::new("pdftotext").args(["-layout"]).arg(&path).arg("-").output().ok();
        let _ = std::fs::remove_file(&path);
        out.filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    }

    #[test]
    fn the_text_layer_lands_on_the_page() {
        for (rotate, w, h) in [(0, 612, 792), (90, 792, 612)] {
            let original = scan(rotate);
            let layer = words(w, h);
            let blobs: Vec<&[u8]> = vec![&original, &layer];
            let out = super::super::run(&original, None, &[super::super::Op::OcrLayer { pages: vec![OcrPage { page: 1, blob: 1 }] }], &blobs).unwrap();
            let doc = Document::load_mem(&out).unwrap();
            let page = doc.get_pages()[&1];
            let content = String::from_utf8_lossy(&doc.get_page_content(page)).into_owned();
            assert!(content.contains("72 600 200 100 re f"), "the scan stays");
            assert!(content.contains("/OCR1 Do"), "the layer is drawn: {content}");
            if let Some(text) = pdftotext(&out) {
                assert!(text.contains("Hello OCR words"), "rotate {rotate}: {text}");
            }
        }
    }
}
