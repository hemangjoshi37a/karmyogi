// This file is a part of "Candle" application (hjLabs.in fork).
// Unit tests for the shared CAD/CAM core.
// Copyright 2026 hjLabs.in / Hemang Joshi

#include <QtTest>
#include <QtMath>

#include "../geometry.h"
#include "../entity.h"
#include "../toolpath.h"
#include "../gcodeemitter.h"
#include "../dxfimporter.h"
#include "../offset.h"
#include "../camoperations.h"
#include "../soldering.h"
#include "../strokefont.h"
#include "../gerberimporter.h"
#include "../excellonimporter.h"
#include "../pcbcam.h"

#include <QDir>
#include <QFile>

using namespace cadcam;

static bool fuzzy(double a, double b, double tol = 1e-6)
{
    return std::fabs(a - b) <= tol;
}

class TstCadCam : public QObject
{
    Q_OBJECT

private slots:
    // ---- geometry ---------------------------------------------------------
    void bboxExpand();
    void rectAreaOrientationLength();
    void circleArea();
    void pointInPolygonTest();
    void distanceToSegment();
    void bulgeArcSemicircle();

    // ---- offset -----------------------------------------------------------
    void offsetSquareOutward();
    void offsetSquareInward();
    void insetRingsCount();
    void insetTooBigCollapses();

    // ---- toolpath / cam ---------------------------------------------------
    void depthLevelsMultiPass();
    void depthLevelsSinglePass();
    void engraveStructure();
    void profileInsideSmallerThanOutside();
    void pocketNonEmpty();

    // ---- emitter ----------------------------------------------------------
    void emitterHeaderFooterSafety();
    void emitterNoNegativeZero();
    void emitterPenMode();
    void emitterFeedSurvivesSkippedMove();

    // ---- dxf --------------------------------------------------------------
    void dxfImportEntities();
    void dxfClosedPolyline();

    // ---- soldering --------------------------------------------------------
    void solderPreSolderFeedsBeforeTouch();
    void solderTouchDownFeedsAfterTouch();
    void solderProgramSafety();

    // ---- stroke font (writing) -------------------------------------------
    void strokeFontBuiltinHasGlyphs();
    void strokeFontLayout();
    void strokeFontJsonRoundTrip();

    // ---- pcb (gerber / excellon / cam) -----------------------------------
    void gerberParseBasic();
    void excellonParseBasic();
    void pcbToolpathsNonEmpty();
};

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

void TstCadCam::bboxExpand()
{
    BBox b;
    QVERIFY(!b.isValid());
    b.expand(Point(1, 2));
    b.expand(Point(-3, 5));
    QVERIFY(b.isValid());
    QVERIFY(fuzzy(b.min.x(), -3));
    QVERIFY(fuzzy(b.min.y(), 2));
    QVERIFY(fuzzy(b.max.x(), 1));
    QVERIFY(fuzzy(b.max.y(), 5));
    QVERIFY(fuzzy(b.width(), 4));
    QVERIFY(fuzzy(b.height(), 3));
}

void TstCadCam::rectAreaOrientationLength()
{
    Polyline r = makeRect(Point(0, 0), 10, 10);
    QVERIFY(r.closed);
    QCOMPARE(r.size(), 4);
    QVERIFY(fuzzy(r.signedArea(), 100.0));   // CCW => positive
    QVERIFY(!r.isClockwise());
    QVERIFY(fuzzy(r.length(), 40.0));        // perimeter incl. closing edge
    BBox b = r.bounds();
    QVERIFY(fuzzy(b.width(), 10) && fuzzy(b.height(), 10));
}

void TstCadCam::circleArea()
{
    Polyline c = makeCircle(Point(0, 0), 5.0, 0.01);
    QVERIFY(c.closed);
    // Flattened polygon area approaches pi r^2 from below.
    double area = std::fabs(c.signedArea());
    double exact = M_PI * 25.0;
    QVERIFY(area > exact * 0.99 && area <= exact + 1e-6);
}

void TstCadCam::pointInPolygonTest()
{
    Polyline r = makeRect(Point(0, 0), 10, 10);
    QVERIFY(pointInPolygon(r, Point(5, 5)));
    QVERIFY(!pointInPolygon(r, Point(15, 5)));
    QVERIFY(!pointInPolygon(r, Point(-1, -1)));
}

void TstCadCam::distanceToSegment()
{
    QVERIFY(fuzzy(distancePointToSegment(Point(5, 3), Point(0, 0), Point(10, 0)), 3.0));
    QVERIFY(fuzzy(distancePointToSegment(Point(-5, 0), Point(0, 0), Point(10, 0)), 5.0));
    QVERIFY(fuzzy(distancePointToSegment(Point(0, 0), Point(0, 0), Point(0, 0)), 0.0));
}

void TstCadCam::bulgeArcSemicircle()
{
    // bulge = 1 => 180 degree arc (tan(pi/4)=1). From (0,0) to (10,0), CCW,
    // semicircle of radius 5 bulging upward; apex near (5,5).
    Polyline pl;
    pl.add(Point(0, 0));
    appendBulgeArc(pl, Point(0, 0), Point(10, 0), 1.0, 0.01);
    QVERIFY(pl.points.size() > 3);
    QVERIFY(fuzzy(pl.points.last().x(), 10.0, 1e-3));
    QVERIFY(fuzzy(pl.points.last().y(), 0.0, 1e-3));
    // Positive bulge => CCW arc; for a left-to-right chord that dips downward,
    // reaching the apex at y ~ -5 (radius 5, centre on the chord midpoint).
    double minY = 0;
    for (const Point &p : pl.points) minY = std::min(minY, p.y());
    QVERIFY(fuzzy(minY, -5.0, 0.05));
}

// ---------------------------------------------------------------------------
// offset
// ---------------------------------------------------------------------------

void TstCadCam::offsetSquareOutward()
{
    Polyline r = makeRect(Point(0, 0), 10, 10);
    Polyline o = offsetPolygon(r, 1.0);
    QCOMPARE(o.size(), 4);
    QVERIFY(fuzzy(std::fabs(o.signedArea()), 144.0)); // 12 x 12
    BBox b = o.bounds();
    QVERIFY(fuzzy(b.min.x(), -1) && fuzzy(b.min.y(), -1));
    QVERIFY(fuzzy(b.max.x(), 11) && fuzzy(b.max.y(), 11));
}

void TstCadCam::offsetSquareInward()
{
    Polyline r = makeRect(Point(0, 0), 10, 10);
    Polyline o = offsetPolygon(r, -1.0);
    QCOMPARE(o.size(), 4);
    QVERIFY(fuzzy(std::fabs(o.signedArea()), 64.0)); // 8 x 8
}

void TstCadCam::insetRingsCount()
{
    Polyline r = makeRect(Point(0, 0), 10, 10);
    // firstOffset 1 (8x8), step 2 -> next inset 3 (4x4); inset 5 collapses.
    QVector<Polyline> rings = insetRings(r, 1.0, 2.0);
    QCOMPARE(rings.size(), 2);
    QVERIFY(fuzzy(std::fabs(rings[0].signedArea()), 64.0));
    QVERIFY(fuzzy(std::fabs(rings[1].signedArea()), 16.0));
}

void TstCadCam::insetTooBigCollapses()
{
    Polyline r = makeRect(Point(0, 0), 10, 10);
    QVector<Polyline> rings = insetRings(r, 8.0, 2.0); // 8 > half-width(5)
    QVERIFY(rings.isEmpty());
}

// ---------------------------------------------------------------------------
// toolpath / cam
// ---------------------------------------------------------------------------

void TstCadCam::depthLevelsMultiPass()
{
    CamParams p;
    p.surfaceZ = 0.0;
    p.cutDepth = 3.0;
    p.tool.stepdown = 1.0;
    QVector<double> levels = depthLevels(p);
    QCOMPARE(levels.size(), 3);
    QVERIFY(fuzzy(levels[0], -1.0));
    QVERIFY(fuzzy(levels[1], -2.0));
    QVERIFY(fuzzy(levels[2], -3.0));
}

void TstCadCam::depthLevelsSinglePass()
{
    CamParams p;
    p.surfaceZ = 0.0;
    p.cutDepth = 3.0;
    p.tool.stepdown = 0.0; // single pass
    QVector<double> levels = depthLevels(p);
    QCOMPARE(levels.size(), 1);
    QVERIFY(fuzzy(levels[0], -3.0));
}

void TstCadCam::engraveStructure()
{
    CamParams p;
    p.safeZ = 5.0;
    p.surfaceZ = 0.0;
    p.cutDepth = 1.0;
    p.tool.stepdown = 0.0;

    Polyline sq = makeRect(Point(0, 0), 10, 10);
    Toolpath tp = engrave(sq, p);

    // rapid + plunge + 3 feeds + close feed + retract rapid = 7 moves.
    QCOMPARE(tp.size(), 7);
    QCOMPARE(tp.moves.first().type, MoveType::Rapid);
    QCOMPARE(tp.moves[1].type, MoveType::Plunge);
    QVERIFY(fuzzy(tp.moves[1].target.z(), -1.0));
    QCOMPARE(tp.moves.last().type, MoveType::Rapid);
    QVERIFY(fuzzy(tp.moves.last().target.z(), 5.0)); // retracted to safeZ
}

void TstCadCam::profileInsideSmallerThanOutside()
{
    CamParams p;
    p.tool.diameter = 2.0; // radius 1
    p.tool.stepdown = 0.0;
    p.cutDepth = 1.0;

    Polyline sq = makeRect(Point(0, 0), 20, 20);
    Toolpath in = profile(sq, ProfileSide::Inside, p);
    Toolpath out = profile(sq, ProfileSide::Outside, p);

    QVERIFY(!in.isEmpty());
    QVERIFY(!out.isEmpty());
    QVERIFY(out.bounds2D().width() > in.bounds2D().width());
    // Inside profile of a 20mm square with r1 tool -> ~18mm path width.
    QVERIFY(fuzzy(in.bounds2D().width(), 18.0, 1e-3));
    QVERIFY(fuzzy(out.bounds2D().width(), 22.0, 1e-3));
}

void TstCadCam::pocketNonEmpty()
{
    CamParams p;
    p.tool.diameter = 2.0;   // radius 1
    p.tool.stepover = 0.5;   // step = 1mm
    p.tool.stepdown = 0.0;
    p.cutDepth = 1.0;

    Polyline sq = makeRect(Point(0, 0), 20, 20);
    Toolpath tp = pocket(sq, p);
    QVERIFY(!tp.isEmpty());
    QVERIFY(tp.cutLength() > 0.0);
    // Pocket must stay strictly inside the boundary.
    BBox b = tp.bounds2D();
    QVERIFY(b.min.x() >= 1.0 - 1e-6 && b.max.x() <= 19.0 + 1e-6);
}

// ---------------------------------------------------------------------------
// emitter
// ---------------------------------------------------------------------------

void TstCadCam::emitterHeaderFooterSafety()
{
    CamParams cp;
    cp.safeZ = 5.0;
    cp.cutDepth = 1.0;
    cp.tool.stepdown = 0.0;
    Polyline sq = makeRect(Point(0, 0), 10, 10);
    Toolpath tp = engrave(sq, cp);

    EmitterOptions opt;
    opt.safeZ = 5.0;
    opt.useSpindle = true;
    opt.spindleRPM = 12000;
    GcodeEmitter em(opt);
    QString g = em.emitProgram(tp);

    QVERIFY(g.contains("G21"));   // metric
    QVERIFY(g.contains("G90"));   // absolute
    QVERIFY(g.contains("M3 S12000.000"));
    QVERIFY(g.contains("M5"));
    QVERIFY(g.contains("M30"));

    // The very first motion line must be a Z retract to safe height.
    const QStringList lines = g.split('\n');
    int firstG0 = -1;
    for (int i = 0; i < lines.size(); ++i) {
        if (lines[i].startsWith("G0")) { firstG0 = i; break; }
    }
    QVERIFY(firstG0 >= 0);
    QVERIFY(lines[firstG0].contains("Z5.000"));
}

void TstCadCam::emitterNoNegativeZero()
{
    Toolpath tp;
    tp.rapid(QVector3D(-0.0000001, 0.0, 5.0));
    tp.plunge(QVector3D(-0.0000001, 0.0, -0.0000001));
    GcodeEmitter em;
    QString g = em.emitProgram(tp);
    QVERIFY(!g.contains("-0.000"));
}

void TstCadCam::emitterPenMode()
{
    CamParams cp;
    cp.cutDepth = 1.0;
    cp.tool.stepdown = 0.0;
    Polyline sq = makeRect(Point(0, 0), 10, 10);
    Toolpath tp = engrave(sq, cp);

    EmitterOptions opt;
    opt.zMode = ZMode::Pen;
    opt.penUpZ = 3.0;
    opt.penDownZ = 0.0;
    opt.useSpindle = true; // should be ignored in pen mode
    GcodeEmitter em(opt);
    QString g = em.emitProgram(tp);

    QVERIFY(!g.contains("M3 S")); // no spindle start in pen mode (M30 is fine)
    QVERIFY(!g.contains("M5"));   // no spindle stop either
    QVERIFY(g.contains("Z3.000")); // pen up
    QVERIFY(g.contains("Z0.000")); // pen down
}

void TstCadCam::emitterFeedSurvivesSkippedMove()
{
    // A zero-length cutting move between a plunge (feedZ) and a feed (feedXY)
    // must be skipped WITHOUT swallowing the feedXY word on the next real move.
    Toolpath tp;
    tp.rapid(QVector3D(0, 0, 5));
    tp.plunge(QVector3D(0, 0, -1));   // feedZ = 200
    tp.feed(QVector3D(0, 0, -1));     // zero-length -> skipped
    tp.feed(QVector3D(10, 0, -1));    // feedXY = 600 -> must emit F600

    EmitterOptions opt;
    opt.feedXY = 600;
    opt.feedZ = 200;
    GcodeEmitter em(opt);
    QString g = em.emitProgram(tp);

    QVERIFY(g.contains("F200.000")); // plunge feed
    QVERIFY(g.contains("F600.000")); // cutting feed survived the skipped move
}

// ---------------------------------------------------------------------------
// dxf
// ---------------------------------------------------------------------------

static QString sampleDxf()
{
    QStringList d = {
        "0","SECTION","2","ENTITIES",
        "0","LINE","8","0","10","0.0","20","0.0","11","10.0","21","0.0",
        "0","CIRCLE","8","0","10","5.0","20","5.0","40","2.5",
        "0","ARC","8","0","10","0.0","20","0.0","40","5.0","50","0.0","51","90.0",
        "0","LWPOLYLINE","8","0","90","4","70","1",
        "10","0.0","20","0.0",
        "10","10.0","20","0.0",
        "10","10.0","20","10.0",
        "10","0.0","20","10.0",
        "0","ENDSEC","0","EOF"
    };
    return d.join('\n');
}

void TstCadCam::dxfImportEntities()
{
    DxfImporter imp;
    Drawing dwg;
    QString err;
    QVERIFY2(imp.importString(sampleDxf(), dwg, &err), qPrintable(err));
    QCOMPARE(dwg.size(), 4);

    QCOMPARE(dwg.entities[0].type, Entity::Line);
    QVERIFY(fuzzy(dwg.entities[0].p2.x(), 10.0));

    QCOMPARE(dwg.entities[1].type, Entity::Circle);
    QVERIFY(fuzzy(dwg.entities[1].radius, 2.5));
    QVERIFY(fuzzy(dwg.entities[1].center.x(), 5.0));

    QCOMPARE(dwg.entities[2].type, Entity::Arc);
    QVERIFY(fuzzy(dwg.entities[2].radius, 5.0));
}

void TstCadCam::dxfClosedPolyline()
{
    DxfImporter imp;
    Drawing dwg;
    QVERIFY(imp.importString(sampleDxf(), dwg, nullptr));
    const Entity &poly = dwg.entities[3];
    QCOMPARE(poly.type, Entity::PolylineEntity);
    QVERIFY(poly.polyline.closed);
    QCOMPARE(poly.polyline.size(), 4);
    BBox b = poly.bounds();
    QVERIFY(fuzzy(b.width(), 10.0) && fuzzy(b.height(), 10.0));
}

// ---------------------------------------------------------------------------
// soldering
// ---------------------------------------------------------------------------

void TstCadCam::solderPreSolderFeedsBeforeTouch()
{
    SolderPoint pt;
    pt.x = 10; pt.y = 20; pt.freeZ = 5; pt.touchZ = -1;
    pt.type = SolderFeedType::PreSolder;
    pt.feedSeconds = 0.8;
    SolderingGenerator gen;
    QString g = gen.generate({pt}, SolderingParams());

    // Feeder must run (M3 .. M5) BEFORE the touch-down (G1 Z..).
    int feedOn = g.indexOf("M3");
    int touch  = g.indexOf("G1 Z");
    QVERIFY(feedOn >= 0 && touch >= 0);
    QVERIFY(feedOn < touch);
    QVERIFY(g.contains("G4 P0.800"));      // feed time
    QVERIFY(g.contains("G1 Z-1.000"));     // touch-down uses touchZ
    QVERIFY(g.contains("G0 Z5.000"));      // travel/retract uses freeZ
}

void TstCadCam::solderTouchDownFeedsAfterTouch()
{
    SolderPoint pt;
    pt.x = 5; pt.y = 5; pt.freeZ = 4; pt.touchZ = -0.5;
    pt.type = SolderFeedType::TouchDown;
    pt.feedSeconds = 1.2;
    SolderingGenerator gen;
    QString g = gen.generate({pt}, SolderingParams());

    // Touch-down (G1 Z..) must come BEFORE the feeder runs (M3).
    int touch  = g.indexOf("G1 Z");
    int feedOn = g.indexOf("M3");
    QVERIFY(feedOn >= 0 && touch >= 0);
    QVERIFY(touch < feedOn);
    QVERIFY(g.contains("G4 P1.200"));
    QVERIFY(g.contains("G1 Z-0.500"));     // touch-down uses touchZ
    QVERIFY(g.contains("G0 Z4.000"));      // travel/retract uses freeZ
}

void TstCadCam::solderProgramSafety()
{
    SolderPoint a, b;
    a.type = SolderFeedType::PreSolder;
    a.freeZ = 6; a.touchZ = -1;
    b.type = SolderFeedType::TouchDown;
    b.freeZ = 6; b.touchZ = -2;
    SolderingParams params;
    params.safeZ = 5.0;
    SolderingGenerator gen;
    QString g = gen.generate({a, b}, params);

    QVERIFY(g.contains("G21"));
    QVERIFY(g.contains("G90"));
    QVERIFY(g.contains("M30"));
    // Per-point touch-down uses touchZ; travel uses freeZ.
    QVERIFY(g.contains("G1 Z-1.000"));
    QVERIFY(g.contains("G1 Z-2.000"));
    QVERIFY(g.contains("G0 Z6.000"));
    // Feeder must end OFF and the program must finish at the program safe Z.
    const QStringList lines = g.split('\n', Qt::SkipEmptyParts);
    QVERIFY(lines.size() >= 3);
    QCOMPARE(lines.last(), QStringLiteral("M30"));
    QCOMPARE(lines[lines.size() - 2], QStringLiteral("M5"));
    QCOMPARE(lines[lines.size() - 3], QStringLiteral("G0 Z5.000"));
}

// ---------------------------------------------------------------------------
// stroke font (writing)
// ---------------------------------------------------------------------------

void TstCadCam::strokeFontBuiltinHasGlyphs()
{
    StrokeFont f = StrokeFont::builtin();
    QVERIFY(f.hasGlyph('A'));
    QVERIFY(f.glyph('A') != nullptr);
    QVERIFY(!f.glyph('A')->strokes.isEmpty());
    QVERIFY(f.hasGlyph('5'));
    QVERIFY(!f.hasGlyph(QChar(0x2603)));   // snowman: absent
}

void TstCadCam::strokeFontLayout()
{
    StrokeFont f = StrokeFont::builtin();
    QVector<Polyline> one = f.layout("A", 10.0, 1.5, 0.0, 0);
    QVERIFY(!one.isEmpty());
    BBox b1;
    for (const Polyline &p : one) b1.expand(p.bounds());
    QVERIFY(b1.isValid());
    QVERIFY(b1.height() > 4.0 && b1.height() < 13.0);  // ~capHeight*10mm

    QVector<Polyline> two = f.layout("A\nB", 10.0, 1.5, 0.0, 0);
    BBox b2;
    for (const Polyline &p : two) b2.expand(p.bounds());
    QVERIFY(b2.height() > b1.height());   // a second line is taller
}

void TstCadCam::strokeFontJsonRoundTrip()
{
    QString path = QDir::tempPath() + "/hjlabs_testfont.json";
    QFile fjson(path);
    QVERIFY(fjson.open(QIODevice::WriteOnly));
    fjson.write("{\"name\":\"T\",\"capHeight\":0.5,\"glyphs\":"
                "{\"I\":{\"advance\":0.3,\"strokes\":[[[0,0],[0,0.5]]]}}}");
    fjson.close();

    StrokeFont f;
    QString err;
    QVERIFY2(f.loadJson(path, &err), qPrintable(err));
    QCOMPARE(f.name(), QStringLiteral("T"));
    QVERIFY(f.hasGlyph('I'));
    QVERIFY(!f.layout("I", 10.0, 1.5, 0.0, 0).isEmpty());
    QFile::remove(path);
}

// ---------------------------------------------------------------------------
// pcb
// ---------------------------------------------------------------------------

void TstCadCam::gerberParseBasic()
{
    QString g =
        "%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\n"
        "D10*\nX0Y0D03*\nX50000Y0D03*\n"
        "X0Y0D02*\nX50000Y0D01*\nM02*\n";
    GerberImporter imp;
    GerberData data;
    QString err;
    QVERIFY2(imp.importString(g, data, &err), qPrintable(err));
    QVERIFY(!data.isEmpty());
    QCOMPARE(data.pads.size(), 2);            // two flashes
    QVERIFY(data.traces.size() >= 1);         // one draw
    QVERIFY(fuzzy(data.traces.first().second, 1.0, 1e-3));  // aperture width
    QVERIFY(data.bounds().isValid());
}

void TstCadCam::excellonParseBasic()
{
    QString e =
        "M48\nMETRIC\nT1C0.80\n%\nT1\nX10.0Y10.0\nX20.0Y10.0\nM30\n";
    ExcellonImporter imp;
    ExcellonData data;
    QString err;
    QVERIFY2(imp.importString(e, data, &err), qPrintable(err));
    QCOMPARE(data.hits.size(), 2);
    QVERIFY(fuzzy(data.hits.first().diameter, 0.80, 1e-3));
    QCOMPARE(data.toolDiameters().size(), 1);
}

void TstCadCam::pcbToolpathsNonEmpty()
{
    GerberData g;
    g.pads.append(makeRect(Point(0, 0), 2, 2));
    Tool t;
    t.diameter = 0.5;
    t.stepover = 0.5;
    Toolpath iso = isolationRoutes(g, t, 5.0, -0.1, 1);
    QVERIFY(!iso.isEmpty());

    ExcellonData d;
    d.hits.append({Point(1, 1), 0.8});
    d.hits.append({Point(5, 1), 0.8});
    Toolpath dr = drillHits(d, 5.0, -1.6, 100.0);
    QVERIFY(!dr.isEmpty());
    QVERIFY(dr.cutLength() >= 0.0);

    Toolpath co = boardCutout(makeRect(Point(0, 0), 20, 20), t, 5.0, 1.6);
    QVERIFY(!co.isEmpty());
}

QTEST_MAIN(TstCadCam)
#include "tst_cadcam.moc"
