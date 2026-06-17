// Build-time international-SEO generator.
//
// The app ships 53 translated locales but is a single-page app served from one
// HTML file, so search engines only ever saw ONE (English) URL. This plugin
// turns each locale into a real, crawlable URL:
//
//   /            → English (x-default)
//   /<code>/     → that locale  (e.g. /hi/, /ar/, /zh/)
//
// For every generated page it:
//   - sets <html lang="<code>"> (+ dir="rtl" for RTL scripts),
//   - rewrites the canonical + og:url to be self-referential,
//   - injects an identical, reciprocal hreflang cluster (all locales +
//     x-default) so Google treats them as one multilingual set,
// and writes a hreflang-annotated sitemap.xml listing every URL.
//
// The app reads the locale from the URL path on load (see src/i18n), so /hi/
// actually renders Hindi — Googlebot renders JS and indexes the localized UI.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ORIGIN = 'https://karmyogi.hjlabs.in'
// RTL scripts among the shipped locales (must match src/i18n LANGUAGES dir flags).
const RTL = new Set(['ar', 'fa', 'he', 'ur', 'sd', 'ks'])

/** Discover shipped locale codes from the locale JSON files (single source of truth). */
function localeCodes(root) {
  return readdirSync(join(root, 'src/i18n/locales'))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}

/** The reciprocal hreflang block shared verbatim by every page in the cluster. */
function hreflangBlock(codes) {
  const lines = [`    <link rel="alternate" hreflang="en" href="${ORIGIN}/" />`]
  for (const c of codes) lines.push(`    <link rel="alternate" hreflang="${c}" href="${ORIGIN}/${c}/" />`)
  lines.push(`    <link rel="alternate" hreflang="x-default" href="${ORIGIN}/" />`)
  return lines.join('\n')
}

function sitemap(codes, lastmod) {
  const alts = [`      <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}/"/>`]
  for (const c of codes) alts.push(`      <xhtml:link rel="alternate" hreflang="${c}" href="${ORIGIN}/${c}/"/>`)
  alts.push(`      <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/"/>`)
  const altBlock = alts.join('\n')
  const urlEntry = (loc, priority) =>
    `  <url>\n    <loc>${loc}</loc>\n${altBlock}\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`
  const entries = [urlEntry(`${ORIGIN}/`, '1.0')]
  for (const c of codes) entries.push(urlEntry(`${ORIGIN}/${c}/`, '0.8'))
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    entries.join('\n') +
    `\n</urlset>\n`
  )
}

export function i18nSeoGenerator() {
  let root = process.cwd()
  let outDir = 'dist'
  return {
    name: 'karmyogi-i18n-seo',
    apply: 'build',
    configResolved(config) {
      root = config.root || root
      outDir = config.build?.outDir || outDir
    },
    closeBundle() {
      const dist = join(root, outDir)
      const indexPath = join(dist, 'index.html')
      let html
      try {
        html = readFileSync(indexPath, 'utf8')
      } catch {
        return // no index.html (e.g. SSR/library build) — nothing to do
      }
      const codes = localeCodes(root)
      const block = hreflangBlock(codes)
      const CANON = `<link rel="canonical" href="${ORIGIN}/" />`

      // 1. Inject the hreflang cluster into the root (English) page.
      const rootHtml = html.includes('hreflang=') ? html : html.replace(CANON, `${CANON}\n${block}`)
      writeFileSync(indexPath, rootHtml)

      // 2. Emit one localized page per locale.
      for (const c of codes) {
        let page = rootHtml
        page = page.replace('<html lang="en">', `<html lang="${c}"${RTL.has(c) ? ' dir="rtl"' : ''}>`)
        page = page.replace(CANON, `<link rel="canonical" href="${ORIGIN}/${c}/" />`)
        page = page.replace(
          `<meta property="og:url" content="${ORIGIN}/" />`,
          `<meta property="og:url" content="${ORIGIN}/${c}/" />`,
        )
        mkdirSync(join(dist, c), { recursive: true })
        writeFileSync(join(dist, c, 'index.html'), page)
      }

      // 3. Replace the sitemap with the full hreflang-annotated multilingual one.
      const lastmod = new Date().toISOString().slice(0, 10)
      writeFileSync(join(dist, 'sitemap.xml'), sitemap(codes, lastmod))

      console.log(`[i18n-seo] generated ${codes.length} localized pages + multilingual sitemap`)
    },
  }
}
