/**
 * Pure camera-framing math for the 3D viewer.
 *
 * NO three.js imports — returns plain {position, target} tuples so it is
 * unit-testable and the React component just feeds the result to the camera
 * and OrbitControls. Z-up convention (GRBL / this app): the bed is the XY
 * plane and the tool moves in +Z.
 */

export type Vec3 = [number, number, number]

export interface CameraView {
  /** Camera world position. */
  position: Vec3
  /** Look-at target (also the OrbitControls target). */
  target: Vec3
}

export interface Bounds3 {
  min: Vec3
  max: Vec3
}

export type ViewName = 'iso' | 'top' | 'front'

const DEFAULT_FOV_DEG = 45

/** Centre point of a bounds box. */
export function boundsCenter(b: Bounds3): Vec3 {
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ]
}

/** Largest dimension of a bounds box (with a small floor so empty/flat boxes still frame). */
export function boundsRadius(b: Bounds3): number {
  const dx = b.max[0] - b.min[0]
  const dy = b.max[1] - b.min[1]
  const dz = b.max[2] - b.min[2]
  const diag = Math.hypot(dx, dy, dz)
  return Math.max(diag / 2, 1)
}

/**
 * Distance the camera must sit from the target so a sphere of `radius` fits
 * the vertical FOV, with a margin factor (1.0 = exact fit; >1 = padding).
 */
export function fitDistance(
  radius: number,
  fovDeg = DEFAULT_FOV_DEG,
  margin = 1.3,
): number {
  const fov = (fovDeg * Math.PI) / 180
  return (radius / Math.sin(fov / 2)) * margin
}

/**
 * Frame the given bounds with a named view direction.
 *
 * - `iso`   — looking from +X/-Y/+Z (classic CAM isometric, matches the
 *             Phase-0 default camera direction).
 * - `top`   — looking straight down -Z onto the XY bed (Y up on screen).
 * - `front` — looking along +Y toward the XZ plane (Z up on screen).
 */
export function frameBounds(
  bounds: Bounds3 | null,
  view: ViewName,
  fovDeg = DEFAULT_FOV_DEG,
  bedSize: Vec3 = [300, 200, 100],
): CameraView {
  // Fall back to the bed extents when there is no toolpath yet.
  const b: Bounds3 =
    bounds ?? { min: [0, 0, 0], max: [bedSize[0], bedSize[1], bedSize[2]] }

  const target = boundsCenter(b)
  const radius = boundsRadius(b)
  const dist = fitDistance(radius, fovDeg)

  const dir = viewDirection(view)
  const position: Vec3 = [
    target[0] + dir[0] * dist,
    target[1] + dir[1] * dist,
    target[2] + dir[2] * dist,
  ]
  return { position, target }
}

/**
 * Fit-to-bounds keeping the *current* viewing direction. Used by the "fit"
 * button: it reframes without changing the angle the user is looking from.
 *
 * @param currentPosition camera position now
 * @param currentTarget   orbit target now
 */
export function fitToBounds(
  bounds: Bounds3 | null,
  currentPosition: Vec3,
  currentTarget: Vec3,
  fovDeg = DEFAULT_FOV_DEG,
  bedSize: Vec3 = [300, 200, 100],
): CameraView {
  const b: Bounds3 =
    bounds ?? { min: [0, 0, 0], max: [bedSize[0], bedSize[1], bedSize[2]] }

  const target = boundsCenter(b)
  const radius = boundsRadius(b)
  const dist = fitDistance(radius, fovDeg)

  // Preserve current viewing direction; default to iso if degenerate.
  let dir: Vec3 = [
    currentPosition[0] - currentTarget[0],
    currentPosition[1] - currentTarget[1],
    currentPosition[2] - currentTarget[2],
  ]
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len < 1e-6) {
    dir = viewDirection('iso')
  } else {
    dir = [dir[0] / len, dir[1] / len, dir[2] / len]
  }

  const position: Vec3 = [
    target[0] + dir[0] * dist,
    target[1] + dir[1] * dist,
    target[2] + dir[2] * dist,
  ]
  return { position, target }
}

/** Unit direction (camera-from-target) for each named view. */
export function viewDirection(view: ViewName): Vec3 {
  switch (view) {
    case 'top':
      // Looking straight down the +Z axis onto the bed.
      return [0, 0, 1]
    case 'front':
      // Looking toward +Y (camera in front of the XZ plane), Z up.
      return [0, -1, 0]
    case 'iso':
    default: {
      // From +X/-Y/+Z, normalized — matches Phase-0 camera [200,-260,220].
      const v: Vec3 = [1, -1.3, 1.1]
      const len = Math.hypot(v[0], v[1], v[2])
      return [v[0] / len, v[1] / len, v[2] / len]
    }
  }
}
