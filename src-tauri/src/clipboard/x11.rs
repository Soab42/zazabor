//! The X11 side of pasting from the Win+V popup: which window has the keyboard, giving it back,
//! and pressing Ctrl+V there (XTest), plus the class of the app that copied (for excluded apps).
//! Xlib and libXtst are loaded at run time (x11-dl), so CorePro still starts without them.
//!
//! Native Wayland apps can't be typed into this way, so on Wayland `can_paste` is false and the
//! popup only puts the item on the clipboard.

use std::ffi::CString;
use std::os::raw::{c_int, c_uchar, c_ulong};
use std::ptr;
use std::sync::OnceLock;
use x11_dl::{keysym, xlib, xtest};

struct Libs {
    x: xlib::Xlib,
    tst: Option<xtest::Xf86vmode>,
}

fn libs() -> Option<&'static Libs> {
    static LIBS: OnceLock<Option<Libs>> = OnceLock::new();
    LIBS.get_or_init(|| xlib::Xlib::open().ok().map(|x| Libs { x, tst: xtest::Xf86vmode::open().ok() })).as_ref()
}

/// Runs `f` with a connection of its own (any thread), closed afterwards.
fn with_display<T>(f: impl FnOnce(&xlib::Xlib, *mut xlib::Display) -> Option<T>) -> Option<T> {
    let libs = libs()?;
    // SAFETY: XOpenDisplay with NULL reads $DISPLAY; the display is closed below and not shared.
    unsafe {
        let display = (libs.x.XOpenDisplay)(ptr::null());
        if display.is_null() {
            return None;
        }
        let out = f(&libs.x, display);
        (libs.x.XCloseDisplay)(display);
        out
    }
}

fn wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.eq_ignore_ascii_case("wayland")) || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// CorePro can press Ctrl+V in other apps: an X11 session with XTest.
pub fn can_paste() -> bool {
    !wayland() && std::env::var_os("DISPLAY").is_some() && libs().is_some_and(|l| l.tst.is_some())
}

unsafe fn atom(x: &xlib::Xlib, d: *mut xlib::Display, name: &str) -> c_ulong {
    let name = CString::new(name).unwrap_or_default();
    (x.XInternAtom)(d, name.as_ptr(), xlib::False)
}

/// A window-valued property (one window id).
unsafe fn window_property(x: &xlib::Xlib, d: *mut xlib::Display, window: c_ulong, name: &str) -> Option<c_ulong> {
    let (mut kind, mut format, mut count, mut after) = (0, 0 as c_int, 0, 0);
    let mut data: *mut c_uchar = ptr::null_mut();
    let ok = (x.XGetWindowProperty)(d, window, atom(x, d, name), 0, 1, xlib::False, xlib::XA_WINDOW, &mut kind, &mut format, &mut count, &mut after, &mut data);
    let value = (ok == 0 && !data.is_null() && count == 1 && format == 32).then(|| *(data as *const c_ulong));
    if !data.is_null() {
        (x.XFree)(data as *mut _);
    }
    value.filter(|&w| w != 0)
}

/// The window with the keyboard: the window manager's active window, else the input focus.
pub fn active_window() -> Option<u64> {
    with_display(|x, d| unsafe {
        let root = (x.XDefaultRootWindow)(d);
        window_property(x, d, root, "_NET_ACTIVE_WINDOW").or_else(|| {
            let (mut focus, mut revert) = (0, 0);
            (x.XGetInputFocus)(d, &mut focus, &mut revert);
            (focus > 1 && focus != root).then_some(focus)
        })
    })
    .map(|w| w as u64)
}

/// The keyboard's owner to give it back to later: the window manager's active window, else the
/// input focus as X has it (PointerRoot, 1, when the keyboard follows the pointer).
pub fn current_focus() -> Option<u64> {
    with_display(|x, d| unsafe {
        let root = (x.XDefaultRootWindow)(d);
        window_property(x, d, root, "_NET_ACTIVE_WINDOW").or_else(|| {
            let (mut focus, mut revert) = (0, 0);
            (x.XGetInputFocus)(d, &mut focus, &mut revert);
            (focus != 0 && focus != root).then_some(focus)
        })
    })
    .map(|w| w as u64)
}

/// The app that copied: the class of the active window (or one of its parents, as the input focus
/// is often a child window).
pub fn active_class() -> Option<String> {
    let window = active_window()? as c_ulong;
    with_display(|x, d| unsafe {
        let mut w = window;
        for _ in 0..6 {
            let mut hint = xlib::XClassHint { res_name: ptr::null_mut(), res_class: ptr::null_mut() };
            if (x.XGetClassHint)(d, w, &mut hint) != 0 {
                let class = (!hint.res_class.is_null()).then(|| std::ffi::CStr::from_ptr(hint.res_class).to_string_lossy().into_owned());
                for p in [hint.res_name, hint.res_class] {
                    if !p.is_null() {
                        (x.XFree)(p as *mut _);
                    }
                }
                if class.is_some() {
                    return class;
                }
            }
            let (mut root, mut parent, mut children, mut count) = (0, 0, ptr::null_mut(), 0);
            if (x.XQueryTree)(d, w, &mut root, &mut parent, &mut children, &mut count) == 0 {
                return None;
            }
            if !children.is_null() {
                (x.XFree)(children as *mut _);
            }
            if parent == 0 || parent == root {
                return None;
            }
            w = parent;
        }
        None
    })
}

/// A text property (WM_NAME, _NET_WM_NAME), as UTF-8.
unsafe fn text_property(x: &xlib::Xlib, d: *mut xlib::Display, window: c_ulong, name: &str) -> Option<String> {
    let (mut kind, mut format, mut count, mut after) = (0, 0 as c_int, 0, 0);
    let mut data: *mut c_uchar = ptr::null_mut();
    let ok = (x.XGetWindowProperty)(d, window, atom(x, d, name), 0, 1024, xlib::False, xlib::AnyPropertyType as c_ulong, &mut kind, &mut format, &mut count, &mut after, &mut data);
    let value = (ok == 0 && !data.is_null() && format == 8).then(|| String::from_utf8_lossy(std::slice::from_raw_parts(data, count as usize)).into_owned());
    if !data.is_null() {
        (x.XFree)(data as *mut _);
    }
    value
}

/// One of this process's own top-level windows, by its title: among the window manager's client
/// list when there is one, else the root's children.
pub fn own_window(title: &str) -> Option<u64> {
    let pid = std::process::id() as c_ulong;
    with_display(|x, d| unsafe {
        let root = (x.XDefaultRootWindow)(d);
        let mut windows: Vec<c_ulong> = Vec::new();
        let (mut kind, mut format, mut count, mut after) = (0, 0 as c_int, 0, 0);
        let mut data: *mut c_uchar = ptr::null_mut();
        if (x.XGetWindowProperty)(d, root, atom(x, d, "_NET_CLIENT_LIST"), 0, 4096, xlib::False, xlib::XA_WINDOW, &mut kind, &mut format, &mut count, &mut after, &mut data) == 0 && !data.is_null() && format == 32 {
            windows.extend_from_slice(std::slice::from_raw_parts(data as *const c_ulong, count as usize));
        }
        if !data.is_null() {
            (x.XFree)(data as *mut _);
        }
        if windows.is_empty() {
            let (mut r, mut parent, mut children, mut n) = (0, 0, ptr::null_mut(), 0);
            if (x.XQueryTree)(d, root, &mut r, &mut parent, &mut children, &mut n) != 0 && !children.is_null() {
                windows.extend_from_slice(std::slice::from_raw_parts(children, n as usize));
                (x.XFree)(children as *mut _);
            }
        }
        windows.into_iter().find(|&w| {
            let mine = {
                let (mut kind, mut format, mut count, mut after) = (0, 0 as c_int, 0, 0);
                let mut data: *mut c_uchar = ptr::null_mut();
                let ok = (x.XGetWindowProperty)(d, w, atom(x, d, "_NET_WM_PID"), 0, 1, xlib::False, xlib::XA_CARDINAL, &mut kind, &mut format, &mut count, &mut after, &mut data);
                let hit = ok == 0 && !data.is_null() && count == 1 && *(data as *const c_ulong) == pid;
                if !data.is_null() {
                    (x.XFree)(data as *mut _);
                }
                hit
            };
            mine && [text_property(x, d, w, "_NET_WM_NAME"), text_property(x, d, w, "WM_NAME")].iter().flatten().any(|t| t == title)
        })
    })
    .map(|w| w as u64)
}

/// Gives the keyboard to `target` (the popup when it opens, the window it was opened over when an
/// item is picked): through the window manager when there is one (as a pager asks, which focus
/// stealing prevention lets through), else directly.
pub fn focus(target: Option<u64>) {
    let Some(target) = target else { return };
    with_display(|x, d| unsafe {
        let root = (x.XDefaultRootWindow)(d);
        if target == 1 {
            // The keyboard followed the pointer: it does again.
            (x.XSetInputFocus)(d, 1, xlib::RevertToPointerRoot, xlib::CurrentTime);
        } else if window_property(x, d, root, "_NET_ACTIVE_WINDOW").is_some() {
            let mut event: xlib::XEvent = std::mem::zeroed();
            event.client_message = xlib::XClientMessageEvent {
                type_: xlib::ClientMessage,
                serial: 0,
                send_event: xlib::True,
                display: d,
                window: target as c_ulong,
                message_type: atom(x, d, "_NET_ACTIVE_WINDOW"),
                format: 32,
                data: xlib::ClientMessageData::from([2, xlib::CurrentTime as i64, 0, 0, 0]),
            };
            (x.XSendEvent)(d, root, xlib::False, xlib::SubstructureRedirectMask | xlib::SubstructureNotifyMask, &mut event);
        } else {
            (x.XSetInputFocus)(d, target as c_ulong, xlib::RevertToParent, xlib::CurrentTime);
        }
        (x.XSync)(d, xlib::False);
        Some(())
    });
}

/// Presses and releases Ctrl+V as if typed.
pub fn press_ctrl_v() -> Result<(), String> {
    let libs = libs().ok_or("Xlib isn't available.")?;
    let tst = libs.tst.as_ref().ok_or("XTest isn't available.")?;
    with_display(|x, d| unsafe {
        let ctrl = (x.XKeysymToKeycode)(d, keysym::XK_Control_L as c_ulong);
        let v = (x.XKeysymToKeycode)(d, keysym::XK_v as c_ulong);
        if ctrl == 0 || v == 0 {
            return None;
        }
        for (key, down) in [(ctrl, true), (v, true), (v, false), (ctrl, false)] {
            (tst.XTestFakeKeyEvent)(d, key as u32, down as c_int, 0);
        }
        (x.XSync)(d, xlib::False);
        Some(())
    })
    .ok_or_else(|| "Couldn't press Ctrl+V.".to_string())
}
