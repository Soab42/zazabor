use super::annots::{Kind, NewAnnot};
use super::compress::CompressSpec;
use super::fonts::Face;
use super::page::{Bates, HeaderFooterSpec, ImageSpec, TextSpec, WatermarkSpec};
use super::security::{ProtectSpec, RedactPage, SanitizeSpec};
use super::redact::MarkPage;
use super::textedit::{line_at, EditSpec};
use super::{run, run_noted, Op};
use lopdf::{dictionary, Document, LoadOptions, Object, Stream};

/// Two pages of Helvetica text, their resources inherited from the page tree.
fn sample() -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
    let resources = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
    let mut kids = vec![];
    for text in ["Top SECRET123 here", "Public text"] {
        let content = format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET");
        let cid = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let pid = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => cid,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        kids.push(pid.into());
    }
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 2, "Resources" => resources }));
    let info = doc.add_object(dictionary! { "Title" => Object::string_literal("Secret title"), "Author" => Object::string_literal("Someone") });
    let js = doc.add_object(dictionary! { "S" => "JavaScript", "JS" => Object::string_literal("app.alert('hi')") });
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id, "OpenAction" => js });
    doc.trailer.set("Root", catalog);
    doc.trailer.set("Info", info);
    let mut out = vec![];
    doc.save_to(&mut out).unwrap();
    out
}

fn load(bytes: &[u8]) -> Document {
    Document::load_mem(bytes).unwrap()
}

/// Every byte of the file that a reader could recover: decoded streams and strings, and the file.
fn everything(bytes: &[u8]) -> Vec<u8> {
    let mut all = bytes.to_vec();
    let doc = load(bytes);
    for obj in doc.objects.values() {
        match obj {
            Object::Stream(s) => all.extend(s.decompressed_content().unwrap_or_else(|_| s.content.clone())),
            Object::String(s, _) => all.extend(s),
            _ => {}
        }
        if let Object::Dictionary(d) = obj {
            for (_, v) in d.iter() {
                if let Object::String(s, _) = v {
                    all.extend(s);
                }
            }
        }
    }
    all
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

fn page_content(doc: &Document, n: u32) -> Vec<u8> {
    doc.get_page_content(doc.get_pages()[&n])
}

fn annots_of(doc: &Document, n: u32) -> Vec<Vec<u8>> {
    super::page_annots(doc, doc.get_pages()[&n])
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .filter_map(|id| doc.get_dictionary(id).ok())
        .map(|d| d.get(b"Subtype").unwrap().as_name().unwrap().to_vec())
        .collect()
}

fn annot(kind: Kind) -> NewAnnot {
    NewAnnot {
        kind,
        quads: vec![72.0, 724.0, 300.0, 724.0, 72.0, 698.0, 300.0, 698.0],
        points: vec![100.0, 100.0, 200.0, 200.0, 150.0, 300.0],
        rect: Some([100.0, 400.0, 220.0, 480.0]),
        color: [0.1, 0.4, 0.9],
        fill: None,
        width: 2.0,
        opacity: 0.8,
        contents: "Check this".into(),
        author: "Tester".into(),
        in_reply_to: None,
    }
}

#[test]
fn annotations_get_appearances() {
    let ops: Vec<Op> = [Kind::Underline, Kind::StrikeOut, Kind::Squiggly, Kind::Note, Kind::Square, Kind::Circle, Kind::Line, Kind::Arrow, Kind::Polygon]
        .into_iter()
        .map(|k| Op::Annotate { page: 1, annot: annot(k) })
        .collect();
    let out = run(&sample(), None, &ops, &[]).unwrap();
    let doc = load(&out);
    let kinds = annots_of(&doc, 1);
    for want in ["Underline", "StrikeOut", "Squiggly", "Text", "Popup", "Square", "Circle", "Line", "Polygon"] {
        assert!(kinds.iter().any(|k| k == want.as_bytes()), "{want} missing from {kinds:?}");
    }
    // Each (but the popup) draws itself.
    for id in super::page_annots(&doc, doc.get_pages()[&1]).iter().filter_map(|o| o.as_reference().ok()) {
        let d = doc.get_dictionary(id).unwrap();
        if d.get(b"Subtype").unwrap().as_name().unwrap() == b"Popup" {
            continue;
        }
        let ap = d.get(b"AP").unwrap().as_dict().unwrap().get(b"N").unwrap().as_reference().unwrap();
        assert!(!doc.get_object(ap).unwrap().as_stream().unwrap().decompressed_content().unwrap().is_empty());
    }
    // Removing one takes its popup too.
    let note = super::page_annots(&doc, doc.get_pages()[&1])
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .find(|&id| doc.get_dictionary(id).unwrap().get(b"Subtype").unwrap().as_name().unwrap() == b"Text")
        .unwrap();
    let out = run(&out, None, &[Op::RemoveAnnots { refs: vec![note] }], &[]).unwrap();
    let kinds = annots_of(&load(&out), 1);
    assert!(!kinds.iter().any(|k| k == b"Text" || k == b"Popup"));
    assert_eq!(kinds.len(), 8);
}

#[test]
fn watermark_round_trip() {
    let spec = WatermarkSpec { pages: vec![], text: Some("DRAFT".into()), face: Face::HelveticaBold, size: 80.0, color: [1.0, 0.0, 0.0], opacity: 0.25, rotation: 45.0, blob: None, scale: 0.5, behind: false };
    let out = run(&sample(), None, &[Op::Watermark(spec)], &[]).unwrap();
    let doc = load(&out);
    for n in [1, 2] {
        let content = page_content(&doc, n);
        assert!(contains(&content, b"<4452414654>"), "page {n} has no watermark");
        // The page's own text is still there, inside q/Q.
        assert!(contains(&content, b"(") && contains(&content, b"Tj"));
        let res = super::page::own_resources(&doc, doc.get_pages()[&n]);
        assert!(super::sub_dict(&doc, &res, b"Font").len() >= 2, "the original font and the watermark's");
        let states = super::sub_dict(&doc, &res, b"ExtGState");
        let gs = states.iter().next().unwrap().1.as_reference().unwrap();
        assert!((doc.get_dictionary(gs).unwrap().get(b"ca").unwrap().as_float().unwrap() - 0.25).abs() < 1e-4);
    }
    assert!(contains(&page_content(&doc, 1), b"SECRET123"));
}

#[test]
fn headers_footers_and_bates() {
    let spec = HeaderFooterSpec {
        pages: vec![],
        slots: ["{file}".into(), "".into(), "{date}".into(), "".into(), "Page {page} of {pages}".into(), "{bates}".into()],
        face: Face::Helvetica,
        size: 9.0,
        color: [0.0; 3],
        margin: 30.0,
        bates: Some(Bates { prefix: "ABC".into(), suffix: String::new(), start: 7, digits: 6 }),
        date: "26 Oct 2026".into(),
        file: "report.pdf".into(),
    };
    let out = run(&sample(), None, &[Op::HeaderFooter(spec)], &[]).unwrap();
    let doc = load(&out);
    let hex = |s: &str| super::fonts::hex(s.as_bytes()).into_bytes();
    assert!(contains(&page_content(&doc, 1), &hex("ABC000007")));
    assert!(contains(&page_content(&doc, 2), &hex("ABC000008")));
    assert!(contains(&page_content(&doc, 2), &hex("Page 2 of 2")));
    assert!(contains(&page_content(&doc, 1), &hex("report.pdf")));
}

#[test]
fn text_and_pictures_on_a_page() {
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_fn(40, 20, |x, _| image::Rgba([200, 30, 30, if x < 20 { 255 } else { 90 }])).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let png = png.into_inner();
    let ops = vec![
        Op::AddText(TextSpec { page: 2, x: 72.0, y: 600.0, text: "Approved – Café\nSecond line".into(), size: 14.0, face: Face::Times, color: [0.0, 0.0, 0.6] }),
        Op::AddImage(ImageSpec { page: 2, x: 300.0, y: 300.0, width: 80.0, height: 40.0, blob: 1 }),
    ];
    let out = run(&sample(), None, &ops, &[b"".as_slice(), png.as_slice()]).unwrap();
    let doc = load(&out);
    let content = page_content(&doc, 2);
    assert!(contains(&content, super::fonts::hex(&super::fonts::win_ansi("Approved – Café").unwrap()).as_bytes()));
    let res = super::page::own_resources(&doc, doc.get_pages()[&2]);
    let xobjects = super::sub_dict(&doc, &res, b"XObject");
    let img = doc.get_object(xobjects.iter().next().unwrap().1.as_reference().unwrap()).unwrap().as_stream().unwrap();
    assert_eq!(img.dict.get(b"Width").unwrap().as_i64().unwrap(), 40);
    assert!(img.dict.get(b"SMask").is_ok(), "the half-transparent picture keeps its alpha");
    // Text the standard fonts can't show is refused.
    let bangla = Op::AddText(TextSpec { page: 1, x: 72.0, y: 600.0, text: "বাংলা".into(), size: 12.0, face: Face::Helvetica, color: [0.0; 3] });
    assert!(run(&sample(), None, &[bangla], &[]).is_err());
}

#[test]
fn flatten_draws_annotations_into_the_page() {
    let out = run(&sample(), None, &[Op::Annotate { page: 1, annot: annot(Kind::Square) }, Op::Annotate { page: 1, annot: annot(Kind::Note) }], &[]).unwrap();
    let out = run(&out, None, &[Op::Flatten { comments: true, forms: true }], &[]).unwrap();
    let doc = load(&out);
    assert!(annots_of(&doc, 1).is_empty());
    let content = page_content(&doc, 1);
    assert!(contains(&content, b"/CPFlat1 Do") && contains(&content, b"/CPFlat2 Do"));
}

#[test]
fn passwords_open_and_refuse() {
    let protect = ProtectSpec { open: "pw1".into(), owner: "boss".into(), print: true, copy: false, edit: false, comment: true };
    let out = run(&sample(), None, &[Op::Protect(protect)], &[]).unwrap();
    // Without the password the file stays encrypted; with a wrong one it doesn't open.
    assert!(Document::load_mem(&out).map(|d| d.is_encrypted()).unwrap_or(true));
    assert!(Document::load_mem_with_options(&out, LoadOptions::with_password("nope")).is_err());
    let opened = Document::load_mem_with_options(&out, LoadOptions::with_password("pw1")).unwrap();
    assert!(contains(&opened.get_page_content(opened.get_pages()[&1]), b"SECRET123"));
    assert_eq!(opened.encryption_state.as_ref().unwrap().revision(), 6);
    // Key lengths as Acrobat writes them (Poppler needs them to decrypt anything).
    let raw = Document::load_mem(&out).unwrap();
    let enc = raw.get_dictionary(raw.trailer.get(b"Encrypt").unwrap().as_reference().unwrap()).unwrap();
    assert_eq!(enc.get(b"Length").unwrap().as_i64().unwrap(), 256);
    let cf = enc.get(b"CF").unwrap().as_dict().unwrap().get(b"StdCF").unwrap().as_dict().unwrap();
    assert_eq!(cf.get(b"Length").unwrap().as_i64().unwrap(), 32);

    // Comments are allowed, and the file stays encrypted with the same passwords.
    let commented = run(&out, Some("pw1"), &[Op::Annotate { page: 1, annot: annot(Kind::Underline) }], &[]).unwrap();
    assert!(Document::load_mem_with_options(&commented, LoadOptions::with_password("nope")).is_err());
    let reopened = Document::load_mem_with_options(&commented, LoadOptions::with_password("pw1")).unwrap();
    assert!(annots_of(&reopened, 1).iter().any(|k| k == b"Underline"));
    // Changing the pages isn't, unless the owner's password opened it.
    let wm = || Op::Watermark(WatermarkSpec { pages: vec![], text: Some("X".into()), face: Face::Helvetica, size: 20.0, color: [0.0; 3], opacity: 1.0, rotation: 0.0, blob: None, scale: 0.5, behind: false });
    assert!(run(&out, Some("pw1"), &[wm()], &[]).is_err());
    assert!(run(&out, Some("boss"), &[wm()], &[]).is_ok());

    // Removing the security needs the permissions password.
    assert!(run(&out, Some("pw1"), &[Op::Unprotect { owner: None }], &[]).is_err());
    assert!(run(&out, Some("pw1"), &[Op::Unprotect { owner: Some("wrong".into()) }], &[]).is_err());
    let plain = run(&out, Some("pw1"), &[Op::Unprotect { owner: Some("boss".into()) }], &[]).unwrap();
    let doc = load(&plain);
    assert!(!doc.is_encrypted() && doc.encryption_state.is_none());
    assert!(contains(&doc.get_page_content(doc.get_pages()[&1]), b"SECRET123"));

    // Restrictions without a permissions password are refused.
    let weak = ProtectSpec { open: "a".into(), owner: String::new(), print: false, copy: true, edit: true, comment: true };
    assert!(run(&sample(), None, &[Op::Protect(weak)], &[]).is_err());
}

#[test]
fn replies_answer_their_comment_and_go_with_it() {
    let marked = run(&sample(), None, &[Op::Annotate { page: 1, annot: annot(Kind::Note) }], &[]).unwrap();
    let doc = load(&marked);
    let page = doc.get_pages()[&1];
    let note = super::page_annots(&doc, page).iter().filter_map(|o| o.as_reference().ok()).find(|&id| doc.get_dictionary(id).unwrap().get(b"Subtype").unwrap().as_name().unwrap() == b"Text").unwrap();
    let mut reply = annot(Kind::Note);
    reply.contents = "Agreed".into();
    reply.in_reply_to = Some((note.0, note.1));
    let answered = run(&marked, None, &[Op::Annotate { page: 1, annot: reply }], &[]).unwrap();
    let doc = load(&answered);
    let list: Vec<_> = super::page_annots(&doc, doc.get_pages()[&1]).iter().filter_map(|o| o.as_reference().ok()).collect();
    let r = doc.get_dictionary(*list.last().unwrap()).unwrap();
    assert_eq!(r.get(b"IRT").unwrap().as_reference().unwrap(), note);
    assert_eq!(r.get(b"RT").unwrap().as_name().unwrap(), b"R");
    assert!(r.get(b"Popup").is_err());
    let rect = super::rect_of(&doc, r.get(b"Rect").unwrap()).unwrap();
    assert!(rect[0] == rect[2] && rect[1] == rect[3], "a reply covers nothing: {rect:?}");
    // A reply to something that isn't there, and an empty reply, are refused.
    let mut lost = annot(Kind::Note);
    lost.in_reply_to = Some((9999, 0));
    assert!(run(&answered, None, &[Op::Annotate { page: 1, annot: lost }], &[]).is_err());
    let mut empty = annot(Kind::Note);
    empty.contents = " ".into();
    empty.in_reply_to = Some((note.0, note.1));
    assert!(run(&answered, None, &[Op::Annotate { page: 1, annot: empty }], &[]).is_err());
    // Deleting the comment takes its popup and its replies.
    let out = run(&answered, None, &[Op::RemoveAnnots { refs: vec![note] }], &[]).unwrap();
    assert!(annots_of(&load(&out), 1).is_empty());
}

#[test]
fn redaction_leaves_nothing_behind() {
    let before = sample();
    assert!(contains(&everything(&before), b"SECRET123"));
    let mut jpeg = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(85, 110, image::Rgb([250, 250, 250])).write_to(&mut jpeg, image::ImageFormat::Jpeg).unwrap();
    let jpeg = jpeg.into_inner();
    // A comment on the redacted page carries the secret too.
    let mut note = annot(Kind::Note);
    note.contents = "SECRET123 is the code".into();
    let marked = run(&before, None, &[Op::Annotate { page: 1, annot: note }], &[]).unwrap();
    let out = run(&marked, None, &[Op::Redact { pages: vec![RedactPage { page: 1, blob: 1, view: None }] }], &[b"".as_slice(), jpeg.as_slice()]).unwrap();
    let all = everything(&out);
    assert!(!contains(&all, b"SECRET123"), "the redacted text survived");
    assert!(!contains(&all, super::fonts::hex(b"SECRET123").as_bytes()));
    let doc = load(&out);
    assert!(annots_of(&doc, 1).is_empty());
    assert!(contains(&page_content(&doc, 1), b"/CPPage Do"));
    // The other page is untouched.
    assert!(contains(&page_content(&doc, 2), b"Public text"));
}

#[test]
fn hidden_information_goes() {
    let spec = SanitizeSpec { metadata: true, attachments: true, scripts: true, comments: true };
    let marked = run(&sample(), None, &[Op::Annotate { page: 2, annot: annot(Kind::Note) }], &[]).unwrap();
    let out = run(&marked, None, &[Op::Sanitize(spec)], &[]).unwrap();
    let doc = load(&out);
    assert!(doc.trailer.get(b"Info").is_err());
    assert!(doc.catalog().unwrap().get(b"OpenAction").is_err());
    assert!(annots_of(&doc, 2).is_empty());
    let all = everything(&out);
    assert!(!contains(&all, b"Secret title") && !contains(&all, b"app.alert"));
}

#[test]
fn compression_downsamples_pictures() {
    // A noisy 1600 × 1600 picture shown 200 points wide: 150 dpi needs about 417 pixels.
    let mut doc = load(&sample());
    let mut seed = 12345u32;
    let raw: Vec<u8> = (0..1600 * 1600 * 3)
        .map(|_| {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            (seed >> 16) as u8
        })
        .collect();
    let mut s = Stream::new(dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 1600, "Height" => 1600, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8 }, raw);
    s.compress().unwrap();
    let img = doc.add_object(s);
    let page = doc.get_pages()[&2];
    let mut res = super::page::own_resources(&doc, page);
    super::page::add_resource(&doc, &mut res, "XObject", "Big", Object::Reference(img));
    super::page::set_resources(&mut doc, page, res).unwrap();
    super::page::append_content(&mut doc, page, b"q 200 0 0 200 100 100 cm /Big1 Do Q".to_vec(), false).unwrap();
    let mut before = vec![];
    doc.save_to(&mut before).unwrap();

    let out = run(&before, None, &[Op::Compress(CompressSpec { dpi: 150, quality: 70 })], &[]).unwrap();
    assert!(out.len() * 4 < before.len(), "{} → {}", before.len(), out.len());
    let doc = load(&out);
    let res = super::page::own_resources(&doc, doc.get_pages()[&2]);
    let xobjects = super::sub_dict(&doc, &res, b"XObject");
    let s = doc.get_object(xobjects.get(b"Big1").unwrap().as_reference().unwrap()).unwrap().as_stream().unwrap();
    let w = s.dict.get(b"Width").unwrap().as_i64().unwrap();
    assert!((410..=425).contains(&w), "width {w}");
    assert_eq!(s.dict.get(b"Filter").unwrap().as_name().unwrap(), b"DCTDecode");
    assert!(contains(&page_content(&doc, 1), b"SECRET123"));
}

#[test]
fn rotated_pages_get_upright_text() {
    // A page turned 90°: its display box is 792 wide and 612 high, and display space maps to the
    // page's own space turned a quarter.
    let mut doc = load(&sample());
    let page = doc.get_pages()[&1];
    doc.get_dictionary_mut(page).unwrap().set("Rotate", 90);
    let d = super::page::Display::of(&doc, page);
    assert_eq!((d.width, d.height), (792.0, 612.0));
    let (x, y) = d.from_user(612.0, 0.0);
    assert!(x.abs() < 1e-3 && y.abs() < 1e-3, "the display origin is the page's bottom right");
    let (x, y) = d.from_user(612.0, 792.0);
    assert!((x - 792.0).abs() < 1e-3 && y.abs() < 1e-3);
}

#[test]
fn picture_watermark_on_chosen_pages() {
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(60, 30, image::Rgba([10, 120, 220, 180])).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let png = png.into_inner();
    let spec = WatermarkSpec { pages: vec![2], text: None, face: Face::Helvetica, size: 72.0, color: [0.0; 3], opacity: 0.5, rotation: 0.0, blob: Some(1), scale: 0.4, behind: true };
    let out = run(&sample(), None, &[Op::Watermark(spec)], &[b"".as_slice(), png.as_slice()]).unwrap();
    let doc = load(&out);
    // Page 2 draws the picture first (behind its text); page 1 is left alone.
    let content = page_content(&doc, 2);
    let at = content.windows(4).position(|w| w == b" Do ").unwrap();
    let text = content.windows(6).position(|w| w == b"Public").unwrap();
    assert!(at < text);
    assert!(!contains(&page_content(&doc, 1), b" Do "));
    let res = super::page::own_resources(&doc, doc.get_pages()[&2]);
    let img = super::sub_dict(&doc, &res, b"XObject");
    let s = doc.get_object(img.iter().next().unwrap().1.as_reference().unwrap()).unwrap().as_stream().unwrap();
    assert!(s.dict.get(b"SMask").is_ok());
}

// ---- PDFium (ignored when the library isn't here: scripts/fetch-pdfium.sh, or ZAZABOR_PDFIUM)

/// Page `n`'s text as PDFium reads it.
fn pdfium_text(bytes: &[u8], n: usize) -> String {
    super::pdfium::session(|api| {
        let file = super::pdfium::Doc::load(api, bytes.to_vec())?;
        let page = file.page(n - 1)?;
        let text = page.text()?;
        Ok((0..text.count()).map(|i| text.unicode(i)).collect())
    })
    .unwrap()
}

/// Page `n`'s text as Poppler reads it, when pdftotext is installed.
fn poppler_text(bytes: &[u8], n: u32) -> Option<String> {
    let dir = std::env::temp_dir().join(format!("zazabor-pdf-test-{}-{n}-{}", std::process::id(), bytes.len()));
    std::fs::write(&dir, bytes).ok()?;
    let out = std::process::Command::new("pdftotext").args(["-f", &n.to_string(), "-l", &n.to_string()]).arg(&dir).arg("-").output().ok();
    let _ = std::fs::remove_file(&dir);
    out.filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// A JPEG of `w` × `h` white pixels.
fn white_jpeg(w: u32, h: u32) -> Vec<u8> {
    let mut jpeg = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(w, h, image::Rgb([255, 255, 255])).write_to(&mut jpeg, image::ImageFormat::Jpeg).unwrap();
    jpeg.into_inner()
}

#[test]
#[cfg_attr(not(has_pdfium), ignore = "PDFium isn't here (scripts/fetch-pdfium.sh, or set ZAZABOR_PDFIUM)")]
fn true_redaction_removes_the_word_and_keeps_its_neighbours() {
    // Page 1 reads "Top SECRET123 here" in 24 pt Helvetica from (72, 700): SECRET123 runs from
    // x 120 to 257.4. A white picture lies under the whole line, across the mark.
    let jpeg = white_jpeg(120, 30);
    let pictured = run(&sample(), None, &[Op::AddImage(ImageSpec { page: 1, x: 180.0, y: 705.0, width: 240.0, height: 60.0, blob: 1 })], &[b"".as_slice(), jpeg.as_slice()]).unwrap();
    let mark = MarkPage { page: 1, rects: vec![[118.0, 692.0, 259.0, 722.0]] };
    let mut notes = Vec::new();
    let out = run_noted(&pictured, None, &[Op::RedactObjects { pages: vec![mark] }], &[], &mut notes).unwrap();

    // Gone from the file's bytes, decoded streams and strings, literal or hex.
    let all = everything(&out);
    assert!(!contains(&all, b"SECRET123"), "the redacted text survived");
    assert!(!contains(&all, super::fonts::hex(b"SECRET123").as_bytes()));
    assert!(!contains(&all.to_ascii_uppercase(), super::fonts::hex(b"SECRET123").to_ascii_uppercase().as_bytes()));
    // The words beside it are still text, and so is the other page.
    let text = pdfium_text(&out, 1);
    assert!(!text.contains("SECRET"), "{text:?}");
    assert!(text.contains("Top") && text.contains("here"), "{text:?}");
    assert!(pdfium_text(&out, 2).contains("Public text"));
    if let Some(text) = poppler_text(&out, 1) {
        assert!(!text.contains("SECRET") && text.contains("Top") && text.contains("here"), "Poppler reads {text:?}");
    }
    // The picture is still there, now with black where the mark was and white elsewhere.
    let doc = load(&out);
    let page = doc.get_pages()[&1];
    let (black, white) = page_images(&doc, page).iter().fold((0, 0), |(b, w), px| (b + px.iter().filter(|&&v| v < 30).count(), w + px.iter().filter(|&&v| v > 225).count()));
    assert!(black > 0 && white > 0, "black {black}, white {white}");
}

/// The decoded pixels (as bytes) of each picture, but JPEGs, in page `page`'s resources.
fn page_images(doc: &Document, page: lopdf::ObjectId) -> Vec<Vec<u8>> {
    let mut out = vec![];
    let Ok((res, ids)) = doc.get_page_resources(page) else { return out };
    let mut dicts: Vec<&lopdf::Dictionary> = res.into_iter().collect();
    dicts.extend(ids.iter().filter_map(|&id| doc.get_dictionary(id).ok()));
    for d in dicts {
        let Ok(xobjects) = d.get(b"XObject").and_then(|x| doc.dereference(x)).and_then(|(_, x)| x.as_dict()) else { continue };
        for (_, v) in xobjects.iter() {
            let Ok(s) = v.as_reference().and_then(|id| doc.get_object(id)).and_then(Object::as_stream) else { continue };
            // The painted copy PDFium writes is raw pixels (Flate); the original JPEG isn't counted.
            let jpeg = s.dict.get(b"Filter").and_then(Object::as_name).ok() == Some(b"DCTDecode");
            if s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image") && !jpeg {
                out.push(if s.dict.get(b"Filter").is_ok() { s.decompressed_content().unwrap_or_default() } else { s.content.clone() });
            }
        }
    }
    out
}

#[test]
#[cfg_attr(not(has_pdfium), ignore = "PDFium isn't here (scripts/fetch-pdfium.sh, or set ZAZABOR_PDFIUM)")]
fn a_mark_with_nothing_left_under_it_is_checked() {
    // Marks that cover nothing still draw their box, and the check passes.
    let out = run(&sample(), None, &[Op::RedactObjects { pages: vec![MarkPage { page: 2, rects: vec![[400.0, 100.0, 500.0, 150.0]] }] }], &[]).unwrap();
    assert!(pdfium_text(&out, 2).contains("Public text"));
    // No marks at all is refused.
    assert!(run(&sample(), None, &[Op::RedactObjects { pages: vec![MarkPage { page: 1, rects: vec![] }] }], &[]).is_err());
}

#[test]
#[cfg_attr(not(has_pdfium), ignore = "PDFium isn't here (scripts/fetch-pdfium.sh, or set ZAZABOR_PDFIUM)")]
fn editing_a_line_round_trips() {
    let before = sample();
    // A click on "Public" in page 2's line.
    let line = line_at(&before, None, 2, 90.0, 708.0).unwrap().expect("a line under the click");
    assert_eq!(line.text, "Public text");
    assert!(line.refused.is_none());
    assert!((line.size - 24.0).abs() < 0.1, "{}", line.size);
    let edit = |text: &str| Op::EditText(EditSpec { page: 2, objects: line.objects.clone(), old: line.text.clone(), text: text.into() });
    let mut notes = Vec::new();
    let out = run_noted(&before, None, &[edit("Private words")], &[], &mut notes).unwrap();
    assert!(notes.is_empty(), "{notes:?}");
    let text = pdfium_text(&out, 2);
    assert!(text.contains("Private words") && !text.contains("Public"), "{text:?}");
    if let Some(text) = poppler_text(&out, 2) {
        assert!(text.contains("Private words"), "Poppler reads {text:?}");
    }
    // Clicked again, the new text is a line of its own, in the same font and size.
    let again = line_at(&out, None, 2, 90.0, 708.0).unwrap().unwrap();
    assert_eq!(again.text, "Private words");
    assert_eq!(again.font, line.font);
    // Page 1 is untouched.
    assert!(pdfium_text(&out, 1).contains("Top SECRET123 here"));
    // Stale text (the page changed since the click) and Bangla are refused.
    let stale = Op::EditText(EditSpec { page: 2, objects: line.objects.clone(), old: "Something else".into(), text: "x".into() });
    assert!(run(&before, None, &[stale], &[]).is_err());
    assert!(run(&before, None, &[edit("বাংলা")], &[]).is_err());
}
