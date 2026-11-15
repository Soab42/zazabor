//! The DLNA renderer: Zazabor as a UPnP AV MediaRenderer, for apps that "play to" a TV
//! (BubbleUPnP, Web Video Caster, Samsung's Gallery, Windows' "Cast to device", Kodi remotes…).
//!
//! The phone finds us with SSDP (`ssdp.rs`), reads the descriptions below, and drives three
//! services with SOAP: AVTransport (what plays and how), RenderingControl (volume) and
//! ConnectionManager (what formats we take). State changes go out as LastChange events to
//! whoever subscribed (GENA), and are also there to poll (GetPositionInfo, GetTransportInfo).

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::http::{xml_escape, Request, Response};
use super::{ssdp, Media, PlayState, Settings, Source};

const DEVICE_TYPE: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
const AVT: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const RC: &str = "urn:schemas-upnp-org:service:RenderingControl:1";
const CM: &str = "urn:schemas-upnp-org:service:ConnectionManager:1";
const EVENT_TIMEOUT: u64 = 1800;

/// What the renderer has been told to play, and its session.
#[derive(Default)]
struct Renderer {
    uri: String,
    metadata: String,
    next_uri: String,
    next_metadata: String,
    session: Option<u64>,
    /// The phone's address and app, for the page's "who's casting".
    sender: String,
    sender_key: String,
    /// Set by Stop: the session is over even if the player still shows it.
    stopped: bool,
}

struct Subscription {
    sid: String,
    service: &'static str,
    callback: String,
    expires: Instant,
    seq: u32,
    last: String,
}

static RENDERER: Mutex<Option<Renderer>> = Mutex::new(None);
static SUBSCRIPTIONS: Mutex<Vec<Subscription>> = Mutex::new(Vec::new());
static NOTIFIER: Mutex<Option<u64>> = Mutex::new(None);
static SETTINGS: Mutex<Option<(String, String)>> = Mutex::new(None);

fn renderer() -> MutexGuard<'static, Option<Renderer>> {
    RENDERER.lock().unwrap_or_else(|e| e.into_inner())
}

fn subscriptions() -> MutexGuard<'static, Vec<Subscription>> {
    SUBSCRIPTIONS.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn adverts(settings: &Settings) -> Vec<ssdp::Advert> {
    *SETTINGS.lock().unwrap_or_else(|e| e.into_inner()) = Some((settings.name.clone(), settings.id.clone()));
    vec![ssdp::Advert { uuid: settings.id.clone(), device_type: DEVICE_TYPE.into(), services: vec![AVT.into(), RC.into(), CM.into()], location: "/dlna/description.xml".into() }]
}

pub fn route(request: &Request) -> Option<Response> {
    let path = request.path.strip_prefix("/dlna/")?;
    ensure_notifier();
    Some(match (request.method.as_str(), path) {
        ("GET" | "HEAD", "description.xml") => Response::xml(description()),
        ("GET" | "HEAD", "avt.xml") => Response::xml(scpd(&AVT_ACTIONS, &AVT_VARS)),
        ("GET" | "HEAD", "rc.xml") => Response::xml(scpd(&RC_ACTIONS, &RC_VARS)),
        ("GET" | "HEAD", "cm.xml") => Response::xml(scpd(&CM_ACTIONS, &CM_VARS)),
        ("GET" | "HEAD", "icon.png") => Response::ok("image/png", include_bytes!("../../icons/128x128.png").to_vec()),
        ("POST", "control/avt") => soap(request, AVT, avt_action),
        ("POST", "control/rc") => soap(request, RC, rc_action),
        ("POST", "control/cm") => soap(request, CM, cm_action),
        ("SUBSCRIBE", service) => subscribe(request, service),
        ("UNSUBSCRIBE", _) => {
            let sid = request.header("sid").unwrap_or("");
            subscriptions().retain(|s| s.sid != sid);
            Response::new(200)
        }
        _ => Response::not_found(),
    })
}

fn description() -> String {
    let (name, id) = SETTINGS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| ("Zazabor".into(), "zazabor".into()));
    let service = |kind: &str, short: &str, id: &str| {
        format!("<service><serviceType>{kind}</serviceType><serviceId>urn:upnp-org:serviceId:{id}</serviceId><SCPDURL>/dlna/{short}.xml</SCPDURL><controlURL>/dlna/control/{short}</controlURL><eventSubURL>/dlna/event/{short}</eventSubURL></service>")
    };
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>{DEVICE_TYPE}</deviceType><friendlyName>{}</friendlyName><manufacturer>Zazabor</manufacturer><manufacturerURL>https://github.com/Soab42/zazabor</manufacturerURL><modelDescription>Zazabor media player</modelDescription><modelName>Zazabor</modelName><modelNumber>1</modelNumber><UDN>uuid:{}</UDN><dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC><iconList><icon><mimetype>image/png</mimetype><width>128</width><height>128</height><depth>32</depth><url>/dlna/icon.png</url></icon></iconList><serviceList>{}{}{}</serviceList></device></root>"#,
        xml_escape(&name),
        xml_escape(&id),
        service(AVT, "avt", "AVTransport"),
        service(RC, "rc", "RenderingControl"),
        service(CM, "cm", "ConnectionManager"),
    )
}

// ---- SOAP ----------------------------------------------------------------------------------

type Action = fn(&str, &Request) -> Result<Vec<(&'static str, String)>, (u16, &'static str)>;

fn soap(request: &Request, service: &str, action: Action) -> Response {
    let header = request.header("soapaction").unwrap_or("").trim_matches('"').to_string();
    let name = header.rsplit('#').next().unwrap_or("").to_string();
    let body = request.body_text();
    match action(&name, request).map(|out| (out, body)) {
        Ok((out, _)) => {
            let args: String = out.iter().map(|(k, v)| format!("<{k}>{}</{k}>", xml_escape(v))).collect();
            Response::xml(envelope(&format!("<u:{name}Response xmlns:u=\"{service}\">{args}</u:{name}Response>")))
        }
        Err((code, text)) => Response::new(500).header("Content-Type", "text/xml; charset=\"utf-8\"").body(envelope(&format!(
            "<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>{code}</errorCode><errorDescription>{text}</errorDescription></UPnPError></detail></s:Fault>"
        ))),
    }
}

fn envelope(body: &str) -> String {
    format!(r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>{body}</s:Body></s:Envelope>"#)
}

/// The text inside the first `<name>` (or `<prefix:name>`) element, unescaped.
pub fn arg(xml: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(pos) = xml[from..].find('<') {
        let start = from + pos + 1;
        let end = start + xml[start..].find('>')?;
        let tag = &xml[start..end];
        from = end + 1;
        if tag.starts_with('/') || tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let tag_name = tag.split_whitespace().next().unwrap_or("");
        let self_closing = tag.ends_with('/');
        let local = tag_name.trim_end_matches('/').rsplit(':').next().unwrap_or("");
        if local != name {
            continue;
        }
        if self_closing {
            return Some(String::new());
        }
        let close = format!("</{}>", tag_name);
        let stop = xml[from..].find(&close)?;
        return Some(unescape(&xml[from..from + stop]));
    }
    None
}

fn unescape(text: &str) -> String {
    let text = text.trim();
    let text = text.strip_prefix("<![CDATA[").and_then(|t| t.strip_suffix("]]>")).unwrap_or(text);
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(semi) = rest.find(';').filter(|&s| s <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e if e.starts_with("#x") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// "H:MM:SS(.fff)" for milliseconds.
pub fn format_time(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// Milliseconds from "H:MM:SS(.fff)" or "MM:SS"; None for anything else.
pub fn parse_time(text: &str) -> Option<i64> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut seconds = 0f64;
    for part in &parts {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some((seconds * 1000.0).round() as i64)
}

// ---- AVTransport ---------------------------------------------------------------------------

fn transport_state(state: Option<PlayState>, has_uri: bool) -> &'static str {
    match state {
        Some(PlayState::Loading | PlayState::Buffering) => "TRANSITIONING",
        Some(PlayState::Playing) => "PLAYING",
        Some(PlayState::Paused) => "PAUSED_PLAYBACK",
        _ if has_uri => "STOPPED",
        _ => "NO_MEDIA_PRESENT",
    }
}

/// The session's status, if it is still ours and not stopped.
fn current_status(r: &Renderer) -> Option<super::Status> {
    let session = r.session.filter(|_| !r.stopped)?;
    Some(super::status(session))
}

fn media_for(uri: &str, metadata: &str, sender: &str, sender_key: &str) -> Media {
    let field = |name| arg(metadata, name).map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let class = field("class").unwrap_or_default();
    Media {
        url: uri.to_string(),
        title: field("title"),
        subtitle: field("artist").or_else(|| field("creator")).or_else(|| field("album")),
        artwork: field("albumArtURI").filter(|u| u.starts_with("http")),
        start_ms: 0,
        live: class.contains("videoBroadcast") || class.contains("audioBroadcast"),
        options: Vec::new(),
        sender: sender.to_string(),
        sender_key: sender_key.to_string(),
    }
}

fn sender_of(request: &Request) -> (String, String) {
    let agent = request.header("user-agent").unwrap_or("");
    // "BubbleUPnP UPnP/1.1", "Samsung SmartView/1.0", "Microsoft-Windows/10.0 UPnP/1.0 …"
    let app = agent.split(['/', ' ', ';']).find(|w| !w.is_empty() && !w.eq_ignore_ascii_case("upnp") && !w.eq_ignore_ascii_case("linux") && !w.eq_ignore_ascii_case("android")).unwrap_or("A phone");
    let ip = request.peer.ip();
    (format!("{app} on {ip}"), format!("dlna:{ip}"))
}

fn start_playing(r: &mut Renderer) {
    let media = media_for(&r.uri, &r.metadata, &r.sender, &r.sender_key);
    r.session = Some(super::play(Source::Dlna, media));
    r.stopped = false;
}

fn avt_action(name: &str, request: &Request) -> Result<Vec<(&'static str, String)>, (u16, &'static str)> {
    let body = request.body_text();
    let mut slot = renderer();
    let r = slot.get_or_insert_with(Renderer::default);
    let status = current_status(r);
    Ok(match name {
        "SetAVTransportURI" => {
            let uri = arg(&body, "CurrentURI").unwrap_or_default();
            if !(uri.starts_with("http://") || uri.starts_with("https://") || uri.starts_with("rtsp://")) {
                return Err((716, "Resource not found"));
            }
            let (sender, key) = sender_of(request);
            let playing = matches!(status.as_ref().map(|s| s.state), Some(PlayState::Playing | PlayState::Paused | PlayState::Buffering));
            r.uri = uri;
            r.metadata = arg(&body, "CurrentURIMetaData").unwrap_or_default();
            r.next_uri.clear();
            r.next_metadata.clear();
            r.sender = sender;
            r.sender_key = key;
            // A new address while something plays switches at once (as TVs do); otherwise the
            // phone sends Play next.
            if playing {
                start_playing(r);
            } else {
                r.session = None;
            }
            vec![]
        }
        "SetNextAVTransportURI" => {
            r.next_uri = arg(&body, "NextURI").unwrap_or_default();
            r.next_metadata = arg(&body, "NextURIMetaData").unwrap_or_default();
            vec![]
        }
        "Play" => {
            match (r.session, status.as_ref().map(|s| s.state)) {
                (Some(session), Some(PlayState::Paused | PlayState::Playing | PlayState::Buffering | PlayState::Loading)) => {
                    super::set_paused(session, false);
                }
                _ if !r.uri.is_empty() => {
                    let (sender, key) = sender_of(request);
                    r.sender = sender;
                    r.sender_key = key;
                    start_playing(r);
                }
                _ => return Err((701, "Transition not available")),
            }
            vec![]
        }
        "Pause" => {
            if let Some(session) = r.session {
                super::set_paused(session, true);
            }
            vec![]
        }
        "Stop" => {
            if let Some(session) = r.session.take() {
                super::stop(session);
            }
            r.stopped = true;
            vec![]
        }
        "Seek" => {
            let unit = arg(&body, "Unit").unwrap_or_default();
            let target = arg(&body, "Target").unwrap_or_default();
            let Some(ms) = (unit == "REL_TIME" || unit == "ABS_TIME").then(|| parse_time(&target)).flatten() else {
                return Err((710, "Seek mode not supported"));
            };
            match r.session {
                Some(session) if super::seek(session, ms) => {}
                _ => return Err((701, "Transition not available")),
            }
            vec![]
        }
        "Next" | "Previous" => return Err((711, "Illegal seek target")),
        "GetTransportInfo" => {
            let state = transport_state(status.as_ref().map(|s| s.state), !r.uri.is_empty());
            vec![("CurrentTransportState", state.into()), ("CurrentTransportStatus", if status.as_ref().is_some_and(|s| s.state == PlayState::Error) { "ERROR_OCCURRED" } else { "OK" }.into()), ("CurrentSpeed", "1".into())]
        }
        "GetPositionInfo" => {
            let (time, length) = status.as_ref().map(|s| (s.time_ms, s.length_ms)).unwrap_or((0, 0));
            vec![
                ("Track", if r.uri.is_empty() { "0" } else { "1" }.into()),
                ("TrackDuration", format_time(length)),
                ("TrackMetaData", r.metadata.clone()),
                ("TrackURI", r.uri.clone()),
                ("RelTime", format_time(time)),
                ("AbsTime", format_time(time)),
                ("RelCount", "2147483647".into()),
                ("AbsCount", "2147483647".into()),
            ]
        }
        "GetMediaInfo" | "GetMediaInfo_Ext" => {
            let length = status.as_ref().map(|s| s.length_ms).unwrap_or(0);
            let mut out = vec![];
            if name == "GetMediaInfo_Ext" {
                out.push(("CurrentType", "TRACK_UNAWARE".to_string()));
            }
            out.extend([
                ("NrTracks", if r.uri.is_empty() { "0" } else { "1" }.to_string()),
                ("MediaDuration", format_time(length)),
                ("CurrentURI", r.uri.clone()),
                ("CurrentURIMetaData", r.metadata.clone()),
                ("NextURI", r.next_uri.clone()),
                ("NextURIMetaData", r.next_metadata.clone()),
                ("PlayMedium", "NETWORK".into()),
                ("RecordMedium", "NOT_IMPLEMENTED".into()),
                ("WriteStatus", "NOT_IMPLEMENTED".into()),
            ]);
            out
        }
        "GetTransportSettings" => vec![("PlayMode", "NORMAL".into()), ("RecQualityMode", "NOT_IMPLEMENTED".into())],
        "GetDeviceCapabilities" => vec![("PlayMedia", "NETWORK".into()), ("RecMedia", "NOT_IMPLEMENTED".into()), ("RecQualityModes", "NOT_IMPLEMENTED".into())],
        "GetCurrentTransportActions" => vec![("Actions", "Play,Pause,Stop,Seek".into())],
        "SetPlayMode" => vec![],
        _ => return Err((401, "Invalid Action")),
    })
}

// ---- RenderingControl ------------------------------------------------------------------------

fn volume_now() -> (u32, bool) {
    let state = crate::video::control::state();
    let (volume, muted) = crate::video::control::volume(&state);
    ((volume.min(1.0) * 100.0).round() as u32, muted)
}

fn rc_action(name: &str, request: &Request) -> Result<Vec<(&'static str, String)>, (u16, &'static str)> {
    let body = request.body_text();
    let session = renderer().as_ref().and_then(|r| r.session).or_else(|| super::current().map(|(id, _)| id));
    Ok(match name {
        "GetVolume" => vec![("CurrentVolume", volume_now().0.to_string())],
        "GetMute" => vec![("CurrentMute", if volume_now().1 { "1" } else { "0" }.into())],
        "SetVolume" => {
            let level: f64 = arg(&body, "DesiredVolume").and_then(|v| v.parse().ok()).ok_or((402, "Invalid Args"))?;
            match session {
                Some(s) => {
                    super::set_volume(s, level / 100.0);
                }
                None => crate::video::control::set_volume((level / 100.0).clamp(0.0, 1.0)),
            }
            vec![]
        }
        "SetMute" => {
            let muted = matches!(arg(&body, "DesiredMute").as_deref(), Some("1" | "true" | "True"));
            match session {
                Some(s) => {
                    super::set_muted(s, muted);
                }
                None => crate::video::control::set_muted(muted),
            }
            vec![]
        }
        "ListPresets" => vec![("CurrentPresetNameList", "FactoryDefaults".into())],
        "SelectPreset" => vec![],
        _ => return Err((401, "Invalid Action")),
    })
}

// ---- ConnectionManager -----------------------------------------------------------------------

const SINK_FORMATS: &[&str] = &[
    "video/mp4", "video/x-matroska", "video/webm", "video/mpeg", "video/mp2t", "video/quicktime", "video/x-msvideo", "video/avi", "video/x-flv", "video/3gpp", "video/x-ms-wmv",
    "application/vnd.apple.mpegurl", "application/x-mpegURL", "application/dash+xml",
    "audio/mpeg", "audio/mp4", "audio/aac", "audio/x-aac", "audio/flac", "audio/x-flac", "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav", "audio/L16", "audio/webm", "audio/x-ms-wma",
    "image/jpeg", "image/png",
];

fn cm_action(name: &str, _request: &Request) -> Result<Vec<(&'static str, String)>, (u16, &'static str)> {
    Ok(match name {
        "GetProtocolInfo" => {
            let sink = SINK_FORMATS.iter().map(|m| format!("http-get:*:{m}:*")).collect::<Vec<_>>().join(",");
            vec![("Source", String::new()), ("Sink", sink)]
        }
        "GetCurrentConnectionIDs" => vec![("ConnectionIDs", "0".into())],
        "GetCurrentConnectionInfo" => vec![
            ("RcsID", "0".into()),
            ("AVTransportID", "0".into()),
            ("ProtocolInfo", String::new()),
            ("PeerConnectionManager", String::new()),
            ("PeerConnectionID", "-1".into()),
            ("Direction", "Input".into()),
            ("Status", "OK".into()),
        ],
        _ => return Err((401, "Invalid Action")),
    })
}

// ---- service descriptions ------------------------------------------------------------------

/// (action, [(argument, in?, state variable)]).
type ActionSpec = (&'static str, &'static [(&'static str, bool, &'static str)]);
/// (state variable, type, evented, allowed values).
type VarSpec = (&'static str, &'static str, bool, &'static [&'static str]);

const ID: (&str, bool, &str) = ("InstanceID", true, "A_ARG_TYPE_InstanceID");

static AVT_ACTIONS: [ActionSpec; 15] = [
    ("SetAVTransportURI", &[ID, ("CurrentURI", true, "AVTransportURI"), ("CurrentURIMetaData", true, "AVTransportURIMetaData")]),
    ("SetNextAVTransportURI", &[ID, ("NextURI", true, "NextAVTransportURI"), ("NextURIMetaData", true, "NextAVTransportURIMetaData")]),
    ("GetMediaInfo", &[ID, ("NrTracks", false, "NumberOfTracks"), ("MediaDuration", false, "CurrentMediaDuration"), ("CurrentURI", false, "AVTransportURI"), ("CurrentURIMetaData", false, "AVTransportURIMetaData"), ("NextURI", false, "NextAVTransportURI"), ("NextURIMetaData", false, "NextAVTransportURIMetaData"), ("PlayMedium", false, "PlaybackStorageMedium"), ("RecordMedium", false, "RecordStorageMedium"), ("WriteStatus", false, "RecordMediumWriteStatus")]),
    ("GetTransportInfo", &[ID, ("CurrentTransportState", false, "TransportState"), ("CurrentTransportStatus", false, "TransportStatus"), ("CurrentSpeed", false, "TransportPlaySpeed")]),
    ("GetPositionInfo", &[ID, ("Track", false, "CurrentTrack"), ("TrackDuration", false, "CurrentTrackDuration"), ("TrackMetaData", false, "CurrentTrackMetaData"), ("TrackURI", false, "CurrentTrackURI"), ("RelTime", false, "RelativeTimePosition"), ("AbsTime", false, "AbsoluteTimePosition"), ("RelCount", false, "RelativeCounterPosition"), ("AbsCount", false, "AbsoluteCounterPosition")]),
    ("GetDeviceCapabilities", &[ID, ("PlayMedia", false, "PossiblePlaybackStorageMedia"), ("RecMedia", false, "PossibleRecordStorageMedia"), ("RecQualityModes", false, "PossibleRecordQualityModes")]),
    ("GetTransportSettings", &[ID, ("PlayMode", false, "CurrentPlayMode"), ("RecQualityMode", false, "CurrentRecordQualityMode")]),
    ("Stop", &[ID]),
    ("Play", &[ID, ("Speed", true, "TransportPlaySpeed")]),
    ("Pause", &[ID]),
    ("Seek", &[ID, ("Unit", true, "A_ARG_TYPE_SeekMode"), ("Target", true, "A_ARG_TYPE_SeekTarget")]),
    ("Next", &[ID]),
    ("Previous", &[ID]),
    ("SetPlayMode", &[ID, ("NewPlayMode", true, "CurrentPlayMode")]),
    ("GetCurrentTransportActions", &[ID, ("Actions", false, "CurrentTransportActions")]),
];

static AVT_VARS: [VarSpec; 27] = [
    ("TransportState", "string", false, &["STOPPED", "PLAYING", "TRANSITIONING", "PAUSED_PLAYBACK", "NO_MEDIA_PRESENT"]),
    ("TransportStatus", "string", false, &["OK", "ERROR_OCCURRED"]),
    ("PlaybackStorageMedium", "string", false, &["NONE", "NETWORK"]),
    ("RecordStorageMedium", "string", false, &["NOT_IMPLEMENTED"]),
    ("PossiblePlaybackStorageMedia", "string", false, &[]),
    ("PossibleRecordStorageMedia", "string", false, &[]),
    ("CurrentPlayMode", "string", false, &["NORMAL"]),
    ("TransportPlaySpeed", "string", false, &["1"]),
    ("RecordMediumWriteStatus", "string", false, &["NOT_IMPLEMENTED"]),
    ("CurrentRecordQualityMode", "string", false, &["NOT_IMPLEMENTED"]),
    ("PossibleRecordQualityModes", "string", false, &[]),
    ("NumberOfTracks", "ui4", false, &[]),
    ("CurrentTrack", "ui4", false, &[]),
    ("CurrentTrackDuration", "string", false, &[]),
    ("CurrentMediaDuration", "string", false, &[]),
    ("CurrentTrackMetaData", "string", false, &[]),
    ("CurrentTrackURI", "string", false, &[]),
    ("AVTransportURI", "string", false, &[]),
    ("AVTransportURIMetaData", "string", false, &[]),
    ("NextAVTransportURI", "string", false, &[]),
    ("NextAVTransportURIMetaData", "string", false, &[]),
    ("RelativeTimePosition", "string", false, &[]),
    ("AbsoluteTimePosition", "string", false, &[]),
    ("RelativeCounterPosition", "i4", false, &[]),
    ("AbsoluteCounterPosition", "i4", false, &[]),
    ("CurrentTransportActions", "string", false, &[]),
    ("LastChange", "string", true, &[]),
];

static AVT_EXTRA_VARS: [VarSpec; 3] = [
    ("A_ARG_TYPE_SeekMode", "string", false, &["REL_TIME", "ABS_TIME", "TRACK_NR"]),
    ("A_ARG_TYPE_SeekTarget", "string", false, &[]),
    ("A_ARG_TYPE_InstanceID", "ui4", false, &[]),
];

static RC_ACTIONS: [ActionSpec; 6] = [
    ("ListPresets", &[ID, ("CurrentPresetNameList", false, "PresetNameList")]),
    ("SelectPreset", &[ID, ("PresetName", true, "A_ARG_TYPE_PresetName")]),
    ("GetMute", &[ID, ("Channel", true, "A_ARG_TYPE_Channel"), ("CurrentMute", false, "Mute")]),
    ("SetMute", &[ID, ("Channel", true, "A_ARG_TYPE_Channel"), ("DesiredMute", true, "Mute")]),
    ("GetVolume", &[ID, ("Channel", true, "A_ARG_TYPE_Channel"), ("CurrentVolume", false, "Volume")]),
    ("SetVolume", &[ID, ("Channel", true, "A_ARG_TYPE_Channel"), ("DesiredVolume", true, "Volume")]),
];

static RC_VARS: [VarSpec; 7] = [
    ("PresetNameList", "string", false, &[]),
    ("LastChange", "string", true, &[]),
    ("Mute", "boolean", false, &[]),
    ("Volume", "ui2", false, &[]),
    ("A_ARG_TYPE_Channel", "string", false, &["Master"]),
    ("A_ARG_TYPE_InstanceID", "ui4", false, &[]),
    ("A_ARG_TYPE_PresetName", "string", false, &["FactoryDefaults"]),
];

static CM_ACTIONS: [ActionSpec; 3] = [
    ("GetProtocolInfo", &[("Source", false, "SourceProtocolInfo"), ("Sink", false, "SinkProtocolInfo")]),
    ("GetCurrentConnectionIDs", &[("ConnectionIDs", false, "CurrentConnectionIDs")]),
    ("GetCurrentConnectionInfo", &[("ConnectionID", true, "A_ARG_TYPE_ConnectionID"), ("RcsID", false, "A_ARG_TYPE_RcsID"), ("AVTransportID", false, "A_ARG_TYPE_AVTransportID"), ("ProtocolInfo", false, "A_ARG_TYPE_ProtocolInfo"), ("PeerConnectionManager", false, "A_ARG_TYPE_ConnectionManager"), ("PeerConnectionID", false, "A_ARG_TYPE_ConnectionID"), ("Direction", false, "A_ARG_TYPE_Direction"), ("Status", false, "A_ARG_TYPE_ConnectionStatus")]),
];

static CM_VARS: [VarSpec; 10] = [
    ("SourceProtocolInfo", "string", true, &[]),
    ("SinkProtocolInfo", "string", true, &[]),
    ("CurrentConnectionIDs", "string", true, &[]),
    ("A_ARG_TYPE_ConnectionStatus", "string", false, &["OK", "ContentFormatMismatch", "InsufficientBandwidth", "UnreliableChannel", "Unknown"]),
    ("A_ARG_TYPE_ConnectionManager", "string", false, &[]),
    ("A_ARG_TYPE_Direction", "string", false, &["Input", "Output"]),
    ("A_ARG_TYPE_ProtocolInfo", "string", false, &[]),
    ("A_ARG_TYPE_ConnectionID", "i4", false, &[]),
    ("A_ARG_TYPE_AVTransportID", "i4", false, &[]),
    ("A_ARG_TYPE_RcsID", "i4", false, &[]),
];

fn scpd(actions: &[ActionSpec], vars: &[VarSpec]) -> String {
    let mut out = String::from(r#"<?xml version="1.0" encoding="utf-8"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>"#);
    for (name, args) in actions {
        out.push_str(&format!("<action><name>{name}</name><argumentList>"));
        for (arg, input, var) in args.iter() {
            out.push_str(&format!("<argument><name>{arg}</name><direction>{}</direction><relatedStateVariable>{var}</relatedStateVariable></argument>", if *input { "in" } else { "out" }));
        }
        out.push_str("</argumentList></action>");
    }
    out.push_str("</actionList><serviceStateTable>");
    let extra: &[VarSpec] = if std::ptr::eq(vars.as_ptr(), AVT_VARS.as_ptr()) { &AVT_EXTRA_VARS } else { &[] };
    for (name, kind, evented, allowed) in vars.iter().chain(extra.iter()) {
        out.push_str(&format!("<stateVariable sendEvents=\"{}\"><name>{name}</name><dataType>{kind}</dataType>", if *evented { "yes" } else { "no" }));
        if !allowed.is_empty() {
            out.push_str("<allowedValueList>");
            for v in allowed.iter() {
                out.push_str(&format!("<allowedValue>{v}</allowedValue>"));
            }
            out.push_str("</allowedValueList>");
        }
        if *name == "Volume" {
            out.push_str("<allowedValueRange><minimum>0</minimum><maximum>100</maximum><step>1</step></allowedValueRange>");
        }
        out.push_str("</stateVariable>");
    }
    out.push_str("</serviceStateTable></scpd>");
    out
}

// ---- events (GENA) -------------------------------------------------------------------------

fn subscribe(request: &Request, path: &str) -> Response {
    let service = match path {
        "event/avt" => "avt",
        "event/rc" => "rc",
        "event/cm" => "cm",
        _ => return Response::not_found(),
    };
    let timeout = Response::new(200).header("TIMEOUT", format!("Second-{EVENT_TIMEOUT}")).header("DATE", ssdp::http_date());
    // A renewal names its SID; a new subscription names its CALLBACK.
    if let Some(sid) = request.header("sid") {
        let mut subs = subscriptions();
        return match subs.iter_mut().find(|s| s.sid == sid) {
            Some(s) => {
                s.expires = Instant::now() + Duration::from_secs(EVENT_TIMEOUT);
                timeout.header("SID", sid)
            }
            None => Response::new(412),
        };
    }
    let Some(callback) = request.header("callback").and_then(|c| c.split('>').next()).map(|c| c.trim_start_matches('<').to_string()) else {
        return Response::new(412);
    };
    // Events only go back to the phone that asked (CallStranger: a callback naming another
    // host would turn the receiver into a request relay on the local network).
    match callback_target(&callback) {
        Some((addr, _)) if addr.ip() == request.peer.ip() => {}
        _ => return Response::new(412),
    }
    let mut subs = subscriptions();
    if subs.len() >= MAX_SUBSCRIPTIONS || subs.iter().filter(|s| callback_target(&s.callback).is_some_and(|(a, _)| a.ip() == request.peer.ip())).count() >= MAX_PER_PHONE {
        return Response::new(503);
    }
    let sid = format!("uuid:{}", random_hex());
    subs.push(Subscription { sid: sid.clone(), service, callback, expires: Instant::now() + Duration::from_secs(EVENT_TIMEOUT), seq: 0, last: String::new() });
    timeout.header("SID", sid)
}

const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_PER_PHONE: usize = 6;

/// `http://<ip literal>[:port]/path` → the address and path. Host names are refused, so nothing
/// is ever looked up and the address can be compared with the subscriber's.
fn callback_target(callback: &str) -> Option<(std::net::SocketAddr, String)> {
    let rest = callback.strip_prefix("http://")?;
    let (host, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
    let addr = host.parse::<std::net::SocketAddr>().ok().or_else(|| host.parse::<std::net::IpAddr>().ok().map(|ip| (ip, 80).into()))?;
    let ip = addr.ip();
    (!ip.is_unspecified() && !ip.is_multicast()).then_some((addr, path))
}

fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// The LastChange document for a service, from the current state.
fn last_change(service: &str) -> String {
    let event = |ns: &str, vars: &[(&str, String)]| {
        let body: String = vars.iter().map(|(k, v)| format!("<{k} val=\"{}\"/>", xml_escape(v))).collect();
        format!("<Event xmlns=\"{ns}\"><InstanceID val=\"0\">{body}</InstanceID></Event>")
    };
    match service {
        "avt" => {
            let slot = renderer();
            let r = slot.as_ref();
            let status = r.and_then(current_status);
            let uri = r.map(|r| r.uri.clone()).unwrap_or_default();
            let meta = r.map(|r| r.metadata.clone()).unwrap_or_default();
            let length = status.as_ref().map(|s| s.length_ms).unwrap_or(0);
            event(
                "urn:schemas-upnp-org:metadata-1-0/AVT/",
                &[
                    ("TransportState", transport_state(status.as_ref().map(|s| s.state), !uri.is_empty()).into()),
                    ("TransportStatus", "OK".into()),
                    ("CurrentTrackURI", uri.clone()),
                    ("AVTransportURI", uri),
                    ("CurrentTrackMetaData", meta.clone()),
                    ("AVTransportURIMetaData", meta),
                    ("CurrentTrackDuration", format_time(length)),
                    ("CurrentMediaDuration", format_time(length)),
                    ("CurrentTransportActions", "Play,Pause,Stop,Seek".into()),
                ],
            )
        }
        "rc" => {
            let (volume, muted) = volume_now();
            event("urn:schemas-upnp-org:metadata-1-0/RCS/", &[("Volume channel=\"Master\"", volume.to_string()), ("Mute channel=\"Master\"", if muted { "1" } else { "0" }.into())])
                .replace("<Volume channel=\"Master\" val=", "<Volume channel=\"Master\" val=")
        }
        _ => String::new(),
    }
}

/// Starts the thread that sends changes to subscribers and moves on to the next track.
fn ensure_notifier() {
    let Some(generation) = super::settings().map(|_| super::GENERATION.load(std::sync::atomic::Ordering::SeqCst)) else { return };
    let mut running = NOTIFIER.lock().unwrap_or_else(|e| e.into_inner());
    if *running == Some(generation) {
        return;
    }
    *running = Some(generation);
    let _ = std::thread::Builder::new().name("cast-dlna-events".into()).spawn(move || {
        while super::alive(generation) {
            std::thread::sleep(Duration::from_millis(700));
            advance_queue();
            notify_subscribers();
        }
    });
}

/// When a track ends and the phone queued another (SetNextAVTransportURI), play it.
fn advance_queue() {
    let mut slot = renderer();
    let Some(r) = slot.as_mut() else { return };
    let Some(session) = r.session else { return };
    if r.next_uri.is_empty() || super::status(session).state != PlayState::Ended {
        return;
    }
    r.uri = std::mem::take(&mut r.next_uri);
    r.metadata = std::mem::take(&mut r.next_metadata);
    start_playing(r);
}

fn notify_subscribers() {
    let now = Instant::now();
    let mut due = Vec::new();
    {
        let mut subs = subscriptions();
        subs.retain(|s| s.expires > now);
        let services: Vec<&'static str> = subs.iter().map(|s| s.service).collect();
        let mut docs = std::collections::HashMap::new();
        for service in services {
            docs.entry(service).or_insert_with(|| last_change(service));
        }
        for s in subs.iter_mut() {
            let doc = docs.get(s.service).cloned().unwrap_or_default();
            if doc.is_empty() || (doc == s.last && s.seq > 0) {
                continue;
            }
            s.last = doc.clone();
            due.push((s.callback.clone(), s.sid.clone(), s.seq, doc));
            s.seq = s.seq.wrapping_add(1).max(1);
        }
    }
    for (callback, sid, seq, doc) in due {
        let body = format!(r#"<?xml version="1.0" encoding="utf-8"?><e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>{}</LastChange></e:property></e:propertyset>"#, xml_escape(&doc));
        let _ = send_notify(&callback, &sid, seq, &body);
    }
}

fn send_notify(callback: &str, sid: &str, seq: u32, body: &str) -> Result<(), String> {
    use std::io::Write;
    let (addr, path) = callback_target(callback).ok_or("bad callback")?;
    let host = addr.to_string();
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!("NOTIFY {path} HTTP/1.1\r\nHOST: {host}\r\nCONTENT-TYPE: text/xml; charset=\"utf-8\"\r\nNT: upnp:event\r\nNTS: upnp:propchange\r\nSID: {sid}\r\nSEQ: {seq}\r\nCONTENT-LENGTH: {}\r\nCONNECTION: close\r\n\r\n{body}", body.len());
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut sink = [0u8; 256];
    let _ = std::io::Read::read(&mut stream, &mut sink);
    Ok(())
}

/// What the page shows about the DLNA side (who's connected).
#[derive(Serialize)]
pub struct DlnaInfo {
    pub subscribers: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_soap_arguments() {
        let body = r#"<?xml version="1.0"?><s:Envelope><s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>http://192.168.1.5:8080/a.mp4?x=1&amp;y=2</CurrentURI><CurrentURIMetaData>&lt;DIDL-Lite&gt;&lt;item&gt;&lt;dc:title&gt;Holiday &amp;amp; more&lt;/dc:title&gt;&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>"#;
        assert_eq!(arg(body, "CurrentURI").unwrap(), "http://192.168.1.5:8080/a.mp4?x=1&y=2");
        let meta = arg(body, "CurrentURIMetaData").unwrap();
        assert_eq!(arg(&meta, "title").unwrap(), "Holiday & more");
        assert_eq!(arg(&meta, "class").unwrap(), "object.item.videoItem");
        assert_eq!(arg(body, "Missing"), None);
        assert_eq!(arg("<a><Speed/></a>", "Speed").unwrap(), "");
    }

    #[test]
    fn times() {
        assert_eq!(format_time(3_725_000), "1:02:05");
        assert_eq!(parse_time("1:02:05"), Some(3_725_000));
        assert_eq!(parse_time("0:00:07.500"), Some(7_500));
        assert_eq!(parse_time("02:05"), Some(125_000));
        assert_eq!(parse_time("x"), None);
    }

    #[test]
    fn descriptions_are_well_formed_enough() {
        let avt = scpd(&AVT_ACTIONS, &AVT_VARS);
        assert!(avt.contains("<name>SetAVTransportURI</name>") && avt.contains("A_ARG_TYPE_SeekMode"));
        let rc = scpd(&RC_ACTIONS, &RC_VARS);
        assert!(rc.contains("<maximum>100</maximum>") && !rc.contains("A_ARG_TYPE_SeekMode"));
        assert_eq!(avt.matches("<action>").count(), AVT_ACTIONS.len());
        let d = description();
        assert!(d.contains(DEVICE_TYPE) && d.contains("/dlna/control/avt"));
    }

    #[test]
    fn callbacks_must_be_ip_literals() {
        assert_eq!(callback_target("http://192.168.1.5:4004/ev").map(|(a, p)| (a.to_string(), p)), Some(("192.168.1.5:4004".into(), "/ev".into())));
        assert_eq!(callback_target("http://192.168.1.5").map(|(a, _)| a.port()), Some(80));
        assert!(callback_target("http://router.local/x").is_none());
        assert!(callback_target("https://192.168.1.5/x").is_none());
        assert!(callback_target("http://224.0.0.1/x").is_none());
    }

    #[test]
    fn unescapes_entities() {
        assert_eq!(unescape("a &amp; b &lt;c&gt; &#233; &#xe9; & loose"), "a & b <c> é é & loose");
        assert_eq!(unescape("<![CDATA[<x>]]>"), "<x>");
    }
}
