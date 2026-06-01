// This file is a part of "Candle" application (hjLabs.in fork).
// Minimal Excellon drill-file importer for the PCB CAM core — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_EXCELLONIMPORTER_H
#define CADCAM_EXCELLONIMPORTER_H

#include "geometry.h"

#include <QString>
#include <QStringList>
#include <QVector>

namespace cadcam {

// A single drilled hole.
struct DrillHit
{
    Point pos;
    double diameter = 0.0;   // mm
};

// All hits parsed from an Excellon file.
struct ExcellonData
{
    QVector<DrillHit> hits;

    bool isEmpty() const { return hits.isEmpty(); }
    BBox bounds() const;          // over hit centres (mm)
    QVector<double> toolDiameters() const;  // distinct, ascending
};

// Reads a useful subset of the Excellon drill format:
//   header tool defs   Tnn C<diam>      (e.g. T1C0.80)
//   units              METRIC / INCH  or  M71 / M72
//   format             optionally from METRIC,LZ/TZ ; defaults 2.4(in)/3.3(mm)
//   body               Tnn (select), Xnn Ynn (hit), M30/M00 (end)
// Coordinates may be decimal-pointed (used verbatim) or implied by the format.
class ExcellonImporter
{
public:
    ExcellonImporter() = default;

    bool importFile(const QString &path, ExcellonData &out, QString *error = nullptr);
    bool importString(const QString &content, ExcellonData &out, QString *error = nullptr);

    const QStringList &warnings() const { return m_warnings; }

private:
    QStringList m_warnings;
};

} // namespace cadcam

#endif // CADCAM_EXCELLONIMPORTER_H
