/**
 * Workbench tab titles + the `tab.*` i18n key wiring.
 *
 * The real definitions live in `src/app/panelRegistry.ts` (alongside the panel
 * list, and crucially OUTSIDE `src/i18n/` which `scripts/i18n-check.mjs` skips
 * when extracting static `t('key','fallback')` call sites). This module simply
 * re-exports them so callers can import tab-title helpers from the i18n layer.
 */
export {
  TAB_TITLES,
  TAB_TITLE_KEYS,
  localizedTabTitles,
  tabTitle,
} from '../app/panelRegistry'
