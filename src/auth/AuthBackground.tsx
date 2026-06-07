import { useMemo } from 'react'

/**
 * AuthBackground — a lightweight, GPU-cheap procedural background for the
 * sign-in screen. Pure CSS/SVG (no canvas loop, no image assets, no deps):
 *  - a slow-drifting CNC bed grid,
 *  - two soft accent gradient "mesh" blobs that breathe,
 *  - SEVERAL distinct procedural toolpaths (spiral, star/polygon, relief-like
 *    contour, serpentine raster, organic loop) that draw themselves on via
 *    stroke-dashoffset, each trailed by a travelling "cutter" dot.
 *
 * The set of paths — and their position / scale / rotation / timing — is seeded
 * with `Math.random()` on each mount, so every login feels fresh and the layout
 * never repeats session to session.
 *
 * All motion is declared in CSS keyframes (compositor-driven transforms /
 * stroke-dashoffset / opacity); under `prefers-reduced-motion` the paths render
 * fully drawn and static (see auth.css) and the cutter dots are hidden. The
 * whole layer is `pointer-events:none` so it never blocks the sign-in UI.
 */

const VIEW_W = 1200
const VIEW_H = 700

type Generator = (cx: number, cy: number, r: number, rng: () => number) => string

/** Build an SVG path `d` from a list of points (first = M, rest = L). */
function poly(pts: Array<[number, number]>, close = false): string {
  if (pts.length === 0) return ''
  const head = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  const rest = pts
    .slice(1)
    .map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join('')
  return head + rest + (close ? 'Z' : '')
}

/** Archimedean spiral — concentric carve. */
const spiral: Generator = (cx, cy, r, rng) => {
  const turns = 3 + Math.floor(rng() * 3)
  const steps = turns * 36
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const ang = t * turns * Math.PI * 2
    const rad = r * t
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad])
  }
  return poly(pts)
}

/** Star / regular polygon profile. */
const star: Generator = (cx, cy, r, rng) => {
  const points = 5 + Math.floor(rng() * 4)
  const inner = r * (0.38 + rng() * 0.2)
  const rot = rng() * Math.PI
  const pts: Array<[number, number]> = []
  for (let i = 0; i < points * 2; i++) {
    const ang = rot + (i / (points * 2)) * Math.PI * 2
    const rad = i % 2 === 0 ? r : inner
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad])
  }
  return poly(pts, true)
}

/** Relief-like layered contour (stacked wavy ridges). */
const relief: Generator = (cx, cy, r, rng) => {
  const rows = 5 + Math.floor(rng() * 3)
  const amp = r * (0.12 + rng() * 0.1)
  const phase = rng() * Math.PI * 2
  const freq = 1.5 + rng() * 2
  const pts: Array<[number, number]> = []
  for (let row = 0; row < rows; row++) {
    const y = cy - r + (row / (rows - 1)) * r * 2
    const dir = row % 2 === 0 ? 1 : -1
    const cols = 40
    for (let c = 0; c <= cols; c++) {
      const f = c / cols
      const fx = dir > 0 ? f : 1 - f
      const x = cx - r + fx * r * 2
      const yy = y + Math.sin(phase + fx * freq * Math.PI * 2 + row) * amp
      pts.push([x, yy])
    }
  }
  return poly(pts)
}

/** Serpentine raster (boustrophedon pocket fill). */
const raster: Generator = (cx, cy, r, rng) => {
  const rows = 6 + Math.floor(rng() * 4)
  const pts: Array<[number, number]> = []
  for (let row = 0; row < rows; row++) {
    const y = cy - r + (row / (rows - 1)) * r * 2
    const x0 = cx - r
    const x1 = cx + r
    if (row % 2 === 0) {
      pts.push([x0, y], [x1, y])
    } else {
      pts.push([x1, y], [x0, y])
    }
  }
  return poly(pts)
}

/** Organic rounded blob / cam contour. */
const lobes: Generator = (cx, cy, r, rng) => {
  const n = 4 + Math.floor(rng() * 4)
  const wobble = 0.18 + rng() * 0.22
  const phase = rng() * Math.PI * 2
  const steps = 80
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const ang = (i / steps) * Math.PI * 2
    const rad = r * (1 - wobble + wobble * Math.cos(ang * n + phase))
    pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad])
  }
  return poly(pts, true)
}

const GENERATORS: Generator[] = [spiral, star, relief, raster, lobes]

interface PathSpec {
  d: string
  /** total approximate length (for dasharray) */
  len: number
  delay: number
  dur: number
  opacity: number
  width: number
  /** travelling-cutter motion duration */
  cutterDur: number
}

/** Rough polyline length so stroke-dasharray covers the whole path exactly. */
function pathLength(d: string): number {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)
  if (!nums) return 3000
  let len = 0
  let px = 0
  let py = 0
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = parseFloat(nums[i])
    const y = parseFloat(nums[i + 1])
    if (i > 0) len += Math.hypot(x - px, y - py)
    px = x
    py = y
  }
  // Pad generously to be safe for the closing segment / curve sampling.
  return Math.ceil(len * 1.05) + 200
}

function buildPaths(): PathSpec[] {
  const rng = Math.random
  // Pick 3–4 distinct generators (no repeats) for this session.
  const pool = [...GENERATORS]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const count = 3 + Math.floor(rng() * 2)
  const chosen = pool.slice(0, count)

  // Spread the paths across the canvas in loose, non-overlapping regions.
  const regions: Array<[number, number]> = [
    [0.22, 0.34],
    [0.74, 0.28],
    [0.32, 0.74],
    [0.78, 0.72],
    [0.52, 0.5],
  ]
  for (let i = regions.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[regions[i], regions[j]] = [regions[j], regions[i]]
  }

  return chosen.map((gen, idx) => {
    const [rxf, ryf] = regions[idx]
    const cx = rxf * VIEW_W + (rng() - 0.5) * 80
    const cy = ryf * VIEW_H + (rng() - 0.5) * 60
    const r = 90 + rng() * 110
    const d = gen(cx, cy, r, rng)
    const dur = 12 + rng() * 8
    return {
      d,
      len: pathLength(d),
      delay: rng() * dur * 0.6,
      dur,
      opacity: 0.28 + rng() * 0.32,
      width: 1.4 + rng() * 1.4,
      cutterDur: dur,
    }
  })
}

export function AuthBackground() {
  // Seed once per mount → varies every login, stable within a session render.
  const paths = useMemo(buildPaths, [])

  return (
    <div className="auth-bg" aria-hidden="true">
      <div className="auth-bg-grid" />
      <div className="auth-bg-blob auth-bg-blob--1" />
      <div className="auth-bg-blob auth-bg-blob--2" />
      <svg
        className="auth-bg-toolpath"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        {paths.map((p, i) => (
          <g key={i}>
            <path
              className="auth-bg-path"
              d={p.d}
              style={
                {
                  '--len': p.len,
                  '--dur': `${p.dur}s`,
                  '--delay': `${p.delay}s`,
                  strokeWidth: p.width,
                  opacity: p.opacity,
                } as React.CSSProperties
              }
            />
            <circle className="auth-bg-cutter" r={3.5 + p.width}>
              <animateMotion
                dur={`${p.cutterDur}s`}
                begin={`${p.delay}s`}
                repeatCount="indefinite"
                keyPoints="0;1"
                keyTimes="0;1"
                calcMode="linear"
                path={p.d}
              />
            </circle>
          </g>
        ))}
      </svg>
      <div className="auth-bg-vignette" />
    </div>
  )
}
