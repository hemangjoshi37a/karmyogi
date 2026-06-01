// This file is a part of "Candle" application (hjLabs.in fork).
// Single-stroke (Hershey "simplex"-style) vector font for pen-plotter writing.
// UI-independent — part of the shared cadcam core.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAM_STROKEFONT_H
#define CADCAM_STROKEFONT_H

#include "geometry.h"

#include <QChar>
#include <QHash>
#include <QString>
#include <QVector>

namespace cadcam {

// A single glyph in EM units: baseline at y=0, +y up, x in [0, advance].
// Cap height is ~0.7 EM. Each stroke is one pen-down polyline (open).
struct Glyph
{
    double advance = 0.6;
    QVector<Polyline> strokes;
};

// A built-in (or JSON-loaded) single-stroke vector font. Coordinates are stored
// in dimensionless EM units; layout() scales them to a requested character
// height in millimetres and produces pen polylines ready for engrave().
class StrokeFont
{
public:
    StrokeFont() = default;

    bool hasGlyph(QChar ch) const;
    const Glyph *glyph(QChar ch) const;     // nullptr if absent
    double capHeight() const { return m_capHeight; }
    QString name() const { return m_name; }

    // Lay out multi-line text into pen polylines, scaled so the cap height maps
    // to charHeightMm. '\n' starts a new line. Origin is the bottom-left of the
    // first (top) line's baseline block; +y is up. lineSpacingFactor multiplies
    // charHeightMm for the baseline-to-baseline distance. letterSpacingMm is
    // extra gap added after each glyph's advance. align: 0 left, 1 centre, 2 right.
    QVector<Polyline> layout(const QString &text, double charHeightMm,
                             double lineSpacingFactor, double letterSpacingMm,
                             int align) const;

    // The embedded public-domain simplex-style font.
    static StrokeFont builtin();

    // Load a custom font file. Format:
    //   { "name":"...", "capHeight":0.7,
    //     "glyphs": { "A": {"advance":0.65,
    //                       "strokes": [ [[x0,y0],[x1,y1],...], ... ] }, ... } }
    // Coordinates in EM units (baseline y=0, +y up). Returns false on error and
    // writes a message to *err if provided. On success the font is replaced.
    bool loadJson(const QString &path, QString *err = nullptr);

private:
    QString m_name = QStringLiteral("Built-in");
    double m_capHeight = 0.7;
    QHash<ushort, Glyph> m_glyphs;   // keyed by QChar::unicode()
};

} // namespace cadcam

#endif // CADCAM_STROKEFONT_H
