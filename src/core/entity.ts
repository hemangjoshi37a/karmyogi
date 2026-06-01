// CAD entity model + Drawing document — UI-independent.
// Ported from the Qt/C++ reference cadcam/entity.{h,cpp}.

import {
  BBox,
  Point,
  Polyline,
  kDefaultArcTolerance,
  makeArcPolyline,
  makeCircle,
} from './geometry';

export enum EntityType {
  Line = 'Line',
  Arc = 'Arc',
  Circle = 'Circle',
  PolylineEntity = 'PolylineEntity',
}

/**
 * A single 2D CAD entity. Kept as a plain tagged struct (no polymorphism) so
 * drawings copy/serialise trivially. Every entity can flatten to a Polyline.
 */
export class Entity {
  type: EntityType = EntityType.Line;

  // Line: uses p1, p2.
  p1: Point = { x: 0, y: 0 };
  p2: Point = { x: 0, y: 0 };
  // Arc / Circle: uses center, radius, startAngle, endAngle (radians), ccw.
  center: Point = { x: 0, y: 0 };
  radius = 0;
  startAngle = 0; // radians
  endAngle = 0; // radians
  ccw = true;
  // PolylineEntity:
  polyline: Polyline = new Polyline();

  layer = '';

  // ---- Factories ----------------------------------------------------------
  static makeLine(a: Point, b: Point, layer = ''): Entity {
    const e = new Entity();
    e.type = EntityType.Line;
    e.p1 = { x: a.x, y: a.y };
    e.p2 = { x: b.x, y: b.y };
    e.layer = layer;
    return e;
  }

  static makeArc(
    center: Point,
    radius: number,
    startAngle: number,
    endAngle: number,
    ccw = true,
    layer = ''
  ): Entity {
    const e = new Entity();
    e.type = EntityType.Arc;
    e.center = { x: center.x, y: center.y };
    e.radius = radius;
    e.startAngle = startAngle;
    e.endAngle = endAngle;
    e.ccw = ccw;
    e.layer = layer;
    return e;
  }

  static makeCircle(center: Point, radius: number, layer = ''): Entity {
    const e = new Entity();
    e.type = EntityType.Circle;
    e.center = { x: center.x, y: center.y };
    e.radius = radius;
    e.layer = layer;
    return e;
  }

  static makePolyline(pl: Polyline, layer = ''): Entity {
    const e = new Entity();
    e.type = EntityType.PolylineEntity;
    e.polyline = pl;
    e.layer = layer;
    return e;
  }

  flatten(tol = kDefaultArcTolerance): Polyline {
    switch (this.type) {
      case EntityType.Line: {
        const pl = new Polyline();
        pl.add(this.p1);
        pl.add(this.p2);
        return pl;
      }
      case EntityType.Arc:
        return makeArcPolyline(this.center, this.radius, this.startAngle, this.endAngle, this.ccw, tol);
      case EntityType.Circle:
        return makeCircle(this.center, this.radius, tol);
      case EntityType.PolylineEntity:
        return this.polyline;
    }
  }

  bounds(tol = kDefaultArcTolerance): BBox {
    return this.flatten(tol).bounds();
  }

  isClosed(): boolean {
    switch (this.type) {
      case EntityType.Circle:
        return true;
      case EntityType.PolylineEntity:
        return this.polyline.closed;
      default:
        return false;
    }
  }
}

/** A CAD document: a flat list of entities plus the layers seen. */
export class Drawing {
  entities: Entity[] = [];

  add(e: Entity): void {
    this.entities.push(e);
  }
  size(): number {
    return this.entities.length;
  }
  isEmpty(): boolean {
    return this.entities.length === 0;
  }
  clear(): void {
    this.entities = [];
  }

  bounds(tol = kDefaultArcTolerance): BBox {
    const b = new BBox();
    for (const e of this.entities) b.expand(e.bounds(tol));
    return b;
  }

  /** Flatten every entity to a polyline (one per entity). */
  flatten(tol = kDefaultArcTolerance): Polyline[] {
    return this.entities.map((e) => e.flatten(tol));
  }

  /** List of distinct layer names, in first-seen order. */
  layers(): string[] {
    const result: string[] = [];
    for (const e of this.entities) {
      if (e.layer && !result.includes(e.layer)) result.push(e.layer);
    }
    return result;
  }
}
