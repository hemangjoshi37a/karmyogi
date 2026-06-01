// Minimal Excellon drill-file importer for the PCB CAM core — UI-independent.
// Ported from the Qt/C++ reference cadcam/excellonimporter.{h,cpp}.
// Pure TypeScript: no React/DOM/three.js imports.
//
// Reads a useful subset of the Excellon drill format:
//   header tool defs   Tnn C<diam>      (e.g. T1C0.80)
//   units              METRIC / INCH  or  M71 / M72
//   format             optionally from METRIC,LZ/TZ ; defaults 2.4(in)/3.3(mm)
//   body               Tnn (select), Xnn Ynn (hit), M30/M00 (end)
// Coordinates may be decimal-pointed (used verbatim) or implied by the format.

import { BBox, Point } from './geometry';

/** A single drilled hole. */
export interface DrillHit {
  pos: Point;
  diameter: number; // mm
}

/** All hits parsed from an Excellon file. */
export class ExcellonData {
  hits: DrillHit[] = [];

  isEmpty(): boolean {
    return this.hits.length === 0;
  }

  /** Bounding box over hit centres (mm). */
  bounds(): BBox {
    const b = new BBox();
    for (const h of this.hits) b.expand(h.pos);
    return b;
  }

  /** Distinct tool diameters, ascending. */
  toolDiameters(): number[] {
    const d: number[] = [];
    for (const h of this.hits) if (!d.includes(h.diameter)) d.push(h.diameter);
    d.sort((a, b) => a - b);
    return d;
  }
}

/** Result of an Excellon import attempt. */
export interface ExcellonImportResult {
  ok: boolean;
  data: ExcellonData;
  error?: string;
  warnings: string[];
}

const RE_TOOL_DEF = /^T(\d+)(?:F[\d.]+)?(?:S[\d.]+)?C([\d.]+)/;
const RE_TOOL_SEL = /^T(\d+)$/;
const RE_X = /X([+-]?[\d.]+)/;
const RE_Y = /Y([+-]?[\d.]+)/;

/**
 * Parse Excellon drill text. Always returns a result object; `ok` is false (with
 * `error`) when no hits could be parsed.
 */
export function importExcellon(content: string): ExcellonImportResult {
  const warnings: string[] = [];
  const out = new ExcellonData();

  let metric = true; // default; refined by METRIC/INCH/M71/M72
  let unitsSeen = false;
  let inHeader = false;
  let leadingZeroOmitted = true; // LZ means leading zeros present; we track omission

  // Implied-decimal format (used only when a coordinate has no '.').
  let decDigits = 4; // 2.4 inch default; switched to 3.3 for metric

  const toolDia = new Map<number, number>(); // tool number -> diameter (mm)
  let currentTool = -1;

  let curX = 0.0;
  let curY = 0.0;

  const decodeCoord = (s: string): number => {
    if (s.length === 0) return 0.0;
    const neg = s.startsWith('-');
    let t = s;
    if (neg || t.startsWith('+')) t = t.slice(1);
    let v: number;
    if (t.includes('.')) {
      v = parseFloat(t);
    } else {
      // implied decimal: assume trailing/leading per leadingZeroOmitted
      const total = (metric ? 3 : 2) + decDigits;
      if (leadingZeroOmitted) {
        while (t.length < total) t = '0' + t;
      } else {
        while (t.length < total) t = t + '0';
      }
      v = Number(t) / Math.pow(10, decDigits);
    }
    if (neg) v = -v;
    return metric ? v : v * 25.4;
  };

  const lines = content.split(/[\r\n]+/).filter((x) => x.length > 0);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';')) continue;

    if (line === 'M48') {
      inHeader = true;
      continue;
    }
    if (line === '%' || line === 'M95') {
      inHeader = false;
      continue;
    }
    if (
      line.startsWith('M30') ||
      line.startsWith('M00') ||
      line.startsWith('M15') ||
      line.startsWith('M17') ||
      line.startsWith('G05') ||
      line.startsWith('G90')
    )
      continue;

    // Units / format directives (may appear in or out of header).
    if (line.startsWith('METRIC')) {
      metric = true;
      unitsSeen = true;
      decDigits = 3;
      if (line.includes('TZ')) leadingZeroOmitted = false;
      else if (line.includes('LZ')) leadingZeroOmitted = true;
      continue;
    }
    if (line.startsWith('INCH')) {
      metric = false;
      unitsSeen = true;
      decDigits = 4;
      if (line.includes('TZ')) leadingZeroOmitted = false;
      else if (line.includes('LZ')) leadingZeroOmitted = true;
      continue;
    }
    if (line === 'M71') {
      metric = true;
      unitsSeen = true;
      decDigits = 3;
      continue;
    }
    if (line === 'M72') {
      metric = false;
      unitsSeen = true;
      decDigits = 4;
      continue;
    }
    if (
      line.startsWith('FMAT') ||
      line.startsWith('VER') ||
      line.startsWith('ICI') ||
      line.startsWith('FILE')
    ) {
      continue;
    }

    // Tool definition: T<n>C<diam> (header), or selection T<n> (body).
    const mDef = RE_TOOL_DEF.exec(line);
    if (mDef && line.includes('C')) {
      const tn = parseInt(mDef[1], 10);
      const d = parseFloat(mDef[2]);
      toolDia.set(tn, metric ? d : d * 25.4);
      continue;
    }
    const mSel = RE_TOOL_SEL.exec(line);
    if (mSel) {
      currentTool = parseInt(mSel[1], 10);
      continue;
    }

    // Coordinate (drill hit) — only meaningful in body.
    if (line.includes('X') || line.includes('Y')) {
      const mx = RE_X.exec(line);
      const my = RE_Y.exec(line);
      if (mx) curX = decodeCoord(mx[1]);
      if (my) curY = decodeCoord(my[1]);
      if (!inHeader && currentTool >= 0) {
        out.hits.push({ pos: { x: curX, y: curY }, diameter: toolDia.get(currentTool) ?? 0.0 });
      }
      continue;
    }
  }

  if (!unitsSeen) warnings.push('No units directive; assumed millimetres');

  if (out.hits.length === 0) {
    return { ok: false, data: out, error: 'No drill hits parsed from Excellon data', warnings };
  }
  return { ok: true, data: out, warnings };
}
