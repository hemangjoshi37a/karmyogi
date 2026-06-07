// Tool / bit library + safe-passes recommender — UI-independent, pure TypeScript.
// No React / DOM / three / zustand imports here (mirrors the Qt cadcam lib split).
//
// This is the project's "safe passes" brain: combine a chosen MaterialPreset
// with a chosen BitPreset and emit ready-to-use, conservative cutting numbers
// (feeds, speeds, stepdown, stepover) for a CNC-3018-class hobby router. The
// material carries the baseline recipe (tuned for a ~3mm reference bit); this
// module scales it for the actual bit diameter and keeps V-bit / engraving /
// drill behaviour sane.

import type { MaterialPreset } from './materials';

/** Physical class of cutter. Drives both the picker and recommend() logic. */
export type BitType = 'flat' | 'ball' | 'vbit' | 'engraving' | 'drill';

/** Display metadata for a bit class (one entry per BitType). */
export interface BitTypeInfo {
  type: BitType;
  name: string;
  i18nKey: string;
  icon: string;
  desc: string;
}

/** Catalogue of bit classes for the type picker. */
export const BIT_TYPES: BitTypeInfo[] = [
  {
    type: 'flat',
    name: 'Flat / end mill',
    i18nKey: 'bit.flat',
    icon: '🔲',
    desc: 'Flat-bottomed end mill — pockets, profiles and general cutting.',
  },
  {
    type: 'ball',
    name: 'Ball nose',
    i18nKey: 'bit.ball',
    icon: '⚫',
    desc: 'Rounded tip — smooth 3D relief carving and contoured surfaces.',
  },
  {
    type: 'vbit',
    name: 'V-bit',
    i18nKey: 'bit.vbit',
    icon: '▽',
    desc: 'Pointed V cutter — sign-making, V-carving and PCB isolation.',
  },
  {
    type: 'engraving',
    name: 'Engraving',
    i18nKey: 'bit.engraving',
    icon: '✒',
    desc: 'Tiny-tipped conical cutter — fine line engraving and detail.',
  },
  {
    type: 'drill',
    name: 'Drill',
    i18nKey: 'bit.drill',
    icon: '🪡',
    desc: 'Drill bit — vertical holes (e.g. PCB vias), peck-drilled.',
  },
];

/** A concrete bit you can select. Diameters in mm. */
export interface BitPreset {
  /** Stable id (e.g. 'flat-3.175'). */
  id: string;
  type: BitType;
  /** Display name, e.g. '1/8" Flat (3.175mm)' (English source-of-truth). */
  name: string;
  /** i18n lookup key for {@link name}, e.g. 'bit.size.flat-3.175'. */
  i18nKey: string;
  /** Emoji glyph for the picker. */
  icon: string;
  /** Cutting diameter (mm). For vbit/engraving this is the body/max width. */
  diameter: number;
  /** Included angle in degrees for vbit/engraving (e.g. 30/60/90). */
  angle?: number;
  /** Flute count, where meaningful. */
  flutes?: number;
}

/**
 * Common real-world bits for a hobby ER11 router. Glyphs come from BIT_TYPES so
 * the picker stays consistent. Ordered by type, then by size.
 */
export const BITS: BitPreset[] = [
  // ---- Flat / end mills ----------------------------------------------------
  { id: 'flat-1.0', type: 'flat', name: '1mm Flat', i18nKey: 'bit.size.flat-1.0', icon: '🔲', diameter: 1.0, flutes: 2 },
  { id: 'flat-1.5875', type: 'flat', name: '1/16" Flat (1.5875mm)', i18nKey: 'bit.size.flat-1.5875', icon: '🔲', diameter: 1.5875, flutes: 2 },
  { id: 'flat-2.0', type: 'flat', name: '2mm Flat', i18nKey: 'bit.size.flat-2.0', icon: '🔲', diameter: 2.0, flutes: 2 },
  { id: 'flat-3.0', type: 'flat', name: '3mm Flat', i18nKey: 'bit.size.flat-3.0', icon: '🔲', diameter: 3.0, flutes: 2 },
  { id: 'flat-3.175', type: 'flat', name: '1/8" Flat (3.175mm)', i18nKey: 'bit.size.flat-3.175', icon: '🔲', diameter: 3.175, flutes: 2 },
  { id: 'flat-6.0', type: 'flat', name: '6mm Flat', i18nKey: 'bit.size.flat-6.0', icon: '🔲', diameter: 6.0, flutes: 2 },
  // ---- Ball nose -----------------------------------------------------------
  { id: 'ball-1.5', type: 'ball', name: '1.5mm Ball', i18nKey: 'bit.size.ball-1.5', icon: '⚫', diameter: 1.5, flutes: 2 },
  { id: 'ball-2.0', type: 'ball', name: '2mm Ball', i18nKey: 'bit.size.ball-2.0', icon: '⚫', diameter: 2.0, flutes: 2 },
  { id: 'ball-3.175', type: 'ball', name: '1/8" Ball (3.175mm)', i18nKey: 'bit.size.ball-3.175', icon: '⚫', diameter: 3.175, flutes: 2 },
  { id: 'ball-6.0', type: 'ball', name: '6mm Ball', i18nKey: 'bit.size.ball-6.0', icon: '⚫', diameter: 6.0, flutes: 2 },
  // ---- V-bits --------------------------------------------------------------
  { id: 'vbit-30', type: 'vbit', name: '30° V-bit', i18nKey: 'bit.size.vbit-30', icon: '▽', diameter: 3.175, angle: 30, flutes: 1 },
  { id: 'vbit-60', type: 'vbit', name: '60° V-bit', i18nKey: 'bit.size.vbit-60', icon: '▽', diameter: 3.175, angle: 60, flutes: 1 },
  { id: 'vbit-90', type: 'vbit', name: '90° V-bit', i18nKey: 'bit.size.vbit-90', icon: '▽', diameter: 3.175, angle: 90, flutes: 1 },
  // ---- Engraving -----------------------------------------------------------
  { id: 'engraving-20', type: 'engraving', name: '0.1mm Engraving (20°)', i18nKey: 'bit.size.engraving-20', icon: '✒', diameter: 0.1, angle: 20, flutes: 1 },
  { id: 'engraving-30', type: 'engraving', name: '0.1mm Engraving (30°)', i18nKey: 'bit.size.engraving-30', icon: '✒', diameter: 0.1, angle: 30, flutes: 1 },
  // ---- Drills --------------------------------------------------------------
  { id: 'drill-0.8', type: 'drill', name: '0.8mm Drill', i18nKey: 'bit.size.drill-0.8', icon: '🪡', diameter: 0.8, flutes: 2 },
  { id: 'drill-1.0', type: 'drill', name: '1.0mm Drill', i18nKey: 'bit.size.drill-1.0', icon: '🪡', diameter: 1.0, flutes: 2 },
  { id: 'drill-3.175', type: 'drill', name: '1/8" Drill (3.175mm)', i18nKey: 'bit.size.drill-3.175', icon: '🪡', diameter: 3.175, flutes: 2 },
];

/** All bits of a given class, in catalogue order. */
export function bitsOfType(type: BitType): BitPreset[] {
  return BITS.filter((b) => b.type === type);
}

/** Look up a bit by id. Returns undefined when unknown. */
export function getBit(id: string): BitPreset | undefined {
  return BITS.find((b) => b.id === id);
}

/** Global default bit. MUST stay valid — other modules hardcode 'flat-3.175'. */
export const DEFAULT_BIT_ID = 'flat-3.175';

/** Reference bit diameter (mm) the material baselines are tuned for. */
const REFERENCE_DIAMETER = 3.175; // 1/8"

/** Floor for any cutting/sideways step (mm) so we never emit a zero pass. */
const MIN_STEP_MM = 0.05;

/** A fully resolved, ready-to-cut recommendation. Distances mm, feeds mm/min. */
export interface CutRecommendation {
  feedXY: number;
  feedZ: number;
  spindleRPM: number;
  /** Depth per pass (mm) — already = fraction × diameter, clamped sane. */
  stepdown: number;
  /** Sideways stepover (mm). */
  stepover: number;
  /** Sideways stepover as a fraction of diameter (0..1) for fraction-based params. */
  stepoverFraction: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Round a feed to a tidy whole mm/min (avoids ugly 437.21 values in the UI). */
function roundFeed(v: number): number {
  return Math.max(MIN_STEP_MM, Math.round(v));
}

/** Round a small distance to 0.01mm. */
function roundStep(v: number): number {
  return Math.max(MIN_STEP_MM, Math.round(v * 100) / 100);
}

/**
 * Combine a material recipe and a bit into safe, ready-to-use numbers.
 *
 * Strategy:
 *  - Feeds scale gently with bit diameter (a smaller bit is more fragile, so
 *    cut slower; a bigger bit can take more). We clamp the scale to [0.4, 1.6]
 *    of the material's reference feed so tiny bits don't stall and big bits
 *    don't get pushed past what a 3018 can handle.
 *  - stepdown / stepover come from the material's fractions × diameter, floored
 *    so we never emit a zero pass.
 *  - Per bit-type tweaks keep the result physically sensible:
 *      vbit/engraving — cap stepdown small (you ride the tip, not plunge deep);
 *                       a slightly slower feed for the fine point.
 *      drill          — stepover is irrelevant (set to the diameter); plunge
 *                       only, with a shallow peck depth and a gentle Z feed.
 */
export function recommend(material: MaterialPreset, bit: BitPreset): CutRecommendation {
  const dia = bit.diameter > 0 ? bit.diameter : REFERENCE_DIAMETER;

  // Gentle diameter-proportional feed scaling around the reference bit.
  const feedScale = clamp(dia / REFERENCE_DIAMETER, 0.4, 1.6);
  let feedXY = material.feedXY * feedScale;
  let feedZ = material.feedZ * feedScale;
  let spindleRPM = material.spindleRPM;

  // Baseline passes from the material fractions.
  let stepdown = Math.max(MIN_STEP_MM, material.stepdownFraction * dia);
  let stepoverFraction = material.stepoverFraction;
  let stepover = Math.max(MIN_STEP_MM, stepoverFraction * dia);

  switch (bit.type) {
    case 'vbit': {
      // V-carving rides the point; depth is driven by line width, not a bulk
      // plunge. Cap the pass shallow and ease the feed for the fine tip.
      stepdown = Math.min(stepdown, 1.0);
      feedXY *= 0.8;
      feedZ *= 0.8;
      break;
    }
    case 'engraving': {
      // A tiny conical tip is delicate — very shallow passes, slow and steady.
      stepdown = Math.min(stepdown, 0.3);
      feedXY *= 0.6;
      feedZ *= 0.6;
      // Stepover for the tip body, not the (large) shank diameter.
      stepover = Math.min(stepover, 0.2);
      stepoverFraction = stepover / dia;
      break;
    }
    case 'drill': {
      // Drilling is a plunge-only op: no sideways motion, peck shallow so chips
      // clear and a small bit doesn't snap.
      stepoverFraction = 1.0;
      stepover = dia; // n/a — full diameter
      stepdown = Math.min(stepdown, dia); // peck depth ≤ one diameter
      feedZ = Math.min(feedZ, material.feedZ * 0.75); // ease the plunge
      break;
    }
    case 'ball':
    case 'flat':
    default:
      break;
  }

  return {
    feedXY: roundFeed(feedXY),
    feedZ: roundFeed(feedZ),
    spindleRPM: Math.round(spindleRPM),
    stepdown: roundStep(stepdown),
    stepover: roundStep(stepover),
    // Keep the fraction in a sane 0..1 band for fraction-based consumers.
    stepoverFraction: clamp(Math.round(stepoverFraction * 1000) / 1000, 0.01, 1),
  };
}
