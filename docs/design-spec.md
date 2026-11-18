# eatplanner.app visual design

## Direction

A warm, modern cookbook: food-first, editorial, and at home in a real kitchen.
Use cream paper, deep forest-green ink, and restrained terracotta and saffron.
Keep the arch-shaped food hero and the existing plain-language voice. Avoid
generic dashboard patterns, decorative glyphs as labels, remote assets, and
runtime dependencies.

## Foundations

- Keep all presentation in self-hosted CSS and the existing browser JavaScript.
- Centralize color, type, spacing, radius, shadow, and motion values as CSS
  custom properties. Prefer Georgia and system fonts; do not load remote fonts.
- Body copy should remain readable at 15–17px. Controls use at least 16px text,
  at least 44px touch targets, and a visible keyboard focus ring.
- Maintain readable contrast in both color schemes, respect
  `prefers-color-scheme` and `prefers-reduced-motion`, and use fluid layouts.
- Keep the strict self-hosted Content Security Policy: no inline styles/scripts,
  external assets, or style attributes.

## Components and screens

- Sticky desktop header; compact mobile bottom navigation with text labels and
  local SVG icons.
- Keep home/week cards editorial and airy; use agenda-like single-column meals
  on narrow screens while retaining all existing actions and identifiers.
- Give planning controls, status/confirmation bars, shopping checklist, recipe
  collection filters, recipe/cook dialogs, recipe editor, swap picker, and share
  card consistent hierarchy and accessible sizing.
- Provide clear loading, empty, progress, and error states. Preserve existing
  app flows, data handling, and selector-based UI tests.
- Include print-specific styling for the week and shopping list.

## Asset and implementation limits

Food photography, iconography, and the favicon are served locally. The share
card canvas follows the same forest/cream/terracotta palette as the interface.
Do not introduce a framework, backend changes, or optional planning behavior
unless it can be implemented without changing existing guarantees.
