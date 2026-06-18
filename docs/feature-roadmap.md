# karmyogi — Feature & UX Roadmap

> A competitor-informed plan to make karmyogi the most capable **and** the most
> approachable browser CNC + CAD/CAM workbench. Mined from gSender, ncSender,
> CNCjs, UGS, bCNC, OpenBuilds, Candle, LightBurn, LaserGRBL, FlatCAM, pcb2gcode,
> Kiri:Moto, Carbide Create, Estlcam, VCarve, PrusaSlicer/OrcaSlicer/Cura/Bambu,
> vpype, saxi, AxiDraw, OpenPnP, and dispensing/welding/coiling references.
>
> **Status: PLAN ONLY.** Nothing here is implemented until explicitly approved.
> We pick items by number and implement them one batch at a time, each verified
> in the closed loop (build → drive the real browser → screenshot → judge).

---

## 0. Product principles (govern every item below)

These are non-negotiable acceptance criteria for **every** feature we add:

1. **Maximum capability** — match or beat the best dedicated tool *per workbench*,
   not just generic CNC senders.
2. **Understandable at a glance** — the visible UI explains itself through clear
   labels, icons, grouping, visual hierarchy, smart defaults, and inline previews.
   A new user should grasp *what a control does* without reading anything.
3. **Tooltips/explainers as the second layer** — every parameter and action carries
   an ⓘ / hover explainer (the deeper "why/how"), so nobody is ever stuck — but the
   explainer is optional, not required.
4. **Fully i18n** — every new string ships as `t('key','English')`; explainer text
   is translated across all 53 locales (tooltips included). No English leaks.
5. **FAANG-sleek & compact** — modern, dense-but-calm, minimal scrolling, "see &
   reach the most from one screen," consistent with the panels we've already
   polished. Two-level **Recommended → Custom/Expert** disclosure everywhere.
6. **Fast** — code-split heavy modules, lightweight render paths for low-end /
   mobile, no main-thread freezes (cf. the gamepad-STEP fix).
7. **High SEO** — keep the crawlable content, per-locale URLs, structured data, and
   per-feature landing content growing as the app grows.
8. **Browser-native advantages first** — exploit what desktop apps can't: zero
   install, instant share links, webcam vision, PWA offline, AI assist.

---

## 1. Cross-cutting foundations (build once, reused by many workbenches)

These reusable engines unlock multiple workbenches and should come early.

| # | Foundation | Powers | Why | Impact | Effort |
|---|---|---|---|---|---|
| F1 | **Teach / record-position from jog** — jog the machine, capture X/Y/Z(/A) into a named point or table row | Soldering, Glue, PnP, Screw, Signature anchors, PCB ref, fiducials | Fastest way to define points without CAD; we already have DRO+jog | **H** | **L** |
| F2 | **Array / grid duplication engine** — replicate any op across rows×cols / radial, with spacing, offset, rotation | Batch signing, PnP panels, screw grids, dispense arrays | One build → value in 5+ modes | **H** | **M** |
| F3 | **Two-point alignment transform** — capture 2 reference features (jog-click or camera) → offset+rotation+scale applied to the whole job | PnP fiducials, soldering, dispensing, screw, print-and-cut | Aligns any job to a real, imperfectly-placed workpiece | **H** | **H** |
| F4 | **Camera overlay / live alignment view** — webcam (HTTPS, already used) as a top-down overlay on the 3D view | PnP, soldering, glue, laser align, PCB | Turns blind XY into see-what-you-target; browser-native edge | **M** | **H** |
| F5 | **Per-point / per-segment parameter table widget** — one editable "points with params" table (dwell, depth, feed, torque, weave…) | Soldering, Glue, Welding, Screw, PnP | Every actuation workbench needs the same UI; build once | **M** | **M** |
| F6 | **Two-level UI scaffolding (Recommended → Custom/Expert)** + universal **hover-help** + **last-used-as-default** | Every panel | Core of the glance-to-understand mandate; keeps first screen tiny | **H** | **M** |
| F7 | **Preset/profile system as the on-ramp** — pick material/tool/machine → fields auto-fill; manual override secondary | Carving, Laser, Printing, PCB | Removes trial-and-error; matches "anyone can use it" | **H** | **M** |
| F8 | **Pause / resume / abort with safe re-entry** (return to exact position, restore modal state, safe-Z) | All streaming jobs | Long jobs need recoverable interruption | **M** | **M** |

---

## 2. The 3D Visualizer overhaul (a signature differentiator)

> You specifically liked ncSender's realistic-spindle visualizer. None of the GRBL
> senders do true *stock material-removal* sim well — that's our moonshot.

| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| V1 | **Realistic spindle + collet + tool body mesh** at the live tool position, sized to the active tool ⌀ (replace the point/crosshair) | ncSender | **H** | **M** |
| V2 | **Animated tool follows the path** during running/simulated jobs, synced to GRBL line progress | ncSender, CNCjs, UGS | **H** | **M** |
| V3 | **Progress dimming** — executed cut lines desaturate, remaining stays bright; option to hide processed lines | gSender, UGS | **H** | **L** |
| V4 | **Per-tool / per-operation path coloring** + legend (each tool/CAM op its own color) | gSender 1.6 | **H** | **L** |
| V5 | **Preset camera views** (Top/Front/Right/Iso) + Fit + reset, one-click | UGS, OpenBuilds | **M** | **L** |
| V6 | **Lightweight / SVG fallback render mode** for huge files & weak devices (Pi/phone) | gSender SVG viz | **H** | **M** |
| V7 | **In-viewport measurement / ruler** + bounding-box dims (X/Y/Z) + run time | UGS, NC Viewer | **M** | **M** |
| V8 | **Right-click-to-jog** — click a point in 3D → jog there (safe-Z first) | UGS | **M** | **M** |
| V9 | **Heightmap overlay** — render the probed surface as a colored mesh (ties to PCB autolevel) | Candle, bCNC | **M** | **M** |
| V10 | **Live DRO/state HUD overlay** inside the viewport (work pos, state, feed/spindle) for fullscreen/phone | cncjs, Carbide | **M** | **L** |
| V11 | **Origin/axis gizmo + bed grid w/ labeled extents + soft-limit box**; distinct G54 vs machine origin | OpenBuilds, UGS | **M** | **L** |
| V12 | **★ Stock material-removal simulation** — render the stock block and carve it away as the tool passes (heightmap/dexel or voxel) | CAMotics/CutViewer class; no GRBL sender does this well | **H** | **H** |
| V13 | **G-code editor ⇄ 3D link** — syntax-highlighted editor; click a line → highlight in 3D and vice-versa | gSender 1.6 | **M** | **M** |
| V14 | **Tool timeline strip** — horizontal bar showing where each tool change occurs along the job | gSender 1.6 | **M** | **L** |

---

## 3. Operational / machinist layer (makes real jobs safe & reliable)

These are the biggest gaps vs. dedicated senders and apply across CNC workbenches.

| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| O1 | **★ Auto-leveling / heightmap probing** — probe a grid → Z surface → warp G-code Z (bilinear interp, split long segs, linearize arcs, apply once) | bCNC, Candle, pcb2gcode, OpenCNCPilot | **H** | **H** |
| O2 | **Probing wizard suite** — Z-touch, XYZ-corner, center-find, tool-length; guided dialogs + bit ⌀ + safe moves | gSender, OpenBuilds, UGS | **H** | **M** |
| O3 | **Surfacing / wasteboard-flatten generator** — area + tool + stepover/feed → pattern (spiral/zig-zag/ramp), preview | gSender, OpenBuilds, Kiri:Moto | **H** | **M** |
| O4 | **Tool-change (M6) wizard** — pause-and-prompt / run-macro / sensor-ATC strategies, remembered per job | gSender, Candle | **H** | **M** |
| O5 | **Start-from-line / job recovery** — resume an interrupted job at any line w/ safe pre-positioning + modal restore | gSender, UGS | **H** | **M** |
| O6 | **Run-outline / dry-run** — trace XY bounding box at safe-Z before cutting *(we already have Frame — extend to convex hull + low-laser variant)* | gSender, OpenBuilds | **H** | **L** |
| O7 | **Check / validation mode** — parse program before run; flag errors / out-of-bounds / unsupported codes | gSender, CNCjs `$C` | **M** | **L** |
| O8 | **Plain-language alarm/error explanations** — map GRBL ALARM/error codes → cause + fix, inline in console + banner + Unlock | ncSender, community | **H** | **L** |
| O9 | **Diagnostics panel + export** — pin states (limits/probe/door), firmware/build, one-click PDF/JSON report; + run stats & maintenance reminders | gSender | **M** | **M** |
| O10 | **Calibration / tuning** — steps/mm movement tuning, XY squaring, backlash; ties to the existing GRBL settings editor | gSender | **M** | **M** |
| O11 | **Coolant / aux outputs** (M7/M8/M9) + rapid-to-corner + safe-park + spindle warm-up, as labeled toggles | gSender, CNCjs, ncSender | **L–M** | **L** |
| O12 | **Dead-man / hold-to-jog + lockout** for touch/gamepad safety | ncSender, gSender | **M** | **L** |
| O13 | **Accel-aware job time estimate** (ETA + % + elapsed, updates with overrides) *(we show estimate — improve accuracy)* | gSender 1.6 | **M** | **M** |

---

## 4. Per-workbench roadmaps

### 4.1 Carving (2D/3D CAD-CAM)
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| C1 | **★ V-carving** (variable-depth from vector medial axis) — sharp signs/text/logos; pairs with our stroke-font Writing | VCarve, Carbide Create, Easel Pro, Estlcam | **H** | **H** |
| C2 | **★ Adaptive / trochoidal clearing** (constant tool engagement) — ideal for low-rigidity desktop machines | Fusion, Estlcam | **H** | **H** |
| C3 | **Advanced V-carve + flat-bit cleanup combo** (V outline + endmill pocket the rest) | Carbide Create Pro, VCarve | **H** | **M** |
| C4 | **Stock setup + visual work-origin picker** (translucent stock box; click corner/center/top) | Kiri:Moto, Fusion | **H** | **M** |
| C5 | **Click-to-place holding tabs/bridges** | Kiri:Moto, Easel, Estlcam | **H** | **M** |
| C6 | **Stacked multi-op pipeline** (rough→finish→V-carve→cutout), drag-reorder, per-op tool + auto tool-change | Kiri:Moto | **H** | **M** |
| C7 | **Lead-in/out + ramped & helical plunge** (no straight plunges) | Carbide Pro, Estlcam, Fusion | **M** | **M** |
| C8 | **Rest machining** (clear only leftover material) | Fusion, Carbide Pro | **M** | **M** |
| C9 | **Tool library + feeds/speeds presets per material** | Fusion, Easel | **H** | **M** |
| C10 | **Finishing strategies** — parallel/raster, offset/contour, pencil/scallop | Kiri:Moto, Fusion | **M** | **H** |
| C11 | **Surfacing/Level facing op** *(= O3, shared)* | Kiri:Moto | **M** | **L** |
| C12 | **Climb/conventional + stock-to-leave** allowance | Carbide Pro, Fusion | **M** | **L** |
| C13 | **V-carve inlay mode** (male/female pair + glue gap) | VCarve/Sienci | **M** | **M** |
| C14 | **2-sided registration / flip holes** | Kiri:Moto | **L** | **M** |
| C15 | **Drag-knife support** (blade offset + corner swivel) | Estlcam, Kiri:Moto | **L** | **M** |

### 4.2 Laser
*(have: power/speed/passes, kerf, multi-pass, nesting, CO2/fiber presets)*
| # | Item | Source | Tier | Impact | Effort |
|---|---|---|---|---|---|
| L1 | **★ Image raster engraving + dither** (Threshold/Ordered/Jarvis/Stucki/Atkinson/Newsprint/Halftone + grayscale depth) | LightBurn, LaserGRBL | table-stakes | **H** | **H** |
| L2 | **Layer system** — group by color; per-layer power/speed/passes/air + explicit cut order | LightBurn | table-stakes | **H** | **M** |
| L3 | **Framing / outline** (bbox + convex-hull "rubber-band") at low power *(= O6)* | all | table-stakes | **H** | **L** |
| L4 | **Material test grid generator** (Power×Speed/Interval/Passes, labeled) | LightBurn | table-stakes | **H** | **M** |
| L5 | **M4 variable-power ramping** (vs M3 constant) | LightBurn default | table-stakes | **H** | **L** |
| L6 | **Interval/DPI + scan angle + overscan** | LightBurn | table-stakes | **H** | **M** |
| L7 | **Per-layer air-assist** (M7/M8/M9) | LightBurn | quick win | **M** | **L** |
| L8 | **Cut-order optimization** (inner-first, travel reduction, start point) | LightBurn cut planner | high | **H** | **M** |
| L9 | **Tabs/bridges on cut paths** | LightBurn | mid | **M** | **M** |
| L10 | **Power-intensity heat-map in 3D viewer** (color path by S-value) | gSender | differentiator | **M** | **M** |
| L11 | **Offset (spiral) fill** vs line fill *(reuses our offset/inset core)* | LightBurn | high-reuse | **M** | **M** |
| L12 | **Image trace (bitmap→vector)** | LaserGRBL, LightBurn | differentiator | **M** | **H** |
| L13 | **Camera alignment / overlay** *(= F4)* + **print-and-cut** registration *(= F3)* | LightBurn | differentiator | **M** | **H** |
| L14 | **Rotary mode** (axis map + diameter→steps/deg) | LightBurn, EZCAD | mid | **M** | **M** |
| L15 | **Z-per-pass focus stepping**, **focus/low-power toggle**, **dot mode**, **bidirectional scan-offset**, **image adjust (invert/contrast/gamma)** | LightBurn, LaserGRBL | quality | **M** | **L–M** |
| L16 | **S-MIN/S-MAX power mapping + `$30` guardrail** | LaserGRBL | quick win | **M** | **L** |
| L17 | **Laser safety guardrails** (confirm-before-fire, travel power 0, missing-air-assist warn, prominent kill) | — | quick win | **H** | **L** |
| L18 | **Fiber/galvo hatch** (angle/spacing/ring) + frequency/Q-pulse for the fiber preset | EZCAD | niche | **L** | **M** |

### 4.3 PCB
*(have: Gerber+Excellon → isolation, drill, cutout staged)*
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| P1 | **★★ Auto-leveling / heightmap** *(= O1; THE unlock for isolation — copper is ~35µm; flat-Z can't work)*. Auto probe-area from toolpath extents → grid → G38.2 cycle → bilinear warp at send → render surface in 3D; **apply exactly once** | bCNC, Candle, pcb2gcode | **H** | **M–H** |
| P2 | **Multiple isolation passes** (count + overlap %) *(reuses offset core)* | FlatCAM, pcb2gcode | **H** | **L–M** |
| P3 | **V-bit isolation depth-from-width** (`width=tipDia+2·Z·tan(θ/2)`) + tool-width calculator | FlatCAM | **H** | **L** |
| P4 | **Copper-pour / non-copper region clearing** (NCC; reuse pocket logic) | FlatCAM | **M** | **M** |
| P5 | **Drill peck + dwell + tool-size grouping** (per-diameter programs) | FlatCAM, pcb2gcode | **M** | **L–M** |
| P6 | **Mill-drill / mill-holes + slots** (holes bigger than the bit) | pcb2gcode, FlatCAM | **M** | **M** |
| P7 | **Cutout tabs/bridges** *(extend existing cutout)* | FlatCAM | **M** | **L–M** |
| P8 | **Double-sided: mirror + fiducials/dowel pins** | FlatCAM, pcb2gcode | **M** | **M** |
| P9 | **Gerber/Excellon layer viewer** w/ per-layer visibility + colors | all | **M** | **L–M** |
| P10 | **Units/origin handling** (mm/inch, corner/center, keep-positive) + **Edge.Cuts** as cutout source | KiCad workflow | **M** | **L** |
| P11 | **Multi-depth** (reuse) + **climb/conventional** | FlatCAM | **M** | **L** |
| P12 | **DRC-lite** — warn if tool/V-width can't clear the smallest gap | derived | **M** | **M** |
| P13 | **Selective isolation** (region/paint) + **rest machining** | FlatCAM | **L** | **M** |
| P14 | **Paste layer → feed pad centroids into our Soldering mode** (unique tie-in) | karmyogi-native | **L** | **M** |

### 4.4 3D Printing
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| D1 | **★ Tree/organic supports (auto) + paint-on enforcers/blockers** | PrusaSlicer, Cura, Bambu | **H** | **H** |
| D2 | **★ Material/printer presets + Recommended↔Custom modes** *(= F6/F7)* | Bambu, Cura | **H** | **M** |
| D3 | **Layer/feature-type preview coloring** (perimeter/infill/support/bridge + by speed) + layer scrub | PrusaSlicer, Orca, Cura | **H** | **M** |
| D4 | **Per-object / height-range modifiers** | PrusaSlicer, Cura, Bambu | **M** | **M** |
| D5 | **Arc fitting (G2/G3 output)** *(smaller files, smoother Web-Serial streaming; reusable for carving)* | PrusaSlicer ArcWelder | **M** | **M** |
| D6 | **Auto-arrange / auto-orient on plate** | Bambu, Cura | **M** | **M** |
| D7 | **Adhesion (skirt/brim/raft) + infill pattern/density picker (gyroid default)** | all | **M** | **L** |
| D8 | **Variable/adaptive layer height** (paintable Z-profile) | PrusaSlicer, Orca | **M** | **H** |
| D9 | **Pressure/linear advance + calibration test patterns** (PA tower, flow) | OrcaSlicer | **M** | **M** |
| D10 | **Ironing toggle** for smooth tops | Bambu, Cura | **L** | **L** |

### 4.5 Writing / Pen plotter
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| W1 | **★ Path optimization (linemerge + linesort)** — minimize pen-up travel | vpype, saxi | **H** | **M** |
| W2 | **Line simplify (Douglas-Peucker) + dedupe** | vpype | **M** | **L** |
| W3 | **Multipass plotting** (draw N× for bolder lines) | vpype | **M** | **L** |
| W4 | **Per-layer pen change w/ pause** (split by color/group) | AxiDraw, saxi | **M** | **M** |
| W5 | **Pen-up/down height + lift/lower speed ("dead slow") tuning** | AxiDraw | **M** | **L** |
| W6 | **Auto scale + center to bed** | saxi | **L** | **L** |
| W7 | **Hidden-line / occlusion removal** | vpype-occult | **M** | **H** |
| W8 | **Reloop (seam randomization on closed paths)** | vpype | **L** | **L** |
| W9 | **Motion preview + plot-time estimate** | saxi | **M** | **H** |

### 4.6 Signature
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| S1 | **Pressure/speed-modulated stroke replay** (less mechanical) | drawingbot, AxiDraw | **M** | **M** |
| S2 | **Batch-sign array** *(= F2)* | cross-cutting | **M** | **L** |

### 4.7 Auto-soldering
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| SO1 | **Dispense dwell + retract/anti-ooze per point** | dispenser practice | **H** | **L** |
| SO2 | **Purge/prime step** before a job | dispensing practice | **M** | **L** |
| SO3 | **Per-point solder profile table** (preheat dwell / touch-down / feed) *(= F5)* | GPD + existing Free-Z/Touch-Z | **M** | **M** |

### 4.8 Glue / fluid dispensing
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| G1 | **Dot / line / area (bead) dispense primitives** | GPD Global | **H** | **M** |
| G2 | **Lead-in/out + on/off delay** (anti-blob/anti-tail) | dispensing/welding sync | **H** | **M** |
| G3 | **Volume model** (vol per dot / mm³ per mm bead → feeder pulses) | GPD auger | **M** | **M** |
| G4 | **Touch-down Z per point** *(reuse soldering Touch-Z)* | dispenser/OpenPnP | **M** | **L** |

### 4.9 Pick & Place (OpenPnP-modeled)
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| PP1 | **Parts → Packages → Footprint library** (the data backbone) | OpenPnP | **H** | **M** |
| PP2 | **Feeder library** (strip/tape w/ pitch+advance, tube, tray; pick loc/Z/rot/count) | OpenPnP | **H** | **H** |
| PP3 | **Top (fiducial) vision** — board alignment affine *(= F3/F4)* | OpenPnP | **H** | **H** |
| PP4 | **Bottom vision** — part centering on nozzle | OpenPnP | **H** | **H** |
| PP5 | **Nozzle-tip library + calibration** | OpenPnP | **M** | **M** |
| PP6 | **Vacuum pick + blow-off + part-present sensing** | OpenPnP | **M** | **M** |
| PP7 | **Panelization** (array of identical boards) *(= F2)* | OpenPnP | **M** | **M** |
| PP8 | **Park + discard locations** | OpenPnP | **L** | **L** |

### 4.10 Welding
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| WE1 | **Weave patterns** (sine/circular/figure-8; amplitude/freq/edge-dwell) | robotic welding | **H** | **M** |
| WE2 | **Multi-pass beads** (root/fill/cap, per-pass offset) | multi-pass/WAAM | **M** | **M** |
| WE3 | **Arc start/stop sync** (pre-flow/crater delays) + **tack welds** | robotic welding | **M** | **M** |
| WE4 | **Per-segment travel speed + WFS/voltage params** *(= F5)* | ArcTool | **M** | **M** |

### 4.11 Screw fitting
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| SC1 | **Torque + insertion-depth targets + abort-on-fault** | auto-screwdrivers | **M** | **M** |
| SC2 | **Screw-feeder pickup + part-present check** *(reuse PnP feeder/vacuum)* | auto screw feeders | **M** | **M** |
| SC3 | **Screw-position array fill** *(= F2)* | cross-cutting | **L** | **L** |

### 4.12 Spring coiling
| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| SP1 | **Type-specific parameter forms** (compression/extension/torsion) | CNC coilers | **M** | **M** |
| SP2 | **Variable pitch / pitch-segment** (closed→active→closed) | CNC coilers | **M** | **M** |
| SP3 | **Extension-spring preload/initial-tension** | coiling guidance | **L** | **L** |

---

## 5. Platform, UX, SEO & performance

| # | Item | Source | Impact | Effort |
|---|---|---|---|---|
| X1 | **Multi-device control** — productize the existing dev "server bridge" so one machine is controllable/monitorable from phone + desktop together | ncSender model | **M** | **M–H** |
| X2 | **Connection setup wizard** on first launch (transport/port/baud; enforce homing before jog) | ncSender | **M** | **M** |
| X3 | **Machine profile library + auto-detect** (bed size/firmware per model; restore-defaults) | gSender | **M** | **M** |
| X4 | **Accent-color / gradient theming** beyond light/dark | ncSender | **L** | **L** |
| X5 | **Portrait/mobile single-pane layout** with reflowed controls + viewport HUD *(= V10)* | ncSender | **M** | **M** |
| X6 | **Lightweight viz + arc-fit + code-split** perf pass for low-end/mobile *(= V6/D5)* | gSender | **M** | **M** |
| X7 | **SEO growth** — per-feature/landing pages ("V-carve online", "PCB autolevel in browser", "image engraving online"), keep hreflang/sitemap/structured-data current as features ship | (our SEO work) | **M** | **L–M** |
| X8 | **i18n discipline** — every new string `t()`-wrapped + tooltip translated across 53 locales each batch (our established pipeline) | — | **H** | ongoing |

---

## 6. Suggested phasing

Each phase is a coherent, shippable batch. Rough order by **impact ÷ effort** and
by foundations-first dependency.

**Phase A — Visualizer wow + cheap credibility wins** *(mostly L/M effort, high visible value)*
V1 spindle/tool mesh · V2 animated tool · V3 progress dimming · V4 per-op color · V5 preset views ·
O8 alarm explanations · O6 run-outline · O11 coolant/park · O12 dead-man/lockout ·
L5 M4 ramping · L3 framing · L7 air-assist · L17 laser safety · L16 S-min/max ·
F6 two-level UI + hover-help scaffolding · X4 accent theming.

**Phase B — Foundations + the must-have engines**
F1 teach-point · F2 array engine · F7 presets · O2 probing wizard · O3 surfacing ·
O1/P1 **auto-leveling/heightmap** (+ V9 surface overlay) · O4 tool-change wizard · O5 start-from-line ·
P2 multi-pass iso · P3 V-bit depth · G1/G2 glue dot-line-area + lead-in/out · W1 pen path optimization.

**Phase C — Depth per workbench**
C1 V-carving · C2 adaptive clearing · C4 stock/origin picker · C5 tabs · C6 multi-op pipeline · C9 tool library ·
L1 **image engraver + dither** · L2 layers · L4 material test grid · L6 interval/overscan · L8 cut-order ·
D1 tree supports · D2 print presets · D3 layer/feature preview ·
P5 drill grouping/peck · P7 cutout tabs · P8 double-sided · P9 layer viewer ·
SO1 solder dwell/retract · F5 per-point/segment table.

**Phase D — Advanced differentiators**
V12 **stock material-removal sim** · F3/F4 two-point alignment + camera overlay · V8 right-click-to-jog · V13 gcode-editor⇄3D ·
L10 power heat-map · L11 offset fill · L12 image trace · L13 camera align/print-and-cut ·
PP1–PP4 PnP parts/feeder/vision · WE1 weld weave · C8 rest machining · D5 arc fitting · D9 PA calibration ·
P4 copper clear · P12 DRC-lite · X1 multi-device · O9 diagnostics/stats.

**Continuous (every batch):** i18n + tooltips across 53 locales (X8), FAANG-sleek/compact review, SEO upkeep (X7), performance/no-freeze checks, closed-loop visual verification.

---

## 7. Highest-leverage bets (if we only do a few)

1. **Visualizer V1+V2+V3+V4** — ncSender/gSender-class realism at mostly low effort; instant credibility & demo value.
2. **O1/P1 Auto-leveling** — makes PCB isolation actually reliable (and helps all uneven-stock jobs). The single biggest correctness unlock.
3. **L1 Image engraving + dither** — the dominant hobby-laser use case we currently lack entirely.
4. **C1 V-carving** — the killer carving feature for signs/text; pairs with our Writing mode.
5. **F1 teach-point + F2 array engine** — tiny/medium effort, unlock usability across 5+ actuation workbenches.
6. **V12 stock material-removal sim** — the moonshot no browser GRBL sender does; defines karmyogi as a true CAD/CAM workbench.

---

*Sources are cited inline per research stream (gSender/ncSender/CNCjs/UGS/bCNC/OpenBuilds/Candle, LightBurn/LaserGRBL/EZCAD, FlatCAM/pcb2gcode/bCNC, Kiri:Moto/Carbide/Estlcam/VCarve/Fusion + PrusaSlicer/OrcaSlicer/Cura/Bambu, vpype/saxi/AxiDraw/OpenPnP/dispensing/welding/coiling). Pick items by their IDs (e.g. "do V1–V4 + O8") and we implement that batch next.*
