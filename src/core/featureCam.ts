// Per-feature CAM composition — UI-independent (no React/DOM/three.js imports).
// ----------------------------------------------------------------------------
// The classic 2D flow in `cam.ts` applies ONE operation+settings bundle to the
// WHOLE file. This module adds a "per-feature" layer on top of it: a loaded
// drawing is split into FEATURES (one per flattened polyline — a closed or open
// loop), and the user stacks one or more OPERATIONS on each feature. Each
// operation is a color-coded PRESET (op + cut settings) so the same feature can
// carry e.g. a Roughing pass and a Finishing pass.
//
// We reuse the existing pure CAM primitives (engrave / profile / pocket) and the
// containment-aware `orderLoopsInsideOut` cut ordering, then concatenate every
// feature's operations into ONE list of toolpaths the existing safe
// GcodeEmitter turns into a single safe program (G21/G90/G94/G17 + safe-Z).
//
// 3D surface features are intentionally OUT OF SCOPE here (deferred) — this layer
// models 2D loops; the structure (a flat list of features keyed by polyline
// index) leaves room to add surface features later without changing the op model.

import { Polyline, orderLoopsInsideOut } from './geometry';
import { Tool, Toolpath, defaultTool } from './toolpath';
import {
  CamParams,
  ProfileSide,
  cutout,
  engrave,
  pocket,
  profile,
} from './cam';

/**
 * The operation kinds a per-feature preset can carry. (Mirrors the 2D `Op`.)
 * - 'Pocket' is also used for the "Clear-out" preset (a flat area clear).
 * - 'Cutout' profiles the loop free through the full stock depth leaving holding
 *   tabs; it is always emitted LAST (see {@link compose}).
 */
export type FeatureOpKind = 'Engrave' | 'Profile' | 'Pocket' | 'Cutout';

/**
 * A color-coded preset = a named operation + a partial settings override. The
 * preset's `color` is the visual identity used both in the feature picker (the
 * swatch on the feature + on each stacked op) and as the palette entry the user
 * clicks to add an op. Settings are PARTIAL — anything omitted falls back to the
 * panel's current 2D tool/cut defaults at generation time, so a preset stays a
 * light "intent" (e.g. "Pocket, blue") rather than a full machine config.
 */
export interface FeaturePreset {
  id: string;
  name: string;
  color: string;
  op: FeatureOpKind;
  /** Profile side (only meaningful when op === 'Profile'). */
  side?: ProfileSide;
  /** Optional per-preset cut overrides (mm). Omitted → use the panel defaults. */
  cutDepth?: number;
  stepdown?: number;
  stepover?: number;
  diameter?: number;
}

/**
 * A single operation STACKED on a feature: a clone of a preset's intent plus a
 * stable id (so the UI can reorder/remove it) and any per-instance tweaks. We
 * snapshot the preset's fields onto the op so editing a preset later doesn't
 * silently rewrite already-placed ops.
 */
export interface FeatureOp {
  id: string;
  presetId: string;
  /** Human label shown in the stack (e.g. "Profile-outside (red)"). */
  label: string;
  color: string;
  op: FeatureOpKind;
  side?: ProfileSide;
  cutDepth?: number;
  stepdown?: number;
  stepover?: number;
  diameter?: number;
}

/**
 * The per-feature assignment map: feature key (the polyline index, as a string)
 * → ordered list of ops. A feature with no entry (or an empty list) generates
 * nothing of its own — see {@link composeFeatureToolpaths} for the whole-file
 * fallback used to preserve the legacy behavior.
 */
export type FeatureOpMap = Record<string, FeatureOp[]>;

/** A derived, pickable feature of the loaded drawing. */
export interface DrawingFeature {
  /** Stable key: the index of this polyline in the panel's `polylines` array. */
  index: number;
  closed: boolean;
  /** Vertex count (after flatten) — handy for labels / "tiny feature" hints. */
  points: number;
  /** A stable display color for the feature outline in the mini viewer. */
  color: string;
}

// A small, distinct, color-blind-friendly-ish cycle for feature outlines. These
// are the FEATURE identity colors (NOT the preset colors — presets carry their
// own). Kept deterministic by index so a feature keeps its color across renders.
const FEATURE_COLORS = [
  '#38bdf8', // sky
  '#f472b6', // pink
  '#a3e635', // lime
  '#fbbf24', // amber
  '#c084fc', // violet
  '#fb7185', // rose
  '#34d399', // emerald
  '#60a5fa', // blue
  '#facc15', // yellow
  '#f87171', // red
];

export function featureColor(index: number): string {
  return FEATURE_COLORS[index % FEATURE_COLORS.length];
}

/** Derive the pickable feature list from the placed polylines (one per polyline). */
export function deriveFeatures(polylines: Polyline[]): DrawingFeature[] {
  return polylines.map((pl, i) => ({
    index: i,
    closed: pl.closed && pl.points.length >= 3,
    points: pl.points.length,
    color: featureColor(i),
  }));
}

/**
 * The built-in color preset palette. Reuses the existing op types + sensible
 * defaults; per-preset overrides keep them light (the panel's tool/cut params
 * fill the rest). Each color names a common "intent" so the user picks by color.
 */
export const BUILTIN_PRESETS: FeaturePreset[] = [
  { id: 'profile-out', name: 'Profile-outside', color: '#ef4444', op: 'Profile', side: ProfileSide.Outside },
  { id: 'profile-in', name: 'Profile-inside', color: '#3b82f6', op: 'Profile', side: ProfileSide.Inside },
  { id: 'profile-on', name: 'Profile-on', color: '#8b5cf6', op: 'Profile', side: ProfileSide.On },
  { id: 'pocket', name: 'Pocket', color: '#0ea5e9', op: 'Pocket' },
  { id: 'engrave', name: 'Engrave', color: '#22c55e', op: 'Engrave' },
  // Flat clearing of the area inside a closed loop (a Pocket-style flat clear).
  { id: 'clearout', name: 'Clear-out', color: '#06b6d4', op: 'Pocket' },
  // Cut the part free from the stock with holding tabs — always runs LAST.
  { id: 'cutout', name: 'Cutout', color: '#e11d48', op: 'Cutout', side: ProfileSide.Outside },
  // Two common multi-pass intents on the SAME feature: a deep roughing profile
  // and a light finishing profile (the user can stack both on one loop).
  { id: 'rough', name: 'Roughing (profile-out)', color: '#f59e0b', op: 'Profile', side: ProfileSide.Outside, stepdown: 2.0 },
  { id: 'finish', name: 'Finishing (profile-out)', color: '#14b8a6', op: 'Profile', side: ProfileSide.Outside, stepdown: 0.4 },
];

export function findPreset(id: string): FeaturePreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id);
}

let opCounter = 0;
/** Instantiate a stacked op from a preset (snapshotting its intent). */
export function opFromPreset(preset: FeaturePreset): FeatureOp {
  opCounter += 1;
  return {
    id: `op-${Date.now().toString(36)}-${opCounter}`,
    presetId: preset.id,
    label: preset.name,
    color: preset.color,
    op: preset.op,
    side: preset.side,
    cutDepth: preset.cutDepth,
    stepdown: preset.stepdown,
    stepover: preset.stepover,
    diameter: preset.diameter,
  };
}

/** Apply an op's optional overrides onto the panel's base tool + cam params. */
function paramsForOp(op: FeatureOp, baseTool: Tool, base: CamParams): CamParams {
  const tool = defaultTool({
    ...baseTool,
    diameter: op.diameter ?? baseTool.diameter,
    stepdown: op.stepdown ?? baseTool.stepdown,
    stepover: op.stepover ?? baseTool.stepover,
  });
  return {
    tool,
    safeZ: base.safeZ,
    surfaceZ: base.surfaceZ,
    cutDepth: op.cutDepth ?? base.cutDepth,
  };
}

/** Build the toolpath for a single op on a single polyline. */
function toolpathForOp(op: FeatureOp, poly: Polyline, p: CamParams): Toolpath {
  switch (op.op) {
    case 'Engrave':
      return engrave(poly, p);
    case 'Pocket':
      return pocket(poly, p);
    case 'Profile':
      return profile(poly, op.side ?? ProfileSide.Outside, p);
    case 'Cutout':
      // Profile outside + cut through the full depth leaving holding tabs. Uses
      // the op's cutDepth (the preset defaults it to a through-stock value).
      return cutout(poly, p);
  }
}

/** True for an op that frees the part — it must be emitted LAST for safety. */
function isCutout(op: FeatureOp): boolean {
  return op.op === 'Cutout';
}

/**
 * One emitted operation in the per-operation breakdown: a single op on a single
 * loop, with its own toolpath, preset color and a human loop label. The panel
 * turns each entry into its OWN program "operation" (its own G-code + color) so
 * the Program tab can expand a carving section into per-op gcode and the
 * Visualizer can tint each op's toolpath by its preset color.
 */
export interface ComposedOperation {
  /** Stable id of the source {@link FeatureOp} (or a synthetic fallback id). */
  opId: string;
  /** Display label (e.g. "Profile-outside · Loop 1 (closed)"). */
  label: string;
  /** The preset color this op carries (used for Visualizer tinting). */
  color: string;
  /** Loop label, e.g. "Loop 1 (closed)". */
  loopLabel: string;
  /** The single-op toolpath (non-empty; empty ops are dropped). */
  toolpath: Toolpath;
}

/** Result of a per-feature composition: the toolpaths + a small generation log. */
export interface ComposeResult {
  toolpaths: Toolpath[];
  /** True when at least one feature had an explicit op (per-feature mode active). */
  perFeature: boolean;
  /** Count of operations actually emitted (non-empty). */
  opCount: number;
  /**
   * Per-operation breakdown in EMITTED order — one entry per non-empty op, in
   * the SAME order as `toolpaths` (so `toolpaths[i] === operations[i].toolpath`).
   * Lets the panel emit per-op gcode + colors without re-composing.
   */
  operations: ComposedOperation[];
}

/** Human label for a loop given its polyline index + closed-ness. */
export function loopLabel(index: number, closed: boolean): string {
  return `Loop ${index + 1} (${closed ? 'closed' : 'open'})`;
}

/** Describes one placed op for safe-order computation (the panel's flat list). */
export interface OrderableOp {
  /** Stable op id (matches the panel's featureOpOrder entries). */
  opId: string;
  /** The polyline this op runs on, in its file's geometry. */
  poly: Polyline;
  /** The op kind (Cutout ops are forced to the very end). */
  op: FeatureOpKind;
  /** Stable sequence index used to break ties (preserves stack order within a loop). */
  seq: number;
}

/**
 * Compute a SAFE machining ORDER over a flat list of placed ops, REUSING the same
 * containment-aware {@link orderLoopsInsideOut} the generator uses:
 *   1. inner / contained loops first → outer loops (children before parents),
 *   2. open / sub-3-point loops after the closed ones,
 *   3. within one loop, ops keep their original sequence (roughing before
 *      finishing, etc.),
 *   4. ANY Cutout op is forced to the very END so the part is never detached
 *      before its inner cuts finish.
 *
 * Returns the op ids in the safe order. The panel uses this to reorder its VISIBLE
 * ops list so it matches what generation already emits — see {@link compose}.
 */
export function orderOpsSafe(ops: OrderableOp[]): string[] {
  // Group ops by their polyline reference (a loop), preserving first-seen order.
  const groups: { poly: Polyline; ops: OrderableOp[] }[] = [];
  const groupOf = new Map<Polyline, number>();
  for (const o of ops) {
    let gi = groupOf.get(o.poly);
    if (gi === undefined) {
      gi = groups.length;
      groupOf.set(o.poly, gi);
      groups.push({ poly: o.poly, ops: [] });
    }
    groups[gi].ops.push(o);
  }

  const isClosed = (p: Polyline) => p.closed && p.points.length >= 3;
  const closedGroups = groups.filter((g) => isClosed(g.poly));
  const openGroups = groups.filter((g) => !isClosed(g.poly));

  // INSIDE-OUT order over the closed loops (children before parents).
  const closedPolys = closedGroups.map((g) => g.poly);
  const order = orderLoopsInsideOut(closedPolys).map((pos) => closedGroups[pos]);
  const orderedGroups = [...order, ...openGroups];

  const normal: OrderableOp[] = [];
  const cutouts: OrderableOp[] = [];
  for (const g of orderedGroups) {
    // Keep each loop's ops in their original sequence (roughing before finishing).
    const sorted = g.ops.slice().sort((a, b) => a.seq - b.seq);
    for (const o of sorted) (o.op === 'Cutout' ? cutouts : normal).push(o);
  }
  // Cutouts last (already inside-out among themselves via the group order above).
  return [...normal, ...cutouts].map((o) => o.opId);
}

// ── Multi-file keying ───────────────────────────────────────────────────────
// With MULTIPLE loaded files, a loop is identified by its FILE id plus its
// polyline index within that file. We key the FeatureOpMap by a composite
// string `${fileId}#${loopIndex}` so loops from different files never collide.
// The single-file flow stays valid: a file with id "" yields keys identical to
// the old bare-index keys ("#0", "#1", …) — but the panel always passes a real
// file id now, so old persisted maps (which were never persisted) are moot.

/** Build the composite FeatureOpMap key for a loop in a given file. */
export function featureKey(fileId: string, loopIndex: number): string {
  return `${fileId}#${loopIndex}`;
}

/**
 * Build the composite FeatureOpMap key for a 3D SURFACE region of a given file/
 * job. Surface keys are namespaced with an `s` prefix on the region id so they
 * can NEVER collide with 2D loop keys (`${fileId}#${index}`) even though both
 * live in the SAME {@link FeatureOpMap}. This lets the per-op list / ordering /
 * per-op program path be reused unchanged for surfaces.
 */
export function surfaceKey(fileId: string, regionId: number): string {
  return `${fileId}#s${regionId}`;
}

/** Parse a surface key back into its file/job id + region id, or null if not one. */
export function parseSurfaceKey(key: string): { fileId: string; regionId: number } | null {
  const hash = key.lastIndexOf('#s');
  if (hash < 0) return null;
  const rid = Number(key.slice(hash + 2));
  if (!Number.isFinite(rid)) return null;
  return { fileId: key.slice(0, hash), regionId: rid };
}

/** True when a FeatureOpMap key addresses a 3D surface region (vs a 2D loop). */
export function isSurfaceKey(key: string): boolean {
  return parseSurfaceKey(key) !== null;
}

/** Parse a composite key back into its file id + loop index. */
export function parseFeatureKey(key: string): { fileId: string; loopIndex: number } {
  const hash = key.lastIndexOf('#');
  if (hash < 0) return { fileId: '', loopIndex: Number(key) || 0 };
  return { fileId: key.slice(0, hash), loopIndex: Number(key.slice(hash + 1)) || 0 };
}

/** One loaded file's placed geometry, for multi-file composition. */
export interface FileGeometry {
  fileId: string;
  name: string;
  polylines: Polyline[];
}

/**
 * Compose toolpaths across MULTIPLE files into one ordered list for the safe
 * emitter (U8). The op map is keyed by {@link featureKey} (fileId#loopIndex).
 *
 * Each file is composed independently (its own containment-aware inside-out
 * ordering over its own loops) and the per-file results are concatenated in the
 * file list's order. Operation LABELS are prefixed with the file name so the
 * Program tab / Visualizer can tell loops from different files apart.
 *
 * WHOLE-FILE FALLBACK: when NO loop in ANY file carries an op, this applies the
 * supplied `fallback` operation to every loop of every file (exactly today's
 * whole-file behavior, now spanning all files).
 */
export function composeMultiFileToolpaths(
  files: FileGeometry[],
  opMap: FeatureOpMap,
  baseTool: Tool,
  base: CamParams,
  fallback?: { op: FeatureOpKind; side?: ProfileSide },
): ComposeResult {
  const anyOps = Object.values(opMap).some((ops) => ops && ops.length > 0);

  const allToolpaths: Toolpath[] = [];
  const allOperations: ComposedOperation[] = [];
  let opCount = 0;

  for (const file of files) {
    // Slice this file's ops out of the global map into a per-file, bare-index map.
    const localMap: FeatureOpMap = {};
    if (anyOps) {
      file.polylines.forEach((_, i) => {
        const ops = opMap[featureKey(file.fileId, i)];
        if (ops && ops.length) localMap[String(i)] = ops;
      });
      // Skip files with no ops only when SOME other file has ops (per-feature mode).
      if (Object.keys(localMap).length === 0) continue;
    }
    const res = composeFeatureToolpaths(
      file.polylines,
      anyOps ? localMap : {},
      baseTool,
      base,
      fallback,
    );
    const prefix = files.length > 1 ? `${file.name} · ` : '';
    for (const tp of res.toolpaths) {
      if (prefix && tp.name) tp.name = `${prefix}${tp.name}`;
      allToolpaths.push(tp);
    }
    for (const co of res.operations) {
      allOperations.push(
        prefix
          ? { ...co, label: `${prefix}${co.label}`, loopLabel: `${prefix}${co.loopLabel}` }
          : co,
      );
    }
    opCount += res.opCount;
  }

  return { toolpaths: allToolpaths, perFeature: anyOps, opCount, operations: allOperations };
}

/**
 * Compose toolpaths for EVERY feature given its stacked ops, into one ordered
 * list for the safe emitter.
 *
 * ORDERING: features are emitted in containment-aware INSIDE-OUT order (a loop
 * nested inside another is cut first) so a part is never freed while an inner
 * cut is still pending — matching the whole-file `profileContours`/pocket
 * behavior. Within a feature, ops run in the user's stack order
 * (roughing-before-finishing, etc.). Open loops carry no containment relation
 * and are appended after the closed ones.
 *
 * BACKWARD COMPATIBILITY: when `opMap` assigns NO ops to any feature, this falls
 * back to the supplied `fallback` operation applied to every polyline — i.e.
 * exactly today's whole-file behavior. Pass `fallback` = the panel's current
 * single-op intent so an untouched UI keeps producing the same program.
 */
export function composeFeatureToolpaths(
  polylines: Polyline[],
  opMap: FeatureOpMap,
  baseTool: Tool,
  base: CamParams,
  fallback?: { op: FeatureOpKind; side?: ProfileSide },
): ComposeResult {
  // Does any feature carry at least one op?
  const anyOps = Object.values(opMap).some((ops) => ops && ops.length > 0);

  if (!anyOps) {
    // ── Whole-file fallback (legacy behavior) ──────────────────────────────
    if (!fallback) return { toolpaths: [], perFeature: false, opCount: 0, operations: [] };
    const synthetic: FeatureOpMap = {};
    polylines.forEach((_, i) => {
      synthetic[String(i)] = [
        {
          id: `fallback-${i}`,
          presetId: 'fallback',
          label: fallback.op,
          color: '#888',
          op: fallback.op,
          side: fallback.side,
        },
      ];
    });
    return compose(polylines, synthetic, baseTool, base, false);
  }

  return compose(polylines, opMap, baseTool, base, true);
}

function compose(
  polylines: Polyline[],
  opMap: FeatureOpMap,
  baseTool: Tool,
  base: CamParams,
  perFeature: boolean,
): ComposeResult {
  // Build containment-aware order over the CLOSED features so nested loops cut
  // first. We order by polyline index but only among those that actually have
  // ops; open / sub-3-point polylines fall to the tail.
  const indices = polylines.map((_, i) => i).filter((i) => (opMap[String(i)]?.length ?? 0) > 0);
  const closedIdx = indices.filter((i) => polylines[i].closed && polylines[i].points.length >= 3);
  const openIdx = indices.filter((i) => !(polylines[i].closed && polylines[i].points.length >= 3));

  // orderLoopsInsideOut returns positions into the array we hand it; map back.
  const closedPolys = closedIdx.map((i) => polylines[i]);
  const order = orderLoopsInsideOut(closedPolys).map((pos) => closedIdx[pos]);
  const ordered = [...order, ...openIdx];

  const toolpaths: Toolpath[] = [];
  const operations: ComposedOperation[] = [];
  let opCount = 0;

  // Emit normal ops first (inside-out loop order, stack order within a loop), then
  // ALL Cutout ops — a Cutout frees the part, so it must never run before any
  // other cut still pending on the same or an inner loop. This is a hard SAFETY
  // guarantee regardless of the user's visible op order.
  const emit = (op: FeatureOp, loopIdx: number, lbl: string): void => {
    const p = paramsForOp(op, baseTool, base);
    const tp = toolpathForOp(op, polylines[loopIdx], p);
    if (tp.isEmpty()) return;
    tp.name = `${op.label} · ${lbl}`;
    toolpaths.push(tp);
    operations.push({ opId: op.id, label: tp.name, color: op.color, loopLabel: lbl, toolpath: tp });
    opCount += 1;
  };

  const deferred: { op: FeatureOp; loopIdx: number; lbl: string }[] = [];
  for (const i of ordered) {
    const ops = opMap[String(i)] ?? [];
    const lbl = loopLabel(i, polylines[i].closed && polylines[i].points.length >= 3);
    for (const op of ops) {
      if (isCutout(op)) deferred.push({ op, loopIdx: i, lbl });
      else emit(op, i, lbl);
    }
  }
  for (const d of deferred) emit(d.op, d.loopIdx, d.lbl);

  return { toolpaths, perFeature, opCount, operations };
}
