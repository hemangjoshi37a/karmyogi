// Embedded single-stroke (Hershey "simplex"-style) vector glyph data.
// UI-independent — part of the shared cadcam core. Pure data + parser.
// Ported from the Qt/C++ reference cadcam/strokefont.cpp builtin() table.
//
// Shapes are re-expressed as compact centreline polylines in dimensionless
// EM units: baseline at y=0, +y up, x grows rightward in [0, advance].
// Cap height = 0.7. Each stroke is one pen-down polyline (open).
//
// Encoding: a glyph is { adv, strokes } where each stroke is a flat number
// list [x0,y0,x1,y1,...]. Round glyphs (O, o, 0, parens, ...) are stored as
// precomputed sampled arcs so the table stays self-contained and needs no
// trig at parse time. parseHersheyGlyphs() turns this into Glyph records.

import { Point, Polyline, pt } from './geometry';

// EM design metrics — mirror the Qt reference exactly.
export const CAP = 0.7; // cap top
export const XH = 0.5; // x-height
export const DESC = -0.22; // descender depth
export const CAP_HEIGHT = CAP; // default font cap-height (EM units)

/** A raw glyph in the embedded table: advance + a list of flat point lists. */
export interface RawGlyph {
  adv: number;
  /** Each entry is [x0,y0,x1,y1,...] — one open pen-down stroke. */
  strokes: number[][];
}

/** A built glyph: advance + ready-to-draw open stroke polylines (EM units). */
export interface Glyph {
  advance: number;
  strokes: Polyline[];
}

// Sample an ellipse/circle outline as a flat [x,y,...] list (EM units). Used to
// keep round glyphs compact and trig-free at parse time. Mirrors emArc().
function arc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a0: number,
  a1: number,
  seg: number,
): number[] {
  const out: number[] = [];
  const n = seg < 2 ? 2 : seg;
  for (let i = 0; i <= n; ++i) {
    const t = a0 + (a1 - a0) * (i / n);
    out.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  }
  return out;
}

const TAU = 2 * Math.PI;

// ----------------------------------------------------------------------------
// The embedded simplex-style table. Keyed by single character.
// Coordinates derived from the public-domain Hershey "simplex" Roman set,
// matching the Qt reference glyph-for-glyph.
// ----------------------------------------------------------------------------
export const HERSHEY_SIMPLEX: Record<string, RawGlyph> = {
  ' ': { adv: 0.4, strokes: [] },

  // ===================== Uppercase =====================
  A: { adv: 0.62, strokes: [[0.02, 0.0, 0.31, CAP, 0.6, 0.0], [0.13, 0.28, 0.49, 0.28]] },
  B: {
    adv: 0.6,
    strokes: [
      [0.06, 0.0, 0.06, CAP, 0.4, CAP, 0.5, 0.62, 0.5, 0.46, 0.4, 0.38, 0.06, 0.38],
      [0.4, 0.38, 0.52, 0.3, 0.52, 0.1, 0.4, 0.0, 0.06, 0.0],
    ],
  },
  C: { adv: 0.62, strokes: [arc(0.31, 0.35, 0.29, 0.35, 0.55, TAU - 0.55, 18)] },
  D: {
    adv: 0.62,
    strokes: [
      [0.06, 0.0, 0.06, CAP],
      [0.06, CAP, 0.32, CAP, 0.52, 0.55, 0.52, 0.15, 0.32, 0.0, 0.06, 0.0],
    ],
  },
  E: { adv: 0.55, strokes: [[0.5, CAP, 0.06, CAP, 0.06, 0.0, 0.5, 0.0], [0.06, 0.35, 0.42, 0.35]] },
  F: { adv: 0.52, strokes: [[0.5, CAP, 0.06, CAP, 0.06, 0.0], [0.06, 0.35, 0.42, 0.35]] },
  G: {
    adv: 0.65,
    strokes: [arc(0.33, 0.35, 0.29, 0.35, 0.45, TAU - 0.2, 20), [0.62, 0.05, 0.62, 0.3, 0.4, 0.3]],
  },
  H: { adv: 0.62, strokes: [[0.06, 0.0, 0.06, CAP], [0.56, 0.0, 0.56, CAP], [0.06, 0.35, 0.56, 0.35]] },
  I: { adv: 0.28, strokes: [[0.14, 0.0, 0.14, CAP]] },
  J: { adv: 0.5, strokes: [[0.4, CAP, 0.4, 0.18, 0.32, 0.02, 0.18, 0.0, 0.06, 0.06, 0.04, 0.18]] },
  K: { adv: 0.6, strokes: [[0.06, 0.0, 0.06, CAP], [0.06, 0.28, 0.54, CAP], [0.22, 0.4, 0.56, 0.0]] },
  L: { adv: 0.52, strokes: [[0.06, CAP, 0.06, 0.0, 0.5, 0.0]] },
  M: { adv: 0.72, strokes: [[0.06, 0.0, 0.06, CAP, 0.36, 0.18, 0.66, CAP, 0.66, 0.0]] },
  N: { adv: 0.66, strokes: [[0.06, 0.0, 0.06, CAP, 0.6, 0.0, 0.6, CAP]] },
  O: { adv: 0.68, strokes: [arc(0.34, 0.35, 0.3, 0.35, 0.0, TAU, 24)] },
  P: {
    adv: 0.58,
    strokes: [[0.06, 0.0, 0.06, CAP], [0.06, CAP, 0.38, CAP, 0.5, 0.6, 0.5, 0.46, 0.38, 0.38, 0.06, 0.38]],
  },
  Q: { adv: 0.68, strokes: [arc(0.34, 0.35, 0.3, 0.35, 0.0, TAU, 24), [0.4, 0.18, 0.62, -0.04]] },
  R: {
    adv: 0.6,
    strokes: [
      [0.06, 0.0, 0.06, CAP],
      [0.06, CAP, 0.38, CAP, 0.5, 0.6, 0.5, 0.46, 0.38, 0.38, 0.06, 0.38],
      [0.32, 0.38, 0.54, 0.0],
    ],
  },
  S: {
    adv: 0.56,
    strokes: [
      [0.5, 0.58, 0.36, CAP, 0.16, CAP, 0.04, 0.58, 0.04, 0.48, 0.16, 0.4, 0.4, 0.3, 0.5, 0.2, 0.5, 0.1, 0.38, 0.0, 0.14, 0.0, 0.02, 0.12],
    ],
  },
  T: { adv: 0.54, strokes: [[0.0, CAP, 0.54, CAP], [0.27, CAP, 0.27, 0.0]] },
  U: { adv: 0.64, strokes: [[0.06, CAP, 0.06, 0.18, 0.18, 0.02, 0.4, 0.02, 0.52, 0.18, 0.52, CAP]] },
  V: { adv: 0.62, strokes: [[0.02, CAP, 0.31, 0.0, 0.6, CAP]] },
  W: { adv: 0.8, strokes: [[0.02, CAP, 0.2, 0.0, 0.4, 0.5, 0.6, 0.0, 0.78, CAP]] },
  X: { adv: 0.6, strokes: [[0.04, 0.0, 0.56, CAP], [0.56, 0.0, 0.04, CAP]] },
  Y: { adv: 0.58, strokes: [[0.02, CAP, 0.29, 0.38, 0.56, CAP], [0.29, 0.38, 0.29, 0.0]] },
  Z: { adv: 0.58, strokes: [[0.04, CAP, 0.54, CAP, 0.04, 0.0, 0.54, 0.0]] },

  // ===================== Lowercase =====================
  a: { adv: 0.54, strokes: [[0.46, XH, 0.46, 0.0], arc(0.26, 0.16, 0.2, 0.16, 0.0, TAU, 18)] },
  b: { adv: 0.54, strokes: [[0.06, CAP, 0.06, 0.0], arc(0.28, 0.16, 0.22, 0.16, 0.0, TAU, 18)] },
  c: { adv: 0.5, strokes: [arc(0.26, 0.16, 0.2, 0.16, 0.6, TAU - 0.6, 16)] },
  d: { adv: 0.54, strokes: [[0.46, CAP, 0.46, 0.0], arc(0.24, 0.16, 0.2, 0.16, 0.0, TAU, 18)] },
  e: { adv: 0.52, strokes: [[0.06, 0.18, 0.46, 0.18], arc(0.26, 0.16, 0.2, 0.16, 0.0, TAU - 0.9, 16)] },
  f: { adv: 0.36, strokes: [[0.32, 0.66, 0.22, CAP, 0.14, 0.62, 0.14, 0.0], [0.02, XH, 0.3, XH]] },
  g: {
    adv: 0.54,
    strokes: [arc(0.26, 0.16, 0.2, 0.16, 0.0, TAU, 18), [0.46, XH, 0.46, -0.1, 0.36, DESC, 0.16, DESC, 0.08, -0.12]],
  },
  h: { adv: 0.54, strokes: [[0.06, CAP, 0.06, 0.0], [0.06, 0.34, 0.2, XH, 0.38, XH, 0.46, 0.36, 0.46, 0.0]] },
  i: { adv: 0.22, strokes: [[0.11, XH, 0.11, 0.0], [0.11, 0.64, 0.11, 0.66]] },
  j: { adv: 0.26, strokes: [[0.16, XH, 0.16, -0.12, 0.08, DESC, 0.02, -0.18], [0.16, 0.64, 0.16, 0.66]] },
  k: { adv: 0.48, strokes: [[0.06, CAP, 0.06, 0.0], [0.06, 0.18, 0.42, XH], [0.18, 0.28, 0.44, 0.0]] },
  l: { adv: 0.22, strokes: [[0.11, CAP, 0.11, 0.0]] },
  m: {
    adv: 0.78,
    strokes: [
      [0.06, XH, 0.06, 0.0],
      [0.06, 0.36, 0.16, XH, 0.3, XH, 0.38, 0.36, 0.38, 0.0],
      [0.38, 0.36, 0.48, XH, 0.62, XH, 0.7, 0.36, 0.7, 0.0],
    ],
  },
  n: { adv: 0.54, strokes: [[0.06, XH, 0.06, 0.0], [0.06, 0.36, 0.2, XH, 0.38, XH, 0.46, 0.36, 0.46, 0.0]] },
  o: { adv: 0.54, strokes: [arc(0.27, 0.16, 0.21, 0.16, 0.0, TAU, 18)] },
  p: { adv: 0.54, strokes: [[0.06, XH, 0.06, DESC], arc(0.28, 0.16, 0.22, 0.16, 0.0, TAU, 18)] },
  q: { adv: 0.54, strokes: [[0.46, XH, 0.46, DESC], arc(0.24, 0.16, 0.22, 0.16, 0.0, TAU, 18)] },
  r: { adv: 0.4, strokes: [[0.06, XH, 0.06, 0.0], [0.06, 0.34, 0.18, XH, 0.34, XH, 0.4, 0.42]] },
  s: {
    adv: 0.46,
    strokes: [[0.4, 0.42, 0.28, XH, 0.12, XH, 0.04, 0.42, 0.12, 0.3, 0.3, 0.22, 0.38, 0.12, 0.3, 0.02, 0.12, 0.02, 0.02, 0.1]],
  },
  t: { adv: 0.34, strokes: [[0.14, 0.66, 0.14, 0.12, 0.22, 0.02, 0.3, 0.06], [0.02, XH, 0.28, XH]] },
  u: { adv: 0.54, strokes: [[0.06, XH, 0.06, 0.14, 0.14, 0.02, 0.32, 0.02, 0.46, 0.14], [0.46, XH, 0.46, 0.0]] },
  v: { adv: 0.5, strokes: [[0.02, XH, 0.25, 0.0, 0.48, XH]] },
  w: { adv: 0.7, strokes: [[0.02, XH, 0.16, 0.0, 0.34, 0.34, 0.52, 0.0, 0.66, XH]] },
  x: { adv: 0.48, strokes: [[0.04, XH, 0.44, 0.0], [0.44, XH, 0.04, 0.0]] },
  y: { adv: 0.5, strokes: [[0.02, XH, 0.25, 0.0, 0.48, XH], [0.48, XH, 0.28, -0.1, 0.14, DESC, 0.04, -0.18]] },
  z: { adv: 0.48, strokes: [[0.04, XH, 0.44, XH, 0.04, 0.0, 0.44, 0.0]] },

  // ===================== Digits =====================
  '0': { adv: 0.56, strokes: [arc(0.28, 0.35, 0.22, 0.35, 0.0, TAU, 22), [0.16, 0.12, 0.4, 0.58]] },
  '1': { adv: 0.4, strokes: [[0.1, 0.58, 0.24, CAP, 0.24, 0.0], [0.06, 0.0, 0.4, 0.0]] },
  '2': {
    adv: 0.54,
    strokes: [[0.04, 0.56, 0.16, CAP, 0.36, CAP, 0.48, 0.56, 0.48, 0.44, 0.04, 0.1, 0.04, 0.0, 0.5, 0.0]],
  },
  '3': {
    adv: 0.54,
    strokes: [
      [0.04, 0.6, 0.18, CAP, 0.38, CAP, 0.48, 0.58, 0.4, 0.42, 0.22, 0.4],
      [0.4, 0.42, 0.5, 0.28, 0.5, 0.1, 0.36, 0.0, 0.14, 0.0, 0.02, 0.12],
    ],
  },
  '4': { adv: 0.56, strokes: [[0.38, 0.0, 0.38, CAP, 0.04, 0.22, 0.52, 0.22]] },
  '5': {
    adv: 0.54,
    strokes: [[0.46, CAP, 0.1, CAP, 0.08, 0.4, 0.3, 0.46, 0.44, 0.38, 0.5, 0.22, 0.42, 0.06, 0.22, 0.0, 0.04, 0.08]],
  },
  '6': {
    adv: 0.54,
    strokes: [[0.44, 0.62, 0.3, CAP, 0.14, 0.62, 0.06, 0.36, 0.06, 0.14, 0.18, 0.0, 0.36, 0.0, 0.48, 0.14, 0.48, 0.24, 0.36, 0.36, 0.14, 0.36, 0.06, 0.26]],
  },
  '7': { adv: 0.52, strokes: [[0.04, CAP, 0.5, CAP, 0.2, 0.0]] },
  '8': {
    adv: 0.54,
    strokes: [arc(0.27, 0.53, 0.18, 0.17, 0.0, TAU, 18), arc(0.27, 0.18, 0.22, 0.18, 0.0, TAU, 18)],
  },
  '9': {
    adv: 0.54,
    strokes: [[0.1, 0.08, 0.24, 0.0, 0.4, 0.08, 0.48, 0.34, 0.48, 0.56, 0.36, CAP, 0.18, CAP, 0.06, 0.56, 0.06, 0.46, 0.18, 0.34, 0.4, 0.34, 0.48, 0.44]],
  },

  // ===================== Punctuation =====================
  '.': { adv: 0.26, strokes: [[0.12, 0.0, 0.12, 0.04]] },
  ',': { adv: 0.26, strokes: [[0.14, 0.06, 0.12, 0.0, 0.06, -0.1]] },
  ':': { adv: 0.26, strokes: [[0.12, 0.0, 0.12, 0.04], [0.12, 0.34, 0.12, 0.38]] },
  ';': { adv: 0.26, strokes: [[0.13, 0.34, 0.13, 0.38], [0.15, 0.06, 0.13, 0.0, 0.07, -0.1]] },
  '!': { adv: 0.24, strokes: [[0.12, 0.18, 0.12, CAP], [0.12, 0.0, 0.12, 0.04]] },
  '?': {
    adv: 0.5,
    strokes: [[0.04, 0.56, 0.16, CAP, 0.34, CAP, 0.46, 0.56, 0.4, 0.44, 0.25, 0.36, 0.25, 0.22], [0.25, 0.0, 0.25, 0.04]],
  },
  '-': { adv: 0.5, strokes: [[0.08, 0.35, 0.42, 0.35]] },
  _: { adv: 0.55, strokes: [[0.0, -0.05, 0.55, -0.05]] },
  '(': { adv: 0.3, strokes: [arc(0.34, 0.32, 0.26, 0.42, Math.PI - 0.9, Math.PI + 0.9, 14)] },
  ')': { adv: 0.3, strokes: [arc(-0.04, 0.32, 0.26, 0.42, -0.9, 0.9, 14)] },
  '/': { adv: 0.42, strokes: [[0.02, 0.0, 0.4, CAP]] },
  '+': { adv: 0.56, strokes: [[0.08, 0.35, 0.48, 0.35], [0.28, 0.15, 0.28, 0.55]] },
  '=': { adv: 0.56, strokes: [[0.08, 0.42, 0.48, 0.42], [0.08, 0.26, 0.48, 0.26]] },
  "'": { adv: 0.2, strokes: [[0.1, 0.56, 0.1, CAP]] },
  '"': { adv: 0.3, strokes: [[0.09, 0.56, 0.09, CAP], [0.21, 0.56, 0.21, CAP]] },

  // ----- Extra printable ASCII (0x20-0x7E) so the whole range is covered -----
  '#': {
    adv: 0.58,
    strokes: [
      [0.18, 0.0, 0.26, CAP],
      [0.34, 0.0, 0.42, CAP],
      [0.08, 0.24, 0.5, 0.24],
      [0.06, 0.46, 0.48, 0.46],
    ],
  },
  $: {
    adv: 0.56,
    strokes: [
      [0.5, 0.58, 0.36, 0.66, 0.16, 0.66, 0.04, 0.54, 0.04, 0.46, 0.16, 0.38, 0.4, 0.3, 0.5, 0.2, 0.5, 0.12, 0.38, 0.04, 0.16, 0.04, 0.04, 0.12],
      [0.27, CAP, 0.27, 0.0],
    ],
  },
  '%': {
    adv: 0.62,
    strokes: [
      [0.5, CAP, 0.06, 0.0],
      arc(0.16, 0.56, 0.1, 0.1, 0.0, TAU, 12),
      arc(0.46, 0.14, 0.1, 0.1, 0.0, TAU, 12),
    ],
  },
  '&': {
    adv: 0.66,
    strokes: [
      [0.6, 0.0, 0.18, 0.46, 0.14, 0.56, 0.2, 0.66, 0.32, 0.66, 0.38, 0.56, 0.34, 0.46, 0.06, 0.22, 0.06, 0.1, 0.16, 0.0, 0.3, 0.0, 0.5, 0.2],
    ],
  },
  '*': {
    adv: 0.46,
    strokes: [[0.23, 0.34, 0.23, 0.66], [0.09, 0.42, 0.37, 0.58], [0.37, 0.42, 0.09, 0.58]],
  },
  '@': {
    adv: 0.74,
    strokes: [
      arc(0.32, 0.3, 0.1, 0.1, 0.0, TAU, 12),
      [0.42, 0.22, 0.42, 0.38, 0.5, 0.42, 0.56, 0.34, 0.56, 0.18],
      arc(0.34, 0.32, 0.32, 0.32, 0.2, TAU - 0.2, 24),
    ],
  },
  '[': { adv: 0.3, strokes: [[0.24, -0.05, 0.1, -0.05, 0.1, CAP, 0.24, CAP]] },
  ']': { adv: 0.3, strokes: [[0.06, -0.05, 0.2, -0.05, 0.2, CAP, 0.06, CAP]] },
  '{': {
    adv: 0.34,
    strokes: [[0.28, -0.05, 0.18, 0.02, 0.18, 0.28, 0.08, 0.32, 0.18, 0.36, 0.18, 0.62, 0.28, 0.69]],
  },
  '}': {
    adv: 0.34,
    strokes: [[0.06, -0.05, 0.16, 0.02, 0.16, 0.28, 0.26, 0.32, 0.16, 0.36, 0.16, 0.62, 0.06, 0.69]],
  },
  '<': { adv: 0.5, strokes: [[0.44, 0.56, 0.08, 0.35, 0.44, 0.14]] },
  '>': { adv: 0.5, strokes: [[0.08, 0.56, 0.44, 0.35, 0.08, 0.14]] },
  '\\': { adv: 0.42, strokes: [[0.02, CAP, 0.4, 0.0]] },
  '|': { adv: 0.2, strokes: [[0.1, -0.05, 0.1, CAP]] },
  '^': { adv: 0.5, strokes: [[0.1, 0.52, 0.25, CAP, 0.4, 0.52]] },
  '~': { adv: 0.56, strokes: [[0.08, 0.38, 0.18, 0.46, 0.32, 0.42, 0.46, 0.34, 0.52, 0.42]] },
  '`': { adv: 0.2, strokes: [[0.06, CAP, 0.16, 0.56]] },
};

/** Build a Polyline (open) from a flat [x,y,...] number list. */
function strokeToPolyline(flat: number[]): Polyline {
  const pl = new Polyline();
  for (let i = 0; i + 1 < flat.length; i += 2) pl.add(pt(flat[i], flat[i + 1]));
  return pl;
}

/**
 * Parse the embedded simplex table into a `code -> Glyph` map, keyed by the
 * character's UTF-16 code unit (matching the EM-unit Glyph model). Strokes with
 * fewer than 2 points are dropped.
 */
export function parseHersheyGlyphs(): Map<number, Glyph> {
  const map = new Map<number, Glyph>();
  for (const ch of Object.keys(HERSHEY_SIMPLEX)) {
    const raw = HERSHEY_SIMPLEX[ch];
    const strokes: Polyline[] = [];
    for (const s of raw.strokes) {
      const pl = strokeToPolyline(s);
      if (pl.size() >= 2) strokes.push(pl);
    }
    map.set(ch.charCodeAt(0), { advance: raw.adv, strokes });
  }
  return map;
}

export type { Point };
