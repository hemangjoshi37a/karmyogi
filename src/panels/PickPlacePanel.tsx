import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { useMachine, useProgram, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import {
  defaultPnpOp,
  defaultPnpParams,
  generatePickPlace,
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

/** Bed size in mm (bottom-left = machine origin [0,0]) for the 2D preview. */
const BED = { w: 300, h: 200 }
const PAD = 6

/** Per-op params the table edits (everything else is global). */
type PanelParams = Omit<PnpParams, 'programName' | 'metric'>

/** Head-type labelling: pick/release vs grip/open. */
function headLabels(head: PnpHeadType, t: ReturnType<typeof useT>): { on: string; off: string } {
  return head === 'gripper'
    ? { on: t('pnp.head.grip', 'Grip'), off: t('pnp.head.open', 'Open') }
    : { on: t('pnp.head.vacuum', 'Vacuum'), off: t('pnp.head.release', 'Release') }
}

/**
 * Pick & Place panel. The head is a vacuum suction cup / gripper wired to the
 * spindle output (M3 = grip/vacuum ON, M5 = release OFF). An editable table of
 * pick→place operations drives the pure `generatePickPlace` core, which emits a
 * safe program (travel at safe-Z, lower to pick, grip, lift, travel to place,
 * lower, release, lift). "Set pick/place from machine" captures the live work
 * position. Generation is live + debounced into the shared program store so the
 * Visualizer previews the travel/pick/place path; Send streams it to the machine.
 *
 * Layout: a single vertical-only scroller of bordered CARD sections — head,
 * operations table, bed preview, motion params (essentials visible, niche
 * settings behind a collapsed Advanced section), and Send + raw G-code.
 */
export function PickPlacePanel() {
  const t = useT()
  // Live machine work-position + connection (for "Set from machine").
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)

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
  // Visualizer updates without a manual Generate step.
  useEffect(() => {
    if (ops.length === 0) return
    const id = window.setTimeout(() => setProgram('pick-place', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, ops.length, setProgram])

  // Stream the program to the machine.
  function play() {
    const lines = gcodeLines(gcode)
    if (lines.length === 0 || !connected) return
    setProgram('pick-place', gcode)
    grbl.startProgram(lines)
  }

  /** Machine-Y (up) → SVG-Y (down). */
  const sy = (y: number) => BED.h - y

  const hasSelection = selected >= 0 && selected < ops.length

  return (
    <div className="pp-panel">
      <div className="pp-scroll">
        <p className="pp-intro">
          {t('pnp.intro.pre', 'Move parts from a')} <b>{t('pnp.intro.pick', 'pick')}</b>{' '}
          {t('pnp.intro.mid', 'point to a')} <b>{t('pnp.intro.place', 'place')}</b>{' '}
          {t('pnp.intro.head', 'point. The head grabs with the spindle output ({on} on, {off} off). Build the operations below, then', { on: labels.on, off: labels.off })}{' '}
          <b>{t('pnp.intro.send', 'Send ▶')}</b> {t('pnp.intro.tomachine', 'to the machine.')}
        </p>

        {/* --- Head + operations --------------------------------------- */}
        <section className="pp-card">
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
                  {ops.map((op, i) => (
                    <tr
                      key={i}
                      className={i === selected ? 'pp-row-selected' : undefined}
                      onClick={() => setSelected(i)}
                    >
                      <td className="pp-idx">{i + 1}</td>
                      <td data-label={t('pnp.col.pickX', 'Pick X')}>
                        <input
                          type="number"
                          step="0.1"
                          value={op.pickX}
                          onChange={(e) => updateOp(i, { pickX: num(e.target.value, op.pickX) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.pickY', 'Pick Y')}>
                        <input
                          type="number"
                          step="0.1"
                          value={op.pickY}
                          onChange={(e) => updateOp(i, { pickY: num(e.target.value, op.pickY) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.placeX', 'Place X')}>
                        <input
                          type="number"
                          step="0.1"
                          value={op.placeX}
                          onChange={(e) => updateOp(i, { placeX: num(e.target.value, op.placeX) })}
                        />
                      </td>
                      <td data-label={t('pnp.col.placeY', 'Place Y')}>
                        <input
                          type="number"
                          step="0.1"
                          value={op.placeY}
                          onChange={(e) => updateOp(i, { placeY: num(e.target.value, op.placeY) })}
                        />
                      </td>
                      <td className="pp-actions">
                        <button title={t('pnp.row.up', 'Move up')} onClick={(e) => { e.stopPropagation(); moveRow(i, -1) }} disabled={i === 0}>
                          ↑
                        </button>
                        <button title={t('pnp.row.down', 'Move down')} onClick={(e) => { e.stopPropagation(); moveRow(i, 1) }} disabled={i === ops.length - 1}>
                          ↓
                        </button>
                        <button className="pp-del" title={t('pnp.row.delete', 'Delete op')} onClick={(e) => { e.stopPropagation(); deleteRow(i) }}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pp-row pp-op-tools">
              <button className="primary" onClick={addRow}>
                {t('pnp.addOp', '+ Add op')}
              </button>
              <button onClick={() => setOps([])} disabled={ops.length === 0}>
                {t('pnp.clear', 'Clear')}
              </button>
              <span className="pp-spacer" />
              <button
                onClick={() => recordInto('pick')}
                disabled={!connected}
                title={connected ? t('pnp.setPick.title.on', 'Fill the selected op pick X/Y from the live machine position') : t('pnp.set.title.off', 'Connect to set from machine')}
              >
                {hasSelection
                  ? t('pnp.setPick.sel', '⌖ Set pick #{n} from machine', { n: selected + 1 })
                  : t('pnp.setPick', '⌖ Set pick from machine')}
              </button>
              <button
                onClick={() => recordInto('place')}
                disabled={!connected}
                title={connected ? t('pnp.setPlace.title.on', 'Fill the selected op place X/Y from the live machine position') : t('pnp.set.title.off', 'Connect to set from machine')}
              >
                {hasSelection
                  ? t('pnp.setPlace.sel', '⌖ Set place #{n} from machine', { n: selected + 1 })
                  : t('pnp.setPlace', '⌖ Set place from machine')}
              </button>
            </div>
            <span className="pp-meta">
              {connected
                ? t('pnp.wpos', 'Live WPos  {x}, {y}', { x: wpos.x.toFixed(2), y: wpos.y.toFixed(2) })
                : t('pnp.notConnected', 'Not connected — set buttons disabled')}
            </span>
          </div>
        </section>

        {/* --- 2D bed preview ------------------------------------------ */}
        {ops.length > 0 && (
          <section className="pp-card">
            <h3>{t('pnp.preview.title', 'Bed preview · pick ○ → place △')}</h3>
            <div className="pp-card-body pp-preview2d-body">
              <svg
                className="pp-preview2d"
                viewBox={`${-PAD} ${-PAD} ${BED.w + PAD * 2} ${BED.h + PAD * 2}`}
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
                <rect className="pp-bed" x={0} y={0} width={BED.w} height={BED.h} />
                {Array.from({ length: Math.floor(BED.w / 20) + 1 }, (_, i) => i * 20).map((gx) => (
                  <line key={`vx${gx}`} className="pp-grid" x1={gx} y1={0} x2={gx} y2={BED.h} />
                ))}
                {Array.from({ length: Math.floor(BED.h / 20) + 1 }, (_, i) => i * 20).map((gy) => (
                  <line key={`hy${gy}`} className="pp-grid" x1={0} y1={sy(gy)} x2={BED.w} y2={sy(gy)} />
                ))}
                <circle className="pp-origin" cx={0} cy={sy(0)} r={2.5} />
                {ops.map((op, i) => {
                  const px = op.pickX
                  const py = sy(op.pickY)
                  const qx = op.placeX
                  const qy = sy(op.placeY)
                  const sel = i === selected
                  const tri = `${qx},${qy - 4} ${qx - 4},${qy + 3} ${qx + 4},${qy + 3}`
                  return (
                    <g key={i} className={sel ? 'pp-op pp-op-sel' : 'pp-op'} onClick={() => setSelected(i)}>
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
                <input
                  type="number"
                  step="0.1"
                  value={params.travelZ}
                  onChange={(e) => setParam('travelZ', num(e.target.value, params.travelZ))}
                  title={t('pnp.field.travelZ.title', 'Safe clearance height for all XY travel')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.pickZ', 'Pick Z (mm)')}
                <input
                  type="number"
                  step="0.1"
                  value={params.pickZ}
                  onChange={(e) => setParam('pickZ', num(e.target.value, params.pickZ))}
                  title={t('pnp.field.pickZ.title', 'Height the head lowers to when picking up the part')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.placeZ', 'Place Z (mm)')}
                <input
                  type="number"
                  step="0.1"
                  value={params.placeZ}
                  onChange={(e) => setParam('placeZ', num(e.target.value, params.placeZ))}
                  title={t('pnp.field.placeZ.title', 'Height the head lowers to when placing the part down')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.feedXY', 'Feed XY (mm/min)')}
                <input
                  type="number"
                  step="100"
                  min="0"
                  value={params.feedXY}
                  onChange={(e) => setParam('feedXY', num(e.target.value, params.feedXY))}
                  title={t('pnp.field.feedXY.title', 'Travel speed for XY moves')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.feedZ', 'Feed Z (mm/min)')}
                <input
                  type="number"
                  step="10"
                  min="0"
                  value={params.feedZ}
                  onChange={(e) => setParam('feedZ', num(e.target.value, params.feedZ))}
                  title={t('pnp.field.feedZ.title', 'Plunge speed when lowering to pick/place height')}
                />
              </label>
              <label className="pp-field">
                {t('pnp.field.strength', '{action} strength (S)', { action: labels.on })}
                <input
                  type="number"
                  step="100"
                  min="0"
                  value={params.gripRpm}
                  onChange={(e) => setParam('gripRpm', num(e.target.value, params.gripRpm))}
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
              {showAdvanced ? '▾' : '▸'} {t('pnp.advanced', 'Advanced')}
              <span className="pp-toggle-note">{t('pnp.advanced.note', 'dwell · rotation · decimals')}</span>
            </button>
          </h3>
          {showAdvanced && (
            <div className="pp-card-body">
              <div className="pp-grid">
                <label className="pp-field">
                  {t('pnp.field.pickDwell', 'Pick dwell (ms)')}
                  <input
                    type="number"
                    step="50"
                    min="0"
                    value={params.pickDwellMs}
                    onChange={(e) => setParam('pickDwellMs', num(e.target.value, params.pickDwellMs))}
                    title={t('pnp.field.pickDwell.title', 'Pause after gripping so the grip is secure (0 = none)')}
                  />
                </label>
                <label className="pp-field">
                  {t('pnp.field.placeDwell', 'Place dwell (ms)')}
                  <input
                    type="number"
                    step="50"
                    min="0"
                    value={params.placeDwellMs}
                    onChange={(e) => setParam('placeDwellMs', num(e.target.value, params.placeDwellMs))}
                    title={t('pnp.field.placeDwell.title', 'Pause after releasing so the part settles (0 = none)')}
                  />
                </label>
                <label className="pp-field">
                  {t('pnp.field.decimals', 'Decimals')}
                  <input
                    type="number"
                    step="1"
                    min="0"
                    max="6"
                    value={params.decimals}
                    onChange={(e) =>
                      setParam('decimals', Math.max(0, Math.min(6, Math.round(num(e.target.value, params.decimals)))))
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
                        key={i}
                        className={i === selected ? 'pp-row-selected' : undefined}
                        onClick={() => setSelected(i)}
                      >
                        <td className="pp-idx">{i + 1}</td>
                        <td data-label={t('pnp.col.rotation', 'Rotation°')}>
                          <input
                            type="number"
                            step="5"
                            value={op.rotation ?? 0}
                            onChange={(e) => updateOp(i, { rotation: num(e.target.value, op.rotation ?? 0) })}
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
        <section className="pp-card pp-send-card">
          <h3>{t('pnp.send.title', 'Generate & send')}</h3>
          <div className="pp-card-body">
            <div className="pp-row pp-generate">
              <button
                className="primary pp-play"
                onClick={play}
                disabled={ops.length === 0 || lineCount === 0 || !connected}
                title={connected ? t('pnp.send.btn.title.on', 'Stream this program to the machine') : t('pnp.send.btn.title.off', 'Connect to a machine to send')}
              >
                {t('pnp.send.btn', '▶ Send to machine')}
              </button>
              <span className="pp-meta">
                {t('pnp.send.meta', 'Live · {n} lines → Visualizer', { n: lineCount })}
              </span>
            </div>
            {!connected && ops.length > 0 && (
              <span className="pp-meta">{t('pnp.send.notConnected', 'Not connected — preview is live; connect to send.')}</span>
            )}

            <button className="pp-raw-toggle" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}>
              {showRaw ? '▾' : '▸'} {t('pnp.raw', 'Raw G-code ({n} lines)', { n: lineCount })}
            </button>
            {showRaw && <pre className="pp-preview">{gcode}</pre>}
          </div>
        </section>
      </div>
    </div>
  )
}
