// Double-sided (front + back) 3D-carving program builder — UI-independent pure TS.
//
// NO React / DOM / three / zustand imports (mirrors the Qt `cadcam` lib split and
// the rest of core/). Given a COMPLETE, safe single-side G-code program (the
// front side, exactly as the carve worker emits it), this rebuilds it as a
// two-sided program:
//
//   (=== SIDE 1 / FRONT ===)        … the front program verbatim (no footer end)
//   (=== SIDE 1 / FRONT complete ===)
//   (=== FLIP STOCK about X, re-zero tool at <corner> ===)   … operator block
//   (=== SIDE 2 / BACK ===)         … the front geometry transformed for the flip
//   … program footer (M5 / M30) once at the very end.
//
// THE TRANSFORM FOR THE BACK SIDE (the load-bearing math)
// -------------------------------------------------------
// The operator flips the physical stock about the chosen axis and RE-ZEROES the
// tool against a reference corner, so the back side is machined in its own work
// coordinate system whose top face (new Z=0) is the old stock BOTTOM.
//
//   • XY MIRROR — flipping about X turns the stock over the X axis, so a point's
//     Y mirrors about the footprint centre line (X is preserved):
//         y' = (yMin + yMax) - y
//     flipping about Y mirrors X instead:
//         x' = (xMin + xMax) - x
//     Mirroring about the footprint centre keeps the back toolpath inside the
//     SAME XY envelope as the front — which is exactly what a corner re-zero of a
//     symmetric flip produces, and keeps the preview/operator sane.
//
//   • Z INVERSION — a CUTTING Z `zf` (≤ 0, measured down from the front top) is a
//     physical point at distance `thickness + zf` above the stock bottom. After
//     the flip the bottom is the new top (new Z = 0), so that same point sits at
//         z' = -(thickness + zf)
//     i.e. the depth is referenced to the NEW (flipped) top face using the stock
//     thickness. A front cut grazing the top (zf=0) becomes the deepest back cut
//     (z'=-thickness); a front through-cut (zf=-thickness) becomes z'=0 at the new
//     top. RETRACTS (any Z > 0 — the safe-Z plane) are LEFT UNTOUCHED: the same
//     positive safe-Z still clears the re-zeroed new top, so safe-Z retracts stay
//     correct and never get inverted into the stock (a crash).
//
// Everything is text-level + modal (G90/G91 tracked) so it composes with the
// emitter output and `core/transform.ts` exactly.

/** Which axis the operator flips the stock about. */
export type FlipAxis = 'x' | 'y';

/**
 * The reference corner the operator re-zeroes the tool against after flipping.
 * Named by bed quadrant (front = −Y / near the operator, back = +Y / far).
 */
export type FlipCorner = 'front-left' | 'front-right' | 'back-left' | 'back-right';

export interface TwoSidedParams {
  /** Master enable — when false the builder is a no-op (returns the front as-is). */
  enabled: boolean;
  /** Stock thickness (mm) — the Z-inversion reference for the back side. */
  stockThicknessMm: number;
  /** Flip the stock about X or about Y. */
  flipAxis: FlipAxis;
  /** The corner the operator re-zeros against after the flip. */
  flipCorner: FlipCorner;
}

export function defaultTwoSidedParams(
  overrides: Partial<TwoSidedParams> = {},
): TwoSidedParams {
  return {
    enabled: false,
    stockThicknessMm: 12,
    flipAxis: 'x',
    flipCorner: 'front-left',
    ...overrides,
  };
}

/** Human label for a flip corner (used in the operator instruction comment). */
export function flipCornerLabel(c: FlipCorner): string {
  switch (c) {
    case 'front-left':
      return 'front-left';
    case 'front-right':
      return 'front-right';
    case 'back-left':
      return 'back-left';
    case 'back-right':
      return 'back-right';
  }
}

// ---- tiny modal G-code text helpers (kept local; mirror core/transform.ts) ----

interface Word {
  letter: string;
  value: number;
  raw: string;
  start: number;
  end: number;
}

const WORD_RE = /([A-Za-z])\s*([-+]?(?:\d*\.\d+|\d+\.?\d*))/g;

/** Strip `;` and `( ... )` comments, returning the code-only portion of a line. */
function codePortion(line: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ';' && depth === 0) break;
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += c;
  }
  return out;
}

function tokenize(code: string): Word[] {
  const words: Word[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(code)) !== null) {
    const value = parseFloat(m[2]);
    if (!Number.isFinite(value)) continue;
    words.push({
      letter: m[1].toUpperCase(),
      value,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return words;
}

/** Format a coordinate: ≤4 decimals, trailing zeros trimmed, never `-0`. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(4);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

interface XYBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** XY bbox of every XY-bearing move in a program (modal G90/G91 tracked). */
export function programXYBounds(gcode: string): XYBounds | null {
  if (typeof gcode !== 'string' || gcode.trim() === '') return null;
  let x = 0;
  let y = 0;
  let absolute = true;
  let any = false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rawLine of gcode.split(/\r?\n/)) {
    const code = codePortion(rawLine);
    if (code.trim() === '') continue;
    const words = tokenize(code);
    if (words.length === 0) continue;
    let nx: number | undefined;
    let ny: number | undefined;
    for (const w of words) {
      if (w.letter === 'G') {
        if (w.value === 90) absolute = true;
        else if (w.value === 91) absolute = false;
      } else if (w.letter === 'X') nx = w.value;
      else if (w.letter === 'Y') ny = w.value;
    }
    const tx = nx === undefined ? x : absolute ? nx : x + nx;
    const ty = ny === undefined ? y : absolute ? ny : y + ny;
    if (nx !== undefined || ny !== undefined) {
      if (tx < minX) minX = tx;
      if (ty < minY) minY = ty;
      if (tx > maxX) maxX = tx;
      if (ty > maxY) maxY = ty;
      any = true;
    }
    x = tx;
    y = ty;
  }
  if (!any || !Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Rewrite a single-side program into the BACK-side program: mirror XY about the
 * footprint centre and invert CUTTING Z about the stock bottom; leave retracts
 * (Z > 0) and all feed/spindle words untouched. Modal G90/G91 aware.
 *
 * Z tolerance: only Z values at-or-below `Z_CUT_TOL` (the stock top) are treated
 * as cutting moves and inverted; anything above is a retract and passes through.
 */
function mirrorBackSide(
  gcode: string,
  bounds: XYBounds,
  axis: FlipAxis,
  thickness: number,
): string {
  const Z_CUT_TOL = 1e-6; // Z ≤ this is a cut (invert); Z above is a retract (keep)
  const sumX = bounds.minX + bounds.maxX; // mirror line: x' = sumX - x
  const sumY = bounds.minY + bounds.maxY; // mirror line: y' = sumY - y
  const th = Math.max(0, thickness);

  let absolute = true;
  const out: string[] = [];

  for (const rawLine of gcode.split(/\r?\n/)) {
    const code = codePortion(rawLine);
    if (code.trim() === '') {
      out.push(rawLine);
      continue;
    }
    const words = tokenize(code);
    if (words.length === 0) {
      out.push(rawLine);
      continue;
    }
    for (const w of words) {
      if (w.letter === 'G') {
        if (w.value === 90) absolute = true;
        else if (w.value === 91) absolute = false;
      }
    }

    const xW = words.find((w) => w.letter === 'X');
    const yW = words.find((w) => w.letter === 'Y');
    const zW = words.find((w) => w.letter === 'Z');
    const iW = words.find((w) => w.letter === 'I');
    const jW = words.find((w) => w.letter === 'J');

    const repl: { w: Word; value: number }[] = [];

    if (absolute) {
      // X mirrors when flipping about Y; Y mirrors when flipping about X.
      if (axis === 'y' && xW !== undefined) repl.push({ w: xW, value: sumX - xW.value });
      if (axis === 'x' && yW !== undefined) repl.push({ w: yW, value: sumY - yW.value });
    } else {
      // Relative moves: a mirror negates the delta along the mirrored axis.
      if (axis === 'y' && xW !== undefined) repl.push({ w: xW, value: -xW.value });
      if (axis === 'x' && yW !== undefined) repl.push({ w: yW, value: -yW.value });
    }

    // Arc centre offsets (I/J) are VECTORS — mirroring negates the mirrored
    // component in BOTH abs/rel arc modes. (A mirror also swaps arc handedness;
    // the carve emitter is all-G1, so no G2/G3 occur here, but handle I/J anyway.)
    if (axis === 'y' && iW !== undefined) repl.push({ w: iW, value: -iW.value });
    if (axis === 'x' && jW !== undefined) repl.push({ w: jW, value: -jW.value });

    if (zW !== undefined) {
      if (absolute) {
        // Invert only cutting Z (at/below the top); leave the safe-Z retract plane.
        if (zW.value <= Z_CUT_TOL) repl.push({ w: zW, value: -(th + zW.value) });
      } else {
        // Relative Z delta: a cut deltas negate under the bottom-referenced flip;
        // (carve output is absolute, so this is a defensive branch).
        repl.push({ w: zW, value: -zW.value });
      }
    }

    if (repl.length > 0) {
      repl.sort((a, b) => a.w.start - b.w.start);
      let res = '';
      let cursor = 0;
      for (const r of repl) {
        res += rawLine.slice(cursor, r.w.start);
        res += r.w.letter + fmt(r.value);
        cursor = r.w.end;
      }
      res += rawLine.slice(cursor);
      out.push(res);
    } else {
      out.push(rawLine);
    }
  }

  return out.join('\n');
}

/**
 * Split a complete emitter program into [header, body, footer] line arrays so the
 * front + back bodies can be wrapped by ONE shared header (units/plane/spindle)
 * and ONE shared footer (final safe-Z retract / M5 / M30). The header is the
 * leading setup block (program comment, G21/G90/G94/G17, the first safe-Z lift,
 * spindle M3); the footer is the trailing safe-Z retract + M5 + M30.
 */
function splitProgram(gcode: string): { header: string[]; body: string[]; footer: string[] } {
  const raw = gcode.split(/\r?\n/);
  const isHeader = (l: string): boolean => {
    const s = l.trim();
    if (s === '') return true;
    if (/^\(/.test(s)) return true; // a leading comment line
    if (/^G21$|^G20$|^G90$|^G91$|^G94$|^G17$/.test(s)) return true;
    if (/^M3\b/i.test(s) || /^M4\b/i.test(s)) return true;
    if (/^G0\s+Z/i.test(s)) return true; // the initial safe-Z lift
    return false;
  };
  const isFooter = (l: string): boolean => {
    const s = l.trim();
    if (s === '') return true;
    if (/^M30\b/i.test(s) || /^M5\b/i.test(s)) return true;
    if (/^G0\s+Z/i.test(s)) return true; // the final safe-Z retract
    return false;
  };
  let start = 0;
  while (start < raw.length && isHeader(raw[start])) start++;
  let end = raw.length;
  while (end > start && isFooter(raw[end - 1])) end--;
  return {
    header: raw.slice(0, start),
    body: raw.slice(start, end).filter((l) => l.trim().length > 0),
    footer: raw.slice(end),
  };
}

/**
 * The retract feed words from the program footer (so the rebuilt footer keeps the
 * SAME safe-Z value the emitter chose). Falls back to a conservative literal.
 */
function findSafeRetract(footer: string[]): string {
  for (const l of footer) {
    if (/^\s*G0\s+Z/i.test(l)) return l.trim();
  }
  return 'G0 Z5';
}

export interface TwoSidedResult {
  gcode: string;
  warnings: string[];
}

/**
 * Build the combined DOUBLE-SIDED program from a complete single-side (front)
 * program. Pure — safe to call from the panel (or anywhere). When two-sided is
 * disabled, or the front program has no XY geometry, the front program is
 * returned unchanged.
 *
 * Safety is preserved end-to-end: the shared header re-asserts G21/G90 and a
 * guaranteed safe-Z lift, each side begins with a safe-Z retract before any XY
 * travel, the back side keeps its retract plane positive (un-inverted) and only
 * inverts cutting Z, and the program ends with one safe-Z retract + M5 + M30.
 */
export function buildTwoSidedProgram(
  frontGcode: string,
  params: TwoSidedParams,
): TwoSidedResult {
  const warnings: string[] = [];
  if (!params.enabled) return { gcode: frontGcode, warnings };
  if (typeof frontGcode !== 'string' || frontGcode.trim() === '') {
    return { gcode: frontGcode, warnings };
  }

  const bounds = programXYBounds(frontGcode);
  if (!bounds) {
    // No XY geometry to mirror — nothing meaningful to flip; return the front.
    warnings.push('Two-sided: front program has no XY moves — back side skipped.');
    return { gcode: frontGcode, warnings };
  }

  const th = Math.max(0, params.stockThicknessMm);
  if (!(th > 0)) {
    warnings.push('Two-sided: stock thickness must be > 0 — back side skipped.');
    return { gcode: frontGcode, warnings };
  }

  const { header, body, footer } = splitProgram(frontGcode);
  if (body.length === 0) {
    warnings.push('Two-sided: no cutting body found in the front program.');
    return { gcode: frontGcode, warnings };
  }

  const safeRetract = findSafeRetract(footer);
  const backBody = mirrorBackSide(body.join('\n'), bounds, params.flipAxis, th).split('\n');
  const axisLabel = params.flipAxis === 'x' ? 'X' : 'Y';
  const cornerLabel = flipCornerLabel(params.flipCorner);

  const lines: string[] = [];
  // Shared header (units/plane/spindle + first safe-Z), reused verbatim.
  for (const l of header) lines.push(l);
  lines.push('(=== SIDE 1 / FRONT ===)');
  for (const l of body) lines.push(l);
  // Side-1 boundary: lift to safe-Z, stop the spindle, and tell the operator how
  // to flip + re-zero before side 2. The block is COMMENTS + a guaranteed retract
  // and an M5/M0 pause so the machine parks safely while the stock is flipped.
  lines.push(safeRetract);
  lines.push('M5');
  lines.push('(=== SIDE 1 / FRONT complete ===)');
  lines.push(`(=== FLIP STOCK about ${axisLabel}, re-zero tool at ${cornerLabel} ===)`);
  lines.push(`(Stock thickness ${fmt(th)}mm — back-side depths referenced to the new top face)`);
  lines.push('M0 (pause: flip the stock and re-zero, then resume)');
  lines.push('(=== SIDE 2 / BACK ===)');
  // Re-assert the spindle for side 2 (M5 stopped it at the boundary), then cut.
  for (const l of header) {
    const s = l.trim();
    if (/^M3\b/i.test(s) || /^M4\b/i.test(s)) lines.push(l);
  }
  lines.push(safeRetract); // guaranteed safe-Z before any back-side XY travel
  for (const l of backBody) lines.push(l);
  // Shared footer once at the very end.
  for (const l of footer) lines.push(l);

  let gcode = lines.join('\n');
  if (!gcode.endsWith('\n')) gcode += '\n';
  return { gcode, warnings };
}
