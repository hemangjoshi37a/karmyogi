// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "excellonimporter.h"

#include <QFile>
#include <QTextStream>
#include <QRegularExpression>
#include <QHash>

#include <algorithm>
#include <cmath>

namespace cadcam {

BBox ExcellonData::bounds() const
{
    BBox b;
    for (const DrillHit &h : hits)
        b.expand(h.pos);
    return b;
}

QVector<double> ExcellonData::toolDiameters() const
{
    QVector<double> d;
    for (const DrillHit &h : hits)
        if (!d.contains(h.diameter)) d.append(h.diameter);
    std::sort(d.begin(), d.end());
    return d;
}

bool ExcellonImporter::importFile(const QString &path, ExcellonData &out, QString *error)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        if (error) *error = QStringLiteral("Cannot open file: %1").arg(path);
        return false;
    }
    QTextStream ts(&f);
    return importString(ts.readAll(), out, error);
}

bool ExcellonImporter::importString(const QString &content, ExcellonData &out, QString *error)
{
    m_warnings.clear();
    out = ExcellonData();

    bool metric = true;          // default; refined by METRIC/INCH/M71/M72
    bool unitsSeen = false;
    bool inHeader = false;
    bool leadingZeroOmitted = true;  // LZ means leading zeros present; we track omission

    // Implied-decimal format (used only when a coordinate has no '.').
    int decDigits = 4;           // 2.4 inch default; switched to 3.3 for metric

    QHash<int, double> toolDia;  // tool number -> diameter (mm)
    int currentTool = -1;

    double curX = 0.0, curY = 0.0;

    QRegularExpression reToolDef(QStringLiteral("^T(\\d+)(?:F[\\d.]+)?(?:S[\\d.]+)?C([\\d.]+)"));
    QRegularExpression reToolSel(QStringLiteral("^T(\\d+)$"));
    QRegularExpression reCoord(QStringLiteral("X([+-]?[\\d.]+)?Y?([+-]?[\\d.]+)?"));

    auto decodeCoord = [&](const QString &s) -> double {
        if (s.isEmpty()) return 0.0;
        bool neg = s.startsWith('-');
        QString t = s;
        if (neg || t.startsWith('+')) t.remove(0, 1);
        double v;
        if (t.contains('.')) {
            v = t.toDouble();
        } else {
            // implied decimal: assume trailing/leading per leadingZeroOmitted
            int total = (metric ? 3 : 2) + decDigits;
            if (leadingZeroOmitted) {
                while (t.length() < total) t.prepend('0');
            } else {
                while (t.length() < total) t.append('0');
            }
            v = t.toDouble() / std::pow(10.0, decDigits);
        }
        if (neg) v = -v;
        return metric ? v : v * 25.4;
    };

    const QStringList lines = content.split(QRegularExpression(QStringLiteral("[\\r\\n]+")),
                                            Qt::SkipEmptyParts);
    for (const QString &rawLine : lines) {
        QString line = rawLine.trimmed();
        if (line.isEmpty() || line.startsWith(';')) continue;

        if (line == QLatin1String("M48")) { inHeader = true; continue; }
        if (line == QLatin1String("%") || line == QLatin1String("M95")) { inHeader = false; continue; }
        if (line.startsWith(QLatin1String("M30")) || line.startsWith(QLatin1String("M00")) ||
            line.startsWith(QLatin1String("M15")) || line.startsWith(QLatin1String("M17")) ||
            line.startsWith(QLatin1String("G05")) || line.startsWith(QLatin1String("G90")))
            continue;

        // Units / format directives (may appear in or out of header).
        if (line.startsWith(QLatin1String("METRIC"))) {
            metric = true; unitsSeen = true; decDigits = 3;
            if (line.contains(QLatin1String("TZ"))) leadingZeroOmitted = false;
            else if (line.contains(QLatin1String("LZ"))) leadingZeroOmitted = true;
            continue;
        }
        if (line.startsWith(QLatin1String("INCH"))) {
            metric = false; unitsSeen = true; decDigits = 4;
            if (line.contains(QLatin1String("TZ"))) leadingZeroOmitted = false;
            else if (line.contains(QLatin1String("LZ"))) leadingZeroOmitted = true;
            continue;
        }
        if (line == QLatin1String("M71")) { metric = true; unitsSeen = true; decDigits = 3; continue; }
        if (line == QLatin1String("M72")) { metric = false; unitsSeen = true; decDigits = 4; continue; }
        if (line.startsWith(QLatin1String("FMAT")) || line.startsWith(QLatin1String("VER")) ||
            line.startsWith(QLatin1String("ICI")) || line.startsWith(QLatin1String("FILE"))) {
            continue;
        }

        // Tool definition: T<n>C<diam> (header), or selection T<n> (body).
        auto mDef = reToolDef.match(line);
        if (mDef.hasMatch() && line.contains('C')) {
            int tn = mDef.captured(1).toInt();
            double d = mDef.captured(2).toDouble();
            toolDia.insert(tn, metric ? d : d * 25.4);
            continue;
        }
        auto mSel = reToolSel.match(line);
        if (mSel.hasMatch()) {
            currentTool = mSel.captured(1).toInt();
            continue;
        }

        // Coordinate (drill hit) — only meaningful in body.
        if (line.contains('X') || line.contains('Y')) {
            // Extract X and Y tokens independently for robustness.
            QRegularExpression rx(QStringLiteral("X([+-]?[\\d.]+)"));
            QRegularExpression ry(QStringLiteral("Y([+-]?[\\d.]+)"));
            auto mx = rx.match(line);
            auto my = ry.match(line);
            if (mx.hasMatch()) curX = decodeCoord(mx.captured(1));
            if (my.hasMatch()) curY = decodeCoord(my.captured(1));
            if (!inHeader && currentTool >= 0) {
                DrillHit h;
                h.pos = Point(curX, curY);
                h.diameter = toolDia.value(currentTool, 0.0);
                out.hits.append(h);
            }
            continue;
        }
    }

    if (!unitsSeen)
        m_warnings << QStringLiteral("No units directive; assumed millimetres");

    if (out.hits.isEmpty()) {
        if (error) *error = QStringLiteral("No drill hits parsed from Excellon data");
        return false;
    }
    return true;
}

} // namespace cadcam
