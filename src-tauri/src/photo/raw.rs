//! Camera RAW files for Photo, through LibRaw (vendored in `vendor/LibRaw`, built by `build.rs`).
//!
//! LibRaw decodes and demosaics once per file, white-balanced as shot, in the camera's own linear
//! colours and without clipping. Developing is Zazabor's own and quick, so the Develop panel's
//! sliders can redo it: white balance (as shot, a preset or a temperature and tint, turned into
//! camera multipliers through the camera's colour matrix), the camera matrix to linear sRGB or
//! Display P3, exposure on top of an automatic baseline, highlight recovery (a soft shoulder that
//! also takes the colour cast out of clipped channels) and a tone curve close to a camera's own
//! rendering. The result is an 8-bit layer tagged with its colour space.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;

/// File extensions LibRaw opens (as Photo offers them).
pub const RAW_EXTENSIONS: &[&str] = &[
    "3fr", "arw", "cr2", "cr3", "crw", "dcr", "dng", "erf", "fff", "iiq", "k25", "kdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "pef",
    "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
];

pub fn is_raw(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| RAW_EXTENSIONS.iter().any(|r| r.eq_ignore_ascii_case(e)))
}

// ---- LibRaw's C API (the few calls used; see vendor/LibRaw/libraw/libraw.h) --------------------

#[repr(C)]
struct ProcessedImage {
    kind: c_int,
    height: u16,
    width: u16,
    colors: u16,
    bits: u16,
    data_size: u32,
    data: [u8; 1],
}

/// The start of `libraw_iparams_t`.
#[repr(C)]
struct IParams {
    guard: [c_char; 4],
    make: [c_char; 64],
    model: [c_char; 64],
}

/// The start of `libraw_imgother_t`.
#[repr(C)]
struct ImgOther {
    iso_speed: f32,
    shutter: f32,
    aperture: f32,
    focal_len: f32,
}

const IMAGE_JPEG: c_int = 1;

extern "C" {
    fn libraw_init(flags: u32) -> *mut c_void;
    fn libraw_open_file(lr: *mut c_void, path: *const c_char) -> c_int;
    fn libraw_unpack(lr: *mut c_void) -> c_int;
    fn libraw_unpack_thumb(lr: *mut c_void) -> c_int;
    fn libraw_dcraw_process(lr: *mut c_void) -> c_int;
    fn libraw_dcraw_make_mem_image(lr: *mut c_void, errc: *mut c_int) -> *mut ProcessedImage;
    fn libraw_dcraw_make_mem_thumb(lr: *mut c_void, errc: *mut c_int) -> *mut ProcessedImage;
    fn libraw_dcraw_clear_mem(img: *mut ProcessedImage);
    fn libraw_close(lr: *mut c_void);
    fn libraw_strerror(code: c_int) -> *const c_char;
    fn libraw_set_output_color(lr: *mut c_void, value: c_int);
    fn libraw_set_output_bps(lr: *mut c_void, value: c_int);
    fn libraw_set_gamma(lr: *mut c_void, index: c_int, value: f32);
    fn libraw_set_no_auto_bright(lr: *mut c_void, value: c_int);
    fn libraw_set_highlight(lr: *mut c_void, value: c_int);
    fn libraw_set_user_mul(lr: *mut c_void, index: c_int, value: f32);
    fn libraw_set_demosaic(lr: *mut c_void, value: c_int);
    fn libraw_get_cam_mul(lr: *mut c_void, index: c_int) -> f32;
    fn libraw_get_pre_mul(lr: *mut c_void, index: c_int) -> f32;
    fn libraw_get_rgb_cam(lr: *mut c_void, i: c_int, j: c_int) -> f32;
    fn libraw_get_iparams(lr: *mut c_void) -> *const IParams;
    fn libraw_get_imgother(lr: *mut c_void) -> *const ImgOther;
}

/// One LibRaw instance, closed when dropped.
struct Raw(*mut c_void);

impl Drop for Raw {
    fn drop(&mut self) {
        // SAFETY: the handle came from libraw_init and is closed once.
        unsafe { libraw_close(self.0) };
    }
}

fn check(code: c_int, what: &str) -> Result<(), String> {
    if code == 0 {
        return Ok(());
    }
    // SAFETY: libraw_strerror returns a static string for any code.
    let message = unsafe { CStr::from_ptr(libraw_strerror(code)) }.to_string_lossy().into_owned();
    Err(format!("{what}: {message}"))
}

fn text(chars: &[c_char]) -> String {
    let bytes: Vec<u8> = chars.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

impl Raw {
    fn open(path: &Path) -> Result<Raw, String> {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| format!("Couldn't open {name}."))?;
        // SAFETY: flags 0 is the default; a null handle means out of memory.
        let lr = unsafe { libraw_init(0) };
        if lr.is_null() {
            return Err("LibRaw couldn't start.".into());
        }
        let raw = Raw(lr);
        // SAFETY: a live handle and a NUL-terminated path.
        check(unsafe { libraw_open_file(raw.0, c.as_ptr()) }, &format!("Couldn't open {name} as a camera RAW file"))?;
        Ok(raw)
    }

    /// The processed image or thumbnail LibRaw made, copied out.
    fn take(&self, thumb: bool) -> Result<(c_int, u32, u32, u16, u16, Vec<u8>), String> {
        let mut errc: c_int = 0;
        // SAFETY: a live handle after open (and unpack/process or unpack_thumb).
        let img = unsafe { if thumb { libraw_dcraw_make_mem_thumb(self.0, &mut errc) } else { libraw_dcraw_make_mem_image(self.0, &mut errc) } };
        if img.is_null() {
            check(if errc == 0 { -1 } else { errc }, "Couldn't develop the RAW file")?;
        }
        // SAFETY: LibRaw allocated `data_size` bytes after the header; freed right after copying.
        let out = unsafe {
            let i = &*img;
            let data = std::slice::from_raw_parts(std::ptr::addr_of!(i.data) as *const u8, i.data_size as usize).to_vec();
            let r = (i.kind, i.width as u32, i.height as u32, i.colors, i.bits, data);
            libraw_dcraw_clear_mem(img);
            r
        };
        Ok(out)
    }
}

// ---- the decoded source ------------------------------------------------------------------------

/// A RAW file demosaiced: linear camera RGB, white balanced as shot, scaled so nothing clips.
pub struct Source {
    pub path: PathBuf,
    /// The file's size and modification time when it was decoded.
    stamp: (u64, std::time::SystemTime),
    pub width: u32,
    pub height: u32,
    /// Camera RGB, three u16 per pixel, upright.
    cam: Vec<u16>,
    /// Where each camera channel clips, on the 0–1 scale of `cam`.
    clip: [f32; 3],
    /// The multipliers it was shot with and the camera's daylight ones (green = 1).
    as_shot: [f32; 3],
    daylight: [f32; 3],
    /// Camera RGB → linear sRGB (D65), as LibRaw has it for this camera.
    rgb_cam: [[f32; 3]; 3],
    /// Exposure (a factor): the sensor's white one stop above white, as cameras render their JPEGs.
    baseline: f32,
    pub make: String,
    pub model: String,
    pub iso: f32,
    pub shutter: f32,
    pub aperture: f32,
    pub focal: f32,
}

/// The two RAW files opened last, so the Develop sliders don't decode again.
static CACHE: Mutex<Vec<Arc<Source>>> = Mutex::new(Vec::new());

fn stamp(path: &Path) -> (u64, std::time::SystemTime) {
    std::fs::metadata(path).map(|m| (m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH))).unwrap_or((0, std::time::UNIX_EPOCH))
}

/// The RAW file, decoded (or from the cache when it hasn't changed on disk).
pub fn source(path: &Path) -> Result<Arc<Source>, String> {
    let now = stamp(path);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = cache.iter().find(|s| s.path == path && s.stamp == now) {
        return Ok(s.clone());
    }
    drop(cache);
    let s = Arc::new(decode_source(path)?);
    cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.retain(|c| c.path != path);
    cache.insert(0, s.clone());
    cache.truncate(2);
    Ok(s)
}

fn normalize(m: [f32; 3]) -> [f32; 3] {
    let g = if m[1] > 0.0 { m[1] } else { 1.0 };
    m.map(|v| if v > 0.0 { v / g } else { 1.0 })
}

fn decode_source(path: &Path) -> Result<Source, String> {
    let raw = Raw::open(path)?;
    let lr = raw.0;
    // SAFETY: a live, opened handle for every call below.
    let (as_shot, daylight, rgb_cam, make, model, other) = unsafe {
        let cam = normalize([libraw_get_cam_mul(lr, 0), libraw_get_cam_mul(lr, 1), libraw_get_cam_mul(lr, 2)]);
        let pre = normalize([libraw_get_pre_mul(lr, 0), libraw_get_pre_mul(lr, 1), libraw_get_pre_mul(lr, 2)]);
        let mut m = [[0f32; 3]; 3];
        for (i, row) in m.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v = libraw_get_rgb_cam(lr, i as c_int, j as c_int);
            }
        }
        let ip = &*libraw_get_iparams(lr);
        let o = &*libraw_get_imgother(lr);
        (cam, pre, m, text(&ip.make), text(&ip.model), (o.iso_speed, o.shutter, o.aperture, o.focal_len))
    };
    // A file without as-shot multipliers is developed with the camera's daylight ones.
    let as_shot = if as_shot.iter().all(|&v| (v - 1.0).abs() < 1e-6) { daylight } else { as_shot };
    // SAFETY: as above.
    unsafe {
        check(libraw_unpack(lr), "Couldn't read the RAW file's pixels")?;
        libraw_set_output_color(lr, 0); // the camera's own colours: the matrix is applied here
        libraw_set_output_bps(lr, 16);
        libraw_set_gamma(lr, 0, 1.0);
        libraw_set_gamma(lr, 1, 1.0);
        libraw_set_no_auto_bright(lr, 1);
        libraw_set_highlight(lr, 1); // unclip: scale so no channel clips; recovery is done here
        libraw_set_demosaic(lr, 3); // AHD
        for (i, v) in as_shot.iter().enumerate() {
            libraw_set_user_mul(lr, i as c_int, *v);
        }
        libraw_set_user_mul(lr, 3, as_shot[1]);
        check(libraw_dcraw_process(lr), "Couldn't develop the RAW file")?;
    }
    let (_, width, height, colors, bits, data) = raw.take(false)?;
    if colors != 3 || bits != 16 || data.len() < (width * height * 6) as usize {
        return Err("LibRaw returned a picture Zazabor can't use.".into());
    }
    let cam: Vec<u16> = data.chunks_exact(2).take((width * height * 3) as usize).map(|b| u16::from_ne_bytes([b[0], b[1]])).collect();
    // With "unclip", the channel with the largest multiplier clips first, at 1/(max/its own).
    let top = as_shot.iter().copied().fold(0.0f32, f32::max);
    let clip = as_shot.map(|m| (m / top).min(1.0) * 0.995);
    // Neutral highlights clip where green does (its multiplier is the smallest); that level one
    // stop over white matches the cameras' own previews best (+1 EV, measured on six brands).
    let baseline = 2.0 * top;
    let s = Source {
        path: path.to_path_buf(),
        stamp: stamp(path),
        width,
        height,
        cam,
        clip,
        as_shot,
        daylight,
        rgb_cam,
        baseline,
        make,
        model,
        iso: other.0,
        shutter: other.1,
        aperture: other.2,
        focal: other.3,
    };
    Ok(s)
}

/// The embedded preview (a JPEG most cameras store), for thumbnails and comparing.
pub fn embedded_preview(path: &Path) -> Result<Vec<u8>, String> {
    let raw = Raw::open(path)?;
    // SAFETY: a live, opened handle.
    check(unsafe { libraw_unpack_thumb(raw.0) }, "The RAW file has no preview")?;
    let (kind, _, _, _, _, data) = raw.take(true)?;
    if kind != IMAGE_JPEG {
        return Err("The RAW file's preview isn't a JPEG.".into());
    }
    Ok(data)
}

// ---- developing --------------------------------------------------------------------------------

/// The Develop panel's settings.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Develop {
    /// Kelvin, or None for as shot.
    pub temperature: Option<f32>,
    /// -100 (green) to 100 (magenta), only with a temperature.
    pub tint: f32,
    /// Stops, on top of the automatic baseline.
    pub exposure: f32,
    /// 0–100: how far bright tones are eased into white rather than clipped.
    pub highlights: f32,
    /// -100–100: lifts or deepens the dark tones.
    pub shadows: f32,
    /// "srgb" or "p3".
    pub space: String,
}

impl Default for Develop {
    fn default() -> Self {
        Develop { temperature: None, tint: 0.0, exposure: 0.0, highlights: 50.0, shadows: 0.0, space: "srgb".into() }
    }
}

/// What the page shows about a RAW file.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub width: u32,
    pub height: u32,
    pub make: String,
    pub model: String,
    pub iso: f32,
    pub shutter: f32,
    pub aperture: f32,
    pub focal: f32,
    /// The as-shot white balance as a temperature and tint, roughly.
    pub as_shot_temperature: f32,
    pub as_shot_tint: f32,
}

pub fn info(s: &Source) -> Info {
    let (t, tint) = estimate_temperature(s, s.as_shot);
    Info {
        width: s.width,
        height: s.height,
        make: s.make.clone(),
        model: s.model.clone(),
        iso: s.iso,
        shutter: s.shutter,
        aperture: s.aperture,
        focal: s.focal,
        as_shot_temperature: t,
        as_shot_tint: tint,
    }
}

type M3 = [[f32; 3]; 3];

fn mul(a: &M3, b: &M3) -> M3 {
    let mut out = [[0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

fn apply(m: &M3, v: [f32; 3]) -> [f32; 3] {
    [0, 1, 2].map(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
}

fn invert(m: &M3) -> Option<M3> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-9 {
        return None;
    }
    let c = |r1: usize, c1: usize, r2: usize, c2: usize| m[r1][c1] * m[r2][c2] - m[r1][c2] * m[r2][c1];
    Some([
        [c(1, 1, 2, 2) / det, -c(0, 1, 2, 2) / det, c(0, 1, 1, 2) / det],
        [-c(1, 0, 2, 2) / det, c(0, 0, 2, 2) / det, -c(0, 0, 1, 2) / det],
        [c(1, 0, 2, 1) / det, -c(0, 0, 2, 1) / det, c(0, 0, 1, 1) / det],
    ])
}

/// Linear sRGB → linear Display P3 (both D65).
const SRGB_TO_P3: M3 = [[0.822_462, 0.177_538, 0.0], [0.033_194, 0.966_806, 0.0], [0.017_083, 0.072_397, 0.910_520]];
/// XYZ → linear sRGB (D65).
const XYZ_TO_SRGB: M3 = [[3.240_970, -1.537_383, -0.498_611], [-0.969_244, 1.875_968, 0.041_555], [0.055_630, -0.203_977, 1.056_972]];

/// The chromaticity of a light at `kelvin`: the CIE daylight locus from 4000 K, Planck's below.
fn white_xy(kelvin: f32) -> (f32, f32) {
    let t = kelvin.clamp(1800.0, 25000.0) as f64;
    let x = if t >= 4000.0 {
        let x = if t <= 7000.0 {
            -4.6070e9 / t.powi(3) + 2.9678e6 / t.powi(2) + 0.09911e3 / t + 0.244063
        } else {
            -2.0064e9 / t.powi(3) + 1.9018e6 / t.powi(2) + 0.24748e3 / t + 0.237040
        };
        let y = -3.0 * x * x + 2.87 * x - 0.275;
        return (x as f32, y as f32);
    } else {
        // Kang et al.'s fit of the Planckian locus.
        if t <= 4000.0 {
            -0.2661239e9 / t.powi(3) - 0.2343589e6 / t.powi(2) + 0.8776956e3 / t + 0.179910
        } else {
            -3.0258469e9 / t.powi(3) + 2.1070379e6 / t.powi(2) + 0.2226347e3 / t + 0.240390
        }
    };
    let y = if t <= 2222.0 {
        -1.1063814 * x.powi(3) - 1.34811020 * x * x + 2.18555832 * x - 0.20219683
    } else {
        -0.9549476 * x.powi(3) - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
    };
    (x as f32, y as f32)
}

/// The camera multipliers that make a light of `kelvin` (and `tint`) neutral.
fn multipliers(s: &Source, kelvin: f32, tint: f32) -> [f32; 3] {
    let (x, y) = white_xy(kelvin);
    let xyz = [x / y, 1.0, (1.0 - x - y) / y];
    let srgb = apply(&XYZ_TO_SRGB, xyz);
    // The camera's response to that light, through the inverse of its matrix (which already holds
    // its daylight balance: undo it so the multipliers come out in the as-shot scale).
    let Some(cam_from_rgb) = invert(&s.rgb_cam) else { return s.daylight };
    let cam = apply(&cam_from_rgb, srgb).map(|v| v.max(1e-4));
    let m = normalize([s.daylight[0] / cam[0], s.daylight[1] / cam[1], s.daylight[2] / cam[2]]);
    // Tint: a magenta tint lowers green.
    let g = 1.0 - tint.clamp(-100.0, 100.0) / 300.0;
    normalize([m[0], m[1] * g, m[2]])
}

/// The temperature and tint whose multipliers come closest to `target`.
fn estimate_temperature(s: &Source, target: [f32; 3]) -> (f32, f32) {
    let mut best = (5500.0f32, 0.0f32, f32::MAX);
    let mut k = 2000.0f32;
    while k <= 12000.0 {
        let m = multipliers(s, k, 0.0);
        let d = (m[0].ln() - target[0].ln()).powi(2) + (m[2].ln() - target[2].ln()).powi(2);
        if d < best.2 {
            best = (k, 0.0, d);
        }
        k *= 1.01;
    }
    // Tint from what green is left over, after matching red and blue.
    let m = multipliers(s, best.0, 0.0);
    let ratio = (target[1] / target[0].sqrt() / target[2].sqrt()) / (m[1] / m[0].sqrt() / m[2].sqrt());
    let tint = ((1.0 - ratio) * 300.0).clamp(-100.0, 100.0);
    ((best.0 / 50.0).round() * 50.0, tint.round())
}

/// sRGB's transfer curve (Display P3 uses the same).
fn encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// The developed picture: 8-bit RGBA at `max_dim` at most (0 = full size) and its ICC profile
/// (empty for sRGB).
pub struct Developed {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub icc: Vec<u8>,
}

pub fn develop(s: &Source, d: &Develop, max_dim: u32) -> Developed {
    let mul_now = match d.temperature {
        Some(k) => multipliers(s, k, d.tint),
        None => s.as_shot,
    };
    let wb = [0, 1, 2].map(|c| mul_now[c] / s.as_shot[c]);
    let p3 = d.space == "p3";
    let matrix = if p3 { mul(&SRGB_TO_P3, &s.rgb_cam) } else { s.rgb_cam };
    let gain = s.baseline * 2f32.powf(d.exposure.clamp(-5.0, 5.0));
    let shoulder = (d.highlights.clamp(0.0, 100.0) / 100.0) * 0.6;
    let knee = 1.0 - shoulder;
    let shadows = d.shadows.clamp(-100.0, 100.0) / 100.0;
    // Sizes: every `k`-th row and column when a smaller picture is asked for (Develop previews).
    let k = if max_dim > 0 { s.width.max(s.height).div_ceil(max_dim).max(1) } else { 1 };
    let (w, h) = (s.width.div_ceil(k), s.height.div_ceil(k));
    let tone = build_tone(knee, shadows);
    let clip = s.clip;
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    rgba.par_chunks_mut((w * 4) as usize).enumerate().for_each(|(y, row)| {
        let sy = (y as u32 * k).min(s.height - 1) as usize;
        for x in 0..w as usize {
            let sx = (x as u32 * k).min(s.width - 1) as usize;
            let i = (sy * s.width as usize + sx) * 3;
            let cam = [s.cam[i] as f32 / 65535.0, s.cam[i + 1] as f32 / 65535.0, s.cam[i + 2] as f32 / 65535.0];
            // How close the brightest camera channel is to clipping: clipped channels carry a
            // colour cast (pink skies), so those pixels ease toward neutral.
            let near = (0..3).map(|c| cam[c] / clip[c]).fold(0.0f32, f32::max);
            let mut rgb = apply(&matrix, [cam[0] * wb[0], cam[1] * wb[1], cam[2] * wb[2]]).map(|v| v.max(0.0) * gain);
            if near > 0.9 {
                let t = ((near - 0.9) / 0.1).clamp(0.0, 1.0) * (0.3 + shoulder);
                let l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
                rgb = rgb.map(|v| v + (l - v) * t);
            }
            let out = &mut row[x * 4..x * 4 + 4];
            for c in 0..3 {
                out[c] = tone_lookup(&tone, rgb[c]);
            }
            out[3] = 255;
        }
    });
    Developed { width: w, height: h, rgba, icc: if p3 { display_p3_icc() } else { Vec::new() } }
}

const TONE_STEPS: usize = 4096;
/// Linear light up to this many times white goes through the tone table.
const TONE_RANGE: f32 = 4.0;

/// The tone curve as a table: a soft shoulder from `knee` that eases values up to four times white
/// into white, a gentle toe for the shadows, the transfer curve, then a slight S-curve (camera
/// rendering is a little more contrasty than a plain gamma).
fn build_tone(knee: f32, shadows: f32) -> Vec<u8> {
    (0..TONE_STEPS)
        .map(|i| {
            let v = i as f32 / (TONE_STEPS - 1) as f32 * TONE_RANGE;
            let shouldered = if v <= knee || knee >= 1.0 {
                v.min(1.0)
            } else {
                // From the knee, approach 1 smoothly, reaching it at TONE_RANGE.
                let t = (v - knee) / (TONE_RANGE - knee);
                knee + (1.0 - knee) * (1.0 - (1.0 - t).powi(3))
            };
            let lifted = if shadows >= 0.0 {
                shouldered + shadows * 0.25 * shouldered * (1.0 - shouldered).powi(4) * 4.0
            } else {
                shouldered * (1.0 + shadows * 0.5 * (1.0 - shouldered).powi(3))
            };
            let e = encode(lifted.clamp(0.0, 1.0));
            // A mild S-curve centred on mid grey.
            let s = e + 0.12 * e * (1.0 - e) * (2.0 * e - 1.0) * 2.0;
            (s.clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

fn tone_lookup(table: &[u8], v: f32) -> u8 {
    let i = ((v / TONE_RANGE).clamp(0.0, 1.0) * (TONE_STEPS - 1) as f32) as usize;
    table[i]
}

/// A small ICC v2 profile for Display P3 (the sRGB curve, P3 primaries, D65 adapted to D50).
pub fn display_p3_icc() -> Vec<u8> {
    fn s15(v: f64) -> [u8; 4] {
        ((v * 65536.0).round() as i32).to_be_bytes()
    }
    fn xyz(v: [f64; 3]) -> Vec<u8> {
        let mut t = b"XYZ \0\0\0\0".to_vec();
        for c in v {
            t.extend_from_slice(&s15(c));
        }
        t
    }
    fn desc(text: &str) -> Vec<u8> {
        let mut t = b"desc\0\0\0\0".to_vec();
        t.extend_from_slice(&((text.len() + 1) as u32).to_be_bytes());
        t.extend_from_slice(text.as_bytes());
        t.push(0);
        t.extend_from_slice(&[0u8; 4 + 4 + 2 + 1 + 67]);
        t
    }
    let curve = {
        let mut t = b"curv\0\0\0\0".to_vec();
        let n = 1024u32;
        t.extend_from_slice(&n.to_be_bytes());
        for i in 0..n {
            let e = i as f64 / (n - 1) as f64;
            let lin = if e <= 0.04045 { e / 12.92 } else { ((e + 0.055) / 1.055).powf(2.4) };
            t.extend_from_slice(&((lin * 65535.0).round() as u16).to_be_bytes());
        }
        t
    };
    let mut copyright = b"text\0\0\0\0".to_vec();
    copyright.extend_from_slice(b"No copyright, use freely\0");
    let tags: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"desc", desc("Display P3")),
        (b"cprt", copyright),
        (b"wtpt", xyz([0.964_203, 1.0, 0.824_905])),
        (b"rXYZ", xyz([0.515_102, 0.241_196, -0.001_053])),
        (b"gXYZ", xyz([0.291_965, 0.692_245, 0.041_885])),
        (b"bXYZ", xyz([0.157_153, 0.066_561, 0.784_073])),
        (b"rTRC", curve.clone()),
        (b"gTRC", curve.clone()),
        (b"bTRC", curve),
    ];
    let mut body = Vec::new();
    let mut table = Vec::new();
    let base = 128 + 4 + tags.len() * 12;
    for (sig, data) in &tags {
        while (base + body.len()) % 4 != 0 {
            body.push(0);
        }
        table.extend_from_slice(*sig);
        table.extend_from_slice(&((base + body.len()) as u32).to_be_bytes());
        table.extend_from_slice(&(data.len() as u32).to_be_bytes());
        body.extend_from_slice(data);
    }
    let size = base + body.len();
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&(size as u32).to_be_bytes());
    out.extend_from_slice(b"\0\0\0\0"); // preferred CMM
    out.extend_from_slice(&[2, 0x10, 0, 0]); // version 2.1
    out.extend_from_slice(b"mntrRGB XYZ ");
    out.extend_from_slice(&[0u8; 12]); // date
    out.extend_from_slice(b"acsp");
    out.extend_from_slice(&[0u8; 24]); // platform, flags, manufacturer, model, attributes
    out.extend_from_slice(&0u32.to_be_bytes()); // intent: perceptual
    for v in [0.964_203f64, 1.0, 0.824_905] {
        out.extend_from_slice(&s15(v));
    }
    out.extend_from_slice(&[0u8; 4 + 16 + 28]); // creator, profile id, reserved
    out.extend_from_slice(&(tags.len() as u32).to_be_bytes());
    out.extend_from_slice(&table);
    out.extend_from_slice(&body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_light_follows_the_daylight_and_planckian_loci() {
        let (x, y) = white_xy(6504.0);
        assert!((x - 0.3127).abs() < 0.002 && (y - 0.3290).abs() < 0.002, "D65 is ({x}, {y})");
        let (x, y) = white_xy(2856.0);
        assert!((x - 0.4476).abs() < 0.004 && (y - 0.4074).abs() < 0.004, "illuminant A is ({x}, {y})");
    }

    #[test]
    fn the_matrix_helpers_invert() {
        let m: M3 = [[1.8, -0.7, -0.1], [-0.2, 1.6, -0.4], [0.05, -0.5, 1.45]];
        let i = invert(&m).unwrap();
        let id = mul(&m, &i);
        for (r, row) in id.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                assert!((v - if r == c { 1.0 } else { 0.0 }).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn the_tone_curve_rises_and_keeps_its_ends() {
        let t = build_tone(0.7, 0.0);
        assert_eq!(t[0], 0);
        assert_eq!(*t.last().unwrap(), 255);
        assert!(t.windows(2).all(|w| w[1] >= w[0]));
        // Mid grey in linear light (18%) lands near the middle.
        let mid = tone_lookup(&t, 0.18);
        assert!((100..=140).contains(&mid), "mid grey → {mid}");
    }

    #[test]
    fn the_display_p3_profile_is_well_formed() {
        let icc = display_p3_icc();
        assert_eq!(u32::from_be_bytes(icc[0..4].try_into().unwrap()) as usize, icc.len());
        assert_eq!(&icc[36..40], b"acsp");
        assert_eq!(&icc[12..20], b"mntrRGB ");
        let count = u32::from_be_bytes(icc[128..132].try_into().unwrap()) as usize;
        assert_eq!(count, 9);
        for n in 0..count {
            let e = 132 + n * 12;
            let at = u32::from_be_bytes(icc[e + 4..e + 8].try_into().unwrap()) as usize;
            let len = u32::from_be_bytes(icc[e + 8..e + 12].try_into().unwrap()) as usize;
            assert!(at % 4 == 0 && at + len <= icc.len());
        }
    }

    #[test]
    fn raw_files_are_known_by_extension() {
        assert!(is_raw(Path::new("/x/IMG_0001.CR3")));
        assert!(is_raw(Path::new("a.nef")));
        assert!(!is_raw(Path::new("a.jpg")));
    }

    /// Needs sample RAW files: ZAZABOR_RAW_SAMPLES=<folder> cargo test -- --ignored raw_samples
    #[test]
    #[ignore]
    fn raw_samples_develop_close_to_their_embedded_previews() {
        let Ok(dir) = std::env::var("ZAZABOR_RAW_SAMPLES") else { return };
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if !is_raw(&path) {
                continue;
            }
            let s = source(&path).unwrap();
            let d = develop(&s, &Develop::default(), 512);
            let Ok(jpeg) = embedded_preview(&path) else { continue };
            let preview = image::load_from_memory(&jpeg).unwrap().to_rgb8();
            let preview = image::imageops::resize(&preview, d.width, d.height, image::imageops::FilterType::Triangle);
            let mut sum = [0f64; 3];
            let mut ref_sum = [0f64; 3];
            for (i, p) in preview.pixels().enumerate() {
                for c in 0..3 {
                    sum[c] += d.rgba[i * 4 + c] as f64;
                    ref_sum[c] += p[c] as f64;
                }
            }
            let n = (d.width * d.height) as f64;
            let ours = sum.map(|v| v / n);
            let theirs = ref_sum.map(|v| v / n);
            let lin = |v: f64| (v / 255.0).powf(2.2);
            let need = (0..3).map(|c| lin(theirs[c]) / lin(ours[c]).max(1e-6)).sum::<f64>() / 3.0;
            println!("{}: {} {} ours {:.0?} preview {:.0?} baseline {:.2} sensor-white {:.2} would match at ×{:.2}", path.display(), s.make, s.model, ours, theirs, s.baseline, 1.0 / s.clip[1], need);
            for c in 0..3 {
                assert!((ours[c] - theirs[c]).abs() < 40.0, "{}: channel {c} {} vs {}", path.display(), ours[c], theirs[c]);
            }
            checked += 1;
        }
        assert!(checked >= 3);
    }
}
