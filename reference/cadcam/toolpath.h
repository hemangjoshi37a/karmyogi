// This file is a part of "Candle" application (hjLabs.in fork).
// Shared CAD/CAM toolpath model — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_TOOLPATH_H
#define CADCAM_TOOLPATH_H

#include "geometry.h"

#include <QVector3D>
#include <QVector>
#include <QString>

namespace cadcam {

// Cutting tool / pen description. Feeds are mm/min.
struct Tool
{
    QString name = QStringLiteral("Default");
    double diameter = 3.175;     // mm (1/8")
    double feedXY = 600.0;       // cutting feed
    double feedZ = 200.0;        // plunge feed
    double spindleRPM = 10000.0;
    double stepover = 0.5;       // fraction of diameter (0..1) for pocketing
    double stepdown = 1.0;       // mm per depth pass

    double radius() const { return diameter / 2.0; }
};

enum class MoveType {
    Rapid,   // G0 — non-cutting positioning at travel height
    Feed,    // G1 — cutting move in XY (and Z)
    Plunge   // G1 — vertical entry into material (feedZ)
};

struct ToolpathMove
{
    QVector3D target;     // absolute target (mm)
    MoveType type = MoveType::Rapid;

    ToolpathMove() = default;
    ToolpathMove(const QVector3D &t, MoveType mt) : target(t), type(mt) {}
};

// An ordered sequence of moves produced by a CAM operation. A toolpath does
// not embed safe-Z / units policy — that belongs to the emitter. It does carry
// the moves at their intended Z depths plus retract moves between passes.
class Toolpath
{
public:
    QString name;
    QVector<ToolpathMove> moves;

    bool isEmpty() const { return moves.isEmpty(); }
    int size() const { return moves.size(); }
    void clear() { moves.clear(); }

    void rapid(const QVector3D &p) { moves.append({p, MoveType::Rapid}); }
    void rapidXY(double x, double y, double z) { rapid(QVector3D(x, y, z)); }
    void feed(const QVector3D &p) { moves.append({p, MoveType::Feed}); }
    void plunge(const QVector3D &p) { moves.append({p, MoveType::Plunge}); }
    void append(const ToolpathMove &m) { moves.append(m); }

    // 2D bounds across all move targets.
    BBox bounds2D() const;
    // Min/max Z over all moves (returns {0,0} when empty).
    void zRange(double &zMin, double &zMax) const;

    // Total cut (Feed+Plunge) distance — handy for time estimation/tests.
    double cutLength() const;
    // Total rapid distance.
    double rapidLength() const;
};

} // namespace cadcam

#endif // CADCAM_TOOLPATH_H
