# karmyogi — Visual Polish Plan (for review)

> Draft plan from a visual audit of every tab. **Nothing here is implemented yet.**
> Review each item, tick the ones you want, strike the ones you don't, add notes —
> then I'll execute only the approved items, verifying each in the browser
> (Playwright + screenshots) at desktop **and** phone widths, dark **and** light.

Legend: **[P1]** high impact / cheap · **[P2]** medium · **[P3]** nice-to-have.
Each box is a decision: `[ ]` = do · `[~]` = maybe · `[x]` = skip.

---

## A. Global / cross-cutting (do once, benefits every tab)

These are the biggest wins because the inconsistencies repeat on all 18 panels.

- [ ] **[P1] Unify the design tokens.** Each panel ships its own CSS prefix
  (`spr-`, `sp-`, `wr-`, `dr-`, `cc-`, …) and they have drifted: card radius,
  header height, section-title casing, slider track, icon-button size, gaps. Pull
  these into shared classes / CSS variables so every panel looks identical in
  spacing, radius, typography, and control sizing.
- [ ] **[P1] Consistent section headers.** Spring now has a glyph + title + ⓘ on
  each card; most other tabs have only a title (or a title + ⓘ). Give **every**
  card header the same `icon + UPPERCASE title + ⓘ` treatment with one glyph set.
- [ ] **[P1] Consistent header toolbar.** Standardize the per-panel top icon row
  (size, hover, active, disabled, tooltip copy). Today some are `spr-ico`, some
  `sp-ico`, some emoji. One `IconButton` style everywhere.
- [ ] **[P1] Primary-action emphasis.** The main CTA per tab (Import Gerber /
  Add point / Generate / Upload STL) should be the one accent-filled button;
  secondary actions are quiet. Several tabs render the primary action the same
  weight as everything else.
- [ ] **[P1] Friendly empty states.** Replace plain "No points yet…" text with a
  centered icon + one-line explanation + the primary CTA button. Applies to
  Soldering, Pick & Place, Welding, Glue, Drilling, Screw Fitting, Signature.
- [ ] **[P2] Live status strip everywhere.** Spring & Soldering show a pill strip
  (turns / travel / G-code lines / est. time / → Program). Extend the SAME strip
  to every generating tab (Carving, Writing, PCB, Drilling, Glue, Laser, Welding,
  Pick & Place, Screw Fitting, Signature, 3D Printing) so feedback is uniform.
- [ ] **[P2] Replace remaining emoji glyphs with SVG icons.** The Visualizer
  toolbar (⤢ ⧉ 📐 ⋯ ✛ ✂ ⇲ 🔁 ⏮ ◀ ▶ ▶▌ ⏭) and topbar (▦ ↺ 🌐 ☀ 🔔) mix emoji
  with SVG — emoji render differently per-OS and look unpolished. Move to the
  shared icon set.
- [ ] **[P2] Light-theme parity pass.** Several recently-tuned colors were picked
  for dark mode (solder PCB board, gamepad HUD, spring scene). Verify + tune all
  of them in light theme.
- [ ] **[P2] Scrollbars + focus rings.** Thin themed scrollbars on the tall panels
  (tables, console, sections list); a single visible focus-ring style for
  keyboard users.
- [ ] **[P3] Motion.** Subtle, consistent 120ms transitions on hover/active/expand;
  respect `prefers-reduced-motion`.
- [ ] **[P3] Responsive sweep.** Re-verify every tab at a phone width (the
  required desktop⇄mobile parity) after the token unification.

---

## B. Per-tab audit

### Core panels
- [ ] **[P2] Controller** — dense but functional. DRO typography could be larger /
  more tabular; jog pad buttons could be a tidier grid with clearer arrows; the
  override sliders (feed/rapid/spindle) are visually busy — group + label better.
- [ ] **[P2] Visualizer** — emoji toolbar → SVG (see A); the playback bar +
  speed buttons + "Machine live / Simulation" legend could be unified into one
  cleaner control strip; bed-size + view controls grouping.
- [ ] **[P2] Program** — section rows are functional; polish the color swatch,
  row hover, the per-section action icons, and the progress/ETA block. Sticky
  run-card already done.
- [ ] **[P3] Console** — MDI input + quick-command chips look OK; align chip sizing
  with the global token; nicer empty "No messages yet" state.

### CAM / machine tabs
- [ ] **[P1] 2D/3D Carving** — import dropzone is clear; the job list + Type/Tool
  controls need the unified card/slider treatment; STL job cards could show a
  thumbnail + nest status; primary "Import" emphasis.
- [ ] **[P2] Writing** — text field + font picker + style toggles. Make Bold/
  Italic/Underline and alignment **icon toggles**; add a small font preview;
  unify the slider rows. (Note: default text no longer auto-loads into the
  program — confirm the in-tab preview still feels right.)
- [ ] **[P2] Soldering** — already upgraded (travel-optimize, 3D PCB, click-to-
  highlight). Remaining: table density/zebra rows, approach-mode icons, align
  the toolbar with the global token, friendly empty state.
- [ ] **[P2] Screw Fitting** — full audit; apply cards/sliders/status-strip/empty
  state; confirm the operation model reads clearly.
- [ ] **[P2] Bore / Drill / Hole** — audit; status strip (holes / depth / lines /
  est.); peck-drill options grouping; empty state.
- [ ] **[P1] PCB** — Gerber-ZIP dropzone is good; polish the detected-layer list
  (role chips, the chosen layer highlighted), and group the isolation / drill /
  cutout options into clear sub-sections with the global card style.
- [ ] **[P2] Glue Dispense** — audit; bead/point controls; status strip; empty
  state; primary action emphasis.
- [ ] **[P2] Pick & Place** — pick→place point pairs; make the pairing visually
  obvious (numbered, paired rows or a connector); empty state; status strip.
- [ ] **[P2] Signature** — drawing canvas; polish pen size/clear/undo controls and
  the canvas framing; make the "draw here" affordance obvious.
- [ ] **[P3] 3D Printing** — audit; the slicer-style controls need the unified
  treatment; status strip (layers / time / filament).
- [ ] **[P2] Laser Cutting** — power/speed/passes controls; status strip; safety
  emphasis (laser-on warning styling).
- [ ] **[P2] Welding** — seam points; status strip; empty state; the same table
  polish as Soldering if it uses a point table.
- [ ] **[P2] Camera** — the "Camera off / allow camera" state should be a friendly
  centered prompt with a clear enable button; calibration-sheet + calibration
  flow could be a clearer stepped layout; live-view framing.
- [ ] **[P3] Spring Coiling** — already heavily polished this session (icon tiles,
  gear/hardware modal, editable counter, 3D coil). Only minor tightening if any.

---

## C. 3D viewer & scenes
- [ ] **[P2] Bed + grid + axes** readability in both themes; dimension label
  contrast; tool-cone legend styling.
- [ ] **[P2] Per-mode scenes** — Spring (done) and Solder PCB (done) look good;
  make sure the **generic toolpath** (carving/drill/laser/etc.) uses attractive,
  legible cut/rapid colors and that rapids vs cuts are visually distinct.
- [ ] **[P3] "Fit" for small jobs** — when a job (e.g. a PCB) is much smaller than
  the 300×200 bed, Fit frames the whole bed so the job looks tiny. Optionally
  frame the job/board tightly when one is loaded.

---

## D. How I'll execute (once you approve items)
1. Land the **global token unification (A)** first — it silently improves every tab.
2. Then per-tab items in priority order, **one tab per change set**, each verified
   in the browser at desktop + phone, dark + light, with screenshots.
3. `tsc --noEmit` + build stay green throughout; no behavior changes, visuals only.
4. No commits/deploys unless you say so.

## E. Open questions for you
1. **Scope** — do the whole list, or just **[P1]**s first?
2. **Light theme** — do you actively use it, or is dark the only one to perfect?
3. **Density** — prefer the current compact look, or a slightly roomier feel?
4. **Iconography** — OK to remove ALL emoji glyphs in favor of the SVG set?
5. Anything you definitely **don't** want touched?
