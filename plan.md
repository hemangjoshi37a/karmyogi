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
