// This file is a part of "Candle" application (hjLabs.in fork).
// Automatic-soldering G-code generator — UI-independent.
// Copyright 2026 hjLabs.in / Hemang Joshi
//
// Machine model: a soldering iron is mounted at the head and the controller's
// spindle on/off output drives a solder-wire FEEDER motor. Turning the "spindle"
// on (M3 S..) runs the feeder; M5 stops it. The amount of wire fed is controlled
// by how long the feeder runs — a dwell (G4 P<seconds>) between M3 and M5.

#ifndef CADCAM_SOLDERING_H
#define CADCAM_SOLDERING_H

#include <QVector>
#include <QString>

namespace cadcam {

enum class SolderFeedType {
    // Feed wire onto the iron tip while raised, THEN touch the pad to deposit
    // the pre-melted blob.
    PreSolder,
    // Touch the pad FIRST, then feed wire while the tip is in contact.
    TouchDown
};

// One soldering action at an absolute machine location.
struct SolderPoint {
    double x = 0.0;
    double y = 0.0;
    double freeZ = 5.0;                             // raised travel/retract height (mm, absolute)
    double touchZ = -1.0;                           // touch-down height where soldering happens (mm, absolute)
    SolderFeedType type = SolderFeedType::TouchDown;
    double feedSeconds = 0.5;                       // feeder ON time (seconds)
};

struct SolderingParams {
    bool metric = true;            // G21 vs G20
    double safeZ = 5.0;            // travel/retract height between points (mm)
    double feederRPM = 1000.0;     // emitted as the S word when the feeder runs
    double plungeFeed = 100.0;     // touch-down feed rate (mm/min)
    double settleSeconds = 0.0;    // dwell after feeding, before retract (s); 0 = none
    int decimals = 3;
    QString programName = QStringLiteral("hjLabs Auto-Soldering");
};

class SolderingGenerator {
public:
    // Produce a complete, safe G-code program for the given points.
    QString generate(const QVector<SolderPoint> &points,
                     const SolderingParams &params) const;
};

} // namespace cadcam

#endif // CADCAM_SOLDERING_H
