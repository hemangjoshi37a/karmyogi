// Extract soldering-point coordinates from parsed Gerber geometry — UI-independent.
// Pure TypeScript: no React/DOM/three.js imports.
//
// The auto-soldering tab places solder at a list of (x, y) points. A Gerber
// layer that carries the solder PADS (typically the paste layer or top copper)
// represents each pad as a FLASH — recorded by the existing Gerber parser as a
// closed `pad` polygon (circle or rectangle outline) in `GerberData.pads`. The
// centre of each pad polygon is the point where solder should be placed.
//
// We reuse that parsed geometry (never re-parse) and turn every pad's bounding
// box centre into one candidate soldering point, deduping coincident pads (the
// same hole can be flashed on several layers / multiple times) and rounding to a
// sensible precision. Coordinates are in millimetres, in the Gerber's own
// coordinate space — the operator zeros the machine to the board origin so this
// space lines up with the work coordinate system.

import { importGerber, type GerberData } from './gerber';
import { importExcellon, type ExcellonData } from './excellon';
import type { PackageEntry } from './gerberPackage';

/** A bare soldering-point coordinate (mm) in the Gerber coordinate space. */
export interface SolderPointXY {
  x: number;
  y: number;
}

/**
 * What KIND of layer (for SOLDERING purposes) a package file is. This is a
 * soldering-specific view that differs from the PCB pipeline's {@link LayerRole}
 * (which marks paste/mask/silk as `Ignore`): for auto-soldering the solder-PASTE
 * layer is the IDEAL source of pads, so it must be a first-class, preferred
 * candidate rather than an ignored ancillary layer.
 *
 *  - 'paste'        → solder-paste / cream / stencil layer (SMD pad apertures) — best.
 *  - 'copper-top'   → top copper (pads + traces) — good fallback.
 *  - 'copper-bottom'→ bottom copper.
 *  - 'drill'        → Excellon drill file (hole centres = through-hole pads).
 *  - 'other'        → recognised but not a useful solder-point source (silk, mask,
 *                     outline, netlist, readme, …). Still listed, never preferred.
 */
export type SolderLayerKind =
  | 'paste'
  | 'copper-top'
  | 'copper-bottom'
  | 'drill'
  | 'other';

/** A package file classified + scored as a candidate solder-point source. */
export interface SolderLayerCandidate {
  entry: PackageEntry;
  kind: SolderLayerKind;
  /** True for an Excellon drill file (parsed differently from Gerber). */
  isDrill: boolean;
}

/**
 * Classify a layer file (by BOTH extension AND filename keywords) for the
 * soldering use case. Works across naming conventions: extension-based exports
 * (`.GTP`/`.GTL`/`.DRL`) AND keyword-only exports where every file is `.GBR` and
 * the role lives in the filename text ("Top SMT Paste", "Top Copper", …).
 */
export function classifySolderLayer(filename: string): SolderLayerKind {
  const f = filename.toLowerCase().trim();

  // --- Drill (Excellon) — distinctive extensions + PTH/NPTH keywords. ---
  if (/\.(drl|xln|drd|exc|nc|tap|txt)$/i.test(f) && /(drill|excellon|pth|npth)/i.test(f))
    return 'drill';
  if (/\.(drl|xln|drd|exc)$/i.test(f)) return 'drill';
  if (/(drillmap|\bdrill\b|-pth|-npth|_pth|_npth|\bpth\b|\bnpth\b)/i.test(f)) return 'drill';

  // --- Solder PASTE / cream / stencil — the BEST solder source. Check before
  //     copper and before the generic mask keyword (a "paste mask" is paste). ---
  if (/\.(gtp|gbp|crc|crs|spt|spb)$/i.test(f)) return 'paste';
  if (/(paste|stencil|\bcream\b|smt[._ -]?paste|smd[._ -]?paste)/i.test(f)) return 'paste';

  // --- Ancillary layers that carry geometry but are NOT solder pads: solder
  //     mask / resist, silkscreen, outline/mechanical, docs, netlist. Matched
  //     BEFORE copper so a "Top Solder Resist.GBR" isn't mistaken for copper. ---
  if (/\.(gts|gbs|sts|smt|smb|gto|gbo|plc|pls|sst|ssb|gko|gm1|gml|oln|ipc)$/i.test(f))
    return 'other';
  if (
    /(soldermask|solder[._ -]?mask|solder[._ -]?resist|\bresist\b|\bmask\b|silk|silkscreen|\boverlay\b|legend|assembly|\bassy\b|fabrication|\bfab\b|outline|mechanical|\bmech\b|profile|edge[._ -]?cut|dimension|netlist|read[._ -]?me|\bipc\b)/i.test(
      f,
    )
  )
    return 'other';

  // --- Top copper. ---
  if (/\.(gtl|cmp|art)$/i.test(f)) return 'copper-top';
  if (/(top[._ -]?copper|copper[._ -]?top|top[._ -]?layer|toplayer|-f[._ -]?cu|f_cu|f\.cu|\btop\b|\bfront\b)/i.test(f))
    return 'copper-top';

  // --- Bottom copper. ---
  if (/\.(gbl|sol)$/i.test(f)) return 'copper-bottom';
  if (/(bottom[._ -]?copper|copper[._ -]?bottom|bottom[._ -]?layer|bottomlayer|-b[._ -]?cu|b_cu|b\.cu|\bbot\b|\bbottom\b|\bback\b)/i.test(f))
    return 'copper-bottom';

  // --- Generic copper Gerber that named "copper" without a side. ---
  if (/\.(gbr|ger)$/i.test(f) && /copper/i.test(f)) return 'copper-top';

  return 'other';
}

/** True when the classified kind is an Excellon drill file. */
export function isDrillKind(kind: SolderLayerKind): boolean {
  return kind === 'drill';
}

/**
 * Classify every extracted package entry for soldering and order them BEST
 * first: paste → top copper → drill → bottom copper → other. The picker
 * highlights `candidates[0]` (the best solder-point source) by default.
 */
export function classifySolderCandidates(entries: PackageEntry[]): SolderLayerCandidate[] {
  const rank: Record<SolderLayerKind, number> = {
    paste: 0,
    'copper-top': 1,
    drill: 2,
    'copper-bottom': 3,
    other: 4,
  };
  const cands = entries.map((entry) => {
    const kind = classifySolderLayer(entry.name);
    return { entry, kind, isDrill: kind === 'drill' };
  });
  cands.sort((a, b) => rank[a.kind] - rank[b.kind] || a.entry.name.localeCompare(b.entry.name));
  return cands;
}

/** Round to `decimals` places, normalising -0 to 0 so dedupe keys are stable. */
function round(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * Convert the flashed PADS of a parsed Gerber layer into soldering-point
 * coordinates. Each pad polygon's bounding-box centre becomes one point.
 *
 * Coincident pads (within `tol` mm, after rounding) are deduped to a single
 * point so a hole flashed on multiple layers / repeatedly doesn't produce a
 * stack of identical points. Output order follows the first occurrence of each
 * unique location in the file.
 *
 * @param gerber parsed layer (uses `gerber.pads`, the D03 flash polygons)
 * @param decimals rounding precision for the emitted coordinates (default 3)
 */
export function padsToSolderPoints(gerber: GerberData, decimals = 3): SolderPointXY[] {
  const out: SolderPointXY[] = [];
  const seen = new Set<string>();
  for (const pad of gerber.pads) {
    const b = pad.bounds();
    if (!b.isValid()) continue;
    const c = b.center();
    const x = round(c.x, decimals);
    const y = round(c.y, decimals);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y });
  }
  return out;
}

/**
 * Convert the drilled holes of a parsed Excellon file into soldering-point
 * coordinates. Each hole centre becomes one point (through-hole pads are
 * soldered at the hole). Coincident holes are deduped exactly like pads.
 */
export function drillsToSolderPoints(excellon: ExcellonData, decimals = 3): SolderPointXY[] {
  const out: SolderPointXY[] = [];
  const seen = new Set<string>();
  for (const hit of excellon.hits) {
    const x = round(hit.pos.x, decimals);
    const y = round(hit.pos.y, decimals);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y });
  }
  return out;
}

/** Outcome of turning one chosen layer's text into solder-point coordinates. */
export interface SolderExtractResult {
  ok: boolean;
  points: SolderPointXY[];
  /** A short reason when `ok` is false (e.g. parse error / no pads). */
  error?: string;
}

/**
 * Turn ONE chosen layer (Gerber pad layer OR Excellon drill file) into
 * soldering-point coordinates, parsing the text with the correct importer for
 * its kind. Gerber layers use pad FLASH centres (falling back to filled-region
 * centres when a layer has no D03 flashes, e.g. region-only paste exports);
 * drill files use hole centres.
 */
export function extractSolderPoints(
  text: string,
  kind: SolderLayerKind,
  decimals = 3,
): SolderExtractResult {
  if (kind === 'drill') {
    const res = importExcellon(text);
    if (!res.ok) return { ok: false, points: [], error: res.error ?? 'no drill hits' };
    const points = drillsToSolderPoints(res.data, decimals);
    if (points.length === 0) return { ok: false, points: [], error: 'no drill hits' };
    return { ok: true, points };
  }
  const res = importGerber(text);
  if (!res.ok) return { ok: false, points: [], error: res.error ?? 'no geometry' };
  let points = padsToSolderPoints(res.data, decimals);
  // Some exporters render pads as filled REGIONS (G36/G37) rather than D03
  // flashes — fall back to region centres so those layers still yield points.
  if (points.length === 0 && res.data.regions.length > 0) {
    points = regionsToSolderPoints(res.data, decimals);
  }
  if (points.length === 0) return { ok: false, points: [], error: 'no pads' };
  return { ok: true, points };
}

/** Region (G36/G37) centres → solder points. Used as a flash-less fallback. */
function regionsToSolderPoints(gerber: GerberData, decimals = 3): SolderPointXY[] {
  const out: SolderPointXY[] = [];
  const seen = new Set<string>();
  for (const region of gerber.regions) {
    const b = region.bounds();
    if (!b.isValid()) continue;
    const c = b.center();
    const x = round(c.x, decimals);
    const y = round(c.y, decimals);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y });
  }
  return out;
}
