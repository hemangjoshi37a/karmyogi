import { useEffect, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { MockPort } from '../serial'
import { useMachine, useMachineProfile, usePersistentState, useMachines } from '../store'
import { CONTROLLER_LIST, profileFor, canLiveConnect } from '../machine/controllers'
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
 * machine state, Connect / Mock / Disconnect, a compact server-bridge ICON
 * toggle, and a machine-FARM switcher (the active machine identifier + a menu of
 * saved machines to switch between, plus adding a WebSocket-attached machine).
 *
 * The single-machine flow is unchanged: Connect/Mock still call grbl.* directly;
 * those connections are auto-registered into the farm store via the controller's
 * onActiveChange hook, so the switcher reflects them without any extra steps.
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
  // Server bridge toggle — same persisted flag the App shell reads to mount the
  // relay hook. Opt-in, default OFF; persists once enabled.
  const [bridge, setBridge] = usePersistentState('karmyogi.machineBridge.enabled', false)
  const bridgeActive = bridge && connected

  // --- machine farm ---
  const machines = useMachines((s) => s.machines)
  const activeId = useMachines((s) => s.activeId)
  const addMachine = useMachines((s) => s.addMachine)
  const removeMachine = useMachines((s) => s.removeMachine)
  const connectMachine = useMachines((s) => s.connectMachine)
  const activeEntry = machines.find((m) => m.id === activeId) ?? null

  const profile = profileFor(controllerKind)
  const experimental = profile.supported === 'experimental'
  // Can we attempt a REAL (non-mock) USB connection to this firmware? Proprietary
  // controllers (Ruida / EzCAD / FSCUT / Masso) can't stream live in a browser, so
  // the live Connect button is gated and points users to Mock / export instead.
  const liveConnect = canLiveConnect(profile)
  // Lock the selector while a connection is active or being established.
  const selectDisabled = connected || connecting

  // Active machine identifier shown in the appbar (label / port / URL).
  const activeLabel = connected
    ? activeEntry?.label ?? grbl.activePort.label ?? t('conn.machine.thisDevice', 'This machine')
    : null

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
            disabled={connecting || !liveConnect}
            onClick={() => grbl.connect().catch(() => {})}
            title={
              liveConnect
                ? t('conn.connect.title', 'Connect to the controller over USB (Web Serial)')
                : t(
                    'conn.connect.unsupported',
                    '{name} can’t be driven live from a browser ({notes}). Use Mock to explore the UI, or generate G-code here and run it on the device.',
                    { name: profile.label, notes: profile.notes },
                  )
            }
          >
            {connecting ? t('conn.connecting', 'Connecting…') : t('conn.connect', 'Connect')}
          </button>
          <button
            className="km-conn-btn"
            disabled={connecting}
            onClick={() => grbl.connect(new MockPort(), { meta: { kind: 'mock', label: 'Mock' } }).catch(() => {})}
            title={t('conn.mock.title', 'Connect to an in-browser mock GRBL device (no hardware)')}
          >
            {t('conn.mock', 'Mock')}
          </button>
          {!liveConnect && (
            <span
              className="km-conn-state"
              data-experimental="true"
              title={profile.notes}
            >
              {t('conn.connect.exportOnly', 'export / Mock only')}
            </span>
          )}
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

      <MachineSwitcher
        activeLabel={activeLabel}
        machines={machines}
        activeId={activeId}
        connecting={connecting}
        onSwitch={(id) => void connectMachine(id)}
        onRemove={(id) => removeMachine(id)}
        onAddWs={(url, label) => {
          const id = addMachine({ kind: 'websocket', url, label })
          void connectMachine(id)
        }}
        addMock={() => {
          const id = addMachine({ kind: 'mock', label: 'Mock' })
          void connectMachine(id)
        }}
      />

      <IconButton
        className="km-conn-icon"
        icon="🛰"
        data-active={bridgeActive ? 'true' : undefined}
        aria-pressed={bridge}
        onClick={() => setBridge((b) => !b)}
        label={t(
          'conn.bridge.title',
          'Server bridge: relay this browser’s machine to the karmyogi dev server so it can read state and send commands',
        ) + (bridge ? (bridgeActive ? ' — ON' : ' — ON (idle)') : ' — OFF')}
      />
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

interface MachineSwitcherProps {
  activeLabel: string | null
  machines: ReturnType<typeof useMachines.getState>['machines']
  activeId: string | null
  connecting: boolean
  onSwitch: (id: string) => void
  onRemove: (id: string) => void
  onAddWs: (url: string, label?: string) => void
  addMock: () => void
}

/**
 * Compact farm switcher: a button showing the active machine identifier; opens a
 * popover listing saved machines (click to switch / connect) and a form to add a
 * WebSocket-attached machine (ESP3D / grblHAL-ws / a serial↔ws bridge).
 */
function MachineSwitcher({
  activeLabel,
  machines,
  activeId,
  connecting,
  onSwitch,
  onRemove,
  onAddWs,
  addMock,
}: MachineSwitcherProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const submitWs = () => {
    const u = url.trim()
    if (!u) return
    try {
      // Surface obviously-bad URLs early (WsPort also validates).
      if (!/^wss?:\/\//i.test(u)) {
        // Allow bare host:port → default to ws://
        onAddWs(`ws://${u}`, label.trim() || undefined)
      } else {
        onAddWs(u, label.trim() || undefined)
      }
      setUrl('')
      setLabel('')
      setOpen(false)
    } catch {
      /* WsPort ctor validation surfaces via the entry error */
    }
  }

  return (
    <span className="km-farm" ref={ref}>
      <button
        className="km-conn-btn km-farm-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={t('conn.machine.switch', 'Machines — switch the active machine or add one')}
      >
        <span className="km-farm-id">{activeLabel ?? t('conn.machine.none', 'Machines')}</span>
        <span className="km-farm-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="km-farm-pop">
          <div className="km-farm-head">{t('conn.machine.farm', 'Machine farm')}</div>
          <div className="km-farm-list">
            {machines.length === 0 && (
              <div className="km-farm-empty">
                {t('conn.machine.empty', 'No machines yet. Connect, or add one below.')}
              </div>
            )}
            {machines.map((m) => (
              <div
                key={m.id}
                className="km-farm-item"
                data-active={m.id === activeId ? 'true' : undefined}
              >
                <button
                  className="km-farm-pick"
                  disabled={connecting}
                  onClick={() => onSwitch(m.id)}
                  title={
                    m.kind === 'websocket'
                      ? m.url
                      : t('conn.machine.connectThis', 'Switch to and connect this machine')
                  }
                >
                  <span className="km-farm-dot" data-status={m.status} />
                  <span className="km-farm-name">{m.label}</span>
                  <span className="km-farm-kind">{m.kind}</span>
                </button>
                <button
                  className="km-farm-del"
                  aria-label={t('conn.machine.remove', 'Remove machine')}
                  title={t('conn.machine.remove', 'Remove machine')}
                  onClick={() => onRemove(m.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="km-farm-add">
            <div className="km-farm-add-title">{t('conn.machine.addWs', 'Add WebSocket machine')}</div>
            <input
              className="km-farm-input"
              type="text"
              placeholder={t('conn.machine.label', 'Label (optional)')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <div className="km-farm-add-row">
              <input
                className="km-farm-input"
                type="text"
                placeholder="ws://192.168.1.50:81/"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitWs()
                }}
              />
              <button className="km-conn-btn primary" disabled={!url.trim()} onClick={submitWs}>
                {t('conn.machine.add', 'Add')}
              </button>
            </div>
            <div className="km-farm-hint">
              {t(
                'conn.machine.wsHint',
                'ESP3D / grblHAL-over-WebSocket / a serial↔ws bridge. Telnet needs a ws↔telnet bridge.',
              )}
            </div>
            <button className="km-conn-btn km-farm-mock" onClick={addMock}>
              {t('conn.machine.addMock', '+ Add a Mock machine')}
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
