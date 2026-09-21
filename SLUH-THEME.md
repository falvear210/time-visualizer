# SLUH Theme — CSS Style Guide

A compact description of the visual system used across the SLUH Time Visualizer
(`style.css`) and the Math Office wall display (`math-office.css`). Hand this to
another chat as the design brief for slides, dashboards, or web pages that should
feel like they belong to the same family.

The look in one line: **clean, quiet, institutional. White or near-black
backgrounds, a single navy/blue accent, generous whitespace, thin hairline
borders, rounded rectangles, and one restrained animation for anything that is
"happening right now."**

---

## 1. Brand palette

SLUH's official colors. Use these exact hex values.

| Role | Name | Hex | Notes |
|---|---|---|---|
| Anchor / primary text | SLUH Navy | `#003366` | Body text on light backgrounds |
| Accent | SLUH Blue | `#005588` | Progress fills, active states, links, highlights |
| Accent (rgb tuple) | — | `0, 85, 136` | For `rgba()` glows and tints |
| Spirit / light blue | Spirit Blue | `#88ccec` | Sparingly, for gradients on live elements |
| Muted text | Dark Gray | `#777777` | Secondary/dim text on light |
| Rails & tracks | Light Gray | `#eeeeee` | Empty progress tracks, subtle fills |
| Completed / spent | Warm Gray | `#ccccbb` | "Done" state — warm, not cold |

Accent gradient (used only on "live" elements, see §6):
`#2e8bc0 → #63b3e0 → #8ecae6 → #63b3e0 → #2e8bc0`

Do **not** introduce additional brand hues. The only colors outside this palette
are the multi-color celebration gradient (`#f59e0b, #fb7185, #a78bfa, #34d399`)
and confetti, both of which are momentary.

---

## 2. Design tokens (CSS custom properties)

Every color is a `var()`, never a literal (except the momentary gradients above).
Define the palette once on `:root`, then theme by swapping token values.

```css
:root {
  --accent: #005588;          /* SLUH Blue */
  --accent-rgb: 0, 85, 136;   /* for rgba() */
}

/* LIGHT (the canonical look for slides / kiosks in lit rooms) */
:root, [data-theme="light"] {
  --bg: #ffffff;
  --panel: #ffffff;           /* or #f7f7f5 for a barely-there card */
  --border: #dcdcd6;          /* warm hairline */
  --track: #eeeeee;           /* empty progress rail */
  --text: #003366;            /* navy */
  --text-dim: #777777;
  --done: #ccccbb;            /* spent / completed */
  --overlay-bg: rgba(0, 51, 102, 0.35);
  color-scheme: light;
}

/* DARK (app default; optional for slides) */
[data-theme="dark"] {
  --bg: #0b0b0d;
  --panel: #17181c;
  --border: #232429;
  --track: #1c1d21;
  --text: #e7e7ea;
  --text-dim: #6c6d74;
  --done: #35363d;
  --overlay-bg: rgba(0, 0, 0, 0.55);
  color-scheme: dark;
}
```

For a slide deck, **light is the default**. Only wire up dark if the deck needs it.

---

## 3. Typography

- **Font stack:** system UI only — no web fonts.
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- **Weights:** 400 body, 600 for labels/subheads, 700 for numbers and emphasis.
- **Numbers:** always `font-variant-numeric: tabular-nums` on clocks, counters,
  percentages, day counts — anything that updates in place.
- **Section headings** (the small ones above a card): uppercase, dimmed, tracked.
  ```css
  h2 {
    font-size: 1.05rem;
    color: var(--text-dim);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  ```
- **Page title (`h1`):** sentence case, normal weight, ~1.85rem. Not shouty.
- **Hero numbers** (countdown clocks): 5–5.4rem, weight 700, colored `--accent`.
- **Scale for reference (kiosk):** date 1.2rem · body 1.15rem · subheads 1.05rem ·
  clock 2.1rem · big countdown 5.4rem. For a normal-density web page the base
  drops to ~0.85rem with headings at 1rem.

---

## 4. Layout & shape

- **Border radius:** `12px` for cards/panels, `10px` for large segments,
  `6px` for buttons/inputs, `3px` for tiny grid squares, `999px` for pills and
  progress tracks. Pick from that set; don't freehand radii.
- **Borders:** always `1px solid var(--border)` — a hairline, never heavier
  (large dashboard segments use `2px`). Borders do the separating; shadows are
  reserved for overlays.
- **Shadows:** only on floating UI (tooltips, modals):
  `0 8px 24px rgba(0,0,0,0.45)` / `0 20px 50px rgba(0,0,0,0.35)`. Flat elements
  cast no shadow.
- **Cards / panels:**
  ```css
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.2rem 1.4rem;
  }
  ```
- **Spacing rhythm:** gaps and padding in multiples of ~0.3rem — commonly
  `0.3, 0.6, 0.9, 1.2, 1.5rem`. Card gutters `1.3–1.9rem`.
- **Content width:** reading layouts cap at `max-width: 720px` centered;
  dashboards at `1100px`.
- **Header pattern:** flex row, `align-items: baseline`,
  `justify-content: space-between`, a `1px` bottom border, title left / meta right.
- **Full-screen layouts** (kiosk / slide): size everything with flex/grid `fr`
  units + `min-height: 0` so it fits one 16:9 frame exactly and never scrolls;
  `overflow: hidden` on `html, body`.

---

## 5. Components

### Progress bar
The signature element. Rounded rail + rounded fill, both fully pill-shaped.

```css
.bar-track {
  height: 10px;              /* 14–16px on a dashboard, 22px solo */
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  width: 0%;                 /* driven inline as a percentage */
  background: var(--accent); /* or var(--navy) for a static/complete bar */
  border-radius: 999px;
}
```
Label row above the bar: flex, baseline-aligned, label left, `%` right in
`--accent` with tabular numerals.

### Countdown / hero clock
Centered. Small dim label, huge `--accent` number, small dim sub-line.
```css
.countdown-clock {
  font-size: 5rem; font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
```

### Grid of squares ("year at a glance" / heatmap)
Tiny rounded cells that fill from the bottom.
```css
.square {
  width: 14px; height: 14px;
  border-radius: 2px;
  background: var(--track);
  border: 1px solid var(--border);
  overflow: hidden;
}
.square-fill {                /* absolutely positioned, grows in height */
  position: absolute; left: 0; bottom: 0;
  width: 100%; height: 0%;
  background: rgba(var(--accent-rgb), 0.4);
}
.square.is-live { border-color: var(--accent); }
.square.is-live .square-fill { background: var(--accent); }
```
Section breaks in a grid: a full-width `border-top: 1px dashed var(--border)`.

### Choropleth / pin map (mcl-office)
An inline SVG world map. Unshaded land is a warm off-white
(`--map-land: #e7e7e1`), country outlines a `#ffffff` hairline, water
transparent (the panel shows through). A "selected" set of countries takes a
solid `var(--accent)` fill — no per-country hues, no gradient. Location pins
are a 20px `var(--accent)` disc with a `2px #fff` ring and a white numbered
label; a secondary pin kind may use the celebration amber `#f59e0b`. Keep
motion to the panel-level cross-fade already used for rotating content — no
per-shape fill transitions.

### List rows (people, breaks, schedule)
```css
.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--border);
  font-size: 1.15rem;
}
.row:last-child { border-bottom: none; }
.row .secondary { color: var(--text-dim); }
.row.is-active { color: var(--accent); font-weight: 700; }
```

### Buttons / pills / chips
Ghost style: transparent or `--track` background, `1px` border, dim text.
Active/selected = keep it subtle: `border-color: var(--accent)` and
`color: var(--text)` — the accent shows as a border, not a fill. The one
exception is a small chip that flips to a solid `--accent` background with
white text when chosen.

### Tabs
Text-only, dim; active tab gets `color: var(--text)` and a
`2px solid var(--accent)` bottom border sitting on the tab strip's own
`1px` border.

### Overlay / modal
`position: fixed; inset: 0`, tinted scrim from `--overlay-bg` (navy-tinted in
light, black in dark), centered panel with `12px` radius and a soft shadow.

### Tooltip / info panel
`--panel` background, `1px` border, `8px` radius, `0.72rem` dim text,
`box-shadow: 0 8px 24px rgba(0,0,0,0.45)`, `pointer-events: none`.

---

## 6. Motion

Motion is **rare and meaningful**. Static by default; movement means "this is
live right now."

- **Live state** — a shimmering horizontal gradient on the element that is
  currently active (the ongoing class period, the current lunch wave):
  ```css
  .is-live .bar-fill {
    background: linear-gradient(90deg,
      var(--accent), rgba(var(--accent-rgb), 0.5), var(--accent));
    background-size: 300% 100%;
    animation: live-shift 4s ease infinite;
  }
  .is-live .bar-label { color: var(--accent); font-weight: 700; }

  @keyframes live-shift {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  ```
  A richer multi-stop blue gradient (`#2e8bc0 → #8ecae6 → …`) is used on the
  kiosk version.
- **Celebration** — when a bar just hit 100%, briefly swap the fill for a
  moving 4-color gradient (`#f59e0b, #fb7185, #a78bfa, #34d399`) over ~3s and
  tint the `%` amber.
- **Confetti** — fixed-position, `pointer-events: none`, `z-index: 200`;
  small 8×14px rectangles that fall with `translate(var(--drift), 105vh)
  rotate(var(--rot))` over a linear timeline, then stop. Momentary only.
- **Fades** — content that rotates in a box cross-fades with
  `transition: opacity 0.25s ease` toggling an `.is-fading` class to `opacity: 0`.
- **Live indicators also get a ring**, not just color:
  `box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.25)` and
  `border-color: var(--accent)`.

No hover animations, no entrance animations, no parallax, no easing longer than
`0.25s` outside the two infinite "live/celebrate" loops.

---

## 7. Applying this to slides

- Background `#ffffff`; body text `#003366` (navy); never pure black.
- One accent, `#005588`, for every highlight, bar, key number, and rule line.
- Slide titles: sentence case, navy, medium weight. Kicker/eyebrow labels:
  uppercase, `#777777`, `letter-spacing: 0.04em`.
- Dividers and table rules: `1px solid #dcdcd6`. Nothing heavier.
- Cards / callout boxes: white (or `#f7f7f5`), `1px` border, `12px` radius,
  `~1.3rem` padding, no shadow.
- Data bars: pill-shaped, `#eeeeee` track, `#005588` fill.
- Big stat numbers: 700 weight, `#005588`, tabular numerals.
- "Completed / past / spent" quantities: warm gray `#ccccbb`.
- Use whitespace, not boxes, as the primary way to group things.
- Reserve any motion for the single item that is "current."
