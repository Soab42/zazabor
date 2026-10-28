# Video editor: the side panels redesigned (spec)

Status: planned 2026-10-28. Nothing under `src/` is changed yet. Implementation starts after the
current round in `panels.ts`, `inspector.ts` and `timeline.ts` lands. That round adds a right-click
menu, overlay transitions with cut/in/out slots, multi-select, music preview through
`shared/listen`, and text editing. This spec builds on those interfaces and doesn't rename them.

The user's words: "whole ui is not user friendly. It's so cozy and not professionally designed:
the options and tools, basically the right and left bar design." Read "cozy" as cramped,
cluttered and amateurish. The goal is a left bar (assets) and a right bar (inspector) that look
and work like a pro editor's, in Zazabor's own look: macOS 26 glass and the coral video tone.

Line numbers cited below refer to the files as committed at `47ffd67` (the working tree on
2026-10-28 before that round). The round already in progress adds:
- a layer "Transitions" section (In, Out, and "From the clip before" when a layer touches the
  previous one);
- `Inspector.reveal(title, field)`, called with "Speed" and "Content" from `index.ts:920, 970`;
- transition slots in `PanelHost`.

Sections 7.5, 7.6 and 11 account for them.

Scope: the left panel (`panels.ts`, `captions.ts`, the Templates tab in `motion/browser.ts`), the
inspector (`inspector.ts`, `motion/fields.ts`, `motion/ui.ts`), the layout of the three columns,
and their CSS. Out of scope: the timeline, the player's transport, the export dialog and Photo.

---

## 0. Decisions at a glance

1. **Floating panels.** The left panel and the inspector become rounded sheets (12 px radius)
   with 6 px gutters on the dark stage. The gutters are the resize handles. Each panel can
   collapse (Ctrl+0 and Ctrl+Alt+0, plus buttons in the top bar). Widths are remembered.
2. **One control system.** A new `controls.ts` holds the section, row, scrub number,
   slider-and-value row, colour well, segmented control, select, switch and tabs. The inspector,
   the captions pane and the template views all use it, replacing three copies of the row
   helpers.
3. **A strict row grid.** Every row is `label 76 | control 1fr | value 52 | actions 36`. Rows are
   28 px tall with 24 px controls and 12 px type. The keyframe diamond and reset sit in the
   trailing actions column, so columns line up through every section.
4. **Inspector tabs per clip kind.** Video, Adjust, Speed and Audio for video clips (as CapCut
   does), Text and Animation for texts, Content and Look for templates. Sections collapse, show
   a summary when closed, and remember their state. Optional effects (Mask, Chroma key, Frame)
   get an on/off switch in their header, as Final Cut Pro and Resolve do.
5. **Typed and scrubbed numbers.** Geometric values (position, size, durations) are scrub fields
   you can drag, type into or step with the arrow keys. Intensities are a slider paired with an
   editable value box (Apple HIG: slider plus text field). Values can't be edited anywhere today.
6. **Left panel: an icon tab strip and a titled pane.** Eight icon tabs (32 px) replace the eight
   9.5 px labels. The pane header carries the category name and its actions, then search and
   filter chips, then a responsive asset grid with hover preview. The full-width coral buttons
   go.
7. **Categories reordered and merged:** Media, Audio, Text, Templates, Stickers | Effects
   (Effects and Filters), Transitions, Captions. Subtitle files move from the Text tab into
   Captions.
8. **One tone.** Inside the editor, switches, slider fills, focus rings and primary glows use the
   coral `--app`, and keyframes use one `--ve-key` gold. No hex colours remain in the panel CSS.
9. **Prerequisite bug fix:** template fonts stop leaking into the app's UI font (see P2).

---

## 1. What's wrong now

I read the code and ran the installed build (`~/.local/bin/zazabor`, 2026-10-28) on a nested
1400×900 display: Studio, then Video, then a Classic text added, then the Templates and
Transitions tabs. The shell's two rails take 120 px; the editor gets 1280 px.

### Top ten problems

**P1. Eight labelled tabs squeezed into 296 px.**
- `panels.ts:49-58` and `95-99` draw the labelled tabs; `video-editor.css:20-25` sizes them:
  `font-size: 9.5px`, `padding: 6px 2px`, `flex: 1 1 auto`.
- In the screenshot, "TemplatesStickersCaptionsTransitions" runs together with no gaps.
- The active pill hugs only the icon and label of "Media".

**P2. Template fonts change the whole app's UI font mid-session.**
- Opening Templates calls `loadFamily`, which adds `FontFace("Inter")` to `document.fonts`
  (`motion/fonts.ts:89-91`).
- `--font` in `styles.css` lists `"Inter"` ahead of Cantarell and Fira Sans, so every module
  switches from Fira Sans to Inter at that moment.
- After that the tabs read "Me…", "Au…", "T…", "Templat…" and the inspector's segments read
  "Reg…" and "Cen…". The bug is outside the panels, but the user sees it as panel breakage.

**P3. No shared controls, and some controls with no style at all.**
- Rows are built three times with different markup: `inspector.ts:114-206`, `motion/ui.ts`
  (whole file) and `captions.ts:87-94`.
- There is no text-field style anywhere in the app. `.ve-textarea` (`video-editor.css:107`),
  `.mo-text` and `.mo-search` (`motion.css:4,37`) render as browser defaults.
- The Templates search box is a WebKit search input, not the app's `.search` pill.

**P4. Values are read-only, and everything is a slider.**
- `slider()` (`inspector.ts:114-140`) shows the value as a plain `<span>`. You can't type 100%,
  nudge it with a key, or scrub it.
- X and Y are two full-width sliders (`:266-267`), the mask is five (`:340-344`), and durations
  are sliders running to 30 s (`:369, :446, :492`).
- Sliders are about 117 px wide, so 1% steps are sub-pixel.

**P5. Columns don't line up, and labels wrap or truncate.**
- Labels are 76 px (`video-editor.css:99`), but keyed rows use 60 px plus an 18 px diamond on the
  left (`:144-145`), so the Position sliders start about 11 px right of the Picture sliders.
- "Shadow / glow" wraps to two lines.
- "Regular" truncates in a three-way segmented control at 12 px (`.ve-seg button`, `:106`).
- "Lower under voice-overs" (`inspector.ts:400`) can't fit 76 px at all.

**P6. Flat, endless sections.**
- A main-track video clip builds up to ten sections and about 50 rows in one scroll
  (`inspector.ts:279-425`).
- There are no tabs and nothing collapses. Section titles are 11 px uppercase `--muted` text
  (`video-editor.css:97`) separated by hairlines, so nothing stands out.
- Resetting is inconsistent: "Reset position" (`:271`), "Reset" (`:309`, which resets only part
  of `fx`) and "Remove table" are buttons, and most sections have none.

**P7. Prose instead of affordances.**
- Instructional paragraphs: "◆ adds a keyframe at the playhead; with keyframes…"
  (`inspector.ts:264`, three lines), the sticker note (`panels.ts:249`), the transitions note
  (`:302`), the filters note (`:323`), the captions blurb (`captions.ts:118`), the template
  description (`motion/fields.ts:37`) and "0 files · Select a clip…" (`inspector.ts:224`).
- Pro inspectors explain with tooltips and states, not paragraphs.

**P8. Optional features behave like rows, and wells look live when they're off.**
- Chroma key starts with a "Remove a colour" switch row (`inspector.ts:324`), Frame with a
  "Rounded frame" switch (`:358`) and Mask with a "Shape: None" select (`:336`).
- The Box and Outline colour wells look active while their switch is off (`:479-483`).
- The project's "Colour" well shows white while Background is Blur (`:220`).
- A black outline well vanishes on the dark panel: it has no frame (`video-editor.css:102`).

**P9. Off-tone and hard-coded colours.**
- Switches turn amber `--accent` inside the coral editor (`styles.css:330`). The focus ring is
  amber.
- The coral Import and Add text buttons keep `.btn.primary`'s amber glow (`styles.css:252-256`
  versus `video-editor.css:27`).
- Hex fills break the light theme and DESIGN.md's rule: `#23252c` (`video-editor.css:59, 189`),
  `#101114` (`:37`), `#173d31`, `#1f5b46` and `#8cf0be` (`:38, 53`), `#b93a2b` and `#b4691c`
  (`:43-44`), and `#ffd166` keyframes (`:148-150`, also `timeline.ts:390, 558`).

**P10. The left panel's chrome and behaviour.**
- Every tab opens with a full-width coral button (`panels.ts:166, 188, 259`;
  `video-editor.css:27`).
- Templates stacks seven rows of search, four rows of wrapping chips, two selects, a kit row and
  two switches before the first card (`motion/browser.ts:94-110`).
- Transitions shows 24 grey, disabled text chips with no preview (`panels.ts:308-315`).
- Subtitle files appear in both the Text tab and Captions (`panels.ts:280-284`).
- A hover "×" on a media card removes the file from the project (`:157`): an easy misclick.
- Only Templates has search.
- Panel widths are fixed (`video-editor.css:16`: `296px … 292px`), with no splitters and no
  collapse.

### Also noted

- `.ve-panel-tab` doesn't use roving focus: all eight tabs are tab stops, and arrows do nothing.
- Media cards show the kind icon and name in 11 px with the duration squeezed beside them. The
  "+" button floats at a computed `top: calc(min(100%, 62.5%) - 34px)` (`video-editor.css:46`).
- The text inspector's textarea is 64 px tall at minimum and resizable, with no style.
- Speed presets are four `btn small` buttons on a separate row (`inspector.ts:383`).
- PiP spots are five text buttons that wrap to two lines (`:350`).
- Keyframe tools are a separate row of prev, next and an Ease select with a count
  (`inspector.ts:229-259`). It looks like a stray toolbar.
- Aside, not editor: at 900 px window height the onboarding "Choose your features" sheet runs off
  the bottom and can't be scrolled to Next.

---

## 2. What pro editors do (rules to transfer)

Sources are listed in section 14. Where a primary page refused automated fetches (Adobe help
returned 403, the Resolve manual mirrors 404), the rule rests on the official page's
search-indexed text or a named third-party guide. That is marked below.

| Rule | Who does it | Our take |
| --- | --- | --- |
| The inspector is contextual: it shows what fits the selection, with top tabs per domain. | Resolve's Inspector tabs (Video, Audio, Effects, Transition, Image, File; tabs that don't apply are greyed). Premiere 25's Properties panel ("context-aware… surfaces the most frequently needed tools"). CapCut's right panel (Video / Audio / Speed / Adjustment, each with sub-tabs such as Basic, Cutout, Mask). | Text tabs per clip kind (section 7). Hide tabs that don't apply rather than greying them: our kinds are few, and hidden tabs keep the bar short. |
| Collapsible titled groups, with on/off per effect group. | FCP's Video inspector: a blue checkbox turns Transform, Crop or Distort off and keeps its settings. Resolve's per-group bypass toggle. HIG: use disclosure controls to hide detail until it's relevant, with descriptive labels. | Every section collapses. Optional effects get a header switch. |
| Reset per parameter and per group. | Motion and FCP: the animation menu's "Reset Parameter" also clears keyframes, and each group has a reset that "removes all keyframes … and restores … default". FCP's effect Reset button. Resolve's clockwise-arrow reset per property and per group (third-party guide). Premiere's per-property reset; with keyframes it resets only the value at the current time (Adobe Effect Controls help, search excerpt). | A row reset appears only when the value differs from its default. The section header reset clears the section, and a reset also clears that property's keyframes (FCP and Motion behaviour, the simplest to explain). |
| A keyframe button on every animatable row, with prev and next arrows. | FCP: a Keyframe button beside the parameter becomes solid when the playhead is on a keyframe, with left and right arrows to step. Resolve: a diamond beside each parameter turns orange on a keyframe. | A diamond in the row's trailing column. Prev and next arrows live in the section header when that section has keys. |
| Numbers can be dragged, typed or stepped. | Premiere: drag inside a control, scrub the underlined value, or type it (Adobe help, search excerpt). FCP: Option-drag adds a keyframe while changing the value. | A scrub field component (section 5.3). |
| Pair a slider with an editable value field. | Apple HIG Sliders: "Consider supplementing a slider with a corresponding text field and stepper." HIG: the track fills from minimum to thumb. | Slider row: track, then a 52 px value box. A bipolar fill (from the centre) for −100…+100 values. |
| An asset library: categories, then search, then a grid. | CapCut's left toolbar: Media, Audio, Text, Stickers, Effects, Transitions, Filters, each with sub-categories. Resolve's Effects Library: Toolbox (Transitions, Titles, Generators) and OpenFX, with search. | Icon tab strip, then a titled pane with search, chips and a grid. |
| Hover preview of assets. | CapCut and the Resolve library preview on hover. Our Templates cards already play on hover. | Video tiles scrub through their filmstrip; audio rows have listen; transition tiles animate (phase 3b). |
| Let people hide and resize side panels, and collapse them automatically when narrow. | HIG Sidebars: "Consider letting people hide the sidebar", "consider automatically hiding and revealing a sidebar when its container window resizes". WWDC23 Inspectors: inspector width min 200, ideal 300, max 400. HIG Split views: dividers drag to resize. | Gutter splitters. Inspector 280–440 (default 320); left 296–480 (default 304). Auto-collapse below the player's 480 px minimum. |
| Liquid Glass belongs to controls and navigation, not the content layer, and should be used sparingly. | HIG Materials: "Don't use Liquid Glass in the content layer", "Use Liquid Glass effects sparingly". The regular variant suits sidebars with lots of text. | Panels are regular glass sheets (tint, sheen, grain, specular edge), with no refraction and no backdrop blur over the solid stage. Refracting capsules stay with the video player. |
| Density. | Pro inspectors run 22–26 px rows at 11–12 px type. DESIGN.md says rows of 28–32 px for general UI. | 28 px rows, 24 px controls, 12 px labels and values, 11 px meta. One step denser than DESIGN.md's general rows, as befits a pro tool. |

---

## 3. Fitting Zazabor's design language

- **Tokens only** (`src/styles.css`, DESIGN.md):
  - Type: `--text-xs` 11, `--text-sm` 12, `--text-md` 13.
  - Spacing: `--space-1…4` (4, 8, 12, 16).
  - Radii: `--radius-sm` 6, `--radius-md` 8, `--radius-lg` 12.
  - Fills and lines: `--line`, `--line-strong`, `--hover`, `--control`, `--control-hover`,
    `--track`, `--selection`, `--tile`; `--glass-surface`, `--spec`, `--elev-1…3`.
  - Text: `--text`, `--text-2`, `--muted`, `--faint`.
  - Motion: `--dur-fast`, `--dur-med`, `--ease-out`, `--ease-spring`.
- **Tone** (`studio.css:7-9`): `--app` coral `#f97350`, `--app-ink`, `--app-soft`. Add these
  beside them, where tone hex values already live (dark and light variants):
  - `--ve-key: #ffd166` (light `#b8860b`): keyframes in the inspector and the timeline.
  - `--ve-audio: #34c38f` (light `#14935f`): audio tiles and waveforms, replacing `#8cf0be` and
    `#1f5b46`.
  - `--ve-warn: #f0a33a` (light `#b86e00`): codec and missing badges (the "missing" badge uses
    `--danger`).
- **Editor-scoped overrides** (`.ve-app` in `video-editor.css`):
  - `--focus: color-mix(in srgb, var(--app) 55%, transparent)`.
  - `.ve-app input.switch:checked { background: var(--app) }`.
  - `.ve-app .btn.primary`: a coral gradient and a coral glow built like `styles.css:252-261`,
    with `--app` in place of `--accent` and `#fff` ink.
- **Same app as the player.** The Liquid Glass player (`video.css:280-400`) floats refracting
  capsules over video. The editor panels use the quieter regular glass sheet (sheen, grain,
  `inset 0 1px 0 var(--spec)`, hairline), with the same 12–22 px rounding family and springy
  presses on icon buttons. The editor's transport could become a Liquid Glass capsule later (out
  of scope).
- **Same app as Photo and Office.**
  - Pane headers and the icon strip use Photo's `.ph-panel-head` metrics (30–40 px, icon in
    `--app-ink`).
  - Tool buttons follow `.ph-tool` (32 px, `--app-soft` active with a 1 px `--app` 50% ring).
  - Group labels inside the left pane use DESIGN's section-label style: 11 px, 650, uppercase,
    `--faint`.
  - Inspector section headers are interactive disclosure headers, so they use Title Case at
    12 px / 650 `--text`, as FCP and Resolve do.
- **Copy:** British spelling as the app already uses ("Colour", "Centre"); sentence case; no
  colons after labels; no instructional paragraphs (put explanations in `title` tooltips).

---

## 4. Layout and dimensions

```
 shell rails (120)│ ve-top 46 ─────────────────────────────────────────────────────────────── │
                  │ [◧] ← ▣ Untitled video ●               ↶ ↷ 💾 [Export] [◨]               │
                  │╭───────── left 304 ─────────╮ ╭──── player 1fr (≥480) ────╮ ╭─ insp 320 ─╮│
                  ││ tab strip 40               │6│                           │6│ header 40   ││
                  ││ pane header 40             │ │        preview            │ │ tabs 36     ││
                  ││ search 36 · chips 32       │ │                           │ │ sections…   ││
                  ││ grid (scrolls)             │ │ transport 44              │ │ (scroll)    ││
                  │╰────────────────────────────╯ ╰───────────────────────────╯ ╰─────────────╯│
                  │ ═══ timeline splitter ═══ (unchanged) ═══ timeline ═══                      │
```

- **`.ve-main`:**
  - `display: grid; grid-template-columns: var(--ve-left, 304px) minmax(480px, 1fr)
    var(--ve-right, 320px); column-gap: 6px; padding: 6px; background: var(--stage)`.
  - Collapsed panels set their column to `0` and get `hidden`; the gap collapses with them
    (`grid-template-columns` is recomputed in TS, not `:has()`, so the ResizeObserver fires once).
- **Panels** (`.ve-panel`, `.ve-inspector`):
  - Fill and edge: `background: var(--glass-surface); border-radius: var(--radius-lg);
    box-shadow: inset 0 1px 0 var(--spec), inset 0 0 0 0.5px var(--line-strong), var(--elev-1);
    overflow: hidden`.
  - No `backdrop-filter`: the stage under them is solid, so a blur buys nothing and costs GPU
    while video plays.
  - Each is a flex column: pinned header area plus a scrolling body.
- **Player:** unchanged (sits on the stage). The `ve-player` top edge aligns with the panels'.
- **Splitters:**
  - The 6 px gutters are `div.ve-gutter` (`role="separator"`, `aria-orientation="vertical"`,
    `tabindex="0"`, `cursor: col-resize`).
  - Hover or drag shows a 2 px × 32 px rounded `--app` 60% grip centred in the gutter.
  - Dragging is clamped: left 296–480, inspector 280–440, player ≥ 480.
  - Double-click resets to the default. ←/→ moves 8 px, Shift ×4.
  - Widths persist in `settings()` (`index.ts:300`): add `left`, `right`, `leftOpen`,
    `rightOpen`.
- **Collapse:**
  - Top-bar buttons: `sidebar` icon before the back button group (toggles the left panel); a
    mirrored `sidebar` (`transform: scaleX(-1)`) after Export (toggles the inspector).
  - Both are `.icon-btn.active` when open.
  - Shortcuts: Ctrl+0 (left) and Ctrl+Alt+0 (inspector), as Xcode does. Ctrl+1…9 belong to the
    shell's module switching (`shell.ts:469`), so digits with Ctrl are off-limits.
- **Auto-collapse** (HIG): on resize, if `left + right + 480 + 18 > editor width`, collapse the
  left panel and mark it `auto`. If that isn't enough, collapse the inspector too. Re-open
  `auto`-collapsed panels when space returns; never re-open one the user closed.
- **Pinned regions:**
  - Left: tab strip, pane header, search and chips.
  - Inspector: header and tabs.
  - When the body is scrolled, the pinned area's bottom edge gets `box-shadow: 0 1px 0
    var(--line-strong), 0 6px 12px -8px rgba(0,0,0,.4)` (class `scrolled`, toggled on scroll).
    This is HIG's scroll-edge effect.

---

## 5. Components to build once (`src/modules/studio/video/controls.ts`)

The new module exports the pieces below. `motion/ui.ts` becomes a thin adapter that re-exports
them with its current signatures (so `fields.ts` and `kits.ts` keep compiling), and `captions.ts`
uses them directly. Every control pushes a sync into `Syncs` exactly as today, and the inspector's
"don't overwrite the focused control" rule stays.

### 5.1 Sizes (local tokens on `.ve-app`)

```
--ve-row: 28px        row min-height
--ve-ctl: 24px        control height (select, field, segmented, buttons)
--ve-pad: 12px        panel side padding
--ve-label: 76px      label column
--ve-value: 52px      value column
--ve-actions: 36px    trailing actions (two 16 px icon buttons + 4 gap)
--ve-gap: 6px         column gap
--ve-section: 32px    section header height
--ve-head: 40px       pane / inspector header height
```

### 5.2 Section: `section(o, ...rows)`

```ts
section({
  id: "transform",                      // persisted open/closed per clip kind + id
  title: "Transform",
  summary?: () => string,               // shown right-aligned when collapsed ("Circle", "Dissolve · 0.6 s", "Off")
  enable?: { get(): boolean; set(v: boolean): void },   // optional effect: switch in header
  modified?: () => boolean,             // dot after the title + header reset visible
  reset?: () => void,
  keys?: { has(): boolean; prev(): void; next(): void },// ‹ › arrows in header when has()
  menu?: () => MenuItem[],              // ⋯ (openMenu from src/ui/menu.ts)
  open?: boolean,                       // default when nothing is persisted (see 7.9)
}, ...rows)
```

**Header** (32 px, full width, `border-top: 0.5px solid var(--line)` except the first):
- A `button.ve-sec-toggle` (`aria-expanded`) holds:
  - a 16 px box with a `chevronRight` 12 px icon, rotated 90° when open (`--dur-fast`);
  - the title, 12 px / 650, `--text`;
  - a 6 px `--app` modified dot.
- Then, right-aligned in this order:
  - the summary (11.5 px `--muted`, ellipsis; only while collapsed);
  - `‹` `›` keyframe arrows (20 px `.ve-mini` buttons, `chevronLeft` and `chevronRight` 12 px;
    disabled when there's no key that way);
  - reset ↺ (`undo` 12 px, only when `modified()`);
  - the enable switch (`input.switch.ve-sm`, 28×16);
  - ⋯ (`more`).
- Hover: `--hover` background on the toggle part only. The rest are separate buttons.

**Body:** `padding: 2px 0 10px`. It's hidden when collapsed, and when `enable` is off: turning it
on opens the section.

**Disabled section** (enable off): title in `--muted`, summary "Off".

### 5.3 Scrub number field: `scrub(o)`

```ts
scrub({
  get(): number; set(v: number, final: boolean): void;  // final=false while dragging (one undo step: same change key)
  min: number; max: number; step: number;
  unit?: "%" | "°" | "s" | "×" | "px" | "";
  prefix?: string;                      // "X", "Y", "W", "H": drawn inside the field in --faint
  format?: (v) => string; parse?: (s) => number | null;
  mixed?: () => boolean;                // multi-selection: shows "—"
  keyed?: () => boolean;                // value text in --ve-key when the property is animated
})
```

- **Element:** `<input type="text" inputmode="decimal" role="spinbutton" aria-valuenow/min/max>`
  in `span.ve-scrub`. It is 24 px tall, at least 52 px wide, padding `0 6px`, radius 5.
  - Fill and edge: `background: var(--control)`, `box-shadow: inset 0 0 0 0.5px
    var(--line-strong)`.
  - Text: 12 px tabular-nums, left-aligned, with the unit in `--muted` after the number.
  - Value text is `--text`; `--ve-key` when `keyed()`.
- **Rest:** `cursor: ew-resize` (the field is readonly until clicked).
- **Pointer down then move ≥ 3 px:** scrub.
  - Pointer capture; Δx × step per 2 px; Shift ×10, Alt ×0.1.
  - Clamp to min and max; `set(v, false)` on each move, `set(v, true)` on release.
  - The body gets `cursor: ew-resize` for the duration.
- **Click without moving:** edit mode. `readonly` off, the text is selected and the caret
  appears, with background `--control-hover` and focus ring `0 0 0 2px var(--focus)`.
  - Enter or Tab commits (parse, clamp, `set(v, true)`). Esc reverts and blurs.
  - An invalid entry reverts, with a 300 ms `--danger` inset flash.
- **Focused, not editing:** ↑/↓ steps, Shift ×10, Alt ×0.1, PageUp/PageDown ×10.
- **Wheel:** ignored (the inspector scrolls).
- **Disabled:** 40% opacity, `pointer-events: none`.
- **Mixed:** shows "—"; typing sets all.

### 5.4 Row: `row(label, control, value?, actions?)` and its variants

`div.ve-row`: `display: grid; grid-template-columns: var(--ve-label) minmax(0,1fr) var(--ve-value)
var(--ve-actions); column-gap: var(--ve-gap); align-items: center; min-height: var(--ve-row)`.

- **Label:** `label.ve-label`, 12 px / 400 `--muted`, one line with ellipsis and the full text
  in `title`. It gets a `for` or `aria-label` link to the control.
- **Control without a value:** spans columns 2–3. Actions are always reserved (empty
  `span.ve-actions`), so every column lines up.
- **Variants** (each pushes its sync):

| Variant | Control column | Value column | Actions |
| --- | --- | --- | --- |
| `sliderRow(label, {min,max,step,get,set,format,default,bipolar?,keyed?})` | range slider (5.5) | `scrub` (same value, no prefix) | ◇ (if keyed), ↺ |
| `scrubRow(label, scrubOpts)` | `scrub` left-aligned, width 88 | – | ◇, ↺ |
| `pairRow(label, a, b)` | two `scrub` with prefixes, each 1fr, across columns 2–3 | | ◇ (both props), ↺ |
| `segRow(label, items)` | `.segmented.ve-seg` (5.6) across 2–3 | | ↺ |
| `selectRow(label, options)` | `select.ve-select` across 2–3 | | ↺ |
| `switchRow(label)` | spacer, then `input.switch.ve-sm` at column 3's right edge | | – |
| `colorRow(label, {get,set,optional?,eyedropper?})` | [☐ checkbox if optional] + well 36×20 + eyedropper `icon-btn ve-mini` | hex `#FFFFFF` (11 px mono `--muted`; click selects it for copying) | ↺ |
| `toggleRow(label, toggles)` | icon or letter toggles 24×24 (B, I; align icons) | | – |

- **Keyframe diamond:** `button.ve-key` 16×16 with the `veKey` 11 px icon.
  - Visible only on row hover or focus when the property has no keys. Outlined `--muted` when it
    has keys elsewhere. Filled `--ve-key` when the playhead is on one.
  - Click toggles a key. Right-click opens a menu: Smooth, Linear, Ease in, Ease out, Hold
    (checked = the key's ease), then Previous keyframe, Next keyframe, Remove all keyframes.
  - The Position diamond adds and removes x and y together. `on` is true if either is keyed at the
    playhead.
- **Row reset:** `button.ve-reset` 16×16 with the `undo` 11 px icon in `--muted`, shown only when
  the value isn't the default. It resets the value and clears that property's keyframes, and has
  a tooltip.
  - Double-clicking a slider's track also resets it (Resolve's habit).

### 5.5 Slider (inside `sliderRow`)

- `input[type=range].ve-range`, height 24.
- Track: 3 px, radius 2, `background: linear-gradient(to right, var(--track) var(--a),
  var(--app) var(--a), var(--app) var(--b), var(--track) var(--b))`.
  - `--a` and `--b` are set in TS on input and sync: from min to value, or for `bipolar`, from
    50% to value, with a 1 px × 7 px `--line-strong` centre tick (`::before` on the wrapper).
- Thumb: 12 px `--knob` with `0 0 0 0.5px rgba(0,0,0,.25), 0 1px 2px rgba(0,0,0,.35)`.
  - Hover: scale 1.15 (`--dur-fast` `--ease-spring`). Focus: `0 0 0 3px var(--focus)`.
- Disabled: 40%. Mixed: the thumb is hidden and the track isn't filled.

### 5.6 Segmented: `.segmented.ve-seg`

- The global `.segmented` at 24 px: padding 2, buttons 20 px tall, 12 px / 560, `flex: 1`.
- Icon variant: buttons 28 px wide with 14 px icons and a `title`.
- No more than three text items, or four short ones such as "0.5×". Otherwise use a select.

### 5.7 Select: `select.ve-select`

- Global `select` at 24 px: `padding: 0 22px 0 8px`, 12 px, chevron at 8 px from the right.
- Options can carry a leading swatch: the Filter select draws its look swatch as a 12×12 chip in
  the closed state, via a wrapper `span.ve-select-swatch` placed before the select.

### 5.8 Colour well

- `label.ve-well`: 36×20, radius 5, with a checkerboard under the colour (for `rgba` boxes).
- Edge: `box-shadow: inset 0 0 0 0.5px rgba(var(--fg), .3), 0 0 0 0.5px var(--line-strong)`.
- A transparent `input[type=color]` sits over it (as Photo's `.ph-color-input` does).
- Off (optional unchecked): 35% opacity, and a click turns the option on.

### 5.9 Text field and text area

- `.ve-field` is a single line, 24 px; `.ve-area` is multi-line: 2 lines minimum, auto-growing
  to 6, `resize: none`, padding `5px 8px`.
- Fill and edge: `background: var(--control); border: 0; border-radius: 6px; box-shadow: inset 0
  0 0 0.5px var(--line-strong)`. Text is 12.5 px `--text`; placeholder `--faint`.
- Focus: `background: var(--control-hover); box-shadow: 0 0 0 2px var(--focus), inset 0 0 0
  0.5px var(--line-strong)`.
- The counter (template limits) sits right-aligned above the field, 10.5 px `--muted`, and turns
  `--danger` when over the limit.
- This is the first text-field style in the app. Keep it `.ve-` scoped for now; promoting it to
  `styles.css` is a separate decision.

### 5.10 Tabs: `tabs({id, items, get, set})`

- A full-width `.segmented.ve-tabs`, 28 px (buttons 24), 12 px / 600, `role="tablist"` with
  `aria-selected`.
- Roving tabindex: ←/→, Home/End. The active tab is persisted per clip kind.

### 5.11 Small buttons

- `.ve-mini`: a 20×20 icon button with a 12 px icon, radius 5, `--muted`; hover `--hover` and
  `--text`; active `--control-hover`.
- `.ve-head-btn`: the pane-header action. 24 px tall, `padding: 0 8px`, radius 6,
  `background: var(--app-soft)`, `color: var(--app-ink)`, 12 px / 600, optional 14 px icon.
  Hover `color-mix(in srgb, var(--app) 28%, transparent)`.
- Inside panels, `.btn.small` becomes 24 px for action rows ("Mark beats", "Choose…").

---

## 6. The left panel

### 6.1 Before (Text tab, as rendered today at 296 px)

```
┌──────────────────────────────────────────┐
│ [▣]  ♫   T   ▤    ☺     ▭     ✦     ◐    │  icons 18 px
│Media Audio Text TemplatesStickersCaptions…│  9.5 px labels running together
├──────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐ │
│ │              + Add text              │ │  full-width coral CTA, amber glow
│ └──────────────────────────────────────┘ │
│ STYLES                                   │
│ ┌─────────────────┐ ┌─────────────────┐  │
│ │       Aa        │ │       Aa        │  │  #23252c hard-coded tile fill
│ │     Classic     │ │       Box       │  │
│ └─────────────────┘ └─────────────────┘  │
│   … three more rows …                    │
│ CAPTIONS                                 │
│ Subtitle files (.srt) come in as texts   │  duplicate of the Captions tab
│ on a track of their own; your texts …    │
│ [Import .srt…] [Export .srt…]            │
└──────────────────────────────────────────┘
```

### 6.2 After (Media)

```
╭──────────────────────────────────────────╮
│ (▣) ♫  T  ▤  ☺ ┊ ✦  ⇄  ▭                 │ 40  icon tabs 32×32, active = --app-soft pill
├──────────────────────────────────────────┤
│ Media  12                   [+ Import] ⋯ │ 40  title 13/650 · count 11.5 --muted
│ ⌕ Search media                           │ 36  .search pill, 28 px
│ (All) (Video) (Photos)  (Unused)         │ 32  chips 24 px, one line, scrolls sideways
├──────────────────────────────────────────┤
│ ┌───────────────┐ ┌───────────────┐      │     auto-fill minmax(112px, 1fr)
│ │               │ │               │      │     thumb 16:10, radius 8
│ │   thumbnail   │ │   thumbnail   │      │     hover: scrub frames, (+) bottom-right
│ │        ●0:12 │ │               │      │     ● = used in the timeline; duration chip
│ └───────────────┘ └───────────────┘      │
│ beach-sunset.mp4  logo.png               │     11 px --text-2, one line
│ ┌───────────────┐ ┌───────────────┐      │
│ │ ! codec       │ │ Missing       │      │     --ve-warn / --danger chips, top-left
╰──────────────────────────────────────────╯
```

### 6.3 Tab strip

- **Order** (two groups with a 1 px × 16 px `--line-strong` divider): add things, then apply
  things to clips.

| # | Id | Icon | Pane title | Shortcut |
| --- | --- | --- | --- | --- |
| 1 | media | `film` | Media | Alt+1 |
| 2 | audio | `music` | Audio | Alt+2 |
| 3 | text | `textBox` | Text | Alt+3 |
| 4 | templates | `template` | Templates | Alt+4 |
| 5 | stickers | `veSticker` | Stickers | Alt+5 |
| ┊ | | | | |
| 6 | effects | `sparkles` | Effects | Alt+6 |
| 7 | transitions | new `veTransition` (two offset frames, 24×24, 1.7 stroke) | Transitions | Alt+7 |
| 8 | captions | `subtitles` | Captions | Alt+8 |

- **Tab buttons:** `button.ve-cat` 32×32, radius 8, 18 px icon `--muted`. Hover `--hover` and
  `--text`. Active: `--app-soft` with `--app-ink` and an inset 1 px `--app` 45% ring (Photo's
  `.ph-tool.active`). Focus `0 0 0 2px var(--focus)`.
- **Strip:** `padding: 4px 6px`, `gap: 2px`, `justify-content: flex-start`.
- **Accessibility:** `role="tablist"`, roving tabindex, ←/→, Home/End, Enter/Space.
- **Tooltips:** "Text (Alt+3)". Use `title` for now; a custom tooltip is out of scope.
- **Persisted:** the last tab, in `settings().panelTab`.
- `PanelTab` gains `effects`, and `filters` is removed. `show("filters")` callers map to
  `effects` with its Filters sub-tab.

### 6.4 Pane header (pinned)

Row 1, 40 px: `padding: 0 var(--ve-pad)`, then the title (13 px / 650), the count (11.5 px
`--muted`), a spacer, and the actions:
- Media: `[+ Import]` (`.ve-head-btn`). The ⋯ menu holds Install codecs… (only when some file
  needs codecs; replaces `.ve-codec-note`), Sort by: Name / Date added / Length, and Remove
  unused files.
- Audio: `[+ Import]`, `[● Record]` (`.ve-mini` with `veMic`; red while recording), ⋯.
- Text: `[+ Add text]` (adds Classic at the playhead).
- Templates: ⋯ menu with Brand Kits…, Import .zaztemplate…
- Stickers, Effects, Transitions, Captions: no header actions, or ⋯ where noted.

Rows 2–3, only where listed: search (36 px) and chips or a sub-segmented control (32 px).

| Pane | Search | Row 3 |
| --- | --- | --- |
| Media | yes | chips All / Video / Photos / Unused |
| Audio | yes | segmented Music / Sound effects / In project |
| Text | – | – |
| Templates | yes, plus an options button (`filter` icon, `.ve-mini`) at its end | category chips, one line, scrolling sideways with fade edges (`mask-image` 16 px) |
| Stickers | yes | – |
| Effects | – | segmented Effects / Filters |
| Transitions | yes | target line + slot segmented (6.11) |
| Captions | – | – |

- **Search:** the app's `.search` and `.search-input` at 28 px, full width.
- It filters by name, tags and category label. Ctrl+F focuses it. Esc clears it, and a second
  Esc blurs it.
- The query is kept per pane while the editor is open.

### 6.5 Asset tile (Media, Text styles, Templates, Effects, Transitions)

Component: `tile({ thumb, name, meta?, badges?, onAdd, onPreview?, drag?, menu? })`
- **Thumb:** radius 8 with an inset 0.5 px `--line` hairline. Background `--tile` until loaded,
  then the image fades in (DESIGN: 250 ms).
- **Name:** under the thumb, 11 px `--text-2`, one line, 18 px line height.
- **Meta chip:** bottom-right of the thumb (duration "0:12", template "6.5 s"). 10.5 px tabular
  `#fff` on `var(--chip)` with `--blur-chip`, radius 5, `padding: 1px 5px`.
- **Badges:** top-left. "Missing" on `--danger`; "!" on `--ve-warn` with the note in `title`.
- **Used dot:** a 6 px `--app` dot left of the duration chip when the media is on the timeline
  (computed on refresh from `project.tracks`).
- **Hover:**
  - Outline `1px solid var(--app)` (not animated).
  - A (+) add button fades in (opacity `--dur-fast`): 24 px round `--app` with a white `plus`
    14, bottom-left of the thumb so it doesn't cover the duration.
  - Video media scrubs: pointer x across the thumb picks frame `floor(x / w * strip.count)` from
    the existing `Strip` sprite (`media.ts:19-24`), drawn into the tile canvas, and the hold
    frame comes back on leave.
  - Templates keep their play-on-hover.
- **Selected or focused:** `outline: 2px solid var(--focus); outline-offset: 1px`.
- **Remove:** the hover "×" goes (P10). Removing uses the right-click menu (from the other
  agent's round), Delete on a focused tile, or the header ⋯ "Remove unused files". It keeps
  undo as today.
- **Dragging** to the timeline keeps `MEDIA_DRAG` and `TEXT_DRAG` unchanged.
- **Double-click and Enter** add at the playhead.

### 6.6 Media

- The grid shows only visual media, as today; audio files live in Audio, under "In project".
- Empty state: section 10.

### 6.7 Audio

- **Rows** (Music, Sound effects, In project), 40 px each:
  - A play/stop button (28 px round, `--app-soft` and `--app-ink`; while playing, `--app` with
    a white `stop` icon), using the other agent's `shared/listen` (`toggleListening` and
    `onListening`).
  - Title 12.5 px / 560 `--text`, then meta 11 px `--muted` ("Upbeat · 120 BPM · 2:31").
  - A (+) `.ve-mini` on hover or focus. Drag is supported for project audio.
- **Playing row:** a 2 px `--app` progress line along its bottom, if listen exposes progress;
  otherwise just the state.
- Only one row plays at a time. Switching tabs or adding stops the preview.
- The sound-effects grid (`ve-sfx-grid`) becomes these same rows.

### 6.8 Text

- Style tiles 4:3 with the "Aa" sample (`ve-text-sample`), 3 columns at ≥ 336 px and 2 below.
- Tile fill: `var(--tile)` instead of `#23252c`.
- "Add text" moves to the header. The Captions/.srt block moves to Captions.

### 6.9 Templates (`motion/browser.ts`)

- **Row 2:** the `.search` pill (replacing `input.mo-search`) and an options button.
- **Options popover** (`.glass-strong`, 260 px) holds what used to be four rows:
  - Shape (select);
  - Length (segmented Any / ≤5 s / 5–7 s / >7 s);
  - Brand Kit (select, with Brand Kits… beside it);
  - Bangla preview (switch);
  - Add suggested sounds (switch).
  - The options button shows a 6 px `--app` dot when any filter isn't at its default.
- **Row 3:** category chips (All, Product launch, Sale & offers, Feature highlight, Logo reveals,
  Lower thirds, Reel hooks & end screens, My Templates) in one sideways-scrolling line.
  - Chips are 24 px, 11.5 px, radius 12.
  - Active chip: `--app-soft` with `--app-ink` and a 1 px `--app` inset. The solid coral fill of
    `motion.css:8` goes.
- **Cards:** as now (`.mo-card` with hover play), in the shared tile frame (6.5). The `mo-card-len`
  chip becomes the meta chip.
- **My Templates:** the head row "N saved [Import .zaztemplate]" becomes the empty state or
  count, and Import moves to the header ⋯.

### 6.10 Stickers

- Grid `repeat(auto-fill, minmax(56px, 1fr))`, gap 6: square tiles with no label (the label goes
  in `title` and `aria-label`).
- The note paragraph goes. Search filters by label.

### 6.11 Transitions

- **Target line** (32 px, 12 px `--text-2`, ellipsis), from `transitionTarget()` (the other
  agent's `TransitionTarget`). Examples:
  - "Cut 3 · beach.mp4 → logo.png" (slot cut);
  - "Layer · Title text" (off the main track).
- **Slot control:** for a layer, a segmented In / Out (and Cut when `touching`); for the main
  track, Cut only, with no control.
- **Row 3:** Length as a `scrubRow` ("Length 0.6 s", 0.2–2, step 0.1), plus a ⋯ menu with
  Remove and Apply to all cuts/clips on this track.
- **Groups:** Classic, Light, Motion, plus the layer groups from `LAYER_TRANSITION_GROUPS`, each
  with an 11 px uppercase `--faint` heading.
- **Tiles:** 3 columns at ≥ 336 px, otherwise 2.
  - Thumb 16:10: a static "A→B" glyph (two frames meeting along the transition's shape) drawn
    with `--tile` and `--app-soft`, plus the name. Animated hover previews are phase 3b.
  - The current kind gets a 2 px `--app` outline.
- **No target:** a callout instead of 24 grey disabled chips (section 10). Tiles render at 50%
  opacity and are `inert`, so browsing still reads well.

### 6.12 Effects (Effects and Filters)

- A segmented **Effects / Filters** control (remembered).
- **Effects:** tiles for `EFFECTS` (`inspector.ts:46-49`, without None), each with a gradient
  thumb and an icon (`sparkles` and so on), applied to the selected clip.
  - Needs `host.applyEffect(id: EffectId | "none")` and `host.currentEffect()`: about 20 lines in
    `index.ts`.
  - The Amount slider stays in the inspector's Adjust tab.
- **Filters:** the existing look tiles (`LOOK_SWATCH`, which may keep its hex gradients because
  they depict the looks; they're content, not chrome).
  - "All clips" moves to the ⋯ menu ("Apply to all clips on the main track").
- **No selection:** a callout, with the tiles inert (section 10).

### 6.13 Captions (`captions.ts`)

- Rows rebuilt with `segRow`, `selectRow` and `colorRow`:
  - From (All clips / Selected), Language, Model (with its note as a 2-line hint under it, 11 px
    `--muted`), Style, Highlight.
- **Generate:** one full-width `.btn.primary` (coral, 28 px). This is the only full-width
  primary button in the left panel, because it's this pane's single action.
- Progress as today, styled with `--app`.
- The intro paragraph shrinks to one line under the header: "Runs on this computer. Nothing is
  uploaded."
- A new section "Subtitle files": `[Import .srt…] [Export .srt…]` (`.btn.small`, 24 px), moved
  from Text.

---

## 7. The inspector

### 7.1 Before (main-track video clip; today, one scroll)

```
┌──────────────────────────────────┐
│ ▶ beach-sunset.mp4               │
│ PICTURE                          │  11 px uppercase --muted titles, no collapse
│ Fit          [ Fill | Fit  ]     │
│ POSITION                         │
│ ◆ adds a keyframe at the playhead│  three-line instruction
│ ; with keyframes, moving a …     │
│ ◇ Scale    ━━━━●━━━━━     100%   │  keyed rows: label 60 px → slider column shifts
│ ◇ X        ━━━━━●━━━━       0%   │
│ ◇ Y        ━━━━━●━━━━      -8%   │
│ ◇ Rotation ━━━━━●━━━━       0°   │
│ ◇ Opacity  ━━━━━━━━━●     100%   │
│ ‹ ›  Ease [Smooth ▾]   3 keys    │
│ [Reset position]                 │
│ FILTER AND ADJUST                │
│ Filter       [None          ▾]   │
│ Brightness   ━━━━━●━━━━      +0  │  read-only numbers
│ …  Contrast, Saturation, Colour table [Load .cube…], [Reset]
│ EFFECTS …  Effect, Blur, Sharpen, Vignette, Grain
│ CHROMA KEY   Remove a colour (○) │
│ MASK         Shape [None ▾]      │
│ FRAME        Rounded frame  (○)  │
│ SPEED  Speed ━━●━━ 1.00×  [0.5×][1×][1.5×][2×]  Curve [None ▾]  Reverse (○)
│        [Freeze frame at the playhead]
│ SOUND  Volume, Fade in, Fade out, Lower under voice-overs…
│ TRANSITION IN  Kind [None ▾]  Length ━●━ 0.6 s
└──────────────────────────────────┘   ≈ 50 rows
```

### 7.2 After (same clip, Video tab)

```
╭──────────────────────────────────────────╮
│ ▶ beach-sunset.mp4                     ⋯ │ 40  icon --app-ink, name 13/650, ⋯ menu
│   0:04.20 · 1920×1080 · Main             │     meta 11 px --muted (part of the 40 px block: two lines 18+16)
│ [  Video  | Adjust |  Speed  |  Audio  ] │ 36  tabs 28 px
├──────────────────────────────────────────┤
│ ˅ Transform •            ‹  ›  ↺         │ 32  • = modified, ‹ › = has keyframes
│   Fit        [  Fill  |  Fit   ]         │ 28
│   Position   [X    0 %][Y   -8 %]   ◇ ↺  │ 28  pair of scrub fields
│   Scale      ━━━━━●━━━━━  [100 %]   ◆ ↺  │ 28  ◆ gold: key at playhead; value text gold
│   Rotation   ━━━━━●━━━━━  [  0 °]   ◇    │
│   Opacity    ━━━━━━━━━━●  [100 %]   ◇    │
│   Ease       [Smooth          ▾]         │ 28  only while the playhead is on a keyframe
│ › Frame                        Off  (○)  │ 32  optional: switch in header
│ › Mask                      Circle  (●)  │     on: summary shows the shape
│ › Chroma key                   Off  (○)  │
│ › Transition in       Dissolve · 0.6 s   │     main track; layers show "Transitions" (In/Out)
╰──────────────────────────────────────────╯
     label 76 │ control 1fr │ value 52 │ actions 36   (content width 296 at the default 320)
```

### 7.3 After (text clip, Text tab)

```
╭──────────────────────────────────────────╮
│ T  Your text                           ⋯ │
│   0:03.00 · Text track                   │
│ [       Text        |     Animation    ] │
├──────────────────────────────────────────┤
│ ˅ Content                                │
│ ┌──────────────────────────────────────┐ │  .ve-area, 2–6 lines, auto-grow
│ │ Your text                            │ │
│ └──────────────────────────────────────┘ │
│ ˅ Style                                  │
│   Font       [Sans                  ▾]   │
│   Size       ━━━●━━━━━━━━━  [ 56  ]   ↺  │
│   Style      [B] [I]   [⟸][≡][⟹]        │  letter toggles + align icon segmented
│   Fill       [■■■■] #FFFFFF          ↺   │
│   Outline    ☑ [■■■■] #000000        ↺   │
│   Background ☐ [░░░░]                    │  dimmed until checked
│   Shadow                          (○)    │
│   Spoken word ☑ [■■■■] #FFD23F           │  only for captions with word timings
│ ˅ Transform                     ‹ › ↺    │
│   Position   [X    0 %][Y   -8 %]   ◇    │
│   …                                      │
╰──────────────────────────────────────────╯
```

### 7.4 Header (pinned, 40 px, plus 36 px tabs when there are two or more)

- **Line 1:** kind icon (16 px, `--app-ink`), name (13 px / 650, ellipsis, path in `title`),
  spacer, ⋯ (`.ve-mini`, `more`).
- **Line 2:** meta, 11 px `--muted` tabular: duration · size or kind · track ("Main",
  "Overlay 1", "Text", "Audio").
- **Missing or codec problems:** a callout under the header (10): "File not found ·
  [Locate…]", or the codec note with `[Install codecs…]`.
- **The ⋯ menu** (via `openMenu`), per kind:
  - Media: Reset this tab · Freeze frame at the playhead (video) · Show in Files · Delete clip.
  - Text and sticker: Reset style · Delete.
  - Template: Add suggested sounds · Ungroup to layers / Regroup · Save as Poster · Save to My
    Templates · Export .zaztemplate… · Delete.
  - The template description becomes the `title` of the header icon.

### 7.5 Tabs and sections per clip kind

Tabs that don't apply are left out, not greyed. A one-tab kind shows no tab bar.

| Kind (how it's detected today) | Tabs and sections (default open state in brackets: O = open, C = closed, A = open only when not at its default) |
| --- | --- |
| **Video on main or overlay** (`m.kind === "video"`, track ≠ audio) | **Video:** Transform [O], Frame (optional) [A], Mask (optional) [A], Chroma key (optional) [A], Transitions [A] (7.6). **Adjust:** Filter [O], Basic [O], Effect [A], Detail [A], Colour table [A]. **Speed:** Speed [O]. **Audio** (if `m.audio`): Volume [O], Fades [O], Ducking [A]. |
| **Image** | **Image:** Transform [O] (+ a Ken Burns switch row), Duration [O], Frame, Mask, Chroma key, Transitions. **Adjust:** as for video. |
| **Freeze frame** (`clip.freeze !== undefined`) | Same as Image, with the title "Freeze frame". |
| **Audio clip** (audio media, or any media on an audio track) | **Audio:** Volume [O], Fades [O], Ducking [A] (not for voice-overs), Beats [O] (audio track). **Speed:** Speed [O] (no curve, no reverse for audio media). |
| **Voice-over** (`role === "voice"`) | As Audio, without Ducking; icon `veMic`. |
| **Text** | **Text:** Content [O], Style [O], Transform [O]. **Animation:** In and out [O], Transitions [A], Timing [O]. |
| **Sticker** (`clip.sticker`) | **Sticker:** Sticker [O] (picker + colour + size), Transform [O]. **Animation:** In and out [O], Transitions [A], Timing [O]. |
| **Template** | **Content:** Fields [O] (texts, choices, picture slots, sample-language buttons), Transform [C], Transitions [A]. **Look:** Brand Kit [O], Colours [O], Fonts [O], Style [O]. |
| **Nothing selected** | **Project:** Canvas [O], Project [O] (read-only meta). |
| **Several selected** (with the other agent's multi-select; phase 4) | **Selection:** a summary header ("3 clips · 2 videos, 1 text"). Common [O]: Opacity, Volume (if all have sound), Filter (if all are visual). Mixed values show "—". Plus a Delete action. |

### 7.6 Rows per section (labels exactly as they'll appear)

**Transform** (media, text, sticker, template):
- Fit: seg Fill / Fit (media only).
- Ken Burns: switch (images only).
- Position: pair X / Y, % with the centre as 0, as today. Keyed (x and y together).
- Scale: slider 10–300% plus value. Keyed.
- Rotation: slider −180–180° plus value. Keyed.
- Opacity: slider 0–100% plus value. Keyed.
- Snap to: a mini picker, overlay track only. A 56×32 frame with five 10 px hot-spots
  (corners and centre) from `PIP_SPOTS`. It replaces five text buttons.
- Ease: select, shown only while the playhead is on a keyframe of this clip (replaces the
  `ve-key-tools` row).
- Header: ‹ › keyframe arrows (`keyTimes`), reset ↺ (as "Reset position", `inspector.ts:271-275`,
  including clearing keys).

**Frame** (optional; header switch = `clip.frame` on/off; summary "Rounded" or "Off"):
- Corners: slider 0–50%.
- Border: scrub 0–30 px, plus a colour well in the same row (control: scrub 64 + well).
- Shadow: slider 0–100%.

**Mask** (optional; switch = mask on with the last shape, or Circle; summary = the shape name):
- Shape: icon seg (Circle / Rectangle). There is no "None": the switch does that.
- Centre: pair X / Y.
- Size: pair W / H.
- Feather: slider 0–30%.
- Invert: switch.

**Chroma key** (optional; switch = `fx.key` on/off; summary = the colour hex or "Off"):
- Key colour: well, eyedropper (`pickKeyColor`) and hex.
- Strength, Edge, Spill: sliders 0–100%.

**Transitions** (one section, two shapes; summary "Dissolve · 0.6 s", "In: Fade · Out: Wipe" or
"None"):
- **Main-track clip after the first:** titled "Transition in". Rows Kind (select: None plus the
  groups) and Length (scrub 0.2–2 s).
- **Layer** (the other agent's `layerTransitions`): rows In, Out and, only while `touching`,
  From the clip before. Each is a select of None plus `LAYER_TRANSITION_GROUPS`.
  - A row's Length scrub sits in that row's value column ("0.5 s") instead of a separate slider
    row, so each transition stays one row.
  - The current "This clip starts where the one before it ends…" paragraph becomes the `title`
    of the "From the clip before" label.
- **Header ⋯:** Browse transitions… (opens the left panel on Transitions, Alt+7, with the
  matching slot selected) and Remove all.

**Duration** (images and freeze frames): Duration as scrub 0.5–30 s (replaces the slider).

**Filter:** Look as a select with a swatch, plus a "Browse…" link to Effects › Filters.

**Basic:** Brightness, Contrast and Saturation, as bipolar sliders −100…+100.

**Effect** (summary = the effect name or "None"):
- Effect: select. Amount: slider 0–100%, only when the effect isn't None.

**Detail:** Blur, Sharpen, Vignette and Grain, as sliders 0–100%.

**Colour table** (summary = the LUT name or "None"):
- File: name (ellipsis) plus `[Load…]` (`.btn.small`), or `[Change…]`.
- Strength: slider, only when a LUT is loaded.
- Header ⋯ menu: Remove table.

**Speed:**
- Mode: seg Standard / Curve (CapCut). Video only; other media gets Standard only.
- Standard:
  - Speed: slider 0.25–4× plus value.
  - Presets: seg 0.5× / 1× / 1.5× / 2× (no row label; spans columns 1–3).
- Curve: Curve as a select of `CURVE_PRESETS`.
- Reverse: switch (video).
- Length: a read-only value showing the resulting clip length, 11 px `--muted`.
- Freeze frame: moved to the header ⋯ menu.

**Volume:** Volume as a slider 0–200% plus value. Keyed.

**Fades:** Fade in and Fade out, as scrubs 0–5 s.

**Ducking:** "Duck under voice", a slider 0–100% (shows "Off" at 0).

**Beats:**
- `[Mark beats]` `[Clear]` (`.btn.small`, 24 px), with "24 beats · clips snap to them" as 11 px
  `--muted` beside them.

**Text › Content:** the `.ve-area` (still the element `index.ts:690` focuses after adding text;
keep `.ve-textarea` as a second class on it so that query keeps working).

**Text › Style:**
- Font: select. Size: slider 12–200 plus value.
- Style: toggles B and I, which replace the Regular/Bold/Italic segmented control; Regular is
  both off. Then align as an icon seg (`alignLeft`, `alignCenter`, `alignRight`).
- Fill: colour well.
- Outline: optional colour well.
- Background: optional colour well (stored with alpha 0.7, as today).
- Shadow: switch.
- Spoken word: optional colour, only when `words` exist.

**Animation › In and out:** In and Out as selects (`TEXT_ANIMS`, without typewriter for Out and
for stickers).

**Animation › Timing:** Duration as scrub 0.3–30 s.

**Sticker:**
- Sticker: a select now, a picker popover of the sticker grid later.
- Colour: well (when `tint !== false`). Size: slider.

**Template › Fields:**
- Text fields stacked (label above, counter right; `.ve-field` or `.ve-area`).
- Choices: `selectRow`.
- Picture slot: a 44 px row with a 36×36 thumb (radius 6, `--tile`), the name (12 px, ellipsis)
  and `[Choose…]`. Its ⋯ menu holds Clear and Cut out product.
- The sample-language buttons become a seg "Sample text" English / বাংলা.

**Template › Brand Kit:**
- Brand Kit: select. Header ⋯: Reset to kit · Brand Kits… · Use on all templates.

**Template › Colours:** one row "Colours" with five wells of 28×20 (Primary, Secondary, Accent,
Background, Text in `title`). The modified dot sits over each changed well (replaces five rows).

**Template › Fonts:** Pairing, Headings, Body and Bangla, as selects.

**Template › Style:** Roundness as a slider; Motion as a seg Snappy / Smooth / Playful.

**Project › Canvas:**
- Shape: seg 9:16 / 16:9 / 1:1 / 4:5.
- Background: seg Blur / Colour, plus a well, which only shows when Colour is chosen. Black and
  White become two preset swatches inside the well's row: 16 px circles before the well.
- Frame rate: select.

**Project › Project:** read-only rows "Length 0:12.40", "Files 7", "Size 1080×1920"; values in
12 px `--text-2`.

### 7.7 Behaviour

- **Rebuilds** stay as today (`refresh()`): rebuild when the selection's "shape" key changes,
  otherwise run the syncs. Add the active tab to the key's inputs. Switching tabs rebuilds only
  the body.
- **Persistence** in `settings()`:
  - `inspectorTab: Record<kind, string>`;
  - `sections: Record<"kind:id", boolean>` (only toggled sections are stored);
  - widths and open flags (4).
- **Scroll:** keep the scroll position per `(clip id, tab)` while the editor is open (today it
  keeps one scroll for everything, `inspector.ts:79-84`).
- **Undo:** a scrub drag uses one change key, so it's one undo step (`COALESCE_MS` already
  merges same-key edits). `set(v, true)` on release doesn't add a step.
- **Keyframed values:** while the playhead moves, `timeChanged()` syncs at 10 Hz as now. The
  value text and the diamond update; nothing allocates in the sync.

### 7.8 What "modified" means

- **Row:** `get() !== default`, using the defaults from `defaultPlace()`, `defaultFx()`,
  `defaultMask()`, `defaultFrame()`, or the template theme for Look (its `overrides` list).
- **Section:** any row modified, or any key on its properties.
- **Header reset:** restores the defaults and removes keys for that section's properties.
  Template Look's reset is "Reset to kit".

### 7.9 Default open and closed

1. The user's last toggle for that `kind:id` wins.
2. Otherwise use the "default" column in 7.5.
3. "A" means open if the section is modified or enabled.

---

## 8. States

| State | Look |
| --- | --- |
| Rest | Controls on `--control` with a 0.5 px `--line-strong` inset. Labels `--muted`, values `--text`. |
| Hover | Fields and selects: `--control-hover`. Buttons and tabs: `--hover` background with `--text` ink. Rows: no background; the ◇ and ↺ slots appear. Tiles: 1 px `--app` outline. |
| Pressed | Icon buttons: scale 0.94 (as `.icon-btn`). Toggles: `--control-hover`. |
| Focus-visible | `0 0 0 2px var(--focus)` (coral inside the editor). Inside scroll areas, keep the ring inside the padding: rows have `padding-inline: 2px` so 2 px rings aren't clipped. |
| Active / selected | Tabs and seg items: `--thumb` raised (global `.segmented`). Category tabs and toggles: `--app-soft` with `--app-ink`. Tiles: 2 px `--app` outline. |
| Disabled | Control at 40% opacity with `pointer-events: none`; the label goes to `--faint`. Never greyed whole panes: use a callout and `inert` instead. |
| Optional off | Section collapsed, summary "Off", title `--muted`, switch off. Optional colours: well at 35% until checked. |
| Modified | ↺ visible on the row, and a 6 px `--app` dot after the section title. |
| Animated (has keys) | Value text `--ve-key`; ◇ outlined `--muted`. At a key: ◆ filled `--ve-key`. |
| Mixed (multi-select) | Value "—", slider thumb hidden, no seg item active, switch shows its middle position (`indeterminate`). |
| Busy | Template cut-out, beats, LUT loading: a 12 px `.spinner` in the row's actions slot. |
| Error | `--danger` 300 ms inset flash on the field. Callouts as in section 10. |

Motion: `--dur-fast` for hover and press, `--dur-med` for chevrons and section open and close.
Sections open without height animation (instant; it avoids layout thrash in long panels). Under
`prefers-reduced-motion`, drop the thumb scale and the chevron rotation transition.

---

## 9. Keyboard

The shell already ignores typing targets before calling `handleKey` (`shell.ts:478`,
`isTypingTarget`). Scrub fields are text inputs only while editing; at rest they are `readonly`
inputs. **`isTypingTarget` treats a readonly text input as typing**, so a focused, resting scrub
field must handle ↑/↓ itself and must not block the editor's own keys. Give resting scrub fields
`data-scrub` and add `if (target.dataset.scrub !== undefined && target.readOnly) return false;`
to `isTypingTarget`.

| Keys | Where | Does |
| --- | --- | --- |
| Alt+1…8 | editor | Show a left-panel category; opens the panel if collapsed. |
| Ctrl+0 | editor | Toggle the left panel. |
| Ctrl+Alt+0 | editor | Toggle the inspector. |
| Ctrl+F | editor | Focus the current pane's search (opens the panel). |
| ←/→, Home/End, Enter/Space | category strip, inspector tabs, seg controls | Roving focus and select. |
| Arrows, Home/End | asset grid | Move focus by tile (row-aware, using the computed column count). |
| Enter, double-click | tile | Add at the playhead. |
| Space | tile | Preview: audio listen, template play, video scrub-play. Space elsewhere stays Play. |
| Delete / Backspace | media tile | Remove from the project (undoable). |
| Shift+F10, Menu key | tile, row, diamond | Context menu. |
| Esc | search | Clear, then blur to the editor. |
| ↑/↓ (+Shift ×10, Alt ×0.1), PgUp/PgDn | scrub field, focused | Step the value. |
| Enter / Tab / Esc | scrub field, editing | Commit / commit and move / revert and blur. |
| Enter / Space | section header | Collapse or expand. |
| Alt+K | a focused keyable row | Toggle a keyframe at the playhead. |
| ←/→, Shift | gutter (splitter) | Resize 8 px / 32 px. |

Tooltips show shortcuts: "Media (Alt+1)", "Hide the inspector (Ctrl+Alt+0)".

---

## 10. Empty states and callouts

**Callout component:** `div.ve-callout`.
- Radius 8, `padding: 8px 10px`, 12 px `--text-2`.
- Fill and edge: `background: rgba(var(--fg), .04)`, `box-shadow: inset 0 0 0 0.5px
  var(--line-strong)`.
- An optional 14 px icon on the left. Tones: info (icon `info`, `--muted`), warn (`--ve-warn`
  icon and 8% tint), danger.
- At most one line of text plus one action (`.btn.small` or a link button).

**Empty state component** (DESIGN.md's recipe, sized for a pane):
- Centred in the body's upper third.
- A 44 px circle in `--app-soft` with a 22 px icon in `--app-ink`.
- A title (13 px / 650), one sentence (12 px `--muted`, max-width 220) and one action.

| Where | Content |
| --- | --- |
| Media, empty | The pane body is a drop zone: dashed 1 px `--line-strong`, radius 12, min-height 180. Icon `film`. "Import media" / "Add videos and photos, then drag them onto the timeline." / `[Import…]` (`.btn.small` coral, 26 px). Dropped files import if the editor receives file drops (check Tauri's drag-drop event in `index.ts`; if there's none yet, leave it as a later item). |
| Audio › In project, empty | Icon `music`. "No audio yet" / "Import music or record a voice-over." / `[Import…]` and `[Record]`. |
| Search, no results | "No matches for “…”." plus a `[Clear search]` text button, top-aligned. |
| Templates › My Templates, empty | Icon `template`. "Nothing saved yet" / "Select a template on the timeline, then choose Save to My Templates from its ⋯ menu." |
| Transitions, no target | Info callout: "Select a clip, or put two clips next to each other on the main track." Tiles inert at 50%. |
| Effects or Filters, nothing selected | Info callout: "Select a clip to apply an effect." Tiles inert. |
| Inspector, missing file | Danger callout under the header: "File not found." `[Locate…]` (the existing locate flow). |
| Inspector, codecs missing | Warn callout with the note and `[Install codecs…]`. |
| Inspector, template can't be shown | Danger callout: "This template can't be shown." |
| Inspector, nothing selected | The Project view (never blank), with "Select a clip to edit it." as 11.5 px `--muted` at the bottom of the Project section. It replaces "0 files · Select a clip…". |

---

## 11. Remove, merge, rename

**Remove:**
- `.btn.ve-import` full-width buttons (Import, Import music, Record a voice-over, Add text).
- `.ve-panel-note` paragraphs:
  - Stickers, Transitions, Filters, the Position keyframe hint, the project files line;
  - the captions intro, cut to one line;
  - the template description, now a tooltip.
- The hover × on media cards.
- The `ve-key-tools` row; its jobs move to header arrows, the Ease row and the diamond menu.
- The "Reset position", "Reset" and "Remove table" buttons.
- The toggle-as-first-row of Chroma key, Frame and Mask (and the Mask "None").
- `.ve-codec-note`, replaced by the header ⋯ item and inspector callouts.
- `.mo-switches`, `.mo-filters` and `.mo-kit-row` in the Templates tab, now in the options
  popover.

**Merge:**
- The Filters tab into Effects (sub-tab).
- Subtitle-file import and export from Text into Captions.
- Sound effects into Audio's row list.
- Three row-helper sets into `controls.ts`.

**Rename:**

| Before | After |
| --- | --- |
| Picture (section) | Transform's Fit row |
| Filter and adjust | Adjust tab: Filter, Basic, Colour table |
| Effects | Effect, Detail |
| Lower under voice-overs | Duck under voice |
| Shadow / glow | Shadow |
| Spoken words | Spoken word |
| Ken Burns motion | Ken Burns |
| Picture in picture | Snap to (in Transform) |
| Rounded frame | Frame |
| Colour (box) | Background |
| Remove a colour | Chroma key switch |

**Keep:**
- Drag payloads (`MEDIA_DRAG`, `TEXT_DRAG`).
- Every host method and the other agent's new interfaces (`TransitionTarget`, `TransitionSlot`,
  `toast`, listen).
- `.ve-textarea` as an extra class on the text area (`index.ts:690`).
- `Inspector.reveal(title, field)`. Sections get `data-section="<id>"`, and reveal looks the
  title up by id:
  - "Speed" → the Speed tab's `speed` section;
  - "Content" → the text's Content, or the template's Content tab's `fields`.
  - It switches to the owning tab first, opens the section if it's collapsed, then scrolls and
    focuses as today.
  - The text inspector's "Or double-click the text on the preview to type on the video." note
    becomes the text area's placeholder: "Type here, or double-click the text on the preview".
- `kits.ts`' use of `.ve-row` in the Brand Kits dialog: give that dialog's rows the new grid with
  `--ve-label: 84px`.

---

## 12. Implementation plan

### Phases (each lands on its own and keeps the app working)

| Phase | Work | Files |
| --- | --- | --- |
| **0. Prerequisites** (small) | Font leak fix: register bundled template faces under an alias (`"zm " + family`), with one helper `faceName(family)` used by `loadFamily` and every canvas font string (`env.font` in `player.ts` and `art.ts`, `textfit.ts`, and the Text inspector's font list if it names bundled families). `.tone-video` tokens (`--ve-key`, `--ve-audio`, `--ve-warn`). Editor-scoped `--focus`, the switch and primary-button tone. Replace the hex fills. The timeline reads `--ve-key` once via `getComputedStyle`. | `motion/fonts.ts`, `motion/player.ts`, `motion/art.ts`, `motion/textfit.ts`, `studio.css`, `video-editor.css`, `timeline.ts` (2 lines, after the other agent is done) |
| **1. Controls and inspector** | `controls.ts` (5.2–5.11); port `inspector.ts` to tabs and sections (7); port `motion/fields.ts` to Content/Look and make `motion/ui.ts` an adapter; `captions.ts` rows; inspector CSS. Unit tests for scrub math (step, modifiers, clamp, parse and format with units) in `tools/ve-controls.test.mjs`, with the same runner as `tools/motion.test.mjs`. | new `controls.ts`, `inspector.ts`, `motion/fields.ts`, `motion/ui.ts`, `captions.ts`, `video-editor.css`, `motion.css` |
| **2. Layout** | Floating panels, gutters and resizing, collapse buttons and shortcuts, auto-collapse, persistence; `fitStage` stays on the ResizeObserver. | `index.ts`, `video-editor.css` |
| **3. Left panel** | Category strip and reorder, pane headers, search, chips, tile component with hover scrub and used dot, Audio rows on `shared/listen`, Text tiles, Templates header and options popover, Stickers grid, Effects pane (+ `applyEffect` / `currentEffect` host hooks), Transitions tiles with target line and slots, empty states. **3b (optional):** animated transition previews on hover. | `panels.ts`, `motion/browser.ts`, `index.ts`, `video-editor.css`, `motion.css`, `ui/icons.ts` (`veTransition`) |
| **4. Keyboard and multi-select** | Section 9's keys; roving grid focus; the `isTypingTarget` tweak; the Selection inspector on the other agent's multi-select (host `selectedIds()` plus mixed states). | `index.ts`, `panels.ts`, `inspector.ts`, `ui/dom.ts` |

### Rough size

| Piece | Lines |
| --- | --- |
| `controls.ts` | ~450 new |
| `inspector.ts` | ~510 → ~600 (mostly rewritten views) |
| `panels.ts` | ~400 → ~560 |
| `motion/browser.ts` | ~70 changed |
| `motion/fields.ts` | ~90 changed |
| `motion/ui.ts` | becomes a ~25-line adapter |
| `captions.ts` | ~50 changed |
| `index.ts` | ~170 added (layout, settings, keys, effect hooks) |
| CSS | ~300 lines of `video-editor.css` replaced by ~380; `motion.css` ~60; `studio.css` +8 |
| Font alias | ~30 |
| Tests | ~100 |

Total: about **2,000–2,400 lines touched**, roughly **2½–3 days** of focused work: phase 0 about
½ day, phase 1 about 1 day, phase 2 about ½ day, phases 3 and 4 about 1 day. The biggest risks
are the inspector port (many edit paths: keep each `edit(id, key, fn)` call exactly as it is,
moving only the markup) and the template views' sync rules.

### Coordination

- Start after the other agent's round lands. Rebase the plan on its final `PanelHost`,
  `InspectorHost`, transition slots, multi-select and listen APIs.
- Don't change `timeline.ts` beyond the `--ve-key` read.
- The right-click menus the other agent adds for clips are reused for tiles, rows and diamonds,
  through the same `openMenu`.

---

## 13. Checking it in the running app

Run on your own nested display with a throwaway HOME and profile (see the
`test-on-nested-display` memory). Config lives at `$XDG_CONFIG_HOME/dev.soab.zazabor/config.json`;
seed `{"onboarded": true, "video": {"muted": true}}`. Check at 1400×900 and 1920×1080, in dark
and light themes, and with Reduce transparency on.

**Before and after:**
1. Repeat the 2026-10-28 path: Studio, then Video, then a Classic text, then Templates, then
   Transitions. No label wraps or truncates in the tab strip or inspector, before or after
   Templates loads its fonts. The UI font must not change when Templates opens (compare
   `getComputedStyle(document.body).fontFamily` and a screenshot of the title bar before and
   after).
2. Columns align: across Transform, Adjust and Audio, every row's control starts at the same x,
   and every value box's right edge matches (crop the screenshot and check pixel columns).

**Each kind:**

3. Select each kind in turn: main video, overlay video, image, freeze frame, music, voice-over,
   video on an audio track, text, sticker, grouped template, ungrouped template, nothing, and
   several clips. The tabs and sections must match the 7.5 table, with no empty tab and no
   duplicated control.

**Controls:**

4. Scrub fields: drag (one undo step per drag), Shift and Alt speeds, click and type with Enter,
   Esc reverting, ↑/↓ stepping, invalid input flashing and reverting. Editor shortcuts (S, Q, W,
   Delete, Space) don't fire while typing, and do fire when a resting scrub field is focused.
5. Keyframes: the diamond's three states while the playhead moves through keys. The value text
   turns gold when animated. ‹ › jump, the Ease row appears only on a key, and right-click ease
   changes the key. The timeline diamonds still match (same colour token).
6. Reset: the row ↺ appears only when modified and clears that property's keys. Section reset;
   the modified dot; Template Look's reset is Reset to kit.
7. Optional sections: the switch turns the effect on and opens the section, and the preview
   changes. Off collapses it and shows "Off". Mask remembers its last shape.

**Layout:**

8. Resize both gutters (clamps, player ≥ 480, double-click reset). Ctrl+0 and Ctrl+Alt+0, and
   the top-bar buttons. Shrink the window until the panels auto-collapse, and they come back
   when it grows (but not one the user closed). Widths and open states survive a restart. The
   stage re-fits each time (no letterbox glitches).

**Left panel:**

9. Alt+1…8 and the tooltips. Search plus no results and Clear, chips, Ctrl+F and Esc. Tiles:
   hover scrub on video, the + button, double-click and Enter add, drag to the timeline still
   works, the used dot appears after adding, Delete removes (undoable), the context menu.
10. Audio: listen plays one at a time and stops on tab switch or adding; Record works from the
    header.
11. Templates: only two control rows above the cards; the options popover's filters work; the
    dot shows when filtered; cards still play on hover; My Templates' empty state.
12. Transitions: the target line for a main cut, a layer in, and a layer out (the other agent's
    slots). Tiles apply; the current one is ringed; with no target, a callout and inert tiles.
13. Effects and Filters apply to the selected clip(s); the Adjust tab shows the effect with its
    Amount.

**Tone and health:**

14. Colours: no amber anywhere in the editor (switches, focus, glows), keyframes gold, no
    hard-coded greys in light theme.
15. Performance while playing a 1080p clip: inspector syncs at 10 Hz don't drop preview frames
    compared to before (watch the engine's late-frame count), and no `backdrop-filter` is on the
    panels.
16. Accessibility: tablist and tab roles, `aria-selected`, `aria-expanded` on section headers,
    `role="spinbutton"` with value attributes on scrub fields, `aria-label` on icon-only buttons.

---

## 14. Sources

Primary (Apple):
- Apple HIG, Sidebars (hide and show; auto-hide on resize; disclosure groups; Liquid Glass
  sidebars): https://developer.apple.com/design/human-interface-guidelines/sidebars
- Apple HIG, Materials (Liquid Glass for controls and navigation, not the content layer; use it
  sparingly; regular variant for text-heavy sidebars):
  https://developer.apple.com/design/human-interface-guidelines/materials
- Apple HIG, Sliders (pair with a text field and stepper; fill from minimum to thumb):
  https://developer.apple.com/design/human-interface-guidelines/sliders
- Apple HIG, Disclosure controls: https://developer.apple.com/design/human-interface-guidelines/disclosure-controls
- WWDC23 "Inspectors in SwiftUI: discover the details" (inspector width min 200 / ideal 300 /
  max 400; trailing, collapsible): https://developer.apple.com/videos/play/wwdc2023/10161/
- Final Cut Pro for Mac, Work with built-in effects (the effect's on/off checkbox keeps settings;
  Reset): https://support.apple.com/guide/final-cut-pro/verfc8a4bdc/mac
- Final Cut Pro for Mac, Add video effect keyframes (Keyframe button turns solid on a key;
  previous and next arrows): https://support.apple.com/guide/final-cut-pro/ver8e3f20ea/mac
- Final Cut Pro for Mac, colour corrections in the Video inspector (checkbox off without reset;
  far-right menu with Reset Parameter): https://support.apple.com/guide/final-cut-pro/ver449109f32/mac
- Motion, Animating using the Inspector (Reset Parameter clears keyframes; group reset):
  https://help.apple.com/motion/mac/5.0/help/English/en/motion/usermanual/chapter_12_section_4.html

Primary (Adobe, Blackmagic, CapCut):
- Adobe, Premiere Pro feature summary, October 2024 (context-aware Properties panel; editing
  several clips at once): https://helpx.adobe.com/premiere-pro/using/whats-new/2025.html
- Adobe, Edit video using the Properties panel (Position, Scale, Rotation, Opacity, Fill/Fit
  frame). Blocked for fetching (403); used via search excerpts:
  https://helpx.adobe.com/premiere-pro/using/edit-video-using-properties-panel.html
- Adobe, Adjust and reset controls in the Effect Controls panel (drag, scrub underlined values or
  type; reset with keyframes). 403; search excerpts:
  https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/adjust-or-reset-controls-in-the-effect-controls-panel.html
- Blackmagic, DaVinci Resolve 20 New Features Guide (Keyframe Editor: one track per keyframable
  parameter): https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20_New_Features_Guide.pdf
- CapCut, How to use CapCut (left toolbar: Media, Audio, Text, Stickers, Effects, Transitions,
  Filters; right panel: Video (Basic / Cutout / Mask), Audio, Speed (Curve), Adjustment):
  https://www.capcut.com/resource/how-to-use-capcut

Secondary (named, not official):
- Larry Jordan, The new Properties panel in Premiere Pro 25.0 (context-driven; progressive
  disclosure behind ⋯): https://larryjordan.com/articles/the-new-properties-panel-in-adobe-premiere-pro-25-0/
- Cromo Studio, A comprehensive guide to the Inspector in DaVinci Resolve (group bypass toggle;
  clockwise-arrow reset per property and per group; diamond keyframe per property):
  https://cromostudio.it/cromo-tips/a-comprehensive-guide-to-the-inspector-tab-in-davinci-resolve

In-repo: `docs/DESIGN.md`, `src/styles.css`, `src/modules/video/video.css` (Liquid Glass),
`src/modules/studio/photo/photo.css` (panel heads, tool buttons, number fields),
`src/modules/office/office.css` (rail and ribbon).
