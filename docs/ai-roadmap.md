# AI / camera workbench — archival roadmap (NOT in the public build yet)

> **Status: idea-thinking + Phase 1 scaffolding.** Gated behind `useExperimentalAI()`
> (`src/experimental.ts`): visible only with `VITE_EXPERIMENTAL_AI=true` in local
> dev, or to the signed-in owner (`hemangjoshi37a@gmail.com`) in production. The
> public never sees it. Each phase must be **fully finished + battle-tested**
> before its flag is removed and it ships to everyone.

## Vision

Use the device camera + on-device (WebGPU) models to set up and assist a carving
job: detect the stock on the bed, suggest material + feeds/speeds, and (later)
reconstruct real objects to carve onto them — all **client-side, zero backend**
(fits the static Cloudflare SPA; camera frames never leave the device, which is
also good for the privacy/legal story). Browser reality: Chrome/Edge (already
required for Web Serial) ship WebGPU; models download once and cache in the PWA
(Cache Storage / OPFS) hosted on R2.

**Human-in-the-loop is mandatory.** A 3-axis hobby GRBL machine has no collision
or load feedback and CNC is destructive — AI *proposes* (origin, stock, material,
strategy), the operator reviews and presses Go. No unattended camera→finished-part.

## What already exists (reuse, don't rebuild)

- **Calibration + homography** — `src/core/cameraCalib.ts`: `solveHomography`,
  `applyHomography`, `reprojectionRMS`; QR/marker, manual 4-corner, machine-motion.
- **Detection primitives** — `silhouetteMask` (empty-bed vs current diff),
  `largestBlobBBoxMm` (markerless largest-blob → px bbox → mm rect), `visualHull`
  (two-camera height estimate).
- **Stores** — `useCameraCalib` (`jobRect`, `jobHeightMm`, cameras[].H homography),
  `useCarveJobs` (`setJobStock`, `setJobPlacement`), `useStock`, `useBed`.
- **Feeds/speeds** — `recommend(material, bit)` in `src/core/toolLibrary.ts`;
  11 materials × 18 bits in `materials.ts` / `toolLibrary.ts`.
- **Carving core** — mature heightmap raster in `src/core/carve3d.ts`
  (`buildHeightmap` z-buffer + tool dilation, `buildRoughing` multi-level w/
  ramp/helix entry + denoise + nearest-neighbour ordering + `engagedLink`,
  `buildFinishing` surface-following raster, scallop stepover via `autoCarveParams`).

## Phases

### Phase 1 — Camera → stock setup  *(scaffolded, gated)*
- **Done:** `CameraStockApply` in `CadCamPanel.tsx` — reads detected `jobRect` +
  `jobHeightMm` and, on click, fills the selected job's stock size and centres the
  model on the detected stock. Keys `cc.camStock*`. End-to-end verified.
- **To finish before public:** markerless auto-detect button wired in CameraPanel
  (`silhouetteMask` → `largestBlobBBoxMm` → `setJobRect`); robustness across
  lighting/angle; confidence + "review before apply"; tests on real bed photos.

### Phase 2 — Toolpath engine upgrade  *(no AI; biggest carve-quality win)*
- Hybrid finishing: add **waterline / constant-Z** passes for steep walls
  (raster alone finishes vertical faces poorly), blended with the existing raster.
- Adaptive / trochoidal roughing (constant tool engagement), retract coalescing,
  optional multi-tool rest machining. Extension points: `buildRoughing`,
  `buildFinishing`, `orderComponents`, `CutEntryOpts` in `carve3d.ts`.

### Phase 3 — Material + feeds suggester  *(WebGPU)*
- Small MobileNet-class classifier (`onnxruntime-web` / `transformers.js`, WebGPU)
  proposes a material profile from the camera frame; rule-based → ML feeds/speeds.
- **Always a suggestion the operator confirms — never auto-applied** (wrong feeds
  break bits / start fires). Add a `karmyogi-models` runtime-cache rule + OPFS for
  the one-time model download (see `vite.config.ts` PWA config).

### Phase 4 — 3D scan → carve  *(R&D differentiator)*
- Depth model or 3D Gaussian splatting (WebGPU) to reconstruct a real object and
  carve/engrave onto its actual surface. Heavy, niche, impressive. Builds on
  `visualHull` + the three.js viewer.

## Graduation checklist (per phase, before removing the flag)
- Works across real lighting/angles/materials, not just a demo.
- No new console errors; `tsc` clean; i18n complete for all new keys.
- Verified in the closed loop (Playwright) at desktop + mobile widths.
- Human-in-the-loop confirm step for anything that changes cutting parameters.
- Model downloads are lazy/one-time and don't bloat first paint.
