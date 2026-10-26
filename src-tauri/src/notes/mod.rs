//! Sticky notes. The notes live here, in one store every window shares: the Notes section, and
//! each note floating in its own small window. Changes go out to all windows as `notes-changed`
//! and wake the sync (`sync.rs`), which keeps a folder of Markdown files in step.
//!
//! Saved in the app's data folder as `notes/notes.json`, with where each note's window was.

mod format;
pub(crate) mod quick;
pub(crate) mod sync;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{Emitter, Manager};

/// Deleted notes stay in Recently Deleted this long.
const KEEP_DELETED_MS: i64 = 30 * 24 * 3_600_000;

/// New notes take these colours in turn, so notes side by side tell apart at a glance. (Gray and
/// charcoal are there to pick by hand.)
const NEW_NOTE_COLORS: [&str; 5] = ["yellow", "green", "pink", "purple", "blue"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Note {
    /// 32 hex digits.
    pub id: String,
    /// Shown above the text; "" for none.
    #[serde(default)]
    pub title: String,
    /// Markdown, read line by line (see `src/notes/markdown.ts`).
    pub body: String,
    /// One of `format::COLORS`.
    pub color: String,
    #[serde(default)]
    pub pinned: bool,
    /// The Kanban column it is in (a column's name); `None` for none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Where it was dragged to, among the others: higher comes first. `None` until it's moved; it
    /// then sorts by `created`, so new notes come first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    /// Milliseconds since the epoch.
    pub created: i64,
    pub updated: i64,
    /// When it went to Recently Deleted; `None` while it's a live note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<i64>,
}

/// Where a note's window was on this computer. Not synced: another computer has its own screen.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NoteWindow {
    /// The window was open when CorePro last ran, so it opens again at the next start.
    #[serde(default)]
    pub open: bool,
    /// Logical pixels.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    #[serde(default)]
    pub on_top: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    notes: Vec<Note>,
    #[serde(default)]
    windows: HashMap<String, NoteWindow>,
}

struct Store {
    path: PathBuf,
    saved: Saved,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn store() -> MutexGuard<'static, Store> {
    STORE.get().expect("notes::init runs at startup").lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 128 random bits as 32 hex digits.
pub fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let part = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

/// Loads the notes and starts the sync. `dir` is the app's data folder.
pub fn init(app: tauri::AppHandle, dir: PathBuf) {
    let dir = dir.join("notes");
    let path = dir.join("notes.json");
    let mut saved: Saved = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let cutoff = now() - KEEP_DELETED_MS;
    saved.notes.retain(|n| n.deleted.is_none_or(|d| d > cutoff));
    let _ = STORE.set(Mutex::new(Store { path, saved }));
    let _ = APP.set(app);
    sync::start(dir);
}

impl Store {
    fn save(&self) {
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = self.path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&self.saved)?)?;
            std::fs::rename(&tmp, &self.path)
        };
        if let Err(err) = write() {
            eprintln!("Saving notes failed: {err}");
        }
    }

    fn get_mut(&mut self, id: &str) -> Result<&mut Note, String> {
        self.saved.notes.iter_mut().find(|n| n.id == id).ok_or_else(|| "That note no longer exists.".to_string())
    }
}

#[derive(Serialize, Clone)]
struct Changed {
    /// Notes added or changed (a deleted one has `deleted` set).
    notes: Vec<Note>,
    /// Ids of notes gone for good.
    removed: Vec<String>,
    /// The window that made the change, which already shows it.
    origin: Option<String>,
}

/// Saves, tells every window, and wakes the sync.
fn changed(store: &Store, notes: Vec<Note>, removed: Vec<String>, origin: Option<String>) {
    store.save();
    if let Some(app) = APP.get() {
        let _ = app.emit("notes-changed", Changed { notes, removed, origin });
    }
    sync::kick();
}

// ---- commands ---------------------------------------------------------------------------------

#[tauri::command]
pub fn notes_list() -> Result<Vec<Note>, String> {
    crate::ensure_unlocked()?;
    Ok(store().saved.notes.clone())
}

#[tauri::command]
pub fn notes_get(id: String) -> Result<Option<Note>, String> {
    crate::ensure_unlocked()?;
    Ok(store().saved.notes.iter().find(|n| n.id == id).cloned())
}

#[tauri::command]
pub fn notes_create(color: Option<String>, body: Option<String>, status: Option<String>, origin: Option<String>) -> Result<Note, String> {
    crate::ensure_unlocked()?;
    Ok(create(color, body, status, origin))
}

/// A one-line title, as typed or pasted.
fn clean_title(title: &str) -> String {
    title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect()
}

/// A Kanban column's name; "" means no status.
fn clean_status(status: &str) -> Option<String> {
    let status = clean_title(status).chars().take(60).collect::<String>();
    (!status.is_empty()).then_some(status)
}

/// A new note; without a colour, it takes the next one after the newest note's.
fn create(color: Option<String>, body: Option<String>, status: Option<String>, origin: Option<String>) -> Note {
    let at = now();
    let mut store = store();
    let note = Note {
        id: new_id(),
        title: String::new(),
        body: body.unwrap_or_default(),
        color: color.filter(|c| format::COLORS.contains(&c.as_str())).unwrap_or_else(|| next_color(&store.saved.notes)),
        pinned: false,
        status: status.as_deref().and_then(clean_status),
        position: None,
        created: at,
        updated: at,
        deleted: None,
    };
    store.saved.notes.push(note.clone());
    changed(&store, vec![note.clone()], vec![], origin);
    note
}

fn next_color(notes: &[Note]) -> String {
    let newest = notes.iter().filter(|n| n.deleted.is_none()).max_by_key(|n| n.created);
    let at = newest.and_then(|n| NEW_NOTE_COLORS.iter().position(|c| *c == n.color));
    NEW_NOTE_COLORS[at.map_or(0, |i| (i + 1) % NEW_NOTE_COLORS.len())].to_string()
}

/// Changes what's given; `status: ""` takes the note out of every Kanban column.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn notes_update(
    id: String,
    title: Option<String>,
    body: Option<String>,
    color: Option<String>,
    pinned: Option<bool>,
    status: Option<String>,
    position: Option<f64>,
    origin: Option<String>,
) -> Result<Note, String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let note = store.get_mut(&id)?;
    let before = note.clone();
    if let Some(title) = title {
        note.title = clean_title(&title);
    }
    if let Some(body) = body {
        note.body = body.trim_end_matches('\n').to_string();
    }
    if let Some(status) = status {
        note.status = clean_status(&status);
    }
    if let Some(position) = position.filter(|p| p.is_finite()) {
        note.position = Some(position);
    }
    if let Some(color) = color.filter(|c| format::COLORS.contains(&c.as_str())) {
        note.color = color;
    }
    if let Some(pinned) = pinned {
        note.pinned = pinned;
    }
    if *note == before {
        return Ok(before);
    }
    // Moving a note among the others isn't editing it.
    let moved_only = Note { position: before.position, ..note.clone() } == before;
    if !moved_only {
        note.updated = now().max(before.updated + 1);
    }
    let note = note.clone();
    changed(&store, vec![note.clone()], vec![], origin);
    Ok(note)
}

/// Moves a note to Recently Deleted and closes its window.
#[tauri::command]
pub fn notes_delete(id: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let note = store.get_mut(&id)?;
    note.deleted = Some(now());
    let note = note.clone();
    store.saved.windows.entry(id.clone()).or_default().open = false;
    changed(&store, vec![note], vec![], None);
    drop(store);
    if let Some(window) = APP.get().and_then(|app| app.get_webview_window(&window_label(&id))) {
        let _ = window.destroy();
    }
    Ok(())
}

/// Brings a note back from Recently Deleted.
#[tauri::command]
pub fn notes_restore(id: String) -> Result<Note, String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let note = store.get_mut(&id)?;
    note.deleted = None;
    // Newer than the deletion, so the sync puts it back in the folder too.
    note.updated = now().max(note.updated + 1);
    let note = note.clone();
    changed(&store, vec![note.clone()], vec![], None);
    Ok(note)
}

/// Removes notes from Recently Deleted for good (all of them when `ids` is empty).
#[tauri::command]
pub fn notes_purge(ids: Vec<String>) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let mut removed = Vec::new();
    store.saved.notes.retain(|n| {
        let gone = n.deleted.is_some() && (ids.is_empty() || ids.contains(&n.id));
        if gone {
            removed.push(n.id.clone());
        }
        !gone
    });
    for id in &removed {
        store.saved.windows.remove(id);
    }
    changed(&store, vec![], removed, None);
    Ok(())
}

// ---- note windows -----------------------------------------------------------------------------

fn window_label(id: &str) -> String {
    format!("note-{id}")
}

/// The window colour while the page loads, so a note never flashes dark: the light theme's paper.
fn paper(color: &str) -> tauri::webview::Color {
    let (r, g, b) = match color {
        "green" => (0xe4, 0xf9, 0xe0),
        "pink" => (0xff, 0xe4, 0xf1),
        "purple" => (0xf2, 0xe6, 0xff),
        "blue" => (0xe2, 0xf1, 0xff),
        "gray" => (0xf3, 0xf2, 0xf1),
        "charcoal" => (0x3b, 0x3a, 0x39),
        _ => (0xff, 0xf7, 0xd1),
    };
    tauri::webview::Color(r, g, b, 0xff)
}

#[tauri::command]
pub fn notes_window(id: String) -> NoteWindow {
    store().saved.windows.get(&id).cloned().unwrap_or_default()
}

/// Remembers where a note's window is, whether it stays on top and whether it is open.
#[tauri::command]
pub fn notes_set_window(id: String, state: NoteWindow) {
    let mut store = store();
    if !store.saved.notes.iter().any(|n| n.id == id) {
        return;
    }
    store.saved.windows.insert(id, state);
    store.save();
}

/// Shows a note in its own window, or brings its window forward.
#[tauri::command]
pub async fn notes_open(app: tauri::AppHandle, id: String) -> Result<(), String> {
    open_window(&app, &id)
}

fn open_window(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let label = window_label(id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let (note, mut state) = {
        let store = store();
        let note = store.saved.notes.iter().find(|n| n.id == id && n.deleted.is_none()).cloned();
        (note.ok_or("That note no longer exists.")?, store.saved.windows.get(id).cloned().unwrap_or_default())
    };
    let title = format::display_title(&note);
    let start = serde_json::json!({ "module": "note", "path": id });
    let mut builder = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .title(if title.is_empty() { "Note".to_string() } else { title })
        .inner_size(state.width.unwrap_or(320.0), state.height.unwrap_or(330.0))
        .min_inner_size(220.0, 150.0)
        .decorations(false)
        .always_on_top(state.on_top)
        .background_color(paper(&note.color))
        .initialization_script(format!("window.__COREPRO_WINDOW__ = {start};"));
    if let (Some(x), Some(y)) = (state.x, state.y) {
        builder = builder.position(x, y);
    }
    builder.build().map_err(|e| e.to_string())?;
    state.open = true;
    let mut store = store();
    store.saved.windows.insert(id.to_string(), state);
    store.save();
    Ok(())
}

/// Shows the notes list: the Notes section of the main window, or a window of its own when the main
/// window was closed.
#[tauri::command]
pub async fn notes_show_list(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        return main.emit("notes-show-list", ()).map_err(|e| e.to_string());
    }
    crate::new_window(&app, "notes", None, None)
}

/// Opens the notes whose windows were open when CorePro last ran; once per run.
#[tauri::command]
pub async fn notes_reopen(app: tauri::AppHandle) -> Result<(), String> {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let ids: Vec<String> = {
        let store = store();
        store
            .saved
            .notes
            .iter()
            .filter(|n| n.deleted.is_none() && store.saved.windows.get(&n.id).is_some_and(|w| w.open))
            .map(|n| n.id.clone())
            .collect()
    };
    for id in ids {
        if let Err(err) = open_window(&app, &id) {
            eprintln!("Could not reopen a note: {err}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(color: &str, created: i64, deleted: bool) -> Note {
        Note { id: new_id(), title: String::new(), body: String::new(), color: color.into(), pinned: false, status: None, position: None, created, updated: created, deleted: deleted.then_some(created) }
    }

    #[test]
    fn new_notes_take_colours_in_turn() {
        assert_eq!(next_color(&[]), "yellow");
        assert_eq!(next_color(&[note("yellow", 1, false)]), "green");
        assert_eq!(next_color(&[note("pink", 2, false), note("green", 1, false)]), "purple");
        assert_eq!(next_color(&[note("blue", 1, false)]), "yellow");
        // A colour picked by hand restarts the turn; deleted notes don't count.
        assert_eq!(next_color(&[note("charcoal", 1, false)]), "yellow");
        assert_eq!(next_color(&[note("green", 1, false), note("purple", 2, true)]), "pink");
    }
}
