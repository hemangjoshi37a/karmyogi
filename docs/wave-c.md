# Wave C — charter (DRAFT for discussion)

> Purpose of this doc: state the **motive** of Wave C first, so we can agree what
> to tackle now, what to defer, and what to avoid — before any code or agents run.

## Motive (the "why")

karmyogi is **feature-complete but still rough in places.** Wave C is a
**hardening + consolidation + polish wave** — NOT a new-feature wave — to take the
existing surface from "works on my machine" to **genuinely production-grade**:
trustworthy, consistent, safe, and pleasant for a real public audience (the
"1,000,000 users, no-bug" bar). New ideas (the AI/camera direction) are **parked
as archival** (`docs/ai-roadmap.md`); Wave C does not add scope, it makes what we
already have solid.

Three pillars, in priority order:
1. **Correctness / safety** — no broken workflows, no unsafe G-code, no data loss,
   no console errors. This is the "no-bug policy" made concrete.
2. **Consistency / polish** — every tab feels like one app: same spacing, controls,
   labels, density, iconography, and the enterprise-grade compact look (the app-bar
   polish is the bar). Fully usable desktop **and** mobile, same mental model.
3. **i18n integrity** — every shipped string is translated across all 53 locales
   (currently PASS — keep it PASS).

## Principles / rules of engagement (lessons from Wave A)

Wave A made "very bad decisions" — sweeping changes that broke working things
(3D viewport, live toolpath gen, machine comms). Wave C must not repeat that:

- **Do no harm.** Never regress something that already works to polish something
  that's merely imperfect. Working > pretty.
- **Audit before edit.** Find + verify issues first; fix with intent, not blanket
  rewrites. Each fix is small, justified, and individually verified.
- **Closed-loop everything.** Every change is verified in the real browser
  (Playwright) at desktop **and** mobile widths, with a screenshot looked at — not
  assumed. `tsc` clean + i18n PASS after every batch.
- **Never hot-edit the live serial controller.** `controller.ts` + the serial
  singleton must not be edited while a machine is connected (HMR corrupts the
  live connection). Batch → restart → verify → hand back.
- **Disjoint file ownership** for any parallel agents (the golden rule). No two
  agents touch the same file; shared wiring is integrated by me between batches.
- **Pure core stays pure.** `src/core/*` stays UI-independent; don't bend it for UI.
- **Surface, don't hide.** If a pass can't cover something or makes a tradeoff,
  say so — no silent truncation.

## Candidate scope (to be prioritized together)

A. **Correctness sweep** — per-tab: load real inputs, exercise the main action,
   watch for console errors / broken state / crashes. Especially: carving
   (all `test_stl_files`), PCB (Gerber/Excellon), DXF import, soldering table,
   pick&place, writing, laser, welding, glue, signature.
B. **G-code safety audit** — every emitter path: G21/G90/G94/G17 header, guaranteed
   safe-Z retract before XY travel + at end, no `-0.000`, correct Spindle/Pen/Feeder
   Z semantics, conservative feeds. This is the highest-consequence area.
C. **UI consistency + polish** — shared spacing/typography/controls tokens; align
   every panel to the enterprise-grade compact look; consistent labels/tooltips.
D. **Mobile responsiveness** — every tab usable on a phone (the app-bar is done;
   the panels/tables/jog pads/number fields still need a sweep).
E. **i18n integrity** — confirm no English-only leaks; keep all 53 locales complete.
F. **Performance / 1M-ready** — code-split sanity, no UI-thread blocking on heavy
   compute, error boundaries hold, no excessive Firebase/Firestore calls.

## Explicitly OUT of scope / avoid right now

- New features (AI/camera/material/scan — parked as archival).
- Rewriting the carve/toolpath **engine behavior** (Phase 2 of the AI roadmap owns
  that, separately + battle-tested). Wave C may FIX toolpath *bugs*, not redesign.
- Any edit to the serial controller while a machine is connected.
- Large refactors / dependency changes / architecture churn.
- Visual changes that trade away working behavior for looks.

## Method

1. **Audit** (read-only, parallel agents, one per tab/area) → findings.
2. **Adversarially verify** each finding (is it real? reproduces?) → drop false
   positives → prioritized list (P0 break > P1 bug > P2 polish > P3 nit).
3. **Fix** in small disjoint batches, closed-loop verified, `tsc` + i18n green.
4. **Re-verify** end-to-end; restart dev server clean; hand back.

## Decisions (locked with owner)

- **Method per item:** SEE current state (read code + look at it in the running app)
  → implement the fix → **battle-test visually** with different scenarios in the real
  browser, confirming the app behaves as it should. Do-no-harm throughout.
- **i18n translation is DEFERRED for Wave C.** New English strings use
  `t('key','English fallback')` and show the fallback; we do ONE translation pass
  across all 53 locales at the END of Wave C, once everything is working. So
  `i18n:check` may report missing keys mid-wave — that is expected and accepted.

## Definition of done

- No P0/P1 left; P2/P3 triaged with a written list of what's deferred and why.
- `tsc --noEmit` clean; i18n PASS (53/53); production build clean.
- Every touched tab verified in the closed loop at desktop + mobile.
- A short report of what changed, what was verified, and what was deliberately
  left alone.

## Open questions for you

1. **Priority** — lead with correctness/safety (A+B), or with polish/mobile (C+D)?
2. **Breadth now** — all tabs at once, or a focused subset first (which)?
3. **Fix appetite** — should agents *propose* fixes for your review, or fix +
   verify directly within the rules above?
4. Anything from Wave A you specifically want me to **steer clear of**?

---

## Audit findings (read-only, 10 parallel agents) — prioritized

**G-code safety: ALL 14 emit paths verified SAFE** (header, guaranteed safe-Z, no -0.000, spindle/laser/feeder off at end). No P0 in the safety contract. Two improvements only: AI-lint is advisory (gate/promote), framing.ts omits `G94 G17`.

### P0 / high-value (fix first)
- **GPU leak → 3D white-screen** — `viewer/Toolpath.tsx:119,192`, `StockBlock.tsx:50`: dispose cleanups use `useMemo(()=>()=>…)` which NEVER runs → orphaned geometries/materials accrue → WebGL context loss (the white-screen). Fix: `useMemo`→`useEffect`. **[low risk, high value]**
- **Carving Decimals crash** — `CadCamPanel.tsx:2017`+`gcodeEmitter.ts:89`: out-of-range decimals → `toFixed()` RangeError, silent gen failure. Clamp [0,6]. **[low risk]**
- **Glue decimals white-screen** — `glue.ts:135`: corrupt/loaded negative `decimals` → `toFixed(<0)` throws in render. Clamp in `fmt`. **[low risk]**
- **Soldering XY-below-safeZ** — `soldering.ts:151`: first/inter-point XY travel at freeZ when freeZ<safeZ. Travel at `max(freeZ,safeZ)`. **[med — changes output, verify]**
- **Soldering plungeFeed=0** → `G1 Z F0` GRBL alarm. Floor to ≥1. **[low risk]**
- **Welding mid-stream reset** — `WeldingPanel.tsx:444`: no `streaming` guard (Glue has it). Mirror it. **[low risk]**
- **PickPlace** — `PickPlacePanel.tsx:268`: no stale-section clear on empty + no streaming guard. **[low risk]**
- **Laser focusZ** — `laser.ts:258`: negative focusZ from loaded file → `G0 Z-…` first move. Clamp ≥0 in core. **[low risk]**  +  `laser.ts:280`: pierce dwell uses coord decimals → `G4 P0` at decimals=0. Own precision. **[low risk]**
- **framing.ts:199,289** — add `G94 G17`. **[trivial]**
- **Viewer Delete key** — `Viewer.tsx:195`: window-scoped → deletes selected shape from anywhere. Scope to container. **[low risk]**

### P0/P1 needing care (discuss/verify before edit)
- **PCB Run streams the WHOLE combined program**, not just the PCB section (`PcbPanel.tsx:597`). **[med — WYSIWYG model]**
- **PCB Pen mode** zeroes drill/cutout depth (`makeEmitter`). Gate Pen to isolation. **[med]**
- **Print cold-extrude** — `M109/M190` don't block on GRBL + `G28` homing assumption (`slicer.ts:744`). Needs prominent warning. **[firmware-dependent]**
- **Controller inch/mm mismatch** — DRO shows inches, jog/zero send mm labeled "mm" (`ControllerPanel.tsx`). **[risky — verify vs C++]**
- **Motion settings write** has no validation gate; panel detects corruption but Saves it anyway (`MotionPanel.onSave`). Gate danger values. **[med]**
- **ProgramPanel Stream** not gated on machine state (Alarm/Hold) (`ProgramPanel.tsx:172`). **[low-med]**

### P1/P2 polish (later in wave)
- Carving: dead "Pull-up Z speed" control; numeric fields snap to constants on blank-entry.
- Writing: missing-glyph warning vs wrong font; StrokeFont space inconsistency.
- Camera: shared `recError` across Capture/Timelapse cards; QR double-click guard.
- CoordSystem: feedback banner never cleared.
- AI lint: safe-Z retract flagged as error on small bed height.
- **Mobile touch targets:** many panels keep 28px controls on coarse-pointer wide (tablet) — needs `@media (pointer:coarse)` bump. Broad, do carefully.

---

## Progress — Batch 1 (low-risk, high-value) ✅ done + verified

Fixed (typecheck clean; 3D viewport battle-tested through theme toggles — renders, 0 console errors):
- **GPU leak → 3D white-screen** — `Toolpath.tsx`, `StockBlock.tsx`: dispose cleanups now `useEffect` (were dead `useMemo`). Verified: viewport survives repeated geometry rebuild/dispose.
- **Decimals crash** — added `clampDecimals()` in `gcodeEmitter.ts` (ctor + setOptions) → no more `toFixed` RangeError; protects every emitter caller.
- **Glue / Laser white-screen** — defensive decimals clamp in their local `fmt()`.
- **Laser focusZ** — clamped `>= 0` in the CORE (both emit sites) so a loaded negative focusZ can't emit `G0 Z-…`.
- **Laser pierce dwell** — uses its own 3-dp precision (was coord `decimals`; `decimals=0` made the dwell vanish).
- **Soldering** — pre-travel XY raise now `max(freeZ, safeZ)` (no XY travel below safe height); plunge feed floored to ≥1 (no `F0` stall).
- **Welding + Pick&Place** — added `streaming` guard so a live edit can't reset a running stream; Pick&Place also clears its section when emptied.
- **framing.ts** — added `G94 G17` to both headers.
- **Viewer Delete key** — scoped to pointer-over-viewport / focus-within (was window-global → deleted shapes from any panel).

All are HMR-safe (no serial-controller edits); the running dev server reflects them.

### Next batches (not yet done)
- **Batch 2 (needs care / discuss):** PCB Run streams whole combined program; PCB Pen mode zeroes drill/cutout; Print cold-extrude/`G28` warnings; Controller inch/mm mismatch; Motion settings write-validation gate; Program Stream gated on machine state.
- **Batch 3 (P1/P2 polish):** carving dead "Pull-up Z" control + blank-entry constant-snap; Writing missing-glyph-vs-font + space; Camera shared recError + QR double-click; CoordSystem stale feedback; AI safe-Z lint false error; mobile touch-target sweep (`@media pointer:coarse`).
- **End of wave:** i18n translation pass for all new strings (deferred per owner).
