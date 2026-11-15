//! The hub and the link end to end: the real listener on 127.0.0.1 and a fake phone written
//! here (no mDNS, no window).

use super::link::{self, Cipher, Frame};
use super::*;
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::rand::SystemRandom;
use sha2::{Digest, Sha256};
use std::io::{BufReader, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Instant;

struct TestHost {
    events: Arc<Mutex<Vec<(String, Value)>>>,
    desktop: Arc<Mutex<Vec<String>>>,
    dir: PathBuf,
}

impl Host for TestHost {
    fn emit(&self, event: &str, payload: Value) {
        lock(&self.events).push((event.to_string(), payload));
    }
    fn settings(&self) -> Settings {
        Settings { pc_name: "Test PC".into(), download_dir: self.dir.clone(), notify: true, mirror_notifs: true, clip: false }
    }
    fn desktop(&self, title: &str, body: &str, _icon: &str, _open: Value) {
        lock(&self.desktop).push(format!("{title}: {body}"));
    }
}

fn wait_for<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let start = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn sha(bytes: &[u8]) -> String {
    link::hex(&Sha256::digest(bytes))
}

/// Bytes that aren't all the same, so a misplaced chunk shows.
fn pattern(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| (i as u32).wrapping_mul(2654435761).to_be_bytes()[0] ^ seed).collect()
}

/// What the fake phone saw that wasn't a request it answered.
#[derive(Debug)]
enum Seen {
    Msg(Value),
    /// A file the PC put, with its bytes and whether the hash matched.
    Put(String, Vec<u8>, bool),
}

/// The fake phone's side of a connection.
struct Phone {
    w: Arc<Mutex<(TcpStream, Cipher)>>,
    seen: mpsc::Receiver<Seen>,
}

impl Phone {
    fn send(&self, frame: Frame) {
        let mut w = lock(&self.w);
        let (stream, cipher) = &mut *w;
        link::write_frame(stream, cipher, &frame).unwrap();
    }

    fn next_msg(&self, t: &str) -> Value {
        let start = Instant::now();
        loop {
            let left = Duration::from_secs(10).saturating_sub(start.elapsed());
            match self.seen.recv_timeout(left).unwrap_or_else(|_| panic!("timed out waiting for {t}")) {
                Seen::Msg(v) if v["t"] == t => return v,
                _ => {}
            }
        }
    }

    fn next_put(&self) -> (String, Vec<u8>, bool) {
        loop {
            if let Seen::Put(p, b, ok) = self.seen.recv_timeout(Duration::from_secs(10)).expect("a file") {
                return (p, b, ok);
            }
        }
    }
}

/// Answers the PC's requests like Zazabor Link would, on its own thread.
fn serve(mut reader: BufReader<TcpStream>, mut rx: Cipher, w: Arc<Mutex<(TcpStream, Cipher)>>) -> mpsc::Receiver<Seen> {
    let (seen, out) = mpsc::channel();
    std::thread::spawn(move || {
        let send = |frame: Frame| {
            let mut w = lock(&w);
            let (stream, cipher) = &mut *w;
            link::write_frame(stream, cipher, &frame)
        };
        let mut puts: HashMap<u64, (String, Vec<u8>)> = HashMap::new();
        loop {
            let frame = match link::read_frame(&mut reader, &mut rx) {
                Ok(f) => f,
                Err(_) => return,
            };
            let msg = match frame {
                Frame::Data(x, bytes) => {
                    if let Some((_, buf)) = puts.get_mut(&(x as u64)) {
                        buf.extend_from_slice(&bytes);
                    }
                    continue;
                }
                Frame::Json(v) => v,
            };
            let rid = msg.get("rid").cloned();
            let re = |fields: Value| {
                let mut a = json!({"t": "re", "rid": rid.clone().unwrap(), "ok": true});
                a.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());
                Frame::Json(a)
            };
            match msg["t"].as_str().unwrap_or("") {
                "sms.threads" => {
                    let _ = send(re(json!({"threads": [
                        {"threadId": 7, "addresses": ["+8801711000000"], "name": "Ada", "snippet": "See you", "at": 1_700_000_000_000i64, "unread": 1, "count": 2},
                        {"threadId": 3, "addresses": ["+8801722000000"], "name": null, "snippet": "Old", "at": 1_600_000_000_000i64, "unread": 0, "count": 1}
                    ]})));
                }
                "contacts.list" => {
                    let _ = send(re(json!({"contacts": [{"id": 1, "name": "Ada Lovelace", "numbers": [{"number": "01711-000000", "label": "mobile"}], "starred": true, "hasPhoto": false}]})));
                }
                "files.get" => {
                    let xfer = msg["xfer"].as_u64().unwrap() as u32;
                    let path = msg["path"].as_str().unwrap();
                    let data = if path.starts_with("content://") { b"photo".to_vec() } else { pattern(700_000, 3) };
                    let mut answer = json!({"size": data.len()});
                    if path.starts_with("content://") {
                        answer["name"] = "IMG_0042.jpg".into();
                    }
                    let _ = send(re(answer));
                    for chunk in data.chunks(link::CHUNK) {
                        let _ = send(Frame::Data(xfer, chunk.to_vec()));
                    }
                    let _ = send(Frame::Json(json!({"t": "file.end", "xfer": xfer, "sha256": sha(&data)})));
                }
                "files.put" => {
                    let path = format!("/storage/emulated/0/{}/{}", msg["dir"].as_str().unwrap(), msg["name"].as_str().unwrap());
                    puts.insert(msg["xfer"].as_u64().unwrap(), (path.clone(), Vec::new()));
                    let _ = send(re(json!({"path": path})));
                }
                "file.end" => {
                    if let Some((path, bytes)) = puts.remove(&msg["xfer"].as_u64().unwrap()) {
                        let ok = sha(&bytes) == msg["sha256"].as_str().unwrap();
                        let _ = seen.send(Seen::Put(path, bytes, ok));
                    }
                }
                _ if rid.is_some() => {
                    let _ = send(re(json!({})));
                    let _ = seen.send(Seen::Msg(msg));
                }
                _ => {
                    let _ = seen.send(Seen::Msg(msg));
                }
            }
        }
    });
    out
}

const PHONE_ID: &str = "5947d7c33d783f94b3b4c1a96ebc8991";

/// The phone's opening lines; `commit` is SHA-256 of the key it will pair with (None leaves it out).
fn hello_line(stream: &mut TcpStream, pair: bool, commit: Option<&[u8]>) -> Vec<u8> {
    let nonce = [0x11u8; 16];
    stream.write_all(b"ZLNK/1\n").unwrap();
    let mut hello = json!({"phoneId": PHONE_ID, "name": "Pixel 7", "model": "Google Pixel 7", "nonce": link::base64(&nonce), "pair": pair});
    if let Some(c) = commit {
        hello["commit"] = link::base64(c).into();
    }
    stream.write_all(format!("{hello}\n").as_bytes()).unwrap();
    nonce.to_vec()
}

fn read_json_line(reader: &mut BufReader<TcpStream>) -> Value {
    serde_json::from_str(&link::read_line(reader).unwrap()).unwrap()
}

fn hello_frame() -> Frame {
    Frame::Json(json!({"t": "hello", "name": "Pixel 7", "model": "Google Pixel 7", "android": 34, "app": "1.0", "caps": ["sms", "contacts", "files"]}))
}

/// The pairing a new phone goes through; returns its link key.
fn pair_new_phone(hub: &Arc<Hub>, port: u16, events: &Arc<Mutex<Vec<(String, Value)>>>) -> [u8; 32] {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mine = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).unwrap();
    let my_pub = mine.compute_public_key().unwrap();
    let phone_nonce = hello_line(&mut stream, true, Some(Sha256::digest(my_pub.as_ref()).as_slice()));
    let answer = read_json_line(&mut reader);
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["pair"], true, "an unknown phone has to pair");
    assert_eq!(answer["pcId"], hub.pc_id.as_str());
    assert_eq!(answer["name"], "Test PC");
    let pc_nonce = link::unbase64(answer["nonce"].as_str().unwrap()).unwrap();
    let pc_pub = link::unbase64(answer["pub"].as_str().unwrap()).unwrap();
    assert_eq!(pc_pub.len(), 65);

    stream.write_all(format!("{}\n", json!({"pub": link::base64(my_pub.as_ref())})).as_bytes()).unwrap();
    let (key, code) = agree_ephemeral(mine, &UnparsedPublicKey::new(&ECDH_P256, &pc_pub), |z| (link::link_key(z, &phone_nonce, &pc_nonce), link::pair_code(z, &phone_nonce, &pc_nonce))).unwrap();

    // Both screens show the same code.
    let shown = wait_for("phone-pair", || lock(events).iter().find(|(e, _)| e == "phone-pair").map(|(_, v)| v.clone()));
    assert_eq!(shown["code"], link::show_code(code));
    assert_eq!(shown["phoneId"], PHONE_ID);
    assert_eq!(hub.state().pairing.unwrap().code, link::show_code(code));

    let (up, down) = link::session_keys(&key, &phone_nonce, &pc_nonce);
    let (mut tx, mut rx) = (Cipher::new(&up), Cipher::new(&down));
    link::write_frame(&mut stream, &mut tx, &Frame::Json(json!({"t": "pair.ok"}))).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert!(lock(&hub.pairing).is_some(), "pairing waits for the user too");
    hub.pair_answer(PHONE_ID, true).unwrap();
    assert_eq!(link::read_frame(&mut reader, &mut rx).unwrap(), Frame::Json(json!({"t": "pair.ok"})));
    wait_for("the pairing to be saved", || hub.with_db(|c| store::link_key(c, PHONE_ID)).unwrap());
    assert!(hub.state().pairing.is_none());

    // The same connection goes on with hello.
    link::write_frame(&mut stream, &mut tx, &hello_frame()).unwrap();
    wait_for("the phone to connect", || hub.is_connected(PHONE_ID).then_some(()));
    assert_eq!(hub.state().phones[0].name, "Pixel 7");
    // Requests from the refresh go unanswered here; hang up and come back as a known phone.
    let _ = stream.shutdown(std::net::Shutdown::Both);
    wait_for("the phone to go", || (!hub.is_connected(PHONE_ID)).then_some(()));
    key
}

fn connect_known(port: u16, key: &[u8; 32]) -> Phone {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let phone_nonce = hello_line(&mut stream, false, Some(&[5u8; 32][..]));
    let answer = read_json_line(&mut reader);
    assert_eq!(answer["ok"], true);
    assert!(answer.get("pair").is_none(), "a known phone doesn't pair again: {answer}");
    let pc_nonce = link::unbase64(answer["nonce"].as_str().unwrap()).unwrap();
    let (up, down) = link::session_keys(key, &phone_nonce, &pc_nonce);
    let w = Arc::new(Mutex::new((stream, Cipher::new(&up))));
    let phone = Phone { seen: serve(reader, Cipher::new(&down), w.clone()), w };
    phone.send(hello_frame());
    phone
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

#[test]
fn a_phone_pairs_reconnects_and_talks() {
    let root = std::env::temp_dir().join(format!("zlnk-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let downloads = root.join("Downloads");
    let events = Arc::new(Mutex::new(Vec::new()));
    let desktop = Arc::new(Mutex::new(Vec::new()));
    let host = TestHost { events: events.clone(), desktop: desktop.clone(), dir: downloads.clone() };
    let timing = Timing { ping: Duration::from_millis(300), dead: Duration::from_secs(10), request: Duration::from_secs(5), listing: Duration::from_secs(5), stall: Duration::from_secs(5) };
    let hub = Hub::new(Box::new(host), Connection::open_in_memory().unwrap(), timing).unwrap();
    let port = hub.start("127.0.0.1", 0).unwrap();
    assert_eq!(hub.state().port, Some(port));

    let key = pair_new_phone(&hub, port, &events);

    // A stranger claiming the same phone id, without the key, gets nothing.
    {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let phone_nonce = hello_line(&mut stream, false, Some(&[5u8; 32][..]));
        let answer = read_json_line(&mut reader);
        let pc_nonce = link::unbase64(answer["nonce"].as_str().unwrap()).unwrap();
        let (up, _) = link::session_keys(&[9; 32], &phone_nonce, &pc_nonce);
        link::write_frame(&mut stream, &mut Cipher::new(&up), &hello_frame()).unwrap();
        let mut buf = [0u8; 1];
        assert_eq!(std::io::Read::read(&mut stream, &mut buf).unwrap_or(0), 0, "the PC hangs up without a word");
        assert!(!hub.is_connected(PHONE_ID));
    }

    // Back as a known phone: hello, then status.
    let phone = connect_known(port, &key);
    wait_for("the phone to connect", || hub.is_connected(PHONE_ID).then_some(()));
    phone.send(Frame::Json(json!({"t": "status", "battery": 81, "charging": true, "signal": 3, "network": "LTE", "carrier": "Grameenphone", "wifi": "Home"})));
    let p = wait_for("the status", || hub.state().phones.into_iter().find(|p| p.battery == Some(81)));
    assert!(p.connected && p.charging);
    assert_eq!((p.signal, p.carrier.as_deref(), p.caps.len()), (Some(3), Some("Grameenphone"), 3));
    // The refresh after hello filled the cache.
    wait_for("the contacts", || (!contacts_cached(&hub).is_empty()).then_some(()));

    // A request and its answer.
    let threads = hub.threads(PHONE_ID).unwrap();
    assert_eq!(threads.len(), 2);
    assert_eq!(threads[0]["threadId"], 7);
    assert_eq!(hub.state().phones[0].unread_sms, 1);
    hub.sms_read(PHONE_ID, json!(7)).unwrap();
    assert_eq!(phone.next_msg("sms.read")["threadId"], 7);
    assert_eq!(hub.state().phones[0].unread_sms, 0);

    // The phone's own call state reaches the page, named from the contacts.
    phone.send(Frame::Json(json!({"t": "call.state", "state": "ringing", "number": "+8801711000000", "name": null, "at": 5})));
    let call = wait_for("phone-call-state", || lock(&events).iter().find(|(e, _)| e == "phone-call-state").map(|(_, v)| v.clone()));
    assert_eq!((call["phoneId"].as_str(), call["state"].as_str(), call["name"].as_str()), (Some(PHONE_ID), Some("ringing"), Some("Ada Lovelace")));
    assert_eq!(hub.calling_phone(), None, "this phone didn't share calls");

    // The name phones see can be changed.
    hub.set_pc_name("Desk").unwrap();
    assert_eq!(hub.state().pc_name, "Desk");
    hub.set_pc_name("").unwrap();
    assert_eq!(hub.state().pc_name, "Test PC");

    // A text arrives: cached, shown, named from the contacts.
    phone.send(Frame::Json(json!({"t": "sms.new", "msg": {"id": -12, "threadId": 7, "address": "+8801711000000", "body": "(picture)", "at": 1_700_000_050_000i64, "out": false, "status": "received", "mms": true}})));
    phone.send(Frame::Json(json!({"t": "sms.new", "msg": {"id": 50, "threadId": 7, "address": "+880 1711 000000", "body": "Running late", "at": 1_700_000_100_000i64, "out": false, "status": "received", "mms": false}})));
    wait_for("phone-sms", || lock(&events).iter().find(|(e, v)| e == "phone-sms" && v["msg"]["id"] == 50).map(|_| ()));
    wait_for("the desktop notification", || lock(&desktop).iter().find(|d| d.as_str() == "Ada Lovelace: Running late").map(|_| ()));
    assert_eq!(hub.with_db(|c| store::threads(c, PHONE_ID)).unwrap()[0]["snippet"], "Running late");
    let ids: Vec<i64> = hub.with_db(|c| store::msgs(c, PHONE_ID, "7", None, 50)).unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, [-12, 50], "MMS ids are negative and kept apart from SMS ids");
    assert_eq!(hub.contact_name(None, "01711000000").as_deref(), Some("Ada Lovelace"));

    // A file to the phone (more than one chunk), checked by its hash.
    let local = root.join("Holiday.bin");
    std::fs::create_dir_all(&root).unwrap();
    let sent = pattern(600_000, 1);
    std::fs::write(&local, &sent).unwrap();
    let ids = hub.upload(PHONE_ID, vec![local.clone()], None).unwrap();
    let (path, bytes, ok) = phone.next_put();
    assert!(ok, "the hash the PC sent matches the bytes");
    assert_eq!(bytes, sent);
    assert_eq!(path, "/storage/emulated/0/Download/Zazabor/Holiday.bin");
    let t = wait_for("the upload to finish", || hub.transfers.get(ids[0]).filter(|t| t.finished()));
    assert_eq!((t.state, t.done, t.dir, t.path.as_deref()), ("done", 600_000, "out", Some(path.as_str())));

    // Files from the phone: checked, and the second one with the same name becomes " (2)".
    let ids = hub.download(PHONE_ID, vec!["/storage/emulated/0/DCIM/clip.bin".into(), "/storage/emulated/0/DCIM/clip.bin".into()], None, None).unwrap();
    assert!(ids.iter().all(|id| id % 2 == 0), "the PC's transfer ids are even");
    for id in &ids {
        let t = wait_for("a download", || hub.transfers.get(*id).filter(|t| t.finished()));
        assert_eq!(t.state, "done", "{t:?}");
        assert_eq!(t.size, 700_000);
    }
    assert_eq!(files_in(&downloads), ["clip (2).bin", "clip.bin"]);
    assert_eq!(std::fs::read(downloads.join("clip (2).bin")).unwrap(), pattern(700_000, 3));
    let last = lock(&events).iter().rev().find(|(e, v)| e == "phone-transfer" && v["id"] == ids[1]).map(|(_, v)| v.clone()).unwrap();
    assert_eq!(last["state"], "done", "the end is always told");

    // Photos come as content URIs: named by the phone's answer, or by the page.
    let uri = "content://media/external/images/media/42".to_string();
    let ids = hub.download(PHONE_ID, vec![uri.clone(), uri], Some(vec![String::new(), "Beach.jpg".into()]), Some(root.join("Photos"))).unwrap();
    for id in &ids {
        assert_eq!(wait_for("a photo", || hub.transfers.get(*id).filter(|t| t.finished())).state, "done");
    }
    assert_eq!(files_in(&root.join("Photos")), ["Beach.jpg", "IMG_0042.jpg"]);

    // The phone shares a file: accepted, and a damaged one is thrown away.
    phone.send(Frame::Json(json!({"t": "file.offer", "xfer": 1, "name": "../note.txt", "size": 5, "mime": "text/plain"})));
    assert_eq!(phone.next_msg("file.accept")["xfer"], 1);
    phone.send(Frame::Data(1, b"hello".to_vec()));
    phone.send(Frame::Json(json!({"t": "file.end", "xfer": 1, "sha256": sha(b"hello")})));
    wait_for("the shared file", || downloads.join("note.txt").exists().then_some(()));
    assert_eq!(std::fs::read(downloads.join("note.txt")).unwrap(), b"hello");
    phone.send(Frame::Json(json!({"t": "file.offer", "xfer": 3, "name": "bad.txt", "size": 5, "mime": "text/plain"})));
    phone.next_msg("file.accept");
    phone.send(Frame::Data(3, b"hellO".to_vec()));
    phone.send(Frame::Json(json!({"t": "file.end", "xfer": 3, "sha256": sha(b"hello")})));
    let bad = wait_for("the damaged file", || hub.transfers.list().into_iter().find(|t| t.name == "bad.txt" && t.finished()));
    assert_eq!(bad.state, "failed");
    assert_eq!(files_in(&downloads), ["clip (2).bin", "clip.bin", "note.txt"], "no part files left behind");

    // Mirroring is asked for with the receiver's port.
    hub.mirror(PHONE_ID, Some(47299)).unwrap();
    assert_eq!(phone.next_msg("mirror.start")["port"], 47299);

    // Quiet for a while: the PC pings.
    phone.next_msg("ping");

    // Forgetting the phone hangs up and drops its cache.
    hub.forget(PHONE_ID).unwrap();
    wait_for("the phone to go", || (!hub.is_connected(PHONE_ID)).then_some(()));
    assert!(hub.state().phones.is_empty());
    hub.stop();
    assert_eq!(hub.state().port, None);
    let _ = std::fs::remove_dir_all(&root);
}

fn contacts_cached(hub: &Hub) -> Vec<Value> {
    hub.with_db(|c| store::contacts(c, PHONE_ID)).unwrap()
}

#[test]
fn a_declined_pairing_stores_nothing() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let host = TestHost { events: events.clone(), desktop: Arc::default(), dir: std::env::temp_dir() };
    let hub = Hub::new(Box::new(host), Connection::open_in_memory().unwrap(), Timing::default()).unwrap();
    let port = hub.start("127.0.0.1", 0).unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mine = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).unwrap();
    let my_pub = mine.compute_public_key().unwrap();
    let phone_nonce = hello_line(&mut stream, true, Some(Sha256::digest(my_pub.as_ref()).as_slice()));
    let answer = read_json_line(&mut reader);
    let pc_nonce = link::unbase64(answer["nonce"].as_str().unwrap()).unwrap();
    let pc_pub = link::unbase64(answer["pub"].as_str().unwrap()).unwrap();
    stream.write_all(format!("{}\n", json!({"pub": link::base64(my_pub.as_ref())})).as_bytes()).unwrap();
    let key = agree_ephemeral(mine, &UnparsedPublicKey::new(&ECDH_P256, &pc_pub), |z| link::link_key(z, &phone_nonce, &pc_nonce)).unwrap();
    wait_for("phone-pair", || lock(&events).iter().find(|(e, _)| e == "phone-pair").map(|_| ()));
    hub.pair_answer(PHONE_ID, false).unwrap();
    let (_, down) = link::session_keys(&key, &phone_nonce, &pc_nonce);
    assert_eq!(link::read_frame(&mut reader, &mut Cipher::new(&down)).unwrap(), Frame::Json(json!({"t": "pair.no"})));
    wait_for("the pairing to end", || hub.state().pairing.is_none().then_some(()));
    assert!(hub.with_db(|c| store::link_key(c, PHONE_ID)).unwrap().is_none());
    hub.stop();
}

/// A key that isn't the one the hello committed to (or no commitment at all) is refused before
/// any code is worked out or shown.
#[test]
fn a_pairing_key_must_match_its_commitment() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let host = TestHost { events: events.clone(), desktop: Arc::default(), dir: std::env::temp_dir() };
    let hub = Hub::new(Box::new(host), Connection::open_in_memory().unwrap(), Timing::default()).unwrap();
    let port = hub.start("127.0.0.1", 0).unwrap();
    let promised = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).unwrap().compute_public_key().unwrap();
    let commitments: [Option<Vec<u8>>; 2] = [Some(Sha256::digest(promised.as_ref()).to_vec()), None];
    for commit in commitments {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        hello_line(&mut stream, true, commit.as_deref());
        let answer = read_json_line(&mut reader);
        assert_eq!(answer["pair"], true);
        // Another key than the one promised.
        let other = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).unwrap().compute_public_key().unwrap();
        stream.write_all(format!("{}\n", json!({"pub": link::base64(other.as_ref())})).as_bytes()).unwrap();
        let refusal = read_json_line(&mut reader);
        assert_eq!(refusal["ok"], false, "{refusal}");
        assert!(refusal["reason"].as_str().is_some_and(|r| !r.is_empty()));
        let mut buf = [0u8; 1];
        assert_eq!(std::io::Read::read(&mut stream, &mut buf).unwrap_or(0), 0, "then the PC hangs up");
        wait_for("the pairing to end", || hub.state().pairing.is_none().then_some(()));
    }
    assert!(!lock(&events).iter().any(|(e, _)| e == "phone-pair"), "no code was shown");
    assert!(hub.with_db(|c| store::link_key(c, PHONE_ID)).unwrap().is_none());
    hub.stop();
}

/// A real Zazabor Link (a phone or the emulator) against the real PC side, without the window:
/// `ZLNK_SERVE=1 cargo test --lib real_phone_session -- --ignored --nocapture`. It listens on
/// 0.0.0.0:47213, accepts the first pairing, then asks for each kind of data and prints only
/// counts, sends a small file and fetches it back. Never sends texts or places calls.
#[test]
#[ignore]
fn real_phone_session() {
    if std::env::var_os("ZLNK_SERVE").is_none() {
        return;
    }
    let root = std::env::temp_dir().join(format!("zlnk-real-{}", std::process::id()));
    let downloads = root.join("Downloads");
    let events = Arc::new(Mutex::new(Vec::new()));
    let host = TestHost { events: events.clone(), desktop: Arc::new(Mutex::new(Vec::new())), dir: downloads.clone() };
    let hub = Hub::new(Box::new(host), Connection::open_in_memory().unwrap(), Timing::default()).unwrap();
    let port = hub.start("0.0.0.0", 47213).unwrap();
    println!("listening on {port}; pair from the phone");
    let wait = |what: &str, secs: u64, f: &mut dyn FnMut() -> Option<String>| -> String {
        let start = Instant::now();
        loop {
            if let Some(v) = f() {
                return v;
            }
            assert!(start.elapsed() < Duration::from_secs(secs), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(200));
        }
    };
    let phone_id = wait("a pairing request", 600, &mut || {
        lock(&events).iter().find(|(e, _)| e == "phone-pair").map(|(_, v)| {
            println!("pairing: {} shows code {}", v["name"], v["code"]);
            v["phoneId"].as_str().unwrap().to_string()
        })
    });
    hub.pair_answer(&phone_id, true).unwrap();
    wait("the phone to connect", 120, &mut || hub.is_connected(&phone_id).then(|| "ok".into()));
    std::thread::sleep(Duration::from_secs(2));
    let p = hub.state().phones.into_iter().find(|p| p.phone_id == phone_id).unwrap();
    println!("connected: model {:?} battery {:?} charging {} network {:?} caps {:?}", p.model, p.battery, p.charging, p.network, p.caps);
    let count = |r: Result<Vec<Value>, String>| r.map(|v| v.len().to_string()).unwrap_or_else(|e| format!("error: {e}"));
    println!("threads: {}", count(hub.threads(&phone_id)));
    println!("calls: {}", count(hub.calls(&phone_id)));
    println!("contacts: {}", count(hub.contacts(&phone_id)));
    println!("notifs: {}", count(hub.notifs(&phone_id)));
    println!("photos: {}", count(hub.photos(&phone_id, 0, 5)));
    let roots = hub.files(&phone_id, "");
    println!("file roots: {}", count(roots.clone()));
    // A small file there and back.
    let src = root.join("zlnk-test.txt");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(&src, b"Zazabor Link round trip\n").unwrap();
    let up = hub.upload(&phone_id, vec![src.clone()], None);
    println!("upload ids: {up:?}");
    let done = wait("the upload", 60, &mut || {
        lock(&events).iter().rev().find(|(e, v)| e == "phone-transfer" && v["dir"] == "out" && v["state"] != "running" && v["state"] != "queued").map(|(_, v)| v.to_string())
    });
    println!("upload: {done}");
    let remote: Value = serde_json::from_str(&done).unwrap();
    if let Some(path) = remote["path"].as_str() {
        println!("download ids: {:?}", hub.download(&phone_id, vec![path.to_string()], None, Some(downloads.clone())));
        let got = wait("the download", 60, &mut || {
            lock(&events).iter().rev().find(|(e, v)| e == "phone-transfer" && v["dir"] == "in" && v["state"] != "running" && v["state"] != "queued").map(|(_, v)| v.to_string())
        });
        println!("download: {got}");
        let _ = hub.file_delete(&phone_id, path).map_err(|e| println!("delete: {e}"));
    }
    let names: Vec<String> = lock(&events).iter().map(|(e, _)| e.clone()).collect();
    println!("events seen: {names:?}");
    let secs: u64 = std::env::var("ZLNK_LINGER").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    std::thread::sleep(Duration::from_secs(secs));
}

#[test]
fn a_forgotten_phone_is_told_and_no_pairing_starts() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let host = TestHost { events: events.clone(), desktop: Arc::new(Mutex::new(Vec::new())), dir: std::env::temp_dir() };
    let hub = Hub::new(Box::new(host), Connection::open_in_memory().unwrap(), Timing::default()).unwrap();
    let port = hub.start("127.0.0.1", 0).unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    hello_line(&mut stream, false, Some(&[5u8; 32][..]));
    let answer = read_json_line(&mut reader);
    assert_eq!((answer["ok"].as_bool(), answer["unknown"].as_bool()), (Some(false), Some(true)));
    assert_eq!(answer["pcId"].as_str(), Some(hub.pc_id.as_str()));
    std::thread::sleep(Duration::from_millis(200));
    assert!(lock(&events).iter().all(|(e, _)| e != "phone-pair"));
    assert!(hub.state().pairing.is_none());
}
