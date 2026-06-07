/**
 * (Removed) The right-click "add shape" context menu has been retired: adding
 * shapes now lives on the viewport toolbar (see VisualizerPanel's `.vz-toolbar`
 * shape buttons), which calls `useViewportShapes.addShape(kind, 0, 0)` directly.
 *
 * Right-click in the viewport is therefore free again for OrbitControls
 * pan/orbit. This file is intentionally left empty to avoid a stale import.
 */
export {}
