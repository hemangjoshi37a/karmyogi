// FDM print presets — pure data + a tiny resolver. UI-independent (no React/DOM).
//
// A preset is the cross-product of a MATERIAL (PLA / PETG / ABS / TPU) and a
// QUALITY (draft / standard / fine). Material fixes the thermal + retraction
// envelope; quality fixes the layer height / speed / line-width trade-off. The
// resolver merges the two into a flat parameter patch the panel spreads over its
// own PrintSettings (so a preset is one-click apply, then freely editable).

/** Material families we ship presets for. */
export type PresetMaterial = 'pla' | 'petg' | 'abs' | 'tpu';
/** Quality tiers (speed/detail trade-off). */
export type PresetQuality = 'draft' | 'standard' | 'fine';

/** The slicing/print parameters a preset can set. Mirrors PrintSettings fields. */
export interface PrintPresetPatch {
  layerHeight: number;
  lineWidth: number;
  printSpeed: number;       // mm/min
  travelSpeed: number;      // mm/min
  firstLayerSpeed: number;  // mm/min
  nozzleTemp: number;       // °C
  firstLayerTemp: number;   // °C
  bedTemp: number;          // °C
  retractDistance: number;  // mm
  retractSpeed: number;     // mm/min
  fan: boolean;
}

interface MaterialProfile {
  nozzleTemp: number;
  firstLayerTemp: number;
  bedTemp: number;
  retractDistance: number;
  retractSpeed: number;     // mm/min
  fan: boolean;
  /** Per-material speed scaler (TPU/ABS print slower than PLA). */
  speedScale: number;
}

interface QualityProfile {
  layerHeight: number;
  lineWidth: number;
  printSpeed: number;       // mm/min (PLA reference; scaled by material)
  travelSpeed: number;      // mm/min
}

export const MATERIAL_PROFILES: Record<PresetMaterial, MaterialProfile> = {
  pla: { nozzleTemp: 210, firstLayerTemp: 215, bedTemp: 60, retractDistance: 1.0, retractSpeed: 2400, fan: true, speedScale: 1.0 },
  petg: { nozzleTemp: 235, firstLayerTemp: 240, bedTemp: 80, retractDistance: 1.5, retractSpeed: 1800, fan: true, speedScale: 0.8 },
  abs: { nozzleTemp: 245, firstLayerTemp: 250, bedTemp: 100, retractDistance: 0.8, retractSpeed: 2400, fan: false, speedScale: 0.85 },
  tpu: { nozzleTemp: 225, firstLayerTemp: 228, bedTemp: 50, retractDistance: 0.6, retractSpeed: 1200, fan: true, speedScale: 0.45 },
};

export const QUALITY_PROFILES: Record<PresetQuality, QualityProfile> = {
  draft: { layerHeight: 0.3, lineWidth: 0.5, printSpeed: 3000, travelSpeed: 7200 },
  standard: { layerHeight: 0.2, lineWidth: 0.4, printSpeed: 2400, travelSpeed: 6000 },
  fine: { layerHeight: 0.12, lineWidth: 0.4, printSpeed: 1800, travelSpeed: 6000 },
};

export const MATERIAL_LABELS: Record<PresetMaterial, string> = {
  pla: 'PLA', petg: 'PETG', abs: 'ABS', tpu: 'TPU',
};
export const QUALITY_LABELS: Record<PresetQuality, string> = {
  draft: 'Draft', standard: 'Standard', fine: 'Fine',
};

/**
 * Resolve a (material, quality) pair into a flat parameter patch. Print speeds
 * are scaled by the material's `speedScale`; the first layer always prints at
 * ~half the print speed for adhesion (floored so it never goes silly-slow).
 */
export function resolvePreset(material: PresetMaterial, quality: PresetQuality): PrintPresetPatch {
  const m = MATERIAL_PROFILES[material];
  const q = QUALITY_PROFILES[quality];
  const printSpeed = Math.round(q.printSpeed * m.speedScale);
  return {
    layerHeight: q.layerHeight,
    lineWidth: q.lineWidth,
    printSpeed,
    travelSpeed: q.travelSpeed,
    firstLayerSpeed: Math.max(600, Math.round(printSpeed * 0.5)),
    nozzleTemp: m.nozzleTemp,
    firstLayerTemp: m.firstLayerTemp,
    bedTemp: m.bedTemp,
    retractDistance: m.retractDistance,
    retractSpeed: m.retractSpeed,
    fan: m.fan,
  };
}

export const PRESET_MATERIALS: PresetMaterial[] = ['pla', 'petg', 'abs', 'tpu'];
export const PRESET_QUALITIES: PresetQuality[] = ['draft', 'standard', 'fine'];
