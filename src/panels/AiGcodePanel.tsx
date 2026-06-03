import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildSystemPrompt,
  extractGcode,
  generate,
  lintGcode,
  parseCookieFile,
  type ChatMessage,
  type Provider,
} from '../core/aiGcode'
import {
  DEFAULT_MODELS,
  MODEL_OPTIONS,
  useAiGcode,
  type AuthMode,
  type ChatTurn,
} from '../store/aiGcode'
import { useBed } from '../store/bed'
import { useProgram } from '../store'
import { useT } from '../i18n'
import '../styles/ai.css'

/**
 * AI G-code panel — turns a plain-English description into safe GRBL G-code via
 * OpenAI or Anthropic. Two auth modes, both user-supplied (nothing hardcoded):
 *
 *  - API key (recommended): paste your own key; we call the official REST API
 *    directly from the browser.
 *  - Session cookie (advanced): paste the logged-in claude.ai / chatgpt.com
 *    cookie you exported with a cookie extension, plus a relay/proxy URL you
 *    control. We CANNOT read that cookie ourselves (cross-origin HttpOnly), and
 *    a browser fetch can't set `Cookie` nor read a CORS-blocked response — so
 *    the cookie is sent as `X-Session-Cookie` to your proxy, which re-attaches
 *    it server-side. The in-panel guide explains the export steps.
 *
 * Everything is stored ONLY in this browser (localStorage) and sent ONLY to the
 * official endpoint (key mode) or your proxy (session mode). Output is run
 * through a SAFETY lint (lintGcode) before display: it prepends a missing
 * G21/G90/G94 preamble and flags out-of-bed coordinates, absurd feeds, and
 * missing safe-Z retracts. The G-code can be loaded into the Program tab so it
 * appears in the Visualizer for review BEFORE it is ever streamed.
 */

const PROVIDER_INFO: Record<
  Provider,
  {
    label: string
    keyUrl: string
    keyHint: string
    /** The web host whose cookie the user exports in session mode. */
    site: string
  }
> = {
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-...',
    site: 'chatgpt.com',
  },
  anthropic: {
    label: 'Claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-...',
    site: 'claude.ai',
  },
}

const EXAMPLE_PROMPT =
  'Engrave the text "HELLO" 20mm tall centered on the bed, 0.3mm deep, single-stroke. ' +
  'Use a 1mm engraving bit, feed 400 mm/min, plunge 150 mm/min.'

export function AiGcodePanel() {
  const t = useT()

  const provider = useAiGcode((s) => s.provider)
  const authMode = useAiGcode((s) => s.authMode)
  const apiKeys = useAiGcode((s) => s.apiKeys)
  const models = useAiGcode((s) => s.models)
  const sessionCookies = useAiGcode((s) => s.sessionCookies)
  const proxyUrls = useAiGcode((s) => s.proxyUrls)
  const setProvider = useAiGcode((s) => s.setProvider)
  const setAuthMode = useAiGcode((s) => s.setAuthMode)
  const setApiKey = useAiGcode((s) => s.setApiKey)
  const setModel = useAiGcode((s) => s.setModel)
  const setSessionCookie = useAiGcode((s) => s.setSessionCookie)
  const setLastPrompt = useAiGcode((s) => s.setLastPrompt)
  const pushHistory = useAiGcode((s) => s.pushHistory)
  const storedPrompt = useAiGcode((s) => s.lastPrompt)

  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)
  const setProgram = useProgram((s) => s.setProgram)
  const chat = useAiGcode((s) => s.chat)
  const pushChat = useAiGcode((s) => s.pushChat)
  const clearChat = useAiGcode((s) => s.clearChat)
  const clearCredentials = useAiGcode((s) => s.clearCredentials)

  const [prompt, setPrompt] = useState(storedPrompt)
  const [tool, setTool] = useState('')
  const [material, setMaterial] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [showConfig, setShowConfig] = useState(chat.length === 0)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [cookieImportNote, setCookieImportNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const cookieFileRef = useRef<HTMLInputElement | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  const info = PROVIDER_INFO[provider]
  const apiKey = apiKeys[provider]
  const model = models[provider]
  const sessionCookie = sessionCookies[provider]
  const proxyUrl = proxyUrls[provider]
  const hasKey = apiKey.trim().length > 0
  // Session mode just needs a pasted cookie — the relay is configured for the
  // deployment, the user doesn't set it.
  const hasSession = sessionCookie.trim().length > 0
  /** Are the credentials for the current auth mode present? */
  const ready = authMode === 'key' ? hasKey : hasSession

  const bed = useMemo(
    () => ({ width: bedW, depth: bedD, height: bedH }),
    [bedW, bedD, bedH],
  )

  const switchProvider = (p: Provider) => {
    setProvider(p)
    setError(null)
  }

  /** Unique-ish id for a chat turn (no crypto dependency needed). */
  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  const run = async (overridePrompt?: string) => {
    const p = (overridePrompt ?? prompt).trim()
    setError(null)
    setLoadedId(null)
    if (!ready) {
      setError(
        authMode === 'key'
          ? t(
              'ai.err.noKey',
              'Add your {provider} API key above first — the app needs it to call the model.',
              { provider: info.label },
            )
          : t(
              'ai.err.noSession',
              'Paste your {site} cookie above first, or switch to API-key mode.',
              { site: info.site },
            ),
      )
      return
    }
    if (!p) {
      setError(t('ai.err.noPrompt', 'Describe what you want to make first.'))
      return
    }

    // Append the user turn and build the full message context (history + this).
    const userTurn: ChatTurn = { id: newId(), role: 'user', content: p, at: Date.now() }
    const priorMessages: ChatMessage[] = [...chat, userTurn].map((m) => ({
      role: m.role,
      content: m.content,
    }))
    pushChat(userTurn)
    setPrompt('')
    setLastPrompt('')
    setBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      // First message of a fresh chat carries the machine context; later ones
      // are pure iteration on the latest code already in the conversation.
      const system = buildSystemPrompt({
        bed,
        tool: tool.trim() || undefined,
        material: material.trim() || undefined,
      })
      const raw = await generate(provider, {
        apiKey,
        model,
        system,
        messages: priorMessages,
        signal: ctrl.signal,
        mode: authMode,
        sessionCookie,
        proxyUrl,
      })
      const gcode = extractGcode(raw)
      const { cleaned, warnings: w } = lintGcode(gcode, { bed })
      pushChat({
        id: newId(),
        role: 'assistant',
        content: raw,
        at: Date.now(),
        gcode: cleaned,
        warnings: w,
      })
      pushHistory({ prompt: p, provider, model, at: Date.now() })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
  }

  /**
   * Import a cookie export file (cookies.txt / JSON / header string) the user
   * downloaded from a cookie extension, parse it to a `name=value; …` string,
   * and drop it into the cookie field. Pure client-side file read — no upload.
   */
  const importCookieFile = (file: File | undefined) => {
    setCookieImportNote(null)
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const parsed = parseCookieFile(String(reader.result ?? ''))
      if (parsed) {
        setSessionCookie(provider, parsed)
        setCookieImportNote(
          t('ai.session.imported', 'Imported cookie from {name}.', { name: file.name }),
        )
      } else {
        setCookieImportNote(
          t(
            'ai.session.importFail',
            'Could not read a cookie from {name}. Use a cookies.txt, JSON export, or paste it manually.',
            { name: file.name },
          ),
        )
      }
    }
    reader.onerror = () =>
      setCookieImportNote(t('ai.session.readErr', 'Could not read that file.'))
    reader.readAsText(file)
  }

  const loadIntoProgram = (turn: ChatTurn) => {
    if (!turn.gcode || !turn.gcode.trim()) return
    setProgram(t('ai.programName', 'AI G-code'), turn.gcode)
    setLoadedId(turn.id)
  }

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, busy])

  return (
    <div className="ai-panel" aria-label={t('ai.aria.panel', 'AI G-code generator')}>
      {/* PROMINENT safety banner — AI output can be wrong/unsafe. */}
      <div className="ai-safety" role="note">
        <span className="ai-safety-icon" aria-hidden="true">
          ⚠
        </span>
        <span>
          {t(
            'ai.safety',
            'AI-generated G-code can be wrong or unsafe. ALWAYS review it in the Visualizer and dry-run (Z raised / spindle off) before cutting. Never run it unattended.',
          )}
        </span>
      </div>

      {/* BYOK explainer. */}
      <p className="ai-intro">
        {t(
          'ai.intro',
          'Describe a job in plain words and the model writes GRBL G-code for it. This runs entirely in your browser using your own API key (or a pasted login session) — there is no server.',
        )}
      </p>

      {/* Provider toggle. */}
      <div className="ai-seg" role="tablist" aria-label={t('ai.providerAria', 'AI provider')}>
        {(['openai', 'anthropic'] as Provider[]).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={provider === p}
            className="ai-seg-btn"
            data-on={provider === p ? 'true' : 'false'}
            onClick={() => switchProvider(p)}
            title={t('ai.provider.tip', 'Use {name}', { name: PROVIDER_INFO[p].label })}
          >
            {PROVIDER_INFO[p].label}
          </button>
        ))}
      </div>

      {/* Auth-mode toggle: API key (recommended) vs session cookie (advanced). */}
      <div className="ai-auth-mode-group">
        <label className="ai-label ai-auth-label">
          {t('ai.auth.methodLabel', 'Authentication Method')}
        </label>
        <div className="ai-seg ai-seg-sub" role="tablist" aria-label={t('ai.authAria', 'Authentication method')}>
          {(['key', 'session'] as AuthMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={authMode === m}
              className="ai-seg-btn"
              data-on={authMode === m ? 'true' : 'false'}
              onClick={() => {
                setAuthMode(m)
                setError(null)
              }}
              title={
                m === 'key'
                  ? t('ai.auth.keyTip', 'Use your own API key (recommended)')
                  : t('ai.auth.sessionTip', 'Paste a logged-in session cookie via your own relay (advanced)')
              }
            >
              {m === 'key'
                ? t('ai.auth.key', 'API key')
                : t('ai.auth.session', 'Login session')}
            </button>
          ))}
        </div>
      </div>

      {authMode === 'key' ? (
        /* API key — masked. */
        <section className="ai-card">
          <label className="ai-label" htmlFor="ai-key">
            {t('ai.key.label', '{provider} API key', { provider: info.label })}
          </label>
          <div className="ai-key-row">
            <input
              id="ai-key"
              className="ai-input ai-mono"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              placeholder={info.keyHint}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setApiKey(provider, e.target.value)}
              aria-label={t('ai.key.aria', '{provider} API key', { provider: info.label })}
            />
            <button
              type="button"
              className="ai-btn ai-mini"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? t('ai.key.hide', 'Hide key') : t('ai.key.show', 'Show key')}
              aria-label={showKey ? t('ai.key.hide', 'Hide key') : t('ai.key.show', 'Show key')}
            >
              {showKey ? '🙈' : '👁'}
            </button>
            {hasKey && (
              <button
                type="button"
                className="ai-btn ai-mini"
                onClick={() => clearCredentials(provider)}
                title={t('ai.creds.clearTip', 'Remove the stored {provider} key from this browser', {
                  provider: info.label,
                })}
                aria-label={t('ai.creds.clear', 'Clear stored credentials')}
              >
                ✕
              </button>
            )}
          </div>
          <p className="ai-note">
            {t(
              'ai.key.note',
              'Your key stays in this browser (localStorage) and is sent only to {provider}.',
              { provider: info.label },
            )}{' '}
            <a href={info.keyUrl} target="_blank" rel="noreferrer noopener">
              {t('ai.key.get', 'Get a key')}
            </a>
          </p>
        </section>
      ) : (
        /* Login session — just paste (or import) your copied cookie. */
        <section className="ai-card">
          <label className="ai-label">
            {t('ai.session.label', '{site} login session', { site: info.site })}
          </label>

          <p className="ai-note">
            {t(
              'ai.session.simple',
              'Already logged in to {site}? Copy your cookie with a cookie extension (e.g. Cookie-Editor) and paste it below — no API key needed.',
              { site: info.site },
            )}
          </p>

          {/* The one easy action: paste, or import a saved cookie file. */}
          <div className="ai-row">
            <a
              className="ai-btn ai-grow ai-bigbtn"
              href={`https://${info.site}/`}
              target="_blank"
              rel="noreferrer noopener"
              title={t('ai.session.openTip', 'Open {site} in a new tab and log in', { site: info.site })}
            >
              {t('ai.session.openLogin', '↗ Open {site}', { site: info.site })}
            </a>
            <button
              type="button"
              className="ai-btn ai-grow ai-bigbtn"
              onClick={() => cookieFileRef.current?.click()}
              title={t(
                'ai.session.importTip',
                'Import a cookie file you saved from a cookie extension (.txt or .json)',
              )}
            >
              {t('ai.session.import', '⤓ Import cookie file')}
            </button>
            <input
              ref={cookieFileRef}
              type="file"
              accept=".txt,.json,text/plain,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                importCookieFile(e.target.files?.[0])
                e.target.value = ''
              }}
              aria-hidden="true"
            />
          </div>
          {cookieImportNote && (
            <p className="ai-note ai-ok" role="status" aria-live="polite">
              {cookieImportNote}
            </p>
          )}

          <label className="ai-label ai-sublabel" htmlFor="ai-cookie">
            {t('ai.session.cookieLabel', 'Paste your cookie here')}
          </label>
          <textarea
            id="ai-cookie"
            className="ai-textarea ai-mono"
            rows={3}
            value={sessionCookie}
            placeholder={t('ai.session.cookiePlaceholder', 'paste the cookie you copied (header string or JSON both work)')}
            spellCheck={false}
            onChange={(e) => {
              const val = e.target.value
              // Automatically parse if pasted text is JSON or Netscape format
              const parsed = parseCookieFile(val)
              setSessionCookie(provider, parsed || val)
            }}
            aria-label={t('ai.session.cookieAria', 'Pasted session cookie')}
          />

          <p className="ai-note">
            {t(
              'ai.session.stored',
              'Your cookie stays in this browser (localStorage). If the session expires, paste a fresh one.',
            )}
          </p>
          {sessionCookie.trim() && (
            <div className="ai-row">
              <button
                type="button"
                className="ai-btn ai-mini"
                onClick={() => clearCredentials(provider)}
                title={t(
                  'ai.creds.clearSessionTip',
                  'Remove the stored {site} cookie from this browser',
                  { site: info.site },
                )}
              >
                {t('ai.creds.clearSession', '✕ Clear stored cookie')}
              </button>
            </div>
          )}
        </section>
      )}

      {/* Model + machine context — collapsible (the credential UI stays visible). */}
      <button
        type="button"
        className="ai-disclosure ai-setup-toggle"
        aria-expanded={showConfig}
        onClick={() => setShowConfig((v) => !v)}
        title={t('ai.setup.tip', 'Model and machine-context settings')}
      >
        <span aria-hidden="true">{showConfig ? '▾' : '▸'}</span>{' '}
        {t('ai.setup.title', 'Model & context — {model} · bed {w}×{d} mm', {
          model,
          w: bedW,
          d: bedD,
        })}
      </button>

      {showConfig && (
      <section className="ai-card">
        <label className="ai-label" htmlFor="ai-model">
          {t('ai.model.label', 'Model')}
        </label>
        <div className="ai-row">
          <select
            id="ai-model"
            className="ai-input"
            value={MODEL_OPTIONS[provider].includes(model) ? model : '__custom__'}
            onChange={(e) => {
              const v = e.target.value
              if (v !== '__custom__') setModel(provider, v)
              else setModel(provider, '')
            }}
            aria-label={t('ai.model.aria', 'Model')}
          >
            {MODEL_OPTIONS[provider].map((m) => (
              <option key={m} value={m}>
                {m === DEFAULT_MODELS[provider] ? `${m} (default)` : m}
              </option>
            ))}
            <option value="__custom__">{t('ai.model.custom', 'Custom…')}</option>
          </select>
        </div>
        <input
          className="ai-input ai-mono"
          type="text"
          value={model}
          placeholder={t('ai.model.customPlaceholder', 'custom model id')}
          spellCheck={false}
          onChange={(e) => setModel(provider, e.target.value)}
          aria-label={t('ai.model.customAria', 'Custom model id')}
        />

        {/* Read-only machine context summary. */}
        <div className="ai-context" role="group" aria-label={t('ai.ctx.aria', 'Machine context')}>
          <span className="ai-ctx-item">
            {t('ai.ctx.bed', 'Bed')}:{' '}
            <b>
              {bedW} × {bedD} × {bedH} mm
            </b>
          </span>
        </div>
        <div className="ai-row">
          <input
            className="ai-input"
            type="text"
            value={tool}
            placeholder={t('ai.ctx.toolPlaceholder', 'Tool (optional) — e.g. 3mm flat endmill')}
            onChange={(e) => setTool(e.target.value)}
            aria-label={t('ai.ctx.toolAria', 'Tool (optional)')}
          />
        </div>
        <div className="ai-row">
          <input
            className="ai-input"
            type="text"
            value={material}
            placeholder={t('ai.ctx.matPlaceholder', 'Material (optional) — e.g. MDF, plywood')}
            onChange={(e) => setMaterial(e.target.value)}
            aria-label={t('ai.ctx.matAria', 'Material (optional)')}
          />
        </div>
      </section>
      )}

      {/* ---- Chat conversation ---- */}
      <section className="ai-card ai-chat-card">
        <header className="ai-out-head">
          <span className="ai-label">{t('ai.chat.label', 'Chat')}</span>
          <span className="ai-out-stats">
            <span className="ai-chat-count">
              {t('ai.chat.count', '{n} messages', { n: chat.length })}
            </span>
            <button
              type="button"
              className="ai-btn ai-mini"
              disabled={chat.length === 0 || busy}
              onClick={() => {
                clearChat()
                setError(null)
                setLoadedId(null)
              }}
              title={t('ai.chat.clearTip', 'Clear this conversation (cannot be undone)')}
            >
              {t('ai.chat.clear', '🗑 Clear chat')}
            </button>
          </span>
        </header>

        {/* Thread (browser-cached; iterate by chatting). */}
        <div className="ai-thread" ref={threadRef} aria-label={t('ai.chat.threadAria', 'Conversation')}>
          {chat.length === 0 && !busy && (
            <p className="ai-thread-empty">
              {t(
                'ai.chat.empty',
                'Describe what you want to make. Then keep chatting to refine it — e.g. “make it 2mm deeper”, “add a 5mm border”, “use feed 300”. The whole conversation is sent as context and cached in this browser.',
              )}
            </p>
          )}
          {chat.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ai-msg user">
                <div className="ai-msg-role">{t('ai.chat.you', 'You')}</div>
                <div className="ai-msg-text">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="ai-msg assistant">
                <div className="ai-msg-role">{info.label}</div>
                {m.warnings && m.warnings.length > 0 && (
                  <ul className="ai-warnings" aria-label={t('ai.out.warnAria', 'Safety lint warnings')}>
                    {m.warnings.map((w, i) => (
                      <li key={i} className={`ai-warn-item ${w.level}`}>
                        <span aria-hidden="true">
                          {w.level === 'error' ? '⛔' : w.level === 'warn' ? '⚠' : 'ℹ'}
                        </span>{' '}
                        {w.message}
                      </li>
                    ))}
                  </ul>
                )}
                {m.gcode ? (
                  <>
                    <pre className="ai-code" aria-label={t('ai.out.codeAria', 'Generated G-code')}>
                      {m.gcode}
                    </pre>
                    <div className="ai-row">
                      <button
                        type="button"
                        className="ai-btn primary ai-grow"
                        onClick={() => loadIntoProgram(m)}
                        title={t(
                          'ai.loadTip',
                          'Load this G-code into the Program tab so it shows in the Visualizer for review',
                        )}
                      >
                        {t('ai.load', '↗ Load into Program')}
                      </button>
                      <button
                        type="button"
                        className="ai-btn"
                        onClick={() => navigator.clipboard?.writeText(m.gcode ?? '').catch(() => {})}
                        title={t('ai.copyTip', 'Copy the G-code to the clipboard')}
                      >
                        {t('ai.copy', '⧉ Copy')}
                      </button>
                    </div>
                    {loadedId === m.id && (
                      <p className="ai-note ai-ok" role="status" aria-live="polite">
                        ✓{' '}
                        {t(
                          'ai.loadedNote',
                          'Loaded into Program — open the Visualizer to review the toolpath before cutting.',
                        )}
                      </p>
                    )}
                  </>
                ) : (
                  <div className="ai-msg-text">{m.content}</div>
                )}
              </div>
            ),
          )}
          {busy && (
            <div className="ai-msg assistant">
              <div className="ai-msg-role">{info.label}</div>
              <p className="ai-note ai-busy" role="status" aria-live="polite">
                <span className="ai-spinner" aria-hidden="true" />
                {t('ai.busy', 'Asking {provider}…', { provider: info.label })}
              </p>
            </div>
          )}
        </div>

        {error && (
          <p className="ai-note ai-error" role="alert">
            {error}
            {authMode === 'key' && !hasKey && (
              <>
                {' '}
                <a href={info.keyUrl} target="_blank" rel="noreferrer noopener">
                  {t('ai.key.get', 'Get a key')}
                </a>
              </>
            )}
          </p>
        )}

        {/* Composer. Enter sends; Shift+Enter for a newline. */}
        <textarea
          id="ai-prompt"
          className="ai-textarea ai-composer"
          rows={3}
          value={prompt}
          placeholder={chat.length === 0 ? EXAMPLE_PROMPT : t('ai.chat.followupPlaceholder', 'Refine the code above…')}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!busy) run()
            }
          }}
          aria-label={t('ai.prompt.aria', 'Message')}
        />
        <div className="ai-row">
          {busy ? (
            <button
              type="button"
              className="ai-btn ai-grow"
              onClick={cancel}
              title={t('ai.cancelTip', 'Cancel the in-flight request')}
            >
              {t('ai.cancel', '■ Cancel')}
            </button>
          ) : (
            <button
              type="button"
              className="ai-btn primary ai-grow"
              onClick={() => run()}
              title={t('ai.sendTip', 'Send to {provider} (Enter)', { provider: info.label })}
            >
              {chat.length === 0
                ? t('ai.generate', '✦ Generate G-code')
                : t('ai.send', '➤ Send')}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
