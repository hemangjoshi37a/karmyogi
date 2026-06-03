# plan.md — karmyogi build plan

Phased, **parallel-agent-friendly** implementation plan. Read `CLAUDE.md` first.

The guiding principle: **agents run in parallel only on disjoint file sets.**
Every workstream below lists exactly what it `Owns:` and what it `Depends on:`.
The orchestrator (main session) owns the *shared wiring* (app shell, the dockview
panel registry, the zustand store index) and integrates between batches. Each
workstream is verified in the **closed loop** (vitest for core, Playwright for UI).

---

## 1. Target architecture (directory = ownership boundary)

```
karmyogi/
  index.html
  vite.config.ts  tsconfig.json  package.json
  src/
    main.tsx                # entry
    app/                    # SHELL: dockview layout, top bar, theme provider, panel registry  [orchestrator-owned]
      App.tsx  shell.tsx  panelRegistry.ts  theme.ts
    store/                  # zustand stores (one file per slice)
      machine.ts  program.ts  settings.ts  layout.ts  index.ts
    serial/                 # Web Serial GRBL transport (no UI)
      grblConnection.ts  streamer.ts  status.ts  realtime.ts  settings.ts  mockPort.ts
    core/                   # PURE TS CAD/CAM core (port of Qt src/cadcam) — no DOM/React
      geometry.ts  entity.ts  toolpath.ts  gcodeEmitter.ts
      dxf.ts  offset.ts  cam.ts  soldering.ts  strokeFont.ts  hersheyData.ts
      gerber.ts  excellon.ts  pcbCam.ts
      __tests__/*.test.ts   # vitest, mirroring the Qt 32-case suite
    viewer/                 # three.js / r3f scene (no business logic)
      Viewer.tsx  Bed.tsx  Toolpath.tsx  ToolMarker.tsx  gcodeToPolylines.ts  viewControls.ts
    panels/                 # one dockview panel per file (UI only; calls core + store + serial)
      ControllerPanel.tsx  ConsolePanel.tsx  ProgramPanel.tsx  VisualizerPanel.tsx
      CadCamPanel.tsx  WritingPanel.tsx  SolderingPanel.tsx  PcbPanel.tsx
      MotionPanel.tsx  CoordSystemPanel.tsx
    components/             # shared dumb UI (Button, NumberField, Table, Toolbar, ...)
    styles/                 # theme.css (light/dark vars), globals.css
  reference/                # copied Qt C++ files for offline lookup
  docs/
```

Key boundaries that make parallelism safe:
- `core/` modules are independent of `viewer/`, `serial/`, `panels/`.
- each `panels/*.tsx` is its own file → different agents can build different panels at once.
- `serial/`, `viewer/`, `core/` are three independent pillars.
- the only *shared* files are `app/*` and `store/index.ts` + `app/panelRegistry.ts`
  → the orchestrator edits these to wire new panels in between batches.

---

## 2. Phases & parallel batches

Legend — each task: **[Wn]** workstream id · `Owns:` files · `Depends on:`.
Tasks within the same **Batch** have disjoint `Owns:` and run **in parallel**.

### Phase 0 — Scaffold + prove the pain points are solved  (orchestrator, mostly serial)
- Scaffold Vite+TS+React; add three.js/@react-three/fiber/drei, dockview, zustand, vitest, Playwright.
- App shell with dockview hosting 4–5 **dummy** dockable panels; dark/light theme toggle.
- A three.js viewport panel showing a **bed grid + origin gizmo**.
- Cloudflare Pages config + `npm run build` produces a deployable `dist/`.
- **Closed-loop gate:** Playwright opens the dev server, **drags a panel, resizes a
  splitter, floats a panel, switches theme**, screenshots each — confirm the
  docking/resizing that failed in Qt now works. Do not proceed until this passes.

### Phase 1 — Two independent pillars (CAN RUN IN PARALLEL)  → **Batch A**
- **[W1] GRBL serial transport.** `Owns: src/serial/*`, `src/store/machine.ts`.
  `Depends on:` Phase 0 store index. Connect/disconnect (`navigator.serial`),
  read loop, line streamer with character-counting flow control, realtime bytes
  (`? ! ~ 0x18`), `<...>` status parsing (state, MPos/WPos, overrides), `$$`
  settings read/write. Ships a **mockPort** so everything works without hardware.
  Tests: vitest against canned GRBL output; Playwright with the mock.
- **[W2] CAD/CAM core — geometry + emitter + toolpath.** `Owns: src/core/geometry.ts,
  entity.ts, toolpath.ts, gcodeEmitter.ts, cam.ts, offset.ts` + their tests.
  `Depends on:` nothing (pure). Port from Qt `geometry/entity/toolpath/gcodeemitter/
  camoperations/offset`. Mirror the Qt unit tests (rect area/orientation, circle
  area, offset square in/out, inset rings, depth levels, engrave/profile/pocket,
  emitter safe-Z/pen-mode/no-`-0`/feed-survives-skip). For robust offsetting use a
  JS clipping lib (`polygon-clipping` or `js-angusj-clipper`/WASM) instead of the
  Qt v1 miter offset.
- **[W3] 3D viewer.** `Owns: src/viewer/*`. `Depends on:` Phase 0. Bed/grid, G-code →
  polylines (`gcodeToPolylines.ts`), toolpath mesh/lines (rapids vs cuts colored),
  tool marker, fit/iso/top/front view controls, theme-aware background.

> Orchestrator after Batch A: wire W1/W3 into the Controller + Visualizer panels and the store.

### Phase 2 — Controller UX + program  → **Batch B** (parallel)
- **[W4] Controller + Console + Coordinate panels.** `Owns: panels/ControllerPanel.tsx,
  ConsolePanel.tsx, CoordSystemPanel.tsx`. `Depends on:` W1. Jog (buttons +
  keyboard), status display, overrides, home/unlock/reset, console send/recv,
  G54–57 + zeroing.
- **[W5] Program panel + streaming.** `Owns: panels/ProgramPanel.tsx, store/program.ts`.
  `Depends on:` W1, W3. Load `.nc`/text, list view, send/stream with progress,
  feed-from-line, pause/abort; pushes parsed toolpath to the viewer.
- **[W6] Visualizer panel.** `Owns: panels/VisualizerPanel.tsx`. `Depends on:` W3.

### Phase 3 — CAM modes (each panel is independent → all parallel)  → **Batch C**
Shared dependency: W2 (core). Each panel emits G-code → program/viewer via the store.
- **[W7] Wood CAD/CAM panel.** `Owns: panels/CadCamPanel.tsx`. DXF import (uses
  `core/dxf.ts`), op select (engrave/profile/pocket), tool params, Pen/Spindle Z,
  **live preview**. *(core/dxf.ts can be a sub-task of W2 or its own [W2b].)*
- **[W8] Writing/Pen panel + stroke font.** `Owns: panels/WritingPanel.tsx,
  core/strokeFont.ts, core/hersheyData.ts` + tests. Text → single-stroke font →
  pen G-code (Pen Z mode); load custom-font JSON (format from Qt `strokefont.cpp`).
- **[W9] Auto-soldering panel + core.** `Owns: panels/SolderingPanel.tsx,
  core/soldering.ts` + tests. Editable table (X/Y/Free-Z/Touch-Z/feed-type/feed-time),
  Record-current-position (reads machine store), pre-solder vs touch-down ordering,
  feeder = spindle M3/G4/M5. Port `soldering.cpp` (it already has Free-Z/Touch-Z).
- **[W10] PCB panel + core.** `Owns: panels/PcbPanel.tsx, core/gerber.ts,
  core/excellon.ts, core/pcbCam.ts` + tests. Gerber + Excellon import → isolation /
  drill / cutout, staged programs. Port the three Qt PCB files.
- **[W11] Motion/Limits + GRBL-Settings panel.** `Owns: panels/MotionPanel.tsx,
  panels/grblSettingsMeta.ts`. `Depends on:` W1. A first-class `$`-settings editor:
  read `$$`, render EVERY setting **grouped** (steppers/ports, limits & homing,
  spindle/laser, steps-per-mm, max-rate, acceleration, max-travel) with **descriptions**
  + units, **edit/write** (`$N=val`), **range/corruption validation** (flag int32
  sentinels ±2147483.648, zero/negative steps·rate·accel·travel — the real EEPROM-
  corruption failure mode that throws `error:15` on every jog), and **factory reset**
  (`$RST=$` / `$RST=#` / `$RST=*`) with confirms. Note: GRBL = linear accel only
  (no S-curves); say so in the UI. Glue already built: `store/grblSettings.ts` +
  `grbl.readSettings()/writeSetting()/resetSettings()`.

### Phase 4 — Polish & host  → **Batch D** (parallel where disjoint)
- Theme refinement (light/dark) + per-panel & global zoom (CSS, trivial on web).
- Layout persistence (save/restore dockview layout to localStorage).
- PWA/offline; file pickers / File System Access API for DXF/Gerber.
- Cloudflare Pages/R2 deploy; optional account/SaaS hooks.
- Handwriting-font helper: reuse the Qt `tools/handwriting/` python pipeline; add an
  in-app "load font.json" already covered by W8.

---

## 3. Orchestration recipe (how the main session drives the agents)

1. Do Phase 0 solo (scaffold + dockview gate). Commit.
2. Launch **Batch A = W1 + W2 + W3** as parallel agents (disjoint dirs: `serial/`,
   `core/*`, `viewer/`). Each builds + vitest-tests its own modules; agents do **not**
   touch `app/*` or `panels/*`.
3. Orchestrator wires Batch A into the shell + store (shared files). Verify with Playwright.
4. Launch **Batch B = W4 + W5 + W6** (disjoint panel files). Integrate, verify.
5. Launch **Batch C = W7…W11** (disjoint panel + core files) — up to 5 in parallel.
   Integrate each into `panelRegistry.ts`, verify each panel with Playwright.
6. **Batch D** polish.

Rules for every agent prompt: state `Owns:` exactly, forbid edits outside it,
forbid touching `app/panelRegistry.ts` / `store/index.ts` (orchestrator-only),
require vitest/Playwright self-verification, and require a closed-loop screenshot
assessment in the final report. Use separate build dirs if an agent must build.

---

## 4. Web Serial / GRBL notes (for W1)

- `navigator.serial.requestPort()` on a user click; `port.open({ baudRate: 115200 })`.
- Read: `port.readable.getReader()` loop, decode lines on `\n`.
- Write: `port.writable.getWriter()`; stream lines. Flow control: track bytes in
  GRBL's 127-byte serial RX buffer (character-counting) for max throughput; simpler
  fallback = send line, wait for `ok`/`error`.
- Realtime (bypass buffer): `?` status, `!` hold, `~` resume, `0x18` reset, `0x84` etc.
- Status report `<Idle|Run|Hold|Jog|Alarm|...|MPos:x,y,z|WPos:...|Ov:...|FS:...>` — poll `?` ~5–10 Hz.
- `$$` → `$<n>=<val>` lines (settings). `$X` unlock, `$H` home, `$G` parser state.
- Mock device: replay canned status/`ok` so the UI + tests run with no hardware.

## 5. Open decisions (resolve in Phase 0)

- Styling: Tailwind vs CSS variables + modules. (Lean: CSS variables for theming +
  small utilities; Tailwind optional.)
- Offset/clipping lib: `polygon-clipping` (pure JS) vs `js-angusj-clipper` (WASM, robust).
- Whether to run the G-code parser / heavy CAM in a Web Worker (keep UI smooth).
- Layout persistence format (dockview serialized layout in localStorage).

## 6. Definition of done (per feature) = parity with the Qt reference

Controller (connect/jog/status/stream/overrides/home), 3D viewer with bed,
Wood CAD/CAM (DXF + engrave/profile/pocket + live preview), Writing (text +
custom font), Soldering (Free-Z/Touch-Z table + record + feeder), PCB (Gerber +
Excellon → isolation/drill/cutout), Motion ($-settings) — all as dockable,
resizable, light/dark panels, verified in the browser via Playwright.

---

## 7. FUTURE — Camera vision auto-calibration & "place-and-carve" (W-Vision)

> **Status: design / parked until a USB camera is connected.** This section is the
> full spec so it can be built later. It needs real hardware (a USB webcam) to
> verify in the closed loop, so it is intentionally not implemented yet. The
> existing **Camera** panel (`src/panels/CameraPanel.tsx`, `getUserMedia` feed +
> snapshot/record) is the UI host this builds on.

### 7.1 The vision (what the user asked for)

Make the machine usable by a **non-technical operator** with near-zero setup. The
operator simply **places the workpiece (with printed marker stickers) on the bed
and presses one button**; the machine then *sees* everything with a USB camera and
configures itself:

- **Auto-measure the bed** — size + origin of the machine work area.
- **Auto-measure the job stock** — width / depth (and thickness) of the raw
  material block, plus where it sits on the bed.
- **Auto-set coordinates / work zero** — derive the XY work origin (and ideally Z
  top) for the job from what the camera sees, instead of manual jogging + zeroing.
- **Auto-zero pre-run** — zero the job stock, the bed reference, and the spindle/Z
  before the program runs.
- **(Stretch) Visual closed-loop zeroing** — the machine *watches the tool with the
  camera and nudges it into position*, the way a human operator eyeballs and dials
  in zero.
- **Auto-detect the material type** from the camera image → automatically pick the
  **carving speed / feeds / RPM / depth-per-pass** (no human knowledge needed).
- **End state:** operator places stickered stock → presses **Auto-setup & carve** →
  the machine carves the loaded drawing / part file by itself.

### 7.2 Printed fiducial markers ("stickers")

Use a **known, pre-defined printed marker** (QR-code-style) of **known physical
size**, placed on objects. Recommended marker tech (robust, public-domain, fast to
detect, gives full 6-DoF pose, far better than a raw QR for metrology):

- **ArUco / AprilTag fiducials** (square markers with an ID encoded in the bits).
  A QR code *can* carry data (e.g. material name, stock thickness) but ArUco/April
  give much better sub-pixel corner pose for measurement — so use **both**: an
  ArUco board for geometry + an optional QR for metadata.
- **Different sticker "roles" via distinct marker dictionaries / ID ranges:**
  - **Bed markers** — e.g. 4 ArUco tags at known bed corners, or one large tag at a
    fixed, known machine coordinate → establishes the bed plane + machine origin.
  - **Stock markers** — a different ID range; one or more tags stuck on the
    workpiece → the tag's known printed size gives the pixel→mm scale, and the
    tag rectangle + stock outline give the stock footprint and placement.
  - **Material/metadata sticker** — optional QR encoding `{material, thickness}` for
    when auto-classification is uncertain (operator can use a labelled sticker).
- Each sticker has a **known real-world edge length (mm)** baked into the app, so a
  single detected marker yields an absolute scale (mm-per-pixel) on its plane.
- Ship a **printable PDF sheet** of the markers (bed set + stock set + material
  tags) from the app so anyone can print stickers on a normal printer.

> **SHIPPED (v1, QR-based):** `tools/calibration/gen-calibration-sheet.cjs`
> generates `public/calibration/karmyogi-calibration-sheet.pdf` (A4) + a
> machine-readable `public/calibration/markers.json` registry. The Camera panel
> exposes a **Download / Print calibration sheet** card. v1 uses **QR codes**
> (OpenCV's `QRCodeDetector` returns the 4 corners *and* decodes the payload in
> one shot, verified to decode 12/12), with each code carrying a compact,
> SELF-DESCRIBING payload so a single detection fixes the scale:
> - `KMYG1|TARGET|<TL|TR|BL|BR>|X=<mm>|Y=<mm>|S=<mm>|W=<mm>|H=<mm>` — 4 bed-plane
>   corner codes at a known 150×229 mm (centre-to-centre) rectangle; `X,Y` =
>   centre in the target frame (origin = BL, +X right, +Y up); `W,H` = target
>   spacing. Solve the homography from ≥3 corners → mm-per-pixel + perspective.
> - `KMYG1|STOCK|N=<i>|S=<mm>` — cut-out stock-corner stickers (each 18 mm).
> - `KMYG1|MAT|name=<material>|t=<thickness_mm>|S=<mm>` — labelled material tags.
> The sheet also prints a 40 mm scale-check square + 100 mm ruler (so the
> operator can confirm a true-100% print) and an X→/Y↑ machine-origin arrow.
> **Future refinement:** add an ArUco/AprilTag board on the same sheet for
> sub-pixel 6-DoF pose (better metrology than QR finder patterns), keeping the
> QR for metadata — exactly the "use both" recommendation above.

### 7.3 Calibration pipeline (camera → machine coordinates)

1. **Camera intrinsics** — one-time calibration (checkerboard or a known ArUco
   board) → focal length + lens distortion. Store per-camera in a `vision` store.
2. **Detect markers** in the live frame (IDs + sub-pixel corners).
3. **Solve the homography / PnP** from marker corners (known mm) → image, giving the
   mapping **image pixel ⇄ bed-plane mm**.
4. **Tie image-mm to machine-mm**: the bed markers sit at known machine coordinates
   (or are taught once by jogging the tool to a marker), so the camera frame becomes
   a calibrated map of the GRBL work area.
5. **Bed extents** → write to the existing **bed store** (`src/store/bed.ts`).
6. **Stock footprint + placement** → write to the **stock store**
   (`src/store/stock.ts`): width/depth from the stock outline measured in mm, plus
   the offset of the stock on the bed (so the drawing can be auto-positioned onto
   the stock). Stock **thickness (Z)** from either a side-view marker, a second
   camera, the known sticker + a touch-probe, or operator entry.
7. **Work zero (XY)** → from a designated stock marker / a chosen stock corner;
   push to the coordinate system (G54 offset) via the controller, mirroring what
   **CoordSystemPanel** does manually.
8. **Z zero** → integrate with the **Probe & Limits** panel: auto-run a touch probe
   on the detected stock top, or use a known marker height. Never assume Z from
   vision alone for cutting depth.

### 7.4 Visual closed-loop zeroing (stretch goal)

Treat it as **visual servoing**: detect the tool tip (or a marker on the spindle) in
the frame, compute the pixel error to the target (e.g. a stock corner), convert to
mm via the calibrated homography, and issue incremental `$J=` jog moves until the
error is within tolerance — exactly how a human nudges the tool while watching. Must
be **slow, bounded, and confirm-gated**; abort on lost tracking.

### 7.5 Automatic material classification → auto feeds/speeds

- Snapshot the stock surface → classify the **material category** (wood / ply / MDF /
  acrylic / PVC / PCB / aluminium / foam / wax …). Start with simple **color +
  texture heuristics**; upgrade to a small **TensorFlow.js** image classifier.
- Map the predicted material → the existing **materials library**
  (`src/core/materials.ts`) and **`recommend(material, bit)`**
  (`src/core/toolLibrary.ts`) to auto-fill feed XY / plunge Z / RPM / stepdown /
  stepover — the same "safe passes" engine the 3D Carving panel already uses.
- Always show the prediction + confidence and let the operator override (or read a
  metadata QR sticker when confidence is low).

### 7.6 One-button "Auto-setup & carve" flow (the payoff)

1. Operator loads a drawing/part (DXF/STL/…) and places stickered stock on the bed.
2. Press **Auto-setup**: detect bed + stock markers → set bed size, stock size +
   placement, classify material, auto-fill feeds/speeds, auto-position the drawing
   onto the stock, set work zero (XY) + probe Z.
3. App shows a **3D preview + the playback simulation** (already built — stock block,
   animated tool, scrub timeline) for a final visual sanity check.
4. Operator confirms → stream G-code. (Never auto-run without an explicit confirm and
   a passing bed-fit / dry-run check.)

### 7.7 Tech + integration (when built)

- **Capture:** reuse `getUserMedia` from CameraPanel; allow choosing the USB camera.
- **Detection:** `js-aruco2` / `apriltag` WASM, or **OpenCV.js** (aruco + calib3d +
  solvePnP + findHomography). Run in a Web Worker to keep the UI smooth.
- **Material ML:** TensorFlow.js (MobileNet transfer-learn) — optional, lazy-loaded.
- **New owned files (disjoint, parallel-agent-friendly):**
  `src/core/vision/` (pure: marker geometry, homography/PnP math, pixel↔mm,
  material heuristics), `src/store/vision.ts` (camera intrinsics + calibration +
  detected results), a `VisionCalibratePanel` (or extend CameraPanel), and a
  printable-markers asset/generator. Consumers **write** the existing bed/stock
  stores and the coordinate/probe flow; they don't fork them.
- **Safety:** vision only *proposes* numbers; cutting still goes through the safe
  G-code emitter + bed-fit check + the simulation preview; Z depth never trusts the
  camera alone (probe-backed). Bounded, confirm-gated jog for any auto-move.

### 7.8 Why it's parked

It is impossible to verify in the required **closed loop** without a real USB camera
on the machine (marker detection, lens distortion, lighting, tool tracking are all
empirical). Implement when the camera is available; until then this spec is the
contract. Note: the format work it complements — robust DXF (incl. **SPLINE/NURBS +
ELLIPSE**) import — is already done, so a vision-placed drawing will carve.

---

## 8. FUTURE — Machine abstraction layer (controllers + machine types + axes)

> **Status: design / parked.** Today everything assumes a **3-axis GRBL** machine.
> This section specs a pluggable abstraction so karmyogi can drive other
> controllers and machine kinds, with **GRBL remaining the default**.

### 8.1 Goal

One workbench, many machines. The user picks (or auto-detects) their controller and
machine type; every panel + CAM op adapts to that machine's capabilities and axes.

### 8.2 Controller adapters (firmware backends)

Introduce a **`ControllerAdapter` interface** that the rest of the app talks to,
instead of hard-coding GRBL strings. The current GRBL code becomes the reference
adapter; new adapters implement the same contract.

- **GRBL** (default) — `$`-settings, `?`/`!`/`~`/`0x18` realtime, `<...>` status,
  `$J=` jog, `$H` home. (What `src/serial/*` already does.)
- **FluidNC** — GRBL-compatible streaming over USB/Wi-Fi (ESP32); mostly the GRBL
  adapter plus its YAML config + extra axes + WebSocket transport.
- **Ruida** (RDC644xx etc., CO2 laser controllers) — very different binary protocol
  (UDP/USB, scrambled packets); a heavier adapter, laser-oriented.
- Room for **Marlin / Smoothieware / grblHAL** later.

Adapter contract (sketch): `connect()/disconnect()`, `sendLine()/sendRealtime()`,
`parseStatus()→{state,mpos,wpos,feed,spindle,pins,...}`, `jog()`, `home()`,
`readSettings()/writeSetting()` (+ a settings **schema** for the Motion panel), and a
**capabilities** object: `{ axes: Axis[], hasSpindle, hasLaser, hasHoming,
hasProbe, realtimeBytes, settingsModel }`. Panels read capabilities and hide/adapt
controls (e.g. no Z-probe UI on a laser).

### 8.3 Machine types

A **machine type** selection (stored in a `machine profile`) drives the UI + CAM:

- **2D** — e.g. **CO2 laser cutter/engraver**: XY motion + laser **power/PWM** and
  passes; "Z" is focus, not cut depth. CAM emits power/speed/pass programs (raster +
  vector), not depth passes. The 3D view flattens to the bed plane.
- **3D** (current) — 3-axis router/mill/plotter/solder/PCB: the existing depth-pass
  CAM, spindle/pen/feeder Z modes.
- **Future 4–6 axis** — rotary (A/B) and full 5/6-axis for advanced CAM
  (indexed + simultaneous); orientation-aware toolpaths.

### 8.4 User-definable axis layout

Let the user **declare which physical axis is which** (and where it is / its travel /
direction / home corner): map logical CAM axes → controller axis letters, set per-axis
limits, invert, and (for rotary) define the rotation centre. CAM + the 3D viewer +
jog pad all read this axis map so a non-standard machine "just works" without code
changes. Persist per machine profile.

### 8.5 Integration & ownership (when built)

- New **`src/machine/`**: `types.ts` (Axis, Capabilities, MachineProfile,
  MachineType), `ControllerAdapter.ts` (interface), `adapters/grbl.ts` (refactor of
  today's `serial/*` behind the interface), `adapters/fluidnc.ts`,
  `adapters/ruida.ts`. A **`src/store/machineProfile.ts`** holds the active
  controller + type + axis map (persisted).
- `serial/controller.ts` becomes a thin shell that delegates to the active adapter.
- Panels (Controller, Motion, CAM, Visualizer, Probe) switch on **capabilities**, not
  on a hard-coded GRBL assumption. CAM ops branch on machine **type** (laser power vs
  depth passes vs multi-axis).
- Keep GRBL as the default profile so nothing regresses; ship adapters incrementally.
