import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  runAutoCalibration,
  type AutoCalibProgress,
  type KinematicsInfo,
} from '../camera/autoCalib'
import { grbl } from '../serial/controller'
import { useT } from '../i18n'
import { Icon } from '../components/Icons'
import { IconButton } from '../components/IconButton'
import { useCameraCalib, useCameraLive, useMachine } from '../store'
import { useBed } from '../store/bed'
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
  loadMarkerRegistry,
  targetMarkers,
  captureFrame,
  videoToGray,
  detectQrCodes,
  barcodeDetectorAvailable,
  bedCornersMm,
  BED_CORNER_ORDER,
  clickToImagePx,
  minPairwiseDist,
  rectFromPoints,
  centeredRect,
  type CapturedFrame,
} from '../camera/bedTracking'
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
type CalibMethod = 'auto' | 'machine' | 'qr' | 'manual'

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

  // Job manual inputs.
  const [jobW, setJobW] = useState('100')
  const [jobD, setJobD] = useState('100')
  const [jobThk, setJobThk] = useState('12')

  // Empty-bed reference captured flags (mirror refGrayRef for re-render).
  const [refCaptured, setRefCaptured] = useState<[boolean, boolean]>([false, false])

  const qrSupported = barcodeDetectorAvailable()
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
    },
    [setVideoEl],
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
      const constraints: MediaStreamConstraints = {
        video: id ? { deviceId: { exact: id } } : true,
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
    [supported, stopStream, enumerate, setVideoEl, setSlotStatus, t],
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

  // Full cleanup on unmount.
  useEffect(() => {
    const videoEls = videoRefs.current
    const streamEls = streamRefs.current
    return () => {
      // Abort any in-flight auto-calibration so no jog is left running.
      autoAbortRef.current?.abort()
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
      calib.setCamera(s, { H: [...H], rmsMm: rms, frameW, frameH })
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
    const reg = await loadMarkerRegistry()
    const targets = targetMarkers(reg)
    if (targets.length === 0) {
      setCalibMsg(t('cam.bt.err.noRegistry', 'Marker registry unavailable — use manual or machine motion.'))
      return
    }
    const codes = await detectQrCodes(frame)
    // Match each detected payload to a TARGET marker by its id.
    const imgPts: Vec2[] = []
    const worldPts: Vec2[] = []
    let matched = 0
    for (const code of codes) {
      const parsed = parseMarkerPayload(code.rawValue)
      if (!parsed || parsed.kind !== 'TARGET') continue
      const pos = parsed.fields.pos
      const tgt = targets.find((m) => m.id === pos)
      if (!tgt) continue
      imgPts.push(code.center)
      worldPts.push([tgt.frameXmm, tgt.frameYmm])
      matched++
    }
    setQrFound(matched)
    if (matched < 4) {
      setCalibMsg(
        t('cam.bt.qr.notEnough', 'Found {n}/4 TARGET markers — need all 4 visible.', { n: matched }),
      )
      return
    }
    commitHomography(calibSlot, imgPts, worldPts, frame.width, frame.height)
  }, [calibSlot, commitHomography, t])

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
            <div className="cam-empty" role="status">
              <strong>{empty.title}</strong>
              <span>{empty.body}</span>
            </div>
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
      </section>
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

      <div className="cam-cards">
        {/* ---- calibration sheet (printable QR fiducials) ---- */}
        <section className="cam-card">
          <header className="cam-card-head">
            <h4>{t('cam.calib.title', 'Calibration sheet')}</h4>
            <span className="cam-raw">{t('cam.calib.badge', 'A4 · QR')}</span>
          </header>
          <p className="cam-hint">
            {t(
              'cam.calib.hint',
              'Print this QR fiducial sheet at 100% scale and lay it flat on the bed. The camera reads the codes to learn mm-per-pixel + perspective, then measures bed and stock size automatically. Cut out the S# stickers for the workpiece.',
            )}
          </p>
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
            <h4>{t('cam.slot2.title', 'Second camera')}</h4>
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
          <p className="cam-hint">
            {t(
              'cam.slot2.hint',
              'A second camera (different angle) lets karmyogi estimate the stock HEIGHT by shape-from-silhouette. Optional — leave off for a single top-down view.',
            )}
          </p>
        </section>
        {secondaryEnabled && renderSlot(1)}

        {/* ---- capture controls (slot 0 / Camera 1 only) ---- */}
        <section className="cam-card">
          <header className="cam-card-head">
            <h4>{t('cam.capture.title', 'Capture')}</h4>
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
            <h4>{t('cam.timelapse.title', 'Timelapse')}</h4>
            {tlActive ? (
              <span className="cam-raw" data-on={true}>
                {t('cam.timelapse.frames', '{count} frame(s)', { count: tlCount })}
              </span>
            ) : (
              <span className="cam-raw">{t('cam.capture.cam1only', 'Camera 1 only')}</span>
            )}
          </header>
          <p className="cam-hint">
            {t('cam.timelapse.hint', 'Grab a frame every interval, play them back fast into one webm.')}
          </p>
          {!recorderSupported && (
            <p className="cam-warn">
              {t('cam.capture.noRecorder', 'Recording is not supported in this browser (no MediaRecorder).')}
            </p>
          )}
          <div className="cam-fields">
            <label htmlFor="cam-tl-interval">
              <span className="cam-flabel">{t('cam.timelapse.interval', 'Interval (s)')}</span>
              <input
                id="cam-tl-interval"
                className="cam-input"
                type="text"
                inputMode="decimal"
                value={tlInterval}
                disabled={tlActive}
                onChange={(e) => setTlInterval(e.target.value)}
                aria-label={t('cam.timelapse.intervalAria', 'Timelapse interval (seconds)')}
              />
            </label>
            <label htmlFor="cam-tl-fps">
              <span className="cam-flabel">{t('cam.timelapse.fps', 'Playback FPS')}</span>
              <input
                id="cam-tl-fps"
                className="cam-input"
                type="text"
                inputMode="numeric"
                value={tlFps}
                disabled={tlActive}
                onChange={(e) => setTlFps(e.target.value)}
                aria-label={t('cam.timelapse.fpsAria', 'Timelapse playback FPS')}
              />
            </label>
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

        {/* ================= BED TRACKING (3D) ================= */}
        <section className="cam-card cam-span">
          <header className="cam-card-head">
            <h4>{t('cam.bt.title', 'Bed tracking (3D)')}</h4>
            <span className="cam-raw" data-on={calib.isCalibrated()}>
              {calib.isCalibrated()
                ? t('cam.bt.calibBadge', 'calibrated')
                : t('cam.bt.uncalibBadge', 'not calibrated')}
            </span>
          </header>
          <p className="cam-hint">
            {t(
              'cam.bt.hint',
              'Teach a camera where the bed is so the 3D viewer can show the real machine behind your toolpaths and check whether the design fits the stock.',
            )}
          </p>

          {/* show-in-3D toggle + opacity */}
          <div className="cam-fields cam-fields-3d">
            <label className="cam-switch cam-switch-wide">
              <input
                type="checkbox"
                checked={calib.enabled}
                onChange={() => calib.toggleEnabled()}
                aria-label={t('cam.bt.showAria', 'Show the live camera overlay in the 3D viewport')}
              />
              <span>{t('cam.bt.show', 'Show camera in 3D')}</span>
            </label>
            <label htmlFor="cam-bt-opacity">
              <span className="cam-flabel">
                {t('cam.bt.opacity', 'Overlay opacity')} · {Math.round(calib.overlayOpacity * 100)}%
              </span>
              <input
                id="cam-bt-opacity"
                className="cam-range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={calib.overlayOpacity}
                onChange={(e) => calib.setOpacity(parseFloat(e.target.value))}
                aria-label={t('cam.bt.opacityAria', 'Bed overlay opacity')}
              />
            </label>
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
                {(live(0) || live(1)) && (
                  <span className={`cam-feed-dot${feedAuto ? ' on' : ''}`} title={feedAuto ? t('cam.bt.feed.autoOn', 'Auto-streaming frames to the server') : t('cam.bt.feed.autoWait', 'Waiting for frames…')}>
                    <span className="cam-feed-dot-mark" aria-hidden="true" />
                    {feedAuto ? t('cam.bt.feed.autoLabel', 'auto-streaming') : t('cam.bt.feed.autoLabelWait', 'connecting…')}
                  </span>
                )}
              </span>
              <p className="cam-hint">
                {live(0) || live(1)
                  ? t('cam.bt.feed.autoNote', 'Dev-only: live frames stream to the local dev server automatically — no clicking needed. This never runs in a production build.')
                  : t('cam.bt.feed.startNote', 'Dev-only: start a camera above (allow the permission) and frames stream to the local dev server automatically. This never runs in a production build.')}
              </p>
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
              <div className="cam-fields">
                <label htmlFor="cam-auto-spread">
                  <span className="cam-flabel">{t('cam.bt.auto.spread', 'Spread (mm)')}</span>
                  <input
                    id="cam-auto-spread"
                    className="cam-input"
                    type="text"
                    inputMode="decimal"
                    value={autoSpread}
                    disabled={autoRun.running}
                    onChange={(e) => setAutoSpread(e.target.value)}
                    aria-label={t('cam.bt.auto.spreadAria', 'Grid half-extent in mm')}
                  />
                </label>
                <label htmlFor="cam-auto-pts">
                  <span className="cam-flabel">
                    {t('cam.bt.auto.pts', 'Points per side')} · {autoPointCount} {t('cam.bt.auto.ptsUnit', 'points')}
                  </span>
                  <input
                    id="cam-auto-pts"
                    className="cam-input"
                    type="text"
                    inputMode="numeric"
                    value={autoPts}
                    disabled={autoRun.running}
                    onChange={(e) => setAutoPts(e.target.value)}
                    aria-label={t('cam.bt.auto.ptsAria', 'Grid points per side')}
                  />
                </label>
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

          {calibMsg && <p className="cam-calib-msg">{calibMsg}</p>}

          {/* --- job footprint + height --- */}
          <div className="cam-subhead">{t('cam.bt.jobTitle', 'Job (stock) on the bed')}</div>
          <p className="cam-hint">
            {t(
              'cam.bt.jobHint',
              'Tell karmyogi where the workpiece sits so it can fit-check the design. Detect it from STOCK stickers, or set the size by hand.',
            )}
          </p>
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
          <div className="cam-fields">
            <label htmlFor="cam-job-w">
              <span className="cam-flabel">{t('cam.bt.job.w', 'Width (mm)')}</span>
              <input
                id="cam-job-w"
                className="cam-input"
                type="text"
                inputMode="decimal"
                value={jobW}
                onChange={(e) => setJobW(e.target.value)}
                aria-label={t('cam.bt.job.wAria', 'Job width in mm')}
              />
            </label>
            <label htmlFor="cam-job-d">
              <span className="cam-flabel">{t('cam.bt.job.d', 'Depth (mm)')}</span>
              <input
                id="cam-job-d"
                className="cam-input"
                type="text"
                inputMode="decimal"
                value={jobD}
                onChange={(e) => setJobD(e.target.value)}
                aria-label={t('cam.bt.job.dAria', 'Job depth in mm')}
              />
            </label>
            <label htmlFor="cam-job-thk">
              <span className="cam-flabel">{t('cam.bt.job.thk', 'Thickness (mm)')}</span>
              <input
                id="cam-job-thk"
                className="cam-input"
                type="text"
                inputMode="decimal"
                value={jobThk}
                onChange={(e) => setJobThk(e.target.value)}
                aria-label={t('cam.bt.job.thkAria', 'Job thickness in mm')}
              />
            </label>
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
      </div>
    </div>
  )
}
