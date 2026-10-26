//! Page content: text and pictures added to a page, watermarks, headers and footers with Bates
//! numbers. Everything is placed as the page shows (its rotation applied), so text reads upright
//! on screen whatever the page's /Rotate.

use super::fonts::{self, Face};
use super::{chosen_pages, deref, inherited, num, page_box, page_id, page_rotation, real, sub_dict};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

/// Display space → the page's own space: [a b c d e f] as `cm` takes it, and the size the page
/// shows at (width, height in points). Display space has its origin at the bottom left of the
/// page as it shows, x to the right and y up.
pub(crate) struct Display {
    pub m: [f32; 6],
    pub width: f32,
    pub height: f32,
}

impl Display {
    pub fn of(doc: &Document, page: ObjectId) -> Display {
        let [x0, y0, x1, y1] = page_box(doc, page);
        let r = page_rotation(doc, page);
        let (cos, sin) = match r {
            90 => (0.0, 1.0),
            180 => (-1.0, 0.0),
            270 => (0.0, -1.0),
            _ => (1.0, 0.0),
        };
        let (ox, oy) = match r {
            90 => (x1, y0),
            180 => (x1, y1),
            270 => (x0, y1),
            _ => (x0, y0),
        };
        let (w, h) = if r % 180 == 90 { (y1 - y0, x1 - x0) } else { (x1 - x0, y1 - y0) };
        Display { m: [cos, sin, -sin, cos, ox, oy], width: w, height: h }
    }

    /// A point of the page's own space in display space.
    pub fn from_user(&self, x: f32, y: f32) -> (f32, f32) {
        let [a, b, c, d, e, f] = self.m;
        let (ux, uy) = (x - e, y - f);
        (ux * a + uy * b, ux * c + uy * d)
    }

    pub fn cm(&self) -> String {
        format!("{} cm", self.m.map(num).join(" "))
    }
}

/// The page's resources, as a dictionary of its own to change (inherited or shared ones copied).
pub(crate) fn own_resources(doc: &Document, page: ObjectId) -> Dictionary {
    inherited(doc, page, b"Resources").map(|o| deref(doc, o)).and_then(|o| o.as_dict().ok()).cloned().unwrap_or_default()
}

/// Adds `value` to a category of `res` (Font, XObject, ExtGState) under a new name; returns it.
pub(crate) fn add_resource(doc: &Document, res: &mut Dictionary, category: &str, prefix: &str, value: Object) -> String {
    let mut cat = sub_dict(doc, res, category.as_bytes());
    let mut n = 1;
    let name = loop {
        let name = format!("{prefix}{n}");
        if !cat.has(name.as_bytes()) {
            break name;
        }
        n += 1;
    };
    cat.set(name.clone(), value);
    res.set(category, Object::Dictionary(cat));
    name
}

pub(crate) fn set_resources(doc: &mut Document, page: ObjectId, res: Dictionary) -> Result<(), String> {
    doc.get_dictionary_mut(page).map_err(|e| e.to_string())?.set("Resources", Object::Dictionary(res));
    Ok(())
}

fn content_stream(doc: &mut Document, content: Vec<u8>) -> ObjectId {
    let mut s = Stream::new(Dictionary::new(), content);
    let _ = s.compress();
    doc.add_object(Object::Stream(s))
}

/// Adds `content` to the page, over what's there (or under it, `behind`). The page's own content
/// is wrapped in q/Q first, so a graphics state it leaves changed can't move the new content.
pub(crate) fn append_content(doc: &mut Document, page: ObjectId, content: Vec<u8>, behind: bool) -> Result<(), String> {
    let old: Vec<Object> = match doc.get_dictionary(page).map_err(|e| e.to_string())?.get(b"Contents") {
        Ok(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![Object::Reference(*id)],
        },
        Ok(Object::Array(a)) => a.clone(),
        _ => vec![],
    };
    let new = Object::Reference(content_stream(doc, content));
    let list = if behind {
        let mut l = vec![new];
        l.extend(old);
        l
    } else {
        let q = Object::Reference(content_stream(doc, b"q\n".to_vec()));
        let end = Object::Reference(content_stream(doc, b"\nQ\n".to_vec()));
        let mut l = vec![q];
        l.extend(old);
        l.push(end);
        l.push(new);
        l
    };
    doc.get_dictionary_mut(page).map_err(|e| e.to_string())?.set("Contents", Object::Array(list));
    Ok(())
}

/// An opacity setting for `gs`.
fn opacity_state(doc: &mut Document, opacity: f32) -> ObjectId {
    let mut d = Dictionary::new();
    d.set("Type", "ExtGState");
    d.set("CA", real(opacity.clamp(0.0, 1.0)));
    d.set("ca", real(opacity.clamp(0.0, 1.0)));
    doc.add_object(Object::Dictionary(d))
}

fn rgb(c: [f32; 3]) -> String {
    format!("{} {} {}", num(c[0].clamp(0.0, 1.0)), num(c[1].clamp(0.0, 1.0)), num(c[2].clamp(0.0, 1.0)))
}

// ---- pictures

/// A picture as an image XObject: a JPEG as it is (grey or colour), anything else as RGB with an
/// alpha mask when it has transparency. Returns its id and its size in pixels.
pub(crate) fn image_xobject(doc: &mut Document, bytes: &[u8]) -> Result<(ObjectId, u32, u32), String> {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut decoder = jpeg_decoder::Decoder::new(bytes);
        if decoder.read_info().is_ok() {
            if let Some(info) = decoder.info() {
                let space = match info.pixel_format {
                    jpeg_decoder::PixelFormat::L8 => Some("DeviceGray"),
                    jpeg_decoder::PixelFormat::RGB24 => Some("DeviceRGB"),
                    _ => None,
                };
                if let Some(space) = space {
                    let mut d = Dictionary::new();
                    d.set("Type", "XObject");
                    d.set("Subtype", "Image");
                    d.set("Width", info.width as i64);
                    d.set("Height", info.height as i64);
                    d.set("ColorSpace", space);
                    d.set("BitsPerComponent", 8);
                    d.set("Filter", "DCTDecode");
                    let s = Stream::new(d, bytes.to_vec()).with_compression(false);
                    return Ok((doc.add_object(Object::Stream(s)), info.width as u32, info.height as u32));
                }
            }
        }
    }
    let img = image::load_from_memory(bytes).map_err(|e| format!("The picture couldn't be read: {e}"))?.to_rgba8();
    let (w, h) = img.dimensions();
    Ok((raster_xobject(doc, &img), w, h))
}

/// RGBA pixels as an RGB image with a soft mask when any pixel isn't opaque.
pub(crate) fn raster_xobject(doc: &mut Document, img: &image::RgbaImage) -> ObjectId {
    let (w, h) = img.dimensions();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    let mut alpha = Vec::with_capacity((w * h) as usize);
    for p in img.pixels() {
        rgb.extend_from_slice(&p.0[..3]);
        alpha.push(p.0[3]);
    }
    let mut d = Dictionary::new();
    d.set("Type", "XObject");
    d.set("Subtype", "Image");
    d.set("Width", w as i64);
    d.set("Height", h as i64);
    d.set("ColorSpace", "DeviceRGB");
    d.set("BitsPerComponent", 8);
    if alpha.iter().any(|&a| a < 255) {
        let mut m = Dictionary::new();
        m.set("Type", "XObject");
        m.set("Subtype", "Image");
        m.set("Width", w as i64);
        m.set("Height", h as i64);
        m.set("ColorSpace", "DeviceGray");
        m.set("BitsPerComponent", 8);
        let mut ms = Stream::new(m, alpha);
        let _ = ms.compress();
        d.set("SMask", Object::Reference(doc.add_object(Object::Stream(ms))));
    }
    let mut s = Stream::new(d, rgb);
    let _ = s.compress();
    doc.add_object(Object::Stream(s))
}

// ---- text and pictures on a page

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSpec {
    pub page: u32,
    /// The top left of the text, in the page's own space.
    pub x: f32,
    pub y: f32,
    pub text: String,
    #[serde(default = "twelve")]
    pub size: f32,
    #[serde(default)]
    pub face: Face,
    #[serde(default)]
    pub color: [f32; 3],
}

fn twelve() -> f32 {
    12.0
}

pub fn add_text(doc: &mut Document, spec: &TextSpec) -> Result<(), String> {
    let page = page_id(doc, spec.page)?;
    let lines = spec.text.lines().map(|l| fonts::win_ansi(l).map_err(fonts::unsupported)).collect::<Result<Vec<_>, _>>()?;
    if lines.iter().all(|l| l.is_empty()) {
        return Ok(());
    }
    let size = spec.size.clamp(2.0, 400.0);
    let display = Display::of(doc, page);
    let (dx, dy) = display.from_user(spec.x, spec.y);
    let mut res = own_resources(doc, page);
    let font = add_resource(doc, &mut res, "Font", "CPF", spec.face.dict());
    let mut c = format!("q {} BT /{font} {} Tf {} rg {} TL {} {} Td", display.cm(), num(size), rgb(spec.color), num(size * 1.2), num(dx), num(dy - size * 0.8));
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            c.push_str(" T*");
        }
        c.push_str(&format!(" {} Tj", fonts::hex(line)));
    }
    c.push_str(" ET Q");
    set_resources(doc, page, res)?;
    append_content(doc, page, c.into_bytes(), false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSpec {
    pub page: u32,
    /// The picture's centre, in the page's own space.
    pub x: f32,
    pub y: f32,
    /// Its size as the page shows it, in points.
    pub width: f32,
    pub height: f32,
    pub blob: usize,
}

pub fn add_image(doc: &mut Document, spec: &ImageSpec, bytes: &[u8]) -> Result<(), String> {
    let page = page_id(doc, spec.page)?;
    let (image, _, _) = image_xobject(doc, bytes)?;
    let display = Display::of(doc, page);
    let (dx, dy) = display.from_user(spec.x, spec.y);
    let mut res = own_resources(doc, page);
    let name = add_resource(doc, &mut res, "XObject", "CPImg", Object::Reference(image));
    let (w, h) = (spec.width.max(1.0), spec.height.max(1.0));
    let c = format!("q {} {} 0 0 {} {} {} cm /{name} Do Q", display.cm(), num(w), num(h), num(dx - w / 2.0), num(dy - h / 2.0));
    set_resources(doc, page, res)?;
    append_content(doc, page, c.into_bytes(), false)
}

// ---- watermarks

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkSpec {
    /// Pages from 1; all when empty.
    #[serde(default)]
    pub pages: Vec<u32>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub face: Face,
    #[serde(default = "seventy_two")]
    pub size: f32,
    #[serde(default)]
    pub color: [f32; 3],
    #[serde(default = "a_third")]
    pub opacity: f32,
    /// Degrees, counterclockwise as the page shows.
    #[serde(default)]
    pub rotation: f32,
    /// A picture instead of text.
    #[serde(default)]
    pub blob: Option<usize>,
    /// A picture's width as a share of the page's.
    #[serde(default = "half")]
    pub scale: f32,
    #[serde(default)]
    pub behind: bool,
}

fn seventy_two() -> f32 {
    72.0
}
fn a_third() -> f32 {
    0.3
}
fn half() -> f32 {
    0.5
}

pub fn watermark(doc: &mut Document, spec: &WatermarkSpec, picture: Option<&[u8]>) -> Result<(), String> {
    let text = match &spec.text {
        Some(t) if picture.is_none() => {
            let t = t.trim();
            if t.is_empty() {
                return Err("The watermark has no text.".into());
            }
            Some(fonts::win_ansi(t).map_err(fonts::unsupported)?)
        }
        _ => None,
    };
    let image = match picture {
        Some(bytes) => Some(image_xobject(doc, bytes)?),
        None => None,
    };
    if text.is_none() && image.is_none() {
        return Err("The watermark has no text or picture.".into());
    }
    let gs = opacity_state(doc, spec.opacity);
    let (sin, cos) = spec.rotation.to_radians().sin_cos();
    for (_, page) in chosen_pages(doc, &spec.pages) {
        let display = Display::of(doc, page);
        let mut res = own_resources(doc, page);
        let gs_name = add_resource(doc, &mut res, "ExtGState", "CPGS", Object::Reference(gs));
        let mut c = format!(
            "/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q /{gs_name} gs {} 1 0 0 1 {} {} cm {} {} {} {} 0 0 cm ",
            display.cm(), num(display.width / 2.0), num(display.height / 2.0), num(cos), num(sin), num(-sin), num(cos)
        );
        if let Some(bytes) = &text {
            let font = add_resource(doc, &mut res, "Font", "CPF", spec.face.dict());
            let size = spec.size.clamp(4.0, 600.0);
            let w = spec.face.width(bytes, size);
            c.push_str(&format!("BT /{font} {} Tf {} rg {} {} Td {} Tj ET", num(size), rgb(spec.color), num(-w / 2.0), num(-size * 0.35), fonts::hex(bytes)));
        } else if let Some((id, pw, ph)) = image {
            let name = add_resource(doc, &mut res, "XObject", "CPImg", Object::Reference(id));
            let w = display.width * spec.scale.clamp(0.02, 2.0);
            let h = w * ph as f32 / pw.max(1) as f32;
            c.push_str(&format!("{} 0 0 {} {} {} cm /{name} Do", num(w), num(h), num(-w / 2.0), num(-h / 2.0)));
        }
        c.push_str(" Q EMC");
        set_resources(doc, page, res)?;
        append_content(doc, page, c.into_bytes(), spec.behind)?;
    }
    Ok(())
}

// ---- headers, footers and Bates numbers

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bates {
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    #[serde(default = "one")]
    pub start: u64,
    #[serde(default = "six")]
    pub digits: usize,
}

fn one() -> u64 {
    1
}
fn six() -> usize {
    6
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFooterSpec {
    #[serde(default)]
    pub pages: Vec<u32>,
    /// Header left, centre and right, then footer left, centre and right. They may hold {page},
    /// {pages}, {date}, {file} and {bates}.
    pub slots: [String; 6],
    #[serde(default)]
    pub face: Face,
    #[serde(default = "ten")]
    pub size: f32,
    #[serde(default)]
    pub color: [f32; 3],
    /// From the page's edges, in points.
    #[serde(default = "thirty_six")]
    pub margin: f32,
    #[serde(default)]
    pub bates: Option<Bates>,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub file: String,
}

fn ten() -> f32 {
    10.0
}
fn thirty_six() -> f32 {
    36.0
}

pub fn bates_number(b: &Bates, index: u64) -> String {
    format!("{}{:0width$}{}", b.prefix, b.start + index, b.suffix, width = b.digits.min(20))
}

pub fn header_footer(doc: &mut Document, spec: &HeaderFooterSpec) -> Result<(), String> {
    if spec.slots.iter().all(|s| s.trim().is_empty()) {
        return Err("The header and footer are empty.".into());
    }
    let total = doc.get_pages().len();
    let size = spec.size.clamp(4.0, 72.0);
    for (k, (number, page)) in chosen_pages(doc, &spec.pages).into_iter().enumerate() {
        let bates = spec.bates.as_ref().map(|b| bates_number(b, k as u64)).unwrap_or_default();
        let fill = |s: &str| {
            s.replace("{page}", &number.to_string())
                .replace("{pages}", &total.to_string())
                .replace("{date}", &spec.date)
                .replace("{file}", &spec.file)
                .replace("{bates}", &bates)
        };
        let display = Display::of(doc, page);
        let mut res = own_resources(doc, page);
        let font = add_resource(doc, &mut res, "Font", "CPF", spec.face.dict());
        let mut c = format!("/Artifact <</Type /Pagination>> BDC q {} BT /{font} {} Tf {} rg", display.cm(), num(size), rgb(spec.color));
        let mut any = false;
        for (i, slot) in spec.slots.iter().enumerate() {
            let text = fill(slot);
            if text.trim().is_empty() {
                continue;
            }
            let bytes = fonts::win_ansi(&text).map_err(fonts::unsupported)?;
            let w = spec.face.width(&bytes, size);
            let m = spec.margin.max(0.0);
            let x = match i % 3 {
                0 => m,
                1 => (display.width - w) / 2.0,
                _ => display.width - m - w,
            };
            let y = if i < 3 { display.height - m - size * 0.75 } else { m };
            c.push_str(&format!(" 1 0 0 1 {} {} Tm {} Tj", num(x), num(y), fonts::hex(&bytes)));
            any = true;
        }
        c.push_str(" ET Q EMC");
        if any {
            set_resources(doc, page, res)?;
            append_content(doc, page, c.into_bytes(), false)?;
        }
    }
    Ok(())
}
