// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "strokefont.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QStringList>

#include <cmath>

namespace cadcam {

namespace {

// A stroke is a flat list of x,y pairs (EM units) terminated by the sentinel
// {kEnd,kEnd}. A glyph is one-or-more strokes followed by another sentinel.
// This keeps the embedded table compact and easy to author by hand.
constexpr double kEnd = 1e9;

// Approximate a circular/elliptic outline by sampling, used for round glyphs so
// the data stays compact. Builds a polyline arc in EM units.
Polyline emArc(double cx, double cy, double rx, double ry,
               double a0, double a1, int seg)
{
    Polyline pl;
    if (seg < 2) seg = 2;
    for (int i = 0; i <= seg; ++i) {
        double t = a0 + (a1 - a0) * (double(i) / seg);
        pl.add(Point(cx + rx * std::cos(t), cy + ry * std::sin(t)));
    }
    return pl;
}

void addLine(Glyph &g, double x0, double y0, double x1, double y1)
{
    Polyline pl;
    pl.add(Point(x0, y0));
    pl.add(Point(x1, y1));
    g.strokes.append(pl);
}

void addPoly(Glyph &g, std::initializer_list<double> coords)
{
    Polyline pl;
    const double *p = coords.begin();
    int n = int(coords.size()) / 2;
    for (int i = 0; i < n; ++i)
        pl.add(Point(p[2 * i], p[2 * i + 1]));
    if (pl.size() >= 2)
        g.strokes.append(pl);
}

// EM design metrics: baseline 0, cap top 0.7, x-height 0.5, descender -0.25.
constexpr double CAP = 0.7;
constexpr double XH = 0.5;
constexpr double DESC = -0.22;

} // namespace

// ----------------------------------------------------------------------------
// Built-in font construction. Shapes derived from the public-domain Hershey
// "simplex" Roman set, re-expressed as compact centreline polylines.
// ----------------------------------------------------------------------------
StrokeFont StrokeFont::builtin()
{
    StrokeFont f;
    f.m_name = QStringLiteral("Built-in");
    f.m_capHeight = CAP;

    auto put = [&](ushort code, const Glyph &g) { f.m_glyphs.insert(code, g); };

    // ---- space ----
    {
        Glyph g; g.advance = 0.4;
        put(' ', g);
    }

    // ===================== Uppercase =====================
    { // A
        Glyph g; g.advance = 0.62;
        addPoly(g, {0.02, 0.0, 0.31, CAP, 0.60, 0.0});
        addLine(g, 0.13, 0.28, 0.49, 0.28);
        put('A', g);
    }
    { // B
        Glyph g; g.advance = 0.60;
        addPoly(g, {0.06, 0.0, 0.06, CAP, 0.40, CAP, 0.50, 0.62, 0.50, 0.46,
                    0.40, 0.38, 0.06, 0.38});
        addPoly(g, {0.40, 0.38, 0.52, 0.30, 0.52, 0.10, 0.40, 0.0, 0.06, 0.0});
        put('B', g);
    }
    { // C
        Glyph g; g.advance = 0.62;
        Polyline pl = emArc(0.31, 0.35, 0.29, 0.35, 0.55, 2.0 * M_PI - 0.55, 18);
        g.strokes.append(pl);
        put('C', g);
    }
    { // D
        Glyph g; g.advance = 0.62;
        addLine(g, 0.06, 0.0, 0.06, CAP);
        addPoly(g, {0.06, CAP, 0.32, CAP, 0.52, 0.55, 0.52, 0.15, 0.32, 0.0, 0.06, 0.0});
        put('D', g);
    }
    { // E
        Glyph g; g.advance = 0.55;
        addPoly(g, {0.50, CAP, 0.06, CAP, 0.06, 0.0, 0.50, 0.0});
        addLine(g, 0.06, 0.35, 0.42, 0.35);
        put('E', g);
    }
    { // F
        Glyph g; g.advance = 0.52;
        addPoly(g, {0.50, CAP, 0.06, CAP, 0.06, 0.0});
        addLine(g, 0.06, 0.35, 0.42, 0.35);
        put('F', g);
    }
    { // G
        Glyph g; g.advance = 0.65;
        Polyline pl = emArc(0.33, 0.35, 0.29, 0.35, 0.45, 2.0 * M_PI - 0.20, 20);
        g.strokes.append(pl);
        addPoly(g, {0.62, 0.05, 0.62, 0.30, 0.40, 0.30});
        put('G', g);
    }
    { // H
        Glyph g; g.advance = 0.62;
        addLine(g, 0.06, 0.0, 0.06, CAP);
        addLine(g, 0.56, 0.0, 0.56, CAP);
        addLine(g, 0.06, 0.35, 0.56, 0.35);
        put('H', g);
    }
    { // I
        Glyph g; g.advance = 0.28;
        addLine(g, 0.14, 0.0, 0.14, CAP);
        put('I', g);
    }
    { // J
        Glyph g; g.advance = 0.50;
        addPoly(g, {0.40, CAP, 0.40, 0.18, 0.32, 0.02, 0.18, 0.0, 0.06, 0.06, 0.04, 0.18});
        put('J', g);
    }
    { // K
        Glyph g; g.advance = 0.60;
        addLine(g, 0.06, 0.0, 0.06, CAP);
        addLine(g, 0.06, 0.28, 0.54, CAP);
        addLine(g, 0.22, 0.40, 0.56, 0.0);
        put('K', g);
    }
    { // L
        Glyph g; g.advance = 0.52;
        addPoly(g, {0.06, CAP, 0.06, 0.0, 0.50, 0.0});
        put('L', g);
    }
    { // M
        Glyph g; g.advance = 0.72;
        addPoly(g, {0.06, 0.0, 0.06, CAP, 0.36, 0.18, 0.66, CAP, 0.66, 0.0});
        put('M', g);
    }
    { // N
        Glyph g; g.advance = 0.66;
        addPoly(g, {0.06, 0.0, 0.06, CAP, 0.60, 0.0, 0.60, CAP});
        put('N', g);
    }
    { // O
        Glyph g; g.advance = 0.68;
        g.strokes.append(emArc(0.34, 0.35, 0.30, 0.35, 0.0, 2.0 * M_PI, 24));
        put('O', g);
    }
    { // P
        Glyph g; g.advance = 0.58;
        addLine(g, 0.06, 0.0, 0.06, CAP);
        addPoly(g, {0.06, CAP, 0.38, CAP, 0.50, 0.60, 0.50, 0.46, 0.38, 0.38, 0.06, 0.38});
        put('P', g);
    }
    { // Q
        Glyph g; g.advance = 0.68;
        g.strokes.append(emArc(0.34, 0.35, 0.30, 0.35, 0.0, 2.0 * M_PI, 24));
        addLine(g, 0.40, 0.18, 0.62, -0.04);
        put('Q', g);
    }
    { // R
        Glyph g; g.advance = 0.60;
        addLine(g, 0.06, 0.0, 0.06, CAP);
        addPoly(g, {0.06, CAP, 0.38, CAP, 0.50, 0.60, 0.50, 0.46, 0.38, 0.38, 0.06, 0.38});
        addLine(g, 0.32, 0.38, 0.54, 0.0);
        put('R', g);
    }
    { // S
        Glyph g; g.advance = 0.56;
        addPoly(g, {0.50, 0.58, 0.36, CAP, 0.16, CAP, 0.04, 0.58, 0.04, 0.48,
                    0.16, 0.40, 0.40, 0.30, 0.50, 0.20, 0.50, 0.10, 0.38, 0.0,
                    0.14, 0.0, 0.02, 0.12});
        put('S', g);
    }
    { // T
        Glyph g; g.advance = 0.54;
        addLine(g, 0.0, CAP, 0.54, CAP);
        addLine(g, 0.27, CAP, 0.27, 0.0);
        put('T', g);
    }
    { // U
        Glyph g; g.advance = 0.64;
        addPoly(g, {0.06, CAP, 0.06, 0.18, 0.18, 0.02, 0.40, 0.02, 0.52, 0.18, 0.52, CAP});
        put('U', g);
    }
    { // V
        Glyph g; g.advance = 0.62;
        addPoly(g, {0.02, CAP, 0.31, 0.0, 0.60, CAP});
        put('V', g);
    }
    { // W
        Glyph g; g.advance = 0.80;
        addPoly(g, {0.02, CAP, 0.20, 0.0, 0.40, 0.50, 0.60, 0.0, 0.78, CAP});
        put('W', g);
    }
    { // X
        Glyph g; g.advance = 0.60;
        addLine(g, 0.04, 0.0, 0.56, CAP);
        addLine(g, 0.56, 0.0, 0.04, CAP);
        put('X', g);
    }
    { // Y
        Glyph g; g.advance = 0.58;
        addPoly(g, {0.02, CAP, 0.29, 0.38, 0.56, CAP});
        addLine(g, 0.29, 0.38, 0.29, 0.0);
        put('Y', g);
    }
    { // Z
        Glyph g; g.advance = 0.58;
        addPoly(g, {0.04, CAP, 0.54, CAP, 0.04, 0.0, 0.54, 0.0});
        put('Z', g);
    }

    // ===================== Lowercase =====================
    { // a
        Glyph g; g.advance = 0.54;
        addLine(g, 0.46, XH, 0.46, 0.0);
        g.strokes.append(emArc(0.26, 0.16, 0.20, 0.16, 0.0, 2.0 * M_PI, 18));
        put('a', g);
    }
    { // b
        Glyph g; g.advance = 0.54;
        addLine(g, 0.06, CAP, 0.06, 0.0);
        g.strokes.append(emArc(0.28, 0.16, 0.22, 0.16, 0.0, 2.0 * M_PI, 18));
        put('b', g);
    }
    { // c
        Glyph g; g.advance = 0.50;
        g.strokes.append(emArc(0.26, 0.16, 0.20, 0.16, 0.6, 2.0 * M_PI - 0.6, 16));
        put('c', g);
    }
    { // d
        Glyph g; g.advance = 0.54;
        addLine(g, 0.46, CAP, 0.46, 0.0);
        g.strokes.append(emArc(0.24, 0.16, 0.20, 0.16, 0.0, 2.0 * M_PI, 18));
        put('d', g);
    }
    { // e
        Glyph g; g.advance = 0.52;
        addLine(g, 0.06, 0.18, 0.46, 0.18);
        g.strokes.append(emArc(0.26, 0.16, 0.20, 0.16, 0.0, 2.0 * M_PI - 0.9, 16));
        put('e', g);
    }
    { // f
        Glyph g; g.advance = 0.36;
        addPoly(g, {0.32, 0.66, 0.22, CAP, 0.14, 0.62, 0.14, 0.0});
        addLine(g, 0.02, XH, 0.30, XH);
        put('f', g);
    }
    { // g
        Glyph g; g.advance = 0.54;
        g.strokes.append(emArc(0.26, 0.16, 0.20, 0.16, 0.0, 2.0 * M_PI, 18));
        addPoly(g, {0.46, XH, 0.46, -0.10, 0.36, DESC, 0.16, DESC, 0.08, -0.12});
        put('g', g);
    }
    { // h
        Glyph g; g.advance = 0.54;
        addLine(g, 0.06, CAP, 0.06, 0.0);
        addPoly(g, {0.06, 0.34, 0.20, XH, 0.38, XH, 0.46, 0.36, 0.46, 0.0});
        put('h', g);
    }
    { // i
        Glyph g; g.advance = 0.22;
        addLine(g, 0.11, XH, 0.11, 0.0);
        addLine(g, 0.11, 0.64, 0.11, 0.66);
        put('i', g);
    }
    { // j
        Glyph g; g.advance = 0.26;
        addPoly(g, {0.16, XH, 0.16, -0.12, 0.08, DESC, 0.02, -0.18});
        addLine(g, 0.16, 0.64, 0.16, 0.66);
        put('j', g);
    }
    { // k
        Glyph g; g.advance = 0.48;
        addLine(g, 0.06, CAP, 0.06, 0.0);
        addLine(g, 0.06, 0.18, 0.42, XH);
        addLine(g, 0.18, 0.28, 0.44, 0.0);
        put('k', g);
    }
    { // l
        Glyph g; g.advance = 0.22;
        addLine(g, 0.11, CAP, 0.11, 0.0);
        put('l', g);
    }
    { // m
        Glyph g; g.advance = 0.78;
        addLine(g, 0.06, XH, 0.06, 0.0);
        addPoly(g, {0.06, 0.36, 0.16, XH, 0.30, XH, 0.38, 0.36, 0.38, 0.0});
        addPoly(g, {0.38, 0.36, 0.48, XH, 0.62, XH, 0.70, 0.36, 0.70, 0.0});
        put('m', g);
    }
    { // n
        Glyph g; g.advance = 0.54;
        addLine(g, 0.06, XH, 0.06, 0.0);
        addPoly(g, {0.06, 0.36, 0.20, XH, 0.38, XH, 0.46, 0.36, 0.46, 0.0});
        put('n', g);
    }
    { // o
        Glyph g; g.advance = 0.54;
        g.strokes.append(emArc(0.27, 0.16, 0.21, 0.16, 0.0, 2.0 * M_PI, 18));
        put('o', g);
    }
    { // p
        Glyph g; g.advance = 0.54;
        addLine(g, 0.06, XH, 0.06, DESC);
        g.strokes.append(emArc(0.28, 0.16, 0.22, 0.16, 0.0, 2.0 * M_PI, 18));
        put('p', g);
    }
    { // q
        Glyph g; g.advance = 0.54;
        addLine(g, 0.46, XH, 0.46, DESC);
        g.strokes.append(emArc(0.24, 0.16, 0.22, 0.16, 0.0, 2.0 * M_PI, 18));
        put('q', g);
    }
    { // r
        Glyph g; g.advance = 0.40;
        addLine(g, 0.06, XH, 0.06, 0.0);
        addPoly(g, {0.06, 0.34, 0.18, XH, 0.34, XH, 0.40, 0.42});
        put('r', g);
    }
    { // s
        Glyph g; g.advance = 0.46;
        addPoly(g, {0.40, 0.42, 0.28, XH, 0.12, XH, 0.04, 0.42, 0.12, 0.30,
                    0.30, 0.22, 0.38, 0.12, 0.30, 0.02, 0.12, 0.02, 0.02, 0.10});
        put('s', g);
    }
    { // t
        Glyph g; g.advance = 0.34;
        addPoly(g, {0.14, 0.66, 0.14, 0.12, 0.22, 0.02, 0.30, 0.06});
        addLine(g, 0.02, XH, 0.28, XH);
        put('t', g);
    }
    { // u
        Glyph g; g.advance = 0.54;
        addPoly(g, {0.06, XH, 0.06, 0.14, 0.14, 0.02, 0.32, 0.02, 0.46, 0.14});
        addLine(g, 0.46, XH, 0.46, 0.0);
        put('u', g);
    }
    { // v
        Glyph g; g.advance = 0.50;
        addPoly(g, {0.02, XH, 0.25, 0.0, 0.48, XH});
        put('v', g);
    }
    { // w
        Glyph g; g.advance = 0.70;
        addPoly(g, {0.02, XH, 0.16, 0.0, 0.34, 0.34, 0.52, 0.0, 0.66, XH});
        put('w', g);
    }
    { // x
        Glyph g; g.advance = 0.48;
        addLine(g, 0.04, XH, 0.44, 0.0);
        addLine(g, 0.44, XH, 0.04, 0.0);
        put('x', g);
    }
    { // y
        Glyph g; g.advance = 0.50;
        addPoly(g, {0.02, XH, 0.25, 0.0, 0.48, XH});
        addPoly(g, {0.48, XH, 0.28, -0.10, 0.14, DESC, 0.04, -0.18});
        put('y', g);
    }
    { // z
        Glyph g; g.advance = 0.48;
        addPoly(g, {0.04, XH, 0.44, XH, 0.04, 0.0, 0.44, 0.0});
        put('z', g);
    }

    // ===================== Digits =====================
    { // 0
        Glyph g; g.advance = 0.56;
        g.strokes.append(emArc(0.28, 0.35, 0.22, 0.35, 0.0, 2.0 * M_PI, 22));
        addLine(g, 0.16, 0.12, 0.40, 0.58);
        put('0', g);
    }
    { // 1
        Glyph g; g.advance = 0.40;
        addPoly(g, {0.10, 0.58, 0.24, CAP, 0.24, 0.0});
        addLine(g, 0.06, 0.0, 0.40, 0.0);
        put('1', g);
    }
    { // 2
        Glyph g; g.advance = 0.54;
        addPoly(g, {0.04, 0.56, 0.16, CAP, 0.36, CAP, 0.48, 0.56, 0.48, 0.44,
                    0.04, 0.10, 0.04, 0.0, 0.50, 0.0});
        put('2', g);
    }
    { // 3
        Glyph g; g.advance = 0.54;
        addPoly(g, {0.04, 0.60, 0.18, CAP, 0.38, CAP, 0.48, 0.58, 0.40, 0.42, 0.22, 0.40});
        addPoly(g, {0.40, 0.42, 0.50, 0.28, 0.50, 0.10, 0.36, 0.0, 0.14, 0.0, 0.02, 0.12});
        put('3', g);
    }
    { // 4
        Glyph g; g.advance = 0.56;
        addPoly(g, {0.38, 0.0, 0.38, CAP, 0.04, 0.22, 0.52, 0.22});
        put('4', g);
    }
    { // 5
        Glyph g; g.advance = 0.54;
        addPoly(g, {0.46, CAP, 0.10, CAP, 0.08, 0.40, 0.30, 0.46, 0.44, 0.38,
                    0.50, 0.22, 0.42, 0.06, 0.22, 0.0, 0.04, 0.08});
        put('5', g);
    }
    { // 6
        Glyph g; g.advance = 0.54;
        addPoly(g, {0.44, 0.62, 0.30, CAP, 0.14, 0.62, 0.06, 0.36, 0.06, 0.14, 0.18, 0.0,
                    0.36, 0.0, 0.48, 0.14, 0.48, 0.24, 0.36, 0.36, 0.14, 0.36, 0.06, 0.26});
        put('6', g);
    }
    { // 7
        Glyph g; g.advance = 0.52;
        addPoly(g, {0.04, CAP, 0.50, CAP, 0.20, 0.0});
        put('7', g);
    }
    { // 8
        Glyph g; g.advance = 0.54;
        g.strokes.append(emArc(0.27, 0.53, 0.18, 0.17, 0.0, 2.0 * M_PI, 18));
        g.strokes.append(emArc(0.27, 0.18, 0.22, 0.18, 0.0, 2.0 * M_PI, 18));
        put('8', g);
    }
    { // 9
        Glyph g; g.advance = 0.54;
        addPoly(g, {0.10, 0.08, 0.24, 0.0, 0.40, 0.08, 0.48, 0.34, 0.48, 0.56, 0.36, CAP,
                    0.18, CAP, 0.06, 0.56, 0.06, 0.46, 0.18, 0.34, 0.40, 0.34, 0.48, 0.44});
        put('9', g);
    }

    // ===================== Punctuation =====================
    { // .
        Glyph g; g.advance = 0.26;
        addLine(g, 0.12, 0.0, 0.12, 0.04);
        put('.', g);
    }
    { // ,
        Glyph g; g.advance = 0.26;
        addPoly(g, {0.14, 0.06, 0.12, 0.0, 0.06, -0.10});
        put(',', g);
    }
    { // :
        Glyph g; g.advance = 0.26;
        addLine(g, 0.12, 0.0, 0.12, 0.04);
        addLine(g, 0.12, 0.34, 0.12, 0.38);
        put(':', g);
    }
    { // ;
        Glyph g; g.advance = 0.26;
        addLine(g, 0.13, 0.34, 0.13, 0.38);
        addPoly(g, {0.15, 0.06, 0.13, 0.0, 0.07, -0.10});
        put(';', g);
    }
    { // !
        Glyph g; g.advance = 0.24;
        addLine(g, 0.12, 0.18, 0.12, CAP);
        addLine(g, 0.12, 0.0, 0.12, 0.04);
        put('!', g);
    }
    { // ?
        Glyph g; g.advance = 0.50;
        addPoly(g, {0.04, 0.56, 0.16, CAP, 0.34, CAP, 0.46, 0.56, 0.40, 0.44,
                    0.25, 0.36, 0.25, 0.22});
        addLine(g, 0.25, 0.0, 0.25, 0.04);
        put('?', g);
    }
    { // -
        Glyph g; g.advance = 0.50;
        addLine(g, 0.08, 0.35, 0.42, 0.35);
        put('-', g);
    }
    { // _
        Glyph g; g.advance = 0.55;
        addLine(g, 0.0, -0.05, 0.55, -0.05);
        put('_', g);
    }
    { // (
        Glyph g; g.advance = 0.30;
        g.strokes.append(emArc(0.34, 0.32, 0.26, 0.42, M_PI - 0.9, M_PI + 0.9, 14));
        put('(', g);
    }
    { // )
        Glyph g; g.advance = 0.30;
        g.strokes.append(emArc(-0.04, 0.32, 0.26, 0.42, -0.9, 0.9, 14));
        put(')', g);
    }
    { // /
        Glyph g; g.advance = 0.42;
        addLine(g, 0.02, 0.0, 0.40, CAP);
        put('/', g);
    }
    { // +
        Glyph g; g.advance = 0.56;
        addLine(g, 0.08, 0.35, 0.48, 0.35);
        addLine(g, 0.28, 0.15, 0.28, 0.55);
        put('+', g);
    }
    { // =
        Glyph g; g.advance = 0.56;
        addLine(g, 0.08, 0.42, 0.48, 0.42);
        addLine(g, 0.08, 0.26, 0.48, 0.26);
        put('=', g);
    }
    { // '
        Glyph g; g.advance = 0.20;
        addLine(g, 0.10, 0.56, 0.10, CAP);
        put('\'', g);
    }
    { // "
        Glyph g; g.advance = 0.30;
        addLine(g, 0.09, 0.56, 0.09, CAP);
        addLine(g, 0.21, 0.56, 0.21, CAP);
        put('"', g);
    }

    return f;
}

bool StrokeFont::hasGlyph(QChar ch) const
{
    return m_glyphs.contains(ch.unicode());
}

const Glyph *StrokeFont::glyph(QChar ch) const
{
    auto it = m_glyphs.constFind(ch.unicode());
    return it == m_glyphs.constEnd() ? nullptr : &it.value();
}

QVector<Polyline> StrokeFont::layout(const QString &text, double charHeightMm,
                                     double lineSpacingFactor,
                                     double letterSpacingMm, int align) const
{
    QVector<Polyline> out;
    if (charHeightMm <= 0.0 || text.isEmpty())
        return out;

    // EM->mm scale so that cap height maps to charHeightMm.
    const double scale = (m_capHeight > 0.0) ? (charHeightMm / m_capHeight)
                                             : charHeightMm;
    const double lineDy = charHeightMm * (lineSpacingFactor > 0.0
                                          ? lineSpacingFactor : 1.0);

    const QStringList lines = text.split('\n');

    // First line baseline sits below the top by one charHeight; subsequent
    // lines descend. Top of the block is y = 0 (origin), text grows downward
    // in line index but each glyph is drawn with +y up from its baseline.
    for (int li = 0; li < lines.size(); ++li) {
        const QString &line = lines.at(li);

        // Measure advance width (mm) for alignment.
        double widthMm = 0.0;
        for (int ci = 0; ci < line.size(); ++ci) {
            const Glyph *gl = glyph(line.at(ci));
            double adv = gl ? gl->advance : 0.45;   // fall back to a space-ish width
            widthMm += adv * scale;
            if (ci + 1 < line.size())
                widthMm += letterSpacingMm;
        }

        double xStart = 0.0;
        if (align == 1)       xStart = -widthMm / 2.0;   // centre
        else if (align == 2)  xStart = -widthMm;         // right

        // Baseline of this line, measured from the block origin (y=0 top).
        const double baseline = -charHeightMm - double(li) * lineDy;

        double penX = xStart;
        for (int ci = 0; ci < line.size(); ++ci) {
            const Glyph *gl = glyph(line.at(ci));
            if (gl) {
                for (const Polyline &src : gl->strokes) {
                    Polyline pl;
                    pl.closed = src.closed;
                    for (const Point &p : src.points)
                        pl.add(Point(penX + p.x() * scale,
                                     baseline + p.y() * scale));
                    if (pl.size() >= 2)
                        out.append(pl);
                }
                penX += gl->advance * scale;
            } else {
                penX += 0.45 * scale;   // unknown glyph -> blank space
            }
            if (ci + 1 < line.size())
                penX += letterSpacingMm;
        }
    }

    return out;
}

bool StrokeFont::loadJson(const QString &path, QString *err)
{
    auto fail = [&](const QString &m) { if (err) *err = m; return false; };

    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return fail(QStringLiteral("Cannot open file: %1").arg(path));

    QByteArray data = file.readAll();
    file.close();

    QJsonParseError pe;
    QJsonDocument doc = QJsonDocument::fromJson(data, &pe);
    if (pe.error != QJsonParseError::NoError)
        return fail(QStringLiteral("JSON parse error: %1").arg(pe.errorString()));
    if (!doc.isObject())
        return fail(QStringLiteral("Root is not a JSON object."));

    QJsonObject root = doc.object();
    QJsonObject glyphs = root.value(QStringLiteral("glyphs")).toObject();
    if (glyphs.isEmpty())
        return fail(QStringLiteral("No \"glyphs\" object found."));

    QString name = root.value(QStringLiteral("name")).toString(QStringLiteral("Custom"));
    double capHeight = root.value(QStringLiteral("capHeight")).toDouble(0.7);
    if (capHeight <= 0.0)
        return fail(QStringLiteral("Invalid capHeight."));

    QHash<ushort, Glyph> parsed;
    for (auto it = glyphs.constBegin(); it != glyphs.constEnd(); ++it) {
        const QString key = it.key();
        if (key.isEmpty())
            continue;
        ushort code = key.at(0).unicode();

        QJsonObject go = it.value().toObject();
        Glyph g;
        g.advance = go.value(QStringLiteral("advance")).toDouble(0.6);

        QJsonArray strokes = go.value(QStringLiteral("strokes")).toArray();
        for (const QJsonValue &sv : strokes) {
            QJsonArray pts = sv.toArray();
            Polyline pl;
            for (const QJsonValue &pv : pts) {
                QJsonArray xy = pv.toArray();
                if (xy.size() >= 2)
                    pl.add(Point(xy.at(0).toDouble(), xy.at(1).toDouble()));
            }
            if (pl.size() >= 2)
                g.strokes.append(pl);
        }
        parsed.insert(code, g);
    }

    if (parsed.isEmpty())
        return fail(QStringLiteral("No valid glyphs parsed."));

    m_name = name;
    m_capHeight = capHeight;
    m_glyphs = parsed;
    return true;
}

} // namespace cadcam
