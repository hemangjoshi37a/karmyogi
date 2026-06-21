// PCB CAM test harness — exercises the Gerber/Excellon parsers + the new
// merged-net isolationRoutes (union → offset) against the two real test
// packages at the repo root. Run with:  npx tsx scripts/pcb-test.mjs
//
// It prints, per board: parse success, #copper features, #unioned polygons/rings,
// #isolation loops & passes, total path length, bbox, and a G-code safety check
// (G21/G90 present, safe-Z retracts present, NO NaN / -0.000). It also compares
// BEFORE (per-feature, mergeNets=false) vs AFTER (merged, mergeNets=true) loop
// counts on each board. Results are written to scripts/pcb-test-output.txt.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

import { importGerber } from '../src/core/gerber.ts';
import { importExcellon } from '../src/core/excellon.ts';
import { isolationRoutes, drillHits, boardCutout, boardOutlinePolygon } from '../src/core/pcbCam.ts';
import { defaultTool } from '../src/core/toolpath.ts';
import { GcodeEmitter, ZMode } from '../src/core/gcodeEmitter.ts';
import { makeRect } from '../src/core/geometry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const lines = [];
const log = (s = '') => {
  lines.push(s);
  console.log(s);
};

// --- helpers -----------------------------------------------------------------

function loadZip(name) {
  const buf = readFileSync(join(ROOT, name));
  const files = unzipSync(new Uint8Array(buf));
  const out = {};
  for (const [path, data] of Object.entries(files)) out[path] = strFromU8(data);
  return out;
}

function pickCopper(files) {
  // Top copper preferred; fall back to first plausible copper gerber.
  const keys = Object.keys(files);
  const top = keys.find((k) => /\.gtl$/i.test(k) || /top copper/i.test(k));
  if (top) return { name: top, content: files[top] };
  const bot = keys.find((k) => /\.gbl$/i.test(k) || /bottom copper/i.test(k));
  if (bot) return { name: bot, content: files[bot] };
  return null;
}

function pickDrill(files) {
  const keys = Object.keys(files);
  // Prefer a PTH through-hole file; else any .drl.
  const pth = keys.find((k) => /\.drl$/i.test(k) && /pth/i.test(k) && !/npth/i.test(k));
  const any = keys.find((k) => /\.drl$/i.test(k));
  const k = pth || any;
  return k ? { name: k, content: files[k] } : null;
}

function pickOutline(files) {
  const keys = Object.keys(files);
  const k = keys.find((x) => /\.gko$/i.test(x) || /\bmechanical\b/i.test(x) || /outline/i.test(x));
  return k ? { name: k, content: files[k] } : null;
}

function totalPathLength(tp) {
  return tp.cutLength() + tp.rapidLength();
}

function countLoops(tp) {
  // A "loop" begins at each rapid->plunge sequence. Count plunge moves as loops.
  let loops = 0;
  for (const m of tp.moves) if (m.type === 'Plunge') loops++;
  return loops;
}

function checkGcodeSafety(label, gcode) {
  const issues = [];
  if (!/\bG21\b/.test(gcode)) issues.push('missing G21 (mm units)');
  if (!/\bG90\b/.test(gcode)) issues.push('missing G90 (absolute)');
  if (/NaN/.test(gcode)) issues.push('contains NaN');
  if (/-0\.0+(\D|$)/.test(gcode)) issues.push('contains -0.000');
  // Safe-Z retract: at least one positive-Z G0 move (retract) should exist.
  if (!/G0[^\n]*Z\s*[0-9]/.test(gcode.replace(/G00/g, 'G0'))) issues.push('no safe-Z retract (G0 Z+)');
  log(`    [${label}] gcode safety: ${issues.length === 0 ? 'OK' : 'FAIL -> ' + issues.join('; ')}`);
  return issues.length === 0;
}

function fmtBBox(b) {
  if (!b.isValid()) return 'invalid';
  return `x[${b.min.x.toFixed(2)},${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] (${b.width().toFixed(2)}x${b.height().toFixed(2)})`;
}

// Mirror PcbPanel's emitter config (Spindle mode).
function makeEmitter(tool, name) {
  return new GcodeEmitter({
    safeZ: 3,
    feedXY: tool.feedXY,
    feedZ: tool.feedZ,
    spindleRPM: tool.spindleRPM,
    zMode: ZMode.Spindle,
    useSpindle: true,
    penUpZ: 3,
    penDownZ: 0,
    programName: `karmyogi PCB ${name}`,
  });
}

// --- per-board run -----------------------------------------------------------

function runBoard(zipName) {
  log('');
  log('='.repeat(72));
  log(`BOARD: ${zipName}`);
  log('='.repeat(72));

  const files = loadZip(zipName);
  const copper = pickCopper(files);
  const drill = pickDrill(files);
  const outlineSrc = pickOutline(files);

  log(`  files in zip: ${Object.keys(files).length}`);
  log(`  copper layer: ${copper ? copper.name : '(none)'}`);
  log(`  drill layer:  ${drill ? drill.name : '(none)'}`);
  log(`  outline layer:${outlineSrc ? ' ' + outlineSrc.name : ' (none — will use copper/bbox)'}`);

  const tool = defaultTool({ diameter: 0.2, feedXY: 120, feedZ: 60, spindleRPM: 0, stepdown: 0.6 });
  const safeZ = 3;
  const cutZ = -0.1;
  const passes = 2;
  const stepoverMm = 0.1;

  // ---- Copper parse + isolation ----
  if (!copper) {
    log('  NO COPPER LAYER — skipping isolation.');
  } else {
    const res = importGerber(copper.content);
    log('');
    log(`  Gerber parse: ${res.ok ? 'OK' : 'FAIL: ' + res.error}`);
    if (res.warnings.length) log(`    warnings(${res.warnings.length}): ${res.warnings.slice(0, 3).join(' | ')}${res.warnings.length > 3 ? ' …' : ''}`);
    const g = res.data;
    const nFeat = g.traces.length + g.pads.length + g.regions.length;
    log(`    copper features: ${nFeat}  (traces=${g.traces.length}, pads=${g.pads.length}, regions=${g.regions.length})`);
    log(`    copper bbox: ${fmtBBox(g.bounds())}`);

    // BEFORE: per-feature isolation.
    const before = isolationRoutes(g, tool, safeZ, cutZ, passes, stepoverMm, false);
    const beforeLoops = countLoops(before);

    // AFTER: merged-net isolation (default).
    const after = isolationRoutes(g, tool, safeZ, cutZ, passes, stepoverMm, true);
    const afterLoops = countLoops(after);

    log('');
    log(`    BEFORE (per-feature)  : ${beforeLoops} loops, ${before.moves.length} moves, path ${totalPathLength(before).toFixed(1)} mm`);
    log(`    AFTER  (merged-net)   : ${afterLoops} loops, ${after.moves.length} moves, path ${totalPathLength(after).toFixed(1)} mm`);
    log(`    passes per ring/feature: ${passes}, stepover ${stepoverMm} mm, tool dia ${tool.diameter} mm`);
    const pct = beforeLoops > 0 ? (((beforeLoops - afterLoops) / beforeLoops) * 100).toFixed(1) : 'n/a';
    log(`    -> merged-net loop reduction: ${pct}%  (fewer/cleaner where copper overlaps)`);

    // Sanity: non-empty.
    log(`    isolation non-empty: ${after.moves.length > 0 ? 'YES' : 'NO (EMPTY!)'}`);

    // G-code safety on AFTER.
    const gcode = makeEmitter(tool, after.name).emitProgram(after);
    checkGcodeSafety('isolation', gcode);
  }

  // ---- Drill ----
  if (drill) {
    const res = importExcellon(drill.content);
    log('');
    log(`  Excellon parse: ${res.ok ? 'OK' : 'FAIL: ' + res.error}`);
    if (res.ok) {
      log(`    drill hits: ${res.data.hits.length}, tools: ${res.data.toolDiameters().length}`);
      const dtp = drillHits(res.data, safeZ, -1.8, 0);
      log(`    drill toolpath: ${dtp.moves.length} moves, path ${totalPathLength(dtp).toFixed(1)} mm`);
      const gcode = makeEmitter(tool, dtp.name).emitProgram(dtp);
      checkGcodeSafety('drill', gcode);
    }
  } else {
    log('  NO DRILL LAYER.');
  }

  // ---- Cutout ----
  {
    let g = null;
    let src = outlineSrc || copper;
    if (src) {
      const r = importGerber(src.content);
      if (r.ok) g = r.data;
    }
    if (g) {
      let outline = boardOutlinePolygon(g);
      if (!outline || outline.points.length < 3) {
        const b = g.bounds();
        outline = b.isValid() ? makeRect(b.min, b.width(), b.height()) : null;
      }
      if (outline) {
        const ctp = boardCutout(outline, tool, safeZ, 1.6, 4, 2);
        log('');
        log(`  Cutout: outline ${outline.points.length} pts, ${ctp.moves.length} moves, path ${totalPathLength(ctp).toFixed(1)} mm`);
        const gcode = makeEmitter(tool, ctp.name).emitProgram(ctp);
        checkGcodeSafety('cutout', gcode);
      } else {
        log('  Cutout: no usable outline.');
      }
    }
  }
}

// --- main --------------------------------------------------------------------

log(`PCB CAM harness — ${new Date().toISOString()}`);
for (const z of ['gerber.ZIP', 'Gerber_SRP 70_50mm_Release.zip']) {
  try {
    runBoard(z);
  } catch (e) {
    log(`  ERROR running ${z}: ${e && e.stack ? e.stack : e}`);
  }
}

writeFileSync(join(__dirname, 'pcb-test-output.txt'), lines.join('\n'));
log('');
log('Wrote scripts/pcb-test-output.txt');
