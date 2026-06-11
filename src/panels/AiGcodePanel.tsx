import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AiError,
  buildSystemPrompt,
  DEFAULT_RELAY_URL,
  extractGcode,
  generate,
  lintGcode,
  parseCookieFile,
  type AiErrorCode,
  type ChatMessage,
  type LintWarning,
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
import { IconButton } from '../components/IconButton'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
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
 *    it server-side. A "How?" disclosure explains the export steps on demand.
 *
 * Everything is stored ONLY in this browser (localStorage) and sent ONLY to the
 * official endpoint (key mode) or your proxy (session mode). Output is run
 * through a SAFETY lint (lintGcode) before display: it prepends a missing
 * G21/G90/G94 preamble and flags out-of-bed coordinates, absurd feeds, and
 * missing safe-Z retracts. The G-code can be loaded into the Program tab so it
 * appears in the Visualizer for review BEFORE it is ever streamed.
 *
 * Layout follows the house (Soldering / Glue) pattern: a slim header (title +
 * InfoTip + icon toolbar), a live status strip (provider · model · readiness ·
 * last lint), a self-contained collapsible "Connect AI" section (collapses to a
 * one-line summary once configured) with the long cookie guide behind a "How?"
 * disclosure, and the CHAT — the primary task — as the dominant region with the
 * composer pinned at the bottom.
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

/** The `t()` translator returned by useT(). */
type T = (key: string, english: string, vars?: Record<string, string | number>) => string

/** Is a relay actually configured for this deployment? Session/cookie mode only
 *  works through a relay (CORS + HttpOnly cookies make the in-browser path
 *  impossible), so the whole mode is hidden unless one is present. */
const RELAY_CONFIGURED = DEFAULT_RELAY_URL.trim().length > 0

/** Inline check glyph for the transient "copied" button state (the shared icon
 *  set has no 'check'; Icons.tsx must not be edited, so it lives locally). */
const CHECK_GLYPH = (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)

/**
 * A slim square icon button for the header toolbar (same pattern as the
 * Soldering panel). `title`/`body` are combined into a native hover tooltip
 * explainer that never intercepts the action click, keeping the toolbar
 * compact while every button stays self-documenting.
 */
function ToolButton(props: {
  glyph: ReactNode
  title: string
  body: string
  onClick: () => void
  className?: string
  disabled?: boolean
  ariaExpanded?: boolean
}) {
  const { glyph, title, body, onClick, className = '', disabled, ariaExpanded } = props
  return (
    <button
      type="button"
      className={`ai-ico${className ? ' ' + className : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-expanded={ariaExpanded}
      title={`${title} — ${body}`}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}

/**
 * Translate an AI-core error (an {@link AiError} carries a stable `code` +
 * interpolation params; plain Errors fall through to their raw message).
 */
function translateError(t: T, err: unknown): string {
  if (err instanceof AiError) {
    const p = err.params ?? {}
    const byCode: Record<AiErrorCode, string> = {
      cancelled: t('ai.err.cancelled', 'Request cancelled.'),
      network: t(
        'ai.err.network',
        'Could not reach {where}. This is usually no internet connection, a browser extension blocking the request, or a CORS block. Check your connection and try again.',
        p,
      ),
      authRejected: t(
        'ai.err.authRejected',
        '{where} rejected the credentials (HTTP {status}). Check your API key — or, in session mode, that the pasted cookie is fresh (re-export it; sessions expire) and the proxy forwards it correctly.',
        p,
      ),
      rateLimit: t(
        'ai.err.rateLimit',
        '{where} rate-limit / quota exceeded (HTTP 429). You may be out of credits or sending too fast. {detail}',
        p,
      ),
      httpError: t('ai.err.httpError', '{where} API error (HTTP {status}). {detail}', p),
      emptyResponse: t('ai.err.emptyResponse', '{where} returned an empty response.', p),
      noCookie: t('ai.err.noCookie', 'Paste your session cookie first.'),
      noKey: t('ai.err.noKeyShort', 'Add your API key first.'),
      noRelay: t(
        'ai.err.noRelay',
        'Session mode needs a relay/proxy URL — configure VITE_AI_RELAY_URL or enter a proxy URL.',
      ),
    }
    return byCode[err.code]
  }
  return err instanceof Error ? err.message : String(err)
}

/** Translate a lint warning by its stable code (falls back to the English message). */
function translateWarning(t: T, w: LintWarning): string {
  const p = w.params ?? {}
  switch (w.code) {
    case 'preamble':
      return t('ai.lint.preamble', 'Prepended missing safety preamble: {codes}.', p)
    case 'xRange':
      return t('ai.lint.xRange', 'X{v} is outside the bed (X must be {lo}..{hi} mm): {line}', p)
    case 'yRange':
      return t('ai.lint.yRange', 'Y{v} is outside the bed (Y must be {lo}..{hi} mm): {line}', p)
    case 'zMax':
      return t('ai.lint.zMax', 'Z{v} is above the work height (Z max {hi} mm): {line}', p)
    case 'feedHigh':
      return t('ai.lint.feedHigh', 'Feed F{feed} mm/min looks very high — verify it is safe: {line}', p)
    case 'feedNonPositive':
      return t('ai.lint.feedNonPositive', 'Feed F{feed} is not positive: {line}', p)
    case 'rapidLowZ':
      return t(
        'ai.lint.rapidLowZ',
        'A rapid XY travel happens while Z may be at/below the surface — make sure the tool retracts to a safe Z before rapids.',
      )
    case 'noSafeRetract':
      return t(
        'ai.lint.noSafeRetract',
        'No safe-Z retract (a positive Z move) found — verify the tool lifts above the stock before/after travel.',
      )
    case 'endLowZ':
      return t(
        'ai.lint.endLowZ',
        'Program may end with Z below the surface — add a safe-Z retract at the end.',
      )
    default:
      return w.message
  }
}

/** Worst severity in a warning list, for the status strip + message summary. */
function worstLevel(warnings: LintWarning[] | undefined): 'error' | 'warn' | 'info' | null {
  if (!warnings || warnings.length === 0) return null
  if (warnings.some((w) => w.level === 'error')) return 'error'
  if (warnings.some((w) => w.level === 'warn')) return 'warn'
  return 'info'
}

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
  const setProxyUrl = useAiGcode((s) => s.setProxyUrl)
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

  // Session/cookie auth can ONLY work through a configured relay; if none is set
  // for this deployment, the mode is hidden and we hard-pin to key mode.
  // (Derived BEFORE the state hooks so the initial Connect collapse keys off it.)
  const effectiveAuthMode: AuthMode = RELAY_CONFIGURED ? authMode : 'key'

  const info = PROVIDER_INFO[provider]
  const apiKey = apiKeys[provider]
  const model = models[provider]
  const sessionCookie = sessionCookies[provider]
  const proxyUrl = proxyUrls[provider]
  const hasKey = apiKey.trim().length > 0
  const hasSession = sessionCookie.trim().length > 0
  /** Are the credentials for the current auth mode present? */
  const ready = effectiveAuthMode === 'key' ? hasKey : hasSession
  /** The model dropdown is on "Custom…" (free-text id not in the preset list). */
  const isCustomModel = !MODEL_OPTIONS[provider].includes(model)
  /** Expected key prefix ('sk-' / 'sk-ant-') — the keyHint minus the trailing dots. */
  const expectedPrefix = info.keyHint.replace(/\.+$/, '')
  /** Soft, purely-presentational format check (never blocks sending). */
  const keyLooksWrong = hasKey && !apiKey.trim().startsWith(expectedPrefix)

  const [prompt, setPrompt] = useState(storedPrompt)
  const [tool, setTool] = useState('')
  const [material, setMaterial] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  // The "Connect AI" section (provider + credentials): open until credentials
  // exist, collapsed to a one-line summary once configured so the CHAT is first.
  const [showConnect, setShowConnect] = useState(!ready)
  // The optional "Model & context" advanced disclosure (collapsed by default).
  const [showContext, setShowContext] = useState(false)
  // The long cookie-export step-by-step guide — hidden behind a "How?" expander.
  const [showCookieHelp, setShowCookieHelp] = useState(false)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [cookieImportNote, setCookieImportNote] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<{ id: string; ok: boolean } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const cookieFileRef = useRef<HTMLInputElement | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  // Monotonic counter so each "Load into Program" gets its OWN program section
  // (the store upserts by name) and multiple loads don't overwrite each other.
  const loadSeqRef = useRef(0)

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

  /** The most recent assistant turn's lint summary, for the status strip. */
  const lastAssistant = useMemo(() => {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i].role === 'assistant') return chat[i]
    }
    return undefined
  }, [chat])
  const lastLevel = worstLevel(lastAssistant?.warnings)
  const lastWarnCount = lastAssistant?.warnings?.length ?? 0

  const run = async (overridePrompt?: string) => {
    // Hard re-entrancy guard: a double-click (or Enter + click) must not fire
    // two concurrent requests.
    if (busy) return
    const p = (overridePrompt ?? prompt).trim()
    setError(null)
    setLoadedId(null)
    if (!ready) {
      // Open the Connect section so the missing field is right there.
      setShowConnect(true)
      setError(
        effectiveAuthMode === 'key'
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
        mode: effectiveAuthMode,
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
      setError(translateError(t, err))
      // On a CANCELLED request, restore the prompt into the composer so the
      // user doesn't lose what they typed.
      if (err instanceof AiError && err.code === 'cancelled') {
        setPrompt(p)
        setLastPrompt(p)
      }
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
    // Give each load a UNIQUE section name (the program store upserts by name),
    // so loading several AI replies keeps each as its own section instead of
    // overwriting the previous one.
    const n = ++loadSeqRef.current
    setProgram(t('ai.programName.n', 'AI G-code {n}', { n }), turn.gcode)
    setLoadedId(turn.id)
  }

  /** Copy G-code to the clipboard and surface a transient confirmation/failure. */
  const copyGcode = async (turn: ChatTurn) => {
    const code = turn.gcode ?? ''
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(code)
      setCopyState({ id: turn.id, ok: true })
    } catch {
      setCopyState({ id: turn.id, ok: false })
    }
  }

  // Keep the newest message in view as the conversation grows.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, busy])

  // Auto-clear the "Copied" / copy-failed confirmation after a moment.
  useEffect(() => {
    if (!copyState) return
    const id = window.setTimeout(() => setCopyState(null), 2200)
    return () => window.clearTimeout(id)
  }, [copyState])

  // Tappable example prompts for the empty state — they only FILL the composer
  // (never auto-send) so the user can edit before generating.
  const exampleCircle = t('ai.example.circle', 'Cut a 40mm circle, 3mm deep, 1mm per pass')
  const exampleGrid = t('ai.example.grid', 'Drill a 5×5 grid of holes, 10mm spacing')
  const exampleChips: { label: string; fill: string }[] = [
    { label: t('ai.example.engrave', 'Engrave “HELLO” centered on the bed'), fill: t('ai.examplePrompt', EXAMPLE_PROMPT) },
    { label: exampleCircle, fill: exampleCircle },
    { label: exampleGrid, fill: exampleGrid },
  ]

  return (
    <div className="ai-panel" aria-label={t('ai.aria.panel', 'AI G-code generator')}>
      {/* Slim house-style header: title + InfoTip + icon toolbar. */}
      <header className="ai-head">
        <div className="ai-head-title">
          <span className="ai-head-name">{t('ai.title', 'AI G-code')}</span>
          <InfoTip
            topic="aiGcode"
            title={t('ai.title', 'AI G-code')}
            body={t(
              'ai.intro',
              'Describe a job in plain words and the model writes GRBL G-code for it. This runs entirely in your browser using your own API key (or a pasted login session) — there is no server.',
            )}
          />
        </div>
        <div className="ai-tools">
          <ToolButton
            className="ai-ico-danger"
            glyph={<Icon name="trash" />}
            disabled={chat.length === 0 || busy}
            onClick={() => {
              clearChat()
              setError(null)
              setLoadedId(null)
            }}
            title={t('ai.chat.clear', 'Clear chat')}
            body={t('ai.chat.clearTip', 'Clear this conversation (cannot be undone)')}
          />
          <span className="ai-tools-sep" aria-hidden="true" />
          <ToolButton
            className={showConnect ? 'is-active' : ''}
            glyph={<Icon name="settings" />}
            onClick={() => setShowConnect((v) => !v)}
            ariaExpanded={showConnect}
            title={t('ai.toolbar.connect', 'Connect AI')}
            body={t(
              'ai.toolbar.connect.body',
              'Provider and your API key or login session — needed before generating.',
            )}
          />
        </div>
      </header>

      {/* At-a-glance readiness strip: provider · model, credentials, bed, last lint. */}
      <div className="ai-status" role="status">
        <span className="ai-status-pill" title={t('ai.status.providerTip', 'Active provider and model')}>
          <b>{info.label}</b>
          <span className="ai-status-model">{model || t('ai.model.custom', 'Custom…')}</span>
        </span>
        <button
          type="button"
          className="ai-status-cred"
          data-ok={ready ? 'true' : 'false'}
          onClick={() => setShowConnect(true)}
          title={
            ready
              ? t('ai.status.credTipOk', 'Credentials are stored in this browser — click to open Connect AI')
              : t('ai.status.credTip', 'No credentials yet — click to open Connect AI and add them')
          }
        >
          <span className="ai-status-dot" aria-hidden="true" />
          {ready
            ? t('ai.status.readyAll', 'Ready')
            : t('ai.status.needsSetup', 'Needs setup')}
        </button>
        <span
          className="ai-status-pill"
          title={t('ai.status.bedTip', 'Machine bed (work area): {w} × {d} × {h} mm', {
            w: bedW,
            d: bedD,
            h: bedH,
          })}
        >
          {t('ai.ctx.bed', 'Bed')}{' '}
          <b>
            {bedW}×{bedD}
          </b>
        </span>
        {lastLevel && (
          <span
            className={`ai-status-lint ${lastLevel}`}
            title={t(
              'ai.status.lintTip',
              'Safety lint on the latest result — review the flagged lines before cutting.',
            )}
          >
            <Icon name={lastLevel === 'info' ? 'info' : 'warning'} size={12} />
            {lastLevel === 'info'
              ? t('ai.status.lintInfo', 'Lint note')
              : t('ai.status.lintCount', '{n} lint', { n: lastWarnCount })}
          </span>
        )}
      </div>

      {/* PROMINENT safety banner — AI output can be wrong/unsafe. */}
      <div className="ai-safety" role="note">
        <Icon name="warning" className="ai-safety-icon" size={16} />
        <span>
          {t(
            'ai.safety',
            'AI-generated G-code can be wrong or unsafe. ALWAYS review it in the Visualizer and dry-run (Z raised / spindle off) before cutting. Never run it unattended.',
          )}
        </span>
      </div>

      {/* ---- Connect AI: collapsible, self-contained provider + credentials ---- */}
      <section className="ai-connect" aria-label={t('ai.connect.aria', 'Connect AI')}>
        <button
          type="button"
          className="ai-connect-bar"
          aria-expanded={showConnect}
          onClick={() => setShowConnect((v) => !v)}
          title={t('ai.connect.toggleTip', 'Show or hide the AI connection settings')}
        >
          <Icon name={showConnect ? 'chevron-down' : 'chevron-right'} size={14} />
          <span className="ai-connect-title">{t('ai.connect.title', 'Connect AI')}</span>
          {/* Compact connected/needs-setup summary chip. */}
          {ready ? (
            <span className="ai-connect-chip ok" title={t('ai.connect.connectedTip', 'AI is configured and ready')}>
              <span className="ai-status-dot" aria-hidden="true" />
              {t('ai.connect.connected', 'Connected · {provider} · {mode}', {
                provider: info.label,
                mode:
                  effectiveAuthMode === 'key'
                    ? t('ai.auth.key', 'API key')
                    : t('ai.auth.session', 'Login session'),
              })}
            </span>
          ) : (
            <span className="ai-connect-chip warn">
              {t('ai.connect.needsSetup', 'Not connected — add credentials')}
            </span>
          )}
        </button>

        {showConnect && (
          <div className="ai-connect-body">
            {/* Provider segmented toggle. */}
            <div className="ai-field-block">
              <span className="ai-label ai-label-row">
                {t('ai.providerAria', 'AI provider')}
                <InfoTip
                  topic="aiProvider"
                  title={t('ai.providerAria', 'AI provider')}
                  body={t(
                    'ai.provider.info',
                    'Which AI service writes the G-code. Each provider keeps its own key, model choice and session in this browser.',
                  )}
                />
              </span>
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
            </div>

            {/* Auth-mode toggle: API key (recommended) vs session cookie (advanced).
                Session/cookie mode only works through a configured relay (CORS +
                HttpOnly cookies make the in-browser path impossible), so the toggle
                is shown ONLY when a relay is configured for this deployment. */}
            {RELAY_CONFIGURED && (
              <div className="ai-field-block">
                <span className="ai-label">{t('ai.auth.methodLabel', 'Authentication method')}</span>
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
                        ? t('ai.auth.keyRec', 'API key (recommended)')
                        : t('ai.auth.sessionAdv', 'Session cookie (advanced)')}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {effectiveAuthMode === 'key' ? (
              /* API key — masked, with soft format validation + stored confirmation. */
              <div className="ai-field-block">
                <span className="ai-label ai-label-row" id="ai-key-label">
                  {t('ai.key.label', '{provider} API key', { provider: info.label })}
                  <InfoTip
                    topic="aiApiKey"
                    title={t('ai.key.label', '{provider} API key', { provider: info.label })}
                    body={t(
                      'ai.key.info',
                      'Paste your own {provider} API key. It is stored only in this browser (localStorage) and sent only to {provider} with each request.',
                      { provider: info.label },
                    )}
                  />
                </span>
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
                    aria-labelledby="ai-key-label"
                  />
                  <IconButton
                    type="button"
                    className="ai-icon-btn"
                    iconName={showKey ? 'eye-off' : 'eye'}
                    onClick={() => setShowKey((v) => !v)}
                    label={showKey ? t('ai.key.hide', 'Hide key') : t('ai.key.show', 'Show key')}
                  />
                  {hasKey && (
                    <IconButton
                      type="button"
                      className="ai-icon-btn ai-icon-danger"
                      iconName="close"
                      onClick={() => clearCredentials(provider)}
                      label={t('ai.creds.clearTip', 'Remove the stored {provider} key from this browser', {
                        provider: info.label,
                      })}
                    />
                  )}
                </div>
                {!hasKey ? (
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
                ) : keyLooksWrong ? (
                  /* Soft inline format check — presentational only, never blocks sending. */
                  <p className="ai-note ai-error" role="status" aria-live="polite">
                    {t(
                      'ai.key.formatWarn',
                      'This does not look like an {provider} key (expected {hint}…) — double-check you copied the right one.',
                      { provider: info.label, hint: expectedPrefix },
                    )}
                  </p>
                ) : (
                  /* Positive confirmation that the key is stored. */
                  <p className="ai-note ai-ok" role="status" aria-live="polite">
                    ✓{' '}
                    {t(
                      'ai.key.note',
                      'Your key stays in this browser (localStorage) and is sent only to {provider}.',
                      { provider: info.label },
                    )}
                  </p>
                )}
              </div>
            ) : (
              /* Login session — paste (or import) your copied cookie; the long
                 export walkthrough lives behind a "How?" disclosure below. */
              <div className="ai-field-block">
                <span className="ai-label ai-label-row" id="ai-cookie-label">
                  {t('ai.session.label', '{site} login session', { site: info.site })}
                  <InfoTip
                    topic="aiSession"
                    title={t('ai.session.label', '{site} login session', { site: info.site })}
                    body={t(
                      'ai.session.info',
                      'Advanced: reuses your logged-in {site} session instead of an API key. The pasted cookie is stored only in this browser (localStorage) and forwarded only to the relay you configure below.',
                      { site: info.site },
                    )}
                  />
                </span>

                <p className="ai-note">
                  {t(
                    'ai.session.simple',
                    'Already logged in to {site}? Copy your cookie with a cookie extension (e.g. Cookie-Editor) and paste it below — no API key needed.',
                    { site: info.site },
                  )}{' '}
                  <button
                    type="button"
                    className="ai-link-btn"
                    aria-expanded={showCookieHelp}
                    onClick={() => setShowCookieHelp((v) => !v)}
                    title={t('ai.session.howTip', 'Show the step-by-step cookie export guide')}
                  >
                    {showCookieHelp ? t('ai.session.howHide', 'Hide guide') : t('ai.session.how', 'How?')}
                  </button>
                </p>

                {/* The long step-by-step export walkthrough, hidden by default. */}
                {showCookieHelp && (
                  <ol className="ai-guide" aria-label={t('ai.session.guideAria', 'Cookie export steps')}>
                    <li>
                      {t(
                        'ai.session.step1',
                        'Install a cookie-export extension such as “Cookie-Editor” or “EditThisCookie” in this browser.',
                      )}
                    </li>
                    <li>
                      {t('ai.session.step2', 'Open {site} in a new tab and make sure you are logged in.', {
                        site: info.site,
                      })}
                    </li>
                    <li>
                      {t(
                        'ai.session.step3',
                        'Click the extension on the {site} tab, then Export (as “Header String” or JSON / Netscape).',
                        { site: info.site },
                      )}
                    </li>
                    <li>
                      {t(
                        'ai.session.step4',
                        'Paste it in the box below, or save it as a .txt/.json file and use “Import cookie file”.',
                      )}
                    </li>
                    <li className="ai-warn-note">
                      {t(
                        'ai.session.step5',
                        'The cookie grants access to your {site} account — keep it private. It is stored only in this browser and sent only to your relay. Sessions expire, so re-export if it stops working.',
                        { site: info.site },
                      )}
                    </li>
                  </ol>
                )}

                {/* The one easy action: open the site, or import a saved cookie file. */}
                <div className="ai-row">
                  <a
                    className="ai-btn ai-grow"
                    href={`https://${info.site}/`}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={t('ai.session.openTip', 'Open {site} in a new tab and log in', { site: info.site })}
                  >
                    <Icon name="upload" size={14} />
                    {t('ai.session.openLogin', 'Open {site}', { site: info.site })}
                  </a>
                  <button
                    type="button"
                    className="ai-btn ai-grow"
                    onClick={() => cookieFileRef.current?.click()}
                    title={t(
                      'ai.session.importTip',
                      'Import a cookie file you saved from a cookie extension (.txt or .json)',
                    )}
                  >
                    <Icon name="download" size={14} />
                    {t('ai.session.import', 'Import cookie file')}
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

                <textarea
                  id="ai-cookie"
                  className="ai-textarea ai-mono"
                  rows={3}
                  value={sessionCookie}
                  placeholder={t('ai.session.cookiePlaceholder', 'paste the cookie you copied (header string or JSON both work)')}
                  spellCheck={false}
                  onChange={(e) => {
                    const val = e.target.value
                    // Automatically parse if pasted text is JSON or Netscape format.
                    const parsed = parseCookieFile(val)
                    setSessionCookie(provider, parsed || val)
                  }}
                  aria-labelledby="ai-cookie-label"
                />
                {hasSession && (
                  /* Positive confirmation that the cookie is stored. */
                  <p className="ai-note ai-ok" role="status" aria-live="polite">
                    ✓{' '}
                    {t(
                      'ai.session.stored',
                      'Your cookie stays in this browser (localStorage). If the session expires, paste a fresh one.',
                    )}
                  </p>
                )}

                {/* Relay/proxy URL — required for session mode (the cookie is forwarded
                    to it as X-Session-Cookie; a direct browser call is CORS-blocked).
                    Defaults to the build-time VITE_AI_RELAY_URL; override for self-host. */}
                <span className="ai-label ai-sublabel ai-label-row" id="ai-proxy-label">
                  {t('ai.session.proxyLabel', 'Relay / proxy URL')}
                  <InfoTip
                    topic="aiRelay"
                    title={t('ai.session.proxyLabel', 'Relay / proxy URL')}
                    body={t(
                      'ai.session.proxyNote',
                      'The pasted cookie is sent to this relay as X-Session-Cookie; it re-attaches it server-side. Leave blank to use the deployment default.',
                    )}
                  />
                </span>
                <input
                  id="ai-proxy"
                  className="ai-input ai-mono"
                  type="url"
                  value={proxyUrl}
                  placeholder={DEFAULT_RELAY_URL || 'https://your-relay.example.com'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setProxyUrl(provider, e.target.value)}
                  aria-labelledby="ai-proxy-label"
                />

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
                      <Icon name="close" size={13} />
                      {t('ai.creds.clearSession', 'Clear stored cookie')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Model & machine context — advanced, collapsed disclosure. */}
            <div className="ai-field-block">
              <button
                type="button"
                className="ai-link-btn ai-context-toggle"
                aria-expanded={showContext}
                onClick={() => setShowContext((v) => !v)}
                title={t('ai.context.toggleTip', 'Choose the model and add optional tool / material context')}
              >
                <Icon name={showContext ? 'chevron-down' : 'chevron-right'} size={13} />
                {t('ai.setup.short', 'Model & context')}
                <span className="ai-context-summary">
                  {model || t('ai.model.custom', 'Custom…')}
                </span>
              </button>
              {showContext && (
                <div className="ai-fields">
                  <label className="ai-fields-wide" htmlFor="ai-model">
                    {t('ai.model.label', 'Model')}
                    <select
                      id="ai-model"
                      className="ai-input"
                      value={isCustomModel ? '__custom__' : model}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v !== '__custom__') setModel(provider, v)
                        else setModel(provider, '')
                      }}
                      aria-label={t('ai.model.aria', 'Model')}
                    >
                      {MODEL_OPTIONS[provider].map((m) => (
                        <option key={m} value={m}>
                          {m === DEFAULT_MODELS[provider] ? t('ai.model.default', '{m} (default)', { m }) : m}
                        </option>
                      ))}
                      <option value="__custom__">{t('ai.model.custom', 'Custom…')}</option>
                    </select>
                  </label>
                  {/* The free-text model id only appears when "Custom…" is selected. */}
                  {isCustomModel && (
                    <label className="ai-fields-wide">
                      {t('ai.model.custom', 'Custom…')}
                      <input
                        className="ai-input ai-mono"
                        type="text"
                        value={model}
                        placeholder={t('ai.model.customPlaceholder', 'custom model id')}
                        spellCheck={false}
                        onChange={(e) => setModel(provider, e.target.value)}
                        aria-label={t('ai.model.customAria', 'Custom model id')}
                      />
                    </label>
                  )}
                  <label>
                    {t('ai.ctx.toolAria', 'Tool (optional)')}
                    <input
                      className="ai-input"
                      type="text"
                      value={tool}
                      placeholder={t('ai.ctx.toolPlaceholder', 'e.g. 3mm flat endmill')}
                      onChange={(e) => setTool(e.target.value)}
                      aria-label={t('ai.ctx.toolAria', 'Tool (optional)')}
                    />
                  </label>
                  <label>
                    {t('ai.ctx.matAria', 'Material (optional)')}
                    <input
                      className="ai-input"
                      type="text"
                      value={material}
                      placeholder={t('ai.ctx.matPlaceholder', 'e.g. MDF, plywood')}
                      onChange={(e) => setMaterial(e.target.value)}
                      aria-label={t('ai.ctx.matAria', 'Material (optional)')}
                    />
                  </label>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ---- Chat conversation (the primary task — dominant region) ---- */}
      <section className="ai-chat" aria-label={t('ai.chat.label', 'Chat')}>
        {/* Thread (browser-cached; iterate by chatting). */}
        <div className="ai-thread" ref={threadRef} aria-label={t('ai.chat.threadAria', 'Conversation')}>
          {chat.length === 0 && !busy && (
            <div className="ai-thread-empty">
              <Icon name="info" size={22} className="ai-empty-icon" />
              <p className="ai-empty-lead">
                {t(
                  'ai.chat.emptyShort',
                  'Describe what you want to make, then keep chatting to refine it.',
                )}
              </p>
              <p className="ai-empty-sub">
                {t('ai.chat.emptyTry', 'Try one of these:')}
              </p>
              <div className="ai-chips" role="group" aria-label={t('ai.examples.aria', 'Example prompts')}>
                {exampleChips.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    className="ai-chip"
                    onClick={() => setPrompt(c.fill)}
                    title={c.fill}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {chat.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ai-msg-row user">
                <div className="ai-msg user">
                  <div className="ai-msg-role">{t('ai.chat.you', 'You')}</div>
                  <div className="ai-msg-text">{m.content}</div>
                </div>
              </div>
            ) : (
              <div key={m.id} className="ai-msg-row assistant">
                <div className="ai-msg assistant">
                  <div className="ai-msg-role">
                    <Icon name="spindle" size={12} className="ai-msg-role-icon" />
                    {info.label}
                  </div>
                  {m.gcode ? (
                    <>
                      <pre className="ai-code" aria-label={t('ai.out.codeAria', 'Generated G-code')}>
                        {m.gcode}
                      </pre>
                      {m.warnings && m.warnings.length > 0 && (
                        <ul className="ai-warnings" aria-label={t('ai.out.warnAria', 'Safety lint warnings')}>
                          {m.warnings.map((w, i) => (
                            <li key={i} className={`ai-warn-item ${w.level}`}>
                              <Icon name={w.level === 'info' ? 'info' : 'warning'} size={13} className="ai-warn-icon" />{' '}
                              {translateWarning(t, w)}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="ai-row ai-msg-actions">
                        <button
                          type="button"
                          className="ai-btn primary ai-grow"
                          onClick={() => loadIntoProgram(m)}
                          title={t(
                            'ai.loadTip',
                            'Load this G-code into the Program tab so it shows in the Visualizer for review',
                          )}
                        >
                          <Icon name="upload" size={14} />
                          {t('ai.load', 'Send to Program')}
                        </button>
                        {/* Copy confirmation is transient IN-BUTTON feedback (check /
                            warning swap) so the thread never shifts; an offscreen
                            live region below announces it for screen readers. */}
                        {copyState?.id === m.id ? (
                          <IconButton
                            type="button"
                            className={`ai-icon-btn ${copyState.ok ? 'ai-icon-ok' : 'ai-icon-danger'}`}
                            icon={copyState.ok ? CHECK_GLYPH : <Icon name="warning" size={16} />}
                            onClick={() => copyGcode(m)}
                            label={
                              copyState.ok
                                ? t('ai.copied', 'Copied to clipboard.')
                                : t('ai.copyFail', 'Could not copy — select the code and copy it manually.')
                            }
                          />
                        ) : (
                          <IconButton
                            type="button"
                            className="ai-icon-btn"
                            iconName="copy"
                            onClick={() => copyGcode(m)}
                            label={t('ai.copyTip', 'Copy the G-code to the clipboard')}
                          />
                        )}
                      </div>
                      {loadedId === m.id && (
                        <p className="ai-note ai-ok" role="status" aria-live="polite">
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
              </div>
            ),
          )}
          {busy && (
            <div className="ai-msg-row assistant">
              <div className="ai-msg assistant">
                <div className="ai-msg-role">
                  <Icon name="spindle" size={12} className="ai-msg-role-icon" />
                  {info.label}
                </div>
                <p className="ai-note ai-busy" role="status" aria-live="polite">
                  <span className="ai-spinner" aria-hidden="true" />
                  {t('ai.busy', 'Asking {provider}…', { provider: info.label })}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Offscreen live region: announces copy results without moving the thread. */}
        <span className="ai-sr-only" role="status" aria-live="polite">
          {copyState
            ? copyState.ok
              ? t('ai.copied', 'Copied to clipboard.')
              : t('ai.copyFail', 'Could not copy — select the code and copy it manually.')
            : ''}
        </span>

        {error && (
          <p className="ai-note ai-error ai-compose-error" role="alert">
            {error}
            {effectiveAuthMode === 'key' && !hasKey && (
              <>
                {' '}
                <a href={info.keyUrl} target="_blank" rel="noreferrer noopener">
                  {t('ai.key.get', 'Get a key')}
                </a>
              </>
            )}
          </p>
        )}

        {/* Composer pinned at the bottom. Enter sends; Shift+Enter for a newline. */}
        <div className="ai-composer">
          <textarea
            id="ai-prompt"
            className="ai-textarea ai-composer-input"
            rows={2}
            value={prompt}
            placeholder={
              chat.length === 0
                ? t('ai.prompt.placeholder', 'Describe what to make…')
                : t('ai.chat.followupPlaceholder', 'Refine the code above…')
            }
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (!busy && prompt.trim()) run()
              }
            }}
            aria-label={t('ai.prompt.aria', 'Message')}
          />
          <div className="ai-composer-row">
            <span className="ai-composer-hint">
              {t('ai.composer.hint', 'Enter to send · Shift+Enter for a new line')}
            </span>
            {busy ? (
              <button
                type="button"
                className="ai-btn ai-send"
                onClick={cancel}
                title={t('ai.cancelTip', 'Cancel the in-flight request')}
              >
                <Icon name="stop" size={13} />
                {t('ai.cancel', 'Cancel')}
              </button>
            ) : (
              <button
                type="button"
                className="ai-btn primary ai-send"
                onClick={() => run()}
                disabled={!prompt.trim()}
                title={t('ai.sendTip', 'Send to {provider} (Enter)', { provider: info.label })}
              >
                <Icon name={chat.length === 0 ? 'play' : 'chevron-right'} size={14} />
                {chat.length === 0
                  ? t('ai.generate', 'Generate')
                  : t('ai.send', 'Send')}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
