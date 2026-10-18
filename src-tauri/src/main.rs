// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    prefer_display_gpu();
    corepro_lib::run()
}

/// On hybrid laptops (Intel or AMD driving the screen, NVIDIA as a second GPU), GLVND hands
/// WebKitGTK NVIDIA's EGL driver first. Every frame is then rendered on the NVIDIA chip and
/// copied to the display GPU, which makes animation stutter and leaves ghost frames behind.
/// Rendering through Mesa on the GPU that drives the screen avoids both. Set
/// `SLIDERPRO_GPU=nvidia` to opt out.
#[cfg(target_os = "linux")]
fn prefer_display_gpu() {
    use std::fs;
    use std::path::Path;
    const MESA_VENDOR: &str = "/usr/share/glvnd/egl_vendor.d/50_mesa.json";
    if std::env::var_os("__EGL_VENDOR_LIBRARY_FILENAMES").is_some()
        || std::env::var("SLIDERPRO_GPU").is_ok_and(|v| v.eq_ignore_ascii_case("nvidia"))
        || !Path::new(MESA_VENDOR).exists()
        || !Path::new("/proc/driver/nvidia").exists()
    {
        return;
    }
    let display_gpu_vendor = fs::read_dir("/sys/class/drm")
        .into_iter()
        .flatten()
        .flatten()
        .map(|card| card.path().join("device"))
        .find(|device| fs::read_to_string(device.join("boot_vga")).is_ok_and(|v| v.trim() == "1"))
        .and_then(|device| fs::read_to_string(device.join("vendor")).ok());
    let nvidia_drives_display = display_gpu_vendor.is_some_and(|v| v.trim() == "0x10de");
    if !nvidia_drives_display {
        // Runs before any other thread exists, so changing the environment is safe.
        std::env::set_var("__EGL_VENDOR_LIBRARY_FILENAMES", MESA_VENDOR);
    }
}
