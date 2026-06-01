// This file is a part of "Candle" application (hjLabs.in fork).
// Polygon offsetting for CAM (profile / pocket / isolation).
// Copyright 2026 hjLabs.in / Hemang Joshi
//
// NOTE: This is a pragmatic v1 miter-offset that is exact for convex polygons
// and correct for simple (non-self-intersecting) concave polygons. It does not
// perform self-intersection removal. For production-grade robustness on complex
// copper pours / nested pockets, swap in Clipper2 (via vcpkg) behind this API.

#ifndef CADCAM_OFFSET_H
#define CADCAM_OFFSET_H

#include "geometry.h"

#include <QVector>

namespace cadcam {

// Offset a closed polygon by `delta`. Positive delta grows the polygon outward,
// negative shrinks it inward (regardless of the input winding order). Returns an
// empty polyline if the result collapses (|delta| too large for an inward offset).
Polyline offsetPolygon(const Polyline &poly, double delta);

// Successive inward offsets at `step` spacing, starting at `firstOffset` inside
// the boundary, until the region collapses. Used for area-clearing (pocketing).
// Each returned ring is a closed polyline; outermost first.
QVector<Polyline> insetRings(const Polyline &poly, double firstOffset, double step);

} // namespace cadcam

#endif // CADCAM_OFFSET_H
