// AI G-code generation core — UI-independent, provider-agnostic.
//
// AUTH MODES (both BYOK in spirit — nothing is hardcoded, all user-supplied):
//
//  1. 'key'  — the user pastes their OWN OpenAI / Anthropic API key and we call
//     the official REST API directly from the browser. This is the recommended,
//     fully-working default.
//
//  2. 'session' — ADVANCED. The user manually exports their logged-in
//     claude.ai / chatgpt.com session cookie (via a cookie-export browser
//     extension) and pastes it here. We CANNOT read that cookie ourselves
//     (cross-origin HttpOnly cookies are invisible to our JS), and a browser
//     `fetch` may not set the `Cookie` header nor read a cross-origin response
//     that lacks CORS headers — so this mode sends the pasted cookie as an
//     `X-Session-Cookie` header to a USER-SUPPLIED relay/proxy URL that
//     re-attaches it server-side and returns CORS-friendly responses. Without
//     such a relay, the providers' first-party web endpoints are CORS-blocked.
//
// Keys/cookies are NEVER hardcoded and never logged — the caller passes them in
// per request. This module is pure (no React/DOM) so it mirrors src/core/.

/** Provider identifier. */
export type Provider = 'openai' | 'anthropic'

/** How the request authenticates. */
export type AuthMode = 'key' | 'session'

/** Machine / job context used to build the system prompt and lint envelope. */
export interface MachineContext {
  /** Work-area bed size in mm (centered on the work origin). */
  bed: { width: number; depth: number; height: number }
  /** Optional free-text tool description (e.g. "3mm 2-flute flat endmill"). */
  tool?: string
  /** Optional material description (e.g. "MDF", "FR-1 copper-clad"). */
  material?: string
  /** Optional stock description (e.g. "100x60x6mm board, top-left origin"). */
  stock?: string
}

/** One turn in the chat conversation sent to the model. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Arguments shared by both provider calls. */
export interface CallArgs {
  apiKey: string
  model: string
  system: string
  /**
   * The conversation so far (oldest→newest), enabling multi-turn iteration on
   * the latest code. Must start with a 'user' turn and end with a 'user' turn.
   */
  messages: ChatMessage[]
  /** Abort signal so the UI can cancel an in-flight request. */
  signal?: AbortSignal
}

/**
 * Default relay endpoint used in session (cookie) mode when the app config
 * doesn't override it. A browser CANNOT post a pasted cross-origin cookie
 * straight to claude.ai / chatgpt.com (CORS + forbidden `Cookie` header), so
 * the cookie is forwarded as `X-Session-Cookie` to this relay, which re-attaches
 * it server-side and returns CORS-friendly responses. The user never sees or
 * configures this — they just paste their cookie.
 *
 * Configure at build time with VITE_AI_RELAY_URL; otherwise this empty default
 * means "no relay available", and session mode reports that clearly.
 */
export const DEFAULT_RELAY_URL: string =
  (import.meta.env?.VITE_AI_RELAY_URL as string | undefined)?.replace(/\/+$/, '') ?? ''

/** Auth + endpoint options layered on top of CallArgs. */
export interface AuthOptions {
  /** 'key' (official API) or 'session' (pasted cookie via the relay). */
  mode: AuthMode
  /**
   * session mode: the logged-in claude.ai / chatgpt.com cookie the user pasted
   * (exported via a cookie extension). Sent as `X-Session-Cookie` to the relay.
   */
  sessionCookie?: string
  /**
   * session mode: relay base URL. Optional — defaults to DEFAULT_RELAY_URL so
   * the user only has to paste their cookie. Set only for self-hosting.
   */
  proxyUrl?: string
}

/** A warning surfaced by the safety lint pass. */
export interface LintWarning {
  /** Coarse class — drives the icon/severity in the UI. */
  level: 'error' | 'warn' | 'info'
  message: string
}

/** Result of the safety lint pass. */
export interface LintResult {
  /** The cleaned G-code (with any required preamble prepended). */
  cleaned: string
  warnings: LintWarning[]
}

// --------------------------------------------------------------------------
// System prompt
// --------------------------------------------------------------------------

/**
 * Build the system prompt. Instructs the model to output ONLY safe GRBL G-code
 * for the given machine context, in a single fenced block with brief comments.
 * The safety rules mirror src/core/gcodeEmitter.ts (the hand-written emitter).
 */
export function buildSystemPrompt(ctx: MachineContext): string {
  const { width, depth, height } = ctx.bed
  const lines: string[] = [
    'You are an expert CNC/CAM programmer for a hobby 3-axis GRBL machine.',
    'Generate G-code that is SAFE for a desktop GRBL controller. Follow EVERY rule:',
    '',
    'OUTPUT FORMAT:',
    '- Output ONLY the G-code, inside a SINGLE fenced code block (```gcode ... ```).',
    '- No prose, explanation, or text before/after the block.',
    '- Use brief `(parenthetical comments)` to label sections — GRBL comment style.',
    '',
    'SAFETY (mandatory):',
    '- Begin the program with `G21 G90 G94 G17` (mm, absolute, units/min feed, XY plane).',
    '- Always RETRACT to a safe Z height (Z+5 or higher, positive, above the stock)',
    '  BEFORE any rapid XY travel, and again at the very end of the program.',
    '- Never plunge in Z and move in XY in the same line.',
    '- Use conservative feeds (cutting feed <= 1000 mm/min, plunge feed <= 300 mm/min).',
    '- Never emit `-0.000`; write `0` for zero values.',
    '- End the program by retracting to safe Z, stopping the spindle (M5), then M2 or M30.',
    '',
    'SPINDLE / PEN:',
    '- For cutting: turn the spindle on with M3 S<rpm> before cutting, M5 at the end.',
    '- For pen-plotting / drawing: do NOT use the spindle; raise/lower the pen with Z',
    '  (Z up = pen up travel height, Z down = drawing height) and say so in a comment.',
    '',
    'MACHINE CONTEXT:',
    `- Work area (bed): ${width} x ${depth} x ${height} mm.`,
    '- Coordinates are centered on the work origin: usable XY is',
    `  X ${-width / 2}..${width / 2}, Y ${-depth / 2}..${depth / 2}; Z 0..${height} (Z- cuts into stock).`,
    '- Keep ALL coordinates inside this envelope.',
  ]
  if (ctx.tool) lines.push(`- Tool: ${ctx.tool}.`)
  if (ctx.material) lines.push(`- Material: ${ctx.material}.`)
  if (ctx.stock) lines.push(`- Stock: ${ctx.stock}.`)
  lines.push(
    '',
    'If the request is ambiguous, pick safe, conservative defaults and note them in a comment.',
  )
  return lines.join('\n')
}

// --------------------------------------------------------------------------
// Provider calls
// --------------------------------------------------------------------------

/** Turn a fetch failure / non-OK response into a helpful, user-facing Error. */
async function explainHttpError(provider: Provider, res: Response): Promise<Error> {
  let detail = ''
  try {
    const body = await res.json()
    detail = body?.error?.message || body?.error?.type || JSON.stringify(body)
  } catch {
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
  }
  const where = provider === 'openai' ? 'OpenAI' : 'Anthropic'
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `${where} rejected the credentials (HTTP ${res.status}). Check your API key — ` +
        `or, in session mode, that the pasted cookie is fresh (re-export it; sessions ` +
        `expire) and the proxy forwards it correctly.`,
    )
  }
  if (res.status === 429) {
    return new Error(
      `${where} rate-limit / quota exceeded (HTTP 429). You may be out of credits or sending too fast. ${detail}`.trim(),
    )
  }
  return new Error(`${where} API error (HTTP ${res.status}). ${detail}`.trim())
}

/** Map a thrown fetch error (network/CORS/abort) to a clearer message. */
function explainNetworkError(provider: Provider, err: unknown): Error {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new Error('Request cancelled.')
  }
  const where = provider === 'openai' ? 'OpenAI' : 'Anthropic'
  // A TypeError from fetch with no HTTP status is almost always a network /
  // CORS / offline failure (the browser hides the real cause for security).
  if (err instanceof TypeError) {
    return new Error(
      `Could not reach ${where}. This is usually no internet connection, a browser ` +
        `extension blocking the request, or a CORS block. Check your connection and try again.`,
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Resolve the endpoint URL + auth headers for a provider, honoring the auth
 * mode. In 'session' mode the request is routed through the relay (the app's
 * built-in DEFAULT_RELAY_URL, or a self-host override) with the pasted cookie
 * as `X-Session-Cookie`; the relay re-attaches it server-side and exposes the
 * same path the official API uses. The user only pastes a cookie.
 */
function resolveEndpoint(
  provider: Provider,
  path: string,
  baseHeaders: Record<string, string>,
  auth: AuthOptions,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  if (auth.mode === 'session') {
    const cookie = (auth.sessionCookie ?? '').trim()
    if (!cookie) {
      throw new Error('Paste your session cookie first.')
    }
    // Default to the local proxy URL (http://localhost:3000) if no custom URL or default build-time URL is set.
    const base = ((auth.proxyUrl ?? '').trim() || DEFAULT_RELAY_URL || 'http://localhost:3000').replace(/\/+$/, '')
    return {
      url: `${base}${path}`,
      headers: { ...baseHeaders, 'X-Session-Cookie': cookie },
    }
  }
  // key mode → official endpoint + key header.
  if (!apiKey.trim()) {
    throw new Error('Add your API key first.')
  }
  const host = provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com'
  return { url: `${host}${path}`, headers: baseHeaders }
}

/** Call the OpenAI Chat Completions API (or its proxy mirror). */
export async function callOpenAI(args: CallArgs & AuthOptions): Promise<string> {
  const { apiKey, model, system, messages, signal } = args

  if (args.mode === 'session') {
    const cookie = (args.sessionCookie ?? '').trim()
    let accessToken: string;
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      }
      if (cookie) {
        headers['X-Session-Cookie'] = cookie;
      }
      const sessionRes = await fetch('https://chatgpt.com/api/auth/session', {
        headers,
        credentials: 'include',
        signal,
      });

      if (!sessionRes.ok) {
        throw new Error(`Failed to authenticate session: HTTP ${sessionRes.status}`);
      }

      const sessionData: any = await sessionRes.json();
      accessToken = sessionData.accessToken;
      if (!accessToken) {
        throw new Error('No access token returned in session. Make sure you are logged in to chatgpt.com.');
      }
    } catch (err: any) {
      throw new Error(`Session auth error: ${err.message}`);
    }

    try {
      const systemMessage = messages.find((m: any) => m.role === 'system')?.content || '';
      const userMessages = messages.filter((m: any) => m.role === 'user');
      const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';
      const prompt = systemMessage ? `${systemMessage}\n\nUser request: ${lastUserMessage}` : lastUserMessage;

      const modelName = model === 'gpt-4o-mini' ? 'gpt-4o-mini' : 'auto';
      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();

      const chatRes = await fetch('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        credentials: 'include',
        body: JSON.stringify({
          action: 'next',
          messages: [
            {
              id: uuid1,
              author: { role: 'user' },
              content: { content_type: 'text', parts: [prompt] },
              metadata: {},
            },
          ],
          parent_message_id: uuid2,
          model: modelName,
          timezone_offset_min: -330,
          suggestions: [],
          history_and_training_disabled: true,
          conversation_mode: 'kindle',
        }),
        signal,
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        throw new Error(`ChatGPT API error: HTTP ${chatRes.status}. ${errText}`);
      }

      const reader = chatRes.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let responseText = '';
      let done = false;

      if (!reader) {
        throw new Error('Response body is empty');
      }

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              done = true;
              break;
            }
            try {
              const parsed = JSON.parse(dataStr);
              const part = parsed?.message?.content?.parts?.[0];
              if (typeof part === 'string') {
                responseText = part;
              }
            } catch {
              // Ignore intermediate parse errors
            }
          }
        }
      }

      if (!responseText) {
        throw new Error('ChatGPT returned an empty response.');
      }

      return responseText;
    } catch (err: any) {
      throw explainNetworkError('openai', err);
    }
  }

  // Official API key mode
  const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (args.mode === 'key') baseHeaders.Authorization = `Bearer ${apiKey}`
  const { url, headers } = resolveEndpoint(
    'openai',
    '/v1/chat/completions',
    baseHeaders,
    args,
    apiKey,
  )
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: 0.2,
      }),
      signal,
    })
  } catch (err) {
    throw explainNetworkError('openai', err)
  }
  if (!res.ok) throw await explainHttpError('openai', res)
  const data = await res.json()
  const text: unknown = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('OpenAI returned an empty response.')
  }
  return text
}

/** Call the Anthropic Messages API (or its proxy mirror). */
export async function callAnthropic(args: CallArgs & AuthOptions): Promise<string> {
  const { apiKey, model, system, messages, signal } = args

  if (args.mode === 'session') {
    let orgId: string;
    try {
      const orgRes = await fetch('https://claude.ai/api/organizations', {
        headers: {
          'Accept': 'application/json',
        },
        credentials: 'include',
        signal,
      });

      if (!orgRes.ok) {
        throw new Error(`Failed to fetch Claude organizations: HTTP ${orgRes.status}`);
      }

      const orgs: any = await orgRes.json();
      if (!Array.isArray(orgs) || orgs.length === 0) {
        throw new Error('No organizations found for this Claude session. Make sure you are logged in to claude.ai.');
      }
      orgId = orgs[0].uuid;
    } catch (err: any) {
      throw new Error(`Claude org fetch error: ${err.message}`);
    }

    let conversationId: string;
    try {
      const convUuid = crypto.randomUUID();
      const convRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          uuid: convUuid,
          name: '',
        }),
        signal,
      });

      if (!convRes.ok) {
        throw new Error(`Failed to create Claude conversation: HTTP ${convRes.status}`);
      }

      const convData: any = await convRes.json();
      conversationId = convData.uuid;
    } catch (err: any) {
      throw new Error(`Claude conversation creation error: ${err.message}`);
    }

    try {
      const systemMessage = system || '';
      const userMessages = messages.filter((m: any) => m.role === 'user');
      const lastUserMessage = userMessages[userMessages.length - 1]?.content || '';
      const prompt = systemMessage ? `${systemMessage}\n\nUser request: ${lastUserMessage}` : lastUserMessage;

      const modelName = model || 'claude-3-5-sonnet-latest';

      const chatRes = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        credentials: 'include',
        body: JSON.stringify({
          prompt: prompt,
          timezone: 'UTC',
          model: modelName,
          rendering_mode: 'raw',
        }),
        signal,
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        throw new Error(`Claude Web API error: HTTP ${chatRes.status}. ${errText}`);
      }

      const reader = chatRes.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let responseText = '';
      let done = false;

      if (!reader) {
        throw new Error('Response body is empty');
      }

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            try {
              const parsed = JSON.parse(dataStr);
              if (typeof parsed?.completion === 'string') {
                responseText += parsed.completion;
              }
            } catch {
              // Ignore parse errors on intermediate lines
            }
          }
        }
      }

      if (!responseText) {
        throw new Error('Claude returned an empty response.');
      }

      return responseText;
    } catch (err: any) {
      throw explainNetworkError('anthropic', err);
    }
  }

  // Official API key mode
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (args.mode === 'key') {
    baseHeaders['x-api-key'] = apiKey
    baseHeaders['anthropic-dangerous-direct-browser-access'] = 'true'
  }
  const { url, headers } = resolveEndpoint('anthropic', '/v1/messages', baseHeaders, args, apiKey)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.2,
        system,
        messages,
      }),
      signal,
    })
  } catch (err) {
    throw explainNetworkError('anthropic', err)
  }
  if (!res.ok) throw await explainHttpError('anthropic', res)
  const data = await res.json()
  const blocks: unknown = data?.content
  let text = ''
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        text += (b as { text?: string }).text ?? ''
      }
    }
  }
  if (!text.trim()) throw new Error('Anthropic returned an empty response.')
  return text
}

/** Dispatch to the chosen provider. */
export async function generate(
  provider: Provider,
  args: CallArgs & AuthOptions,
): Promise<string> {
  return provider === 'openai' ? callOpenAI(args) : callAnthropic(args)
}

// --------------------------------------------------------------------------
// Cookie-file parsing (for the "Import cookie file" convenience button)
// --------------------------------------------------------------------------

/**
 * Normalize the various cookie-export formats a user might upload into a single
 * `name=value; name2=value2` header string ready to send to a relay:
 *
 *  - Netscape `cookies.txt` (tab-separated, one cookie per line, `# ` comments)
 *    — what "Get cookies.txt" exports.
 *  - JSON arrays of `{name, value}` objects — what "Cookie-Editor"/"EditThisCookie"
 *    export.
 *  - A raw `name=value; ...` header string (already in the right shape).
 *
 * Pure string→string; never throws (returns '' if nothing parseable). It only
 * reformats text the user supplied — it cannot and does not read any cookie.
 */
export function parseCookieFile(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  // 1) JSON array of cookie objects.
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed)
      const arr = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : []
      const pairs = (arr as unknown[])
        .filter((c): c is { name: string; value: string } =>
          !!c && typeof c === 'object' &&
          typeof (c as { name?: unknown }).name === 'string' &&
          typeof (c as { value?: unknown }).value === 'string',
        )
        .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
      if (pairs.length) return pairs.join('; ')
    } catch {
      /* fall through to other formats */
    }
  }

  // 2) Netscape cookies.txt — tab-separated, `domain \t flag \t path \t secure
  //    \t expiry \t name \t value`. Skip comments/blank lines.
  const tabLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('\t'))
  if (tabLines.length) {
    const pairs: string[] = []
    for (const l of tabLines) {
      const cols = l.split('\t')
      if (cols.length >= 7) pairs.push(`${cols[5]}=${cols[6]}`)
    }
    if (pairs.length) return pairs.join('; ')
  }

  // 3) Already a `name=value; ...` header string — collapse whitespace/newlines.
  if (/[^=;\s]+=[^;]*/.test(trimmed)) {
    return trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join('; ')
      .replace(/;\s*;/g, ';')
  }

  return ''
}

// --------------------------------------------------------------------------
// Extract G-code from a model response
// --------------------------------------------------------------------------

/**
 * Strip markdown fences and prose, returning just the G-code lines. If the
 * model wrapped the code in a ```...``` fence we take the (longest) fenced
 * block; otherwise we keep lines that look like G-code or GRBL comments and
 * drop obvious prose.
 */
export function extractGcode(text: string): string {
  // Prefer fenced blocks (```gcode / ```nc / ``` ...).
  const fence = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g
  const blocks: string[] = []
  let m: RegExpExecArray | null
  while ((m = fence.exec(text)) !== null) blocks.push(m[1])
  if (blocks.length) {
    // Pick the longest block (the actual program, not a tiny inline snippet).
    blocks.sort((a, b) => b.length - a.length)
    return blocks[0].replace(/\s+$/, '').replace(/^\s*\n/, '')
  }

  // No fence: heuristically keep code-ish lines.
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      out.push('')
      continue
    }
    const isComment = line.startsWith('(') || line.startsWith(';')
    // G-code-ish: starts with a word letter followed by a number, optionally
    // line-numbered (N10 G1 ...).
    const isCode = /^(N\d+\s*)?[GMTFSXYZIJKRP][-\d.]/i.test(line)
    if (isComment || isCode) out.push(raw)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// --------------------------------------------------------------------------
// Safety lint
// --------------------------------------------------------------------------

/** Strip a GRBL comment (`(...)` or `; ...`) from a line for token scanning. */
function stripComment(line: string): string {
  return line.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim()
}

/** Parse a numeric axis word (e.g. "X-12.5") from a code line; undefined if absent. */
function axisWord(code: string, axis: 'X' | 'Y' | 'Z'): number | undefined {
  const m = new RegExp(`${axis}(-?\\d+(?:\\.\\d+)?)`, 'i').exec(code)
  return m ? parseFloat(m[1]) : undefined
}

/**
 * SAFETY lint pass. Operates on extracted G-code:
 *  - ensures the `G21 G90 G94` preamble exists (PREPENDS it if missing);
 *  - checks for a safe-Z (positive Z) retract before lateral travel and at end;
 *  - flags absurd feed rates;
 *  - flags X/Y/Z coordinates outside the bed envelope.
 * Returns the cleaned text + a list of warnings. NEVER throws.
 */
export function lintGcode(
  text: string,
  opts: { bed: { width: number; depth: number; height: number } },
): LintResult {
  const warnings: LintWarning[] = []
  const { width, depth, height } = opts.bed
  const halfW = width / 2
  const halfD = depth / 2

  // Normalize: drop trailing whitespace, fix a *negative zero* ("-0", "-0.0",
  // "-0.000") → "0". The negative-lookahead is critical: it must NOT touch
  // "-0.5" (a real value) by matching only its "-0" prefix, which would flip
  // the sign and turn a downward Z plunge into an upward move.
  let lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/-0(?:\.0+)?(?![.\d])/g, '0').replace(/\s+$/, ''))

  const upper = text.toUpperCase()
  const hasG21 = /\bG21\b/.test(upper)
  const hasG90 = /\bG90\b/.test(upper)
  const hasG94 = /\bG94\b/.test(upper)

  // PREPEND any missing required modal preamble.
  const missing: string[] = []
  if (!hasG21) missing.push('G21')
  if (!hasG90) missing.push('G90')
  if (!hasG94) missing.push('G94')
  if (missing.length) {
    lines = [
      '(--- safety preamble added by AI G-code lint ---)',
      `${missing.join(' ')}${!/\bG17\b/.test(upper) ? ' G17' : ''}`,
      ...lines,
    ]
    warnings.push({
      level: 'info',
      message: `Prepended missing safety preamble: ${missing.join(' ')}.`,
    })
  }

  // Scan the body: track Z, detect lateral moves below safe-Z, envelope, feeds.
  let lastZ: number | undefined
  let sawLateral = false
  let sawSafeRetract = false
  let unsafeTravelReported = false

  for (const raw of lines) {
    const code = stripComment(raw).toUpperCase()
    if (!code) continue

    const x = axisWord(code, 'X')
    const y = axisWord(code, 'Y')
    const z = axisWord(code, 'Z')
    if (z !== undefined) lastZ = z

    // Envelope check (centered bed).
    if (x !== undefined && (x < -halfW - 1e-6 || x > halfW + 1e-6)) {
      warnings.push({
        level: 'error',
        message: `X${x} is outside the bed (X must be ${-halfW}..${halfW} mm): ${raw.trim()}`,
      })
    }
    if (y !== undefined && (y < -halfD - 1e-6 || y > halfD + 1e-6)) {
      warnings.push({
        level: 'error',
        message: `Y${y} is outside the bed (Y must be ${-halfD}..${halfD} mm): ${raw.trim()}`,
      })
    }
    if (z !== undefined && z > height + 1e-6) {
      warnings.push({
        level: 'error',
        message: `Z${z} is above the work height (Z max ${height} mm): ${raw.trim()}`,
      })
    }

    // Feed-rate sanity.
    const fm = /F(\d+(?:\.\d+)?)/.exec(code)
    if (fm) {
      const feed = parseFloat(fm[1])
      if (feed > 5000) {
        warnings.push({
          level: 'warn',
          message: `Feed F${feed} mm/min looks very high — verify it is safe: ${raw.trim()}`,
        })
      } else if (feed <= 0) {
        warnings.push({
          level: 'warn',
          message: `Feed F${feed} is not positive: ${raw.trim()}`,
        })
      }
    }

    // Lateral travel: an XY move. The worry is a RAPID (G0) across the work
    // while the tool is at/below the surface (Z <= 0).
    const movesXY = x !== undefined || y !== undefined
    if (movesXY) {
      sawLateral = true
      const rapid = /\bG0\b/.test(code) || /\bG00\b/.test(code)
      if (rapid && (lastZ === undefined || lastZ < 0) && !unsafeTravelReported) {
        warnings.push({
          level: 'warn',
          message:
            'A rapid XY travel happens while Z may be at/below the surface — make sure the tool retracts to a safe Z before rapids.',
        })
        unsafeTravelReported = true
      }
    }

    // Did we ever retract to a positive (safe) Z?
    if (z !== undefined && z > 0) sawSafeRetract = true
  }

  if (sawLateral && !sawSafeRetract) {
    warnings.push({
      level: 'warn',
      message:
        'No safe-Z retract (a positive Z move) found — verify the tool lifts above the stock before/after travel.',
    })
  }

  // End-of-program safe-Z: the last Z we saw should be positive.
  if (sawLateral && lastZ !== undefined && lastZ < 0) {
    warnings.push({
      level: 'warn',
      message: 'Program may end with Z below the surface — add a safe-Z retract at the end.',
    })
  }

  return { cleaned: lines.join('\n').replace(/\n{3,}/g, '\n\n'), warnings }
}
