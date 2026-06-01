// This file is a part of "Candle" application (hjLabs.in fork).
// Shared CAD/CAM G-code emitter — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_GCODEEMITTER_H
#define CADCAM_GCODEEMITTER_H

#include "toolpath.h"

#include <QVector>
#include <QString>
#include <QStringList>

namespace cadcam {

// How Z is interpreted when emitting. In Spindle mode the toolpath's Z values
// are written verbatim (negative = into the material). In Pen mode the emitter
// ignores cut depth and maps cutting moves to penDownZ and travels to penUpZ,
// so the same toolpaths drive a pen-plotter (Z = pen up/down).
enum class ZMode {
    Spindle,
    Pen
};

// Output policy for the emitter. Defaults are conservative and safe.
struct EmitterOptions
{
    QString programName;          // emitted as a leading comment if set

    bool metric = true;           // G21 (mm) vs G20 (inch)
    bool absolute = true;         // G90 vs G91 (only G90 is fully supported)

    double safeZ = 5.0;           // guaranteed retract height (mm)
    double feedXY = 600.0;        // cutting feed (mm/min)
    double feedZ = 200.0;         // plunge feed (mm/min)

    bool useSpindle = true;       // emit M3/M5 with spindleRPM
    double spindleRPM = 10000.0;
    double spindleDwell = 0.0;    // seconds to dwell (G4 P..) after M3; 0 = none

    ZMode zMode = ZMode::Spindle;
    double penUpZ = 5.0;          // pen mode: travel height
    double penDownZ = 0.0;        // pen mode: drawing height

    int decimals = 3;             // coordinate precision
    bool lineNumbers = false;     // prefix N10, N20, ...
    int lineNumberStep = 10;
    bool comments = true;         // include explanatory comments
};

class GcodeEmitter
{
public:
    explicit GcodeEmitter(const EmitterOptions &options = EmitterOptions());

    const EmitterOptions &options() const { return m_opt; }
    void setOptions(const EmitterOptions &options) { m_opt = options; }

    // Emit a complete, self-contained G-code program for the given toolpaths.
    QString emitProgram(const QVector<Toolpath> &paths) const;
    QString emitProgram(const Toolpath &path) const;

private:
    EmitterOptions m_opt;

    QString fmt(double value) const;                 // formatted number, no "-0"
    QString axisWord(QChar axis, double value) const;
    void emitMove(QStringList &out, const ToolpathMove &move,
                  bool &hasLast, QVector3D &last, int &lastG, double &lastFeed,
                  int &lineNo) const;
    void addLine(QStringList &out, const QString &code, int &lineNo) const;
    double mapZ(const ToolpathMove &move) const;
};

} // namespace cadcam

#endif // CADCAM_GCODEEMITTER_H
