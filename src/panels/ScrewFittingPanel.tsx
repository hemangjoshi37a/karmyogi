import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useMachine, useProgram, useNotifications, usePersistentState } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import {
  MoveHorizontal,
  MoveVertical,
  ArrowDownToLine,
  ArrowUpToLine,
  Timer,
  Gauge,
  FastForward,
  ChevronsDown,
  Drill,
  Magnet,
  Hash,
} from 'lucide-react'
import {
  defaultScrewDrivePoint,
  defaultScrewDrivingParams,
  generateScrewDriving,
  type ScrewDrivePoint,
  type ScrewDrivingParams,
} from '../core/screwDriving'
import '../styles/screwdriving.css'

/** Clamp decimals to the range toFixed() accepts (0..6) — guards the render-phase
 * useMemo from a RangeError that would white-screen the panel. */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Split G-code into non-empty lines for the line count shown to the operator. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/** Coerce an (untrusted) value to a finite number, else the fallback. */
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** Generator params editable from the panel (programName/metric are fixed here). */
type EditableParams = Omit<ScrewDrivingParams, 'programName' | 'metric'>

/** What a JSON save/load file holds: the screw list + the parameters. */
interface ScrewDriveDoc {
  points: ScrewDrivePoint[]
  params: EditableParams
}

/** Coerce an unknown loaded value into a screw point (defensive, never throws). */
function toPoint(v: unknown, defaultDepth: number): ScrewDrivePoint {
  const o = (v ?? {}) as Record<string, unknown>
  return defaultScrewDrivePoint({
    x: typeof o.x === 'number' ? o.x : 0,
    y: typeof o.y === 'number' ? o.y : 0,
    depth: typeof o.depth === 'number' ? o.depth : defaultDepth,
  })
}

/**
 * A slim square icon button for the header toolbar. Its `title`/`body` combine
 * into a native hover tooltip that never intercepts the action click — keeping
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
      className={`swd-ico${className ? ' ' + className : ''}`}
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

/**
 * Sleek slider + number-input + unit row for the loader/driver/motion parameters,
 * mirroring CadCamPanel's `SliderField` and the Controller jog "Feed" control.
 * One compact line: leading glyph + label, a themed draggable `.sd-slider` (accent
 * fill via the inline `--pct` var), a small typable number box clamped to
 * [min, max] for the slider but allowing exact entry, and an inline unit suffix.
 * The `value`/`onChange` wiring is unchanged from the old NumField — only the
 * input WIDGET changes (number box → slider + number).
 */
function SliderField(props: {
  icon: ReactNode
  label: string
  value: number
  unit?: string
  min: number
  max: number
  step: number
  onChange: (n: number) => void
  info?: { title: string; body: string }
}) {
  const { icon, label, value, unit, min, max, step, onChange, info } = props
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  // Filled-track percentage for the slider's accent fill (read as --pct by the
  // WebKit/Blink track gradient; Firefox fills via ::-moz-range-progress). Uses
  // the CLAMPED value so an out-of-range typed value never overflows the fill.
  const pct = max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="sd-sfield">
      <span className="sd-sfield-lbl">
        <span className="sd-sfield-ico" aria-hidden>
          {icon}
        </span>
        <span className="sd-sfield-txt">{label}</span>
        {info && <InfoTip topic="screwDriveField" title={info.title} body={info.body} />}
      </span>
      <input
        type="range"
        className="sd-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="sd-sfield-num">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          aria-label={label}
          onChange={(e) => {
            // Allow EXACT entry (don't clamp the typed number) — only blank/NaN is
            // rejected; the caller's own guards clamp where it matters (feeds etc.).
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit && <i>{unit}</i>}
      </span>
    </div>
  )
}

/**
 * Screw Fitting panel — an automated screw-DRIVING machine. An electric
 * screwdriver with a MAGNETIC bit mounted in the spindle slot picks screws from a
 * known loader and drives them into a list of target points. An editable table of
 * target points (captured from the live machine X/Y) plus the loader/driver
 * settings drive the pure `generateScrewDriving` core, which emits a safe program
 * (M3 spins the driver to DRIVE; the magnetic pick is just descend + dwell +
 * retract). The program auto-syncs to the shared store so the Visualizer renders
 * it and the Program tab streams it; a Send button pushes it immediately, and the
 * G-code can be copied/downloaded.
 */
export function ScrewFittingPanel() {
  const t = useT()
  // Live machine work-position + connection (for "Add point" / "Record position").
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const notify = useNotifications((s) => s.notify)

  const [points, setPoints] = useState<ScrewDrivePoint[]>([])
  const [selected, setSelected] = useState(-1)
  const [showSettings, setShowSettings] = usePersistentState<boolean>(
    'karmyogi.screwdrive.showSettings',
    true,
  )

  const [params, setParams] = useState<EditableParams>(() => {
    const d = defaultScrewDrivingParams()
    return {
      pickupX: d.pickupX,
      pickupY: d.pickupY,
      pickZ: d.pickZ,
      pickDwellSec: d.pickDwellSec,
      safeZ: d.safeZ,
      driverRPM: d.driverRPM,
      pushFeed: d.pushFeed,
      approachFeed: d.approachFeed,
      seatDwellSec: d.seatDwellSec,
      defaultDepth: d.defaultDepth,
      decimals: clampDecimals(d.decimals),
    }
  })

  // ---- color-coded setting PRESETS (loader/driver/motion params only) -------
  // Restore the editable params from an (untrusted) snapshot, coercing every
  // field so a corrupt slot or hand-edited file can never feed a NaN to the
  // emitter. Feeds / dwells / RPM / Safe-Z are clamped non-negative; depths stay
  // signed (negative = into the work); decimals stay in toFixed()'s 0–6 range.
  // Shared by both the preset rail and the settings Save/Load pair.
  const applyParams = (raw: unknown) => {
    const o = (raw ?? {}) as Record<string, unknown>
    setParams((prev) => ({
      pickupX: numOr(o.pickupX, prev.pickupX),
      pickupY: numOr(o.pickupY, prev.pickupY),
      pickZ: numOr(o.pickZ, prev.pickZ),
      pickDwellSec: Math.max(0, numOr(o.pickDwellSec, prev.pickDwellSec)),
      safeZ: Math.max(0, numOr(o.safeZ, prev.safeZ)),
      driverRPM: Math.max(0, numOr(o.driverRPM, prev.driverRPM)),
      pushFeed: Math.max(0, numOr(o.pushFeed, prev.pushFeed)),
      approachFeed: Math.max(0, numOr(o.approachFeed, prev.approachFeed)),
      seatDwellSec: Math.max(0, numOr(o.seatDwellSec, prev.seatDwellSec)),
      defaultDepth: numOr(o.defaultDepth, prev.defaultDepth),
      decimals: clampDecimals(numOr(o.decimals, prev.decimals)),
    }))
  }
  // Snapshot only the SETTINGS (loader/driver/motion params) — NOT the screw
  // point list, which is the operator's actual work. Scoped to its own key so
  // it is independent of the carving / soldering / writing presets.
  const presets = usePresets<EditableParams>({
    storageKey: 'karmyogi.screwdrive.presets',
    capture: () => ({ ...params }),
    onApply: applyParams,
  })

  function addRow() {
    // Prefill X/Y from the LIVE machine work-position when connected so the new
    // point lands where the bit currently is (jog to the spot, then Add). The
    // depth comes from the configured default. When disconnected fall back to the
    // origin — never crash.
    const x = connected ? wpos.x : 0
    const y = connected ? wpos.y : 0
    setPoints((p) => {
      setSelected(p.length)
      return [...p, defaultScrewDrivePoint({ x, y, depth: params.defaultDepth })]
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

  function updatePoint(i: number, patch: Partial<ScrewDrivePoint>) {
    setPoints((p) => p.map((pt, idx) => (idx === i ? { ...pt, ...patch } : pt)))
  }

  // Record the live machine position: fill the selected row's X/Y, else append.
  function recordPosition() {
    if (!connected) return
    if (selected >= 0 && selected < points.length) {
      updatePoint(selected, { x: wpos.x, y: wpos.y })
    } else {
      setPoints((p) => {
        setSelected(p.length)
        return [...p, defaultScrewDrivePoint({ x: wpos.x, y: wpos.y, depth: params.defaultDepth })]
      })
    }
  }

  function clearAll() {
    if (points.length === 0) return
    if (!window.confirm(t('screw.clearConfirm', 'Remove all {n} screw point(s)?', { n: points.length })))
      return
    setPoints([])
    setSelected(-1)
  }

  // Sanitised params for generation + preview: clamp decimals and force feeds /
  // dwells / safe-Z non-negative so a typed negative never produces an inverted
  // move or a backwards feed. Depths stay signed (negative = into the work).
  const safeParams = useMemo<EditableParams>(
    () => ({
      ...params,
      decimals: clampDecimals(params.decimals),
      pickDwellSec: Math.max(0, params.pickDwellSec),
      safeZ: Math.max(0, params.safeZ),
      driverRPM: Math.max(0, params.driverRPM),
      pushFeed: Math.max(0, params.pushFeed),
      approachFeed: Math.max(0, params.approachFeed),
      seatDwellSec: Math.max(0, params.seatDwellSec),
    }),
    [params],
  )

  const gcode = useMemo(() => generateScrewDriving(points, safeParams), [points, safeParams])
  // With no screw points there is nothing to drive, so report ZERO lines (and
  // never push a body-less program to the store) — the status strip must not
  // claim a line count while the list is empty.
  const lineCount = useMemo(
    () => (points.length === 0 ? 0 : gcodeLines(gcode).length),
    [gcode, points.length],
  )

  // Warn when the pick Z is at or above safe-Z: the bit would never descend onto
  // the loader to grab a screw (a degenerate pick).
  const pickTooHigh = useMemo(
    () => points.length > 0 && safeParams.pickZ >= safeParams.safeZ,
    [points.length, safeParams.pickZ, safeParams.safeZ],
  )
  // Warn when a target depth is at or above safe-Z: the driver would never push
  // the screw down. Lists the 1-based point indices.
  const shallowPoints = useMemo(
    () => points.map((p, i) => (p.depth >= safeParams.safeZ ? i + 1 : -1)).filter((i) => i > 0),
    [points, safeParams.safeZ],
  )

  const doc: ScrewDriveDoc = useMemo(() => ({ points, params }), [points, params])

  function loadDoc(data: unknown) {
    const o = (data ?? {}) as Record<string, unknown>
    // Read the saved default depth first so blank per-point depths inherit it.
    const savedParams =
      o.params && typeof o.params === 'object'
        ? defaultScrewDrivingParams(o.params as Partial<ScrewDrivingParams>)
        : defaultScrewDrivingParams()
    const rawPoints = Array.isArray(o.points) ? o.points : []
    const parsed = rawPoints.map((v) => toPoint(v, savedParams.defaultDepth))
    if (parsed.length === 0 && !o.params) {
      notify('warn', t('screw.load.empty', 'No usable screw points found in that file.'))
      return
    }
    if (
      points.length > 0 &&
      !window.confirm(
        t('screw.load.replaceConfirm', 'Replace the current {n} point(s) with {m} from the file?', {
          n: points.length,
          m: parsed.length,
        }),
      )
    ) {
      return
    }
    setPoints(parsed)
    setSelected(-1)
    // Merge any saved params over the defaults so unknown/missing keys are safe.
    if (o.params && typeof o.params === 'object') {
      setParams({
        pickupX: savedParams.pickupX,
        pickupY: savedParams.pickupY,
        pickZ: savedParams.pickZ,
        pickDwellSec: savedParams.pickDwellSec,
        safeZ: savedParams.safeZ,
        driverRPM: savedParams.driverRPM,
        pushFeed: savedParams.pushFeed,
        approachFeed: savedParams.approachFeed,
        seatDwellSec: savedParams.seatDwellSec,
        defaultDepth: savedParams.defaultDepth,
        decimals: clampDecimals(savedParams.decimals),
      })
    }
    notify('success', t('screw.load.done', 'Loaded {n} screw point(s).', { n: parsed.length }))
  }

  // Copy the generated program to the clipboard.
  async function copyGcode() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(gcode)
      notify('success', t('screw.copied', 'Copied {n} G-code line(s) to the clipboard.', { n: lineCount }))
    } catch {
      notify('warn', t('screw.copyFailed', 'Could not copy to the clipboard.'))
    }
  }

  // Download the generated program as a .gcode/.nc file.
  function downloadGcode() {
    const blob = new Blob([gcode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'screw-driving.nc'
    a.click()
    URL.revokeObjectURL(url)
    notify('success', t('screw.downloaded', 'Downloaded the screw-driving program.'))
  }

  // Live generation: push the freshly-computed program to the store (debounced)
  // so the Visualizer + Program tab pick it up without a manual step. When the
  // list is emptied, DROP the section so no stale toolpath lingers.
  useEffect(() => {
    if (points.length === 0) {
      removeSection('screwfitting')
      return
    }
    const id = window.setTimeout(() => setProgram('screwfitting', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, points.length, setProgram, removeSection])

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('screw.presets.aria', 'Screw-fitting setting presets')}
      />
    <div className="swd-panel">
      {/* Slim header: title + icon toolbar. */}
      <header className="swd-head">
        <div className="swd-head-title">
          <span className="swd-head-name">{t('screw.title', 'Screw Fitting')}</span>
          <InfoTip
            topic="screwDriveMode"
            title={t('screw.title', 'Screw Fitting')}
            body={t(
              'screw.intro',
              'Drives screws automatically: an electric screwdriver with a magnetic bit in the spindle slot picks a screw from the loader, moves to each target point, and spins (M3) to drive it to depth. Add points from the live machine position; the program auto-syncs to the Program tab for streaming.',
            )}
          />
        </div>
        <div className="swd-tools">
          <ToolButton
            className="swd-ico-primary"
            glyph={<Icon name="add" />}
            onClick={addRow}
            title={t('screw.toolbar.add', 'Add point')}
            body={
              connected
                ? t('screw.toolbar.add.body.live', 'Append a screw point at the current machine X/Y (depth from the default).')
                : t('screw.toolbar.add.body', 'Append a screw point at the origin (connect to capture the live position).')
            }
          />
          <ToolButton
            glyph={<Icon name="probe" />}
            onClick={recordPosition}
            disabled={!connected}
            title={t('screw.toolbar.record', 'Record position')}
            body={
              connected
                ? selected >= 0
                  ? t('screw.toolbar.record.body.fill', 'Fills the selected row X/Y from the live machine position.')
                  : t('screw.toolbar.record.body.append', 'Appends a point at the current machine position.')
                : t('screw.toolbar.record.body.connect', 'Connect to a machine to capture its live position.')
            }
          />
          <ToolButton
            className="swd-ico-danger"
            glyph={<Icon name="trash" />}
            onClick={clearAll}
            disabled={points.length === 0}
            title={t('screw.toolbar.clear', 'Clear all')}
            body={t('screw.toolbar.clear.body', 'Remove every screw point and start over.')}
          />
          <span className="swd-tools-sep" aria-hidden="true" />
          <ToolButton
            glyph={<Icon name="copy" />}
            onClick={copyGcode}
            disabled={points.length === 0}
            title={t('screw.toolbar.copy', 'Copy G-code')}
            body={t('screw.toolbar.copy.body', 'Copy the generated screw-driving program to the clipboard.')}
          />
          <ToolButton
            glyph={<Icon name="download" />}
            onClick={downloadGcode}
            disabled={points.length === 0}
            title={t('screw.toolbar.download', 'Download G-code')}
            body={t('screw.toolbar.download.body', 'Download the generated screw-driving program as a .nc file.')}
          />
          <SaveLoadButtons
            value={doc}
            onLoad={loadDoc}
            fileBase="karmyogi-screws"
            ext="kscrew"
            saveDisabled={points.length === 0}
            saveTitle={t('screw.save', 'Save screw list')}
            loadTitle={t('screw.load', 'Load screw list')}
            onError={(m) => notify('warn', m)}
          />
          <span className="swd-tools-sep" aria-hidden="true" />
          <ToolButton
            className={showSettings ? 'is-active' : ''}
            glyph={<Icon name="settings" />}
            onClick={() => setShowSettings((v) => !v)}
            ariaExpanded={showSettings}
            title={t('screw.toolbar.settings', 'Settings')}
            body={t('screw.toolbar.settings.body', 'Loader pickup location, pick Z & dwell, driver RPM, push/approach feeds, seat dwell, default depth and Safe-Z.')}
          />
        </div>
      </header>

      {/* Live status strip: point + line counts, auto-synced to the Program tab. */}
      <div className="swd-status">
        <span className="swd-status-pill">
          <b>{points.length}</b> {t('screw.status.points', 'screws')}
        </span>
        <span className="swd-status-sep" aria-hidden="true">·</span>
        <span className="swd-status-pill">
          <b>{lineCount}</b> {t('screw.status.lines', 'G-code lines')}
        </span>
        <span className="swd-status-sep" aria-hidden="true">·</span>
        <span className="swd-status-pill">
          {t('screw.status.driver', 'driver')} <b>S{safeParams.driverRPM}</b>
        </span>
        <span className="swd-status-sync" title={t('screw.live.title', 'Lines auto-synced to the Program tab')}>
          → {t('screw.status.program', 'Program')}
        </span>
      </div>

      {pickTooHigh && (
        <p className="swd-warn">
          {t(
            'screw.warn.pickHigh',
            'Pick Z ({pz}) ≥ Safe-Z ({sz}) — the bit never descends onto the loader to grab a screw. Lower the pick Z below Safe-Z.',
            { pz: safeParams.pickZ.toFixed(2), sz: safeParams.safeZ.toFixed(2) },
          )}
        </p>
      )}
      {shallowPoints.length > 0 && (
        <p className="swd-warn">
          {t(
            'screw.warn.shallow',
            'Depth ≥ Safe-Z on point(s) {list} — the driver will not push the screw down. Set a depth below Safe-Z (negative = into the work).',
            { list: shallowPoints.join(', ') },
          )}
        </p>
      )}
      {!connected && points.length > 0 && (
        <p className="swd-warn">
          {t('screw.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
        </p>
      )}

      {/* Collapsible Settings. */}
      {showSettings && (
        <section className="swd-settings">
          <div className="swd-card">
            <div className="swd-card-head">
              <h4>{t('screw.loader.title', 'Screw loader')}</h4>
              <InfoTip
                topic="screwLoader"
                title={t('screw.loader.title', 'Screw loader')}
                body={t('screw.loader.body', 'Where a screw is picked from. The magnetic bit rapids to this XY, feeds down to the pick Z, and dwells so the magnet grabs the screw before retracting.')}
              />
            </div>
            <div className="swd-fields">
              <SliderField
                icon={<MoveHorizontal size={14} strokeWidth={1.8} />}
                label={t('screw.field.pickupX', 'Pickup X')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={400}
                step={0.5}
                value={params.pickupX}
                onChange={(n) => setParams((p) => ({ ...p, pickupX: n }))}
                info={{
                  title: t('screw.field.pickupX', 'Pickup X'),
                  body: t('screw.field.pickupX.body', 'Loader X the bit moves to in order to pick up a screw.'),
                }}
              />
              <SliderField
                icon={<MoveVertical size={14} strokeWidth={1.8} />}
                label={t('screw.field.pickupY', 'Pickup Y')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={400}
                step={0.5}
                value={params.pickupY}
                onChange={(n) => setParams((p) => ({ ...p, pickupY: n }))}
                info={{
                  title: t('screw.field.pickupY', 'Pickup Y'),
                  body: t('screw.field.pickupY.body', 'Loader Y the bit moves to in order to pick up a screw.'),
                }}
              />
              <SliderField
                icon={<ArrowDownToLine size={14} strokeWidth={1.8} />}
                label={t('screw.field.pickZ', 'Pick Z')}
                unit={t('unit.mm', 'mm')}
                min={-50}
                max={20}
                step={0.1}
                value={params.pickZ}
                onChange={(n) => setParams((p) => ({ ...p, pickZ: n }))}
                info={{
                  title: t('screw.field.pickZ', 'Pick Z'),
                  body: t('screw.field.pickZ.body', 'Height the magnetic bit descends to at the loader to grab a screw (absolute, usually negative).'),
                }}
              />
              <SliderField
                icon={<Magnet size={14} strokeWidth={1.8} />}
                label={t('screw.field.pickDwell', 'Pick dwell')}
                unit={t('unit.s', 's')}
                min={0}
                max={10}
                step={0.1}
                value={params.pickDwellSec}
                onChange={(n) => setParams((p) => ({ ...p, pickDwellSec: n }))}
                info={{
                  title: t('screw.field.pickDwell', 'Pick dwell'),
                  body: t('screw.field.pickDwell.body', 'Dwell at the loader so the magnet grabs the screw before retracting (seconds).'),
                }}
              />
            </div>
          </div>

          <div className="swd-card">
            <div className="swd-card-head">
              <h4>{t('screw.driver.title', 'Screwdriver')}</h4>
              <InfoTip
                topic="screwDriver"
                title={t('screw.driver.title', 'Screwdriver')}
                body={t('screw.driver.body', 'The spindle output is the electric screwdriver. M3 S<rpm> spins it to DRIVE the screw in; M5 stops it. The push feed is how fast the screw is driven down; the seat dwell holds at depth so the screw seats.')}
              />
            </div>
            <div className="swd-fields">
              <SliderField
                icon={<Gauge size={14} strokeWidth={1.8} />}
                label={t('screw.field.driverRPM', 'Driver')}
                unit={t('unit.sWord', 'S')}
                min={0}
                max={24000}
                step={100}
                value={params.driverRPM}
                onChange={(n) => setParams((p) => ({ ...p, driverRPM: n }))}
                info={{
                  title: t('screw.field.driverRPM', 'Driver speed'),
                  body: t('screw.field.driverRPM.body', 'Spindle speed word (S) that spins the electric screwdriver while driving (M3).'),
                }}
              />
              <SliderField
                icon={<FastForward size={14} strokeWidth={1.8} />}
                label={t('screw.field.pushFeed', 'Push')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={0}
                max={2000}
                step={10}
                value={params.pushFeed}
                onChange={(n) => setParams((p) => ({ ...p, pushFeed: n }))}
                info={{
                  title: t('screw.field.pushFeed', 'Push feed'),
                  body: t('screw.field.pushFeed.body', 'The speed of pushing — the Z plunge feed while driving the screw down into the work.'),
                }}
              />
              <SliderField
                icon={<ChevronsDown size={14} strokeWidth={1.8} />}
                label={t('screw.field.approachFeed', 'Approach')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={0}
                max={2000}
                step={10}
                value={params.approachFeed}
                onChange={(n) => setParams((p) => ({ ...p, approachFeed: n }))}
                info={{
                  title: t('screw.field.approachFeed', 'Approach feed'),
                  body: t('screw.field.approachFeed.body', 'Feed rate for the descent onto the loader when picking a screw.'),
                }}
              />
              <SliderField
                icon={<Timer size={14} strokeWidth={1.8} />}
                label={t('screw.field.seatDwell', 'Seat dwell')}
                unit={t('unit.s', 's')}
                min={0}
                max={10}
                step={0.1}
                value={params.seatDwellSec}
                onChange={(n) => setParams((p) => ({ ...p, seatDwellSec: n }))}
                info={{
                  title: t('screw.field.seatDwell', 'Seat dwell'),
                  body: t('screw.field.seatDwell.body', 'Dwell at the final depth so the screw seats before the driver stops and retracts (seconds).'),
                }}
              />
            </div>
          </div>

          <div className="swd-card">
            <div className="swd-card-head">
              <h4>{t('screw.motion.title', 'Depth & motion')}</h4>
              <InfoTip
                topic="screwMotion"
                title={t('screw.motion.title', 'Depth & motion')}
                body={t('screw.motion.body', 'Default per-point screwing depth (negative = into the work), the guaranteed Safe-Z retract height, and the emitted coordinate precision.')}
              />
            </div>
            <div className="swd-fields">
              <SliderField
                icon={<Drill size={14} strokeWidth={1.8} />}
                label={t('screw.field.defaultDepth', 'Default depth')}
                unit={t('unit.mm', 'mm')}
                min={-50}
                max={20}
                step={0.1}
                value={params.defaultDepth}
                onChange={(n) => setParams((p) => ({ ...p, defaultDepth: n }))}
                info={{
                  title: t('screw.field.defaultDepth', 'Default depth'),
                  body: t('screw.field.defaultDepth.body', 'Depth a newly added screw is driven to (negative = into the work). Each point can override it.'),
                }}
              />
              <SliderField
                icon={<ArrowUpToLine size={14} strokeWidth={1.8} />}
                label={t('screw.field.safeZ', 'Safe-Z')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={60}
                step={0.5}
                value={params.safeZ}
                onChange={(n) => setParams((p) => ({ ...p, safeZ: n }))}
                info={{
                  title: t('screw.field.safeZ', 'Safe-Z'),
                  body: t('screw.field.safeZ.body', 'Guaranteed retract height before any XY travel and at program end.'),
                }}
              />
            </div>
            {/* Coordinate precision is a small enum (0–6) — a segmented control reads
                clearer than a slider and snaps to exact integers. */}
            <div className="sd-enum-row">
              <span className="sd-enum-lbl">
                <span className="sd-sfield-ico" aria-hidden>
                  <Hash size={14} strokeWidth={1.8} />
                </span>
                {t('screw.field.decimals', 'Decimals')}
                <InfoTip
                  topic="screwDriveField"
                  title={t('screw.field.decimals', 'Decimals')}
                  body={t('screw.field.decimals.body', 'Number of decimal places in the emitted coordinates (0–6).')}
                />
              </span>
              <div className="sd-seg" role="group" aria-label={t('screw.field.decimals', 'Decimals')}>
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={'sd-seg-btn' + (clampDecimals(params.decimals) === d ? ' active' : '')}
                    aria-pressed={clampDecimals(params.decimals) === d}
                    onClick={() => setParams((p) => ({ ...p, decimals: d }))}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Points — compact editable table (reflows to stacked cards when narrow). */}
      <div className="swd-card swd-points">
        <div className="swd-card-head">
          <h4>{t('screw.points.title', 'Screw points')}</h4>
          <span className="swd-card-count">{points.length}</span>
        </div>
        <div className="swd-table-wrap">
          <table className="swd-table">
            <thead>
              <tr>
                <th className="swd-idx">{t('screw.table.num', '#')}</th>
                <th>{t('screw.table.x', 'X')}</th>
                <th>{t('screw.table.y', 'Y')}</th>
                <th>{t('screw.table.depth', 'Depth')}</th>
                <th className="swd-actions-col" aria-label={t('screw.table.actions', 'Actions')} />
              </tr>
            </thead>
            <tbody>
              {points.length === 0 && (
                <tr>
                  <td colSpan={5} className="swd-empty">
                    {t(
                      'screw.table.empty',
                      'No screws yet. Press + to add one, or ⌖ to record the machine position.',
                    )}
                  </td>
                </tr>
              )}
              {points.map((pt, i) => (
                <tr
                  key={i}
                  className={i === selected ? 'swd-row-selected' : undefined}
                  onClick={() => setSelected(i)}
                >
                  <td className="swd-idx">{i + 1}</td>
                  <td data-label={t('screw.table.x', 'X')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.x}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    />
                  </td>
                  <td data-label={t('screw.table.y', 'Y')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.y}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    />
                  </td>
                  <td data-label={t('screw.table.depth', 'Depth')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.depth}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { depth: num(e.target.value, pt.depth) })}
                    />
                  </td>
                  <td className="swd-actions">
                    <button
                      className="swd-row-ico"
                      title={t('screw.row.moveUp', 'Move up')}
                      aria-label={t('screw.row.moveUp', 'Move up')}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, -1)
                      }}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      className="swd-row-ico"
                      title={t('screw.row.moveDown', 'Move down')}
                      aria-label={t('screw.row.moveDown', 'Move down')}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, 1)
                      }}
                      disabled={i === points.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className="swd-row-ico swd-del"
                      title={t('screw.row.delete', 'Delete point')}
                      aria-label={t('screw.row.delete', 'Delete point')}
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteRow(i)
                      }}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Narrow PANEL: each point becomes a compact card. */}
        <div className="swd-cards">
          {points.length === 0 && (
            <p className="swd-empty">
              {t(
                'screw.table.empty',
                'No screws yet. Press + to add one, or ⌖ to record the machine position.',
              )}
            </p>
          )}
          {points.map((pt, i) => (
            <div
              key={i}
              className={`swd-pcard${i === selected ? ' is-selected' : ''}`}
              onClick={() => setSelected(i)}
            >
              <div className="swd-pcard-head">
                <span className="swd-pcard-idx">
                  {t('screw.card.point', 'Screw')} {i + 1}
                </span>
                <div className="swd-pcard-actions">
                  <button
                    className="swd-row-ico"
                    title={t('screw.row.moveUp', 'Move up')}
                    aria-label={t('screw.row.moveUp', 'Move up')}
                    onClick={(e) => {
                      e.stopPropagation()
                      moveRow(i, -1)
                    }}
                    disabled={i === 0}
                  >
                    ↑
                  </button>
                  <button
                    className="swd-row-ico"
                    title={t('screw.row.moveDown', 'Move down')}
                    aria-label={t('screw.row.moveDown', 'Move down')}
                    onClick={(e) => {
                      e.stopPropagation()
                      moveRow(i, 1)
                    }}
                    disabled={i === points.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    className="swd-row-ico swd-del"
                    title={t('screw.row.delete', 'Delete point')}
                    aria-label={t('screw.row.delete', 'Delete point')}
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteRow(i)
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>

              <div className="swd-pcard-grid">
                <label className="swd-mini">
                  <span>{t('screw.table.x', 'X')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.x}
                    onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="swd-mini">
                  <span>{t('screw.table.y', 'Y')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.y}
                    onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="swd-mini">
                  <span>{t('screw.table.depth', 'Depth')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.depth}
                    onChange={(e) => updatePoint(i, { depth: num(e.target.value, pt.depth) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
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
            value={params}
            onLoad={applyParams}
            fileBase="screwdrive-settings"
            ext="kscrewset"
            saveTitle={t('screw.settings.save', 'Save screw-fitting settings')}
            loadTitle={t('screw.settings.load', 'Load screw-fitting settings')}
            onError={(m) => notify('warn', m)}
          />
        }
      />
    </div>
  )
}
