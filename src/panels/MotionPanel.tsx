import { useEffect, useMemo, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { useGrblSettings, useMachine, useMachineProfile, usePersistentState } from '../store'
import { notesKeyFor, profileFor } from '../machine/controllers'
import type { Capabilities, ControllerProfile } from '../machine/types'
import { GRBL_SETTING_META, writeSettingCommand, resolveDialect } from '../serial'
import type { GrblSetting } from '../serial'
import { parseSettingsBlock } from '../serial'
// Named (FluidNC) settings APIs live in the settings module and are imported
// directly (the ../serial barrel is owned by another workstream).
import {
  useNamedSettings,
  writeNamedSettingCommand,
  readNamedSettingCommand,
} from '../serial/settings'
import {
  GRBL_GROUPS,
  GRBL_SETTING_RICH,
  settingGroup,
  settingMeta,
  settingDefault,
  settingRangeText,
  validateSetting,
  MACHINE_DEFAULT_PROFILE,
  type GrblSettingGroup,
} from './grblSettingsMeta'
import { Icon } from '../components/Icons'
import { Modal } from '../components/Modal'
import { useT } from '../i18n'
import '../styles/motion.css'

/**
 * Motion / settings panel — adapts to the selected controller firmware.
 *
 * The app supports many controllers and each stores its settings differently, so
 * this panel branches on the active profile's `settingsModel` instead of assuming
 * GRBL `$`-settings for everyone:
 *  - `grbl` / `grblhal` → the full numeric `$`-settings editor
 *                          (`GrblSettingsEditor`) — EXCEPT FluidNC, whose dialect
 *                          resolves `settingsStyle: 'named'` and gets the
 *                          named-settings editor (`NamedSettingsEditor`:
 *                          `$path/name=value` rows, YAML config note).
 *  - `marlin`           → an honest M-code view (settings live in EEPROM).
 *  - `smoothie`         → an honest config-file view (`config-get` / `config-set`).
 *  - `masso`            → an honest "managed on-device / offline-export" notice.
 *  - `none`             → a capability-aware "no editable settings" notice (lasers).
 *
 * Selecting a controller in the titlebar dropdown updates `useMachineProfile`, so
 * this re-renders reactively with no reload.
 */
export function MotionPanel() {
  const controllerKind = useMachineProfile((s) => s.controllerKind)
  const profile = profileFor(controllerKind)
  switch (profile.settingsModel) {
    case 'grbl':
    case 'grblhal': {
      const dialect = resolveDialect(profile.dialect, profile.kind)
      if (dialect.supportsNamedSettings) return <NamedSettingsEditor profile={profile} />
      return <GrblSettingsEditor profile={profile} />
    }
    case 'marlin':
      return <MarlinSettingsView profile={profile} />
    case 'smoothie':
      return <SmoothieSettingsView profile={profile} />
    case 'masso':
      return <MassoSettingsView profile={profile} />
    case 'none':
    default:
      return <NoSettingsView profile={profile} />
  }
}

/**
 * GRBL `$`-Settings editor — a first-class `$`-settings manager (used for the
 * `grbl` + `grblhal` settings models; grblHAL's extended set is just whatever
 * `$$` reports, so the same editor lists it).
 *
 * Reads `$$`, renders every reported setting grouped into sections, lets the
 * user edit + write individual values, and (the key feature) flags values that
 * look corrupted (int32 overflow sentinel, zero/negative where impossible, or
 * out of a sane range) so an EEPROM-corruption incident like the one that made
 * every jog throw error:15 is obvious at a glance. Factory-reset buttons
 * ($RST=$ / # / *) are behind confirms.
 */
function GrblSettingsEditor({ profile }: { profile: ControllerProfile }) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const values = useGrblSettings((s) => s.values)
  const loading = useGrblSettings((s) => s.loading)
  const lastReadAt = useGrblSettings((s) => s.lastReadAt)

  const connected = connection === 'connected'

  // Pending edits, keyed by setting number; absent => showing the live value.
  // Persisted so unsaved edits survive a page refresh.
  const [edits, setEdits] = usePersistentState<Record<number, string>>(
    'karmyogi.motion.edits',
    {},
  )
  const [saving, setSaving] = useState(false)
  // Failures from the last Save, by setting number → reason. Surfaced so a
  // partial save is obvious; the failed rows keep their pending edit.
  const [saveErrors, setSaveErrors] = useState<Record<number, string>>({})
  const editCount = Object.keys(edits).length

  // Search / filter + "only flagged or changed" toggle for the (long) table.
  const [search, setSearch] = useState('')
  const [flaggedOnly, setFlaggedOnly] = useState(false)

  // Confirm dialog state for the factory-reset actions (replaces window.confirm).
  const [confirmKind, setConfirmKind] = useState<'$' | '#' | '*' | null>(null)
  // Import/paste-config dialog.
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [copied, setCopied] = useState(false)

  const onSync = () => {
    grbl.readSettings().catch(() => {
      /* surfaced via console/store */
    })
  }

  // Auto-sync when the tab is opened while connected and we have nothing yet.
  useEffect(() => {
    if (connected && Object.keys(values).length === 0 && !loading) onSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  // Clear pending edits + save errors when the link drops or the controller kind
  // changes — those edits were against a different/now-gone machine and applying
  // them silently on reconnect would be wrong.
  const prevConn = useRef(connection)
  useEffect(() => {
    if (prevConn.current === 'connected' && connection === 'disconnected') {
      setEdits({})
      setSaveErrors({})
    }
    prevConn.current = connection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection])
  useEffect(() => {
    setEdits({})
    setSaveErrors({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.kind])

  const setEdit = (num: number, v: string) =>
    setEdits((e) => ({ ...e, [num]: v }))

  /**
   * Write every pending edit to the machine, then re-sync to confirm. Only the
   * edits that WROTE SUCCESSFULLY are dropped from the pending set; any that
   * failed keep their value and are surfaced in `saveErrors` so the user can
   * retry, rather than silently losing a failed change with an unconditional
   * `setEdits({})`.
   */
  const onSave = async () => {
    const entries = Object.entries(edits)
    if (entries.length === 0) return
    setSaving(true)
    const remaining: Record<number, string> = {}
    const failures: Record<number, string> = {}
    for (const [num, val] of entries) {
      try {
        await grbl.writeSetting(Number(num), val)
      } catch (e) {
        // Keep the failed edit so it isn't lost, and record why.
        remaining[Number(num)] = val
        failures[Number(num)] = e instanceof Error ? e.message : String(e)
      }
    }
    setEdits(remaining)
    setSaveErrors(failures)
    setSaving(false)
    grbl.readSettings().catch(() => {})
  }

  const discardEdits = () => {
    setEdits({})
    setSaveErrors({})
  }

  /** Set a row to its default ONLY if it differs numerically (parseFloat). */
  const resetToDefault = (num: number, def: string, current: string) => {
    if (parseFloat(current) === parseFloat(def)) return
    setEdit(num, def)
  }

  /** Serialize the current live values (or defaults) as `$N=val` lines for export. */
  const exportText = useMemo(() => {
    const numbers = Object.keys(GRBL_SETTING_META)
      .map(Number)
      .concat(Object.values(values).map((s) => s.number))
    const uniq = Array.from(new Set(numbers)).sort((a, b) => a - b)
    return uniq
      .map((n) => {
        const live = values[n]
        const val = live ? live.value : settingDefault(n)
        if (val === undefined) return null
        return writeSettingCommand(n, val)
      })
      .filter((l): l is string => l !== null)
      .join('\n')
  }, [values])

  const onCopy = () => {
    const text = exportText
    const done = () => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => done())
    } else {
      done()
    }
  }

  /** Parse pasted `$$` text and stage every parsed line as a pending edit. */
  const applyImport = () => {
    const parsed = parseSettingsBlock(importText)
    if (parsed.size === 0) {
      setImportOpen(false)
      return
    }
    setEdits((e) => {
      const next = { ...e }
      for (const [num, s] of parsed) {
        // Only stage when the imported value differs numerically from the live one.
        const live = values[num]
        if (!live || parseFloat(live.value) !== parseFloat(s.value)) {
          next[num] = s.value
        }
      }
      return next
    })
    setImportOpen(false)
    setImportText('')
  }

  const resetMessages: Record<'$' | '#' | '*', string> = {
    $: t(
      'motion.confirm.resetSettings',
      'Restore the machine to its known-good default configuration?\n\nThis runs $RST=$ then writes the karmyogi default profile (steps/mm 1600, max rate 1000, accel 30, max travel 200, etc.) — use it to recover a corrupted or mis-configured controller.',
    ),
    '#': t(
      'motion.confirm.clearOffsets',
      'Clear all work-coordinate offsets (G54–G59, G28/G30, G92)?\n\nMachine settings are kept; only your zero offsets are erased.',
    ),
    '*': t(
      'motion.confirm.wipeAll',
      'FULL EEPROM WIPE: reset BOTH settings AND coordinate offsets to defaults?\n\nThis is the nuclear option — everything goes back to factory.',
    ),
  }

  const executeReset = (kind: '$' | '#' | '*') => {
    setConfirmKind(null)
    void (async () => {
      try {
        await grbl.resetSettings(kind)
        // After a settings reset, write the known-good machine profile so the
        // controller ends up correctly configured regardless of firmware defaults.
        if (kind === '$' || kind === '*') {
          for (const [num, val] of Object.entries(MACHINE_DEFAULT_PROFILE)) {
            await grbl.writeSetting(Number(num), val)
          }
        }
      } catch {
        /* surfaced via console */
      }
      grbl.readSettings().catch(() => {})
    })()
  }

  // Group settings into ordered sections. Show the FULL known-settings catalog
  // ALWAYS (every documented $-number), overlaying live synced values when
  // present and falling back to documented defaults otherwise — so the table is
  // never blank, even before a $$ sync or while disconnected. Any extra settings
  // a controller reports (e.g. grblHAL's extended set) are included too.
  const sections = useMemo(() => {
    const numbers = new Set<number>([
      ...Object.keys(GRBL_SETTING_META).map(Number),
      ...Object.values(values).map((s) => s.number),
    ])
    const rowFor = (n: number): GrblSetting => {
      const live = values[n]
      if (live) return live
      const def = settingDefault(n)
      return { number: n, value: def ?? '', numeric: def != null ? parseFloat(def) : NaN }
    }
    const byGroup = new Map<GrblSettingGroup, GrblSetting[]>()
    for (const n of numbers) {
      const g = settingGroup(n)
      const arr = byGroup.get(g) ?? []
      arr.push(rowFor(n))
      byGroup.set(g, arr)
    }
    return GRBL_GROUPS.map((g) => ({
      info: g,
      rows: (byGroup.get(g.id) ?? []).sort((a, b) => a.number - b.number),
    })).filter((sec) => sec.rows.length > 0)
  }, [values])

  const total = Object.keys(values).length
  const corruptCount = useMemo(
    () =>
      Object.values(values).filter((s) => validateSetting(s.number, s.numeric).bad)
        .length,
    [values],
  )

  // Apply the search box + "only flagged/changed" toggle to the grouped table.
  // A row matches the search if its number (with/without `$`) or its English
  // label/description contains the query. "Flagged or changed" = validation-bad
  // OR has a pending edit. The English meta is used for matching so the filter is
  // stable regardless of UI language (the query is usually a number anyway).
  const filteredSections = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matchesSearch = (s: GrblSetting): boolean => {
      if (!q) return true
      if (String(s.number).includes(q)) return true
      if (`$${s.number}`.includes(q)) return true
      const meta = GRBL_SETTING_META[s.number]
      if (meta?.label.toLowerCase().includes(q)) return true
      const rich = GRBL_SETTING_RICH[s.number]
      if (rich?.description.toLowerCase().includes(q)) return true
      return false
    }
    const matchesFlagged = (s: GrblSetting): boolean => {
      if (!flaggedOnly) return true
      if (edits[s.number] !== undefined) return true
      return validateSetting(s.number, s.numeric).bad
    }
    return sections
      .map((sec) => ({
        info: sec.info,
        rows: sec.rows.filter((s) => matchesSearch(s) && matchesFlagged(s)),
      }))
      .filter((sec) => sec.rows.length > 0)
  }, [sections, search, flaggedOnly, edits])

  const saveErrorCount = Object.keys(saveErrors).length

  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and GRBL settings')}>
      {/* Read / status */}
      <section className="mo-section">
        <h4>
          {t('motion.heading.settingsFor', '{label} settings ($$)', {
            label: profile.label,
          })}
        </h4>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary mo-iconbtn"
            disabled={!connected || loading}
            onClick={onSync}
            title={
              connected
                ? t('motion.sync.title', 'Sync — fetch all parameters from the machine ($$)')
                : t('motion.connectFirst', 'Connect first')
            }
          >
            <Icon name="download" size={14} />
            {loading ? t('motion.sync.syncing', 'Syncing…') : t('motion.sync.label', 'Sync')}
          </button>
          <button
            type="button"
            className="mo-btn save mo-iconbtn"
            disabled={!connected || saving || editCount === 0}
            onClick={() => void onSave()}
            title={t('motion.save.title', 'Save all edited parameters to the machine')}
          >
            <Icon name="upload" size={14} />
            {saving
              ? t('motion.save.saving', 'Saving…')
              : editCount > 0
                ? t('motion.save.labelCount', 'Save changes ({count})', { count: editCount })
                : t('motion.save.label', 'Save changes')}
          </button>
          {editCount > 0 && (
            <button
              type="button"
              className="mo-btn"
              onClick={discardEdits}
              title={t('motion.discard.title', 'Discard pending edits')}
            >
              {t('motion.discard.label', 'Discard')}
            </button>
          )}
          <button
            type="button"
            className="mo-btn mo-iconbtn"
            onClick={onCopy}
            title={t('motion.copy.title', 'Copy all $N=val settings to the clipboard')}
          >
            <Icon name="copy" size={14} />
            {copied ? t('motion.copy.copied', 'Copied') : t('motion.copy.label', 'Copy $$')}
          </button>
          <button
            type="button"
            className="mo-btn mo-iconbtn"
            disabled={!connected}
            onClick={() => {
              setImportText('')
              setImportOpen(true)
            }}
            title={t('motion.import.title', 'Paste a $$ dump / config to stage as edits')}
          >
            <Icon name="upload" size={14} />
            {t('motion.import.label', 'Import config')}
          </button>
          <span className="mo-grow" />
          <span className="mo-status">
            {total > 0
              ? t('motion.status.parameters', '{count} parameters', { count: total })
              : t('motion.status.notSynced', 'not synced yet')}
            {lastReadAt != null && (
              <>
                {' · '}
                {t('motion.status.syncedAt', 'synced {time}', {
                  time: new Date(lastReadAt).toLocaleTimeString(),
                })}
              </>
            )}
          </span>
        </div>
        {!connected && (
          <div className="mo-note">
            {t(
              'motion.note.connectDefaults',
              'Showing default GRBL settings below. Connect to a GRBL device and press Sync to read and edit the live values from your machine.',
            )}
          </div>
        )}
        {corruptCount > 0 && (
          <div className="mo-alert" role="alert">
            {corruptCount > 1
              ? t(
                  'motion.alert.corruptPlural',
                  '{count} settings look corrupted. Review the highlighted rows below, or factory-reset to recover.',
                  { count: corruptCount },
                )
              : t(
                  'motion.alert.corruptSingular',
                  '1 setting looks corrupted. Review the highlighted rows below, or factory-reset to recover.',
                )}
          </div>
        )}
        {saveErrorCount > 0 && (
          <div className="mo-alert" role="alert">
            {saveErrorCount > 1
              ? t(
                  'motion.alert.saveFailedPlural',
                  '{count} settings failed to save and kept their pending edit — check the Console and retry.',
                  { count: saveErrorCount },
                )
              : t(
                  'motion.alert.saveFailedSingular',
                  '1 setting failed to save and kept its pending edit — check the Console and retry.',
                )}
          </div>
        )}
        {/* Search / filter the (long) settings table. */}
        <div className="mo-row mo-filter">
          <input
            className="mo-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('motion.filter.searchPlaceholder', 'Search settings ($-number or name)…')}
            aria-label={t('motion.filter.searchAria', 'Search settings')}
          />
          <label className="mo-toggle" title={t('motion.filter.flaggedTitle', 'Show only flagged or changed settings')}>
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => setFlaggedOnly(e.target.checked)}
            />
            {t('motion.filter.flaggedLabel', 'Only flagged / changed')}
          </label>
        </div>
      </section>

      {/* Settings table, grouped */}
      {filteredSections.length === 0 && (
        <section className="mo-section">
          <div className="mo-note">
            {t('motion.filter.noMatches', 'No settings match the current filter.')}
          </div>
        </section>
      )}
      {filteredSections.map((sec) => {
        const groupTitle = t(sec.info.titleKey, sec.info.title)
        return (
        <section className="mo-section" key={sec.info.id}>
          <h5 className="mo-group">{groupTitle}</h5>
          <div className="mo-table" role="table" aria-label={groupTitle}>
            {sec.rows.map((s) => {
              const meta = settingMeta(s.number)
              const rich = GRBL_SETTING_RICH[s.number]
              const v = validateSetting(s.number, s.numeric)
              const editing = edits[s.number] !== undefined
              const fieldVal = edits[s.number] ?? s.value
              const known = GRBL_SETTING_META[s.number] !== undefined
              const def = settingDefault(s.number)
              const range = settingRangeText(s.number)
              // Resolve the (pure-module) English label/units through i18n here at
              // the UI boundary.
              const label = t(meta.labelKey, meta.label)
              const units = meta.units ? t(meta.unitsKey ?? meta.labelKey, meta.units) : undefined
              const failed = saveErrors[s.number]
              // Reset is disabled when the field already equals the default — but
              // compared NUMERICALLY (parseFloat), so "200" == "200.000".
              const atDefault = def !== undefined && parseFloat(fieldVal) === parseFloat(def)
              return (
                <div
                  className="mo-rowitem"
                  role="row"
                  key={s.number}
                  data-bad={v.bad ? v.severity : undefined}
                >
                  <div className="mo-cell mo-key">
                    <span className="mo-num">${s.number}</span>
                    <span className="mo-name">
                      {known ? label : <em>{t('motion.unknown', 'unknown')}</em>}
                    </span>
                    {rich?.description && (
                      (() => {
                        const desc = t(rich.descKey, rich.description)
                        return (
                          <span className="mo-desc" title={desc}>
                            {desc}
                          </span>
                        )
                      })()
                    )}
                    {(range || def !== undefined) && (
                      <span className="mo-range">
                        {range && <>{t('motion.range', 'Range {range}', { range })}</>}
                        {range && def !== undefined && ' · '}
                        {def !== undefined && <>{t('motion.default', 'default {value}', { value: def })}</>}
                      </span>
                    )}
                  </div>
                  <div className="mo-cell mo-edit">
                    <input
                      className={`mo-input${editing ? ' edited' : ''}`}
                      type="text"
                      inputMode="decimal"
                      value={fieldVal}
                      disabled={!connected}
                      onChange={(e) => setEdit(s.number, e.target.value)}
                      aria-label={t('motion.aria.value', '{label} (${num}) value', {
                        label,
                        num: s.number,
                      })}
                      data-bad={v.bad ? v.severity : undefined}
                    />
                    {units && <span className="mo-units">{units}</span>}
                    {editing && (
                      <span className="mo-pending" title={t('motion.pending.title', 'Edited — click Save changes')}>
                        <Icon name="info" size={12} />
                      </span>
                    )}
                    {def !== undefined && (
                      <button
                        type="button"
                        className="mo-btn mo-reset mo-iconbtn"
                        disabled={!connected || atDefault}
                        onClick={() => resetToDefault(s.number, def, fieldVal)}
                        title={t(
                          'motion.reset.title',
                          'Reset ${num} to default ({value}) — then Save to apply',
                          { num: s.number, value: def },
                        )}
                        aria-label={t('motion.reset.aria', 'Reset ${num} to default', { num: s.number })}
                      >
                        <Icon name="home" size={13} />
                      </button>
                    )}
                  </div>
                  {v.bad && v.hint && (
                    <div className="mo-warn" data-sev={v.severity} role="status">
                      <span className="mo-badge" data-sev={v.severity}>
                        {v.severity === 'danger'
                          ? t('motion.badge.corrupt', 'corrupt')
                          : t('motion.badge.check', 'check')}
                      </span>
                      {v.hintKey ? t(v.hintKey, v.hint, v.hintParams) : v.hint}
                    </div>
                  )}
                  {failed && (
                    <div className="mo-warn" data-sev="danger" role="status">
                      <span className="mo-badge" data-sev="danger">
                        {t('motion.badge.saveFailed', 'save failed')}
                      </span>
                      {failed}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
        )
      })}

      {/* Acceleration note */}
      <section className="mo-section">
        <div className="mo-note">
          {t('motion.note.accelPre', 'Note: GRBL uses ')}
          <strong>{t('motion.note.accelEmph', 'linear acceleration only')}</strong>
          {t(
            'motion.note.accelPost',
            ' (trapezoidal ramps, no S-curve / jerk control). $120–$122 are constant accel in mm/sec².',
          )}
        </div>
      </section>

      {/* Factory reset */}
      <section className="mo-section">
        <h5 className="mo-group">{t('motion.factory.heading', 'Factory reset')}</h5>
        <div className="mo-note">
          {t(
            'motion.factory.note',
            'Use these to recover from corrupted EEPROM. Each asks for confirmation, then re-reads settings.',
          )}
        </div>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn danger"
            disabled={!connected}
            onClick={() => setConfirmKind('$')}
            title={t('motion.factory.resetSettings.title', '$RST=$ — restore settings ($0–$132) to defaults')}
          >
            {t('motion.factory.resetSettings.label', 'Reset settings ($RST=$)')}
          </button>
          <button
            type="button"
            className="mo-btn"
            disabled={!connected}
            onClick={() => setConfirmKind('#')}
            title={t('motion.factory.clearOffsets.title', '$RST=# — clear G54–G59 coordinate offsets')}
          >
            {t('motion.factory.clearOffsets.label', 'Clear offsets ($RST=#)')}
          </button>
          <button
            type="button"
            className="mo-btn danger"
            disabled={!connected}
            onClick={() => setConfirmKind('*')}
            title={t('motion.factory.wipeAll.title', '$RST=* — full EEPROM wipe (settings + offsets)')}
          >
            {t('motion.factory.wipeAll.label', 'Wipe all ($RST=*)')}
          </button>
        </div>
      </section>

      {/* Factory-reset confirmation (replaces native window.confirm). */}
      <Modal
        open={confirmKind !== null}
        title={t('motion.confirm.title', 'Confirm factory reset')}
        onClose={() => setConfirmKind(null)}
        width={460}
      >
        <p className="mo-confirm-msg">{confirmKind ? resetMessages[confirmKind] : ''}</p>
        <div className="mo-row mo-confirm-actions">
          <button type="button" className="mo-btn" onClick={() => setConfirmKind(null)}>
            {t('motion.confirm.cancel', 'Cancel')}
          </button>
          <span className="mo-grow" />
          <button
            type="button"
            className="mo-btn danger"
            onClick={() => confirmKind && executeReset(confirmKind)}
          >
            {t('motion.confirm.confirm', 'Reset')}
          </button>
        </div>
      </Modal>

      {/* Import / paste config dialog. */}
      <Modal
        open={importOpen}
        title={t('motion.import.dialogTitle', 'Import / paste config')}
        onClose={() => setImportOpen(false)}
        width={520}
      >
        <p className="mo-note">
          {t(
            'motion.import.help',
            'Paste a $$ dump or a list of $N=val lines. Values that differ from the live settings are staged as pending edits — review them, then press Save changes to write them.',
          )}
        </p>
        <textarea
          className="mo-import"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={'$100=250.000\n$110=500.000\n…'}
          aria-label={t('motion.import.aria', 'Paste $$ config')}
          rows={10}
        />
        <div className="mo-row mo-confirm-actions">
          <button type="button" className="mo-btn" onClick={() => setImportOpen(false)}>
            {t('motion.confirm.cancel', 'Cancel')}
          </button>
          <span className="mo-grow" />
          <button
            type="button"
            className="mo-btn primary"
            disabled={importText.trim().length === 0}
            onClick={applyImport}
          >
            {t('motion.import.apply', 'Stage edits')}
          </button>
        </div>
      </Modal>
    </div>
  )
}

/**
 * FluidNC NAMED-settings editor (`settingsStyle: 'named'`).
 *
 * FluidNC replaced GRBL's numbered `$0=10` table with a YAML config + NAMED
 * settings: `$$` dumps `$path/name=value` lines, one is written back with
 * `$<name>=<value>` and read with `$<name>`. This editor:
 *  - Sync issues `$$` (same controller path as GRBL; the named lines are
 *    captured into `useNamedSettings` by the settings parser),
 *  - groups rows by the first path segment (axes/, Firmware/, Sta/, …) with a
 *    raw substring filter over names AND values,
 *  - edits inline — Enter (or the per-row write button, for touch) sends
 *    `$name=value` then reads the value back with `$name` so the row reflects
 *    what the controller actually accepted; Esc reverts,
 *  - is honest that the FULL machine config lives in the YAML file
 *    (`$Config/Dump` prints it to the Console).
 */
function NamedSettingsEditor({ profile }: { profile: ControllerProfile }) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const connected = connection === 'connected'
  const values = useNamedSettings((s) => s.values)
  // The `$$` read lifecycle (loading flag + completion time) is shared with the
  // numeric store — the controller arms/clears it for both line styles.
  const loading = useGrblSettings((s) => s.loading)
  const lastReadAt = useGrblSettings((s) => s.lastReadAt)

  // Pending edits keyed by setting name; absent => showing the live value.
  const [edits, setEdits] = useState<Record<string, string>>({})
  // Name of the setting currently being written (disables its row).
  const [writing, setWriting] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState(false)

  const onSync = () => {
    grbl.readSettings().catch(() => {
      /* surfaced via console/store */
    })
  }

  // Auto-sync when the panel is shown while connected and we have nothing yet.
  useEffect(() => {
    if (connected && Object.keys(values).length === 0 && !loading) onSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  // Drop pending edits when the link drops or the controller kind changes —
  // they were against a different/now-gone machine (mirrors the numeric editor).
  const prevConn = useRef(connection)
  useEffect(() => {
    if (prevConn.current === 'connected' && connection === 'disconnected') setEdits({})
    prevConn.current = connection
  }, [connection])
  useEffect(() => {
    setEdits({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.kind])

  const revert = (name: string) =>
    setEdits((e) => {
      const next = { ...e }
      delete next[name]
      return next
    })

  /** Commit one edit: write `$name=value`, then read it back with `$name`. */
  const commit = async (name: string) => {
    const v = edits[name]
    if (v === undefined || writing !== null) return
    const value = v.trim()
    if (value === (values[name] ?? '')) {
      revert(name)
      return
    }
    setWriting(name)
    try {
      await grbl.send(writeNamedSettingCommand(name, value))
      // Read the setting back — the `$name=value` reply is captured into the
      // store, so the row shows what the controller actually accepted.
      await grbl.send(readNamedSettingCommand(name))
      revert(name)
    } catch {
      /* kept as a pending edit; the failure is surfaced via the Console */
    }
    setWriting(null)
  }

  const total = Object.keys(values).length
  const editCount = Object.keys(edits).length

  // Group by the first path segment ('' = names without a slash → "General"),
  // applying the raw filter to full names and values. Groups and rows sort
  // alphabetically; General first.
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const names = Object.keys(values).sort((a, b) => a.localeCompare(b))
    const byGroup = new Map<string, string[]>()
    for (const name of names) {
      if (
        q &&
        !name.toLowerCase().includes(q) &&
        !(values[name] ?? '').toLowerCase().includes(q)
      ) {
        continue
      }
      const slash = name.indexOf('/')
      const seg = slash > 0 ? name.slice(0, slash) : ''
      const arr = byGroup.get(seg) ?? []
      arr.push(name)
      byGroup.set(seg, arr)
    }
    return Array.from(byGroup.entries()).sort(([a], [b]) =>
      a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
    )
  }, [values, filter])

  /** Serialize the snapshot as `$name=value` lines for export/backup. */
  const exportText = useMemo(
    () =>
      Object.keys(values)
        .sort((a, b) => a.localeCompare(b))
        .map((n) => writeNamedSettingCommand(n, values[n]))
        .join('\n'),
    [values],
  )

  const onCopy = () => {
    const done = () => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(exportText).then(done).catch(() => done())
    } else {
      done()
    }
  }

  const send = (line: string) => {
    grbl.send(line).catch(() => {
      /* surfaced via console */
    })
  }

  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and controller settings')}>
      <section className="mo-section">
        <h4>
          {t('motion.heading.settingsFor', '{label} settings ($$)', {
            label: profile.label,
          })}
        </h4>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary mo-iconbtn"
            disabled={!connected || loading}
            onClick={onSync}
            title={
              connected
                ? t('motion.sync.title', 'Sync — fetch all parameters from the machine ($$)')
                : t('motion.connectFirst', 'Connect first')
            }
          >
            <Icon name="download" size={14} />
            {loading ? t('motion.sync.syncing', 'Syncing…') : t('motion.sync.label', 'Sync')}
          </button>
          <button
            type="button"
            className="mo-btn mo-iconbtn"
            disabled={total === 0}
            onClick={onCopy}
            title={t('motion.named.copy.title', 'Copy all $name=value settings to the clipboard')}
          >
            <Icon name="copy" size={14} />
            {copied ? t('motion.copy.copied', 'Copied') : t('motion.copy.label', 'Copy $$')}
          </button>
          {editCount > 0 && (
            <button
              type="button"
              className="mo-btn"
              onClick={() => setEdits({})}
              title={t('motion.discard.title', 'Discard pending edits')}
            >
              {t('motion.discard.label', 'Discard')}
            </button>
          )}
          <span className="mo-grow" />
          <span className="mo-status">
            {total > 0
              ? t('motion.status.parameters', '{count} parameters', { count: total })
              : t('motion.status.notSynced', 'not synced yet')}
            {lastReadAt != null && total > 0 && (
              <>
                {' · '}
                {t('motion.status.syncedAt', 'synced {time}', {
                  time: new Date(lastReadAt).toLocaleTimeString(),
                })}
              </>
            )}
          </span>
        </div>
        <div className="mo-note">
          {t(
            'motion.named.model',
            'FluidNC uses NAMED settings: each row writes $name=value (press Enter or the write button). The full machine configuration lives in the YAML config file — $Config/Dump prints it to the Console.',
          )}
        </div>
        {!connected && (
          <div className="mo-note">
            {total > 0
              ? t(
                  'motion.named.note.offlineSnapshot',
                  'Showing the last-synced values. Connect to {label} to edit and re-sync.',
                  { label: profile.label },
                )
              : t(
                  'motion.named.note.connect',
                  'Connect to a {label} device and press Sync to list its named settings ($$).',
                  { label: profile.label },
                )}
          </div>
        )}
        <div className="mo-row mo-filter">
          <input
            className="mo-search"
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('motion.named.filter.placeholder', 'Filter settings (name or value)…')}
            aria-label={t('motion.filter.searchAria', 'Search settings')}
          />
        </div>
      </section>

      {total > 0 && groups.length === 0 && (
        <section className="mo-section">
          <div className="mo-note">
            {t('motion.filter.noMatches', 'No settings match the current filter.')}
          </div>
        </section>
      )}
      {groups.map(([seg, names]) => {
        const groupTitle = seg === '' ? t('motion.named.groupGeneral', 'General') : seg
        return (
          <section className="mo-section" key={seg === '' ? '«general»' : seg}>
            <h5 className="mo-group">{groupTitle}</h5>
            <div className="mo-table" role="table" aria-label={groupTitle}>
              {names.map((name) => {
                const rest = seg === '' ? name : name.slice(seg.length + 1)
                const editing = edits[name] !== undefined
                const fieldVal = edits[name] ?? values[name] ?? ''
                const busy = writing === name
                return (
                  <div className="mo-rowitem" role="row" key={name}>
                    <div className="mo-cell mo-key">
                      <span className="mo-num mo-path" title={`$${name}`}>
                        {rest}
                      </span>
                    </div>
                    <div className="mo-cell mo-edit">
                      <input
                        className={`mo-input named${editing ? ' edited' : ''}`}
                        type="text"
                        value={fieldVal}
                        disabled={!connected || busy}
                        spellCheck={false}
                        onChange={(e) =>
                          setEdits((m) => ({ ...m, [name]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void commit(name)
                          } else if (e.key === 'Escape') {
                            revert(name)
                          }
                        }}
                        aria-label={t('motion.named.aria.value', '{name} value', { name })}
                      />
                      {editing && (
                        <button
                          type="button"
                          className="mo-btn mo-iconbtn"
                          disabled={!connected || busy}
                          onClick={() => void commit(name)}
                          title={t(
                            'motion.named.write.title',
                            'Write {name}={value} to the controller (Enter)',
                            { name: `$${name}`, value: fieldVal.trim() },
                          )}
                          aria-label={t('motion.named.write.aria', 'Write {name}', {
                            name: `$${name}`,
                          })}
                        >
                          <Icon name="upload" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      {/* YAML config — the real source of truth on FluidNC. */}
      <section className="mo-section">
        <h5 className="mo-group">{t('motion.named.yaml.heading', 'YAML config')}</h5>
        <div className="mo-note">
          {t(
            'motion.named.yaml.note',
            'Machine structure (axes, motors, spindles, pins, homing) is defined in the YAML config file on the controller, not in the settings above. $Config/Dump prints the running config to the Console; $SS shows the startup log; type $Bye in the Console to restart the controller.',
          )}
        </div>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary"
            disabled={!connected}
            onClick={() => send('$Config/Dump')}
            title={
              connected
                ? t(
                    'motion.named.dump.title',
                    'Send $Config/Dump — the YAML config streams into the Console',
                  )
                : t('motion.connectFirst', 'Connect first')
            }
          >
            {t('motion.named.dump.label', 'Dump YAML ($Config/Dump)')}
          </button>
          <button
            type="button"
            className="mo-btn"
            disabled={!connected}
            onClick={() => send('$SS')}
            title={t('motion.named.ss.title', 'Send $SS — show the startup log in the Console')}
          >
            {t('motion.named.ss.label', 'Startup log ($SS)')}
          </button>
          <span className="mo-grow" />
          {!connected && (
            <span className="mo-status">{t('motion.connectFirst', 'Connect first')}</span>
          )}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.cap.heading', 'Capabilities')}</h5>
        <CapabilitySummary caps={profile.capabilities} />
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.notes.heading', 'About this controller')}</h5>
        <div className="mo-note">{t(notesKeyFor(profile.kind), profile.notes)}</div>
      </section>
    </div>
  )
}

/**
 * Capability summary chips (axes, spindle/laser, homing, probe) reused by the
 * non-GRBL settings views so every controller's abilities are shown honestly.
 */
function CapabilitySummary({ caps }: { caps: Capabilities }) {
  const t = useT()
  const chips: string[] = []
  chips.push(
    t('motion.cap.axes', '{count}-axis ({axes})', {
      count: caps.axes.length,
      axes: caps.axes.join(' '),
    }),
  )
  if (caps.hasSpindle) chips.push(t('motion.cap.spindle', 'spindle'))
  if (caps.hasLaser) chips.push(t('motion.cap.laser', 'laser'))
  chips.push(
    caps.hasHoming ? t('motion.cap.homing', 'homing') : t('motion.cap.noHoming', 'no homing'),
  )
  chips.push(
    caps.hasProbe ? t('motion.cap.probe', 'probe') : t('motion.cap.noProbe', 'no probe'),
  )
  return (
    <div
      className="mo-row"
      style={{ gap: 6 }}
      aria-label={t('motion.cap.aria', 'Controller capabilities')}
    >
      {chips.map((c) => (
        <span
          key={c}
          className="mo-units"
          style={{
            minWidth: 0,
            padding: '2px 8px',
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'var(--bg-input)',
            color: 'var(--fg)',
            fontSize: 11,
          }}
        >
          {c}
        </span>
      ))}
    </div>
  )
}

/**
 * `settingsModel: 'none'` — Ruida / EzCAD / FSCUT lasers expose no host-editable
 * machine settings over this connection. Show a clean, capability-aware notice
 * instead of a fake `$`-editor.
 */
function NoSettingsView({ profile }: { profile: ControllerProfile }) {
  const t = useT()
  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and controller settings')}>
      <section className="mo-section">
        <h4>
          {t('motion.heading.controllerFor', '{label} controller', { label: profile.label })}
        </h4>
        <div className="mo-alert" role="status">
          {t(
            'motion.none.notice',
            "{label} doesn't expose editable machine settings over this connection — configure motion / laser parameters in the controller's own software.",
            { label: profile.label },
          )}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.cap.heading', 'Capabilities')}</h5>
        <CapabilitySummary caps={profile.capabilities} />
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.notes.heading', 'About this controller')}</h5>
        <div className="mo-note">{t(notesKeyFor(profile.kind), profile.notes)}</div>
      </section>
    </div>
  )
}

/**
 * `settingsModel: 'marlin'` — Marlin keeps settings in EEPROM, managed via
 * M-codes (NOT a GRBL `$`-table). Be honest: explain the model, offer an M503
 * "report current settings" button (which streams into the Console), and list the
 * common setter M-codes for reference. No fake editor.
 */
function MarlinSettingsView({ profile }: { profile: ControllerProfile }) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const connected = connection === 'connected'

  const send = (line: string) => {
    grbl.send(line).catch(() => {
      /* surfaced via console */
    })
  }

  const codes: Array<[string, string]> = [
    ['M503', t('motion.marlin.m503', 'report current settings')],
    ['M500', t('motion.marlin.m500', 'save settings to EEPROM')],
    ['M501', t('motion.marlin.m501', 'reload settings from EEPROM')],
    ['M502', t('motion.marlin.m502', 'reset settings to firmware defaults')],
    ['M92', t('motion.marlin.m92', 'steps per mm (X/Y/Z/E)')],
    ['M203', t('motion.marlin.m203', 'max feedrates (mm/s)')],
    ['M201', t('motion.marlin.m201', 'max accelerations (mm/s²)')],
    ['M204', t('motion.marlin.m204', 'print / retract / travel accel')],
    ['M205', t('motion.marlin.m205', 'advanced: jerk / junction deviation')],
  ]

  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and controller settings')}>
      <section className="mo-section">
        <h4>
          {t('motion.heading.settingsForLabel', '{label} settings', { label: profile.label })}
        </h4>
        <div className="mo-alert" role="status">
          {t(
            'motion.marlin.notice',
            'Marlin stores settings in EEPROM and manages them via M-codes — not GRBL `$`-settings. Use M503 to report the current values, M500 to save, and M92 / M203 / M201 / M204 / M205 to set steps, feedrates, and acceleration.',
          )}
        </div>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary"
            disabled={!connected}
            onClick={() => send('M503')}
            title={
              connected
                ? t('motion.marlin.report.title', 'Send M503 — report current settings into the Console')
                : t('motion.connectFirst', 'Connect first')
            }
          >
            {t('motion.marlin.report.label', '⤓ Report settings (M503)')}
          </button>
          <button
            type="button"
            className="mo-btn"
            disabled={!connected}
            onClick={() => send('M500')}
            title={t('motion.marlin.save.title', 'Send M500 — save current settings to EEPROM')}
          >
            {t('motion.marlin.save.label', '💾 Save to EEPROM (M500)')}
          </button>
          <span className="mo-grow" />
          {!connected && (
            <span className="mo-status">{t('motion.connectFirst', 'Connect first')}</span>
          )}
        </div>
        <div className="mo-note">
          {t(
            'motion.marlin.consoleHint',
            'Reported values stream into the Console panel. Set a value by typing the M-code there, e.g. M92 X80 Y80 Z400, then M500 to persist.',
          )}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.marlin.ref.heading', 'M-code reference')}</h5>
        <div className="mo-table" role="table" aria-label={t('motion.marlin.ref.heading', 'M-code reference')}>
          {codes.map(([code, desc]) => (
            <div className="mo-rowitem" role="row" key={code}>
              <div className="mo-cell mo-key">
                <span className="mo-num">{code}</span>
                <span className="mo-desc">{desc}</span>
              </div>
              <div className="mo-cell mo-edit">
                <button
                  type="button"
                  className="mo-btn"
                  disabled={!connected}
                  onClick={() => send(code)}
                  title={t('motion.marlin.sendCode.title', 'Send {code} to the controller', { code })}
                  aria-label={t('motion.marlin.sendCode.aria', 'Send {code}', { code })}
                >
                  ▷
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.cap.heading', 'Capabilities')}</h5>
        <CapabilitySummary caps={profile.capabilities} />
      </section>
    </div>
  )
}

/**
 * `settingsModel: 'smoothie'` — Smoothieware keeps settings in the `config` file,
 * read/written with `config-get sd <key>` / `config-set sd <key> <value>`. Be
 * honest: show the model + a connected-only button to fetch a common key.
 */
function SmoothieSettingsView({ profile }: { profile: ControllerProfile }) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const connected = connection === 'connected'

  const send = (line: string) => {
    grbl.send(line).catch(() => {
      /* surfaced via console */
    })
  }

  const commonKeys: Array<[string, string]> = [
    ['alpha_steps_per_mm', t('motion.smoothie.alpha', 'X steps per mm')],
    ['beta_steps_per_mm', t('motion.smoothie.beta', 'Y steps per mm')],
    ['gamma_steps_per_mm', t('motion.smoothie.gamma', 'Z steps per mm')],
    ['default_feed_rate', t('motion.smoothie.feed', 'default feed rate (mm/min)')],
    ['acceleration', t('motion.smoothie.accel', 'acceleration (mm/s²)')],
  ]

  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and controller settings')}>
      <section className="mo-section">
        <h4>
          {t('motion.heading.controllerFor', '{label} controller', { label: profile.label })}
        </h4>
        <div className="mo-alert" role="status">
          {t(
            'motion.smoothie.notice',
            'Smoothieware keeps settings in its `config` file on the SD card — not GRBL `$`-settings. Read a value with `config-get sd <key>` and change one with `config-set sd <key> <value>` (a reset applies it).',
          )}
        </div>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary"
            disabled={!connected}
            onClick={() => send('config-get sd alpha_steps_per_mm')}
            title={
              connected
                ? t(
                    'motion.smoothie.get.title',
                    'Send config-get sd alpha_steps_per_mm — value streams into the Console',
                  )
                : t('motion.connectFirst', 'Connect first')
            }
          >
            {t('motion.smoothie.get.label', '⤓ config-get sd alpha_steps_per_mm')}
          </button>
          <span className="mo-grow" />
          {!connected && (
            <span className="mo-status">{t('motion.connectFirst', 'Connect first')}</span>
          )}
        </div>
        <div className="mo-note">
          {t(
            'motion.smoothie.consoleHint',
            'Values stream into the Console panel. To change one, type e.g. config-set sd alpha_steps_per_mm 80 there, then reset the board to apply.',
          )}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.smoothie.ref.heading', 'Common config keys')}</h5>
        <div
          className="mo-table"
          role="table"
          aria-label={t('motion.smoothie.ref.heading', 'Common config keys')}
        >
          {commonKeys.map(([key, desc]) => (
            <div className="mo-rowitem" role="row" key={key}>
              <div className="mo-cell mo-key">
                <span className="mo-num">{key}</span>
                <span className="mo-desc">{desc}</span>
              </div>
              <div className="mo-cell mo-edit">
                <button
                  type="button"
                  className="mo-btn"
                  disabled={!connected}
                  onClick={() => send(`config-get sd ${key}`)}
                  title={t('motion.smoothie.getKey.title', 'Send config-get sd {key}', { key })}
                  aria-label={t('motion.smoothie.getKey.aria', 'config-get sd {key}', { key })}
                >
                  ▷
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.cap.heading', 'Capabilities')}</h5>
        <CapabilitySummary caps={profile.capabilities} />
      </section>
    </div>
  )
}

/**
 * `settingsModel: 'masso'` — Masso is a standalone all-in-one controller with its
 * own touchscreen; all machine settings are configured ON THE DEVICE, and it does
 * not expose a host-streaming serial protocol over USB. Be honest: there is nothing
 * to edit from the browser. Explain the offline/export workflow (generate G-code →
 * copy to a USB stick → run from the Masso pendant) and show capabilities.
 */
function MassoSettingsView({ profile }: { profile: ControllerProfile }) {
  const t = useT()
  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and controller settings')}>
      <section className="mo-section">
        <h4>
          {t('motion.heading.controllerFor', '{label} controller', { label: profile.label })}
        </h4>
        <div className="mo-alert" role="status">
          {t(
            'motion.masso.notice',
            '{label} is a standalone controller — all motion and machine settings are configured on its own touchscreen, not from the host. It also has no GRBL-style host-streaming serial protocol, so karmyogi can’t connect live or read/write settings.',
            { label: profile.label },
          )}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.masso.workflow.heading', 'Offline / export workflow')}</h5>
        <div className="mo-note">
          {t(
            'motion.masso.workflow.body',
            'Use karmyogi as a CAD/CAM + G-code generator: design or import your job, generate safe G-code, then copy the .nc/.gcode file to a USB stick and run it from the Masso pendant. Configure feeds, homing, soft limits, spindle and probing on the Masso touchscreen itself.',
          )}
        </div>
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.cap.heading', 'Capabilities')}</h5>
        <CapabilitySummary caps={profile.capabilities} />
      </section>

      <section className="mo-section">
        <h5 className="mo-group">{t('motion.notes.heading', 'About this controller')}</h5>
        <div className="mo-note">{t(notesKeyFor(profile.kind), profile.notes)}</div>
      </section>
    </div>
  )
}
