# Photo: a mini Photoshop (plan, draft)

*Researched 2026-10-26. Licences, versions and release dates were read from each project's
repository, crates.io, the npm registry and Hugging Face model cards on that day. Target: Tauri 2 +
plain TypeScript on Linux (WebKitGTK 2.50.4; Intel UHD (Tiger Lake) graphics on this machine).
Status: **I0–I3 built, most of I4, and I5 (AI) and I6 (RAW) in a first version (2026-10-26/27,
below).** Section 11 lists the decisions only the user can make.*

## What's built (2026-10-26)

Decisions taken for this round: Photo lives in Studio (`src/modules/studio/photo/`); Quick Edit
saves a copy next to the original; no AI models, RAW, PSD or AVIF yet.

**I0, probe and canvas.**
- The probe (`gl.ts`, shown in Photo's status bar): WebGL2 with `EXT_color_buffer_float`, RGBA16F
  render targets checked by drawing a value 8 bits can't hold and reading it back, and
  `MAX_TEXTURE_SIZE` 16384. Measured in Zazabor's WebKitGTK 2.50.4 on a nested Xephyr display,
  where libEGL reported no DRI3, so probably Mesa's software renderer; WebKit masks the renderer
  name ("Apple GPU"), so the Intel GPU's own answer still needs a look at Photo's status bar on
  the real display. Without float targets compositing falls back to RGBA8.
- Rust (`src-tauri/src/photo/`): decode PNG/JPEG/WebP/TIFF/BMP/GIF upright (EXIF orientation
  applied, as the Gallery reads it) to 8-bit RGBA with the ICC profile and EXIF; encode JPEG, PNG,
  WebP (lossless), TIFF and BMP with the profile (and EXIF for JPEG/PNG/WebP, orientation reset to
  1). Colours are never converted: a picture keeps its own profile. TIFF profiles are read back
  with a small parser (the tiff crate writes them but doesn't return them).
- Pictures larger than the texture limit are scaled to fit and the user is told. Pixels cross
  the bridge raw: about 200 MB for a 50 MP photo, roughly 6 s to the page and 3 s back in the
  debug build. Quick Edit decodes the full picture in the background while the user edits.
- **Not done:** the tiled layer store. Layers are whole textures up to 16384 px, with a 1.5 GB
  budget (layers + buffers + history) that refuses new layers past it. Colour management
  (lcms2, linear working space, display profile) isn't started.

**I1, Quick Edit in the Gallery** (`src/modules/gallery/viewer/quickedit.ts`, the viewer's
Edit button or E): crop with ratios (free, original, 1:1, 4:5, 3:2, 16:9, 9:16), straighten with
auto-zoom, rotate, flip; Auto; exposure, contrast, highlights, shadows, whites, blacks,
temperature, tint, vibrance, saturation; the slideshow's six looks as filters with GPU swatches
and a strength; vignette; undo/redo; hold \ or the compare button for the original. Save a copy
writes `IMG_1234 (edited).jpg` (numbered when taken) and shows it in the viewer; "Save over
original…" asks first; "Open in Photo" applies the crop and turns to the picture and puts the
sliders on an adjustment layer. One shader (`render.ts`, `adjust.ts`) draws the preview and the
saved file in 2048 px tiles. Checked: a saved copy against the on-screen preview differs by 0.8
of 255 on average (resampling only), Photo's result after "Open in Photo" by 0.5.

**I2 core, the Photo editor** (`editor.ts`, `engine.ts`): Photoshop's layout (menus, options
bar, tools, Adjustments/Layers/History panels, status bar). Pixel and adjustment layers; all 27
of Photoshop's blend modes (W3C formulas plus Photoshop's own), opacity, visibility, rename,
drag to reorder, duplicate, delete, merge down, merge visible, flatten. Tools: move (arrow
nudges), crop with ratios, brush and eraser (size, hardness, opacity, flow, pen pressure,
[ ] keys), gradient (linear/radial, to transparent), paint bucket (tolerance, contiguous, all
layers), eyedropper, hand, zoom. Image menu: Auto Tone, Image Size, rotate and flip the canvas.
History panel with up to 200 steps or 1 GB (strokes keep only their changed rectangle). New
Canvas (1080 × 1080 default, presets). `.coreimage` save and open (zip: `document.json`,
`layers/n.png`, `profile.icc`, `preview.jpg`). Save to a picture format merges the layers and
asks before replacing the picture it came from; Export As picks the format and JPEG quality.
Live strokes recomposite only the changed area over a cached composite of the layers below.

### Round 2 (2026-10-27): masks, groups, selections, adjustments, type, shapes, transform, filters, PSD

The user said "start left ones"; the plan's recommendations were taken again. Checked in the app
on a nested display with screenshots, and by pixel comparisons in Python and Node.

- **I2 finished.** Layer masks on any layer (pixel, adjustment, group): Reveal/Hide All, from the
  selection or its inverse, paint on them (black hides; the eraser paints the background colour),
  fill, gradient, filters, invert (Ctrl+I), disable (Shift+click the thumbnail), apply, delete,
  load as a selection; Q switches between pixels and mask. Groups (Ctrl+G, Ctrl+Shift+G, New
  Group): Pass Through or a blend mode, opacity and mask, open/closed in the panel, nested; drag
  rows above, below or into a group; merge a group (Ctrl+E). Clipping masks (Ctrl+Alt+G): a layer
  shows only inside the opaque pixels (and mask and opacity) of the layer below it.
  The compositor (`engine.ts`) became a recursive pass over the layer tree with a buffer pair per
  nesting depth; live painting keeps its "layers below composited once" shortcut at the top level.
- **I3 selections** (`selection.ts`): Rectangular and Elliptical Marquee, Lasso, Polygonal Lasso
  (double-click or Enter closes, Backspace takes a corner back), Magic Wand (tolerance, contiguous,
  all layers); New/Add/Subtract/Intersect from the options bar or Shift/Alt; Select All, Deselect,
  Reselect, Inverse, Color Range (live outline while choosing), Layer Transparency (Ctrl+click a
  thumbnail), Feather (Shift+F6), Expand and Contract (exact distance transform). Marching ants are
  traced once per change into a `Path2D`. Every painting tool, fill, clear (Delete), bucket, filter,
  invert and the healing brush stays inside the selection (soft edges included); a new adjustment
  layer takes the selection as its mask. Cut, Copy, Copy Merged, Paste (as a new layer where it
  came from, or a picture from the system clipboard), Layer via Copy (Ctrl+J) and via Cut.
- **I3 adjustment layers** (`layeradjust.ts`, `props.ts`): Levels (per channel, histogram),
  Curves (per channel, drag points, type values, drag off to delete), Exposure, Vibrance,
  Hue/Saturation (master and six ranges, Colorize), Color Balance (three tones, Preserve
  Luminosity), Black & White (six weights, Tint), Photo Filter (Photoshop's presets), Gradient
  Map, Invert, Posterize and Threshold, beside the existing Light & Colour. Levels, Curves,
  Exposure and Posterize are worked out per pixel in the shader (a natural cubic spline for
  Curves, the coefficients from `tone.ts`); only Gradient Map uses a lookup table. The first try,
  a 1,024-entry table, missed Photoshop's 1/255 by up to 3.7/255 near a black point with a high
  midtone gamma, so it was dropped. **Checked:** `node --test tools/photo-tone.test.mjs`
  (Levels with gamma 0.1–9.9 and Curves with up to 8 points, against independent references,
  also with 32-bit float rounding: all within 1/255); and on the GPU, a 0–255 ramp through Levels
  (30/0.60/235, output 10) then an S-curve, saved and compared with the reference worked out
  from the saved settings: worst 0.87/255 over every value. Quick slider changes (arrow keys) fold
  into one History step.
- **I4, most of it.** Type layers (`vector.ts`): click to type with the system's fonts (Bangla
  through the browser's shaping), size, bold, italic, alignment, colour; Ctrl+Enter keeps,
  Esc drops; click the text or double-click its thumbnail to edit; option changes apply to the
  chosen type layer. Shape layers: rectangle (corner radius), ellipse, polygon (sides), line;
  fill and stroke, editable until rasterized. Free Transform (Ctrl+T, `transform.ts`): move,
  scale (corners in proportion, Shift free), rotate outside the box (Shift: 15°), skew
  (Ctrl+top/bottom edge), flip, typed X/Y/W/H/angle, Enter/Esc; on selected pixels it lifts them
  and the selection follows; the Move tool drags selected pixels the same way; Flip/Rotate Layer
  in the Edit menu. Filters (`filters.ts`, GPU): Gaussian Blur (large radii on a shrunk copy),
  Motion Blur, Unsharp Mask, Add Noise, each previewed live in a dialog that leaves the canvas
  visible, on pixels or a mask, inside the selection; Last Filter (Ctrl+Alt+F). Clone Stamp and
  Healing Brush (Alt+click the source, Aligned): the healing brush clones while painting, then
  blends the stroke into its surroundings with a coarse-to-fine Poisson solve (`heal.ts`).
  **PSD** (`psd.ts`, ag-psd 31.0.3, MIT, published 2026-10-07; the plan's 33.0.0 was 2 days old
  and skipped): open and Save As .psd with pixel layers, groups (Pass Through), masks, clipping,
  blend modes, opacity and the adjustment layers both apps have; type layers go as pixels, Light &
  Colour layers are left out with a message. **Checked:** a document with a masked layer, a group,
  Levels and text saved as PSD, read back in Node (structure and Levels values as written),
  reopened in Photo (same layers), flattened: identical to the PSD's own composite (difference 0).
  **Export:** lossy WebP (libwebp, with the colour profile and EXIF put back by our own container
  writer) and AVIF (ravif, pure Rust: this machine has no nasm, so no assembly; written as sRGB)
  next to JPEG, PNG, lossless WebP, TIFF and BMP; a Rust test checks both.
- **Projects:** `.coreimage` is version 2 (groups, masks, clipping, adjustment kinds, type and
  shape sources); version 1 files still open.

**Not done in round 2:** perspective/distort and warp in Free Transform; Select Subject, quick
selection, Refine Edge; spot healing (PatchMatch); box, lens and surface blurs, high pass, reduce
noise; LUT (.cube) and Channel Mixer adjustments; text on a path, layer styles; layer locks;
the tiled layer store and colour management (from I0); PSD colour profiles (ag-psd 31 has no
ICC field) and 16-bit PSDs.

**Waiting on the user:** nothing since round 3 (the user said "go for all waiting").

**Left for later milestones:** tiles and eviction (I0), colour management, 16-bit documents,
keeping EXIF in `.coreimage`, history in the file. A shortcut for Export As (Studio takes every
Ctrl+W/Ctrl+S combination, so Photoshop's Ctrl+Alt+Shift+W can't be used).

### Round 3 (2026-10-27): AI tools and RAW files

The user approved model downloads (decision 5) and RAW support (decision 6) with "go for all
waiting"; the repository is public with no licence chosen yet.

- **AI tools, all on this computer's CPU** (`src-tauri/src/photo/ai.rs`, `studio/photo/aimodels.ts`).
  Inference is [tract](https://github.com/sonos/tract) 0.23.9 (pure Rust ONNX, MIT/Apache-2.0,
  with its multithreaded matrix products on), so building Zazabor downloads nothing prebuilt.
  Each model is planned once for a fixed input size and kept while Zazabor runs.
  - **Remove Background** (Layer menu, Properties ▸ Quick Actions): a layer mask from the subject
    finder; no pixel is deleted. **Select Subject** (Select ▸ Subject, the Object Selection
    options): the same mask as a selection.
  - **Object Selection** (Shift+W): click an object; more clicks refine it, Alt+click takes a part
    away, Shift+click starts another object; New/Add/Subtract/Intersect from the options bar.
    MobileSAM's encoder looks at the picture once (shrunk to 1024 px; padded with the mean so the
    model's own normalising pads with zeros, as SAM does), then each click runs the prompt
    decoder. The decoder gets the clicks and exactly one "not a point" pad: planning it for 16
    points with 15 pads gave grid-patterned, wrong masks.
  - **Remove** (Shift+J): paint over something; on release it's filled from around it (MI-GAN).
    The model sees a square 3× the painted area (2.2× left too little context and smeared), at
    512 px; the fill is blended in over a feathered, slightly grown mask.
  - **Refine Edge** (Select menu, not AI): a guided filter (He et al.) with the picture's
    brightness as the guide, so soft AI edges snap to the picture's own (a 14-px ramp across an
    edge became a step at the edge in the check).
  - **Models** download on first use after a prompt with the size and licence, from pinned
    addresses checked against SHA-256, into the app data folder (`photo/models`); a cancelled or
    broken download keeps its `.part` and resumes with a Range request. Settings ▸ Photo lists
    them with Download and Remove and picks the subject finder. Only MIT or Apache-2.0 weights:

    | Tool | Model | File, size | Licence | SHA-256 |
    |---|---|---|---|---|
    | Subject (best) | IS-Net general use, 1024 px | `isnet-general-use.onnx` from rembg's release, 170 MB | Apache-2.0 | `60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a` |
    | Subject (faster) | U²-Netp, 320 px | `u2netp.onnx` from rembg's release, 4.4 MB | Apache-2.0 | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` |
    | Object Selection | MobileSAM encoder (Acly/MobileSAM on Hugging Face) | `mobile_sam_image_encoder.onnx`, 26.9 MB | Apache-2.0 weights, MIT export | `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749` |
    | Object Selection | SAM mask decoder (same repository) | `sam_mask_decoder_single.onnx`, 15.7 MB | Apache-2.0 weights, MIT export | `93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d` |
    | Remove | MI-GAN (andraniksargsyan/migan on Hugging Face) | `migan.onnx`, 28.2 MB | MIT | `593eba0b7e04730f1b61c0a3cbca68d97d8d6a7ff5c6a44a7b9d7fcd880fc5ae` |

    Not used: BiRefNet (its deformable convolutions aren't in tract), LaMa (Apache-2.0, 208 MB,
    better fills, but 8 s at 512 px in tract here), the MI-GAN and SAM "pipeline" exports (their
    shapes depend on the data, which tract can't plan), RMBG (non-commercial).
  - **Timings** on the 3300 × 4125 (13.6 MP) test portrait, release build, i5-11400H, while three
    other agents compiled (load average 17–28, so these are pessimistic): IS-Net 4.8 s warm,
    18 s the first time (loading and planning a 170 MB model); U²-Netp 1.4 s; Object Selection
    2.2 s to look at the picture, then about 0.15 s per click at 1024 px; Remove 1.4–2.5 s per
    stroke. In the debug app on the nested display: Remove Background 19.5 s (first use), a click
    3–4 s, Remove 2 s.
  - **Checked** on two public-domain photos (Neil Armstrong's NASA portrait, a golden retriever):
    the subject masks (IS-Net keeps the helmet, U²-Netp loses the visor), the dog selected from
    one click with clean edges, the helmet from two, bushes refilled with their own texture, a
    head removed (filled with fur). In the app: Remove Background (a mask, one History step),
    Object Selection, Remove over the flag, the first-use prompt and download of U²-Netp
    (checksum matched), Settings ▸ Photo. **Weak spot:** a large hole in a patterned area (part
    of the flag) leaves smears; MI-GAN at 512 px is best for small and medium distractions.
- **RAW files** (`src-tauri/src/photo/raw.rs`, `studio/photo/develop.ts`). **LibRaw 0.21.3,
  vendored** in `src-tauri/vendor/LibRaw` (copied unchanged from the copy in the rsraw-sys crate)
  and built by `build.rs` with the system's C++ compiler (-O2 and OpenMP even in debug builds),
  with a hand-written FFI to its C API: the vendored crates generate bindings with bindgen,
  which needs libclang, and this machine has none. **Why LibRaw over rawler:** LibRaw is
  CDDL-1.0 or LGPL-2.1; linked statically under the CDDL it leaves Zazabor's own licence open
  (closed, permissive or GPL, which can take the LGPL option), where rawler is LGPL-2.1 only and
  would make a closed or static future need relinking provisions.
  - Opening a RAW file (all of LibRaw's: CR2, CR3, NEF, ARW, RAF, RW2, ORF, DNG and more) makes
    one layer developed as shot; the Properties panel becomes **Develop**: camera, ISO, shutter,
    aperture, focal length; white balance As Shot (shown as a temperature and tint), Daylight,
    Cloudy, Shade, Tungsten, Fluorescent, Flash or Custom; Temperature, Tint, Exposure,
    Highlights, Shadows; sRGB or Display P3 (a small Display P3 ICC v2 profile is written and
    tags saved files). Each change is one History step; undo develops again.
  - LibRaw demosaics once per file (AHD, or X-Trans for Fuji) in the camera's own linear colours,
    white-balanced as shot and scaled so nothing clips; developing is Zazabor's: white balance as
    camera multipliers (a temperature goes through the CIE daylight or Planckian locus and the
    inverse of the camera's matrix), the camera matrix to linear sRGB or P3, exposure on a fixed
    baseline (the sensor's white one stop over white), a highlight shoulder that also takes the
    colour cast out of clipped channels, a shadows lift and a camera-like tone curve. The decoded
    file stays cached (two files, keyed by size and time), so a Develop change takes about 3 s on
    a 20 MP file in the debug build.
  - **Checked** against the embedded previews of six cameras from five brands (raw.pixls.us,
    CC0): Canon EOS R6 (CR3), Canon EOS 80D (CR2), Nikon Z 6 (NEF), Sony ILCE-6400 (ARW),
    Fujifilm X-T3 (RAF, X-Trans) and Apple iPhone 12 Pro (DNG). Mean colour per channel within 24
    of 255 of the camera's own rendering on all six (a test, ignored by default:
    `ZAZABOR_RAW_SAMPLES=<folder> cargo test raw_samples -- --ignored`). The first exposure
    baseline (the brightest 0.5 % at white) was off by up to 1.5 stops; the fixed one matches
    within about half a stop. In the app: the R6 file opened (12 s in the debug build), cooler
    white balance and undo.
  - **Not done:** 16-bit RAW layers (the layer is 8-bit), lens corrections, noise reduction,
    the Gallery and Files showing RAW thumbnails (they need sizes and orientation from LibRaw
    in shared code; left for a later round), a camera-profile (DCP) look.
- **Round 2 leftovers:** Refine Edge (above). Perspective and warp transforms and layer styles are
  still to do.

## 1. Summary

- **The same GPU work as the Gallery, made editable.** Layers, masks, blend modes, adjustment
  layers and filters are WebGL2 shaders in the page. The Gallery's deep-zoom viewer
  (`src/modules/gallery/viewer/`, tiled and mipmapped) and the slideshow's colour grades
  (`slideshow/gl.ts`) are the starting point. Rust does what needs files or the CPU: decoding
  (including 16-bit and RAW), colour management, encoding, PSD and project files, and the AI
  models.
- **Non-destructive by default.** Adjustments are layers with settings, not baked pixels. Pixel
  layers are sparse tiles, and the original photo is never overwritten unless asked.
- **Two levels, one engine.** A **Quick Edit** panel inside the Gallery viewer (crop, straighten,
  light, colour, filters, like Google Photos) and the full editor (layers, selections, brushes,
  text). Quick Edit's settings open in the full editor as adjustment layers.
- **Formats:** PNG, JPEG, WebP, AVIF, TIFF and 16-bit PNG/TIFF through Rust; PSD in and out
  through [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT, 33.0.0, 2026-10-24; 8-bit,
  partial text). Zazabor's own `.coreimage` project file (a zip) keeps everything.
- **AI tools on CPU, with permissive models only:**
  - Remove Background and Select Subject: BiRefNet (MIT), IS-Net or U²-Net (Apache-2.0).
  - Click to Select an Object: MobileSAM or SAM 2 (Apache-2.0).
  - Remove an Object: MI-GAN (MIT) or LaMa (Apache-2.0).

  They run through [ort](https://github.com/pykeio/ort) (ONNX Runtime, MIT). Models download on
  first use. BRIA RMBG (non-commercial) and @imgly/background-removal (**AGPL**) are left out.

## 2. Features

| Area | Photoshop | Zazabor, first version | Later |
|---|---|---|---|
| Canvas | Zoom, pan, rotate view, rulers, guides, grid, navigator | Same, on the Gallery's zoom (cursor-anchored cubic-bezier zoom, inertial pan, minimap) | Artboards |
| Layers | Pixel, adjustment, text, shape, smart object, group; opacity, fill, 27 blend modes, lock, clipping masks | Pixel, adjustment, text, shape, groups; opacity, all of Photoshop's blend modes, lock, clipping masks, layer masks | Smart objects (an embedded original that can be transformed again without loss) |
| Selections | Marquee, lasso, polygonal lasso, magic wand, quick selection, Select Subject, Select and Mask | Rectangle, ellipse, lasso, polygonal lasso, magic wand (tolerance, contiguous), colour range, Select Subject, click to select an object; feather, expand, contract, invert; save as a channel | Refine Edge for hair (a guided filter); a quick-selection brush |
| Crop and transform | Crop, straighten, perspective crop, free transform, warp, content-aware scale | Crop with ratios (1:1, 4:5, 9:16, 16:9, original), straighten with a level line, perspective crop, free transform (scale, rotate, skew, distort, perspective), flip | Warp, liquify |
| Adjustments (as layers) | Brightness/contrast, levels, curves, exposure, vibrance, hue/saturation, colour balance, black and white, photo filter, channel mixer, gradient map, LUT, shadows/highlights | All of those, plus white balance (temperature and tint) and LUTs (.cube) | Selective colour, HDR toning |
| Filters | Blur, sharpen, noise, distort, stylise, render | Gaussian, box, motion and lens blur; unsharp mask and high pass; add noise, reduce noise; vignette; pixelate; emboss; the slideshow's film grain | Lens correction, Camera Raw–style develop panel |
| Painting | Brush, pencil, eraser, mixer brush, gradient, paint bucket, clone stamp, healing brushes | Brush and eraser (size, hardness, opacity, flow, spacing; pen pressure from pointer events), gradient, paint bucket, clone stamp, healing brush, spot healing | Brush presets and textures, the mixer brush |
| Text and shapes | Text layers with full typography, shapes with stroke and fill | Point and box text with system fonts (Bangla included), size, weight, colour, alignment, line and letter spacing; rectangle, ellipse, line, polygon, custom path with fill and stroke | Text on a path, layer styles (shadow, stroke, glow) |
| History | History panel, snapshots | History panel (click a step to go back), snapshots | The history brush |
| AI | Generative fill (cloud), Remove Background, Select Subject, remove tool | Remove Background, Select Subject, click to select, Remove an Object (inpainting), all on this computer | Generative fill is out of scope: it needs very large models or a cloud |
| Colour | ICC profiles, 8/16/32-bit, CMYK | Working space in linear light, 8 or 16 bits per channel, embedded ICC profiles kept and written, display profile applied | CMYK soft-proofing |
| Formats | PSD, PSB, TIFF, PNG, JPEG, WebP, RAW (Camera Raw) | Open: JPEG, PNG, WebP, AVIF, TIFF, BMP, GIF, HEIC (if the system decoder is there), PSD (ag-psd), RAW (section 6). Save: `.coreimage`, PSD, and Export As PNG/JPEG/WebP/AVIF/TIFF with size, quality and metadata options | PSB, JPEG XL |

## 3. Architecture

### 3.1 Where the work happens

| Work | Where | Why |
|---|---|---|
| Compositing layers, blend modes, masks, adjustments, filters, the brush | WebGL2 shaders in the page | Real-time feedback on the GPU. The Gallery and Video already draw this way |
| Tiles and memory | Page (GPU textures) with Rust as the store | Only painted tiles exist. Tiles that aren't used for a while are evicted to Rust (memory, then disk) |
| Decode and encode, 16-bit, ICC | Rust (`image` 0.25.10, MIT/Apache-2.0; [lcms2](https://github.com/kornelski/rust-lcms2) 6.2.0 over Little CMS, MIT) | Already in Zazabor for thumbnails (`imaging.rs`) |
| AVIF and lossy WebP export | Rust: [ravif](https://github.com/kornelski/cavif-rs) 0.13.0 (BSD-3-Clause) and the [webp](https://crates.io/crates/webp) crate 0.3.1 (MIT/Apache-2.0, over libwebp, BSD) | The `image` crate writes lossless WebP only |
| PSD | Page (ag-psd) | MIT; reads and writes layers, masks, blend modes and effects. 8-bit only, text partly |
| Magic wand, healing (Poisson blending), PatchMatch | Rust, with rayon | CPU algorithms that are awkward in shaders |
| AI models | Rust through `ort` 2.0.0-rc.15 (MIT/Apache-2.0) and the ONNX Runtime library (MIT), or [tract](https://github.com/snipsco/tract) 0.23.9 (pure Rust) for small models | WebKitGTK has no WebGPU, so models in the page would be slow |
| Export at full resolution | The page renders each final tile, then Rust gathers and encodes them | The same shaders as the preview, so the export matches what was on screen |

### 3.2 The render graph

- Each layer is a node: its pixels (tiles) or its generator (text, shape, adjustment), then its
  mask, opacity and blend mode.
- The canvas renders the graph into a 16-bit float (RGBA16F) buffer in linear light, then converts
  to the display.
- Only tiles that changed are re-rendered, and the view renders at screen resolution from mipmaps
  while zoomed out.
- A fragment shader per blend mode, from the W3C compositing formulas plus Photoshop's own
  (linear burn, vivid light, pin light, hard mix, dissolve, darker/lighter colour).
- Adjustment layers are shader passes with uniforms. A curves or levels layer is a 1D lookup
  texture, and a LUT is a 3D texture.
- **First check (M0):** float render targets need `EXT_color_buffer_float` or the half-float
  variant in WebKitGTK's WebGL2. If they're missing, compositing falls back to RGBA8 with dithering
  and 16-bit work is done in Rust.

### 3.3 Memory

A 24-megapixel photo is about 96 MB per layer at 8 bits and 192 MB at 16-bit float. Integrated
graphics share system memory, so:

- Pixel layers store 8-bit tiles unless the document is 16-bit.
- Only touched tiles are allocated: a layer with a small brush stroke costs a few tiles, not a
  whole image.
- Adjustment, text and shape layers hold no pixels until they're rasterised.
- A memory budget (Settings, default 1.5 GB on the GPU) evicts least-recently-used tiles to Rust.
- Very large images (over about 16,000 px on a side, beyond the GPU's maximum texture size) are
  always tiled.

### 3.4 History

Each step stores what it changed: the tiles before it, or the old settings of a layer. Steps live
in memory up to a budget (default 1 GB) and older ones spill to the project's temporary folder.
History survives closing and reopening a `.coreimage` file when "Keep history in the file" is on.

### 3.5 Colour management

1. Decoding converts embedded ICC profiles (sRGB, Display P3, Adobe RGB, camera profiles) into the
   working space with lcms2: linear sRGB or linear Display P3, one per document.
2. The display transform is a 3D LUT built by lcms2 from the monitor's profile (colord, or the
   `_ICC_PROFILE` X atom), applied in the last shader. WebKitGTK itself assumes sRGB.
3. Export converts to the chosen output profile (sRGB by default for the web) and embeds it.

### 3.6 Project file: `.coreimage`

A zip, the same idea as .docx and .kra:

- `document.json` holds the size, bit depth, colour space, layers, settings, guides and history
  settings.
- `tiles/` holds layer tiles as PNG (8- or 16-bit).
- `sources/` holds the embedded originals of placed images.
- `preview.jpg` (1,600 px) gives Files, Quick Look and the Gallery a thumbnail without opening the
  editor.

Files and Quick Look learn the extension.

## 4. Tools in detail

- **Brush engine:** a stamp shader placed along the pointer path at a spacing, with size, hardness,
  opacity and flow. Pressure comes from `PointerEvent.pressure` and tilt from `tiltX`/`tiltY`
  (graphics tablets through libinput). Strokes are smoothed (lazy mouse). Painting draws into a
  stroke buffer that's composited once at the end, so opacity doesn't stack within one stroke.
- **Clone and healing:** clone copies from a source offset. The healing brush clones, then blends
  the edges by solving a Poisson equation over the stroke's area (Jacobi iterations in a shader,
  or a direct solve in Rust). Spot healing picks its source with PatchMatch in Rust; for larger
  areas, the AI remover (section 5).
- **Magic wand and colour range:** a flood fill or a global colour-distance test in Rust over the
  composite or the current layer, returned as an 8-bit mask tile set. The marching ants are a
  shader over the mask's edge.
- **Text:**
  - Text layers are drawn with Canvas 2D into a texture, with system fonts through CSS; the
    browser shapes Bangla correctly.
  - Editing happens in place with a `contenteditable` overlay, so input methods work.
  - On PSD export the text is kept as a text layer where ag-psd can write it, and rasterised
    otherwise.
- **Shapes:** paths with fill and stroke, drawn with Canvas 2D (or tiny-skia in Rust for
  export), editable until rasterised.
- **Transform:** the selection or layer gets handles. While dragging, the preview resamples on the
  GPU (bilinear, or bicubic when released). Perspective uses a homography.

## 5. AI tools

All run on this computer, in Rust, on the CPU by default. ONNX Runtime can use CUDA or OpenVINO
when they're present. Models download once into the app's data folder, after a prompt that names
the size. Sizes are approximate.

| Tool | Model | Licence | Size, approximately | Notes |
|---|---|---|---|---|
| Remove Background, Select Subject | [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (general, lite) | MIT | a few hundred MB (lite less) | Best edges. Run at 1024 px |
| Same, small and fast | [IS-Net](https://github.com/xuebinqin/DIS) general-use, or [U²-Net](https://github.com/xuebinqin/U-2-Net) / U²-Netp | Apache-2.0 | ~170 MB / 4.7 MB | Fallback, as [rembg](https://github.com/danielgatis/rembg) offers (rembg is MIT; each model has its own licence) |
| Portraits | [MODNet](https://github.com/ZHKKKe/MODNet) | Apache-2.0 | ~25 MB | Hair-level masks for people. The repository is quiet since 2024 |
| Click to select an object | [MobileSAM](https://github.com/ChaoningZhang/MobileSAM), or [SAM 2](https://github.com/facebookresearch/sam2) (tiny or small) | Apache-2.0 | ~40 MB / ~150 MB | The encoder runs once per image, then each click is quick |
| Remove an object | [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN), or [LaMa](https://github.com/advimman/lama) | MIT / Apache-2.0 | ~30 MB / ~200 MB | Paint over the object; the model fills it. Then the healing brush tidies up |
| **Not used** | BRIA [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) and RMBG-2.0 | BRIA's own licence (1.4); [CC BY-NC 4.0, per mirrors of the card](https://gitserver.onethingai.com/ai-models/RMBG-2.0/commit/b104609356afa90696da049a95c408ffc0e3e7ff) (2.0; the official card is gated) | ~1 GB | Non-commercial or paid only |
| **Not used** | [@imgly/background-removal](https://github.com/imgly/background-removal-js) | **AGPL-3.0** | — | Copyleft |

Generative fill ("add a hat") needs diffusion models of several GB and a strong GPU, so it's left
out.

## 6. RAW photos

| Option | Licence | Latest | Notes |
|---|---|---|---|
| [rawler](https://github.com/dnglab/dnglab) (dnglab) | **LGPL-2.1** | 0.8.0, 2026-08-30 | Pure Rust; many cameras and DNG. Statically linked Rust code under the LGPL means Zazabor must let users relink, which is simple only if Zazabor's source is public |
| [rawloader](https://github.com/pedrocr/rawloader) | **LGPL-2.1** | 0.37.2, 2026-08-15 | Decoding only; the same LGPL question |
| [LibRaw](https://github.com/LibRaw/LibRaw) | LGPL-2.1 or CDDL-1.0 | 0.22.3, 2026-10-26 (Pop!_OS has 0.20.2, `libraw20`, not installed) | The standard C library, linked dynamically from the system: clean for LGPL. The Rust binding [libraw-rs](https://crates.io/crates/libraw-rs) is stale (2021), so Zazabor needs a small FFI of its own |

**Recommendation:** LibRaw from the system, through a small FFI, loaded only when a RAW file is
opened. Development is Zazabor's own:

1. LibRaw demosaics.
2. Then, in linear light: white balance, the camera matrix to the working space, exposure, a tone
   curve and lens vignetting.
3. The result is a 16-bit layer, with the RAW settings kept as an editable "Develop" adjustment at
   the bottom of the stack.

## 7. Integration with the rest of Zazabor

- **Gallery viewer:** an **Edit** button opens **Quick Edit** in place: crop and rotate, auto,
  light (exposure, contrast, highlights, shadows), colour (temperature, tint, saturation,
  vibrance), filters (the 11 slideshow looks as presets) and vignette. Save makes a copy
  (`IMG_1234 (edited).jpg`) by default; "Save over original" asks first and keeps the original in
  Zazabor's versions for 30 days. "Open in Photo" carries the settings over as adjustment layers.
- **Files:** `.coreimage` and `.psd` open in Photo; images get **Edit in Photo** in their context
  menu.
- **Office and PDF:** an image in Docs, or a picked image in the PDF app, can be sent to Photo and
  comes back when saved.
- **Video editor:** a frame grab can be edited here, and a still exported from Photo can be used as
  an overlay.

## 8. Milestones

| # | Milestone | Done when |
|---|---|---|
| I0 | **Probe and canvas**: test float render targets and maximum texture size in WebKitGTK; a tiled layer store; the canvas with the Gallery's zoom and pan; open and save PNG/JPEG with ICC | A 50-megapixel JPEG opens, zooms and pans without dropped frames, and saves with its profile kept |
| I1 | **Quick Edit in the Gallery**: crop, straighten, the light and colour sliders, filter presets, save a copy | Edits look the same on screen and in the saved file (pixel diff against the shader output) |
| I2 | **Layers and painting**: pixel layers, blend modes, opacity, masks, groups, brush, eraser, gradient, bucket, history panel, `.coreimage` | 20 layers on a 24-megapixel image stay responsive on the Intel GPU here. History steps back through 200 brush strokes |
| I3 | **Selections and adjustment layers**: all the selection tools in section 2 except the AI ones; all the adjustments; clipping masks | Levels and curves match a reference implementation within 1/255 |
| I4 | **Text, shapes, transform, filters, clone and healing; PSD in and out; export dialog (PNG, JPEG, WebP, AVIF, TIFF, 16-bit)** | A PSD with layers and masks from Photopea or Photoshop round-trips through Zazabor and reopens there |
| I5 | **AI tools**: Remove Background, Select Subject, click to select, Remove an Object | Each runs in under 5 seconds on this machine's CPU for a 12-megapixel photo |
| I6 | **RAW and colour**: LibRaw develop layer; display profile; Display P3 working space | RAW files from three camera brands develop with correct colour against their embedded previews |

## 9. Effort, roughly

I0 takes 1–2 sessions, I1 one, I2 3–4 (the tile store and brushes are the core), I3 2, I4 3, I5 2,
and I6 2.

## 10. Risks

| Risk | Mitigation |
|---|---|
| WebKitGTK's WebGL2 lacks float targets, or is slow on some GPUs | The probe in I0. An RGBA8 fallback with dithering; 16-bit maths in Rust where needed |
| GPU memory on integrated graphics | Sparse tiles, the memory budget and eviction (section 3.3) |
| PSD fidelity (Photoshop features ag-psd can't write) | Warn when saving over a PSD with unsupported parts (the Office plan's fidelity guard idea), and save a copy by default |
| AI model licences change or downloads disappear | Pin model versions with checksums. Host the files Zazabor uses on a mirror it controls, if the licences allow redistribution |
| Scope: Photoshop is enormous | Ship Quick Edit first (I1), which covers most real use, then grow the full editor milestone by milestone |
| Existing apps to learn from | [Graphite](https://github.com/GraphiteEditor/Graphite) (Apache-2.0, Rust, node-based; raster tools still early, desktop release candidate in 2026) and [miniPaint](https://github.com/viliusle/miniPaint) (MIT, v4.14.3, 2026-04-20, Canvas 2D) are worth reading for ideas. Neither fits as an embedded engine: each is a whole app with its own UI |

## 11. Decisions to make

1. **Where it lives:** a "Studio" section on the rail holding Photo and Video, with an inner rail
   like Office (recommended); or Photo inside the Gallery; or its own section?
2. **Name:** Photo, Zazabor Photo, Studio Photo, or another?
3. **Quick Edit first**, then the full editor? Or start with the full editor?
4. **Saving edits from the Gallery:** a copy next to the original (recommended), or over the
   original with a backup?
5. **AI models:** OK to download them on first use (tens to a few hundred MB each, with a prompt)?
   Which matter most: background removal, object removal, or click to select?
   *Decided 2026-10-27: yes, all three (built in round 3).*
6. **RAW support** in the first version? Which camera or phone do you shoot RAW with? A sample file
   would help.
   *Decided 2026-10-27: yes; tested on public CC0 samples from six cameras while no file of the
   user's is to hand.*
7. **Zazabor's licence** affects the RAW choice. If Zazabor's source will be public, rawler (LGPL,
   pure Rust) becomes simple; if not, LibRaw through the system library is the clean route.
   *Round 3 took a third route that keeps every option open: LibRaw vendored and linked
   statically under its CDDL-1.0 option (round 3 above). The licence itself is still the user's.*
8. **PSD:** is reading and writing PSD important (working with people who use Photoshop), or is
   `.coreimage` plus PNG/JPEG export enough?
