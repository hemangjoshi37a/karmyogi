// Gerber/Excellon ZIP-package extraction + layer-role detection — UI-independent.
// Pure TypeScript: no React/DOM/three.js imports. Reusable from any caller.
//
// A standard PCB fabrication export (KiCad / EAGLE / Altium / Protel / generic
// CAM) bundles each copper / drill / outline / mask / silk layer as a separate
// file inside one ZIP. This module unzips the package, decodes each text file,
// and heuristically tags it with a `LayerRole` so the PCB panel can drive the
// Isolation / Drilling / Cutout stages from the right files. The detected role
// is only a guess — the UI lets the user reassign it.

import { unzipSync, strFromU8 } from 'fflate';

/**
 * Role a layer file plays in the PCB CAM pipeline.
 *  - CopperTop / CopperBottom → isolation routing (Gerber)
 *  - Drill                    → drilling (Excellon)
 *  - BoardOutline             → board cutout (Gerber)
 *  - Ignore                   → recognised but not used for CAM (mask/silk/paste/…)
 *  - Unknown                  → could not be classified; the user must assign
 */
export type LayerRole =
  | 'CopperTop'
  | 'CopperBottom'
  | 'Drill'
  | 'BoardOutline'
  | 'Ignore'
  | 'Unknown';

/** All roles the UI offers in its dropdown, with human labels. */
export const LAYER_ROLES: { role: LayerRole; label: string }[] = [
  { role: 'CopperTop', label: 'Copper Top' },
  { role: 'CopperBottom', label: 'Copper Bottom' },
  { role: 'Drill', label: 'Drill' },
  { role: 'BoardOutline', label: 'Board Outline' },
  { role: 'Ignore', label: 'Ignore' },
  { role: 'Unknown', label: 'Unknown' },
];

/** Human-readable label for a role. */
export function layerRoleLabel(role: LayerRole): string {
  return LAYER_ROLES.find((r) => r.role === role)?.label ?? role;
}

/** One file extracted from the package. */
export interface PackageEntry {
  /** Base file name (no directory component). */
  name: string;
  /** Decoded text content of the file (UTF-8). */
  text: string;
  /** Auto-detected role (the user may reassign in the UI). */
  role: LayerRole;
  /** Decompressed size in bytes. */
  size: number;
}

// File extensions / name fragments that mark a non-CAM ancillary layer. These
// are recognised so they can be listed and skipped rather than left Unknown.
const MASK_EXT = /\.(gts|gbs|sts|ssb|smt|smb)$/i;
const SILK_EXT = /\.(gto|gbo|plc|pls|sst|ssb)$/i;
const PASTE_EXT = /\.(gtp|gbp|crc|crs|spt|spb)$/i;

/**
 * Detect the most likely CAM role for a file from its name/extension. Matching
 * is case-insensitive and tolerant of KiCad, EAGLE, Altium and Protel naming.
 * Drill detection wins over copper/outline because Excellon `.txt`/`.tap` files
 * would otherwise be misread; copper wins over outline for ambiguous copper
 * names. Ancillary mask/silk/paste layers map to `Ignore`.
 */
export function detectLayerRole(filename: string): LayerRole {
  const f = filename.toLowerCase().trim();

  // --- Drill (Excellon) — check first; extensions are distinctive. ---
  if (/\.(drl|xln|drd|exc|nc|tap)$/i.test(f)) return 'Drill';
  if (/(drill|drillmap|-pth|-npth|_pth|_npth|\bpth\b|\bnpth\b)/i.test(f)) return 'Drill';
  // Excellon often ships as a generic .txt (e.g. KiCad "*.drl" but also .txt).
  if (/\.txt$/i.test(f) && /(drill|excellon)/i.test(f)) return 'Drill';

  // --- Board outline / edge cuts (check before copper to catch .gko/.gm1). ---
  if (/\.(gko|gm1|gml|gbr_outline|oln)$/i.test(f)) return 'BoardOutline';
  if (/(edge[._-]?cuts|edge_?cut|boardoutline|board[._-]?outline|outline|profile|\bedge\b|\bgko\b|dimension|mechanical|\bmech\b)/i.test(f))
    return 'BoardOutline';

  // --- Ancillary layers we recognise but do not use for CAM. ---
  if (MASK_EXT.test(f) || /(soldermask|solder[._-]?mask|solder[._-]?resist|\bresist\b|\bmask\b)/i.test(f)) return 'Ignore';
  if (SILK_EXT.test(f) || /(silk|silkscreen|\boverlay\b|legend)/i.test(f)) return 'Ignore';
  if (PASTE_EXT.test(f) || /(paste|stencil|\bcream\b)/i.test(f)) return 'Ignore';
  // Docs / fab / assembly / netlist / non-Gerber attachments — listed, not cut.
  if (/(assembly|\bassy\b|fabrication|\bfab\b|\bdrawing\b|drill[._-]?map|netlist|\bipc\b|read[._-]?me|\.(pdf|png|jpe?g|csv|xlsx?|md)$)/i.test(f))
    return 'Ignore';

  // --- Copper top. ---
  if (/\.(gtl|cmp|art)$/i.test(f)) return 'CopperTop';
  if (/(-f[._-]?cu|f_cu|f\.cu|toplayer|top[._-]?copper|top[._-]?layer|\btop\b|\bfront\b|copper[._-]?top)/i.test(f))
    return 'CopperTop';

  // --- Copper bottom. ---
  if (/\.(gbl|sol)$/i.test(f)) return 'CopperBottom';
  if (/(-b[._-]?cu|b_cu|b\.cu|bottomlayer|bottom[._-]?copper|bottom[._-]?layer|\bbot\b|\bbottom\b|\bback\b|copper[._-]?bottom)/i.test(f))
    return 'CopperBottom';

  // --- Generic copper Gerber that didn't say which side. ---
  if (/\.(gbr|ger)$/i.test(f) && /copper/i.test(f)) return 'CopperTop';

  return 'Unknown';
}

/** Thrown by {@link unzipGerberPackage} when the ZIP cannot be read at all. */
export class GerberPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GerberPackageError';
  }
}

// Files that are never PCB layers (OS junk, READMEs, metadata, images, archives).
function isJunk(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  if (base.startsWith('.') || base.startsWith('__MACOSX')) return true;
  if (/\.(ds_store|md|pdf|png|jpg|jpe?g|gif|bmp|svg|html?|json|xml|csv|zip|rar|7z|gz)$/i.test(base))
    return true;
  return false;
}

/**
 * Unzip a Gerber/Excellon package and return one {@link PackageEntry} per
 * extracted layer file, each tagged with an auto-detected {@link LayerRole}.
 * Directory entries, nested-path prefixes, OS junk (`__MACOSX`, `.DS_Store`)
 * and obvious non-layer files (PDF/PNG/README/…) are filtered out.
 *
 * @throws {GerberPackageError} when the bytes are not a valid ZIP or contain no
 *   usable layer files.
 */
export function unzipGerberPackage(bytes: Uint8Array): PackageEntry[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new GerberPackageError(
      `Could not read ZIP archive: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const entries: PackageEntry[] = [];
  for (const path of Object.keys(files)) {
    // Skip directory placeholders and junk.
    if (path.endsWith('/')) continue;
    if (isJunk(path)) continue;

    const data = files[path];
    if (!data || data.length === 0) continue;

    const name = path.split('/').pop() ?? path;
    let text: string;
    try {
      text = strFromU8(data);
    } catch {
      // Non-text (binary) file — not a Gerber/Excellon layer; skip.
      continue;
    }

    entries.push({
      name,
      text,
      role: detectLayerRole(name),
      size: data.length,
    });
  }

  if (entries.length === 0) {
    throw new GerberPackageError(
      'No layer files found in the ZIP. Export a standard Gerber/Excellon package and try again.'
    );
  }

  // Stable order: known CAM layers first, then ignored, then unknown; by name.
  const rank: Record<LayerRole, number> = {
    CopperTop: 0,
    CopperBottom: 1,
    Drill: 2,
    BoardOutline: 3,
    Ignore: 4,
    Unknown: 5,
  };
  entries.sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
  return entries;
}
