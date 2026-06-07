import { useRef } from 'react'
import { useT } from '../i18n'
import { Icon } from './Icons'
import '../styles/saveload.css'

/**
 * Reusable Save / Load pair for a tab's user-authored data (points, shapes,
 * params…). Mirrors the Soldering tab's CSV save/load, generalised:
 *
 *  • Save  — downloads the current `value` as PLAIN, human-readable JSON text
 *    with the tab's own extension (e.g. `glue-drawing.kglue`). The files are
 *    deliberately text-based, uncompiled and unencrypted so they can be diffed,
 *    edited by hand, and shared.
 *  • Load  — opens a file picker (accepting that extension or any .json/.txt),
 *    parses the JSON, and hands the value back via `onLoad`.
 *
 * Content is JSON regardless of the extension, so a `.kglue`/`.kweld`/… file is
 * just JSON a human can read. Parse failures call `onError` (or are ignored).
 *
 * All user-visible strings (button titles AND the internal parse/read-error
 * messages) are localized via i18n with English fallbacks, so panels stop
 * leaking English. Callers may still override `saveTitle`/`loadTitle`, and may
 * pass pre-translated `parseErrorMessage(filename)` / `readErrorMessage(filename)`
 * builders to fully customize the error text.
 */
export function SaveLoadButtons(props: {
  /** Current value to serialize when Save is pressed. */
  value: unknown
  /** Called with the parsed value after a successful Load. */
  onLoad: (data: unknown) => void
  /** Base filename without extension, e.g. `glue-drawing`. */
  fileBase: string
  /** Extension WITHOUT the dot, e.g. `kglue`. The file body stays JSON text. */
  ext: string
  saveTitle?: string
  loadTitle?: string
  /** Disable Save (e.g. nothing to save yet). Load stays enabled. */
  saveDisabled?: boolean
  className?: string
  /** Called with a human-readable message when a load fails to parse. */
  onError?: (message: string) => void
  /** Override the parse-failure message (already-translated). Gets the filename. */
  parseErrorMessage?: (filename: string) => string
  /** Override the read-failure message (already-translated). Gets the filename. */
  readErrorMessage?: (filename: string) => string
}) {
  const t = useT()
  const {
    value,
    onLoad,
    fileBase,
    ext,
    saveTitle = t('io.save', 'Save to file'),
    loadTitle = t('io.load', 'Load from file'),
    saveDisabled,
    className = '',
    onError,
    parseErrorMessage,
    readErrorMessage,
  } = props
  const inputRef = useRef<HTMLInputElement>(null)

  function save() {
    const text = JSON.stringify(value, null, 2)
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileBase}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  function load(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        onLoad(JSON.parse(String(reader.result ?? '')))
      } catch {
        onError?.(
          parseErrorMessage?.(file.name) ??
            t(
              'io.parseError',
              'Could not read {name} — expected a {ext} (JSON) file.',
              { name: file.name, ext },
            ),
        )
      }
    }
    reader.onerror = () =>
      onError?.(
        readErrorMessage?.(file.name) ??
          t('io.readError', 'Could not read {name}.', { name: file.name }),
      )
    reader.readAsText(file)
  }

  return (
    <span className={`km-io${className ? ' ' + className : ''}`}>
      <button
        type="button"
        className="km-io-btn"
        onClick={save}
        disabled={saveDisabled}
        title={`${saveTitle} (.${ext})`}
        aria-label={saveTitle}
      >
        <Icon name="download" size={15} />
      </button>
      <button
        type="button"
        className="km-io-btn"
        onClick={() => inputRef.current?.click()}
        title={`${loadTitle} (.${ext})`}
        aria-label={loadTitle}
      >
        <Icon name="upload" size={15} />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={`.${ext},application/json,text/plain`}
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) load(f)
          e.target.value = '' // allow re-loading the same file
        }}
      />
    </span>
  )
}
