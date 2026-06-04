// 3D-Carving Web Worker — runs the heavy heightmap raster + roughing + finishing
// + optional cutout + G-code emission OFF the main thread so the UI never freezes
// while the operator tweaks parameters (carving auto-runs on a debounce).
//
// This file is intentionally THIN: it reconstructs the meshes from the
// transferred triangle buffers, calls the pure `buildCarveProgram` from
// `carve3d.ts` (which does the real work and stays UI-independent), and posts
// paced progress + a final result back to the panel.
//
// Created from the panel via:
//   new Worker(new URL('./carve3d.worker.ts', import.meta.url), { type: 'module' })
//
// Cancellation: the panel cancels by calling `worker.terminate()` (authoritative
// and instant) OR by posting a newer request — each request carries a monotonic
// `jobId`, and the panel ignores any `done`/`progress` whose id is stale. We also
// honour an in-worker `cancel` flag observed between jobs (the per-job compute is
// synchronous, so terminate() is what stops a single huge job mid-flight).

import {
  buildCarveProgram,
  type CarveWorkerInbound,
  type CarveWorkerOutbound,
} from './carve3d';
import type { StlMesh } from './slicer';

// Worker global scope (typed so postMessage/onmessage resolve under the app tsconfig).
const ctx = self as unknown as Worker & { onmessage: ((e: MessageEvent) => void) | null };

let cancelled = false;

function post(msg: CarveWorkerOutbound) {
  ctx.postMessage(msg);
}

ctx.onmessage = (e: MessageEvent<CarveWorkerInbound>) => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (data.type !== 'carve') return;

  // A fresh job — clear any stale cancel from a previous run on this worker.
  cancelled = false;
  const jobId = data.jobId;

  try {
    const specs = data.jobs.map((j) => j.spec);
    const meshes: StlMesh[] = data.jobs.map((j) => ({
      triangles: j.triangles,
      triangleCount: j.triangleCount,
      vertexCount: j.vertexCount,
      bbox: j.bbox,
      format: j.format,
    }));

    const res = buildCarveProgram(specs, meshes, data.globals, data.cutout, (done, total) => {
      if (cancelled) return false;
      post({ type: 'progress', jobId, done, total });
      return true;
    });

    if (cancelled) {
      post({ type: 'error', jobId, message: 'Carving cancelled.', cancelled: true });
      return;
    }

    post({
      type: 'done',
      jobId,
      gcode: res.gcode,
      lineCount: res.lineCount,
      jobsCarved: res.jobsCarved,
      grids: res.grids,
      warnings: res.warnings,
    });
  } catch (err) {
    if (cancelled) {
      post({ type: 'error', jobId, message: 'Carving cancelled.', cancelled: true });
    } else {
      post({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
