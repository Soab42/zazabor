//! The call's audio link: a Bluetooth SCO socket (`BTPROTO_SCO`) with the CVSD voice setting, so
//! the controller turns the air's CVSD into 16-bit PCM at 8 kHz. The phone opens it when a call's
//! audio should come to the PC (Zazabor listens on the adapter), or Zazabor opens it itself
//! ("audio to the PC"). Closing it moves the audio back to the phone.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use super::audio::Audio;

const BTPROTO_SCO: libc::c_int = 2;
const SOL_BLUETOOTH: libc::c_int = 274;
const BT_DEFER_SETUP: libc::c_int = 7;
const BT_VOICE: libc::c_int = 11;
/// `BT_VOICE_CVSD_16BIT`: CVSD on the air, 16-bit linear PCM on the socket.
const BT_VOICE_CVSD_16BIT: u16 = 0x0060;

/// A Bluetooth address as the kernel stores it (bytes reversed).
pub type Addr = [u8; 6];

#[repr(C)]
#[derive(Clone, Copy)]
struct SockaddrSco {
    family: libc::sa_family_t,
    bdaddr: Addr,
}

/// "70:1A:B8:14:E1:86" → the kernel's byte order.
pub fn parse_addr(text: &str) -> Option<Addr> {
    let parts: Vec<u8> = text.split(':').map(|p| u8::from_str_radix(p, 16)).collect::<Result<_, _>>().ok()?;
    let mut addr: Addr = parts.try_into().ok()?;
    addr.reverse();
    Some(addr)
}

pub fn format_addr(addr: &Addr) -> String {
    addr.iter().rev().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

fn check(ret: libc::c_int) -> io::Result<libc::c_int> {
    if ret < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(ret)
    }
}

fn sockaddr(addr: &Addr) -> SockaddrSco {
    SockaddrSco { family: libc::AF_BLUETOOTH as libc::sa_family_t, bdaddr: *addr }
}

/// A CVSD SCO socket bound to the adapter.
fn socket(adapter: &Addr) -> io::Result<OwnedFd> {
    // SAFETY: plain socket calls on a descriptor this function owns; the address structs live
    // for the duration of each call.
    unsafe {
        let fd = OwnedFd::from_raw_fd(check(libc::socket(libc::AF_BLUETOOTH, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, BTPROTO_SCO))?);
        let local = sockaddr(adapter);
        check(libc::bind(fd.as_raw_fd(), (&local as *const SockaddrSco).cast(), std::mem::size_of::<SockaddrSco>() as libc::socklen_t))?;
        let voice: u16 = BT_VOICE_CVSD_16BIT;
        check(libc::setsockopt(fd.as_raw_fd(), SOL_BLUETOOTH, BT_VOICE, (&voice as *const u16).cast(), std::mem::size_of::<u16>() as libc::socklen_t))?;
        Ok(fd)
    }
}

/// Listens for the phone's audio connections on the adapter. Connections are deferred: the
/// kernel only completes one once Zazabor [`authorize`]s it, so one from another device (a
/// headset) is turned down by closing it.
pub struct Listener {
    fd: OwnedFd,
}

impl Listener {
    pub fn new(adapter: &Addr) -> io::Result<Listener> {
        let fd = socket(adapter)?;
        let defer: u32 = 1;
        // SAFETY: setsockopt/listen on the socket just made; `defer` outlives the call.
        unsafe {
            check(libc::setsockopt(fd.as_raw_fd(), SOL_BLUETOOTH, BT_DEFER_SETUP, (&defer as *const u32).cast(), std::mem::size_of::<u32>() as libc::socklen_t))?;
            check(libc::listen(fd.as_raw_fd(), 1))?;
        }
        Ok(Listener { fd })
    }

    /// The next connection and who it's from, or None after `timeout_ms` without one.
    pub fn accept(&self, timeout_ms: i32) -> io::Result<Option<(OwnedFd, Addr)>> {
        if !poll_in(self.fd.as_raw_fd(), timeout_ms)? {
            return Ok(None);
        }
        let mut peer = sockaddr(&[0; 6]);
        let mut len = std::mem::size_of::<SockaddrSco>() as libc::socklen_t;
        // SAFETY: `peer` and `len` describe a writable SockaddrSco.
        let fd = unsafe { libc::accept4(self.fd.as_raw_fd(), (&mut peer as *mut SockaddrSco).cast(), &mut len, libc::SOCK_CLOEXEC) };
        if fd < 0 {
            let err = io::Error::last_os_error();
            return if matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) { Ok(None) } else { Err(err) };
        }
        // SAFETY: accept4 returned a new descriptor that nothing else owns.
        Ok(Some((unsafe { OwnedFd::from_raw_fd(fd) }, peer.bdaddr)))
    }
}

/// Completes a deferred connection (the kernel accepts it on the first read, which returns 0).
pub fn authorize(fd: &OwnedFd) -> io::Result<()> {
    let mut byte = 0u8;
    // SAFETY: reads at most one byte into `byte`.
    check(unsafe { libc::read(fd.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) } as libc::c_int).map(|_| ())
}

/// Opens the audio link to the phone (blocks until it's up or refused).
pub fn connect(adapter: &Addr, phone: &Addr) -> io::Result<OwnedFd> {
    let fd = socket(adapter)?;
    let remote = sockaddr(phone);
    loop {
        // SAFETY: `remote` is a valid SockaddrSco for the call.
        let ret = unsafe { libc::connect(fd.as_raw_fd(), (&remote as *const SockaddrSco).cast(), std::mem::size_of::<SockaddrSco>() as libc::socklen_t) };
        match check(ret) {
            Ok(_) => return Ok(fd),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

fn poll_in(fd: RawFd, timeout_ms: i32) -> io::Result<bool> {
    let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    // SAFETY: one valid pollfd.
    match unsafe { libc::poll(&mut pfd, 1, timeout_ms) } {
        n if n < 0 => {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(err)
            }
        }
        0 => Ok(false),
        _ => Ok(true),
    }
}

/// What the rest of Zazabor changes while a call's audio runs.
#[derive(Debug)]
pub struct Flags {
    pub stop: AtomicBool,
    pub muted: AtomicBool,
    pub volume: AtomicU8,
}

impl Flags {
    pub fn new(muted: bool, volume: u8) -> Flags {
        Flags { stop: AtomicBool::new(false), muted: AtomicBool::new(muted), volume: AtomicU8::new(volume) }
    }
}

/// Moves the audio until the link closes or `flags.stop` is set: every packet the phone sends is
/// played, and answered with as many bytes of the mic.
pub fn pump(fd: &OwnedFd, audio: &mut Audio, flags: &Flags) -> Result<(), String> {
    let mut buf = [0u8; 1024];
    let mut volume = u8::MAX;
    loop {
        if flags.stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let level = flags.volume.load(Ordering::Relaxed);
        if level != volume {
            audio.set_volume(level);
            volume = level;
        }
        if !poll_in(fd.as_raw_fd(), 200).map_err(|e| e.to_string())? {
            if let Some(err) = audio.error() {
                return Err(err);
            }
            continue;
        }
        // SAFETY: reads into `buf` within its length.
        let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n == 0 {
            return Ok(());
        }
        if n < 0 {
            let err = io::Error::last_os_error();
            match err.kind() {
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted => continue,
                // The phone took the audio back or the link dropped.
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted | io::ErrorKind::NotConnected => return Ok(()),
                _ => return Err(format!("The call audio link failed: {err}")),
            }
        }
        let n = n as usize;
        audio.play(&buf[..n]);
        let mic = audio.mic(n, flags.muted.load(Ordering::Relaxed));
        // SAFETY: writes `mic` within its length.
        let wrote = unsafe { libc::write(fd.as_raw_fd(), mic.as_ptr().cast(), mic.len()) };
        if wrote < 0 {
            let err = io::Error::last_os_error();
            if !matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::super::audio::tests::fake_ends;
    use super::*;

    #[test]
    fn addresses() {
        let addr = parse_addr("70:1A:B8:14:E1:86").unwrap();
        assert_eq!(addr, [0x86, 0xE1, 0x14, 0xB8, 0x1A, 0x70]);
        assert_eq!(format_addr(&addr), "70:1A:B8:14:E1:86");
        assert_eq!(parse_addr("70:1A:B8:14:E1"), None);
        assert_eq!(parse_addr("zz:1A:B8:14:E1:86"), None);
        assert_eq!(std::mem::size_of::<SockaddrSco>(), 8);
    }

    /// A SEQPACKET socket pair stands in for the SCO link: the "phone" sends 48-byte packets
    /// every 3 ms like a USB controller and gets the same size back.
    #[test]
    fn pump_answers_packet_for_packet() {
        let mut fds = [0; 2];
        // SAFETY: socketpair fills two new descriptors.
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) }, 0);
        // SAFETY: both descriptors are new and owned here.
        let (ours, phone) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        let flags = Arc::new(Flags::new(false, 12));
        let thread = {
            let flags = flags.clone();
            std::thread::spawn(move || {
                let mut audio = Audio::new(&fake_ends(), false).unwrap();
                pump(&ours, &mut audio, &flags)
            })
        };
        let (mut packets, mut voiced) = (0, 0);
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(1500) {
            let tone: Vec<u8> = (0..48).map(|i| (i * 5) as u8).collect();
            // SAFETY: plain write/read on the test socket.
            assert_eq!(unsafe { libc::write(phone.as_raw_fd(), tone.as_ptr().cast(), tone.len()) }, 48);
            let mut back = [0u8; 256];
            assert!(poll_in(phone.as_raw_fd(), 1000).unwrap(), "the pump answers");
            let n = unsafe { libc::read(phone.as_raw_fd(), back.as_mut_ptr().cast(), back.len()) };
            assert_eq!(n, 48, "same size back");
            packets += 1;
            if back[..48].iter().any(|&b| b != 0) {
                voiced += 1;
            }
            std::thread::sleep(Duration::from_millis(3));
        }
        assert!(packets > 100);
        assert!(voiced > 0, "the mic's tone went to the phone");
        // Muted: only silence.
        flags.muted.store(true, Ordering::Relaxed);
        for _ in 0..5 {
            unsafe { libc::write(phone.as_raw_fd(), [1u8; 48].as_ptr().cast(), 48) };
            let mut back = [0u8; 64];
            assert!(poll_in(phone.as_raw_fd(), 1000).unwrap());
            let n = unsafe { libc::read(phone.as_raw_fd(), back.as_mut_ptr().cast(), back.len()) };
            assert!(n == 48 && back[..48].iter().all(|&b| b == 0));
        }
        // The phone closes the link: the pump ends.
        drop(phone);
        assert_eq!(thread.join().unwrap(), Ok(()));
    }

    #[test]
    fn pump_stops_when_asked() {
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) }, 0);
        let (ours, _phone) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        let flags = Arc::new(Flags::new(false, 12));
        flags.stop.store(true, Ordering::Relaxed);
        let mut audio = Audio::new(&fake_ends(), false).unwrap();
        assert_eq!(pump(&ours, &mut audio, &flags), Ok(()));
    }
}
