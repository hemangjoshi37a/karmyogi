// Minimal DXF (ASCII) importer for the CAD/CAM core — UI-independent.
// Ported from the Qt/C++ reference cadcam/dxfimporter.{h,cpp}.
//
// Reads a subset of the ASCII DXF format sufficient for 2.5D carving/engraving:
//   LINE, CIRCLE, ARC, LWPOLYLINE (with bulges), POLYLINE/VERTEX/SEQEND.
// TEXT/MTEXT/SPLINE/ELLIPSE are reported as warnings and skipped. The importer
// is tolerant of unknown groups.

import { Point, Polyline, appendBulgeArc, distance, kEpsilon } from './geometry';
import { Drawing, Entity } from './entity';

interface Pair {
  code: number;
  value: string;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export interface DxfImportResult {
  ok: boolean;
  drawing: Drawing;
  warnings: string[];
  error?: string;
}

/**
 * Parse ASCII DXF content into a Drawing. Mirrors the Qt DxfImporter.importString
 * behaviour, including resync-on-misaligned-pair tolerance.
 */
export function importDxfString(content: string): DxfImportResult {
  const warnings: string[] = [];
  const drawing = new Drawing();

  // ---- Tokenise into (code, value) pairs ----------------------------------
  const pairs: Pair[] = [];
  const lines = content.split('\n');
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    const code = parseInt(codeStr, 10);
    if (!Number.isFinite(code) || codeStr === '' || !/^[+-]?\d+$/.test(codeStr)) {
      // Misaligned pair — try to resync by advancing one line.
      i -= 1;
      continue;
    }
    let value = lines[i + 1];
    // Strip a trailing CR (Windows line endings) but preserve inner text.
    if (value.endsWith('\r')) value = value.slice(0, -1);
    pairs.push({ code, value: value.trim() });
  }

  if (pairs.length === 0) {
    return { ok: false, drawing, warnings, error: 'Empty or unparseable DXF content' };
  }

  // ---- Walk entities ------------------------------------------------------
  let sawSection = false;
  let inEntities = false;
  let i = 0;
  const n = pairs.length;

  const consumeToNextEntity = (from: number): number => {
    let j = from;
    while (j < n && pairs[j].code !== 0) ++j;
    return j;
  };

  const num = (s: string): number => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  };
  const int = (s: string): number => {
    const v = parseInt(s, 10);
    return Number.isFinite(v) ? v : 0;
  };

  while (i < n) {
    const p = pairs[i];
    if (p.code !== 0) {
      ++i;
      continue;
    }

    const kw = p.value.toUpperCase();

    if (kw === 'SECTION') {
      sawSection = true;
      // The following code-2 pair names the section.
      let j = i + 1;
      let name = '';
      while (j < n && pairs[j].code !== 0) {
        if (pairs[j].code === 2) name = pairs[j].value.toUpperCase();
        ++j;
      }
      inEntities = name === 'ENTITIES';
      i = j;
      continue;
    }
    if (kw === 'ENDSEC') {
      inEntities = false;
      i = consumeToNextEntity(i + 1);
      continue;
    }
    if (kw === 'EOF') break;

    const active = inEntities || !sawSection;
    if (!active) {
      i = consumeToNextEntity(i + 1);
      continue;
    }

    // ---- Entity dispatch --------------------------------------------------
    if (kw === 'LINE') {
      let x1 = 0,
        y1 = 0,
        x2 = 0,
        y2 = 0,
        layer = '';
      let j = i + 1;
      for (; j < n && pairs[j].code !== 0; ++j) {
        switch (pairs[j].code) {
          case 10: x1 = num(pairs[j].value); break;
          case 20: y1 = num(pairs[j].value); break;
          case 11: x2 = num(pairs[j].value); break;
          case 21: y2 = num(pairs[j].value); break;
          case 8: layer = pairs[j].value; break;
        }
      }
      drawing.add(Entity.makeLine({ x: x1, y: y1 }, { x: x2, y: y2 }, layer));
      i = j;
    } else if (kw === 'CIRCLE') {
      let cx = 0,
        cy = 0,
        r = 0,
        layer = '';
      let j = i + 1;
      for (; j < n && pairs[j].code !== 0; ++j) {
        switch (pairs[j].code) {
          case 10: cx = num(pairs[j].value); break;
          case 20: cy = num(pairs[j].value); break;
          case 40: r = num(pairs[j].value); break;
          case 8: layer = pairs[j].value; break;
        }
      }
      if (r > 0) drawing.add(Entity.makeCircle({ x: cx, y: cy }, r, layer));
      i = j;
    } else if (kw === 'ARC') {
      let cx = 0,
        cy = 0,
        r = 0,
        a0 = 0,
        a1 = 0,
        layer = '';
      let j = i + 1;
      for (; j < n && pairs[j].code !== 0; ++j) {
        switch (pairs[j].code) {
          case 10: cx = num(pairs[j].value); break;
          case 20: cy = num(pairs[j].value); break;
          case 40: r = num(pairs[j].value); break;
          case 50: a0 = num(pairs[j].value); break;
          case 51: a1 = num(pairs[j].value); break;
          case 8: layer = pairs[j].value; break;
        }
      }
      // DXF arcs are CCW.
      if (r > 0) drawing.add(Entity.makeArc({ x: cx, y: cy }, r, toRad(a0), toRad(a1), true, layer));
      i = j;
    } else if (kw === 'LWPOLYLINE') {
      let layer = '';
      let closed = false;
      const verts: Point[] = [];
      const bulges: number[] = [];
      let curBulge = 0;
      let haveVertex = false;
      let vx = 0,
        vy = 0;
      let j = i + 1;
      const flushVertex = () => {
        if (haveVertex) {
          verts.push({ x: vx, y: vy });
          bulges.push(curBulge);
          curBulge = 0;
          haveVertex = false;
        }
      };
      for (; j < n && pairs[j].code !== 0; ++j) {
        switch (pairs[j].code) {
          case 70: closed = (int(pairs[j].value) & 0x1) !== 0; break;
          case 8: layer = pairs[j].value; break;
          case 10: flushVertex(); vx = num(pairs[j].value); haveVertex = true; break;
          case 20: vy = num(pairs[j].value); break;
          case 42: curBulge = num(pairs[j].value); break;
        }
      }
      flushVertex();
      addPolyline(drawing, verts, bulges, closed, layer);
      i = j;
    } else if (kw === 'POLYLINE') {
      // Old-style polyline: header, then VERTEX blocks, then SEQEND.
      let layer = '';
      let closed = false;
      let j = i + 1;
      for (; j < n && pairs[j].code !== 0; ++j) {
        switch (pairs[j].code) {
          case 70: closed = (int(pairs[j].value) & 0x1) !== 0; break;
          case 8: layer = pairs[j].value; break;
        }
      }
      const verts: Point[] = [];
      const bulges: number[] = [];
      while (j < n && pairs[j].code === 0 && pairs[j].value.toUpperCase() === 'VERTEX') {
        let vx = 0,
          vy = 0,
          b = 0;
        let k = j + 1;
        for (; k < n && pairs[k].code !== 0; ++k) {
          switch (pairs[k].code) {
            case 10: vx = num(pairs[k].value); break;
            case 20: vy = num(pairs[k].value); break;
            case 42: b = num(pairs[k].value); break;
          }
        }
        verts.push({ x: vx, y: vy });
        bulges.push(b);
        j = k;
      }
      // Consume the SEQEND block if present.
      if (j < n && pairs[j].code === 0 && pairs[j].value.toUpperCase() === 'SEQEND')
        j = consumeToNextEntity(j + 1);

      addPolyline(drawing, verts, bulges, closed, layer);
      i = j;
    } else if (kw === 'TEXT' || kw === 'MTEXT' || kw === 'SPLINE' || kw === 'ELLIPSE') {
      warnings.push(`Skipped unsupported entity: ${kw}`);
      i = consumeToNextEntity(i + 1);
    } else {
      // Unknown entity/keyword — skip its group.
      i = consumeToNextEntity(i + 1);
    }
  }

  return { ok: true, drawing, warnings };
}

function addPolyline(
  drawing: Drawing,
  verts: Point[],
  bulges: number[],
  closed: boolean,
  layer: string
): void {
  if (verts.length < 2) return;
  const pl = new Polyline();
  pl.add(verts[0]);
  for (let k = 1; k < verts.length; ++k) appendBulgeArc(pl, verts[k - 1], verts[k], bulges[k - 1]);
  if (closed) {
    appendBulgeArc(pl, verts[verts.length - 1], verts[0], bulges[bulges.length - 1]);
    if (pl.points.length > 1 && distance(pl.points[0], pl.points[pl.points.length - 1]) <= kEpsilon)
      pl.points.pop();
    pl.closed = true;
  }
  drawing.add(Entity.makePolyline(pl, layer));
}
