//! Text subtitles stored inside Matroska / WebM files (an .mkv's SRT, ASS or WebVTT tracks), read
//! so the Video module can draw them itself: then the Subtitles tab's timeline, delay and styles
//! work for them as they do for added files. Image subtitles (PGS, VobSub) are listed but stay
//! with libVLC.
//!
//! Only what's needed is parsed: the track list and, in each cluster, the blocks of subtitle
//! tracks. Video and audio blocks are skipped by seeking past them, and a file without text
//! subtitle tracks stops at its track list.

use super::frame::lock_ignore_poison;
use super::{blocking, ensure_unlocked};
use crate::scan::unix_seconds;
use flate2::read::ZlibDecoder;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// ---- Matroska element ids ----------------------------------------------------------------------

const EBML: u32 = 0x1A45_DFA3;
const DOC_TYPE: u32 = 0x4282;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const INFO: u32 = 0x1549_A966;
const TIMESTAMP_SCALE: u32 = 0x2A_D7B1;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_TYPE: u32 = 0x83;
const CODEC_ID: u32 = 0x86;
const LANGUAGE: u32 = 0x22_B59C;
const LANGUAGE_BCP47: u32 = 0x22_B59D;
const NAME: u32 = 0x536E;
const FLAG_DEFAULT: u32 = 0x88;
const FLAG_FORCED: u32 = 0x55AA;
const CONTENT_ENCODINGS: u32 = 0x6D80;
const CONTENT_ENCODING: u32 = 0x6240;
const CONTENT_ENCODING_SCOPE: u32 = 0x5032;
const CONTENT_ENCODING_TYPE: u32 = 0x5033;
const CONTENT_COMPRESSION: u32 = 0x5034;
const CONTENT_COMP_ALGO: u32 = 0x4254;
const CONTENT_COMP_SETTINGS: u32 = 0x4255;
const CLUSTER: u32 = 0x1F43_B675;
const CLUSTER_TIMESTAMP: u32 = 0xE7;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const BLOCK_DURATION: u32 = 0x9B;
const CUES: u32 = 0x1C53_BB6B;
const ATTACHMENTS: u32 = 0x1941_A469;
const CHAPTERS: u32 = 0x1043_A770;
const TAGS: u32 = 0x1254_C367;

const TRACK_TYPE_SUBTITLE: u64 = 0x11;
/// A cue with no duration in the file lasts until the next one, but no longer than this.
const MAX_OPEN_CUE_MS: i64 = 5000;
/// …and this long when it is the last one.
const LAST_CUE_MS: i64 = 3000;
/// Element payloads read into memory are capped (a subtitle block is a few hundred bytes).
const MAX_PAYLOAD: u64 = 16 * 1024 * 1024;
const CACHED_FILES: usize = 4;

// ---- results -----------------------------------------------------------------------------------

/// One subtitle cue: times in ms, the text with its markup (SRT tags or ASS override blocks).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EmbeddedCue {
    pub start: i64,
    pub end: i64,
    pub text: String,
}

/// A subtitle track of the file, in file order; `text` tracks carry their cues.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedTrack {
    /// Position among the file's subtitle tracks (libVLC lists them in the same order).
    pub index: usize,
    pub track_number: u64,
    pub codec: String,
    pub language: String,
    pub name: String,
    pub default: bool,
    pub forced: bool,
    /// A text track we can show (not an image format, not encrypted or oddly compressed).
    pub text: bool,
    pub cues: Vec<EmbeddedCue>,
}

// ---- reading -----------------------------------------------------------------------------------

/// A position-tracking EBML reader over a buffered, seekable source.
struct Reader<R> {
    inner: BufReader<R>,
    pos: u64,
    len: u64,
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

impl<R: Read + Seek> Reader<R> {
    fn new(inner: R, len: u64) -> Self {
        Reader { inner: BufReader::with_capacity(1 << 20, inner), pos: 0, len }
    }

    fn byte(&mut self) -> io::Result<u8> {
        let mut b = [0u8; 1];
        self.inner.read_exact(&mut b)?;
        self.pos += 1;
        Ok(b[0])
    }

    fn fill(&mut self, buf: &mut [u8]) -> io::Result<()> {
        self.inner.read_exact(buf)?;
        self.pos += buf.len() as u64;
        Ok(())
    }

    fn skip(&mut self, n: u64) -> io::Result<()> {
        if self.pos + n > self.len {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        // Within the buffer this costs nothing; past it, one seek.
        self.inner.seek_relative(n as i64)?;
        self.pos += n;
        Ok(())
    }

    /// An EBML variable-length integer: (value without the length marker, all value bits set, length).
    fn vint(&mut self) -> io::Result<(u64, bool, u64)> {
        let first = self.byte()?;
        if first == 0 {
            return Err(invalid("bad EBML number"));
        }
        let len = first.leading_zeros() as u64 + 1;
        // An 8-byte number keeps no value bits in its first byte.
        let mut value = (first & 0xFFu8.checked_shr(len as u32).unwrap_or(0)) as u64;
        for _ in 1..len {
            value = (value << 8) | self.byte()? as u64;
        }
        let all_ones = value == (1u64 << (7 * len)) - 1;
        Ok((value, all_ones, len))
    }

    /// An element id (its bytes as written, length marker included) and size (None = unknown).
    fn header(&mut self) -> io::Result<(u32, Option<u64>)> {
        let first = self.byte()?;
        let len = first.leading_zeros() + 1;
        if first == 0 || len > 4 {
            return Err(invalid("bad element id"));
        }
        let mut id = first as u32;
        for _ in 1..len {
            id = (id << 8) | self.byte()? as u32;
        }
        let (size, unknown, _) = self.vint()?;
        Ok((id, if unknown { None } else { Some(size) }))
    }

    fn uint(&mut self, size: u64) -> io::Result<u64> {
        if size > 8 {
            self.skip(size)?;
            return Err(invalid("integer too long"));
        }
        let mut value = 0u64;
        for _ in 0..size {
            value = (value << 8) | self.byte()? as u64;
        }
        Ok(value)
    }

    fn bytes(&mut self, size: u64) -> io::Result<Vec<u8>> {
        if size > MAX_PAYLOAD {
            return Err(invalid("element too large"));
        }
        let mut buf = vec![0u8; size as usize];
        self.fill(&mut buf)?;
        Ok(buf)
    }

    fn string(&mut self, size: u64) -> io::Result<String> {
        let bytes = self.bytes(size)?;
        Ok(String::from_utf8_lossy(&bytes).trim_end_matches('\0').to_string())
    }
}

fn known(size: Option<u64>) -> io::Result<u64> {
    size.ok_or_else(|| invalid("unexpected unknown size"))
}

/// Elements that sit directly in the Segment: one of these ends an unknown-size cluster.
fn is_segment_child(id: u32) -> bool {
    matches!(id, SEEK_HEAD | INFO | TRACKS | CLUSTER | CUES | ATTACHMENTS | CHAPTERS | TAGS)
}

// ---- tracks ------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Encoding {
    Zlib,
    /// Header stripping: these bytes were removed from the start of every frame.
    Strip(Vec<u8>),
}

#[derive(Debug)]
struct Track {
    number: u64,
    codec: String,
    language: String,
    name: String,
    default: bool,
    forced: bool,
    text: bool,
    encodings: Vec<Encoding>,
    cues: Vec<(i64, Option<i64>, String)>,
}

fn is_text_codec(codec: &str) -> bool {
    matches!(codec, "S_TEXT/UTF8" | "S_TEXT/ASCII" | "S_TEXT/ASS" | "S_TEXT/SSA" | "S_ASS" | "S_SSA" | "S_TEXT/WEBVTT")
}

/// Content encodings of a track: the compressions to undo, and whether we can read it at all.
fn parse_encodings<R: Read + Seek>(r: &mut Reader<R>, size: u64) -> io::Result<(Vec<Encoding>, bool)> {
    let end = r.pos + size;
    let mut encodings = Vec::new();
    let mut readable = true;
    while r.pos < end {
        let (id, size) = r.header()?;
        let size = known(size)?;
        if id != CONTENT_ENCODING {
            r.skip(size)?;
            continue;
        }
        let entry_end = r.pos + size;
        let (mut scope, mut kind, mut algo, mut settings) = (1u64, 0u64, 0u64, Vec::new());
        while r.pos < entry_end {
            let (id, size) = r.header()?;
            let size = known(size)?;
            match id {
                CONTENT_ENCODING_SCOPE => scope = r.uint(size)?,
                CONTENT_ENCODING_TYPE => kind = r.uint(size)?,
                CONTENT_COMPRESSION => {
                    let comp_end = r.pos + size;
                    while r.pos < comp_end {
                        let (id, size) = r.header()?;
                        let size = known(size)?;
                        match id {
                            CONTENT_COMP_ALGO => algo = r.uint(size)?,
                            CONTENT_COMP_SETTINGS => settings = r.bytes(size)?,
                            _ => r.skip(size)?,
                        }
                    }
                }
                _ => r.skip(size)?,
            }
        }
        if scope & 1 == 0 {
            continue; // applies to private data only, not frames
        }
        match (kind, algo) {
            (0, 0) => encodings.push(Encoding::Zlib),
            (0, 3) => encodings.push(Encoding::Strip(settings)),
            _ => readable = false, // encryption, bzlib, lzo
        }
    }
    Ok((encodings, readable))
}

/// One TrackEntry; `None` for anything that isn't a subtitle track.
fn parse_track_entry<R: Read + Seek>(r: &mut Reader<R>, size: u64) -> io::Result<Option<Track>> {
    let end = r.pos + size;
    let mut track = Track {
        number: 0,
        codec: String::new(),
        language: "eng".into(),
        name: String::new(),
        default: true,
        forced: false,
        text: false,
        encodings: Vec::new(),
        cues: Vec::new(),
    };
    let (mut kind, mut bcp47, mut readable) = (0u64, String::new(), true);
    while r.pos < end {
        let (id, size) = r.header()?;
        let size = known(size)?;
        match id {
            TRACK_NUMBER => track.number = r.uint(size)?,
            TRACK_TYPE => kind = r.uint(size)?,
            CODEC_ID => track.codec = r.string(size)?,
            LANGUAGE => track.language = r.string(size)?,
            LANGUAGE_BCP47 => bcp47 = r.string(size)?,
            NAME => track.name = r.string(size)?,
            FLAG_DEFAULT => track.default = r.uint(size)? != 0,
            FLAG_FORCED => track.forced = r.uint(size)? != 0,
            CONTENT_ENCODINGS => (track.encodings, readable) = parse_encodings(r, size)?,
            _ => r.skip(size)?,
        }
    }
    if kind != TRACK_TYPE_SUBTITLE || track.number == 0 {
        return Ok(None);
    }
    if !bcp47.is_empty() {
        track.language = bcp47;
    }
    // Encodings are undone last-applied first.
    track.encodings.reverse();
    track.text = readable && is_text_codec(&track.codec);
    Ok(Some(track))
}

// ---- blocks ------------------------------------------------------------------------------------

struct Scan {
    /// Matroska timestamp units, in ns.
    scale: i64,
    tracks: Vec<Track>,
    by_number: HashMap<u64, usize>,
}

impl Scan {
    fn ms(&self, ticks: i64) -> i64 {
        (ticks as i128 * self.scale as i128 / 1_000_000) as i64
    }

    fn any_text(&self) -> bool {
        self.tracks.iter().any(|t| t.text)
    }

    /// Reads a (Simple)Block of `size` bytes: the payload of a text subtitle track, else skips it.
    fn block<R: Read + Seek>(&self, r: &mut Reader<R>, size: u64) -> io::Result<Option<(usize, i64, Vec<u8>)>> {
        let (number, _, len) = r.vint()?;
        let rest = size.checked_sub(len).ok_or_else(|| invalid("short block"))?;
        let Some(&index) = self.by_number.get(&number).filter(|&&i| self.tracks[i].text) else {
            r.skip(rest)?;
            return Ok(None);
        };
        if rest < 3 {
            r.skip(rest)?;
            return Ok(None);
        }
        let mut head = [0u8; 3];
        r.fill(&mut head)?;
        let relative = i16::from_be_bytes([head[0], head[1]]) as i64;
        let payload = rest - 3;
        if head[2] & 0x06 != 0 {
            // Laced: several frames in one block. Never used for subtitles in practice.
            r.skip(payload)?;
            return Ok(None);
        }
        Ok(Some((index, relative, r.bytes(payload)?)))
    }

    fn add(&mut self, index: usize, cluster: i64, relative: i64, duration: Option<i64>, data: Vec<u8>) {
        let track = &self.tracks[index];
        let Some(raw) = decode(&track.encodings, data) else { return };
        let text = cue_markup(&track.codec, &raw);
        if text.trim().is_empty() {
            return;
        }
        let ticks = (cluster + relative).max(0);
        let start = self.ms(ticks);
        let end = duration.map(|d| self.ms(ticks + d));
        self.tracks[index].cues.push((start, end, text));
    }

    /// One cluster; returns the header of a segment-level element that ended an unknown-size cluster.
    fn cluster<R: Read + Seek>(&mut self, r: &mut Reader<R>, size: Option<u64>, segment_end: u64) -> io::Result<Option<(u32, Option<u64>)>> {
        let end = size.map(|s| r.pos + s).unwrap_or(segment_end);
        let mut timestamp = 0i64;
        while r.pos < end {
            let (id, child) = r.header()?;
            if size.is_none() && is_segment_child(id) {
                return Ok(Some((id, child)));
            }
            let child = known(child)?;
            match id {
                CLUSTER_TIMESTAMP => timestamp = r.uint(child)? as i64,
                SIMPLE_BLOCK => {
                    if let Some((index, relative, data)) = self.block(r, child)? {
                        self.add(index, timestamp, relative, None, data);
                    }
                }
                BLOCK_GROUP => {
                    let group_end = r.pos + child;
                    let (mut block, mut duration) = (None, None);
                    while r.pos < group_end {
                        let (id, size) = r.header()?;
                        let size = known(size)?;
                        match id {
                            BLOCK => block = self.block(r, size)?,
                            BLOCK_DURATION => duration = Some(r.uint(size)? as i64),
                            _ => r.skip(size)?,
                        }
                    }
                    if let Some((index, relative, data)) = block {
                        self.add(index, timestamp, relative, duration, data);
                    }
                }
                _ => r.skip(child)?,
            }
        }
        Ok(None)
    }

    fn finish(self) -> Vec<EmbeddedTrack> {
        self.tracks
            .into_iter()
            .enumerate()
            .map(|(index, mut t)| {
                t.cues.sort_by_key(|c| c.0);
                let starts: Vec<i64> = t.cues.iter().map(|c| c.0).collect();
                let cues = t
                    .cues
                    .into_iter()
                    .enumerate()
                    .map(|(i, (start, end, text))| {
                        let end = end.unwrap_or_else(|| match starts[i + 1..].iter().find(|&&s| s > start) {
                            Some(&next) => next.min(start + MAX_OPEN_CUE_MS),
                            None => start + LAST_CUE_MS,
                        });
                        EmbeddedCue { start, end: end.max(start), text }
                    })
                    .collect();
                EmbeddedTrack {
                    index,
                    track_number: t.number,
                    codec: t.codec,
                    language: t.language,
                    name: t.name,
                    default: t.default,
                    forced: t.forced,
                    text: t.text,
                    cues,
                }
            })
            .collect()
    }
}

/// Undoes a track's content encodings; `None` when the data doesn't decompress.
fn decode(encodings: &[Encoding], mut data: Vec<u8>) -> Option<String> {
    for encoding in encodings {
        data = match encoding {
            Encoding::Zlib => {
                let mut out = Vec::new();
                ZlibDecoder::new(data.as_slice()).read_to_end(&mut out).ok()?;
                out
            }
            Encoding::Strip(prefix) => {
                let mut out = prefix.clone();
                out.extend_from_slice(&data);
                out
            }
        };
    }
    Some(String::from_utf8_lossy(&data).into_owned())
}

/// The cue's markup from a block: SSA/ASS blocks are `ReadOrder,Layer,Style,Name,MarginL,MarginR,
/// MarginV,Effect,Text` (the text keeps its override tags for the renderer); others are the text.
fn cue_markup(codec: &str, raw: &str) -> String {
    let raw = raw.trim_end_matches('\0').replace("\r\n", "\n");
    let text = if matches!(codec, "S_TEXT/ASS" | "S_TEXT/SSA" | "S_ASS" | "S_SSA") {
        raw.splitn(9, ',').nth(8).unwrap_or("").to_string()
    } else {
        raw
    };
    text.trim_end().to_string()
}

/// Reads the subtitle tracks of a Matroska/WebM stream; anything else gives an empty list.
fn scan<R: Read + Seek>(source: R, len: u64) -> io::Result<Vec<EmbeddedTrack>> {
    let mut r = Reader::new(source, len);
    let Ok((id, size)) = r.header() else { return Ok(Vec::new()) };
    if id != EBML {
        return Ok(Vec::new());
    }
    let header_end = r.pos + known(size)?;
    let mut doc_type = String::new();
    while r.pos < header_end {
        let (id, size) = r.header()?;
        let size = known(size)?;
        if id == DOC_TYPE {
            doc_type = r.string(size)?;
        } else {
            r.skip(size)?;
        }
    }
    if doc_type != "matroska" && doc_type != "webm" {
        return Ok(Vec::new());
    }
    let (id, size) = r.header()?;
    if id != SEGMENT {
        return Ok(Vec::new());
    }
    let segment_end = size.map(|s| r.pos + s).unwrap_or(len).min(len);

    let mut scan = Scan { scale: 1_000_000, tracks: Vec::new(), by_number: HashMap::new() };
    let mut seen_tracks = false;
    let mut pending = None;
    let outcome: io::Result<()> = (|| {
        while r.pos < segment_end {
            let (id, size) = match pending.take() {
                Some(header) => header,
                None => r.header()?,
            };
            match id {
                INFO => {
                    let end = r.pos + known(size)?;
                    while r.pos < end {
                        let (id, size) = r.header()?;
                        let size = known(size)?;
                        if id == TIMESTAMP_SCALE {
                            scan.scale = (r.uint(size)? as i64).max(1);
                        } else {
                            r.skip(size)?;
                        }
                    }
                }
                TRACKS => {
                    seen_tracks = true;
                    let end = r.pos + known(size)?;
                    while r.pos < end {
                        let (id, size) = r.header()?;
                        let size = known(size)?;
                        if id != TRACK_ENTRY {
                            r.skip(size)?;
                        } else if let Some(track) = parse_track_entry(&mut r, size)? {
                            scan.by_number.insert(track.number, scan.tracks.len());
                            scan.tracks.push(track);
                        }
                    }
                    // No text subtitles: nothing in the clusters is of interest.
                    if !scan.any_text() {
                        return Ok(());
                    }
                }
                CLUSTER => {
                    if seen_tracks && !scan.any_text() {
                        return Ok(());
                    }
                    pending = scan.cluster(&mut r, size, segment_end)?;
                }
                _ => match size {
                    Some(size) => r.skip(size)?,
                    None => return Ok(()),
                },
            }
        }
        Ok(())
    })();
    // A truncated or partly damaged file still gives what was read before the problem.
    drop(outcome);
    Ok(scan.finish())
}

fn read_file(path: &Path) -> Result<Vec<EmbeddedTrack>, String> {
    let file = File::open(path).map_err(|e| format!("Couldn't open the video: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    scan(file, len).map_err(|e| format!("Couldn't read the video's subtitles: {e}"))
}

type CacheEntry = (PathBuf, u64, f64, Arc<Vec<EmbeddedTrack>>);
static CACHE: Mutex<Vec<CacheEntry>> = Mutex::new(Vec::new());

/// The subtitle tracks of a file, from memory when the same file was read recently.
fn read_cached(path: &Path) -> Result<Arc<Vec<EmbeddedTrack>>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Couldn't open the video: {e}"))?;
    let (size, mtime) = (meta.len(), unix_seconds(meta.modified()));
    {
        let cache = lock_ignore_poison(&CACHE);
        if let Some(entry) = cache.iter().find(|e| e.0 == path && e.1 == size && e.2 == mtime) {
            return Ok(entry.3.clone());
        }
    }
    let tracks = Arc::new(read_file(path)?);
    let mut cache = lock_ignore_poison(&CACHE);
    cache.retain(|e| e.0 != path);
    cache.push((path.to_path_buf(), size, mtime, tracks.clone()));
    if cache.len() > CACHED_FILES {
        cache.remove(0);
    }
    Ok(tracks)
}

/// The subtitle tracks stored in a video file (Matroska/WebM; empty for other files).
#[tauri::command]
pub async fn video_embedded_subtitles(path: String) -> Result<Vec<EmbeddedTrack>, String> {
    ensure_unlocked()?;
    blocking(move || read_cached(Path::new(&path)).map(|tracks| (*tracks).clone())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// An element with a known size, written with an 8-byte size field.
    fn el(id: u32, body: &[u8]) -> Vec<u8> {
        let mut out: Vec<u8> = id.to_be_bytes().iter().copied().skip_while(|&b| b == 0).collect();
        out.push(0x01);
        out.extend_from_slice(&(body.len() as u64).to_be_bytes()[1..]);
        out.extend_from_slice(body);
        out
    }

    fn unknown(id: u32, body: &[u8]) -> Vec<u8> {
        let mut out: Vec<u8> = id.to_be_bytes().iter().copied().skip_while(|&b| b == 0).collect();
        out.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        out.extend_from_slice(body);
        out
    }

    fn uint(id: u32, value: u64) -> Vec<u8> {
        el(id, &value.to_be_bytes())
    }

    fn text(id: u32, value: &str) -> Vec<u8> {
        el(id, value.as_bytes())
    }

    fn block_body(track: u8, relative: i16, data: &[u8]) -> Vec<u8> {
        let mut out = vec![0x80 | track];
        out.extend_from_slice(&relative.to_be_bytes());
        out.push(0x80);
        out.extend_from_slice(data);
        out
    }

    fn simple(track: u8, relative: i16, data: &[u8]) -> Vec<u8> {
        el(SIMPLE_BLOCK, &block_body(track, relative, data))
    }

    fn group(track: u8, relative: i16, duration: u64, data: &[u8]) -> Vec<u8> {
        el(BLOCK_GROUP, &[el(BLOCK, &block_body(track, relative, data)), uint(BLOCK_DURATION, duration)].concat())
    }

    fn cluster(timestamp: u64, blocks: &[Vec<u8>]) -> Vec<u8> {
        el(CLUSTER, &[uint(CLUSTER_TIMESTAMP, timestamp), blocks.concat()].concat())
    }

    fn track(number: u64, kind: u64, codec: &str, extra: &[Vec<u8>]) -> Vec<u8> {
        el(TRACK_ENTRY, &[uint(TRACK_NUMBER, number), uint(TRACK_TYPE, kind), text(CODEC_ID, codec), extra.concat()].concat())
    }

    fn file(doc: &str, tracks: &[Vec<u8>], clusters: &[Vec<u8>], unknown_segment: bool) -> Vec<u8> {
        let header = el(EBML, &text(DOC_TYPE, doc));
        let body = [el(INFO, &uint(TIMESTAMP_SCALE, 1_000_000)), el(TRACKS, &tracks.concat()), clusters.concat()].concat();
        let segment = if unknown_segment { unknown(SEGMENT, &body) } else { el(SEGMENT, &body) };
        [header, segment].concat()
    }

    fn read(bytes: Vec<u8>) -> Vec<EmbeddedTrack> {
        let len = bytes.len() as u64;
        scan(Cursor::new(bytes), len).unwrap()
    }

    fn cue(start: i64, end: i64, text: &str) -> EmbeddedCue {
        EmbeddedCue { start, end, text: text.into() }
    }

    #[test]
    fn srt_cues_from_simple_and_grouped_blocks_skipping_video() {
        let video = track(1, 1, "V_MPEG4/ISO/AVC", &[]);
        let subs = track(2, 0x11, "S_TEXT/UTF8", &[text(LANGUAGE, "eng"), text(NAME, "SDH"), uint(FLAG_DEFAULT, 1)]);
        let bytes = file(
            "matroska",
            &[video, subs],
            &[
                cluster(1000, &[simple(1, 0, &[0u8; 5000]), group(2, 500, 2000, b"<i>Hello</i>"), simple(1, 40, &[1u8; 3000])]),
                cluster(10_000, &[simple(2, 0, b"Second"), simple(2, 1000, b"Third")]),
            ],
            false,
        );
        let tracks = read(bytes);
        assert_eq!(tracks.len(), 1);
        let t = &tracks[0];
        assert_eq!((t.index, t.track_number, t.codec.as_str(), t.language.as_str(), t.name.as_str()), (0, 2, "S_TEXT/UTF8", "eng", "SDH"));
        assert!(t.text && t.default && !t.forced);
        // The last two have no duration: until the next cue, then a few seconds.
        assert_eq!(t.cues, vec![cue(1500, 3500, "<i>Hello</i>"), cue(10_000, 11_000, "Second"), cue(11_000, 14_000, "Third")]);
    }

    #[test]
    fn unknown_size_segment_and_clusters() {
        let subs = track(3, 0x11, "S_TEXT/UTF8", &[]);
        let header = el(EBML, &text(DOC_TYPE, "webm"));
        let body = [
            el(TRACKS, &subs),
            unknown(CLUSTER, &[uint(CLUSTER_TIMESTAMP, 0), group(3, 100, 900, b"one")].concat()),
            unknown(CLUSTER, &[uint(CLUSTER_TIMESTAMP, 5000), group(3, 0, 1000, b"two")].concat()),
            el(CUES, &[0u8; 10]),
        ]
        .concat();
        let tracks = read([header, unknown(SEGMENT, &body)].concat());
        assert_eq!(tracks[0].cues, vec![cue(100, 1000, "one"), cue(5000, 6000, "two")]);
        assert_eq!(tracks[0].language, "eng");
    }

    #[test]
    fn zlib_and_header_stripping_are_undone() {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(b"compressed line").unwrap();
        let packed = z.finish().unwrap();
        let zlib = el(CONTENT_ENCODINGS, &el(CONTENT_ENCODING, &el(CONTENT_COMPRESSION, &uint(CONTENT_COMP_ALGO, 0))));
        let strip = el(
            CONTENT_ENCODINGS,
            &el(CONTENT_ENCODING, &el(CONTENT_COMPRESSION, &[uint(CONTENT_COMP_ALGO, 3), el(CONTENT_COMP_SETTINGS, b"Hello ")].concat())),
        );
        let bytes = file(
            "matroska",
            &[track(1, 0x11, "S_TEXT/UTF8", &[zlib]), track(2, 0x11, "S_TEXT/UTF8", &[text(LANGUAGE_BCP47, "fr-CA"), strip])],
            &[cluster(0, &[group(1, 0, 1000, &packed), group(2, 0, 1000, b"world")])],
            true,
        );
        let tracks = read(bytes);
        assert_eq!(tracks[0].cues[0].text, "compressed line");
        assert_eq!(tracks[1].cues[0].text, "Hello world");
        assert_eq!(tracks[1].language, "fr-CA");
    }

    #[test]
    fn ass_blocks_keep_only_the_text_with_its_tags() {
        let bytes = file(
            "matroska",
            &[track(1, 0x11, "S_TEXT/ASS", &[])],
            &[cluster(0, &[group(1, 0, 1000, b"7,0,Default,,0,0,0,,{\\an8}Top, with a comma\\Nsecond")])],
            false,
        );
        assert_eq!(read(bytes)[0].cues, vec![cue(0, 1000, "{\\an8}Top, with a comma\\Nsecond")]);
    }

    #[test]
    fn image_and_encrypted_tracks_are_listed_without_cues() {
        let encrypted = el(CONTENT_ENCODINGS, &el(CONTENT_ENCODING, &uint(CONTENT_ENCODING_TYPE, 1)));
        let bytes = file(
            "matroska",
            &[track(1, 0x11, "S_HDMV/PGS", &[uint(FLAG_FORCED, 1)]), track(2, 0x11, "S_TEXT/UTF8", &[encrypted])],
            &[cluster(0, &[group(1, 0, 1000, &[9u8; 50]), group(2, 0, 1000, b"secret")])],
            false,
        );
        let tracks = read(bytes);
        assert_eq!(tracks.len(), 2);
        assert!(!tracks[0].text && tracks[0].forced && tracks[0].cues.is_empty());
        assert!(!tracks[1].text && tracks[1].cues.is_empty());
    }

    #[test]
    fn other_files_and_truncated_files() {
        assert!(read(b"RIFF....WAVEfmt ".to_vec()).is_empty());
        assert!(read(Vec::new()).is_empty());
        assert!(read(file("other", &[track(1, 0x11, "S_TEXT/UTF8", &[])], &[], false)).is_empty());
        // No subtitle tracks: the clusters are never read.
        assert!(read(file("matroska", &[track(1, 1, "V_VP9", &[])], &[cluster(0, &[simple(1, 0, b"x")])], false)).is_empty());
        // Cut off in the middle of the second cluster: the first one's cues survive.
        let mut bytes = file(
            "matroska",
            &[track(1, 0x11, "S_TEXT/UTF8", &[])],
            &[cluster(0, &[group(1, 0, 500, b"kept")]), cluster(1000, &[group(1, 0, 500, b"lost")])],
            false,
        );
        bytes.truncate(bytes.len() - 6);
        assert_eq!(read(bytes)[0].cues, vec![cue(0, 500, "kept")]);
    }

    /// `CS_MKV=/path/to/movie.mkv cargo test embedded_subs -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn reads_a_real_file() {
        let Ok(path) = std::env::var("CS_MKV") else { return };
        let started = std::time::Instant::now();
        let tracks = read_file(Path::new(&path)).unwrap();
        println!("{} subtitle track(s) in {:?}", tracks.len(), started.elapsed());
        for t in &tracks {
            println!("#{} track {} {} lang={} name={:?} default={} forced={} text={} cues={}", t.index, t.track_number, t.codec, t.language, t.name, t.default, t.forced, t.text, t.cues.len());
            for c in t.cues.iter().take(3) {
                println!("    {} → {}  {:?}", c.start, c.end, c.text);
            }
        }
        let started = std::time::Instant::now();
        read_cached(Path::new(&path)).unwrap();
        read_cached(Path::new(&path)).unwrap();
        println!("cached read: {:?}", started.elapsed());
    }
}
