// URL deep-linking for the workbench.
//
// Reflects the ACTIVE TAB — and the LAST control the user interacted with — in the
// address bar as query params (`?tab=<id>&el=<slug>`), so the URL you copy opens
// the same tab and reveals the same button/field for whoever you send it to.
//
// Query-param based on PURPOSE: it composes with the app's locale path prefixes
// (`/hi/`, `/ar/…`) and the SPA router (which keys off pathname, not the query), so
// it never triggers a navigation. Everything is `history.replaceState` — it updates
// the current URL in place and NEVER spams the back-button history.

/** Controls we consider "interactable" for deep-linking. */
const CONTROL_SEL =
  'button, [role="button"], input, select, textarea, a[href], [role="tab"], [role="menuitem"], summary, label[for]'

export interface DeepLink {
  tab?: string
  el?: string
}

/** Read the current deep-link state from the URL. */
export function readDeepLink(): DeepLink {
  try {
    const p = new URLSearchParams(location.search)
    return { tab: p.get('tab') ?? undefined, el: p.get('el') ?? undefined }
  } catch {
    return {}
  }
}

/** Merge params into the current URL (deleting empties) via replaceState. */
function updateUrl(params: Record<string, string | undefined>): void {
  try {
    const url = new URL(location.href)
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') url.searchParams.delete(k)
      else url.searchParams.set(k, v)
    }
    history.replaceState(history.state, '', url.toString())
  } catch {
    /* URL API unavailable / opaque origin — deep-linking is best-effort */
  }
}

// Single source of truth for the current tab — set by the shells on every
// active-tab change. The interaction tracker reads THIS (not a re-query of
// dockview's global activePanel, which can point at a different group's panel).
let currentTab: string | undefined

/** Seed the current tab WITHOUT touching the URL (used on load to preserve a shared ?el). */
export function setCurrentTab(tab: string | undefined): void {
  currentTab = tab
}

/** Set the `?tab=` param (and clear the stale `el`, which belonged to the old tab). */
export function writeTab(tab: string | undefined): void {
  currentTab = tab
  updateUrl({ tab, el: undefined })
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

/**
 * A stable-ish slug identifying a control, for the `?el=` param. Prefers an
 * explicit id / `data-deeplink` / accessible name, falling back to name/title/text.
 * Returns null for elements that aren't a meaningful control.
 */
export function controlSlug(target: EventTarget | Element | null): string | null {
  const start = target instanceof Element ? target : null
  if (!start) return null
  const ctl = start.closest(CONTROL_SEL) as HTMLElement | null
  if (!ctl) return null
  const raw =
    ctl.getAttribute('data-deeplink') ||
    ctl.id ||
    ctl.getAttribute('aria-label') ||
    ctl.getAttribute('name') ||
    ctl.getAttribute('title') ||
    (ctl.textContent ?? '').trim()
  if (!raw) return null
  const slug = slugify(raw)
  return slug ? slug.slice(0, 60) : null
}

let trackerInstalled = false
/**
 * Install a global capture-phase listener that records the last interacted control
 * into `?el=`, tab-scoped via the module's `currentTab` (kept in sync by the shells'
 * active-tab handlers). rAF-debounced so a burst of events collapses to one URL
 * write. Idempotent.
 */
export function installInteractionTracker(): void {
  if (trackerInstalled || typeof document === 'undefined') return
  trackerInstalled = true
  let scheduled = false
  let pendingSlug: string | null = null
  const flush = () => {
    scheduled = false
    if (pendingSlug) updateUrl({ tab: currentTab, el: pendingSlug })
  }
  const onInteract = (e: Event) => {
    const slug = controlSlug(e.target)
    if (!slug) return
    pendingSlug = slug
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(flush)
    }
  }
  document.addEventListener('pointerdown', onInteract, true)
  document.addEventListener('focusin', onInteract, true)
  document.addEventListener('change', onInteract, true)
}

/**
 * Find the control matching `slug` within `root`, scroll it into view, briefly
 * flash it and focus it. Returns true if found. Used on load to reveal the shared
 * control once its tab (and lazy panel) has mounted.
 */
export function restoreControl(slug: string | undefined, root: ParentNode = document): boolean {
  if (!slug) return false
  const nodes = root.querySelectorAll<HTMLElement>(CONTROL_SEL)
  for (const el of nodes) {
    if (controlSlug(el) !== slug) continue
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch {
      /* ignore */
    }
    el.classList.add('km-deeplink-flash')
    window.setTimeout(() => el.classList.remove('km-deeplink-flash'), 2200)
    try {
      el.focus({ preventScroll: true })
    } catch {
      /* not focusable — the flash still shows it */
    }
    return true
  }
  return false
}

/**
 * Reveal the deep-linked control once it exists — the panel is lazy-loaded, so the
 * element may not be in the DOM immediately. Retries a few times over ~2 s, then
 * gives up. No-op when there's no `el` in the URL.
 */
export function restoreControlWhenReady(slug: string | undefined): void {
  if (!slug || typeof document === 'undefined') return
  let tries = 0
  const tick = () => {
    if (restoreControl(slug) || ++tries > 12) return
    window.setTimeout(tick, 160)
  }
  window.setTimeout(tick, 120)
}
