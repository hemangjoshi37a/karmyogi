// Single-stroke (Hershey "simplex"-style) vector font + text layout.
// UI-independent — part of the shared cadcam core. Pure TS, no DOM/React.
// Ported from the Qt/C++ reference cadcam/strokefont.{h,cpp}.
//
// Coordinates are stored in dimensionless EM units (baseline y=0, +y up,
// x in [0, advance]; cap height ~0.7 EM). layout() scales them to a requested
// character height in millimetres and produces pen polylines ready to plot.

import { Point, Polyline, pt } from './geometry';
import { CAP_HEIGHT, Glyph, parseHersheyGlyphs } from './hersheyData';

export type { Glyph } from './hersheyData';

/** Text alignment for layout(). Mirrors the Qt align int (0/1/2). */
export enum TextAlign {
  Left = 0,
  Center = 1,
  Right = 2,
}

/** Options for laying out a string into pen strokes. */
export interface LayoutOptions {
  /** Cap height maps to this height, in mm. */
  charHeightMm: number;
  /** Baseline-to-baseline distance = charHeightMm * this. Default 1.5. */
  lineSpacingFactor?: number;
  /** Extra gap (mm) added after each glyph's advance. Default 0. */
  letterSpacingMm?: number;
  /** Horizontal alignment. Default Left. */
  align?: TextAlign;
}

// Advance (EM units) used for a character that has no glyph, so unknown
// characters render as blank space rather than collapsing the layout.
const MISSING_ADVANCE = 0.45;

/**
 * A built-in (or JSON-loaded) single-stroke vector font. Coordinates are stored
 * in EM units; layout() scales them to a requested character height in mm.
 */
export class StrokeFont {
  private m_name = 'Built-in';
  private m_capHeight = CAP_HEIGHT;
  private m_glyphs = new Map<number, Glyph>(); // keyed by UTF-16 code unit

  name(): string {
    return this.m_name;
  }
  capHeight(): number {
    return this.m_capHeight;
  }
  /** Number of glyphs in the font (for diagnostics). */
  glyphCount(): number {
    return this.m_glyphs.size;
  }

  hasGlyph(ch: string): boolean {
    return ch.length > 0 && this.m_glyphs.has(ch.charCodeAt(0));
  }

  /** The glyph for `ch`, or undefined if absent. */
  glyph(ch: string): Glyph | undefined {
    return ch.length > 0 ? this.m_glyphs.get(ch.charCodeAt(0)) : undefined;
  }

  /** The embedded public-domain simplex-style font. */
  static builtin(): StrokeFont {
    const f = new StrokeFont();
    f.m_name = 'Built-in';
    f.m_capHeight = CAP_HEIGHT;
    f.m_glyphs = parseHersheyGlyphs();
    return f;
  }

  /**
   * Lay out multi-line text into pen polylines, scaled so the cap height maps
   * to charHeightMm. '\n' starts a new line. Origin is the top-left: the block
   * top is y=0 and text grows downward (each glyph drawn +y up from its
   * baseline). Returns open stroke polylines in mm.
   */
  layout(text: string, opts: LayoutOptions): Polyline[] {
    const out: Polyline[] = [];
    const charHeightMm = opts.charHeightMm;
    if (charHeightMm <= 0 || text.length === 0) return out;

    const lineSpacingFactor = opts.lineSpacingFactor && opts.lineSpacingFactor > 0 ? opts.lineSpacingFactor : 1.0;
    const letterSpacingMm = opts.letterSpacingMm ?? 0;
    const align = opts.align ?? TextAlign.Left;

    // EM->mm scale so that cap height maps to charHeightMm.
    const scale = this.m_capHeight > 0 ? charHeightMm / this.m_capHeight : charHeightMm;
    const lineDy = charHeightMm * lineSpacingFactor;

    const lines = text.split('\n');

    for (let li = 0; li < lines.length; ++li) {
      const line = lines[li];

      // Measure advance width (mm) for alignment.
      let widthMm = 0;
      for (let ci = 0; ci < line.length; ++ci) {
        const gl = this.glyph(line[ci]);
        const adv = gl ? gl.advance : MISSING_ADVANCE;
        widthMm += adv * scale;
        if (ci + 1 < line.length) widthMm += letterSpacingMm;
      }

      let xStart = 0;
      if (align === TextAlign.Center) xStart = -widthMm / 2;
      else if (align === TextAlign.Right) xStart = -widthMm;

      // Baseline of this line, measured from the block origin (y=0 top).
      const baseline = -charHeightMm - li * lineDy;

      let penX = xStart;
      for (let ci = 0; ci < line.length; ++ci) {
        const gl = this.glyph(line[ci]);
        if (gl) {
          for (const src of gl.strokes) {
            const pl = new Polyline();
            pl.closed = src.closed;
            for (const p of src.points) pl.add(pt(penX + p.x * scale, baseline + p.y * scale));
            if (pl.size() >= 2) out.push(pl);
          }
          penX += gl.advance * scale;
        } else {
          penX += MISSING_ADVANCE * scale; // unknown glyph -> blank space
        }
        if (ci + 1 < line.length) penX += letterSpacingMm;
      }
    }

    return out;
  }

  /**
   * Characters in `text` that have no glyph in this font (each distinct
   * missing, non-newline character once). Used to surface glyph-miss warnings.
   */
  missingGlyphs(text: string): string[] {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const ch of text) {
      if (ch === '\n' || seen.has(ch)) continue;
      seen.add(ch);
      if (!this.hasGlyph(ch)) missing.push(ch);
    }
    return missing;
  }

  /**
   * Replace this font's glyphs from a parsed custom-font JSON object. Format
   * (matches the Qt handwriting pipeline output and StrokeFont::loadJson):
   *
   *   { "name":"My Hand", "capHeight":0.7,
   *     "glyphs": { "A": { "advance":0.65,
   *                        "strokes": [ [[x0,y0],[x1,y1],...], ... ] }, ... } }
   *
   * Coordinates in EM units (baseline y=0, +y up). Throws Error on a malformed
   * document. On success the font is replaced in place.
   */
  loadJsonObject(root: unknown): void {
    if (typeof root !== 'object' || root === null) throw new Error('Root is not a JSON object.');
    const obj = root as Record<string, unknown>;

    const glyphsRaw = obj.glyphs;
    if (typeof glyphsRaw !== 'object' || glyphsRaw === null) throw new Error('No "glyphs" object found.');

    const name = typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : 'Custom';
    const capHeight = typeof obj.capHeight === 'number' ? obj.capHeight : 0.7;
    if (!(capHeight > 0)) throw new Error('Invalid capHeight.');

    const parsed = new Map<number, Glyph>();
    for (const [key, value] of Object.entries(glyphsRaw as Record<string, unknown>)) {
      if (key.length === 0) continue;
      const code = key.charCodeAt(0);

      const go = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      const advance = typeof go.advance === 'number' ? go.advance : 0.6;

      const strokesRaw = Array.isArray(go.strokes) ? go.strokes : [];
      const strokes: Polyline[] = [];
      for (const sv of strokesRaw) {
        if (!Array.isArray(sv)) continue;
        const pl = new Polyline();
        for (const pv of sv) {
          if (Array.isArray(pv) && pv.length >= 2 && typeof pv[0] === 'number' && typeof pv[1] === 'number') {
            pl.add(pt(pv[0], pv[1]));
          }
        }
        if (pl.size() >= 2) strokes.push(pl);
      }
      parsed.set(code, { advance, strokes });
    }

    if (parsed.size === 0) throw new Error('No valid glyphs parsed.');

    this.m_name = name;
    this.m_capHeight = capHeight;
    this.m_glyphs = parsed;
  }

  /**
   * Parse a custom-font JSON string and return a new StrokeFont. Throws on
   * malformed JSON or a malformed font document.
   */
  static fromJson(jsonText: string): StrokeFont {
    let root: unknown;
    try {
      root = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`JSON parse error: ${(e as Error).message}`);
    }
    const f = new StrokeFont();
    f.loadJsonObject(root);
    return f;
  }
}

export type { Point, Polyline };
