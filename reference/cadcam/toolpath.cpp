// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "toolpath.h"

#include <cmath>

namespace cadcam {

BBox Toolpath::bounds2D() const
{
    BBox b;
    for (const ToolpathMove &m : moves)
        b.expand(Point(m.target.x(), m.target.y()));
    return b;
}

void Toolpath::zRange(double &zMin, double &zMax) const
{
    if (moves.isEmpty()) {
        zMin = zMax = 0.0;
        return;
    }
    zMin = zMax = moves.first().target.z();
    for (const ToolpathMove &m : moves) {
        double z = m.target.z();
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
    }
}

double Toolpath::cutLength() const
{
    double total = 0.0;
    for (int i = 1; i < moves.size(); ++i) {
        if (moves[i].type == MoveType::Feed || moves[i].type == MoveType::Plunge)
            total += (moves[i].target - moves[i - 1].target).length();
    }
    return total;
}

double Toolpath::rapidLength() const
{
    double total = 0.0;
    for (int i = 1; i < moves.size(); ++i) {
        if (moves[i].type == MoveType::Rapid)
            total += (moves[i].target - moves[i - 1].target).length();
    }
    return total;
}

} // namespace cadcam
