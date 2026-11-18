# eatplanner.app design spec

Status: proposal. Scope: the browser UI in `public/` and the share card. No server or data-model changes are required except where marked optional.

## 1. Where the app is today

The app is a single-page, dependency-free front end (`index.html`, `base.css`, `planner.css`, `planner.js`) with four surfaces: the weeks home, a week (planning form, then draft or locked plan with shopping list), the recipe collection, and a dialog used for recipe detail, cook mode, swap, share and the recipe editor.

What already works and should be kept:

- A clear voice: calm, warm, a little wry ("A night off.", "Setting the table...").
- Serif headlines over quiet UI text, and a restrained green identity.
- Semantic HTML, labelled controls, a native `<dialog>`, a print stylesheet.
- No build step, no third-party requests, a strict CSP.

What holds it back:

| Problem | Evidence |
| --- | --- |
| Text is too small | Body copy is 11–13px, tags and eyebrows 9px, pantry tags 8px. |
| Text is too faint | Measured against the page background: nav links 2.8:1, fine print 2.7:1, eyebrows and tags 3.1:1, muted copy 3.5:1, placeholders 2.6:1. WCAG AA needs 4.5:1. |
| One hue does everything | Background, borders, tags, panels and buttons are all sage. Nothing signals "primary", "today" or "done" apart from slightly darker sage. |
| Colours are hard-coded | About 90 hex values across two stylesheets, five variables. No dark mode is possible without a rewrite. |
| Photography is thin | 80 starter recipes share 8 photos (salmon.jpg appears 16 times), in mixed aspect ratios. A week of five dinners often shows the same picture twice. |
| Controls feel like a form | Moving a meal is a bare `<select>`, unlocking uses `window.confirm`, checkboxes are native 16px boxes, touch targets are often under 30px. |
| No motion or loading states | Views swap instantly; loading is a line of text; the grid jumps when data arrives. |
| Small gaps | Empty favicon, no sticky navigation, no mobile-specific navigation, system font stack with Georgia. |

## 2. Direction: a warm cookbook, not a dashboard

The app should feel like a well-made cookbook that happens to know your calendar: generous type, real food photography, cream paper, deep green ink, and one appetising accent colour used sparingly.

Principles:

1. **Food first.** Photos are the largest thing on any screen that has them. Chrome recedes.
2. **Readable at arm's length.** This is used on a phone in a supermarket and a kitchen. Nothing below 13px; cook mode is large enough to read from a bench.
3. **One obvious next step.** Each screen has a single filled primary button. Everything else is quiet.
4. **Calm, then delight.** Motion is short and purposeful, with a small flourish at the moments that matter (confirming a week, finishing a recipe).
5. **Keep it light.** Still plain HTML, CSS and one JS module. No framework, no CSS build, no runtime dependencies.

## 3. Foundations

All values below become custom properties in `base.css`. Component CSS must reference tokens only; no raw hex values or pixel font sizes outside the token block.

### 3.1 Colour

Contrast ratios were calculated for the pairs listed and all meet WCAG AA for their use.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#FAF7F0` | `#121814` | Page |
| `--surface` | `#FFFFFF` | `#1A221D` | Cards, dialog, inputs |
| `--surface-sunken` | `#F3EEE3` | `#161D19` | Night-off cards, cook mode, upload box |
| `--ink` | `#1C2B22` | `#EEF0E8` | Headlines, body (13.8:1 / 15.7:1 on `--bg`) |
| `--ink-muted` | `#566253` | `#A9B3A5` | Secondary text, placeholders (6.0:1 / 8.3:1) |
| `--line` | `#E6DFD0` | `#2C3830` | Dividers, card borders (decorative) |
| `--line-control` | `#8E8873` | `#6C776B` | Input and checkbox borders (3.3:1 / 3.5:1) |
| `--brand` | `#1F4D3A` | `#8FCFA8` | Primary button, active nav, links (9.0:1 / 10.0:1 as text) |
| `--brand-hover` | `#173B2C` | `#A6DCBA` | Primary hover |
| `--on-brand` | `#FFFFFF` | `#0E1F16` | Text on `--brand` (9.6:1 / 9.5:1) |
| `--brand-soft` | `#E3EDDF` | `#1F3329` | Selected day, "Locked in" tag, current week |
| `--accent` | `#B5462F` | `#F08A6E` | Today marker, step number, "Surprise me", progress (5.4:1 with white text / 6.6:1 on surface) |
| `--highlight` | `#E9B44C` | `#F2C76A` | Draft tag fill, confetti; text on it is `#1C2B22` in both themes (7.8:1 in light) |
| `--highlight-soft` | `#FBF0D6` | `#33290F` | Notices, import warnings |
| `--on-highlight-soft` | `#74500F` | `#F2C76A` | Text on notices (6.4:1 in light) |
| `--danger` | `#A33B2A` | `#F08A6E` | Error toast, inline errors (6.1:1 on `--bg`; white on it 6.5:1 in light) |
| `--scrim` | `#1C2B2299` | `#000000B3` | Dialog backdrop |

Rules:

- Green is for actions and state. Terracotta is for "now" and for delight. Saffron is for "draft / needs attention". Do not use accent colours for body text or large fills.
- Dark mode follows `prefers-color-scheme`; set `color-scheme: light dark` and swap tokens in one `@media` block. Provide `<meta name="theme-color">` in light and dark variants (`#FAF7F0`, `#121814`).
- Photos get a 1px inner border of `--line` so pale dishes don't bleed into the page.
- Dark-mode pairs not listed with a ratio above must be checked when that step is built.

### 3.2 Typography

Two self-hosted variable fonts (both SIL OFL), served from `public/fonts/` as `woff2` with `font-display: swap` and preloaded in `index.html`. Self-hosting is required: the CSP is `default-src 'self'`, so remote font hosts are blocked, and the app promises no third-party requests.

- **Display: Fraunces** (variable, optical size axis). Headlines, recipe titles, cook-mode steps, day numerals. Weight 400–500. Fallback: `Georgia, serif`.
- **Text: Inter** (variable). Everything else. Fallback: the current system stack.

| Token | Size / line height | Font | Use |
| --- | --- | --- | --- |
| `--text-display` | `clamp(2.75rem, 6vw, 4.5rem)` / 1.05 | Fraunces 400, -0.02em | Home hero |
| `--text-h1` | `clamp(2.25rem, 4.5vw, 3.25rem)` / 1.1 | Fraunces 400, -0.02em | Page titles |
| `--text-h2` | `clamp(1.625rem, 3vw, 2rem)` / 1.2 | Fraunces 400 | Section and dialog titles |
| `--text-h3` | `1.375rem` / 1.25 | Fraunces 500 | Card titles |
| `--text-step` | `clamp(1.5rem, 3.2vw, 2rem)` / 1.45 | Fraunces 400 | Cook-mode instruction |
| `--text-lg` | `1.125rem` / 1.6 | Inter 400 | Lede |
| `--text-base` | `1rem` / 1.6 | Inter 400 | Body, inputs, shopping items |
| `--text-sm` | `0.875rem` / 1.5 | Inter 400/500 | Buttons, meta, help text, nav |
| `--text-xs` | `0.8125rem` / 1.4 | Inter 600, +0.08em, uppercase | Eyebrows, tags (the minimum size) |

Rules: inputs are never below 16px (prevents iOS zoom). Use `text-wrap: balance` on headings and `text-wrap: pretty` on paragraphs. Use tabular numerals for quantities and times. Limit body line length to 65ch.

### 3.3 Space, shape, depth

- **Spacing scale** (4px base): `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 24, `-6` 32, `-7` 48, `-8` 64, `-9` 96. Section gaps use 7–9; card padding uses 5; inline gaps use 2–3.
- **Layout**: content max width 1200px; page gutter `clamp(20px, 5vw, 56px)`. Breakpoints at 640px and 960px. Grids use `repeat(auto-fill, minmax(280px, 1fr))` instead of fixed column counts.
- **Radius**: `--radius-sm` 8 (inputs), `--radius-md` 14 (small cards, popovers), `--radius-lg` 22 (cards, panels), `--radius-xl` 32 (dialog, hero image), `--radius-full` (buttons, pills, tags).
- **Elevation** (tinted with ink, never grey):
  - `--shadow-1`: `0 1px 2px #1C2B220A, 0 2px 8px #1C2B220A` for resting cards.
  - `--shadow-2`: `0 4px 12px #1C2B2212, 0 12px 32px #1C2B2212` for hover and sticky bars.
  - `--shadow-3`: `0 24px 80px #1C2B2233` for the dialog and toast.
  - In dark mode, replace shadows with a 1px `--line` border and a slightly lighter surface.
- **Hit targets**: 44×44px minimum for anything tappable.
- **Focus**: `outline: 2px solid var(--brand); outline-offset: 3px` on `:focus-visible`, on every interactive element, in both themes.

### 3.4 Motion

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(.2, .8, .2, 1)` | Entrances, hovers |
| `--ease-spring` | `cubic-bezier(.34, 1.56, .64, 1)` | Toggles, checkmarks |
| `--dur-fast` | 120ms | Hover, press |
| `--dur-base` | 220ms | Cards, toggles, toast |
| `--dur-slow` | 420ms | Dialog, view change |

- View changes use the View Transitions API (`document.startViewTransition`) where supported, with a plain swap as fallback. Give the opened card's photo a `view-transition-name` so it grows into the recipe dialog hero.
- Grids stagger in: each card fades up 8px with a 30ms delay per item, capped at 8 items.
- Buttons scale to 0.98 on press. Cards lift 2px and gain `--shadow-2` on hover; their photo scales to 1.03 inside a clipped frame.
- Under `@media (prefers-reduced-motion: reduce)` everything collapses to opacity-only or no animation.

### 3.5 Icons and imagery

- **Icons**: replace text glyphs (`→ ↗ ↻ ✓ ×`) with a small inline SVG sprite in `index.html` (Lucide style, 1.75px stroke, `currentColor`): arrow-right, arrow-left, calendar, shuffle, move, lock, unlock, share, copy, check, plus, search, clock, users, camera, sparkle, pencil, x. Icons accompany labels; they never replace them except for close.
- **Favicon and app icon**: a fork-and-leaf monogram in `--brand` on `--bg`, shipped as `favicon.svg` plus a 180px PNG touch icon.
- **Photo treatment**: every recipe image renders in a fixed frame with `object-fit: cover`: 4:3 on cards, 16:9 in the dialog hero, 1:1 in swap rows. Add `width`/`height` attributes and a `--surface-sunken` background so layout does not shift.
- **Photo variety**: the biggest visual win available. Either expand the bundled set to roughly 24 photos (three per protein group, consistent angle, natural light), or run the existing "Find a photo with Copilot" flow across the starter set. Until then, when a photo would repeat within one week or one screenful, render a typographic placeholder instead: `--brand-soft` fill, the protein icon, and the title's first letter in Fraunces.

## 4. Components

Existing class names and ids are kept wherever possible; `server/ui.test.ts` selects on `.week-card`, `.day-card`, `.day-toggle`, `.recipe-open`, `.collection-card`, `.swap-choice`, `.meal-actions select`, `.selection-count`, `.recipe-form`, `.upload-box`, `.import-warnings`, `.shopping-text`, `.share-preview`, `.cook-mode .eyebrow`, `#shopping`, `#add-recipe`, `#nav-recipes`, `#close-modal`, `#modal-content` and `#dialog-error`.

### Buttons

| Variant | Look | Use |
| --- | --- | --- |
| Primary `.button` | `--brand` fill, `--on-brand` text, `--radius-full`, 48px tall, `--text-sm` 600 | One per screen |
| Secondary `.button.secondary` | `--surface` fill, 1px `--line-control` border, `--brand` text | Alternatives |
| Quiet `.text-button` | No fill; `--brand` text; `--brand-soft` pill on hover; 44px tall | Tertiary and inline actions |
| Small `.button.small` | 40px tall, with a 44px hit area | Top bar, toolbars |

A disabled button drops to 45% opacity. A busy button (while `run()` is awaiting) swaps its icon for a 16px spinner and sets `aria-busy="true"`; its width must not change.

### Tags

Pills, 28px tall, `--text-xs`. Variants: neutral (`--surface-sunken`), `green` (`--brand-soft` / `--brand`), `draft` (`--highlight` / `#1C2B22`), `today` (`--accent` / white in light, `#0E1F16` in dark). Tags over photos use a blurred translucent `--surface` backing.

### Form controls

- Inputs and selects: 48px tall, `--radius-sm`, 1px `--line-control`, `--surface` fill; on focus the border becomes `--brand` with a 3px `--brand-soft` ring. Selects get a custom chevron (`appearance: none`).
- Labels: `--text-sm` 600 in `--ink`; help text `--text-sm` in `--ink-muted`.
- Checkboxes: custom 22px rounded box (`appearance: none`), `--brand` when checked, with the tick animated by `--ease-spring`.
- Number inputs for people and servings become a stepper: minus, value, plus, each 44px.
- Diet and time pickers become segmented controls (a radio group styled as pills) at 640px and wider; they stay as selects below that.

### Cards

Shared shell: `--surface`, `--radius-lg`, 1px `--line`, `--shadow-1`, clipped overflow.

- **Week card**: title and status tag on top; the date range; a seven-dot row where planned days are filled `--brand` and today's dot has an `--accent` ring; a two-line preview; a whole-card click target. Planned weeks show up to three overlapping 36px circular meal thumbnails (optional: needs the summary endpoint to return image paths). The current week uses a `--brand-soft` fill and a `--brand` border.
- **Day card (meal)**: 4:3 photo with the weekday and date as an overlaid pill (top left) and total time (top right); title in `--text-h3`; protein tag and category beneath. Draft actions sit in a footer row: **Swap** (shuffle icon) and **Move** (see below). Today's card gets a 2px `--accent` border and a "Tonight" tag instead of the current offset outline.
- **Day card (night off)**: `--surface-sunken`, dashed `--line-control`, the same height as meal cards on desktop and a compact 96px row on mobile. In a draft it offers a quiet "Add a dinner" action (optional: needs a server route).
- **Collection card**: 4:3 photo with the category tag overlaid; title, a two-line clamped description, then a meta row with protein, total time and diet.

### Moving a meal

Replace the bare select with a "Move" quiet button that opens a small popover (the `popover` attribute) listing the seven days as 44px rows, marking the current day and naming the meal an occupied day would swap with. Keep the existing `<select>` as the underlying control and as the fallback where popovers are unsupported, so behaviour and tests are unchanged. Stretch goal: drag a card onto another day on pointer devices.

### Navigation

- **Desktop**: sticky top bar, 72px, `--bg` at 85% opacity with `backdrop-filter: blur(12px)` and a hairline that appears only once the page has scrolled. Brand left, nav centre as a pill-style segmented control (active item on `--brand-soft`), "Add recipe" right.
- **Mobile (below 640px)**: the top bar keeps only the brand and "Add recipe". Navigation moves to a fixed bottom tab bar (Weeks, Recipes) with icon plus label, 64px plus `env(safe-area-inset-bottom)`.
- The footer becomes a single centred tagline in `--ink-muted`.

### Dialog

- Desktop: centred, max width 880px, `--radius-xl`, `--shadow-3`; enters with a 12px rise and fade while the backdrop blurs.
- Mobile: a bottom sheet, full width, top corners rounded, max height 92dvh.
- The close button is a 44px circle pinned to the dialog's top-right corner, on a blurred `--surface` backing so it stays legible over photos.
- Long dialogs (recipe editor, planning rules) get a sticky footer holding the primary action.
- Replace `window.confirm` for unlocking with a small confirmation dialog in the same style.

### Toast

Bottom centre (above the tab bar on mobile), `--ink` fill with `--bg` text, `--radius-full`, a leading icon, and a slide-up entrance. Error toasts use `--danger` and get a dismiss button, since they persist for 14 seconds.

### Loading and empty states

- Loading uses skeletons that match the final layout (three week cards, six meal cards) with a slow shimmer. Keep the playful sentence as the visually hidden status text.
- Empty and error states are centred: a simple line illustration (plate, pan or empty shelf) in `--line-control`, a Fraunces headline, one sentence, one button.

## 5. Screens

### 5.1 Home (weeks)

- **Hero**: two columns on desktop. Left: eyebrow, display headline, lede, and the primary "Plan this week" button. If this week already has a plan, the hero shows it instead: "Tonight: {recipe title}" with that meal's photo and a "Let's cook" button, so the home page is useful every day rather than only on planning day.
- Right: the hero photo in a tall arch-topped frame (keep the arch; it is the one distinctive shape in the current design), with the tilted "On the menu" note in `--highlight-soft`.
- **Your kitchen calendar**: the section title, with "Jump to a week" as a quiet calendar button that opens the native date picker. Order the cards as this week, next week, then future weeks, with past weeks under a collapsed "Earlier" disclosure. On mobile the cards form a horizontal scroll-snap row.

### 5.2 Week: planning

Keep the two numbered sections; they read well. Changes:

- Day toggles become tall pills (about 72×96px) showing the weekday, a large Fraunces date numeral and a check; selected is `--brand-soft` with a `--brand` border, and the check pops in with `--ease-spring`.
- Quick picks become three chips rather than text links.
- House rules use the stepper, segmented controls and custom checkboxes described above, laid out as rows with the label on the left and the control on the right.
- The submit bar sticks to the bottom of the viewport on mobile and shows the live count ("Plan 5 dinners").

### 5.3 Week: draft and locked plan

- **Header**: back link, date range as the H1, a meta line with icons (dinners, people), and "Share" on the right. Move "Refresh" out of the header and into the stale-revision error, which is the only time it is needed.
- **Status strip**: one slim bar under the header. Draft: `--highlight-soft` with a draft tag, the hint text and "Change rules". Locked: `--brand-soft` with a lock icon, "Locked in", and "Unlock".
- **Meal grid**: three columns on desktop, two on tablet. On mobile it becomes a vertical agenda: each day is a row with a 96px square photo on the left and the title, tags and actions on the right, so a whole week fits in about two screens.
- **Confirm bar** (draft): sticky at the bottom, `--surface` with `--shadow-2`, containing a short summary and the primary "Confirm this week" button. On confirm, play a brief confetti burst in brand, accent and highlight colours (canvas, about 900ms, skipped under reduced motion), then scroll to the list.
- **Shopping list** (locked): a `--surface` panel whose header row holds the title, a progress count ("7 of 23") with a thin `--accent` progress bar, and "Copy list". Items are 48px rows with the custom checkbox, the quantity in tabular bold, then the name; checked items strike through and fade. "Include pantry staples" becomes a switch. The plain-text textarea moves into a collapsed "Plain text for pasting" disclosure, since the Copy button covers the main case; the disclosure opens automatically when clipboard copy fails. On desktop the list splits into two columns.

### 5.4 Recipe collection

- A sticky toolbar below the top bar: a search field with a leading icon and a clear button, then category and protein as horizontally scrolling single-select filter chips ("All" first) instead of two selects. The result count sits on the right.
- The grid uses collection cards with a staggered entrance. An empty result shows the empty state with a "Clear filters" button.

### 5.5 Recipe detail and cook mode

- A 16:9 hero photo, full-bleed to the dialog edges, with a soft bottom gradient; the photo credit overlays the bottom-right corner in `--text-xs`.
- Below it: eyebrow, title in `--text-h1`, description, then a row of four stats with icons (serves, prep, cook, diet) separated by hairlines rather than four identical pills. "Edit recipe" becomes a quiet button with a pencil icon aligned to the title.
- Two columns on desktop: ingredients on the left (sticky, custom checkboxes, quantities bold and tabular) and method on the right.
- **Cook mode** sits on `--surface-sunken` with `--radius-lg`:
  - a segmented progress bar, one segment per step, filled in `--accent`;
  - "Step 3 of 7" as the eyebrow, and the instruction in `--text-step`;
  - Previous and Next as full-width 56px buttons side by side, plus left and right arrow-key support;
  - a "Focus" toggle that expands cook mode to fill the dialog, hides everything else, and requests a screen wake lock (`navigator.wakeLock`, where available) so the phone stays awake while cooking;
  - on the last step, "Ready to serve" plays the small confetti burst.
- "See the whole method" stays as a disclosure, with step numbers set in Fraunces.

### 5.6 Swap dialog

Each alternative is a 72px row with a 1:1 thumbnail, the title in `--text-h3`, and a meta line. When "overlapping ingredients" is on, show a small "Shares 3 ingredients" hint (optional: needs the alternatives endpoint to return the overlap count). "Surprise me" is a secondary button with the shuffle icon, placed above the list.

### 5.7 Recipe editor

Break the long form into three visually separate groups with their own headings:

1. **Photo**: a drop zone with a camera icon and two clear buttons ("Take or choose a photo", "Find a photo with Copilot"), a preview with its credit, and the status line. While Copilot is working, show an indeterminate progress bar beside the status text; the privacy note sits beneath in `--text-sm`.
2. **Details**: name, description, then category, protein and diet, then servings, prep and cook as steppers.
3. **Ingredients and method**: both textareas with tabular numerals, and the format help shown as a compact example block instead of one long sentence.

Import warnings use `--highlight-soft` with a warning icon. The review checkbox and the save button live in the dialog's sticky footer.

### 5.8 Share card

Redraw the 1080×1480 canvas to match the new identity: a `--bg` background; a `--brand` header band with the monogram, "This week, at our table." in Fraunces (wait for `document.fonts.ready` before drawing) and the date range; each planned day as a row with a 96px rounded photo thumbnail, the weekday in small caps and the title in Fraunces; nights off in `--ink-muted` italics; a footer line with people, dinner count and status. Drafts get a saffron "DRAFT" ribbon across the header corner. The card always uses the light palette.

### 5.9 Print

Keep the existing print rules. Additionally force the light tokens, hide the tab bar and sticky bars, print the shopping list as two columns of empty checkboxes, and print an open recipe as a clean single page (title, stats, ingredients, numbered method).

## 6. Accessibility and quality bar

- All text meets 4.5:1 and UI boundaries and icons meet 3:1, in both themes.
- A full keyboard path through plan, swap, move, confirm, shop and cook. Popovers and the dialog return focus to the control that opened them.
- State is never colour-only: selected days have a check, locked weeks have a lock icon, checked items are struck through.
- `aria-live` status for loading, and `aria-busy` on working buttons.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`. Layout holds at 200% zoom and at 320px width.
- Budgets: fonts under 150KB total (two subsetted variable `woff2` files), CSS under 30KB, no layout shift from images, no new runtime dependencies.
- Constraint: the CSP is `style-src 'self'` and `default-src 'self'`, so there are no `style` attributes in markup and no remote assets; fonts and icons are local, and styling goes through classes and tokens.

## 7. Suggested order of work

Each step is shippable on its own and should leave the tests green.

1. **Tokens and type**: introduce the token block, fonts, new sizes and colours; replace every raw hex value. This alone fixes legibility and contrast.
2. **Core components**: buttons, tags, inputs, checkboxes, cards, dialog, toast, icon sprite, favicon.
3. **Navigation and layout**: sticky top bar, mobile tab bar, fluid grids, mobile agenda view.
4. **Screens**: home hero and week cards; planning form; plan, status strip and confirm bar; shopping list; collection toolbar; recipe detail and cook mode; editor grouping; share card.
5. **Dark mode**: the token swap, then a pass over photos, shadows and contrast.
6. **Motion and delight**: view transitions, staggered grids, skeletons, confetti, wake lock.
7. **Photography**: expand or regenerate the starter photos; typographic placeholders.
8. **Optional server-backed extras**: meal thumbnails in week summaries, overlap counts in alternatives, "add a dinner" on a night off.

## 8. Out of scope

Accounts, multi-device sync, URL routing, supermarket integration, and any change to planning rules or data storage.
