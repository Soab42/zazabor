//! Decoding, EXIF orientation, resizing and the on-disk render cache.

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, ImageFormat, ImageReader, RgbImage};
use jpeg_decoder::PixelFormat;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use xxhash_rust::xxh3::xxh3_64;

use crate::scan::{extension, unix_seconds};

/// Bump to invalidate every cached render after a change to how renders are produced.
const CACHE_VERSION: u32 = 1;

/// Renders at or below this size are thumbnails: they favour speed over resampling quality.
const THUMB_LIMIT: u32 = 640;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn is_jpeg(path: &Path) -> bool {
    matches!(
        extension(path).as_deref(),
        Some("jpg" | "jpeg" | "jpe" | "jfif")
    )
}

fn read_exif(path: &Path) -> Option<exif::Exif> {
    let file = File::open(path).ok()?;
    exif::Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()
}

fn orientation_of(exif: &exif::Exif) -> u32 {
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .filter(|o| (1..=8).contains(o))
        .unwrap_or(1)
}

pub fn read_orientation(path: &Path) -> u32 {
    read_exif(path).map(|e| orientation_of(&e)).unwrap_or(1)
}

/// Dimensions, orientation and pixel format of a JPEG, from the markers before its image data.
fn jpeg_header(path: &Path) -> Option<(u32, u32, u32, PixelFormat)> {
    let mut decoder = jpeg_decoder::Decoder::new(BufReader::new(File::open(path).ok()?));
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    let orientation = decoder
        .exif_data()
        .and_then(|raw| exif::Reader::new().read_raw(raw.to_vec()).ok())
        .map(|exif| orientation_of(&exif))
        .unwrap_or(1);
    Some((info.width.into(), info.height.into(), orientation, info.pixel_format))
}

/// The size a photo displays at once its EXIF orientation is applied, read from the file
/// header without decoding any pixels.
pub fn display_size(path: &Path) -> Option<(u32, u32)> {
    let header = if is_jpeg(path) { jpeg_header(path).map(|(w, h, o, _)| (w, h, o)) } else { None };
    let (w, h, orientation) = header.or_else(|| {
        let (w, h) = ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_dimensions().ok()?;
        Some((w, h, read_orientation(path)))
    })?;
    Some(if orientation >= 5 { (h, w) } else { (w, h) })
}

/// Rotates/flips a decoded image so it displays upright for the given EXIF orientation.
pub fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// Decodes a JPEG using DCT scaling so the long edge is at least `min_long` (0 = full size).
/// Returns None for pixel formats we do not handle here (CMYK, 16-bit), letting the caller
/// fall back to the general decoder.
fn decode_jpeg_scaled(path: &Path, min_long: u32) -> Option<DynamicImage> {
    let file = File::open(path).ok()?;
    let mut decoder = jpeg_decoder::Decoder::new(BufReader::new(file));
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    let (mut w, mut h) = (info.width as u32, info.height as u32);
    let long = w.max(h);
    if min_long > 0 && min_long < long {
        let k = min_long as f64 / long as f64;
        let rw = ((w as f64 * k).ceil() as u32).clamp(1, u16::MAX as u32) as u16;
        let rh = ((h as f64 * k).ceil() as u32).clamp(1, u16::MAX as u32) as u16;
        let (sw, sh) = decoder.scale(rw, rh).ok()?;
        (w, h) = (sw as u32, sh as u32);
    }
    let pixels = decoder.decode().ok()?;
    match info.pixel_format {
        PixelFormat::RGB24 => {
            RgbImage::from_raw(w, h, pixels).map(DynamicImage::ImageRgb8)
        }
        PixelFormat::L8 => {
            GrayImage::from_raw(w, h, pixels).map(DynamicImage::ImageLuma8)
        }
        _ => None,
    }
}

fn decode_any(path: &Path) -> Result<DynamicImage, String> {
    ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())
}

/// Decodes, orients and downsizes an image so its long edge is at most `max_dim`
/// (0 keeps the full resolution).
pub fn render(path: &Path, max_dim: u32) -> Result<DynamicImage, String> {
    let orientation = read_orientation(path);
    // DCT scaling only pays off when shrinking; full-size decodes use the faster decoder.
    let decoded = if is_jpeg(path) && max_dim > 0 {
        decode_jpeg_scaled(path, max_dim).map(Ok).unwrap_or_else(|| decode_any(path))
    } else {
        decode_any(path)
    }?;
    let img = apply_orientation(decoded, orientation);
    if max_dim == 0 || img.width().max(img.height()) <= max_dim {
        return Ok(img);
    }
    Ok(if max_dim <= THUMB_LIMIT {
        img.thumbnail(max_dim, max_dim)
    } else {
        // The decoder already shrank JPEGs to within 2× of the target, so Catmull-Rom is as
        // sharp as Lanczos here and noticeably faster on very large photos.
        img.resize(max_dim, max_dim, FilterType::CatmullRom)
    })
}

/// The cache file name (without extension) of a render of `path` at `max_dim`; it changes
/// whenever the file does.
fn cache_stem(path: &Path, max_dim: u32) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let key = format!(
        "{CACHE_VERSION}|{}|{}|{}|{max_dim}",
        path.display(),
        meta.len(),
        unix_seconds(meta.modified())
    );
    Ok(format!("{:016x}", xxh3_64(key.as_bytes())))
}

/// A thumbnail the webview drew for a file this side cannot render (a PDF's first page), if one
/// was stored for the file as it is now.
pub fn stored_thumb(path: &Path, max_dim: u32, cache_dir: &Path) -> Option<PathBuf> {
    let file = cache_dir.join(format!("{}.jpg", cache_stem(path, max_dim).ok()?));
    file.exists().then_some(file)
}

/// Keeps a JPEG thumbnail the webview drew for `path`, served by the `thumb` route from then on.
pub fn store_thumb(path: &Path, max_dim: u32, cache_dir: &Path, jpeg: &[u8]) -> Result<(), String> {
    if !jpeg.starts_with(&[0xff, 0xd8]) {
        return Err("not a JPEG".into());
    }
    let stem = cache_stem(path, max_dim)?;
    let tmp = cache_dir.join(format!(
        "{stem}.{}.{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let out = cache_dir.join(format!("{stem}.jpg"));
    fs::write(&tmp, jpeg)
        .and_then(|_| fs::rename(&tmp, &out))
        .map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })
}

/// Returns a cached render of `path` at `max_dim`, producing it on a miss, or the file itself
/// when it can be shown as it is.
/// Opaque images are stored as JPEG; images with transparency as PNG.
pub fn cached_render(
    path: &Path,
    max_dim: u32,
    cache_dir: &Path,
) -> Result<(PathBuf, &'static str), String> {
    let stem = cache_stem(path, max_dim)?;
    let jpg = cache_dir.join(format!("{stem}.jpg"));
    let png = cache_dir.join(format!("{stem}.png"));
    if jpg.exists() {
        return Ok((jpg, "image/jpeg"));
    }
    if png.exists() {
        return Ok((png, "image/png"));
    }
    // A JPEG that already fits and is stored upright is served as it is: re-encoding it would
    // only cost time (and its colour profile).
    if is_jpeg(path) {
        if let Some((w, h, 1, PixelFormat::RGB24 | PixelFormat::L8)) = jpeg_header(path) {
            if max_dim == 0 || w.max(h) <= max_dim {
                return Ok((path.to_path_buf(), "image/jpeg"));
            }
        }
    }

    let img = render(path, max_dim)?;
    let quality = match max_dim {
        0 => 95,
        d if d <= THUMB_LIMIT => 82,
        _ => 90,
    };
    let has_alpha = img.color().has_alpha();
    let (out, mime) = if has_alpha {
        (png, "image/png")
    } else {
        (jpg, "image/jpeg")
    };
    // Write to a unique temp file then rename, so concurrent requests never see a partial file.
    let tmp = cache_dir.join(format!(
        "{stem}.{}.{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = if has_alpha {
        img.to_rgba8()
            .save_with_format(&tmp, ImageFormat::Png)
            .map_err(|e| e.to_string())
    } else {
        File::create(&tmp)
            .map_err(|e| e.to_string())
            .and_then(|f| {
                JpegEncoder::new_with_quality(BufWriter::new(f), quality)
                    .encode_image(&img.to_rgb8())
                    .map_err(|e| e.to_string())
            })
    };
    if let Err(e) = written.and_then(|_| fs::rename(&tmp, &out).map_err(|e| e.to_string())) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok((out, mime))
}

struct FullImage {
    key: String,
    image: Arc<DynamicImage>,
}

/// The photo currently shown at full resolution; tiles are cut from it.
static FULL: Mutex<Option<FullImage>> = Mutex::new(None);

/// The upright, full-resolution image (8-bit RGB or RGBA), decoded once and kept for tiling.
pub fn full_image(path: &Path) -> Result<Arc<DynamicImage>, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let key = format!("{}|{}|{}", path.display(), meta.len(), unix_seconds(meta.modified()));
    // Held while decoding, so simultaneous tile requests wait instead of decoding again.
    let mut slot = FULL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(full) = slot.as_ref().filter(|f| f.key == key) {
        return Ok(full.image.clone());
    }
    // Free the previous photo before decoding the next.
    *slot = None;
    let decoded = render(path, 0)?;
    let image = match decoded {
        DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_) => decoded,
        other if other.color().has_alpha() => DynamicImage::ImageRgba8(other.to_rgba8()),
        other => DynamicImage::ImageRgb8(other.to_rgb8()),
    };
    let image = Arc::new(image);
    *slot = Some(FullImage { key, image: image.clone() });
    Ok(image)
}

/// One `size`×`size` tile of the full image as RGBA bytes, with a 1-pixel apron wherever a
/// neighbouring tile exists so that smoothed edges blend seamlessly. A 16-byte header holds
/// the data width and height and the tile's offset within the data (u32, little-endian).
pub fn tile(path: &Path, tx: u32, ty: u32, size: u32) -> Result<Vec<u8>, String> {
    let image = full_image(path)?;
    let (w, h) = (image.width() as usize, image.height() as usize);
    let size = size.clamp(64, 2048) as usize;
    let (x0, y0) = (tx as usize * size, ty as usize * size);
    if x0 >= w || y0 >= h {
        return Err("tile out of range".into());
    }
    let (x1, y1) = ((x0 + size).min(w), (y0 + size).min(h));
    let (ax0, ay0) = (x0.saturating_sub(1), y0.saturating_sub(1));
    let (ax1, ay1) = ((x1 + 1).min(w), (y1 + 1).min(h));
    let (dw, dh) = (ax1 - ax0, ay1 - ay0);
    let mut out = Vec::with_capacity(16 + dw * dh * 4);
    for value in [dw, dh, x0 - ax0, y0 - ay0] {
        out.extend_from_slice(&(value as u32).to_le_bytes());
    }
    match image.as_ref() {
        DynamicImage::ImageRgb8(rgb) => {
            let raw = rgb.as_raw();
            for y in ay0..ay1 {
                for px in raw[(y * w + ax0) * 3..(y * w + ax1) * 3].chunks_exact(3) {
                    out.extend_from_slice(&[px[0], px[1], px[2], 255]);
                }
            }
        }
        DynamicImage::ImageRgba8(rgba) => {
            let raw = rgba.as_raw();
            for y in ay0..ay1 {
                out.extend_from_slice(&raw[(y * w + ax0) * 4..(y * w + ax1) * 4]);
            }
        }
        _ => return Err("unexpected pixel format".into()),
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoInfo {
    /// Stored pixel dimensions, before EXIF orientation is applied.
    pub width: u32,
    pub height: u32,
    pub orientation: u32,
    pub size: u64,
    pub mtime: f64,
    pub format: String,
    /// Human-readable (label, value) pairs in display order.
    pub exif: Vec<(String, String)>,
}

fn field_text(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    let text = field.display_value().with_unit(exif).to_string();
    let text = text.trim().trim_matches('"').trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn gps_coordinate(exif: &exif::Exif, tag: exif::Tag, ref_tag: exif::Tag) -> Option<f64> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Rational(parts) = &field.value else {
        return None;
    };
    if parts.len() < 3 {
        return None;
    }
    let value = parts[0].to_f64() + parts[1].to_f64() / 60.0 + parts[2].to_f64() / 3600.0;
    let negative = field_text(exif, ref_tag).is_some_and(|r| r.starts_with('S') || r.starts_with('W'));
    Some(if negative { -value } else { value })
}

fn exif_summary(exif: &exif::Exif) -> Vec<(String, String)> {
    use exif::Tag;
    let mut rows: Vec<(String, String)> = Vec::new();
    let mut push = |label: &str, value: Option<String>| {
        if let Some(v) = value {
            rows.push((label.to_string(), v));
        }
    };

    let make = field_text(exif, Tag::Make);
    let model = field_text(exif, Tag::Model);
    let camera = match (make, model) {
        (Some(make), Some(model)) if model.to_lowercase().starts_with(&make.to_lowercase()) => {
            Some(model)
        }
        (Some(make), Some(model)) => Some(format!("{make} {model}")),
        (make, model) => make.or(model),
    };
    push("Camera", camera);
    push("Lens", field_text(exif, Tag::LensModel));
    push("Taken", field_text(exif, Tag::DateTimeOriginal));
    push("Shutter", field_text(exif, Tag::ExposureTime));
    push("Aperture", field_text(exif, Tag::FNumber));
    push("ISO", field_text(exif, Tag::PhotographicSensitivity));
    let focal = field_text(exif, Tag::FocalLength).map(|f| {
        match field_text(exif, Tag::FocalLengthIn35mmFilm) {
            Some(eq) if eq != "0" => format!("{f} ({eq} mm equiv.)"),
            _ => f,
        }
    });
    push("Focal length", focal);
    push("Exposure bias", field_text(exif, Tag::ExposureBiasValue));
    push("Metering", field_text(exif, Tag::MeteringMode));
    push("Flash", field_text(exif, Tag::Flash));
    push("White balance", field_text(exif, Tag::WhiteBalance));
    let gps = gps_coordinate(exif, Tag::GPSLatitude, Tag::GPSLatitudeRef).zip(gps_coordinate(
        exif,
        Tag::GPSLongitude,
        Tag::GPSLongitudeRef,
    ));
    push("Location", gps.map(|(lat, lon)| format!("{lat:.5}, {lon:.5}")));
    push("Software", field_text(exif, Tag::Software));
    push("Artist", field_text(exif, Tag::Artist));
    push("Copyright", field_text(exif, Tag::Copyright));
    rows
}

pub fn photo_info(path: &Path) -> Result<PhotoInfo, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    // From the content, not the name: a cloud drive's files are named by id.
    let reader = ImageReader::open(path).ok().and_then(|r| r.with_guessed_format().ok());
    let kind = reader.as_ref().and_then(|r| r.format());
    let (width, height) = reader.and_then(|r| r.into_dimensions().ok()).unwrap_or((0, 0));
    let exif = read_exif(path);
    let format = kind
        .and_then(|f| f.extensions_str().first().copied())
        .unwrap_or("unknown")
        .to_uppercase();
    Ok(PhotoInfo {
        width,
        height,
        orientation: exif.as_ref().map(orientation_of).unwrap_or(1),
        size: meta.len(),
        mtime: unix_seconds(meta.modified()),
        format,
        exif: exif.as_ref().map(exif_summary).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    #[test]
    fn orientation_rotates_and_flips_like_exif() {
        // 2×1 image: red on the left, blue on the right.
        let mut img = image::RgbImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgb([255, 0, 0]));
        img.put_pixel(1, 0, image::Rgb([0, 0, 255]));
        let img = DynamicImage::ImageRgb8(img);

        let rotated = apply_orientation(img.clone(), 6);
        assert_eq!(rotated.dimensions(), (1, 2));
        // Rotating 90° clockwise puts the left (red) pixel on top.
        assert_eq!(rotated.get_pixel(0, 0).0[0], 255);

        let mirrored = apply_orientation(img.clone(), 2);
        assert_eq!(mirrored.get_pixel(0, 0).0[2], 255);

        let ccw = apply_orientation(img, 8);
        assert_eq!(ccw.dimensions(), (1, 2));
        assert_eq!(ccw.get_pixel(0, 1).0[0], 255);
    }

    #[test]
    fn display_size_reads_headers_and_honours_orientation() {
        use image::ImageEncoder;
        let dir = std::env::temp_dir().join(format!("sliderpro-size-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let pixels = RgbImage::new(40, 20);

        let png = dir.join("wide.png");
        pixels.save(&png).unwrap();
        assert_eq!(display_size(&png), Some((40, 20)));

        // A big-endian TIFF block with one entry: Orientation = 6 (rotate 90° clockwise).
        let exif = vec![
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, //
            0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, //
            0, 0, 0, 0,
        ];
        let jpg = dir.join("rotated.jpg");
        let mut encoder = JpegEncoder::new(BufWriter::new(File::create(&jpg).unwrap()));
        encoder.set_exif_metadata(exif).unwrap();
        encoder.write_image(pixels.as_raw(), 40, 20, image::ExtendedColorType::Rgb8).unwrap();
        assert_eq!(display_size(&jpg), Some((20, 40)));

        let junk = dir.join("junk.jpg");
        fs::write(&junk, b"not an image").unwrap();
        assert_eq!(display_size(&junk), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_stored_thumbnail_is_found_until_its_file_changes() {
        let dir = std::env::temp_dir().join(format!("sliderpro-stored-{}", std::process::id()));
        let cache = dir.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let pdf = dir.join("paper.pdf");
        fs::write(&pdf, b"%PDF-1.7").unwrap();
        assert_eq!(stored_thumb(&pdf, 256, &cache), None);
        assert!(store_thumb(&pdf, 256, &cache, b"not a jpeg").is_err());

        store_thumb(&pdf, 256, &cache, &[0xff, 0xd8, 0xff, 0xd9]).unwrap();
        let stored = stored_thumb(&pdf, 256, &cache).unwrap();
        assert_eq!(fs::read(stored).unwrap(), [0xff, 0xd8, 0xff, 0xd9]);
        // Kept per size, and forgotten once the file is different.
        assert_eq!(stored_thumb(&pdf, 512, &cache), None);
        fs::write(&pdf, b"%PDF-1.7 edited").unwrap();
        assert_eq!(stored_thumb(&pdf, 256, &cache), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cached_render_serves_an_upright_jpeg_that_fits_as_it_is() {
        use image::ImageEncoder;
        let dir = std::env::temp_dir().join(format!("sliderpro-asis-{}", std::process::id()));
        let cache = dir.join("cache");
        fs::create_dir_all(&cache).unwrap();
        let pixels = RgbImage::new(40, 20);
        let write = |name: &str, exif: Option<Vec<u8>>| {
            let path = dir.join(name);
            let mut encoder = JpegEncoder::new(BufWriter::new(File::create(&path).unwrap()));
            if let Some(exif) = exif {
                encoder.set_exif_metadata(exif).unwrap();
            }
            encoder.write_image(pixels.as_raw(), 40, 20, image::ExtendedColorType::Rgb8).unwrap();
            path
        };

        let upright = write("upright.jpg", None);
        assert_eq!(cached_render(&upright, 64, &cache).unwrap().0, upright);
        assert_eq!(cached_render(&upright, 0, &cache).unwrap().0, upright);
        // Larger than asked for: rendered down into the cache.
        let (small, _) = cached_render(&upright, 16, &cache).unwrap();
        assert!(small.starts_with(&cache));
        assert_eq!(image::image_dimensions(&small).unwrap(), (16, 8));

        // Orientation = 6: the file needs turning, so it is rendered upright.
        let exif = vec![
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, //
            0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, //
            0, 0, 0, 0,
        ];
        let rotated = write("rotated.jpg", Some(exif));
        let (turned, _) = cached_render(&rotated, 64, &cache).unwrap();
        assert!(turned.starts_with(&cache));
        assert_eq!(image::image_dimensions(&turned).unwrap(), (20, 40));
        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tile_tests {
    use super::*;

    #[test]
    fn tiles_carry_an_apron_and_the_right_pixels() {
        let dir = std::env::temp_dir().join(format!("sliderpro-tiles-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("grid.png");
        // 600×300: pixel (x, y) is (x % 256, y % 256, 7).
        let img = RgbImage::from_fn(600, 300, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 7]));
        img.save(&path).unwrap();

        let bytes = tile(&path, 1, 0, 512).unwrap();
        let header: Vec<u32> = bytes[..16].chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        // Tile (1, 0) covers x 512..600; it gets a left apron but no right or top one.
        assert_eq!(header, vec![89, 300, 1, 0]);
        let data = &bytes[16..];
        let at = |dx: usize, dy: usize| &data[(dy * 89 + dx) * 4..(dy * 89 + dx) * 4 + 4];
        assert_eq!(at(1, 0), &[(512 % 256) as u8, 0, 7, 255]); // first pixel of the tile
        assert_eq!(at(0, 5), &[(511 % 256) as u8, 5, 7, 255]); // apron from the neighbour
        assert!(tile(&path, 2, 0, 512).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
