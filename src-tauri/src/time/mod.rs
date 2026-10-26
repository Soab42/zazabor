//! Time tracking (the Time section): checking in and out of a working day, time spent on tasks,
//! and the breaks, lunch, prayer, meetings and other activities in between. One store that every
//! window shares; each change goes out to all of them as `time-changed`.
//!
//! The rules live here, not in the page: one thing runs at a time, and nothing runs outside a
//! check-in. An activity started while a task timer runs pauses the timer, and ending the activity
//! starts it again. Entries never overlap. A day left checked in closes at its end.
//!
//! Saved in the app's data folder as `time/time.json`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::Emitter;

use crate::notes::{new_id, now};

/// What an entry can be besides work on a task.
pub const ACTIVITIES: [&str; 5] = ["short_break", "lunch", "prayer", "meeting", "other"];
const TASK_KINDS: [&str; 2] = ["development", "meeting"];
/// Times this far past our clock still count as now (the page's clock reads a little apart).
const SLACK_MS: i64 = 60_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Task {
    /// 32 hex digits.
    pub id: String,
    pub title: String,
    /// "" for none.
    #[serde(default)]
    pub project: String,
    /// One of `TASK_KINDS`.
    pub kind: String,
    /// Done tasks leave the timer's list of tasks in progress.
    #[serde(default)]
    pub done: bool,
    /// Milliseconds since the epoch, like every time here.
    pub created: i64,
}

/// One check-in, from checking in to checking out (`None` while still checked in).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub start: i64,
    pub end: Option<i64>,
}

/// Time on a task (`kind` "work") or an activity (one of `ACTIVITIES`); `end` is `None` while it runs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub kind: String,
    /// The task worked on (work only).
    #[serde(default)]
    pub task: Option<String>,
    /// A work log's note, or what an activity was.
    #[serde(default)]
    pub text: String,
    pub start: i64,
    pub end: Option<i64>,
    /// The task timer this activity paused, started again when the activity ends.
    #[serde(default)]
    pub paused_task: Option<String>,
}

impl Entry {
    /// An end within `SLACK_MS` past the clock becomes now.
    fn clamped(self, now: i64) -> Entry {
        let end = self.end.map(|e| e.min(now.max(self.start + 1)));
        Entry { end, ..self }
    }
}

/// The daily report: one per local day, a draft until submitted.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The local day, "YYYY-MM-DD".
    pub date: String,
    pub content: String,
    pub worked_min: u32,
    pub break_min: u32,
    pub idle_min: u32,
    /// "draft" or "submitted".
    pub status: String,
    #[serde(default)]
    pub updated: i64,
    #[serde(default)]
    pub submitted: Option<i64>,
}

#[derive(Serialize, Deserialize, Default, Debug)]
struct Saved {
    #[serde(default)]
    tasks: Vec<Task>,
    #[serde(default)]
    sessions: Vec<Session>,
    #[serde(default)]
    entries: Vec<Entry>,
    #[serde(default)]
    reports: Vec<Report>,
}

/// What the page shows for a span of time.
#[derive(Serialize)]
pub struct Data {
    tasks: Vec<Task>,
    /// Check-ins that reach into the span, oldest first.
    sessions: Vec<Session>,
    /// Entries that reach into the span, newest first.
    entries: Vec<Entry>,
    /// The check-in still open, wherever it falls.
    session: Option<Session>,
    /// What runs now, wherever it falls.
    running: Option<Entry>,
    /// Our clock.
    now: i64,
}

/// What `time_stop` stopped, and the task timer it started again (after an activity that paused it).
#[derive(Serialize)]
pub struct Stopped {
    stopped: Entry,
    resumed: Option<Entry>,
}

struct Store {
    path: PathBuf,
    saved: Saved,
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

fn store() -> MutexGuard<'static, Store> {
    STORE.get().expect("time::init runs at startup").lock().unwrap_or_else(|e| e.into_inner())
}

/// Loads the store and starts closing days left checked in. `dir` is the app's data folder.
pub fn init(app: tauri::AppHandle, dir: PathBuf) {
    let path = dir.join("time").join("time.json");
    let saved: Saved = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let _ = STORE.set(Mutex::new(Store { path, saved }));
    let _ = APP.set(app);
    std::thread::spawn(|| loop {
        {
            let mut store = store();
            if store.saved.close_stale(now()) {
                store.changed();
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(60));
    });
}

impl Store {
    /// Saves, and tells every window.
    fn changed(&self) {
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = self.path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(&self.saved)?)?;
            std::fs::rename(&tmp, &self.path)
        };
        if let Err(err) = write() {
            eprintln!("Saving time tracking failed: {err}");
        }
        if let Some(app) = APP.get() {
            let _ = app.emit("time-changed", ());
        }
    }
}

/// Runs a change; saves and tells the windows when it worked (or when a stale day was closed).
fn change<T>(f: impl FnOnce(&mut Saved, i64) -> Result<T, String>) -> Result<T, String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let at = now();
    let stale = store.saved.close_stale(at);
    let result = f(&mut store.saved, at);
    if stale || result.is_ok() {
        store.changed();
    }
    result
}

/// The last millisecond of the local day that `ms` falls on.
#[cfg(unix)]
fn day_end(ms: i64) -> i64 {
    let secs = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: localtime_r and mktime only read `secs` and read and write the `tm` handed to them.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return utc_day_end(ms);
        }
        tm.tm_hour = 23;
        tm.tm_min = 59;
        tm.tm_sec = 59;
        tm.tm_isdst = -1;
        let end = libc::mktime(&mut tm);
        if end == -1 {
            utc_day_end(ms)
        } else {
            end as i64 * 1000 + 999
        }
    }
}

#[cfg(not(unix))]
fn day_end(ms: i64) -> i64 {
    utc_day_end(ms)
}

fn utc_day_end(ms: i64) -> i64 {
    ms.div_euclid(86_400_000) * 86_400_000 + 86_399_999
}

/// A one-line name, as typed or pasted.
fn clean_line(text: &str, max: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// An entry as a sentence names it: "lunch", "a short break", "time on “Fix login”".
fn describe(entry: &Entry, tasks: &[Task]) -> String {
    match entry.kind.as_str() {
        "work" => match tasks.iter().find(|t| Some(&t.id) == entry.task.as_ref()) {
            Some(task) => format!("time on “{}”", task.title),
            None => "a work session".into(),
        },
        "short_break" => "a short break".into(),
        "lunch" => "lunch".into(),
        "prayer" => "prayer".into(),
        "meeting" => "a meeting".into(),
        _ if !entry.text.is_empty() => format!("“{}”", entry.text),
        _ => "another activity".into(),
    }
}

impl Saved {
    fn open_session(&self) -> Option<&Session> {
        self.sessions.iter().find(|s| s.end.is_none())
    }

    fn running(&self) -> Option<&Entry> {
        self.entries.iter().find(|e| e.end.is_none())
    }

    /// The first entry other than `except` that `start..end` runs into (a running one reaches `now`).
    fn clash(&self, start: i64, end: i64, except: Option<&str>, now: i64) -> Option<&Entry> {
        self.entries.iter().find(|e| Some(e.id.as_str()) != except && start < e.end.unwrap_or(now) && e.start < end)
    }

    fn clash_error(&self, start: i64, end: i64, except: Option<&str>, now: i64) -> Result<(), String> {
        match self.clash(start, end, except, now) {
            Some(other) => Err(format!("That overlaps {}.", describe(other, &self.tasks))),
            None => Ok(()),
        }
    }

    /// Closes a check-in left open past the end of its day, with whatever ran in it.
    fn close_stale(&mut self, now: i64) -> bool {
        let Some(session) = self.sessions.iter_mut().find(|s| s.end.is_none()) else {
            return false;
        };
        let end = day_end(session.start);
        if now <= end {
            return false;
        }
        session.end = Some(end);
        for entry in self.entries.iter_mut().filter(|e| e.end.is_none()) {
            entry.end = Some(end.max(entry.start));
        }
        true
    }

    /// Ends what runs at `at`; the caller has checked that it started before.
    fn stop_running(&mut self, at: i64) -> Option<Entry> {
        let entry = self.entries.iter_mut().find(|e| e.end.is_none())?;
        entry.end = Some(at.max(entry.start));
        Some(entry.clone())
    }

    fn data(&self, from: i64, to: i64, now: i64) -> Data {
        let mut sessions: Vec<Session> = self.sessions.iter().filter(|s| s.start < to && s.end.unwrap_or(now) > from).cloned().collect();
        sessions.sort_by_key(|s| s.start);
        let mut entries: Vec<Entry> = self.entries.iter().filter(|e| e.start < to && e.end.unwrap_or(now) > from).cloned().collect();
        entries.sort_by_key(|e| std::cmp::Reverse(e.start));
        Data {
            tasks: self.tasks.clone(),
            sessions,
            entries,
            session: self.open_session().cloned(),
            running: self.running().cloned(),
            now,
        }
    }

    fn check_in(&mut self, at: Option<i64>, now: i64) -> Result<Session, String> {
        if self.open_session().is_some() {
            return Err("You're already checked in.".into());
        }
        let at = at.unwrap_or(now);
        if at > now + SLACK_MS {
            return Err("You can't check in later than now.".into());
        }
        let at = at.min(now);
        if self.sessions.iter().filter_map(|s| s.end).any(|end| end > at) {
            return Err("That's before you last checked out.".into());
        }
        let session = Session { id: new_id(), start: at, end: None };
        self.sessions.push(session.clone());
        Ok(session)
    }

    /// Checks out, stopping whatever runs.
    fn check_out(&mut self, at: Option<i64>, now: i64) -> Result<Session, String> {
        let at = at.unwrap_or(now);
        if at > now + SLACK_MS {
            return Err("You can't check out later than now.".into());
        }
        let at = at.min(now);
        let Some(start) = self.open_session().map(|s| s.start) else {
            return Err("You're not checked in.".into());
        };
        if at < start {
            return Err("That's before you checked in.".into());
        }
        if self.running().is_some_and(|r| r.start > at) {
            return Err("Something has been running since after that time. Pick a later time.".into());
        }
        self.stop_running(at);
        let session = self.sessions.iter_mut().find(|s| s.end.is_none()).expect("checked above");
        session.end = Some(at);
        Ok(session.clone())
    }

    /// Starts a task timer, now or at `at` (earlier today, within the check-in), stopping what ran.
    fn start(&mut self, task: &str, note: &str, at: Option<i64>, now: i64) -> Result<Entry, String> {
        let Some(session_start) = self.open_session().map(|s| s.start) else {
            return Err("Check in first.".into());
        };
        if !self.tasks.iter().any(|t| t.id == task) {
            return Err("That task no longer exists.".into());
        }
        let at = at.unwrap_or(now);
        if at > now + SLACK_MS {
            return Err("The start can't be later than now.".into());
        }
        let at = at.min(now);
        if at < session_start {
            return Err("The start can't be before you checked in.".into());
        }
        let running = self.running().cloned();
        if running.as_ref().is_some_and(|r| r.start > at) {
            return Err("That's before the timer that's running started.".into());
        }
        self.clash_error(at, now.max(at + 1), running.as_ref().map(|r| r.id.as_str()), now)?;
        self.stop_running(at);
        let entry = Entry {
            id: new_id(),
            kind: "work".into(),
            task: Some(task.to_string()),
            text: note.trim().to_string(),
            start: at,
            end: None,
            paused_task: None,
        };
        self.entries.push(entry.clone());
        Ok(entry)
    }

    /// Starts an activity now. A task timer that runs pauses until the activity ends.
    fn begin(&mut self, kind: &str, text: &str, now: i64) -> Result<Entry, String> {
        if !ACTIVITIES.contains(&kind) {
            return Err("Unknown activity.".into());
        }
        let text = clean_line(text, 300);
        if kind == "other" && text.is_empty() {
            return Err("Say what the activity is.".into());
        }
        if self.open_session().is_none() {
            return Err("Check in first.".into());
        }
        // Switching from one activity to another keeps the task waiting to resume.
        let paused = self.running().and_then(|r| if r.kind == "work" { r.task.clone() } else { r.paused_task.clone() });
        self.stop_running(now);
        let entry = Entry { id: new_id(), kind: kind.into(), task: None, text, start: now, end: None, paused_task: paused };
        self.entries.push(entry.clone());
        Ok(entry)
    }

    /// Stops what runs; an activity that paused a task timer starts that timer again.
    fn stop(&mut self, now: i64) -> Result<Stopped, String> {
        let Some(stopped) = self.stop_running(now) else {
            return Err("Nothing is running.".into());
        };
        let mut resumed = None;
        if let Some(task) = stopped.paused_task.as_ref().filter(|id| self.tasks.iter().any(|t| &t.id == *id)) {
            if self.open_session().is_some() {
                // The note of the session it paused carries on.
                let note = self
                    .entries
                    .iter()
                    .filter(|e| e.kind == "work" && e.task.as_ref() == Some(task) && e.end.is_some_and(|end| end <= stopped.start))
                    .max_by_key(|e| e.end)
                    .map(|e| e.text.clone())
                    .unwrap_or_default();
                let entry = Entry { id: new_id(), kind: "work".into(), task: Some(task.clone()), text: note, start: now, end: None, paused_task: None };
                self.entries.push(entry.clone());
                resumed = Some(entry);
            }
        }
        Ok(Stopped { stopped, resumed })
    }

    /// Checks an entry's fields; `id` is the entry being edited, if any.
    fn validate(&self, entry: &Entry, id: Option<&str>, now: i64) -> Result<(), String> {
        if entry.kind == "work" {
            if !entry.task.as_ref().is_some_and(|t| self.tasks.iter().any(|task| &task.id == t)) {
                return Err("Pick a task.".into());
            }
        } else if !ACTIVITIES.contains(&entry.kind.as_str()) {
            return Err("Unknown activity.".into());
        }
        if entry.start > now + SLACK_MS {
            return Err("The start can't be later than now.".into());
        }
        match entry.end {
            Some(end) => {
                if end <= entry.start {
                    return Err("The end must be after the start.".into());
                }
                if end > now + SLACK_MS {
                    return Err("The end can't be later than now.".into());
                }
                self.clash_error(entry.start, end, id, now)
            }
            None => {
                if self.running().is_some_and(|r| Some(r.id.as_str()) != id) {
                    return Err("Something else is running. Stop it first, or give this an end.".into());
                }
                if !self.open_session().is_some_and(|s| s.start <= entry.start) {
                    return Err("Only something within today's check-in can still be running. Give it an end.".into());
                }
                self.clash_error(entry.start, now.max(entry.start + 1), id, now)
            }
        }
    }

    /// Logs something that already happened.
    fn add(&mut self, kind: &str, task: Option<String>, text: &str, start: i64, end: i64, now: i64) -> Result<Entry, String> {
        let entry = Entry {
            id: new_id(),
            kind: kind.into(),
            task: if kind == "work" { task } else { None },
            text: clean_line(text, 300),
            start,
            end: Some(end),
            paused_task: None,
        };
        self.validate(&entry, None, now)?;
        let entry = entry.clamped(now);
        self.entries.push(entry.clone());
        Ok(entry)
    }

    /// Changes an entry; work stays work and an activity stays an activity. `end: None` lets it run.
    #[allow(clippy::too_many_arguments)]
    fn edit(&mut self, id: &str, kind: &str, task: Option<String>, text: &str, start: i64, end: Option<i64>, now: i64) -> Result<Entry, String> {
        let Some(before) = self.entries.iter().find(|e| e.id == id).cloned() else {
            return Err("That entry no longer exists.".into());
        };
        if (before.kind == "work") != (kind == "work") {
            return Err("Work stays work, and an activity stays an activity.".into());
        }
        let entry = Entry {
            kind: kind.into(),
            task: if kind == "work" { task } else { None },
            text: clean_line(text, 300),
            start,
            end,
            ..before
        };
        self.validate(&entry, Some(id), now)?;
        let entry = entry.clamped(now);
        let slot = self.entries.iter_mut().find(|e| e.id == id).expect("found above");
        *slot = entry.clone();
        Ok(entry)
    }

    fn delete(&mut self, id: &str) -> Result<(), String> {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        if self.entries.len() == before {
            return Err("That entry no longer exists.".into());
        }
        Ok(())
    }

    fn add_task(&mut self, title: &str, project: &str, kind: &str, now: i64) -> Result<Task, String> {
        let title = clean_line(title, 200);
        if title.is_empty() {
            return Err("Give the task a name.".into());
        }
        if !TASK_KINDS.contains(&kind) {
            return Err("Unknown kind of task.".into());
        }
        let task = Task { id: new_id(), title, project: clean_line(project, 120), kind: kind.into(), done: false, created: now };
        self.tasks.push(task.clone());
        Ok(task)
    }

    fn edit_task(&mut self, id: &str, title: Option<String>, project: Option<String>, kind: Option<String>, done: Option<bool>) -> Result<Task, String> {
        let task = self.tasks.iter_mut().find(|t| t.id == id).ok_or_else(|| "That task no longer exists.".to_string())?;
        if let Some(title) = title {
            let title = clean_line(&title, 200);
            if title.is_empty() {
                return Err("Give the task a name.".into());
            }
            task.title = title;
        }
        if let Some(project) = project {
            task.project = clean_line(&project, 120);
        }
        if let Some(kind) = kind.filter(|k| TASK_KINDS.contains(&k.as_str())) {
            task.kind = kind;
        }
        if let Some(done) = done {
            task.done = done;
        }
        Ok(task.clone())
    }

    fn save_report(&mut self, mut report: Report, now: i64) -> Result<Report, String> {
        let valid_date = report.date.len() == 10
            && report.date.char_indices().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
        if !valid_date {
            return Err("A report needs a day.".into());
        }
        if report.status != "draft" && report.status != "submitted" {
            return Err("Unknown report status.".into());
        }
        report.updated = now;
        report.submitted = (report.status == "submitted").then_some(now);
        self.reports.retain(|r| r.date != report.date);
        self.reports.push(report.clone());
        Ok(report)
    }
}

// ---- commands ---------------------------------------------------------------------------------

/// Everything that reaches into `from..to`, plus the open check-in and what runs.
#[tauri::command]
pub fn time_data(from: i64, to: i64) -> Result<Data, String> {
    crate::ensure_unlocked()?;
    let mut store = store();
    let at = now();
    if store.saved.close_stale(at) {
        store.changed();
    }
    Ok(store.saved.data(from, to, at))
}

#[tauri::command]
pub fn time_check_in(at: Option<i64>) -> Result<Session, String> {
    change(|saved, now| saved.check_in(at, now))
}

#[tauri::command]
pub fn time_check_out(at: Option<i64>) -> Result<Session, String> {
    change(|saved, now| saved.check_out(at, now))
}

#[tauri::command]
pub fn time_start(task: String, note: String, at: Option<i64>) -> Result<Entry, String> {
    change(|saved, now| saved.start(&task, &note, at, now))
}

#[tauri::command]
pub fn time_begin(kind: String, text: String) -> Result<Entry, String> {
    change(|saved, now| saved.begin(&kind, &text, now))
}

#[tauri::command]
pub fn time_stop() -> Result<Stopped, String> {
    change(|saved, now| saved.stop(now))
}

#[tauri::command]
pub fn time_add(kind: String, task: Option<String>, text: String, start: i64, end: i64) -> Result<Entry, String> {
    change(|saved, now| saved.add(&kind, task, &text, start, end, now))
}

#[tauri::command]
pub fn time_edit(id: String, kind: String, task: Option<String>, text: String, start: i64, end: Option<i64>) -> Result<Entry, String> {
    change(|saved, now| saved.edit(&id, &kind, task, &text, start, end, now))
}

#[tauri::command]
pub fn time_delete(id: String) -> Result<(), String> {
    change(|saved, _| saved.delete(&id))
}

#[tauri::command]
pub fn time_task_add(title: String, project: String, kind: String) -> Result<Task, String> {
    change(|saved, now| saved.add_task(&title, &project, &kind, now))
}

#[tauri::command]
pub fn time_task_edit(id: String, title: Option<String>, project: Option<String>, kind: Option<String>, done: Option<bool>) -> Result<Task, String> {
    change(|saved, _| saved.edit_task(&id, title, project, kind, done))
}

#[tauri::command]
pub fn time_report(date: String) -> Result<Option<Report>, String> {
    crate::ensure_unlocked()?;
    Ok(store().saved.reports.iter().find(|r| r.date == date).cloned())
}

#[tauri::command]
pub fn time_report_save(report: Report) -> Result<Report, String> {
    change(|saved, now| saved.save_report(report, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    /// Noon on some day, so a few hours either way stay on the same local day.
    const NOON: i64 = 1_793_016_000_000;

    fn day() -> (Saved, String) {
        let mut saved = Saved::default();
        let task = saved.add_task("Fix login", "Portal", "development", NOON).unwrap().id;
        saved.check_in(Some(NOON - 60 * MIN), NOON).unwrap();
        (saved, task)
    }

    #[test]
    fn nothing_runs_without_a_check_in() {
        let mut saved = Saved::default();
        let task = saved.add_task("Fix login", "", "development", NOON).unwrap().id;
        assert!(saved.start(&task, "", None, NOON).is_err());
        assert!(saved.begin("lunch", "", NOON).is_err());
    }

    #[test]
    fn an_activity_pauses_the_timer_and_ending_it_resumes() {
        let (mut saved, task) = day();
        saved.start(&task, "OAuth", None, NOON).unwrap();
        let lunch = saved.begin("lunch", "", NOON + 30 * MIN).unwrap();
        assert_eq!(lunch.paused_task.as_deref(), Some(task.as_str()));
        assert_eq!(saved.entries.iter().filter(|e| e.end.is_none()).count(), 1);
        // A prayer in the middle of lunch still hands the task back at the end.
        saved.begin("prayer", "", NOON + 40 * MIN).unwrap();
        let out = saved.stop(NOON + 50 * MIN).unwrap();
        let resumed = out.resumed.expect("the task timer starts again");
        assert_eq!(resumed.task.as_deref(), Some(task.as_str()));
        assert_eq!(resumed.text, "OAuth");
        assert_eq!(resumed.start, NOON + 50 * MIN);
    }

    #[test]
    fn a_new_timer_stops_the_last() {
        let (mut saved, task) = day();
        let first = saved.start(&task, "", None, NOON).unwrap();
        saved.start(&task, "", None, NOON + 5 * MIN).unwrap();
        assert_eq!(saved.entries.iter().find(|e| e.id == first.id).unwrap().end, Some(NOON + 5 * MIN));
    }

    #[test]
    fn a_custom_start_stays_within_the_check_in() {
        let (mut saved, task) = day();
        assert!(saved.start(&task, "", Some(NOON - 90 * MIN), NOON).is_err());
        assert!(saved.start(&task, "", Some(NOON + 10 * MIN), NOON).is_err());
        assert!(saved.start(&task, "", Some(NOON - 30 * MIN), NOON).is_ok());
    }

    #[test]
    fn past_entries_never_overlap() {
        let (mut saved, task) = day();
        saved.add("lunch", None, "", NOON - 50 * MIN, NOON - 20 * MIN, NOON).unwrap();
        let err = saved.add("work", Some(task.clone()), "", NOON - 30 * MIN, NOON - 10 * MIN, NOON).unwrap_err();
        assert_eq!(err, "That overlaps lunch.");
        assert!(saved.add("work", Some(task.clone()), "", NOON - 20 * MIN, NOON - 10 * MIN, NOON).is_ok());
        assert!(saved.add("prayer", None, "", NOON - 5 * MIN, NOON - 6 * MIN, NOON).is_err());
        assert!(saved.add("prayer", None, "", NOON, NOON + 10 * MIN, NOON).is_err());
    }

    #[test]
    fn editing_checks_against_the_others_but_not_itself() {
        let (mut saved, _) = day();
        let lunch = saved.add("lunch", None, "", NOON - 50 * MIN, NOON - 20 * MIN, NOON).unwrap();
        let prayer = saved.add("prayer", None, "", NOON - 15 * MIN, NOON - 5 * MIN, NOON).unwrap();
        assert!(saved.edit(&lunch.id, "short_break", None, "", NOON - 55 * MIN, Some(NOON - 18 * MIN), NOON).is_ok());
        assert!(saved.edit(&lunch.id, "lunch", None, "", NOON - 55 * MIN, Some(NOON - 10 * MIN), NOON).is_err());
        assert!(saved.edit(&prayer.id, "work", None, "", NOON - 15 * MIN, Some(NOON - 5 * MIN), NOON).is_err());
        // Clearing the end lets the latest one run again, within the check-in.
        assert!(saved.edit(&prayer.id, "prayer", None, "", NOON - 15 * MIN, None, NOON).is_ok());
        assert!(saved.edit(&lunch.id, "lunch", None, "", NOON - 55 * MIN, None, NOON).is_err());
    }

    #[test]
    fn checking_out_stops_everything() {
        let (mut saved, task) = day();
        saved.start(&task, "", None, NOON).unwrap();
        saved.check_out(None, NOON + 10 * MIN).unwrap();
        assert!(saved.running().is_none());
        assert!(saved.open_session().is_none());
        assert!(saved.check_in(Some(NOON + 5 * MIN), NOON + 20 * MIN).is_err());
        assert!(saved.check_in(None, NOON + 20 * MIN).is_ok());
    }

    #[test]
    fn a_day_left_checked_in_closes_at_its_end() {
        let (mut saved, task) = day();
        saved.start(&task, "", None, NOON).unwrap();
        assert!(!saved.close_stale(NOON + 60 * MIN));
        assert!(saved.close_stale(NOON + 24 * 60 * MIN));
        let end = day_end(NOON);
        assert_eq!(saved.sessions[0].end, Some(end));
        assert_eq!(saved.entries[0].end, Some(end));
        assert!(end > NOON && end - NOON < 24 * 60 * MIN);
    }

    #[test]
    fn one_report_per_day() {
        let mut saved = Saved::default();
        let report = |status: &str| Report {
            date: "2026-10-26".into(),
            content: "Worked 1h".into(),
            worked_min: 60,
            break_min: 0,
            idle_min: 0,
            status: status.into(),
            updated: 0,
            submitted: None,
        };
        saved.save_report(report("draft"), NOON).unwrap();
        let sent = saved.save_report(report("submitted"), NOON + MIN).unwrap();
        assert_eq!(saved.reports.len(), 1);
        assert_eq!(sent.submitted, Some(NOON + MIN));
        assert!(saved.save_report(Report { date: "today".into(), ..report("draft") }, NOON).is_err());
    }
}
