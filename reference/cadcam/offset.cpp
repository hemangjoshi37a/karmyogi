// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "offset.h"

#include <algorithm>
#include <cmath>

namespace cadcam {

namespace {

// Intersection of two infinite lines: line A through a0 with direction da,
// line B through b0 with direction db. Returns false when (near) parallel.
bool lineIntersect(const Point &a0, const QPointF &da,
                   const Point &b0, const QPointF &db, Point &out)
{
    double denom = da.x() * db.y() - da.y() * db.x();
    if (std::fabs(denom) < 1e-12)
        return false;
    QPointF diff = b0 - a0;
    double t = (diff.x() * db.y() - diff.y() * db.x()) / denom;
    out = a0 + da * t;
    return true;
}

// Remove consecutive duplicate vertices (within kEpsilon).
Polyline dedupe(const Polyline &in)
{
    Polyline out;
    out.closed = in.closed;
    for (const Point &p : in.points) {
        if (out.points.isEmpty() || distance(out.points.last(), p) > kEpsilon)
            out.points.append(p);
    }
    // Drop a closing duplicate vertex.
    if (out.points.size() > 1 &&
        distance(out.points.first(), out.points.last()) <= kEpsilon)
        out.points.removeLast();
    return out;
}

} // namespace

Polyline offsetPolygon(const Polyline &poly, double delta)
{
    Polyline in = dedupe(poly);
    int n = in.points.size();
    if (n < 3)
        return Polyline();

    // Normalise to CCW so a right-hand normal points outward and +delta grows.
    if (in.signedArea() < 0.0)
        in.reverse();
    n = in.points.size();

    // Per-edge offset line: base point + unit direction.
    QVector<Point> base(n);
    QVector<QPointF> dir(n);
    for (int i = 0; i < n; ++i) {
        const Point &p0 = in.points[i];
        const Point &p1 = in.points[(i + 1) % n];
        QPointF d = p1 - p0;
        double len = std::sqrt(d.x() * d.x() + d.y() * d.y());
        if (len < kEpsilon) {
            dir[i] = QPointF(1, 0);
            base[i] = p0;
            continue;
        }
        d /= len;
        dir[i] = d;
        // Right-hand normal (dy, -dx) points outward for a CCW polygon.
        QPointF rn(d.y(), -d.x());
        base[i] = p0 + rn * delta;
    }

    Polyline out;
    out.closed = true;
    for (int i = 0; i < n; ++i) {
        int prev = (i - 1 + n) % n;
        Point ip;
        if (lineIntersect(base[prev], dir[prev], base[i], dir[i], ip))
            out.points.append(ip);
        else
            out.points.append(base[i]); // parallel edges: keep shifted start
    }

    return out;
}

QVector<Polyline> insetRings(const Polyline &poly, double firstOffset, double step)
{
    QVector<Polyline> rings;
    if (poly.points.size() < 3 || step <= 0.0 || firstOffset <= 0.0)
        return rings;

    BBox bb = poly.bounds();
    double maxInset = 0.5 * std::min(bb.width(), bb.height());

    double refArea = std::fabs(poly.signedArea());
    if (refArea < kEpsilon)
        return rings;

    const int cap = 100000;
    for (int k = 0; k < cap; ++k) {
        double inset = firstOffset + k * step;
        if (inset > maxInset + step) // allow one ring past centre, then stop
            break;
        Polyline ring = offsetPolygon(poly, -inset);
        if (ring.points.size() < 3)
            break;
        double area = ring.signedArea();
        // Collapse detection: area vanished or winding flipped (self-overlap).
        if (std::fabs(area) < 1e-6 || area < 0.0)
            break;
        if (std::fabs(area) > refArea) // sanity: inset must not grow area
            break;
        rings.append(ring);
    }
    return rings;
}

} // namespace cadcam
