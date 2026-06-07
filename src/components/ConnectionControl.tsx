import { useEffect, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { MockPort } from '../serial'
import { BlePort } from '../serial/blePort'
import { mixedContentReason, normalizeWsUrl } from '../serial/wsPort'
import { useMachine, useMachineProfile, usePersistentState, useMachines } from '../store'
import { CONTROLLER_LIST, profileFor, canLiveConnect } from '../machine/controllers'
import type { ControllerKind } from '../machine/types'
import { useT } from '../i18n'
import { IconButton } from './IconButton'
import { Icon } from './Icons'
import { FirmwareDrivers } from './FirmwareDrivers'
import '../styles/connect.css'

interface ConnectionControlProps {
  /** Open the Motion / GRBL settings modal. Renders a ⚙ button in the cluster. */
  onOpenSettings?: () => void
  /** Open the Probe & Limits modal. Renders a ⌖ probe button in the cluster. */
  onOpenProbe?: () => void
}

// --- small inline transport glyphs (Icons.tsx has no usb/wifi/ble glyph and is
// owned by another agent), drawn on the same 24×24 / 2px-stroke grid as Icon. ---
function TransportGlyph({ kind, size = 18 }: { kind: 'usb' | 'wifi' | 'ble'; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (kind === 'usb') {
    return (
      <svg {...common}>
        <path d="M12 3v15" />
        <path d="M12 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
        <path d="M12 7l2.5 2.5L12 12" />
        <path d="M12 11l-3 3v3" />
        <circle cx="9" cy="18" r="1.4" />
        <path d="M9.5 6.5L12 4l2.5 2.5z" />
      </svg>
    )
  }
  if (kind === 'wifi') {
    return (
      <svg {...common}>
        <path d="M5 12.5a10 10 0 0 1 14 0" />
        <path d="M8 15.5a6 6 0 0 1 8 0" />
        <path d="M11 18.5a2 2 0 0 1 2 0" />
        <circle cx="12" cy="20" r="0.6" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M8 7l8 5-8 5V2l8 5-8 5" />
    </svg>
  )
}

/**
 * Connection control for the top title bar: a controller selector, status dot +
 * machine state, a CONNECT MENU (USB / Wi-Fi / Bluetooth) + Mock / Disconnect, a
 * compact server-bridge ICON toggle, and a machine-FARM switcher.
 *
 * The single-machine flow is unchanged: USB Connect / Mock still call grbl.*
 * directly; those connections are auto-registered into the farm store via the
 * controller's onActiveChange hook, so the switcher reflects them. Wireless
 * (Wi-Fi/WebSocket + Bluetooth/BLE) reuse the same connect machinery.
 */
export function ConnectionControl({ onOpenSettings, onOpenProbe }: ConnectionControlProps = {}) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
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
      <FirmwareDrivers kind={controllerKind} />
      <span className="km-conn-dot" data-conn={connection} />
      <span className="km-conn-state">
        {/* Connection status only (Connected / Connecting / Disconnected) — the
            live Idle/Run/busy machine STATE is intentionally not shown here per
            the operator's request. */}
        {t(`conn.status.${connection}`, connection)}
      </span>
      {!connected ? (
        <>
          <ConnectMenu connecting={connecting} liveConnect={liveConnect} profileNotes={profile.notes} profileLabel={profile.label} />
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
        icon={<Icon name={bridgeActive ? 'connect' : 'disconnect'} size={15} />}
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
          iconName="probe"
          iconSize={15}
          label={t('conn.probe', 'Probe & limits')}
          onClick={onOpenProbe}
        />
      )}
      {onOpenSettings && (
        <IconButton
          className="km-conn-icon"
          iconName="settings"
          iconSize={15}
          label={t('conn.settings', 'Motion / GRBL settings')}
          onClick={onOpenSettings}
        />
      )}
    </span>
  )
}

interface ConnectMenuProps {
  connecting: boolean
  liveConnect: boolean
  profileLabel: string
  profileNotes: string
}

/**
 * The Connect menu: a primary button that opens a popover with the three
 * browser-possible transports — USB (Web Serial), Wi-Fi (WebSocket), and
 * Bluetooth (Web Bluetooth / BLE). Each transport is gated on its API being
 * available and on whether the selected firmware can live-connect.
 */
function ConnectMenu({ connecting, liveConnect, profileLabel, profileNotes }: ConnectMenuProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [wifiErr, setWifiErr] = useState<string | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

  const bleSupported = typeof navigator !== 'undefined' && BlePort.isSupported()
  const serialSupported = typeof navigator !== 'undefined' && !!navigator.serial
  const pageSecure = typeof location !== 'undefined' && location.protocol === 'https:'

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Live-preview the mixed-content verdict for whatever host the user typed, so
  // they see the ws://-from-https warning BEFORE clicking Connect.
  const wifiPreviewWarn = (() => {
    const h = host.trim()
    if (!h) return null
    try {
      const url = normalizeWsUrl(h, port.trim() ? Number(port.trim()) : 81)
      return mixedContentReason(url)
    } catch {
      return null
    }
  })()

  const connectUsb = () => {
    setOpen(false)
    grbl.connect().catch(() => {})
  }

  const connectWifi = () => {
    setWifiErr(null)
    const h = host.trim()
    if (!h) return
    const p = port.trim() ? Number(port.trim()) : undefined
    if (p != null && (!Number.isFinite(p) || p < 1 || p > 65535)) {
      setWifiErr(t('conn.wifi.badPort', 'Port must be a number between 1 and 65535.'))
      return
    }
    grbl
      .connectWebSocket(h, { defaultPort: p })
      .then(() => setOpen(false))
      .catch((err) => setWifiErr(err instanceof Error ? err.message : String(err)))
  }

  const connectBle = () => {
    setOpen(false)
    grbl.connectBluetooth().catch(() => {})
  }

  return (
    <span className="km-cx" ref={ref}>
      <button
        className="km-conn-btn primary km-cx-toggle"
        disabled={connecting}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={t('conn.connect.menu', 'Connect to the controller — USB, Wi-Fi, or Bluetooth')}
      >
        {connecting ? t('conn.connecting', 'Connecting…') : t('conn.connect', 'Connect')}
        <span className="km-cx-caret" aria-hidden="true">
          <Icon name="chevron-down" size={12} />
        </span>
      </button>
      {open && (
        <div className="km-cx-pop" role="menu">
          <div className="km-cx-head">{t('conn.connect.how', 'Connect to machine')}</div>

          {/* USB / Web Serial */}
          <button
            className="km-cx-row"
            role="menuitem"
            disabled={connecting || !liveConnect || !serialSupported}
            onClick={connectUsb}
            title={
              !serialSupported
                ? t('conn.usb.unsupported', 'Web Serial needs Chrome/Edge over HTTPS or localhost.')
                : liveConnect
                  ? t('conn.connect.title', 'Connect to the controller over USB (Web Serial)')
                  : t(
                      'conn.connect.unsupported',
                      '{name} can’t be driven live from a browser ({notes}). Use Mock to explore the UI, or generate G-code here and run it on the device.',
                      { name: profileLabel, notes: profileNotes },
                    )
            }
          >
            <span className="km-cx-row-ico"><TransportGlyph kind="usb" /></span>
            <span className="km-cx-row-txt">
              <span className="km-cx-row-title">{t('conn.usb', 'USB cable')}</span>
              <span className="km-cx-row-sub">
                {serialSupported
                  ? t('conn.usb.sub', 'Web Serial — the standard wired connection.')
                  : t('conn.usb.subUnsupported', 'Not available in this browser.')}
              </span>
            </span>
          </button>

          {/* Bluetooth / Web Bluetooth (BLE) */}
          <button
            className="km-cx-row"
            role="menuitem"
            disabled={connecting || !bleSupported}
            onClick={connectBle}
            title={
              bleSupported
                ? t('conn.ble.title', 'Connect over Bluetooth LE (Nordic UART / HM-10 style serial bridge)')
                : t(
                    'conn.ble.unsupported',
                    'Web Bluetooth isn’t available here — use Chrome/Edge over HTTPS (or localhost) with OS Bluetooth on.',
                  )
            }
          >
            <span className="km-cx-row-ico"><TransportGlyph kind="ble" /></span>
            <span className="km-cx-row-txt">
              <span className="km-cx-row-title">{t('conn.ble', 'Bluetooth')}</span>
              <span className="km-cx-row-sub">
                {bleSupported
                  ? t('conn.ble.sub', 'BLE serial bridge (Nordic UART / HM-10).')
                  : t('conn.ble.subUnsupported', 'Not available in this browser.')}
              </span>
            </span>
          </button>

          <div className="km-cx-sep" aria-hidden="true" />

          {/* Wi-Fi / WebSocket */}
          <div className="km-cx-form">
            <div className="km-cx-form-title">
              <span className="km-cx-row-ico" style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: 6 }}>
                <TransportGlyph kind="wifi" size={15} />
              </span>
              {t('conn.wifi', 'Wi-Fi (WebSocket)')}
            </div>
            <div className="km-cx-form-rowwrap">
              <input
                className="km-cx-input"
                type="text"
                inputMode="url"
                placeholder={t('conn.wifi.host', 'Host or IP (e.g. 192.168.1.50)')}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') connectWifi()
                }}
              />
              <input
                className="km-cx-input km-cx-port"
                type="text"
                inputMode="numeric"
                placeholder={t('conn.wifi.port', 'Port 81')}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') connectWifi()
                }}
              />
            </div>
            <button
              className="km-conn-btn primary km-cx-go"
              disabled={connecting || !host.trim()}
              onClick={connectWifi}
            >
              {t('conn.wifi.connect', 'Connect over Wi-Fi')}
            </button>
            {wifiErr && <div className="km-cx-note err">{wifiErr}</div>}
            {!wifiErr && wifiPreviewWarn && (
              <div className="km-cx-note warn">{wifiPreviewWarn}</div>
            )}
            {!wifiErr && !wifiPreviewWarn && (
              <div className="km-cx-note">
                {pageSecure
                  ? t(
                      'conn.wifi.hintSecure',
                      'For ESP3D / FluidNC / MKS DLC32. On this secure (https) page only wss:// controllers work — a plain ws:// device is blocked by the browser; run karmyogi over http on your LAN to reach it.',
                    )
                  : t(
                      'conn.wifi.hint',
                      'For ESP3D / FluidNC / MKS DLC32 (default WebSocket port 81). Bare host → ws://host:81/.',
                    )}
              </div>
            )}
            <div className="km-cx-note">
              {t(
                'conn.telnet.note',
                'Telnet (raw TCP, port 23) can’t be opened from a browser — there is no API. It needs a WebSocket↔TCP bridge/relay; use Wi-Fi (WebSocket) above, which covers ESP3D / FluidNC networked GRBL.',
              )}
            </div>
          </div>
        </div>
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

  // Warn (don't block) when the typed endpoint would be blocked as ws:// mixed
  // content from this https page — the WsPort will reject with the same message.
  const addWarn = (() => {
    const u = url.trim()
    if (!u) return null
    try {
      const full = /^wss?:\/\//i.test(u) ? u : normalizeWsUrl(u)
      return mixedContentReason(full)
    } catch {
      return null
    }
  })()

  const submitWs = () => {
    const u = url.trim()
    if (!u) return
    // Normalize a bare host / host:port to a scheme-prefixed URL (wss:// on https
    // pages, ws:// otherwise). A full ws(s):// URL passes through unchanged.
    const full = /^wss?:\/\//i.test(u) ? u : normalizeWsUrl(u)
    onAddWs(full, label.trim() || undefined)
    setUrl('')
    setLabel('')
    setOpen(false)
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
        <span className="km-farm-caret" aria-hidden="true">
          <Icon name="chevron-down" size={13} />
        </span>
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
                  <Icon name="close" size={13} />
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
                placeholder="192.168.1.50:81"
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
            {addWarn && <div className="km-cx-note warn">{addWarn}</div>}
            <div className="km-farm-hint">
              {t(
                'conn.machine.wsHint',
                'ESP3D / FluidNC / grblHAL-over-WebSocket / a serial↔ws bridge. Telnet needs a ws↔telnet bridge.',
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
