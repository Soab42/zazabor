//! The hands-free side of the HFP 1.7 AT dialogue, without any I/O. The phone (the audio gateway,
//! "AG") and Zazabor (the hands-free unit, "HF") talk in text lines over the RFCOMM socket: Zazabor
//! sends one command at a time (`AT…\r`) and waits for its final result (`OK`, `ERROR`,
//! `+CME ERROR: n`, …), while the phone also sends unsolicited lines (`+CIEV`, `RING`, `+CLIP`, …)
//! whenever it likes.
//!
//! [`Hf`] takes what the phone sent ([`Hf::feed`]), what the user asked for ([`Hf::request`]) and
//! the time ([`Hf::tick`]), and hands back the bytes to write and what happened ([`Hf::take`]).
//! `session.rs` connects it to the socket.

use std::collections::{HashSet, VecDeque};

use serde::Serialize;

/// The HF features Zazabor announces in `AT+BRSF`: three-way calling, CLI presentation, remote
/// volume control, enhanced call status and enhanced call control. No codec negotiation, so the
/// audio is always CVSD (narrow band), and no EC/NR of its own.
pub const HF_FEATURES: u32 = (1 << 1) | (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6);

/// The same features in the SDP record's 16-bit layout (call waiting / three-way, CLI, remote
/// volume control).
pub const SDP_FEATURES: u16 = (1 << 1) | (1 << 2) | (1 << 4);

/// The AG features from `+BRSF`.
pub mod ag {
    pub const THREE_WAY: u32 = 1 << 0;
    pub const NREC: u32 = 1 << 1;
    pub const INBAND_RING: u32 = 1 << 3;
    pub const ENHANCED_STATUS: u32 = 1 << 6;
    pub const EXTENDED_ERRORS: u32 = 1 << 8;
}

/// How long the phone gets to answer a command.
const TIMEOUT_MS: u64 = 10_000;
/// `ATD` can take longer: some phones answer only once the network accepted the call.
const DIAL_TIMEOUT_MS: u64 = 30_000;
/// A line longer than this is junk; it's dropped.
const MAX_LINE: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dir {
    In,
    Out,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CallState {
    Active,
    Held,
    Dialing,
    Alerting,
    Incoming,
    Waiting,
}

impl CallState {
    /// The `<stat>` of `+CLCC`.
    fn from_clcc(n: u32) -> Option<Self> {
        Some(match n {
            0 => Self::Active,
            1 => Self::Held,
            2 => Self::Dialing,
            3 => Self::Alerting,
            4 => Self::Incoming,
            5 => Self::Waiting,
            _ => return None,
        })
    }

    /// The call is ringing here: the page shows Answer and Decline for it.
    pub fn ringing(self) -> bool {
        matches!(self, Self::Incoming | Self::Waiting)
    }

    /// The call has (or is about to have) audio: talking, dialing or ringing at the other end.
    pub fn has_audio(self) -> bool {
        matches!(self, Self::Active | Self::Dialing | Self::Alerting)
    }
}

/// A call the phone has right now (`LiveCall` in docs/plans/phone-link.md §3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCall {
    pub idx: u32,
    pub number: String,
    pub name: Option<String>,
    pub dir: Dir,
    pub state: CallState,
    /// When the call was first seen talking (Unix ms).
    pub since: Option<u64>,
}

/// What the user asks the phone to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Dial(String),
    /// Calls the last number again (`AT+BLDN`).
    Redial,
    Answer,
    Hangup,
    /// Turns down the ringing call: the incoming one (`AT+CHUP`) or the one waiting beside a call
    /// (`AT+CHLD=0`).
    Decline,
    Dtmf(char),
    /// `AT+CHLD=<n>`: 0 drops the held or waiting calls, 1 ends the active call and takes the
    /// other, 2 swaps the active and the held or waiting call.
    Hold(u8),
    /// The speaker gain, 0-15.
    Volume(u8),
}

/// What happened, for the session to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// The service level connection is up: calls can go through this phone.
    Connected,
    /// The connection couldn't be set up, or the phone stopped answering. The link should close.
    Failed(String),
    /// Indicators, calls, carrier or volume changed.
    Changed,
    /// A call started ringing (incoming, or waiting beside another call).
    Ring(LiveCall),
    /// The phone set the speaker gain (0-15).
    Volume(u8),
    /// A command the user gave failed (readable text).
    Rejected(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum User {
    Dial,
    Answer,
    Hangup,
    Dtmf,
    Hold,
    Volume,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Brsf,
    CindTest,
    CindRead,
    Cmer,
    ChldTest,
    /// After the connection: its result doesn't matter.
    Setup,
    Clcc,
    User(User),
}

struct Cmd {
    text: String,
    kind: Kind,
    /// When it was written (Unix ms); only the queue's first command is ever written.
    sent: Option<u64>,
}

/// The hands-free state machine for one phone.
pub struct Hf {
    ag_features: u32,
    /// Indicator names by position (`+CIND` and `+CIEV` count from 1).
    names: Vec<String>,
    values: Vec<u8>,
    carrier: Option<String>,
    volume: u8,
    inband: bool,
    three_way: Vec<String>,
    connected: bool,
    failed: bool,
    /// Ask the phone to turn off its own echo cancelling (Zazabor cancels the echo itself).
    nrec_off: bool,
    queue: VecDeque<Cmd>,
    line: Vec<u8>,
    /// The last `+CLCC` list, and the one being received.
    clcc: Vec<LiveCall>,
    clcc_rx: Vec<LiveCall>,
    /// The phone answered `AT+CLCC` with an error: calls come from the indicators instead.
    clcc_broken: bool,
    clip: Option<(String, Option<String>)>,
    ccwa: Option<(String, Option<String>)>,
    /// `RING`s and `+CCWA`s since the phone last had no call.
    alerts: u32,
    dialed: String,
    /// The first call when the calls come from the indicators: its direction and number.
    primary: Option<(Dir, String)>,
    calls: Vec<LiveCall>,
    announced: HashSet<u32>,
    out: Vec<u8>,
    events: Vec<Event>,
}

/// What [`Hf::take`] hands back.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Output {
    pub write: Vec<u8>,
    pub events: Vec<Event>,
}

impl Hf {
    /// `volume` is the speaker gain to start with; `nrec_off` asks the phone to stop its own echo
    /// cancelling when it can.
    pub fn new(volume: u8, nrec_off: bool) -> Self {
        Self {
            ag_features: 0,
            names: Vec::new(),
            values: Vec::new(),
            carrier: None,
            volume: volume.min(15),
            inband: false,
            three_way: Vec::new(),
            connected: false,
            failed: false,
            nrec_off,
            queue: VecDeque::new(),
            line: Vec::new(),
            clcc: Vec::new(),
            clcc_rx: Vec::new(),
            clcc_broken: false,
            clip: None,
            ccwa: None,
            alerts: 0,
            dialed: String::new(),
            primary: None,
            calls: Vec::new(),
            announced: HashSet::new(),
            out: Vec::new(),
            events: Vec::new(),
        }
    }

    /// Starts the service level connection.
    pub fn start(&mut self, now: u64) {
        self.push(format!("AT+BRSF={HF_FEATURES}"), Kind::Brsf);
        self.pump(now);
    }

    /// What the phone sent.
    pub fn feed(&mut self, bytes: &[u8], now: u64) {
        for &b in bytes {
            if b == b'\r' || b == b'\n' {
                if !self.line.is_empty() {
                    let line = String::from_utf8_lossy(&std::mem::take(&mut self.line)).trim().to_string();
                    if !line.is_empty() && !self.failed {
                        self.handle(&line, now);
                    }
                }
            } else if self.line.len() < MAX_LINE {
                self.line.push(b);
            }
        }
        self.pump(now);
    }

    /// Gives up on a command the phone didn't answer in time.
    pub fn tick(&mut self, now: u64) {
        let Some(front) = self.queue.front() else { return };
        let Some(sent) = front.sent else { return };
        let limit = if front.kind == Kind::User(User::Dial) { DIAL_TIMEOUT_MS } else { TIMEOUT_MS };
        if now.saturating_sub(sent) >= limit {
            self.finish(Err("The phone didn't answer".into()), now);
            self.pump(now);
        }
    }

    /// What the user asked for. It errs when the phone can't take it now.
    pub fn request(&mut self, request: Request, now: u64) -> Result<(), String> {
        if !self.connected {
            return Err("The phone isn't connected for calls.".into());
        }
        let (text, user) = match request {
            Request::Dial(number) => {
                let number = dialable(&number).ok_or("That isn't a phone number.")?;
                self.dialed = number.clone();
                (format!("ATD{number};"), User::Dial)
            }
            Request::Redial => ("AT+BLDN".to_string(), User::Dial),
            Request::Answer => ("ATA".to_string(), User::Answer),
            Request::Hangup => ("AT+CHUP".to_string(), User::Hangup),
            Request::Decline => {
                let waiting = self.calls.iter().any(|c| c.state == CallState::Waiting);
                let other = self.calls.iter().any(|c| matches!(c.state, CallState::Active | CallState::Held));
                if waiting && other {
                    ("AT+CHLD=0".to_string(), User::Hold)
                } else {
                    ("AT+CHUP".to_string(), User::Hangup)
                }
            }
            Request::Dtmf(digit) => {
                let digit = digit.to_ascii_uppercase();
                if !"0123456789*#ABCD".contains(digit) {
                    return Err("That isn't a keypad key.".into());
                }
                (format!("AT+VTS={digit}"), User::Dtmf)
            }
            Request::Hold(action) => {
                if action > 2 {
                    return Err("Unknown hold action.".into());
                }
                if self.ag_features & ag::THREE_WAY == 0 {
                    return Err("This phone can't hold calls over Bluetooth.".into());
                }
                (format!("AT+CHLD={action}"), User::Hold)
            }
            Request::Volume(level) => {
                self.volume = level.min(15);
                (format!("AT+VGS={}", self.volume), User::Volume)
            }
        };
        self.push(text, Kind::User(user));
        self.pump(now);
        Ok(())
    }

    /// The bytes to write to the phone and what happened since the last call.
    pub fn take(&mut self) -> Output {
        let mut events = std::mem::take(&mut self.events);
        // Several changes in one go are one change.
        let mut seen = false;
        events.retain(|e| {
            if *e == Event::Changed {
                let keep = !seen;
                seen = true;
                keep
            } else {
                true
            }
        });
        Output { write: std::mem::take(&mut self.out), events }
    }

    pub fn connected(&self) -> bool {
        self.connected
    }

    #[allow(dead_code)] // for the page later; the tests use it
    pub fn ag_features(&self) -> u32 {
        self.ag_features
    }

    pub fn calls(&self) -> &[LiveCall] {
        &self.calls
    }

    pub fn carrier(&self) -> Option<&str> {
        self.carrier.as_deref()
    }

    #[allow(dead_code)] // for the page later; the tests use it
    pub fn volume(&self) -> u8 {
        self.volume
    }

    /// The phone plays its own ringtone over the audio link.
    #[allow(dead_code)] // for the page later; the tests use it
    pub fn inband_ring(&self) -> bool {
        self.inband
    }

    /// The phone's battery in percent (`battchg` 0-5 → 0-100).
    pub fn battery(&self) -> Option<u8> {
        self.indicator("battchg").map(|v| v.min(5) * 20)
    }

    /// The phone's signal, 0-4 like the Wi-Fi link's (`signal` 0-5).
    pub fn signal(&self) -> Option<u8> {
        self.indicator("signal").map(|v| (v.min(5) * 4 + 2) / 5)
    }

    /// The phone has network service.
    #[allow(dead_code)] // for the page later; the tests use it
    pub fn service(&self) -> Option<bool> {
        self.indicator("service").map(|v| v > 0)
    }

    #[allow(dead_code)] // for the page later; the tests use it
    pub fn roaming(&self) -> Option<bool> {
        self.indicator("roam").map(|v| v > 0)
    }

    /// An indicator's value by its name ("call", "battchg", …), once the phone said it.
    pub fn indicator(&self, name: &str) -> Option<u8> {
        let i = self.names.iter().position(|n| n.eq_ignore_ascii_case(name))?;
        self.values.get(i).copied()
    }

    fn push(&mut self, text: String, kind: Kind) {
        self.queue.push_back(Cmd { text, kind, sent: None });
    }

    /// Writes the next command when none is waiting for its answer.
    fn pump(&mut self, now: u64) {
        if self.failed {
            return;
        }
        if let Some(front) = self.queue.front_mut() {
            if front.sent.is_none() {
                front.sent = Some(now);
                self.out.extend_from_slice(front.text.as_bytes());
                self.out.push(b'\r');
            }
        }
    }

    fn fail(&mut self, why: &str) {
        self.failed = true;
        self.connected = false;
        self.queue.clear();
        self.events.push(Event::Failed(why.to_string()));
    }

    fn handle(&mut self, line: &str, now: u64) {
        match line {
            "OK" => return self.finish(Ok(()), now),
            "ERROR" | "NO CARRIER" | "BUSY" | "NO ANSWER" | "DELAYED" | "BLACKLISTED" => {
                return self.finish(Err(line.to_string()), now)
            }
            "RING" => {
                self.alerts += 1;
                self.calls_changed(now);
                return;
            }
            _ => {}
        }
        if let Some(code) = line.strip_prefix("+CME ERROR:") {
            return self.finish(Err(format!("+CME ERROR: {}", code.trim())), now);
        }
        // `+NAME: args`; a few phones write `+VGS=7`.
        let Some(split) = line.find(&[':', '='][..]).filter(|_| line.starts_with('+')) else { return };
        let (name, rest) = (&line[..split], line[split + 1..].trim());
        let front = self.queue.front().filter(|c| c.sent.is_some()).map(|c| c.kind);
        match name {
            "+BRSF" => self.ag_features = rest.parse().unwrap_or(0),
            "+CIND" if front == Some(Kind::CindTest) => self.names = quoted(rest),
            "+CIND" if front == Some(Kind::CindRead) => {
                self.values = rest.split(',').map(|v| v.trim().parse().unwrap_or(0)).collect();
            }
            "+CIEV" => {
                let args = args(rest);
                let (Some(index), Some(value)) = (num(&args, 0), num(&args, 1)) else { return };
                let Some(slot) = (index as usize).checked_sub(1).and_then(|i| self.values.get_mut(i)) else { return };
                *slot = value.min(255) as u8;
                let name = self.names.get(index as usize - 1).map(|n| n.to_ascii_lowercase()).unwrap_or_default();
                if matches!(name.as_str(), "call" | "callsetup" | "callheld") {
                    self.calls_changed(now);
                } else {
                    self.events.push(Event::Changed);
                }
            }
            "+CHLD" => self.three_way = rest.trim_matches(&['(', ')'][..]).split(',').map(|s| s.trim().to_string()).collect(),
            "+CLIP" => {
                let args = args(rest);
                let number = text(&args, 0).unwrap_or_default();
                self.clip = Some((number, text(&args, 4)));
                self.calls_changed(now);
            }
            "+CCWA" => {
                let args = args(rest);
                let number = text(&args, 0).unwrap_or_default();
                self.ccwa = Some((number, text(&args, 3)));
                self.alerts += 1;
                self.calls_changed(now);
            }
            "+CLCC" if front == Some(Kind::Clcc) => {
                if let Some(call) = clcc(rest) {
                    self.clcc_rx.push(call);
                }
            }
            "+COPS" => {
                let carrier = text(&args(rest), 2).filter(|c| !c.is_empty());
                if carrier != self.carrier {
                    self.carrier = carrier;
                    self.events.push(Event::Changed);
                }
            }
            "+VGS" => {
                if let Ok(level) = rest.parse::<u8>() {
                    self.volume = level.min(15);
                    self.events.push(Event::Volume(self.volume));
                    self.events.push(Event::Changed);
                }
            }
            "+BSIR" => self.inband = rest == "1",
            _ => {}
        }
    }

    /// The final result of the command waiting for one.
    fn finish(&mut self, result: Result<(), String>, now: u64) {
        let Some(cmd) = self.queue.front() else { return };
        if cmd.sent.is_none() {
            return;
        }
        let kind = cmd.kind;
        self.queue.pop_front();
        match kind {
            // A phone without AT+BRSF (HFP 0.96) answers ERROR; carry on with no AG features.
            Kind::Brsf => self.push("AT+CIND=?".into(), Kind::CindTest),
            Kind::CindTest if result.is_ok() && !self.names.is_empty() => self.push("AT+CIND?".into(), Kind::CindRead),
            Kind::CindRead if result.is_ok() => {
                self.values.resize(self.names.len(), 0);
                self.push("AT+CMER=3,0,0,1".into(), Kind::Cmer);
            }
            Kind::Cmer if result.is_ok() => {
                if self.ag_features & ag::THREE_WAY != 0 && HF_FEATURES & (1 << 1) != 0 {
                    self.push("AT+CHLD=?".into(), Kind::ChldTest);
                } else {
                    self.slc_up(now);
                }
            }
            Kind::CindTest | Kind::CindRead | Kind::Cmer => {
                self.fail("The phone didn't accept the hands-free connection.");
            }
            Kind::ChldTest => self.slc_up(now),
            Kind::Setup => {}
            Kind::Clcc => {
                let rx = std::mem::take(&mut self.clcc_rx);
                if result.is_ok() {
                    self.clcc = rx;
                } else {
                    self.clcc_broken = true;
                }
                self.refresh(now);
            }
            Kind::User(user) => {
                if let Err(error) = result {
                    self.events.push(Event::Rejected(rejected(user, &error)));
                }
            }
        }
    }

    /// The service level connection is up: turn on caller ID and the rest, and read the
    /// carrier and the calls.
    fn slc_up(&mut self, now: u64) {
        self.connected = true;
        self.events.push(Event::Connected);
        self.push("AT+CLIP=1".into(), Kind::Setup);
        if self.ag_features & ag::THREE_WAY != 0 {
            self.push("AT+CCWA=1".into(), Kind::Setup);
        }
        if self.ag_features & ag::EXTENDED_ERRORS != 0 {
            self.push("AT+CMEE=1".into(), Kind::Setup);
        }
        if self.nrec_off && self.ag_features & ag::NREC != 0 {
            self.push("AT+NREC=0".into(), Kind::Setup);
        }
        self.push(format!("AT+VGS={}", self.volume), Kind::Setup);
        self.push("AT+COPS=3,0".into(), Kind::Setup);
        self.push("AT+COPS?".into(), Kind::Setup);
        self.inband = self.ag_features & ag::INBAND_RING != 0;
        self.calls_changed(now);
    }

    fn uses_clcc(&self) -> bool {
        self.ag_features & ag::ENHANCED_STATUS != 0 && !self.clcc_broken
    }

    /// A call indicator, `RING`, `+CLIP` or `+CCWA` came: work out the calls again.
    fn calls_changed(&mut self, now: u64) {
        let (call, setup, held) = (self.indicator("call").unwrap_or(0), self.indicator("callsetup").unwrap_or(0), self.indicator("callheld").unwrap_or(0));
        if call == 0 && setup == 0 && held == 0 && self.connected {
            // No call any more.
            self.clip = None;
            self.ccwa = None;
            self.alerts = 0;
            self.primary = None;
            self.clcc.clear();
        }
        match setup {
            1 if call == 0 => self.primary = Some((Dir::In, self.clip.as_ref().map(|c| c.0.clone()).unwrap_or_default())),
            2 | 3 if call == 0 && self.primary.as_ref().map_or(true, |p| p.0 != Dir::Out) => {
                self.primary = Some((Dir::Out, self.dialed.clone()))
            }
            _ => {}
        }
        if self.uses_clcc() && self.connected && (call, setup, held) != (0, 0, 0) {
            // Ask again unless a request is already queued and not yet written (it will see this
            // change too). One in flight may have been answered before the change.
            if !self.queue.iter().any(|c| c.kind == Kind::Clcc && c.sent.is_none()) {
                self.push("AT+CLCC".into(), Kind::Clcc);
            }
        }
        self.refresh(now);
    }

    /// The calls from the indicators, for phones without `AT+CLCC`.
    fn synthesized(&self) -> Vec<LiveCall> {
        let (call, setup, held) = (self.indicator("call").unwrap_or(0), self.indicator("callsetup").unwrap_or(0), self.indicator("callheld").unwrap_or(0));
        let (dir, number) = self.primary.clone().unwrap_or((Dir::Out, String::new()));
        let make = |idx, number: String, dir, state| LiveCall { idx, number, name: None, dir, state, since: None };
        let mut calls = Vec::new();
        if call == 1 {
            calls.push(make(1, number.clone(), dir, if held == 2 { CallState::Held } else { CallState::Active }));
            if held == 1 {
                calls.push(make(2, String::new(), Dir::Out, CallState::Held));
            }
        }
        let next = calls.len() as u32 + 1;
        match setup {
            1 if call == 1 => calls.push(make(next, self.ccwa.as_ref().map(|c| c.0.clone()).unwrap_or_default(), Dir::In, CallState::Waiting)),
            1 => calls.push(make(next, self.clip.as_ref().map(|c| c.0.clone()).unwrap_or_default(), Dir::In, CallState::Incoming)),
            2 => calls.push(make(next, if call == 1 { self.dialed.clone() } else { number }, Dir::Out, CallState::Dialing)),
            3 => calls.push(make(next, if call == 1 { self.dialed.clone() } else { number }, Dir::Out, CallState::Alerting)),
            _ => {}
        }
        calls
    }

    fn refresh(&mut self, now: u64) {
        let mut calls = if self.uses_clcc() { self.clcc.clone() } else { self.synthesized() };
        for call in &mut calls {
            // The name the phone sent with the caller ID.
            if call.name.is_none() {
                call.name = [&self.clip, &self.ccwa]
                    .into_iter()
                    .flatten()
                    .find(|(number, _)| !number.is_empty() && same_number(number, &call.number))
                    .and_then(|(_, name)| name.clone());
            }
            let before = self.calls.iter().find(|c| c.idx == call.idx && same_number(&c.number, &call.number));
            call.since = before.and_then(|c| c.since).or((call.state == CallState::Active).then_some(now));
        }
        if calls != self.calls {
            self.calls = calls;
            self.events.push(Event::Changed);
        }
        self.announce();
    }

    /// A `Ring` for each call that started ringing. Without `AT+CLCC` a call is announced once its
    /// caller ID came, or after the second `RING` (a withheld number).
    fn announce(&mut self) {
        let synthesized = !self.uses_clcc();
        let ringing: Vec<LiveCall> = self.calls.iter().filter(|c| c.state.ringing()).cloned().collect();
        self.announced.retain(|idx| ringing.iter().any(|c| c.idx == *idx));
        for call in ringing {
            if self.announced.contains(&call.idx) {
                continue;
            }
            if synthesized && call.number.is_empty() && self.alerts < 2 {
                continue;
            }
            self.announced.insert(call.idx);
            self.events.push(Event::Ring(call));
        }
    }
}

/// A number the phone can dial: digits with `*`, `#` and a leading `+`; spaces, dashes, dots and
/// brackets are dropped.
pub fn dialable(number: &str) -> Option<String> {
    let mut out = String::new();
    for c in number.trim().chars() {
        match c {
            '0'..='9' | '*' | '#' => out.push(c),
            '+' if out.is_empty() => out.push(c),
            ' ' | '-' | '.' | '(' | ')' | '/' | '\u{a0}' => {}
            _ => return None,
        }
    }
    (!out.is_empty() && out != "+").then_some(out)
}

/// Two numbers are the same call when their digits agree (the last 9 when both are long enough,
/// so "+8801712345678" and "01712345678" match).
pub fn same_number(a: &str, b: &str) -> bool {
    let digits = |s: &str| s.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
    let (a, b) = (digits(a), digits(b));
    if a.is_empty() || b.is_empty() {
        return a == b;
    }
    if a.len() >= 9 && b.len() >= 9 {
        return a[a.len() - 9..] == b[b.len() - 9..];
    }
    a == b
}

/// Splits `a,"b,c",d` into its arguments, keeping quotes off and commas in quotes.
fn args(rest: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(String::new()),
            _ => out.last_mut().unwrap().push(c),
        }
    }
    out.into_iter().map(|a| a.trim().to_string()).collect()
}

fn num(args: &[String], i: usize) -> Option<u32> {
    args.get(i)?.parse().ok()
}

fn text(args: &[String], i: usize) -> Option<String> {
    args.get(i).filter(|a| !a.is_empty()).cloned()
}

/// Every quoted string, in order: the indicator names of `+CIND: ("call",(0,1)),…`.
fn quoted(rest: &str) -> Vec<String> {
    rest.split('"').skip(1).step_by(2).map(str::to_string).collect()
}

/// `+CLCC: <idx>,<dir>,<stat>,<mode>,<mpty>[,<number>,<type>[,<alpha>]]`
fn clcc(rest: &str) -> Option<LiveCall> {
    let args = args(rest);
    let idx = num(&args, 0)?;
    let dir = if num(&args, 1)? == 1 { Dir::In } else { Dir::Out };
    let state = CallState::from_clcc(num(&args, 2)?)?;
    Some(LiveCall { idx, number: text(&args, 5).unwrap_or_default(), name: text(&args, 7), dir, state, since: None })
}

/// What to tell the user when a command failed.
fn rejected(user: User, error: &str) -> String {
    let cme = error.strip_prefix("+CME ERROR: ").and_then(|c| c.parse::<u32>().ok());
    let reason = match (error, cme) {
        ("BUSY", _) => Some("the line is busy"),
        ("NO ANSWER", _) => Some("nobody answered"),
        ("NO CARRIER", _) => Some("the call couldn't be connected"),
        ("BLACKLISTED" | "DELAYED", _) => Some("the phone is holding back calls to this number"),
        (_, Some(30)) => Some("the phone has no network"),
        (_, Some(32)) => Some("the network only allows emergency calls"),
        (_, Some(3)) => Some("the phone doesn't allow it right now"),
        (_, Some(4)) => Some("the phone doesn't support it"),
        (_, Some(10)) => Some("the phone has no SIM card"),
        (_, Some(11)) => Some("the SIM card is locked"),
        _ if error.contains("didn't answer") => Some("the phone didn't answer"),
        _ => None,
    };
    let what = match user {
        User::Dial => "The phone couldn't place the call",
        User::Answer => "The phone couldn't answer",
        User::Hangup => "The phone couldn't hang up",
        User::Dtmf => "The phone couldn't send the key",
        User::Hold => "The phone couldn't switch the calls",
        User::Volume => "The phone didn't take the volume",
    };
    match reason {
        Some(reason) => format!("{what}: {reason}."),
        None => format!("{what}."),
    }
}


#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// A typical Android phone's indicator list.
    const CIND_TEST: &str = "+CIND: (\"call\",(0,1)),(\"callsetup\",(0-3)),(\"service\",(0-1)),(\"signal\",(0-5)),(\"roam\",(0,1)),(\"battchg\",(0-5)),(\"callheld\",(0-2))";
    /// AG features: three-way, NREC, in-band ring, reject, enhanced call status and control,
    /// extended errors.
    const FULL: u32 = 0b1_1110_1011;

    /// A scripted phone: it answers every command at once, `AT+CLCC` with its call list and the
    /// rest with `OK` unless a reply was set for it.
    struct Ag {
        hf: Hf,
        now: u64,
        clcc: Vec<String>,
        replies: HashMap<String, String>,
        log: Vec<String>,
        events: Vec<Event>,
    }

    impl Ag {
        fn new(features: u32, cind: &str) -> Self {
            let mut replies = HashMap::new();
            replies.insert("AT+BRSF=118".to_string(), format!("+BRSF: {features}\r\n\r\nOK"));
            replies.insert("AT+CIND=?".to_string(), format!("{CIND_TEST}\r\n\r\nOK"));
            replies.insert("AT+CIND?".to_string(), format!("+CIND: {cind}\r\n\r\nOK"));
            replies.insert("AT+CHLD=?".to_string(), "+CHLD: (0,1,1x,2,2x,3,4)\r\n\r\nOK".to_string());
            replies.insert("AT+COPS?".to_string(), "+COPS: 0,0,\"Grameenphone\"\r\n\r\nOK".to_string());
            Self { hf: Hf::new(9, true), now: 0, clcc: Vec::new(), replies, log: Vec::new(), events: Vec::new() }
        }

        fn connect(features: u32, cind: &str) -> Self {
            let mut ag = Self::new(features, cind);
            ag.hf.start(0);
            ag.settle();
            assert!(ag.hf.connected());
            ag.log.clear();
            ag.events.clear();
            ag
        }

        /// Answers whatever Zazabor wrote, until it has nothing more to say.
        fn settle(&mut self) {
            loop {
                let out = self.hf.take();
                self.events.extend(out.events);
                if out.write.is_empty() {
                    return;
                }
                for cmd in String::from_utf8(out.write).unwrap().split('\r').filter(|c| !c.is_empty()) {
                    self.log.push(cmd.to_string());
                    let reply = if cmd == "AT+CLCC" {
                        self.clcc.iter().map(|l| format!("\r\n+CLCC: {l}\r\n")).collect::<String>() + "\r\nOK"
                    } else {
                        self.replies.get(cmd).cloned().unwrap_or_else(|| "OK".into())
                    };
                    self.hf.feed(format!("\r\n{reply}\r\n").as_bytes(), self.now);
                }
            }
        }

        /// The phone sends unsolicited lines at `now`.
        fn says(&mut self, now: u64, lines: &[&str]) {
            self.now = now;
            for line in lines {
                self.hf.feed(format!("\r\n{line}\r\n").as_bytes(), now);
            }
            self.settle();
        }

        fn ask(&mut self, now: u64, request: Request) -> Result<(), String> {
            self.now = now;
            let r = self.hf.request(request, now);
            self.settle();
            r
        }

        fn rings(&mut self) -> Vec<LiveCall> {
            let rings = self.events.iter().filter_map(|e| if let Event::Ring(c) = e { Some(c.clone()) } else { None }).collect();
            self.events.clear();
            rings
        }
    }

    #[test]
    fn service_level_connection_in_spec_order() {
        let mut ag = Ag::new(FULL, "0,0,1,4,0,3,0");
        ag.hf.start(0);
        ag.settle();
        assert_eq!(
            ag.log,
            [
                "AT+BRSF=118",
                "AT+CIND=?",
                "AT+CIND?",
                "AT+CMER=3,0,0,1",
                "AT+CHLD=?",
                "AT+CLIP=1",
                "AT+CCWA=1",
                "AT+CMEE=1",
                "AT+NREC=0",
                "AT+VGS=9",
                "AT+COPS=3,0",
                "AT+COPS?",
            ]
        );
        assert_eq!(ag.events.first(), Some(&Event::Connected));
        assert!(ag.hf.connected());
        assert_eq!(ag.hf.battery(), Some(60));
        assert_eq!(ag.hf.signal(), Some(3));
        assert_eq!(ag.hf.service(), Some(true));
        assert_eq!(ag.hf.roaming(), Some(false));
        assert_eq!(ag.hf.carrier(), Some("Grameenphone"));
        assert!(ag.hf.inband_ring());
        assert!(ag.hf.calls().is_empty());
    }

    #[test]
    fn plain_phone_skips_optional_steps() {
        // HFP 0.96: no AT+BRSF (ERROR), so no AG features: no CHLD, CCWA, CMEE, NREC or CLCC.
        let mut ag = Ag::new(0, "0,0,1,5,0,5,0");
        ag.replies.insert("AT+BRSF=118".into(), "ERROR".into());
        ag.hf.start(0);
        ag.settle();
        assert_eq!(ag.log, ["AT+BRSF=118", "AT+CIND=?", "AT+CIND?", "AT+CMER=3,0,0,1", "AT+CLIP=1", "AT+VGS=9", "AT+COPS=3,0", "AT+COPS?"]);
        assert!(ag.hf.connected());
        assert!(ag.hf.request(Request::Hold(2), 1).is_err());
    }

    #[test]
    fn connecting_mid_call_reads_the_call() {
        let mut ag = Ag::new(FULL, "1,0,1,4,0,3,0");
        ag.clcc = vec!["1,0,0,0,0,\"123\",129".into()];
        ag.hf.start(0);
        ag.settle();
        assert!(ag.log.contains(&"AT+CLCC".to_string()));
        assert_eq!(ag.hf.calls()[0].state, CallState::Active);
    }

    #[test]
    fn rejected_slc_fails() {
        let mut ag = Ag::new(0, "");
        ag.replies.insert("AT+CMER=3,0,0,1".into(), "ERROR".into());
        ag.hf.start(0);
        ag.settle();
        assert!(matches!(ag.events.as_slice(), [Event::Failed(_)]));
        assert!(!ag.hf.connected());
        assert!(ag.hf.request(Request::Answer, 2).is_err());
    }

    #[test]
    fn slc_times_out() {
        let mut hf = Hf::new(9, false);
        hf.start(0);
        assert_eq!(hf.take().write, b"AT+BRSF=118\r");
        hf.tick(5_000);
        assert_eq!(hf.take(), Output::default());
        hf.tick(10_000);
        // BRSF gave up; it goes on with CIND=? like with an old phone.
        assert_eq!(hf.take().write, b"AT+CIND=?\r");
        hf.tick(20_001);
        assert!(matches!(hf.take().events.as_slice(), [Event::Failed(_)]));
    }

    #[test]
    fn incoming_call_with_clcc() {
        let mut ag = Ag::connect(FULL, "0,0,1,4,0,3,0");
        // callsetup = 1: Zazabor asks for the call list and announces the call from it.
        ag.clcc = vec!["1,1,4,0,0,\"+8801712345678\",145".into()];
        ag.says(100, &["+CIEV: 2,1", "RING", "+CLIP: \"+8801712345678\",145,,,\"Rahim\""]);
        assert!(ag.log.iter().all(|c| c == "AT+CLCC"));
        let rings = ag.rings();
        assert_eq!(rings.len(), 1);
        assert_eq!(rings[0], LiveCall { idx: 1, number: "+8801712345678".into(), name: Some("Rahim".into()), dir: Dir::In, state: CallState::Incoming, since: None });
        // The next RING doesn't ring again.
        ag.says(200, &["RING"]);
        assert!(ag.rings().is_empty());

        // Answered: ATA, then call = 1 and callsetup = 0.
        ag.log.clear();
        ag.ask(300, Request::Answer).unwrap();
        assert_eq!(ag.log, ["ATA"]);
        ag.clcc = vec!["1,1,0,0,0,\"+8801712345678\",145".into()];
        ag.says(400, &["+CIEV: 1,1", "+CIEV: 2,0"]);
        let call = ag.hf.calls()[0].clone();
        assert_eq!((call.state, call.since, call.name.as_deref()), (CallState::Active, Some(400), Some("Rahim")));
        // Later lists keep the start time; other indicators just change.
        ag.says(500, &["+CIEV: 4,5", "+CIEV: 3,0", "+CIEV: 3,1"]);
        assert_eq!(ag.hf.signal(), Some(4));
        assert_eq!(ag.hf.calls()[0].since, Some(400));

        // Hang up.
        ag.log.clear();
        ag.ask(600, Request::Hangup).unwrap();
        assert_eq!(ag.log, ["AT+CHUP"]);
        ag.clcc.clear();
        ag.events.clear();
        ag.says(700, &["+CIEV: 1,0"]);
        assert!(ag.events.contains(&Event::Changed));
        assert!(ag.hf.calls().is_empty());
    }

    #[test]
    fn waiting_call_with_clcc() {
        let mut ag = Ag::connect(FULL, "1,0,1,4,0,3,0");
        ag.clcc = vec!["1,0,0,0,0,\"123\",129".into(), "2,1,5,0,0,\"+15551234567\",145".into()];
        ag.says(10, &["+CCWA: \"+15551234567\",145,1", "+CIEV: 2,1"]);
        let rings = ag.rings();
        assert_eq!((rings.len(), rings[0].state, rings[0].idx), (1, CallState::Waiting, 2));
        ag.log.clear();
        ag.ask(20, Request::Decline).unwrap();
        assert_eq!(ag.log[0], "AT+CHLD=0");
        // Swap to the waiting call.
        ag.log.clear();
        ag.ask(30, Request::Hold(2)).unwrap();
        assert_eq!(ag.log[0], "AT+CHLD=2");
    }

    #[test]
    fn incoming_call_without_clcc() {
        // AG features: three-way only, no enhanced call status: calls come from the indicators.
        let mut ag = Ag::connect(1, "0,0,1,4,0,3,0");
        ag.says(10, &["+CIEV: 2,1", "RING"]);
        assert!(ag.log.is_empty(), "no AT+CLCC: {:?}", ag.log);
        assert!(ag.rings().is_empty(), "waits for the caller ID");
        ag.says(20, &["+CLIP: \"01712345678\",129"]);
        let rings = ag.rings();
        assert_eq!((rings[0].number.as_str(), rings[0].state, rings[0].dir), ("01712345678", CallState::Incoming, Dir::In));

        ag.says(30, &["+CIEV: 1,1", "+CIEV: 2,0"]);
        let call = &ag.hf.calls()[0];
        assert_eq!((call.state, call.number.as_str(), call.since), (CallState::Active, "01712345678", Some(30)));

        // A second call waits beside it.
        ag.says(40, &["+CCWA: \"+15551234567\",145,1", "+CIEV: 2,1"]);
        let rings = ag.rings();
        assert_eq!((rings[0].state, rings[0].number.as_str()), (CallState::Waiting, "+15551234567"));
        ag.ask(50, Request::Decline).unwrap();
        assert_eq!(ag.log.last().unwrap(), "AT+CHLD=0");
        ag.says(60, &["+CIEV: 2,0"]);
        assert_eq!(ag.hf.calls().len(), 1);
        // The first call ends.
        ag.says(70, &["+CIEV: 1,0"]);
        assert!(ag.hf.calls().is_empty());
    }

    #[test]
    fn withheld_number_rings_on_the_second_ring() {
        let mut ag = Ag::connect(0, "0,0,1,4,0,3,0");
        ag.says(10, &["+CIEV: 2,1", "RING"]);
        assert!(ag.rings().is_empty());
        ag.says(20, &["RING"]);
        let rings = ag.rings();
        assert!(rings.len() == 1 && rings[0].number.is_empty());
    }

    #[test]
    fn outgoing_call() {
        let mut ag = Ag::connect(FULL, "0,0,1,4,0,3,0");
        assert!(ag.ask(0, Request::Dial("call me".into())).is_err());
        ag.ask(0, Request::Dial("+880 1712-345678".into())).unwrap();
        assert_eq!(ag.log, ["ATD+8801712345678;"]);
        ag.clcc = vec!["1,0,2,0,0,\"+8801712345678\",145".into()];
        ag.says(10, &["+CIEV: 2,2"]);
        assert_eq!(ag.hf.calls()[0].state, CallState::Dialing);
        ag.clcc = vec!["1,0,3,0,0,\"+8801712345678\",145".into()];
        ag.says(20, &["+CIEV: 2,3"]);
        assert_eq!((ag.hf.calls()[0].state, ag.hf.calls()[0].dir), (CallState::Alerting, Dir::Out));
        assert!(ag.rings().is_empty());

        ag.log.clear();
        assert!(ag.ask(30, Request::Dtmf('x')).is_err());
        ag.ask(30, Request::Dtmf('#')).unwrap();
        ag.ask(31, Request::Volume(20)).unwrap();
        ag.ask(32, Request::Redial).unwrap();
        assert_eq!(ag.log, ["AT+VTS=#", "AT+VGS=15", "AT+BLDN"]);
    }

    #[test]
    fn dial_errors_are_readable() {
        let mut ag = Ag::connect(FULL, "0,0,1,4,0,3,0");
        ag.replies.insert("ATD123;".into(), "+CME ERROR: 30".into());
        ag.ask(0, Request::Dial("123".into())).unwrap();
        assert_eq!(ag.events, [Event::Rejected("The phone couldn't place the call: the phone has no network.".into())]);
        ag.events.clear();
        ag.replies.insert("ATD123;".into(), "BUSY".into());
        ag.ask(0, Request::Dial("123".into())).unwrap();
        assert_eq!(ag.events, [Event::Rejected("The phone couldn't place the call: the line is busy.".into())]);
    }

    #[test]
    fn commands_wait_their_turn() {
        // Without the scripted phone: the second command waits for the first one's answer.
        let mut ag = Ag::connect(FULL, "0,0,1,4,0,3,0");
        let hf = &mut ag.hf;
        hf.request(Request::Dtmf('1'), 0).unwrap();
        hf.request(Request::Dtmf('2'), 0).unwrap();
        assert_eq!(hf.take().write, b"AT+VTS=1\r");
        hf.feed(b"\r\n+VGS: 3\r\n", 0);
        assert_eq!(hf.take().write, b"");
        hf.feed(b"\r\nOK\r\n", 0);
        assert_eq!(hf.take().write, b"AT+VTS=2\r");
        // A dial that never gets an answer gives up after 30 s.
        hf.feed(b"\r\nOK\r\n", 0);
        hf.request(Request::Dial("1".into()), 0).unwrap();
        hf.take();
        hf.tick(29_000);
        assert!(hf.take().events.is_empty());
        hf.tick(30_000);
        assert_eq!(hf.take().events, [Event::Rejected("The phone couldn't place the call: the phone didn't answer.".into())]);
    }

    #[test]
    fn unsolicited_lines() {
        let mut ag = Ag::connect(FULL, "0,0,1,4,0,3,0");
        ag.says(0, &["+VGS: 12", "+VGS=7", "+BSIR: 0", "+CIEV: 42,1", "+XAPL=whatever"]);
        assert!(ag.events.contains(&Event::Volume(12)) && ag.events.contains(&Event::Volume(7)));
        assert_eq!(ag.hf.volume(), 7);
        assert!(!ag.hf.inband_ring());
        // A line split across reads.
        ag.hf.feed(b"\r\n+CIEV: 6,", 0);
        ag.hf.feed(b"1\r\n", 0);
        assert_eq!(ag.hf.battery(), Some(20));
        // Stray results with nothing pending are ignored.
        ag.says(0, &["OK", "ERROR"]);
        assert!(ag.hf.connected());
    }

    #[test]
    fn helpers() {
        assert_eq!(dialable(" (555) 123-4567 "), Some("5551234567".into()));
        assert_eq!(dialable("*#06#"), Some("*#06#".into()));
        assert_eq!(dialable("+"), None);
        assert_eq!(dialable("1+2"), None);
        assert!(same_number("+8801712345678", "01712345678"));
        assert!(!same_number("123", "1234"));
        assert_eq!(args("1,\"a,b\",,x"), ["1", "a,b", "", "x"]);
        assert_eq!(quoted("(\"call\",(0,1)),(\"callsetup\",(0-3))"), ["call", "callsetup"]);
        assert_eq!(clcc("2,1,5,0,0,\"+1555\",145,\"Bob\"").unwrap().name.as_deref(), Some("Bob"));
        let json = serde_json::to_string(&LiveCall { idx: 1, number: "1".into(), name: None, dir: Dir::In, state: CallState::Incoming, since: None }).unwrap();
        assert_eq!(json, r#"{"idx":1,"number":"1","name":null,"dir":"in","state":"incoming","since":null}"#);
    }
}
