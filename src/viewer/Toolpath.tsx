import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Segment } from './gcodeToPolylines'
import { useSettings } from '../store'
import { prefersReducedMotion } from './reducedMotion'

interface ToolpathProps {
  /** Parsed segments (from gcodeToPolylines). */
  segments: Segment[]
  /** Override cut colour (defaults to a theme accent). */
  cutColor?: string
  /** Override rapid colour (defaults to a theme-muted tone). */
  rapidColor?: string
  /**
   * Simulation reveal: index of the segment currently being executed. When
   * provided (>= 0), segments before it render as "traveled" (bright), the
   * active segment is split at `revealPoint`, and later segments render as
   * "upcoming" (dim). Omit (or pass < 0) for the static, full-path look.
   */
  revealIndex?: number
  /** Point on the active segment the tool has reached, for the split. */
  revealPoint?: [number, number, number] | null
  /**
   * When revealing, fully HIDE the already-processed (traveled) portion instead
   * of just dimming it — leaves only the work still to come on screen. Default
   * false (processed lines are shown desaturated/dim).
   */
  hideProcessed?: boolean
  /**
   * Cross-panel HOVER highlight: when true, this op's cut lines SHIMMER — an
   * animated pulse toward a bright highlight (via useFrame) so the user can see
   * which viewer line corresponds to the hovered operation row. Honours
   * `prefers-reduced-motion`: when reduced, a STATIC brightened highlight (no
   * animation). Default false. Only meaningful in the static (non-reveal) path.
   */
  highlight?: boolean
  /**
   * Slightly DIM this op's cut lines (lowered opacity) — used while ANOTHER op
   * is hovered, so the shimmering one pops. Default false. Ignored while
   * `highlight` is true. Only meaningful in the static (non-reveal) path.
   */
  dim?: boolean
  /**
   * L10 — colour CUT lines by their S-value (laser power) using a heat gradient
   * instead of a single cut colour. Only applies in the static (non-reveal)
   * path; the simulation reveal keeps its traveled/upcoming split. Default false.
   */
  colorByPower?: boolean
  /**
   * Power range `[min, max]` used to normalise the heat-map colours so every
   * section/op shares the SAME scale (a value at `max` is the hottest). Ignored
   * unless `colorByPower` is set.
   */
  powerRange?: [number, number] | null
}

/**
 * Map a normalised value t∈[0,1] to a perceptual heat colour (cool blue → cyan →
 * green → amber → hot red). Pure + allocation-free per call beyond the returned
 * tuple; used once per segment when building the vertex-colour buffer (never per
 * frame). Matches the legend gradient in the panel.
 */
export function heatColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  // 5 stops in 0..1 RGB. Linear interpolation between the bracketing stops.
  const stops: [number, [number, number, number]][] = [
    [0.0, [0.15, 0.3, 0.85]], // blue (low power)
    [0.25, [0.1, 0.75, 0.85]], // cyan
    [0.5, [0.2, 0.8, 0.3]], // green
    [0.75, [0.97, 0.75, 0.15]], // amber
    [1.0, [0.92, 0.16, 0.18]], // red (high power)
  ]
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [a0, ca] = stops[i - 1]
      const [b0, cb] = stops[i]
      const f = (x - a0) / (b0 - a0 || 1)
      return [
        ca[0] + (cb[0] - ca[0]) * f,
        ca[1] + (cb[1] - ca[1]) * f,
        ca[2] + (cb[2] - ca[2]) * f,
      ]
    }
  }
  return stops[stops.length - 1][1]
}

/**
 * Build a single vertex-coloured LineSegments geometry for the CUT moves, each
 * coloured by its power (S-value) via {@link heatColor}. Built once per
 * segments/range change (useMemo) — no per-frame allocation. Returns null when
 * there are no cut moves.
 */
function buildPowerGeometry(
  segments: Segment[],
  range: [number, number],
): THREE.BufferGeometry | null {
  const [lo, hi] = range
  const span = hi - lo || 1
  const pos: number[] = []
  const col: number[] = []
  for (const s of segments) {
    if (s.kind !== 'cut') continue
    const t = ((s.power ?? lo) - lo) / span
    const [r, g, b] = heatColor(t)
    pos.push(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2])
    col.push(r, g, b, r, g, b)
  }
  if (pos.length === 0) return null
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  return geom
}

/** Mix a hex colour toward neutral grey by `amount` (0..1) — the "spent" look. */
function desaturate(hex: string, amount: number): THREE.Color {
  const c = new THREE.Color(hex)
  // Pull toward this layer's mid-grey so executed cuts read as "done/cold".
  const grey = new THREE.Color(0.5, 0.5, 0.5)
  return c.lerp(grey, amount)
}

/** Build a non-indexed LineSegments geometry from segments of one kind. */
function buildGeometry(segments: Segment[], kind: Segment['kind']): THREE.BufferGeometry | null {
  const pts: number[] = []
  for (const s of segments) {
    if (s.kind !== kind) continue
    pts.push(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2])
  }
  if (pts.length === 0) return null
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return geom
}

/**
 * Renders parsed G-code segments as coloured three.js line segments.
 * Cuts (G1/G2/G3) use the accent colour as solid lines; rapids (G0) use a
 * muted dashed line so travel moves read as secondary.
 *
 * When `revealIndex` is provided it splits the path into traveled / active /
 * upcoming portions for the playback simulation (bright = already run, dim =
 * still to come); otherwise it renders the full path uniformly as before.
 *
 * Contains no business logic — it only turns already-parsed geometry into a
 * scene. Theme colours come from the settings store.
 */
export function Toolpath({
  segments,
  cutColor,
  rapidColor,
  revealIndex,
  revealPoint,
  hideProcessed = false,
  highlight = false,
  dim = false,
  colorByPower = false,
  powerRange = null,
}: ToolpathProps) {
  const theme = useSettings((s) => s.theme)

  const cut = cutColor ?? (theme === 'dark' ? '#38bdf8' : '#0369a1')
  const rapid = rapidColor ?? (theme === 'dark' ? '#6b7280' : '#94a3b8')
  // Executed cuts desaturate toward grey so the REMAINING work stays the bright,
  // saturated colour the operator tracks (V3 progress dimming).
  const cutDone = useMemo(() => desaturate(cut, 0.72), [cut])

  // --- Hover shimmer ---------------------------------------------------------
  // The base cut colour and a bright highlight to pulse toward. Reused across
  // frames (no per-frame allocation): useFrame only lerps between these two.
  const baseColor = useMemo(() => new THREE.Color(cut), [cut])
  const brightColor = useMemo(() => baseColor.clone().lerp(new THREE.Color('#ffffff'), 0.6), [baseColor])
  const reduceMotion = useMemo(() => prefersReducedMotion(), [])
  // Animate ONLY when this op is hovered AND motion is allowed. We mutate the
  // live material via a ref so the pulse never re-renders React.
  const matRef = useRef<THREE.LineBasicMaterial>(null)
  // Scratch colour reused every frame (no allocation in the hot loop).
  const scratch = useRef(new THREE.Color())
  useFrame((state) => {
    const m = matRef.current
    if (!m) return
    if (highlight && !reduceMotion) {
      // 0..1 triangle-ish pulse; mix base→bright and modulate opacity.
      const p = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 5)
      scratch.current.copy(baseColor).lerp(brightColor, p)
      m.color.copy(scratch.current)
      m.opacity = 0.7 + 0.3 * p
    }
  })

  const revealing = revealIndex !== undefined && revealIndex >= 0
  // L10: heat-map mode replaces the flat cut colour with a per-segment vertex
  // colour buffer. Only when not revealing and a range was supplied.
  const heatmap = colorByPower && !revealing && !!powerRange

  // --- Static path geometries (used when not revealing). -------------------
  const cutGeom = useMemo(
    () => (revealing || heatmap ? null : buildGeometry(segments, 'cut')),
    [revealing, heatmap, segments],
  )
  const rapidGeom = useMemo(
    () => (revealing ? null : buildGeometry(segments, 'rapid')),
    [revealing, segments],
  )
  // Vertex-coloured cut geometry for the power heat-map (built once per change).
  const powerGeom = useMemo(
    () => (heatmap && powerRange ? buildPowerGeometry(segments, powerRange) : null),
    [heatmap, powerRange, segments],
  )

  // Dispose old geometries when they change / on unmount. MUST be useEffect:
  // useMemo never runs its returned cleanup, so the GPU buffers would leak
  // (a contributor to WebGL context loss / the 3D white-screen).
  useEffect(() => {
    return () => {
      cutGeom?.dispose()
      rapidGeom?.dispose()
      powerGeom?.dispose()
    }
  }, [cutGeom, rapidGeom, powerGeom])

  // SIMULATION reveal: delegate to a buffer-stable renderer that builds the line
  // geometry ONCE and only advances a GPU draw-range cursor per frame — so the
  // 60fps playhead never rebuilds/re-uploads the whole toolpath (the old per-tick
  // `buildGeometry` x4 was the dominant sim-time FPS sink on large programs).
  if (revealing) {
    return (
      <RevealToolpath
        segments={segments}
        cut={cut}
        cutDone={cutDone}
        rapid={rapid}
        revealIndex={revealIndex as number}
        revealPoint={revealPoint ?? null}
        hideProcessed={hideProcessed}
      />
    )
  }

  // Static cut-material props. Hover wins over dim:
  //  • highlight + reduced motion → STATIC bright, fully opaque (no animation).
  //  • highlight + motion allowed → useFrame pulses color/opacity (start bright).
  //  • dim (another op hovered)   → faded so the hovered one pops.
  //  • normal                     → base colour, opaque.
  const cutMatColor = highlight ? brightColor : cut
  const cutTransparent = highlight ? !reduceMotion : dim
  const cutOpacity = highlight ? 1 : dim ? 0.35 : 1

  return (
    <group>
      {/* L10 heat-map: cut lines coloured by power via per-vertex colours. */}
      {powerGeom && (
        <lineSegments geometry={powerGeom}>
          <lineBasicMaterial vertexColors />
        </lineSegments>
      )}
      {cutGeom && (
        <lineSegments geometry={cutGeom}>
          <lineBasicMaterial
            ref={matRef}
            color={cutMatColor}
            transparent={cutTransparent}
            opacity={cutOpacity}
          />
        </lineSegments>
      )}
      {rapidGeom && (
        <RapidLines geometry={rapidGeom} color={rapid} opacity={dim && !highlight ? 0.25 : 0.85} />
      )}
    </group>
  )
}

/**
 * Buffer-stable simulation reveal. The full cut + rapid line buffers are built
 * ONCE (per `segments`); revealing the path over time only moves a GPU
 * `drawRange` cursor — an O(1) number change, NOT an O(N) geometry rebuild +
 * re-upload. The single active segment is split at the reveal point via a tiny
 * dynamic 2-vertex buffer (12 floats/frame). The "done" and "todo" halves of one
 * kind share a single position attribute (uploaded once) across two geometries.
 */
function RevealToolpath({
  segments,
  cut,
  cutDone,
  rapid,
  revealIndex,
  revealPoint,
  hideProcessed,
}: {
  segments: Segment[]
  cut: string
  cutDone: THREE.Color
  rapid: string
  revealIndex: number
  revealPoint: [number, number, number] | null
  hideProcessed: boolean
}) {
  // Build the static buffers + per-kind prefix counts ONCE per program. The
  // done/todo geometries of each kind share ONE position BufferAttribute, so
  // three.js uploads each buffer to the GPU a single time.
  const built = useMemo(() => {
    const cutPts: number[] = []
    const rapidPts: number[] = []
    const n = segments.length
    // prefix[i] = number of segments of that kind in [0, i).
    const cutPrefix = new Int32Array(n + 1)
    const rapidPrefix = new Int32Array(n + 1)
    let nc = 0
    let nr = 0
    for (let i = 0; i < n; i++) {
      cutPrefix[i] = nc
      rapidPrefix[i] = nr
      const s = segments[i]
      if (s.kind === 'cut') {
        cutPts.push(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2])
        nc++
      } else {
        rapidPts.push(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2])
        nr++
      }
    }
    cutPrefix[n] = nc
    rapidPrefix[n] = nr

    const cutAttr = new THREE.Float32BufferAttribute(cutPts, 3)
    const rapidAttr = new THREE.Float32BufferAttribute(rapidPts, 3)
    const share = (attr: THREE.Float32BufferAttribute) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', attr)
      return g
    }
    const doneCut = share(cutAttr)
    const todoCut = share(cutAttr)
    const doneRapid = share(rapidAttr)
    const todoRapid = share(rapidAttr)
    // Active-segment split: two dynamic 2-vertex lines updated each frame.
    const activeDone = new THREE.BufferGeometry()
    activeDone.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3))
    const activeTodo = new THREE.BufferGeometry()
    activeTodo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3))
    return {
      doneCut,
      todoCut,
      doneRapid,
      todoRapid,
      activeDone,
      activeTodo,
      cutPrefix,
      rapidPrefix,
      cutTotalV: nc * 2,
      rapidTotalV: nr * 2,
    }
  }, [segments])

  // Per-tick: advance draw ranges + refresh the active split. All O(1).
  useLayoutEffect(() => {
    const n = segments.length
    if (n === 0) return
    const ri = Math.max(0, Math.min(revealIndex, n - 1))
    const active = segments[ri]
    const activeIsCut = active.kind === 'cut'
    const {
      doneCut,
      todoCut,
      doneRapid,
      todoRapid,
      activeDone,
      activeTodo,
      cutPrefix,
      rapidPrefix,
      cutTotalV,
      rapidTotalV,
    } = built

    const doneCutV = cutPrefix[ri] * 2
    const doneRapidV = rapidPrefix[ri] * 2
    doneCut.setDrawRange(0, doneCutV)
    doneRapid.setDrawRange(0, doneRapidV)
    // The active segment is drawn by the dynamic split, so SKIP it in the static
    // "todo" range (advance past it by one segment of its own kind).
    const todoCutStart = (cutPrefix[ri] + (activeIsCut ? 1 : 0)) * 2
    const todoRapidStart = (rapidPrefix[ri] + (activeIsCut ? 0 : 1)) * 2
    todoCut.setDrawRange(todoCutStart, Math.max(0, cutTotalV - todoCutStart))
    todoRapid.setDrawRange(todoRapidStart, Math.max(0, rapidTotalV - todoRapidStart))

    const ad = (activeDone.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const at = (activeTodo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    if (revealPoint) {
      ad[0] = active.from[0]; ad[1] = active.from[1]; ad[2] = active.from[2]
      ad[3] = revealPoint[0]; ad[4] = revealPoint[1]; ad[5] = revealPoint[2]
      at[0] = revealPoint[0]; at[1] = revealPoint[1]; at[2] = revealPoint[2]
      at[3] = active.to[0]; at[4] = active.to[1]; at[5] = active.to[2]
      activeDone.setDrawRange(0, 2)
      activeTodo.setDrawRange(0, 2)
    } else {
      // No partial point → the whole active segment counts as done.
      ad[0] = active.from[0]; ad[1] = active.from[1]; ad[2] = active.from[2]
      ad[3] = active.to[0]; ad[4] = active.to[1]; ad[5] = active.to[2]
      activeDone.setDrawRange(0, 2)
      activeTodo.setDrawRange(0, 0)
    }
    ;(activeDone.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(activeTodo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }, [built, segments, revealIndex, revealPoint])

  // Dispose all geometries on change / unmount (shared attributes dispose safely).
  useLayoutEffect(() => {
    return () => {
      built.doneCut.dispose()
      built.todoCut.dispose()
      built.doneRapid.dispose()
      built.todoRapid.dispose()
      built.activeDone.dispose()
      built.activeTodo.dispose()
    }
  }, [built])

  const n = segments.length
  const ri = Math.max(0, Math.min(revealIndex, Math.max(0, n - 1)))
  const activeIsCut = n === 0 || segments[ri].kind === 'cut'

  return (
    <group>
      {/* Traveled (done): desaturated + dim, drawn first so remaining work sits on top. */}
      {!hideProcessed && (
        <lineSegments geometry={built.doneCut}>
          <lineBasicMaterial color={cutDone} transparent opacity={0.5} />
        </lineSegments>
      )}
      {!hideProcessed && (
        <lineSegments geometry={built.doneRapid}>
          <lineBasicMaterial color={rapid} transparent opacity={0.18} />
        </lineSegments>
      )}
      {/* Remaining work (todo): full bright saturated colour. */}
      <lineSegments geometry={built.todoCut}>
        <lineBasicMaterial color={cut} />
      </lineSegments>
      <lineSegments geometry={built.todoRapid}>
        <lineBasicMaterial color={rapid} transparent opacity={0.7} />
      </lineSegments>
      {/* Active segment, split at the reveal point. */}
      {!hideProcessed && (
        <lineSegments geometry={built.activeDone}>
          <lineBasicMaterial color={activeIsCut ? cutDone : rapid} transparent opacity={0.5} />
        </lineSegments>
      )}
      <lineSegments geometry={built.activeTodo}>
        <lineBasicMaterial color={activeIsCut ? cut : rapid} transparent opacity={activeIsCut ? 1 : 0.7} />
      </lineSegments>
    </group>
  )
}

/** Dashed rapid lines — dashes require computed line distances. */
function RapidLines({
  geometry,
  color,
  opacity = 0.85,
}: {
  geometry: THREE.BufferGeometry
  color: string
  opacity?: number
}) {
  const lines = useMemo(() => {
    const mat = new THREE.LineDashedMaterial({
      color: new THREE.Color(color),
      dashSize: 3,
      gapSize: 2,
      transparent: true,
      opacity,
    })
    const obj = new THREE.LineSegments(geometry, mat)
    obj.computeLineDistances()
    return obj
  }, [geometry, color, opacity])

  useEffect(() => {
    return () => {
      ;(lines.material as THREE.Material).dispose()
    }
  }, [lines])

  return <primitive object={lines} />
}
