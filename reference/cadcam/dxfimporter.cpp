// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "dxfimporter.h"

#include <QFile>
#include <QTextStream>
#include <QtMath>

namespace cadcam {

namespace {

struct Pair {
    int code;
    QString value;
};

// A DXF group: a (code, value) pair, with helpers.
double toRad(double deg) { return deg * M_PI / 180.0; }

} // namespace

bool DxfImporter::importFile(const QString &path, Drawing &out, QString *error)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        if (error) *error = QStringLiteral("Cannot open file: %1").arg(path);
        return false;
    }
    QTextStream in(&file);
    const QString content = in.readAll();
    return importString(content, out, error);
}

bool DxfImporter::importString(const QString &content, Drawing &out, QString *error)
{
    m_warnings.clear();

    // ---- Tokenise into (code, value) pairs --------------------------------
    QVector<Pair> pairs;
    const QStringList lines = content.split('\n');
    for (int i = 0; i + 1 < lines.size(); i += 2) {
        bool ok = false;
        int code = lines[i].trimmed().toInt(&ok);
        if (!ok) {
            // Misaligned pair — try to resync by advancing one line.
            i -= 1;
            continue;
        }
        QString value = lines[i + 1];
        // Strip a trailing CR (Windows line endings) but preserve inner text.
        if (value.endsWith('\r')) value.chop(1);
        pairs.append({code, value.trimmed()});
    }

    if (pairs.isEmpty()) {
        if (error) *error = QStringLiteral("Empty or unparseable DXF content");
        return false;
    }

    // ---- Walk entities ----------------------------------------------------
    bool sawSection = false;
    bool inEntities = false;
    int i = 0;
    const int n = pairs.size();

    auto consumeToNextEntity = [&](int from) -> int {
        int j = from;
        while (j < n && pairs[j].code != 0) ++j;
        return j;
    };

    while (i < n) {
        const Pair &p = pairs[i];
        if (p.code != 0) { ++i; continue; }

        const QString kw = p.value.toUpper();

        if (kw == QLatin1String("SECTION")) {
            sawSection = true;
            // The following code-2 pair names the section.
            int j = i + 1;
            QString name;
            while (j < n && pairs[j].code != 0) {
                if (pairs[j].code == 2) name = pairs[j].value.toUpper();
                ++j;
            }
            inEntities = (name == QLatin1String("ENTITIES"));
            i = j;
            continue;
        }
        if (kw == QLatin1String("ENDSEC")) {
            inEntities = false;
            i = consumeToNextEntity(i + 1);
            continue;
        }
        if (kw == QLatin1String("EOF")) break;

        bool active = inEntities || !sawSection;
        if (!active) { i = consumeToNextEntity(i + 1); continue; }

        // ---- Entity dispatch ----------------------------------------------
        if (kw == QLatin1String("LINE")) {
            double x1 = 0, y1 = 0, x2 = 0, y2 = 0;
            QString layer;
            int j = i + 1;
            for (; j < n && pairs[j].code != 0; ++j) {
                switch (pairs[j].code) {
                case 10: x1 = pairs[j].value.toDouble(); break;
                case 20: y1 = pairs[j].value.toDouble(); break;
                case 11: x2 = pairs[j].value.toDouble(); break;
                case 21: y2 = pairs[j].value.toDouble(); break;
                case 8:  layer = pairs[j].value; break;
                }
            }
            out.add(Entity::makeLine(Point(x1, y1), Point(x2, y2), layer));
            i = j;
        } else if (kw == QLatin1String("CIRCLE")) {
            double cx = 0, cy = 0, r = 0;
            QString layer;
            int j = i + 1;
            for (; j < n && pairs[j].code != 0; ++j) {
                switch (pairs[j].code) {
                case 10: cx = pairs[j].value.toDouble(); break;
                case 20: cy = pairs[j].value.toDouble(); break;
                case 40: r = pairs[j].value.toDouble(); break;
                case 8:  layer = pairs[j].value; break;
                }
            }
            if (r > 0) out.add(Entity::makeCircle(Point(cx, cy), r, layer));
            i = j;
        } else if (kw == QLatin1String("ARC")) {
            double cx = 0, cy = 0, r = 0, a0 = 0, a1 = 0;
            QString layer;
            int j = i + 1;
            for (; j < n && pairs[j].code != 0; ++j) {
                switch (pairs[j].code) {
                case 10: cx = pairs[j].value.toDouble(); break;
                case 20: cy = pairs[j].value.toDouble(); break;
                case 40: r = pairs[j].value.toDouble(); break;
                case 50: a0 = pairs[j].value.toDouble(); break;
                case 51: a1 = pairs[j].value.toDouble(); break;
                case 8:  layer = pairs[j].value; break;
                }
            }
            if (r > 0)
                out.add(Entity::makeArc(Point(cx, cy), r, toRad(a0), toRad(a1),
                                        true, layer)); // DXF arcs are CCW
            i = j;
        } else if (kw == QLatin1String("LWPOLYLINE")) {
            QString layer;
            bool closed = false;
            QVector<Point> verts;
            QVector<double> bulges;
            double curBulge = 0.0;
            bool haveVertex = false;
            double vx = 0, vy = 0;
            int j = i + 1;
            auto flushVertex = [&]() {
                if (haveVertex) {
                    verts.append(Point(vx, vy));
                    bulges.append(curBulge);
                    curBulge = 0.0;
                    haveVertex = false;
                }
            };
            for (; j < n && pairs[j].code != 0; ++j) {
                switch (pairs[j].code) {
                case 70: closed = (pairs[j].value.toInt() & 0x1) != 0; break;
                case 8:  layer = pairs[j].value; break;
                case 10: flushVertex(); vx = pairs[j].value.toDouble(); haveVertex = true; break;
                case 20: vy = pairs[j].value.toDouble(); break;
                case 42: curBulge = pairs[j].value.toDouble(); break;
                }
            }
            flushVertex();
            if (verts.size() >= 2) {
                Polyline pl;
                pl.add(verts.first());
                for (int k = 1; k < verts.size(); ++k)
                    appendBulgeArc(pl, verts[k - 1], verts[k], bulges[k - 1]);
                if (closed) {
                    appendBulgeArc(pl, verts.last(), verts.first(), bulges.last());
                    if (pl.points.size() > 1 &&
                        distance(pl.points.first(), pl.points.last()) <= kEpsilon)
                        pl.points.removeLast();
                    pl.closed = true;
                }
                out.add(Entity::makePolyline(pl, layer));
            }
            i = j;
        } else if (kw == QLatin1String("POLYLINE")) {
            // Old-style polyline: header, then VERTEX blocks, then SEQEND.
            QString layer;
            bool closed = false;
            int j = i + 1;
            for (; j < n && pairs[j].code != 0; ++j) {
                switch (pairs[j].code) {
                case 70: closed = (pairs[j].value.toInt() & 0x1) != 0; break;
                case 8:  layer = pairs[j].value; break;
                }
            }
            QVector<Point> verts;
            QVector<double> bulges;
            while (j < n && pairs[j].code == 0 &&
                   pairs[j].value.toUpper() == QLatin1String("VERTEX")) {
                double vx = 0, vy = 0, b = 0;
                int k = j + 1;
                for (; k < n && pairs[k].code != 0; ++k) {
                    switch (pairs[k].code) {
                    case 10: vx = pairs[k].value.toDouble(); break;
                    case 20: vy = pairs[k].value.toDouble(); break;
                    case 42: b = pairs[k].value.toDouble(); break;
                    }
                }
                verts.append(Point(vx, vy));
                bulges.append(b);
                j = k;
            }
            // Consume the SEQEND block if present.
            if (j < n && pairs[j].code == 0 &&
                pairs[j].value.toUpper() == QLatin1String("SEQEND"))
                j = consumeToNextEntity(j + 1);

            if (verts.size() >= 2) {
                Polyline pl;
                pl.add(verts.first());
                for (int k = 1; k < verts.size(); ++k)
                    appendBulgeArc(pl, verts[k - 1], verts[k], bulges[k - 1]);
                if (closed) {
                    appendBulgeArc(pl, verts.last(), verts.first(), bulges.last());
                    if (pl.points.size() > 1 &&
                        distance(pl.points.first(), pl.points.last()) <= kEpsilon)
                        pl.points.removeLast();
                    pl.closed = true;
                }
                out.add(Entity::makePolyline(pl, layer));
            }
            i = j;
        } else if (kw == QLatin1String("TEXT") || kw == QLatin1String("MTEXT") ||
                   kw == QLatin1String("SPLINE") || kw == QLatin1String("ELLIPSE")) {
            m_warnings.append(QStringLiteral("Skipped unsupported entity: %1").arg(kw));
            i = consumeToNextEntity(i + 1);
        } else {
            // Unknown entity/keyword — skip its group.
            i = consumeToNextEntity(i + 1);
        }
    }

    return true;
}

} // namespace cadcam
