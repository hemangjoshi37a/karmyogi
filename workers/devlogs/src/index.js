/**
 * karmyogi-devlogs — Cloudflare Worker backend for the @hemangjoshi37a/dev-logs
 * bug-report / feature-request overlay embedded in the karmyogi app.
 *
 * The overlay (loaded from `<endpoint>/overlay.js`) does two things against this
 * backend, deriving the origin from its own <script> src:
 *
 *   1. POST `<origin>/api/requests`
 *        Content-Type: application/json
 *        body: { title, description, priority, category, submitted_by, platform }
 *        It reads `response.request.id` from the JSON we return and uses it for
 *        any follow-up attachment upload.
 *
 *   2. POST `<origin>/api/requests/:id/attachments`
 *        Content-Type: multipart/form-data  (one or more files)
 *
 * It also serves `<origin>/overlay.js` (the overlay bundle itself).
 *
 * Storage: every report is written to Cloudflare KV under a timestamped key
 * (`report:<ISO-ts>:<id>`). Optionally, if GITHUB_TOKEN + GITHUB_REPO are set as
 * secrets, a matching GitHub Issue is created (labeled bug/feature). The GitHub
 * step is best-effort and never blocks the KV write or the response.
 *
 * Admin: GET `<origin>/api/requests` (with `Authorization: Bearer <ADMIN_TOKEN>`
 * or `?token=<ADMIN_TOKEN>`) lists recent reports from KV.
 *
 * Bindings / vars (see wrangler.toml):
 *   - REPORTS          KV namespace (required)
 *   - ALLOWED_ORIGIN   comma-separated allowed origins for CORS (var)
 *   - ADMIN_TOKEN      secret — gates the admin list endpoint
 *   - GITHUB_TOKEN     secret  (optional) — GitHub PAT with `repo`/`issues` scope
 *   - GITHUB_REPO      var/secret (optional) — e.g. "hemangjoshi37a/karmyogi"
 */

const MAX_BODY_BYTES = 64 * 1024 // 64 KB cap on a JSON report
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical'])
const VALID_CATEGORIES = new Set(['bug', 'feature', 'improvement', 'other'])
const LIST_LIMIT = 100

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   */
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    const cors = corsHeaders(origin, env)

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // Serve the overlay bundle. We proxy the published npm overlay so a single
    // <script src="<worker>/overlay.js"> works with no extra hosting. The overlay
    // reads its own script origin → it will POST back here.
    if (url.pathname === '/overlay.js') {
      return serveOverlay(cors)
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'karmyogi-devlogs' }, 200, cors)
    }

    // Create a report.
    if (url.pathname === '/api/requests' && request.method === 'POST') {
      return handleCreate(request, env, cors)
    }

    // Attachment upload — accepted and acknowledged. We do not persist binary
    // blobs in KV (size/cost); we record that an attachment was attempted. To
    // store blobs, wire an R2 bucket here.
    const attachMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/attachments$/)
    if (attachMatch && request.method === 'POST') {
      return json({ ok: true, id: attachMatch[1], note: 'attachments not stored (KV-only backend)' }, 200, cors)
    }

    // Admin: list recent reports (token-gated).
    if (url.pathname === '/api/requests' && request.method === 'GET') {
      return handleList(request, env, url, cors)
    }

    return json({ error: 'not_found' }, 404, cors)
  },
}

/**
 * @param {string | null} origin
 * @param {Record<string, any>} env
 */
function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Echo the request origin only if it's allow-listed (or if '*' is configured).
  let allowOrigin = 'null'
  if (allowed.includes('*')) allowOrigin = origin || '*'
  else if (origin && allowed.includes(origin)) allowOrigin = origin
  else if (allowed.length === 1) allowOrigin = allowed[0]
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

/**
 * @param {unknown} body
 * @param {number} status
 * @param {Record<string, string>} cors
 */
function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {Record<string, string>} cors
 */
async function handleCreate(request, env, cors) {
  // Size-limit defensively.
  const cl = Number(request.headers.get('Content-Length') || '0')
  if (cl > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413, cors)
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413, cors)
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }
  if (!data || typeof data !== 'object') {
    return json({ error: 'invalid_body' }, 400, cors)
  }

  const description = clampStr(data.description, 8000)
  const title = clampStr(data.title, 300) || description.slice(0, 80) || 'Untitled report'
  if (!description && !data.title) {
    return json({ error: 'description_required' }, 400, cors)
  }

  const priority = VALID_PRIORITIES.has(data.priority) ? data.priority : 'medium'
  const category = VALID_CATEGORIES.has(data.category) ? data.category : 'bug'

  const now = new Date()
  const id = `REQ-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const report = {
    id,
    title,
    description,
    priority,
    category,
    status: 'submitted',
    submitted_by: clampStr(data.submitted_by, 120) || 'overlay',
    platform: clampStr(data.platform, 200),
    created_at: now.toISOString(),
  }

  // KV write — primary persistence. Key sorts chronologically (reverse below).
  if (env.REPORTS && typeof env.REPORTS.put === 'function') {
    const key = `report:${now.toISOString()}:${id}`
    try {
      await env.REPORTS.put(key, JSON.stringify(report))
    } catch (e) {
      return json({ error: 'storage_failed', detail: String(e) }, 500, cors)
    }
  }

  // Best-effort GitHub issue (optional, guarded). Never blocks the response.
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    try {
      const issueUrl = await createGithubIssue(env, report)
      if (issueUrl) report.github_issue = issueUrl
    } catch {
      /* GitHub optional — ignore failures */
    }
  }

  // Shape the response so the overlay can read `response.request.id`.
  return json({ ok: true, request: report }, 201, cors)
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {URL} url
 * @param {Record<string, string>} cors
 */
async function handleList(request, env, url, cors) {
  const token =
    (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
    url.searchParams.get('token') ||
    ''
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401, cors)
  }
  if (!env.REPORTS || typeof env.REPORTS.list !== 'function') {
    return json({ error: 'no_store' }, 500, cors)
  }
  // KV list returns keys in lexicographic order; ISO timestamps sort ascending,
  // so reverse for newest-first.
  const listed = await env.REPORTS.list({ prefix: 'report:', limit: 1000 })
  const keys = listed.keys.map((k) => k.name).sort().reverse().slice(0, LIST_LIMIT)
  const reports = []
  for (const name of keys) {
    const v = await env.REPORTS.get(name)
    if (v) {
      try {
        reports.push(JSON.parse(v))
      } catch {
        /* skip corrupt entry */
      }
    }
  }
  return json({ ok: true, count: reports.length, reports }, 200, cors)
}

/**
 * Create a GitHub Issue mirroring the report. Returns the issue html_url or null.
 * @param {Record<string, any>} env
 * @param {Record<string, any>} report
 */
async function createGithubIssue(env, report) {
  const body = [
    report.description,
    '',
    '---',
    `- Category: ${report.category}`,
    `- Priority: ${report.priority}`,
    `- Submitted by: ${report.submitted_by}`,
    `- Platform: ${report.platform}`,
    `- Report ID: ${report.id}`,
    `- Created: ${report.created_at}`,
  ].join('\n')

  const label = report.category === 'feature' || report.category === 'improvement' ? 'feature' : 'bug'

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'karmyogi-devlogs-worker',
    },
    body: JSON.stringify({
      title: `[${label}] ${report.title}`.slice(0, 256),
      body,
      labels: [label],
    }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data && data.html_url ? data.html_url : null
}

/** Serve the overlay bundle by proxying the published npm CDN copy. */
async function serveOverlay(cors) {
  try {
    const res = await fetch(
      'https://cdn.jsdelivr.net/npm/@hemangjoshi37a/dev-logs/dist/overlay.js',
      { cf: { cacheTtl: 3600, cacheEverything: true } },
    )
    if (res.ok) {
      return new Response(res.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          ...cors,
        },
      })
    }
  } catch {
    /* fall through */
  }
  return new Response('// overlay.js unavailable\n', {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', ...cors },
  })
}

/**
 * @param {unknown} v
 * @param {number} max
 */
function clampStr(v, max) {
  if (typeof v !== 'string') return ''
  return v.slice(0, max)
}
