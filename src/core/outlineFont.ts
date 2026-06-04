// Outline (TrueType/OpenType) vector font + text layout.
// UI-independent — part of the shared cadcam core. Pure TS, no DOM/React.
//
// Where StrokeFont follows glyph *centerlines* (single-stroke), OutlineFont
// follows glyph *contours*: it parses a .ttf/.otf via opentype.js, asks it for
// the glyph outline path, and flattens the cubic/quadratic Béziers into closed
// Polylines (mm). The result feeds the SAME pen-mode emitter as StrokeFont, so
// the machine engraves around the glyph shapes.
//
// Layout mirrors StrokeFont.layout(): block origin is the top-left (y=0), text
// grows downward (+y up from each baseline), cap height maps to charHeightMm.

import { Point, Polyline, pt } from './geometry';
import { TextAlign, type LayoutOptions } from './strokeFont';
import opentype, { type Font as OtFont, type PathCommand } from 'opentype.js';

// Chord tolerance (in font-em fraction) for flattening Béziers. Curves are
// flattened in normalized em space (cap height ~1) then scaled to mm, so this
// is resolution-independent of the requested char height.
const BEZIER_TOL = 0.01;
// Max subdivision steps per Bézier segment (guards pathological control nets).
const MAX_BEZIER_STEPS = 48;

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function quadAt(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

// Steps for a Bézier sized by its control-polygon length vs. tolerance.
function bezierSteps(ctrlLen: number, tol: number): number {
  if (!(tol > 0)) return 8;
  return Math.max(2, Math.min(MAX_BEZIER_STEPS, Math.ceil(ctrlLen / tol)));
}

function polyLen(...ps: Point[]): number {
  let len = 0;
  for (let i = 1; i < ps.length; i++) {
    len += Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y);
  }
  return len;
}

/**
 * An outline (TTF/OTF) vector font. Glyph contours are produced on demand from
 * opentype.js and flattened to closed Polylines. Coordinates are normalized so
 * that one unit ≈ cap height, matching StrokeFont's EM convention; layout()
 * scales them to a requested cap height in mm.
 */
export class OutlineFont {
  private m_name: string;
  private readonly m_font: OtFont;
  private readonly m_unitsPerEm: number;
  // Normalization: font units -> "cap height" units. We approximate cap height
  // by the font ascender so a requested charHeightMm maps to a sensible visual
  // size that's comparable to the stroke font.
  private readonly m_capUnits: number;

  private constructor(font: OtFont, name: string) {
    this.m_font = font;
    this.m_name = name;
    this.m_unitsPerEm = font.unitsPerEm || 1000;
    // Prefer the OS/2 cap height; fall back to ascender, then 0.7 em.
    const os2 = (font.tables as Record<string, unknown> | undefined)?.os2 as
      | { sCapHeight?: number }
      | undefined;
    const cap =
      os2 && typeof os2.sCapHeight === 'number' && os2.sCapHeight > 0
        ? os2.sCapHeight
        : (font.ascender || 0) > 0
          ? font.ascender * 0.7
          : this.m_unitsPerEm * 0.7;
    this.m_capUnits = cap > 0 ? cap : this.m_unitsPerEm * 0.7;
  }

  name(): string {
    return this.m_name;
  }
  /** Always "outline" — used by the panel to pick a sensible default mode. */
  kind(): 'outline' {
    return 'outline';
  }
  /** Number of glyphs in the font (for diagnostics). */
  glyphCount(): number {
    return this.m_font.glyphs?.length ?? 0;
  }

  hasGlyph(ch: string): boolean {
    if (ch.length === 0) return false;
    const g = this.m_font.charToGlyph(ch);
    // opentype returns the .notdef glyph (index 0) for unknown chars.
    return !!g && g.index !== 0;
  }

  /**
   * Characters in `text` with no glyph in this font (each distinct, non-newline
   * char once). Spaces are skipped (they advance but draw nothing).
   */
  missingGlyphs(text: string): string[] {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const ch of text) {
      if (ch === '\n' || ch === ' ' || seen.has(ch)) continue;
      seen.add(ch);
      if (!this.hasGlyph(ch)) missing.push(ch);
    }
    return missing;
  }

  /**
   * Lay out multi-line text into closed outline polylines (mm). Mirrors
   * StrokeFont.layout(): block top is y=0, text grows downward, cap height maps
   * to charHeightMm. opentype y is up already, matching our +y-up convention.
   */
  layout(text: string, opts: LayoutOptions): Polyline[] {
    const out: Polyline[] = [];
    const charHeightMm = opts.charHeightMm;
    if (charHeightMm <= 0 || text.length === 0) return out;

    const lineSpacingFactor =
      opts.lineSpacingFactor && opts.lineSpacingFactor > 0 ? opts.lineSpacingFactor : 1.0;
    const letterSpacingMm = opts.letterSpacingMm ?? 0;
    const align = opts.align ?? TextAlign.Left;

    // font-units -> mm so cap height maps to charHeightMm.
    const scale = charHeightMm / this.m_capUnits;
    const lineDy = charHeightMm * lineSpacingFactor;
    // Flatten tolerance in font units (BEZIER_TOL is a fraction of cap height).
    const tolUnits = BEZIER_TOL * this.m_capUnits;

    const lines = text.split('\n');

    for (let li = 0; li < lines.length; ++li) {
      const line = lines[li];

      // Measure advance width (mm) for alignment.
      let widthMm = 0;
      const glyphs = this.m_font.stringToGlyphs(line);
      for (let ci = 0; ci < glyphs.length; ++ci) {
        const adv = glyphs[ci].advanceWidth ?? 0;
        widthMm += adv * scale;
        if (ci + 1 < glyphs.length) widthMm += letterSpacingMm;
      }

      let xStart = 0;
      if (align === TextAlign.Center) xStart = -widthMm / 2;
      else if (align === TextAlign.Right) xStart = -widthMm;

      const baseline = -charHeightMm - li * lineDy;

      let penUnits = 0; // x cursor in font units, relative to line start
      for (let ci = 0; ci < glyphs.length; ++ci) {
        const g = glyphs[ci];
        const path = g.getPath(0, 0, this.m_unitsPerEm, undefined, this.m_font);
        // Convert this glyph's path commands into closed contour polylines.
        const contours = commandsToContours(path.commands, tolUnits);
        for (const c of contours) {
          if (c.size() < 3) continue;
          const pl = new Polyline();
          pl.closed = true;
          // opentype path y is already up; place at pen X + baseline.
          for (const p of c.points) {
            pl.add(pt(xStart + penUnits * scale + p.x * scale, baseline + p.y * scale));
          }
          out.push(pl);
        }
        penUnits += g.advanceWidth ?? 0;
        if (ci + 1 < glyphs.length) penUnits += letterSpacingMm / scale;
      }
    }

    return out;
  }

  /** Parse a .ttf/.otf ArrayBuffer into an OutlineFont. Throws on failure. */
  static fromArrayBuffer(buf: ArrayBuffer, fallbackName = 'Outline'): OutlineFont {
    let font: OtFont;
    try {
      font = opentype.parse(buf);
    } catch (e) {
      throw new Error(`Font parse error: ${(e as Error).message}`);
    }
    if (!font || !font.glyphs) throw new Error('Not a valid TrueType/OpenType font.');
    const name = readFontName(font) || fallbackName;
    return new OutlineFont(font, name);
  }
}

/** Pull a human name from the opentype font's name table, with fallbacks. */
function readFontName(font: OtFont): string {
  const names = font.names as
    | { fullName?: Record<string, string>; fontFamily?: Record<string, string> }
    | undefined;
  const pick = (rec?: Record<string, string>): string | undefined => {
    if (!rec) return undefined;
    return rec.en ?? Object.values(rec)[0];
  };
  return pick(names?.fullName) ?? pick(names?.fontFamily) ?? '';
}

/**
 * Convert opentype path commands (M/L/C/Q/Z) into closed contour polylines,
 * flattening Béziers to line segments at `tolUnits` chord tolerance. Each M
 * starts a new contour; Z (or the next M) closes the current one.
 */
function commandsToContours(commands: PathCommand[], tolUnits: number): Polyline[] {
  const contours: Polyline[] = [];
  let cur: Polyline | null = null;
  let last: Point = { x: 0, y: 0 };

  const finish = (): void => {
    if (cur && cur.size() >= 3) {
      // Drop a trailing point coincident with the start (closed implies it).
      const pts = cur.points;
      if (pts.length > 1) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) pts.pop();
      }
      if (cur.size() >= 3) contours.push(cur);
    }
    cur = null;
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M': {
        finish();
        cur = new Polyline();
        cur.closed = true;
        last = { x: cmd.x, y: cmd.y };
        cur.add(last);
        break;
      }
      case 'L': {
        if (!cur) {
          cur = new Polyline();
          cur.closed = true;
          cur.add(last);
        }
        last = { x: cmd.x, y: cmd.y };
        cur.add(last);
        break;
      }
      case 'Q': {
        if (!cur) {
          cur = new Polyline();
          cur.closed = true;
          cur.add(last);
        }
        const p0 = last;
        const p1 = { x: cmd.x1, y: cmd.y1 };
        const p2 = { x: cmd.x, y: cmd.y };
        const steps = bezierSteps(polyLen(p0, p1, p2), tolUnits);
        for (let i = 1; i <= steps; i++) cur.add(quadAt(p0, p1, p2, i / steps));
        last = p2;
        break;
      }
      case 'C': {
        if (!cur) {
          cur = new Polyline();
          cur.closed = true;
          cur.add(last);
        }
        const p0 = last;
        const p1 = { x: cmd.x1, y: cmd.y1 };
        const p2 = { x: cmd.x2, y: cmd.y2 };
        const p3 = { x: cmd.x, y: cmd.y };
        const steps = bezierSteps(polyLen(p0, p1, p2, p3), tolUnits);
        for (let i = 1; i <= steps; i++) cur.add(cubicAt(p0, p1, p2, p3, i / steps));
        last = p3;
        break;
      }
      case 'Z': {
        finish();
        break;
      }
    }
  }
  finish();
  return contours;
}
