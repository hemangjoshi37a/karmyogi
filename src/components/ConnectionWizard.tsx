// X2 — Connection setup wizard (guided first-launch flow).
//
// A welcoming, 3-step guide shown ONCE on first launch (gated on the
// `configured` flag in the machineProfile store): pick a machine model →
// choose a transport (USB / Wi-Fi / Mock) and connect → suggest homing before
// jog. It reuses the existing connect machinery (`grbl.*`) and the machine
// profile library (X3) so picking "Genmitsu 3018-PRO" sets the bed + firmware in
// one step. SAFETY: the wizard never sends a motion command on its own — homing
// runs only when the operator clicks the explicit "Run homing" button.
//
// Self-gating: renders nothing unless setup is pending, so the app shell can mount
// it unconditionally (`<ConnectionWizard />`).

import { useEffect, useMemo, useState } from 'react'
import { Modal, ModalFootSpacer } from './Modal'
import { useT } from '../i18n'
import { grbl } from '../serial/controller'
import { MockPort } from '../serial'
import { UsbPort } from '../serial/usbPort'
import { useMachine } from '../store/machine'
import { useMachines } from '../store/machines'
import {
  useMachineProfile,
  MACHINE_MODELS,
  modelFor,
  type MachineModel,
} from '../store/machineProfile'
import { useBed } from '../store/bed'
import '../styles/connection.css'

type Step = 'model' | 'connect' | 'home'

const STANDARD_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 250000, 500000, 1000000] as const

export function ConnectionWizard() {
  const configured = useMachineProfile((s) => s.configured)
  const markConfigured = useMachineProfile((s) => s.markConfigured)
  const machines = useMachines((s) => s.machines)
  const connection = useMachine((s) => s.connection)
  const connected = connection === 'connected'

  // First-launch gate: a returning user (already has saved machines, or is
  // already connected) is treated as configured so the wizard never nags. Runs
  // once on mount — reopening via reopenSetup() keeps showing it because this
  // effect won't re-fire while mounted.
  useEffect(() => {
    if (!configured && (machines.length > 0 || connected)) markConfigured()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const show = !configured
  if (!show) return null
  return <WizardBody onClose={markConfigured} />
}

function WizardBody({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [step, setStep] = useState<Step>('model')

  const connection = useMachine((s) => s.connection)
  const connectError = useMachine((s) => s.error)
  const connected = connection === 'connected'
  const connecting = connection === 'connecting'

  const machineModelId = useMachineProfile((s) => s.machineModelId)
  const setMachineModel = useMachineProfile((s) => s.setMachineModel)
  const capabilities = useMachineProfile((s) => s.capabilities)
  const hasHoming = capabilities().hasHoming

  // When a connection comes up while we're on the connect step, advance to the
  // homing suggestion automatically.
  useEffect(() => {
    if (connected && step === 'connect') setStep('home')
  }, [connected, step])

  const finish = () => onClose()

  const stepIndex = step === 'model' ? 0 : step === 'connect' ? 1 : 2
  const titles = [
    t('cw.step.model', 'Choose your machine'),
    t('cw.step.connect', 'Connect'),
    t('cw.step.home', 'Home before you move'),
  ]

  const footer = (
    <>
      {step !== 'model' && (
        <button
          className="km-conn-btn"
          onClick={() => setStep(step === 'home' ? 'connect' : 'model')}
        >
          {t('cw.back', 'Back')}
        </button>
      )}
      <button className="km-conn-btn" onClick={finish}>
        {t('cw.skip', 'Skip setup')}
      </button>
      <ModalFootSpacer />
      {step === 'model' && (
        <button className="km-conn-btn primary" onClick={() => setStep('connect')}>
          {t('cw.next', 'Next')}
        </button>
      )}
      {step === 'connect' && (
        <button
          className="km-conn-btn primary"
          disabled={!connected}
          onClick={() => setStep('home')}
          title={
            connected
              ? undefined
              : t('cw.next.needConn', 'Connect to a machine to continue')
          }
        >
          {t('cw.next', 'Next')}
        </button>
      )}
      {step === 'home' && (
        <button className="km-conn-btn primary" onClick={finish}>
          {t('cw.finish', 'Finish')}
        </button>
      )}
    </>
  )

  return (
    <Modal
      open
      title={titles[stepIndex]}
      eyebrow={t('cw.eyebrow', 'Setup · step {n} of 3', { n: stepIndex + 1 })}
      onClose={finish}
      size="md"
      footer={footer}
    >
      <div className="km-cw">
        <StepDots index={stepIndex} />
        {step === 'model' && (
          <ModelStep selectedId={machineModelId} onPick={setMachineModel} />
        )}
        {step === 'connect' && (
          <ConnectStep
            connection={connection}
            connecting={connecting}
            connected={connected}
            error={connectError}
          />
        )}
        {step === 'home' && <HomeStep hasHoming={hasHoming} />}
      </div>
    </Modal>
  )
}

function StepDots({ index }: { index: number }) {
  return (
    <div className="km-cw-dots" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className="km-cw-dot" data-active={i === index} data-done={i < index} />
      ))}
    </div>
  )
}

// ─── Step 1: machine model ─────────────────────────────────────────────────────
function ModelStep({
  selectedId,
  onPick,
}: {
  selectedId: string | null
  onPick: (id: string | null) => void
}) {
  const t = useT()
  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)
  const selected = modelFor(selectedId)

  // Group by vendor for a tidy picker; generic/custom entries first.
  const groups = useMemo(() => {
    const byVendor = new Map<string, MachineModel[]>()
    for (const m of MACHINE_MODELS) {
      const key = m.vendor ?? (m.generic ? '' : 'Other')
      const arr = byVendor.get(key) ?? []
      arr.push(m)
      byVendor.set(key, arr)
    }
    return byVendor
  }, [])

  return (
    <div className="km-cw-step">
      <p className="km-cw-lead">
        {t(
          'cw.model.lead',
          'Pick your machine to set its work area and firmware automatically. You can change everything later.',
        )}
      </p>
      <label className="km-cw-field">
        <span className="km-cw-field-label">{t('cw.model.label', 'Machine model')}</span>
        <select
          className="km-conn-select km-cw-select"
          value={selectedId ?? ''}
          onChange={(e) => onPick(e.target.value || null)}
        >
          <option value="">{t('cw.model.none', 'Not sure / set up manually')}</option>
          {[...groups.entries()].map(([vendor, models]) =>
            vendor ? (
              <optgroup key={vendor} label={vendor}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))
            ),
          )}
        </select>
      </label>

      {selected && (
        <div className="km-cw-info">
          <div className="km-cw-info-row">
            <span className="km-cw-info-k">{t('cw.model.firmware', 'Firmware')}</span>
            <span className="km-cw-info-v">{selected.controllerKind}</span>
          </div>
          {selected.bed ? (
            <div className="km-cw-info-row">
              <span className="km-cw-info-k">{t('cw.model.bed', 'Work area')}</span>
              <span className="km-cw-info-v">
                {selected.bed.width} × {selected.bed.depth} × {selected.bed.height} mm
              </span>
            </div>
          ) : (
            <div className="km-cw-info-row">
              <span className="km-cw-info-k">{t('cw.model.bed', 'Work area')}</span>
              <span className="km-cw-info-v">
                {t('cw.model.bedKept', '{w} × {d} × {h} mm (your current bed — unchanged)', {
                  w: bedW,
                  d: bedD,
                  h: bedH,
                })}
              </span>
            </div>
          )}
          {selected.notes && <p className="km-cw-note">{selected.notes}</p>}
        </div>
      )}
    </div>
  )
}

// ─── Step 2: transport + connect ───────────────────────────────────────────────
function ConnectStep({
  connection,
  connecting,
  connected,
  error,
}: {
  connection: string
  connecting: boolean
  connected: boolean
  error: string | null
}) {
  const t = useT()
  const baudOverride = useMachineProfile((s) => s.baudOverride)
  const setBaudOverride = useMachineProfile((s) => s.setBaudOverride)
  const profile = useMachineProfile((s) => s.profile)()
  const effectiveBaud = baudOverride ?? profile.baud

  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [wifiErr, setWifiErr] = useState<string | null>(null)

  const serialSupported = typeof navigator !== 'undefined' && !!navigator.serial
  const usbOtgSupported = !serialSupported && UsbPort.isSupported()
  const usbSupported = serialSupported || usbOtgSupported

  const connectUsb = () => {
    if (serialSupported) grbl.connect().catch(() => {})
    else grbl.connectUsbOtg().catch(() => {})
  }
  const connectWifi = () => {
    setWifiErr(null)
    const h = host.trim()
    if (!h) return
    const p = port.trim() ? Number(port.trim()) : undefined
    if (p != null && (!Number.isFinite(p) || p < 1 || p > 65535)) {
      setWifiErr(t('cw.wifi.badPort', 'Port must be between 1 and 65535.'))
      return
    }
    grbl.connectWebSocket(h, { defaultPort: p }).catch((err) => {
      setWifiErr(err instanceof Error ? err.message : String(err))
    })
  }
  const connectMock = () => {
    grbl.connect(new MockPort(), { meta: { kind: 'mock', label: 'Mock' } }).catch(() => {})
  }

  if (connected) {
    return (
      <div className="km-cw-step">
        <div className="km-cw-status km-cw-status--ok">
          <span className="km-cw-status-dot" data-conn="connected" />
          <span>{t('cw.connect.connected', 'Connected. Continue to the next step.')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="km-cw-step">
      <p className="km-cw-lead">
        {t('cw.connect.lead', 'How is your machine attached? Pick a connection to bring it online.')}
      </p>

      {/* USB */}
      <div className="km-cw-card">
        <div className="km-cw-card-head">
          <span className="km-cw-card-title">{t('cw.usb', 'USB cable')}</span>
          <span className="km-cw-card-sub">
            {serialSupported
              ? t('cw.usb.sub', 'Web Serial — the standard wired connection.')
              : usbOtgSupported
                ? t('cw.usb.subOtg', 'WebUSB (USB-OTG) — plug into your phone with an OTG adapter.')
                : t('cw.usb.subNone', 'No USB API in this browser — use Wi-Fi or Mock.')}
          </span>
        </div>
        <div className="km-cw-card-row">
          <label className="km-cw-baud">
            <span>{t('cw.usb.baud', 'Baud')}</span>
            <select
              className="km-conn-select"
              value={String(effectiveBaud)}
              onChange={(e) => {
                const n = Number(e.target.value)
                setBaudOverride(n === profile.baud ? null : n)
              }}
              aria-label={t('cw.usb.baud', 'Baud')}
            >
              {STANDARD_BAUDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === profile.baud ? ` — ${t('cw.usb.baudDefault', 'default')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            className="km-conn-btn primary"
            disabled={connecting || !usbSupported}
            onClick={connectUsb}
          >
            {connecting ? t('cw.connecting', 'Connecting…') : t('cw.usb.connect', 'Connect USB')}
          </button>
        </div>
      </div>

      {/* Wi-Fi */}
      <div className="km-cw-card">
        <div className="km-cw-card-head">
          <span className="km-cw-card-title">{t('cw.wifi', 'Wi-Fi (WebSocket)')}</span>
          <span className="km-cw-card-sub">
            {t('cw.wifi.sub', 'For FluidNC / ESP3D / MKS DLC32. Leave port blank to auto-detect.')}
          </span>
        </div>
        <div className="km-cw-card-row">
          <input
            className="km-cw-input"
            type="text"
            inputMode="url"
            placeholder={t('cw.wifi.host', 'Host or IP (e.g. 192.168.1.50)')}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') connectWifi()
            }}
          />
          <input
            className="km-cw-input km-cw-input--port"
            type="text"
            inputMode="numeric"
            placeholder={t('cw.wifi.port', 'Port')}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') connectWifi()
            }}
          />
          <button
            className="km-conn-btn primary"
            disabled={connecting || !host.trim()}
            onClick={connectWifi}
          >
            {t('cw.wifi.connect', 'Connect')}
          </button>
        </div>
        {wifiErr && <div className="km-cw-err">{wifiErr}</div>}
      </div>

      {/* Mock */}
      <div className="km-cw-card">
        <div className="km-cw-card-head">
          <span className="km-cw-card-title">{t('cw.mock', 'Mock device')}</span>
          <span className="km-cw-card-sub">
            {t('cw.mock.sub', 'In-browser GRBL simulator — explore the app with no hardware.')}
          </span>
        </div>
        <div className="km-cw-card-row">
          <span className="km-cw-spacer" />
          <button className="km-conn-btn" disabled={connecting} onClick={connectMock}>
            {t('cw.mock.connect', 'Try the simulator')}
          </button>
        </div>
      </div>

      {error && connection === 'disconnected' && <div className="km-cw-err">{error}</div>}
    </div>
  )
}

// ─── Step 3: homing suggestion ─────────────────────────────────────────────────
function HomeStep({ hasHoming }: { hasHoming: boolean }) {
  const t = useT()
  const detectedModelId = useMachineProfile((s) => s.detectedModelId)
  const machineModelId = useMachineProfile((s) => s.machineModelId)
  const setMachineModel = useMachineProfile((s) => s.setMachineModel)
  const machineState = useMachine((s) => s.state)
  const [homed, setHomed] = useState(false)

  const detected = !machineModelId && detectedModelId ? modelFor(detectedModelId) : null

  const runHoming = () => {
    // Operator-confirmed homing — the only motion the wizard ever triggers.
    grbl.home()
    setHomed(true)
  }

  return (
    <div className="km-cw-step">
      {detected && (
        <div className="km-cw-info km-cw-detected">
          <p className="km-cw-note">
            {t('cw.detected', 'Detected a {label} from the firmware. Apply its work area?', {
              label: detected.label,
            })}
          </p>
          <button className="km-conn-btn" onClick={() => setMachineModel(detected.id)}>
            {t('cw.detected.apply', 'Apply {label}', { label: detected.label })}
          </button>
        </div>
      )}

      {hasHoming ? (
        <>
          <p className="km-cw-lead">
            {t(
              'cw.home.lead',
              'Run a homing cycle so the machine knows where it is. Homing finds the limit switches and sets a reliable origin — do this before jogging or running a job.',
            )}
          </p>
          <div className="km-cw-card">
            <div className="km-cw-card-head">
              <span className="km-cw-card-title">{t('cw.home.title', 'Home the machine')}</span>
              <span className="km-cw-card-sub">
                {t(
                  'cw.home.sub',
                  'Sends $H. Make sure the area is clear and limit switches are wired. You confirm each move.',
                )}
              </span>
            </div>
            <div className="km-cw-card-row">
              <span className="km-cw-state">
                {homed
                  ? t('cw.home.sent', 'Homing started — state: {state}', { state: machineState })
                  : t('cw.home.idle', 'Machine state: {state}', { state: machineState })}
              </span>
              <button className="km-conn-btn primary" onClick={runHoming}>
                {t('cw.home.run', 'Run homing ($H)')}
              </button>
            </div>
          </div>
          <p className="km-cw-note">
            {t(
              'cw.home.skip',
              'No limit switches? Skip homing — but set your work zero manually before cutting.',
            )}
          </p>
        </>
      ) : (
        <p className="km-cw-lead">
          {t(
            'cw.home.noHoming',
            'This controller has no homing cycle. Set your work zero manually before running a job.',
          )}
        </p>
      )}
    </div>
  )
}
