import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useBed } from '../store/bed'
import { grbl } from '../serial/controller'
import { Icon } from '../components/Icons'
import { IconButton } from '../components/IconButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import {
  defaultPnpOp,
  defaultPnpParams,
  generatePickPlace,
  newPnpOpId,
  type PnpHeadType,
  type PnpOp,
  type PnpParams,
} from '../core/pickPlace'
import '../styles/pickplace.css'

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

/** Whether a point lies inside the bed rectangle [0..w] x [0..h]. */
const inBed = (x: number, y: number, w: number, h: number): boolean =>
  x >= 0 && x <= w && y >= 0 && y <= h

/**
 * Pick & Place panel. The head is a vacuum suction cup / gripper wired to the
 * spindle output (M3 = grip/vacuum ON, M5 = release OFF). An editable table of
 * pick→place operations drives the pure `generatePickPlace` core, which emits a
 * safe program (travel at safe-Z, lower to pick, grip, lift, travel to place,
 * lower, release, lift). "Set pick/place from machine" captures the live work
 * position. Generation is live + debounced into the shared program store so the
 * Visualizer previews the travel/pick/place path; Send streams it to the machine.
 *
 * Layout: a vertical-only scroller whose CARD sections tile into a responsive
 * grid — head + operations table and the bed preview stay full width, while the
 * motion params and the collapsed Advanced section tile beside each other at
 * wide widths (collapsing to one column when the panel is narrow). The Send +
 * raw G-code card spans full width at the foot.
 */
export function PickPlacePanel() {
  const t = useT()
  // Live machine work-position + connection (for "Set from machine").
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
        decimals: d.decimals,
      }
    })(),
  )

  const [selected, setSelected] = useState(-1)
  const [showRaw, setShowRaw] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
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

  // Stream the program to the machine.
  function play() {
    const lines = gcodeLines(gcode)
    if (lines.length === 0 || !connected || streaming) return
    setProgram('pick-place', gcode)
    grbl.startProgram(lines)
  }

  // Abort the active stream (soft reset) — the Send button swaps to this while
  // a program is streaming.
  function stop() {
    grbl.abortProgram()
  }

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

  return (
    <div className="pp-panel">
      <div className="pp-scroll">
        <p className="pp-intro">
          {t('pnp.intro.pre', 'Move parts from a')} <b>{t('pnp.intro.pick', 'pick')}</b>{' '}
          {t('pnp.intro.mid', 'point to a')} <b>{t('pnp.intro.place', 'place')}</b>{' '}
          {t('pnp.intro.head', 'point. The head grabs with the spindle output ({on} on, {off} off). Build the operations below, then', { on: labels.on, off: labels.off })}{' '}
          <b>{t('pnp.intro.send', 'Send')}</b> {t('pnp.intro.tomachine', 'to the machine.')}
        </p>

        {/* Cards tile into a responsive grid: wide cards (ops table, bed
            preview, send bar) span all columns; the motion + advanced param
            cards tile beside each other at wide widths and collapse to one
            column when the panel is narrow. */}
        <div className="pp-cards">

        {/* --- Head + operations --------------------------------------- */}
        <section className="pp-card pp-card-wide">
          <h3>{t('pnp.ops.title', 'Operations')}</h3>
          <div className="pp-card-body">
            <div className="pp-row">
              <label className="pp-head">
                {t('pnp.head.label', 'Head')}
                <select
                  value={params.headType}
                  onChange={(e) => setParam('headType', e.target.value as PnpHeadType)}
                  title={t('pnp.head.select.title', 'What is mounted at the head')}
                >
                  <option value="vacuum">{t('pnp.head.opt.vacuum', 'Vacuum suction cup')}</option>
                  <option value="gripper">{t('pnp.head.opt.gripper', 'Gripper')}</option>
                </select>
              </label>
              <span className="pp-spacer" />
              <span className="pp-meta">
                {ops.length === 1
                  ? t('pnp.ops.count.one', '{n} op', { n: ops.length })
                  : t('pnp.ops.count.many', '{n} ops', { n: ops.length })}
              </span>
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
                    <th className="pp-actions-col" />
                  </tr>
                </thead>
                <tbody>
                  {ops.length === 0 && (
                    <tr>
                      <td colSpan={6} className="pp-empty">
                        {t('pnp.ops.empty', 'No operations yet. Add one below, or set pick/place from the machine position.')}
                      </td>
                    </tr>
                  )}
                  {ops.map((op, i) => {
                    const oob = !inBed(op.pickX, op.pickY, bedW, bedH) || !inBed(op.placeX, op.placeY, bedW, bedH)
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
                          value={op.pickX}
                          commit={(raw) => updateOp(i, { pickX: num(raw, op.pickX) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.pickY', 'Pick Y')}>
                        <NumField
                          step="0.1"
                          aria-label={t('pnp.col.pickY', 'Pick Y')}
                          value={op.pickY}
                          commit={(raw) => updateOp(i, { pickY: num(raw, op.pickY) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.placeX', 'Place X')}>
                        <NumField
                          step="0.1"
                          aria-label={t('pnp.col.placeX', 'Place X')}
                          value={op.placeX}
                          commit={(raw) => updateOp(i, { placeX: num(raw, op.placeX) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.placeY', 'Place Y')}>
                        <NumField
                          step="0.1"
                          aria-label={t('pnp.col.placeY', 'Place Y')}
                          value={op.placeY}
                          commit={(raw) => updateOp(i, { placeY: num(raw, op.placeY) })}
                        />
                      </td>
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

            <div className="pp-row pp-op-tools">
              <button className="primary pp-add" onClick={addRow}>
                <Icon name="add" size={14} /> {t('pnp.addOp', 'Add op')}
              </button>
              <button className="pp-clear" onClick={clearOps} disabled={ops.length === 0}>
                <Icon name="trash" size={14} /> {t('pnp.clear', 'Clear')}
              </button>
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
              <span className="pp-spacer" />
              <button
                className="pp-set"
                onClick={() => recordInto('pick')}
                disabled={!connected}
                title={connected ? t('pnp.setPick.title.on', 'Fill the selected op pick X/Y from the live machine position') : t('pnp.set.title.off', 'Connect to set from machine')}
              >
                <Icon name="zero" size={14} />{' '}
                {hasSelection
                  ? t('pnp.setPick.sel', 'Set pick #{n} from machine', { n: selected + 1 })
                  : t('pnp.setPick', 'Set pick from machine')}
              </button>
              <button
                className="pp-set"
                onClick={() => recordInto('place')}
                disabled={!connected}
                title={connected ? t('pnp.setPlace.title.on', 'Fill the selected op place X/Y from the live machine position') : t('pnp.set.title.off', 'Connect to set from machine')}
              >
                <Icon name="zero" size={14} />{' '}
                {hasSelection
                  ? t('pnp.setPlace.sel', 'Set place #{n} from machine', { n: selected + 1 })
                  : t('pnp.setPlace', 'Set place from machine')}
              </button>
            </div>
            <span className="pp-meta">
              {connected
                ? t('pnp.wpos', 'Live WPos  {x}, {y}', { x: wpos.x.toFixed(2), y: wpos.y.toFixed(2) })
                : t('pnp.notConnected', 'Not connected — set buttons disabled')}
            </span>
            {loadError && <span className="pp-meta pp-load-error">{loadError}</span>}

            {(outOfBoundsOps.length > 0 || travelZUnsafe) && (
              <div className="pp-warnings" role="alert">
                {outOfBoundsOps.length > 0 && (
                  <span className="pp-warning">
                    <Icon name="warning" size={14} />{' '}
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
                )}
                {travelZUnsafe && (
                  <span className="pp-warning">
                    <Icon name="warning" size={14} />{' '}
                    {t(
                      'pnp.warn.travelZ',
                      'Travel Z ({tz}) is not above the pick/place Z — the head may drag the part across the bed.',
                      { tz: params.travelZ },
                    )}
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        {/* --- 2D bed preview ------------------------------------------ */}
        {ops.length > 0 && (
          <section className="pp-card pp-card-wide">
            <h3>{t('pnp.preview.title', 'Bed preview · pick ○ → place △')}</h3>
            <div className="pp-card-body pp-preview2d-body">
              <span className="pp-meta pp-preview-size">
                {t('pnp.preview.size', 'Bed {w} × {h} mm', { w: bedW, h: bedH })}
              </span>
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
            </div>
          </section>
        )}

        {/* --- Motion params (essentials) ------------------------------ */}
        <section className="pp-card">
          <h3>{t('pnp.motion.title', 'Motion & {action}', { action: labels.on.toLowerCase() })}</h3>
          <div className="pp-card-body">
            <div className="pp-grid">
              <label className="pp-field">
                {t('pnp.field.travelZ', 'Travel Z (mm)')}
                <NumField
                  step="0.1"
                  value={params.travelZ}
                  commit={(raw) => setParam('travelZ', num(raw, params.travelZ))}
                  title={t('pnp.field.travelZ.title', 'Safe clearance height for all XY travel')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.pickZ', 'Pick Z (mm)')}
                <NumField
                  step="0.1"
                  value={params.pickZ}
                  commit={(raw) => setParam('pickZ', num(raw, params.pickZ))}
                  title={t('pnp.field.pickZ.title', 'Height the head lowers to when picking up the part')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.placeZ', 'Place Z (mm)')}
                <NumField
                  step="0.1"
                  value={params.placeZ}
                  commit={(raw) => setParam('placeZ', num(raw, params.placeZ))}
                  title={t('pnp.field.placeZ.title', 'Height the head lowers to when placing the part down')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.feedXY', 'Feed XY (mm/min)')}
                <NumField
                  step="100"
                  min="0"
                  value={params.feedXY}
                  commit={(raw) => setParam('feedXY', Math.max(0, num(raw, params.feedXY)))}
                  title={t('pnp.field.feedXY.title', 'Travel speed for XY moves')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.feedZ', 'Feed Z (mm/min)')}
                <NumField
                  step="10"
                  min="0"
                  value={params.feedZ}
                  commit={(raw) => setParam('feedZ', Math.max(0, num(raw, params.feedZ)))}
                  title={t('pnp.field.feedZ.title', 'Plunge speed when lowering to pick/place height')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.strength', '{action} strength (S)', { action: labels.on })}
                <NumField
                  step="100"
                  min="0"
                  value={params.gripRpm}
                  commit={(raw) => setParam('gripRpm', Math.max(0, num(raw, params.gripRpm)))}
                  title={t('pnp.field.strength.title', 'Spindle S value = vacuum / grip strength (M3 S…)')}
                />
              </label>
            </div>
          </div>
        </section>

        {/* --- Advanced (collapsed) ------------------------------------ */}
        <section className={showAdvanced ? 'pp-card pp-collapsible is-open' : 'pp-card pp-collapsible'}>
          <h3>
            <button
              className="pp-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
            >
              <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} />{' '}
              {t('pnp.advanced', 'Advanced')}
              <span className="pp-toggle-note">{t('pnp.advanced.note', 'dwell · rotation · decimals')}</span>
            </button>
          </h3>
          {showAdvanced && (
            <div className="pp-card-body">
              <div className="pp-grid">
                <label className="pp-field">
                  {t('pnp.field.pickDwell', 'Pick dwell (ms)')}
                  <NumField
                    step="50"
                    min="0"
                    value={params.pickDwellMs}
                    commit={(raw) => setParam('pickDwellMs', Math.max(0, num(raw, params.pickDwellMs)))}
                    title={t('pnp.field.pickDwell.title', 'Pause after gripping so the grip is secure (0 = none)')}
                  />
                </label>
                <label className="pp-field">
                  {t('pnp.field.placeDwell', 'Place dwell (ms)')}
                  <NumField
                    step="50"
                    min="0"
                    value={params.placeDwellMs}
                    commit={(raw) => setParam('placeDwellMs', Math.max(0, num(raw, params.placeDwellMs)))}
                    title={t('pnp.field.placeDwell.title', 'Pause after releasing so the part settles (0 = none)')}
                  />
                </label>
                <label className="pp-field">
                  {t('pnp.field.decimals', 'Decimals')}
                  <NumField
                    step="1"
                    min="0"
                    max="6"
                    value={params.decimals}
                    commit={(raw) =>
                      setParam('decimals', Math.max(0, Math.min(6, Math.round(num(raw, params.decimals)))))
                    }
                    title={t('pnp.field.decimals.title', 'Decimal places used in emitted coordinates')}
                  />
                </label>
              </div>

              <label className="pp-check">
                <input
                  type="checkbox"
                  checked={params.rotaryAxis}
                  onChange={(e) => setParam('rotaryAxis', e.target.checked)}
                />
                {t('pnp.rotaryAxis', 'Emit part rotation as a real A-axis word (G0 A…)')}
              </label>

              <div className="pp-table-wrap pp-rot-table">
                <table className="pp-table">
                  <thead>
                    <tr>
                      <th className="pp-idx">#</th>
                      <th>{t('pnp.col.rotation', 'Rotation°')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ops.length === 0 && (
                      <tr>
                        <td colSpan={2} className="pp-empty">{t('pnp.rot.empty', 'No operations.')}</td>
                      </tr>
                    )}
                    {ops.map((op, i) => (
                      <tr
                        key={op.id ?? i}
                        className={i === selected ? 'pp-row-selected' : undefined}
                        onClick={() => setSelected(i)}
                      >
                        <td className="pp-idx">
                          <span className="pp-idx-label">{t('pnp.idx.label', 'Op')}</span> {i + 1}
                        </td>
                        <td data-label={t('pnp.col.rotation', 'Rotation°')}>
                          <NumField
                            step="5"
                            aria-label={t('pnp.col.rotation', 'Rotation°')}
                            value={op.rotation ?? 0}
                            commit={(raw) => updateOp(i, { rotation: num(raw, op.rotation ?? 0) })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="pp-hint">
                {t('pnp.hint.pre', 'Speed here is the')} <b>{t('pnp.hint.feed', 'feed rate')}</b>{' '}
                {t('pnp.hint.post', 'only. Acceleration is a global machine setting ($120–$122, set in the Motion / Probe panels) and is not written here.')}
              </p>
            </div>
          )}
        </section>

        {/* --- Send + raw G-code --------------------------------------- */}
        <section className="pp-card pp-card-wide pp-send-card">
          <h3>{t('pnp.send.title', 'Generate & send')}</h3>
          <div className="pp-card-body">
            <div className="pp-row pp-generate">
              {streaming ? (
                <button
                  className="pp-play pp-stop"
                  onClick={stop}
                  title={t('pnp.stop.title', 'Stop the running program (soft reset)')}
                >
                  <Icon name="stop" size={15} /> {t('pnp.stop.btn', 'Stop')}
                </button>
              ) : (
                <button
                  className="primary pp-play"
                  onClick={play}
                  disabled={ops.length === 0 || lineCount === 0 || !connected}
                  title={connected ? t('pnp.send.btn.title.on', 'Stream this program to the machine') : t('pnp.send.btn.title.off', 'Connect to a machine to send')}
                >
                  <Icon name="play" size={15} /> {t('pnp.send.btn', 'Send to machine')}
                </button>
              )}
              <span className="pp-meta">
                {t('pnp.send.meta', 'Live · {n} lines → Visualizer', { n: lineCount })}
              </span>
            </div>
            {!connected && ops.length > 0 && !streaming && (
              <span className="pp-meta">{t('pnp.send.notConnected', 'Not connected — preview is live; connect to send.')}</span>
            )}

            <button className="pp-raw-toggle" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}>
              <Icon name={showRaw ? 'chevron-down' : 'chevron-right'} size={13} />{' '}
              {t('pnp.raw', 'Raw G-code ({n} lines)', { n: lineCount })}
            </button>
            {showRaw && <pre className="pp-preview">{gcode}</pre>}
          </div>
        </section>
        </div>
      </div>
    </div>
  )
}
