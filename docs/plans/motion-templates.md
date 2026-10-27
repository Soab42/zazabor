# Plan: premium motion templates for product videos and reels

*Studio → Video Editor (and Photo, for still posters). Asked for on 2026-10-27: "premium motion
graphics template for product marketing video and reels … stunning modern animation … designed by
professional, category wise, with different font, and also save and reuse customised theme".
Status: **T0–T2 and the first six templates built** (2026-10-27); see section 13. Section 12
records the decisions taken.*

## 1. Summary

- **A template gallery in the Video Editor.** Ready-made scenes (intros, product reveals, feature
  call-outs, price and sale cards, testimonials, logo reveals, end screens) sorted by category and
  shape (9:16, 1:1, 4:5, 16:9). Hovering a template plays it. One click puts it on the timeline.
- **Fill in, don't build.** Each template has fields: headline, lines of text, price, product photo
  or clip, logo, call to action. The user types and drops files. Layout, timing and motion stay
  designed. Text that runs long reflows and shrinks the way the designer set it up.
- **Brand Kits: themes saved and reused.** Colours, a heading and a body font, a logo, corner
  roundness and a motion feel (Snappy, Smooth, Playful). Applying a kit restyles every template in
  a project at once. Kits are saved, can be the default for new projects, and can be shared as a
  file. A customised template can be saved to "My Templates".
- **Premium means the motion, not the effects count.** Kinetic type with per-letter staggers, mask
  reveals, spring physics, motion blur, depth and parallax, device mockups, number counters, liquid
  and shape transitions, all timed to music beats. Section 4 sets the design language, so every
  template follows the same rules.
- **Built on what exists:**
  - the WebGL2 compositor;
  - keyframes and easing from round 2, and the slideshow's 50 transitions;
  - captions, stickers, sounds and export from round 3;
  - Photo's AI Remove Background, which cuts the product out of its photo.

## 2. What the user does

1. Video Editor → **Templates** tab (beside Media, Audio, Text, Transitions, Filters). It has
   categories on the left, a grid of live-looping previews, and filters for shape, length (6 s,
   10 s, 15 s, 30 s) and mood. A search field covers names and tags.
2. Pick one, then **Use Template**. It lands on the timeline as one *template clip* sized to the
   project. Whole-video templates ("Product Launch, 15 s") fill the timeline as a sequence of
   scenes.
3. The Inspector shows the template's **fields**:
   - Text boxes, with the character limit the design holds well.
   - **Media slots**: drop a photo or clip. For a product photo, a "Cut out product" button runs
     Photo's Remove Background.
   - Colour swatches from the Brand Kit, and a font pair.
   - Length: stretch or squeeze, so the timing scales and the keyframes stay in proportion.
4. Optional extras:
   - "Match to music": scene cuts and accent hits snap to the beats of the chosen track (round 2's
     beat marks).
   - "Ungroup to layers": the template becomes ordinary text, shape and media clips for full
     freedom.
5. Export as today. **Save as Poster** renders one frame of a template as a still PNG or JPEG for
   Instagram or Facebook posts, and Photo can open it.

## 3. Categories and the first collection

Each design ships in all four shapes, with layouts adapting rather than cropping (section 6.4).

| Category | Templates in v1 | Examples |
|---|---|---|
| Product launch | 6 | Hero reveal with light sweep, "Introducing…" with kinetic type, 3D turntable card, spec call-outs with leader lines |
| Sale & offers | 6 | Flash-sale countdown, price slash (old price struck, new price springs in), % badge burst, "Limited stock" ticker, BOGO, coupon code card |
| Feature highlight | 5 | Three-up icon features, before/after slider, zoom-to-detail with circle mask, numbered steps, stat counters |
| App & tech promo | 5 | Phone mockup with screen recording slot, laptop/browser mockup, UI scroll-through, notification pop-ins, QR / download badges |
| Fashion & beauty | 4 | Editorial split-screen, lookbook grid, swatch picker, elegant serif titles |
| Food & restaurant | 4 | Menu card, "Today's special", ingredient pop-ins, delivery CTA (Foodpanda/Pathao style) |
| Real estate & services | 3 | Property card with details, agent intro, map pin reveal |
| Testimonials & social proof | 3 | Quote card with stars, review carousel, "10,000+ customers" counter |
| Logo reveals & intros | 6 | Line-draw logo, liquid morph, glitch, particles assemble, light-leak, clean minimal |
| Lower thirds & titles | 5 | Name/title bars, chapter titles, subscribe/follow prompts |
| Reel hooks & end screens | 5 | "Wait for it…", "3 reasons why", swipe-up/link CTA, follow end card, outro with socials |
| Festive (Bangladesh) | 4 | Eid offer, Pohela Boishakh, Victory Day / Independence Day, Puja: festive motifs, Bangla-first type |
| **Total** | **56** | |

Every template has a Bangla-ready variant: it uses the Bangla font of the Brand Kit, with line
heights set for Bangla's taller letters, and a check that conjuncts aren't split by per-letter
animation (section 6.3).

## 4. The motion design language ("premium")

The rules every template follows, written down so the collection feels like one designer's:

- **Timing.** Entrances 400–700 ms, exits about 60% of that, nothing faster than 150 ms. Hold
  times long enough to read: about 250 ms per word, at least 1.5 s per text block.
- **Easing.** No linear motion except for continuous loops. The default curve is an expressive
  ease-out (cubic-bezier(0.16, 1, 0.3, 1)). Springs, with stiffness and damping per Brand Kit motion
  feel, drive pops and settles. Overshoot only in the Playful feel.
- **Staggers.** Letters 18–35 ms apart, words 60–90 ms, cards 90–140 ms. Direction follows reading
  order.
- **Reveals over fades.** Mask wipes, clip-path reveals, text rising from behind a baseline, line
  draws (stroke offset), scale-from-blur. A plain fade only for exits.
- **Depth.** Two or three parallax layers, soft shadows that move with the light, slight 3D
  perspective on cards (≤ 12°), and background blur that pulls focus to the product.
- **Motion blur.** Sub-frame accumulation on fast moves, so whips and slides look filmed, not
  stepped.
- **Colour and light.** Gradient sweeps, glows and light leaks in the Brand Kit's colours,
  grain at 2–4% for a filmic finish, and contrast checked for every text field (WCAG AA on its
  background).
- **Layout.** A 12-column grid with safe areas per platform (Reels/TikTok UI zones kept clear),
  type scale by ratio (1.25 or 1.333), and at most two fonts per template.
- **Sound.** Each template has suggested hit points (whoosh on a wipe, pop on a badge), mapped to
  round 3's sound effects and played only if the user keeps them on.

## 5. Fonts

- **Bundled, OFL-licensed** (free to ship and to use in commercial videos), about 25 families,
  subset to Latin + Bengali where they have it, as variable fonts when available:
  - **Sans:** Inter, Poppins, Montserrat, Plus Jakarta Sans, DM Sans, Manrope, Space Grotesk, Outfit, Sora
  - **Display:** Bebas Neue, Anton, Oswald, Archivo Black, Syne, Unbounded, Righteous
  - **Serif:** Playfair Display, DM Serif Display, Fraunces, Cormorant Garamond
  - **Script & hand:** Pacifico, Caveat, Dancing Script
  - **Bangla:** Hind Siliguri, Anek Bangla, Baloo Da 2, Tiro Bangla, Galada, Noto Sans and Serif Bengali (already on the system)
- **Font pairings** as named presets ("Editorial: Playfair + Inter", "Bold Retail: Anton +
  Poppins", "Tech: Space Grotesk + Inter", "Bangla Modern: Anek Bangla + Hind Siliguri"…). A Brand
  Kit picks one pairing or two fonts of its own.
- **The user's own fonts:** installed system fonts and fonts added from a file (.ttf, .otf,
  .woff2) are listed too. A project keeps a copy of any added font, so it opens the same way on
  another computer.
- **Size:** about 15–25 MB in all. Each font is loaded only when a template or text uses it.

## 6. How it works

### 6.1 The template format (`.zaztemplate`)

A JSON document plus its assets (SVG shapes, fonts, images, sound hits), zipped:

- **Metadata:** name, category, tags, mood, length, shapes it supports, preview poster and loop.
- **Fields:** id, kind (text, media, colour, number, choice), label, default value, limits
  (characters, lines), Brand Kit binding (heading font, accent colour…).
- **Scene graph:** layers of kind text, shape (SVG path), media slot, group, mask, effect
  (glow, blur, grain, light leak), particles and device frame. Each layer has a transform, opacity,
  blend mode and an optional mask.
- **Animation:** keyframe tracks on any property, with easing (bezier) or spring. Text gets
  per-letter, per-word or per-line *animators*: one animation with a stagger. Markers name hit
  points for sound and beat sync.
- **Responsive layout:** positions and sizes in grid units, with per-shape overrides
  (section 6.4).
- **Version.** Old templates keep working because the player understands every earlier version.

### 6.2 The player

A `TemplateClip` on the timeline is rendered by a template player inside the existing WebGL2
compositor (`gfx.ts`):

- Shapes and masks are tessellated SVG paths drawn on the GPU.
- Text is laid out per glyph on a canvas atlas, so letters animate one by one.
- Effects are small shaders: glow, blur, grain, gradient sweep, light leak, chromatic offset.
- Motion blur takes N sub-frame samples, on export only.

Preview runs in real time at preview size. Export renders every frame at full size through the
existing pipeline (round 3: about real time at 1080p).

### 6.3 Text that stays beautiful

- **Fit rules per field:** shrink to fit within a range, then wrap to N lines, then ellipsis.
- **Balanced line breaks** (no single orphan word on a line).
- **Bangla:** letters are grouped into graphemes with `Intl.Segmenter`, so per-letter animation
  moves whole letters, never pieces of a conjunct. Shaping comes from the browser engine
  (HarfBuzz).
- **Numbers** (prices, percentages, counts) can count up, using the taka sign and lakh grouping
  from Wallet's formatting.

### 6.4 One design, every shape

The designer sets anchors and constraints in grid units, plus optional overrides per shape. 9:16
stacks vertically, 16:9 sets things side by side, and 1:1 and 4:5 sit in between. The browser
shows the template in the project's shape. There's a test that renders every template in every
shape and flags text running out of the safe area.

### 6.5 Brand Kits

- **Contents:** name, five colours (primary, secondary, accent, background, text), heading and
  body font, logo (light and dark versions), corner radius, motion feel, and optional default
  music and sounds.
- **Storage:** Studio's settings, plus a `.zazkit` file to share or back up. One kit can be the
  default for new projects.
- **Applying a kit** sets every bound field in the project's templates. Fields the user changed by
  hand stay as they are, and a "Reset to kit" button brings them back.
- **"Make a kit from my logo":** suggests a palette from the logo's colours.

### 6.6 My Templates

"Save as My Template" stores a template clip with its field values, font and colour choices and
any layer edits. Saved templates show in their own category, with rename, duplicate, delete and
export as `.zaztemplate`.

### 6.7 Helpers (optional, they use what's already there)

- **Cut out product:** Photo's AI Remove Background (round 3), run inside the media slot.
- **Write my copy (Claude, opt-in):** from a short product description, suggests a headline,
  three feature lines and a call to action, in English or Bangla, within each field's limits.
  It uses the Settings → AI key and consent from the Statements work, and nothing is sent without
  them.
- **Captions** on talking clips (round 3) take the Brand Kit's fonts and colours.

## 7. Where the templates come from ("designed by professionals")

1. **Designed in-house, to the rules in section 4.** The first collection is built in the format
   above, with a template editor, a development-only Studio tool: a timeline of a template's
   layers, keyframe curves, field bindings and a preview in all four shapes. Each template is
   reviewed against a checklist (timing, contrast, safe areas, Bangla, all shapes) before it ships.
2. **Optional: commissioned designers.** A motion designer can design in After Effects or Figma
   and hand over the template format, or Lottie for the animated parts (option 3). That needs a
   budget and a contract that grants redistribution (decision 1).
3. **Optional: Lottie import.** Lottie (an After Effects export, MIT-licensed player) layers inside
   a template. This opens up the user's own Lottie files and licensed packs. Many free Lottie
   files online carry licences that don't allow redistributing them inside an app, so the app
   only plays Lottie files the user adds and never bundles third-party ones without a licence
   (decision 2).

Market templates (Envato, Motion Array, Mixkit) can't be bundled: their licences allow using them
in your own videos, not redistributing them in software.

## 8. Performance targets

- The browser grid plays 12 previews at once, from pre-rendered looping WebM thumbnails rather
  than live renders.
- A template in the preview at 30 fps on the Intel GPU here at 540p, and at 60 fps for lighter
  ones.
- Export of a 15 s 1080×1920 template at or near real time (motion blur adds about 2× on fast
  parts).
- First use of a font: under 150 ms to load.

## 9. Milestones

| # | Milestone | Done when |
|---|---|---|
| T0 | **Engine**: template format v1, player (shapes, masks, glyph text with animators, springs, effects, motion blur on export), responsive layout, fit rules, Bangla graphemes | One hand-written template plays identically in preview and export in all four shapes |
| T1 | **Browser and fields**: Templates tab, live previews, Use Template, Inspector fields, media slots with Cut out product, length stretch, Ungroup, Save as Poster | A user makes a 15 s product reel from a template in under 3 minutes (timed walkthrough) |
| T2 | **Brand Kits and fonts**: the 25 bundled families with pairings, kits (create, apply, reset, default, share file, palette from logo), My Templates | Applying another kit restyles a 4-template project in one click and nothing hand-changed is lost |
| T3 | **The first 24 templates** across launch, sale, feature, logo, lower thirds and hooks, with sound hits and beat sync | Every template passes the design checklist in all four shapes |
| T4 | **The other 32 templates**: app promo with device mockups, fashion, food, real estate, testimonials, festive | The same checklist; a Bangla pass on all |
| T5 | **Optional**: template editor out of developer mode, Lottie layers, Write my copy with Claude | Decided with the user (section 12) |

## 10. Effort, roughly

T0 is the heavy part (the player and text engine). T1–T2 are mostly interface. T3–T4 are design
work. At about 2–3 hours per template done to the checklist, that's 100–170 hours for 56 if made
in-house. A commissioned designer would cut that, at cost.

## 11. Risks

- **Taste.** "Premium" is judged by eye. Plan for a review round with the user on the first six
  templates before making the rest.
- **Fonts and Bangla.** Per-letter animation can break conjuncts (handled by graphemes). Some
  display fonts have no Bangla, so the kit's Bangla font takes over automatically.
- **Performance on heavy templates.** Particles and motion blur are capped in preview and
  full-quality on export only.
- **Licences.** Only OFL fonts, our own artwork, and assets with redistribution rights are
  bundled. A licence list ships with the app.

## 12. Decisions (taken 2026-10-27)

1. **Who designs:** in-house, to the rules in section 4.
2. **Lottie:** no. Everything stays in the template format.
3. **The first six:** launch hero with light sweep and Cut out product; sale price slash with a %
   badge; three-up features; line-draw logo (an SVG's own paths, or an outline traced from a
   picture); lower third; reel hook with a follow end card.
4. **Language:** English defaults, everything Bangla-safe, and a Bangla preview switch.
5. **Fonts:** the list in section 5.
6. **Write my copy (Claude):** later.
7. **Posters:** Save as Poster in the Video Editor this round; templates in Photo later.

## 13. What's built

T0, T1 and T2, and the first six templates (decision 3), on 2026-10-27. Code in
`src/modules/studio/video/motion/`, the backend in `src-tauri/src/motion/`, tests in
`tools/motion.test.mjs` (`node --test tools/motion.test.mjs`) and `cargo test --lib motion::`.

**Engine (T0)**

- **Format v1** (`format.ts`): layers `rect`/`ellipse`, `path` (with line-draw), `text`, `image`
  (media slot, optional traced outline), `icon`, `group` and `fx` (grain, vignette, light leak,
  blobs, stripes, rays, progress bar, typing dots). Any property can be keyframed; layers can
  reveal behind a mask, glow, cast a shadow, take a light sweep, idle-drift, and show only when a
  slot is empty or filled. Fields are text, choice or media, each with English and Bangla defaults
  and a character limit.
- **Player** (`player.ts`): Canvas 2D, one canvas per template clip, uploaded as one compositor
  layer, so the preview and the export draw the same thing. Export adds motion blur (5 samples
  over a half-frame shutter, only while something moves) and waits for fonts and pictures.
- **Easing** (`ease.ts`): CSS-exact béziers, damped springs, and the three motion feels (Snappy,
  Smooth, Playful). Section 4's ease-out is the default.
- **Text** (`textfit.ts`): grapheme units that never split a Bangla conjunct, balanced wrapping,
  fitting that shrinks within a range and then adds an ellipsis, and number counters that keep
  the taka sign, Bangla digits and lakh grouping.
- **Layout** (`layout.ts`): frames per shape, safe areas (the Reels/TikTok zones in 9:16), and
  stretching. A longer or shorter clip changes only the hold; split clips keep one timeline across
  the cut.
- **Logos** (`svgsafe.ts`, `outline.ts`): an SVG logo is cut down to geometry before use (no
  script, events, links, outside files or styles) and measured without touching the page. A
  picture logo gets an outline traced by marching squares.

**Browser and fields (T1)**

- **Templates tab:** categories, search, shape and length filters, cards that play on hover in
  the project's shape and the default kit, a Bangla preview switch, and "Add suggested sounds"
  (round 3's effects at each template's hit points). One click adds the clip at the playhead.
- **Inspector:**
  - text and choice fields with counters;
  - picture slots with Choose, Clear and **Cut out product** (Photo's subject model, saved as a
    PNG next to the original);
  - sample text in English or Bangla;
  - Add suggested sounds, **Ungroup to layers** (texts and pictures become clips of their own;
    Regroup undoes it), **Save as Poster** (PNG or JPEG of the playhead's frame, or the middle of
    the hold), Save to My Templates and Export `.zaztemplate`;
  - the usual Position section with keyframes.

**Brand Kits and fonts (T2)**

- **Fonts:** 29 OFL families bundled in `public/fonts/` (63 files, 11 MB, pinned by
  `tools/fetch_motion_fonts.py` with SHA-256s in `fonts.lock.json`), loaded when first used, with
  9 pairings.
- **Kits:** five built-in kits (Midnight, Sunrise, Mono Luxe, Fresh Mint, Tech Blue) and the
  user's own. In the Brand Kits dialog you can create, copy, edit, delete, set the default, apply
  to the selected template or to all, take colours from a logo, and import or export `.zazkit`.
  Parts changed by hand on a clip are marked and kept when a kit is applied; Reset to kit clears
  them.
- **My Templates:** saved with their texts, look and pictures (kept in the app data folder),
  with rename, delete, and import and export of `.zaztemplate`.

**The six templates:** Product Hero (launch, light sweep), Price Drop (strike, counter, % badge),
Feature Trio (columns in 16:9, rows elsewhere), Line Logo (SVG paths or a traced outline;
emblem without a logo), Name Bar (lower third, overlay) and Hook + Follow (hook, circle wipe,
follow card). Each works in all four shapes, inside the safe areas (tested), with Bangla
defaults.

**Smoke test** (2026-10-27, debug build on a nested display with software WebGL):

- All six templates were checked mid-animation in 9:16 and 16:9, with Price Drop in Bangla.
- Sunrise was applied to every template from the Brand Kits dialog, and the project was saved
  and reopened.
- Save as Poster wrote a 1920×1080 PNG.
- A 60 s, 1080p30 H.264 MP4 of all six templates exported in 239 s (0.25× real time, motion blur
  on). Its frames matched the preview.

The tests:

- `node --test tools/motion.test.mjs`: 25 passing. They cover easing and springs, Bangla
  grapheme units, fitting and numbers, safe areas for every template in every shape, Brand Kit
  apply and reset, kit files, the template, package and project round trips, split and stretch
  timing, and malicious SVG samples.
- `cargo test --lib`: 352 passing, 6 of them motion's. Those cover package round trip, entry
  names, size limits, and only `.zaztemplate`/`.zazkit` files that aren't links.

**Left for later**

- The template editor (section 7), and pre-rendered WebM thumbnails (section 8). The cards
  render live, which is fine for six.
- Fonts from the user's files, and subsetting the bundled fonts (fontTools isn't installed:
  11 MB rather than about 6).
- Beat sync ("Match to music") and whole-video sequences.
- Templates in Photo (decision 7), and Write my copy (decision 6).
- Dragging templates onto the timeline. Today it's the card's click.
- WebKitGTK has no canvas `filter`, so blur falls back to scaling down and up. That's coarse on
  small soft shapes such as the hero's floor shadow.
- T3–T4: the other templates.
