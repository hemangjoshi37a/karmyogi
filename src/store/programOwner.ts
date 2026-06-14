import { create } from 'zustand'

/**
 * Which CAM panel currently OWNS the shared program + 3D viewer — by
 * "last writer wins": whichever panel most recently produced output (the
 * operator imported pads, typed text, moved a coil slider, …) claims ownership,
 * and the others drop their program section + clear their 3D-viz channel.
 *
 * Why not gate on the active dock TAB? Because dockview keeps inactive panels
 * MOUNTED and the active-tab signal can be stale (after an HMR reload, a restored
 * custom layout, or a click that didn't refocus the panel) — which led to a panel
 * deleting its OWN freshly-imported toolpath. Ownership-by-last-output matches
 * what the operator just did and never races the active-tab signal.
 *
 * `claim(id)` is called by a panel whenever it has REAL output to show. Every CAM
 * panel watches `owner`: when `owner` is set and isn't theirs, they yield. The
 * very first claimer on load (e.g. the Spring panel's default coil) owns until the
 * operator does something elsewhere. Pure data; not persisted (live UI state).
 */

interface ProgramOwnerState {
  /** The owning panel id (dock-tab id), or null when nothing has claimed yet. */
  owner: string | null
  /** Claim ownership for `id` (idempotent — no state change if already owner). */
  claim: (id: string) => void
  /** Release ownership if `id` currently holds it (e.g. its output went empty). */
  release: (id: string) => void
}

export const useProgramOwner = create<ProgramOwnerState>((set, get) => ({
  owner: null,
  claim: (id) => {
    if (get().owner !== id) set({ owner: id })
  },
  release: (id) => {
    if (get().owner === id) set({ owner: null })
  },
}))
