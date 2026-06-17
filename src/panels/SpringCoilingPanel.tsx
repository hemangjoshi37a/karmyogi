import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useProgram, useNotifications, usePersistentState, useMachine } from '../store'
import { useSpringViz } from '../store/springViz'
import { useProgramOwner } from '../store/programOwner'
import { grbl } from '../serial/controller'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
import { Modal } from '../components/Modal'
import {
  CompressionSpringGlyph,
  ExtensionSpringGlyph,
  TorsionSpringGlyph,
  CwGlyph,
  CcwGlyph,
  GeometryGlyph,
  ClosingGlyph,
  MotionGlyph,
  CoilGlyph,
} from '../components/SpringGlyphs'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import {
  defaultSpringCoilingParams,
  generateSpringMachineGcode,
  springInfo,
  type SpringCoilingParams,
  type SpringType,
  type SpringDirection,
} from '../core/springCoiling'
import '../styles/springcoiling.css'

/** Clamp decimals to the range toFixed() accepts (0..6). */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Split G-code into non-empty lines for the line count shown to the operator. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}
const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Params editable from the panel (programName/axis letters/metric are fixed here). */
type EditableParams = Omit<
  SpringCoilingParams,
  'programName' | 'rotaryAxis' | 'linearAxis'
>

/** Coerce an (untrusted) snapshot into the editable params, merged over defaults. */
function toParams(v: unknown): EditableParams {
  const d = defaultSpringCoilingParams((v ?? {}) as Partial<SpringCoilingParams>)
  return {
    wireDiameter: d.wireDiameter,
    coilDiameter: d.coilDiameter,
    bodyTurns: d.bodyTurns,
    pitch: d.pitch,
    springType: d.springType,
    closeTurnsStart: d.closeTurnsStart,
    closeTurnsEnd: d.closeTurnsEnd,
    releaseTurns: d.releaseTurns,
    chuckRpm: d.chuckRpm,
    direction: d.direction,
    segmentsPerRev: d.segmentsPerRev,
    decimals: clampDecimals(d.decimals),
  }
}

/** A slim square icon button for the header toolbar (mirrors DrillingPanel). */
function ToolButton(props: {
  glyph: ReactNode
  title: string
  body: string
  onClick: () => void
  className?: string
  disabled?: boolean
  ariaExpanded?: boolean
}) {
  const { glyph, title, body, onClick, className = '', disabled, ariaExpanded } = props
  return (
    <button
      type="button"
      className={`spr-ico${className ? ' ' + className : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-expanded={ariaExpanded}
      title={`${title} — ${body}`}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}

/**
 * Themed slider + number-input + unit row, mirroring the Drilling/Carving
 * `.dr-slider`/`.cc-slider` pattern: [label · range slider · number · unit]. The
 * range shows a CSS accent fill via the inline `--spr-pct` custom property; the
 * number input stays editable so exact typing still works. `disabled` greys the
 * whole row (used to lock the body pitch for tight extension/torsion springs).
 */
function SliderField(props: {
  label: string
  value: number
  unit?: string
  min: number
  max: number
  step: number
  onChange: (n: number) => void
  parse?: (v: string, fallback: number) => number
  disabled?: boolean
  info?: { title: string; body: string }
}) {
  const { label, value, unit, min, max, step, onChange, parse = num, disabled, info } = props
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  const pct = max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className={`spr-sfield${disabled ? ' is-disabled' : ''}`}>
      <span className="spr-sfield-lbl">
        <span className="spr-sfield-txt">{label}</span>
        {info && <InfoTip topic="springField" title={info.title} body={info.body} />}
      </span>
      <input
        type="range"
        className="spr-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        disabled={disabled}
        style={{ '--spr-pct': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(clamp(parse(e.target.value, value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="spr-sfield-num">
        <input
          type="number"
          className="spr-slider-num"
          step={step}
          value={String(value)}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange(parse(e.target.value, value))}
        />
        {unit && <span className="spr-sfield-unit">{unit}</span>}
      </span>
    </div>
  )
}

/**
 * A small segmented (single-choice) control. Options may carry an `icon`
 * (rendered above the label) and a `compact` flag stacks icon+label into a tidy
 * tile; without an icon it stays a plain text chip (used for the axis letters).
 */
function Segmented<T extends string>(props: {
  value: T
  options: { id: T; label: string; title?: string; icon?: ReactNode }[]
  onChange: (v: T) => void
  ariaLabel: string
  variant?: 'chip' | 'tile'
}) {
  const { value, options, onChange, ariaLabel, variant = 'chip' } = props
  return (
    <div className={`spr-seg${variant === 'tile' ? ' spr-seg-tiles' : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`spr-seg-btn${o.id === value ? ' is-on' : ''}${o.icon ? ' has-ico' : ''}`}
          aria-pressed={o.id === value}
          title={o.title}
          onClick={() => onChange(o.id)}
        >
          {o.icon && <span className="spr-seg-ico" aria-hidden="true">{o.icon}</span>}
          <span className="spr-seg-lbl">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * An inline number that reads as a label until clicked, then becomes an editable
 * field; commits on Enter/blur and reverts on Escape. Used for the production
 * counter so the operator can correct the tally by typing.
 */
function EditableCount(props: { value: number; onChange: (n: number) => void; ariaLabel: string }) {
  const { value, onChange, ariaLabel } = props
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editing) {
      setDraft(String(value))
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing, value])
  const commit = () => {
    const n = Math.max(0, Math.floor(parseInt(draft, 10)))
    onChange(Number.isFinite(n) ? n : 0)
    setEditing(false)
  }
  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0}
        step={1}
        className="spr-counter-input"
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="spr-counter-val"
      aria-live="polite"
      title={t('spring.count.edit', 'Click to edit the count')}
      onClick={() => setEditing(true)}
    >
      {value}
    </button>
  )
}

/** Hardware-calibration config — set once per machine build (persisted). */
interface SpringHardware {
  /** Chuck (rotary) stepper full steps per revolution (e.g. 200 for 1.8°). */
  chuckStepsPerRev: number
  /** Chuck driver microstepping (1/N). */
  chuckMicrosteps: number
  /** Gear reduction motor:chuck (motor turns per 1 chuck turn). */
  chuckGearRatio: number
  /** Carriage leadscrew lead — linear travel per screw revolution (mm). */
  screwLead: number
  /** Carriage (linear) stepper full steps per revolution. */
  carriageStepsPerRev: number
  /** Carriage driver microstepping (1/N). */
  carriageMicrosteps: number
}

const DEFAULT_HARDWARE: SpringHardware = {
  chuckStepsPerRev: 200,
  chuckMicrosteps: 16,
  chuckGearRatio: 1,
  screwLead: 8,
  carriageStepsPerRev: 200,
  carriageMicrosteps: 16,
}

/** Spring types whose body coils are wound tight (pitch ≈ wire dia). */
function isTight(type: SpringType): boolean {
  return type !== 'compression'
}

/**
 * Spring-Coiling panel. Drives the pure `springCoiling` core for a 2-axis
 * automatic spring coiler (a rotary chuck winding wire on a mandrel + a synced
 * linear carriage that sets the pitch). The user picks the spring TYPE, sets the
 * wire/coil dimensions, turns and pitch. There is ONE output: the real 2-axis
 * machine program (coordinated rotary+linear moves) — the only thing the coiler
 * can run. It auto-syncs to the shared store so the Program tab streams it, while
 * the spring params are published to the `springViz` channel so the Visualizer
 * renders the wound coil (the workpiece) as a 2-axis machine.
 */
export function SpringCoilingPanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const streaming = useProgram((s) => s.streaming)
  const notify = useNotifications((s) => s.notify)
  const setSpringViz = useSpringViz((s) => s.set)
  const clearSpringViz = useSpringViz((s) => s.clear)
  // Shared-program ownership (last writer wins): we claim it whenever we (re)build
  // the coil program, and yield (drop our section + coil viz) when another CAM
  // panel claims it.
  const programOwner = useProgramOwner((s) => s.owner)
  const claimOwner = useProgramOwner((s) => s.claim)

  const [params, setParams] = useState<EditableParams>(() => toParams(undefined))
  const [showRaw, setShowRaw] = useState(false)
  // Which physical GRBL axis the chuck (rotary) and carriage (linear) are wired
  // to. MUST be a real axis on the controller: a standard 3-axis GRBL 1.1 board
  // only has X/Y/Z and rejects an 'A' word with error:20. Default rotary=Y,
  // linear=X (both valid everywhere). Persisted — a machine's wiring is fixed.
  // ('A' is offered for 4-axis grblHAL/FluidNC boards.)
  const [rotaryAxis, setRotaryAxis] = usePersistentState('karmyogi.spring.rotaryAxis', 'Y')
  const [linearAxis, setLinearAxis] = usePersistentState('karmyogi.spring.linearAxis', 'X')

  // Hardware calibration (set once per machine build) + its settings dialog.
  const [hardware, setHardware] = usePersistentState<SpringHardware>(
    'karmyogi.spring.hardware',
    DEFAULT_HARDWARE,
  )
  const [showHardware, setShowHardware] = useState(false)

  // ---- colour-coded setting PRESETS (the coiling params) ----
  const capturePreset = (): EditableParams => ({ ...params })
  const applyPreset = (p: EditableParams) => setParams(toParams(p))
  const presets = usePresets<EditableParams>({
    storageKey: 'karmyogi.springcoiling.presets',
    capture: capturePreset,
    onApply: applyPreset,
  })

  const tight = isTight(params.springType)

  // Sanitised params for generation + preview: clamp decimals and force the
  // numeric fields into sane non-negative ranges so a typed negative never makes
  // a backwards feed or an inverted helix.
  const safeParams = useMemo<EditableParams>(
    () => ({
      ...params,
      decimals: clampDecimals(params.decimals),
      wireDiameter: Math.max(0.01, params.wireDiameter),
      coilDiameter: Math.max(0.01, params.coilDiameter),
      bodyTurns: Math.max(0, params.bodyTurns),
      pitch: Math.max(0, params.pitch),
      closeTurnsStart: Math.max(0, params.closeTurnsStart),
      closeTurnsEnd: Math.max(0, params.closeTurnsEnd),
      releaseTurns: Math.max(0, params.releaseTurns),
      chuckRpm: Math.max(0.1, params.chuckRpm),
      segmentsPerRev: Math.max(4, Math.min(360, Math.floor(params.segmentsPerRev) || 48)),
    }),
    [params],
  )

  // The full param object the core consumes. Axis letters come from the machine
  // axis-mapping control (which physical GRBL axis the chuck + carriage are on),
  // so the streamed program only uses axes the controller actually has.
  const coreParams = useMemo<Partial<SpringCoilingParams>>(
    () => ({ ...safeParams, rotaryAxis, linearAxis }),
    [safeParams, rotaryAxis, linearAxis],
  )

  // There is exactly ONE program: the 2-axis machine program. (A coiler is not a
  // 3-axis head; an XYZ helix would be a meaningless 3-axis path.)
  const machineGcode = useMemo(() => generateSpringMachineGcode(coreParams), [coreParams])
  const info = useMemo(() => springInfo({ ...defaultSpringCoilingParams(coreParams) }), [coreParams])
  const lineCount = useMemo(() => gcodeLines(machineGcode).length, [machineGcode])

  const programName = `Spring coil — ${safeParams.springType}`

  // Live generation (rAF-coalesced): push the 2-axis machine program to the shared
  // store so the Program tab picks it up as the sliders drag. While a job is
  // streaming we skip the sync so a fresh setProgram can't reset the running
  // program/cursor mid-wind — AND we clear the spring-viz channel so the Viewer
  // shows the generic streamed toolpath instead of the static coil preview.
  const rafRef = useRef<number | null>(null)
  // Don't auto-load the default coil into the program on page load. We skip the
  // FIRST run (mount with default params) and only publish once the operator
  // actually adjusts the coil — so a fresh load / refresh shows an empty program.
  const didInitRef = useRef(false)
  useEffect(() => {
    // While a job is streaming, leave the running program/cursor alone — but do
    // NOT clear the spring-viz channel. Clearing it made the Viewer fall back to
    // rendering the raw 2-axis program as a CARTESIAN toolpath, and that program's
    // rotary axis holds cumulative DEGREES (e.g. 11 turns ≈ 3960) — which drew a
    // strip the width of the spring shooting "infinitely" along the rotary axis.
    // Keeping the spring scene active throughout means the coil viz (which reads
    // the live carriage X) animates correctly and the degree-toolpath never shows.
    // Read `streaming` via getState (NOT a dep): a streamed program must NOT be
    // disturbed when it FINISHES. If `streaming` were a dep, the true→false flip
    // on completion would re-run this effect, re-claim ownership for the spring,
    // and evict whatever was just streamed (the reported "program auto-removed on
    // finish" bug). We only (re)publish on a real coil edit (machineGcode change).
    if (useProgram.getState().streaming) return
    // Skip the initial mount (default coil) so nothing is auto-loaded on page load.
    if (!didInitRef.current) {
      didInitRef.current = true
      return
    }
    // (Re)building the coil program → CLAIM ownership (last writer wins) + publish.
    claimOwner('springcoiling')
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      setProgram(programName, machineGcode)
      rafRef.current = null
    })
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [machineGcode, programName, setProgram, claimOwner])

  // Publish the spring dimensions to the viewer's spring-scene channel so it draws
  // the wound coil (the workpiece) + spinning chuck + sliding carriage as a 2-axis
  // machine. Skipped while streaming (handled above) and cleared on unmount, so
  // leaving the tab never leaves spring annotations behind.
  // Publish ALWAYS (including while streaming) so the Viewer keeps drawing the
  // spring scene — the live carriage X then animates the coil. The scene is purely
  // dimensional, so re-publishing during a stream is harmless and never resets the
  // running program (that's the setProgram effect above, which DOES skip streaming).
  useEffect(() => {
    setSpringViz({
      wireDiameter: safeParams.wireDiameter,
      coilDiameter: safeParams.coilDiameter,
      pitch: info.bodyPitch,
      freeLength: info.freeLength,
      totalTurns: info.totalTurns,
      direction: safeParams.direction,
    })
    return () => clearSpringViz()
  }, [
    safeParams.wireDiameter,
    safeParams.coilDiameter,
    safeParams.direction,
    info.bodyPitch,
    info.freeLength,
    info.totalTurns,
    setSpringViz,
    clearSpringViz,
  ])

  // Yield: when ANOTHER CAM panel claims the program, drop our section + coil viz
  // (the rotary 2-axis path is meaningless as an XYZ toolpath, so it must not
  // linger over another job). No-op while we're the owner / before any claim.
  useEffect(() => {
    if (programOwner && programOwner !== 'springcoiling') {
      removeSection(programName)
      clearSpringViz()
    }
  }, [programOwner, programName, removeSection, clearSpringViz])

  // ---- Production counter ----------------------------------------------------
  // A persisted tally of springs wound. Increments by one each time a coiling RUN
  // finishes (the shared `streaming` flag falls true → false). Manual +1 / reset
  // are provided for hand-fed parts or correcting a miscount.
  const [produced, setProduced] = usePersistentState('karmyogi.spring.produced', 0)
  const prevStreaming = useRef(false)
  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      setProduced((n) => n + 1)
    }
    prevStreaming.current = streaming
  }, [streaming, setProduced])

  // ---- Home the linear (carriage) axis --------------------------------------
  // Sends a single-axis homing command for the carriage axis so it seeks its home
  // limit switch and re-establishes a known zero. Falls back to a friendly notice
  // if the controller is not connected. Uses the raw `$H<axis>` form (GRBL 1.1's
  // single-axis homing); a board without it will simply report an error to console.
  const connection = useMachine((s) => s.connection)
  const connected = connection === 'connected'
  function homeCarriage() {
    if (!connected) {
      notify('warn', t('spring.home.offline', 'Connect to the machine to home the carriage axis.'))
      return
    }
    grbl.send(`$H${linearAxis}`).catch(() => {
      notify('warn', t('spring.home.failed', 'Homing command was rejected by the controller.'))
    })
    notify('info', t('spring.home.sent', 'Homing the carriage ({axis}) axis…', { axis: linearAxis }))
  }

  async function copyGcode() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(machineGcode)
      notify('success', t('spring.copied', 'Copied {n} G-code line(s) to the clipboard.', { n: lineCount }))
    } catch {
      notify('warn', t('spring.copyFailed', 'Could not copy to the clipboard.'))
    }
  }

  // Download the 2-axis MACHINE program (what the coiler actually runs).
  function downloadGcode() {
    const blob = new Blob([machineGcode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'spring-coil.nc'
    a.click()
    URL.revokeObjectURL(url)
    notify('success', t('spring.downloaded', 'Downloaded the spring-coiling machine program.'))
  }

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('spring.presets.aria', 'Spring coiling setting presets')}
      />
      <div className="spr-panel">
        {/* Slim header: just the icon toolbar — the tab title already names the
            panel, so the in-panel title is redundant. A compact ⓘ keeps the help. */}
        <header className="spr-head spr-head-bare">
          <div className="spr-head-info">
            <InfoTip
              topic="springMode"
              title={t('spring.title', 'Spring Coiling')}
              body={t(
                'spring.intro',
                'Winds a coil spring on a 2-axis automatic coiler: a rotary chuck turns the mandrel (each revolution = one spring turn) while a synced linear carriage advances by the pitch (A = chuck deg, X = carriage mm). Pick the spring type, set the wire/coil sizes, turns and pitch; the 2-axis program auto-syncs to the Program tab for streaming.',
              )}
            />
          </div>
          <div className="spr-tools">
            <ToolButton
              glyph={<Icon name="settings" />}
              onClick={() => setShowHardware(true)}
              ariaExpanded={showHardware}
              title={t('spring.toolbar.hw', 'Machine hardware')}
              body={t(
                'spring.toolbar.hw.body',
                'Hardware calibration (stepper steps/rev, microstepping, gear ratio, leadscrew lead) — set once when the machine is built or its drivetrain changes.',
              )}
            />
            <ToolButton
              glyph={<Icon name="home" />}
              onClick={homeCarriage}
              disabled={!connected}
              title={t('spring.toolbar.home', 'Home carriage axis')}
              body={t(
                'spring.toolbar.home.body',
                'Home the linear carriage axis: it seeks its home limit switch and re-zeroes (sends $H to the carriage axis).',
              )}
            />
            <ToolButton
              glyph={<Icon name="copy" />}
              onClick={copyGcode}
              title={t('spring.toolbar.copy', 'Copy G-code')}
              body={t('spring.toolbar.copy.body', 'Copy the 2-axis machine program to the clipboard.')}
            />
            <ToolButton
              glyph={<Icon name="download" />}
              onClick={downloadGcode}
              title={t('spring.toolbar.download', 'Download machine G-code')}
              body={t('spring.toolbar.download.body', 'Download the 2-axis machine program as a .nc file.')}
            />
            <SaveLoadButtons
              value={params}
              onLoad={(data) => setParams(toParams(data))}
              fileBase="karmyogi-spring"
              ext="kspring"
              saveTitle={t('spring.save', 'Save spring settings')}
              loadTitle={t('spring.load', 'Load spring settings')}
              onError={(m) => notify('warn', m)}
            />
          </div>
        </header>

        {/* Live status strip: turns, free length, wire length, line count, auto-synced. */}
        <div className="spr-status">
          <span className="spr-status-pill">
            <b>{info.totalTurns.toFixed(2)}</b> {t('spring.status.turns', 'turns')}
          </span>
          <span className="spr-status-sep" aria-hidden="true">·</span>
          <span className="spr-status-pill">
            {t('spring.status.free', 'free L')} <b>{info.freeLength.toFixed(1)}</b> {t('unit.mm', 'mm')}
          </span>
          <span className="spr-status-sep" aria-hidden="true">·</span>
          <span className="spr-status-pill">
            {t('spring.status.wire', 'wire')} <b>{info.wireLength.toFixed(0)}</b> {t('unit.mm', 'mm')}
          </span>
          <span className="spr-status-sep" aria-hidden="true">·</span>
          <span className="spr-status-pill">
            <b>{lineCount}</b> {t('spring.status.lines', 'G-code lines')}
          </span>
          <span className="spr-status-sync" title={t('spring.live.title', 'Lines auto-synced to the Program tab')}>
            → {t('spring.status.program', 'Program')}
          </span>
        </div>

        {/* Production counter — tally of springs wound (auto +1 per finished run). */}
        <div className="spr-counter" role="group" aria-label={t('spring.count.aria', 'Production counter')}>
          <div className="spr-counter-main">
            <EditableCount
              value={produced}
              onChange={(n) => setProduced(n)}
              ariaLabel={t('spring.count.label', 'springs produced')}
            />
            <span className="spr-counter-lbl">
              {t('spring.count.label', 'springs produced')}
              <InfoTip
                topic="springCount"
                title={t('spring.count.label', 'Springs produced')}
                body={t(
                  'spring.count.body',
                  'A running tally that increases by one each time a coiling run finishes streaming. Use +1 for a hand-fed part, or Reset to start a new batch.',
                )}
              />
            </span>
          </div>
          <div className="spr-counter-btns">
            <button
              type="button"
              className="spr-counter-btn"
              onClick={() => setProduced((n) => n + 1)}
              title={t('spring.count.inc.title', 'Add one to the count')}
            >
              +1
            </button>
            <button
              type="button"
              className="spr-counter-btn is-reset"
              onClick={() => setProduced(0)}
              disabled={produced === 0}
              title={t('spring.count.reset.title', 'Reset the count to zero')}
            >
              {t('spring.count.reset', 'Reset')}
            </button>
          </div>
        </div>

        <section className="spr-settings">
          {/* Spring type + direction */}
          <div className="spr-card">
            <div className="spr-card-head">
              <CoilGlyph className="spr-card-ico" />
              <h4>{t('spring.type.title', 'Spring type')}</h4>
              <InfoTip
                topic="springType"
                title={t('spring.type.title', 'Spring type')}
                body={t('spring.type.body', 'Compression springs have closed (squared) ends and an open body pitch. Extension and torsion springs are wound with tight, touching coils throughout (pitch ≈ wire diameter) — hooks/legs are added manually. The machine winds the coil with a rotary chuck + a synced linear carriage (the only output).')}
              />
            </div>
            <div className="spr-fields">
              <label className="spr-field">
                <span className="spr-field-label">{t('spring.field.type', 'Type')}</span>
                <Segmented<SpringType>
                  ariaLabel={t('spring.field.type', 'Type')}
                  variant="tile"
                  value={params.springType}
                  onChange={(v) => setParams((p) => ({ ...p, springType: v }))}
                  options={[
                    { id: 'compression', label: t('spring.type.compression', 'Compression'), title: t('spring.type.compression.body', 'Closed ends, open body pitch'), icon: <CompressionSpringGlyph /> },
                    { id: 'extension', label: t('spring.type.extension', 'Extension'), title: t('spring.type.extension.body', 'Tight coils throughout; hooks made manually'), icon: <ExtensionSpringGlyph /> },
                    { id: 'torsion', label: t('spring.type.torsion', 'Torsion'), title: t('spring.type.torsion.body', 'Tight coils throughout; legs made manually'), icon: <TorsionSpringGlyph /> },
                  ]}
                />
              </label>
              <label className="spr-field">
                <span className="spr-field-label">{t('spring.field.direction', 'Direction')}</span>
                <Segmented<SpringDirection>
                  ariaLabel={t('spring.field.direction', 'Direction')}
                  variant="tile"
                  value={params.direction}
                  onChange={(v) => setParams((p) => ({ ...p, direction: v }))}
                  options={[
                    { id: 'cw', label: t('spring.dir.cw', 'CW'), title: t('spring.dir.cw.body', 'Right-hand winding (clockwise)'), icon: <CwGlyph /> },
                    { id: 'ccw', label: t('spring.dir.ccw', 'CCW'), title: t('spring.dir.ccw.body', 'Left-hand winding (counter-clockwise)'), icon: <CcwGlyph /> },
                  ]}
                />
              </label>
              {tight && (
                <p className="spr-note">
                  {t('spring.note.tight', 'Tight coils — body pitch is locked to the wire diameter. Hooks/legs are made manually after winding.')}
                </p>
              )}
            </div>
          </div>

          {/* Geometry */}
          <div className="spr-card">
            <div className="spr-card-head">
              <GeometryGlyph className="spr-card-ico" />
              <h4>{t('spring.geom.title', 'Geometry')}</h4>
              <InfoTip
                topic="springGeom"
                title={t('spring.geom.title', 'Geometry')}
                body={t('spring.geom.body', 'Wire diameter and the MEAN coil diameter (the diameter the wire centre traces ≈ mandrel diameter + wire diameter). Body turns are the active turns wound at the body pitch; pitch is the axial advance per revolution.')}
              />
            </div>
            <div className="spr-fields">
              <SliderField
                label={t('spring.field.wireDia', 'Wire ⌀')}
                unit={t('unit.mm', 'mm')}
                min={0.1}
                max={6}
                step={0.05}
                value={params.wireDiameter}
                onChange={(n) => setParams((p) => ({ ...p, wireDiameter: n }))}
                info={{ title: t('spring.field.wireDia', 'Wire diameter'), body: t('spring.field.wireDia.body', 'Wire diameter (mm). Closed/tight coils use this as the pitch so the coils touch.') }}
              />
              <SliderField
                label={t('spring.field.coilDia', 'Coil ⌀ (mean)')}
                unit={t('unit.mm', 'mm')}
                min={1}
                max={80}
                step={0.5}
                value={params.coilDiameter}
                onChange={(n) => setParams((p) => ({ ...p, coilDiameter: n }))}
                info={{ title: t('spring.field.coilDia', 'Mean coil diameter'), body: t('spring.field.coilDia.body', 'Mean coil diameter (mm) — the diameter the wire centre traces. The 3D helix radius is half this.') }}
              />
              <SliderField
                label={t('spring.field.bodyTurns', 'Body turns')}
                min={0}
                max={60}
                step={0.5}
                value={params.bodyTurns}
                onChange={(n) => setParams((p) => ({ ...p, bodyTurns: n }))}
                info={{ title: t('spring.field.bodyTurns', 'Body turns'), body: t('spring.field.bodyTurns.body', 'Active turns wound at the body pitch (one revolution of the chuck = one turn).') }}
              />
              <SliderField
                label={t('spring.field.pitch', 'Body pitch')}
                unit={t('unit.mm', 'mm')}
                min={0}
                max={20}
                step={0.1}
                value={tight ? safeParams.wireDiameter : params.pitch}
                disabled={tight}
                onChange={(n) => setParams((p) => ({ ...p, pitch: n }))}
                info={{ title: t('spring.field.pitch', 'Body pitch'), body: t('spring.field.pitch.body', 'Axial advance per revolution in the body (mm). Locked to the wire diameter for tight extension/torsion springs.') }}
              />
            </div>
          </div>

          {/* Closing turns — only meaningful for compression springs. */}
          <div className="spr-card">
            <div className="spr-card-head">
              <ClosingGlyph className="spr-card-ico" />
              <h4>{t('spring.close.title', 'Closing turns')}</h4>
              <InfoTip
                topic="springClose"
                title={t('spring.close.title', 'Closing (dead) turns')}
                body={t('spring.close.body', 'Closed (dead) turns at each end where the pitch ≈ wire diameter so the coils touch — squared compression-spring ends. Extension/torsion springs are closed throughout, so closing turns do not apply.')}
              />
            </div>
            <div className="spr-fields">
              {tight ? (
                <p className="spr-note">
                  {t('spring.close.na', 'Not applicable — this spring type is wound with tight coils end to end.')}
                </p>
              ) : (
                <>
                  <SliderField
                    label={t('spring.field.closeStart', 'Close start')}
                    unit={t('unit.turns', 'turns')}
                    min={0}
                    max={5}
                    step={0.25}
                    value={params.closeTurnsStart}
                    onChange={(n) => setParams((p) => ({ ...p, closeTurnsStart: n }))}
                    info={{ title: t('spring.field.closeStart', 'Closing turns (start)'), body: t('spring.field.closeStart.body', 'Tight, touching turns at the START end (pitch = wire diameter).') }}
                  />
                  <SliderField
                    label={t('spring.field.closeEnd', 'Close end')}
                    unit={t('unit.turns', 'turns')}
                    min={0}
                    max={5}
                    step={0.25}
                    value={params.closeTurnsEnd}
                    onChange={(n) => setParams((p) => ({ ...p, closeTurnsEnd: n }))}
                    info={{ title: t('spring.field.closeEnd', 'Closing turns (end)'), body: t('spring.field.closeEnd.body', 'Tight, touching turns at the END end (pitch = wire diameter).') }}
                  />
                </>
              )}
              {/* Release turns apply to ALL spring types (relieving wind-up for
                  removal), so this row is outside the compression-only gate. */}
              <SliderField
                label={t('spring.field.releaseTurns', 'Release turns')}
                unit={t('unit.turns', 'turns')}
                min={0}
                max={5}
                step={0.25}
                value={params.releaseTurns}
                onChange={(n) => setParams((p) => ({ ...p, releaseTurns: n }))}
                info={{
                  title: t('spring.field.releaseTurns', 'Release turns'),
                  body: t(
                    'spring.field.releaseTurns.body',
                    'After winding, the chuck reverse-rotates this many turns (the carriage stays put) to relieve the wound-up tension so the finished spring slips off the mandrel. 0 = none.',
                  ),
                }}
              />
            </div>
          </div>

          {/* Motion */}
          <div className="spr-card">
            <div className="spr-card-head">
              <MotionGlyph className="spr-card-ico" />
              <h4>{t('spring.motion.title', 'Motion')}</h4>
              <InfoTip
                topic="springMotion"
                title={t('spring.motion.title', 'Motion')}
                body={t('spring.motion.body', 'Chuck speed (rev/min) sets the winding rate; the linear carriage feed is derived from it and the pitch so the two axes stay synced. Segments/rev controls how finely each revolution is subdivided for smooth coordinated motion. Decimals sets the emitted coordinate precision.')}
              />
            </div>
            <div className="spr-fields">
              <SliderField
                label={t('spring.field.rpm', 'Chuck speed')}
                unit={t('unit.rpm', 'rev/min')}
                min={1}
                max={200}
                step={1}
                value={params.chuckRpm}
                onChange={(n) => setParams((p) => ({ ...p, chuckRpm: n }))}
                info={{ title: t('spring.field.rpm', 'Chuck speed'), body: t('spring.field.rpm.body', 'Chuck rotational speed (rev/min). The synced linear feed = speed × pitch.') }}
              />
              <SliderField
                label={t('spring.field.segs', 'Segments/rev')}
                min={4}
                max={180}
                step={1}
                value={params.segmentsPerRev}
                parse={(v, fb) => intNum(v, fb)}
                onChange={(n) => setParams((p) => ({ ...p, segmentsPerRev: Math.floor(n) }))}
                info={{ title: t('spring.field.segs', 'Segments per revolution'), body: t('spring.field.segs.body', 'How many coordinated moves make up each revolution (higher = smoother motion + bigger program).') }}
              />
              <SliderField
                label={t('spring.field.decimals', 'Decimals')}
                min={0}
                max={6}
                step={1}
                value={params.decimals}
                parse={(v, fb) => clampDecimals(intNum(v, fb))}
                onChange={(n) => setParams((p) => ({ ...p, decimals: clampDecimals(n) }))}
                info={{ title: t('spring.field.decimals', 'Decimals'), body: t('spring.field.decimals.body', 'Number of decimal places in the emitted coordinates (0–6).') }}
              />
              <p className="spr-note">
                {t('spring.note.derived', 'Body pitch {pitch} mm · free length {free} mm · ≈{wire} mm of wire · {turns} total turns', {
                  pitch: info.bodyPitch.toFixed(2),
                  free: info.freeLength.toFixed(1),
                  wire: info.wireLength.toFixed(0),
                  turns: info.totalTurns.toFixed(2),
                })}
              </p>
            </div>
          </div>
        </section>

        {/* Raw G-code (collapsed) — the 2-axis machine program. */}
        <div className="spr-card">
          <div className="spr-card-head">
            <h4>{t('spring.raw.head', 'Program')}</h4>
            <span className="spr-status-pill" style={{ marginLeft: 'auto' }}>
              {t('spring.raw.machine', 'machine (rotary+linear)')}
            </span>
          </div>
          <button
            className="spr-raw-toggle"
            onClick={() => setShowRaw((v) => !v)}
            aria-expanded={showRaw}
            title={t('spring.raw.title', 'Show the generated G-code text')}
          >
            <Icon name={showRaw ? 'chevron-down' : 'chevron-right'} size={14} />
            {t('spring.raw', 'Raw G-code ({n} lines)', { n: lineCount })}
          </button>
          {showRaw && <pre className="spr-preview">{machineGcode}</pre>}
        </div>
      </div>
      <PresetSaveBar
        slots={presets.slots}
        selected={presets.selected}
        onSelect={presets.select}
        onSave={presets.save}
        onClear={presets.clear}
        onRename={presets.rename}
        extra={
          <SaveLoadButtons
            value={params}
            onLoad={(data) => setParams(toParams(data))}
            fileBase="spring-settings"
            ext="ksprcfg"
            saveTitle={t('spring.settings.save', 'Save spring settings')}
            loadTitle={t('spring.settings.load', 'Load spring settings')}
            onError={(m) => notify('warn', m)}
          />
        }
      />

      <Modal
        open={showHardware}
        onClose={() => setShowHardware(false)}
        title={t('spring.hw.title', 'Machine hardware')}
        width={560}
      >
        <p className="spr-hw-intro">
          {t(
            'spring.hw.intro',
            'Drivetrain calibration for THIS coiler. Set these once when the machine is built or its motors/gearing/leadscrew change — not per spring. The derived steps/° and steps/mm are what the controller needs (GRBL $100/$101).',
          )}
        </p>
        <div className="spr-hw-grid">
          <h5 className="spr-hw-h">{t('spring.hw.chuck', 'Chuck (rotary) axis')}</h5>
          <HwField
            label={t('spring.hw.stepsRev', 'Motor steps / rev')}
            value={hardware.chuckStepsPerRev}
            onChange={(n) => setHardware((h) => ({ ...h, chuckStepsPerRev: n }))}
          />
          <HwField
            label={t('spring.hw.microsteps', 'Microstepping (1/N)')}
            value={hardware.chuckMicrosteps}
            onChange={(n) => setHardware((h) => ({ ...h, chuckMicrosteps: n }))}
          />
          <HwField
            label={t('spring.hw.gear', 'Gear ratio (motor:chuck)')}
            value={hardware.chuckGearRatio}
            step={0.1}
            onChange={(n) => setHardware((h) => ({ ...h, chuckGearRatio: n }))}
          />
          <p className="spr-hw-derived">
            {t('spring.hw.stepsDeg', 'Resolution')}:{' '}
            <b>
              {(
                (hardware.chuckStepsPerRev * hardware.chuckMicrosteps * hardware.chuckGearRatio) /
                360
              ).toFixed(3)}
            </b>{' '}
            {t('spring.hw.stepsDegUnit', 'steps/°')}
          </p>

          <h5 className="spr-hw-h">{t('spring.hw.carriage', 'Carriage (linear) axis')}</h5>
          <HwField
            label={t('spring.hw.lead', 'Leadscrew lead (mm/rev)')}
            value={hardware.screwLead}
            step={0.1}
            onChange={(n) => setHardware((h) => ({ ...h, screwLead: n }))}
          />
          <HwField
            label={t('spring.hw.stepsRev', 'Motor steps / rev')}
            value={hardware.carriageStepsPerRev}
            onChange={(n) => setHardware((h) => ({ ...h, carriageStepsPerRev: n }))}
          />
          <HwField
            label={t('spring.hw.microsteps', 'Microstepping (1/N)')}
            value={hardware.carriageMicrosteps}
            onChange={(n) => setHardware((h) => ({ ...h, carriageMicrosteps: n }))}
          />
          <p className="spr-hw-derived">
            {t('spring.hw.stepsMm', 'Resolution')}:{' '}
            <b>
              {hardware.screwLead > 0
                ? (
                    (hardware.carriageStepsPerRev * hardware.carriageMicrosteps) /
                    hardware.screwLead
                  ).toFixed(3)
                : '—'}
            </b>{' '}
            {t('spring.hw.stepsMmUnit', 'steps/mm')}
          </p>

          <h5 className="spr-hw-h">{t('spring.hw.wiring', 'Axis wiring (controller)')}</h5>
          <label className="spr-hw-field">
            <span>
              {t('spring.field.rotaryAxis', 'Chuck axis (rotary)')}
              <InfoTip
                topic="springAxis"
                title={t('spring.field.rotaryAxis', 'Chuck axis (rotary)')}
                body={t(
                  'spring.field.rotaryAxis.body',
                  'Which controller axis the chuck/rotation stepper is wired to. A standard 3-axis GRBL board has only X/Y/Z — pick A only on a 4-axis grblHAL/FluidNC board. Must differ from the carriage axis.',
                )}
              />
            </span>
            <Segmented<string>
              ariaLabel={t('spring.field.rotaryAxis', 'Chuck axis (rotary)')}
              value={rotaryAxis}
              onChange={(v) => setRotaryAxis(v)}
              options={[
                { id: 'X', label: 'X' },
                { id: 'Y', label: 'Y' },
                { id: 'Z', label: 'Z' },
                { id: 'A', label: 'A' },
              ]}
            />
          </label>
          <label className="spr-hw-field">
            <span>{t('spring.field.linearAxis', 'Carriage axis (linear)')}</span>
            <Segmented<string>
              ariaLabel={t('spring.field.linearAxis', 'Carriage axis (linear)')}
              value={linearAxis}
              onChange={(v) => setLinearAxis(v)}
              options={[
                { id: 'X', label: 'X' },
                { id: 'Y', label: 'Y' },
                { id: 'Z', label: 'Z' },
              ]}
            />
          </label>
          {rotaryAxis === linearAxis && (
            <p className="spr-note" role="alert" style={{ gridColumn: '1 / -1' }}>
              {t(
                'spring.note.axisClash',
                'Chuck and carriage are on the same axis — pick two different axes.',
              )}
            </p>
          )}
        </div>
        <div className="spr-hw-foot">
          <button
            type="button"
            className="spr-hw-reset"
            onClick={() => setHardware(DEFAULT_HARDWARE)}
          >
            {t('spring.hw.reset', 'Restore defaults')}
          </button>
          <button type="button" className="spr-hw-done" onClick={() => setShowHardware(false)}>
            {t('spring.hw.done', 'Done')}
          </button>
        </div>
      </Modal>
    </div>
  )
}

/** A labelled integer/decimal field for the hardware-config modal. */
function HwField(props: {
  label: string
  value: number
  step?: number
  onChange: (n: number) => void
}) {
  const { label, value, step = 1, onChange } = props
  return (
    <label className="spr-hw-field">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={String(value)}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          onChange(Number.isFinite(n) && n >= 0 ? n : 0)
        }}
      />
    </label>
  )
}
