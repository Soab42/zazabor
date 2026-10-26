//! Clipboard history, like Windows' Win+V: everything copied on the desktop (text with its HTML,
//! pictures, files) is kept, newest first, the last 25 plus whatever is pinned. The Win+V popup
//! (`popup.rs`) and the Clipboard section show it; picking an item puts it back on the clipboard
//! and pastes it where the user was typing (`x11.rs`).
//!
//! `watch.rs` follows the system clipboard (GTK, on the main thread). Recording pauses while the
//! history is off or CorePro is locked, skips what password managers mark as secret, and skips
//! apps the user excluded. Saved in the app's data folder as `clipboard/history.json`, pictures
//! as PNG files in `clipboard/images/`.

pub(crate) mod popup;
mod watch;
pub(crate) mod x11;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{Emitter, Manager};

use crate::notes::{new_id, now};
use gio::prelude::*;

/// Unpinned items kept, as Windows keeps 25.
pub const MAX_UNPINNED: usize = 25;
/// Longest text kept (Windows caps an item at 4 MB; text this long is rarely wanted back).
pub const MAX_TEXT: usize = 1_000_000;
/// Largest HTML flavour kept alongside a text.
pub const MAX_HTML: usize = 2_000_000;
/// Largest picture kept, in pixels (about 8K × 5K).
pub const MAX_PIXELS: u64 = 40_000_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// 32 hex digits.
    pub id: String,
    /// "text", "image" or "files".
    pub kind: String,
    /// The text; for files, their paths, one per line.
    #[serde(default)]
    pub text: String,
    /// The rich-text flavour of a text, as the source offered it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    /// Copied files, as URIs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uris: Vec<String>,
    /// A picture's PNG, in `clipboard/images/` (its full path is sent to the page).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Identifies the content: copying the same thing again moves its item to the top.
    pub hash: String,
    #[serde(default)]
    pub pinned: bool,
    /// When it was (last) copied, ms since the epoch.
    pub created: i64,
    /// The app it was copied from (its window class), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Recording is on (Settings → Clipboard → Clipboard history).
    pub enabled: bool,
    /// Unpinned items go when CorePro quits (Windows clears them at restart).
    #[serde(default)]
    pub clear_on_exit: bool,
    /// Window classes whose copies aren't kept (e.g. "keepassxc").
    #[serde(default)]
    pub exclude: Vec<String>,
    /// CorePro took Super+V from GNOME's notification list; giving the shortcut up hands it back.
    #[serde(default)]
    pub took_super_v: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: true, clear_on_exit: false, exclude: Vec::new(), took_super_v: false }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    /// Newest first.
    #[serde(default)]
    items: Vec<Item>,
    #[serde(default)]
    settings: Settings,
}

struct Store {
    dir: PathBuf,
    saved: Saved,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn store() -> MutexGuard<'static, Store> {
    STORE.get().expect("clipboard::init runs at startup").lock().unwrap_or_else(|e| e.into_inner())
}

/// Loads the history and starts following the clipboard. Runs on the main thread (setup).
pub fn init(app: tauri::AppHandle, dir: PathBuf) {
    let dir = dir.join("clipboard");
    let saved: Saved = std::fs::read_to_string(dir.join("history.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let _ = STORE.set(Mutex::new(Store { dir, saved }));
    let _ = APP.set(app);
    watch::start();
}

/// CorePro is quitting: clears the unpinned items when the user asked for that.
pub fn on_exit() {
    let Some(lock) = STORE.get() else { return };
    let mut store = lock.lock().unwrap_or_else(|e| e.into_inner());
    if store.saved.settings.clear_on_exit {
        let gone = clear_unpinned(&mut store.saved.items);
        store.forget_images(&gone);
        store.save();
    }
}

impl Store {
    fn images(&self) -> PathBuf {
        self.dir.join("images")
    }

    fn save(&self) {
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&self.dir)?;
            let path = self.dir.join("history.json");
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&self.saved)?)?;
            std::fs::rename(&tmp, &path)
        };
        if let Err(err) = write() {
            eprintln!("Saving the clipboard history failed: {err}");
        }
    }

    /// Saves, and tells every window.
    fn changed(&self) {
        self.save();
        if let Some(app) = APP.get() {
            let _ = app.emit("clipboard-changed", ());
        }
    }

    fn forget_images(&self, items: &[Item]) {
        for item in items {
            if let Some(name) = &item.image {
                let _ = std::fs::remove_file(self.images().join(name));
            }
        }
    }

    /// An item as the page sees it: the picture's file as a full path.
    fn shown(&self, item: &Item) -> Item {
        let mut item = item.clone();
        item.image = item.image.map(|name| self.images().join(name).to_string_lossy().into_owned());
        item
    }
}

// ---- the history's rules (pure, tested) -------------------------------------------------------

/// Puts a new copy at the top. The same content copied again moves its item up instead (keeping
/// its pin). Unpinned items past the cap fall off the end. Returns the items that were dropped
/// (and the new item itself when it was a duplicate), so their pictures can be deleted.
fn record(items: &mut Vec<Item>, item: Item) -> Vec<Item> {
    let mut gone = Vec::new();
    let top = match items.iter().position(|i| i.hash == item.hash) {
        Some(at) => {
            let mut existing = items.remove(at);
            existing.created = item.created;
            existing.source = item.source.clone().or(existing.source);
            gone.push(item);
            existing
        }
        None => item,
    };
    items.insert(0, top);
    let mut unpinned = 0;
    items.retain(|i| {
        if i.pinned {
            return true;
        }
        unpinned += 1;
        if unpinned > MAX_UNPINNED {
            gone.push(i.clone());
            return false;
        }
        true
    });
    gone
}

/// Clear all, as Windows does it: pinned items stay.
fn clear_unpinned(items: &mut Vec<Item>) -> Vec<Item> {
    let (kept, gone): (Vec<Item>, Vec<Item>) = std::mem::take(items).into_iter().partition(|i| i.pinned);
    *items = kept;
    gone
}

/// What KDE's and KeePassXC's password hint says: "secret" means don't keep it.
pub fn is_secret(hint: Option<&[u8]>) -> bool {
    hint.is_some_and(|h| String::from_utf8_lossy(h).trim().eq_ignore_ascii_case("secret"))
}

/// The copying app is one the user excluded (by window class or instance, any case).
fn excluded(settings: &Settings, source: Option<&str>) -> bool {
    source.is_some_and(|s| settings.exclude.iter().any(|e| e.trim().eq_ignore_ascii_case(s.trim())))
}

pub fn hash_of(kind: &str, bytes: &[u8]) -> String {
    format!("{kind}:{:016x}", xxhash_rust::xxh3::xxh3_64(bytes))
}

// ---- recording (called by watch.rs) -----------------------------------------------------------

/// Whether a copy should be looked at at all (history on, unlocked).
pub fn recording() -> bool {
    STORE.get().is_some_and(|s| s.lock().unwrap_or_else(|e| e.into_inner()).saved.settings.enabled) && !crate::lock::is_locked()
}

/// Something new was copied (built by watch.rs, picture already saved under `image`).
pub fn add(mut item: Item) {
    let mut store = store();
    if !store.saved.settings.enabled || excluded(&store.saved.settings, item.source.as_deref()) {
        store.forget_images(std::slice::from_ref(&item));
        return;
    }
    item.id = new_id();
    item.created = now();
    let gone = record(&mut store.saved.items, item);
    store.forget_images(&gone);
    store.changed();
}

/// Where watch.rs saves a picture.
pub fn image_dir() -> PathBuf {
    store().images()
}

/// A new item's skeleton, for watch.rs.
pub fn blank(kind: &str) -> Item {
    Item { id: String::new(), kind: kind.into(), text: String::new(), html: None, uris: Vec::new(), image: None, width: None, height: None, hash: String::new(), pinned: false, created: 0, source: None }
}

// ---- commands ---------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    items: Vec<Item>,
    settings: Settings,
    /// CorePro can paste into other apps itself (an X11 session); otherwise the user presses Ctrl+V.
    can_paste: bool,
}

#[tauri::command]
pub fn clipboard_list() -> Result<History, String> {
    crate::ensure_unlocked()?;
    let store = store();
    Ok(History { items: store.saved.items.iter().map(|i| store.shown(i)).collect(), settings: store.saved.settings.clone(), can_paste: x11::can_paste() })
}

#[tauri::command]
pub fn clipboard_pin(id: String, pinned: bool) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let item = store.saved.items.iter_mut().find(|i| i.id == id).ok_or("That item is gone.")?;
    item.pinned = pinned;
    // Unpinning can push the history past its cap.
    let items = std::mem::take(&mut store.saved.items);
    let mut kept = Vec::new();
    let mut gone = Vec::new();
    let mut unpinned = 0;
    for i in items {
        if !i.pinned {
            unpinned += 1;
            if unpinned > MAX_UNPINNED {
                gone.push(i);
                continue;
            }
        }
        kept.push(i);
    }
    store.saved.items = kept;
    store.forget_images(&gone);
    store.changed();
    Ok(())
}

#[tauri::command]
pub fn clipboard_delete(id: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let Some(at) = store.saved.items.iter().position(|i| i.id == id) else { return Ok(()) };
    let item = store.saved.items.remove(at);
    store.forget_images(&[item]);
    store.changed();
    Ok(())
}

/// Clear all: everything but the pinned items.
#[tauri::command]
pub fn clipboard_clear() -> Result<(), String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let gone = clear_unpinned(&mut store.saved.items);
    store.forget_images(&gone);
    store.changed();
    Ok(())
}

#[tauri::command]
pub fn clipboard_set_settings(enabled: bool, clear_on_exit: bool, exclude: Vec<String>) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let settings = &mut store.saved.settings;
    settings.enabled = enabled;
    settings.clear_on_exit = clear_on_exit;
    settings.exclude = exclude.into_iter().map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect();
    store.changed();
    Ok(())
}

/// Puts an item back on the clipboard; with `paste`, also hides the popup and pastes it where the
/// user was typing. Returns whether it pasted (else the user presses Ctrl+V).
#[tauri::command]
pub async fn clipboard_use(app: tauri::AppHandle, id: String, paste: bool) -> Result<bool, String> {
    crate::ensure_unlocked()?;
    let item = {
        let store = store();
        let item = store.saved.items.iter().find(|i| i.id == id).ok_or("That item is gone.")?;
        store.shown(item)
    };
    put_and_paste(&app, watch::Content::Item(item), paste).await
}

/// Types an emoji, kaomoji or symbol where the user was typing: through the clipboard, which gets
/// its earlier content back afterwards, and without adding it to the history.
#[tauri::command]
pub async fn clipboard_type(app: tauri::AppHandle, text: String) -> Result<bool, String> {
    crate::ensure_unlocked()?;
    let before = {
        let store = store();
        store.saved.items.first().map(|i| store.shown(i))
    };
    watch::skip_for(std::time::Duration::from_millis(1500));
    let pasted = put_and_paste(&app, watch::Content::Text(text), true).await?;
    if pasted {
        if let Some(before) = before {
            tauri::async_runtime::spawn(async move {
                tokio_sleep(600).await;
                let _ = app.run_on_main_thread(move || {
                    let _ = watch::put(watch::Content::Item(before));
                });
            });
        }
    }
    Ok(pasted)
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

async fn put_and_paste(app: &tauri::AppHandle, content: watch::Content, paste: bool) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(watch::put(content));
    })
    .map_err(|e| e.to_string())?;
    let put = tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())).await.map_err(|e| e.to_string())??;
    put?;
    // Without a way to press Ctrl+V the popup stays up a moment to say so (the page hides it).
    if !paste || !x11::can_paste() {
        return Ok(false);
    }
    // Hidden for real (on the main thread) before the keys go out, or they'd reach the popup.
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        popup::hide(&handle);
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    let target = popup::previous_focus();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = rx.recv_timeout(std::time::Duration::from_secs(1));
        std::thread::sleep(std::time::Duration::from_millis(80));
        // The window that had the keyboard gets it back, then Ctrl+V.
        x11::focus(target);
        std::thread::sleep(std::time::Duration::from_millis(90));
        x11::press_ctrl_v()
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(true)
}

/// Shows or hides the Win+V popup (the Clipboard section's button, and `corepro --clipboard`).
#[tauri::command]
pub async fn clipboard_popup(app: tauri::AppHandle) -> Result<(), String> {
    popup::toggle(&app)
}

#[tauri::command]
pub async fn clipboard_popup_hide(app: tauri::AppHandle) -> Result<(), String> {
    popup::hide(&app);
    Ok(())
}

/// The main window's Clipboard section (the popup's "Open Clipboard").
#[tauri::command]
pub async fn clipboard_show_section(app: tauri::AppHandle) -> Result<(), String> {
    popup::hide(&app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        return main.emit("clipboard-show-section", ()).map_err(|e| e.to_string());
    }
    crate::new_window(&app, "clipboard", None, None)
}

// ---- the desktop shortcut (Super+V) ------------------------------------------------------------

/// GNOME Shell opens its notification list with Super+V (and Super+M).
const SHELL_KEYS: &str = "org.gnome.shell.keybindings";
const MESSAGE_TRAY: &str = "toggle-message-tray";

fn shell_keys() -> Option<gio::Settings> {
    let source = gio::SettingsSchemaSource::default()?;
    let schema = source.lookup(SHELL_KEYS, true)?;
    schema.has_key(MESSAGE_TRAY).then(|| gio::Settings::new(SHELL_KEYS))
}

fn is_super_v(binding: &str) -> bool {
    binding.eq_ignore_ascii_case("<Super>v")
}

/// GNOME's notification list currently answers to Super+V.
fn gnome_has_super_v() -> bool {

    shell_keys().is_some_and(|k| k.strv(MESSAGE_TRAY).iter().any(|b| is_super_v(b)))
}

/// Adds Super+V to, or takes it from, GNOME's notification-list shortcut (its other keys stay).
fn give_gnome_super_v(back: bool) -> Result<(), String> {

    let keys = shell_keys().ok_or("GNOME's shortcuts aren't there.")?;
    let mut list: Vec<String> = keys.strv(MESSAGE_TRAY).iter().map(|b| b.to_string()).filter(|b| !is_super_v(b)).collect();
    if back {
        list.insert(0, "<Super>v".into());
    }
    keys.set_strv(MESSAGE_TRAY, list.iter().map(String::as_str).collect::<Vec<_>>()).map_err(|e| e.to_string())?;
    gio::Settings::sync();
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardShortcut {
    #[serde(flatten)]
    shortcut: crate::notes::quick::Shortcut,
    /// GNOME uses Super+V for its notification list (so Super+V needs taking over first).
    gnome_super_v: bool,
    /// CorePro took Super+V from GNOME (removing the shortcut gives it back).
    took_super_v: bool,
}

fn clipboard_shortcut_status() -> ClipboardShortcut {
    ClipboardShortcut {
        shortcut: crate::notes::quick::shortcut_status(&crate::notes::quick::CLIPBOARD),
        gnome_super_v: gnome_has_super_v(),
        took_super_v: store().saved.settings.took_super_v,
    }
}

#[tauri::command]
pub fn clipboard_shortcut() -> ClipboardShortcut {
    clipboard_shortcut_status()
}

/// Sets the shortcut that opens the popup (`None` removes it). Super+V while GNOME uses it needs
/// `take_super_v`: only then is it taken from GNOME's notification list, and removing CorePro's
/// shortcut later gives it back. Nothing else of the user's is changed.
#[tauri::command]
pub fn clipboard_set_shortcut(binding: Option<String>, take_super_v: bool) -> Result<ClipboardShortcut, String> {
    let wants_super_v = binding.as_deref().is_some_and(is_super_v);
    if wants_super_v && gnome_has_super_v() {
        if !take_super_v {
            return Err("GNOME opens its notification list with Super+V.".into());
        }
        give_gnome_super_v(false)?;
        let mut store = store();
        store.saved.settings.took_super_v = true;
        store.save();
    }
    crate::notes::quick::set_shortcut(&crate::notes::quick::CLIPBOARD, binding.clone())?;
    // Moving off Super+V, or removing the shortcut, hands Super+V back to GNOME.
    let took = store().saved.settings.took_super_v;
    if took && !wants_super_v {
        give_gnome_super_v(true)?;
        let mut store = store();
        store.saved.settings.took_super_v = false;
        store.save();
    }
    Ok(clipboard_shortcut_status())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> Item {
        Item { id: new_id(), text: t.into(), hash: hash_of("text", t.as_bytes()), created: 1, ..blank("text") }
    }

    #[test]
    fn the_same_copy_moves_to_the_top() {
        let mut items = Vec::new();
        record(&mut items, text("a"));
        record(&mut items, text("b"));
        let again = Item { created: 9, source: Some("firefox".into()), ..text("a") };
        let gone = record(&mut items, again);
        assert_eq!(items.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(items[0].created, 9);
        assert_eq!(items[0].source.as_deref(), Some("firefox"));
        // The duplicate's own copy is the one dropped.
        assert_eq!(gone.len(), 1);
    }

    #[test]
    fn twenty_five_unpinned_plus_the_pinned() {
        let mut items = Vec::new();
        record(&mut items, Item { pinned: true, ..text("keep") });
        for n in 0..30 {
            record(&mut items, text(&n.to_string()));
        }
        assert_eq!(items.iter().filter(|i| !i.pinned).count(), MAX_UNPINNED);
        assert!(items.iter().any(|i| i.text == "keep"));
        assert_eq!(items[0].text, "29");
        assert!(!items.iter().any(|i| i.text == "4"));
    }

    #[test]
    fn a_pinned_item_copied_again_stays_pinned() {
        let mut items = Vec::new();
        record(&mut items, Item { pinned: true, ..text("a") });
        record(&mut items, text("b"));
        record(&mut items, text("a"));
        assert!(items[0].pinned && items[0].text == "a");
    }

    #[test]
    fn clear_all_keeps_the_pinned() {
        let mut items = vec![text("a"), Item { pinned: true, ..text("b") }, text("c")];
        let gone = clear_unpinned(&mut items);
        assert_eq!(items.len(), 1);
        assert_eq!(gone.len(), 2);
    }

    #[test]
    fn secrets_and_excluded_apps_are_skipped() {
        assert!(is_secret(Some(b"secret")));
        assert!(is_secret(Some(b"Secret\n")));
        assert!(!is_secret(Some(b"accepted")));
        assert!(!is_secret(None));
        let settings = Settings { exclude: vec!["KeePassXC".into()], ..Settings::default() };
        assert!(excluded(&settings, Some("keepassxc")));
        assert!(!excluded(&settings, Some("firefox")));
        assert!(!excluded(&settings, None));
    }
}
