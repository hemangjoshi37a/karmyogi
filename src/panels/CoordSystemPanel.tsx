import { Fragment } from 'react'
import { grbl } from '../serial/controller'
import { useMachine, useSettings, usePersistentState } from '../store'
import { AxisZeroIcon, GoToZeroIcon } from '../components/MachineIcons'
import '../styles/controller.css'

/**
 * Work coordinate systems. `code` is the GRBL command sent on select; `label`
 * is the compact human-readable chip text (short form so all six fit in the
 * narrow column); `title` is the full hover description (name + gcode).
 */
const WCS = [
  { code: 'G54', label: 'W1', title: 'G54 — Work coordinate system 1 (default datum). The active work zero used for positioning.' },
  { code: 'G55', label: 'W2', title: 'G55 — Work coordinate system 2.' },
  { code: 'G56', label: 'W3', title: 'G56 — Work coordinate system 3.' },
  { code: 'G57', label: 'W4', title: 'G57 — Work coordinate system 4.' },
  { code: 'G58', label: 'W5', title: 'G58 — Work coordinate system 5.' },
  { code: 'G59', label: 'W6', title: 'G59 — Work coordinate system 6.' },
] as const
const AXES = ['x', 'y', 'z'] as const

/**
 * Coordinate-system panel: select the active work coordinate system (G54–G59),
 * view the current work offset (WCO), and zero work axes at the current
 * position (`G10 L20 P0`). Disabled until connected.
 */
export function CoordSystemPanel() {
  const connected = useMachine((s) => s.connection === 'connected')
  const wco = useMachine((s) => s.wco)
  const units = useSettings((s) => s.units)
  const decimals = units === 'inch' ? 4 : 3
  const [active, setActive] = usePersistentState('karmyogi.wcs', 'G54')

  const selectWcs = (w: string) => {
    setActive(w)
    if (grbl.isConnected) void grbl.send(w)
  }
  const zero = (axes: string) => {
    if (grbl.isConnected) void grbl.send(`G10 L20 P0 ${axes}`)
  }

  return (
    <div className="mc-panel">
      <div className="mc-cols">
      <section className="mc-section">
        <h4>Work Coordinate System</h4>
        <div className="mc-row tight">
          {WCS.map((w) => (
            <button
              key={w.code}
              type="button"
              className={`mc-btn${active === w.code ? ' primary' : ''}`}
              disabled={!connected}
              aria-pressed={active === w.code}
              aria-label={`${w.code} work coordinate system`}
              title={w.title}
              onClick={() => selectWcs(w.code)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mc-section">
        <h4>Work Offset (WCO)</h4>
        <div className="dro">
          <span className="dro-head axis-head">Axis</span>
          <span className="dro-head">Offset</span>
          <span className="dro-head" />
          {AXES.map((ax) => (
            <Fragment key={ax}>
              <span className="dro-axis">{ax.toUpperCase()}</span>
              <span className="dro-val machine">{wco[ax].toFixed(decimals)}</span>
              <button
                type="button"
                className="mc-btn mc-btn-lead"
                disabled={!connected}
                onClick={() => zero(`${ax.toUpperCase()}0`)}
              >
                <AxisZeroIcon size={16} />
                <span>Zero {ax.toUpperCase()}</span>
              </button>
            </Fragment>
          ))}
        </div>
      </section>

      <section className="mc-section">
        <h4>Quick Zero</h4>
        <div className="mc-row">
          <button
            type="button"
            className="mc-btn mc-btn-stack primary"
            disabled={!connected}
            onClick={() => zero('X0 Y0 Z0')}
            title="Set the current position as work zero for X, Y and Z (G10 L20 P0)"
          >
            <AxisZeroIcon size={18} />
            <span className="mc-btn-label">Zero all axes</span>
            <span className="mc-btn-cmd" aria-hidden="true">XYZ→0</span>
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack"
            disabled={!connected}
            onClick={() => zero('X0 Y0')}
            title="Set the current position as work zero for X and Y only (G10 L20 P0)"
          >
            <AxisZeroIcon size={18} />
            <span className="mc-btn-label">Zero XY</span>
            <span className="mc-btn-cmd" aria-hidden="true">XY→0</span>
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack"
            disabled={!connected}
            onClick={() => grbl.isConnected && void grbl.send('G90 G0 X0 Y0')}
            title="Rapid to work zero (X0 Y0)"
          >
            <GoToZeroIcon size={18} />
            <span className="mc-btn-label">Go to zero</span>
            <span className="mc-btn-cmd" aria-hidden="true">G0 X0 Y0</span>
          </button>
        </div>
      </section>
      </div>
    </div>
  )
}
