// This file is a part of "Candle" application (hjLabs.in fork).
// Copyright 2026 hjLabs.in / Hemang Joshi

#include "cam/motionwidget.h"

#include <QCheckBox>
#include <QDoubleSpinBox>
#include <QSpinBox>
#include <QLabel>
#include <QPushButton>
#include <QToolButton>
#include <QGroupBox>
#include <QFormLayout>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QScrollArea>
#include <QFrame>
#include <QRegularExpression>
#include <QApplication>
#include <QFont>
#include <QEvent>
#include <QTimer>
#include <cmath>

namespace {
// makeSpin: decimals MUST be set before the value, otherwise the value is
// rounded to the default 2-decimal precision first (e.g. 3.175 -> 3.17).
QDoubleSpinBox *makeSpin(double min, double max, double val, double step,
                         int decimals, const QString &suffix)
{
    auto *s = new QDoubleSpinBox();
    s->setDecimals(decimals);
    s->setRange(min, max);
    s->setSingleStep(step);
    s->setValue(val);
    if (!suffix.isEmpty()) s->setSuffix(suffix);
    return s;
}
}

MotionWidget::MotionWidget(QWidget *parent) : QWidget(parent)
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

    auto *intro = new QLabel(
        tr("Configure the GRBL firmware's motion settings (limit switches, homing, "
           "per-axis steps/mm, travel, max rate and linear acceleration). "
           "GRBL has no S-curves; acceleration is linear only."));
    intro->setWordWrap(true);
    root->addWidget(intro);

    // ---- Limit switches & homing -----------------------------------------
    auto *limBox = new QGroupBox(tr("Limit switches & homing"));
    auto *limForm = new QFormLayout(limBox);
    addBool(limForm, 20, tr("Soft limits ($20)"));
    addBool(limForm, 21, tr("Hard limits ($21)"));
    addBool(limForm, 22, tr("Homing cycle ($22)"));
    addInt (limForm, 23, tr("Homing dir invert mask ($23)"), 0, 255);
    addReal(limForm, 24, tr("Homing feed ($24)"), 0.0, 100000.0, tr(" mm/min"));
    addReal(limForm, 25, tr("Homing seek ($25)"), 0.0, 100000.0, tr(" mm/min"));
    addInt (limForm, 26, tr("Homing debounce ($26)"), 0, 10000, tr(" ms"));
    addReal(limForm, 27, tr("Homing pull-off ($27)"), 0.0, 100.0, tr(" mm"));
    addBool(limForm, 5,  tr("Invert limit pins ($5)"));
    root->addWidget(limBox);

    // ---- Steps / travel --------------------------------------------------
    auto *stepBox = new QGroupBox(tr("Steps / travel"));
    auto *stepForm = new QFormLayout(stepBox);
    addReal(stepForm, 100, tr("Steps/mm X ($100)"), 0.0, 100000.0, tr(" steps/mm"));
    addReal(stepForm, 101, tr("Steps/mm Y ($101)"), 0.0, 100000.0, tr(" steps/mm"));
    addReal(stepForm, 102, tr("Steps/mm Z ($102)"), 0.0, 100000.0, tr(" steps/mm"));
    addReal(stepForm, 130, tr("Max travel X ($130)"), 0.0, 100000.0, tr(" mm"));
    addReal(stepForm, 131, tr("Max travel Y ($131)"), 0.0, 100000.0, tr(" mm"));
    addReal(stepForm, 132, tr("Max travel Z ($132)"), 0.0, 100000.0, tr(" mm"));
    root->addWidget(stepBox);

    // ---- Speed & acceleration --------------------------------------------
    auto *spdBox = new QGroupBox(tr("Speed & acceleration"));
    auto *spdForm = new QFormLayout(spdBox);
    addReal(spdForm, 110, tr("Max rate X ($110)"), 0.0, 1000000.0, tr(" mm/min"));
    addReal(spdForm, 111, tr("Max rate Y ($111)"), 0.0, 1000000.0, tr(" mm/min"));
    addReal(spdForm, 112, tr("Max rate Z ($112)"), 0.0, 1000000.0, tr(" mm/min"));
    addReal(spdForm, 120, tr("Acceleration X ($120)"), 0.0, 1000000.0, tr(" mm/s^2"));
    addReal(spdForm, 121, tr("Acceleration Y ($121)"), 0.0, 1000000.0, tr(" mm/s^2"));
    addReal(spdForm, 122, tr("Acceleration Z ($122)"), 0.0, 1000000.0, tr(" mm/s^2"));
    root->addWidget(spdBox);

    // ---- Buttons ---------------------------------------------------------
    auto *btnRow = new QHBoxLayout();
    auto *btnRead     = new QPushButton(tr("Read from controller"));
    auto *btnApplyChg = new QPushButton(tr("Apply changed"));
    auto *btnApplyAll = new QPushButton(tr("Apply all"));
    btnApplyChg->setStyleSheet("font-weight:bold; padding:4px;");
    btnRow->addWidget(btnRead);
    btnRow->addWidget(btnApplyChg);
    btnRow->addWidget(btnApplyAll);
    btnRow->addStretch(1);
    root->addLayout(btnRow);

    root->addStretch(1);

    connect(btnRead,     &QPushButton::clicked, this, &MotionWidget::readFromController);
    connect(btnApplyChg, &QPushButton::clicked, this, &MotionWidget::applyChanged);
    connect(btnApplyAll, &QPushButton::clicked, this, &MotionWidget::applyAll);

    // Automated visual-test hook (no effect unless set):
    //   HJLABS_MOTION_AUTODEMO=1 -> feed fake controller settings so the panel
    //   shows populated values without a real GRBL connection.
    if (qEnvironmentVariableIsSet("HJLABS_MOTION_AUTODEMO")) {
        QTimer::singleShot(500, this, [this]() {
            onResponseLine("$5=0");
            onResponseLine("$20=0");
            onResponseLine("$21=1");
            onResponseLine("$22=1");
            onResponseLine("$23=3");
            onResponseLine("$24=100.000");
            onResponseLine("$25=2000.000");
            onResponseLine("$26=250");
            onResponseLine("$27=1.000");
            onResponseLine("$100=80.000");
            onResponseLine("$101=80.000");
            onResponseLine("$102=400.000");
            onResponseLine("$110=8000.000");
            onResponseLine("$111=8000.000");
            onResponseLine("$112=2000.000");
            onResponseLine("$120=500.000");
            onResponseLine("$121=500.000");
            onResponseLine("$122=100.000");
            onResponseLine("$130=300.000");
            onResponseLine("$131=300.000");
            onResponseLine("$132=100.000");
            emit statusMessage(tr("Motion: loaded demo settings."));
        });
    }

    applyZoom();   // apply default 100% zoom and announce it to the title bar
}

void MotionWidget::zoomIn()    { m_zoom = qMin(2.0, m_zoom + 0.1); applyZoom(); }
void MotionWidget::zoomOut()   { m_zoom = qMax(0.5, m_zoom - 0.1); applyZoom(); }
void MotionWidget::zoomReset() { m_zoom = 1.0; applyZoom(); }

void MotionWidget::applyZoom()
{
    // Scale via a widget stylesheet font-size. setFont() is useless here because
    // the global app stylesheet sets `QWidget { font-size: Npt }`, which always
    // overrides setFont(). The `*` selector forces the size onto every
    // descendant control in this panel's subtree.
    int pt = qBound(6, int(qRound(10.0 * m_zoom)), 28);
    setStyleSheet(QString("* { font-size: %1pt; }").arg(pt));
    emit zoomChanged(int(qRound(m_zoom * 100.0)));
}

void MotionWidget::registerField(int num, Kind kind, QWidget *widget)
{
    Field f;
    f.num = num;
    f.kind = kind;
    f.widget = widget;
    m_fields[num] = f;
}

QCheckBox *MotionWidget::addBool(QFormLayout *form, int num, const QString &label)
{
    auto *cb = new QCheckBox();
    form->addRow(label, cb);
    registerField(num, Kind::Bool, cb);
    return cb;
}

QSpinBox *MotionWidget::addInt(QFormLayout *form, int num, const QString &label,
                               int min, int max, const QString &suffix)
{
    auto *s = new QSpinBox();
    s->setRange(min, max);
    if (!suffix.isEmpty()) s->setSuffix(suffix);
    form->addRow(label, s);
    registerField(num, Kind::Int, s);
    return s;
}

QDoubleSpinBox *MotionWidget::addReal(QFormLayout *form, int num, const QString &label,
                                      double min, double max, const QString &suffix)
{
    auto *s = makeSpin(min, max, 0.0, 1.0, 3, suffix);
    form->addRow(label, s);
    registerField(num, Kind::Real, s);
    return s;
}

double MotionWidget::fieldValue(const Field &f) const
{
    switch (f.kind) {
    case Kind::Bool:
        return qobject_cast<QCheckBox*>(f.widget)->isChecked() ? 1.0 : 0.0;
    case Kind::Int:
        return static_cast<double>(qobject_cast<QSpinBox*>(f.widget)->value());
    case Kind::Real:
        return qobject_cast<QDoubleSpinBox*>(f.widget)->value();
    }
    return 0.0;
}

void MotionWidget::setFieldValue(const Field &f, double value)
{
    switch (f.kind) {
    case Kind::Bool:
        qobject_cast<QCheckBox*>(f.widget)->setChecked(value != 0.0);
        break;
    case Kind::Int:
        qobject_cast<QSpinBox*>(f.widget)->setValue(static_cast<int>(std::lround(value)));
        break;
    case Kind::Real:
        qobject_cast<QDoubleSpinBox*>(f.widget)->setValue(value);
        break;
    }
}

QString MotionWidget::formatValue(const Field &f, double value) const
{
    switch (f.kind) {
    case Kind::Bool:
        return value != 0.0 ? QStringLiteral("1") : QStringLiteral("0");
    case Kind::Int:
        return QString::number(static_cast<int>(std::lround(value)));
    case Kind::Real:
        break;
    }
    return QString::number(value, 'f', 3);
}

void MotionWidget::onResponseLine(const QString &line)
{
    // Match GRBL setting echoes: "$120=10.000" and tolerate "$120 = 10.0".
    static const QRegularExpression re(QStringLiteral("^\\s*\\$(\\d+)\\s*=\\s*([-+]?\\d*\\.?\\d+)"));
    QRegularExpressionMatch m = re.match(line);
    if (!m.hasMatch())
        return; // ignore non-setting lines

    int num = m.captured(1).toInt();
    double value = m.captured(2).toDouble();

    auto it = m_fields.find(num);
    if (it == m_fields.end())
        return; // a GRBL setting we don't expose

    m_lastRead[num] = value;
    setFieldValue(it->second, value);
}

int MotionWidget::sendFields(bool changedOnly)
{
    int sent = 0;
    for (const auto &kv : m_fields) {
        const Field &f = kv.second;
        double value = fieldValue(f);

        if (changedOnly) {
            auto it = m_lastRead.find(f.num);
            // Send only if unread or differing from the last known value.
            if (it != m_lastRead.end() && qFuzzyCompare(it->second + 1.0, value + 1.0))
                continue;
        }

        emit commandRequested(QStringLiteral("$%1=%2")
                                  .arg(f.num)
                                  .arg(formatValue(f, value)));
        m_lastRead[f.num] = value;
        ++sent;
    }
    return sent;
}

void MotionWidget::readFromController()
{
    emit commandRequested(QStringLiteral("$$"));
    emit statusMessage(tr("Reading GRBL settings…"));
}

void MotionWidget::applyChanged()
{
    int n = sendFields(true);
    emit statusMessage(tr("Applied %1 changed motion setting(s).").arg(n));
}

void MotionWidget::applyAll()
{
    int n = sendFields(false);
    emit statusMessage(tr("Applied all %1 motion setting(s).").arg(n));
}
