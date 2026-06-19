import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  runAutoCalibration,
  type AutoCalibProgress,
  type KinematicsInfo,
} from '../camera/autoCalib'
import { generateCalibrationSheet, generateCornerMarkersPdf, registrationMarkers } from '../camera/calibPdf'
import {
  detectGridMarkers,
  calibrateCameraFromGrid,
  detectCameraRoles,
  calibrateHeadFromMotion,
  solveSheetTransform,
  type CameraRole,
  type RoleProbeProgress,
  type SheetRegistration,
} from '../camera/qrCalib'
import { grbl } from '../serial/controller'
import { useT } from '../i18n'
import { Icon } from '../components/Icons'
import { IconButton } from '../components/IconButton'
import { CamEmpty } from '../components/cam/CamUI'
import { useCameraCalib, useCameraLive, useMachine, usePersistentState } from '../store'
import { useProgram } from '../store/program'
import { useTabCommands } from '../machine/tabCommands'
import { useBed } from '../store/bed'
import { startRecordingSession, type RecordingSession } from '../camera/recorder'
import {
  saveClip,
  listClips,
  getClipBlob,
  deleteClip,
  type ClipMeta,
} from '../store/cameraClips'
import {
  solveHomography,
  reprojectionRMS,
  applyHomography,
  silhouetteMask,
  invertMat3,
  assumedIntrinsics,
  poseFromPlaneHomography,
  visualHull,
  parseMarkerPayload,
  type GrayImage,
  type Mat3,
  type Vec2,
} from '../core/cameraCalib'
import {
  captureFrame,
  videoToGray,
  detectQrCodes,
  frameDiagnostics,
  zxingStatus,
  qrDecodeAvailable,
  bedCornersMm,
  BED_CORNER_ORDER,
  clickToImagePx,
  minPairwiseDist,
  rectFromPoints,
  centeredRect,
  type CapturedFrame,
} from '../camera/bedTracking'
import '../styles/cam.css'
import '../styles/camera.css'

/**
 * Camera panel — webcam feed tooling PLUS live-camera → 3D bed tracking.
 *
 * Original features (kept intact): two camera SLOTS (primary + secondary),
 * device picker, live feed, MediaRecorder recording, PNG snapshot, timelapse,
 * the printable QR calibration sheet, and a saved-clips list.
 *
 * New "Bed tracking (3D)" feature: calibrate each camera's image⇄bed-mm
 * homography (three methods), publish each live <video> to `useCameraLive` so
 * the 3D viewer can texture the bed, toggle/opacity for the overlay, detect or
 * set the job footprint, and a two-camera visual-hull job-height estimate. Pure
 * math comes from `src/core/cameraCalib.ts`; DOM/QR glue from
 * `src/camera/bedTracking.ts`. Calibration is persisted via `useCameraCalib`.
 *
 * Pure UI/orchestration here: component state + refs + the two stores.
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'unsupported' }
  | { kind: 'denied' }
  | { kind: 'nocamera' }
  | { kind: 'error'; message: string }

interface Clip {
  id: number
  name: string
  url: string
  kind: 'rec' | 'timelapse'
  bytes: number
}

/** Slot index — 0 = primary, 1 = secondary. */
type SlotIdx = 0 | 1

/**
 * Calibration method chooser. Tab order/default is Auto · Manual · QR · Bed.
 *   - 'auto'    : fully-automatic (jog a grid, auto-detect the tool) — DEFAULT.
 *   - 'machine' : manual machine-motion (jog + click the tool) — the fallback.
 *   - 'qr'      : read the printed TARGET QR codes.
 *   - 'manual'  : click the 4 bed corners.
 */
type CalibMethod = 'auto' | 'machine' | 'qr' | 'manual' | 'head'

/** Live state of an automatic-calibration run (drives the progress UI). */
interface AutoRunState {
  running: boolean
  progress: AutoCalibProgress | null
  /** Terminal message (success / error / abort) shown after the run ends. */
  done: string | null
  /**
   * Per-axis kinematics detected by the probe step (head/bed + px/mm), shown so
   * the operator can confirm e.g. "X → head, Y → bed". Null until a run reports
   * it (the probe runs as the first part of Auto-calibrate).
   */
  kinematics: KinematicsInfo | null
}

/**
 * The "Camera → server bridge" (auto-POSTing live JPEGs to the dev server's
 * `/__camera_frame` endpoint so a developer/agent on the server can SEE the
 * camera while tuning calibration) is a DEVELOPMENT-ONLY aid. In a production
 * build that endpoint does not exist, so the auto-stream would 404-spam while
 * uploading the user's webcam — a privacy problem. Gate every bit of it (UI +
 * the auto-POST effect) behind Vite's `import.meta.env.DEV`, which is statically
 * `false` in prod builds and lets the bundler drop the whole branch.
 */
const FEED_BRIDGE_ENABLED = import.meta.env.DEV

/** Pick a supported webm mime type for MediaRecorder, falling back gracefully. */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return undefined
}

/** mm:ss elapsed formatter. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Human file size. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** mm:ss duration from a millisecond span (for saved clips). */
function fmtDuration(ms: number): string {
  return fmtElapsed(ms)
}

/** Timestamp-based clip name like `karmyogi-cam-2026-06-11_14-32-05`. */
function timestampClipName(when: number): string {
  const d = new Date(when)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `karmyogi-cam-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  )
}

/** File extension implied by a recorder MIME type. */
function extForMime(mime: string): string {
  return mime.includes('mp4') ? 'mp4' : 'webm'
}

/** Trigger a browser download of a blob URL with the given filename. */
function downloadUrl(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Quality bucket from a reprojection RMS (mm). */
function rmsQuality(rms: number | null): 'good' | 'ok' | 'poor' | null {
  if (rms == null) return null
  if (rms <= 1.5) return 'good'
  if (rms <= 4) return 'ok'
  return 'poor'
}

/**
 * Advanced live-camera image controls. These are NON-STANDARD MediaStreamTrack
 * video settings (the Image Capture / constrainable-properties extensions) — not
 * in the base `MediaTrackCapabilities`/`MediaTrackSettings` lib types — so we read
 * capabilities/settings as plain records and write them through the
 * `applyConstraints({ advanced: [{ <name>: value }] })` escape hatch. Only the
 * settings the active device actually reports get a slider; the rest are hidden.
 *
 * Each entry carries a stable i18n key + English fallback for its label.
 */
interface AdvCapDef {
  /** MediaStreamTrack constrainable-property name (e.g. 'brightness'). */
  name: string
  /** i18n key for the slider label. */
  key: string
  /** English fallback label. */
  label: string
}

const ADV_CAP_DEFS: AdvCapDef[] = [
  { name: 'brightness', key: 'cam.adv.brightness', label: 'Brightness' },
  { name: 'contrast', key: 'cam.adv.contrast', label: 'Contrast' },
  { name: 'saturation', key: 'cam.adv.saturation', label: 'Saturation' },
  { name: 'sharpness', key: 'cam.adv.sharpness', label: 'Sharpness' },
  { name: 'exposureCompensation', key: 'cam.adv.exposureComp', label: 'Exposure compensation' },
  { name: 'exposureTime', key: 'cam.adv.exposureTime', label: 'Exposure time' },
  { name: 'colorTemperature', key: 'cam.adv.colorTemperature', label: 'White balance (K)' },
  { name: 'iso', key: 'cam.adv.iso', label: 'ISO' },
  { name: 'focusDistance', key: 'cam.adv.focusDistance', label: 'Focus distance' },
  { name: 'zoom', key: 'cam.adv.zoom', label: 'Zoom' },
]

/**
 * The camera "auto" modes (enum constrainable properties, NOT numeric ranges):
 * each is a `*Mode` whose 'continuous' value turns the auto function ON and
 * 'manual' hands control to a linked numeric setting. Enabled (continuous) by
 * default on start so the camera's autofocus / auto-exposure / auto-white-balance
 * all engage. Mirrors the v4l2 controls (auto_exposure, white_balance_automatic).
 */
interface AutoModeDef {
  /** MediaStreamTrack `*Mode` constrainable property. */
  mode: 'focusMode' | 'exposureMode' | 'whiteBalanceMode'
  /** Linked numeric setting used when switched to manual. */
  manual: string
  key: string
  label: string
}
const AUTO_MODE_DEFS: AutoModeDef[] = [
  { mode: 'focusMode', manual: 'focusDistance', key: 'cam.adv.autofocus', label: 'Autofocus' },
  { mode: 'exposureMode', manual: 'exposureTime', key: 'cam.adv.autoexposure', label: 'Auto exposure' },
  { mode: 'whiteBalanceMode', manual: 'colorTemperature', key: 'cam.adv.autowb', label: 'Auto white balance' },
]

/** A numeric range as reported by getCapabilities() for one setting. */
interface AdvCapRange {
  min: number
  max: number
  step: number
}

/** A discovered, adjustable setting on the active track. */
interface AdvCap extends AdvCapDef, AdvCapRange {
  /** Current device value (from getSettings()), if known. */
  current: number | null
}

/** Persisted user overrides per slot: { [setting]: value }. */
type AdvOverrides = Record<string, number>

/** Read a numeric { min,max,step } range from a capabilities record entry. */
function asRange(cap: unknown): AdvCapRange | null {
  if (!cap || typeof cap !== 'object') return null
  const o = cap as { min?: unknown; max?: unknown; step?: unknown }
  const min = typeof o.min === 'number' ? o.min : null
  const max = typeof o.max === 'number' ? o.max : null
  if (min == null || max == null || !(max > min)) return null
  const step = typeof o.step === 'number' && o.step > 0 ? o.step : (max - min) / 100
  return { min, max, step }
}

/** Feature-detect: does this track expose getCapabilities/applyConstraints? */
function trackSupportsAdvanced(track: MediaStreamTrack | null | undefined): boolean {
  return (
    !!track &&
    typeof track.getCapabilities === 'function' &&
    typeof track.applyConstraints === 'function'
  )
}

/**
 * A house-style collapsible SECTION card: a slim header (title + optional status
 * badge on the right) with a chevron disclosure, and a body that shows only when
 * open. Open/closed is owned by the caller (persisted via usePersistentState) so
 * the operator's layout survives a reload. Keeps the panel calm: a first-time
 * user sees a few labelled sections, not every control at once.
 */
function CamSection({
  title,
  open,
  onToggle,
  badge,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="cam-sec" data-open={open}>
      <button
        type="button"
        className="cam-sec-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="cam-sec-title">{title}</span>
        {badge != null && <span className="cam-sec-badge">{badge}</span>}
      </button>
      {open && <div className="cam-sec-body">{children}</div>}
    </section>
  )
}

/**
 * Tiny "ⓘ" info affordance — a compact, accessible way to relocate a long
 * explanatory paragraph into a hover/focus tooltip so the panel stays dense.
 * The descriptive text rides on BOTH `title` (native hover tooltip) and
 * `aria-label` (screen-reader name) so nothing is lost when the prose leaves
 * the visible flow. Sits inline next to a section heading or label.
 */
function CamInfo({ text, label }: { text: string; label: string }) {
  return (
    <button type="button" className="cam-info" title={text} aria-label={label}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
        <rect x="7.2" y="6.7" width="1.6" height="5" rx="0.8" fill="currentColor" />
      </svg>
    </button>
  )
}

/**
 * Sleek slider + number-input + unit row — a local replica of the CadCam panel's
 * SliderField (and the Controller jog "Feed" control), restyled with `.cam-*`
 * classes so camera.css owns its own slider chrome (no cross-panel CSS import).
 * A full-width row: leading glyph + label, a themed draggable `.cam-slider`
 * (accent fill via the inline `--pct` var), a small typable `.cam-slider-num`,
 * and an optional unit suffix. `value`/`onChange` carry the field's existing
 * wiring untouched — only the input WIDGET changes (number box → slider + input).
 */
function CamSlider({
  icon,
  label,
  htmlFor,
  unit,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  title,
}: {
  icon?: ReactNode
  label: string
  htmlFor: string
  unit?: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step: number
  disabled?: boolean
  title?: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  const pct =
    max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="cam-sfield" title={title}>
      <label className="cam-sfield-lbl" htmlFor={htmlFor}>
        {icon != null && (
          <span className="cam-sfield-ico" aria-hidden>
            {icon}
          </span>
        )}
        <span className="cam-sfield-txt">{label}</span>
      </label>
      <input
        type="range"
        className="cam-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        disabled={disabled}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="cam-sfield-num">
        <input
          id={htmlFor}
          type="number"
          className="cam-slider-num"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit ? <span className="cam-sfield-unit">{unit}</span> : null}
      </span>
    </div>
  )
}

export function CameraPanel() {
  const t = useT()
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'

  // ---- bed-tracking stores ----
  const calib = useCameraCalib()
  const setVideoEl = useCameraLive((s) => s.setVideoEl)
  const bed = useBed()
  const machineConn = useMachine((s) => s.connection)
  const wpos = useMachine((s) => s.wpos)

  // ---- per-slot refs: one set of capture machinery PER slot ----
  // Slot 0 is the "main" feed (records / snapshots / timelapse run on it);
  // slot 1 is a secondary view (used for the second visual-hull camera).
  const videoRefs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null])
  // Test-pattern (synthetic camera) animation interval ids per slot.
  const testRefs = useRef<[number | null, number | null]>([null, null])
  const streamRefs = useRef<[MediaStream | null, MediaStream | null]>([null, null])

  // Recording / timelapse machinery (slot 0 only).
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recTimerRef = useRef<number | null>(null)

  const tlCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const tlRecorderRef = useRef<MediaRecorder | null>(null)
  const tlChunksRef = useRef<Blob[]>([])
  const tlCaptureTimerRef = useRef<number | null>(null)
  const tlDrawTimerRef = useRef<number | null>(null)
  const tlFramesRef = useRef<ImageBitmap[]>([])
  const tlDrawIdxRef = useRef(0)

  const seqRef = useRef(0)

  // Mirror of `clips` so the unmount cleanup can revoke their blob URLs without
  // re-subscribing the cleanup effect to every clips change (which would tear
  // down + rebuild all the camera cleanup each time a clip is added/removed).
  const clipsRef = useRef<Clip[]>([])

  // Empty-bed reference grayscale frames per slot (transient — for visual hull).
  const refGrayRef = useRef<[GrayImage | null, GrayImage | null]>([null, null])

  // ---- state ----
  const [status, setStatus] = useState<[Status, Status]>([
    supported ? { kind: 'idle' } : { kind: 'unsupported' },
    supported ? { kind: 'idle' } : { kind: 'unsupported' },
  ])
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceIds, setDeviceIds] = useState<[string, string]>(['', ''])
  const [secondaryEnabled, setSecondaryEnabled] = useState(false)
  const [clips, setClips] = useState<Clip[]>([])

  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  // Surfaced when MediaRecorder is missing or a recording/timelapse fails to start.
  const [recError, setRecError] = useState<string | null>(null)

  const [tlActive, setTlActive] = useState(false)
  const [tlInterval, setTlInterval] = useState('5')
  const [tlFps, setTlFps] = useState('10')
  const [tlCount, setTlCount] = useState(0)

  // ---- AUTO-record (record while a program streams) ----
  // Persisted ON/OFF for the auto-record behavior (pill toggle below).
  const [autoRecord, setAutoRecord] = usePersistentState<boolean>('karmyogi.camera.autoRecord', false)
  // The program-streaming flag, observed READ-ONLY from the program store.
  const streaming = useProgram((s) => s.streaming)
  // True while an auto-record session is actively capturing (drives the live dot).
  const [autoRecActive, setAutoRecActive] = useState(false)
  // Saved clips (metadata only — blobs stay in IndexedDB until played/downloaded).
  const [savedClips, setSavedClips] = useState<ClipMeta[]>([])
  // The id of the clip currently expanded for inline playback (+ its object URL).
  const [playingClip, setPlayingClip] = useState<{ id: number; url: string } | null>(null)
  // Surfaced when auto-record can't start/save (no recorder, no live camera, quota).
  const [autoRecMsg, setAutoRecMsg] = useState<string | null>(null)
  // The in-flight auto-record session (slot 0). Held in a ref so the streaming
  // effect can start it on stream-start and stop+persist it on stream-end.
  const autoSessionRef = useRef<RecordingSession | null>(null)
  // Mirror of the inline-playback object URL so the unmount cleanup can revoke it
  // without re-subscribing the cleanup effect to every playback change.
  const playingUrlRef = useRef<string | null>(null)

  // ---- calibration UI state ----
  const [calibSlot, setCalibSlot] = useState<SlotIdx>(0)
  const [method, setMethod] = useState<CalibMethod>('auto')

  // ---- automatic calibration UI state ----
  const [autoSpread, setAutoSpread] = useState('20')
  const [autoPts, setAutoPts] = useState('3')
  const [autoRun, setAutoRun] = useState<AutoRunState>({
    running: false,
    progress: null,
    done: null,
    kinematics: null,
  })
  // Abort handle for the in-flight auto run (so the Abort button can cancel it).
  const autoAbortRef = useRef<AbortController | null>(null)

  // ---- dev: feed frames to the server (so the agent on the server can SEE this
  // networked client's camera and tune calibration in a closed loop) ----
  const [feedLabel, setFeedLabel] = useState('rest')
  // True while frames are auto-streaming to the server (any camera live).
  const [feedAuto, setFeedAuto] = useState(false)
  const [feedMsg, setFeedMsg] = useState<string | null>(null)

  // Machine-motion pairs: pixel click ↔ live machine XY (work coords, mm).
  const [mmPairs, setMmPairs] = useState<{ px: Vec2; world: Vec2 }[]>([])
  // A pending machine XY captured by "Add point", awaiting a pixel click.
  const [pendingWorld, setPendingWorld] = useState<Vec2 | null>(null)

  // Manual bed-corner clicks (0..4).
  const [cornerClicks, setCornerClicks] = useState<Vec2[]>([])

  // QR auto results.
  const [qrFound, setQrFound] = useState<number | null>(null)
  const [calibMsg, setCalibMsg] = useState<string | null>(null)

  // ---- two-camera GRID calibration (printed marker sheet) ----
  // Persisted inferred mount per slot (head-mounted / stationary), survives reload.
  const [camRoles, setCamRoles] = usePersistentState<[CameraRole, CameraRole]>(
    'karmyogi.camera.roles',
    ['unknown', 'unknown'],
  )
  // Sheet-generation status / busy flag.
  const [sheetBusy, setSheetBusy] = useState(false)
  const [gridMsg, setGridMsg] = useState<string | null>(null)
  // Per-slot grid auto-calibrate marker counts (null = not run this session).
  const [gridFound, setGridFound] = useState<[number | null, number | null]>([null, null])
  // Role-probe live state.
  const [roleRunning, setRoleRunning] = useState(false)
  const [roleProgress, setRoleProgress] = useState<RoleProbeProgress | null>(null)
  // Abort handle for the in-flight role probe.
  const roleAbortRef = useRef<AbortController | null>(null)

  // ---- sheet → machine registration (ties the printed grid to the work frame) ----
  // The printed sheet sits at an unknown offset+rotation on the bed, so a grid-
  // solved homography lands in SHEET-mm, not machine-work-mm. The operator jogs
  // the tool tip to two known markers and captures live work XY at each; from
  // those we bake a rigid sheet→machine transform into the stored homography so
  // it lands in machine-work-mm (consistent with the bed-corner / machine-motion
  // methods and what CameraBedPlane expects). PERSISTED so it survives reload and
  // can be re-applied / recomputed. null entry = not yet captured.
  const [sheetReg, setSheetReg] = usePersistentState<{
    originMachine: [number, number] | null
    secondMachine: [number, number] | null
  }>('karmyogi.camera.sheetReg', { originMachine: null, secondMachine: null })

  // Job manual inputs.
  const [jobW, setJobW] = useState('100')
  const [jobD, setJobD] = useState('100')
  const [jobThk, setJobThk] = useState('12')

  // Empty-bed reference captured flags (mirror refGrayRef for re-render).
  const [refCaptured, setRefCaptured] = useState<[boolean, boolean]>([false, false])

  // ---- advanced live-camera image controls (per slot) ----
  // Discovered, adjustable settings on each slot's active track (re-read on every
  // (re)start). Empty = the device/browser exposes nothing adjustable.
  const [advCaps, setAdvCaps] = useState<[AdvCap[], AdvCap[]]>([[], []])
  // PERSISTED user overrides per slot — survive a stream restart + a reload, and
  // are re-applied whenever the camera (re)starts (see applyAdvancedToSlot).
  const [advOverrides, setAdvOverrides] = usePersistentState<[AdvOverrides, AdvOverrides]>(
    'karmyogi.camera.advOverrides',
    [{}, {}],
  )
  // Keep a ref mirror so the (re)start path can read the latest overrides without
  // adding them to startStream's dependency list (which would rebuild the stream
  // callbacks — and could restart streams — on every slider drag).
  const advOverridesRef = useRef(advOverrides)
  useEffect(() => {
    advOverridesRef.current = advOverrides
  }, [advOverrides])

  // Camera AUTO modes (focus / exposure / white balance). `autoModeCaps` is the
  // per-slot map of modeName → supported values the device reports (empty = the
  // browser/OS exposes no control for it). `autoModeOn` (persisted) chooses
  // continuous (auto) vs manual per mode; a mode missing from the map defaults to
  // auto (true).
  const [autoModeCaps, setAutoModeCaps] = useState<
    [Record<string, string[]>, Record<string, string[]>]
  >([{}, {}])
  const [autoModeOn, setAutoModeOn] = usePersistentState<
    [Record<string, boolean>, Record<string, boolean>]
  >('karmyogi.camera.autoMode', [{}, {}])
  const autoModeOnRef = useRef(autoModeOn)
  useEffect(() => {
    autoModeOnRef.current = autoModeOn
  }, [autoModeOn])
  const isAutoOn = (s: SlotIdx, mode: string) => autoModeOn[s][mode] !== false

  // ---- collapsible-section open/closed (persisted) ----
  // The panel is grouped into a few house-style sections. The everyday ones
  // ("Live view") start open; the advanced/occasional ones start collapsed so a
  // first-time user sees a calm panel. Each flag survives a reload.
  const [secLiveOpen, setSecLiveOpen] = usePersistentState<boolean>('karmyogi.camera.sec.live', true)
  const [secCaptureOpen, setSecCaptureOpen] = usePersistentState<boolean>('karmyogi.camera.sec.capture', false)
  const [secSavedOpen, setSecSavedOpen] = usePersistentState<boolean>('karmyogi.camera.sec.saved', false)
  const [secCalibOpen, setSecCalibOpen] = usePersistentState<boolean>('karmyogi.camera.sec.calib', false)

  // QR works everywhere: native BarcodeDetector when present, else the bundled
  // pure-JS decoder fallback. So the QR method is always offered.
  const qrSupported = qrDecodeAvailable()
  // MediaRecorder is needed for both Record and Timelapse (which assemble webm).
  const recorderSupported = typeof MediaRecorder !== 'undefined'

  const live = (s: SlotIdx) => status[s].kind === 'live'

  const setSlotStatus = useCallback((s: SlotIdx, st: Status) => {
    setStatus((prev) => {
      const next: [Status, Status] = [prev[0], prev[1]]
      next[s] = st
      return next
    })
  }, [])

  // ---- device enumeration (shared across slots) ----
  const enumerate = useCallback(async () => {
    if (!supported || !navigator.mediaDevices.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const cams = all.filter((d) => d.kind === 'videoinput')
      setDevices(cams)
      setDeviceIds((prev) => {
        const pick = (cur: string) =>
          cur && cams.some((c) => c.deviceId === cur) ? cur : (cams[0]?.deviceId ?? '')
        return [pick(prev[0]), prev[1] || (cams[1]?.deviceId ?? '')]
      })
    } catch {
      /* ignore — enumeration can fail before any permission */
    }
  }, [supported])

  // ---- stop a slot's stream ----
  const stopStream = useCallback(
    (s: SlotIdx) => {
      // Stop any synthetic test-pattern animation for this slot.
      const tid = testRefs.current[s]
      if (tid !== null) {
        window.clearInterval(tid)
        testRefs.current[s] = null
      }
      const st = streamRefs.current[s]
      if (st) for (const tr of st.getTracks()) tr.stop()
      streamRefs.current[s] = null
      const v = videoRefs.current[s]
      if (v) v.srcObject = null
      // Tell the 3D viewer this slot's feed is gone.
      setVideoEl(s, null)
      // Drop the discovered advanced settings — there's no live track now.
      // (Persisted overrides stay; they re-apply on the next start.)
      setAdvCaps((prev) => {
        if (prev[s].length === 0) return prev
        const next: [AdvCap[], AdvCap[]] = [prev[0], prev[1]]
        next[s] = []
        return next
      })
    },
    [setVideoEl],
  )

  // ---- advanced image controls: discover + (re)apply for a slot ----
  // Read the live track's capabilities/settings and publish the adjustable ones
  // for this slot. getCapabilities/getSettings are non-standard for the image
  // controls, so the records are read defensively. No-op if unsupported.
  const discoverAdvCaps = useCallback((s: SlotIdx) => {
    const track = streamRefs.current[s]?.getVideoTracks()[0]
    if (!trackSupportsAdvanced(track)) {
      setAdvCaps((prev) => {
        const next: [AdvCap[], AdvCap[]] = [prev[0], prev[1]]
        next[s] = []
        return next
      })
      return
    }
    let caps: Record<string, unknown> = {}
    let settings: Record<string, unknown> = {}
    try {
      caps = track!.getCapabilities() as unknown as Record<string, unknown>
    } catch {
      caps = {}
    }
    try {
      settings = track!.getSettings() as unknown as Record<string, unknown>
    } catch {
      settings = {}
    }
    const found: AdvCap[] = []
    for (const def of ADV_CAP_DEFS) {
      const range = asRange(caps[def.name])
      if (!range) continue
      const cur = settings[def.name]
      found.push({
        ...def,
        ...range,
        current: typeof cur === 'number' ? cur : null,
      })
    }
    setAdvCaps((prev) => {
      const next: [AdvCap[], AdvCap[]] = [prev[0], prev[1]]
      next[s] = found
      return next
    })
    // Enum `*Mode` controls (focus/exposure/white balance) — tracked separately
    // from the numeric ranges, for the Auto/Manual toggles.
    const modeCaps: Record<string, string[]> = {}
    for (const def of AUTO_MODE_DEFS) {
      const v = caps[def.mode]
      if (Array.isArray(v) && v.length > 0) modeCaps[def.mode] = v as string[]
    }
    setAutoModeCaps((prev) => {
      const next: [Record<string, string[]>, Record<string, string[]>] = [prev[0], prev[1]]
      next[s] = modeCaps
      return next
    })
  }, [])

  // Apply ALL supported auto modes for a slot: continuous (auto) by default — so
  // autofocus / auto-exposure / auto-white-balance all engage — or manual + the
  // linked numeric setting when the user turned that mode off. No-op for any mode
  // the device/browser doesn't expose.
  const applyAutoModes = useCallback(async (s: SlotIdx) => {
    const track = streamRefs.current[s]?.getVideoTracks()[0]
    if (!trackSupportsAdvanced(track)) return
    let caps: Record<string, unknown> = {}
    try {
      caps = track!.getCapabilities() as unknown as Record<string, unknown>
    } catch {
      return
    }
    for (const def of AUTO_MODE_DEFS) {
      const modes = Array.isArray(caps[def.mode]) ? (caps[def.mode] as string[]) : []
      if (modes.length === 0) continue
      const auto = autoModeOnRef.current[s][def.mode] !== false // default: auto
      try {
        if (auto && modes.includes('continuous')) {
          await track!.applyConstraints({ advanced: [{ [def.mode]: 'continuous' } as unknown as MediaTrackConstraintSet] })
        } else if (!auto && modes.includes('manual')) {
          await track!.applyConstraints({ advanced: [{ [def.mode]: 'manual' } as unknown as MediaTrackConstraintSet] })
          const mv = advOverridesRef.current[s][def.manual]
          if (Number.isFinite(mv)) {
            await track!.applyConstraints({ advanced: [{ [def.manual]: mv } as MediaTrackConstraintSet] })
          }
        }
      } catch {
        /* device rejected this mode — keep going with the others */
      }
    }
  }, [])

  // Re-apply this slot's PERSISTED overrides to its live track. Called on every
  // (re)start so settings survive a stream restart / reload. Each override is
  // applied independently so one unsupported value can't break the rest.
  const applyAdvancedToSlot = useCallback(async (s: SlotIdx) => {
    const track = streamRefs.current[s]?.getVideoTracks()[0]
    if (!trackSupportsAdvanced(track)) return
    const overrides = advOverridesRef.current[s]
    for (const [name, value] of Object.entries(overrides)) {
      if (!Number.isFinite(value)) continue
      try {
        await track!.applyConstraints({ advanced: [{ [name]: value } as MediaTrackConstraintSet] })
      } catch {
        /* device rejected this value — skip it, keep the others */
      }
    }
  }, [])

  // Live-edit one setting: persist it + apply it immediately to the active track.
  const setAdvValue = useCallback(
    (s: SlotIdx, name: string, value: number) => {
      setAdvOverrides((prev) => {
        const next: [AdvOverrides, AdvOverrides] = [{ ...prev[0] }, { ...prev[1] }]
        next[s] = { ...next[s], [name]: value }
        return next
      })
      const track = streamRefs.current[s]?.getVideoTracks()[0]
      if (trackSupportsAdvanced(track)) {
        track!
          .applyConstraints({ advanced: [{ [name]: value } as MediaTrackConstraintSet] })
          .catch(() => {})
      }
    },
    [setAdvOverrides],
  )

  // Reset a slot: clear its persisted overrides and re-apply the device defaults
  // (the capability ranges' implied defaults), then re-read current settings.
  const resetAdvForSlot = useCallback(
    async (s: SlotIdx) => {
      setAdvOverrides((prev) => {
        const next: [AdvOverrides, AdvOverrides] = [{ ...prev[0] }, { ...prev[1] }]
        next[s] = {}
        return next
      })
      const track = streamRefs.current[s]?.getVideoTracks()[0]
      if (trackSupportsAdvanced(track)) {
        // Re-apply each adjustable setting at its capability default (midpoint is
        // a safe neutral when the device doesn't expose a default), then re-read.
        for (const cap of advCaps[s]) {
          const def = cap.current ?? (cap.min + cap.max) / 2
          try {
            await track!.applyConstraints({ advanced: [{ [cap.name]: def } as MediaTrackConstraintSet] })
          } catch {
            /* ignore */
          }
        }
      }
      discoverAdvCaps(s)
    },
    [advCaps, setAdvOverrides, discoverAdvCaps],
  )

  // ---- start / restart a slot's stream ----
  const startStream = useCallback(
    async (s: SlotIdx, id: string) => {
      if (!supported) {
        setSlotStatus(s, { kind: 'unsupported' })
        return
      }
      stopStream(s)
      setSlotStatus(s, { kind: 'starting' })
      // Request a HIGH resolution: the default is often 640×480, which leaves a
      // close-up QR with too few pixels per module to decode reliably. The IMX179
      // is 8MP, so ask for 1080p (the browser picks the nearest the device + the
      // chosen pixel format support, falling back gracefully).
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      }
      if (id) videoConstraints.deviceId = { exact: id }
      const constraints: MediaStreamConstraints = {
        video: videoConstraints,
        audio: false,
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        streamRefs.current[s] = stream
        const v = videoRefs.current[s]
        if (v) {
          v.srcObject = stream
          v.play().catch(() => {})
          // Publish to the live bus so the 3D viewer can texture the bed.
          setVideoEl(s, v)
        }
        setSlotStatus(s, { kind: 'live' })
        await enumerate()
        const track = stream.getVideoTracks()[0]
        const realId = track?.getSettings().deviceId
        if (realId) {
          setDeviceIds((prev) => {
            const next: [string, string] = [prev[0], prev[1]]
            next[s] = realId
            return next
          })
        }
        // Re-apply the user's saved advanced image settings to the fresh track
        // (so they survive a stream restart / reload), then publish the discovered
        // adjustable settings for the UI. Order: apply first, then re-read so the
        // sliders reflect what actually took effect.
        await applyAdvancedToSlot(s)
        // Engage the camera's auto modes (focus / exposure / white balance) so an
        // autofocus module like the Arducam IMX179 sharpens, and auto-exposure /
        // auto-WB track the scene, instead of being stuck on whatever the browser
        // defaulted to. Discover caps FIRST so applyAutoModes sees them.
        discoverAdvCaps(s)
        await applyAutoModes(s)
      } catch (err) {
        const e = err as DOMException
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          setSlotStatus(s, { kind: 'denied' })
        } else if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
          setSlotStatus(s, { kind: 'nocamera' })
        } else {
          setSlotStatus(s, {
            kind: 'error',
            message: e?.message || t('cam.err.couldNotStart', 'Could not start the camera.'),
          })
        }
      }
    },
    [supported, stopStream, enumerate, setVideoEl, setSlotStatus, applyAdvancedToSlot, applyAutoModes, discoverAdvCaps, t],
  )

  // ---- SYNTHETIC test-pattern source (no camera / no permission needed) ----
  // Draws a fake top-down bed with a tool dot (the dot follows the live machine
  // X/Y) onto a canvas and feeds canvas.captureStream() through the SAME pipeline
  // as a real camera — so the feed bridge + 3D overlay + calibration UI can be
  // exercised end-to-end without any webcam. Great for testing on either side.
  const startTestPattern = useCallback(
    (s: SlotIdx) => {
      // The synthetic test pattern only feeds the DEV server bridge — no-op (and
      // drop its body) in production via the literal `import.meta.env.DEV` guard.
      if (!import.meta.env.DEV) return
      stopStream(s)
      setSlotStatus(s, { kind: 'starting' })
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      const draw = () => {
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const W = canvas.width
        const H = canvas.height
        ctx.fillStyle = '#1a1d21'
        ctx.fillRect(0, 0, W, H)
        const bx = 80
        const by = 56
        const bw = W - 160
        const bh = H - 130
        ctx.strokeStyle = '#3a4250'
        ctx.lineWidth = 2
        ctx.strokeRect(bx, by, bw, bh)
        ctx.strokeStyle = '#2a2f37'
        ctx.lineWidth = 1
        for (let i = 1; i < 6; i++) {
          const x = bx + (bw * i) / 6
          ctx.beginPath(); ctx.moveTo(x, by); ctx.lineTo(x, by + bh); ctx.stroke()
        }
        for (let j = 1; j < 4; j++) {
          const y = by + (bh * j) / 4
          ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx + bw, y); ctx.stroke()
        }
        const wp = useMachine.getState().wpos
        const nx = Math.max(0, Math.min(1, (wp.x || 0) / 300))
        const ny = Math.max(0, Math.min(1, (wp.y || 0) / 200))
        const t = performance.now()
        const dx = bx + nx * bw + Math.cos(t / 600) * 5
        const dy = by + (1 - ny) * bh + Math.sin(t / 600) * 5
        ctx.fillStyle = '#f59e0b'
        ctx.beginPath(); ctx.arc(dx, dy, 10, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#9aa3af'
        ctx.font = '13px sans-serif'
        ctx.fillText('TEST PATTERN (synthetic) · dot = machine X/Y', bx, by - 10)
      }
      draw()
      const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(10)
      streamRefs.current[s] = stream
      const v = videoRefs.current[s]
      if (v) {
        v.srcObject = stream
        v.play().catch(() => {})
        setVideoEl(s, v)
      }
      testRefs.current[s] = window.setInterval(draw, 100)
      setSlotStatus(s, { kind: 'live' })
    },
    [stopStream, setVideoEl, setSlotStatus],
  )

  // ---- recording (slot 0) ----
  const stopRecording = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    if (recTimerRef.current !== null) {
      window.clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
  }, [])

  const startRecording = useCallback(() => {
    const stream = streamRefs.current[0]
    if (!stream) return
    if (typeof MediaRecorder === 'undefined') {
      setRecError(
        t('cam.capture.noRecorder', 'Recording is not supported in this browser (no MediaRecorder).'),
      )
      return
    }
    const mime = pickMime()
    let rec: MediaRecorder
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    } catch {
      setRecError(t('cam.capture.recFailed', 'Could not start recording — the camera format may be unsupported.'))
      return
    }
    setRecError(null)
    recChunksRef.current = []
    rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) recChunksRef.current.push(ev.data)
    }
    rec.onstop = () => {
      const type = rec.mimeType || 'video/webm'
      const blob = new Blob(recChunksRef.current, { type })
      recChunksRef.current = []
      const id = ++seqRef.current
      const ext = type.includes('mp4') ? 'mp4' : 'webm'
      const name = `karmyogi-cam-${id}.${ext}`
      const url = URL.createObjectURL(blob)
      downloadUrl(url, name)
      setClips((prev) => [{ id, name, url, kind: 'rec', bytes: blob.size }, ...prev])
      setRecording(false)
    }
    recorderRef.current = rec
    rec.start()
    const startedAt = Date.now()
    setRecElapsed(0)
    setRecording(true)
    recTimerRef.current = window.setInterval(() => {
      setRecElapsed(Date.now() - startedAt)
    }, 250)
  }, [t])

  // ---- snapshot (slot 0) ----
  const snapshot = useCallback(() => {
    const v = videoRefs.current[0]
    if (!v || !v.videoWidth || !v.videoHeight) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) return
      const id = ++seqRef.current
      const url = URL.createObjectURL(blob)
      downloadUrl(url, `karmyogi-snap-${id}.png`)
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }, 'image/png')
  }, [])

  // ── Gamepad command bus: toggle recording + grab a snapshot of the feed. ──
  useTabCommands('camera', {
    recordToggle: () => {
      if (recording) stopRecording()
      else startRecording()
    },
    snapshot: () => snapshot(),
  })

  // ---- timelapse (slot 0) ----
  const stopTimelapse = useCallback(() => {
    if (tlCaptureTimerRef.current !== null) {
      window.clearInterval(tlCaptureTimerRef.current)
      tlCaptureTimerRef.current = null
    }
    if (tlDrawTimerRef.current !== null) {
      window.clearInterval(tlDrawTimerRef.current)
      tlDrawTimerRef.current = null
    }
    const rec = tlRecorderRef.current
    if (rec && rec.state !== 'inactive') {
      window.setTimeout(() => {
        if (rec.state !== 'inactive') rec.stop()
      }, 200)
    }
    setTlActive(false)
  }, [])

  const startTimelapse = useCallback(() => {
    const stream = streamRefs.current[0]
    const v = videoRefs.current[0]
    if (!stream || !v) return
    if (typeof MediaRecorder === 'undefined') {
      setRecError(
        t('cam.capture.noRecorder', 'Recording is not supported in this browser (no MediaRecorder).'),
      )
      return
    }
    const intervalS = Math.max(0.2, parseFloat(tlInterval) || 5)
    const fps = Math.max(1, Math.min(60, Math.round(parseFloat(tlFps) || 10)))

    const w = v.videoWidth || 640
    const h = v.videoHeight || 480

    const canvas = tlCanvasRef.current ?? document.createElement('canvas')
    tlCanvasRef.current = canvas
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    for (const bmp of tlFramesRef.current) bmp.close?.()
    tlFramesRef.current = []
    tlDrawIdxRef.current = 0
    setTlCount(0)

    const canvasStream = canvas.captureStream(fps)
    const mime = pickMime()
    let rec: MediaRecorder
    try {
      rec = mime
        ? new MediaRecorder(canvasStream, { mimeType: mime })
        : new MediaRecorder(canvasStream)
    } catch {
      setRecError(t('cam.capture.tlFailed', 'Could not start the timelapse — the recorder format may be unsupported.'))
      return
    }
    setRecError(null)
    tlChunksRef.current = []
    rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) tlChunksRef.current.push(ev.data)
    }
    rec.onstop = () => {
      const type = rec.mimeType || 'video/webm'
      const blob = new Blob(tlChunksRef.current, { type })
      tlChunksRef.current = []
      for (const bmp of tlFramesRef.current) bmp.close?.()
      tlFramesRef.current = []
      if (blob.size === 0) return
      const id = ++seqRef.current
      const ext = type.includes('mp4') ? 'mp4' : 'webm'
      const name = `karmyogi-timelapse-${id}.${ext}`
      const url = URL.createObjectURL(blob)
      downloadUrl(url, name)
      setClips((prev) => [{ id, name, url, kind: 'timelapse', bytes: blob.size }, ...prev])
    }
    tlRecorderRef.current = rec
    rec.start()
    setTlActive(true)

    const capture = () => {
      const vid = videoRefs.current[0]
      if (!vid || !vid.videoWidth) return
      createImageBitmap(vid)
        .then((bmp) => {
          tlFramesRef.current.push(bmp)
          setTlCount(tlFramesRef.current.length)
        })
        .catch(() => {})
    }
    capture()
    tlCaptureTimerRef.current = window.setInterval(capture, intervalS * 1000)

    tlDrawTimerRef.current = window.setInterval(() => {
      const frames = tlFramesRef.current
      if (frames.length === 0) return
      const idx = tlDrawIdxRef.current % frames.length
      const bmp = frames[idx]
      if (bmp) {
        ctx.drawImage(bmp, 0, 0, w, h)
        tlDrawIdxRef.current = idx + 1
      }
    }, Math.round(1000 / fps))
  }, [tlInterval, tlFps, t])

  // ---- AUTO-record: load saved clips on mount + react to streaming ----
  // Load the persisted clip list once on mount (newest first).
  const refreshClips = useCallback(async () => {
    try {
      const metas = await listClips()
      setSavedClips(metas)
    } catch {
      /* IndexedDB unavailable — leave the list empty */
    }
  }, [])

  useEffect(() => {
    refreshClips().catch(() => {})
  }, [refreshClips])

  // Start / stop the auto-record session in lock-step with the program stream.
  // Only the PRIMARY slot (0) is recorded — that's the calibrated, top-down view
  // the rest of the panel already records / snapshots / timelapses.
  useEffect(() => {
    // Begin recording only when auto-record is ARMED and a stream is running.
    if (autoRecord && streaming) {
      // Stream STARTED — begin recording the active primary stream (once).
      if (autoSessionRef.current) return
      const stream = streamRefs.current[0]
      if (!stream) {
        setAutoRecMsg(
          t('cam.auto.noCam', 'Auto-record is ON but Camera 1 is not live — start it to capture the run.'),
        )
        return
      }
      try {
        autoSessionRef.current = startRecordingSession(stream)
        setAutoRecActive(true)
        setAutoRecMsg(null)
      } catch {
        autoSessionRef.current = null
        setAutoRecMsg(
          t('cam.auto.recFailed', 'Could not start auto-recording — the camera format may be unsupported.'),
        )
      }
      return
    }
    // Otherwise (stream ended, OR auto-record disarmed mid-run) — if a session is
    // in flight, stop it and persist what was captured so far.
    const session = autoSessionRef.current
    if (!session) return
    autoSessionRef.current = null
    session
      .stop()
      .then(async (res) => {
        setAutoRecActive(false)
        if (res.blob.size === 0) return
        const when = Date.now()
        const name = `${timestampClipName(when)}.${extForMime(res.mimeType)}`
        try {
          await saveClip({
            name,
            blob: res.blob,
            durationMs: res.durationMs,
            mimeType: res.mimeType,
            createdAt: when,
          })
          await refreshClips()
        } catch {
          setAutoRecMsg(
            t('cam.auto.saveFailed', 'Could not save the recorded clip — the browser cache may be full.'),
          )
        }
      })
      .catch(() => {
        setAutoRecActive(false)
      })
  }, [autoRecord, streaming, t, refreshClips])

  // ---- saved-clip actions: play (inline) / download / delete ----
  const playClip = useCallback(
    async (id: number) => {
      // Toggle: clicking the playing clip closes it (and revokes its URL).
      setPlayingClip((prev) => {
        if (prev && prev.id === id) {
          URL.revokeObjectURL(prev.url)
          return null
        }
        return prev
      })
      const already = playingClip?.id === id
      if (already) return
      const blob = await getClipBlob(id)
      if (!blob) {
        await refreshClips()
        return
      }
      const url = URL.createObjectURL(blob)
      setPlayingClip((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { id, url }
      })
    },
    [playingClip, refreshClips],
  )

  const downloadClip = useCallback(async (meta: ClipMeta) => {
    const blob = await getClipBlob(meta.id)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    downloadUrl(url, meta.name)
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }, [])

  const removeSavedClip = useCallback(
    async (id: number) => {
      setPlayingClip((prev) => {
        if (prev && prev.id === id) {
          URL.revokeObjectURL(prev.url)
          return null
        }
        return prev
      })
      try {
        await deleteClip(id)
      } catch {
        /* ignore — refresh reflects the real state */
      }
      await refreshClips()
    },
    [refreshClips],
  )

  // ---- power toggle per slot ----
  const toggleLive = useCallback(
    (s: SlotIdx) => {
      if (live(s) || status[s].kind === 'starting') {
        if (s === 0) {
          stopRecording()
          stopTimelapse()
        }
        stopStream(s)
        setSlotStatus(s, { kind: 'idle' })
      } else {
        startStream(s, deviceIds[s]).catch(() => {})
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, deviceIds, startStream, stopStream, stopRecording, stopTimelapse, setSlotStatus],
  )

  const onSelectDevice = useCallback(
    (s: SlotIdx, id: string) => {
      setDeviceIds((prev) => {
        const next: [string, string] = [prev[0], prev[1]]
        next[s] = id
        return next
      })
      if (live(s) || status[s].kind === 'starting') {
        if (s === 0) {
          stopRecording()
          stopTimelapse()
        }
        startStream(s, id).catch(() => {})
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, startStream, stopRecording, stopTimelapse],
  )

  // Seed the picker from the PERSISTED per-slot deviceId (so the chosen camera
  // survives a reload). Runs once on mount; only fills slots the user hasn't
  // already touched this session, and only if the store actually has an id.
  // enumerate() afterwards reconciles against the cameras present right now.
  useEffect(() => {
    const persisted = useCameraCalib.getState().cameras
    const id0 = persisted[0]?.deviceId ?? ''
    const id1 = persisted[1]?.deviceId ?? ''
    if (!id0 && !id1) return
    setDeviceIds((prev) => [prev[0] || id0, prev[1] || id1])
    // Mount-only seed; the live store is read imperatively, not subscribed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist each slot's chosen deviceId so the selection survives reload (read
  // back by the mount-seed effect above). Only write when it actually changes.
  useEffect(() => {
    for (const s of [0, 1] as const) {
      if (deviceIds[s] && deviceIds[s] !== calib.cameras[s].deviceId) {
        calib.setCamera(s, { deviceId: deviceIds[s] })
      }
    }
  }, [deviceIds, calib])

  // Initial enumeration + device-change listener.
  useEffect(() => {
    if (!supported) return
    enumerate().catch(() => {})
    const md = navigator.mediaDevices
    const onChange = () => {
      enumerate().catch(() => {})
    }
    md.addEventListener?.('devicechange', onChange)
    return () => {
      md.removeEventListener?.('devicechange', onChange)
    }
  }, [supported, enumerate])

  // Stop the secondary feed when the secondary slot is disabled. Also force the
  // calibration target back to Cam 1 — otherwise the whole calibration block
  // would keep operating on a now-disabled (dead) camera slot.
  useEffect(() => {
    if (!secondaryEnabled) {
      stopStream(1)
      setSlotStatus(1, { kind: 'idle' })
      setCalibSlot(0)
    }
  }, [secondaryEnabled, stopStream, setSlotStatus])

  // Keep the unmount cleanup's clip mirror current.
  useEffect(() => {
    clipsRef.current = clips
  }, [clips])

  // Mirror the inline-playback URL so the unmount cleanup can revoke it.
  useEffect(() => {
    playingUrlRef.current = playingClip?.url ?? null
  }, [playingClip])

  // Full cleanup on unmount.
  useEffect(() => {
    const videoEls = videoRefs.current
    const streamEls = streamRefs.current
    return () => {
      // Abort any in-flight auto-calibration / role probe so no jog is left running.
      autoAbortRef.current?.abort()
      roleAbortRef.current?.abort()
      if (recTimerRef.current !== null) window.clearInterval(recTimerRef.current)
      if (tlCaptureTimerRef.current !== null) window.clearInterval(tlCaptureTimerRef.current)
      if (tlDrawTimerRef.current !== null) window.clearInterval(tlDrawTimerRef.current)
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop()
        } catch {
          /* noop */
        }
      }
      const tlRec = tlRecorderRef.current
      if (tlRec && tlRec.state !== 'inactive') {
        try {
          tlRec.stop()
        } catch {
          /* noop */
        }
      }
      // Stop any in-flight auto-record session (its blob is discarded on unmount).
      autoSessionRef.current?.stop().catch(() => {})
      autoSessionRef.current = null
      // Revoke the inline-playback object URL if one is open.
      if (playingUrlRef.current) {
        URL.revokeObjectURL(playingUrlRef.current)
        playingUrlRef.current = null
      }
      for (const bmp of tlFramesRef.current) bmp.close?.()
      for (let i = 0; i < 2; i++) {
        const s = streamEls[i]
        if (s) for (const tr of s.getTracks()) tr.stop()
        streamEls[i] = null
        const v = videoEls[i]
        if (v) v.srcObject = null
      }
      // Revoke any saved-clip blob URLs so they don't leak after unmount.
      for (const c of clipsRef.current) URL.revokeObjectURL(c.url)
      clipsRef.current = []
      // Detach from the live bus on unmount.
      setVideoEl(0, null)
      setVideoEl(1, null)
    }
  }, [setVideoEl])

  const removeClip = useCallback((id: number) => {
    setClips((prev) => {
      const found = prev.find((c) => c.id === id)
      if (found) URL.revokeObjectURL(found.url)
      return prev.filter((c) => c.id !== id)
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Calibration: shared "store the homography for slot S from imgPts↔worldPts"
  // ---------------------------------------------------------------------------
  const commitHomography = useCallback(
    (s: SlotIdx, imgPts: Vec2[], worldPts: Vec2[], frameW: number, frameH: number): boolean => {
      if (imgPts.length < 4 || imgPts.length !== worldPts.length) {
        setCalibMsg(t('cam.bt.err.need4', 'Need at least 4 well-spread points.'))
        return false
      }
      // Image pixels → bed-mm.
      const H = solveHomography(imgPts, worldPts)
      if (!H) {
        setCalibMsg(t('cam.bt.err.degenerate', 'Could not solve — points may be collinear.'))
        return false
      }
      const rms = reprojectionRMS(H, imgPts, worldPts)
      // These methods calibrate a FIXED (overhead) camera — store the homography
      // and mark the mount fixed so the overlay uses the whole-bed rectification.
      calib.setCamera(s, { mount: 'fixed', H: [...H], rmsMm: rms, frameW, frameH })
      // Turn the bed overlay ON so the rectified camera view appears on the 3D
      // bed immediately — otherwise a successful calibration looks like nothing
      // happened (the overlay defaults off and CameraBedPlane renders null).
      calib.setEnabled(true)
      setCalibMsg(
        t('cam.bt.calibrated', 'Calibrated Cam {n} — RMS {rms} mm', {
          n: s + 1,
          rms: rms.toFixed(2),
        }),
      )
      return true
    },
    [calib, t],
  )

  // ---- (a) machine-motion calibration ----
  const machineReady = machineConn === 'connected'

  const addMachinePoint = useCallback(() => {
    // Capture current machine work XY; the next pixel click pairs to it.
    // The persistent `pendingWorld` prompt (rendered below) tells the user what
    // to do next, so we clear any prior status here to avoid a doubled message.
    setPendingWorld([wpos.x, wpos.y])
    setCalibMsg('')
  }, [wpos.x, wpos.y])

  const solveMachine = useCallback(() => {
    const v = videoRefs.current[calibSlot]
    const imgPts = mmPairs.map((p) => p.px)
    const worldPts = mmPairs.map((p) => p.world)
    const fw = v?.videoWidth || calib.cameras[calibSlot].frameW || 0
    const fh = v?.videoHeight || calib.cameras[calibSlot].frameH || 0
    commitHomography(calibSlot, imgPts, worldPts, fw, fh)
  }, [calibSlot, mmPairs, calib, commitHomography])

  const clearMachinePoints = useCallback(() => {
    setMmPairs([])
    setPendingWorld(null)
    setCalibMsg(null)
  }, [])

  // ---- (a0) FULLY-AUTOMATIC calibration (default) ----
  // Number of grid points, derived from points-per-side (≥2).
  const autoPtsPerSide = Math.max(2, Math.floor(parseFloat(autoPts) || 3))
  const autoPointCount = autoPtsPerSide * autoPtsPerSide
  const autoSpreadMm = Math.max(0, parseFloat(autoSpread) || 0)

  // Translate a stable auto-calibration progress code (emitted by the pure
  // driver) into a localized status line. Keeping the copy here means autoCalib
  // stays i18n-free and the panel owns all user-facing strings (task 5).
  const progressLabel = useCallback(
    (p: AutoCalibProgress): string => {
      const x = p.params ?? {}
      switch (p.code) {
        case 'probeCapturing':
          return t('cam.bt.auto.p.probeCapturing', 'Probing {axis} kinematics — capturing…', x)
        case 'probeJogging':
          return t('cam.bt.auto.p.probeJogging', 'Probing {axis} kinematics — jogging +{delta} mm…', x)
        case 'probeInconclusive':
          return t('cam.bt.auto.p.probeInconclusive', 'Kinematics probe inconclusive — falling back to tool-grid tracking…')
        case 'probeFailed':
          return t('cam.bt.auto.p.probeFailed', 'Kinematics probe failed — falling back to tool-grid tracking…')
        case 'moving':
          return t('cam.bt.auto.p.moving', 'Point {n}/{total} — moving…', x)
        case 'capturing':
          return t('cam.bt.auto.p.capturing', 'Point {n}/{total} — capturing…', x)
        case 'solving':
          return t('cam.bt.auto.p.solving', 'Detecting the tool and solving the homography…')
        case 'doneKinematics':
          return t('cam.bt.auto.p.doneKinematics', 'Calibrated (kinematics: X→{kx}, Y→{ky}) — RMS {rms} mm.', x)
        case 'doneGrid':
          return t('cam.bt.auto.p.doneGrid', 'Calibrated — RMS {rms} mm, used {used}/{total} points.', x)
        case 'aborted':
          return t('cam.bt.auto.aborted', 'Auto-calibration aborted — machine stopped.')
        case 'failed':
          return x.detail != null
            ? String(x.detail)
            : t('cam.bt.auto.failed', 'Auto-calibration failed.')
        default:
          return ''
      }
    },
    [t],
  )

  const runAuto = useCallback(async () => {
    const video = videoRefs.current[calibSlot]
    if (!video || !video.videoWidth) {
      setCalibMsg(t('cam.bt.err.noFrame', 'No live frame — start this camera first.'))
      return
    }
    if (machineConn !== 'connected') {
      setCalibMsg(
        t('cam.bt.auto.notConnected', 'Machine not connected — connect it in the Controller tab first.'),
      )
      return
    }
    const ptsPerSide = Math.max(2, Math.floor(parseFloat(autoPts) || 3))
    const spread = Math.max(1, parseFloat(autoSpread) || 20)
    const count = ptsPerSide * ptsPerSide

    // Safety confirm — the machine is about to move on its own.
    const ok =
      typeof window === 'undefined'
        ? true
        : window.confirm(
            t(
              'cam.bt.auto.confirm',
              'The machine will jog to {n} points around the current position (±{s} mm in X/Y, Z untouched). Make sure the tool is clear and raised. Continue?',
              { n: count, s: spread },
            ),
          )
    if (!ok) return

    // Snapshot the CURRENT work XY as the grid centre at press time.
    const livePos = useMachine.getState().wpos
    const center: [number, number] = [livePos.x, livePos.y]

    const ctrl = new AbortController()
    autoAbortRef.current = ctrl
    setCalibMsg(null)
    setAutoRun({ running: true, progress: null, done: null, kinematics: null })

    try {
      const res = await runAutoCalibration({
        video,
        center,
        spreadMm: spread,
        grid: ptsPerSide,
        feed: 1000,
        settleMs: 250,
        diffThreshold: 28,
        signal: ctrl.signal,
        onProgress: (p) => setAutoRun((prev) => ({ ...prev, progress: p })),
      })
      calib.setCamera(calibSlot, {
        H: res.H,
        rmsMm: res.rmsMm,
        frameW: res.frameW,
        frameH: res.frameH,
      })
      const done =
        res.method === 'kinematics' && res.kinematics
          ? t(
              'cam.bt.auto.okKin',
              'Calibrated — RMS {rms} mm · X→{kx}, Y→{ky}.',
              {
                rms: res.rmsMm.toFixed(2),
                kx: res.kinematics.x.kind,
                ky: res.kinematics.y.kind,
              },
            )
          : t('cam.bt.auto.ok', 'Calibrated — RMS {rms} mm · used {u}/{n} points.', {
              rms: res.rmsMm.toFixed(2),
              u: res.used,
              n: res.total,
            })
      setAutoRun({
        running: false,
        progress: null,
        done,
        kinematics: res.kinematics ?? null,
      })
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      const msg = isAbort
        ? t('cam.bt.auto.aborted', 'Auto-calibration aborted — machine stopped.')
        : err instanceof Error
          ? err.message
          : t('cam.bt.auto.failed', 'Auto-calibration failed.')
      setAutoRun((prev) => ({ running: false, progress: null, done: msg, kinematics: prev.kinematics }))
    } finally {
      autoAbortRef.current = null
    }
  }, [calibSlot, machineConn, autoPts, autoSpread, calib, t])

  const abortAuto = useCallback(() => {
    autoAbortRef.current?.abort()
    grbl.jogCancel()
  }, [])

  // Capture the current calibration-slot frame as a PNG and POST it to the dev
  // server (`/__camera_frame?name=…`), which saves it to ./.camera-frames/ so
  // the developer/agent on the server can see this client's camera.
  const sendFrameToServer = useCallback(
    async (name: string, slot: SlotIdx): Promise<boolean> => {
      // Belt-and-braces: even though every caller is DEV-gated, hard-guard the
      // upload itself with the literal `import.meta.env.DEV` so the bundler folds
      // it to `false` and DROPS the fetch (and the `/__camera_frame` URL) from
      // production output entirely — no live-webcam JPEG ever leaves the browser.
      if (!import.meta.env.DEV) return false
      const v = videoRefs.current[slot]
      // Only capture a REAL, decoded frame: needs current data (readyState ≥ 2)
      // and non-zero dimensions, else we'd post a blank/0-byte image.
      if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return false
      const canvas = document.createElement('canvas')
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
      // Encode to a JPEG blob (binary) — ~10× smaller than PNG for a photo, so it
      // streams fast and stays well under any large-body transport limit (big PNG
      // bodies were getting truncated in transit). Sent as raw binary, not base64.
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82),
      )
      if (!blob || blob.size < 256) return false
      const safe = (name || 'frame').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
      try {
        const r = await fetch(`/__camera_frame?name=${encodeURIComponent(safe)}`, {
          method: 'POST',
          headers: { 'content-type': 'image/jpeg' },
          body: blob,
        })
        return r.ok
      } catch {
        return false
      }
    },
    [calibSlot],
  )

  const sendOneFrame = useCallback(async () => {
    setFeedMsg(t('cam.bt.feed.sending', 'Sending…'))
    const ok = await sendFrameToServer(feedLabel, calibSlot)
    setFeedMsg(
      ok
        ? t('cam.bt.feed.sent', 'Saved {name}.png on the server.', { name: feedLabel || 'frame' })
        : t('cam.bt.feed.failed', 'Send failed — is a camera live?'),
    )
  }, [sendFrameToServer, feedLabel, calibSlot, t])

  // AUTOMATIC BRIDGE: the moment a camera is live, continuously push its frames
  // to the server (live0.png / live1.png) every ~1.2 s with NO clicking, so the
  // server (and the agent on it) always has the latest view of each camera. The
  // ONLY manual step browsers require is the one-time "Start + allow camera"
  // permission grant; after that this runs hands-off until the camera stops.
  useEffect(() => {
    // PRIVACY: only ever run in dev. In a prod build `FEED_BRIDGE_ENABLED` is a
    // static `false`, so this effect short-circuits and the bundler can drop the
    // upload code entirely — no live-webcam JPEGs are POSTed anywhere.
    if (!FEED_BRIDGE_ENABLED) return
    const liveSlots: SlotIdx[] = []
    if (status[0].kind === 'live') liveSlots.push(0)
    if (status[1].kind === 'live') liveSlots.push(1)
    if (liveSlots.length === 0) {
      setFeedAuto(false)
      return
    }
    let cancelled = false
    const tick = async () => {
      let any = false
      for (const s of liveSlots) {
        const ok = await sendFrameToServer(`live${s}`, s)
        any = any || ok
      }
      if (!cancelled) setFeedAuto(any)
    }
    void tick()
    const id = window.setInterval(tick, 1200)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [status, sendFrameToServer])

  // ---- (b) QR auto calibration ----
  const runQrCalib = useCallback(async () => {
    const v = videoRefs.current[calibSlot]
    const frame: CapturedFrame | null = captureFrame(v)
    if (!frame) {
      setCalibMsg(t('cam.bt.err.noFrame', 'No live frame — start this camera first.'))
      return
    }
    const codes = await detectQrCodes(frame)
    // Each TARGET code is placed at a BED CORNER (its TL/TR/BL/BR id). Map the
    // detected pixel centre of each to that bed corner in MACHINE-WORK mm (bed
    // centred on work zero) — the SAME frame the manual corner method and the 3D
    // overlay (CameraBedPlane) use, so the rectified view lands on the real bed.
    const bedCorners = bedCornersMm(bed.width, bed.depth) // order: TL, TR, BR, BL
    const imgByCorner = new Map<string, Vec2>()
    for (const code of codes) {
      const parsed = parseMarkerPayload(code.rawValue)
      if (!parsed || parsed.kind !== 'TARGET') continue
      const pos = parsed.fields.pos // 'TL' | 'TR' | 'BL' | 'BR'
      if (pos && BED_CORNER_ORDER.includes(pos as (typeof BED_CORNER_ORDER)[number])) {
        imgByCorner.set(pos, code.center)
      }
    }
    const imgPts: Vec2[] = []
    const worldPts: Vec2[] = []
    for (let i = 0; i < BED_CORNER_ORDER.length; i++) {
      const px = imgByCorner.get(BED_CORNER_ORDER[i])
      if (!px) continue
      imgPts.push(px)
      worldPts.push(bedCorners[i])
    }
    setQrFound(imgPts.length)
    if (imgPts.length < 4) {
      setCalibMsg(
        t('cam.bt.qr.notEnough', 'Found {n}/4 TARGET markers — need all 4 visible.', { n: imgPts.length }),
      )
      return
    }
    commitHomography(calibSlot, imgPts, worldPts, frame.width, frame.height)
  }, [calibSlot, commitHomography, bed.width, bed.depth, t])

  // ---- (d) head-mounted camera: scale + rotation from ONE visible QR ----
  // A head camera sits close to the bed and can't see all 4 corners, so we get
  // px-per-mm from a SINGLE marker's pixel size vs its known physical size, and
  // rotation from its top edge. Absolute placement then comes live from the
  // machine XY (+ tunable offset) — see CameraBedPlane (head mount).
  const runHeadScaleFromQr = useCallback(async () => {
    const v = videoRefs.current[calibSlot]
    if (!captureFrame(v)) {
      setCalibMsg(t('cam.bt.err.noFrame', 'No live frame — start this camera first.'))
      return
    }
    // BURST: a single click can land on a motion-blurred / glare frame, so grab
    // several over ~1s and use the first that decodes. Keep the last frame for
    // the failure diagnostic.
    let codes: Awaited<ReturnType<typeof detectQrCodes>> = []
    let frame = captureFrame(v)!
    for (let attempt = 0; attempt < 6; attempt++) {
      const f = captureFrame(v)
      if (f) frame = f
      codes = await detectQrCodes(frame)
      if (codes.length > 0) break
      await new Promise((r) => window.setTimeout(r, 160))
    }
    const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])
    let best: { sidePx: number; angleDeg: number; sizeMm: number } | null = null
    for (const code of codes) {
      if (code.corners.length < 4) continue
      const parsed = parseMarkerPayload(code.rawValue)
      const sizeMm = parsed && parsed.fields.S ? Number(parsed.fields.S) : 28
      if (!Number.isFinite(sizeMm) || sizeMm <= 0) continue
      const c = code.corners
      // Mean of the 4 edge lengths → robust pixel size (order-independent).
      const sidePx = (d(c[0], c[1]) + d(c[1], c[2]) + d(c[2], c[3]) + d(c[3], c[0])) / 4
      // Rotation from the top edge (corner0→corner1); image Y is down, bed Y is
      // up, so negate to get the bed-frame angle.
      const angleDeg = (-Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]) * 180) / Math.PI
      if (!best || sidePx > best.sidePx) best = { sidePx, angleDeg, sizeMm }
    }
    if (!best || best.sidePx <= 0) {
      // Surface WHY it failed so we can tell a bad frame from a decode failure.
      const diag = frameDiagnostics(frame)
      const zx = zxingStatus()
      // If the robust decoder errored (e.g. wasm didn't load), say so explicitly —
      // that's a software/caching issue (hard-reload), not a focus problem.
      const decoder =
        zx.state === 'error'
          ? `decoder FAILED to load (${zx.error || 'wasm error'}) — hard-reload the page (Ctrl+Shift+R) to clear a stale cached build`
          : zx.state === 'idle'
            ? 'decoder did not run (stale cached build?) — hard-reload (Ctrl+Shift+R)'
            : `decoder ran, found 0 codes — likely soft focus or glare`
      const detail = !diag.readable
        ? 'frame pixels unreadable (camera stream is cross-origin/tainted)'
        : diag.lum < 12
          ? `frame nearly black (brightness ${diag.lum}) — check exposure/lighting`
          : `frame ${frame.width}×${frame.height}, brightness ${diag.lum}; ${decoder}`
      setCalibMsg(
        t('cam.head.noQrDiag', 'No QR decoded — {detail}.', { detail }),
      )
      return
    }
    const pxPerMm = best.sidePx / best.sizeMm
    calib.setCamera(calibSlot, {
      mount: 'head',
      pxPerMm,
      rotationDeg: best.angleDeg,
      frameW: frame.width,
      frameH: frame.height,
    })
    calib.setEnabled(true)
    setCalibMsg(
      t('cam.head.calibrated', 'Head camera: {ppm} px/mm, {rot}° — tune offset so it lines up.', {
        ppm: pxPerMm.toFixed(2),
        rot: best.angleDeg.toFixed(1),
      }),
    )
  }, [calibSlot, calib, t])

  // Download a print-ready PDF of the 4 simple low-density corner markers.
  const downloadCornerMarkers = useCallback(async () => {
    try {
      const blob = await generateCornerMarkersPdf()
      const url = URL.createObjectURL(blob)
      downloadUrl(url, 'karmyogi-corner-markers.pdf')
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch {
      setCalibMsg(t('cam.head.pdfErr', 'Could not generate the marker PDF.'))
    }
  }, [t])

  // Full AUTO head calibration from motion: jogs the head a small grid, tracks a
  // fixed marker, and solves the pixel→bed map (auto direction/rotation/scale/
  // shear — no manual flipping). Needs a marker visible in every jog frame.
  const [headBusy, setHeadBusy] = useState(false)
  const headAbort = useRef<AbortController | null>(null)
  const runHeadMotionCalib = useCallback(async () => {
    const v = videoRefs.current[calibSlot]
    if (!v) {
      setCalibMsg(t('cam.bt.err.noFrame', 'No live frame — start this camera first.'))
      return
    }
    if (machineConn !== 'connected') {
      setCalibMsg(t('cam.head.notConnected', 'Connect the machine (Controller tab) — the head overlay follows the live machine position.'))
      return
    }
    const ac = new AbortController()
    headAbort.current = ac
    setHeadBusy(true)
    setCalibMsg(t('cam.head.calibrating', 'Calibrating — jogging the head and tracking the marker…'))
    try {
      const res = await calibrateHeadFromMotion({
        video: v,
        stepMm: 8,
        feed: 800,
        settleMs: 350,
        signal: ac.signal,
        onProgress: (code, i, n) =>
          setCalibMsg(
            code === 'moving' || code === 'sampling'
              ? t('cam.head.calibStep', 'Calibrating… {i}/{n}', { i: (i ?? 0) + 1, n: n ?? 5 })
              : t('cam.head.calibPhase', 'Calibrating… {code}', { code }),
          ),
      })
      if (!res) {
        setCalibMsg(
          t('cam.head.calibFail', 'Could not solve — keep ONE marker sharp and visible in every jog frame, then retry.'),
        )
        return
      }
      calib.setCamera(calibSlot, { mount: 'head', headMap: res.headMap, frameW: res.frameW, frameH: res.frameH })
      calib.setEnabled(true)
      setCalibMsg(
        t('cam.head.motionOk', 'Head camera aligned from motion ({n} samples) — direction & skew auto-corrected. Tune offset to place it.', {
          n: res.used,
        }),
      )
    } catch (e) {
      const err = e as Error
      setCalibMsg(err?.message || t('cam.head.calibErr', 'Head calibration failed.'))
    } finally {
      setHeadBusy(false)
      headAbort.current = null
    }
  }, [calibSlot, machineConn, calib, t])

  // ---- (b1) sheet → machine registration ----
  // The printed grid uses cols:4, rows:5 (see generateSheet), so the two
  // registration anchors are grid (0,0) → sheet (0,0) and grid (3,0) → sheet
  // (114,0). Derive them from the same layout the sheet is built with so the
  // on-screen guidance always matches the printed marker labels.
  const regMarkers = useMemo(() => registrationMarkers({ cols: 4, rows: 5 }), [])

  // Build the SheetRegistration the grid solver bakes in, or null until BOTH
  // anchors have been captured by jogging the tool to the marker.
  const sheetRegistration: SheetRegistration | null = useMemo(() => {
    const { originMachine, secondMachine } = sheetReg
    if (!originMachine || !secondMachine) return null
    return {
      originSheet: [regMarkers.originMm.x, regMarkers.originMm.y],
      originMachine,
      secondSheet: [regMarkers.secondMm.x, regMarkers.secondMm.y],
      secondMachine,
    }
  }, [sheetReg, regMarkers])

  // A live sanity check of the captured registration (rotation + scale), shown so
  // the operator can spot a fat-fingered capture (scale should be ~1.0).
  const regTransform = useMemo(
    () => (sheetRegistration ? solveSheetTransform(sheetRegistration) : null),
    [sheetRegistration],
  )

  // Capture the CURRENT live machine work XY as one of the two anchors. Mirrors
  // how machine-motion calibration reads useMachine wpos at the press.
  const captureRegAnchor = useCallback(
    (which: 'origin' | 'second') => {
      if (machineConn !== 'connected') {
        setGridMsg(t('cam.reg.notConnected', 'Machine not connected — connect it in the Controller tab first.'))
        return
      }
      const p = useMachine.getState().wpos
      const xy: [number, number] = [p.x, p.y]
      setSheetReg((prev) => ({
        originMachine: which === 'origin' ? xy : prev.originMachine,
        secondMachine: which === 'second' ? xy : prev.secondMachine,
      }))
      setGridMsg(
        which === 'origin'
          ? t('cam.reg.gotOrigin', 'Captured origin marker at work X{x} Y{y}. Now jog to the second marker and capture it.', {
              x: xy[0].toFixed(1),
              y: xy[1].toFixed(1),
            })
          : t('cam.reg.gotSecond', 'Captured second marker at work X{x} Y{y}. Re-run “Auto-calibrate” so the sheet ties to the machine.', {
              x: xy[0].toFixed(1),
              y: xy[1].toFixed(1),
            }),
      )
    },
    [machineConn, setSheetReg, t],
  )

  const clearRegistration = useCallback(() => {
    setSheetReg({ originMachine: null, secondMachine: null })
    setGridMsg(t('cam.reg.cleared', 'Registration cleared — re-capture both markers to tie the sheet to the machine.'))
  }, [setSheetReg, t])

  // ---- (b2) two-camera GRID calibration (printed marker sheet) ----
  // Generate + download the printable A4 marker grid (each QR encodes its own
  // bed-mm coordinate). REQUIRES the user to print at 100% and lay it flat.
  const generateSheet = useCallback(async () => {
    setSheetBusy(true)
    setGridMsg(t('cam.grid.generating', 'Generating the A4 marker sheet…'))
    try {
      const sheet = await generateCalibrationSheet({ cols: 4, rows: 5 })
      const url = URL.createObjectURL(sheet.blob)
      downloadUrl(url, 'karmyogi-grid-calibration-A4.pdf')
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      setGridMsg(
        t(
          'cam.grid.generated',
          'Sheet ready ({n} markers). PRINT AT 100% (no fit-to-page), lay it flat on the bed, then auto-calibrate.',
          { n: sheet.markers.length },
        ),
      )
    } catch (err) {
      setGridMsg(
        err instanceof Error
          ? err.message
          : t('cam.grid.genFailed', 'Could not generate the calibration sheet.'),
      )
    } finally {
      setSheetBusy(false)
    }
  }, [t])

  // Auto-calibrate ONE slot from the printed grid (reads the QR mm coordinates
  // and solves its image→bed homography). Persists via useCameraCalib.
  const autoCalibSlotFromGrid = useCallback(
    async (s: SlotIdx) => {
      if (!qrSupported) {
        setGridMsg(
          t('cam.grid.noDetector', 'BarcodeDetector is unavailable in this browser — use Auto or Manual calibration instead.'),
        )
        return
      }
      const v = videoRefs.current[s]
      if (!v || !v.videoWidth) {
        setGridMsg(t('cam.bt.err.noFrame', 'No live frame — start this camera first.'))
        return
      }
      const detected = await detectGridMarkers(v)
      setGridFound((prev) => {
        const next: [number | null, number | null] = [prev[0], prev[1]]
        next[s] = detected.markers.length
        return next
      })
      const res = calibrateCameraFromGrid(detected, sheetRegistration)
      if (!res.ok) {
        setGridMsg(
          res.reason === 'tooFew'
            ? t('cam.grid.tooFew', 'Cam {n}: found {f} grid markers — need at least 4 visible and spread out.', {
                n: s + 1,
                f: detected.markers.length,
              })
            : res.reason === 'badRegistration'
              ? t('cam.grid.badReg', 'Cam {n}: the two registration captures coincide — jog to two DIFFERENT markers and re-capture.', {
                  n: s + 1,
                })
              : t('cam.grid.degenerate', 'Cam {n}: markers are collinear — angle the sheet so a 2D spread is visible.', {
                  n: s + 1,
                }),
        )
        return
      }
      calib.setCamera(s, {
        H: res.result.H,
        rmsMm: res.result.rmsMm,
        frameW: res.result.frameW,
        frameH: res.result.frameH,
      })
      setGridMsg(
        res.result.registered
          ? t('cam.grid.calibrated', 'Cam {n} calibrated from {u} grid markers (registered to machine work XY) — RMS {rms} mm.', {
              n: s + 1,
              u: res.result.used,
              rms: res.result.rmsMm.toFixed(2),
            })
          : t('cam.grid.calibratedNoReg', 'Cam {n} solved from {u} grid markers — RMS {rms} mm. NOT yet tied to the machine: do step 2 (register the sheet) and re-calibrate, or the overlay will be offset.', {
              n: s + 1,
              u: res.result.used,
              rms: res.result.rmsMm.toFixed(2),
            }),
      )
    },
    [qrSupported, calib, sheetRegistration, t],
  )

  // Auto-calibrate BOTH live cameras from the grid in one click.
  const autoCalibBothFromGrid = useCallback(async () => {
    await autoCalibSlotFromGrid(0)
    if (secondaryEnabled && live(1)) await autoCalibSlotFromGrid(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCalibSlotFromGrid, secondaryEnabled, status])

  // GUIDED head-vs-stationary probe: jog a known distance, see which feed the
  // markers/world shift in. The HEAD camera's whole view translates; the
  // STATIONARY one barely moves. Persists the inferred role per slot.
  const runRoleProbe = useCallback(async () => {
    if (machineConn !== 'connected') {
      setGridMsg(
        t('cam.role.notConnected', 'Machine not connected — connect it in the Controller tab first.'),
      )
      return
    }
    if (!live(0) && !live(1)) {
      setGridMsg(t('cam.role.needCam', 'Start at least one camera first.'))
      return
    }
    const jog = 8
    const ok =
      typeof window === 'undefined'
        ? true
        : window.confirm(
            t(
              'cam.role.confirm',
              'The machine will jog +{j} mm on X and back to detect which camera is head-mounted. Make sure the tool is clear. Continue?',
              { j: jog },
            ),
          )
    if (!ok) return

    const ctrl = new AbortController()
    roleAbortRef.current = ctrl
    setRoleRunning(true)
    setRoleProgress(null)
    setGridMsg(null)
    try {
      const res = await detectCameraRoles({
        videos: [videoRefs.current[0], videoRefs.current[1]],
        jogMm: jog,
        feed: 1000,
        settleMs: 350,
        signal: ctrl.signal,
        onProgress: (p) => setRoleProgress(p),
      })
      setCamRoles([res.slots[0].role, res.slots[1].role])
      const label = (r: CameraRole) =>
        r === 'head'
          ? t('cam.role.head', 'head-mounted')
          : r === 'stationary'
            ? t('cam.role.stationary', 'stationary')
            : t('cam.role.unknown', 'unknown')
      if (res.headSlot == null && res.stationarySlot == null) {
        setGridMsg(
          t(
            'cam.role.inconclusive',
            'Inconclusive — neither feed showed a clear world-shift. Ensure the head camera sees the bed and retry with more light.',
          ),
        )
      } else {
        setGridMsg(
          t('cam.role.done', 'Detected — Cam 1: {a}, Cam 2: {b}.', {
            a: label(res.slots[0].role),
            b: label(res.slots[1].role),
          }),
        )
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError'
      setGridMsg(
        isAbort
          ? t('cam.role.aborted', 'Probe aborted — machine returned to start.')
          : err instanceof Error
            ? err.message
            : t('cam.role.failed', 'Role detection failed.'),
      )
    } finally {
      setRoleRunning(false)
      setRoleProgress(null)
      roleAbortRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineConn, status, setCamRoles, t])

  const abortRoleProbe = useCallback(() => {
    roleAbortRef.current?.abort()
    grbl.jogCancel().catch(() => {})
  }, [])

  // Localize a role-probe progress code (panel owns the copy; qrCalib stays i18n-free).
  const roleProgressLabel = useCallback(
    (p: RoleProbeProgress): string => {
      switch (p.code) {
        case 'capturing':
          return t('cam.role.p.capturing', 'Capturing reference frames…')
        case 'jogging':
          return t('cam.role.p.jogging', 'Jogging +{delta} mm on X…', p.params ?? {})
        case 'capturingAfter':
          return t('cam.role.p.after', 'Capturing shifted frames…')
        case 'returning':
          return t('cam.role.p.returning', 'Returning to start…')
        case 'analyzing':
          return t('cam.role.p.analyzing', 'Comparing the feeds…')
        default:
          return ''
      }
    },
    [t],
  )

  // ---- (c) manual bed-corner calibration ----
  const solveManual = useCallback(() => {
    if (cornerClicks.length < 4) {
      setCalibMsg(t('cam.bt.err.need4corners', 'Click all 4 bed corners first.'))
      return
    }
    const v = videoRefs.current[calibSlot]
    const fw = v?.videoWidth || 0
    const fh = v?.videoHeight || 0
    const worldPts = bedCornersMm(bed.width, bed.depth)
    commitHomography(calibSlot, cornerClicks.slice(0, 4), worldPts, fw, fh)
  }, [cornerClicks, calibSlot, bed.width, bed.depth, commitHomography])

  const clearCorners = useCallback(() => {
    setCornerClicks([])
    setCalibMsg(null)
  }, [])

  // ---- click on the calibration frame (routes by method) ----
  const onCalibFrameClick = useCallback(
    (e: MouseEvent<HTMLVideoElement>) => {
      const v = videoRefs.current[calibSlot]
      if (!v || !v.videoWidth) return
      const rect = v.getBoundingClientRect()
      const px = clickToImagePx(e.clientX, e.clientY, rect, v.videoWidth, v.videoHeight)
      if (!px) return
      if (method === 'machine') {
        if (!pendingWorld) {
          setCalibMsg(t('cam.bt.mm.addFirst', "Press 'Add point' first to capture machine X/Y."))
          return
        }
        setMmPairs((prev) => [...prev, { px, world: pendingWorld }])
        setPendingWorld(null)
        setCalibMsg(null)
      } else if (method === 'manual') {
        setCornerClicks((prev) => (prev.length >= 4 ? prev : [...prev, px]))
      }
    },
    [calibSlot, method, pendingWorld, t],
  )

  // ---- empty-bed reference capture (per slot) ----
  const captureRef = useCallback((s: SlotIdx) => {
    const gray = videoToGray(videoRefs.current[s])
    refGrayRef.current[s] = gray
    setRefCaptured((prev) => {
      const next: [boolean, boolean] = [prev[0], prev[1]]
      next[s] = gray != null
      return next
    })
  }, [])

  // ---- visual-hull height estimate (both slots) ----
  const estimateHeight = useCallback(() => {
    const slots: SlotIdx[] = [0, 1]
    const views: {
      mask: Uint8Array
      width: number
      height: number
      pose: ReturnType<typeof poseFromPlaneHomography>
    }[] = []
    for (const s of slots) {
      const cam = calib.cameras[s]
      const ref = refGrayRef.current[s]
      const cur = videoToGray(videoRefs.current[s])
      if (!cam.H || cam.H.length !== 9 || !ref || !cur) {
        setCalibMsg(t('cam.bt.hull.missing', 'Both slots need calibration + an empty-bed reference + a live frame.'))
        return
      }
      if (ref.width !== cur.width || ref.height !== cur.height) {
        setCalibMsg(t('cam.bt.hull.sizeMismatch', 'Reference and live frame sizes differ — re-capture the reference.'))
        return
      }
      const mask = silhouetteMask(ref, cur, 28)
      const Himg2world = cam.H as Mat3
      const Hworld2img = invertMat3(Himg2world)
      if (!Hworld2img) {
        setCalibMsg(t('cam.bt.hull.badH', 'Calibration matrix is not invertible — recalibrate.'))
        return
      }
      const K = assumedIntrinsics(cur.width, cur.height)
      const pose = poseFromPlaneHomography(Hworld2img, K)
      if (!pose) {
        setCalibMsg(t('cam.bt.hull.noPose', 'Could not derive camera pose — recalibrate.'))
        return
      }
      views.push({ mask, width: cur.width, height: cur.height, pose })
    }
    const validViews = views.filter((v) => v.pose != null) as {
      mask: Uint8Array
      width: number
      height: number
      pose: NonNullable<ReturnType<typeof poseFromPlaneHomography>>
    }[]
    if (validViews.length < 2) {
      setCalibMsg(t('cam.bt.hull.needTwo', 'Two calibrated views are required for height.'))
      return
    }
    const bedRect = centeredRect(bed.width, bed.depth)
    const field = visualHull({ bed: bedRect, cell: 4, maxHeight: 60, zStep: 2, views: validViews })
    // Prefer the median of nonzero heights (robust); fall back to maxZ.
    const nz: number[] = []
    for (let i = 0; i < field.z.length; i++) if (field.z[i] > 0) nz.push(field.z[i])
    let h = field.maxZ
    if (nz.length > 0) {
      nz.sort((a, b) => a - b)
      const median = nz[Math.floor(nz.length / 2)]
      h = median > 0 ? median : field.maxZ
    }
    calib.setJobHeight(h)
    setCalibMsg(
      t('cam.bt.hull.done', 'Estimated job height ≈ {h} mm (peak {peak} mm).', {
        h: h.toFixed(1),
        peak: field.maxZ.toFixed(1),
      }),
    )
  }, [calib, bed.width, bed.depth, t])

  // ---- job: detect from stock QR ----
  // The 3D bed plane is textured from Cam 1 (slot 0), so stock-pixel→mm must go
  // through the SAME slot's homography to land in the right place. Always use the
  // actually-bed-calibrated slot 0 (and say so in the copy).
  const JOB_SLOT: SlotIdx = 0
  const detectJobFromQr = useCallback(async () => {
    const v = videoRefs.current[JOB_SLOT]
    const frame = captureFrame(v)
    if (!frame) {
      setCalibMsg(t('cam.bt.err.noFrame', 'No live frame — start this camera first.'))
      return
    }
    const cam = calib.cameras[JOB_SLOT]
    if (!cam.H || cam.H.length !== 9) {
      setCalibMsg(t('cam.bt.job.needCalib', 'Calibrate Cam 1 first so stock pixels map to mm.'))
      return
    }
    const codes = await detectQrCodes(frame)
    // Collect every stock marker's centre + corners as pixel points.
    const stockPx: Vec2[] = []
    for (const code of codes) {
      const parsed = parseMarkerPayload(code.rawValue)
      if (!parsed || parsed.kind !== 'STOCK') continue
      stockPx.push(code.center)
      for (const c of code.corners) stockPx.push(c)
    }
    if (stockPx.length === 0) {
      setCalibMsg(t('cam.bt.job.noStock', 'No STOCK markers detected on the workpiece.'))
      return
    }
    // Map stock pixel points through H → mm, take their extents.
    const Himg2world = cam.H as Mat3
    const worldPts: Vec2[] = stockPx.map((p) => applyHomography(Himg2world, p))
    const rect = rectFromPoints(worldPts)
    if (!rect) {
      setCalibMsg(t('cam.bt.job.noStock', 'No STOCK markers detected on the workpiece.'))
      return
    }
    calib.setJobRect(rect)
    setCalibMsg(
      t('cam.bt.job.detected', 'Job ≈ {w}×{d} mm from {n} stock marker(s).', {
        w: (rect.maxX - rect.minX).toFixed(0),
        d: (rect.maxY - rect.minY).toFixed(0),
        n: stockPx.length,
      }),
    )
  }, [calib, t])

  const applyManualJob = useCallback(() => {
    const w = parseFloat(jobW)
    const d = parseFloat(jobD)
    const thk = parseFloat(jobThk)
    if (!Number.isFinite(w) || !Number.isFinite(d) || w <= 0 || d <= 0) {
      setCalibMsg(t('cam.bt.job.badSize', 'Enter a positive width and depth.'))
      return
    }
    calib.setJobRect(centeredRect(w, d))
    if (Number.isFinite(thk) && thk >= 0) calib.setJobHeight(thk)
    setCalibMsg(t('cam.bt.job.set', 'Job set to {w}×{d}×{t} mm at bed center.', { w, d, t: Number.isFinite(thk) ? thk : 0 }))
  }, [jobW, jobD, jobThk, calib, t])

  // ---------------------------------------------------------------------------
  // Empty-state messaging (per slot)
  // ---------------------------------------------------------------------------
  const emptyStateFor = useCallback(
    (st: Status): { title: string; body: string } => {
      switch (st.kind) {
        case 'unsupported':
          return {
            title: t('cam.empty.unsupported.title', 'Camera not supported'),
            body: t(
              'cam.empty.unsupported.body',
              'This browser has no getUserMedia. Use a Chromium browser over HTTPS or localhost.',
            ),
          }
        case 'denied':
          return {
            title: t('cam.empty.denied.title', 'Permission denied'),
            body: t(
              'cam.empty.denied.body',
              'Camera access was blocked. Allow it in the address-bar site permissions, then press the power button again. (getUserMedia needs HTTPS or localhost.)',
            ),
          }
        case 'nocamera':
          return {
            title: t('cam.empty.nocamera.title', 'No camera found'),
            body: t(
              'cam.empty.nocamera.body',
              'No video input device is available. Plug in a webcam and it will appear here.',
            ),
          }
        case 'error':
          return { title: t('cam.empty.error.title', 'Camera error'), body: st.message }
        case 'starting':
          return {
            title: t('cam.empty.starting.title', 'Starting camera…'),
            body: t('cam.empty.starting.body', 'Grant permission if your browser asks.'),
          }
        default:
          return {
            title: t('cam.empty.off.title', 'Camera off'),
            body: t(
              'cam.empty.off.body',
              'Press the power button to start the live feed. getUserMedia needs HTTPS or localhost.',
            ),
          }
      }
    },
    [t],
  )

  const canCapture = live(0) && !!streamRefs.current[0]
  const bothCalibrated =
    !!calib.cameras[0].H &&
    calib.cameras[0].H.length === 9 &&
    !!calib.cameras[1].H &&
    calib.cameras[1].H.length === 9
  const spreadTooSmall = mmPairs.length >= 2 && minPairwiseDist(mmPairs.map((p) => p.px)) < 20

  // ---- top status strip: condense the camera / calibration / recording state
  // the panel already computes into three compact pills. Pure derivation. ----
  const liveCount = (live(0) ? 1 : 0) + (live(1) ? 1 : 0)
  const anyDenied = status[0].kind === 'denied' || status[1].kind === 'denied'
  const camState: { tone: 'on' | 'warn' | 'off'; label: string } = !supported
    ? { tone: 'warn', label: t('cam.strip.unsupported', 'no getUserMedia') }
    : anyDenied
      ? { tone: 'warn', label: t('cam.strip.denied', 'permission denied') }
      : liveCount > 0
        ? {
            tone: 'on',
            label:
              liveCount === 2
                ? t('cam.strip.live2', '2 cameras live')
                : t('cam.strip.live1', '1 camera live'),
          }
        : { tone: 'off', label: t('cam.strip.noCam', 'no camera') }
  const isCalibrated = calib.isCalibrated()
  const recState: { tone: 'on' | 'off'; label: string } | null = recording
    ? { tone: 'on', label: t('cam.strip.recording', 'recording') }
    : autoRecActive
      ? { tone: 'on', label: t('cam.strip.autoRec', 'auto-recording') }
      : tlActive
        ? { tone: 'on', label: t('cam.strip.timelapse', 'timelapse') }
        : null

  // ---- VISIBLE "why is this disabled?" reasons (not just tooltips) ----
  // Each returns a localized one-liner when the action can't run, else null.
  const autoReason: string | null =
    machineConn !== 'connected'
      ? t('cam.bt.auto.btnNeedConn', 'Connect the machine first (Controller tab).')
      : !live(calibSlot)
        ? t('cam.bt.auto.btnNeedCam', 'Start this camera first.')
        : !(autoSpreadMm > 0)
          ? t('cam.bt.auto.btnNeedSpread', 'Enter a spread greater than zero.')
          : null

  const detectQrReason: string | null = !qrSupported
    ? t('cam.bt.m.qrUnavailable', 'BarcodeDetector unavailable in this browser.')
    : !calib.cameras[0].H
      ? t('cam.bt.job.needCam1Calib', 'Calibrate Cam 1 first (its homography maps stock pixels to mm).')
      : !live(0)
        ? t('cam.bt.job.needCam1Live', 'Start Camera 1 first.')
        : null

  const hullReason: string | null = !secondaryEnabled
    ? t('cam.bt.hull.needSecond', 'Enable the second camera (a different angle is needed for height).')
    : !bothCalibrated
      ? t('cam.bt.hull.needBothCalib', 'Calibrate both cameras first.')
      : !(live(0) && live(1))
        ? t('cam.bt.hull.needBothLive', 'Start both cameras first.')
        : !(refCaptured[0] && refCaptured[1])
          ? t('cam.bt.hull.needRefs', 'Capture an empty-bed reference for both cameras.')
          : null

  // Quality label for the currently-edited slot.
  const slotCam = calib.cameras[calibSlot]
  const quality = rmsQuality(slotCam.rmsMm)

  // Stable per-slot <video> ref callbacks. They MUST be stable identities so
  // React only invokes them on real mount/unmount — an inline arrow would be a
  // new function each render, making React detach+reattach (and thrash the live
  // bus) on every render. We only store the element here; the live bus is
  // (un)published in startStream / stopStream.
  const setVideo0 = useCallback((el: HTMLVideoElement | null) => {
    videoRefs.current[0] = el
  }, [])
  const setVideo1 = useCallback((el: HTMLVideoElement | null) => {
    videoRefs.current[1] = el
  }, [])
  const videoRefSetters: [
    (el: HTMLVideoElement | null) => void,
    (el: HTMLVideoElement | null) => void,
  ] = [setVideo0, setVideo1]

  // ---- a small reusable camera-feed card ----
  const renderSlot = (s: SlotIdx) => {
    const st = status[s]
    const isLive = st.kind === 'live'
    const empty = emptyStateFor(st)
    const isCalibFrame = calibSlot === s && (method === 'machine' || method === 'manual')
    return (
      <section className="cam-card" key={`slot-${s}`}>
        <header className="cam-card-head">
          <h4>
            <Icon name="camera" size={14} className="cam-card-ico" />{' '}
            {s === 0
              ? t('cam.slot.primary', 'Camera 1 · primary')
              : t('cam.slot.secondary', 'Camera 2 · secondary')}
          </h4>
          <span className="cam-raw" data-on={isLive}>
            {isLive
              ? t('cam.status.live', 'live')
              : st.kind === 'starting'
                ? t('cam.status.starting', 'starting…')
                : t('cam.status.off', 'off')}
          </span>
        </header>
        <div className="cam-row">
          <select
            className="cam-select"
            value={deviceIds[s]}
            disabled={!supported || devices.length === 0}
            onChange={(e) => onSelectDevice(s, e.target.value)}
            title={t('cam.device.tip', 'Choose which camera to use')}
            aria-label={t('cam.device.aria', 'Camera device')}
          >
            {devices.length === 0 && (
              <option value="">{t('cam.device.none', 'No cameras found')}</option>
            )}
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || t('cam.device.fallback', 'Camera {n}', { n: i + 1 })}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`cam-btn cam-power${isLive ? ' on' : ''}`}
            disabled={!supported}
            onClick={() => toggleLive(s)}
            title={isLive ? t('cam.power.stopTip', 'Stop the camera') : t('cam.power.startTip', 'Start the camera')}
            aria-pressed={isLive}
          >
            <span className="cam-power-dot" aria-hidden="true" />
            {isLive ? t('cam.power.stop', 'Stop') : t('cam.power.start', 'Start')}
          </button>
        </div>
        <div className="cam-stage" data-live={isLive} data-calib={isCalibFrame}>
          <video
            ref={videoRefSetters[s]}
            className="cam-video"
            data-clickable={isCalibFrame}
            autoPlay
            muted
            playsInline
            hidden={!isLive}
            onClick={isCalibFrame ? onCalibFrameClick : undefined}
          />
          {!isLive && (
            <CamEmpty
              icon={<Icon name="camera" size={22} />}
              title={empty.title}
              hint={empty.body}
              action={
                supported && st.kind !== 'starting' ? (
                  <button
                    type="button"
                    className="cam-btn cam-power"
                    onClick={() => toggleLive(s)}
                    title={t('cam.power.startTip', 'Start the camera')}
                  >
                    <span className="cam-power-dot" aria-hidden="true" />
                    {t('cam.power.start', 'Start')}
                  </button>
                ) : undefined
              }
            />
          )}
          {isLive && s === 0 && recording && (
            <span className="cam-rec cam-rec-overlay" title={t('cam.feed.recTip', 'Recording in progress')}>
              <span className="cam-rec-dot" aria-hidden="true" />
              {t('cam.feed.rec', 'REC')} {fmtElapsed(recElapsed)}
            </span>
          )}
        </div>
        {/* Empty-bed reference capture (used by the visual hull). */}
        <div className="cam-row">
          <button
            type="button"
            className="cam-btn cam-grow"
            disabled={!isLive}
            onClick={() => captureRef(s)}
            title={t('cam.bt.ref.tip', 'Store an empty-bed reference frame for this camera (used by height estimation)')}
          >
            <Icon name={refCaptured[s] ? 'eye' : 'camera'} size={14} />
            {refCaptured[s]
              ? t('cam.bt.ref.have', 'Empty-bed reference set')
              : t('cam.bt.ref.set', 'Capture empty-bed reference')}
          </button>
        </div>
        {/* Advanced live-camera image controls (collapsed by default). */}
        {renderAdvanced(s)}
      </section>
    )
  }

  // ---- advanced image-controls disclosure (per slot) ----
  const renderAdvanced = (s: SlotIdx) => {
    const isLive = status[s].kind === 'live'
    const caps = advCaps[s]
    const overrides = advOverrides[s]
    const hasOverrides = Object.keys(overrides).length > 0
    return (
      <details className="cam-guide cam-adv" data-has={hasOverrides}>
        <summary>
          {t('cam.adv.title', 'Advanced image settings')}
          {hasOverrides && <span className="cam-adv-badge">{t('cam.adv.custom', 'custom')}</span>}
        </summary>
        <div className="cam-adv-body">
          {!isLive ? (
            <p className="cam-hint">
              {t('cam.adv.needLive', 'Start this camera to adjust the live image.')}
            </p>
          ) : caps.length === 0 ? (
            <p className="cam-hint">
              {t(
                'cam.adv.unsupported',
                'This camera / browser does not expose adjustable image settings (no getCapabilities support, or the device reports none).',
              )}
            </p>
          ) : (
            <>
              <p className="cam-hint">
                {t(
                  'cam.adv.hint',
                  'Adjust the live feed. Only settings your camera reports are shown; values are saved and re-applied when the camera restarts.',
                )}
              </p>
              {AUTO_MODE_DEFS.some((d) => (autoModeCaps[s][d.mode] ?? []).length > 0) && (
                <div className="cam-row cam-focus-row">
                  {AUTO_MODE_DEFS.filter((d) => (autoModeCaps[s][d.mode] ?? []).length > 0).map((d) => (
                    <label key={d.mode} className="cam-check" title={t(d.key, d.label)}>
                      <input
                        type="checkbox"
                        checked={isAutoOn(s, d.mode)}
                        onChange={(e) => {
                          const on = e.target.checked
                          setAutoModeOn((prev) => {
                            const next: [Record<string, boolean>, Record<string, boolean>] = [
                              { ...prev[0] },
                              { ...prev[1] },
                            ]
                            next[s] = { ...next[s], [d.mode]: on }
                            return next
                          })
                          autoModeOnRef.current[s] = { ...autoModeOnRef.current[s], [d.mode]: on }
                          applyAutoModes(s).catch(() => {})
                        }}
                      />
                      {t(d.key, d.label)}
                    </label>
                  ))}
                </div>
              )}
              {AUTO_MODE_DEFS.every((d) => (autoModeCaps[s][d.mode] ?? []).length === 0) && (
                <p className="cam-hint cam-warn">
                  {t(
                    'cam.adv.noAutoCtrl',
                    'This browser/OS exposes no focus/exposure/white-balance mode control for this camera (common for UVC cameras on Linux Chrome). Set these on the OS instead — e.g. v4l2-ctl -d /dev/video2 --set-ctrl=auto_exposure=3 (auto) / =1 (manual), and --set-ctrl=white_balance_automatic=1. (This IMX179 has no focus control — focus it by rotating the lens.)',
                  )}
                </p>
              )}
              <div className="cam-sgrid">
                {caps.map((cap) => {
                  const value =
                    cap.name in overrides
                      ? overrides[cap.name]
                      : cap.current ?? (cap.min + cap.max) / 2
                  const id = `cam-adv-${s}-${cap.name}`
                  return (
                    <CamSlider
                      key={cap.name}
                      icon={<Icon name="settings" size={13} />}
                      label={t(cap.key, cap.label)}
                      htmlFor={id}
                      value={value}
                      onChange={(v) => setAdvValue(s, cap.name, v)}
                      min={cap.min}
                      max={cap.max}
                      step={cap.step}
                    />
                  )
                })}
              </div>
              <div className="cam-row">
                <button
                  type="button"
                  className="cam-btn cam-grow"
                  disabled={!hasOverrides}
                  onClick={() => {
                    resetAdvForSlot(s).catch(() => {})
                  }}
                  title={t('cam.adv.resetTip', 'Clear your saved adjustments and restore the camera defaults')}
                >
                  <Icon name="close" size={14} />
                  {t('cam.adv.reset', 'Reset to defaults')}
                </button>
              </div>
            </>
          )}
        </div>
      </details>
    )
  }

  return (
    <div className="cam-panel" aria-label={t('cam.aria.panel', 'Camera')}>
      <p className="cam-intro">
        {t(
          'cam.intro',
          'Live webcam feed — record clips, grab snapshots, capture a timelapse, and calibrate the camera to the 3D bed so you can preview the real machine. Everything stays in your browser.',
        )}
      </p>

      {/* ---- top status strip: camera · calibration · recording ---- */}
      <div className="cam-strip" role="status" aria-label={t('cam.strip.aria', 'Camera status')}>
        <span className="cam-strip-pill" data-tone={camState.tone}>
          <span className="cam-strip-dot" aria-hidden="true" />
          {camState.label}
        </span>
        <span className="cam-strip-sep" aria-hidden="true">·</span>
        <span className="cam-strip-pill" data-tone={isCalibrated ? 'on' : 'off'}>
          {isCalibrated
            ? t('cam.strip.calibrated', 'calibrated')
            : t('cam.strip.notCalibrated', 'not calibrated')}
        </span>
        {recState && (
          <>
            <span className="cam-strip-sep" aria-hidden="true">·</span>
            <span className="cam-strip-pill cam-strip-rec" data-tone={recState.tone}>
              <span className="cam-rec-dot" aria-hidden="true" />
              {recState.label}
            </span>
          </>
        )}
      </div>

      {/* ============================ LIVE VIEW ============================ */}
      <CamSection
        title={t('cam.sec.live', 'Live view')}
        open={secLiveOpen}
        onToggle={() => setSecLiveOpen((v) => !v)}
        badge={
          <span className="cam-raw" data-on={liveCount > 0}>
            {camState.label}
          </span>
        }
      >
      <div className="cam-cards">
        {/* ---- calibration sheet (printable QR fiducials) ---- */}
        <section className="cam-card">
          <header className="cam-card-head">
            <h4>
              <Icon name="frame" size={14} className="cam-card-ico" /> {t('cam.calib.title', 'Calibration sheet')}
              <CamInfo
                label={t('cam.calib.title', 'Calibration sheet')}
                text={t(
                  'cam.calib.hint',
                  'Print this QR fiducial sheet at 100% scale and lay it flat on the bed. The camera reads the codes to learn mm-per-pixel + perspective, then measures bed and stock size automatically. Cut out the S# stickers for the workpiece.',
                )}
              />
            </h4>
            <span className="cam-raw" title={t('cam.calib.oneCamHint', 'Single camera — for one top-down view')}>
              {t('cam.calib.badge', 'A4 · QR')}
            </span>
          </header>
          <div className="cam-row">
            <a
              className="cam-btn cam-primary cam-grow"
              href="/calibration/karmyogi-calibration-sheet.pdf"
              download="karmyogi-calibration-sheet.pdf"
              title={t('cam.calib.downloadTip', 'Download the printable A4 calibration sheet (PDF)')}
            >
              <Icon name="download" size={14} />
              {t('cam.calib.download', 'Download sheet (PDF)')}
            </a>
            <a
              className="cam-btn cam-icon"
              href="/calibration/karmyogi-calibration-sheet.pdf"
              target="_blank"
              rel="noreferrer"
              title={t('cam.calib.openTip', 'Open the calibration sheet in a new tab to print')}
              aria-label={t('cam.calib.open', 'Print calibration sheet')}
            >
              <Icon name="frame" size={16} />
            </a>
          </div>
        </section>

        {/* ---- primary camera slot ---- */}
        {renderSlot(0)}

        {/* ---- secondary camera slot toggle + slot ---- */}
        <section className="cam-card">
          <header className="cam-card-head">
            <h4>
              <Icon name="camera" size={14} className="cam-card-ico" /> {t('cam.slot2.title', 'Second camera')}
              <CamInfo
                label={t('cam.slot2.title', 'Second camera')}
                text={t(
                  'cam.slot2.hint',
                  'A second camera (different angle) lets karmyogi estimate the stock HEIGHT by shape-from-silhouette. Optional — leave off for a single top-down view.',
                )}
              />
            </h4>
            <label className="cam-switch">
              <input
                type="checkbox"
                checked={secondaryEnabled}
                onChange={(e) => setSecondaryEnabled(e.target.checked)}
                aria-label={t('cam.slot2.enableAria', 'Enable a second camera')}
              />
              <span>{t('cam.slot2.enable', 'Enable')}</span>
            </label>
          </header>
        </section>
        {secondaryEnabled && renderSlot(1)}

        {/* ---- auto-record while streaming (slot 0 / Camera 1 only) ---- */}
        <section className="cam-card">
          <header className="cam-card-head">
            <h4>
              <Icon name="play" size={14} className="cam-card-ico" /> {t('cam.auto.title', 'Auto-record runs')}
              <CamInfo
                label={t('cam.auto.title', 'Auto-record runs')}
                text={t(
                  'cam.auto.hint',
                  'Automatically record Camera 1 whenever the machine streams a program — the clip is saved to this browser when the run finishes.',
                )}
              />
            </h4>
            {autoRecActive ? (
              <span className="cam-rec" title={t('cam.auto.recTip', 'Recording the current run')}>
                <span className="cam-rec-dot" aria-hidden="true" />
                {t('cam.auto.recording', 'recording')}
              </span>
            ) : (
              <span className="cam-raw" data-on={autoRecord}>
                {autoRecord ? t('cam.auto.on', 'armed') : t('cam.auto.off', 'off')}
              </span>
            )}
          </header>
          {!recorderSupported && (
            <p className="cam-warn">
              {t('cam.capture.noRecorder', 'Recording is not supported in this browser (no MediaRecorder).')}
            </p>
          )}
          <div className="cam-row">
            <button
              type="button"
              role="switch"
              aria-checked={autoRecord}
              className={`cam-rec-pill${autoRecord ? ' on' : ''}`}
              disabled={!recorderSupported}
              onClick={() => setAutoRecord((v) => !v)}
              title={
                autoRecord
                  ? t('cam.auto.toggleOnTip', 'Auto-record is ON — click to disable')
                  : t('cam.auto.toggleOffTip', 'Auto-record is OFF — click to record every run automatically')
              }
            >
              <span className="cam-rec-pill-dot" data-live={autoRecActive} aria-hidden="true" />
              <span className="cam-rec-pill-label">
                {autoRecord ? t('cam.auto.labelOn', 'Auto-record ON') : t('cam.auto.labelOff', 'Auto-record OFF')}
              </span>
            </button>
          </div>
          {autoRecord && !canCapture && recorderSupported && (
            <p className="cam-hint">
              {t('cam.auto.needCam1', 'Start Camera 1 above so a run can be captured.')}
            </p>
          )}
          {autoRecMsg && <p className="cam-warn">{autoRecMsg}</p>}
        </section>
      </div>
      </CamSection>

      {/* ============================= CAPTURE ============================= */}
      <CamSection
        title={t('cam.sec.capture', 'Capture')}
        open={secCaptureOpen}
        onToggle={() => setSecCaptureOpen((v) => !v)}
        badge={<span className="cam-raw">{t('cam.capture.cam1only', 'Camera 1 only')}</span>}
      >
      <div className="cam-cards">
        {/* ---- capture controls (slot 0 / Camera 1 only) ---- */}
        <section className="cam-card">
          <header className="cam-card-head">
            <h4>{t('cam.capture.title', 'Snapshot & record')}</h4>
            <span className="cam-raw">{t('cam.capture.cam1only', 'Camera 1 only')}</span>
          </header>
          {!recorderSupported && (
            <p className="cam-warn">
              {t('cam.capture.noRecorder', 'Recording is not supported in this browser (no MediaRecorder).')}
            </p>
          )}
          {!canCapture && recorderSupported && (
            <p className="cam-hint">
              {t('cam.capture.needCam1', 'Start Camera 1 above to record, snapshot, or capture a timelapse.')}
            </p>
          )}
          <div className="cam-row">
            {!recording ? (
              <button
                type="button"
                className="cam-btn cam-grow"
                disabled={!canCapture || !recorderSupported}
                onClick={startRecording}
                title={t('cam.capture.recordTip', 'Start recording the live feed to a WebM clip')}
              >
                <span className="cam-rec-dot cam-btn-dot" aria-hidden="true" />
                {t('cam.capture.record', 'Record')}
              </button>
            ) : (
              <button
                type="button"
                className="cam-btn danger cam-grow"
                onClick={stopRecording}
                title={t('cam.capture.stopRecTip', 'Stop recording and download the clip')}
              >
                <Icon name="stop" size={13} />
                {t('cam.capture.stopRec', 'Stop ({elapsed})', { elapsed: fmtElapsed(recElapsed) })}
              </button>
            )}
            <button
              type="button"
              className="cam-btn cam-grow"
              disabled={!canCapture}
              onClick={snapshot}
              title={t('cam.capture.snapshotTip', 'Capture the current frame as a PNG and download it')}
            >
              <Icon name="camera" size={14} />
              {t('cam.capture.snapshot', 'Snapshot')}
            </button>
          </div>
          {recError && <p className="cam-warn">{recError}</p>}
        </section>

        {/* ---- timelapse (slot 0 / Camera 1 only) ---- */}
        <section className="cam-card">
          <header className="cam-card-head">
            <h4>
              {t('cam.timelapse.title', 'Timelapse')}
              <CamInfo
                label={t('cam.timelapse.title', 'Timelapse')}
                text={t('cam.timelapse.hint', 'Grab a frame every interval, play them back fast into one webm.')}
              />
            </h4>
            {tlActive ? (
              <span className="cam-raw" data-on={true}>
                {t('cam.timelapse.frames', '{count} frame(s)', { count: tlCount })}
              </span>
            ) : (
              <span className="cam-raw">{t('cam.capture.cam1only', 'Camera 1 only')}</span>
            )}
          </header>
          {!recorderSupported && (
            <p className="cam-warn">
              {t('cam.capture.noRecorder', 'Recording is not supported in this browser (no MediaRecorder).')}
            </p>
          )}
          <div className="cam-sgrid">
            <CamSlider
              icon={<Icon name="settings" size={13} />}
              label={t('cam.timelapse.interval', 'Interval')}
              htmlFor="cam-tl-interval"
              unit="s"
              value={parseFloat(tlInterval) || 0}
              onChange={(v) => setTlInterval(String(v))}
              min={0.2}
              max={60}
              step={0.2}
              disabled={tlActive}
              title={t('cam.timelapse.intervalAria', 'Timelapse interval (seconds)')}
            />
            <CamSlider
              icon={<Icon name="play" size={13} />}
              label={t('cam.timelapse.fps', 'Playback FPS')}
              htmlFor="cam-tl-fps"
              unit="fps"
              value={parseFloat(tlFps) || 0}
              onChange={(v) => setTlFps(String(Math.round(v)))}
              min={1}
              max={60}
              step={1}
              disabled={tlActive}
              title={t('cam.timelapse.fpsAria', 'Timelapse playback FPS')}
            />
          </div>
          {!canCapture && recorderSupported && (
            <p className="cam-hint">
              {t('cam.capture.needCam1', 'Start Camera 1 above to record, snapshot, or capture a timelapse.')}
            </p>
          )}
          <div className="cam-row">
            {!tlActive ? (
              <button
                type="button"
                className="cam-btn cam-grow"
                disabled={!canCapture || !recorderSupported}
                onClick={startTimelapse}
                title={t('cam.timelapse.startTip', 'Start capturing a timelapse')}
              >
                <Icon name="play" size={13} />
                {t('cam.timelapse.start', 'Start timelapse')}
              </button>
            ) : (
              <button
                type="button"
                className="cam-btn danger cam-grow"
                onClick={stopTimelapse}
                title={t('cam.timelapse.stopTip', 'Stop the timelapse, assemble the webm and download it')}
              >
                <Icon name="stop" size={13} />
                {t('cam.timelapse.stop', 'Stop & save ({count})', { count: tlCount })}
              </button>
            )}
          </div>
          {recError && <p className="cam-warn">{recError}</p>}
        </section>
      </div>
      </CamSection>

      {/* ================= BED TRACKING & CALIBRATION ================= */}
      <CamSection
        title={t('cam.sec.calib', 'Bed tracking & calibration')}
        open={secCalibOpen}
        onToggle={() => setSecCalibOpen((v) => !v)}
        badge={
          <span className="cam-raw" data-on={isCalibrated}>
            {isCalibrated
              ? t('cam.bt.calibBadge', 'calibrated')
              : t('cam.bt.uncalibBadge', 'not calibrated')}
          </span>
        }
      >
      <div className="cam-cards">
        <section className="cam-card cam-span">
          <header className="cam-card-head">
            <h4>
              {t('cam.bt.title', 'Bed tracking (3D)')}
              <CamInfo
                label={t('cam.bt.title', 'Bed tracking (3D)')}
                text={t(
                  'cam.bt.hint',
                  'Teach a camera where the bed is so the 3D viewer can show the real machine behind your toolpaths and check whether the design fits the stock.',
                )}
              />
            </h4>
            <span className="cam-raw" data-on={calib.isCalibrated()}>
              {calib.isCalibrated()
                ? t('cam.bt.calibBadge', 'calibrated')
                : t('cam.bt.uncalibBadge', 'not calibrated')}
            </span>
          </header>

          {/* show-in-3D toggle + opacity */}
          <div className="cam-seg-row">
            <span className="cam-seg-label">{t('cam.bt.show', 'Show camera in 3D')}</span>
            <div className="cam-seg" role="group" aria-label={t('cam.bt.showAria', 'Show the live camera overlay in the 3D viewport')}>
              <button
                type="button"
                className={`cam-seg-btn${calib.enabled ? ' on' : ''}`}
                onClick={() => { if (!calib.enabled) calib.toggleEnabled() }}
                aria-pressed={calib.enabled}
              >
                {t('cam.bt.showOn', 'On')}
              </button>
              <button
                type="button"
                className={`cam-seg-btn${!calib.enabled ? ' on' : ''}`}
                onClick={() => { if (calib.enabled) calib.toggleEnabled() }}
                aria-pressed={!calib.enabled}
              >
                {t('cam.bt.showOff', 'Off')}
              </button>
            </div>
          </div>
          <div className="cam-sgrid">
            <CamSlider
              icon={<Icon name="eye" size={13} />}
              label={t('cam.bt.opacity', 'Overlay opacity')}
              htmlFor="cam-bt-opacity"
              unit="%"
              value={Math.round(calib.overlayOpacity * 100)}
              onChange={(v) => calib.setOpacity(Math.min(1, Math.max(0, v / 100)))}
              min={0}
              max={100}
              step={5}
              title={t('cam.bt.opacityAria', 'Bed overlay opacity')}
            />
          </div>

          {/* slot + method choosers (segmented) */}
          <div className="cam-seg-row">
            <span className="cam-seg-label">{t('cam.bt.calibSlot', 'Calibrate')}</span>
            <div className="cam-seg" role="group" aria-label={t('cam.bt.slotGroup', 'Camera slot to calibrate')}>
              <button
                type="button"
                className={`cam-seg-btn${calibSlot === 0 ? ' on' : ''}`}
                onClick={() => setCalibSlot(0)}
                aria-pressed={calibSlot === 0}
              >
                {t('cam.bt.cam1', 'Cam 1')}
              </button>
              <button
                type="button"
                className={`cam-seg-btn${calibSlot === 1 ? ' on' : ''}`}
                disabled={!secondaryEnabled}
                onClick={() => setCalibSlot(1)}
                aria-pressed={calibSlot === 1}
                title={secondaryEnabled ? undefined : t('cam.bt.cam2Disabled', 'Enable the second camera first')}
              >
                {t('cam.bt.cam2', 'Cam 2')}
              </button>
            </div>
            {quality && (
              <span className={`cam-quality cam-quality-${quality}`}>
                {t('cam.bt.rms', 'RMS {rms} mm', { rms: (slotCam.rmsMm ?? 0).toFixed(2) })}
              </span>
            )}
            {slotCam.H && (
              <IconButton
                className="cam-icon-btn"
                iconName="trash"
                label={t('cam.bt.clearCalib', 'Clear this camera’s calibration')}
                onClick={() => {
                  calib.clearCamera(calibSlot)
                  setCalibMsg(null)
                }}
              />
            )}
          </div>

          {FEED_BRIDGE_ENABLED && (
            <div className="cam-feed-dev">
              <span className="cam-seg-label cam-feed-title">
                <span className="cam-dev-badge">{t('cam.bt.feed.devBadge', 'DEV')}</span>
                {t('cam.bt.feed.title', 'Camera → server bridge')}
                <CamInfo
                  label={t('cam.bt.feed.title', 'Camera → server bridge')}
                  text={
                    live(0) || live(1)
                      ? t('cam.bt.feed.autoNote', 'Dev-only: live frames stream to the local dev server automatically — no clicking needed. This never runs in a production build.')
                      : t('cam.bt.feed.startNote', 'Dev-only: start a camera above (allow the permission) and frames stream to the local dev server automatically. This never runs in a production build.')
                  }
                />
                {(live(0) || live(1)) && (
                  <span className={`cam-feed-dot${feedAuto ? ' on' : ''}`} title={feedAuto ? t('cam.bt.feed.autoOn', 'Auto-streaming frames to the server') : t('cam.bt.feed.autoWait', 'Waiting for frames…')}>
                    <span className="cam-feed-dot-mark" aria-hidden="true" />
                    {feedAuto ? t('cam.bt.feed.autoLabel', 'auto-streaming') : t('cam.bt.feed.autoLabelWait', 'connecting…')}
                  </span>
                )}
              </span>
              <div className="cam-row">
                <button
                  type="button"
                  className="cam-btn"
                  onClick={() => startTestPattern(calibSlot)}
                  title={t('cam.bt.feed.testTip', 'Start a synthetic in-app camera (no webcam / no permission) and stream it to the server — for testing the whole pipeline')}
                >
                  <Icon name="camera" size={14} />
                  {t('cam.bt.feed.test', 'Use test pattern (no camera)')}
                </button>
              </div>
              <div className="cam-row">
                <input
                  className="cam-feed-name"
                  type="text"
                  value={feedLabel}
                  onChange={(e) => setFeedLabel(e.target.value)}
                  placeholder={t('cam.bt.feed.name', 'name (e.g. rest, x20)')}
                  title={t('cam.bt.feed.nameTip', 'Optional: save a one-off labelled frame as .camera-frames/<name>.png')}
                />
                <button
                  type="button"
                  className="cam-btn"
                  onClick={sendOneFrame}
                  disabled={!live(calibSlot)}
                  title={t('cam.bt.feed.sendTip', 'Save a one-off labelled frame (the live feed already streams automatically)')}
                >
                  <Icon name="upload" size={14} />
                  {t('cam.bt.feed.send', 'Save labelled frame')}
                </button>
              </div>
              {feedMsg && <p className="cam-hint">{feedMsg}</p>}
            </div>
          )}

          <div className="cam-seg-row">
            <span className="cam-seg-label">{t('cam.bt.method', 'Method')}</span>
            <div className="cam-seg" role="group" aria-label={t('cam.bt.methodGroup', 'Calibration method')}>
              <button
                type="button"
                className={`cam-seg-btn${method === 'auto' ? ' on' : ''}`}
                onClick={() => setMethod('auto')}
                aria-pressed={method === 'auto'}
                title={t('cam.bt.m.autoTip', 'Recommended — the machine jogs to a grid and auto-detects the tool')}
              >
                {t('cam.bt.m.auto', 'Auto')}
              </button>
              <button
                type="button"
                className={`cam-seg-btn${method === 'machine' ? ' on' : ''}`}
                onClick={() => setMethod('machine')}
                aria-pressed={method === 'machine'}
                title={t('cam.bt.m.machineTip', 'Fallback — jog the tool to known XY and click it in the frame')}
              >
                {t('cam.bt.m.manualMotion', 'Manual')}
              </button>
              <button
                type="button"
                className={`cam-seg-btn${method === 'qr' ? ' on' : ''}`}
                disabled={!qrSupported}
                onClick={() => setMethod('qr')}
                aria-pressed={method === 'qr'}
                title={
                  qrSupported
                    ? t('cam.bt.m.qrTip', 'Read the printed TARGET QR codes')
                    : t('cam.bt.m.qrUnavailable', 'BarcodeDetector unavailable in this browser')
                }
              >
                {t('cam.bt.m.qr', 'QR')}
              </button>
              <button
                type="button"
                className={`cam-seg-btn${method === 'manual' ? ' on' : ''}`}
                onClick={() => setMethod('manual')}
                aria-pressed={method === 'manual'}
                title={t('cam.bt.m.manualTip', 'Offline fallback — click the 4 bed corners')}
              >
                {t('cam.bt.m.manual', 'Bed corners')}
              </button>
              <button
                type="button"
                className={`cam-seg-btn${method === 'head' ? ' on' : ''}`}
                onClick={() => setMethod('head')}
                aria-pressed={method === 'head'}
                title={t('cam.bt.m.headTip', 'Camera on the spindle/head, close to the bed — the view follows the machine position')}
              >
                {t('cam.bt.m.head', 'Head cam')}
              </button>
            </div>
          </div>

          {/* --- method bodies --- */}
          {method === 'auto' && (
            <div className="cam-method">
              {machineConn !== 'connected' && (
                <p className="cam-warn">
                  {t(
                    'cam.bt.auto.notConnectedHint',
                    'Machine not connected. Connect in the Controller tab — auto-calibration jogs the tool to a grid of known points.',
                  )}
                </p>
              )}
              <details className="cam-guide">
                <summary>{t('cam.bt.howItWorks', 'How this works')}</summary>
                <p className="cam-hint">
                  {t(
                    'cam.bt.auto.guide',
                    'Aim a camera at the bed so the tool is visible in the feed above and raise the tool clear of the work. Then press Auto-calibrate: the machine jogs to a small XY grid around the current position, snaps a frame at each, and finds the tool automatically (no clicking).',
                  )}
                </p>
              </details>
              <div className="cam-sgrid">
                <CamSlider
                  icon={<Icon name="frame" size={13} />}
                  label={t('cam.bt.auto.spread', 'Spread')}
                  htmlFor="cam-auto-spread"
                  unit="mm"
                  value={autoSpreadMm}
                  onChange={(v) => setAutoSpread(String(v))}
                  min={1}
                  max={100}
                  step={1}
                  disabled={autoRun.running}
                  title={t('cam.bt.auto.spreadAria', 'Grid half-extent in mm')}
                />
                <CamSlider
                  icon={<Icon name="add" size={13} />}
                  label={t('cam.bt.auto.pts', 'Points/side')}
                  htmlFor="cam-auto-pts"
                  unit={t('cam.bt.auto.ptsUnit', '→ {n}', { n: autoPointCount })}
                  value={autoPtsPerSide}
                  onChange={(v) => setAutoPts(String(Math.round(v)))}
                  min={2}
                  max={8}
                  step={1}
                  disabled={autoRun.running}
                  title={t('cam.bt.auto.ptsAria', 'Grid points per side')}
                />
              </div>
              {!autoRun.running && autoReason && (
                <p className="cam-warn cam-disabled-why">{autoReason}</p>
              )}
              <div className="cam-row">
                {!autoRun.running ? (
                  <button
                    type="button"
                    className="cam-btn cam-primary cam-grow"
                    disabled={!!autoReason}
                    onClick={() => {
                      runAuto().catch(() => {})
                    }}
                    title={autoReason ?? t('cam.bt.auto.btnTip', 'Jog a grid, auto-detect the tool, and solve the calibration')}
                  >
                    <Icon name="jog" size={14} />
                    {t('cam.bt.auto.btn', 'Auto-calibrate ({n} pts)', { n: autoPointCount })}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="cam-btn danger cam-grow"
                    onClick={abortAuto}
                    title={t('cam.bt.auto.abortTip', 'Stop the calibration and cancel the jog')}
                  >
                    <Icon name="stop" size={13} />
                    {t('cam.bt.auto.abort', 'Abort')}
                  </button>
                )}
              </div>
              {autoRun.running && autoRun.progress && (
                <p className="cam-hint cam-pending cam-auto-progress" role="status">
                  {progressLabel(autoRun.progress)}
                </p>
              )}
              {!autoRun.running && autoRun.done && (
                <p className="cam-hint cam-auto-done" role="status">
                  {autoRun.done}
                </p>
              )}
              {autoRun.kinematics && (
                <div className="cam-kin" role="status" aria-label={t('cam.bt.auto.kinAria', 'Detected per-axis kinematics')}>
                  <span className="cam-kin-title">
                    {t('cam.bt.auto.kinTitle', 'Detected kinematics')}
                  </span>
                  {([
                    ['X', autoRun.kinematics.x] as const,
                    ['Y', autoRun.kinematics.y] as const,
                  ]).map(([axisLabel, probe]) => {
                    const pxmm = Math.hypot(probe.pxPerMm[0], probe.pxPerMm[1])
                    const kindLabel =
                      probe.kind === 'head'
                        ? t('cam.bt.auto.kinHead', 'head')
                        : probe.kind === 'bed'
                          ? t('cam.bt.auto.kinBed', 'bed')
                          : t('cam.bt.auto.kinNone', 'no motion')
                    return (
                      <div className="cam-kin-row" key={axisLabel}>
                        <span className="cam-kin-axis">{axisLabel}</span>
                        <span className="cam-kin-arrow" aria-hidden="true">→</span>
                        <span className={`cam-kin-kind cam-kin-${probe.kind}`}>{kindLabel}</span>
                        <span className="cam-kin-scale">
                          {probe.kind === 'none'
                            ? '—'
                            : t('cam.bt.auto.kinPxMm', '{v} px/mm', { v: pxmm.toFixed(2) })}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {method === 'machine' && (
            <div className="cam-method">
              {!machineReady && (
                <p className="cam-warn">
                  {t(
                    'cam.bt.mm.notConnected',
                    'Machine not connected. Connect in the Controller tab to use machine-motion calibration — it reads live work X/Y as you jog.',
                  )}
                </p>
              )}
              <details className="cam-guide">
                <summary>{t('cam.bt.howItWorks', 'How this works')}</summary>
                <p className="cam-hint">
                  {t(
                    'cam.bt.mm.guide',
                    'Aim a camera at the bed so the machine’s tool is visible in the feed above. Then, for ≥4 spread-out spots: jog the tool there (Controller jog pad), press “Add point”, and click the tool’s tip in the image. Then “Solve”.',
                  )}
                </p>
              </details>
              <div className="cam-row">
                <button
                  type="button"
                  className="cam-btn cam-grow"
                  disabled={!machineReady || !live(calibSlot)}
                  onClick={addMachinePoint}
                  title={t('cam.bt.mm.addTip', 'Record the current machine work X/Y, then click the tool tip')}
                >
                  <Icon name="add" size={14} />
                  {t('cam.bt.mm.add', 'Add point (X{x} Y{y})', {
                    x: wpos.x.toFixed(1),
                    y: wpos.y.toFixed(1),
                  })}
                </button>
                <button
                  type="button"
                  className="cam-btn cam-primary cam-grow"
                  disabled={mmPairs.length < 4}
                  onClick={solveMachine}
                  title={t('cam.bt.mm.solveTip', 'Solve the camera↔machine homography from the collected pairs')}
                >
                  {t('cam.bt.mm.solve', 'Solve ({n}/4)', { n: mmPairs.length })}
                </button>
                <IconButton
                  className="cam-icon-btn"
                  iconName="close"
                  label={t('cam.bt.mm.clear', 'Clear collected points')}
                  disabled={mmPairs.length === 0 && !pendingWorld}
                  onClick={clearMachinePoints}
                />
              </div>
              {pendingWorld && (
                <p className="cam-hint cam-pending">
                  {t(
                    'cam.bt.mm.pending',
                    'Now click your tool’s TIP in the camera image above — the very end of the bit / pen / nozzle, where it touches near the bed. That pairs that pixel with the machine position X{x} Y{y} you just recorded. Then jog elsewhere and repeat.',
                    {
                      x: pendingWorld[0].toFixed(1),
                      y: pendingWorld[1].toFixed(1),
                    },
                  )}
                </p>
              )}
              {spreadTooSmall && (
                <p className="cam-warn">
                  {t('cam.bt.mm.spread', 'Points are clustered — spread them across the bed for a stable solve.')}
                </p>
              )}
            </div>
          )}

          {method === 'qr' && (
            <div className="cam-method">
              {!qrSupported ? (
                <p className="cam-warn">
                  {t(
                    'cam.bt.qr.unsupported',
                    'This browser has no BarcodeDetector. Use machine motion or bed-corner calibration instead.',
                  )}
                </p>
              ) : (
                <>
                  <details className="cam-guide">
                    <summary>{t('cam.bt.howItWorks', 'How this works')}</summary>
                    <p className="cam-hint">
                      {t(
                        'cam.bt.qr.guide',
                        'Lay the printed sheet flat on the bed with all 4 TARGET codes visible, then scan.',
                      )}
                    </p>
                  </details>
                  {!live(calibSlot) && (
                    <p className="cam-warn cam-disabled-why">
                      {t('cam.bt.qr.needCam', 'Start this camera first.')}
                    </p>
                  )}
                  <div className="cam-row">
                    <button
                      type="button"
                      className="cam-btn cam-primary cam-grow"
                      disabled={!live(calibSlot)}
                      onClick={() => {
                        runQrCalib().catch(() => {})
                      }}
                      title={t('cam.bt.qr.scanTip', 'Scan the frame for the 4 TARGET QR codes and solve')}
                    >
                      <Icon name="frame" size={14} />
                      {t('cam.bt.qr.scan', 'Scan QR & calibrate')}
                    </button>
                    {qrFound != null && (
                      <span className="cam-raw" data-on={qrFound >= 4}>
                        {t('cam.bt.qr.count', '{n}/4 markers', { n: qrFound })}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {method === 'manual' && (
            <div className="cam-method">
              <details className="cam-guide">
                <summary>{t('cam.bt.howItWorks', 'How this works')}</summary>
                <p className="cam-hint">
                  {t(
                    'cam.bt.manual.guide',
                    'Click the 4 bed corners in the frame above in this order: top-left, top-right, bottom-right, bottom-left. World corners come from the bed size ({w}×{d} mm).',
                    { w: bed.width, d: bed.depth },
                  )}
                </p>
              </details>
              <div className="cam-corner-dots">
                {BED_CORNER_ORDER.map((label, i) => (
                  <span
                    key={label}
                    className={`cam-corner-dot${i < cornerClicks.length ? ' done' : ''}${i === cornerClicks.length ? ' next' : ''}`}
                  >
                    {label}
                  </span>
                ))}
              </div>
              <div className="cam-row">
                <button
                  type="button"
                  className="cam-btn cam-primary cam-grow"
                  disabled={cornerClicks.length < 4}
                  onClick={solveManual}
                  title={t('cam.bt.manual.solveTip', 'Solve the homography from the 4 clicked bed corners')}
                >
                  {t('cam.bt.manual.solve', 'Solve ({n}/4)', { n: cornerClicks.length })}
                </button>
                <IconButton
                  className="cam-icon-btn"
                  iconName="close"
                  label={t('cam.bt.manual.clear', 'Clear clicked corners')}
                  disabled={cornerClicks.length === 0}
                  onClick={clearCorners}
                />
              </div>
            </div>
          )}

          {method === 'head' &&
            (() => {
              const hc = calib.cameras[calibSlot]
              return (
                <div className="cam-method">
                  <details className="cam-guide">
                    <summary>{t('cam.bt.howItWorks', 'How this works')}</summary>
                    <p className="cam-hint">
                      {t(
                        'cam.head.guide',
                        'For a camera on the spindle/head, too close to see all 4 corners. Point it at ONE printed QR marker and press Measure to set scale (px/mm) + rotation. The live view is then drawn on the bed at the machine position and FOLLOWS the head as it moves. Tune the offset so it lines up with the real bed, and the warp slider to straighten a wide-angle lens.',
                      )}
                    </p>
                  </details>
                  <div className="cam-row">
                    <button
                      type="button"
                      className="cam-btn cam-grow"
                      onClick={() => {
                        downloadCornerMarkers().catch(() => {})
                      }}
                      title={t(
                        'cam.head.dlMarkersTip',
                        'Download a print-ready PDF of the 4 simple corner markers (TL/TR/BL/BR) — big modules that decode reliably',
                      )}
                    >
                      <Icon name="download" size={14} />
                      {t('cam.head.dlMarkers', 'Download corner markers (PDF)')}
                    </button>
                  </div>
                  {machineConn !== 'connected' && (
                    <p className="cam-warn">
                      {t(
                        'cam.head.notConnected',
                        'Connect the machine (Controller tab) — the head overlay follows the live machine position.',
                      )}
                    </p>
                  )}
                  <div className="cam-row">
                    <button
                      type="button"
                      className="cam-btn cam-primary cam-grow"
                      disabled={!live(calibSlot) || machineConn !== 'connected' || headBusy}
                      onClick={() => {
                        runHeadMotionCalib().catch(() => {})
                      }}
                      title={t(
                        'cam.head.autoAlignTip',
                        'Recommended — jogs the head and tracks one fixed marker to auto-solve direction, rotation, scale & skew',
                      )}
                    >
                      {headBusy
                        ? t('cam.head.calibBusy', 'Calibrating…')
                        : t('cam.head.autoAlign', 'Auto-align (jog the head)')}
                    </button>
                  </div>
                  <div className="cam-row">
                    <button
                      type="button"
                      className="cam-btn cam-grow"
                      disabled={!live(calibSlot) || headBusy}
                      onClick={() => {
                        runHeadScaleFromQr().catch(() => {})
                      }}
                      title={t('cam.head.measureTip', 'Quick fallback — read one visible QR for scale + rotation only (no skew/mirror correction)')}
                    >
                      {t('cam.head.measure', 'Quick: scale & rotation from a QR')}
                    </button>
                  </div>
                  <p className="cam-hint">
                    {hc.pxPerMm
                      ? t('cam.head.cur', 'Scale {ppm} px/mm · rotation {rot}°', {
                          ppm: hc.pxPerMm.toFixed(2),
                          rot: hc.rotationDeg.toFixed(1),
                        })
                      : t('cam.head.uncal', 'Not measured yet — point at a QR and press Measure.')}
                  </p>
                  <CamSlider
                    label={t('cam.head.offX', 'Offset X')}
                    htmlFor="cam-head-offx"
                    unit="mm"
                    min={-bed.width}
                    max={bed.width}
                    step={1}
                    value={hc.offsetMm[0]}
                    onChange={(n) => calib.setCamera(calibSlot, { offsetMm: [n, hc.offsetMm[1]] })}
                  />
                  <CamSlider
                    label={t('cam.head.offY', 'Offset Y')}
                    htmlFor="cam-head-offy"
                    unit="mm"
                    min={-bed.depth}
                    max={bed.depth}
                    step={1}
                    value={hc.offsetMm[1]}
                    onChange={(n) => calib.setCamera(calibSlot, { offsetMm: [hc.offsetMm[0], n] })}
                  />
                  <CamSlider
                    label={t('cam.head.warp', 'Lens warp')}
                    htmlFor="cam-head-warp"
                    min={-0.6}
                    max={0.6}
                    step={0.01}
                    value={hc.distortK}
                    onChange={(n) => calib.setCamera(calibSlot, { distortK: n })}
                  />
                  <div className="cam-seg-row">
                    <span className="cam-seg-label">{t('cam.head.orient', 'View rotation')}</span>
                    <div className="cam-seg" role="group" aria-label={t('cam.head.orient', 'View rotation')}>
                      {[0, 1, 2, 3].map((q) => (
                        <button
                          key={q}
                          type="button"
                          className={`cam-seg-btn${(hc.headRotateQuarters % 4) === q ? ' on' : ''}`}
                          aria-pressed={(hc.headRotateQuarters % 4) === q}
                          onClick={() => calib.setCamera(calibSlot, { headRotateQuarters: q })}
                          title={t('cam.head.orientTip', 'Rotate the overlay for a rotated camera mount')}
                        >
                          {q * 90}°
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="cam-seg-row">
                    <span className="cam-seg-label">{t('cam.head.flip', 'Flip')}</span>
                    <div className="cam-seg" role="group" aria-label={t('cam.head.flip', 'Flip')}>
                      <button
                        type="button"
                        className={`cam-seg-btn${hc.headFlipH ? ' on' : ''}`}
                        aria-pressed={hc.headFlipH}
                        onClick={() => calib.setCamera(calibSlot, { headFlipH: !hc.headFlipH })}
                        title={t('cam.head.flipHTip', 'Mirror the overlay left ↔ right')}
                      >
                        {t('cam.head.flipH', 'Horizontal')}
                      </button>
                      <button
                        type="button"
                        className={`cam-seg-btn${hc.headFlipV ? ' on' : ''}`}
                        aria-pressed={hc.headFlipV}
                        onClick={() => calib.setCamera(calibSlot, { headFlipV: !hc.headFlipV })}
                        title={t('cam.head.flipVTip', 'Mirror the overlay top ↔ bottom')}
                      >
                        {t('cam.head.flipV', 'Vertical')}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })()}

          {calibMsg && <p className="cam-calib-msg">{calibMsg}</p>}

          {/* --- two-camera printed-grid calibration --- */}
          <div className="cam-subhead" title={t('cam.grid.twoCamHint', 'Two cameras (also estimates height)')}>
            {t('cam.grid.title', 'Two-camera grid (print & auto-calibrate)')}
            <CamInfo
              label={t('cam.grid.title', 'Two-camera grid (print & auto-calibrate)')}
              text={t(
                'cam.grid.hint',
                'For a head-mounted + a stationary external camera. Print the marker grid, lay it flat on the bed, then let karmyogi read each marker’s printed mm coordinate and solve both cameras at once — and tell which camera is on the head.',
              )}
            />
          </div>
          <div className="cam-grid-cal">
            {/* (1) generate the printable sheet */}
            <div className="cam-grid-step">
              <span className="cam-grid-step-n" aria-hidden="true">1</span>
              <div className="cam-grid-step-body">
                <span className="cam-grid-step-title">
                  {t('cam.grid.step1', 'Print the marker sheet')}
                  <CamInfo
                    label={t('cam.grid.step1', 'Print the marker sheet')}
                    text={t(
                      'cam.grid.step1Note',
                      'Each QR encodes its own bed position in mm. PRINT AT 100% (no “fit to page”), measure the 50 mm ruler to confirm scale, and tape it flat on the bed.',
                    )}
                  />
                </span>
                <div className="cam-row">
                  <button
                    type="button"
                    className="cam-btn cam-primary cam-grow"
                    disabled={sheetBusy}
                    onClick={() => {
                      generateSheet().catch(() => {})
                    }}
                    title={t('cam.grid.genTip', 'Generate and download a printable A4 PDF of unique QR markers')}
                  >
                    <Icon name="download" size={14} />
                    {sheetBusy
                      ? t('cam.grid.genBusy', 'Generating…')
                      : t('cam.grid.gen', 'Generate marker sheet (A4 PDF)')}
                  </button>
                </div>
              </div>
            </div>

            {/* (2) register the sheet to the machine work frame */}
            <div className="cam-grid-step">
              <span className="cam-grid-step-n" aria-hidden="true">2</span>
              <div className="cam-grid-step-body">
                <span className="cam-grid-step-title">
                  {t('cam.reg.title', 'Register the sheet to the machine')}
                  <CamInfo
                    label={t('cam.reg.title', 'Register the sheet to the machine')}
                    text={t(
                      'cam.reg.note',
                      'The sheet sits at an unknown spot on the bed. Tie it to the machine: jog the tool TIP exactly onto two printed markers and capture the live work XY at each. karmyogi bakes that into the calibration so the overlay lands in true machine coordinates (without this it would be offset/rotated). Needs the machine connected.',
                    )}
                  />
                </span>
                {machineConn !== 'connected' && (
                  <p className="cam-warn cam-disabled-why">
                    {t('cam.reg.notConnectedHint', 'Connect the machine in the Controller tab to capture work XY.')}
                  </p>
                )}
                <div className="cam-row">
                  <button
                    type="button"
                    className="cam-btn cam-grow"
                    disabled={machineConn !== 'connected'}
                    onClick={() => captureRegAnchor('origin')}
                    title={t('cam.reg.captureOriginTip', 'Jog the tool tip onto the X{x} Y{y} marker, then capture the live work XY', {
                      x: regMarkers.originMm.x,
                      y: regMarkers.originMm.y,
                    })}
                  >
                    <Icon name="probe" size={14} />
                    {t('cam.reg.captureOrigin', 'Capture origin marker (X{x} Y{y})', {
                      x: regMarkers.originMm.x,
                      y: regMarkers.originMm.y,
                    })}
                    {sheetReg.originMachine && (
                      <span className="cam-grid-count" data-on={true}>
                        {t('cam.reg.at', 'X{x} Y{y}', {
                          x: sheetReg.originMachine[0].toFixed(1),
                          y: sheetReg.originMachine[1].toFixed(1),
                        })}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="cam-btn cam-grow"
                    disabled={machineConn !== 'connected'}
                    onClick={() => captureRegAnchor('second')}
                    title={t('cam.reg.captureSecondTip', 'Jog the tool tip onto the X{x} Y{y} marker, then capture the live work XY', {
                      x: regMarkers.secondMm.x,
                      y: regMarkers.secondMm.y,
                    })}
                  >
                    <Icon name="probe" size={14} />
                    {t('cam.reg.captureSecond', 'Capture second marker (X{x} Y{y})', {
                      x: regMarkers.secondMm.x,
                      y: regMarkers.secondMm.y,
                    })}
                    {sheetReg.secondMachine && (
                      <span className="cam-grid-count" data-on={true}>
                        {t('cam.reg.at', 'X{x} Y{y}', {
                          x: sheetReg.secondMachine[0].toFixed(1),
                          y: sheetReg.secondMachine[1].toFixed(1),
                        })}
                      </span>
                    )}
                  </button>
                  {(sheetReg.originMachine || sheetReg.secondMachine) && (
                    <IconButton
                      className="cam-icon-btn"
                      iconName="close"
                      label={t('cam.reg.clear', 'Clear the sheet registration')}
                      onClick={clearRegistration}
                    />
                  )}
                </div>
                {sheetRegistration ? (
                  regTransform ? (
                    <p
                      className={`cam-hint${Math.abs(regTransform.scale - 1) > 0.05 ? ' cam-warn' : ''}`}
                      role="status"
                    >
                      {t('cam.reg.ok', 'Registered: sheet rotated {deg}° on the bed, scale {scale}× (should be ~1.0).', {
                        deg: regTransform.rotationDeg.toFixed(1),
                        scale: regTransform.scale.toFixed(3),
                      })}
                    </p>
                  ) : (
                    <p className="cam-warn" role="status">
                      {t('cam.reg.degenerate', 'The two captures are at the same spot — jog to two DIFFERENT markers.')}
                    </p>
                  )
                ) : (
                  <p className="cam-hint" role="status">
                    {t('cam.reg.pending', 'Capture BOTH markers to register. Until then a grid calibration stays in the sheet’s frame (overlay will be offset).')}
                  </p>
                )}
              </div>
            </div>

            {/* (3) auto-calibrate both cameras from the grid */}
            <div className="cam-grid-step">
              <span className="cam-grid-step-n" aria-hidden="true">3</span>
              <div className="cam-grid-step-body">
                <span className="cam-grid-step-title">
                  {t('cam.grid.step2', 'Auto-calibrate from the grid')}
                  <CamInfo
                    label={t('cam.grid.step2', 'Auto-calibrate from the grid')}
                    text={t(
                      'cam.grid.step2Note',
                      'Aim each camera at the sheet so several markers are visible, then scan. ≥4 markers per camera are needed. Do step 2 (register) first so the result lands in machine coordinates.',
                    )}
                  />
                </span>
                {!qrSupported && (
                  <p className="cam-warn cam-disabled-why">
                    {t('cam.grid.noDetector', 'BarcodeDetector is unavailable in this browser — use Auto or Manual calibration instead.')}
                  </p>
                )}
                {qrSupported && !sheetRegistration && (
                  <p className="cam-warn cam-disabled-why">
                    {t('cam.grid.regFirst', 'Not registered yet — calibrating now lands in the sheet’s frame (overlay offset). Do step 2 first, or re-calibrate after.')}
                  </p>
                )}
                <div className="cam-row">
                  <button
                    type="button"
                    className="cam-btn cam-grow"
                    disabled={!qrSupported || !live(0)}
                    onClick={() => {
                      autoCalibSlotFromGrid(0).catch(() => {})
                    }}
                    title={t('cam.grid.scan1Tip', 'Read the grid in Camera 1 and solve its calibration')}
                  >
                    <Icon name="frame" size={14} />
                    {t('cam.grid.scan1', 'Calibrate Cam 1')}
                    {gridFound[0] != null && (
                      <span className="cam-grid-count" data-on={gridFound[0] >= 4}>
                        {t('cam.grid.count', '{n} found', { n: gridFound[0] })}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="cam-btn cam-grow"
                    disabled={!qrSupported || !secondaryEnabled || !live(1)}
                    onClick={() => {
                      autoCalibSlotFromGrid(1).catch(() => {})
                    }}
                    title={
                      secondaryEnabled
                        ? t('cam.grid.scan2Tip', 'Read the grid in Camera 2 and solve its calibration')
                        : t('cam.bt.cam2Disabled', 'Enable the second camera first')
                    }
                  >
                    <Icon name="frame" size={14} />
                    {t('cam.grid.scan2', 'Calibrate Cam 2')}
                    {gridFound[1] != null && (
                      <span className="cam-grid-count" data-on={gridFound[1] >= 4}>
                        {t('cam.grid.count', '{n} found', { n: gridFound[1] })}
                      </span>
                    )}
                  </button>
                </div>
                {secondaryEnabled && (
                  <div className="cam-row">
                    <button
                      type="button"
                      className="cam-btn cam-primary cam-grow"
                      disabled={!qrSupported || !live(0)}
                      onClick={() => {
                        autoCalibBothFromGrid().catch(() => {})
                      }}
                      title={t('cam.grid.scanBothTip', 'Read the grid in both live cameras and solve both at once')}
                    >
                      <Icon name="frame" size={14} />
                      {t('cam.grid.scanBoth', 'Auto-calibrate both cameras')}
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* (4) detect which camera is head-mounted vs stationary */}
            <div className="cam-grid-step">
              <span className="cam-grid-step-n" aria-hidden="true">4</span>
              <div className="cam-grid-step-body">
                <span className="cam-grid-step-title">
                  {t('cam.role.title', 'Detect head vs stationary camera')}
                  <CamInfo
                    label={t('cam.role.title', 'Detect head vs stationary camera')}
                    text={t(
                      'cam.role.note',
                      'Jogs the machine a small known distance and watches which feed the world shifts in — the head-mounted camera moves with the spindle; the external one barely changes. Needs the machine connected; it will ask before jogging.',
                    )}
                  />
                </span>
                {machineConn !== 'connected' && (
                  <p className="cam-warn cam-disabled-why">
                    {t('cam.role.notConnectedHint', 'Connect the machine in the Controller tab to run the probe.')}
                  </p>
                )}
                <div className="cam-role-chips" role="status">
                  {([0, 1] as SlotIdx[]).map((s) => {
                    const r = camRoles[s]
                    return (
                      <span key={s} className={`cam-role-chip cam-role-${r}`}>
                        <span className="cam-role-chip-cam">
                          {s === 0 ? t('cam.bt.cam1', 'Cam 1') : t('cam.bt.cam2', 'Cam 2')}
                        </span>
                        <span className="cam-role-chip-val">
                          {r === 'head'
                            ? t('cam.role.head', 'head-mounted')
                            : r === 'stationary'
                              ? t('cam.role.stationary', 'stationary')
                              : t('cam.role.unknown', 'unknown')}
                        </span>
                      </span>
                    )
                  })}
                </div>
                <div className="cam-row">
                  {!roleRunning ? (
                    <button
                      type="button"
                      className="cam-btn cam-grow"
                      disabled={machineConn !== 'connected' || (!live(0) && !live(1))}
                      onClick={() => {
                        runRoleProbe().catch(() => {})
                      }}
                      title={t('cam.role.runTip', 'Jog a known distance and infer which camera is on the head')}
                    >
                      <Icon name="jog" size={14} />
                      {t('cam.role.run', 'Detect camera mounts')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="cam-btn danger cam-grow"
                      onClick={abortRoleProbe}
                      title={t('cam.role.abortTip', 'Stop the probe and cancel the jog')}
                    >
                      <Icon name="stop" size={13} />
                      {t('cam.role.abort', 'Abort')}
                    </button>
                  )}
                </div>
                {roleRunning && roleProgress && (
                  <p className="cam-hint cam-pending" role="status">
                    {roleProgressLabel(roleProgress)}
                  </p>
                )}
              </div>
            </div>
          </div>
          {gridMsg && <p className="cam-calib-msg">{gridMsg}</p>}

          {/* --- job footprint + height --- */}
          <div className="cam-subhead">
            {t('cam.bt.jobTitle', 'Job (stock) on the bed')}
            <CamInfo
              label={t('cam.bt.jobTitle', 'Job (stock) on the bed')}
              text={t(
                'cam.bt.jobHint',
                'Tell karmyogi where the workpiece sits so it can fit-check the design. Detect it from STOCK stickers, or set the size by hand.',
              )}
            />
          </div>
          {detectQrReason && <p className="cam-warn cam-disabled-why">{detectQrReason}</p>}
          <div className="cam-row">
            <button
              type="button"
              className="cam-btn cam-grow"
              disabled={!!detectQrReason}
              onClick={() => {
                detectJobFromQr().catch(() => {})
              }}
              title={detectQrReason ?? t('cam.bt.job.detectTip', 'Detect the workpiece from STOCK QR stickers (needs Cam 1 calibrated)')}
            >
              <Icon name="frame" size={14} />
              {t('cam.bt.job.detect', 'Detect from stock QR')}
            </button>
          </div>
          <div className="cam-sgrid">
            <CamSlider
              icon={<Icon name="frame" size={13} />}
              label={t('cam.bt.job.w', 'Width')}
              htmlFor="cam-job-w"
              unit="mm"
              value={parseFloat(jobW) || 0}
              onChange={(v) => setJobW(String(v))}
              min={0}
              max={Math.max(500, bed.width)}
              step={1}
              title={t('cam.bt.job.wAria', 'Job width in mm')}
            />
            <CamSlider
              icon={<Icon name="frame" size={13} />}
              label={t('cam.bt.job.d', 'Depth')}
              htmlFor="cam-job-d"
              unit="mm"
              value={parseFloat(jobD) || 0}
              onChange={(v) => setJobD(String(v))}
              min={0}
              max={Math.max(500, bed.depth)}
              step={1}
              title={t('cam.bt.job.dAria', 'Job depth in mm')}
            />
            <CamSlider
              icon={<Icon name="probe" size={13} />}
              label={t('cam.bt.job.thk', 'Thickness')}
              htmlFor="cam-job-thk"
              unit="mm"
              value={parseFloat(jobThk) || 0}
              onChange={(v) => setJobThk(String(v))}
              min={0}
              max={100}
              step={0.5}
              title={t('cam.bt.job.thkAria', 'Job thickness in mm')}
            />
          </div>
          <div className="cam-row">
            <button
              type="button"
              className="cam-btn cam-grow"
              onClick={applyManualJob}
              title={t('cam.bt.job.setTip', 'Place a job of this size at the bed center')}
            >
              <Icon name="frame" size={14} />
              {t('cam.bt.job.setBtn', 'Set job size')}
            </button>
            <button
              type="button"
              className="cam-btn cam-grow"
              disabled={!!hullReason}
              onClick={estimateHeight}
              title={hullReason ?? t('cam.bt.hull.tip', 'Estimate stock height by two-camera shape-from-silhouette')}
            >
              <Icon name="probe" size={14} />
              {t('cam.bt.hull.btn', 'Estimate height (visual hull)')}
            </button>
          </div>
          {hullReason && <p className="cam-warn cam-disabled-why">{hullReason}</p>}
          {calib.jobRect && (
            <p className="cam-hint cam-job-readout">
              {t('cam.bt.job.current', 'Current job: {w}×{d} mm{h}', {
                w: (calib.jobRect.maxX - calib.jobRect.minX).toFixed(0),
                d: (calib.jobRect.maxY - calib.jobRect.minY).toFixed(0),
                h: calib.jobHeightMm != null ? ` × ${calib.jobHeightMm.toFixed(1)} mm` : '',
              })}
            </p>
          )}
        </section>
      </div>
      </CamSection>

      {/* ========================= SAVED RECORDINGS ========================= */}
      <CamSection
        title={t('cam.sec.saved', 'Saved recordings')}
        open={secSavedOpen}
        onToggle={() => setSecSavedOpen((v) => !v)}
        badge={<span className="cam-raw">{clips.length + savedClips.length}</span>}
      >
      <div className="cam-cards">
        {/* ---- recorded clips ---- */}
        <section className="cam-card cam-span">
          <header className="cam-card-head">
            <h4>{t('cam.clips.title', 'Clips')}</h4>
            <span className="cam-raw">{clips.length}</span>
          </header>
          {clips.length === 0 ? (
            <p className="cam-hint">{t('cam.clips.empty', 'Recordings and timelapses you save show up here.')}</p>
          ) : (
            <ul className="cam-clips">
              {clips.map((c) => (
                <li key={c.id} className="cam-clip">
                  <span className={`cam-clip-tag ${c.kind}`}>
                    {c.kind === 'rec' ? t('cam.clips.tagRec', 'REC') : t('cam.clips.tagTl', 'TL')}
                  </span>
                  <span className="cam-clip-name" title={c.name}>
                    {c.name}
                  </span>
                  <span className="cam-clip-size">{fmtBytes(c.bytes)}</span>
                  <a
                    className="cam-btn cam-mini cam-clip-dl"
                    href={c.url}
                    download={c.name}
                    title={t('cam.clips.download', 'Download {name}', { name: c.name })}
                    aria-label={t('cam.clips.download', 'Download {name}', { name: c.name })}
                  >
                    <Icon name="download" size={14} />
                  </a>
                  <IconButton
                    className="cam-icon-btn cam-mini"
                    iconName="trash"
                    label={t('cam.clips.remove', 'Remove from this list (does not delete a downloaded file)')}
                    onClick={() => removeClip(c.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- auto-recorded clips (saved in this browser via IndexedDB) ---- */}
        <section className="cam-card cam-span">
          <header className="cam-card-head">
            <h4>{t('cam.saved.title', 'Saved run recordings')}</h4>
            <span className="cam-raw">{savedClips.length}</span>
          </header>
          {savedClips.length === 0 ? (
            <p className="cam-hint">
              {t(
                'cam.saved.empty',
                'Clips auto-recorded while the machine streams a program are saved in this browser and listed here.',
              )}
            </p>
          ) : (
            <ul className="cam-clips">
              {savedClips.map((c) => (
                <li key={c.id} className="cam-saved-clip">
                  <div className="cam-clip">
                    <span className="cam-clip-tag rec">{t('cam.saved.tag', 'AUTO')}</span>
                    <span className="cam-clip-name" title={c.name}>
                      {c.name}
                    </span>
                    <span className="cam-clip-size">
                      {fmtDuration(c.durationMs)} · {fmtBytes(c.bytes)}
                    </span>
                    <button
                      type="button"
                      className="cam-btn cam-mini"
                      onClick={() => {
                        playClip(c.id).catch(() => {})
                      }}
                      title={
                        playingClip?.id === c.id
                          ? t('cam.saved.close', 'Close the player')
                          : t('cam.saved.play', 'Play {name}', { name: c.name })
                      }
                      aria-label={
                        playingClip?.id === c.id
                          ? t('cam.saved.close', 'Close the player')
                          : t('cam.saved.play', 'Play {name}', { name: c.name })
                      }
                    >
                      <Icon name={playingClip?.id === c.id ? 'stop' : 'play'} size={14} />
                    </button>
                    <button
                      type="button"
                      className="cam-btn cam-mini cam-clip-dl"
                      onClick={() => {
                        downloadClip(c).catch(() => {})
                      }}
                      title={t('cam.clips.download', 'Download {name}', { name: c.name })}
                      aria-label={t('cam.clips.download', 'Download {name}', { name: c.name })}
                    >
                      <Icon name="download" size={14} />
                    </button>
                    <IconButton
                      className="cam-icon-btn cam-mini"
                      iconName="trash"
                      label={t('cam.saved.delete', 'Delete {name} from this browser', { name: c.name })}
                      onClick={() => {
                        removeSavedClip(c.id).catch(() => {})
                      }}
                    />
                  </div>
                  {playingClip?.id === c.id && (
                    <video
                      className="cam-saved-video"
                      src={playingClip.url}
                      controls
                      autoPlay
                      playsInline
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      </CamSection>
    </div>
  )
}
