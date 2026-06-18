import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { HeightMap, ProbeArea } from '../core/heightmap'

/**
 * Persisted auto-leveling (heightmap) state for the PCB workbench.
 *
 * Holds the most-recently probed surface map so a page reload survives a probe
 * cycle (re-probing a clamped board is slow), plus the warp settings and the
 * single source of truth for HOW the surface is applied:
 *
 *   applyMode: 'off'    — no warp (flat Z).
 *              'onfly'  — warp G-code at SEND time (the program store keeps the
 *                         flat program; warping happens just before streaming).
 *              'baked'  — warp is baked into the generated program text.
 *
 * `onfly` and `baked` are MUTUALLY EXCLUSIVE — re-applying a warp on top of an
 * already-warped program would double-offset Z and ruin the board. The panel
 * uses `applyMode` as the exclusive selector; only one path ever transforms Z.
 */

const KEY = 'karmyogi.heightmap'

export type ApplyMode = 'off' | 'onfly' | 'baked'

interface HeightmapState {
  /** The probed surface (null until a probe cycle completes / is saved). */
  map: HeightMap | null
  /** How the surface is applied to generated G-code. */
  applyMode: ApplyMode
  /** Max XY length of a cut segment before splitting so Z follows the surface (mm). */
  maxSegment: number
  /** Margin (mm) added around the toolpath extents when deriving the probe area. */
  margin: number
  /** Probe feed (slow plunge) mm/min. */
  probeFeed: number
  /** Max plunge distance from safe-Z before giving up (mm, positive). */
  probeDepth: number
  /** Safe-Z (mm) the head rapids to between probe points. */
  probeClearance: number

  setMap: (map: HeightMap | null) => void
  setApplyMode: (m: ApplyMode) => void
  setMaxSegment: (v: number) => void
  setMargin: (v: number) => void
  setProbeFeed: (v: number) => void
  setProbeDepth: (v: number) => void
  setProbeClearance: (v: number) => void
  /** Clear the probed map AND turn the warp off (a stale map must never warp). */
  clearMap: () => void
}

const numClamp = (v: number, lo: number, hi: number, fb: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb

export const useHeightmap = create<HeightmapState>()(
  persist(
    (set, get) => ({
      map: null,
      applyMode: 'off',
      maxSegment: 1,
      margin: 2,
      probeFeed: 40,
      probeDepth: 5,
      probeClearance: 3,
      setMap: (map) => set({ map }),
      setApplyMode: (applyMode) => set({ applyMode }),
      setMaxSegment: (v) => set({ maxSegment: numClamp(v, 0.2, 10, get().maxSegment) }),
      setMargin: (v) => set({ margin: numClamp(v, 0, 50, get().margin) }),
      setProbeFeed: (v) => set({ probeFeed: numClamp(v, 5, 500, get().probeFeed) }),
      setProbeDepth: (v) => set({ probeDepth: numClamp(v, 0.5, 50, get().probeDepth) }),
      setProbeClearance: (v) => set({ probeClearance: numClamp(v, 0.5, 50, get().probeClearance) }),
      clearMap: () => set({ map: null, applyMode: 'off' }),
    }),
    {
      name: KEY,
      // NOTE: `applyMode` is deliberately NOT persisted — it always rehydrates to
      // 'off'. The map survives a reload (no need to re-probe), but the warp stays
      // disabled until the operator re-confirms Apply against the CURRENTLY-loaded
      // board, so a stale surface from a prior session/board can never silently
      // warp (and ruin) a different PCB.
      partialize: (s) => ({
        map: s.map,
        maxSegment: s.maxSegment,
        margin: s.margin,
        probeFeed: s.probeFeed,
        probeDepth: s.probeDepth,
        probeClearance: s.probeClearance,
      }),
    },
  ),
)

/** Re-export so panels can import the area type from the store barrel-adjacent. */
export type { ProbeArea }
