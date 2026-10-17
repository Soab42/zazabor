//! Decoding, EXIF orientation, resizing and the on-disk render cache.

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, ImageFormat, ImageReader, RgbImage};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
        jpeg_decoder::PixelFormat::RGB24 => {
            RgbImage::from_raw(w, h, pixels).map(DynamicImage::ImageRgb8)
        }
        jpeg_decoder::PixelFormat::L8 => {
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
    let decoded = if is_jpeg(path) {
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
        img.resize(max_dim, max_dim, FilterType::Lanczos3)
    })
}

/// Returns a cached render of `path` at `max_dim`, producing it on a miss.
/// Opaque images are stored as JPEG; images with transparency as PNG.
pub fn cached_render(
    path: &Path,
    max_dim: u32,
    cache_dir: &Path,
) -> Result<(PathBuf, &'static str), String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let key = format!(
        "{CACHE_VERSION}|{}|{}|{}|{max_dim}",
        path.display(),
        meta.len(),
        unix_seconds(meta.modified())
    );
    let stem = format!("{:016x}", xxh3_64(key.as_bytes()));
    let jpg = cache_dir.join(format!("{stem}.jpg"));
    let png = cache_dir.join(format!("{stem}.png"));
    if jpg.exists() {
        return Ok((jpg, "image/jpeg"));
    }
    if png.exists() {
        return Ok((png, "image/png"));
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
    let (width, height) = image::image_dimensions(path).unwrap_or((0, 0));
    let exif = read_exif(path);
    let format = ImageFormat::from_path(path)
        .ok()
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
}
