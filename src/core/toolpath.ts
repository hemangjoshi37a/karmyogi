// CAD/CAM toolpath model — UI-independent.
// Ported from the Qt/C++ reference cadcam/toolpath.{h,cpp}.

import { BBox } from './geometry';

/** A 3D point (mm). Replaces Qt's QVector3D. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function vlen(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Cutting tool / pen description. Feeds are mm/min. */
export interface Tool {
  name: string;
  diameter: number; // mm
  feedXY: number; // cutting feed
  feedZ: number; // plunge feed
  spindleRPM: number;
  stepover: number; // fraction of diameter (0..1) for pocketing
  stepdown: number; // mm per depth pass
}

export function defaultTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'Default',
    diameter: 3.175, // 1/8"
    feedXY: 600,
    feedZ: 200,
    spindleRPM: 10000,
    stepover: 0.5,
    stepdown: 1.0,
    ...overrides,
  };
}

export function toolRadius(t: Tool): number {
  return t.diameter / 2;
}

export enum MoveType {
  Rapid = 'Rapid', // G0 — non-cutting positioning at travel height
  Feed = 'Feed', // G1 — cutting move in XY (and Z)
  Plunge = 'Plunge', // G1 — vertical entry into material (feedZ)
}

export interface ToolpathMove {
  target: Vec3; // absolute target (mm)
  type: MoveType;
}

/**
 * An ordered sequence of moves produced by a CAM operation. A toolpath does not
 * embed safe-Z / units policy — that belongs to the emitter. It carries the
 * moves at their intended Z depths plus retract moves between passes.
 */
export class Toolpath {
  name = '';
  moves: ToolpathMove[] = [];

  isEmpty(): boolean {
    return this.moves.length === 0;
  }
  size(): number {
    return this.moves.length;
  }
  clear(): void {
    this.moves = [];
  }

  rapid(p: Vec3): void {
    this.moves.push({ target: { ...p }, type: MoveType.Rapid });
  }
  rapidXY(x: number, y: number, z: number): void {
    this.rapid({ x, y, z });
  }
  feed(p: Vec3): void {
    this.moves.push({ target: { ...p }, type: MoveType.Feed });
  }
  plunge(p: Vec3): void {
    this.moves.push({ target: { ...p }, type: MoveType.Plunge });
  }
  append(m: ToolpathMove): void {
    this.moves.push(m);
  }

  /** 2D bounds across all move targets. */
  bounds2D(): BBox {
    const b = new BBox();
    for (const m of this.moves) b.expand({ x: m.target.x, y: m.target.y });
    return b;
  }

  /** Min/max Z over all moves (returns {0,0} when empty). */
  zRange(): { zMin: number; zMax: number } {
    if (this.moves.length === 0) return { zMin: 0, zMax: 0 };
    let zMin = this.moves[0].target.z;
    let zMax = zMin;
    for (const m of this.moves) {
      const z = m.target.z;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    return { zMin, zMax };
  }

  /** Total cut (Feed+Plunge) distance. */
  cutLength(): number {
    let total = 0;
    for (let i = 1; i < this.moves.length; ++i) {
      if (this.moves[i].type === MoveType.Feed || this.moves[i].type === MoveType.Plunge)
        total += vlen(this.moves[i].target, this.moves[i - 1].target);
    }
    return total;
  }

  /** Total rapid distance. */
  rapidLength(): number {
    let total = 0;
    for (let i = 1; i < this.moves.length; ++i) {
      if (this.moves[i].type === MoveType.Rapid)
        total += vlen(this.moves[i].target, this.moves[i - 1].target);
    }
    return total;
  }
}
