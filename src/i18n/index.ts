import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Multilingual layer for karmyogi.
 *
 * Goal: nobody hits a language barrier. We ship English as the source-of-truth
 * and translate into the major Indian languages first, then the world's most
 * spoken languages. Adding a language is ONE step: drop a `locales/<code>.json`
 * file (keyed by the same dot-keys, e.g. `cc.material`) and add an entry to
 * LANGUAGES below — the JSON is auto-discovered via Vite's import.meta.glob.
 *
 * Translation contract (see useT): every call site passes the English text
 * inline as the fallback, so any key missing from a locale gracefully shows
 * English. Locale files therefore only need to cover what's been translated.
 */

export interface LanguageInfo {
  /** BCP-47-ish short code; also the locale filename (`<code>.json`). */
  code: string
  /** English name of the language. */
  label: string
  /** The language's own native-script name. */
  native: string
  /** Writing direction; right-to-left scripts set this. */
  dir?: 'rtl'
}

/**
 * Languages offered in the switcher, in display order: English, then the
 * scheduled / major Indian languages, then the world's most spoken languages.
 * A code here without a matching `locales/<code>.json` simply falls back to
 * English until its file is added — so the list can lead the translations.
 */
export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', label: 'English', native: 'English' },

  // --- India first ---
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা' },
  { code: 'te', label: 'Telugu', native: 'తెలుగు' },
  { code: 'mr', label: 'Marathi', native: 'मराठी' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { code: 'ur', label: 'Urdu', native: 'اردو', dir: 'rtl' },
  { code: 'gu', label: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'or', label: 'Odia', native: 'ଓଡ଼ିଆ' },
  { code: 'ml', label: 'Malayalam', native: 'മലയാളം' },
  { code: 'pa', label: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'as', label: 'Assamese', native: 'অসমীয়া' },
  { code: 'mai', label: 'Maithili', native: 'मैथिली' },
  { code: 'sa', label: 'Sanskrit', native: 'संस्कृतम्' },
  { code: 'ne', label: 'Nepali', native: 'नेपाली' },
  { code: 'kok', label: 'Konkani', native: 'कोंकणी' },
  { code: 'sd', label: 'Sindhi', native: 'سنڌي', dir: 'rtl' },
  { code: 'doi', label: 'Dogri', native: 'डोगरी' },
  { code: 'mni', label: 'Manipuri (Meitei)', native: 'মৈতৈলোন' },
  { code: 'bho', label: 'Bhojpuri', native: 'भोजपुरी' },
  { code: 'ks', label: 'Kashmiri', native: 'کٲشُر', dir: 'rtl' },
  { code: 'sat', label: 'Santali', native: 'ᱥᱟᱱᱛᱟᱲᱤ' },
  { code: 'brx', label: 'Bodo', native: 'बड़ो' },

  // --- the world's most spoken ---
  { code: 'zh', label: 'Chinese (Mandarin)', native: '中文' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'ar', label: 'Arabic', native: 'العربية', dir: 'rtl' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ko', label: 'Korean', native: '한국어' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', label: 'Thai', native: 'ไทย' },
  { code: 'pl', label: 'Polish', native: 'Polski' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська' },
  { code: 'fa', label: 'Persian', native: 'فارسی', dir: 'rtl' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands' },
  { code: 'fil', label: 'Filipino', native: 'Filipino' },
  { code: 'sw', label: 'Swahili', native: 'Kiswahili' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu' },
  { code: 'ha', label: 'Hausa', native: 'Hausa' },
  { code: 'am', label: 'Amharic', native: 'አማርኛ' },
  { code: 'yo', label: 'Yoruba', native: 'Yorùbá' },
  { code: 'my', label: 'Burmese', native: 'မြန်မာ' },
  { code: 'he', label: 'Hebrew', native: 'עברית', dir: 'rtl' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά' },
  { code: 'ro', label: 'Romanian', native: 'Română' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar' },
  { code: 'cs', label: 'Czech', native: 'Čeština' },
]

/** A language code (kept as a string so locale files can extend the set freely). */
export type Lang = string

/**
 * Auto-discover every translation map under ./locales (one JSON per language,
 * keyed by dot-keys) as LAZY dynamic imports.
 *
 * Performance: with 53 locales × ~1683 keys, eagerly inlining every map bloated
 * the entry bundle massively even though a user only ever views ONE language.
 * `import.meta.glob` WITHOUT `eager` gives one code-split chunk per locale that
 * we fetch on demand — only the active language is ever downloaded.
 *
 * English needs NO file and NO fetch: it is the inline fallback supplied at each
 * call site (`useT(key, english)`), so `lang === 'en'` is instant and the UI
 * never flashes raw keys. When switching to another language, `useT` keeps
 * returning the English fallback until that locale's chunk has loaded, then a
 * version bump re-renders consumers with the translated strings.
 */
const localeLoaders = import.meta.glob('./locales/*.json', {
  import: 'default',
}) as Record<string, () => Promise<Record<string, string>>>

/** code → dynamic-import loader (resolved from the glob path). */
const loaderByCode: Record<string, () => Promise<Record<string, string>>> = {}
for (const path in localeLoaders) {
  const m = /\/([a-z]+)\.json$/i.exec(path)
  if (m) loaderByCode[m[1]] = localeLoaders[path]
}

/** Lazily-loaded translation maps, keyed by language code (filled on demand). */
const translations: Record<string, Record<string, string>> = {}
/** In-flight loads, deduped so a language is fetched at most once. */
const inflight: Record<string, Promise<void>> = {}

const KNOWN_CODES = new Set(LANGUAGES.map((l) => l.code))

/**
 * Fetch a locale's translation map (once) and, on success, bump the store's
 * version so every `useT` consumer re-renders with the now-available strings.
 * No-ops for English (inline fallback) and for codes with no locale file.
 */
function ensureLocale(lang: string): void {
  if (lang === 'en' || lang in translations || lang in inflight) return
  const loader = loaderByCode[lang]
  if (!loader) return
  inflight[lang] = loader()
    .then((map) => {
      translations[lang] = map
      // Re-render consumers now that the active locale is available.
      useLocale.setState((s) => ({ version: s.version + 1 }))
    })
    .catch(() => {
      // Network/parse failure → stay on the inline English fallback silently.
    })
    .finally(() => {
      delete inflight[lang]
    })
}

/** Reflect the active language onto <html> (lang + direction). */
function applyDocumentLang(lang: string): void {
  const info = LANGUAGES.find((l) => l.code === lang)
  const el = document.documentElement
  el.setAttribute('lang', lang)
  el.setAttribute('dir', info?.dir === 'rtl' ? 'rtl' : 'ltr')
}

interface LocaleState {
  lang: Lang
  /**
   * Bumped whenever a lazily-loaded locale map becomes available, forcing every
   * `useT` consumer to re-render with the now-present translations. (`lang`
   * alone can't do this: it changes BEFORE the async locale chunk arrives.)
   */
  version: number
  setLang: (l: Lang) => void
}

/**
 * Persisted language store. Changing `lang` re-renders every component that
 * reads it (via `useLocale`/`useT`), so the whole UI re-translates live. The
 * matching locale chunk is fetched lazily (see `ensureLocale`); until it lands,
 * the inline English fallback is shown — no flash of raw keys.
 */
export const useLocale = create<LocaleState>()(
  persist(
    (set) => ({
      lang: 'en',
      version: 0,
      setLang: (lang) => {
        applyDocumentLang(lang)
        ensureLocale(lang)
        set({ lang })
      },
    }),
    {
      name: 'karmyogi.lang',
      // `version` is derived runtime state, not persisted.
      partialize: (s) => ({ lang: s.lang }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        // Guard against a stored code we no longer ship.
        if (!KNOWN_CODES.has(state.lang)) state.lang = 'en'
        applyDocumentLang(state.lang)
        // Begin fetching the restored language's locale chunk immediately.
        ensureLocale(state.lang)
      },
    },
  ),
)

// Apply the (possibly restored) language at module load, and start loading its
// locale chunk (no-op for English).
applyDocumentLang(useLocale.getState().lang)
ensureLocale(useLocale.getState().lang)

/** Replace `{name}` tokens in `template` with values from `vars`. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  )
}

/**
 * Returns a translate function bound to the current language.
 *
 * English-fallback contract:
 *   - `lang === 'en'` → interpolate and return the supplied `english` string.
 *   - otherwise → interpolate `translations[lang][key] ?? english`.
 *
 * `english` is therefore always the inline source-of-truth default, so any
 * key missing from a locale map gracefully shows English.
 */
export function useT(): (
  key: string,
  english: string,
  vars?: Record<string, string | number>,
) => string {
  const lang = useLocale((s) => s.lang)
  // Subscribe to `version` so that when the active locale's chunk finishes
  // loading asynchronously, this component re-renders with the translations.
  useLocale((s) => s.version)
  return (key, english, vars) => {
    if (lang === 'en') return interpolate(english, vars)
    const map = translations[lang]
    const translated = (map && map[key]) ?? english
    return interpolate(translated, vars)
  }
}
