// This file is a part of "Candle" application (hjLabs.in fork).
// PCB CAM: isolation routing, drilling, and board cutout — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_PCBCAM_H
#define CADCAM_PCBCAM_H

#include "geometry.h"
#include "toolpath.h"
#include "gerberimporter.h"
#include "excellonimporter.h"

#include <QVector>

namespace cadcam {

// Isolation-route the copper described by `gerber`.
//
// SIMPLIFICATION (v1): each copper feature is converted to a closed polygon and
// offset OUTWARD by (toolRadius + (pass-1)*stepover) to mill an isolation gap
// around it. Traces (centreline + width) are turned into a closed outline by
// offsetting the centreline polygon on both sides (i.e. inflating by width/2);
// pads/regions are used directly. Each pass produces a feed-following toolpath
// at `cutZ`. This does NOT merge overlapping copper into single nets — features
// are isolated individually, which is correct for boards whose copper is not
// densely overlapping. Swap in Clipper2 union+offset for production robustness.
//   safeZ   retract height (mm), cutZ engraving depth (negative into copper).
//   passes  number of concentric isolation passes (>=1); spacing = tool.stepover (mm).
Toolpath isolationRoutes(const GerberData &gerber, const Tool &tool,
                         double safeZ, double cutZ, int passes);

// Drill every hit: rapid above the hole, plunge to drillZ, retract to safeZ.
// Hits are ordered nearest-neighbour from the origin to reduce travel.
Toolpath drillHits(const ExcellonData &drill, double safeZ, double drillZ,
                   double plungeFeed);

// Profile-cut the board outline on the OUTSIDE, in multiple depth passes down
// to (surface - cutDepthTotal). `outline` should be a closed polygon (mm).
Toolpath boardCutout(const Polyline &outline, const Tool &tool,
                     double safeZ, double cutDepthTotal);

// Helper: convert a (centreline, width) trace into a closed outline polygon by
// inflating the centreline by width/2 (round caps approximated by the offset).
// For a degenerate/zero-width trace the polyline is returned closed as-is.
Polyline traceToOutline(const Polyline &centreline, double width);

} // namespace cadcam

#endif // CADCAM_PCBCAM_H
