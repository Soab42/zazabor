# CorePro design brief

CorePro should feel like a premium macOS app: calm, precise, frosted glass, generous but
tight spacing, nothing loud. Every screen in every module follows these rules.

## Materials

- **Backdrop**: `var(--backdrop)` (soft accent/blue/violet glows over `--bg`) sits behind the
  window. Content areas are transparent so the backdrop shows through.
- **Glass**: bars, sidebars, panels → `background: var(--glass)` +
  `backdrop-filter: var(--blur)` + a hairline edge (`box-shadow: inset 0 -0.5px 0 var(--line-strong)`
  or the matching side). Popovers, menus, sheets, dialogs → `var(--glass-strong)` +
  `blur(40px) saturate(180%)`, `box-shadow: inset 0 1px 0 var(--shine), var(--shadow-pop)`.
- **Never** use solid hex colours in module CSS. Use the tokens in `src/styles.css`: `--text`,
  `--text-2`, `--muted`, `--faint`, `--line`, `--line-strong`, `--hover`, `--control`,
  `--control-hover`, `--selection`, `--track`, `--tile`, `--accent`, `--accent-soft`,
  `--accent-ink`, `--focus`, `--danger`, `--shadow`, `--shadow-pop`. Translucent tints of the
  foreground use `rgba(var(--fg), a)`. This keeps light/dark themes and background tones working.

## Typography

- System stack (`var(--font)`), 13px base. Titles 15–18px, weight 650–700, letter-spacing
  −0.01 to −0.015em. Secondary text `--muted` 11.5–12px. Section labels `--faint` 11px, weight 650.
- Numbers that change (sizes, counts, times) use `font-variant-numeric: tabular-nums`.

## Shape and spacing

- 4px grid. Radii: 6–7px small controls, 8px buttons/fields, 10–12px cards, 14–16px dialogs.
- Rows 28–32px tall; toolbars 52–58px; sidebars 220–260px.
- Hairlines are 0.5px (`box-shadow: inset 0 0 0 0.5px var(--line)`), never heavy borders.

## Controls (reuse these classes; don't restyle them per module)

`.btn` (+ `.primary`, `.ghost`, `.small`, `.large`), `.icon-btn` (+ `.active`, `.small`),
`.text-btn`, `.segmented` with `button.active`, `.search` + `.search-input`, `select`,
`input[type=range]`, `input.switch`, `.menu` + `.menu-item` + `.menu-sep` (via `openMenu` in
`src/ui/menu.ts`), `.modal-overlay` + `.modal` + `.modal-head/-body/-foot`, `.sf-group` +
`legend`, `.sf-row` + `.sf-label` + `.sf-value`, `.sf-toggle`, `.sf-hint`, `.scope`, `.spinner`.
Icons: `icon(name, size)` from `src/ui/icons.ts` (24×24 line icons, 1.7 stroke).

## Motion

- UI transitions 150–220ms with `cubic-bezier(0.2, 0.8, 0.3, 1)` (settle) or
  `cubic-bezier(0.3, 0.7, 0.4, 1)` (springy toggles). Pop-ins: 6px rise + 0.98 scale.
- Hover feedback is a background tint (`--hover`), not movement; cards may lift 2px.
- Respect `prefers-reduced-motion: reduce` (drop movement, keep fades).

## Details that make it feel premium

- Selection: `--selection` pill with the icon in `--accent`; keyboard focus: `0 0 0 3px var(--focus)`.
- Empty states: a glass tile with a large accent icon, one-line title, one helpful sentence,
  one primary action.
- Thumbnails get `--tile` placeholders that fade to the image (opacity 0 → 1, 250ms).
- Text never wraps awkwardly: truncate with ellipsis, put the full value in `title`.
- Every interactive element has hover, active, focus-visible and disabled states.
- Context menus on right-click everywhere it makes sense; shortcuts shown in menus and tooltips.
