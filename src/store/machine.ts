import { create } from 'zustand'
import {
  parseStatusReport,
  parseParserState,
  type StatusReport,
  type ParserState,
  type GrblState,
  type WorkCoordSystem,
  type Vec3 as SerialVec3,
} from '../serial/status'

// W1 (serial) owns this slice. The Phase-0 export names are preserved:
//   useMachine, ConnectionStatus, MachineState, Vec3
// (the orchestrator's store/index.ts re-exports them). This expands the stub
// with full connection lifecycle, overrides, feed/spindle, and status wiring.

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

// MachineState mirrors the GRBL state set (kept identical to the serial layer's
// GrblState so status parsing maps straight through).
export type MachineState = GrblState

export type Vec3 = SerialVec3

/** Re-export so Coordinates/Controller can type the active-WCS field. */
export type { WorkCoordSystem, ParserState } from '../serial/status'

export interface Overrides {
  feed: number
  rapid: number
  spindle: number
}

interface MachineStore {
  // --- connection ---
  connection: ConnectionStatus
  /** Last connection error message, if any. */
  error: string | null

  // --- machine status ---
  state: MachineState
  subState: number | null
  mpos: Vec3
  wpos: Vec3
  wco: Vec3
  feed: number
  spindle: number
  overrides: Overrides
  /** Active input pins (limit/probe/door), e.g. ['X','Z']. */
  pins: string[]
  /** Planner / RX buffer availability, if reported. */
  buffer: { plan: number; rx: number } | null
  /** Timestamp (ms) of the last status report applied. */
  lastStatusAt: number | null

  // --- parser state ($G) ---
  /**
   * Last GRBL `$G` parser-state report (modal words + active WCS). null until a
   * `$G` reply is seen. The Coordinates panel reads `activeWcs` to reflect the
   * machine's REAL active work coordinate system rather than a guessed local one.
   */
  parserState: ParserState | null
  /** Active work coordinate system (G54–G59) from `$G`, or null if unknown. */
  activeWcs: WorkCoordSystem | null

  // --- actions ---
  setConnection: (c: ConnectionStatus) => void
  setError: (e: string | null) => void
  setState: (s: MachineState) => void
  setPositions: (p: { mpos?: Vec3; wpos?: Vec3 }) => void
  /** Apply a parsed status report to the store. */
  applyStatus: (report: StatusReport) => void
  /** Parse a raw `<...>` line and apply it. Returns true if it was a report. */
  ingestStatusLine: (line: string) => boolean
  /** Apply a parsed `$G` parser-state report (sets parserState + activeWcs). */
  applyParserState: (ps: ParserState) => void
  /** Parse a raw `[GC:...]` line and apply it. Returns true if it was one. */
  ingestParserStateLine: (line: string) => boolean
  /** Reset machine status back to defaults (e.g. on disconnect). */
  resetMachine: () => void
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
const FULL_OV: Overrides = { feed: 100, rapid: 100, spindle: 100 }

export const useMachine = create<MachineStore>((set, get) => ({
  connection: 'disconnected',
  error: null,

  state: 'Unknown',
  subState: null,
  mpos: { ...ZERO },
  wpos: { ...ZERO },
  wco: { ...ZERO },
  feed: 0,
  spindle: 0,
  overrides: { ...FULL_OV },
  pins: [],
  buffer: null,
  lastStatusAt: null,

  parserState: null,
  activeWcs: null,

  // Connecting clears any stale error so a retry starts clean; connected does
  // too. Going to 'disconnected' PRESERVES the current error so a mid-job /
  // unexpected disconnect message (set by the controller) survives the
  // connection-state flip and stays visible to the operator (the dangerous
  // CNC case — losing the link mid-cut).
  setConnection: (connection) =>
    set({
      connection,
      error: connection === 'disconnected' ? get().error : null,
    }),
  setError: (error) => set({ error }),
  setState: (state) => set({ state }),
  setPositions: ({ mpos, wpos }) =>
    set((s) => ({ mpos: mpos ?? s.mpos, wpos: wpos ?? s.wpos })),

  applyStatus: (report) =>
    set((s) => ({
      state: report.state,
      subState: report.subState ?? null,
      mpos: report.mpos ?? s.mpos,
      wpos: report.wpos ?? s.wpos,
      wco: report.wco ?? s.wco,
      feed: report.feed ?? s.feed,
      spindle: report.spindle ?? s.spindle,
      overrides: report.overrides ?? s.overrides,
      pins: report.pins ?? [],
      buffer: report.buffer ?? s.buffer,
      lastStatusAt: Date.now(),
    })),

  ingestStatusLine: (line) => {
    const report = parseStatusReport(line, get().wco)
    if (!report) return false
    get().applyStatus(report)
    return true
  },

  applyParserState: (ps) =>
    set({ parserState: ps, activeWcs: ps.wcs ?? get().activeWcs }),

  ingestParserStateLine: (line) => {
    const ps = parseParserState(line)
    if (!ps) return false
    get().applyParserState(ps)
    return true
  },

  resetMachine: () =>
    set({
      state: 'Unknown',
      subState: null,
      mpos: { ...ZERO },
      wpos: { ...ZERO },
      wco: { ...ZERO },
      feed: 0,
      spindle: 0,
      overrides: { ...FULL_OV },
      pins: [],
      buffer: null,
      lastStatusAt: null,
      parserState: null,
      activeWcs: null,
    }),
}))
