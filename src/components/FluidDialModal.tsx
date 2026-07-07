import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { RotateCcw, Save, Download, AlertTriangle, Gauge, Cable } from 'lucide-react'
import { useT } from '../i18n'
import { grbl } from '../serial/controller'
import { useNotifications } from '../store/notifications'
import {
  parseConfig,
  stringifyConfig,
  readPendantUart,
  setPendantUart,
  validateUartPin,
  DEFAULT_PENDANT_UART,
  type PendantUart,
} from '../serial/fluidncConfig'
import type { Document } from 'yaml'
import '../styles/sd.css'

type Phase = 'loading' | 'ready' | 'applying' | 'done' | 'error'

/** Wait ms — lets the controller reboot before we re-read the config. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * FluidDial pendant setup. FluidDial is FluidNC's native encoder+display pendant;
 * it wires to a spare UART on the controller (RX/TX + GND), NOT to the browser. So
 * "setting it up" means enabling that UART channel in the controller's config.yaml:
 * we read the running config with `$CD`, write a `uart<N>` (pins/baud/mode) + a
 * matching `uart_channel<N>` (report cadence), PERSIST it (auto-backup → XMODEM
 * config.yaml → [ESP444]RESTART), then re-read to verify. FluidNC-only.
 */
export function FluidDialModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const notify = useNotifications((s) => s.notify)
  const docRef = useRef<Document | null>(null)
  const originalRef = useRef<string>('') // pristine config for backup + dirty check
  const [cfg, setCfg] = useState<PendantUart>(DEFAULT_PENDANT_UART)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  const load = useCallback(async () => {
    setPhase('loading')
    setError(null)
    setConfirming(false)
    if (!grbl.isFluidNC) {
      setError(
        t(
          'fd.needFluidnc',
          'FluidDial setup needs a FluidNC controller (it edits config.yaml). Connect a FluidNC board and try again.',
        ),
      )
      setPhase('error')
      return
    }
    try {
      const text = await grbl.readConfigDump()
      const doc = parseConfig(text)
      docRef.current = doc
      originalRef.current = stringifyConfig(doc)
      setCfg(readPendantUart(doc, DEFAULT_PENDANT_UART.uartNum))
      setPhase('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [t])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const set = <K extends keyof PendantUart>(key: K, value: PendantUart[K]) =>
    setCfg((c) => ({ ...c, [key]: value }))

  const downloadBackup = () => {
    const blob = new Blob([originalRef.current], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'config.backup.yaml'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const apply = async () => {
    if (!docRef.current) return
    setPendantUart(docRef.current, cfg)
    const yamlText = stringifyConfig(docRef.current)
    downloadBackup() // always keep a copy of the pristine config first
    setPhase('applying')
    setError(null)
    try {
      await grbl.writeFileViaXmodem('config.yaml', yamlText)
      await grbl.restartController()
      await wait(6000) // let the board reboot + re-read config
      const text = await grbl.readConfigDump()
      const doc = parseConfig(text)
      docRef.current = doc
      originalRef.current = stringifyConfig(doc)
      setCfg(readPendantUart(doc, DEFAULT_PENDANT_UART.uartNum))
      setPhase('done')
      notify('success', t('fd.applied', 'FluidDial UART written to the controller and verified after restart.'))
    } catch (e) {
      setPhase('error')
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      notify('error', t('fd.applyFailed', 'Config write/restart failed: {err}. Your backup was downloaded.', { err: msg }))
    }
  }

  const pinField = (key: 'txdPin' | 'rxdPin', label: string, hint: string) => {
    const warn = validateUartPin(cfg[key], key === 'txdPin' ? 'tx' : 'rx')
    return (
      <div>
        <label className="sd-pin-row" style={{ gridTemplateColumns: '96px 1fr' }}>
          <span className="sd-pin-axis" style={{ textAlign: 'left', fontSize: 12 }}>{label}</span>
          <input
            type="text"
            className="sd-pin-input"
            value={cfg[key] ?? ''}
            placeholder={t('fd.pinPh', 'e.g. gpio.16')}
            onChange={(e) => set(key, e.target.value)}
            aria-label={label}
            title={hint}
            spellCheck={false}
            data-warn={warn ? 'true' : undefined}
          />
        </label>
        {warn && (
          <p className="fd-pinwarn" role="alert">
            <AlertTriangle size={12} /> {warn}
          </p>
        )}
      </div>
    )
  }

  // Block the write when a pin is known-dangerous (would crash FluidNC on boot).
  const pinWarnings = [
    validateUartPin(cfg.txdPin, 'tx'),
    validateUartPin(cfg.rxdPin, 'rx'),
  ].filter(Boolean) as string[]
  const hasBlockingWarn = pinWarnings.length > 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('fd.title', 'FluidDial pendant (controller config)')}
      eyebrow={t('fd.eyebrow', 'FluidNC · config.yaml · UART')}
      initialFocusRef={closeRef}
      footer={
        <>
          <button ref={closeRef} type="button" className="sd-btn sd-btn--ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--ghost"
            onClick={() => void load()}
            disabled={phase === 'applying' || phase === 'loading'}
            title={t('fd.reread', 'Re-read the controller config')}
          >
            <RotateCcw size={14} /> {t('fd.rereadShort', 'Re-read')}
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            onClick={() => setConfirming(true)}
            disabled={phase === 'applying' || phase === 'loading' || phase === 'error' || hasBlockingWarn}
            title={
              hasBlockingWarn
                ? t('fd.applyBlocked', 'Fix the flagged pin(s) first — writing them would crash the controller.')
                : t('fd.apply', 'Apply to controller')
            }
          >
            <Save size={14} /> {t('fd.apply', 'Apply to controller')}
          </button>
        </>
      }
    >
      <div className="sd-modal">
        {phase === 'loading' ? (
          <div className="sd-state" role="status">
            <span className="km-panel-spinner" aria-hidden="true" />
            {t('fd.reading', 'Reading config from the controller ($CD)…')}
          </div>
        ) : phase === 'error' ? (
          <div className="sd-state sd-state--err">
            <AlertTriangle size={16} />
            <div>
              <div>{t('fd.error', 'Could not read/write the controller config.')}</div>
              <div className="sd-state-detail">{error}</div>
              <button type="button" className="sd-btn sd-btn--ghost" onClick={() => void load()} style={{ marginTop: 8 }}>
                {t('fd.retry', 'Retry')}
              </button>
            </div>
          </div>
        ) : phase === 'applying' ? (
          <div className="sd-state" role="status">
            <span className="km-panel-spinner" aria-hidden="true" />
            {t('fd.applying', 'Writing config.yaml + restarting the controller… (~6 s)')}
          </div>
        ) : (
          <>
            <p className="sd-note">
              {t(
                'fd.intro',
                'FluidDial is FluidNC’s native dial pendant. It connects to a spare UART on the CONTROLLER (not to this browser). This enables that UART channel in config.yaml.',
              )}
            </p>

            {/* Wiring guidance */}
            <div className="fd-wire">
              <span className="fd-wire-head">
                <Cable size={14} /> {t('fd.wiring', 'Wiring (crossed)')}
              </span>
              <ul className="fd-wire-list">
                <li>{t('fd.wire.tx', 'Controller TXD pin → Dial RX')}</li>
                <li>{t('fd.wire.rx', 'Controller RXD pin → Dial TX')}</li>
                <li>{t('fd.wire.gnd', 'GND → GND, and 5V → the dial’s 5V/VIN')}</li>
              </ul>
            </div>

            {/* Pin fields */}
            <div className="sd-pin-grid">
              {pinField('txdPin', t('fd.txd', 'TXD pin'), t('fd.txdHint', 'Controller transmit pin → Dial RX. Format gpio.NN'))}
              {pinField('rxdPin', t('fd.rxd', 'RXD pin'), t('fd.rxdHint', 'Controller receive pin → Dial TX. Format gpio.NN'))}
            </div>

            {/* Numeric params */}
            <div className="fd-nums">
              <label className="fd-num">
                <span className="fd-num-lbl"><Gauge size={13} /> {t('fd.baud', 'Baud')}</span>
                <input
                  type="number"
                  className="sd-pin-input"
                  value={cfg.baud}
                  min={2400}
                  step={100}
                  onChange={(e) => set('baud', Number(e.target.value) || 115200)}
                />
              </label>
              <label className="fd-num">
                <span className="fd-num-lbl">{t('fd.mode', 'Mode')}</span>
                <input
                  type="text"
                  className="sd-pin-input"
                  value={cfg.mode}
                  placeholder="8N1"
                  onChange={(e) => set('mode', e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="fd-num">
                <span className="fd-num-lbl">{t('fd.report', 'Report ms')}</span>
                <input
                  type="number"
                  className="sd-pin-input"
                  value={cfg.reportIntervalMs}
                  min={10}
                  step={5}
                  title={t('fd.reportHint', 'How often the controller pushes a status report to the dial (75 ms is smooth).')}
                  onChange={(e) => set('reportIntervalMs', Number(e.target.value) || 75)}
                />
              </label>
            </div>

            {phase === 'done' && (
              <p className="sd-note" style={{ color: 'var(--ok)' }}>
                {t('fd.doneNote', '✓ Written + verified after restart. Power the dial — it should connect within a few seconds.')}
              </p>
            )}

            {confirming ? (
              <div className="lc-confirm">
                <div className="lc-confirm-q">
                  <AlertTriangle size={15} />{' '}
                  {t('fd.confirmQ', 'This overwrites config.yaml on the controller and restarts it. A backup is downloaded first. Continue?')}
                </div>
                <div className="lc-confirm-actions">
                  <button type="button" className="sd-btn sd-btn--ghost" onClick={downloadBackup}>
                    <Download size={14} /> {t('fd.backup', 'Backup')}
                  </button>
                  <button type="button" className="sd-btn sd-btn--ghost" onClick={() => setConfirming(false)}>
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button type="button" className="sd-btn sd-btn--primary" onClick={() => void apply()}>
                    {t('fd.confirmApply', 'Backup & write')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="sd-note">
                {t(
                  'fd.note',
                  'Enter the controller’s free UART pins (format gpio.NN). Applying writes uart{n} + uart_channel{n} to config.yaml and restarts the controller (~6 s). A backup downloads automatically.',
                  { n: cfg.uartNum },
                )}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
