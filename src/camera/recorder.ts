/**
 * Thin MediaRecorder wrapper used by the Camera panel's AUTO-record feature
 * (record while the machine streams a program). UI-independent — no React/DOM
 * beyond the MediaRecorder/Blob APIs — so the panel stays focused on rendering.
 *
 * The browser-wide capture machinery (manual Record / Timelapse) lives inline in
 * CameraPanel; this module only owns the auto-record session so its start/stop +
 * blob-assembly logic is isolated and testable by exercising the running app.
 */

/** Pick a supported webm mime type for MediaRecorder, falling back gracefully. */
export function pickRecorderMime(): string | undefined {
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

/** Is MediaRecorder available in this browser at all? */
export function recorderSupported(): boolean {
  return typeof MediaRecorder !== 'undefined'
}

/** The finished recording handed back to the caller when a session stops. */
export interface RecordingResult {
  blob: Blob
  /** MIME the recorder actually produced (used to pick a file extension). */
  mimeType: string
  /** Recording wall-clock duration in milliseconds. */
  durationMs: number
}

/**
 * An in-flight auto-record session. Call {@link RecordingSession.stop} to finish;
 * the returned promise resolves with the assembled blob (or rejects if nothing
 * was captured). The session collects chunks internally so the caller only ever
 * deals with the final blob.
 */
export interface RecordingSession {
  /** Stop recording; resolves once the final blob is assembled. */
  stop: () => Promise<RecordingResult>
  /** Current recorder state, for live UI (e.g. "recording" indicator). */
  isRecording: () => boolean
}

/**
 * Begin recording `stream` to a single blob. Throws synchronously if recording
 * is unsupported or the recorder can't be constructed for this stream — the
 * caller surfaces that to the user. The session resolves with the assembled blob
 * when {@link RecordingSession.stop} is called.
 */
export function startRecordingSession(stream: MediaStream): RecordingSession {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser.')
  }
  const mime = pickRecorderMime()
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)

  const chunks: Blob[] = []
  rec.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data)
  }

  const startedAt = Date.now()
  // Timeslice so long recordings flush chunks periodically (avoids one giant
  // buffer and gives data even if the page is closing).
  rec.start(1000)

  let stopPromise: Promise<RecordingResult> | null = null

  const stop = (): Promise<RecordingResult> => {
    if (stopPromise) return stopPromise
    stopPromise = new Promise<RecordingResult>((resolve) => {
      const finalize = () => {
        const mimeType = rec.mimeType || mime || 'video/webm'
        const blob = new Blob(chunks, { type: mimeType })
        resolve({ blob, mimeType, durationMs: Date.now() - startedAt })
      }
      if (rec.state === 'inactive') {
        finalize()
        return
      }
      rec.onstop = finalize
      try {
        rec.stop()
      } catch {
        finalize()
      }
    })
    return stopPromise
  }

  return {
    stop,
    isRecording: () => rec.state === 'recording',
  }
}
