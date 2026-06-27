import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useProgram, usePersistentState, useNotifications } from '../store'
import { IconButton } from '../components/IconButton'
import { InfoTip } from '../components/InfoTip'
import { importDxfString } from '../core/dxf'
import type { Polyline } from '../core/geometry'
import '../styles/cam.css'
import '../styles/tattoo.css'

/**
 * TATTOO / HENNA — a HIGHLY EXPERIMENTAL / CONCEPTUAL workbench.
 *
 * One machine, two skin tools:
 *   • NEEDLE (tattoo): the Z axis drives a needle that PENETRATES the skin to a
 *     tiny, hard-capped depth and stipples dots along the design.
 *   • HENNA / MEHNDI extruder: a paste extruder driven by the PWM (spindle) output
 *     (M3 S… sets the extrude rate, M5 stops) draws henna ON the skin SURFACE in
 *     continuous strokes — no penetration.
 *
 * SKIN SHAPE (wrap): real skin isn't flat — limbs (forearm, leg) are roughly
 * cylindrical. A "cylinder" surface model curves the tool's Z across the wrap axis
 * so the design conforms to the limb instead of plunging into a flat plane. (3-axis
 * keeps the needle vertical — an approximation best near the top of the limb; a
 * rotary/5-axis would keep it surface-normal. Real use also needs continuous
 * camera depth tracking — the planned next step.)
 *
 * Camera-guided + DANGEROUS on living tissue → framed as R&D / simulation only,
 * NOT a device: a SAFETY ACKNOWLEDGMENT gates every machine-bound action and
 * needle depth is hard-capped. Publishes a `tattoo` program section.
 */

type TattooMode = 'needle' | 'henna'
type SkinShape = 'flat' | 'cylinder'

const SECTION = 'tattoo'
/** Hard safety cap on needle penetration below the skin surface (mm). */
const MAX_DEPTH_MM = 3

const num = (v: string, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

interface TattooParams {
  mode: TattooMode
  shape: SkinShape
  /** Cylinder radius (mm) for the limb when shape='cylinder'. */
  cylRadius: number
  /** Which axis the surface curves ACROSS (the circumference direction). */
  wrapAxis: 'x' | 'y'
  /** Skin-surface Z datum (mm) at the TOP of the limb / the flat plane. */
  skinZ: number
  depth: number
  dwell: number
  dotSpacing: number
  hennaPwm: number
  prime: number
  feed: number
  safeZ: number
  designR: number
  cx: number
  cy: number
  /** Scale an imported design so its largest dimension == fitSize, then centre it. */
  fitEnabled: boolean
  fitSize: number
  /** Live skin-tracking registration offset (manual placeholder for camera CV). */
  trackOn: boolean
  trackDx: number
  trackDy: number
  /** Rotation (deg) about the design centre. */
  trackTheta: number
}

interface XY {
  x: number
  y: number
}
/** A path in machine space: contact points + whether it forms a closed loop. */
interface DesignPath {
  pts: XY[]
  closed: boolean
}

/**
 * Surface Z at a point. Flat → the skin datum. Cylinder → the datum minus how far
 * the limb's surface drops away from its top centreline along the wrap axis, so the
 * tool rides the curve. Clamped at the cylinder's edge (±R).
 */
function surfaceZAt(x: number, y: number, p: TattooParams): number {
  if (p.shape !== 'cylinder' || p.cylRadius <= 0) return p.skinZ
  const off = p.wrapAxis === 'x' ? x - p.cx : y - p.cy
  const R = p.cylRadius
  const a = Math.min(Math.abs(off), R)
  return p.skinZ - (R - Math.sqrt(R * R - a * a))
}

/**
 * LIVE SKIN-TRACKING registration offset: rotate a point by θ (deg) about the
 * design centre (cx,cy), then translate by (dx,dy). This represents compensating
 * for the body part moving. (The camera CV that would drive this LIVE is the
 * planned next step — for now the offset is manual, see the panel copy.)
 */
function liveOffset(x: number, y: number, p: TattooParams): XY {
  if (!p.trackOn) return { x, y }
  const th = (p.trackTheta * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  const ox = x - p.cx
  const oy = y - p.cy
  return { x: p.cx + ox * c - oy * s + p.trackDx, y: p.cy + ox * s + oy * c + p.trackDy }
}

/** The DEMO fallback when no design is loaded: a single circle centred on (cx,cy). */
function demoPaths(p: TattooParams): DesignPath[] {
  const r = Math.max(p.designR, 0.5)
  const segs = Math.max(24, Math.round((2 * Math.PI * r) / 0.4))
  const pts: XY[] = []
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * 2 * Math.PI
    pts.push({ x: p.cx + r * Math.cos(a), y: p.cy + r * Math.sin(a) })
  }
  return [{ pts, closed: false }]
}

/** Centre (and optionally scale-to-fit) imported polylines onto (cx,cy). */
function designPaths(loaded: Polyline[], p: TattooParams): DesignPath[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pl of loaded)
    for (const q of pl.points) {
      if (q.x < minX) minX = q.x
      if (q.y < minY) minY = q.y
      if (q.x > maxX) maxX = q.x
      if (q.y > maxY) maxY = q.y
    }
  if (!Number.isFinite(minX)) return []
  const sx = (minX + maxX) / 2
  const sy = (minY + maxY) / 2
  let scale = 1
  if (p.fitEnabled) {
    const span = Math.max(maxX - minX, maxY - minY)
    if (span > 1e-6) scale = Math.max(p.fitSize, 0.5) / span
  }
  return loaded
    .filter((pl) => pl.points.length >= 2)
    .map((pl) => ({
      closed: pl.closed,
      pts: pl.points.map((q) => ({ x: p.cx + (q.x - sx) * scale, y: p.cy + (q.y - sy) * scale })),
    }))
}

/** Resample a path into stipple dots spaced ~`spacing` mm apart by arc length. */
function dotsAlong(pts: XY[], spacing: number): XY[] {
  const out: XY[] = []
  if (pts.length === 0) return out
  out.push({ x: pts[0].x, y: pts[0].y })
  if (pts.length === 1) return out
  const sp = Math.max(spacing, 0.1)
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1].x
    let ay = pts[i - 1].y
    const bx = pts[i].x
    const by = pts[i].y
    let seg = Math.hypot(bx - ax, by - ay)
    while (carry + seg >= sp && seg > 1e-9) {
      const tt = (sp - carry) / seg
      ax += (bx - ax) * tt
      ay += (by - ay) * tt
      out.push({ x: ax, y: ay })
      seg = Math.hypot(bx - ax, by - ay)
      carry = 0
    }
    carry += seg
  }
  return out
}

/**
 * Conceptual path generator. Builds source paths from the IMPORTED design (or a
 * DEMO circle if none is loaded), applies the live skin-tracking registration
 * offset to every vertex, then emits per mode. NEEDLE → stipple dots along each
 * path (descend to the surface, penetrate, dwell, retract). HENNA → continuous
 * on-surface strokes with the PWM extruder on (M3 S…/M5 between paths). With a
 * cylinder skin shape, every contact Z follows the limb curve via surfaceZAt(),
 * so an imported design WRAPS onto the limb just like the demo. Emits standard
 * safe G-code for the Visualizer.
 */
function generateGcode(p: TattooParams, loaded: Polyline[] | null): string {
  const f = Math.max(1, Math.round(p.feed))
  const usingFile = !!(loaded && loaded.length)
  const rawPaths = usingFile ? designPaths(loaded as Polyline[], p) : demoPaths(p)
  // Apply the live skin-tracking registration offset to every vertex.
  const paths: DesignPath[] = rawPaths.map((d) => ({
    closed: d.closed,
    pts: d.pts.map((q) => liveOffset(q.x, q.y, p)),
  }))

  const shapeNote = p.shape === 'cylinder' ? `cylinder R=${p.cylRadius}mm wrap=${p.wrapAxis}` : 'flat'
  const srcNote = usingFile ? 'imported design' : 'demo circle'
  const trackNote = p.trackOn
    ? `dx=${p.trackDx}mm dy=${p.trackDy}mm theta=${p.trackTheta}deg (manual placeholder)`
    : 'off'
  const head = [
    '; karmyogi TATTOO / HENNA — EXPERIMENTAL / CONCEPTUAL (R&D only, NOT a device)',
    '; Marking living skin carries serious infection / injury risk. Review every line.',
    `; source: ${srcNote}`,
    `; skin shape: ${shapeNote}`,
    `; live skin tracking: ${trackNote}`,
    'G21 G90 G94 G17',
    `G0 Z${p.safeZ.toFixed(3)}`,
  ]

  if (paths.length === 0) {
    return [...head, '; (no usable geometry in the loaded design)', 'M2'].join('\n') + '\n'
  }

  if (p.mode === 'henna') {
    const pwm = Math.min(Math.max(Math.round(p.hennaPwm), 0), 1000)
    const lines = [...head, `; HENNA extruder: PWM/S=${pwm} feed=${f}mm/min strokes=${paths.length}`]
    for (const d of paths) {
      const pts = d.closed && d.pts.length > 1 ? [...d.pts, d.pts[0]] : d.pts
      if (pts.length < 2) continue
      const a = pts[0]
      lines.push(`G0 X${a.x.toFixed(3)} Y${a.y.toFixed(3)}`)
      lines.push(`G1 Z${surfaceZAt(a.x, a.y, p).toFixed(3)} F${f}`)
      lines.push(`M3 S${pwm}`)
      if (p.prime > 0) lines.push(`G4 P${p.prime.toFixed(3)}`)
      for (let i = 1; i < pts.length; i++) {
        const q = pts[i]
        lines.push(`G1 X${q.x.toFixed(3)} Y${q.y.toFixed(3)} Z${surfaceZAt(q.x, q.y, p).toFixed(3)} F${f}`)
      }
      lines.push('M5', `G0 Z${p.safeZ.toFixed(3)}`) // lift between separate strokes
    }
    lines.push('M2')
    return lines.join('\n') + '\n'
  }

  // NEEDLE — stipple dots along each path.
  const depth = Math.min(Math.max(p.depth, 0), MAX_DEPTH_MM)
  const lines = [...head, `; NEEDLE: depth=${depth}mm (cap ${MAX_DEPTH_MM}mm) dwell=${p.dwell}s spacing=${p.dotSpacing}mm`]
  let total = 0
  for (const d of paths) {
    const pts = d.closed && d.pts.length > 1 ? [...d.pts, d.pts[0]] : d.pts
    for (const q of dotsAlong(pts, p.dotSpacing)) {
      const sZ = surfaceZAt(q.x, q.y, p)
      lines.push(`G0 X${q.x.toFixed(3)} Y${q.y.toFixed(3)}`)
      lines.push(`G1 Z${sZ.toFixed(3)} F${f}`) // descend to the (curved) surface
      lines.push(`G1 Z${(sZ - depth).toFixed(3)} F${f}`) // penetrate
      if (p.dwell > 0) lines.push(`G4 P${p.dwell.toFixed(3)}`)
      lines.push(`G0 Z${p.safeZ.toFixed(3)}`)
      total++
    }
  }
  lines.push(`; total dots=${total}`, `G0 Z${p.safeZ.toFixed(3)}`, 'M2')
  return lines.join('\n') + '\n'
}

/** A compact labelled number row. */
function NumRow({
  label,
  tip,
  value,
  onChange,
  step = 0.1,
  min,
  max,
  unit,
  warn,
}: {
  label: string
  tip?: { title: string; body: string }
  value: number
  onChange: (n: number) => void
  step?: number
  min?: number
  max?: number
  unit?: string
  warn?: boolean
}) {
  return (
    <label className={'tt-row' + (warn ? ' tt-row--warn' : '')}>
      <span className="tt-row-label">
        {label}
        {tip && <InfoTip topic="tattoo" title={tip.title} body={tip.body} />}
      </span>
      <span className="tt-row-input">
        <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => onChange(num(e.target.value, value))} />
        {unit && <span className="tt-row-unit">{unit}</span>}
      </span>
    </label>
  )
}

export function TattooPanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const notify = useNotifications((s) => s.notify)

  const [ack, setAck] = usePersistentState('karmyogi.tattoo.ack', false)
  const [bannerDismissed, setBannerDismissed] = usePersistentState('karmyogi.tattoo.bannerHidden', false)
  const [mode, setMode] = usePersistentState<TattooMode>('karmyogi.tattoo.mode', 'needle')

  // ── Live skin camera (continuous feed) — self-contained getUserMedia. ──
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [camOn, setCamOn] = useState(false)
  const [camErr, setCamErr] = useState<string | null>(null)
  // Detected video input devices + the chosen one. Device LABELS are only filled
  // in AFTER camera permission is granted, so we re-enumerate once a stream starts.
  // A dropdown appears next to the title when >1 camera is found (e.g. a future
  // 2-camera stereo-depth rig — see the panel notes).
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [camId, setCamId] = useState<string>('')

  const refreshCameras = async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      setCameras(devs.filter((d) => d.kind === 'videoinput'))
    } catch {
      /* enumerateDevices unavailable — single-camera fallback (no dropdown) */
    }
  }

  const stopCam = () => {
    streamRef.current?.getTracks().forEach((tk) => tk.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCamOn(false)
  }
  const startCam = async (deviceId?: string) => {
    setCamErr(null)
    const id = deviceId ?? camId
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: id
          ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      // Drop any prior stream, adopt the device that actually opened (so the
      // dropdown reflects reality), and re-enumerate now that labels are available.
      streamRef.current?.getTracks().forEach((tk) => tk.stop())
      const active = stream.getVideoTracks()[0]?.getSettings().deviceId
      if (active) setCamId(active)
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
      setCamOn(true)
      void refreshCameras()
    } catch (e) {
      setCamErr(
        t('tattoo.cam.err', 'Camera unavailable — needs a secure (https/localhost) page and camera permission.') +
          (e instanceof Error ? ` (${e.name})` : ''),
      )
    }
  }
  // Enumerate on mount + when devices change; release the camera on unmount.
  useEffect(() => {
    void refreshCameras()
    const md = navigator.mediaDevices
    const onChange = () => void refreshCameras()
    md?.addEventListener?.('devicechange', onChange)
    return () => {
      md?.removeEventListener?.('devicechange', onChange)
      stopCam()
    }
  }, [])

  // ── Parameters (persisted). ──
  const [shape, setShape] = usePersistentState<SkinShape>('karmyogi.tattoo.shape', 'flat')
  const [cylRadius, setCylRadius] = usePersistentState('karmyogi.tattoo.cylR', 30)
  const [wrapAxis, setWrapAxis] = usePersistentState<'x' | 'y'>('karmyogi.tattoo.wrapAxis', 'x')
  const [skinZ, setSkinZ] = usePersistentState('karmyogi.tattoo.skinZ', 0)
  const [depth, setDepth] = usePersistentState('karmyogi.tattoo.depth', 1.0)
  const [feed, setFeed] = usePersistentState('karmyogi.tattoo.feed', 300)
  const [dwell, setDwell] = usePersistentState('karmyogi.tattoo.dwell', 0.05)
  const [dotSpacing, setDotSpacing] = usePersistentState('karmyogi.tattoo.dot', 0.5)
  const [safeZ, setSafeZ] = usePersistentState('karmyogi.tattoo.safeZ', 10)
  const [hennaPwm, setHennaPwm] = usePersistentState('karmyogi.tattoo.pwm', 600)
  const [prime, setPrime] = usePersistentState('karmyogi.tattoo.prime', 0.3)
  // Fixed placeholder-circle radius (mm), shown only until a design is loaded — no
  // longer a user "demo" knob (the vector import is the real design source now).
  const designR = 8
  const [cx, setCx] = usePersistentState('karmyogi.tattoo.cx', 0)
  const [cy, setCy] = usePersistentState('karmyogi.tattoo.cy', 0)

  // ── Imported vector design (DXF). Held in volatile state (not persisted —
  // file content is re-loaded each session, mirroring CadCam). Falls back to the
  // demo circle when nothing is loaded. ──
  const [designPolys, setDesignPolys] = useState<Polyline[] | null>(null)
  const [designName, setDesignName] = useState<string | null>(null)
  const [designErr, setDesignErr] = useState<string | null>(null)
  const [designWarn, setDesignWarn] = useState<number>(0)
  const designInputRef = useRef<HTMLInputElement>(null)
  const [fitEnabled, setFitEnabled] = usePersistentState('karmyogi.tattoo.fit', true)
  const [fitSize, setFitSize] = usePersistentState('karmyogi.tattoo.fitSize', 24)

  // ── Live skin tracking (manual registration offset — placeholder for camera CV). ──
  const [trackOn, setTrackOn] = usePersistentState('karmyogi.tattoo.trackOn', false)
  const [trackDx, setTrackDx] = usePersistentState('karmyogi.tattoo.trackDx', 0)
  const [trackDy, setTrackDy] = usePersistentState('karmyogi.tattoo.trackDy', 0)
  const [trackTheta, setTrackTheta] = usePersistentState('karmyogi.tattoo.trackTheta', 0)

  const loadDesignFile = async (file: File) => {
    setDesignErr(null)
    setDesignWarn(0)
    try {
      const text = await file.text()
      const res = importDxfString(text)
      if (!res.ok) {
        setDesignErr(res.error ?? t('tattoo.design.errParse', 'Could not parse this DXF.'))
        return
      }
      const polys = res.drawing.flatten().filter((pl) => pl.points.length >= 2)
      if (polys.length === 0) {
        setDesignErr(t('tattoo.design.empty', 'No usable line geometry found in this file.'))
        return
      }
      setDesignPolys(polys)
      setDesignName(file.name)
      setDesignWarn(res.warnings?.length ?? 0)
      notify('info', t('tattoo.design.ok', 'Loaded {name} — {count} path(s).', { name: file.name, count: polys.length }))
    } catch (err) {
      setDesignErr(t('tattoo.design.errRead', 'Could not read this design: {msg}', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }
  const clearDesign = () => {
    setDesignPolys(null)
    setDesignName(null)
    setDesignErr(null)
    setDesignWarn(0)
  }

  const params: TattooParams = useMemo(
    () => ({ mode, shape, cylRadius, wrapAxis, skinZ, depth, dwell, dotSpacing, hennaPwm, prime, feed, safeZ, designR, cx, cy, fitEnabled, fitSize, trackOn, trackDx, trackDy, trackTheta }),
    [mode, shape, cylRadius, wrapAxis, skinZ, depth, dwell, dotSpacing, hennaPwm, prime, feed, safeZ, designR, cx, cy, fitEnabled, fitSize, trackOn, trackDx, trackDy, trackTheta],
  )
  const gcode = useMemo(() => generateGcode(params, designPolys), [params, designPolys])
  const depthCapped = depth > MAX_DEPTH_MM
  const isHenna = mode === 'henna'
  const isCyl = shape === 'cylinder'
  const hasDesign = !!(designPolys && designPolys.length)
  // Effective design half-extent (mm): the demo radius, or the imported design's
  // half span — its fit size if scaling, else its own millimetre size.
  const designHalf = useMemo(() => {
    if (!designPolys || designPolys.length === 0) return designR
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const pl of designPolys)
      for (const q of pl.points) {
        if (q.x < minX) minX = q.x
        if (q.y < minY) minY = q.y
        if (q.x > maxX) maxX = q.x
        if (q.y > maxY) maxY = q.y
      }
    if (!Number.isFinite(minX)) return designR
    const span = Math.max(maxX - minX, maxY - minY)
    return (fitEnabled ? Math.max(fitSize, 1) : span) / 2
  }, [designPolys, fitEnabled, fitSize, designR])
  // The design must fit within the limb's wrappable half-circumference, or it spills
  // past the side where this 3-axis approximation breaks down.
  const wrapTooWide = isCyl && designHalf > cylRadius

  const pushToProgram = () => {
    if (!ack) {
      notify('warn', t('tattoo.ackFirst', 'Acknowledge the experimental safety notice first.'))
      return
    }
    setProgram(SECTION, gcode, { color: isHenna ? '#7a5230' : '#e0567a' })
    notify('info', t('tattoo.pushed', 'Conceptual path sent to the Program tab (review before any run).'))
  }

  return (
    <div className="tt-panel cam-panel">
      {/* ── EXPERIMENTAL / SAFETY banner — DISMISSABLE (collapses to a chip) ── */}
      {bannerDismissed ? (
        <button type="button" className="tt-chip" onClick={() => setBannerDismissed(false)}>
          <span aria-hidden="true">⚠</span>
          {t('tattoo.exp.chip', 'Experimental — R&D only · show safety notice')}
        </button>
      ) : (
        <div className="tt-banner" role="alert">
          <span className="tt-banner-icon" aria-hidden="true">⚠</span>
          <div className="tt-banner-text">
            <strong>{t('tattoo.exp.title', 'Experimental concept — not a medical/cosmetic device')}</strong>
            <span>
              {t(
                'tattoo.exp.body',
                'Camera-guided needle tattooing and henna extrusion on living skin are unproven and carry serious infection, scarring and injury risk. This tab is for R&D and simulation only. You are solely responsible for any use.',
              )}
            </span>
          </div>
          <button
            type="button"
            className="tt-banner-close"
            onClick={() => setBannerDismissed(true)}
            title={t('tattoo.exp.dismiss', 'Dismiss this notice')}
            aria-label={t('tattoo.exp.dismiss', 'Dismiss this notice')}
          >
            ✕
          </button>
        </div>
      )}

      {/* Safety acknowledgment — ALWAYS visible (independent of the banner), since
          it gates the generate action. */}
      <label className="tt-ackrow">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>{t('tattoo.ack', 'I understand & accept responsibility')}</span>
      </label>

      {/* ── Tool mode ── */}
      <div className="tt-mode" role="tablist" aria-label={t('tattoo.mode.aria', 'Tool mode')}>
        <button type="button" role="tab" aria-selected={!isHenna} className={'tt-mode-btn' + (!isHenna ? ' is-active' : '')} onClick={() => setMode('needle')}>
          {t('tattoo.mode.needle', 'Tattoo · needle')}
        </button>
        <button type="button" role="tab" aria-selected={isHenna} className={'tt-mode-btn' + (isHenna ? ' is-active' : '')} onClick={() => setMode('henna')}>
          {t('tattoo.mode.henna', 'Henna · extruder')}
        </button>
        <InfoTip
          topic="tattoo"
          title={t('tattoo.mode.tip.title', 'Two skin tools, one machine')}
          body={t(
            'tattoo.mode.tip.body',
            'Needle penetrates the skin and stipples dots (tattoo). Henna uses a PWM-driven paste extruder (M3 S…/M5) drawing ON the surface in continuous strokes (mehndi) — no penetration.',
          )}
        />
      </div>

      {/* ── Live skin camera ── */}
      <section className="tt-card">
        <div className="tt-card-head">
          <span className="tt-camhead-left">
            <span className="tt-card-title">
              {t('tattoo.cam.title', 'Skin camera (live)')}
              <InfoTip
                topic="tattoo"
                title={t('tattoo.cam.tip.title', 'Continuous skin feed')}
                body={t(
                  'tattoo.cam.tip.body',
                  'A live camera feed of the skin. The concept: track the skin-surface depth, register the design onto the skin, and guide the tool — computer-vision that is the next step (not yet implemented).',
                )}
              />
            </span>
            {/* Multi-camera selector — only when >1 video input is detected. Lets the
                user pick the right feed (and is the hook for a future 2-camera
                stereo-depth rig). */}
            {cameras.length > 1 && (
              <select
                className="tt-camselect"
                value={camId}
                onChange={(e) => {
                  const id = e.target.value
                  setCamId(id)
                  if (camOn) void startCam(id)
                }}
                title={t('tattoo.cam.select', 'Choose camera input')}
                aria-label={t('tattoo.cam.select', 'Choose camera input')}
              >
                {cameras.map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || t('tattoo.cam.n', 'Camera {n}', { n: i + 1 })}
                  </option>
                ))}
              </select>
            )}
          </span>
          <span className="tt-card-actions">
            {camOn ? (
              <IconButton icon={<span aria-hidden>■</span>} label={t('tattoo.cam.stop', 'Stop camera')} onClick={stopCam} />
            ) : (
              <IconButton icon={<span aria-hidden>▶</span>} label={t('tattoo.cam.start', 'Start camera')} onClick={() => void startCam()} />
            )}
          </span>
        </div>
        <div className="tt-camframe">
          <video ref={videoRef} className="tt-video" playsInline muted />
          {!camOn && <div className="tt-camempty">{t('tattoo.cam.off', 'Camera off — start it to see the skin feed.')}</div>}
          {camOn && (
            <div className="tt-camoverlay" aria-hidden="true">
              <span className="tt-camoverlay-note">{t('tattoo.cam.overlay', 'Skin-depth & design registration overlay — conceptual (future CV)')}</span>
            </div>
          )}
        </div>
        {camErr && <div className="cam-status cam-status--err">{camErr}</div>}
      </section>

      {/* ── Skin shape (flat / cylinder wrap) ── */}
      <section className="tt-card">
        <div className="tt-card-title">
          {t('tattoo.shape.title', 'Skin shape (wrap)')}
          <InfoTip
            topic="tattoo"
            title={t('tattoo.shape.tip.title', 'Conform to curved skin')}
            body={t(
              'tattoo.shape.tip.body',
              'Real skin is rarely flat. "Cylinder" models a limb (forearm/leg): the tool Z follows the curve so the design wraps around it instead of plunging into a flat plane. The same wrap will map an imported DXF onto the limb.',
            )}
          />
        </div>
        <div className="tt-seg">
          <button type="button" className={'tt-seg-btn' + (!isCyl ? ' is-active' : '')} onClick={() => setShape('flat')}>
            {t('tattoo.shape.flat', 'Flat')}
          </button>
          <button type="button" className={'tt-seg-btn' + (isCyl ? ' is-active' : '')} onClick={() => setShape('cylinder')}>
            {t('tattoo.shape.cyl', 'Cylinder (limb)')}
          </button>
        </div>
        {isCyl && (
          <>
            <NumRow
              label={t('tattoo.shape.r', 'Limb radius')}
              tip={{
                title: t('tattoo.shape.r.tip.title', 'How curved the limb is'),
                body: t('tattoo.shape.r.tip.body', 'Cylinder radius (mm) of the limb — e.g. a forearm ≈ 30–40 mm. Smaller = more curve.'),
              }}
              value={cylRadius}
              onChange={(n) => setCylRadius(Math.max(1, n))}
              min={1}
              unit="mm"
              warn={wrapTooWide}
            />
            <div className="tt-seg tt-seg--sm">
              <span className="tt-seg-label">{t('tattoo.shape.axis', 'Wrap across')}</span>
              <button type="button" className={'tt-seg-btn' + (wrapAxis === 'x' ? ' is-active' : '')} onClick={() => setWrapAxis('x')}>
                X
              </button>
              <button type="button" className={'tt-seg-btn' + (wrapAxis === 'y' ? ' is-active' : '')} onClick={() => setWrapAxis('y')}>
                Y
              </button>
            </div>
            {wrapTooWide && (
              <div className="tt-gen-hint">
                {t('tattoo.shape.warn', 'Design is wider than the limb radius — it spills past the side where this 3-axis wrap breaks down.')}
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Skin surface (+ needle depth in needle mode) ── */}
      <section className="tt-card">
        <div className="tt-card-title">{isHenna ? t('tattoo.skin.title.henna', 'Skin surface') : t('tattoo.skin.title', 'Skin surface & needle depth')}</div>
        <NumRow
          label={isCyl ? t('tattoo.skinZ.top', 'Skin Z (limb top)') : t('tattoo.skinZ', 'Skin-surface Z')}
          tip={{
            title: t('tattoo.skinZ.tip.title', 'Where the skin is'),
            body: t('tattoo.skinZ.tip.body', 'The Z (mm) at which the tool just touches the skin (the limb TOP for a cylinder) — your zero datum.'),
          }}
          value={skinZ}
          onChange={setSkinZ}
          unit="mm"
        />
        {!isHenna && (
          <NumRow
            label={t('tattoo.depth', 'Penetration depth')}
            tip={{
              title: t('tattoo.depth.tip.title', 'How deep the needle goes'),
              body: t('tattoo.depth.tip.body', 'How far the needle goes BELOW the surface, in mm. Real tattoo depth is tiny (~1–2 mm). Hard-capped at {cap} mm for safety.', { cap: MAX_DEPTH_MM }),
            }}
            value={depth}
            onChange={(n) => setDepth(Math.min(Math.max(n, 0), MAX_DEPTH_MM))}
            min={0}
            max={MAX_DEPTH_MM}
            unit="mm"
            warn={depthCapped}
          />
        )}
        <NumRow
          label={t('tattoo.safeZ', 'Safe-Z (retract)')}
          tip={{ title: t('tattoo.safeZ.tip.title', 'Retract height'), body: t('tattoo.safeZ.tip.body', 'How far above the skin the tool lifts between strokes (mm).') }}
          value={safeZ}
          onChange={setSafeZ}
          unit="mm"
        />
      </section>

      {/* ── Mode-specific tool parameters ── */}
      {isHenna ? (
        <section className="tt-card">
          <div className="tt-card-title">{t('tattoo.henna.title', 'Henna extruder (PWM)')}</div>
          <NumRow
            label={t('tattoo.henna.pwm', 'Extruder rate (PWM/S)')}
            tip={{
              title: t('tattoo.henna.pwm.tip.title', 'Paste flow via PWM'),
              body: t('tattoo.henna.pwm.tip.body', 'The PWM (spindle S) value 0–1000 driving the henna extruder — higher = faster flow. Emitted as M3 S… at stroke start, M5 at end.'),
            }}
            value={hennaPwm}
            onChange={(n) => setHennaPwm(Math.min(Math.max(Math.round(n), 0), 1000))}
            step={10}
            min={0}
            max={1000}
          />
          <NumRow
            label={t('tattoo.henna.prime', 'Prime dwell')}
            tip={{ title: t('tattoo.henna.prime.tip.title', 'Prime the paste'), body: t('tattoo.henna.prime.tip.body', 'Seconds to run the extruder before moving, so paste flows as the stroke begins.') }}
            value={prime}
            onChange={setPrime}
            step={0.05}
            unit="s"
          />
          <NumRow label={t('tattoo.feed', 'Feed')} value={feed} onChange={setFeed} step={10} unit="mm/min" />
        </section>
      ) : (
        <section className="tt-card">
          <div className="tt-card-title">{t('tattoo.needle.title', 'Needle & stipple')}</div>
          <NumRow label={t('tattoo.feed', 'Feed')} value={feed} onChange={setFeed} step={10} unit="mm/min" />
          <NumRow
            label={t('tattoo.dwell', 'Hit dwell')}
            tip={{ title: t('tattoo.dwell.tip.title', 'Time in the skin'), body: t('tattoo.dwell.tip.body', 'Seconds the needle dwells at full depth per dot — the "hit".') }}
            value={dwell}
            onChange={setDwell}
            step={0.01}
            unit="s"
          />
          <NumRow
            label={t('tattoo.dot', 'Dot spacing')}
            tip={{ title: t('tattoo.dot.tip.title', 'Stipple density'), body: t('tattoo.dot.tip.body', 'Distance between consecutive dots along the path (mm) — smaller = denser line.') }}
            value={dotSpacing}
            onChange={setDotSpacing}
            step={0.05}
            unit="mm"
          />
        </section>
      )}

      {/* ── Design (vector upload + demo fallback) ── */}
      <section className="tt-card">
        <div className="tt-card-head">
          <span className="tt-card-title">
            {t('tattoo.design.title', 'Design')}
            <InfoTip
              topic="tattoo"
              title={t('tattoo.design.tip.title', 'Vector design → skin-wrapped path')}
              body={t(
                'tattoo.design.tip.body',
                'Load a vector design (DXF). Its polylines are centred on (X,Y) and turned into a path: stipple DOTS for the needle, or continuous strokes for henna. Every contact Z still follows the skin shape, so the design wraps onto the limb. With no file loaded, a demo circle is used.',
              )}
            />
          </span>
          <span className="tt-card-actions">
            <IconButton icon={<span aria-hidden>⤓</span>} label={t('tattoo.design.load', 'Load design (DXF)')} onClick={() => designInputRef.current?.click()} />
            {hasDesign && <IconButton icon={<span aria-hidden>✕</span>} label={t('tattoo.design.clear', 'Remove design (use demo)')} onClick={clearDesign} />}
          </span>
        </div>
        <input
          ref={designInputRef}
          type="file"
          accept=".dxf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.currentTarget.value = '' // allow re-picking the same file
            if (f) void loadDesignFile(f)
          }}
        />
        {hasDesign ? (
          <div className="tt-file">
            <span className="tt-file-name" title={designName ?? ''}>
              {designName}
            </span>
            <span className="tt-file-meta">{t('tattoo.design.count', '{n} path(s)', { n: designPolys?.length ?? 0 })}</span>
          </div>
        ) : (
          <div className="tt-note">{t('tattoo.design.formats', 'No design loaded — a placeholder circle is shown. Load a .DXF vector outline (export AI / EPS / CDR / SVG to DXF first).')}</div>
        )}
        {designErr && <div className="cam-status cam-status--err">{designErr}</div>}
        {hasDesign && designWarn > 0 && (
          <div className="tt-note tt-note--warn">{t('tattoo.design.warn', '{n} import warning(s) — some entities (e.g. text) were skipped.', { n: designWarn })}</div>
        )}

        {hasDesign && (
          <>
            <label className="tt-checkrow">
              <input type="checkbox" checked={fitEnabled} onChange={(e) => setFitEnabled(e.target.checked)} />
              <span className="tt-checkrow-label">
                {t('tattoo.design.fit', 'Scale to fit')}
                <InfoTip
                  topic="tattoo"
                  title={t('tattoo.design.fit.tip.title', 'Fit imported size')}
                  body={t('tattoo.design.fit.tip.body', 'Uniformly scale the design so its largest dimension equals the fit size, then centre it on (X,Y). Off = use the design’s own millimetre size.')}
                />
              </span>
            </label>
            {fitEnabled && (
              <NumRow label={t('tattoo.design.fitSize', 'Fit size (max dim)')} value={fitSize} onChange={(n) => setFitSize(Math.max(1, n))} min={1} unit="mm" warn={wrapTooWide} />
            )}
          </>
        )}
        <div className="tt-row2">
          <NumRow label={t('tattoo.design.cx', 'Centre X')} value={cx} onChange={setCx} unit="mm" />
          <NumRow label={t('tattoo.design.cy', 'Centre Y')} value={cy} onChange={setCy} unit="mm" />
        </div>
      </section>

      {/* ── Live skin tracking (manual registration offset — placeholder for camera CV) ── */}
      <section className="tt-card">
        <div className="tt-card-head">
          <span className="tt-card-title">
            {t('tattoo.track.title', 'Live skin tracking')}
            <InfoTip
              topic="tattoo"
              title={t('tattoo.track.tip.title', 'Motion compensation (placeholder)')}
              body={t(
                'tattoo.track.tip.body',
                'Skin moves — people are alive. A real system would track the skin from the camera feed (computer vision for position + depth) and continuously shift the toolpath to compensate. That live CV is NOT implemented yet. For now this offset is MANUAL, so the compensation pipeline is wired and testable: it rotates and shifts the WHOLE generated path about the design centre.',
              )}
            />
          </span>
          <label className="tt-switch">
            <input type="checkbox" checked={trackOn} onChange={(e) => setTrackOn(e.target.checked)} />
            <span>{trackOn ? t('tattoo.track.on', 'On') : t('tattoo.track.off', 'Off')}</span>
          </label>
        </div>
        <div className="tt-note">
          {t('tattoo.track.note', 'Manual placeholder for camera-driven tracking (not yet implemented). Adjust to simulate compensating for the body part moving slightly.')}
        </div>
        {trackOn && (
          <>
            <div className="tt-row2">
              <NumRow label={t('tattoo.track.dx', 'Offset X')} value={trackDx} onChange={setTrackDx} step={0.1} unit="mm" />
              <NumRow label={t('tattoo.track.dy', 'Offset Y')} value={trackDy} onChange={setTrackDy} step={0.1} unit="mm" />
            </div>
            <NumRow
              label={t('tattoo.track.theta', 'Rotation θ')}
              tip={{ title: t('tattoo.track.theta.tip.title', 'Rotate about centre'), body: t('tattoo.track.theta.tip.body', 'Rotation in degrees applied to the whole path about the design centre (X,Y).') }}
              value={trackTheta}
              onChange={setTrackTheta}
              step={1}
              unit="°"
            />
          </>
        )}
      </section>

      {/* ── Generate ── */}
      <section className="tt-card tt-generate">
        <div className="tt-summary">
          {hasDesign ? t('tattoo.summary.file', 'design: {name}', { name: designName ?? '' }) : t('tattoo.summary.demo', 'design: demo circle')}
          {' · '}
          {isHenna
            ? t('tattoo.summary.henna', 'Henna · PWM {pwm} · {feed} mm/min', { pwm: Math.min(Math.max(hennaPwm, 0), 1000), feed })
            : t('tattoo.summary.needle', 'Tattoo · depth {depth} mm · {feed} mm/min', { depth: Math.min(depth, MAX_DEPTH_MM), feed })}
          {isCyl ? ' · ' + t('tattoo.summary.cyl', 'wrapped (R={r} mm)', { r: cylRadius }) : ''}
          {trackOn ? ' · ' + t('tattoo.summary.track', 'tracking dx{dx} dy{dy} θ{th}°', { dx: trackDx, dy: trackDy, th: trackTheta }) : ''}
        </div>
        <button
          type="button"
          className="tt-gen-btn"
          disabled={!ack}
          onClick={pushToProgram}
          title={ack ? t('tattoo.gen.title', 'Send the conceptual path to the Program tab') : t('tattoo.gen.disabled', 'Acknowledge the experimental notice first')}
        >
          {t('tattoo.gen', 'Generate conceptual path → Program')}
        </button>
        {!ack && <div className="tt-gen-hint">{t('tattoo.gen.hint', 'Tick the safety box above to enable.')}</div>}
      </section>
    </div>
  )
}
