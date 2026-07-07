import { useEffect, useMemo, useRef, useState } from 'react'
import { grbl, type WorkspaceMeasureResult } from '../serial/controller'
import { useConsole, useGrblSettings, useMachine, usePersistentState } from '../store'
import { useBed } from '../store/bed'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
import { LimitConfigModal } from '../components/LimitConfigModal'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Crosshair,
  DoorOpen,
  ScanLine,
  Gauge,
  Ruler,
  Layers,
} from 'lucide-react'
import { IconButton } from '../components/IconButton'
import { SegControl } from '../components/ui/SegControl'
import { SliderField } from '../components/ui/SliderField'
import { useT } from '../i18n'
import {
  defaultProbeParams,
  zTouchProgram,
  edgeProgram,
  cornerProgram,
  boreProgram,
  defaultSurfaceParams,
  surfacingProgram,
  type WizardKind,
  type AxisDir,
  type ProbeParams,
} from '../core/probing'
import {
  probeGrid,
  snakeOrder,
  gridForSpacing,
  defaultSpacing,
  isComplete,
  probedCount,
  zExtent,
  type HeightMap,
  type ProbePoint,
  type ProbeArea,
} from '../core/heightmap'
import { useHeightmap } from '../store/heightmap'
import '../styles/probe.css'

/** Parsed GRBL `[PRB:x,y,z:s]` probe result. `success` is the trailing flag. */
interface ProbeResult {
  x: number
  y: number
  z: number
  success: boolean
}

/** Parse a GRBL `[PRB:0.000,0.000,1.234:1]` line; undefined if it isn't one. */
function parsePrbLine(line: string): ProbeResult | undefined {
  const m = /^\[PRB:(-?\d+\.?\d*),(-?\d+\.?\d*),(-?\d+\.?\d*):([01])\]$/.exec(line.trim())
  if (!m) return undefined
  return {
    x: parseFloat(m[1]),
    y: parseFloat(m[2]),
    z: parseFloat(m[3]),
    success: m[4] === '1',
  }
}

/**
 * Read the configured per-axis max travel ($130–$132) from the settings store
 * AT CALL TIME (not via a render-time closure), so a freshly-synced value is
 * used. Returns undefined per axis if absent / non-numeric / ≤0.
 */
function readTravel(): { x?: number; y?: number; z?: number } {
  const values = useGrblSettings.getState().values
  const pick = (n: number) => {
    const v = values[n]
    if (!v || !Number.isFinite(v.numeric) || v.numeric <= 0) return undefined
    return v.numeric
  }
  return { x: pick(130), y: pick(131), z: pick(132) }
}

/**
 * Probe & Limits panel.
 *
 * Designed beginner-first, expert-deep:
 *  1. Live switch detection — prominent indicator "lights" for X/Y/Z limit
 *     switches, Probe and Door, lit when their letter is present in the GRBL
 *     status report's `Pn:` field (surfaced by the store as `pins: string[]`).
 *     The controller polls status ~5 Hz so these update live; press each switch
 *     by hand to confirm wiring.
 *  2. Z-Probe — G38.2/G38.3 toward the workpiece, then G10 L20 to zero work Z
 *     accounting for a probe-plate thickness. Clear "Probe Z" + "Set Z zero".
 *  3. Advanced: limits & homing — collapsed by default. The GRBL limit/homing
 *     $-setting toggles ($20/$21/$22 + $5/$6 invert masks), Home/Unlock/Sync,
 *     and the caution notes. Novices use detection + probe; experts open this.
 */

/**
 * Letters GRBL reports in `Pn:` and how we label them. `lk`/`sk` are translation
 * keys for the label / sub-label (resolved at render time with the fallbacks).
 */
/** The three limit axes, each with a lucide arrow for its − and + end. The
 *  display shows six directional tiles (X−/X+/Y−/Y+/Z−/Z+); the Probe + Door
 *  inputs render as two aux tiles below. */
const LIMIT_AXES = [
  { axis: 'X', neg: ArrowLeft, pos: ArrowRight },
  { axis: 'Y', neg: ArrowDown, pos: ArrowUp },
  { axis: 'Z', neg: ArrowDown, pos: ArrowUp },
] as const

/** A 0/1 GRBL boolean setting wired to a labelled toggle. */
function BoolSetting({
  num,
  title,
  desc,
  value,
  connected,
}: {
  num: number
  title: string
  desc: string
  value: string | undefined
  connected: boolean
}) {
  const t = useT()
  const on = value !== undefined && parseFloat(value) >= 0.5
  const known = value !== undefined
  const current = known
    ? on
      ? t('probe.bool.on1', 'ON (1)')
      : t('probe.bool.off0', 'OFF (0)')
    : t('probe.bool.unknownSync', 'unknown, Sync first')
  return (
    <div className="pr-field">
      <label htmlFor={`pr-set-${num}`}>
        <span className="pr-num">${num}</span> {title}
        <span className="pr-sub">{desc}</span>
      </label>
      <button
        id={`pr-set-${num}`}
        type="button"
        className="pr-toggle"
        data-on={known ? on : undefined}
        disabled={!connected}
        title={
          connected
            ? t('probe.bool.toggleTip', 'Toggle ${num} ({title}) — currently {current}', {
                num,
                title,
                current,
              })
            : t('probe.bool.connectFirst', 'Connect first')
        }
        onClick={() => {
          grbl.writeSetting(num, on ? 0 : 1).then(() => grbl.readSettings()).catch(() => {})
        }}
      >
        {known ? (on ? t('probe.bool.on', 'ON') : t('probe.bool.off', 'OFF')) : '—'}
      </button>
    </div>
  )
}

/** Read a GRBL numeric setting; returns undefined if absent or non-numeric. */
function settingNumber(
  values: Record<number, { numeric: number } | undefined>,
  n: number,
): number | undefined {
  const v = values[n]
  if (!v || !Number.isFinite(v.numeric)) return undefined
  return v.numeric
}

type T = ReturnType<typeof useT>

// ===========================================================================
// O2 — Probing wizard suite (Z-touch / X-edge / Y-edge / corner / center-bore)
// ===========================================================================

/** Parse a GRBL `[PRB:x,y,z:s]` into machine coords + success. */
function parsePrb(line: string): { x: number; y: number; z: number; ok: boolean } | undefined {
  const r = parsePrbLine(line)
  if (!r) return undefined
  return { x: r.x, y: r.y, z: r.z, ok: r.success }
}

const WIZARD_KINDS: { value: WizardKind; label: string; lk: string }[] = [
  { value: 'z', label: 'Z-touch', lk: 'probe.wiz.z' },
  { value: 'x', label: 'X edge', lk: 'probe.wiz.x' },
  { value: 'y', label: 'Y edge', lk: 'probe.wiz.y' },
  { value: 'corner', label: 'Corner', lk: 'probe.wiz.corner' },
  { value: 'center', label: 'Bore center', lk: 'probe.wiz.center' },
]

/**
 * Guided probing wizard. Builds a safe G38.2 program for the selected routine
 * (always retracts to safe-Z, never crashes the probe) from the live params,
 * shows the exact G-code, and runs it line-by-line when connected. The bore
 * routine collects four touches and offers a "set centre" zero afterward.
 */
function WizardSection({
  t,
  connected,
  machineBusy,
}: {
  t: T
  connected: boolean
  machineBusy: boolean
}) {
  const [kind, setKind] = usePersistentState<WizardKind>('karmyogi.probe.wiz.kind', 'z')
  const [feed, setFeed] = usePersistentState<number>('karmyogi.probe.wiz.feed', 50)
  const [maxTravel, setMaxTravel] = usePersistentState<number>('karmyogi.probe.wiz.travel', 25)
  const [safeZ, setSafeZ] = usePersistentState<number>('karmyogi.probe.wiz.safez', 5)
  const [offset, setOffset] = usePersistentState<number>('karmyogi.probe.wiz.offset', 1)
  const [xDir, setXDir] = usePersistentState<AxisDir>('karmyogi.probe.wiz.xdir', '-')
  const [yDir, setYDir] = usePersistentState<AxisDir>('karmyogi.probe.wiz.ydir', '-')
  const [stepOver, setStepOver] = usePersistentState<number>('karmyogi.probe.wiz.step', 10)

  const params: ProbeParams = defaultProbeParams({ feed, maxTravel, safeZ, offset })
  const program = useMemo(() => {
    switch (kind) {
      case 'z':
        return zTouchProgram(params)
      case 'x':
        return edgeProgram('x', xDir, params)
      case 'y':
        return edgeProgram('y', yDir, params)
      case 'corner':
        return cornerProgram(xDir, yDir, params, stepOver)
      case 'center':
        return boreProgram(params)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, feed, maxTravel, safeZ, offset, xDir, yDir, stepOver])

  const offsetLabel =
    kind === 'z'
      ? t('probe.wiz.plate', 'Plate thickness')
      : t('probe.wiz.radius', 'Tool radius')

  const run = () => {
    if (!connected || machineBusy || !program) return
    // Stream the whole guided program line-by-line; each line is queued so the
    // controller serializes them and the G38.2 touches resolve in order.
    for (const line of program.gcode.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith(';')) continue
      grbl.send(trimmed).catch(() => {})
    }
  }

  return (
    <section className="pr-card">
      <header className="pr-card-head">
        <h4>
          <span className="pr-card-ico" aria-hidden="true"><Icon name="zero" size={13} /></span>
          {t('probe.wiz.title', 'Probing wizard')}
        </h4>
        <span className="pr-raw">{t('probe.wiz.tag', 'guided zero')}</span>
      </header>
      <p className="pr-hint">
        {t('probe.wiz.hint', 'Guided touch-off that sets work zero safely. Every routine retracts to safe-Z and never dives the probe.')}
      </p>
      <SegControl
        ariaLabel={t('probe.wiz.kindAria', 'Probing routine')}
        size="sm"
        options={WIZARD_KINDS.map((k) => ({ value: k.value, label: t(k.lk, k.label) }))}
        value={kind}
        onChange={setKind}
      />
      <div className="pr-wiz-grid">
        <SliderField
          label={t('probe.wiz.feed', 'Probe feed')}
          unit="mm/min"
          min={5}
          max={300}
          step={5}
          value={feed}
          onChange={setFeed}
        />
        <SliderField
          label={t('probe.wiz.travel', 'Max travel')}
          unit="mm"
          min={2}
          max={80}
          step={1}
          value={maxTravel}
          onChange={setMaxTravel}
        />
        <SliderField
          label={t('probe.wiz.safez', 'Safe-Z')}
          unit="mm"
          min={1}
          max={30}
          step={0.5}
          value={safeZ}
          onChange={setSafeZ}
        />
        {kind !== 'center' && (
          <SliderField
            label={offsetLabel}
            unit="mm"
            min={0}
            max={10}
            step={0.1}
            value={offset}
            onChange={setOffset}
          />
        )}
        {(kind === 'x' || kind === 'corner') && (
          <label className="pr-wiz-dir">
            <span className="pr-field-name">{t('probe.wiz.xdir', 'X approach')}</span>
            <SegControl
              ariaLabel={t('probe.wiz.xdirAria', 'X approach direction')}
              size="sm"
              options={[
                { value: '-' as AxisDir, label: t('probe.wiz.minus', '−') },
                { value: '+' as AxisDir, label: t('probe.wiz.plus', '+') },
              ]}
              value={xDir}
              onChange={setXDir}
            />
          </label>
        )}
        {(kind === 'y' || kind === 'corner') && (
          <label className="pr-wiz-dir">
            <span className="pr-field-name">{t('probe.wiz.ydir', 'Y approach')}</span>
            <SegControl
              ariaLabel={t('probe.wiz.ydirAria', 'Y approach direction')}
              size="sm"
              options={[
                { value: '-' as AxisDir, label: t('probe.wiz.minus', '−') },
                { value: '+' as AxisDir, label: t('probe.wiz.plus', '+') },
              ]}
              value={yDir}
              onChange={setYDir}
            />
          </label>
        )}
        {kind === 'corner' && (
          <SliderField
            label={t('probe.wiz.step', 'Step to Y edge')}
            unit="mm"
            min={2}
            max={50}
            step={1}
            value={stepOver}
            onChange={setStepOver}
          />
        )}
      </div>

      {/* Ordered step list — the operator sees exactly what will happen. */}
      <ol className="pr-wiz-steps" aria-label={t('probe.wiz.stepsAria', 'Wizard steps')}>
        {program?.steps.map((s, i) => (
          <li key={i} className={s.isProbe ? 'probe' : s.setsZero ? 'zero' : ''}>
            {s.note}
          </li>
        ))}
      </ol>

      <code className="pr-code" aria-label={t('probe.wiz.codeAria', 'Wizard G-code')}>
        {program?.gcode}
      </code>

      <div className="pr-row">
        <button
          type="button"
          className="pr-btn primary pr-grow"
          disabled={!connected || machineBusy}
          onClick={run}
          title={t('probe.wiz.runTip', 'Stream this guided routine to the machine')}
        >
          <span className="pr-bico" aria-hidden="true"><Icon name="play" size={14} /></span>
          {t('probe.wiz.run', 'Run wizard')}
        </button>
      </div>
      <p className="pr-note caution">
        {t('probe.wiz.safety', 'Clip the probe to the tool and position the bit beside the edge at probing depth before running. The routine alarms (stops) if no contact is found within Max travel — it will not crash the probe.')}
      </p>
    </section>
  )
}

// ===========================================================================
// O1/P1 — Heightmap / auto-level probe (general, in the Probe modal)
// ===========================================================================

type ProbePhase = 'idle' | 'running' | 'done' | 'error'

/**
 * General-purpose heightmap probe: define a rectangular XY area + grid spacing,
 * run a safe G38.2 grid (retract to clearance between every point), and store
 * the resulting surface in the shared heightmap store so any workbench can warp
 * its program. The PCB panel applies the warp; here we collect + show the map.
 */
function HeightmapSection({
  t,
  connected,
  machineBusy,
  machineState,
  bedW,
  bedD,
}: {
  t: T
  connected: boolean
  machineBusy: boolean
  machineState: string
  bedW: number
  bedD: number
}) {
  const map = useHeightmap((s) => s.map)
  const setMap = useHeightmap((s) => s.setMap)
  const clearMap = useHeightmap((s) => s.clearMap)
  const probeFeed = useHeightmap((s) => s.probeFeed)
  const setProbeFeed = useHeightmap((s) => s.setProbeFeed)
  const probeDepth = useHeightmap((s) => s.probeDepth)
  const setProbeDepth = useHeightmap((s) => s.setProbeDepth)
  const probeClearance = useHeightmap((s) => s.probeClearance)
  const setProbeClearance = useHeightmap((s) => s.setProbeClearance)

  // The probe area defaults to the bed; the operator narrows it to the stock.
  const [minX, setMinX] = usePersistentState<number>('karmyogi.probe.hm.minX', 0)
  const [minY, setMinY] = usePersistentState<number>('karmyogi.probe.hm.minY', 0)
  const [w, setW] = usePersistentState<number>('karmyogi.probe.hm.w', Math.min(50, bedW || 50))
  const [d, setD] = usePersistentState<number>('karmyogi.probe.hm.d', Math.min(50, bedD || 50))
  const area: ProbeArea = useMemo(
    () => ({ minX, minY, maxX: minX + Math.max(1, w), maxY: minY + Math.max(1, d) }),
    [minX, minY, w, d],
  )
  const [spacing, setSpacing] = usePersistentState<number>(
    'karmyogi.probe.hm.spacing',
    Math.round(defaultSpacing(area)),
  )
  const grid = useMemo(() => gridForSpacing(area, spacing), [area, spacing])
  const total = grid.nx * grid.ny

  const [phase, setPhase] = useState<ProbePhase>('idle')
  const [status, setStatus] = useState('')
  const [statusErr, setStatusErr] = useState(false)
  const [done, setDone] = useState(0)

  const cycle = useRef<{ seq: ProbePoint[]; idx: number; work: HeightMap; abort: boolean } | null>(
    null,
  )
  const lastSeen = useRef(0)

  const probedNow = map ? probedCount(map) : 0
  const complete = !!map && isComplete(map)
  const z = map ? zExtent(map) : { min: 0, max: 0 }

  const finish = (okFlag: boolean) => {
    const c = cycle.current
    cycle.current = null
    if (!c) return
    if (okFlag) {
      setMap(c.work)
      setPhase('done')
      const e = zExtent(c.work)
      setStatusErr(false)
      setStatus(
        t('probe.hm.done', 'Probed {n} points — surface warp {warp} mm (Z {min}…{max}).', {
          n: c.seq.length,
          warp: (e.max - e.min).toFixed(3),
          min: e.min.toFixed(3),
          max: e.max.toFixed(3),
        }),
      )
    }
  }

  const probeNext = () => {
    const c = cycle.current
    if (!c || c.abort) return
    if (c.idx >= c.seq.length) {
      finish(true)
      return
    }
    const p = c.seq[c.idx]
    setDone(c.idx)
    grbl.send(`G0 Z${probeClearance.toFixed(3)}`).catch(() => {})
    grbl.send(`G0 X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`).catch(() => {})
    grbl.send(`G38.2 Z${(-Math.abs(probeDepth)).toFixed(3)} F${Math.abs(probeFeed)}`).catch(() => {})
  }

  useEffect(() => {
    const entries = useConsole.getState().entries
    lastSeen.current = entries.length ? entries[entries.length - 1].id : 0
    const unsub = useConsole.subscribe((s) => {
      const c = cycle.current
      if (!c || c.abort) return
      for (const e of s.entries) {
        if (e.id <= lastSeen.current) continue
        lastSeen.current = e.id
        if (e.dir !== 'recv') continue
        const prb = parsePrb(e.text)
        if (!prb) continue
        if (!prb.ok) {
          c.abort = true
          cycle.current = null
          setPhase('error')
          setStatusErr(true)
          setStatus(
            t('probe.hm.noContact', 'No contact at point {i} — cycle stopped. Check wiring / Z range.', {
              i: c.idx + 1,
            }),
          )
          return
        }
        const pt = c.seq[c.idx]
        const node = c.work.points.find((n) => n.ix === pt.ix && n.iy === pt.iy)
        // Convert to work frame: WPos = MPos − WCO.
        if (node) node.z = prb.z - useMachine.getState().wco.z
        c.idx++
        grbl.send(`G0 Z${probeClearance.toFixed(3)}`).catch(() => {})
        probeNext()
      }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase === 'running' && machineState === 'Alarm' && cycle.current) {
      cycle.current.abort = true
      cycle.current = null
      setPhase('error')
      setStatusErr(true)
      setStatus(t('probe.hm.alarm', 'Alarmed during probing — Unlock ($X) and check the probe.'))
    }
  }, [machineState, phase, t])

  useEffect(() => {
    if (!connected && cycle.current) {
      cycle.current.abort = true
      cycle.current = null
      setPhase('idle')
    }
  }, [connected])

  const start = () => {
    if (!connected || machineBusy) {
      setStatusErr(true)
      setStatus(t('probe.hm.connectFirst', 'Connect (and free the machine) before probing.'))
      return
    }
    const fresh = probeGrid(area, grid)
    const seq = snakeOrder(fresh)
    cycle.current = { seq, idx: 0, work: fresh, abort: false }
    setDone(0)
    setPhase('running')
    setStatusErr(false)
    setStatus(t('probe.hm.probing', 'Probing {n} points… keep clear. Slow on purpose.', { n: seq.length }))
    probeNext()
  }

  const abort = () => {
    if (cycle.current) cycle.current.abort = true
    cycle.current = null
    setPhase('idle')
    setStatus(t('probe.hm.aborted', 'Probe cycle stopped.'))
    grbl.send(`G0 Z${probeClearance.toFixed(3)}`).catch(() => {})
  }

  const running = phase === 'running'

  return (
    <section className="pr-card">
      <header className="pr-card-head">
        <h4>
          <span className="pr-card-ico" aria-hidden="true"><Icon name="frame" size={13} /></span>
          {t('probe.hm.title', 'Auto-level / heightmap probe')}
        </h4>
        <span className="pr-raw">{t('probe.hm.tag', 'grid → surface')}</span>
      </header>
      <p className="pr-hint">
        {t('probe.hm.hint', 'Probe a grid over an area to map surface tilt/warp. The map is shared with the PCB workbench, which warps cut Z to follow it (bilinear).')}
      </p>
      <div className="pr-wiz-grid">
        <SliderField label={t('probe.hm.minX', 'Origin X')} unit="mm" min={0} max={Math.max(10, bedW || 300)} step={1} value={minX} onChange={setMinX} />
        <SliderField label={t('probe.hm.minY', 'Origin Y')} unit="mm" min={0} max={Math.max(10, bedD || 300)} step={1} value={minY} onChange={setMinY} />
        <SliderField label={t('probe.hm.w', 'Width')} unit="mm" min={2} max={Math.max(10, bedW || 300)} step={1} value={w} onChange={setW} />
        <SliderField label={t('probe.hm.d', 'Depth')} unit="mm" min={2} max={Math.max(10, bedD || 300)} step={1} value={d} onChange={setD} />
        <SliderField label={t('probe.hm.spacing', 'Grid spacing')} unit="mm" min={2} max={50} step={1} value={spacing} onChange={setSpacing} />
        <SliderField label={t('probe.hm.feed', 'Probe feed')} unit="mm/min" min={5} max={300} step={5} value={probeFeed} onChange={setProbeFeed} />
        <SliderField label={t('probe.hm.depth', 'Probe depth')} unit="mm" min={0.5} max={20} step={0.5} value={probeDepth} onChange={setProbeDepth} />
        <SliderField label={t('probe.hm.clear', 'Clearance Z')} unit="mm" min={0.5} max={20} step={0.5} value={probeClearance} onChange={setProbeClearance} />
      </div>
      <p className="pr-hint pr-hm-grid-line">
        {t('probe.hm.gridInfo', 'Grid: {nx} × {ny} = {total} points', { nx: grid.nx, ny: grid.ny, total })}
        {running && ` — ${t('probe.hm.progress', '{done}/{total}', { done, total })}`}
      </p>
      <div className="pr-row">
        {!running ? (
          <button type="button" className="pr-btn primary pr-grow" disabled={!connected || machineBusy} onClick={start} title={t('probe.hm.runTip', 'Run the G38.2 probe grid')}>
            <span className="pr-bico" aria-hidden="true"><Icon name="play" size={14} /></span>
            {t('probe.hm.run', 'Run probe grid')}
          </button>
        ) : (
          <button type="button" className="pr-btn danger pr-grow" onClick={abort}>
            <span className="pr-bico" aria-hidden="true"><Icon name="stop" size={14} /></span>
            {t('probe.hm.stop', 'Stop probing')}
          </button>
        )}
        {map && !running && (
          <IconButton className="pr-icon-btn" icon="✕" label={t('probe.hm.clear2', 'Clear map')} onClick={clearMap} />
        )}
      </div>
      {map && (
        <p className="pr-note" role="status" aria-live="polite">
          {complete
            ? t('probe.hm.mapComplete', '✓ Surface mapped: {n} points, warp {warp} mm (Z {min}…{max}).', {
                n: probedNow,
                warp: (z.max - z.min).toFixed(3),
                min: z.min.toFixed(3),
                max: z.max.toFixed(3),
              })
            : t('probe.hm.mapPartial', '{n} / {total} points probed.', { n: probedNow, total: map.points.length })}
          <span className="pr-sub">{t('probe.hm.applyNote', 'Apply the warp in the PCB workbench (Auto-leveling section).')}</span>
        </p>
      )}
      {status && (
        <p className={`pr-note${statusErr ? ' caution' : ''}`} role="status" aria-live="polite">
          {status}
        </p>
      )}
    </section>
  )
}

// ===========================================================================
// O3 — Surfacing / wasteboard-flatten generator
// ===========================================================================

/** Surfacing toolpath generator: raster a rectangular area to flatten stock. */
function SurfacingSection({
  t,
  connected,
  machineBusy,
  bedW,
  bedD,
}: {
  t: T
  connected: boolean
  machineBusy: boolean
  bedW: number
  bedD: number
}) {
  const [minX, setMinX] = usePersistentState<number>('karmyogi.probe.surf.minX', 0)
  const [minY, setMinY] = usePersistentState<number>('karmyogi.probe.surf.minY', 0)
  const [w, setW] = usePersistentState<number>('karmyogi.probe.surf.w', Math.min(80, bedW || 80))
  const [d, setD] = usePersistentState<number>('karmyogi.probe.surf.d', Math.min(80, bedD || 80))
  const [tool, setTool] = usePersistentState<number>('karmyogi.probe.surf.tool', 6)
  const [stepFrac, setStepFrac] = usePersistentState<number>('karmyogi.probe.surf.step', 0.4)
  const [depth, setDepth] = usePersistentState<number>('karmyogi.probe.surf.depth', 0.5)
  const [dpp, setDpp] = usePersistentState<number>('karmyogi.probe.surf.dpp', 0.3)
  const [feed, setFeed] = usePersistentState<number>('karmyogi.probe.surf.feed', 800)
  const [rpm, setRpm] = usePersistentState<number>('karmyogi.probe.surf.rpm', 12000)
  const [along, setAlong] = usePersistentState<'x' | 'y'>('karmyogi.probe.surf.along', 'x')

  const result = useMemo(() => {
    const params = defaultSurfaceParams({
      toolDiameter: tool,
      stepoverFrac: stepFrac,
      depth,
      depthPerPass: dpp,
      feed,
      rpm,
      along,
    })
    return surfacingProgram(
      { minX, minY, maxX: minX + Math.max(1, w), maxY: minY + Math.max(1, d) },
      params,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minX, minY, w, d, tool, stepFrac, depth, dpp, feed, rpm, along])

  const run = () => {
    if (!connected || machineBusy) return
    for (const line of result.gcode.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith(';')) continue
      grbl.send(trimmed).catch(() => {})
    }
  }

  return (
    <section className="pr-card">
      <header className="pr-card-head">
        <h4>
          <span className="pr-card-ico" aria-hidden="true"><Icon name="jog" size={13} /></span>
          {t('probe.surf.title', 'Surfacing / flatten')}
        </h4>
        <span className="pr-raw">{t('probe.surf.tag', 'face stock')}</span>
      </header>
      <p className="pr-hint">
        {t('probe.surf.hint', 'Raster a flat face across a rectangular area to flatten stock or a wasteboard. Conservative multi-pass, safe-Z between passes.')}
      </p>
      <div className="pr-wiz-grid">
        <SliderField label={t('probe.surf.minX', 'Origin X')} unit="mm" min={0} max={Math.max(10, bedW || 300)} step={1} value={minX} onChange={setMinX} />
        <SliderField label={t('probe.surf.minY', 'Origin Y')} unit="mm" min={0} max={Math.max(10, bedD || 300)} step={1} value={minY} onChange={setMinY} />
        <SliderField label={t('probe.surf.w', 'Width')} unit="mm" min={2} max={Math.max(10, bedW || 300)} step={1} value={w} onChange={setW} />
        <SliderField label={t('probe.surf.d', 'Depth')} unit="mm" min={2} max={Math.max(10, bedD || 300)} step={1} value={d} onChange={setD} />
        <SliderField label={t('probe.surf.tool', 'Tool ⌀')} unit="mm" min={0.5} max={50} step={0.5} value={tool} onChange={setTool} />
        <SliderField label={t('probe.surf.step', 'Stepover')} unit="×⌀" min={0.1} max={0.9} step={0.05} value={stepFrac} onChange={setStepFrac} />
        <SliderField label={t('probe.surf.depth', 'Total depth')} unit="mm" min={0} max={10} step={0.1} value={depth} onChange={setDepth} />
        <SliderField label={t('probe.surf.dpp', 'Depth / pass')} unit="mm" min={0.05} max={5} step={0.05} value={dpp} onChange={setDpp} />
        <SliderField label={t('probe.surf.feed', 'Feed')} unit="mm/min" min={50} max={3000} step={50} value={feed} onChange={setFeed} />
        <SliderField label={t('probe.surf.rpm', 'Spindle')} unit="rpm" min={0} max={30000} step={500} value={rpm} onChange={setRpm} />
        <label className="pr-wiz-dir">
          <span className="pr-field-name">{t('probe.surf.along', 'Raster along')}</span>
          <SegControl
            ariaLabel={t('probe.surf.alongAria', 'Raster direction')}
            size="sm"
            options={[
              { value: 'x' as const, label: 'X' },
              { value: 'y' as const, label: 'Y' },
            ]}
            value={along}
            onChange={setAlong}
          />
        </label>
      </div>
      <p className="pr-hint pr-hm-grid-line">
        {t('probe.surf.stats', '{lines} raster lines × {passes} passes — stepover {so} mm, ~{len} m of cut', {
          lines: result.rasterLines,
          passes: result.passes,
          so: result.stepover.toFixed(2),
          len: (result.cutLength / 1000).toFixed(1),
        })}
      </p>
      <code className="pr-code" aria-label={t('probe.surf.codeAria', 'Surfacing G-code preview')}>
        {result.gcode.split('\n').slice(0, 8).join('\n')}
        {result.gcode.split('\n').length > 8 ? '\n…' : ''}
      </code>
      <div className="pr-row">
        <button
          type="button"
          className="pr-btn primary pr-grow"
          disabled={!connected || machineBusy}
          onClick={run}
          title={t('probe.surf.runTip', 'Stream the surfacing program to the machine')}
        >
          {t('probe.surf.run', '▶ Run surfacing')}
        </button>
      </div>
      <p className="pr-note caution">
        {t('probe.surf.safety', 'Zero Z at the TOP of the stock first. The cutter centre is inset by its radius so the edge just reaches the bounds; passes retract to safe-Z. Set spindle to 0 for a manually-started router.')}
      </p>
    </section>
  )
}

const MEASURE_AXES = [
  { key: 'X', sel: 'karmyogi.probe.measure.x', dflt: true },
  { key: 'Y', sel: 'karmyogi.probe.measure.y', dflt: true },
  { key: 'Z', sel: 'karmyogi.probe.measure.z', dflt: false },
] as const

/** Round to 2 dp, dropping a `-0`. */
const round2 = (n: number) => {
  const r = Math.round(n * 100) / 100
  return r === 0 ? 0 : r
}

/**
 * AUTO BED-SIZE by touching both ends of each selected axis (X then Y then Z, − then
 * +). Drives grbl.measureWorkspace(): each seek is a guarded jog the limit stops at
 * the switch; we read MPos there and compute travel = |max − min|, then write it into
 * the 3D bed size. Needs hard_limits OFF + FluidNC per-direction `LS:` reporting. The
 * machine MOVES — gated behind an inline confirm with an always-available Abort.
 */
function MeasureBedSection({
  t,
  connected,
  machineState,
  limitsLive,
}: {
  t: T
  connected: boolean
  machineState: string
  limitsLive: boolean
}) {
  const [selX, setSelX] = usePersistentState<boolean>(MEASURE_AXES[0].sel, MEASURE_AXES[0].dflt)
  const [selY, setSelY] = usePersistentState<boolean>(MEASURE_AXES[1].sel, MEASURE_AXES[1].dflt)
  const [selZ, setSelZ] = usePersistentState<boolean>(MEASURE_AXES[2].sel, MEASURE_AXES[2].dflt)
  const [feed, setFeed] = usePersistentState<number>('karmyogi.probe.measure.feed', 400)
  const [backoff, setBackoff] = usePersistentState<number>('karmyogi.probe.measure.backoff', 4)
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WorkspaceMeasureResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const sel: Record<'X' | 'Y' | 'Z', boolean> = { X: selX, Y: selY, Z: selZ }
  const setSel: Record<'X' | 'Y' | 'Z', (v: boolean) => void> = { X: setSelX, Y: setSelY, Z: setSelZ }
  const axes = (['X', 'Y', 'Z'] as const).filter((a) => sel[a])

  const idle = machineState === 'Idle' || machineState === 'Jog' || machineState === 'Unknown'
  const canRun = connected && limitsLive && axes.length > 0 && idle && !running

  const run = async () => {
    setConfirming(false)
    setError(null)
    setResult(null)
    setRunning(true)
    setProgress(t('pr.measure.starting', 'Starting…'))
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await grbl.measureWorkspace({
        axes,
        feed,
        backoffMm: backoff,
        signal: ctrl.signal,
        onProgress: (p) => {
          if (p.phase === 'seeking') {
            setProgress(t('pr.measure.seeking', 'Seeking {axis}{edge} limit…', { axis: p.axis, edge: p.edge }))
          } else if (p.phase === 'recorded') {
            setProgress(
              t('pr.measure.recorded', '{axis}{edge} found at {v} mm', {
                axis: p.axis,
                edge: p.edge,
                v: round2(p.value ?? 0),
              }),
            )
          } else if (p.phase === 'axisDone') {
            setProgress(t('pr.measure.axisDone', '{axis} travel = {v} mm', { axis: p.axis, v: round2(p.value ?? 0) }))
          }
        },
      })
      setResult(res)
      const size: { width?: number; depth?: number; height?: number } = {}
      if (res.x) size.width = round2(res.x.travel)
      if (res.y) size.depth = round2(res.y.travel)
      if (res.z) size.height = round2(res.z.travel)
      if (size.width !== undefined || size.depth !== undefined || size.height !== undefined) {
        useBed.getState().setSize(size)
      }
      setProgress(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg === 'aborted' ? t('pr.measure.aborted', 'Aborted — machine stopped.') : msg)
      setProgress(null)
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const abort = () => {
    abortRef.current?.abort()
    grbl.jogCancel().catch(() => {})
  }

  return (
    <section className="pr-card pr-card-wide">
      <header className="pr-card-head">
        <h4>
          <span className="pr-card-ico" aria-hidden="true">
            <Ruler size={13} />
          </span>
          {t('pr.measure.title', 'Measure bed (touch both ends)')}
        </h4>
        <span className="pr-raw">{t('pr.measure.tag', '6 switches → travel')}</span>
      </header>
      <p className="pr-hint">
        {t(
          'pr.measure.hint',
          'Drives each selected axis to BOTH limit switches and measures the real travel between them — more accurate than reading the configured $130–$132. Order: X, then Y, then Z; − end then + end. The machine moves; keep Abort within reach.',
        )}
      </p>

      {/* Axis pick + feeds */}
      <div className="pr-row pr-measure-axes" role="group" aria-label={t('pr.measure.axesAria', 'Axes to measure')}>
        {MEASURE_AXES.map(({ key }) => (
          <button
            key={key}
            type="button"
            className="pr-chip-toggle"
            aria-pressed={sel[key]}
            data-on={sel[key]}
            disabled={running}
            onClick={() => setSel[key](!sel[key])}
            title={t('pr.measure.axisToggle', 'Include {axis} (touch both ends)', { axis: key })}
          >
            {key}
            {key === 'Z' && (
              <span className="pr-chip-sub">{t('pr.measure.zCaution', 'Z− goes down')}</span>
            )}
          </button>
        ))}
      </div>
      <SliderField
        label={t('pr.measure.feed', 'Seek feed')}
        unit="mm/min"
        min={50}
        max={3000}
        step={50}
        value={feed}
        onChange={setFeed}
      />
      <SliderField
        label={t('pr.measure.backoff', 'Back-off')}
        unit="mm"
        min={1}
        max={20}
        step={1}
        value={backoff}
        onChange={setBackoff}
      />

      {/* Not-ready hints */}
      {connected && !limitsLive && (
        <p className="pr-note caution">
          {t(
            'pr.measure.noLs',
            'Needs FluidNC per-direction limit reporting (the LS: status field) so the two ends of an axis can be told apart. Update the controller firmware, then reconnect.',
          )}
        </p>
      )}

      {/* Run / confirm / abort */}
      {running ? (
        <div className="pr-row">
          <button type="button" className="pr-btn danger pr-grow" onClick={abort}>
            {t('pr.measure.abort', '■ Abort — stop the machine')}
          </button>
        </div>
      ) : confirming ? (
        <div className="pr-row pr-confirm" role="alertdialog" aria-label={t('pr.measure.confirmAria', 'Confirm bed measurement')}>
          <span className="pr-confirm-q">
            {t('pr.measure.confirmQ', 'The machine will drive to {n} limit switches at {feed} mm/min. Area clear? hard_limits must be OFF.', {
              n: axes.length * 2,
              feed,
            })}
          </span>
          <button type="button" className="pr-btn danger" onClick={() => void run()}>
            {t('pr.measure.confirmYes', 'Measure now')}
          </button>
          <button type="button" className="pr-btn" onClick={() => setConfirming(false)}>
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      ) : (
        <div className="pr-row">
          <button
            type="button"
            className="pr-btn primary pr-grow"
            disabled={!canRun}
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
            title={
              !connected
                ? t('pr.detect.connectFirst', 'Connect first')
                : !limitsLive
                  ? t('pr.measure.noLsTip', 'Needs FluidNC per-direction LS: reporting')
                  : axes.length === 0
                    ? t('pr.measure.pickAxis', 'Select at least one axis')
                    : t('pr.measure.runTip', 'Touch both ends of each selected axis and set the bed size')
            }
          >
            <Ruler size={14} /> {t('pr.measure.run', 'Measure bed size')}
          </button>
        </div>
      )}

      {/* Live progress */}
      {progress && (
        <p className="pr-note" role="status" aria-live="polite">
          ⟳ {progress}
        </p>
      )}
      {error && (
        <p className="pr-note caution" role="status" aria-live="polite">
          {error}
        </p>
      )}

      {/* Result table */}
      {result && (
        <div className="pr-measure-result" role="status" aria-live="polite">
          {(['x', 'y', 'z'] as const).map((a) =>
            result[a] ? (
              <div className="pr-measure-row" key={a}>
                <span className="pr-measure-axis">{a.toUpperCase()}</span>
                <span className="pr-measure-travel">{round2(result[a]!.travel)} mm</span>
                <span className="pr-measure-range">
                  {round2(result[a]!.min)} → {round2(result[a]!.max)}
                </span>
              </div>
            ) : null,
          )}
          <p className="pr-note pr-detect-result" style={{ margin: '4px 0 0' }}>
            ✓ {t('pr.measure.done', 'Bed size updated from the measured travel.')}
          </p>
        </div>
      )}
    </section>
  )
}

export function ProbePanel() {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const state = useMachine((s) => s.state)
  const pins = useMachine((s) => s.pins)
  // Per-direction limit state from FluidNC's extended status (null on plain GRBL
  // and FluidNC without the 6-pin report → the display falls back to per-axis).
  const limitDirs = useMachine((s) => s.limitDirs)
  const values = useGrblSettings((s) => s.values)
  const loading = useGrblSettings((s) => s.loading)
  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)

  const connected = connection === 'connected'
  // Machine is "busy" (can't accept a new probe / surfacing job) while running,
  // jogging, homing or held — the wizard/heightmap/surfacing buttons gate on this.
  const machineBusy = state === 'Run' || state === 'Jog' || state === 'Home' || state === 'Hold'

  // Probe parameters (persisted so they survive a refresh). Thickness defaults
  // to a common 1 mm touch-plate so a first-time probe doesn't silently zero at
  // the tool tip instead of the plate surface.
  const [feed, setFeed] = usePersistentState<string>('karmyogi.probe.feed', '50')
  const [dist, setDist] = usePersistentState<string>('karmyogi.probe.dist', '20')
  const [thickness, setThickness] = usePersistentState<string>(
    'karmyogi.probe.thickness',
    '1',
  )
  // Advanced section is collapsed by default — novices stay in detection + probe.
  const [advOpen, setAdvOpen] = usePersistentState<boolean>('karmyogi.probe.advOpen', false)
  // Cheap UX state for the last probe action (not persisted).
  const [probed, setProbed] = useState(false)
  // True while a G38 probe move is in flight (between send and its ok/PRB) — used
  // to disable Probe Z / Set Z zero so a second probe can't be fired mid-move.
  const [probing, setProbing] = useState(false)
  // Last parsed [PRB:…] result, shown inline.
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)

  // Auto-sync settings when opened while connected with nothing cached yet, so
  // the limit/homing toggles show real values.
  useEffect(() => {
    if (connected && Object.keys(values).length === 0 && !loading) {
      grbl.readSettings().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const setVal = (n: number) => values[n]?.value

  const num = (s: string, fallback: number) => {
    const v = parseFloat(s)
    return Number.isFinite(v) ? v : fallback
  }

  // The exact commands the buttons will emit, shown live so there are no
  // surprises before a move that lowers the tool into the workpiece.
  const probeDist = Math.abs(num(dist, 20))
  const probeFeed = Math.abs(num(feed, 50))
  const plateT = num(thickness, 0)
  const thicknessZero = plateT === 0
  const probeCmd = `G38.2 Z-${probeDist} F${probeFeed}`
  const zeroCmd = `G10 L20 P0 Z${plateT}`

  const doProbe = (mode: '2' | '3') => {
    if (probing) return
    setProbing(true)
    setProbeResult(null)
    grbl
      .send(`G38.${mode} Z-${probeDist} F${probeFeed}`)
      .then(() => setProbed(true))
      .catch(() => setProbing(false))
  }

  const setZeroWithPlate = () => {
    grbl.send(zeroCmd).catch(() => {})
  }

  // Watch the console for the `[PRB:…]` reply GRBL emits after a G38 probe and
  // surface it inline. Subscribing to the console store keeps the parsing in the
  // serial layer's single source of truth (the controller already pushes the
  // bracketed report there as a `recv` line). We only react to entries newer
  // than the time we mounted/last-probed so stale lines don't re-trigger.
  const lastSeenId = useRef(0)
  useEffect(() => {
    // Start past whatever is already in the log.
    const entries = useConsole.getState().entries
    lastSeenId.current = entries.length ? entries[entries.length - 1].id : 0
    const unsub = useConsole.subscribe((s) => {
      for (const e of s.entries) {
        if (e.id <= lastSeenId.current) continue
        lastSeenId.current = e.id
        if (e.dir !== 'recv') continue
        const prb = parsePrbLine(e.text)
        if (prb) {
          setProbeResult(prb)
          setProbing(false)
        }
      }
    })
    return unsub
  }, [])

  // A probe move ends (for the in-flight guard) on any non-Run/Jog state — the
  // PRB line resolves the success case, but Alarm (no contact within distance)
  // or a return to Idle must also clear the guard so the buttons re-enable.
  useEffect(() => {
    if (!probing) return
    if (state === 'Idle' || state === 'Alarm' || state === 'Door') setProbing(false)
  }, [state, probing])

  // Reset the sticky "probed" flag + in-flight guard whenever the machine
  // alarms (a stale "last probe sent" hint is misleading) — but KEEP the parsed
  // [PRB:…] result: GRBL alarms on a no-contact G38.2 right after sending PRB,
  // and that result is exactly what the operator needs to see.
  useEffect(() => {
    if (state === 'Alarm') {
      setProbed(false)
      setProbing(false)
    }
  }, [state])

  // A dropped connection clears everything — the result no longer applies.
  useEffect(() => {
    if (!connected) {
      setProbed(false)
      setProbeResult(null)
      setProbing(false)
    }
  }, [connected])

  // --- Auto-detect workspace ---------------------------------------------
  // Relevant GRBL settings: $22 homing enable, $21 hard limits, and the
  // configured per-axis max travel $130/$131/$132 (mm). These are what GRBL
  // *thinks* the machine envelope is — accurate only if calibrated.
  const homingOn = settingNumber(values, 22) === 1
  const hardLimitsOn = settingNumber(values, 21) === 1
  const settingsKnown = Object.keys(values).length > 0
  const travelX = settingNumber(values, 130)
  const travelY = settingNumber(values, 131)
  const travelZ = settingNumber(values, 132)
  const haveTravel =
    (travelX ?? 0) > 0 || (travelY ?? 0) > 0 || (travelZ ?? 0) > 0

  // 'idle' | 'confirm' (inline are-you-sure) | 'homing' | 'done' | 'error'
  const [detectPhase, setDetectPhase] = useState<
    'idle' | 'confirm' | 'homing' | 'done' | 'error'
  >('idle')
  const [detectMsg, setDetectMsg] = useState<string | null>(null)
  // Last size we wrote to the bed store, for the "Workspace set to …" readout.
  const [detected, setDetected] = useState<{
    width?: number
    depth?: number
    height?: number
  } | null>(null)
  // True while we're inside the homing flow and waiting for Idle — used by the
  // state-watcher effect so it only reacts to *our* homing cycle.
  const awaitingHome = useRef(false)
  // Set once the machine has actually left Idle (entered Home/Run/Jog) after our
  // $H, so we know the next Idle means "homing finished" — not the Idle we were
  // sitting in when we pressed the button.
  const sawBusy = useRef(false)
  // Fallback timer: if we never observe a Home/Run transition (cycle too fast to
  // catch, or a controller that doesn't surface it), finalize on Idle anyway.
  const homeFallback = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Copy the configured max-travel ($130–$132) into the bed store. Reads the
   * travel from the settings store AT CALL TIME (not via a render-time closure),
   * so a value synced moments earlier — e.g. by the `$$` read kicked off when
   * homing started — is the one applied. Skips any axis whose value is missing
   * or 0 (uncalibrated), warning if it had to. Returns the size written.
   */
  const applyTravelToBed = (): {
    width?: number
    depth?: number
    height?: number
  } => {
    const travel = readTravel()
    const size: { width?: number; depth?: number; height?: number } = {}
    const skipped: string[] = []
    if ((travel.x ?? 0) > 0) size.width = travel.x
    else skipped.push(t('probe.axis.x130', 'X ($130)'))
    if ((travel.y ?? 0) > 0) size.depth = travel.y
    else skipped.push(t('probe.axis.y131', 'Y ($131)'))
    if ((travel.z ?? 0) > 0) size.height = travel.z
    else skipped.push(t('probe.axis.z132', 'Z ($132)'))
    if (size.width !== undefined || size.depth !== undefined || size.height !== undefined) {
      useBed.getState().setSize(size)
    }
    setDetected(size)
    if (skipped.length) {
      setDetectMsg(
        t(
          'pr.detect.skipped',
          'Skipped {axes} — set to 0 or unknown. Calibrate max travel in Motion settings.',
          { axes: skipped.join(', ') },
        ),
      )
    }
    return size
  }

  /** Movement-free: just copy $130–$132 into the bed size. */
  const useConfiguredTravel = () => {
    if (!settingsKnown) {
      // Pull settings first if we have a connection but no cache yet.
      if (connected) grbl.readSettings().catch(() => {})
      setDetectPhase('error')
      setDetectMsg(
        t('pr.detect.noSettings', 'GRBL settings not read yet — press Sync, then retry.'),
      )
      return
    }
    if (!haveTravel) {
      setDetectPhase('error')
      setDetectMsg(
        t(
          'pr.detect.noTravel',
          'No usable max travel ($130–$132). Set them in Motion settings first.',
        ),
      )
      return
    }
    setDetectMsg(null)
    applyTravelToBed()
    setDetectPhase('done')
  }

  /** Tear down the homing watch (flags + fallback timer). */
  const endHomingWatch = () => {
    awaitingHome.current = false
    sawBusy.current = false
    if (homeFallback.current !== null) {
      clearTimeout(homeFallback.current)
      homeFallback.current = null
    }
  }

  /** Homing finished and the machine is Idle — learn the travel into the bed. */
  const finishHoming = () => {
    endHomingWatch()
    // Re-read travel from the (possibly just-synced) store at apply time.
    const size = applyTravelToBed()
    const wrote =
      size.width !== undefined || size.depth !== undefined || size.height !== undefined
    setDetectPhase(wrote ? 'done' : 'error')
    if (!wrote) {
      setDetectMsg(
        t(
          'pr.detect.noTravelAfter',
          'Homed, but no usable max travel ($130–$132) to learn. Set them in Motion settings.',
        ),
      )
    }
  }

  /** Start the home-then-learn flow (after the inline confirm). */
  const confirmAutoDetect = () => {
    setDetectPhase('homing')
    setDetectMsg(t('pr.detect.homing', 'Homing… keep clear of the machine.'))
    setDetected(null)
    awaitingHome.current = true
    sawBusy.current = false
    // Make sure we have fresh settings to read travel from once homing ends.
    grbl.readSettings().catch(() => {})
    grbl.home().catch((err: unknown) => {
      endHomingWatch()
      setDetectPhase('error')
      setDetectMsg(
        t('pr.detect.homeErr', 'Homing failed to start: {err}', {
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    })
    // Fallback: if we never observe a Home/Run transition (homing cycle too
    // brief to catch, or a controller — like the mock — that stays Idle through
    // an instant `ok`), finalize on the current Idle after a short grace period.
    if (homeFallback.current !== null) clearTimeout(homeFallback.current)
    homeFallback.current = setTimeout(() => {
      if (awaitingHome.current && useMachine.getState().state === 'Idle') finishHoming()
    }, 2500)
  }

  // Watch the machine state during our homing cycle. A real GRBL goes
  // Idle → Home → Idle on a clean cycle, or Alarm if a switch wasn't found.
  // We only treat Idle as "done" once we've seen the machine leave Idle (so the
  // Idle we started from doesn't false-trigger); a fallback timer covers the
  // case where that transition is too fast to observe.
  useEffect(() => {
    if (!awaitingHome.current) return
    if (state === 'Alarm') {
      endHomingWatch()
      setDetectPhase('error')
      setDetectMsg(
        t('pr.detect.alarm', 'Alarm during homing — check switches, then Unlock ($X) and retry.'),
      )
      return
    }
    // Only HOMING-related busy states count as "our cycle is running". A manual
    // Jog while we wait must NOT mark us busy — otherwise the Jog→Idle that
    // follows would false-finish the auto-home before homing ever started.
    if (state === 'Home' || state === 'Run') {
      sawBusy.current = true
      return
    }
    if (state === 'Idle' && sawBusy.current) {
      finishHoming()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Clean up the fallback timer if the panel unmounts mid-homing.
  useEffect(() => endHomingWatch, [])

  const pinSet = new Set(pins)
  // "Identify" mode arms the tiles: press a physical switch and its tile lights so
  // you can confirm the axis + wiring (the safe, no-config half of auto-rebind).
  const [identify, setIdentify] = useState(false)
  // ── Gamepad-style switch rebinding ──────────────────────────────────────────
  // `limitBind[tile] = source` remaps which REPORTED limit lights a given DISPLAY
  // tile (so a mis-wired switch can be corrected in software without touching the
  // FluidNC config — empty map = identity). Persisted. `rebind` enters rebind mode;
  // `arming` is the tile waiting for a press (exactly like the gamepad's capture).
  const [limitBind, setLimitBind] = usePersistentState<Record<string, string>>(
    'karmyogi.probe.limitBind',
    {},
  )
  const [rebind, setRebind] = useState(false)
  const [arming, setArming] = useState<string | null>(null)
  // Controller-side limit-pin config editor (FluidNC config.yaml read/write).
  const [showLimitConfig, setShowLimitConfig] = useState(false)
  // Limit-aware jogging: karmyogi blocks jogging INTO a triggered limit (other 5
  // directions still work, no controller alarm). Read by controller.jog via the
  // same localStorage key. Default on.
  const [jogGuard, setJogGuard] = usePersistentState<boolean>('karmyogi.jog.limitGuard', true)
  // The RAW limit sources currently triggered, as tokens the rebind maps from:
  //  • per-direction LS tokens (X-,X+,Y-,Y+,Z-,Z+) when the firmware reports them,
  //  • PLUS the Pn limit AXIS letters (X,Y,Z,A,B,C). Many machines wire the six
  //    switches as six separate AXES (each reported as X/Y/Z/A/B/C), so those must
  //    be detectable + bindable too — not just the X/Y/Z neg/pos ends.
  const rawActive = useMemo(() => {
    const s = new Set<string>()
    if (limitDirs) for (const d of limitDirs) s.add(d)
    for (const p of pins) if ('XYZABC'.includes(p)) s.add(p)
    return s
  }, [limitDirs, pins])
  // Is a (bound) source triggered? Direct hit on a reported token; a direction
  // tile with NO LS still falls back to its own axis pin (both ends share it).
  const rawOn = (source: string) => {
    if (rawActive.has(source)) return true
    if (!limitDirs && /[+-]$/.test(source)) return pinSet.has(source[0])
    return false
  }
  // A display tile is on when its (possibly remapped) source is triggered.
  const dirOn = (axis: string, dir: '-' | '+') => {
    const tile = axis + dir
    return rawOn(limitBind[tile] ?? tile)
  }
  const limTip = (axis: string, dir: '-' | '+', on: boolean) => {
    const tile = axis + dir
    const src = limitBind[tile]
    const base = t('probe.switch.limTip', '{axis}{dir} limit — {state}', {
      axis,
      dir: dir === '-' ? '−' : '+',
      state: on
        ? t('probe.switch.triggered', 'TRIGGERED')
        : t('probe.switch.open', 'open'),
    })
    return src && src !== tile
      ? base + t('probe.switch.boundTo', ' (bound to {src})', { src })
      : base
  }
  // Capture: while a tile is armed, the first newly-triggered raw source (rising
  // edge — an LS end OR a Pn axis letter like A/B/C) binds to it. The gamepad
  // arm-then-press flow, so any wiring (incl. 6-axis limit configs) can be mapped.
  const prevRaw = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (arming) {
      for (const tok of rawActive) {
        if (!prevRaw.current.has(tok)) {
          setLimitBind((m) => ({ ...m, [arming]: tok }))
          setArming(null)
          break
        }
      }
    }
    prevRaw.current = new Set(rawActive)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawActive, arming])

  return (
    <div className="pr-panel" aria-label={t('probe.aria.panel', 'Probe and limits')}>
      <p className="pr-intro">
        {t(
          'probe.intro',
          'Find Z=0 with a touch probe, and watch your limit / probe switches live. Advanced GRBL limit & homing settings are tucked below.',
        )}
      </p>

      <div className="pr-cards">
      {/* 1. Live limit switches — the hero. Six directional tiles (X−/X+/Y−/Y+/
          Z−/Z+) + Probe + Door that glow + shimmer when triggered, plus an
          "Identify" mode to confirm wiring by pressing each switch. */}
      <section className="pr-card pr-card-wide pr-switch-card">
        <header className="pr-card-head">
          <h4>
            <span className="pr-card-ico" aria-hidden="true"><Icon name="probe" size={13} /></span>
            {t('probe.switch.title', 'Live limit switches')}
          </h4>
          <div className="pr-switch-tools">
            <button
              type="button"
              className="pr-identify-btn"
              data-on={identify}
              onClick={() => {
                setIdentify((v) => !v)
                setRebind(false)
                setArming(null)
              }}
              title={t('probe.switch.identifyTip', 'Identify mode — press each physical switch by hand and watch its tile light up to confirm the axis + wiring.')}
            >
              <ScanLine size={14} />
              {identify ? t('probe.switch.identifyOn', 'Identifying…') : t('probe.switch.identify', 'Identify')}
            </button>
            <button
              type="button"
              className="pr-identify-btn"
              data-on={rebind}
              onClick={() => {
                setRebind((v) => !v)
                setIdentify(false)
                setArming(null)
              }}
              title={t('probe.switch.rebindTip', 'Rebind — like gamepad mapping: click a tile, then press its physical switch to assign it. Corrects mis-wired switches in software.')}
            >
              <Crosshair size={14} />
              {rebind ? t('probe.switch.rebindOn', 'Rebinding…') : t('probe.switch.rebind', 'Rebind')}
            </button>
            {Object.keys(limitBind).length > 0 && (
              <button
                type="button"
                className="pr-identify-btn"
                onClick={() => {
                  setLimitBind({})
                  setArming(null)
                }}
                title={t('probe.switch.resetBindTip', 'Clear all switch rebindings (back to direct X−/X+ mapping)')}
              >
                {t('probe.switch.resetBind', 'Reset')}
              </button>
            )}
            {connected && grbl.supportsSdCard && (
              <button
                type="button"
                className="pr-identify-btn"
                onClick={() => setShowLimitConfig(true)}
                title={t('probe.switch.pinsTip', 'Edit the controller’s limit pins (config.yaml) — swap −↔+ or reassign a pin, then write + restart')}
              >
                <Icon name="settings" size={13} />
                {t('probe.switch.pins', 'Pins')}
              </button>
            )}
            <button
              type="button"
              className="pr-identify-btn"
              data-on={jogGuard}
              onClick={() => setJogGuard((v) => !v)}
              title={t('probe.switch.jogGuardTip', 'Limit-aware jogging — stop jogging INTO a triggered limit (the other 5 directions keep working, no alarm). Needs hard_limits OFF on the controller.')}
            >
              <Icon name="warning" size={13} />
              {jogGuard ? t('probe.switch.jogGuardOn', 'Jog-guard on') : t('probe.switch.jogGuardOff', 'Jog-guard off')}
            </button>
            <span className="pr-raw">
              Pn:&nbsp;<b>{pins.length ? pins.join('') : '—'}</b>
            </span>
          </div>
        </header>
        <p className="pr-hint">
          {rebind
            ? arming
              ? t('probe.switch.rebindArmed', 'Now press the physical {tile} switch — it will bind to this tile.', { tile: arming.replace('-', '−') })
              : t('probe.switch.rebindHint', 'Click a tile, then press the physical switch you want it to map to (gamepad-style).')
            : identify
              ? t('probe.switch.identifyHint', 'Press each switch by hand — its tile lights so you can confirm the axis + wiring.')
              : t('probe.switch.hint', 'Press a switch by hand — it lights up here.')}
        </p>
        <div className="pr-limgrid" role="group" aria-label={t('probe.switch.pinsAria', 'Input pin states')}>
          {LIMIT_AXES.map(({ axis, neg: Neg, pos: Pos }) => {
            const cell = (dir: '-' | '+', Ico: typeof Neg) => {
              const tile = axis + dir
              const on = dirOn(axis, dir)
              const bound = limitBind[tile] && limitBind[tile] !== tile ? limitBind[tile] : null
              return (
                <div
                  className={
                    'pr-lim' +
                    (on ? ' is-on' : '') +
                    (identify && !rebind ? ' is-arm' : '') +
                    (rebind ? ' is-rebind' : '') +
                    (arming === tile ? ' is-arming' : '') +
                    (bound ? ' is-bound' : '')
                  }
                  data-on={on}
                  onClick={rebind ? () => setArming((a) => (a === tile ? null : tile)) : undefined}
                  title={limTip(axis, dir, on)}
                >
                  <Ico size={17} className="pr-lim-ico" aria-hidden="true" />
                  <span className="pr-lim-lbl">{axis}{dir === '-' ? '−' : '+'}</span>
                  {arming === tile ? (
                    <span className="pr-lim-press">{t('probe.switch.press', 'press…')}</span>
                  ) : bound ? (
                    <span className="pr-lim-bound">⇐ {bound.replace('-', '−')}</span>
                  ) : null}
                </div>
              )
            }
            return (
              <div className="pr-limrow" key={axis}>
                <span className="pr-limaxis" aria-hidden="true">{axis}</span>
                {cell('-', Neg)}
                {cell('+', Pos)}
              </div>
            )
          })}
        </div>
        <div className="pr-auxrow">
          <div
            className={`pr-lim pr-lim-aux${pinSet.has('P') ? ' is-on' : ''}${identify ? ' is-arm' : ''}`}
            data-on={pinSet.has('P')}
            title={t('probe.switch.probeTip', 'Probe input (P) — {state}', { state: pinSet.has('P') ? t('probe.switch.triggered', 'TRIGGERED') : t('probe.switch.open', 'open') })}
          >
            <Crosshair size={16} className="pr-lim-ico" aria-hidden="true" />
            <span className="pr-lim-lbl">{t('probe.pin.probe', 'Probe')}</span>
          </div>
          <div
            className={`pr-lim pr-lim-aux door${pinSet.has('D') ? ' is-on' : ''}${identify ? ' is-arm' : ''}`}
            data-on={pinSet.has('D')}
            title={t('probe.switch.doorTip', 'Safety door (D) — {state}', { state: pinSet.has('D') ? t('probe.switch.triggered', 'TRIGGERED') : t('probe.switch.open', 'open') })}
          >
            <DoorOpen size={16} className="pr-lim-ico" aria-hidden="true" />
            <span className="pr-lim-lbl">{t('probe.pin.door', 'Door')}</span>
          </div>
        </div>
        {limitDirs === null && connected && (
          <p className="pr-note">
            {t('probe.switch.fallbackNote', 'Limits report per-axis (e.g. X Y Z A B C). If a switch lights the wrong tile — or your six switches are wired as separate axes — use Rebind to map each physical switch to a tile. Flash the FluidNC LS build for automatic per-direction X−/X+.')}
          </p>
        )}
        {!connected && (
          <p className="pr-note">{t('probe.switch.connectNote', 'Connect to a GRBL device to see live pin states.')}</p>
        )}
      </section>

      {/* 2. Z-Probe — simple Probe Z + Set Z zero. */}
      <section className="pr-card">
        <header className="pr-card-head">
          <h4>
            <span className="pr-card-ico" aria-hidden="true"><Icon name="probe" size={13} /></span>
            {t('probe.z.title', 'Z-Probe')}
          </h4>
          <span className="pr-raw">{t('probe.z.tag', 'touch off Z')}</span>
        </header>
        <div className="pr-fields">
          <label htmlFor="pr-feed">
            <span className="pr-field-name">
              <Gauge size={13} className="pr-fld-ico" aria-hidden="true" />
              {t('probe.z.speed', 'Probe speed')}
              <InfoTip topic="probeFeed" />
              <span className="pr-units">mm/min</span>
            </span>
            <input
              id="pr-feed"
              className="pr-input"
              type="text"
              inputMode="decimal"
              value={feed}
              disabled={!connected}
              onChange={(e) => setFeed(e.target.value)}
              aria-label={t('probe.z.speedAria', 'Probe speed (mm/min)')}
            />
            <span className="pr-sub">{t('probe.z.speedSub', 'how fast to lower toward the workpiece')}</span>
          </label>
          <label htmlFor="pr-dist">
            <span className="pr-field-name">
              <Ruler size={13} className="pr-fld-ico" aria-hidden="true" />
              {t('probe.z.maxDist', 'Max distance')}
              <InfoTip topic="probeDistance" />
              <span className="pr-units">mm</span>
            </span>
            <input
              id="pr-dist"
              className="pr-input"
              type="text"
              inputMode="decimal"
              value={dist}
              disabled={!connected}
              onChange={(e) => setDist(e.target.value)}
              aria-label={t('probe.z.maxDistAria', 'Max probe distance (mm)')}
            />
            <span className="pr-sub">{t('probe.z.maxDistSub', 'give up if no contact within this far')}</span>
          </label>
          <label htmlFor="pr-thick">
            <span className="pr-field-name">
              <Layers size={13} className="pr-fld-ico" aria-hidden="true" />
              {t('probe.z.plate', 'Plate thickness')}
              <InfoTip topic="workZero" />
              <span className="pr-units">mm</span>
            </span>
            <input
              id="pr-thick"
              className="pr-input"
              type="text"
              inputMode="decimal"
              value={thickness}
              disabled={!connected}
              onChange={(e) => setThickness(e.target.value)}
              aria-label={t('probe.z.plateAria', 'Plate thickness (mm)')}
              aria-invalid={thicknessZero || undefined}
            />
            <span className={`pr-sub${thicknessZero ? ' warn' : ''}`}>
              {thicknessZero
                ? t('probe.z.plateZeroWarn', 'thickness is 0 — Z will zero at the tool tip, not the plate surface')
                : t('probe.z.plateSub', 'thickness of the probe / touch plate')}
            </span>
          </label>
        </div>
        <div className="pr-row">
          <button
            type="button"
            className="pr-btn primary pr-grow"
            disabled={!connected || probing}
            onClick={() => doProbe('2')}
            title={t('probe.z.probeTip', 'G38.2 Z- F — lower the tool until it touches the plate. Alarms if no contact within the max distance.')}
          >
            <span className="pr-bico" aria-hidden="true"><Icon name="probe" size={14} /></span>
            {probing ? t('probe.z.probing', 'Probing…') : t('probe.z.probe', 'Probe Z')}
          </button>
          <button
            type="button"
            className="pr-btn pr-grow"
            disabled={!connected || probing}
            onClick={setZeroWithPlate}
            title={t('probe.z.setZeroTip', 'G10 L20 P0 Z<thickness> — set work Z=0 at the plate surface. Run after a successful probe.')}
          >
            <span className="pr-bico" aria-hidden="true"><Icon name="zero" size={14} /></span>
            {t('probe.z.setZero', 'Set Z zero')}
          </button>
        </div>
        <div className="pr-row pr-mini-row" role="group" aria-label={t('probe.z.miniGroupAria', 'Secondary probe actions')}>
          <IconButton
            className="pr-icon-btn"
            icon="⤓"
            label={`${t('probe.z.noAlarm', 'Probe (no alarm)')} — ${t('probe.z.noAlarmTip', 'G38.3 Z- F — probe toward the workpiece, but do NOT alarm if no contact is made.')}`}
            disabled={!connected || probing}
            onClick={() => doProbe('3')}
          />
          <IconButton
            className="pr-icon-btn"
            icon="#"
            label={`${t('probe.z.lastProbe', 'Show last probe ($#)')} — ${t('probe.z.lastProbeTip', '$# — dump coordinate systems incl. PRB (last probe result) to the console')}`}
            disabled={!connected}
            onClick={() => grbl.send('$#').catch(() => {})}
          />
        </div>
        {/* Live G-code — exactly what the buttons send, so there's no surprise. */}
        <code className="pr-code" aria-label={t('probe.z.codeAria', 'G-code these buttons send')}>
          {probeCmd}
          <span className="pr-code-cmt">{'  ; Probe Z'}</span>
          {'\n'}
          {zeroCmd}
          <span className="pr-code-cmt">{'  ; Set Z zero'}</span>
        </code>
        {/* Inline last-probe result, parsed from GRBL's [PRB:…] reply. */}
        {probeResult && (
          <p
            className={`pr-note pr-prb${probeResult.success ? ' ok' : ' caution'}`}
            role="status"
            aria-live="polite"
          >
            {probeResult.success
              ? t('probe.z.prbOk', 'Probe contact at Z {z} (machine).', {
                  z: probeResult.z.toFixed(3),
                })
              : t('probe.z.prbFail', 'No probe contact (PRB reported failure) at Z {z}.', {
                  z: probeResult.z.toFixed(3),
                })}
            <span className="pr-sub">
              {t('probe.z.prbCoords', 'X {x}  Y {y}  Z {z}', {
                x: probeResult.x.toFixed(3),
                y: probeResult.y.toFixed(3),
                z: probeResult.z.toFixed(3),
              })}
            </span>
          </p>
        )}
        <p className="pr-note caution">
          {t('probe.z.safetyLead', 'Safety:')} <b>{t('probe.z.probe', 'Probe Z')}</b>{' '}
          {t('probe.z.safety1', 'lowers the tool — clip the probe clip to the tool and rest the plate on the workpiece first. 1) Place the plate. 2)')}{' '}
          <b>{t('probe.z.probe', 'Probe Z')}</b>{' '}
          {t('probe.z.safety2', 'stops on contact (shows as')} <b>P</b> {t('probe.z.safety3', 'in the lights above). 3)')}{' '}
          <b>{t('probe.z.setZero', 'Set Z zero')}</b>{' '}
          {t('probe.z.safety4', 'writes')} <code>{zeroCmd}</code> {t('probe.z.safety5', 'so Z=0 sits at the plate surface.')}
          {probed && ' ' + t('probe.z.lastSent', 'Last probe sent — check the console / "Show last probe".')}
        </p>
      </section>

      {/* O2 — guided probing wizard (Z / X / Y / corner / center). */}
      <WizardSection t={t} connected={connected} machineBusy={machineBusy} />

      {/* O1/P1 — auto-level / heightmap grid probe. */}
      <HeightmapSection
        t={t}
        connected={connected}
        machineBusy={machineBusy}
        machineState={state}
        bedW={bedW}
        bedD={bedD}
      />

      {/* O3 — surfacing / wasteboard flatten generator. */}
      <SurfacingSection t={t} connected={connected} machineBusy={machineBusy} bedW={bedW} bedD={bedD} />

      {/* 2.4 Measure bed by touching both ends of each axis (the most accurate, and
          the reason individual limit switches matter). */}
      <MeasureBedSection t={t} connected={connected} machineState={state} limitsLive={limitDirs !== null} />

      {/* 2.5 Auto-detect workspace — home, then learn the work-area size. */}
      <section className="pr-card">
        <header className="pr-card-head">
          <h4>
            <span className="pr-card-ico" aria-hidden="true"><Icon name="home" size={13} /></span>
            {t('pr.detect.title', 'Auto-detect workspace')}
          </h4>
          <span className="pr-raw">{t('pr.detect.tag', 'home → bed size')}</span>
        </header>
        <p className="pr-hint">
          {t(
            'pr.detect.hint',
            'Home the machine on its limit switches, then learn the work-area size from GRBL’s configured max travel. This drives the 3D bed grid and bed-fit checks.',
          )}
        </p>

        {/* Status line: homing/limits + configured travel. */}
        <div className="pr-detect-status" role="group" aria-label={t('probe.detectStatus.aria', 'Workspace detection status')}>
          <span className="pr-chip" data-on={settingsKnown ? homingOn : undefined}>
            {t('pr.detect.homingChip', 'Homing $22')}:{' '}
            <b>
              {!settingsKnown
                ? t('pr.detect.unknown', '?')
                : homingOn
                  ? t('pr.detect.on', 'ON')
                  : t('pr.detect.off', 'OFF')}
            </b>
          </span>
          <span className="pr-chip" data-on={settingsKnown ? hardLimitsOn : undefined}>
            {t('pr.detect.limitsChip', 'Hard limits $21')}:{' '}
            <b>
              {!settingsKnown
                ? t('pr.detect.unknown', '?')
                : hardLimitsOn
                  ? t('pr.detect.on', 'ON')
                  : t('pr.detect.off', 'OFF')}
            </b>
          </span>
          <span className="pr-chip mono" data-on={settingsKnown ? haveTravel : undefined}>
            {t('pr.detect.travelChip', 'Travel $130–$132')}:{' '}
            <b>
              {settingsKnown
                ? `${travelX ?? '?'} × ${travelY ?? '?'} × ${travelZ ?? '?'} mm`
                : t('pr.detect.unknown', '?')}
            </b>
          </span>
        </div>

        {/* Friendly hint when homing/limits aren't ready. */}
        {(!settingsKnown || !homingOn) && (
          <p className="pr-note caution">
            {t(
              'pr.detect.needHoming',
              'Auto-home needs homing enabled. Open Motion / GRBL settings (⚙) and set $22=1 (homing) and wire your limit switches first.',
            )}
          </p>
        )}

        {/* Primary action — gated behind an inline confirm (it MOVES the machine). */}
        {detectPhase !== 'confirm' ? (
          <div className="pr-row">
            <button
              type="button"
              className="pr-btn primary pr-grow"
              disabled={!connected || !homingOn || detectPhase === 'homing'}
              onClick={() => {
                setDetectMsg(null)
                setDetectPhase('confirm')
              }}
              title={
                !connected
                  ? t('pr.detect.connectFirst', 'Connect first')
                  : !homingOn
                    ? t('pr.detect.enableHomingFirst', 'Enable homing ($22=1) first')
                    : t(
                        'pr.detect.autoTip',
                        '$H homing cycle, then read $130–$132 into the bed size. Moves the machine.',
                      )
              }
            >
              {detectPhase === 'homing'
                ? t('pr.detect.homingBtn', '⟳ Homing…')
                : t('pr.detect.autoBtn', '⌖ Auto-detect workspace')}
            </button>
          </div>
        ) : (
          <div className="pr-row pr-confirm" role="alertdialog" aria-label={t('probe.confirmHoming.aria', 'Confirm homing')}>
            <span className="pr-confirm-q">
              {t('pr.detect.confirmQ', 'This will home the machine — keep clear. Continue?')}
            </span>
            <button
              type="button"
              className="pr-btn danger"
              onClick={confirmAutoDetect}
              title={t('pr.detect.confirmYesTip', 'Send $H and learn the workspace size')}
            >
              {t('pr.detect.confirmYes', 'Home & detect')}
            </button>
            <button
              type="button"
              className="pr-btn"
              onClick={() => setDetectPhase('idle')}
              title={t('pr.detect.confirmNoTip', 'Cancel — do not move the machine')}
            >
              {t('pr.detect.confirmNo', 'Cancel')}
            </button>
          </div>
        )}

        {/* Secondary, movement-free action. */}
        <div className="pr-row">
          <button
            type="button"
            className="pr-btn pr-grow pr-btn-sm"
            disabled={!settingsKnown || !haveTravel}
            onClick={useConfiguredTravel}
            title={t(
              'pr.detect.useTravelTip',
              'Copy the configured max travel ($130–$132) into the bed size. Does NOT move the machine.',
            )}
          >
            {t('pr.detect.useTravelBtn', '⤓ Use configured travel ($130–$132)')}
          </button>
        </div>

        {/* Progress / result message. */}
        {detectMsg && (
          <p
            className={`pr-note${detectPhase === 'error' ? ' caution' : ''}`}
            role="status"
            aria-live="polite"
          >
            {detectMsg}
          </p>
        )}

        {/* Detected-size readout + provenance. */}
        {detectPhase === 'done' && detected && (
          <p className="pr-note pr-detect-result" role="status" aria-live="polite">
            ✓{' '}
            {t('pr.detect.result', 'Workspace set to {w} × {d} × {h} mm', {
              w: detected.width ?? bedW,
              d: detected.depth ?? bedD,
              h: detected.height ?? bedH,
            })}
            <span className="pr-sub">
              {t(
                'pr.detect.provenance',
                'From GRBL’s configured max travel ($130–$132) — accurate only if those are calibrated to the real machine.',
              )}
            </span>
          </p>
        )}
      </section>

      {/* 3. Advanced: limits & homing — collapsed by default. */}
      <section className="pr-card pr-card-wide">
        <button
          type="button"
          className="pr-disclosure"
          aria-expanded={advOpen}
          aria-controls="pr-adv-body"
          onClick={() => setAdvOpen(!advOpen)}
        >
          <span className="pr-caret" aria-hidden="true">
            {advOpen ? '▾' : '▸'}
          </span>
          <span className="pr-disclosure-title">{t('probe.adv.title', 'Advanced: limits & homing')}</span>
          <span className="pr-disclosure-hint">
            {advOpen ? t('probe.adv.hide', 'hide') : t('probe.adv.settings', 'GRBL $-settings')}
          </span>
        </button>
        {advOpen && (
          <div id="pr-adv-body" className="pr-adv-body">
            <BoolSetting
              num={20}
              title={t('probe.adv.softLimits', 'Soft limits')}
              desc={t('probe.adv.softLimitsDesc', 'refuse moves past $130–$132 max travel (needs homing)')}
              value={setVal(20)}
              connected={connected}
            />
            <BoolSetting
              num={21}
              title={t('probe.adv.hardLimits', 'Hard limits')}
              desc={t('probe.adv.hardLimitsDesc', 'stop on a limit switch trigger (needs switches wired)')}
              value={setVal(21)}
              connected={connected}
            />
            <BoolSetting
              num={22}
              title={t('probe.adv.homingEnable', 'Homing enable')}
              desc={t('probe.adv.homingEnableDesc', 'allow the $H homing cycle')}
              value={setVal(22)}
              connected={connected}
            />
            <BoolSetting
              num={5}
              title={t('probe.adv.limitInvert', 'Limit pins invert')}
              desc={t('probe.adv.limitInvertDesc', 'invert limit inputs — set ON for NC (normally-closed) switches')}
              value={setVal(5)}
              connected={connected}
            />
            <BoolSetting
              num={6}
              title={t('probe.adv.probeInvert', 'Probe pin invert')}
              desc={t('probe.adv.probeInvertDesc', 'invert the probe input')}
              value={setVal(6)}
              connected={connected}
            />
            <div className="pr-row pr-adv-actions" role="group" aria-label={t('probe.adv.actionsAria', 'Homing actions')}>
              <button
                type="button"
                className="pr-btn primary pr-grow"
                disabled={!connected}
                onClick={() => grbl.home().catch(() => {})}
                title={t('probe.adv.homeTip', '$H — run the homing cycle')}
              >
                {t('probe.adv.home', 'Home ($H)')}
              </button>
              {(['X', 'Y', 'Z'] as const).map((ax) => (
                <button
                  key={ax}
                  type="button"
                  className="pr-btn pr-btn-sm"
                  disabled={!connected}
                  onClick={() => grbl.homeAxis(ax).catch(() => {})}
                  title={t('probe.adv.homeAxisTip', 'Home just the {axis} axis ($H{axis})', { axis: ax })}
                >
                  {t('probe.adv.homeAxis', 'Home {axis}', { axis: ax })}
                </button>
              ))}
              <IconButton
                className="pr-icon-btn"
                icon="⤓"
                label={`${t('probe.adv.unlock', 'Unlock ($X)')} — ${t('probe.adv.unlockTip', '$X — clear an alarm / unlock')}`}
                disabled={!connected}
                onClick={() => grbl.unlock().catch(() => {})}
              />
              <IconButton
                className="pr-icon-btn"
                icon="⟳"
                label={
                  loading
                    ? t('probe.adv.syncing', '⟳ Syncing…')
                    : `${t('probe.adv.sync', '⟳ Sync')} — ${t('probe.adv.syncTip', '$$ — re-read settings so the toggles reflect the machine')}`
                }
                disabled={!connected || loading}
                data-loading={loading || undefined}
                onClick={() => grbl.readSettings().catch(() => {})}
              />
            </div>
            <p className="pr-note caution">
              {t(
                'probe.adv.caution',
                'Caution: hard limits ($21) need limit switches physically wired. Many switches are normally-closed — if a switch reads triggered while open in the lights above, turn ON limit-pins invert ($5). Soft limits ($20) only work after a successful homing cycle.',
              )}
            </p>
          </div>
        )}
      </section>
      </div>
      <LimitConfigModal open={showLimitConfig} onClose={() => setShowLimitConfig(false)} />
    </div>
  )
}
