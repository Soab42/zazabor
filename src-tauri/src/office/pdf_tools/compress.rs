//! Making a PDF smaller (docs/plans/pdf.md §4.9): pictures downsampled to the resolution they're
//! shown at and re-encoded, unused objects dropped, streams compressed and objects packed into
//! object streams. Ghostscript, when it's installed, is offered as a separate program.

use super::deref;
use lopdf::content::Content;
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressSpec {
    /// Pictures are kept at this resolution, as they're shown on the page.
    #[serde(default = "dpi")]
    pub dpi: u32,
    /// JPEG quality for photos, 1–100.
    #[serde(default = "quality")]
    pub quality: u8,
}

fn dpi() -> u32 {
    150
}
fn quality() -> u8 {
    75
}

type Matrix = [f32; 6];

fn mul(a: Matrix, b: Matrix) -> Matrix {
    // a then b (row vectors, as PDF has it).
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn matrix_of(doc: &Document, ops: &[Object]) -> Option<Matrix> {
    if ops.len() != 6 {
        return None;
    }
    let v: Vec<f32> = ops.iter().filter_map(|o| deref(doc, o).as_float().ok()).collect();
    (v.len() == 6).then(|| [v[0], v[1], v[2], v[3], v[4], v[5]])
}

/// The largest size (width, height in points) each picture is shown at, found by following the
/// pages' content (and the forms they draw) with the current transformation.
fn shown_sizes(doc: &Document) -> HashMap<ObjectId, (f32, f32)> {
    let mut sizes = HashMap::new();
    for (_, page) in doc.get_pages() {
        let res = super::inherited(doc, page, b"Resources").map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()).cloned().unwrap_or_default();
        walk(doc, &doc.get_page_content(page), &res, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], 0, &mut sizes);
    }
    sizes
}

fn walk(doc: &Document, content: &[u8], res: &Dictionary, start: Matrix, depth: u32, sizes: &mut HashMap<ObjectId, (f32, f32)>) {
    if depth > 8 {
        return;
    }
    let Ok(content) = Content::decode(content) else { return };
    let xobjects = res.get(b"XObject").ok().map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok());
    let mut ctm = start;
    let mut stack = Vec::new();
    for op in &content.operations {
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(start),
            "cm" => {
                if let Some(m) = matrix_of(doc, &op.operands) {
                    ctm = mul(m, ctm);
                }
            }
            "Do" => {
                let Some(name) = op.operands.first().and_then(|o| o.as_name().ok()) else { continue };
                let Some(id) = xobjects.and_then(|x| x.get(name).ok()).and_then(|o| o.as_reference().ok()) else { continue };
                let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else { continue };
                match stream.dict.get(b"Subtype").and_then(Object::as_name).ok() {
                    Some(b"Image") => {
                        let w = (ctm[0] * ctm[0] + ctm[1] * ctm[1]).sqrt();
                        let h = (ctm[2] * ctm[2] + ctm[3] * ctm[3]).sqrt();
                        let e = sizes.entry(id).or_insert((0.0, 0.0));
                        e.0 = e.0.max(w);
                        e.1 = e.1.max(h);
                    }
                    Some(b"Form") => {
                        let m = stream.dict.get(b"Matrix").ok().and_then(|o| deref(doc, o).as_array().ok()).and_then(|a| matrix_of(doc, a)).unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
                        let inner = stream.dict.get(b"Resources").ok().map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()).cloned().unwrap_or_else(|| res.clone());
                        if let Ok(data) = stream.decompressed_content_with_limit(64 * 1024 * 1024) {
                            walk(doc, &data, &inner, mul(m, ctm), depth + 1, sizes);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

/// How many colour components a picture's colour space has, when it's one that can be
/// re-encoded as it is (grey, RGB, or an ICC profile of one of them).
fn components(doc: &Document, space: &Object) -> Option<u8> {
    match deref(doc, space) {
        Object::Name(n) if n == b"DeviceGray" => Some(1),
        Object::Name(n) if n == b"DeviceRGB" => Some(3),
        Object::Array(a) if a.first().and_then(|o| o.as_name().ok()) == Some(b"ICCBased") => {
            let profile = a.get(1).map(|o| deref(doc, o)).and_then(|o| o.as_stream().ok())?;
            match profile.dict.get(b"N").ok().and_then(|n| n.as_i64().ok()) {
                Some(1) => Some(1),
                Some(3) => Some(3),
                _ => None,
            }
        }
        _ => None,
    }
}

/// A picture's pixels, when it's one this can re-encode: 8 bits, grey or RGB, JPEG or Flate.
fn decode(doc: &Document, dict: &Dictionary, data: &[u8], stream: &lopdf::Stream) -> Option<(image::DynamicImage, bool)> {
    if dict.get(b"ImageMask").ok().and_then(|o| o.as_bool().ok()) == Some(true) || dict.has(b"Decode") || dict.has(b"Mask") {
        return None;
    }
    if deref(doc, dict.get(b"BitsPerComponent").ok()?).as_i64().ok()? != 8 {
        return None;
    }
    let n = components(doc, dict.get(b"ColorSpace").ok()?)?;
    let w = deref(doc, dict.get(b"Width").ok()?).as_i64().ok()? as u32;
    let h = deref(doc, dict.get(b"Height").ok()?).as_i64().ok()? as u32;
    if w == 0 || h == 0 || (w as u64) * (h as u64) > 200_000_000 {
        return None;
    }
    let filters = stream.filters().unwrap_or_default();
    if filters == [b"DCTDecode".as_slice()] {
        let img = image::load_from_memory_with_format(data, image::ImageFormat::Jpeg).ok()?;
        let ok = match n {
            1 => matches!(img, image::DynamicImage::ImageLuma8(_)),
            _ => matches!(img, image::DynamicImage::ImageRgb8(_)),
        };
        return ok.then_some((img, true));
    }
    if filters.iter().all(|f| *f == b"FlateDecode") {
        let raw = stream.decompressed_content_with_limit((w as usize) * (h as usize) * n as usize + 1024).ok()?;
        if raw.len() < (w * h * n as u32) as usize {
            return None;
        }
        let raw = raw[..(w * h * n as u32) as usize].to_vec();
        let img = if n == 1 {
            image::DynamicImage::ImageLuma8(image::GrayImage::from_raw(w, h, raw)?)
        } else {
            image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(w, h, raw)?)
        };
        return Some((img, false));
    }
    None
}

/// Whether a picture looks like a photo rather than line art or text, which JPEG blurs: many
/// colours, or (for grey pictures) many mid-tones. Pixels are sampled as they are: shrinking
/// first would average noise and grain away.
fn photographic(img: &image::DynamicImage) -> bool {
    let rgb = img.to_rgb8();
    let (w, h) = rgb.dimensions();
    let step = ((w as u64 * h as u64 / 4096).max(1) as f64).sqrt().ceil() as u32;
    let mut seen = std::collections::HashSet::new();
    let (mut samples, mut mid) = (0u32, 0u32);
    for y in (0..h).step_by(step as usize) {
        for x in (0..w).step_by(step as usize) {
            let p = rgb.get_pixel(x, y);
            seen.insert([p.0[0] >> 2, p.0[1] >> 2, p.0[2] >> 2]);
            if seen.len() > 256 {
                return true;
            }
            let luma = (p.0[0] as u32 * 3 + p.0[1] as u32 * 6 + p.0[2] as u32) / 10;
            samples += 1;
            if (40..=215).contains(&luma) {
                mid += 1;
            }
        }
    }
    // Text and drawings are mostly paper and ink; photos are mostly in between.
    samples > 0 && mid * 100 > samples * 40
}

fn jpeg(img: &image::DynamicImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(10, 100));
    img.write_with_encoder(encoder).ok()?;
    Some(out.into_inner())
}

fn flate(raw: &[u8]) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    use std::io::Write;
    let mut e = ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    let _ = e.write_all(raw);
    e.finish().unwrap_or_default()
}

/// Downsamples and re-encodes the pictures; a picture only changes when it gets smaller.
pub fn images(doc: &mut Document, spec: &CompressSpec) -> Result<(), String> {
    let dpi = spec.dpi.clamp(36, 600) as f32;
    let sizes = shown_sizes(doc);
    let ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter(|(_, o)| o.as_stream().is_ok_and(|s| s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")))
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else { continue };
        let stream = stream.clone();
        let Some((img, was_jpeg)) = decode(doc, &stream.dict, &stream.content, &stream) else { continue };
        let (w, h) = (img.width(), img.height());
        // Pictures not found on any page (in patterns, annotations…) keep their size.
        let scale = match sizes.get(&id) {
            Some(&(sw, sh)) if sw > 0.0 && sh > 0.0 => ((sw / 72.0 * dpi) / w as f32).max((sh / 72.0 * dpi) / h as f32).min(1.0),
            _ => 1.0,
        };
        let resized = scale < 0.9;
        let (nw, nh) = if resized { (((w as f32) * scale).round().max(1.0) as u32, ((h as f32) * scale).round().max(1.0) as u32) } else { (w, h) };
        // A soft mask is resized with its picture; one that can't be read keeps the picture as is.
        let mask = stream.dict.get(b"SMask").ok().and_then(|o| o.as_reference().ok());
        let mut new_mask = None;
        if resized {
            if let Some(mid) = mask {
                let Ok(ms) = doc.get_object(mid).and_then(Object::as_stream) else { continue };
                let mw = ms.dict.get(b"Width").ok().and_then(|o| o.as_i64().ok()).unwrap_or(0) as u32;
                let mh = ms.dict.get(b"Height").ok().and_then(|o| o.as_i64().ok()).unwrap_or(0) as u32;
                let Some(raw) = ms.decompressed_content_with_limit((mw * mh) as usize + 1024).ok().filter(|r| mw > 0 && mh > 0 && r.len() >= (mw * mh) as usize) else { continue };
                let Some(gray) = image::GrayImage::from_raw(mw, mh, raw[..(mw * mh) as usize].to_vec()) else { continue };
                let small = image::imageops::resize(&gray, nw, nh, image::imageops::FilterType::Triangle);
                new_mask = Some((mid, small.into_raw()));
            }
        }
        let img = if resized { img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3) } else { img };
        let (bytes, is_jpeg) = if was_jpeg || photographic(&img) {
            match jpeg(&img, spec.quality) {
                Some(b) => (b, true),
                None => continue,
            }
        } else {
            (flate(img.as_bytes()), false)
        };
        if bytes.len() >= stream.content.len() && !resized {
            continue;
        }
        if let Ok(Object::Stream(s)) = doc.get_object_mut(id) {
            s.dict.set("Width", nw as i64);
            s.dict.set("Height", nh as i64);
            s.dict.set("Filter", if is_jpeg { "DCTDecode" } else { "FlateDecode" });
            s.dict.remove(b"DecodeParms");
            s.set_content(bytes);
            s.allows_compression = false;
        }
        if let Some((mid, raw)) = new_mask {
            if let Ok(Object::Stream(s)) = doc.get_object_mut(mid) {
                s.dict.set("Width", nw as i64);
                s.dict.set("Height", nh as i64);
                s.dict.set("Filter", "FlateDecode");
                s.dict.remove(b"DecodeParms");
                s.set_content(flate(&raw));
                s.allows_compression = false;
            }
        }
    }
    // Page thumbnails are made again by readers that want them.
    for (_, page) in doc.get_pages() {
        if let Ok(d) = doc.get_dictionary_mut(page) {
            d.remove(b"Thumb");
        }
    }
    Ok(())
}

// ---- Ghostscript

/// Ghostscript's program, when it's installed.
pub fn ghostscript() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join("gs")).find(|p| p.is_file())
}

/// Ghostscript's pdfwrite with one of its presets; the result only when it's smaller.
pub fn with_ghostscript(pdf: &[u8], preset: &str) -> Result<Vec<u8>, String> {
    let setting = match preset {
        "screen" => "/screen",
        "printer" => "/printer",
        _ => "/ebook",
    };
    let gs = ghostscript().ok_or("Ghostscript isn't installed.")?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("zazabor-gs-{}-{nanos:x}", std::process::id()));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let input = dir.join("in.pdf");
    let output = dir.join("out.pdf");
    let result = (|| {
        std::fs::write(&input, pdf).map_err(|e| e.to_string())?;
        let status = std::process::Command::new(gs)
            .args(["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.6", "-dDetectDuplicateImages=true"])
            .arg(format!("-dPDFSETTINGS={setting}"))
            .arg(format!("-sOutputFile={}", output.display()))
            .arg(&input)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Ghostscript couldn't start: {e}"))?;
        if !status.status.success() {
            let msg = String::from_utf8_lossy(&status.stderr);
            return Err(format!("Ghostscript couldn't compress the file: {}", msg.lines().next().unwrap_or("it failed")));
        }
        std::fs::read(&output).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}
