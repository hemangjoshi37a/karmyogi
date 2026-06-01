// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "gerberimporter.h"

#include <QFile>
#include <QTextStream>
#include <QRegularExpression>
#include <QHash>

#include <cmath>

namespace cadcam {

namespace {

// One configured aperture.
struct Aperture
{
    enum Shape { Circle, Rect, Other } shape = Circle;
    double a = 0.0;   // circle diameter, or rect X size (mm)
    double b = 0.0;   // rect Y size (mm)
};

// Coordinate format from %FS...X<int><dec>Y<int><dec>*%.
struct CoordFormat
{
    int xInt = 2, xDec = 4;
    int yInt = 2, yDec = 4;
    bool leadingZeroOmitted = true;   // LA = leading zeros omitted (most common)
};

double toMm(double v, bool metric) { return metric ? v : v * 25.4; }

} // namespace

BBox GerberData::bounds() const
{
    BBox b;
    for (const auto &t : traces)
        b.expand(t.first.bounds());
    for (const Polyline &p : pads)
        b.expand(p.bounds());
    for (const Polyline &r : regions)
        b.expand(r.bounds());
    return b;
}

bool GerberImporter::importFile(const QString &path, GerberData &out, QString *error)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) {
        if (error) *error = QStringLiteral("Cannot open file: %1").arg(path);
        return false;
    }
    QTextStream ts(&f);
    return importString(ts.readAll(), out, error);
}

bool GerberImporter::importString(const QString &content, GerberData &out, QString *error)
{
    m_warnings.clear();
    out = GerberData();

    bool metric = true;          // %MOMM*% default assumption (warn if unset)
    bool unitsSeen = false;
    CoordFormat fmt;
    bool fmtSeen = false;

    QHash<int, Aperture> apertures;
    int currentAperture = -1;

    // Gerber coordinates are stored as raw integers scaled by the format spec.
    double curX = 0.0, curY = 0.0;   // current point (mm)
    int interp = 1;                  // 1=linear, 2=CW arc, 3=CCW arc
    bool regionMode = false;
    Polyline regionPath;             // accumulates contour in G36 mode
    bool haveCurrent = false;

    // Decode a coordinate token (e.g. "X1500") into mm using the format spec.
    auto decode = [&](const QString &digits, int intDigits, int decDigits) -> double {
        QString s = digits;
        bool neg = false;
        if (s.startsWith('-')) { neg = true; s.remove(0, 1); }
        else if (s.startsWith('+')) s.remove(0, 1);
        if (s.isEmpty()) return 0.0;
        int total = intDigits + decDigits;
        if (fmt.leadingZeroOmitted) {
            // value implicitly right-aligned: pad on the left to `total` digits
            while (s.length() < total) s.prepend('0');
        } else {
            // trailing zeros omitted: pad on the right
            while (s.length() < total) s.append('0');
        }
        // If still longer than expected, keep the rightmost `total` digits.
        if (s.length() > total) s = s.right(total);
        double raw = s.toDouble();
        double val = raw / std::pow(10.0, decDigits);
        if (neg) val = -val;
        return toMm(val, metric);
    };

    // Build a pad polygon for a flash of `ap` at (x,y).
    auto flashPad = [&](const Aperture &ap, double x, double y) {
        if (ap.shape == Aperture::Circle && ap.a > 0.0) {
            out.pads.append(makeCircle(Point(x, y), ap.a / 2.0));
        } else if (ap.shape == Aperture::Rect && ap.a > 0.0 && ap.b > 0.0) {
            out.pads.append(makeRect(Point(x - ap.a / 2.0, y - ap.b / 2.0), ap.a, ap.b));
        } else {
            // Unknown/unsupported aperture: approximate with a tiny dot so the
            // location is still represented.
            double d = ap.a > 0.0 ? ap.a : 0.2;
            out.pads.append(makeCircle(Point(x, y), d / 2.0));
        }
    };

    // ---- Tokenise -------------------------------------------------------
    // Split into extended (%...%) parameter blocks and ordinary data blocks
    // terminated by '*'. Whitespace/newlines are insignificant in Gerber.
    QString data = content;
    int i = 0;
    const int n = data.length();

    QRegularExpression reAdd(QStringLiteral("^ADD(\\d+)([A-Za-z]+)(?:,(.*))?$"));
    QRegularExpression reFs(QStringLiteral("^FS([LT])([AI])X(\\d)(\\d)Y(\\d)(\\d)$"));

    // Active trace being drawn (between consecutive D01s with the same aperture).
    Polyline activeTrace;
    auto flushTrace = [&]() {
        if (activeTrace.size() >= 2) {
            double w = 0.0;
            if (apertures.contains(currentAperture) &&
                apertures[currentAperture].shape == Aperture::Circle)
                w = apertures[currentAperture].a;
            else if (apertures.contains(currentAperture))
                w = qMax(apertures[currentAperture].a, apertures[currentAperture].b);
            out.traces.append(qMakePair(activeTrace, w));
        }
        activeTrace.clear();
    };

    auto handleParam = [&](const QString &p) {
        // Multiple parameters may be packed in one %...% block separated by '*'.
        const QStringList parts = p.split('*', Qt::SkipEmptyParts);
        for (const QString &raw : parts) {
            QString s = raw.trimmed();
            if (s.isEmpty()) continue;
            if (s.startsWith(QLatin1String("MO"))) {
                QString u = s.mid(2);
                metric = (u.compare(QLatin1String("MM"), Qt::CaseInsensitive) == 0);
                unitsSeen = true;
            } else if (s.startsWith(QLatin1String("FS"))) {
                auto m = reFs.match(s);
                if (m.hasMatch()) {
                    fmt.leadingZeroOmitted = (m.captured(1) == QLatin1String("L"));
                    fmt.xInt = m.captured(3).toInt();
                    fmt.xDec = m.captured(4).toInt();
                    fmt.yInt = m.captured(5).toInt();
                    fmt.yDec = m.captured(6).toInt();
                    fmtSeen = true;
                } else {
                    m_warnings << QStringLiteral("Unrecognised format spec: %1").arg(s);
                }
            } else if (s.startsWith(QLatin1String("ADD"))) {
                auto m = reAdd.match(s);
                if (m.hasMatch()) {
                    int code = m.captured(1).toInt();
                    QString shape = m.captured(2);
                    QString args = m.captured(3);
                    Aperture ap;
                    const QStringList av = args.split('X', Qt::SkipEmptyParts);
                    if (shape == QLatin1String("C")) {
                        ap.shape = Aperture::Circle;
                        if (av.size() >= 1) ap.a = toMm(av[0].toDouble(), metric);
                    } else if (shape == QLatin1String("R") || shape == QLatin1String("O")) {
                        ap.shape = Aperture::Rect; // obround approximated as rect
                        if (av.size() >= 1) ap.a = toMm(av[0].toDouble(), metric);
                        if (av.size() >= 2) ap.b = toMm(av[1].toDouble(), metric);
                        else ap.b = ap.a;
                        if (shape == QLatin1String("O"))
                            m_warnings << QStringLiteral("Obround aperture D%1 approximated as rectangle").arg(code);
                    } else {
                        ap.shape = Aperture::Other;
                        if (av.size() >= 1) ap.a = toMm(av[0].toDouble(), metric);
                        m_warnings << QStringLiteral("Unsupported aperture shape '%1' (D%2) approximated").arg(shape).arg(code);
                    }
                    apertures.insert(code, ap);
                }
            } else if (s.startsWith(QLatin1String("AM"))) {
                m_warnings << QStringLiteral("Aperture macro (AM) not supported; skipped");
            } else if (s.startsWith(QLatin1String("SR"))) {
                m_warnings << QStringLiteral("Step & repeat (SR) not supported; skipped");
            } else if (s.startsWith(QLatin1String("LP")) || s.startsWith(QLatin1String("LM")) ||
                       s.startsWith(QLatin1String("LR")) || s.startsWith(QLatin1String("LS"))) {
                m_warnings << QStringLiteral("Layer transform '%1' ignored").arg(s.left(2));
            }
            // IN, IP, AS, OF, MI, SF (deprecated) silently ignored.
        }
    };

    // Process one ordinary data block (already stripped of trailing '*').
    auto handleBlock = [&](const QString &blk) {
        QString b = blk.trimmed();
        if (b.isEmpty()) return;

        // Pull out G, D, X, Y, I, J codes. A block may carry several.
        // Examples: G01X1500Y2000D01 ; D10 ; G36 ; X100Y100D03
        QRegularExpression reTok(QStringLiteral(
            "([GDXYIJ])([+-]?\\d+)"));
        auto it = reTok.globalMatch(b);

        bool hasX = false, hasY = false, hasI = false, hasJ = false;
        double nx = curX, ny = curY, ci = 0.0, cj = 0.0;
        int dCode = -1;
        QVector<int> gCodes;

        while (it.hasNext()) {
            auto m = it.next();
            QChar c = m.captured(1).at(0);
            QString digits = m.captured(2);
            switch (c.toLatin1()) {
            case 'G': gCodes.append(digits.toInt()); break;
            case 'D': dCode = digits.toInt(); break;
            case 'X': nx = decode(digits, fmt.xInt, fmt.xDec); hasX = true; break;
            case 'Y': ny = decode(digits, fmt.yInt, fmt.yDec); hasY = true; break;
            case 'I': ci = decode(digits, fmt.xInt, fmt.xDec); hasI = true; break;
            case 'J': cj = decode(digits, fmt.yInt, fmt.yDec); hasJ = true; break;
            }
        }

        // Apply G modal codes first.
        for (int g : gCodes) {
            switch (g) {
            case 1: interp = 1; break;
            case 2: interp = 2; break;
            case 3: interp = 3; break;
            case 36:
                regionMode = true;
                regionPath.clear();
                break;
            case 37:
                regionMode = false;
                if (regionPath.size() >= 3) {
                    regionPath.closed = true;
                    out.regions.append(regionPath);
                }
                regionPath.clear();
                break;
            case 74: case 75: break; // quadrant mode — we flatten arcs anyway
            case 54: break;          // deprecated tool prepare (Dnn follows)
            default: break;
            }
        }

        // A bare "Dnn" (>=10) with no operation selects the aperture.
        if (dCode >= 10 && !hasX && !hasY) {
            if (currentAperture != dCode) flushTrace();
            currentAperture = dCode;
            return;
        }

        auto emitSegment = [&](double tx, double ty) {
            if (interp == 1 || !(hasI || hasJ)) {
                // linear
                if (regionMode) {
                    if (regionPath.isEmpty()) regionPath.add(Point(curX, curY));
                    regionPath.add(Point(tx, ty));
                } else {
                    if (activeTrace.isEmpty()) activeTrace.add(Point(curX, curY));
                    activeTrace.add(Point(tx, ty));
                }
            } else {
                // circular: centre = current + (I,J)
                Point center(curX + ci, curY + cj);
                double r = distance(Point(curX, curY), center);
                double a0 = std::atan2(curY - center.y(), curX - center.x());
                double a1 = std::atan2(ty - center.y(), tx - center.x());
                bool ccw = (interp == 3);
                Polyline &dst = regionMode ? regionPath : activeTrace;
                if (dst.isEmpty()) dst.add(Point(curX, curY));
                dst.addArc(center, r, a0, a1, ccw);
            }
        };

        if (dCode == 1) {            // D01 draw
            emitSegment(nx, ny);
            curX = nx; curY = ny; haveCurrent = true;
        } else if (dCode == 2) {     // D02 move (pen up)
            if (!regionMode) flushTrace();
            else if (regionPath.size() >= 3) {
                regionPath.closed = true;
                out.regions.append(regionPath);
                regionPath.clear();
            } else {
                regionPath.clear();
            }
            curX = nx; curY = ny; haveCurrent = true;
        } else if (dCode == 3) {     // D03 flash
            if (apertures.contains(currentAperture))
                flashPad(apertures[currentAperture], nx, ny);
            curX = nx; curY = ny; haveCurrent = true;
        } else if (hasX || hasY) {
            // Coordinates with no explicit D-code: continue current modal op.
            // Most files always include D01/D02; treat bare coords as a move.
            curX = nx; curY = ny; haveCurrent = true;
        }
        Q_UNUSED(haveCurrent);
    };

    // ---- Main scan ------------------------------------------------------
    while (i < n) {
        QChar c = data.at(i);
        if (c == '%') {
            int end = data.indexOf('%', i + 1);
            if (end < 0) { m_warnings << QStringLiteral("Unterminated %-block"); break; }
            handleParam(data.mid(i + 1, end - i - 1));
            i = end + 1;
        } else if (c == '*') {
            i++; // empty block
        } else if (c.isSpace()) {
            i++;
        } else {
            int end = data.indexOf('*', i);
            if (end < 0) end = n;
            handleBlock(data.mid(i, end - i));
            i = end + 1;
        }
    }

    flushTrace();
    if (regionMode && regionPath.size() >= 3) {
        regionPath.closed = true;
        out.regions.append(regionPath);
    }

    if (!fmtSeen)
        m_warnings << QStringLiteral("No %FS format spec found; assumed X%1.%2 leading-zero-omitted")
                          .arg(fmt.xInt).arg(fmt.xDec);
    if (!unitsSeen)
        m_warnings << QStringLiteral("No %MO units found; assumed millimetres");

    if (out.isEmpty()) {
        if (error) *error = QStringLiteral("No copper geometry parsed from Gerber data");
        return false;
    }
    return true;
}

} // namespace cadcam
