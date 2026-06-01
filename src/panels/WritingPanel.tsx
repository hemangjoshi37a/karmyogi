import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Polyline } from '../core/geometry'
import { Toolpath } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import { StrokeFont, TextAlign } from '../core/strokeFont'
import { useProgram, useMachine, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import '../styles/writing.css'

/** Split G-code into non-empty lines for streaming to the controller. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

const ALIGN_OPTIONS: { value: TextAlign; label: string }[] = [
  { value: TextAlign.Left, label: 'Left' },
  { value: TextAlign.Center, label: 'Center' },
  { value: TextAlign.Right, label: 'Right' },
]

/**
 * Build pen-mode G-code from laid-out stroke polylines. Each stroke becomes a
 * rapid (pen up) to its start, then feed moves (pen down) along its points. The
 * emitter maps Rapid->penUpZ and Feed->penDownZ in ZMode.Pen, so Z values here
 * are placeholders (0). origin offsets the whole layout in XY.
 */
function strokesToGcode(
  strokes: Polyline[],
  origin: { x: number; y: number },
  pen: { penUpZ: number; penDownZ: number; feedXY: number },
): string {
  const tp = new Toolpath()
  tp.name = 'Writing'
  for (const pl of strokes) {
    if (pl.points.length < 2) continue
    const first = pl.points[0]
    tp.rapid({ x: first.x + origin.x, y: first.y + origin.y, z: 0 })
    for (let i = 1; i < pl.points.length; i++) {
      const p = pl.points[i]
      tp.feed({ x: p.x + origin.x, y: p.y + origin.y, z: 0 })
    }
  }

  const emitter = new GcodeEmitter({
    programName: 'Writing',
    zMode: ZMode.Pen,
    penUpZ: pen.penUpZ,
    penDownZ: pen.penDownZ,
    safeZ: pen.penUpZ,
    useSpindle: false,
    feedXY: pen.feedXY,
  })
  return emitter.emitProgram(tp)
}

/**
 * Writing / Pen-plotter panel. Type text, lay it out with a single-stroke
 * vector font (built-in Hershey simplex, or a custom JSON font from the Qt
 * handwriting pipeline), and generate pen-mode G-code (Z = pen up/down) that is
 * pushed to the program store for 3D preview + streaming.
 */
export function WritingPanel() {
  const setProgram = useProgram((s) => s.setProgram)
  const connected = useMachine((s) => s.connection === 'connected')

  const [text, setText] = usePersistentState('karmyogi.writing.text', 'Hello\nWorld 123')
  const [charHeight, setCharHeight] = usePersistentState('karmyogi.writing.charHeight', 10)
  const [lineSpacing, setLineSpacing] = usePersistentState('karmyogi.writing.lineSpacing', 1.5)
  const [letterSpacing, setLetterSpacing] = usePersistentState('karmyogi.writing.letterSpacing', 1)
  const [originX, setOriginX] = usePersistentState('karmyogi.writing.originX', 0)
  const [originY, setOriginY] = usePersistentState('karmyogi.writing.originY', 0)
  const [align, setAlign] = usePersistentState<TextAlign>('karmyogi.writing.align', TextAlign.Left)
  const [penUpZ, setPenUpZ] = usePersistentState('karmyogi.writing.penUpZ', 5)
  const [penDownZ, setPenDownZ] = usePersistentState('karmyogi.writing.penDownZ', 0)
  const [feed, setFeed] = usePersistentState('karmyogi.writing.feed', 1500)
  const [showAdvanced, setShowAdvanced] = usePersistentState('karmyogi.writing.showAdvanced', false)
  const [showRaw, setShowRaw] = usePersistentState('karmyogi.writing.showRaw', false)

  // The active font lives in component state; default is the built-in font.
  const [font, setFont] = useState<StrokeFont>(() => StrokeFont.builtin())
  const [fontName, setFontName] = useState('Built-in')
  const [info, setInfo] = useState('Type text — G-code regenerates automatically.')
  const [preview, setPreview] = useState('')
  const previewRef = useRef('')
  const fileRef = useRef<HTMLInputElement>(null)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Distinct characters in the text that the active font cannot render.
  const missing = useMemo(() => font.missingGlyphs(text), [font, text])

  const generate = useCallback((): string => {
    if (text.trim().length === 0) {
      setInfo('Enter some text first.')
      setPreview('')
      previewRef.current = ''
      return ''
    }
    const strokes = font.layout(text, {
      charHeightMm: charHeight,
      lineSpacingFactor: lineSpacing,
      letterSpacingMm: letterSpacing,
      align,
    })
    if (strokes.length === 0) {
      setInfo('Nothing to draw (no renderable glyphs).')
      setPreview('')
      previewRef.current = ''
      return ''
    }

    const gcode = strokesToGcode(
      strokes,
      { x: originX, y: originY },
      { penUpZ, penDownZ, feedXY: feed },
    )
    setProgram('text — pen', gcode)
    setPreview(gcode)
    previewRef.current = gcode

    const lineCount = text.split('\n').length
    let msg = `${strokes.length} pen stroke(s), ${lineCount} line(s) → Visualizer.`
    if (missing.length > 0) msg += ` ${missing.length} character(s) missing from "${fontName}".`
    setInfo(msg)
    return gcode
  }, [
    text, font, charHeight, lineSpacing, letterSpacing, align,
    originX, originY, penUpZ, penDownZ, feed, missing, fontName, setProgram,
  ])

  // Live G-code: always regenerate ~300ms after the last change and push to the
  // program store so the Visualizer updates without a manual Generate step.
  useEffect(() => {
    if (text.trim().length === 0) return
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => generate(), 300)
    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current)
    }
  }, [generate, text])

  // Stream the (freshly-generated) program to the machine.
  const play = useCallback(() => {
    const gcode = previewRef.current || generate()
    const lines = gcodeLines(gcode)
    if (lines.length === 0 || !connected) return
    grbl.startProgram(lines)
  }, [generate, connected])

  const loadFont = useCallback(async (file: File) => {
    try {
      const json = await file.text()
      const loaded = StrokeFont.fromJson(json)
      setFont(loaded)
      setFontName(loaded.name())
      setInfo(`Loaded custom font "${loaded.name()}" (${loaded.glyphCount()} glyphs).`)
    } catch (e) {
      setInfo(`Failed to load font: ${(e as Error).message}`)
    }
  }, [])

  const useBuiltin = useCallback(() => {
    setFont(StrokeFont.builtin())
    setFontName('Built-in')
    setInfo('Using built-in font.')
    if (fileRef.current) fileRef.current.value = ''
  }, [])

  return (
    <div className="wr-panel">
      <div className="wr-scroll">
        <p className="wr-intro">
          Type text → it previews live in the Visualizer → press Send ▶. Rendered as a
          single-stroke vector font in pen-plotter G-code (Z = pen up / down).
        </p>

        {/* ---- Text ---- */}
        <section className="wr-card">
          <h3>Text</h3>
          <div className="wr-card-body">
            <textarea
              className="wr-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type here. Use Enter for a new line."
              title="Text to plot. Press Enter for a new line."
              rows={3}
              spellCheck={false}
            />
          </div>
        </section>

        {/* ---- Essentials: size, alignment, pen Z, feed ---- */}
        <section className="wr-card">
          <h3>Pen &amp; Layout</h3>
          <div className="wr-card-body">
            <div className="wr-grid">
              <label className="wr-field" title="Cap height of the text in millimetres.">
                <span>Char height</span>
                <span className="wr-input">
                  <input type="number" inputMode="decimal" min={0.5} step={0.5} value={charHeight}
                    onChange={(e) => setCharHeight(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="wr-field" title="Horizontal alignment of each line of text.">
                <span>Alignment</span>
                <select value={align} onChange={(e) => setAlign(Number(e.target.value) as TextAlign)}>
                  {ALIGN_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label className="wr-field" title="Z height when the pen is lifted for travel moves (safe-Z).">
                <span>Pen up Z</span>
                <span className="wr-input">
                  <input type="number" inputMode="decimal" step={0.5} value={penUpZ}
                    onChange={(e) => setPenUpZ(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="wr-field" title="Z height when the pen is down and drawing.">
                <span>Pen down Z</span>
                <span className="wr-input">
                  <input type="number" inputMode="decimal" step={0.5} value={penDownZ}
                    onChange={(e) => setPenDownZ(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="wr-field" title="Drawing (pen-down) feed rate in mm per minute.">
                <span>Feed</span>
                <span className="wr-input">
                  <input type="number" inputMode="decimal" min={1} step={50} value={feed}
                    onChange={(e) => setFeed(Number(e.target.value))} />
                  <em>mm/min</em>
                </span>
              </label>
            </div>
          </div>
        </section>

        {/* ---- Advanced (collapsed by default) ---- */}
        <section className={'wr-card wr-collapsible' + (showAdvanced ? ' is-open' : '')}>
          <h3>
            <button
              type="button"
              className="wr-toggle"
              onClick={() => setShowAdvanced(!showAdvanced)}
              aria-expanded={showAdvanced}
            >
              <span className="wr-caret">{showAdvanced ? '▾' : '▸'}</span>
              Advanced
              <span className="wr-toggle-note">spacing &amp; origin</span>
            </button>
          </h3>
          {showAdvanced && (
            <div className="wr-card-body">
              <div className="wr-grid">
                <label className="wr-field" title="Baseline-to-baseline distance as a multiple of char height.">
                  <span>Line spacing</span>
                  <span className="wr-input">
                    <input type="number" inputMode="decimal" min={0.5} step={0.1} value={lineSpacing}
                      onChange={(e) => setLineSpacing(Number(e.target.value))} />
                    <em>×</em>
                  </span>
                </label>
                <label className="wr-field" title="Extra gap added after each character, in millimetres.">
                  <span>Letter spacing</span>
                  <span className="wr-input">
                    <input type="number" inputMode="decimal" min={0} step={0.5} value={letterSpacing}
                      onChange={(e) => setLetterSpacing(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
                <label className="wr-field" title="Shift the whole text block along X, in millimetres.">
                  <span>Origin X</span>
                  <span className="wr-input">
                    <input type="number" inputMode="decimal" step={1} value={originX}
                      onChange={(e) => setOriginX(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
                <label className="wr-field" title="Shift the whole text block along Y, in millimetres.">
                  <span>Origin Y</span>
                  <span className="wr-input">
                    <input type="number" inputMode="decimal" step={1} value={originY}
                      onChange={(e) => setOriginY(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
              </div>
            </div>
          )}
        </section>

        {/* ---- Font ---- */}
        <section className="wr-card">
          <h3>Font</h3>
          <div className="wr-card-body">
            <div className="wr-font-row">
              <button type="button" className="wr-btn" onClick={() => fileRef.current?.click()}
                title="Load a custom single-stroke font JSON (from the handwriting pipeline).">
                Load font JSON…
              </button>
              <button type="button" className="wr-btn" onClick={useBuiltin} disabled={fontName === 'Built-in'}
                title="Switch back to the built-in Hershey simplex font.">
                Use built-in
              </button>
              <span className="wr-font-name" title={`Active font: ${fontName}`}>
                Active: <strong>{fontName}</strong>
              </span>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="wr-file"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void loadFont(f)
                }}
              />
            </div>
            {missing.length > 0 && (
              <p className="wr-warn" role="status">
                Missing glyph{missing.length > 1 ? 's' : ''}: {missing.map((c) => (c === ' ' ? '␣' : c)).join(' ')}
                {' '}— rendered as blank space.
              </p>
            )}
          </div>
        </section>

        {/* ---- Send ---- */}
        <section className="wr-card">
          <h3>Send</h3>
          <div className="wr-card-body">
            <div className="wr-actions">
              <button
                type="button"
                className="wr-btn primary wr-play"
                onClick={play}
                disabled={!connected || preview.length === 0}
                title={connected ? 'Stream this program to the machine' : 'Connect to a machine to send'}
              >
                ▶ Send to machine
              </button>
              <button
                type="button"
                className="wr-btn wr-regen"
                onClick={generate}
                title="Regenerate G-code now"
              >
                ↻
              </button>
            </div>
            {!connected && preview.length > 0 && (
              <p className="wr-info">Preview is live; connect to a machine to send.</p>
            )}
            <p className="wr-info">{info}</p>
          </div>
        </section>

        {/* ---- Raw G-code (collapsed by default) ---- */}
        <section className={'wr-card wr-collapsible' + (showRaw ? ' is-open wr-grow' : '')}>
          <h3>
            <button
              type="button"
              className="wr-toggle"
              onClick={() => setShowRaw(!showRaw)}
              aria-expanded={showRaw}
            >
              <span className="wr-caret">{showRaw ? '▾' : '▸'}</span>
              Raw G-code
              {preview.length > 0 && (
                <span className="wr-toggle-note">{gcodeLines(preview).length} lines</span>
              )}
            </button>
          </h3>
          {showRaw && (
            <div className="wr-card-body">
              <textarea
                className="wr-preview"
                readOnly
                value={preview}
                placeholder="Generated G-code preview will appear here."
                spellCheck={false}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
