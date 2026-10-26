//! Following the system clipboard through GTK, and putting items back on it. GTK's clipboard
//! lives on the main thread: `start` runs from setup, `put` through `run_on_main_thread`.
//!
//! Each change (GTK's "owner-change", which X11's XFixes reports for every app) asks the owner
//! which formats it offers, then reads the best one: files, else text (with its HTML), else a
//! picture. Requests are asynchronous, so a slow app never freezes CorePro; a newer copy makes
//! the answers to an older one stale.

use gtk::prelude::*;
use gtk::{gdk, gdk_pixbuf};
use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use super::Item;
use crate::notes::{new_id, now};

thread_local! {
    static CLIPBOARD: RefCell<Option<gtk::Clipboard>> = const { RefCell::new(None) };
    static GENERATION: Cell<u64> = const { Cell::new(0) };
}

/// Copies before this time (ms) aren't recorded: CorePro's own, while typing an emoji.
static SKIP_UNTIL: AtomicI64 = AtomicI64::new(0);
/// CorePro just put a history item back: its next owner change is that, not a new copy from
/// CorePro (the item moves to the top and keeps the app it came from).
static OWN_PUT: AtomicI64 = AtomicI64::new(0);

const TEXT_TARGETS: [&str; 6] = ["UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING", "TEXT", "COMPOUND_TEXT"];
const GNOME_FILES: &str = "x-special/gnome-copied-files";
const URI_LIST: &str = "text/uri-list";
const HTML: &str = "text/html";
const PASSWORD_HINT: &str = "x-kde-passwordManagerHint";

pub fn skip_for(d: Duration) {
    SKIP_UNTIL.store(now() + d.as_millis() as i64, Ordering::SeqCst);
}

fn atom(name: &str) -> gdk::Atom {
    gdk::Atom::intern(name)
}

pub fn start() {
    let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    clipboard.connect_local("owner-change", false, |values| {
        if let Ok(cb) = values[0].get::<gtk::Clipboard>() {
            changed(&cb);
        }
        None
    });
    CLIPBOARD.with(|c| *c.borrow_mut() = Some(clipboard));
}

fn current(generation: u64) -> bool {
    GENERATION.with(|g| g.get()) == generation
}

fn changed(cb: &gtk::Clipboard) {
    let generation = GENERATION.with(|g| {
        g.set(g.get() + 1);
        g.get()
    });
    if now() < SKIP_UNTIL.load(Ordering::SeqCst) || !super::recording() {
        return;
    }
    // Whose copy it is, asked now: the active window when the copy happened; nobody's when
    // CorePro put an item back (the history keeps the one it had).
    let source = if now() < OWN_PUT.swap(0, Ordering::SeqCst) { None } else { super::x11::active_class() };
    cb.request_contents(&atom("TARGETS"), move |cb, data| {
        if !current(generation) {
            return;
        }
        let targets: Vec<String> = data.targets().unwrap_or_default().iter().map(|a| a.name().to_string()).collect();
        if targets.is_empty() {
            return;
        }
        if targets.iter().any(|t| t == PASSWORD_HINT) {
            cb.request_contents(&atom(PASSWORD_HINT), move |cb, hint| {
                if current(generation) && !super::is_secret(Some(&hint.data())) {
                    read(cb, targets, source, generation);
                }
            });
        } else {
            read(cb, targets, source, generation);
        }
    });
}

fn read(cb: &gtk::Clipboard, targets: Vec<String>, source: Option<String>, generation: u64) {
    let has = |t: &str| targets.iter().any(|x| x == t);
    if has(GNOME_FILES) || has(URI_LIST) {
        let gnome = has(GNOME_FILES);
        cb.request_contents(&atom(if gnome { GNOME_FILES } else { URI_LIST }), move |_, data| {
            if !current(generation) {
                return;
            }
            let raw = String::from_utf8_lossy(&data.data()).into_owned();
            // GNOME's list starts with "copy" or "cut"; a URI list may carry # comments.
            let uris: Vec<String> = raw.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#') && *l != "copy" && *l != "cut").map(String::from).collect();
            if !uris.is_empty() {
                super::add(files_item(uris, source));
            }
        });
        return;
    }
    if TEXT_TARGETS.iter().any(|t| has(t)) {
        let want_html = has(HTML);
        cb.request_text(move |cb, text| {
            if !current(generation) {
                return;
            }
            let Some(text) = text.map(str::to_string).filter(|t| !t.trim().is_empty() && t.len() <= super::MAX_TEXT) else { return };
            let mut item = Item { hash: super::hash_of("text", text.as_bytes()), text, source, ..super::blank("text") };
            if !want_html {
                return super::add(item);
            }
            cb.request_contents(&atom(HTML), move |_, data| {
                if !current(generation) {
                    return;
                }
                item.html = decode_html(&data.data()).filter(|h| h.len() <= super::MAX_HTML && !h.trim().is_empty());
                super::add(item);
            });
        });
        return;
    }
    if targets.iter().any(|t| t.starts_with("image/")) {
        cb.request_image(move |_, pixbuf| {
            if !current(generation) {
                return;
            }
            if let Some(pixbuf) = pixbuf {
                if let Some(item) = image_item(pixbuf, source) {
                    super::add(item);
                }
            }
        });
    }
}

/// HTML as browsers put it on the clipboard: UTF-8, or UTF-16 with a byte-order mark (Firefox).
fn decode_html(bytes: &[u8]) -> Option<String> {
    if bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16(&units).ok();
    }
    Some(String::from_utf8_lossy(bytes).trim_end_matches('\0').to_string())
}

fn files_item(uris: Vec<String>, source: Option<String>) -> Item {
    let paths: Vec<String> = uris
        .iter()
        .map(|u| url::Url::parse(u).ok().and_then(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| u.clone()))
        .collect();
    Item { hash: super::hash_of("files", uris.join("\n").as_bytes()), text: paths.join("\n"), uris, source, ..super::blank("files") }
}

fn image_item(pixbuf: &gdk_pixbuf::Pixbuf, source: Option<String>) -> Option<Item> {
    let (w, h) = (pixbuf.width().max(0) as u32, pixbuf.height().max(0) as u32);
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > super::MAX_PIXELS {
        return None;
    }
    let pixels = pixbuf.read_pixel_bytes();
    let mut key = pixels.to_vec();
    key.extend_from_slice(&w.to_le_bytes());
    let dir = super::image_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let name = format!("{}.png", new_id());
    if let Err(err) = pixbuf.savev(dir.join(&name), "png", &[]) {
        eprintln!("Couldn't keep a copied picture: {err}");
        return None;
    }
    Some(Item { hash: super::hash_of("image", &key), image: Some(name), width: Some(w), height: Some(h), source, ..super::blank("image") })
}

/// What to put on the clipboard.
pub enum Content {
    /// A history item (its picture as a full path).
    Item(Item),
    /// Plain text (an emoji or a symbol).
    Text(String),
}

/// Puts something on the clipboard (main thread). Text keeps its HTML; files go as GNOME's and
/// the standard URI list, so file managers paste them as files and editors as paths.
pub fn put(content: Content) -> Result<(), String> {
    let cb = CLIPBOARD.with(|c| c.borrow().clone()).ok_or("The clipboard isn't available.")?;
    OWN_PUT.store(now() + 2000, Ordering::SeqCst);
    let flags = gtk::TargetFlags::empty();
    match content {
        Content::Text(text) => cb.set_text(&text),
        Content::Item(item) => match item.kind.as_str() {
            "image" => {
                let path = item.image.ok_or("That picture is gone.")?;
                let pixbuf = gdk_pixbuf::Pixbuf::from_file(&path).map_err(|e| format!("Couldn't read the picture: {e}"))?;
                cb.set_image(&pixbuf);
            }
            "files" => {
                let mut targets = vec![gtk::TargetEntry::new(GNOME_FILES, flags, 0), gtk::TargetEntry::new(URI_LIST, flags, 1)];
                targets.extend(TEXT_TARGETS.iter().map(|t| gtk::TargetEntry::new(t, flags, 2)));
                let (uris, paths) = (item.uris, item.text);
                cb.set_with_data(&targets, move |_, data, info| match info {
                    0 => data.set(&atom(GNOME_FILES), 8, format!("copy\n{}", uris.join("\n")).as_bytes()),
                    1 => {
                        data.set_uris(&uris.iter().map(String::as_str).collect::<Vec<_>>());
                    }
                    _ => {
                        data.set_text(&paths);
                    }
                });
            }
            _ => match item.html {
                Some(html) => {
                    let mut targets = vec![gtk::TargetEntry::new(HTML, flags, 0)];
                    targets.extend(TEXT_TARGETS.iter().map(|t| gtk::TargetEntry::new(t, flags, 1)));
                    let text = item.text;
                    cb.set_with_data(&targets, move |_, data, info| {
                        if info == 0 {
                            data.set(&atom(HTML), 8, html.as_bytes());
                        } else {
                            data.set_text(&text);
                        }
                    });
                }
                None => cb.set_text(&item.text),
            },
        },
    }
    // The owner change reaches the watcher too, which moves the item to the top, as Win+V does.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_in_either_encoding() {
        assert_eq!(decode_html(b"<b>hi</b>\0").as_deref(), Some("<b>hi</b>"));
        let utf16: Vec<u8> = [0xff, 0xfe].into_iter().chain("<i>ক</i>".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        assert_eq!(decode_html(&utf16).as_deref(), Some("<i>ক</i>"));
    }

    #[test]
    fn copied_files_read_as_paths() {
        let item = files_item(vec!["file:///home/me/a%20b.txt".into(), "file:///tmp/c.png".into()], None);
        assert_eq!(item.text, "/home/me/a b.txt\n/tmp/c.png");
        assert_eq!(item.kind, "files");
    }
}
