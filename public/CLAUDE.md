# public/

The frontend is plain ES modules with no build step. Preact and htm come from `/vendor/htm-preact.js`. Imports use absolute paths (`/ui.js`, `/vendor/...`).

| File | Role |
|---|---|
| `app.js` | Hash router, auth screens, Home / Course / Set / Settings / Admin pages, `Shell` |
| `study.js` | Study entry plus the Learn / Flashcards / Write / Match modes and the session summary |
| `lib.js` | Pure shared logic: `StudyQueue`, `grade`, `levenshtein`, CSV parse/format, `shuffle`. No DOM, no Node APIs. Tested by `server/core.test.js` |
| `ui.js` | `api()`, `useAsync`, prefs, theme, `toast`, `feedback` (sound/haptics), `speak` (TTS), `Md`, `Icon` |
| `md.js` | Markdown + KaTeX + DOMPurify |
| `sw.js` | Service worker: precaches the app shell, serves other files stale-while-revalidate, never caches `/api` |
| `theme.js` | Applies the saved theme before first paint (CSP forbids inline scripts) |

## Rules

- **Components:** write them with htm tagged templates (`` html`<div>…</div>` ``), never JSX. Use hooks from the vendor bundle only.
- **Server calls:** always use `api()`. It adds the CSRF header and fires the re-auth event on a 401.
- **Routing:** hash routes look like `#/course/:id`, `#/set/:id`, `#/study?set=|course=&mode=learn|flip|write|match&starred=1`. Do not add a router library.
- **Service worker:** when you add or rename a shell file, update `SHELL` in `sw.js` and bump `CACHE` (`flipp-vN`).
- **Inline scripts:** no `<script>` blocks and no inline event handler attributes in `index.html`, because the CSP blocks them.
- **Card content:** render it through `<${Md} src=… />` and nothing else.

## Styling

- All styles live in `styles.css`. Do not add CSS-in-JS. Use inline `style` only for one-off layout tweaks.
- Colors come from the CSS variables in `:root`. A new color token needs values in three places:
  - the dark default in `:root`
  - `@media (prefers-color-scheme: light)` under `:root:not([data-theme="dark"])`
  - `:root[data-theme="light"]`
- Dark is the default theme. The look is minimal, Linear/Raycast style: neutral greys, one accent (the text color), 1px borders, 10–20px radii, no gradients.
- Build mobile-first:
  - Touch targets must be at least 34px.
  - Respect `--top` and `--bottom` (the safe-area insets).
  - Check layouts at 390px wide and at iPad size.
- **Motion:** animate only `transform` and `opacity`. During gestures, write transforms straight to the DOM through refs instead of re-rendering, to keep 60fps. `prefers-reduced-motion` is already handled globally.

## Study logic

- **Ratings:** 1 Again, 2 Hard, 3 Good, 4 Easy. Anything ≥ 3 counts as correct in `StudyQueue`.
- **Weak spots:** a missed card goes back into the queue 3–5 cards later and must be answered correctly twice. Do not weaken this.
- **Keyboard shortcuts:** `Space` flips, `1`–`4` or `←`/`→` rate, `Z` undoes. Keep them consistent across modes.
