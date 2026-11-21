//! TV: the DhakaFlix media servers (movies and series behind nginx directory listings) as a
//! catalog to browse and play, and Live TV from the user's own M3U playlists. The page can't reach
//! the servers (no CORS, and the CSP only allows the app's own scheme), so this reads them: names
//! become catalog items (`names.rs`, `crawl.rs`), posters and logos are cached on disk and shown
//! through the `cs:` file scheme, and the video links go to the Video player as http URLs.

mod catalog;
mod crawl;
mod listing;
mod live;
mod names;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use catalog::{Filter, Item};
use listing::Category;

pub type Result<T> = std::result::Result<T, String>;

const REFRESH_AFTER_MS: i64 = 4 * 3600 * 1000;
const PARALLEL: usize = 6;

struct State {
    app: AppHandle,
    conn: Mutex<Connection>,
    /// `<cache>/tv`: posters/ and logos/.
    cache: PathBuf,
    running: AtomicBool,
    cancel: AtomicBool,
    progress: Mutex<Progress>,
    /// At most `PARALLEL` requests to the servers from looks inside folders.
    gate: (Mutex<usize>, Condvar),
}

static STATE: OnceLock<State> = OnceLock::new();

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn state() -> Result<&'static State> {
    STATE.get().ok_or_else(|| "TV isn't available".to_string())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn init(app: AppHandle, data_dir: PathBuf, cache_dir: PathBuf) {
    let conn = match catalog::open(&data_dir.join("tv.db")) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("TV: {err}");
            return;
        }
    };
    let last = catalog::meta_get(&conn, "last_crawl").and_then(|v| v.parse().ok()).unwrap_or(0);
    let _ = STATE.set(State {
        app,
        conn: Mutex::new(conn),
        cache: cache_dir.join("tv"),
        running: AtomicBool::new(false),
        cancel: AtomicBool::new(false),
        progress: Mutex::new(Progress { last_crawl: last, ..Default::default() }),
        gate: (Mutex::new(0), Condvar::new()),
    });
}

impl State {
    fn db(&self) -> MutexGuard<'_, Connection> {
        lock(&self.conn)
    }
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        let _ = self.app.emit(event, payload);
    }
    fn permit(&self) -> Permit<'_> {
        let (count, cv) = &self.gate;
        let mut n = lock(count);
        while *n >= PARALLEL {
            n = cv.wait(n).unwrap_or_else(|e| e.into_inner());
        }
        *n += 1;
        Permit(self)
    }
    fn set_progress(&self, f: impl FnOnce(&mut Progress)) {
        let snapshot = {
            let mut p = lock(&self.progress);
            f(&mut p);
            p.items = catalog::count(&self.db());
            p.clone()
        };
        self.emit("tv-progress", snapshot);
    }
}

struct Permit<'a>(&'a State);
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let (count, cv) = &self.0.gate;
        *lock(count) -= 1;
        cv.notify_one();
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub items: i64,
    /// None until a crawl has tried; false when no server answered.
    pub reachable: Option<bool>,
    pub error: String,
    pub last_crawl: i64,
}

fn unreachable_text(origin: &str) -> String {
    let host = origin.split("://").nth(1).unwrap_or(origin);
    format!("Can't reach DhakaFlix at {host} — are you on the ISP's network?")
}

// ---- discovery and the crawl ------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub reachable: bool,
    pub error: String,
    pub categories: Vec<Category>,
}

fn portal_url(portal: &str) -> String {
    let p = portal.trim();
    let p = if p.contains("://") { p.to_string() } else { format!("http://{p}") };
    if p.matches('/').count() < 3 {
        format!("{p}/")
    } else {
        p
    }
}

fn discover_blocking(portal: &str) -> Discovered {
    let url = portal_url(portal);
    let origin = listing::split_url(&url).map(|(o, _)| o).unwrap_or_else(|| url.clone());
    match listing::get_bytes(&listing::lan_agent(), &url, 2 << 20) {
        Ok(page) => {
            let found = listing::discover(&String::from_utf8_lossy(&page), &url);
            Discovered { reachable: true, error: String::new(), categories: if found.is_empty() { listing::default_categories() } else { found } }
        }
        Err(_) => Discovered { reachable: false, error: unreachable_text(&origin), categories: Vec::new() },
    }
}

#[tauri::command]
pub async fn tv_discover(portal: String) -> Result<Discovered> {
    tauri::async_runtime::spawn_blocking(move || discover_blocking(&portal)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tv_state() -> Result<Progress> {
    Ok(lock(&state()?.progress).clone())
}

/// Starts (or skips, when the catalog is fresh) a crawl of the enabled categories of the sources.
/// `overrides` maps a category URL to the user's on/off choice; the default is `default_on`.
#[tauri::command]
pub fn tv_start(portals: Vec<String>, overrides: HashMap<String, bool>, force: bool) -> Result<Progress> {
    let st = state()?;
    if st.running.swap(true, Ordering::SeqCst) {
        return Ok(lock(&st.progress).clone());
    }
    st.cancel.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        run_crawl(st, portals, overrides, force);
        st.running.store(false, Ordering::SeqCst);
        st.set_progress(|p| p.running = false);
        st.emit("tv-changed", ());
    });
    Ok(lock(&st.progress).clone())
}

fn run_crawl(st: &'static State, portals: Vec<String>, overrides: HashMap<String, bool>, force: bool) {
    st.set_progress(|p| {
        p.running = true;
        p.done = 0;
        p.total = 0;
        p.error.clear();
    });
    let mut cats: Vec<Category> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for portal in &portals {
        let found = discover_blocking(portal);
        if !found.reachable {
            failed.push(found.error);
        }
        for c in found.categories {
            if !cats.iter().any(|x| x.url == c.url) {
                cats.push(c);
            }
        }
    }
    cats.retain(|c| overrides.get(&c.url).copied().unwrap_or(c.default_on));
    let wanted: Vec<String> = cats.iter().map(|c| c.url.clone()).collect();
    let signature = wanted.join("|");
    let (fresh, same, have) = {
        let db = st.db();
        let last: i64 = catalog::meta_get(&db, "last_crawl").and_then(|v| v.parse().ok()).unwrap_or(0);
        (now_ms() - last < REFRESH_AFTER_MS, catalog::meta_get(&db, "signature").as_deref() == Some(signature.as_str()), catalog::count(&db) > 0)
    };
    if !failed.is_empty() && cats.is_empty() {
        st.set_progress(|p| {
            p.reachable = Some(false);
            p.error = failed[0].clone();
        });
        return;
    }
    if !force && fresh && same && have {
        st.set_progress(|p| p.reachable = Some(true));
        return;
    }
    if portals.is_empty() || cats.is_empty() {
        catalog::keep_categories(&st.db(), &wanted);
        st.set_progress(|p| p.reachable = Some(true));
        return;
    }
    catalog::keep_categories(&st.db(), &wanted);
    let stamp = now_ms();
    let next = AtomicUsize::new(0);
    let reached = AtomicBool::new(false);
    let complete = AtomicBool::new(true);
    let last_emit = Mutex::new(std::time::Instant::now());
    st.set_progress(|p| p.total = cats.len());
    std::thread::scope(|scope| {
        for _ in 0..4.min(cats.len()) {
            scope.spawn(|| {
                let agent = listing::lan_agent();
                loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(cat) = cats.get(i) else { break };
                    let mut sink = |items: Vec<catalog::NewItem>| {
                        let _ = catalog::upsert(&mut st.db(), &items, stamp);
                        let mut at = lock(&last_emit);
                        if at.elapsed() > std::time::Duration::from_millis(400) {
                            *at = std::time::Instant::now();
                            st.set_progress(|_| {});
                            st.emit("tv-changed", ());
                        }
                    };
                    match crawl::walk(&agent, cat, &mut sink, &|| st.cancel.load(Ordering::SeqCst)) {
                        Ok(done) => {
                            reached.store(true, Ordering::SeqCst);
                            if done {
                                catalog::prune(&st.db(), &cat.url, stamp);
                            } else {
                                complete.store(false, Ordering::SeqCst);
                            }
                        }
                        Err(err) => {
                            eprintln!("[tv] {}: {err}", cat.url);
                            complete.store(false, Ordering::SeqCst);
                        }
                    }
                    st.set_progress(|p| p.done += 1);
                }
            });
        }
    });
    let ok = reached.load(Ordering::SeqCst);
    let all = complete.load(Ordering::SeqCst);
    {
        let db = st.db();
        if ok && all {
            catalog::meta_set(&db, "last_crawl", &stamp.to_string());
            catalog::meta_set(&db, "signature", &signature);
        }
    }
    st.set_progress(|p| {
        p.reachable = Some(ok);
        if ok && all {
            p.last_crawl = stamp;
        }
        p.error = if !ok { failed.first().cloned().unwrap_or_else(|| unreachable_text(&portals[0])) } else if !failed.is_empty() { failed[0].clone() } else { String::new() };
    });
    if ok {
        prefetch(st);
    }
}

/// The newest titles get their poster before anyone scrolls to them, so Home opens complete.
fn prefetch(st: &'static State) {
    let ids: Vec<String> = {
        let f = Filter { limit: Some(48), ..Default::default() };
        catalog::query(&st.db(), &f).map(|(items, _)| items).unwrap_or_default().into_iter().filter(|i| i.poster.is_none() && !i.no_poster).map(|i| i.id).collect()
    };
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(id) = ids.get(i) else { break };
                if st.cancel.load(Ordering::SeqCst) {
                    break;
                }
                if resolve_blocking(st, id).is_ok() && i % 6 == 5 {
                    st.emit("tv-changed", ());
                }
            });
        }
    });
    st.emit("tv-changed", ());
}

// ---- looking inside a title --------------------------------------------------------------------

fn resolve_blocking(st: &'static State, id: &str) -> Result<Item> {
    let item = catalog::get(&st.db(), id).ok_or("That title isn't in the catalog any more")?;
    let (stored_poster, resolved) = catalog::poster_state(&st.db(), id).unwrap_or_default();
    let poster_gone = !stored_poster.is_empty() && item.poster.is_none();
    if resolved && !poster_gone {
        return Ok(item);
    }
    let _permit = st.permit();
    let agent = listing::lan_agent();
    let found = crawl::inspect(&agent, &st.cache, id, &item.folder_url, true)?;
    catalog::set_resolved(&st.db(), id, &found)?;
    catalog::get(&st.db(), id).ok_or_else(|| "That title isn't in the catalog any more".to_string())
}

/// A title with its video link and poster: looks inside its folder the first time.
#[tauri::command]
pub async fn tv_resolve(id: String) -> Result<Item> {
    let st = state()?;
    tauri::async_runtime::spawn_blocking(move || resolve_blocking(st, &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tv_episodes(id: String) -> Result<Vec<crawl::Season>> {
    let st = state()?;
    tauri::async_runtime::spawn_blocking(move || {
        let item = catalog::get(&st.db(), &id).ok_or("That title isn't in the catalog any more")?;
        let _permit = st.permit();
        crawl::seasons(&listing::lan_agent(), &item.folder_url)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- the catalog for the pages -----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatRow {
    pub url: String,
    pub label: String,
    pub section: String,
    pub kind: String,
    pub count: i64,
    pub items: Vec<Item>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Home {
    pub hero: Vec<Item>,
    pub recent: Vec<Item>,
    pub new: Vec<Item>,
    pub top: Vec<Item>,
    pub top_year: Option<i32>,
    pub categories: Vec<CatRow>,
    pub total: i64,
}

#[tauri::command]
pub fn tv_home() -> Result<Home> {
    let st = state()?;
    let db = st.db();
    let q = |f: Filter| catalog::query(&db, &f).map(|(items, _)| items);
    let newest = q(Filter { kind: Some("movie".into()), limit: Some(40), ..Default::default() })?;
    let (mut hero, rest): (Vec<Item>, Vec<Item>) = newest.into_iter().partition(|i| i.poster.is_some());
    hero.truncate(7);
    if hero.len() < 5 {
        hero.extend(rest.iter().take(5 - hero.len()).cloned());
    }
    let recent = q(Filter { played: true, sort: Some("played".into()), limit: Some(20), ..Default::default() })?;
    let new = q(Filter { limit: Some(30), ..Default::default() })?;
    let (years, _) = catalog::facets(&db, &Filter { kind: Some("movie".into()), ..Default::default() })?;
    let top_year = years.iter().find(|(y, n)| *n >= 10 && *y <= 2100).map(|(y, _)| *y).or(years.first().map(|(y, _)| *y));
    let top = match top_year {
        Some(y) => q(Filter { kind: Some("movie".into()), year: Some(y), limit: Some(10), ..Default::default() })?,
        None => Vec::new(),
    };
    let mut categories = Vec::new();
    for (url, label, section, kind, count) in catalog::categories(&db)? {
        let sort = if label.to_lowercase().contains("imdb") { "rank" } else { "new" };
        let items = q(Filter { category_url: Some(url.clone()), sort: Some(sort.into()), limit: Some(24), ..Default::default() })?;
        categories.push(CatRow { url, label, section, kind, count, items });
    }
    let total = catalog::count(&db);
    drop(db);
    // posters for what the hero and the first rows show, in the background
    let want: Vec<String> = hero.iter().chain(top.iter()).chain(new.iter().take(12)).filter(|i| i.poster.is_none() && !i.no_poster).map(|i| i.id.clone()).collect();
    if !want.is_empty() {
        std::thread::spawn(move || {
            for id in want.iter().take(20) {
                if resolve_blocking(st, id).is_ok() {
                    st.emit("tv-changed", ());
                }
            }
        });
    }
    Ok(Home { hero, recent, new, top, top_year, categories, total })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Item>,
    pub total: i64,
    pub years: Vec<(i32, i64)>,
    pub qualities: Vec<(String, i64)>,
}

#[tauri::command]
pub fn tv_items(filter: Filter, facets: Option<bool>) -> Result<Page> {
    let db = state()?.db();
    let (items, total) = catalog::query(&db, &filter)?;
    let (years, qualities) = if facets == Some(true) { catalog::facets(&db, &filter)? } else { Default::default() };
    Ok(Page { items, total, years, qualities })
}

#[tauri::command]
pub fn tv_played(id: String) -> Result<()> {
    catalog::touch_played(&state()?.db(), &id, now_ms());
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub bytes: u64,
    pub files: usize,
    pub items: i64,
    pub channels: usize,
    pub cap: u64,
}

#[tauri::command]
pub fn tv_cache_info() -> Result<CacheInfo> {
    let st = state()?;
    let (pb, pf) = crawl::dir_size(&st.cache.join("posters"));
    let (lb, lf) = crawl::dir_size(&st.cache.join("logos"));
    let db = st.db();
    Ok(CacheInfo { bytes: pb + lb, files: pf + lf, items: catalog::count(&db), channels: live::list(&db).map(|c| c.len()).unwrap_or(0), cap: crawl::POSTER_CAP })
}

/// Deletes the cached posters and logos (they download again when shown). `catalog` also forgets
/// the catalog itself, so the next refresh reads the servers afresh.
#[tauri::command]
pub fn tv_clear_cache(catalog_too: Option<bool>) -> Result<()> {
    let st = state()?;
    for sub in ["posters", "logos"] {
        let _ = std::fs::remove_dir_all(st.cache.join(sub));
    }
    let db = st.db();
    catalog::forget_posters(&db);
    live::clear_logos(&db);
    if catalog_too == Some(true) {
        let _ = db.execute("DELETE FROM items", []);
        catalog::meta_set(&db, "last_crawl", "0");
    }
    Ok(())
}

// ---- live TV -----------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SourceResult {
    pub id: String,
    pub count: usize,
    pub error: String,
}

/// Reads the playlists again (and forgets the ones that were removed).
#[tauri::command]
pub async fn tv_live_refresh(sources: Vec<live::Source>) -> Result<Vec<SourceResult>> {
    let st = state()?;
    tauri::async_runtime::spawn_blocking(move || {
        live::remove_other_sources(&st.db(), &sources.iter().map(|s| s.id.clone()).collect::<Vec<_>>());
        let mut out = Vec::new();
        for s in &sources {
            let result = live::fetch(&s.url).map(|text| live::parse_m3u(&text)).and_then(|parsed| {
                if parsed.is_empty() {
                    Err("There are no channels in that list".to_string())
                } else {
                    live::store(&mut st.db(), &s.id, &parsed)
                }
            });
            match result {
                Ok(count) => out.push(SourceResult { id: s.id.clone(), count, error: String::new() }),
                Err(error) => out.push(SourceResult { id: s.id.clone(), count: 0, error }),
            }
        }
        st.emit("tv-live-changed", ());
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tv_live_channels() -> Result<Vec<live::Channel>> {
    live::list(&state()?.db())
}

#[tauri::command]
pub fn tv_live_fav(id: String, on: bool) -> Result<()> {
    live::set_fav(&state()?.db(), &id, on);
    Ok(())
}

#[tauri::command]
pub fn tv_live_watched(id: String) -> Result<()> {
    live::mark_watched(&state()?.db(), &id, now_ms());
    Ok(())
}

/// A channel's logo as a file in the cache (None when it has none or isn't a picture).
#[tauri::command]
pub async fn tv_live_logo(id: String) -> Result<Option<String>> {
    let st = state()?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some((_, logo_url, logo, _)) = live::lookup(&st.db(), &id) else { return Ok(None) };
        if !logo.is_empty() && std::path::Path::new(&logo).exists() {
            return Ok(Some(logo));
        }
        if logo_url.is_empty() {
            return Ok(None);
        }
        let _permit = st.permit();
        let path = live::fetch_logo(&st.cache.join("logos"), &logo_url).unwrap_or(None);
        if let Some(p) = &path {
            live::set_logo(&st.db(), &id, &p.to_string_lossy());
        }
        Ok(path.map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
pub struct ChannelStatus {
    pub id: String,
    pub status: String,
}

/// Checks whether channels answer (3 s each, six at a time; ones checked in the last ten minutes
/// are left alone) and says so per channel through `tv-live-status`.
#[tauri::command]
pub async fn tv_live_probe(ids: Vec<String>, force: Option<bool>) -> Result<usize> {
    let st = state()?;
    tauri::async_runtime::spawn_blocking(move || {
        let now = now_ms();
        let todo: Vec<(String, String)> = ids
            .into_iter()
            .filter_map(|id| live::lookup(&st.db(), &id).map(|(url, _, _, checked)| (id, url, checked)))
            .filter(|(_, _, checked)| force == Some(true) || now - checked > 10 * 60 * 1000)
            .map(|(id, url, _)| (id, url))
            .collect();
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..PARALLEL.min(todo.len()) {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some((id, url)) = todo.get(i) else { break };
                    let status = if live::probe(url) { "online" } else { "offline" };
                    live::set_status(&st.db(), id, status, now_ms());
                    st.emit("tv-live-status", ChannelStatus { id: id.clone(), status: status.to_string() });
                });
            }
        });
        Ok(todo.len())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- a live check against the real server (run by hand) ------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// `cargo test --lib tv::tests::live_crawl -- --ignored --nocapture` on the ISP's network.
    #[test]
    #[ignore]
    fn live_crawl() {
        let agent = listing::lan_agent();
        let cat = Category {
            url: "http://172.16.50.14/DHAKA-FLIX-14/English%20Movies%20%281080p%29/%282025%29%201080p/".into(),
            label: "English Movies 1080p".into(),
            section: "movies".into(),
            series: false,
            default_on: true,
        };
        let mut items = Vec::new();
        let complete = crawl::walk(&agent, &cat, &mut |batch| items.extend(batch), &|| false).expect("the server answers");
        println!("crawled {} titles (complete: {complete})", items.len());
        let mut c = Connection::open_in_memory().unwrap();
        catalog::init(&c).unwrap();
        println!("{} new in the catalog", catalog::upsert(&mut c, &items, 1).unwrap());
        for it in items.iter().take(3) {
            println!("  {:?}", it);
        }
        let dir = std::env::temp_dir().join(format!("zazabor-tv-live-crawl-{}", std::process::id()));
        for it in items.iter().take(2) {
            let id = catalog::make_id(&it.folder_url);
            let found = crawl::inspect(&agent, &dir, &id, &it.folder_url, true).expect("a look inside works");
            println!("  {} -> video {} ({} bytes), poster {}", it.title, found.video_url, found.size, found.poster);
            assert!(std::path::Path::new(&found.poster).exists());
        }
        let page = listing::get_bytes(&agent, "http://172.16.50.14/", 2 << 20).expect("front page");
        let cats = listing::discover(&String::from_utf8_lossy(&page), "http://172.16.50.14/");
        println!("front page lists {} categories: {:?}", cats.len(), cats.iter().map(|c| c.label.as_str()).collect::<Vec<_>>());
        assert!(items.len() > 20);
    }

    /// Whole categories of other shapes: a ranked flat list, year folders without brackets, a flat series list.
    #[test]
    #[ignore]
    fn live_walk_shapes() {
        let agent = listing::lan_agent();
        for (label, url, series) in [
            ("IMDb Top 250", "http://172.16.50.14/DHAKA-FLIX-14/IMDb%20Top-250%20Movies/", false),
            ("Animation Movies", "http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies/", false),
            ("Korean TV & Web Series", "http://172.16.50.14/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/", true),
        ] {
            let (section, _) = listing::classify(label, url);
            let cat = Category { url: url.into(), label: label.into(), section, series, default_on: true };
            let mut items = Vec::new();
            let complete = crawl::walk(&agent, &cat, &mut |b| items.extend(b), &|| false).expect("answers");
            let ranked = items.iter().filter(|i| i.rank.is_some()).count();
            let years: std::collections::BTreeSet<_> = items.iter().filter_map(|i| i.year).collect();
            println!("{label}: {} titles, complete {complete}, {ranked} ranked, years {:?}..{:?}, first {:?}", items.len(), years.iter().next(), years.iter().next_back(), items.first().map(|i| (&i.title, &i.kind)));
            assert!(!items.is_empty());
        }
    }
}
