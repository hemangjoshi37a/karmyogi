# Wave 3 roadmap follow-ups — status snapshot

Wave 2 committed/deployed at `c3d1999`. Wave 3 = carried-forward cross-file follow-ups,
10 disjoint-file agents. Agent edits are on disk (killing an agent does not revert them).

## Agent map
1. Carving wiring + C4 origin picker (CadCam+placement viewer+stock store) — DONE
2. Visualizer interaction (V13/V11/V6/L10; Viewer/Program/Bed)              — DONE
3. Machinist cal+ETA (O10/O13; MotionPanel/programWindow)                   — DONE
4. PCB region-paint (P13; PcbPanel/pcbCam)                                  — DONE
5. Laser low-power framing (L15; LaserPanel/laser/framing)                  — DONE
6. Writing fit-to-bed (W6/W4; WritingPanel/Signature/penOptimize)          — DONE
7. Connection wizard (X2/X3; ConnectionControl/machineProfile/machines)    — DONE (needs shell.tsx mount)
8. Mobile single-pane + perf (X5/X6; MobileShell/useIsMobile)              — DONE
9. Camera + AI (Phase1/Phase3; CameraPanel/materialSuggest/cameraCalib)    — DONE
10. i18n (translate Wave-1/2 backlog across 53 locales)                     — DEFERRED to next day
    (stopped to save quota before it wrote translations; _catalog.json revert kept clean. Re-run next
     day: scan codebase for t() keys missing from _catalog.json, add English, translate all 53 locales.
     Backlog now includes ALL Wave-1/2/3 inline keys: cc.strat.*, cc.* origin/inlay/rest/dragknife/2sided,
     laser frame/L15, pcb region, motion cal, mobile hud, connection wizard, camera AI, etc.)

## Integration follow-ups (orchestrator to wire)
- Viewer.tsx should consume useLowEndDevice() from src/app/useIsMobile.ts (clamp dpr, no AA/shadows,
  prefer SVG fallback on constrained devices) — coordinate with agent #2's V6 SVG-fallback work.
- shell.tsx (REQUIRED mount for X2 wizard): `import { ConnectionWizard } from '../components/ConnectionWizard'`
  then mount `<ConnectionWizard />` once at app root (near <PwaManager/>/<BackGuard/>, outside dock host).
  Self-gates (null unless setup pending). Works desktop+mobile.

---

## DONE — Agent 8: Mobile single-pane + perf (X5/X6)
- X5 ADDED MachineHud strip in MobileShell (state/work XYZ/feed/spindle, mirrors desktop Controller DRO
  contract; shown only when connected; collapsible to a state pill, persisted karmyogi.mobile.hud.collapsed;
  own component → status polling re-renders only the HUD). New src/styles/mobile.css scoped under
  .mobile-shell, clamp() sizing, ≥36px tap, safe-area, reduced-motion, ≤360px tightening. Kept top tab strip.
- X6 verified panels already React.lazy() in panelRegistry + MobileShell renders only active chunk + shell
  mounts MobileShell instead of dockview on mobile (no desktop chrome/heavy panel on phone). ADDED
  detectLowEndDevice()/useLowEndDevice() (save-data / deviceMemory≤4 / cores≤4 / coarse-pointer heuristic).
- No read-only-file lines needed. Viewer hook noted above. tsc exit 0.

## DONE — Agent 5: Laser low-power framing (L15)
- ADDED "Frame & focus (low power)" card: trace bbox or convex-hull at low operator-set power +
  momentary focus dot; gated connect+idle + arm→confirm.
- framing.ts: added pure convexHull() (Andrew monotone chain); existing callers untouched, no cycle.
- laser.ts: LaserFrameShape, kMaxFramePowerPct=30 (HARD clamp), buildFrameContour (box/hull + margin,
  hull→box fallback), emitLaserFrameProgram, laserDotOnCommand/kLaserOffCommand.
- BEAM-SAFETY: routed via emitLaserProgram (gcodeEmitter read-only); forces M3 Constant (never M4),
  pierce/focusZ/air off; power clamped ≤30% (cannot cut); S0 every travel/G0, S0 M5 footer; focus dot
  auto-extinguishes (M5 S0) on leaving Idle/disconnect; arm auto-disarms 4s.
- All strings t()-wrapped. No cross-file blocks. tsc clean on owned.

## DONE — Agent 3: Machinist cal+ETA (O10/O13)
- O13 ADDED: estimateProgramSeconds() rewritten constant-velocity → trapezoidal accel-aware lookahead
  planner (per-axis cruise cap $110-112, dir-projected accel $120-122, corner junction-speed cos(turn/2)
  backward/forward passes, trapezoidal/triangular per move, G4 dwell, G90/G91). Signature kept
  estimateProgramSeconds(lines, limits?) w/ DEFAULT_LIMITS → ProgramPanel ETA picks it up automatically;
  module stays pure.
- O10 ADDED: CalibrationSection in MotionPanel (inside $-editor): (1) steps/mm tuning — Idle-gated
  cancellable $J= measured move → corrected=current×commanded/measured → writes $100/$101/$102 behind
  explicit from→to confirm modal, re-syncs $$; (2) XY squaring diagnostic (mm+deg); (3) backlash
  there-and-back lost-motion readout. SAFETY: only steps/mm writes $-settings (GRBL has no skew/backlash
  comp → those stay measurement diagnostics, not invented $-writes); all moves cancellable Idle-gated
  $J= at safe feed, nothing written without confirm.
- t()-wrapped, no catalog edits, no cross-file blocks. tsc clean on owned.

## DONE — Agent 9: Camera + AI (Phase 1/3)
- Phase 1 HARDENED: detectStockSilhouette() = absDiff → Otsu auto-threshold (noise-floored) →
  morph open+close → largestBlobStats → bed-mm rect (replaces brittle fixed-28 threshold). Multi-signal
  confidence (area-band × dominance × fill × edge-touch penalty) + detectReason() line + live SVG preview
  overlay matching video object-fit. Apply-time guard if cameras[0].H missing. Explicit Apply/Discard only.
- Phase 3 HARDENED: fixed real bug (!bright float always-false → bright<0.4); confidence now absolute
  plausibility + separate share for ranking. Async suggestMaterial() (lazy WebGPU → rule-based fallback,
  model unbundled returns null safely), busy state, engine-source badge, feeds-safety note. "Use" sets only
  stock material id; feeds stay a suggestion, never auto-cut.
- Stays gated behind useExperimentalAI(); frames never leave device. t()-wrapped, no catalog edits, no
  cross-file blocks. tsc clean on owned.

## DONE — Agent 4: PCB region-paint (P13)
- ADDED rectangle picker: clipPolylineToRect() Liang-Barsky polyline→rect clipper; IsolationOptions.region
  routes every iso loop through emitIsolationLoop() (clip when region set, full loop otherwise; safe-Z
  preserved via cutLoopLayered). CopperClearOptions.region clamps raster; restToolRadiusMm adds rest pass
  (small tool clears band inside prior larger tool's keep-out).
- UI: LayerViewer drag-to-paint rectangle (pointer events, screen→mm via inverse getScreenCTM, touch
  touch-action:none), "Paint region" toggle, dashed/solid overlay; iso card region checkbox + rest
  machining prior-Ø slider + warning. Region mapped through same origin-shift+mirror as copper.
- FOLLOW-UP: polygon/freeform region (only rectangle shipped); true pinch-gap rest approximated via NCC
  band-difference. No cross-file blocks. tsc clean on owned.

## DONE — Agent 6: Writing fit-to-bed + Signature (W6/W4)
- W6 ADDED "Fit to bed" buttons (Writing Placement card + Signature send bar) → penOptimize.fitToBed()
  reading useBed.getState() (read-only), bed−5mm margin, scales charHeight/letterSpacing (Writing) or
  drawW/H/targetW/H (Signature) by fit.scale, recenters origin; status shows scale+offset.
- W4 ADDED (was N-A): "Pen change" toggle — when Passes>1, turns passes into colour layers, M0 pause
  between copies (withPenChangePauses); SAFETY splits off safe header/footer + lifts pen before every M0
  (never pauses pen-down); returns unchanged if header/footer not found. Persisted .kwrite + presets;
  plot-time ×passes.
- New CSS only in writing.css/signature.css; penOptimize stays pure (M0 stitching in panel, operates on
  emitted G-code). t()-wrapped. No cross-file blocks. tsc clean on owned.

## DONE — Agent 7: Connection wizard + profiles (X2/X3)  [needs shell.tsx mount — see above]
- X2 ADDED ConnectionWizard.tsx: self-gating 3-step first-launch flow (pick model → transport USB/Wi-Fi/
  Mock + baud → suggest homing). Gated on machineProfile.configured; auto-marks for returning users.
  SAFETY: sends no motion; homing only on explicit "Run homing ($H)" button. New connection.css (.km-cw-*).
- X3 ADDED MACHINE_MODELS library (Genmitsu 3018-PRO/3020/4040, Shapeoko 3/XXL, X-Carve, OpenBuilds
  LEAD/WorkBee, FluidNC, Ortur, Marlin/custom) w/ bed+firmware+$-settings; modelFor(), setMachineModel
  (applies firmware+baud+bed), restoreDefaults (returns $-settings, sends nothing), detectedModelId,
  configured/markConfigured/reopenSetup. machines.ts: firmwareToModelId + non-destructive model suggestion
  on connect (never silently changes bed). ConnectionControl: "Setup wizard…" button → reopenSetup().
- t()-wrapped, no catalog edits. tsc clean on owned.

## DONE — Agent 1: Carving wiring + C4 origin picker
- C4 ADDED transient pickingOrigin in store/stock.ts; StockBlock.tsx renders clickable 3D handles
  (centre+front-left → setXYOrigin, top+bottom face → setZRef, highlighted/labelled); "Work origin"
  CadCam section w/ "Pick origin in 3D" toggle + SegControls; auto-disarms on unmount. No Viewer.tsx change.
- C8 ADDED rest machining wired (restFilter in build2DToolpathsForFile via carveStrategy.restMachiningLoops;
  toggle + prior-tool-Ø slider).
- C13 ADDED V-carve inlay sub-mode (vcarve.vCarveInlay; glue-gap + seating-floor); emits TWO safe sections
  (female pocket + male plug) via pushSection, each full safe-Z header/footer.
- C15 ADDED drag-knife Profile mode (carveStrategy.dragKnifeToolpath; blade-offset + swivel-angle).
- C14 ADDED registration dowels (twoSided.buildRegistrationDrills along flip mirror centre line =
  self-registering; count/Ø/depth/edge-inset; safe-Z per hole, fmt no -0.000).
- BUGFIX: 2D genKey omitted strategy → C7/C12/C8/C15 controls didn't live-regenerate; folded strategy
  into key+deps. Plumbed via parseStrategy/parseVcarve/defaultTwoSidedParams (persist+session round-trip).
- t()-wrapped, new CSS only .cc-pick-origin-btn. No cross-file blocks. tsc clean on owned.
