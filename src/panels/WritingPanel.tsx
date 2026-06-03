import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Polyline } from '../core/geometry'
import { Toolpath } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import { StrokeFont, TextAlign } from '../core/strokeFont'
import { useProgram, useMachine, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import { useT } from '../i18n'
import '../styles/writing.css'

/** Split G-code into non-empty lines for streaming to the controller. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

const ALIGN_OPTIONS: { value: TextAlign; key: string; label: string }[] = [
  { value: TextAlign.Left, key: 'writing.align.left', label: 'Left' },
  { value: TextAlign.Center, key: 'writing.align.center', label: 'Center' },
  { value: TextAlign.Right, key: 'writing.align.right', label: 'Right' },
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
  const t = useT()
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
  const [info, setInfo] = useState(() =>
    t('writing.info.autoRegen', 'Type text — G-code regenerates automatically.'),
  )
  const [preview, setPreview] = useState('')
  const previewRef = useRef('')
  const fileRef = useRef<HTMLInputElement>(null)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Distinct characters in the text that the active font cannot render.
  const missing = useMemo(() => font.missingGlyphs(text), [font, text])

  const generate = useCallback((): string => {
    if (text.trim().length === 0) {
      setInfo(t('writing.info.enterText', 'Enter some text first.'))
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
      setInfo(t('writing.info.nothingToDraw', 'Nothing to draw (no renderable glyphs).'))
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
    let msg = t(
      'writing.info.generated',
      '{strokes} pen stroke(s), {lines} line(s) → Visualizer.',
      { strokes: strokes.length, lines: lineCount },
    )
    if (missing.length > 0)
      msg +=
        ' ' +
        t('writing.info.missingChars', '{count} character(s) missing from "{font}".', {
          count: missing.length,
          font: fontName,
        })
    setInfo(msg)
    return gcode
  }, [
    t, text, font, charHeight, lineSpacing, letterSpacing, align,
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
      setInfo(
        t('writing.info.fontLoaded', 'Loaded custom font "{name}" ({count} glyphs).', {
          name: loaded.name(),
          count: loaded.glyphCount(),
        }),
      )
    } catch (e) {
      setInfo(
        t('writing.info.fontFailed', 'Failed to load font: {error}', {
          error: (e as Error).message,
        }),
      )
    }
  }, [t])

  const useBuiltin = useCallback(() => {
    setFont(StrokeFont.builtin())
    setFontName('Built-in')
    setInfo(t('writing.info.usingBuiltin', 'Using built-in font.'))
    if (fileRef.current) fileRef.current.value = ''
  }, [t])

  return (
    <div className="wr-panel">
      <div className="wr-scroll">
        <p className="wr-intro">
          {t(
            'writing.intro',
            'Type text → it previews live in the Visualizer → press Send ▶. Rendered as a single-stroke vector font in pen-plotter G-code (Z = pen up / down).',
          )}
        </p>

        {/* ---- Text ---- */}
        <section className="wr-card">
          <h3>{t('writing.text.title', 'Text')}</h3>
          <div className="wr-card-body">
            <textarea
              className="wr-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('writing.text.placeholder', 'Type here. Use Enter for a new line.')}
              title={t('writing.text.title.tip', 'Text to plot. Press Enter for a new line.')}
              rows={3}
              spellCheck={false}
            />
          </div>
        </section>

        {/* ---- Essentials: size, alignment, pen Z, feed ---- */}
        <section className="wr-card">
          <h3>{t('writing.penLayout.title', 'Pen & Layout')}</h3>
          <div className="wr-card-body">
            <div className="wr-grid">
              <label className="wr-field" title={t('writing.charHeight.tip', 'Cap height of the text in millimetres.')}>
                <span>{t('writing.charHeight', 'Char height')}</span>
                <span className="wr-input">
                  <input type="number" inputMode="decimal" min={0.5} step={0.5} value={charHeight}
                    onChange={(e) => setCharHeight(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="wr-field" title={t('writing.alignment.tip', 'Horizontal alignment of each line of text.')}>
                <span>{t('writing.alignment', 'Alignment')}</span>
                <select value={align} onChange={(e) => setAlign(Number(e.target.value) as TextAlign)}>
                  {ALIGN_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{t(o.key, o.label)}</option>
                  ))}
                </select>
              </label>
              <label className="wr-field" title={t('writing.penUpZ.tip', 'Z height when the pen is lifted for travel moves (safe-Z).')}>
                <span>{t('writing.penUpZ', 'Pen up Z')}</span>
                <span className="wr-input">
                  <input type="number" inputMode="decimal" step={0.5} value={penUpZ}
                    onChange={(e) => setPenUpZ(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="wr-field" title={t('writing.penDownZ.tip', 'Z height when the pen is down and drawing.')}>
                <span>{t('writing.penDownZ', 'Pen down Z')}</span>
                <span className="wr-input">
                  <input type="number" inputMode="decimal" step={0.5} value={penDownZ}
                    onChange={(e) => setPenDownZ(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="wr-field" title={t('writing.feed.tip', 'Drawing (pen-down) feed rate in mm per minute.')}>
                <span>{t('writing.feed', 'Feed')}</span>
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
              {t('writing.advanced', 'Advanced')}
              <span className="wr-toggle-note">{t('writing.advanced.note', 'spacing & origin')}</span>
            </button>
          </h3>
          {showAdvanced && (
            <div className="wr-card-body">
              <div className="wr-grid">
                <label className="wr-field" title={t('writing.lineSpacing.tip', 'Baseline-to-baseline distance as a multiple of char height.')}>
                  <span>{t('writing.lineSpacing', 'Line spacing')}</span>
                  <span className="wr-input">
                    <input type="number" inputMode="decimal" min={0.5} step={0.1} value={lineSpacing}
                      onChange={(e) => setLineSpacing(Number(e.target.value))} />
                    <em>×</em>
                  </span>
                </label>
                <label className="wr-field" title={t('writing.letterSpacing.tip', 'Extra gap added after each character, in millimetres.')}>
                  <span>{t('writing.letterSpacing', 'Letter spacing')}</span>
                  <span className="wr-input">
                    <input type="number" inputMode="decimal" min={0} step={0.5} value={letterSpacing}
                      onChange={(e) => setLetterSpacing(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
                <label className="wr-field" title={t('writing.originX.tip', 'Shift the whole text block along X, in millimetres.')}>
                  <span>{t('writing.originX', 'Origin X')}</span>
                  <span className="wr-input">
                    <input type="number" inputMode="decimal" step={1} value={originX}
                      onChange={(e) => setOriginX(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
                <label className="wr-field" title={t('writing.originY.tip', 'Shift the whole text block along Y, in millimetres.')}>
                  <span>{t('writing.originY', 'Origin Y')}</span>
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
          <h3>{t('writing.font.title', 'Font')}</h3>
          <div className="wr-card-body">
            <div className="wr-font-row">
              <button type="button" className="wr-btn" onClick={() => fileRef.current?.click()}
                title={t('writing.font.loadTip', 'Load a custom single-stroke font JSON (from the handwriting pipeline).')}>
                {t('writing.font.load', 'Load font JSON…')}
              </button>
              <button type="button" className="wr-btn" onClick={useBuiltin} disabled={fontName === 'Built-in'}
                title={t('writing.font.builtinTip', 'Switch back to the built-in Hershey simplex font.')}>
                {t('writing.font.useBuiltin', 'Use built-in')}
              </button>
              <span className="wr-font-name" title={t('writing.font.active', 'Active font: {name}', { name: fontName })}>
                {t('writing.font.activeLabel', 'Active:')} <strong>{fontName}</strong>
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
                {t('writing.missingGlyphs', 'Missing glyph(s): {glyphs} — rendered as blank space.', {
                  glyphs: missing.map((c) => (c === ' ' ? '␣' : c)).join(' '),
                })}
              </p>
            )}
          </div>
        </section>

        {/* ---- Send ---- */}
        <section className="wr-card">
          <h3>{t('writing.send.title', 'Send')}</h3>
          <div className="wr-card-body">
            <div className="wr-actions">
              <button
                type="button"
                className="wr-btn primary wr-play"
                onClick={play}
                disabled={!connected || preview.length === 0}
                title={connected
                  ? t('writing.send.streamTip', 'Stream this program to the machine')
                  : t('writing.send.connectTip', 'Connect to a machine to send')}
              >
                {t('writing.send.btn', '▶ Send to machine')}
              </button>
              <button
                type="button"
                className="wr-btn wr-regen"
                onClick={generate}
                title={t('writing.send.regenTip', 'Regenerate G-code now')}
              >
                ↻
              </button>
            </div>
            {!connected && preview.length > 0 && (
              <p className="wr-info">{t('writing.send.previewLive', 'Preview is live; connect to a machine to send.')}</p>
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
              {t('writing.raw.title', 'Raw G-code')}
              {preview.length > 0 && (
                <span className="wr-toggle-note">
                  {t('writing.raw.lines', '{count} lines', { count: gcodeLines(preview).length })}
                </span>
              )}
            </button>
          </h3>
          {showRaw && (
            <div className="wr-card-body">
              <textarea
                className="wr-preview"
                readOnly
                value={preview}
                placeholder={t('writing.raw.placeholder', 'Generated G-code preview will appear here.')}
                spellCheck={false}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
