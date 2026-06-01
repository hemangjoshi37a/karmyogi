// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "cam/solderingwidget.h"

#include <QTableWidget>
#include <QHeaderView>
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
#include <QFont>
#include <QApplication>
#include <QEvent>
#include <QTimer>
#include <QItemSelectionModel>
#include <algorithm>
#include <functional>

#include "cadcam/soldering.h"

using namespace cadcam;

namespace {
enum Column { ColX = 0, ColY, ColFreeZ, ColTouchZ, ColType, ColFeed, ColCount };

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

SolderingWidget::SolderingWidget(QWidget *parent) : QWidget(parent)
{
    auto *root = new QVBoxLayout(this);
    root->setContentsMargins(6, 6, 6, 6);

    auto *intro = new QLabel(
        tr("Soldering iron on the head; the spindle output drives the wire feeder. "
           "Each point touches down at X/Y/Z and feeds wire for the given time."));
    intro->setWordWrap(true);
    root->addWidget(intro);

    // ---- Points table ----------------------------------------------------
    auto *pointsBox = new QGroupBox(tr("Solder points"));
    auto *pv = new QVBoxLayout(pointsBox);

    m_table = new QTableWidget(0, ColCount);
    m_table->setHorizontalHeaderLabels(
        {tr("X (mm)"), tr("Y (mm)"), tr("Free Z (mm)"), tr("Touch Z (mm)"),
         tr("Feed type"), tr("Feed time (s)")});
    // Interactive columns: the user can drag column widths; the last column
    // takes any slack so the table still fills the panel width.
    m_table->horizontalHeader()->setSectionResizeMode(QHeaderView::Interactive);
    m_table->horizontalHeader()->setStretchLastSection(true);
    m_table->verticalHeader()->setSectionResizeMode(QHeaderView::Interactive);
    m_table->verticalHeader()->setDefaultSectionSize(22);
    m_table->setSelectionBehavior(QAbstractItemView::SelectRows);
    m_table->setMinimumHeight(160);
    pv->addWidget(m_table);

    auto *rowBtns = new QHBoxLayout();
    auto *btnAdd = new QPushButton(tr("Add row"));
    auto *btnDel = new QPushButton(tr("Delete selected"));
    auto *btnDemo = new QPushButton(tr("Demo points"));
    auto *btnRecord = new QPushButton(tr("⊕ Record position"));
    btnRecord->setToolTip(tr("Capture the current machine position into the "
                             "selected row (or a new row)."));
    rowBtns->addWidget(btnAdd);
    rowBtns->addWidget(btnDel);
    rowBtns->addWidget(btnDemo);
    rowBtns->addWidget(btnRecord);
    rowBtns->addStretch(1);
    pv->addLayout(rowBtns);

    m_liveLabel = new QLabel(tr("Live position:  X 0.000   Y 0.000   Z 0.000"));
    pv->addWidget(m_liveLabel);
    root->addWidget(pointsBox);

    // ---- Process parameters ----------------------------------------------
    auto *paramBox = new QGroupBox(tr("Process parameters"));
    auto *form = new QFormLayout(paramBox);
    m_safeZ      = makeSpin(0.5, 50.0, 5.0, 0.5, 2, tr(" mm"));
    m_feederRPM  = makeSpin(0.0, 60000.0, 1000.0, 100.0, 0, QString());
    m_plungeFeed = makeSpin(1.0, 5000.0, 100.0, 10.0, 0, tr(" mm/min"));
    m_settle     = makeSpin(0.0, 10.0, 0.0, 0.1, 2, tr(" s"));
    form->addRow(tr("Safe Z"), m_safeZ);
    form->addRow(tr("Feeder speed"), m_feederRPM);
    form->addRow(tr("Plunge feed"), m_plungeFeed);
    form->addRow(tr("Settle dwell"), m_settle);
    root->addWidget(paramBox);

    m_livePreview = new QCheckBox(tr("Live preview (auto-update 3D)"));
    root->addWidget(m_livePreview);

    auto *btnGen = new QPushButton(tr("Generate NC code"));
    btnGen->setProperty("accent", true);
    root->addWidget(btnGen);

    m_info = new QLabel(tr("No points yet — add rows or load demo points."));
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

    connect(btnAdd, &QPushButton::clicked, this, &SolderingWidget::addRow);
    connect(btnDel, &QPushButton::clicked, this, &SolderingWidget::deleteSelectedRows);
    connect(btnDemo, &QPushButton::clicked, this, &SolderingWidget::addDemoPoints);
    connect(btnRecord, &QPushButton::clicked, this, &SolderingWidget::recordPosition);
    connect(btnGen, &QPushButton::clicked, this, &SolderingWidget::generate);

    // ---- Live preview: debounced auto-regeneration -----------------------
    m_liveTimer = new QTimer(this);
    m_liveTimer->setSingleShot(true);
    m_liveTimer->setInterval(250);
    connect(m_liveTimer, &QTimer::timeout, this, &SolderingWidget::generate);

    connect(m_livePreview, &QCheckBox::toggled, this, &SolderingWidget::scheduleLivePreview);

    // Cell edits and selection changes feed the preview. Per-row type combo
    // boxes are wired in appendRow(); row add/delete/record call
    // scheduleLivePreview() at the end of their handlers.
    connect(m_table, &QTableWidget::cellChanged, this, &SolderingWidget::scheduleLivePreview);
    connect(m_table, &QTableWidget::itemSelectionChanged,
            this, &SolderingWidget::scheduleLivePreview);

    const QList<QDoubleSpinBox*> spins = {m_safeZ, m_feederRPM, m_plungeFeed, m_settle};
    for (QDoubleSpinBox *s : spins)
        connect(s, QOverload<double>::of(&QDoubleSpinBox::valueChanged),
                this, &SolderingWidget::scheduleLivePreview);

    // Automated visual-test hook (no effect unless set):
    //   HJLABS_SOLDER_AUTODEMO=1 -> add demo points and generate.
    if (qEnvironmentVariableIsSet("HJLABS_SOLDER_AUTODEMO")) {
        QTimer::singleShot(600, this, [this]() {
            addDemoPoints();
            generate();
        });
    }

    applyZoom();   // apply default 100% zoom and announce it to the title bar
}

void SolderingWidget::zoomIn()    { m_zoom = qMin(2.0, m_zoom + 0.1); applyZoom(); }
void SolderingWidget::zoomOut()   { m_zoom = qMax(0.5, m_zoom - 0.1); applyZoom(); }
void SolderingWidget::zoomReset() { m_zoom = 1.0; applyZoom(); }

void SolderingWidget::applyZoom()
{
    // Scale via a widget stylesheet font-size. setFont() is useless here because
    // the global app stylesheet sets `QWidget { font-size: Npt }`, which always
    // overrides setFont(). The `*` selector forces the size onto every
    // descendant control in this panel's subtree.
    int pt = qBound(6, int(qRound(10.0 * m_zoom)), 28);
    setStyleSheet(QString("* { font-size: %1pt; }").arg(pt));
    emit zoomChanged(int(qRound(m_zoom * 100.0)));
}

void SolderingWidget::appendRow(double x, double y, double freeZ, double touchZ,
                                int typeIndex, double feedSeconds)
{
    int r = m_table->rowCount();
    m_table->insertRow(r);
    m_table->setItem(r, ColX, new QTableWidgetItem(QString::number(x, 'f', 3)));
    m_table->setItem(r, ColY, new QTableWidgetItem(QString::number(y, 'f', 3)));
    m_table->setItem(r, ColFreeZ, new QTableWidgetItem(QString::number(freeZ, 'f', 3)));
    m_table->setItem(r, ColTouchZ, new QTableWidgetItem(QString::number(touchZ, 'f', 3)));

    auto *type = new QComboBox();
    type->addItems({tr("Touch-down"), tr("Pre-solder")});
    type->setCurrentIndex(typeIndex);
    connect(type, QOverload<int>::of(&QComboBox::currentIndexChanged),
            this, &SolderingWidget::scheduleLivePreview);
    m_table->setCellWidget(r, ColType, type);

    m_table->setItem(r, ColFeed, new QTableWidgetItem(QString::number(feedSeconds, 'f', 2)));
}

double SolderingWidget::cellValue(int row, int col) const
{
    QTableWidgetItem *it = m_table->item(row, col);
    return it ? it->text().toDouble() : 0.0;
}

void SolderingWidget::setCell(int row, int col, double value)
{
    QTableWidgetItem *it = m_table->item(row, col);
    if (!it) {
        it = new QTableWidgetItem();
        m_table->setItem(row, col, it);
    }
    it->setText(QString::number(value, 'f', 3));
}

void SolderingWidget::scheduleLivePreview()
{
    if (m_livePreview && m_livePreview->isChecked())
        m_liveTimer->start();
}

void SolderingWidget::setLivePosition(double x, double y, double z)
{
    m_liveX = x;
    m_liveY = y;
    m_liveZ = z;
    if (m_liveLabel)
        m_liveLabel->setText(tr("Live position:  X %1   Y %2   Z %3")
                                 .arg(x, 0, 'f', 3).arg(y, 0, 'f', 3).arg(z, 0, 'f', 3));
}

void SolderingWidget::recordPosition()
{
    // Free/Touch Z are NOT taken from the live machine Z: carry them over from
    // the previous row if one exists, otherwise default to Safe Z / -1.0. The
    // user can edit them manually in the table afterward.
    int prev = m_table->rowCount() - 1;
    double freeZ = (prev >= 0) ? cellValue(prev, ColFreeZ) : m_safeZ->value();
    double touchZ = (prev >= 0) ? cellValue(prev, ColTouchZ) : -1.0;

    int row = m_table->currentRow();
    if (row < 0) {
        appendRow(m_liveX, m_liveY, freeZ, touchZ, 0, 0.5);
        row = m_table->rowCount() - 1;
        m_table->selectRow(row);
    } else {
        setCell(row, ColX, m_liveX);
        setCell(row, ColY, m_liveY);
    }
    emit statusMessage(tr("Recorded X %1 Y %2 into row %3")
                           .arg(m_liveX, 0, 'f', 3).arg(m_liveY, 0, 'f', 3)
                           .arg(row + 1));
    scheduleLivePreview();
}

void SolderingWidget::addRow()
{
    appendRow(0.0, 0.0, 5.0, -1.0, 0, 0.5);
    scheduleLivePreview();
}

void SolderingWidget::deleteSelectedRows()
{
    QList<int> rows;
    foreach (const QModelIndex &idx, m_table->selectionModel()->selectedRows())
        rows.append(idx.row());
    std::sort(rows.begin(), rows.end(), std::greater<int>());
    foreach (int r, rows)
        m_table->removeRow(r);
    scheduleLivePreview();
}

void SolderingWidget::addDemoPoints()
{
    appendRow(10.0, 10.0, 5.0, -1.0, 0, 0.5);  // touch-down
    appendRow(30.0, 10.0, 5.0, -1.0, 1, 0.8);  // pre-solder
    appendRow(50.0, 10.0, 5.0, -1.0, 0, 0.6);  // touch-down
    appendRow(10.0, 30.0, 5.0, -1.0, 1, 0.7);  // pre-solder
    appendRow(30.0, 30.0, 5.0, -1.0, 0, 0.5);  // touch-down
    appendRow(50.0, 30.0, 5.0, -1.0, 1, 0.9);  // pre-solder
    scheduleLivePreview();
}

void SolderingWidget::generate()
{
    QVector<SolderPoint> points;
    for (int r = 0; r < m_table->rowCount(); ++r) {
        SolderPoint p;
        p.x = cellValue(r, ColX);
        p.y = cellValue(r, ColY);
        p.freeZ = cellValue(r, ColFreeZ);
        p.touchZ = cellValue(r, ColTouchZ);
        auto *cb = qobject_cast<QComboBox*>(m_table->cellWidget(r, ColType));
        p.type = (cb && cb->currentIndex() == 1) ? SolderFeedType::PreSolder
                                                  : SolderFeedType::TouchDown;
        p.feedSeconds = cellValue(r, ColFeed);
        points.append(p);
    }

    if (points.isEmpty()) {
        m_info->setText(tr("Add at least one solder point first."));
        return;
    }

    SolderingParams sp;
    sp.safeZ = m_safeZ->value();
    sp.feederRPM = m_feederRPM->value();
    sp.plungeFeed = m_plungeFeed->value();
    sp.settleSeconds = m_settle->value();

    SolderingGenerator gen;
    QString g = gen.generate(points, sp);
    m_preview->setPlainText(g);

    m_info->setText(tr("Generated program for %1 solder point(s).").arg(points.size()));
    emit statusMessage(tr("Auto-soldering: %1 point(s)").arg(points.size()));
    emit programGenerated(g.split('\n'));
}
