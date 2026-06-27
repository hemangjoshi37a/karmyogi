import { useEffect, useMemo, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import type { JogParams } from '../serial/controller'
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
  fluidncSettingSupport,
  FLUIDNC_NUMBERS,
} from '../serial/settings'
import type { FluidncSupport } from '../serial/settings'
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
import { Modal, ModalFootSpacer } from '../components/Modal'
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
export function MotionPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const controllerKind = useMachineProfile((s) => s.controllerKind)
  const profile = profileFor(controllerKind)
  switch (profile.settingsModel) {
    case 'grbl':
    case 'grblhal': {
      const dialect = resolveDialect(profile.dialect, profile.kind)
      if (dialect.supportsNamedSettings)
        return <NamedSettingsEditor profile={profile} embedded={embedded} />
      return <GrblSettingsEditor profile={profile} embedded={embedded} />
    }
    case 'marlin':
      return <MarlinSettingsView profile={profile} embedded={embedded} />
    case 'smoothie':
      return <SmoothieSettingsView profile={profile} embedded={embedded} />
    case 'masso':
      return <MassoSettingsView profile={profile} embedded={embedded} />
    case 'none':
    default:
      return <NoSettingsView profile={profile} embedded={embedded} />
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
function GrblSettingsEditor({
  profile,
  embedded = false,
}: {
  profile: ControllerProfile
  embedded?: boolean
}) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const values = useGrblSettings((s) => s.values)
  const loading = useGrblSettings((s) => s.loading)
  const lastReadAt = useGrblSettings((s) => s.lastReadAt)

  const connected = connection === 'connected'
  // FluidNC keeps a GRBL-compatible numbered `$$` dump, but only for the SUBSET of
  // settings it registers with a grblName — and several of those are READ-ONLY
  // proxies derived from the YAML config. When the active profile is FluidNC we
  // (a) show only the numbers FluidNC actually exposes (not the full GRBL catalog,
  // which would render fabricated defaults that look like a broken sync), and
  // (b) mark the read-only rows + skip writes FluidNC would reject. Everything else
  // (classic GRBL / grblHAL) is unchanged.
  const isFluidnc = profile.kind === 'fluidnc'
  /** FluidNC support class for a setting number ('writable' for non-FluidNC). */
  const supportFor = (num: number): FluidncSupport =>
    isFluidnc ? fluidncSettingSupport(num) : 'writable'

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

  /** Send a raw line (used by the FluidNC YAML-config buttons). */
  const sendLine = (line: string) => {
    grbl.send(line).catch(() => {
      /* surfaced via console */
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

  /** Save a SINGLE edited parameter to the machine (the per-row Save button). */
  const saveOne = async (num: number, val: string) => {
    setSaving(true)
    try {
      await grbl.writeSetting(num, val)
      // Clear this row's pending edit + any prior error for it.
      setEdits((e) => {
        const next = { ...e }
        delete next[num]
        return next
      })
      setSaveErrors((errs) => {
        const next = { ...errs }
        delete next[num]
        return next
      })
    } catch (e) {
      setSaveErrors((errs) => ({ ...errs, [num]: e instanceof Error ? e.message : String(e) }))
    } finally {
      setSaving(false)
      grbl.readSettings().catch(() => {})
    }
  }

  /** Set a row to its default ONLY if it differs numerically (parseFloat). */
  const resetToDefault = (num: number, def: string, current: string) => {
    if (parseFloat(current) === parseFloat(def)) return
    setEdit(num, def)
  }

  /**
   * Serialize the current live values (or defaults) as `$N=val` lines for export.
   * On FluidNC the catalog base is the FluidNC-exposed subset, and READ-ONLY
   * numbers are dropped — re-importing a `$20=…` line would just be rejected.
   */
  const exportText = useMemo(() => {
    const base = isFluidnc
      ? Array.from(FLUIDNC_NUMBERS)
      : Object.keys(GRBL_SETTING_META).map(Number)
    const numbers = base.concat(Object.values(values).map((s) => s.number))
    const uniq = Array.from(new Set(numbers)).sort((a, b) => a - b)
    return uniq
      // GRBL/grblHAL: export everything. FluidNC: only the settings it accepts via
      // `$N=` (drops read-only YAML proxies and any non-FluidNC number).
      .filter((n) => (isFluidnc ? supportFor(n) === 'writable' : true))
      .map((n) => {
        const live = values[n]
        const val = live ? live.value : settingDefault(n)
        if (val === undefined) return null
        return writeSettingCommand(n, val)
      })
      .filter((l): l is string => l !== null)
      .join('\n')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, isFluidnc])

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
        // On FluidNC skip numbers it can't accept via `$N=` (read-only proxies or
        // settings it doesn't expose) — staging them would only fail on Save.
        if (isFluidnc && supportFor(num) !== 'writable') continue
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
            const n = Number(num)
            // On FluidNC only re-write the settings it accepts via `$N=` (steps/mm,
            // max rate, accel, max travel, status mask). The read-only proxies and
            // GRBL-only numbers would just error; their values come from the YAML config.
            if (isFluidnc && supportFor(n) !== 'writable') continue
            await grbl.writeSetting(n, val)
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
    // Catalog base: the FULL GRBL catalog for GRBL/grblHAL, but only the
    // FluidNC-exposed subset for FluidNC (so we don't render fabricated defaults
    // for settings FluidNC never reports). Live `$$` values are always unioned in,
    // so any extra number a controller actually reports still shows up.
    const liveNums = Object.values(values).map((s) => s.number)
    const numbers = new Set<number>([
      ...(isFluidnc ? FLUIDNC_NUMBERS : Object.keys(GRBL_SETTING_META).map(Number)),
      // On FluidNC drop any live value that isn't a FluidNC setting — this also
      // sheds rows left over in the persisted store from a previously-connected
      // classic-GRBL machine, which would otherwise show as fake/stale on FluidNC.
      ...(isFluidnc
        ? liveNums.filter((n) => fluidncSettingSupport(n) !== 'unsupported')
        : liveNums),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, isFluidnc])

  const total = Object.keys(values).length
  const corruptCount = useMemo(
    () =>
      Object.values(values).filter(
        (s) =>
          // On FluidNC ignore values that aren't FluidNC settings (e.g. stale rows
          // from a previously-connected GRBL machine) — they aren't shown, so
          // flagging them would be a phantom alert with no visible row to fix.
          (!isFluidnc || fluidncSettingSupport(s.number) !== 'unsupported') &&
          validateSetting(s.number, s.numeric).bad,
      ).length,
    [values, isFluidnc],
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
      {/* Read / status — sticks to the top of the (scrolling) modal so the
          Sync/Save toolbar stays reachable while the parameters scroll. When
          embedded in a <Modal> the Modal title already names the panel, so we
          drop our own <h4> (no double header) and the sticky/shadow treatment. */}
      <section className={`mo-section${embedded ? '' : ' mo-sticky-head'}`}>
        {!embedded && (
          <h4>
            {t('motion.heading.settingsFor', '{label} settings ($$)', {
              label: profile.label,
            })}
          </h4>
        )}
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
        {isFluidnc && (
          <div className="mo-note">
            {t(
              'motion.fluidnc.model',
              'FluidNC keeps a GRBL-compatible numbered $$ dump, but only for the settings it exposes for sender compatibility: steps/mm, max rate, acceleration, max travel and the status mask are writable here, while the rows marked “YAML · read-only” (soft/hard limits, homing, spindle, laser mode) are derived from the YAML config and can only be changed there. The full machine configuration lives in the YAML file — $Config/Dump prints it to the Console.',
            )}
          </div>
        )}
        {!connected && (
          <div className="mo-note">
            {isFluidnc
              ? t(
                  'motion.fluidnc.note.offline',
                  'Showing the GRBL-compatible settings FluidNC exposes. Connect to your FluidNC board and press Sync to read and edit the live values.',
                )
              : t(
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
              // FluidNC: this numbered setting appears in `$$` but is a read-only
              // proxy of the YAML config — show its live value but don't let it be
              // edited (a `$N=` write would be rejected). Configure it in the YAML.
              const readOnly = supportFor(s.number) === 'readonly'
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
                    {readOnly && (
                      <span
                        className="mo-badge"
                        data-sev="warn"
                        title={t(
                          'motion.fluidnc.readonly.hint',
                          'Firmware-managed on FluidNC — derived from the YAML config and not writable with $N=. Change it in config.yaml ($Config/Dump prints the running config to the Console).',
                        )}
                      >
                        {t('motion.fluidnc.readonly.badge', 'YAML · read-only')}
                      </span>
                    )}
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
                      disabled={!connected || readOnly}
                      readOnly={readOnly}
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
                    {/* Per-row Save: save JUST this changed parameter, without
                        committing every other pending edit. Mirrors the per-row
                        reset (home) button; shown only while this row is edited. */}
                    {editing && (
                      <button
                        type="button"
                        className="mo-btn mo-saveone mo-iconbtn"
                        disabled={!connected || saving}
                        onClick={() => void saveOne(s.number, fieldVal)}
                        title={t('motion.saveOne.title', 'Save ${num} to the machine now', {
                          num: s.number,
                        })}
                        aria-label={t('motion.saveOne.aria', 'Save ${num}', { num: s.number })}
                      >
                        <Icon name="upload" size={13} />
                      </button>
                    )}
                    {def !== undefined && !readOnly && (
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

      {/* FluidNC: the YAML config is the real source of truth for everything the
          numbered $$ subset can't reach (read-only proxies, pins, motors). Offer the
          same $Config/Dump / startup-log buttons the named editor has. */}
      {isFluidnc && (
        <section className="mo-section">
          <h5 className="mo-group">{t('motion.named.yaml.heading', 'YAML config')}</h5>
          <div className="mo-note">
            {t(
              'motion.fluidnc.yaml.note',
              'Settings marked “YAML · read-only” above (soft/hard limits, homing, spindle, laser mode) and the deeper machine structure (axes, motors, pins) are defined in the YAML config file, not the numbered settings. $Config/Dump prints the running config to the Console; $SS shows the startup log; type $Bye in the Console to restart the controller.',
            )}
          </div>
          <div className="mo-row">
            <button
              type="button"
              className="mo-btn primary"
              disabled={!connected}
              onClick={() => sendLine('$Config/Dump')}
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
              onClick={() => sendLine('$SS')}
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
      )}

      {/* Guided calibration & tuning (writes $100–$102 on confirm). */}
      <CalibrationSection connected={connected} values={values} />

      {/* Factory reset */}
      <section className="mo-section">
        <h5 className="mo-group">{t('motion.factory.heading', 'Factory reset')}</h5>
        <div className="mo-note">
          {isFluidnc
            ? t(
                'motion.fluidnc.factory.note',
                'On FluidNC $RST restores the NVS settings and then re-writes the writable defaults (steps/mm, max rate, accel, max travel). The YAML-managed settings (soft/hard limits, homing, spindle, laser) are unaffected — edit the YAML config for those. Each action asks for confirmation, then re-reads settings.',
              )
            : t(
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

      {/* Factory-reset confirmation (replaces native window.confirm). Sticky
          footer (§2.8): secondary Cancel LEFT, destructive Reset RIGHT. */}
      <Modal
        open={confirmKind !== null}
        title={t('motion.confirm.title', 'Confirm factory reset')}
        onClose={() => setConfirmKind(null)}
        size="sm"
        footer={
          <>
            <button type="button" className="mo-btn" onClick={() => setConfirmKind(null)}>
              {t('motion.confirm.cancel', 'Cancel')}
            </button>
            <ModalFootSpacer />
            <button
              type="button"
              className="mo-btn danger"
              onClick={() => confirmKind && executeReset(confirmKind)}
            >
              {t('motion.confirm.confirm', 'Reset')}
            </button>
          </>
        }
      >
        <p className="mo-confirm-msg">{confirmKind ? resetMessages[confirmKind] : ''}</p>
      </Modal>

      {/* Import / paste config dialog. Sticky footer: Cancel LEFT, primary RIGHT. */}
      <Modal
        open={importOpen}
        title={t('motion.import.dialogTitle', 'Import / paste config')}
        onClose={() => setImportOpen(false)}
        size="sm"
        footer={
          <>
            <button type="button" className="mo-btn" onClick={() => setImportOpen(false)}>
              {t('motion.confirm.cancel', 'Cancel')}
            </button>
            <ModalFootSpacer />
            <button
              type="button"
              className="mo-btn primary"
              disabled={importText.trim().length === 0}
              onClick={applyImport}
            >
              {t('motion.import.apply', 'Stage edits')}
            </button>
          </>
        }
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
      </Modal>
    </div>
  )
}

// Axis → steps/mm $-setting number.
const STEPS_SETTING: Record<'x' | 'y' | 'z', number> = { x: 100, y: 101, z: 102 }
const CAL_AXES: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z']

/** A non-negative finite number parsed from a text field, or null. */
function posNum(s: string): number | null {
  const v = parseFloat(s)
  return Number.isFinite(v) && v > 0 ? v : null
}

/** Relative jog of a single axis by `delta` mm at `feed` mm/min (cancellable $J=). */
function jogAxis(a: 'x' | 'y' | 'z', delta: number, feed: number): Promise<void> {
  const move: JogParams = { feed }
  move[a] = delta
  return grbl.jog(move)
}

/**
 * Guided machine calibration & tuning (O10) — lives inside the GRBL `$`-settings
 * editor and ties directly into it.
 *
 * Three guided tools:
 *  1. **Steps/mm tuning** — command a measured move on one axis (via the
 *     cancellable `$J=` jog at a safe feed), have the operator measure the actual
 *     travel, compute the corrected `$100/$101/$102` and (on an explicit confirm
 *     showing before → after) write it.
 *  2. **XY squaring** — measure the two diagonals of a scribed square and report
 *     the out-of-square error (mm + degrees). Stock GRBL has no skew-compensation
 *     setting, so this is an honest diagnostic + mechanical-adjustment guidance.
 *  3. **Backlash** — guided there-and-back move to measure lost motion per axis;
 *     reported as a diagnostic (stock GRBL cannot compensate it).
 *
 * SAFETY: every test move uses the cancellable `$J=` jog (never an uncancellable
 * G1), a conservative default feed, requires the Idle state, and offers a Cancel.
 * No `$`-setting is ever written without an explicit operator confirm.
 */
function CalibrationSection({
  connected,
  values,
}: {
  connected: boolean
  values: Record<number, GrblSetting>
}) {
  const t = useT()
  const machineState = useMachine((s) => s.state)
  const idle = machineState === 'Idle' || machineState === 'Jog' || machineState === 'Unknown'
  const ready = connected && idle

  const [open, setOpen] = useState(false)

  // ── Steps/mm tuning ──
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('x')
  const [dir, setDir] = useState<1 | -1>(1)
  const [target, setTarget] = useState('100')
  const [feed, setFeed] = useState('500')
  const [measured, setMeasured] = useState('')
  const [confirmApply, setConfirmApply] = useState(false)
  const [moving, setMoving] = useState(false)

  const settingNum = STEPS_SETTING[axis]
  const liveSteps = values[settingNum]?.value ?? settingDefault(settingNum) ?? ''
  const currentSteps = parseFloat(liveSteps)
  const targetN = posNum(target)
  const measuredN = posNum(measured)
  const corrected =
    Number.isFinite(currentSteps) && targetN && measuredN
      ? currentSteps * (targetN / measuredN)
      : null
  const correctedStr = corrected != null ? corrected.toFixed(3) : ''
  const errorPct =
    targetN && measuredN ? ((measuredN - targetN) / targetN) * 100 : null

  const runMove = async () => {
    if (!ready || !targetN) return
    const f = posNum(feed) ?? 500
    setMoving(true)
    try {
      await jogAxis(axis, dir * targetN, f)
    } catch {
      /* surfaced via console */
    }
    setMoving(false)
  }

  const applySteps = async () => {
    setConfirmApply(false)
    if (corrected == null) return
    try {
      await grbl.writeSetting(settingNum, corrected.toFixed(3))
    } catch {
      /* surfaced via console */
    }
    grbl.readSettings().catch(() => {})
    setMeasured('')
  }

  // ── XY squaring ──
  const [legLen, setLegLen] = useState('100')
  const [diag1, setDiag1] = useState('')
  const [diag2, setDiag2] = useState('')
  const sq = useMemo(() => {
    const L = posNum(legLen)
    const p = posNum(diag1)
    const q = posNum(diag2)
    if (!L || !p || !q) return null
    // sides L, included angle θ → p²−q² = 4L²cosθ; ε = θ−90°, cosθ ≈ −sin ε.
    const cosTheta = (p * p - q * q) / (4 * L * L)
    const epsRad = -Math.asin(Math.max(-1, Math.min(1, cosTheta)))
    const epsDeg = (epsRad * 180) / Math.PI
    const offsetMm = L * Math.sin(epsRad)
    return { diff: Math.abs(p - q), epsDeg, offsetMm }
  }, [legLen, diag1, diag2])

  // ── Backlash ──
  const [blAxis, setBlAxis] = useState<'x' | 'y' | 'z'>('x')
  const [blLen, setBlLen] = useState('20')
  const [blFeed, setBlFeed] = useState('500')
  const [blMeasured, setBlMeasured] = useState('')
  const blMoving = useRef(false)
  const [blBusy, setBlBusy] = useState(false)
  const blValue = posNum(blMeasured)

  const runBacklash = async () => {
    if (!ready || blMoving.current) return
    const L = posNum(blLen)
    if (!L) return
    const f = posNum(blFeed) ?? 500
    blMoving.current = true
    setBlBusy(true)
    try {
      // There-and-back: forward L (takes up slack in the + direction), then
      // return −L. The shortfall from the start mark is the lost motion.
      await jogAxis(blAxis, L, f)
      await jogAxis(blAxis, -L, f)
    } catch {
      /* surfaced via console */
    }
    blMoving.current = false
    setBlBusy(false)
  }

  return (
    <section className="mo-section">
      <button
        type="button"
        className="mo-cal-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={t('motion.cal.toggle.title', 'Guided steps/mm, squaring and backlash calibration')}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="mo-group" style={{ margin: 0 }}>
          {t('motion.cal.heading', 'Calibration & tuning')}
        </span>
      </button>

      {open && (
        <div className="mo-cal">
          <div className="mo-note">
            {t(
              'motion.cal.intro',
              'Guided tuning. Test moves use the cancellable $J= jog at a safe feed and need the Idle state — clear the area, keep a hand near the stop, and ensure the axis has clearance (especially Z). No setting is written until you confirm.',
            )}
          </div>
          {!ready && (
            <div className="mo-note">
              {connected
                ? t('motion.cal.notIdle', 'Machine is {state} — calibration moves need the Idle state.', {
                    state: machineState,
                  })
                : t('motion.connectFirst', 'Connect first')}
            </div>
          )}

          {/* ── Tool 1: steps/mm ── */}
          <div className="mo-cal-card">
            <h6 className="mo-cal-title">{t('motion.cal.steps.title', 'Steps per mm (axis movement)')}</h6>
            <div className="mo-note">
              {t(
                'motion.cal.steps.help',
                'Command a known move, measure the ACTUAL travel with calipers/rule, then apply the corrected steps/mm. corrected = current × commanded ÷ measured.',
              )}
            </div>
            <div className="mo-cal-grid">
              <label className="mo-cal-field">
                <span>{t('motion.cal.axis', 'Axis')}</span>
                <select
                  className="mo-cal-select"
                  value={axis}
                  onChange={(e) => {
                    setAxis(e.target.value as 'x' | 'y' | 'z')
                    setMeasured('')
                  }}
                >
                  {CAL_AXES.map((a) => (
                    <option key={a} value={a}>
                      {a.toUpperCase()} (${STEPS_SETTING[a]})
                    </option>
                  ))}
                </select>
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.steps.dir', 'Direction')}</span>
                <select
                  className="mo-cal-select"
                  value={dir}
                  onChange={(e) => setDir(Number(e.target.value) === -1 ? -1 : 1)}
                >
                  <option value={1}>+</option>
                  <option value={-1}>−</option>
                </select>
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.steps.commanded', 'Commanded (mm)')}</span>
                <input
                  className="mo-input"
                  type="text"
                  inputMode="decimal"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.feed', 'Feed (mm/min)')}</span>
                <input
                  className="mo-input"
                  type="text"
                  inputMode="decimal"
                  value={feed}
                  onChange={(e) => setFeed(e.target.value)}
                />
              </label>
            </div>
            <div className="mo-row">
              <button
                type="button"
                className="mo-btn primary mo-iconbtn"
                disabled={!ready || !targetN || moving}
                onClick={() => void runMove()}
                title={t('motion.cal.steps.run.title', 'Jog {axis} {sign}{dist} mm at {feed} mm/min (cancellable $J=)', {
                  axis: axis.toUpperCase(),
                  sign: dir < 0 ? '−' : '+',
                  dist: targetN ?? 0,
                  feed: posNum(feed) ?? 500,
                })}
              >
                <Icon name="play" size={13} />
                {moving
                  ? t('motion.cal.moving', 'Moving…')
                  : t('motion.cal.steps.run', 'Run test move')}
              </button>
              <button
                type="button"
                className="mo-btn mo-iconbtn"
                disabled={!connected}
                onClick={() => void grbl.jogCancel()}
                title={t('motion.cal.cancel.title', 'Cancel the jog (GRBL 0x85)')}
              >
                <Icon name="stop" size={13} />
                {t('motion.cal.cancel', 'Stop')}
              </button>
            </div>
            <div className="mo-cal-grid">
              <label className="mo-cal-field">
                <span>{t('motion.cal.steps.measured', 'Measured (mm)')}</span>
                <input
                  className="mo-input"
                  type="text"
                  inputMode="decimal"
                  value={measured}
                  onChange={(e) => setMeasured(e.target.value)}
                  placeholder={t('motion.cal.steps.measuredPh', 'actual travel')}
                />
              </label>
            </div>
            {corrected != null && (
              <div className="mo-cal-result">
                <div className="mo-cal-beforeafter">
                  <span className="mo-cal-num">${settingNum}</span>
                  <span className="mo-cal-from">
                    {Number.isFinite(currentSteps) ? currentSteps.toFixed(3) : '—'}
                  </span>
                  <span className="mo-cal-arrow" aria-hidden>&rarr;</span>
                  <span className="mo-cal-to">{correctedStr}</span>
                  <span className="mo-units">{t('motion.cal.units.stepsmm', 'steps/mm')}</span>
                </div>
                {errorPct != null && Math.abs(errorPct) >= 0.05 && (
                  <span className="mo-cal-hint">
                    {t('motion.cal.steps.errPct', 'measured is {pct}% off commanded', {
                      pct: errorPct.toFixed(2),
                    })}
                  </span>
                )}
                <button
                  type="button"
                  className="mo-btn save mo-iconbtn"
                  disabled={!ready || corrected == null}
                  onClick={() => setConfirmApply(true)}
                  title={t('motion.cal.steps.apply.title', 'Write ${num}={value} to the machine', {
                    num: settingNum,
                    value: correctedStr,
                  })}
                >
                  <Icon name="upload" size={13} />
                  {t('motion.cal.steps.apply', 'Apply ${num}', { num: settingNum })}
                </button>
              </div>
            )}
          </div>

          {/* ── Tool 2: XY squaring ── */}
          <div className="mo-cal-card">
            <h6 className="mo-cal-title">{t('motion.cal.sq.title', 'XY squaring')}</h6>
            <div className="mo-note">
              {t(
                'motion.cal.sq.help',
                'Scribe/cut a square of the given leg length, then measure both diagonals. Equal diagonals = square. Stock GRBL has NO skew-compensation setting, so correct any error mechanically (frame/gantry).',
              )}
            </div>
            <div className="mo-cal-grid">
              <label className="mo-cal-field">
                <span>{t('motion.cal.sq.leg', 'Leg (mm)')}</span>
                <input className="mo-input" type="text" inputMode="decimal" value={legLen} onChange={(e) => setLegLen(e.target.value)} />
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.sq.diag1', 'Diagonal 1 (mm)')}</span>
                <input className="mo-input" type="text" inputMode="decimal" value={diag1} onChange={(e) => setDiag1(e.target.value)} />
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.sq.diag2', 'Diagonal 2 (mm)')}</span>
                <input className="mo-input" type="text" inputMode="decimal" value={diag2} onChange={(e) => setDiag2(e.target.value)} />
              </label>
            </div>
            {sq && (
              <div className="mo-cal-result">
                <span className="mo-cal-hint">
                  {t('motion.cal.sq.diff', 'diagonal difference {diff} mm', { diff: sq.diff.toFixed(3) })}
                  {' · '}
                  {t('motion.cal.sq.err', 'out of square {deg}° ({mm} mm over the leg)', {
                    deg: sq.epsDeg.toFixed(3),
                    mm: sq.offsetMm.toFixed(3),
                  })}
                </span>
              </div>
            )}
          </div>

          {/* ── Tool 3: backlash ── */}
          <div className="mo-cal-card">
            <h6 className="mo-cal-title">{t('motion.cal.bl.title', 'Backlash measurement')}</h6>
            <div className="mo-note">
              {t(
                'motion.cal.bl.help',
                'Mount an indicator on the axis. Run the test (move forward, then return the same distance) and read the lost motion at the mark — that is the backlash. Stock GRBL cannot compensate it; reduce it mechanically (or use firmware with backlash compensation).',
              )}
            </div>
            <div className="mo-cal-grid">
              <label className="mo-cal-field">
                <span>{t('motion.cal.axis', 'Axis')}</span>
                <select className="mo-cal-select" value={blAxis} onChange={(e) => setBlAxis(e.target.value as 'x' | 'y' | 'z')}>
                  {CAL_AXES.map((a) => (
                    <option key={a} value={a}>
                      {a.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.bl.len', 'Move (mm)')}</span>
                <input className="mo-input" type="text" inputMode="decimal" value={blLen} onChange={(e) => setBlLen(e.target.value)} />
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.feed', 'Feed (mm/min)')}</span>
                <input className="mo-input" type="text" inputMode="decimal" value={blFeed} onChange={(e) => setBlFeed(e.target.value)} />
              </label>
              <label className="mo-cal-field">
                <span>{t('motion.cal.bl.measured', 'Lost motion (mm)')}</span>
                <input className="mo-input" type="text" inputMode="decimal" value={blMeasured} onChange={(e) => setBlMeasured(e.target.value)} />
              </label>
            </div>
            <div className="mo-row">
              <button
                type="button"
                className="mo-btn primary mo-iconbtn"
                disabled={!ready || !posNum(blLen) || blBusy}
                onClick={() => void runBacklash()}
                title={t('motion.cal.bl.run.title', 'Jog {axis} forward then back {dist} mm (cancellable $J=)', {
                  axis: blAxis.toUpperCase(),
                  dist: posNum(blLen) ?? 0,
                })}
              >
                <Icon name="play" size={13} />
                {blBusy ? t('motion.cal.moving', 'Moving…') : t('motion.cal.bl.run', 'Run backlash test')}
              </button>
              <button
                type="button"
                className="mo-btn mo-iconbtn"
                disabled={!connected}
                onClick={() => void grbl.jogCancel()}
                title={t('motion.cal.cancel.title', 'Cancel the jog (GRBL 0x85)')}
              >
                <Icon name="stop" size={13} />
                {t('motion.cal.cancel', 'Stop')}
              </button>
            </div>
            {blValue != null && (
              <div className="mo-cal-result">
                <span className="mo-cal-hint">
                  {t('motion.cal.bl.result', '{axis} backlash: {mm} mm', {
                    axis: blAxis.toUpperCase(),
                    mm: blValue.toFixed(3),
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Apply steps/mm confirmation. */}
      <Modal
        open={confirmApply}
        title={t('motion.cal.steps.confirmTitle', 'Apply steps/mm')}
        onClose={() => setConfirmApply(false)}
        size="sm"
        footer={
          <>
            <button type="button" className="mo-btn" onClick={() => setConfirmApply(false)}>
              {t('motion.confirm.cancel', 'Cancel')}
            </button>
            <ModalFootSpacer />
            <button type="button" className="mo-btn save" onClick={() => void applySteps()}>
              {t('motion.cal.steps.confirmApply', 'Write ${num}', { num: settingNum })}
            </button>
          </>
        }
      >
        <p className="mo-confirm-msg">
          {t(
            'motion.cal.steps.confirmMsg',
            'Write ${num} (the {axis}-axis steps/mm) from {from} to {to}? This changes how far the {axis} axis moves per commanded mm. You can re-tune or reset to default afterwards.',
            {
              num: settingNum,
              axis: axis.toUpperCase(),
              from: Number.isFinite(currentSteps) ? currentSteps.toFixed(3) : '—',
              to: correctedStr,
            },
          )}
        </p>
      </Modal>
    </section>
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
function NamedSettingsEditor({
  profile,
  embedded = false,
}: {
  profile: ControllerProfile
  embedded?: boolean
}) {
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
        {!embedded && (
          <h4>
            {t('motion.heading.settingsFor', '{label} settings ($$)', {
              label: profile.label,
            })}
          </h4>
        )}
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
function NoSettingsView({
  profile,
  embedded = false,
}: {
  profile: ControllerProfile
  embedded?: boolean
}) {
  const t = useT()
  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and controller settings')}>
      <section className="mo-section">
        {!embedded && (
          <h4>
            {t('motion.heading.controllerFor', '{label} controller', { label: profile.label })}
          </h4>
        )}
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
function MarlinSettingsView({
  profile,
  embedded = false,
}: {
  profile: ControllerProfile
  embedded?: boolean
}) {
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
        {!embedded && (
          <h4>
            {t('motion.heading.settingsForLabel', '{label} settings', { label: profile.label })}
          </h4>
        )}
        <div className="mo-alert" role="status">
          {t(
            'motion.marlin.notice',
            'Marlin stores settings in EEPROM and manages them via M-codes — not GRBL `$`-settings. Use M503 to report the current values, M500 to save, and M92 / M203 / M201 / M204 / M205 to set steps, feedrates, and acceleration.',
          )}
        </div>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary mo-iconbtn"
            disabled={!connected}
            onClick={() => send('M503')}
            title={
              connected
                ? t('motion.marlin.report.title', 'Send M503 — report current settings into the Console')
                : t('motion.connectFirst', 'Connect first')
            }
          >
            <Icon name="download" size={14} />
            {t('motion.marlin.report.label', 'Report settings (M503)')}
          </button>
          <button
            type="button"
            className="mo-btn mo-iconbtn"
            disabled={!connected}
            onClick={() => send('M500')}
            title={t('motion.marlin.save.title', 'Send M500 — save current settings to EEPROM')}
          >
            <Icon name="upload" size={14} />
            {t('motion.marlin.save.label', 'Save to EEPROM (M500)')}
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
                  className="mo-btn mo-iconbtn"
                  disabled={!connected}
                  onClick={() => send(code)}
                  title={t('motion.marlin.sendCode.title', 'Send {code} to the controller', { code })}
                  aria-label={t('motion.marlin.sendCode.aria', 'Send {code}', { code })}
                >
                  <Icon name="play" size={13} />
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
function SmoothieSettingsView({
  profile,
  embedded = false,
}: {
  profile: ControllerProfile
  embedded?: boolean
}) {
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
        {!embedded && (
          <h4>
            {t('motion.heading.controllerFor', '{label} controller', { label: profile.label })}
          </h4>
        )}
        <div className="mo-alert" role="status">
          {t(
            'motion.smoothie.notice',
            'Smoothieware keeps settings in its `config` file on the SD card — not GRBL `$`-settings. Read a value with `config-get sd <key>` and change one with `config-set sd <key> <value>` (a reset applies it).',
          )}
        </div>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary mo-iconbtn"
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
            <Icon name="download" size={14} />
            {t('motion.smoothie.get.label', 'config-get sd alpha_steps_per_mm')}
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
                  className="mo-btn mo-iconbtn"
                  disabled={!connected}
                  onClick={() => send(`config-get sd ${key}`)}
                  title={t('motion.smoothie.getKey.title', 'Send config-get sd {key}', { key })}
                  aria-label={t('motion.smoothie.getKey.aria', 'config-get sd {key}', { key })}
                >
                  <Icon name="play" size={13} />
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
function MassoSettingsView({
  profile,
  embedded = false,
}: {
  profile: ControllerProfile
  embedded?: boolean
}) {
  const t = useT()
  return (
    <div className="mo-panel" aria-label={t('motion.aria.panel', 'Motion and controller settings')}>
      <section className="mo-section">
        {!embedded && (
          <h4>
            {t('motion.heading.controllerFor', '{label} controller', { label: profile.label })}
          </h4>
        )}
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
