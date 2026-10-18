//! Video tracks of the current file (the Video tab's track list).

use super::vlc::{libvlc_media_player_t, libvlc_track_description_t};
use super::{ensure_unlocked, read_tracks, wake, with_player, Track};
use serde::Serialize;
use std::ffi::c_int;

#[link(name = "vlc")]
extern "C" {
    fn libvlc_video_get_track_description(player: *mut libvlc_media_player_t) -> *mut libvlc_track_description_t;
    fn libvlc_video_get_track(player: *mut libvlc_media_player_t) -> c_int;
    fn libvlc_video_set_track(player: *mut libvlc_media_player_t, id: c_int) -> c_int;
}

#[derive(Serialize, Debug)]
pub struct VideoTracks {
    pub(crate) tracks: Vec<Track>,
    /// The selected track's id, -1 when none.
    pub(crate) current: i32,
}

pub(crate) fn video_tracks_now() -> VideoTracks {
    with_player(|p| {
        // SAFETY: see with_player; the list is released by read_tracks.
        unsafe { VideoTracks { tracks: read_tracks(libvlc_video_get_track_description(p)), current: libvlc_video_get_track(p) } }
    })
    .unwrap_or(VideoTracks { tracks: Vec::new(), current: -1 })
}

#[tauri::command]
pub async fn video_video_tracks() -> Result<VideoTracks, String> {
    ensure_unlocked()?;
    Ok(video_tracks_now())
}

#[tauri::command]
pub async fn video_set_video_track(id: i32) -> Result<(), String> {
    ensure_unlocked()?;
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { libvlc_video_set_track(p, id) }
    });
    wake();
    Ok(())
}
