// This file is a part of "Candle" application (hjLabs.in fork).
// Shared CAD/CAM geometry core — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_ENTITY_H
#define CADCAM_ENTITY_H

#include "geometry.h"

#include <QVector>
#include <QString>
#include <QStringList>

namespace cadcam {

// A single 2D CAD entity. Kept as a plain tagged struct (no polymorphism) so
// drawings copy/serialise trivially. Every entity can flatten to a Polyline.
class Entity
{
public:
    enum Type { Line, Arc, Circle, PolylineEntity };

    Type type = Line;

    // Line: uses p1, p2.
    // Arc:  uses center, radius, startAngle, endAngle (radians), ccw.
    // Circle: uses center, radius.
    // PolylineEntity: uses polyline.
    Point p1;
    Point p2;
    Point center;
    double radius = 0.0;
    double startAngle = 0.0;   // radians
    double endAngle = 0.0;     // radians
    bool ccw = true;

    Polyline polyline;

    QString layer;

    // ---- Factories --------------------------------------------------------
    static Entity makeLine(const Point &a, const Point &b, const QString &layer = QString());
    static Entity makeArc(const Point &center, double radius,
                          double startAngle, double endAngle, bool ccw = true,
                          const QString &layer = QString());
    static Entity makeCircle(const Point &center, double radius,
                             const QString &layer = QString());
    static Entity makePolyline(const Polyline &pl, const QString &layer = QString());

    Polyline flatten(double tol = kDefaultArcTolerance) const;
    BBox bounds(double tol = kDefaultArcTolerance) const;
    bool isClosed() const;
};

// A CAD document: a flat list of entities plus the layers seen.
class Drawing
{
public:
    QVector<Entity> entities;

    void add(const Entity &e) { entities.append(e); }
    int size() const { return entities.size(); }
    bool isEmpty() const { return entities.isEmpty(); }
    void clear() { entities.clear(); }

    BBox bounds(double tol = kDefaultArcTolerance) const;

    // Flatten every entity to a polyline (one per entity).
    QVector<Polyline> flatten(double tol = kDefaultArcTolerance) const;

    // List of distinct layer names, in first-seen order.
    QStringList layers() const;
};

} // namespace cadcam

#endif // CADCAM_ENTITY_H
