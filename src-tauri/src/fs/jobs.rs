//! Background file jobs: progress events (`fs-job`, throttled to ~10/s), conflict questions
//! that wait for the user's answer, and cancellation. The work itself lives in `ops.rs`; it
//! talks to a `JobCtx`, which tests drive with scripted answers instead of a window.

use super::ops::{OpError, UndoOp};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

const THROTTLE: Duration = Duration::from_millis(100);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Copy,
    Move,
    Trash,
    Delete,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Running,
    Waiting,
    Done,
    Cancelled,
    Failed,
}

/// What to do when the target of a copy or move already exists.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Replace,
    KeepBoth,
    Skip,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub source: String,
    pub target: String,
    pub is_dir: bool,
}

/// The payload of the `fs-job` event.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub id: u64,
    pub kind: Kind,
    pub state: State,
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
    pub total_bytes: u64,
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<Conflict>,
    /// Final events only: records that reverse what happened (apply with `fs_undo`).
    pub undo: Vec<UndoOp>,
    /// Final events only: the resulting paths (pasted, restored, trashed items).
    pub results: Vec<String>,
}

type Emit = Box<dyn Fn(&JobEvent) + Send>;
type Ask = Box<dyn Fn(&Conflict) -> Option<(Decision, bool)> + Send>;

/// Everything a running job can do: report progress, ask about conflicts, notice cancelling.
pub struct JobCtx {
    id: u64,
    kind: Kind,
    emit: Emit,
    ask: Ask,
    cancel: Arc<AtomicBool>,
    last_emit: Option<Instant>,
    /// Minimum time between running-state events.
    pub throttle: Duration,
    apply_all: Option<Decision>,
    /// Where the home trash lives (replaced items go there).
    pub trash_home: PathBuf,
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
    pub total_bytes: u64,
    pub current: String,
    pub undo: Vec<UndoOp>,
    pub results: Vec<String>,
    pub errors: Vec<String>,
}

impl JobCtx {
    pub fn new(id: u64, kind: Kind, trash_home: PathBuf, cancel: Arc<AtomicBool>, emit: Emit, ask: Ask) -> Self {
        JobCtx {
            id, kind, emit, ask, cancel, last_emit: None, throttle: THROTTLE, apply_all: None, trash_home,
            done: 0, total: 0, bytes: 0, total_bytes: 0, current: String::new(),
            undo: Vec::new(), results: Vec::new(), errors: Vec::new(),
        }
    }

    /// A context for quick synchronous work (undo, duplicate): silent, and never asks.
    pub fn detached(kind: Kind, trash_home: PathBuf) -> Self {
        JobCtx::new(0, kind, trash_home, Arc::new(AtomicBool::new(false)), Box::new(|_| {}), Box::new(|_| Some((Decision::Skip, true))))
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// `Err(Cancelled)` once the user cancelled; call between units of work.
    pub fn check(&self) -> Result<(), OpError> {
        if self.cancelled() { Err(OpError::Cancelled) } else { Ok(()) }
    }

    fn event(&self, state: State, conflict: Option<Conflict>, error: Option<String>, last: bool) -> JobEvent {
        JobEvent {
            id: self.id, kind: self.kind, state,
            done: self.done, total: self.total, bytes: self.bytes, total_bytes: self.total_bytes,
            current: self.current.clone(), error, conflict,
            undo: if last { self.undo.clone() } else { Vec::new() },
            results: if last { self.results.clone() } else { Vec::new() },
        }
    }

    /// Emits a running-state progress event, at most every 100 ms.
    pub fn tick(&mut self) {
        let due = self.last_emit.is_none_or(|t| t.elapsed() >= self.throttle);
        if due {
            self.last_emit = Some(Instant::now());
            (self.emit)(&self.event(State::Running, None, None, false));
        }
    }

    pub fn add_bytes(&mut self, n: u64) {
        self.bytes += n;
        self.tick();
    }

    /// Names the item being worked on and reports it at once.
    pub fn begin(&mut self, name: &str) {
        self.current = name.to_string();
        self.tick();
    }

    pub fn finish_item(&mut self) {
        self.done += 1;
        self.tick();
    }

    /// Asks what to do about an existing target (honouring "apply to all"); blocks until answered.
    pub fn resolve(&mut self, conflict: Conflict) -> Result<Decision, OpError> {
        if let Some(d) = self.apply_all {
            return Ok(d);
        }
        (self.emit)(&self.event(State::Waiting, Some(conflict.clone()), None, false));
        let answer = (self.ask)(&conflict);
        self.last_emit = None;
        let (decision, all) = answer.ok_or(OpError::Cancelled)?;
        self.check()?;
        if all {
            self.apply_all = Some(decision);
        }
        (self.emit)(&self.event(State::Running, None, None, false));
        Ok(decision)
    }

    /// Sends the final event for how the job ended.
    pub fn finish(&mut self, outcome: Result<(), OpError>) {
        let (state, error) = match outcome {
            Err(OpError::Cancelled) => (State::Cancelled, None),
            Err(OpError::Failed(msg)) => (State::Failed, Some(msg)),
            Ok(()) if self.errors.is_empty() => (State::Done, None),
            Ok(()) => {
                let more = self.errors.len() - 1;
                let msg = if more == 0 { self.errors[0].clone() } else { format!("{} (and {more} more problems)", self.errors[0]) };
                (State::Failed, Some(msg))
            }
        };
        (self.emit)(&self.event(state, None, error, true));
    }
}

// ---- the running jobs ---------------------------------------------------------------------------

struct Live {
    cancel: Arc<AtomicBool>,
    answer: Arc<(Mutex<Option<(Decision, bool)>>, Condvar)>,
}

fn registry() -> &'static Mutex<HashMap<u64, Live>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Live>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

/// Runs `work` on its own thread as job `kind`, emitting `fs-job` events; returns the job id.
pub fn spawn<F>(app: tauri::AppHandle, kind: Kind, trash_home: PathBuf, work: F) -> u64
where
    F: FnOnce(&mut JobCtx) -> Result<(), OpError> + Send + 'static,
{
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let cancel = Arc::new(AtomicBool::new(false));
    let answer: Arc<(Mutex<Option<(Decision, bool)>>, Condvar)> = Arc::new((Mutex::new(None), Condvar::new()));
    registry().lock().unwrap().insert(id, Live { cancel: cancel.clone(), answer: answer.clone() });

    let emitter = app.clone();
    let emit: Emit = Box::new(move |event| {
        let _ = emitter.emit("fs-job", event);
    });
    let waiting_cancel = cancel.clone();
    let ask: Ask = Box::new(move |_| {
        let (slot, cv) = &*answer;
        let mut guard = slot.lock().unwrap();
        loop {
            if let Some(a) = guard.take() {
                return Some(a);
            }
            if waiting_cancel.load(Ordering::SeqCst) {
                return None;
            }
            guard = cv.wait_timeout(guard, Duration::from_millis(200)).unwrap().0;
        }
    });
    let mut ctx = JobCtx::new(id, kind, trash_home, cancel, emit, ask);
    std::thread::spawn(move || {
        ctx.begin("");
        let outcome = work(&mut ctx);
        ctx.finish(outcome);
        registry().lock().unwrap().remove(&id);
    });
    id
}

/// The user's answer to a waiting conflict.
pub fn resolve(id: u64, decision: Decision, apply_to_all: bool) -> Result<(), String> {
    let jobs = registry().lock().unwrap();
    let live = jobs.get(&id).ok_or("That job has already finished.")?;
    let (slot, cv) = &*live.answer;
    *slot.lock().unwrap() = Some((decision, apply_to_all));
    cv.notify_all();
    Ok(())
}

/// Asks a job to stop at the next safe point; unknown ids are ignored (it already ended).
pub fn cancel(id: u64) {
    if let Some(live) = registry().lock().unwrap().get(&id) {
        live.cancel.store(true, Ordering::SeqCst);
        live.answer.1.notify_all();
    }
}
