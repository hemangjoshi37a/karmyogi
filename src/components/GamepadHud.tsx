import { useT } from '../i18n'
import { tabLegend } from '../machine/gamepadTabActions'
import type { GamepadType } from '../machine/useGamepad'
import '../styles/controller.css'

/**
 * On-screen HUD legend for the game controller, shown ONLY while a pad is armed
 * AND connected. Two fixed-position, pointer-events:none corner overlays mirror
 * the tiny keyboard-shortcut chips the Controller buttons already carry (e.g.
 * "h", "$H"), but blown up to be READABLE from across a workshop:
 *   - UPPER-LEFT  → the GAMEPAD legend for the CURRENTLY ACTIVE dock tab. The
 *     per-tab overrides (from `tabLegend`) REPLACE the global default action for
 *     that button on that tab; everything else falls back to the global map.
 *   - UPPER-RIGHT → the KEYBOARD shortcut legend (the same keys ControllerPanel
 *     documents in its big aria-label hint, plus Space → play/pause sim).
 *
 * Pure/presentational: it reads no stores and never touches the machine — the
 * caller passes the gamepad state + armed flag. Hidden while tab-nav mode is on
 * (the dedicated tab-switch overlay takes over then) to avoid clutter.
 */

interface GamepadHudProps {
  /** A pad is physically connected. */
  connected: boolean
  /** Controller family — drives the face-button glyphs (✕●■▲ for PlayStation). */
  type: GamepadType | null
  /** The active dock tab id (for the per-tab gamepad overrides). */
  activeTab: string | undefined
  /** User has armed the controller (persisted intent). */
  armed: boolean
}

/** One legend line: a key-cap chip on the left, the action text on the right. */
interface HudRow {
  /** The control glyph/name shown inside the key-cap (e.g. "A", "✕", "LB", "→"). */
  key: string
  /** What that control does. */
  action: string
}

/**
 * Face-button glyphs by controller family. PlayStation uses the symbol legend
 * (✕ ● ■ ▲) mapped from the standard A/B/X/Y indices: A→✕, B→●, X→■, Y→▲. Every
 * other family keeps the lettered Xbox-style labels.
 */
function faceLabels(type: GamepadType | null): { a: string; b: string; x: string; y: string } {
  if (type === 'playstation') return { a: '✕', b: '●', x: '■', y: '▲' }
  return { a: 'A', b: 'B', x: 'X', y: 'Y' }
}

export function GamepadHud({ connected, type, activeTab, armed }: GamepadHudProps) {
  const t = useT()
  // Only ever visible when the operator has armed the pad AND one is attached.
  if (!armed || !connected) return null

  const f = faceLabels(type)

  // GLOBAL default action labels, keyed by the SAME control glyph we render, so
  // a per-tab override can replace a row by matching its control. (See
  // useGamepad: A=resume, B=hold, X=spindle, Y=home, Back=unlock, Start=reset,
  // LB=step down, RB=step up, sticks=jog, L3=toggle tab navigation.)
  const globalRows: HudRow[] = [
    { key: f.a, action: t('gp.hud.a', 'Resume / cycle start') },
    { key: f.b, action: t('gp.hud.b', 'Feed hold') },
    { key: f.x, action: t('gp.hud.x', 'Spindle on/off') },
    { key: f.y, action: t('gp.hud.y', 'Home') },
    { key: 'LB', action: t('gp.hud.lb', 'Step size −') },
    { key: 'RB', action: t('gp.hud.rb', 'Step size +') },
    { key: 'Back', action: t('gp.hud.back', 'Unlock') },
    { key: 'Start', action: t('gp.hud.start', 'Reset') },
    { key: 'L3', action: t('gp.hud.l3', 'Tab switch mode') },
    { key: t('gp.hud.sticks', 'Sticks'), action: t('gp.hud.jog', 'Jog XY / Z') },
  ]

  // Per-tab overrides map an Xbox-style control label (A/B/X/Y/LB/RB/Start/…) to
  // a new action. Translate the A/B/X/Y names to the active family's glyphs so
  // they line up with (and replace) the matching global row.
  const overrideControl = (control: string): string => {
    switch (control) {
      case 'A':
        return f.a
      case 'B':
        return f.b
      case 'X':
        return f.x
      case 'Y':
        return f.y
      default:
        return control
    }
  }
  const overrides = tabLegend(activeTab).map((e) => ({
    key: overrideControl(e.control),
    action: e.action,
  }))

  // Merge: an override REPLACES the global action for the same control; any
  // override on a control not present globally (rare) is appended. Keep it
  // compact — cap at a sane number of rows so the HUD never sprawls.
  const overrideByKey = new Map(overrides.map((o) => [o.key, o.action]))
  const merged: HudRow[] = globalRows.map((r) =>
    overrideByKey.has(r.key) ? { key: r.key, action: overrideByKey.get(r.key)! } : r,
  )
  const globalKeys = new Set(globalRows.map((r) => r.key))
  for (const o of overrides) {
    if (!globalKeys.has(o.key)) merged.push(o)
  }
  const gamepadRows = merged.slice(0, 12)

  // KEYBOARD legend — mirrors the hint string in ControllerPanel (arrows jog XY ·
  // PgUp/PgDn jog Z · Esc · 1–4 step · h/u/r · ! / ~ · s · z · [ ] feed · \ feed
  // 100%) plus Space → play/pause sim.
  const keyboardRows: HudRow[] = [
    { key: '↑↓←→', action: t('gp.hud.kbd.arrows', 'Jog XY') },
    { key: 'PgUp / PgDn', action: t('gp.hud.kbd.pg', 'Jog Z') },
    { key: 'Esc', action: t('gp.hud.kbd.esc', 'Cancel jog') },
    { key: '1–4', action: t('gp.hud.kbd.step', 'Step size') },
    { key: 'h', action: t('gp.hud.kbd.h', 'Home') },
    { key: 'u', action: t('gp.hud.kbd.u', 'Unlock') },
    { key: 'r', action: t('gp.hud.kbd.r', 'Reset') },
    { key: '!', action: t('gp.hud.kbd.hold', 'Feed hold') },
    { key: '~', action: t('gp.hud.kbd.resume', 'Resume') },
    { key: 's', action: t('gp.hud.kbd.s', 'Spindle on/off') },
    { key: 'z', action: t('gp.hud.kbd.z', 'Zero work XYZ') },
    { key: '[ ]', action: t('gp.hud.kbd.feed', 'Feed override ∓') },
    { key: '\\', action: t('gp.hud.kbd.feed100', 'Feed override 100%') },
    { key: 'Space', action: t('gp.hud.kbd.space', 'Play / pause sim') },
  ]

  return (
    <>
      <aside className="gp-hud gp-hud-left" role="status" aria-live="off" aria-label={t('gp.hud.gamepad.aria', 'Gamepad controls')}>
        <div className="gp-hud-card">
          <span className="gp-hud-title">{t('gp.hud.gamepad', 'Gamepad')}</span>
          <div className="gp-hud-rows">
            {gamepadRows.map((r, i) => (
              <div className="gp-hud-row" key={`${r.key}-${i}`}>
                <span className="gp-hud-key">{r.key}</span>
                <span className="gp-hud-action">{r.action}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <aside className="gp-hud gp-hud-right" role="status" aria-live="off" aria-label={t('gp.hud.keyboard.aria', 'Keyboard shortcuts')}>
        <div className="gp-hud-card">
          <span className="gp-hud-title">{t('gp.hud.keyboard', 'Keyboard')}</span>
          <div className="gp-hud-rows">
            {keyboardRows.map((r, i) => (
              <div className="gp-hud-row" key={`${r.key}-${i}`}>
                <span className="gp-hud-key">{r.key}</span>
                <span className="gp-hud-action">{r.action}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  )
}
