// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "camoperations.h"
#include "offset.h"

#include <algorithm>
#include <cmath>

namespace cadcam {

namespace {

// Append a single closed/open loop cut at depth z, retracting to safeZ after.
// Assumes the spindle is already running and Z starts at/above safeZ.
void cutLoop(Toolpath &tp, const Polyline &loop, double z, double safeZ)
{
    if (loop.points.size() < 2)
        return;

    const Point &start = loop.points.first();
    // Position above the entry point, then plunge.
    tp.rapid(QVector3D(start.x(), start.y(), safeZ));
    tp.plunge(QVector3D(start.x(), start.y(), z));

    for (int i = 1; i < loop.points.size(); ++i)
        tp.feed(QVector3D(loop.points[i].x(), loop.points[i].y(), z));

    if (loop.closed)
        tp.feed(QVector3D(start.x(), start.y(), z));

    const Point &end = loop.closed ? start : loop.points.last();
    tp.rapid(QVector3D(end.x(), end.y(), safeZ)); // retract straight up
}

} // namespace

QVector<double> depthLevels(const CamParams &p)
{
    QVector<double> levels;
    double floorZ = p.surfaceZ - std::fabs(p.cutDepth);

    if (p.tool.stepdown <= 0.0 || std::fabs(p.cutDepth) < kEpsilon) {
        levels.append(floorZ);
        return levels;
    }

    double z = p.surfaceZ - p.tool.stepdown;
    while (z > floorZ + kEpsilon) {
        levels.append(z);
        z -= p.tool.stepdown;
    }
    levels.append(floorZ); // guarantee we reach the exact floor
    return levels;
}

Toolpath engrave(const Polyline &path, const CamParams &p)
{
    QVector<Polyline> v;
    v.append(path);
    return engrave(v, p);
}

Toolpath engrave(const QVector<Polyline> &paths, const CamParams &p)
{
    Toolpath tp;
    tp.name = QStringLiteral("Engrave");
    const QVector<double> levels = depthLevels(p);

    for (double z : levels) {
        for (const Polyline &path : paths) {
            if (path.points.size() >= 2)
                cutLoop(tp, path, z, p.safeZ);
        }
    }
    return tp;
}

Toolpath profile(const Polyline &contour, ProfileSide side, const CamParams &p)
{
    Toolpath tp;
    tp.name = QStringLiteral("Profile");

    // Open contours can't have a meaningful inside/outside — just follow them.
    if (!contour.closed || contour.points.size() < 3) {
        tp.name = QStringLiteral("Profile (follow)");
        const QVector<double> levels = depthLevels(p);
        for (double z : levels)
            cutLoop(tp, contour, z, p.safeZ);
        return tp;
    }

    Polyline path;
    switch (side) {
    case ProfileSide::On:
        path = contour;
        path.closed = true;
        break;
    case ProfileSide::Outside:
        path = offsetPolygon(contour, +p.tool.radius());
        break;
    case ProfileSide::Inside:
        path = offsetPolygon(contour, -p.tool.radius());
        break;
    }

    if (path.points.size() < 3)
        return tp; // offset collapsed (tool too big for an inside profile)

    path.closed = true;
    const QVector<double> levels = depthLevels(p);
    for (double z : levels)
        cutLoop(tp, path, z, p.safeZ);
    return tp;
}

Toolpath pocket(const Polyline &boundary, const CamParams &p)
{
    Toolpath tp;
    tp.name = QStringLiteral("Pocket");

    if (!boundary.closed || boundary.points.size() < 3)
        return tp;

    double step = std::max(kEpsilon, p.tool.stepover) * p.tool.diameter;
    QVector<Polyline> rings = insetRings(boundary, p.tool.radius(), step);
    if (rings.isEmpty())
        return tp;

    const QVector<double> levels = depthLevels(p);
    for (double z : levels) {
        for (Polyline ring : rings) {
            ring.closed = true;
            cutLoop(tp, ring, z, p.safeZ);
        }
    }
    return tp;
}

} // namespace cadcam
