// Minimal Gerber RS-274X (ASCII) importer for the PCB CAM core — UI-independent.
// Ported from the Qt/C++ reference cadcam/gerberimporter.{h,cpp}.
// Pure TypeScript: no React/DOM/three.js imports.
//
// Reads a useful subset of RS-274X:
//   %FSLAX..Y..*%  format spec (leading/trailing zero omission, integer/decimal digits)
//   %MOMM*% / %MOIN*%  units
//   %ADDnnC,diam*%  circular aperture, %ADDnnR,xXy*% rectangular aperture
//   Dnn  aperture select; G01/G02/G03 interpolation; D01 draw / D02 move / D03 flash
//   G36/G37 region (contour) mode; G75/G74 (quadrant); M02 end
// Unsupported features (obround/polygon/macro apertures, step&repeat, LP/LM/LR
// transforms) are noted via warnings() and skipped.

import { BBox, Point, Polyline, distance, makeCircle, makeRect } from './geometry';

/** A centreline trace polyline plus its aperture width (mm). */
export interface GerberTrace {
  centreline: Polyline;
  width: number;
}

/**
 * Parsed copper geometry from a Gerber file. The model is deliberately simple
 * (v1): every D01 draw becomes a centreline `trace` polyline tagged with the
 * active aperture width; every D03 flash becomes a closed `pad` polygon
 * (circle or rectangle outline at the flash location); G36/G37 regions become
 * closed `region` polygons. Curved (G02/G03) interpolation between draws is
 * flattened to line segments.
 */
export class GerberData {
  /** (centreline polyline, aperture width in mm). */
  traces: GerberTrace[] = [];
  /** Flashed pads as closed polygons (mm). */
  pads: Polyline[] = [];
  /** Filled regions (G36/G37) as closed polygons (mm). */
  regions: Polyline[] = [];

  isEmpty(): boolean {
    return this.traces.length === 0 && this.pads.length === 0 && this.regions.length === 0;
  }

  /** Bounding box over all geometry (mm). Pad/trace widths are NOT inflated in. */
  bounds(): BBox {
    const b = new BBox();
    for (const t of this.traces) b.expand(t.centreline.bounds());
    for (const p of this.pads) b.expand(p.bounds());
    for (const r of this.regions) b.expand(r.bounds());
    return b;
  }
}

/** Result of a Gerber import attempt. */
export interface GerberImportResult {
  ok: boolean;
  data: GerberData;
  error?: string;
  warnings: string[];
}

// One configured aperture.
enum ApShape {
  Circle,
  Rect,
  Other,
}
interface Aperture {
  shape: ApShape;
  a: number; // circle diameter, or rect X size (mm)
  b: number; // rect Y size (mm)
}

// Coordinate format from %FS...X<int><dec>Y<int><dec>*%.
interface CoordFormat {
  xInt: number;
  xDec: number;
  yInt: number;
  yDec: number;
  leadingZeroOmitted: boolean; // LA = leading zeros omitted (most common)
}

function toMm(v: number, metric: boolean): number {
  return metric ? v : v * 25.4;
}

const RE_ADD = /^ADD(\d+)([A-Za-z]+)(?:,(.*))?$/;
const RE_FS = /^FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/;
const RE_TOK = /([GDXYIJ])([+-]?\d+)/g;

/**
 * Parse Gerber RS-274X text. Always returns a result object; `ok` is false (with
 * `error`) when no geometry could be parsed. Unsupported features accumulate in
 * `warnings` rather than failing.
 */
export function importGerber(content: string): GerberImportResult {
  const warnings: string[] = [];
  const out = new GerberData();

  let metric = true; // %MOMM*% default assumption (warn if unset)
  let unitsSeen = false;
  const fmt: CoordFormat = { xInt: 2, xDec: 4, yInt: 2, yDec: 4, leadingZeroOmitted: true };
  let fmtSeen = false;

  const apertures = new Map<number, Aperture>();
  let currentAperture = -1;

  // Gerber coordinates are stored as raw integers scaled by the format spec.
  let curX = 0.0;
  let curY = 0.0; // current point (mm)
  let interp = 1; // 1=linear, 2=CW arc, 3=CCW arc
  let regionMode = false;
  let regionPath = new Polyline(); // accumulates contour in G36 mode

  // Active trace being drawn (between consecutive D01s with the same aperture).
  let activeTrace = new Polyline();

  // Decode a coordinate token (e.g. "1500") into mm using the format spec.
  const decode = (digits: string, intDigits: number, decDigits: number): number => {
    let s = digits;
    let neg = false;
    if (s.startsWith('-')) {
      neg = true;
      s = s.slice(1);
    } else if (s.startsWith('+')) {
      s = s.slice(1);
    }
    if (s.length === 0) return 0.0;
    const total = intDigits + decDigits;
    if (fmt.leadingZeroOmitted) {
      // value implicitly right-aligned: pad on the left to `total` digits
      while (s.length < total) s = '0' + s;
    } else {
      // trailing zeros omitted: pad on the right
      while (s.length < total) s = s + '0';
    }
    // If still longer than expected, keep the rightmost `total` digits.
    if (s.length > total) s = s.slice(s.length - total);
    const raw = Number(s);
    let val = raw / Math.pow(10, decDigits);
    if (neg) val = -val;
    return toMm(val, metric);
  };

  // Build a pad polygon for a flash of `ap` at (x,y).
  const flashPad = (ap: Aperture, x: number, y: number): void => {
    if (ap.shape === ApShape.Circle && ap.a > 0.0) {
      out.pads.push(makeCircle({ x, y }, ap.a / 2.0));
    } else if (ap.shape === ApShape.Rect && ap.a > 0.0 && ap.b > 0.0) {
      out.pads.push(makeRect({ x: x - ap.a / 2.0, y: y - ap.b / 2.0 }, ap.a, ap.b));
    } else {
      // Unknown/unsupported aperture: approximate with a tiny dot so the
      // location is still represented.
      const d = ap.a > 0.0 ? ap.a : 0.2;
      out.pads.push(makeCircle({ x, y }, d / 2.0));
    }
  };

  const flushTrace = (): void => {
    if (activeTrace.size() >= 2) {
      let w = 0.0;
      const ap = apertures.get(currentAperture);
      if (ap) {
        if (ap.shape === ApShape.Circle) w = ap.a;
        else w = Math.max(ap.a, ap.b);
      }
      out.traces.push({ centreline: activeTrace, width: w });
    }
    activeTrace = new Polyline();
  };

  const handleParam = (p: string): void => {
    // Multiple parameters may be packed in one %...% block separated by '*'.
    const parts = p.split('*').filter((x) => x.length > 0);
    for (const raw of parts) {
      const s = raw.trim();
      if (s.length === 0) continue;
      if (s.startsWith('MO')) {
        const u = s.slice(2);
        metric = u.toUpperCase() === 'MM';
        unitsSeen = true;
      } else if (s.startsWith('FS')) {
        const m = RE_FS.exec(s);
        if (m) {
          fmt.leadingZeroOmitted = m[1] === 'L';
          fmt.xInt = parseInt(m[3], 10);
          fmt.xDec = parseInt(m[4], 10);
          fmt.yInt = parseInt(m[5], 10);
          fmt.yDec = parseInt(m[6], 10);
          fmtSeen = true;
        } else {
          warnings.push(`Unrecognised format spec: ${s}`);
        }
      } else if (s.startsWith('ADD')) {
        const m = RE_ADD.exec(s);
        if (m) {
          const code = parseInt(m[1], 10);
          const shape = m[2];
          const args = m[3] ?? '';
          const av = args.split('X').filter((x) => x.length > 0);
          const ap: Aperture = { shape: ApShape.Circle, a: 0, b: 0 };
          if (shape === 'C') {
            ap.shape = ApShape.Circle;
            if (av.length >= 1) ap.a = toMm(parseFloat(av[0]), metric);
          } else if (shape === 'R' || shape === 'O') {
            ap.shape = ApShape.Rect; // obround approximated as rect
            if (av.length >= 1) ap.a = toMm(parseFloat(av[0]), metric);
            if (av.length >= 2) ap.b = toMm(parseFloat(av[1]), metric);
            else ap.b = ap.a;
            if (shape === 'O')
              warnings.push(`Obround aperture D${code} approximated as rectangle`);
          } else {
            ap.shape = ApShape.Other;
            if (av.length >= 1) ap.a = toMm(parseFloat(av[0]), metric);
            warnings.push(`Unsupported aperture shape '${shape}' (D${code}) approximated`);
          }
          apertures.set(code, ap);
        }
      } else if (s.startsWith('AM')) {
        warnings.push('Aperture macro (AM) not supported; skipped');
      } else if (s.startsWith('SR')) {
        warnings.push('Step & repeat (SR) not supported; skipped');
      } else if (
        s.startsWith('LP') ||
        s.startsWith('LM') ||
        s.startsWith('LR') ||
        s.startsWith('LS')
      ) {
        warnings.push(`Layer transform '${s.slice(0, 2)}' ignored`);
      }
      // IN, IP, AS, OF, MI, SF (deprecated) silently ignored.
    }
  };

  // Process one ordinary data block (already stripped of trailing '*').
  const handleBlock = (blk: string): void => {
    const b = blk.trim();
    if (b.length === 0) return;

    // Pull out G, D, X, Y, I, J codes. A block may carry several.
    // Examples: G01X1500Y2000D01 ; D10 ; G36 ; X100Y100D03
    let hasX = false;
    let hasY = false;
    let hasI = false;
    let hasJ = false;
    let nx = curX;
    let ny = curY;
    let ci = 0.0;
    let cj = 0.0;
    let dCode = -1;
    const gCodes: number[] = [];

    RE_TOK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_TOK.exec(b)) !== null) {
      const c = m[1];
      const digits = m[2];
      switch (c) {
        case 'G':
          gCodes.push(parseInt(digits, 10));
          break;
        case 'D':
          dCode = parseInt(digits, 10);
          break;
        case 'X':
          nx = decode(digits, fmt.xInt, fmt.xDec);
          hasX = true;
          break;
        case 'Y':
          ny = decode(digits, fmt.yInt, fmt.yDec);
          hasY = true;
          break;
        case 'I':
          ci = decode(digits, fmt.xInt, fmt.xDec);
          hasI = true;
          break;
        case 'J':
          cj = decode(digits, fmt.yInt, fmt.yDec);
          hasJ = true;
          break;
      }
    }

    // Apply G modal codes first.
    for (const g of gCodes) {
      switch (g) {
        case 1:
          interp = 1;
          break;
        case 2:
          interp = 2;
          break;
        case 3:
          interp = 3;
          break;
        case 36:
          regionMode = true;
          regionPath = new Polyline();
          break;
        case 37:
          regionMode = false;
          if (regionPath.size() >= 3) {
            regionPath.closed = true;
            out.regions.push(regionPath);
          }
          regionPath = new Polyline();
          break;
        case 74:
        case 75:
          break; // quadrant mode — we flatten arcs anyway
        case 54:
          break; // deprecated tool prepare (Dnn follows)
        default:
          break;
      }
    }

    // A bare "Dnn" (>=10) with no operation selects the aperture.
    if (dCode >= 10 && !hasX && !hasY) {
      if (currentAperture !== dCode) flushTrace();
      currentAperture = dCode;
      return;
    }

    const emitSegment = (tx: number, ty: number): void => {
      if (interp === 1 || !(hasI || hasJ)) {
        // linear
        if (regionMode) {
          if (regionPath.isEmpty()) regionPath.add({ x: curX, y: curY });
          regionPath.add({ x: tx, y: ty });
        } else {
          if (activeTrace.isEmpty()) activeTrace.add({ x: curX, y: curY });
          activeTrace.add({ x: tx, y: ty });
        }
      } else {
        // circular: centre = current + (I,J)
        const center: Point = { x: curX + ci, y: curY + cj };
        const r = distance({ x: curX, y: curY }, center);
        const a0 = Math.atan2(curY - center.y, curX - center.x);
        const a1 = Math.atan2(ty - center.y, tx - center.x);
        const ccw = interp === 3;
        const dst = regionMode ? regionPath : activeTrace;
        if (dst.isEmpty()) dst.add({ x: curX, y: curY });
        dst.addArc(center, r, a0, a1, ccw);
      }
    };

    if (dCode === 1) {
      // D01 draw
      emitSegment(nx, ny);
      curX = nx;
      curY = ny;
    } else if (dCode === 2) {
      // D02 move (pen up)
      if (!regionMode) {
        flushTrace();
      } else if (regionPath.size() >= 3) {
        regionPath.closed = true;
        out.regions.push(regionPath);
        regionPath = new Polyline();
      } else {
        regionPath = new Polyline();
      }
      curX = nx;
      curY = ny;
    } else if (dCode === 3) {
      // D03 flash
      const ap = apertures.get(currentAperture);
      if (ap) flashPad(ap, nx, ny);
      curX = nx;
      curY = ny;
    } else if (hasX || hasY) {
      // Coordinates with no explicit D-code: continue current modal op.
      // Most files always include D01/D02; treat bare coords as a move.
      curX = nx;
      curY = ny;
    }
  };

  // ---- Main scan --------------------------------------------------------
  const data = content;
  const n = data.length;
  let i = 0;
  while (i < n) {
    const c = data[i];
    if (c === '%') {
      const end = data.indexOf('%', i + 1);
      if (end < 0) {
        warnings.push('Unterminated %-block');
        break;
      }
      handleParam(data.slice(i + 1, end));
      i = end + 1;
    } else if (c === '*') {
      i++; // empty block
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let end = data.indexOf('*', i);
      if (end < 0) end = n;
      handleBlock(data.slice(i, end));
      i = end + 1;
    }
  }

  flushTrace();
  if (regionMode && regionPath.size() >= 3) {
    regionPath.closed = true;
    out.regions.push(regionPath);
  }

  if (!fmtSeen)
    warnings.push(
      `No %FS format spec found; assumed X${fmt.xInt}.${fmt.xDec} leading-zero-omitted`
    );
  if (!unitsSeen) warnings.push('No %MO units found; assumed millimetres');

  if (out.isEmpty()) {
    return { ok: false, data: out, error: 'No copper geometry parsed from Gerber data', warnings };
  }
  return { ok: true, data: out, warnings };
}
