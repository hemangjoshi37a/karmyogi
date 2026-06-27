import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { useSolderViz } from '../store/solderViz'
import { useProgram, useMachine } from '../store'
import { usePlayback } from '../store/playback'
import { prefersReducedMotion } from './reducedMotion'
import { isIdentityJob, type JobPlacement } from '../core/transform'

/**
 * Lightweight 3D PCB stand-in for the Auto-Soldering tab. Reads the published
 * solder points (see solderViz) and draws:
 *   - a BOARD SLAB sized to the points' bounding box (a green FR-4 look), its top
 *     face at Z=0 (the work surface the machine is zeroed to);
 *   - a copper PAD at every point (a thin disc), or a drilled HOLE (a dark
 *     ring/bore) when the points came from a drill file;
 *   - a HIGHLIGHT cone hovering at the SELECTED point's Free-Z, with a guide line
 *     down to the pad, so clicking a table row shows that point in 3D space.
 *
 * Pure presentation — no machine state, no program parsing. It complements (does
 * not replace) the generic streamed toolpath: the toolpath shows the travel,
 * this shows the board the points live on. Theme-aware colours.
 */

export interface SolderSceneProps {
  dark: boolean
}

export function SolderScene({ dark }: SolderSceneProps) {
  const points = useSolderViz((s) => s.points)
  const selected = useSolderViz((s) => s.selected)
  const hovered = useSolderViz((s) => s.hovered)
  // Effective highlight: a row HOVER previews its point; otherwise the pinned
  // (clicked) `selected` shows. So hovering the soldering table lights up the
  // matching pad in 3D, and clicking pins it even after the cursor leaves.
  const highlight = hovered >= 0 ? hovered : selected
  const activeIndex = useSolderViz((s) => s.activeIndex)
  const setActiveIndex = useSolderViz((s) => s.setActiveIndex)
  const fromDrill = useSolderViz((s) => s.fromDrill)
  const detected = useSolderViz((s) => s.detected)
  // Display toggle (from the Visualizer's ⋯ menu): when OFF, the FR-4/copper board
  // slab is hidden but the PADS/points (and highlights) below still render.
  const showPcb = useSolderViz((s) => s.showPcb)

  const reduceMotion = useMemo(() => prefersReducedMotion(), [])
  // The soldering section's placement (the gizmo edits it). We apply the SAME
  // transform to the board so it tracks the toolpath when the job is moved /
  // rotated / scaled. (Updates on gizmo release — the live drag previews the
  // toolpath, then both snap to the committed placement.)
  // NB: sections are keyed by a generated `id`; their `name` is 'soldering' (the
  // setProgram name). Match on NAME — matching `id` never hit, so the board never
  // picked up the gizmo's placement.
  const placement = useProgram((s) => s.sections.find((x) => x.name === 'soldering')?.placement)

  // Brighter, more saturated FR-4 + copper so the board reads well on the dark
  // viewport (the previous near-black green vanished in dark mode).
  const boardColor = dark ? '#1f9d57' : '#15803d' // soldermask green (top)
  const boardEmissive = '#0a3a22'
  const fr4Color = dark ? '#7a6a36' : '#b89a56' // FR-4 substrate / edge rim
  const padColor = dark ? '#ffd98a' : '#c8951a' // tinned copper
  const padEmissive = dark ? '#3a2c0a' : '#000000'
  const holeColor = dark ? '#0a0d11' : '#11161c' // plated-through bore
  const hiColor = dark ? '#34e3f5' : '#0891b2'
  const lineColor = dark ? '#34e3f5' : '#0891b2'

  // Board extents from the point cloud (padded). Memoized on the points.
  const board = useMemo(() => {
    if (points.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    const spanX = Math.max(maxX - minX, 1)
    const spanY = Math.max(maxY - minY, 1)
    // Pad the board out around the points (a real board has margin around pads).
    const pad = Math.max(spanX, spanY) * 0.08 + 2
    const w = maxX - minX + pad * 2
    const h = maxY - minY + pad * 2
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    // Pad/hole radius scaled to the board so it reads at any board size.
    const feat = Math.min(Math.max(Math.min(spanX, spanY) * 0.02, 0.6), 2.2)
    const thick = Math.max(Math.min(w, h) * 0.03, 1.2)
    return { w, h, cx, cy, feat, thick }
  }, [points])

  // The placement transform applied about the points' XY centre (Z pivot at the
  // work surface = 0), EXACTLY mirroring applyJobPlacement so the board lands
  // where the placed toolpath does. Null when there's no (non-identity) placement.
  const placeMatrix = useMemo(() => {
    if (!board || !placement || isIdentityJob(placement as JobPlacement)) return null
    const { cx, cy } = board
    const p = placement as JobPlacement
    const clampS = (s: number) =>
      !Number.isFinite(s) || s === 0 ? 1 : Math.abs(s) < 0.01 ? (s < 0 ? -0.01 : 0.01) : s
    return new THREE.Matrix4()
      .makeTranslation(cx + p.dx, cy + p.dy, p.dz)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(p.qx, p.qy, p.qz, p.qw)))
      .multiply(new THREE.Matrix4().makeScale(clampS(p.sx), clampS(p.sy), clampS(p.sz)))
      .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, 0))
  }, [board, placement])

  // ── Active-point tracking: shimmer whatever point the machine is doing NOW ──
  // Each frame, derive the live tool XY (sim playhead while playing, else the
  // live machine work-position while a real stream runs) and shimmer the NEAREST
  // solder point within a small XY radius — so the highlight naturally advances
  // point-to-point as the program executes. Read imperatively via getState() so
  // this never re-renders at 60fps; the chosen index is pushed to the store
  // (cheap no-op when unchanged) and consumed by the shimmer mesh + the panel.
  const tmpXY = useRef({ x: 0, y: 0 })
  useFrame(() => {
    const pts = useSolderViz.getState().points
    if (pts.length === 0) {
      setActiveIndex(-1)
      return
    }
    // 1) Where is the tool right now?
    const pb = usePlayback.getState()
    let x: number | null = null
    let y: number | null = null
    if (pb.isPlaying && pb.timeline && pb.timeline.duration > 0) {
      const pos = pb.timeline.positionAt(pb.time)
      x = pos[0]
      y = pos[1]
    } else {
      const m = useMachine.getState()
      const prog = useProgram.getState()
      if (m.connection === 'connected' && prog.streaming) {
        x = m.wpos.x
        y = m.wpos.y
      }
    }
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
      setActiveIndex(-1)
      return
    }
    // 2) Nearest point within a small XY radius (so "between pads" shimmers none).
    //    Radius scales with the feature size, with a sane floor for tiny boards.
    const r = Math.max(board ? board.feat * 2.5 : 2, 2)
    const r2 = r * r
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - x
      const dy = pts[i].y - y
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    tmpXY.current.x = x
    tmpXY.current.y = y
    setActiveIndex(best >= 0 && bestD <= r2 ? best : -1)
  })

  const transformRef = useRef<THREE.Group>(null)
  useLayoutEffect(() => {
    const g = transformRef.current
    if (!g) return
    if (placeMatrix) {
      g.matrixAutoUpdate = false
      g.matrix.copy(placeMatrix)
    } else {
      g.matrixAutoUpdate = true
      g.position.set(0, 0, 0)
      g.quaternion.identity()
      g.scale.set(1, 1, 1)
    }
    g.matrixWorldNeedsUpdate = true
  }, [placeMatrix])

  // Camera-detected candidate pads: faint ＋ ring markers on the bed (z just above
  // the surface) so the operator sees where the vision detector found pads BEFORE
  // adding them as real solder points. Drawn OUTSIDE the placement group (they are
  // raw bed-mm detections, not part of the placed job) and shown even when there
  // are no solder points yet. Z comes from the Z-datum, so these sit at the work
  // surface (≈0).
  const detColor = dark ? '#a78bfa' : '#7c3aed' // violet — distinct from copper/cyan
  const detMarkers =
    detected.length > 0 ? (
      <group>
        {detected.map((d, i) => {
          const r = d.rMm > 0.05 ? Math.min(Math.max(d.rMm, 0.5), 4) : 1
          return (
            <group key={`det-${i}`} position={[d.x, d.y, 0.12]}>
              {/* Ring around the detected pad. */}
              <mesh rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[r, r * 0.16, 8, 24]} />
                <meshStandardMaterial color={detColor} emissive={detColor} emissiveIntensity={0.5} />
              </mesh>
              {/* A small ＋ cross at the centre (two thin bars). */}
              <mesh>
                <boxGeometry args={[r * 1.5, r * 0.22, 0.05]} />
                <meshStandardMaterial color={detColor} emissive={detColor} emissiveIntensity={0.6} />
              </mesh>
              <mesh>
                <boxGeometry args={[r * 0.22, r * 1.5, 0.05]} />
                <meshStandardMaterial color={detColor} emissive={detColor} emissiveIntensity={0.6} />
              </mesh>
            </group>
          )
        })}
      </group>
    ) : null

  if (!board || points.length === 0) return detMarkers

  const sel = highlight >= 0 && highlight < points.length ? points[highlight] : null
  // The point the machine is currently executing — shimmered (animated pulse),
  // visually distinct from the static cyan click-selected highlight above.
  const act = activeIndex >= 0 && activeIndex < points.length ? points[activeIndex] : null

  return (
    <>
      {detMarkers}
    <group ref={transformRef}>
      {/* ---- Board: an FR-4 substrate (slightly larger → a thin tan edge rim)
          with a green soldermask layer on top whose face sits at Z=0 (the work
          surface). The two tones + rim give the slab real PCB depth. Gated by the
          `showPcb` display toggle — when off, only the board hides; pads stay. ---- */}
      {showPcb && (
        <>
          <mesh position={[board.cx, board.cy, -0.05 - board.thick / 2]}>
            <boxGeometry args={[board.w + 1.4, board.h + 1.4, board.thick]} />
            <meshStandardMaterial color={fr4Color} metalness={0.1} roughness={0.9} />
          </mesh>
          <mesh position={[board.cx, board.cy, -board.thick * 0.25]}>
            <boxGeometry args={[board.w, board.h, board.thick * 0.5]} />
            <meshStandardMaterial
              color={boardColor}
              emissive={boardEmissive}
              emissiveIntensity={0.4}
              metalness={0.15}
              roughness={0.55}
            />
          </mesh>
        </>
      )}

      {/* ---- Pads (surface discs) or drilled holes at every point. ---- */}
      {points.map((p, i) => {
        const isSel = i === highlight
        if (fromDrill) {
          // A dark plated bore through the board + a shiny copper annular ring.
          return (
            <group key={i} position={[p.x, p.y, 0]}>
              <mesh position={[0, 0, -board.thick / 2]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry
                  args={[board.feat * 0.55, board.feat * 0.55, board.thick * 1.06, 18]}
                />
                <meshStandardMaterial color={holeColor} metalness={0.3} roughness={0.85} />
              </mesh>
              <mesh position={[0, 0, 0.03]} rotation={[Math.PI / 2, 0, 0]}>
                <torusGeometry args={[board.feat * 0.85, board.feat * 0.3, 10, 24]} />
                <meshStandardMaterial
                  color={isSel ? hiColor : padColor}
                  emissive={isSel ? hiColor : padEmissive}
                  emissiveIntensity={isSel ? 0.5 : 0.25}
                  metalness={0.85}
                  roughness={0.22}
                />
              </mesh>
            </group>
          )
        }
        // Surface pad: a shiny tinned disc with a tiny domed cap, on the board top.
        return (
          <group key={i} position={[p.x, p.y, 0.06]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[board.feat, board.feat, 0.14, 20]} />
              <meshStandardMaterial
                color={isSel ? hiColor : padColor}
                emissive={isSel ? hiColor : padEmissive}
                emissiveIntensity={isSel ? 0.5 : 0.25}
                metalness={0.85}
                roughness={0.22}
              />
            </mesh>
            <mesh position={[0, 0, 0.07]}>
              <sphereGeometry args={[board.feat * 0.92, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
              <meshStandardMaterial
                color={isSel ? hiColor : padColor}
                emissive={isSel ? hiColor : padEmissive}
                emissiveIntensity={isSel ? 0.4 : 0.2}
                metalness={0.9}
                roughness={0.18}
              />
            </mesh>
          </group>
        )
      })}

      {/* ---- Highlight the SELECTED point: a cone hovering at its Free-Z with a
          guide line down to the pad, so the operator sees exactly where it is. ---- */}
      {sel && (
        <group>
          <mesh position={[sel.x, sel.y, sel.freeZ]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[board.feat * 1.6, board.feat * 3.2, 24]} />
            <meshStandardMaterial
              color={hiColor}
              emissive={hiColor}
              emissiveIntensity={0.5}
              metalness={0.3}
              roughness={0.35}
            />
          </mesh>
          <Line
            points={[
              [sel.x, sel.y, sel.freeZ],
              [sel.x, sel.y, Math.min(0, sel.touchZ)],
            ]}
            color={lineColor}
            lineWidth={2}
          />
          {/* A ring on the board around the selected pad for extra legibility. */}
          <mesh position={[sel.x, sel.y, 0.06]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[board.feat * 2, board.feat * 0.18, 8, 28]} />
            <meshStandardMaterial color={hiColor} emissive={hiColor} emissiveIntensity={0.4} />
          </mesh>
        </group>
      )}

      {/* ---- SHIMMER the point the machine is CURRENTLY executing: a warm-amber
          pulsing ring + glow disc on the pad that animates (or static-bright when
          reduced motion), advancing point-to-point as the sim/stream runs. A warm
          colour keeps it distinct from the cyan click-selected highlight, and it
          can show on the SAME pad as a selection (both read independently). ---- */}
      {act && (
        <SolderShimmer
          key={`shim-${activeIndex}`}
          x={act.x}
          y={act.y}
          freeZ={act.freeZ}
          touchZ={act.touchZ}
          feat={board.feat}
          dark={dark}
          reduceMotion={reduceMotion}
        />
      )}
    </group>
    </>
  )
}

/**
 * The shimmering "currently-executing" marker: a warm-amber ring + glow disc on
 * the active pad and a small hovering bead at its Free-Z. While motion is allowed
 * it PULSES (emissive + scale, via useFrame, mutating material/transform refs so
 * the 60fps animation never re-renders React); under reduced-motion it renders a
 * steady bright emphasis instead. Amber keeps it distinct from the cyan static
 * click-selected highlight. Remounted per active index (the `key`), so each new
 * point starts its pulse cleanly.
 */
function SolderShimmer(props: {
  x: number
  y: number
  freeZ: number
  touchZ: number
  feat: number
  dark: boolean
  reduceMotion: boolean
}) {
  const { x, y, freeZ, touchZ, feat, dark, reduceMotion } = props
  const color = dark ? '#ffb454' : '#ea7a17' // warm amber — distinct from cyan
  const ringRef = useRef<THREE.Group>(null)
  const ringMat = useRef<THREE.MeshStandardMaterial>(null)
  const discMat = useRef<THREE.MeshStandardMaterial>(null)
  const beadMat = useRef<THREE.MeshStandardMaterial>(null)

  useFrame((state) => {
    if (reduceMotion) return
    // 0..1 pulse; drive ring scale + emissive so it visibly "breathes".
    const p = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 4.5)
    if (ringRef.current) {
      const s = 1 + 0.35 * p
      ringRef.current.scale.set(s, s, 1)
    }
    if (ringMat.current) ringMat.current.emissiveIntensity = 0.45 + 0.85 * p
    if (discMat.current) {
      discMat.current.emissiveIntensity = 0.3 + 0.6 * p
      discMat.current.opacity = 0.35 + 0.4 * p
    }
    if (beadMat.current) beadMat.current.emissiveIntensity = 0.4 + 0.8 * p
  })

  // Reduced-motion: steady bright values baked into the initial material props.
  const baseI = reduceMotion ? 0.9 : 0.45
  const discI = reduceMotion ? 0.7 : 0.3
  const discO = reduceMotion ? 0.6 : 0.4

  return (
    <group>
      {/* Pulsing ring on the pad (scaled by the group ref). */}
      <group ref={ringRef} position={[x, y, 0.08]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[feat * 1.8, feat * 0.22, 10, 32]} />
          <meshStandardMaterial ref={ringMat} color={color} emissive={color} emissiveIntensity={baseI} />
        </mesh>
      </group>
      {/* Soft glow disc under the ring. */}
      <mesh position={[x, y, 0.07]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[feat * 1.5, 32]} />
        <meshStandardMaterial
          ref={discMat}
          color={color}
          emissive={color}
          emissiveIntensity={discI}
          transparent
          opacity={discO}
          depthWrite={false}
        />
      </mesh>
      {/* A bead hovering at Free-Z with a guide line down to the pad. */}
      <mesh position={[x, y, freeZ]}>
        <sphereGeometry args={[feat * 0.7, 16, 12]} />
        <meshStandardMaterial ref={beadMat} color={color} emissive={color} emissiveIntensity={baseI} />
      </mesh>
      <Line
        points={[
          [x, y, freeZ],
          [x, y, Math.min(0, touchZ)],
        ]}
        color={color}
        lineWidth={2}
        dashed
        dashSize={0.6}
        gapSize={0.4}
      />
    </group>
  )
}
