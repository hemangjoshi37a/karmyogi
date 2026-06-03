// Machine-abstraction layer — controller registry (plan.md §8.2, §8.5).
//
// The single source of truth for which controllers karmyogi knows about and what
// each can do. GRBL is the default; FluidNC / grblHAL / Marlin reuse the GRBL
// streaming path (`grblCompatible`). Ruida is listed honestly as experimental and
// NOT grblCompatible — its proprietary binary protocol is not wired for live
// connect yet (see src/serial/controller.ts).

import type { ControllerKind, ControllerProfile } from './types'

const STANDARD_3AXIS = ['X', 'Y', 'Z'] as const

export const CONTROLLER_PROFILES: Record<ControllerKind, ControllerProfile> = {
  grbl: {
    kind: 'grbl',
    label: 'GRBL',
    machineType: 'cnc3',
    baud: 115200,
    capabilities: {
      axes: [...STANDARD_3AXIS],
      hasSpindle: true,
      hasLaser: false,
      hasHoming: true,
      hasProbe: true,
    },
    grblCompatible: true,
    supported: 'full',
    transport: 'webserial',
    settingsModel: 'grbl',
    notes: '3-axis CNC controller. The reference firmware — full support.',
  },
  fluidnc: {
    kind: 'fluidnc',
    label: 'FluidNC',
    machineType: 'cnc3',
    baud: 115200,
    capabilities: {
      // FluidNC allows extra axes; default to a standard 3-axis layout plus A.
      axes: ['X', 'Y', 'Z', 'A'],
      hasSpindle: true,
      hasLaser: true,
      hasHoming: true,
      hasProbe: true,
    },
    grblCompatible: true,
    supported: 'full',
    transport: 'webserial',
    // FluidNC exposes GRBL `$`-settings over serial (plus a YAML config), so the
    // classic `$`-editor works.
    settingsModel: 'grbl',
    notes:
      'ESP32 firmware. GRBL-compatible streaming/realtime/status over Web Serial; YAML config, extra axes.',
  },
  grblhal: {
    kind: 'grblhal',
    label: 'grblHAL',
    machineType: 'cnc3',
    baud: 115200,
    capabilities: {
      axes: [...STANDARD_3AXIS],
      hasSpindle: true,
      hasLaser: false,
      hasHoming: true,
      hasProbe: true,
    },
    grblCompatible: true,
    supported: 'full',
    transport: 'webserial',
    // grblHAL keeps GRBL `$`-settings but extends the set; the `$$`-driven editor
    // lists whatever the controller reports, so the extended superset just works.
    settingsModel: 'grblhal',
    notes: 'GRBL successor (32-bit). GRBL-compatible dialect — full support.',
  },
  marlin: {
    kind: 'marlin',
    label: 'Marlin',
    machineType: 'cnc3',
    baud: 115200,
    capabilities: {
      axes: [...STANDARD_3AXIS],
      hasSpindle: true,
      hasLaser: false,
      hasHoming: true,
      hasProbe: false,
    },
    // Line-based, ok-acknowledged streaming — usable via the existing path, but
    // GRBL-specific `$`/realtime niceties differ, so flag it experimental.
    grblCompatible: true,
    supported: 'experimental',
    transport: 'webserial',
    // Marlin keeps settings in EEPROM, managed via M-codes (M503 report, M500 save)
    // — NOT a GRBL `$`-table.
    settingsModel: 'marlin',
    notes:
      'Line-based ok-ack streaming. Usable, but `$`-settings/realtime differ from GRBL — experimental.',
  },
  smoothieware: {
    kind: 'smoothieware',
    label: 'Smoothieware',
    machineType: 'cnc3',
    baud: 115200,
    capabilities: {
      axes: [...STANDARD_3AXIS],
      hasSpindle: true,
      hasLaser: false,
      hasHoming: true,
      hasProbe: false,
    },
    // Line-based G-code with ok-ack; speaks enough of the GRBL streaming dialect
    // for our sender, but not all `$`/realtime niceties — so flag experimental.
    grblCompatible: true,
    supported: 'experimental',
    transport: 'webserial',
    // Smoothieware settings live in the `config` file, read/written with
    // `config-get` / `config-set` — not a GRBL `$`-table.
    settingsModel: 'smoothie',
    notes:
      'Line-based G-code over USB serial (ok-ack); GRBL-compatible streaming — experimental.',
  },
  ruida: {
    kind: 'ruida',
    label: 'Ruida',
    machineType: 'laser2d',
    baud: 115200,
    capabilities: {
      axes: ['X', 'Y'],
      hasSpindle: false,
      hasLaser: true,
      hasHoming: true,
      hasProbe: false,
    },
    // Proprietary scrambled binary protocol (RDC644xx CO2 laser controllers).
    // Live USB/Web-Serial connect is NOT wired — do not fake it.
    grblCompatible: false,
    supported: 'experimental',
    transport: 'webserial',
    // No host-editable machine settings over this connection — configure in the
    // controller's own laser software.
    settingsModel: 'none',
    notes:
      'CO2 laser controller. Proprietary binary protocol — live connection not supported yet (use Mock).',
  },
  // --- Fiber / galvo laser sources (MAX, Raycus, JPT, IPG …) ---
  // Note: "MAX" and "Raycus" are fiber-laser SOURCE brands, not control firmware.
  // The source is driven by a separate control board. The two common families:
  //   • EzCAD / BJJCZ (LMC) galvo marking boards  → kind 'ezcad'
  //   • Cypcut / FSCUT (Friendess) gantry cutters → kind 'fscut'
  // Both speak proprietary protocols (not GRBL), so live connect is NOT wired —
  // listed honestly as experimental so MAX/Raycus owners see their hardware.
  ezcad: {
    kind: 'ezcad',
    label: 'EzCAD / BJJCZ (galvo fiber)',
    machineType: 'galvo',
    baud: 115200,
    capabilities: {
      // Galvo marker: XY is the mirror-steered scan field, Z is focus height.
      axes: ['X', 'Y', 'Z'],
      hasSpindle: false,
      hasLaser: true,
      hasHoming: false,
      hasProbe: false,
    },
    // BJJCZ LMC boards use a proprietary USB/.ezd protocol (EzCAD2/LightBurn).
    grblCompatible: false,
    supported: 'experimental',
    transport: 'webserial',
    settingsModel: 'none',
    notes:
      'Galvo fiber/UV marker (MAX, Raycus, JPT, IPG sources via a BJJCZ/LMC board). ' +
      'Proprietary EzCAD protocol — live connection not supported yet (use Mock).',
  },
  fscut: {
    kind: 'fscut',
    label: 'Cypcut / FSCUT (fiber gantry)',
    machineType: 'laser2d',
    baud: 115200,
    capabilities: {
      axes: ['X', 'Y', 'Z'],
      hasSpindle: false,
      hasLaser: true,
      hasHoming: true,
      hasProbe: false,
    },
    // Friendess FSCUT/Cypcut industrial controllers — proprietary bus, no Web Serial.
    grblCompatible: false,
    supported: 'experimental',
    transport: 'webserial',
    settingsModel: 'none',
    notes:
      'Gantry fiber sheet cutter (MAX/Raycus/IPG source on a Friendess FSCUT/Cypcut controller). ' +
      'Proprietary protocol — live connection not supported yet (use Mock).',
  },
}

/** Ordered list for menus: default + fully-supported first, experimental last. */
export const CONTROLLER_LIST: ControllerProfile[] = [
  CONTROLLER_PROFILES.grbl,
  CONTROLLER_PROFILES.fluidnc,
  CONTROLLER_PROFILES.grblhal,
  CONTROLLER_PROFILES.marlin,
  CONTROLLER_PROFILES.smoothieware,
  CONTROLLER_PROFILES.ruida,
  CONTROLLER_PROFILES.ezcad,
  CONTROLLER_PROFILES.fscut,
]

export const DEFAULT_CONTROLLER_KIND: ControllerKind = 'grbl'

/** Resolve a (possibly unknown / corrupted) kind to a profile, falling back to GRBL. */
export function profileFor(kind: ControllerKind | string | null | undefined): ControllerProfile {
  if (kind && kind in CONTROLLER_PROFILES) {
    return CONTROLLER_PROFILES[kind as ControllerKind]
  }
  return CONTROLLER_PROFILES[DEFAULT_CONTROLLER_KIND]
}

/**
 * Can we attempt a real (non-mock) connection to this controller today?
 * GRBL-compatible firmware uses the streaming path; everything else (Ruida) is
 * honest about not being wired yet.
 */
export function canLiveConnect(profile: ControllerProfile): boolean {
  return profile.grblCompatible
}
