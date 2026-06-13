import { Gamepad2, Vibrate, Move, ChevronsUpDown, Play, Pause, Disc3, Home, Unlock, RotateCcw, Minus, Plus, Grid3x3 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Modal } from './Modal'
import { GamepadModel3D } from './GamepadModel3D'
import { type GamepadState } from '../machine/useGamepad'
import { tabLegend } from '../machine/gamepadTabActions'
import { useT } from '../i18n'
import './../styles/gamepad.css'

interface GamepadModalProps {
  open: boolean
  onClose: () => void
  gp: GamepadState
  armed: boolean
  setArmed: (v: boolean) => void
  machineConnected: boolean
  haptics: boolean
  setHaptics: (v: boolean) => void
  hapticIntensity: number
  setHapticIntensity: (v: number) => void
}

/** Friendly, type-classified controller name (connection-agnostic). */
function controllerName(gp: GamepadState, t: ReturnType<typeof useT>): string {
  if (!gp.connected) return t('gp.none', 'No controller')
  switch (gp.type) {
    case 'xbox':
      return t('gp.type.xbox', 'Xbox controller')
    case 'playstation':
      return t('gp.type.ps', 'PlayStation controller')
    case 'switch':
      return t('gp.type.switch', 'Nintendo Switch Pro controller')
    case '8bitdo':
      return t('gp.type.8bitdo', '8BitDo controller')
    default:
      return t('gp.type.generic', 'Generic controller')
  }
}

/** One row of the mapping reference. */
function MapRow({ icon, control, action }: { icon: ReactNode; control: string; action: string }) {
  return (
    <div className="gp-map-row">
      <span className="gp-map-icon" aria-hidden="true">{icon}</span>
      <span className="gp-map-control">{control}</span>
      <span className="gp-map-arrow" aria-hidden="true">→</span>
      <span className="gp-map-action">{action}</span>
    </div>
  )
}

/** Friendly title for the tabs that have context bindings (for the legend head). */
const TAB_TITLE: Record<string, string> = {
  program: 'Program',
  cadcam: '2D/3D Carving',
}

export function GamepadModal({
  open,
  onClose,
  gp,
  armed,
  setArmed,
  machineConnected,
  haptics,
  setHaptics,
  hapticIntensity,
  setHapticIntensity,
}: GamepadModalProps) {
  const t = useT()
  const name = controllerName(gp, t)
  // CONTEXT-AWARE legend: what the face buttons do on the CURRENTLY-ACTIVE tab.
  // Empty for tabs that fall back to the global mapping (shown below).
  const legend = tabLegend(gp.activeTab)
  const tabTitle = gp.activeTab ? TAB_TITLE[gp.activeTab] ?? gp.activeTab : undefined

  return (
    <Modal open={open} onClose={onClose} title={t('gp.title', 'Game controller')} width={760}>
      <div className="gp-modal">
        {/* Immersive 3D space: the controller fills it; status + control toggles
            float as translucent overlays on top of the model. */}
        <div className="gp-space">
          <GamepadModel3D detectedType={gp.type} />

          {/* Status (top-left overlay) */}
          <div className="gp-ov gp-ov-tl">
            <span className={`gp-ov-dot${gp.connected ? ' on' : ''}`} aria-hidden="true" />
            <div className="gp-ov-status-txt">
              {gp.connected ? (
                <>
                  <strong>{name}</strong>
                  {gp.id && (
                    <span className="gp-ov-id" title={gp.id}>
                      {gp.id}
                    </span>
                  )}
                </>
              ) : (
                <strong>{t('gp.press', 'Press any button to connect')}</strong>
              )}
            </div>
          </div>

          {/* Control toggles (top-right overlay, translucent) */}
          <div className="gp-ov gp-ov-tr">
            <button
              type="button"
              role="switch"
              aria-checked={armed}
              className={`gp-chip${armed ? ' on' : ''}`}
              onClick={() => setArmed(!armed)}
              title={t('gp.safety', 'Controls the machine — keep clear. Jog only works when connected & idle.')}
            >
              <Gamepad2 size={14} aria-hidden="true" />
              {armed ? t('gp.on.s', 'Control ON') : t('gp.off.s', 'Control OFF')}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={haptics}
              className={`gp-chip${haptics ? ' on' : ''}`}
              onClick={() => setHaptics(!haptics)}
              title={t('gp.haptics.note', 'Rumbles on machine events (Alarm/limit, error, job done). Informational only; needs a pad/browser that supports rumble.')}
            >
              <Vibrate size={14} aria-hidden="true" />
              {haptics ? t('gp.hap.on.s', 'Vibration ON') : t('gp.hap.off.s', 'Vibration OFF')}
            </button>
            {haptics && (
              <label className="gp-chip-slider" title={t('gp.haptics.intensity', 'Intensity')}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={hapticIntensity}
                  onChange={(e) => setHapticIntensity(Number(e.target.value))}
                  onPointerUp={() => gp.rumble('idle')}
                  aria-label={t('gp.haptics.intensity.aria', 'Vibration intensity')}
                />
              </label>
            )}
          </div>

          {/* Not-connected hint (bottom overlay) */}
          {!machineConnected && (
            <div className="gp-ov gp-ov-bottom" role="status">
              {t('gp.noMachine.s', 'Connect a machine — jog & commands are inactive until you do.')}
            </div>
          )}
        </div>

        {/* Connection / pairing guidance below the space */}
        <p className="gp-space-note">
          {gp.connected
            ? t('gp.safety', 'Controls the machine — keep clear. Jog only works when connected & idle.')
            : t(
                'gp.connect.how',
                'Pair your controller over Bluetooth, or plug it in via USB or its wireless dongle, then press any button. Works the same on desktop and Android.',
              )}
        </p>

        {/* CONTEXT layer: what the buttons do on the active tab (overrides the
            global mapping below for these buttons). Shown only when the active
            tab has bindings; otherwise the global mapping fully applies. */}
        {legend.length > 0 && (
          <div
            className="gp-map"
            style={{
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius, 6px)',
              background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
              padding: '8px 10px',
            }}
          >
            <h4>
              {t('gp.ctx.title', 'On this tab')}
              {tabTitle ? <span style={{ color: 'var(--fg-muted)' }}> · {tabTitle}</span> : null}
            </h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: 12, color: 'var(--fg-muted)' }}>
              {legend.map((row) => (
                <span key={row.control}>
                  <strong style={{ color: 'var(--accent)' }}>{row.control}</strong>: {row.action}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Mapping reference (compact legend — to be replaced by on-model callouts) */}
        <div className="gp-map">
          <h4>{t('gp.map.title', 'Button mapping')}</h4>
          <div className="gp-map-grid">
            <MapRow icon={<Move size={15} />} control={t('gp.ctl.lstick', 'Left stick')} action={t('gp.act.jogxy', 'Jog X / Y — any angle; push harder = faster')} />
            <MapRow icon={<ChevronsUpDown size={15} />} control={t('gp.ctl.rstick', 'Right stick / LT-RT')} action={t('gp.act.jogz', 'Jog Z — push harder = faster')} />
            <MapRow icon={<Grid3x3 size={15} />} control={t('gp.ctl.dpad', 'D-pad')} action={t('gp.act.stepjog', 'Step jog X / Y')} />
            <MapRow icon={<Minus size={15} />} control={t('gp.ctl.lb', 'LB')} action={t('gp.act.stepdown', 'Step size −')} />
            <MapRow icon={<Plus size={15} />} control={t('gp.ctl.rb', 'RB')} action={t('gp.act.stepup', 'Step size +')} />
            <MapRow icon={<Play size={15} />} control={t('gp.ctl.a', 'A / ✕')} action={t('gp.act.resume', 'Cycle start / Resume')} />
            <MapRow icon={<Pause size={15} />} control={t('gp.ctl.b', 'B / ●')} action={t('gp.act.hold', 'Feed hold')} />
            <MapRow icon={<Disc3 size={15} />} control={t('gp.ctl.x', 'X / ■')} action={t('gp.act.spindle', 'Spindle toggle')} />
            <MapRow icon={<Home size={15} />} control={t('gp.ctl.y', 'Y / ▲')} action={t('gp.act.home', 'Home')} />
            <MapRow icon={<Unlock size={15} />} control={t('gp.ctl.back', 'Back / Share')} action={t('gp.act.unlock', 'Unlock')} />
            <MapRow icon={<RotateCcw size={15} />} control={t('gp.ctl.start', 'Start / Options')} action={t('gp.act.reset', 'Soft reset')} />
          </div>
        </div>
      </div>
    </Modal>
  )
}
