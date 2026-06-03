import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { useConsole, useMachine, type ConsoleDir, type ConsoleEntry } from '../store'
import { useT } from '../i18n'
import '../styles/console.css'

/** Quick-send macros (cncjs-style): settings, home, unlock, parser state, go to origin, status.
 *  `cmd` is the raw GRBL command (untranslated); `hk`/`help` resolve the explanatory
 *  tooltip — `hk` is the translation key, `help` the English fallback. */
const MACROS: ReadonlyArray<{ cmd: string; hk: string; help: string }> = [
  { cmd: '$$', hk: 'console.macro.settings', help: '$$ — view all GRBL settings' },
  { cmd: '$H', hk: 'console.macro.home', help: '$H — run homing cycle' },
  { cmd: '$X', hk: 'console.macro.unlock', help: '$X — clear alarm / unlock' },
  { cmd: '$G', hk: 'console.macro.parser', help: '$G — view G-code parser state' },
  { cmd: 'G0 X0 Y0', hk: 'console.macro.origin', help: 'G0 X0 Y0 — rapid to work origin' },
  { cmd: '?', hk: 'console.macro.status', help: '? — query realtime status' },
]

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
 * - A pinned search bar at the top filters bubbles by text (case-insensitive,
 *   with an "x of y" match count); a pinned composer at the bottom sends G-code /
 *   `$` commands via `grbl.send`. The thread auto-scrolls to the newest message
 *   unless the user has scrolled up, and only ever scrolls vertically.
 */
export function ConsolePanel() {
  const t = useT()
  const entries = useConsole((s) => s.entries)
  const clear = useConsole((s) => s.clear)
  const connected = useMachine((s) => s.connection === 'connected')
  const [cmd, setCmd] = useState('')
  const [query, setQuery] = useState('')
  const [showMacros, setShowMacros] = useState(true)

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
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  useEffect(() => {
    const el = threadRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [matches])

  const send = useCallback(() => {
    const line = cmd.trim()
    if (!line || !grbl.isConnected) return
    void grbl.send(line)
    setCmd('')
    stickRef.current = true
  }, [cmd])

  const canSend = connected && cmd.trim().length > 0

  return (
    <div className="chat-panel">
      {/* ---- search bar (pinned top) ---- */}
      <div className="chat-search" role="search">
        <span className="chat-search-icon" aria-hidden="true">⌕</span>
        <input
          className="chat-search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('console.search.placeholder', 'Search messages…')}
          aria-label={t('console.search.aria', 'Search console messages')}
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
          onClick={() => setShowMacros((v) => !v)}
          title={
            showMacros
              ? t('console.macros.hide', 'Hide quick commands')
              : t('console.macros.show', 'Show quick commands')
          }
          aria-label={t('console.macros.toggle', 'Toggle quick commands')}
          aria-pressed={showMacros}
        >
          ⚡
        </button>
        <button
          type="button"
          className="chat-icon-btn"
          onClick={clear}
          disabled={entries.length === 0}
          title={t('console.clear.title', 'Clear the console log')}
          aria-label={t('console.clear.aria', 'Clear console')}
        >
          🗑
        </button>
      </div>

      {/* ---- message thread (scrolls) ---- */}
      <div
        className="chat-thread"
        ref={threadRef}
        onScroll={onScroll}
        aria-live="polite"
        aria-label={t('console.thread.aria', 'Console messages')}
      >
        {entries.length === 0 ? (
          <div className="chat-empty">
            {t('console.empty.none', 'No messages yet — connect and send a command.')}
          </div>
        ) : matches.length === 0 ? (
          <div className="chat-empty">
            {t('console.empty.noMatch', 'No messages match “{query}”.', { query: query.trim() })}
          </div>
        ) : (
          matches.map((e) => {
            const where = side(e.dir)
            return (
              <div key={e.id} className={`chat-msg ${where}`}>
                <div className={`chat-bubble dir-${e.dir}`}>
                  <span className="chat-text">{e.text}</span>
                  <time className="chat-time" dateTime={new Date(e.ts).toISOString()}>
                    {clock(e.ts)}
                  </time>
                </div>
              </div>
            )
          })
        )}
      </div>

      <p className="chat-note">
        {t('console.note.before', 'Raw GRBL console — type any G-code or ')}
        <code>$</code>
        {t('console.note.after', ' command (advanced).')}
      </p>

      {/* ---- quick-macro chips (optional, toggleable) ---- */}
      {showMacros && (
        <div className="chat-macros" role="group" aria-label={t('console.macros.group', 'Quick commands')}>
          {MACROS.map((m) => (
            <button
              key={m.cmd}
              type="button"
              className="chat-chip"
              disabled={!connected}
              onClick={() => {
                void grbl.send(m.cmd)
                stickRef.current = true
              }}
              title={t(m.hk, m.help)}
              aria-label={t(m.hk, m.help)}
            >
              {m.cmd}
            </button>
          ))}
        </div>
      )}

      {/* ---- composer (pinned bottom) ---- */}
      <div className="chat-composer">
        <input
          className="chat-input"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          placeholder={
            connected
              ? t('console.composer.placeholder', 'Type a G-code / $ command…')
              : t('console.composer.disconnected', 'Connect to send commands')
          }
          disabled={!connected}
          aria-label={t('console.composer.aria', 'Message the controller')}
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
          <span aria-hidden="true">➤</span>
        </button>
      </div>
    </div>
  )
}
