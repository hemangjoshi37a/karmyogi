// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "cam/cadcamwidget.h"

#include <QComboBox>
#include <QDoubleSpinBox>
#include <QPlainTextEdit>
#include <QLabel>
#include <QPushButton>
#include <QToolButton>
#include <QCheckBox>
#include <QFormLayout>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QGroupBox>
#include <QFileDialog>
#include <QFileInfo>
#include <QFont>
#include <QApplication>
#include <QEvent>
#include <QTimer>
#include <QScrollArea>

#include "cadcam/dxfimporter.h"
#include "cadcam/camoperations.h"
#include "cadcam/gcodeemitter.h"

using namespace cadcam;

namespace {
QDoubleSpinBox *makeSpin(double min, double max, double val, double step, int decimals,
                         const QString &suffix)
{
    auto *s = new QDoubleSpinBox();
    // Decimals MUST be set before the value, otherwise the value is rounded to
    // the default 2-decimal precision first (e.g. 3.175 -> 3.17).
    s->setDecimals(decimals);
    s->setRange(min, max);
    s->setSingleStep(step);
    s->setValue(val);
    if (!suffix.isEmpty()) s->setSuffix(suffix);
    return s;
}
}

CadCamWidget::CadCamWidget(QWidget *parent) : QWidget(parent)
{
    // Host everything in a scroll area so the panel stays usable when the dock
    // is made small (controls scroll instead of being clipped).
    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto *scroll = new QScrollArea(this);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    outer->addWidget(scroll);
    auto *content = new QWidget(scroll);
    scroll->setWidget(content);

    auto *root = new QVBoxLayout(content);
    root->setContentsMargins(6, 6, 6, 6);

    // ---- Source ----------------------------------------------------------
    auto *srcRow = new QHBoxLayout();
    auto *btnDxf = new QPushButton(tr("Load DXF…"));
    auto *btnDemo = new QPushButton(tr("Demo shape"));
    srcRow->addWidget(btnDxf);
    srcRow->addWidget(btnDemo);
    root->addLayout(srcRow);

    m_info = new QLabel(tr("No geometry loaded."));
    m_info->setWordWrap(true);
    root->addWidget(m_info);

    // ---- Operation -------------------------------------------------------
    auto *opBox = new QGroupBox(tr("Operation"));
    auto *form = new QFormLayout(opBox);

    m_operation = new QComboBox();
    m_operation->addItems({tr("Engrave (follow)"),
                           tr("Profile outside"),
                           tr("Profile inside"),
                           tr("Profile on line"),
                           tr("Pocket (clear)")});
    form->addRow(tr("Type"), m_operation);

    m_zmode = new QComboBox();
    m_zmode->addItems({tr("Spindle (mill)"), tr("Pen (plotter)")});
    form->addRow(tr("Z mode"), m_zmode);

    m_toolDia  = makeSpin(0.1, 50.0, 3.175, 0.1, 3, tr(" mm"));
    m_stepover = makeSpin(0.05, 1.0, 0.45, 0.05, 2, QString());
    m_stepdown = makeSpin(0.0, 50.0, 1.0, 0.1, 2, tr(" mm"));
    m_cutDepth = makeSpin(0.0, 100.0, 2.0, 0.1, 2, tr(" mm"));
    m_safeZ    = makeSpin(0.5, 50.0, 5.0, 0.5, 2, tr(" mm"));
    m_feedXY   = makeSpin(1.0, 10000.0, 600.0, 10.0, 0, tr(" mm/min"));
    m_feedZ    = makeSpin(1.0, 10000.0, 200.0, 10.0, 0, tr(" mm/min"));
    m_rpm      = makeSpin(0.0, 60000.0, 10000.0, 500.0, 0, tr(" rpm"));

    form->addRow(tr("Tool Ø"), m_toolDia);
    form->addRow(tr("Stepover"), m_stepover);
    form->addRow(tr("Stepdown"), m_stepdown);
    form->addRow(tr("Cut depth"), m_cutDepth);
    form->addRow(tr("Safe Z"), m_safeZ);
    form->addRow(tr("Feed XY"), m_feedXY);
    form->addRow(tr("Feed Z"), m_feedZ);
    form->addRow(tr("Spindle"), m_rpm);
    root->addWidget(opBox);

    m_livePreview = new QCheckBox(tr("Live preview (auto-update 3D)"));
    root->addWidget(m_livePreview);

    auto *btnGen = new QPushButton(tr("Generate G-code"));
    btnGen->setProperty("accent", true);
    root->addWidget(btnGen);

    m_preview = new QPlainTextEdit();
    m_preview->setReadOnly(true);
    QFont mono("monospace");
    mono.setStyleHint(QFont::TypeWriter);
    m_preview->setFont(mono);
    m_preview->setPlaceholderText(tr("Generated G-code preview will appear here."));
    root->addWidget(m_preview, 1);

    connect(btnDxf, &QPushButton::clicked, this, &CadCamWidget::loadDxf);
    connect(btnDemo, &QPushButton::clicked, this, &CadCamWidget::loadDemo);
    connect(btnGen, &QPushButton::clicked, this, &CadCamWidget::generate);

    // ---- Live preview: debounced auto-regeneration -----------------------
    m_liveTimer = new QTimer(this);
    m_liveTimer->setSingleShot(true);
    m_liveTimer->setInterval(250);
    connect(m_liveTimer, &QTimer::timeout, this, &CadCamWidget::generate);

    // Toggling live preview ON immediately previews the current state.
    connect(m_livePreview, &QCheckBox::toggled, this, &CadCamWidget::scheduleLivePreview);

    // Any parameter change reschedules a debounced regeneration.
    connect(m_operation, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &CadCamWidget::scheduleLivePreview);
    connect(m_zmode, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &CadCamWidget::scheduleLivePreview);
    const QList<QDoubleSpinBox*> spins = {m_toolDia, m_stepover, m_stepdown, m_cutDepth,
                                          m_safeZ, m_feedXY, m_feedZ, m_rpm};
    for (QDoubleSpinBox *s : spins)
        connect(s, QOverload<double>::of(&QDoubleSpinBox::valueChanged),
                this, &CadCamWidget::scheduleLivePreview);

    // Automated visual-test hook (no effect unless the env var is set):
    //   HJLABS_CADCAM_AUTODEMO=1  -> load the demo shape and generate G-code
    //   HJLABS_CADCAM_OP=<0..4>   -> select the operation before generating
    if (qEnvironmentVariableIsSet("HJLABS_CADCAM_AUTODEMO")) {
        int op = qEnvironmentVariableIntValue("HJLABS_CADCAM_OP");
        QTimer::singleShot(600, this, [this, op]() {
            loadDemo();
            m_operation->setCurrentIndex(qBound(0, op, m_operation->count() - 1));
            generate();
        });
    }

    applyZoom();   // apply default 100% zoom and announce it to the title bar
}

void CadCamWidget::zoomIn()    { m_zoom = qMin(2.0, m_zoom + 0.1); applyZoom(); }
void CadCamWidget::zoomOut()   { m_zoom = qMax(0.5, m_zoom - 0.1); applyZoom(); }
void CadCamWidget::zoomReset() { m_zoom = 1.0; applyZoom(); }

void CadCamWidget::applyZoom()
{
    // Scale via a widget stylesheet font-size. setFont() is useless here because
    // the global app stylesheet sets `QWidget { font-size: Npt }`, and a QSS
    // font-size always overrides setFont(). The `*` selector forces the size
    // onto every descendant control in this panel's subtree.
    int pt = qBound(6, int(qRound(10.0 * m_zoom)), 28);
    setStyleSheet(QString("* { font-size: %1pt; }").arg(pt));
    emit zoomChanged(int(qRound(m_zoom * 100.0)));
}

void CadCamWidget::scheduleLivePreview()
{
    if (m_livePreview && m_livePreview->isChecked())
        m_liveTimer->start();
}

void CadCamWidget::setDrawing(const Drawing &drawing, const QString &source)
{
    m_drawing = drawing;
    m_source = source;
    updateInfo();
    scheduleLivePreview();
}

void CadCamWidget::updateInfo()
{
    if (m_drawing.isEmpty()) {
        m_info->setText(tr("No geometry loaded."));
        return;
    }
    BBox b = m_drawing.bounds();
    int closed = 0;
    for (const Entity &e : m_drawing.entities)
        if (e.isClosed()) ++closed;
    m_info->setText(tr("%1: %2 entities (%3 closed), extents %4 × %5 mm")
                        .arg(m_source)
                        .arg(m_drawing.size())
                        .arg(closed)
                        .arg(b.width(), 0, 'f', 2)
                        .arg(b.height(), 0, 'f', 2));
}

void CadCamWidget::loadDxf()
{
    QString path = QFileDialog::getOpenFileName(
        this, tr("Import DXF"), QString(), tr("DXF files (*.dxf);;All files (*.*)"));
    if (path.isEmpty()) return;

    DxfImporter imp;
    Drawing dwg;
    QString err;
    if (!imp.importFile(path, dwg, &err)) {
        m_info->setText(tr("DXF import failed: %1").arg(err));
        emit statusMessage(tr("DXF import failed: %1").arg(err));
        return;
    }
    setDrawing(dwg, QFileInfo(path).fileName());
    if (!imp.warnings().isEmpty())
        emit statusMessage(imp.warnings().join("; "));
}

void CadCamWidget::loadDemo()
{
    // A rectangle with an interior circle and an open zig-zag — exercises
    // closed-profile/pocket paths and open-engrave paths together.
    Drawing dwg;
    dwg.add(Entity::makePolyline(makeRect(Point(0, 0), 40, 30), "demo"));
    dwg.add(Entity::makeCircle(Point(20, 15), 6, "demo"));
    Polyline zig;
    zig.add(Point(5, 5));
    zig.add(Point(12, 25));
    zig.add(Point(20, 5));
    zig.add(Point(28, 25));
    zig.add(Point(35, 5));
    dwg.add(Entity::makePolyline(zig, "demo"));
    setDrawing(dwg, tr("Demo shape"));
}

void CadCamWidget::generate()
{
    if (m_drawing.isEmpty()) {
        m_info->setText(tr("Load a DXF or a demo shape first."));
        return;
    }

    CamParams p;
    p.tool.diameter = m_toolDia->value();
    p.tool.stepover = m_stepover->value();
    p.tool.stepdown = m_stepdown->value();
    p.tool.feedXY = m_feedXY->value();
    p.tool.feedZ = m_feedZ->value();
    p.tool.spindleRPM = m_rpm->value();
    p.safeZ = m_safeZ->value();
    p.surfaceZ = 0.0;
    p.cutDepth = m_cutDepth->value();

    const int op = m_operation->currentIndex();
    const QVector<Polyline> polys = m_drawing.flatten();

    QVector<Toolpath> paths;
    for (const Polyline &pl : polys) {
        if (pl.size() < 2) continue;

        switch (op) {
        case 0: // engrave
            paths.append(engrave(pl, p));
            break;
        case 1: // profile outside
        case 2: // profile inside
        case 3: // profile on
            if (pl.closed && pl.size() >= 3) {
                ProfileSide side = (op == 1) ? ProfileSide::Outside
                                  : (op == 2) ? ProfileSide::Inside
                                              : ProfileSide::On;
                paths.append(profile(pl, side, p));
            } else {
                paths.append(engrave(pl, p)); // open paths can only be followed
            }
            break;
        case 4: // pocket
            if (pl.closed && pl.size() >= 3)
                paths.append(pocket(pl, p));
            break;
        }
    }

    // Drop empty toolpaths.
    QVector<Toolpath> nonEmpty;
    for (const Toolpath &t : paths)
        if (!t.isEmpty()) nonEmpty.append(t);

    if (nonEmpty.isEmpty()) {
        m_info->setText(tr("Operation produced no toolpaths (tool too large, or no "
                           "closed contours for profile/pocket?)."));
        return;
    }

    EmitterOptions opt;
    opt.safeZ = p.safeZ;
    opt.feedXY = p.tool.feedXY;
    opt.feedZ = p.tool.feedZ;
    opt.spindleRPM = p.tool.spindleRPM;
    bool pen = (m_zmode->currentIndex() == 1);
    opt.zMode = pen ? ZMode::Pen : ZMode::Spindle;
    opt.useSpindle = !pen;
    opt.penUpZ = p.safeZ;
    opt.penDownZ = 0.0;
    opt.programName = QStringLiteral("hjLabs CAD/CAM — %1").arg(m_operation->currentText());

    GcodeEmitter emitter(opt);
    QString gcode = emitter.emitProgram(nonEmpty);

    m_preview->setPlainText(gcode);

    double cut = 0.0, rapid = 0.0;
    for (const Toolpath &t : nonEmpty) { cut += t.cutLength(); rapid += t.rapidLength(); }
    emit statusMessage(tr("Generated %1 toolpath(s), cut %2 mm")
                           .arg(nonEmpty.size()).arg(cut, 0, 'f', 1));

    const QStringList lines = gcode.split('\n');
    emit programGenerated(lines);
}
