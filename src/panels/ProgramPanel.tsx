import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import { useProgram, useMachine, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import { ProgramProgressBar } from '../components/ProgramProgressBar'
import {
  computeProgress,
  estimateProgramSeconds,
  formatDuration,
} from '../components/programWindow'
import '../styles/program.css'

const ACCEPT = '.nc,.gcode,.tap,.txt,.cnc,.ngc'

/**
 * Program panel (W5): load a G-code program (button or drag-drop), edit it in an
 * editable monospace view, see a rough ETA, and stream it to the machine with
 * progress + pause/resume/abort + a start/current-line field.
 *
 * Two cards: a full-width Run card (start-line input + 4 transport buttons +
 * progress + ETA) and a Program-text card (editable / collapsible / resizable,
 * with Load + Clear in its header).
 */
export function ProgramPanel() {
  const name = useProgram((s) => s.name)
  const lines = useProgram((s) => s.lines)
  const cursor = useProgram((s) => s.cursor)
  const streaming = useProgram((s) => s.streaming)
  const setProgram = useProgram((s) => s.setProgram)
  const clear = useProgram((s) => s.clear)

  const connected = useMachine((s) => s.connection === 'connected')
  const machineState = useMachine((s) => s.state)

  const fileRef = useRef<HTMLInputElement>(null)

  const [dragOver, setDragOver] = useState(false)
  const [textOpen, setTextOpen] = usePersistentState<boolean>(
    'karmyogi.program.textOpen',
    true,
  )
  const [editorH, setEditorH] = usePersistentState<number>(
    'karmyogi.program.editorH',
    260,
  )

  // Start line to stream from (1-based). Doubles as a live "current line"
  // readout while streaming. Default 1; clamped to 1..lines.length on use.
  const [startLine, setStartLine] = useState('1')

  // Local editable buffer for the program text. Kept in sync with the store
  // when the program changes from outside (load, clear), but the textarea is the
  // source of truth while the user types; we push back to the store on blur.
  const [draft, setDraft] = useState<string>(() => lines.join('\n'))
  const storeText = useMemo(() => lines.join('\n'), [lines])
  useEffect(() => {
    // Re-sync the editor when the program is replaced from outside (load/clear),
    // but never clobber the user's in-progress edits.
    setDraft(storeText)
  }, [storeText])

  // While streaming, the start-line field becomes a live current-line readout
  // (1-based) that tracks the program cursor.
  useEffect(() => {
    if (streaming) setStartLine(String(cursor + 1))
  }, [streaming, cursor])

  const hasProgram = lines.length > 0
  const progress = computeProgress(cursor, lines.length)
  const held = machineState === 'Hold'

  // Rough ETA. Total when idle, remaining (× 1 − progress) while streaming.
  const totalSeconds = useMemo(() => estimateProgramSeconds(lines), [lines])
  const etaSeconds = streaming
    ? totalSeconds * Math.max(0, 1 - progress.fraction)
    : totalSeconds
  const etaLabel = hasProgram ? formatDuration(etaSeconds) : null

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

  // Commit edits back to the store (re-splits lines). Called on blur so we don't
  // thrash the store on every keystroke.
  const commitDraft = useCallback(() => {
    if (streaming) return
    if (draft === storeText) return
    setProgram(name ?? 'untitled', draft)
  }, [draft, storeText, name, streaming, setProgram])

  // Persist the editor height after the user drags the textarea's resize grip.
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const onEditorMouseUp = useCallback(() => {
    const h = editorRef.current?.offsetHeight
    if (h && Math.abs(h - editorH) > 1) setEditorH(h)
  }, [editorH, setEditorH])

  function onStream() {
    if (!connected || !hasProgram) return
    // Clamp the typed start line to 1..lines.length and stream from there.
    const n = parseInt(startLine, 10)
    const start = Number.isFinite(n) ? Math.min(Math.max(1, n), lines.length) : 1
    grbl.startProgram(lines.slice(start - 1))
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
            <input
              className="pp-line-input"
              type="number"
              min={1}
              max={lines.length || 1}
              value={startLine}
              onChange={(e) => setStartLine(e.target.value)}
              disabled={!hasProgram}
              readOnly={streaming}
              aria-label="Start line / current line"
              title={
                streaming
                  ? 'Current line being streamed'
                  : 'Start line: Stream begins from this line (1-based)'
              }
            />
            <button
              className="pp-stream primary"
              onClick={onStream}
              disabled={!canStream}
              title={
                !connected
                  ? 'Connect to the machine first'
                  : !hasProgram
                    ? 'Load a program first'
                    : 'Start streaming the program from the start line'
              }
            >
              ▶ Stream
            </button>
            <button
              className="pp-icon-btn"
              onClick={() => grbl.feedHold()}
              disabled={!streaming || held}
              title="Pause (feed hold)"
              aria-label="Pause"
            >
              ⏸
            </button>
            <button
              className="pp-icon-btn"
              onClick={() => grbl.resume()}
              disabled={!streaming || !held}
              title="Resume"
              aria-label="Resume"
            >
              ⏵
            </button>
            <button
              className="pp-icon-btn pp-btn-abort"
              onClick={() => grbl.abortProgram()}
              disabled={!streaming}
              title="Abort (soft reset)"
              aria-label="Abort"
            >
              ⏹
            </button>
          </div>

          <div className="pp-progress-eta">
            <ProgramProgressBar
              progress={progress}
              color={held ? 'var(--warn)' : undefined}
            />
            {etaLabel && (
              <span
                className="pp-eta"
                title={
                  streaming
                    ? 'Estimated time remaining'
                    : 'Estimated total run time'
                }
              >
                <span className="pp-eta-icon" aria-hidden="true">
                  ⏱
                </span>
                {streaming ? '' : '~'}
                {etaLabel}
              </span>
            )}
          </div>
        </section>
      </div>

      {/* --- Program text: editable, collapsible, resizable, scrollable.
              Load + Clear live in the header row, right-aligned. --- */}
      <section className="pp-card pp-text-card">
        <div className="pp-text-header">
          <button
            type="button"
            className="pp-disclosure"
            aria-expanded={textOpen}
            onClick={() => setTextOpen((v) => !v)}
            title={textOpen ? 'Hide program text editor' : 'Show program text editor'}
          >
            <span className="pp-disclosure-caret">{textOpen ? '▾' : '▸'}</span>
            Program text
            <span className="pp-meta pp-text-count">
              ({lines.length} {lines.length === 1 ? 'line' : 'lines'})
            </span>
          </button>
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
              title="Load a .nc / .gcode / .tap / .ngc file (or drag &amp; drop)"
              aria-label="Load file"
            >
              ⬆
            </button>
            {hasProgram && (
              <button
                className="pp-icon-btn pp-btn-clear"
                onClick={() => clear()}
                disabled={streaming}
                title="Clear / unload program"
                aria-label="Clear program"
              >
                🗑
              </button>
            )}
          </div>
        </div>
        {textOpen && (
          <textarea
            ref={editorRef}
            className="pp-editor"
            style={{ height: editorH }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onMouseUp={onEditorMouseUp}
            readOnly={streaming}
            spellCheck={false}
            wrap="off"
            placeholder="No program loaded. Drag &amp; drop or ⬆ a .nc / .gcode file, or type / paste G-code here."
            aria-label="Editable G-code program text"
            title={
              streaming
                ? 'Editing is disabled while streaming'
                : 'Edit G-code; changes apply when you click away'
            }
          />
        )}
        {streaming && textOpen && (
          <span className="pp-hint">Read-only while streaming.</span>
        )}
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
