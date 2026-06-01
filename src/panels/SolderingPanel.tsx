import { useEffect, useMemo, useState } from 'react'
import { useMachine, useProgram } from '../store'
import { grbl } from '../serial/controller'
import {
  SolderFeedType,
  defaultSolderPoint,
  defaultSolderingParams,
  generateSoldering,
  type SolderPoint,
  type SolderingParams,
} from '../core/soldering'
import '../styles/soldering.css'

/** Split G-code into non-empty lines for streaming to the controller. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

// Defaults used to prefill new rows. Mirror the core SolderPoint defaults but
// are user-editable from the panel so a batch of points share a Free-Z etc.
interface RowDefaults {
  freeZ: number
  touchZ: number
  feedSeconds: number
  type: SolderFeedType
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Auto-soldering panel (W9). An editable table of soldering points drives the
 * pure `generateSoldering` core, which emits a safe program where the spindle
 * output is repurposed as a solder-wire feeder (M3/G4/M5). "Record position"
 * captures the live machine work-position into a point. Generation is live:
 * every edit pushes a fresh program into the shared store (Visualizer renders
 * it; this panel and the Program panel can stream it).
 */
export function SolderingPanel() {
  // Live machine work-position + connection (for "Record position").
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)

  const [defaults, setDefaults] = useState<RowDefaults>({
    freeZ: 5.0,
    touchZ: -1.0,
    feedSeconds: 0.5,
    type: SolderFeedType.TouchDown,
  })

  const [points, setPoints] = useState<SolderPoint[]>([])
  const [selected, setSelected] = useState(-1)
  const [showRaw, setShowRaw] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Global generator params (programName is fixed here; metric stays mm/G21).
  const [params, setParams] = useState<Omit<SolderingParams, 'programName' | 'metric'>>(() => {
    const d = defaultSolderingParams()
    return {
      safeZ: d.safeZ,
      feederRPM: d.feederRPM,
      plungeFeed: d.plungeFeed,
      settleSeconds: d.settleSeconds,
      decimals: d.decimals,
    }
  })

  function newRow(x = 0, y = 0): SolderPoint {
    return defaultSolderPoint({
      x,
      y,
      freeZ: defaults.freeZ,
      touchZ: defaults.touchZ,
      feedSeconds: defaults.feedSeconds,
      type: defaults.type,
    })
  }

  function addRow() {
    setPoints((p) => [...p, newRow()])
    setSelected(points.length)
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

  function updatePoint(i: number, patch: Partial<SolderPoint>) {
    setPoints((p) => p.map((pt, idx) => (idx === i ? { ...pt, ...patch } : pt)))
  }

  // Record the live machine work-position. If a row is selected, fill its X/Y;
  // otherwise append a new row at that position.
  function recordPosition() {
    if (!connected) return
    if (selected >= 0 && selected < points.length) {
      updatePoint(selected, { x: wpos.x, y: wpos.y })
    } else {
      setPoints((p) => [...p, newRow(wpos.x, wpos.y)])
      setSelected(points.length)
    }
  }

  // Live G-code preview, recomputed whenever points/params change.
  const gcode = useMemo(() => generateSoldering(points, { ...params }), [points, params])
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])

  // Live generation: push the freshly-computed program to the store (debounced)
  // so the Visualizer updates without a manual Generate step.
  useEffect(() => {
    if (points.length === 0) return
    const id = window.setTimeout(() => setProgram('soldering', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, points.length, setProgram])

  // Stream the program to the machine.
  function play() {
    const lines = gcodeLines(gcode)
    if (lines.length === 0 || !connected) return
    setProgram('soldering', gcode)
    grbl.startProgram(lines)
  }

  return (
    <div className="sp-panel">
      {/* One-line orientation for newcomers. */}
      <p className="sp-intro">
        Solders a list of points one by one. The machine's <b>spindle output drives a
        solder-wire feeder</b> (M3 runs it, M5 stops). Add points or record positions, tune the
        feeder, then send.
      </p>

      {/* 1 · Points — toolbar + editable table */}
      <section className="sp-card sp-card-points">
        <header className="sp-card-head">
          <h4>1 · Soldering points</h4>
          <span className="sp-meta">
            {points.length} point{points.length === 1 ? '' : 's'}
          </span>
        </header>

        <div className="sp-toolbar">
          <button className="primary" onClick={addRow} title="Add a soldering point prefilled from the defaults below">
            + Add point
          </button>
          <button
            onClick={recordPosition}
            disabled={!connected}
            title={
              connected
                ? selected >= 0
                  ? 'Fill selected row X/Y from machine position'
                  : 'Append a point at the current machine position'
                : 'Connect to record the machine position'
            }
          >
            Record position
          </button>
          <button
            onClick={() => setPoints([])}
            disabled={points.length === 0}
            title="Remove all soldering points"
          >
            Clear
          </button>
        </div>

        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr>
                <th className="sp-idx">#</th>
                <th>X</th>
                <th>Y</th>
                <th>Free-Z</th>
                <th>Touch-Z</th>
                <th>Feed type</th>
                <th>Feed s</th>
                <th className="sp-actions-col" />
              </tr>
            </thead>
            <tbody>
              {points.length === 0 && (
                <tr>
                  <td colSpan={8} className="sp-empty">
                    No soldering points yet. Add a point or record the machine position to begin.
                  </td>
                </tr>
              )}
              {points.map((pt, i) => (
                <tr
                  key={i}
                  className={i === selected ? 'sp-row-selected' : undefined}
                  onClick={() => setSelected(i)}
                >
                  <td className="sp-idx">{i + 1}</td>
                  <td data-label="X">
                    <input
                      type="number"
                      step="0.1"
                      value={pt.x}
                      onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    />
                  </td>
                  <td data-label="Y">
                    <input
                      type="number"
                      step="0.1"
                      value={pt.y}
                      onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    />
                  </td>
                  <td data-label="Free-Z">
                    <input
                      type="number"
                      step="0.1"
                      value={pt.freeZ}
                      onChange={(e) => updatePoint(i, { freeZ: num(e.target.value, pt.freeZ) })}
                    />
                  </td>
                  <td data-label="Touch-Z">
                    <input
                      type="number"
                      step="0.1"
                      value={pt.touchZ}
                      onChange={(e) => updatePoint(i, { touchZ: num(e.target.value, pt.touchZ) })}
                    />
                  </td>
                  <td data-label="Feed type">
                    <select
                      value={pt.type}
                      onChange={(e) => updatePoint(i, { type: e.target.value as SolderFeedType })}
                    >
                      <option value={SolderFeedType.PreSolder}>pre-solder</option>
                      <option value={SolderFeedType.TouchDown}>touch-down</option>
                    </select>
                  </td>
                  <td data-label="Feed s">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={pt.feedSeconds}
                      onChange={(e) =>
                        updatePoint(i, { feedSeconds: num(e.target.value, pt.feedSeconds) })
                      }
                    />
                  </td>
                  <td className="sp-actions">
                    <button
                      title="Move up"
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, -1)
                      }}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      title="Move down"
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, 1)
                      }}
                      disabled={i === points.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className="sp-del"
                      title="Delete point"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteRow(i)
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="sp-hint">
          New points are prefilled from the defaults below. Click a row to select it (then
          "Record position" fills its X/Y).
        </p>
      </section>

      {/* 2 · New-point defaults */}
      <section className="sp-card">
        <header className="sp-card-head">
          <h4>New-point defaults</h4>
        </header>
        <div className="sp-fields">
          <label>
            Free-Z (mm)
            <input
              type="number"
              step="0.1"
              value={defaults.freeZ}
              onChange={(e) => setDefaults((d) => ({ ...d, freeZ: num(e.target.value, d.freeZ) }))}
            />
          </label>
          <label>
            Touch-Z (mm)
            <input
              type="number"
              step="0.1"
              value={defaults.touchZ}
              onChange={(e) => setDefaults((d) => ({ ...d, touchZ: num(e.target.value, d.touchZ) }))}
            />
          </label>
          <label>
            Feed (s)
            <input
              type="number"
              step="0.1"
              min="0"
              value={defaults.feedSeconds}
              onChange={(e) =>
                setDefaults((d) => ({ ...d, feedSeconds: num(e.target.value, d.feedSeconds) }))
              }
            />
          </label>
          <label>
            Feed type
            <select
              value={defaults.type}
              onChange={(e) => setDefaults((d) => ({ ...d, type: e.target.value as SolderFeedType }))}
            >
              <option value={SolderFeedType.PreSolder}>pre-solder</option>
              <option value={SolderFeedType.TouchDown}>touch-down</option>
            </select>
          </label>
        </div>
      </section>

      {/* 3 · Feeder & motion */}
      <section className="sp-card">
        <header className="sp-card-head">
          <h4>2 · Feeder &amp; motion</h4>
        </header>
        <div className="sp-fields">
          <label>
            Safe-Z (mm)
            <input
              type="number"
              step="0.1"
              value={params.safeZ}
              onChange={(e) => setParams((p) => ({ ...p, safeZ: num(e.target.value, p.safeZ) }))}
            />
          </label>
          <label>
            Feeder S
            <input
              type="number"
              step="100"
              min="0"
              value={params.feederRPM}
              onChange={(e) => setParams((p) => ({ ...p, feederRPM: num(e.target.value, p.feederRPM) }))}
            />
          </label>
          <label>
            Plunge F (mm/min)
            <input
              type="number"
              step="10"
              min="0"
              value={params.plungeFeed}
              onChange={(e) =>
                setParams((p) => ({ ...p, plungeFeed: num(e.target.value, p.plungeFeed) }))
              }
            />
          </label>
        </div>

        <button
          className="sp-adv-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <div className="sp-fields sp-adv">
            <label>
              Settle dwell (s)
              <input
                type="number"
                step="0.1"
                min="0"
                value={params.settleSeconds}
                onChange={(e) =>
                  setParams((p) => ({ ...p, settleSeconds: num(e.target.value, p.settleSeconds) }))
                }
              />
            </label>
            <label>
              Decimals
              <input
                type="number"
                step="1"
                min="0"
                max="6"
                value={params.decimals}
                onChange={(e) =>
                  setParams((p) => ({ ...p, decimals: intNum(e.target.value, p.decimals) }))
                }
              />
            </label>
          </div>
        )}
      </section>

      {/* 4 · Generate / send */}
      <section className="sp-card sp-card-send">
        <button
          className="primary sp-play"
          onClick={play}
          disabled={points.length === 0 || lineCount === 0 || !connected}
          title={connected ? 'Stream this program to the machine' : 'Connect to a machine to send'}
        >
          ▶ Send to machine
        </button>
        <span className="sp-meta">
          Live · <b>{lineCount}</b> lines → Visualizer
        </span>
        {!connected && points.length > 0 && (
          <span className="sp-meta sp-warn">Not connected — preview is live; connect to send.</span>
        )}

        <button
          className="sp-raw-toggle"
          onClick={() => setShowRaw((v) => !v)}
          aria-expanded={showRaw}
        >
          {showRaw ? '▾' : '▸'} Raw G-code ({lineCount} lines)
        </button>
        {showRaw && <pre className="sp-preview">{gcode}</pre>}
      </section>
    </div>
  )
}
