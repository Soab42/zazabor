# Motion rule book: professional marketing videos and reels

*For the designers of Zazabor's motion templates (Studio → Video Editor → Templates). Written
2026-10-27. It complements [`motion-templates.md`](motion-templates.md) §4 with numbers and ends
with a QA checklist (§13).*

**Tags.** **[P]** is a platform or standards rule. **[R]** is measured research. **[C]** is a
convention (practitioner consensus, not measured). **[D]** is derived here from the sources.
**Sources disagree** marks open conflicts. Units follow `format.ts`: **S** is the canvas short
side (1080 px in every 1080-wide export), and **f** is a frame at 30 fps (33 ms).

## 0. The rules that matter most

1. **Frame 0 is the hook and the thumbnail.** In ads and reels, the headline or subject is legible
   on the first frame. Fades from black belong to logo stings.
2. **Critical text sits in the strict 9:16 band:** x 65–950 and y 269–1248 px on 1080×1920 (§4).
3. **Text size floors:** 0.036 S for any text people must read, 0.044 S for body and CTA, and
   0.07 S or more for headlines. Never below 0.028 S (§5.1).
4. **Reading time:** 0.5 s + characters ÷ 15. Never faster than 20 characters/s in English or 22
   in Bangla.
5. **One focal point per beat, one signature move per template.** Everything else is quieter.
6. **Backgrounds live at the edge of notice:** 8–20 s cycles, drift ≤ 3% of the width per second,
   and calm luminance behind text (§3).
7. **Contrast is checked on the worst frame:** WCAG 4.5:1 or 3:1, plus APCA on dark themes.
8. **Decelerate in, accelerate out.** Linear only for loops. Springs drive position and scale,
   never opacity or colour.
9. **Cut on the beat.** Sound hits land on the impact frame or one frame after, never before.
10. **Bangla:** no tracking, uppercase, italic or underline. Animate by syllable; line height
    1.5 or more.
11. **Works muted and with sound:** the offer reads on screen, and the sound design is still done.
12. **Bundle only our own work, CC0, OFL, MIT, ISC or Apache.** Make the rest procedurally.

## 1. Professional vs amateur: the tells

| Amateur tell | The pro fix |
|---|---|
| Linear or default easing everywhere, which Val Head calls one of the most telltale beginner mistakes ([Val Head](https://valhead.com/?p=3469)) | Ease out on entrances, ease in on exits, springs for settles (§6) |
| Everything enters at once, so there's no reading order | Stagger 60–140 ms in reading order, with the hero first |
| The same duration for small and big things | Duration grows with distance and size ([Material](https://raw.githubusercontent.com/material-components/material-components-android/master/docs/theming/Motion.md); [Carbon, 2026-08-12](https://carbondesignsystem.com/elements/motion/overview/)) |
| A flat fill or a static stock gradient: a slide, not a film | A layered, slowly living background (§3) |
| 3+ fonts and 4+ weights | 2 families and 3 weights; "minimize the number of typefaces" ([Apple HIG, 2025-12-16](https://developer.apple.com/design/human-interface-guidelines/typography)) |
| Text crowding the edges and covered by the platform UI | The safe band (§4); gaps of 0.04 S or more between blocks |
| Text that never rests (constant pulsing) | In, rest, out. Idle drift ≤ 3% over the hold |
| Big outer glows, lens flares on type | Glow only on light sources, tinted by the kit, ≤ 0.03 S, ≤ 40% |
| Hard shadows in random directions | One `light` per template; soft shadows (0.03–0.08 S) |
| Stepped fast moves | Motion blur at a 180° shutter (half a frame, as the player does) |
| Dissolves between unrelated graphics | Cut, wipe or match (§8) |
| Effects stacked (grain + leak + glitch + shake) | One look and one signature move |
| Cuts off the music's grid | Quantise cuts and hits to the beat (§6.4) |
| A pure #000 base with saturated neon text | A deep base tinted by the brand, desaturated accents ([Material dark theme](https://m2.material.io/design/color/dark-theme.html)) |

## 2. Trends 2025–2026

The trend sources are trade blogs ([Videobolt, 2025-12-11](https://blog.videobolt.net/post/top-motion-graphics-trends-2026);
[Graphic Design Junction, Jan 2026](https://graphicdesignjunction.com/2026/01/video-and-motion-creative-trends-2026/);
[Motionographer, 2024-12-10](https://motionographer.com/2024/12/10/motionographers-crystal-ball-2025-motion-design-predictions-part-1/)).
They agree on one shift: crafted, tactile, human-feeling work over generic "AI-smooth" output.
All rows are **[C]**.

| Trend | Fits | Overused / wrong when | In our engine |
|---|---|---|---|
| Kinetic type as the main visual | Hooks, sale, launch intros, quotes | Words never rest long enough to read | Animate by word or line; one emphasis word per line |
| Mesh / grainy gradients | Tech, app, launch, festive | Rainbow hues, banding, the same gradient everywhere | `mesh`/`aurora` + grain 2–3% |
| Glass / Liquid Glass ([Apple, 2025-06-09](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/)) | App promo, feature cards, lower-third plates | Over a flat colour (it reads as a grey box), or on everything. "Use Liquid Glass effects sparingly" ([HIG Materials, 2025-09-09](https://developer.apple.com/design/human-interface-guidelines/materials)) | `glass` with `over: true` above a living layer; 1–3 panels |
| 3D / pseudo-3D | Product reveals, turntables, devices | Spinning with no reason; inconsistent light | `turnY` ≤ 25° for a showcase, ≤ 12° for cards |
| Bento / modular grids | Feature summaries, specs, "3 reasons" | Every scene a bento; critics say it has peaked ([Webdesigner Depot](https://webdesignerdepot.com/what-is-the-bento-ui-trend-and-how-can-you-get-started)) | One hero cell at 2× area; 90–140 ms card staggers |
| Maximal (collage, cutouts, torn paper) | Fashion drops, youth, festive, hooks | Corporate, real estate, testimonials | Paper shapes; motion stepped at 12 fps ("on twos") |
| Minimal | Luxury, real estate, logos | When the product photo is weak | Few layers, long eases, 30–50% empty space |
| Brutalist type | Streetwear, music, tech hooks | Luxury, food, finance | Heavy grotesk, hard cuts, thick rules |
| Film grain / analog texture | Fashion, food, luxury | Over 4%; on UI screens | `grain` 2–3%, coarse (≥ 1.5 px) |
| Light leaks | Fashion, festive, logos | On tech; over text; more than 2 per video | `leak` in kit colours, ≤ 60% opacity |
| Motion-blurred whips | Sale, hooks, food, fashion | Every transition; whips in both directions | One direction per video, 8–12 f |
| Morphing shapes | Logos, feature continuity, app | Blob to blob with no meaning | `morph` between related shapes (button → card) |
| Cinematic product reveal | Launch, luxury, hardware | Hooks that must land in 1 s | `rays` + `drift`, `sheen`, slow `idle` scale |

## 3. Living backgrounds

Build the background as a stack of slow, independent layers that stays below the text in both
contrast and motion. **[C]** unless cited.

| Layer | Job | Engine | Speed | Limits |
|---|---|---|---|---|
| 1. Base field | Colour, mood | `mesh`, `waves`, `aurora` | 12–20 s cycles; ≤ 2% of the width per second | Luminance range ≤ 25 L* across the frame |
| 2. Light / mid shapes | Depth, direction | `rays`, `glass`, `bokeh` (`over: true`) | 1.5–2× the base; 8–15 s | ≤ 50% opacity, clear of text boxes |
| 3. Particles | Parallax, life | `drift`, `dust`, `sparks` | 2–4× the base | ≤ 0.01 S each, ≤ 40 visible, mostly out of focus |
| 4. Finish | Stops banding, adds film | `grain`, `vignette` | Grain refreshed at 12–24 fps | Grain 2–3%; corners ≤ 25% darker |

- **Parallax:** far, mid and near layers move at about 1 : 2 : 4. Blur runs the other way: far
  0.02–0.04 S, mid 0.01 S, near sharp or as soft bokeh.
- **No regular bobbing.** Apple warns against sustained oscillation, especially around 0.2 Hz
  (a 5 s period) ([HIG Motion, 2025-09-09](https://developer.apple.com/design/human-interface-guidelines/motion),
  visionOS note). Use noise-driven motion, or cycles of 8 s or more.
- **Loops:** the clip length is a whole number of background cycles, or the background phase
  is continuous across the loop. **[D]**
- **Calm behind text:**
  - Behind each text box, the luminance stays within about ±8 L* over the whole clip, and the
    background's local contrast stays below the text's.
  - Otherwise add a soft radial darkening (0.3–0.5 S). Apple suggests "a dark dimming layer of
    35% opacity" over bright content ([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)).
- **Colour:**
  - Use two or three kit colours, adjacent within about 60° of hue, over a dark base.
  - Interpolate in OKLab/OKLCH so the midpoints don't go grey ([CSS Color 4](https://www.w3.org/TR/css-color-4/#interpolation)).
- **Energy by category:**
  - 0.5× for luxury, real estate and testimonials;
  - 1× for launch, feature and app;
  - 1.5× for sale and hooks.
- **Banding and grain:**
  - Dark gradients band in 8-bit H.264, and grain dithers them ([CSS-Tricks, 2021-09-13](https://css-tricks.com/grainy-gradients/)).
  - Grain is costly to encode: Netflix cut its average bitrate by about 30% by sending grain as
    metadata ([Broadband TV News, 2025-07-04](https://www.broadbandtvnews.com/2025/07/04/netflix-film-grain-synthesis-saves-on-the-bitrate/)).
  - Keep grain coarse and subtle so the platform's re-encode doesn't smear it.
- **Variety:** no two templates in a category share both a base and a mid preset.

## 4. Composition and layout

### 4.1 Safe areas (1080×1920 pixels)

| Platform | Top | Bottom | Sides | Source |
|---|---|---|---|---|
| Reels (Instagram, Facebook) | 14% = 269 | 35% = 672 | 6% = 65 each | [Meta Reels guide](https://www.facebook.com/business/ads-guide/update/image/instagram-reels) (an image-ad page; Meta's video checker files are dated 2023-08-24) **[P]** |
| Stories | 14% ≈ 250 | 20% ≈ 340 | — | [Meta Stories guide](https://en-gb.facebook.com/business/ads-guide/update/video/instagram-story) **[P]** |
| YouTube Shorts | 10% = 192 | 25% = 480 | 10% = 108 on the right | [Google](https://business.google.com/us/ad-solutions/youtube-ads/shorts-ads/) **[P]** |
| TikTok | No published numbers | — | Action rail on the right | The zone "is determined by … the ad caption length"; use TikTok's zone files ([TikTok, Jul 2025](https://ads.tiktok.com/help/article/tiktok-reservation-in-feed-ads-reach-frequency?lang=en)) **[P]** |
| **Zazabor strict** | **269** | **672** | **65 left, 130 right** | The union of the above, with 12% on the right for TikTok's rail **[D]** |

- **Critical content** (headline, price, CTA, logo, QR code) goes in x 65–950, y 269–1248.
  **Secondary text** may go down to y 1440 and risk a long caption covering it. Only decoration
  and the background go further out.
- **Other shapes:**
  - 1:1 and 4:5 keep a 5% margin.
  - 16:9 uses EBU graphics-safe, 5% per edge (96 × 54 px), or action-safe 3.5% for web-only
    ([EBU R 95 v1.1, 2017](https://tech.ebu.ch/publications/r095)).
- **Sources disagree:** third-party Shorts and TikTok templates vary by up to 2×. Platform pages
  win.

### 4.2 Grid, focal point, hierarchy [C/D]

- **Grid:** 6 columns inside the 9:16 safe box, 8 in 1:1 and 4:5, 12 in 16:9. Gutter 0.03 S,
  baseline unit 0.01 S.
- **Focal point in 9:16:** it sits on the upper third (y ≈ 0.33–0.42 H), because the bottom
  third belongs to the platform. The vertical thirds still place the subject against its
  negative space. Headlines go above or below the product, never across it.
- **Negative space:** 30–50% of the safe box in launch, luxury and real estate; 15–25% in sale
  and hooks.
- **Hierarchy:** at most three levels on screen at once. Headlines are 2–3× the body; Apple's
  Large Title / Body is 34/17 = 2× ([HIG](https://developer.apple.com/design/human-interface-guidelines/typography)).
  A 1.25 scale is fine if the levels shown together are two or more steps apart.

## 5. Typography in motion

### 5.1 Size floors [D]

A 1080-px frame shown full width on a 393-pt phone (iPhone 15/16 width) gives about 2.75 px per pt. That holds in
S units for 9:16, 4:5, 1:1 and full-screen 16:9. Only 16:9 letterboxed in a vertical feed is
1.78× smaller.

| Role | Floor | Pixels at 1080 | Basis ([HIG](https://developer.apple.com/design/human-interface-guidelines/typography)) |
|---|---|---|---|
| Never below | 0.028 S | 30 | iOS minimum 11 pt |
| Details, legal | 0.036 S | 39 | ≈ 14 pt: a step above Footnote (13 pt), because video text moves and is seen briefly |
| Body, CTA, price labels | 0.044 S | 47 | Body 17 pt (default) |
| WCAG "large" (3:1 allowed) | 0.061 S, or 0.048 S bold | 66 / 51 | 24 CSS px (18.66 bold) × 2.75 |
| Headline | 0.07–0.12 S | 76–130 | Large Title 34 pt = 0.087 S |

- **Weights:** Regular to Bold. "Avoid light font weights" at small sizes (HIG).
- **Line length:** ≤ 42 characters, ≤ 2 lines for body text
  ([Netflix English TTSG, 2025-12-19](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide)).
  In 9:16, headlines run to 3 lines of 8–18 characters at most.
- **Tracking:**
  - Display type at 0.06 S or more: −1 to −3%.
  - Eyebrow labels: +8 to +20%, never +40%.
  - Bangla: always 0.

### 5.2 Reading time

| Source | Rate |
|---|---|
| Adult silent reading | 238 words/min ≈ 4 words/s ([Brysbaert, *J. Memory & Language*, 2019](https://www.Gwern.net/doc/psychology/linguistics/2019-brysbaert.pdf)) **[R]** |
| Netflix subtitles | ≤ 20 characters/s English, ≤ 22 Bangla ([Bangla TTSG, 2025-07-04](https://partnerhelp.netflixstudios.com/hc/en-us/articles/4483351778963-Bangla-Timed-Text-Style-Guide)); ≥ ⅚ s per subtitle **[P]** |
| TikTok ads | "5-10 words per second when using text" ([TikTok, Jun 2025](https://ads.tiktok.com/help/article/creative-best-practices?lang=en)) **[P]** |

**Sources disagree:** TikTok's rate is 1.3–2.5× faster than measured reading. It works for punch
words, not sentences.

**Rule [D]:** count from when the text becomes legible (about 70% through its entrance) to the
start of its exit.

- **Comfortable** (the designed default): 0.5 s + characters ÷ 15.
- **Floor:** 0.3 s + characters ÷ 20 in English (÷ 22 in Bangla), and at least 1.5 s.

A 35-character headline needs 2.8 s comfortable, or 2.05 s at the floor.

### 5.3 Animation unit

| Unit | Use for | Stagger |
|---|---|---|
| Letter | 1–2 words of ≤ 14 graphemes: hero words, prices, logos | 18–35 ms, ≤ 450 ms in all |
| Word | Headlines of 2–8 words (the default) | 60–90 ms |
| Line | Sentences, quotes, titles (rising from behind the baseline) | 100–150 ms |
| Block | Paragraphs, legal | None; it moves as one |

Cap any group's total stagger at about 600 ms, then switch to a coarser unit. Fluent's advice is
"short offsets", and no stagger for very large sets ([Fluent 2](https://fluent2.microsoft.design/motion)).
Use one display or serif face with one neutral sans, never two display faces.

### 5.4 Bangla

- **The unit is the orthographic syllable.** A conjunct "should be treated as an indivisible
  unit" ([W3C Bengali Layout Requirements, 2024-07-09](https://www.w3.org/TR/2024/DNOTE-beng-lreq-20240709)).
  `textfit.ts` already merges virama clusters.
- **No tracking.** Spacing breaks the headstroke (matra). Android's text engine turns
  letter-spacing off for Bengali ([Minikin](https://android.googlesource.com/platform/frameworks/minikin/+/e8721b2%5E%21/)),
  and the W3C says any spacing must fall at syllable boundaries ([ISSUE-334, 2014](https://www.w3.org/International/track/issues/334)).
- **No other Latin emphasis.** Emphasise with weight, size, colour or a marker swipe instead of:
  - uppercase (Bangla has no case);
  - italic: "Do not use italics" (Netflix Bangla TTSG);
  - underline: "not traditional" (W3C).
- **Line height 1.5–1.7**, against 1.1–1.25 for Latin display. Masks need 0.1 em of padding for
  the reph and the stacks below the line. **[C]**
- **Danda and digits:** the danda (।) never wraps alone; use the real double-danda character
  (॥) (W3C). Prices use Bangla digits and lakh grouping, which `textfit.ts` already does.
- **Size:** set Bangla 5–10% larger than Latin at the same nominal size. **[C]**
- **Faces:**
  - Anek Bangla and Hind Siliguri: sans.
  - Tiro Bangla: editorial serif.
  - Baloo Da 2: rounded.
  - Galada: festive headlines only.

## 6. Timing and easing

### 6.1 Durations

UI tokens run from 50 to 1000 ms, and duration should grow with the area or distance a move
covers ([Material](https://raw.githubusercontent.com/material-components/material-components-android/master/docs/theming/Motion.md)).
Carbon's slow tokens are 400 and 700 ms, and it reserves expressive motion for "occasional,
important moments" ([Carbon](https://carbondesignsystem.com/elements/motion/overview/)). Video graphics are
full-frame scale, so they sit at the long end. **[D]**

| Move | Duration | Frames at 30 fps |
|---|---|---|
| Micro (tick, badge settle) | 150–250 ms | 5–8 |
| Word, chip or icon entrance | 300–500 ms | 9–15 |
| Headline or card entrance | 500–800 ms | 15–24 |
| Hero reveal, full-frame wipe | 800–1500 ms | 24–45 |
| Exit | 50–70% of the entrance | 6–12 |
| Scene transition | 0 (a cut) or 250–600 ms | 0 / 8–18 |
| Logo | Build 1.5–3 s, then hold still ≥ 1.5 s | — |
| Idle in a hold | +2–5% scale over the whole hold | — |

Nothing is shorter than 4 f except cuts, impact frames and glitches.

### 6.2 Curves and springs

| Use | cubic-bezier | Source |
|---|---|---|
| Entrance (house default) | (0.16, 1, 0.3, 1) | Plan §4 |
| Entrance, softer | (0.05, 0.7, 0.1, 1) | M3 emphasized decelerate **[P]** |
| Exit | (0.3, 0, 0.8, 0.15) | M3 emphasized accelerate **[P]** |
| Exit, expressive | (0.4, 0.14, 1, 1) | Carbon **[P]** |
| A to B on screen | (0.2, 0, 0, 1), or (0.4, 0.14, 0.3, 1) for expressive | M3 standard / Carbon **[P]** |
| Loops, marquees, rotation | linear | Fluent **[P]** |

**Springs.**

- Material gives spatial springs damping 0.9 at stiffness 1400, 700 or 300 (fast, default,
  slow). Its *effects* springs (opacity and colour) use damping 1.0, so they never overshoot
  ([Motion.md](https://raw.githubusercontent.com/material-components/material-components-android/master/docs/theming/Motion.md)).
- Apple's springs take a duration of 0.5 s and a bounce of 0, 0.15 or 0.3 ([WWDC23](https://developer.apple.com/videos/play/wwdc2023/10158/)).
- Overshoot is exp(−ζπ/√(1−ζ²)). By feel:
  - Smooth: ζ ≈ 1 (0%).
  - Snappy: ζ 0.8–0.9 (0.2–1.5%).
  - Playful: ζ ≈ 0.5 (about 16%).

### 6.3 Overlap, follow-through and the 12 principles [C]

- **Offset:** children start 60–120 ms after their parent. Plates lead their text; products lead
  their shadows.
- **Follow-through:** tags, ribbons and badges settle 80–200 ms after the main body.
- **Overlap:** the next element starts when the previous one is about 70% done.

Willenskomer argues that only easing transfers fully from Disney's 12 principles to UI
([Adobe, 2016-11-08](https://blog.adobe.com/en/publish/2016/11/08/redesigning-the-12-principles-of-animation-for-motion-design)).
In graphics:

- **Squash:** 3–8% on impacts.
- **Anticipation:** a 2–4 f pull-back before whips and slams.
- **Staging:** one focal point per beat.
- **Arcs:** anything travelling more than 0.3 S curves slightly or rotates 2–6°.
- **Secondary action:** sheen, background drift, shadows that track the light.
- **Exaggeration:** the Playful feel, hooks and sale only.
- **Solid drawing:** one light and one perspective.
- **Appeal:** restraint.

### 6.4 Beat-matched cutting

A beat lasts 60 ÷ BPM seconds.

| BPM | Beat | Frames at 30 fps | 4/4 bar |
|---|---|---|---|
| 90 | 0.667 s | 20 | 2.67 s |
| 100 | 0.600 s | 18 | 2.40 s |
| 120 | 0.500 s | 15 | 2.00 s |
| 128 | 0.469 s | 14.06 | 1.88 s |
| 140 | 0.429 s | 12.9 | 1.71 s |

- **Cut every** (micro-hits may fall on half beats) **[C]**:
  - 2 beats for sale and hooks;
  - 1 bar for launch, feature and app;
  - 2 bars for luxury and editorial.
- **Quantise from absolute time:** frame = round(n × 60/BPM × fps). Adding rounded beats one
  after another drifts a frame every 16 beats at 128 BPM. **[D]**

## 7. Pacing for short-form

- **Hook in the first 3 s:**
  - TikTok: "introduce your content proposition in the first 3 seconds" and "prioritize your
    hook in the first 6 seconds" ([TikTok, Jun 2025](https://ads.tiktok.com/help/article/creative-best-practices?lang=en)).
  - Meta: key message or branding within 3 s ([Meta](https://www.facebook.com/business/ads/automation/tailored-campaigns)).
  - Google: "hook viewers in the first few seconds" ([Google](https://business.google.com/us/ad-solutions/youtube-ads/shorts-ads/)).
  - A Meta and Nielsen study found up to 47% of campaign value in the first 3 s and 74% in the
    first 10 s ([Marketing Dive](https://www.marketingdive.com/news/facebook-offers-tips-for-converting-tv-ads-to-mobile/448510/),
    c. 2016) **[R, dated]**.
- **Brand early:** "early, often, and richly". Ads following Google's ABCDs showed a 30% lift in
  short-term sales likelihood ([Think with Google, Apr 2022](https://business.google.com/us/think/future-of-marketing/youtube-video-ad-creative/),
  Kantar 2021) **[R]**. Show the product or logo by 2 s and again at the end.
- **Scene length:** 1–2.5 s for picture beats, 2–4 s for text beats (§5.2), nothing under 0.5 s
  except flashes. **[C]**

| Goal | Total length | Source |
|---|---|---|
| Logo sting | 3–6 s | **[C]** |
| Standard Reels or TikTok ad | 9–15 s | TikTok in-feed recommends 9–15 s ([Jul 2025](https://ads.tiktok.com/help/article/tiktok-reservation-in-feed-ads-reach-frequency?lang=en)); Meta: "15 seconds or less" ([Meta](https://www.facebook.com/business/news/want-to-better-video-ads-for-mobile-well-show-you-how)) **[P]** |
| Conversion on Shorts | 10–30 s | [Google Ads Help](https://support.google.com/google-ads/answer/16041697?hl=en) **[P]** |
| Product story | 20–45 s | Shorts plays only the first 60 s in the feed (same page) **[P]** |
| Lower third | 4–6 s held | **[C]** |

- **CTA:**
  - It holds still and readable for 2 s or more at the end.
  - It sits above y 1248, because Meta's CTA button covers the bottom.
  - Add a soft mid-roll CTA in videos over 20 s.
- **Loops:** the last frame composes into the first, and the cut lands on a beat. End screens
  hold for 3 s or more.
- **Captions and sound. Sources disagree.**
  - The muted case:
    - 69% watch with sound off in public, and 80% say captions make them likelier to finish
      (self-reported, Verizon Media and Publicis, April 2019, via [3Play Media](https://www.3playmedia.com/blog/verizon-media-and-publicis-media-find-viewers-want-captions/));
    - captions added about 12% view time in Meta's tests ([Meta](https://www.facebook.com/business/news/want-to-better-video-ads-for-mobile-well-show-you-how)).
  - The sound-on case:
    - Reels play with sound on by default ([Meta](https://www.facebook.com/business/ads/facebook-instagram-reels-ads));
    - Shorts is a "sound-on environment", and sound lifts conversions by over 20% (Google, above);
    - 88% of TikTok users call sound vital (Nielsen 2020, via [TikTok, 2021-12-21](https://ads.tiktok.com/business/en-US/blog/evolution-of-sound-volume-1)).
  - **Rule:** the offer reads muted, and the sound is finished too.

## 8. Transitions

| Transition | Duration | Fits | Keep it from looking cheap |
|---|---|---|---|
| Cut on the beat | 0 | Everything (the default) | Cut to a new size or angle |
| Match cut | 0–200 ms | Launch, logo, feature | Silhouettes aligned within about 5% of the frame |
| Whip with motion blur | 8–12 f, blur peaking at the cut ([PremiumBeat](https://www.premiumbeat.com/blog/create-whip-pan-using-built-effects-premiere-pro/); [No Film School](https://nofilmschool.com/2017/09/5-steps-create-perfect-whip-pan-transition)) | Sale, hooks, food, fashion | One direction per video; blur only along the motion |
| Mask or shape wipe (iris, diagonal, the logo's shape) | 300–600 ms | Launch, sale, lower thirds | Brand-derived shapes; soft edge 0.01–0.02 S |
| Zoom-through | 400–700 ms | App, hooks, logo | Accelerate in, decelerate out; radial blur at the peak |
| Morph / shared element | 400–800 ms | Feature, app, testimonials | Only between related shapes |
| Light leak / flash | 300–800 ms | Fashion, luxury, festive | Kit-tinted, ≤ 60%; ≤ 3 flashes in any second ([WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)) |
| Luma dip | 400–800 ms | Luxury, real estate, testimonials | Dip to the kit's deep colour, not #000; never in an ad's first 3 s |
| Glitch / RGB split | 2–6 f | Tech, hooks | Once per video at most |
| Speed ramp | Ramp over 6–12 f | Turntables, food, fashion | Ramp into the cut, ease out after |
| Push / slide | 400–600 ms | Carousels, testimonials | The whole layout moves as one plane, with blur |
| J/L-cut (sound) | Audio leads or trails by 4–12 f ([J cut](https://en.wikipedia.org/wiki/J_cut)) | Anything with a voiceover or music change | Whooshes start 2–6 f early |

Never use page curls, cube spins, star or heart wipes, checkerboards, or random 3D flips. **[C]**

## 9. Colour

- **Roles:** about 60% base, 30% secondary and surfaces, 10% accent. The accent is reserved for
  the CTA, the price and one highlight. **[C]**
- **Dark themes:**
  - Use a deep, brand-tinted base, not black. Material uses #121212 with about 8% primary
    overlay.
  - Desaturate accents: saturated colours fail 4.5:1 on dark ([Material](https://m2.material.io/design/color/dark-theme.html)).
- **Light themes:** avoid white fields under the platform's white UI. TikTok warns its text
  becomes unreadable ([TikTok, Jul 2025](https://ads.tiktok.com/help/article/tiktok-reservation-in-feed-ads-reach-frequency?lang=en)).
- **Contrast:**
  - WCAG 2.2 requires 4.5:1 for text, 3:1 for large text (§5.1) and 3:1 for essential shapes
    **[P]**.
  - On dark themes, also pass APCA: Lc 75 for body, 60 for other readable text, 45 for large
    headlines. Its authors say WCAG 2 overstates contrast for dark colours
    ([APCA](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html); a draft WCAG 3
    candidate).
  - **Sources disagree:** WCAG 2 and APCA can disagree on a pair. Ship only pairs that pass both.
- **Premium grade [C]:**
  - Low overall chroma with one saturated accent.
  - Blacks lifted about 2–4%, never crushed.
  - Shadows tinted by the brand; bloom only on real light sources.
  - Food and skin stay warm.
  - No teal-and-orange on products.

## 10. Sound design

- **Sync:**
  - A whoosh starts 2–6 f before its move and peaks at the fastest frame.
  - A hit lands on the impact frame or one frame after.
  - Early audio is noticed first: detection runs from +45 ms (audio early) to −125 ms (late)
    ([ITU-R BT.1359, 1998](https://itu.int/dms_pubrec/itu-r/rec/bt/R-REC-BT.1359-0-199802-S!!PDF-E.pdf)) **[P]**.
- **Vocabulary:** three or four sounds per template **[C]**:
  - a whoosh for wipes and whips;
  - a hit or boom for the reveal;
  - a pop or click for badges and UI;
  - a shimmer for the sheen.
- **Risers and whooshes:** a riser of 1, 2 or 4 bars ends exactly on the reveal; a whoosh lasts
  only as long as its move.
- **Levels [C]:** duck the music 6–12 dB under a voiceover, keep effects peaking 6–10 dB under the
  music's peaks, and don't put a sound on every element.
- **Loudness:**
  - Master to **−14 LUFS integrated, ≤ −1 dBTP**. That's Spotify's published target
    ([Spotify](https://support.spotify.com/us/artists/article/loudness-normalization/)) and the
    de facto social target.
  - Meta, TikTok and YouTube publish none, so for video this is **[C]**.
  - AES TD1008 (2021) suggests −16 to −18 LUFS for streams but excludes sound with picture
    ([Production Expert](https://www.production-expert.com/production-expert-1/aes-update-loudness-recommendations-for-audio-only-streaming)).

## 11. Assets and licensing

**What the collection needs:**

- shapes and masks;
- line icons;
- textures (paper, grain, dust);
- light leaks, bokeh, rays;
- particles;
- grades and LUTs;
- device frames;
- product stand-ins;
- festive motifs (alpona, crescent, lantern, marigold);
- sound effects (whoosh, hit, pop, click, riser, shimmer);
- music beds;
- fonts.

**Make them procedurally first.** Shaders and vectors carry no licence risk, fit every shape,
take the kit's colours and weigh almost nothing. `background.ts`, `art.ts` and the fx layers
already do this. Make LUTs as parametric grades (lift, gamma, gain, split-tone), and synthesise
whooshes and risers from filtered noise sweeps.

### Can be bundled in the app

Keep each licence file in the app's licence list.

| Type | Source | Conditions |
|---|---|---|
| Fonts | [Google Fonts](https://fonts.google.com/) OFL families | Bundling in commercial software is allowed. Include the copyright and licence; the font can't be sold alone; a subset is a modified version and can't use Reserved Font Names. Videos made with the fonts are unaffected ([OFL-FAQ 1.1-update7, page 2026-01-12](https://openfontlicense.org/ofl-faq/)) |
| Icons | Lucide (ISC), Tabler (MIT), Phosphor (MIT), Material Symbols (Apache 2.0) | Keep the notice. Today's `icons.ts` set is our own |
| Textures, HDRIs | [Poly Haven](https://polyhaven.com/license), [ambientCG](https://docs.ambientcg.com/license/) | CC0: "even in a product you sell" |
| Sound effects | [Kenney](https://kenney.nl/support) audio (CC0); [Freesound](https://freesound.org/help/faq/) filtered to CC0 | Check each Freesound file. CC BY needs credit; BY-NC forbids commercial use |
| Shaders | Our own code | Shadertoy code defaults to **CC BY-NC-SA 3.0** ([three.js manual](https://threejs.org/manual/en/shadertoy.html); confirm at shadertoy.com/terms). Don't paste it in |

### Only for the user's own videos

Don't bundle any of these.

| Source | Why not |
|---|---|
| Envato Elements | Items "must not be redistributed … in tools or templates"; one licence per project ([Envato](https://help.elements.envato.com/hc/en-us/articles/360000628966-License-Terms)) |
| Mixkit | You may not "rent, license, sublicense, sell" its items ([Mixkit](https://mixkit.co/llm-info/)) |
| Pexels | "Don't redistribute or sell … on other stock photo or wallpaper platforms" ([Pexels](https://www.pexels.com/license/)) |
| Unsplash | No right "to compile images … to replicate a similar or competing service" ([Unsplash](https://unsplash.com/license)) |
| Pixabay | No selling or distributing "on a Standalone basis" ([Pixabay](https://pixabay.com/service/license-summary/)) |
| LottieFiles (free) | Same-terms redistribution only, and no compiling into a rival service ([Lottie Simple License, 2021](https://lottiefiles.com/page/license)). Plan decision 2 already excludes Lottie |
| Sonniss GDC bundles | Fine inside finished work, but not "inside a sound library, sample pack, asset pack" ([Sonniss](https://sonniss.com/gameaudiogdc/)) |
| Motion Array, Meta Sound Collection, YouTube Audio Library | Subscription or platform licences (not checked here; treat them as not bundle-safe) |

Correction to the brief: Google Fonts under OFL *is* bundle-safe.

## 12. Category playbooks [C]

The **signature** move is what makes each category look premium.

| Category | Look (palette · background · type) | Motion · transitions · sound | Signature |
|---|---|---|---|
| Product launch | Deep base and one light · `rays` + `drift` or a slow `mesh` · big grotesk, tight tracking | Mask reveals, slow push (1.00 → 1.05), sheen · match cut, zoom-through · riser into a sub-hit, shimmer | The product rises from darkness, a rim light sweeps it, then a fast push (600 ms) eases into a slow drift |
| Sale & offers | Accent against yellow or red, saturated or light base · `waves` or `grid` at 1.5× · condensed heavy display (Anton, Bebas), price at 0.25–0.35 S | Spring overshoot, counters, slams (3 f anticipation, 6% squash), shake ≤ 6 px · cuts every 2 beats, whips · 120–128 BPM, pops and an impact | Price slam: the old price strikes through in 150 ms, the new one drops with overshoot, confetti fires on the settle frame |
| Feature highlight | Neutral surface with the accent · calm `mesh` or `grid` · geometric sans, icon + 2–4 words | Card staggers, call-out lines drawing, counters · push or morph · 100–115 BPM, soft clicks | Shared-element morph: the card just read becomes the next scene's frame |
| App & tech | Dark with neon, or light iOS-like · `glass` over `mesh`, `grid` · Inter, Space Grotesk | Device float (≤ 2%), screen scroll, notifications on springs · zoom-through, one glitch at most · electronic 110–125 BPM, taps | Zoom through the phone screen into full-frame UI, with one glass card refracting the live background |
| Fashion & beauty | Cream, black or blush + one accent · paper or `aurora` at 0.5×, grain 3% · high-contrast serif + spaced small sans | 800–1200 ms eases, crop masks, split screens · cuts every 2 bars, a hairline-rule wipe, ≤ 2 leaks · deep house 115–122 BPM, shutter clicks | The image grows out of a thin slit behind a hairline rule; the headline is huge and partly behind the model |
| Food & restaurant | Tomato, saffron, cream, brown; never blue on food · warm `bokeh` or `waves` · friendly bold sans, one script word | Ingredient pops, steam particles, a swinging price tag · whips, top-down turns · acoustic or funk 95–115 BPM, sizzle | Ingredients burst around the hero dish, then settle into a slow orbit with a tiny bob |
| Real estate & services | Navy or charcoal with gold · soft `mesh`, architectural lines · clean sans, a serif for luxury | Ken Burns (1.00 → 1.08 over 5–6 s), floor plans drawing on, a map pin on a spring · push with blur, luma dip · piano 80–100 BPM | Two-plane photo parallax (1 : 0.6), then the map pin drops with a ripple |
| Testimonials | Light kit, white space · `aurora` at 0.5× · readable sans ≥ 0.05 S, giant quote marks | Quote word by word at reading speed, stars in sequence · carousel slides · soft music | A marker swipe in the accent colour across the key phrase, once the quote lands |
| Logo reveals | Kit deep colour · `rays`, `drift` or `glass` · logo + small tagline | Build 1.5–3 s, resolve, hold still ≥ 1.5 s · the one place to fade in from black · riser, hit, tail | Parts converge with motion blur, the last 10% of travel eases very slowly, then a light sweep |
| Lower thirds & titles | Overlay: a kit plate or glass, no full background · name 2× title | In 400–600 ms, hold ≥ 4 s, out 300 ms · optional soft swish | Three beats 120 ms apart: the plate wipes, the text rises from behind its baseline, a 1 px accent line draws on |
| Reel hooks & end screens | Bold `mesh` or `grid` at 1.5× · 1–7 huge heavy words in the safe band | Legible on frame 0, zoom punches on the beats · smash cuts, zoom-through, whips · 120–140 BPM, impact on frame 0; end screen holds ≥ 3 s and loops into the hook | The frame-0 headline punches (1.00 → 1.08 in 120 ms) on the first beat |
| Festive (Bangladesh) | Bangla-first type (Galada or Tiro Bangla headlines, Anek or Hind body). Eid: green or navy with gold, crescent, lanterns, geometric patterns, no religious figures. Pohela Boishakh: red and white, terracotta, alpona, fish, owl and sun motifs. 26 March and 16 December: flag green and red (≈ #006A4E, #F42A41). Puja: red, marigold, sindoor, dhak, conch, diya | Eid calm; Boishakh joyful; national days proud and respectful; Puja rich · `rays`, `drift`, `bokeh` · festive percussion or instrumental | An alpona draws itself outward in radial symmetry, then the greeting (শুভ নববর্ষ, ঈদ মোবারক …) reveals syllable by syllable |

**Festive cautions:**

- **The flag:** keep its 10:6 proportion, with the disc's radius one fifth of the length and
  the disc set slightly towards the hoist ([Banglapedia](https://en.banglapedia.org/index.php/National_Flag)).
  Never stretch it or set text on it.
- **Don't name the Boishakh procession.** It was renamed in 2025 and again in 2026 and is
  politically charged ([Wikipedia](https://en.wikipedia.org/wiki/Mangal_Shobhajatra)).
- **Solemn days are not sale moments:** 21 February is Language Martyrs' Day.

## 13. QA checklist

Every item must pass on every template.

1. **Shapes.** 9:16, 1:1, 4:5 and 16:9 all render, adapted, not cropped.
2. **Safe band.** Critical items in 9:16 sit inside x 65–950, y 269–1248; other shapes keep a 5%
   margin. Nothing clips its box or mask, including Bangla's marks above and below the line.
3. **Size floors.** Text ≥ 0.028 S, details ≥ 0.036 S, body and CTA ≥ 0.044 S.
4. **Contrast.** Sampled over the whole clip at the brightest moment: WCAG 4.5:1 (3:1 for large
   text), plus APCA Lc ≥ 60 on dark themes.
5. **Reading time.** Each block is legible for ≥ 0.5 s + characters ÷ 15, never under 1.5 s.
6. **Frame 0.** For hooks, ads, sale and launch, the subject or headline is legible on frame 0,
   and the poster frame (mid-hold) works as a thumbnail.
7. **Hierarchy.** One focal point per beat; one signature move that nothing competes with.
8. **Easing.** No linear keys outside loops. Entrances decelerate, exits accelerate, and opacity
   and colour never spring.
9. **Timing.** Durations fit §6.1, nothing is under 4 f except cuts and impacts, exits are 50–70%
   of their entrances, and staggers follow reading order and spread ≤ 600 ms.
10. **Motion blur.** Every move faster than about 1 S per second blurs in the export.
11. **Background.** It has:
    - at least two living layers;
    - 8–20 s cycles;
    - drift ≤ 3% of the width per second;
    - luminance behind text within ±8 L*, or a scrim.

    It looks right in all five kits, light and dark.
12. **Grain and banding.** Grain is 2–3%, and a 1080p H.264 export at 8 Mbps shows no banding or
    smeared grain.
13. **Flashes.** At most 3 flashes in any second, and no saturated red flashes.
14. **Fonts.** At most 2 families and 3 weights; no light weights below 0.06 S.
15. **Bangla.** With the Bangla preview on:
    - no tracking, uppercase, italic or underline;
    - conjuncts stay whole;
    - line height is 1.5 or more;
    - no danda sits alone on a line;
    - prices use Bangla digits;
    - text at each field's limit stays above the floors.
16. **Long text and stretch.** Every field at its limit fits and wraps evenly. At 0.5× and 2× the
    length, the entrance and exit stay intact and the hold still lives.
17. **Loop and CTA.** Looping templates compose their last frame into the first. The CTA is still
    and readable for ≥ 2 s inside the strict band.
18. **Sound.** Hits land on the impact frame or one after, with ≤ 4 sound types. With a typical
    bed, the export measures −14 LUFS ±1 with a true peak ≤ −1 dBTP. The message also works muted.
19. **Licences.** Every asset is our own, CC0, OFL, MIT, ISC or Apache, and is listed in the
    licence file.
20. **Performance and culture.** 30 fps preview at 540p on the reference GPU. Flags keep their
    proportions, and a native speaker has checked the Bangla.
