// Slicer Web Worker — runs the heavy FDM slice + G-code emission OFF the main
// thread so the UI never freezes. This file is intentionally THIN: it parses a
// request message, calls the pure slicing functions from `slicer.ts` (which do
// the real work and stay UI-independent), and posts paced progress + a final
// result back to the panel.
//
// Created from the panel via:
//   new Worker(new URL('../core/slicer.worker.ts', import.meta.url), { type: 'module' })
//
// Cancellation: the panel cancels by calling `worker.terminate()` (authoritative
// and instant). We additionally honour an in-worker `cancel` flag where it can
// be observed — but because the pure slice is synchronous, terminate() is what
// actually stops a long job mid-flight.

import {
  sliceMesh,
  sliceToGcode,
  estimatePrint,
  SliceCancelled,
  type StlMesh,
  type SliceWorkerInbound,
  type SliceWorkerOutbound,
} from './slicer';

// Worker global scope (typed so postMessage/onmessage resolve under the app tsconfig).
const ctx = self as unknown as Worker & { onmessage: ((e: MessageEvent) => void) | null };

let cancelled = false;

function post(msg: SliceWorkerOutbound) {
  ctx.postMessage(msg);
}

ctx.onmessage = (e: MessageEvent<SliceWorkerInbound>) => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (data.type !== 'slice') return;

  // A fresh job — clear any stale cancel from a previous run on this worker.
  cancelled = false;

  try {
    const mesh: StlMesh = {
      triangles: data.triangles,
      triangleCount: data.triangleCount,
      vertexCount: data.vertexCount,
      bbox: data.bbox,
      format: data.format,
    };

    // Phase split for a smooth overall bar: slicing is the bulk (0..0.85),
    // G-code emission is the tail (0.85..1.0).
    const SLICE_END = 0.85;

    const slice = sliceMesh(mesh, data.sliceParams, ({ phase, current, total, fraction }) => {
      if (cancelled) return false;
      post({ type: 'progress', phase, current, total, fraction: fraction * SLICE_END });
      return true;
    });

    if (slice.layerCount === 0) {
      // Not an error — let the panel surface the warnings as a status message.
      post({ type: 'done', gcode: '', layers: 0, lines: 0, warnings: slice.warnings });
      return;
    }

    const gcode = sliceToGcode(slice, data.gcodeParams, ({ phase, current, total, fraction }) => {
      if (cancelled) return false;
      post({ type: 'progress', phase, current, total, fraction: SLICE_END + fraction * (1 - SLICE_END) });
      return true;
    });

    post({ type: 'progress', phase: 'gcode', current: slice.layerCount, total: slice.layerCount, fraction: 1 });

    let lines = 0;
    for (let i = 0, n = gcode.length; i < n; i++) if (gcode.charCodeAt(i) === 10) lines++;

    const estimate = estimatePrint(slice, data.gcodeParams);
    post({ type: 'done', gcode, layers: slice.layerCount, lines, warnings: slice.warnings, estimate });
  } catch (err) {
    if (err instanceof SliceCancelled || cancelled) {
      post({ type: 'error', message: 'Slicing cancelled.', cancelled: true });
    } else {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
};
