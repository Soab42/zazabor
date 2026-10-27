//! Photo's AI tools, on this computer's CPU: Remove Background and Select Subject (IS-Net, or
//! U²-Netp when the faster model is chosen), click to select (MobileSAM's encoder once per picture,
//! then its prompt decoder per click), and Remove an Object (MI-GAN inpainting).
//!
//! Nothing is bundled: each model downloads on first use from a pinned address, after the page
//! has asked (with its size), into the app's data folder. Downloads resume after a cancel or a
//! lost connection and are checked against their SHA-256 before use. Only models whose weights
//! are under a permissive licence (MIT or Apache-2.0) are listed.
//!
//! Inference runs in tract (pure Rust ONNX), so building Zazabor downloads nothing prebuilt. Each
//! model is planned once for a fixed input size and kept in memory while Zazabor runs.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use image::imageops::FilterType;
use image::{ImageBuffer, Luma, Rgb, RgbImage};
use sha2::{Digest, Sha256};
use tract_linalg::multithread::{multithread_tract_scope, Executor};
use tract_onnx::prelude::*;

/// One downloadable model file.
pub struct Model {
    pub id: &'static str,
    pub title: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
    pub licence: &'static str,
    pub source: &'static str,
}

/// Every model the AI tools use. Sizes and checksums are those of the pinned files.
pub const MODELS: &[Model] = &[
    Model {
        id: "isnet",
        title: "Subject finder (IS-Net)",
        file: "isnet-general-use.onnx",
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx",
        sha256: "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
        bytes: 178_648_008,
        licence: "Apache-2.0",
        source: "https://github.com/xuebinqin/DIS",
    },
    Model {
        id: "u2netp",
        title: "Fast subject finder (U²-Netp)",
        file: "u2netp.onnx",
        url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
        sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
        bytes: 4_574_861,
        licence: "Apache-2.0",
        source: "https://github.com/xuebinqin/U-2-Net",
    },
    Model {
        id: "sam-encoder",
        title: "Object selection, image encoder (MobileSAM)",
        file: "mobile_sam_image_encoder.onnx",
        url: "https://huggingface.co/Acly/MobileSAM/resolve/main/mobile_sam_image_encoder.onnx",
        sha256: "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749",
        bytes: 28_157_093,
        licence: "Apache-2.0 (weights), MIT (export)",
        source: "https://github.com/ChaoningZhang/MobileSAM",
    },
    Model {
        id: "sam-decoder",
        title: "Object selection, mask decoder (Segment Anything)",
        file: "sam_mask_decoder_single.onnx",
        url: "https://huggingface.co/Acly/MobileSAM/resolve/main/sam_mask_decoder_single.onnx",
        sha256: "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d",
        bytes: 16_501_323,
        licence: "Apache-2.0 (weights), MIT (export)",
        source: "https://github.com/ChaoningZhang/MobileSAM",
    },
    Model {
        id: "migan",
        title: "Object remover (MI-GAN)",
        file: "migan.onnx",
        url: "https://huggingface.co/andraniksargsyan/migan/resolve/main/migan.onnx",
        sha256: "593eba0b7e04730f1b61c0a3cbca68d97d8d6a7ff5c6a44a7b9d7fcd880fc5ae",
        bytes: 29_546_882,
        licence: "MIT",
        source: "https://github.com/Picsart-AI-Research/MI-GAN",
    },
];

/// The models a tool needs: "subject" (Remove Background, Select Subject), "subject-fast",
/// "select" (click to select) and "remove" (Remove an Object).
pub fn models_for(tool: &str) -> &'static [&'static str] {
    match tool {
        "subject" => &["isnet"],
        "subject-fast" => &["u2netp"],
        "select" => &["sam-encoder", "sam-decoder"],
        "remove" => &["migan"],
        _ => &[],
    }
}

pub fn model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

fn path_of(dir: &Path, m: &Model) -> PathBuf {
    dir.join(m.file)
}

fn part_of(dir: &Path, m: &Model) -> PathBuf {
    dir.join(format!("{}.part", m.file))
}

/// Whether the model's file is in `dir` (complete; its checksum was checked when it arrived).
pub fn installed(dir: &Path, m: &Model) -> bool {
    std::fs::metadata(path_of(dir, m)).map(|md| md.len() == m.bytes).unwrap_or(false)
}

/// Bytes of an unfinished download, to resume from.
pub fn partial(dir: &Path, m: &Model) -> u64 {
    std::fs::metadata(part_of(dir, m)).map(|md| md.len()).unwrap_or(0)
}

/// The SHA-256 of a file, in lowercase hex.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Moves a finished download into place once its size and checksum are right; a wrong file is
/// deleted so the next try starts over.
pub fn finish_download(dir: &Path, m: &Model) -> Result<(), String> {
    let part = part_of(dir, m);
    let got = std::fs::metadata(&part).map(|md| md.len()).unwrap_or(0);
    if got != m.bytes || sha256_file(&part)? != m.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("The download of {} was damaged (its checksum didn't match). Try again.", m.title));
    }
    std::fs::rename(&part, path_of(dir, m)).map_err(|e| e.to_string())
}

/// Downloads a model into `dir`, resuming an earlier partial download. `progress(done, total)` is
/// called as bytes arrive; setting `cancel` stops it (the part already fetched is kept).
pub fn download(dir: &Path, m: &Model, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    if installed(dir, m) {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = part_of(dir, m);
    let mut start = partial(dir, m);
    if start > m.bytes {
        let _ = std::fs::remove_file(&part);
        start = 0;
    }
    if start < m.bytes {
        let mut request = ureq::get(m.url);
        if start > 0 {
            request = request.header("Range", &format!("bytes={start}-"));
        }
        let mut response = request.call().map_err(|e| format!("Couldn't download {}: {e}", m.title))?;
        // A server that ignores the range sends the whole file again.
        if start > 0 && response.status().as_u16() != 206 {
            start = 0;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(start > 0)
            .truncate(start == 0)
            .open(&part)
            .map_err(|e| e.to_string())?;
        let mut reader = response.body_mut().with_config().limit(m.bytes + 1).reader();
        let mut buf = vec![0u8; 256 * 1024];
        let mut done = start;
        progress(done, m.bytes);
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Cancelled".into());
            }
            let n = reader.read(&mut buf).map_err(|e| format!("The download of {} stopped: {e}", m.title))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            progress(done, m.bytes);
        }
        file.flush().map_err(|e| e.to_string())?;
        if done < m.bytes {
            return Err(format!("The download of {} stopped early. Try again to continue it.", m.title));
        }
    }
    finish_download(dir, m)
}

/// Deletes a model's file (and any unfinished download of it).
pub fn remove(dir: &Path, m: &Model) -> Result<(), String> {
    for path in [path_of(dir, m), part_of(dir, m)] {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    forget_plans(m.id);
    Ok(())
}

// ---- planning and running ----------------------------------------------------------------------

type Plan = Arc<TypedRunnableModel>;

/// Planned models, by model id (and input size, for the subject finders).
static PLANS: Mutex<Vec<(String, Plan)>> = Mutex::new(Vec::new());

fn forget_plans(id: &str) {
    PLANS.lock().unwrap_or_else(|e| e.into_inner()).retain(|(key, _)| key.split('@').next() != Some(id));
}

/// The model planned for these input facts, keeping only the outputs listed.
fn plan(dir: &Path, id: &str, inputs: &[InferenceFact], outputs: Option<&[usize]>) -> Result<Plan, String> {
    let key = format!("{id}@{inputs:?}");
    if let Some((_, p)) = PLANS.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _)| *k == key) {
        return Ok(p.clone());
    }
    let m = model(id).ok_or("Unknown model.")?;
    if !installed(dir, m) {
        return Err(format!("{} isn't downloaded yet.", m.title));
    }
    let run = || -> TractResult<Plan> {
        let mut graph = tract_onnx::onnx().model_for_path(path_of(dir, m))?;
        for (i, fact) in inputs.iter().enumerate() {
            graph = graph.with_input_fact(i, fact.clone())?;
        }
        if let Some(keep) = outputs {
            let all = graph.output_outlets()?.to_vec();
            let wanted: Vec<OutletId> = keep.iter().map(|&i| all[i]).collect();
            graph.select_output_outlets(&wanted)?;
        }
        graph.into_optimized()?.into_runnable()
    };
    let p = run().map_err(|e| format!("Couldn't load {}: {e}", m.title))?;
    let mut plans = PLANS.lock().unwrap_or_else(|e| e.into_inner());
    plans.push((key, p.clone()));
    Ok(p)
}

/// Runs a plan on every CPU core this computer has.
fn run(p: &Plan, inputs: TVec<TValue>) -> Result<TVec<TValue>, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    multithread_tract_scope(Executor::multithread(threads), || p.run(inputs)).map_err(|e| e.to_string())
}

/// RGB from RGBA, with transparent parts shown on mid grey (models see no alpha).
fn rgb_of(rgba: &[u8], w: u32, h: u32) -> RgbImage {
    let mut out = RgbImage::new(w, h);
    for (i, px) in out.pixels_mut().enumerate() {
        let s = &rgba[i * 4..i * 4 + 4];
        let a = s[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 128 * (255 - a)) / 255) as u8;
        *px = Rgb([mix(s[0]), mix(s[1]), mix(s[2])]);
    }
    out
}

fn check_size(rgba: &[u8], w: u32, h: u32) -> Result<(), String> {
    if w == 0 || h == 0 || rgba.len() != w as usize * h as usize * 4 {
        return Err("The picture's size doesn't match its pixels.".into());
    }
    Ok(())
}

/// A greyscale map at another size, smoothly.
fn resize_grey(data: Vec<u8>, w: u32, h: u32, nw: u32, nh: u32) -> Vec<u8> {
    let img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::from_raw(w, h, data).expect("sized");
    image::imageops::resize(&img, nw, nh, FilterType::Triangle).into_raw()
}

// ---- the subject (Remove Background, Select Subject) ----

/// How opaque each pixel of the main subject is (0–255, one byte per pixel at the picture's size).
/// `fast` uses U²-Netp at 320 px instead of IS-Net at 1024 px.
pub fn subject_mask(dir: &Path, rgba: &[u8], w: u32, h: u32, fast: bool) -> Result<Vec<u8>, String> {
    check_size(rgba, w, h)?;
    let (id, side, mean, std) = if fast {
        ("u2netp", 320u32, [0.485f32, 0.456, 0.406], [0.229f32, 0.224, 0.225])
    } else {
        ("isnet", 1024u32, [0.5f32, 0.5, 0.5], [1.0f32, 1.0, 1.0])
    };
    let s = side as usize;
    let p = plan(dir, id, &[InferenceFact::dt_shape(f32::datum_type(), tvec!(1, 3, s, s))], Some(&[0]))?;
    let small = image::imageops::resize(&rgb_of(rgba, w, h), side, side, FilterType::Triangle);
    let input = tract_ndarray::Array4::from_shape_fn((1, 3, s, s), |(_, c, y, x)| {
        (small.get_pixel(x as u32, y as u32)[c] as f32 / 255.0 - mean[c]) / std[c]
    });
    let out = run(&p, tvec!(input.into_tensor().into()))?;
    let pred = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    let (lo, hi) = pred.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    let span = (hi - lo).max(1e-6);
    let grey: Vec<u8> = pred.iter().map(|&v| (((v - lo) / span) * 255.0).round().clamp(0.0, 255.0) as u8).collect();
    Ok(resize_grey(grey, side, side, w, h))
}

// ---- click to select (MobileSAM) ----

const SAM_SIDE: usize = 1024;
/// Clicks a selection keeps (the latest ones); the decoder is planned once per count.
pub const SAM_POINTS: usize = 16;
const SAM_MEAN: [f32; 3] = [123.675, 116.28, 103.53];

/// MobileSAM's view of one picture: computed once, then each click is quick.
pub struct SamEmbedding {
    data: Arc<tract_ndarray::ArrayD<f32>>,
    /// Picture pixels → the encoder's 1024-px frame.
    scale: f32,
    pub width: u32,
    pub height: u32,
}

pub fn sam_embed(dir: &Path, rgba: &[u8], w: u32, h: u32) -> Result<SamEmbedding, String> {
    check_size(rgba, w, h)?;
    let scale = SAM_SIDE as f32 / w.max(h) as f32;
    let nw = ((w as f32 * scale).round() as u32).clamp(1, SAM_SIDE as u32);
    let nh = ((h as f32 * scale).round() as u32).clamp(1, SAM_SIDE as u32);
    let small = image::imageops::resize(&rgb_of(rgba, w, h), nw, nh, FilterType::Triangle);
    // Padding with the mean becomes zero after the model's own normalising, as SAM pads.
    let input = tract_ndarray::Array3::from_shape_fn((SAM_SIDE, SAM_SIDE, 3), |(y, x, c)| {
        if (x as u32) < nw && (y as u32) < nh { small.get_pixel(x as u32, y as u32)[c] as f32 } else { SAM_MEAN[c] }
    });
    let p = plan(dir, "sam-encoder", &[InferenceFact::dt_shape(f32::datum_type(), tvec!(SAM_SIDE, SAM_SIDE, 3))], None)?;
    let out = run(&p, tvec!(input.into_tensor().into()))?;
    let data = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?.to_owned();
    Ok(SamEmbedding { data: Arc::new(data), scale, width: w, height: h })
}

/// A click: picture coordinates, and whether it adds (true) or takes away (false).
#[derive(Clone, Copy, Debug, serde::Deserialize)]
pub struct SamPoint {
    pub x: f32,
    pub y: f32,
    pub add: bool,
}

/// The object the clicks point at, as a soft mask at the picture's size.
pub fn sam_mask(dir: &Path, emb: &SamEmbedding, points: &[SamPoint]) -> Result<Vec<u8>, String> {
    if points.is_empty() {
        return Err("Click on the object to select.".into());
    }
    // The clicks and one "not a point" pad, as SAM was trained (more pads spoil the mask).
    let points = &points[points.len().saturating_sub(SAM_POINTS)..];
    let n = points.len() + 1;
    let mut coords = tract_ndarray::Array3::<f32>::zeros((1, n, 2));
    let mut labels = tract_ndarray::Array2::<f32>::from_elem((1, n), -1.0);
    for (i, p) in points.iter().enumerate() {
        coords[[0, i, 0]] = p.x * emb.scale;
        coords[[0, i, 1]] = p.y * emb.scale;
        labels[[0, i]] = if p.add { 1.0 } else { 0.0 };
    }
    let mask_input = tract_ndarray::Array4::<f32>::zeros((1, 1, 256, 256));
    let has_mask = tract_ndarray::Array1::<f32>::zeros(1);
    let size = tract_ndarray::arr1(&[emb.height as f32, emb.width as f32]);
    let facts = [
        InferenceFact::dt_shape(f32::datum_type(), tvec!(1, 256, 64, 64)),
        InferenceFact::dt_shape(f32::datum_type(), tvec!(1, n, 2)),
        InferenceFact::dt_shape(f32::datum_type(), tvec!(1, n)),
        InferenceFact::dt_shape(f32::datum_type(), tvec!(1, 1, 256, 256)),
        InferenceFact::dt_shape(f32::datum_type(), tvec!(1)),
        InferenceFact::dt_shape(f32::datum_type(), tvec!(2)),
    ];
    // Only the scores and the 256-px mask: the full-size one needs shapes tract can't plan ahead.
    let p = plan(dir, "sam-decoder", &facts, Some(&[1, 2]))?;
    let out = run(
        &p,
        tvec!(
            Tensor::from((*emb.data).clone()).into(),
            coords.into_tensor().into(),
            labels.into_tensor().into(),
            mask_input.into_tensor().into(),
            has_mask.into_tensor().into(),
            size.into_tensor().into(),
        ),
    )?;
    let low = out[1].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    // The 256-px mask covers the 1024-px frame; the picture fills its top-left corner.
    let cw = ((emb.width as f32 * emb.scale / 4.0).round() as usize).clamp(1, 256);
    let ch = ((emb.height as f32 * emb.scale / 4.0).round() as usize).clamp(1, 256);
    let (w, h) = (emb.width as usize, emb.height as usize);
    let mut mask = vec![0u8; w * h];
    let at = |x: usize, y: usize| low[[0, 0, y.min(ch - 1), x.min(cw - 1)]];
    for y in 0..h {
        let fy = ((y as f32 + 0.5) * ch as f32 / h as f32 - 0.5).max(0.0);
        let (y0, ty) = (fy.floor() as usize, fy.fract());
        for x in 0..w {
            let fx = ((x as f32 + 0.5) * cw as f32 / w as f32 - 0.5).max(0.0);
            let (x0, tx) = (fx.floor() as usize, fx.fract());
            let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1, y0) * tx;
            let bottom = at(x0, y0 + 1) * (1.0 - tx) + at(x0 + 1, y0 + 1) * tx;
            let logit = top * (1.0 - ty) + bottom * ty;
            // A soft edge about a pixel wide.
            mask[y * w + x] = ((logit * 2.0 + 0.5).clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    Ok(mask)
}

// ---- Remove an Object (MI-GAN) ----

const MIGAN_SIDE: u32 = 512;

/// A patch to paste back: its place in the picture and its RGBA pixels.
pub struct Patch {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The smallest box holding every marked pixel.
fn bounds(mask: &[u8], w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for y in 0..h {
        for x in 0..w {
            if mask[(y * w + x) as usize] > 127 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    (x0 != u32::MAX).then(|| (x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}

/// Where the model looks: a square around the marked area with room for context, inside the picture.
fn context_box(b: (u32, u32, u32, u32), w: u32, h: u32) -> (u32, u32, u32, u32) {
    let (bx, by, bw, bh) = b;
    let side = ((bw.max(bh) as f32 * 3.0) as u32).max(MIGAN_SIDE / 2).min(w.max(h));
    let (cw, ch) = (side.min(w), side.min(h));
    let cx = (bx + bw / 2).saturating_sub(cw / 2).min(w - cw);
    let cy = (by + bh / 2).saturating_sub(ch / 2).min(h - ch);
    (cx, cy, cw, ch)
}

/// Fills the marked pixels (mask > 127) with what the model expects around them. The rest of the
/// picture is untouched; the patch covers the area the model looked at.
pub fn inpaint(dir: &Path, rgba: &[u8], w: u32, h: u32, mask: &[u8]) -> Result<Patch, String> {
    check_size(rgba, w, h)?;
    if mask.len() != (w * h) as usize {
        return Err("The mask's size doesn't match the picture.".into());
    }
    let b = bounds(mask, w, h).ok_or("Paint over what to remove first.")?;
    let (cx, cy, cw, ch) = context_box(b, w, h);
    let side = MIGAN_SIDE;
    let s = side as usize;
    let crop_rgb = image::imageops::crop_imm(&rgb_of(rgba, w, h), cx, cy, cw, ch).to_image();
    let small = image::imageops::resize(&crop_rgb, side, side, FilterType::Triangle);
    let mut crop_mask = vec![0u8; (cw * ch) as usize];
    for y in 0..ch {
        for x in 0..cw {
            crop_mask[(y * cw + x) as usize] = mask[((y + cy) * w + x + cx) as usize];
        }
    }
    // A slightly grown hole: objects' soft edges and shadows go with them.
    let hole = grow(&resize_grey(crop_mask.clone(), cw, ch, side, side), side, side, 3);
    let image_in = tract_ndarray::Array4::from_shape_fn((1, 3, s, s), |(_, c, y, x)| small.get_pixel(x as u32, y as u32)[c]);
    // MI-GAN's mask: 255 where the picture is known, 0 in the hole.
    let mask_in = tract_ndarray::Array4::from_shape_fn((1, 1, s, s), |(_, _, y, x)| if hole[y * s + x] > 0 { 0u8 } else { 255u8 });
    let facts = [
        InferenceFact::dt_shape(u8::datum_type(), tvec!(1, 3, s, s)),
        InferenceFact::dt_shape(u8::datum_type(), tvec!(1, 1, s, s)),
    ];
    let p = plan(dir, "migan", &facts, None)?;
    let out = run(&p, tvec!(image_in.into_tensor().into(), mask_in.into_tensor().into()))?;
    let filled = out[0].to_plain_array_view::<u8>().map_err(|e| e.to_string())?;
    let mut result = RgbImage::new(side, side);
    for (x, y, px) in result.enumerate_pixels_mut() {
        *px = Rgb([0, 1, 2].map(|c| filled[[0, c, y as usize, x as usize]]));
    }
    let back = image::imageops::resize(&result, cw, ch, FilterType::CatmullRom);
    // Blend the filled pixels in over a feathered, slightly grown copy of the mask.
    let blend = feather(&grow(&crop_mask, cw, ch, 4), cw, ch, 3);
    let mut patch = vec![0u8; (cw * ch * 4) as usize];
    for y in 0..ch {
        for x in 0..cw {
            let i = (y * cw + x) as usize;
            let src = ((y + cy) * w + x + cx) as usize * 4;
            let a = blend[i] as u32;
            let f = back.get_pixel(x, y);
            for c in 0..3 {
                patch[i * 4 + c] = ((rgba[src + c] as u32 * (255 - a) + f[c] as u32 * a + 127) / 255) as u8;
            }
            // A hole painted on a transparent area becomes solid.
            patch[i * 4 + 3] = rgba[src + 3].max(a as u8);
        }
    }
    Ok(Patch { x: cx, y: cy, width: cw, height: ch, rgba: patch })
}

/// The mask grown by `r` pixels (a square neighbourhood, two passes).
fn grow(mask: &[u8], w: u32, h: u32, r: u32) -> Vec<u8> {
    let (w, h, r) = (w as usize, h as usize, r as usize);
    let mut rows = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let lo = x.saturating_sub(r);
            let hi = (x + r).min(w - 1);
            rows[y * w + x] = mask[y * w + lo..=y * w + hi].iter().copied().max().unwrap_or(0);
        }
    }
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        let lo = y.saturating_sub(r);
        let hi = (y + r).min(h - 1);
        for x in 0..w {
            out[y * w + x] = (lo..=hi).map(|yy| rows[yy * w + x]).max().unwrap_or(0);
        }
    }
    out
}

/// A box blur of radius `r`, twice (close to a Gaussian), for soft blend edges.
fn feather(mask: &[u8], w: u32, h: u32, r: u32) -> Vec<u8> {
    let img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::from_raw(w, h, mask.to_vec()).expect("sized");
    image::imageops::blur(&img, r as f32).into_raw()
}

/// Cancels whatever download is running for the model with this id (see `download`).
pub struct Cancels(Mutex<Vec<(String, Arc<AtomicBool>)>>);

impl Cancels {
    pub const fn new() -> Self {
        Cancels(Mutex::new(Vec::new()))
    }
    pub fn start(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut list = self.0.lock().unwrap_or_else(|e| e.into_inner());
        list.retain(|(k, _)| k != id);
        list.push((id.to_string(), flag.clone()));
        flag
    }
    pub fn cancel(&self, id: &str) {
        for (k, flag) in self.0.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            if k == id {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
    pub fn finish(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| k != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-ai-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_model_is_pinned_and_permissive() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", m.id);
            assert!(m.url.starts_with("https://"), "{}", m.id);
            assert!(m.bytes > 0, "{}", m.id);
            assert!(m.licence.contains("MIT") || m.licence.contains("Apache-2.0"), "{}", m.id);
            assert!(!m.licence.contains("NC"), "{}", m.id);
        }
        for tool in ["subject", "subject-fast", "select", "remove"] {
            assert!(!models_for(tool).is_empty());
            assert!(models_for(tool).iter().all(|id| model(id).is_some()));
        }
    }

    #[test]
    fn a_download_is_kept_only_when_its_checksum_matches() {
        let dir = scratch("check");
        let body = b"pretend model weights";
        let good: String = Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect();
        let good: &'static str = Box::leak(good.into_boxed_str());
        let m = Model { id: "t", title: "Test", file: "t.onnx", url: "https://example.invalid/t.onnx", sha256: good, bytes: body.len() as u64, licence: "MIT", source: "" };
        std::fs::write(part_of(&dir, &m), body).unwrap();
        assert_eq!(partial(&dir, &m), body.len() as u64);
        finish_download(&dir, &m).unwrap();
        assert!(installed(&dir, &m));
        assert_eq!(partial(&dir, &m), 0);

        let bad = Model { sha256: "0000000000000000000000000000000000000000000000000000000000000000", file: "u.onnx", ..m };
        std::fs::write(part_of(&dir, &bad), body).unwrap();
        assert!(finish_download(&dir, &bad).is_err());
        assert!(!installed(&dir, &bad));
        assert_eq!(partial(&dir, &bad), 0, "a damaged download is deleted");
        remove(&dir, &m).unwrap();
        assert!(!installed(&dir, &m));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_context_box_holds_the_hole_and_stays_inside() {
        let (w, h) = (3000, 2000);
        for b in [(10, 10, 40, 40), (2900, 1900, 99, 99), (0, 0, 3000, 2000), (1500, 50, 600, 30)] {
            let (x, y, cw, ch) = context_box(b, w, h);
            assert!(x + cw <= w && y + ch <= h, "{b:?}");
            assert!(x <= b.0 && y <= b.1 && x + cw >= b.0 + b.2 && y + ch >= b.1 + b.3, "{b:?} in {:?}", (x, y, cw, ch));
        }
        assert_eq!(bounds(&[0, 0, 255, 0, 255, 0], 3, 2), Some((1, 0, 2, 2)));
        assert_eq!(bounds(&[0; 6], 3, 2), None);
    }

    /// Needs the downloaded models: ZAZABOR_AI_MODELS=<folder> cargo test -- --ignored ai_models
    #[test]
    #[ignore]
    fn ai_models_run_on_a_small_picture() {
        let Ok(dir) = std::env::var("ZAZABOR_AI_MODELS") else { return };
        let dir = PathBuf::from(dir);
        let (w, h) = (96u32, 64u32);
        let mut rgba = vec![255u8; (w * h * 4) as usize];
        for y in 20..44 {
            for x in 30..66 {
                let i = ((y * w + x) * 4) as usize;
                rgba[i..i + 3].copy_from_slice(&[200, 30, 30]);
            }
        }
        let fast = subject_mask(&dir, &rgba, w, h, true).unwrap();
        assert_eq!(fast.len(), (w * h) as usize);
        let emb = sam_embed(&dir, &rgba, w, h).unwrap();
        let m = sam_mask(&dir, &emb, &[SamPoint { x: 48.0, y: 32.0, add: true }]).unwrap();
        assert!(m[(32 * w + 48) as usize] > 127, "the clicked square is selected");
        assert!(m[(2 * w + 2) as usize] < 128, "the white corner isn't");
        let mut hole = vec![0u8; (w * h) as usize];
        for y in 20..44 {
            for x in 30..66 {
                hole[(y * w + x) as usize] = 255;
            }
        }
        let patch = inpaint(&dir, &rgba, w, h, &hole).unwrap();
        let cx = 48 - patch.x;
        let cy = 32 - patch.y;
        let i = ((cy * patch.width + cx) * 4) as usize;
        assert!(patch.rgba[i] > 150 && patch.rgba[i + 1] > 150, "the red square is filled with the white around it");
    }
}
