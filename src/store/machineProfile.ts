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

interface MachineProfileState {
  /** The selected controller firmware kind. */
  controllerKind: ControllerKind
  /** Set the active controller (no-op if the kind is unknown). */
  setControllerKind: (kind: ControllerKind) => void
  /** Resolve the full profile for the current selection. */
  profile: () => ControllerProfile
  /** Convenience: the current profile's capability flags. */
  capabilities: () => Capabilities
}

export const useMachineProfile = create<MachineProfileState>()(
  persist(
    (set, get) => ({
      controllerKind: DEFAULT_CONTROLLER_KIND,
      setControllerKind: (kind) => {
        if (kind in CONTROLLER_PROFILES) set({ controllerKind: kind })
      },
      profile: () => profileFor(get().controllerKind),
      capabilities: () => profileFor(get().controllerKind).capabilities,
    }),
    {
      name: 'karmyogi.machineProfile',
      // Persist only the raw selection; everything else is derived.
      partialize: (s) => ({ controllerKind: s.controllerKind }),
    },
  ),
)
