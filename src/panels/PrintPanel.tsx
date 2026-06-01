import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid } from '@react-three/drei'
import * as THREE from 'three'
import { useProgram, useMachine, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import {
  parseStl,
  sliceMesh,
  sliceToGcode,
  STL_STRIDE,
  type StlMesh,
  type SliceParams,
  type GcodeParams,
} from '../core/slicer'
import '../styles/print.css'

// Build volume (mm). Matches the app's default 300×200 bed.
const BED_X = 300
const BED_Y = 200
const BED_Z = 200

interface PrintSettings {
  layerHeight: number
  nozzleTemp: number
  bedTemp: number
  printSpeed: number // mm/min
  infill: number // %
  perimeters: number
  fan: boolean
  // advanced
  filamentDiameter: number
  lineWidth: number
  travelSpeed: number // mm/min
  retractDistance: number
  retractSpeed: number // mm/min
  firstLayerTemp: number
  firstLayerSpeed: number // mm/min
  skirt: boolean
}

const DEFAULTS: PrintSettings = {
  layerHeight: 0.2,
  nozzleTemp: 210,
  bedTemp: 60,
  printSpeed: 1800,
  infill: 20,
  perimeters: 2,
  fan: true,
  filamentDiameter: 1.75,
  lineWidth: 0.4,
  travelSpeed: 6000,
  retractDistance: 1.0,
  retractSpeed: 1800,
  firstLayerTemp: 215,
  firstLayerSpeed: 900,
  skirt: true,
}

/** Object placement on the bed. */
interface Transform {
  scale: number // uniform, fraction (1 = 100%)
  rotZ: number // degrees, 90° steps
}

interface MeshInfo {
  name: string
  mesh: StlMesh
  format: string
}

const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '—')

/**
 * 3D Printing panel: import an STL, arrange it on the bed, choose FDM settings,
 * slice to G-code (basic perimeters + rectilinear infill), preview it in the
 * shared Visualizer, and stream it to a GRBL-based printer.
 *
 * Honest scope: this is a *basic* FDM slicer (planar slicing, inset perimeters,
 * alternating 0/90° rectilinear infill) for hobby GRBL printers — not a
 * production slicer (no supports, bridging, or adaptive layers).
 */
export function PrintPanel() {
  const setProgram = useProgram((s) => s.setProgram)
  const connected = useMachine((s) => s.connection === 'connected')

  const fileRef = useRef<HTMLInputElement>(null)

  const [meshInfo, setMeshInfo] = useState<MeshInfo | null>(null)
  const [loadError, setLoadError] = useState<string>('')
  const [dragOver, setDragOver] = useState(false)

  const [transform, setTransform] = useState<Transform>({ scale: 1, rotZ: 0 })
  const [scalePct, setScalePct] = useState('100')

  const [settings, setSettings] = usePersistentState<PrintSettings>(
    'karmyogi.print.settings',
    DEFAULTS,
  )
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [slicing, setSlicing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [lastGcode, setLastGcode] = useState<{ name: string; text: string; lines: number } | null>(
    null,
  )
  const [showGcode, setShowGcode] = useState(false)

  function set<K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }))
  }
  function num(key: keyof PrintSettings) {
    return (e: ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value)
      set(key, (Number.isFinite(v) ? v : 0) as PrintSettings[typeof key])
    }
  }

  // ---- STL import ----------------------------------------------------------
  async function loadFile(file: File) {
    setLoadError('')
    setStatus('')
    setLastGcode(null)
    try {
      const buf = await file.arrayBuffer()
      const mesh = parseStl(buf)
      if (mesh.triangleCount === 0) {
        setLoadError('STL parsed but contained no triangles.')
        setMeshInfo(null)
        return
      }
      setMeshInfo({ name: file.name, mesh, format: mesh.format })
      setTransform({ scale: 1, rotZ: 0 })
      setScalePct('100')
    } catch (err) {
      setMeshInfo(null)
      setLoadError(`Failed to read STL: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) void loadFile(f)
    e.target.value = ''
  }

  // ---- Derived: placed geometry (scale + rotate + centre on bed) -----------
  // We transform vertices into bed coordinates: model centred in X/Y, base at Z=0.
  const placed = useMemo(() => {
    if (!meshInfo) return null
    const { mesh } = meshInfo
    const s = transform.scale
    const ang = (transform.rotZ * Math.PI) / 180
    const cos = Math.cos(ang)
    const sin = Math.sin(ang)

    const src = mesh.triangles
    const stride = STL_STRIDE
    const vCount = mesh.vertexCount
    const dst = new Float32Array(src.length)

    // First pass: rotate+scale to find new bbox.
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < vCount; i++) {
      const o = i * stride
      const x = src[o] * s
      const y = src[o + 1] * s
      const z = src[o + 2] * s
      const rx = x * cos - y * sin
      const ry = x * sin + y * cos
      if (rx < minX) minX = rx
      if (ry < minY) minY = ry
      if (z < minZ) minZ = z
      if (rx > maxX) maxX = rx
      if (ry > maxY) maxY = ry
      if (z > maxZ) maxZ = z
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const bedCx = BED_X / 2
    const bedCy = BED_Y / 2

    // Second pass: write centred, base at z=0, normals rotated too.
    let nMinX = Infinity, nMinY = Infinity, nMinZ = 0
    let nMaxX = -Infinity, nMaxY = -Infinity, nMaxZ = -Infinity
    for (let i = 0; i < vCount; i++) {
      const o = i * stride
      const x = src[o] * s
      const y = src[o + 1] * s
      const z = src[o + 2] * s
      const rx = x * cos - y * sin
      const ry = x * sin + y * cos
      const px = rx - cx + bedCx
      const py = ry - cy + bedCy
      const pz = z - minZ
      dst[o] = px
      dst[o + 1] = py
      dst[o + 2] = pz
      // rotate normal about Z
      const nx = src[o + 3]
      const ny = src[o + 4]
      dst[o + 3] = nx * cos - ny * sin
      dst[o + 4] = nx * sin + ny * cos
      dst[o + 5] = src[o + 5]
      if (px < nMinX) nMinX = px
      if (py < nMinY) nMinY = py
      if (pz > nMaxZ) nMaxZ = pz
      if (px > nMaxX) nMaxX = px
      if (py > nMaxY) nMaxY = py
    }

    const placedMesh: StlMesh = {
      triangles: dst,
      vertexCount: vCount,
      triangleCount: mesh.triangleCount,
      bbox: { min: [nMinX, nMinY, nMinZ], max: [nMaxX, nMaxY, nMaxZ] },
      format: mesh.format,
    }
    const sizeX = maxX - minX
    const sizeY = maxY - minY
    const sizeZ = maxZ - minZ
    const fits = sizeX <= BED_X && sizeY <= BED_Y && sizeZ <= BED_Z
    return { mesh: placedMesh, sizeX, sizeY, sizeZ, fits }
  }, [meshInfo, transform])

  // ---- Arrange controls ----------------------------------------------------
  function applyScalePct() {
    const v = parseFloat(scalePct)
    if (Number.isFinite(v) && v > 0) setTransform((t) => ({ ...t, scale: v / 100 }))
  }
  function scaleToFit() {
    if (!placed) return
    const cur = transform.scale
    // base size at scale=1
    const baseX = placed.sizeX / cur
    const baseY = placed.sizeY / cur
    const baseZ = placed.sizeZ / cur
    const fitS = Math.min(
      (BED_X * 0.9) / Math.max(baseX, 1e-6),
      (BED_Y * 0.9) / Math.max(baseY, 1e-6),
      (BED_Z * 0.9) / Math.max(baseZ, 1e-6),
    )
    const next = Math.min(1, fitS)
    setTransform((t) => ({ ...t, scale: next }))
    setScalePct((next * 100).toFixed(0))
  }
  function rotate90() {
    setTransform((t) => ({ ...t, rotZ: (t.rotZ + 90) % 360 }))
  }

  // ---- Slice (chunked so the UI doesn't freeze) ----------------------------
  async function doSlice() {
    if (!placed) return
    setSlicing(true)
    setProgress(0)
    setStatus('Slicing…')
    setLastGcode(null)
    try {
      // Yield to the browser so the "Slicing…" state paints before heavy work.
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      setProgress(0.3)

      const sliceParams: SliceParams = {
        layerHeight: settings.layerHeight,
        lineWidth: settings.lineWidth,
        perimeters: settings.perimeters,
        infillDensity: settings.infill,
      }
      const slice = sliceMesh(placed.mesh, sliceParams)
      setProgress(0.7)
      await new Promise((r) => requestAnimationFrame(() => r(null)))

      if (slice.layerCount === 0) {
        setStatus(slice.warnings.join(' ') || 'Slicing produced no layers.')
        setSlicing(false)
        setProgress(0)
        return
      }

      const gParams: GcodeParams = {
        layerHeight: settings.layerHeight,
        lineWidth: settings.lineWidth,
        filamentDiameter: settings.filamentDiameter,
        nozzleTemp: settings.nozzleTemp,
        bedTemp: settings.bedTemp,
        firstLayerNozzleTemp: settings.firstLayerTemp,
        printSpeed: settings.printSpeed,
        travelSpeed: settings.travelSpeed,
        firstLayerSpeed: settings.firstLayerSpeed,
        retractDistance: settings.retractDistance,
        retractSpeed: settings.retractSpeed,
        fanEnabled: settings.fan,
        skirt: settings.skirt,
      }
      const gcode = sliceToGcode(slice, gParams)
      setProgress(1)

      const name = `print.gcode`
      setProgram(name, gcode)
      const lines = gcode.split('\n').filter(Boolean).length
      setLastGcode({ name, text: gcode, lines })
      const warn = slice.warnings.length ? ` (${slice.warnings.length} warning(s))` : ''
      setStatus(
        `Sliced ${slice.layerCount} layers → ${lines} lines${warn}. Shown in Visualizer & Program.`,
      )
    } catch (err) {
      setStatus(`Slice failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSlicing(false)
    }
  }

  function sendToMachine() {
    if (!connected || !lastGcode) return
    const ok = window.confirm(
      `Start the print on the machine now?\n` +
        `${lastGcode.lines} lines. Make sure the bed is clear and the printer is homed-safe.`,
    )
    if (!ok) return
    grbl.startProgram(lastGcode.text.split(/\r?\n/).filter(Boolean))
    setStatus(`Streaming print — ${lastGcode.lines} lines.`)
  }

  return (
    <div className="print-panel">
      <div className="print-scroll">
        <p className="print-intro">
          Import an <b>STL</b>, arrange it on the bed, slice to G-code, then preview &amp; stream it
          to a GRBL printer.
        </p>

        {/* ---- 1. Import ---- */}
        <section className="print-section">
          <h3>1 · Import STL</h3>
          <div className="print-section-body">
            <div
              className={'print-drop' + (dragOver ? ' print-dragover' : '')}
              onDragOver={(e: DragEvent) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault()
                setDragOver(false)
                const fl = e.dataTransfer.files?.[0]
                if (fl) void loadFile(fl)
              }}
            >
              <button className="print-btn primary" onClick={() => fileRef.current?.click()}>
                ⬆ Open STL…
              </button>
              <span className="print-drop-hint">or drop a .stl file here</span>
              <input
                ref={fileRef}
                className="print-file-input"
                type="file"
                accept=".stl"
                onChange={onFileInput}
              />
            </div>
            {loadError && <div className="print-error">{loadError}</div>}
            {meshInfo && (
              <div className="print-info">
                {meshInfo.name} — {meshInfo.mesh.triangleCount.toLocaleString()} triangles ·{' '}
                {meshInfo.format} STL
              </div>
            )}
          </div>
        </section>

        {/* ---- 2. Preview + Arrange ---- */}
        {placed && (
          <section className="print-section">
            <h3>2 · Arrange</h3>
            <div className="print-section-body">
              <div className="print-viewport">
                <MeshPreview triangles={placed.mesh.triangles} fits={placed.fits} />
              </div>

              <div className={'print-size' + (placed.fits ? '' : ' print-size-bad')}>
                Size: {f1(placed.sizeX)} × {f1(placed.sizeY)} × {f1(placed.sizeZ)} mm
                {placed.fits ? (
                  <span className="print-fit-ok"> · fits bed</span>
                ) : (
                  <span className="print-fit-bad"> · ⚠ exceeds {BED_X}×{BED_Y}×{BED_Z} mm bed</span>
                )}
              </div>

              <div className="print-arrange">
                <label className="print-field print-field-inline">
                  <span>Scale %</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="5"
                    min="1"
                    value={scalePct}
                    onChange={(e) => setScalePct(e.target.value)}
                    onBlur={applyScalePct}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyScalePct()
                    }}
                  />
                </label>
                <button className="print-btn" onClick={rotate90} title="Rotate 90° about Z">
                  ⟳ Rotate 90°
                </button>
                <button className="print-btn" onClick={scaleToFit} title="Scale down to fit the bed">
                  Scale to fit
                </button>
                <button
                  className="print-btn"
                  onClick={() => {
                    setTransform({ scale: 1, rotZ: 0 })
                    setScalePct('100')
                  }}
                  title="Reset scale/rotation, auto-centre"
                >
                  Reset
                </button>
              </div>
              <p className="print-hint">Object is auto-centred on the bed. Rotation is in 90° steps about Z.</p>
            </div>
          </section>
        )}

        {/* ---- 3. Print settings ---- */}
        <section className="print-section">
          <h3>3 · Print settings</h3>
          <div className="print-section-body">
            <div className="print-grid">
              <Field label="Layer height (mm)">
                <input type="number" step="0.05" min="0.05" value={settings.layerHeight} onChange={num('layerHeight')} />
              </Field>
              <Field label="Infill (%)">
                <input type="number" step="5" min="0" max="100" value={settings.infill} onChange={num('infill')} />
              </Field>
              <Field label="Perimeters (walls)">
                <input type="number" step="1" min="1" max="8" value={settings.perimeters} onChange={num('perimeters')} />
              </Field>
              <Field label="Nozzle temp (°C)">
                <input type="number" step="5" min="0" value={settings.nozzleTemp} onChange={num('nozzleTemp')} />
              </Field>
              <Field label="Bed temp (°C)">
                <input type="number" step="5" min="0" value={settings.bedTemp} onChange={num('bedTemp')} />
              </Field>
              <Field label="Print speed (mm/min)">
                <input type="number" step="60" min="60" value={settings.printSpeed} onChange={num('printSpeed')} />
              </Field>
            </div>
            <label className="print-check">
              <input type="checkbox" checked={settings.fan} onChange={(e) => set('fan', e.target.checked)} />
              <span>Part-cooling fan (on after first layer)</span>
            </label>
          </div>
        </section>

        {/* ---- 4. Advanced (collapsed) ---- */}
        <section className="print-section">
          <button
            className="print-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? '▾' : '▸'} Advanced — filament, retraction, first layer
          </button>
          {showAdvanced && (
            <div className="print-section-body">
              <div className="print-grid">
                <Field label="Filament Ø (mm)">
                  <input type="number" step="0.05" min="0.5" value={settings.filamentDiameter} onChange={num('filamentDiameter')} />
                </Field>
                <Field label="Line width (mm)">
                  <input type="number" step="0.05" min="0.1" value={settings.lineWidth} onChange={num('lineWidth')} />
                </Field>
                <Field label="Travel speed (mm/min)">
                  <input type="number" step="120" min="120" value={settings.travelSpeed} onChange={num('travelSpeed')} />
                </Field>
                <Field label="Retract dist (mm)">
                  <input type="number" step="0.1" min="0" value={settings.retractDistance} onChange={num('retractDistance')} />
                </Field>
                <Field label="Retract speed (mm/min)">
                  <input type="number" step="120" min="60" value={settings.retractSpeed} onChange={num('retractSpeed')} />
                </Field>
                <Field label="First-layer temp (°C)">
                  <input type="number" step="5" min="0" value={settings.firstLayerTemp} onChange={num('firstLayerTemp')} />
                </Field>
                <Field label="First-layer speed (mm/min)">
                  <input type="number" step="60" min="60" value={settings.firstLayerSpeed} onChange={num('firstLayerSpeed')} />
                </Field>
              </div>
              <label className="print-check">
                <input type="checkbox" checked={settings.skirt} onChange={(e) => set('skirt', e.target.checked)} />
                <span>Skirt (priming loop on first layer)</span>
              </label>
            </div>
          )}
        </section>

        {/* ---- 5. Slice & send ---- */}
        <section className="print-section">
          <h3>4 · Slice &amp; print</h3>
          <div className="print-section-body">
            <div className="print-actions">
              <button className="print-btn primary" onClick={() => void doSlice()} disabled={!placed || slicing}>
                {slicing ? 'Slicing…' : '✂ Slice → G-code'}
              </button>
              <button
                className="print-btn print-send"
                onClick={sendToMachine}
                disabled={!connected || !lastGcode || slicing}
                title={!connected ? 'Connect to the machine first' : !lastGcode ? 'Slice first' : 'Stream the print'}
              >
                ▶ Send to printer
              </button>
            </div>
            {slicing && (
              <div className="print-progress" aria-label="slicing progress">
                <div className="print-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
            {status && <div className="print-status">{status}</div>}

            {lastGcode && (
              <div className="print-gcode">
                <button
                  className="print-gcode-toggle"
                  onClick={() => setShowGcode((v) => !v)}
                  aria-expanded={showGcode}
                >
                  {showGcode ? '▾' : '▸'} G-code — {lastGcode.name}
                  <span className="print-gcode-meta">{lastGcode.lines} lines</span>
                </button>
                {showGcode && (
                  <pre className="print-gcode-text" aria-label="generated g-code">
                    {lastGcode.text}
                  </pre>
                )}
              </div>
            )}

            <p className="print-note">
              Note: this is a <strong>basic FDM slicer</strong> (inset perimeters + alternating
              0/90° rectilinear infill) for hobby GRBL-based printers — not a production slicer (no
              supports, bridging, or adaptive layers). Always sanity-check the toolpath in the
              Visualizer before printing.
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="print-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

/**
 * Small 3D preview of the imported mesh sitting on the bed (Z-up, matching the
 * app). The mesh is supplied already placed in bed coordinates.
 */
function MeshPreview({ triangles, fits }: { triangles: Float32Array; fits: boolean }) {
  // Extract just positions (drop interleaved normals) into a tight buffer.
  const geom = useMemo(() => {
    const triCount = triangles.length / (STL_STRIDE * 3)
    const positions = new Float32Array(triCount * 9)
    let p = 0
    for (let i = 0; i < triCount * 3; i++) {
      const o = i * STL_STRIDE
      positions[p++] = triangles[o]
      positions[p++] = triangles[o + 1]
      positions[p++] = triangles[o + 2]
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [triangles])

  // Frame the camera roughly to the bed.
  const camTarget: [number, number, number] = [BED_X / 2, BED_Y / 2, 20]

  return (
    <Canvas
      style={{ height: '100%', width: '100%' }}
      camera={{ position: [BED_X / 2 + 180, -180, 180], up: [0, 0, 1], fov: 45, near: 0.1, far: 5000 }}
      onCreated={({ camera }) => camera.lookAt(...camTarget)}
    >
      <color attach="background" args={['#15181c']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[100, -120, 300]} intensity={0.7} />
      <directionalLight position={[-120, 80, 150]} intensity={0.3} />
      {/* Bed: grid on the XY plane (Z-up). Centred on the bed centre. */}
      <group position={[BED_X / 2, BED_Y / 2, 0]}>
        <Grid
          args={[BED_X, BED_Y]}
          cellSize={10}
          cellThickness={0.6}
          cellColor="#3a4250"
          sectionSize={50}
          sectionThickness={1.1}
          sectionColor="#515c6e"
          rotation={[Math.PI / 2, 0, 0]}
          infiniteGrid={false}
          fadeDistance={Math.max(BED_X, BED_Y) * 3}
          fadeStrength={1}
        />
      </group>
      <mesh geometry={geom}>
        <meshStandardMaterial
          color={fits ? '#5e8bd6' : '#d66a5e'}
          metalness={0.1}
          roughness={0.7}
          flatShading
        />
      </mesh>
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} target={camTarget} />
    </Canvas>
  )
}
