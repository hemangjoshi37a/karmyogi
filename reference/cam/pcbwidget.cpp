// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "cam/pcbwidget.h"

#include <QComboBox>
#include <QCheckBox>
#include <QDoubleSpinBox>
#include <QSpinBox>
#include <QPlainTextEdit>
#include <QLabel>
#include <QPushButton>
#include <QToolButton>
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

#include "cadcam/pcbcam.h"
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

PcbWidget::PcbWidget(QWidget *parent) : QWidget(parent)
{
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

    // ---- Inputs ----------------------------------------------------------
    auto *inBox = new QGroupBox(tr("Input files"));
    auto *inLayout = new QVBoxLayout(inBox);

    auto *gRow = new QHBoxLayout();
    auto *btnGerber = new QPushButton(tr("Load Gerber (copper)…"));
    gRow->addWidget(btnGerber);
    inLayout->addLayout(gRow);
    m_gerberInfo = new QLabel(tr("No copper layer loaded."));
    m_gerberInfo->setWordWrap(true);
    inLayout->addWidget(m_gerberInfo);

    auto *dRow = new QHBoxLayout();
    auto *btnExc = new QPushButton(tr("Load Excellon (drill)…"));
    dRow->addWidget(btnExc);
    inLayout->addLayout(dRow);
    m_drillInfo = new QLabel(tr("No drill file loaded."));
    m_drillInfo->setWordWrap(true);
    inLayout->addWidget(m_drillInfo);
    root->addWidget(inBox);

    // ---- Stages ----------------------------------------------------------
    auto *stageBox = new QGroupBox(tr("Stages"));
    auto *stageLayout = new QVBoxLayout(stageBox);
    m_doIsolation = new QCheckBox(tr("Isolation routing (copper)"));
    m_doDrill = new QCheckBox(tr("Drill holes"));
    m_doCutout = new QCheckBox(tr("Board cutout (outline)"));
    m_doIsolation->setChecked(true);
    m_doDrill->setChecked(true);
    m_doCutout->setChecked(false);
    stageLayout->addWidget(m_doIsolation);
    stageLayout->addWidget(m_doDrill);
    stageLayout->addWidget(m_doCutout);
    root->addWidget(stageBox);

    // ---- Parameters ------------------------------------------------------
    auto *paramBox = new QGroupBox(tr("Parameters"));
    auto *form = new QFormLayout(paramBox);

    m_zmode = new QComboBox();
    m_zmode->addItems({tr("Spindle (mill)"), tr("Pen (plotter)")});
    form->addRow(tr("Z mode"), m_zmode);

    m_toolDia     = makeSpin(0.05, 6.0, 0.2, 0.05, 3, tr(" mm"));   // V-bit / engraver
    m_passes      = new QSpinBox();
    m_passes->setRange(1, 8);
    m_passes->setValue(1);
    m_stepover    = makeSpin(0.05, 3.0, 0.15, 0.05, 3, tr(" mm"));
    m_safeZ       = makeSpin(0.5, 50.0, 3.0, 0.5, 2, tr(" mm"));
    m_copperZ     = makeSpin(-5.0, 0.0, -0.1, 0.01, 3, tr(" mm"));
    m_drillZ      = makeSpin(-10.0, 0.0, -1.8, 0.1, 2, tr(" mm"));
    m_cutoutDepth = makeSpin(0.1, 10.0, 1.6, 0.1, 2, tr(" mm"));
    m_feedXY      = makeSpin(1.0, 10000.0, 200.0, 10.0, 0, tr(" mm/min"));
    m_feedZ       = makeSpin(1.0, 10000.0, 60.0, 10.0, 0, tr(" mm/min"));
    m_rpm         = makeSpin(0.0, 60000.0, 12000.0, 500.0, 0, tr(" rpm"));

    form->addRow(tr("Tool Ø"), m_toolDia);
    form->addRow(tr("Isolation passes"), m_passes);
    form->addRow(tr("Pass stepover"), m_stepover);
    form->addRow(tr("Safe Z"), m_safeZ);
    form->addRow(tr("Copper cut Z"), m_copperZ);
    form->addRow(tr("Drill Z"), m_drillZ);
    form->addRow(tr("Cutout depth"), m_cutoutDepth);
    form->addRow(tr("Feed XY"), m_feedXY);
    form->addRow(tr("Feed Z"), m_feedZ);
    form->addRow(tr("Spindle"), m_rpm);
    root->addWidget(paramBox);

    m_livePreview = new QCheckBox(tr("Live preview (auto-update 3D)"));
    root->addWidget(m_livePreview);

    auto *btnGen = new QPushButton(tr("Generate NC code"));
    btnGen->setProperty("accent", true);
    root->addWidget(btnGen);

    m_preview = new QPlainTextEdit();
    m_preview->setReadOnly(true);
    QFont mono("monospace");
    mono.setStyleHint(QFont::TypeWriter);
    m_preview->setFont(mono);
    m_preview->setPlaceholderText(tr("Generated G-code preview will appear here."));
    root->addWidget(m_preview, 1);

    connect(btnGerber, &QPushButton::clicked, this, &PcbWidget::loadGerber);
    connect(btnExc, &QPushButton::clicked, this, &PcbWidget::loadExcellon);
    connect(btnGen, &QPushButton::clicked, this, &PcbWidget::generate);

    // ---- Live preview: debounced auto-regeneration -----------------------
    m_liveTimer = new QTimer(this);
    m_liveTimer->setSingleShot(true);
    m_liveTimer->setInterval(250);
    connect(m_liveTimer, &QTimer::timeout, this, &PcbWidget::generate);

    connect(m_livePreview, &QCheckBox::toggled, this, &PcbWidget::scheduleLivePreview);

    const QList<QCheckBox*> checks = {m_doIsolation, m_doDrill, m_doCutout};
    for (QCheckBox *c : checks)
        connect(c, &QCheckBox::toggled, this, &PcbWidget::scheduleLivePreview);
    connect(m_zmode, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &PcbWidget::scheduleLivePreview);
    connect(m_passes, QOverload<int>::of(&QSpinBox::valueChanged),
            this, &PcbWidget::scheduleLivePreview);
    const QList<QDoubleSpinBox*> spins = {m_toolDia, m_stepover, m_safeZ, m_copperZ,
                                          m_drillZ, m_cutoutDepth, m_feedXY, m_feedZ, m_rpm};
    for (QDoubleSpinBox *s : spins)
        connect(s, QOverload<double>::of(&QDoubleSpinBox::valueChanged),
                this, &PcbWidget::scheduleLivePreview);

    // Automated visual-test hook (no effect unless the env var is set):
    //   HJLABS_PCB_AUTODEMO=1 -> synthesize tiny copper+drill data and generate.
    if (qEnvironmentVariableIsSet("HJLABS_PCB_AUTODEMO")) {
        QTimer::singleShot(600, this, [this]() {
            loadDemoData();
            generate();
        });
    }

    applyZoom();   // apply default 100% zoom and announce it to the title bar
}

void PcbWidget::zoomIn()    { m_zoom = qMin(2.0, m_zoom + 0.1); applyZoom(); }
void PcbWidget::zoomOut()   { m_zoom = qMax(0.5, m_zoom - 0.1); applyZoom(); }
void PcbWidget::zoomReset() { m_zoom = 1.0; applyZoom(); }

void PcbWidget::applyZoom()
{
    // Scale via a widget stylesheet font-size. setFont() is useless here because
    // the global app stylesheet sets `QWidget { font-size: Npt }`, which always
    // overrides setFont(). The `*` selector forces the size onto every
    // descendant control in this panel's subtree.
    int pt = qBound(6, int(qRound(10.0 * m_zoom)), 28);
    setStyleSheet(QString("* { font-size: %1pt; }").arg(pt));
    emit zoomChanged(int(qRound(m_zoom * 100.0)));
}

void PcbWidget::scheduleLivePreview()
{
    if (m_livePreview && m_livePreview->isChecked())
        m_liveTimer->start();
}

void PcbWidget::loadDemoData()
{
    // Two pads + one trace + two holes, entirely in-memory (no files needed).
    m_gerber = GerberData();
    m_gerber.pads.append(makeCircle(Point(2, 2), 0.8));
    m_gerber.pads.append(makeCircle(Point(10, 2), 0.8));
    Polyline trace;
    trace.add(Point(2, 2));
    trace.add(Point(10, 2));
    m_gerber.traces.append(qMakePair(trace, 0.25));
    m_haveGerber = true;

    m_drill = ExcellonData();
    m_drill.hits.append({Point(2, 2), 0.8});
    m_drill.hits.append({Point(10, 2), 0.8});
    m_haveDrill = true;

    updateInfo();
}

void PcbWidget::updateInfo()
{
    if (m_haveGerber) {
        BBox b = m_gerber.bounds();
        m_gerberInfo->setText(tr("Copper: %1 traces, %2 pads, %3 regions; extents %4 × %5 mm")
                                  .arg(m_gerber.traces.size())
                                  .arg(m_gerber.pads.size())
                                  .arg(m_gerber.regions.size())
                                  .arg(b.width(), 0, 'f', 2)
                                  .arg(b.height(), 0, 'f', 2));
    } else {
        m_gerberInfo->setText(tr("No copper layer loaded."));
    }
    if (m_haveDrill) {
        m_drillInfo->setText(tr("Drill: %1 hits, %2 distinct tools")
                                 .arg(m_drill.hits.size())
                                 .arg(m_drill.toolDiameters().size()));
    } else {
        m_drillInfo->setText(tr("No drill file loaded."));
    }
    scheduleLivePreview();
}

void PcbWidget::loadGerber()
{
    QString path = QFileDialog::getOpenFileName(
        this, tr("Import Gerber"), QString(),
        tr("Gerber files (*.gbr *.ger *.gtl *.gbl *.art);;All files (*.*)"));
    if (path.isEmpty()) return;

    GerberImporter imp;
    GerberData data;
    QString err;
    if (!imp.importFile(path, data, &err)) {
        m_gerberInfo->setText(tr("Gerber import failed: %1").arg(err));
        emit statusMessage(tr("Gerber import failed: %1").arg(err));
        return;
    }
    m_gerber = data;
    m_haveGerber = true;
    updateInfo();
    if (!imp.warnings().isEmpty())
        emit statusMessage(imp.warnings().join("; "));
}

void PcbWidget::loadExcellon()
{
    QString path = QFileDialog::getOpenFileName(
        this, tr("Import Excellon"), QString(),
        tr("Excellon files (*.drl *.xln *.txt *.nc);;All files (*.*)"));
    if (path.isEmpty()) return;

    ExcellonImporter imp;
    ExcellonData data;
    QString err;
    if (!imp.importFile(path, data, &err)) {
        m_drillInfo->setText(tr("Excellon import failed: %1").arg(err));
        emit statusMessage(tr("Excellon import failed: %1").arg(err));
        return;
    }
    m_drill = data;
    m_haveDrill = true;
    updateInfo();
    if (!imp.warnings().isEmpty())
        emit statusMessage(imp.warnings().join("; "));
}

void PcbWidget::generate()
{
    Tool tool;
    tool.diameter = m_toolDia->value();
    tool.stepover = m_stepover->value();   // metric step (mm) for isolation passes
    tool.stepdown = m_cutoutDepth->value() > 0.6 ? 0.6 : m_cutoutDepth->value();
    tool.feedXY = m_feedXY->value();
    tool.feedZ = m_feedZ->value();
    tool.spindleRPM = m_rpm->value();

    const double safeZ = m_safeZ->value();

    QVector<Toolpath> paths;

    if (m_doIsolation->isChecked()) {
        if (!m_haveGerber) {
            emit statusMessage(tr("Load a Gerber copper layer for isolation routing."));
        } else {
            Toolpath iso = isolationRoutes(m_gerber, tool, safeZ, m_copperZ->value(),
                                           m_passes->value());
            if (!iso.isEmpty()) paths.append(iso);
        }
    }

    if (m_doDrill->isChecked()) {
        if (!m_haveDrill) {
            emit statusMessage(tr("Load an Excellon drill file for drilling."));
        } else {
            Toolpath drl = drillHits(m_drill, safeZ, m_drillZ->value(), tool.feedZ);
            if (!drl.isEmpty()) paths.append(drl);
        }
    }

    if (m_doCutout->isChecked()) {
        if (!m_haveGerber) {
            emit statusMessage(tr("Load a Gerber layer to derive the board outline for cutout."));
        } else {
            // Use the copper bounding box as a simple rectangular outline (v1).
            BBox b = m_gerber.bounds();
            if (b.isValid()) {
                Polyline outline = makeRect(b.min, b.width(), b.height());
                Toolpath cut = boardCutout(outline, tool, safeZ, m_cutoutDepth->value());
                if (!cut.isEmpty()) paths.append(cut);
            }
        }
    }

    // Drop empties.
    QVector<Toolpath> nonEmpty;
    for (const Toolpath &t : paths)
        if (!t.isEmpty()) nonEmpty.append(t);

    if (nonEmpty.isEmpty()) {
        m_preview->setPlainText(QString());
        emit statusMessage(tr("No toolpaths generated. Load inputs and select stages."));
        return;
    }

    EmitterOptions opt;
    opt.safeZ = safeZ;
    opt.feedXY = tool.feedXY;
    opt.feedZ = tool.feedZ;
    opt.spindleRPM = tool.spindleRPM;
    bool pen = (m_zmode->currentIndex() == 1);
    opt.zMode = pen ? ZMode::Pen : ZMode::Spindle;
    opt.useSpindle = !pen;
    opt.penUpZ = safeZ;
    opt.penDownZ = 0.0;
    opt.programName = QStringLiteral("hjLabs PCB");

    GcodeEmitter emitter(opt);
    QString gcode = emitter.emitProgram(nonEmpty);
    m_preview->setPlainText(gcode);

    double cut = 0.0;
    for (const Toolpath &t : nonEmpty) cut += t.cutLength();
    emit statusMessage(tr("Generated %1 PCB stage(s), cut %2 mm")
                           .arg(nonEmpty.size()).arg(cut, 0, 'f', 1));

    emit programGenerated(gcode.split('\n'));
}
