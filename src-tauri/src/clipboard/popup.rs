//! The Win+V popup: a small frameless window over everything, next to the pointer. It is made
//! once and then hidden and shown again, so it opens at once. Opening it remembers which window
//! had the keyboard, so a picked item can be pasted there (`x11::focus`).
//!
//! Started on its own (`zazabor --clipboard` with no Zazabor running), Zazabor stays running in
//! the background after the popup hides, as Windows' clipboard service does: copies keep being
//! recorded, and the next press of the shortcut opens the popup at once (through the socket).

use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub const LABEL: &str = "clipboard-popup";
/// Its title (never shown: it has no frame), which `x11::own_window` looks for.
const TITLE: &str = "Clipboard — Zazabor";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 470.0;

static PREVIOUS: Mutex<Option<u64>> = Mutex::new(None);

/// The window that had the keyboard before the popup opened.
pub fn previous_focus() -> Option<u64> {
    *PREVIOUS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Shows the popup, or hides it when it already shows (pressing the shortcut again).
pub fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            hide(app);
            return Ok(());
        }
    }
    show(app)
}

pub fn show(app: &tauri::AppHandle) -> Result<(), String> {
    let mine = app.get_webview_window(LABEL);
    let before = super::x11::current_focus();
    // Pressing the shortcut over the popup itself keeps the window remembered before.
    if before.is_some() && mine.as_ref().is_none_or(|w| !w.is_focused().unwrap_or(false)) {
        *PREVIOUS.lock().unwrap_or_else(|e| e.into_inner()) = before;
    }
    let at = place(app);
    if let Some(window) = mine {
        let _ = window.set_position(at);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        take_keyboard(app);
        return window.emit_to(LABEL, "clipboard-popup-shown", ()).map_err(|e| e.to_string());
    }
    let start = serde_json::json!({ "module": "clipboard-popup" });
    tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .position(at.x, at.y)
        .focused(true)
        .background_color(tauri::webview::Color(0x1c, 0x1d, 0x21, 0xff))
        .initialization_script(format!("window.__ZAZABOR_WINDOW__ = {start};"))
        .build()
        .map_err(|e| e.to_string())?;
    take_keyboard(app);
    Ok(())
}

/// The popup takes the keyboard once it's on screen. A window shown by a process in the
/// background (the shortcut forwards to a running Zazabor) isn't always given it, and without a
/// window manager nothing gives it; the web view inside needs it too, for the arrow keys.
fn take_keyboard(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(40));
            if let Some(id) = super::x11::own_window(TITLE) {
                super::x11::focus(Some(id));
                if let Some(window) = app.get_webview_window(LABEL) {
                    let _ = window.with_webview(|view| {
                        use gtk::prelude::WidgetExt;
                        view.inner().grab_focus();
                    });
                }
                return;
            }
        }
    });
}

pub fn hide(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

/// Next to the pointer, below and to the right of it when there's room (else above or left), on
/// the pointer's monitor.
fn place(app: &tauri::AppHandle) -> tauri::LogicalPosition<f64> {
    let Ok(cursor) = app.cursor_position() else { return tauri::LogicalPosition::new(80.0, 80.0) };
    let monitor = app.monitor_from_point(cursor.x, cursor.y).ok().flatten().or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return tauri::LogicalPosition::new(cursor.x, cursor.y) };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (left, top) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
    let (right, bottom) = (left + area.size.width as f64 / scale, top + area.size.height as f64 / scale);
    let (cx, cy) = (cursor.x / scale, cursor.y / scale);
    let mut x = cx + 12.0;
    let mut y = cy + 12.0;
    if x + WIDTH > right - 8.0 {
        x = (cx - WIDTH - 12.0).max(left + 8.0);
    }
    if y + HEIGHT > bottom - 8.0 {
        y = (cy - HEIGHT - 12.0).max(top + 8.0);
    }
    tauri::LogicalPosition::new(x.max(left + 8.0), y.max(top + 8.0))
}
