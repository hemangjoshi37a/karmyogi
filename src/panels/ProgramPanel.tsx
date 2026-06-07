import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import { useProgram, useMachine, useSettings } from '../store'
import { sectionColor } from '../viewer/sectionColors'
import { grbl } from '../serial/controller'
import { ProgramProgressBar } from '../components/ProgramProgressBar'
import { FrameButton } from '../components/FrameButton'
import { Icon } from '../components/Icons'
import {
  computeProgress,
  estimateProgramSeconds,
  formatDuration,
} from '../components/programWindow'
import { useT } from '../i18n'
import '../styles/program.css'

const ACCEPT = '.nc,.gcode,.tap,.txt,.cnc,.ngc'

/**
 * Program panel (W5): load a G-code program (button or drag-drop), edit it in an
 * editable monospace view, see a rough ETA, and stream it to the machine with
 * progress + pause/resume(merged toggle)/abort + a start/current-line field.
 *
 * Feed-from-line: the start-line field is a FULL-program 1-based line number.
 * On Stream we record that index and call `controller.startProgram(slice,
 * { startIndex })` so the streamer reports progress + current-line in
 * FULL-program indices — the progress bar and the highlighted read-view row
 * therefore always track the real line in the whole program, never the slice.
 */
export function ProgramPanel() {
  const t = useT()
  const name = useProgram((s) => s.name)
  const lines = useProgram((s) => s.lines)
  const sections = useProgram((s) => s.sections)
  const cursor = useProgram((s) => s.cursor)
  const streaming = useProgram((s) => s.streaming)
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const setSectionColor = useProgram((s) => s.setSectionColor)
  const clear = useProgram((s) => s.clear)
  const theme = useSettings((s) => s.theme)

  const connected = useMachine((s) => s.connection === 'connected')
  const machineState = useMachine((s) => s.state)
  const machineError = useMachine((s) => s.error)

  const fileRef = useRef<HTMLInputElement>(null)

  const [dragOver, setDragOver] = useState(false)

  // Start line to stream from (1-based, FULL-program index). Doubles as a live
  // "current line" readout while streaming. Default 1; clamped to 1..lines.length
  // on use. Reset back to 1 when a stream ends (streaming → false), so the next
  // run starts from the top unless the user picks a new line.
  const [startLine, setStartLine] = useState('1')

  // Which section cards are expanded (collapsed by default), keyed by id.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const toggleSection = useCallback((id: string) => {
    setOpenSections((m) => ({ ...m, [id]: !m[id] }))
  }, [])

  // While streaming, the start-line field becomes a live current-line readout
  // (1-based, full-program). The store's `cursor` is already a FULL-program
  // index (the streamer adds the startIndex), so cursor+1 is the line number.
  // When the stream ends (streaming flips false), reset the field back to 1.
  const prevStreaming = useRef(streaming)
  useEffect(() => {
    if (streaming) {
      setStartLine(String(cursor + 1))
    } else if (prevStreaming.current) {
      // Just finished/aborted → restore the default start line.
      setStartLine('1')
    }
    prevStreaming.current = streaming
  }, [streaming, cursor])

  const hasProgram = lines.length > 0
  const progress = computeProgress(cursor, lines.length)
  const held = machineState === 'Hold'

  // Rough ETA. Total when idle, remaining (× 1 − progress) while streaming.
  // ALWAYS rendered (shows an em-dash when there is no program / zero estimate)
  // so the layout never jumps as the program loads/empties.
  const totalSeconds = useMemo(() => estimateProgramSeconds(lines), [lines])
  const etaSeconds = streaming
    ? totalSeconds * Math.max(0, 1 - progress.fraction)
    : totalSeconds
  const etaLabel = hasProgram && etaSeconds > 0 ? formatDuration(etaSeconds) : null

  // Mid-program failure surfaced in-panel: the controller records the last error
  // on the machine store (e.g. "error on \"G1 …\": error:33"). Show it while the
  // machine is in an Alarm state or there's a recorded error during a run so the
  // operator isn't left guessing why a stream stopped.
  const showError =
    !!machineError && (machineState === 'Alarm' || held || streaming)

  async function loadFile(file: File) {
    const text = await file.text()
    setProgram(file.name, text)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void loadFile(file)
    // reset so picking the same file again re-fires change
    e.target.value = ''
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void loadFile(file)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!dragOver) setDragOver(true)
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // Only clear when leaving the panel (not entering a child).
    if (e.currentTarget === e.target) setDragOver(false)
  }

  // Resolve the clamped, FULL-program 1-based start line (1..lines.length).
  const startIndex1 = useMemo(() => {
    const n = parseInt(startLine, 10)
    if (!Number.isFinite(n)) return 1
    return Math.min(Math.max(1, n), Math.max(1, lines.length))
  }, [startLine, lines.length])

  function onStream() {
    if (!connected || !hasProgram) return
    // Stream the slice from the (clamped) start line, telling the streamer the
    // FULL-program offset of that slice so progress + current-line are reported
    // in full-program indices (startIndex + completed-within-slice).
    const startIndex0 = startIndex1 - 1
    grbl.startProgram(lines.slice(startIndex0), { startIndex: startIndex0 })
  }

  // Pause/Resume merged into ONE toggle: it pauses (feed hold) while running and
  // resumes when held. Disabled when not streaming.
  function onPauseResume() {
    if (held) grbl.resume()
    else grbl.feedHold()
  }

  // Destructive Clear asks for confirmation so a loaded program isn't lost on a
  // stray click.
  function onClear() {
    if (
      window.confirm(
        t(
          'prog.clearConfirm',
          'Clear the loaded program? This cannot be undone.',
        ),
      )
    ) {
      clear()
    }
  }

  // Confirm before removing a section (it discards that source's generated code).
  function onRemoveSection(sectionName: string) {
    if (
      window.confirm(
        t('prog.sectionDeleteConfirm', 'Delete the “{name}” section?', {
          name: sectionName,
        }),
      )
    ) {
      removeSection(sectionName)
    }
  }

  // Per-section G-code copy / download (moved here from the carving Output).
  function copySectionGcode(sec: { rawLines: string[] }) {
    const text = sec.rawLines.join('\n')
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => {})
    }
  }
  function downloadSectionGcode(sec: { name: string; rawLines: string[] }) {
    const text = sec.rawLines.join('\n')
    const base = (sec.name || 'program').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'program'
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${base}.nc`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const canStream = connected && hasProgram && !streaming

  return (
    <div
      className={'pp-panel' + (dragOver ? ' pp-dragover' : '')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {/* Masonry wrapper. With only the Run card here, it spans full width. */}
      <div className="pp-cols">
        {/* --- Run card (full-width): start/current line + transport + progress + ETA --- */}
        <section className="pp-card pp-run-card">
          <div className="pp-btnrow">
            <button
              className="pp-icon-btn pp-btn-reset"
              onClick={() => setStartLine('1')}
              disabled={streaming || !hasProgram}
              title={t(
                'prog.resetStartLine',
                'Reset start line to 1 (restart from the top)',
              )}
              aria-label={t('prog.resetStartLineAria', 'Reset start line to 1')}
            >
              ↺
            </button>
            <input
              className={
                'pp-line-input' + (streaming ? ' pp-line-input--readonly' : '')
              }
              type="number"
              min={1}
              max={lines.length || 1}
              value={startLine}
              onChange={(e) => setStartLine(e.target.value)}
              disabled={!hasProgram}
              readOnly={streaming}
              aria-readonly={streaming}
              aria-label={t('prog.startLineLabel', 'Start line / current line')}
              title={
                streaming
                  ? t('prog.currentLineHint', 'Current line being streamed')
                  : t(
                      'prog.startLineHint',
                      'Start line: Stream begins from this line (1-based)',
                    )
              }
            />
            {/* Frame (trace perimeter) — moved here from the carving Output. Uses
                the loaded program's XY bounds; options hidden (sane defaults). */}
            <FrameButton
              className="pp-frame"
              lines={lines}
              showOptions={false}
              label={t('prog.frame', 'Frame')}
            />
            <button
              className="pp-stream primary"
              onClick={onStream}
              disabled={!canStream}
              title={
                !connected
                  ? t('prog.streamHintConnect', 'Connect to the machine first')
                  : !hasProgram
                    ? t('prog.streamHintLoad', 'Load a program first')
                    : t(
                        'prog.streamHint',
                        'Start streaming the program from the start line',
                      )
              }
            >
              ▶ {t('prog.stream', 'Stream')}
            </button>
            {/* Merged Pause/Resume toggle: feed-hold while running, resume when held. */}
            <button
              className="pp-icon-btn"
              onClick={onPauseResume}
              disabled={!streaming}
              aria-pressed={held}
              title={
                held
                  ? t('prog.resume', 'Resume')
                  : t('prog.pause', 'Pause (feed hold)')
              }
              aria-label={
                held
                  ? t('prog.resume', 'Resume')
                  : t('prog.pauseAria', 'Pause')
              }
            >
              {held ? '⏵' : '⏸'}
            </button>
            <button
              className="pp-icon-btn pp-btn-abort"
              onClick={() => grbl.abortProgram()}
              disabled={!streaming}
              title={t('prog.abort', 'Abort (soft reset)')}
              aria-label={t('prog.abortAria', 'Abort')}
            >
              ⏹
            </button>
          </div>

          <div className="pp-progress-eta">
            <ProgramProgressBar
              progress={progress}
              color={held ? 'var(--warn)' : undefined}
            />
            <span
              className="pp-eta"
              title={
                streaming
                  ? t('prog.etaRemaining', 'Estimated time remaining')
                  : t('prog.etaTotal', 'Estimated total run time')
              }
            >
              <span className="pp-eta-icon" aria-hidden="true">
                ⏱
              </span>
              {etaLabel ? (
                <>
                  {streaming ? '' : '~'}
                  {etaLabel}
                </>
              ) : (
                <span className="pp-eta-empty" aria-hidden="true">
                  {t('common.emDash', '—')}
                </span>
              )}
            </span>
          </div>

          {/* Mid-program error / alarm surfaced in-panel. */}
          {showError && (
            <div className="pp-error" role="alert">
              <span className="pp-error-icon" aria-hidden="true">
                ⚠
              </span>
              <span className="pp-error-text">
                {machineState === 'Alarm'
                  ? t('prog.errorAlarm', 'Alarm: {msg}', { msg: machineError! })
                  : t('prog.errorRun', '{msg}', { msg: machineError! })}
              </span>
            </div>
          )}
        </section>
      </div>

      {/* --- Sections: one expandable/deletable card per source/tab. Each tab
              that generates G-code keeps its OWN section here; regenerating from
              a tab updates its section in place rather than clobbering others. --- */}
      {sections.length > 0 && (
        <section className="pp-card pp-sections-card">
          <div className="pp-sections-header">
            <span className="pp-section-title">
              {t('prog.sections', 'Sections')}
            </span>
            <span className="pp-meta">
              {sections.length === 1
                ? t('prog.sectionCountOne', '{count} section', {
                    count: sections.length,
                  })
                : t('prog.sectionCount', '{count} sections', {
                    count: sections.length,
                  })}
            </span>
          </div>
          <ul className="pp-section-list">
            {sections.map((sec, i) => {
              const open = !!openSections[sec.id]
              const count = sec.rawLines.length
              const color = sectionColor(i, theme === 'dark', sec.color)
              return (
                <li key={sec.id} className="pp-section">
                  <div className="pp-section-row">
                    <label
                      className="pp-section-color"
                      title={t('prog.sectionColor', 'Toolpath line colour in the 3D viewer')}
                      style={{ background: color }}
                    >
                      <input
                        type="color"
                        value={color}
                        onChange={(e) => setSectionColor(sec.id, e.target.value)}
                        aria-label={t('prog.sectionColorAria', 'Toolpath colour for section {name}', {
                          name: sec.name,
                        })}
                      />
                    </label>
                    <button
                      type="button"
                      className="pp-section-disclosure"
                      aria-expanded={open}
                      onClick={() => toggleSection(sec.id)}
                      title={
                        open
                          ? t('prog.sectionHide', 'Collapse section')
                          : t('prog.sectionShow', 'Expand section')
                      }
                    >
                      <span className="pp-disclosure-caret">
                        {open ? '▾' : '▸'}
                      </span>
                      <span className="pp-section-name" title={sec.name}>
                        {sec.name}
                      </span>
                      <span className="pp-meta pp-section-lines">
                        {count === 1
                          ? t('prog.lineCountOne', '{count} line', { count })
                          : t('prog.lineCount', '{count} lines', { count })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="pp-icon-btn pp-section-io"
                      onClick={() => copySectionGcode(sec)}
                      title={t('prog.sectionCopy', 'Copy this section’s G-code')}
                      aria-label={t('prog.sectionCopyAria', 'Copy G-code for {name}', { name: sec.name })}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                    <button
                      type="button"
                      className="pp-icon-btn pp-section-io"
                      onClick={() => downloadSectionGcode(sec)}
                      title={t('prog.sectionDownload', 'Download this section’s G-code (.nc)')}
                      aria-label={t('prog.sectionDownloadAria', 'Download G-code for {name}', { name: sec.name })}
                    >
                      <Icon name="download" size={14} />
                    </button>
                    <button
                      className="pp-icon-btn pp-btn-clear"
                      onClick={() => onRemoveSection(sec.name)}
                      disabled={streaming}
                      title={t('prog.sectionDelete', 'Delete this section')}
                      aria-label={t(
                        'prog.sectionDeleteAria',
                        'Delete section {name}',
                        { name: sec.name },
                      )}
                    >
                      🗑
                    </button>
                  </div>
                  {open && (
                    <pre className="pp-section-body">
                      {sec.rawLines.join('\n')}
                    </pre>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* --- Program file: name + Load / Clear. The line-by-line read view and
              the text editor were removed — the Sections list above is the single
              representation of the program (view its lines by expanding a section,
              copy/download/delete per section). --- */}
      <section className="pp-card pp-text-card">
        <div className="pp-text-header">
          <span className="pp-section-title">
            {t('prog.programFile', 'Program')}
            <span className="pp-meta pp-text-count">
              {' '}
              (
              {lines.length === 1
                ? t('prog.lineCountOne', '{count} line', { count: lines.length })
                : t('prog.lineCount', '{count} lines', { count: lines.length })}
              )
            </span>
          </span>
          {name && (
            <span className="pp-name" title={name}>
              {name}
            </span>
          )}
          <div className="pp-file-actions">
            <button
              className="pp-icon-btn"
              onClick={() => fileRef.current?.click()}
              disabled={streaming}
              title={t(
                'prog.loadHint',
                'Load a .nc / .gcode / .tap / .ngc file (or drag & drop)',
              )}
              aria-label={t('prog.loadFile', 'Load file')}
            >
              ⬆
            </button>
            {hasProgram && (
              <button
                className="pp-icon-btn pp-btn-clear"
                onClick={onClear}
                disabled={streaming}
                title={t('prog.clear', 'Clear / unload program')}
                aria-label={t('prog.clearAria', 'Clear program')}
              >
                🗑
              </button>
            )}
          </div>
        </div>
        <input
          ref={fileRef}
          className="pp-load-input"
          type="file"
          accept={ACCEPT}
          onChange={onFileChange}
        />
      </section>
    </div>
  )
}
