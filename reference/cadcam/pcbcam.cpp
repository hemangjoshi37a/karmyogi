// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "pcbcam.h"
#include "offset.h"
#include "camoperations.h"

#include <QSet>

#include <algorithm>
#include <cmath>
#include <limits>

namespace cadcam {

namespace {

// Append a closed/open loop cut at depth z, retracting to safeZ after.
void cutLoop(Toolpath &tp, const Polyline &loop, double z, double safeZ)
{
    if (loop.points.size() < 2)
        return;

    const Point &start = loop.points.first();
    tp.rapid(QVector3D(start.x(), start.y(), safeZ));
    tp.plunge(QVector3D(start.x(), start.y(), z));

    for (int i = 1; i < loop.points.size(); ++i)
        tp.feed(QVector3D(loop.points[i].x(), loop.points[i].y(), z));

    if (loop.closed)
        tp.feed(QVector3D(start.x(), start.y(), z));

    const Point &end = loop.closed ? start : loop.points.last();
    tp.rapid(QVector3D(end.x(), end.y(), safeZ));
}

} // namespace

Polyline traceToOutline(const Polyline &centreline, double width)
{
    // v1 simplification: build the convex-ish hull of the inflated centreline by
    // offsetting it as a (closed) polygon by +width/2. For an open trace we first
    // close it (out-and-back) so the offsetter sees a thin slab around the path.
    if (centreline.points.size() < 2 || width <= kEpsilon) {
        Polyline c = centreline;
        c.closed = true;
        return c;
    }

    // Construct a degenerate closed polygon that traces the centreline forward
    // and back, then offset it outward by width/2 to produce the copper outline.
    Polyline slab;
    for (const Point &p : centreline.points)
        slab.add(p);
    for (int i = centreline.points.size() - 2; i >= 0; --i)
        slab.add(centreline.points[i]);
    slab.closed = true;

    Polyline outline = offsetPolygon(slab, width / 2.0);
    if (outline.points.size() < 3) {
        slab.closed = true;
        return slab;
    }
    outline.closed = true;
    return outline;
}

Toolpath isolationRoutes(const GerberData &gerber, const Tool &tool,
                         double safeZ, double cutZ, int passes)
{
    Toolpath tp;
    tp.name = QStringLiteral("Isolation");
    if (passes < 1) passes = 1;

    const double r = tool.radius();
    // stepover stored as fraction in Tool; for isolation we want a metric step.
    double step = tool.stepover;
    if (step <= 0.0) step = tool.diameter * 0.5;
    if (step <= 1.0) step = step * tool.diameter; // treat <=1 as a fraction

    // Collect every copper feature as a closed polygon to isolate.
    QVector<Polyline> features;
    for (const auto &t : gerber.traces) {
        Polyline o = traceToOutline(t.first, t.second);
        if (o.points.size() >= 3) features.append(o);
    }
    for (const Polyline &pad : gerber.pads)
        if (pad.points.size() >= 3) { Polyline p = pad; p.closed = true; features.append(p); }
    for (const Polyline &reg : gerber.regions)
        if (reg.points.size() >= 3) { Polyline p = reg; p.closed = true; features.append(p); }

    for (const Polyline &feat : features) {
        for (int pass = 0; pass < passes; ++pass) {
            double delta = r + pass * step;          // outward isolation ring
            Polyline ring = offsetPolygon(feat, +delta);
            if (ring.points.size() < 3) continue;
            ring.closed = true;
            cutLoop(tp, ring, cutZ, safeZ);
        }
    }
    return tp;
}

Toolpath drillHits(const ExcellonData &drill, double safeZ, double drillZ,
                   double /*plungeFeed*/)
{
    Toolpath tp;
    tp.name = QStringLiteral("Drill");
    if (drill.hits.isEmpty())
        return tp;

    // Nearest-neighbour ordering from the origin to reduce rapid travel. (Feed
    // rates are applied by the emitter from EmitterOptions; the move types here
    // mark plunges so the emitter uses feedZ for them.)
    const int n = drill.hits.size();
    QVector<bool> used(n, false);
    Point cur(0.0, 0.0);

    for (int k = 0; k < n; ++k) {
        int best = -1;
        double bestD = std::numeric_limits<double>::max();
        for (int j = 0; j < n; ++j) {
            if (used[j]) continue;
            double d = distanceSquared(cur, drill.hits[j].pos);
            if (d < bestD) { bestD = d; best = j; }
        }
        if (best < 0) break;
        used[best] = true;
        const DrillHit &h = drill.hits[best];
        tp.rapid(QVector3D(h.pos.x(), h.pos.y(), safeZ));
        tp.plunge(QVector3D(h.pos.x(), h.pos.y(), drillZ));
        tp.rapid(QVector3D(h.pos.x(), h.pos.y(), safeZ));
        cur = h.pos;
    }
    return tp;
}

Toolpath boardCutout(const Polyline &outline, const Tool &tool,
                     double safeZ, double cutDepthTotal)
{
    Toolpath tp;
    tp.name = QStringLiteral("Cutout");
    if (outline.points.size() < 3)
        return tp;

    Polyline closed = outline;
    closed.closed = true;

    // Profile OUTSIDE: offset outward by the tool radius so the finished board
    // keeps its nominal dimensions.
    Polyline path = offsetPolygon(closed, +tool.radius());
    if (path.points.size() < 3) {
        path = closed; // offset collapsed — fall back to on-line
    }
    path.closed = true;

    // Multi-depth descent using the tool's stepdown.
    double floorZ = -std::fabs(cutDepthTotal);
    double stepdown = tool.stepdown > 0.0 ? tool.stepdown : std::fabs(cutDepthTotal);

    QVector<double> levels;
    double z = -stepdown;
    while (z > floorZ + kEpsilon) { levels.append(z); z -= stepdown; }
    levels.append(floorZ);

    for (double lz : levels)
        cutLoop(tp, path, lz, safeZ);

    return tp;
}

} // namespace cadcam
