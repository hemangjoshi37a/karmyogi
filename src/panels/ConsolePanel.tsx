import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import {
  useConsole,
  useMachine,
  usePersistentState,
  type ConsoleDir,
  type ConsoleEntry,
} from '../store'
import { useT } from '../i18n'
import { Icon } from '../components/Icons'
import { CamEmpty } from '../components/cam/CamUI'
import { explainGrblMessage } from '../core/explainers'
import '../styles/console.css'

/** A user-editable quick-send macro: a label + the raw GRBL command. */
interface Macro {
  /** Display label on the chip. */
  label: string
  /** Raw GRBL command sent verbatim. */
  cmd: string
}

/** Default quick-send macros (cncjs-style). Seeded once; then user-editable. */
const DEFAULT_MACROS: ReadonlyArray<Macro> = [
  { label: '$$', cmd: '$$' },
  { label: '$H', cmd: '$H' },
  { label: '$X', cmd: '$X' },
  { label: '$G', cmd: '$G' },
  { label: 'G0 X0 Y0', cmd: 'G0 X0 Y0' },
  { label: '?', cmd: '?' },
]

/** How many recently-sent commands to keep for ArrowUp/ArrowDown recall. */
const HISTORY_MAX = 100

/** Side a bubble sits on: sent commands hug the right, replies the left, notices center. */
function side(dir: ConsoleDir): 'right' | 'left' | 'center' {
  if (dir === 'send') return 'right'
  if (dir === 'recv') return 'left'
  return 'center'
}

/** Format an epoch-ms timestamp as a short HH:MM:SS clock for the bubble corner. */
function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/**
 * Console panel, styled as a WhatsApp-style chat with the GRBL controller.
 *
 * - Sent commands appear as accent-tinted bubbles on the RIGHT; machine replies
 *   as neutral bubbles on the LEFT; info/error as small centered system notices.
 * - A pinned search bar at the top filters bubbles by text; a pinned composer at
 *   the bottom sends G-code / `$` commands via `grbl.send` (failures are caught
 *   and surfaced as an error notice — never an unhandled rejection).
 * - ArrowUp / ArrowDown recall previously-sent commands. A "jump to latest" chip
 *   appears when scrolled up, and the whole transcript can be copied.
 * - Quick-send macros are user-editable (add / rename / delete) and persisted.
 * - `connected` (machine store) is the SINGLE source of truth for whether the
 *   composer + macros can send.
 */
export function ConsolePanel() {
  const t = useT()
  const entries = useConsole((s) => s.entries)
  const clear = useConsole((s) => s.clear)
  const pushConsole = useConsole((s) => s.push)
  // Single source of truth for "can we send": the machine connection state.
  const connected = useMachine((s) => s.connection === 'connected')
  const [cmd, setCmd] = useState('')
  const [query, setQuery] = useState('')
  const [showMacros, setShowMacros] = useState(true)
  const [editMacros, setEditMacros] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

  // User-editable, persisted macro list (seeded from DEFAULT_MACROS).
  const [macros, setMacros] = usePersistentState<Macro[]>(
    'karmyogi.console.macros',
    DEFAULT_MACROS.map((m) => ({ ...m })),
  )

  // Command history for ArrowUp/Down recall (newest last). Not persisted —
  // a session-scoped recall buffer. `histIdx` walks it (-1 = live input).
  const historyRef = useRef<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  // Stash the in-progress input when the user starts walking history so
  // ArrowDown past the newest entry restores what they were typing.
  const stashRef = useRef('')

  const threadRef = useRef<HTMLDivElement>(null)
  /** True while the user is parked near the bottom — only then do we auto-scroll. */
  const stickRef = useRef(true)

  const trimmedQuery = query.trim().toLowerCase()
  const matches = useMemo<ConsoleEntry[]>(() => {
    if (!trimmedQuery) return entries
    return entries.filter((e) => e.text.toLowerCase().includes(trimmedQuery))
  }, [entries, trimmedQuery])

  // Track whether the user is pinned to the bottom so new messages can auto-scroll
  // without yanking the view when they've scrolled up to read history.
  const onScroll = useCallback(() => {
    const el = threadRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stickRef.current = bottom
    setAtBottom(bottom)
  }, [])

  const scrollToLatest = useCallback(() => {
    const el = threadRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
    setAtBottom(true)
  }, [])

  useEffect(() => {
    const el = threadRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [matches])

  /**
   * Send a raw command. Single send path for the composer AND macros so the
   * `.catch()` (surface failure as an error notice, no unhandled rejection) and
   * the connected-gate live in ONE place.
   */
  const sendCmd = useCallback(
    (line: string) => {
      const trimmed = line.trim()
      if (!trimmed || !connected) return
      grbl.send(trimmed).catch((err: unknown) => {
        pushConsole(
          'error',
          t('console.send.failed', 'Send failed: {msg}', {
            msg: err instanceof Error ? err.message : String(err),
          }),
        )
      })
      stickRef.current = true
    },
    [connected, pushConsole, t],
  )

  const send = useCallback(() => {
    const line = cmd.trim()
    if (!line || !connected) return
    // Record in history (dedupe consecutive repeats) and reset the recall walk.
    const hist = historyRef.current
    if (hist[hist.length - 1] !== line) {
      hist.push(line)
      if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX)
    }
    setHistIdx(-1)
    stashRef.current = ''
    sendCmd(line)
    setCmd('')
  }, [cmd, connected, sendCmd])

  // ArrowUp/Down command-history recall in the composer.
  const onComposerKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const hist = historyRef.current
      if (e.key === 'Enter') {
        send()
        return
      }
      if (e.key === 'ArrowUp') {
        if (hist.length === 0) return
        e.preventDefault()
        const next = histIdx === -1 ? hist.length - 1 : Math.max(0, histIdx - 1)
        if (histIdx === -1) stashRef.current = cmd
        setHistIdx(next)
        setCmd(hist[next])
      } else if (e.key === 'ArrowDown') {
        if (histIdx === -1) return
        e.preventDefault()
        const next = histIdx + 1
        if (next >= hist.length) {
          setHistIdx(-1)
          setCmd(stashRef.current)
        } else {
          setHistIdx(next)
          setCmd(hist[next])
        }
      }
    },
    [cmd, histIdx, send],
  )

  // Copy the whole (filtered or full) transcript to the clipboard.
  const copyTranscript = useCallback(() => {
    const text = (trimmedQuery ? matches : entries)
      .map((e) => `${clock(e.ts)}  ${e.dir.toUpperCase().padEnd(5)} ${e.text}`)
      .join('\n')
    if (!text) return
    void navigator.clipboard?.writeText(text).catch(() => {
      pushConsole('error', t('console.copy.failed', 'Could not copy transcript.'))
    })
  }, [entries, matches, trimmedQuery, pushConsole, t])

  // --- macro editing helpers ---
  const addMacro = useCallback(() => {
    setMacros((m) => [...m, { label: '', cmd: '' }])
  }, [setMacros])
  const updateMacro = useCallback(
    (i: number, patch: Partial<Macro>) => {
      setMacros((m) => m.map((x, j) => (j === i ? { ...x, ...patch } : x)))
    },
    [setMacros],
  )
  const removeMacro = useCallback(
    (i: number) => {
      setMacros((m) => m.filter((_, j) => j !== i))
    },
    [setMacros],
  )

  const canSend = connected && cmd.trim().length > 0

  return (
    <div className="chat-panel">
      {/* ---- search bar (pinned top) ---- */}
      <div className="chat-search" role="search">
        <span className="chat-search-icon" aria-hidden="true">
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </span>
        <input
          className="chat-search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('console.search.placeholder', 'Search messages…')}
          aria-label={t('console.search.aria', 'Search console messages')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {trimmedQuery && (
          <span className="chat-search-count" aria-live="polite">
            {t('console.search.count', '{matches} of {total}', {
              matches: matches.length,
              total: entries.length,
            })}
          </span>
        )}
        {query && (
          <button
            type="button"
            className="chat-icon-btn"
            onClick={() => setQuery('')}
            title={t('console.search.clear', 'Clear search')}
            aria-label={t('console.search.clear', 'Clear search')}
          >
            ✕
          </button>
        )}
        <span className="mc-grow" />
        <button
          type="button"
          className="chat-icon-btn"
          onClick={copyTranscript}
          disabled={entries.length === 0}
          title={t('console.copy.title', 'Copy transcript to clipboard')}
          aria-label={t('console.copy.aria', 'Copy transcript')}
        >
          <Icon name="copy" size={16} />
        </button>
        <button
          type="button"
          className="chat-icon-btn"
          onClick={() => setShowMacros((v) => !v)}
          title={
            showMacros
              ? t('console.macros.hide', 'Hide quick commands')
              : t('console.macros.show', 'Show quick commands')
          }
          aria-label={t('console.macros.toggle', 'Toggle quick commands')}
          aria-pressed={showMacros}
        >
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
          </svg>
        </button>
        <button
          type="button"
          className="chat-icon-btn chat-icon-btn--danger"
          onClick={clear}
          disabled={entries.length === 0}
          title={t('console.clear.title', 'Clear the console log')}
          aria-label={t('console.clear.aria', 'Clear console')}
        >
          <Icon name="trash" size={16} />
        </button>
      </div>

      {/* ---- message thread (scrolls) ---- */}
      <div className="chat-thread-wrap">
        <div
          className="chat-thread"
          ref={threadRef}
          onScroll={onScroll}
          aria-live="polite"
          aria-label={t('console.thread.aria', 'Console messages')}
        >
          {entries.length === 0 ? (
            <div className="chat-empty">
              <CamEmpty
                icon={
                  <svg
                    width={22}
                    height={22}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                  </svg>
                }
                title={t('console.empty.noneTitle', 'No messages yet')}
                hint={t(
                  'console.empty.none',
                  'Connect a machine and send a command — replies appear here.',
                )}
              />
            </div>
          ) : matches.length === 0 ? (
            <div className="chat-empty">
              <CamEmpty
                icon={
                  <svg
                    width={22}
                    height={22}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4.3-4.3" />
                  </svg>
                }
                title={t('console.empty.noMatchTitle', 'No matches')}
                hint={t('console.empty.noMatch', 'No messages match “{query}”.', {
                  query: query.trim(),
                })}
              />
            </div>
          ) : (
            matches.map((e) => {
              const where = side(e.dir)
              // O8 — decode a GRBL ALARM:/error: code in an incoming/error line
              // into a plain-language cause + fix, shown under the bubble.
              const ex =
                e.dir !== 'send' ? explainGrblMessage(e.text) : null
              return (
                <div key={e.id} className={`chat-msg ${where}`}>
                  <div className={`chat-bubble dir-${e.dir}`}>
                    <span className="chat-text">{e.text}</span>
                    <time
                      className="chat-time"
                      dateTime={new Date(e.ts).toISOString()}
                    >
                      {clock(e.ts)}
                    </time>
                  </div>
                  {ex && (
                    <div
                      className="chat-explain"
                      style={{
                        alignSelf: 'flex-start',
                        maxWidth: 'min(92%, 460px)',
                        margin: '2px 0 6px',
                        padding: '7px 10px',
                        borderRadius: 8,
                        borderLeft: `3px solid ${ex.kind === 'alarm' ? 'var(--err, #e5484d)' : 'var(--warn, #f5a524)'}`,
                        background: 'color-mix(in srgb, var(--surface-2, #2a2a2a) 80%, transparent)',
                        fontSize: '0.78rem',
                        lineHeight: 1.4,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 3,
                      }}
                    >
                      <strong style={{ color: ex.kind === 'alarm' ? 'var(--err, #e5484d)' : 'var(--warn, #f5a524)' }}>
                        {t(`grbl.${ex.kind}.${ex.code}.title`, ex.title)}
                      </strong>
                      <span style={{ opacity: 0.9 }}>
                        {t(`grbl.${ex.kind}.${ex.code}.cause`, ex.cause)}{' '}
                        {t('console.explain.fix', 'Fix: {fix}', {
                          fix: t(`grbl.${ex.kind}.${ex.code}.fix`, ex.fix),
                        })}
                      </span>
                      {ex.kind === 'alarm' && connected && (
                        <button
                          type="button"
                          onClick={() => sendCmd('$X')}
                          title={t('console.explain.unlock.title', 'Clear the alarm lock ($X)')}
                          style={{
                            alignSelf: 'flex-start',
                            marginTop: 2,
                            minHeight: 32,
                            padding: '4px 12px',
                            borderRadius: 6,
                            border: '1px solid var(--border, #444)',
                            background: 'var(--accent, #3b82f6)',
                            color: '#fff',
                            fontSize: '0.78rem',
                            cursor: 'pointer',
                          }}
                        >
                          {t('console.explain.unlock', 'Unlock ($X)')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
        {/* Jump-to-latest chip: appears only when scrolled up from the bottom. */}
        {!atBottom && entries.length > 0 && (
          <button
            type="button"
            className="chat-jump"
            onClick={scrollToLatest}
            title={t('console.jump.title', 'Jump to latest message')}
            aria-label={t('console.jump.aria', 'Jump to latest')}
          >
            <span aria-hidden="true">⌄</span>{' '}
            {t('console.jump.label', 'Latest')}
          </button>
        )}
      </div>

      <p className="chat-note">
        {t('console.note.before', 'Raw GRBL console — type any G-code or ')}
        <code>$</code>
        {t('console.note.after', ' command (advanced).')}
      </p>

      {/* ---- quick-macro chips (optional, toggleable + user-editable) ---- */}
      {showMacros && (
        <div
          className="chat-macros"
          role="group"
          aria-label={t('console.macros.group', 'Quick commands')}
        >
          {editMacros
            ? macros.map((m, i) => (
                <span key={i} className="chat-macro-edit">
                  <input
                    className="chat-macro-input chat-macro-label"
                    value={m.label}
                    onChange={(e) => updateMacro(i, { label: e.target.value })}
                    placeholder={t('console.macro.labelPh', 'Label')}
                    aria-label={t('console.macro.labelAria', 'Macro label')}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <input
                    className="chat-macro-input chat-macro-cmd"
                    value={m.cmd}
                    onChange={(e) => updateMacro(i, { cmd: e.target.value })}
                    placeholder={t('console.macro.cmdPh', 'Command')}
                    aria-label={t('console.macro.cmdAria', 'Macro command')}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="chat-icon-btn"
                    onClick={() => removeMacro(i)}
                    title={t('console.macro.remove', 'Remove macro')}
                    aria-label={t('console.macro.remove', 'Remove macro')}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              ))
            : macros.map((m, i) => (
                <button
                  key={i}
                  type="button"
                  className="chat-chip"
                  disabled={!connected || !m.cmd.trim()}
                  onClick={() => sendCmd(m.cmd)}
                  title={t('console.macro.send', 'Send {cmd}', { cmd: m.cmd })}
                  aria-label={t('console.macro.send', 'Send {cmd}', {
                    cmd: m.cmd,
                  })}
                >
                  {m.label.trim() || m.cmd}
                </button>
              ))}
          {editMacros && (
            <button
              type="button"
              className="chat-chip chat-chip-add"
              onClick={addMacro}
              title={t('console.macro.add', 'Add a macro')}
              aria-label={t('console.macro.add', 'Add a macro')}
            >
              ＋ {t('console.macro.addLabel', 'Add')}
            </button>
          )}
          <button
            type="button"
            className="chat-icon-btn chat-macro-edit-toggle"
            onClick={() => setEditMacros((v) => !v)}
            title={
              editMacros
                ? t('console.macro.done', 'Done editing macros')
                : t('console.macro.edit', 'Edit macros')
            }
            aria-label={t('console.macro.editAria', 'Edit macros')}
            aria-pressed={editMacros}
          >
            {editMacros ? (
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z" />
                <path d="M13.5 6.5l3 3" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* ---- composer (pinned bottom) ---- */}
      <div className="chat-composer">
        <input
          className="chat-input"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder={
            connected
              ? t('console.composer.placeholder', 'Type a G-code / $ command…')
              : t('console.composer.disconnected', 'Connect to send commands')
          }
          disabled={!connected}
          aria-label={t('console.composer.aria', 'Message the controller')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="chat-send-btn"
          disabled={!canSend}
          onClick={send}
          title={
            connected
              ? t('console.send.title', 'Send command (Enter)')
              : t('console.composer.disconnected', 'Connect to send commands')
          }
          aria-label={t('console.send.aria', 'Send command')}
        >
          <svg
            width={18}
            height={18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 12l16-8-6 16-3.5-6.5z" />
            <path d="M10.5 13.5L20 4" />
          </svg>
        </button>
      </div>
    </div>
  )
}
