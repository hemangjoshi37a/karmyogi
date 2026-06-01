// This file is a part of "Candle" application (hjLabs.in fork).
// Minimal DXF (ASCII) importer for the CAD/CAM core — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_DXFIMPORTER_H
#define CADCAM_DXFIMPORTER_H

#include "entity.h"

#include <QString>
#include <QStringList>

namespace cadcam {

// Reads a subset of the ASCII DXF format sufficient for 2.5D carving/engraving:
//   LINE, CIRCLE, ARC, LWPOLYLINE (with bulges), POLYLINE/VERTEX/SEQEND.
// TEXT/MTEXT and SPLINE are reported as warnings and skipped (TODO: stroke-font
// text + spline tessellation). The importer is tolerant of unknown groups.
class DxfImporter
{
public:
    DxfImporter() = default;

    bool importFile(const QString &path, Drawing &out, QString *error = nullptr);
    bool importString(const QString &content, Drawing &out, QString *error = nullptr);

    // Non-fatal notes collected during the last import (e.g. skipped entities).
    const QStringList &warnings() const { return m_warnings; }

private:
    QStringList m_warnings;
};

} // namespace cadcam

#endif // CADCAM_DXFIMPORTER_H
