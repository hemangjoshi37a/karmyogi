import { useEffect, useMemo, useState } from 'react'
import { grbl } from '../serial/controller'
import { useGrblSettings, useMachine, usePersistentState } from '../store'
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
import '../styles/motion.css'

/**
 * Motion / GRBL-Settings panel — a first-class `$`-settings manager.
 *
 * Reads `$$`, renders every reported setting grouped into sections, lets the
 * user edit + write individual values, and (the key feature) flags values that
 * look corrupted (int32 overflow sentinel, zero/negative where impossible, or
 * out of a sane range) so an EEPROM-corruption incident like the one that made
 * every jog throw error:15 is obvious at a glance. Factory-reset buttons
 * ($RST=$ / # / *) are behind confirms.
 */
export function MotionPanel() {
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
      $: 'Restore the machine to its known-good default configuration?\n\nThis runs $RST=$ then writes the karmyogi default profile (steps/mm 1600, max rate 1000, accel 30, max travel 200, etc.) — use it to recover a corrupted or mis-configured controller.',
      '#': 'Clear all work-coordinate offsets (G54–G59, G28/G30, G92)?\n\nMachine settings are kept; only your zero offsets are erased.',
      '*': 'FULL EEPROM WIPE: reset BOTH settings AND coordinate offsets to defaults?\n\nThis is the nuclear option — everything goes back to factory.',
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

  // Group the present settings into ordered sections.
  const sections = useMemo(() => {
    const byGroup = new Map<GrblSettingGroup, GrblSetting[]>()
    for (const s of Object.values(values)) {
      const g = settingGroup(s.number)
      const arr = byGroup.get(g) ?? []
      arr.push(s)
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
    <div className="mo-panel" aria-label="Motion and GRBL settings">
      {/* Read / status */}
      <section className="mo-section">
        <h4>GRBL settings ($$)</h4>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn primary"
            disabled={!connected || loading}
            onClick={onSync}
            title={connected ? 'Sync — fetch all parameters from the machine ($$)' : 'Connect first'}
          >
            {loading ? '⟳ Syncing…' : '⟳ Sync'}
          </button>
          <button
            type="button"
            className="mo-btn save"
            disabled={!connected || saving || editCount === 0}
            onClick={() => void onSave()}
            title="Save all edited parameters to the machine"
          >
            {saving ? 'Saving…' : `💾 Save changes${editCount > 0 ? ` (${editCount})` : ''}`}
          </button>
          {editCount > 0 && (
            <button type="button" className="mo-btn" onClick={discardEdits} title="Discard pending edits">
              Discard
            </button>
          )}
          <span className="mo-grow" />
          <span className="mo-status">
            {total > 0 ? `${total} parameters` : 'not synced yet'}
            {lastReadAt != null && (
              <>
                {' · '}
                synced {new Date(lastReadAt).toLocaleTimeString()}
              </>
            )}
          </span>
        </div>
        {!connected && (
          <div className="mo-note">Connect to a GRBL device to read or edit settings.</div>
        )}
        {corruptCount > 0 && (
          <div className="mo-alert" role="alert">
            {corruptCount} setting{corruptCount > 1 ? 's' : ''} look{corruptCount > 1 ? '' : 's'} corrupted.
            Review the highlighted rows below, or factory-reset to recover.
          </div>
        )}
      </section>

      {/* Settings table, grouped */}
      {sections.map((sec) => (
        <section className="mo-section" key={sec.info.id}>
          <h5 className="mo-group">{sec.info.title}</h5>
          <div className="mo-table" role="table" aria-label={sec.info.title}>
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
                      {known ? meta.label : <em>unknown</em>}
                    </span>
                    {rich?.description && (
                      <span className="mo-desc" title={rich.description}>
                        {rich.description}
                      </span>
                    )}
                    {(range || def !== undefined) && (
                      <span className="mo-range">
                        {range && <>Range {range}</>}
                        {range && def !== undefined && ' · '}
                        {def !== undefined && <>default {def}</>}
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
                      aria-label={`${meta.label} ($${s.number}) value`}
                      data-bad={v.bad ? v.severity : undefined}
                    />
                    {meta.units && <span className="mo-units">{meta.units}</span>}
                    {editing && <span className="mo-pending" title="Edited — click Save changes">●</span>}
                    {def !== undefined && (
                      <button
                        type="button"
                        className="mo-btn mo-reset"
                        disabled={!connected || fieldVal === def}
                        onClick={() => setEdit(s.number, def)}
                        title={`Reset $${s.number} to default (${def}) — then Save to apply`}
                        aria-label={`Reset $${s.number} to default`}
                      >
                        ↺
                      </button>
                    )}
                  </div>
                  {v.bad && v.hint && (
                    <div className="mo-warn" data-sev={v.severity} role="status">
                      <span className="mo-badge" data-sev={v.severity}>
                        {v.severity === 'danger' ? 'corrupt' : 'check'}
                      </span>
                      {v.hint}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {/* Acceleration note */}
      <section className="mo-section">
        <div className="mo-note">
          Note: GRBL uses <strong>linear acceleration only</strong> (trapezoidal ramps,
          no S-curve / jerk control). $120–$122 are constant accel in mm/sec².
        </div>
      </section>

      {/* Factory reset */}
      <section className="mo-section">
        <h5 className="mo-group">Factory reset</h5>
        <div className="mo-note">
          Use these to recover from corrupted EEPROM. Each asks for confirmation, then
          re-reads settings.
        </div>
        <div className="mo-row">
          <button
            type="button"
            className="mo-btn danger"
            disabled={!connected}
            onClick={() => onReset('$')}
            title="$RST=$ — restore settings ($0–$132) to defaults"
          >
            Reset settings ($RST=$)
          </button>
          <button
            type="button"
            className="mo-btn"
            disabled={!connected}
            onClick={() => onReset('#')}
            title="$RST=# — clear G54–G59 coordinate offsets"
          >
            Clear offsets ($RST=#)
          </button>
          <button
            type="button"
            className="mo-btn danger"
            disabled={!connected}
            onClick={() => onReset('*')}
            title="$RST=* — full EEPROM wipe (settings + offsets)"
          >
            Wipe all ($RST=*)
          </button>
        </div>
      </section>
    </div>
  )
}
