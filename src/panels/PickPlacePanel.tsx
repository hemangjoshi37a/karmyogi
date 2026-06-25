import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTabCommands } from '../machine/tabCommands'
import { useT } from '../i18n'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useBed } from '../store/bed'
import { Icon } from '../components/Icons'
import { IconButton } from '../components/IconButton'
import { InfoTip } from '../components/InfoTip'
import { Modal } from '../components/Modal'
import {
  Crosshair,
  MapPin,
  Settings,
  ArrowUpToLine,
  ArrowDownToLine,
  Gauge,
  FastForward,
  Grip,
  Timer,
  Hash,
  RotateCw,
  Wind,
} from 'lucide-react'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import {
  defaultPnpOp,
  defaultPnpParams,
  defaultFeeder,
  defaultNozzleTip,
  defaultPart,
  generatePickPlace,
  newPnpOpId,
  type PnpHeadType,
  type PnpOp,
  type PnpParams,
  type PnpFeeder,
  type PnpNozzleTip,
  type PnpPart,
} from '../core/pickPlace'
import { expandArray } from '../core/arrayDuplicate'
import { CamEmpty, CamStatus } from '../components/cam/CamUI'
import { SegControl } from '../components/ui/SegControl'
import '../styles/pickplace.css'
import '../styles/cam.css'

/** Split G-code into non-empty lines for streaming to the controller. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/** Round to `decimals` places (used when clamping loaded coordinates). */
const roundTo = (v: number, decimals: number): number => {
  const f = Math.pow(10, Math.max(0, Math.min(6, decimals)))
  return Math.round(v * f) / f
}

const PAD = 6

/** Per-op params the table edits (everything else is global). */
type PanelParams = Omit<PnpParams, 'programName' | 'metric'>

/** The serializable Pick & Place document written by Save / read by Load. */
interface PnpDoc {
  kind: 'karmyogi.pnp'
  version: 1
  ops: PnpOp[]
  params: PanelParams
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const numOr = (v: unknown, f: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : f
const boolOr = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f)

/**
 * Narrow one unknown entry into a valid PnpOp (drops anything malformed).
 * Coordinates are clamped to `decimals` places on load so a hand-edited file
 * with long floats doesn't surface noisy precision in the table; a fresh stable
 * id is minted (loaded files never carry trustworthy keys).
 */
function parseOp(v: unknown, decimals: number): PnpOp | null {
  if (!isRecord(v)) return null
  const op = defaultPnpOp({
    id: newPnpOpId(),
    pickX: roundTo(numOr(v.pickX, 0), decimals),
    pickY: roundTo(numOr(v.pickY, 0), decimals),
    placeX: roundTo(numOr(v.placeX, 0), decimals),
    placeY: roundTo(numOr(v.placeY, 0), decimals),
  })
  if (typeof v.rotation === 'number' && Number.isFinite(v.rotation)) {
    op.rotation = roundTo(v.rotation, decimals)
  }
  return op
}

/** Narrow unknown into a valid PanelParams, falling back per-field to `base`. */
function parsePnpParams(v: unknown, base: PanelParams): PanelParams {
  if (!isRecord(v)) return base
  const headType: PnpHeadType =
    v.headType === 'vacuum' || v.headType === 'gripper' ? v.headType : base.headType
  return {
    headType,
    travelZ: numOr(v.travelZ, base.travelZ),
    pickZ: numOr(v.pickZ, base.pickZ),
    placeZ: numOr(v.placeZ, base.placeZ),
    feedXY: numOr(v.feedXY, base.feedXY),
    feedZ: numOr(v.feedZ, base.feedZ),
    gripRpm: numOr(v.gripRpm, base.gripRpm),
    pickDwellMs: numOr(v.pickDwellMs, base.pickDwellMs),
    placeDwellMs: numOr(v.placeDwellMs, base.placeDwellMs),
    rotaryAxis: boolOr(v.rotaryAxis, base.rotaryAxis),
    blowOff: boolOr(v.blowOff, base.blowOff),
    blowOffMs: numOr(v.blowOffMs, base.blowOffMs),
    partPresentCheck: boolOr(v.partPresentCheck, base.partPresentCheck),
    parkAtEnd: boolOr(v.parkAtEnd, base.parkAtEnd),
    parkX: numOr(v.parkX, base.parkX),
    parkY: numOr(v.parkY, base.parkY),
    discardX: numOr(v.discardX, base.discardX),
    discardY: numOr(v.discardY, base.discardY),
    decimals: numOr(v.decimals, base.decimals),
  }
}

/** Head-type labelling: pick/release vs grip/open. */
function headLabels(head: PnpHeadType, t: ReturnType<typeof useT>): { on: string; off: string } {
  return head === 'gripper'
    ? { on: t('pnp.head.grip', 'Grip'), off: t('pnp.head.open', 'Open') }
    : { on: t('pnp.head.vacuum', 'Vacuum'), off: t('pnp.head.release', 'Release') }
}

/**
 * A slim square icon button for the header toolbar (the Soldering / CAD-CAM
 * house pattern). `title`/`body` are combined into a native hover tooltip
 * explainer (one that never intercepts the action click). An optional `text`
 * label sits beside the glyph for the few actions that need a word.
 */
function ToolButton(props: {
  glyph: ReactNode
  title: string
  body: string
  onClick: () => void
  text?: string
  className?: string
  disabled?: boolean
}) {
  const { glyph, title, body, onClick, text, className = '', disabled } = props
  return (
    <button
      type="button"
      className={`pp-ico${text ? ' pp-ico-text' : ''}${className ? ' ' + className : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={`${title} — ${body}`}
    >
      <span aria-hidden="true">{glyph}</span>
      {text && <span className="pp-ico-label">{text}</span>}
    </button>
  )
}

/**
 * A number input that keeps the user's RAW keystrokes in local string state
 * while focused, so transient values ("", "-", "1.", "-0.0") never get coerced
 * back to a number mid-edit (which fought the caret and reverted typing). The
 * committed numeric value is only produced on blur (and Enter) via `commit`,
 * which clamps/normalizes; when the field isn't focused it mirrors `value`.
 */
function NumField(props: {
  value: number
  /** Coerce the typed string to the committed number (clamp/round here). */
  commit: (raw: string) => void
  step?: string
  min?: string
  max?: string
  title?: string
  className?: string
  'aria-label'?: string
  'aria-invalid'?: boolean
}) {
  const { value, commit, ...rest } = props
  const [draft, setDraft] = useState<string | null>(null)
  // Show the live draft while editing; otherwise reflect the canonical value.
  const shown = draft ?? String(value)
  return (
    <input
      type="number"
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        commit(e.target.value)
        setDraft(null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      {...rest}
    />
  )
}

/**
 * Sleek slider + number-input + unit row for the settings params, mirroring the
 * CadCam `SliderField` / Controller jog "Feed" pattern: a leading glyph + label,
 * a themed draggable `.pnp-slider` (accent fill via the inline `--pct` var), a
 * small typable `.pnp-slider-num` clamped to [min, max] for the slider but
 * allowing exact entry, and an inline unit suffix. `value`/`onChange` carry the
 * existing wiring untouched — only the WIDGET changes (number box → slider).
 * `warn` tints the row when a validation rule flags it (e.g. unsafe Travel Z).
 */
function SliderField(props: {
  icon: ReactNode
  label: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step: number
  unit?: string
  info?: { title: string; body: string }
  warn?: boolean
}) {
  const { icon, label, value, onChange, min, max, step, unit, info, warn } = props
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  // Filled-track percentage for the slider's accent fill (read as --pct by the
  // WebKit/Blink track gradient; Firefox fills via ::-moz-range-progress). Uses
  // the CLAMPED value so an out-of-range typed value doesn't overflow the fill.
  const pct =
    max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(value)
  return (
    <div className={`pnp-sfield${warn ? ' pnp-sfield-warn' : ''}`}>
      <span className="pnp-sfield-lbl">
        <span className="pnp-sfield-ico" aria-hidden="true">
          {icon}
        </span>
        <span className="pnp-sfield-txt">
          {label}
          {info && <InfoTip topic="pnpField" title={info.title} body={info.body} />}
        </span>
      </span>
      <input
        type="range"
        className="pnp-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="pnp-sfield-num">
        <input
          type="number"
          className="pnp-slider-num"
          min={min}
          max={max}
          step={step}
          value={shown}
          aria-label={label}
          aria-invalid={warn || undefined}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            // Commit verbatim on blur (caller's guard clamps/rounds); exact entry
            // outside the slider range is allowed, only blank/NaN is rejected.
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
            setDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        {unit ? <span className="pnp-sfield-unit">{unit}</span> : null}
      </span>
    </div>
  )
}

/** Whether a point lies inside the bed rectangle [0..w] x [0..h]. */
const inBed = (x: number, y: number, w: number, h: number): boolean =>
  x >= 0 && x <= w && y >= 0 && y <= h

/**
 * Pick & Place panel. The head is a vacuum suction cup / gripper wired to the
 * spindle output (M3 = grip/vacuum ON, M5 = release OFF). An editable table of
 * pick→place operations drives the pure `generatePickPlace` core, which emits a
 * safe program (travel at safe-Z, lower to pick, grip, lift, travel to place,
 * lower, release, lift). "Set pick/place" captures the live work position.
 * Generation is live + debounced into the shared program store so the
 * Visualizer previews the travel/pick/place path; the job is streamed from the
 * Program / Controller tab (like Glue / Soldering), not from this panel.
 *
 * Layout (house style): a slim header (title + ⓘ + icon toolbar), an
 * always-visible status strip (op/line counts · connection · sync hint), then a
 * vertical-only scroller whose CARD sections tile into a responsive grid — the
 * ops table and bed preview stay full width, while the motion params and the
 * collapsed Advanced section tile beside each other at wide widths (collapsing
 * to one column when the panel is narrow).
 */
export function PickPlacePanel() {
  const t = useT()
  // Live machine work-position + connection (for "Set pick/place").
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const streaming = useProgram((s) => s.streaming)
  // Bed size from the shared store so the preview matches the user's machine
  // (X = width, Y = depth). Falls back to the store's persisted defaults.
  const bedW = useBed((s) => s.width)
  const bedH = useBed((s) => s.depth)

  const [ops, setOps] = usePersistentState<PnpOp[]>('karmyogi.pnp.ops', [])
  const [params, setParams] = usePersistentState<PanelParams>(
    'karmyogi.pnp.params',
    (() => {
      const d = defaultPnpParams()
      return {
        headType: d.headType,
        travelZ: d.travelZ,
        pickZ: d.pickZ,
        placeZ: d.placeZ,
        feedXY: d.feedXY,
        feedZ: d.feedZ,
        gripRpm: d.gripRpm,
        pickDwellMs: d.pickDwellMs,
        placeDwellMs: d.placeDwellMs,
        rotaryAxis: d.rotaryAxis,
        blowOff: d.blowOff,
        blowOffMs: d.blowOffMs,
        partPresentCheck: d.partPresentCheck,
        parkAtEnd: d.parkAtEnd,
        parkX: d.parkX,
        parkY: d.parkY,
        discardX: d.discardX,
        discardY: d.discardY,
        decimals: d.decimals,
      }
    })(),
  )

  const [selected, setSelected] = useState(-1)
  const [showSettings, setShowSettings] = usePersistentState<boolean>('karmyogi.pnp.showSettings', false)
  const [loadError, setLoadError] = useState('')

  const labels = headLabels(params.headType, t)

  // --- op CRUD ---
  function addRow() {
    setOps((p) => [...p, defaultPnpOp()])
    setSelected(ops.length)
  }
  function deleteRow(i: number) {
    setOps((p) => p.filter((_, idx) => idx !== i))
    setSelected((s) => (s === i ? -1 : s > i ? s - 1 : s))
  }
  // Insert a copy of op `i` directly after it (new identity, same coords).
  function duplicateRow(i: number) {
    setOps((p) => {
      const src = p[i]
      if (!src) return p
      const copy: PnpOp = { ...src, id: newPnpOpId() }
      const next = [...p]
      next.splice(i + 1, 0, copy)
      return next
    })
    setSelected(i + 1)
  }
  function clearOps() {
    if (ops.length === 0) return
    if (!window.confirm(t('pnp.clear.confirm', 'Remove all {n} operations?', { n: ops.length }))) return
    setOps([])
    setSelected(-1)
  }
  function moveRow(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= ops.length) return
    setOps((p) => {
      const next = [...p]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setSelected(j)
  }
  function updateOp(i: number, patch: Partial<PnpOp>) {
    setOps((p) => p.map((op, idx) => (idx === i ? { ...op, ...patch } : op)))
  }
  const setParam = <K extends keyof PanelParams>(key: K, value: PanelParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }))

  // ---- PP7: panelization (array the whole op set across identical boards) ----
  const [showPanel, setShowPanel] = useState(false)
  const [panRows, setPanRows] = usePersistentState('karmyogi.pnp.pan.rows', 2)
  const [panCols, setPanCols] = usePersistentState('karmyogi.pnp.pan.cols', 2)
  const [panSpX, setPanSpX] = usePersistentState('karmyogi.pnp.pan.spX', 50)
  const [panSpY, setPanSpY] = usePersistentState('karmyogi.pnp.pan.spY', 50)
  // Panelize: each board is a copy of the current op set translated by the panel
  // pitch. Only the PLACE points are arrayed (parts still come from the same
  // feeders/pick points); the pick stays fixed while the place steps per board.
  function applyPanelize() {
    if (ops.length === 0) return
    const src = ops.map((op) => ({ x: op.placeX, y: op.placeY, meta: op }))
    const res = expandArray(src, {
      kind: 'linear',
      rows: Math.max(1, Math.floor(panRows)),
      cols: Math.max(1, Math.floor(panCols)),
      spacingX: panSpX,
      spacingY: panSpY,
    })
    const next: PnpOp[] = res.points.map((p) => {
      const base = p.meta as PnpOp
      return { ...base, id: newPnpOpId(), placeX: p.x, placeY: p.y }
    })
    setOps(next)
    setSelected(-1)
    setShowPanel(false)
  }

  // ---- PP1/PP2/PP5: parts / feeder / nozzle library (self-contained) --------
  const [showLibrary, setShowLibrary] = useState(false)
  const [feeders, setFeeders] = usePersistentState<PnpFeeder[]>('karmyogi.pnp.feeders', [])
  const [nozzles, setNozzles] = usePersistentState<PnpNozzleTip[]>('karmyogi.pnp.nozzles', [])
  const [parts, setParts] = usePersistentState<PnpPart[]>('karmyogi.pnp.parts', [])
  // Seed a pick→place op straight from a feeder's pick location (PP2 tie-in): the
  // pick comes from the feeder, the place from the current machine pos / origin.
  function addOpFromFeeder(f: PnpFeeder) {
    const op = defaultPnpOp({
      pickX: f.pickX,
      pickY: f.pickY,
      placeX: connected ? wpos.x : f.pickX,
      placeY: connected ? wpos.y : f.pickY,
    })
    if (f.pickRot) op.rotation = f.pickRot
    setOps((p) => [...p, op])
    setSelected(ops.length)
    setShowLibrary(false)
  }

  // ---- color-coded setting PRESETS (motion / head params only) -------------
  // A preset snapshots the GENERATOR SETTINGS (head + Z heights + feeds + grip +
  // dwell/rotation/decimals) — NOT the pick→place operation list, which is the
  // operator's actual work. Scoped to its own persistence key, independent of
  // the carving / soldering / writing presets.
  const capturePreset = (): PanelParams => ({ ...params })
  // Restore a preset, re-validating the (untrusted) snapshot per-field via the
  // same parser the file-load path uses so a corrupt slot can't feed a NaN to
  // the emitter; missing fields fall back to the current params.
  const applyPreset = (p: PanelParams) => {
    setParams((prev) => parsePnpParams(p, prev))
  }
  const presets = usePresets<PanelParams>({
    storageKey: 'karmyogi.pnp.presets',
    capture: capturePreset,
    onApply: applyPreset,
  })

  // Record the live machine work-position into the selected row's pick or place
  // X/Y. If no row is selected, append a fresh row first.
  function recordInto(which: 'pick' | 'place') {
    if (!connected) return
    let i = selected
    if (i < 0 || i >= ops.length) {
      i = ops.length
      setOps((p) => [...p, defaultPnpOp()])
      setSelected(i)
    }
    const patch: Partial<PnpOp> =
      which === 'pick'
        ? { pickX: wpos.x, pickY: wpos.y }
        : { placeX: wpos.x, placeY: wpos.y }
    updateOp(i, patch)
  }

  // Live G-code preview, recomputed whenever ops/params change.
  const gcode = useMemo(() => generatePickPlace(ops, { ...params }), [ops, params])
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])
  // With NO ops the generator still emits a preamble/footer-only program, but
  // the store sync below pushes '' (nothing for the Visualizer) — so every
  // user-facing count reports 0 lines until there is at least one operation.
  const effectiveLines = ops.length === 0 ? 0 : lineCount

  // Push the freshly-computed program into the store (debounced) so the
  // Visualizer updates without a manual Generate step. While a job is streaming
  // we skip the sync entirely so a fresh push can't reset the running stream
  // (setProgram forces streaming:false / cursor:-1). When ops are emptied, clear
  // the section so no stale pick-place toolpath lingers in the Visualizer.
  useEffect(() => {
    if (streaming) return
    if (ops.length === 0) {
      setProgram('pick-place', '')
      return
    }
    const id = window.setTimeout(() => setProgram('pick-place', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, ops.length, setProgram, streaming])

  // ---- Save / Load document ------------------------------------------------
  const doc: PnpDoc = { kind: 'karmyogi.pnp', version: 1, ops, params }

  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('pnp.load.bad', 'Could not load — not a valid pick & place file.'))
      return
    }
    // Decimals from the loaded params (if any) drive coordinate clamping; fall
    // back to the current setting.
    const nextParams = parsePnpParams(data.params, params)
    if (Array.isArray(data.ops)) {
      const next: PnpOp[] = []
      for (const raw of data.ops) {
        const op = parseOp(raw, nextParams.decimals)
        if (op) next.push(op)
      }
      setOps(next)
      setSelected(-1)
    }
    setParams(nextParams)
    setLoadError('')
  }

  /** Machine-Y (up) → SVG-Y (down). */
  const sy = useCallback((y: number) => bedH - y, [bedH])

  const hasSelection = selected >= 0 && selected < ops.length

  // --- out-of-range / unsafe-Z warnings -------------------------------------
  // Ops whose pick OR place point falls outside the bed rectangle.
  const outOfBoundsOps = useMemo(
    () =>
      ops
        .map((op, i) =>
          inBed(op.pickX, op.pickY, bedW, bedH) && inBed(op.placeX, op.placeY, bedW, bedH)
            ? -1
            : i,
        )
        .filter((i) => i >= 0),
    [ops, bedW, bedH],
  )
  // Travel (safe) Z must clear both the pick and place down-heights, or the head
  // would drag the part across the bed at or below pickup height.
  const travelZUnsafe = params.travelZ <= params.pickZ || params.travelZ <= params.placeZ

  // The rotation column only appears when rotation is emitted as a real A-axis
  // word; the empty-state cell spans whatever columns are visible.
  const tableCols = params.rotaryAxis ? 7 : 6

  // Tooltip body for the Set pick / Set place toolbar buttons: explains exactly
  // what will happen given the connection + selection state.
  const setBody = (which: 'pick' | 'place'): string => {
    if (!connected) return t('pnp.set.title.off', 'Connect to set from machine')
    if (hasSelection) {
      return which === 'pick'
        ? t('pnp.setPick.title.on', 'Fill the selected op pick X/Y from the live machine position')
        : t('pnp.setPlace.title.on', 'Fill the selected op place X/Y from the live machine position')
    }
    return which === 'pick'
      ? t('pnp.setPick.body.append', 'Add a new op and fill its pick X/Y from the live machine position.')
      : t('pnp.setPlace.body.append', 'Add a new op and fill its place X/Y from the live machine position.')
  }

  // ── Gamepad command bus: teach (record pick pos) / navigate / delete ops. ──
  const stepSel = (dir: -1 | 1) => {
    if (ops.length === 0) return
    const base = selected < 0 ? (dir === 1 ? -1 : 0) : selected
    setSelected((base + dir + ops.length) % ops.length)
  }
  useTabCommands('pnp', {
    addPoint: () => recordInto('pick'),
    nextPoint: () => stepSel(1),
    prevPoint: () => stepSel(-1),
    deletePoint: () => {
      if (selected >= 0 && selected < ops.length) deleteRow(selected)
    },
  })

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('pnp.presets.aria', 'Pick & Place setting presets')}
      />
    <div className="pp-panel">
      <div className="pp-scroll">
        {/* Slim header: compact icon toolbar only (the dock tab carries the
            panel name + explainer tooltip now). */}
        <header className="pp-head">
          <div className="pp-tools">
            <ToolButton
              className="pp-ico-primary"
              glyph={<Icon name="add" />}
              onClick={addRow}
              title={t('pnp.addOp', 'Add op')}
              body={t('pnp.toolbar.add.body', 'Append a pick→place operation to the table.')}
            />
            <span className="pp-tools-sep" aria-hidden="true" />
            {/* Ops FILE save/load (.kpnp = operations + params); distinct from the
                settings-only (.kpnpset) pair in the preset save bar below. */}
            <SaveLoadButtons
              value={doc}
              onLoad={loadDoc}
              onError={setLoadError}
              fileBase="karmyogi-pick-place"
              ext="kpnp"
              saveDisabled={ops.length === 0}
              saveTitle={t('pnp.save', 'Save operations + params')}
              loadTitle={t('pnp.load', 'Load operations + params')}
            />
            <span className="pp-tools-sep" aria-hidden="true" />
            <ToolButton
              className="pp-ico-pick"
              glyph={<Crosshair size={16} />}
              onClick={() => recordInto('pick')}
              disabled={!connected}
              title={
                hasSelection
                  ? t('pnp.setPick.short.sel', 'Set pick #{n}', { n: selected + 1 })
                  : t('pnp.setPick.short', 'Set pick')
              }
              body={setBody('pick')}
            />
            <ToolButton
              className="pp-ico-place"
              glyph={<MapPin size={16} />}
              onClick={() => recordInto('place')}
              disabled={!connected}
              title={
                hasSelection
                  ? t('pnp.setPlace.short.sel', 'Set place #{n}', { n: selected + 1 })
                  : t('pnp.setPlace.short', 'Set place')
              }
              body={setBody('place')}
            />
            <span className="pp-tools-sep" aria-hidden="true" />
            <ToolButton
              glyph={<Grip size={16} />}
              onClick={() => setShowLibrary(true)}
              title={t('pnp.library', 'Library')}
              body={t('pnp.library.body', 'Parts, feeders and nozzle tips. Add an op straight from a feeder pick location.')}
            />
            <ToolButton
              glyph={<Icon name="duplicate" />}
              onClick={() => setShowPanel(true)}
              disabled={ops.length === 0}
              title={t('pnp.panelize', 'Panelize')}
              body={t('pnp.panelize.body', 'Array the whole op set across a rows × cols panel of identical boards (PP7).')}
            />
            <ToolButton
              glyph={<Settings size={16} />}
              onClick={() => setShowSettings(true)}
              title={t('pnp.settings', 'Settings')}
              body={t(
                'pnp.settings.body',
                'Motion, head strength, dwell, rotation and decimal settings for the generated program.',
              )}
            />
            {/* Destructive Clear sits LAST, isolated behind its own separator, so
                it never sits next to a benign action (W-H / §2.3). */}
            <span className="pp-tools-sep" aria-hidden="true" />
            <ToolButton
              className="pp-ico-danger"
              glyph={<Icon name="trash" />}
              onClick={clearOps}
              disabled={ops.length === 0}
              title={t('pnp.clear', 'Clear')}
              body={t('pnp.toolbar.clear.body', 'Remove every operation and start over.')}
            />
          </div>
        </header>

        {/* Live status strip: op/line counts · connection · program sync.
            Uses the shared <CamStatus> kit so it reads identically to every tab. */}
        <div className="pp-status">
          <CamStatus
            items={[
              {
                value: ops.length,
                unit: ops.length === 1 ? t('pnp.status.op', 'op') : t('pnp.status.ops', 'ops'),
              },
              { value: effectiveLines, unit: t('pnp.status.lines', 'lines') },
              connected
                ? {
                    label: t('pnp.status.wpos', 'WPos'),
                    value: `${wpos.x.toFixed(2)}, ${wpos.y.toFixed(2)}`,
                    title: t('pnp.status.wpos.title', 'Live machine work position (X, Y)'),
                  }
                : {
                    value: (
                      <span className="pp-status-warn">
                        {t('pnp.status.notConnected', 'Not connected')}
                      </span>
                    ),
                    title: t(
                      'pnp.status.conn.title',
                      'Connect to a machine to set positions and send',
                    ),
                  },
            ]}
          />
        </div>

        {loadError && (
          <p className="pp-warnbox" role="alert">
            <Icon name="warning" size={14} />
            <span>{loadError}</span>
          </p>
        )}

        {/* Cards tile into a responsive grid: wide cards (ops table, bed
            preview, send bar) span all columns; the motion + advanced param
            cards tile beside each other at wide widths and collapse to one
            column when the panel is narrow. */}
        <div className="pp-cards">

        {/* --- Head + operations --------------------------------------- */}
        <section className="pp-card pp-card-wide">
          <h3>
            <span className="cam-card-ico" aria-hidden="true">
              <Crosshair size={15} />
            </span>
            {t('pnp.ops.title', 'Operations')}
          </h3>
          <div className="pp-card-body">
            <div className="pp-headrow">
              <span className="pp-headsel-lbl">{t('pnp.head.label', 'Head')}</span>
              {/* Canonical segmented control (§2.8/W-C): a head-type MODE switch →
                  tonal. The optional leading glyph is muted (inherits text color). */}
              <SegControl<'vacuum' | 'gripper'>
                options={[
                  {
                    value: 'vacuum',
                    title: t('pnp.head.opt.vacuum', 'Vacuum suction cup'),
                    label: (
                      <>
                        <span className="pnp-seg-ico" aria-hidden="true"><Wind size={15} /></span>
                        <span className="pnp-seg-lbl">{t('pnp.head.opt.vacuum', 'Vacuum suction cup')}</span>
                      </>
                    ),
                  },
                  {
                    value: 'gripper',
                    title: t('pnp.head.opt.gripper', 'Gripper'),
                    label: (
                      <>
                        <span className="pnp-seg-ico" aria-hidden="true"><Grip size={15} /></span>
                        <span className="pnp-seg-lbl">{t('pnp.head.opt.gripper', 'Gripper')}</span>
                      </>
                    ),
                  },
                ]}
                value={params.headType}
                onChange={(v) => setParam('headType', v)}
                ariaLabel={t('pnp.head.select.title', 'What is mounted at the head')}
                variant="tonal"
                size="sm"
                className="pnp-seg"
              />
            </div>

            <div className="pp-table-wrap">
              <table className="pp-table">
                <thead>
                  <tr>
                    <th className="pp-idx">#</th>
                    <th>{t('pnp.col.pickX', 'Pick X')}</th>
                    <th>{t('pnp.col.pickY', 'Pick Y')}</th>
                    <th>{t('pnp.col.placeX', 'Place X')}</th>
                    <th>{t('pnp.col.placeY', 'Place Y')}</th>
                    {params.rotaryAxis && <th>{t('pnp.col.rot', 'Rot°')}</th>}
                    <th className="pp-actions-col" />
                  </tr>
                </thead>
                <tbody>
                  {ops.length === 0 && (
                    <tr>
                      <td colSpan={tableCols} className="pp-empty">
                        <CamEmpty
                          icon={<MapPin size={20} />}
                          title={t('pnp.ops.empty.title', 'No operations yet')}
                          hint={t(
                            'pnp.ops.empty.hint',
                            'Add a pick→place operation, or use ⌖ to set pick/place from the live machine position.',
                          )}
                          action={
                            <button className="cam-primary pp-empty-add" onClick={addRow}>
                              <Icon name="add" size={14} /> {t('pnp.addOp', 'Add op')}
                            </button>
                          }
                        />
                      </td>
                    </tr>
                  )}
                  {ops.map((op, i) => {
                    // Per-coordinate range checks so the offending inputs (not
                    // just the row) get the warning tint.
                    const badPX = op.pickX < 0 || op.pickX > bedW
                    const badPY = op.pickY < 0 || op.pickY > bedH
                    const badQX = op.placeX < 0 || op.placeX > bedW
                    const badQY = op.placeY < 0 || op.placeY > bedH
                    const oob = badPX || badPY || badQX || badQY
                    return (
                    <tr
                      key={op.id ?? i}
                      className={
                        [i === selected ? 'pp-row-selected' : '', oob ? 'pp-row-oob' : '']
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      onClick={() => setSelected(i)}
                    >
                      <td className="pp-idx">
                        <span className="pp-idx-label">{t('pnp.idx.label', 'Op')}</span> {i + 1}
                      </td>
                      <td data-label={t('pnp.col.pickX', 'Pick X')}>
                        <NumField
                          step="0.1"
                          aria-label={t('pnp.col.pickX', 'Pick X')}
                          aria-invalid={badPX || undefined}
                          className={badPX ? 'pp-num-warn' : undefined}
                          value={op.pickX}
                          commit={(raw) => updateOp(i, { pickX: num(raw, op.pickX) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.pickY', 'Pick Y')}>
                        <NumField
                          step="0.1"
                          aria-label={t('pnp.col.pickY', 'Pick Y')}
                          aria-invalid={badPY || undefined}
                          className={badPY ? 'pp-num-warn' : undefined}
                          value={op.pickY}
                          commit={(raw) => updateOp(i, { pickY: num(raw, op.pickY) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.placeX', 'Place X')}>
                        <NumField
                          step="0.1"
                          aria-label={t('pnp.col.placeX', 'Place X')}
                          aria-invalid={badQX || undefined}
                          className={badQX ? 'pp-num-warn' : undefined}
                          value={op.placeX}
                          commit={(raw) => updateOp(i, { placeX: num(raw, op.placeX) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.placeY', 'Place Y')}>
                        <NumField
                          step="0.1"
                          aria-label={t('pnp.col.placeY', 'Place Y')}
                          aria-invalid={badQY || undefined}
                          className={badQY ? 'pp-num-warn' : undefined}
                          value={op.placeY}
                          commit={(raw) => updateOp(i, { placeY: num(raw, op.placeY) })}
                        />
                      </td>
                      {params.rotaryAxis && (
                        <td data-label={t('pnp.col.rot', 'Rot°')}>
                          <NumField
                            step="5"
                            aria-label={t('pnp.col.rotation', 'Rotation°')}
                            value={op.rotation ?? 0}
                            commit={(raw) => updateOp(i, { rotation: num(raw, op.rotation ?? 0) })}
                          />
                        </td>
                      )}
                      <td className="pp-actions">
                        <IconButton
                          className="pp-row-btn"
                          icon={<Icon name="chevron-down" size={16} className="pp-flip-y" />}
                          label={t('pnp.row.up', 'Move up')}
                          onClick={(e) => { e.stopPropagation(); moveRow(i, -1) }}
                          disabled={i === 0}
                        />
                        <IconButton
                          className="pp-row-btn"
                          iconName="chevron-down"
                          label={t('pnp.row.down', 'Move down')}
                          onClick={(e) => { e.stopPropagation(); moveRow(i, 1) }}
                          disabled={i === ops.length - 1}
                        />
                        <IconButton
                          className="pp-row-btn"
                          iconName="duplicate"
                          label={t('pnp.row.duplicate', 'Duplicate op')}
                          onClick={(e) => { e.stopPropagation(); duplicateRow(i) }}
                        />
                        <IconButton
                          className="pp-row-btn pp-del"
                          iconName="trash"
                          label={t('pnp.row.delete', 'Delete op')}
                          onClick={(e) => { e.stopPropagation(); deleteRow(i) }}
                        />
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {outOfBoundsOps.length > 0 && (
              <p className="pp-warnbox" role="alert">
                <Icon name="warning" size={14} />
                <span>
                  {t(
                    'pnp.warn.outOfBounds',
                    'Op {ops} outside the {w}×{h} mm bed — it will be clipped or hit a limit.',
                    {
                      ops: outOfBoundsOps.map((i) => i + 1).join(', '),
                      w: bedW,
                      h: bedH,
                    },
                  )}
                </span>
              </p>
            )}
          </div>
        </section>

        {/* --- 2D bed preview ------------------------------------------ */}
        {ops.length > 0 && (
          <section className="pp-card pp-card-wide">
            <h3>
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name="frame" size={15} />
              </span>
              {t('pnp.preview.title', 'Bed preview')}
            </h3>
            <div className="pp-card-body pp-preview2d-body">
              <svg
                className="pp-preview2d"
                viewBox={`${-PAD} ${-PAD} ${bedW + PAD * 2} ${bedH + PAD * 2}`}
                preserveAspectRatio="xMidYMid meet"
              >
                <defs>
                  <marker
                    id="pp-arrow"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L10,5 L0,10 z" className="pp-arrow-head" />
                  </marker>
                </defs>
                <rect className="pp-bed" x={0} y={0} width={bedW} height={bedH} />
                {Array.from({ length: Math.floor(bedW / 20) + 1 }, (_, i) => i * 20).map((gx) => (
                  <line key={`vx${gx}`} className="pp-grid" x1={gx} y1={0} x2={gx} y2={bedH} />
                ))}
                {Array.from({ length: Math.floor(bedH / 20) + 1 }, (_, i) => i * 20).map((gy) => (
                  <line key={`hy${gy}`} className="pp-grid" x1={0} y1={sy(gy)} x2={bedW} y2={sy(gy)} />
                ))}
                <circle className="pp-origin" cx={0} cy={sy(0)} r={2.5} />
                {ops.map((op, i) => {
                  const px = op.pickX
                  const py = sy(op.pickY)
                  const qx = op.placeX
                  const qy = sy(op.placeY)
                  const sel = i === selected
                  const oob = !inBed(op.pickX, op.pickY, bedW, bedH) || !inBed(op.placeX, op.placeY, bedW, bedH)
                  const cls = ['pp-op', sel ? 'pp-op-sel' : '', oob ? 'pp-op-oob' : '']
                    .filter(Boolean)
                    .join(' ')
                  const tri = `${qx},${qy - 4} ${qx - 4},${qy + 3} ${qx + 4},${qy + 3}`
                  return (
                    <g key={op.id ?? i} className={cls} onClick={() => setSelected(i)}>
                      <line className="pp-move" x1={px} y1={py} x2={qx} y2={qy} markerEnd="url(#pp-arrow)" />
                      <circle className="pp-pick" cx={px} cy={py} r={3} />
                      <polygon className="pp-place" points={tri} />
                    </g>
                  )
                })}
              </svg>
              {/* Legend: swatches drawn with the same SVG classes the preview
                  uses, so they always match the live styles. */}
              <div className="pp-legend">
                <span className="pp-legend-item">
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                    <circle className="pp-pick" cx="7" cy="7" r="4" />
                  </svg>
                  {t('pnp.legend.pick', 'pick')}
                </span>
                <span className="pp-legend-item">
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                    <polygon className="pp-place" points="7,2.5 2.5,11.5 11.5,11.5" />
                  </svg>
                  {t('pnp.legend.place', 'place')}
                </span>
                <span className="pp-legend-item">
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                    <line className="pp-move" x1="1" y1="7" x2="13" y2="7" />
                  </svg>
                  {t('pnp.legend.travel', 'travel')}
                </span>
                <span className="pp-legend-item">
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                    <circle className="pp-legend-oob" cx="7" cy="7" r="4" />
                  </svg>
                  {t('pnp.legend.oob', 'outside bed')}
                </span>
                <span className="pp-legend-size">
                  {t('pnp.preview.size', 'Bed {w} × {h} mm', { w: bedW, h: bedH })}
                </span>
              </div>
            </div>
          </section>
        )}

        </div>
      </div>
    </div>

      {/* PP7 — panelization modal. */}
      <Modal open={showPanel} title={t('pnp.panelize', 'Panelize')} onClose={() => setShowPanel(false)}>
        <p className="pp-hint">
          {t('pnp.panelize.intro', 'Repeat the {n}-op board across a rows × cols panel. Place points step per board; pick points stay on the feeders.', { n: ops.length })}
        </p>
        <div className="pnp-sgrid">
          <SliderField icon={<Hash size={15} />} label={t('pnp.panel.rows', 'Rows')} min={1} max={20} step={1}
            value={panRows} onChange={(n) => setPanRows(Math.max(1, Math.floor(n)))} />
          <SliderField icon={<Hash size={15} />} label={t('pnp.panel.cols', 'Cols')} min={1} max={20} step={1}
            value={panCols} onChange={(n) => setPanCols(Math.max(1, Math.floor(n)))} />
          <SliderField icon={<ArrowUpToLine size={15} />} label={t('pnp.panel.spX', 'Pitch X')} unit={t('unit.mm', 'mm')} min={0} max={Math.max(bedW, 400)} step={1}
            value={panSpX} onChange={(n) => setPanSpX(n)} />
          <SliderField icon={<ArrowUpToLine size={15} />} label={t('pnp.panel.spY', 'Pitch Y')} unit={t('unit.mm', 'mm')} min={0} max={Math.max(bedH, 400)} step={1}
            value={panSpY} onChange={(n) => setPanSpY(n)} />
        </div>
        <p className="pp-hint">
          {t('pnp.panel.result', '→ {n} operations', { n: ops.length * Math.max(1, Math.floor(panRows)) * Math.max(1, Math.floor(panCols)) })}
        </p>
        <div className="pp-modal-foot">
          <button type="button" className="pp-modal-cancel" onClick={() => setShowPanel(false)}>
            {t('pnp.panel.cancel', 'Cancel')}
          </button>
          <button type="button" className="cam-primary" onClick={applyPanelize}>
            {t('pnp.panel.apply', 'Panelize')}
          </button>
        </div>
      </Modal>

      {/* PP1/PP2/PP5 — parts / feeders / nozzle-tip library. */}
      <Modal open={showLibrary} title={t('pnp.library', 'Library')} onClose={() => setShowLibrary(false)} width={620}>
        <div className="pp-lib">
          {/* Feeders */}
          <section className="pp-lib-sec">
            <div className="pp-lib-head">
              <h4>{t('pnp.lib.feeders', 'Feeders')}</h4>
              <button type="button" className="cam-primary pp-lib-add" onClick={() => setFeeders((f) => [...f, defaultFeeder()])}>
                <Icon name="add" size={13} /> {t('pnp.lib.addFeeder', 'Add feeder')}
              </button>
            </div>
            {feeders.length === 0 && <p className="pp-hint">{t('pnp.lib.noFeeders', 'No feeders yet. Add a tape / tube / tray feeder with a pick location.')}</p>}
            {feeders.map((f, i) => (
              <div className="pp-lib-row" key={f.id}>
                <input className="pp-lib-name" value={f.name} aria-label={t('pnp.lib.name', 'Name')}
                  onChange={(e) => setFeeders((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <SegControl<PnpFeeder['type']>
                  options={[
                    { value: 'tape', label: t('pnp.lib.tape', 'Tape') },
                    { value: 'tube', label: t('pnp.lib.tube', 'Tube') },
                    { value: 'tray', label: t('pnp.lib.tray', 'Tray') },
                  ]}
                  value={f.type}
                  onChange={(v) => setFeeders((arr) => arr.map((x, j) => (j === i ? { ...x, type: v } : x)))}
                  ariaLabel={t('pnp.lib.feederType', 'Feeder type')}
                  variant="tonal" size="sm"
                />
                <label className="pp-lib-mini"><span>{t('pnp.col.pickX', 'Pick X')}</span>
                  <input type="number" step="0.1" value={f.pickX}
                    onChange={(e) => setFeeders((arr) => arr.map((x, j) => (j === i ? { ...x, pickX: num(e.target.value, x.pickX) } : x)))} /></label>
                <label className="pp-lib-mini"><span>{t('pnp.col.pickY', 'Pick Y')}</span>
                  <input type="number" step="0.1" value={f.pickY}
                    onChange={(e) => setFeeders((arr) => arr.map((x, j) => (j === i ? { ...x, pickY: num(e.target.value, x.pickY) } : x)))} /></label>
                <label className="pp-lib-mini"><span>{t('pnp.lib.rot', 'Rot°')}</span>
                  <input type="number" step="5" value={f.pickRot}
                    onChange={(e) => setFeeders((arr) => arr.map((x, j) => (j === i ? { ...x, pickRot: num(e.target.value, x.pickRot) } : x)))} /></label>
                {f.type === 'tape' && (
                  <label className="pp-lib-mini"><span>{t('pnp.lib.pitch', 'Pitch')}</span>
                    <input type="number" step="1" value={f.tapePitch}
                      onChange={(e) => setFeeders((arr) => arr.map((x, j) => (j === i ? { ...x, tapePitch: num(e.target.value, x.tapePitch) } : x)))} /></label>
                )}
                <label className="pp-lib-mini"><span>{t('pnp.lib.count', 'Count')}</span>
                  <input type="number" step="1" value={f.count}
                    onChange={(e) => setFeeders((arr) => arr.map((x, j) => (j === i ? { ...x, count: num(e.target.value, x.count) } : x)))} /></label>
                <button type="button" className="pp-lib-use" onClick={() => addOpFromFeeder(f)} title={t('pnp.lib.use', 'Add op from this feeder')}>
                  <Crosshair size={14} />
                </button>
                <button type="button" className="pp-lib-del" onClick={() => setFeeders((arr) => arr.filter((_, j) => j !== i))} aria-label={t('pnp.row.delete', 'Delete')}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </section>

          {/* Nozzle tips */}
          <section className="pp-lib-sec">
            <div className="pp-lib-head">
              <h4>{t('pnp.lib.nozzles', 'Nozzle tips')}</h4>
              <button type="button" className="cam-primary pp-lib-add" onClick={() => setNozzles((n) => [...n, defaultNozzleTip()])}>
                <Icon name="add" size={13} /> {t('pnp.lib.addNozzle', 'Add nozzle')}
              </button>
            </div>
            {nozzles.length === 0 && <p className="pp-hint">{t('pnp.lib.noNozzles', 'No nozzle tips yet. Add a tip with its ⌀ and calibration offset.')}</p>}
            {nozzles.map((nz, i) => (
              <div className="pp-lib-row" key={nz.id}>
                <input className="pp-lib-name" value={nz.name} aria-label={t('pnp.lib.name', 'Name')}
                  onChange={(e) => setNozzles((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <label className="pp-lib-mini"><span>{t('pnp.lib.dia', '⌀')}</span>
                  <input type="number" step="0.1" value={nz.diameter}
                    onChange={(e) => setNozzles((arr) => arr.map((x, j) => (j === i ? { ...x, diameter: num(e.target.value, x.diameter) } : x)))} /></label>
                <label className="pp-lib-mini"><span>{t('pnp.lib.offX', 'Off X')}</span>
                  <input type="number" step="0.05" value={nz.offsetX}
                    onChange={(e) => setNozzles((arr) => arr.map((x, j) => (j === i ? { ...x, offsetX: num(e.target.value, x.offsetX) } : x)))} /></label>
                <label className="pp-lib-mini"><span>{t('pnp.lib.offY', 'Off Y')}</span>
                  <input type="number" step="0.05" value={nz.offsetY}
                    onChange={(e) => setNozzles((arr) => arr.map((x, j) => (j === i ? { ...x, offsetY: num(e.target.value, x.offsetY) } : x)))} /></label>
                <label className="pp-lib-mini"><span>{t('pnp.lib.offZ', 'Off Z')}</span>
                  <input type="number" step="0.05" value={nz.offsetZ}
                    onChange={(e) => setNozzles((arr) => arr.map((x, j) => (j === i ? { ...x, offsetZ: num(e.target.value, x.offsetZ) } : x)))} /></label>
                <button type="button" className="pp-lib-del" onClick={() => setNozzles((arr) => arr.filter((_, j) => j !== i))} aria-label={t('pnp.row.delete', 'Delete')}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </section>

          {/* Parts */}
          <section className="pp-lib-sec">
            <div className="pp-lib-head">
              <h4>{t('pnp.lib.parts', 'Parts')}</h4>
              <button type="button" className="cam-primary pp-lib-add" onClick={() => setParts((p) => [...p, defaultPart()])}>
                <Icon name="add" size={13} /> {t('pnp.lib.addPart', 'Add part')}
              </button>
            </div>
            {parts.length === 0 && <p className="pp-hint">{t('pnp.lib.noParts', 'No parts yet. Add a component value / package.')}</p>}
            {parts.map((pt, i) => (
              <div className="pp-lib-row" key={pt.id}>
                <input className="pp-lib-name" value={pt.name} aria-label={t('pnp.lib.name', 'Name')}
                  onChange={(e) => setParts((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="pp-lib-name" value={pt.value ?? ''} placeholder={t('pnp.lib.value', 'value')} aria-label={t('pnp.lib.value', 'value')}
                  onChange={(e) => setParts((arr) => arr.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <button type="button" className="pp-lib-del" onClick={() => setParts((arr) => arr.filter((_, j) => j !== i))} aria-label={t('pnp.row.delete', 'Delete')}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </section>

          {/* PP3/PP4 — vision scaffold (camera homography lives in cameraCalib.ts). */}
          <section className="pp-lib-sec">
            <h4>{t('pnp.lib.vision', 'Vision (top / bottom)')}</h4>
            <p className="pp-hint">
              {t('pnp.lib.visionTodo', 'Top fiducial alignment and bottom part-centering use the shared camera calibration. TODO: wire the fiducial-capture affine + nozzle-centering offset once the camera pipeline is connected to this panel.')}
            </p>
          </section>
        </div>
      </Modal>

      {/* Settings modal: the Motion & {action} params plus the Advanced
          (dwell / rotation / decimals) params, surfaced from the gear toolbar
          button so the main view shows only Operations + Bed preview. */}
      <Modal
        open={showSettings}
        title={t('pnp.settings', 'Settings')}
        onClose={() => setShowSettings(false)}
      >
        <div className="pp-settings">
          <section className="pp-settings-group">
            <h4>{t('pnp.motion.title', 'Motion & {action}', { action: labels.on.toLowerCase() })}</h4>
            <div className="pnp-sgrid">
              <SliderField
                icon={<ArrowUpToLine size={15} />}
                label={t('pnp.f.travelZ', 'Travel Z')}
                unit={t('unit.mm', 'mm')}
                warn={travelZUnsafe}
                min={0}
                max={60}
                step={0.1}
                value={params.travelZ}
                onChange={(n) => setParam('travelZ', n)}
                info={{
                  title: t('pnp.f.travelZ', 'Travel Z'),
                  body: t('pnp.field.travelZ.title', 'Safe clearance height for all XY travel'),
                }}
              />
              <SliderField
                icon={<ArrowDownToLine size={15} />}
                label={t('pnp.f.pickZ', 'Pick Z')}
                unit={t('unit.mm', 'mm')}
                min={-20}
                max={40}
                step={0.1}
                value={params.pickZ}
                onChange={(n) => setParam('pickZ', n)}
                info={{
                  title: t('pnp.f.pickZ', 'Pick Z'),
                  body: t('pnp.field.pickZ.title', 'Height the head lowers to when picking up the part'),
                }}
              />
              <SliderField
                icon={<MapPin size={15} />}
                label={t('pnp.f.placeZ', 'Place Z')}
                unit={t('unit.mm', 'mm')}
                min={-20}
                max={40}
                step={0.1}
                value={params.placeZ}
                onChange={(n) => setParam('placeZ', n)}
                info={{
                  title: t('pnp.f.placeZ', 'Place Z'),
                  body: t('pnp.field.placeZ.title', 'Height the head lowers to when placing the part down'),
                }}
              />
              <SliderField
                icon={<Gauge size={15} />}
                label={t('pnp.f.feedXY', 'Feed XY')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={0}
                max={5000}
                step={50}
                value={params.feedXY}
                onChange={(n) => setParam('feedXY', Math.max(0, n))}
                info={{
                  title: t('pnp.f.feedXY', 'Feed XY'),
                  body: t('pnp.field.feedXY.title', 'Travel speed for XY moves'),
                }}
              />
              <SliderField
                icon={<FastForward size={15} />}
                label={t('pnp.f.feedZ', 'Feed Z')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={0}
                max={2000}
                step={10}
                value={params.feedZ}
                onChange={(n) => setParam('feedZ', Math.max(0, n))}
                info={{
                  title: t('pnp.f.feedZ', 'Feed Z'),
                  body: t('pnp.field.feedZ.title', 'Plunge speed when lowering to pick/place height'),
                }}
              />
              <SliderField
                icon={params.headType === 'gripper' ? <Grip size={15} /> : <Wind size={15} />}
                label={t('pnp.f.strength', '{action} strength', { action: labels.on })}
                unit={t('unit.sWord', 'S')}
                min={0}
                max={2000}
                step={50}
                value={params.gripRpm}
                onChange={(n) => setParam('gripRpm', Math.max(0, n))}
                info={{
                  title: t('pnp.f.strength', '{action} strength', { action: labels.on }),
                  body: t('pnp.field.strength.title', 'Spindle S value = vacuum / grip strength (M3 S…)'),
                }}
              />
            </div>

            {travelZUnsafe && (
              <p className="pp-warnbox" role="alert">
                <Icon name="warning" size={14} />
                <span>
                  {t(
                    'pnp.warn.travelZ',
                    'Travel Z ({tz}) is not above the pick/place Z — the head may drag the part across the bed.',
                    { tz: params.travelZ },
                  )}
                </span>
              </p>
            )}
          </section>

          <section className="pp-settings-group">
            <h4>{t('pnp.advanced', 'Advanced')}</h4>
            <div className="pnp-sgrid">
                <SliderField
                  icon={<Timer size={15} />}
                  label={t('pnp.f.pickDwell', 'Pick dwell')}
                  unit={t('unit.ms', 'ms')}
                  min={0}
                  max={2000}
                  step={50}
                  value={params.pickDwellMs}
                  onChange={(n) => setParam('pickDwellMs', Math.max(0, n))}
                  info={{
                    title: t('pnp.f.pickDwell', 'Pick dwell'),
                    body: t('pnp.field.pickDwell.title', 'Pause after gripping so the grip is secure (0 = none)'),
                  }}
                />
                <SliderField
                  icon={<Timer size={15} />}
                  label={t('pnp.f.placeDwell', 'Place dwell')}
                  unit={t('unit.ms', 'ms')}
                  min={0}
                  max={2000}
                  step={50}
                  value={params.placeDwellMs}
                  onChange={(n) => setParam('placeDwellMs', Math.max(0, n))}
                  info={{
                    title: t('pnp.f.placeDwell', 'Place dwell'),
                    body: t('pnp.field.placeDwell.title', 'Pause after releasing so the part settles (0 = none)'),
                  }}
                />
                <SliderField
                  icon={<Hash size={15} />}
                  label={t('pnp.f.decimals', 'Decimals')}
                  min={0}
                  max={6}
                  step={1}
                  value={params.decimals}
                  onChange={(n) =>
                    setParam('decimals', Math.max(0, Math.min(6, Math.round(n))))
                  }
                  info={{
                    title: t('pnp.f.decimals', 'Decimals'),
                    body: t('pnp.field.decimals.title', 'Decimal places used in emitted coordinates'),
                  }}
                />
              </div>

              <div className="pp-rotrow">
                <span className="pnp-seg-rowlbl">
                  <RotateCw size={14} aria-hidden="true" />
                  {t('pnp.rotaryAxis.label', 'Part rotation (A-axis)')}
                </span>
                {/* Canonical segmented control (§2.8/W-C): a bool MODE switch → tonal. */}
                <SegControl<'off' | 'on'>
                  options={[
                    { value: 'off', label: t('pnp.rotaryAxis.off', 'Off') },
                    {
                      value: 'on',
                      label: t('pnp.rotaryAxis.on', 'Emit A°'),
                      title: t('pnp.rotaryAxis', 'Emit part rotation as a real A-axis word (G0 A…)'),
                    },
                  ]}
                  value={params.rotaryAxis ? 'on' : 'off'}
                  onChange={(v) => setParam('rotaryAxis', v === 'on')}
                  ariaLabel={t('pnp.rotaryAxis', 'Emit part rotation as a real A-axis word (G0 A…)')}
                  variant="tonal"
                  size="sm"
                  className="pnp-seg pnp-seg-bool"
                />
              </div>
              <p className="pp-hint">
                {t('pnp.rot.note', 'Rotation is edited per-op in the Operations table.')}
              </p>

              {/* PP6 — vacuum part-present sensing + blow-off. */}
              <div className="pp-rotrow">
                <span className="pnp-seg-rowlbl">
                  <Crosshair size={14} aria-hidden="true" />
                  {t('pnp.partPresent.label', 'Part-present check')}
                  <InfoTip
                    topic="pnpField"
                    title={t('pnp.partPresent.label', 'Part-present check')}
                    body={t('pnp.partPresent.body', 'After picking, probe (G38.4) expecting no contact to confirm a part is held on the nozzle. The controller halts if the part is missing. Needs a probe / vacuum-sense input.')}
                  />
                </span>
                <SegControl<'off' | 'on'>
                  options={[
                    { value: 'off', label: t('pnp.off', 'Off') },
                    { value: 'on', label: t('pnp.on', 'On') },
                  ]}
                  value={params.partPresentCheck ? 'on' : 'off'}
                  onChange={(v) => setParam('partPresentCheck', v === 'on')}
                  ariaLabel={t('pnp.partPresent.label', 'Part-present check')}
                  variant="tonal"
                  size="sm"
                  className="pnp-seg pnp-seg-bool"
                />
              </div>
              {params.headType === 'vacuum' && (
                <div className="pp-rotrow">
                  <span className="pnp-seg-rowlbl">
                    <Wind size={14} aria-hidden="true" />
                    {t('pnp.blowOff.label', 'Blow-off')}
                    <InfoTip
                      topic="pnpField"
                      title={t('pnp.blowOff.label', 'Blow-off')}
                      body={t('pnp.blowOff.body', 'After releasing, pulse positive air (M8 → dwell → M9) so the part does not cling to the nozzle.')}
                    />
                  </span>
                  <SegControl<'off' | 'on'>
                    options={[
                      { value: 'off', label: t('pnp.off', 'Off') },
                      { value: 'on', label: t('pnp.on', 'On') },
                    ]}
                    value={params.blowOff ? 'on' : 'off'}
                    onChange={(v) => setParam('blowOff', v === 'on')}
                    ariaLabel={t('pnp.blowOff.label', 'Blow-off')}
                    variant="tonal"
                    size="sm"
                    className="pnp-seg pnp-seg-bool"
                  />
                </div>
              )}
              {params.blowOff && params.headType === 'vacuum' && (
                <div className="pnp-sgrid">
                  <SliderField
                    icon={<Timer size={15} />}
                    label={t('pnp.f.blowOffMs', 'Blow-off')}
                    unit={t('unit.ms', 'ms')}
                    min={0}
                    max={1000}
                    step={25}
                    value={params.blowOffMs}
                    onChange={(n) => setParam('blowOffMs', Math.max(0, n))}
                    info={{
                      title: t('pnp.f.blowOffMs', 'Blow-off duration'),
                      body: t('pnp.f.blowOffMs.body', 'Positive-air pulse duration after release.'),
                    }}
                  />
                </div>
              )}
          </section>

          {/* PP8 — park + discard locations. */}
          <section className="pp-settings-group">
            <h4>{t('pnp.park.title', 'Park & discard')}</h4>
            <div className="pp-rotrow">
              <span className="pnp-seg-rowlbl">
                <MapPin size={14} aria-hidden="true" />
                {t('pnp.park.atEnd', 'Park at end')}
                <InfoTip
                  topic="pnpField"
                  title={t('pnp.park.atEnd', 'Park at end')}
                  body={t('pnp.park.atEnd.body', 'Move the head to a safe park location after the last placement (at program end).')}
                />
              </span>
              <SegControl<'off' | 'on'>
                options={[
                  { value: 'off', label: t('pnp.off', 'Off') },
                  { value: 'on', label: t('pnp.on', 'On') },
                ]}
                value={params.parkAtEnd ? 'on' : 'off'}
                onChange={(v) => setParam('parkAtEnd', v === 'on')}
                ariaLabel={t('pnp.park.atEnd', 'Park at end')}
                variant="tonal"
                size="sm"
                className="pnp-seg pnp-seg-bool"
              />
            </div>
            <div className="pnp-sgrid">
              <SliderField
                icon={<ArrowUpToLine size={15} />}
                label={t('pnp.f.parkX', 'Park X')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={Math.max(bedW, 400)}
                step={1}
                value={params.parkX}
                onChange={(n) => setParam('parkX', n)}
              />
              <SliderField
                icon={<ArrowUpToLine size={15} />}
                label={t('pnp.f.parkY', 'Park Y')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={Math.max(bedH, 400)}
                step={1}
                value={params.parkY}
                onChange={(n) => setParam('parkY', n)}
              />
              <SliderField
                icon={<MapPin size={15} />}
                label={t('pnp.f.discardX', 'Discard X')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={Math.max(bedW, 400)}
                step={1}
                value={params.discardX}
                onChange={(n) => setParam('discardX', n)}
                info={{
                  title: t('pnp.f.discardX', 'Discard location X'),
                  body: t('pnp.discard.body', 'Where a failed / unrecognised part is dropped (documentary — used by the operator / future reject flow).'),
                }}
              />
              <SliderField
                icon={<MapPin size={15} />}
                label={t('pnp.f.discardY', 'Discard Y')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={Math.max(bedH, 400)}
                step={1}
                value={params.discardY}
                onChange={(n) => setParam('discardY', n)}
              />
            </div>

            <p className="pp-hint">
              {t(
                'pnp.hint',
                'Speed here is the feed rate only. Acceleration is a global machine setting ($120–$122, set in the Motion / Probe panels) and is not written here.',
              )}
            </p>
          </section>
        </div>
      </Modal>
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
            onLoad={(data) => setParams((prev) => parsePnpParams(data, prev))}
            onError={setLoadError}
            fileBase="pnp-settings"
            ext="kpnpset"
            saveTitle={t('pnp.preset.save', 'Save motion / head settings to file')}
            loadTitle={t('pnp.preset.load', 'Load motion / head settings from file')}
          />
        }
      />
    </div>
  )
}
