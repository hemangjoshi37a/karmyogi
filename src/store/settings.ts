import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'light' | 'dark'
export type Units = 'mm' | 'inch'

export const MIN_SCALE = 0.7
export const MAX_SCALE = 1.6

interface SettingsState {
  theme: Theme
  units: Units
  /** Global UI zoom factor (1 = 100%). Scales the whole app. */
  uiScale: number
  setTheme: (t: Theme) => void
  toggleTheme: () => void
  setUnits: (u: Units) => void
  setUiScale: (s: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
}

const applyTheme = (t: Theme) => {
  document.documentElement.setAttribute('data-theme', t)
}

const clampScale = (s: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * 100) / 100))

const applyScale = (s: number) => {
  // Chromium-only app (Web Serial) → `zoom` is the simplest uniform global scale.
  document.documentElement.style.setProperty('zoom', String(s))
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      units: 'mm',
      uiScale: 1,
      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
      toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
      setUnits: (units) => set({ units }),
      setUiScale: (s) => {
        const uiScale = clampScale(s)
        applyScale(uiScale)
        set({ uiScale })
      },
      zoomIn: () => get().setUiScale(get().uiScale + 0.1),
      zoomOut: () => get().setUiScale(get().uiScale - 0.1),
      resetZoom: () => get().setUiScale(1),
    }),
    {
      name: 'karmyogi.settings',
      partialize: (s) => ({ theme: s.theme, units: s.units, uiScale: s.uiScale }),
    },
  ),
)

// Apply the (possibly restored) theme + zoom at module load.
applyTheme(useSettings.getState().theme)
applyScale(useSettings.getState().uiScale)
