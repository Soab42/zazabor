fn main() {
    libraw();
    pdfium_cfg();
    tauri_build::build()
}

/// `has_pdfium` when PDFium is here for the tests that use it: `ZAZABOR_PDFIUM`, or pdfium/ from
/// scripts/fetch-pdfium.sh. Without it those tests are ignored (fetching it later: touch build.rs).
fn pdfium_cfg() {
    println!("cargo:rustc-check-cfg=cfg(has_pdfium)");
    println!("cargo:rerun-if-env-changed=ZAZABOR_PDFIUM");
    let named = std::env::var_os("ZAZABOR_PDFIUM").filter(|v| !v.is_empty()).map(std::path::PathBuf::from).map(|p| if p.is_dir() { p.join("libpdfium.so") } else { p });
    let found = named.filter(|p| p.is_file()).or_else(|| Some(std::path::PathBuf::from("pdfium/lib/libpdfium.so")).filter(|p| p.is_file()));
    if let Some(lib) = found {
        println!("cargo:rerun-if-changed={}", lib.display());
        println!("cargo:rustc-cfg=has_pdfium");
    }
}

/// LibRaw (vendor/LibRaw, CDDL-1.0 or LGPL-2.1), which Photo uses for RAW files, built from source
/// with optimisation even in debug builds (demosaicing unoptimised takes a minute a photo).
fn libraw() {
    let root = std::path::Path::new("vendor/LibRaw");
    println!("cargo:rerun-if-changed=vendor/LibRaw");
    let mut files = Vec::new();
    let mut dirs = vec![root.join("src")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).expect("vendor/LibRaw/src").flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.is_dir() {
                dirs.push(path);
            } else if name.ends_with(".cpp") && !name.ends_with("_ph.cpp") {
                // The *_ph.cpp files are placeholders other files include.
                files.push(path);
            }
        }
    }
    files.sort();
    let mut build = cc::Build::new();
    build.cpp(true).include(root).files(&files).warnings(false).extra_warnings(false).opt_level(2);
    for flag in ["-Wno-format-truncation", "-Wno-unused-result", "-Wno-format-overflow", "-w"] {
        build.flag_if_supported(flag);
    }
    build.flag("-pthread");
    if build.is_flag_supported("-fopenmp").unwrap_or(false) {
        build.flag("-fopenmp");
        println!("cargo:rustc-link-lib=gomp");
    }
    build.compile("raw");
}
