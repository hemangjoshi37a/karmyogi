import { useEffect, useRef } from 'react'
import { Quaternion, Vector3 } from 'three'
import { useFrame } from '@react-three/fiber'
import { cameraQuat } from './axisGizmoSync'

/**
 * Colored XYZ axis-arrow indicator, drawn as a pure SVG/DOM overlay (NOT a second
 * WebGL canvas). A separate <Canvas> here used to flicker/blank on flaky GPUs
 * (e.g. AMD Vega + Mesa) because two live WebGL contexts thrash each other and
 * drop+restore in a loop. Projecting the world axes to 2D from the shared
 * {@link cameraQuat} and drawing them with SVG removes that whole failure class:
 * there's only ONE WebGL context (the main viewer), and this overlay can never
 * lose a context because it doesn't have one. It still turns exactly with the
 * scene — a clean companion to the orientation cube, with real arrowheads and the
 * labels outside the tips.
 */

// Lives INSIDE the main Canvas: publishes the live camera orientation each frame.
export function CameraQuatReporter() {
  useFrame(({ camera }) => {
    cameraQuat.copy(camera.quaternion)
  })
  return null
}

const AXES = [
  { v: [1, 0, 0] as const, color: '#ff6b6b', label: 'X' },
  { v: [0, 1, 0] as const, color: '#51cf66', label: 'Y' },
  { v: [0, 0, 1] as const, color: '#4dabf7', label: 'Z' },
]

const R = 26 // arrow length in SVG units (viewBox is 90 units → fits with the label)

export function AxisOverlay({ theme }: { theme: string }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const outline = theme === 'dark' ? '#0b0e12' : '#e9eef3'

  useEffect(() => {
    let raf = 0
    const qInv = new Quaternion()
    const tmp = new Vector3()
    const tick = () => {
      const svg = svgRef.current
      if (svg) {
        // World axes seen on screen = transform each into VIEW space (inverse of
        // the camera orientation). View space: +X right, +Y up, camera looks −Z.
        qInv.copy(cameraQuat).invert()
        for (let i = 0; i < AXES.length; i++) {
          const g = svg.querySelector<SVGGElement>(`#axg-${i}`)
          if (!g) continue
          tmp.set(AXES[i].v[0], AXES[i].v[1], AXES[i].v[2]).applyQuaternion(qInv)
          const x = tmp.x * R
          const y = -tmp.y * R // SVG Y points down
          const len = Math.hypot(x, y) || 1e-6
          const dx = x / len
          const dy = y / len
          const px = -dy
          const py = dx
          const h = 8 // arrowhead length
          const w = 4.5 // arrowhead half-width
          const bx = x - dx * h
          const by = y - dy * h
          const line = g.querySelector('line')!
          const head = g.querySelector('polygon')!
          const text = g.querySelector('text')!
          line.setAttribute('x2', bx.toFixed(2))
          line.setAttribute('y2', by.toFixed(2))
          head.setAttribute(
            'points',
            `${x.toFixed(2)},${y.toFixed(2)} ${(bx + px * w).toFixed(2)},${(by + py * w).toFixed(2)} ${(bx - px * w).toFixed(2)},${(by - py * w).toFixed(2)}`,
          )
          text.setAttribute('x', (x * 1.32).toFixed(2))
          text.setAttribute('y', (y * 1.32).toFixed(2))
          // An axis pointing away from the viewer (toward −view-Z) is dimmed so the
          // triad reads as 3D without z-fighting.
          g.style.opacity = tmp.z > 0.25 ? '0.45' : '1'
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 10,
        top: 56,
        width: 90,
        height: 90,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <svg ref={svgRef} viewBox="-45 -45 90 90" width={90} height={90}>
        {AXES.map((a, i) => (
          <g id={`axg-${i}`} key={i}>
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={0}
              stroke={a.color}
              strokeWidth={3}
              strokeLinecap="round"
            />
            <polygon points="0,0 0,0 0,0" fill={a.color} />
            <text
              x={0}
              y={0}
              fill={a.color}
              fontSize={12}
              fontWeight={700}
              textAnchor="middle"
              dominantBaseline="central"
              stroke={outline}
              strokeWidth={0.6}
              paintOrder="stroke"
            >
              {a.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
