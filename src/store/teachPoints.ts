import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * F1 — Teach / record-position store.
 *
 * A small, reusable capability for capturing the machine's current position
 * (jog to a spot, hit "Capture") into a named, editable list of TAUGHT POINTS.
 * It is the fastest way to define points without CAD, and is meant to be
 * consumed by multiple workbenches (Soldering, Glue, PnP, Screw, Signature
 * anchors, PCB reference / fiducials) — each can read the taught list and turn
 * a chosen point into an anchor / operation origin.
 *
 * This slice is UI-INDEPENDENT (no React/DOM imports) and PERSISTED to
 * localStorage so taught points survive a refresh. It does NOT read the machine
 * itself — the UI (Controller panel) passes the live position in when capturing,
 * keeping this store a pure data container that any panel can subscribe to.
 *
 * Coordinates are stored in WORK coordinates (mm) by default — that is what an
 * operation cares about (relative to the active work zero). The capturing UI is
 * free to record machine coords too; the `frame` field records which it is so a
 * consumer never mixes the two up. The optional `a` axis is forward-compat for
 * a 4th rotary axis (GRBL builds that report A); it's omitted when absent.
 */

/** Which coordinate frame a taught point's X/Y/Z are expressed in. */
export type TeachFrame = 'work' | 'machine'

/** A single captured/edited position. */
export interface TeachPoint {
  /** Stable id (used as a React key and for consumer references). */
  id: string
  /** Human label, e.g. "Pad 1", "Top-left fiducial". Editable. */
  name: string
  x: number
  y: number
  z: number
  /** Optional 4th (rotary) axis, mm/deg — present only when the machine reports A. */
  a?: number
  /** Coordinate frame these values are in. */
  frame: TeachFrame
  /** Capture timestamp (ms epoch). */
  createdAt: number
}

/** The position payload the UI hands in when capturing/recapturing. */
export interface CapturePosition {
  x: number
  y: number
  z: number
  a?: number
  frame: TeachFrame
}

interface TeachPointsState {
  /** Ordered list of taught points. */
  points: TeachPoint[]
  /** Capture a new point at `pos`. Returns the new point's id. */
  capture: (pos: CapturePosition, name?: string) => string
  /** Rename a point. */
  rename: (id: string, name: string) => void
  /** Overwrite a point's position (keeps its id + name) — a re-capture. */
  recapture: (id: string, pos: CapturePosition) => void
  /** Patch arbitrary editable fields (e.g. an inline coordinate edit). */
  update: (id: string, patch: Partial<Pick<TeachPoint, 'name' | 'x' | 'y' | 'z' | 'a'>>) => void
  /** Delete one point. */
  remove: (id: string) => void
  /** Reorder: move a point to a new index. */
  move: (id: string, toIndex: number) => void
  /** Delete every taught point. */
  clear: () => void
}

let seq = 0
function newId(): string {
  seq += 1
  return `tp_${Date.now().toString(36)}_${seq.toString(36)}`
}

/** Default name for the Nth (1-based) captured point. */
function defaultName(n: number): string {
  return `P${n}`
}

export const useTeachPoints = create<TeachPointsState>()(
  persist(
    (set, get) => ({
      points: [],

      capture: (pos, name) => {
        const id = newId()
        const point: TeachPoint = {
          id,
          name: name?.trim() || defaultName(get().points.length + 1),
          x: pos.x,
          y: pos.y,
          z: pos.z,
          ...(pos.a !== undefined ? { a: pos.a } : {}),
          frame: pos.frame,
          createdAt: Date.now(),
        }
        set((s) => ({ points: [...s.points, point] }))
        return id
      },

      rename: (id, name) =>
        set((s) => ({
          points: s.points.map((p) => (p.id === id ? { ...p, name } : p)),
        })),

      recapture: (id, pos) =>
        set((s) => ({
          points: s.points.map((p) =>
            p.id === id
              ? {
                  ...p,
                  x: pos.x,
                  y: pos.y,
                  z: pos.z,
                  // Drop a stale A if the new capture has none; set it if present.
                  ...(pos.a !== undefined ? { a: pos.a } : { a: undefined }),
                  frame: pos.frame,
                }
              : p,
          ),
        })),

      update: (id, patch) =>
        set((s) => ({
          points: s.points.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),

      remove: (id) => set((s) => ({ points: s.points.filter((p) => p.id !== id) })),

      move: (id, toIndex) =>
        set((s) => {
          const from = s.points.findIndex((p) => p.id === id)
          if (from < 0) return s
          const clamped = Math.max(0, Math.min(s.points.length - 1, toIndex))
          if (clamped === from) return s
          const next = s.points.slice()
          const [item] = next.splice(from, 1)
          next.splice(clamped, 0, item)
          return { points: next }
        }),

      clear: () => set({ points: [] }),
    }),
    {
      name: 'karmyogi.teachPoints',
      // Persist only the list; actions are recreated on hydration.
      partialize: (s) => ({ points: s.points }),
    },
  ),
)
