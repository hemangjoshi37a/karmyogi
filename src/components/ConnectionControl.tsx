import { grbl } from '../serial/controller'
import { MockPort } from '../serial'
import { useMachine, useMachineProfile } from '../store'
import { CONTROLLER_LIST, profileFor } from '../machine/controllers'
import type { ControllerKind } from '../machine/types'
import { useT } from '../i18n'
import { IconButton } from './IconButton'

interface ConnectionControlProps {
  /** Open the Motion / GRBL settings modal. Renders a ⚙ button in the cluster. */
  onOpenSettings?: () => void
  /** Open the Probe & Limits modal. Renders a ⌖ probe button in the cluster. */
  onOpenProbe?: () => void
}

/**
 * Connection control for the top title bar: a controller selector, status dot +
 * machine state, and Connect / Mock / Disconnect. Moved here from the Controller
 * panel so the connection is always visible regardless of which panel is focused.
 * Optionally also hosts the ⚙ settings and ⌖ probe buttons so machine-level
 * actions sit with the connection controls.
 */
export function ConnectionControl({ onOpenSettings, onOpenProbe }: ConnectionControlProps = {}) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const state = useMachine((s) => s.state)
  const error = useMachine((s) => s.error)
  const controllerKind = useMachineProfile((s) => s.controllerKind)
  const setControllerKind = useMachineProfile((s) => s.setControllerKind)
  const connected = connection === 'connected'
  const connecting = connection === 'connecting'

  const profile = profileFor(controllerKind)
  const experimental = profile.supported === 'experimental'
  // Lock the selector while a connection is active or being established.
  const selectDisabled = connected || connecting

  return (
    <span className="km-conn" title={error ?? undefined}>
      <select
        className="km-conn-select"
        value={controllerKind}
        disabled={selectDisabled}
        data-experimental={experimental ? 'true' : undefined}
        onChange={(e) => setControllerKind(e.target.value as ControllerKind)}
        title={
          experimental
            ? t(
                'conn.controller.experimental',
                '{name}: experimental support',
                { name: profile.label },
              )
            : t('conn.controller.title', 'Select controller firmware')
        }
        aria-label={t('conn.controller.label', 'Controller firmware')}
      >
        {CONTROLLER_LIST.map((c) => (
          <option key={c.kind} value={c.kind}>
            {c.label}
            {c.supported === 'experimental'
              ? ` — ${t('conn.controller.experimentalTag', 'experimental')}`
              : ''}
          </option>
        ))}
      </select>
      <span className="km-conn-dot" data-conn={connection} data-state={state} />
      <span className="km-conn-state">
        {connected ? state : t(`conn.status.${connection}`, connection)}
      </span>
      {!connected ? (
        <>
          <button
            className="km-conn-btn primary"
            disabled={connecting}
            onClick={() => grbl.connect().catch(() => {})}
            title={t('conn.connect.title', 'Connect to a GRBL device over USB (Web Serial)')}
          >
            {connecting ? t('conn.connecting', 'Connecting…') : t('conn.connect', 'Connect')}
          </button>
          <button
            className="km-conn-btn"
            disabled={connecting}
            onClick={() => grbl.connect(new MockPort()).catch(() => {})}
            title={t('conn.mock.title', 'Connect to an in-browser mock GRBL device (no hardware)')}
          >
            {t('conn.mock', 'Mock')}
          </button>
        </>
      ) : (
        <button
          className="km-conn-btn"
          onClick={() => void grbl.disconnect()}
          title={t('conn.disconnect', 'Disconnect')}
        >
          {t('conn.disconnect', 'Disconnect')}
        </button>
      )}
      {(onOpenProbe || onOpenSettings) && <span className="km-conn-sep" aria-hidden="true" />}
      {onOpenProbe && (
        <IconButton
          className="km-conn-icon"
          icon="⌖"
          label={t('conn.probe', 'Probe & limits')}
          onClick={onOpenProbe}
        />
      )}
      {onOpenSettings && (
        <IconButton
          className="km-conn-icon"
          icon="⚙"
          label={t('conn.settings', 'Motion / GRBL settings')}
          onClick={onOpenSettings}
        />
      )}
    </span>
  )
}
