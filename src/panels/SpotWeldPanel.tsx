import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
import { CamEmpty, CamStatus } from '../components/cam/CamUI'
import { SliderField } from '../components/ui/SliderField'
import { SegControl } from '../components/ui/SegControl'
import '../styles/spotweld.css'

/* ──────────────────────────────────────────────────────────────────────────
 * PURE core (no React) — the spot-weld point model, pattern generators, the
 * safe G-code emitter and the time estimates. Kept side-effect free so it is
 * trivially portable and mirrors the Qt cadcam structure.
 * ────────────────────────────────────────────────────────────────────────── */

/** One resistance spot-weld nugget. `weldTime` is an OPTIONAL per-point
 *  override (seconds) of the global weld-on dwell; undefined ⇒ use the global. */
export interface WeldPoint {
  x: number
  y: number
  weldTime?: number
}

/** The weld SCHEDULE + motion parameters shared by every point. */
export interface SpotWeldParams {
  /** Electrode-UP / travel height (mm) — the guaranteed safe retract. */
  safeZ: number
  /** Electrode-DOWN / touch height (mm) — where the tip presses the sheets. */
  downZ: number
  /** Plunge feed (mm/min) lowering the electrode from safe-Z to down-Z. */
  approachFeed: number
  /** Squeeze time (s) — electrode-down settle before current flows. */
  squeezeTime: number
  /** Weld time (s) — current-on dwell; the key schedule parameter. */
  weldTime: number
  /** Hold time (s) — after current, before the electrode lifts. */
  holdTime: number
  /** Weld current level, emitted as the spindle S word (0–1000) as a proxy. */
  current: number
  /** Number of current-on pulses per spot (multi-pulse schedules). */
  pulseCount: number
  /** Cool interval (s) between pulses (current OFF). */
  coolInterval: number
  /** Emitted-coordinate decimal places (0–6). */
  decimals: number
}

export function defaultSpotWeldParams(): SpotWeldParams {
  return {
    safeZ: 5,
    downZ: -1,
    approachFeed: 200,
    squeezeTime: 0.3,
    weldTime: 0.2,
    holdTime: 0.3,
    current: 600,
    pulseCount: 1,
    coolInterval: 0.1,
    decimals: 3,
  }
}

/** Pattern-generator inputs (grid rows×cols + line A→B). */
export interface GenParams {
  mode: 'grid' | 'line'
  rows: number
  cols: number
  dx: number
  dy: number
  ox: number
  oy: number
  count: number
  ax: number
  ay: number
  bx: number
  by: number
}

function defaultGenParams(): GenParams {
  return {
    mode: 'grid',
    rows: 3,
    cols: 3,
    dx: 10,
    dy: 10,
    ox: 0,
    oy: 0,
    count: 5,
    ax: 0,
    ay: 0,
    bx: 50,
    by: 0,
  }
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Clamp decimals to the range toFixed() accepts (0..6) so a corrupt persisted
 *  value can never white-screen the render-phase useMemo with a RangeError. */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Format a coordinate at `dp` decimals, guaranteeing no `-0.000` is emitted. */
function fmt(n: number, dp: number): string {
  const d = clampDecimals(dp)
  let s = (Number.isFinite(n) ? n : 0).toFixed(d)
  if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1) // strip the sign off negative zero
  return s
}

/** Format a dwell (seconds) for `G4 P…`: non-negative, ≤3 dp, no trailing zeros. */
function fmtSec(sec: number): string {
  const v = Math.max(0, Number.isFinite(sec) ? sec : 0)
  return String(Math.round(v * 1000) / 1000)
}

/** The effective weld-on dwell for a point (per-point override, else global). */
function effWeldTime(p: WeldPoint, params: SpotWeldParams): number {
  return p.weldTime != null && Number.isFinite(p.weldTime)
    ? Math.max(0, p.weldTime)
    : Math.max(0, params.weldTime)
}

/** Grid of weld points: rows × cols, spaced by dx/dy from an origin. PURE. */
export function makeGridPoints(
  rows: number,
  cols: number,
  dx: number,
  dy: number,
  ox: number,
  oy: number,
): WeldPoint[] {
  const r = Math.max(1, Math.floor(rows))
  const c = Math.max(1, Math.floor(cols))
  const out: WeldPoint[] = []
  for (let iy = 0; iy < r; iy++) {
    for (let ix = 0; ix < c; ix++) {
      out.push({ x: ox + ix * dx, y: oy + iy * dy })
    }
  }
  return out
}

/** N evenly-spaced weld points from A→B (inclusive of both ends). PURE. */
export function makeLinePoints(
  n: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): WeldPoint[] {
  const count = Math.max(1, Math.floor(n))
  if (count === 1) return [{ x: ax, y: ay }]
  const out: WeldPoint[] = []
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1)
    out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t })
  }
  return out
}

/**
 * Emit a SAFE spot-welding program. Ports the emitter's safety behaviour:
 * always `G21 G90 G94 G17`, a guaranteed electrode-UP (safe-Z) retract before
 * every XY travel and at program end, no `-0.000`, and weld current OFF (`M5`)
 * with Z parked at the safe height on exit. Per point: retract → rapid XY →
 * plunge to electrode-down → squeeze dwell → pulseCount×(current-on dwell / off
 * / cool) → hold dwell → retract. PURE. */
export function generateSpotWeldGcode(points: WeldPoint[], params: SpotWeldParams): string {
  const dp = clampDecimals(params.decimals)
  const S = Math.max(0, Math.min(1000, Math.round(params.current)))
  const pulses = Math.max(1, Math.floor(params.pulseCount))
  const feed = Math.max(1, Math.round(params.approachFeed))
  const L: string[] = []
  L.push('(karmyogi spot welding)')
  L.push('(CAUTION: resistance weld current and dwell are hazardous)')
  L.push('G21 G90 G94 G17')
  L.push('M5') // weld current OFF before any motion
  L.push(`G0 Z${fmt(params.safeZ, dp)}`) // electrode up / safe height
  points.forEach((p, i) => {
    const wt = effWeldTime(p, params)
    L.push(`(spot ${i + 1} X${fmt(p.x, dp)} Y${fmt(p.y, dp)})`)
    L.push(`G0 Z${fmt(params.safeZ, dp)}`) // guarantee electrode UP before XY
    L.push(`G0 X${fmt(p.x, dp)} Y${fmt(p.y, dp)}`) // rapid to the spot
    L.push(`G1 Z${fmt(params.downZ, dp)} F${feed}`) // lower electrode / squeeze down
    if (params.squeezeTime > 0) L.push(`G4 P${fmtSec(params.squeezeTime)}`) // squeeze settle
    for (let k = 0; k < pulses; k++) {
      L.push(`M3 S${S}`) // weld current ON
      L.push(`G4 P${fmtSec(wt)}`) // weld-on dwell
      L.push('M5') // weld current OFF
      if (k < pulses - 1 && params.coolInterval > 0) {
        L.push(`G4 P${fmtSec(params.coolInterval)}`) // cool between pulses
      }
    }
    if (params.holdTime > 0) L.push(`G4 P${fmtSec(params.holdTime)}`) // hold before lift
    L.push(`G0 Z${fmt(params.safeZ, dp)}`) // lift electrode to safe
  })
  L.push('M5') // ensure current OFF at end
  L.push(`G0 Z${fmt(params.safeZ, dp)}`) // park at safe height
  L.push('(end)')
  return L.join('\n') + '\n'
}

/** Total current-ON time across every spot (sum of pulses × weld dwell). PURE. */
export function totalWeldSeconds(points: WeldPoint[], params: SpotWeldParams): number {
  const pulses = Math.max(1, Math.floor(params.pulseCount))
  return points.reduce((acc, p) => acc + pulses * effWeldTime(p, params), 0)
}

/** Estimated cycle time (s): per point plunge (down+up) + squeeze + pulses +
 *  cools + hold. Rapids across XY are ignored. PURE. */
export function estimateSpotWeldSeconds(points: WeldPoint[], params: SpotWeldParams): number {
  const pulses = Math.max(1, Math.floor(params.pulseCount))
  const feed = Math.max(1, params.approachFeed)
  const travelZ = Math.abs(params.safeZ - params.downZ)
  const plungeSec = (travelZ / feed) * 60 * 2 // down + up
  return points.reduce((acc, p) => {
    const wt = effWeldTime(p, params)
    const onOff =
      pulses * wt +
      Math.max(0, pulses - 1) * Math.max(0, params.coolInterval)
    return (
      acc +
      plungeSec +
      Math.max(0, params.squeezeTime) +
      onOff +
      Math.max(0, params.holdTime)
    )
  }, 0)
}

/** Split G-code into non-empty lines for the line count shown to the operator. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

/** Human-readable duration from seconds (e.g. "1 m 30 s", "12 s"). */
function fmtDuration(totalSeconds: number, t: ReturnType<typeof useT>): string {
  const s = Math.max(0, Math.round(totalSeconds))
  if (s < 60) return t('time.seconds', '{s} s', { s })
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return t('time.minSec', '{m} m {s} s', { m, s: rem })
  const h = Math.floor(m / 60)
  const mm = m % 60
  return t('time.hourMin', '{h} h {m} m', { h, m: mm })
}

/**
 * A slim square icon button for the header toolbar. Its `title`/`body` combine
 * into a native hover tooltip that never intercepts the action click, keeping
 * the toolbar compact while every button stays self-documenting.
 */
function ToolButton(props: {
  glyph: ReactNode
  title: string
  body: string
  onClick: () => void
  className?: string
  disabled?: boolean
  ariaExpanded?: boolean
}) {
  const { glyph, title, body, onClick, className = '', disabled, ariaExpanded } = props
  return (
    <button
      type="button"
      className={`sw-ico${className ? ' ' + className : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-expanded={ariaExpanded}
      title={`${title} — ${body}`}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * SPOT WELDING panel — a table of discrete resistance-spot-weld points driven
 * by a shared weld schedule. Point-based (like Auto-solder), NOT a path. The
 * pure emitter above produces a safe program where the spindle output is
 * repurposed as the weld-current gate (M3 on, M5 off) with squeeze/weld/hold
 * dwells. Generation is live: every edit pushes a fresh program to the shared
 * store (section 'spotweld') — the Visualizer renders it and the Program tab
 * streams it (no send controls live here).
 * ────────────────────────────────────────────────────────────────────────── */
export function SpotWeldPanel() {
  const t = useT()
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const streaming = useProgram((s) => s.streaming)

  const [points, setPoints] = usePersistentState<WeldPoint[]>('karmyogi.spotweld.points', [])
  const [params, setParams] = usePersistentState<SpotWeldParams>(
    'karmyogi.spotweld.params',
    defaultSpotWeldParams(),
  )
  const [gen, setGen] = usePersistentState<GenParams>('karmyogi.spotweld.gen', defaultGenParams())
  const [selected, setSelected] = useState(-1)
  // Defaults disclosure (§6). Tri-state: null = auto (open only with 0 points so
  // there is something to do; collapsed once ≥1 so the table leads); a boolean
  // is the operator's explicit persisted choice, which wins.
  const [defaultsOpen, setDefaultsOpen] = usePersistentState<boolean | null>(
    'karmyogi.spotweld.defaultsOpen',
    null,
  )

  // Sanitize a PERSISTED decimals once on mount (localStorage bypasses the input
  // guards, so a corrupt out-of-range value could otherwise reach toFixed()).
  useEffect(() => {
    if (clampDecimals(params.decimals) !== params.decimals) {
      setParams((p) => ({ ...p, decimals: clampDecimals(p.decimals) }))
    }
    // once on mount — intentionally not reactive to later edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addRow() {
    const x = connected ? wpos.x : 0
    const y = connected ? wpos.y : 0
    setPoints((p) => {
      setSelected(p.length)
      return [...p, { x, y }]
    })
  }

  // Record the live machine work-position: fill the selected row's X/Y if one is
  // selected, else append a new point at that position.
  function recordPosition() {
    if (!connected) return
    setPoints((p) => {
      if (selected >= 0 && selected < p.length) {
        return p.map((pt, i) => (i === selected ? { ...pt, x: wpos.x, y: wpos.y } : pt))
      }
      setSelected(p.length)
      return [...p, { x: wpos.x, y: wpos.y }]
    })
  }

  function deleteRow(i: number) {
    setPoints((p) => p.filter((_, idx) => idx !== i))
    setSelected((s) => (s === i ? -1 : s > i ? s - 1 : s))
  }

  function moveRow(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= points.length) return
    setPoints((p) => {
      const next = [...p]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setSelected(j)
  }

  function updatePoint(i: number, patch: Partial<WeldPoint>) {
    setPoints((p) => p.map((pt, idx) => (idx === i ? { ...pt, ...patch } : pt)))
  }

  function clearAll() {
    if (points.length === 0) return
    if (!window.confirm(t('sw.clearConfirm', 'Remove all {n} weld point(s)?', { n: points.length })))
      return
    setPoints([])
    setSelected(-1)
  }

  // Run the active pattern generator and APPEND its points to the list.
  function generatePattern() {
    const made =
      gen.mode === 'grid'
        ? makeGridPoints(gen.rows, gen.cols, gen.dx, gen.dy, gen.ox, gen.oy)
        : makeLinePoints(gen.count, gen.ax, gen.ay, gen.bx, gen.by)
    if (made.length === 0) return
    setPoints((p) => [...p, ...made])
    setSelected(-1)
  }

  const genCount =
    gen.mode === 'grid'
      ? Math.max(1, Math.floor(gen.rows)) * Math.max(1, Math.floor(gen.cols))
      : Math.max(1, Math.floor(gen.count))

  // Live preview — clamp times/feeds ≥ 0 and decimals into range so a typed
  // negative never produces an inverted dwell or a backwards feed.
  const safeParams = useMemo<SpotWeldParams>(
    () => ({
      ...params,
      decimals: clampDecimals(params.decimals),
      approachFeed: Math.max(1, params.approachFeed),
      squeezeTime: Math.max(0, params.squeezeTime),
      weldTime: Math.max(0, params.weldTime),
      holdTime: Math.max(0, params.holdTime),
      coolInterval: Math.max(0, params.coolInterval),
      current: Math.max(0, Math.min(1000, params.current)),
      pulseCount: Math.max(1, Math.floor(params.pulseCount)),
    }),
    [params],
  )

  const gcode = useMemo(() => generateSpotWeldGcode(points, safeParams), [points, safeParams])
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])
  const effectiveLines = points.length === 0 ? 0 : lineCount
  const weldSecs = useMemo(() => totalWeldSeconds(points, safeParams), [points, safeParams])
  const estSeconds = useMemo(() => estimateSpotWeldSeconds(points, safeParams), [points, safeParams])

  // Warn when the electrode-down Z is at or above the safe/up Z — the electrode
  // would never descend to press the sheets (a degenerate move).
  const zInverted = safeParams.downZ >= safeParams.safeZ

  // Live generation: push the freshly-computed program to the shared store
  // (debounced) so the Visualizer + Program tab pick it up without a manual
  // Generate step. Empty list DROPS the section (no stale toolpath). Skip while
  // a job is streaming so a push can't reset the running stream mid-weld.
  useEffect(() => {
    if (streaming) return
    if (!points.length) {
      removeSection('spotweld')
      return
    }
    const id = window.setTimeout(() => setProgram('spotweld', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, points.length, setProgram, removeSection, streaming])

  const defaultsEffectiveOpen = defaultsOpen ?? points.length === 0
  const toggleDefaults = () => setDefaultsOpen(!defaultsEffectiveOpen)

  return (
    <div className="sw-panel">
      {/* Slim header: title + live line-count + icon toolbar. */}
      <header className="sw-head">
        <div className="sw-head-title">
          <span className="sw-head-name">{t('sw.title', 'Spot welding')}</span>
          <InfoTip
            topic="spotWeldMode"
            title={t('sw.title', 'Spot welding')}
            body={t(
              'sw.intro',
              'Makes discrete resistance spot welds at a list of points. At each point the electrode lowers, squeezes, passes weld current for the weld time, holds, then lifts. The spindle output gates the weld current (M3 on / M5 off). The program auto-syncs to the Program tab for streaming.',
            )}
          />
        </div>
        <div className="sw-tools">
          <ToolButton
            className="sw-ico-primary"
            glyph={<Icon name="add" />}
            onClick={addRow}
            title={t('sw.toolbar.add', 'Add point')}
            body={t('sw.toolbar.add.body', 'Append a weld point (prefilled from the live machine X/Y when connected, else 0,0).')}
          />
          <ToolButton
            glyph={<Icon name="probe" />}
            onClick={recordPosition}
            disabled={!connected}
            title={t('sw.toolbar.record', 'Record position')}
            body={
              connected
                ? selected >= 0
                  ? t('sw.toolbar.record.body.fill', 'Fills the selected row X/Y from the live machine position.')
                  : t('sw.toolbar.record.body.append', 'Appends a point at the current machine position.')
                : t('sw.toolbar.record.body.connect', 'Connect to a machine to capture its live position.')
            }
          />
          <span className="sw-tools-sep" aria-hidden="true" />
          <ToolButton
            className={defaultsEffectiveOpen ? 'is-active' : ''}
            glyph={<Icon name="settings" />}
            onClick={toggleDefaults}
            ariaExpanded={defaultsEffectiveOpen}
            title={t('sw.toolbar.settings', 'Settings')}
            body={t('sw.toolbar.settings.body', 'The weld schedule (squeeze / weld / hold / current / pulses), electrode Z heights, approach feed and the pattern generators.')}
          />
          {/* Destructive Clear sits LAST, isolated behind its own separator. */}
          <span className="sw-tools-sep" aria-hidden="true" />
          <ToolButton
            className="sw-ico-danger"
            glyph={<Icon name="trash" />}
            onClick={clearAll}
            disabled={points.length === 0}
            title={t('sw.toolbar.clear', 'Clear all')}
            body={t('sw.toolbar.clear.body', 'Remove every weld point and start over.')}
          />
        </div>
      </header>

      {/* Live status strip, synced to Program. Uses the shared <CamStatus> kit. */}
      <div className="sw-status">
        <CamStatus
          items={[
            { value: points.length, unit: t('sw.status.points', 'spots') },
            {
              value: fmtDuration(weldSecs, t),
              unit: t('sw.status.weld', 'weld on'),
              title: t('sw.status.weld.title', 'Total current-on time across every spot (pulses × weld time). Keep this short — it is the hazardous interval.'),
            },
            {
              value: fmtDuration(estSeconds, t),
              unit: t('sw.status.est', 'est.'),
              title: t('sw.status.est.title', 'Estimated cycle time (plunge + squeeze + weld pulses + cool + hold; XY rapids ignored).'),
            },
            { value: effectiveLines, unit: t('sw.status.gcode', 'G-code lines') },
          ]}
        />
      </div>

      {/* Safety caution — weld current + dwell are hazardous. */}
      <p className="sw-note sw-caution" role="note">
        <Icon name="warning" size={14} />
        <span>
          {t(
            'sw.caution',
            'CAUTION: resistance spot welding passes high current and gets hot. Verify the weld schedule (weld time, current, pulses) at low settings first, keep clear of the electrodes, and confirm your safe-Z retract before streaming.',
          )}
        </span>
      </p>

      {zInverted && (
        <p className="sw-warn">
          {t(
            'sw.warn.zInverted',
            'Electrode-down Z ≥ safe-Z — the electrode will not descend to press the sheets. Lower the electrode-down Z below the safe-Z.',
          )}
        </p>
      )}

      {!connected && points.length > 0 && (
        <p className="sw-warn">
          {t('sw.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
        </p>
      )}

      {/* Defaults disclosure (§6): a persistent WORDED trigger + rotating caret. */}
      <button
        type="button"
        className="sw-defaults-toggle"
        data-open={defaultsEffectiveOpen}
        aria-expanded={defaultsEffectiveOpen}
        onClick={toggleDefaults}
      >
        <Icon name="settings" size={14} className="sw-defaults-ico" />
        <span className="sw-defaults-word">{t('sw.defaults.disclosure', 'Weld schedule & patterns')}</span>
        <span className="ui-caret" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
      </button>

      {defaultsEffectiveOpen && (
        <section className="sw-settings">
          {/* Weld schedule */}
          <div className="sw-card">
            <div className="sw-card-head">
              <h4><Icon name="spindle" size={14} className="cam-card-ico" /> {t('sw.sched.title', 'Weld schedule')}</h4>
              <InfoTip
                topic="spotWeldSchedule"
                title={t('sw.sched.title', 'Weld schedule')}
                body={t('sw.sched.body', 'Squeeze settles the electrode before current flows; weld time is the current-on dwell (the key parameter); hold keeps pressure after current. Current is emitted as the spindle S word (0–1000) as a proxy for the weld level. Pulse count repeats the current-on/off with a cool interval for multi-pulse schedules.')}
              />
            </div>
            <div className="sw-fields">
              <SliderField
                label={t('sw.field.squeeze', 'Squeeze')}
                unit={t('unit.s', 's')}
                min={0}
                max={5}
                step={0.05}
                value={params.squeezeTime}
                onChange={(n) => setParams((p) => ({ ...p, squeezeTime: Math.max(0, n) }))}
                title={t('sw.field.squeeze.body', 'Electrode-down settle time (s) before weld current flows.')}
              />
              <SliderField
                label={t('sw.field.weld', 'Weld time')}
                unit={t('unit.s', 's')}
                min={0}
                max={3}
                step={0.01}
                value={params.weldTime}
                onChange={(n) => setParams((p) => ({ ...p, weldTime: Math.max(0, n) }))}
                title={t('sw.field.weld.body', 'Current-on dwell (s) — the key spot-weld parameter. A per-point value in the table overrides this.')}
              />
              <SliderField
                label={t('sw.field.hold', 'Hold')}
                unit={t('unit.s', 's')}
                min={0}
                max={5}
                step={0.05}
                value={params.holdTime}
                onChange={(n) => setParams((p) => ({ ...p, holdTime: Math.max(0, n) }))}
                title={t('sw.field.hold.body', 'Dwell (s) after current stops, before the electrode lifts, so the nugget solidifies under pressure.')}
              />
              <SliderField
                label={t('sw.field.current', 'Current')}
                unit={t('unit.sWord', 'S')}
                min={0}
                max={1000}
                step={10}
                value={params.current}
                onChange={(n) => setParams((p) => ({ ...p, current: Math.max(0, Math.min(1000, n)) }))}
                title={t('sw.field.current.body', 'Weld current level emitted as the spindle S word (0–1000) as a proxy for the actual current.')}
              />
              <SliderField
                label={t('sw.field.pulses', 'Pulses')}
                min={1}
                max={10}
                step={1}
                value={params.pulseCount}
                onChange={(n) => setParams((p) => ({ ...p, pulseCount: Math.max(1, Math.floor(n)) }))}
                title={t('sw.field.pulses.body', 'Number of current-on pulses per spot (multi-pulse schedules), each separated by the cool interval.')}
              />
              <SliderField
                label={t('sw.field.cool', 'Cool')}
                unit={t('unit.s', 's')}
                min={0}
                max={2}
                step={0.05}
                value={params.coolInterval}
                onChange={(n) => setParams((p) => ({ ...p, coolInterval: Math.max(0, n) }))}
                title={t('sw.field.cool.body', 'Current-OFF interval (s) between pulses. Ignored when Pulses = 1.')}
              />
            </div>
          </div>

          {/* Electrode motion */}
          <div className="sw-card">
            <div className="sw-card-head">
              <h4><Icon name="jog" size={14} className="cam-card-ico" /> {t('sw.motion.title', 'Electrode motion')}</h4>
              <InfoTip
                topic="spotWeldMotion"
                title={t('sw.motion.title', 'Electrode motion')}
                body={t('sw.motion.body', 'Electrode-up (safe) Z is the guaranteed retract before every XY travel and at program end; electrode-down Z is where the tip presses the sheets. Approach feed lowers the electrode from up to down.')}
              />
            </div>
            <div className="sw-fields">
              <SliderField
                label={t('sw.field.safeZ', 'Electrode-up Z')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={50}
                step={0.5}
                value={params.safeZ}
                onChange={(n) => setParams((p) => ({ ...p, safeZ: n }))}
                title={t('sw.field.safeZ.body', 'Safe / electrode-up height retracted to before every XY travel and at program end.')}
              />
              <SliderField
                label={t('sw.field.downZ', 'Electrode-down Z')}
                unit={t('unit.mm', 'mm')}
                min={-10}
                max={10}
                step={0.1}
                value={params.downZ}
                onChange={(n) => setParams((p) => ({ ...p, downZ: n }))}
                title={t('sw.field.downZ.body', 'Touch height the electrode lowers to at each spot to press the sheets together.')}
              />
              <SliderField
                label={t('sw.field.approach', 'Approach feed')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={1}
                max={1000}
                step={10}
                value={params.approachFeed}
                onChange={(n) => setParams((p) => ({ ...p, approachFeed: Math.max(1, n) }))}
                title={t('sw.field.approach.body', 'Feed rate lowering the electrode from the up Z to the down Z.')}
              />
              <SliderField
                label={t('sw.field.decimals', 'Decimals')}
                min={0}
                max={6}
                step={1}
                value={params.decimals}
                onChange={(n) => setParams((p) => ({ ...p, decimals: clampDecimals(n) }))}
                title={t('sw.field.decimals.body', 'Number of decimal places in the emitted coordinates (0–6).')}
              />
            </div>
          </div>

          {/* Pattern generators */}
          <div className="sw-card sw-gen">
            <div className="sw-card-head">
              <h4><Icon name="frame" size={14} className="cam-card-ico" /> {t('sw.gen.title', 'Pattern generator')}</h4>
              <InfoTip
                topic="spotWeldPattern"
                title={t('sw.gen.title', 'Pattern generator')}
                body={t('sw.gen.body', 'Build a block of weld points at once: a grid (rows × cols spaced by X/Y from an origin) or a line (N evenly-spaced points from A to B). Generate appends the points; edit or delete them in the table below.')}
              />
            </div>
            <div className="sw-gen-body">
              <SegControl<'grid' | 'line'>
                options={[
                  { value: 'grid', label: t('sw.gen.grid', 'Grid') },
                  { value: 'line', label: t('sw.gen.line', 'Line') },
                ]}
                value={gen.mode}
                onChange={(v) => setGen((g) => ({ ...g, mode: v }))}
                ariaLabel={t('sw.gen.mode', 'Pattern type')}
                variant="tonal"
                size="sm"
              />
              {gen.mode === 'grid' ? (
                <div className="sw-gen-grid">
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.rows', 'Rows')}</span>
                    <input type="number" step="1" min="1" value={gen.rows}
                      onChange={(e) => setGen((g) => ({ ...g, rows: Math.max(1, intNum(e.target.value, g.rows)) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.cols', 'Cols')}</span>
                    <input type="number" step="1" min="1" value={gen.cols}
                      onChange={(e) => setGen((g) => ({ ...g, cols: Math.max(1, intNum(e.target.value, g.cols)) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.dx', 'X pitch')}</span>
                    <input type="number" step="0.5" value={gen.dx}
                      onChange={(e) => setGen((g) => ({ ...g, dx: num(e.target.value, g.dx) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.dy', 'Y pitch')}</span>
                    <input type="number" step="0.5" value={gen.dy}
                      onChange={(e) => setGen((g) => ({ ...g, dy: num(e.target.value, g.dy) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.ox', 'Origin X')}</span>
                    <input type="number" step="0.5" value={gen.ox}
                      onChange={(e) => setGen((g) => ({ ...g, ox: num(e.target.value, g.ox) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.oy', 'Origin Y')}</span>
                    <input type="number" step="0.5" value={gen.oy}
                      onChange={(e) => setGen((g) => ({ ...g, oy: num(e.target.value, g.oy) }))} />
                  </label>
                </div>
              ) : (
                <div className="sw-gen-grid">
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.count', 'Points')}</span>
                    <input type="number" step="1" min="1" value={gen.count}
                      onChange={(e) => setGen((g) => ({ ...g, count: Math.max(1, intNum(e.target.value, g.count)) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.ax', 'A · X')}</span>
                    <input type="number" step="0.5" value={gen.ax}
                      onChange={(e) => setGen((g) => ({ ...g, ax: num(e.target.value, g.ax) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.ay', 'A · Y')}</span>
                    <input type="number" step="0.5" value={gen.ay}
                      onChange={(e) => setGen((g) => ({ ...g, ay: num(e.target.value, g.ay) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.bx', 'B · X')}</span>
                    <input type="number" step="0.5" value={gen.bx}
                      onChange={(e) => setGen((g) => ({ ...g, bx: num(e.target.value, g.bx) }))} />
                  </label>
                  <label className="sw-gen-field">
                    <span>{t('sw.gen.by', 'B · Y')}</span>
                    <input type="number" step="0.5" value={gen.by}
                      onChange={(e) => setGen((g) => ({ ...g, by: num(e.target.value, g.by) }))} />
                  </label>
                </div>
              )}
              <button type="button" className="sw-gen-btn" onClick={generatePattern}>
                <Icon name="add" size={14} />
                <span>{t('sw.gen.generate', 'Generate {n} points', { n: genCount })}</span>
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Weld points — compact editable table (reflows to cards when narrow). */}
      <div className="sw-card sw-points">
        <div className="sw-card-head">
          <h4>{t('sw.points.title', 'Weld points')}</h4>
          <span className="sw-card-count">{points.length}</span>
        </div>

        <div className="sw-table-wrap">
          <table className="sw-table">
            <thead>
              <tr>
                <th className="sw-idx">{t('sw.table.num', '#')}</th>
                <th>{t('sw.table.x', 'X')}</th>
                <th>{t('sw.table.y', 'Y')}</th>
                <th>
                  <span className="sw-th">
                    <span className="sw-th-txt">{t('sw.table.weld', 'Weld s')}</span>
                    <InfoTip
                      topic="spotWeldPerPoint"
                      title={t('sw.table.weld', 'Weld s')}
                      body={t('sw.table.weld.body', 'Optional per-point weld-time override (s). Leave blank to use the global weld time from the schedule.')}
                    />
                  </span>
                </th>
                <th className="sw-actions-col" aria-label={t('sw.table.actions', 'Actions')} />
              </tr>
            </thead>
            <tbody>
              {points.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <CamEmpty
                      icon={<Icon name="add" size={22} />}
                      title={t('sw.empty.title', 'No weld points yet')}
                      hint={t('sw.empty.hint', 'Add a point, record a machine position, or generate a grid/line pattern.')}
                      action={
                        <button type="button" className="cam-primary" onClick={addRow}>
                          <Icon name="add" size={15} /> {t('sw.toolbar.add', 'Add point')}
                        </button>
                      }
                    />
                  </td>
                </tr>
              )}
              {points.map((pt, i) => (
                <tr
                  key={i}
                  className={i === selected ? 'sw-row-selected' : undefined}
                  onClick={() => setSelected(i)}
                >
                  <td className="sw-idx">{i + 1}</td>
                  <td data-label={t('sw.table.x', 'X')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.x}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    />
                  </td>
                  <td data-label={t('sw.table.y', 'Y')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.y}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    />
                  </td>
                  <td data-label={t('sw.table.weld', 'Weld s')}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder={String(params.weldTime)}
                      value={pt.weldTime ?? ''}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const v = e.target.value.trim()
                        updatePoint(i, { weldTime: v === '' ? undefined : Math.max(0, num(v, 0)) })
                      }}
                    />
                  </td>
                  <td className="sw-actions">
                    <button
                      className="sw-row-ico"
                      title={t('sw.row.moveUp', 'Move up')}
                      aria-label={t('sw.row.moveUp', 'Move up')}
                      onClick={(e) => { e.stopPropagation(); moveRow(i, -1) }}
                      disabled={i === 0}
                    >↑</button>
                    <button
                      className="sw-row-ico"
                      title={t('sw.row.moveDown', 'Move down')}
                      aria-label={t('sw.row.moveDown', 'Move down')}
                      onClick={(e) => { e.stopPropagation(); moveRow(i, 1) }}
                      disabled={i === points.length - 1}
                    >↓</button>
                    <button
                      className="sw-row-ico sw-del"
                      title={t('sw.row.delete', 'Delete point')}
                      aria-label={t('sw.row.delete', 'Delete point')}
                      onClick={(e) => { e.stopPropagation(); deleteRow(i) }}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Narrow PANEL: each point becomes a compact card (hidden on wide panels
            by the container query; the table above is shown instead). */}
        <div className="sw-cards">
          {points.length === 0 && (
            <CamEmpty
              icon={<Icon name="add" size={22} />}
              title={t('sw.empty.title', 'No weld points yet')}
              hint={t('sw.empty.hint', 'Add a point, record a machine position, or generate a grid/line pattern.')}
              action={
                <button type="button" className="cam-primary" onClick={addRow}>
                  <Icon name="add" size={15} /> {t('sw.toolbar.add', 'Add point')}
                </button>
              }
            />
          )}
          {points.map((pt, i) => (
            <div
              key={i}
              className={`sw-pcard${i === selected ? ' is-selected' : ''}`}
              onClick={() => setSelected(i)}
            >
              <div className="sw-pcard-head">
                <span className="sw-pcard-idx">{t('sw.card.point', 'Point')} {i + 1}</span>
                <div className="sw-pcard-actions">
                  <button
                    className="sw-row-ico"
                    title={t('sw.row.moveUp', 'Move up')}
                    aria-label={t('sw.row.moveUp', 'Move up')}
                    onClick={(e) => { e.stopPropagation(); moveRow(i, -1) }}
                    disabled={i === 0}
                  >↑</button>
                  <button
                    className="sw-row-ico"
                    title={t('sw.row.moveDown', 'Move down')}
                    aria-label={t('sw.row.moveDown', 'Move down')}
                    onClick={(e) => { e.stopPropagation(); moveRow(i, 1) }}
                    disabled={i === points.length - 1}
                  >↓</button>
                  <button
                    className="sw-row-ico sw-del"
                    title={t('sw.row.delete', 'Delete point')}
                    aria-label={t('sw.row.delete', 'Delete point')}
                    onClick={(e) => { e.stopPropagation(); deleteRow(i) }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>
              <div className="sw-pcard-grid">
                <label className="sw-mini">
                  <span>{t('sw.table.x', 'X')}</span>
                  <input type="number" step="0.1" value={pt.x}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })} />
                </label>
                <label className="sw-mini">
                  <span>{t('sw.table.y', 'Y')}</span>
                  <input type="number" step="0.1" value={pt.y}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })} />
                </label>
                <label className="sw-mini">
                  <span>{t('sw.card.weld', 'Weld s')}</span>
                  <input type="number" step="0.01" min="0"
                    placeholder={String(params.weldTime)}
                    value={pt.weldTime ?? ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      updatePoint(i, { weldTime: v === '' ? undefined : Math.max(0, num(v, 0)) })
                    }} />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
