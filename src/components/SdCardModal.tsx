import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icons'
import { useT } from '../i18n'
import { grbl } from '../serial/controller'
import { useProgram } from '../store/program'
import { useNotifications } from '../store/notifications'
import { useMachine } from '../store/machine'
import '../styles/sd.css'

interface SdFile {
  name: string
  size: number
}

/** Human-readable byte size (e.g. 2.0 KB). */
function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * SD-card file browser for a FluidNC (or grblHAL) controller. Opened from the
 * Program tab's Sections header. Lets the operator:
 *   - browse the G-code files on the controller's SD card (`$SD/List`),
 *   - MULTI-SELECT one or more and load them into the Program tab's Sections
 *     (`$SD/Show` → one section per file), so a CAM-less / pendant workflow can
 *     reuse files already on the card,
 *   - run a file DIRECTLY on the controller (`$SD/Run`) — the offline-pendant
 *     path, where karmyogi isn't needed during the cut,
 *   - delete a file (`$SD/Delete`).
 *
 * All commands go over the existing serial/Wi-Fi/BLE link via the controller's
 * capture API; nothing here is hardware-specific beyond the FluidNC command set.
 */
export function SdCardModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const notify = useNotifications((s) => s.notify)
  // If the controller booted without its config (panic-skip), the SD SPI pins
  // aren't set, so the card can never mount — surface THAT, not a generic error.
  const configError = useMachine((s) => s.configError)

  const [files, setFiles] = useState<SdFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false) // a load/run/delete is in flight
  const [restoring, setRestoring] = useState(false)
  const restoreRef = useRef<HTMLInputElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Recovery from the panic-skip state: write a known-good config.yaml (the
  // operator's downloaded backup) back to the controller over XMODEM + restart.
  // This is the ONE path that fixes a board stuck on the default/empty config.
  const restoreConfig = async (file: File) => {
    setRestoring(true)
    try {
      const text = await file.text()
      if (!/\S/.test(text)) throw new Error('That file is empty.')
      await grbl.writeFileViaXmodem('config.yaml', text)
      await grbl.restartController()
      notify('success', t('sd.restored', 'config.yaml restored ({name}) — restarting the controller. Give it ~6 s, then it should boot with its real config.', { name: file.name }))
    } catch (e) {
      notify('error', t('sd.restoreFailed', 'Restore failed: {err}', { err: e instanceof Error ? e.message : String(e) }))
    } finally {
      setRestoring(false)
      if (restoreRef.current) restoreRef.current.value = ''
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await grbl.listSdFiles()
      // Show G-code-like files first, but keep everything (the card may hold any).
      list.sort((a, b) => a.name.localeCompare(b.name))
      setFiles(list)
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch the listing each time the modal opens.
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const allSelected = files.length > 0 && selected.size === files.length
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(files.map((f) => f.name)))

  // Load every selected file as its own Program section (one $SD/Show each).
  const loadSelected = async () => {
    const names = files.filter((f) => selected.has(f.name)).map((f) => f.name)
    if (names.length === 0) return
    setBusy(true)
    let ok = 0
    let failed: string[] = []
    for (const name of names) {
      try {
        const gcode = await grbl.readSdFile(name)
        if (gcode.trim() === '') {
          failed.push(name)
          continue
        }
        setProgram(name, gcode)
        ok++
      } catch {
        failed.push(name)
      }
    }
    setBusy(false)
    if (ok > 0) {
      notify(
        'success',
        t('sd.loaded', 'Loaded {n} file(s) from the SD card into Sections.', { n: ok }),
      )
    }
    if (failed.length > 0) {
      notify(
        'error',
        t('sd.loadFailed', 'Could not read: {names} (machine must be Idle).', {
          names: failed.join(', '),
        }),
      )
    }
    if (ok > 0 && failed.length === 0) onClose()
  }

  // Run a file directly on the controller from its SD card ($SD/Run).
  const runOnMachine = async (name: string) => {
    setBusy(true)
    try {
      await grbl.runSdFile(name)
      notify('info', t('sd.running', 'Running {name} from the SD card on the controller.', { name }))
      onClose()
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteFile = async (name: string) => {
    setBusy(true)
    try {
      await grbl.deleteSdFile(name)
      notify('success', t('sd.deleted', 'Deleted {name} from the SD card.', { name }))
      await refresh()
    } catch (e) {
      notify('error', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={t('sd.title', 'Load from SD card')}
      eyebrow={t('sd.eyebrow', 'FluidNC controller')}
      initialFocusRef={closeRef}
      footer={
        <>
          <button ref={closeRef} type="button" className="sd-btn sd-btn--ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            onClick={() => void loadSelected()}
            disabled={busy || loading || selected.size === 0}
          >
            {t('sd.loadSelected', 'Load selected ({n})', { n: selected.size })}
          </button>
        </>
      }
    >
      <div className="sd-modal">
        <div className="sd-toolbar">
          <label className="sd-selall">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              disabled={files.length === 0 || loading || busy}
            />
            {t('sd.selectAll', 'Select all')}
          </label>
          <button
            type="button"
            className="sd-btn sd-btn--ghost sd-refresh"
            onClick={() => void refresh()}
            disabled={loading || busy}
            title={t('sd.refresh', 'Refresh file list')}
          >
            <Icon name="frame" size={14} /> {t('sd.refresh', 'Refresh')}
          </button>
        </div>

        {loading ? (
          <div className="sd-state" role="status">
            <span className="km-panel-spinner" aria-hidden="true" />
            {t('sd.loading', 'Reading SD card…')}
          </div>
        ) : configError ? (
          // Root cause is upstream of the SD card: the config didn't load, so the
          // card's SPI pins are unset and it can never mount. Explain + recover.
          <div className="sd-state sd-state--err">
            <Icon name="warning" size={16} />
            <div>
              <div><b>{t('sd.configSkipped', 'The controller has no config loaded.')}</b></div>
              <div className="sd-state-detail">
                {t(
                  'sd.configSkippedWhy',
                  'FluidNC skipped config.yaml after a boot crash (“Skipping configuration file due to panic”), so the SD card’s SPI pins aren’t set and it can’t mount. Fix the config first:',
                )}
              </div>
              <ul className="sd-recover">
                <li>{t('sd.recover.pins', 'A recent change likely set a pin that conflicts or doesn’t exist (e.g. a UART pin on the USB-console GPIO). Your backup won’t have that bad change, so restoring it fixes the crash.')}</li>
                <li>{t('sd.recover.restart', 'Restore your last-good config below, then the controller restarts and re-reads it.')}</li>
              </ul>
              <div className="sd-recover-actions">
                <input
                  ref={restoreRef}
                  type="file"
                  accept=".yaml,.yml,text/yaml"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void restoreConfig(f)
                  }}
                />
                <button
                  type="button"
                  className="sd-btn sd-btn--primary"
                  disabled={restoring}
                  onClick={() => restoreRef.current?.click()}
                  title={t('sd.restoreTip', 'Upload a known-good config.yaml (e.g. config.backup.yaml) to the controller and restart it')}
                >
                  {restoring
                    ? t('sd.restoring', 'Restoring + restarting…')
                    : t('sd.restore', 'Restore config.yaml from file…')}
                </button>
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="sd-state sd-state--err">
            <Icon name="warning" size={16} />
            <div>
              <div>{t('sd.error', 'Could not read the SD card.')}</div>
              <div className="sd-state-detail">{error}</div>
              <ul className="sd-recover">
                <li>{t('sd.cause.card', 'Is an SD card actually inserted and seated in the controller?')}</li>
                <li>{t('sd.cause.config', 'Is the SD card enabled in config.yaml (an `sdcard:` section with the right `cs_pin` + an `spi:` bus)?')}</li>
                <li>{t('sd.cause.idle', 'The controller must be Idle (not running a job) to read the card.')}</li>
              </ul>
            </div>
          </div>
        ) : files.length === 0 ? (
          <div className="sd-state">{t('sd.empty', 'No files on the SD card.')}</div>
        ) : (
          <ul className="sd-list">
            {files.map((f) => (
              <li key={f.name} className={'sd-row' + (selected.has(f.name) ? ' is-sel' : '')}>
                <label className="sd-row-main">
                  <input
                    type="checkbox"
                    checked={selected.has(f.name)}
                    onChange={() => toggle(f.name)}
                    disabled={busy}
                  />
                  <Icon name="sd-card" size={15} className="sd-row-ico" />
                  <span className="sd-row-name" title={f.name}>
                    {f.name}
                  </span>
                  <span className="sd-row-size">{fmtSize(f.size)}</span>
                </label>
                <div className="sd-row-actions">
                  <button
                    type="button"
                    className="sd-icon-btn"
                    onClick={() => void runOnMachine(f.name)}
                    disabled={busy}
                    title={t('sd.run', 'Run this file directly on the controller (no streaming)')}
                    aria-label={t('sd.run', 'Run on controller')}
                  >
                    <Icon name="play" size={15} />
                  </button>
                  <button
                    type="button"
                    className="sd-icon-btn sd-del"
                    onClick={() => void deleteFile(f.name)}
                    disabled={busy}
                    title={t('sd.delete', 'Delete this file from the SD card')}
                    aria-label={t('sd.delete', 'Delete from SD card')}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="sd-note">
          {t(
            'sd.note',
            'Files live on the controller’s SD card — an offline pendant can run them with no computer. “Load” copies a file into Sections here; “Run” executes it on the controller directly.',
          )}
        </p>
      </div>
    </Modal>
  )
}
