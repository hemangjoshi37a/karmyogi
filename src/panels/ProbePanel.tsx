import { useEffect, useState } from 'react'
import { grbl } from '../serial/controller'
import { useGrblSettings, useMachine, usePersistentState } from '../store'
import '../styles/probe.css'

/**
 * Probe & Limits panel.
 *
 * Designed beginner-first, expert-deep:
 *  1. Live switch detection — prominent indicator "lights" for X/Y/Z limit
 *     switches, Probe and Door, lit when their letter is present in the GRBL
 *     status report's `Pn:` field (surfaced by the store as `pins: string[]`).
 *     The controller polls status ~5 Hz so these update live; press each switch
 *     by hand to confirm wiring.
 *  2. Z-Probe — G38.2/G38.3 toward the workpiece, then G10 L20 to zero work Z
 *     accounting for a probe-plate thickness. Clear "Probe Z" + "Set Z zero".
 *  3. Advanced: limits & homing — collapsed by default. The GRBL limit/homing
 *     $-setting toggles ($20/$21/$22 + $5/$6 invert masks), Home/Unlock/Sync,
 *     and the caution notes. Novices use detection + probe; experts open this.
 */

/** Letters GRBL reports in `Pn:` and how we label them. */
const PIN_DEFS: { letter: string; label: string; sub: string; door?: boolean }[] = [
  { letter: 'X', label: 'X', sub: 'limit' },
  { letter: 'Y', label: 'Y', sub: 'limit' },
  { letter: 'Z', label: 'Z', sub: 'limit' },
  { letter: 'P', label: 'Probe', sub: 'P' },
  { letter: 'D', label: 'Door', sub: 'D', door: true },
]

/** A 0/1 GRBL boolean setting wired to a labelled toggle. */
function BoolSetting({
  num,
  title,
  desc,
  value,
  connected,
}: {
  num: number
  title: string
  desc: string
  value: string | undefined
  connected: boolean
}) {
  const on = value !== undefined && parseFloat(value) >= 0.5
  const known = value !== undefined
  return (
    <div className="pr-field">
      <label htmlFor={`pr-set-${num}`}>
        <span className="pr-num">${num}</span> {title}
        <span className="pr-sub">{desc}</span>
      </label>
      <button
        id={`pr-set-${num}`}
        type="button"
        className="pr-toggle"
        data-on={known ? on : undefined}
        disabled={!connected}
        title={
          connected
            ? `Toggle $${num} (${title}) — currently ${known ? (on ? 'ON (1)' : 'OFF (0)') : 'unknown, Sync first'}`
            : 'Connect first'
        }
        onClick={() => {
          grbl.writeSetting(num, on ? 0 : 1).then(() => grbl.readSettings()).catch(() => {})
        }}
      >
        {known ? (on ? 'ON' : 'OFF') : '—'}
      </button>
    </div>
  )
}

export function ProbePanel() {
  const connection = useMachine((s) => s.connection)
  const pins = useMachine((s) => s.pins)
  const values = useGrblSettings((s) => s.values)
  const loading = useGrblSettings((s) => s.loading)

  const connected = connection === 'connected'

  // Probe parameters (persisted so they survive a refresh).
  const [feed, setFeed] = usePersistentState<string>('karmyogi.probe.feed', '50')
  const [dist, setDist] = usePersistentState<string>('karmyogi.probe.dist', '20')
  const [thickness, setThickness] = usePersistentState<string>(
    'karmyogi.probe.thickness',
    '0',
  )
  // Advanced section is collapsed by default — novices stay in detection + probe.
  const [advOpen, setAdvOpen] = usePersistentState<boolean>('karmyogi.probe.advOpen', false)
  // Cheap UX state for the last probe action (not persisted).
  const [probed, setProbed] = useState(false)

  // Auto-sync settings when opened while connected with nothing cached yet, so
  // the limit/homing toggles show real values.
  useEffect(() => {
    if (connected && Object.keys(values).length === 0 && !loading) {
      grbl.readSettings().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const setVal = (n: number) => values[n]?.value

  const num = (s: string, fallback: number) => {
    const v = parseFloat(s)
    return Number.isFinite(v) ? v : fallback
  }

  // The exact commands the buttons will emit, shown live so there are no
  // surprises before a move that lowers the tool into the workpiece.
  const probeDist = Math.abs(num(dist, 20))
  const probeFeed = Math.abs(num(feed, 50))
  const plateT = num(thickness, 0)
  const probeCmd = `G38.2 Z-${probeDist} F${probeFeed}`
  const zeroCmd = `G10 L20 P0 Z${plateT}`

  const doProbe = (mode: '2' | '3') => {
    grbl.send(`G38.${mode} Z-${probeDist} F${probeFeed}`).then(() => setProbed(true)).catch(() => {})
  }

  const setZeroWithPlate = () => {
    grbl.send(zeroCmd).catch(() => {})
  }

  const pinSet = new Set(pins)

  return (
    <div className="pr-panel" aria-label="Probe and limits">
      <p className="pr-intro">
        Find Z=0 with a touch probe, and watch your limit / probe switches live.
        Advanced GRBL limit &amp; homing settings are tucked below.
      </p>

      {/* 1. Live switch detection — the hero. "Press a switch to see it light up." */}
      <section className="pr-card">
        <header className="pr-card-head">
          <h4>Live switch detection</h4>
          <span className="pr-raw">
            Pn:&nbsp;<b>{pins.length ? pins.join('') : '—'}</b>
          </span>
        </header>
        <p className="pr-hint">Press a switch by hand — it lights up here.</p>
        <div className="pr-lights" role="group" aria-label="Input pin states">
          {PIN_DEFS.map((p) => {
            const on = pinSet.has(p.letter)
            return (
              <div
                key={p.letter}
                className={`pr-light${p.door ? ' door' : ''}`}
                data-on={on}
                title={`${p.label} ${p.sub} — ${on ? 'TRIGGERED' : 'open'} (Pn:${p.letter})`}
              >
                <span className="pr-dot" aria-hidden="true" />
                <span className="pr-lbl">{p.label}</span>
                <span className="pr-sub">{on ? 'on' : p.sub}</span>
              </div>
            )
          })}
        </div>
        {!connected && (
          <p className="pr-note">Connect to a GRBL device to see live pin states.</p>
        )}
      </section>

      {/* 2. Z-Probe — simple Probe Z + Set Z zero. */}
      <section className="pr-card">
        <header className="pr-card-head">
          <h4>Z-Probe</h4>
          <span className="pr-raw">touch off Z</span>
        </header>
        <div className="pr-field">
          <label htmlFor="pr-feed">
            Probe speed
            <span className="pr-sub">how fast to lower toward the workpiece</span>
          </label>
          <input
            id="pr-feed"
            className="pr-input"
            type="text"
            inputMode="decimal"
            value={feed}
            disabled={!connected}
            onChange={(e) => setFeed(e.target.value)}
            aria-label="Probe speed (mm/min)"
          />
          <span className="pr-units">mm/min</span>
        </div>
        <div className="pr-field">
          <label htmlFor="pr-dist">
            Max distance
            <span className="pr-sub">give up if no contact within this far</span>
          </label>
          <input
            id="pr-dist"
            className="pr-input"
            type="text"
            inputMode="decimal"
            value={dist}
            disabled={!connected}
            onChange={(e) => setDist(e.target.value)}
            aria-label="Max probe distance (mm)"
          />
          <span className="pr-units">mm</span>
        </div>
        <div className="pr-field">
          <label htmlFor="pr-thick">
            Plate thickness
            <span className="pr-sub">thickness of the probe / touch plate</span>
          </label>
          <input
            id="pr-thick"
            className="pr-input"
            type="text"
            inputMode="decimal"
            value={thickness}
            disabled={!connected}
            onChange={(e) => setThickness(e.target.value)}
            aria-label="Plate thickness (mm)"
          />
          <span className="pr-units">mm</span>
        </div>
        <div className="pr-row">
          <button
            type="button"
            className="pr-btn primary pr-grow"
            disabled={!connected}
            onClick={() => doProbe('2')}
            title="G38.2 Z- F — lower the tool until it touches the plate. Alarms if no contact within the max distance."
          >
            Probe Z
          </button>
          <button
            type="button"
            className="pr-btn pr-grow"
            disabled={!connected}
            onClick={setZeroWithPlate}
            title="G10 L20 P0 Z<thickness> — set work Z=0 at the plate surface. Run after a successful probe."
          >
            Set Z zero
          </button>
        </div>
        <div className="pr-row">
          <button
            type="button"
            className="pr-btn pr-mini"
            disabled={!connected}
            onClick={() => doProbe('3')}
            title="G38.3 Z- F — probe toward the workpiece, but do NOT alarm if no contact is made."
          >
            Probe (no alarm)
          </button>
          <button
            type="button"
            className="pr-btn pr-mini"
            disabled={!connected}
            onClick={() => grbl.send('$#').catch(() => {})}
            title="$# — dump coordinate systems incl. PRB (last probe result) to the console"
          >
            Show last probe ($#)
          </button>
        </div>
        {/* Live G-code — exactly what the buttons send, so there's no surprise. */}
        <code className="pr-code" aria-label="G-code these buttons send">
          {probeCmd}
          <span className="pr-code-cmt">{'  ; Probe Z'}</span>
          {'\n'}
          {zeroCmd}
          <span className="pr-code-cmt">{'  ; Set Z zero'}</span>
        </code>
        <p className="pr-note caution">
          Safety: <b>Probe Z</b> lowers the tool — clip the probe clip to the tool and
          rest the plate on the workpiece first. 1) Place the plate. 2) <b>Probe Z</b>{' '}
          stops on contact (shows as <b>P</b> in the lights above). 3) <b>Set Z zero</b>{' '}
          writes <code>{zeroCmd}</code> so Z=0 sits at the plate surface.
          {probed && ' Last probe sent — check the console / "Show last probe".'}
        </p>
      </section>

      {/* 3. Advanced: limits & homing — collapsed by default. */}
      <section className="pr-card">
        <button
          type="button"
          className="pr-disclosure"
          aria-expanded={advOpen}
          aria-controls="pr-adv-body"
          onClick={() => setAdvOpen(!advOpen)}
        >
          <span className="pr-caret" aria-hidden="true">
            {advOpen ? '▾' : '▸'}
          </span>
          <span className="pr-disclosure-title">Advanced: limits &amp; homing</span>
          <span className="pr-disclosure-hint">
            {advOpen ? 'hide' : 'GRBL $-settings'}
          </span>
        </button>
        {advOpen && (
          <div id="pr-adv-body" className="pr-adv-body">
            <BoolSetting
              num={20}
              title="Soft limits"
              desc="refuse moves past $130–$132 max travel (needs homing)"
              value={setVal(20)}
              connected={connected}
            />
            <BoolSetting
              num={21}
              title="Hard limits"
              desc="stop on a limit switch trigger (needs switches wired)"
              value={setVal(21)}
              connected={connected}
            />
            <BoolSetting
              num={22}
              title="Homing enable"
              desc="allow the $H homing cycle"
              value={setVal(22)}
              connected={connected}
            />
            <BoolSetting
              num={5}
              title="Limit pins invert"
              desc="invert limit inputs — set ON for NC (normally-closed) switches"
              value={setVal(5)}
              connected={connected}
            />
            <BoolSetting
              num={6}
              title="Probe pin invert"
              desc="invert the probe input"
              value={setVal(6)}
              connected={connected}
            />
            <div className="pr-row">
              <button
                type="button"
                className="pr-btn primary pr-grow"
                disabled={!connected}
                onClick={() => grbl.home().catch(() => {})}
                title="$H — run the homing cycle"
              >
                Home ($H)
              </button>
              <button
                type="button"
                className="pr-btn pr-grow"
                disabled={!connected}
                onClick={() => grbl.unlock().catch(() => {})}
                title="$X — clear an alarm / unlock"
              >
                Unlock ($X)
              </button>
              <button
                type="button"
                className="pr-btn pr-grow"
                disabled={!connected || loading}
                onClick={() => grbl.readSettings().catch(() => {})}
                title="$$ — re-read settings so the toggles reflect the machine"
              >
                {loading ? '⟳ Syncing…' : '⟳ Sync'}
              </button>
            </div>
            <p className="pr-note caution">
              Caution: hard limits ($21) need limit switches physically wired. Many
              switches are normally-closed — if a switch reads triggered while open in the
              lights above, turn ON limit-pins invert ($5). Soft limits ($20) only work
              after a successful homing cycle.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
