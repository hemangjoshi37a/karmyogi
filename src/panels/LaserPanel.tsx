import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useProgram, usePersistentState, useMachine } from '../store'
import { grbl } from '../serial/controller'
import { buildFrameProgram, frameBoundsOfGcode } from '../core/framing'
import { useTabCommands } from '../machine/tabCommands'
import { useT } from '../i18n'
import { Icon, type IconName } from '../components/Icons'
import { FrameButton } from '../components/FrameButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import { importDxfString } from '../core/dxf'
import { nestFootprints, type NestItem, type NestWarning } from '../core/nesting'
import { distance } from '../core/geometry'
import { traceBitmap, simplifyPolyline, fitPolylinesToSize, countPoints } from '../core/vectorize'
import {
  LaserMode,
  LaserPowerMode,
  defaultLaserParams,
  drawingToContours,
  contoursBounds,
  countContours,
  placeContours,
  orderContours,
  optimizeTravel,
  tabContour,
  offsetFill,
  lineFill,
  contourLayers,
  FillStyle,
  emitLaserProgram,
  emitLaserFrameProgram,
  laserDotOnCommand,
  kLaserOffCommand,
  kMaxFramePowerPct,
  percentFromPower,
  powerFromPercent,
  type LaserContour,
  type LaserFrameShape,
  type PlacedContour,
} from '../core/laser'
import {
  DitherMode,
  ScanAngle,
  defaultImageAdjust,
  defaultRasterParams,
  rgbaToGray,
  dither,
  burnToRGBA,
  emitRasterProgram,
  dpiToInterval,
  intervalToDpi,
  type ImageAdjust,
  type RasterParams,
} from '../core/laserImage'
import { emitTestGrid, type TestGridParams } from '../core/laserTestGrid'
import { CamBusy, CamEmpty, CamError } from '../components/cam/CamUI'
import { SliderField as KitSlider } from '../components/ui/SliderField'
import { SegControl as KitSeg } from '../components/ui/SegControl'
import '../styles/laser.css'
import '../styles/laserImage.css'
import '../styles/cam.css'

/** Hard cap on the Quantity field — keeps the O(n²) nest hill-climb bounded. */
const MAX_QUANTITY = 200

/** Clamp `n` into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** Format a duration (seconds) as "1h 23m" / "12m 30s" / "45s". */
function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** Non-empty G-code line count for the operator status strip. */
function gcodeLineCount(gcode: string): number {
  let n = 0
  for (const l of gcode.split(/\r?\n/)) if (l.trim().length > 0) ++n
  return n
}

/**
 * Thin wrapper around the shared {@link KitSlider} keeping the laser tab's
 * existing call sites (icon + integer props) unchanged. The icon is dropped (the
 * shared row has no leading glyph); `integer` just keeps the step at 1.
 */
function SliderField(props: {
  icon: ReactNode
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  title?: string
  integer?: boolean
  onChange: (n: number) => void
}) {
  const { label, value, min, max, step, unit, title, integer, onChange } = props
  return (
    <KitSlider
      label={label}
      value={value}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : undefined)}
      unit={unit}
      title={title}
      onChange={onChange}
    />
  )
}

/** One option in a {@link SegControl}. */
interface SegOption<T extends string> {
  value: T
  label: string
  icon?: IconName
  title?: string
}

/**
 * Wrapper around the shared {@link KitSeg} keeping the laser tab's icon-led
 * option shape. Icons are folded into the segment label node; `variant` defaults
 * to `tonal` (mode switches) so only the true CTA stays full-accent.
 */
function SegControl<T extends string>(props: {
  ariaLabel: string
  value: T
  options: SegOption<T>[]
  onChange: (v: T) => void
  variant?: 'tonal' | 'accent'
}) {
  const { ariaLabel, value, options, onChange, variant } = props
  return (
    <KitSeg<T>
      ariaLabel={ariaLabel}
      value={value}
      onChange={onChange}
      variant={variant}
      options={options.map((o) => ({
        value: o.value,
        title: o.title,
        label: o.icon ? (
          <>
            <Icon name={o.icon} size={14} /> {o.label}
          </>
        ) : (
          o.label
        ),
      }))}
    />
  )
}

/**
 * Material test-grid card (L4) — sweeps POWER × FEED across a grid of filled
 * tiles so the operator can dial in settings for a new material. Self-contained:
 * it owns its own persisted sweep settings and, on "Send to Program", emits a
 * safe test program (`emitTestGrid`) into the shared Program store so the
 * Visualizer renders it and the Program tab streams it. `defaults` seeds the
 * sweep ranges from the surrounding workbench (power/feed/sMax/mode/air).
 */
function LaserTestGridCard(props: { defaults: Partial<TestGridParams> }) {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const streaming = useProgram((s) => s.streaming)
  const [open, setOpen] = usePersistentState<boolean>('karmyogi.laser.testgrid.open', false)
  const [grid, setGrid] = usePersistentState<{
    powerSteps: number
    feedSteps: number
    powerMin: number
    feedMinFrac: number // feedMin as a fraction of the workbench feed (0..1)
    tileMm: number
    gapMm: number
  }>('karmyogi.laser.testgrid', {
    powerSteps: 5,
    feedSteps: 5,
    powerMin: 200,
    feedMinFrac: 0.25,
    tileMm: 8,
    gapMm: 2,
  })

  const sMax = Math.max(1, props.defaults.sMax ?? 1000)
  const feedMax = Math.max(1, props.defaults.feedMax ?? 6000)
  const params: Partial<TestGridParams> = {
    ...props.defaults,
    powerSteps: clamp(Math.floor(grid.powerSteps), 1, 12),
    feedSteps: clamp(Math.floor(grid.feedSteps), 1, 12),
    powerMin: clamp(grid.powerMin, 0, sMax),
    powerMax: sMax,
    feedMin: clamp(Math.round(feedMax * grid.feedMinFrac), 1, feedMax),
    feedMax,
    sMax,
    tileMm: clamp(grid.tileMm, 1, 50),
    gapMm: clamp(grid.gapMm, 0, 20),
  }
  const result = useMemo(() => emitTestGrid(params), [JSON.stringify(params)])

  const send = useCallback(() => {
    if (streaming) return
    setProgram('laser', result.gcode)
  }, [streaming, setProgram, result.gcode])

  return (
    <section className="lp-card ui-card">
      <div className="lp-card-head">
        <h4 className="ui-sec-head">
          <span className="cam-card-ico" aria-hidden="true">
            <Icon name="duplicate" size={14} />
          </span>
          {t('laser.testgrid.title', 'Material test grid')}
        </h4>
        <button
          type="button"
          className="lp-advanced-toggle"
          style={{ margin: 0, padding: '2px 6px' }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        </button>
      </div>
      {open && (
        <>
          <p className="lp-hint">
            {t(
              'laser.testgrid.hint',
              'Burns a grid of tiles sweeping power (→ columns, up to S-max) and feed (↑ rows). Pick the cleanest tile, then copy its power/feed.',
            )}
          </p>
          <div className="lp-sliders">
            <KitSlider
              label={t('laser.testgrid.cols', 'Power steps')}
              min={1}
              max={12}
              step={1}
              value={grid.powerSteps}
              onChange={(n) => setGrid((g) => ({ ...g, powerSteps: clamp(Math.floor(n), 1, 12) }))}
              title={t('laser.testgrid.cols.title', 'Number of power columns (low → S-max).')}
            />
            <KitSlider
              label={t('laser.testgrid.rows', 'Feed steps')}
              min={1}
              max={12}
              step={1}
              value={grid.feedSteps}
              onChange={(n) => setGrid((g) => ({ ...g, feedSteps: clamp(Math.floor(n), 1, 12) }))}
              title={t('laser.testgrid.rows.title', 'Number of feed rows (low → the workbench feed).')}
            />
            <KitSlider
              label={t('laser.testgrid.pmin', 'Power min')}
              unit="S"
              min={0}
              max={sMax}
              step={5}
              value={Math.min(grid.powerMin, sMax)}
              onChange={(n) => setGrid((g) => ({ ...g, powerMin: clamp(n, 0, sMax) }))}
              title={t('laser.testgrid.pmin.title', 'Lowest power (leftmost column). The rightmost is S-max ({s}).', { s: sMax })}
            />
            <KitSlider
              label={t('laser.testgrid.fmin', 'Feed min')}
              unit="%"
              min={5}
              max={100}
              step={5}
              value={Math.round(grid.feedMinFrac * 100)}
              onChange={(n) => setGrid((g) => ({ ...g, feedMinFrac: clamp(n, 5, 100) / 100 }))}
              title={t('laser.testgrid.fmin.title', 'Slowest feed (bottom row) as a % of the workbench feed ({f} mm/min). Top row = full feed.', { f: feedMax })}
            />
            <KitSlider
              label={t('laser.testgrid.tile', 'Tile')}
              unit="mm"
              min={1}
              max={50}
              step={0.5}
              value={grid.tileMm}
              onChange={(n) => setGrid((g) => ({ ...g, tileMm: clamp(n, 1, 50) }))}
              title={t('laser.testgrid.tile.title', 'Size of each square tile.')}
            />
            <KitSlider
              label={t('laser.testgrid.gap', 'Gap')}
              unit="mm"
              min={0}
              max={20}
              step={0.5}
              value={grid.gapMm}
              onChange={(n) => setGrid((g) => ({ ...g, gapMm: clamp(n, 0, 20) }))}
              title={t('laser.testgrid.gap.title', 'Gap between tiles.')}
            />
          </div>
          <p className="lp-hint">
            {t('laser.testgrid.summary', '{tiles} tiles · {w}×{h} mm · {lines} lines', {
              tiles: result.tiles,
              w: result.widthMm.toFixed(0),
              h: result.heightMm.toFixed(0),
              lines: result.lines,
            })}
          </p>
          <button
            type="button"
            className="cam-primary"
            disabled={streaming}
            onClick={send}
            title={t('laser.testgrid.send.title', 'Replace the current Program with this test grid (Visualizer + Program tab).')}
          >
            <Icon name="chevron-right" size={15} /> {t('laser.testgrid.send', 'Send grid to Program')}
          </button>
        </>
      )}
    </section>
  )
}

/** Machine states in which it is safe to fire the frame / focus dot. */
const FRAME_OK_STATES = new Set(['Idle', 'Check'])

/**
 * Low-power FRAME + FOCUS DOT card (L15). Traces the job outline (bounding box
 * or convex-hull rubber-band) at a low, operator-set power so the operator sees
 * exactly where the job lands on the material BEFORE cutting; plus a momentary
 * focus dot for manual focusing. Both FIRE THE BEAM, so each is gated behind a
 * connect + idle check AND an explicit arm → confirm step (auto-disarming after
 * a few seconds). Emission routes through the safe laser emitter
 * (`emitLaserFrameProgram` / `laserDotOnCommand`): constant M3, low clamped S,
 * S0 on every travel, M5 S0 at the end. The dot auto-extinguishes if the
 * machine leaves Idle or disconnects.
 */
function LaserFrameCard(props: {
  placed: PlacedContour[]
  sMax: number
  cutFeed: number
  decimals: number
}) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const machineState = useMachine((s) => s.state)
  const connected = connection === 'connected'
  const idle = FRAME_OK_STATES.has(machineState)
  const canFire = connected && idle

  const [shape, setShape] = usePersistentState<LaserFrameShape>('karmyogi.laser.frame.shape', 'box')
  const [powerPct, setPowerPct] = usePersistentState<number>('karmyogi.laser.frame.power', 5)
  const [marginMm, setMarginMm] = usePersistentState<number>('karmyogi.laser.frame.margin', 2)
  const [loops, setLoops] = usePersistentState<number>('karmyogi.laser.frame.loops', 1)
  const [frameFeed, setFrameFeed] = usePersistentState<number>('karmyogi.laser.frame.feed', 1500)

  const [armFrame, setArmFrame] = useState(false)
  const [running, setRunning] = useState(false)
  const [armDot, setArmDot] = useState(false)
  const [dotOn, setDotOn] = useState(false)

  const hasJob = props.placed.length > 0
  const safePct = clamp(powerPct, 0, kMaxFramePowerPct)
  const frameS = Math.round((safePct / 100) * Math.max(1, props.sMax))

  // Auto-disarm a pending confirm so a stray arm never lingers / fires later.
  useEffect(() => {
    if (!armFrame) return
    const id = window.setTimeout(() => setArmFrame(false), 4000)
    return () => window.clearTimeout(id)
  }, [armFrame])
  useEffect(() => {
    if (!armDot) return
    const id = window.setTimeout(() => setArmDot(false), 4000)
    return () => window.clearTimeout(id)
  }, [armDot])

  // SAFETY: if the machine leaves Idle or disconnects while the dot is on, kill
  // it immediately (and command M5 if we can still reach the controller).
  useEffect(() => {
    if (dotOn && (!connected || !idle)) {
      setDotOn(false)
      if (connected) void grbl.send(kLaserOffCommand)
    }
  }, [connected, idle, dotOn])

  async function runFrame() {
    if (!canFire || !hasJob || running) return
    const gcode = emitLaserFrameProgram(props.placed, {
      shape,
      powerPct: safePct,
      marginMm,
      loops,
      feed: frameFeed,
      sMax: props.sMax,
      decimals: props.decimals,
    })
    const lines = gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length === 0) return
    setArmFrame(false)
    setRunning(true)
    try {
      // Stream via the MDI path so the loaded program / cursor is untouched.
      for (const line of lines) await grbl.send(line)
    } catch {
      /* surfaced on the console by grbl.send */
    } finally {
      setRunning(false)
    }
  }

  async function toggleDot() {
    if (dotOn) {
      // OFF is always immediate (safe) regardless of state.
      setDotOn(false)
      try {
        await grbl.send(kLaserOffCommand)
      } catch {
        /* console */
      }
      return
    }
    if (!canFire) return
    if (!armDot) {
      setArmDot(true)
      return
    }
    setArmDot(false)
    setDotOn(true)
    try {
      await grbl.send(laserDotOnCommand(safePct, props.sMax))
    } catch {
      /* console */
    }
  }

  const frameTip = !connected
    ? t('laser.lframe.run.connect', 'Connect the machine to frame the job.')
    : !idle
      ? t('laser.lframe.run.busy', 'Machine is {state} — wait until Idle.', { state: machineState })
      : !hasJob
        ? t('laser.lframe.run.nojob', 'Import a drawing first.')
        : armFrame
          ? t('laser.lframe.run.armed', 'Click again to fire the low-power frame (≈ S{s}).', { s: frameS })
          : t('laser.lframe.run.ready', 'Trace the job outline at {pct}% (≈ S{s}) so you can see where it lands.', { pct: safePct, s: frameS })

  const dotTip = dotOn
    ? t('laser.lframe.dot.on', 'Beam is firing a focus dot — click to stop.')
    : !canFire
      ? t('laser.lframe.dot.gate', 'Connect + Idle to fire a focus dot.')
      : armDot
        ? t('laser.lframe.dot.armed', 'Click again to fire a constant low-power focus dot (≈ S{s}).', { s: frameS })
        : t('laser.lframe.dot.ready', 'Fire a stationary low-power dot (M3 constant) to focus the head manually.')

  return (
    <section className="lp-card ui-card">
      <div className="lp-card-head">
        <h4 className="ui-sec-head">
          <span className="cam-card-ico" aria-hidden="true">
            <Icon name="frame" size={14} />
          </span>
          {t('laser.lframe.title', 'Frame & focus (low power)')}
        </h4>
      </div>
      <p className="lp-hint">
        {t(
          'laser.lframe.hint',
          'Trace the job outline at low power so you can see exactly where it lands on the material before cutting. The beam fires — wear rated eye protection.',
        )}
      </p>
      <div className="lp-segrow">
        <span
          className="lp-segrow-label"
          title={t('laser.lframe.shape.title', 'Box = bounding rectangle; Hull = convex-hull rubber-band (tight outline).')}
        >
          {t('laser.lframe.shape', 'Outline')}
        </span>
        <SegControl<LaserFrameShape>
          ariaLabel={t('laser.lframe.shape', 'Frame outline')}
          value={shape}
          onChange={setShape}
          options={[
            { value: 'box', label: t('laser.lframe.box', 'Box'), icon: 'frame' },
            { value: 'hull', label: t('laser.lframe.hull', 'Hull'), icon: 'duplicate' },
          ]}
        />
      </div>
      <div className="lp-sliders">
        <SliderField
          icon={<Icon name="laser" size={14} />}
          label={t('laser.lframe.power', 'Frame power')}
          unit="%"
          min={0}
          max={kMaxFramePowerPct}
          step={1}
          integer
          value={safePct}
          onChange={(n) => setPowerPct(clamp(Math.round(n), 0, kMaxFramePowerPct))}
          title={t('laser.lframe.power.title', 'Low marking power as a % of S-max — capped at {max}% so framing marks but never cuts. ≈ S{s}.', { max: kMaxFramePowerPct, s: frameS })}
        />
        <SliderField
          icon={<Icon name="jog" size={14} />}
          label={t('laser.lframe.margin', 'Margin')}
          unit="mm"
          min={0}
          max={50}
          step={0.5}
          value={marginMm}
          onChange={(n) => setMarginMm(clamp(n, 0, 50))}
          title={t('laser.lframe.margin.title', 'Grow the outline outward so the trace clears the part.')}
        />
        <SliderField
          icon={<Icon name="copy" size={14} />}
          label={t('laser.lframe.loops', 'Loops')}
          min={1}
          max={10}
          step={1}
          integer
          value={loops}
          onChange={(n) => setLoops(clamp(Math.floor(n), 1, 10))}
          title={t('laser.lframe.loops.title', 'How many times to trace the outline.')}
        />
        <SliderField
          icon={<Icon name="jog" size={14} />}
          label={t('laser.lframe.feed', 'Frame speed')}
          unit="mm/min"
          min={1}
          max={10000}
          step={10}
          value={frameFeed}
          onChange={(n) => setFrameFeed(clamp(n, 1, 10000))}
          title={t('laser.lframe.feed.title', 'Feed rate for the perimeter trace (G1 F…).')}
        />
      </div>
      <div className="lp-frame-actions">
        <button
          type="button"
          className={`cam-primary lp-fire${armFrame ? ' is-armed' : ''}`}
          disabled={!canFire || !hasJob || running}
          onClick={() => {
            if (!armFrame) {
              setArmFrame(true)
              return
            }
            void runFrame()
          }}
          title={frameTip}
          aria-label={frameTip}
        >
          <Icon name={armFrame ? 'warning' : 'frame'} size={15} />{' '}
          {running
            ? t('laser.lframe.framing', 'Framing…')
            : armFrame
              ? t('laser.lframe.confirm', 'Confirm — fire frame')
              : t('laser.lframe.run', 'Frame (low power)')}
        </button>
        <button
          type="button"
          className={`cam-secondary lp-fire${dotOn ? ' is-on' : ''}${armDot ? ' is-armed' : ''}`}
          disabled={!canFire && !dotOn}
          onClick={() => void toggleDot()}
          title={dotTip}
          aria-label={dotTip}
        >
          <Icon name={dotOn ? 'pause' : armDot ? 'warning' : 'laser'} size={15} />{' '}
          {dotOn
            ? t('laser.lframe.dotOff', 'Stop focus dot')
            : armDot
              ? t('laser.lframe.dotConfirm', 'Confirm — fire dot')
              : t('laser.lframe.dot', 'Focus dot')}
        </button>
      </div>
      {connected && !idle && (
        <p className="lp-hint is-warn">
          {t('laser.lframe.busy', 'Machine is {state} — wait until Idle to frame or focus.', { state: machineState })}
        </p>
      )}
      {connected && idle && !hasJob && (
        <p className="lp-hint">{t('laser.lframe.nojob', 'Import a drawing to frame the job outline.')}</p>
      )}
      {!connected && (
        <p className="lp-hint">{t('laser.lframe.connect', 'Connect the machine to frame or focus.')}</p>
      )}
      <p className="lp-note">
        {t(
          'laser.lframe.note',
          'Frames in constant-power (M3) mode at low S; the beam is OFF (S0/M5) on every travel and at the end. The focus dot stays on until you stop it — never leave a firing laser unattended.',
        )}
      </p>
    </section>
  )
}

/** The combined-laser params persisted to localStorage. */
interface PanelParams {
  mode: LaserMode
  cutFeed: number
  power: number
  sMax: number
  passes: number
  powerMode: LaserPowerMode
  useFocusZ: boolean
  focusZ: number
  pierce: boolean
  piercePower: number
  pierceTime: number
  airAssist: boolean
  decimals: number
  // L8 — travel optimization
  optimizeTravel: boolean
  // L9 — tabs / bridges
  tabsOn: boolean
  tabCount: number
  tabWidth: number
  // L11 — fill
  fill: FillStyle
  fillSpacing: number
  fillAngle: number
  // L14 — rotary
  rotary: boolean
  rotaryAxis: 'A' | 'B' | 'C' | 'Y'
  rotaryDiameter: number
  // L18 — fiber galvo pulse
  fiberFrequencyKHz: number
  fiberPulseNs: number
}

function defaultsFor(mode: LaserMode): PanelParams {
  const d = defaultLaserParams(mode)
  return {
    mode,
    cutFeed: d.cutFeed,
    power: d.power,
    sMax: d.sMax,
    passes: d.passes,
    powerMode: d.powerMode,
    useFocusZ: d.useFocusZ,
    focusZ: d.focusZ,
    pierce: d.pierce,
    piercePower: d.piercePower,
    pierceTime: d.pierceTime,
    airAssist: d.airAssist ?? false,
    decimals: d.decimals,
    optimizeTravel: true,
    tabsOn: false,
    tabCount: 4,
    tabWidth: 0.5,
    fill: FillStyle.None,
    fillSpacing: 0.3,
    fillAngle: 0,
    rotary: false,
    rotaryAxis: d.rotaryAxis ?? 'A',
    rotaryDiameter: d.rotaryDiameter ?? 50,
    fiberFrequencyKHz: d.fiberFrequencyKHz ?? 30,
    fiberPulseNs: d.fiberPulseNs ?? 200,
  }
}

/** Sheet / nesting settings persisted alongside the laser params. */
interface SheetSettings {
  sheetW: number
  sheetH: number
  margin: number
  quantity: number
  doNest: boolean
}

/** The serializable Laser document written by Save / read by Load. */
interface LaserDoc {
  kind: 'karmyogi.laser'
  version: 1
  mode: LaserMode
  co2: PanelParams
  fiber: PanelParams
  sheet: SheetSettings
}

/**
 * A reusable LASER setting preset: the current mode plus BOTH mode param records
 * and the sheet/nesting settings (NOT the imported DXF contours, which are the
 * operator's actual work). Scoped to its own persistence key, independent of the
 * carving / soldering / writing presets.
 */
interface LaserPreset {
  mode: LaserMode
  co2: PanelParams
  fiber: PanelParams
  sheet: SheetSettings
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const numOr = (v: unknown, f: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : f
const boolOr = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f)

const VALID_MODES: LaserMode[] = [LaserMode.CO2, LaserMode.Fiber]
const VALID_POWER_MODES: LaserPowerMode[] = [LaserPowerMode.Dynamic, LaserPowerMode.Constant]
const VALID_FILLS: FillStyle[] = [FillStyle.None, FillStyle.Line, FillStyle.Offset]
const VALID_ROT_AXES: Array<'A' | 'B' | 'C' | 'Y'> = ['A', 'B', 'C', 'Y']

/** Narrow unknown into a valid PanelParams, falling back per-field to `base`. */
function parseParams(v: unknown, base: PanelParams): PanelParams {
  if (!isRecord(v)) return base
  const mode = VALID_MODES.includes(v.mode as LaserMode) ? (v.mode as LaserMode) : base.mode
  const powerMode = VALID_POWER_MODES.includes(v.powerMode as LaserPowerMode)
    ? (v.powerMode as LaserPowerMode)
    : base.powerMode
  return {
    mode,
    cutFeed: numOr(v.cutFeed, base.cutFeed),
    power: numOr(v.power, base.power),
    sMax: numOr(v.sMax, base.sMax),
    passes: numOr(v.passes, base.passes),
    powerMode,
    useFocusZ: boolOr(v.useFocusZ, base.useFocusZ),
    focusZ: numOr(v.focusZ, base.focusZ),
    pierce: boolOr(v.pierce, base.pierce),
    piercePower: numOr(v.piercePower, base.piercePower),
    pierceTime: numOr(v.pierceTime, base.pierceTime),
    airAssist: boolOr(v.airAssist, base.airAssist),
    decimals: numOr(v.decimals, base.decimals),
    optimizeTravel: boolOr(v.optimizeTravel, base.optimizeTravel),
    tabsOn: boolOr(v.tabsOn, base.tabsOn),
    tabCount: numOr(v.tabCount, base.tabCount),
    tabWidth: numOr(v.tabWidth, base.tabWidth),
    fill: VALID_FILLS.includes(v.fill as FillStyle) ? (v.fill as FillStyle) : base.fill,
    fillSpacing: numOr(v.fillSpacing, base.fillSpacing),
    fillAngle: numOr(v.fillAngle, base.fillAngle),
    rotary: boolOr(v.rotary, base.rotary),
    rotaryAxis: VALID_ROT_AXES.includes(v.rotaryAxis as 'A')
      ? (v.rotaryAxis as 'A' | 'B' | 'C' | 'Y')
      : base.rotaryAxis,
    rotaryDiameter: numOr(v.rotaryDiameter, base.rotaryDiameter),
    fiberFrequencyKHz: numOr(v.fiberFrequencyKHz, base.fiberFrequencyKHz),
    fiberPulseNs: numOr(v.fiberPulseNs, base.fiberPulseNs),
  }
}

/** Narrow unknown into a valid SheetSettings, falling back per-field to `base`. */
function parseSheet(v: unknown, base: SheetSettings): SheetSettings {
  if (!isRecord(v)) return base
  return {
    sheetW: numOr(v.sheetW, base.sheetW),
    sheetH: numOr(v.sheetH, base.sheetH),
    margin: numOr(v.margin, base.margin),
    quantity: clamp(Math.floor(numOr(v.quantity, base.quantity)), 1, MAX_QUANTITY),
    doNest: boolOr(v.doNest, base.doNest),
  }
}

/** Map a structured nesting warning to a localized string (code → t(), else fallback). */
function useNestWarnText() {
  const t = useT()
  return (w: NestWarning): string => {
    switch (w.code) {
      case 'tooLarge':
        return t(
          'laser.nest.warn.tooLarge',
          'Job is larger ({jobW}×{jobH} mm) than the sheet ({bedW}×{bedH} mm) — shrink it or use a bigger sheet.',
          w.params,
        )
      case 'edgeOverflow':
        return t(
          'laser.nest.warn.edgeOverflow',
          'Not all jobs fit on the sheet — they are stacked but overlap the edge.',
        )
      default:
        return w.message
    }
  }
}

/**
 * Laser-cutting workbench — handles BOTH CO2 and Fiber in one UI. A mode radio
 * at the top toggles the few mode-specific controls (piercing / focus-Z); DXF
 * import, nesting, ordering and the common cut params drive a single pure core
 * (`emitLaserProgram`). Generation is LIVE: every edit pushes a fresh program
 * into the shared store (debounced) so the Visualizer renders it and the
 * Program tab streams it — there is no explicit "send" here.
 */
/** Top-level workbench: vector cutting vs raster image engraving. */
type LaserWorkbench = 'vector' | 'image'

/**
 * Laser workbench shell — switches between the VECTOR cutting workbench (DXF →
 * cut loops/lines) and the RASTER IMAGE engraving workbench (PNG/JPG → dithered
 * PWM raster). The two share the same Program-store sync contract (`'laser'`
 * section name) so only ONE is ever pushing G-code at a time.
 */
export function LaserPanel() {
  const t = useT()
  const [workbench, setWorkbench] = usePersistentState<LaserWorkbench>(
    'karmyogi.laser.workbench',
    'vector',
  )
  return (
    <div className="cc-presets-host" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="li-wb-switch">
        <KitSeg<LaserWorkbench>
          ariaLabel={t('laser.img.wb.aria', 'Laser workbench')}
          value={workbench}
          onChange={setWorkbench}
          options={[
            {
              value: 'vector',
              title: t('laser.img.wb.vector.title', 'Vector cutting — DXF contours become cut loops and lines.'),
              label: (
                <>
                  <Icon name="frame" size={14} /> {t('laser.img.wb.vector', 'Vector cut')}
                </>
              ),
            },
            {
              value: 'image',
              title: t('laser.img.wb.image.title', 'Raster engraving — a photo or logo burned line-by-line with dithering.'),
              label: (
                <>
                  <Icon name="camera" size={14} /> {t('laser.img.wb.image', 'Image engrave')}
                </>
              ),
            },
          ]}
        />
      </div>
      {workbench === 'image' ? <LaserImageWorkbench /> : <LaserVectorWorkbench />}
    </div>
  )
}

// ===========================================================================
//  RASTER IMAGE ENGRAVING WORKBENCH
// ===========================================================================

/** Cap the working (dither) resolution so the live preview stays responsive. */
const MAX_WORK_PX = 1100 // longest edge of the working raster (≈1.2 MP cap)

/** Image-workbench slider row — a thin wrapper over the shared {@link KitSlider}. */
function ImgField(props: {
  icon: IconName
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  title?: string
  integer?: boolean
  onChange: (n: number) => void
}) {
  const { label, value, min, max, step, unit, title, integer, onChange } = props
  return (
    <KitSlider
      label={label}
      value={value}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : undefined)}
      unit={unit}
      title={title}
      onChange={onChange}
    />
  )
}

/** Decoded source image kept in memory as RGBA + its native dimensions. */
interface SourceImage {
  rgba: Uint8ClampedArray
  w: number
  h: number
  name: string
}

/** Image-engraving params persisted to localStorage (adjust + raster + dither). */
interface ImgParams {
  adjust: ImageAdjust
  dither: DitherMode
  newsCell: number
  // raster (subset of RasterParams driven by the UI)
  dpi: number
  scanAngle: ScanAngle
  overscan: number
  bidirectional: boolean
  scanOffset: number
  dotMode: boolean
  dotDwell: number
  widthMm: number
  lockAspect: boolean
  feed: number
  dynamicPower: boolean
  sMin: number
  sMax: number
  passes: number
  zPerPass: number
  useFocusZ: boolean
  focusZ: number
  airAssist: boolean
  decimals: number
}

function defaultImgParams(): ImgParams {
  const r = defaultRasterParams()
  return {
    adjust: defaultImageAdjust(),
    dither: DitherMode.FloydSteinberg,
    newsCell: 4,
    dpi: Math.round(intervalToDpi(r.lineInterval)),
    scanAngle: ScanAngle.Horizontal,
    overscan: r.overscan,
    bidirectional: r.bidirectional,
    scanOffset: r.scanOffset,
    dotMode: r.dotMode,
    dotDwell: r.dotDwell,
    widthMm: r.widthMm,
    lockAspect: true,
    feed: r.feed,
    dynamicPower: r.dynamicPower,
    sMin: r.sMin,
    sMax: r.sMax,
    passes: r.passes,
    zPerPass: r.zPerPass,
    useFocusZ: r.useFocusZ,
    focusZ: r.focusZ,
    airAssist: r.airAssist,
    decimals: r.decimals,
  }
}

function LaserImageWorkbench() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const streaming = useProgram((s) => s.streaming)

  const [params, setParams] = usePersistentState<ImgParams>(
    'karmyogi.laser.img.params',
    defaultImgParams(),
  )
  const patch = useCallback(
    (p: Partial<ImgParams>) => setParams((cur) => ({ ...cur, ...p })),
    [setParams],
  )
  const patchAdjust = useCallback(
    (p: Partial<ImageAdjust>) => setParams((cur) => ({ ...cur, adjust: { ...cur.adjust, ...p } })),
    [setParams],
  )

  // Source image (NOT persisted — re-import each session).
  const [src, setSrc] = useState<SourceImage | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<'dither' | 'source'>('dither')
  const [busy, setBusy] = useState(false)

  const previewCanvas = useRef<HTMLCanvasElement>(null)

  // ---- Load + decode an image file to RGBA via an offscreen canvas. -------
  const loadFile = useCallback((file: File) => {
    setLoadErr('')
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      // Downscale to the working cap on load (keeps everything fast).
      const scale = Math.min(1, MAX_WORK_PX / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const cv = document.createElement('canvas')
      cv.width = w
      cv.height = h
      const ctx = cv.getContext('2d')
      if (!ctx) {
        setLoadErr(t('laser.img.err.decode', 'Could not decode the image.'))
        URL.revokeObjectURL(url)
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      setSrc({ rgba: new Uint8ClampedArray(data), w, h, name: file.name })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      setLoadErr(t('laser.img.err.load', 'Could not load {name}. Use a PNG or JPG.', { name: file.name }))
      URL.revokeObjectURL(url)
    }
    img.src = url
  }, [t])

  // Engraved output height derived from aspect when locked.
  const aspect = src ? src.h / src.w : 0.75
  const heightMm = useMemo(
    () => (params.lockAspect && src ? params.widthMm * aspect : params.widthMm * aspect),
    [params.lockAspect, params.widthMm, aspect, src],
  )

  // ---- Live dither (debounced) → burn map + preview canvas. ---------------
  // The dither result is the SAME burn map the emitter uses, so the preview is
  // literally what will burn. Kept off the critical path via a debounce.
  const [burn, setBurn] = useState<{ map: Float32Array; w: number; h: number } | null>(null)

  useEffect(() => {
    if (!src) {
      setBurn(null)
      return
    }
    setBusy(true)
    const id = window.setTimeout(() => {
      const gray = rgbaToGray(src.rgba, src.w, src.h, params.adjust)
      const map = dither(gray, params.dither, params.newsCell)
      setBurn({ map, w: src.w, h: src.h })
      setBusy(false)
    }, 180)
    return () => window.clearTimeout(id)
  }, [src, params.adjust, params.dither, params.newsCell])

  // Paint the preview canvas whenever the burn map / source / tab changes.
  useEffect(() => {
    const cv = previewCanvas.current
    if (!cv || !src) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    cv.width = src.w
    cv.height = src.h
    if (preview === 'source') {
      const imgData = ctx.createImageData(src.w, src.h)
      imgData.data.set(src.rgba)
      ctx.putImageData(imgData, 0, 0)
    } else if (burn) {
      const rgba = burnToRGBA(burn.map, burn.w, burn.h)
      const imgData = ctx.createImageData(burn.w, burn.h)
      imgData.data.set(rgba)
      ctx.putImageData(imgData, 0, 0)
    }
  }, [burn, src, preview])

  // ---- Raster G-code (recomputed from the burn map + params). -------------
  const result = useMemo(() => {
    if (!burn) return null
    const rp: Partial<RasterParams> = {
      widthMm: Math.max(1, params.widthMm),
      heightMm: Math.max(1, params.widthMm * aspect),
      lineInterval: dpiToInterval(params.dpi),
      scanAngle: params.scanAngle,
      overscan: Math.max(0, params.overscan),
      bidirectional: params.bidirectional,
      scanOffset: Math.max(0, params.scanOffset),
      dotMode: params.dotMode,
      dotDwell: Math.max(0, params.dotDwell),
      feed: Math.max(1, params.feed),
      dynamicPower: params.dynamicPower,
      sMin: Math.max(0, Math.min(params.sMin, params.sMax)),
      sMax: Math.max(params.sMin, params.sMax),
      passes: Math.max(1, Math.floor(params.passes)),
      zPerPass: params.zPerPass,
      useFocusZ: params.useFocusZ,
      focusZ: params.focusZ,
      airAssist: params.airAssist ?? false,
      decimals: params.decimals,
      programName: `hjLabs Laser raster — ${src?.name ?? 'image'}`,
    }
    return emitRasterProgram(burn.map, burn.w, burn.h, rp)
  }, [burn, params, aspect, src])

  // Live sync to the Program store (debounced; never while streaming).
  useEffect(() => {
    if (streaming) return
    const gcode = result?.gcode ?? ''
    const id = window.setTimeout(() => setProgram('laser', gcode), 300)
    return () => window.clearTimeout(id)
  }, [result, setProgram, streaming])

  const showNewsCell = params.dither === DitherMode.Newsprint
  const sMaxPct = params.sMax > 0 ? Math.round((params.sMin / params.sMax) * 100) : 0

  // ── Gamepad command bus: frame the raster job's perimeter (tool/laser OFF). ──
  useTabCommands('laser', {
    frame: () => {
      const lines = result?.gcode ? result.gcode.split(/\r?\n/) : []
      if (!grbl.isConnected || lines.length === 0) return
      const bounds = frameBoundsOfGcode(lines)
      if (!bounds || !bounds.isValid()) return
      for (const ln of buildFrameProgram(bounds, { safeZ: 5 })) void grbl.send(ln)
    },
  })

  return (
    <div className="li-root">
      {/* Header + live status. */}
      <header className="li-head">
        <span className="li-head-title">
          <span className="li-head-ico" aria-hidden>
            <Icon name="camera" size={15} />
          </span>
          {t('laser.img.title', 'Image raster engraving')}
        </span>
        <span className="li-head-spacer" />
        <FrameButton
          lines={result?.gcode ? result.gcode.split(/\r?\n/) : []}
          showOptions={false}
          label={t('laser.img.frame', 'Frame')}
          className="lp-frame"
        />
      </header>

      <div className="li-status">
        {src ? (
          <>
            <span className="li-status-pill">
              <b>{src.w}×{src.h}</b> px
            </span>
            <span className="li-status-sep" aria-hidden>·</span>
            <span className="li-status-pill">
              <b>{params.widthMm.toFixed(0)}×{heightMm.toFixed(0)}</b> mm
            </span>
            <span className="li-status-sep" aria-hidden>·</span>
            <span className="li-status-pill"><b>{params.dpi}</b> DPI</span>
            {result && (
              <>
                <span className="li-status-sep" aria-hidden>·</span>
                <span className="li-status-pill"><b>{result.scanLines}</b> {t('laser.img.status.lines', 'lines')}</span>
                <span className="li-status-sep" aria-hidden>·</span>
                <span
                  className="li-status-pill"
                  title={t('laser.img.status.estTitle', 'Estimated burn-path length and time (all passes).')}
                >
                  <b>{(result.pathLengthMm / 1000).toFixed(1)} m</b> · <b>{fmtDuration(result.timeSeconds)}</b>
                </span>
              </>
            )}
          </>
        ) : (
          <span>{t('laser.img.status.none', 'No image loaded')}</span>
        )}
        <span
          className="li-status-sync"
          title={
            streaming
              ? t('laser.img.status.streamingTitle', 'Streaming — live sync paused so the running job is not reset.')
              : t('laser.img.status.syncTitle', 'Lines auto-synced to the Program tab.')
          }
        >
          {streaming ? (
            <>
              <Icon name="play" size={12} /> {t('laser.img.status.streaming', 'Streaming')}
            </>
          ) : (
            <>
              <Icon name="chevron-right" size={12} /> {t('laser.img.status.program', 'Program')}
            </>
          )}
        </span>
      </div>

      {/* Live preview — the glance-to-understand centerpiece. */}
      <section className="li-card ui-card">
        <div className="li-card-head">
          <h4 className="ui-sec-head">
            <span className="li-card-ico" aria-hidden>
              <Icon name="eye" size={14} />
            </span>
            {t('laser.img.preview.title', 'Preview')}
          </h4>
          {src && (
            <div className="li-preview-tabs" role="tablist" aria-label={t('laser.img.preview.aria', 'Preview source')}>
              <button
                type="button"
                role="tab"
                aria-selected={preview === 'dither'}
                className={`li-preview-tab${preview === 'dither' ? ' is-on' : ''}`}
                onClick={() => setPreview('dither')}
                title={t('laser.img.preview.dither.title', 'Exactly what will burn — the dithered result.')}
              >
                {t('laser.img.preview.dither', 'Dithered')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={preview === 'source'}
                className={`li-preview-tab${preview === 'source' ? ' is-on' : ''}`}
                onClick={() => setPreview('source')}
                title={t('laser.img.preview.source.title', 'The original image (before adjustments/dither).')}
              >
                {t('laser.img.preview.source', 'Original')}
              </button>
            </div>
          )}
        </div>
        <div className="li-preview">
          {src ? (
            <>
              <canvas ref={previewCanvas} />
              {busy && (
                <div className="li-preview-busy">
                  <CamBusy label={t('laser.img.preview.busy', 'Rendering…')} />
                </div>
              )}
            </>
          ) : (
            <div className="li-preview-empty">
              <span className="li-empty-ico" aria-hidden>
                <Icon name="camera" size={26} />
              </span>
              <p>{t('laser.img.preview.empty', 'Load a PNG or JPG to see the live dithered preview — exactly what the laser will burn.')}</p>
            </div>
          )}
        </div>
        <div className="li-import-row" style={{ marginTop: 'var(--sp-2)' }}>
          <button type="button" className="li-primary" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={15} /> {src ? t('laser.img.replace', 'Replace image…') : t('laser.img.load', 'Load image…')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadFile(f)
              e.target.value = ''
            }}
          />
          {src && <span className="li-import-info">{src.name}</span>}
        </div>
        {loadErr && (
          <CamError
            icon={<Icon name="camera" size={20} />}
            title={t('laser.img.err.title', 'Could not load image')}
            message={loadErr}
            onRetry={() => fileRef.current?.click()}
            retryLabel={t('laser.img.err.retry', 'Choose another image')}
          />
        )}
      </section>

      {/* Image adjustments. */}
      <section className="li-card ui-card">
        <div className="li-card-head">
          <h4 className="ui-sec-head">
            <span className="li-card-ico" aria-hidden>
              <Icon name="settings" size={14} />
            </span>
            {t('laser.img.adjust.title', 'Image')}
          </h4>
        </div>
        <div className="li-fields">
          <ImgField
            icon="settings"
            label={t('laser.img.adjust.brightness', 'Brightness')}
            min={-100}
            max={100}
            step={1}
            integer
            value={params.adjust.brightness}
            onChange={(n) => patchAdjust({ brightness: n })}
            title={t('laser.img.adjust.brightness.title', 'Lighten or darken the whole image before dithering (−100…100).')}
          />
          <ImgField
            icon="settings"
            label={t('laser.img.adjust.contrast', 'Contrast')}
            min={-100}
            max={100}
            step={1}
            integer
            value={params.adjust.contrast}
            onChange={(n) => patchAdjust({ contrast: n })}
            title={t('laser.img.adjust.contrast.title', 'Expand or compress the tonal range around mid-grey (−100…100).')}
          />
          <ImgField
            icon="settings"
            label={t('laser.img.adjust.gamma', 'Gamma')}
            min={0.1}
            max={3}
            step={0.05}
            value={params.adjust.gamma}
            onChange={(n) => patchAdjust({ gamma: n })}
            title={t('laser.img.adjust.gamma.title', 'Midtone curve. <1 darkens mids, >1 lightens them (0.1…3).')}
          />
        </div>
        <div className="li-toggle-row">
          <label className="li-toggle" title={t('laser.img.adjust.invert.title', 'Swap black and white — engrave the negative.')}>
            <input
              type="checkbox"
              checked={params.adjust.invert}
              onChange={(e) => patchAdjust({ invert: e.target.checked })}
            />
            {t('laser.img.adjust.invert', 'Invert')}
          </label>
        </div>
      </section>

      {/* Dither mode. */}
      <section className="li-card ui-card">
        <div className="li-card-head">
          <h4 className="ui-sec-head">
            <span className="li-card-ico" aria-hidden>
              <Icon name="copy" size={14} />
            </span>
            {t('laser.img.dither.title', 'Dither')}
          </h4>
        </div>
        <div className="li-dither-grid" role="radiogroup" aria-label={t('laser.img.dither.aria', 'Dither mode')}>
          {[
            { value: DitherMode.Threshold, label: t('laser.img.dither.threshold', 'Threshold'), title: t('laser.img.dither.threshold.title', 'Hard 50% cut — pure black/white, no shading.') },
            { value: DitherMode.Ordered, label: t('laser.img.dither.ordered', 'Ordered'), title: t('laser.img.dither.ordered.title', 'Bayer matrix — fast, regular crosshatch pattern.') },
            { value: DitherMode.FloydSteinberg, label: t('laser.img.dither.floyd', 'Floyd–Steinberg'), title: t('laser.img.dither.floyd.title', 'Classic error diffusion — best all-round photo detail.') },
            { value: DitherMode.Jarvis, label: t('laser.img.dither.jarvis', 'Jarvis'), title: t('laser.img.dither.jarvis.title', 'Wider diffusion — smoother gradients, slightly softer.') },
            { value: DitherMode.Stucki, label: t('laser.img.dither.stucki', 'Stucki'), title: t('laser.img.dither.stucki.title', 'Sharp, clean diffusion with strong edge retention.') },
            { value: DitherMode.Atkinson, label: t('laser.img.dither.atkinson', 'Atkinson'), title: t('laser.img.dither.atkinson.title', 'High-contrast, airy look (classic Mac).') },
            { value: DitherMode.Newsprint, label: t('laser.img.dither.newsprint', 'Newsprint'), title: t('laser.img.dither.newsprint.title', 'Clustered round dots — print/halftone look that survives low DPI.') },
            { value: DitherMode.Grayscale, label: t('laser.img.dither.grayscale', 'Grayscale'), title: t('laser.img.dither.grayscale.title', 'No dither — power varies continuously with tone (variable-depth).') },
          ].map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={params.dither === o.value}
              className={`li-seg-btn${params.dither === o.value ? ' is-on' : ''}`}
              title={o.title}
              onClick={() => patch({ dither: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
        {showNewsCell && (
          <div className="li-fields" style={{ marginTop: 'var(--sp-2)' }}>
            <ImgField
              icon="settings"
              label={t('laser.img.dither.cell', 'Dot cell')}
              unit="px"
              min={2}
              max={12}
              step={1}
              integer
              value={params.newsCell}
              onChange={(n) => patch({ newsCell: n })}
              title={t('laser.img.dither.cell.title', 'Halftone cell size — bigger cells = coarser, more visible dots.')}
            />
          </div>
        )}
      </section>

      {/* Raster geometry. */}
      <section className="li-card ui-card">
        <div className="li-card-head">
          <h4 className="ui-sec-head">
            <span className="li-card-ico" aria-hidden>
              <Icon name="frame" size={14} />
            </span>
            {t('laser.img.raster.title', 'Raster')}
          </h4>
        </div>
        <div className="li-fields">
          <ImgField
            icon="frame"
            label={t('laser.img.raster.width', 'Width')}
            unit="mm"
            min={1}
            max={1000}
            step={1}
            value={params.widthMm}
            onChange={(n) => patch({ widthMm: n })}
            title={t('laser.img.raster.width.title', 'Engraved output width (X). Height follows the image aspect ratio.')}
          />
          <ImgField
            icon="settings"
            label={t('laser.img.raster.dpi', 'DPI')}
            unit="dpi"
            min={50}
            max={1200}
            step={10}
            integer
            value={params.dpi}
            onChange={(n) => patch({ dpi: n })}
            title={t('laser.img.raster.dpi.title', 'Lines per inch. Interval = {mm} mm. Higher = finer + slower.', { mm: dpiToInterval(params.dpi).toFixed(3) })}
          />
          <ImgField
            icon="jog"
            label={t('laser.img.raster.overscan', 'Overscan')}
            unit="mm"
            min={0}
            max={20}
            step={0.5}
            value={params.overscan}
            onChange={(n) => patch({ overscan: n })}
            title={t('laser.img.raster.overscan.title', 'Extra travel past each end of a line so the head is at full speed over edge pixels (avoids edge over-burn).')}
          />
        </div>
        <div className="li-segrow">
          <span className="li-segrow-label" title={t('laser.img.raster.angle.title', 'Scan-line direction: horizontal (sweep X) or vertical (sweep Y).')}>
            {t('laser.img.raster.angle', 'Scan angle')}
          </span>
          <KitSeg<ScanAngle>
            ariaLabel={t('laser.img.raster.angle', 'Scan angle')}
            value={params.scanAngle}
            onChange={(v) => patch({ scanAngle: v })}
            options={[
              { value: ScanAngle.Horizontal, label: t('laser.img.raster.angle.h', '0° (horizontal)') },
              { value: ScanAngle.Vertical, label: t('laser.img.raster.angle.v', '90° (vertical)') },
            ]}
          />
        </div>
        <div className="li-toggle-row">
          <label className="li-toggle" title={t('laser.img.raster.bidi.title', 'Engrave on both sweep directions (faster) vs always left-to-right (more consistent, slower).')}>
            <input
              type="checkbox"
              checked={params.bidirectional}
              onChange={(e) => patch({ bidirectional: e.target.checked })}
            />
            {t('laser.img.raster.bidi', 'Bidirectional')}
          </label>
          <label className="li-toggle" title={t('laser.img.raster.dot.title', 'Fire a short dwell at each lit pixel (perforate / stipple) instead of continuous sweeps. Beam is off between dots.')}>
            <input
              type="checkbox"
              checked={params.dotMode}
              onChange={(e) => patch({ dotMode: e.target.checked })}
            />
            {t('laser.img.raster.dot', 'Dot mode')}
          </label>
        </div>
        {(params.bidirectional || params.dotMode) && (
          <div className="li-fields" style={{ marginTop: 'var(--sp-2)' }}>
            {params.bidirectional && (
              <ImgField
                icon="jog"
                label={t('laser.img.raster.scanOffset', 'Scan offset')}
                unit="mm"
                min={0}
                max={2}
                step={0.01}
                value={params.scanOffset}
                onChange={(n) => patch({ scanOffset: clamp(n, 0, 2) })}
                title={t('laser.img.raster.scanOffset.title', 'Shift reverse rows forward to correct bidirectional mis-alignment (mechanical/laser lag). Dial in on a test until edges line up.')}
              />
            )}
            {params.dotMode && (
              <ImgField
                icon="pause"
                label={t('laser.img.raster.dotDwell', 'Dot dwell')}
                unit="s"
                min={0.001}
                max={0.2}
                step={0.001}
                value={params.dotDwell}
                onChange={(n) => patch({ dotDwell: clamp(n, 0.001, 0.2) })}
                title={t('laser.img.raster.dotDwell.title', 'How long the beam dwells at each dot (G4). Longer = deeper / darker dots.')}
              />
            )}
          </div>
        )}
      </section>

      {/* Power + passes. */}
      <section className="li-card ui-card">
        <div className="li-card-head">
          <h4 className="ui-sec-head">
            <span className="li-card-ico" aria-hidden>
              <Icon name="laser" size={14} />
            </span>
            {t('laser.img.power.title', 'Power')}
          </h4>
        </div>
        <div className="li-fields">
          <ImgField
            icon="jog"
            label={t('laser.img.power.feed', 'Feed')}
            unit="mm/min"
            min={1}
            max={20000}
            step={50}
            value={params.feed}
            onChange={(n) => patch({ feed: n })}
            title={t('laser.img.power.feed.title', 'Engraving speed for every scan line (G1 F…).')}
          />
          <ImgField
            icon="laser"
            label={t('laser.img.power.sMin', 'S-min (white)')}
            unit="S"
            min={0}
            max={Math.max(1, params.sMax)}
            step={5}
            integer
            value={params.sMin}
            onChange={(n) => patch({ sMin: clamp(n, 0, Math.max(1, params.sMax)) })}
            title={t('laser.img.power.sMin.title', 'Power for the LIGHTEST tone. Keep low (often 0) so white stays unburnt. ({pct}% of S-max)', { pct: sMaxPct })}
          />
          <ImgField
            icon="laser"
            label={t('laser.img.power.sMax', 'S-max (black)')}
            unit="S"
            min={1}
            max={2000}
            step={10}
            integer
            value={params.sMax}
            onChange={(n) => patch({ sMax: n })}
            title={t('laser.img.power.sMax.title', 'Power for the DARKEST tone (also your GRBL $30 ceiling).')}
          />
          <ImgField
            icon="copy"
            label={t('laser.img.power.passes', 'Passes')}
            min={1}
            max={20}
            step={1}
            integer
            value={params.passes}
            onChange={(n) => patch({ passes: n })}
            title={t('laser.img.power.passes.title', 'How many times the whole image is engraved.')}
          />
          {params.passes > 1 && (
            <ImgField
              icon="probe"
              label={t('laser.img.power.zPerPass', 'Z / pass')}
              unit="mm"
              min={-5}
              max={5}
              step={0.05}
              value={params.zPerPass}
              onChange={(n) => patch({ zPerPass: n })}
              title={t('laser.img.power.zPerPass.title', 'Z change applied each pass (e.g. focus stepping for deep engraves). 0 = none.')}
            />
          )}
          <ImgField
            icon="settings"
            label={t('laser.img.power.decimals', 'Decimals')}
            min={0}
            max={6}
            step={1}
            integer
            value={params.decimals}
            onChange={(n) => patch({ decimals: n })}
            title={t('laser.img.power.decimals.title', 'Coordinate precision in the emitted G-code.')}
          />
        </div>
        <div className="li-segrow">
          <span className="li-segrow-label" title={t('laser.img.power.mode.title', 'M4 dynamic scales power with feed (recommended for engraving — even shading through accel); M3 is constant power.')}>
            {t('laser.img.power.mode', 'Power mode')}
          </span>
          <KitSeg<'dynamic' | 'constant'>
            ariaLabel={t('laser.img.power.mode', 'Power mode')}
            value={params.dynamicPower ? 'dynamic' : 'constant'}
            onChange={(v) => patch({ dynamicPower: v === 'dynamic' })}
            options={[
              {
                value: 'dynamic',
                label: (
                  <>
                    <Icon name="play" size={13} /> {t('laser.img.power.m4', 'M4 dynamic')}
                  </>
                ),
              },
              {
                value: 'constant',
                label: (
                  <>
                    <Icon name="spindle" size={13} /> {t('laser.img.power.m3', 'M3 constant')}
                  </>
                ),
              },
            ]}
          />
        </div>
        <div className="li-toggle-row">
          <label className="li-toggle" title={t('laser.img.power.focus.title', 'Move Z to a fixed focus height at program start (no negative Z — there is no safe-Z retract before it).')}>
            <input
              type="checkbox"
              checked={params.useFocusZ}
              onChange={(e) => patch({ useFocusZ: e.target.checked })}
            />
            {t('laser.img.power.focus', 'Set focus Z')}
          </label>
          {params.useFocusZ && (
            <span className="li-snum">
              <input
                type="number"
                min={0}
                max={200}
                step={0.1}
                value={String(params.focusZ)}
                aria-label={t('laser.img.power.focusZ', 'Focus Z')}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isFinite(v)) patch({ focusZ: clamp(v, 0, 200) })
                }}
              />
              <i>mm</i>
            </span>
          )}
          <label className="li-toggle" title={t('laser.img.power.air.title', 'Switch the air-assist solenoid on for the whole job (M8 at start, M9 at end). Auxiliary output — never gates the beam.')}>
            <input
              type="checkbox"
              checked={params.airAssist ?? false}
              onChange={(e) => patch({ airAssist: e.target.checked })}
            />
            {t('laser.img.power.air', 'Air assist (M8/M9)')}
          </label>
        </div>
      </section>

      <LaserTestGridCard
        defaults={{
          sMax: Math.max(params.sMin, params.sMax),
          powerMax: Math.max(params.sMin, params.sMax),
          feedMin: Math.max(1, Math.round(params.feed / 4)),
          feedMax: Math.max(1, params.feed),
          lineInterval: dpiToInterval(params.dpi),
          dynamicPower: params.dynamicPower,
          airAssist: params.airAssist ?? false,
          decimals: params.decimals,
        }}
      />

      <p className="li-safety">
        <span className="li-safety-ico" aria-hidden>
          <Icon name="warning" size={15} />
        </span>
        <span>
          {t(
            'laser.img.safety',
            'Safety: never leave a firing laser unattended and always wear rated eye protection. Beam is OFF (S0/M5) on every travel and at program end; it fires only on scan moves. Requires GRBL laser mode $32=1, and S-max should not exceed your $30 ceiling.',
          )}
        </span>
      </p>
    </div>
  )
}

function LaserVectorWorkbench() {
  const t = useT()
  const nestWarnText = useNestWarnText()
  const setProgram = useProgram((s) => s.setProgram)
  const streaming = useProgram((s) => s.streaming)

  // ---- Mode (persisted) — gates the mode-specific controls below. ---------
  const [mode, setMode] = usePersistentState<LaserMode>('karmyogi.laser.mode', LaserMode.CO2)

  // ---- Common + mode params (persisted, one record per mode). -------------
  const [co2, setCo2] = usePersistentState<PanelParams>(
    'karmyogi.laser.params.co2',
    defaultsFor(LaserMode.CO2),
  )
  const [fiber, setFiber] = usePersistentState<PanelParams>(
    'karmyogi.laser.params.fiber',
    defaultsFor(LaserMode.Fiber),
  )
  const params = mode === LaserMode.Fiber ? fiber : co2
  const setParams = (patch: Partial<PanelParams>) => {
    if (mode === LaserMode.Fiber) setFiber((p) => ({ ...p, ...patch }))
    else setCo2((p) => ({ ...p, ...patch }))
  }

  // Collapse the two mode-specific (advanced) cards to tame vertical scroll.
  const [showAdvanced, setShowAdvanced] = usePersistentState<boolean>('karmyogi.laser.showAdvanced', false)

  // ---- Sheet / nesting (persisted). ---------------------------------------
  const [sheetW, setSheetW] = usePersistentState<number>('karmyogi.laser.sheetW', 300)
  const [sheetH, setSheetH] = usePersistentState<number>('karmyogi.laser.sheetH', 200)
  const [margin, setMargin] = usePersistentState<number>('karmyogi.laser.margin', 5)
  const [quantity, setQuantity] = usePersistentState<number>('karmyogi.laser.qty', 1)
  const [doNest, setDoNest] = usePersistentState<boolean>('karmyogi.laser.nestOn', false)
  const [loadError, setLoadError] = useState<string>('')

  // ---- DXF (NOT persisted — re-import each session). ----------------------
  const [contours, setContours] = useState<LaserContour[]>([])
  const [fileName, setFileName] = useState<string>('')
  const [importError, setImportError] = useState<string>('')
  const [warnings, setWarnings] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const traceInputRef = useRef<HTMLInputElement>(null)
  // L12 — image trace settings (threshold + simplify tolerance + target size).
  const [traceThreshold, setTraceThreshold] = usePersistentState<number>('karmyogi.laser.trace.thr', 128)
  const [traceInvert, setTraceInvert] = usePersistentState<boolean>('karmyogi.laser.trace.inv', false)
  const [traceSize, setTraceSize] = usePersistentState<number>('karmyogi.laser.trace.size', 80)

  // L2 — layer system. Disabled layers are dropped from the job; the cut order
  // follows `layerOrder` (drag-free: move-up/down). Re-derived on each import.
  const [disabledLayers, setDisabledLayers] = useState<Set<string>>(new Set())
  const [layerOrder, setLayerOrder] = useState<string[]>([])

  const bounds = useMemo(() => contoursBounds(contours), [contours])
  const counts = useMemo(() => countContours(contours), [contours])
  const layers = useMemo(() => contourLayers(contours), [contours])
  // Per-layer contour counts for the layer list.
  const layerCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of contours) m.set(c.layer ?? '', (m.get(c.layer ?? '') ?? 0) + 1)
    return m
  }, [contours])
  // Effective ordered+enabled layer list (multi-layer only when >1 layer).
  const orderedLayers = useMemo(() => {
    const known = new Set(layers)
    const fromOrder = layerOrder.filter((l) => known.has(l))
    const rest = layers.filter((l) => !fromOrder.includes(l))
    return [...fromOrder, ...rest]
  }, [layers, layerOrder])

  function loadDxfFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const res = importDxfString(String(reader.result ?? ''))
      setWarnings(res.warnings ?? [])
      if (!res.ok) {
        setContours([])
        setImportError(res.error ?? t('laser.dxf.parseFail', 'Failed to parse DXF'))
        return
      }
      setImportError('')
      const cs = drawingToContours(res.drawing)
      setContours(cs)
      setDisabledLayers(new Set())
      setLayerOrder(contourLayers(cs))
      setFileName(file.name)
    }
    reader.onerror = () => {
      setContours([])
      setWarnings([])
      setImportError(t('laser.dxf.readFail', 'Could not read {name}.', { name: file.name }))
    }
    reader.readAsText(file)
  }

  // L12 — image trace: decode a raster → binary mask → boundary contours →
  // simplify → fit to the target mm size → laser cut contours. The traced
  // outlines become CLOSED cut loops on a single (unnamed) layer.
  function traceImageFile(file: File) {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const cap = 1000 // working-resolution cap (longest edge)
      const scale = Math.min(1, cap / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const cv = document.createElement('canvas')
      cv.width = w
      cv.height = h
      const ctx = cv.getContext('2d')
      if (!ctx) {
        setImportError(t('laser.trace.err.decode', 'Could not decode the image.'))
        URL.revokeObjectURL(url)
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      const raw = traceBitmap(new Uint8ClampedArray(data), w, h, {
        threshold: traceThreshold,
        invert: traceInvert,
        minContourLength: 8,
      })
      if (raw.length === 0) {
        setContours([])
        setImportError(t('laser.trace.err.empty', 'No outlines found — adjust the threshold or invert.'))
        URL.revokeObjectURL(url)
        return
      }
      // Simplify each contour then uniformly fit to the target box (flip Y up).
      const tol = Math.max(0.5, (w / Math.max(1, traceSize)) * 0.4) // ~0.4mm in px
      const simplified = raw.map((p) => simplifyPolyline(p, tol))
      const fitted = fitPolylinesToSize(simplified, traceSize, traceSize, true)
      const cs: LaserContour[] = fitted
        .filter((p) => p.points.length >= 2)
        .map((p) => ({ poly: p, closed: true, layer: '' }))
      setImportError('')
      setWarnings([
        t('laser.trace.warn', 'Traced {n} outlines ({pts} points) — outlines, not centerlines.', {
          n: cs.length,
          pts: countPoints(fitted),
        }),
      ])
      setContours(cs)
      setDisabledLayers(new Set())
      setLayerOrder([''])
      setFileName(file.name)
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      setImportError(t('laser.trace.err.load', 'Could not load {name}. Use a PNG or JPG.', { name: file.name }))
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  // ---- Nesting: lay out `quantity` copies of the part on the sheet. -------
  // Each copy is one NestItem with the part footprint; the packer returns a
  // bottom-left placement we translate the part into. When nesting is off, all
  // copies are stacked at the origin (single copy use-case).
  //
  // The placed contours, the fit summary AND the warnings are derived from ONE
  // `nestFootprints` call (it runs an O(n²) hill-climb, so it must not run twice
  // per render — that froze the UI on large Quantity).
  const nest = useMemo(() => {
    // L2: drop contours on disabled layers BEFORE placing.
    const active = contours.filter((c) => !disabledLayers.has(c.layer ?? ''))
    if (active.length === 0) {
      return { placed: [] as PlacedContour[], fit: null as null | { fit: number; total: number; overflow: boolean }, warnings: [] as NestWarning[] }
    }
    const qty = clamp(Math.floor(quantity), 1, MAX_QUANTITY)
    const w = bounds.width()
    const h = bounds.height()

    const out: PlacedContour[] = []
    let fit: { fit: number; total: number; overflow: boolean } | null = null
    let warnings: NestWarning[] = []

    if (doNest && qty > 0 && w > 0 && h > 0) {
      const items: NestItem[] = []
      for (let i = 0; i < qty; ++i) items.push({ id: `c${i}`, w, h })
      const res = nestFootprints(items, { bedW: sheetW, bedH: sheetH, margin })
      for (const pl of res.placements) {
        out.push(...placeContours(active, bounds, pl.x, pl.y))
      }
      fit = { fit: res.placements.filter((p) => !p.overflow).length, total: qty, overflow: res.overflow }
      warnings = res.warningCodes
    } else {
      // No nesting → stack all copies at the sheet origin (+margin).
      for (let i = 0; i < qty; ++i) {
        out.push(...placeContours(active, bounds, margin, margin))
      }
    }
    // L2: sort by layer cut order (stable within a layer), then inner-first.
    const rank = new Map(orderedLayers.map((l, i) => [l, i]))
    const byLayer = out
      .map((c, i) => ({ c, i, r: rank.get(c.layer ?? '') ?? 0 }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c)
    // orderContours (inner-first) is applied per-layer block by re-grouping.
    const grouped: PlacedContour[] = []
    let cursor = 0
    while (cursor < byLayer.length) {
      const layerName = byLayer[cursor].layer ?? ''
      let end = cursor
      while (end < byLayer.length && (byLayer[end].layer ?? '') === layerName) end++
      grouped.push(...orderContours(byLayer.slice(cursor, end)))
      cursor = end
    }
    return { placed: grouped, fit, warnings }
  }, [contours, disabledLayers, orderedLayers, bounds, quantity, doNest, sheetW, sheetH, margin])

  // ---- L11 fill + L9 tabs + L8 travel optimization. -----------------------
  // Applied AFTER nesting/ordering so geometry is final. Fill adds interior cut
  // paths to closed loops; tabs break closed loops into open segments (leaving
  // un-cut bridges); travel optimization reorders to minimize beam-off jumps.
  const placed = useMemo(() => {
    let out: PlacedContour[] = []
    for (const c of nest.placed) {
      // Fill closed loops first (drawn before the perimeter so the outline cut
      // last keeps the part attached longest).
      if (c.closed && params.fill !== FillStyle.None && params.fillSpacing > 0) {
        const fillPaths =
          params.fill === FillStyle.Offset
            ? offsetFill(c, params.fillSpacing)
            : lineFill(c, params.fillSpacing, params.fillAngle)
        out.push(...fillPaths)
      }
      // Tabs break a closed loop into open cut segments with un-cut gaps.
      if (c.closed && params.tabsOn && params.tabCount > 0 && params.tabWidth > 0) {
        out.push(...tabContour(c, params.tabCount, params.tabWidth))
      } else {
        out.push(c)
      }
    }
    if (params.optimizeTravel) out = optimizeTravel(out)
    return out
  }, [nest.placed, params.fill, params.fillSpacing, params.fillAngle, params.tabsOn, params.tabCount, params.tabWidth, params.optimizeTravel])
  const nestFit = nest.fit

  // ---- Live G-code (recomputed on any param/DXF change). ------------------
  // Power / pierce power are CLAMPED to [0, sMax] here so an out-of-range S value
  // can never reach the emitter (the GRBL controller caps at $30 = sMax anyway).
  const gcode = useMemo(() => {
    if (placed.length === 0) return ''
    const sMax = Math.max(1, params.sMax)
    return emitLaserProgram(placed, {
      mode: params.mode,
      cutFeed: params.cutFeed,
      power: clamp(params.power, 0, sMax),
      sMax,
      passes: params.passes,
      powerMode: params.powerMode,
      useFocusZ: params.useFocusZ,
      focusZ: params.focusZ,
      pierce: params.pierce,
      piercePower: clamp(params.piercePower, 0, sMax),
      pierceTime: params.pierceTime,
      airAssist: params.airAssist,
      rotary: params.rotary,
      rotaryAxis: params.rotaryAxis,
      rotaryDiameter: params.rotaryDiameter,
      fiberFrequencyKHz: params.mode === LaserMode.Fiber ? params.fiberFrequencyKHz : undefined,
      fiberPulseNs: params.mode === LaserMode.Fiber ? params.fiberPulseNs : undefined,
      decimals: params.decimals,
      programName: `hjLabs Laser — ${params.mode}`,
    })
  }, [placed, params])
  const lineCount = useMemo(() => gcodeLineCount(gcode), [gcode])

  // ---- Cut-path length + time estimate (XY only, all passes). -------------
  const estimate = useMemo(() => {
    if (placed.length === 0 || params.cutFeed <= 0) return null
    const passes = Math.max(1, Math.floor(params.passes))
    let len = 0
    for (const c of placed) {
      const pts = c.points
      for (let i = 1; i < pts.length; ++i) len += distance(pts[i - 1], pts[i])
      if (c.closed && pts.length > 1) len += distance(pts[pts.length - 1], pts[0])
    }
    len *= passes
    // time(min) = length(mm) / feed(mm/min); add pierce dwell per contour/pass.
    let timeMin = len / params.cutFeed
    if (params.pierce && params.pierceTime > 0) {
      timeMin += (placed.length * passes * params.pierceTime) / 60
    }
    return { lengthMm: len, timeSeconds: timeMin * 60 }
  }, [placed, params])

  // Live sync: push the freshly-computed program to the store (debounced) so the
  // Visualizer + Program tab pick it up without a manual Generate step.
  // GUARD: never push WHILE a job is streaming — a fresh setProgram would reset
  // the program/cursor mid-cut. We skip the sync entirely while streaming.
  useEffect(() => {
    if (!gcode || streaming) return
    const id = window.setTimeout(() => setProgram('laser', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, setProgram, streaming])

  const powerPct = percentFromPower(params.power, params.sMax)
  const fiberMode = mode === LaserMode.Fiber

  // ---- Save / Load document (params + sheet/nesting only; DXF re-imported). --
  const doc: LaserDoc = {
    kind: 'karmyogi.laser',
    version: 1,
    mode,
    co2,
    fiber,
    sheet: { sheetW, sheetH, margin, quantity, doNest },
  }

  // Restore a (possibly untrusted) settings snapshot — shared by Load and by the
  // colour presets so corrupt persisted values can never reach the emitter.
  // `data.mode/co2/fiber/sheet` are each coerced per-field via the parse helpers.
  function applySettings(data: Record<string, unknown>) {
    if (VALID_MODES.includes(data.mode as LaserMode)) setMode(data.mode as LaserMode)
    setCo2((p) => parseParams(data.co2, p))
    setFiber((p) => parseParams(data.fiber, p))
    setSheetW((v) => parseSheet(data.sheet, { sheetW: v, sheetH, margin, quantity, doNest }).sheetW)
    setSheetH((v) => parseSheet(data.sheet, { sheetW, sheetH: v, margin, quantity, doNest }).sheetH)
    setMargin((v) => parseSheet(data.sheet, { sheetW, sheetH, margin: v, quantity, doNest }).margin)
    setQuantity((v) => parseSheet(data.sheet, { sheetW, sheetH, margin, quantity: v, doNest }).quantity)
    setDoNest((v) => parseSheet(data.sheet, { sheetW, sheetH, margin, quantity, doNest: v }).doNest)
  }

  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('laser.load.bad', 'Could not load — not a valid laser settings file.'))
      return
    }
    applySettings(data)
    setLoadError('')
  }

  // ---- color-coded setting PRESETS (mode + both param records + sheet) -------
  // Snapshot the current settings (NOT the imported DXF contours).
  const captureSettings = (): LaserPreset => ({ mode, co2, fiber, sheet: { sheetW, sheetH, margin, quantity, doNest } })
  // Restore a captured preset, coercing each field defensively (parseParams /
  // parseSheet) so a corrupt slot can never feed a NaN to the emitter.
  const applyPreset = (p: LaserPreset) => {
    if (isRecord(p)) applySettings(p as unknown as Record<string, unknown>)
  }
  const presets = usePresets<LaserPreset>({
    storageKey: 'karmyogi.laser.presets',
    capture: captureSettings,
    onApply: applyPreset,
  })

  // Settings-only payload for the preset-bar Save/Load pair (mirrors the header
  // Save/Load doc minus the kind/version envelope) — loaded the same path.
  const settings: LaserPreset = captureSettings()

  // ── Gamepad command bus: frame the vector cut's perimeter (laser OFF). ──
  useTabCommands('laser', {
    frame: () => {
      const lines = gcode ? gcode.split(/\r?\n/) : []
      if (!grbl.isConnected || lines.length === 0) return
      const bounds = frameBoundsOfGcode(lines)
      if (!bounds || !bounds.isValid()) return
      for (const ln of buildFrameProgram(bounds, { safeZ: 5 })) void grbl.send(ln)
    },
  })

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('laser.presets.aria', 'Laser setting presets')}
      />
    <div className="lp-panel">
      {/* Header: title + mode radio + live status. */}
      <header className="lp-head">
        <div className="lp-head-title">
          <span className="lp-head-name">{t('laser.title', 'Laser Cutting')}</span>
        </div>
        <div className="lp-mode-wrap">
          <SegControl
            ariaLabel={t('laser.mode.aria', 'Laser mode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: LaserMode.CO2, label: t('laser.mode.co2', 'CO2'), icon: 'laser' },
              { value: LaserMode.Fiber, label: t('laser.mode.fiber', 'Fiber'), icon: 'laser' },
            ]}
          />
        </div>
        <FrameButton
          lines={gcode ? gcode.split(/\r?\n/) : []}
          showOptions={false}
          label={t('laser.frame', 'Frame')}
          className="lp-frame"
        />
        <SaveLoadButtons
          value={doc}
          onLoad={loadDoc}
          onError={setLoadError}
          fileBase="karmyogi-laser"
          ext="klaser"
          saveTitle={t('laser.save', 'Save laser settings')}
          loadTitle={t('laser.load', 'Load laser settings')}
          className="lp-io"
        />
      </header>

      {loadError && <p className="lp-warn">{loadError}</p>}

      {/* Live status strip: contour + part + line counts, auto-synced. */}
      <div className="lp-status">
        <span className="lp-status-pill">
          <b>{counts.closed}</b> {t('laser.status.loops', 'loops')}
        </span>
        <span className="lp-status-sep" aria-hidden="true">·</span>
        <span className="lp-status-pill">
          <b>{counts.open}</b> {t('laser.status.lines', 'lines')}
        </span>
        <span className="lp-status-sep" aria-hidden="true">·</span>
        <span className="lp-status-pill">
          <b>{placed.length}</b> {t('laser.status.contours', 'contours out')}
        </span>
        <span className="lp-status-sep" aria-hidden="true">·</span>
        <span className="lp-status-pill">
          <b>{lineCount}</b> {t('laser.status.gcode', 'G-code lines')}
        </span>
        {estimate && (
          <>
            <span className="lp-status-sep" aria-hidden="true">·</span>
            <span
              className="lp-status-pill"
              title={t('laser.status.estTitle', 'Estimated cut path length and time (XY, all passes — pierce dwell included).')}
            >
              <b>{(estimate.lengthMm / 1000).toFixed(2)} m</b> · <b>{fmtDuration(estimate.timeSeconds)}</b>
            </span>
          </>
        )}
        <span
          className="lp-status-sync"
          title={
            streaming
              ? t('laser.status.streamingTitle', 'Streaming — live sync paused so the running job is not reset.')
              : t('laser.status.syncTitle', 'Lines auto-synced to the Program tab')
          }
        >
          {streaming ? (
            <>
              <Icon name="play" size={12} /> {t('laser.status.streaming', 'Streaming')}
            </>
          ) : (
            <>
              <Icon name="chevron-right" size={12} /> {t('laser.status.program', 'Program')}
            </>
          )}
        </span>
      </div>

      {/* DXF import. */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="frame" size={14} />
            </span>
            {t('laser.dxf.title', 'Drawing (DXF)')}
          </h4>
          {fileName && <span className="lp-card-count">{fileName}</span>}
        </div>
        <div className="lp-import-row">
          <button
            type="button"
            className="cam-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" size={15} /> {t('laser.dxf.import', 'Import DXF…')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dxf,application/dxf,image/vnd.dxf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadDxfFile(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className="cam-secondary"
            onClick={() => traceInputRef.current?.click()}
            title={t('laser.trace.btn.title', 'Trace a PNG/JPG bitmap into cut outlines (boundary tracing). Tune threshold below.')}
          >
            <Icon name="camera" size={15} /> {t('laser.trace.btn', 'Trace image…')}
          </button>
          <input
            ref={traceInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) traceImageFile(f)
              e.target.value = ''
            }}
          />
          {contours.length > 0 && (
            <span className="lp-import-info">
              {t('laser.dxf.info', '{n} contours · {w}×{h} mm', {
                n: contours.length,
                w: bounds.width().toFixed(1),
                h: bounds.height().toFixed(1),
              })}
            </span>
          )}
        </div>
        {importError && <p className="lp-warn">{importError}</p>}
        {warnings.length > 0 && (
          <ul className="lp-warn-list">
            {warnings.slice(0, 4).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <details className="lp-trace-opts">
          <summary title={t('laser.trace.opts.title', 'Settings used when tracing a bitmap into cut outlines.')}>
            {t('laser.trace.opts', 'Image trace settings')}
          </summary>
          <div className="lp-sliders" style={{ marginTop: 'var(--sp-2)' }}>
            <SliderField
              icon={<Icon name="settings" size={14} />}
              label={t('laser.trace.threshold', 'Threshold')}
              min={0}
              max={255}
              step={1}
              integer
              value={traceThreshold}
              onChange={(n) => setTraceThreshold(clamp(Math.floor(n), 0, 255))}
              title={t('laser.trace.threshold.title', 'Luminance cutoff: pixels darker than this become ink and get outlined (0..255).')}
            />
            <SliderField
              icon={<Icon name="frame" size={14} />}
              label={t('laser.trace.size', 'Fit size')}
              unit="mm"
              min={5}
              max={500}
              step={1}
              value={traceSize}
              onChange={(n) => setTraceSize(clamp(n, 5, 500))}
              title={t('laser.trace.size.title', 'Longest dimension the traced result is scaled to (aspect preserved).')}
            />
          </div>
          <label className="lp-toggle" title={t('laser.trace.invert.title', 'Trace light regions on a dark background instead.')}>
            <input type="checkbox" checked={traceInvert} onChange={(e) => setTraceInvert(e.target.checked)} />
            {t('laser.trace.invert', 'Invert (light = ink)')}
          </label>
        </details>
        {contours.length === 0 && !importError && (
          <CamEmpty
            icon={<Icon name="laser" size={20} />}
            title={t('laser.dxf.empty.title', 'No drawing loaded')}
            hint={t('laser.dxf.empty.hint', 'Import a DXF — closed contours become cut loops, open paths become cut lines.')}
          />
        )}
      </section>

      {/* Nesting / sheet. */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="duplicate" size={14} />
            </span>
            {t('laser.sheet.title', 'Sheet & nesting')}
          </h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={doNest}
              onChange={(e) => setDoNest(e.target.checked)}
            />
            {t('laser.sheet.nest', 'Nest')}
          </label>
        </div>
        <div className="lp-sliders">
          <SliderField
            icon={<Icon name="frame" size={14} />}
            label={t('laser.sheet.w', 'Sheet W')}
            unit="mm"
            min={1}
            max={2000}
            step={1}
            value={sheetW}
            onChange={(n) => setSheetW(n)}
            title={t('laser.sheet.w.title', 'Usable sheet width (X).')}
          />
          <SliderField
            icon={<Icon name="frame" size={14} />}
            label={t('laser.sheet.h', 'Sheet H')}
            unit="mm"
            min={1}
            max={2000}
            step={1}
            value={sheetH}
            onChange={(n) => setSheetH(n)}
            title={t('laser.sheet.h.title', 'Usable sheet height (Y).')}
          />
          <SliderField
            icon={<Icon name="jog" size={14} />}
            label={t('laser.sheet.spacing', 'Spacing')}
            unit="mm"
            min={0}
            max={50}
            step={0.5}
            value={margin}
            onChange={(n) => setMargin(n)}
            title={t('laser.sheet.spacing.title', 'Gap kept between parts and around the sheet edge.')}
          />
          <SliderField
            icon={<Icon name="duplicate" size={14} />}
            label={t('laser.sheet.qty', 'Quantity')}
            min={1}
            max={MAX_QUANTITY}
            step={1}
            integer
            value={quantity}
            onChange={(n) => setQuantity(clamp(Math.floor(n), 1, MAX_QUANTITY))}
            title={t('laser.sheet.qty.title', 'Number of copies of the imported part to lay out (max {max}).', { max: MAX_QUANTITY })}
          />
        </div>
        {nestFit && (
          <p className={`lp-hint${nestFit.overflow ? ' is-warn' : ''}`}>
            {t('laser.nest.fit', '{fit} of {total} copies fit on the {w}×{h} mm sheet', {
              fit: nestFit.fit,
              total: nestFit.total,
              w: sheetW,
              h: sheetH,
            })}
            {nestFit.overflow
              ? t('laser.nest.overflow', ' — some overflow the edge.')
              : t('laser.nest.period', '.')}
          </p>
        )}
        {/* Without nesting, >1 copies stack at the SAME spot → overlapping burns. */}
        {!doNest && quantity > 1 && contours.length > 0 && (
          <p className="lp-hint is-warn">
            <Icon name="warning" size={13} />{' '}
            {t(
              'laser.nest.stackWarn',
              'Nesting is off — all {n} copies overlap at the same spot. Enable Nest to lay them out separately.',
              { n: quantity },
            )}
          </p>
        )}
        {nest.warnings.length > 0 && (
          <ul className="lp-warn-list">
            {nest.warnings.map((w, i) => (
              <li key={i}>{nestWarnText(w)}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Common cut parameters. */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="laser" size={14} />
            </span>
            {t('laser.cut.title', 'Cut parameters')}
          </h4>
        </div>
        <div className="lp-sliders">
          <SliderField
            icon={<Icon name="jog" size={14} />}
            label={t('laser.cut.speed', 'Cut speed')}
            unit="mm/min"
            min={1}
            max={10000}
            step={10}
            value={params.cutFeed}
            onChange={(n) => setParams({ cutFeed: n })}
            title={t('laser.cut.speed.title', 'Feed rate while cutting (G1 F…).')}
          />
          <SliderField
            icon={<Icon name="laser" size={14} />}
            label={t('laser.cut.power', 'Power')}
            unit="S"
            min={0}
            max={Math.max(1, params.sMax)}
            step={10}
            value={params.power}
            onChange={(n) => setParams({ power: clamp(n, 0, Math.max(1, params.sMax)) })}
            title={t('laser.cut.power.title', 'Laser power as an S value (0..{sMax} = 0..100%). Currently {pct}%.', {
              sMax: params.sMax,
              pct: powerPct,
            })}
          />
          <SliderField
            icon={<Icon name="laser" size={14} />}
            label={t('laser.cut.powerPct', 'Power %')}
            unit="%"
            min={0}
            max={100}
            step={1}
            value={powerPct}
            onChange={(n) => setParams({ power: powerFromPercent(n, params.sMax) })}
            title={t('laser.cut.powerPct.title', 'Laser power as a percentage of S-max.')}
          />
          <SliderField
            icon={<Icon name="settings" size={14} />}
            label={t('laser.cut.sMax', 'S-max')}
            min={1}
            max={2000}
            step={10}
            value={params.sMax}
            onChange={(n) => setParams({ sMax: n })}
            title={t('laser.cut.sMax.title', 'Max S value the controller maps to 100% (GRBL $30).')}
          />
          <SliderField
            icon={<Icon name="copy" size={14} />}
            label={t('laser.cut.passes', 'Passes')}
            min={1}
            max={50}
            step={1}
            integer
            value={params.passes}
            onChange={(n) => setParams({ passes: n })}
            title={t('laser.cut.passes.title', 'How many times each contour is cut.')}
          />
          <SliderField
            icon={<Icon name="settings" size={14} />}
            label={t('laser.cut.decimals', 'Decimals')}
            min={0}
            max={6}
            step={1}
            integer
            value={params.decimals}
            onChange={(n) => setParams({ decimals: n })}
            title={t('laser.cut.decimals.title', 'Coordinate precision in the emitted G-code.')}
          />
        </div>
        <div className="lp-segrow">
          <span className="lp-segrow-label" title={t('laser.powerMode.title', 'M4 dynamic scales power with feed (best for cutting); M3 is constant power.')}>
            {t('laser.powerMode', 'Power mode')}
          </span>
          <SegControl
            ariaLabel={t('laser.powerMode', 'Power mode')}
            value={params.powerMode}
            onChange={(v) => setParams({ powerMode: v })}
            options={[
              { value: LaserPowerMode.Dynamic, label: t('laser.powerMode.dynamic', 'M4 dynamic'), icon: 'play' },
              { value: LaserPowerMode.Constant, label: t('laser.powerMode.constant', 'M3 constant'), icon: 'spindle' },
            ]}
          />
        </div>
        <div className="lp-toggle-row">
          <label className="lp-toggle" title={t('laser.cut.air.title', 'Switch the air-assist solenoid on for the whole job (M8 at start, M9 at end). Auxiliary output — never gates the beam.')}>
            <input
              type="checkbox"
              checked={params.airAssist}
              onChange={(e) => setParams({ airAssist: e.target.checked })}
            />
            {t('laser.cut.air', 'Air assist (M8/M9)')}
          </label>
          <label className="lp-toggle" title={t('laser.cut.optimize.title', 'Reorder cuts with a nearest-neighbour walk to minimize beam-off travel between shapes, rotate loop seams next to the previous cut, and reverse open lines. Inner-first ordering is relaxed when on.')}>
            <input
              type="checkbox"
              checked={params.optimizeTravel}
              onChange={(e) => setParams({ optimizeTravel: e.target.checked })}
            />
            {t('laser.cut.optimize', 'Optimize travel')}
          </label>
        </div>
      </section>

      {/* L15 — low-power frame + focus dot (pre-run placement / manual focus). */}
      <LaserFrameCard
        placed={placed}
        sMax={Math.max(1, params.sMax)}
        cutFeed={params.cutFeed}
        decimals={params.decimals}
      />

      {/* L2 — Layers (only when the DXF actually has >1 layer). */}
      {layers.length > 1 && (
        <section className="lp-card ui-card">
          <div className="lp-card-head">
            <h4 className="ui-sec-head">
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name="copy" size={14} />
              </span>
              {t('laser.layers.title', 'Layers')}
            </h4>
            <span className="lp-card-count">{t('laser.layers.count', '{n} layers', { n: layers.length })}</span>
          </div>
          <p className="lp-hint">
            {t('laser.layers.hint', 'Grouped by DXF layer. Toggle a layer off to skip it; reorder to set the cut order (top cut first).')}
          </p>
          <ul className="lp-layer-list">
            {orderedLayers.map((ln, i) => {
              const on = !disabledLayers.has(ln)
              const label = ln === '' ? t('laser.layers.unnamed', '(no layer)') : ln
              return (
                <li key={ln || '__none__'} className={`lp-layer${on ? '' : ' is-off'}`}>
                  <label className="lp-layer-toggle" title={t('laser.layers.toggle.title', 'Include this layer in the job.')}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        setDisabledLayers((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.delete(ln)
                          else next.add(ln)
                          return next
                        })
                      }}
                    />
                    <span className="lp-layer-name">{label}</span>
                  </label>
                  <span className="lp-layer-count">{layerCounts.get(ln) ?? 0}</span>
                  <span className="lp-layer-ord">
                    <button
                      type="button"
                      className="lp-layer-btn"
                      disabled={i === 0}
                      title={t('laser.layers.up', 'Cut earlier')}
                      onClick={() =>
                        setLayerOrder(() => {
                          const arr = orderedLayers.slice()
                          ;[arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]
                          return arr
                        })
                      }
                    >
                      <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
                        <Icon name="chevron-down" size={12} />
                      </span>
                    </button>
                    <button
                      type="button"
                      className="lp-layer-btn"
                      disabled={i === orderedLayers.length - 1}
                      title={t('laser.layers.down', 'Cut later')}
                      onClick={() =>
                        setLayerOrder(() => {
                          const arr = orderedLayers.slice()
                          ;[arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]
                          return arr
                        })
                      }
                    >
                      <Icon name="chevron-down" size={12} />
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* L11 — Fill (closed loops only). */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="duplicate" size={14} />
            </span>
            {t('laser.fill.title', 'Fill')}
          </h4>
        </div>
        <div className="lp-segrow">
          <span className="lp-segrow-label" title={t('laser.fill.mode.title', 'Fill closed loops: line/hatch sweeps parallel lines; offset spirals concentric rings inward (reuses the offset engine). None = outline only.')}>
            {t('laser.fill.mode', 'Style')}
          </span>
          <SegControl
            ariaLabel={t('laser.fill.mode', 'Fill style')}
            value={params.fill}
            onChange={(v) => setParams({ fill: v })}
            options={[
              { value: FillStyle.None, label: t('laser.fill.none', 'None'), icon: 'frame' },
              { value: FillStyle.Line, label: t('laser.fill.line', 'Line'), icon: 'jog' },
              { value: FillStyle.Offset, label: t('laser.fill.offset', 'Offset'), icon: 'duplicate' },
            ]}
          />
        </div>
        {params.fill !== FillStyle.None && (
          <div className="lp-sliders">
            <SliderField
              icon={<Icon name="jog" size={14} />}
              label={t('laser.fill.spacing', 'Spacing')}
              unit="mm"
              min={0.05}
              max={5}
              step={0.05}
              value={params.fillSpacing}
              onChange={(n) => setParams({ fillSpacing: clamp(n, 0.05, 5) })}
              title={t('laser.fill.spacing.title', 'Gap between fill lines / rings. Smaller = denser (darker) but slower.')}
            />
            {params.fill === FillStyle.Line && (
              <SliderField
                icon={<Icon name="settings" size={14} />}
                label={t('laser.fill.angle', 'Angle')}
                unit="°"
                min={0}
                max={180}
                step={5}
                integer
                value={params.fillAngle}
                onChange={(n) => setParams({ fillAngle: clamp(n, 0, 180) })}
                title={t('laser.fill.angle.title', 'Direction of the parallel fill lines (0 = horizontal).')}
              />
            )}
          </div>
        )}
      </section>

      {/* L9 — Tabs / bridges (closed loops only). */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="frame" size={14} />
            </span>
            {t('laser.tabs.title', 'Tabs / bridges')}
          </h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={params.tabsOn}
              onChange={(e) => setParams({ tabsOn: e.target.checked })}
            />
            {t('laser.tabs.toggle', 'Tabs')}
          </label>
        </div>
        {params.tabsOn ? (
          <div className="lp-sliders">
            <SliderField
              icon={<Icon name="duplicate" size={14} />}
              label={t('laser.tabs.count', 'Tabs / loop')}
              min={1}
              max={12}
              step={1}
              integer
              value={params.tabCount}
              onChange={(n) => setParams({ tabCount: clamp(Math.floor(n), 1, 12) })}
              title={t('laser.tabs.count.title', 'Number of un-cut bridges left around each closed loop so the part stays attached to the sheet.')}
            />
            <SliderField
              icon={<Icon name="jog" size={14} />}
              label={t('laser.tabs.width', 'Tab width')}
              unit="mm"
              min={0.1}
              max={5}
              step={0.1}
              value={params.tabWidth}
              onChange={(n) => setParams({ tabWidth: clamp(n, 0.1, 5) })}
              title={t('laser.tabs.width.title', 'Length of each un-cut gap. Wider = stronger hold, more to snap off afterwards.')}
            />
          </div>
        ) : (
          <p className="lp-hint">
            {t('laser.tabs.hint', 'Leave small un-cut bridges on closed loops so cut-out parts do not drop / shift during the job.')}
          </p>
        )}
      </section>

      {/* L14 — Rotary mode. */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="settings" size={14} />
            </span>
            {t('laser.rotary.title', 'Rotary')}
          </h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={params.rotary}
              onChange={(e) => setParams({ rotary: e.target.checked })}
            />
            {t('laser.rotary.toggle', 'Rotary')}
          </label>
        </div>
        {params.rotary ? (
          <>
            <div className="lp-segrow">
              <span className="lp-segrow-label" title={t('laser.rotary.axis.title', 'Which rotary axis the Y travel is mapped onto. The job wraps around the cylinder on this axis.')}>
                {t('laser.rotary.axis', 'Axis')}
              </span>
              <KitSeg<'A' | 'B' | 'C' | 'Y'>
                ariaLabel={t('laser.rotary.axis', 'Rotary axis')}
                value={params.rotaryAxis}
                onChange={(v) => setParams({ rotaryAxis: v })}
                options={[
                  { value: 'A', label: 'A' },
                  { value: 'B', label: 'B' },
                  { value: 'C', label: 'C' },
                  { value: 'Y', label: 'Y' },
                ]}
              />
            </div>
            <div className="lp-sliders">
              <SliderField
                icon={<Icon name="frame" size={14} />}
                label={t('laser.rotary.diameter', 'Diameter')}
                unit="mm"
                min={1}
                max={500}
                step={0.5}
                value={params.rotaryDiameter}
                onChange={(n) => setParams({ rotaryDiameter: clamp(n, 1, 500) })}
                title={t('laser.rotary.diameter.title', 'Workpiece diameter. Y travel converts to degrees via π·⌀ / 360 mm per degree ({mm} mm/°).', { mm: ((Math.PI * params.rotaryDiameter) / 360).toFixed(4) })}
              />
            </div>
            <p className="lp-note">
              {t('laser.rotary.note', 'Y moves become {axis}-axis rotation; X stays linear. Feed is rescaled to deg/min. Set up your rotary chuck and home {axis} before running.', { axis: params.rotaryAxis })}
            </p>
          </>
        ) : (
          <p className="lp-hint">
            {t('laser.rotary.hint', 'Engrave/cut on a cylinder: map Y travel to a rotary axis using the workpiece diameter.')}
          </p>
        )}
      </section>

      {/* Advanced (mode-specific) — collapsed by default to reduce scroll. */}
      <button
        type="button"
        className="lp-advanced-toggle"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
      >
        <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} />{' '}
        {t('laser.advanced', 'Advanced — piercing & focus')}
      </button>

      {showAdvanced && (
      <>
      {/* Mode-specific: piercing. Both modes can pierce; defaults differ. */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">{fiberMode ? t('laser.pierce.title.fiber', 'Piercing (Fiber)') : t('laser.pierce.title.co2', 'Piercing (CO2 — usually off)')}</h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={params.pierce}
              onChange={(e) => setParams({ pierce: e.target.checked })}
            />
            {t('laser.pierce.toggle', 'Pierce')}
          </label>
        </div>
        {params.pierce ? (
          <div className="lp-sliders">
            <SliderField
              icon={<Icon name="laser" size={14} />}
              label={t('laser.pierce.power', 'Pierce power')}
              unit="S"
              min={0}
              max={Math.max(1, params.sMax)}
              step={10}
              value={params.piercePower}
              onChange={(n) => setParams({ piercePower: clamp(n, 0, Math.max(1, params.sMax)) })}
              title={t('laser.pierce.power.title', 'Beam power during the pre-cut pierce dwell (0..{sMax}).', { sMax: params.sMax })}
            />
            <SliderField
              icon={<Icon name="pause" size={14} />}
              label={t('laser.pierce.time', 'Pierce time')}
              unit="s"
              min={0}
              max={5}
              step={0.05}
              value={params.pierceTime}
              onChange={(n) => setParams({ pierceTime: n })}
              title={t('laser.pierce.time.title', 'Dwell at the contour start before cutting begins (G4 P…).')}
            />
          </div>
        ) : (
          <p className="lp-hint">
            {fiberMode
              ? t('laser.pierce.hint.fiber', 'Fiber cuts normally pierce before each contour. Enable to dwell at the start point.')
              : t('laser.pierce.hint.co2', 'CO2 normally starts the cut immediately (no pierce). Enable only for thick material.')}
          </p>
        )}
      </section>

      {/* Mode-specific: focus-Z. */}
      <section className="lp-card ui-card">
        <div className="lp-card-head">
          <h4 className="ui-sec-head">{fiberMode ? t('laser.focus.title.fiber', 'Autofocus / focus offset (Fiber)') : t('laser.focus.title.co2', 'Focus height (CO2)')}</h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={params.useFocusZ}
              onChange={(e) => setParams({ useFocusZ: e.target.checked })}
            />
            {t('laser.focus.setZ', 'Set Z')}
          </label>
        </div>
        {params.useFocusZ ? (
          <div className="lp-sliders">
            <SliderField
              icon={<Icon name="probe" size={14} />}
              label={t('laser.focus.z', 'Focus Z')}
              unit="mm"
              min={0}
              max={200}
              step={0.1}
              value={params.focusZ}
              onChange={(n) => setParams({ focusZ: clamp(n, 0, 200) })}
              title={t('laser.focus.z.title', 'Absolute Z moved to at program start to set focus (0..200 mm). Negative Z is blocked — there is no safe-Z retract before this move.')}
            />
          </div>
        ) : (
          <p className="lp-hint">
            {t('laser.focus.hint', 'Z is left untouched — focus the head manually.')}
          </p>
        )}
        <p className="lp-note">
          {fiberMode
            ? t('laser.focus.note.fiber', 'Note: true capacitive height-following is not possible in plain GRBL — this sets a fixed focus Z.')
            : t('laser.focus.note.co2', 'CO2 focus is usually fixed/manual; set a Z here only if your machine focuses by Z.')}
        </p>
      </section>

      {/* L18 — Fiber/galvo pulse (fiber mode only). */}
      {fiberMode && (
        <section className="lp-card ui-card">
          <div className="lp-card-head">
            <h4 className="ui-sec-head">{t('laser.fiber.title', 'Galvo / Q-pulse (Fiber)')}</h4>
          </div>
          <div className="lp-sliders">
            <SliderField
              icon={<Icon name="laser" size={14} />}
              label={t('laser.fiber.freq', 'Frequency')}
              unit="kHz"
              min={1}
              max={200}
              step={1}
              integer
              value={params.fiberFrequencyKHz}
              onChange={(n) => setParams({ fiberFrequencyKHz: clamp(Math.floor(n), 1, 200) })}
              title={t('laser.fiber.freq.title', 'Q-switch pulse frequency. Emitted as a header comment — plain GRBL has no pulse word; EZCAD-class controllers consume it.')}
            />
            <SliderField
              icon={<Icon name="pause" size={14} />}
              label={t('laser.fiber.pulse', 'Q-pulse')}
              unit="ns"
              min={1}
              max={1000}
              step={1}
              integer
              value={params.fiberPulseNs}
              onChange={(n) => setParams({ fiberPulseNs: clamp(Math.floor(n), 1, 1000) })}
              title={t('laser.fiber.pulse.title', 'Pulse width (nanoseconds). Header comment only.')}
            />
          </div>
          <p className="lp-note">
            {t('laser.fiber.note', 'For marking/engraving the fill (Line/Offset) hatches the interior; combine with these pulse settings on a galvo controller.')}
          </p>
        </section>
      )}
      </>
      )}

      <LaserTestGridCard
        defaults={{
          sMax: Math.max(1, params.sMax),
          powerMax: Math.max(1, params.sMax),
          feedMin: Math.max(1, Math.round(params.cutFeed / 4)),
          feedMax: Math.max(1, params.cutFeed),
          dynamicPower: params.powerMode === LaserPowerMode.Dynamic,
          airAssist: params.airAssist,
          decimals: params.decimals,
        }}
      />

      <p className="lp-safety">
        {t('laser.safety', 'Safety: laser OFF (M5 S0) during all travel; beam on (M3/M4 S…) only on cut feeds; requires GRBL laser mode $32=1.')}
      </p>
    </div>
      <PresetSaveBar
        slots={presets.slots}
        selected={presets.selected}
        onSelect={presets.select}
        onSave={presets.save}
        onClear={presets.clear}
        onRename={presets.rename}
        extra={
          <SaveLoadButtons
            value={settings}
            onLoad={loadDoc}
            onError={setLoadError}
            fileBase="laser-settings"
            ext="klaser"
            saveTitle={t('laser.preset.save', 'Save laser settings to file')}
            loadTitle={t('laser.preset.load', 'Load laser settings from file')}
          />
        }
      />
    </div>
  )
}
