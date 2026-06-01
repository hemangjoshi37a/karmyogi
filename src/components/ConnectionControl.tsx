import { grbl } from '../serial/controller'
import { MockPort } from '../serial'
import { useMachine } from '../store'

/**
 * Connection control for the top title bar: a status dot + machine state, and
 * Connect / Mock / Disconnect. Moved here from the Controller panel so the
 * connection is always visible regardless of which panel is focused.
 */
export function ConnectionControl() {
  const connection = useMachine((s) => s.connection)
  const state = useMachine((s) => s.state)
  const error = useMachine((s) => s.error)
  const connected = connection === 'connected'
  const connecting = connection === 'connecting'

  return (
    <span className="km-conn" title={error ?? undefined}>
      <span className="km-conn-dot" data-conn={connection} data-state={state} />
      <span className="km-conn-state">{connected ? state : connection}</span>
      {!connected ? (
        <>
          <button
            className="km-conn-btn primary"
            disabled={connecting}
            onClick={() => grbl.connect().catch(() => {})}
            title="Connect to a GRBL device over USB (Web Serial)"
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
          <button
            className="km-conn-btn"
            disabled={connecting}
            onClick={() => grbl.connect(new MockPort()).catch(() => {})}
            title="Connect to an in-browser mock GRBL device (no hardware)"
          >
            Mock
          </button>
        </>
      ) : (
        <button className="km-conn-btn" onClick={() => void grbl.disconnect()} title="Disconnect">
          Disconnect
        </button>
      )}
    </span>
  )
}
