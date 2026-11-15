//! Desktop notifications through the freedesktop notification service on the session D-Bus
//! (`org.freedesktop.Notifications`), the one GNOME, KDE and the others show. It needs no
//! `notify-send` (libnotify-bin isn't always installed). A notification can carry a click: the
//! service's `ActionInvoked` signal for it runs the callback on the main thread.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use gio::glib::{self, ToVariant, Variant};

type OnClick = Box<dyn Fn() + Send + 'static>;

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

/// The clicks waiting, by the notification's id.
static CLICKS: Mutex<Option<HashMap<u32, OnClick>>> = Mutex::new(None);
static BUS: OnceLock<Option<gio::DBusConnection>> = OnceLock::new();

fn bus() -> Option<&'static gio::DBusConnection> {
    BUS.get_or_init(|| gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).map_err(|e| eprintln!("Notifications: no session bus: {e}")).ok()).as_ref()
}

/// Listens for clicks and closes. Called once at startup, on the main thread, so the signals
/// arrive on the main loop.
pub fn init() {
    let Some(bus) = bus() else { return };
    bus.signal_subscribe(Some(SERVICE), Some(SERVICE), None, Some(PATH), None, gio::DBusSignalFlags::NONE, |_, _, _, _, signal, params| {
        let Some(id) = params.try_child_value(0).and_then(|v| v.get::<u32>()) else { return };
        let click = CLICKS.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|all| all.remove(&id));
        if signal == "ActionInvoked" {
            if let Some(click) = click {
                click();
            }
        }
    });
}

pub struct Note<'a> {
    pub title: &'a str,
    pub body: &'a str,
    /// A themed icon name ("mail-unread").
    pub icon: &'a str,
    /// The freedesktop category ("email.arrived").
    pub category: &'a str,
    /// Replaces the notification of this id still showing (0 for a new one).
    pub replaces: u32,
}

/// The arguments of `Notify` (app, replaces, icon, summary, body, actions, hints, timeout).
fn notify_params(note: &Note, clickable: bool) -> Variant {
    let mut hints: HashMap<String, Variant> = HashMap::new();
    hints.insert("desktop-entry".into(), "zazabor".to_variant());
    hints.insert("category".into(), note.category.to_variant());
    hints.insert("urgency".into(), 1u8.to_variant());
    let actions: Vec<String> = if clickable { vec!["default".into(), "Open".into()] } else { Vec::new() };
    ("Zazabor", note.replaces, note.icon, note.title, note.body, actions, hints, -1i32).to_variant()
}

/// Shows a notification; `on_click` runs when it's clicked. Returns its id (0 when there's no
/// notification service).
pub fn show(note: Note, on_click: Option<OnClick>) -> u32 {
    let Some(bus) = bus() else { return 0 };
    let params = notify_params(&note, on_click.is_some());
    let reply = bus.call_sync(Some(SERVICE), PATH, SERVICE, "Notify", Some(&params), Some(glib::VariantTy::new("(u)").expect("a reply type")), gio::DBusCallFlags::NONE, 3000, gio::Cancellable::NONE);
    match reply {
        Ok(reply) => {
            let id = reply.try_child_value(0).and_then(|v| v.get::<u32>()).unwrap_or(0);
            let mut clicks = CLICKS.lock().unwrap_or_else(|e| e.into_inner());
            let all = clicks.get_or_insert_with(HashMap::new);
            match on_click {
                Some(click) if id != 0 => {
                    all.insert(id, click);
                }
                _ => {
                    all.remove(&id);
                }
            }
            id
        }
        Err(err) => {
            eprintln!("Notifications: {err}");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_takes_the_specs_arguments() {
        let note = Note { title: "Ada", body: "Hello", icon: "mail-unread", category: "email.arrived", replaces: 7 };
        let params = notify_params(&note, true);
        assert_eq!(params.type_().as_str(), "(susssasa{sv}i)");
        assert_eq!(params.try_child_value(1).and_then(|v| v.get::<u32>()), Some(7));
        assert_eq!(params.try_child_value(5).and_then(|v| v.get::<Vec<String>>()), Some(vec!["default".to_string(), "Open".to_string()]));
    }
}
