// This file is a part of "Candle" application (hjLabs.in fork).
// Wood-carving CAM operations: profile / pocket / engrave — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_CAMOPERATIONS_H
#define CADCAM_CAMOPERATIONS_H

#include "geometry.h"
#include "toolpath.h"

#include <QVector>

namespace cadcam {

// Which side of a closed contour the tool runs on.
enum class ProfileSide {
    On,       // follow the contour centreline (engrave-on-line)
    Inside,   // offset inward by the tool radius
    Outside   // offset outward by the tool radius
};

// Shared cutting parameters for a single CAM operation.
struct CamParams
{
    Tool tool;
    double safeZ = 5.0;        // retract height above the stock (mm)
    double surfaceZ = 0.0;     // top surface of the stock (mm)
    double cutDepth = 1.0;     // total depth to remove, >= 0; floor = surfaceZ - cutDepth
    // Depth per pass comes from tool.stepdown; <= 0 means a single full-depth pass.
};

// Compute the descending list of Z levels for multi-pass cutting. The final
// level always equals the floor (surfaceZ - cutDepth).
QVector<double> depthLevels(const CamParams &p);

// Follow each polyline (open or closed) with the tool centre on the path.
Toolpath engrave(const QVector<Polyline> &paths, const CamParams &p);
Toolpath engrave(const Polyline &path, const CamParams &p);

// Profile a closed contour on/inside/outside, with multi-depth passes.
// Falls back to engrave (follow) when the contour is not closed.
Toolpath profile(const Polyline &contour, ProfileSide side, const CamParams &p);

// Area-clear a closed boundary with concentric offset rings, multi-depth.
Toolpath pocket(const Polyline &boundary, const CamParams &p);

} // namespace cadcam

#endif // CADCAM_CAMOPERATIONS_H
