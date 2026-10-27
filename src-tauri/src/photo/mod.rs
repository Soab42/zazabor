//! Photo (Studio) and the Gallery's Quick Edit: the page edits pictures on the GPU; this side
//! decodes and encodes them, and reads and writes Photo's own `.coreimage` projects.
//!
//! Pixels cross the bridge raw as 8-bit RGBA, upright (EXIF orientation applied). A picture's
//! colour profile (ICC) and EXIF data travel with it and are written back on save, the EXIF
//! orientation reset to "upright" since the pixels already are; colours are never converted, so a
//! Display P3 or Adobe RGB photo stays tagged as what it is.
//!
//! A `.coreimage` file is a zip: `document.json` (written by the page), `layers/<n>.png` (each
//! pixel layer, RGBA), `profile.icc` when the picture had one, and `preview.jpg` for thumbnails.

pub mod ai;
pub mod raw;

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader};

/// Pictures larger than this many pixels aren't opened (8-bit RGBA would pass 1 GB).
const MAX_PIXELS: u64 = 250_000_000;
/// Project files larger than this aren't read.
const MAX_PROJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| format!("Bad value: {text}"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("Bad value: {text}"))
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let value = request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("Missing {name}."))?;
    percent_decode(value)
}

fn body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("Nothing to save.".into()),
    }
}

fn shown(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

// ---- decoding

/// A decoded picture: upright 8-bit RGBA and the metadata to write back.
pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub icc: Vec<u8>,
    pub exif: Vec<u8>,
    /// The picture was scaled down to fit `max_dim`.
    pub scaled: bool,
}

/// Decodes a picture upright; when `max_dim` > 0 and the picture is larger, scales it so its
/// long edge is `max_dim` (the GPU can't hold more than its maximum texture size).
pub fn decode(path: &Path, max_dim: u32) -> Result<Decoded, String> {
    if raw::is_raw(path) {
        return decode_raw(path, &raw::Develop::default(), max_dim);
    }
    let shown = shown(path);
    let reader = ImageReader::open(path).map_err(|e| format!("Couldn’t open {shown}: {e}"))?.with_guessed_format().map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| format!("Couldn’t read {shown}: {e}"))?;
    let (w, h) = decoder.dimensions();
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(format!("{shown} is too large to edit ({w} × {h})."));
    }
    let mut icc = decoder.icc_profile().ok().flatten().unwrap_or_default();
    if icc.is_empty() && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("tif") || e.eq_ignore_ascii_case("tiff")) {
        // The tiff crate writes the profile but doesn't hand it back.
        icc = std::fs::read(path).ok().and_then(|bytes| tiff_icc(&bytes)).unwrap_or_default();
    }
    let exif = decoder.exif_metadata().ok().flatten().unwrap_or_default();
    let img = DynamicImage::from_decoder(decoder).map_err(|e| format!("Couldn’t read {shown}: {e}"))?;
    // The Gallery's own reading of the orientation, so Quick Edit matches what it shows.
    let img = crate::imaging::apply_orientation(img, crate::imaging::read_orientation(path));
    let mut img = img.to_rgba8();
    let mut scaled = false;
    if max_dim > 0 && img.width().max(img.height()) > max_dim {
        let k = max_dim as f64 / img.width().max(img.height()) as f64;
        let (nw, nh) = (((img.width() as f64 * k).round() as u32).max(1), ((img.height() as f64 * k).round() as u32).max(1));
        img = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Lanczos3);
        scaled = true;
    }
    Ok(Decoded { width: img.width(), height: img.height(), rgba: img.into_raw(), icc, exif, scaled })
}

/// The decoded picture for the page: a 24-byte header ("CPIM", width, height, ICC length, EXIF
/// length, flags; u32 little-endian), then the ICC profile, the EXIF data and the RGBA pixels.
fn pack(d: Decoded) -> Vec<u8> {
    let mut out = Vec::with_capacity(24 + d.icc.len() + d.exif.len() + d.rgba.len());
    out.extend_from_slice(b"CPIM");
    for v in [d.width, d.height, d.icc.len() as u32, d.exif.len() as u32, u32::from(d.scaled)] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&d.icc);
    out.extend_from_slice(&d.exif);
    out.extend_from_slice(&d.rgba);
    out
}

#[tauri::command]
pub async fn photo_decode(path: String, max_dim: u32) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || decode(Path::new(&path), max_dim).map(pack)).await?;
    Ok(Response::new(bytes))
}

// ---- encoding

/// The ICC profile (tag 0x8773) in a TIFF file's first directory.
fn tiff_icc(t: &[u8]) -> Option<Vec<u8>> {
    let little = match t.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |i: usize| t.get(i..i + 2).map(|b| if little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) });
    let u32_at = |i: usize| t.get(i..i + 4).map(|b| if little { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) });
    let ifd = u32_at(4)? as usize;
    for n in 0..u16_at(ifd)? as usize {
        let e = ifd + 2 + n * 12;
        if u16_at(e)? == 0x8773 {
            let count = u32_at(e + 4)? as usize;
            let at = if count <= 4 { e + 8 } else { u32_at(e + 8)? as usize };
            return t.get(at..at.checked_add(count)?).map(<[u8]>::to_vec);
        }
    }
    None
}

/// Sets a TIFF-structured EXIF block's orientation tag (0x0112) to 1, "upright": the saved pixels
/// are already turned. Leaves anything it can't parse alone.
pub fn reset_orientation(exif: &mut [u8]) {
    // Some decoders hand back the APP1 payload with its "Exif\0\0" prefix.
    let start = if exif.starts_with(b"Exif\0\0") { 6 } else { 0 };
    let t = &mut exif[start..];
    if t.len() < 8 {
        return;
    }
    let little = match &t[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return,
    };
    let u16_at = |b: &[u8], i: usize| if little { u16::from_le_bytes([b[i], b[i + 1]]) } else { u16::from_be_bytes([b[i], b[i + 1]]) };
    let u32_at = |b: &[u8], i: usize| if little { u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) } else { u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) };
    let ifd = u32_at(t, 4) as usize;
    if ifd + 2 > t.len() {
        return;
    }
    let count = u16_at(t, ifd) as usize;
    for n in 0..count {
        let e = ifd + 2 + n * 12;
        if e + 12 > t.len() {
            return;
        }
        // Tag 0x0112 (Orientation), type 3 (SHORT), one value, stored in the entry itself.
        if u16_at(t, e) == 0x0112 && u16_at(t, e + 2) == 3 {
            let one = if little { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
            t[e + 8..e + 10].copy_from_slice(&one);
            return;
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodeMeta {
    width: u32,
    height: u32,
    /// "jpeg", "png", "webp" (lossless), "webp-lossy", "avif", "tiff" or "bmp".
    format: String,
    /// JPEG, lossy WebP and AVIF quality, 1–100.
    #[serde(default = "default_quality")]
    quality: u8,
    #[serde(default)]
    icc_len: usize,
    #[serde(default)]
    exif_len: usize,
}

fn default_quality() -> u8 {
    92
}

/// Encodes RGBA pixels into a file's bytes, with the ICC profile and EXIF data when the format
/// takes them. JPEG and BMP have no alpha: it's dropped, so the page flattens the picture first.
pub fn encode(rgba: &[u8], width: u32, height: u32, format: &str, quality: u8, icc: &[u8], exif: &[u8]) -> Result<Vec<u8>, String> {
    if rgba.len() != width as usize * height as usize * 4 {
        return Err("The picture's size doesn't match its pixels.".into());
    }
    let mut exif = exif.to_vec();
    reset_orientation(&mut exif);
    let mut out = Vec::new();
    let add_meta = |enc: &mut dyn ImageEncoderMeta| {
        if !icc.is_empty() {
            enc.icc(icc.to_vec());
        }
        if !exif.is_empty() {
            enc.exif(exif.clone());
        }
    };
    // The page flattens transparency onto white before asking for a format without alpha; this
    // drops the alpha channel in the image crate's own (optimised) code: pictures are large.
    let flat = || -> Result<Vec<u8>, String> {
        let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or("The picture's size doesn't match its pixels.")?;
        Ok(DynamicImage::ImageRgba8(img).into_rgb8().into_raw())
    };
    match format {
        "jpeg" | "jpg" => {
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
            add_meta(&mut enc);
            enc.write_image(&flat()?, width, height, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())?;
        }
        "png" => {
            let mut enc = image::codecs::png::PngEncoder::new(&mut out);
            add_meta(&mut enc);
            enc.write_image(rgba, width, height, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
        }
        "webp" => {
            let mut enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
            add_meta(&mut enc);
            enc.write_image(rgba, width, height, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
        }
        "tiff" | "tif" => {
            let mut cursor = Cursor::new(Vec::new());
            {
                let mut enc = image::codecs::tiff::TiffEncoder::new(&mut cursor);
                if !icc.is_empty() {
                    let _ = enc.set_icc_profile(icc.to_vec());
                }
                enc.write_image(rgba, width, height, image::ExtendedColorType::Rgba8).map_err(|e| e.to_string())?;
            }
            out = cursor.into_inner();
        }
        "bmp" => {
            let mut enc = image::codecs::bmp::BmpEncoder::new(&mut out);
            enc.encode(&flat()?, width, height, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())?;
        }
        "webp-lossy" => {
            let opaque = rgba.chunks_exact(4).all(|p| p[3] == 255);
            let encoded = if opaque {
                webp::Encoder::from_rgb(&flat()?, width, height).encode(f32::from(quality.clamp(1, 100)))
            } else {
                webp::Encoder::from_rgba(rgba, width, height).encode(f32::from(quality.clamp(1, 100)))
            };
            out = webp_with_meta(&encoded, width, height, !opaque, icc, &exif)?;
        }
        "avif" => {
            // AV1 in pure Rust (no assembly here), at a quick speed; written as sRGB.
            let pixels: Vec<ravif::RGBA8> = rgba.chunks_exact(4).map(|p| ravif::RGBA8::new(p[0], p[1], p[2], p[3])).collect();
            let encoded = ravif::Encoder::new()
                .with_quality(f32::from(quality.clamp(1, 100)))
                .with_alpha_quality(f32::from(quality.clamp(1, 100)))
                .with_speed(8)
                .encode_rgba(ravif::Img::new(pixels.as_slice(), width as usize, height as usize))
                .map_err(|e| e.to_string())?;
            out = encoded.avif_file;
        }
        other => return Err(format!("Can’t save as {other}.")),
    }
    Ok(out)
}

/// libwebp's simple encoder writes no colour profile or EXIF: this rewraps its chunks in the
/// extended format (a `VP8X` header, `ICCP` first and `EXIF` last), as the WebP container spec has it.
fn webp_with_meta(file: &[u8], width: u32, height: u32, alpha: bool, icc: &[u8], exif: &[u8]) -> Result<Vec<u8>, String> {
    if file.len() < 12 || &file[0..4] != b"RIFF" || &file[8..12] != b"WEBP" {
        return Err("The WebP encoder made something unexpected.".into());
    }
    if icc.is_empty() && exif.is_empty() {
        return Ok(file.to_vec());
    }
    // The chunks after the header, without any VP8X (one is written below).
    let mut chunks: Vec<(&[u8], &[u8])> = Vec::new();
    let mut at = 12;
    while at + 8 <= file.len() {
        let id = &file[at..at + 4];
        let len = u32::from_le_bytes([file[at + 4], file[at + 5], file[at + 6], file[at + 7]]) as usize;
        let end = (at + 8 + len).min(file.len());
        if id != b"VP8X" && id != b"ICCP" && id != b"EXIF" {
            chunks.push((id, &file[at + 8..end]));
        }
        at = at + 8 + len + (len & 1);
    }
    let mut body = Vec::new();
    let mut put = |id: &[u8], data: &[u8]| {
        body.extend_from_slice(id);
        body.extend_from_slice(&(data.len() as u32).to_le_bytes());
        body.extend_from_slice(data);
        if data.len() & 1 == 1 {
            body.push(0);
        }
    };
    let mut flags = 0u8;
    if !icc.is_empty() {
        flags |= 0x20;
    }
    if alpha {
        flags |= 0x10;
    }
    if !exif.is_empty() {
        flags |= 0x08;
    }
    let mut vp8x = vec![flags, 0, 0, 0];
    vp8x.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    vp8x.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    put(b"VP8X", &vp8x);
    if !icc.is_empty() {
        put(b"ICCP", icc);
    }
    for (id, data) in &chunks {
        put(id, data);
    }
    if !exif.is_empty() {
        put(b"EXIF", exif);
    }
    let mut out = Vec::with_capacity(body.len() + 12);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&body);
    Ok(out)
}

/// The metadata setters of `ImageEncoder`, so one closure serves every encoder.
trait ImageEncoderMeta {
    fn icc(&mut self, icc: Vec<u8>);
    fn exif(&mut self, exif: Vec<u8>);
}

impl<T: ImageEncoder> ImageEncoderMeta for T {
    fn icc(&mut self, icc: Vec<u8>) {
        let _ = self.set_icc_profile(icc);
    }
    fn exif(&mut self, exif: Vec<u8>) {
        let _ = self.set_exif_metadata(exif);
    }
}

/// Saves RGBA pixels (the body: pixels, then the ICC profile, then the EXIF data) to `x-path` in
/// the format `x-meta` names. Returns the new modification time.
#[tauri::command]
pub async fn photo_encode(request: Request<'_>) -> Result<f64, String> {
    crate::ensure_unlocked()?;
    let path = header(&request, "x-path")?;
    let meta: EncodeMeta = serde_json::from_str(&header(&request, "x-meta")?).map_err(|e| e.to_string())?;
    let bytes = body(&request)?;
    let pixels = meta.width as usize * meta.height as usize * 4;
    if bytes.len() != pixels + meta.icc_len + meta.exif_len {
        return Err("The picture arrived incomplete.".into());
    }
    let bytes = bytes.to_vec();
    blocking(move || {
        let (rgba, rest) = bytes.split_at(pixels);
        let (icc, exif) = rest.split_at(meta.icc_len);
        let file = encode(rgba, meta.width, meta.height, &meta.format, meta.quality, icc, exif)?;
        crate::fs::text::write_bytes(Path::new(&path), &file)
    })
    .await
}

/// Where "Save a copy" of a picture goes: `IMG_1234 (edited).jpg` next to it, or
/// `(edited 2)`… when that exists. `ext` changes the extension (without a dot) when given.
pub fn copy_path(path: &Path, ext: Option<&str>) -> PathBuf {
    let dir = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "picture".into());
    // Editing a copy again makes "(edited 2)", not "(edited) (edited)".
    let base = match stem.rfind(" (edited") {
        Some(i) if stem.ends_with(')') => stem[..i].to_string(),
        _ => stem,
    };
    let ext = ext.map(str::to_string).or_else(|| path.extension().map(|e| e.to_string_lossy().into_owned())).unwrap_or_else(|| "jpg".into());
    (1..)
        .map(|n| dir.join(if n == 1 { format!("{base} (edited).{ext}") } else { format!("{base} (edited {n}).{ext}") }))
        .find(|p| !p.exists())
        .expect("an unused name exists")
}

#[tauri::command]
pub fn photo_copy_path(path: String, ext: Option<String>) -> String {
    copy_path(Path::new(&path), ext.as_deref()).to_string_lossy().into_owned()
}

// ---- raw files (Photoshop documents are read and written in the page)

/// A file's bytes (a .psd), up to the project limit.
#[tauri::command]
pub async fn photo_read_file(path: String) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || crate::fs::text::read_bytes(Path::new(&path), MAX_PROJECT_BYTES)).await?;
    Ok(Response::new(bytes))
}

/// Saves the request body to `x-path` (safely: a temporary file renamed over it); returns the new
/// modification time.
#[tauri::command]
pub async fn photo_write_file(request: Request<'_>) -> Result<f64, String> {
    crate::ensure_unlocked()?;
    let path = header(&request, "x-path")?;
    let bytes = body(&request)?.to_vec();
    blocking(move || crate::fs::text::write_bytes(Path::new(&path), &bytes)).await
}

// ---- projects (.coreimage)

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    /// Bytes of `document.json` at the start of the body.
    json_len: usize,
    /// Each pixel layer's size, in the order their RGBA follows the JSON.
    layers: Vec<[u32; 2]>,
    /// The flattened preview's size; its RGBA comes last, then the ICC profile.
    preview: [u32; 2],
    #[serde(default)]
    icc_len: usize,
}

/// Writes a project: `document.json`, `layers/<n>.png`, `profile.icc` and `preview.jpg`.
pub fn write_project(path: &Path, json: &[u8], layers: &[(u32, u32, &[u8])], preview: (u32, u32, &[u8]), icc: &[u8]) -> Result<f64, String> {
    use zip::write::SimpleFileOptions;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let ze = |e: zip::result::ZipError| e.to_string();
    zip.start_file("document.json", deflated).map_err(ze)?;
    zip.write_all(json).map_err(|e| e.to_string())?;
    for (n, (w, h, rgba)) in layers.iter().enumerate() {
        // PNG compresses already.
        zip.start_file(format!("layers/{n}.png"), stored).map_err(ze)?;
        zip.write_all(&encode(rgba, *w, *h, "png", 100, &[], &[])?).map_err(|e| e.to_string())?;
    }
    if !icc.is_empty() {
        zip.start_file("profile.icc", deflated).map_err(ze)?;
        zip.write_all(icc).map_err(|e| e.to_string())?;
    }
    let (pw, ph, prgba) = preview;
    if pw > 0 && ph > 0 {
        zip.start_file("preview.jpg", stored).map_err(ze)?;
        zip.write_all(&encode(prgba, pw, ph, "jpeg", 85, icc, &[])?).map_err(|e| e.to_string())?;
    }
    let bytes = zip.finish().map_err(ze)?.into_inner();
    crate::fs::text::write_bytes(path, &bytes)
}

#[tauri::command]
pub async fn photo_project_save(request: Request<'_>) -> Result<f64, String> {
    crate::ensure_unlocked()?;
    let path = header(&request, "x-path")?;
    let meta: ProjectMeta = serde_json::from_str(&header(&request, "x-meta")?).map_err(|e| e.to_string())?;
    let bytes = body(&request)?.to_vec();
    blocking(move || {
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let part = bytes.get(at..at + n).ok_or("The project arrived incomplete.")?;
            at += n;
            Ok(part)
        };
        let json = take(meta.json_len)?.to_vec();
        let mut layers = Vec::new();
        for [w, h] in &meta.layers {
            layers.push((*w, *h, take(*w as usize * *h as usize * 4)?.to_vec()));
        }
        let [pw, ph] = meta.preview;
        let preview = take(pw as usize * ph as usize * 4)?.to_vec();
        let icc = take(meta.icc_len)?.to_vec();
        let refs: Vec<(u32, u32, &[u8])> = layers.iter().map(|(w, h, p)| (*w, *h, p.as_slice())).collect();
        write_project(Path::new(&path), &json, &refs, (pw, ph, &preview), &icc)
    })
    .await
}

/// A project for the page: "CPPJ", the JSON's length, the ICC profile's length, the layer count
/// (u32 each), the JSON, the ICC profile, then each layer as width, height (u32) and RGBA.
pub fn read_project(path: &Path) -> Result<Vec<u8>, String> {
    let shown = shown(path);
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn’t open {shown}: {e}"))?;
    if meta.len() > MAX_PROJECT_BYTES {
        return Err(format!("{shown} is too large to open."));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn’t open {shown}: {e}"))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|_| format!("{shown} isn’t a Photo project."))?;
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let mut entry = zip.by_name(name).ok()?;
        let mut out = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut out).ok()?;
        Some(out)
    };
    let json = read("document.json").ok_or_else(|| format!("{shown} has no document."))?;
    let icc = read("profile.icc").unwrap_or_default();
    let mut layers = Vec::new();
    for n in 0.. {
        let Some(png) = read(&format!("layers/{n}.png")) else { break };
        let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png).map_err(|e| format!("{shown}: layer {n}: {e}"))?;
        layers.push(img.to_rgba8());
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"CPPJ");
    for v in [json.len() as u32, icc.len() as u32, layers.len() as u32] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&json);
    out.extend_from_slice(&icc);
    for layer in layers {
        out.extend_from_slice(&layer.width().to_le_bytes());
        out.extend_from_slice(&layer.height().to_le_bytes());
        out.extend_from_slice(layer.as_raw());
    }
    Ok(out)
}

#[tauri::command]
pub async fn photo_project_open(path: String) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || read_project(Path::new(&path))).await?;
    Ok(Response::new(bytes))
}

// ---- RAW files ----------------------------------------------------------------------------------

/// A RAW file developed with `settings`, at `max_dim` at most (0 = full size).
fn decode_raw(path: &Path, settings: &raw::Develop, max_dim: u32) -> Result<Decoded, String> {
    let source = raw::source(path)?;
    let d = raw::develop(&source, settings, max_dim);
    let scaled = d.width < source.width;
    Ok(Decoded { width: d.width, height: d.height, rgba: d.rgba, icc: d.icc, exif: Vec::new(), scaled })
}

/// What Photo's Develop panel shows about a RAW file (camera, exposure, as-shot white balance).
#[tauri::command]
pub async fn photo_raw_info(path: String) -> Result<raw::Info, String> {
    crate::ensure_unlocked()?;
    blocking(move || raw::source(Path::new(&path)).map(|s| raw::info(&s))).await
}

/// Develops a RAW file again with new settings (the decoded file is kept, so this is quick).
#[tauri::command]
pub async fn photo_raw_develop(path: String, settings: raw::Develop, max_dim: u32) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || decode_raw(Path::new(&path), &settings, max_dim).map(pack)).await?;
    Ok(Response::new(bytes))
}

/// The JPEG preview a camera stored in its RAW file.
#[tauri::command]
pub async fn photo_raw_preview(path: String) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || raw::embedded_preview(Path::new(&path))).await?;
    Ok(Response::new(bytes))
}

// ---- AI tools -----------------------------------------------------------------------------------

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("photo").join("models"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: &'static str,
    title: &'static str,
    bytes: u64,
    licence: &'static str,
    source: &'static str,
    installed: bool,
    /// Bytes of an unfinished download.
    partial: u64,
}

#[derive(serde::Serialize)]
pub struct AiModels {
    models: Vec<ModelStatus>,
    /// The models each tool needs.
    tools: std::collections::BTreeMap<&'static str, &'static [&'static str]>,
}

/// The AI models, whether each is downloaded, and which tool needs which.
#[tauri::command]
pub fn photo_ai_models(app: tauri::AppHandle) -> Result<AiModels, String> {
    let dir = models_dir(&app)?;
    let models = ai::MODELS
        .iter()
        .map(|m| ModelStatus { id: m.id, title: m.title, bytes: m.bytes, licence: m.licence, source: m.source, installed: ai::installed(&dir, m), partial: ai::partial(&dir, m) })
        .collect();
    let tools = ["subject", "subject-fast", "select", "remove"].into_iter().map(|t| (t, ai::models_for(t))).collect();
    Ok(AiModels { models, tools })
}

static CANCELS: ai::Cancels = ai::Cancels::new();

#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    id: String,
    done: u64,
    total: u64,
}

/// Downloads a model (resuming a partial one), sending `photo-ai-download` progress events.
#[tauri::command]
pub async fn photo_ai_download(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let dir = models_dir(&app)?;
    let m = ai::model(&id).ok_or("Unknown model.")?;
    let cancel = CANCELS.start(&id);
    let result = blocking(move || {
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let mut progress = |done: u64, total: u64| {
            if last.elapsed().as_millis() >= 150 || done == total {
                last = std::time::Instant::now();
                let _ = app.emit("photo-ai-download", DownloadProgress { id: m.id.to_string(), done, total });
            }
        };
        ai::download(&dir, m, &cancel, &mut progress)
    })
    .await;
    CANCELS.finish(&id);
    result
}

#[tauri::command]
pub fn photo_ai_cancel(id: String) {
    CANCELS.cancel(&id);
}

#[tauri::command]
pub async fn photo_ai_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = models_dir(&app)?;
    let m = ai::model(&id).ok_or("Unknown model.")?;
    CANCELS.cancel(&id);
    blocking(move || ai::remove(&dir, m)).await
}

#[derive(serde::Deserialize)]
struct AiMeta {
    width: u32,
    height: u32,
    #[serde(default)]
    fast: bool,
}

fn ai_meta(request: &Request<'_>) -> Result<AiMeta, String> {
    serde_json::from_str(&header(request, "x-meta")?).map_err(|e| e.to_string())
}

/// The main subject's mask (one byte a pixel) for RGBA pixels in the body.
#[tauri::command]
pub async fn photo_ai_subject(app: tauri::AppHandle, request: Request<'_>) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let dir = models_dir(&app)?;
    let meta = ai_meta(&request)?;
    let rgba = body(&request)?.to_vec();
    let mask = blocking(move || ai::subject_mask(&dir, &rgba, meta.width, meta.height, meta.fast)).await?;
    Ok(Response::new(mask))
}

/// The pictures MobileSAM has looked at, by token (the latest few).
static SAM: Mutex<Vec<(u32, Arc<ai::SamEmbedding>)>> = Mutex::new(Vec::new());
static SAM_NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// Prepares click selection on RGBA pixels in the body; returns a token for `photo_ai_sam_mask`.
#[tauri::command]
pub async fn photo_ai_sam_embed(app: tauri::AppHandle, request: Request<'_>) -> Result<u32, String> {
    crate::ensure_unlocked()?;
    let dir = models_dir(&app)?;
    let meta = ai_meta(&request)?;
    let rgba = body(&request)?.to_vec();
    let emb = blocking(move || ai::sam_embed(&dir, &rgba, meta.width, meta.height)).await?;
    let token = SAM_NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut list = SAM.lock().unwrap_or_else(|e| e.into_inner());
    list.insert(0, (token, Arc::new(emb)));
    list.truncate(3);
    Ok(token)
}

/// The object the clicks point at, for a picture `photo_ai_sam_embed` prepared.
#[tauri::command]
pub async fn photo_ai_sam_mask(app: tauri::AppHandle, token: u32, points: Vec<ai::SamPoint>) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let dir = models_dir(&app)?;
    let emb = SAM.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(t, _)| *t == token).map(|(_, e)| e.clone());
    let emb = emb.ok_or("The picture changed: click again.")?;
    let mask = blocking(move || ai::sam_mask(&dir, &emb, &points)).await?;
    Ok(Response::new(mask))
}

/// Fills the marked area: the body is RGBA pixels then a mask (a byte a pixel). The reply is a
/// 16-byte header (x, y, width, height; u32 little-endian) then the patch's RGBA.
#[tauri::command]
pub async fn photo_ai_inpaint(app: tauri::AppHandle, request: Request<'_>) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let dir = models_dir(&app)?;
    let meta = ai_meta(&request)?;
    let bytes = body(&request)?;
    let pixels = meta.width as usize * meta.height as usize;
    if bytes.len() != pixels * 5 {
        return Err("The picture arrived incomplete.".into());
    }
    let bytes = bytes.to_vec();
    let out = blocking(move || {
        let (rgba, mask) = bytes.split_at(pixels * 4);
        let p = ai::inpaint(&dir, rgba, meta.width, meta.height, mask)?;
        let mut out = Vec::with_capacity(16 + p.rgba.len());
        for v in [p.x, p.y, p.width, p.height] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&p.rgba);
        Ok(out)
    })
    .await?;
    Ok(Response::new(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-photo-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A little-endian TIFF block with one IFD entry: orientation 6.
    fn exif_with_orientation(little: bool) -> Vec<u8> {
        let mut t = Vec::new();
        let (w16, w32): (fn(u16) -> [u8; 2], fn(u32) -> [u8; 4]) =
            if little { (u16::to_le_bytes, u32::to_le_bytes) } else { (u16::to_be_bytes, u32::to_be_bytes) };
        t.extend_from_slice(if little { b"II" } else { b"MM" });
        t.extend_from_slice(&w16(42));
        t.extend_from_slice(&w32(8));
        t.extend_from_slice(&w16(1));
        t.extend_from_slice(&w16(0x0112));
        t.extend_from_slice(&w16(3));
        t.extend_from_slice(&w32(1));
        t.extend_from_slice(&w16(6));
        t.extend_from_slice(&[0, 0]);
        t.extend_from_slice(&w32(0));
        t
    }

    #[test]
    fn orientation_is_reset_to_upright() {
        for little in [true, false] {
            let mut exif = exif_with_orientation(little);
            reset_orientation(&mut exif);
            let v = if little { u16::from_le_bytes([exif[18], exif[19]]) } else { u16::from_be_bytes([exif[18], exif[19]]) };
            assert_eq!(v, 1);
        }
        // Garbage is left alone, never a panic.
        let mut junk = vec![1, 2, 3];
        reset_orientation(&mut junk);
        let mut short_ifd = b"II\x2a\x00\xff\x00\x00\x00".to_vec();
        reset_orientation(&mut short_ifd);
    }

    #[test]
    fn lossy_webp_keeps_profile_and_avif_is_avif() {
        let (w, h) = (24u32, 16u32);
        let mut rgba = Vec::new();
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[(x * 10) as u8, (y * 15) as u8, 128, if x < 4 { 0 } else { 255 }]);
            }
        }
        let icc = vec![7u8; 131];
        let webp = encode(&rgba, w, h, "webp-lossy", 80, &icc, &[]).unwrap();
        assert_eq!(&webp[0..4], b"RIFF");
        assert_eq!(&webp[12..16], b"VP8X");
        assert_eq!(webp[20] & 0x30, 0x30, "ICC and alpha flags");
        assert_eq!(u32::from_le_bytes([webp[4], webp[5], webp[6], webp[7]]) as usize, webp.len() - 8);
        let img = image::load_from_memory_with_format(&webp, image::ImageFormat::WebP).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (w, h));
        assert!(img.get_pixel(0, 0)[3] < 20 && img.get_pixel(20, 8)[3] > 235);
        let decoded = image::codecs::webp::WebPDecoder::new(Cursor::new(&webp)).unwrap().icc_profile().unwrap();
        assert_eq!(decoded, Some(icc));
        let avif = encode(&rgba, w, h, "avif", 70, &[], &[]).unwrap();
        assert_eq!(&avif[4..12], b"ftypavif");
    }

    #[test]
    fn copies_get_edited_names() {
        let dir = temp_dir("names");
        let original = dir.join("IMG_1234.jpg");
        std::fs::write(&original, b"x").unwrap();
        assert_eq!(copy_path(&original, None), dir.join("IMG_1234 (edited).jpg"));
        std::fs::write(dir.join("IMG_1234 (edited).jpg"), b"x").unwrap();
        assert_eq!(copy_path(&original, None), dir.join("IMG_1234 (edited 2).jpg"));
        assert_eq!(copy_path(&dir.join("IMG_1234 (edited).jpg"), None), dir.join("IMG_1234 (edited 2).jpg"));
        assert_eq!(copy_path(&original, Some("png")), dir.join("IMG_1234 (edited).png"));
    }

    #[test]
    fn saved_pictures_keep_their_profile_and_pixels() {
        let dir = temp_dir("roundtrip");
        // A fake but well-formed-enough ICC block: decoders hand back whatever was embedded.
        let icc: Vec<u8> = (0..300u32).map(|i| (i % 251) as u8).collect();
        let (w, h) = (5u32, 3u32);
        let rgba: Vec<u8> = (0..w * h).flat_map(|i| [i as u8 * 10, 200, 30, 255]).collect();
        for format in ["png", "jpeg", "tiff", "webp"] {
            let file = dir.join(format!("p.{format}"));
            std::fs::write(&file, encode(&rgba, w, h, format, 100, &icc, &[]).unwrap()).unwrap();
            let back = decode(&file, 0).unwrap();
            assert_eq!((back.width, back.height), (w, h), "{format}");
            assert_eq!(back.icc, icc, "{format} keeps the profile");
            if format != "jpeg" {
                assert_eq!(back.rgba, rgba, "{format} is lossless");
            }
        }
    }

    #[test]
    fn decoding_scales_down_to_the_gpu_limit() {
        let dir = temp_dir("scale");
        let file = dir.join("big.png");
        let rgba = vec![128u8; 400 * 200 * 4];
        std::fs::write(&file, encode(&rgba, 400, 200, "png", 100, &[], &[]).unwrap()).unwrap();
        let d = decode(&file, 100).unwrap();
        assert_eq!((d.width, d.height, d.scaled), (100, 50, true));
    }

    #[test]
    fn a_project_round_trips() {
        let dir = temp_dir("project");
        let file = dir.join("art.coreimage");
        let a: Vec<u8> = (0..4 * 4).flat_map(|i| [i as u8, 0, 0, 255]).collect();
        let b: Vec<u8> = (0..2 * 3).flat_map(|i| [0, i as u8, 0, 128]).collect();
        let preview = vec![255u8; 2 * 2 * 4];
        let json = br#"{"width":4,"height":4}"#;
        write_project(&file, json, &[(4, 4, &a), (2, 3, &b)], (2, 2, &preview), b"icc!").unwrap();
        let packed = read_project(&file).unwrap();
        assert_eq!(&packed[..4], b"CPPJ");
        let u = |i: usize| u32::from_le_bytes(packed[i..i + 4].try_into().unwrap()) as usize;
        let (jl, il, n) = (u(4), u(8), u(12));
        assert_eq!((jl, il, n), (json.len(), 4, 2));
        assert_eq!(&packed[16..16 + jl], json);
        let mut at = 16 + jl + il;
        assert_eq!((u(at), u(at + 4)), (4, 4));
        assert_eq!(&packed[at + 8..at + 8 + a.len()], a.as_slice());
        at += 8 + a.len();
        assert_eq!((u(at), u(at + 4)), (2, 3));
        assert_eq!(&packed[at + 8..at + 8 + b.len()], b.as_slice());
        assert!(read_project(&dir.join("missing.coreimage")).is_err());
    }
}
