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

### 7.8 Why the FULL auto-setup is parked

The full one-button auto-setup-and-carve loop is impossible to verify without a real
USB camera on the machine (lens distortion, lighting, tool tracking, material ML are
all empirical). It stays parked. **But one slice does NOT need the machine and is
being built now → 7.9.**

### 7.9 ACTIVE — Live camera → calibrated 3D bed/job in the viewport ("does it fit?")

> **Status: building now (user request).** A self-contained, backend-free slice of
> W-Vision: point **ordinary webcams** at the bed and render the **real bed plane (and
> the job sitting on it) in the 3D viewport**, correctly placed in machine-mm — so the
> operator can drop the design onto the job and *see whether it fits* before cutting.
> Verifiable in the closed loop with a laptop webcam (or a synthetic/mock frame), so it
> ships independently of the CNC hardware.
>
> **Locked build scope (decided 2026-06):**
> - **Calibration:** machine-motion (recommended) · QR-auto · manual-corner — all feed
>   ONE image⇄bed-mm homography (see the ordered list below).
> - **ONE camera is sufficient for the core goal** — live bed + job **footprint** + the
>   **fit check** all come from the single bed-plane homography. (A homography only
>   relates the Z=0 plane, so one view can't recover stock *height* — that's the only
>   thing a single camera lacks.)
> - **Height (Z):** default to the **Z-probe** (already built; most accurate, and cutting
>   depth must be probe-backed anyway — vision is never trusted for cutting Z). Optional
>   alternatives, all giving a *preview* only: **controlled-motion stereo with the same
>   one camera** (gantry-mounted or bed-moving → known baselines → triangulate the top),
>   a top-face marker, or operator entry. A **second static camera + visual hull** is
>   just ONE optional way to get a live height preview — NOT required.
> - **Live webcam video projected onto the bed plane** (rectified through the camera's
>   homography) with an **opacity slider** — the photographic "live 3D from camera"
>   look, orbitable, with the design/toolpath overlaid on top + green/red fit check.
> - Build treats **camera 1 as primary** (footprint + fit) and **camera 2 as optional**
>   (visual-hull height preview); the probe path is the recommended height source.

**Metric scale needs a known-size reference → QR is the recommended calibration; pure
markerless is non-metric.** (Decided with the user 2026-06.) You cannot recover true
real-world millimetres from video alone — a fully reference-free reconstruction is only
known up to an unknown scale, which is useless for CNC. So *some* known real dimension
must anchor the scale. The QR is the best anchor (exact printed size, auto-detected
sub-pixel corners, carries its own ID + bed position, doesn't need the whole bed in
frame, zero manual clicking). The bed rectangle can substitute **only if its true size
is known and its corners are visible/clickable**. Pure markerless (no known dimension)
is still useful for a *non-metric* flat-plane video view, just not for 1:1 fit checks.

**Why it works with no backend (just Vite + the browser):**
- **Geometry = a planar homography.** The bed is a plane (Z=0). A camera viewing a
  plane maps image⇄bed-mm by one **3×3 homography H** (8 DOF), solved from **≥4 points
  whose bed-mm position is known** via the normalized **DLT** (pure-TS, no SVD lib /
  OpenCV). Where the ≥4 known points come from, in **recommended order**:
  1. **Machine-motion self-calibration (BEST — recommended; user idea, no print needed).**
     The machine's own GRBL motion IS a precise ruler. The tool's pixel at ≥4 known
     machine-XY positions gives image↔**machine-mm** correspondences → `solveHomography`.
     Because the reference points are machine coordinates by construction, H is **natively
     1:1 in the machine frame** — this also eliminates the "tie the calibration frame to
     machine zero" step the QR/manual methods need. Two sub-modes:
     - **AUTO (the DEFAULT — one button, fully hands-off).** Press *Auto-calibrate*: the
       app jogs the tool (`$J=G90` absolute, cancellable) to a small bounded grid around
       the current position (e.g. 3×3 = 9 points within ±20 mm), waits for each move to
       settle, and snaps a frame at each. The tool sits at a different pixel in every
       frame while the bed is static, so the **per-pixel median of the frames = the
       background**; each frame minus background isolates the **tool blob → its centroid =
       the tool pixel** for that frame's known machine XY. Solve from the auto-found pairs.
       No clicking, no markers. Safety: XY-only (never Z), strictly bounded to ±spread,
       confirm-gated, abortable (→ `jogCancel`), per-move timeout; needs the machine
       connected + not in Alarm.
     - **MANUAL (fallback).** Jog to ≥4 spots yourself and click the tool tip in the frame
       at each. For when auto-detection struggles (poor contrast/lighting).
     Caveat (both): keep the tool at a consistent Z near the bed surface (tool-tip height
     adds parallax otherwise).
  2. **QR auto (metric, offline):** the shipped `KMYG1|TARGET|…|X=|Y=|S=` codes (§7.2)
     have an **exact known printed size + position**. The native `BarcodeDetector` API
     (Chromium — already required for Web Serial) returns each code's payload **and** 4
     `cornerPoints` in one call → H, zero clicks. Frame = the sheet's; tie to machine
     zero by placing the sheet's BL corner at the origin (its arrow shows X→/Y↑).
  3. **Markerless bed-corner (offline, metric only if bed size known):** operator clicks
     the 4 bed corners once (or auto-detect the largest quadrilateral); uses the known
     `bed` store size as the scale anchor → H.
  4. **Pure markerless (non-metric):** flat-plane video view with no scale anchor —
     visual only; fit checks disabled until (1)–(3) supply a real dimension.
- **Two QR roles — bed + stock (recommended minimal setup, user request):**
  1. **Bed QR** (`KMYG1|TARGET`, known size + known bed position) → solves each camera's
     image⇄bed-mm homography H = the world frame.
  2. **Stock QR** (`KMYG1|STOCK`, known size, stuck on the workpiece, e.g. a corner at a
     known offset) → its detected corners mapped through H give the stock's **origin,
     orientation and footprint in bed-mm directly** (its known printed size is an
     independent scale check too). This is the easy, robust way to "know things" about
     the job — no background-subtraction guesswork for the footprint.
  With both QRs, one frame per camera fixes the whole scene: bed plane + where the job
  sits on it, in real millimetres.
- **Job footprint (where the stock sits):** from the **stock QR** (recommended) — its
  corners through H give the footprint + pose in bed-mm directly. Markerless fallback:
  capture an **empty-bed reference frame**, then **background-subtract** the live frame
  (per-pixel diff + threshold + largest contour) → silhouette → outline mapped to mm
  through H. Either way the footprint is in real bed-mm.
- **Markerless job height / coarse 3D (the multi-camera part):** with **two** cameras
  each calibrated to the same bed plane, intersect the two job silhouettes in 3D —
  classic **shape-from-silhouette / visual hull** (carve a coarse voxel/height field
  that projects inside both silhouettes) → a job **box with real height**, or just the
  top-surface height. MVP can also accept a typed thickness; the visual hull is the
  markerless upgrade. (Optional later: decompose H + assumed intrinsics → 6-DoF camera
  pose to draw each camera's frustum in the scene.)
- **The one honest constraint — absolute scale.** Metric (mm) 3D needs *some* known
  real dimension. We get it for free from the **known bed size**, so no QR is needed —
  but a fully reference-free reconstruction can only be recovered up to an unknown
  scale, which is useless for CNC. So: markerless ✅, but *dimension-less* ✗ — the bed
  (or any one known length) is the reference, and QR is just an automated way to supply
  it. Full SfM/MVS of arbitrary geometry is deliberately out of scope (heavy, fiddly,
  not real-time in-browser) — the bed-plane homography + silhouette/visual-hull gives
  ~90% of the value simply and verifiably.

**What renders in the 3D viewport:**
- **Bed plane** at Z=0 covering the machine work area, **textured with the live camera
  frame rectified through H** (a small fragment shader samples the `<video>` texture by
  H so the real bed appears undistorted and aligned to mm) — with an opacity slider.
- **Job plane / box**: the stock footprint as a rectangle on the bed (from detected
  `KMYG1|STOCK` corner stickers, OR a rectangle the user drags over the job in the
  camera image → mapped to mm via H, OR typed W×D×thickness). Rendered as a plane (or a
  box if a thickness is given).
- **Fit check**: the loaded program/design is already in bed-mm, so compare its XY
  bounding box (and the placement gizmo) against the job rectangle → **green = fits,
  red = overhangs**, with the overhang amount. Reuses the existing `PlacementGizmo` +
  `programXYBounds()`.
- Two cameras: each is independently calibrated to the **same** bed plane (own H); the
  viewport can blend/choose feeds and cross-check agreement. Data model is `cameras[]`.

**Entry points (both, per the request):**
- **Camera panel** — a new **"Bed tracking / calibration"** card: pick camera(s), live
  detection status + quality (markers seen, reprojection error), "Calibrate" (lock H),
  set/auto-detect the job rectangle, manual-corner fallback. Builds on the existing
  `getUserMedia` feed already in `CameraPanel.tsx`.
- **3D viewport** — a toolbar **toggle "Show live camera 3D"** (📷) next to the existing
  Show-stock / sim toggles, **persisted across page refresh** (localStorage via the
  app's `usePersistentState` / zustand-`persist` pattern, key `karmyogi.viewer.cameraOverlay`;
  full calibration under `karmyogi.camera`). Choice + calibration survive reload.

**Owned files (disjoint, mostly NEW — parallel-safe):**
- `src/core/cameraCalib.ts` — **pure math, no React/three**: `solveHomography4` (DLT),
  `applyH` / `invertH`, multi-point least-squares + reprojection error,
  `fitCheck(bbox, jobRect)`, background-subtraction silhouette → contour → bed-mm
  outline, two-view **visual-hull** height estimate, and optional marker-payload parsing
  (`KMYG1|…`). Takes raw `ImageData`/point arrays in, returns geometry out (no DOM).
  Mirrors the Qt-core "pure module" rule.
- `src/store/cameraCalib.ts` — zustand **`persist`** store: `cameras[]` (deviceId, H,
  quality), `jobRect`, `overlayOpacity`, `enabled`; exported from `src/store/index.ts`.
- `src/viewer/CameraBedPlane.tsx` (+ optional `JobPlane.tsx`) — three.js plane(s) reading
  the store; H-sampling shader for the live texture.
- `src/panels/CameraPanel.tsx` + `src/styles/camera.css` — the calibration/tracking UI
  (this panel is ALSO where the §-wide UI-polish pass for Camera lands, to avoid two
  agents touching one file).
- **Orchestrator-integrated shared wiring** (not parallel): `src/viewer/Viewer.tsx`
  (mount the overlay), `src/panels/VisualizerPanel.tsx` (the persisted toggle button),
  `src/store/index.ts` (export), i18n keys.

**Honest accuracy caveats:** a single planar homography is exact for the bed *plane* and
nails XY-footprint fit. True job **height/3D solid** needs user-entered thickness, a
top-of-stock marker, or two-camera stereo (enhancement). Wide-angle webcam **lens
distortion** adds error; a one-time intrinsics calibration (§7.3.1) can be added later.
Cutting still never trusts vision for Z — depth stays probe-backed (§7.3 step 8).

---

### 7.10 ACTIVE — Digital twin of the machine in the 3D viewport (user request)

> Goal: show the operator's ACTUAL machine (frame + moving bed + moving head) in
> the 3D viewport, animated live by the GRBL position — a true digital twin the
> design/toolpath sits inside. Built on the camera feed + the kinematics calib.

**Honest approach (realistic in-browser, no backend):**
- **NOT** automatic photogrammetry (photos → dense mesh). Full SfM/MVS is heavy,
  needs many well-distributed photos, and won't run client-side. Don't promise it.
- **YES — a parametric BOX-KINEMATIC twin.** The machine is mostly rectangular, so
  model it as a small rig of boxes (base frame, bed/table, Y carriage, X gantry, Z
  head, spindle) and **animate it from the live `wpos` + the kinematics map**: on
  this user's machine the **bed box translates in Y**, the **head box in X/Z** (per
  §7.9 auto-detect). It moves in real time with the real machine. This IS the twin;
  no photogrammetry needed.
- **Photos set proportions + skin.** The user streams **all-around photos** via the
  camera→server bridge; the dev/agent reads them to set each box's real dimensions
  and optionally project them as textures so the twin looks like the actual machine.

**Three inputs:** (1) all-around photos (bridge) → proportions + skin; (2) bed
movement (§7.9 auto-cal, Y→bed); (3) head movement (§7.9 auto-cal, X/Z→head).

**Owned files (when built):** `src/viewer/MachineModel.tsx` (parametric box rig,
reads live `useMachine.wpos` + an axis-map store) + `src/store/machineModel.ts`
(box dimensions + axis→part mapping, persisted). No new heavy deps.

**Sequencing:** camera feed → kinematics auto-cal (bed vs head) → box-kinematic
twin animated by live position, proportions/skin from the photos.

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
