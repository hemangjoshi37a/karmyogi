// CAD/CAM G-code emitter — UI-independent.
// Ported from the Qt/C++ reference cadcam/gcodeemitter.{h,cpp}.
// Safety behaviour (safe-Z retract, no "-0.000", modal axis/feed words,
// Spindle vs Pen Z mode) is preserved exactly.

import { MoveType, Toolpath, ToolpathMove, Vec3 } from './toolpath';

/**
 * How Z is interpreted when emitting. In Spindle mode the toolpath's Z values
 * are written verbatim (negative = into the material). In Pen mode the emitter
 * ignores cut depth and maps cutting moves to penDownZ and travels to penUpZ,
 * so the same toolpaths drive a pen-plotter (Z = pen up/down).
 */
export enum ZMode {
  Spindle = 'Spindle',
  Pen = 'Pen',
}

/** Output policy for the emitter. Defaults are conservative and safe. */
export interface EmitterOptions {
  programName: string; // emitted as a leading comment if set

  metric: boolean; // G21 (mm) vs G20 (inch)
  absolute: boolean; // G90 vs G91 (only G90 is fully supported)

  safeZ: number; // guaranteed retract height (mm)
  feedXY: number; // cutting feed (mm/min)
  feedZ: number; // plunge feed (mm/min)
  travelFeed: number; // "free"/link feed for Travel moves (mm/min); <=0 → use feedXY

  useSpindle: boolean; // emit M3/M5 with spindleRPM
  spindleRPM: number;
  spindleDwell: number; // seconds to dwell (G4 P..) after M3; 0 = none

  zMode: ZMode;
  penUpZ: number; // pen mode: travel height
  penDownZ: number; // pen mode: drawing height

  decimals: number; // coordinate precision
  lineNumbers: boolean; // prefix N10, N20, ...
  lineNumberStep: number;
  comments: boolean; // include explanatory comments
}

/**
 * Sanitize the `decimals` option. It feeds `Number.toFixed`, which throws a
 * RangeError outside [0,100], so a bad/corrupt/typed value (e.g. -1, 7.5, 200)
 * must never reach it. The UI offers 0–6; clamp to an integer in [0,8].
 */
export function clampDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 3;
  return Math.max(0, Math.min(8, Math.floor(decimals)));
}

export function defaultEmitterOptions(overrides: Partial<EmitterOptions> = {}): EmitterOptions {
  return {
    programName: '',
    metric: true,
    absolute: true,
    safeZ: 5.0,
    feedXY: 600.0,
    feedZ: 200.0,
    travelFeed: 0.0,
    useSpindle: true,
    spindleRPM: 10000.0,
    spindleDwell: 0.0,
    zMode: ZMode.Spindle,
    penUpZ: 5.0,
    penDownZ: 0.0,
    decimals: 3,
    lineNumbers: false,
    lineNumberStep: 10,
    comments: true,
    ...overrides,
  };
}

export class GcodeEmitter {
  private m_opt: EmitterOptions;

  constructor(options: Partial<EmitterOptions> = {}) {
    this.m_opt = defaultEmitterOptions(options);
    this.m_opt.decimals = clampDecimals(this.m_opt.decimals);
  }

  options(): EmitterOptions {
    return this.m_opt;
  }
  setOptions(options: EmitterOptions): void {
    this.m_opt = options;
    this.m_opt.decimals = clampDecimals(this.m_opt.decimals);
  }

  /** Formatted number, never "-0.000". */
  private fmt(value: number): string {
    // Snap values that round to zero so we never emit "-0.000".
    const snap = 0.5 * Math.pow(10, -this.m_opt.decimals);
    if (Math.abs(value) < snap) value = 0;
    // Guard against a residual signed-zero producing "-0.000".
    if (value === 0) value = 0;
    return value.toFixed(this.m_opt.decimals);
  }

  private axisWord(axis: string, value: number): string {
    return axis + this.fmt(value);
  }

  private mapZ(move: ToolpathMove): number {
    if (this.m_opt.zMode === ZMode.Pen)
      return move.type === MoveType.Rapid || move.type === MoveType.Travel
        ? this.m_opt.penUpZ
        : this.m_opt.penDownZ;
    return move.target.z;
  }

  private addLine(out: string[], code: string, state: { lineNo: number }): void {
    if (code.length === 0) return;
    if (this.m_opt.lineNumbers) {
      out.push(`N${state.lineNo} ${code}`);
      state.lineNo += this.m_opt.lineNumberStep;
    } else {
      out.push(code);
    }
  }

  private emitMove(
    out: string[],
    move: ToolpathMove,
    s: {
      hasLast: boolean;
      last: Vec3;
      lastG: number;
      lastFeed: number;
      lineNo: number;
      penDown: boolean;
    }
  ): void {
    // ---- Pen-plotter mode -------------------------------------------------
    // The pen draws in XY only at a constant penDownZ; Z is used ONLY to lift
    // or lower the pen straight up/down (Z-only moves) when traveling between
    // strokes. No emitted line ever changes Z and XY at the same time.
    if (this.m_opt.zMode === ZMode.Pen) {
      this.emitPenMove(out, move, s);
      return;
    }

    const target: Vec3 = { x: move.target.x, y: move.target.y, z: this.mapZ(move) };

    // Rapid → G0; everything else (Feed/Plunge/Travel) is a controlled G1 move.
    const g = move.type === MoveType.Rapid ? 0 : 1;
    const travelFeed =
      this.m_opt.travelFeed > 0 ? this.m_opt.travelFeed : this.m_opt.feedXY;
    const feed =
      move.type === MoveType.Plunge
        ? this.m_opt.feedZ
        : move.type === MoveType.Travel
          ? travelFeed
          : this.m_opt.feedXY;

    const tol = 0.5 * Math.pow(10, -this.m_opt.decimals);

    const moveX = !s.hasLast || Math.abs(target.x - s.last.x) > tol;
    const moveY = !s.hasLast || Math.abs(target.y - s.last.y) > tol;
    const moveZ = !s.hasLast || Math.abs(target.z - s.last.z) > tol;
    const hasMotion = moveX || moveY || moveZ;

    // Skip a line that carries no motion and no mode change. Do this BEFORE
    // touching lastFeed, so a skipped line never swallows a pending feed word.
    if (!hasMotion && g === s.lastG) {
      s.last = target;
      s.hasLast = true;
      return;
    }

    const words: string[] = [];
    if (g !== s.lastG) words.push(`G${g}`);
    if (moveX) words.push(this.axisWord('X', target.x));
    if (moveY) words.push(this.axisWord('Y', target.y));
    if (moveZ) words.push(this.axisWord('Z', target.z));

    // Feed only matters on cutting moves and only when it changes.
    if (g === 1 && Math.abs(feed - s.lastFeed) > 1e-6) {
      words.push('F' + this.fmt(feed));
      s.lastFeed = feed;
    }

    this.addLine(out, words.join(' '), s);
    s.lastG = g;
    s.last = target;
    s.hasLast = true;
  }

  /**
   * Pen-plotter emit: guarantees Z-only pen transitions. A Rapid move means
   * "travel with the pen UP"; a Feed/Plunge move means "draw with the pen
   * DOWN". When the required pen state differs from the current one, a Z-only
   * move is emitted FIRST at the current X/Y (lift = `G0 Z<penUpZ>`, lower =
   * `G1 Z<penDownZ>`), then the X/Y motion is emitted with Z left modal. No
   * emitted line ever changes Z and XY together.
   */
  private emitPenMove(
    out: string[],
    move: ToolpathMove,
    s: {
      hasLast: boolean;
      last: Vec3;
      lastG: number;
      lastFeed: number;
      lineNo: number;
      penDown: boolean;
    }
  ): void {
    // Feed/Plunge draw (pen down); Rapid/Travel travel with the pen up.
    const wantDown = move.type !== MoveType.Rapid && move.type !== MoveType.Travel;
    const tol = 0.5 * Math.pow(10, -this.m_opt.decimals);

    // Step 1: if the pen state must change, emit a Z-only move at the CURRENT
    // X/Y. Lift (pen up) uses G0; lower (pen down) uses G1 at feedZ.
    if (wantDown !== s.penDown) {
      const z = wantDown ? this.m_opt.penDownZ : this.m_opt.penUpZ;
      if (!s.hasLast || Math.abs(z - s.last.z) > tol) {
        const g = wantDown ? 1 : 0;
        const words: string[] = [];
        if (g !== s.lastG) words.push(`G${g}`);
        words.push(this.axisWord('Z', z));
        if (g === 1 && Math.abs(this.m_opt.feedZ - s.lastFeed) > 1e-6) {
          words.push('F' + this.fmt(this.m_opt.feedZ));
          s.lastFeed = this.m_opt.feedZ;
        }
        this.addLine(out, words.join(' '), s);
        s.lastG = g;
        s.last = { x: s.last.x, y: s.last.y, z };
        s.hasLast = true;
      }
      s.penDown = wantDown;
    }

    // Step 2: emit the X/Y motion. Z stays modal (never written here). Travel
    // (pen up) is G0; drawing (pen down) is G1 at feedXY.
    const tx = move.target.x;
    const ty = move.target.y;
    const moveX = !s.hasLast || Math.abs(tx - s.last.x) > tol;
    const moveY = !s.hasLast || Math.abs(ty - s.last.y) > tol;

    const g = wantDown ? 1 : 0;
    if (!moveX && !moveY) {
      // No XY motion; nothing to draw/travel. Keep modal state consistent.
      s.lastG = g;
      return;
    }

    const words: string[] = [];
    if (g !== s.lastG) words.push(`G${g}`);
    if (moveX) words.push(this.axisWord('X', tx));
    if (moveY) words.push(this.axisWord('Y', ty));
    if (g === 1 && Math.abs(this.m_opt.feedXY - s.lastFeed) > 1e-6) {
      words.push('F' + this.fmt(this.m_opt.feedXY));
      s.lastFeed = this.m_opt.feedXY;
    }

    this.addLine(out, words.join(' '), s);
    s.lastG = g;
    s.last = { x: tx, y: ty, z: s.last.z };
    s.hasLast = true;
  }

  /** Emit a complete, self-contained G-code program for the given toolpaths. */
  emitProgram(paths: Toolpath | Toolpath[]): string {
    const list = Array.isArray(paths) ? paths : [paths];
    const out: string[] = [];
    const s = {
      hasLast: false,
      last: { x: 0, y: 0, z: 0 } as Vec3,
      lastG: -1,
      lastFeed: -1.0,
      lineNo: this.m_opt.lineNumberStep,
      // Pen-mode state: the header retracts to penUpZ, so the pen starts UP.
      penDown: false,
    };
    const retractZ = this.m_opt.zMode === ZMode.Pen ? this.m_opt.penUpZ : this.m_opt.safeZ;
    s.last = { x: 0, y: 0, z: retractZ };

    // ---- Header -----------------------------------------------------------
    if (this.m_opt.comments && this.m_opt.programName.length > 0)
      out.push(`(${this.m_opt.programName})`);
    if (this.m_opt.comments) out.push('(Generated by karmyogi.hjLabs.in CAD/CAM Workbench)');

    this.addLine(out, this.m_opt.metric ? 'G21' : 'G20', s); // units
    this.addLine(out, 'G90', s); // absolute distance
    this.addLine(out, 'G94', s); // feed per minute
    this.addLine(out, 'G17', s); // XY plane

    // Guaranteed safe start: lift Z before any XY travel.
    this.addLine(out, `G0 Z${this.fmt(retractZ)}`, s);

    if (this.m_opt.useSpindle && this.m_opt.zMode === ZMode.Spindle) {
      this.addLine(out, `M3 S${this.fmt(this.m_opt.spindleRPM)}`, s);
      if (this.m_opt.spindleDwell > 0.0) this.addLine(out, `G4 P${this.fmt(this.m_opt.spindleDwell)}`, s);
    }

    // ---- Body -------------------------------------------------------------
    for (const path of list) {
      if (path.isEmpty()) continue;
      if (this.m_opt.comments && path.name.length > 0) out.push(`(${path.name})`);
      for (const m of path.moves) this.emitMove(out, m, s);
    }

    // ---- Footer -----------------------------------------------------------
    this.addLine(out, `G0 Z${this.fmt(retractZ)}`, s);
    if (this.m_opt.useSpindle && this.m_opt.zMode === ZMode.Spindle) this.addLine(out, 'M5', s);
    this.addLine(out, 'M30', s);

    return out.join('\n') + '\n';
  }
}
