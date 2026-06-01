// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "geometry.h"

#include <QtMath>
#include <algorithm>
#include <cmath>

namespace cadcam {

// ---- BBox -----------------------------------------------------------------

void BBox::expand(const Point &p)
{
    if (!valid) {
        min = p;
        max = p;
        valid = true;
        return;
    }
    if (p.x() < min.x()) min.setX(p.x());
    if (p.y() < min.y()) min.setY(p.y());
    if (p.x() > max.x()) max.setX(p.x());
    if (p.y() > max.y()) max.setY(p.y());
}

void BBox::expand(const BBox &other)
{
    if (!other.valid) return;
    expand(other.min);
    expand(other.max);
}

Point BBox::center() const
{
    if (!valid) return Point(0, 0);
    return Point((min.x() + max.x()) / 2.0, (min.y() + max.y()) / 2.0);
}

// ---- Polyline -------------------------------------------------------------

void Polyline::add(const Point &p)
{
    points.append(p);
}

void Polyline::addUnique(const Point &p, double tol)
{
    if (!points.isEmpty() && distance(points.last(), p) <= tol) return;
    points.append(p);
}

void Polyline::addArc(const Point &center, double radius,
                      double startAngle, double endAngle, bool ccw, double tol)
{
    // Normalise the swept angle to the correct direction.
    double sweep = endAngle - startAngle;
    if (ccw) {
        while (sweep <= 0) sweep += 2.0 * M_PI;
        while (sweep > 2.0 * M_PI) sweep -= 2.0 * M_PI;
    } else {
        while (sweep >= 0) sweep -= 2.0 * M_PI;
        while (sweep < -2.0 * M_PI) sweep += 2.0 * M_PI;
    }

    // Number of segments so chord error <= tol.
    int segments = 1;
    if (radius > tol && tol > 0.0) {
        double maxStep = 2.0 * std::acos(std::max(0.0, 1.0 - tol / radius));
        if (maxStep > kEpsilon)
            segments = std::max(1, (int)std::ceil(std::fabs(sweep) / maxStep));
    }
    segments = std::max(segments, 2);

    for (int i = 0; i <= segments; ++i) {
        double a = startAngle + sweep * (double(i) / segments);
        Point p(center.x() + radius * std::cos(a),
                center.y() + radius * std::sin(a));
        addUnique(p);
    }
}

double Polyline::length() const
{
    if (points.size() < 2) return 0.0;
    double total = 0.0;
    for (int i = 1; i < points.size(); ++i)
        total += distance(points[i - 1], points[i]);
    if (closed)
        total += distance(points.last(), points.first());
    return total;
}

double Polyline::signedArea() const
{
    if (points.size() < 3) return 0.0;
    double area = 0.0;
    int n = points.size();
    for (int i = 0; i < n; ++i) {
        const Point &a = points[i];
        const Point &b = points[(i + 1) % n];
        area += (a.x() * b.y() - b.x() * a.y());
    }
    return area / 2.0;
}

bool Polyline::isClockwise() const
{
    return signedArea() < 0.0;
}

void Polyline::reverse()
{
    std::reverse(points.begin(), points.end());
}

void Polyline::makeClockwise(bool cw)
{
    if (isClockwise() != cw)
        reverse();
}

BBox Polyline::bounds() const
{
    BBox b;
    for (const Point &p : points)
        b.expand(p);
    return b;
}

// ---- Construction helpers -------------------------------------------------

Polyline makeArcPolyline(const Point &center, double radius,
                         double startAngle, double endAngle, bool ccw, double tol)
{
    Polyline pl;
    pl.addArc(center, radius, startAngle, endAngle, ccw, tol);
    return pl;
}

Polyline makeCircle(const Point &center, double radius, double tol)
{
    Polyline pl;
    pl.addArc(center, radius, 0.0, 2.0 * M_PI, true, tol);
    // Drop the duplicate closing vertex; mark closed instead.
    if (pl.points.size() > 1 &&
        distance(pl.points.first(), pl.points.last()) <= kEpsilon)
        pl.points.removeLast();
    pl.closed = true;
    return pl;
}

Polyline makeRect(const Point &corner, double width, double height)
{
    Polyline pl;
    pl.add(corner);
    pl.add(Point(corner.x() + width, corner.y()));
    pl.add(Point(corner.x() + width, corner.y() + height));
    pl.add(Point(corner.x(), corner.y() + height));
    pl.closed = true;
    return pl;
}

// ---- Predicates / utilities ----------------------------------------------

double distance(const Point &a, const Point &b)
{
    return std::sqrt(distanceSquared(a, b));
}

double distanceSquared(const Point &a, const Point &b)
{
    double dx = a.x() - b.x();
    double dy = a.y() - b.y();
    return dx * dx + dy * dy;
}

double distancePointToSegment(const Point &p, const Point &a, const Point &b)
{
    double dx = b.x() - a.x();
    double dy = b.y() - a.y();
    double len2 = dx * dx + dy * dy;
    if (len2 <= kEpsilon)
        return distance(p, a);
    double t = ((p.x() - a.x()) * dx + (p.y() - a.y()) * dy) / len2;
    t = std::max(0.0, std::min(1.0, t));
    Point proj(a.x() + t * dx, a.y() + t * dy);
    return distance(p, proj);
}

bool pointInPolygon(const Polyline &poly, const Point &p)
{
    int n = poly.points.size();
    if (n < 3) return false;
    bool inside = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        const Point &pi = poly.points[i];
        const Point &pj = poly.points[j];
        bool crosses = ((pi.y() > p.y()) != (pj.y() > p.y()));
        if (crosses) {
            double xCross = (pj.x() - pi.x()) * (p.y() - pi.y()) /
                                (pj.y() - pi.y()) + pi.x();
            if (p.x() < xCross)
                inside = !inside;
        }
    }
    return inside;
}

void appendBulgeArc(Polyline &out, const Point &p0, const Point &p1,
                    double bulge, double tol)
{
    if (std::fabs(bulge) < kEpsilon) {
        out.addUnique(p1);
        return;
    }

    // bulge = tan(theta/4); theta is the included angle (signed: +CCW, -CW).
    double theta = 4.0 * std::atan(bulge);
    double chord = distance(p0, p1);
    if (chord < kEpsilon) {
        out.addUnique(p1);
        return;
    }

    double radius = chord / (2.0 * std::sin(std::fabs(theta) / 2.0));

    // Midpoint of the chord and the perpendicular direction to the centre.
    Point mid((p0.x() + p1.x()) / 2.0, (p0.y() + p1.y()) / 2.0);
    double dx = p1.x() - p0.x();
    double dy = p1.y() - p0.y();
    double dist = std::sqrt(dx * dx + dy * dy);
    // Apothem (centre offset from chord midpoint).
    double h = radius * std::cos(std::fabs(theta) / 2.0);
    // Perpendicular unit vector; sign chooses which side the centre sits on.
    double sign = (theta > 0) ? 1.0 : -1.0;
    double nx = -dy / dist;
    double ny = dx / dist;
    Point center(mid.x() + sign * h * nx, mid.y() + sign * h * ny);

    double a0 = std::atan2(p0.y() - center.y(), p0.x() - center.x());
    double a1 = std::atan2(p1.y() - center.y(), p1.x() - center.x());

    bool ccw = theta > 0;
    // addArc appends starting vertex too; we already have p0, so add from after.
    Polyline tmp;
    tmp.addArc(center, radius, a0, a1, ccw, tol);
    for (int i = 1; i < tmp.points.size(); ++i)
        out.addUnique(tmp.points[i]);
    // Guarantee the exact end vertex.
    out.addUnique(p1);
}

} // namespace cadcam
