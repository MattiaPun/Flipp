# public/

The frontend is plain ES modules with no build step. Preact and htm come from `/vendor/htm-preact.js`. Imports use absolute paths (`/ui.js`, `/vendor/...`).

| File | Role |
|---|---|
| `app.js` | Hash router, `Shell` (top bar, bottom nav, offline badge), ⌘K command palette, `App` (auth gate, forced 2FA setup) |
| `ui.js` | `api()`, `useAsync`, `useSubmit`, `Modal` (native `<dialog>`), prefs, theme, `toast`, `feedback` (sounds + haptics), `confetti`, `Mascot`, `speak`, `Md`, `Icon`, formatters |
| `lib.js` | Pure shared logic: `StudyQueue`, `grade`, `charDiff`, cloze helpers, `sides`, CSV, `shuffle`. No DOM. |
| `srs.js` | FSRS-6 scheduler + `preview()` (shared with the server) |
| `md.js` | Markdown + KaTeX + DOMPurify |
| `offline.js` | Offline review queue (localStorage) and replay |
| `sw.js` | Service worker: app shell, offline API cache, push notifications |
| `theme.js` | Applies the saved theme before first paint (CSP forbids inline scripts) |
| `pages/` | One module per screen: `auth`, `home`, `course`, `set` (editor, import, bulk), `study` (all modes), `stats`, `browse` (library, tags, leeches), `groups`, `settings`, `reminders`, `admin`, `backups`, `transfer` |

## Rules

- **Components:** write them with htm tagged templates (`` html`<div>…</div>` ``), never JSX. Use hooks from the vendor bundle only.
- **Server calls:** always use `api()`. It adds the CSRF header and fires the re-auth event on a 401.
- **Routing:** hash routes like `#/course/:id`, `#/set/:id`, `#/group/:id`, `#/study?set=|course=|tag=&mode=learn|flip|write|choice|cram|match|test&dir=&starred=1&len=|min=`. Do not add a router library.
- **Service worker:** when you add or rename a module, add it to `SHELL` in `sw.js` and bump `CACHE` (`flipp-vN`). Only user-independent data and the endpoints listed in `OFFLINE_API` are cached; the API cache is cleared on sign-out.
- **Inline scripts:** no `<script>` blocks and no inline event handler attributes in `index.html`, because the CSP blocks them.
- **Card content:** render it through `<${Md} src=… />` and nothing else.

## Styling

- All styles live in `styles.css`. Do not add CSS-in-JS. Use inline `style` only for one-off layout tweaks.
- Colors come from the CSS variables in `:root`. A new color token needs values in three places:
  - the dark default in `:root`
  - `@media (prefers-color-scheme: light)` under `:root:not([data-theme="dark"])`
  - `:root[data-theme="light"]`
- Dark is the default theme. The look is playful, Duolingo/Quizlet style:
  - Rounded Nunito font (self-hosted from `@fontsource-variable/nunito` via `/vendor/nunito`), heavy weights for headings and buttons.
  - Brand violet `--brand` (admins can override it) plus a fixed fun palette: `--good`, `--bad`, `--warn`, `--blue`, `--pink`, `--star`, `--flame`. Each solid color has a `*-deep` twin.
  - Chunky 3D: 2px borders and a solid bottom edge (`box-shadow: 0 4px 0 <deep>`) that collapses on `:active`. Radii 14–26px.
  - Each study mode and each course tile has its own color (`data-mode`, `--hue` from the course id).
  - Delight is part of the product: praise in answer banners, the `Mascot` (moods happy/cheer/sleepy/sad) in empty states and summaries, `confetti()` and `feedback('win')` on wins. Keep it quick and never block input.
- Build mobile-first:
  - Touch targets must be at least 34px.
  - Respect `--top` and `--bottom` (the safe-area insets).
  - Check layouts at 390px wide and at iPad size.
- **Motion:** animate only `transform` and `opacity`. During gestures, write transforms straight to the DOM through refs instead of re-rendering, to keep 60fps. `prefers-reduced-motion` is already handled globally.

## Study logic

- **Ratings:** 1 Again, 2 Hard, 3 Good, 4 Easy. Anything ≥ 3 counts as correct in `StudyQueue`.
- **Study items** are card × variant (`key = "cardId:variant"`; variant 0 front→back, 1 reverse, n = cloze number). Use `sides(item, item.variant)` for prompt/answer. Only `scheduled` items post reviews, and only in modes with `records: true`.
- **Charts** are hand-written SVG following the dataviz rules: one sequential violet hue (`--series`, `--heat-*`), recessive grid, hover tooltip, a "Show as table" view, real pixel width (`useWidth`).
- **Weak spots:** a missed card goes back into the queue 3–5 cards later and must be answered correctly twice. Do not weaken this.
- **Keyboard shortcuts:** `Space` flips, `1`–`4` or `←`/`→` rate, `Z` undoes. Keep them consistent across modes.
