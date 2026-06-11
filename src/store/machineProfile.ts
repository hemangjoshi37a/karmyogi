// Active machine/controller selection store (persisted).
//
// Holds which controller firmware the user has picked (GRBL by default) and
// derives the matching ControllerProfile / Capabilities from the registry in
// src/machine/controllers.ts. Persisted to localStorage via the zustand persist
// middleware (same pattern as src/store/settings.ts), so the choice survives a
// reload and the connection layer can restore + auto-reconnect.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  CONTROLLER_PROFILES,
  DEFAULT_CONTROLLER_KIND,
  profileFor,
} from '../machine/controllers'
import type {
  Capabilities,
  ControllerKind,
  ControllerProfile,
} from '../machine/types'
import { resolveDialect, type ResolvedDialect } from '../serial/dialect'

interface MachineProfileState {
  /** The selected controller firmware kind. */
  controllerKind: ControllerKind
  /** Set the active controller (no-op if the kind is unknown). */
  setControllerKind: (kind: ControllerKind) => void
  /**
   * User-chosen serial baud override. `null` means "use the selected profile's
   * default baud" (`profile().baud`). When set to a positive integer it wins over
   * the profile default at the next port open. Persisted so it survives a reload.
   */
  baudOverride: number | null
  /**
   * Set (or clear, with `null`) the baud override. Non-positive / non-finite
   * values are coerced to `null` (fall back to the profile default) so a bad
   * custom entry can never open the port at an invalid rate.
   */
  setBaudOverride: (baud: number | null) => void
  /** The baud to actually open the port at: override if set, else profile default. */
  effectiveBaud: () => number
  /** Resolve the full profile for the current selection. */
  profile: () => ControllerProfile
  /** Convenience: the current profile's capability flags. */
  capabilities: () => Capabilities
  /**
   * The current profile's fully-resolved protocol dialect (GRBL-shaped defaults
   * filled in, FluidNC resolved by kind). Carries the derived capability flags
   * the UI can branch on without re-deriving GRBL-vs-Marlin-vs-FluidNC:
   * `supportsGrblSettings` (numeric `$N=` settings — does the Motion panel's
   * classic GRBL editor apply?), `supportsNamedSettings` (FluidNC `$name=value`
   * named settings — the Motion panel's named editor), `settingsStyle`
   * ('numeric' | 'named' | 'none'), `supportsRealtimeStatus` (GRBL `?` vs Marlin
   * `M114`), and `statusIsLineCommand`. Marlin resolves to a non-GRBL dialect
   * (no `$$`, no realtime `?`); FluidNC resolves GRBL-shaped but named-settings.
   */
  dialect: () => ResolvedDialect
}

export const useMachineProfile = create<MachineProfileState>()(
  persist(
    (set, get) => ({
      controllerKind: DEFAULT_CONTROLLER_KIND,
      setControllerKind: (kind) => {
        if (!(kind in CONTROLLER_PROFILES)) return
        // Changing firmware resets any baud override back to the NEW firmware's
        // default (least-surprising: pick Marlin → you get Marlin's 250000, not a
        // stale 115200 you set for GRBL earlier). Re-pick a custom baud after.
        set({ controllerKind: kind, baudOverride: null })
      },
      baudOverride: null,
      setBaudOverride: (baud) =>
        set({
          baudOverride:
            baud != null && Number.isFinite(baud) && baud > 0 ? Math.floor(baud) : null,
        }),
      effectiveBaud: () => {
        const o = get().baudOverride
        return o != null && Number.isFinite(o) && o > 0 ? o : profileFor(get().controllerKind).baud
      },
      profile: () => profileFor(get().controllerKind),
      capabilities: () => profileFor(get().controllerKind).capabilities,
      dialect: () => {
        // Pass the kind so FluidNC resolves to its named-settings dialect.
        const p = profileFor(get().controllerKind)
        return resolveDialect(p.dialect, p.kind)
      },
    }),
    {
      name: 'karmyogi.machineProfile',
      // Persist the raw selection + the baud override; everything else is derived.
      partialize: (s) => ({ controllerKind: s.controllerKind, baudOverride: s.baudOverride }),
    },
  ),
)
