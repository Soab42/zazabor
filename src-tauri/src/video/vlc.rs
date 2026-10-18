//! The small part of libVLC 3's C API the video backend uses.

#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_int, c_uint, c_void};

#[repr(C)]
pub struct libvlc_instance_t {
    _private: [u8; 0],
}
#[repr(C)]
pub struct libvlc_media_t {
    _private: [u8; 0],
}
#[repr(C)]
pub struct libvlc_media_player_t {
    _private: [u8; 0],
}
#[repr(C)]
pub struct libvlc_event_manager_t {
    _private: [u8; 0],
}

/// Only the leading `type` field is read; the payload union is never touched.
#[repr(C)]
pub struct libvlc_event_t {
    pub kind: c_int,
}

/// An entry of a track list; the list is freed with `libvlc_track_description_list_release`.
#[repr(C)]
pub struct libvlc_track_description_t {
    pub id: c_int,
    pub name: *mut c_char,
    pub next: *mut libvlc_track_description_t,
}

pub const EVENT_PLAYING: c_int = 260;
pub const EVENT_PAUSED: c_int = 261;
pub const EVENT_STOPPED: c_int = 262;
pub const EVENT_END_REACHED: c_int = 265;
pub const EVENT_ENCOUNTERED_ERROR: c_int = 266;
pub const EVENT_LENGTH_CHANGED: c_int = 273;
pub const EVENT_VOUT: c_int = 274;
pub const EVENT_ES_ADDED: c_int = 276;
pub const EVENT_ES_DELETED: c_int = 277;
pub const EVENT_ES_SELECTED: c_int = 278;

pub const STATE_PLAYING: c_int = 3;
pub const SLAVE_SUBTITLE: c_int = 0;

pub type LockCb = unsafe extern "C" fn(opaque: *mut c_void, planes: *mut *mut c_void) -> *mut c_void;
pub type UnlockCb = unsafe extern "C" fn(opaque: *mut c_void, picture: *mut c_void, planes: *const *mut c_void);
pub type DisplayCb = unsafe extern "C" fn(opaque: *mut c_void, picture: *mut c_void);
pub type FormatCb = unsafe extern "C" fn(
    opaque: *mut *mut c_void,
    chroma: *mut c_char,
    width: *mut c_uint,
    height: *mut c_uint,
    pitches: *mut c_uint,
    lines: *mut c_uint,
) -> c_uint;
pub type CleanupCb = unsafe extern "C" fn(opaque: *mut c_void);
pub type EventCb = unsafe extern "C" fn(event: *const libvlc_event_t, data: *mut c_void);

/// libvlc_media_track_t (`vlc/libvlc_media.h`), shared by the library parser and the Playback tab.
#[repr(C)]
pub struct MediaTrack {
    pub codec: u32,
    pub original_fourcc: u32,
    pub id: c_int,
    pub kind: c_int,
    pub profile: c_int,
    pub level: c_int,
    /// Union of audio / video / subtitle details; points at the struct matching `kind`.
    pub details: *mut c_void,
    pub bitrate: c_uint,
    pub language: *mut c_char,
    pub description: *mut c_char,
}

#[link(name = "vlc")]
extern "C" {
    pub fn libvlc_media_tracks_get(media: *mut libvlc_media_t, tracks: *mut *mut *mut MediaTrack) -> c_uint;
    pub fn libvlc_media_tracks_release(tracks: *mut *mut MediaTrack, count: c_uint);
}

#[link(name = "vlc")]
extern "C" {
    pub fn libvlc_new(argc: c_int, argv: *const *const c_char) -> *mut libvlc_instance_t;
    pub fn libvlc_media_new_path(instance: *mut libvlc_instance_t, path: *const c_char) -> *mut libvlc_media_t;
    pub fn libvlc_media_add_option(media: *mut libvlc_media_t, option: *const c_char);
    pub fn libvlc_media_release(media: *mut libvlc_media_t);
    pub fn libvlc_media_player_new_from_media(media: *mut libvlc_media_t) -> *mut libvlc_media_player_t;
    pub fn libvlc_media_player_release(player: *mut libvlc_media_player_t);
    pub fn libvlc_media_player_play(player: *mut libvlc_media_player_t) -> c_int;
    pub fn libvlc_media_player_set_pause(player: *mut libvlc_media_player_t, pause: c_int);
    pub fn libvlc_media_player_stop(player: *mut libvlc_media_player_t);
    pub fn libvlc_media_player_get_state(player: *mut libvlc_media_player_t) -> c_int;
    pub fn libvlc_media_player_get_time(player: *mut libvlc_media_player_t) -> i64;
    pub fn libvlc_media_player_set_time(player: *mut libvlc_media_player_t, time: i64);
    pub fn libvlc_media_player_get_length(player: *mut libvlc_media_player_t) -> i64;
    pub fn libvlc_media_player_set_rate(player: *mut libvlc_media_player_t, rate: f32) -> c_int;
    pub fn libvlc_media_player_add_slave(
        player: *mut libvlc_media_player_t,
        kind: c_int,
        uri: *const c_char,
        select: bool,
    ) -> c_int;
    pub fn libvlc_media_player_event_manager(player: *mut libvlc_media_player_t) -> *mut libvlc_event_manager_t;
    pub fn libvlc_event_attach(
        manager: *mut libvlc_event_manager_t,
        kind: c_int,
        callback: EventCb,
        data: *mut c_void,
    ) -> c_int;
    pub fn libvlc_event_detach(manager: *mut libvlc_event_manager_t, kind: c_int, callback: EventCb, data: *mut c_void);
    pub fn libvlc_video_set_callbacks(
        player: *mut libvlc_media_player_t,
        lock: Option<LockCb>,
        unlock: Option<UnlockCb>,
        display: Option<DisplayCb>,
        opaque: *mut c_void,
    );
    pub fn libvlc_video_set_format_callbacks(player: *mut libvlc_media_player_t, setup: Option<FormatCb>, cleanup: Option<CleanupCb>);
    pub fn libvlc_video_get_size(player: *mut libvlc_media_player_t, num: c_uint, x: *mut c_uint, y: *mut c_uint) -> c_int;
    pub fn libvlc_video_get_spu(player: *mut libvlc_media_player_t) -> c_int;
    pub fn libvlc_video_set_spu(player: *mut libvlc_media_player_t, id: c_int) -> c_int;
    pub fn libvlc_video_get_spu_description(player: *mut libvlc_media_player_t) -> *mut libvlc_track_description_t;
    pub fn libvlc_audio_get_track(player: *mut libvlc_media_player_t) -> c_int;
    pub fn libvlc_audio_set_track(player: *mut libvlc_media_player_t, id: c_int) -> c_int;
    pub fn libvlc_audio_get_track_description(player: *mut libvlc_media_player_t) -> *mut libvlc_track_description_t;
    pub fn libvlc_audio_set_volume(player: *mut libvlc_media_player_t, volume: c_int) -> c_int;
    pub fn libvlc_audio_set_mute(player: *mut libvlc_media_player_t, mute: c_int);
    pub fn libvlc_track_description_list_release(list: *mut libvlc_track_description_t);
}
