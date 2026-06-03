import type { ChangeEvent } from 'react'
import { LANGUAGES, useLocale, type Lang } from '../i18n'

/**
 * Compact top-bar language picker: a globe glyph plus a native-name dropdown.
 * Selecting a language updates the persisted locale store, re-rendering every
 * `useT`/`useLocale` consumer across the app.
 */
export function LanguageSwitcher() {
  const lang = useLocale((s) => s.lang)
  const setLang = useLocale((s) => s.setLang)
  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0]

  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setLang(e.target.value as Lang)
  }

  return (
    <label className="lang-switcher" title={`Language — ${current.native}`}>
      <span className="lang-switcher-glyph" aria-hidden="true">
        🌐
      </span>
      <select
        className="lang-switcher-select"
        value={lang}
        onChange={onChange}
        aria-label={`Language — ${current.native}`}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.native}
          </option>
        ))}
      </select>
      <style>{`
        .lang-switcher {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 28px;
          padding: 0 6px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg-input);
          color: var(--fg);
          cursor: pointer;
          line-height: 1;
        }
        .lang-switcher:hover {
          border-color: var(--accent);
        }
        .lang-switcher-glyph {
          font-size: 13px;
          line-height: 1;
        }
        .lang-switcher-select {
          appearance: none;
          -webkit-appearance: none;
          border: none;
          background: transparent;
          color: var(--fg);
          font: inherit;
          font-size: 12px;
          cursor: pointer;
          padding: 0 2px;
          outline: none;
          max-width: 7.5em;
        }
        .lang-switcher-select option {
          background: var(--bg-elev);
          color: var(--fg);
        }
        @media (pointer: coarse) {
          .lang-switcher {
            height: 36px;
            padding: 0 10px;
          }
          .lang-switcher-glyph {
            font-size: 15px;
          }
          .lang-switcher-select {
            font-size: 14px;
            max-width: 9em;
          }
        }
      `}</style>
    </label>
  )
}
