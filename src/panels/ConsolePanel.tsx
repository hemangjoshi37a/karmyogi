import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { useConsole, useMachine, type ConsoleDir, type ConsoleEntry } from '../store'
import '../styles/console.css'

/** Quick-send macros (cncjs-style): settings, home, unlock, parser state, go to origin, status.
 *  `label` is what shows on the chip; `help` is the explanatory tooltip. */
const MACROS: ReadonlyArray<{ cmd: string; help: string }> = [
  { cmd: '$$', help: '$$ — view all GRBL settings' },
  { cmd: '$H', help: '$H — run homing cycle' },
  { cmd: '$X', help: '$X — clear alarm / unlock' },
  { cmd: '$G', help: '$G — view G-code parser state' },
  { cmd: 'G0 X0 Y0', help: 'G0 X0 Y0 — rapid to work origin' },
  { cmd: '?', help: '? — query realtime status' },
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
          placeholder="Search messages…"
          aria-label="Search console messages"
        />
        {trimmedQuery && (
          <span className="chat-search-count" aria-live="polite">
            {matches.length} of {entries.length}
          </span>
        )}
        {query && (
          <button
            type="button"
            className="chat-icon-btn"
            onClick={() => setQuery('')}
            title="Clear search"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
        <span className="mc-grow" />
        <button
          type="button"
          className="chat-icon-btn"
          onClick={() => setShowMacros((v) => !v)}
          title={showMacros ? 'Hide quick commands' : 'Show quick commands'}
          aria-label="Toggle quick commands"
          aria-pressed={showMacros}
        >
          ⚡
        </button>
        <button
          type="button"
          className="chat-icon-btn"
          onClick={clear}
          disabled={entries.length === 0}
          title="Clear the console log"
          aria-label="Clear console"
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
        aria-label="Console messages"
      >
        {entries.length === 0 ? (
          <div className="chat-empty">No messages yet — connect and send a command.</div>
        ) : matches.length === 0 ? (
          <div className="chat-empty">No messages match “{query.trim()}”.</div>
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

      <p className="chat-note">Raw GRBL console — type any G-code or <code>$</code> command (advanced).</p>

      {/* ---- quick-macro chips (optional, toggleable) ---- */}
      {showMacros && (
        <div className="chat-macros" role="group" aria-label="Quick commands">
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
              title={m.help}
              aria-label={m.help}
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
          placeholder={connected ? 'Type a G-code / $ command…' : 'Connect to send commands'}
          disabled={!connected}
          aria-label="Message the controller"
        />
        <button
          type="button"
          className="chat-send-btn"
          disabled={!canSend}
          onClick={send}
          title={connected ? 'Send command (Enter)' : 'Connect to send commands'}
          aria-label="Send command"
        >
          <span aria-hidden="true">➤</span>
        </button>
      </div>
    </div>
  )
}
