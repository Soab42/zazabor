//! PDFium (BSD-3-Clause, Chrome's PDF engine) for what lopdf can't do well: true redaction
//! (`redact.rs`) and editing existing text (`textedit.rs`), docs/plans/pdf.md §4.5–4.6.
//!
//! The library isn't linked. libpdfium.so is loaded the first time a tool needs it, from (in
//! order) `ZAZABOR_PDFIUM` (the file, or the folder it's in), `<exe dir>/../lib/zazabor/` (where
//! scripts/install-linux.sh puts it beside ~/.local/bin/zazabor), then `pdfium/lib/` in src-tauri,
//! found by walking up from the executable (dev builds and tests; scripts/fetch-pdfium.sh fetches
//! it there). Without it the PDFium tools say why, and the rest (lopdf, rasterised redaction)
//! works as before. A failed load isn't remembered, so installing it needs no restart.
//!
//! PDFium isn't thread-safe: everything runs inside `session`, one at a time.

use pdfium_render::prelude::{
    Pdfium, PdfiumLibraryBindings, FPDF_BITMAP, FPDF_DOCUMENT, FPDF_FILEWRITE, FPDF_FONT, FPDF_PAGE, FPDF_PAGEOBJECT, FPDF_TEXTPAGE, FPDF_WCHAR, FS_MATRIX, FS_RECTF,
};
use std::ffi::{c_int, c_uint, c_ulong, c_void};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) const TEXT: c_int = 1;
pub(crate) const PATH: c_int = 2;
pub(crate) const IMAGE: c_int = 3;
pub(crate) const SHADING: c_int = 4;
pub(crate) const FORM: c_int = 5;

struct Library {
    raw: Box<dyn PdfiumLibraryBindings>,
    lock: Mutex<()>,
}

// The bindings are only used inside `session`, under `lock` (and pdfium-render's own lock).
unsafe impl Send for Library {}
unsafe impl Sync for Library {}

static LOADED: Mutex<Option<&'static Library>> = Mutex::new(None);

const NAME: &str = "libpdfium.so";

/// Where libpdfium.so is looked for, in order. An installed Zazabor only loads the copy the
/// installer put beside it; `ZAZABOR_PDFIUM` and the checkout's `src-tauri/pdfium/` (found by
/// walking up from the program) are for development builds and tests only.
pub(crate) fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(debug_assertions) {
        if let Some(v) = std::env::var_os("ZAZABOR_PDFIUM").filter(|v| !v.is_empty()) {
            let p = PathBuf::from(v);
            out.push(if p.is_dir() { p.join(NAME) } else { p });
        }
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.canonicalize().ok()).and_then(|e| e.parent().map(PathBuf::from)) {
        out.push(dir.join("../lib/zazabor").join(NAME));
        if cfg!(debug_assertions) {
            for up in dir.ancestors() {
                out.push(up.join("pdfium/lib").join(NAME));
                out.push(up.join("src-tauri/pdfium/lib").join(NAME));
            }
        }
    }
    out
}

/// A library is only loaded when nobody else could have put it there: the file and every folder
/// above it belong to this user or to root, none is writable by others, and any group-writable
/// one belongs to this user's own group (Ubuntu gives each user a group of their own).
fn trusted(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(real) = path.canonicalize() else { return false };
    // SAFETY: getuid and getgid have no preconditions.
    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
    real.ancestors().all(|p| {
        std::fs::metadata(p).is_ok_and(|m| {
            (m.uid() == uid || m.uid() == 0) && m.mode() & 0o002 == 0 && (m.mode() & 0o020 == 0 || m.gid() == gid)
        })
    })
}

/// The loaded library, loading it the first time.
fn library() -> Result<&'static Library, String> {
    let mut slot = LOADED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(lib) = *slot {
        return Ok(lib);
    }
    let path = candidates().into_iter().find(|p| p.is_file() && trusted(p)).ok_or_else(|| {
        "PDFium isn't installed, so this tool can't run. Reinstall Zazabor with scripts/install-linux.sh (or run scripts/fetch-pdfium.sh in a dev checkout).".to_string()
    })?;
    let raw = Pdfium::bind_to_library(&path).map_err(|e| format!("PDFium ({}) couldn't be loaded: {e}", path.display()))?;
    unsafe { raw.FPDF_InitLibrary() };
    let lib: &'static Library = Box::leak(Box::new(Library { raw, lock: Mutex::new(()) }));
    *slot = Some(lib);
    Ok(lib)
}

/// Whether PDFium can be loaded: `Ok(path)` or why not.
pub(crate) fn status() -> Result<PathBuf, String> {
    library()?;
    Ok(candidates().into_iter().find(|p| p.is_file()).unwrap_or_default())
}

/// Runs `f` with PDFium, alone.
pub(crate) fn session<T>(f: impl FnOnce(Api) -> Result<T, String>) -> Result<T, String> {
    let lib = library()?;
    let _alone = lib.lock.lock().unwrap_or_else(|e| e.into_inner());
    f(Api { b: lib.raw.as_ref() })
}

/// The raw functions, with small safe helpers. Handles are only valid inside the session.
#[derive(Clone, Copy)]
pub(crate) struct Api<'a> {
    pub b: &'a dyn PdfiumLibraryBindings,
}

pub(crate) struct Doc<'a> {
    pub api: Api<'a>,
    pub handle: FPDF_DOCUMENT,
    _bytes: Vec<u8>,
}

impl<'a> Doc<'a> {
    pub fn load(api: Api<'a>, bytes: Vec<u8>) -> Result<Self, String> {
        Self::open(api, bytes, None)
    }

    pub fn open(api: Api<'a>, bytes: Vec<u8>, password: Option<&str>) -> Result<Self, String> {
        // PDFium reads from the buffer while the document is open: it lives in the Doc.
        let handle = unsafe { api.b.FPDF_LoadMemDocument64(&bytes, password) };
        if handle.is_null() {
            let code = unsafe { api.b.FPDF_GetLastError() };
            return Err(match code {
                4 => "PDFium needs the file's password.".into(),
                _ => format!("PDFium couldn't read the file (error {code})."),
            });
        }
        Ok(Doc { api, handle, _bytes: bytes })
    }

    pub fn page_count(&self) -> usize {
        unsafe { self.api.b.FPDF_GetPageCount(self.handle) }.max(0) as usize
    }

    /// Page `index` (from 0).
    pub fn page(&self, index: usize) -> Result<Page<'_>, String> {
        if index >= self.page_count() {
            return Err(format!("There's no page {}.", index + 1));
        }
        let handle = unsafe { self.api.b.FPDF_LoadPage(self.handle, index as c_int) };
        if handle.is_null() {
            return Err(format!("PDFium couldn't read page {}.", index + 1));
        }
        Ok(Page { doc: self, handle })
    }

    /// The whole file written anew (not an incremental update).
    pub fn save(&self) -> Result<Vec<u8>, String> {
        #[repr(C)]
        struct Sink {
            api: FPDF_FILEWRITE,
            out: Vec<u8>,
        }
        unsafe extern "C" fn write_block(this: *mut FPDF_FILEWRITE, data: *const c_void, size: c_ulong) -> c_int {
            // `this` is the first field of a Sink.
            let sink = unsafe { &mut *(this as *mut Sink) };
            if size > 0 && !data.is_null() {
                sink.out.extend_from_slice(unsafe { std::slice::from_raw_parts(data as *const u8, size as usize) });
            }
            1
        }
        let mut sink = Sink { api: FPDF_FILEWRITE { version: 1, WriteBlock: Some(write_block) }, out: Vec::new() };
        const NO_INCREMENTAL: c_ulong = 2;
        let ok = unsafe { self.api.b.FPDF_SaveAsCopy(self.handle, &mut sink.api, NO_INCREMENTAL as _) };
        if ok == 0 || sink.out.is_empty() {
            return Err("PDFium couldn't write the file.".into());
        }
        Ok(sink.out)
    }

    pub fn standard_font(&self, name: &str) -> FPDF_FONT {
        unsafe { self.api.b.FPDFText_LoadStandardFont(self.handle, name) }
    }
}

impl Drop for Doc<'_> {
    fn drop(&mut self) {
        unsafe { self.api.b.FPDF_CloseDocument(self.handle) };
    }
}

pub(crate) struct Page<'d> {
    pub doc: &'d Doc<'d>,
    pub handle: FPDF_PAGE,
}

impl<'d> Page<'d> {
    fn b(&self) -> &'d dyn PdfiumLibraryBindings {
        self.doc.api.b
    }

    pub fn objects(&self) -> Vec<FPDF_PAGEOBJECT> {
        let n = unsafe { self.b().FPDFPage_CountObjects(self.handle) }.max(0);
        (0..n).map(|i| unsafe { self.b().FPDFPage_GetObject(self.handle, i) }).filter(|o| !o.is_null()).collect()
    }

    pub fn index_of(&self, obj: FPDF_PAGEOBJECT) -> Option<usize> {
        self.objects().iter().position(|&o| o == obj)
    }

    /// Puts `obj` (which the page now owns) at `index`.
    pub fn insert(&self, obj: FPDF_PAGEOBJECT, index: usize) -> Result<(), String> {
        if unsafe { self.b().FPDFPage_InsertObjectAtIndex(self.handle, obj, index) } == 0 {
            unsafe { self.b().FPDFPageObj_Destroy(obj) };
            return Err("PDFium couldn't add to the page.".into());
        }
        Ok(())
    }

    /// Takes `obj` off the page and frees it.
    pub fn remove(&self, obj: FPDF_PAGEOBJECT) {
        if unsafe { self.b().FPDFPage_RemoveObject(self.handle, obj) } != 0 {
            unsafe { self.b().FPDFPageObj_Destroy(obj) };
        }
    }

    pub fn text(&self) -> Result<TextPage<'d>, String> {
        let handle = unsafe { self.b().FPDFText_LoadPage(self.handle) };
        if handle.is_null() {
            return Err("PDFium couldn't read the page's text.".into());
        }
        Ok(TextPage { b: self.b(), handle })
    }

    /// Writes the page's objects back into its content.
    pub fn generate(&self) -> Result<(), String> {
        if unsafe { self.b().FPDFPage_GenerateContent(self.handle) } == 0 {
            return Err("PDFium couldn't write the page.".into());
        }
        Ok(())
    }
}

impl Drop for Page<'_> {
    fn drop(&mut self) {
        unsafe { self.b().FPDF_ClosePage(self.handle) };
    }
}

pub(crate) struct TextPage<'d> {
    b: &'d dyn PdfiumLibraryBindings,
    pub handle: FPDF_TEXTPAGE,
}

impl TextPage<'_> {
    pub fn count(&self) -> usize {
        unsafe { self.b.FPDFText_CountChars(self.handle) }.max(0) as usize
    }

    pub fn unicode(&self, i: usize) -> char {
        char::from_u32(unsafe { self.b.FPDFText_GetUnicode(self.handle, i as c_int) }).unwrap_or('\u{fffd}')
    }

    /// The text object a character comes from (null for spaces and line ends PDFium adds).
    pub fn object(&self, i: usize) -> FPDF_PAGEOBJECT {
        unsafe { self.b.FPDFText_GetTextObject(self.handle, i as c_int) }
    }

    /// The character's box (left, bottom, right, top), as tall as the font.
    pub fn char_box(&self, i: usize) -> Option<[f32; 4]> {
        let mut r = FS_RECTF { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
        (unsafe { self.b.FPDFText_GetLooseCharBox(self.handle, i as c_int, &mut r) } != 0).then(|| [r.left.min(r.right), r.bottom.min(r.top), r.left.max(r.right), r.bottom.max(r.top)])
    }

    pub fn origin(&self, i: usize) -> Option<(f32, f32)> {
        let (mut x, mut y) = (0.0, 0.0);
        (unsafe { self.b.FPDFText_GetCharOrigin(self.handle, i as c_int, &mut x, &mut y) } != 0).then_some((x as f32, y as f32))
    }

    /// A text object's text.
    pub fn object_text(&self, obj: FPDF_PAGEOBJECT) -> String {
        let bytes = unsafe { self.b.FPDFTextObj_GetText(obj, self.handle, std::ptr::null_mut(), 0) } as usize;
        if bytes < 2 {
            return String::new();
        }
        let mut buf: Vec<FPDF_WCHAR> = vec![0; bytes / 2];
        unsafe { self.b.FPDFTextObj_GetText(obj, self.handle, buf.as_mut_ptr(), bytes as c_ulong) };
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }
}

impl Drop for TextPage<'_> {
    fn drop(&mut self) {
        unsafe { self.b.FPDFText_ClosePage(self.handle) };
    }
}

// ---- object helpers

impl Api<'_> {
    pub fn kind(&self, obj: FPDF_PAGEOBJECT) -> c_int {
        unsafe { self.b.FPDFPageObj_GetType(obj) }
    }

    /// left, bottom, right, top on the page.
    pub fn bounds(&self, obj: FPDF_PAGEOBJECT) -> Option<[f32; 4]> {
        let (mut l, mut b, mut r, mut t) = (0.0, 0.0, 0.0, 0.0);
        (unsafe { self.b.FPDFPageObj_GetBounds(obj, &mut l, &mut b, &mut r, &mut t) } != 0).then_some([l, b, r, t])
    }

    pub fn matrix(&self, obj: FPDF_PAGEOBJECT) -> FS_MATRIX {
        let mut m = FS_MATRIX { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
        unsafe { self.b.FPDFPageObj_GetMatrix(obj, &mut m) };
        m
    }

    pub fn set_matrix(&self, obj: FPDF_PAGEOBJECT, m: &FS_MATRIX) {
        unsafe { self.b.FPDFPageObj_SetMatrix(obj, m) };
    }

    pub fn font(&self, obj: FPDF_PAGEOBJECT) -> FPDF_FONT {
        unsafe { self.b.FPDFTextObj_GetFont(obj) }
    }

    pub fn font_size(&self, obj: FPDF_PAGEOBJECT) -> f32 {
        let mut s = 0.0;
        unsafe { self.b.FPDFTextObj_GetFontSize(obj, &mut s) };
        s
    }

    pub fn font_name(&self, font: FPDF_FONT) -> String {
        if font.is_null() {
            return String::new();
        }
        let mut buf = vec![0u8; 256];
        let n = unsafe { self.b.FPDFFont_GetBaseFontName(font, buf.as_mut_ptr() as *mut _, buf.len()) };
        let end = buf.iter().position(|&c| c == 0).unwrap_or((n as usize).min(buf.len()));
        let name = String::from_utf8_lossy(&buf[..end]).into_owned();
        // A subset's name starts with six capitals and a plus sign.
        match name.split_once('+') {
            Some((tag, rest)) if tag.len() == 6 && tag.bytes().all(|c| c.is_ascii_uppercase()) => rest.to_string(),
            _ => name,
        }
    }

    pub fn font_weight(&self, font: FPDF_FONT) -> i32 {
        if font.is_null() { 400 } else { unsafe { self.b.FPDFFont_GetWeight(font) } }
    }

    /// Whether `font` draws `c` (has an outline for it). Spaces have none, so aren't asked about.
    pub fn has_glyph(&self, font: FPDF_FONT, c: char, size: f32) -> bool {
        let path = unsafe { self.b.FPDFFont_GetGlyphPath(font, c as c_uint, size.max(1.0)) };
        !path.is_null() && unsafe { self.b.FPDFGlyphPath_CountGlyphSegments(path) } > 0
    }

    /// A new text object in `font`, with `text`, placed by `m`, painted like `like` (colours, fill
    /// or stroke or invisible). Null when PDFium refuses.
    pub fn new_text(&self, doc: &Doc, font: FPDF_FONT, size: f32, text: &str, m: &FS_MATRIX, like: FPDF_PAGEOBJECT) -> FPDF_PAGEOBJECT {
        let obj = unsafe { self.b.FPDFPageObj_CreateTextObj(doc.handle, font, size) };
        if obj.is_null() {
            return obj;
        }
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        if unsafe { self.b.FPDFText_SetText(obj, wide.as_ptr()) } == 0 {
            unsafe { self.b.FPDFPageObj_Destroy(obj) };
            return std::ptr::null_mut();
        }
        self.set_matrix(obj, m);
        self.paint_like(obj, like);
        obj
    }

    /// Copies `from`'s fill and stroke colours, stroke width and text render mode to `to`.
    pub fn paint_like(&self, to: FPDF_PAGEOBJECT, from: FPDF_PAGEOBJECT) {
        let (mut r, mut g, mut b, mut a) = (0, 0, 0, 255);
        unsafe {
            if self.b.FPDFPageObj_GetFillColor(from, &mut r, &mut g, &mut b, &mut a) != 0 {
                self.b.FPDFPageObj_SetFillColor(to, r, g, b, a);
            }
            if self.b.FPDFPageObj_GetStrokeColor(from, &mut r, &mut g, &mut b, &mut a) != 0 {
                self.b.FPDFPageObj_SetStrokeColor(to, r, g, b, a);
            }
            let mut w = 0.0;
            if self.b.FPDFPageObj_GetStrokeWidth(from, &mut w) != 0 {
                self.b.FPDFPageObj_SetStrokeWidth(to, w);
            }
            if self.kind(from) == TEXT {
                self.b.FPDFTextObj_SetTextRenderMode(to, self.b.FPDFTextObj_GetTextRenderMode(from));
            }
        }
    }

    /// A black filled rectangle.
    pub fn black_box(&self, r: [f32; 4]) -> FPDF_PAGEOBJECT {
        let obj = unsafe { self.b.FPDFPageObj_CreateNewRect(r[0], r[1], r[2] - r[0], r[3] - r[1]) };
        if !obj.is_null() {
            unsafe {
                self.b.FPDFPageObj_SetFillColor(obj, 0, 0, 0, 255);
                const ALTERNATE: c_int = 1;
                self.b.FPDFPath_SetDrawMode(obj, ALTERNATE, 0);
            }
        }
        obj
    }

    pub fn bitmap(&self, image: FPDF_PAGEOBJECT) -> Option<Bitmap<'_>> {
        let handle = unsafe { self.b.FPDFImageObj_GetBitmap(image) };
        (!handle.is_null()).then_some(Bitmap { b: self.b, handle })
    }
}

/// A bitmap PDFium made; freed when dropped.
pub(crate) struct Bitmap<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    pub handle: FPDF_BITMAP,
}

impl Bitmap<'_> {
    /// Width, height, bytes per row and bytes per pixel.
    pub fn layout(&self) -> (usize, usize, usize, usize) {
        let b = self.b;
        let h = self.handle;
        let bpp = match unsafe { b.FPDFBitmap_GetFormat(h) } {
            1 => 1,
            2 => 3,
            _ => 4,
        };
        unsafe { (b.FPDFBitmap_GetWidth(h).max(0) as usize, b.FPDFBitmap_GetHeight(h).max(0) as usize, b.FPDFBitmap_GetStride(h).max(0) as usize, bpp) }
    }

    pub fn pixels(&mut self) -> &mut [u8] {
        let (_, h, stride, _) = self.layout();
        let ptr = unsafe { self.b.FPDFBitmap_GetBuffer(self.handle) } as *mut u8;
        if ptr.is_null() {
            return &mut [];
        }
        unsafe { std::slice::from_raw_parts_mut(ptr, stride * h) }
    }
}

impl Drop for Bitmap<'_> {
    fn drop(&mut self) {
        unsafe { self.b.FPDFBitmap_Destroy(self.handle) };
    }
}

// ---- geometry

pub(crate) fn invert(m: &FS_MATRIX) -> Option<FS_MATRIX> {
    let det = m.a * m.d - m.b * m.c;
    if det.abs() < 1e-9 {
        return None;
    }
    let (a, b, c, d) = (m.d / det, -m.b / det, -m.c / det, m.a / det);
    Some(FS_MATRIX { a, b, c, d, e: -(m.e * a + m.f * c), f: -(m.e * b + m.f * d) })
}

pub(crate) fn apply(m: &FS_MATRIX, x: f32, y: f32) -> (f32, f32) {
    (m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f)
}

/// `[x0, y0, x1, y1]` in any order, as left, bottom, right, top.
pub(crate) fn normal(r: [f32; 4]) -> [f32; 4] {
    [r[0].min(r[2]), r[1].min(r[3]), r[0].max(r[2]), r[1].max(r[3])]
}

pub(crate) fn overlap(a: [f32; 4], b: [f32; 4]) -> f32 {
    let w = a[2].min(b[2]) - a[0].max(b[0]);
    let h = a[3].min(b[3]) - a[1].max(b[1]);
    if w <= 0.0 || h <= 0.0 { 0.0 } else { w * h }
}

pub(crate) fn area(r: [f32; 4]) -> f32 {
    (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0)
}

/// Whether `inner` lies within `outer` (give or take `slack` points).
pub(crate) fn inside(inner: [f32; 4], outer: [f32; 4], slack: f32) -> bool {
    inner[0] >= outer[0] - slack && inner[1] >= outer[1] - slack && inner[2] <= outer[2] + slack && inner[3] <= outer[3] + slack
}

#[cfg(test)]
mod trust_tests {
    use super::trusted;

    #[test]
    fn a_library_under_a_world_writable_folder_is_refused() {
        // /tmp is world-writable (anyone could have put a library there).
        let dir = std::env::temp_dir().join(format!("zazabor-pdfium-trust-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lib = dir.join("libpdfium.so");
        std::fs::write(&lib, b"not a library").unwrap();
        assert!(!trusted(&lib));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_in_the_users_own_folders_is_trusted() {
        assert!(trusted(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")));
    }
}
