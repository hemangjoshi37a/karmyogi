// This file is a part of "Candle" application (hjLabs.in fork).
// Shared CAD/CAM geometry core — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_GEOMETRY_H
#define CADCAM_GEOMETRY_H

#include <QPointF>
#include <QVector>
#include <QString>

namespace cadcam {

// Default chord tolerance (mm) used when flattening arcs/circles to polylines.
constexpr double kDefaultArcTolerance = 0.05;
// Generic geometric epsilon (mm).
constexpr double kEpsilon = 1e-9;

using Point = QPointF;

// Axis-aligned 2D bounding box. Starts invalid; expand() grows it.
struct BBox
{
    Point min;
    Point max;
    bool valid = false;

    void expand(const Point &p);
    void expand(const BBox &other);

    double width() const { return valid ? (max.x() - min.x()) : 0.0; }
    double height() const { return valid ? (max.y() - min.y()) : 0.0; }
    Point center() const;
    bool isValid() const { return valid; }
};

// A connected chain of vertices. Closed polylines represent polygons.
// Arcs are represented by flattening into vertices via add* helpers.
class Polyline
{
public:
    Polyline() = default;

    QVector<Point> points;
    bool closed = false;

    int size() const { return points.size(); }
    bool isEmpty() const { return points.isEmpty(); }
    void clear() { points.clear(); closed = false; }

    void add(const Point &p);
    void addUnique(const Point &p, double tol = kEpsilon);

    // Append an arc (center, radius, start/end angle in radians) approximated
    // by line segments not deviating from the true arc by more than `tol`.
    // The arc's first point is added unless it coincides with the last vertex.
    void addArc(const Point &center, double radius,
                double startAngle, double endAngle, bool ccw,
                double tol = kDefaultArcTolerance);

    double length() const;        // total path length (includes closing edge if closed)
    double signedArea() const;    // >0 CCW, <0 CW; meaningful only when closed
    bool isClockwise() const;     // signedArea() < 0
    void reverse();
    void makeClockwise(bool cw);  // force orientation
    BBox bounds() const;
};

// ---- Free construction helpers -------------------------------------------

Polyline makeCircle(const Point &center, double radius,
                    double tol = kDefaultArcTolerance);
Polyline makeArcPolyline(const Point &center, double radius,
                         double startAngle, double endAngle, bool ccw,
                         double tol = kDefaultArcTolerance);
Polyline makeRect(const Point &corner, double width, double height);

// ---- Geometric predicates / utilities ------------------------------------

double distance(const Point &a, const Point &b);
double distanceSquared(const Point &a, const Point &b);
double distancePointToSegment(const Point &p, const Point &a, const Point &b);

// Even-odd ray-cast test. Treats the polyline as closed regardless of flag.
bool pointInPolygon(const Polyline &poly, const Point &p);

// Convert a DXF "bulge" value between two vertices into an arc and append the
// flattened points (excluding p0, including p1) to `out`. bulge==0 -> straight.
void appendBulgeArc(Polyline &out, const Point &p0, const Point &p1,
                    double bulge, double tol = kDefaultArcTolerance);

} // namespace cadcam

#endif // CADCAM_GEOMETRY_H
