# Wave 2 roadmap build-out — status snapshot (2026-06-25)

Saved because of quota risk. **Agent code edits are already on disk** (killing an
agent does not revert its edits). Raw per-agent transcripts are in this dir as
`NN-name.<agentId>.raw.jsonl`. This file holds the human-readable final reports
of the agents that COMPLETED before the snapshot.

Wave 1 is committed at `51c636c` (toolpath/laser/PCB/3D-print/controller/visualizer/probing).

## Agent map (10 concurrent, disjoint files)
1. a93b4881de87a1efd — Carving (§4.1)            — DONE
2. ae48b72d192f94b17 — Writing/Pen (§4.5/4.6)    — DONE
3. a2b19a1328a871c9f — Laser (§4.2)              — DONE
4. ab827254481cca6d5 — PCB (§4.3)                — DONE
5. a04bc5971e6fcdd6e — 3D Print (§4.4)           — DONE
6. a530c95bbaba04dd1 — Visualizer (§2)           — DONE
7. a49d623ef90d133f8 — Soldering+Glue (§4.7/4.8) — DONE
8. ad29fbe5559dfd708 — Welding/Screw/Spring/PnP  — DONE (ALL 10 COMPLETE)
9. a6e9315ee1d29c06e — Machinist (§3)            — DONE
10. a77022ec672becde0 — Foundations+AI (§1/§5/ai)— DONE

## Integration follow-ups flagged by agents (cross-file, blocked under disjoint rules)
- W6 "Fit to bed" button: penOptimize.fitToBed() ready; needs bed-size from store wiring.
- O13 ETA accuracy: estimateProgramSeconds in src/components/programWindow.ts (constant-velocity → make accel-aware).
- O10 calibration/tuning: belongs in MotionPanel.tsx (GRBL settings editor).
- AI Phase 3: WebGPU model dep (@xenova/transformers / onnxruntime-web) + runtime-cache rule in vite.config.ts; materialSuggest.ts has TODO(ai-phase3) + rule-based fallback so it works without the model.

---

## DONE — Agent 2: Writing/Pen + Signature
New pure core `src/core/penOptimize.ts`: simplify (Douglas-Peucker), dedupe, linemerge,
linesort, reloop, multipass, occlude, fitToBed, estimatePlotTime/formatDuration,
modulateStroke(s), optimizePenPaths (dedupe→simplify→merge→occlude→reloop→sort→multipass).
- W1 ADDED (merge+sort toggles), W2 ADDED (simplify slider + dedupe), W3 ADDED (multipass 1–8×),
  W4 N-A (single font/color), W5 ADDED (travel-feed + pen-lift "dead slow"), W6 PARTIAL (core ready;
  one-click button needs bed store), W7 ADDED (hide-hidden occlusion), W8 ADDED (reloop),
  W9 ADDED (plot-time chip + new collapsible "Optimize" section).
- Signature S1 ADDED (Chaikin smoothing + pressure taper), S2 ADDED (batch array via arrayDuplicate).
- All strings t()-wrapped; G-code via gcodeEmitter ZMode.Pen safe-Z; tsc clean on owned files.

## DONE — Agent 9: Machinist/operational (§3)
- O5 start-from-line — ALREADY-DONE (safe preamble + safe-Z + modal restore verified).
- O7 check/validation — ADDED: checkProgram()+CheckFinding in ProgramPanel, "Check" button w/ badge
  (unsupported codes→err20, cut-before-feed→err22, XY outside bed soft-limit).
- O8 alarm explanations — ADDED: GRBL_ALARMS(1–9)+GRBL_ERRORS(1–38)+explainGrblMessage() in
  core/explainers.ts; surfaced in Console (w/ Unlock $X), Controller banner, Program mid-job block.
- O9 diagnostics export — ADDED: live pin states (Pn:), firmware/version, Export JSON + Export report.
- O13 ETA — PARTIAL (live ETA exists; accel-aware accuracy blocked in programWindow.ts).
- F8 pause/resume/abort — ALREADY-DONE. O10 calibration — N/A (MotionPanel, not owned).
- O1/O2/O3/O4/O6/O11/O12 verified present (Wave 1), no regression. tsc clean on owned files.

## DONE — Agent 10: Foundations + AI
- F2 array engine — ALREADY-DONE (arrayDuplicate.ts: expandArray/arrayTransforms/arrayCount,
  linear+radial spacing/stagger/rotation/sweep/faceOutward).
- F3 two-point alignment — ADDED: solveTwoPointAlignment() in transform.ts → pivot-relative Placement
  (offset+rot+uniform scale) + rotDeg/scale/rmsMm residual; lockScale option.
- F4 camera overlay — ALREADY-DONE (CameraBedPlane.tsx rectifies live video onto bed plane).
- X3 machine profile — N-A (store-side). X4 theming — N-A (app-side).
- AI Phase 1 markerless detect — ADDED: gated "Auto-detect job" in CameraPanel
  (silhouetteMask→largestBlobBBoxMm→review card→operator Apply/Discard; never auto-applied).
- AI Phase 3 — ADDED scaffold: src/core/materialSuggest.ts (rule-based classifier fallback + lazy
  WebGPU ML path memoized, TODO(ai-phase3), no first-paint bloat); gated "Suggest material" button;
  camera.css styles. tsc clean on owned files.

## DONE — Agent 7: Soldering + Glue
- SO1 ADDED per-point settleSeconds override + antiOozeMm dab-lift + global antiOozeFeed; CSV gained
  preheatSeconds,antiOozeMm (back-compat).
- SO2 ADDED global primeSeconds purge/prime at safe-Z before point 1 (in estimate).
- SO3 ADDED per-point preheatSeconds (dwell after touch-down, touch-down mode) in table+card+bulk.
- G1 ADDED DotShape primitive (click-to-place disc) + per-shape fill flag (concentric offset rings via
  shared insetRings) for area/potting.
- G2 ADDED leadInMm/leadOutMm for open beads (anti-blob/anti-tail); on/off delays already existed.
- G3 ADDED volume model volPerDotMm3/volPerMmMm3 → dotDwellMs()/estimateGlueVolume() + live mm³ chip.
- G4 ADDED per-shape dispenseZ override (touch-down Z).
- All G-code via safe emitters (Free-Z before XY, M3/G4/M5 feeder, no -0.000); cores pure; t()-wrapped;
  back-compat reads guarded ?? 0; new CSS only in glue.css. No cross-file blocks. tsc clean on owned.

## DONE — Agent 6: Visualizer (§2)
- V1 spindle/collet/tool mesh (spins about +Z, anti-Y-bug verified), V2 animated tool, V3 progress
  dimming/hide-processed, V4 per-op color+legend, V5/V6/O6, V11 gizmo/grid, V12 stock material-removal
  sim (heightmap/dexel) — ALREADY-DONE (Wave 1), no redo.
- V7 ADDED run-time row to DimensionsOverlay (DOM, memoized — FPS-safe).
- V8 ADDED right-click-to-jog (JogTarget plane, mounted only in jog-to mode; retract safe-Z then
  grbl.jog relative delta; gated connected+Idle/Jog; event-driven).
- V9 ADDED HeightmapSurface.tsx (probed grid → single static BufferGeometry, baked vertex colors, 1
  draw call; shown when grid complete).
- V10 ADDED ViewportHud (work XYZ/state/F-S; narrowly subscribed; DOM only).
- V14 ADDED tool timeline strip (Timeline.toolChanges[] M6/T detection; clickable scrub markers;
  hidden for single-tool jobs).
- FPS-safety: every new path DOM-only / single static geometry / event-driven — no useFrame work, no
  per-frame alloc, no sim regression. New file HeightmapSurface.tsx; edited Viewer.tsx,
  VisualizerPanel.tsx, simulation.ts. tsc clean on owned.
- BLOCKED cross-file: V11 soft-limit box + G54/machine-origin distinction → Bed.tsx (not owned);
  V13 editor-side line highlight → ProgramPanel.tsx (machinist agent owns); V6 separate SVG-render
  mode is a larger Canvas-setup effort, left untouched.

## DONE — Agent 5: 3D Print (§4.4)
- D1 tree supports, D2 presets, D3 preview, D5 arc fitting, D9 PA cal — ALREADY-DONE, untouched.
- D4 ADDED HeightModifier[] (per-Z-range infill density/walls/pattern, last-match-wins via resolveLayer)
  + collapsible editor.
- D6 ADDED auto-orient "lay flat" (area-weighted face-normal clustering → dominant facet faces −Z).
  Auto-arrange N/A (single-object panel, auto-centred).
- D7 ADDED adhesion SegControl (None/Skirt/Brim/Raft) + brim-loop count; infill-pattern picker (Gyroid
  default + Lines/Grid/Tri/Concentric); legacy skirt bool back-compat.
- D8 ADDED LayerHeightBand[] adaptive layer height (Z bands, per-layer thickness).
- D10 ADDED ironing toggle (top-surface detect → re-traverse tops tight spacing ~10% flow).
- All via safe emitter; heavy slicing stays in worker (one-shot auto-orient transform only on main);
  SegControl/SliderField reused; t()-wrapped; ≥36px touch. No cross-file blocks. tsc clean on owned.

## DONE — Agent 4: PCB (§4.3)
- P1 autolevel, P3 V-bit depth, P5 drill grouping/peck, P7 cutout tabs, P8 mirror, P9 layer viewer,
  P12 DRC, P14 paste→solder — ALREADY-DONE, untouched.
- P2 ADDED stepover MODE toggle (mm vs % overlap → step=cutterWidth·(1−overlap%), live mm readout).
- P4 ADDED copperPourClear() (boustrophedon raster of non-copper field inside outline, keepout
  toolRadius+clearance, multi-depth, row-guarded) + UI toggle/sliders.
- P6 ADDED millHoles()/millOneHole()/oversizedHoleCount() — holes > bit+threshold spiralled out
  (concentric rings, multi-depth) vs drilled; drill card splits oversized to mill pass.
- P10 ADDED origin handling originShift()/reoriginGerber()/reoriginExcellon() (asis/keep-positive/
  corner/center) across copper+drill+outline (+mirror datum); SegControl in Essentials.
- P11 ADDED cutLoopLayered() (IsolationOptions{stepdown,climb}) replaces single-depth isolation;
  depth-per-pass slider + Conventional/Climb SegControl (ring winding reversed for climb).
- P13 DEFERRED — selective region-paint isolation + rest-machining needs an interactive painting
  picker over the layer viewer; too large for a safe single pass. REMAINING GAP.
- All via Toolpath→GcodeEmitter (safe-Z before/after each feature); cores pure; t()-wrapped; new CSS
  .pcb-op-toggles. No cross-file blocks. tsc clean on owned.

## DONE — Agent 1: Carving (§4.1)  [reported tsc --noEmit exit 0 FULLY clean]
- C1 V-carve, C2 adaptive, C3 V+flat cleanup, C5 holding tabs, C6 multi-op pipeline (featureCam),
  C9 tool library, C10/C11 finishing/surfacing — ALREADY-DONE, untouched.
- C7 ADDED + wired: new core/carveStrategy.ts applyLeadRamp (tangent/arc leads + ramp/helix descent,
  no straight plunge) → Profile/Pocket via applyStrategyPost + "Cut strategy" panel section (Spindle only).
- C12 ADDED + wired: orientLoop climb/conventional winding + stockToLeave in CamParams (profile/pocket).
- C8 rest machining — ADDED core (restMachiningLoops), exported, NOT yet a panel op (needs prior-tool field).
- C13 V-carve inlay — ADDED core (vcarve.vCarveInlay male/female + glue gap + seating floor), exported,
  NOT wired (needs two-program emission UI).
- C15 drag-knife — ADDED core (carveStrategy.dragKnifeToolpath pivot-offset + corner swivel), exported,
  NOT wired as a panel mode.
- C4 visual work-origin picker — PARTIAL: data model + per-job stock dims exist; the translucent-stock-box
  click-corner/center/top handler needs the 3D viewer + src/store/stock.ts (BOTH read-only to this agent).
- strategy state persisted (karmyogi.carve.strategy) + session-zip round-trip. Reused existing CSS.
- FOLLOW-UP: ~30 new cc.strat.* i18n keys added inline only (catalog read-only) → needs i18n extraction
  pass across 53 locales.
- REMAINING (focused future batch): wire C8/C13/C15 panel ops; C4 viewer click-picker.

## DONE — Agent 3: Laser (§4.2)
- L1 engrave+dither, L3 framing, L4 test grid, L5 M4, L6 interval/overscan, L7 air, L16 S-min/max,
  L17 safety — ALREADY-DONE, untouched.
- L2 ADDED layer system (DXF layer-name grouping → per-layer enable + cut-order up/down; inner-first
  within layer). Note: dxf.ts (read-only) doesn't parse color index 62, so grouping keys off layer name.
- L8 ADDED optimizeTravel() greedy NN + seam rotation + open-line reversal (toggle, default on).
- L9 ADDED tabContour() (N evenly-spaced uncut gaps on closed loops) + Tabs card.
- L11 ADDED offsetFill() (insetRings spiral) + lineFill() (angled scanline hatch) + Fill card.
- L12 ADDED image trace — wired orphaned vectorize.ts (traceBitmap/simplify/fit) → "Trace image…".
- L14 ADDED rotary mode (Y→A/B/C/Y remap, mmPerDeg=π⌀/360, feed rescaled deg/min, X linear).
- L15 ADDED dot mode (per-pixel dwell, beam off between) + bidirectional scan-offset; invert/contrast/
  gamma/Z-focus/bidi already present. Low-power framing NOT added (needs read-only framing.ts/emitter).
- L18 ADDED fiber frequency(kHz)+Q-pulse(ns) as header comments (EZCAD-class); hatch via L11 fill.
- All vector paths via emitLaserProgram (M3/M4+S, S0/M5 on travel+end, beam off on every G0, fmt no
  -0.000); fills cut before perimeter so tabbed parts stay attached longest.
- BLOCKED: L15 low-power framing → framing.ts/gcodeEmitter.ts (read-only); chevron-up icon absent in
  read-only Icons.tsx → reused chevron-down rotated 180°. tsc clean on owned (laser.ts/laserImage.ts/
  LaserPanel.tsx/laser.css).

## DONE — Agent 8: Welding/Screw/Spring/PnP  [reported tsc --noEmit exit 0 zero errors]
- WE1 ADDED figure-8 (Lissajous 1:2) weave + per-object edge-dwell (sampleObjectEdges/isEdgePhase);
  sine/circular/zigzag existed. WE2 ADDED multi-pass beads (passes+passOffset root/fill/cap, Z-raised).
  WE3 ADDED craterSeconds + tack welds (tackCount/tackSeconds/tackPoints). WE4 ADDED per-object WFS+voltage.
- SC1 ADDED targetTorque comment + verifyDepth (G38.2 fault halt = part-present) + pauseEachScrew (M0).
  SC2 part-present via verify probe. SC3 ADDED array/grid fill via arrayDuplicate.expandArray.
- SP1/SP2 ALREADY-DONE. SP3 ADDED initialTension (extension preload, comment + SpringInfo).
- PP1 ADDED parts/package/footprint model+UI. PP2 ADDED feeder library (tape/tube/tray). PP3/PP4
  SCAFFOLDED vision (TODO — cameraCalib.ts read-only). PP5 ADDED nozzle-tip library. PP6 ADDED blow-off
  + part-present (G38.4). PP7 ADDED panelization (expandArray). PP8 ADDED park+discard.
- New CSS in screwdriving.css + pickplace.css (≥36px touch). All G-code via safe emitters; t()-wrapped;
  no cross-file blocks. tsc clean.

---
# ALL 10 AGENTS COMPLETE. 3 agents independently reported `tsc --noEmit` exit 0 (whole repo clean).
# Next: orchestrator integration typecheck + production build + Playwright sweep, then commit.
