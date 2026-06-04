// Pen-text styling transforms — UI-independent, pure TS (no DOM/React).
//
// These post-process the laid-out Polyline[] from StrokeFont/OutlineFont so the
// Writing panel can offer simple, font-agnostic styling that the machine can
// actually draw:
//
//   italic    — horizontal shear (slant) of every vertex about the baseline.
//   bold      — extra parallel passes offset around each stroke so the pen
//               re-traces slightly displaced copies, thickening the line.
//   underline — an extra straight stroke under each text line, spanning its
//               horizontal extent at a small offset below the baseline.
//
// They take and return Polyline[] in mm, so they slot in between layout() and
// the G-code emitter without touching the safe pen-Z handling.

import { BBox, Point, Polyline, pt } from './geometry';

/** Standard "oblique" slant: ~12° → tan ≈ 0.213. */
const ITALIC_SHEAR = 0.213;

export interface StyleOptions {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Cap height (mm) — drives bold offset + underline placement/thickness. */
  charHeightMm: number;
}

/**
 * Apply the enabled styles, in order: italic shear, then bold thickening, then
 * underline. Input polylines are mm with the layout convention (block top y=0,
 * text grows downward; each line's baseline is below its glyphs). `lineDy` is
 * the baseline-to-baseline spacing in mm, used to locate underline rows.
 */
export function applyTextStyle(
  strokes: Polyline[],
  opts: StyleOptions,
  lineDy: number,
): Polyline[] {
  let out = strokes;
  if (opts.italic) out = out.map(shearPolyline);
  if (opts.bold) out = thicken(out, opts.charHeightMm);
  if (opts.underline) out = out.concat(underlineStrokes(strokes, opts.charHeightMm, lineDy));
  return out;
}

/** Horizontal shear about y=0 (block top). Slant grows with height like real italics. */
function shearPolyline(pl: Polyline): Polyline {
  const r = pl.clone();
  for (const p of r.points) p.x += p.y * ITALIC_SHEAR;
  return r;
}

/**
 * Thicken strokes by emitting the original plus offset copies. Rather than a
 * true polygon offset (overkill for a pen), we draw each stroke at small ±X/±Y
 * displacements so successive passes lay down adjacent ink and fatten the line.
 * Offset scales with char height so bold looks consistent at any size.
 */
function thicken(strokes: Polyline[], charHeightMm: number): Polyline[] {
  const d = Math.max(0.12, charHeightMm * 0.04);
  const offsets: Point[] = [
    { x: 0, y: 0 },
    { x: d, y: 0 },
    { x: -d, y: 0 },
    { x: 0, y: d },
    { x: 0, y: -d },
  ];
  const out: Polyline[] = [];
  for (const pl of strokes) {
    for (const o of offsets) {
      if (o.x === 0 && o.y === 0) {
        out.push(pl);
        continue;
      }
      const c = pl.clone();
      for (const p of c.points) {
        p.x += o.x;
        p.y += o.y;
      }
      out.push(c);
    }
  }
  return out;
}

/**
 * One underline stroke per text line. We bucket all vertices into lines by Y
 * (using lineDy), then for each occupied line draw a horizontal segment a touch
 * below the glyphs spanning [minX, maxX]. A small vertical thickness is added
 * as a second parallel pass so the underline reads at any pen width.
 */
function underlineStrokes(strokes: Polyline[], charHeightMm: number, lineDy: number): Polyline[] {
  if (strokes.length === 0) return [];

  // Overall extent to find how many line rows exist.
  const all = new BBox();
  for (const pl of strokes) for (const p of pl.points) all.expand(p);
  if (!all.isValid()) return [];

  const dy = lineDy > 0 ? lineDy : charHeightMm * 1.5;
  // Baseline of the first line in the layout convention is at y=-charHeightMm.
  // Group strokes by nearest line index using their topmost point.
  const lines = new Map<number, BBox>();
  for (const pl of strokes) {
    const b = pl.bounds();
    if (!b.isValid()) continue;
    // Use the glyph top (max y) to assign a line; round to a line index.
    const idx = Math.round((-b.max.y - charHeightMm) / dy);
    const cur = lines.get(idx) ?? new BBox();
    cur.expand(b);
    lines.set(idx, cur);
  }

  const out: Polyline[] = [];
  const drop = Math.max(0.4, charHeightMm * 0.12); // gap below baseline
  const thick = Math.max(0.12, charHeightMm * 0.05);
  for (const [idx, b] of lines) {
    if (!b.isValid()) continue;
    const baseline = -charHeightMm - idx * dy;
    const y = baseline - drop;
    const x0 = b.min.x;
    const x1 = b.max.x;
    if (!(x1 > x0)) continue;
    const a = new Polyline();
    a.add(pt(x0, y));
    a.add(pt(x1, y));
    out.push(a);
    const c = new Polyline();
    c.add(pt(x1, y - thick));
    c.add(pt(x0, y - thick));
    out.push(c);
  }
  return out;
}
