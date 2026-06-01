# CLAUDE.md — karmyogi

> Guidance for Claude Code (and humans) working in this repository.
> Read this first, then `plan.md` for the phased, parallel-agent build plan.

## What this is

**karmyogi** is a browser-based, multipurpose control + CAD/CAM workbench for a
hobby/desktop **3-axis GRBL machine** (CNC carving, engraving, pen-plotting,
auto-soldering, and PCB isolation routing/drilling). It runs entirely in the
browser, talks to the machine's GRBL controller over USB via the **Web Serial
API**, visualizes toolpaths and the machine bed in **3D**, and presents a fully
**dockable / floatable / resizable** panel UI.

It is the **web successor** to the Qt/C++ desktop fork `hjLabs.in_Candle`.
Intended to be hosted as a static SaaS at a subdomain, e.g. `karmyogi.hjlabs.in`.

## Why it exists (and the relationship to the Qt app)

The Qt/C++ app at `/home/hemang/Documents/GitHub/hjLabs.in_Candle` is the
**reference implementation**: it has a complete, working, unit-tested CAD/CAM
core and the full feature set, but Qt Widgets made a modern dockable/resizable
UI painful and hard to iterate on. karmyogi reimplements the **frontend** in
web tech (docking/resizing are trivial and battle-tested there, 3D is nicer, and
hosting is a static build) and **ports the CAD/CAM core algorithms from C++ to
TypeScript**. Treat the Qt code as the spec, not as something to run.

### Reference C++ to port (in the Qt repo `src/cadcam/`)
| C++ file | What to port to TS |
|---|---|
| `geometry.{h,cpp}` | Point/BBox/Polyline, arc + DXF-bulge flattening, signed area/orientation, point-in-polygon, distance helpers |
| `entity.{h,cpp}` | `Entity` (Line/Arc/Circle/Polyline) + `Drawing` document; `flatten()` |
| `toolpath.{h,cpp}` | `Tool`, `ToolpathMove` (Rapid/Feed/Plunge), `Toolpath` |
| `gcodeemitter.{h,cpp}` | Safe G-code: G21/G90/G94/G17, guaranteed safe-Z, **Spindle vs Pen Z mode**, no `-0.000`, modal axis/feed words |
| `dxfimporter.{h,cpp}` | ASCII DXF: LINE/CIRCLE/ARC/LWPOLYLINE/POLYLINE (+ bulges) |
| `offset.{h,cpp}` | polygon offset + concentric inset rings (in TS use a robust clipping lib — see below) |
| `camoperations.{h,cpp}` | engrave / profile (on/inside/outside) / pocket, multi-depth |
| `soldering.{h,cpp}` | auto-soldering points → G-code; spindle output repurposed as **solder-wire feeder** (M3/G4/M5); per-point Free-Z (travel) + Touch-Z (touch-down), feed type (pre-solder / touch-down), feed-time |
| `strokefont.{h,cpp}` | single-stroke (Hershey-simplex) vector font + text layout; loads custom-font JSON |
| `gerberimporter / excellonimporter / pcbcam` | Gerber RS-274X + Excellon → isolation routing / drilling / board cutout |

UI/feature reference: `src/candle/cam/*widget.{h,cpp}` (the CAD/CAM, Soldering,
Writing, PCB, Motion panels) and `src/candle/frmmain.cpp` (controller, jog,
status, sender). The Qt repo also has `tools/handwriting/` — a python3.13
pipeline that turns a photographed template into a custom single-stroke font
JSON (consumed by the Writing mode); keep using it as-is.

A copy of the key reference files lives in `reference/` for offline lookup, but
the Qt repo is the source of truth.

### UI/UX inspiration: cncjs (DESIGN/LOOKS reference only)
[**cncjs**](https://github.com/cncjs/cncjs) is a **visual design reference only** — we do
**not** fork it or adopt its architecture (it's a Node server + socket.io + node-serialport
+ React 15/Redux app; the opposite of our browser-only Web Serial static SPA). We take
*how it looks* (layout, spacing, iconography, widget grouping) and reimplement in our own
stack; if we already do something better, we keep ours. cncjs is **MIT-licensed**, so its
**local asset files (icons/button graphics) may be reused with attribution** once installed.
Borrow its widget information-architecture for our panels: per-axis **DRO** (work + machine
pos, zero/go-to-zero), **jog pad** with step size, **connection** + **status**
(state/feed/spindle/buffer), **console + MDI + macros**, **spindle** + **Z-probe**,
**feed/rapid/spindle override** controls, and 3D tool-path visualization. cncjs also ships a
dedicated responsive view for screens **<720px**, validating our desktop⇄mobile requirement.

## Tech stack (decided)

- **Vite + TypeScript** (strict).
- **React** + **three.js** via **@react-three/fiber** (+ **drei**) for the 3D viewport.
- **dockview** for the dockable/floatable/resizable panel layout (this is the piece
  that was painful in Qt — it is a built-in feature here).
- **Web Serial API** (`navigator.serial`) for GRBL USB comms.
- **zustand** for state (machine state, program, settings, layout/theme).
- Styling: start with CSS variables + a small utility layer (Tailwind optional — decide in Phase 0).
- Testing: **NO unit tests — ever.** Verify *everything* visually in the real browser
  with **Playwright** + screenshots (see closed-loop below). No vitest, no test files.
- Output: static SPA → host on **Cloudflare Pages / R2**.

## Hard constraints / platform notes (know these)

- **Web Serial is Chromium-only** (Chrome/Edge/Opera/Brave; NOT Firefox/Safari) and
  requires **HTTPS or `localhost`** plus a **user gesture** to pick the port.
- GRBL streaming is line-based with flow control; browser latency is fine. Use the
  character-counting protocol (track GRBL's 127-byte RX buffer) for throughput, or
  simple send-then-wait-for-`ok` to start.
- Realtime bytes: `?` (status), `!` (feed hold), `~` (resume), `0x18` (soft reset).
- Provide a **mock serial device** so the whole app is developable/testable without
  hardware (and so Playwright e2e can run headless in CI).

## Safety (generated G-code)

Always emit `G21 G90 G94 G17`, a guaranteed **safe-Z retract** before any XY
travel and at program end, conservative default feeds, and explicit spindle/pen
handling. The machine doubles as a **pen plotter and a solder-wire feeder**, so Z
semantics and the spindle output are **mode-configurable** (Spindle / Pen /
Feeder). Port the emitter's safety behavior exactly from `gcodeemitter.cpp`.

## Responsive UI (REQUIRED — desktop AND mobile, one mental model)

Every page/panel/UI **must** be fully usable at both **desktop** and **mobile/phone**
sizes, and switching between the desktop and mobile versions (and back) must have the
**least possible learning curve** — same controls, labels, and mental model on both,
not two divergent UIs.

- The **dockview** docking shell is desktop-oriented. At narrow/mobile widths the app
  shell falls back to a **mobile layout** (single-column / stacked or a tabbed panel
  switcher) that shows the *same panel content* — only the arrangement changes.
- Use fluid CSS (flex/grid, `clamp()`, media/container queries). Avoid fixed pixel
  widths that break small screens. Touch targets ≥ ~36px; jog pads, number fields, and
  tables (Controller / Soldering / PCB) must be touch-usable and reflow on mobile.
- Verify in the closed loop at **multiple viewport sizes** (desktop + a phone preset)
  via Playwright.

## Closed-loop development (REQUIRED — this is how we work)

Develop in a **closed loop**: change → run the dev server → drive the **real
browser with Playwright** (click / drag / resize / type) → screenshot → *look at
the screenshot* → judge → iterate. Do **not** make many blind changes.

This is now fully automatable (the Playwright MCP tools can open `localhost`,
interact, and screenshot) — unlike the Qt app, where synthetic mouse drags never
triggered the dock splitters and made resize work un-verifiable. Web fixes the
verification loop too.

- **No unit tests.** Verify ALL logic (core CAM/G-code, serial, UI) by exercising it
  through the running app and Playwright — drive it, screenshot, *look*, judge.
- UI: Playwright against the Vite dev server; verify docking/resizing/drag + the
  desktop⇄mobile layouts visually. Typecheck with `tsc --noEmit` (not a test, just types).

## Parallel-agent development

This project is structured for **parallel agents** (see `plan.md`). The golden
rule learned from the Qt work: **parallel agents must own disjoint file sets** —
never let two agents edit the same file at once. `plan.md` assigns each workstream
an explicit `Owns:` directory/file list and a `Depends on:` list, and groups them
into "parallel batches" that can run concurrently. The orchestrator integrates
shared wiring (the app shell / dockview registry) between batches.

## Build / run / host

```bash
npm install
npm run dev          # Vite dev server on localhost:5185 (Web Serial works on localhost)
npm run build        # -> dist/ static files (deploy-time only)
npm run preview      # serve the built app
npm run typecheck    # tsc --noEmit (types only — there are NO unit tests; verify via Playwright)
# deploy: push dist/ to Cloudflare Pages (see docs/deploy.md). HTTPS is automatic.
```

## Conventions / guardrails

- Keep the **CAD/CAM core (`src/core/`) UI-independent and pure** — no React/DOM
  imports — so it stays portable and mirrors the Qt `cadcam` lib structure.
- TypeScript strict; one concern per file; small modules.
- Never block the UI thread on serial I/O; use async streams / a worker if needed.
- Keep generated G-code safe (see Safety above).
- Update this file and `plan.md` as the architecture solidifies.

## Status

- [x] Repo created; CLAUDE.md + plan.md written.
- [x] Phase 0 — scaffold (Vite+React19+TS strict), dockview shell, theme, 3D bed, responsive desktop⇄mobile shell.
- [x] Batch A — W1 GRBL serial transport + mock, W2 CAD/CAM core (geometry/entity/toolpath/gcodeEmitter/offset/cam/dxf), W3 3D viewer.
- [x] Orchestrator glue — `grbl` controller service, console/grblSettings stores, persistence, auto-connect, continuous (press-hold) jog.
- [x] Batch B — Controller (DRO/jog/overrides), Console (MDI/macros), Coordinates (G54–59/zero), Program (load/stream), Visualizer.
- [x] W11 — Motion / GRBL-settings editor (grouped, described, range/corruption-validated, Sync + Save + factory reset).
- [x] Batch C — W7 Wood CAD/CAM (DXF→engrave/profile/pocket), W8 Writing (single-stroke font + custom JSON), W9 Auto-soldering (Free-Z/Touch-Z table + feeder), W10 PCB (Gerber-ZIP package + Excellon → isolation/drill/cutout).
- [x] Batch D — global UI zoom, layout persistence, theme persistence, PWA/offline, Cloudflare deploy config (`public/_redirects`, `_headers`, `docs/deploy.md`).
- All verified in the browser via Playwright; `tsc --noEmit` clean. No unit tests by design.
