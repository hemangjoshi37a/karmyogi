import { useEffect, useMemo, useState } from 'react'
import { grbl } from '../serial/controller'
import { useGrblSettings, useMachine, useMachineProfile, usePersistentState } from '../store'
import { profileFor } from '../machine/controllers'
import type { Capabilities, ControllerProfile } from '../machine/types'
import { GRBL_SETTING_META } from '../serial'
import type { GrblSetting } from '../serial'
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
import { useT } from '../i18n'
import '../styles/motion.css'

/**
 * Motion / settings panel — adapts to the selected controller firmware.
 *
 * The app supports many controllers and each stores its settings differently, so
 * this panel branches on the active profile's `settingsModel` instead of assuming
 * GRBL `$`-settings for everyone:
 *  - `grbl` / `grblhal` → the full `$`-settings editor (`GrblSettingsEditor`).
 *  - `marlin`           → an honest M-code view (settings live in EEPROM).
 *  - `smoothie`         → an honest config-file view (`config-get` / `config-set`).
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
    case 'grblhal':
      return <GrblSettingsEditor profile={profile} />
    case 'marlin':
      return <MarlinSettingsView profile={profile} />
    case 'smoothie':
      return <SmoothieSettingsView profile={profile} />
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
  const editCount = Object.keys(edits).length

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

  const setEdit = (num: number, v: string) =>
    setEdits((e) => ({ ...e, [num]: v }))

  /** Write every pending edit to the machine, then re-sync to confirm. */
  const onSave = async () => {
    const entries = Object.entries(edits)
    if (entries.length === 0) return
    setSaving(true)
    for (const [num, val] of entries) {
      try {
        await grbl.writeSetting(Number(num), val)
      } catch {
        /* surfaced via console */
      }
    }
    setEdits({})
    setSaving(false)
    grbl.readSettings().catch(() => {})
  }

  const discardEdits = () => setEdits({})

  const onReset = (kind: '$' | '#' | '*') => {
    const messages: Record<typeof kind, string> = {
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
    if (!window.confirm(messages[kind])) return
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
            className="mo-btn primary"
            disabled={!connected || loading}
            onClick={onSync}
            title={
              connected
                ? t('motion.sync.title', 'Sync — fetch all parameters from the machine ($$)')
                : t('motion.connectFirst', 'Connect first')
            }
          >
            {loading ? t('motion.sync.syncing', '⟳ Syncing…') : t('motion.sync.label', '⟳ Sync')}
          </button>
          <button
            type="button"
            className="mo-btn save"
            disabled={!connected || saving || editCount === 0}
            onClick={() => void onSave()}
            title={t('motion.save.title', 'Save all edited parameters to the machine')}
          >
            {saving
              ? t('motion.save.saving', 'Saving…')
              : editCount > 0
                ? t('motion.save.labelCount', '💾 Save changes ({count})', { count: editCount })
                : t('motion.save.label', '💾 Save changes')}
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
      </section>

      {/* Settings table, grouped */}
      {sections.map((sec) => {
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
                      {known ? meta.label : <em>{t('motion.unknown', 'unknown')}</em>}
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
                        label: meta.label,
                        num: s.number,
                      })}
                      data-bad={v.bad ? v.severity : undefined}
                    />
                    {meta.units && <span className="mo-units">{meta.units}</span>}
                    {editing && (
                      <span className="mo-pending" title={t('motion.pending.title', 'Edited — click Save changes')}>
                        ●
                      </span>
                    )}
                    {def !== undefined && (
                      <button
                        type="button"
                        className="mo-btn mo-reset"
                        disabled={!connected || fieldVal === def}
                        onClick={() => setEdit(s.number, def)}
                        title={t(
                          'motion.reset.title',
                          'Reset ${num} to default ({value}) — then Save to apply',
                          { num: s.number, value: def },
                        )}
                        aria-label={t('motion.reset.aria', 'Reset ${num} to default', { num: s.number })}
                      >
                        ↺
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
                      {v.hint}
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
            onClick={() => onReset('$')}
            title={t('motion.factory.resetSettings.title', '$RST=$ — restore settings ($0–$132) to defaults')}
          >
            {t('motion.factory.resetSettings.label', 'Reset settings ($RST=$)')}
          </button>
          <button
            type="button"
            className="mo-btn"
            disabled={!connected}
            onClick={() => onReset('#')}
            title={t('motion.factory.clearOffsets.title', '$RST=# — clear G54–G59 coordinate offsets')}
          >
            {t('motion.factory.clearOffsets.label', 'Clear offsets ($RST=#)')}
          </button>
          <button
            type="button"
            className="mo-btn danger"
            disabled={!connected}
            onClick={() => onReset('*')}
            title={t('motion.factory.wipeAll.title', '$RST=* — full EEPROM wipe (settings + offsets)')}
          >
            {t('motion.factory.wipeAll.label', 'Wipe all ($RST=*)')}
          </button>
        </div>
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
        <div className="mo-note">{profile.notes}</div>
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
