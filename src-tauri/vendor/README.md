# Vendored sources

- **LibRaw 0.21.3** (`LibRaw/`): decodes camera RAW files for Photo (`src/photo/raw.rs`). Copied
  unchanged (minus its Makefiles and the RawSpeed glue's data) from the copy vendored in the
  [rsraw-sys](https://crates.io/crates/rsraw-sys) 0.1.1 crate. LibRaw is dual-licensed under
  CDDL-1.0 or LGPL-2.1 (see `LibRaw/COPYRIGHT`, `LICENSE.CDDL`, `LICENSE.LGPL`); CorePro links it
  statically under the CDDL, which keeps CorePro's own licence open. `build.rs` compiles it with
  the system's C++ compiler, so no prebuilt binary is involved.
