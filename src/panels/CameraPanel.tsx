import { useCallback, useEffect, useRef, useState } from 'react'
import '../styles/camera.css'

/**
 * Camera panel — a clean, simple webcam feed tool.
 *
 * Pure UI (no stores, no core): component state + refs only.
 *
 *  1. Camera selection — enumerate `videoinput` devices, pick one in a <select>,
 *     re-enumerate on `devicechange`. Labels only populate after permission is
 *     granted, so we request a stream first, then re-enumerate.
 *  2. Live feed — getUserMedia({ video: { deviceId } }) into a muted, playsInline
 *     <video>. Power toggle to start/stop. Friendly empty states for
 *     not-supported / permission-denied / no-camera (getUserMedia needs HTTPS or
 *     localhost — noted in the empty state).
 *  3. Recording — MediaRecorder (prefer video/webm); elapsed time + REC dot;
 *     auto-download on stop and keep a small clip list with download links.
 *  4. Snapshot — draw the current frame to a <canvas> and download a PNG.
 *  5. Timelapse — capture a frame every N seconds into a canvas-backed
 *     MediaRecorder stream redrawn at the chosen FPS, assemble a webm, download.
 *  6. Cleanup — stop all tracks / recorders on unmount and when switching cameras.
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

export function CameraPanel() {
  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'

  // ---- refs (never trigger re-renders) ----
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recTimerRef = useRef<number | null>(null)

  // Timelapse machinery.
  const tlCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const tlRecorderRef = useRef<MediaRecorder | null>(null)
  const tlChunksRef = useRef<Blob[]>([])
  const tlCaptureTimerRef = useRef<number | null>(null)
  const tlDrawTimerRef = useRef<number | null>(null)
  const tlFramesRef = useRef<ImageBitmap[]>([])
  const tlDrawIdxRef = useRef(0)

  // Monotonic id for clips / filenames.
  const seqRef = useRef(0)

  // ---- state (drives the UI) ----
  const [status, setStatus] = useState<Status>(
    supported ? { kind: 'idle' } : { kind: 'unsupported' },
  )
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string>('')
  const [clips, setClips] = useState<Clip[]>([])

  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)

  const [tlActive, setTlActive] = useState(false)
  const [tlInterval, setTlInterval] = useState('5')
  const [tlFps, setTlFps] = useState('10')
  const [tlCount, setTlCount] = useState(0)

  const live = status.kind === 'live'

  // ---- device enumeration ----
  const enumerate = useCallback(async () => {
    if (!supported || !navigator.mediaDevices.enumerateDevices) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const cams = all.filter((d) => d.kind === 'videoinput')
      setDevices(cams)
      setDeviceId((prev) => {
        if (prev && cams.some((c) => c.deviceId === prev)) return prev
        return cams[0]?.deviceId ?? ''
      })
    } catch {
      /* ignore — enumeration can fail before any permission */
    }
  }, [supported])

  // ---- stop everything ----
  const stopStream = useCallback(() => {
    const s = streamRef.current
    if (s) {
      for (const t of s.getTracks()) t.stop()
    }
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  // ---- start / restart the live stream for the current deviceId ----
  const startStream = useCallback(
    async (id: string) => {
      if (!supported) {
        setStatus({ kind: 'unsupported' })
        return
      }
      // Tear down any existing stream first (switching cameras / restart).
      stopStream()
      setStatus({ kind: 'starting' })
      const constraints: MediaStreamConstraints = {
        video: id ? { deviceId: { exact: id } } : true,
        audio: false,
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          // play() can reject if the element unmounts mid-flight; ignore.
          videoRef.current.play().catch(() => {})
        }
        setStatus({ kind: 'live' })
        // Now that permission is granted, labels are available — re-enumerate.
        await enumerate()
        // Lock onto the actual device we got (id may have been '' / default).
        const track = stream.getVideoTracks()[0]
        const realId = track?.getSettings().deviceId
        if (realId) setDeviceId(realId)
      } catch (err) {
        const e = err as DOMException
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          setStatus({ kind: 'denied' })
        } else if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
          setStatus({ kind: 'nocamera' })
        } else {
          setStatus({ kind: 'error', message: e?.message || 'Could not start the camera.' })
        }
      }
    },
    [supported, stopStream, enumerate],
  )

  // ---- recording ----
  const stopRecording = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    // onstop handler finalizes the clip; just clear the elapsed timer here.
    if (recTimerRef.current !== null) {
      window.clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
  }, [])

  const startRecording = useCallback(() => {
    const stream = streamRef.current
    if (!stream || typeof MediaRecorder === 'undefined') return
    const mime = pickMime()
    let rec: MediaRecorder
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    } catch {
      return
    }
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
  }, [])

  // ---- snapshot ----
  const snapshot = useCallback(() => {
    const v = videoRef.current
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
      // Snapshots auto-download but aren't kept in the clip list (they're images).
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    }, 'image/png')
  }, [])

  // ---- timelapse ----
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
      // Give the recorder a beat to flush the final frame, then stop.
      window.setTimeout(() => {
        if (rec.state !== 'inactive') rec.stop()
      }, 200)
    }
    setTlActive(false)
  }, [])

  const startTimelapse = useCallback(() => {
    const stream = streamRef.current
    const v = videoRef.current
    if (!stream || !v || typeof MediaRecorder === 'undefined') return
    const intervalS = Math.max(0.2, parseFloat(tlInterval) || 5)
    const fps = Math.max(1, Math.min(60, Math.round(parseFloat(tlFps) || 10)))

    // Source dimensions — fall back to a sane default until metadata loads.
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

    // Reset frame buffers.
    for (const bmp of tlFramesRef.current) bmp.close?.()
    tlFramesRef.current = []
    tlDrawIdxRef.current = 0
    setTlCount(0)

    // Record the canvas as it's redrawn (the canvas drives the stream's frames).
    const canvasStream = canvas.captureStream(fps)
    const mime = pickMime()
    let rec: MediaRecorder
    try {
      rec = mime
        ? new MediaRecorder(canvasStream, { mimeType: mime })
        : new MediaRecorder(canvasStream)
    } catch {
      return
    }
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

    // Capture a frame from the live video every `intervalS` seconds.
    const capture = () => {
      const vid = videoRef.current
      if (!vid || !vid.videoWidth) return
      createImageBitmap(vid)
        .then((bmp) => {
          tlFramesRef.current.push(bmp)
          setTlCount(tlFramesRef.current.length)
        })
        .catch(() => {})
    }
    capture() // grab one immediately so there's never an empty timelapse
    tlCaptureTimerRef.current = window.setInterval(capture, intervalS * 1000)

    // Redraw the canvas at the playback FPS, advancing through captured frames.
    // This is what gives the sped-up playback: many captured frames played at fps.
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
  }, [tlInterval, tlFps])

  // ---- power toggle (start/stop live feed) ----
  const toggleLive = useCallback(() => {
    if (live || status.kind === 'starting') {
      // Stop recording / timelapse first, then the stream.
      stopRecording()
      stopTimelapse()
      stopStream()
      setStatus({ kind: 'idle' })
    } else {
      startStream(deviceId).catch(() => {})
    }
  }, [live, status.kind, deviceId, startStream, stopStream, stopRecording, stopTimelapse])

  // ---- switch camera (only restart if currently live) ----
  const onSelectDevice = useCallback(
    (id: string) => {
      setDeviceId(id)
      if (live || status.kind === 'starting') {
        stopRecording()
        stopTimelapse()
        startStream(id).catch(() => {})
      }
    },
    [live, status.kind, startStream, stopRecording, stopTimelapse],
  )

  // Initial enumeration + listen for device changes.
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

  // Full cleanup on unmount — no leaked streams / recorders / timers / object URLs.
  useEffect(() => {
    return () => {
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
      const s = streamRef.current
      if (s) for (const t of s.getTracks()) t.stop()
      streamRef.current = null
    }
  }, [])

  // Revoke clip object URLs when clips are removed from the list.
  const removeClip = useCallback((id: number) => {
    setClips((prev) => {
      const found = prev.find((c) => c.id === id)
      if (found) URL.revokeObjectURL(found.url)
      return prev.filter((c) => c.id !== id)
    })
  }, [])

  // ---- empty-state messaging ----
  const emptyState = (() => {
    switch (status.kind) {
      case 'unsupported':
        return {
          title: 'Camera not supported',
          body: 'This browser has no getUserMedia. Use a Chromium browser over HTTPS or localhost.',
        }
      case 'denied':
        return {
          title: 'Permission denied',
          body: 'Camera access was blocked. Allow it in the address-bar site permissions, then press the power button again. (getUserMedia needs HTTPS or localhost.)',
        }
      case 'nocamera':
        return {
          title: 'No camera found',
          body: 'No video input device is available. Plug in a webcam and it will appear here.',
        }
      case 'error':
        return { title: 'Camera error', body: status.message }
      case 'starting':
        return { title: 'Starting camera…', body: 'Grant permission if your browser asks.' }
      default:
        return {
          title: 'Camera off',
          body: 'Press the power button to start the live feed. getUserMedia needs HTTPS or localhost.',
        }
    }
  })()

  const canCapture = live && !!streamRef.current

  return (
    <div className="cam-panel" aria-label="Camera">
      <p className="cam-intro">
        Live webcam feed — record clips, grab PNG snapshots, or capture a sped-up
        timelapse. Everything stays in your browser.
      </p>

      {/* ---- camera selection + power ---- */}
      <section className="cam-card">
        <header className="cam-card-head">
          <h4>Camera</h4>
          <span className="cam-raw" data-on={live}>
            {live ? 'live' : status.kind === 'starting' ? 'starting…' : 'off'}
          </span>
        </header>
        <div className="cam-row">
          <select
            className="cam-select"
            value={deviceId}
            disabled={!supported || devices.length === 0}
            onChange={(e) => onSelectDevice(e.target.value)}
            title="Choose which camera to use"
            aria-label="Camera device"
          >
            {devices.length === 0 && <option value="">No cameras found</option>}
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`cam-btn cam-power${live ? ' on' : ''}`}
            disabled={!supported}
            onClick={toggleLive}
            title={live ? 'Stop the camera' : 'Start the camera'}
            aria-pressed={live}
          >
            <span className="cam-power-dot" aria-hidden="true" />
            {live ? 'Stop' : 'Start'}
          </button>
        </div>
      </section>

      {/* ---- live feed ---- */}
      <section className="cam-card">
        <header className="cam-card-head">
          <h4>Feed</h4>
          {recording && (
            <span className="cam-rec" title="Recording in progress">
              <span className="cam-rec-dot" aria-hidden="true" />
              REC {fmtElapsed(recElapsed)}
            </span>
          )}
        </header>
        <div className="cam-stage" data-live={live}>
          <video
            ref={videoRef}
            className="cam-video"
            autoPlay
            muted
            playsInline
            hidden={!live}
          />
          {!live && (
            <div className="cam-empty" role="status">
              <strong>{emptyState.title}</strong>
              <span>{emptyState.body}</span>
            </div>
          )}
        </div>
      </section>

      {/* ---- capture controls ---- */}
      <section className="cam-card">
        <header className="cam-card-head">
          <h4>Capture</h4>
        </header>
        <div className="cam-row">
          {!recording ? (
            <button
              type="button"
              className="cam-btn cam-grow"
              disabled={!canCapture}
              onClick={startRecording}
              title="Start recording the live feed to a WebM clip"
            >
              ● Record
            </button>
          ) : (
            <button
              type="button"
              className="cam-btn danger cam-grow"
              onClick={stopRecording}
              title="Stop recording and download the clip"
            >
              ■ Stop ({fmtElapsed(recElapsed)})
            </button>
          )}
          <button
            type="button"
            className="cam-btn cam-grow"
            disabled={!canCapture}
            onClick={snapshot}
            title="Capture the current frame as a PNG and download it"
          >
            ⧉ Snapshot
          </button>
        </div>
      </section>

      {/* ---- timelapse ---- */}
      <section className="cam-card">
        <header className="cam-card-head">
          <h4>Timelapse</h4>
          {tlActive && (
            <span className="cam-raw" data-on={true}>
              {tlCount} frame{tlCount === 1 ? '' : 's'}
            </span>
          )}
        </header>
        <p className="cam-hint">
          Grab a frame every interval, play them back fast into one webm.
        </p>
        <div className="cam-field">
          <label htmlFor="cam-tl-interval">
            Interval
            <span className="cam-sub">seconds between captured frames</span>
          </label>
          <input
            id="cam-tl-interval"
            className="cam-input"
            type="text"
            inputMode="decimal"
            value={tlInterval}
            disabled={tlActive}
            onChange={(e) => setTlInterval(e.target.value)}
            aria-label="Timelapse interval (seconds)"
          />
          <span className="cam-units">s</span>
        </div>
        <div className="cam-field">
          <label htmlFor="cam-tl-fps">
            Playback FPS
            <span className="cam-sub">frames per second in the output video</span>
          </label>
          <input
            id="cam-tl-fps"
            className="cam-input"
            type="text"
            inputMode="numeric"
            value={tlFps}
            disabled={tlActive}
            onChange={(e) => setTlFps(e.target.value)}
            aria-label="Timelapse playback FPS"
          />
          <span className="cam-units">fps</span>
        </div>
        <div className="cam-row">
          {!tlActive ? (
            <button
              type="button"
              className="cam-btn cam-grow"
              disabled={!canCapture}
              onClick={startTimelapse}
              title="Start capturing a timelapse"
            >
              ◷ Start timelapse
            </button>
          ) : (
            <button
              type="button"
              className="cam-btn danger cam-grow"
              onClick={stopTimelapse}
              title="Stop the timelapse, assemble the webm and download it"
            >
              ■ Stop &amp; save ({tlCount})
            </button>
          )}
        </div>
      </section>

      {/* ---- recorded clips ---- */}
      <section className="cam-card">
        <header className="cam-card-head">
          <h4>Clips</h4>
          <span className="cam-raw">{clips.length}</span>
        </header>
        {clips.length === 0 ? (
          <p className="cam-hint">Recordings and timelapses you save show up here.</p>
        ) : (
          <ul className="cam-clips">
            {clips.map((c) => (
              <li key={c.id} className="cam-clip">
                <span className={`cam-clip-tag ${c.kind}`}>
                  {c.kind === 'rec' ? 'REC' : 'TL'}
                </span>
                <span className="cam-clip-name" title={c.name}>
                  {c.name}
                </span>
                <span className="cam-clip-size">{fmtBytes(c.bytes)}</span>
                <a
                  className="cam-btn cam-mini"
                  href={c.url}
                  download={c.name}
                  title={`Download ${c.name}`}
                >
                  ↓
                </a>
                <button
                  type="button"
                  className="cam-btn cam-mini"
                  onClick={() => removeClip(c.id)}
                  title="Remove from this list (does not delete a downloaded file)"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
