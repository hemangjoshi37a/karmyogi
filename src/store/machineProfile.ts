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
import { useBed } from './bed'

// ─── X3: Machine profile LIBRARY ──────────────────────────────────────────────
// A curated catalogue of popular hobby/desktop machines. Unlike the controller
// FIRMWARE registry (src/machine/controllers.ts — GRBL/FluidNC/Marlin/…), a
// "machine model" is a physical product: it pins the firmware AND the work-area
// (bed) envelope AND representative factory $-settings. The connection wizard (X2)
// and a "restore defaults" action build on this so a user can pick "Genmitsu
// 3018-PRO" and get the right bed size + firmware in one click instead of typing
// envelope numbers by hand.

/** App-default work area (mm) — mirrors src/store/bed.ts initial state. */
const DEFAULT_BED = { width: 300, depth: 200, height: 100 } as const

export interface MachineModel {
  /** Stable id (persisted as the active selection). */
  id: string
  /** Display name (proper noun — NOT translated). */
  label: string
  /** Vendor / brand, for grouping in the picker. */
  vendor?: string
  /** Firmware this model ships with → selects the controller profile. */
  controllerKind: ControllerKind
  /** Default serial baud (omit → the firmware profile's default baud). */
  baud?: number
  /**
   * Work-area envelope in mm (X width × Y depth × Z height). Omitted for the
   * generic/"custom" entries so picking them never clobbers the user's own bed.
   */
  bed?: { width: number; depth: number; height: number }
  /**
   * Representative factory GRBL `$`-settings (numbered keys as strings, e.g.
   * '130' = max X travel). DATA ONLY — karmyogi NEVER pushes these to a live
   * controller automatically; `restoreDefaults()` returns them so the caller can
   * OFFER to apply them (operator confirms in the Motion panel).
   */
  defaultSettings?: Record<string, number>
  /** Catch-all entry (no bed forced; user sets their own envelope). */
  generic?: boolean
  /** Short English note for the picker (UI may t()-wrap with a key). */
  notes?: string
}

export const MACHINE_MODELS: MachineModel[] = [
  // ── Generic / custom catch-alls (no bed override) ──
  {
    id: 'custom',
    label: 'Custom / Other',
    controllerKind: 'grbl',
    generic: true,
    notes: 'Set your own bed size and firmware — nothing is overridden.',
  },
  // ── SainSmart / Genmitsu desktop routers (GRBL) ──
  {
    id: 'genmitsu-3018-pro',
    label: 'Genmitsu 3018-PRO',
    vendor: 'SainSmart',
    controllerKind: 'grbl',
    bed: { width: 300, depth: 180, height: 45 },
    defaultSettings: {
      '130': 300, '131': 180, '132': 45,
      '100': 800, '101': 800, '102': 800,
      '110': 1000, '111': 1000, '112': 600,
      '120': 30, '121': 30, '122': 30,
    },
    notes: 'Popular 3018 desktop CNC. Work area ~300×180×45 mm.',
  },
  {
    id: 'genmitsu-3020-prover',
    label: 'Genmitsu PROVer 3020',
    vendor: 'SainSmart',
    controllerKind: 'grbl',
    bed: { width: 300, depth: 200, height: 60 },
    defaultSettings: { '130': 300, '131': 200, '132': 60 },
  },
  {
    id: 'genmitsu-4040-pro',
    label: 'Genmitsu 4040-PRO',
    vendor: 'SainSmart',
    controllerKind: 'grbl',
    bed: { width: 400, depth: 400, height: 78 },
    defaultSettings: { '130': 400, '131': 400, '132': 78 },
  },
  // ── Carbide 3D Shapeoko (GRBL) ──
  {
    id: 'shapeoko-3',
    label: 'Shapeoko 3 (Standard)',
    vendor: 'Carbide 3D',
    controllerKind: 'grbl',
    bed: { width: 425, depth: 425, height: 95 },
    defaultSettings: { '130': 425, '131': 425, '132': 95 },
  },
  {
    id: 'shapeoko-xxl',
    label: 'Shapeoko XXL',
    vendor: 'Carbide 3D',
    controllerKind: 'grbl',
    bed: { width: 838, depth: 838, height: 95 },
    defaultSettings: { '130': 838, '131': 838, '132': 95 },
  },
  // ── Inventables X-Carve (GRBL) ──
  {
    id: 'xcarve-1000',
    label: 'X-Carve 1000 mm',
    vendor: 'Inventables',
    controllerKind: 'grbl',
    bed: { width: 750, depth: 750, height: 65 },
    defaultSettings: { '130': 750, '131': 750, '132': 65 },
  },
  // ── OpenBuilds (GRBL / grblHAL) ──
  {
    id: 'openbuilds-lead-1010',
    label: 'OpenBuilds LEAD 1010',
    vendor: 'OpenBuilds',
    controllerKind: 'grbl',
    bed: { width: 810, depth: 810, height: 90 },
    defaultSettings: { '130': 810, '131': 810, '132': 90 },
  },
  {
    id: 'openbuilds-workbee-1010',
    label: 'OpenBuilds WorkBee 1010',
    vendor: 'OpenBuilds',
    controllerKind: 'grbl',
    bed: { width: 790, depth: 790, height: 90 },
  },
  // ── FluidNC reference (ESP32) ──
  {
    id: 'fluidnc-generic',
    label: 'FluidNC machine (ESP32)',
    vendor: 'FluidNC',
    controllerKind: 'fluidnc',
    generic: true,
    notes: 'ESP32 GRBL successor — connects over USB or Wi-Fi. Set your bed size.',
  },
  // ── Diode laser engraver (GRBL) ──
  {
    id: 'ortur-lm2',
    label: 'Ortur Laser Master 2',
    vendor: 'Ortur',
    controllerKind: 'grbl',
    bed: { width: 400, depth: 430, height: 50 },
    defaultSettings: { '130': 400, '131': 430 },
  },
  // ── Marlin-based (MPCNC / LowRider / converted printer) ──
  {
    id: 'marlin-generic',
    label: 'Marlin machine',
    vendor: 'Marlin',
    controllerKind: 'marlin',
    generic: true,
    notes: 'Marlin firmware (MPCNC / LowRider / converted printer). Set bed manually.',
  },
]

/** Resolve a model id to its definition (null for unknown / null id). */
export function modelFor(id: string | null | undefined): MachineModel | null {
  if (!id) return null
  return MACHINE_MODELS.find((m) => m.id === id) ?? null
}

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

  // ─── X3: machine model library + X2: first-launch flag ───
  /** The selected machine model id (null = none / custom). Persisted. */
  machineModelId: string | null
  /**
   * Apply a machine model: selects its firmware (controllerKind), its default
   * baud, and its bed envelope (skipped for generic/custom models so the user's
   * own bed is kept). Pass `null` to clear the selection without changing
   * anything. Never sends any motion/serial command.
   */
  setMachineModel: (id: string | null) => void
  /** Resolve the active machine model definition (null when none selected). */
  model: () => MachineModel | null
  /**
   * Restore-defaults: re-apply the active model's firmware/baud/bed (or, with no
   * model selected, reset firmware to GRBL + baud to the profile default + the
   * app-default bed). Returns the model's representative factory `$`-settings so
   * the caller can OFFER to push them — this action itself sends nothing.
   */
  restoreDefaults: () => Record<string, number> | null
  /**
   * Auto-detect suggestion: the model id inferred from the connected firmware
   * string (set by the connection manager on connect). A hint for the wizard —
   * never auto-applied.
   */
  detectedModelId: string | null
  /** Record an auto-detected model suggestion (or clear with null). */
  setDetectedModel: (id: string | null) => void

  /**
   * First-launch flag: false until the user has completed (or skipped) the
   * connection setup wizard. Persisted so the wizard only auto-shows once.
   */
  configured: boolean
  /** Mark setup complete — the wizard stops auto-showing. */
  markConfigured: () => void
  /** Re-open the setup wizard (e.g. from the Machines menu): clears `configured`. */
  reopenSetup: () => void
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

      // ─── X3 / X2 ───
      machineModelId: null,
      model: () => modelFor(get().machineModelId),
      setMachineModel: (id) => {
        const model = modelFor(id)
        if (id && !model) return // unknown id → no-op
        set({ machineModelId: id })
        if (!model) return
        // 1) Firmware. setControllerKind clears any baud override first…
        get().setControllerKind(model.controllerKind)
        // 2) …then pin the model's explicit baud (if any), else keep the
        //    firmware default (null override).
        set({
          baudOverride:
            model.baud != null && Number.isFinite(model.baud) && model.baud > 0
              ? Math.floor(model.baud)
              : null,
        })
        // 3) Bed envelope — only for concrete models (generic/custom keep the
        //    user's own bed). Calls the bed store's clamped setter; sends nothing.
        if (model.bed) useBed.getState().setSize(model.bed)
      },
      restoreDefaults: () => {
        const model = modelFor(get().machineModelId)
        if (model) {
          // Re-apply the model's firmware + baud + bed.
          get().setMachineModel(model.id)
          return model.defaultSettings ?? null
        }
        // No model selected → reset to bare app defaults.
        set({ controllerKind: DEFAULT_CONTROLLER_KIND, baudOverride: null })
        useBed.getState().setSize({ ...DEFAULT_BED })
        return null
      },
      detectedModelId: null,
      setDetectedModel: (id) => set({ detectedModelId: modelFor(id) ? id : null }),

      configured: false,
      markConfigured: () => set({ configured: true }),
      reopenSetup: () => set({ configured: false }),
    }),
    {
      name: 'karmyogi.machineProfile',
      // Persist the raw selection + baud override + the model/first-launch flag;
      // everything else is derived. `detectedModelId` is a transient runtime hint.
      partialize: (s) => ({
        controllerKind: s.controllerKind,
        baudOverride: s.baudOverride,
        machineModelId: s.machineModelId,
        configured: s.configured,
      }),
    },
  ),
)
