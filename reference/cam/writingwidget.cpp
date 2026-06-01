// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "cam/writingwidget.h"

#include <QComboBox>
#include <QDoubleSpinBox>
#include <QPlainTextEdit>
#include <QLabel>
#include <QPushButton>
#include <QToolButton>
#include <QCheckBox>
#include <QGroupBox>
#include <QFormLayout>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QScrollArea>
#include <QFileDialog>
#include <QFont>
#include <QApplication>
#include <QEvent>
#include <QTimer>

#include "cadcam/strokefont.h"
#include "cadcam/camoperations.h"
#include "cadcam/gcodeemitter.h"

using namespace cadcam;

namespace {
QDoubleSpinBox *makeSpin(double min, double max, double val, double step,
                         int decimals, const QString &suffix)
{
    auto *s = new QDoubleSpinBox();
    s->setDecimals(decimals);     // decimals before value (avoids rounding)
    s->setRange(min, max);
    s->setSingleStep(step);
    s->setValue(val);
    if (!suffix.isEmpty()) s->setSuffix(suffix);
    return s;
}
}

WritingWidget::WritingWidget(QWidget *parent) : QWidget(parent)
{
    m_font = StrokeFont::builtin();

    // Outer layout holds a scroll area so the panel stays narrow on small screens.
    auto *outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);

    auto *scroll = new QScrollArea(this);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    outer->addWidget(scroll);

    auto *content = new QWidget();
    scroll->setWidget(content);

    auto *root = new QVBoxLayout(content);
    root->setContentsMargins(6, 6, 6, 6);

    auto *intro = new QLabel(
        tr("Type text below; it is rendered with a single-stroke vector font and "
           "emitted as pen-plotter G-code (Z = pen up/down)."));
    intro->setWordWrap(true);
    root->addWidget(intro);

    // ---- Text ------------------------------------------------------------
    auto *textBox = new QGroupBox(tr("Text"));
    auto *tv = new QVBoxLayout(textBox);
    m_text = new QPlainTextEdit();
    m_text->setPlaceholderText(tr("Type here. Use Enter for a new line."));
    m_text->setMinimumHeight(80);
    tv->addWidget(m_text);
    root->addWidget(textBox);

    // ---- Layout parameters ----------------------------------------------
    auto *layoutBox = new QGroupBox(tr("Layout"));
    auto *lf = new QFormLayout(layoutBox);
    m_charHeight    = makeSpin(0.5, 500.0, 10.0, 0.5, 2, tr(" mm"));
    m_lineSpacing   = makeSpin(0.5, 5.0, 1.5, 0.1, 2, QString());
    m_letterSpacing = makeSpin(0.0, 50.0, 1.0, 0.5, 2, tr(" mm"));
    m_originX       = makeSpin(-9999.0, 9999.0, 0.0, 1.0, 2, tr(" mm"));
    m_originY       = makeSpin(-9999.0, 9999.0, 0.0, 1.0, 2, tr(" mm"));
    m_align         = new QComboBox();
    m_align->addItems({tr("Left"), tr("Center"), tr("Right")});
    lf->addRow(tr("Char height"), m_charHeight);
    lf->addRow(tr("Line spacing"), m_lineSpacing);
    lf->addRow(tr("Letter spacing"), m_letterSpacing);
    lf->addRow(tr("Origin X"), m_originX);
    lf->addRow(tr("Origin Y"), m_originY);
    lf->addRow(tr("Alignment"), m_align);
    root->addWidget(layoutBox);

    // ---- Pen parameters --------------------------------------------------
    auto *penBox = new QGroupBox(tr("Pen"));
    auto *pf = new QFormLayout(penBox);
    m_penUpZ   = makeSpin(-50.0, 50.0, 5.0, 0.5, 2, tr(" mm"));
    m_penDownZ = makeSpin(-50.0, 50.0, 0.0, 0.5, 2, tr(" mm"));
    m_feed     = makeSpin(1.0, 20000.0, 1500.0, 50.0, 0, tr(" mm/min"));
    pf->addRow(tr("Pen up Z"), m_penUpZ);
    pf->addRow(tr("Pen down Z"), m_penDownZ);
    pf->addRow(tr("Feed"), m_feed);
    root->addWidget(penBox);

    // ---- Font ------------------------------------------------------------
    auto *fontBox = new QGroupBox(tr("Font"));
    auto *fontRow = new QHBoxLayout(fontBox);
    auto *btnFont = new QPushButton(tr("Load custom font…"));
    m_fontLabel = new QLabel(tr("Active font: %1").arg(m_font.name()));
    fontRow->addWidget(btnFont);
    fontRow->addWidget(m_fontLabel, 1);
    root->addWidget(fontBox);

    m_livePreview = new QCheckBox(tr("Live preview (auto-update 3D)"));
    root->addWidget(m_livePreview);

    auto *btnGen = new QPushButton(tr("Generate NC code"));
    btnGen->setProperty("accent", true);
    root->addWidget(btnGen);

    m_info = new QLabel(tr("Type text and press Generate."));
    m_info->setWordWrap(true);
    root->addWidget(m_info);

    m_preview = new QPlainTextEdit();
    m_preview->setReadOnly(true);
    QFont mono("monospace");
    mono.setStyleHint(QFont::TypeWriter);
    m_preview->setFont(mono);
    m_preview->setPlaceholderText(tr("Generated G-code preview will appear here."));
    m_preview->setMinimumHeight(80);
    root->addWidget(m_preview, 1);

    connect(btnFont, &QPushButton::clicked, this, &WritingWidget::loadCustomFont);
    connect(btnGen, &QPushButton::clicked, this, &WritingWidget::generate);

    // ---- Live preview: debounced auto-regeneration -----------------------
    m_liveTimer = new QTimer(this);
    m_liveTimer->setSingleShot(true);
    m_liveTimer->setInterval(250);
    connect(m_liveTimer, &QTimer::timeout, this, &WritingWidget::generate);

    connect(m_livePreview, &QCheckBox::toggled, this, &WritingWidget::scheduleLivePreview);

    connect(m_text, &QPlainTextEdit::textChanged, this, &WritingWidget::scheduleLivePreview);
    connect(m_align, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &WritingWidget::scheduleLivePreview);
    const QList<QDoubleSpinBox*> spins = {m_charHeight, m_lineSpacing, m_letterSpacing,
                                          m_originX, m_originY, m_penUpZ, m_penDownZ, m_feed};
    for (QDoubleSpinBox *s : spins)
        connect(s, QOverload<double>::of(&QDoubleSpinBox::valueChanged),
                this, &WritingWidget::scheduleLivePreview);

    // Automated visual-test hook (no effect unless set):
    //   HJLABS_WRITING_AUTODEMO=1 -> set sample text and generate.
    if (qEnvironmentVariableIsSet("HJLABS_WRITING_AUTODEMO")) {
        QTimer::singleShot(600, this, [this]() {
            m_text->setPlainText(QStringLiteral("Hello\nWorld 123"));
            generate();
        });
    }

    applyZoom();   // apply default 100% zoom and announce it to the title bar
}

void WritingWidget::zoomIn()    { m_zoom = qMin(2.0, m_zoom + 0.1); applyZoom(); }
void WritingWidget::zoomOut()   { m_zoom = qMax(0.5, m_zoom - 0.1); applyZoom(); }
void WritingWidget::zoomReset() { m_zoom = 1.0; applyZoom(); }

void WritingWidget::applyZoom()
{
    // Scale via a widget stylesheet font-size. setFont() is useless here because
    // the global app stylesheet sets `QWidget { font-size: Npt }`, which always
    // overrides setFont(). The `*` selector forces the size onto every
    // descendant control in this panel's subtree.
    int pt = qBound(6, int(qRound(10.0 * m_zoom)), 28);
    setStyleSheet(QString("* { font-size: %1pt; }").arg(pt));
    emit zoomChanged(int(qRound(m_zoom * 100.0)));
}

void WritingWidget::scheduleLivePreview()
{
    if (m_livePreview && m_livePreview->isChecked())
        m_liveTimer->start();
}

void WritingWidget::loadCustomFont()
{
    const QString path = QFileDialog::getOpenFileName(
        this, tr("Load custom stroke font"), QString(),
        tr("Stroke font (*.json);;All files (*)"));
    if (path.isEmpty())
        return;

    StrokeFont loaded;
    QString err;
    if (!loaded.loadJson(path, &err)) {
        m_info->setText(tr("Failed to load font: %1").arg(err));
        emit statusMessage(tr("Writing: font load failed — %1").arg(err));
        return;
    }

    m_font = loaded;
    m_fontLabel->setText(tr("Active font: %1").arg(m_font.name()));
    m_info->setText(tr("Loaded custom font \"%1\".").arg(m_font.name()));
    emit statusMessage(tr("Writing: loaded font \"%1\"").arg(m_font.name()));
    scheduleLivePreview();
}

void WritingWidget::generate()
{
    const QString text = m_text->toPlainText();
    if (text.trimmed().isEmpty()) {
        m_info->setText(tr("Enter some text first."));
        return;
    }

    QVector<Polyline> polylines = m_font.layout(
        text, m_charHeight->value(), m_lineSpacing->value(),
        m_letterSpacing->value(), m_align->currentIndex());

    if (polylines.isEmpty()) {
        m_info->setText(tr("Nothing to draw (no renderable glyphs)."));
        return;
    }

    // Translate to the requested origin.
    const Point origin(m_originX->value(), m_originY->value());
    for (Polyline &pl : polylines)
        for (Point &p : pl.points)
            p = Point(p.x() + origin.x(), p.y() + origin.y());

    // Pen-mode CAM: follow each stroke at the surface; depth is irrelevant in
    // Pen Z mode but the engrave op still produces the move sequence.
    CamParams cam;
    cam.tool.feedXY = m_feed->value();
    cam.safeZ = m_penUpZ->value();
    cam.surfaceZ = 0.0;
    cam.cutDepth = 0.0;
    Toolpath tp = engrave(polylines, cam);

    EmitterOptions opt;
    opt.programName = QStringLiteral("Writing");
    opt.zMode = ZMode::Pen;
    opt.penUpZ = m_penUpZ->value();
    opt.penDownZ = m_penDownZ->value();
    opt.safeZ = m_penUpZ->value();
    opt.useSpindle = false;
    opt.feedXY = m_feed->value();

    GcodeEmitter emitter(opt);
    QString g = emitter.emitProgram(tp);
    m_preview->setPlainText(g);

    m_info->setText(tr("Generated %1 pen stroke(s) for %2 line(s).")
                        .arg(polylines.size())
                        .arg(text.split('\n').size()));
    emit statusMessage(tr("Writing: %1 stroke(s)").arg(polylines.size()));
    emit programGenerated(g.split('\n'));
}
