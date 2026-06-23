// Machine FARM store (connection manager).
//
// karmyogi can manage MULTIPLE machines and switch which one we view/operate.
// This store is the MANAGER: it keeps a saved list of machines (Serial / Mock /
// WebSocket), tracks which one is ACTIVE, and drives connect/disconnect/switch
// by delegating to the existing `grbl` controller singleton.
//
// CRITICAL non-breaking design — the active-machine FACADE stays identical:
//   • `grbl` (src/serial/controller.ts) and `useMachine` (src/store/machine.ts)
//     keep their exact exported API/shape. Every panel keeps importing those and
//     keeps working untouched.
//   • The ACTIVE machine is simply whatever `grbl` is currently connected to;
//     `useMachine` already reflects its live state. This store does not duplicate
//     that — it only adds the *roster* (multiple saved machines) and the *switch*.
//   • The legacy Connect / Mock buttons call `grbl.connect()` directly. We
//     subscribe to `grbl.onActiveChange(...)` so those connections are reflected
//     here too (auto-registered as an entry) — nothing breaks if the manager is
//     never used.
//
// SCOPE: the controller currently holds ONE live GrblConnection at a time, so we
// support multiple SAVED machines you connect/switch between one-active-at-a-time.
// The store is structured (per-entry status, ids, transport descriptors) so that
// graduating to several simultaneous live connections later is additive.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { grbl, type ActivePortInfo } from '../serial/controller'
import { MockPort, WsPort } from '../serial'
import type { PortLike } from '../serial/grblConnection'
import { useMachine } from './machine'
import { useMachineProfile } from './machineProfile'
import type { ControllerKind } from '../machine/types'

export type TransportKind = 'serial' | 'mock' | 'websocket'
export type MachineLinkStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Firmware classified by a port probe (see serial/portScan.ts). */
export type DetectedFirmware =
  | 'grbl'
  | 'grblhal'
  | 'fluidnc'
  | 'marlin'
  | 'smoothie'
  | 'unknown'

export interface MachineEntry {
  id: string
  /** User-facing label (defaults from the transport: port id / "Mock" / URL). */
  label: string
  kind: TransportKind
  /** For websocket transports: the ws:// or wss:// endpoint. */
  url?: string
  /** Live link status for THIS machine (only the active one is ever live). */
  status: MachineLinkStatus
  /** Last error for this machine, if any. */
  error?: string

  // ─── Auto-scan (Task #97) metadata — set for entries created by probing a
  // granted serial port. Web Serial only exposes {usbVendorId, usbProductId}
  // (no OS path), so a port is identified/deduped by those ids. ───
  /** USB vendor id of the detected serial port (for dedupe + the label). */
  usbVendorId?: number
  /** USB product id of the detected serial port. */
  usbProductId?: number
  /** Friendly USB bridge-chip / port label, e.g. "CH340 (1A86:7523)". */
  portLabel?: string
  /** Firmware detected by probing the port. */
  firmware?: DetectedFirmware
  /** Firmware version string if the probe reported one. */
  firmwareVersion?: string
}

/** A machine discovered + probed by scanGrantedPorts(), passed to upsertDetected. */
export interface DetectedMachine {
  label: string
  usbVendorId?: number
  usbProductId?: number
  portLabel: string
  firmware: DetectedFirmware
  firmwareVersion?: string
}

interface MachinesState {
  machines: MachineEntry[]
  /** Id of the machine currently bound to the `grbl`/`useMachine` facade. */
  activeId: string | null

  /** Add a saved machine; returns its id. */
  addMachine: (m: { label?: string; kind: TransportKind; url?: string }) => string
  /**
   * Upsert a serial machine discovered by an auto-scan (Task #97). Dedupes on the
   * USB vendor:product id (the only stable identifier Web Serial exposes — there
   * is no OS port path). Updates the label/firmware/chip of an existing entry, or
   * adds a new one. Returns its id. Never disturbs the active connection.
   */
  upsertDetected: (m: DetectedMachine) => string
  /** Remove a saved machine (disconnects it first if active). */
  removeMachine: (id: string) => void
  /** Rename a saved machine. */
  renameMachine: (id: string, label: string) => void

  /**
   * Make `id` the active machine and connect it. If another machine is currently
   * connected, it is disconnected first (single live connection at a time). Safe
   * to call for an already-active+connected machine (no-op).
   */
  connectMachine: (id: string) => Promise<void>
  /** Disconnect the active machine (the facade) if it matches `id` (or any). */
  disconnectMachine: (id?: string) => Promise<void>
  /** Switch the active machine to `id`, connecting it (alias of connectMachine). */
  switchTo: (id: string) => Promise<void>

  // --- internal wiring (called by the controller subscription) ---
  /** Mark an entry's status; auto-registers a legacy connection if unknown. */
  _syncFromController: (info: ActivePortInfo, conn: MachineLinkStatus) => void
  /** Set a machine's status/error. */
  _setStatus: (id: string, status: MachineLinkStatus, error?: string) => void
}

let idSeq = 0
function newId(): string {
  idSeq += 1
  return `m${Date.now().toString(36)}${idSeq.toString(36)}`
}

function buildPort(entry: MachineEntry): PortLike | undefined {
  switch (entry.kind) {
    case 'serial':
      return undefined // undefined → controller prompts the Web Serial picker
    case 'mock':
      return new MockPort()
    case 'websocket':
      if (!entry.url) throw new Error('WebSocket machine has no URL')
      return new WsPort(entry.url)
  }
}

/**
 * Map a port-probe firmware classification to a controller PROFILE kind, so a
 * detected board connects under its real protocol/dialect (e.g. FluidNC's named
 * settings + YAML config) instead of falling back to plain GRBL. `unknown` (or
 * an unmapped value) returns null → leave the current selection untouched.
 */
function firmwareToControllerKind(fw?: DetectedFirmware): ControllerKind | null {
  switch (fw) {
    case 'grbl':
      return 'grbl'
    case 'grblhal':
      return 'grblhal'
    case 'fluidnc':
      return 'fluidnc'
    case 'marlin':
      return 'marlin'
    case 'smoothie':
      return 'smoothieware'
    default:
      return null
  }
}

/**
 * Revoke the Web Serial permission for a saved serial machine (Chrome 103+
 * `SerialPort.forget()`). Without this, "removing" a machine only drops the
 * roster row — the browser still reports the port from `getPorts()`, so it shows
 * as paired and gets silently re-discovered/re-added on the next scan. Matching
 * is by USB vendor:product (Web Serial exposes nothing more identifying).
 * Best-effort: no-op on older browsers or when the port isn't found.
 */
async function forgetGrantedPort(entry?: MachineEntry): Promise<void> {
  if (!entry || entry.kind !== 'serial' || entry.usbVendorId == null) return
  if (typeof navigator === 'undefined' || !navigator.serial) return
  try {
    const ports = await navigator.serial.getPorts()
    for (const p of ports) {
      const i = p.getInfo()
      if (i.usbVendorId === entry.usbVendorId && i.usbProductId === entry.usbProductId) {
        await (p as unknown as { forget?: () => Promise<void> }).forget?.()
      }
    }
  } catch {
    /* best-effort un-pair */
  }
}

export const useMachines = create<MachinesState>()(
  persist(
    (set, get) => ({
      machines: [],
      activeId: null,

      addMachine: ({ label, kind, url }) => {
        const id = newId()
        const fallback =
          kind === 'mock' ? 'Mock' : kind === 'websocket' ? url ?? 'WebSocket' : 'Serial'
        const entry: MachineEntry = {
          id,
          label: (label && label.trim()) || fallback,
          kind,
          url: kind === 'websocket' ? url : undefined,
          status: 'disconnected',
        }
        set((s) => ({ machines: [...s.machines, entry] }))
        return id
      },

      upsertDetected: (m) => {
        // Dedupe by USB vendor:product. Two ports with the SAME vendor:product
        // (e.g. two identical CH340 boards) are indistinguishable to Web Serial —
        // they collapse into one farm entry, which is the honest representation of
        // what the API tells us. If ids are missing, dedupe by portLabel instead.
        const matchKey = (e: MachineEntry): boolean =>
          m.usbVendorId != null && m.usbProductId != null
            ? e.kind === 'serial' &&
              e.usbVendorId === m.usbVendorId &&
              e.usbProductId === m.usbProductId
            : e.kind === 'serial' && e.portLabel === m.portLabel
        const existing = get().machines.find(matchKey)
        if (existing) {
          set((s) => ({
            machines: s.machines.map((e) =>
              e.id === existing.id
                ? {
                    ...e,
                    label: m.label,
                    portLabel: m.portLabel,
                    firmware: m.firmware,
                    firmwareVersion: m.firmwareVersion,
                    usbVendorId: m.usbVendorId,
                    usbProductId: m.usbProductId,
                  }
                : e,
            ),
          }))
          return existing.id
        }
        const id = newId()
        const entry: MachineEntry = {
          id,
          label: m.label,
          kind: 'serial',
          status: 'disconnected',
          usbVendorId: m.usbVendorId,
          usbProductId: m.usbProductId,
          portLabel: m.portLabel,
          firmware: m.firmware,
          firmwareVersion: m.firmwareVersion,
        }
        set((s) => ({ machines: [...s.machines, entry] }))
        return id
      },

      removeMachine: (id) => {
        const { activeId } = get()
        const entry = get().machines.find((m) => m.id === id)
        if (activeId === id && grbl.isConnected) void grbl.disconnect()
        // Truly un-pair: revoke the Web Serial grant so it doesn't linger as
        // "paired" and get re-discovered/re-added on the next granted-port scan.
        void forgetGrantedPort(entry)
        set((s) => ({
          machines: s.machines.filter((m) => m.id !== id),
          activeId: s.activeId === id ? null : s.activeId,
        }))
      },

      renameMachine: (id, label) =>
        set((s) => ({
          machines: s.machines.map((m) =>
            m.id === id ? { ...m, label: label.trim() || m.label } : m,
          ),
        })),

      connectMachine: async (id) => {
        const entry = get().machines.find((m) => m.id === id)
        if (!entry) return
        // Already the active, connected machine? Nothing to do.
        if (get().activeId === id && grbl.isConnected) return
        // Single live connection: drop whatever is connected first.
        if (grbl.isConnected) {
          try {
            await grbl.disconnect()
          } catch {
            /* ignore */
          }
        }
        set({ activeId: id })
        get()._setStatus(id, 'connecting', undefined)
        // Connect under the DETECTED firmware's profile so e.g. a FluidNC board
        // resolves the FluidNC dialect (named settings + YAML config in Motion)
        // instead of defaulting to plain GRBL. This also persists into the
        // preferred-port record, so future auto-connects restore the right
        // controller. `unknown` firmware leaves the current selection alone.
        const kind = firmwareToControllerKind(entry.firmware)
        if (kind && kind !== useMachineProfile.getState().controllerKind) {
          useMachineProfile.getState().setControllerKind(kind)
        }
        try {
          let port = buildPort(entry)
          // Detected serial machine: open its ALREADY-GRANTED port directly by
          // matching the USB vendor:product via navigator.serial.getPorts() — so
          // connecting needs NO Web Serial chooser. Only falls back to the picker
          // (buildPort's undefined) when the granted port can't be found.
          if (
            entry.kind === 'serial' &&
            entry.usbVendorId != null &&
            typeof navigator !== 'undefined' &&
            navigator.serial
          ) {
            try {
              const ports = await navigator.serial.getPorts()
              const match = ports.find((p) => {
                const i = p.getInfo()
                return i.usbVendorId === entry.usbVendorId && i.usbProductId === entry.usbProductId
              })
              if (match) port = match as unknown as PortLike
            } catch {
              /* fall back to the picker */
            }
          }
          await grbl.connect(port, {
            meta: {
              machineId: id,
              label: entry.label,
              kind: entry.kind,
              usbVendorId: entry.usbVendorId,
              usbProductId: entry.usbProductId,
            },
          })
          get()._setStatus(id, 'connected')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          get()._setStatus(id, 'error', msg)
        }
      },

      switchTo: (id) => get().connectMachine(id),

      disconnectMachine: async (id) => {
        const { activeId } = get()
        if (id && id !== activeId) return
        if (grbl.isConnected) {
          try {
            await grbl.disconnect()
          } catch {
            /* ignore */
          }
        }
        if (activeId) get()._setStatus(activeId, 'disconnected')
      },

      _syncFromController: (info, conn) => {
        // If the controller connected to something the manager doesn't know about
        // (legacy Connect/Mock buttons), auto-register it so the appbar shows it.
        let id = info.machineId ?? null
        if (info.connected && !id) {
          // Prefer matching an existing entry by USB vendor:product — the SAME
          // stable id an auto-scan dedupes on — so a live device merges into its
          // scanned "GRBL …" entry instead of spawning a duplicate "USB …" row.
          // Fall back to kind+label for transports without USB ids (mock/ws/BLE).
          const existing =
            (info.usbVendorId != null
              ? get().machines.find(
                  (m) =>
                    m.kind === (info.kind ?? 'serial') &&
                    m.usbVendorId === info.usbVendorId &&
                    m.usbProductId === info.usbProductId,
                )
              : undefined) ??
            get().machines.find(
              (m) => m.kind === (info.kind ?? 'serial') && m.label === (info.label ?? ''),
            )
          if (existing) {
            id = existing.id
          } else {
            id = newId()
            const entry: MachineEntry = {
              id,
              label: info.label ?? (info.kind === 'mock' ? 'Mock' : 'Serial'),
              kind: info.kind ?? 'serial',
              status: 'disconnected',
              // Stamp the USB ids so a later scan dedupes onto THIS entry.
              usbVendorId: info.usbVendorId,
              usbProductId: info.usbProductId,
            }
            set((s) => ({ machines: [...s.machines, entry] }))
          }
        }
        if (info.connected && id) {
          set({ activeId: id })
          get()._setStatus(id, conn)
        } else if (!info.connected) {
          // Disconnected: clear the active entry's live status, keep it saved.
          const targetId = id ?? get().activeId
          if (targetId) get()._setStatus(targetId, conn === 'connected' ? 'disconnected' : conn)
        }
      },

      _setStatus: (id, status, error) =>
        set((s) => ({
          machines: s.machines.map((m) =>
            m.id === id ? { ...m, status, error: status === 'error' ? error : undefined } : m,
          ),
        })),
    }),
    {
      name: 'karmyogi.machines',
      // Persist only the saved roster (not live status). Status is always
      // recomputed from the controller at runtime.
      partialize: (s) => ({
        machines: s.machines.map((m) => ({
          id: m.id,
          label: m.label,
          kind: m.kind,
          url: m.url,
          status: 'disconnected' as MachineLinkStatus,
          // Persist the scan metadata so detected machines keep their port label
          // + firmware across reloads (and dedupe correctly on the next scan).
          usbVendorId: m.usbVendorId,
          usbProductId: m.usbProductId,
          portLabel: m.portLabel,
          firmware: m.firmware,
          firmwareVersion: m.firmwareVersion,
        })),
        activeId: s.activeId,
      }),
      onRehydrateStorage: () => (state) => {
        // On reload nothing is live: reset every saved machine to disconnected.
        if (!state) return
        state.machines = state.machines.map((m) => ({ ...m, status: 'disconnected', error: undefined }))
      },
    },
  ),
)

// --- wire the controller → manager so the facade and roster stay in sync ------
// Reflect connect/disconnect from the controller (incl. legacy Connect/Mock and
// the bridge / auto-reconnect) into the manager's roster + active id.
grbl.onActiveChange((info) => {
  const conn = useMachine.getState().connection
  const status: MachineLinkStatus = info.connected
    ? conn === 'connecting'
      ? 'connecting'
      : 'connected'
    : 'disconnected'
  useMachines.getState()._syncFromController(info, status)
})

// Reflect the active machine's connecting/connected/disconnected transitions
// from useMachine (which the facade updates) onto the active entry's status.
useMachine.subscribe((s, prev) => {
  if (s.connection === prev.connection) return
  const { activeId, _setStatus } = useMachines.getState()
  if (!activeId) return
  if (s.connection === 'connecting') _setStatus(activeId, 'connecting')
  else if (s.connection === 'connected') _setStatus(activeId, 'connected')
  else if (s.connection === 'disconnected') {
    // Don't clobber an 'error' status set by connectMachine's catch.
    const cur = useMachines.getState().machines.find((m) => m.id === activeId)
    if (cur && cur.status !== 'error') _setStatus(activeId, 'disconnected')
  }
})
