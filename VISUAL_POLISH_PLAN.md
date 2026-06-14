# karmyogi — Visual Polish Plan (living status)

> Audit of every tab → polish pass. **Most of this is now DONE** (verified in the
> browser, desktop + dark/light, `tsc` + build green, no behavior changes).
> Philosophy throughout: **sleek, compact, space-optimized** — fit more on screen,
> scroll less.

Legend: **[x] = done** · **[ ] = remaining** · **[~] = intentionally skipped**.
Priority tags: **[P1]** high · **[P2]** medium · **[P3]** nice-to-have.

---

## A. Global / cross-cutting
- [x] **[P1] Unify design tokens.** `theme.css` already centralizes spacing/color/
  sizing; added a shared **`cam.css` + `CamUI` foundation** (status strip, empty
  state, primary button, section glyph) so panels share one look.
- [x] **[P1] Consistent section headers.** Accent `cam-card-ico` glyphs on card
  titles across all panels.
- [x] **[P1] Primary-action emphasis.** One accent-filled `cam-primary` CTA per tab.
- [x] **[P1] Friendly empty states.** Shared compact `CamEmpty` (icon + title +
  hint + CTA) on Soldering, Pick & Place, Welding, Glue, Drilling, Screw Fitting,
  Signature, Carving, Laser, PCB, Print, Camera.
- [x] **[P2] Live status strip.** Shared `CamStatus`; panels that already had an
  equivalent kept theirs (no new bulk).
- [x] **[P2] Replace emoji glyphs with SVG.** Visualizer toolbar + playback, top
  bar, Program, Console, PanelLauncher, NotificationBell, LanguageSwitcher, USB
  downloads — all SVG/`Icon` now. (Jog-pad arrows `↖↗↙↘` kept: plain Unicode
  direction labels, render consistently — not pictographic emoji.)
- [x] **[P2] Light-theme parity.** Verified across the polished areas + the 3D
  solder board / spring colors.
- [x] **[P2] Scrollbars + focus rings.** Already global in `globals.css`.
- [ ] **[P1] Consistent header *toolbar button* style.** Section-header icons are
  unified, but each panel still defines its own near-identical `*-ico` toolbar
  button CSS. They already *look* alike; folding into one `.cam-ico` class is a
  low-visual-impact cleanup. (Minor residual.)
- [ ] **[P3] Motion.** Subtle 120ms hover/active/expand transitions; respect
  `prefers-reduced-motion`. ← doing now
- [~] **[P3] Responsive sweep.** Spot-checked during the pass; a formal phone-width
  re-verify of all 18 tabs can follow if wanted.

---

## B. Per-tab — all polished (empty states / primary / section icons /
## compaction / emoji as applicable)
- [x] **Controller** — compacted (DRO/jog/overrides/gamepad), tighter rhythm.
- [x] **Visualizer** — emoji→SVG, control strips compacted, readable menu on-state,
  distinct Play vs Next-segment transport icons.
- [x] **Program** — emoji→SVG, section rows + progress compacted.
- [x] **Console** — emoji→SVG.
- [x] **2D/3D Carving** — empty state + primary + section icons.
- [x] **Writing** — alignment emoji→SVG glyphs, sleek slider rows, section icons.
- [x] **Soldering** — (travel-optimize + 3D PCB + click-highlight earlier) + empty
  state + section icons.
- [x] **Screw Fitting / Bore-Drill-Hole** — empty states + primary + section icons.
- [x] **PCB** — inviting upload empty state, primary, section icons.
- [x] **Glue / Pick & Place / Laser / Welding / Signature / 3D Printing** — empty
  states + primary + section icons (kept existing status strips).
- [x] **Camera** — friendly "camera off" prompt + enable button; fixed a `.cam-empty`
  class collision; stage keeps its 4/3 frame.
- [x] **Spring Coiling** — heavily polished earlier (icon tiles, hardware modal,
  editable counter, 3D coil).

---

## C. 3D viewer & scenes
- [ ] **[P3] Generic-toolpath colors** — make cut vs rapid visually distinct +
  attractive in both themes (Spring & Solder scenes already polished). ← doing now
- [ ] **[P3] "Fit" for small jobs** — frame the loaded job/board tightly when it's
  much smaller than the 300×200 bed (so a PCB/coil isn't tiny). ← doing now
- [~] **[P2] Bed + grid + axes** — already legible in both themes; revisit only if
  a specific contrast issue shows up.

---

## Remaining work (this pass)
1. Motion transitions (global, subtle, compact).
2. Generic-toolpath cut/rapid colors.
3. "Fit" frames small jobs tightly.
(Optional later: the `.cam-ico` toolbar-button-style fold-up; a formal phone-width sweep.)

## Open items for you
- Commit this large batch? Drop the leftover backup `stash@{0}`?
