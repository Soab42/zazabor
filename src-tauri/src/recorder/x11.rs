//! The X11 side of choosing what to record: the open windows (title, app, icon, where they are)
//! and a still of the screen for drawing an area on. Xlib is loaded at run time (x11-dl).

use serde::Serialize;
use std::os::raw::{c_int, c_uchar, c_ulong};
use std::ptr;
use std::sync::OnceLock;
use x11_dl::{xlib, xrandr};

fn xlib() -> Option<&'static xlib::Xlib> {
    static LIB: OnceLock<Option<xlib::Xlib>> = OnceLock::new();
    LIB.get_or_init(|| xlib::Xlib::open().ok()).as_ref()
}

/// The recorder's own connection to the X server, kept open: opening and closing connections
/// from several threads at once isn't safe without `XInitThreads`, and the page, the control
/// bar and the screen watch all ask at the same time.
struct Connection {
    name: String,
    display: *mut xlib::Display,
}

// SAFETY: the connection is only used under the mutex below.
unsafe impl Send for Connection {}

static CONNECTION: std::sync::Mutex<Option<Connection>> = std::sync::Mutex::new(None);

/// Runs `f` with the recorder's connection to `display`, one caller at a time (any thread).
fn with_display<T>(display: &str, f: impl FnOnce(&xlib::Xlib, *mut xlib::Display) -> Option<T>) -> Option<T> {
    let x = xlib()?;
    let mut held = CONNECTION.lock().unwrap_or_else(|e| e.into_inner());
    if held.as_ref().is_none_or(|c| c.name != display) {
        let name = std::ffi::CString::new(display).ok()?;
        // SAFETY: opened once per display name; the old one is closed under the same lock.
        unsafe {
            if let Some(old) = held.take() {
                (x.XCloseDisplay)(old.display);
            }
            let d = (x.XOpenDisplay)(name.as_ptr());
            if d.is_null() {
                return None;
            }
            *held = Some(Connection { name: display.to_string(), display: d });
        }
    }
    // `d` is open and only used here while the lock is held.
    let d = held.as_ref()?.display;
    f(x, d)
}

unsafe fn atom(x: &xlib::Xlib, d: *mut xlib::Display, name: &str) -> c_ulong {
    let c = std::ffi::CString::new(name).expect("atom name");
    (x.XInternAtom)(d, c.as_ptr(), xlib::False)
}

/// A window property as 32-bit items (X returns them as longs), or bytes for format 8.
unsafe fn property(x: &xlib::Xlib, d: *mut xlib::Display, w: c_ulong, name: &str, kind: c_ulong, max: i64) -> Option<(c_int, Vec<c_ulong>, Vec<u8>)> {
    let (mut got, mut format, mut count, mut after) = (0, 0 as c_int, 0, 0);
    let mut data: *mut c_uchar = ptr::null_mut();
    let ok = (x.XGetWindowProperty)(d, w, atom(x, d, name), 0, max, xlib::False, kind, &mut got, &mut format, &mut count, &mut after, &mut data);
    if ok != 0 || data.is_null() {
        return None;
    }
    let out = match format {
        32 => (32, std::slice::from_raw_parts(data as *const c_ulong, count as usize).to_vec(), Vec::new()),
        8 => (8, Vec::new(), std::slice::from_raw_parts(data, count as usize).to_vec()),
        _ => (format, Vec::new(), Vec::new()),
    };
    (x.XFree)(data as *mut _);
    Some(out)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub xid: u64,
    pub title: String,
    /// The app (WM_CLASS), e.g. "firefox".
    pub app: String,
    /// Where it is on the screen, in pixels.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub minimized: bool,
    /// Its icon as a PNG data URL, when it has one.
    pub icon: Option<String>,
}

/// The windows a person can pick: the window manager's client list, without docks, desktops and
/// Zazabor's own windows; newest-stacked first.
pub fn windows(display: &str) -> Vec<WindowInfo> {
    let me = std::process::id() as c_ulong;
    with_display(display, |x, d| unsafe {
        let root = (x.XDefaultRootWindow)(d);
        let mut list = property(x, d, root, "_NET_CLIENT_LIST_STACKING", xlib::XA_WINDOW, 4096)
            .or_else(|| property(x, d, root, "_NET_CLIENT_LIST", xlib::XA_WINDOW, 4096))
            .map(|p| p.1)
            .unwrap_or_default();
        // No window manager keeps a list: the root's visible children are the apps' windows.
        if list.is_empty() {
            let (mut r, mut parent, mut children, mut n) = (0, 0, ptr::null_mut(), 0);
            if (x.XQueryTree)(d, root, &mut r, &mut parent, &mut children, &mut n) != 0 && !children.is_null() {
                for &w in std::slice::from_raw_parts(children, n as usize) {
                    let mut attrs: xlib::XWindowAttributes = std::mem::zeroed();
                    if (x.XGetWindowAttributes)(d, w, &mut attrs) != 0 && attrs.map_state == xlib::IsViewable && attrs.override_redirect == 0 {
                        list.push(w);
                    }
                }
                (x.XFree)(children as *mut _);
            }
        }
        let skip_types = [atom(x, d, "_NET_WM_WINDOW_TYPE_DOCK"), atom(x, d, "_NET_WM_WINDOW_TYPE_DESKTOP"), atom(x, d, "_NET_WM_WINDOW_TYPE_SPLASH")];
        let hidden = atom(x, d, "_NET_WM_STATE_HIDDEN");
        let utf8 = atom(x, d, "UTF8_STRING");
        let mut out = Vec::new();
        for &w in list.iter().rev() {
            if property(x, d, w, "_NET_WM_PID", xlib::XA_CARDINAL, 1).is_some_and(|p| p.1.first() == Some(&me)) {
                continue;
            }
            if property(x, d, w, "_NET_WM_WINDOW_TYPE", xlib::XA_ATOM, 16).is_some_and(|p| p.1.iter().any(|t| skip_types.contains(t))) {
                continue;
            }
            let title = property(x, d, w, "_NET_WM_NAME", utf8, 1024)
                .or_else(|| property(x, d, w, "WM_NAME", xlib::AnyPropertyType as c_ulong, 1024))
                .map(|p| String::from_utf8_lossy(&p.2).into_owned())
                .unwrap_or_default();
            if title.trim().is_empty() {
                continue;
            }
            let app = property(x, d, w, "WM_CLASS", xlib::XA_STRING, 256)
                .map(|p| p.2.split(|b| *b == 0).filter(|s| !s.is_empty()).last().map(|s| String::from_utf8_lossy(s).into_owned()).unwrap_or_default())
                .unwrap_or_default();
            let minimized = property(x, d, w, "_NET_WM_STATE", xlib::XA_ATOM, 32).is_some_and(|p| p.1.contains(&hidden));
            let mut attrs: xlib::XWindowAttributes = std::mem::zeroed();
            if (x.XGetWindowAttributes)(d, w, &mut attrs) == 0 || attrs.width < 16 || attrs.height < 16 {
                continue;
            }
            let (mut rx, mut ry, mut child) = (0, 0, 0);
            (x.XTranslateCoordinates)(d, w, root, 0, 0, &mut rx, &mut ry, &mut child);
            let icon = property(x, d, w, "_NET_WM_ICON", xlib::XA_CARDINAL, 1 << 20).and_then(|p| icon_png(&p.1, 48));
            out.push(WindowInfo { xid: w as u64, title, app, x: rx, y: ry, width: attrs.width as u32, height: attrs.height as u32, minimized, icon });
        }
        Some(out)
    })
    .unwrap_or_default()
}

/// Where a window is now (it may have moved since the list was made), or None when it's gone.
pub fn window_rect(display: &str, xid: u64) -> Option<(i32, i32, u32, u32)> {
    with_display(display, |x, d| unsafe {
        let root = (x.XDefaultRootWindow)(d);
        let mut attrs: xlib::XWindowAttributes = std::mem::zeroed();
        if (x.XGetWindowAttributes)(d, xid as c_ulong, &mut attrs) == 0 {
            return None;
        }
        let (mut rx, mut ry, mut child) = (0, 0, 0);
        (x.XTranslateCoordinates)(d, xid as c_ulong, root, 0, 0, &mut rx, &mut ry, &mut child);
        Some((rx, ry, attrs.width as u32, attrs.height as u32))
    })
}

/// The monitors as RandR 1.5 sees them now: (name, x, y, width, height, primary). Asked on a
/// connection of its own each time, so a screen plugged in a moment ago is there.
pub fn monitors(display: &str) -> Vec<(String, i32, i32, u32, u32, bool)> {
    static RANDR: OnceLock<Option<xrandr::Xrandr>> = OnceLock::new();
    let Some(rr) = RANDR.get_or_init(|| xrandr::Xrandr::open().ok()).as_ref() else { return Vec::new() };
    with_display(display, |x, d| unsafe {
        let mut n: c_int = 0;
        let list = (rr.XRRGetMonitors)(d, (x.XDefaultRootWindow)(d), xlib::True, &mut n);
        if list.is_null() {
            return None;
        }
        let out = std::slice::from_raw_parts(list, n.max(0) as usize)
            .iter()
            .map(|m| {
                let atom = (x.XGetAtomName)(d, m.name);
                let name = if atom.is_null() {
                    String::new()
                } else {
                    let s = std::ffi::CStr::from_ptr(atom).to_string_lossy().into_owned();
                    (x.XFree)(atom.cast());
                    s
                };
                (name, m.x, m.y, m.width.max(0) as u32, m.height.max(0) as u32, m.primary != 0)
            })
            .collect();
        (rr.XRRFreeMonitors)(list);
        Some(out)
    })
    .unwrap_or_default()
}

/// The whole X screen's size.
pub fn screen_size(display: &str) -> Option<(u32, u32)> {
    with_display(display, |x, d| unsafe {
        let screen = (x.XDefaultScreen)(d);
        Some(((x.XDisplayWidth)(d, screen) as u32, (x.XDisplayHeight)(d, screen) as u32))
    })
}

/// `_NET_WM_ICON` (width, height, ARGB pixels, repeated per size) as a PNG data URL of the size
/// nearest `want` (the smallest one at least that big).
fn icon_png(data: &[c_ulong], want: u32) -> Option<String> {
    let mut best: Option<(u32, u32, usize)> = None;
    let mut i = 0;
    while i + 2 <= data.len() {
        let (w, h) = (data[i] as u32, data[i + 1] as u32);
        let n = (w as usize).checked_mul(h as usize)?;
        if w == 0 || h == 0 || i + 2 + n > data.len() {
            break;
        }
        let better = match best {
            None => true,
            Some((bw, _, _)) => (w >= want && (bw < want || w < bw)) || (bw < want && w > bw),
        };
        if better {
            best = Some((w, h, i + 2));
        }
        i += 2 + n;
    }
    let (w, h, start) = best?;
    let mut img = image::RgbaImage::new(w, h);
    for (k, px) in img.pixels_mut().enumerate() {
        let argb = data[start + k] as u32;
        *px = image::Rgba([(argb >> 16) as u8, (argb >> 8) as u8, argb as u8, (argb >> 24) as u8]);
    }
    let img = if w > want { image::imageops::resize(&img, want, (h * want / w).max(1), image::imageops::FilterType::Triangle) } else { img };
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64(&png)))
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for (k, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if k <= chunk.len() { T[(n >> shift & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_icon_size_nearest_above_what_is_wanted() {
        // A 2×2 icon then a 64×64 one: 64 is picked for 48 (then scaled down).
        let mut data: Vec<c_ulong> = vec![2, 2, 0xff0000ff, 0xff00ff00, 0xffff0000, 0xffffffff];
        data.extend([64, 64]);
        data.extend(std::iter::repeat_n(0x80112233, 64 * 64));
        let url = icon_png(&data, 48).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // Truncated data is refused rather than read past its end.
        assert!(icon_png(&[16, 16, 1, 2, 3], 48).is_none());
    }

    #[test]
    fn base64_pads() {
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"M"), "TQ==");
    }
}
