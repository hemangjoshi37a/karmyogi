// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "entity.h"

namespace cadcam {

Entity Entity::makeLine(const Point &a, const Point &b, const QString &layer)
{
    Entity e;
    e.type = Line;
    e.p1 = a;
    e.p2 = b;
    e.layer = layer;
    return e;
}

Entity Entity::makeArc(const Point &center, double radius,
                       double startAngle, double endAngle, bool ccw,
                       const QString &layer)
{
    Entity e;
    e.type = Arc;
    e.center = center;
    e.radius = radius;
    e.startAngle = startAngle;
    e.endAngle = endAngle;
    e.ccw = ccw;
    e.layer = layer;
    return e;
}

Entity Entity::makeCircle(const Point &center, double radius, const QString &layer)
{
    Entity e;
    e.type = Circle;
    e.center = center;
    e.radius = radius;
    e.layer = layer;
    return e;
}

Entity Entity::makePolyline(const Polyline &pl, const QString &layer)
{
    Entity e;
    e.type = PolylineEntity;
    e.polyline = pl;
    e.layer = layer;
    return e;
}

Polyline Entity::flatten(double tol) const
{
    switch (type) {
    case Line: {
        Polyline pl;
        pl.add(p1);
        pl.add(p2);
        return pl;
    }
    case Arc:
        return makeArcPolyline(center, radius, startAngle, endAngle, ccw, tol);
    case Circle:
        return cadcam::makeCircle(center, radius, tol);
    case PolylineEntity:
        return polyline;
    }
    return Polyline();
}

BBox Entity::bounds(double tol) const
{
    return flatten(tol).bounds();
}

bool Entity::isClosed() const
{
    switch (type) {
    case Circle:
        return true;
    case PolylineEntity:
        return polyline.closed;
    default:
        return false;
    }
}

// ---- Drawing --------------------------------------------------------------

BBox Drawing::bounds(double tol) const
{
    BBox b;
    for (const Entity &e : entities)
        b.expand(e.bounds(tol));
    return b;
}

QVector<Polyline> Drawing::flatten(double tol) const
{
    QVector<Polyline> out;
    out.reserve(entities.size());
    for (const Entity &e : entities)
        out.append(e.flatten(tol));
    return out;
}

QStringList Drawing::layers() const
{
    QStringList result;
    for (const Entity &e : entities) {
        if (!e.layer.isEmpty() && !result.contains(e.layer))
            result.append(e.layer);
    }
    return result;
}

} // namespace cadcam
