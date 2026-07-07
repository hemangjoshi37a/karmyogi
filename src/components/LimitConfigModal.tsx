import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { ArrowLeftRight, RotateCcw, Save, Download, AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'
import { grbl } from '../serial/controller'
import { useNotifications } from '../store/notifications'
import {
  parseConfig,
  readAxisLimits,
  setAxisLimitPin,
  swapAxisLimits,
  stringifyConfig,
  type AxisLimits,
  type LimitKey,
} from '../serial/fluidncConfig'
import type { Document } from 'yaml'
import '../styles/sd.css'

type Phase = 'loading' | 'ready' | 'applying' | 'done' | 'error'

/** Wait ms — used to let the controller reboot before we re-read the config. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * FluidNC limit-pin config editor. Reads the running config with `$CD`, lets the
 * operator swap neg↔pos or edit a limit pin per axis, then PERSISTS it to the
 * controller: auto-backup → XMODEM-write config.yaml → [ESP444]RESTART → re-read
 * to verify. Limit pins aren't runtime-settable, so this is the only way to make
 * a rebinding stick on the board (and be readable by an offline pendant).
 */
export function LimitConfigModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const notify = useNotifications((s) => s.notify)
  const docRef = useRef<Document | null>(null)
  const originalRef = useRef<string>('') // pristine config for backup + dirty check
  const [rows, setRows] = useState<AxisLimits[]>([])
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  const refreshRows = useCallback(() => {
    if (docRef.current) setRows(readAxisLimits(docRef.current))
  }, [])

  const load = useCallback(async () => {
    setPhase('loading')
    setError(null)
    setConfirming(false)
    try {
      const text = await grbl.readConfigDump()
      const doc = parseConfig(text)
      docRef.current = doc
      originalRef.current = stringifyConfig(doc)
      setRows(readAxisLimits(doc))
      setPhase('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const dirty = phase === 'ready' && docRef.current
    ? stringifyConfig(docRef.current) !== originalRef.current
    : false

  const onSwap = (axis: string) => {
    if (!docRef.current) return
    swapAxisLimits(docRef.current, axis)
    refreshRows()
  }
  const onEditPin = (axis: string, key: LimitKey, value: string) => {
    if (!docRef.current) return
    setAxisLimitPin(docRef.current, axis, key, value)
    refreshRows()
  }
  const revertEdits = () => {
    docRef.current = parseConfig(originalRef.current)
    refreshRows()
    setConfirming(false)
  }

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
    const yamlText = stringifyConfig(docRef.current)
    downloadBackup() // always keep a copy of the pristine config first
    setPhase('applying')
    setError(null)
    try {
      await grbl.writeFileViaXmodem('config.yaml', yamlText)
      await grbl.restartController()
      // Give the board ~6 s to reboot + re-read config, then verify by re-reading.
      await wait(6000)
      const text = await grbl.readConfigDump()
      const doc = parseConfig(text)
      docRef.current = doc
      originalRef.current = stringifyConfig(doc)
      setRows(readAxisLimits(doc))
      setPhase('done')
      notify('success', t('lc.applied', 'Limit pins written to the controller and verified after restart.'))
    } catch (e) {
      setPhase('error')
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      notify('error', t('lc.applyFailed', 'Config write/restart failed: {err}. Your backup was downloaded.', { err: msg }))
    }
  }

  const pinCell = (axis: string, key: LimitKey, value: string | null) => (
    <input
      type="text"
      className="sd-pin-input"
      value={value ?? ''}
      placeholder={t('lc.noPin', '— none —')}
      onChange={(e) => onEditPin(axis, key, e.target.value)}
      aria-label={`${axis} ${key}`}
      spellCheck={false}
    />
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('lc.title', 'Limit pins (controller config)')}
      eyebrow={t('lc.eyebrow', 'FluidNC · config.yaml')}
      initialFocusRef={closeRef}
      footer={
        <>
          <button ref={closeRef} type="button" className="sd-btn sd-btn--ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--ghost"
            onClick={revertEdits}
            disabled={!dirty || phase === 'applying'}
            title={t('lc.revert', 'Discard edits (back to the controller’s current config)')}
          >
            <RotateCcw size={14} /> {t('lc.revertShort', 'Revert')}
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            onClick={() => setConfirming(true)}
            disabled={!dirty || phase === 'applying' || phase === 'loading'}
          >
            <Save size={14} /> {t('lc.apply', 'Apply to controller')}
          </button>
        </>
      }
    >
      <div className="sd-modal">
        {phase === 'loading' ? (
          <div className="sd-state" role="status">
            <span className="km-panel-spinner" aria-hidden="true" />
            {t('lc.reading', 'Reading config from the controller ($CD)…')}
          </div>
        ) : phase === 'error' ? (
          <div className="sd-state sd-state--err">
            <AlertTriangle size={16} />
            <div>
              <div>{t('lc.error', 'Could not read/write the controller config.')}</div>
              <div className="sd-state-detail">{error}</div>
              <button type="button" className="sd-btn sd-btn--ghost" onClick={() => void load()} style={{ marginTop: 8 }}>
                {t('lc.retry', 'Retry')}
              </button>
            </div>
          </div>
        ) : phase === 'applying' ? (
          <div className="sd-state" role="status">
            <span className="km-panel-spinner" aria-hidden="true" />
            {t('lc.applying', 'Writing config.yaml + restarting the controller… (~6 s)')}
          </div>
        ) : (
          <>
            <div className="sd-pin-grid" role="table">
              <div className="sd-pin-head" role="row">
                <span>{t('lc.axis', 'Axis')}</span>
                <span>{t('lc.neg', 'limit_neg_pin (−)')}</span>
                <span>{t('lc.pos', 'limit_pos_pin (+)')}</span>
                <span></span>
              </div>
              {rows.length === 0 ? (
                <div className="sd-state">{t('lc.noAxes', 'No axes with limit pins found in the config.')}</div>
              ) : (
                rows.map((r) => (
                  <div className="sd-pin-row" role="row" key={r.axisKey}>
                    <span className="sd-pin-axis">{r.axis}</span>
                    {pinCell(r.axisKey, 'limit_neg_pin', r.negPin)}
                    {pinCell(r.axisKey, 'limit_pos_pin', r.posPin)}
                    <button
                      type="button"
                      className="sd-icon-btn"
                      onClick={() => onSwap(r.axisKey)}
                      title={t('lc.swap', 'Swap − ↔ + (switch wired to the wrong end)')}
                      aria-label={t('lc.swapAria', 'Swap {axis} neg/pos limit pins', { axis: r.axis })}
                    >
                      <ArrowLeftRight size={15} />
                    </button>
                  </div>
                ))
              )}
            </div>

            {phase === 'done' && (
              <p className="sd-note" style={{ color: 'var(--ok)' }}>
                {t('lc.doneNote', '✓ Written + verified after restart. Trigger a switch to confirm the right tile lights.')}
              </p>
            )}

            {confirming ? (
              <div className="lc-confirm">
                <div className="lc-confirm-q">
                  <AlertTriangle size={15} />{' '}
                  {t('lc.confirmQ', 'This overwrites config.yaml on the controller and restarts it. A backup is downloaded first. Continue?')}
                </div>
                <div className="lc-confirm-actions">
                  <button type="button" className="sd-btn sd-btn--ghost" onClick={downloadBackup}>
                    <Download size={14} /> {t('lc.backup', 'Backup')}
                  </button>
                  <button type="button" className="sd-btn sd-btn--ghost" onClick={() => setConfirming(false)}>
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button type="button" className="sd-btn sd-btn--primary" onClick={() => void apply()}>
                    {t('lc.confirmApply', 'Backup & write')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="sd-note">
                {t('lc.note', 'Edit a pin (format gpio.NN:low:pu) or swap − ↔ +. Limit pins aren’t runtime-settable, so applying writes config.yaml and restarts the controller (~6 s). A backup downloads automatically.')}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
