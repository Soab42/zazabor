//! One phone's hands-free connection: the RFCOMM socket BlueZ handed over, driven by the AT state
//! machine (`at.rs`). [`Session::run`] reads the phone's lines on its own thread; commands from the
//! page go through [`Session::request`]. Every write happens under the state machine's lock, so
//! commands keep their order.

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use super::at::{Event, Hf, Request};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub struct Session {
    /// The phone's BlueZ object path.
    pub device: String,
    /// "AA:BB:CC:DD:EE:FF"
    pub address: String,
    /// The phone's Bluetooth name.
    pub name: String,
    /// The adapter's address.
    pub adapter: String,
    fd: OwnedFd,
    hf: Mutex<Hf>,
    closed: AtomicBool,
}

impl Session {
    pub fn new(device: String, address: String, name: String, adapter: String, fd: OwnedFd, hf: Hf) -> Arc<Session> {
        // BlueZ may hand the socket over non-blocking; the reader polls anyway.
        // SAFETY: fcntl on a descriptor this session owns.
        unsafe {
            let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
            if flags >= 0 {
                libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK);
            }
        }
        Arc::new(Session { device, address, name, adapter, fd, hf: Mutex::new(hf), closed: AtomicBool::new(false) })
    }

    fn hf(&self) -> MutexGuard<'_, Hf> {
        self.hf.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Looks at the state machine (calls, indicators, …).
    pub fn with_hf<R>(&self, f: impl FnOnce(&Hf) -> R) -> R {
        f(&self.hf())
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Hangs up the link; `run` returns soon after.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        // SAFETY: shutdown on our own socket; it stays open (and owned) until the session drops.
        unsafe { libc::shutdown(self.fd.as_raw_fd(), libc::SHUT_RDWR) };
    }

    /// A command from the page.
    pub fn request(&self, request: Request) -> Result<Vec<Event>, String> {
        if self.is_closed() {
            return Err("The phone isn't connected for calls.".into());
        }
        let mut hf = self.hf();
        hf.request(request, now_ms())?;
        let out = hf.take();
        self.write(&out.write).map_err(|e| format!("Couldn't reach the phone: {e}"))?;
        Ok(out.events)
    }

    fn write(&self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            // SAFETY: writes from `bytes` within its length.
            let n = unsafe { libc::write(self.fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
            if n < 0 {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if err.kind() == io::ErrorKind::WouldBlock {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    continue;
                }
                return Err(err);
            }
            bytes = &bytes[n as usize..];
        }
        Ok(())
    }

    /// Sets up the service level connection and then reads the phone until the link closes.
    /// `on_event` runs for everything that happens, outside the lock.
    pub fn run(self: &Arc<Self>, mut on_event: impl FnMut(&Arc<Session>, Event)) {
        let step = |f: &mut dyn FnMut(&mut Hf)| -> Result<Vec<Event>, ()> {
            let mut hf = self.hf();
            f(&mut hf);
            let out = hf.take();
            self.write(&out.write).map_err(|_| ())?;
            Ok(out.events)
        };
        let mut events = step(&mut |hf| hf.start(now_ms())).unwrap_or_else(|_| vec![Event::Failed("Couldn't reach the phone.".into())]);
        let mut buf = [0u8; 1024];
        loop {
            let mut failed = false;
            for event in events.drain(..) {
                failed |= matches!(event, Event::Failed(_));
                on_event(self, event);
            }
            if failed || self.is_closed() {
                break;
            }
            let mut pfd = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            let ready = unsafe { libc::poll(&mut pfd, 1, 500) };
            if ready < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            let result = if ready == 0 {
                step(&mut |hf| hf.tick(now_ms()))
            } else {
                // SAFETY: reads into `buf` within its length.
                let n = unsafe { libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
                if n == 0 {
                    break;
                }
                if n < 0 {
                    let kind = io::Error::last_os_error().kind();
                    if matches!(kind, io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) {
                        continue;
                    }
                    break;
                }
                let bytes = &buf[..n as usize];
                step(&mut |hf| {
                    hf.feed(bytes, now_ms());
                    hf.tick(now_ms());
                })
            };
            match result {
                Ok(e) => events = e,
                Err(()) => break,
            }
        }
        self.closed.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::os::fd::FromRawFd;
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::super::at::{CallState, LiveCall};
    use super::*;

    /// A fake phone on the other end of a socket pair (RFCOMM is a byte stream, like this one).
    /// It answers the service level connection like an Android phone, then rings.
    #[test]
    fn talks_to_a_scripted_phone_over_a_socket() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let fd = OwnedFd::from(ours);
        let session = Session::new("/org/bluez/hci0/dev_X".into(), "11:22:33:44:55:66".into(), "Pixel".into(), "70:1A:B8:14:E1:86".into(), fd, Hf::new(10, false));

        let (heard_tx, heard_rx) = mpsc::channel::<String>();
        let (say_tx, say_rx) = mpsc::channel::<String>();
        let phone = std::thread::spawn(move || {
            let mut writer = theirs.try_clone().unwrap();
            let mut reader = BufReader::new(theirs);
            let mut clcc = String::new();
            loop {
                // Commands end with \r.
                let mut cmd = Vec::new();
                if reader.read_until(b'\r', &mut cmd).unwrap_or(0) == 0 {
                    return;
                }
                let cmd = String::from_utf8_lossy(&cmd).trim().to_string();
                if heard_tx.send(cmd.clone()).is_err() {
                    return;
                }
                let reply = match cmd.as_str() {
                    "AT+BRSF=118" => "+BRSF: 1003\r\n\r\nOK".to_string(),
                    "AT+CIND=?" => "+CIND: (\"call\",(0,1)),(\"callsetup\",(0-3)),(\"service\",(0-1)),(\"signal\",(0-5)),(\"roam\",(0,1)),(\"battchg\",(0-5)),(\"callheld\",(0-2))\r\n\r\nOK".into(),
                    "AT+CIND?" => "+CIND: 0,0,1,5,0,4,0\r\n\r\nOK".into(),
                    "AT+CHLD=?" => "+CHLD: (0,1,2,3)\r\n\r\nOK".into(),
                    "AT+COPS?" => "+COPS: 0,0,\"Robi\"\r\n\r\nOK".into(),
                    "AT+CLCC" => format!("{clcc}OK"),
                    _ => "OK".into(),
                };
                // The PC side may hang up while the phone answers; that ends the fake phone too.
                if writer.write_all(format!("\r\n{reply}\r\n").as_bytes()).is_err() {
                    return;
                }
                // After the carrier, the scripted call: unsolicited lines from the test.
                while let Ok(line) = say_rx.try_recv() {
                    if let Some(list) = line.strip_prefix("clcc:") {
                        clcc = list.to_string();
                    } else {
                        if writer.write_all(format!("\r\n{line}\r\n").as_bytes()).is_err() {
                            return;
                        }
                    }
                }
            }
        });

        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let runner = {
            let session = session.clone();
            std::thread::spawn(move || session.run(move |_, e| event_tx.send(e).unwrap()))
        };
        let wait_for = |pred: &dyn Fn(&Event) -> bool| loop {
            let e = event_rx.recv_timeout(Duration::from_secs(5)).expect("event");
            if pred(&e) {
                return e;
            }
        };
        wait_for(&|e| *e == Event::Connected);
        // Let the setup commands finish (the last one reads the carrier).
        loop {
            if heard_rx.recv_timeout(Duration::from_secs(5)).unwrap() == "AT+COPS?" {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(session.with_hf(|hf| (hf.carrier().map(String::from), hf.battery(), hf.signal())), (Some("Robi".into()), Some(80), Some(4)));

        // An incoming call. The phone sends it on its next answer, so poke it with a keypress-free
        // command: the volume.
        say_tx.send("clcc:\r\n+CLCC: 1,1,4,0,0,\"+8801812345678\",145\r\n\r\n".into()).unwrap();
        say_tx.send("+CIEV: 2,1".into()).unwrap();
        say_tx.send("RING".into()).unwrap();
        session.request(Request::Volume(11)).unwrap();
        let ring = wait_for(&|e| matches!(e, Event::Ring(_)));
        assert_eq!(ring, Event::Ring(LiveCall { idx: 1, number: "+8801812345678".into(), name: None, dir: super::super::at::Dir::In, state: CallState::Incoming, since: None }));

        session.request(Request::Answer).unwrap();
        loop {
            if heard_rx.recv_timeout(Duration::from_secs(5)).unwrap() == "ATA" {
                break;
            }
        }

        // The phone drops the link: run returns.
        session.close();
        runner.join().unwrap();
        assert!(session.is_closed());
        assert!(session.request(Request::Hangup).is_err());
        phone.join().unwrap();
    }

    #[test]
    fn fails_when_the_phone_refuses() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        // SAFETY: into_raw_fd hands over the descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(std::os::fd::IntoRawFd::into_raw_fd(ours)) };
        let session = Session::new("d".into(), "a".into(), "n".into(), "x".into(), fd, Hf::new(10, false));
        let phone = std::thread::spawn(move || {
            let mut writer = theirs.try_clone().unwrap();
            let mut reader = BufReader::new(theirs);
            let mut cmd = Vec::new();
            while reader.read_until(b'\r', &mut cmd).unwrap_or(0) > 0 {
                let _ = writer.write_all(b"\r\nERROR\r\n");
                cmd.clear();
            }
        });
        let mut events = Vec::new();
        session.run(|_, e| events.push(e));
        assert!(matches!(events.last(), Some(Event::Failed(_))));
        drop(session);
        phone.join().unwrap();
    }
}
