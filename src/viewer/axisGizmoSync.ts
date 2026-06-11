import { Quaternion } from 'three'

// Live orientation of the main viewer camera, published each frame by
// <CameraQuatReporter/> (inside the main Canvas) and consumed by the independent
// <AxisOverlay/> mini-canvas so its axis triad mirrors the main view. A plain
// shared object (not state) — it's read/written every frame, never triggers React.
export const cameraQuat = new Quaternion()
