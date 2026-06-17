import { useMemo } from 'react'
import { Line, Text, Billboard, Tube } from '@react-three/drei'
import * as THREE from 'three'
import { useSpringViz } from '../store/springViz'
import { springHelixPoints } from '../core/springCoiling'
import { useT } from '../i18n'

/**
 * Spring-coiling 3D scene: visualizes the 2-AXIS MACHINE (a rotary chuck winding
 * wire on a mandrel + a synced linear carriage that sets the pitch) — NOT a 3-axis
 * head tracing a helix. It draws:
 *   - the COIL/SPRING as the workpiece forming on the mandrel: a tube along +X,
 *     circle in the Y–Z plane, radius = coilDiameter/2, lifted to rest on the bed.
 *     Computed from the spring PARAMS (`springHelixPoints`), not from a program.
 *   - the spinning CHUCK / mandrel at the start (left) end — spins about +X.
 *   - the CARRIAGE / wire-guide that moves ONLY along +X (the linear axis) to the
 *     current wind point. It never moves in Y/Z.
 *   - the spring dimension annotations (wire ⌀, coil ⌀, pitch, free length, turns).
 *
 * Animation: the Viewer passes `simPosition`; for the 2-axis program the playhead's
 * X = the linear carriage position. simPosition[0] (clamped 0..freeLength) (a)
 * slides the carriage along X, (b) spins the chuck (angle = carriageX / pitch ×
 * 360°), and (c) progressively REVEALS the coil only up to the carriage X (the
 * spring visibly "grows" as it is wound). When not simulating, the full finished
 * coil is shown with the carriage + chuck at the start.
 *
 * Pure presentation — reads the spring dimensions from the `springViz` store
 * (published by the panel). Theme-aware colours mirror Dimensions.tsx. Every drei
 * <Line> is guarded so it only renders with ≥2 points (an empty points array
 * crashed a previous version → Float32Array(-6)).
 */

export interface SpringSceneProps {
  dark: boolean
  /**
   * Simulation tool position [x, y, z] (mm) from the playback timeline, used to
   * spin the chuck about X and slide the carriage along X with the playhead. Null
   * when not simulating → chuck/carriage sit at the start (static).
   */
  simPosition?: [number, number, number] | null
}

type V3 = [number, number, number]

/** Format a length in mm with at most 2 decimals, trimming trailing zeros. */
function fmtMm(v: number): string {
  return `${(Math.round(v * 100) / 100).toString()} mm`
}

export function SpringScene({ dark, simPosition }: SpringSceneProps) {
  const params = useSpringViz((s) => s.params)
  const t = useT()

  const lineColor = dark ? '#9fb3c8' : '#475569'
  const textColor = dark ? '#e2e8f0' : '#1e293b'
  const textOutline = dark ? '#15181c' : '#e7ecf1'
  const accent = dark ? '#5eead4' : '#0e7c66'
  const chuckColor = dark ? '#3b4250' : '#94a3b8'
  const platformColor = dark ? '#475569' : '#cbd5e1'
  // The wire-feed nozzle uses the bright "sim tool" cyan so it reads as the live
  // working point (it replaces the generic sim-tool cone that is hidden for springs).
  const feedColor = dark ? '#22d3ee' : '#0891b2'

  const geom = useMemo(() => (params ? buildSpringDims(params, t) : null), [params, t])

  const L = Math.max(0, params?.freeLength ?? 0)

  // Carriage X from the playhead (its X tracks the axial/carriage advance), clamped
  // to the spring length. When NOT simulating the carriage sits at the start and
  // the whole finished coil is shown.
  const simulating = !!(simPosition && Number.isFinite(simPosition[0]))
  // The carriage sits at the live wind point while simulating, and at the FAR end
  // (X=L) on a finished spring — that's where the coiler actually leaves it.
  const carriageX = simulating
    ? Math.min(L, Math.max(0, (simPosition as [number, number, number])[0]))
    : L
  // Reveal the coil up to the carriage (the spring "grows" as it is wound); on a
  // finished part carriageX = L so the whole coil shows.
  const revealX = carriageX

  // The wound coil's helix centre-line points (the workpiece), computed from the
  // spring PARAMS — the SAME coordinated rotary+linear motion the 2-axis machine
  // program emits. Spring axis +X, circle in Y–Z, lifted to rest on the bed.
  const coilPoints = useMemo<[number, number, number][]>(
    () =>
      params
        ? springHelixPoints({
            wireDiameter: params.wireDiameter,
            coilDiameter: params.coilDiameter,
            // The panel publishes the effective body pitch + total turns, which is
            // all the helix needs (closing turns are already folded into freeLength).
            // Use a single body span at the published pitch so the visualized axial
            // advance matches freeLength.
            bodyTurns: params.totalTurns,
            pitch: params.pitch,
            springType: 'compression',
            closeTurnsStart: 0,
            closeTurnsEnd: 0,
            segmentsPerRev: 48,
          })
        : [],
    [params],
  )

  // Reveal the coil curve up to revealX: keep every point whose X ≤ revealX, plus
  // one boundary point interpolated exactly at revealX so the tube ends at the
  // carriage. A THREE.CatmullRomCurve3 needs ≥2 points; otherwise we draw nothing.
  const revealed = useMemo(() => {
    if (coilPoints.length < 2) return { curve: null, lead: null }
    const kept: THREE.Vector3[] = []
    for (let i = 0; i < coilPoints.length; i++) {
      const p = coilPoints[i]
      if (p[0] <= revealX + 1e-9) {
        kept.push(new THREE.Vector3(p[0], p[1], p[2]))
      } else {
        // Interpolate the crossing point so the tube stops exactly at the carriage.
        const prev = coilPoints[i - 1]
        if (prev) {
          const span = p[0] - prev[0]
          const tt = span > 1e-9 ? (revealX - prev[0]) / span : 0
          kept.push(
            new THREE.Vector3(
              prev[0] + (p[0] - prev[0]) * tt,
              prev[1] + (p[1] - prev[1]) * tt,
              prev[2] + (p[2] - prev[2]) * tt,
            ),
          )
        }
        break
      }
    }
    if (kept.length < 2) return { curve: null, lead: null }
    return {
      curve: new THREE.CatmullRomCurve3(kept, false, 'catmullrom', 0),
      lead: kept[kept.length - 1],
    }
  }, [coilPoints, revealX])
  const revealedCurve = revealed.curve
  const leadPoint = revealed.lead

  if (!params || !geom) return null

  const R = params.coilDiameter / 2
  // Wire half-thickness: kept visible even for very thin wire, and CAPPED at a
  // fraction of the coil radius so an (unphysical) thick-wire / small-coil combo
  // can't render the tube as a solid blob that swallows the coil and shaft.
  const wr = Math.min(Math.max(params.wireDiameter / 2, R * 0.02, 0.15), R * 0.42)
  const wireColor = dark ? '#cbd5e1' : '#52606d'
  // Which side of the shaft the wire feeds onto: a right-hand ('cw') coil winds
  // over the TOP of the mandrel, a left-hand ('ccw') coil under the BOTTOM. The
  // feed nozzle sits on that side at the current wind point and rides the carriage.
  const feedTop = (params.direction ?? 'cw') === 'cw'
  const feedSide = feedTop ? 1 : -1 // +Z (top) or −Z (bottom), in carriage-local space
  // The fixed feed angle on the coil circle MUST equal the nozzle's position so
  // the rotated coil's leading end lands exactly at the cone. The nozzle sits on
  // the FRONT (−Y) of the coil, UPPER (+Z) quadrant for a right-hand coil / LOWER
  // (−Z) for a left-hand coil → θ = 135° (cw) or −135° (ccw), since the surface
  // point is [x, R·cosθ, R + R·sinθ] and front-upper = (−0.707, +0.707).
  const phiNozzle = feedTop ? (3 * Math.PI) / 4 : -((3 * Math.PI) / 4)
  // RIGID rotation of the wound coil (and the chuck gripping its start) about the
  // mandrel axis so the coil's LEADING end always meets the fixed feed nozzle: as
  // winding advances the whole assembly visibly spins while new wire is laid at the
  // nozzle on the moving carriage — the real coiling motion. Only while simulating;
  // a finished part is shown unrotated.
  let coilRotation = 0
  if (simulating && leadPoint) {
    const thetaLead = Math.atan2(leadPoint.z - R, leadPoint.y)
    coilRotation = phiNozzle - thetaLead
  }

  return (
    <group>
      {/* ---- The wound COIL (workpiece) as a tube along the mandrel. Rotates
          rigidly about the axis (z=R) with the chuck while winding. ---- */}
      {revealedCurve && (
        <group position={[0, 0, R]} rotation={[coilRotation, 0, 0]}>
          <group position={[0, 0, -R]}>
            <Tube args={[revealedCurve, Math.max(96, coilPoints.length), wr, 12, false]}>
              <meshStandardMaterial color={wireColor} metalness={0.6} roughness={0.35} />
            </Tube>
          </group>
        </group>
      )}

      {/* ---- Dimension annotations (wire ⌀, coil ⌀, pitch, free length, turns) ---- */}
      {geom.dims.map((d) => (
        <group key={d.key}>
          {d.extensions.map((seg, i) => (
            <Line
              key={`${d.key}-ext-${i}`}
              points={seg}
              color={lineColor}
              lineWidth={1}
              transparent
              opacity={0.7}
              depthTest={false}
            />
          ))}
          {d.dimLine.length >= 2 && (
            <Line points={d.dimLine} color={lineColor} lineWidth={1.5} depthTest={false} />
          )}
          {d.arrows.map((tri, i) => (
            <Line
              key={`${d.key}-arr-${i}`}
              points={tri}
              color={lineColor}
              lineWidth={1.5}
              depthTest={false}
            />
          ))}
          <Billboard position={d.labelPos}>
            <Text
              fontSize={d.fontSize}
              color={textColor}
              anchorX="center"
              anchorY="middle"
              outlineWidth={d.fontSize * 0.08}
              outlineColor={textOutline}
              depthOffset={-4}
            >
              {d.label}
            </Text>
          </Billboard>
        </group>
      ))}

      {/* ---- Per-turn ticks: a small radial tick at the top of each whole turn ---- */}
      {geom.turnTicks.map((tk, i) => (
        <Line
          key={`tick-${i}`}
          points={tk}
          color={accent}
          lineWidth={1}
          transparent
          opacity={0.55}
          depthTest={false}
        />
      ))}

      {/* ---- Chuck + mandrel at the START end (just left of X=0). Rotates as one
          rigid assembly with the coil (same axis z=R) so the START end visibly
          spins as the spring is wound — the chuck grips and turns the work. ---- */}
      <group position={[0, 0, R]} rotation={[coilRotation, 0, 0]}>
        <group position={[0, 0, -R]}>
          <group position={[-(geom.chuckLen + R * 0.15), 0, R]}>
            {/* Drive body, axis along +X (cylinder default axis is Y → rotate −90° about Z). */}
            <mesh rotation={[0, 0, -Math.PI / 2]}>
              <cylinderGeometry args={[geom.chuckR, geom.chuckR, geom.chuckLen, 28]} />
              <meshStandardMaterial color={chuckColor} metalness={0.45} roughness={0.55} />
            </mesh>
            {/* A back plate so the chuck reads as a solid head. */}
            <mesh position={[-geom.chuckLen * 0.5, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
              <cylinderGeometry args={[geom.chuckR * 1.15, geom.chuckR * 1.15, geom.chuckLen * 0.22, 28]} />
              <meshStandardMaterial color={chuckColor} metalness={0.5} roughness={0.5} />
            </mesh>
            {/* Three jaws gripping the work — fixed in the assembly; the group spins them. */}
            {[0, 1, 2].map((j) => {
              const a = (j * 2 * Math.PI) / 3
              return (
                <mesh
                  key={j}
                  position={[geom.chuckLen * 0.1, geom.chuckR * Math.cos(a), geom.chuckR * Math.sin(a)]}
                  rotation={[a, 0, -Math.PI / 2]}
                >
                  <boxGeometry args={[geom.chuckLen * 0.95, geom.chuckR * 0.2, geom.chuckR * 0.42]} />
                  <meshStandardMaterial color={accent} metalness={0.35} roughness={0.45} />
                </mesh>
              )
            })}
          </group>
          {/* Mandrel shaft running through the coil. */}
          <mesh position={[L / 2, 0, R]} rotation={[0, 0, -Math.PI / 2]}>
            <cylinderGeometry args={[geom.mandrelR, geom.mandrelR, Math.max(L, R) * 1.02, 20]} />
            <meshStandardMaterial color={chuckColor} metalness={0.3} roughness={0.7} />
          </mesh>
        </group>
      </group>

      {/* ---- Carriage / platform + wire-feed nozzle, sliding along +X ----
          Carriage-local frame (group at world [carriageX, 0, R]): the coil centre
          is the origin, the bed is at z=−R, the coil surface is radius R in Y–Z.
          The nozzle sits on the FRONT (−Y) of the coil, in the UPPER quadrant for a
          right-hand (cw) coil or the LOWER quadrant for a left-hand (ccw) coil, and
          rides the carriage along X — marking exactly where the wire feeds onto the
          mandrel as the spring is wound. */}
      <group position={[carriageX, 0, R]}>
      {(() => {
        // Feed RADIAL unit (coil-centre → contact) in the Y–Z plane — the SAME
        // direction `phiNozzle` uses, so the cone sits exactly where the rotated
        // coil's leading end lands. Front (−Y) + upper (+Z) for cw / lower (−Z) ccw.
        const k = 0.7071
        const dirY = -k
        const dirZ = feedSide * k
        // Nozzle sized to the COIL (not the wire) so a thick wire can't blow it up.
        const nozH = Math.max(R * 0.8, 1.5)
        const nozR = Math.max(R * 0.22, 0.5)
        // Contact on the coil surface and the cone centre just outside it (local
        // frame: coil centre at origin, surface point = R·(dirY,dirZ)).
        const contactY = R * dirY
        const contactZ = R * dirZ
        const nzY = (R + nozH * 0.55) * dirY
        const nzZ = (R + nozH * 0.55) * dirZ
        // Cone apex (+Y) aimed inward along −radial (single X-rotation).
        const aim = Math.atan2(-dirZ, -dirY)
        // The carriage rides in FRONT of the spring (−Y), clear of the coil
        // (radius R) and the mandrel, with a column up to the wire guide — so it
        // never overlaps the coil or shaft at any coil/wire diameter.
        const baseY = -(R + Math.max(R * 0.9, nozR + R * 0.6))
        const colTopZ = nzZ
        const colCenterZ = (colTopZ - R) / 2
        const colH = Math.max(Math.abs(colTopZ + R), R * 0.5)
        return (
          <group>
            {/* Base plate on the bed, in FRONT of the spring. */}
            <mesh position={[0, baseY, -R + R * 0.18]}>
              <boxGeometry args={[R * 0.95, R * 0.95, R * 0.36]} />
              <meshStandardMaterial color={platformColor} metalness={0.2} roughness={0.8} />
            </mesh>
            {/* Column rising from the base to the wire-guide height. */}
            <mesh position={[0, baseY, colCenterZ]}>
              <boxGeometry args={[R * 0.28, R * 0.28, colH]} />
              <meshStandardMaterial color={platformColor} metalness={0.2} roughness={0.8} />
            </mesh>
            {/* Horizontal arm reaching from the column in to the nozzle. */}
            <mesh position={[0, (baseY + nzY) / 2, nzZ]}>
              <boxGeometry args={[R * 0.22, Math.max(Math.abs(nzY - baseY), 0.1), R * 0.22]} />
              <meshStandardMaterial color={platformColor} metalness={0.2} roughness={0.8} />
            </mesh>
            {/* The bright wire-feed nozzle (the live working-point indicator). */}
            <mesh position={[0, nzY, nzZ]} rotation={[aim, 0, 0]}>
              <coneGeometry args={[nozR, nozH, 22]} />
              <meshStandardMaterial
                color={feedColor}
                emissive={feedColor}
                emissiveIntensity={0.5}
                metalness={0.3}
                roughness={0.35}
              />
            </mesh>
            {/* The wire strand from the nozzle to the exact coil contact point. */}
            <Line
              points={[
                [0, nzY, nzZ],
                [0, contactY, contactZ],
              ]}
              color={feedColor}
              lineWidth={2}
            />
          </group>
        )
      })()}
      </group>
    </group>
  )
}

interface DimSpec {
  key: string
  label: string
  extensions: V3[][]
  dimLine: V3[]
  arrows: V3[][]
  labelPos: V3
  fontSize: number
}

interface SpringGeom {
  dims: DimSpec[]
  turnTicks: V3[][]
  chuckLen: number
  chuckR: number
  mandrelR: number
}

/**
 * Build the spring dimension geometry in the helix world frame (axis +X, coil
 * circle in Y–Z, lifted so the coil centre is at Z=R):
 *   - free length  → along +X, in front of the coil (−Y), at bed level.
 *   - coil ⌀       → vertical (Z) at the start face, off the −Y side.
 *   - wire ⌀       → a short vertical caliper at the coil top, near the start.
 *   - pitch        → along +X across one body gap, above the coil.
 *   - turn count   → a billboard label above the coil mid-span, plus per-turn ticks.
 */
function buildSpringDims(p: {
  wireDiameter: number
  coilDiameter: number
  pitch: number
  freeLength: number
  totalTurns: number
}, t: (key: string, en: string) => string): SpringGeom | null {
  const R = p.coilDiameter / 2
  const L = Math.max(0, p.freeLength)
  if (!(R > 1e-6)) return null

  const span = Math.max(L, p.coilDiameter, 1)
  const off = Math.max(span * 0.08, 4)
  const ext = off * 0.35
  const ah = Math.max(span * 0.025, 1.2)
  const fontSize = Math.max(span * 0.045, 2.5)
  const lift = fontSize * 0.8
  const zc = R // coil centre line height

  const dims: DimSpec[] = []

  // ---- Free length: along +X, in front of the coil (−Y side), at bed level. ----
  if (L > 1e-6) {
    const yd = -R - off
    dims.push({
      key: 'free',
      label: `${t('spring.dim.freeL', 'free L')} ${fmtMm(L)}`,
      extensions: [
        [[0, -R, 0], [0, yd - ext, 0]],
        [[L, -R, 0], [L, yd - ext, 0]],
      ],
      dimLine: [[0, yd, 0], [L, yd, 0]],
      arrows: [
        chevron([0, yd, 0], [1, 0, 0], [0, 1, 0], ah),
        chevron([L, yd, 0], [-1, 0, 0], [0, 1, 0], ah),
      ],
      labelPos: [L / 2, yd - lift, 0],
      fontSize,
    })
  }

  // ---- Coil ⌀: vertical (Z) caliper at the start face, off the −Y side. ----
  {
    const yd = -R - off * 1.7
    dims.push({
      key: 'coil',
      label: `${t('spring.dim.coilDia', 'coil ⌀')} ${fmtMm(p.coilDiameter)}`,
      extensions: [
        [[0, yd + ext, 0], [0, yd, 0]],
        [[0, yd + ext, zc * 2], [0, yd, zc * 2]],
      ],
      dimLine: [[0, yd, 0], [0, yd, zc * 2]],
      arrows: [
        chevron([0, yd, 0], [0, 0, 1], [0, 1, 0], ah),
        chevron([0, yd, zc * 2], [0, 0, -1], [0, 1, 0], ah),
      ],
      labelPos: [0, yd - lift, zc],
      fontSize,
    })
  }

  // ---- Wire ⌀: a short vertical caliper at the coil top near the start. ----
  {
    const wr = Math.max(p.wireDiameter / 2, R * 0.02, 0.15)
    const xw = Math.min(L, R * 0.3) + R * 0.1
    const zTop = zc * 2
    dims.push({
      key: 'wire',
      label: `${t('spring.dim.wireDia', 'wire ⌀')} ${fmtMm(p.wireDiameter)}`,
      extensions: [
        [[xw, R, zTop - wr], [xw, R + off * 0.6, zTop - wr]],
        [[xw, R, zTop + wr], [xw, R + off * 0.6, zTop + wr]],
      ],
      dimLine: [[xw, R + off * 0.5, zTop - wr], [xw, R + off * 0.5, zTop + wr]],
      arrows: [
        chevron([xw, R + off * 0.5, zTop - wr], [0, 0, 1], [0, 1, 0], ah * 0.8),
        chevron([xw, R + off * 0.5, zTop + wr], [0, 0, -1], [0, 1, 0], ah * 0.8),
      ],
      labelPos: [xw, R + off * 0.5 + lift * 1.2, zTop],
      fontSize: fontSize * 0.85,
    })
  }

  // ---- Pitch: along +X across one body gap, above the coil (+Z side). ----
  if (p.pitch > 1e-6 && L > p.pitch && p.totalTurns >= 2) {
    // Place across a gap roughly in the middle of the spring.
    const x0 = Math.min(L - p.pitch, Math.max(0, L / 2 - p.pitch / 2))
    const x1 = x0 + p.pitch
    const zd = zc * 2 + off * 0.9
    dims.push({
      key: 'pitch',
      label: `${t('spring.dim.pitch', 'pitch')} ${fmtMm(p.pitch)}`,
      extensions: [
        [[x0, 0, zc * 2], [x0, 0, zd + ext]],
        [[x1, 0, zc * 2], [x1, 0, zd + ext]],
      ],
      dimLine: [[x0, 0, zd], [x1, 0, zd]],
      arrows: [
        chevron([x0, 0, zd], [1, 0, 0], [0, 0, 1], ah),
        chevron([x1, 0, zd], [-1, 0, 0], [0, 0, 1], ah),
      ],
      labelPos: [(x0 + x1) / 2, 0, zd + lift],
      fontSize,
    })
  }

  // ---- Turn count: a billboard label above the coil mid-span. ----
  dims.push({
    key: 'turns',
    label: `${(Math.round(p.totalTurns * 100) / 100).toString()} ${t('spring.dim.turns', 'turns')}`,
    extensions: [],
    dimLine: [],
    arrows: [],
    labelPos: [L / 2, 0, zc * 2 + off * 1.9],
    fontSize: fontSize * 1.05,
  })

  // ---- Per-turn ticks: a short radial tick at the top of each whole turn. ----
  const turnTicks: V3[][] = []
  if (L > 1e-6 && p.totalTurns > 0 && p.totalTurns <= 200) {
    const whole = Math.floor(p.totalTurns)
    const dx = L / p.totalTurns // axial advance per turn (average)
    for (let i = 1; i <= whole; i++) {
      const x = i * dx
      if (x > L) break
      turnTicks.push([
        [x, 0, zc * 2],
        [x, 0, zc * 2 + off * 0.4],
      ])
    }
  }

  // The mandrel/shaft the wire is wound onto sits INSIDE the coil and must touch
  // the spring's inner diameter: ID = mean coil ⌀ − wire ⌀ → inner radius = R − wr.
  // (Using the same visual wire half-thickness `wr` as the coil tube so the shaft
  // surface meets the drawn wire's inner edge exactly.)
  const wrVis = Math.max(p.wireDiameter / 2, R * 0.02, 0.15)
  const mandrelR = Math.max(R - wrVis, 0.2)
  return {
    dims,
    turnTicks,
    chuckLen: Math.max(R * 0.8, 4),
    chuckR: R * 1.15,
    mandrelR,
  }
}

/**
 * Build a small arrowhead chevron at `tip`, opening along `dir`, barbs along
 * `side` — mirrors Dimensions.tsx so the arrows look identical to the generic
 * overlay. Returns a 3-point polyline (barb → tip → barb).
 */
function chevron(tip: V3, dir: V3, side: V3, size: number): V3[] {
  const t = new THREE.Vector3(tip[0], tip[1], tip[2])
  const dv = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize()
  const sv = new THREE.Vector3(side[0], side[1], side[2]).normalize()
  const back = dv.clone().multiplyScalar(-size * 1.6)
  const half = sv.clone().multiplyScalar(size * 0.7)
  const b1 = t.clone().add(back).add(half)
  const b2 = t.clone().add(back).sub(half)
  return [
    [b1.x, b1.y, b1.z],
    [t.x, t.y, t.z],
    [b2.x, b2.y, b2.z],
  ]
}
