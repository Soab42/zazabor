# CorePro design brief

CorePro should feel like a premium macOS app: calm, precise, frosted glass, generous but
tight spacing, nothing loud. Every screen in every module follows these rules.

## Materials

- **Backdrop**: `var(--backdrop)` (soft accent/blue/violet glows over `--bg`) sits behind the
  window. Content areas are transparent so the backdrop shows through.
- **Glass** (bars, sidebars, panels): `.glass`, or `background: var(--glass-surface)` +
  `backdrop-filter: var(--blur)` + a hairline edge (`box-shadow: inset 0 -0.5px 0 var(--line-strong)`
  or the matching side). `--glass-surface` layers a top sheen and film grain over `--glass`.
- **Strong glass** (popovers, menus, sheets, dialogs): `.glass-strong`, or
  `background: var(--glass-strong-surface)` + `backdrop-filter: var(--blur-strong)` +
  `box-shadow: inset 0 1px 0 var(--spec), var(--elev-3)`.
- **Blur only on bars and popovers**, never on large scrolling content. Small chips over photos use
  `--blur-chip` with `background: var(--chip)` (`--chip-strong` on hover).
- **Reduce transparency**: `html.reduce-transparency` (set by the shell from Settings) and
  `@media (prefers-reduced-transparency: reduce)` make `--glass-alpha` and `--glass-strong-alpha`
  1, and turn off blur, sheen and grain, so the same classes render as solid fills. Anything
  built from the tokens follows automatically; don't hardcode `rgba()` glass fills or
  `backdrop-filter` values in module CSS.
- **Never** use solid hex colours in module CSS. Use the tokens in `src/styles.css`: `--text`,
  `--text-2`, `--muted`, `--faint`, `--line`, `--line-strong`, `--hover`, `--control`,
  `--control-hover`, `--selection`, `--track`, `--tile`, `--accent`, `--accent-soft`,
  `--accent-ink`, `--focus`, `--danger`. Translucent tints of the foreground use
  `rgba(var(--fg), a)`. This keeps light/dark themes and background tones working.
  `--muted` and `--faint` are tuned to stay legible on glass in both themes; use `--faint` only
  for labels and decoration.
- `.card` is a soft tint plus hairline (no blur) for sections inside a panel.

## Tokens

| Group | Tokens |
| --- | --- |
| Type | `--text-xs` 11 / `--text-sm` 12 / `--text-md` 13 / `--text-lg` 15 / `--text-xl` 18 / `--text-2xl` 22, each with `--text-*-w` (weight) and `--text-*-ls` (letter-spacing) |
| Spacing (4px grid) | `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 24, `--space-6` 32 |
| Radii | `--radius-sm` 6, `--radius-md` 8, `--radius-lg` 12, `--radius-xl` 16 (`--radius` 10 is the older general value) |
| Motion | `--ease-out`, `--ease-spring`, `--dur-fast` 150ms, `--dur-med` 220ms; keyframes `fade-in`, `pop-in`, `sheet-in`, `menu-in` |
| Elevation | `--elev-1` cards, `--elev-2` raised or hovered cards, `--elev-3` popovers and menus, `--elev-4` dialogs. Each layers a hairline, a key shadow and an ambient shadow. `--shadow` = `--elev-1`, `--shadow-pop` = `--elev-3` |
| Glass | `--glass`, `--glass-strong` (colour), `--glass-surface`, `--glass-strong-surface` (layered backgrounds), `--sheen`, `--spec` (specular top edge), `--grain`, `--blur`, `--blur-strong`, `--blur-chip`, `--chip`, `--chip-strong` |

Palette notes: the light palette is crisp white glass over a cool airy backdrop; the dark palette
is the default. Background tones still override `--bg`, `--bg-raised` and `--glass-rgb` inline.

## Typography

- System stack (`var(--font)`), 13px base. Titles 15–18px, weight 650–700, letter-spacing
  −0.01 to −0.02em (use the `--text-lg`/`--text-xl` steps). Secondary text `--muted` 11.5–12px.
  Section labels `--faint`, `--text-xs`, uppercase, weight 650.
- Numbers that change (sizes, counts, times) use `font-variant-numeric: tabular-nums`.

## Shape and spacing

- 4px grid (`--space-*`). Radii: 6–7px small controls, 8px buttons/fields, 10–12px cards,
  14–16px dialogs.
- Rows 28–32px tall; toolbars 52–58px; sidebars 220–260px.
- Hairlines are 0.5px (`box-shadow: inset 0 0 0 0.5px var(--line)`), never heavy borders.

## Controls (reuse these classes; don't restyle them per module)

`.btn` (+ `.primary`, `.ghost`, `.small`, `.large`), `.icon-btn` (+ `.active`, `.small`),
`.text-btn`, `.segmented` with `button.active`, `.search` + `.search-input`, `select`,
`input[type=range]`, `input.switch`, `.menu` + `.menu-item` + `.menu-sep` (via `openMenu` in
`src/ui/menu.ts`), `.modal-overlay` + `.modal` + `.modal-head/-body/-foot`, `.glass`, `.glass-strong`, `.card`, `.sf-group` +
`legend`, `.sf-row` + `.sf-label` + `.sf-value`, `.sf-toggle`, `.sf-hint`, `.scope`, `.spinner`.
Icons: `icon(name, size)` from `src/ui/icons.ts` (24×24 line icons, 1.7 stroke).

## Motion

- UI transitions use `--dur-fast` (hover, press) or `--dur-med` (toggles, entrances) with
  `--ease-out` (settle) or `--ease-spring` (switches, knobs). Pop-ins: 6px rise + 0.98 scale;
  sheets drop in from above (`sheet-in`); menus scale out of the pointer (`menu-in`, origin set by
  `openMenu`).
- Hover feedback is a background tint (`--hover`), not movement; cards may lift 2–3px. Never
  animate box-shadow or filters on grids of many items.
- `prefers-reduced-motion: reduce` drops movement (lifts, scale pops, slide-ins) and keeps fades.
  If you add a transform animation, add its reduced-motion override next to the existing block at
  the end of `src/styles.css`.

## Details that make it feel premium

- Selection: `--selection` pill with the icon in `--accent`; keyboard focus: `0 0 0 3px var(--focus)`.
- Empty states: a glass tile with a large accent icon, one-line title, one helpful sentence,
  one primary action.
- Thumbnails get `--tile` placeholders that fade to the image (opacity 0 → 1, 250ms).
- Text never wraps awkwardly: truncate with ellipsis, put the full value in `title`.
- Every interactive element has hover, active, focus-visible and disabled states.
- Context menus on right-click everywhere it makes sense; shortcuts shown in menus and tooltips.
