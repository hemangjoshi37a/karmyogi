# karmyogi — Enterprise-Grade UI/UX Upgrade Plan

> Single source of truth for taking karmyogi from "powerful internal tool" to
> "shipped enterprise product." Built from a 7-area expert audit (every tab,
> panel, modal, both themes, desktop + mobile) and verified against the real
> codebase (`src/styles/theme.css`, `globals.css`, `src/components/cam/CamUI.tsx`,
> `src/components/Modal.tsx`, `src/panels/ControllerPanel.tsx`).
>
> **This is presentation/UX only.** No features are removed, and **no
> currently-visible control disappears from the default view without a labeled
> way back to it.** See [§6 Non-goals / guardrails](#6-non-goals--guardrails).
> Items the user may want to drop are marked **✂️ CUT?**; everything else is
> **🔲 KEEP**.
>
> **Normative anchor:** [§2.8 Standard control specs](#28-standard-control-specs-the-canonical-kit)
> is the single canonical kit. Every workstream cites it; no workstream re-opens
> a recipe it pins. [§7 Acceptance gates](#7-acceptance-gates-per-phase-exit-bar)
> defines the grep-able + visual exit bar per phase.

---

## 1. Executive summary

### 1.1 Current state (per-area audit scores)

| # | Audited area | Score | Headline problem |
|---|---|:---:|---|
| 1 | App shell, top bar & global chrome | **3.5 / 5** | Flat undifferentiated toolbar; **no global focus ring**; stray "active" border on Reset |
| 2 | Core dock panels (Controller, Program, Console, Visualizer) | **3.5 / 5** | **No focus ring**; destructive Stop not color-coded; debug-looking keyboard-help paragraph |
| 3 | CAM file tabs (2D/3D Carving, PCB, Laser) | **3.5 / 5** | Slider track squeezed to a stub; labels truncate; 3 segmented-control idioms |
| 4 | Point/teach tabs (Soldering, Screw, Drill, Glue, Pick&Place, Weld, Spring) | **3.0 / 5** | Shared `CamStatus`/`CamEmpty` kit exists but **adoption is partial**; ~7× duplicated CSS; scrambled prefixes |
| 5 | Modals & overlays (Gamepad, Machines, Motion, AI) | **3.0 / 5** | **Double header** on Motion; no shared footer; zero body padding; tiny close button |
| 6 | Responsive (mobile) shell & dark/light theme parity | **3.0 / 5** | Tab strip overflows with no affordance; dense panels don't reflow; light theme inherits dark shadows |

**Average ≈ 3.25 / 5.** The recurring verdict across all seven auditors: *the
components are individually polished, but the system is inconsistent.* Nothing
is broken; it reads as several capable apps sharing a palette rather than one
finished product.

### 1.2 Design vision — what "finished, enterprise-grade karmyogi" looks like

- **One control language.** A single segmented control, one slider+number field,
  one card, one section header, one table, one status strip, one empty state, one
  busy/error state — reused by all 18+ tabs and every modal. A user who learns the
  Soldering tab already knows the PCB, Laser and Welding tabs.
- **Keyboard-first and accessible.** Every interactive element has a visible
  focus ring; segmented controls are arrow-key navigable; contrast passes AA in
  both themes; machine-state changes are announced to screen readers; touch
  targets ≥ ~40px on mobile. (This is a machine-control app — keyboard operation
  and state awareness are headline features, so invisible focus or a silent ALARM
  is a critical miss, not a nicety.)
- **Nothing important hides.** Disclosures may *tidy* dense surfaces, but every
  collapsed control keeps a persistent, labeled affordance and remembers its
  open/closed state (see §6 disclosure rule). No first-time user can lose a
  capability simply by never discovering it.
- **Calm density.** Compact desktop rhythm (the existing token system is good),
  but with grouping/whitespace/dividers so dense surfaces read as
  *information-architected*, not *crammed*. Linear/Vercel/Figma-grade chrome.
- **Complete state coverage.** Empty, loading/busy, error, and disabled-with-reason
  states are all designed, not just the happy path.
- **True dark/light parity.** Light theme is deliberately designed (its own
  elevation + shadow tokens), not a recolor that inherits dark-tuned shadows.
- **One mental model desktop ⇄ mobile.** Same controls, labels, and "which
  panel am I on" cue; only arrangement changes.

### 1.3 Headline themes (the cross-cutting work)

1. **Inconsistent control language across the point/CAM/doc tabs** — segmented
   controls, sliders, section headers, status strips and empty states are
   re-implemented 4–7 times each, under crossed CSS prefixes. *Biggest single
   lever.* (Areas 3, 4, 5)
2. **Accessibility floor** — there is **no global `:focus-visible` ring** on
   `button/input/select` in `globals.css` (confirmed: only `.skip-link`,
   `.mobile-tab`, `.mobile-panel` have rings), **no `aria-live` region anywhere**
   (confirmed: 0 matches in `src/components`), and segmented controls are plain
   tab-stops with no roving tabindex/arrow-key nav. (Areas 1, 2, 3, 4, 5, 6)
3. **Spacing rhythm & density** — slider tracks squeezed to stubs, modal body
   with zero padding, flat ungrouped toolbars, double headers. (Areas 1, 2, 3, 5)
4. **Typography scale** — modal titles same size as toolbar labels; section
   micro-labels low-contrast; four header treatments for the same concept.
   (Areas 2, 3, 4, 5)
5. **Light-theme parity** — `--bg-elev` == `--bg-panel` == `#fff` (no elevation
   steps), dark-tuned `rgba(0,0,0,.55)` shadows, faint accent slider fill.
   (Areas 3, 5, 6)
6. **Destructive & state affordances** — Stop/abort/clear not color-coded;
   toggle vs momentary buttons look identical; persistent accent borders read as
   "selected"; no busy/error chrome for async work. (Areas 1, 2, 4)

---

## 2. Design-system foundation (the backbone)

The token layer already exists and is good (`src/styles/theme.css` density +
theme tokens; `globals.css` base controls). The work is to **fill gaps,
add a small number of missing tokens, and align the `.cc-*`/`.sp-*`/`.pp-*`/
`.pr-*`/`.cam-*` class families to them** — not to rewrite the system.

### 2.1 Spacing scale — **KEEP, extend**

Existing `--sp-1:4` `--sp-2:6` `--sp-3:8` `--sp-4:12` are fine. Add the two
larger steps modals/cards need:

```css
/* theme.css :root (theme-independent) */
--sp-5: 16px;   /* modal body gutter, card group gap */
--sp-6: 24px;   /* section separation, dialog footer */
```

### 2.2 Type scale — **KEEP density tokens, add a title ramp**

Existing `--fs-section:10.5` `--fs-label:11` `--fs-ctl:12` `--fs-body:12`
`--fs-mono:11.5` stay. The gap auditors flagged is **no title size** above
toolbar text (modal titles are 13px, same as section labels). Add:

```css
--fs-title:    15px;   /* modal / overlay / popover dialog title */
--fs-title-lg: 17px;   /* primary page-level title (optional) */
--lh-tight: 1.25;      /* titles */
--lh-body:  1.45;      /* body / hints */
--fw-label: 600;       /* uppercase section labels (was unstated) */
--fw-title: 600;
```

Weights: section micro-labels bump to **600/700** to fix the low-contrast
recede (audit core-dock typography finding); titles **600**.

### 2.3 Color roles — both themes — **KEEP roles, fix light elevation + add semantic borders**

Current roles (`--bg`, `--bg-elev`, `--bg-panel`, `--bg-input`, `--fg`,
`--fg-muted`, `--border`, `--accent`, `--accent-fg`, `--danger`, `--warn`,
`--ok`) are the right set. Three fixes:

| Token | Dark (keep) | Light (today → proposed) | Why |
|---|---|---|---|
| `--bg-panel` | `#1e2227` | `#ffffff` → `#ffffff` | — |
| `--bg-elev` | `#23272e` | `#ffffff` → **`#fbfcfd`** | give light **3 elevation steps** like dark (audit 6) |
| `--bg-card` *(new)* | `= --bg-elev` | `= --bg-elev` | one canonical card fill; unifies `.wr-card`/`.sig-card`/`.print-section`/`.cam-card` (audit 5) |
| `--border` | `#333a44` | `#d4dae1` → **`#c9d0d8`** | crisper light card edges (audit 3) |
| `--accent` | `#2dd4bf` | `#0e7c66` → consider **`#0b6d59`** **✂️ CUT?** | lift white-on-accent text above 4.5:1 (audit 6 a11y); test first |

> **Dependency — accent vs a11y (resolves the "CUT? vs KEEP" tension):** The
> two-tone focus ring (§2.6) and white-on-accent text both rely on the accent
> having contrast headroom. **Decision:** *If the `--accent` darkening is cut,*
> then (a) the §2.6 two-tone ring becomes **REQUIRED, not optional**, and (b)
> white-on-accent text (`.cam-primary`, `.pp-stream`, `.mobile-tab.active`, active
> pills) must use **≥14px / 600 weight** to hold AA at the current `#0e7c66`.
> *If the darkening ships,* the 14px/600 floor is a nicety, not a requirement.
> Exactly one of {darken accent} / {two-tone ring + 14px-600 floor} is mandatory;
> they are not both optional.

Add **semantic border tints** so destructive/warn controls don't need bespoke
rules per panel:

```css
--border-danger: color-mix(in srgb, var(--danger) 55%, var(--border));
--border-warn:   color-mix(in srgb, var(--warn) 50%, var(--border));
--accent-soft:   color-mix(in srgb, var(--accent) 14%, var(--bg-input)); /* tonal/secondary fill */
```

### 2.4 Radii — **KEEP, enforce two values only**

`--radius:6px` (cards) and `--radius-sm:4px` (inner controls) already exist.
**Audit fix:** stop the drift — base `button` is `radius:4px`, but `.dro`,
`.pp-section` use 6px, `.mc-seg` 5px, `.fv-card` 9px, `.fv-op-btn` 5px. Reconcile
to the two tokens: inner controls → `--radius-sm`, cards/sections → `--radius`.

### 2.5 Elevation / shadow — **NEW, theme-aware** (fixes muddy light shadows, audit 6)

```css
/* dark */
--shadow-1: 0 2px 8px -2px rgba(0,0,0,.5);
--shadow-2: 0 18px 48px -12px rgba(0,0,0,.55), 0 4px 12px -6px rgba(0,0,0,.4);
/* light */
--shadow-1: 0 1px 3px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.06);
--shadow-2: 0 12px 32px -8px rgba(16,24,40,.16);
```

Replace the hardcoded `rgba(0,0,0,0.55)` in `pwa.css` (`.km-pwa-card`) and the
gamepad/modal glass shadows with `var(--shadow-2)`.

### 2.6 Focus ring — **NEW, single global rule** (the #1 cross-cutting fix)

Add **once** in `globals.css` with low specificity so component CSS can still
override:

```css
:where(button, a, input, select, textarea, [role="button"], [tabindex], .icon-btn, .dv-tab):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: inherit;
}
/* inset variant for full-bleed/overflow-clipping controls */
:where(.mc-seg button, .pt-speed-btn, .cam-seg-btn, .mobile-tab):focus-visible {
  outline-offset: -2px;
}
/* two-tone ring on accent-filled controls so the ring doesn't vanish on accent bg
   (REQUIRED if the §2.3 accent darkening is cut — see §2.3 dependency note) */
:where(.mobile-tab.active, .cam-primary, .pp-stream):focus-visible {
  outline-color: var(--accent-fg);
}
```

> **Specificity caveat — dockview tabs (verified):** dockview tabs are styled by
> `.dockview-theme-karmyogi .dv-tab` (`globals.css:289`), specificity **0-2-0**.
> The `:where(.dv-tab)` rule above is specificity **0-0-0** and **will be
> overridden** — the ring may silently not render. **Rule:** scope the tab ring
> under the theme class so it wins:
> `.dockview-theme-karmyogi .dv-tab:focus-visible { outline: 2px solid var(--accent); outline-offset:-2px; }`.
> W-A must Playwright-Tab through the dock strip to confirm the ring actually
> appears (see §7 Phase-1 gate).

Keep existing slider-thumb box-shadow rings as the model for range inputs.

### 2.7 Motion / easing — **NEW, with reduced-motion gate** (audit 2, 5)

```css
--ease: cubic-bezier(.2,.6,.2,1);
--dur-fast: 120ms;   /* hover/border/bg */
--dur-mid:  160ms;   /* modal enter, disclosure */
```

Authoring contract — **every** new transition lives behind the reduced-motion
gate, expressed as code (not just prose), so reviewers can grep for it:

```css
/* Base button hover (audit 2 — hovers currently snap) */
button {
  transition:
    border-color var(--dur-fast) var(--ease),
    background    var(--dur-fast) var(--ease),
    color         var(--dur-fast) var(--ease);
}
/* Modal enter */
.km-modal-scrim { transition: opacity var(--dur-mid) var(--ease); }
.km-modal[data-enter] { transition: transform var(--dur-mid) var(--ease), opacity var(--dur-mid) var(--ease); }
/* Disclosure caret */
.ui-caret { transition: transform var(--dur-fast) var(--ease); }

@media (prefers-reduced-motion: reduce) {
  button,
  .km-modal-scrim,
  .km-modal[data-enter],
  .ui-caret { transition: none; }
  /* and: no scale/opacity keyframes on modal enter */
}
```

The codebase already honors reduced-motion for the shimmer; this extends the same
gate to the modal enter (scrim fade + panel `scale(.98→1)`), the base-button
hover, and the disclosure caret.

### 2.8 Standard control specs (the canonical kit) — **NORMATIVE**

> This is the single source of truth for control recipes. Every "decide ONCE"
> question is **decided here**; workstreams cite the row, they do not re-open it.

| Control | Spec (tokenized) | Today's drift to fix | Replaces |
|---|---|---|---|
| **Button (base)** | `min-height: var(--ctl-h)` 28px · `radius: --radius-sm` · transition (2.7) · focus ring (2.6) | 28/30/26px heights; 4 vs 6 vs 7px radii | — |
| **Primary button** | solid `--accent`/`--accent-fg`, `--ctl-h-lg` 34px | Camera primary is translucent tint (audit 5); align all | `.sig-btn.primary`, `.print-btn.primary`, `.cam-primary`, `.pp-stream` |
| **Small control** | add `--ctl-h-sm: 26px` for speed/search/chip controls (audit 2) | `.pt-speed-btn` 26 vs `.chat-chip` 24 | — |
| **Segmented control** | active = `--accent`/`--accent-fg`; inactive = `--bg-input`/`--fg`; 1px `--border` seam; `--ctl-h`; `--radius-sm`. **Mode switches use `--accent-soft` tint** (so only true primaries are full-accent). **Keyboard:** real `<button role="radio">` children inside `role="radiogroup"`; **roving tabindex** (selected = `tabindex 0`, rest `-1`); **Left/Up → prev, Right/Down → next**, Home/End to ends, selection follows focus. | 7+ idioms: `.mc-seg`, `.pt-speed`, `.cc-opseg`, `.laser-seg`, `.pcb-zmode`, `.pcb-stage-btn`, `.wr-seg`, `.cam-seg-btn`, `.sig-mode`, `.pr-seg-btn`. (Verified: `.mc-seg` children are real `<button aria-pressed>` in a `role="group"` span — currently plain tab-stops, **no roving tabindex / arrow nav**.) | one `.ui-seg` / `<SegControl>` |
| **Slider + number field** | label `flex-basis ~64–72px` (wrap to 2 lines, no ellipsis) · slider `min-width: 72px` · number frame `~64px` · one inline progress var `--pct` · thumb focus ring | label 86–104px + number 76–96px squeeze track to its 34px min (stub); 4–7 duplicate impls; var named `--mc-pct` vs `--pct` | one `.ui-sfield`/`.ui-slider` / `<SliderField>` |
| **Card** | `background: --bg-card` · `border: 1px --border` (**border only — NO drop shadow on resting cards**) · `radius: --radius` · `padding: --pad-card-y --pad-card-x` | `--bg` vs `--bg-elev` vs `color-mix`; `.fv-card` 9px | `.cc-section`, `.wr-card`, `.sig-card`, `.print-section`, `.cam-card`, `.fv-card` |
| **Section header** | uppercase `--fs-section` · `--fw-label` (600) · `letter-spacing .5px` · raised contrast `color-mix(--fg-muted 70%, --fg)`. **Decided:** **NO bottom border** (cards already carry the edge; a border would double up). **Leading glyph: OPTIONAL, muted, 14px** — when present it is `--fg-muted`, never accent, sized 14px. | 4–6 header styles; some bordered some not; some icon-led some not; Spring uses accent leading icons | one `.ui-sec-head` |
| **Table** | sticky head · zebra optional · shared bulk-edit header trigger (`.cam-bulk-pop`) ≥24px | bulk-edit only in Soldering; `flex:1` body inconsistent | one `<CamTable>` |
| **Status strip** | the existing **`<CamStatus>`** + `.cam-status` | 7 hand-rolled `.sp/.swd/.scf/.wp/.pp/.spr/.gp-status` | `<CamStatus>` (already exists, 0 adopters) |
| **Empty state** | the existing **`<CamEmpty>`** (icon + title + hint + CTA) | Soldering uses bare `<p class="sp-empty">`; Camera shows black void | `<CamEmpty>` (exists, 5/7 adopters) |
| **Busy / loading** *(new — W-Q)* | `<CamBusy>` spinner|skeleton + one-line label, `aria-busy` on the container | none today (parse/solve/stream show nothing) | one `<CamBusy>` |
| **Error** *(new — W-Q)* | `<CamError>` = `CamEmpty` variant: danger glyph + message + **retry CTA** | inline ad-hoc / silent failures | one `<CamError>` |
| **Icon button** | `--icon-btn` 28px square · neutral border · accent only on hover/active/focus | Reset has persistent accent border; `.fv-op-btn` 5px | `.icon-btn`, `.km-modal-close`, `.*-ico` |
| **Modal** | `size: sm/md/lg/xl` (460/620/780/960) · body `padding: --sp-5` (+`--flush` modifier) · title `--fs-title` + eyebrow slot · **sticky footer: secondary/ghost buttons LEFT-aligned, primary RIGHT-aligned, `gap: --sp-3`** · close = **28–32px square icon button** (icon already present) · enter transition · focus-trap + focus-restore (already implemented — verify) | inline px widths; 0 body padding; 13px title; tiny close; no footer | `<Modal>` extended |

**Files the foundation touches:** `src/styles/theme.css` (tokens),
`src/styles/globals.css` (focus ring, base button transition, radii, dock-tab
ring scoped under theme class), `src/styles/pwa.css` (shadow tokens), plus new
shared stylesheets created in §3.

---

## 3. Cross-cutting workstreams

> Each: **Goal · Changes · Files · Effort (S/M/L).** Ordered by impact.

### W-A · Global focus ring + base-button motion — **🔲 KEEP · Effort S**
- **Goal:** Visible keyboard focus everywhere; hovers ease instead of snap.
- **Changes:** Add §2.6 focus rule + §2.7 base-button transition to `globals.css`. One commit fixes the #1 a11y miss across all 6 areas. **Verify the dockview tab ring renders despite `.dockview-theme-karmyogi .dv-tab` specificity (§2.6 caveat); if overridden, add the theme-scoped tab-ring rule** and Playwright-Tab through the dock strip to confirm.
- **Files:** `src/styles/globals.css`.

### W-B · Unify the slider + number field — **🔲 KEEP · Effort M**
- **Goal:** The slider is always a usable track; one definition app-wide.
- **Changes:** Create `src/styles/slider-row.css` (`.ui-sfield`/`.ui-slider`/`.ui-sfield-num`) with §2.8 geometry and tokenized `--slider-label-w`/`--slider-num-w`; optional `<SliderField>` wrapper. Migrate `.cc-slider` (cadcam), `.laser-slider`, `.pcb-op-card .cc-slider`, `.pr-slider`, `.sig-slider`, `.cam-slider`, and the 7 point-tab sliders. **Delete duplicated `::-webkit-slider-thumb` blocks — verified to live in 17 files** (re-grep `webkit-slider-thumb` before/after). Fix label truncation (wrap, no ellipsis), `Recommended:` clipping, and unit clipping.
- **Files:** new `slider-row.css`; **`cadcam.css`, `laser.css`, `laserImage.css`, `pcb.css`, `print.css`, `writing.css`, `signature.css`, `camera.css`, `controller.css`, `timeline.css`, `soldering.css`, `drilling.css`, `screwdriving.css`, `glue.css`, `pickplace.css`, `welding.css`, `springcoiling.css`** (the full verified 17-file set carrying a `::-webkit-slider-thumb` block).

### W-C · Unify the segmented control — **🔲 KEEP · Effort M**
- **Goal:** One segmented control; mode-switches tonal, primaries full-accent; arrow-key navigable (§2.8 keyboard contract).
- **Changes:** One `.ui-seg`/`<SegControl>` (§2.8) with `role="radiogroup"`, `role="radio"` children, roving tabindex + Left/Right/Up/Down/Home/End. Migrate `.mc-seg`, `.pt-speed`, `.teach-frame`, `.cc-opseg`, `.laser-seg`, `.pcb-zmode`, `.pcb-stage-btn`, `.wr-seg/.wr-modeseg`, `.sig-mode`, `.pr-seg-btn`, `.cam-seg-btn`. Make `.cam-seg-btn.on` solid accent (was 22% tint); make Laser Vector/Image + Carving op-switch tonal so only the real CTA is full-accent.
- **Files:** `controller.css`, `timeline.css`, `teach.css`, `cadcam.css`, `laser.css`, `pcb.css`, `writing.css`, `signature.css`, `print.css`, `camera.css`, plus the `<SegControl>` component + the panels that adopt it.

### W-D · Adopt the shared CAM kit on the 7 point tabs — **🔲 KEEP · Effort M**
- **Goal:** Kill the largest source of cross-tab drift; the kit already exists.
- **Changes:** (1) Replace all 7 hand-rolled status strips with `<CamStatus>`; delete `.sp/.swd/.scf/.wp/.pp/.spr/.gp-status`. (2) Replace `SolderingPanel`'s bare `<p class="sp-empty">`/`<td class="sp-empty">` with `<CamEmpty>` (match `DrillingPanel`). (3) Extract `styles/cam-controls.css` (`.cam-slider` via W-B, `.cam-seg` via W-C, `.cam-ico`/`-primary`/`-danger`); delete 7 prefixed copies. (4) Rename crossed prefixes: `drilling.css` `.scf-*`→`.dr-*`, `screwdriving.css` `.swd-*`→`.scf-*` (or fold into `.cam-*`). (5) **Collapsible "defaults" once ≥1 point** (`✂️ CUT?`): if adopted, it **must follow the §6 disclosure rule** — a persistent `Defaults ⌄` chevron with the word visible, remembering open/closed state; never a bare hidden block.
- **Files:** `src/components/cam/CamUI.tsx`, all 7 panel `.tsx`, all 7 panel `.css`.

### W-E · Modal chrome standardization — **🔲 KEEP · Effort M**
- **Goal:** One dialog system: padded body, real title, icon close, sticky footer, enter animation, size scale.
- **Changes:** Extend `Modal.tsx` with `subtitle`/`headerActions`/`footer` slots and a `size` enum (replace inline px widths). `.km-modal-body` gets `padding: var(--sp-5)` + `.km-modal-body--flush` for self-padded panels. **`.km-modal-close`: it already renders `<Icon name="close" size={15}/>` — the fix is geometry, not the icon: enlarge to a 28–32px square, add hover background + focus ring** (match `.ai-bubble-btn`). `.km-modal-title` → `--fs-title`. Footer follows §2.8 order (secondary left / primary right). Fix **Motion double-header**: add `embedded` prop to `MotionPanel` to suppress its `<h4>`/sticky treatment; move Sync/Save/Copy/Import into the Modal footer. Add §2.7 enter transition. **Focus-trap + focus-restore already exist in `Modal.tsx` (verified) — keep them; just verify they still hold after the slot refactor.**
- **Files:** `Modal.tsx`, `shell-extra.css`, `MotionPanel.tsx`, `motion.css`, `shell.tsx`, `aibubble.css`.

### W-F · Section-header + card-surface unification — **🔲 KEEP · Effort M**
- **Goal:** One header recipe and one card surface across CAM/doc/point tabs and overlays — using the **decided** §2.8 recipe (no bottom border; optional muted 14px leading glyph; card = border only).
- **Changes:** `.ui-sec-head` + `--bg-card` (§2.8/§2.3). Migrate `.cc-section>h3`, `.pcb-section>h3`, `.lp-card-head h4`, `.fv-head`, `.wr-card>h3`, `.sig-card-head h4`, `.print-section>h3`, `.cam-card-head`/`.cam-sec-head`, and overlay labels `.mo-group`/`.gp-grouplbl`/`.ai-label`. **(No "decide once" remains — §2.8 already pins the header recipe; just apply it.)**
- **Files:** `cadcam.css`, `pcb.css`, `laser.css`, `featureViewer.css`, `writing.css`, `signature.css`, `print.css`, `camera.css`, `motion.css`, `controller.css`, `ai.css`.

### W-G · Topbar grouping & refinement — **🔲 KEEP · Effort S–M**
- **Goal:** App-bar reads as information-architected, not a flat 14-control run.
- **Changes:** Group `.topbar-actions` into clusters (connection │ layout+zoom │ language+theme │ status+account) with a reusable `.topbar-sep` hairline (generalize `.km-conn-sep`); ~10px between-group gap. Remove persistent accent border on Reset icon button. Unify control heights to `--ctl-h` baseline (connection pill is 24px vs icon-btn 30px). Normalize all topbar SVGs to one stroke width (2) + size (16). Render or delete dead `.brand-subtitle`. Give disconnected status word more presence (`--fg` not `--fg-muted`).
- **Files:** `topbar.css`, `shell.tsx`, `shell-extra.css`, `IconButton.tsx`, `ConnectionControl.tsx`, `PanelLauncher.tsx`, `Icons.tsx`.

### W-H · Destructive / state-affordance pass — **🔲 KEEP · Effort S**
- **Goal:** Danger reads danger; toggles read different from momentary.
- **Changes:** Program Stop (`.pp-btn-abort`) persistent destructive (`--border-danger` + filled-danger hover), pause warn-tinted; Console clear-log danger. Visualizer toggle modes (`.vz-toolbar-btn--on` lasso/pick) distinct accent fill vs momentary. Point-tab Clear → `.cam-ico-danger` in a fixed toolbar slot.
- **Files:** `program.css`, `ProgramPanel.tsx`, `console.css`, `VisualizerPanel.tsx`, `globals.css`, point-tab panels.

### W-I · Empty-state system — **🔲 KEEP · Effort S**
- **Goal:** Every "nothing here" state uses `<CamEmpty>` chrome (icon + title + hint + CTA).
- **Changes:** Soldering (W-D), Console `.chat-empty` (icon + 2 lines, fix clipping), Program/Sections, Camera black-void stage (`.cam-stage-empty`), Gamepad disconnected state, Glue double-prompt (show one). Unify dropzone dashed-border weight across `.cc-drop`/`.pcb-drop`/laser import. **Controller keyboard-help (`.mc-hint`, `ControllerPanel.tsx:1304`): this is safety-relevant on a machine-control app — do NOT simply hide it.** Keep a **one-line inline summary** always visible (e.g. "Arrows jog · PgUp/Dn Z · Esc cancel · `?` for all") plus a persistent `?` button opening the full `<kbd>`-chip shortcut map. Per §6 disclosure rule, the popover remembers nothing about itself, but the inline summary + the labeled `?` guarantee the legend is never lost.
- **Files:** `console.css`, `ConsolePanel.tsx`, `camera.css`, `CameraPanel.tsx`, `GamepadModal.tsx`, `gamepad.css`, `glue.css`, `GluePanel.tsx`, `cadcam.css`, `pcb.css`, `laser.css`, `ControllerPanel.tsx`, `controller.css`.

### W-J · Light-theme parity pass — **🔲 KEEP · Effort S–M**
- **Goal:** Light theme deliberately designed, not a recolor.
- **Changes:** Apply §2.3 (`--bg-elev` `#fbfcfd`, `--border` `#c9d0d8`) and §2.5 shadow tokens. Darken light slider unfilled track + strengthen thumb ring. Verify gamepad glass chips don't drop contrast in light (raise bg-elev mix to 88–92% if needed). Verify accent-text contrast (`--accent` `#0b6d59` candidate). **Honor the §2.3 dependency:** if the accent darkening is cut, the §2.6 two-tone ring + 14px/600 white-on-accent floor are mandatory here. **Verify every change in Playwright at both themes.**
- **Files:** `theme.css`, `pwa.css`, `cadcam.css`, `gamepad.css`, `globals.css`.

### W-K · Mobile / touch polish — **🔲 KEEP · Effort M**
- **Goal:** "designed for mobile," one mental model with desktop.
- **Changes:** `.mobile-tabs` edge-fade `mask-image` + scroll-snap; `scrollIntoView({inline:'center'})` on tab change in `MobileShell.tsx`. Reflow Soldering/PCB **PRESETS side-rail** to horizontal at `≤768px`. Wrap/scroll overflowing panel sub-toolbars. Inactive `.mobile-tab` gets 1px border + pressed state. One touch token `--ctl-h-touch:40px` referenced by both the `@media` override and `.mobile-tab`. Safe-area `env(safe-area-inset-bottom)` on bottom preset bar + `viewport-fit=cover`.
- **Files:** `globals.css`, `MobileShell.tsx`, `SolderingPanel.tsx`, `pwa.css`, `theme.css`.

### W-L · Motion & interaction-state pass — **🔲 KEEP · Effort S**
- **Goal:** Consistent eased transitions; subtle modal enter; **all of it reduced-motion gated in code (§2.7), not just prose.**
- **Changes:** §2.7 tokens applied to base button, modal enter/exit (scrim fade + `scale(.98→1)`), disclosure carets; the `@media (prefers-reduced-motion: reduce)` block in §2.7 must explicitly include the new modal + caret selectors, not only `button`.
- **Files:** `globals.css`, `shell-extra.css`, `Modal.tsx`.

### W-M · Iconography consistency — **🔲 KEEP · Effort S**
- **Goal:** One icon family, one stroke weight.
- **Changes:** Normalize topbar SVGs (W-G); replace Marlin/Smoothie literal glyphs `⤓ 💾 ▷` with `<Icon>`; standardize gamepad lucide vs in-house icon sizing (13–14px); single SVG caret for all disclosures (drop `▸` text glyph in Camera).
- **Files:** `shell.tsx`, `MotionPanel.tsx`, `GamepadModal.tsx`, `PanelLauncher.tsx`, `Icons.tsx`, `camera.css`, `signature.css`.

### W-N · Accessibility finish (beyond focus ring) — **🔲 KEEP · Effort S–M**
- **Goal:** AA contrast + targets + screen-reader awareness everywhere; close the keyboard-first gaps.
- **Sub-checklist (each is a §7 gate):**
  - **(a) Unlabeled-control audit.** Grep pass for icon-only buttons missing a label — `grep -rEl '<button[^>]*>\s*<(svg|Icon)' src` then confirm each has `aria-label` (and ideally `title`). Add labels where missing. Raise unit-suffix font to ≥11px / drop extra opacity (shared cam-controls class); raise `.kbd-hint`/`.pad-hint`/disabled opacities.
  - **(b) Segmented-control keyboard nav.** Implement §2.8 roving-tabindex + arrow-key contract in `<SegControl>` (W-C). Documented as the canonical recipe in §2.8.
  - **(c) Reduced-motion coverage.** Confirm every new transition from W-L is inside the §2.7 `@media` block (grep the selectors).
  - **(d) Live regions.** Add `aria-live="polite"` to the GRBL **state** chip and **streaming progress %** so changes are announced; add an `aria-live="assertive"` (or `role="alert"`) region for **ALARM** and **DISCONNECTED** transitions. (Verified: 0 `aria-live` in `src/components` today.)
  - **(e) Modal focus.** `Modal.tsx` already implements focus-trap + focus-restore-on-close (verified) — keep as-is; do **not** regress it. Note: it focuses the first focusable element on open, which is fine; if a dialog opens to a destructive control, give that dialog an initial-focus target on the title/body instead.
- **Files:** `cam-controls.css`, `controller.css`, point-tab panels, `ConnectionControl.tsx`, `ProgramPanel.tsx`, `Modal.tsx`, `<SegControl>`.

### W-O · Operation rail / IA (left dock tabs) — **✂️ CUT? · Effort L**
- **Goal:** Make the 12-hidden-modes overflow discoverable (the app's main mode switcher hides behind a `▾ 12` chevron).
- **Changes:** Either a dedicated vertical icon rail (VS Code / Fusion activity-bar style) **OR** just style the overflow affordance so `12` reads as "see all modes" and keep per-tab glyphs visible when collapsed (the smaller, presentation-only option). *Larger structural change — user decides scope.*
- **Files:** `shell.tsx`, `globals.css`, `panelIcons.tsx`.

### W-P · Preset rail clarity — **🔲 KEEP · Effort S**
- **Goal:** The floating preset rail reads as actionable save slots, not a paint-swatch column.
- **Changes:** Mute empty-slot hues (dashed ~40%, neutral `+`), saturate only on save; replace the **red ring on the first slot** with the standard accent focus ring; bigger/readable header than the 7px rotated `PRESETS` caption; `aria-label`/tooltip "Save current settings to preset N."
- **Files:** `presets.css`, `PresetRail.tsx`.

### W-Q · Async & error chrome (busy / error / disabled-with-reason) — **🔲 KEEP · Effort S–M**
- **Goal:** The whole async dimension an enterprise app needs but the audit only half-covered: loading/busy, inline error+retry, and disabled-with-reason. (`<CamEmpty>` covers static "nothing here"; this covers *in-flight* and *failed*.)
- **Changes:**
  - **`<CamBusy>`** (§2.8) — spinner or skeleton + one-line label, `aria-busy` on the surface. Trigger sites: **CadCam/PCB/Laser import parse** (DXF / Gerber-ZIP / image), **CameraPanel lens-solve**, **ProgramPanel stream-start**.
  - **`<CamError>`** (§2.8) — `CamEmpty` variant with a danger glyph, message, and a **retry CTA**. Trigger sites: bad DXF, failed Gerber ZIP, **serial disconnect mid-stream** (`ConnectionControl`), **gamepad lost during jog**.
  - **Disabled-with-reason** convention — any disabled **primary** action carries a `title` explaining the blocker (e.g. *"Connect a machine to stream"*, *"Load a file first"*). Pairs with the W-N disabled-opacity bump so disabled never looks "just dim."
- **Files:** new `cam-controls.css` additions (or `CamUI.tsx` for `<CamBusy>`/`<CamError>`), `CarvingPanel.tsx`, `PcbPanel.tsx`, `LaserPanel.tsx`/`laserImage.css`, `CameraPanel.tsx`, `ProgramPanel.tsx`, `ConnectionControl.tsx`, gamepad jog path.

---

## 4. Per-area punch list

> All auditor findings preserved (overlaps deduped to the cross-cutting
> workstream that owns them). Severity tags: 🟥 critical · 🟧 high · 🟨 medium · 🟦 low.

### Area 1 — App shell, top bar & global chrome (3.5)

- 🟧 **No global keyboard focus ring** — `globals.css` has hover/active but no `:focus-visible`; topbar + dock strip show nothing on Tab. → **W-A**. `globals.css`, `topbar.css`.
- 🟧 **Flat 14-control toolbar, no grouping/dividers.** → **W-G**. `topbar.css`, `shell.tsx`, `shell-extra.css`.
- 🟨 **Reset icon button has persistent accent border** (reads "selected"); should be neutral, accent only on hover/active. → **W-G/W-H**. `topbar.css`, `shell.tsx`, `IconButton.tsx`.
- 🟨 **Control-height mismatch** — `.icon-btn` 30px vs `.km-conn-*` 24px; no single baseline. → **W-G**. `shell-extra.css`, `topbar.css`, `theme.css`.
- 🟨 **Left operation rail hides 12 primary modes behind `▾ 12`** with no count affordance. → **W-O ✂️ CUT?**. `shell.tsx`, `globals.css`, `panelIcons.tsx`.
- 🟦 **Dead `.brand-subtitle` CSS** (no element renders it); brand block thinner than code implies. → **W-G**. `shell.tsx`, `globals.css`, `topbar.css`.
- 🟦 **Mixed icon stroke languages in the bar** (local 24×24 set vs Icon set vs launcher grid). → **W-M**. `shell.tsx`, `PanelLauncher.tsx`, `ConnectionControl.tsx`, `Icons.tsx`.
- 🟦 **Mobile `⋯` overflow holds half the globals with low discoverability.** → **W-K** (optional accent dot / labeled Menu on widest phones). `shell.tsx`, `topbar.css`.
- 🟦 **`DISCONNECTED` rendered in lowest-emphasis muted gray** — most safety-relevant status easy to miss; also announce via live region. → **W-G + W-N(d)**. `shell-extra.css`, `ConnectionControl.tsx`.

### Area 2 — Core dock panels: Controller, Program, Console, Visualizer (3.5)

- 🟥 **No visible keyboard focus indicator** anywhere in these panels (app is "fully keyboard-operable" — WCAG 2.4.7 fail). → **W-A**. `globals.css`.
- 🟧 **Program transport doesn't encode danger** — Pause and Stop are identical neutral squares; abort styling is hover-only. → **W-H**. `program.css`, `ProgramPanel.tsx`.
- 🟧 **Keyboard-help is a run-on muted paragraph** (`.mc-hint`, `ControllerPanel.tsx:1304`) — reads like debug text. **Move the FULL map to a `?` shortcuts popover with `<kbd>` chips, but keep a one-line inline summary visible (safety-relevant); never hide the legend with no affordance.** → **W-I** (per §6 disclosure rule). `ControllerPanel.tsx`, `controller.css`.
- 🟧 **Jog-card grouping ambiguous** — 3×3 arrow grid + Z column + far-right `Zero X/Y/Z` column + 6-up WCS strip, no sub-grouping. Add `JOG`/`SET ZERO`/`WCS` micro-labels or hairline dividers; tether `.mc-zero-col` to the pad. `controller.css`, `ControllerPanel.tsx`.
- 🟨 **Control heights/radii drift** (28/30/26/24px; 4/5/6px). → **W-B/W-C + §2.4**. `globals.css`, `timeline.css`, `console.css`, `theme.css`.
- 🟨 **Console empty state** is one clipped italic line. → **W-I**. `console.css`, `ConsolePanel.tsx`.
- 🟨 **Streaming has no busy/error chrome** — stream-start shows nothing; disconnect mid-stream isn't surfaced inline. → **W-Q**. `ProgramPanel.tsx`, `ConnectionControl.tsx`.
- 🟨 **Unlabeled ambiguous icon controls** — Program reset/`1`-field/frame icons; Console search copy/⚡ icons. Add titles/aria, a "Line" caption, 1px separator between search and actions. → **W-N(a)/W-M**. `ProgramPanel.tsx`, `ConsolePanel.tsx`, `console.css`.
- 🟨 **Progress/ETA row thin and unanchored** — bump `.pp-progress-track` to 10px, give `%` `--fg` weight, separate ETA into its own zone; add `aria-live` on `%`. → **W-N(d)**. `program.css`.
- 🟨 **Visualizer toolbar one undifferentiated run** — add `.vz-toolbar-sep` between functional clusters; distinct active-toggle fill. → **W-H**. `VisualizerPanel.tsx`, `globals.css`.
- 🟦 **Section micro-labels low-contrast/tiny** (`.mc-section>h4`, `.pp-section-title`). → **§2.2 weight bump**. `controller.css`, `program.css`.
- 🟦 **Invisible hint badges** (`.kbd-hint` 0.18, `.pad-hint` 0.22) + disabled 0.45. → **W-N(a)**. `controller.css`.
- 🟦 **Three segmented-control impls** (`.mc-seg`/`.pt-speed`/`.teach-frame`) — plain tab-stops, no arrow nav. → **W-C + W-N(b)**. `controller.css`, `timeline.css`, `teach.css`.
- 🟦 **Inconsistent transition coverage** — base buttons snap on hover. → **W-L**. `globals.css`.

### Area 3 — CAM file tabs: 2D/3D Carving, PCB, Laser (3.5)

- 🟧 **Three segmented/toggle idioms** (`.cc-opseg`, `.laser-seg`, `.pcb-zmode`/`.pcb-stage-btn`). → **W-C**. `cadcam.css`, `laser.css`, `pcb.css`.
- 🟧 **Slider rows cramped; labels truncate** ("Cut depth / ...", "Max carve ..."). → **W-B**. `cadcam.css`, `laser.css`, `pcb.css`.
- 🟧 **`EDITING:` block is bare text, not a bordered card** — breaks card rhythm. Wrap in `.cc-section`/`.cc-jobcard`. → **W-F**. `cadcam.css`, `CarvingPanel.tsx`.
- 🟧 **Preset rail cryptic** — 7px rotated caption, empty dashed slots, red ring on slot 1. → **W-P**. `presets.css`.
- 🟨 **Import has no busy/error chrome** — DXF / Gerber-ZIP / laser-image parse shows nothing while working and nothing on failure. → **W-Q**. `CarvingPanel.tsx`, `PcbPanel.tsx`, `laser.css`, `laserImage.css`.
- 🟨 **PCB step numbering gap** — shows `1 · Upload` then `4 · Essentials` (2,3 hidden until ZIP loads). Render ghost placeholders for 2/3 or drop literal numbers. `PcbPanel.tsx`, `pcb.css`.
- 🟨 **Section-header treatment differs** across the three tabs (+FeatureViewer). → **W-F**. `cadcam.css`, `pcb.css`, `laser.css`, `featureViewer.css`.
- 🟨 **Slider+number widget re-implemented 4×** (~250 dup lines; `--mc-pct` vs `--pct`). → **W-B**. `cadcam.css`, `pcb.css`, `laser.css`.
- 🟨 **Light-theme slider fill + hairline borders faint.** → **W-J**. `theme.css`, `cadcam.css`.
- 🟨 **Laser stacks competing primaries** — full-accent Vector/Image fights the real CTA Import DXF; make mode switch tonal. → **W-C**. `laser.css`.
- 🟦 **`Recommended:` hint clipped/asymmetric.** Inline ghost value or `use rec` chip; never truncate. `cadcam.css`.
- 🟦 **Material picker mixes styles** — photoreal wood banner dominates vs line-icon selectors; scale to a compact `.cc-matrow` thumbnail. `cadcam.css`.
- 🟦 **Empty/dropzone affordances inconsistent** (`.cc-drop` 2px dashed vs `.pcb-drop` 1px vs laser none). → **W-I**. `cadcam.css`, `pcb.css`, `laser.css`.
- 🟦 **FeatureViewer uses own radii/surfaces** (9px/5px, ad-hoc color-mix). → **W-F + §2.4**. `featureViewer.css`.
- 🟦 **Number frames flush to panel edge clip units** ("50 m", "1.59 m"). Add `padding-right`/`scrollbar-gutter: stable`. → **W-B**. `cadcam.css`.

### Area 4 — Point/teach tabs: Soldering, Screw, Drill, Glue, Pick&Place, Weld, Spring (3.0)

- 🟧 **Empty states diverge** — 5 tabs use `<CamEmpty>`; Soldering uses bare `<p/td class="sp-empty">` (looks unfinished, no CTA). → **W-D**. `SolderingPanel.tsx`, `CamUI.tsx`, `soldering.css`.
- 🟧 **`<CamStatus>` exists but 0/7 panels use it** — 7 hand-rolled strips already diverging (`.swd-status-sync` pill vs `.sp-status-sync` text). → **W-D**. `CamUI.tsx` + 7 panel css.
- 🟧 **Massive CSS duplication** of slider/segmented/icon-button (the `::-webkit-slider-thumb` block in all 7 point files). → **W-D + W-B + W-C**. 7 panel css.
- 🟨 **Toolbar grammar differs** — title row present on some, absent on Soldering/Pick&Place; destructive Clear in different slots. Define one header contract; Clear last after a separator. → **W-D/W-H**. `SolderingPanel.tsx`, `PickPlacePanel.tsx`, `ScrewFittingPanel.tsx`.
- 🟨 **Scrambled CSS prefixes** — `drilling.css` defines `.scf-*`, `screwdriving.css` defines `.swd-*` (mode↔prefix crossed; edit hazard). → **W-D**. `drilling.css`, `screwdriving.css`, `DrillingPanel.tsx`, `ScrewFittingPanel.tsx`.
- 🟨 **Defaults-vs-table primacy inconsistent** — Drilling/Screw defaults-heavy, Soldering table-first. Pick one IA: **collapsible defaults once ≥1 point (`✂️ CUT?`)** with a persistent `Defaults ⌄` chevron (the word stays visible) that remembers state (§6 disclosure rule), `flex:1` table. `SolderingPanel.tsx`, `DrillingPanel.tsx`, `ScrewFittingPanel.tsx`, `soldering.css`, `drilling.css`.
- 🟨 **Bulk-edit ("apply to all") only in Soldering** — promote `.sp-bulk-pop`→`.cam-bulk-pop`, wire into Drilling/Screw/Pick&Place, trigger ≥24px with persistent glyph. `SolderingPanel.tsx`, `soldering.css`, `DrillingPanel.tsx`, `ScrewFittingPanel.tsx`.
- 🟨 **Record-position presented 3 ways** (Soldering ⌖ / Pick&Place Set pick+Set place / Welding ⇤⇥⊙). Standardize glyph family + labeling; tooltip Welding glyphs. `SolderingPanel.tsx`, `PickPlacePanel.tsx`, `WeldingPanel.tsx`, `pickplace.css`.
- 🟦 **Preset rail reads as paint swatches; red ring on slot 1.** → **W-P**. `presets.css`, `PresetRail.tsx`.
- 🟦 **Card-head glyph treatment varies** — Spring has accent leading icons, others none. **Resolved by §2.8: leading glyph is optional and muted (never accent).** → **W-F**. `springcoiling.css`, `soldering.css`, `drilling.css`.
- 🟦 **Glue double empty prompt** (faint canvas text + SHAPES CamEmpty say the same thing). → **W-I**. `GluePanel.tsx`, `glue.css`.
- 🟦 **Unit suffixes 10px @ 0.8 opacity on muted** — borderline AA. → **W-N(a)**. 5 panel css.
- 🟦 **Inconsistent focus-ring offsets** (`teach.css` -2/+1/+2px). → **W-A/W-N**. `teach.css`, `soldering.css`, `pickplace.css`.

### Area 5 — Modals & overlays: Gamepad, Machines, Motion, AI (3.0)

- 🟧 **Motion Settings double header** (generic Modal title + panel `<h4>` + sticky toolbar inside scroll). → **W-E**. `shell.tsx`, `MotionPanel.tsx`, `motion.css`.
- 🟧 **`.km-modal-body` has 0 padding** — content butts the 1px border. Add `--sp-5` + `--flush` modifier. → **W-E**. `shell-extra.css`, `Modal.tsx`.
- 🟧 **`.km-modal-close` is too small** (26px, 2/8 padding, no hover bg). **It already renders an `<Icon>` — enlarge to a 28–32px square + hover bg + focus ring; keep the icon.** → **W-E**. `shell-extra.css`, `aibubble.css`.
- 🟧 **Gamepad modal overwhelming** — 4 expanded sections below a ~58vh 3D stage; rebind grid below the fold. Collapse Button-names/Per-tab into `<details>` **with a persistent labeled summary + a `Rebind (N)` count badge so the live rebind UI stays discoverable (§6 disclosure rule); remember open/closed state**; shrink `.gp-space` to `min(40vh,340px)`. `gamepad.css`, `GamepadModal.tsx`.
- 🟧 **Three overlay paradigms, no shared system** — centered `<Modal>`, Modal-wrapping-a-panel, and the `km-farm-pop` Machines popover. → **W-E** (promote Machines to `<Modal>` or standardize a popover variant). `topbar.css`, `ConnectionControl.tsx`, `Modal.tsx`.
- 🟨 **Modal titles only 13px** (same as toolbar text); no eyebrow/subtitle. → **W-E + §2.2**. `shell-extra.css`, `Modal.tsx`, `aibubble.css`.
- 🟨 **No shared dialog footer** — Motion confirm/import hand-roll action rows that scroll with body; Gamepad has none. → **W-E** (sticky `.km-modal-foot`, **secondary/ghost left, primary right — pinned in §2.8**). `Modal.tsx`, `shell-extra.css`, `MotionPanel.tsx`.
- 🟨 **Gamepad glass chips tuned for dark** — verify light contrast (raise bg-elev mix, `--fg` not `--fg-muted` on translucent). → **W-J**. `gamepad.css`.
- 🟨 **Motion sticky-header-in-scroll fragile** (negative margins reclaim padding the body lacks; dock-tuned shadow). → **W-E**. `motion.css`, `topbar.css`.
- 🟨 **No modal enter/exit transition** (hard-cut). → **W-L**. `shell-extra.css`, `Modal.tsx`.
- 🟨 **Gamepad mapping rows `flex-wrap` ragged** — give a stable grid; make Rebind the primary, picker secondary. `gamepad.css`, `controller.css`.
- 🟨 **Modal widths are inline px** (780/860/460/520), no size scale. → **W-E**. (Initial-focus: `Modal.tsx` already traps + restores focus; leave the focus-trap intact — only set an explicit initial-focus target for dialogs whose first control is destructive. → **W-N(e)**.) `Modal.tsx`, `shell-extra.css`.
- 🟦 **Three near-identical section-label styles** across overlays. → **W-F**. `motion.css`, `controller.css`, `ai.css`.
- 🟦 **Mixed icon sourcing** — lucide vs in-house `<Icon>` vs literal `⤓ 💾 ▷`. → **W-M**. `MotionPanel.tsx`, `GamepadModal.tsx`.
- 🟦 **Gamepad disconnected renders full Unbound form** — collapse behind a `<CamEmpty>`/`<CamError>` "No controller — connect & press a button" state. → **W-I/W-Q**. `GamepadModal.tsx`, `gamepad.css`.
- 🟦 **Scattered hard-px modal breakpoints** (560/540/768) vs AI's container queries. → **W-E/W-K** (container-query the modal body). `gamepad.css`, `motion.css`, `shell-extra.css`.

### Area 6 — Responsive (mobile) shell & dark/light theme parity (3.0)

- 🟧 **Mobile tab strip overflows with no affordance** — tabs clipped at edges, no fade/snap, never auto-scrolls active into view. → **W-K**. `globals.css`, `MobileShell.tsx`.
- 🟧 **Dense panels don't reflow to one column** — Soldering/PCB still render the vertical PRESETS rail + overflowing sub-toolbar (3 scroll axes). → **W-K**. `globals.css`.
- 🟧 **Panel sub-toolbars overflow horizontally** (400px wrap rule misses them). → **W-K**. `globals.css`, `SolderingPanel.tsx`.
- 🟧 **Light theme inherits dark `rgba(0,0,0,.55)` shadows** (muddy on white). → **W-J + §2.5**. `theme.css`, `pwa.css`.
- 🟨 **`--bg-elev` == `--bg-panel` == `#fff` in light** (elevation by borders only). → **W-J + §2.3**. `theme.css`.
- 🟨 **Inactive mobile pills lack border/pressed state.** → **W-K**. `globals.css`.
- 🟨 **Accent-text contrast borderline** — white-on-`#0e7c66` ≈4.1:1 at 12px; focus ring vanishes on green active pill. → **W-J + §2.6 two-tone ring** (mandatory if accent darkening is cut — §2.3 dependency). `theme.css`, `globals.css`.
- 🟨 **Bottom preset bar has no safe-area inset** (notch/home-indicator collision). → **W-K**. `pwa.css`, `globals.css`.
- 🟦 **Touch-target tokens defined 3 ways** (`--ctl-h-touch:38` vs forced 40px vs pill 38). → **W-K** (one token). `theme.css`, `globals.css`.
- 🟦 **Desktop underline vs mobile pill** express "selected" two ways. → **W-K** (optional unify). `globals.css`.
- 🟦 **Soldering mobile empty state references clipped toolbar glyphs** — add inline "Add point" CTA (resolves with W-D + toolbar fix). `SolderingPanel.tsx`.

---

## 5. Phased rollout

### Phase 1 — Foundation tokens + highest-impact quick wins
**Deliverables:** §2 tokens (spacing 5/6, type title ramp + weights, `--bg-card`,
light `--bg-elev`/`--border`, `--shadow-1/2`, motion tokens, `--ctl-h-sm`).
Global `:focus-visible` ring (incl. theme-scoped dockview-tab ring) + base-button
transition. Reset-border fix. Topbar grouping/dividers. Destructive Stop/Clear
coloring. Section-label weight bump.
**Workstreams:** W-A, W-G, W-H, W-L, parts of §2.
**Files:** `theme.css`, `globals.css`, `topbar.css`, `shell.tsx`, `shell-extra.css`, `program.css`, `ProgramPanel.tsx`, `console.css`, `IconButton.tsx`.

### Phase 2 — Cross-cutting component unification (the backbone payoff)
**Deliverables:** `slider-row.css` (`.ui-sfield`/`.ui-slider`) and `cam-controls.css`
(`.cam-slider`/`.cam-seg`/`.cam-ico` + `<CamBusy>`/`<CamError>`); `.ui-seg`/`<SegControl>`
with roving-tabindex arrow nav; `.ui-sec-head` + `--bg-card` card/header unification;
`<CamStatus>`/`<CamEmpty>` adopted on all 7 point tabs; prefix rename
(`drilling`/`screwdriving`); `Modal.tsx` extended (size enum, padded body, geometry
fix on the existing icon close, title ramp, footer slot w/ §2.8 order, enter
transition; focus-trap preserved) + Motion double-header fix.
**Workstreams:** W-B, W-C, W-D, W-E, W-F, W-Q (busy/error tokens).
**Files:** all CAM/point/doc `.css` + panel `.tsx`, `CamUI.tsx`, `Modal.tsx`, `MotionPanel.tsx`, `motion.css`, `shell-extra.css`.

### Phase 3 — Per-tab polish
**Deliverables:** Carving `EDITING` card + material thumbnail; PCB step numbering;
Laser tonal mode switch; Controller jog sub-grouping + shortcuts popover (with
inline summary kept); Program progress row; Visualizer toolbar grouping; point-tab
toolbar contract + bulk-edit promotion + record-position standardization;
preset-rail clarity; empty-state + dropzone unification; busy/error chrome wired to
import/solve/stream/disconnect/gamepad-lost trigger sites; disabled-with-reason
titles; FeatureViewer token alignment.
**Workstreams:** W-I, W-P, W-Q (trigger-site wiring), remaining per-area items.
**Files:** `CarvingPanel.tsx`, `cadcam.css`, `PcbPanel.tsx`, `pcb.css`, `laser.css`, `laserImage.css`, `ControllerPanel.tsx`, `controller.css`, `VisualizerPanel.tsx`, point-tab panels/css, `presets.css`, `PresetRail.tsx`, `featureViewer.css`, `console.css`, `camera.css`, `CameraPanel.tsx`, `ConnectionControl.tsx`.

### Phase 4 — Motion / a11y / light-theme / mobile finish
**Deliverables:** Light-theme parity verified in Playwright both themes (shadows,
elevation, slider fill, glass chips, accent contrast); mobile tab-strip fade +
snap + scrollIntoView; side-rail + sub-toolbar reflow; safe-area insets; touch
token unification; icon-family normalization; a11y finish — W-N sub-checklist
(a–e): unlabeled-control audit, segmented-control arrow nav, reduced-motion
coverage, `aria-live` regions for state/progress/ALARM/DISCONNECTED, modal
focus verification. Optional W-O operation-rail IA.
**Workstreams:** W-J, W-K, W-M, W-N, (W-O ✂️ CUT?).
**Files:** `theme.css`, `pwa.css`, `globals.css`, `MobileShell.tsx`, `SolderingPanel.tsx`, `gamepad.css`, `cam-controls.css`, `MotionPanel.tsx`, `GamepadModal.tsx`, `Icons.tsx`, `panelIcons.tsx`, `shell.tsx`, `ConnectionControl.tsx`, `ProgramPanel.tsx`, `<SegControl>`.

---

## 6. Non-goals / guardrails

**This plan is presentation/UX only.** Verify everything in the real browser with
Playwright at desktop + a phone preset, both themes (per CLAUDE.md closed-loop).

**Explicitly NOT changed / preserved intact:**
- The **CAD/CAM core** (`src/core/`) — pure, UI-independent, untouched.
- **G-code safety** — `G21/G90/G94/G17`, safe-Z retract, no `-0.000`, Spindle/Pen/Feeder modes, conservative feeds. Emitter behavior unchanged.
- **dockview** docking/floating/resizing behavior and the desktop⇄mobile shell switch.
- **Web Serial** transport, GRBL streaming/realtime bytes, mock device.
- **Every existing feature, tab, panel, and capability.** No mode, control, or workflow is removed — only its chrome/layout/consistency improves.
- **No unit tests** added (verify via Playwright; `tsc --noEmit` stays clean).
- **No auto-deploy / no auto-commit** (per user memory).

### Disclosure rule (NEW — guards against feature-hiding)

Moving an existing, currently-visible control behind a disclosure is allowed for
tidiness **only if all of the following hold**:

1. **Persistent labeled affordance.** The collapsed control leaves a visible,
   *worded* trigger — a `?` / `Shortcuts` button, a `Defaults ⌄` chevron with the
   word, a `Rebind (N)` count badge — not a bare icon or an invisible hotspot.
2. **State is remembered.** Open/closed state persists across renders/sessions so
   a user who opens it once isn't re-hiding it every visit.
3. **Safety-relevant info stays inline.** For the Controller keyboard legend
   specifically (safety-relevant on a machine-control app), keep a **one-line
   inline summary** always visible *in addition to* the `?` popover holding the
   full map — the inline text is reduced, not removed.

This rule explicitly covers the three at-risk items: Controller shortcut help
(W-I), Gamepad rebind grid (Area 5), and point-tab defaults editor (W-D). None of
them may become hidden-by-default with no way back.

### 🔲 KEEP / ✂️ CUT — quick prune table

| Item | Workstream | Default | Note |
|---|---|:---:|---|
| Global focus ring | W-A | 🔲 KEEP | Non-negotiable a11y floor |
| Unified slider / segmented / card / header / status / empty | W-B…W-F | 🔲 KEEP | Core of the upgrade |
| Async & error chrome (busy/error/disabled-reason) | W-Q | 🔲 KEEP | The missing "finished software" state dimension |
| Modal standardization + Motion double-header fix | W-E | 🔲 KEEP | — |
| Topbar grouping, destructive coloring, light-theme, mobile, motion, a11y, icons | W-G…W-N | 🔲 KEEP | — |
| Preset-rail clarity | W-P | 🔲 KEEP | Low effort, removes the "red error ring" confusion |
| Darken `--accent` (`#0e7c66`→`#0b6d59`) for light | §2.3 / W-J | ✂️ CUT? | Brand color change. **If cut, §2.6 two-tone ring + 14px/600 white-on-accent text become REQUIRED** (§2.3 dependency) |
| Brand subtitle: render vs delete | W-G | ✂️ CUT? | Either is fine; user picks |
| **Operation rail → vertical activity bar** | W-O | ✂️ CUT? | Larger structural/IA change; the lighter "style the overflow" option can stand in |
| Promote Machines popover → full `<Modal>` | W-E | ✂️ CUT? | Or keep as a standardized popover variant |
| Desktop underline ⇄ mobile pill unification | W-K | ✂️ CUT? | Optional consistency nicety |
| Collapsible "defaults" once ≥1 point (point tabs) | W-D | ✂️ CUT? | IA opinion — user may prefer always-expanded. **If kept, must obey the disclosure rule above** |

---

## 7. Acceptance gates (per-phase exit bar)

> Each phase is "done" only when its gates pass. Gates are grep-able where
> possible and visual (Playwright screenshot) otherwise. These turn "looks
> finished" from subjective into checkable, and catch regressions (e.g. a new
> panel re-introducing a bespoke slider).

### Phase 1 gates
- **Focus ring matrix (visual).** Playwright Tab-through of topbar, dock tab
  strip, Controller, Program at **desktop + phone × light + dark** (4 screenshots);
  every interactive element shows a ring. **Specifically confirm the dockview tab
  ring renders** (the `.dockview-theme-karmyogi .dv-tab` specificity case).
- **Tokens present (grep).** `grep -E -- '--sp-5|--sp-6|--fs-title|--bg-card|--shadow-1|--shadow-2|--ctl-h-sm|--dur-fast' src/styles/theme.css` returns all.
- **Reset border (visual).** Topbar Reset icon shows no resting accent border.
- **No-snap hover (visual/grep).** Base `button` has the §2.7 transition; reduced-motion screenshot path unaffected.

### Phase 2 gates
- **Zero private slider thumbs (grep).** After migration, `grep -rl 'webkit-slider-thumb' src/styles | grep -v 'slider-row.css\|cam-controls.css' | wc -l == 0` (started at **17 files**; only the two shared files may keep a thumb block).
- **One segmented control (grep).** Exactly one `.ui-seg` definition; `grep -rE '\.mc-seg|\.pt-speed|\.cc-opseg|\.laser-seg|\.pcb-zmode|\.pcb-stage-btn|\.wr-seg|\.cam-seg-btn|\.sig-mode|\.pr-seg-btn' src/styles | wc -l == 0` (all migrated/aliased).
- **CamStatus/CamEmpty adoption (grep).** All 7 point panels import `CamStatus`; `grep -rl 'class="sp-empty"' src` returns nothing.
- **Modal contract (visual).** A representative modal shows: ≥`--sp-5` body padding, `--fs-title` title, a sticky footer with secondary-left/primary-right, a 28–32px icon close with hover bg + focus ring, and an enter transition (or none under reduced-motion). Focus-trap + restore still work (Tab cycles inside; close returns focus to opener).
- **Motion single header (visual).** Motion modal shows exactly one title row.

### Phase 3 gates
- **No feature hidden without an affordance (visual).** Controller shows the
  inline shortcut summary + a worded `?`; Gamepad collapsed sections show a worded
  summary + `Rebind (N)` badge; point-tab defaults (if collapsed) show `Defaults ⌄`.
- **Busy/error coverage (visual).** Trigger each W-Q site (DXF/Gerber/image parse,
  lens-solve, stream-start, mid-stream disconnect, gamepad-lost) and confirm a
  `<CamBusy>` then `<CamError>`-with-retry appears; disabled primary actions carry a
  `title`.

### Phase 4 gates
- **Contrast table (signed off).** A table of N text/bg pairs (incl. white-on-accent,
  muted labels, unit suffixes, glass chips) measured ≥ AA in **both** themes.
- **Unlabeled controls (grep + manual).** `grep -rEl '<button[^>]*>\s*<(svg|Icon)' src` reviewed; every hit has `aria-label`.
- **Live regions (grep).** `grep -rE 'aria-live|role="alert"' src/components` shows the GRBL-state/progress (polite) and ALARM/DISCONNECTED (assertive) regions (was **0** before).
- **Reduced-motion (grep).** Every new transition selector from W-L appears inside a `@media (prefers-reduced-motion: reduce)` block.
- **Mobile (visual).** Phone-preset screenshots show: tab strip edge-fade + active tab centered; Soldering/PCB reflowed to one column (no vertical preset rail, ≤1 horizontal scroll axis); bottom bar clears the safe-area inset.
