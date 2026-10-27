//! Keeps the screen awake (no dimming, screen saver or screen lock) while something is being
//! watched. The video player draws libVLC's frames with WebGL instead of giving libVLC a window,
//! so libVLC's own screen saver inhibition never applies; this asks the desktop instead, over
//! D-Bus: `org.freedesktop.ScreenSaver` (GNOME, KDE, COSMIC, Xfce…), else GNOME's session manager.
//!
//! Each reason (a playing video, a slideshow in some window) is turned on and off on its own; the
//! screen stays awake while any is on. The D-Bus calls run on their own thread, so a slow desktop
//! never holds up playback.

use gio::prelude::*;
use std::collections::HashSet;
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};

const APP_NAME: &str = "Zazabor";

enum Cookie {
    ScreenSaver(u32),
    Session(u32),
}

static TX: OnceLock<Mutex<Sender<(String, bool)>>> = OnceLock::new();
static ACTIVE: Mutex<bool> = Mutex::new(false);

/// Turns one reason to stay awake on or off, e.g. `("video", true)` while a video plays.
pub fn set(reason: &str, on: bool) {
    let tx = TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<(String, bool)>();
        std::thread::Builder::new()
            .name("awake".into())
            .spawn(move || {
                let mut reasons = HashSet::new();
                let mut cookie: Option<Cookie> = None;
                while let Ok((reason, on)) = rx.recv() {
                    if on {
                        reasons.insert(reason);
                    } else {
                        reasons.remove(&reason);
                    }
                    if !reasons.is_empty() && cookie.is_none() {
                        cookie = inhibit();
                    } else if reasons.is_empty() {
                        if let Some(c) = cookie.take() {
                            release(c);
                        }
                    }
                    *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = !reasons.is_empty();
                }
            })
            .expect("starting the keep-awake thread");
        Mutex::new(tx)
    });
    let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send((reason.to_string(), on));
}

/// Whether something keeps the screen awake now; the privacy lock's auto-lock waits meanwhile.
pub fn active() -> bool {
    *ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// The session bus, shared for the life of the app: an inhibition ends with the connection that
/// made it, and must be lifted through the same one.
fn bus() -> Option<gio::DBusConnection> {
    gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).ok()
}

fn call(bus: &gio::DBusConnection, service: &str, path: &str, interface: &str, method: &str, args: gio::glib::Variant) -> Option<u32> {
    let reply = bus
        .call_sync(
            Some(service),
            path,
            interface,
            method,
            Some(&args),
            Some(gio::glib::VariantTy::new("(u)").ok()?),
            gio::DBusCallFlags::NONE,
            3000,
            gio::Cancellable::NONE,
        )
        .ok()?;
    reply.get::<(u32,)>().map(|(cookie,)| cookie)
}

fn inhibit() -> Option<Cookie> {
    let bus = bus()?;
    let reason = "Playing";
    if let Some(c) = call(&bus, "org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", "Inhibit", (APP_NAME, reason).to_variant()) {
        return Some(Cookie::ScreenSaver(c));
    }
    // GNOME without the screen saver proxy. Flag 8: the session must not be marked idle.
    let session = call(&bus, "org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "Inhibit", (APP_NAME, 0u32, reason, 8u32).to_variant());
    if session.is_none() {
        eprintln!("Couldn’t keep the screen awake: the desktop offers no screen saver inhibition over D-Bus.");
    }
    session.map(Cookie::Session)
}

fn release(cookie: Cookie) {
    let Some(bus) = bus() else { return };
    let (service, path, interface, method, value) = match cookie {
        Cookie::ScreenSaver(c) => ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", "UnInhibit", c),
        Cookie::Session(c) => ("org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "Uninhibit", c),
    };
    let _ = bus.call_sync(Some(service), path, interface, method, Some(&(value,).to_variant()), None, gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE);
}

/// For pages: a slideshow keeps the screen awake while it runs. `reason` is per window.
#[tauri::command]
pub fn awake_set(window: tauri::Window, reason: String, on: bool) {
    set(&format!("{}:{reason}", window.label()), on);
}

#[tauri::command]
pub fn awake_active() -> bool {
    active()
}

/// A window that closes takes its reasons with it.
pub fn window_closed(label: &str) {
    set(&format!("{label}:slideshow"), false);
}
