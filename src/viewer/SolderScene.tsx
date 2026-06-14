import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Line } from '@react-three/drei'
import { useSolderViz } from '../store/solderViz'
import { useProgram } from '../store'
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
  const fromDrill = useSolderViz((s) => s.fromDrill)
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

  if (!board || points.length === 0) return null

  const sel = selected >= 0 && selected < points.length ? points[selected] : null

  return (
    <group ref={transformRef}>
      {/* ---- Board: an FR-4 substrate (slightly larger → a thin tan edge rim)
          with a green soldermask layer on top whose face sits at Z=0 (the work
          surface). The two tones + rim give the slab real PCB depth. ---- */}
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

      {/* ---- Pads (surface discs) or drilled holes at every point. ---- */}
      {points.map((p, i) => {
        const isSel = i === selected
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
    </group>
  )
}
