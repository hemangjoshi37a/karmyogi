// This file is a part of "Candle" application (hjLabs.in fork).
// Minimal Gerber RS-274X (ASCII) importer for the PCB CAM core — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_GERBERIMPORTER_H
#define CADCAM_GERBERIMPORTER_H

#include "geometry.h"

#include <QString>
#include <QStringList>
#include <QVector>
#include <QPair>

namespace cadcam {

// Parsed copper geometry from a Gerber file. The model is deliberately simple
// (v1): every D01 draw becomes a centreline `trace` polyline tagged with the
// active aperture width; every D03 flash becomes a closed `pad` polygon
// (circle or rectangle outline at the flash location); G36/G37 regions become
// closed `region` polygons. Curved (G02/G03) interpolation between draws is
// flattened to line segments.
struct GerberData
{
    // (centreline polyline, aperture width in mm)
    QVector<QPair<Polyline, double>> traces;
    // Flashed pads as closed polygons (mm).
    QVector<Polyline> pads;
    // Filled regions (G36/G37) as closed polygons (mm).
    QVector<Polyline> regions;

    bool isEmpty() const { return traces.isEmpty() && pads.isEmpty() && regions.isEmpty(); }

    // Bounding box over all geometry (mm). Pad/trace widths are NOT inflated in.
    BBox bounds() const;
};

// Reads a useful subset of RS-274X:
//   %FSLAX..Y..*%  format spec (leading/trailing zero omission, integer/decimal digits)
//   %MOMM*% / %MOIN*%  units
//   %ADDnnC,diam*%  circular aperture, %ADDnnR,xXy*% rectangular aperture
//   Dnn  aperture select; G01/G02/G03 interpolation; D01 draw / D02 move / D03 flash
//   G36/G37 region (contour) mode; G75/G74 (quadrant); M02 end
// Unsupported features (obround/polygon/macro apertures, step&repeat, LP/LM/LR
// transforms) are noted via warnings() and skipped.
class GerberImporter
{
public:
    GerberImporter() = default;

    bool importFile(const QString &path, GerberData &out, QString *error = nullptr);
    bool importString(const QString &content, GerberData &out, QString *error = nullptr);

    const QStringList &warnings() const { return m_warnings; }

private:
    QStringList m_warnings;
};

} // namespace cadcam

#endif // CADCAM_GERBERIMPORTER_H
